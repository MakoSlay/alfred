import type { MeetingState } from "../proactive/types.ts";
import type { MicrophoneProbeResult, MicrophoneState } from "./microphone.ts";

export type { MeetingState, MicrophoneState };

export interface IdleProbeSuccess {
	ok: true;
	idleSeconds: number;
	sampledAt: string;
}

export interface IdleProbeFailure {
	ok: false;
	error: string;
	sampledAt: string;
}

export type IdleProbeResult = IdleProbeSuccess | IdleProbeFailure;

export interface MeetingProbeResult {
	state: MeetingState;
	evidence: string[];
	confidence: "none" | "low" | "medium" | "high";
	sampledAt: string;
}

export type ActivityStatus = "active" | "inactive" | "unknown";

export interface ActivityStateSnapshot {
	sampledAt: string | null;
	idleSeconds: number | null;
	idleProbeOk: boolean;
	activityStatus: ActivityStatus;
	meetingState: MeetingState;
	meetingEvidence: string[];
	microphoneState: MicrophoneState;
	microphoneEvidence: string[];
	activeWorkAccumulatedMs: number;
	activeWorkAccumulatedMinutes: number;
	continuousIdleSeconds: number;
	lastError: string | null;
	sampleCount: number;
}

export type IdleProbe = (now?: Date) => Promise<IdleProbeResult>;
export type MeetingProbe = (now?: Date) => Promise<MeetingProbeResult>;
export type MicrophoneProbe = (now?: Date) => Promise<MicrophoneProbeResult>;
