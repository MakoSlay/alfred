import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProactiveEventStore } from "../src/alfred-2/proactive/event-store.ts";
import type { RuntimeInterruptionState } from "../src/alfred-2/proactive/types.ts";
import type { ActivityStateSnapshot } from "../src/alfred-2/activity/types.ts";
import { IMPLICIT_BREAK_IDLE_S } from "../src/alfred-2/activity/sampler.ts";
import { BREAK_THRESHOLD_MINUTES, SNOOZE_DEFAULT_MINUTES, WellnessWatcher, loadWellnessState } from "../src/alfred-2/watchers/wellness.ts";
import type { ProactiveDeliveryFunctions } from "../src/alfred-2/watchers/types.ts";

function runtime(now: Date, patch: Partial<RuntimeInterruptionState> = {}): RuntimeInterruptionState {
	return { muted: false, mutedUntil: null, meetingState: "not_in_meeting", now, ...patch };
}

function snapshot(patch: Partial<ActivityStateSnapshot> = {}): ActivityStateSnapshot {
	return {
		sampledAt: "2026-07-02T12:00:00.000Z",
		idleSeconds: 0,
		idleProbeOk: true,
		activityStatus: "active",
		meetingState: "not_in_meeting",
		meetingEvidence: [],
		microphoneState: "inactive",
		microphoneEvidence: [],
		activeWorkAccumulatedMs: 0,
		activeWorkAccumulatedMinutes: 0,
		continuousIdleSeconds: 0,
		lastError: null,
		sampleCount: 1,
		...patch,
	};
}

function tempStatePath(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "alfred-wellness-test-"));
	return { dir, path: join(dir, "wellness.json") };
}

function delivery(options: { muted?: boolean; notifyFails?: boolean; speakFails?: boolean } = {}): ProactiveDeliveryFunctions & { notifications: string[]; speeches: string[] } {
	const calls = {
		notifications: [] as string[],
		speeches: [] as string[],
		isMuted: () => Boolean(options.muted),
		async notify(_title: string, body: string) {
			if (options.notifyFails) throw new Error("notify failed");
			calls.notifications.push(body);
		},
		async speak(text: string) {
			if (options.speakFails) throw new Error("speak failed");
			calls.speeches.push(text);
			return true;
		},
	};
	return calls;
}

test("break watcher fires after 90 active minutes and resets only on successful delivery", async () => {
	const { dir, path } = tempStatePath();
	try {
		let resets = 0;
		const d = delivery();
		const watcher = new WellnessWatcher({ eventStore: new ProactiveEventStore(), delivery: d, statePath: path, resetActiveWork: () => { resets += 1; } });
		const result = await watcher.tick({
			runtime: runtime(new Date("2026-07-02T12:00:00.000Z")),
			snapshot: snapshot({ activeWorkAccumulatedMinutes: BREAK_THRESHOLD_MINUTES }),
		});
		assert.equal(result.emitted.length, 1);
		assert.ok(result.emitted[0]?.decision.deliveries.includes("speech"));
		assert.equal(result.emitted[0]?.delivered, true);
		assert.equal(resets, 1);
		assert.equal(watcher.getState().breakPending, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("suppressed break emit stays pending and does not reset active work", async () => {
	const { dir, path } = tempStatePath();
	try {
		let resets = 0;
		const watcher = new WellnessWatcher({ eventStore: new ProactiveEventStore(), delivery: delivery({ muted: true }), statePath: path, resetActiveWork: () => { resets += 1; } });
		const result = await watcher.tick({
			runtime: runtime(new Date("2026-07-02T12:00:00.000Z"), { muted: true }),
			snapshot: snapshot({ activeWorkAccumulatedMinutes: BREAK_THRESHOLD_MINUTES }),
		});
		assert.equal(result.emitted.length, 1);
		assert.deepEqual(result.emitted[0]?.decision.deliveries, ["dashboard"]);
		assert.equal(result.emitted[0]?.delivered, false);
		assert.equal(resets, 0);
		assert.equal(watcher.getState().breakPending, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snooze and implicit idle acknowledgement reset break timer", async () => {
	const { dir, path } = tempStatePath();
	try {
		let resets = 0;
		const watcher = new WellnessWatcher({ eventStore: new ProactiveEventStore(), delivery: delivery({ muted: true }), statePath: path, resetActiveWork: () => { resets += 1; } });
		const now = new Date("2026-07-02T12:00:00.000Z");
		watcher.snoozeBreak(undefined, now);
		assert.equal(resets, 1);
		assert.equal(watcher.getState().breakSnoozedUntil, new Date(now.getTime() + SNOOZE_DEFAULT_MINUTES * 60_000).toISOString());

		await watcher.tick({ runtime: runtime(now, { muted: true }), snapshot: snapshot({ activeWorkAccumulatedMinutes: BREAK_THRESHOLD_MINUTES }) });
		assert.equal(watcher.getState().breakPending, false, "snooze prevents immediate refire");

		await watcher.tick({ runtime: runtime(new Date(now.getTime() + 21 * 60_000), { muted: true }), snapshot: snapshot({ activeWorkAccumulatedMinutes: BREAK_THRESHOLD_MINUTES }) });
		assert.equal(watcher.getState().breakPending, true, "suppressed post-snooze break becomes pending");

		await watcher.tick({ runtime: runtime(new Date(now.getTime() + 22 * 60_000), { muted: true }), snapshot: snapshot({ activeWorkAccumulatedMinutes: BREAK_THRESHOLD_MINUTES, continuousIdleSeconds: IMPLICIT_BREAK_IDLE_S }) });
		assert.equal(watcher.getState().breakPending, false);
		assert.ok(resets >= 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lunch fires once during 2-3pm on active tick and persists fired date", async () => {
	const { dir, path } = tempStatePath();
	try {
		const store = new ProactiveEventStore();
		const watcher = new WellnessWatcher({ eventStore: store, delivery: delivery(), statePath: path });
		const first = await watcher.tick({ runtime: runtime(new Date("2026-07-02T14:05:00")), snapshot: snapshot({ idleSeconds: 30, activeWorkAccumulatedMinutes: 30 }) });
		assert.equal(first.emitted.length, 1);
		assert.equal(first.emitted[0]?.event.watcherId, "wellness.lunch");
		const second = await watcher.tick({ runtime: runtime(new Date("2026-07-02T14:06:00")), snapshot: snapshot({ idleSeconds: 30, activeWorkAccumulatedMinutes: 30 }) });
		assert.equal(second.emitted.length, 0);

		const restarted = new WellnessWatcher({ eventStore: new ProactiveEventStore(), delivery: delivery(), statePath: path });
		const afterRestart = await restarted.tick({ runtime: runtime(new Date("2026-07-02T14:07:00")), snapshot: snapshot({ idleSeconds: 30, activeWorkAccumulatedMinutes: 30 }) });
		assert.equal(afterRestart.emitted.length, 0);
		assert.equal(loadWellnessState(path).lastLunchFiredDate, "2026-07-02");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("meal windows require current activity and dinner requires accumulated work", async () => {
	const { dir, path } = tempStatePath();
	try {
		const watcher = new WellnessWatcher({ eventStore: new ProactiveEventStore(), delivery: delivery(), statePath: path });
		const idleLunch = await watcher.tick({ runtime: runtime(new Date("2026-07-02T14:05:00")), snapshot: snapshot({ idleSeconds: 120 }) });
		assert.equal(idleLunch.emitted.length, 0);
		const noWorkDinner = await watcher.tick({ runtime: runtime(new Date("2026-07-02T20:05:00")), snapshot: snapshot({ idleSeconds: 30, activeWorkAccumulatedMinutes: 0 }) });
		assert.equal(noWorkDinner.emitted.length, 0);
		const dinner = await watcher.tick({ runtime: runtime(new Date("2026-07-02T20:06:00")), snapshot: snapshot({ idleSeconds: 30, activeWorkAccumulatedMinutes: 30 }) });
		assert.equal(dinner.emitted.length, 1);
		assert.equal(dinner.emitted[0]?.event.watcherId, "wellness.dinner");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
