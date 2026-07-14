import test from "node:test";
import assert from "node:assert/strict";
import { webSearch, fetchContent, type WebSearchResult } from "../src/alfred-2/tools/web.ts";
import { ALFRED_AUTONOMOUS_DEFAULTS } from "../src/alfred-2/tool-types.ts";
import type { ToolExecutionContext } from "../src/alfred-2/tool-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CTX: ToolExecutionContext = {
	requestId: "req-test-1",
	toolCallId: "tc-test-1",
	risk: "external",
};

/** Create a minimal fake Exa client with a mocked search method. */
function fakeExaClient(opts: {
	search?: (query: string, params: any) => Promise<{ results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string; publishedDate?: string }> }>;
	getContents?: (urls: string[], params?: any) => Promise<{ results?: Array<{ text?: string; url?: string; title?: string }> }>;
}) {
	return {
		search: opts.search ?? (async () => ({ results: [] })),
		getContents: opts.getContents ?? (async () => ({ results: [] })),
	} as any;
}

/** Fake fetch for plain-HTTP fallback tests (fetchContent without API key). */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof globalThis.fetch {
	return ((async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		return await handler(urlStr, init);
	}) as unknown) as typeof globalThis.fetch;
}

// Save/restore globals for fetch tests
const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// webSearch
// ---------------------------------------------------------------------------

test("webSearch returns graceful error when EXA_API_KEY is not configured", async () => {
	const result = await webSearch(
		{ tool: "web_search", query: "test" },
		DEFAULT_CTX,
		null, // explicit null = no client
	);
	assert.equal(result.tool, "web_search");
	assert.equal(result.success, false);
	assert.match(result.text, /EXA_API_KEY/i);
	assert.equal(result.retryable, false);
});

test("webSearch returns structured results from Exa with mocked client", async () => {
	const numResults = ALFRED_AUTONOMOUS_DEFAULTS.webDefaultResults;
	const hits = Array.from({ length: numResults }, (_, i) => ({
		title: `Result ${i + 1}`,
		url: `https://example.com/${i + 1}`,
		highlights: [`Snippet for result ${i + 1}`],
		publishedDate: `2026-01-${String(i + 1).padStart(2, "0")}`,
	}));

	const fakeExa = fakeExaClient({
		search: async (_query, _params) => ({ results: hits }),
	});

	const result = await webSearch(
		{ tool: "web_search", query: "alfred test" },
		DEFAULT_CTX,
		fakeExa,
	);

	assert.equal(result.tool, "web_search");
	assert.equal(result.success, true);
	assert.ok(Array.isArray(result.data));
	assert.equal(result.data!.length, numResults);
	assert.equal(result.data![0]!.title, "Result 1");
	assert.equal(result.data![0]!.url, "https://example.com/1");
	assert.equal(result.data![0]!.snippet, "Snippet for result 1");
	assert.match(result.text, /Result 1/);
});

test("webSearch respects numResults and caps at max 10", async () => {
	let capturedNumResults: number | undefined;
	const fakeExa = fakeExaClient({
		search: async (_query, params: any) => {
			capturedNumResults = params.numResults;
			return { results: [] };
		},
	});

	await webSearch({ tool: "web_search", query: "q", numResults: 3 }, DEFAULT_CTX, fakeExa);
	assert.equal(capturedNumResults, 3);

	await webSearch({ tool: "web_search", query: "q", numResults: 15 }, DEFAULT_CTX, fakeExa);
	assert.equal(capturedNumResults, ALFRED_AUTONOMOUS_DEFAULTS.webMaxResults);

	await webSearch({ tool: "web_search", query: "q", numResults: 0 }, DEFAULT_CTX, fakeExa);
	assert.equal(capturedNumResults, 1);

	await webSearch({ tool: "web_search", query: "q" }, DEFAULT_CTX, fakeExa);
	assert.equal(capturedNumResults, ALFRED_AUTONOMOUS_DEFAULTS.webDefaultResults);
});

test("webSearch returns search errors as retryable failure", async () => {
	const fakeExa = fakeExaClient({
		search: async () => { throw new Error("rate limited"); },
	});

	const result = await webSearch(
		{ tool: "web_search", query: "rate limited" },
		DEFAULT_CTX,
		fakeExa,
	);

	assert.equal(result.tool, "web_search");
	assert.equal(result.success, false);
	assert.equal(result.retryable, true);
	assert.match(result.text, /rate limited/);
});

test("webSearch returns empty results gracefully", async () => {
	const fakeExa = fakeExaClient({
		search: async () => ({ results: [] }),
	});

	const result = await webSearch(
		{ tool: "web_search", query: "noresults" },
		DEFAULT_CTX,
		fakeExa,
	);

	assert.equal(result.tool, "web_search");
	assert.equal(result.success, true);
	assert.match(result.text, /No results/i);
	assert.deepEqual(result.data, []);
});

// ---------------------------------------------------------------------------
// fetchContent via Exa SDK
// ---------------------------------------------------------------------------

test("fetchContent uses Exa SDK getContents when client is available", async () => {
	let getContentsCalled = false;
	const fakeExa = fakeExaClient({
		getContents: async (urls: string[], _params?: any) => {
			getContentsCalled = true;
			assert.deepEqual(urls, ["https://example.com/page"]);
			return { results: [{ text: "exa extracted content", url: "https://example.com/page" }] };
		},
	});

	const result = await fetchContent(
		{ tool: "fetch_content", url: "https://example.com/page" },
		DEFAULT_CTX,
		fakeExa,
	);

	assert.equal(result.tool, "fetch_content");
	assert.equal(result.success, true);
	assert.equal(result.data, "exa extracted content");
	assert.equal(getContentsCalled, true);
});

test("fetchContent falls back to plain HTTP when Exa SDK throws", async () => {
	const fakeExa = fakeExaClient({
		getContents: async () => { throw new Error("Exa unavailable"); },
	});

	// Need real fetch for the HTTP fallback
	const html = "<html><body><p>Hello fallback</p></body></html>";
	globalThis.fetch = ((async () => new Response(html, {
		status: 200,
		headers: { "Content-Type": new Headers({ "Content-Type": "text/html" }).get("Content-Type") ?? "text/html" },
	}) as unknown) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/page" },
			DEFAULT_CTX,
			fakeExa,
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, true);
		assert.match(result.text!, /Hello fallback/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchContent without Exa key uses plain HTTP", async () => {
	const html = "<html><body><h1>Hello World</h1><p>test paragraph</p><script>hidden</script></body></html>";
	globalThis.fetch = ((async () => new Response(html, {
		status: 200,
		headers: { "Content-Type": new Headers({ "Content-Type": "text/html; charset=utf-8" }).get("Content-Type") ?? "text/html" },
	}) as unknown) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/test" },
			DEFAULT_CTX,
			null, // no Exa client
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, true);
		assert.match(result.text, /Hello World/);
		assert.match(result.text, /test paragraph/);
		assert.ok(!result.text!.includes("hidden"));
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchContent truncates large responses", async () => {
	const largeBody = "A".repeat(12_000);
	globalThis.fetch = ((async () => new Response(largeBody, {
		status: 200,
		headers: { "Content-Type": new Headers({ "Content-Type": "text/plain" }).get("Content-Type") ?? "text/plain" },
	}) as unknown) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/large" },
			DEFAULT_CTX,
			null,
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, true);
		assert.ok(result.text!.length < 12_000);
		assert.match(result.text, /truncated/i);
		assert.equal(result.truncation?.truncated, true);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchContent handles HTTP error responses", async () => {
	globalThis.fetch = ((async () => new Response("Not Found", {
		status: 404,
		headers: { "Content-Type": new Headers({ "Content-Type": "text/plain" }).get("Content-Type") ?? "text/plain" },
	}) as unknown) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/missing" },
			DEFAULT_CTX,
			null,
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, false);
		assert.match(result.text, /404/);
		assert.equal(result.retryable, false);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchContent marks 5xx as retryable", async () => {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = ((async () => new Response("Server Error", { status: 503 })) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/busy" },
			DEFAULT_CTX,
			null,
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, false);
		assert.equal(result.retryable, true);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchContent handles unsupported content type", async () => {
	globalThis.fetch = ((async () => new Response("png data", {
		status: 200,
		headers: { "Content-Type": new Headers({ "Content-Type": "image/png" }).get("Content-Type") ?? "image/png" },
	}) as unknown) as typeof globalThis.fetch);

	try {
		const result = await fetchContent(
			{ tool: "fetch_content", url: "https://example.com/image.png" },
			DEFAULT_CTX,
			null,
		);

		assert.equal(result.tool, "fetch_content");
		assert.equal(result.success, false);
		assert.match(result.text, /Unsupported content type/i);
	} finally {
		globalThis.fetch = realFetch;
	}
});
