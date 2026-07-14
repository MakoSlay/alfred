import { execFile } from "node:child_process";
import type { MeetingProbeResult, MeetingState } from "./types.ts";

export const MEETING_PROBE_TIMEOUT_MS = 5_000;

type ProcessProbeResult = { ok: true; stdout: string; exitCode: number } | { ok: false; error: string };

export async function probeMeetingState(now = new Date()): Promise<MeetingProbeResult> {
	const [zoom, slack] = await Promise.all([
		probeZoomMeetingState(now),
		probeSlackHuddleState(now),
	]);
	return combineMeetingProbeResults([zoom, slack], now);
}

export async function probeZoomMeetingState(now = new Date()): Promise<MeetingProbeResult> {
	const result = await safePgrep("(CptHost|zoom.us|ZoomOpener)");
	if (!result.ok) return { state: "unknown", evidence: [`zoom probe failed: ${result.error}`], confidence: "none", sampledAt: now.toISOString() };
	if (result.exitCode === 1 || !result.stdout.trim()) {
		return { state: "not_in_meeting", evidence: ["no Zoom meeting process evidence"], confidence: "low", sampledAt: now.toISOString() };
	}
	const evidence = result.stdout.trim().split(/\r?\n/).slice(0, 5);
	const hasMeetingHost = /CptHost|zoom\.us/i.test(result.stdout);
	return {
		state: hasMeetingHost ? "maybe_in_meeting" : "not_in_meeting",
		evidence: hasMeetingHost ? evidence : ["Zoom process found without meeting-host evidence"],
		confidence: hasMeetingHost ? "medium" : "low",
		sampledAt: now.toISOString(),
	};
}

export async function probeSlackHuddleState(now = new Date()): Promise<MeetingProbeResult> {
	// MVP: no Accessibility permission and no screen/audio inspection. A running Slack process alone is not huddle evidence.
	const result = await safePgrep("Slack");
	if (!result.ok) return { state: "unknown", evidence: [`slack huddle probe failed: ${result.error}`], confidence: "none", sampledAt: now.toISOString() };
	return {
		state: "not_in_meeting",
		evidence: result.exitCode === 0 && result.stdout.trim()
			? ["Slack process present; non-invasive MVP has no huddle evidence"]
			: ["no Slack process evidence"],
		confidence: "low",
		sampledAt: now.toISOString(),
	};
}

export function combineMeetingProbeResults(results: MeetingProbeResult[], now = new Date()): MeetingProbeResult {
	const evidence = results.flatMap((result) => result.evidence);
	const states = results.map((result) => result.state);
	let state: MeetingState = "not_in_meeting";
	if (states.includes("in_meeting")) state = "in_meeting";
	else if (states.includes("maybe_in_meeting")) state = "maybe_in_meeting";
	else if (states.includes("unknown")) state = "unknown";
	const confidence = state === "in_meeting" ? "high" : state === "maybe_in_meeting" ? "medium" : state === "unknown" ? "none" : "low";
	return { state, evidence, confidence, sampledAt: now.toISOString() };
}

function safePgrep(pattern: string): Promise<ProcessProbeResult> {
	return new Promise((resolve) => {
		execFile("/usr/bin/pgrep", ["-fl", pattern], { timeout: MEETING_PROBE_TIMEOUT_MS }, (error, stdout) => {
			const exitCode = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : 0;
			if (!error || exitCode === 1) {
				resolve({ ok: true, stdout: stdout.toString(), exitCode });
				return;
			}
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
		});
	});
}
