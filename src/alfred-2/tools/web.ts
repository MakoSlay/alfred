import {
	ALFRED_AUTONOMOUS_DEFAULTS,
	type FetchContentToolCall,
	type ToolExecutionContext,
	type ToolResult,
	type WebSearchToolCall,
} from "../tool-types.ts";
import { createStructuredFailure } from "../capabilities/outcome.ts";
import type { StructuredFailure } from "../capabilities/failure-codes.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
}

/** Minimal Exa client interface for type-safe dependency injection. */
export interface ExaClient {
	search(query: string, options?: Record<string, unknown>): Promise<{ results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string; publishedDate?: string }> }>;
	getContents(urls: string[], options?: Record<string, unknown>): Promise<{ results?: Array<{ text?: string; url?: string; title?: string }> }>;
}

/** Typed contract so other providers can be slotted in later. */
export interface WebToolProvider {
	webSearch(
		query: string,
		numResults: number,
		ctx: ToolExecutionContext,
	): Promise<ToolResult<WebSearchResult[]>>;

	fetchContent(
		url: string,
		ctx: ToolExecutionContext,
	): Promise<ToolResult<string>>;
}

// ---------------------------------------------------------------------------
// Exa SDK helper
// ---------------------------------------------------------------------------

function exaApiKey(): string | null {
	return process.env["EXA_API_KEY"]?.trim() || null;
}

let _ExaClass: { new (key: string): ExaClient } | null = null;

async function getExaClass(): Promise<{ new (key: string): ExaClient } | null> {
	if (_ExaClass) return _ExaClass;
	try {
		const mod = await import("exa-js");
		const ExaConstructor = (mod as any).default ?? (mod as any).Exa;
		if (typeof ExaConstructor === "function") {
			_ExaClass = ExaConstructor as unknown as { new (key: string): ExaClient };
		}
		return _ExaClass;
	} catch {
		return null;
	}
}

function createExaClient(): ExaClient | null {
	const key = exaApiKey();
	if (!key) return null;
	if (!_ExaClass) return null;
	return new _ExaClass(key);
}

function exaResultToWebResult(result: {
	title?: string;
	url?: string;
	highlights?: string[];
	publishedDate?: string;
	text?: string;
}): WebSearchResult {
	return {
		title: result.title ?? "Untitled",
		url: result.url ?? "",
		snippet: result.highlights?.join(" ... ") ?? result.text ?? "",
		publishedDate: result.publishedDate,
	};
}

// ---------------------------------------------------------------------------
// Tool entry points
// ---------------------------------------------------------------------------

export async function webSearch(
	toolCall: WebSearchToolCall,
	ctx: ToolExecutionContext,
	_exaOverride?: ExaClient | null,
): Promise<ToolResult<WebSearchResult[]>> {
	const t0 = Date.now();

	// Lazy-load the Exa SDK on first use
	if (!_ExaClass) await getExaClass();

	const exa = _exaOverride !== undefined ? _exaOverride : createExaClient();

	if (!exa) {
		return {
			tool: "web_search",
			toolCallId: ctx.toolCallId,
			success: false,
			text: "EXA_API_KEY is not configured. Set it in the environment to enable web search.",
			retryable: false,
			failure: externalFailure("precondition.missing_config", "EXA_API_KEY is not configured.", false, { configKeysMissing: ["EXA_API_KEY"] }),
			safety: { risk: "external", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	const numResults = Math.min(
		Math.max(1, toolCall.numResults ?? ALFRED_AUTONOMOUS_DEFAULTS.webDefaultResults),
		ALFRED_AUTONOMOUS_DEFAULTS.webMaxResults,
	);

	try {
		const response = await exa.search(toolCall.query, {
			type: "auto",
			numResults,
			contents: { highlights: true },
		});

		const results: WebSearchResult[] = (response.results ?? []).map(exaResultToWebResult);

		if (results.length === 0) {
			return {
				tool: "web_search",
				toolCallId: ctx.toolCallId,
				success: true,
				text: "No results found for that query.",
				data: [],
				retryable: false,
				safety: { risk: "external", confirmation: "none" },
				timingMs: Date.now() - t0,
			};
		}

		const text = results
			.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.publishedDate ? ` (${result.publishedDate})` : ""}\n   ${result.snippet.slice(0, 300)}`)
			.join("\n\n");

		return {
			tool: "web_search",
			toolCallId: ctx.toolCallId,
			success: true,
			text,
			data: results,
			retryable: false,
			safety: { risk: "external", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "web_search",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `Web search failed: ${message}`,
			retryable: true,
			failure: externalFailure("execution.internal_error", message, true),
			safety: { risk: "external", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}
}

// ---------------------------------------------------------------------------
// fetchContent
// ---------------------------------------------------------------------------

const MAX_FETCH_CONTENT_CHARS = 8_000;

export async function fetchContent(
	toolCall: FetchContentToolCall,
	ctx: ToolExecutionContext,
	_exaOverride?: ExaClient | null,
): Promise<ToolResult<string>> {
	const t0 = Date.now();

	// Lazy-load the Exa SDK on first use
	if (!_ExaClass) await getExaClass();

	const exa = _exaOverride !== undefined ? _exaOverride : createExaClient();

	// Try Exa content retrieval first when API key is available
	if (exa) {
		try {
			const response = await exa.getContents([toolCall.url], { text: true });
			const hit = response.results?.[0];
			const raw = hit?.text ?? "";
			const text = raw.length > MAX_FETCH_CONTENT_CHARS
				? raw.slice(0, MAX_FETCH_CONTENT_CHARS) + `\n[truncated ${raw.length - MAX_FETCH_CONTENT_CHARS} chars]`
				: raw;

			return {
				tool: "fetch_content",
				toolCallId: ctx.toolCallId,
				success: true,
				text: text || "(empty content)",
				data: text,
				retryable: false,
				safety: { risk: "external", confirmation: "none" },
				timingMs: Date.now() - t0,
				truncation: raw.length > MAX_FETCH_CONTENT_CHARS
					? { truncated: true, originalBytes: Buffer.byteLength(raw, "utf8"), shownBytes: Buffer.byteLength(text, "utf8"), limitBytes: MAX_FETCH_CONTENT_CHARS }
					: undefined,
			};
		} catch {
			// Exa content retrieval failed; fall through to plain HTTP fetch
		}
	}

	// Plain HTTP fetch + strip HTML
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("fetch_content (HTTP) timed out")), ctx.timeoutMs ?? 15_000);
	try {
		const res = await fetch(toolCall.url, {
			signal: controller.signal,
			headers: { "User-Agent": "Alfred/0.1" },
		});

		if (!res.ok) {
			const failure = res.status === 429
				? externalFailure("execution.rate_limited", `HTTP ${res.status} while fetching content.`, true, { httpStatus: res.status, rateLimited: true })
				: res.status >= 500
					? externalFailure("execution.provider_5xx", `HTTP ${res.status} while fetching content.`, true, { httpStatus: res.status })
					: externalFailure("execution.internal_error", `HTTP ${res.status} while fetching content.`, false, { httpStatus: res.status });
			return {
				tool: "fetch_content",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `HTTP ${res.status}: failed to fetch ${toolCall.url}`,
				retryable: res.status >= 500 || res.status === 429,
				failure,
				safety: { risk: "external", confirmation: "none" },
				timingMs: Date.now() - t0,
			};
		}

		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
			return {
				tool: "fetch_content",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Unsupported content type: ${contentType}. Only text/html and text/plain are supported.`,
				retryable: false,
				failure: externalFailure("execution.internal_error", `Unsupported content type: ${contentType}.`, false),
				safety: { risk: "external", confirmation: "none" },
				timingMs: Date.now() - t0,
			};
		}

		const raw = await res.text();
		const stripped = contentType.includes("text/html") ? stripHtml(raw) : raw;
		const text = stripped.length > MAX_FETCH_CONTENT_CHARS
			? stripped.slice(0, MAX_FETCH_CONTENT_CHARS) + `\n[truncated ${stripped.length - MAX_FETCH_CONTENT_CHARS} chars]`
			: stripped;

		return {
			tool: "fetch_content",
			toolCallId: ctx.toolCallId,
			success: true,
			text: text || "(empty content)",
			data: text,
			retryable: false,
			safety: { risk: "external", confirmation: "none" },
			timingMs: Date.now() - t0,
			truncation: stripped.length > MAX_FETCH_CONTENT_CHARS
				? { truncated: true, originalBytes: Buffer.byteLength(stripped, "utf8"), shownBytes: Buffer.byteLength(text, "utf8"), limitBytes: MAX_FETCH_CONTENT_CHARS }
				: undefined,
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const timedOut = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
		return {
			tool: "fetch_content",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `Content fetch failed: ${message}`,
			retryable: true,
			failure: timedOut
				? externalFailure("execution.timeout", message, true, { timedOut: true })
				: externalFailure("execution.network_transient", message, true),
			safety: { risk: "external", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	} finally {
		clearTimeout(timer);
	}
}

function externalFailure(
	code: "precondition.missing_config" | "execution.internal_error" | "execution.rate_limited" | "execution.provider_5xx" | "execution.timeout" | "execution.network_transient",
	message: string,
	retryable: boolean,
	details: Partial<Pick<StructuredFailure, "timedOut" | "rateLimited" | "httpStatus" | "configKeysMissing">> = {},
): StructuredFailure {
	return createStructuredFailure({
		stage: code.startsWith("precondition.") ? "execute" : "execute",
		code,
		component: "web-tools",
		message,
		retryable,
		...details,
		detector: { id: "alfred.web.typed", version: 1 },
	});
}

// ---------------------------------------------------------------------------
// HTML stripping (no jsdom / readability — simple regex, per spec)
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<[^>]*>/g;
const WHITESPACE_RE = /\s+/g;
const ENTITY_RE = /&(?:[a-z]+|#\d+);/gi;

const ENTITY_MAP: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

function decodeEntities(text: string): string {
	return text.replace(ENTITY_RE, (entity) => ENTITY_MAP[entity.toLowerCase()] ?? entity);
}

function stripHtml(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style|noscript|iframe|svg)[\s>][\s\S]*?<\/\1>/gi, "")
			.replace(HTML_TAG_RE, " ")
			.replace(WHITESPACE_RE, " ")
			.trim(),
	);
}
