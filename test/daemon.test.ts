import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createAlfredDaemon, defaultDaemonConfig } from "../src/daemon/index.ts";
import { cliSource, piCommandSource, powerCodeTarget } from "../src/testing/fixtures.ts";
import type { AlfredDraft, AlfredHandleRequest, AlfredTarget } from "../src/contracts/runtime.ts";
import type { CmuxError } from "../src/cmux/index.ts";

interface MockCmuxOptions {
	targets?: AlfredTarget[];
	sendError?: CmuxError;
}

function createMockCmux(options: MockCmuxOptions = {}) {
	const defaultTargets: AlfredTarget[] = [
		powerCodeTarget(),
		{ ...powerCodeTarget({ ref: "surface:55", label: "Codex Review", processKind: "codex", kind: "codex-session", surfaceRef: "surface:55" }) },
	];
	const sends: Array<{ kind: "surface" | "workspace"; ref: string; text: string }> = [];
	let targets = options.targets ?? defaultTargets;
	return {
		sends,
		setTargets(nextTargets: AlfredTarget[]) {
			targets = nextTargets;
		},
		cmux: {
			async listTargets() {
				return { ok: true as const, value: targets };
			},
			async sendTextToSurface(surfaceRef: string, text: string) {
				sends.push({ kind: "surface" as const, ref: surfaceRef, text });
				return options.sendError ? { ok: false as const, error: options.sendError } : { ok: true as const, value: { surfaceRef } };
			},
			async sendTextToWorkspace(workspaceRef: string, text: string) {
				sends.push({ kind: "workspace" as const, ref: workspaceRef, text });
				return options.sendError ? { ok: false as const, error: options.sendError } : { ok: true as const, value: { workspaceRef } };
			},
		},
	};
}

async function withDaemon(run: (baseUrl: string, token: string, mock: ReturnType<typeof createMockCmux>) => Promise<void>): Promise<void> {
	const mock = createMockCmux();
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token", allowedOrigins: ["http://127.0.0.1"] },
		{ cmux: mock.cmux, now: () => new Date("2026-06-19T22:00:00.000Z") },
	);
	const started = await daemon.start();
	try {
		await run(`http://${started.host}:${started.port}`, started.authToken, mock);
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

async function postJson<T>(baseUrl: string, token: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { ...authHeaders(token), "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() as T };
}

async function createPowercoDraft(baseUrl: string, token: string): Promise<{ status: number; body: { ok: boolean; pendingDraft?: AlfredDraft; events: Array<{ kind: string }>; proposedActions: Array<{ kind: string; status: string }> } }> {
	return await postJson(baseUrl, token, "/handle", {
		requestId: "req_powerco_draft",
		createdAt: "2026-06-19T21:59:59.000Z",
		source: piCommandSource(),
		input: { text: "use my power co session in this workspace and try to implement ways to fix it" },
		context: { currentWorkspaceRef: "workspace:9" },
		policy: { requireConfirmationForSend: true },
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

test("Powerco named target request creates a pending draft without sending", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const { status, body } = await createPowercoDraft(baseUrl, token);

		assert.equal(status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.pendingDraft?.target.label, "π - Power Code");
		assert.equal(body.pendingDraft?.status, "pending");
		assert.equal(body.proposedActions[0]?.kind, "draft");
		assert.equal(body.proposedActions[0]?.status, "pending_confirmation");
		assert.equal(body.events[0]?.kind, "draft.created");
		assert.deepEqual(mock.sends, []);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { pendingDrafts: AlfredDraft[] };
		assert.equal(stateBody.pendingDrafts.length, 1);
		assert.equal(stateBody.pendingDrafts[0]?.id, body.pendingDraft?.id);
	});
});

test("POST /confirm sends a pending draft exactly once", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const draft = (await createPowercoDraft(baseUrl, token)).body.pendingDraft;
		assert.ok(draft);

		const confirmed = await postJson<{ ok: boolean; events: Array<{ kind: string }>; proposedActions: Array<{ kind: string; status: string }> }>(baseUrl, token, "/confirm", {
			requestId: "req_confirm_powerco",
			draftId: draft.id,
			source: piCommandSource(),
		});
		assert.equal(confirmed.status, 200);
		assert.equal(confirmed.body.ok, true);
		assert.equal(confirmed.body.events.some((event) => event.kind === "send.succeeded"), true);
		assert.equal(confirmed.body.proposedActions[0]?.kind, "send");
		assert.equal(confirmed.body.proposedActions[0]?.status, "succeeded");
		assert.deepEqual(mock.sends, [{ kind: "surface", ref: "surface:42", text: "try to implement ways to fix it" }]);

		const second = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/confirm", {
			requestId: "req_confirm_powerco_again",
			draftId: draft.id,
			source: piCommandSource(),
		});
		assert.equal(second.status, 400);
		assert.equal(second.body.ok, false);
		assert.equal(second.body.errors[0]?.code, "confirmation_expired");
		assert.equal(mock.sends.length, 1);
	});
});

test("send that through /handle confirms the latest pending draft", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		await createPowercoDraft(baseUrl, token);
		const confirmed = await postJson<{ ok: boolean; events: Array<{ kind: string }> }>(baseUrl, token, "/handle", {
			requestId: "req_send_that",
			createdAt: "2026-06-19T22:00:00.000Z",
			source: piCommandSource(),
			input: { text: "send that" },
		});

		assert.equal(confirmed.status, 200);
		assert.equal(confirmed.body.ok, true);
		assert.equal(confirmed.body.events.some((event) => event.kind === "send.succeeded"), true);
		assert.equal(mock.sends.length, 1);
	});
});

test("cancel removes a pending draft and records history", async () => {
	await withDaemon(async (baseUrl, token) => {
		const draft = (await createPowercoDraft(baseUrl, token)).body.pendingDraft;
		assert.ok(draft);

		const cancelled = await postJson<{ ok: boolean; events: Array<{ kind: string }> }>(baseUrl, token, "/cancel", {
			requestId: "req_cancel_powerco",
			draftId: draft.id,
			source: piCommandSource(),
			reason: "user cancelled",
		});
		assert.equal(cancelled.status, 200);
		assert.equal(cancelled.body.ok, true);
		assert.equal(cancelled.body.events[0]?.kind, "draft.cancelled");

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { pendingDrafts: AlfredDraft[] };
		assert.deepEqual(stateBody.pendingDrafts, []);
	});
});

test("confirm fails closed when the target disappears before confirmation", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const draft = (await createPowercoDraft(baseUrl, token)).body.pendingDraft;
		assert.ok(draft);
		mock.setTargets([]);

		const confirmed = await postJson<{ ok: boolean; errors: Array<{ code: string }>; events: Array<{ kind: string }> }>(baseUrl, token, "/confirm", {
			requestId: "req_confirm_missing_target",
			draftId: draft.id,
			source: piCommandSource(),
		});
		assert.equal(confirmed.status, 400);
		assert.equal(confirmed.body.ok, false);
		assert.equal(confirmed.body.errors[0]?.code, "target_not_found");
		assert.equal(confirmed.body.events[0]?.kind, "send.failed");
		assert.deepEqual(mock.sends, []);
	});
});

test("failed sends do not claim success", async () => {
	const mock = createMockCmux({ sendError: { code: "command_failed", message: "cmux send failed" } });
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token" },
		{ cmux: mock.cmux, now: () => new Date("2026-06-19T22:00:00.000Z") },
	);
	const started = await daemon.start();
	const baseUrl = `http://${started.host}:${started.port}`;
	try {
		const draft = (await createPowercoDraft(baseUrl, started.authToken)).body.pendingDraft;
		assert.ok(draft);
		const confirmed = await postJson<{ ok: boolean; errors: Array<{ code: string }>; events: Array<{ kind: string }>; proposedActions: Array<{ status: string }> }>(baseUrl, started.authToken, "/confirm", {
			requestId: "req_confirm_send_failure",
			draftId: draft.id,
			source: piCommandSource(),
		});
		assert.equal(confirmed.status, 400);
		assert.equal(confirmed.body.ok, false);
		assert.equal(confirmed.body.errors[0]?.code, "send_failed");
		assert.equal(confirmed.body.events.some((event) => event.kind === "send.succeeded"), false);
		assert.equal(confirmed.body.events.some((event) => event.kind === "send.failed"), true);
		assert.equal(confirmed.body.proposedActions[0]?.status, "failed");
	} finally {
		await daemon.stop();
	}
});

test("default daemon origins include unique loopback origins", () => {
	const config = defaultDaemonConfig({ host: "127.0.0.1", port: 47321, authToken: "test-token" });
	assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:47321", "http://localhost:47321", "http://[::1]:47321"]);

	const ipv6Config = defaultDaemonConfig({ host: "::1", port: 47322, authToken: "test-token" });
	assert.deepEqual(ipv6Config.allowedOrigins, ["http://[::1]:47322", "http://localhost:47322", "http://127.0.0.1:47322"]);
});

test("dashboard route renders local UI without exposing daemon state", async () => {
	await withDaemon(async (baseUrl, token) => {
		const dashboard = await fetch(`${baseUrl}/dashboard`);
		assert.equal(dashboard.status, 200);
		assert.equal(dashboard.headers.get("content-type")?.includes("text/html"), true);
		assert.equal(dashboard.headers.has("access-control-allow-origin"), false);
		const html = await dashboard.text();
		assert.match(html, /Alfred Local Dashboard/);
		assert.match(html, /GET \/surfaces|\/surfaces/);
		assert.match(html, /pending drafts/i);
		assert.match(html, /confirm/i);
		assert.match(html, /cancel/i);
		assert.match(html, /x-alfred-auth/);
		assert.equal(html.includes(token), false);
		assert.equal(html.includes("URLSearchParams"), false);
		assert.equal(html.includes("location.search"), false);

		const badOrigin = await fetch(`${baseUrl}/dashboard`, { headers: { origin: "https://evil.test" } });
		assert.equal(badOrigin.status, 403);
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
		{
			cmux: {
				async listTargets() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async sendTextToSurface() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async sendTextToWorkspace() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
			},
		},
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
