import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAlfredModelResponse } from "../src/alfred-2/parser.ts";
import {
	buildDriveDocsQuery,
	buildGoogleAuthUrl,
	decodeBase64Url,
	docsRead,
	extractGoogleDocText,
	gmailSearch,
	parseGoogleOAuthClient,
} from "../src/alfred-2/tools/google.ts";
import type { ToolExecutionContext } from "../src/alfred-2/tool-types.ts";

const ctx: ToolExecutionContext = { requestId: "req", toolCallId: "tool", risk: "external" };

test("google oauth helpers parse desktop client and build consent URL", () => {
	const client = parseGoogleOAuthClient(JSON.stringify({ installed: { client_id: "client-id", client_secret: "secret" } }));
	const url = new URL(buildGoogleAuthUrl({ client, redirectUri: "http://127.0.0.1:123/oauth2callback", scopes: ["scope-a", "scope-b"], state: "state-1" }));
	assert.equal(url.hostname, "accounts.google.com");
	assert.equal(url.searchParams.get("client_id"), "client-id");
	assert.equal(url.searchParams.get("access_type"), "offline");
	assert.equal(url.searchParams.get("prompt"), "consent");
	assert.equal(url.searchParams.get("scope"), "scope-a scope-b");
	assert.equal(url.searchParams.get("state"), "state-1");
});

test("google content helpers decode Gmail and extract Docs text", () => {
	assert.equal(decodeBase64Url("SGVsbG8td29ybGQ_"), "Hello-world?");
	assert.equal(extractGoogleDocText({ body: { content: [{ paragraph: { elements: [{ textRun: { content: "Hello " } }, { textRun: { content: "Docs\n" } }] } }] } }), "Hello Docs");
	assert.match(buildDriveDocsQuery("Muhammad's plan"), /mimeType='application\/vnd\.google-apps\.document'/);
	assert.match(buildDriveDocsQuery("Muhammad's plan"), /Muhammad\\'s plan/);
});

test("parser accepts read-only google tool calls", () => {
	assert.equal(parseAlfredModelResponse(JSON.stringify({ tool: "gmail_search", query: "newer_than:7d", maxResults: 5 })).kind, "tool");
	assert.equal(parseAlfredModelResponse(JSON.stringify({ tool: "calendar_today" })).kind, "tool");
	assert.equal(parseAlfredModelResponse(JSON.stringify({ tool: "docs_read", documentId: "doc-1" })).kind, "tool");
	const bad = parseAlfredModelResponse(JSON.stringify({ tool: "gmail_read" }));
	assert.equal(bad.kind, "retryable_error");
});

test("gmail_search uses saved token and fetches metadata", async () => {
	const paths = googleFixturePaths();
	const calls: string[] = [];
	const fetchImpl = async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("/messages?") || url.includes("/messages&q")) {
			return jsonResponse({ messages: [{ id: "msg-1" }] });
		}
		return jsonResponse({
			id: "msg-1",
			threadId: "thread-1",
			snippet: "A useful note",
			payload: { headers: [{ name: "From", value: "A <a@example.com>" }, { name: "Subject", value: "Hello" }, { name: "Date", value: "Today" }] },
		});
	};
	const result = await gmailSearch({ tool: "gmail_search", query: "from:a@example.com", maxResults: 1 }, ctx, { ...paths, fetchImpl: fetchImpl as typeof fetch });
	assert.equal(result.success, true);
	assert.equal(result.data?.[0]?.subject, "Hello");
	assert.match(result.text, /ID: msg-1/);
	assert.equal(calls.length, 2);
});

test("docs_read extracts document text", async () => {
	const paths = googleFixturePaths();
	const fetchImpl = async () => jsonResponse({ title: "Plan", body: { content: [{ paragraph: { elements: [{ textRun: { content: "First line\n" } }] } }] } });
	const result = await docsRead({ tool: "docs_read", documentId: "doc-1" }, ctx, { ...paths, fetchImpl: fetchImpl as typeof fetch });
	assert.equal(result.success, true);
	assert.equal(result.data?.name, "Plan");
	assert.match(result.text, /First line/);
});

function googleFixturePaths(): { clientPath: string; tokenPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "alfred-google-test-"));
	const clientPath = join(dir, "client.json");
	const tokenPath = join(dir, "token.json");
	writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "client-id", client_secret: "secret" } }));
	writeFileSync(tokenPath, JSON.stringify({ access_token: "access-token", expiry_date: Date.now() + 3600_000 }));
	return { clientPath, tokenPath };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
