import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantWorkspaces } from "../src/alfred-2/context.ts";

test("workspace selection prefers remembered recent workspaces over stale cmux order", () => {
	const workspaces = [
		{ ref: "workspace:1", title: "Old", index: 0 },
		{ ref: "workspace:2", title: "Recent", index: 1 },
		{ ref: "workspace:3", title: "Also Recent", index: 2 },
	] as any[];
	const selected = selectRelevantWorkspaces(workspaces, 2, {
		workspaces: {
			"workspace:1": { title: "Old", lastSeenAt: "2026-01-01T00:00:00.000Z" },
			"workspace:2": { title: "Recent", lastSeenAt: "2026-07-01T00:00:00.000Z" },
			"workspace:3": { title: "Also Recent", lastSeenAt: "2026-07-02T00:00:00.000Z" },
		},
	});
	assert.deepEqual(selected.map((workspace) => workspace.ref), ["workspace:2", "workspace:3"]);
});

test("workspace selection always keeps the selected workspace relevant", () => {
	const workspaces = [
		{ ref: "workspace:1", title: "Selected", selected: true, index: 0 },
		{ ref: "workspace:2", title: "Recent", index: 1, latest_submitted_at: "2026-07-02T00:00:00.000Z" },
	] as any[];
	const selected = selectRelevantWorkspaces(workspaces, 1, { workspaces: {} });
	assert.deepEqual(selected.map((workspace) => workspace.ref), ["workspace:1"]);
});
