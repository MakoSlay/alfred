import test from "node:test";
import assert from "node:assert/strict";

import { IDLE_THRESHOLD_S, SAMPLE_INTERVAL_MS, resetActivitySamplerForTests, tickActivitySampler } from "../src/alfred-2/activity/sampler.ts";
import { parseHidIdleSeconds } from "../src/alfred-2/activity/idle.ts";
import { combineMeetingProbeResults } from "../src/alfred-2/activity/meeting.ts";
import { parseMacAudioEngineMicrophoneState } from "../src/alfred-2/activity/microphone.ts";
import type { IdleProbe, MeetingProbe, MeetingState, MicrophoneProbe, MicrophoneState } from "../src/alfred-2/activity/types.ts";

function idle(seconds: number): IdleProbe {
	return async (now = new Date()) => ({ ok: true, idleSeconds: seconds, sampledAt: now.toISOString() });
}

function idleFailure(error = "failed"): IdleProbe {
	return async (now = new Date()) => ({ ok: false, error, sampledAt: now.toISOString() });
}

function meeting(state: MeetingState): MeetingProbe {
	return async (now = new Date()) => ({ state, evidence: [state], confidence: state === "unknown" ? "none" : "low", sampledAt: now.toISOString() });
}

function microphone(state: MicrophoneState = "inactive"): MicrophoneProbe {
	return async (now = new Date()) => ({ state, evidence: [state], sampledAt: now.toISOString() });
}

test("parseHidIdleSeconds parses ioreg nanoseconds safely", () => {
	assert.equal(parseHidIdleSeconds('    | |   "HIDIdleTime" = 1500000000\n'), 1.5);
	assert.equal(parseHidIdleSeconds("no idle time"), null);
});

test("active samples add at most one sample interval even when late", async () => {
	resetActivitySamplerForTests();
	const t0 = new Date("2026-07-02T12:00:00.000Z");
	let snap = await tickActivitySampler({ now: t0, idleProbe: idle(0), meetingProbe: meeting("not_in_meeting"), microphoneProbe: microphone() });
	assert.equal(snap.activeWorkAccumulatedMs, SAMPLE_INTERVAL_MS);

	snap = await tickActivitySampler({ now: new Date(t0.getTime() + 5 * SAMPLE_INTERVAL_MS), idleProbe: idle(1), meetingProbe: meeting("not_in_meeting"), microphoneProbe: microphone() });
	assert.equal(snap.activeWorkAccumulatedMs, SAMPLE_INTERVAL_MS * 2);
});

test("idle at threshold is inactive and does not advance active work", async () => {
	resetActivitySamplerForTests();
	const snap = await tickActivitySampler({ idleProbe: idle(IDLE_THRESHOLD_S), meetingProbe: meeting("not_in_meeting"), microphoneProbe: microphone() });
	assert.equal(snap.activityStatus, "inactive");
	assert.equal(snap.activeWorkAccumulatedMs, 0);
	assert.ok(snap.continuousIdleSeconds >= IDLE_THRESHOLD_S);
});

test("idle probe failure fails closed and does not advance active work", async () => {
	resetActivitySamplerForTests();
	const snap = await tickActivitySampler({ idleProbe: idleFailure("timeout"), meetingProbe: meeting("not_in_meeting"), microphoneProbe: microphone() });
	assert.equal(snap.activityStatus, "unknown");
	assert.equal(snap.idleProbeOk, false);
	assert.equal(snap.activeWorkAccumulatedMs, 0);
	assert.equal(snap.lastError, "timeout");
});

test("active work accumulation pauses during in_meeting and maybe_in_meeting", async () => {
	for (const state of ["in_meeting", "maybe_in_meeting"] as const) {
		resetActivitySamplerForTests();
		const snap = await tickActivitySampler({ idleProbe: idle(0), meetingProbe: meeting(state), microphoneProbe: microphone() });
		assert.equal(snap.activityStatus, "active");
		assert.equal(snap.activeWorkAccumulatedMs, 0, state);
	}
});

test("probe failure meeting state remains unknown", async () => {
	resetActivitySamplerForTests();
	const snap = await tickActivitySampler({ idleProbe: idle(0), meetingProbe: meeting("unknown"), microphoneProbe: microphone() });
	assert.equal(snap.meetingState, "unknown");
	assert.equal(snap.activeWorkAccumulatedMs, SAMPLE_INTERVAL_MS);
});

test("combined meeting probes fail closed when any probe is unknown", () => {
	const combined = combineMeetingProbeResults([
		{ state: "unknown", evidence: ["zoom probe failed"], confidence: "none", sampledAt: "2026-07-02T12:00:00.000Z" },
		{ state: "not_in_meeting", evidence: ["no slack huddle evidence"], confidence: "low", sampledAt: "2026-07-02T12:00:00.000Z" },
	], new Date("2026-07-02T12:00:00.000Z"));
	assert.equal(combined.state, "unknown");
});

test("microphone audio engine parser detects active input engines", () => {
	const active = parseMacAudioEngineMicrophoneState(`
+-o AppleHDAEngineInput:1B,0,1,0 <class IOAudioEngine>
  | {"IOAudioEngineDirection" = "Input","IOAudioEngineState" = 1}
+-o AppleHDAEngineOutput:1B,0,1,1 <class IOAudioEngine>
  | {"IOAudioEngineDirection" = "Output","IOAudioEngineState" = 1}
`);
	assert.equal(active?.state, "active");

	const inactive = parseMacAudioEngineMicrophoneState(`
+-o AppleHDAEngineInput:1B,0,1,0 <class IOAudioEngine>
  | {"IOAudioEngineDirection" = "Input","IOAudioEngineState" = 0}
`);
	assert.equal(inactive?.state, "inactive");

	assert.equal(parseMacAudioEngineMicrophoneState("no audio engines"), null);
});
