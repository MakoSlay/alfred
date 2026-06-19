import assert from "node:assert/strict";
import test from "node:test";
import {
	ALFRED_CONTRACT_VERSION,
	isPrivilegedCapability,
	sourceHasCapabilities,
} from "../src/contracts/runtime.ts";
import {
	cliSource,
	powerCodeDraftRequest,
	powerCodeDraftResponse,
} from "../src/testing/fixtures.ts";

test("runtime contract version is exported", () => {
	assert.equal(ALFRED_CONTRACT_VERSION, "0.1.0");
});

test("Powerco draft fixture remains a pending draft and not a send", () => {
	const request = powerCodeDraftRequest();
	const response = powerCodeDraftResponse();

	assert.equal(request.source.kind, "pi-command");
	assert.equal(request.context?.visibleTargets?.[0]?.label, "π - Power Code");
	assert.equal(response.ok, true);
	assert.equal(response.pendingDraft?.status, "pending");
	assert.equal(response.proposedActions[0]?.kind, "draft");
	assert.equal(response.proposedActions[0]?.status, "pending_confirmation");
	assert.equal(response.events[0]?.kind, "draft.created");
	assert.equal(response.events[0]?.retention.policy, "session");
});

test("capability helpers distinguish privileged sends from read-only CLI", () => {
	const source = cliSource();

	assert.equal(isPrivilegedCapability("surface.send"), true);
	assert.equal(isPrivilegedCapability("world.read"), false);
	assert.equal(sourceHasCapabilities(source, ["world.read"]), true);
	assert.equal(sourceHasCapabilities(source, ["surface.send"]), false);
});
