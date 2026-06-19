import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createAlfredDaemon } from "../src/daemon/index.ts";
import { cliSource, powerCodeTarget } from "../src/testing/fixtures.ts";
import type { AlfredHandleRequest, AlfredTarget } from "../src/contracts/runtime.ts";

async function withDaemon(run: (baseUrl: string, token: string) => Promise<void>): Promise<void> {
	const targets: AlfredTarget[] = [powerCodeTarget(), { ...powerCodeTarget({ ref: "surface:55", label: "Codex Review", processKind: "codex", kind: "codex-session", surfaceRef: "surface:55" }) }];
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token", allowedOrigins: ["http://127.0.0.1"] },
		{ cmux: { async listTargets() { return { ok: true, value: targets }; } }, now: () => new Date("2026-06-19T22:00:00.000Z") },
	);
	const started = await daemon.start();
	try {
		await run(`http://${started.host}:${started.port}`, started.authToken);
	} finally {
		await daemon.stop();
	}
}

function authHeaders(token: string): HeadersInit {
	return { "x-alfred-auth": token };
}

async function rawGetWithHost(baseUrl: string, path: string, host: string, token: string): Promise<{ status: number }> {
	const url = new URL(path, baseUrl);
	return await new Promise((resolve, reject) => {
		const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { host, "x-alfred-auth": token } }, (response) => {
			response.resume();
			response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
		});
		request.on("error", reject);
		request.end();
	});
}

test("daemon protects state and surfaces with local auth", async () => {
	await withDaemon(async (baseUrl, token) => {
		const unauthenticated = await fetch(`${baseUrl}/state`);
		assert.equal(unauthenticated.status, 401);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		assert.equal(state.status, 200);
		const body = await state.json() as { health?: string; pendingDrafts?: unknown[] };
		assert.equal(body.health, "ok");
		assert.deepEqual(body.pendingDrafts, []);
	});
});

test("daemon surfaces endpoint is backed by the cmux adapter dependency", async () => {
	await withDaemon(async (baseUrl, token) => {
		const response = await fetch(`${baseUrl}/surfaces`, { headers: authHeaders(token) });
		assert.equal(response.status, 200);
		const body = await response.json() as { ok: boolean; targets: AlfredTarget[] };
		assert.equal(body.ok, true);
		assert.equal(body.targets.some((target) => target.kind === "pi-chat"), true);
		assert.equal(body.targets.some((target) => target.kind === "codex-session"), true);
	});
});

test("POST /handle returns typed contract response and process-owned events", async () => {
	await withDaemon(async (baseUrl, token) => {
		const request: AlfredHandleRequest = {
			requestId: "req_cli_daemon_001",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: cliSource(),
			input: { text: "what surfaces can you see?" },
		};
		const response = await fetch(`${baseUrl}/handle`, {
			method: "POST",
			headers: { ...authHeaders(token), "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { ok: boolean; requestId: string; events: Array<{ kind: string }> };
		assert.equal(body.ok, true);
		assert.equal(body.requestId, request.requestId);
		assert.equal(body.events[0]?.kind, "request.received");

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { events: Array<{ requestId: string }> };
		assert.equal(stateBody.events[0]?.requestId, request.requestId);
	});
});

test("daemon rejects DNS rebinding and cross-origin browser-style requests", async () => {
	await withDaemon(async (baseUrl, token) => {
		const badHost = await rawGetWithHost(baseUrl, "/state", "evil.test", token);
		assert.equal(badHost.status, 403);

		const badOrigin = await fetch(`${baseUrl}/handle`, {
			method: "POST",
			headers: { ...authHeaders(token), origin: "https://evil.test", "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(badOrigin.status, 403);
		assert.equal(badOrigin.headers.has("access-control-allow-origin"), false);
	});
});

test("daemon reports structured errors for bad JSON and unavailable cmux", async () => {
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token" },
		{ cmux: { async listTargets() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; } } },
	);
	const started = await daemon.start();
	const baseUrl = `http://${started.host}:${started.port}`;
	try {
		const badJson = await fetch(`${baseUrl}/handle`, {
			method: "POST",
			headers: { ...authHeaders(started.authToken), "content-type": "application/json" },
			body: "not json",
		});
		assert.equal(badJson.status, 400);
		const badJsonBody = await badJson.json() as { error: { code: string } };
		assert.equal(badJsonBody.error.code, "invalid_request");

		const surfaces = await fetch(`${baseUrl}/surfaces`, { headers: authHeaders(started.authToken) });
		assert.equal(surfaces.status, 503);
		const surfacesBody = await surfaces.json() as { error: { code: string; retryable: boolean } };
		assert.equal(surfacesBody.error.code, "cmux_unavailable");
		assert.equal(surfacesBody.error.retryable, true);
	} finally {
		await daemon.stop();
	}
});
