import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoalJobStore, ScheduledJobRunner } from "../src/alfred-2/goals.ts";
import { ProactiveEventStore } from "../src/alfred-2/proactive/event-store.ts";
import type { RuntimeInterruptionState } from "../src/alfred-2/proactive/types.ts";

function runtime(now: Date): RuntimeInterruptionState {
	return { muted: false, mutedUntil: null, meetingState: "not_in_meeting", microphoneState: "inactive", now };
}

function tempStore(now: () => Date, idFactory = (() => "one")) {
	const directory = mkdtempSync(join(tmpdir(), "alfred-goals-"));
	const path = join(directory, "goals.json");
	return { directory, path, store: new GoalJobStore({ path, now, idFactory }) };
}

test("goal store persists goals and completion across restart", () => {
	const now = new Date("2026-07-16T12:00:00.000Z");
	const fixture = tempStore(() => now);
	try {
		const goal = fixture.store.createGoal("Ship work advisor", "Keep it quiet by default");
		fixture.store.completeGoal(goal.id);
		const reloaded = new GoalJobStore({ path: fixture.path, now: () => now });
		assert.equal(reloaded.listGoals()[0]?.status, "completed");
		assert.equal(reloaded.listGoals()[0]?.notes, "Keep it quiet by default");
		assert.equal(readFileSync(fixture.path, "utf8").includes("Ship work advisor"), true);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("corrupt goal store fails closed instead of overwriting data", () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-goals-corrupt-"));
	const path = join(directory, "goals.json");
	try {
		writeFileSync(path, "not-json", "utf8");
		const store = new GoalJobStore({ path });
		assert.equal(store.getStatus().healthy, false);
		assert.throws(() => store.createGoal("Must not overwrite"), /unavailable/);
		assert.equal(readFileSync(path, "utf8"), "not-json");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("recurring jobs enforce a 15 minute minimum and advance after delivery", async () => {
	let now = new Date("2026-07-16T12:00:00.000Z");
	const fixture = tempStore(() => now);
	try {
		assert.throws(() => fixture.store.scheduleJob({ kind: "reminder", title: "Too frequent", runAt: now.toISOString(), recurrenceMinutes: 5 }), /at least 15/);
		const job = fixture.store.scheduleJob({ kind: "reminder", title: "Review the pull request", runAt: now.toISOString(), recurrenceMinutes: 30 });
		const spoken: string[] = [];
		const runner = new ScheduledJobRunner({
			store: fixture.store,
			eventStore: new ProactiveEventStore(),
			now: () => now,
			runtime: () => runtime(now),
			delivery: {
				isMuted: () => false,
				notify: async () => {},
				speak: async (text) => { spoken.push(text); return true; },
			},
		});
		assert.equal(await runner.tick(), 1);
		assert.deepEqual(spoken, ["Review the pull request"]);
		const advanced = fixture.store.listJobs().find((item) => item.id === job.id)!;
		assert.equal(advanced.runAt, "2026-07-16T12:30:00.000Z");
		assert.equal(advanced.enabled, true);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("schedule timestamps and recurrence bounds are strict", () => {
	const now = new Date("2026-07-16T12:00:00.000Z");
	const fixture = tempStore(() => now);
	try {
		assert.throws(() => fixture.store.scheduleJob({ kind: "reminder", title: "date only", runAt: "2026-07-16" }), /RFC3339/);
		assert.throws(() => fixture.store.scheduleJob({ kind: "reminder", title: "rollover", runAt: "2026-02-30T12:00:00Z" }), /RFC3339/);
		assert.throws(() => fixture.store.scheduleJob({ kind: "reminder", title: "too sparse", runAt: now.toISOString(), recurrenceMinutes: 525_601 }), /at most 525600/);
		assert.doesNotThrow(() => fixture.store.scheduleJob({ kind: "reminder", title: "bounded", runAt: "2026-07-16T14:00:00+02:00", recurrenceMinutes: 525_600 }));
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("work reviews stay due until the advisor reports a consumable result", async () => {
	const now = new Date("2026-07-16T12:00:00.000Z");
	const fixture = tempStore(() => now);
	try {
		const job = fixture.store.scheduleJob({ kind: "work_review", title: "Review current work", runAt: now.toISOString(), workspaceRef: "workspace:1", surfaceRef: "surface:1" });
		let consume = false;
		const runner = new ScheduledJobRunner({
			store: fixture.store,
			now: () => now,
			runtime: () => runtime(now),
			onWorkReview: async () => consume,
			delivery: { isMuted: () => false, notify: async () => {}, speak: async () => true },
		});
		assert.equal(await runner.tick(), 0);
		assert.equal(fixture.store.dueJobs(now).some((item) => item.id === job.id), true);
		assert.equal(fixture.store.listJobs().find((item) => item.id === job.id)?.lastAttemptStatus, "retrying");
		consume = true;
		assert.equal(await runner.tick(), 1);
		assert.equal(fixture.store.listJobs().find((item) => item.id === job.id)?.enabled, false);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("a disabled or failing work advisor never becomes a reminder or blocks later jobs", async () => {
	const now = new Date("2026-07-16T12:00:00.000Z");
	let id = 0;
	const fixture = tempStore(() => now, () => String(++id));
	try {
		const review = fixture.store.scheduleJob({ kind: "work_review", title: "Do not speak this title", runAt: now.toISOString(), workspaceRef: "workspace:1", surfaceRef: "surface:1" });
		fixture.store.scheduleJob({ kind: "reminder", title: "Later reminder", runAt: now.toISOString() });
		const notified: string[] = [];
		const errors: string[] = [];
		const runner = new ScheduledJobRunner({
			store: fixture.store,
			now: () => now,
			runtime: () => runtime(now),
			onWorkReview: async () => { throw new Error("advisor unavailable"); },
			onJobError: (job) => { errors.push(job.id); },
			delivery: { isMuted: () => false, notify: async (_title, message) => { notified.push(message); }, speak: async () => false },
		});
		assert.equal(await runner.tick(), 1);
		assert.deepEqual(errors, [review.id]);
		assert.deepEqual(notified, ["Later reminder"]);
		assert.equal(fixture.store.dueJobs(now).some((item) => item.id === review.id), true);
		assert.match(fixture.store.listJobs().find((item) => item.id === review.id)?.lastAttemptReason ?? "", /advisor unavailable/);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("suppressed one-time reminder stays due for a later delivery", async () => {
	const now = new Date("2026-07-16T12:00:00.000Z");
	const fixture = tempStore(() => now);
	try {
		const job = fixture.store.scheduleJob({ kind: "reminder", title: "Still due", runAt: now.toISOString() });
		const runner = new ScheduledJobRunner({
			store: fixture.store,
			eventStore: new ProactiveEventStore(),
			now: () => now,
			runtime: () => ({ ...runtime(now), muted: true }),
			delivery: { isMuted: () => true, notify: async () => {}, speak: async () => false },
		});
		assert.equal(await runner.tick(), 0);
		assert.equal(fixture.store.listJobs().find((item) => item.id === job.id)?.enabled, true);
		assert.equal(fixture.store.dueJobs(now).length, 1);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});
