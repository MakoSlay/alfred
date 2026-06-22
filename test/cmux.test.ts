import assert from "node:assert/strict";
import test from "node:test";
import { createCmuxWorldModelAdapter, type CmuxExec } from "../src/cmux/index.ts";

const workspaceList = JSON.stringify({
	workspaces: [
		{ id: "10", ref: "workspace:10", title: "Powerco", selected: true, current_directory: "/tmp/powerco" },
		{ id: "11", ref: "workspace:11", title: "Sandbox", selected: false, current_directory: "/tmp/sandbox" },
	],
});

const identify = JSON.stringify({
	caller: { workspace_id: "10", workspace_ref: "workspace:10", surface_ref: "surface:2", tab_ref: "surface:2", pane_ref: "pane:1", window_ref: "window:1" },
});

const powercoJsonTree = JSON.stringify({
	windows: [{
		workspaces: [{
			panes: [
				{
					surfaces: [
						{ ref: "surface:1", title: "π - Power Code", type: "terminal", selected: false, focused: false, here: false, selected_in_pane: false },
						{ ref: "surface:2", title: "Codex Review", type: "terminal", selected: true, focused: true, here: true, selected_in_pane: true },
						{ ref: "surface:3", title: "Shell", type: "terminal", selected: false, focused: false, here: false, selected_in_pane: false },
					],
				},
			],
		}],
	}],
});

const sandboxJsonTree = JSON.stringify({
	windows: [{
		workspaces: [{
			panes: [
				{
					surfaces: [
						{ ref: "surface:4", title: "Unknown Terminal", type: "terminal", selected: false, focused: true, here: true, selected_in_pane: true },
					],
				},
			],
		}],
	}],
});

const capabilitiesJson = JSON.stringify({
	access_mode: "cmuxOnly",
	methods: ["surface.send_text", "surface.read_text", "notification.list"],
	version: 2,
	protocol: "cmux-socket",
});

const notificationList = JSON.stringify([
	{ id: "n1", title: "Pi — Powerco", subtitle: "Task Complete", body: "3 cmds · 15s", is_read: false, created_at: "2026-01-01T00:00:00Z", workspace_id: "10", surface_id: "s1", tab_title: "Powerco" },
	{ id: "n2", title: "Pi — Sandbox", subtitle: "Waiting", body: "Waiting for input", is_read: true, created_at: "2026-01-01T01:00:00Z", workspace_id: "11", surface_id: "s2", tab_title: "Sandbox" },
]);

const sidebarStateOutput = `tab=abc123
color=#ff9500
cwd=/tmp/powerco
focused_cwd=/tmp/powerco
focused_panel=panel1
git_branch=main clean
ports=47321,8080
progress=0.75
status_count=2
log_count=1
`;

const statusListOutput = `build=compiling icon=hammer color=#ff9500 priority=80
test=passing icon=checkmark
`;

function createFakeExec(fail?: (args: readonly string[]) => Error | null): { exec: CmuxExec; calls: Array<{ file: string; args: readonly string[] }> } {
	const calls: Array<{ file: string; args: readonly string[] }> = [];
	const exec: CmuxExec = async (file, args) => {
		calls.push({ file, args });
		const failure = fail?.(args);
		if (failure) throw failure;
		const joined = args.join(" ");
		// workspace / identify
		if (joined === "workspace list --json --id-format both") return { stdout: workspaceList, stderr: "" };
		if (joined === "identify --id-format both") return { stdout: identify, stderr: "" };
		// JSON tree (primary path)
		if (joined === "tree --workspace workspace:10 --json --id-format both") return { stdout: powercoJsonTree, stderr: "" };
		if (joined === "tree --workspace workspace:11 --json --id-format both") return { stdout: sandboxJsonTree, stderr: "" };
		// text tree (fallback path)
		if (joined === "tree --workspace workspace:10" || joined === "tree --workspace workspace:11") return { stdout: "", stderr: "" };
		// terminal I/O
		if (joined.startsWith("read-screen --surface surface:1")) return { stdout: "assistant: ready", stderr: "" };
		if (joined.startsWith("read-screen --surface surface:9")) return { stdout: "assistant: ready", stderr: "" };
		if (args[0] === "send" || args[0] === "send-key") return { stdout: "", stderr: "" };
		// capabilities
		if (joined === "capabilities") return { stdout: capabilitiesJson, stderr: "" };
		// notifications
		if (joined === "list-notifications --json --id-format both") return { stdout: notificationList, stderr: "" };
		if (args[0] === "dismiss-notification" && args[1] === "--id") return { stdout: "", stderr: "" };
		if (args[0] === "dismiss-notification" && args[1] === "--all-read") return { stdout: "", stderr: "" };
		if (args[0] === "mark-notification-read" && args[1] === "--id") return { stdout: "", stderr: "" };
		if (args[0] === "mark-notification-read" && args[1] === "--all") return { stdout: "", stderr: "" };
		if (args[0] === "open-notification" && args[1] === "--id") return { stdout: "", stderr: "" };
		if (args[0] === "jump-to-unread") return { stdout: "", stderr: "" };
		if (args[0] === "clear-notifications") return { stdout: "", stderr: "" };
		// sidebar
		if (args[0] === "set-status") return { stdout: "", stderr: "" };
		if (args[0] === "clear-status") return { stdout: "", stderr: "" };
		if (args[0] === "list-status") return { stdout: statusListOutput, stderr: "" };
		if (args[0] === "set-progress") return { stdout: "", stderr: "" };
		if (args[0] === "clear-progress") return { stdout: "", stderr: "" };
		if (args[0] === "log") return { stdout: "", stderr: "" };
		if (args[0] === "sidebar-state") return { stdout: sidebarStateOutput, stderr: "" };
		// markdown / diff / file / URL / browser
		if (args[0] === "markdown" && args[1] === "open") return { stdout: "", stderr: "" };
		if (args[0] === "diff") return { stdout: "", stderr: "" };
		if (args[0] === "open" && args[1].startsWith("http")) return { stdout: "", stderr: "" };
		if (args[0] === "open") return { stdout: "", stderr: "" };
		if (args[0] === "browser" && args[1] === "open") return { stdout: "", stderr: "" };
		throw new Error(`Unexpected cmux call: ${joined}`);
	};
	return { exec, calls };
}

// ─── workspace / surface discovery tests (existing) ───

test("lists cmux workspaces and surfaces as Alfred targets", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const targets = await adapter.listTargets();

	assert.equal(targets.ok, true);
	if (!targets.ok) return;
	assert.equal(targets.value.some((target) => target.kind === "cmux-workspace" && target.label === "Powerco"), true);
	assert.equal(targets.value.some((target) => target.kind === "pi-chat" && target.label === "π - Power Code" && target.processKind === "pi"), true);
	assert.equal(targets.value.some((target) => target.kind === "codex-session" && target.label === "Codex Review" && target.current), true);
	assert.equal(targets.value.some((target) => target.kind === "terminal" && target.label === "Shell"), true);
});

test("matches current and fuzzy named targets", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const current = await adapter.findTargets("this tab");
	assert.equal(current.ok, true);
	if (!current.ok) return;
	assert.equal(current.value[0]?.label, "Codex Review");
	assert.equal(current.value[0]?.kind, "codex-session");

	const fuzzy = await adapter.findTargets("powr code", { workspaceRef: "workspace:10" });
	assert.equal(fuzzy.ok, true);
	if (!fuzzy.ok) return;
	assert.equal(fuzzy.value[0]?.label, "π - Power Code");
	assert.equal(fuzzy.value[0]?.confidence, "fuzzy");
});

test("read and send helpers return structured results and preserve text arguments", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const read = await adapter.readSurface("surface:1", { lines: 80 });
	assert.deepEqual(read, { ok: true, value: { text: "assistant: ready" } });

	const text = "Please run tests && do not shell-expand $HOME";
	const sent = await adapter.sendTextToSurface("surface:1", text);
	assert.deepEqual(sent, { ok: true, value: { surfaceRef: "surface:1" } });
	assert.deepEqual(calls.at(-2)?.args, ["send", "--surface", "surface:1", text]);
	assert.deepEqual(calls.at(-1)?.args, ["send-key", "--surface", "surface:1", "enter"]);
});

test("read failures are structured instead of thrown", async () => {
	const { exec } = createFakeExec((args) => args[0] === "read-screen" ? new Error("cmux unavailable") : null);
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const read = await adapter.readSurface("surface:1");

	assert.equal(read.ok, false);
	if (read.ok) return;
	assert.equal(read.error.code, "command_failed");
	assert.match(read.error.message, /cmux unavailable/);
});

// ─── capabilities ───

test("capabilities returns parsed access mode and methods", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.capabilities();
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.accessMode, "cmuxOnly");
	assert.equal(result.value.protocol, "cmux-socket");
	assert.equal(result.value.version, 2);
	assert.equal(result.value.methods.length > 0, true);
	assert.equal(result.value.methods.includes("surface.send_text"), true);
});

// ─── notifications ───

test("lists notifications with parsed fields", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.listNotifications();
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.length, 2);
	assert.equal(result.value[0]?.id, "n1");
	assert.equal(result.value[0]?.title, "Pi — Powerco");
	assert.equal(result.value[0]?.isRead, false);
	assert.equal(result.value[1]?.isRead, true);
});

test("dismissNotification calls the right cmux command", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.dismissNotification("n1");
	assert.equal(result.ok, true);
	const dismissCall = calls.find((c) => c.args[0] === "dismiss-notification");
	assert.ok(dismissCall);
	assert.deepEqual(dismissCall.args, ["dismiss-notification", "--id", "n1"]);
});

test("markNotificationRead and markAllNotificationsRead call expected cmux commands", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const markOne = await adapter.markNotificationRead("n1");
	assert.equal(markOne.ok, true);
	assert.equal(markOne.ok && markOne.value.id, "n1");

	const markAll = await adapter.markAllNotificationsRead();
	assert.equal(markAll.ok, true);
	assert.equal(markAll.ok && markAll.value.marked, true);

	const markAllCall = calls.find((c) => c.args[0] === "mark-notification-read" && c.args[1] === "--all");
	assert.ok(markAllCall);
});

test("jumpToUnreadNotification and clearNotifications are structured", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const jump = await adapter.jumpToUnreadNotification();
	assert.equal(jump.ok, true);

	const clear = await adapter.clearNotifications();
	assert.equal(clear.ok, true);
	assert.equal(clear.ok && clear.value.cleared, true);
});

// ─── sidebar status / progress / log ───

test("setStatus passes key/value and optional flags", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.setStatus("build", "compiling", { icon: "hammer", color: "#ff9500", priority: 80 });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.key, "build");
	assert.equal(result.value.value, "compiling");

	const statusCall = calls.find((c) => c.args[0] === "set-status");
	assert.ok(statusCall);
	assert.deepEqual(statusCall?.args, ["set-status", "build", "compiling", "--icon", "hammer", "--color", "#ff9500", "--priority", "80"]);
});

test("setProgress clamps value 0-1 and passes label", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.setProgress(1.5, { label: "Building..." });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.value, 1);
	const progressCall = calls.find((c) => c.args[0] === "set-progress");
	assert.ok(progressCall);
	assert.deepEqual(progressCall?.args, ["set-progress", "1", "--label", "Building..."]);
});

test("clearProgress calls cmux clear-progress", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.clearProgress({ workspaceRef: "workspace:10" });
	assert.equal(result.ok, true);
	const progressCall = calls.find((c) => c.args[0] === "clear-progress");
	assert.ok(progressCall);
	assert.deepEqual(progressCall?.args, ["clear-progress", "--workspace", "workspace:10"]);
});

test("listStatus parses cmux status entries", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.listStatus("workspace:10");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.length, 2);
	assert.equal(result.value[0]?.key, "build");
	assert.equal(result.value[0]?.value, "compiling");
	assert.equal(result.value[0]?.icon, "hammer");
	assert.equal(result.value[0]?.priority, 80);
});

test("sidebarState parses key=value output", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.sidebarState("workspace:10");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.cwd, "/tmp/powerco");
	assert.equal(result.value.gitBranch, "main");
	assert.equal(result.value.gitDirty, false);
	assert.equal(result.value.progress?.value, 0.75);
	assert.equal(result.value.ports.length, 2);
	assert.equal(result.value.ports.includes("47321"), true);
	assert.equal(result.value.statusCount, 2);
	assert.equal(result.value.logCount, 1);
});

// ─── markdown / diff / file / URL / browser open ───

test("openMarkdown passes path and returns structured result", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.openMarkdown("plan.md", { workspaceRef: "workspace:10" });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.path, "plan.md");

	const mdCall = calls.find((c) => c.args[0] === "markdown");
	assert.ok(mdCall);
	assert.deepEqual(mdCall?.args, ["markdown", "open", "plan.md", "--workspace", "workspace:10"]);
});

test("openDiff passes flags and returns structured result", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const result = await adapter.openDiff({ unstaged: true, workspaceRef: "workspace:10" });
	assert.equal(result.ok, true);

	const diffCall = calls.find((c) => c.args[0] === "diff");
	assert.ok(diffCall);
	assert.equal(diffCall?.args.includes("--unstaged"), true);
	assert.equal(diffCall?.args.includes("workspace:10"), true);
});

test("openFile and openUrl use the same open command", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const fileResult = await adapter.openFile("report.pdf", { workspaceRef: "workspace:10" });
	assert.equal(fileResult.ok, true);

	const urlResult = await adapter.openUrl("https://example.com", { workspaceRef: "workspace:10" });
	assert.equal(urlResult.ok, true);
});

test("rich open helpers pass explicit focus flag values", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	await adapter.openMarkdown("plan.md", { focus: true });
	await adapter.openDiff({ focus: false });
	await adapter.openBrowserSurface("https://example.com", { focus: true });

	assert.deepEqual(calls.find((c) => c.args[0] === "markdown")?.args, ["markdown", "open", "plan.md", "--focus", "true"]);
	assert.deepEqual(calls.find((c) => c.args[0] === "diff")?.args, ["diff", "--focus", "false"]);
	assert.deepEqual(calls.find((c) => c.args[0] === "browser")?.args, ["browser", "open", "https://example.com", "--focus", "true"]);
});

// ─── error handling for new methods ───

test("new methods return structured errors on cmux failure", async () => {
	const { exec } = createFakeExec(() => new Error("cmux crashed"));
	const adapter = createCmuxWorldModelAdapter({ execFile: exec, processEnv: {} });

	const caps = await adapter.capabilities();
	assert.equal(caps.ok, false);
	if (caps.ok) return;
	assert.equal(caps.error.code, "command_failed");

	const notifs = await adapter.listNotifications();
	assert.equal(notifs.ok, false);

	const status = await adapter.setStatus("key", "val");
	assert.equal(status.ok, false);
});

test("identifyCurrent uses cmux environment refs without dropping surface context", async () => {
	const { exec } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({
		execFile: exec,
		processEnv: {
			CMUX_WORKSPACE_ID: "workspace:10",
			CMUX_SURFACE_ID: "surface:2",
			CMUX_TAB_ID: "tab:2",
			CMUX_PANE_ID: "pane:1",
			CMUX_WINDOW_ID: "window:1",
		},
	});

	const current = await adapter.identifyCurrent();
	assert.equal(current.ok, true);
	if (!current.ok) return;
	assert.equal(current.value.workspaceRef, "workspace:10");
	assert.equal(current.value.surfaceRef, "surface:2");
	assert.equal(current.value.tabRef, "tab:2");
});

test("identifyCurrent still calls cmux identify when only workspace env is present", async () => {
	const { exec, calls } = createFakeExec();
	const adapter = createCmuxWorldModelAdapter({
		execFile: exec,
		processEnv: { CMUX_WORKSPACE_ID: "10" },
	});

	const current = await adapter.identifyCurrent();
	assert.equal(current.ok, true);
	if (!current.ok) return;
	assert.equal(current.value.workspaceRef, "workspace:10");
	assert.equal(current.value.surfaceRef, "surface:2");
	assert.ok(calls.some((call) => call.args.join(" ") === "identify --id-format both"));
});


test("malformed JSON in list-notifications returns parse_failed", async () => {
	const adapter = createCmuxWorldModelAdapter({
		execFile: async () => ({ stdout: "not json", stderr: "" }),
		processEnv: {},
	});

	const result = await adapter.listNotifications();
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.code, "parse_failed");
});

test("malformed JSON in capabilities returns parse_failed", async () => {
	const adapter = createCmuxWorldModelAdapter({
		execFile: async () => ({ stdout: "{ bad json", stderr: "" }),
		processEnv: {},
	});

	const result = await adapter.capabilities();
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.code, "parse_failed");
});
