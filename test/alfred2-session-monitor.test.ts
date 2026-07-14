import test from "node:test";
import assert from "node:assert/strict";

import { SessionMonitorManager, type SessionMonitorDecision } from "../src/alfred-2/session-monitor.ts";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import type { SessionExecFn } from "../src/alfred-2/tools/session.ts";

const CONTEXT = `WORKSPACES (1):
  Collectors Survey [current] | ref:workspace:11 | /tmp/collectors | branch: feature (clean)`;

const tree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
	{ ref: "surface:30", title: "Pi chat", selected: true },
] }] }] }] });

function ctx(toolCallId = "tool") {
	return { requestId: "req", toolCallId, risk: "read" as const, workspaceRef: "workspace:11" };
}

function createExec(screen: () => string, sent: string[][]): SessionExecFn {
	return async (_command, args) => {
		if (args[0] === "tree") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: screen(), stderr: "", exitCode: 0 };
		if (args[0] === "send") {
			sent.push(args);
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
	};
}

test("session monitor starts, drafts on poll, and suppresses duplicate unchanged screens", async () => {
	const sent: string[][] = [];
	let currentScreen = "User: can you handle this?";
	const decisions: SessionMonitorDecision[] = [
		{ kind: "draft_reply", message: "I can handle that." },
		{ kind: "draft_reply", message: "duplicate should not send" },
	];
	const manager = new SessionMonitorManager({
		llmClient: createFakeLlmClient([]),
		exec: createExec(() => currentScreen, sent),
		systemContext: CONTEXT,
		setTimer: () => ({ timer: true }),
		clearTimer: () => {},
		decide: async () => decisions.shift()!,
	});

	const start = await manager.start({ tool: "start_session_monitor", workspaceName: "Collectors Survey", tabHint: "Pi chat", goal: "answer direct questions", pollIntervalMs: 1000, maxTurns: 3 }, ctx("start"));
	assert.equal(start.success, true);
	const monitorId = start.data?.monitor?.id;
	assert.ok(monitorId);
	assert.equal(start.data?.monitor?.replyMode, "draft");

	const first = await manager.poll({ tool: "poll_session_monitor", monitorId }, ctx("poll-1"));
	assert.equal(first.success, true);
	assert.equal(first.data?.action, "drafted");
	assert.equal(first.data?.monitor?.turns, 1);
	assert.deepEqual(sent.at(-1), ["send", "--workspace", "workspace:11", "--surface", "surface:30", "I can handle that."]);

	const second = await manager.poll({ tool: "poll_session_monitor", monitorId }, ctx("poll-2"));
	assert.equal(second.success, true);
	assert.equal(second.data?.action, "wait");
	assert.equal(sent.length, 1);

	currentScreen = "User: new question now";
	const status = manager.status({ tool: "session_monitor_status", monitorId }, ctx("status"));
	assert.equal(status.data?.monitors[0]?.status, "waiting");
});

test("session monitor send mode appends Enter for autonomous replies", async () => {
	const sent: string[][] = [];
	const manager = new SessionMonitorManager({
		llmClient: createFakeLlmClient([]),
		exec: createExec(() => "User: please reply now", sent),
		systemContext: CONTEXT,
		setTimer: () => ({ timer: true }),
		clearTimer: () => {},
		decide: async () => ({ kind: "send_reply", message: "Done." }),
	});

	const start = await manager.start({ tool: "start_session_monitor", workspaceRef: "workspace:11", surfaceRef: "surface:30", goal: "answer direct requests", replyMode: "send", pollIntervalMs: 1000, maxTurns: 1 }, ctx("start"));
	assert.equal(start.success, true);

	const poll = await manager.poll({ tool: "poll_session_monitor", monitorId: start.data!.monitor!.id }, ctx("poll"));
	assert.equal(poll.success, true);
	assert.equal(poll.data?.action, "sent");
	assert.equal(poll.data?.monitor?.status, "done");
	assert.deepEqual(sent.at(-1), ["send", "--workspace", "workspace:11", "--surface", "surface:30", "Done.\\n"]);
});

test("session monitor stops and reports no active monitor", async () => {
	const manager = new SessionMonitorManager({
		llmClient: createFakeLlmClient([]),
		exec: createExec(() => "idle", []),
		systemContext: CONTEXT,
		setTimer: () => ({ timer: true }),
		clearTimer: () => {},
	});
	const start = await manager.start({ tool: "start_session_monitor", workspaceRef: "workspace:11", surfaceRef: "surface:30", goal: "watch" }, ctx("start"));
	assert.equal(start.success, true);
	const stopped = manager.stop({ tool: "stop_session_monitor", monitorId: start.data!.monitor!.id }, ctx("stop"));
	assert.equal(stopped.success, true);
	assert.equal(manager.status({ tool: "session_monitor_status" }, ctx("status")).data?.monitors.length, 0);
});

test("session monitor LLM decision parser fails closed on invalid output", async () => {
	const manager = new SessionMonitorManager({
		llmClient: createFakeLlmClient(["not json"]),
		exec: createExec(() => "User: please reply", []),
		systemContext: CONTEXT,
		setTimer: () => ({ timer: true }),
		clearTimer: () => {},
	});
	const start = await manager.start({ tool: "start_session_monitor", workspaceRef: "workspace:11", surfaceRef: "surface:30", goal: "watch" }, ctx("start"));
	const poll = await manager.poll({ tool: "poll_session_monitor", monitorId: start.data!.monitor!.id }, ctx("poll"));
	assert.equal(poll.success, true);
	assert.equal(poll.data?.action, "needs_user");
	assert.match(poll.text, /invalid JSON/i);
});
