import test from "node:test";
import assert from "node:assert/strict";

import { ProactiveEventStore, PROACTIVE_EVENT_CAP } from "../src/alfred-2/proactive/event-store.ts";
import { decideProactiveDelivery } from "../src/alfred-2/proactive/policy.ts";
import type { ProactiveEvent, RuntimeInterruptionState } from "../src/alfred-2/proactive/types.ts";

const now = new Date("2026-07-02T12:00:00.000Z");

function runtime(patch: Partial<RuntimeInterruptionState> = {}): RuntimeInterruptionState {
	return { muted: false, mutedUntil: null, meetingState: "not_in_meeting", now, ...patch };
}

function event(patch: Partial<ProactiveEvent> = {}): ProactiveEvent {
	return {
		id: patch.id ?? "evt-1",
		watcherId: patch.watcherId ?? "wellness.break",
		kind: patch.kind ?? "wellness",
		priority: patch.priority ?? "important",
		title: patch.title ?? "Break",
		message: patch.message ?? "Take a break",
		createdAt: patch.createdAt ?? now.toISOString(),
		dedupeKey: patch.dedupeKey,
		privacy: patch.privacy ?? { mayStoreMessage: true },
		metadata: patch.metadata,
	};
}

test("mute suppresses proactive speech and notifications", () => {
	const store = new ProactiveEventStore();
	const decision = decideProactiveDelivery(event({ priority: "urgent" }), runtime({ muted: true }), store.getCooldownSnapshot());
	assert.deepEqual(decision.deliveries, ["dashboard"]);
	assert.equal(decision.suppressReason, "muted");
});

test("urgent bypasses cooldown but not mute", () => {
	const store = new ProactiveEventStore();
	const first = event({ id: "first", dedupeKey: "break" });
	const firstDecision = store.decideAndRecord(first, runtime());
	assert.ok(firstDecision.deliveries.includes("speech"));

	const nonUrgent = event({ id: "second", dedupeKey: "break", priority: "important" });
	const nonUrgentDecision = store.decide(nonUrgent, runtime({ now: new Date(now.getTime() + 5 * 60_000) }));
	assert.equal(nonUrgentDecision.suppressReason, "kind_cooldown");
	assert.ok(!nonUrgentDecision.deliveries.includes("speech"));

	const urgent = event({ id: "third", dedupeKey: "break", priority: "urgent" });
	const urgentDecision = store.decide(urgent, runtime({ now: new Date(now.getTime() + 5 * 60_000) }));
	assert.ok(urgentDecision.deliveries.includes("speech"));

	const urgentMuted = store.decide(urgent, runtime({ muted: true, now: new Date(now.getTime() + 5 * 60_000) }));
	assert.deepEqual(urgentMuted.deliveries, ["dashboard"]);
});

test("speech is suppressed for uncertain or active meeting states", () => {
	for (const meetingState of ["in_meeting", "maybe_in_meeting", "unknown"] as const) {
		const store = new ProactiveEventStore();
		const decision = store.decide(event({ priority: "important" }), runtime({ meetingState }));
		assert.ok(!decision.deliveries.includes("speech"), meetingState);
		if (meetingState === "unknown") assert.ok(!decision.deliveries.includes("notification"), "wellness unknown stays dashboard only");
	}
});

test("active microphone suppresses proactive speech while preserving notifications", () => {
	const store = new ProactiveEventStore();
	const decision = store.decide(event({ priority: "important" }), runtime({ microphoneState: "active" }));
	assert.ok(decision.deliveries.includes("notification"));
	assert.ok(!decision.deliveries.includes("speech"));
});

test("work-awareness speech requires a known inactive microphone", () => {
	for (const microphoneState of [undefined, "unknown", "active"] as const) {
		const store = new ProactiveEventStore();
		const decision = store.decide(event({ kind: "stuck_work", priority: "important" }), runtime({ microphoneState }));
		assert.ok(decision.deliveries.includes("notification"));
		assert.ok(!decision.deliveries.includes("speech"));
	}
});

test("Slack speech requires urgent missed likely-forgotten actionable metadata", () => {
	const base = event({ kind: "slack_attention", priority: "urgent", privacy: { mayStoreMessage: false }, createdAt: now.toISOString() });
	const store = new ProactiveEventStore();
	const noMetadata = store.decide(base, runtime());
	assert.ok(noMetadata.deliveries.includes("notification"));
	assert.ok(!noMetadata.deliveries.includes("speech"));

	const actionable = store.decide(event({
		...base,
		metadata: { slack: { itemCreatedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(), requiresAction: true, reviewed: false, previouslySurfaced: false } },
	}), runtime());
	assert.ok(actionable.deliveries.includes("speech"));
});

test("event store redacts non-storable messages and caps at 200 events", () => {
	const store = new ProactiveEventStore();
	store.recordEvent(event({ kind: "slack_attention", privacy: { mayStoreMessage: false }, message: "secret slack content" }));
	assert.equal(store.getRecentEvents()[0]?.message, undefined);

	for (let i = 0; i < PROACTIVE_EVENT_CAP + 5; i += 1) {
		store.recordEvent(event({ id: `evt-${i}`, dedupeKey: undefined, title: `event ${i}` }));
	}
	assert.equal(store.getRecentEvents(PROACTIVE_EVENT_CAP + 10).length, PROACTIVE_EVENT_CAP);
});

test("dedupe key replaces the previous stored event", () => {
	const store = new ProactiveEventStore();
	store.recordEvent(event({ id: "old", dedupeKey: "same", title: "old" }));
	store.recordEvent(event({ id: "new", dedupeKey: "same", title: "new" }));
	const events = store.getRecentEvents();
	assert.equal(events.length, 1);
	assert.equal(events[0]?.id, "new");
});
