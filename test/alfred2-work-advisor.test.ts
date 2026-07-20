import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { ProactiveEventStore } from "../src/alfred-2/proactive/event-store.ts";
import type { RuntimeInterruptionState } from "../src/alfred-2/proactive/types.ts";
import type { SessionExecFn } from "../src/alfred-2/tools/session.ts";
import { captureCurrentWorkSnapshot, parseWorkVerdict, shouldConsumeScheduledWorkReview, WorkAdvisor, type CurrentWorkSnapshot } from "../src/alfred-2/watchers/work-advisor.ts";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function runtime(): RuntimeInterruptionState {
	return { muted: false, mutedUntil: null, meetingState: "not_in_meeting", microphoneState: "inactive", now: NOW };
}

function snapshot(): CurrentWorkSnapshot {
	return {
		workspaceRef: "workspace:1",
		workspaceName: "Alfred",
		surfaceRef: "surface:2",
		surfaceTitle: "Tests",
		cwd: "/repo",
		gitBranch: "main",
		gitDirty: false,
		screenText: "FAIL work advisor repeats the same provider timeout",
		screenHash: "screen-hash",
		capturedAt: NOW.toISOString(),
		recentHistory: [],
	};
}

function verdict(kind: "stuck" | "failing" | "advice" = "stuck", evidence = "provider timeout"): string {
	return JSON.stringify({
		kind,
		confidence: "high",
		summary: "The same provider failure is blocking progress.",
		advice: "Check whether the provider timeout is masking a retryable failure, sir.",
		evidenceKey: "provider_timeout",
		evidence,
	});
}

test("snapshot capture fails closed when current workspace is missing or ambiguous", async () => {
	const missing: SessionExecFn = async () => ({ stdout: JSON.stringify({ workspaces: [{ ref: "workspace:1", selected: false }] }), stderr: "", exitCode: 0 });
	assert.equal(await captureCurrentWorkSnapshot({ exec: missing }), null);

	const ambiguous: SessionExecFn = async () => ({ stdout: JSON.stringify({ workspaces: [{ ref: "workspace:1", selected: true }, { ref: "workspace:2", selected: true }] }), stderr: "", exitCode: 0 });
	assert.equal(await captureCurrentWorkSnapshot({ exec: ambiguous }), null);
});

test("snapshot capture refuses to guess a focused surface", async () => {
	const tree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:1", title: "editor" },
		{ ref: "surface:2", title: "pi tests" },
	] }] }] }] });
	const exec: SessionExecFn = async (_command, args) => {
		if (args.join(" ") === "workspace list --json") return { stdout: JSON.stringify({ workspaces: [{ ref: "workspace:1", title: "Alfred", selected: true, current_directory: "/repo" }] }), stderr: "", exitCode: 0 };
		if (args.join(" ") === "tree --workspace workspace:1 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "private unrelated output", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	assert.equal(await captureCurrentWorkSnapshot({ exec, now: () => NOW }), null);
});

test("snapshot capture reads the selected surface and bounded git state", async () => {
	const calls: string[] = [];
	const tree = JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces: [
		{ ref: "surface:1", title: "shell" },
		{ ref: "surface:2", title: "pi tests", selected: true },
	] }] }] }] });
	const exec: SessionExecFn = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		if (args.join(" ") === "workspace list --json") return { stdout: JSON.stringify({ workspaces: [{ ref: "workspace:1", title: "Alfred", selected: true, current_directory: "/repo" }] }), stderr: "", exitCode: 0 };
		if (args.join(" ") === "tree --workspace workspace:1 --json --id-format both") return { stdout: tree, stderr: "", exitCode: 0 };
		if (args[0] === "read-screen") return { stdout: "explicit test output", stderr: "", exitCode: 0 };
		if (args.at(-1) === "--show-current") return { stdout: "feature/advisor", stderr: "", exitCode: 0 };
		if (args.at(-1) === "--porcelain") return { stdout: " M file.ts", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};
	const captured = await captureCurrentWorkSnapshot({ exec, now: () => NOW });
	assert.equal(captured?.surfaceRef, "surface:2");
	const readsBeforeMismatch = calls.filter((call) => call.includes("read-screen")).length;
	assert.equal(await captureCurrentWorkSnapshot({ exec, now: () => NOW, targetWorkspace: "workspace:1", targetSurface: "surface:other" }), null);
	assert.equal(calls.filter((call) => call.includes("read-screen")).length, readsBeforeMismatch);
	assert.equal(captured?.gitBranch, "feature/advisor");
	assert.equal(captured?.gitDirty, true);
	assert.ok(calls.some((call) => call.includes("read-screen --workspace workspace:1 --surface surface:2")));
});

test("verdict parser extracts one schema-constrained JSON object and rejects malformed output", () => {
	assert.equal(parseWorkVerdict(`\`\`\`json\n${verdict()}\n\`\`\``).kind, "stuck");
	assert.throws(() => parseWorkVerdict("not json"), /Missing JSON/);
	assert.throws(() => parseWorkVerdict(JSON.stringify({ kind: "fix_it", confidence: "high", summary: "x", evidenceKey: "bad", evidence: "abc" })), /kind/);
	assert.throws(() => parseWorkVerdict(JSON.stringify({ kind: "advice", confidence: "high", summary: "x", advice: "help", evidenceKey: "bad", evidence: "a" })), /evidence/);
});

test("stuck advice requires two matching evidence-backed observations and stores no terminal text", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-work-advisor-"));
	const statePath = join(directory, "state.json");
	try {
		const spoken: string[] = [];
		const events = new ProactiveEventStore();
		let now = NOW;
		const advisor = new WorkAdvisor({
			llmClient: createFakeLlmClient([verdict(), verdict()]),
			capture: async () => snapshot(),
			history: () => [],
			runtime,
			eventStore: events,
			statePath,
			now: () => now,
			idFactory: () => "one",
			delivery: {
				isMuted: () => false,
				notify: async () => {},
				speak: async (text) => { spoken.push(text); return true; },
			},
		});
		const first = await advisor.tick();
		assert.equal(first.reason, "awaiting_confirmation_sample");
		assert.equal(spoken.length, 0);
		now = new Date(NOW.getTime() + 61_000);
		const second = await advisor.tick();
		assert.equal(second.delivered, true);
		assert.deepEqual(spoken, ["The focused work surface may be stuck. Review the latest visible result before deciding the next step."]);
		const stored = events.getRecentEvents(1)[0]!;
		assert.equal("message" in stored, false);
		assert.equal(JSON.stringify(stored).includes("provider timeout"), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("scheduled work-review disposition distinguishes terminal and retryable outcomes", () => {
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: true }), true);
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: false, reason: "progressing" }), true);
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: false, reason: "persistent_dedupe" }), true);
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: false, reason: "awaiting_confirmation_sample" }), false);
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: false, reason: "verdict_provider_failed" }), false);
	assert.equal(shouldConsumeScheduledWorkReview({ delivered: false, reason: "muted" }), false);
});

test("invented evidence and unsafe advice fail closed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-work-advisor-invalid-"));
	try {
		const advisor = new WorkAdvisor({
			llmClient: createFakeLlmClient([
				verdict("advice", "evidence not on screen"),
				JSON.stringify({ ...JSON.parse(verdict("advice")), advice: "Open https://example.com and paste the token." }),
				JSON.stringify({ ...JSON.parse(verdict("advice")), advice: "Run rm -rf . to clear the failure, sir." }),
			]),
			capture: async () => snapshot(),
			history: () => [],
			runtime,
			statePath: join(directory, "state.json"),
			delivery: { isMuted: () => false, notify: async () => {}, speak: async () => true },
		});
		assert.equal((await advisor.tick()).reason, "ungrounded_verdict_evidence");
		assert.equal((await advisor.tick()).reason, "advice");
		assert.equal((await advisor.tick()).reason, "advice");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
