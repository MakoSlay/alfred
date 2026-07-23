export const MEMORY_KINDS = ["profile", "session", "knowledge"] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];

export type MemoryProvenanceSource = "manual" | "conversation" | "tool" | "import";

/** Captured when a memory is written; it is not reconstructed during recall. */
export interface MemoryProvenance {
	source: MemoryProvenanceSource;
	sourceId?: string;
	requestId?: string;
	turnId?: string;
	timestamp: string;
	/** Optional normalized confidence from 0 to 1. */
	confidence?: number;
	/** Explicit review workflow metadata; sourceId/requestId/turnId still identify the source turn. */
	review?: {
		batchId: string;
		candidateId: string;
		requestId: string;
		sessionId: string;
		sessionRecordId: string;
	};
}

export interface BaseMemoryRecord {
	id: string;
	kind: MemoryKind;
	createdAt: string;
	updatedAt: string;
	provenance: MemoryProvenance;
}

export type ProfileMemoryCategory = "preference" | "identity" | "context" | "note";
export type ReviewedMemoryCategory = Extract<ProfileMemoryCategory, "preference" | "identity">;

export interface ProfileMemoryRecord extends BaseMemoryRecord {
	kind: "profile";
	key: string;
	value: string;
	category: ProfileMemoryCategory;
}

/**
 * Ephemeral, sanitized conversation state. Tool names and compact outcomes are
 * retained, but raw tool stdout/stderr is never part of this record.
 */
export interface SessionMemoryRecord extends BaseMemoryRecord {
	kind: "session";
	ephemeral: true;
	userText: string;
	finalSpeech: string;
	toolsUsed: string[];
	workspaceHint: string;
	shortOutcome: string;
}

export type KnowledgeSourceType = "document" | "note" | "project";
export type KnowledgeSourceStatus = "metadata_only" | "indexed" | "error";
export type KnowledgeSourceOrigin = "dashboard" | "file" | "assistant";

/** Durable metadata for an imported local knowledge source. */
export interface KnowledgeSourceRecord extends BaseMemoryRecord {
	kind: "knowledge";
	title: string;
	sourceType: KnowledgeSourceType;
	location?: string;
	mimeType?: string;
	sizeBytes?: number;
	contentHash?: string;
	status: KnowledgeSourceStatus;
	/** How this source entered Knowledge. Assistant-created sources are visibly marked. */
	origin?: KnowledgeSourceOrigin;
	error?: string;
	chunkCount?: number;
	indexedAt?: string;
}

/** One deterministic lexical-retrieval unit persisted in chunks.jsonl. */
export interface KnowledgeChunkRecord {
	id: string;
	sourceId: string;
	index: number;
	text: string;
	startChar: number;
	endChar: number;
	contentHash: string;
	createdAt: string;
}

/** Bounded passage returned by lexical search and safe to cite by ID. */
export interface KnowledgeSearchMatch {
	citationId: string;
	sourceId: string;
	chunkId: string;
	title: string;
	sourceType: KnowledgeSourceType;
	origin?: KnowledgeSourceOrigin;
	location?: string;
	chunkIndex: number;
	text: string;
	score: number;
}

export type KnowledgeCitation = KnowledgeSearchMatch;

export type MemoryRecord = ProfileMemoryRecord | SessionMemoryRecord | KnowledgeSourceRecord;

/** A request-scoped suggestion derived only from explicitly selected session user text. */
export interface ReviewedMemoryCandidate {
	id: string;
	batchId: string;
	reviewRequestId: string;
	ephemeral: true;
	key: string;
	value: string;
	category: ReviewedMemoryCategory;
	source: {
		sessionId: string;
		sessionRecordId: string;
		requestId?: string;
		turnId?: string;
		timestamp: string;
		/** Bounded, exact filtered evidence from the selected user-authored request only. */
		userText: string;
	};
	conflict?: {
		type: "existing_key";
		record: ProfileMemoryRecord;
	};
}

export type MemoryCandidateExclusionReason = "secret_or_sensitive" | "no_supported_fact";

export interface MemoryCandidateBatch {
	batchId: string;
	requestId: string;
	sessionId: string;
	ephemeral: true;
	createdAt: string;
	expiresAt: string;
	candidates: ReviewedMemoryCandidate[];
	excluded: Array<{ turnId: string; reason: MemoryCandidateExclusionReason }>;
}

export interface ProfileMemoryRecallResult {
	kind: "profile";
	record: ProfileMemoryRecord;
}

export interface SessionMemoryRecallResult {
	kind: "session";
	record: SessionMemoryRecord;
}

export interface KnowledgeMemoryRecallResult {
	kind: "knowledge";
	record: KnowledgeSourceRecord;
	citation: KnowledgeSearchMatch;
}

export type MemoryRecallResult = ProfileMemoryRecallResult | SessionMemoryRecallResult | KnowledgeMemoryRecallResult;

/** Grouped because lexical Knowledge scores are not comparable with profile/session substring matches. */
export interface MemoryRecallResponse {
	query: string;
	kinds: MemoryKind[];
	limit: number;
	total: number;
	groups: {
		profile: ProfileMemoryRecallResult[];
		session: SessionMemoryRecallResult[];
		knowledge: KnowledgeMemoryRecallResult[];
	};
	/** Exact Knowledge passages that may be cited for this request only. */
	citations: KnowledgeCitation[];
}

/** Shared backend/frontend hydration contract for the Memory page. */
export interface MemoryDashboardState {
	profile: {
		persistent: true;
		count: number;
		records: ProfileMemoryRecord[];
	};
	session: {
		ephemeral: true;
		count: number;
		records: SessionMemoryRecord[];
		currentContextTokens: number;
		cumulativeTotalTokens: number;
	};
	knowledge: {
		persistent: true;
		available: boolean;
		count: number;
		sources: KnowledgeSourceRecord[];
	};
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string"
		|| !MEMORY_KINDS.includes(record.kind as MemoryKind)
		|| typeof record.createdAt !== "string"
		|| typeof record.updatedAt !== "string"
		|| !isMemoryProvenance(record.provenance)) return false;

	if (record.kind === "profile") {
		return typeof record.key === "string"
			&& typeof record.value === "string"
			&& ["preference", "identity", "context", "note"].includes(String(record.category));
	}
	if (record.kind === "session") {
		return record.ephemeral === true
			&& typeof record.userText === "string"
			&& typeof record.finalSpeech === "string"
			&& Array.isArray(record.toolsUsed)
			&& record.toolsUsed.every((tool) => typeof tool === "string")
			&& typeof record.workspaceHint === "string"
			&& typeof record.shortOutcome === "string";
	}
	return typeof record.title === "string"
		&& ["document", "note", "project"].includes(String(record.sourceType))
		&& ["metadata_only", "indexed", "error"].includes(String(record.status))
		&& (record.location === undefined || typeof record.location === "string")
		&& (record.mimeType === undefined || typeof record.mimeType === "string")
		&& (record.sizeBytes === undefined || (typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0))
		&& (record.contentHash === undefined || typeof record.contentHash === "string")
		&& (record.origin === undefined || ["dashboard", "file", "assistant"].includes(String(record.origin)))
		&& (record.error === undefined || typeof record.error === "string")
		&& (record.chunkCount === undefined || (typeof record.chunkCount === "number" && Number.isInteger(record.chunkCount) && record.chunkCount >= 0))
		&& (record.indexedAt === undefined || typeof record.indexedAt === "string");
}

function isMemoryProvenance(value: unknown): value is MemoryProvenance {
	if (!value || typeof value !== "object") return false;
	const provenance = value as Record<string, unknown>;
	return ["manual", "conversation", "tool", "import"].includes(String(provenance.source))
		&& typeof provenance.timestamp === "string"
		&& (provenance.sourceId === undefined || typeof provenance.sourceId === "string")
		&& (provenance.requestId === undefined || typeof provenance.requestId === "string")
		&& (provenance.turnId === undefined || typeof provenance.turnId === "string")
		&& (provenance.confidence === undefined
			|| (typeof provenance.confidence === "number" && Number.isFinite(provenance.confidence) && provenance.confidence >= 0 && provenance.confidence <= 1))
		&& (provenance.review === undefined || isMemoryReviewProvenance(provenance.review));
}

function isMemoryReviewProvenance(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const review = value as Record<string, unknown>;
	return typeof review.batchId === "string"
		&& typeof review.candidateId === "string"
		&& typeof review.requestId === "string"
		&& typeof review.sessionId === "string"
		&& typeof review.sessionRecordId === "string";
}
