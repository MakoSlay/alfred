import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAlfred2 } from "../src/alfred-2/server.ts";

function temporaryProfile(): { directory: string; file: string; historyFile: string } {
	const directory = mkdtempSync(join(tmpdir(), "alfred2-server-profile-"));
	return { directory, file: join(directory, "profile.json"), historyFile: join(directory, "history.json") };
}

async function withServer<T>(fn: (baseUrl: string, historyFile: string) => Promise<T>): Promise<T> {
	const profile = temporaryProfile();
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
		profileFile: profile.file,
		historyFile: profile.historyFile,
	});
	try {
		return await fn(`http://${server.host}:${server.port}`, profile.historyFile);
	} finally {
		await server.close();
		rmSync(profile.directory, { recursive: true, force: true });
	}
}

async function readSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<Array<Record<string, unknown>>> {
	const decoder = new TextDecoder();
	let buffer = "";
	const events: Array<Record<string, unknown>> = [];
	while (events.length < count) {
		const result = await reader.read();
		if (result.done) break;
		buffer += decoder.decode(result.value, { stream: true });
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
			if (data) events.push(JSON.parse(data) as Record<string, unknown>);
		}
	}
	return events;
}

test("server close removes process signal listeners it installs", async () => {
	const profile = temporaryProfile();
	const before = {
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGINT: process.listenerCount("SIGINT"),
		beforeExit: process.listenerCount("beforeExit"),
	};
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
		profileFile: profile.file,
		historyFile: profile.historyFile,
	});
	await server.close();
	rmSync(profile.directory, { recursive: true, force: true });
	assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
	assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
	assert.equal(process.listenerCount("beforeExit"), before.beforeExit);
});

test("SSE publishes request-scoped lifecycle events for deterministic asks", async () => {
	await withServer(async (baseUrl) => {
		const controller = new AbortController();
		const stream = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
		assert.equal(stream.status, 200);
		assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
		const reader = stream.body?.getReader();
		assert.ok(reader);
		const eventsPromise = readSseEvents(reader, 2);

		const response = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-sse-test", text: "what time is it" }),
		});
		assert.equal(response.status, 200);
		const events = await eventsPromise;
		controller.abort();
		assert.deepEqual(events.map((event) => event.type), ["ask:start", "ask:done"]);
		assert.equal(events.every((event) => event.requestId === "req-sse-test"), true);
		assert.match(String(events[1]?.displayText), /^It is /);
	});
});

test("/ask responses include caller-provided request IDs", async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-test-123", text: "" }),
		});
		const data = await response.json() as { ok: boolean; requestId?: string; sessionId?: string; error?: string };
		assert.equal(response.status, 400);
		assert.equal(data.ok, false);
		assert.equal(data.requestId, "req-test-123");
		assert.match(data.sessionId ?? "", /^session-/);
		assert.equal(data.error, "text is required");
	});
});

test("common time phrasing is deterministic and bypasses LLM", async () => {
	const profile = temporaryProfile();
	let agentCalls = 0;
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { agentCalls++; return { speech: "LLM called", displayText: "LLM called" }; } },
		profileFile: profile.file,
		historyFile: profile.historyFile,
	});
	try {
		const response = await fetch(`http://${server.host}:${server.port}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-time", text: "what time is it" }),
		});
		const data = await response.json() as { ok: boolean; requestId: string; speech: string; timing?: unknown };
		assert.equal(response.status, 200);
		assert.equal(data.ok, true);
		assert.equal(data.requestId, "req-time");
		assert.match(data.speech, /^It is .+sir\.$/);
		assert.equal(data.timing, undefined);
		assert.equal(agentCalls, 0);
	} finally {
		await server.close();
		rmSync(profile.directory, { recursive: true, force: true });
	}
});

test("wellness break acknowledgement and snooze routes are deterministic", async () => {
	await withServer(async (baseUrl) => {
		const snooze = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-snooze", text: "snooze break for 5 minutes" }),
		});
		const snoozeData = await snooze.json() as { ok: boolean; requestId: string; displayText: string; wellness: { breakSnoozedUntil: string | null } };
		assert.equal(snooze.status, 200);
		assert.equal(snoozeData.ok, true);
		assert.equal(snoozeData.requestId, "req-snooze");
		assert.match(snoozeData.displayText, /Break reminder snoozed/);
		assert.ok(snoozeData.wellness.breakSnoozedUntil);

		const ack = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-break-ack", text: "break done" }),
		});
		const ackData = await ack.json() as { ok: boolean; requestId: string; wellness: { breakSnoozedUntil: string | null; breakPending: boolean } };
		assert.equal(ack.status, 200);
		assert.equal(ackData.ok, true);
		assert.equal(ackData.requestId, "req-break-ack");
		assert.equal(ackData.wellness.breakPending, false);
		assert.equal(ackData.wellness.breakSnoozedUntil, null);
	});
});

test("dashboard state and tools endpoints expose live controls", async () => {
	await withServer(async (baseUrl) => {
		const toolsResponse = await fetch(`${baseUrl}/tools`);
		const tools = await toolsResponse.json() as { ok: boolean; count: number; names: string[]; contracts: Array<{ name: string }> };
		assert.equal(toolsResponse.status, 200);
		assert.equal(tools.ok, true);
		assert.equal(tools.count, 24);
		assert.equal(tools.names.includes("bash"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "remember"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "set_voice_settings"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "refresh_context"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "inspect_session"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "send_session_message"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "start_session_monitor"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "session_monitor_status"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "gmail_search"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "calendar_today"), true);
		assert.equal(tools.contracts.some((contract) => contract.name === "docs_read"), true);

		const enable = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "yes to all" }),
		});
		assert.equal(enable.status, 200);

		const ask = await fetch(`${baseUrl}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-dashboard-recall", text: "please leave a previous response marker" }),
		});
		assert.equal(ask.status, 200);

		const stateResponse = await fetch(`${baseUrl}/dashboard/state`);
		const state = await stateResponse.json() as { ok: boolean; autoConfirm: boolean; toolRounds: number; tools: { count: number }; listener: { provider: string; running: boolean }; recentResponses: Array<{ requestId?: string; userText: string; responseText: string }> };
		assert.equal(stateResponse.status, 200);
		assert.equal(state.ok, true);
		assert.equal(state.autoConfirm, true);
		assert.equal(state.toolRounds, 0);
		assert.equal(state.tools.count, 24);
		assert.equal(state.listener.provider, "off");
		assert.equal(state.listener.running, false);
		assert.equal(state.recentResponses.some((entry) => entry.requestId === "req-dashboard-recall" && entry.userText === "please leave a previous response marker" && entry.responseText === "Done, sir."), true);
	});
});

test("server history writes stay inside the injected test path", async () => {
	await withServer(async (baseUrl, historyFile) => {
		for (let index = 0; index < 5; index++) {
			const response = await fetch(`${baseUrl}/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requestId: `history-${index}`, text: "what time is it" }),
			});
			assert.equal(response.status, 200);
		}
		assert.equal(existsSync(historyFile), true);
		const entries = JSON.parse(readFileSync(historyFile, "utf8")) as Array<{ requestId?: string }>;
		assert.equal(entries.some((entry) => entry.requestId === "history-4"), true);
	});
});

test("dashboard serves the built React app and immutable Vite assets", async () => {
	await withServer(async (baseUrl) => {
		const dashboard = await fetch(`${baseUrl}/dashboard`);
		assert.equal(dashboard.status, 200);
		assert.match(dashboard.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(dashboard.headers.get("cache-control"), "no-store");
		assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff");
		assert.match(dashboard.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
		const html = await dashboard.text();
		assert.match(html, /<div id="root"><\/div>/);
		assert.doesNotMatch(html, /Private Butler Console/);

		const assetPath = html.match(/(?:src|href)="(\/dashboard\/assets\/[^"]+)"/)?.[1];
		assert.ok(assetPath, "built dashboard should reference a hashed asset");
		const asset = await fetch(`${baseUrl}${assetPath}`);
		assert.equal(asset.status, 200);
		assert.match(asset.headers.get("content-type") ?? "", /^(?:text\/javascript|text\/css)/);
		assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal(asset.headers.get("x-content-type-options"), "nosniff");

		const missing = await fetch(`${baseUrl}/dashboard/assets/not-found.js`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { ok: false, error: "Dashboard asset not found." });

		const traversal = await fetch(`${baseUrl}/dashboard/assets/%2e%2e%2findex.html`);
		assert.equal(traversal.status, 400);
	});
});
