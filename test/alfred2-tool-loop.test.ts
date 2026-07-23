import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { AUTONOMOUS_SYSTEM_PROMPT, createWorkingAcknowledgement, isMacOpenCommand, resolveWorkspaceForRequest, runToolLoop, type BashExecutor, type ToolLoopEvent } from "../src/alfred-2/tool-loop.ts";
import { GoalJobStore } from "../src/alfred-2/goals.ts";
import { PendingConfirmationStore } from "../src/alfred-2/confirmation.ts";

const CONTEXT = `WORKSPACES (2):
  Main [current] | ref:workspace:1 | /tmp/main | branch: main (clean)
  Sandbox | ref:workspace:2 | /tmp/sandbox | branch: feature (DIRTY)

NOTIFICATIONS: none`;

test("tool loop prompt tells the model speech is a TTS script", () => {
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /speech field is sent directly to text-to-speech/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /put that in displayText/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /Do not put Markdown/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /discovery\/inspection alone is not completion/);
	assert.doesNotMatch(AUTONOMOUS_SYSTEM_PROMPT, /Do not wait for the user to tell you to remember/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /Do not store one-off task details or guesses/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /prefer save_note/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /separate verified facts from assumptions/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /show\/check arithmetic/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /scope "host" for machine-wide inspection/);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /local apps or system resource usage/);
});

test("working acknowledgements are contextual instead of always generic", () => {
	assert.equal(
		createWorkingAcknowledgement("any new sessions or work I should address before I log off", { tool: "refresh_context", forceFresh: true }),
		"Looking into that for you, sir.",
	);
	assert.equal(createWorkingAcknowledgement("what is on my calendar today", { tool: "calendar_today" }), "Checking your calendar, sir.");
	assert.equal(createWorkingAcknowledgement("search gmail for recent notes", { tool: "gmail_search", query: "newer_than:1d" }), "Checking your mail, sir.");
	assert.equal(createWorkingAcknowledgement("run tests", { tool: "bash", command: "npm test" }), "Running that check now, sir.");
});

test("tool loop runs one bash tool call then final speech", async () => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const liveEvents: ToolLoopEvent[] = [];
	const executeBash: BashExecutor = async (command, options) => {
		calls.push({ command, cwd: options.cwd });
		return { ok: true, stdout: "hello", stderr: "", exitCode: 0 };
	};
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"echo hello"}',
			'{"speech":"It printed hello, sir."}',
		]),
		userText: "say hello",
		systemContext: CONTEXT,
		requestId: "req-one",
		sessionId: "sess-one",
		executeBash,
		onEvent: (event) => liveEvents.push(event),
	});
	assert.equal(result.speech, "It printed hello, sir.");
	assert.equal(result.executed, true);
	assert.equal(result.toolRounds, 1);
	assert.deepEqual(calls, [{ command: "echo hello", cwd: "/tmp/main" }]);
	assert.deepEqual(liveEvents.map((event) => [event.type, event.tool, event.ok]), [
		["tool_call", "bash", undefined],
		["tool_result", "bash", true],
	]);
});

test("tool loop runs two sequential bash tool calls then final speech", async () => {
	const calls: string[] = [];
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"pwd"}',
			'{"tool":"bash","command":"echo done"}',
			'{"speech":"Both checks are done, sir."}',
		]),
		userText: "check twice",
		systemContext: CONTEXT,
		requestId: "req-two",
		sessionId: "sess-two",
		executeBash: async (command) => {
			calls.push(command);
			return { ok: true, stdout: command, stderr: "", exitCode: 0 };
		},
	});
	assert.equal(result.speech, "Both checks are done, sir.");
	assert.deepEqual(calls, ["pwd", "echo done"]);
	assert.equal(result.toolRounds, 2);
});

test("tool loop stops safely when max tool rounds is reached", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"echo one"}',
			'{"tool":"bash","command":"echo two"}',
		]),
		userText: "loop",
		systemContext: CONTEXT,
		requestId: "req-max",
		sessionId: "sess-max",
		maxToolRounds: 1,
		executeBash: async () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0 }),
	});
	assert.match(result.speech, /tool limit/);
	assert.equal(result.toolRounds, 1);
});

test("legacy speech plus command JSON still executes as bash", async () => {
	let ran = false;
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"speech":"Right away, sir.","command":"echo legacy"}',
			'{"speech":"Legacy command finished, sir."}',
		]),
		userText: "legacy",
		systemContext: CONTEXT,
		requestId: "req-legacy",
		sessionId: "sess-legacy",
		executeBash: async () => {
			ran = true;
			return { ok: true, stdout: "legacy", stderr: "", exitCode: 0 };
		},
	});
	assert.equal(ran, true);
	assert.equal(result.command, "echo legacy");
	assert.equal(result.speech, "Legacy command finished, sir.");
});

test("execute-time bash guard blocks multiline, heredoc, and here-string legacy commands", async () => {
	for (const command of ["printf one\nprintf two", "cat <<EOF > note.txt", "cat <<< value"]) {
		let ran = false;
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				JSON.stringify({ speech: "Working, sir.", command }),
				'{"speech":"The unsafe shell shape was blocked, sir."}',
			]),
			userText: "write a note",
			systemContext: CONTEXT,
			requestId: "req-legacy-shape",
			sessionId: "sess-legacy-shape",
			executeBash: async () => { ran = true; return { ok: true, stdout: "", stderr: "", exitCode: 0 }; },
		});
		assert.equal(ran, false);
		assert.match(result.displayText, /single line|heredoc/i);
	}
});

test("confirmation preserves an originally absent cwd instead of adopting approval-turn context", async () => {
	const confirmationStore = new PendingConfirmationStore();
	let ran = false;
	const pending = await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"mkdir approved-dir"}']),
		userText: "make a directory",
		systemContext: "No cmux workspace is available.",
		requestId: "req-no-cwd-1",
		sessionId: "sess-no-cwd",
		confirmationStore,
		executeBash: async () => { ran = true; return { ok: true, stdout: "", stderr: "", exitCode: 0 }; },
	});
	assert.equal(pending.requiresConfirmation, true);
	assert.doesNotMatch(pending.displayText, /Cwd:/);
	const completed = await runToolLoop({
		llmClient: { complete: async () => { throw new Error("planner must not run after confirmation"); } },
		userText: "yes",
		systemContext: CONTEXT,
		requestId: "req-no-cwd-2",
		sessionId: "sess-no-cwd",
		confirmationStore,
		confirm: true,
		confirmationId: pending.confirmationId,
		executeBash: async () => { ran = true; return { ok: true, stdout: "", stderr: "", exitCode: 0 }; },
	});
	assert.equal(ran, false);
	assert.match(completed.displayText, /No safe cmux workspace cwd/);
});

test("confirmation continuation preserves the original request tail and workspace for follow-on steps", async () => {
	const confirmationStore = new PendingConfirmationStore();
	const originalContext = `WORKSPACES (1):\n  Original [current] | ref:workspace:original | /tmp/original | branch: main (clean)\n\n${"state ".repeat(6_000)}`;
	const driftedContext = `WORKSPACES (1):\n  Drifted [current] | ref:workspace:drifted | /tmp/drifted | branch: main (clean)`;
	const marker = "ORIGINAL REQUEST MARKER: create the directory and then verify it";
	const pending = await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"mkdir approved-dir"}']),
		userText: marker,
		systemContext: originalContext,
		requestId: "req-continuation-1",
		sessionId: "sess-continuation",
		confirmationStore,
	});
	const calls: Array<{ command: string; cwd: string }> = [];
	let plannerCalls = 0;
	const completed = await runToolLoop({
		llmClient: { complete: async (request) => {
			plannerCalls++;
			if (plannerCalls === 1) {
				assert.match(request.messages.map((message) => message.content).join("\n"), new RegExp(marker));
				assert.match(request.messages.map((message) => message.content).join("\n"), /APPROVED TASK CONTINUATION/);
				return { text: '{"tool":"bash","command":"echo verified"}' };
			}
			return { text: '{"speech":"The directory was created and verified, sir."}' };
		} },
		userText: "yes",
		systemContext: driftedContext,
		requestId: "req-continuation-2",
		sessionId: "sess-continuation",
		confirmationStore,
		confirm: true,
		confirmationId: pending.confirmationId,
		executeBash: async (command, options) => {
			calls.push({ command, cwd: options.cwd });
			return { ok: true, stdout: "ok", stderr: "", exitCode: 0 };
		},
	});
	assert.equal(completed.speech, "The directory was created and verified, sir.");
	assert.deepEqual(calls, [
		{ command: "mkdir approved-dir", cwd: "/tmp/original" },
		{ command: "echo verified", cwd: "/tmp/original" },
	]);
});

test("unknown tool triggers one parser retry then graceful failure", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"teleport","target":"moon"}',
			'{"tool":"teleport","target":"moon"}',
		]),
		userText: "teleport",
		systemContext: CONTEXT,
		requestId: "req-parser",
		sessionId: "sess-parser",
	});
	assert.match(result.speech, /couldn't parse/);
	assert.equal(result.parserRetries, 1);
	assert.equal(result.executed, false);
});

test("bash runs in current cmux workspace cwd by default", async () => {
	let cwd = "";
	await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"pwd"}', '{"speech":"Done, sir."}']),
		userText: "pwd",
		systemContext: CONTEXT,
		requestId: "req-cwd",
		sessionId: "sess-cwd",
		executeBash: async (_command, options) => {
			cwd = options.cwd;
			return { ok: true, stdout: options.cwd, stderr: "", exitCode: 0 };
		},
	});
	assert.equal(cwd, "/tmp/main");
});

test("bash never falls back to Alfred repo when cmux cwd is unavailable", async () => {
	let ran = false;
	const result = await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"pwd"}', '{"speech":"I need a workspace, sir."}']),
		userText: "pwd",
		systemContext: "WORKSPACES: (cmux unavailable)",
		requestId: "req-nocwd",
		sessionId: "sess-nocwd",
		executeBash: async () => {
			ran = true;
			return { ok: true, stdout: process.cwd(), stderr: "", exitCode: 0 };
		},
	});
	assert.equal(ran, false);
	assert.equal(result.toolResults[0]?.success, false);
	assert.match(result.toolResults[0]?.text ?? "", /will not fall back/);
});

test("host-scoped bash inspects macOS without cmux and runs from a neutral cwd", async () => {
	const command = "osascript -e 'tell application \"System Events\" to get name of every visible process'";
	const calls: Array<{ command: string; cwd: string }> = [];
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			JSON.stringify({ tool: "bash", command, scope: "host" }),
			'{"speech":"You have several visible apps, sir."}',
		]),
		userText: "how many apps do I have open?",
		systemContext: "WORKSPACES: (cmux unavailable)",
		requestId: "req-host-apps",
		sessionId: "sess-host-apps",
		executeBash: async (actualCommand, options) => {
			calls.push({ command: actualCommand, cwd: options.cwd });
			return { ok: true, stdout: "Finder, Calendar, Messages", stderr: "", exitCode: 0 };
		},
	});
	assert.deepEqual(calls, [{ command, cwd: tmpdir() }]);
	assert.equal(result.executed, true);
	assert.equal(result.toolResults[0]?.success, true);
	assert.equal(result.toolResults[0]?.workspaceRef, undefined);
	assert.equal(result.toolResults[0]?.cwd, tmpdir());
});

test("tool loop rejects host scope combined with a cwd", async () => {
	let ran = false;
	const invalid = JSON.stringify({ tool: "bash", command: "pwd", scope: "host", cwd: "/tmp/project" });
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([invalid, invalid]),
		userText: "inspect the host",
		systemContext: "WORKSPACES: (cmux unavailable)",
		requestId: "req-host-invalid",
		sessionId: "sess-host-invalid",
		executeBash: async () => {
			ran = true;
			return { ok: true, stdout: "", stderr: "", exitCode: 0 };
		},
	});
	assert.equal(ran, false);
	assert.equal(result.parserRetries, 1);
	assert.equal(result.outcome.terminalFailure?.code, "parser.invalid_tool_arguments");
});

test("fuzzy workspace correction resolves Maine to Main when unambiguous", async () => {
	let cwd = "";
	const result = await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"pwd"}', '{"speech":"Done in Main, sir."}']),
		userText: "run pwd in Maine",
		systemContext: `WORKSPACES (2):\n  Sandbox [current] | ref:workspace:2 | /tmp/sandbox\n  Main | ref:workspace:1 | /tmp/main`,
		requestId: "req-fuzzy",
		sessionId: "sess-fuzzy",
		executeBash: async (_command, options) => {
			cwd = options.cwd;
			return { ok: true, stdout: options.cwd, stderr: "", exitCode: 0 };
		},
	});
	assert.equal(cwd, "/tmp/main");
	assert.equal(result.workspace?.name, "Main");
});

test("ambiguous fuzzy workspace mentions ask instead of executing", async () => {
	let ran = false;
	const result = await runToolLoop({
		llmClient: createFakeLlmClient(['{"tool":"bash","command":"pwd"}']),
		userText: "run pwd in Maine",
		systemContext: `WORKSPACES (2):\n  Sandbox [current] | ref:workspace:2 | /tmp/sandbox\n  Main | ref:workspace:1 | /tmp/main\n  Maine | ref:workspace:3 | /tmp/maine`,
		requestId: "req-ambig",
		sessionId: "sess-ambig",
		executeBash: async () => {
			ran = true;
			return { ok: true, stdout: "", stderr: "", exitCode: 0 };
		},
	});
	assert.equal(ran, false);
	assert.match(result.speech, /Which workspace/);
});

test("open requests cannot be finalized until a successful macOS open command runs", async () => {
	const calls: string[] = [];
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"bash","command":"ls -la /tmp/main"}',
			'{"speech":"The folder is open and ready, sir."}',
			'{"tool":"bash","command":"open \\"/tmp/main\\""}',
			'{"speech":"The folder is open now, sir."}',
		]),
		userText: "open the /tmp/main folder",
		systemContext: CONTEXT,
		requestId: "req-open-guard",
		sessionId: "sess-open-guard",
		executeBash: async (command) => {
			calls.push(command);
			return { ok: true, stdout: "ok", stderr: "", exitCode: 0 };
		},
	});
	assert.deepEqual(calls, ["ls -la /tmp/main", "open \"/tmp/main\""]);
	assert.equal(result.speech, "The folder is open now, sir.");
	assert.equal(result.command, "open \"/tmp/main\"");
	assert.equal(result.toolRounds, 2);
	assert.equal(result.events.some((event) => event.message.includes("Action completion check")), true);
});

test("completion guard prevents false opened claims if correction is exhausted", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"speech":"Of course, sir. The folder is open."}',
			'{"speech":"It is open, sir."}',
		]),
		userText: "open the /tmp/main folder",
		systemContext: CONTEXT,
		requestId: "req-open-false-claim",
		sessionId: "sess-open-false-claim",
		executeBash: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
	});
	assert.match(result.speech, /not opened it yet/);
	assert.equal(result.executed, false);
});

test("macOS open command detection handles direct and chained commands", () => {
	assert.equal(isMacOpenCommand("open \"/tmp/main\""), true);
	assert.equal(isMacOpenCommand("test -d /tmp/main && open /tmp/main"), true);
	assert.equal(isMacOpenCommand("ls -la /tmp/main"), false);
});

test("multi-turn tool loop reports cumulative and current-context usage separately", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			{ text: '{"tool":"bash","command":"echo one"}', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" } },
			{ text: '{"speech":"Done, sir."}', usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27, source: "provider" } },
		]),
		userText: "usage",
		systemContext: CONTEXT,
		requestId: "req-usage",
		sessionId: "sess-usage",
		executeBash: async () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0 }),
	});
	assert.equal(result.usage.totalTokens, 42);
	assert.equal(result.sessionTokens, 42);
	assert.ok(result.currentContextTokens > 0);
	assert.ok(result.maxContextTokens >= result.currentContextTokens);
});

test("natural-language goal requests can be fulfilled through the goal tool", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-tool-goals-"));
	try {
		const goalJobStore = new GoalJobStore({ path: join(directory, "goals.json"), idFactory: () => "natural" });
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"create_goal","title":"Keep proactive advice useful","notes":"Prefer natural language over command phrases"}',
				'{"speech":"I have saved that goal, sir."}',
			]),
			userText: "I want you to keep your proactive advice useful, could you remember that as something we're aiming for?",
			systemContext: CONTEXT,
			requestId: "req-natural-goal",
			sessionId: "sess-natural-goal",
			goalJobStore,
		});
		assert.equal(result.outcome.status, "completed");
		assert.equal(result.toolResults[0]?.tool, "create_goal");
		assert.equal(goalJobStore.listGoals()[0]?.title, "Keep proactive advice useful");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("schedule_job selected from natural language is confirmation gated", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-tool-schedule-"));
	try {
		const goalJobStore = new GoalJobStore({ path: join(directory, "goals.json") });
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"schedule_job","kind":"reminder","title":"Check the pull request","runAt":"2026-07-16T15:00:00.000Z"}',
			]),
			userText: "Give me a nudge at three this afternoon to check the pull request.",
			systemContext: CONTEXT,
			requestId: "req-natural-reminder",
			sessionId: "sess-natural-reminder",
			goalJobStore,
			autoConfirm: true,
		});
		assert.equal(result.requiresConfirmation, true);
		assert.match(result.confirmationPrompt ?? "", /schedule that reminder/i);
		assert.equal(goalJobStore.listJobs().length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("one confirmation authorizes only the stored schedule payload", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-tool-schedule-once-"));
	try {
		const goalJobStore = new GoalJobStore({ path: join(directory, "goals.json") });
		const confirmationStore = new PendingConfirmationStore();
		const pending = await runToolLoop({
			llmClient: createFakeLlmClient(['{"tool":"schedule_job","kind":"reminder","title":"Approved","runAt":"2026-07-16T15:00:00Z"}']),
			userText: "Schedule approved",
			systemContext: CONTEXT,
			requestId: "req-schedule-once-1",
			sessionId: "sess-schedule-once",
			goalJobStore,
			confirmationStore,
		});
		assert.equal(pending.requiresConfirmation, true);

		const followOn = await runToolLoop({
			llmClient: { complete: async () => { throw new Error("approval must not be replanned"); } },
			userText: "Approve only the pending reminder",
			systemContext: CONTEXT,
			requestId: "req-schedule-once-2",
			sessionId: "sess-schedule-once",
			goalJobStore,
			confirmationStore,
			confirm: true,
			confirmationId: pending.confirmationId,
		});
		assert.deepEqual(goalJobStore.listJobs().map((job) => job.title), ["Approved"]);
		assert.equal(followOn.requiresConfirmation, false);
		assert.equal(followOn.deterministicCompletion, true);
		assert.match(followOn.displayText, /Scheduled job/);
		assert.equal(confirmationStore.count(), 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("completion guard corrects a false natural-language reminder claim into a schedule tool", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-tool-schedule-guard-"));
	try {
		const goalJobStore = new GoalJobStore({ path: join(directory, "goals.json") });
		const result = await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"speech":"I will remind you at three, sir."}',
				'{"tool":"schedule_job","kind":"reminder","title":"Check the implementation","runAt":"2026-07-16T15:00:00.000Z"}',
			]),
			userText: "Later this afternoon at three, give me a nudge to check this implementation.",
			systemContext: CONTEXT,
			requestId: "req-natural-reminder-guard",
			sessionId: "sess-natural-reminder-guard",
			goalJobStore,
		});
		assert.equal(result.requiresConfirmation, true);
		assert.equal(result.parserRetries, 0);
		assert.equal(goalJobStore.listJobs().length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("crossing current-context threshold writes handoff before another LLM call", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([]),
		userText: "handoff",
		systemContext: CONTEXT,
		requestId: "req-handoff",
		sessionId: "sess-handoff",
		initialSessionTokens: 99,
		sessionHandoffTokens: 10,
		now: () => new Date("2026-06-29T18:42:00.000Z"),
		executeBash: async () => {
			throw new Error("should not execute after handoff threshold");
		},
	});
	assert.match(result.speech, /context limit/);
	assert.equal(result.sessionTokens, 99);
	assert.ok(result.currentContextTokens >= 10);
	assert.ok(result.handoffPath);
	assert.equal(existsSync(result.handoffPath!), true);
	rmSync(result.handoffPath!, { force: true });
});

test("workspace resolver reports ambiguous spoken names", () => {
	const resolved = resolveWorkspaceForRequest("use Maine", `WORKSPACES (2):\n  Main [current] | ref:workspace:1 | /tmp/main\n  Maine | ref:workspace:3 | /tmp/maine`);
	assert.equal(resolved.ambiguous, true);
});
