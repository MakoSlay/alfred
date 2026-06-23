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
import { buildPlannerInput, plannerInputSummary, validatePlannerResult, type AlfredPlanner, type AlfredPlannerResult } from "../planner/index.ts";
import { createAlfredLoopManager, type AlfredLoopDecision, type AlfredLoopManager, type AlfredLoopRuntimeState, type AlfredLoopScheduler, type AlfredLoopStartRequest } from "../loops/index.ts";
import { createJsonFileStorage, defaultAlfredStorageDir, type AlfredStorageAdapter } from "../storage/index.ts";
import { createActionRegistry, registerBuiltinActions, type ActionRegistry } from "../actions/index.ts";
import { requiredSendCapabilities, resolvePlannerDraftIntent, routeAskBeforeWorld, routeAskWithWorld, targetHasCapabilities, type DraftIntent, type KeyIntent } from "../router/index.ts";

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

type AlfredDaemonCmux = Pick<CmuxWorldModelAdapter, "listTargets" | "readSurface" | "sendTextToSurface" | "sendTextToWorkspace" | "sendKeyToSurface" | "openDiff" | "openMarkdown" | "openUrl" | "listNotifications">;

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
	const preWorldRoute = routeAskBeforeWorld(inputText);
	if (preWorldRoute.kind === "confirm") {
		return await confirmDraft({ requestId: request.requestId, source: effectiveSource }, state, cmux, now);
	}
	if (preWorldRoute.kind === "cancel") {
		return cancelDraft({ requestId: request.requestId, source: effectiveSource, reason: inputText }, state, now);
	}

	const targets = await cmux.listTargets();
	if (!targets.ok) {
		return cmuxUnavailableResponse(request.requestId, now().toISOString(), targets.error.message);
	}
	rememberTargets(state, targets.value, now().toISOString());
	const route = routeAskWithWorld({ inputText, targets: targets.value, currentWorkspaceRef: request.context?.currentWorkspaceRef });
	if (route.kind === "list_targets") {
		return createTargetsAnswerResponse(request, effectiveSource, targets.value, state, now);
	}
	if (route.kind === "current_workspace") {
		return createCurrentWorkspaceAnswerResponse(request, effectiveSource, targets.value, state, now, request.context?.currentWorkspaceRef);
	}
	if (route.kind === "pending_actions") {
		return createPendingActionsAnswerResponse(request, effectiveSource, state, now);
	}
	if (route.kind === "safe_action") {
		return await executeSafeAction(request, effectiveSource, state, cmux, now, route.actionId, route.input);
	}
	if (route.kind === "send_key") {
		return createPendingKeyActionResponse(request, effectiveSource, route.intent, state, now);
	}
	if (route.kind === "draft_message") {
		return createDraftResponse(request, effectiveSource, route.intent, state, now);
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
	const event = pushWorldObservedEvent(state, request.requestId, source, createdAt, `Listed ${targets.length} visible target${targets.length === 1 ? "" : "s"}.`, { targetCount: targets.length });
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

function createCurrentWorkspaceAnswerResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	targets: readonly AlfredTarget[],
	state: DaemonState,
	now: () => Date,
	currentWorkspaceRef?: AlfredRef,
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const workspaceTargets = targets.filter((target) => target.kind === "cmux-workspace" || target.workspaceRef || target.workspaceLabel);
	const current = (currentWorkspaceRef ? workspaceTargets.find((target) => target.ref === currentWorkspaceRef || target.workspaceRef === currentWorkspaceRef) : undefined)
		?? workspaceTargets.find((target) => target.selected)
		?? workspaceTargets.find((target) => target.current)
		?? workspaceTargets[0];
	const workspaceRef = current?.kind === "cmux-workspace" ? current.ref : current?.workspaceRef;
	const workspaceLabel = current?.kind === "cmux-workspace" ? current.label : current?.workspaceLabel;
	const displayText = workspaceRef || workspaceLabel
		? `Current workspace: ${workspaceLabel ?? workspaceRef} (${workspaceRef ?? "unknown ref"}).`
		: "I cannot determine the current workspace from visible cmux targets.";
	const event = pushWorldObservedEvent(state, request.requestId, source, createdAt, "Answered current workspace question.", { workspaceRef: workspaceRef ?? null, workspaceLabel: workspaceLabel ?? null });
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText,
		proposedActions: [],
		events: [event],
		nextStatePatch: current ? { rememberTarget: current } : undefined,
	};
}

function createPendingActionsAnswerResponse(
	request: AlfredHandleRequest,
	source: AlfredSource,
	state: DaemonState,
	now: () => Date,
): AlfredHandleResponse {
	const createdAt = now().toISOString();
	const items = pendingActions(state, createdAt).slice(0, 12);
	const lines = items.map((pending) => `- ${pending.label} (${pending.actionMetaId}, ${pending.status}, ${pending.id})${pending.target ? ` → ${pending.target.label}` : ""}`);
	const displayText = items.length > 0 ? `Pending actions:\n${lines.join("\n")}` : "There are no pending actions right now.";
	const event = pushWorldObservedEvent(state, request.requestId, source, createdAt, `Listed ${items.length} pending action${items.length === 1 ? "" : "s"}.`, { pendingActionCount: items.length });
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText,
		proposedActions: [],
		events: [event],
	};
}

function pushWorldObservedEvent(
	state: DaemonState,
	requestId: AlfredId,
	source: AlfredSource,
	createdAt: IsoTimestamp,
	summary: string,
	data?: Record<string, unknown>,
): AlfredEvent {
	return pushEvent(state, {
		id: nextId("evt"),
		kind: "world.observed",
		createdAt,
		requestId,
		source: { kind: source.kind, id: source.id, label: source.label },
		summary,
		data,
		redaction: { status: "not_needed" },
		retention: defaultEventRetention(createdAt),
	});
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
	const displayText = executed.ok && actionId === "cmux.readNotifications"
		? formatNotificationsDisplay(executed.pending.result?.notifications)
		: executed.ok ? executed.event.summary : `Alfred could not execute ${actionId}: ${executed.event.summary}`;
	return {
		requestId: request.requestId,
		createdAt: executed.event.createdAt,
		ok: executed.ok,
		displayText,
		proposedActions: [],
		events: [proposedEvent, executedEvent],
		errors: executed.ok ? undefined : [{ code: "unsupported_action", message: executed.event.summary, retryable: true }],
	};
}

function formatNotificationsDisplay(value: unknown): string {
	const notifications = Array.isArray(value) ? value.slice(0, 12) : [];
	if (notifications.length === 0) return "No cmux notifications are visible right now.";
	const lines = notifications.map((notification) => {
		const record = typeof notification === "object" && notification !== null ? notification as Record<string, unknown> : {};
		const title = typeof record.title === "string" && record.title.trim() ? record.title : String(record.id ?? "notification");
		const state = record.isRead === true ? "read" : "unread";
		return `- ${title} (${state})`;
	});
	return `Notifications:\n${lines.join("\n")}`;
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
		errors: executed.ok ? undefined : [{ code: errorCodeForPendingExecutionFailure(pending, executed.event), message: executed.event.summary, retryable: true }],
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
	return candidates.at(-1) ?? null;
}

function findPendingActionForCancel(state: DaemonState, pendingActionId?: string, draftId?: string): PendingAction | null {
	const candidates = state.actions.listPending().filter((pending) => pending.status === "pending" || pending.status === "approved");
	if (pendingActionId) return candidates.find((pending) => pending.id === pendingActionId) ?? null;
	if (draftId) return candidates.find((pending) => pending.id === draftId && pending.actionMetaId === "cmux.sendText") ?? null;
	return candidates.at(-1) ?? null;
}

function errorCodeForPendingExecutionFailure(pending: PendingAction, event: AlfredEvent): AlfredError["code"] {
	if (event.kind === "action.expired") return "confirmation_expired";
	if (event.kind === "action.denied") return "capability_denied";
	if (pending.actionMetaId === "cmux.sendText" || pending.actionMetaId === "cmux.sendKey") return "send_failed";
	if (pending.actionMetaId.startsWith("cmux.")) return "cmux_unavailable";
	if (pending.actionMetaId.startsWith("loop.")) return "internal_error";
	return "unsupported_action";
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
