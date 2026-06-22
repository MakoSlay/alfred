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
