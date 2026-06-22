import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AlfredEvent } from "../src/contracts/runtime.ts";
import { createJsonFileStorage, sanitizeEventForStorage } from "../src/storage/index.ts";
import { cliSource, powerCodeTarget } from "../src/testing/fixtures.ts";

function auditEvent(overrides: Partial<AlfredEvent> = {}): AlfredEvent {
	return {
		id: "evt_persist_001",
		kind: "request.received",
		createdAt: "2026-06-19T22:00:00.000Z",
		requestId: "req_persist_001",
		source: { kind: cliSource().kind, id: cliSource().id, label: cliSource().label },
		target: powerCodeTarget({ metadata: { secretTitle: "do-not-store-this" } }),
		summary: "Handled CLI request without executing privileged actions.",
		data: { rawProviderText: "sk-secret-should-not-persist" },
		redaction: { status: "not_needed" },
		retention: { policy: "short", expiresAt: "2026-06-20T22:00:00.000Z", reason: "test audit event" },
		...overrides,
	};
}

test("json file storage round-trips redacted audit events and sanitized target memory", async () => {
	const appDir = await mkdtemp(join(tmpdir(), "alfred-storage-"));
	try {
		const storage = createJsonFileStorage({ appDir, maxEvents: 10 });
		assert.equal(storage.appendEvent(auditEvent()), null);
		assert.equal(storage.saveTargets([powerCodeTarget({ metadata: { secretTitle: "do-not-store-this" } })], "2026-06-19T22:00:00.000Z"), null);

		const loaded = storage.load("2026-06-19T22:01:00.000Z");
		assert.deepEqual(loaded.warnings, []);
		assert.equal(loaded.events.length, 1);
		assert.equal(loaded.events[0]?.requestId, "req_persist_001");
		assert.equal(loaded.events[0]?.data, undefined);
		assert.equal(loaded.events[0]?.target?.metadata, undefined);
		assert.equal(loaded.recentTargets.length, 1);
		assert.equal(loaded.recentTargets[0]?.label, "π - Power Code");
		assert.equal(loaded.recentTargets[0]?.metadata, undefined);

		const eventLog = await readFile(storage.eventsPath, "utf8");
		const targetsJson = await readFile(storage.targetsPath, "utf8");
		assert.equal(eventLog.includes("sk-secret-should-not-persist"), false);
		assert.equal(eventLog.includes("do-not-store-this"), false);
		assert.equal(targetsJson.includes("do-not-store-this"), false);
	} finally {
		await rm(appDir, { recursive: true, force: true });
	}
});

test("json file storage applies retention pruning and keeps session events ephemeral", async () => {
	const appDir = await mkdtemp(join(tmpdir(), "alfred-storage-"));
	try {
		const storage = createJsonFileStorage({ appDir, maxEvents: 10 });
		const sessionEvent = auditEvent({ id: "evt_session", retention: { policy: "session", expiresAt: "2026-06-19T22:05:00.000Z" } });
		assert.equal(sanitizeEventForStorage(sessionEvent), null);
		assert.equal(storage.appendEvent(sessionEvent), null);
		assert.equal(existsSync(storage.eventsPath), false);

		assert.equal(storage.appendEvent(auditEvent({ id: "evt_expired", retention: { policy: "short", expiresAt: "2026-06-19T22:00:01.000Z" } })), null);
		const loaded = storage.load("2026-06-19T22:00:02.000Z");
		assert.deepEqual(loaded.events, []);
		assert.equal(await readFile(storage.eventsPath, "utf8"), "");
	} finally {
		await rm(appDir, { recursive: true, force: true });
	}
});

test("json file storage skips corrupt records without failing startup", async () => {
	const appDir = await mkdtemp(join(tmpdir(), "alfred-storage-"));
	try {
		const storage = createJsonFileStorage({ appDir, maxEvents: 10 });
		await writeFile(storage.eventsPath, `not-json\n${JSON.stringify(sanitizeEventForStorage(auditEvent({ id: "evt_valid" })))}\n${JSON.stringify({ id: "evt_invalid" })}\n`, { mode: 0o600 });
		const loaded = storage.load("2026-06-19T22:01:00.000Z");
		assert.equal(loaded.events.length, 1);
		assert.equal(loaded.events[0]?.id, "evt_valid");
		assert.equal(loaded.warnings.length, 2);
		assert.match(loaded.warnings.join("\n"), /corrupt stored event|invalid stored event/);
	} finally {
		await rm(appDir, { recursive: true, force: true });
	}
});
