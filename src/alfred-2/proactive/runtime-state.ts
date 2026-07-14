import type { ActivityStateSnapshot } from "../activity/types.ts";
import { getSnapshot } from "../activity/sampler.ts";
import type { MeetingState, RuntimeInterruptionState } from "./types.ts";

export interface RuntimeStateInput {
	muted: boolean;
	mutedUntil: string | null;
	now?: Date;
	activitySnapshot?: Pick<ActivityStateSnapshot, "meetingState" | "meetingEvidence" | "microphoneState" | "microphoneEvidence">;
}

export function createRuntimeInterruptionState(input: RuntimeStateInput): RuntimeInterruptionState {
	const snapshot = input.activitySnapshot ?? getSnapshot();
	return {
		muted: input.muted,
		mutedUntil: input.mutedUntil,
		meetingState: snapshot.meetingState,
		meetingEvidence: snapshot.meetingEvidence,
		microphoneState: snapshot.microphoneState,
		microphoneEvidence: snapshot.microphoneEvidence,
		now: input.now ?? new Date(),
	};
}

export function normalizeMeetingState(value: unknown): MeetingState {
	if (value === "in_meeting" || value === "maybe_in_meeting" || value === "not_in_meeting" || value === "unknown") return value;
	return "unknown";
}
