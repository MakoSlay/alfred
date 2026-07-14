import test from "node:test";
import assert from "node:assert/strict";

import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { PendingConfirmationStore } from "../src/alfred-2/confirmation.ts";
import { inspectSession, type SessionExecFn } from "../src/alfred-2/tools/session.ts";
import { sendSessionMessage } from "../src/alfred-2/tools/session-message.ts";
import { AUTONOMOUS_SYSTEM_PROMPT, runToolLoop } from "../src/alfred-2/tool-loop.ts";
import type { AlfredToolCall } from "../src/alfred-2/tool-types.ts";

const CONTEXT = `WORKSPACES (2):
  Main [current] | ref:workspace:1 | /tmp/main | branch: main (clean)
  Collectors Survey | ref:workspace:11 | /tmp/collectors | branch: feature (clean)`;

const tree = JSON.stringify({
	windows: [
		{
			workspaces: [
				{
					panes: [
						{
							surfaces: [
								{ ref: "surface:29", title: "local ci runs", selected: false },
								{ ref: "surface:30", title: "shell", selected: true },
							],
						},
					],
				},
			],
		},
	],
});

test("inspect_session resolves workspace and tab hint, then reads cmux screen with workspace and surface refs", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const exec: SessionExecFn = async (command, args) => {
		calls.push({ command, args });
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args.join(" ") === "read-screen --workspace workspace:11 --surface surface:29 --scrollback --lines 160") {
			return { stdout: "CI ✅ all passed (9)", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceName: "collector survey", tabHint: "local CI runs", lines: 160 },
		{ requestId: "req", toolCallId: "tool", risk: "read", workspaceRef: "workspace:1" },
		{ exec, systemContext: CONTEXT },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.workspaceRef, "workspace:11");
	assert.equal(result.data?.surfaceRef, "surface:29");
	assert.match(result.text, /all passed/);
	assert.deepEqual(calls.map((call) => call.args), [
		["tree", "--workspace", "workspace:11", "--json", "--id-format", "both"],
		["read-screen", "--workspace", "workspace:11", "--surface", "surface:29", "--scrollback", "--lines", "160"],
	]);
});

test("inspect_session returns candidates without reading when tab hint is ambiguous", async () => {
	const calls: string[] = [];
	const ambiguousTree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:1", title: "local CI runs" },
		{ ref: "surface:2", title: "local CI deploy" },
	] }] }] }] });
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args.join(" "));
		return { stdout: ambiguousTree, stderr: "", exitCode: 0 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11", tabHint: "local CI" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, false);
	assert.match(result.text, /Multiple tabs matched/);
	assert.equal(result.data?.candidates?.length, 2);
	assert.equal(result.failure?.code, "resolution.ambiguous_target");
	assert.equal(calls.some((call) => call.startsWith("read-screen")), false);
});

test("inspect_session returns visible candidates when tab hint is missing", async () => {
	const exec: SessionExecFn = async (_command, args) => {
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected read", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11", tabHint: "does not exist" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, false);
	assert.match(result.text, /No tabs matched/);
	assert.equal(result.failure?.code, "resolution.target_not_found");
	assert.deepEqual(result.data?.candidates?.map((candidate) => candidate.ref), ["surface:29", "surface:30"]);
});

test("tool loop can execute inspect_session before final answer", async () => {
	let bashRan = false;
	const exec: SessionExecFn = async (_command, args) => {
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "PID disappeared; fresh run now CI ✅ all passed (9)", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"inspect_session","workspaceName":"Collectors Survey","tabHint":"local CI runs","lines":160}',
			'{"speech":"The local CI run is no longer stuck, sir.","displayText":"The prior run went stale after its test process disappeared; a fresh run now shows CI ✅ all passed (9)."}',
		]),
		userText: "in my collector survey workspace, check the local CI runs tab",
		systemContext: CONTEXT,
		requestId: "req-loop",
		sessionId: "sess-loop",
		inspectSessionExec: exec,
		executeBash: async () => {
			bashRan = true;
			return { ok: true, stdout: "", stderr: "", exitCode: 0 };
		},
	});

	assert.equal(bashRan, false);
	assert.equal(result.toolResults[0]?.tool, "inspect_session");
	assert.match(result.displayText, /all passed/);
});

test("autonomous prompt instructs session inspection before bash for running tabs", () => {
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /use inspect_session before bash/i);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /Do not infer from process names/i);
});

test("autonomous prompt distinguishes one-off session messages from background monitoring", () => {
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /send_session_message/i);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /start_session_monitor/i);
	assert.match(AUTONOMOUS_SYSTEM_PROMPT, /replyMode send only when the user explicitly asks/i);
});

test("send_session_message resolves target and drafts without Enter", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const exec: SessionExecFn = async (command, args) => {
		calls.push({ command, args });
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "send") return { stdout: "", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
	};

	const result = await sendSessionMessage(
		{ tool: "send_session_message", workspaceName: "Collectors Survey", tabHint: "local CI runs", text: "I'll take a look.", mode: "draft" },
		{ requestId: "req", toolCallId: "tool", risk: "mutation", workspaceRef: "workspace:1" },
		{ exec, systemContext: CONTEXT },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.workspaceRef, "workspace:11");
	assert.equal(result.data?.surfaceRef, "surface:29");
	assert.deepEqual(calls.at(-1)?.args, ["send", "--workspace", "workspace:11", "--surface", "surface:29", "I'll take a look."]);
});

test("send_session_message send mode appends Enter escape", async () => {
	const calls: string[][] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args);
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "send") return { stdout: "", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await sendSessionMessage(
		{ tool: "send_session_message", workspaceRef: "workspace:11", surfaceRef: "surface:30", text: "Done.", mode: "send" },
		{ requestId: "req", toolCallId: "tool", risk: "mutation" },
		{ exec },
	);

	assert.equal(result.success, true);
	assert.equal(calls.at(-1)?.at(-1), "Done.\\n");
});

test("send_session_message returns candidates without sending when tab is ambiguous", async () => {
	const ambiguousTree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:1", title: "local CI runs" },
		{ ref: "surface:2", title: "local CI deploy" },
	] }] }] }] });
	const calls: string[] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args.join(" "));
		if (args[0] === "tree") return { stdout: ambiguousTree, stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected send", exitCode: 1 };
	};

	const result = await sendSessionMessage(
		{ tool: "send_session_message", workspaceRef: "workspace:11", tabHint: "local CI", text: "Done." },
		{ requestId: "req", toolCallId: "tool", risk: "mutation" },
		{ exec },
	);

	assert.equal(result.success, false);
	assert.match(result.text, /Multiple tabs matched/);
	assert.equal(calls.some((call) => call.startsWith("send")), false);
});

test("tool loop confirmation-gates and then executes send_session_message", async () => {
	const store = new PendingConfirmationStore<AlfredToolCall>();
	const calls: string[][] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args);
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "send") return { stdout: "", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const phase1 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"send_session_message","workspaceName":"Collectors Survey","tabHint":"shell","text":"On it.","mode":"draft"}',
		]),
		userText: "draft a reply in the collectors shell tab",
		systemContext: CONTEXT,
		requestId: "req-send-phase1",
		sessionId: "sess-send",
		confirmationStore: store,
		inspectSessionExec: exec,
	});

	assert.equal(phase1.requiresConfirmation, true);
	assert.equal(calls.length, 0);
	assert.ok(phase1.confirmationId);

	const phase2 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"speech":"Drafted that message, sir."}',
		]),
		userText: "confirm",
		systemContext: CONTEXT,
		requestId: "req-send-phase2",
		sessionId: "sess-send",
		confirm: true,
		confirmationId: phase1.confirmationId,
		confirmationStore: store,
		inspectSessionExec: exec,
	});

	assert.equal(phase2.requiresConfirmation, false);
	assert.equal(phase2.toolResults[0]?.tool, "send_session_message");
	assert.deepEqual(calls.at(-1), ["send", "--workspace", "workspace:11", "--surface", "surface:30", "On it."]);
});

test("tool loop resolves natural-language confirmation intent before normal planning", async () => {
	const store = new PendingConfirmationStore<AlfredToolCall>();
	const calls: string[][] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args);
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "send") return { stdout: "", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const phase1 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"send_session_message","workspaceName":"Collectors Survey","tabHint":"shell","text":"On it.","mode":"draft"}',
		]),
		userText: "draft a reply in the collectors shell tab",
		systemContext: CONTEXT,
		requestId: "req-natural-confirm-phase1",
		sessionId: "sess-natural-confirm",
		confirmationStore: store,
		inspectSessionExec: exec,
	});

	assert.equal(phase1.requiresConfirmation, true);
	assert.ok(phase1.confirmationId);

	const phase2 = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"intent":"approve","confidence":0.94,"reason":"The user approved the pending action."}',
			'{"speech":"Drafted that message, sir."}',
		]),
		userText: "Yuss, go ahead and do that",
		systemContext: CONTEXT,
		requestId: "req-natural-confirm-phase2",
		sessionId: "sess-natural-confirm",
		confirmationStore: store,
		inspectSessionExec: exec,
	});

	assert.equal(phase2.requiresConfirmation, false);
	assert.equal(phase2.toolResults[0]?.tool, "send_session_message");
	assert.deepEqual(calls.at(-1), ["send", "--workspace", "workspace:11", "--surface", "surface:30", "On it."]);
});

test("destructive session monitor confirmation uses natural speech and readable details", async () => {
	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"start_session_monitor","workspaceName":"Main","tabHint":"Alfred origin","goal":"Ask for quick wins and iterate on implementation.","replyMode":"send","pollIntervalMs":12000,"maxTurns":10}',
		]),
		userText: "monitor my Alfred origin tab and go back and forth",
		systemContext: CONTEXT,
		requestId: "req-monitor-confirm-copy",
		sessionId: "sess-monitor-confirm-copy",
	});

	assert.equal(result.requiresConfirmation, true);
	assert.match(result.speech, /Shall I start monitoring Alfred origin and send replies autonomously, sir\?/);
	assert.doesNotMatch(result.speech, /workspace=|tab=|replyMode=|Shall I run/i);
	assert.match(result.displayText, /Workspace: Main/);
	assert.match(result.displayText, /Tab: Alfred origin/);
	assert.match(result.displayText, /Reply mode: send/);
	assert.doesNotMatch(result.displayText, /workspace=|tab=|replyMode=/);
	assert.doesNotMatch(result.displayText, /"confirm": true/);
});

test("send_session_message still requires confirmation when auto-confirm is enabled", async () => {
	const calls: string[][] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args);
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "send") return { stdout: "", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await runToolLoop({
		llmClient: createFakeLlmClient([
			'{"tool":"send_session_message","workspaceName":"Collectors Survey","tabHint":"shell","text":"On it.","mode":"draft"}',
		]),
		userText: "draft a reply in the collectors shell tab",
		systemContext: CONTEXT,
		requestId: "req-send-autoconfirm",
		sessionId: "sess-send-autoconfirm",
		autoConfirm: true,
		inspectSessionExec: exec,
	});

	assert.equal(result.requiresConfirmation, true);
	assert.equal(calls.length, 0);
});

test("workspace-only inspect_session with workspaceRef auto-picks the selected surface", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const exec: SessionExecFn = async (command, args) => {
		calls.push({ command, args });
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args.join(" ") === "read-screen --workspace workspace:11 --surface surface:30 --scrollback --lines 160") {
			return { stdout: "shell output here", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.workspaceRef, "workspace:11");
	// Should pick surface:30 (the selected one), not surface:29
	assert.equal(result.data?.surfaceRef, "surface:30");
	assert.match(result.text, /shell output here/);
	assert.equal(result.data?.inspectedSurfaces?.length, 1);
	assert.equal(result.data?.inspectedSurfaces?.[0]?.ref, "surface:30");
});

test("workspace-only inspect_session with workspaceName resolves from context", async () => {
	const calls: string[] = [];
	const exec: SessionExecFn = async (_command, args) => {
		calls.push(args.join(" "));
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "pi session output", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceName: "Collectors Survey" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec, systemContext: CONTEXT },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.workspaceRef, "workspace:11");
	assert.equal(result.data?.workspaceName, "Collectors Survey");
});

test("workspace-only inspect_session with maxSurfaces=2 inspects two tabs", async () => {
	const multiSurfaces = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:1", title: "pi session", selected: true },
		{ ref: "surface:2", title: "shell" },
		{ ref: "surface:3", title: "editor" },
	] }] }] }] });
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: multiSurfaces, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") {
			const surface = args[args.indexOf("--surface") + 1];
			return { stdout: `content of ${surface}`, stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11", maxSurfaces: 2 },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.inspectedSurfaces?.length, 2);
	assert.equal(result.data?.inspectedSurfaces?.[0]?.ref, "surface:1");
	assert.equal(result.data?.inspectedSurfaces?.[1]?.ref, "surface:2");
	assert.match(result.text, /Inspected 2 tab/);
	assert.match(result.text, /content of surface:1/);
	assert.match(result.text, /content of surface:2/);
});

test("workspace-only inspect_session returns empty message for workspace with no tabs", async () => {
	const emptyTree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [] }] }] }] });
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "tree --workspace workspace:99 --json --id-format both") return { stdout: emptyTree, stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:99" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, true);
	assert.match(result.text, /no visible tabs/i);
});

test("workspace-only inspect_session handles failed surface reads gracefully", async () => {
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "", stderr: "cmux read-screen failed", exitCode: 1 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, false);
	assert.equal(result.failure?.code, "execution.exit_nonzero");
	assert.equal(result.data?.inspectedSurfaces?.length, 1);
	assert.match(result.data?.inspectedSurfaces?.[0]?.screenText ?? "", /read failed/);
});

test("rankSurfaces prefers agent-like titles over generic ones when neither is selected", async () => {
	const agentFirstTree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:10", title: "notes.txt" },
		{ ref: "surface:11", title: "pi session" },
	] }] }] }] });
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: agentFirstTree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: `screen for ${args[args.indexOf("--surface") + 1]}`, stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceRef: "workspace:11" },
		{ requestId: "req", toolCallId: "tool", risk: "read" },
		{ exec },
	);

	assert.equal(result.success, true);
	// pi session should be picked over notes.txt (agent title > generic)
	assert.equal(result.data?.surfaceRef, "surface:11");
});

test("inspect_session single-surface path still includes inspectedSurfaces array", async () => {
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "tree --workspace workspace:11 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "CI ✅ all passed (9)", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};

	const result = await inspectSession(
		{ tool: "inspect_session", workspaceName: "collector survey", tabHint: "local CI runs", lines: 160 },
		{ requestId: "req", toolCallId: "tool", risk: "read", workspaceRef: "workspace:1" },
		{ exec, systemContext: CONTEXT },
	);

	assert.equal(result.success, true);
	assert.equal(result.data?.inspectedSurfaces?.length, 1);
	assert.equal(result.data?.inspectedSurfaces?.[0]?.ref, "surface:29");
});
