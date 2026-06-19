import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AlfredAction,
	AlfredCapability,
	AlfredDraft,
	AlfredEvent,
	AlfredHandleRequest,
	AlfredHandleResponse,
	AlfredRef,
	AlfredSendAction,
	AlfredSource,
	AlfredTarget,
	IsoTimestamp,
	RedactedText,
	RetentionMetadata,
} from "../contracts/runtime.ts";
import { DEFAULT_DRAFT_TTL_MS, redactedText, sourceHasCapabilities } from "../contracts/runtime.ts";
import { createCmuxWorldModelAdapter, type CmuxResult, type CmuxWorldModelAdapter } from "../cmux/index.ts";

export interface AlfredDaemonConfig {
	readonly host: string;
	readonly port: number;
	readonly authToken: string;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly maxBodyBytes: number;
}

export interface AlfredDaemonStateSnapshot {
	health: "ok" | "degraded";
	pendingDrafts: AlfredDraft[];
	activeLoop: null;
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
}

type AlfredDaemonCmux = Pick<CmuxWorldModelAdapter, "listTargets" | "sendTextToSurface" | "sendTextToWorkspace">;

export interface AlfredDaemonDependencies {
	cmux?: AlfredDaemonCmux;
	now?: () => Date;
}

export interface AlfredDaemon {
	readonly config: AlfredDaemonConfig;
	start(): Promise<{ host: string; port: number; authToken: string }>;
	stop(): Promise<void>;
}

export interface AlfredConfirmRequest {
	requestId?: string;
	draftId?: string;
	source?: AlfredSource;
}

export interface AlfredCancelRequest {
	requestId?: string;
	draftId?: string;
	source?: AlfredSource;
	reason?: string;
}

interface DaemonState {
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
	pendingDrafts: AlfredDraft[];
}

interface DraftIntent {
	target: AlfredTarget;
	message: string;
	confidence: AlfredTarget["confidence"];
}

export function defaultDaemonConfig(overrides: Partial<AlfredDaemonConfig> = {}): AlfredDaemonConfig {
	const host = overrides.host ?? "127.0.0.1";
	const port = overrides.port ?? 47_321;
	return {
		host,
		port,
		authToken: overrides.authToken ?? process.env.ALFRED_LOCAL_TOKEN ?? randomBytes(24).toString("base64url"),
		allowedHosts: overrides.allowedHosts ?? ["127.0.0.1", "localhost", "::1", "[::1]"],
		allowedOrigins: overrides.allowedOrigins ?? [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
		maxBodyBytes: overrides.maxBodyBytes ?? 128 * 1024,
	};
}

export function createAlfredDaemon(
	config: Partial<AlfredDaemonConfig> = {},
	dependencies: AlfredDaemonDependencies = {},
): AlfredDaemon {
	const resolvedConfig = defaultDaemonConfig(config);
	const state: DaemonState = { recentTargets: [], events: [], pendingDrafts: [] };
	const cmux = dependencies.cmux ?? createCmuxWorldModelAdapter();
	const now = dependencies.now ?? (() => new Date());
	const server = http.createServer((request, response) => {
		void handleDaemonRequest(request, response, resolvedConfig, state, cmux, now);
	});

	return {
		config: resolvedConfig,
		async start() {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(resolvedConfig.port, resolvedConfig.host, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address() as AddressInfo;
			return { host: resolvedConfig.host, port: address.port, authToken: resolvedConfig.authToken };
		},
		async stop() {
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

async function handleDaemonRequest(
	request: IncomingMessage,
	response: ServerResponse,
	config: AlfredDaemonConfig,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
): Promise<void> {
	const guard = guardRequest(request, config);
	if (!guard.ok) {
		writeJson(response, guard.status, { ok: false, error: guard.error });
		return;
	}

	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
	if (request.method === "GET" && url.pathname === "/health") {
		writeJson(response, 200, { ok: true, health: "ok" });
		return;
	}

	pruneExpiredDrafts(state, now().toISOString());

	if (request.method === "GET" && url.pathname === "/state") {
		writeJson(response, 200, snapshotState(state));
		return;
	}

	if (request.method === "GET" && url.pathname === "/surfaces") {
		const targets = await cmux.listTargets();
		if (!targets.ok) {
			writeJson(response, 503, {
				ok: false,
				error: {
					code: "cmux_unavailable",
					message: targets.error.message,
					retryable: true,
				},
			});
			return;
		}
		state.recentTargets = targets.value;
		writeJson(response, 200, { ok: true, targets: targets.value });
		return;
	}

	if (request.method === "POST" && url.pathname === "/handle") {
		const body = await readJsonBody<AlfredHandleRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = await handleRequest(body.value, state, cmux, now);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && url.pathname === "/confirm") {
		const body = await readJsonBody<AlfredConfirmRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = await confirmDraft(body.value, state, cmux, now);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && url.pathname === "/cancel") {
		const body = await readJsonBody<AlfredCancelRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = cancelDraft(body.value, state, now);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && url.pathname === "/send") {
		writeJson(response, 501, {
			ok: false,
			error: {
				code: "unsupported_action",
				message: "/send direct execution is not enabled. Create a draft and call /confirm instead.",
				retryable: false,
			},
		});
		return;
	}

	writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Route not found", retryable: false } });
}

async function handleRequest(
	request: AlfredHandleRequest,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
): Promise<AlfredHandleResponse> {
	const inputText = request.input?.text?.trim() ?? "";
	if (!inputText) {
		return invalidRequestResponse(request.requestId, now().toISOString(), "input.text is required");
	}
	const effectiveSource = applyAllowedCapabilities(request.source, request.policy?.allowedCapabilities);
	if (!sourceHasCapabilities(effectiveSource, ["world.read"])) {
		return capabilityDeniedResponse(request.requestId, now().toISOString(), "Missing world.read capability");
	}
	if (isConfirmInput(inputText)) {
		return await confirmDraft({ requestId: request.requestId, source: effectiveSource }, state, cmux, now);
	}
	if (isCancelInput(inputText)) {
		return cancelDraft({ requestId: request.requestId, source: effectiveSource, reason: inputText }, state, now);
	}

	const targets = await cmux.listTargets();
	if (!targets.ok) {
		return cmuxUnavailableResponse(request.requestId, now().toISOString(), targets.error.message);
	}
	state.recentTargets = targets.value;
	const draftIntent = resolveDraftIntent(inputText, targets.value, request.context?.currentWorkspaceRef);
	if (draftIntent) {
		return createDraftResponse(request, effectiveSource, draftIntent, state, now);
	}
	const createdAt = now().toISOString();
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "request.received",
		createdAt,
		requestId: request.requestId,
		source: { kind: request.source.kind, id: request.source.id, label: request.source.label },
		summary: `Handled ${request.source.kind} request without executing privileged actions.`,
		redaction: { status: "not_needed" },
		retention: defaultEventRetention(createdAt),
	});
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText: "Alfred daemon received the request. No privileged action was needed.",
		proposedActions: [],
		events: [event],
		nextStatePatch: request.context?.visibleTargets?.[0] ? { rememberTarget: request.context.visibleTargets[0] } : undefined,
	};
}

function createDraftResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	intent: DraftIntent,
	state: DaemonState,
	now: () => Date,
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const requiredCapabilities = requiredSendCapabilities(intent.target);
	if (!targetHasCapabilities(intent.target, requiredCapabilities)) {
		return capabilityDeniedResponse(request.requestId, createdAt, `Target ${intent.target.label} does not support ${requiredCapabilities.join(", ")}.`);
	}
	if (!sourceHasCapabilities(source, requiredCapabilities)) {
		return capabilityDeniedResponse(request.requestId, createdAt, `Source lacks ${requiredCapabilities.join(", ")} capability.`);
	}
	const expiresAt = new Date(Date.parse(createdAt) + DEFAULT_DRAFT_TTL_MS).toISOString();
	const draft: AlfredDraft = {
		id: nextId("draft"),
		target: { ...intent.target, confidence: intent.confidence },
		text: redactedText(intent.message),
		createdAt,
		expiresAt,
		status: "pending",
		createdBy: source,
	};
	state.pendingDrafts.unshift(draft);
	const action: AlfredAction = {
		id: nextId("act"),
		kind: "draft",
		createdAt,
		requestedBy: source,
		target: draft.target,
		requiredCapabilities,
		status: "pending_confirmation",
		draftText: draft.text,
		confirmBeforeSend: true,
		expiresAt,
	};
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.created",
		createdAt,
		requestId: request.requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: draft.target,
		actionId: action.id,
		summary: `Created draft for ${draft.target.label}.`,
		redaction: draft.text.redaction,
		retention: { policy: "session", expiresAt },
	});
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		speech: source.presentation?.wantsSpeech ? `Shall I send that to ${draft.target.label}, sir?` : undefined,
		displayText: `Draft ready for ${draft.target.label}. Confirm before sending.`,
		proposedActions: [action],
		pendingDraft: draft,
		events: [event],
		nextStatePatch: { rememberTarget: draft.target, rememberDraftId: draft.id, rememberLastSpeech: redactedText(`Draft ready for ${draft.target.label}.`) },
	};
}

async function confirmDraft(
	request: AlfredConfirmRequest,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const draft = findPendingDraft(state, request.draftId);
	const requestId = request.requestId ?? nextId("req_confirm");
	if (!draft) {
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "There is no pending draft to confirm.",
			proposedActions: [],
			events: [],
			errors: [{ code: "confirmation_expired", message: "No pending draft was found.", retryable: false }],
		};
	}
	if (draft.expiresAt <= createdAt) {
		draft.status = "expired";
		removePendingDraft(state, draft.id);
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "That draft has expired.",
			proposedActions: [],
			events: [],
			errors: [{ code: "confirmation_expired", message: "Draft confirmation expired.", retryable: false }],
		};
	}
	const source = request.source ?? draft.createdBy;
	const requiredCapabilities = requiredSendCapabilities(draft.target);
	if (!sourceHasCapabilities(source, requiredCapabilities)) {
		return capabilityDeniedResponse(requestId, createdAt, `Source lacks ${requiredCapabilities.join(", ")} capability.`);
	}
	const targets = await cmux.listTargets();
	if (!targets.ok) {
		return cmuxUnavailableResponse(requestId, createdAt, targets.error.message);
	}
	state.recentTargets = targets.value;
	const liveTarget = targets.value.find((target) => target.ref === draft.target.ref || (draft.target.surfaceRef && target.surfaceRef === draft.target.surfaceRef));
	if (!liveTarget) {
		draft.status = "failed";
		removePendingDraft(state, draft.id);
		const failedEvent = pushSendFailedEvent(state, requestId, createdAt, source, draft, "Target disappeared before confirmation.");
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: `I could not send that to ${draft.target.label}; the target is no longer visible.`,
			proposedActions: [sendAction(draft, source, createdAt, "failed", "Target disappeared before confirmation.")],
			events: [failedEvent],
			errors: [{ code: "target_not_found", message: "Target disappeared before confirmation.", retryable: true }],
		};
	}
	const confirmedEvent = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.confirmed",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		summary: `Confirmed draft for ${liveTarget.label}.`,
		redaction: draft.text.redaction,
		retention: { policy: "session", expiresAt: draft.expiresAt },
	});
	draft.status = "confirmed";
	pushEvent(state, {
		id: nextId("evt"),
		kind: "send.started",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		summary: `Started send to ${liveTarget.label}.`,
		redaction: draft.text.redaction,
		retention: defaultEventRetention(createdAt),
	});
	const sendResult = await sendDraft(cmux, liveTarget, draft.text.value);
	if (!sendResult.ok) {
		draft.status = "failed";
		removePendingDraft(state, draft.id);
		const failedEvent = pushSendFailedEvent(state, requestId, now().toISOString(), source, draft, sendResult.error.message, liveTarget);
		return {
			requestId,
			createdAt: failedEvent.createdAt,
			ok: false,
			displayText: `I could not send that to ${liveTarget.label}. ${sendResult.error.message}`,
			proposedActions: [sendAction(draft, source, failedEvent.createdAt, "failed", sendResult.error.message, liveTarget)],
			events: [confirmedEvent, failedEvent],
			errors: [{ code: "send_failed", message: sendResult.error.message, retryable: true }],
		};
	}
	draft.status = "sent";
	removePendingDraft(state, draft.id);
	const sentAt = now().toISOString();
	const succeededEvent = pushEvent(state, {
		id: nextId("evt"),
		kind: "send.succeeded",
		createdAt: sentAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		summary: `Sent draft to ${liveTarget.label}.`,
		redaction: draft.text.redaction,
		retention: { policy: "short", expiresAt: new Date(Date.parse(sentAt) + 24 * 60 * 60 * 1000).toISOString(), reason: "send audit event" },
	});
	return {
		requestId,
		createdAt: sentAt,
		ok: true,
		speech: source.presentation?.wantsSpeech ? `I have sent that to ${liveTarget.label}, sir.` : undefined,
		displayText: `Sent draft to ${liveTarget.label}.`,
		proposedActions: [sendAction(draft, source, sentAt, "succeeded", undefined, liveTarget)],
		events: [confirmedEvent, succeededEvent],
		nextStatePatch: { rememberTarget: liveTarget, rememberDraftId: null, rememberLastSentText: draft.text },
	};
}

function cancelDraft(request: AlfredCancelRequest, state: DaemonState, now: () => Date): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_cancel");
	const draft = findPendingDraft(state, request.draftId);
	if (!draft) {
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "There is no pending draft to cancel.",
			proposedActions: [],
			events: [],
			errors: [{ code: "confirmation_expired", message: "No pending draft was found.", retryable: false }],
		};
	}
	draft.status = "cancelled";
	removePendingDraft(state, draft.id);
	const source = request.source ?? draft.createdBy;
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.cancelled",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: draft.target,
		summary: `Cancelled draft for ${draft.target.label}.`,
		redaction: draft.text.redaction,
		retention: defaultEventRetention(createdAt),
	});
	return {
		requestId,
		createdAt,
		ok: true,
		displayText: `Cancelled draft for ${draft.target.label}.`,
		proposedActions: [{
			id: nextId("act"),
			kind: "cancel",
			createdAt,
			requestedBy: source,
			target: draft.target,
			requiredCapabilities: [],
			status: "cancelled",
			draftId: draft.id,
			reason: request.reason,
		}],
		events: [event],
		nextStatePatch: { rememberDraftId: null },
	};
}

function resolveDraftIntent(inputText: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): DraftIntent | null {
	const normalized = inputText.trim();
	const useSession = normalized.match(/^(?:use|talk to|work with|ask)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+and\s+(.+)$/i);
	if (useSession?.[1] && useSession[2]) {
		return resolveTargetAndMessage(useSession[1], useSession[2], targets, currentWorkspaceRef);
	}
	const askSession = normalized.match(/^(?:ask|tell|message|send)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+(?:to|that|saying)\s+(.+)$/i);
	if (askSession?.[1] && askSession[2]) {
		return resolveTargetAndMessage(askSession[1], askSession[2], targets, currentWorkspaceRef);
	}
	const command = normalized.match(/^(?:tell|send|message|ask)\s+(.+)$/i);
	if (!command?.[1]) return null;
	const tokens = command[1].trim().split(/\s+/).filter(Boolean);
	for (let index = Math.min(tokens.length - 1, 8); index >= 1; index -= 1) {
		const targetPhrase = tokens.slice(0, index).join(" ");
		const message = tokens.slice(index).join(" ").trim();
		if (!message) continue;
		const resolved = resolveTargetAndMessage(targetPhrase, message, targets, currentWorkspaceRef);
		if (resolved) return resolved;
	}
	return null;
}

function resolveTargetAndMessage(targetPhrase: string, message: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): DraftIntent | null {
	const scopedTargets = currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets;
	const matches = bestTargetMatches(scopedTargets, normalizeForMatch(targetPhrase));
	if (matches.length !== 1) return null;
	const target = matches[0]!;
	return { target, message: message.trim(), confidence: target.confidence ?? "unknown" };
}

function prioritizeCurrentWorkspace(targets: AlfredTarget[], currentWorkspaceRef: AlfredRef): AlfredTarget[] {
	const current = targets.filter((target) => target.workspaceRef === currentWorkspaceRef || target.ref === currentWorkspaceRef);
	return current.length > 0 ? current : targets;
}

function bestTargetMatches(targets: AlfredTarget[], normalizedQuery: string): AlfredTarget[] {
	if (!normalizedQuery) return [];
	const sendable = targets.filter((target) => requiredSendCapabilities(target).length > 0);
	const scored = sendable
		.map((target) => ({ target, score: matchScore(target, normalizedQuery) }))
		.filter(({ score }) => score < Number.POSITIVE_INFINITY)
		.sort((left, right) => left.score - right.score || targetKindPriority(left.target) - targetKindPriority(right.target));
	if (scored.length === 0) return [];
	const best = scored[0]?.score ?? Number.POSITIVE_INFINITY;
	return scored.filter(({ score }) => score === best).map(({ target, score }) => ({
		...target,
		confidence: score === 0 ? "exact" : score === 1 ? "prefix" : score === 2 ? "substring" : "fuzzy",
	}));
}

function matchScore(target: AlfredTarget, normalizedQuery: string): number {
	const labels = [target.label, String(target.metadata?.normalizedTitle ?? "")].map(normalizeForMatch).filter(Boolean);
	if (labels.some((label) => label === normalizedQuery)) return 0;
	if (labels.some((label) => label.startsWith(normalizedQuery))) return 1;
	if (labels.some((label) => label.includes(normalizedQuery))) return 2;
	const fuzzyDistance = Math.min(...labels.map((label) => levenshtein(label, normalizedQuery)));
	const shortest = Math.min(...labels.map((label) => label.length));
	return fuzzyDistance <= Math.max(2, Math.floor(shortest * 0.25)) ? 3 + fuzzyDistance / 100 : Number.POSITIVE_INFINITY;
}

function targetKindPriority(target: AlfredTarget): number {
	if (target.kind === "pi-chat" || target.kind === "codex-session" || target.kind === "cmux-surface" || target.kind === "terminal") return 0;
	if (target.kind === "cmux-workspace") return 1;
	return 2;
}

function normalizeForMatch(value: string): string {
	return value.toLowerCase().replace(/^π\s*-\s*/i, "").replace(/[-_\s]+/g, " ").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function isConfirmInput(inputText: string): boolean {
	return /^(yes|send that|confirm|go ahead|do it)$/i.test(inputText.trim());
}

function isCancelInput(inputText: string): boolean {
	return /^(cancel|cancel that|never mind|nevermind|do not send|don't send)$/i.test(inputText.trim());
}

function requiredSendCapabilities(target: AlfredTarget): AlfredCapability[] {
	if (target.kind === "cmux-workspace") return ["workspace.send"];
	if (target.surfaceRef || target.kind === "cmux-surface" || target.kind === "pi-chat" || target.kind === "codex-session" || target.kind === "terminal") return ["surface.send"];
	return [];
}

function targetHasCapabilities(target: AlfredTarget, capabilities: readonly AlfredCapability[]): boolean {
	return capabilities.every((capability) => target.capabilities.includes(capability));
}

async function sendDraft(cmux: AlfredDaemonCmux, target: AlfredTarget, text: string): Promise<CmuxResult<{ ref: string }>> {
	if (target.kind === "cmux-workspace") {
		const result = await cmux.sendTextToWorkspace(target.ref, text);
		return result.ok ? { ok: true, value: { ref: result.value.workspaceRef } } : result;
	}
	const surfaceRef = target.surfaceRef ?? target.ref;
	const result = await cmux.sendTextToSurface(surfaceRef, text);
	return result.ok ? { ok: true, value: { ref: result.value.surfaceRef } } : result;
}

function sendAction(
	draft: AlfredDraft,
	source: AlfredSource,
	createdAt: IsoTimestamp,
	status: AlfredSendAction["status"],
	reason?: string,
	target: AlfredTarget = draft.target,
): AlfredSendAction {
	return {
		id: nextId("act"),
		kind: "send",
		createdAt,
		requestedBy: source,
		target,
		requiredCapabilities: requiredSendCapabilities(target),
		status,
		reason,
		text: draft.text,
		confirmationId: draft.id,
		transport: target.kind === "cmux-workspace" ? "cmux-send-workspace" : "cmux-send-surface",
	};
}

function pushSendFailedEvent(
	state: DaemonState,
	requestId: string,
	createdAt: IsoTimestamp,
	source: AlfredSource,
	draft: AlfredDraft,
	reason: string,
	target: AlfredTarget = draft.target,
): AlfredEvent {
	return pushEvent(state, {
		id: nextId("evt"),
		kind: "send.failed",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target,
		summary: `Failed to send draft to ${target.label}: ${reason}`,
		redaction: draft.text.redaction,
		retention: defaultEventRetention(createdAt),
	});
}

function findPendingDraft(state: DaemonState, draftId?: string): AlfredDraft | undefined {
	return draftId
		? state.pendingDrafts.find((draft) => draft.id === draftId && draft.status === "pending")
		: state.pendingDrafts.find((draft) => draft.status === "pending");
}

function removePendingDraft(state: DaemonState, draftId: string): void {
	state.pendingDrafts = state.pendingDrafts.filter((draft) => draft.id !== draftId);
}

function pruneExpiredDrafts(state: DaemonState, nowIso: IsoTimestamp): void {
	for (const draft of state.pendingDrafts) {
		if (draft.status === "pending" && draft.expiresAt <= nowIso) {
			draft.status = "expired";
		}
	}
	state.pendingDrafts = state.pendingDrafts.filter((draft) => draft.status === "pending");
}

function pushEvent(state: DaemonState, event: AlfredEvent): AlfredEvent {
	state.events.unshift(event);
	state.events = state.events.slice(0, 100);
	return event;
}

function applyAllowedCapabilities(source: AlfredSource, allowedCapabilities?: readonly AlfredCapability[]): AlfredSource {
	if (!allowedCapabilities) return source;
	return {
		...source,
		capabilities: source.capabilities.filter((capability) => allowedCapabilities.includes(capability)),
	};
}

function invalidRequestResponse(requestId: string, createdAt: IsoTimestamp, message: string): AlfredHandleResponse {
	return {
		requestId,
		createdAt,
		ok: false,
		displayText: "Alfred needs input text to handle a request.",
		proposedActions: [],
		events: [],
		errors: [{ code: "invalid_request", message, retryable: false }],
	};
}

function capabilityDeniedResponse(requestId: string, createdAt: IsoTimestamp, message: string): AlfredHandleResponse {
	return {
		requestId,
		createdAt,
		ok: false,
		displayText: message,
		proposedActions: [],
		events: [],
		errors: [{ code: "capability_denied", message, retryable: false }],
	};
}

function cmuxUnavailableResponse(requestId: string, createdAt: IsoTimestamp, message: string): AlfredHandleResponse {
	return {
		requestId,
		createdAt,
		ok: false,
		displayText: `cmux is unavailable: ${message}`,
		proposedActions: [],
		events: [],
		errors: [{ code: "cmux_unavailable", message, retryable: true }],
	};
}

function guardRequest(request: IncomingMessage, config: AlfredDaemonConfig): { ok: true } | { ok: false; status: number; error: { code: string; message: string; retryable: boolean } } {
	if (request.method === "OPTIONS") {
		return { ok: false, status: 403, error: { code: "cors_forbidden", message: "CORS preflight is not allowed for Alfred local control APIs.", retryable: false } };
	}
	const hostHeader = request.headers.host;
	if (!hostHeader || !hostAllowed(hostHeader, config.allowedHosts)) {
		return { ok: false, status: 403, error: { code: "host_forbidden", message: "Host header is not allowed.", retryable: false } };
	}
	const origin = request.headers.origin;
	if (origin && !originAllowed(origin, config.allowedOrigins, config.allowedHosts)) {
		return { ok: false, status: 403, error: { code: "origin_forbidden", message: "Origin is not allowed.", retryable: false } };
	}
	if (request.url !== "/health" && !authAllowed(request, config.authToken)) {
		return { ok: false, status: 401, error: { code: "auth_required", message: "Missing or invalid Alfred local auth token.", retryable: false } };
	}
	return { ok: true };
}

function authAllowed(request: IncomingMessage, authToken: string): boolean {
	const headerToken = request.headers["x-alfred-auth"];
	if (headerToken === authToken) return true;
	const authorization = request.headers.authorization;
	return authorization === `Bearer ${authToken}`;
}

function hostAllowed(hostHeader: string, allowedHosts: readonly string[]): boolean {
	const host = hostHeader.startsWith("[")
		? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
		: hostHeader.split(":")[0] ?? "";
	const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
	return allowedHosts.some((allowed) => allowed.replace(/^\[/, "").replace(/\]$/, "") === normalized);
}

function originAllowed(origin: string, allowedOrigins: readonly string[], allowedHosts: readonly string[]): boolean {
	if (allowedOrigins.includes(origin)) return true;
	try {
		const parsed = new URL(origin);
		return hostAllowed(parsed.host, allowedHosts);
	} catch {
		return false;
	}
}

async function readJsonBody<T>(request: IncomingMessage, maxBytes: number): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let total = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buffer.length;
		if (total > maxBytes) return { ok: false, error: "Request body is too large" };
		chunks.push(buffer);
	}
	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T };
	} catch {
		return { ok: false, error: "Request body must be valid JSON" };
	}
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

function snapshotState(state: DaemonState): AlfredDaemonStateSnapshot {
	return {
		health: "ok",
		pendingDrafts: state.pendingDrafts,
		activeLoop: null,
		recentTargets: state.recentTargets,
		events: state.events,
	};
}

function defaultEventRetention(createdAt: string): RetentionMetadata {
	return {
		policy: "short",
		expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
		reason: "daemon request audit event",
	};
}

function nextId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i += 1) dp[i]![0] = i;
	for (let j = 0; j <= b.length; j += 1) dp[0]![j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		for (let j = 1; j <= b.length; j += 1) {
			dp[i]![j] = Math.min(
				dp[i - 1]![j]! + 1,
				dp[i]![j - 1]! + 1,
				dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dp[a.length]![b.length]!;
}
