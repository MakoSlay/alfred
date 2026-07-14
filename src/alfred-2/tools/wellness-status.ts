import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSnapshot } from "../activity/sampler.ts";
import type { ToolExecutionContext, ToolResult } from "../tool-types.ts";

const DEFAULT_WELLNESS_PATH = join(homedir(), ".alfred", "wellness-state.json");

export interface WellnessStatusData {
	minutesWorked: number;
	minutesUntilBreak: number;
	breakPending: boolean;
	breakSnoozedUntil: string | null;
	lastBreakAcknowledgedAt: string | null;
	lunchFiredToday: boolean;
	dinnerFiredToday: boolean;
}

export function wellnessStatus(ctx: ToolExecutionContext, statePath?: string): ToolResult<WellnessStatusData> {
	const t0 = Date.now();
	const path = statePath ?? DEFAULT_WELLNESS_PATH;
	const snapshot = getSnapshot();
	const minutesWorked = Math.round(snapshot.activeWorkAccumulatedMinutes);
	const minutesUntilBreak = Math.max(0, 90 - minutesWorked);

	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	let fileState: Record<string, unknown> = {};
	if (existsSync(path)) {
		try { fileState = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* use empty */ }
	}

	const breakPending = fileState.breakPending === true;
	const breakSnoozedUntil = typeof fileState.breakSnoozedUntil === "string" ? fileState.breakSnoozedUntil : null;
	const lastBreak = typeof fileState.lastBreakAcknowledgedAt === "string" ? fileState.lastBreakAcknowledgedAt : null;
	const lunchFiredToday = fileState.lastLunchFiredDate === today;
	const dinnerFiredToday = fileState.lastDinnerFiredDate === today;

	const parts: string[] = [];
	parts.push(minutesWorked > 0
		? `Active work: ${minutesWorked} minute${minutesWorked === 1 ? "" : "s"}.`
		: "No active work session.");
	if (breakPending) parts.push("Break reminder is pending.");
	else if (minutesUntilBreak <= 0) parts.push("Break is due now.");
	else parts.push(`Next break in ~${minutesUntilBreak} minute${minutesUntilBreak === 1 ? "" : "s"}.`);
	if (lastBreak) parts.push(`Last break: ${lastBreak}.`);
	if (lunchFiredToday) parts.push("Lunch reminder already sent today.");
	if (dinnerFiredToday) parts.push("Dinner reminder already sent today.");

	const data: WellnessStatusData = {
		minutesWorked, minutesUntilBreak, breakPending, breakSnoozedUntil,
		lastBreakAcknowledgedAt: lastBreak, lunchFiredToday, dinnerFiredToday,
	};

	return {
		tool: "wellness_status",
		toolCallId: ctx.toolCallId,
		success: true,
		text: parts.join(" "),
		data,
		retryable: false,
		safety: { risk: "read", confirmation: "none" },
		timingMs: Date.now() - t0,
	};
}
