import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCandidateBatch, ProfileMemoryRecord, SessionMemoryRecord } from "../src/alfred-2/memory-types.ts";
import { startAlfred2 } from "../src/alfred-2/server.ts";

async function json(response: Response): Promise<any> {
	return response.json();
}

test("reviewed candidate APIs require explicit per-item acceptance and ignore auto-confirm", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-reviewed-server-"));
	const profileFile = join(directory, "profile.json");
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		profileFile,
		historyFile: join(directory, "history.json"),
		knowledgeDirectory: join(directory, "knowledge"),
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
	});
	const baseUrl = `http://${server.host}:${server.port}`;
	try {
		await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "I prefer concise status updates.", requestId: "source-request", playback: "browser" }),
		});
		await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: `I prefer brief replies. ${"x".repeat(260)} My password is hunter2.`, requestId: "source-secret", playback: "browser" }),
		});
		const state = await json(await fetch(`${baseUrl}/dashboard/state`)) as { sessionId: string; memory: { session: { records: SessionMemoryRecord[] } } };
		const source = state.memory.session.records.find((record) => record.userText.includes("concise"));
		const secretSource = state.memory.session.records.find((record) => record.provenance.requestId === "source-secret");
		assert.ok(source);
		assert.ok(secretSource);
		const secretBatch = await json(await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "review-secret", turnIds: [secretSource.id] }) })) as MemoryCandidateBatch;
		assert.deepEqual(secretBatch.candidates, []);
		assert.deepEqual(secretBatch.excluded, [{ turnId: secretSource.id, reason: "secret_or_sensitive" }]);
		assert.doesNotMatch(JSON.stringify(secretBatch), /hunter2|password/i);
		assert.equal(existsSync(profileFile), false);

		await fetch(`${baseUrl}/api/settings/autonomy`,  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoConfirm: true }) });
		const external = await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ requestId: "review-external", turnIds: [source.id] }) });
		assert.equal(external.status, 403);
		assert.equal(external.headers.get("cache-control"), "no-store");
		const wrongType = await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
		assert.equal(wrongType.status, 415);
		const oversized = await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "x".repeat(17_000), turnIds: [source.id] }) });
		assert.equal(oversized.status, 413);
		assert.equal(oversized.headers.get("cache-control"), "no-store");
		const missingSource = await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "review-missing", turnIds: ["missing"] }) });
		assert.equal(missingSource.status, 409);

		const extractionResponse = await fetch(`${baseUrl}/api/memory/candidates/extract`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "review-request", turnIds: [source.id] }),
		});
		assert.equal(extractionResponse.status, 200);
		assert.equal(extractionResponse.headers.get("cache-control"), "no-store");
		const batch = await json(extractionResponse) as MemoryCandidateBatch & { ok: true };
		assert.equal(batch.sessionId, state.sessionId);
		assert.equal(batch.candidates.length, 1);
		assert.equal(batch.candidates[0]?.source.sessionRecordId, source.id);
		assert.equal(batch.candidates[0]?.source.requestId, "source-request");
		assert.equal(existsSync(profileFile), false, "extraction must not create durable profile storage");

		await fetch(`${baseUrl}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "yes, accept it", requestId: "natural-yes", playback: "browser" }) });
		assert.equal(existsSync(profileFile), false, "natural-language confirmation and auto-confirm must not accept a candidate");
		const candidate = batch.candidates[0]!;
		const bypass = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/accept`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: candidate.key, value: candidate.value, category: candidate.category, confirm: true }),
		});
		assert.equal(bypass.status, 400);
		assert.equal(existsSync(profileFile), false);

		const acceptedResponse = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/accept`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "preferred_status_updates", value: "concise", category: "preference" }),
		});
		assert.equal(acceptedResponse.status, 200);
		assert.equal(acceptedResponse.headers.get("cache-control"), "no-store");
		const accepted = await json(acceptedResponse) as { fact: ProfileMemoryRecord };
		assert.equal(accepted.fact.provenance.source, "conversation");
		assert.equal(accepted.fact.provenance.sourceId, source.id);
		assert.equal(accepted.fact.provenance.requestId, "source-request");
		assert.equal(accepted.fact.provenance.turnId, source.provenance.turnId);
		assert.deepEqual(accepted.fact.provenance.review, {
			batchId: batch.batchId,
			candidateId: candidate.id,
			requestId: batch.requestId,
			sessionId: batch.sessionId,
			sessionRecordId: source.id,
		});
		const replay = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/accept`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: candidate.key, value: candidate.value, category: candidate.category }),
		});
		assert.equal(replay.status, 404);
		assert.equal((JSON.parse(readFileSync(profileFile, "utf8")) as { facts: unknown[] }).facts.length, 1);
	} finally {
		await server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("reviewed conflicts, rejection, and session clear fail closed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-reviewed-server-"));
	const profileFile = join(directory, "profile.json");
	const server = await startAlfred2({
		host: "127.0.0.1", port: 0, profileFile, historyFile: join(directory, "history.json"), knowledgeDirectory: join(directory, "knowledge"),
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done.", displayText: "Done." }; } },
	});
	const baseUrl = `http://${server.host}:${server.port}`;
	try {
		const manual = await json(await fetch(`${baseUrl}/dashboard/facts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "preferred_theme", value: "estate", category: "preference" }) })) as { fact: ProfileMemoryRecord };
		await fetch(`${baseUrl}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "My preferred theme is cave.", requestId: "source-conflict", playback: "browser" }) });
		const state = await json(await fetch(`${baseUrl}/dashboard/state`)) as { memory: { session: { records: SessionMemoryRecord[] } } };
		const source = state.memory.session.records.find((record) => record.userText.includes("preferred theme"))!;
		const batch = await json(await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "review-conflict", turnIds: [source.id] }) })) as MemoryCandidateBatch;
		assert.equal(batch.candidates[0]?.conflict?.record.id, manual.fact.id);
		const candidate = batch.candidates[0]!;
		const conflict = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: candidate.key, value: candidate.value, category: candidate.category }) });
		assert.equal(conflict.status, 409);
		assert.equal((await json(await fetch(`${baseUrl}/dashboard/state`)) as { profileFacts: ProfileMemoryRecord[] }).profileFacts[0]?.value, "estate");

		const rejected = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		assert.equal(rejected.status, 200);
		const rejectedAccept = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(batch.batchId)}/${encodeURIComponent(candidate.id)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "other_key", value: "other", category: "preference" }) });
		assert.equal(rejectedAccept.status, 404);

		const freshBatch = await json(await fetch(`${baseUrl}/api/memory/candidates/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "review-clear", turnIds: [source.id] }) })) as MemoryCandidateBatch;
		const cleared = await json(await fetch(`${baseUrl}/api/memory/session`, { method: "DELETE" })) as { removedCandidates: number };
		assert.equal(cleared.removedCandidates, 1);
		const afterClear = await fetch(`${baseUrl}/api/memory/candidates/${encodeURIComponent(freshBatch.batchId)}/${encodeURIComponent(freshBatch.candidates[0]!.id)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "other_key", value: "other", category: "preference" }) });
		assert.equal(afterClear.status, 404);
	} finally {
		await server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
