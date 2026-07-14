import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryProvenance, SessionMemoryRecord } from "./memory-types.ts";
import type { TokenUsage } from "./tool-types.ts";

/** A taxonomy-aligned turn retained only for the lifetime of this process/session. */
export type ConversationTurn = SessionMemoryRecord;

export type ConversationTurnInput = Pick<
	SessionMemoryRecord,
	"userText" | "finalSpeech" | "toolsUsed" | "workspaceHint" | "shortOutcome"
> & Partial<Pick<SessionMemoryRecord, "id" | "createdAt" | "updatedAt" | "provenance">>;

export interface AddTurnMetadata {
	requestId?: string;
	turnId?: string;
	sourceId?: string;
	timestamp?: string;
}

/**
 * In-memory session memory with a ring buffer of recent turns,
 * token accounting, and handoff generation.
 */
export interface SessionMemory {
	/** Ring buffer of recent conversation turns (most recent up to maxTurns). */
	turns: ConversationTurn[];
	/** Maximum number of turns retained by addTurn unless explicitly overridden. */
	readonly maxTurns: number;
	/** Accumulated input tokens since session start. */
	cumulativeInputTokens: number;
	/** Accumulated output tokens since session start. */
	cumulativeOutputTokens: number;
	/** Accumulated total tokens since session start; useful for cost/stats, not context pressure. */
	cumulativeTotalTokens: number;
	/** Estimated tokens in the prompt Alfred is about to send now. */
	currentContextTokens: number;
	/** Highest estimated prompt size seen in this server session. */
	maxContextTokens: number;
	/** Current-context threshold at which Alfred should prepare compaction/handoff (default 80k). */
	readonly warnThreshold: number;
	/** Current-context threshold at which Alfred must hand off before another LLM call (default 100k). */
	readonly handoffThreshold: number;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_WARN_THRESHOLD = 80_000;
const DEFAULT_HANDOFF_THRESHOLD = 100_000;

/**
 * Create a new empty SessionMemory.
 * Thresholds default to the ALFRED_AUTONOMOUS_DEFAULTS values.
 */
export function createSessionMemory(opts?: {
	maxTurns?: number;
	warnThreshold?: number;
	handoffThreshold?: number;
}): SessionMemory {
	return {
		turns: [],
		maxTurns: opts?.maxTurns ?? DEFAULT_MAX_TURNS,
		cumulativeInputTokens: 0,
		cumulativeOutputTokens: 0,
		cumulativeTotalTokens: 0,
		currentContextTokens: 0,
		maxContextTokens: 0,
		warnThreshold: opts?.warnThreshold ?? DEFAULT_WARN_THRESHOLD,
		handoffThreshold: opts?.handoffThreshold ?? DEFAULT_HANDOFF_THRESHOLD,
	};
}

/**
 * Push a turn into the ring buffer. If the buffer exceeds maxTurns,
 * the oldest turn is evicted.
 */
export function addTurn(
	memory: SessionMemory,
	turn: ConversationTurnInput,
	maxTurns: number = memory.maxTurns,
	metadata: AddTurnMetadata = {},
): void {
	const timestamp = metadata.timestamp ?? turn.createdAt ?? new Date().toISOString();
	const id = turn.id ?? `session-${randomUUID()}`;
	const provenance: MemoryProvenance = turn.provenance ?? {
		source: "conversation",
		sourceId: metadata.sourceId,
		requestId: metadata.requestId,
		turnId: metadata.turnId ?? id,
		timestamp,
	};
	memory.turns.push({
		id,
		kind: "session",
		ephemeral: true,
		createdAt: turn.createdAt ?? timestamp,
		updatedAt: turn.updatedAt ?? timestamp,
		provenance,
		userText: sanitizeSummary(turn.userText, 1_000),
		finalSpeech: sanitizeSummary(turn.finalSpeech, 1_000),
		toolsUsed: turn.toolsUsed.map((tool) => sanitizeSummary(tool, 80)).filter(Boolean),
		workspaceHint: sanitizeSummary(turn.workspaceHint, 200),
		shortOutcome: sanitizeSummary(turn.shortOutcome, 200),
	});
	while (memory.turns.length > maxTurns) memory.turns.shift();
}

/** Return detached, display-safe records for dashboard/API consumers. */
export function getSessionMemoryRecords(memory: SessionMemory): SessionMemoryRecord[] {
	return memory.turns.map((turn) => ({
		...turn,
		provenance: { ...turn.provenance },
		userText: sanitizeSummary(turn.userText, 240),
		finalSpeech: sanitizeSummary(turn.finalSpeech, 240),
		toolsUsed: [...turn.toolsUsed],
		workspaceHint: sanitizeSummary(turn.workspaceHint, 120),
		shortOutcome: sanitizeSummary(turn.shortOutcome, 200),
	}));
}

function sanitizeSummary(value: string, maxLength: number): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, maxLength);
}

/**
 * Add a TokenUsage snapshot to the cumulative counters.
 */
export function addTokens(memory: SessionMemory, usage: TokenUsage): void {
	memory.cumulativeInputTokens += usage.inputTokens ?? 0;
	memory.cumulativeOutputTokens += usage.outputTokens ?? 0;
	memory.cumulativeTotalTokens += usage.totalTokens ?? 0;
}

/**
 * Update the current-context estimate used for context-window pressure decisions.
 */
export function updateCurrentContextTokens(memory: SessionMemory, tokens: number): void {
	const safeTokens = Math.max(0, Math.ceil(tokens));
	memory.currentContextTokens = safeTokens;
	memory.maxContextTokens = Math.max(memory.maxContextTokens, safeTokens);
}

/**
 * Returns true when the current prompt estimate has reached the warning threshold (~80k).
 */
export function shouldWarnForContext(memory: SessionMemory, tokens = memory.currentContextTokens): boolean {
	return tokens >= memory.warnThreshold;
}

/**
 * Returns true when the current prompt estimate has reached the handoff threshold (~100k).
 */
export function shouldHandoffForContext(memory: SessionMemory, tokens = memory.currentContextTokens): boolean {
	return tokens >= memory.handoffThreshold;
}

/**
 * Legacy cumulative usage warning helper. Cumulative usage is for stats/cost, not context pressure.
 */
export function shouldWarn(memory: SessionMemory): boolean {
	return memory.cumulativeTotalTokens >= memory.warnThreshold;
}

/**
 * Legacy cumulative usage handoff helper. Prefer shouldHandoffForContext for runtime handoff decisions.
 */
export function shouldHandoff(memory: SessionMemory): boolean {
	return memory.cumulativeTotalTokens >= memory.handoffThreshold;
}

/**
 * Format recent turns as a compact multi-line string suitable for prompt injection.
 * No raw stdout is included; user text and speech are truncated to 200 chars each.
 */
export function formatConversationForContext(memory: SessionMemory): string {
	if (memory.turns.length === 0) return "(No previous turns.)";

	const lines: string[] = [];
	for (let i = 0; i < memory.turns.length; i++) {
		const turn = memory.turns[i]!;
		const label = `[Turn ${i + 1}]`;
		lines.push(label);
		lines.push(`  User: ${turn.userText.slice(0, 200)}`);
		lines.push(`  Alfred: ${turn.finalSpeech.slice(0, 200)}`);
		if (turn.toolsUsed.length > 0) {
			lines.push(`  Tools: ${turn.toolsUsed.join(", ")}`);
		}
		if (turn.workspaceHint) {
			lines.push(`  Workspace: ${turn.workspaceHint}`);
		}
		if (turn.shortOutcome) {
			lines.push(`  Outcome: ${turn.shortOutcome}`);
		}
	}
	return lines.join("\n");
}

/**
 * Generate deterministic markdown handoff content with task overview,
 * current state, recent decisions, files/tools touched, pending confirmations,
 * next steps, commands run, and token accounting.
 */
export function generateHandoffContent(params: {
	taskOverview: string;
	currentState: string;
	recentDecisions: string[];
	filesAndToolsTouched: string[];
	pendingConfirmations: string[];
	nextSteps: string[];
	commandsRun: string[];
	memory: SessionMemory;
	sessionId: string;
	requestId: string;
}): string {
	const lines: string[] = [];

	lines.push("# Alfred Session Handoff");
	lines.push("");
	lines.push("## Task Overview");
	lines.push(params.taskOverview);
	lines.push("");
	lines.push("## Current State");
	lines.push(params.currentState);
	lines.push("");

	lines.push("## Recent Decisions");
	for (const decision of params.recentDecisions) {
		lines.push(`- ${decision}`);
	}
	if (params.recentDecisions.length === 0) {
		lines.push("(none)");
	}
	lines.push("");

	lines.push("## Files / Tools Touched");
	for (const item of params.filesAndToolsTouched) {
		lines.push(`- ${item}`);
	}
	if (params.filesAndToolsTouched.length === 0) {
		lines.push("(none)");
	}
	lines.push("");

	if (params.pendingConfirmations.length > 0) {
		lines.push("## Pending Confirmations");
		for (const confirmation of params.pendingConfirmations) {
			lines.push(`- ${confirmation}`);
		}
		lines.push("");
	}

	lines.push("## Next Steps");
	for (const step of params.nextSteps) {
		lines.push(`- ${step}`);
	}
	if (params.nextSteps.length === 0) {
		lines.push("(none)");
	}
	lines.push("");

	lines.push("## Commands Run");
	for (const cmd of params.commandsRun) {
		lines.push(`- \`${cmd}\``);
	}
	if (params.commandsRun.length === 0) {
		lines.push("(none)");
	}
	lines.push("");

	lines.push("## Token Accounting");
	lines.push(`- Current context tokens: ${params.memory.currentContextTokens}`);
	lines.push(`- Max context tokens: ${params.memory.maxContextTokens}`);
	lines.push(`- Cumulative input tokens: ${params.memory.cumulativeInputTokens}`);
	lines.push(`- Cumulative output tokens: ${params.memory.cumulativeOutputTokens}`);
	lines.push(`- Cumulative total tokens: ${params.memory.cumulativeTotalTokens}`);
	lines.push("");

	lines.push("## Session Info");
	lines.push(`- SessionId: ${params.sessionId}`);
	lines.push(`- RequestId: ${params.requestId}`);
	lines.push("");

	lines.push("## Conversation Summary");
	lines.push(formatConversationForContext(params.memory));

	return lines.join("\n");
}

/**
 * Return the deterministic handoff file path under ~/.alfred/handoffs/
 * with format: YYYY-MM-DDTHH-mm-ss-session-<sessionId>-request-<requestId>.md
 *
 * An optional `baseDir` override is accepted for testing; otherwise
 * the default `~/.alfred/handoffs` is used.
 */
export function handoffFilePath(
	sessionId: string,
	requestId: string,
	baseDir?: string,
): string {
	const now = new Date();
	const timestamp = now.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
	const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	const safeRequest = requestId.replace(/[^a-zA-Z0-9_-]/g, "-");
	const dir = baseDir ?? join(homedir(), ".alfred", "handoffs");
	return join(dir, `${timestamp}-session-${safeSession}-request-${safeRequest}.md`);
}

/**
 * Reset a SessionMemory to its initial empty state.
 */
export function clearMemory(memory: SessionMemory): void {
	memory.turns = [];
	memory.cumulativeInputTokens = 0;
	memory.cumulativeOutputTokens = 0;
	memory.cumulativeTotalTokens = 0;
	memory.currentContextTokens = 0;
	memory.maxContextTokens = 0;
}

/**
 * Remove all files from the handoff directory.
 * Accepts an optional `baseDir` override for testing; otherwise
 * uses `~/.alfred/handoffs`.
 */
export function clearHandoffDir(baseDir?: string): void {
	const dir = baseDir ?? join(homedir(), ".alfred", "handoffs");
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir)) {
			rmSync(join(dir, entry), { force: true });
		}
	}
}
