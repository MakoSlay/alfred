import { randomUUID } from "node:crypto";
import type {
	MemoryCandidateBatch,
	MemoryCandidateExclusionReason,
	ProfileMemoryRecord,
	ReviewedMemoryCandidate,
	ReviewedMemoryCategory,
	SessionMemoryRecord,
} from "../memory-types.ts";

export const MEMORY_CANDIDATE_TTL_MS = 15 * 60_000;
export const MAX_MEMORY_CANDIDATE_BATCHES = 5;
export const MAX_MEMORY_CANDIDATE_TURNS = 10;
export const MAX_MEMORY_CANDIDATES_PER_BATCH = 10;
export const MAX_REVIEWED_MEMORY_KEY_LENGTH = 80;
export const MAX_REVIEWED_MEMORY_VALUE_LENGTH = 240;

export class MemoryCandidateError extends Error {
	readonly code: "candidate_not_found" | "candidate_expired" | "candidate_session_mismatch" | "candidate_invalid" | "source_not_found";

	constructor(
		code: "candidate_not_found" | "candidate_expired" | "candidate_session_mismatch" | "candidate_invalid" | "source_not_found",
		message: string,
	) {
		super(message);
		this.code = code;
	}
}

export interface ReviewedMemoryWrite {
	key: string;
	value: string;
	category: ReviewedMemoryCategory;
}

interface ExtractedMemoryWrite extends ReviewedMemoryWrite {
	evidence: string;
}

interface ExtractCandidateInput {
	requestId: string;
	sessionId: string;
	turnIds: string[];
	turns: SessionMemoryRecord[];
	profileRecords: ProfileMemoryRecord[];
	now?: Date;
}

const forbiddenContentPatterns = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/i,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
	/\bsk-[A-Za-z0-9_-]{16,}\b/i,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\b(?:password|passcode|credential|secret|api[ _-]?key|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|auth(?:entication)?[ _-]?token|session[ _-]?(?:id|cookie)|recovery[ _-]?code|otp[ _-]?(?:seed|secret))\b/i,
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i,
	/\b(?=[A-Za-z0-9_=-]{32,}\b)(?=[A-Za-z0-9_=-]*[A-Za-z])(?=[A-Za-z0-9_=-]*\d)[A-Za-z0-9_=-]+\b/,
	/\b(?:diagnos(?:is|ed)|medical condition|health condition|disability|cancer|diabetes|depression|anxiety|hiv|aids|pregnan(?:t|cy)|medication|therapy|therapist|religion|religious|muslim|christian|jewish|hindu|buddhist|atheist|race|ethnicity|ethnic|sexual orientation|gender identity|political party|vote for|bank account|credit card|card number|social security|ssn|government id|passport number|home address|date of birth|birth date|birthday|dob|born on|criminal record|legal status)\b/i,
	/\b\d{3}-\d{2}-\d{4}\b/,
	/\b(?:\+?\d[\s().-]*){10,15}\b/,
];

export function containsForbiddenMemoryContent(value: string): boolean {
	return forbiddenContentPatterns.some((pattern) => pattern.test(value));
}

export function validateReviewedMemoryWrite(input: ReviewedMemoryWrite): ReviewedMemoryWrite {
	const key = input.key.trim().toLowerCase();
	const value = input.value.trim();
	if (!/^[a-z][a-z0-9_]*$/.test(key) || key.length > MAX_REVIEWED_MEMORY_KEY_LENGTH) {
		throw new MemoryCandidateError("candidate_invalid", `Memory keys must use lowercase letters, numbers, and underscores and be at most ${MAX_REVIEWED_MEMORY_KEY_LENGTH} characters.`);
	}
	if (!value || value.length > MAX_REVIEWED_MEMORY_VALUE_LENGTH) {
		throw new MemoryCandidateError("candidate_invalid", `Memory values must be between 1 and ${MAX_REVIEWED_MEMORY_VALUE_LENGTH} characters.`);
	}
	if (input.category !== "preference" && input.category !== "identity") {
		throw new MemoryCandidateError("candidate_invalid", "Reviewed extraction only supports preference and identity memories.");
	}
	if (containsForbiddenMemoryContent(`${key.replace(/_/g, " ")}\n${value}`)) {
		throw new MemoryCandidateError("candidate_invalid", "This candidate cannot be saved because it may contain secret or sensitive information.");
	}
	return { key, value, category: input.category };
}

export function extractReviewedMemoryCandidates(input: ExtractCandidateInput): MemoryCandidateBatch {
	if (!input.requestId.trim() || input.requestId.length > 128) throw new MemoryCandidateError("candidate_invalid", "A bounded review request ID is required.");
	if (!input.sessionId.trim()) throw new MemoryCandidateError("candidate_invalid", "A server session ID is required.");
	if (input.turnIds.length < 1 || input.turnIds.length > MAX_MEMORY_CANDIDATE_TURNS || new Set(input.turnIds).size !== input.turnIds.length) {
		throw new MemoryCandidateError("candidate_invalid", `Select between 1 and ${MAX_MEMORY_CANDIDATE_TURNS} unique current-session requests.`);
	}
	const now = input.now ?? new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + MEMORY_CANDIDATE_TTL_MS).toISOString();
	const batchId = `candidate-batch-${randomUUID()}`;
	const turns = new Map(input.turns.map((turn) => [turn.id, turn]));
	const existingByKey = new Map(input.profileRecords.map((record) => [record.key.trim().toLowerCase(), record]));
	const candidates: ReviewedMemoryCandidate[] = [];
	const excluded: Array<{ turnId: string; reason: MemoryCandidateExclusionReason }> = [];
	const missingTurnId = input.turnIds.find((turnId) => !turns.has(turnId));
	if (missingTurnId) throw new MemoryCandidateError("source_not_found", "A selected request is no longer available in current-session memory. Refresh and select again.");

	for (const turnId of input.turnIds) {
		const turn = turns.get(turnId)!;
		if (containsForbiddenMemoryContent(turn.userText)) {
			excluded.push({ turnId, reason: "secret_or_sensitive" });
			continue;
		}
		const extracted = extractFromUserText(turn.userText);
		if (extracted.length === 0) {
			excluded.push({ turnId, reason: "no_supported_fact" });
			continue;
		}
		for (const proposal of extracted) {
			const write = validateReviewedMemoryWrite(proposal);
			const existing = existingByKey.get(write.key);
			candidates.push({
				id: `candidate-${randomUUID()}`,
				batchId,
				reviewRequestId: input.requestId,
				ephemeral: true,
				...write,
				source: {
					sessionId: input.sessionId,
					sessionRecordId: turn.id,
					requestId: turn.provenance.requestId,
					turnId: turn.provenance.turnId,
					timestamp: turn.createdAt,
					userText: sanitizeSourceText(proposal.evidence),
				},
				conflict: existing ? { type: "existing_key", record: cloneProfileRecord(existing) } : undefined,
			});
		}
	}

	return {
		batchId,
		requestId: input.requestId,
		sessionId: input.sessionId,
		ephemeral: true,
		createdAt,
		expiresAt,
		candidates: candidates.slice(0, MAX_MEMORY_CANDIDATES_PER_BATCH),
		excluded,
	};
}

export class ReviewedMemoryCandidateStore {
	private readonly batches = new Map<string, MemoryCandidateBatch>();

	create(input: ExtractCandidateInput): MemoryCandidateBatch {
		const now = input.now ?? new Date();
		this.removeExpired(now);
		const batch = extractReviewedMemoryCandidates({ ...input, now });
		if (batch.candidates.length > 0) {
			this.batches.set(batch.batchId, cloneBatch(batch));
			while (this.batches.size > MAX_MEMORY_CANDIDATE_BATCHES) {
				const oldest = this.batches.keys().next().value as string | undefined;
				if (!oldest) break;
				this.batches.delete(oldest);
			}
		}
		return cloneBatch(batch);
	}

	get(batchId: string, candidateId: string, sessionId: string, now = new Date()): ReviewedMemoryCandidate {
		const batch = this.batches.get(batchId);
		if (batch && Date.parse(batch.expiresAt) <= now.getTime()) {
			this.batches.delete(batchId);
			throw new MemoryCandidateError("candidate_expired", "This memory review expired. Extract fresh candidates from the selected session text.");
		}
		if (!batch) throw new MemoryCandidateError("candidate_not_found", "Memory candidate not found.");
		if (batch.sessionId !== sessionId) throw new MemoryCandidateError("candidate_session_mismatch", "Memory candidate does not belong to this server session.");
		const candidate = batch.candidates.find((item) => item.id === candidateId);
		if (!candidate) throw new MemoryCandidateError("candidate_not_found", "Memory candidate not found.");
		return cloneCandidate(candidate);
	}

	consume(batchId: string, candidateId: string, sessionId: string, now = new Date()): ReviewedMemoryCandidate {
		const candidate = this.get(batchId, candidateId, sessionId, now);
		const batch = this.batches.get(batchId)!;
		batch.candidates = batch.candidates.filter((item) => item.id !== candidateId);
		if (batch.candidates.length === 0) this.batches.delete(batchId);
		return candidate;
	}

	clear(): number {
		let removed = 0;
		for (const batch of this.batches.values()) removed += batch.candidates.length;
		this.batches.clear();
		return removed;
	}

	private removeExpired(now: Date): void {
		for (const [batchId, batch] of this.batches) {
			if (Date.parse(batch.expiresAt) <= now.getTime()) this.batches.delete(batchId);
		}
	}
}

function extractFromUserText(userText: string): ExtractedMemoryWrite[] {
	const clauses = userText
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.split(/(?:[.!?]\s+|\n+)/)
		.map((clause) => clause.trim().replace(/[.!?]+$/, ""))
		.filter(Boolean)
		.slice(0, 20);
	const results: ExtractedMemoryWrite[] = [];
	for (const original of clauses) {
		const clause = original.replace(/^remember(?:\s+that)?\s+/i, "").trim();
		let match = clause.match(/^(?:please\s+)?call me\s+(.+)$/i) ?? clause.match(/^my name is\s+(.+)$/i);
		if (match) {
			const value = cleanValue(match[1] ?? "");
			if (isPlausibleName(value)) results.push({ key: "preferred_name", value, category: "identity", evidence: original });
			continue;
		}
		match = clause.match(/^my preferred\s+([a-z][a-z0-9 _-]{1,60})\s+is\s+(.+)$/i);
		if (match) {
			results.push({ key: `preferred_${slug(match[1] ?? "")}`, value: cleanValue(match[2] ?? ""), category: "preference", evidence: original });
			continue;
		}
		match = clause.match(/^i prefer\s+(.+?)\s+for\s+([a-z][a-z0-9 _-]{1,60})$/i);
		if (match) {
			results.push({ key: `preferred_${slug(match[2] ?? "")}`, value: cleanValue(match[1] ?? ""), category: "preference", evidence: original });
			continue;
		}
		match = clause.match(/^for\s+([a-z][a-z0-9 _-]{1,60}),?\s+i prefer\s+(.+)$/i);
		if (match) {
			results.push({ key: `preferred_${slug(match[1] ?? "")}`, value: cleanValue(match[2] ?? ""), category: "preference", evidence: original });
			continue;
		}
		match = clause.match(/^i prefer\s+(.+)$/i);
		if (match) {
			const value = cleanValue(match[1] ?? "");
			results.push({ key: `preference_${slug(value)}`, value, category: "preference", evidence: original });
		}
	}
	const seen = new Set<string>();
	return results.filter((result) => {
		if (result.category === "preference" && /\b(?:today|tonight|right now|for now|currently|this (?:task|request|time|session|project)|because|since|due to|so that|and (?:i|my)|but (?:i|my))\b/i.test(`${result.key.replace(/_/g, " ")} ${result.value}`)) return false;
		const fingerprint = `${result.category}\0${result.key}\0${result.value.toLowerCase()}`;
		if (seen.has(fingerprint)) return false;
		seen.add(fingerprint);
		return Boolean(result.value) && result.key.length <= MAX_REVIEWED_MEMORY_KEY_LENGTH && result.value.length <= MAX_REVIEWED_MEMORY_VALUE_LENGTH;
	});
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "preference";
}

function cleanValue(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "").trim();
}

function isPlausibleName(value: string): boolean {
	return value.length >= 1 && value.length <= 80 && !/[\d@/:]/.test(value) && value.split(/\s+/).length <= 6;
}

function sanitizeSourceText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 240);
}

function cloneProfileRecord(record: ProfileMemoryRecord): ProfileMemoryRecord {
	return { ...record, provenance: { ...record.provenance } };
}

function cloneCandidate(candidate: ReviewedMemoryCandidate): ReviewedMemoryCandidate {
	return {
		...candidate,
		source: { ...candidate.source },
		conflict: candidate.conflict ? { type: "existing_key", record: cloneProfileRecord(candidate.conflict.record) } : undefined,
	};
}

function cloneBatch(batch: MemoryCandidateBatch): MemoryCandidateBatch {
	return {
		...batch,
		candidates: batch.candidates.map(cloneCandidate),
		excluded: batch.excluded.map((item) => ({ ...item })),
	};
}
