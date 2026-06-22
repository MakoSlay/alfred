import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AlfredAction,
	AlfredCapability,
	AlfredDraft,
	AlfredError,
	AlfredEvent,
	AlfredHandleRequest,
	AlfredHandleResponse,
	AlfredId,
	AlfredLoopSummary,
	AlfredRef,
	AlfredSendAction,
	AlfredSource,
	AlfredTarget,
	IsoTimestamp,
	PendingAction,
	RedactedText,
	RetentionMetadata,
} from "../contracts/runtime.ts";
import { DEFAULT_DRAFT_TTL_MS, redactedText, sourceHasCapabilities } from "../contracts/runtime.ts";
import { createCmuxWorldModelAdapter, type CmuxResult, type CmuxWorldModelAdapter } from "../cmux/index.ts";
import { renderDashboardHtml } from "../dashboard/index.ts";
import { formatHostForUrl } from "../lib/host-formatting.ts";
import { buildPlannerInput, plannerInputSummary, validatePlannerResult, type AlfredPlanner, type AlfredPlannerIntent, type AlfredPlannerResult } from "../planner/index.ts";
import { createAlfredLoopManager, type AlfredLoopDecision, type AlfredLoopManager, type AlfredLoopRuntimeState, type AlfredLoopScheduler, type AlfredLoopStartRequest } from "../loops/index.ts";
import { createJsonFileStorage, defaultAlfredStorageDir, type AlfredStorageAdapter } from "../storage/index.ts";
import { createActionRegistry, registerBuiltinActions, type ActionRegistry } from "../actions/index.ts";

export interface AlfredDaemonConfig {
	readonly host: string;
	readonly port: number;
	readonly authToken: string;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly maxBodyBytes: number;
	readonly storageDir?: string | null;
}

export interface AlfredDaemonStateSnapshot {
	health: "ok" | "degraded";
	pendingActions: PendingAction[];
	pendingDrafts: AlfredDraft[];
	activeLoop: AlfredLoopSummary | null;
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
	storageWarnings?: string[];
}

type AlfredDaemonCmux = Pick<CmuxWorldModelAdapter, "listTargets" | "readSurface" | "sendTextToSurface" | "sendTextToWorkspace" | "sendKeyToSurface" | "openDiff">;

export interface AlfredDaemonDependencies {
	cmux?: AlfredDaemonCmux;
	now?: () => Date;
	planner?: AlfredPlanner;
	loopDecider?: (loop: AlfredLoopRuntimeState, transcript: string) => Promise<AlfredLoopDecision>;
	loopScheduler?: AlfredLoopScheduler;
	loopManager?: AlfredLoopManager;
	storage?: AlfredStorageAdapter | null;
}

export interface AlfredDaemon {
	readonly config: AlfredDaemonConfig;
	start(): Promise<{ host: string; port: number; authToken: string }>;
	stop(): Promise<void>;
}

export interface AlfredConfirmRequest {
	requestId?: string;
	/** Legacy alias for a pending cmux.sendText action id. */
	draftId?: string;
	/** Canonical pending action id. */
	pendingActionId?: string;
	/** Optional edited draft text supplied by a pending action card before approval. */
	text?: string;
	source?: AlfredSource;
}

export interface AlfredCancelRequest {
	requestId?: string;
	/** Legacy alias for a pending action id. */
	draftId?: string;
	pendingActionId?: string;
	source?: AlfredSource;
	reason?: string;
}

export interface AlfredLoopPollRequest {
	requestId?: string;
	loopId?: AlfredId;
	source?: AlfredSource;
}

export interface AlfredLoopStopRequest {
	requestId?: string;
	loopId?: AlfredId;
	source?: AlfredSource;
	interruptTarget?: boolean;
	reason?: string;
}

interface DaemonState {
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
	actions: ActionRegistry;
	storage?: AlfredStorageAdapter;
	storageWarnings: string[];
}

interface DraftIntent {
	target: AlfredTarget;
	message: string;
	confidence: AlfredTarget["confidence"];
}

interface KeyIntent {
	target: AlfredTarget;
	key: string;
	confidence: AlfredTarget["confidence"];
}

interface PlannerDraftResolution {
	ok: boolean;
	intent?: DraftIntent;
	error?: AlfredError;
}

export function defaultDaemonConfig(overrides: Partial<AlfredDaemonConfig> = {}): AlfredDaemonConfig {
	const host = overrides.host ?? "127.0.0.1";
	const port = overrides.port ?? 47_321;
	const originHost = formatHostForUrl(host);
	return {
		host,
		port,
		authToken: overrides.authToken ?? process.env.ALFRED_LOCAL_TOKEN ?? randomBytes(24).toString("base64url"),
		allowedHosts: overrides.allowedHosts ?? ["127.0.0.1", "localhost", "::1", "[::1]"],
		allowedOrigins: overrides.allowedOrigins ?? [...new Set([`http://${originHost}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`])],
		maxBodyBytes: overrides.maxBodyBytes ?? 128 * 1024,
		storageDir: overrides.storageDir === null ? null : overrides.storageDir ?? defaultAlfredStorageDir(),
	};
}

export function createAlfredDaemon(
	config: Partial<AlfredDaemonConfig> = {},
	dependencies: AlfredDaemonDependencies = {},
): AlfredDaemon {
	const resolvedConfig = defaultDaemonConfig(config);
	const storage = dependencies.storage === null ? undefined : dependencies.storage ?? (resolvedConfig.storageDir ? createJsonFileStorage({ appDir: resolvedConfig.storageDir }) : undefined);
	const cmux = dependencies.cmux ?? createCmuxWorldModelAdapter();
	const now = dependencies.now ?? (() => new Date());
	const actions = createActionRegistry({ now, nextId, defaultTtlMs: DEFAULT_DRAFT_TTL_MS });
	registerBuiltinActions(actions);
	const state: DaemonState = { recentTargets: [], events: [], actions, storage, storageWarnings: [] };
	const planner = dependencies.planner;
	const loopManager = dependencies.loopManager ?? createAlfredLoopManager({ cmux, now, nextId, decide: dependencies.loopDecider, scheduler: dependencies.loopScheduler });
	const server = http.createServer((request, response) => {
		void handleDaemonRequest(request, response, resolvedConfig, state, cmux, now, planner, loopManager);
	});

	return {
		config: resolvedConfig,
		async start() {
			loadPersistedState(state, now().toISOString());
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					server.off("error", onStartupError);
					reject(new Error("Startup timed out after 10s"));
				}, 10_000);
				const onStartupError = (error: Error) => {
					clearTimeout(timeout);
					reject(error);
				};
				server.once("error", onStartupError);
				server.listen(resolvedConfig.port, resolvedConfig.host, () => {
					clearTimeout(timeout);
					server.off("error", onStartupError);
					server.on("error", () => undefined);
					resolve();
				});
			});
			const address = server.address() as AddressInfo;
			return { host: resolvedConfig.host, port: address.port, authToken: resolvedConfig.authToken };
		},
		async stop() {
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
				server.close((error) => {
					clearTimeout(forceClose);
					error ? reject(error) : resolve();
				});
				server.closeIdleConnections();
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
	planner?: AlfredPlanner,
	loopManager?: AlfredLoopManager,
): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
	const authOptionalRoute = request.method === "GET" && (url.pathname === "/health" || url.pathname === "/" || url.pathname === "/dashboard");
	const guard = guardRequest(request, config, { requireAuth: !authOptionalRoute });
	if (!guard.ok) {
		writeJson(response, guard.status, { ok: false, error: guard.error });
		return;
	}

	if (request.method === "GET" && url.pathname === "/health") {
		writeJson(response, 200, { ok: true, health: "ok" });
		return;
	}

	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
		writeHtml(response, renderDashboardHtml());
		return;
	}

	pruneExpiredDrafts(state, now().toISOString());

	if (request.method === "GET" && url.pathname === "/state") {
		writeJson(response, 200, snapshotState(state, loopManager, now().toISOString()));
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
		rememberTargets(state, targets.value, now().toISOString());
		writeJson(response, 200, { ok: true, targets: targets.value });
		return;
	}

	if (request.method === "POST" && (url.pathname === "/ask" || url.pathname === "/handle")) {
		const body = await readJsonBody<AlfredHandleRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = await handleRequest(body.value, state, cmux, now, planner);
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

	if (request.method === "POST" && url.pathname === "/loops/start") {
		const body = await readJsonBody<AlfredLoopStartRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const startRequest = normalizeLoopStartRequest(body.value);
		const result = loopManager ? await loopManager.start(startRequest) : unsupportedLoopResponse(startRequest.requestId, now().toISOString());
		recordResponseEvents(state, result.events);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && url.pathname === "/loops/poll") {
		const body = await readJsonBody<AlfredLoopPollRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = await pollLoop(body.value, state, cmux, now, loopManager);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && url.pathname === "/loops/stop") {
		const body = await readJsonBody<AlfredLoopStopRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = await stopLoop(body.value, state, now, loopManager);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "GET" && url.pathname === "/loops/status") {
		writeJson(response, 200, { ok: true, activeLoop: loopManager?.status(url.searchParams.get("loopId") ?? undefined) ?? null });
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
	planner?: AlfredPlanner,
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
	rememberTargets(state, targets.value, now().toISOString());
	if (isTargetListInput(inputText)) {
		return createTargetsAnswerResponse(request, effectiveSource, targets.value, state, now);
	}
	if (isOpenDiffInput(inputText)) {
		return await executeSafeAction(request, effectiveSource, state, cmux, now, "cmux.openDiff", { unstaged: true });
	}
	const keyIntent = resolveSendKeyIntent(inputText, targets.value, request.context?.currentWorkspaceRef);
	if (keyIntent) {
		return createPendingKeyActionResponse(request, effectiveSource, keyIntent, state, now);
	}
	const draftIntent = resolveDraftIntent(inputText, targets.value, request.context?.currentWorkspaceRef);
	if (draftIntent) {
		return createDraftResponse(request, effectiveSource, draftIntent, state, now);
	}
	if (planner) {
		const plannerInput = buildPlannerInput(request, effectiveSource, targets.value);
		let plannerResult: AlfredPlannerResult;
		try {
			plannerResult = validatePlannerResult(await planner.plan(plannerInput), plannerInputSummary(plannerInput.inputText, plannerInput.maxInputChars));
		} catch {
			plannerResult = validatePlannerResult({ ok: false, errors: [{ code: "llm_unavailable", message: "Planner failed before returning a validated action.", retryable: true }] }, plannerInputSummary(plannerInput.inputText, plannerInput.maxInputChars));
		}
		if (plannerResult.ok && plannerResult.intent?.kind === "draft_message") {
			const resolved = resolvePlannerDraftIntent(plannerResult.intent, targets.value, request.context?.currentWorkspaceRef);
			if (resolved.ok && resolved.intent) {
				return createDraftResponse(request, effectiveSource, resolved.intent, state, now);
			}
			return createNoActionResponse(request, effectiveSource, state, now, {
				errors: resolved.error ? [resolved.error] : [{ code: "target_not_found", message: "Planner draft target could not be resolved.", retryable: false }],
				plannerSummary: plannerResult.sanitizedInputSummary,
			});
		}
		if (!plannerResult.ok) {
			return createNoActionResponse(request, effectiveSource, state, now, { errors: plannerResult.errors, plannerSummary: plannerResult.sanitizedInputSummary });
		}
	}
	return createNoActionResponse(request, effectiveSource, state, now);
}

function createTargetsAnswerResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	targets: readonly AlfredTarget[],
	state: DaemonState,
	now: () => Date,
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const visible = targets.slice(0, 12);
	const lines = visible.map((target) => `- ${target.label} (${target.kind}, ${target.ref})${target.current ? " — current" : ""}`);
	const more = targets.length > visible.length ? `\n…and ${targets.length - visible.length} more.` : "";
	const displayText = targets.length > 0 ? `Visible targets:\n${lines.join("\n")}${more}` : "No cmux targets are visible right now.";
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "world.observed",
		createdAt,
		requestId: request.requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		summary: `Listed ${targets.length} visible target${targets.length === 1 ? "" : "s"}.`,
		data: { targetCount: targets.length },
		redaction: { status: "not_needed" },
		retention: defaultEventRetention(createdAt),
	});
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText,
		proposedActions: [],
		events: [event],
		nextStatePatch: visible[0] ? { rememberTarget: visible[0] } : undefined,
	};
}

async function executeSafeAction(
	request: AlfredHandleRequest,
	source: AlfredSource,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	actionId: string,
	input: Record<string, unknown>,
	target?: AlfredTarget,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const proposed = state.actions.propose({ actionId, input, source, target, editable: false });
	if (!proposed.ok) {
		const event = recordActionEvent(state, proposed.event);
		return {
			requestId: request.requestId,
			createdAt,
			ok: false,
			displayText: proposed.decision.message,
			proposedActions: [],
			events: [event],
			errors: [{ code: proposed.decision.reason === "capability_missing" ? "capability_denied" : "unsupported_action", message: proposed.decision.message, retryable: false }],
		};
	}
	const proposedEvent = recordActionEvent(state, proposed.event);
	const executed = await state.actions.execute(proposed.pending.id, {
		source,
		target,
		requestId: request.requestId,
		now,
		cmux: cmux as never,
	});
	const executedEvent = recordActionEvent(state, executed.event);
	return {
		requestId: request.requestId,
		createdAt: executed.event.createdAt,
		ok: executed.ok,
		displayText: executed.ok ? executed.event.summary : `Alfred could not execute ${actionId}: ${executed.event.summary}`,
		proposedActions: [],
		events: [proposedEvent, executedEvent],
		errors: executed.ok ? undefined : [{ code: "unsupported_action", message: executed.event.summary, retryable: true }],
	};
}

function createNoActionResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	state: DaemonState,
	now: () => Date,
	options: { errors?: AlfredError[]; plannerSummary?: RedactedText } = {},
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const events: AlfredEvent[] = [];
	const sanitizedErrors = options.errors?.slice(0, 5);
	if (sanitizedErrors && sanitizedErrors.length > 0) {
		events.push(pushEvent(state, {
			id: nextId("evt"),
			kind: "error.raised",
			createdAt,
			requestId: request.requestId,
			source: { kind: source.kind, id: source.id, label: source.label },
			summary: `Planner proposal ignored: ${sanitizedErrors[0]?.code ?? "unsupported_action"}.`,
			data: {
				codes: sanitizedErrors.map((error) => error.code),
				plannerInput: options.plannerSummary?.value,
			},
			redaction: options.plannerSummary?.redaction ?? { status: "unknown" },
			retention: defaultEventRetention(createdAt),
		}));
	}
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "request.received",
		createdAt,
		requestId: request.requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		summary: `Handled ${source.kind} request without executing privileged actions.`,
		redaction: { status: "not_needed" },
		retention: defaultEventRetention(createdAt),
	});
	events.push(event);
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText: "Alfred daemon received the request. No privileged action was needed.",
		proposedActions: [],
		events,
		errors: sanitizedErrors,
		nextStatePatch: request.context?.visibleTargets?.[0] ? { rememberTarget: request.context.visibleTargets[0] } : undefined,
	};
}

function createPendingKeyActionResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	intent: KeyIntent,
	state: DaemonState,
	now: () => Date,
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const proposed = state.actions.propose({
		actionId: "cmux.sendKey",
		input: { key: intent.key, targetRef: intent.target.ref },
		source,
		target: { ...intent.target, confidence: intent.confidence },
		editable: false,
		ttlMs: DEFAULT_DRAFT_TTL_MS,
	});
	if (!proposed.ok) {
		recordActionEvent(state, proposed.event);
		return capabilityDeniedResponse(request.requestId, createdAt, proposed.decision.message);
	}
	const event = recordActionEvent(state, proposed.event);
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		speech: source.presentation?.wantsSpeech ? `Shall I send ${intent.key} to ${intent.target.label}, sir?` : undefined,
		displayText: `Pending action ready: send key ${intent.key} to ${intent.target.label}. Confirm before executing.`,
		proposedActions: [],
		pendingAction: proposed.pending,
		events: [event],
		nextStatePatch: { rememberTarget: intent.target },
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
	const proposed = state.actions.propose({
		actionId: "cmux.sendText",
		input: { text: intent.message, targetRef: intent.target.ref },
		source,
		target: { ...intent.target, confidence: intent.confidence },
		editable: true,
		ttlMs: DEFAULT_DRAFT_TTL_MS,
	});
	if (!proposed.ok) {
		recordActionEvent(state, proposed.event);
		return capabilityDeniedResponse(request.requestId, createdAt, proposed.decision.message);
	}
	const pending = proposed.pending;
	const draft = draftFromPendingAction(pending);
	if (!draft) {
		return capabilityDeniedResponse(request.requestId, createdAt, "Pending action could not be represented as a draft.");
	}
	const action: AlfredAction = draftActionFromPending(pending, source, requiredCapabilities, draft);
	recordActionEvent(state, proposed.event);
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.created",
		createdAt,
		requestId: request.requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: draft.target,
		actionId: pending.id,
		summary: `Created draft for ${draft.target.label}.`,
		redaction: draft.text.redaction,
		retention: { policy: "session", expiresAt: pending.expiresAt },
	});
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		speech: source.presentation?.wantsSpeech ? `Shall I send that to ${draft.target.label}, sir?` : undefined,
		displayText: `Draft ready for ${draft.target.label}. Confirm before sending.`,
		proposedActions: [action],
		pendingAction: pending,
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
	const pending = findPendingActionForApproval(state, request.pendingActionId, request.draftId);
	if (pending?.actionMetaId === "cmux.sendText") {
		return await confirmSendPendingAction(request, state, cmux, now, pending);
	}
	return await confirmGenericPendingAction(request, state, cmux, now, pending ?? null);
}

async function confirmSendPendingAction(
	request: AlfredConfirmRequest,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	pending: PendingAction | null,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_confirm");
	const draft = pending ? draftFromPendingAction(pending) : null;
	if (!pending || !draft) {
		return pendingActionNotFoundResponse(requestId, createdAt, "confirm");
	}
	if (draft.expiresAt <= createdAt) {
		const approved = state.actions.approve(pending.id, request.source ?? pending.proposedBy, pending.target);
		const expiredEvent = approved.event ? recordActionEvent(state, approved.event) : pushEvent(state, {
			id: nextId("evt"),
			kind: "action.expired",
			createdAt,
			requestId,
			target: draft.target,
			actionId: pending.id,
			summary: `Pending action ${pending.label} has expired.`,
			redaction: draft.text.redaction,
			retention: { policy: "session" },
		});
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "That pending action has expired.",
			proposedActions: [],
			events: [expiredEvent],
			errors: [{ code: "confirmation_expired", message: "Pending action confirmation expired.", retryable: false }],
		};
	}
	const source = request.source ?? pending.proposedBy;
	const targets = await cmux.listTargets();
	if (!targets.ok) {
		return cmuxUnavailableResponse(requestId, createdAt, targets.error.message);
	}
	rememberTargets(state, targets.value, now().toISOString());
	const liveTarget = findLiveTarget(targets.value, draft.target);
	if (!liveTarget) {
		pending.status = "failed";
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
	let draftToSend = draft;
	if (request.text !== undefined) {
		const editedText = request.text.trim();
		if (!editedText) {
			return invalidRequestResponse(requestId, createdAt, "Edited draft text must be non-empty.");
		}
		const edited = state.actions.updateInput(pending.id, { text: editedText, targetRef: liveTarget.ref }, source, liveTarget);
		if (edited.event) recordActionEvent(state, edited.event);
		if (!edited.ok || !edited.pending) {
			return capabilityDeniedResponse(requestId, createdAt, edited.decision?.message ?? "Pending action could not be edited.");
		}
		draftToSend = draftFromPendingAction(edited.pending) ?? draftToSend;
	}
	const requiredCapabilities = requiredSendCapabilities(liveTarget);
	if (!sourceHasCapabilities(source, requiredCapabilities)) {
		return capabilityDeniedResponse(requestId, createdAt, `Source lacks ${requiredCapabilities.join(", ")} capability.`);
	}
	if (!targetHasCapabilities(liveTarget, requiredCapabilities)) {
		return capabilityDeniedResponse(requestId, createdAt, `Target ${liveTarget.label} does not support ${requiredCapabilities.join(", ")}.`);
	}
	const approved = state.actions.approve(pending.id, source, liveTarget);
	const approvedEvent = approved.event ? recordActionEvent(state, approved.event) : null;
	if (!approved.ok || !approved.pending) {
		const code = approved.pending?.status === "expired" ? "confirmation_expired" : "capability_denied";
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: approved.event?.summary ?? "Pending action could not be approved.",
			proposedActions: [],
			events: approvedEvent ? [approvedEvent] : [],
			errors: [{ code, message: approved.event?.summary ?? "Pending action could not be approved.", retryable: false }],
		};
	}
	const confirmedEvent = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.confirmed",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		actionId: pending.id,
		summary: `Confirmed draft for ${liveTarget.label}.`,
		redaction: draftToSend.text.redaction,
		retention: { policy: "session", expiresAt: draftToSend.expiresAt },
	});
	pushEvent(state, {
		id: nextId("evt"),
		kind: "send.started",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		actionId: pending.id,
		summary: `Started send to ${liveTarget.label}.`,
		redaction: draftToSend.text.redaction,
		retention: defaultEventRetention(createdAt),
	});
	const executed = await state.actions.execute(pending.id, {
		source,
		target: liveTarget,
		requestId,
		now,
		cmux: cmux as never,
	});
	const executedEvent = recordActionEvent(state, executed.event);
	if (!executed.ok) {
		const failedEvent = pushSendFailedEvent(state, requestId, now().toISOString(), source, draftToSend, executed.event.summary, liveTarget);
		return {
			requestId,
			createdAt: failedEvent.createdAt,
			ok: false,
			displayText: `I could not send that to ${liveTarget.label}. ${executed.event.summary}`,
			proposedActions: [sendAction(draftToSend, source, failedEvent.createdAt, "failed", executed.event.summary, liveTarget)],
			events: [confirmedEvent, executedEvent, failedEvent],
			errors: [{ code: "send_failed", message: executed.event.summary, retryable: true }],
		};
	}
	const sentAt = now().toISOString();
	const succeededEvent = pushEvent(state, {
		id: nextId("evt"),
		kind: "send.succeeded",
		createdAt: sentAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: liveTarget,
		actionId: pending.id,
		summary: `Sent draft to ${liveTarget.label}.`,
		redaction: draftToSend.text.redaction,
		retention: { policy: "short", expiresAt: new Date(Date.parse(sentAt) + 24 * 60 * 60 * 1000).toISOString(), reason: "send audit event" },
	});
	return {
		requestId,
		createdAt: sentAt,
		ok: true,
		speech: source.presentation?.wantsSpeech ? `I have sent that to ${liveTarget.label}, sir.` : undefined,
		displayText: `Sent draft to ${liveTarget.label}.`,
		proposedActions: [sendAction(draftToSend, source, sentAt, "succeeded", undefined, liveTarget)],
		events: [confirmedEvent, executedEvent, succeededEvent],
		nextStatePatch: { rememberTarget: liveTarget, rememberDraftId: null, rememberLastSentText: draftToSend.text },
	};
}

async function confirmGenericPendingAction(
	request: AlfredConfirmRequest,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	pending: PendingAction | null,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_confirm");
	if (!pending) {
		return pendingActionNotFoundResponse(requestId, createdAt, "confirm");
	}
	const source = request.source ?? pending.proposedBy;
	if (pending.expiresAt <= createdAt) {
		const approved = state.actions.approve(pending.id, source, pending.target);
		const expiredEvent = approved.event ? recordActionEvent(state, approved.event) : null;
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "That pending action has expired.",
			proposedActions: [],
			events: expiredEvent ? [expiredEvent] : [],
			errors: [{ code: "confirmation_expired", message: "Pending action confirmation expired.", retryable: false }],
		};
	}
	if (request.text !== undefined) {
		return invalidRequestResponse(requestId, createdAt, "Text edits are only supported for pending cmux.sendText actions.");
	}
	const resolved = await resolveLivePendingTarget(pending, state, cmux, now, requestId, createdAt);
	if (!resolved.ok) return resolved.response;
	const approved = state.actions.approve(pending.id, source, resolved.target);
	const approvedEvent = approved.event ? recordActionEvent(state, approved.event) : null;
	if (!approved.ok || !approved.pending) {
		const code = approved.pending?.status === "expired" ? "confirmation_expired" : "capability_denied";
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: approved.event?.summary ?? "Pending action could not be approved.",
			proposedActions: [],
			events: approvedEvent ? [approvedEvent] : [],
			errors: [{ code, message: approved.event?.summary ?? "Pending action could not be approved.", retryable: false }],
		};
	}
	const executed = await state.actions.execute(pending.id, {
		source,
		target: resolved.target,
		requestId,
		now,
		cmux: cmux as never,
	});
	const executedEvent = recordActionEvent(state, executed.event);
	return {
		requestId,
		createdAt: executed.event.createdAt,
		ok: executed.ok,
		displayText: executed.ok ? executed.event.summary : `Alfred could not execute ${pending.label}: ${executed.event.summary}`,
		proposedActions: [],
		events: [approvedEvent, executedEvent].filter((event): event is AlfredEvent => Boolean(event)),
		errors: executed.ok ? undefined : [{ code: "unsupported_action", message: executed.event.summary, retryable: true }],
		nextStatePatch: resolved.target ? { rememberTarget: resolved.target, rememberDraftId: null } : { rememberDraftId: null },
	};
}

function cancelDraft(request: AlfredCancelRequest, state: DaemonState, now: () => Date): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_cancel");
	const pending = findPendingActionForCancel(state, request.pendingActionId, request.draftId);
	if (!pending) {
		return pendingActionNotFoundResponse(requestId, createdAt, "cancel");
	}
	const draft = draftFromPendingAction(pending);
	const source = request.source ?? pending.proposedBy;
	const cancelled = state.actions.cancel(pending.id, request.reason);
	const actionCancelledEvent = cancelled.event ? recordActionEvent(state, cancelled.event) : null;
	if (!cancelled.ok) {
		return {
			requestId,
			createdAt,
			ok: false,
			displayText: "That pending action can no longer be cancelled.",
			proposedActions: [],
			events: actionCancelledEvent ? [actionCancelledEvent] : [],
			errors: [{ code: "confirmation_expired", message: "Pending action is no longer cancellable.", retryable: false }],
		};
	}
	if (!draft) {
		return {
			requestId,
			createdAt,
			ok: true,
			displayText: `Cancelled ${pending.label}.`,
			proposedActions: [],
			events: actionCancelledEvent ? [actionCancelledEvent] : [],
			nextStatePatch: { rememberDraftId: null },
		};
	}
	const event = pushEvent(state, {
		id: nextId("evt"),
		kind: "draft.cancelled",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		target: draft.target,
		actionId: pending.id,
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
		events: [event, actionCancelledEvent].filter((item): item is AlfredEvent => Boolean(item)),
		nextStatePatch: { rememberDraftId: null },
	};
}

function normalizeLoopStartRequest(request: AlfredLoopStartRequest): AlfredLoopStartRequest {
	return {
		...request,
		requestId: request.requestId ?? nextId("req_loop_start"),
		goal: request.goal ?? redactedText(""),
		allowedCapabilities: request.allowedCapabilities ?? request.source?.capabilities ?? [],
	};
}

async function pollLoop(
	request: AlfredLoopPollRequest,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	loopManager?: AlfredLoopManager,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_loop_poll");
	if (!request.source || !Array.isArray(request.source.capabilities)) {
		return invalidLoopControlSourceResponse(requestId, createdAt);
	}
	if (!sourceHasCapabilities(request.source, ["loop.manage"])) {
		return capabilityDeniedResponse(requestId, createdAt, "Missing loop.manage capability");
	}
	const active = loopManager?.active();
	const loopId = request.loopId ?? active?.summary.id;
	if (!loopManager || !loopId || !active || active.summary.id !== loopId) {
		return loopErrorResponse(requestId, createdAt, "There is no active loop to poll.", { code: "loop_not_found", message: "Loop not found.", retryable: false });
	}
	const decision = await loopManager.poll(loopId);
	if (decision.kind === "draft_reply") {
		return await handleLoopDraftReply(requestId, decision, state, cmux, now, loopManager);
	}
	const event = pushLoopDecisionEvent(state, requestId, createdAt, active, decision);
	return {
		requestId,
		createdAt,
		ok: true,
		displayText: loopDecisionDisplayText(decision, active.summary.target.label),
		proposedActions: [],
		activeLoop: loopManager.status(loopId) ?? active.summary,
		events: [event],
		nextStatePatch: { activeLoopId: loopManager.status(loopId)?.id ?? null },
	};
}

async function handleLoopDraftReply(
	requestId: AlfredId,
	decision: Extract<AlfredLoopDecision, { kind: "draft_reply" }>,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	loopManager: AlfredLoopManager,
): Promise<AlfredHandleResponse> {
	const active = loopManager.active();
	const createdAt = now().toISOString();
	if (!active) {
		return loopErrorResponse(requestId, createdAt, "There is no active loop to poll.", { code: "loop_not_found", message: "Loop not found.", retryable: false });
	}
	if (!sourceHasCapabilities(active.source, ["loop.autonomousSend"])) {
		const draftResponse = createDraftResponse({
			requestId,
			createdAt,
			source: active.source,
			input: { text: "loop draft reply" },
			context: { currentWorkspaceRef: active.summary.target.workspaceRef, currentSurfaceRef: active.summary.target.surfaceRef },
			policy: { requireConfirmationForSend: true },
		}, active.source, { target: active.summary.target, message: decision.message, confidence: active.summary.target.confidence ?? "unknown" }, state, now);
		if (draftResponse.ok) {
			loopManager.recordReplyDrafted(active.summary.id);
			const event = pushLoopLifecycleEvent(state, requestId, now().toISOString(), active, "loop.replied", "Drafted loop reply pending confirmation.", redactedText(decision.message).redaction);
			return {
				...draftResponse,
				displayText: `${draftResponse.displayText} Loop reply is pending confirmation.`,
				activeLoop: loopManager.status(active.summary.id) ?? active.summary,
				events: [...draftResponse.events, event],
				nextStatePatch: { ...draftResponse.nextStatePatch, activeLoopId: active.summary.id },
			};
		}
		loopManager.recordReplyFailed(active.summary.id, "needs_user");
		return { ...draftResponse, activeLoop: loopManager.status(active.summary.id) ?? undefined, nextStatePatch: { ...draftResponse.nextStatePatch, activeLoopId: active.summary.id } };
	}
	return await sendAutonomousLoopReply(requestId, decision.message, state, cmux, now, loopManager, active);
}

async function sendAutonomousLoopReply(
	requestId: AlfredId,
	message: string,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	loopManager: AlfredLoopManager,
	active: NonNullable<ReturnType<AlfredLoopManager["active"]>>,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const requiredCapabilities: AlfredCapability[] = [...requiredSendCapabilities(active.summary.target), "loop.autonomousSend"];
	if (!sourceHasCapabilities(active.source, requiredCapabilities)) {
		return capabilityDeniedResponse(requestId, createdAt, `Source lacks ${requiredCapabilities.join(", ")} capability.`);
	}
	const draft: AlfredDraft = {
		id: nextId("draft_loop_autonomous"),
		target: active.summary.target,
		text: redactedText(message),
		createdAt,
		expiresAt: createdAt,
		status: "confirmed",
		createdBy: active.source,
	};
	pushEvent(state, {
		id: nextId("evt"),
		kind: "send.started",
		createdAt,
		requestId,
		source: { kind: active.source.kind, id: active.source.id, label: active.source.label },
		target: active.summary.target,
		summary: `Started autonomous loop reply to ${active.summary.target.label}.`,
		redaction: draft.text.redaction,
		retention: defaultEventRetention(createdAt),
	});
	const sendResult = await sendDraft(cmux, active.summary.target, message);
	if (!sendResult.ok) {
		const failedAt = now().toISOString();
		loopManager.recordReplyFailed(active.summary.id, "failed");
		const failedEvent = pushSendFailedEvent(state, requestId, failedAt, active.source, draft, sendResult.error.message, active.summary.target);
		return {
			requestId,
			createdAt: failedAt,
			ok: false,
			displayText: `Loop reply failed for ${active.summary.target.label}. ${sendResult.error.message}`,
			proposedActions: [sendAction(draft, active.source, failedAt, "failed", sendResult.error.message, active.summary.target)],
			activeLoop: loopManager.status(active.summary.id) ?? active.summary,
			events: [failedEvent],
			errors: [{ code: "send_failed", message: sendResult.error.message, retryable: true }],
		};
	}
	loopManager.recordReplyDrafted(active.summary.id);
	const sentAt = now().toISOString();
	const loopEvent = pushLoopLifecycleEvent(state, requestId, sentAt, active, "loop.replied", `Sent autonomous loop reply to ${active.summary.target.label}.`, draft.text.redaction);
	const sentEvent = pushEvent(state, {
		id: nextId("evt"),
		kind: "send.succeeded",
		createdAt: sentAt,
		requestId,
		source: { kind: active.source.kind, id: active.source.id, label: active.source.label },
		target: active.summary.target,
		summary: `Sent autonomous loop reply to ${active.summary.target.label}.`,
		redaction: draft.text.redaction,
		retention: defaultEventRetention(sentAt),
	});
	return {
		requestId,
		createdAt: sentAt,
		ok: true,
		displayText: `Loop reply sent to ${active.summary.target.label}.`,
		proposedActions: [sendAction(draft, active.source, sentAt, "succeeded", undefined, active.summary.target)],
		activeLoop: loopManager.status(active.summary.id) ?? active.summary,
		events: [loopEvent, sentEvent],
		nextStatePatch: { activeLoopId: active.summary.id },
	};
}

async function stopLoop(
	request: AlfredLoopStopRequest,
	state: DaemonState,
	now: () => Date,
	loopManager?: AlfredLoopManager,
): Promise<AlfredHandleResponse> {
	const createdAt = now().toISOString();
	const requestId = request.requestId ?? nextId("req_loop_stop");
	if (!request.source || !Array.isArray(request.source.capabilities)) {
		return invalidLoopControlSourceResponse(requestId, createdAt);
	}
	if (!sourceHasCapabilities(request.source, ["loop.manage"])) {
		return capabilityDeniedResponse(requestId, createdAt, "Missing loop.manage capability");
	}
	const active = loopManager?.active();
	const loopId = request.loopId ?? active?.summary.id;
	if (!loopManager || !loopId) {
		return loopErrorResponse(requestId, createdAt, "There is no active loop to stop.", { code: "loop_not_found", message: "Loop not found.", retryable: false });
	}
	const result = await loopManager.stop(loopId, { requestId, source: request.source, interruptTarget: request.interruptTarget, reason: request.reason });
	recordResponseEvents(state, result.events);
	return result;
}

function pushLoopDecisionEvent(state: DaemonState, requestId: AlfredId, createdAt: IsoTimestamp, active: NonNullable<ReturnType<AlfredLoopManager["active"]>>, decision: AlfredLoopDecision): AlfredEvent {
	const kind = decision.kind === "wait" ? "loop.waiting" : decision.kind === "done" ? "loop.done" : decision.kind === "needs_user" ? "loop.needs_user" : "loop.replied";
	return pushLoopLifecycleEvent(state, requestId, createdAt, active, kind, loopDecisionDisplayText(decision, active.summary.target.label), active.summary.goal.redaction);
}

function pushLoopLifecycleEvent(
	state: DaemonState,
	requestId: AlfredId,
	createdAt: IsoTimestamp,
	active: NonNullable<ReturnType<AlfredLoopManager["active"]>>,
	kind: Extract<AlfredEvent["kind"], "loop.waiting" | "loop.replied" | "loop.needs_user" | "loop.done" | "loop.stopped" | "loop.started">,
	summary: string,
	redaction: RedactedText["redaction"],
): AlfredEvent {
	return pushEvent(state, {
		id: nextId("evt"),
		kind,
		createdAt,
		requestId,
		source: { kind: active.source.kind, id: active.source.id, label: active.source.label },
		target: active.summary.target,
		loopId: active.summary.id,
		summary,
		redaction,
		retention: defaultEventRetention(createdAt),
	});
}

function loopDecisionDisplayText(decision: AlfredLoopDecision, targetLabel: string): string {
	if (decision.kind === "wait") return decision.reason ? `Loop waiting for ${targetLabel}: ${decision.reason}` : `Loop waiting for ${targetLabel}.`;
	if (decision.kind === "done") return `Loop done for ${targetLabel}: ${decision.summary}`;
	if (decision.kind === "needs_user") return `Loop needs you for ${targetLabel}: ${decision.summary}`;
	return `Loop drafted a reply for ${targetLabel}.`;
}

function loopErrorResponse(requestId: AlfredId, createdAt: IsoTimestamp, displayText: string, error: AlfredError): AlfredHandleResponse {
	return { requestId, createdAt, ok: false, displayText, proposedActions: [], events: [], errors: [error] };
}

function invalidLoopControlSourceResponse(requestId: AlfredId, createdAt: IsoTimestamp): AlfredHandleResponse {
	return loopErrorResponse(requestId, createdAt, "Loop control requires a source with loop.manage capability.", { code: "invalid_request", message: "Loop control requires a source with loop.manage capability.", retryable: false });
}

function unsupportedLoopResponse(requestId: AlfredId, createdAt: IsoTimestamp): AlfredHandleResponse {
	return loopErrorResponse(requestId, createdAt, "Loop manager is unavailable.", { code: "internal_error", message: "Loop manager is unavailable.", retryable: true });
}

function recordResponseEvents(state: DaemonState, events: readonly AlfredEvent[]): void {
	for (const event of [...events].reverse()) {
		pushEvent(state, event);
	}
}

function recordActionEvent(state: DaemonState, event: AlfredEvent): AlfredEvent {
	return pushEvent(state, event);
}

function resolvePlannerDraftIntent(intent: Extract<AlfredPlannerIntent, { kind: "draft_message" }>, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): PlannerDraftResolution {
	const refMatches = intent.targetRef ? targetRefMatches(targets, intent.targetRef) : [];
	if (intent.targetRef && refMatches.length !== 1) {
		return {
			ok: false,
			error: {
				code: refMatches.length > 1 ? "target_ambiguous" : "target_not_found",
				message: refMatches.length > 1 ? "Planner targetRef matched multiple visible targets." : "Planner targetRef did not match a visible target.",
				retryable: false,
			},
		};
	}
	if (intent.targetName) {
		const namedMatches = bestTargetMatches(currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets, normalizeForMatch(intent.targetName));
		if (!intent.targetRef) {
			if (namedMatches.length !== 1) {
				return {
					ok: false,
					error: {
						code: namedMatches.length > 1 ? "target_ambiguous" : "target_not_found",
						message: namedMatches.length > 1 ? "Planner targetName matched multiple visible targets." : "Planner targetName did not match a visible target.",
						retryable: false,
					},
				};
			}
			const target = namedMatches[0]!;
			return { ok: true, intent: { target, message: intent.message, confidence: target.confidence ?? "unknown" } };
		}
		if (namedMatches.length === 1 && refMatches[0] && !sameTarget(namedMatches[0]!, refMatches[0])) {
			return {
				ok: false,
				error: { code: "target_ambiguous", message: "Planner targetRef and targetName identified different visible targets.", retryable: false },
			};
		}
	}
	const target = refMatches[0];
	if (!target) {
		return { ok: false, error: { code: "target_not_found", message: "Planner draft target could not be resolved.", retryable: false } };
	}
	return { ok: true, intent: { target, message: intent.message, confidence: target.confidence ?? "exact" } };
}

function targetRefMatches(targets: AlfredTarget[], targetRef: AlfredRef): AlfredTarget[] {
	return targets.filter((target) => requiredSendCapabilities(target).length > 0 && (target.ref === targetRef || target.surfaceRef === targetRef || target.workspaceRef === targetRef));
}

function sameTarget(left: AlfredTarget, right: AlfredTarget): boolean {
	return left.ref === right.ref || (left.surfaceRef !== undefined && left.surfaceRef === right.surfaceRef);
}

function resolveSendKeyIntent(inputText: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): KeyIntent | null {
	const normalized = inputText.trim();
	const sendKey = normalized.match(/^(?:send\s+key|press)\s+(.+?)\s+(?:to|in|on)\s+(.+)$/i);
	if (!sendKey?.[1] || !sendKey[2]) return null;
	const key = normalizeKeyName(sendKey[1]);
	if (!key) return null;
	const scopedTargets = currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets;
	const matches = bestTargetMatches(scopedTargets, normalizeForMatch(sendKey[2]));
	if (matches.length !== 1) return null;
	const target = matches[0]!;
	return { target, key, confidence: target.confidence ?? "unknown" };
}

function normalizeKeyName(value: string): string {
	return value.trim().replace(/^the\s+/i, "").replace(/\s+/g, " ");
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

function isTargetListInput(inputText: string): boolean {
	return /^(?:what\s+)?(?:targets|surfaces|workspaces)(?:\s+are\s+(?:active|visible|available))?\??$/i.test(inputText.trim())
		|| /^(?:what|which)\s+(?:targets|surfaces|workspaces)\s+(?:are\s+)?(?:active|visible|available)\??$/i.test(inputText.trim());
}

function isOpenDiffInput(inputText: string): boolean {
	return /^(?:open|show)\s+(?:the\s+)?(?:diff|changes)(?:\s+view)?$/i.test(inputText.trim());
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

function findPendingActionForApproval(state: DaemonState, pendingActionId?: string, draftId?: string): PendingAction | null {
	const candidates = state.actions.listPending().filter((pending) => pending.status === "pending");
	if (pendingActionId) return candidates.find((pending) => pending.id === pendingActionId) ?? null;
	if (draftId) return candidates.find((pending) => pending.id === draftId && pending.actionMetaId === "cmux.sendText") ?? null;
	return candidates.find((pending) => pending.actionMetaId === "cmux.sendText") ?? null;
}

function findPendingActionForCancel(state: DaemonState, pendingActionId?: string, draftId?: string): PendingAction | null {
	const candidates = state.actions.listPending().filter((pending) => pending.status === "pending" || pending.status === "approved");
	if (pendingActionId) return candidates.find((pending) => pending.id === pendingActionId) ?? null;
	if (draftId) return candidates.find((pending) => pending.id === draftId && pending.actionMetaId === "cmux.sendText") ?? null;
	return candidates.find((pending) => pending.actionMetaId === "cmux.sendText") ?? null;
}

async function resolveLivePendingTarget(
	pending: PendingAction,
	state: DaemonState,
	cmux: AlfredDaemonCmux,
	now: () => Date,
	requestId: string,
	createdAt: IsoTimestamp,
): Promise<{ ok: true; target?: AlfredTarget } | { ok: false; response: AlfredHandleResponse }> {
	if (!pending.target) return { ok: true };
	const targets = await cmux.listTargets();
	if (!targets.ok) {
		return { ok: false, response: cmuxUnavailableResponse(requestId, createdAt, targets.error.message) };
	}
	rememberTargets(state, targets.value, now().toISOString());
	const liveTarget = findLiveTarget(targets.value, pending.target);
	if (!liveTarget) {
		pending.status = "failed";
		const event = pushEvent(state, {
			id: nextId("evt"),
			kind: "action.failed",
			createdAt,
			requestId,
			target: pending.target,
			actionId: pending.id,
			summary: `Failed ${pending.label}: target disappeared before approval.`,
			redaction: { status: "not_needed" },
			retention: defaultEventRetention(createdAt),
		});
		return {
			ok: false,
			response: {
				requestId,
				createdAt,
				ok: false,
				displayText: `I could not execute ${pending.label}; the target is no longer visible.`,
				proposedActions: [],
				events: [event],
				errors: [{ code: "target_not_found", message: "Target disappeared before approval.", retryable: true }],
			},
		};
	}
	return { ok: true, target: liveTarget };
}

function pendingActionNotFoundResponse(requestId: string, createdAt: IsoTimestamp, operation: "confirm" | "cancel"): AlfredHandleResponse {
	return {
		requestId,
		createdAt,
		ok: false,
		displayText: `There is no pending action to ${operation}.`,
		proposedActions: [],
		events: [],
		errors: [{ code: "confirmation_expired", message: "No pending action was found.", retryable: false }],
	};
}

function findLiveTarget(targets: readonly AlfredTarget[], target: AlfredTarget): AlfredTarget | undefined {
	return targets.find((candidate) => candidate.ref === target.ref || (target.surfaceRef !== undefined && candidate.surfaceRef === target.surfaceRef));
}

function pendingDrafts(state: DaemonState, nowIso?: IsoTimestamp): AlfredDraft[] {
	return state.actions.listPending()
		.filter((pending) => pending.actionMetaId === "cmux.sendText" && pending.status === "pending" && (!nowIso || pending.expiresAt > nowIso))
		.map((pending) => draftFromPendingAction(pending))
		.filter((draft): draft is AlfredDraft => draft !== null);
}

function pendingActions(state: DaemonState, nowIso?: IsoTimestamp): PendingAction[] {
	return state.actions.listPending().filter((pending) => !nowIso || pending.expiresAt > nowIso);
}

function draftFromPendingAction(pending: PendingAction): AlfredDraft | null {
	if (pending.actionMetaId !== "cmux.sendText" || !pending.target || typeof pending.input.text !== "string") return null;
	const status: AlfredDraft["status"] = pending.status === "executed" ? "sent"
		: pending.status === "cancelled" ? "cancelled"
		: pending.status === "expired" ? "expired"
		: pending.status === "failed" || pending.status === "denied" ? "failed"
		: "pending";
	return {
		id: pending.id,
		target: pending.target,
		text: redactedText(pending.input.text),
		createdAt: pending.createdAt,
		expiresAt: pending.expiresAt,
		status,
		createdBy: pending.proposedBy,
	};
}

function draftActionFromPending(pending: PendingAction, source: AlfredSource, requiredCapabilities: AlfredCapability[], draft: AlfredDraft): AlfredAction {
	return {
		id: pending.id,
		kind: "draft",
		createdAt: pending.createdAt,
		requestedBy: source,
		target: draft.target,
		requiredCapabilities,
		status: "pending_confirmation",
		draftText: draft.text,
		confirmBeforeSend: true,
		expiresAt: pending.expiresAt,
	};
}

function pruneExpiredDrafts(_state: DaemonState, _nowIso: IsoTimestamp): void {
	// PendingAction is now the canonical approval model. Expiry is revalidated by
	// approval/execution and compatibility draft lists derive only non-expired records.
}

function pushEvent(state: DaemonState, event: AlfredEvent): AlfredEvent {
	state.events.unshift(event);
	state.events = state.events.slice(0, 100);
	recordStorageWarning(state, state.storage?.appendEvent(event));
	return event;
}

function loadPersistedState(state: DaemonState, nowIso: IsoTimestamp): void {
	if (!state.storage) return;
	const loaded = state.storage.load(nowIso);
	state.events = loaded.events;
	state.recentTargets = loaded.recentTargets;
	state.storageWarnings = loaded.warnings.slice(-20);
	recordStorageWarning(state, state.storage.prune(nowIso));
}

function rememberTargets(state: DaemonState, targets: readonly AlfredTarget[], updatedAt: IsoTimestamp): void {
	state.recentTargets = [...targets];
	recordStorageWarning(state, state.storage?.saveTargets(targets, updatedAt));
}

function recordStorageWarning(state: DaemonState, warning: string | null | undefined): void {
	if (!warning) return;
	state.storageWarnings = [...state.storageWarnings, warning].slice(-20);
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

function guardRequest(
	request: IncomingMessage,
	config: AlfredDaemonConfig,
	options: { requireAuth: boolean } = { requireAuth: true },
): { ok: true } | { ok: false; status: number; error: { code: string; message: string; retryable: boolean } } {
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
	if (options.requireAuth && !authAllowed(request, config.authToken)) {
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

function writeHtml(response: ServerResponse, html: string): void {
	response.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	});
	response.end(html);
}


function snapshotState(state: DaemonState, loopManager?: AlfredLoopManager, nowIso: IsoTimestamp = new Date().toISOString()): AlfredDaemonStateSnapshot {
	return {
		health: state.storageWarnings.length > 0 ? "degraded" : "ok",
		pendingActions: pendingActions(state, nowIso),
		pendingDrafts: pendingDrafts(state, nowIso),
		activeLoop: loopManager?.status() ?? null,
		recentTargets: state.recentTargets,
		events: state.events,
		storageWarnings: state.storageWarnings.length > 0 ? state.storageWarnings : undefined,
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
