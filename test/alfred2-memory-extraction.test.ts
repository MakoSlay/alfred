import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTurn, createSessionMemory } from "../src/alfred-2/memory.ts";
import {
	containsForbiddenMemoryContent,
	extractReviewedMemoryCandidates,
	MemoryCandidateError,
	ReviewedMemoryCandidateStore,
	validateReviewedMemoryWrite,
} from "../src/alfred-2/memory/extraction.ts";
import { createProfileStore, ProfileMemoryConflictError } from "../src/alfred-2/profile.ts";

const timestamp = "2026-07-14T10:00:00.000Z";

function sessionTurn(id: string, userText: string) {
	const memory = createSessionMemory();
	addTurn(memory, {
		id,
		createdAt: timestamp,
		updatedAt: timestamp,
		userText,
		finalSpeech: "Assistant output must not be inspected.",
		toolsUsed: ["read_file"],
		workspaceHint: "workspace:1",
		shortOutcome: "Tool output must not be inspected.",
	}, undefined, { requestId: `request-${id}`, turnId: id, timestamp });
	return memory.turns[0]!;
}

test("reviewed extraction uses only explicitly selected current-session user text", () => {
	const selected = sessionTurn("turn-selected", "I prefer concise status updates.");
	const unselected = sessionTurn("turn-unselected", "My name is Unselected.");
	const batch = extractReviewedMemoryCandidates({
		requestId: "review-request",
		sessionId: "session-test",
		turnIds: [selected.id],
		turns: [selected, unselected],
		profileRecords: [],
		now: new Date(timestamp),
	});
	assert.equal(batch.ephemeral, true);
	assert.equal(batch.requestId, "review-request");
	assert.equal(batch.candidates.length, 1);
	assert.equal(batch.candidates[0]?.key, "preference_concise_status_updates");
	assert.equal(batch.candidates[0]?.value, "concise status updates");
	assert.equal(batch.candidates[0]?.category, "preference");
	assert.equal(batch.candidates[0]?.source.sessionId, "session-test");
	assert.equal(batch.candidates[0]?.source.sessionRecordId, selected.id);
	assert.equal(batch.candidates[0]?.source.turnId, selected.id);
	assert.equal(batch.candidates[0]?.batchId, batch.batchId);
	assert.equal(batch.candidates[0]?.reviewRequestId, batch.requestId);
	assert.equal(batch.candidates[0]?.source.userText, "I prefer concise status updates");
	assert.doesNotMatch(JSON.stringify(batch), /Assistant output|Tool output|Unselected/);
});

test("reviewed extraction supports narrow explicit identity and subject preference forms", () => {
	const identity = sessionTurn("turn-name", "Please call me Ada Lovelace.");
	const preference = sessionTurn("turn-theme", "My preferred dashboard theme is estate.");
	const batch = extractReviewedMemoryCandidates({
		requestId: "review-request",
		sessionId: "session-test",
		turnIds: [identity.id, preference.id],
		turns: [identity, preference],
		profileRecords: [],
		now: new Date(timestamp),
	});
	assert.deepEqual(batch.candidates.map(({ key, value, category }) => ({ key, value, category })), [
		{ key: "preferred_name", value: "Ada Lovelace", category: "identity" },
		{ key: "preferred_dashboard_theme", value: "estate", category: "preference" },
	]);
});

test("secret or sensitive selected turns are excluded as a whole without echoing text", () => {
	const secret = sessionTurn("turn-secret", "I prefer dark mode. My API key is sk-abcdefghijklmnop1234.");
	const sensitive = sessionTurn("turn-sensitive", "I prefer short replies about my medical condition.");
	const batch = extractReviewedMemoryCandidates({
		requestId: "review-request",
		sessionId: "session-test",
		turnIds: [secret.id, sensitive.id],
		turns: [secret, sensitive],
		profileRecords: [],
		now: new Date(timestamp),
	});
	assert.deepEqual(batch.candidates, []);
	assert.deepEqual(batch.excluded, [
		{ turnId: secret.id, reason: "secret_or_sensitive" },
		{ turnId: sensitive.id, reason: "secret_or_sensitive" },
	]);
	assert.throws(() => extractReviewedMemoryCandidates({ requestId: "review-request", sessionId: "session-test", turnIds: [secret.id, "missing-turn"], turns: [secret], profileRecords: [], now: new Date(timestamp) }), (cause) => cause instanceof MemoryCandidateError && cause.code === "source_not_found");
	assert.doesNotMatch(JSON.stringify(batch), /sk-|medical condition|dark mode/i);
	assert.equal(containsForbiddenMemoryContent("password=hunter2"), true);
	assert.equal(containsForbiddenMemoryContent("I prefer concise replies"), false);
});

test("the complete retained turn is scanned before bounded evidence is returned", () => {
	const turn = sessionTurn("turn-long-secret", `I prefer concise replies. ${"x".repeat(260)} My password is hunter2.`);
	const batch = extractReviewedMemoryCandidates({ requestId: "review-request", sessionId: "session-test", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	assert.deepEqual(batch.candidates, []);
	assert.deepEqual(batch.excluded, [{ turnId: turn.id, reason: "secret_or_sensitive" }]);
	assert.doesNotMatch(JSON.stringify(batch), /hunter2|password/i);
});

test("temporary task preferences are not proposed as durable memory", () => {
	const turn = sessionTurn("turn-temporary", "I prefer verbose output for this task.");
	const batch = extractReviewedMemoryCandidates({ requestId: "review-request", sessionId: "session-test", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	assert.deepEqual(batch.candidates, []);
	assert.deepEqual(batch.excluded, [{ turnId: turn.id, reason: "no_supported_fact" }]);
});

test("existing keys are visible conflicts and detached from profile state", () => {
	const turn = sessionTurn("turn-conflict", "My preferred theme is cave.");
	const existing = {
		id: "profile-theme",
		kind: "profile" as const,
		key: "preferred_theme",
		value: "estate",
		category: "preference" as const,
		createdAt: timestamp,
		updatedAt: timestamp,
		provenance: { source: "manual" as const, timestamp },
	};
	const batch = extractReviewedMemoryCandidates({ requestId: "review-request", sessionId: "session-test", turnIds: [turn.id], turns: [turn], profileRecords: [existing], now: new Date(timestamp) });
	assert.equal(batch.candidates[0]?.conflict?.record.id, existing.id);
	batch.candidates[0]!.conflict!.record.value = "mutated";
	assert.equal(existing.value, "estate");
});

test("candidate batches are request-scoped, expiring, consumable, and clearable", () => {
	const store = new ReviewedMemoryCandidateStore();
	const turn = sessionTurn("turn-store", "I prefer concise replies.");
	const batch = store.create({ requestId: "request-a", sessionId: "session-a", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	const candidate = batch.candidates[0]!;
	assert.throws(() => store.get(batch.batchId, candidate.id, "session-b", new Date(timestamp)), (cause) => cause instanceof MemoryCandidateError && cause.code === "candidate_session_mismatch");
	assert.equal(store.consume(batch.batchId, candidate.id, "session-a", new Date(timestamp)).id, candidate.id);
	assert.throws(() => store.get(batch.batchId, candidate.id, "session-a", new Date(timestamp)), (cause) => cause instanceof MemoryCandidateError && cause.code === "candidate_not_found");

	const expiring = store.create({ requestId: "request-c", sessionId: "session-a", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	assert.throws(() => store.get(expiring.batchId, expiring.candidates[0]!.id, "session-a", new Date("2026-07-14T10:16:00.000Z")), (cause) => cause instanceof MemoryCandidateError && cause.code === "candidate_expired");
	const clearable = store.create({ requestId: "request-d", sessionId: "session-a", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	assert.equal(clearable.candidates.length, 1);
	assert.equal(store.clear(), 1);
});

test("extraction enforces authoritative selection and candidate bounds", () => {
	const turn = sessionTurn("turn-bounds", Array.from({ length: 15 }, (_, index) => `I prefer option ${index}.`).join(" "));
	const batch = extractReviewedMemoryCandidates({ requestId: "request-bounds", sessionId: "session-test", turnIds: [turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) });
	assert.equal(batch.candidates.length, 10);
	assert.throws(() => extractReviewedMemoryCandidates({ requestId: "request-empty", sessionId: "session-test", turnIds: [], turns: [turn], profileRecords: [], now: new Date(timestamp) }), /between 1 and 10/);
	assert.throws(() => extractReviewedMemoryCandidates({ requestId: "request-duplicate", sessionId: "session-test", turnIds: [turn.id, turn.id], turns: [turn], profileRecords: [], now: new Date(timestamp) }), /unique/);
});

test("credential and sensitive-data gates reject common dangerous forms", () => {
	for (const text of [
		"Authorization: Basic dXNlcjpwYXNz",
		"xoxb-1234567890-abcdefghijklmnop",
		"github_pat_abcdefghijklmnopqrstuvwxyz123456",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123",
		"https://user:password@example.com",
		"recovery code 1234-5678",
		"wifi secret hunter2",
		"My phone is +1 (403) 555-0123",
		"My date of birth is July 1, 1990",
		"My SSN is 123-45-6789",
		"I have cancer",
		"I am Muslim",
		"gender identity",
		"criminal record",
		"AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
	]) assert.equal(containsForbiddenMemoryContent(text), true, text);
});

test("accepted reviewed writes are create-only, revision-safe, and never replace manual facts", () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-reviewed-memory-"));
	try {
		const file = join(directory, "profile.json");
		const first = createProfileStore(file);
		const manual = first.rememberFact("preferred_theme", "estate", "preference");
		const second = createProfileStore(file);
		assert.throws(() => second.createProfileMemoryIfAbsent(
			{ key: "Preferred_Theme", value: "cave", category: "preference" },
			{ source: "conversation", sourceId: "candidate-1", requestId: "review-request", turnId: "turn-1", timestamp },
		), ProfileMemoryConflictError);
		assert.equal(createProfileStore(file).recallFact("preferred_theme")[0]?.value, manual.value);

		const accepted = second.createProfileMemoryIfAbsent(
			{ key: "preferred_status_style", value: "concise", category: "preference" },
			{ source: "conversation", sourceId: "candidate-2", requestId: "review-request", turnId: "turn-2", timestamp: "2026-07-14T10:01:00.000Z", confidence: 0.94 },
		);
		assert.equal(accepted.provenance.source, "conversation");
		assert.equal(accepted.provenance.requestId, "review-request");
		assert.equal(accepted.provenance.turnId, "turn-2");
		assert.equal(accepted.source, "observed");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("candidate edits remain restricted to safe preference and identity writes", () => {
	assert.deepEqual(validateReviewedMemoryWrite({ key: " Preferred_Name ", value: " Ada ", category: "identity" }), { key: "preferred_name", value: "Ada", category: "identity" });
	assert.throws(() => validateReviewedMemoryWrite({ key: "bad key", value: "safe", category: "preference" }), /lowercase letters/);
	assert.throws(() => validateReviewedMemoryWrite({ key: "token", value: "Bearer secret-value", category: "preference" }), /secret or sensitive/);
	assert.throws(() => validateReviewedMemoryWrite({ key: "medical_condition", value: "private", category: "identity" }), /secret or sensitive/);
	assert.throws(() => validateReviewedMemoryWrite({ key: "phone", value: "+1 (403) 555-0123", category: "identity" }), /secret or sensitive/);
	assert.throws(() => validateReviewedMemoryWrite({ key: "birthday", value: "date of birth: July 1, 1990", category: "identity" }), /secret or sensitive/);
});
