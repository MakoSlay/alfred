import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { addTurn, createSessionMemory, getSessionMemoryRecords } from "../src/alfred-2/memory.ts";
import { isMemoryRecord, type KnowledgeSourceRecord, type ProfileMemoryRecord, type SessionMemoryRecord } from "../src/alfred-2/memory-types.ts";
import { createKnowledgeStore } from "../src/alfred-2/knowledge.ts";
import { recallMemory } from "../src/alfred-2/memory/recall.ts";
import { createProfileStore } from "../src/alfred-2/profile.ts";
import { startAlfred2 } from "../src/alfred-2/server.ts";
import { runToolLoop } from "../src/alfred-2/tool-loop.ts";
import { recallMemory as recallMemoryTool } from "../src/alfred-2/tools/profile.ts";

function temporaryProfile(): { directory: string; file: string } {
	const directory = mkdtempSync(join(tmpdir(), "alfred2-profile-"));
	return { directory, file: join(directory, "profile.json") };
}

test("memory taxonomy records discriminate profile, session, and knowledge", () => {
	const provenance = { source: "manual" as const, timestamp: "2026-07-14T10:00:00.000Z" };
	const profile: ProfileMemoryRecord = { id: "profile-1", kind: "profile", key: "tone", value: "concise", category: "preference", createdAt: provenance.timestamp, updatedAt: provenance.timestamp, provenance };
	const session: SessionMemoryRecord = { id: "session-1", kind: "session", ephemeral: true, userText: "hello", finalSpeech: "hello, sir", toolsUsed: [], workspaceHint: "", shortOutcome: "answered", createdAt: provenance.timestamp, updatedAt: provenance.timestamp, provenance: { source: "conversation", timestamp: provenance.timestamp } };
	const knowledge: KnowledgeSourceRecord = { id: "knowledge-1", kind: "knowledge", title: "Notes", sourceType: "note", status: "metadata_only", createdAt: provenance.timestamp, updatedAt: provenance.timestamp, provenance: { source: "import", timestamp: provenance.timestamp } };

	assert.equal(isMemoryRecord(profile), true);
	assert.equal(isMemoryRecord(session), true);
	assert.equal(isMemoryRecord(knowledge), true);
	assert.equal(isMemoryRecord({ ...profile, category: "knowledge" }), false);
	assert.equal(isMemoryRecord({ id: "broken", kind: "profile", createdAt: provenance.timestamp, updatedAt: provenance.timestamp, provenance }), false);
	assert.equal(isMemoryRecord({ ...knowledge, location: 42 }), false);
	assert.equal(isMemoryRecord({ ...knowledge, sizeBytes: "large" }), false);
	assert.equal(isMemoryRecord({ ...knowledge, error: false }), false);
	assert.deepEqual([profile, session, knowledge].map((record) => record.kind), ["profile", "session", "knowledge"]);
});

test("legacy profile loads without rewriting and maps to stable IDs and provenance", () => {
	const { directory, file } = temporaryProfile();
	const legacy = JSON.stringify({
		facts: [
			{ key: "response_style", value: "concise", category: "preference", addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", source: "user" },
			{ key: "current_project", value: "Alfred", category: "context", addedAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z", source: "observed" },
		],
		updatedAt: "2026-02-02T00:00:00.000Z",
	}, null, 2);
	writeFileSync(file, legacy, "utf8");

	try {
		const first = createProfileStore(file).loadProfile();
		assert.equal(readFileSync(file, "utf8"), legacy, "loading must not silently rewrite a legacy profile");
		assert.equal(first.facts[0]?.kind, "profile");
		assert.equal(first.facts[0]?.provenance.source, "manual");
		assert.equal(first.facts[1]?.provenance.source, "conversation");
		assert.equal(first.facts[0]?.createdAt, first.facts[0]?.addedAt);

		const second = createProfileStore(file).loadProfile();
		assert.equal(second.facts[0]?.id, first.facts[0]?.id);
		assert.equal(second.facts[1]?.id, first.facts[1]?.id);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("duplicate legacy facts receive distinct stable IDs across loads", () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, JSON.stringify({
		facts: [
			{ key: "duplicate", value: "same", category: "note", addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: "user" },
			{ key: "duplicate", value: "same", category: "note", addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: "user" },
		],
		updatedAt: "2026-01-01T00:00:00.000Z",
	}), "utf8");
	try {
		const first = createProfileStore(file).loadProfile().facts.map((fact) => fact.id);
		const second = createProfileStore(file).loadProfile().facts.map((fact) => fact.id);
		assert.equal(new Set(first).size, 2);
		assert.deepEqual(second, first);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy extension fields survive the first canonical write", () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, JSON.stringify({
		customRoot: { owner: "user" },
		facts: [{ key: "theme", value: "estate", category: "preference", addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: "user", customFact: "keep-me", provenance: { source: "manual", timestamp: "2026-01-01T00:00:00.000Z", futureField: "keep-provenance" } }],
		updatedAt: "2026-01-01T00:00:00.000Z",
	}), "utf8");
	try {
		createProfileStore(file).rememberProfileMemory(
			{ key: "tone", value: "concise", category: "preference" },
			{ source: "manual", timestamp: "2026-07-14T10:00:00.000Z" },
		);
		const persisted = JSON.parse(readFileSync(file, "utf8")) as { customRoot?: unknown; facts: Array<{ customFact?: string; provenance?: { futureField?: string } }> };
		assert.deepEqual(persisted.customRoot, { owner: "user" });
		assert.equal(persisted.facts[0]?.customFact, "keep-me");
		assert.equal(persisted.facts[0]?.provenance?.futureField, "keep-provenance");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("corrupt profiles are never treated as empty or overwritten by a later write", () => {
	const { directory, file } = temporaryProfile();
	const corrupt = "{ broken legacy profile";
	writeFileSync(file, corrupt, "utf8");
	try {
		const store = createProfileStore(file);
		assert.throws(() => store.loadProfile(), /existing file was left untouched/);
		assert.throws(() => store.rememberFact("theme", "estate"), /existing file was left untouched/);
		assert.equal(readFileSync(file, "utf8"), corrupt);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("profile persistence errors are observable and roll back cached mutations", () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, JSON.stringify({ facts: [], updatedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
	try {
		const store = createProfileStore(file);
		assert.equal(store.loadProfile().facts.length, 0);
		rmSync(file);
		mkdirSync(file);
		assert.throws(() => store.rememberFact("theme", "estate"), /Could not (?:load|persist) profile/);
		assert.throws(() => store.loadProfile(), /Could not load profile/, "failed writes must not be served from stale cache");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("profile writes use private directory and file permissions", () => {
	const { directory, file } = temporaryProfile();
	try {
		const nestedDirectory = join(directory, "private-profile");
		const nestedFile = join(nestedDirectory, "profile.json");
		createProfileStore(nestedFile).rememberFact("theme", "estate");
		assert.equal(statSync(nestedDirectory).mode & 0o777, 0o700);
		assert.equal(statSync(nestedFile).mode & 0o777, 0o600);
		chmodSync(nestedFile, 0o644);
		createProfileStore(nestedFile).rememberFact("tone", "concise");
		assert.equal(statSync(nestedFile).mode & 0o777, 0o600, "replacement must not retain broad permissions");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("fresh writes merge changes committed by another profile store", () => {
	const { directory, file } = temporaryProfile();
	try {
		const first = createProfileStore(file);
		const second = createProfileStore(file);
		first.loadProfile();
		second.loadProfile();
		first.rememberFact("first", "one");
		second.rememberFact("second", "two");
		assert.deepEqual(createProfileStore(file).loadProfile().facts.map((fact) => fact.key), ["first", "second"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("profile reads observe changes committed by another store", () => {
	const { directory, file } = temporaryProfile();
	try {
		const reader = createProfileStore(file);
		assert.deepEqual(reader.recallFact(), []);
		createProfileStore(file).rememberFact("theme", "estate");
		assert.deepEqual(reader.recallFact().map((fact) => fact.key), ["theme"]);
		assert.match(reader.formatProfileForContext(), /theme: estate/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stale direct saves fail instead of overwriting a newer profile revision", () => {
	const { directory, file } = temporaryProfile();
	try {
		const stale = createProfileStore(file);
		stale.loadProfile();
		createProfileStore(file).rememberFact("newer", "committed");
		assert.throws(() => stale.saveProfile(), /Profile changed on disk/);
		assert.deepEqual(createProfileStore(file).loadProfile().facts.map((fact) => fact.key), ["newer"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("duplicate persisted profile IDs are rejected as corrupt", () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, JSON.stringify({
		facts: [
			{ id: "profile-duplicate", kind: "profile", key: "one", value: "1", category: "note", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", addedAt: "2026-01-01T00:00:00.000Z", source: "user", provenance: { source: "manual", timestamp: "2026-01-01T00:00:00.000Z" } },
			{ id: "profile-duplicate", kind: "profile", key: "two", value: "2", category: "note", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", addedAt: "2026-01-01T00:00:00.000Z", source: "user", provenance: { source: "manual", timestamp: "2026-01-01T00:00:00.000Z" } },
		],
		updatedAt: "2026-01-01T00:00:00.000Z",
	}), "utf8");
	try {
		assert.throws(() => createProfileStore(file).loadProfile(), /duplicate profile memory id/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("profile writes capture provenance, preserve IDs on update, round trip, and delete by ID", () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		const created = store.rememberProfileMemory(
			{ key: "response_style", value: "concise", category: "preference" },
			{ source: "manual", sourceId: "dashboard", requestId: "req-manual", timestamp: "2026-07-14T10:00:00.000Z" },
		);
		assert.match(created.id, /^profile-[a-f0-9]{20}$/);
		assert.equal(created.provenance.requestId, "req-manual");
		assert.equal(created.source, "user");

		const updated = store.rememberProfileMemory(
			{ key: "response_style", value: "brief", category: "preference" },
			{ source: "tool", sourceId: "tool-7", requestId: "req-tool", turnId: "turn-2", timestamp: "2026-07-14T10:05:00.000Z" },
		);
		assert.equal(updated.id, created.id);
		assert.equal(updated.createdAt, created.createdAt);
		assert.equal(updated.updatedAt, "2026-07-14T10:05:00.000Z");
		assert.equal(updated.provenance.source, "tool");
		assert.equal(updated.provenance.turnId, "turn-2");

		const reloaded = createProfileStore(file).loadProfile();
		assert.equal(reloaded.facts[0]?.id, created.id);
		assert.equal(reloaded.facts[0]?.value, "brief");
		assert.equal(reloaded.facts[0]?.provenance.sourceId, "tool-7");
		assert.equal(reloaded.facts[0]?.addedAt, created.addedAt);
		assert.equal(reloaded.facts[0]?.source, "user");
		assert.equal(createProfileStore(file).forgetProfileMemory(created.id), true);
		assert.equal(createProfileStore(file).loadProfile().facts.length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stable-ID profile edits preserve identity/extensions and reject stale or colliding writes", () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		const first = store.rememberProfileMemory(
			{ key: "theme", value: "estate", category: "preference" },
			{ source: "manual", timestamp: "2026-07-14T10:00:00.000Z" },
		);
		store.rememberProfileMemory(
			{ key: "tone", value: "concise", category: "preference" },
			{ source: "manual", timestamp: "2026-07-14T10:01:00.000Z" },
		);
		const persisted = JSON.parse(readFileSync(file, "utf8")) as { facts: Array<Record<string, unknown>> };
		persisted.facts[0]!.extension = "preserve";
		writeFileSync(file, JSON.stringify(persisted), "utf8");
		const current = createProfileStore(file).loadProfile().facts.find((fact) => fact.id === first.id)!;
		const updated = createProfileStore(file).updateProfileMemory(
			first.id,
			{ key: "visual_theme", value: "cave", category: "context" },
			current.updatedAt,
			{ source: "manual", sourceId: "dashboard", timestamp: "2026-07-14T10:05:00.000Z" },
		)!;
		assert.equal(updated.id, first.id);
		assert.equal(updated.createdAt, first.createdAt);
		assert.equal(updated.addedAt, first.addedAt);
		assert.equal(updated.extension, "preserve");
		assert.equal(updated.key, "visual_theme");
		assert.equal(updated.updatedAt, "2026-07-14T10:05:00.000Z");
		assert.throws(() => createProfileStore(file).updateProfileMemory(first.id, { value: "stale" }, current.updatedAt, { source: "manual", timestamp: "2026-07-14T10:06:00.000Z" }), /changed since/);
		assert.throws(() => createProfileStore(file).updateProfileMemory(first.id, { key: "tone" }, updated.updatedAt, { source: "manual", timestamp: "2026-07-14T10:06:00.000Z" }), /already uses/);
		assert.throws(() => createProfileStore(file).updateProfileMemory(first.id, { value: " " }, updated.updatedAt, { source: "manual", timestamp: "2026-07-14T10:06:00.000Z" }), /value is required/);
		assert.equal(createProfileStore(file).updateProfileMemory("missing", { value: "x" }, updated.updatedAt, { source: "manual", timestamp: "2026-07-14T10:06:00.000Z" }), null);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("profile revisions advance monotonically and reject same-millisecond stale edits", () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		const timestamp = "2026-07-14T10:00:00.000Z";
		const created = store.rememberProfileMemory(
			{ key: "theme", value: "estate", category: "preference" },
			{ source: "manual", timestamp },
		);
		const updated = store.rememberProfileMemory(
			{ key: "theme", value: "cave" },
			{ source: "tool", timestamp },
		);
		assert.equal(updated.updatedAt, "2026-07-14T10:00:00.001Z");
		assert.equal(updated.provenance.timestamp, updated.updatedAt);
		assert.throws(
			() => store.updateProfileMemory(created.id, { value: "stale" }, created.updatedAt, { source: "manual", timestamp }),
			/changed since/,
		);
		const backwards = store.updateProfileMemory(created.id, { value: "newest" }, updated.updatedAt, { source: "manual", timestamp: "2026-01-01T00:00:00.000Z" })!;
		assert.equal(backwards.updatedAt, "2026-07-14T10:00:00.002Z");
		assert.equal(backwards.provenance.timestamp, backwards.updatedAt);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("updates without a category preserve the existing profile category", () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		store.rememberProfileMemory(
			{ key: "theme", value: "estate", category: "preference" },
			{ source: "manual", timestamp: "2026-07-14T10:00:00.000Z" },
		);
		const updated = store.rememberProfileMemory(
			{ key: "theme", value: "cave" },
			{ source: "tool", timestamp: "2026-07-14T10:05:00.000Z" },
		);
		assert.equal(updated.category, "preference");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("case-distinct profile keys receive distinct stable IDs even at the same timestamp", () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		const provenance = { source: "manual" as const, timestamp: "2026-07-14T10:00:00.000Z" };
		const upper = store.rememberProfileMemory({ key: "Theme", value: "estate" }, provenance);
		const lower = store.rememberProfileMemory({ key: "theme", value: "cave" }, provenance);
		assert.notEqual(upper.id, lower.id);
		assert.equal(new Set(store.loadProfile().facts.map((fact) => fact.id)).size, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("remember tool captures request and turn provenance in the injected profile store", async () => {
	const { directory, file } = temporaryProfile();
	try {
		const store = createProfileStore(file);
		await runToolLoop({
			llmClient: createFakeLlmClient([
				'{"tool":"remember","key":"theme","value":"estate","category":"preference"}',
				'{"speech":"Remembered, sir."}',
			]),
			userText: "remember that I prefer the estate theme",
			systemContext: "WORKSPACES: (cmux unavailable)",
			requestId: "req-remember-tool",
			turnId: "turn-remember-tool",
			sessionId: "session-memory-test",
			profileStore: store,
			speakAcknowledgements: false,
		});
		const fact = store.loadProfile().facts[0];
		assert.equal(fact?.provenance.source, "tool");
		assert.equal(fact?.provenance.requestId, "req-remember-tool");
		assert.equal(fact?.provenance.turnId, "turn-remember-tool");
		assert.match(fact?.provenance.sourceId ?? "", /^tool-/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("unified recall sanitizes profile-store failures before returning them to the model", () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, "{ broken", "utf8");
	try {
		const result = recallMemoryTool(
			{ tool: "recall", query: "theme" },
			{ requestId: "req-recall", toolCallId: "tool-recall", risk: "read" },
			{ profile: createProfileStore(file), session: createSessionMemory(), knowledge: createKnowledgeStore(join(directory, "knowledge")) },
		);
		assert.equal(result.success, false);
		assert.equal(result.retryable, true);
		assert.equal(result.text, "Memory recall is temporarily unavailable.");
		assert.doesNotMatch(result.text, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(result.text, /JSON|profile\.json|broken/i);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session memory honors maxTurns configured at creation", () => {
	const memory = createSessionMemory({ maxTurns: 2 });
	for (let index = 0; index < 3; index++) {
		addTurn(memory, { userText: `request-${index}`, finalSpeech: "done", toolsUsed: [], workspaceHint: "", shortOutcome: "done" });
	}
	assert.deepEqual(memory.turns.map((turn) => turn.userText), ["request-1", "request-2"]);
});

test("session mapping assigns stable per-turn IDs and returns bounded sanitized summaries", () => {
	const memory = createSessionMemory();
	const rawOutcome = `stdout:${"x".repeat(500)}\u0000secret-tail`;
	addTurn(memory, {
		userText: `request ${"u".repeat(400)}`,
		finalSpeech: `response ${"r".repeat(400)}`,
		toolsUsed: ["bash"],
		workspaceHint: "workspace:1",
		shortOutcome: rawOutcome,
	}, undefined, { requestId: "req-session", turnId: "turn-session", sourceId: "session-a", timestamp: "2026-07-14T11:00:00.000Z" });

	const storedId = memory.turns[0]?.id;
	assert.ok(storedId);
	assert.ok((memory.turns[0]?.shortOutcome.length ?? 0) <= 200);
	assert.doesNotMatch(memory.turns[0]?.shortOutcome ?? "", /secret-tail|\u0000/);
	const firstProjection = getSessionMemoryRecords(memory);
	const records = getSessionMemoryRecords(memory);
	assert.equal(records[0]?.id, storedId);
	assert.equal(firstProjection[0]?.id, storedId);
	assert.equal(records[0]?.kind, "session");
	assert.equal(records[0]?.ephemeral, true);
	assert.equal(records[0]?.provenance.requestId, "req-session");
	assert.equal(records[0]?.provenance.turnId, "turn-session");
	assert.ok((records[0]?.userText.length ?? 0) <= 240);
	assert.ok((records[0]?.finalSpeech.length ?? 0) <= 240);
	assert.ok((records[0]?.shortOutcome.length ?? 0) <= 200);
	assert.doesNotMatch(records[0]?.shortOutcome ?? "", /secret-tail|\u0000/);
});

test("unified recall groups detached profile, session, and Knowledge matches", () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred2-recall-"));
	try {
		const profile = createProfileStore(join(directory, "profile.json"));
		profile.rememberFact("launch_theme", "amber", "preference");
		const session = createSessionMemory();
		addTurn(session, { userText: "Review the amber launch", finalSpeech: "Reviewed.", toolsUsed: ["recall"], workspaceHint: "Alfred", shortOutcome: "Amber launch reviewed." });
		const knowledge = createKnowledgeStore(join(directory, "knowledge"));
		const source = knowledge.ingest({ title: "Launch notes", content: "The amber launch review happens Thursday." }).source;
		const result = recallMemory({ query: "amber", limit: 3 }, { profile, session, knowledge });
		assert.deepEqual(result.kinds, ["profile", "session", "knowledge"]);
		assert.equal(result.groups.profile.length, 1);
		assert.equal(result.groups.session.length, 1);
		assert.equal(result.groups.knowledge[0]?.record.id, source.id);
		assert.equal(result.groups.knowledge[0]?.citation.sourceId, source.id);
		assert.equal(result.citations[0]?.citationId, result.groups.knowledge[0]?.citation.citationId);
		result.groups.profile[0]!.record.value = "mutated clone";
		assert.equal(profile.recallFact("launch_theme")[0]?.value, "amber");
		const filtered = recallMemory({ query: "amber", kinds: ["session"], limit: 1 }, { profile, session, knowledge });
		assert.equal(filtered.total, 1);
		assert.deepEqual(filtered.groups.profile, []);
		assert.deepEqual(filtered.groups.knowledge, []);
		assert.throws(() => recallMemory({ query: " ", limit: 1 }, { profile, session, knowledge }), /required/);
		assert.equal(recallMemory({ query: "amber", limit: 10 }, { profile, session, knowledge }).limit, 10);
		assert.throws(() => recallMemory({ query: "amber", limit: 11 }, { profile, session, knowledge }), /1 to 10/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("dashboard state is additive and profile deletion uses the stable memory ID", async () => {
	const { directory, file } = temporaryProfile();
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		profileFile: file,
		historyFile: join(directory, "history.json"),
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
	});
	const baseUrl = `http://${server.host}:${server.port}`;
	try {
		const createResponse = await fetch(`${baseUrl}/dashboard/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "theme", value: "estate", category: "preference", requestId: "req-dashboard-memory" }),
		});
		assert.equal(createResponse.status, 200);
		assert.equal(createResponse.headers.get("cache-control"), "no-store");
		const created = await createResponse.json() as { fact: ProfileMemoryRecord };
		assert.equal(created.fact.provenance.source, "manual");
		assert.equal(created.fact.provenance.requestId, "req-dashboard-memory");

		const externalState = await fetch(`${baseUrl}/dashboard/state`, { headers: { Origin: "https://evil.example" } });
		assert.equal(externalState.status, 403);
		assert.equal(externalState.headers.get("cache-control"), "no-store");
		const invalidCreate = await fetch(`${baseUrl}/dashboard/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "", value: "missing" }),
		});
		assert.equal(invalidCreate.status, 400);
		assert.equal(invalidCreate.headers.get("cache-control"), "no-store");

		const updateResponse = await fetch(`${baseUrl}/dashboard/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "theme", value: "cave" }),
		});
		assert.equal(updateResponse.status, 200);
		const updated = await updateResponse.json() as { fact: ProfileMemoryRecord };
		assert.equal(updated.fact.id, created.fact.id);
		assert.equal(updated.fact.category, "preference");

		const patchResponse = await fetch(`${baseUrl}/api/memory/profile/${encodeURIComponent(created.fact.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "visual_theme", value: "cave", category: "context", expectedUpdatedAt: updated.fact.updatedAt }),
		});
		assert.equal(patchResponse.status, 200);
		const patched = await patchResponse.json() as { fact: ProfileMemoryRecord };
		assert.equal(patched.fact.id, created.fact.id);
		assert.equal(patched.fact.key, "visual_theme");
		assert.equal(patched.fact.createdAt, created.fact.createdAt);
		const stalePatch = await fetch(`${baseUrl}/api/memory/profile/${encodeURIComponent(created.fact.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "stale", expectedUpdatedAt: updated.fact.updatedAt }),
		});
		assert.equal(stalePatch.status, 409);

		const malformedPatch = await fetch(`${baseUrl}/api/memory/profile/%`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "nope", expectedUpdatedAt: patched.fact.updatedAt }),
		});
		assert.equal(malformedPatch.status, 400);
		const malformedDelete = await fetch(`${baseUrl}/api/memory/profile/%`, { method: "DELETE" });
		assert.equal(malformedDelete.status, 400);
		const wrongPatchType = await fetch(`${baseUrl}/api/memory/profile/${encodeURIComponent(created.fact.id)}`, { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: "{}" });
		assert.equal(wrongPatchType.status, 415);
		const oversizedPatch = await fetch(`${baseUrl}/api/memory/profile/${encodeURIComponent(created.fact.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(1024 * 1024 + 1), expectedUpdatedAt: patched.fact.updatedAt }) });
		assert.equal(oversizedPatch.status, 413);

		const recallResponse = await fetch(`${baseUrl}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "cave", kinds: ["profile"], limit: 2 }),
		});
		assert.equal(recallResponse.status, 200);
		const recalled = await recallResponse.json() as { total: number; groups: { profile: Array<{ record: ProfileMemoryRecord }> } };
		assert.equal(recalled.total, 1);
		assert.equal(recalled.groups.profile[0]?.record.id, created.fact.id);
		const externalRecall = await fetch(`${baseUrl}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
			body: JSON.stringify({ query: "cave" }),
		});
		assert.equal(externalRecall.status, 403);
		assert.equal(externalRecall.headers.get("cache-control"), "no-store");
		const wrongRecallType = await fetch(`${baseUrl}/api/memory/recall`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
		assert.equal(wrongRecallType.status, 415);
		assert.equal(wrongRecallType.headers.get("cache-control"), "no-store");
		const oversizedRecall = await fetch(`${baseUrl}/api/memory/recall`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "x".repeat(1024 * 1024 + 1) }) });
		assert.equal(oversizedRecall.status, 413);
		assert.equal(oversizedRecall.headers.get("cache-control"), "no-store");
		const invalidRecall = await fetch(`${baseUrl}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "", kinds: [], limit: 21 }),
		});
		assert.equal(invalidRecall.status, 400);

		const cleared = await fetch(`${baseUrl}/api/memory/session`, { method: "DELETE" });
		assert.equal(cleared.status, 200);
		const clearData = await cleared.json() as { removed: number; retained: string[]; session: { count: number } };
		assert.equal(clearData.removed, 0);
		assert.equal(clearData.session.count, 0);
		assert.ok(clearData.retained.includes("activity history"));

		const stateResponse = await fetch(`${baseUrl}/dashboard/state`);
		assert.equal(stateResponse.status, 200);
		assert.equal(stateResponse.headers.get("cache-control"), "no-store");
		const state = await stateResponse.json() as {
			profileFacts: ProfileMemoryRecord[];
			memoryTurns: number;
			memory: {
				profile: { count: number; records: ProfileMemoryRecord[] };
				session: { ephemeral: boolean; count: number; records: SessionMemoryRecord[] };
				knowledge: { available: boolean; count: number; sources: KnowledgeSourceRecord[] };
			};
		};
		assert.equal(state.profileFacts[0]?.id, created.fact.id);
		assert.equal(state.profileFacts[0]?.key, "visual_theme");
		assert.equal(state.memoryTurns, 0);
		assert.equal(state.memory.profile.records[0]?.kind, "profile");
		assert.equal(state.memory.session.ephemeral, true);
		assert.deepEqual(state.memory.session.records, []);
		assert.equal(state.memory.knowledge.available, true);
		assert.deepEqual(state.memory.knowledge.sources, []);

		const deleteResponse = await fetch(`${baseUrl}/api/memory/profile/${encodeURIComponent(created.fact.id)}`, { method: "DELETE" });
		assert.equal(deleteResponse.status, 200);
		const afterDelete = await fetch(`${baseUrl}/dashboard/state`).then((response) => response.json()) as { profileFacts: ProfileMemoryRecord[] };
		assert.deepEqual(afterDelete.profileFacts, []);

		const compatibilityCreate = await fetch(`${baseUrl}/dashboard/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "compatibility", value: "retained" }),
		}).then((response) => response.json()) as { fact: ProfileMemoryRecord };
		const compatibilityDelete = await fetch(`${baseUrl}/dashboard/facts/${encodeURIComponent(compatibilityCreate.fact.id)}`, { method: "DELETE" });
		assert.equal(compatibilityDelete.status, 200);
	} finally {
		await server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("unified recall API sanitizes private store failures", async () => {
	const { directory, file } = temporaryProfile();
	writeFileSync(file, "{ private broken profile", "utf8");
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		profileFile: file,
		historyFile: join(directory, "history.json"),
		knowledgeDirectory: join(directory, "knowledge"),
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
	});
	const baseUrl = `http://${server.host}:${server.port}`;
	try {
		const response = await fetch(`${baseUrl}/api/memory/recall`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "theme", kinds: ["profile"] }),
		});
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const body = await response.json() as { error: string };
		assert.equal(body.error, "Memory recall is temporarily unavailable.");
		assert.doesNotMatch(JSON.stringify(body), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(JSON.stringify(body), /JSON|profile\.json|existing file was left untouched/i);
	} finally {
		await server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
