import { probeMacIdleSeconds } from "./idle.ts";
import { probeMeetingState } from "./meeting.ts";
import { probeMacMicrophoneState } from "./microphone.ts";
import type { ActivityStateSnapshot, ActivityStatus, IdleProbe, MeetingProbe, MeetingState, MicrophoneProbe, MicrophoneState } from "./types.ts";

export const SAMPLE_INTERVAL_MS = 30_000;
export const IDLE_THRESHOLD_S = 60;
export const IMPLICIT_BREAK_IDLE_S = 30 * 60;
export const MAYBE_MEETING_PAUSE = true;

interface ActivityStateInternal {
	sampledAt: string | null;
	lastSampleMs: number | null;
	idleSeconds: number | null;
	idleProbeOk: boolean;
	activityStatus: ActivityStatus;
	meetingState: MeetingState;
	meetingEvidence: string[];
	microphoneState: MicrophoneState;
	microphoneEvidence: string[];
	activeWorkAccumulatedMs: number;
	continuousIdleSeconds: number;
	lastError: string | null;
	sampleCount: number;
}

const state: ActivityStateInternal = initialState();
let interval: NodeJS.Timeout | null = null;

export interface TickActivitySamplerOptions {
	now?: Date;
	idleProbe?: IdleProbe;
	meetingProbe?: MeetingProbe;
	microphoneProbe?: MicrophoneProbe;
}

export async function tickActivitySampler(options: TickActivitySamplerOptions = {}): Promise<ActivityStateSnapshot> {
	const now = options.now ?? new Date();
	const nowMs = now.getTime();
	const contributionMs = contributionForTick(nowMs);
	const idleProbe = options.idleProbe ?? probeMacIdleSeconds;
	const meetingProbe = options.meetingProbe ?? probeMeetingState;
	const microphoneProbe = options.microphoneProbe ?? probeMacMicrophoneState;

	const [idle, meeting, microphone] = await Promise.all([
		idleProbe(now),
		meetingProbe(now),
		microphoneProbe(now),
	]);

	state.sampledAt = now.toISOString();
	state.lastSampleMs = nowMs;
	state.meetingState = meeting.state;
	state.meetingEvidence = [...meeting.evidence];
	state.microphoneState = microphone.state;
	state.microphoneEvidence = [...microphone.evidence];
	state.sampleCount += 1;

	if (!idle.ok) {
		state.idleSeconds = null;
		state.idleProbeOk = false;
		state.activityStatus = "unknown";
		state.lastError = idle.error;
		return getSnapshot();
	}

	state.idleSeconds = idle.idleSeconds;
	state.idleProbeOk = true;
	state.lastError = null;
	const active = idle.idleSeconds < IDLE_THRESHOLD_S;
	state.activityStatus = active ? "active" : "inactive";
	if (active) {
		state.continuousIdleSeconds = 0;
	} else {
		state.continuousIdleSeconds = Math.max(state.continuousIdleSeconds + contributionMs / 1000, idle.idleSeconds);
	}

	if (active && !meetingPausesAccumulation(meeting.state)) {
		state.activeWorkAccumulatedMs += contributionMs;
	}

	return getSnapshot();
}

export function getSnapshot(): ActivityStateSnapshot {
	return {
		sampledAt: state.sampledAt,
		idleSeconds: state.idleSeconds,
		idleProbeOk: state.idleProbeOk,
		activityStatus: state.activityStatus,
		meetingState: state.meetingState,
		meetingEvidence: [...state.meetingEvidence],
		microphoneState: state.microphoneState,
		microphoneEvidence: [...state.microphoneEvidence],
		activeWorkAccumulatedMs: state.activeWorkAccumulatedMs,
		activeWorkAccumulatedMinutes: state.activeWorkAccumulatedMs / 60_000,
		continuousIdleSeconds: state.continuousIdleSeconds,
		lastError: state.lastError,
		sampleCount: state.sampleCount,
	};
}

export function resetActiveWorkAccumulator(): void {
	state.activeWorkAccumulatedMs = 0;
	state.continuousIdleSeconds = 0;
}

export function restoreActiveWorkAccumulator(ms: number): void {
	if (Number.isFinite(ms) && ms >= 0) {
		state.activeWorkAccumulatedMs = Math.floor(ms);
	}
}

export function startActivitySampler(options: Omit<TickActivitySamplerOptions, "now"> = {}): void {
	if (interval) return;
	interval = setInterval(() => {
		tickActivitySampler(options).catch(() => {
			state.lastError = "activity sampler tick failed";
			state.activityStatus = "unknown";
		});
	}, SAMPLE_INTERVAL_MS);
	interval.unref();
}

export function stopActivitySampler(): void {
	if (!interval) return;
	clearInterval(interval);
	interval = null;
}

export function resetActivitySamplerForTests(): void {
	stopActivitySampler();
	Object.assign(state, initialState());
}

function contributionForTick(nowMs: number): number {
	if (state.lastSampleMs === null) return SAMPLE_INTERVAL_MS;
	return Math.max(0, Math.min(SAMPLE_INTERVAL_MS, nowMs - state.lastSampleMs));
}

function meetingPausesAccumulation(meetingState: MeetingState): boolean {
	if (meetingState === "in_meeting") return true;
	if (meetingState === "maybe_in_meeting") return MAYBE_MEETING_PAUSE;
	return false;
}

function initialState(): ActivityStateInternal {
	return {
		sampledAt: null,
		lastSampleMs: null,
		idleSeconds: null,
		idleProbeOk: false,
		activityStatus: "unknown",
		meetingState: "unknown",
		meetingEvidence: [],
		microphoneState: "unknown",
		microphoneEvidence: [],
		activeWorkAccumulatedMs: 0,
		continuousIdleSeconds: 0,
		lastError: null,
		sampleCount: 0,
	};
}
