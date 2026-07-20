import { randomBytes } from "node:crypto";
import type {
	AlfredAction,
	AlfredCapability,
	AlfredError,
	AlfredHandleResponse,
	AlfredId,
	AlfredLoopSummary,
	AlfredRef,
	AlfredSource,
	AlfredTarget,
	IsoTimestamp,
	RedactedText,
	RetentionMetadata,
} from "../contracts/runtime.ts";
import { redactedText, sourceHasCapabilities } from "../contracts/runtime.ts";
import type { CmuxResult, CmuxWorldModelAdapter } from "../cmux/index.ts";

export interface AlfredLoopStartRequest {
	requestId: AlfredId;
	source: AlfredSource;
	targetRef: AlfredRef;
	goal: RedactedText;
	maxTurns: number;
	pollIntervalMs: number;
	allowedCapabilities: AlfredCapability[];
}

export type AlfredLoopDecision =
	| { kind: "wait"; reason?: string }
	| { kind: "draft_reply"; message: string }
	| { kind: "done"; summary: string }
	| { kind: "needs_user"; summary: string };

export interface AlfredLoopStopOptions {
	interruptTarget?: boolean;
	requestId?: AlfredId;
	source?: AlfredSource;
	reason?: string;
}

export interface AlfredLoopRuntimeState {
	summary: AlfredLoopSummary;
	source: AlfredSource;
	allowedCapabilities: AlfredCapability[];
	pollIntervalMs: number;
	lastDecision?: AlfredLoopDecision;
}

export interface AlfredLoopScheduler {
	schedule(loopId: AlfredId, delayMs: number): void;
	cancel(loopId: AlfredId): void;
}

export interface AlfredLoopManager {
	start(request: AlfredLoopStartRequest): Promise<AlfredHandleResponse>;
	poll(loopId: AlfredId): Promise<AlfredLoopDecision>;
	stop(loopId: AlfredId, options?: AlfredLoopStopOptions): Promise<AlfredHandleResponse>;
	status(loopId?: AlfredId): AlfredLoopSummary | null;
	active(): AlfredLoopRuntimeState | null;
	recordReplyDrafted(loopId: AlfredId): void;
	recordReplyFailed(loopId: AlfredId, status?: "failed" | "needs_user"): void;
}

export type AlfredLoopCmux = Pick<CmuxWorldModelAdapter, "listTargets" | "readSurface">;

export interface AlfredLoopManagerDependencies {
	cmux: AlfredLoopCmux;
	now?: () => Date;
	nextId?: (prefix: string) => AlfredId;
	decide?: (state: AlfredLoopRuntimeState, transcript: string) => Promise<AlfredLoopDecision>;
	scheduler?: AlfredLoopScheduler;
}

const DEFAULT_POLL_INTERVAL_MS = 12_000;
const MAX_POLL_INTERVAL_MS = 10 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_LOOP_TURNS = 12;
const DEFAULT_READ_LINES = 160;

export function createAlfredLoopManager(dependencies: AlfredLoopManagerDependencies): AlfredLoopManager {
	const now = dependencies.now ?? (() => new Date());
	const nextId = dependencies.nextId ?? defaultNextId;
	const scheduler = dependencies.scheduler ?? noopScheduler;
	let activeLoop: AlfredLoopRuntimeState | null = null;

	async function start(request: AlfredLoopStartRequest): Promise<AlfredHandleResponse> {
		const createdAt = now().toISOString();
		const requestId = typeof request.requestId === "string" && request.requestId.trim() ? request.requestId : nextId("req_loop_start");
		if (!isSourceLike(request.source) || typeof request.targetRef !== "string" || !request.targetRef.trim() || !isRedactedTextLike(request.goal)) {
			return errorResponse(requestId, createdAt, "Loop start requires source, targetRef, and goal.", { code: "invalid_request", message: "Loop start requires source, targetRef, and goal.", retryable: false });
		}
		const effectiveSource = applyAllowedCapabilities(request.source, Array.isArray(request.allowedCapabilities) ? request.allowedCapabilities : request.source.capabilities);
		if (!sourceHasCapabilities(effectiveSource, ["loop.manage"])) {
			return errorResponse(requestId, createdAt, "Source lacks loop.manage capability.", { code: "capability_denied", message: "Source lacks loop.manage capability.", retryable: false });
		}
		if (activeLoop && ["running", "waiting"].includes(activeLoop.summary.status)) {
			return errorResponse(requestId, createdAt, `A loop is already running for ${activeLoop.summary.target.label}.`, { code: "loop_already_running", message: "Only one active loop is supported in this foundation.", retryable: false });
		}
		const targetResult = await findTarget(dependencies.cmux, request.targetRef);
		if (!targetResult.ok) {
			return errorResponse(requestId, createdAt, `Loop target is unavailable: ${targetResult.error.message}`, { code: targetResult.error.code === "target_not_found" ? "target_not_found" : "cmux_unavailable", message: targetResult.error.message, retryable: targetResult.error.code !== "target_not_found" });
		}
		const observationCapabilities = requiredObservationCapabilities(targetResult.value);
		if (!sourceHasCapabilities(effectiveSource, observationCapabilities)) {
			return errorResponse(requestId, createdAt, `Source lacks ${observationCapabilities.join(", ")} capability.`, { code: "capability_denied", message: `Source lacks ${observationCapabilities.join(", ")} capability.`, retryable: false });
		}
		if (!targetHasCapabilities(targetResult.value, observationCapabilities)) {
			return errorResponse(requestId, createdAt, `Target ${targetResult.value.label} does not support ${observationCapabilities.join(", ")}.`, { code: "capability_denied", message: `Target does not support ${observationCapabilities.join(", ")}.`, retryable: false });
		}
		const goalValue = request.goal.value.trim();
		if (!goalValue) {
			return errorResponse(requestId, createdAt, "Loop goal is required.", { code: "invalid_request", message: "Loop goal is required.", retryable: false });
		}
		const loopId = nextId("loop");
		const summary: AlfredLoopSummary = {
			id: loopId,
			target: targetResult.value,
			goal: redactedText(goalValue, request.goal.redaction),
			status: "running",
			turns: 0,
			maxTurns: clampInt(request.maxTurns, 1, MAX_LOOP_TURNS),
			autonomousSend: sourceHasCapabilities(effectiveSource, ["loop.autonomousSend"]),
			startedAt: createdAt,
			lastActivityAt: createdAt,
			observeMode: "screen",
		};
		activeLoop = {
			summary,
			source: effectiveSource,
			allowedCapabilities: [...effectiveSource.capabilities],
			pollIntervalMs: clampInt(request.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
		};
		scheduler.schedule(loopId, activeLoop.pollIntervalMs);
		const action: AlfredAction = {
			id: nextId("act"),
			kind: "loop.start",
			createdAt,
			requestedBy: effectiveSource,
			target: summary.target,
			requiredCapabilities: ["loop.manage"],
			status: "running",
			goal: summary.goal,
			maxTurns: summary.maxTurns,
			silent: true,
		};
		const event = {
			id: nextId("evt"),
			kind: "loop.started" as const,
			createdAt,
			requestId,
			source: { kind: effectiveSource.kind, id: effectiveSource.id, label: effectiveSource.label },
			target: summary.target,
			actionId: action.id,
			loopId,
			summary: `Started loop for ${summary.target.label}.`,
			redaction: summary.goal.redaction,
			retention: defaultEventRetention(createdAt),
		};
		return {
			requestId,
			createdAt,
			ok: true,
			displayText: `Loop started for ${summary.target.label}.`,
			proposedActions: [action],
			activeLoop: summary,
			events: [event],
			nextStatePatch: { activeLoopId: loopId },
		};
	}

	async function poll(loopId: AlfredId): Promise<AlfredLoopDecision> {
		const loop = activeLoop;
		if (!loop || loop.summary.id !== loopId) {
			return { kind: "needs_user", summary: "Loop not found." };
		}
		if (loop.summary.status !== "running" && loop.summary.status !== "waiting") {
			return { kind: "needs_user", summary: `Loop is ${loop.summary.status}.` };
		}
		if (loop.summary.turns >= loop.summary.maxTurns) {
			loop.summary.status = "done";
			loop.summary.lastActivityAt = now().toISOString();
			scheduler.cancel(loopId);
			const decision: AlfredLoopDecision = { kind: "done", summary: "Loop reached its turn limit." };
			loop.lastDecision = decision;
			return decision;
		}
		const targetResult = await findTarget(dependencies.cmux, loop.summary.target.ref);
		if (!targetResult.ok) {
			loop.summary.status = "failed";
			loop.summary.lastActivityAt = now().toISOString();
			scheduler.cancel(loopId);
			const decision: AlfredLoopDecision = { kind: "needs_user", summary: `Loop target disappeared: ${targetResult.error.message}` };
			loop.lastDecision = decision;
			return decision;
		}
		const observationCapabilities = requiredObservationCapabilities(targetResult.value);
		if (!sourceHasCapabilities(loop.source, observationCapabilities) || !targetHasCapabilities(targetResult.value, observationCapabilities)) {
			loop.summary.status = "needs_user";
			loop.summary.lastActivityAt = now().toISOString();
			scheduler.cancel(loopId);
			const decision: AlfredLoopDecision = { kind: "needs_user", summary: `Loop observation requires ${observationCapabilities.join(", ")}.` };
			loop.lastDecision = decision;
			return decision;
		}
		loop.summary.target = targetResult.value;
		const transcript = await readTargetTranscript(dependencies.cmux, targetResult.value);
		let decision: AlfredLoopDecision;
		try {
			const rawDecision = dependencies.decide ? await dependencies.decide(cloneRuntimeState(loop), transcript) : { kind: "wait", reason: "No loop decision provider is configured yet." };
			decision = normalizeLoopDecision(rawDecision);
		} catch {
			loop.summary.status = "needs_user";
			loop.summary.lastActivityAt = now().toISOString();
			scheduler.cancel(loopId);
			decision = { kind: "needs_user", summary: "Loop decision provider failed." };
			loop.lastDecision = decision;
			return decision;
		}
		loop.lastDecision = decision;
		loop.summary.lastActivityAt = now().toISOString();
		if (loop.lastDecision.kind === "wait") {
			loop.summary.status = "waiting";
			scheduler.schedule(loopId, loop.pollIntervalMs);
		} else if (loop.lastDecision.kind === "done") {
			loop.summary.status = "done";
			scheduler.cancel(loopId);
		} else if (loop.lastDecision.kind === "needs_user") {
			loop.summary.status = "needs_user";
			scheduler.cancel(loopId);
		} else {
			loop.summary.status = "waiting";
		}
		return loop.lastDecision;
	}

	async function stop(loopId: AlfredId, options: AlfredLoopStopOptions = {}): Promise<AlfredHandleResponse> {
		const createdAt = now().toISOString();
		const loop = activeLoop;
		const requestId = options.requestId ?? nextId("req_loop_stop");
		if (!loop || loop.summary.id !== loopId) {
			return errorResponse(requestId, createdAt, "There is no active loop to stop.", { code: "loop_not_found", message: "Loop not found.", retryable: false });
		}
		const source = options.source ?? loop.source;
		if (!sourceHasCapabilities(source, ["loop.manage"])) {
			return errorResponse(requestId, createdAt, "Source lacks loop.manage capability.", { code: "capability_denied", message: "Source lacks loop.manage capability.", retryable: false });
		}
		scheduler.cancel(loopId);
		loop.summary.status = "stopped";
		loop.summary.lastActivityAt = createdAt;
		activeLoop = null;
		const action: AlfredAction = {
			id: nextId("act"),
			kind: "loop.stop",
			createdAt,
			requestedBy: source,
			target: loop.summary.target,
			requiredCapabilities: ["loop.manage"],
			status: "cancelled",
			loopId,
			interruptTarget: options.interruptTarget,
			reason: options.reason,
		};
		const event = {
			id: nextId("evt"),
			kind: "loop.stopped" as const,
			createdAt,
			requestId,
			source: { kind: source.kind, id: source.id, label: source.label },
			target: loop.summary.target,
			actionId: action.id,
			loopId,
			summary: `Stopped loop for ${loop.summary.target.label}.`,
			redaction: loop.summary.goal.redaction,
			retention: defaultEventRetention(createdAt),
		};
		return {
			requestId,
			createdAt,
			ok: true,
			displayText: `Stopped loop for ${loop.summary.target.label}.`,
			proposedActions: [action],
			activeLoop: loop.summary,
			events: [event],
			nextStatePatch: { activeLoopId: null },
		};
	}

	function status(loopId?: AlfredId): AlfredLoopSummary | null {
		if (!activeLoop) return null;
		if (loopId && activeLoop.summary.id !== loopId) return null;
		return cloneSummary(activeLoop.summary);
	}

	function active(): AlfredLoopRuntimeState | null {
		if (!activeLoop) return null;
		return cloneRuntimeState(activeLoop);
	}

	function recordReplyDrafted(loopId: AlfredId): void {
		if (!activeLoop || activeLoop.summary.id !== loopId || activeLoop.summary.status !== "waiting") return;
		activeLoop.summary.turns += 1;
		activeLoop.summary.status = "waiting";
		activeLoop.summary.lastActivityAt = now().toISOString();
		scheduler.schedule(loopId, activeLoop.pollIntervalMs);
	}

	function recordReplyFailed(loopId: AlfredId, status: "failed" | "needs_user" = "failed"): void {
		if (!activeLoop || activeLoop.summary.id !== loopId) return;
		activeLoop.summary.status = status;
		activeLoop.summary.lastActivityAt = now().toISOString();
		scheduler.cancel(loopId);
	}

	return { start, poll, stop, status, active, recordReplyDrafted, recordReplyFailed };
}

async function findTarget(cmux: AlfredLoopCmux, targetRef: AlfredRef): Promise<CmuxResult<AlfredTarget>> {
	const targets = await cmux.listTargets();
	if (!targets.ok) return targets;
	const matches = targets.value.filter((target) => target.ref === targetRef || target.surfaceRef === targetRef || target.workspaceRef === targetRef);
	if (matches.length !== 1) {
		return { ok: false, error: { code: "target_not_found", message: matches.length === 0 ? `Target not found: ${targetRef}` : `Target is ambiguous: ${targetRef}` } };
	}
	return { ok: true, value: matches[0]! };
}

async function readTargetTranscript(cmux: AlfredLoopCmux, target: AlfredTarget): Promise<string> {
	if (!target.surfaceRef && target.kind === "cmux-workspace") return "";
	const surfaceRef = target.surfaceRef ?? target.ref;
	const result = await cmux.readSurface(surfaceRef, { lines: DEFAULT_READ_LINES }).catch(() => ({ ok: false as const, error: { code: "command_failed" as const, message: "read failed" } }));
	return result.ok ? result.value.text : "";
}

function requiredObservationCapabilities(target: AlfredTarget): AlfredCapability[] {
	return target.surfaceRef || target.kind === "cmux-surface" || target.kind === "pi-chat" || target.kind === "codex-session" || target.kind === "terminal" ? ["surface.read"] : [];
}

function targetHasCapabilities(target: AlfredTarget, capabilities: readonly AlfredCapability[]): boolean {
	return capabilities.every((capability) => target.capabilities.includes(capability));
}

function isSourceLike(value: unknown): value is AlfredSource {
	if (!value || typeof value !== "object") return false;
	const source = value as Partial<AlfredSource>;
	return typeof source.kind === "string"
		&& typeof source.id === "string"
		&& typeof source.trustedLocalOnly === "boolean"
		&& Array.isArray(source.capabilities)
		&& source.capabilities.every((capability) => typeof capability === "string");
}

function isRedactedTextLike(value: unknown): value is RedactedText {
	if (!value || typeof value !== "object") return false;
	const text = value as Partial<RedactedText>;
	return typeof text.value === "string" && Boolean(text.redaction) && typeof text.redaction === "object";
}

function normalizeLoopDecision(decision: unknown): AlfredLoopDecision {
	if (!decision || typeof decision !== "object") {
		return { kind: "needs_user", summary: "Loop decision provider returned an invalid decision." };
	}
	const record = decision as Record<string, unknown>;
	if (record.kind === "draft_reply") {
		const message = typeof record.message === "string" ? record.message.trim() : "";
		return message ? { kind: "draft_reply", message } : { kind: "needs_user", summary: "Loop planner returned an empty reply." };
	}
	if (record.kind === "done") {
		const summary = typeof record.summary === "string" ? record.summary.trim() : "";
		return { kind: "done", summary: summary || "Loop completed." };
	}
	if (record.kind === "needs_user") {
		const summary = typeof record.summary === "string" ? record.summary.trim() : "";
		return { kind: "needs_user", summary: summary || "Loop needs user input." };
	}
	if (record.kind === "wait") {
		return { kind: "wait", reason: typeof record.reason === "string" ? record.reason.trim() : undefined };
	}
	return { kind: "needs_user", summary: "Loop decision provider returned an invalid decision." };
}

function applyAllowedCapabilities(source: AlfredSource, allowedCapabilities?: readonly AlfredCapability[]): AlfredSource {
	if (!allowedCapabilities) return source;
	return {
		...source,
		capabilities: source.capabilities.filter((capability) => allowedCapabilities.includes(capability)),
	};
}

function errorResponse(requestId: string, createdAt: IsoTimestamp, displayText: string, error: AlfredError): AlfredHandleResponse {
	return {
		requestId,
		createdAt,
		ok: false,
		displayText,
		proposedActions: [],
		events: [],
		errors: [error],
	};
}

function cloneRuntimeState(state: AlfredLoopRuntimeState): AlfredLoopRuntimeState {
	return {
		summary: cloneSummary(state.summary),
		source: cloneSource(state.source),
		allowedCapabilities: [...state.allowedCapabilities],
		pollIntervalMs: state.pollIntervalMs,
		lastDecision: state.lastDecision ? cloneDecision(state.lastDecision) : undefined,
	};
}

function cloneSummary(summary: AlfredLoopSummary): AlfredLoopSummary {
	return {
		...summary,
		target: { ...summary.target, metadata: summary.target.metadata ? { ...summary.target.metadata } : undefined, capabilities: [...summary.target.capabilities] },
		goal: { ...summary.goal, redaction: { ...summary.goal.redaction, rulesApplied: summary.goal.redaction.rulesApplied ? [...summary.goal.redaction.rulesApplied] : undefined } },
	};
}

function cloneSource(source: AlfredSource): AlfredSource {
	return {
		...source,
		capabilities: [...source.capabilities],
		presentation: source.presentation ? { ...source.presentation } : undefined,
	};
}

function cloneDecision(decision: AlfredLoopDecision): AlfredLoopDecision {
	if (decision.kind === "draft_reply") return { kind: "draft_reply", message: decision.message };
	if (decision.kind === "done") return { kind: "done", summary: decision.summary };
	if (decision.kind === "needs_user") return { kind: "needs_user", summary: decision.summary };
	return { kind: "wait", reason: decision.reason };
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function defaultEventRetention(createdAt: string): RetentionMetadata {
	return {
		policy: "short",
		expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
		reason: "loop lifecycle audit event",
	};
}

function defaultNextId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

const noopScheduler: AlfredLoopScheduler = {
	schedule() { /* explicit no-op scheduler seam for embedders */ },
	cancel() { /* explicit no-op scheduler seam for embedders */ },
};
