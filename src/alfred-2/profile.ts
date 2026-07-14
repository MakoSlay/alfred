import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	MemoryProvenance,
	MemoryProvenanceSource,
	ProfileMemoryCategory,
	ProfileMemoryRecord,
} from "./memory-types.ts";

const DEFAULT_PROFILE_FILE = join(homedir(), ".alfred", "profile.json");
const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Persisted profile fact. Legacy aliases and unknown extension fields are kept
 * so existing profile.json readers and forward-compatible additions survive.
 */
export interface UserFact extends ProfileMemoryRecord {
	/** Legacy alias for createdAt. */
	addedAt: string;
	/** Legacy source retained for compatibility with existing profile files. */
	source: "user" | "observed";
	[key: string]: unknown;
}

export interface UserProfile {
	facts: UserFact[];
	updatedAt: string;
	[key: string]: unknown;
}

export interface ProfileMemoryWrite {
	key: string;
	value: string;
	category?: ProfileMemoryCategory;
}

export interface ProfileStore {
	readonly filePath: string;
	loadProfile(): UserProfile;
	saveProfile(): void;
	rememberFact(
		key: string,
		value: string,
		category?: ProfileMemoryCategory,
		source?: UserFact["source"],
		provenance?: MemoryProvenance,
	): UserFact;
	rememberProfileMemory(write: ProfileMemoryWrite, provenance: MemoryProvenance): UserFact;
	recallFact(key?: string): UserFact[];
	forgetFact(key: string): boolean;
	forgetProfileMemory(id: string): boolean;
	formatProfileForContext(): string;
}

interface ProfileSnapshot {
	profile: UserProfile;
	revision: string;
}

export function legacySourceToProvenance(source: UserFact["source"]): MemoryProvenanceSource {
	return source === "observed" ? "conversation" : "manual";
}

function provenanceSourceToLegacy(source: MemoryProvenanceSource): UserFact["source"] {
	return source === "conversation" ? "observed" : "user";
}

function stableProfileId(key: string, createdAt: string, discriminator = ""): string {
	const digest = createHash("sha256")
		.update(`${key}\0${createdAt}\0${discriminator}`)
		.digest("hex")
		.slice(0, 20);
	return `profile-${digest}`;
}

function contentRevision(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeCategory(value: unknown): ProfileMemoryCategory | undefined {
	return value === "preference" || value === "identity" || value === "context" || value === "note"
		? value
		: undefined;
}

function normalizeProvenance(
	value: unknown,
	legacySource: UserFact["source"],
	fallbackTimestamp: string,
): MemoryProvenance {
	const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const source = candidate.source === "manual"
		|| candidate.source === "conversation"
		|| candidate.source === "tool"
		|| candidate.source === "import"
		? candidate.source
		: legacySourceToProvenance(legacySource);
	const confidence = typeof candidate.confidence === "number"
		&& Number.isFinite(candidate.confidence)
		&& candidate.confidence >= 0
		&& candidate.confidence <= 1
		? candidate.confidence
		: undefined;
	return {
		...candidate,
		source,
		sourceId: nonEmptyString(candidate.sourceId),
		requestId: nonEmptyString(candidate.requestId),
		turnId: nonEmptyString(candidate.turnId),
		timestamp: nonEmptyString(candidate.timestamp) ?? fallbackTimestamp,
		confidence,
	};
}

function normalizeFact(value: unknown, profileUpdatedAt: string, index: number): UserFact | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	const key = nonEmptyString(candidate.key);
	const factValue = typeof candidate.value === "string" ? candidate.value : undefined;
	if (!key || factValue === undefined) return null;
	const category = candidate.category === undefined ? "note" : normalizeCategory(candidate.category);
	if (!category) return null;
	const createdAt = nonEmptyString(candidate.createdAt)
		?? nonEmptyString(candidate.addedAt)
		?? profileUpdatedAt;
	const updatedAt = nonEmptyString(candidate.updatedAt) ?? createdAt;
	const candidateSource = candidate.source === "observed" || candidate.source === "user"
		? candidate.source
		: undefined;
	const provenanceCandidate = candidate.provenance && typeof candidate.provenance === "object"
		? candidate.provenance as Record<string, unknown>
		: undefined;
	const legacySource = candidateSource
		?? (provenanceCandidate?.source === "conversation" ? "observed" : "user");
	const id = nonEmptyString(candidate.id) ?? stableProfileId(key, createdAt, `legacy-${index}`);
	return {
		...candidate,
		id,
		kind: "profile",
		key,
		value: factValue,
		category,
		createdAt,
		updatedAt,
		provenance: normalizeProvenance(candidate.provenance, legacySource, updatedAt),
		addedAt: createdAt,
		source: legacySource,
	} as UserFact;
}

export function createProfileStore(filePath: string = DEFAULT_PROFILE_FILE): ProfileStore {
	let profile: UserProfile | null = null;
	let profileRevision: string | null = null;
	const lockDirectory = `${filePath}.lock`;

	function ensureDir(): void {
		const directory = dirname(filePath);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
		chmodSync(directory, PROFILE_DIRECTORY_MODE);
	}

	function readSnapshot(): ProfileSnapshot {
		ensureDir();
		if (!existsSync(filePath)) {
			return {
				profile: { facts: [], updatedAt: new Date().toISOString() },
				revision: "missing",
			};
		}
		try {
			chmodSync(filePath, PROFILE_FILE_MODE);
			const content = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(content) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("profile root must be an object");
			const raw = parsed as Record<string, unknown>;
			if (!Array.isArray(raw.facts)) throw new Error("profile facts must be an array");
			const updatedAt = nonEmptyString(raw.updatedAt) ?? new Date().toISOString();
			const facts = raw.facts.map((fact, index) => {
				const normalized = normalizeFact(fact, updatedAt, index);
				if (!normalized) throw new Error(`profile fact at index ${index} is invalid`);
				return normalized;
			});
			const ids = new Set<string>();
			for (const fact of facts) {
				if (ids.has(fact.id)) throw new Error(`duplicate profile memory id: ${fact.id}`);
				ids.add(fact.id);
			}
			return {
				profile: { ...raw, facts, updatedAt } as UserProfile,
				revision: contentRevision(content),
			};
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Could not load profile ${filePath}; the existing file was left untouched: ${detail}`);
		}
	}

	function useSnapshot(snapshot: ProfileSnapshot): UserProfile {
		profile = snapshot.profile;
		profileRevision = snapshot.revision;
		return profile;
	}

	function loadProfile(): UserProfile {
		const snapshot = readSnapshot();
		if (profile && profileRevision === snapshot.revision) return profile;
		return useSnapshot(snapshot);
	}

	function acquireLock(): () => void {
		ensureDir();
		const startedAt = Date.now();
		while (true) {
			try {
				mkdirSync(lockDirectory, { mode: PROFILE_DIRECTORY_MODE });
				return () => rmSync(lockDirectory, { recursive: true, force: true });
			} catch (cause) {
				const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
				if (code !== "EEXIST") throw cause;
				try {
					if (Date.now() - statSync(lockDirectory).mtimeMs > STALE_LOCK_MS) {
						rmSync(lockDirectory, { recursive: true, force: true });
						continue;
					}
				} catch {
					continue;
				}
				if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
					throw new Error(`Timed out waiting for profile lock ${lockDirectory}`);
				}
				Atomics.wait(lockWaitBuffer, 0, 0, LOCK_WAIT_MS);
			}
		}
	}

	function writeCurrentProfile(): void {
		if (!profile) return;
		ensureDir();
		const updatedAt = new Date().toISOString();
		const serialized = JSON.stringify({ ...profile, updatedAt }, null, 2);
		const temporaryFile = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
		try {
			writeFileSync(temporaryFile, serialized, { encoding: "utf-8", mode: PROFILE_FILE_MODE });
			chmodSync(temporaryFile, PROFILE_FILE_MODE);
			const temporaryFd = openSync(temporaryFile, "r");
			try {
				fsyncSync(temporaryFd);
			} finally {
				closeSync(temporaryFd);
			}
			renameSync(temporaryFile, filePath);
			chmodSync(filePath, PROFILE_FILE_MODE);
			const directoryFd = openSync(dirname(filePath), "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
			profile.updatedAt = updatedAt;
			profileRevision = contentRevision(serialized);
		} catch (cause) {
			rmSync(temporaryFile, { force: true });
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Could not persist profile ${filePath}: ${detail}`);
		}
	}

	function saveProfile(): void {
		if (!profile) return;
		const release = acquireLock();
		try {
			const diskRevision = readSnapshot().revision;
			if (profileRevision !== diskRevision) {
				throw new Error(`Profile changed on disk; reload before saving ${filePath}`);
			}
			writeCurrentProfile();
		} finally {
			release();
		}
	}

	function withFreshProfile<T>(operation: (current: UserProfile) => T): T {
		const release = acquireLock();
		let snapshot: ProfileSnapshot | null = null;
		let previous: UserProfile | null = null;
		try {
			snapshot = readSnapshot();
			useSnapshot(snapshot);
			previous = { ...snapshot.profile, facts: [...snapshot.profile.facts] };
			const result = operation(snapshot.profile);
			writeCurrentProfile();
			return result;
		} catch (cause) {
			if (snapshot && previous) {
				profile = previous;
				profileRevision = snapshot.revision;
			}
			throw cause;
		} finally {
			release();
		}
	}

	function rememberProfileMemory(write: ProfileMemoryWrite, provenance: MemoryProvenance): UserFact {
		return withFreshProfile((current) => {
			const now = provenance.timestamp || new Date().toISOString();
			const existing = current.facts.findIndex((fact) => fact.key === write.key);
			if (existing >= 0) {
				const prior = current.facts[existing]!;
				current.facts[existing] = {
					...prior,
					value: write.value,
					category: write.category ?? prior.category,
					updatedAt: now,
					provenance: { ...provenance, timestamp: now },
					source: provenanceSourceToLegacy(provenance.source),
				};
				return current.facts[existing]!;
			}
			const fact: UserFact = {
				id: stableProfileId(write.key, now),
				kind: "profile",
				key: write.key,
				value: write.value,
				category: write.category ?? "note",
				createdAt: now,
				updatedAt: now,
				provenance: { ...provenance, timestamp: now },
				addedAt: now,
				source: provenanceSourceToLegacy(provenance.source),
			};
			current.facts.push(fact);
			return fact;
		});
	}

	function rememberFact(
		key: string,
		value: string,
		category: ProfileMemoryCategory = "note",
		source: UserFact["source"] = "user",
		provenance?: MemoryProvenance,
	): UserFact {
		const now = provenance?.timestamp ?? new Date().toISOString();
		return rememberProfileMemory(
			{ key, value, category },
			provenance ?? { source: legacySourceToProvenance(source), timestamp: now },
		);
	}

	function cloneFact(fact: UserFact): UserFact {
		return { ...fact, provenance: { ...fact.provenance } };
	}

	function recallFact(key?: string): UserFact[] {
		const current = loadProfile();
		if (!key) return current.facts.map(cloneFact);
		const lower = key.toLowerCase();
		return current.facts.filter(
			(fact) =>
				fact.key.toLowerCase().includes(lower)
				|| fact.value.toLowerCase().includes(lower)
				|| fact.category.toLowerCase().includes(lower),
		).map(cloneFact);
	}

	function removeFact(predicate: (fact: UserFact) => boolean): boolean {
		const release = acquireLock();
		let snapshot: ProfileSnapshot | null = null;
		let previous: UserProfile | null = null;
		try {
			snapshot = readSnapshot();
			useSnapshot(snapshot);
			const index = snapshot.profile.facts.findIndex(predicate);
			if (index < 0) return false;
			previous = { ...snapshot.profile, facts: [...snapshot.profile.facts] };
			snapshot.profile.facts.splice(index, 1);
			writeCurrentProfile();
			return true;
		} catch (cause) {
			if (snapshot && previous) {
				profile = previous;
				profileRevision = snapshot.revision;
			}
			throw cause;
		} finally {
			release();
		}
	}

	function forgetFact(key: string): boolean {
		return removeFact((fact) => fact.key === key);
	}

	function forgetProfileMemory(id: string): boolean {
		return removeFact((fact) => fact.id === id);
	}

	function formatProfileForContext(): string {
		const current = loadProfile();
		if (current.facts.length === 0) return "(no facts about the user yet)";
		const lines: string[] = ["USER PROFILE:"];
		const byCategory: Record<string, UserFact[]> = {};
		for (const fact of current.facts) (byCategory[fact.category] ??= []).push(fact);
		for (const [category, facts] of Object.entries(byCategory)) {
			lines.push(`  ${category}:`);
			for (const fact of facts) lines.push(`    - ${fact.key}: ${fact.value}`);
		}
		return lines.join("\n");
	}

	return {
		filePath,
		loadProfile,
		saveProfile,
		rememberFact,
		rememberProfileMemory,
		recallFact,
		forgetFact,
		forgetProfileMemory,
		formatProfileForContext,
	};
}

const defaultProfileStore = createProfileStore();

export function getDefaultProfileStore(): ProfileStore {
	return defaultProfileStore;
}

// Compatibility API used by existing callers.
export const loadProfile = (): UserProfile => defaultProfileStore.loadProfile();
export const saveProfile = (): void => defaultProfileStore.saveProfile();
export const rememberFact = (
	key: string,
	value: string,
	category: ProfileMemoryCategory = "note",
	source: UserFact["source"] = "user",
	provenance?: MemoryProvenance,
): UserFact => defaultProfileStore.rememberFact(key, value, category, source, provenance);
export const rememberProfileMemory = (
	write: ProfileMemoryWrite,
	provenance: MemoryProvenance,
): UserFact => defaultProfileStore.rememberProfileMemory(write, provenance);
export const recallFact = (key?: string): UserFact[] => defaultProfileStore.recallFact(key);
export const forgetFact = (key: string): boolean => defaultProfileStore.forgetFact(key);
export const forgetProfileMemory = (id: string): boolean => defaultProfileStore.forgetProfileMemory(id);
export const formatProfileForContext = (): string => defaultProfileStore.formatProfileForContext();
