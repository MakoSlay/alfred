import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { runToolLoop, type BashExecutor } from "../src/alfred-2/tool-loop.ts";
import { PendingConfirmationStore } from "../src/alfred-2/confirmation.ts";
import type { AlfredToolCall } from "../src/alfred-2/tool-types.ts";

const CONTEXT = `WORKSPACES (1):
  Main [current] | ref:workspace:1 | TMPDIR | branch: main (clean)

NOTIFICATIONS: none`;

// ── Helpers ──

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `alfred-itest-${prefix}-`));
}

function noopBash(): BashExecutor {
	return async () => ({ ok: false, stdout: "", stderr: "should not execute", exitCode: 1 });
}

function fakeBash(output: string): BashExecutor {
	return async (cmd) => ({ ok: true, stdout: output, stderr: "", exitCode: 0 });
}

function failingBash(stderr: string): BashExecutor {
	return async (cmd) => ({ ok: false, stdout: "", stderr, exitCode: 1 });
}

// ── a. web search → final speech ──

test("a. web search → final speech", async () => {
	const originalFetch = globalThis.fetch as typeof fetch;
	const originalExaKey = process.env["EXA_API_KEY"];
	process.env["EXA_API_KEY"] = "fake-exa-key";

	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "https://api.exa.ai/search") {
				return new Response(
					JSON.stringify({
						results: [
							{
								title: "Alfred the Butler",
								url: "https://en.wikipedia.org/wiki/Alfred_Pennyworth",
								text: "Alfred Pennyworth is a fictional character appearing in American comic books published by DC Comics, most commonly in association with the superhero Batman.",
								publishedDate: "2024-01-01",
							},
							{
								title: "Alfred Workflow",
								url: "https://alfredapp.com/",
								text: "Alfred is a productivity application for macOS, which boosts your efficiency with hotkeys, keywords and text expansion.",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"web_search","query":"Alfred the butler","numResults":2}',
				'{"speech":"Found results about Alfred, sir.","displayText":"Two results: Alfred Pennyworth and Alfred App."}',
			]),
			userText: "search for Alfred the butler",
			systemContext: CONTEXT.replace("TMPDIR", tmpDir("websearch")),
			requestId: "req-websearch",
			sessionId: "sess-websearch",
			cwdOverride: tmpDir("websearch"),
			executeBash: noopBash(),
		});

		assert.equal(result.speech, "Found results about Alfred, sir.");
		assert.equal(result.executed, true);
		assert.equal(result.toolResults.length, 1);
		assert.equal(result.toolResults[0]!.tool, "web_search");
		assert.equal(result.toolResults[0]!.success, true);
		assert.match(result.toolResults[0]!.text, /Alfred Pennyworth/);
		assert.match(result.toolResults[0]!.text, /Alfred Workflow/);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalExaKey === undefined) {
			delete process.env["EXA_API_KEY"];
		} else {
			process.env["EXA_API_KEY"] = originalExaKey;
		}
	}
});

// ── b. read file → edit file → run test ──

test("b. confirmed edit resumes the original task and runs its remaining check", async () => {
	const dir = tmpDir("readedit");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	const scratchPath = join(dir, "scratch.ts");
	const originalContent = 'export const x = 1;\nexport const y = 2;\n';
	writeFileSync(scratchPath, originalContent, "utf8");

	const ctxWithDir = CONTEXT.replace("TMPDIR", dir);
	const store = new PendingConfirmationStore<AlfredToolCall>();
	let bashCalls: string[] = [];

	// Phase 1: read_file executes, then edit_file triggers confirmation
	const phase1 = await runToolLoop({
		llmClient: createFakeLlmClient([
			`{"tool":"read_file","path":"${scratchPath}"}`,
			`{"tool":"edit_file","path":"${scratchPath}","oldText":"x = 1","newText":"x = 42"}`,
		]),
		userText: "read scratch.ts, change x to 42, then run tsc",
		systemContext: ctxWithDir,
		requestId: "req-readedit",
		sessionId: "sess-readedit",
		cwdOverride: dir,
		confirmationStore: store,
		executeBash: noopBash(),
	});

	// read_file should have executed
	assert.equal(phase1.toolResults.length, 1);
	assert.equal(phase1.toolResults[0]!.tool, "read_file");
	assert.equal(phase1.toolResults[0]!.success, true);
	assert.match(phase1.toolResults[0]!.text, /x = 1/);

	// edit_file should require confirmation
	assert.equal(phase1.requiresConfirmation, true);
	assert.ok(phase1.confirmationId, "should have a confirmationId");
	const confId = phase1.confirmationId!;

	// Phase 2: execute the exact edit, then continue from the stored original
	// request and prior read result—not from the terse approval utterance.
	const phase2 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"echo typecheck ok"}',
			'{"speech":"File edited and typecheck passes, sir."}',
		]),
		userText: "yes",
		systemContext: ctxWithDir,
		requestId: "req-readedit-confirm",
		sessionId: "sess-readedit",
		confirm: true,
		confirmationId: confId,
		cwdOverride: dir,
		confirmationStore: store,
		executeBash: async (command) => {
			bashCalls.push(command);
			return { ok: true, stdout: "no errors", stderr: "", exitCode: 0 };
		},
	});

	// Final result checks
	assert.equal(phase2.speech, "File edited and typecheck passes, sir.");
	assert.equal(phase2.deterministicCompletion, undefined);
	assert.equal(phase2.toolResults.length, 2);

	const editResult = phase2.toolResults[0]!;
	assert.equal(editResult.tool, "edit_file");
	assert.equal(editResult.success, true);
	assert.equal(phase2.toolResults[1]?.tool, "bash");
	assert.equal(phase2.toolResults[1]?.success, true);

	// Verify the file was actually edited on disk
	const updatedContent = readFileSync(scratchPath, "utf8");
	assert.match(updatedContent, /x = 42/);
	assert.doesNotMatch(updatedContent, /\bx = 1\b/);
	assert.match(updatedContent, /y = 2/);

	assert.deepEqual(bashCalls, ["echo typecheck ok"]);

	// Confirmation should be consumed
	assert.equal(store.get(confId), null);

	rmSync(dir, { recursive: true, force: true });
});

// ── c. CI status → failed log ──

test("c. CI status → failed log", async () => {
	const dir = tmpDir("ci");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	// Init a git repo
	execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	writeFileSync(join(dir, "dummy.txt"), "test", "utf8");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

	// Create a fake gh executable that returns PR info, checks, and logs
	const fakeBinDir = join(dir, "fake-bin");
	mkdirSync(fakeBinDir, { recursive: true });

	const ghScript = join(fakeBinDir, "gh");
	writeFileSync(
		ghScript,
		`#!/usr/bin/env bash
case "$*" in
  *"auth status"*)
    exit 0
    ;;
  *"pr view"*)
    echo '{"number":42,"title":"Fix login bug","state":"OPEN","url":"https://github.com/test/repo/pull/42","headRefName":"fix-login","baseRefName":"main"}'
    exit 0
    ;;
  *"pr checks"*)
    echo '[{"name":"lint","conclusion":"success","status":"completed","startedAt":"2026-06-01T10:00:00Z","completedAt":"2026-06-01T10:01:00Z","detailsUrl":"https://github.com/test/repo/runs/1"},{"name":"test","conclusion":"failure","status":"completed","startedAt":"2026-06-01T10:01:00Z","completedAt":"2026-06-01T10:03:00Z","detailsUrl":"https://github.com/test/repo/runs/2"},{"name":"build","conclusion":"success","status":"completed","startedAt":"2026-06-01T10:03:00Z","completedAt":"2026-06-01T10:04:00Z","detailsUrl":"https://github.com/test/repo/runs/3"}]'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac`,
		{ encoding: "utf8", mode: 0o755 },
	);

	const ctxWithDir = CONTEXT.replace("TMPDIR", dir);
	const originalPath = process.env["PATH"] ?? "";
	process.env["PATH"] = `${fakeBinDir}:${originalPath}`;

	try {
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"bash","command":"local-ci status"}',
				'{"speech":"CI shows 2 passed, 1 failed, sir."}',
			]),
			userText: "check CI",
			systemContext: ctxWithDir,
			requestId: "req-ci",
			sessionId: "sess-ci",
			cwdOverride: dir,
			executeBash: fakeBash("PR #42 Fix login bug: 2 passed, 1 failed"),
		});

		assert.equal(result.speech, "CI shows 2 passed, 1 failed, sir.");
		assert.equal(result.toolResults.length, 1);

		const ciResult = result.toolResults[0]!;
		assert.equal(ciResult.tool, "bash");
		assert.equal(ciResult.success, true);
		assert.match(ciResult.text, /PR #42/);
		assert.match(ciResult.text, /2 passed/);
		assert.match(ciResult.text, /1 failed/);
	} finally {
		process.env["PATH"] = originalPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── d. failed command → retry → final speech ──

test("d. failed command → retry → final speech", async () => {
	const dir = tmpDir("retry");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	const ctxWithDir = CONTEXT.replace("TMPDIR", dir);
	const bashCalls: string[] = [];

	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"curl -s https://nonexistent.example.com/api"}',
			'{"tool":"bash","command":"curl -s --retry 3 https://real.example.com/api"}',
			'{"speech":"First attempt failed but the retry succeeded, sir."}',
		]),
		userText: "fetch data from the API",
		systemContext: ctxWithDir,
		requestId: "req-retry",
		sessionId: "sess-retry",
		cwdOverride: dir,
		executeBash: async (command) => {
			bashCalls.push(command);
			if (bashCalls.length === 1) {
				// First call: fail with retryable
				return { ok: false, stdout: "", stderr: "curl: (6) Could not resolve host", exitCode: 6 };
			}
			// Second call: succeed
			return { ok: true, stdout: '{"status":"ok"}', stderr: "", exitCode: 0 };
		},
	});

	assert.equal(result.speech, "First attempt failed but the retry succeeded, sir.");
	assert.equal(result.toolResults.length, 2);

	// First bash result: failed, retryable
	const firstResult = result.toolResults[0]!;
	assert.equal(firstResult.tool, "bash");
	assert.equal(firstResult.success, false);
	assert.equal(firstResult.retryable, true);

	// Second bash result: success
	const secondResult = result.toolResults[1]!;
	assert.equal(secondResult.tool, "bash");
	assert.equal(secondResult.success, true);

	// Verify exact commands executed
	assert.equal(bashCalls.length, 2);
	assert.match(bashCalls[0]!, /nonexistent/);
	assert.match(bashCalls[1]!, /real\.example\.com/);

	rmSync(dir, { recursive: true, force: true });
});

// ── e. dangerous command → confirmation → exact payload execution ──

test("e. dangerous command → confirmation → exact payload execution", async () => {
	const dir = tmpDir("danger");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	const ctxWithDir = CONTEXT.replace("TMPDIR", dir);
	const store = new PendingConfirmationStore<AlfredToolCall>();
	let actualCommand = "";

	// Phase 1: should trigger confirmation (rm command is destructive)
	const phase1 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"rm -rf ./build-cache"}',
		]),
		userText: "clean the build cache",
		systemContext: ctxWithDir,
		requestId: "req-danger",
		sessionId: "sess-danger",
		cwdOverride: dir,
		confirmationStore: store,
		executeBash: async (command) => {
			actualCommand = command;
			return { ok: true, stdout: "removed", stderr: "", exitCode: 0 };
		},
	});

	// Should require confirmation, not execute
	assert.equal(phase1.requiresConfirmation, true);
	assert.ok(phase1.confirmationId, "should have a confirmationId");
	assert.match(phase1.confirmationPrompt ?? "", /high risk action|run the proposed command/);
	assert.match(phase1.displayText, /rm -rf/);
	assert.equal(actualCommand, "", "command should not have executed yet");

	// Verify the stored confirmation contains exact payload
	const confId = phase1.confirmationId!;
	const pending = store.get(confId);
	assert.ok(pending, "confirmation should be stored");
	assert.equal(pending!.tool, "bash");
	assert.match((pending!.payload as any).command, /rm -rf/);

	// Phase 2: confirm with the same store. The stored command executes, then
	// the original task context is restored for final reporting.
	const phase2 = await runToolLoop({
		llmClient: createFakeLlmClient(['{"speech":"Build cache cleaned, sir."}']),
		userText: "yes",
		systemContext: ctxWithDir,
		requestId: "req-danger-confirm",
		sessionId: "sess-danger",
		confirm: true,
		confirmationId: confId,
		cwdOverride: dir,
		confirmationStore: store,
		executeBash: async (command) => {
			actualCommand = command;
			return { ok: true, stdout: "removed", stderr: "", exitCode: 0 };
		},
	});

	// Should have executed the STORED command (rm -rf ./build-cache),
	// not a regenerated or different command
	assert.equal(phase2.executed, true);
	assert.equal(phase2.speech, "Build cache cleaned, sir.");
	assert.equal(phase2.deterministicCompletion, undefined);
	assert.match(actualCommand, /rm -rf.*build-cache/);
	assert.doesNotMatch(actualCommand, /evil-hacked/);

	// Confirmation should be consumed
	assert.equal(store.get(confId), null);

	rmSync(dir, { recursive: true, force: true });
});

// ── f. 100k handoff → continuation ──

test("f. current-context handoff → continuation", async () => {
	const dir = tmpDir("handoff");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	const ctxWithDir = CONTEXT.replace("TMPDIR", dir);

	// Phase 1: LLM call pushes tokens over handoff threshold.
	// The handoff is triggered AFTER the LLM call but BEFORE tool execution,
	// so no commands are recorded in the handoff.
	const phase1 = await runToolLoop({
		llmClient: createFakeLlmClient([]),
		userText: "long running task that will hit handoff",
		systemContext: ctxWithDir,
		requestId: "req-handoff-1",
		sessionId: "sess-handoff",
		cwdOverride: dir,
		initialSessionTokens: 99,
		sessionHandoffTokens: 10,
		now: () => new Date("2026-06-30T12:00:00.000Z"),
		executeBash: async () => {
			throw new Error("should not execute after handoff threshold");
		},
	});

	// Verify handoff was triggered
	assert.match(phase1.speech, /context limit/);
	assert.ok(phase1.handoffPath, "handoff path should be set");
	assert.equal(existsSync(phase1.handoffPath!), true);

	// Verify handoff file contains session info
	const handoffContent = readFileSync(phase1.handoffPath!, "utf8");
	assert.match(handoffContent, /Alfred Session Handoff/);
	assert.match(handoffContent, /long running task that will hit handoff/);
	assert.match(handoffContent, /Token Accounting/);
	assert.match(handoffContent, /Current context tokens:/);
	assert.match(handoffContent, /Cumulative total tokens: 99/);

	// Phase 2: Simulate a fresh session loading from handoff context.
	// The fresh session reads the handoff and continues the task.
	const phase2 = await runToolLoop({
		llmClient: createFakeLlmClient([
			{
				text: '{"tool":"bash","command":"echo done"}',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
			},
			'{"speech":"All done, sir."}',
		]),
		userText: `Continue from handoff. Previous state:\n${handoffContent.slice(0, 500)}`,
		systemContext: ctxWithDir,
		requestId: "req-handoff-2",
		sessionId: "sess-handoff-fresh",
		cwdOverride: dir,
		executeBash: async () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0 }),
	});

	// Fresh session completes normally
	assert.equal(phase2.speech, "All done, sir.");
	assert.equal(phase2.toolResults.length, 1);
	assert.equal(phase2.toolResults[0]!.success, true);

	// Cleanup
	rmSync(phase1.handoffPath!, { force: true });
	rmSync(dir, { recursive: true, force: true });
});

// ── Edge case: empty tool results → final speech ──

test("no tools needed → direct final speech", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"speech":"I am Alfred at your service, sir.","displayText":"Greeting"}',
		]),
		userText: "hello",
		systemContext: CONTEXT.replace("TMPDIR", tmpDir("direct")),
		requestId: "req-direct",
		sessionId: "sess-direct",
		cwdOverride: tmpDir("direct"),
		executeBash: noopBash(),
	});

	assert.equal(result.speech, "I am Alfred at your service, sir.");
	assert.equal(result.toolResults.length, 0);
	assert.equal(result.executed, false);
	assert.equal(result.requiresConfirmation, false);
});
