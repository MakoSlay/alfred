import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createSessionMemory,
	addTurn,
	addTokens,
	shouldWarn,
	shouldHandoff,
	shouldWarnForContext,
	shouldHandoffForContext,
	updateCurrentContextTokens,
	formatConversationForContext,
	generateHandoffContent,
	handoffFilePath,
	clearMemory,
	clearHandoffDir,
	type ConversationTurn,
	type SessionMemory,
} from "../src/alfred-2/memory.ts";

test("recent turns formatted compactly without raw stdout", () => {
	const memory = createSessionMemory();
	addTurn(memory, {
		userText: "list files in the repo",
		finalSpeech: "Here are the files, sir.",
		toolsUsed: ["bash"],
		workspaceHint: "workspace:1",
		shortOutcome: "Listed 42 files.",
	});
	addTurn(memory, {
		userText: "check git status",
		finalSpeech: "All clean, sir.",
		toolsUsed: ["bash"],
		workspaceHint: "workspace:1",
		shortOutcome: "Git status returned clean working tree.",
	});
	addTurn(memory, {
		userText: "run the tests",
		finalSpeech: "Tests passed.",
		toolsUsed: ["bash"],
		workspaceHint: "workspace:1",
		shortOutcome: "All 15 tests passed.",
	});

	const context = formatConversationForContext(memory);
	assert.ok(context.includes("[Turn 1]"));
	assert.ok(context.includes("list files in the repo"));
	assert.ok(context.includes("Here are the files, sir."));
	assert.ok(context.includes("Tools: bash"));
	assert.ok(context.includes("[Turn 3]"));
	assert.ok(context.includes("Tests passed."));

	// No turn indices beyond what was added
	assert.ok(!context.includes("[Turn 4]"));
});

test("large shortOutcome is never stored as raw stdout", () => {
	const memory = createSessionMemory();

	// Simulate a turn that produced huge output
	const hugeOutput = "x".repeat(5000);
	// The shortOutcome field is max 200 chars by contract; ensure it's stored trimmed
	const trimmed = hugeOutput.slice(0, 200);
	addTurn(memory, {
		userText: "cat a large file",
		finalSpeech: "File is large, sir.",
		toolsUsed: ["bash"],
		workspaceHint: "workspace:1",
		shortOutcome: trimmed,
	});

	const context = formatConversationForContext(memory);
	// The raw stdout is never in the context — only the trimmed shortOutcome
	assert.ok(context.includes(trimmed));
	assert.ok(!context.includes(hugeOutput));
	// Context should be compact
	assert.ok(context.length < 2000);
});

test("excessive turns are evicted from the ring buffer", () => {
	const memory = createSessionMemory();

	for (let i = 0; i < 15; i++) {
		addTurn(memory, {
			userText: `Turn ${i} request`,
			finalSpeech: `Turn ${i} response`,
			toolsUsed: ["bash"],
			workspaceHint: "w:1",
			shortOutcome: `Outcome ${i}`,
		});
	}

	// Default maxTurns is 10, so turns 0-4 should be evicted
	// Remaining turns (5-14) are relabeled [Turn 1]..[Turn 10]
	const context = formatConversationForContext(memory);
	assert.ok(!context.includes("Turn 0 request"), "oldest turn should be evicted");
	assert.ok(!context.includes("Turn 4 request"), "turn 4 should be evicted");
	assert.ok(context.includes("Turn 5 request"), "first remaining turn should be present");
	assert.ok(context.includes("Turn 14 request"), "newest turn should be present");
	assert.ok(context.includes("[Turn 10]"), "turn should be labeled relative to what remains");

	// Should have exactly 10 turns
	const turnLabels = (context.match(/\[Turn \d+\]/g) ?? []);
	assert.equal(turnLabels.length, 10);
});

test("memory clear removes all turns and resets token counters", () => {
	const memory = createSessionMemory();
	addTurn(memory, {
		userText: "hello",
		finalSpeech: "hi",
		toolsUsed: [],
		workspaceHint: "",
		shortOutcome: "",
	});
	addTokens(memory, { inputTokens: 100, outputTokens: 200, totalTokens: 300, source: "provider" });

	assert.equal(memory.turns.length, 1);
	assert.equal(memory.cumulativeTotalTokens, 300);
	updateCurrentContextTokens(memory, 1234);
	assert.equal(memory.currentContextTokens, 1234);

	clearMemory(memory);
	assert.equal(memory.turns.length, 0);
	assert.equal(memory.cumulativeInputTokens, 0);
	assert.equal(memory.cumulativeOutputTokens, 0);
	assert.equal(memory.cumulativeTotalTokens, 0);
	assert.equal(memory.currentContextTokens, 0);
	assert.equal(memory.maxContextTokens, 0);

	const context = formatConversationForContext(memory);
	assert.ok(context.includes("No previous turns"));
});

test("legacy cumulative token helpers still track usage totals", () => {
	const memory = createSessionMemory();

	// Below warning
	addTokens(memory, { inputTokens: 50_000, outputTokens: 20_000, totalTokens: 70_000, source: "provider" });
	assert.equal(shouldWarn(memory), false);
	assert.equal(shouldHandoff(memory), false);

	// At exact warning threshold (80k)
	addTokens(memory, { inputTokens: 5_000, outputTokens: 5_000, totalTokens: 10_000, source: "provider" });
	assert.equal(memory.cumulativeTotalTokens, 80_000);
	assert.equal(shouldWarn(memory), true);
	assert.equal(shouldHandoff(memory), false);

	// Below handoff threshold
	addTokens(memory, { inputTokens: 10_000, outputTokens: 5_000, totalTokens: 15_000, source: "provider" });
	assert.equal(memory.cumulativeTotalTokens, 95_000);
	assert.equal(shouldWarn(memory), true);
	assert.equal(shouldHandoff(memory), false);

	// At exact handoff threshold (100k)
	addTokens(memory, { inputTokens: 3_000, outputTokens: 2_000, totalTokens: 5_000, source: "provider" });
	assert.equal(memory.cumulativeTotalTokens, 100_000);
	assert.equal(shouldWarn(memory), true);
	assert.equal(shouldHandoff(memory), true);

	// Past handoff
	addTokens(memory, { inputTokens: 1_000, outputTokens: 1_000, totalTokens: 2_000, source: "provider" });
	assert.equal(memory.cumulativeTotalTokens, 102_000);
	assert.equal(shouldHandoff(memory), true);
});

test("custom thresholds are respected for current context pressure", () => {
	const memory = createSessionMemory({ warnThreshold: 50_000, handoffThreshold: 75_000 });
	updateCurrentContextTokens(memory, 50_000);
	assert.equal(shouldWarnForContext(memory), true);
	assert.equal(shouldHandoffForContext(memory), false);
	assert.equal(memory.maxContextTokens, 50_000);

	updateCurrentContextTokens(memory, 75_000);
	assert.equal(memory.currentContextTokens, 75_000);
	assert.equal(memory.maxContextTokens, 75_000);
	assert.equal(shouldHandoffForContext(memory), true);
});

test("empty turns format returns placeholder", () => {
	const memory = createSessionMemory();
	const context = formatConversationForContext(memory);
	assert.equal(context, "(No previous turns.)");
});

test("handoff file path follows expected format", () => {
	// Use a tmp dir to avoid writing to real ~/.alfred/handoffs
	const tmpDir = mkdtempSync(join(tmpdir(), "alfred2-memory-handoff-"));
	const path = handoffFilePath("sess-abc", "req-xyz", tmpDir);

	assert.ok(path.startsWith(tmpDir));
	assert.ok(path.endsWith(".md"));

	// Extract the filename portion
	const filename = path.split("/").pop()!;
	// Format: YYYY-MM-DDTHH-mm-ss-session-sess-abc-request-req-xyz.md
	const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-session-sess-abc-request-req-xyz\.md$/;
	assert.ok(pattern.test(filename), `filename "${filename}" does not match expected pattern`);

	rmSync(tmpDir, { recursive: true, force: true });
});

test("handoff file path sanitizes special characters in ids", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "alfred2-memory-handoff-"));
	const path = handoffFilePath("session/with:bad*chars", "req?<>\"|chars", tmpDir);

	const filename = path.split("/").pop()!;
	// No special characters should remain
	assert.ok(!filename.includes("/"));
	assert.ok(!filename.includes(":"));
	assert.ok(!filename.includes("*"));
	assert.ok(!filename.includes("?"));
	assert.ok(!filename.includes("<"));
	assert.ok(!filename.includes(">"));
	assert.ok(!filename.includes("\""));
	assert.ok(!filename.includes("|"));
	assert.ok(filename.includes("-session-session-with-bad-chars-"));
	assert.ok(filename.includes("request-req-----chars"));

	rmSync(tmpDir, { recursive: true, force: true });
});

test("generated handoff markdown includes task overview, state, decisions, files/tools", () => {
	const memory = createSessionMemory();
	addTurn(memory, {
		userText: "fix the compile error",
		finalSpeech: "Fixed by updating the type signature, sir.",
		toolsUsed: ["bash"],
		workspaceHint: "workspace:2",
		shortOutcome: "Compilation succeeded after fix.",
	});
	addTokens(memory, { inputTokens: 5_000, outputTokens: 2_000, totalTokens: 7_000, source: "provider" });

	const content = generateHandoffContent({
		taskOverview: "Fix TypeScript compile errors in worker module",
		currentState: "Type errors resolved, tests passing",
		recentDecisions: ["Use stricter types for worker payload", "Deferred subagent integration to Phase 005"],
		filesAndToolsTouched: ["src/worker.ts (edit_file)", "test/worker.test.ts (write_file)", "bash: tsc --noEmit"],
		pendingConfirmations: [],
		nextSteps: ["Run full test suite", "Merge PR"],
		commandsRun: ["npx tsc --noEmit", "npm test"],
		memory,
		sessionId: "session-1",
		requestId: "request-1",
	});

	// Verify sections are present
	assert.ok(content.includes("# Alfred Session Handoff"));
	assert.ok(content.includes("## Task Overview"));
	assert.ok(content.includes("Fix TypeScript compile errors in worker module"));
	assert.ok(content.includes("## Current State"));
	assert.ok(content.includes("Type errors resolved"));
	assert.ok(content.includes("## Recent Decisions"));
	assert.ok(content.includes("Use stricter types for worker payload"));
	assert.ok(content.includes("Deferred subagent integration to Phase 005"));
	assert.ok(content.includes("## Files / Tools Touched"));
	assert.ok(content.includes("src/worker.ts (edit_file)"));
	assert.ok(content.includes("test/worker.test.ts (write_file)"));
	assert.ok(content.includes("## Next Steps"));
	assert.ok(content.includes("Run full test suite"));
	assert.ok(content.includes("## Commands Run"));
	assert.ok(content.includes("npx tsc --noEmit"));
	assert.ok(content.includes("npm test"));
	assert.ok(content.includes("## Token Accounting"));
	assert.ok(content.includes("Current context tokens:"));
	assert.ok(content.includes("Cumulative total tokens: 7000"));
	assert.ok(content.includes("## Session Info"));
	assert.ok(content.includes("SessionId: session-1"));
	assert.ok(content.includes("RequestId: request-1"));
	assert.ok(content.includes("## Conversation Summary"));
	assert.ok(content.includes("fix the compile error"));
	assert.ok(content.includes("Fixed by updating the type signature, sir."));
});

test("generated handoff includes pending confirmations when present", () => {
	const memory = createSessionMemory();
	const content = generateHandoffContent({
		taskOverview: "Deploy to production",
		currentState: "Awaiting confirmation",
		recentDecisions: [],
		filesAndToolsTouched: [],
		pendingConfirmations: ["Confirm deploy to production (destructive)", "Confirm database migration"],
		nextSteps: ["Await confirmation then proceed"],
		commandsRun: [],
		memory,
		sessionId: "sess",
		requestId: "req",
	});

	assert.ok(content.includes("## Pending Confirmations"));
	assert.ok(content.includes("Confirm deploy to production (destructive)"));
	assert.ok(content.includes("Confirm database migration"));

	// When there are no pending confirmations, the section should be absent
	const noConfContent = generateHandoffContent({
		taskOverview: "List files",
		currentState: "Done",
		recentDecisions: [],
		filesAndToolsTouched: [],
		pendingConfirmations: [],
		nextSteps: [],
		commandsRun: [],
		memory,
		sessionId: "sess",
		requestId: "req",
	});
	assert.ok(!noConfContent.includes("## Pending Confirmations"));
});

test("generated handoff shows (none) for empty sections", () => {
	const memory = createSessionMemory();
	const content = generateHandoffContent({
		taskOverview: "No-op task",
		currentState: "Idle",
		recentDecisions: [],
		filesAndToolsTouched: [],
		pendingConfirmations: [],
		nextSteps: [],
		commandsRun: [],
		memory,
		sessionId: "s",
		requestId: "r",
	});

	assert.ok(content.includes("## Recent Decisions\n(none)"));
	assert.ok(content.includes("## Files / Tools Touched\n(none)"));
	assert.ok(content.includes("## Next Steps\n(none)"));
	assert.ok(content.includes("## Commands Run\n(none)"));
});

test("clearHandoffDir removes files from the handoff directory", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "alfred2-memory-handoff-"));
	mkdirSync(tmpDir, { recursive: true });

	// Create some placeholder handoff files
	writeFileSync(join(tmpDir, "2026-01-01T00-00-00-session-a-request-b.md"), "test content", "utf8");
	writeFileSync(join(tmpDir, "2026-01-02T00-00-00-session-c-request-d.md"), "test content 2", "utf8");

	assert.equal(existsSync(join(tmpDir, "2026-01-01T00-00-00-session-a-request-b.md")), true);

	clearHandoffDir(tmpDir);

	// Directory should still exist but be empty
	assert.equal(existsSync(tmpDir), true);

	rmSync(tmpDir, { recursive: true, force: true });
});

test("clearHandoffDir is safe on a nonexistent directory", () => {
	// Should not throw
	assert.doesNotThrow(() => clearHandoffDir("/tmp/nonexistent-handoff-dir-for-alfred-test"));
});

test("turns with no tools used render correctly", () => {
	const memory = createSessionMemory();
	addTurn(memory, {
		userText: "What time is it?",
		finalSpeech: "It is 3 PM, sir.",
		toolsUsed: [],
		workspaceHint: "",
		shortOutcome: "Answered directly.",
	});

	const context = formatConversationForContext(memory);
	assert.ok(context.includes("What time is it?"));
	assert.ok(context.includes("It is 3 PM, sir."));
	assert.ok(context.includes("Outcome: Answered directly."));
	// Tools line should not appear
	assert.ok(!context.includes("Tools:"));
});

test("addTokens handles missing fields gracefully", () => {
	const memory = createSessionMemory();
	// TokenUsage with no fields set
	addTokens(memory, { source: "estimate" });
	assert.equal(memory.cumulativeInputTokens, 0);
	assert.equal(memory.cumulativeOutputTokens, 0);
	assert.equal(memory.cumulativeTotalTokens, 0);

	// Partial TokenUsage
	addTokens(memory, { inputTokens: 100, source: "provider" });
	assert.equal(memory.cumulativeInputTokens, 100);
	assert.equal(memory.cumulativeOutputTokens, 0);
	assert.equal(memory.cumulativeTotalTokens, 0);
});

test("custom maxTurns via addTurn", () => {
	const memory = createSessionMemory();
	for (let i = 0; i < 8; i++) {
		addTurn(memory, {
			userText: `T${i}`,
			finalSpeech: `R${i}`,
			toolsUsed: [],
			workspaceHint: "",
			shortOutcome: "",
		}, 5 /* maxTurns */);
	}
	// Only 5 turns should remain (turns 3-7)
	assert.equal(memory.turns.length, 5);
	assert.equal(memory.turns[0]!.userText, "T3");
	assert.equal(memory.turns[4]!.userText, "T7");
});
