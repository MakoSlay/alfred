import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAlfredDaemon, defaultDaemonConfig } from "../src/daemon/index.ts";
import { renderDashboardHtml } from "../src/dashboard/index.ts";
import { cliSource, piCommandSource, powerCodeTarget } from "../src/testing/fixtures.ts";
import type { AlfredDraft, AlfredHandleRequest, AlfredTarget } from "../src/contracts/runtime.ts";
import type { AlfredPlanner, AlfredPlannerInput } from "../src/planner/index.ts";
import type { AlfredLoopDecision, AlfredLoopRuntimeState, AlfredLoopScheduler } from "../src/loops/index.ts";
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
	const openedDiffs: Array<Record<string, unknown> | undefined> = [];
	let targets = options.targets ?? defaultTargets;
	return {
		sends,
		openedDiffs,
		setTargets(nextTargets: AlfredTarget[]) {
			targets = nextTargets;
		},
		cmux: {
			async listTargets() {
				return { ok: true as const, value: targets };
			},
			async readSurface(surfaceRef: string) {
				return { ok: true as const, value: { text: `screen for ${surfaceRef}` } };
			},
			async sendTextToSurface(surfaceRef: string, text: string) {
				sends.push({ kind: "surface" as const, ref: surfaceRef, text });
				return options.sendError ? { ok: false as const, error: options.sendError } : { ok: true as const, value: { surfaceRef } };
			},
			async sendTextToWorkspace(workspaceRef: string, text: string) {
				sends.push({ kind: "workspace" as const, ref: workspaceRef, text });
				return options.sendError ? { ok: false as const, error: options.sendError } : { ok: true as const, value: { workspaceRef } };
			},
			async openDiff(options?: Record<string, unknown>) {
				openedDiffs.push(options);
				return { ok: true as const, value: { opened: true } };
			},
		},
	};
}

async function withDaemon(
	run: (baseUrl: string, token: string, mock: ReturnType<typeof createMockCmux>) => Promise<void>,
	dependencies: { planner?: AlfredPlanner; loopDecider?: (loop: AlfredLoopRuntimeState, transcript: string) => Promise<AlfredLoopDecision>; loopScheduler?: AlfredLoopScheduler } = {},
): Promise<void> {
	const mock = createMockCmux();
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token", allowedOrigins: ["http://127.0.0.1"], storageDir: null },
		{ cmux: mock.cmux, now: () => new Date("2026-06-19T22:00:00.000Z"), planner: dependencies.planner, loopDecider: dependencies.loopDecider, loopScheduler: dependencies.loopScheduler },
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

async function createPowercoDraft(baseUrl: string, token: string): Promise<{ status: number; body: { ok: boolean; pendingAction?: { id: string; actionMetaId: string; status: string; input: Record<string, unknown> }; pendingDraft?: AlfredDraft; events: Array<{ kind: string }>; proposedActions: Array<{ kind: string; status: string }> } }> {
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

test("daemon persists audit events and target memory but not pending drafts", async () => {
	const storageDir = await mkdtemp(join(tmpdir(), "alfred-daemon-store-"));
	try {
		const mock = createMockCmux();
		const firstDaemon = createAlfredDaemon(
			{ host: "127.0.0.1", port: 0, authToken: "test-token", storageDir, allowedOrigins: ["http://127.0.0.1"] },
			{ cmux: mock.cmux, now: () => new Date("2026-06-19T22:00:00.000Z") },
		);
		const first = await firstDaemon.start();
		const firstBaseUrl = `http://${first.host}:${first.port}`;
		await fetch(`${firstBaseUrl}/surfaces`, { headers: authHeaders(first.authToken) });
		const handled = await postJson<{ ok: boolean; events: Array<{ requestId?: string }> }>(firstBaseUrl, first.authToken, "/handle", {
			requestId: "req_persist_noop",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: cliSource(),
			input: { text: "what can you see?" },
		});
		assert.equal(handled.status, 200);
		assert.equal(handled.body.ok, true);
		const draft = (await createPowercoDraft(firstBaseUrl, first.authToken)).body.pendingDraft;
		assert.ok(draft);
		await firstDaemon.stop();

		const secondDaemon = createAlfredDaemon(
			{ host: "127.0.0.1", port: 0, authToken: "test-token", storageDir, allowedOrigins: ["http://127.0.0.1"] },
			{ cmux: mock.cmux, now: () => new Date("2026-06-19T22:01:00.000Z") },
		);
		const second = await secondDaemon.start();
		try {
			const state = await fetch(`http://${second.host}:${second.port}/state`, { headers: authHeaders(second.authToken) });
			const stateBody = await state.json() as { health: string; pendingDrafts: AlfredDraft[]; recentTargets: AlfredTarget[]; events: Array<{ kind: string; requestId?: string }> };
			assert.equal(stateBody.health, "ok");
			assert.deepEqual(stateBody.pendingDrafts, []);
			assert.equal(stateBody.recentTargets.some((target) => target.label === "π - Power Code"), true);
			assert.equal(stateBody.events.some((event) => event.requestId === "req_persist_noop"), true);
			assert.equal(stateBody.events.some((event) => event.kind === "draft.created"), false);
			const eventLog = await readFile(join(storageDir, "events.jsonl"), "utf8");
			assert.equal(eventLog.includes("try to implement ways to fix it"), false);
		} finally {
			await secondDaemon.stop();
		}
	} finally {
		await rm(storageDir, { recursive: true, force: true });
	}
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

test("POST /ask answers target list questions without side effects", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; displayText: string; proposedActions: unknown[]; events: Array<{ kind: string }> }>(baseUrl, token, "/ask", {
			requestId: "req_ask_targets",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "what targets are active" },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.match(response.body.displayText, /Visible targets:/);
		assert.match(response.body.displayText, /π - Power Code/);
		assert.deepEqual(response.body.proposedActions, []);
		assert.equal(response.body.events[0]?.kind, "world.observed");
		assert.deepEqual(mock.sends, []);
	});
});

test("POST /ask executes safe open-diff requests directly through the registry", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; displayText: string; events: Array<{ kind: string }> }>(baseUrl, token, "/ask", {
			requestId: "req_ask_open_diff",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "open diff" },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.match(response.body.displayText, /executed successfully/);
		assert.equal(response.body.events.some((event) => event.kind === "action.executed"), true);
		assert.equal(mock.openedDiffs.length, 1);
		assert.deepEqual(mock.sends, []);
	});
});

test("POST /ask uses the shared Ask Alfred pipeline and creates PendingAction drafts", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; pendingAction?: { id: string; actionMetaId: string; status: string }; pendingDraft?: AlfredDraft; events: Array<{ kind: string }> }>(baseUrl, token, "/ask", {
			requestId: "req_ask_powerco",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "use my power co session in this workspace and run the focused test" },
			context: { currentWorkspaceRef: "workspace:9" },
			policy: { requireConfirmationForSend: true },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.pendingAction?.actionMetaId, "cmux.sendText");
		assert.equal(response.body.pendingDraft?.id, response.body.pendingAction?.id);
		assert.equal(response.body.events[0]?.kind, "draft.created");
		assert.deepEqual(mock.sends, []);
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

		assert.equal(body.pendingAction?.actionMetaId, "cmux.sendText");
		assert.equal(body.pendingAction?.id, body.pendingDraft?.id);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { pendingActions: Array<{ id: string; actionMetaId: string }>; pendingDrafts: AlfredDraft[] };
		assert.equal(stateBody.pendingActions.length, 1);
		assert.equal(stateBody.pendingActions[0]?.id, body.pendingAction?.id);
		assert.equal(stateBody.pendingDrafts.length, 1);
		assert.equal(stateBody.pendingDrafts[0]?.id, body.pendingDraft?.id);
	});
});

test("/confirm can edit a PendingAction-backed draft before sending", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const draft = (await createPowercoDraft(baseUrl, token)).body.pendingDraft;
		assert.ok(draft);

		const confirmed = await postJson<{ ok: boolean; events: Array<{ kind: string }> }>(baseUrl, token, "/confirm", {
			requestId: "req_confirm_edited_powerco",
			draftId: draft.id,
			text: "Please run the edited validation command.",
		});

		assert.equal(confirmed.status, 200);
		assert.equal(confirmed.body.ok, true);
		assert.deepEqual(mock.sends.map((send) => send.text), ["Please run the edited validation command."]);
		assert.equal(confirmed.body.events.some((event) => event.kind === "send.succeeded"), true);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { pendingActions: unknown[]; pendingDrafts: AlfredDraft[]; events: Array<{ kind: string }> };
		assert.deepEqual(stateBody.pendingActions, []);
		assert.deepEqual(stateBody.pendingDrafts, []);
		assert.equal(stateBody.events.some((event) => event.kind === "action.edited"), true);
		assert.equal(stateBody.events.some((event) => event.kind === "action.executed"), true);
	});
});

test("planner draft_message by target ref creates a pending draft without sending", async () => {
	let capturedInput: AlfredPlannerInput | undefined;
	const planner: AlfredPlanner = {
		async plan(input) {
			capturedInput = input;
			return {
				ok: true,
				intent: { kind: "draft_message", targetRef: "surface:42", message: "Please tell me what files I can delete now." },
				sanitizedInputSummary: { value: input.inputText, redaction: { status: "not_needed" } },
			};
		},
	};
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft; proposedActions: Array<{ kind: string; status: string }> }>(baseUrl, token, "/handle", {
			requestId: "req_planner_ref",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "can you get the powerco tab to identify removable files?" },
			context: { currentWorkspaceRef: "workspace:9" },
			policy: { requireConfirmationForSend: true, maxTranscriptChars: 120 },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.pendingDraft?.target.ref, "surface:42");
		assert.equal(response.body.pendingDraft?.text.value, "Please tell me what files I can delete now.");
		assert.equal(response.body.proposedActions[0]?.kind, "draft");
		assert.equal(response.body.proposedActions[0]?.status, "pending_confirmation");
		assert.deepEqual(mock.sends, []);
		assert.equal(capturedInput?.inputText, "can you get the powerco tab to identify removable files?");
		assert.equal(capturedInput?.maxInputChars, 120);
		assert.equal(capturedInput?.visibleTargets[0]?.metadata, undefined);
	}, { planner });
});

test("planner draft_message by target name resolves safely", async () => {
	const planner: AlfredPlanner = {
		async plan(input) {
			return {
				ok: true,
				intent: { kind: "draft_message", targetName: "Codex Review", message: "Please review the latest patch." },
				sanitizedInputSummary: { value: input.inputText, redaction: { status: "not_needed" } },
			};
		},
	};
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft }>(baseUrl, token, "/handle", {
			requestId: "req_planner_name",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "please ask the review session to look at the patch" },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.pendingDraft?.target.label, "Codex Review");
		assert.equal(response.body.pendingDraft?.status, "pending");
		assert.deepEqual(mock.sends, []);
	}, { planner });
});

test("planner unsupported direct-send output is ignored without persisting raw provider text", async () => {
	const rawProviderSecret = "sk-rawprovidersecret123456789";
	const planner: AlfredPlanner = {
		async plan(input) {
			return {
				ok: false,
				errors: [{ code: "unsupported_action", message: `provider said ${rawProviderSecret}`, retryable: false }],
				sanitizedInputSummary: { value: input.inputText, redaction: { status: "not_needed" } },
			};
		},
	};
	await withDaemon(async (baseUrl, token, mock) => {
		const response = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft; errors?: Array<{ code: string; message: string }>; events: Array<{ kind: string }> }>(baseUrl, token, "/handle", {
			requestId: "req_planner_unsupported",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "make the other chat do this" },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.pendingDraft, undefined);
		assert.equal(response.body.errors?.[0]?.code, "unsupported_action");
		assert.equal(response.body.errors?.[0]?.message.includes(rawProviderSecret), false);
		assert.equal(response.body.events.some((event) => event.kind === "error.raised"), true);
		assert.deepEqual(mock.sends, []);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateText = await state.text();
		assert.equal(stateText.includes(rawProviderSecret), false);
	}, { planner });
});

test("planner target ambiguity fails closed without creating a draft", async () => {
	const planner: AlfredPlanner = {
		async plan(input) {
			return {
				ok: true,
				intent: { kind: "draft_message", targetName: "Power Code", message: "Please continue." },
				sanitizedInputSummary: { value: input.inputText, redaction: { status: "not_needed" } },
			};
		},
	};
	await withDaemon(async (baseUrl, token, mock) => {
		mock.setTargets([
			powerCodeTarget({ ref: "surface:42", surfaceRef: "surface:42", label: "Power Code" }),
			powerCodeTarget({ ref: "surface:43", surfaceRef: "surface:43", label: "Power Code" }),
		]);
		const response = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft; errors?: Array<{ code: string }> }>(baseUrl, token, "/handle", {
			requestId: "req_planner_ambiguous",
			createdAt: "2026-06-19T21:59:59.000Z",
			source: piCommandSource(),
			input: { text: "get power code to continue" },
		});

		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.pendingDraft, undefined);
		assert.equal(response.body.errors?.[0]?.code, "target_ambiguous");
		assert.deepEqual(mock.sends, []);
	}, { planner });
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

test("loop API starts, reports, and stops one active loop", async () => {
	const scheduled: Array<{ loopId: string; delayMs: number }> = [];
	const cancelled: string[] = [];
	await withDaemon(async (baseUrl, token) => {
		const source = piCommandSource();
		const started = await postJson<{ ok: boolean; activeLoop?: { id: string; target: { ref: string }; status: string }; events: Array<{ kind: string }> }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start",
			source,
			targetRef: "surface:42",
			goal: { value: "Work until the file cleanup question is answered.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 2_500,
			allowedCapabilities: source.capabilities,
		});

		assert.equal(started.status, 200);
		assert.equal(started.body.ok, true);
		assert.equal(started.body.activeLoop?.target.ref, "surface:42");
		assert.equal(started.body.events[0]?.kind, "loop.started");
		assert.equal(scheduled[0]?.delayMs, 2_500);

		const status = await fetch(`${baseUrl}/loops/status`, { headers: authHeaders(token) });
		const statusBody = await status.json() as { activeLoop?: { id: string; status: string } };
		assert.equal(statusBody.activeLoop?.id, started.body.activeLoop?.id);
		assert.equal(statusBody.activeLoop?.status, "running");

		const stopped = await postJson<{ ok: boolean; activeLoop?: { status: string }; events: Array<{ kind: string }> }>(baseUrl, token, "/loops/stop", {
			requestId: "req_loop_stop",
			loopId: started.body.activeLoop?.id,
			source,
			interruptTarget: true,
		});
		assert.equal(stopped.status, 200);
		assert.equal(stopped.body.ok, true);
		assert.equal(stopped.body.events[0]?.kind, "loop.stopped");
		assert.equal(cancelled.includes(started.body.activeLoop?.id ?? ""), true);

		const state = await fetch(`${baseUrl}/state`, { headers: authHeaders(token) });
		const stateBody = await state.json() as { activeLoop: unknown; events: Array<{ kind: string }> };
		assert.equal(stateBody.activeLoop, null);
		assert.equal(stateBody.events.some((event) => event.kind === "loop.started"), true);
		assert.equal(stateBody.events.some((event) => event.kind === "loop.stopped"), true);
	}, {
		loopScheduler: {
			schedule(loopId, delayMs) { scheduled.push({ loopId, delayMs }); },
			cancel(loopId) { cancelled.push(loopId); },
		},
	});
});

test("loop poll drafts replies when autonomous-send approval is absent", async () => {
	const scheduled: Array<{ loopId: string; delayMs: number }> = [];
	await withDaemon(async (baseUrl, token, mock) => {
		const source = piCommandSource();
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_draft",
			source,
			targetRef: "surface:42",
			goal: { value: "Ask for cleanup advice.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		const polled = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft; activeLoop?: { turns: number; status: string }; events: Array<{ kind: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_draft",
			loopId: started.body.activeLoop?.id,
			source,
		});

		assert.equal(polled.status, 200);
		assert.equal(polled.body.ok, true);
		assert.equal(polled.body.pendingDraft?.target.ref, "surface:42");
		assert.equal(polled.body.pendingDraft?.text.value, "Please list the files I can delete now.");
		assert.equal(polled.body.activeLoop?.turns, 1);
		assert.equal(polled.body.events.some((event) => event.kind === "loop.replied"), true);
		assert.deepEqual(mock.sends, []);
		assert.equal(scheduled.some((entry) => entry.delayMs === 3_000), true);
	}, {
		loopDecider: async () => ({ kind: "draft_reply", message: "Please list the files I can delete now." }),
		loopScheduler: { schedule(loopId, delayMs) { scheduled.push({ loopId, delayMs }); }, cancel() { /* test seam */ } },
	});
});

test("loop draft failure marks loop as needing user", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const source = piCommandSource({ capabilities: ["world.read", "surface.read", "loop.manage"] });
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_draft_failure",
			source,
			targetRef: "surface:42",
			goal: { value: "Ask for cleanup advice.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		const polled = await postJson<{ ok: boolean; errors: Array<{ code: string }>; activeLoop?: { status: string }; pendingDraft?: AlfredDraft }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_draft_failure",
			loopId: started.body.activeLoop?.id,
			source,
		});

		assert.equal(polled.status, 400);
		assert.equal(polled.body.ok, false);
		assert.equal(polled.body.errors[0]?.code, "capability_denied");
		assert.equal(polled.body.pendingDraft, undefined);
		assert.equal(polled.body.activeLoop?.status, "needs_user");
		assert.deepEqual(mock.sends, []);
	}, { loopDecider: async () => ({ kind: "draft_reply", message: "Please list the files I can delete now." }) });
});

test("loop poll can autonomously send only with loop.autonomousSend", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const source = piCommandSource({ capabilities: [...piCommandSource().capabilities, "loop.autonomousSend"] });
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_auto",
			source,
			targetRef: "surface:42",
			goal: { value: "Ask for cleanup advice.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		const polled = await postJson<{ ok: boolean; pendingDraft?: AlfredDraft; proposedActions: Array<{ kind: string; status: string }>; activeLoop?: { turns: number }; events: Array<{ kind: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_auto",
			loopId: started.body.activeLoop?.id,
			source,
		});

		assert.equal(polled.status, 200);
		assert.equal(polled.body.ok, true);
		assert.equal(polled.body.pendingDraft, undefined);
		assert.deepEqual(mock.sends, [{ kind: "surface", ref: "surface:42", text: "Please list the files I can delete now." }]);
		assert.equal(polled.body.proposedActions[0]?.kind, "send");
		assert.equal(polled.body.proposedActions[0]?.status, "succeeded");
		assert.equal(polled.body.activeLoop?.turns, 1);
	}, { loopDecider: async () => ({ kind: "draft_reply", message: "Please list the files I can delete now." }) });
});

test("autonomous loop send failures do not claim success", async () => {
	const mock = createMockCmux({ sendError: { code: "command_failed", message: "cmux send failed" } });
	const daemon = createAlfredDaemon(
		{ host: "127.0.0.1", port: 0, authToken: "test-token", storageDir: null },
		{
			cmux: mock.cmux,
			now: () => new Date("2026-06-19T22:00:00.000Z"),
			loopDecider: async () => ({ kind: "draft_reply", message: "Please list the files I can delete now." }),
		},
	);
	const startedDaemon = await daemon.start();
	const baseUrl = `http://${startedDaemon.host}:${startedDaemon.port}`;
	try {
		const source = piCommandSource({ capabilities: [...piCommandSource().capabilities, "loop.autonomousSend"] });
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, startedDaemon.authToken, "/loops/start", {
			requestId: "req_loop_start_send_failure",
			source,
			targetRef: "surface:42",
			goal: { value: "Ask for cleanup advice.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		const polled = await postJson<{ ok: boolean; errors: Array<{ code: string }>; proposedActions: Array<{ status: string }>; activeLoop?: { status: string }; events: Array<{ kind: string }> }>(baseUrl, startedDaemon.authToken, "/loops/poll", {
			requestId: "req_loop_poll_send_failure",
			loopId: started.body.activeLoop?.id,
			source,
		});

		assert.equal(polled.status, 400);
		assert.equal(polled.body.ok, false);
		assert.equal(polled.body.errors[0]?.code, "send_failed");
		assert.equal(polled.body.proposedActions[0]?.status, "failed");
		assert.equal(polled.body.activeLoop?.status, "failed");
		assert.equal(polled.body.events.some((event) => event.kind === "send.succeeded"), false);
		assert.equal(mock.sends.length, 1);

		const status = await fetch(`${baseUrl}/loops/status?loopId=${started.body.activeLoop?.id ?? ""}`, { headers: authHeaders(startedDaemon.authToken) });
		const statusBody = await status.json() as { activeLoop?: { status: string } };
		assert.equal(statusBody.activeLoop?.status, "failed");
	} finally {
		await daemon.stop();
	}
});

test("loop poll and stop require a source with loop.manage", async () => {
	await withDaemon(async (baseUrl, token) => {
		const source = piCommandSource();
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_control_source",
			source,
			targetRef: "surface:42",
			goal: { value: "Do work.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		assert.ok(started.body.activeLoop?.id);

		const pollWithoutSource = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_without_source",
			loopId: started.body.activeLoop.id,
		});
		assert.equal(pollWithoutSource.status, 400);
		assert.equal(pollWithoutSource.body.ok, false);
		assert.equal(pollWithoutSource.body.errors[0]?.code, "invalid_request");

		const stopWithoutSource = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/stop", {
			requestId: "req_loop_stop_without_source",
			loopId: started.body.activeLoop.id,
		});
		assert.equal(stopWithoutSource.status, 400);
		assert.equal(stopWithoutSource.body.ok, false);
		assert.equal(stopWithoutSource.body.errors[0]?.code, "invalid_request");

		const pollWithoutCapability = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_without_capability",
			loopId: started.body.activeLoop.id,
			source: cliSource(),
		});
		assert.equal(pollWithoutCapability.status, 400);
		assert.equal(pollWithoutCapability.body.ok, false);
		assert.equal(pollWithoutCapability.body.errors[0]?.code, "capability_denied");

		const stopWithoutCapability = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/stop", {
			requestId: "req_loop_stop_without_capability",
			loopId: started.body.activeLoop.id,
			source: cliSource(),
		});
		assert.equal(stopWithoutCapability.status, 400);
		assert.equal(stopWithoutCapability.body.ok, false);
		assert.equal(stopWithoutCapability.body.errors[0]?.code, "capability_denied");

		const status = await fetch(`${baseUrl}/loops/status?loopId=${started.body.activeLoop.id}`, { headers: authHeaders(token) });
		const statusBody = await status.json() as { activeLoop?: { status: string } };
		assert.equal(statusBody.activeLoop?.status, "running");
	});
});

test("loop start rejects malformed authenticated bodies with structured errors", async () => {
	await withDaemon(async (baseUrl, token) => {
		const malformed = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_malformed",
		});

		assert.equal(malformed.status, 400);
		assert.equal(malformed.body.ok, false);
		assert.equal(malformed.body.errors[0]?.code, "invalid_request");
	});
});

test("loop poll fails closed when decision provider throws", async () => {
	await withDaemon(async (baseUrl, token) => {
		const source = piCommandSource();
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_decider_throw",
			source,
			targetRef: "surface:42",
			goal: { value: "Do work.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		const polled = await postJson<{ ok: boolean; activeLoop?: { status: string }; events: Array<{ kind: string; summary: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_decider_throw",
			loopId: started.body.activeLoop?.id,
			source,
		});

		assert.equal(polled.status, 200);
		assert.equal(polled.body.ok, true);
		assert.equal(polled.body.activeLoop?.status, "needs_user");
		assert.equal(polled.body.events[0]?.kind, "loop.needs_user");
		assert.match(polled.body.events[0]?.summary ?? "", /decision provider failed/i);
	}, { loopDecider: async () => { throw new Error("planner exploded"); } });
});

test("loop start and poll fail closed for missing capabilities or targets", async () => {
	await withDaemon(async (baseUrl, token, mock) => {
		const denied = await postJson<{ ok: boolean; errors: Array<{ code: string }> }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_denied",
			source: cliSource(),
			targetRef: "surface:42",
			goal: { value: "Do work.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: cliSource().capabilities,
		});
		assert.equal(denied.status, 400);
		assert.equal(denied.body.errors[0]?.code, "capability_denied");

		const source = piCommandSource();
		const started = await postJson<{ activeLoop?: { id: string } }>(baseUrl, token, "/loops/start", {
			requestId: "req_loop_start_missing_target",
			source,
			targetRef: "surface:42",
			goal: { value: "Do work.", redaction: { status: "not_needed" } },
			maxTurns: 4,
			pollIntervalMs: 3_000,
			allowedCapabilities: source.capabilities,
		});
		mock.setTargets([]);
		const polled = await postJson<{ ok: boolean; activeLoop?: { status: string }; events: Array<{ kind: string }> }>(baseUrl, token, "/loops/poll", {
			requestId: "req_loop_poll_missing_target",
			loopId: started.body.activeLoop?.id,
			source,
		});
		assert.equal(polled.status, 200);
		assert.equal(polled.body.ok, true);
		assert.equal(polled.body.events[0]?.kind, "loop.needs_user");
		assert.equal(polled.body.activeLoop?.status, "failed");
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
		{ host: "127.0.0.1", port: 0, authToken: "test-token", storageDir: null },
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

test("dashboard renderer includes local operator UI without query-token patterns", () => {
	const html = renderDashboardHtml();
	assert.match(html, /Alfred Local Dashboard/);
	assert.match(html, /Local authentication/);
	assert.match(html, /daemon token printed in the terminal/i);
	assert.match(html, /Daemon health/);
	assert.match(html, /Ask Alfred/);
	assert.match(html, /Active loop/);
	assert.match(html, /Pending action cards/);
	assert.match(html, /Visible surfaces and workspaces/);
	assert.match(html, /Recent activity/);
	assert.match(html, /Storage warnings/);
	assert.match(html, /localStorage/);
	assert.match(html, /x-alfred-auth/);
	assert.match(html, /api\('\/ask'/);
	assert.match(html, /api\('\/confirm'/);
	assert.match(html, /api\('\/cancel'/);
	assert.equal(html.includes("test-token"), false);
	assert.equal(html.includes("URLSearchParams"), false);
	assert.equal(html.includes("location.search"), false);
	assert.equal(html.includes("innerHTML"), false);
});

test("dashboard route renders local UI without exposing daemon state", async () => {
	await withDaemon(async (baseUrl, token) => {
		const dashboard = await fetch(`${baseUrl}/dashboard`);
		assert.equal(dashboard.status, 200);
		assert.equal(dashboard.headers.get("content-type")?.includes("text/html"), true);
		assert.equal(dashboard.headers.get("cache-control"), "no-store");
		assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff");
		assert.match(dashboard.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.match(dashboard.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
		assert.equal(dashboard.headers.has("access-control-allow-origin"), false);
		const html = await dashboard.text();
		assert.match(html, /Alfred Local Dashboard/);
		assert.match(html, /\/state/);
		assert.match(html, /\/ask/);
		assert.match(html, /\/surfaces/);
		assert.match(html, /pending action/i);
		assert.match(html, /Confirm send/);
		assert.match(html, /Cancel draft/);
		assert.match(html, /x-alfred-auth/);
		assert.equal(html.includes(token), false);
		assert.equal(html.includes("URLSearchParams"), false);
		assert.equal(html.includes("location.search"), false);

		const badOrigin = await fetch(`${baseUrl}/dashboard`, { headers: { origin: "https://evil.test" } });
		assert.equal(badOrigin.status, 403);
	});
});

test("daemon reports contract error codes for unsupported and missing routes", async () => {
	await withDaemon(async (baseUrl, token) => {
		const directSend = await fetch(`${baseUrl}/send`, {
			method: "POST",
			headers: { ...authHeaders(token), "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(directSend.status, 501);
		const directSendBody = await directSend.json() as { error: { code: string } };
		assert.equal(directSendBody.error.code, "unsupported_action");

		const missing = await fetch(`${baseUrl}/missing`, { headers: authHeaders(token) });
		assert.equal(missing.status, 404);
		const missingBody = await missing.json() as { error: { code: string } };
		assert.equal(missingBody.error.code, "not_found");
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
		{ host: "127.0.0.1", port: 0, authToken: "test-token", storageDir: null },
		{
			cmux: {
				async listTargets() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async readSurface() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async sendTextToSurface() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async sendTextToWorkspace() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
				async openDiff() { return { ok: false, error: { code: "command_failed", message: "cmux missing" } }; },
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
