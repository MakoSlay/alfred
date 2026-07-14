import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resetActiveWorkAccumulator } from "../activity/sampler.ts";
import type { ToolExecutionContext, ToolResult } from "../tool-types.ts";

const DEFAULT_WELLNESS_PATH = join(homedir(), ".alfred", "wellness-state.json");

export function logBreak(ctx: ToolExecutionContext, statePath?: string): ToolResult {
	const t0 = Date.now();
	const path = statePath ?? DEFAULT_WELLNESS_PATH;
	const now = new Date().toISOString();

	resetActiveWorkAccumulator();

	try {
		mkdirSync(dirname(path), { recursive: true });
		let state: Record<string, unknown> = {};
		if (existsSync(path)) {
			try { state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* use empty */ }
		}
		state.lastBreakAcknowledgedAt = now;
		state.activeWorkAccumulatedMs = 0;
		state.breakPending = false;
		state.breakSnoozedUntil = null;
		writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best-effort; the accumulator is already reset in memory.
	}

	return {
		tool: "log_break",
		toolCallId: ctx.toolCallId,
		success: true,
		text: `Break logged at ${now}. Work timer reset.`,
		retryable: false,
		safety: { risk: "mutation", confirmation: "none" },
		timingMs: Date.now() - t0,
	};
}
