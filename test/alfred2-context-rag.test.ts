import test from "node:test";
import assert from "node:assert/strict";
import { buildRelevantSystemContext } from "../src/alfred-2/context-rag.ts";
import type { HistoryEntry } from "../src/alfred-2/history.ts";

const FULL_CONTEXT = `CURRENT DATE/TIME: Thursday, July 2, 2026 at 5:00:00 PM EDT (America/Toronto; UTC 2026-07-02T21:00:00.000Z)

WORKSPACES (2):
  Main [current] | ref:workspace:1 | /Users/me/work/alfred | branch: main (DIRTY)
    PR: #81 Alfred dashboard
  KPI | ref:workspace:2 | /Users/me/work/kpi | branch: feature (clean)
    PR: #3079 Add labels

NOTIFICATIONS (2):
  Build finished (unread)
  Calendar starts soon

CMUX COMMANDS REFERENCE:
${"very long help\n".repeat(1000)}`;

const HISTORY: HistoryEntry[] = [
	{ timestamp: "2026-07-02T20:00:00.000Z", userText: "check my GitHub PRs", speech: "PR three zero seven nine looks best, sir.", executed: false, requiresConfirmation: false, importance: "normal" },
	{ timestamp: "2026-07-02T20:01:00.000Z", userText: "what emails need attention?", speech: "There are security alerts, sir.", executed: false, requiresConfirmation: false, importance: "normal", toolSummary: "gmail_search:ok" },
];

test("RAG context for email requests omits workspace and cmux bulk", () => {
	const result = buildRelevantSystemContext({ userText: "what is the most recent GitHub email talking about?", fullContext: FULL_CONTEXT, recentHistory: HISTORY });
	assert.match(result.text, /CURRENT DATE\/TIME/);
	assert.doesNotMatch(result.text, /WORKSPACES \(2\)/);
	assert.doesNotMatch(result.text, /CMUX COMMANDS REFERENCE/);
	assert.ok(result.omittedPacks.includes("workspaces"));
	assert.ok(result.omittedPacks.includes("cmux-reference"));
});

test("RAG context for PR requests includes workspace PR signals", () => {
	const result = buildRelevantSystemContext({ userText: "which PR should I work on?", fullContext: FULL_CONTEXT, recentHistory: HISTORY });
	assert.match(result.text, /WORKSPACES \(2\)/);
	assert.match(result.text, /#3079 Add labels/);
	assert.ok(result.includedPacks.includes("workspaces"));
});

test("RAG context respects max char cap", () => {
	const result = buildRelevantSystemContext({ userText: "what notifications need attention?", fullContext: FULL_CONTEXT, recentHistory: HISTORY, maxChars: 500 });
	assert.ok(result.text.length <= 520);
	assert.match(result.text, /rag-truncated|RAG CONTEXT PACKS/);
});
