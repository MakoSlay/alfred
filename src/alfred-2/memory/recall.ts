import type { KnowledgeStore } from "../knowledge.ts";
import { getSessionMemoryRecords, type SessionMemory } from "../memory.ts";
import type {
	KnowledgeMemoryRecallResult,
	MemoryKind,
	MemoryRecallResponse,
	ProfileMemoryRecord,
	ProfileMemoryRecallResult,
	SessionMemoryRecallResult,
} from "../memory-types.ts";
import type { ProfileStore } from "../profile.ts";

export const MAX_MEMORY_RECALL_QUERY_LENGTH = 500;
export const MAX_MEMORY_RECALL_LIMIT = 10;
export const DEFAULT_MEMORY_RECALL_LIMIT = 5;

export interface RecallMemoryOptions {
	query: string;
	kinds?: readonly MemoryKind[];
	limit?: number;
}

export function recallMemory(
	options: RecallMemoryOptions,
	stores: { profile: ProfileStore; session: SessionMemory; knowledge: KnowledgeStore },
): MemoryRecallResponse {
	const query = options.query.trim();
	if (!query) throw new Error("Memory recall query is required.");
	if (query.length > MAX_MEMORY_RECALL_QUERY_LENGTH) throw new Error(`Memory recall query is limited to ${MAX_MEMORY_RECALL_QUERY_LENGTH} characters.`);
	const limit = options.limit ?? DEFAULT_MEMORY_RECALL_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_RECALL_LIMIT) {
		throw new Error(`Memory recall limit must be an integer from 1 to ${MAX_MEMORY_RECALL_LIMIT}.`);
	}
	const kinds = normalizeKinds(options.kinds);
	const normalizedQuery = normalize(query);

	const profile: ProfileMemoryRecallResult[] = kinds.includes("profile")
		? stores.profile.recallFact(query)
			.sort(compareRecords)
			.slice(0, limit)
			.map((record) => ({ kind: "profile", record: toProfileRecord(record) }))
		: [];

	const session: SessionMemoryRecallResult[] = kinds.includes("session")
		? getSessionMemoryRecords(stores.session)
			.filter((record) => normalize([record.userText, record.finalSpeech, record.shortOutcome, record.workspaceHint, ...record.toolsUsed].join(" ")).includes(normalizedQuery))
			.sort(compareRecords)
			.slice(0, limit)
			.map((record) => ({ kind: "session", record: cloneRecord(record) }))
		: [];

	const knowledge: KnowledgeMemoryRecallResult[] = [];
	if (kinds.includes("knowledge")) {
		const sources = new Map(stores.knowledge.listSources().map((source) => [source.id, source]));
		knowledge.push(...stores.knowledge.search(query, { limit })
			.flatMap((citation) => {
				const source = sources.get(citation.sourceId);
				return source ? [{ kind: "knowledge" as const, record: cloneRecord(source), citation: { ...citation } }] : [];
			}));
	}
	const citations = knowledge.map((result) => ({ ...result.citation }));

	return {
		query,
		kinds: [...kinds],
		limit,
		total: profile.length + session.length + knowledge.length,
		groups: { profile, session, knowledge },
		citations,
	};
}

function normalizeKinds(kinds: readonly MemoryKind[] | undefined): MemoryKind[] {
	const requested = kinds ?? ["profile", "session", "knowledge"];
	const seen = new Set<MemoryKind>();
	for (const kind of requested) {
		if (kind !== "profile" && kind !== "session" && kind !== "knowledge") throw new Error(`Unsupported memory kind: ${String(kind)}.`);
		seen.add(kind);
	}
	if (seen.size === 0) throw new Error("At least one memory kind is required.");
	return (["profile", "session", "knowledge"] as const).filter((kind) => seen.has(kind));
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function compareRecords(a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function toProfileRecord(record: ProfileMemoryRecord): ProfileMemoryRecord {
	return {
		id: record.id,
		kind: "profile",
		key: record.key,
		value: record.value,
		category: record.category,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		provenance: { ...record.provenance },
	};
}

function cloneRecord<T extends { provenance: object }>(record: T): T {
	return structuredClone(record);
}
