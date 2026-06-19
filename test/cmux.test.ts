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
	caller: { workspace_id: "10", workspace_ref: "workspace:10", surface_ref: "surface:2", tab_ref: "surface:2" },
});

const powercoTree = `workspace workspace:10 "Powerco"
  surface surface:1 [terminal] "π - Power Code"
  surface surface:2 [terminal] "Codex Review" [selected]
  surface surface:3 [terminal] "Shell"
`;

const sandboxTree = `workspace workspace:11 "Sandbox"
  surface surface:4 [terminal] "Unknown Terminal"
`;

function createFakeExec(fail?: (args: readonly string[]) => Error | null): { exec: CmuxExec; calls: Array<{ file: string; args: readonly string[] }> } {
	const calls: Array<{ file: string; args: readonly string[] }> = [];
	const exec: CmuxExec = async (file, args) => {
		calls.push({ file, args });
		const failure = fail?.(args);
		if (failure) throw failure;
		const joined = args.join(" ");
		if (joined === "workspace list --json --id-format both") return { stdout: workspaceList, stderr: "" };
		if (joined === "identify --id-format both") return { stdout: identify, stderr: "" };
		if (joined === "tree --workspace workspace:10") return { stdout: powercoTree, stderr: "" };
		if (joined === "tree --workspace workspace:11") return { stdout: sandboxTree, stderr: "" };
		if (joined.startsWith("read-screen --surface surface:1")) return { stdout: "assistant: ready", stderr: "" };
		if (args[0] === "send" || args[0] === "send-key") return { stdout: "", stderr: "" };
		throw new Error(`Unexpected cmux call: ${joined}`);
	};
	return { exec, calls };
}

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
