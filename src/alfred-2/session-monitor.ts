import { createHash, randomUUID } from "node:crypto";
import type { LlmClient, LlmMessage } from "./agent.ts";
import type {
	PollSessionMonitorToolCall,
	SessionMonitorStatusToolCall,
	StartSessionMonitorToolCall,
	StopSessionMonitorToolCall,
	ToolExecutionContext,
	ToolResult,
} from "./tool-types.ts";
import type { FailureCode } from "./capabilities/failure-codes.ts";
import { createStructuredFailure } from "./capabilities/outcome.ts";
import { inspectSession, resolveSessionTarget, type InspectSessionOptions, type SessionExecFn } from "./tools/session.ts";
import { sendSessionMessage } from "./tools/session-message.ts";

export type SessionMonitorStatus = "running" | "waiting" | "needs_user" | "done" | "failed" | "stopped";
export type SessionMonitorReplyMode = "draft" | "send";

export type SessionMonitorDecision =
	| { kind: "wait"; reason?: string }
	| { kind: "draft_reply"; message: string }
	| { kind: "send_reply"; message: string }
	| { kind: "done"; summary: string }
	| { kind: "needs_user"; summary: string };

export interface SessionMonitorSummary {
	id: string;
	workspaceRef: string;
	workspaceName: string;
	surfaceRef: string;
	surfaceTitle: string;
	goal: string;
	status: SessionMonitorStatus;
	replyMode: SessionMonitorReplyMode;
	turns: number;
	maxTurns: number;
	pollIntervalMs: number;
	startedAt: string;
	lastActivityAt: string;
	nextPollAt?: string;
	lastDecision?: SessionMonitorDecision;
	lastReply?: string;
	lastError?: string;
}

export interface StartSessionMonitorData {
	monitor?: SessionMonitorSummary;
}

export interface PollSessionMonitorData {
	monitor?: SessionMonitorSummary;
	decision?: SessionMonitorDecision;
	action?: "wait" | "drafted" | "sent" | "done" | "needs_user" | "failed";
	sendText?: string;
}

export interface SessionMonitorStatusData {
	monitors: SessionMonitorSummary[];
}

export interface SessionMonitorManagerOptions {
	llmClient: LlmClient;
	exec?: SessionExecFn;
	systemContext?: string;
	cmuxExecutable?: string;
	now?: () => Date;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	onPollResult?: (result: ToolResult<PollSessionMonitorData>) => void;
	decide?: (monitor: SessionMonitorSummary, screenText: string) => Promise<SessionMonitorDecision>;
}

interface SessionMonitorRecord extends SessionMonitorSummary {
	lastScreenHash?: string;
	lastRespondedScreenHash?: string;
	lastReadText?: string;
	timer?: unknown;
	polling?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 12_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 6;
const MAX_TURNS = 24;
const READ_LINES = 160;

export class SessionMonitorManager {
	private readonly monitors = new Map<string, SessionMonitorRecord>();
	private readonly llmClient: LlmClient;
	private readonly exec?: SessionExecFn;
	private readonly systemContext?: string;
	private readonly cmuxExecutable?: string;
	private readonly now: () => Date;
	private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;
	private readonly onPollResult?: (result: ToolResult<PollSessionMonitorData>) => void;
	private readonly decideOverride?: (monitor: SessionMonitorSummary, screenText: string) => Promise<SessionMonitorDecision>;

	constructor(options: SessionMonitorManagerOptions) {
		this.llmClient = options.llmClient;
		this.exec = options.exec;
		this.systemContext = options.systemContext;
		this.cmuxExecutable = options.cmuxExecutable;
		this.now = options.now ?? (() => new Date());
		this.setTimer = options.setTimer ?? ((callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref?.();
			return timer;
		});
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
		this.onPollResult = options.onPollResult;
		this.decideOverride = options.decide;
	}

	async start(toolCall: StartSessionMonitorToolCall, ctx: ToolExecutionContext, options: InspectSessionOptions = {}): Promise<ToolResult<StartSessionMonitorData>> {
		const started = Date.now();
		const resolved = await resolveSessionTarget(toolCall, ctx, this.mergeOptions(options));
		if (resolved.kind !== "resolved") {
			return makeResult("start_session_monitor", ctx, false, resolved.message, {}, Date.now() - started, true, resolved.kind === "ambiguous" ? "resolution.ambiguous_target" : "resolution.target_not_found");
		}
		const id = `monitor-${randomUUID()}`;
		const now = this.now().toISOString();
		const pollIntervalMs = clampInt(toolCall.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
		const monitor: SessionMonitorRecord = {
			id,
			workspaceRef: resolved.target.workspace.ref,
			workspaceName: resolved.target.workspace.name,
			surfaceRef: resolved.target.surface.ref,
			surfaceTitle: resolved.target.surface.title,
			goal: toolCall.goal.trim(),
			status: "running",
			replyMode: toolCall.replyMode ?? "draft",
			turns: 0,
			maxTurns: clampInt(toolCall.maxTurns ?? DEFAULT_MAX_TURNS, 1, MAX_TURNS),
			pollIntervalMs,
			startedAt: now,
			lastActivityAt: now,
		};
		this.monitors.set(id, monitor);
		this.schedule(monitor);
		return makeResult("start_session_monitor", ctx, true, `Started monitoring ${monitor.workspaceName} / ${monitor.surfaceTitle}.`, { monitor: cloneSummary(monitor) }, Date.now() - started, false);
	}

	async poll(toolCall: PollSessionMonitorToolCall, ctx: ToolExecutionContext, options: InspectSessionOptions = {}): Promise<ToolResult<PollSessionMonitorData>> {
		const started = Date.now();
		const monitor = this.pickMonitor(toolCall.monitorId);
		if (!monitor) return makeResult("poll_session_monitor", ctx, false, "No matching session monitor is running.", { action: "failed" }, Date.now() - started, false, "resolution.target_not_found");
		const result = await this.pollMonitor(monitor, ctx, options, started);
		return result;
	}

	status(toolCall: SessionMonitorStatusToolCall, ctx: ToolExecutionContext): ToolResult<SessionMonitorStatusData> {
		const monitors = [...this.monitors.values()]
			.filter((monitor) => !toolCall.monitorId || monitor.id === toolCall.monitorId)
			.map(cloneSummary);
		const text = monitors.length === 0
			? "No active session monitors."
			: monitors.map((monitor) => `${monitor.id}: ${monitor.status} for ${monitor.workspaceName} / ${monitor.surfaceTitle}; turns ${monitor.turns}/${monitor.maxTurns}.`).join("\n");
		return makeResult("session_monitor_status", ctx, true, text, { monitors }, 0, false);
	}

	stop(toolCall: StopSessionMonitorToolCall, ctx: ToolExecutionContext): ToolResult<{ monitor?: SessionMonitorSummary }> {
		const monitor = this.pickMonitor(toolCall.monitorId);
		if (!monitor) return makeResult("stop_session_monitor", ctx, false, "No matching session monitor is running.", {}, 0, false, "resolution.target_not_found");
		this.cancel(monitor);
		monitor.status = "stopped";
		monitor.lastActivityAt = this.now().toISOString();
		this.monitors.delete(monitor.id);
		return makeResult("stop_session_monitor", ctx, true, `Stopped monitoring ${monitor.workspaceName} / ${monitor.surfaceTitle}.`, { monitor: cloneSummary(monitor) }, 0, false);
	}

	list(): SessionMonitorSummary[] {
		return [...this.monitors.values()].map(cloneSummary);
	}

	close(): void {
		for (const monitor of this.monitors.values()) this.cancel(monitor);
		this.monitors.clear();
	}

	private async pollMonitor(monitor: SessionMonitorRecord, ctx: ToolExecutionContext, options: InspectSessionOptions, started: number): Promise<ToolResult<PollSessionMonitorData>> {
		if (monitor.polling) {
			return makeResult("poll_session_monitor", ctx, true, `Monitor ${monitor.id} is already polling.`, { monitor: cloneSummary(monitor), action: "wait", decision: { kind: "wait", reason: "Poll already in progress." } }, Date.now() - started, false);
		}
		if (!["running", "waiting"].includes(monitor.status)) {
			return makeResult("poll_session_monitor", ctx, true, `Monitor ${monitor.id} is ${monitor.status}.`, { monitor: cloneSummary(monitor), action: monitor.status === "done" ? "done" : "needs_user" }, Date.now() - started, false);
		}
		if (monitor.turns >= monitor.maxTurns) {
			monitor.status = "done";
			monitor.lastDecision = { kind: "done", summary: "Monitor reached its reply limit." };
			this.cancel(monitor);
			return makeResult("poll_session_monitor", ctx, true, "Monitor reached its reply limit.", { monitor: cloneSummary(monitor), decision: monitor.lastDecision, action: "done" }, Date.now() - started, false);
		}

		monitor.polling = true;
		try {
			const inspected = await inspectSession({ tool: "inspect_session", workspaceRef: monitor.workspaceRef, surfaceRef: monitor.surfaceRef, lines: READ_LINES, scrollback: true }, ctx, this.mergeOptions(options));
			if (!inspected.success) {
				monitor.status = "failed";
				monitor.lastError = inspected.text;
				monitor.lastActivityAt = this.now().toISOString();
				this.cancel(monitor);
				return makeResult("poll_session_monitor", ctx, false, inspected.text, { monitor: cloneSummary(monitor), action: "failed" }, Date.now() - started, true, inspected.failure?.code as Extract<FailureCode, `resolution.${string}` | `execution.${string}`> | undefined);
			}

			const screenText = inspected.data?.screenText ?? inspected.text;
			const screenHash = hashText(screenText);
			monitor.lastReadText = screenText;
			monitor.lastScreenHash = screenHash;
			if (monitor.lastRespondedScreenHash === screenHash) {
				const decision: SessionMonitorDecision = { kind: "wait", reason: "No new screen text since the last reply." };
				this.applyWait(monitor, decision);
				return makeResult("poll_session_monitor", ctx, true, decision.reason!, { monitor: cloneSummary(monitor), decision, action: "wait" }, Date.now() - started, false);
			}

			const decision = await this.decide(cloneSummary(monitor), screenText);
			monitor.lastDecision = decision;
			monitor.lastActivityAt = this.now().toISOString();
			if (decision.kind === "wait") {
				this.applyWait(monitor, decision);
				return makeResult("poll_session_monitor", ctx, true, decision.reason ?? "No reply needed yet.", { monitor: cloneSummary(monitor), decision, action: "wait" }, Date.now() - started, false);
			}
			if (decision.kind === "done") {
				monitor.status = "done";
				this.cancel(monitor);
				return makeResult("poll_session_monitor", ctx, true, decision.summary, { monitor: cloneSummary(monitor), decision, action: "done" }, Date.now() - started, false);
			}
			if (decision.kind === "needs_user") {
				monitor.status = "needs_user";
				this.cancel(monitor);
				return makeResult("poll_session_monitor", ctx, true, decision.summary, { monitor: cloneSummary(monitor), decision, action: "needs_user" }, Date.now() - started, false);
			}

			const message = decision.message.trim();
			const mode: SessionMonitorReplyMode = decision.kind === "send_reply" && monitor.replyMode === "send" ? "send" : "draft";
			const sent = await sendSessionMessage({ tool: "send_session_message", workspaceRef: monitor.workspaceRef, surfaceRef: monitor.surfaceRef, text: message, mode }, ctx, this.mergeOptions(options));
			if (!sent.success) {
				monitor.status = "failed";
				monitor.lastError = sent.text;
				this.cancel(monitor);
				return makeResult("poll_session_monitor", ctx, false, sent.text, { monitor: cloneSummary(monitor), decision, action: "failed", sendText: message }, Date.now() - started, true, sent.failure?.code as Extract<FailureCode, `resolution.${string}` | `execution.${string}`> | undefined);
			}
			monitor.turns += 1;
			monitor.lastReply = message;
			monitor.lastRespondedScreenHash = screenHash;
			monitor.status = monitor.turns >= monitor.maxTurns ? "done" : "waiting";
			if (monitor.status === "done") this.cancel(monitor);
			else this.schedule(monitor);
			const action = mode === "send" ? "sent" : "drafted";
			return makeResult("poll_session_monitor", ctx, true, `${mode === "send" ? "Sent" : "Drafted"} monitor reply to ${monitor.workspaceName} / ${monitor.surfaceTitle}.`, { monitor: cloneSummary(monitor), decision, action, sendText: message }, Date.now() - started, false);
		} catch (error) {
			monitor.status = "needs_user";
			monitor.lastError = error instanceof Error ? error.message : String(error);
			monitor.lastActivityAt = this.now().toISOString();
			this.cancel(monitor);
			return makeResult("poll_session_monitor", ctx, false, `Session monitor failed: ${monitor.lastError}`, { monitor: cloneSummary(monitor), action: "failed" }, Date.now() - started, true, "execution.internal_error");
		} finally {
			monitor.polling = false;
		}
	}

	private applyWait(monitor: SessionMonitorRecord, decision: SessionMonitorDecision): void {
		monitor.lastDecision = decision;
		monitor.status = "waiting";
		monitor.lastActivityAt = this.now().toISOString();
		this.schedule(monitor);
	}

	private schedule(monitor: SessionMonitorRecord): void {
		this.cancel(monitor);
		if (!["running", "waiting"].includes(monitor.status)) return;
		monitor.nextPollAt = new Date(this.now().getTime() + monitor.pollIntervalMs).toISOString();
		monitor.timer = this.setTimer(() => {
			void this.pollMonitor(monitor, {
				requestId: `monitor-${monitor.id}`,
				toolCallId: `poll-${randomUUID()}`,
				risk: "read",
				workspaceRef: monitor.workspaceRef,
			}, {}, Date.now()).then((result) => this.onPollResult?.(result));
		}, monitor.pollIntervalMs);
	}

	private cancel(monitor: SessionMonitorRecord): void {
		if (monitor.timer) this.clearTimer(monitor.timer);
		monitor.timer = undefined;
		monitor.nextPollAt = undefined;
	}

	private pickMonitor(monitorId?: string): SessionMonitorRecord | undefined {
		if (monitorId) return this.monitors.get(monitorId);
		const active = [...this.monitors.values()].filter((monitor) => ["running", "waiting", "needs_user"].includes(monitor.status));
		return active.length === 1 ? active[0] : undefined;
	}

	private mergeOptions(options: InspectSessionOptions): InspectSessionOptions {
		return {
			exec: options.exec ?? this.exec,
			systemContext: options.systemContext ?? this.systemContext,
			cmuxExecutable: options.cmuxExecutable ?? this.cmuxExecutable,
		};
	}

	private async decide(monitor: SessionMonitorSummary, screenText: string): Promise<SessionMonitorDecision> {
		if (this.decideOverride) return normalizeDecision(await this.decideOverride(monitor, screenText));
		const messages: LlmMessage[] = [
			{ role: "system", content: SESSION_MONITOR_SYSTEM_PROMPT },
			{ role: "user", content: JSON.stringify({ monitor, screenText: screenText.slice(-12_000) }) },
		];
		const response = await this.llmClient.complete({ messages, temperature: 0, maxTokens: 800, timeoutMs: 30_000 });
		return parseDecision(response.text);
	}
}

export const SESSION_MONITOR_SYSTEM_PROMPT = `You are Alfred's cmux session monitor decision engine. Return exactly one JSON object and nothing else.

You are deciding whether a monitored cmux chat/session needs Alfred to respond. Use only the supplied screen text and monitor goal. Do not invent events, failures, sent messages, or user intent.

Decision JSON shapes:
{"kind":"wait","reason":"short reason"}
{"kind":"draft_reply","message":"text to place in the target input buffer for user review"}
{"kind":"send_reply","message":"text to send only when the monitor is explicitly configured for autonomous send"}
{"kind":"done","summary":"why monitoring is complete"}
{"kind":"needs_user","summary":"what decision or clarification is needed"}

Default to wait unless the latest screen clearly shows a message or state relevant to the goal. Prefer draft_reply unless the monitor summary says replyMode is send. Keep replies concise and directly useful.`;

function parseDecision(text: string): SessionMonitorDecision {
	try {
		return normalizeDecision(JSON.parse(text.trim()));
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (match) return normalizeDecision(JSON.parse(match[0]!));
		return { kind: "needs_user", summary: "Monitor decision provider returned invalid JSON." };
	}
}

function normalizeDecision(value: unknown): SessionMonitorDecision {
	if (!value || typeof value !== "object") return { kind: "needs_user", summary: "Monitor decision provider returned an invalid decision." };
	const obj = value as Record<string, unknown>;
	switch (obj.kind) {
		case "wait":
			return { kind: "wait", reason: typeof obj.reason === "string" ? obj.reason.slice(0, 500) : undefined };
		case "draft_reply":
		case "send_reply": {
			const message = typeof obj.message === "string" ? obj.message.trim() : "";
			if (!message) return { kind: "needs_user", summary: "Monitor decision provider returned an empty reply." };
			return { kind: obj.kind, message: message.slice(0, 4_000) };
		}
		case "done":
			return { kind: "done", summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 1_000) : "Monitoring complete." };
		case "needs_user":
			return { kind: "needs_user", summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 1_000) : "Monitor needs user input." };
		default:
			return { kind: "needs_user", summary: "Monitor decision provider returned an invalid decision kind." };
	}
}

function makeResult<TData>(
	tool: "start_session_monitor" | "poll_session_monitor" | "session_monitor_status" | "stop_session_monitor",
	ctx: ToolExecutionContext,
	success: boolean,
	text: string,
	data: TData,
	timingMs: number,
	retryable: boolean,
	failureCode?: Extract<FailureCode, `resolution.${string}` | `execution.${string}`>,
): ToolResult<TData> {
	return {
		tool,
		toolCallId: ctx.toolCallId,
		success,
		text,
		data,
		displayText: text,
		retryable,
		failure: failureCode ? createStructuredFailure({
			stage: failureCode.startsWith("resolution.") ? "resolve" : "execute",
			code: failureCode,
			component: "session-monitor",
			message: text,
			retryable,
			detector: { id: "alfred.session-monitor.typed", version: 1 },
		}) : undefined,
		safety: { risk: tool === "session_monitor_status" || tool === "poll_session_monitor" ? "read" : "mutation", confirmation: tool === "start_session_monitor" ? "confirm" : "none" },
		timingMs,
		workspaceRef: ctx.workspaceRef,
		cwd: ctx.cwd,
	};
}

function cloneSummary(monitor: SessionMonitorRecord | SessionMonitorSummary): SessionMonitorSummary {
	return {
		id: monitor.id,
		workspaceRef: monitor.workspaceRef,
		workspaceName: monitor.workspaceName,
		surfaceRef: monitor.surfaceRef,
		surfaceTitle: monitor.surfaceTitle,
		goal: monitor.goal,
		status: monitor.status,
		replyMode: monitor.replyMode,
		turns: monitor.turns,
		maxTurns: monitor.maxTurns,
		pollIntervalMs: monitor.pollIntervalMs,
		startedAt: monitor.startedAt,
		lastActivityAt: monitor.lastActivityAt,
		nextPollAt: monitor.nextPollAt,
		lastDecision: monitor.lastDecision,
		lastReply: monitor.lastReply,
		lastError: monitor.lastError,
	};
}

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}
