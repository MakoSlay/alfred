import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IdleProbeResult } from "./types.ts";

const execFileAsync = promisify(execFile);
export const IDLE_PROBE_TIMEOUT_MS = 5_000;

export async function probeMacIdleSeconds(now = new Date()): Promise<IdleProbeResult> {
	try {
		const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], {
			timeout: IDLE_PROBE_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const idleSeconds = parseHidIdleSeconds(stdout);
		if (idleSeconds === null) {
			return { ok: false, error: "malformed_ioreg_idle_output", sampledAt: now.toISOString() };
		}
		return { ok: true, idleSeconds, sampledAt: now.toISOString() };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), sampledAt: now.toISOString() };
	}
}

export function parseHidIdleSeconds(output: string): number | null {
	const match = output.match(/"HIDIdleTime"\s*=\s*(\d+)/);
	if (!match) return null;
	const ns = Number(match[1]);
	if (!Number.isFinite(ns) || ns < 0) return null;
	return ns / 1_000_000_000;
}
