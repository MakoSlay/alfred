import assert from "node:assert/strict";
import test from "node:test";
import type { AlfredSource, AlfredTarget } from "../src/contracts/runtime.ts";
import {
	createActionRegistry,
	registerBuiltinActions,
	SAFE_RISK,
	CONFIRMATION_REQUIRED_RISK,
	RESTRICTED_RISK,
	type ActionRegistry,
	type ProposeActionParams,
	type TemporaryGrant,
} from "../src/actions/index.ts";

function fakeSource(overrides: Partial<AlfredSource> = {}): AlfredSource {
	return {
		kind: "web-ui",
		id: "test-source",
		trustedLocalOnly: true,
		capabilities: ["world.read", "surface.read", "surface.send", "workspace.send", "loop.manage", "history.read", "history.write", "config.read"],
		...overrides,
	};
}

function fakeTarget(overrides: Partial<AlfredTarget> = {}): AlfredTarget {
	return {
		kind: "cmux-surface",
		ref: "surface:1",
		label: "Test Surface",
		surfaceRef: "surface:1",
		capabilities: ["surface.read", "surface.send"],
		...overrides,
	};
}

function createRegistry(): ActionRegistry {
	const registry = createActionRegistry();
	registerBuiltinActions(registry);
	return registry;
}

function proposePending(registry: ActionRegistry, params: ProposeActionParams) {
	const result = registry.propose(params);
	if (!result.ok) throw new Error(result.decision.message);
	assert.equal(result.ok, true);
	return result.pending;
}

// ─── metadata and listing ───

test("action registry lists all registered actions", () => {
	const registry = createRegistry();

	const actions = registry.list();
	assert.equal(actions.length > 0, true);
	assert.equal(actions.every((a) => typeof a.id === "string" && a.id.length > 0), true);
	const sendAction = actions.find((a) => a.id === "cmux.sendText");
	assert.ok(sendAction);
	assert.equal(sendAction?.riskLevel, CONFIRMATION_REQUIRED_RISK);
});

test("action registry get returns action metadata for known actions", () => {
	const registry = createRegistry();

	const send = registry.get("cmux.sendText");
	assert.ok(send);
	assert.equal(send?.metadata.riskLevel, CONFIRMATION_REQUIRED_RISK);

	const unknown = registry.get("nonexistent.action");
	assert.equal(unknown, undefined);
});

test("safe actions appear with safe risk level", () => {
	const registry = createRegistry();

	const diff = registry.get("cmux.openDiff");
	assert.ok(diff);
	assert.equal(diff?.metadata.riskLevel, SAFE_RISK);

	const notifications = registry.get("cmux.readNotifications");
	assert.ok(notifications);
	assert.equal(notifications?.metadata.riskLevel, SAFE_RISK);
});

test("restricted actions appear with restricted risk level", () => {
	const registry = createRegistry();

	const click = registry.get("browser.click");
	assert.ok(click);
	assert.equal(click?.metadata.riskLevel, RESTRICTED_RISK);
});

// ─── policy evaluation ───

test("safe action is allowed through policy", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "cmux.openDiff",
		input: { unstaged: true },
		source,
	});

	assert.equal(decision.allowed, true);
});

test("confirmation-required action is allowed through policy when target is compatible", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: "surface:1" },
		source,
		target: fakeTarget(),
	});

	assert.equal(decision.allowed, true);
});

test("unknown action is denied", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "nonexistent.action",
		input: {},
		source,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "unknown_action");
	}
});

test("malformed input is denied", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "" }, // missing targetRef
		source,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "invalid_input");
	}
});

test("missing capability is denied", () => {
	const registry = createRegistry();
	const source = fakeSource({ capabilities: ["world.read"] });

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: "surface:1" },
		source,
		target: fakeTarget(),
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "capability_missing");
	}
});

test("restricted action is denied without temporary grant", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();

	const decision = registry.evaluatePolicy({
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		target,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "restricted_without_grant");
	}
});

test("restricted action is allowed with valid temporary grant", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	const grant: TemporaryGrant = {
		id: "grant-1",
		actionMetaId: "browser.click",
		scope: "one_action",
		grantedBy: source,
		grantedAt: new Date().toISOString(),
	};

	const decision = registry.evaluatePolicy({
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		target,
		grant,
	});

	assert.equal(decision.allowed, true);
});

test("one-action restricted grants are consumed after execution attempt", async () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	const grant: TemporaryGrant = {
		id: "grant-once",
		actionMetaId: "browser.click",
		scope: "one_action",
		grantedBy: source,
		grantedAt: new Date().toISOString(),
	};
	const pending = proposePending(registry, {
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		target,
		grant,
	});
	assert.equal(registry.approve(pending.id, source).ok, true);

	const executed = await registry.execute(pending.id, {
		source,
		target,
		requestId: "req-browser",
		now: () => new Date(),
		cmux: {} as never,
	});
	assert.equal(executed.ok, false);

	const reused = registry.evaluatePolicy({
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		target,
		grant,
	});
	assert.equal(reused.allowed, false);
	if (!reused.allowed) {
		assert.equal(reused.reason, "expired_grant");
	}
});

test("expired grant denies restricted action", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	const grant: TemporaryGrant = {
		id: "grant-1",
		actionMetaId: "browser.click",
		scope: "time_window",
		expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
		grantedBy: source,
		grantedAt: new Date(Date.now() - 120_000).toISOString(),
	};

	const decision = registry.evaluatePolicy({
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		target,
		grant,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "expired_grant");
	}
});

test("target-required action is denied when target is missing", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendKey",
		input: { key: "enter", targetRef: "surface:1" },
		source,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "target_incompatible");
	}
});

test("cmux.sendText requires only the target-specific send capability", () => {
	const registry = createRegistry();
	const source = fakeSource({ capabilities: ["surface.send"] });
	const target = fakeTarget({ capabilities: ["surface.send"] });

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	assert.equal(decision.allowed, true);
});

test("cmux.sendText denies unresolved targets", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: "surface:1" },
		source,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "target_incompatible");
	}
});

test("targetRef must match the resolved target", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget({ ref: "surface:2", surfaceRef: "surface:2" });

	const decision = registry.evaluatePolicy({
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: "surface:1" },
		source,
		target,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "target_incompatible");
	}
});

test("browser mutation requires a resolved browser target before grant checks", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const grant: TemporaryGrant = {
		id: "grant-browser",
		actionMetaId: "browser.click",
		scope: "one_action",
		grantedBy: source,
		grantedAt: new Date().toISOString(),
	};

	const decision = registry.evaluatePolicy({
		actionId: "browser.click",
		input: { selector: "button" },
		source,
		grant,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "target_incompatible");
	}
});

test("target-incompatible action is denied when target lacks required capability", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget({ capabilities: [] }); // no surface.read capability

	const decision = registry.evaluatePolicy({
		actionId: "loop.start",
		input: { targetRef: target.ref, goal: "test", maxTurns: 3 },
		source,
		target,
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.reason, "target_incompatible");
	}
});

// ─── pending action lifecycle ───

test("propose creates a pending action with correct metadata", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();

	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	assert.equal(pending.actionMetaId, "cmux.sendText");
	assert.equal(pending.riskLevel, CONFIRMATION_REQUIRED_RISK);
	assert.equal(pending.status, "pending");
	assert.equal(pending.editable, true);
	assert.ok(pending.createdAt);
	assert.ok(pending.expiresAt);
	assert.equal(pending.expiresAt > pending.createdAt, true);
});

test("propose unknown action returns a denial without creating pending state", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const result = registry.propose({
		actionId: "nonexistent.action",
		input: {},
		source,
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.decision.reason, "unknown_action");
	assert.equal(result.event.kind, "action.denied");
	assert.equal(registry.listPending().length, 0);
});

test("editable pending actions can update input with policy revalidation", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	const edited = registry.updateInput(pending.id, { text: "edited", targetRef: target.ref }, source, target);
	assert.equal(edited.ok, true);
	assert.equal(edited.pending?.input.text, "edited");
	assert.equal(edited.event?.kind, "action.edited");

	const denied = registry.updateInput(pending.id, { text: "edited", targetRef: "surface:elsewhere" }, source, target);
	assert.equal(denied.ok, false);
	assert.equal(denied.decision?.reason, "target_incompatible");
});

test("cancel pending action marks it cancelled", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();

	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	const result = registry.cancel(pending.id, "changed my mind");
	assert.equal(result.ok, true);
	assert.equal(result.pending?.status, "cancelled");

	const result2 = registry.cancel(pending.id); // double-cancel
	assert.equal(result2.ok, false);
});

test("cancel unknown pending action returns false", () => {
	const registry = createRegistry();

	const result = registry.cancel("nonexistent-id");
	assert.equal(result.ok, false);
	assert.equal(result.pending, null);
});

test("listPending returns current pending actions", () => {
	const registry = createRegistry();
	const source = fakeSource();

	assert.equal(registry.listPending().length, 0);

	const target = fakeTarget();
	proposePending(registry, { actionId: "cmux.sendText", input: { text: "a", targetRef: target.ref }, source, target });
	proposePending(registry, { actionId: "cmux.openDiff", input: {}, source });

	assert.equal(registry.listPending().length, 2);
});

test("cancelled actions are removed from pending list", () => {
	const registry = createRegistry();
	const source = fakeSource();

	const target = fakeTarget();
	const p1 = proposePending(registry, { actionId: "cmux.sendText", input: { text: "a", targetRef: target.ref }, source, target });
	const p2 = proposePending(registry, { actionId: "cmux.openDiff", input: {}, source });

	registry.cancel(p1.id);
	assert.equal(registry.listPending().length, 1);
	assert.equal(registry.listPending()[0]?.id, p2.id);
});

// ─── execution ───

test("execute expired pending action fails", async () => {
	const registry = createRegistry();
	const source = fakeSource();

	const pending = proposePending(registry, {
		actionId: "cmux.openDiff",
		input: { unstaged: true },
		source,
		ttlMs: -1, // instantly expired
	});

	const fakeCmux = { openDiff: async () => ({ ok: true as const, value: { opened: true } }) };
	const result = await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	assert.equal(result.ok, false);
	assert.equal(result.pending.status, "expired");
});

test("execute unknown action id fails", async () => {
	const registry = createRegistry();
	const source = fakeSource();

	const fakeCmux = {};
	const result = await registry.execute("nonexistent", {
		source,
		target: undefined,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	assert.equal(result.ok, false);
});

test("execute confirmation-required action fails until approved", async () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	let sent = false;

	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	const fakeCmux = {
		sendTextToSurface: async () => {
			sent = true;
			return { ok: true as const, value: { surfaceRef: target.ref } };
		},
		sendTextToWorkspace: async () => ({ ok: true as const, value: { workspaceRef: "workspace:1" } }),
	};

	const denied = await registry.execute(pending.id, {
		source,
		target,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});
	assert.equal(denied.ok, false);
	assert.equal(denied.event.kind, "action.denied");
	assert.equal(sent, false);

	const approved = registry.approve(pending.id, source);
	assert.equal(approved.ok, true);
	assert.equal(approved.pending?.status, "approved");
	assert.equal(approved.event?.kind, "action.approved");

	const executed = await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-2",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});
	assert.equal(executed.ok, true);
	assert.equal(sent, true);
});


test("approve revalidates policy before marking an action approved", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();
	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "hello", targetRef: target.ref },
		source,
		target,
	});

	const result = registry.approve(pending.id, fakeSource({ capabilities: ["world.read"] }));
	assert.equal(result.ok, false);
	assert.equal(result.pending?.status, "denied");
	assert.equal(result.event?.kind, "action.denied");
});


test("execute safe action succeeds directly", async () => {
	const registry = createRegistry();
	const source = fakeSource();
	let diffCalled = false;

	const pending = proposePending(registry, {
		actionId: "cmux.openDiff",
		input: { unstaged: true },
		source,
	});

	const fakeCmux = {
		openDiff: async () => {
			diffCalled = true;
			return { ok: true as const, value: { opened: true } };
		},
	};

	const result = await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	assert.equal(result.ok, true);
	assert.equal(diffCalled, true);
	assert.equal(result.pending.status, "executed");
});

test("re-executing an already-executed action fails", async () => {
	const registry = createRegistry();
	const source = fakeSource();

	const pending = proposePending(registry, {
		actionId: "cmux.openDiff",
		input: { unstaged: true },
		source,
	});

	const fakeCmux = { openDiff: async () => ({ ok: true as const, value: { opened: true } }) };

	await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	const result2 = await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-2",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	assert.equal(result2.ok, false);
	assert.equal(result2.pending.status, "executed");
});

// ─── audit events ───

test("execute emits an audit event on success", async () => {
	const registry = createRegistry();
	const source = fakeSource();

	const pending = proposePending(registry, {
		actionId: "cmux.openDiff",
		input: { unstaged: true },
		source,
	});

	const fakeCmux = { openDiff: async () => ({ ok: true as const, value: { opened: true } }) };

	const { ok, event } = await registry.execute(pending.id, {
		source,
		target: undefined,
		requestId: "req-1",
		now: () => new Date(),
		cmux: fakeCmux as never,
	});

	assert.equal(ok, true);
	assert.equal(event.kind, "action.executed");
	assert.match(event.summary, /cmux diff view/);
});

test("cancel emits an audit event", () => {
	const registry = createRegistry();
	const source = fakeSource();
	const target = fakeTarget();

	const pending = proposePending(registry, {
		actionId: "cmux.sendText",
		input: { text: "test", targetRef: target.ref },
		source,
		target,
	});

	const result = registry.cancel(pending.id);
	assert.equal(result.ok, true);
	assert.ok(result.event);
	assert.equal(result.event?.kind, "action.cancelled");
});

// ─── input validation edge cases ───

test("validateInput for cmux.sendText rejects empty text", () => {
	const registry = createRegistry();
	const action = registry.get("cmux.sendText");
	assert.ok(action);

	const errors = action?.validateInput({ text: "", targetRef: "s:1" });
	assert.notEqual(errors, null);
});

test("validateInput for cmux.sendText accepts valid input", () => {
	const registry = createRegistry();
	const action = registry.get("cmux.sendText");
	assert.ok(action);

	const errors = action?.validateInput({ text: "hello", targetRef: "s:1" });
	assert.equal(errors, null);
});

test("validateInput for cmux.sendText rejects non-object input", () => {
	const registry = createRegistry();
	const action = registry.get("cmux.sendText");
	assert.ok(action);

	const errors = action?.validateInput(null);
	assert.notEqual(errors, null);
});

test("validateInput for cmux.readNotifications accepts optional unread/count input", () => {
	const registry = createRegistry();
	const action = registry.get("cmux.readNotifications");
	assert.ok(action);

	assert.equal(action?.validateInput(undefined), null);
	assert.equal(action?.validateInput({ filter: "unread", countOnly: true }), null);
	assert.notEqual(action?.validateInput({ filter: "dismissed" }), null);
	assert.deepEqual(action?.buildPreview({ filter: "unread", countOnly: true }), { type: "cmux.readNotifications", filter: "unread", countOnly: true });
});

test("validateInput for cmux.openMarkdown requires path", () => {
	const registry = createRegistry();
	const action = registry.get("cmux.openMarkdown");
	assert.ok(action);

	const errors = action?.validateInput({});
	assert.notEqual(errors, null);

	const valid = action?.validateInput({ path: "/tmp/test.md" });
	assert.equal(valid, null);
});

test("validateInput for browser.click requires selector (but handler stubs)", () => {
	const registry = createRegistry();
	const action = registry.get("browser.click");
	assert.ok(action);

	const errors = action?.validateInput({});
	assert.notEqual(errors, null);

	const valid = action?.validateInput({ selector: ".btn" });
	assert.equal(valid, null);
});
