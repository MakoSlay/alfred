import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { chunkKnowledgeText, createKnowledgeStore, normalizeKnowledgeText } from "../src/alfred-2/knowledge.ts";
import { parseAlfredModelResponse } from "../src/alfred-2/parser.ts";
import { classifyToolRisk } from "../src/alfred-2/risk.ts";
import { startAlfred2 } from "../src/alfred-2/server.ts";
import { PendingConfirmationStore } from "../src/alfred-2/confirmation.ts";
import { runToolLoop } from "../src/alfred-2/tool-loop.ts";
import { createSessionMemory } from "../src/alfred-2/memory.ts";
import { createProfileStore } from "../src/alfred-2/profile.ts";
import { importKnowledge } from "../src/alfred-2/tools/knowledge.ts";
import type { AlfredToolCall } from "../src/alfred-2/tool-types.ts";

function temporaryKnowledge(): { root: string; knowledge: string; profile: string; history: string } {
	const root = mkdtempSync(join(tmpdir(), "alfred-knowledge-"));
	return { root, knowledge: join(root, "knowledge"), profile: join(root, "profile.json"), history: join(root, "history.json") };
}

test("Text and Markdown chunking is normalized and deterministic", () => {
	const input = `# Release notes\r\n\r\n${"alpha beta gamma ".repeat(180)}\r\n\r\nFinal checklist.`;
	const first = chunkKnowledgeText(input);
	const second = chunkKnowledgeText(input);
	assert.deepEqual(first, second);
	assert.ok(first.length > 1);
	assert.equal(first[0]?.startChar, 0);
	assert.equal(first.at(-1)?.endChar, normalizeKnowledgeText(input).length);
	assert.ok(first.every((chunk) => chunk.text.length <= 1_200));
	assert.ok(first.slice(1).every((chunk, index) => chunk.startChar < first[index]!.endChar));
});

test("knowledge store persists private metadata/chunks and supports lexical search, reindex, and deletion", () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		const imported = store.ingest({
			title: "Operations handbook",
			content: "# Release checklist\n\nRun typecheck before deployment. Verify the lighthouse token after deployment.",
			location: "handbook.md",
			mimeType: "text/markdown",
		});
		assert.equal(imported.created, true);
		assert.equal(imported.source.status, "indexed");
		assert.ok((imported.source.chunkCount ?? 0) > 0);
		assert.equal(store.ingest({ title: "Duplicate", content: "# Release checklist\n\nRun typecheck before deployment. Verify the lighthouse token after deployment.", location: "copy.md" }).created, false);
		assert.equal(statSync(paths.knowledge).mode & 0o777, 0o700);
		assert.equal(statSync(store.sourcesFile).mode & 0o777, 0o600);
		assert.equal(statSync(store.chunksFile).mode & 0o777, 0o600);
		assert.match(readFileSync(store.sourcesFile, "utf8"), /Operations handbook/);
		assert.match(readFileSync(store.chunksFile, "utf8"), /lighthouse token/);

		const matches = store.search("lighthouse deployment");
		assert.equal(matches[0]?.title, "Operations handbook");
		assert.match(matches[0]?.citationId ?? "", /^knowledge:knowledge-.*:chunk-/);
		assert.match(matches[0]?.text ?? "", /lighthouse token/);

		const reindexed = store.reindexSource(imported.source.id, "The canary phrase is blue orchard. Run smoke tests.");
		assert.equal(reindexed?.chunkCount, 1);
		assert.equal(store.search("lighthouse").length, 0);
		assert.equal(store.search("blue orchard")[0]?.sourceId, imported.source.id);
		assert.equal(store.deleteSource(imported.source.id), true);
		assert.deepEqual(store.listSources(), []);
		assert.deepEqual(store.listChunks(), []);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("knowledge store rolls back an interrupted two-file index write", () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		const imported = store.ingest({ title: "Recovery note", content: "Keep the violet recovery phrase." });
		const oldSources = readFileSync(store.sourcesFile, "utf8");
		const oldChunks = readFileSync(store.chunksFile, "utf8");
		writeFileSync(join(paths.knowledge, ".index-transaction.json"), JSON.stringify({ oldSources, oldChunks }), { mode: 0o600 });
		writeFileSync(store.sourcesFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sources: [] }));
		writeFileSync(store.chunksFile, "");
		assert.equal(store.listSources()[0]?.id, imported.source.id);
		assert.match(readFileSync(store.chunksFile, "utf8"), /violet recovery phrase/);
		assert.equal(store.search("violet recovery")[0]?.sourceId, imported.source.id);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("search returns a bounded citation window around a late-chunk match", () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		store.ingest({ title: "Long note", content: `${"preface ".repeat(130)}NEEDLE appears with grounded context ${"ending ".repeat(40)}` });
		const match = store.search("preface needle", { maxCharsPerResult: 240 })[0];
		assert.ok(match);
		assert.ok((match?.text.length ?? 0) <= 242);
		assert.match(match?.text ?? "", /NEEDLE/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("search_knowledge is parsed and read-only, and tool-loop citations are request-scoped and validated", async () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		const imported = store.ingest({ title: "Garden notes", sourceType: "note", content: "The greenhouse access phrase is silver fern." });
		const parsed = parseAlfredModelResponse('{"tool":"search_knowledge","query":"greenhouse phrase","limit":3}');
		assert.equal(parsed.kind, "tool");
		assert.equal(parseAlfredModelResponse('{"tool":"import_knowledge","path":"docs/notes.md"}').kind, "tool");
		assert.equal(parseAlfredModelResponse('{"tool":"import_knowledge","title":"Brief","content":"Generated note"}').kind, "tool");
		assert.equal(parseAlfredModelResponse('{"tool":"import_knowledge","path":"a.md","content":"both"}').kind, "retryable_error");
		assert.equal(parseAlfredModelResponse('{"tool":"import_knowledge","path":"notes.md","cwd":"/tmp"}').kind, "retryable_error");
		assert.deepEqual(classifyToolRisk({ tool: "search_knowledge", query: "greenhouse phrase" }), { risk: "read", confirmation: "none" });
		assert.deepEqual(classifyToolRisk({ tool: "import_knowledge", path: "docs/notes.md" }), { risk: "mutation", confirmation: "confirm" });
		const citationId = store.search("greenhouse phrase")[0]!.citationId;
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"search_knowledge","query":"greenhouse phrase"}',
				JSON.stringify({ speech: "The phrase is silver fern, sir.", displayText: "The greenhouse phrase is silver fern.", citations: [citationId, "knowledge:invented"] }),
			]),
			userText: "What is the greenhouse phrase?",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-knowledge",
			sessionId: "session-knowledge",
			knowledgeStore: store,
			speakAcknowledgements: false,
		});
		assert.equal(result.citations.length, 1);
		assert.equal(result.citations[0]?.sourceId, imported.source.id);
		assert.match(result.displayText, /Sources/);
		assert.match(result.displayText, /Garden notes/);
		assert.doesNotMatch(result.speech, /knowledge:|Sources/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("unified recall exposes only request-scoped Knowledge citations", async () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		const profileStore = createProfileStore(paths.profile);
		const imported = store.ingest({ title: "Launch notes", content: "The launch signal is amber lantern." });
		const citationId = store.search("amber lantern")[0]!.citationId;
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"recall","query":"amber lantern","kinds":["knowledge"]}',
				JSON.stringify({ speech: "The signal is amber lantern, sir.", citations: [citationId, "knowledge:invented"] }),
			]),
			userText: "Recall the launch signal",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-unified-recall",
			sessionId: "session-unified-recall",
			profileStore,
			knowledgeStore: store,
			memory: createSessionMemory(),
			speakAcknowledgements: false,
		});
		assert.equal(result.citations.length, 1);
		assert.equal(result.citations[0]?.sourceId, imported.source.id);
		assert.equal(result.citations[0]?.citationId, citationId);
		assert.doesNotMatch(JSON.stringify(result.citations), /invented/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("Knowledge-backed answers fail closed when citation repair remains uncited", async () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		store.ingest({ title: "Launch notes", content: "The launch signal is amber lantern." });
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"recall","query":"amber lantern","kinds":["knowledge"]}',
				'{"speech":"The signal is amber lantern, sir."}',
				'{"speech":"The signal is amber lantern, sir."}',
			]),
			userText: "Recall the launch signal",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-unified-recall-uncited",
			sessionId: "session-unified-recall-uncited",
			profileStore: createProfileStore(paths.profile),
			knowledgeStore: store,
			memory: createSessionMemory(),
			speakAcknowledgements: false,
		});
		assert.equal(result.outcome.status, "failed");
		assert.deepEqual(result.citations, []);
		assert.match(result.displayText, /citation was missing or invalid/i);
		assert.doesNotMatch(result.speech, /amber lantern/i);
		assert.doesNotMatch(result.displayText, /amber lantern/i);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("import_knowledge reads safe workspace files and blocks symlink escapes", () => {
	const paths = temporaryKnowledge();
	const outside = mkdtempSync(join(tmpdir(), "alfred-knowledge-outside-"));
	try {
		writeFileSync(join(paths.root, "handbook.md"), "# Handbook\n\nThe launch color is indigo.");
		writeFileSync(join(outside, "secret.md"), "outside workspace secret");
		symlinkSync(join(outside, "secret.md"), join(paths.root, "escape.md"));
		const store = createKnowledgeStore(paths.knowledge);
		const imported = importKnowledge(
			{ tool: "import_knowledge", path: "handbook.md" },
			{ requestId: "req-file-import", toolCallId: "tool-file-import", cwd: paths.root, risk: "mutation" },
			store,
		);
		assert.equal(imported.success, true);
		assert.equal(imported.data?.source?.origin, "file");
		assert.equal(imported.data?.source?.location, "handbook.md");
		assert.equal(store.search("launch indigo")[0]?.sourceId, imported.data?.source?.id);

		const absolute = importKnowledge(
			{ tool: "import_knowledge", path: join(paths.root, "handbook.md") },
			{ requestId: "req-file-absolute", toolCallId: "tool-file-absolute", cwd: paths.root, risk: "mutation" },
			store,
		);
		assert.equal(absolute.success, false);
		assert.match(absolute.text, /workspace-relative/);

		const escaped = importKnowledge(
			{ tool: "import_knowledge", path: "escape.md" },
			{ requestId: "req-file-escape", toolCallId: "tool-file-escape", cwd: paths.root, risk: "mutation" },
			store,
		);
		assert.equal(escaped.success, false);
		assert.match(escaped.text, /escapes the workspace/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("import_knowledge confirmation-gates and labels assistant-created notes", async () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		const confirmations = new PendingConfirmationStore<AlfredToolCall>();
		const first = await runToolLoop({
			llmClient: createFakeLlmClient(['{"tool":"import_knowledge","title":"Generated brief","content":"# Brief\\n\\nThe generated finding is cobalt.","sourceType":"note"}']),
			userText: "Save your brief to Knowledge",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-generated-import",
			sessionId: "session-generated-import",
			knowledgeStore: store,
			confirmationStore: confirmations,
			autoConfirm: true,
			speakAcknowledgements: false,
		});
		assert.equal(first.requiresConfirmation, true);
		assert.match(first.displayText, /The generated finding is cobalt/);
		assert.equal(store.listSources().length, 0);

		const second = await runToolLoop({
			llmClient: createFakeLlmClient(['{"speech":"Saved the brief, sir."}']),
			userText: "confirm",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-generated-import-confirm",
			sessionId: "session-generated-import",
			knowledgeStore: store,
			confirmationStore: confirmations,
			confirm: true,
			confirmationId: first.confirmationId,
			speakAcknowledgements: false,
		});
		assert.equal(second.requiresConfirmation, false);
		const source = store.listSources()[0];
		assert.equal(source?.origin, "assistant");
		assert.equal(source?.provenance.source, "tool");
		assert.match(second.toolResults[0]?.text ?? "", /assistant-created/);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("tool loop requests a citation repair instead of auto-attaching unselected passages", async () => {
	const paths = temporaryKnowledge();
	try {
		const store = createKnowledgeStore(paths.knowledge);
		store.ingest({ title: "Policy", content: "The travel limit is four hundred pounds." });
		const citationId = store.search("travel limit")[0]!.citationId;
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"search_knowledge","query":"travel limit"}',
				'{"speech":"The limit is four hundred pounds, sir."}',
				JSON.stringify({ speech: "The limit is four hundred pounds, sir.", citations: [citationId] }),
			]),
			userText: "What is the travel limit?",
			systemContext: "Current date: 2026-07-14",
			requestId: "req-citation-repair",
			sessionId: "session-citation-repair",
			knowledgeStore: store,
			speakAcknowledgements: false,
		});
		assert.deepEqual(result.citations.map((citation) => citation.citationId), [citationId]);
		assert.equal(result.toolRounds, 1);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("/ask serializes validated knowledge citations", async () => {
	const paths = temporaryKnowledge();
	const store = createKnowledgeStore(paths.knowledge);
	store.ingest({ title: "Concierge notes", content: "The guest Wi-Fi phrase is quiet library." });
	const citationId = store.search("guest wifi phrase")[0]!.citationId;
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		profileFile: paths.profile,
		historyFile: paths.history,
		knowledgeDirectory: paths.knowledge,
		llm: {
			endpoint: "https://example.invalid/v1",
			model: "fake",
			apiKey: "fake",
			llmClient: createFakeLlmClient([
				'{"tool":"search_knowledge","query":"guest wifi phrase"}',
				JSON.stringify({ speech: "The phrase is quiet library, sir.", citations: [citationId] }),
			]),
		},
	});
	try {
		const response = await fetch(`http://${server.host}:${server.port}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "What is the guest Wi-Fi phrase?", playback: "browser" }),
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { citations: Array<{ citationId: string; title: string }>; displayText: string };
		assert.deepEqual(body.citations.map((citation) => citation.citationId), [citationId]);
		assert.equal(body.citations[0]?.title, "Concierge notes");
		assert.match(body.displayText, /Sources/);
	} finally {
		await server.close();
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("Alfred 2 refuses a non-loopback bind for private knowledge APIs", async () => {
	await assert.rejects(startAlfred2({
		host: "0.0.0.0",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
	}), /must bind to a loopback host/);
});

test("knowledge dashboard APIs ingest, search, reindex, hydrate, and delete sources", async () => {
	const paths = temporaryKnowledge();
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		profileFile: paths.profile,
		historyFile: paths.history,
		knowledgeDirectory: paths.knowledge,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
	});
	const baseUrl = `http://${server.host}:${server.port}`;
	try {
		const blockedOrigin = await fetch(`${baseUrl}/api/memory/knowledge/sources`, { headers: { Origin: "https://evil.example" } });
		assert.equal(blockedOrigin.status, 403);
		assert.equal(blockedOrigin.headers.get("cache-control"), "no-store");
		const wrongContentType = await fetch(`${baseUrl}/api/memory/knowledge/search`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ query: "launch" }) });
		assert.equal(wrongContentType.status, 415);
		assert.equal(wrongContentType.headers.get("cache-control"), "no-store");
		const oversized = await fetch(`${baseUrl}/api/memory/knowledge/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Too large", content: "x".repeat(5 * 1024 * 1024) }) });
		assert.equal(oversized.status, 413);
		assert.equal(oversized.headers.get("cache-control"), "no-store");
		const malformedDelete = await fetch(`${baseUrl}/api/memory/knowledge/sources/%`, { method: "DELETE" });
		assert.equal(malformedDelete.status, 400);
		assert.equal(malformedDelete.headers.get("cache-control"), "no-store");
		const malformedReindex = await fetch(`${baseUrl}/api/memory/knowledge/sources/%/reindex`, { method: "POST" });
		assert.equal(malformedReindex.status, 400);
		assert.equal(malformedReindex.headers.get("cache-control"), "no-store");

		const importedResponse = await fetch(`${baseUrl}/dashboard/knowledge/sources`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Launch plan", content: "Launch on Thursday after the amber readiness review.", sourceType: "document", location: "launch.md", mimeType: "text/markdown" }),
		});
		assert.equal(importedResponse.status, 201);
		const imported = await importedResponse.json() as { source: { id: string } };
		const sourceListResponse = await fetch(`${baseUrl}/api/memory/knowledge/sources`);
		assert.equal(sourceListResponse.headers.get("cache-control"), "no-store");

		const state = await fetch(`${baseUrl}/dashboard/state`).then((response) => response.json()) as { memory: { knowledge: { available: boolean; count: number } } };
		assert.equal(state.memory.knowledge.available, true);
		assert.equal(state.memory.knowledge.count, 1);

		const search = await fetch(`${baseUrl}/api/memory/knowledge/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "amber readiness" }),
		}).then((response) => response.json()) as { matches: Array<{ sourceId: string }> };
		assert.equal(search.matches[0]?.sourceId, imported.source.id);

		const reindex = await fetch(`${baseUrl}/dashboard/knowledge/sources/${encodeURIComponent(imported.source.id)}/reindex`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		assert.equal(reindex.status, 200);
		const removed = await fetch(`${baseUrl}/api/memory/knowledge/sources/${encodeURIComponent(imported.source.id)}`, { method: "DELETE" });
		assert.equal(removed.status, 200);
	} finally {
		await server.close();
		rmSync(paths.root, { recursive: true, force: true });
	}
});
