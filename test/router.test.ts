import assert from "node:assert/strict";
import test from "node:test";
import type { AlfredTarget, AlfredTargetAlias } from "../src/contracts/runtime.ts";
import { isSafeRelativeMarkdownPath, resolvePlannerDraftIntent, routeAskBeforeWorld, routeAskWithWorld } from "../src/router/index.ts";

function target(overrides: Partial<AlfredTarget> = {}): AlfredTarget {
	return {
		kind: "cmux-surface",
		ref: "surface:1",
		label: "Power Code",
		surfaceRef: "surface:1",
		workspaceRef: "workspace:1",
		workspaceLabel: "Powerco",
		capabilities: ["surface.read", "surface.send"],
		...overrides,
	};
}

test("router handles confirm and cancel before world lookup", () => {
	assert.deepEqual(routeAskBeforeWorld("confirm"), { kind: "confirm" });
	assert.deepEqual(routeAskBeforeWorld("never mind"), { kind: "cancel" });
	assert.deepEqual(routeAskBeforeWorld("what targets are active"), { kind: "needs_world" });
});

test("router classifies safe answer and direct action intents", () => {
	const targets = [target()];
	assert.deepEqual(routeAskWithWorld({ inputText: "what targets are active", targets }), { kind: "list_targets" });
	assert.deepEqual(routeAskWithWorld({ inputText: "what is current workspace", targets }), { kind: "current_workspace" });
	assert.deepEqual(routeAskWithWorld({ inputText: "what pending actions exist", targets }), { kind: "pending_actions" });
	assert.deepEqual(routeAskWithWorld({ inputText: "open diff", targets }), { kind: "safe_action", actionId: "cmux.openDiff", input: { unstaged: true } });
	assert.deepEqual(routeAskWithWorld({ inputText: "read notifications", targets }), { kind: "safe_action", actionId: "cmux.readNotifications", input: {} });
	assert.deepEqual(routeAskWithWorld({ inputText: "open URL https://example.test/docs", targets }), { kind: "safe_action", actionId: "cmux.openUrl", input: { url: "https://example.test/docs" } });
});

test("router enforces safe relative markdown paths", () => {
	assert.equal(isSafeRelativeMarkdownPath("docs/plans/PLAN.md"), true);
	assert.equal(isSafeRelativeMarkdownPath("notes/README.markdown"), true);
	for (const path of [
		"/tmp/secret.md",
		"~/secret.md",
		"-bad.md",
		"docs/../secret.md",
		"docs/-secret.md",
		"C:\\Users\\secret.md",
		"\\\\server\\share\\secret.md",
		"docs/plain.txt",
	]) {
		assert.equal(isSafeRelativeMarkdownPath(path), false, path);
		const route = routeAskWithWorld({ inputText: `open markdown ${path}`, targets: [target()] });
		assert.equal(route.kind, "clarification");
		assert.equal(route.kind === "clarification" ? route.code : undefined, "unsupported_action");
	}
	assert.deepEqual(routeAskWithWorld({ inputText: "open markdown docs/plans/PLAN.md", targets: [target()] }), { kind: "safe_action", actionId: "cmux.openMarkdown", input: { path: "docs/plans/PLAN.md" } });
});

test("router resolves send-key and draft intents without guessing ambiguous targets", () => {
	const targets = [
		target({ ref: "surface:a", surfaceRef: "surface:a", workspaceRef: "workspace:a" }),
		target({ ref: "surface:b", surfaceRef: "surface:b", workspaceRef: "workspace:b" }),
	];
	const ambiguous = routeAskWithWorld({ inputText: "send key enter to power code", targets });
	assert.equal(ambiguous.kind, "clarification");
	assert.equal(ambiguous.kind === "clarification" ? ambiguous.code : undefined, "target_ambiguous");

	const sendKey = routeAskWithWorld({ inputText: "send key enter to power code", targets, currentWorkspaceRef: "workspace:a" });
	assert.equal(sendKey.kind, "send_key");
	assert.equal(sendKey.kind === "send_key" ? sendKey.intent.target.ref : undefined, "surface:a");
	assert.equal(sendKey.kind === "send_key" ? sendKey.intent.key : undefined, "enter");

	const draft = routeAskWithWorld({ inputText: "tell power code run the focused test", targets, currentWorkspaceRef: "workspace:b" });
	assert.equal(draft.kind, "draft_message");
	assert.equal(draft.kind === "draft_message" ? draft.intent.target.ref : undefined, "surface:b");
	assert.equal(draft.kind === "draft_message" ? draft.intent.message : undefined, "run the focused test");
});

test("planner draft resolution rejects mismatched target ref and name", () => {
	const targets = [
		target({ ref: "surface:a", surfaceRef: "surface:a", label: "Power Code" }),
		target({ ref: "surface:b", surfaceRef: "surface:b", label: "Docs Bot" }),
	];
	const resolved = resolvePlannerDraftIntent({ kind: "draft_message", targetRef: "surface:a", targetName: "Docs Bot", message: "hello" }, targets);
	assert.equal(resolved.ok, false);
	assert.equal(resolved.error?.code, "target_ambiguous");
});

test("router resolves aliases and detects stale aliases", () => {
	const targets = [
		target({ ref: "surface:local", surfaceRef: "surface:local", workspaceRef: "workspace:local", label: "Local Bot" }),
		target({ ref: "surface:global", surfaceRef: "surface:global", workspaceRef: "workspace:global", label: "Global Bot" }),
	];
	const aliases: AlfredTargetAlias[] = [
		{ id: "alias_1", alias: "bot", normalizedAlias: "bot", scope: "global", targetRef: "surface:global", targetKind: "cmux-surface", targetLabel: "Global Bot", createdAt: "2026-06-19T22:00:00.000Z", updatedAt: "2026-06-19T22:00:00.000Z", createdBy: { kind: "cli", id: "cli" } },
		{ id: "alias_2", alias: "bot", normalizedAlias: "bot", scope: "workspace", targetRef: "surface:local", targetKind: "cmux-surface", targetLabel: "Local Bot", workspaceRef: "workspace:local", createdAt: "2026-06-19T22:00:00.000Z", updatedAt: "2026-06-19T22:00:00.000Z", createdBy: { kind: "cli", id: "cli" } },
		{ id: "alias_3", alias: "stale", normalizedAlias: "stale", scope: "global", targetRef: "surface:missing", targetKind: "cmux-surface", targetLabel: "Missing", createdAt: "2026-06-19T22:00:00.000Z", updatedAt: "2026-06-19T22:00:00.000Z", createdBy: { kind: "cli", id: "cli" } },
	];
	const local = routeAskWithWorld({ inputText: "tell bot hello", targets, aliases, currentWorkspaceRef: "workspace:local" });
	assert.equal(local.kind, "draft_message");
	assert.equal(local.kind === "draft_message" ? local.intent.target.ref : undefined, "surface:local");
	const global = routeAskWithWorld({ inputText: "tell bot hello", targets, aliases, currentWorkspaceRef: "workspace:other" });
	assert.equal(global.kind, "draft_message");
	assert.equal(global.kind === "draft_message" ? global.intent.target.ref : undefined, "surface:global");
	const stale = routeAskWithWorld({ inputText: "tell stale hello", targets, aliases });
	assert.equal(stale.kind, "clarification");
	assert.equal(stale.kind === "clarification" ? stale.code : undefined, "target_not_found");
});

test("router classifies browser, unread notification, and alias management intents", () => {
	const targets = [target()];
	assert.deepEqual(routeAskWithWorld({ inputText: "open browser https://example.test/path", targets }), { kind: "safe_action", actionId: "cmux.openBrowserSurface", input: { url: "https://example.test/path" } });
	assert.deepEqual(routeAskWithWorld({ inputText: "how many unread notifications", targets }), { kind: "safe_action", actionId: "cmux.readNotifications", input: { filter: "unread", countOnly: true } });
	assert.deepEqual(routeAskWithWorld({ inputText: "show unread notifications", targets }), { kind: "safe_action", actionId: "cmux.readNotifications", input: { filter: "unread" } });
	assert.deepEqual(routeAskWithWorld({ inputText: "remember power code as main pi", targets }), { kind: "remember_alias", targetPhrase: "power code", alias: "main pi", scope: "workspace" });
	assert.deepEqual(routeAskWithWorld({ inputText: "list aliases", targets }), { kind: "list_aliases" });
	assert.deepEqual(routeAskWithWorld({ inputText: "forget alias main pi", targets }), { kind: "forget_alias", alias: "main pi", scope: undefined });
});
