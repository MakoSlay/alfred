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
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	KnowledgeChunkRecord,
	KnowledgeSearchMatch,
	KnowledgeSourceOrigin,
	KnowledgeSourceRecord,
	KnowledgeSourceType,
} from "./memory-types.ts";

const DEFAULT_KNOWLEDGE_DIRECTORY = join(homedir(), ".alfred", "knowledge");
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_COUNT = 200;
const MAX_TOTAL_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 1_200;
const DEFAULT_CHUNK_OVERLAP = 200;
const SOURCES_VERSION = 1;

interface PersistedSources {
	version: 1;
	updatedAt: string;
	sources: KnowledgeSourceRecord[];
}

export interface KnowledgeImport {
	title: string;
	content: string;
	sourceType?: KnowledgeSourceType;
	location?: string;
	mimeType?: string;
	origin?: KnowledgeSourceOrigin;
}

export interface KnowledgeSearchOptions {
	limit?: number;
	maxCharsPerResult?: number;
	sourceId?: string;
}

export interface KnowledgeStore {
	readonly directory: string;
	readonly sourcesFile: string;
	readonly chunksFile: string;
	listSources(): KnowledgeSourceRecord[];
	listChunks(sourceId?: string): KnowledgeChunkRecord[];
	ingest(input: KnowledgeImport): { source: KnowledgeSourceRecord; created: boolean };
	deleteSource(id: string): boolean;
	reindexSource(id: string, content?: string): KnowledgeSourceRecord | null;
	search(query: string, options?: KnowledgeSearchOptions): KnowledgeSearchMatch[];
}

export interface ChunkTextOptions {
	maxChars?: number;
	overlapChars?: number;
}

export function normalizeKnowledgeText(content: string): string {
	return content
		.replace(/\r\n?/g, "\n")
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.replace(/[\t ]+$/g, ""))
		.join("\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

export function chunkKnowledgeText(content: string, options: ChunkTextOptions = {}): Array<{ text: string; startChar: number; endChar: number }> {
	const text = normalizeKnowledgeText(content);
	if (!text) return [];
	const maxChars = clampInteger(options.maxChars, 200, 4_000, DEFAULT_CHUNK_SIZE);
	const overlapChars = clampInteger(options.overlapChars, 0, Math.floor(maxChars / 2), DEFAULT_CHUNK_OVERLAP);
	const chunks: Array<{ text: string; startChar: number; endChar: number }> = [];
	let start = 0;

	while (start < text.length) {
		let end = Math.min(text.length, start + maxChars);
		if (end < text.length) {
			const minimumBreak = start + Math.floor(maxChars * 0.6);
			const window = text.slice(minimumBreak, end);
			const paragraphBreak = window.lastIndexOf("\n\n");
			const lineBreak = window.lastIndexOf("\n");
			const whitespaceBreak = window.search(/\s+\S*$/);
			const relativeBreak = Math.max(paragraphBreak >= 0 ? paragraphBreak + 2 : -1, lineBreak >= 0 ? lineBreak + 1 : -1, whitespaceBreak);
			if (relativeBreak >= 0) end = minimumBreak + relativeBreak;
		}
		if (end <= start) end = Math.min(text.length, start + maxChars);
		chunks.push({ text: text.slice(start, end), startChar: start, endChar: end });
		if (end >= text.length) break;
		let nextStart = Math.max(start + 1, end - overlapChars);
		while (nextStart < end && nextStart > 0 && !/\s/.test(text[nextStart - 1]!)) nextStart++;
		while (nextStart < end && /\s/.test(text[nextStart]!)) nextStart++;
		start = nextStart >= end ? end : nextStart;
	}
	return chunks;
}

export function createKnowledgeStore(directory: string = DEFAULT_KNOWLEDGE_DIRECTORY): KnowledgeStore {
	const sourcesFile = join(directory, "sources.json");
	const chunksFile = join(directory, "chunks.jsonl");
	const transactionFile = join(directory, ".index-transaction.json");

	function ensureDirectory(): void {
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
		chmodSync(directory, DIRECTORY_MODE);
	}

	function recoverInterruptedWrite(): void {
		if (!existsSync(transactionFile)) return;
		try {
			chmodSync(transactionFile, FILE_MODE);
			const transaction = JSON.parse(readFileSync(transactionFile, "utf8")) as { oldSources?: unknown; oldChunks?: unknown };
			if (!(transaction.oldSources === null || typeof transaction.oldSources === "string")
				|| !(transaction.oldChunks === null || typeof transaction.oldChunks === "string")) {
				throw new Error("transaction journal is invalid");
			}
			restoreFile(sourcesFile, transaction.oldSources);
			restoreFile(chunksFile, transaction.oldChunks);
			rmSync(transactionFile, { force: true });
			fsyncDirectory(directory);
		} catch (cause) {
			throw new Error(`Could not recover interrupted knowledge write ${transactionFile}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	function readSources(): KnowledgeSourceRecord[] {
		ensureDirectory();
		recoverInterruptedWrite();
		if (!existsSync(sourcesFile)) return [];
		try {
			chmodSync(sourcesFile, FILE_MODE);
			const parsed = JSON.parse(readFileSync(sourcesFile, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
			const value = parsed as Record<string, unknown>;
			if (value.version !== SOURCES_VERSION || !Array.isArray(value.sources)) throw new Error("unsupported sources schema");
			const sources = value.sources.map(validateSource);
			const ids = new Set<string>();
			for (const source of sources) {
				if (ids.has(source.id)) throw new Error(`duplicate source id: ${source.id}`);
				ids.add(source.id);
			}
			return sources;
		} catch (cause) {
			throw loadError(sourcesFile, cause);
		}
	}

	function readChunks(): KnowledgeChunkRecord[] {
		ensureDirectory();
		recoverInterruptedWrite();
		if (!existsSync(chunksFile)) return [];
		try {
			chmodSync(chunksFile, FILE_MODE);
			const content = readFileSync(chunksFile, "utf8");
			if (!content.trim()) return [];
			const chunks = content.trimEnd().split("\n").map((line, index) => {
				try {
					return validateChunk(JSON.parse(line) as unknown);
				} catch (cause) {
					throw new Error(`line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
			});
			const ids = new Set<string>();
			for (const chunk of chunks) {
				if (ids.has(chunk.id)) throw new Error(`duplicate chunk id: ${chunk.id}`);
				ids.add(chunk.id);
			}
			return chunks;
		} catch (cause) {
			throw loadError(chunksFile, cause);
		}
	}

	function writeIndex(sources: KnowledgeSourceRecord[], chunks: KnowledgeChunkRecord[]): void {
		ensureDirectory();
		const updatedAt = new Date().toISOString();
		const sourcePayload: PersistedSources = { version: SOURCES_VERSION, updatedAt, sources };
		const serializedSources = `${JSON.stringify(sourcePayload, null, 2)}\n`;
		const serializedChunks = chunks.length ? `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n` : "";
		const sourceTemp = join(directory, `.${basename(sourcesFile)}.tmp-${process.pid}-${randomUUID()}`);
		const chunkTemp = join(directory, `.${basename(chunksFile)}.tmp-${process.pid}-${randomUUID()}`);
		const journalTemp = join(directory, `.index-transaction.tmp-${process.pid}-${randomUUID()}`);
		try {
			writeDurableTemp(sourceTemp, serializedSources);
			writeDurableTemp(chunkTemp, serializedChunks);
			writeDurableTemp(journalTemp, JSON.stringify({
				oldSources: existsSync(sourcesFile) ? readFileSync(sourcesFile, "utf8") : null,
				oldChunks: existsSync(chunksFile) ? readFileSync(chunksFile, "utf8") : null,
			}));
			renameSync(journalTemp, transactionFile);
			fsyncDirectory(directory);
			renameSync(chunkTemp, chunksFile);
			renameSync(sourceTemp, sourcesFile);
			chmodSync(chunksFile, FILE_MODE);
			chmodSync(sourcesFile, FILE_MODE);
			fsyncDirectory(directory);
			rmSync(transactionFile, { force: true });
			fsyncDirectory(directory);
		} catch (cause) {
			rmSync(sourceTemp, { force: true });
			rmSync(chunkTemp, { force: true });
			rmSync(journalTemp, { force: true });
			try { recoverInterruptedWrite(); } catch { /* Preserve the journal for startup recovery. */ }
			throw new Error(`Could not persist knowledge index ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	function listSources(): KnowledgeSourceRecord[] {
		return readSources().map(cloneSource);
	}

	function listChunks(sourceId?: string): KnowledgeChunkRecord[] {
		const chunks = readChunks();
		return chunks.filter((chunk) => !sourceId || chunk.sourceId === sourceId).map((chunk) => ({ ...chunk }));
	}

	function ingest(input: KnowledgeImport): { source: KnowledgeSourceRecord; created: boolean } {
		const normalized = validateImport(input);
		const sources = readSources();
		const chunks = readChunks();
		const contentHash = sha256(normalized.content);
		const duplicate = sources.find((source) => source.contentHash === contentHash && source.status === "indexed");
		if (duplicate) return { source: cloneSource(duplicate), created: false };
		if (sources.length >= MAX_SOURCE_COUNT) throw new Error(`Knowledge index is limited to ${MAX_SOURCE_COUNT} sources.`);
		const incomingBytes = Buffer.byteLength(normalized.content, "utf8");
		const currentBytes = sources.reduce((total, source) => total + (source.sizeBytes ?? 0), 0);
		if (currentBytes + incomingBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error(`Knowledge index is limited to ${MAX_TOTAL_SOURCE_BYTES} total source bytes.`);

		const now = new Date().toISOString();
		const sourceId = `knowledge-${randomUUID()}`;
		const sourceChunks = makeChunks(sourceId, normalized.content, contentHash, now);
		const source: KnowledgeSourceRecord = {
			id: sourceId,
			kind: "knowledge",
			title: normalized.title,
			sourceType: normalized.sourceType,
			location: normalized.location,
			mimeType: normalized.mimeType,
			sizeBytes: incomingBytes,
			contentHash,
			status: "indexed",
			origin: normalized.origin,
			chunkCount: sourceChunks.length,
			indexedAt: now,
			createdAt: now,
			updatedAt: now,
			provenance: { source: normalized.origin === "file" || normalized.origin === "assistant" ? "tool" : "import", sourceId: normalized.location, timestamp: now },
		};
		writeIndex([...sources, source], [...chunks, ...sourceChunks]);
		return { source: cloneSource(source), created: true };
	}

	function deleteSource(id: string): boolean {
		const sources = readSources();
		const index = sources.findIndex((source) => source.id === id);
		if (index < 0) return false;
		sources.splice(index, 1);
		writeIndex(sources, readChunks().filter((chunk) => chunk.sourceId !== id));
		return true;
	}

	function reindexSource(id: string, replacementContent?: string): KnowledgeSourceRecord | null {
		const sources = readSources();
		const sourceIndex = sources.findIndex((source) => source.id === id);
		if (sourceIndex < 0) return null;
		const allChunks = readChunks();
		const oldChunks = allChunks.filter((chunk) => chunk.sourceId === id).sort((a, b) => a.index - b.index);
		const content = replacementContent === undefined ? reconstructSourceText(oldChunks) : normalizeKnowledgeText(replacementContent);
		if (!content) throw new Error("Knowledge source content is empty and cannot be reindexed.");
		if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) throw new Error(`Knowledge source exceeds ${MAX_SOURCE_BYTES} bytes.`);
		const replacementBytes = Buffer.byteLength(content, "utf8");
		const otherBytes = sources.reduce((total, source, index) => total + (index === sourceIndex ? 0 : source.sizeBytes ?? 0), 0);
		if (otherBytes + replacementBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error(`Knowledge index is limited to ${MAX_TOTAL_SOURCE_BYTES} total source bytes.`);
		const now = new Date().toISOString();
		const contentHash = sha256(content);
		const sourceChunks = makeChunks(id, content, contentHash, now);
		const prior = sources[sourceIndex]!;
		const updated: KnowledgeSourceRecord = {
			...prior,
			contentHash,
			sizeBytes: replacementBytes,
			status: "indexed",
			error: undefined,
			chunkCount: sourceChunks.length,
			indexedAt: now,
			updatedAt: now,
		};
		sources[sourceIndex] = updated;
		writeIndex(sources, [...allChunks.filter((chunk) => chunk.sourceId !== id), ...sourceChunks]);
		return cloneSource(updated);
	}

	function search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeSearchMatch[] {
		const terms = tokenize(query).slice(0, 32);
		if (terms.length === 0) return [];
		const limit = clampInteger(options.limit, 1, 10, 5);
		const maxChars = clampInteger(options.maxCharsPerResult, 120, 2_000, 800);
		const sources = readSources().filter((source) => source.status === "indexed" && (!options.sourceId || source.id === options.sourceId));
		const bySource = new Map(sources.map((source) => [source.id, source]));
		const chunks = readChunks().filter((chunk) => bySource.has(chunk.sourceId));
		if (chunks.length === 0) return [];
		const uniqueTerms = [...new Set(terms)];
		const documentFrequency = new Map(uniqueTerms.map((term) => [term, chunks.filter((chunk) => tokenize(chunk.text).includes(term)).length]));
		const phrase = normalizeKnowledgeText(query).toLocaleLowerCase();

		return chunks.map((chunk): KnowledgeSearchMatch | null => {
			const source = bySource.get(chunk.sourceId)!;
			const tokens = tokenize(chunk.text);
			const frequencies = new Map<string, number>();
			for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			let score = 0;
			for (const term of terms) {
				const frequency = frequencies.get(term) ?? 0;
				if (!frequency) continue;
				const df = documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
				score += idf * ((frequency * 2.2) / (frequency + 1.2));
			}
			const titleTokens = tokenize(source.title);
			for (const term of uniqueTerms) if (titleTokens.includes(term)) score += 0.75;
			if (phrase.length >= 3 && chunk.text.toLocaleLowerCase().includes(phrase)) score += 1.5;
			if (score <= 0) return null;
			const excerptTerms = uniqueTerms.slice().sort((a, b) => (frequencies.get(a) ?? 0) - (frequencies.get(b) ?? 0) || (documentFrequency.get(a) ?? 0) - (documentFrequency.get(b) ?? 0) || b.length - a.length || a.localeCompare(b));
			const text = excerptAroundTerms(chunk.text, excerptTerms, maxChars);
			return {
				citationId: `knowledge:${source.id}:${chunk.id}`,
				sourceId: source.id,
				chunkId: chunk.id,
				title: source.title,
				sourceType: source.sourceType,
				origin: source.origin,
				location: source.location,
				chunkIndex: chunk.index,
				text,
				score: Number(score.toFixed(6)),
			};
		}).filter((match): match is KnowledgeSearchMatch => match !== null)
			.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.sourceId.localeCompare(b.sourceId) || a.chunkIndex - b.chunkIndex)
			.slice(0, limit);
	}

	return { directory, sourcesFile, chunksFile, listSources, listChunks, ingest, deleteSource, reindexSource, search };
}

function validateImport(input: KnowledgeImport): Required<Pick<KnowledgeImport, "title" | "content" | "sourceType" | "origin">> & Pick<KnowledgeImport, "location" | "mimeType"> {
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (typeof input.content === "string" && input.content.includes("\0")) throw new Error("Knowledge source must be UTF-8 text, not binary content.");
	const content = typeof input.content === "string" ? normalizeKnowledgeText(input.content) : "";
	const sourceType = input.sourceType ?? "document";
	const origin = input.origin ?? "dashboard";
	const location = typeof input.location === "string" && input.location.trim() ? input.location.trim() : undefined;
	const mimeType = typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim().toLowerCase() : inferMimeType(location);
	if (!title) throw new Error("Knowledge source title is required.");
	if (!content) throw new Error("Knowledge source content is empty.");
	if (!(["document", "note", "project"] as const).includes(sourceType)) throw new Error("Invalid knowledge source type.");
	if (!(["dashboard", "file", "assistant"] as const).includes(origin)) throw new Error("Invalid knowledge source origin.");
	if (mimeType && !["text/plain", "text/markdown", "text/x-markdown"].includes(mimeType)) throw new Error("Only Text and Markdown sources are supported.");
	if (!mimeType && location && /\.[a-z0-9]+$/i.test(location) && !/\.(?:txt|md|markdown)$/i.test(location)) throw new Error("Only .txt, .md, and .markdown files are supported.");
	if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) throw new Error(`Knowledge source exceeds ${MAX_SOURCE_BYTES} bytes.`);
	return { title, content, sourceType, location, mimeType, origin };
}

function inferMimeType(location?: string): string | undefined {
	if (!location) return undefined;
	if (/\.(?:md|markdown)$/i.test(location)) return "text/markdown";
	if (/\.txt$/i.test(location)) return "text/plain";
	return undefined;
}

function makeChunks(sourceId: string, content: string, contentHash: string, now: string): KnowledgeChunkRecord[] {
	return chunkKnowledgeText(content).map((chunk, index) => ({
		id: `chunk-${sha256(`${sourceId}\0${contentHash}\0${index}\0${chunk.startChar}\0${chunk.endChar}`).slice(0, 24)}`,
		sourceId,
		index,
		text: chunk.text,
		startChar: chunk.startChar,
		endChar: chunk.endChar,
		contentHash: sha256(chunk.text),
		createdAt: now,
	}));
}

function reconstructSourceText(chunks: KnowledgeChunkRecord[]): string {
	if (chunks.length === 0) return "";
	const length = Math.max(...chunks.map((chunk) => chunk.endChar));
	const characters = new Array<string>(length);
	for (const chunk of chunks) {
		for (let offset = 0; offset < chunk.text.length; offset++) characters[chunk.startChar + offset] = chunk.text[offset]!;
	}
	return normalizeKnowledgeText(characters.map((character) => character ?? " ").join(""));
}

function validateSource(value: unknown): KnowledgeSourceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source must be an object");
	const source = value as KnowledgeSourceRecord;
	if (typeof source.id !== "string" || !source.id || source.kind !== "knowledge" || typeof source.title !== "string" || !source.title) throw new Error("source identity is invalid");
	if (!["document", "note", "project"].includes(source.sourceType) || !["metadata_only", "indexed", "error"].includes(source.status)) throw new Error("source type or status is invalid");
	if (typeof source.createdAt !== "string" || typeof source.updatedAt !== "string" || !source.provenance || !["import", "tool"].includes(source.provenance.source)) throw new Error("source provenance is invalid");
	if (source.origin !== undefined && !["dashboard", "file", "assistant"].includes(source.origin)) throw new Error("source origin is invalid");
	if (source.chunkCount !== undefined && (!Number.isInteger(source.chunkCount) || source.chunkCount < 0)) throw new Error("source chunkCount is invalid");
	return { ...source, provenance: { ...source.provenance } };
}

function validateChunk(value: unknown): KnowledgeChunkRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("chunk must be an object");
	const chunk = value as KnowledgeChunkRecord;
	if (typeof chunk.id !== "string" || !chunk.id || typeof chunk.sourceId !== "string" || !chunk.sourceId || typeof chunk.text !== "string" || !chunk.text) throw new Error("chunk identity or text is invalid");
	if (!Number.isInteger(chunk.index) || chunk.index < 0 || !Number.isInteger(chunk.startChar) || chunk.startChar < 0 || !Number.isInteger(chunk.endChar) || chunk.endChar <= chunk.startChar) throw new Error("chunk offsets are invalid");
	if (chunk.text.length !== chunk.endChar - chunk.startChar || typeof chunk.contentHash !== "string" || typeof chunk.createdAt !== "string") throw new Error("chunk metadata is invalid");
	return { ...chunk };
}

function excerptAroundTerms(text: string, terms: readonly string[], maxChars: number): string {
	if (text.length <= maxChars) return text.trim();
	const lower = text.toLocaleLowerCase();
	const matchAt = terms.map((term) => lower.indexOf(term)).find((position) => position >= 0) ?? 0;
	let start = Math.max(0, matchAt - Math.floor(maxChars * 0.35));
	let end = Math.min(text.length, start + maxChars);
	start = Math.max(0, end - maxChars);
	if (start > 0) {
		const boundary = text.slice(start, Math.min(end, start + 80)).search(/\s/);
		if (boundary >= 0) start += boundary + 1;
	}
	if (end < text.length) {
		const boundary = text.slice(Math.max(start, end - 80), end).lastIndexOf(" ");
		if (boundary >= 0) end = Math.max(start + 1, end - 80 + boundary);
	}
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function tokenize(text: string): string[] {
	return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 1 || /^\d+$/.test(term));
}

function writeDurableTemp(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: FILE_MODE });
	chmodSync(path, FILE_MODE);
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function restoreFile(path: string, content: string | null): void {
	if (content === null) {
		rmSync(path, { force: true });
		return;
	}
	const temporary = join(dirname(path), `.${basename(path)}.recovery-${process.pid}-${randomUUID()}`);
	writeDurableTemp(temporary, content);
	renameSync(temporary, path);
	chmodSync(path, FILE_MODE);
}

function fsyncDirectory(directory: string): void {
	const fd = openSync(directory, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function loadError(path: string, cause: unknown): Error {
	return new Error(`Could not load knowledge index ${path}; the existing file was left untouched: ${cause instanceof Error ? cause.message : String(cause)}`);
}

function cloneSource(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
	return { ...source, provenance: { ...source.provenance } };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

export function getDefaultKnowledgeDirectory(): string {
	return DEFAULT_KNOWLEDGE_DIRECTORY;
}
