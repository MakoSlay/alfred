import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AlfredEvent, AlfredEventKind, AlfredSource, AlfredTarget, AlfredTargetAlias, IsoTimestamp, RedactionMetadata, RetentionMetadata } from "../contracts/runtime.ts";

export const ALFRED_STORAGE_VERSION = 1;
export const DEFAULT_STORAGE_MAX_EVENTS = 100;

export interface AlfredPersistedDaemonState {
	events: AlfredEvent[];
	recentTargets: AlfredTarget[];
	targetAliases: AlfredTargetAlias[];
	warnings: string[];
}

export interface AlfredStorageAdapter {
	readonly appDir: string;
	readonly eventsPath: string;
	readonly targetsPath: string;
	readonly aliasesPath: string;
	readonly metadataPath: string;
	load(nowIso: IsoTimestamp): AlfredPersistedDaemonState;
	appendEvent(event: AlfredEvent): string | null;
	saveTargets(targets: readonly AlfredTarget[], updatedAt: IsoTimestamp): string | null;
	saveTargetAliases(aliases: readonly AlfredTargetAlias[], updatedAt: IsoTimestamp): string | null;
	prune(nowIso: IsoTimestamp): string | null;
}

export interface JsonFileStorageOptions {
	appDir?: string;
	maxEvents?: number;
}

interface StoredTargetsFile {
	version: number;
	updatedAt: IsoTimestamp;
	targets: AlfredTarget[];
}

interface StoredAliasesFile {
	version: number;
	updatedAt: IsoTimestamp;
	aliases: AlfredTargetAlias[];
}

interface StoredMetadataFile {
	version: number;
	updatedAt: IsoTimestamp;
	retention: {
		events: "short-and-manual-only";
		pendingDrafts: "session-only";
		targetAliases: "manual";
		loopRuntimeState: "session-only";
		transcripts: "never-by-default";
	};
}

const EVENT_KINDS: readonly AlfredEventKind[] = [
	"request.received",
	"world.observed",
	"draft.created",
	"draft.confirmed",
	"draft.cancelled",
	"action.proposed",
	"action.approved",
	"action.edited",
	"action.cancelled",
	"action.denied",
	"action.expired",
	"action.executed",
	"action.failed",
	"send.started",
	"send.succeeded",
	"send.failed",
	"loop.started",
	"loop.waiting",
	"loop.replied",
	"loop.needs_user",
	"loop.done",
	"loop.stopped",
	"error.raised",
	"fallback.used",
];

export function defaultAlfredStorageDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.ALFRED_STORAGE_DIR?.trim();
	return override ? resolve(override) : join(homedir(), ".alfred");
}

export function createJsonFileStorage(options: JsonFileStorageOptions = {}): AlfredStorageAdapter {
	const appDir = resolve(options.appDir ?? defaultAlfredStorageDir());
	const maxEvents = clampMaxEvents(options.maxEvents ?? DEFAULT_STORAGE_MAX_EVENTS);
	const eventsPath = join(appDir, "events.jsonl");
	const targetsPath = join(appDir, "targets.json");
	const aliasesPath = join(appDir, "aliases.json");
	const metadataPath = join(appDir, "metadata.json");

	function ensureStorageDir(updatedAt: IsoTimestamp): string | null {
		try {
			mkdirSync(appDir, { recursive: true, mode: 0o700 });
			try {
				chmodSync(appDir, 0o700);
			} catch {
				// Best effort: some filesystems ignore chmod. The decision doc records the expectation.
			}
			writeMetadata(updatedAt);
			return null;
		} catch (error) {
			return warningFor("initialize storage", error);
		}
	}

	function writeMetadata(updatedAt: IsoTimestamp): void {
		const metadata: StoredMetadataFile = {
			version: ALFRED_STORAGE_VERSION,
			updatedAt,
			retention: {
				events: "short-and-manual-only",
				pendingDrafts: "session-only",
				targetAliases: "manual",
				loopRuntimeState: "session-only",
				transcripts: "never-by-default",
			},
		};
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
	}

	function load(nowIso: IsoTimestamp): AlfredPersistedDaemonState {
		const warnings: string[] = [];
		const initWarning = ensureStorageDir(nowIso);
		if (initWarning) return { events: [], recentTargets: [], targetAliases: [], warnings: [initWarning] };

		const eventLoad = loadEvents(nowIso);
		warnings.push(...eventLoad.warnings);
		const targetLoad = loadTargets();
		warnings.push(...targetLoad.warnings);
		const aliasLoad = loadAliases();
		warnings.push(...aliasLoad.warnings);
		const pruneWarning = rewriteEvents(eventLoad.events, nowIso);
		if (pruneWarning) warnings.push(pruneWarning);

		return {
			events: newestFirst(eventLoad.events).slice(0, maxEvents),
			recentTargets: targetLoad.targets,
			targetAliases: aliasLoad.aliases,
			warnings,
		};
	}

	function appendEvent(event: AlfredEvent): string | null {
		const stored = sanitizeEventForStorage(event);
		if (!stored) return null;
		const initWarning = ensureStorageDir(event.createdAt);
		if (initWarning) return initWarning;
		try {
			appendFileSync(eventsPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
			const loaded = loadEvents(event.createdAt).events;
			if (loaded.length > maxEvents) return rewriteEvents(newestFirst(loaded).slice(0, maxEvents), event.createdAt);
			return null;
		} catch (error) {
			return warningFor("append event", error);
		}
	}

	function saveTargets(targets: readonly AlfredTarget[], updatedAt: IsoTimestamp): string | null {
		const initWarning = ensureStorageDir(updatedAt);
		if (initWarning) return initWarning;
		const payload: StoredTargetsFile = {
			version: ALFRED_STORAGE_VERSION,
			updatedAt,
			targets: targets.map(sanitizeTargetForStorage),
		};
		try {
			writeAtomicJson(targetsPath, payload);
			return null;
		} catch (error) {
			return warningFor("save targets", error);
		}
	}

	function saveTargetAliases(aliases: readonly AlfredTargetAlias[], updatedAt: IsoTimestamp): string | null {
		const initWarning = ensureStorageDir(updatedAt);
		if (initWarning) return initWarning;
		const payload: StoredAliasesFile = {
			version: ALFRED_STORAGE_VERSION,
			updatedAt,
			aliases: aliases.map(sanitizeTargetAliasForStorage),
		};
		try {
			writeAtomicJson(aliasesPath, payload);
			return null;
		} catch (error) {
			return warningFor("save target aliases", error);
		}
	}

	function prune(nowIso: IsoTimestamp): string | null {
		const initWarning = ensureStorageDir(nowIso);
		if (initWarning) return initWarning;
		const events = loadEvents(nowIso).events;
		return rewriteEvents(events, nowIso);
	}

	function loadEvents(nowIso: IsoTimestamp): { events: AlfredEvent[]; warnings: string[] } {
		if (!existsSync(eventsPath)) return { events: [], warnings: [] };
		const warnings: string[] = [];
		const events: AlfredEvent[] = [];
		let content = "";
		try {
			content = readFileSync(eventsPath, "utf8");
		} catch (error) {
			return { events: [], warnings: [warningFor("read events", error)] };
		}
		const lines = content.split(/\r?\n/).filter((line) => line.trim());
		for (const [index, line] of lines.entries()) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const event = parseStoredEvent(parsed);
				if (!event) {
					warnings.push(`Skipped invalid stored event at line ${index + 1}.`);
					continue;
				}
				if (eventExpired(event.retention, nowIso)) continue;
				events.push(event);
			} catch {
				warnings.push(`Skipped corrupt stored event at line ${index + 1}.`);
			}
		}
		return { events: newestFirst(events).slice(0, maxEvents), warnings };
	}

	function loadTargets(): { targets: AlfredTarget[]; warnings: string[] } {
		if (!existsSync(targetsPath)) return { targets: [], warnings: [] };
		try {
			const parsed = JSON.parse(readFileSync(targetsPath, "utf8")) as unknown;
			if (!isRecord(parsed) || parsed.version !== ALFRED_STORAGE_VERSION || !Array.isArray(parsed.targets)) {
				return { targets: [], warnings: ["Skipped invalid stored targets file."] };
			}
			return { targets: parsed.targets.map(parseStoredTarget).filter((target): target is AlfredTarget => Boolean(target)), warnings: [] };
		} catch {
			return { targets: [], warnings: ["Skipped corrupt stored targets file."] };
		}
	}

	function loadAliases(): { aliases: AlfredTargetAlias[]; warnings: string[] } {
		if (!existsSync(aliasesPath)) return { aliases: [], warnings: [] };
		try {
			const parsed = JSON.parse(readFileSync(aliasesPath, "utf8")) as unknown;
			if (!isRecord(parsed) || parsed.version !== ALFRED_STORAGE_VERSION || !Array.isArray(parsed.aliases)) {
				return { aliases: [], warnings: ["Skipped invalid stored aliases file."] };
			}
			return { aliases: parsed.aliases.map(parseStoredTargetAlias).filter((alias): alias is AlfredTargetAlias => Boolean(alias)), warnings: [] };
		} catch {
			return { aliases: [], warnings: ["Skipped corrupt stored aliases file."] };
		}
	}

	function rewriteEvents(events: readonly AlfredEvent[], updatedAt: IsoTimestamp): string | null {
		const initWarning = ensureStorageDir(updatedAt);
		if (initWarning) return initWarning;
		try {
			const keptEvents = newestFirst(events).slice(0, maxEvents).filter((event) => !eventExpired(event.retention, updatedAt));
			const lines = [...keptEvents]
				.reverse()
				.map((event) => sanitizeEventForStorage(event))
				.filter((event): event is AlfredEvent => event !== null)
				.map((event) => JSON.stringify(event));
			writeFileSync(eventsPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
			writeMetadata(updatedAt);
			return null;
		} catch (error) {
			return warningFor("rewrite events", error);
		}
	}

	return { appDir, eventsPath, targetsPath, aliasesPath, metadataPath, load, appendEvent, saveTargets, saveTargetAliases, prune };
}

export function sanitizeEventForStorage(event: AlfredEvent): AlfredEvent | null {
	if (event.retention.policy === "ephemeral" || event.retention.policy === "session") return null;
	return {
		id: event.id,
		kind: event.kind,
		createdAt: event.createdAt,
		requestId: event.requestId,
		source: event.source ? sanitizeEventSource(event.source) : undefined,
		target: event.target ? sanitizeTargetForStorage(event.target) : undefined,
		actionId: event.actionId,
		loopId: event.loopId,
		summary: event.summary,
		redaction: sanitizeRedaction(event.redaction),
		retention: sanitizeRetention(event.retention),
	};
}

export function sanitizeTargetForStorage(target: AlfredTarget): AlfredTarget {
	return {
		kind: target.kind,
		ref: target.ref,
		label: target.label,
		workspaceRef: target.workspaceRef,
		workspaceLabel: target.workspaceLabel,
		surfaceRef: target.surfaceRef,
		processKind: target.processKind,
		current: target.current,
		selected: target.selected,
		confidence: target.confidence,
		capabilities: [...target.capabilities],
	};
}

export function sanitizeTargetAliasForStorage(alias: AlfredTargetAlias): AlfredTargetAlias {
	return {
		id: alias.id,
		alias: alias.alias,
		normalizedAlias: alias.normalizedAlias,
		scope: alias.scope,
		targetRef: alias.targetRef,
		targetKind: alias.targetKind,
		targetLabel: alias.targetLabel,
		workspaceRef: alias.workspaceRef,
		workspaceLabel: alias.workspaceLabel,
		surfaceRef: alias.surfaceRef,
		createdAt: alias.createdAt,
		updatedAt: alias.updatedAt,
		lastSeenAt: alias.lastSeenAt,
		createdBy: sanitizeEventSource(alias.createdBy),
	};
}

function parseStoredEvent(value: unknown): AlfredEvent | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || !isEventKind(value.kind) || typeof value.createdAt !== "string" || typeof value.summary !== "string") return null;
	const redaction = parseRedaction(value.redaction);
	const retention = parseRetention(value.retention);
	if (!redaction || !retention) return null;
	const source = parseStoredSource(value.source);
	const target = parseStoredTarget(value.target);
	return {
		id: value.id,
		kind: value.kind,
		createdAt: value.createdAt,
		requestId: typeof value.requestId === "string" ? value.requestId : undefined,
		source,
		target,
		actionId: typeof value.actionId === "string" ? value.actionId : undefined,
		loopId: typeof value.loopId === "string" ? value.loopId : undefined,
		summary: value.summary,
		redaction,
		retention,
	};
}

function parseStoredTarget(value: unknown): AlfredTarget | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.kind !== "string" || typeof value.ref !== "string" || typeof value.label !== "string" || !Array.isArray(value.capabilities)) return undefined;
	const capabilities = value.capabilities.filter((capability): capability is AlfredTarget["capabilities"][number] => typeof capability === "string");
	return sanitizeTargetForStorage({
		kind: value.kind as AlfredTarget["kind"],
		ref: value.ref,
		label: value.label,
		workspaceRef: typeof value.workspaceRef === "string" ? value.workspaceRef : undefined,
		workspaceLabel: typeof value.workspaceLabel === "string" ? value.workspaceLabel : undefined,
		surfaceRef: typeof value.surfaceRef === "string" ? value.surfaceRef : undefined,
		processKind: typeof value.processKind === "string" ? value.processKind as AlfredTarget["processKind"] : undefined,
		current: typeof value.current === "boolean" ? value.current : undefined,
		selected: typeof value.selected === "boolean" ? value.selected : undefined,
		confidence: typeof value.confidence === "string" ? value.confidence as AlfredTarget["confidence"] : undefined,
		capabilities,
	});
}

function parseStoredTargetAlias(value: unknown): AlfredTargetAlias | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.alias !== "string" || typeof value.normalizedAlias !== "string" || (value.scope !== "workspace" && value.scope !== "global")) return undefined;
	if (typeof value.targetRef !== "string" || typeof value.targetKind !== "string" || typeof value.targetLabel !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
	const createdBy = parseStoredSource(value.createdBy);
	if (!createdBy) return undefined;
	return sanitizeTargetAliasForStorage({
		id: value.id,
		alias: value.alias,
		normalizedAlias: value.normalizedAlias,
		scope: value.scope,
		targetRef: value.targetRef,
		targetKind: value.targetKind as AlfredTargetAlias["targetKind"],
		targetLabel: value.targetLabel,
		workspaceRef: typeof value.workspaceRef === "string" ? value.workspaceRef : undefined,
		workspaceLabel: typeof value.workspaceLabel === "string" ? value.workspaceLabel : undefined,
		surfaceRef: typeof value.surfaceRef === "string" ? value.surfaceRef : undefined,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined,
		createdBy,
	});
}

function parseStoredSource(value: unknown): Pick<AlfredSource, "kind" | "id" | "label"> | undefined {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return undefined;
	return { kind: value.kind as AlfredSource["kind"], id: value.id, label: typeof value.label === "string" ? value.label : undefined };
}

function sanitizeEventSource(source: Pick<AlfredSource, "kind" | "id" | "label">): Pick<AlfredSource, "kind" | "id" | "label"> {
	return { kind: source.kind, id: source.id, label: source.label };
}

function parseRedaction(value: unknown): RedactionMetadata | null {
	if (!isRecord(value) || (value.status !== "not_needed" && value.status !== "redacted" && value.status !== "contains_sensitive" && value.status !== "unknown")) return null;
	return sanitizeRedaction({
		status: value.status,
		rulesApplied: Array.isArray(value.rulesApplied) ? value.rulesApplied.filter((rule): rule is string => typeof rule === "string") : undefined,
		originalLength: typeof value.originalLength === "number" ? value.originalLength : undefined,
	});
}

function sanitizeRedaction(redaction: RedactionMetadata): RedactionMetadata {
	return {
		status: redaction.status,
		rulesApplied: redaction.rulesApplied ? [...redaction.rulesApplied] : undefined,
		originalLength: redaction.originalLength,
	};
}

function parseRetention(value: unknown): RetentionMetadata | null {
	if (!isRecord(value) || (value.policy !== "ephemeral" && value.policy !== "session" && value.policy !== "short" && value.policy !== "manual")) return null;
	return sanitizeRetention({
		policy: value.policy,
		expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
		reason: typeof value.reason === "string" ? value.reason : undefined,
	});
}

function sanitizeRetention(retention: RetentionMetadata): RetentionMetadata {
	return { policy: retention.policy, expiresAt: retention.expiresAt, reason: retention.reason };
}

function eventExpired(retention: RetentionMetadata, nowIso: IsoTimestamp): boolean {
	return typeof retention.expiresAt === "string" && retention.expiresAt <= nowIso;
}

function isEventKind(value: unknown): value is AlfredEventKind {
	return typeof value === "string" && EVENT_KINDS.includes(value as AlfredEventKind);
}

function writeAtomicJson(path: string, value: unknown): void {
	const tempPath = `${path}.tmp-${process.pid}`;
	writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
}

function newestFirst(events: readonly AlfredEvent[]): AlfredEvent[] {
	return [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function warningFor(action: string, error: unknown): string {
	return `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function clampMaxEvents(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_STORAGE_MAX_EVENTS;
	return Math.max(1, Math.min(10_000, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}
