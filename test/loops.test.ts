import assert from "node:assert/strict";
import test from "node:test";
import { createAlfredLoopManager } from "../src/loops/index.ts";
import { cliSource, piCommandSource, powerCodeTarget } from "../src/testing/fixtures.ts";

function createLoopCmux() {
	return {
		async listTargets() {
			return { ok: true as const, value: [powerCodeTarget()] };
		},
		async readSurface(surfaceRef: string) {
			return { ok: true as const, value: { text: `screen for ${surfaceRef}` } };
		},
	};
}

test("loop manager rejects malformed start requests with structured invalid_request", async () => {
	const manager = createAlfredLoopManager({ cmux: createLoopCmux(), now: () => new Date("2026-06-19T22:00:00.000Z") });
	const result = await manager.start({ requestId: "req_bad_loop" } as never);

	assert.equal(result.ok, false);
	assert.equal(result.errors?.[0]?.code, "invalid_request");
});

test("loop manager active state is a defensive copy", async () => {
	const manager = createAlfredLoopManager({ cmux: createLoopCmux(), now: () => new Date("2026-06-19T22:00:00.000Z") });
	const started = await manager.start({
		requestId: "req_loop_start_copy",
		source: piCommandSource(),
		targetRef: "surface:42",
		goal: { value: "Do work.", redaction: { status: "not_needed" } },
		maxTurns: 4,
		pollIntervalMs: 3_000,
		allowedCapabilities: piCommandSource().capabilities,
	});
	assert.ok(started.activeLoop?.id);

	const active = manager.active();
	assert.ok(active);
	active.summary.status = "failed";
	active.summary.target.capabilities.length = 0;
	active.source.capabilities.length = 0;
	active.allowedCapabilities.length = 0;
	active.lastDecision = { kind: "done", summary: "mutated" };

	const status = manager.status(started.activeLoop.id);
	assert.equal(status?.status, "running");
	assert.deepEqual(status?.target.capabilities, ["surface.read", "surface.send"]);
	assert.deepEqual(manager.active()?.source.capabilities, piCommandSource().capabilities);
	assert.deepEqual(manager.active()?.allowedCapabilities, piCommandSource().capabilities);
	assert.equal(manager.active()?.lastDecision, undefined);
});

test("loop manager stops are capability-scoped even for direct callers", async () => {
	const manager = createAlfredLoopManager({ cmux: createLoopCmux(), now: () => new Date("2026-06-19T22:00:00.000Z") });
	const started = await manager.start({
		requestId: "req_loop_start_direct",
		source: piCommandSource(),
		targetRef: "surface:42",
		goal: { value: "Do work.", redaction: { status: "not_needed" } },
		maxTurns: 4,
		pollIntervalMs: 3_000,
		allowedCapabilities: piCommandSource().capabilities,
	});
	assert.equal(started.ok, true);
	const loopId = started.activeLoop?.id;
	assert.ok(loopId);

	const denied = await manager.stop(loopId, { requestId: "req_loop_stop_denied", source: cliSource() });
	assert.equal(denied.ok, false);
	assert.equal(denied.errors?.[0]?.code, "capability_denied");
	assert.equal(manager.status(loopId)?.status, "running");
});

test("loop manager malformed decision values fail closed", async () => {
	const cases: Array<{ name: string; decision: unknown; summaryPattern: RegExp }> = [
		{ name: "missing draft message", decision: { kind: "draft_reply" }, summaryPattern: /empty reply/i },
		{ name: "null decision", decision: null, summaryPattern: /invalid decision/i },
		{ name: "non-object decision", decision: "wait", summaryPattern: /invalid decision/i },
		{ name: "unknown kind", decision: { kind: "bogus" }, summaryPattern: /invalid decision/i },
	];
	for (const testCase of cases) {
		const manager = createAlfredLoopManager({
			cmux: createLoopCmux(),
			now: () => new Date("2026-06-19T22:00:00.000Z"),
			decide: async () => testCase.decision as never,
		});
		const started = await manager.start({
			requestId: `req_loop_start_malformed_decision_${testCase.name.replace(/\W+/g, "_")}`,
			source: piCommandSource(),
			targetRef: "surface:42",
			goal: { value: "Do work.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: piCommandSource().capabilities,
		});
		assert.ok(started.activeLoop?.id, testCase.name);

		const decision = await manager.poll(started.activeLoop.id);
		assert.equal(decision.kind, "needs_user", testCase.name);
		assert.match(decision.summary, testCase.summaryPattern, testCase.name);
		assert.equal(manager.status(started.activeLoop.id)?.status, "needs_user", testCase.name);
	}
});

test("loop manager recordReplyFailed updates status, cancels scheduling, and ignores wrong loop IDs", async () => {
	const cancelled: string[] = [];
	const manager = createAlfredLoopManager({
		cmux: createLoopCmux(),
		now: () => new Date("2026-06-19T22:00:00.000Z"),
		scheduler: { schedule() { /* not needed */ }, cancel(loopId) { cancelled.push(loopId); } },
	});
	const started = await manager.start({
		requestId: "req_loop_start_reply_failed",
		source: piCommandSource(),
		targetRef: "surface:42",
		goal: { value: "Do work.", redaction: { status: "not_needed" } },
		maxTurns: 4,
		pollIntervalMs: 3_000,
		allowedCapabilities: piCommandSource().capabilities,
	});
	const loopId = started.activeLoop?.id;
	assert.ok(loopId);

	manager.recordReplyFailed("loop_missing", "failed");
	assert.equal(manager.status(loopId)?.status, "running");
	assert.deepEqual(cancelled, []);

	manager.recordReplyFailed(loopId, "needs_user");
	assert.equal(manager.status(loopId)?.status, "needs_user");
	assert.deepEqual(cancelled, [loopId]);
});

test("loop manager decision provider failures fail closed", async () => {
	const manager = createAlfredLoopManager({
		cmux: createLoopCmux(),
		now: () => new Date("2026-06-19T22:00:00.000Z"),
		decide: async () => { throw new Error("provider exploded"); },
	});
	const started = await manager.start({
		requestId: "req_loop_start_throw",
		source: piCommandSource(),
		targetRef: "surface:42",
		goal: { value: "Do work.", redaction: { status: "not_needed" } },
		maxTurns: 4,
		pollIntervalMs: 3_000,
		allowedCapabilities: piCommandSource().capabilities,
	});
	assert.ok(started.activeLoop?.id);

	const decision = await manager.poll(started.activeLoop.id);
	assert.equal(decision.kind, "needs_user");
	assert.match(decision.summary, /decision provider failed/i);
	assert.equal(manager.status(started.activeLoop.id)?.status, "needs_user");
});
