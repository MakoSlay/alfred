import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPlannerInput,
	extractJsonObjectCandidates,
	parsePlannerIntent,
	plannerInputLimit,
	sanitizePlannerText,
	validatePlannerResult,
} from "../src/planner/index.ts";
import { piCommandSource, powerCodeDraftRequest, powerCodeTarget } from "../src/testing/fixtures.ts";

const sanitizedSummary = { value: "redacted request", redaction: { status: "not_needed" as const } };

test("planner parser accepts strict draft_message JSON", () => {
	const result = parsePlannerIntent('{"kind":"draft_message","targetRef":"surface:42","message":"Please list removable files."}', sanitizedSummary);

	assert.equal(result.ok, true);
	assert.equal(result.intent?.kind, "draft_message");
	if (result.intent?.kind === "draft_message") {
		assert.equal(result.intent.targetRef, "surface:42");
		assert.equal(result.intent.message, "Please list removable files.");
	}
});

test("planner parser extracts draft_message from prose-wrapped JSON", () => {
	const content = 'Very good, sir. {"kind":"draft_message","targetName":"Power Code","message":"Let me know what files I can delete now."}';
	const result = parsePlannerIntent(content, sanitizedSummary);

	assert.equal(result.ok, true);
	assert.equal(result.intent?.kind, "draft_message");
	if (result.intent?.kind === "draft_message") {
		assert.equal(result.intent.targetName, "Power Code");
		assert.equal(result.intent.message, "Let me know what files I can delete now.");
	}
	assert.equal(extractJsonObjectCandidates(content).some((candidate) => candidate.includes("draft_message")), true);
});

test("planner parser rejects direct-send-like output", () => {
	const result = parsePlannerIntent('{"kind":"send","targetRef":"surface:42","message":"ship it"}', sanitizedSummary);

	assert.equal(result.ok, false);
	assert.equal(result.errors?.[0]?.code, "unsupported_action");
	assert.match(result.errors?.[0]?.message ?? "", /Direct send/i);
});

test("planner result validation rejects malformed draft or direct-send intents", () => {
	const direct = validatePlannerResult({ ok: true, intent: { kind: "workspace_send", targetRef: "workspace:9", message: "run" } }, sanitizedSummary);
	assert.equal(direct.ok, false);
	assert.equal(direct.errors?.[0]?.code, "unsupported_action");

	const missingTarget = validatePlannerResult({ ok: true, intent: { kind: "draft_message", message: "run" } }, sanitizedSummary);
	assert.equal(missingTarget.ok, false);
	assert.equal(missingTarget.errors?.[0]?.code, "target_not_found");
});

test("planner input redacts and limits request text without transcript context", () => {
	const request = powerCodeDraftRequest();
	request.input.text = `please use token=ghp_abcdefghijklmnopqrstuvwxyz and ${"x".repeat(200)} now`;
	request.policy = { ...request.policy, maxTranscriptChars: 80 };
	const input = buildPlannerInput(request, piCommandSource(), [powerCodeTarget({ metadata: { transcriptPath: "/tmp/raw-session.log", normalizedTitle: "Power Code" } })]);

	assert.equal(input.maxInputChars, 80);
	assert.equal(input.inputText.length <= 80, true);
	assert.equal(input.inputText.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
	assert.equal(input.inputText.includes("[redacted:secret]"), true);
	assert.equal(input.visibleTargets[0]?.metadata, undefined);
	assert.equal(input.source.sessionId, undefined);
	assert.deepEqual(input.allowedCapabilities, piCommandSource().capabilities);
});

test("planner sanitizer records redaction and hard cap", () => {
	const sanitized = sanitizePlannerText("password: swordfish " + "a".repeat(20), 24);

	assert.equal(sanitized.value.length <= 24, true);
	assert.equal(sanitized.value.includes("swordfish"), false);
	assert.equal(sanitized.redaction.status, "redacted");
	assert.equal(sanitized.redaction.rulesApplied?.includes("labelled-secret"), true);
});

test("planner input max treats policy max as upper-bound compatibility field", () => {
	assert.equal(plannerInputLimit(undefined), 4000);
	assert.equal(plannerInputLimit(12_000), 4000);
	assert.equal(plannerInputLimit(120), 120);
});
