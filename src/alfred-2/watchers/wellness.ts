import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { IMPLICIT_BREAK_IDLE_S, resetActiveWorkAccumulator } from "../activity/sampler.ts";
import type { ActivityStateSnapshot } from "../activity/types.ts";
import { ProactiveEventStore, proactiveEventStore } from "../proactive/event-store.ts";
import type { ProactiveDecision, ProactiveEvent, RuntimeInterruptionState } from "../proactive/types.ts";
import { notify as defaultNotify, speak as defaultSpeak } from "../speech.ts";
import type { ProactiveDeliveryFunctions, WatcherEmitResult } from "./types.ts";

export const BREAK_THRESHOLD_MINUTES = 90;
export const MEAL_MIN_WORK_MINUTES = 30;
export const SNOOZE_DEFAULT_MINUTES = 20;
export const LUNCH_WINDOW = { start: 14, end: 15 } as const;
export const DINNER_WINDOW = { start: 20, end: 21 } as const;
export const MEAL_ACTIVE_IDLE_S = 120;

const DEFAULT_STATE_PATH = join(homedir(), ".alfred", "wellness-state.json");

export interface WellnessPersistentState {
	lastLunchFiredDate: string | null;
	lastDinnerFiredDate: string | null;
	lastBreakAcknowledgedAt: string | null;
}

export interface WellnessRuntimeState {
	breakPending: boolean;
	breakSnoozedUntil: string | null;
	lastBreakEventAt: string | null;
	lastBreakAcknowledgedAt: string | null;
}

export interface WellnessWatcherOptions {
	eventStore?: ProactiveEventStore;
	delivery?: ProactiveDeliveryFunctions;
	statePath?: string;
	resetActiveWork?: () => void;
	idFactory?: () => string;
	initialBreakPending?: boolean;
	initialBreakSnoozedUntil?: string | null;
	initialLastBreakAcknowledgedAt?: string | null;
}

export interface WellnessTickInput {
	snapshot: ActivityStateSnapshot;
	runtime: RuntimeInterruptionState;
}

export interface WellnessTickResult {
	emitted: WatcherEmitResult[];
	state: WellnessRuntimeState;
	persistentState: WellnessPersistentState;
}

export class WellnessWatcher {
	private readonly eventStore: ProactiveEventStore;
	private readonly delivery: ProactiveDeliveryFunctions;
	private readonly statePath: string;
	private readonly resetActiveWork: () => void;
	private readonly idFactory: () => string;
	private persistentState: WellnessPersistentState;
	private runtimeState: WellnessRuntimeState = {
		breakPending: false,
		breakSnoozedUntil: null,
		lastBreakEventAt: null,
		lastBreakAcknowledgedAt: null,
	};

	constructor(options: WellnessWatcherOptions = {}) {
		this.eventStore = options.eventStore ?? proactiveEventStore;
		this.delivery = options.delivery ?? {
			speak: defaultSpeak,
			notify: defaultNotify,
			isMuted: () => false,
		};
		this.statePath = options.statePath ?? DEFAULT_STATE_PATH;
		this.resetActiveWork = options.resetActiveWork ?? resetActiveWorkAccumulator;
		this.idFactory = options.idFactory ?? (() => `wellness-${randomUUID()}`);
		this.persistentState = loadWellnessState(this.statePath);
		if (options.initialBreakPending !== undefined) this.runtimeState.breakPending = options.initialBreakPending;
		if (options.initialBreakSnoozedUntil !== undefined) this.runtimeState.breakSnoozedUntil = options.initialBreakSnoozedUntil;
		if (options.initialLastBreakAcknowledgedAt !== undefined) this.runtimeState.lastBreakAcknowledgedAt = options.initialLastBreakAcknowledgedAt;
	}

	async tick(input: WellnessTickInput): Promise<WellnessTickResult> {
		const emitted: WatcherEmitResult[] = [];
		const now = input.runtime.now;
		const today = localDateKey(now);

		if (this.runtimeState.breakPending && input.snapshot.continuousIdleSeconds >= IMPLICIT_BREAK_IDLE_S) {
			this.acknowledgeBreak("implicit_idle_break");
		}

		if (this.shouldFireBreak(input.snapshot, now)) {
			const result = await this.emit(input.runtime, makeBreakEvent(this.idFactory(), now));
			emitted.push(result);
			this.runtimeState.breakPending = !result.delivered;
			this.runtimeState.lastBreakEventAt = now.toISOString();
			if (result.delivered) this.resetAfterSuccessfulBreak();
		}

		if (this.shouldFireLunch(input.snapshot, now, today)) {
			const result = await this.emit(input.runtime, makeLunchEvent(this.idFactory(), now));
			emitted.push(result);
			this.persistentState.lastLunchFiredDate = today;
			saveWellnessState(this.statePath, this.persistentState);
		}

		if (this.shouldFireDinner(input.snapshot, now, today)) {
			const result = await this.emit(input.runtime, makeDinnerEvent(this.idFactory(), now));
			emitted.push(result);
			this.persistentState.lastDinnerFiredDate = today;
			saveWellnessState(this.statePath, this.persistentState);
		}

		return { emitted, state: this.getState(), persistentState: this.getPersistentState() };
	}

	acknowledgeBreak(_reason = "acknowledged"): void {
		this.runtimeState.breakPending = false;
		this.runtimeState.breakSnoozedUntil = null;
		this.runtimeState.lastBreakAcknowledgedAt = new Date().toISOString();
		this.resetActiveWork();
	}

	snoozeBreak(minutes = SNOOZE_DEFAULT_MINUTES, now = new Date()): void {
		this.runtimeState.breakPending = false;
		this.runtimeState.breakSnoozedUntil = new Date(now.getTime() + minutes * 60_000).toISOString();
		this.resetActiveWork();
	}

	dismissBreak(): void {
		this.acknowledgeBreak("dismissed");
	}

	getState(): WellnessRuntimeState {
		return { ...this.runtimeState };
	}

	getPersistentState(): WellnessPersistentState {
		return { ...this.persistentState };
	}

	private shouldFireBreak(snapshot: ActivityStateSnapshot, now: Date): boolean {
		if (snapshot.continuousIdleSeconds >= IMPLICIT_BREAK_IDLE_S) return false;
		if (snapshot.activeWorkAccumulatedMinutes < BREAK_THRESHOLD_MINUTES) return false;
		if (this.runtimeState.breakSnoozedUntil && new Date(this.runtimeState.breakSnoozedUntil) > now) return false;
		return true;
	}

	private shouldFireLunch(snapshot: ActivityStateSnapshot, now: Date, today: string): boolean {
		return this.persistentState.lastLunchFiredDate !== today
			&& isHourInWindow(now, LUNCH_WINDOW)
			&& snapshot.activeWorkAccumulatedMinutes >= MEAL_MIN_WORK_MINUTES
			&& typeof snapshot.idleSeconds === "number"
			&& snapshot.idleSeconds < MEAL_ACTIVE_IDLE_S;
	}

	private shouldFireDinner(snapshot: ActivityStateSnapshot, now: Date, today: string): boolean {
		return this.persistentState.lastDinnerFiredDate !== today
			&& isHourInWindow(now, DINNER_WINDOW)
			&& snapshot.activeWorkAccumulatedMinutes >= MEAL_MIN_WORK_MINUTES
			&& typeof snapshot.idleSeconds === "number"
			&& snapshot.idleSeconds < MEAL_ACTIVE_IDLE_S;
	}

	private async emit(runtime: RuntimeInterruptionState, event: ProactiveEvent): Promise<WatcherEmitResult> {
		const decision = this.eventStore.decide(event, runtime);
		this.eventStore.recordEvent(event);
		const delivered = await executeDelivery(event, decision, this.delivery);
		if (delivered) this.eventStore.recordCooldownsForDecision(event, decision, runtime.now.getTime());
		return { event, decision, delivered };
	}

	private resetAfterSuccessfulBreak(): void {
		this.runtimeState.breakPending = false;
		this.runtimeState.breakSnoozedUntil = null;
		this.resetActiveWork();
	}
}

export interface DeliveryOutcome {
	delivered: boolean;
	notificationDelivered: boolean;
	speechDelivered: boolean;
}

export async function executeDeliveryWithOutcome(event: ProactiveEvent, decision: ProactiveDecision, delivery: ProactiveDeliveryFunctions): Promise<DeliveryOutcome> {
	let notificationDelivered = false;
	let speechDelivered = false;
	if (decision.deliveries.includes("notification")) {
		try {
			await delivery.notify(event.title, event.message);
			notificationDelivered = true;
		} catch {
			// Keep pending if every interruptive channel fails.
		}
	}
	if (decision.deliveries.includes("speech") && !delivery.isMuted()) {
		try {
			const spoken = await delivery.speak(event.message);
			if (spoken && !delivery.isMuted()) speechDelivered = true;
		} catch {
			// Keep pending if every interruptive channel fails.
		}
	}
	return { delivered: notificationDelivered || speechDelivered, notificationDelivered, speechDelivered };
}

export async function executeDelivery(event: ProactiveEvent, decision: ProactiveDecision, delivery: ProactiveDeliveryFunctions): Promise<boolean> {
	return (await executeDeliveryWithOutcome(event, decision, delivery)).delivered;
}

export function loadWellnessState(path = DEFAULT_STATE_PATH): WellnessPersistentState {
	try {
		if (!existsSync(path)) return defaultPersistentState();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WellnessPersistentState & { activeWorkAccumulatedMs?: number; breakPending?: boolean; breakSnoozedUntil?: string | null }>;
		return {
			lastLunchFiredDate: typeof parsed.lastLunchFiredDate === "string" ? parsed.lastLunchFiredDate : null,
			lastDinnerFiredDate: typeof parsed.lastDinnerFiredDate === "string" ? parsed.lastDinnerFiredDate : null,
			lastBreakAcknowledgedAt: typeof parsed.lastBreakAcknowledgedAt === "string" ? parsed.lastBreakAcknowledgedAt : null,
		};
	} catch {
		return defaultPersistentState();
	}
}

export function saveWellnessState(path: string, state: WellnessPersistentState, runtime?: { breakPending?: boolean; breakSnoozedUntil?: string | null; activeWorkAccumulatedMs?: number }): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const payload: Record<string, unknown> = { ...state };
		if (runtime) {
			payload.breakPending = runtime.breakPending;
			payload.breakSnoozedUntil = runtime.breakSnoozedUntil;
			if (runtime.activeWorkAccumulatedMs !== undefined) payload.activeWorkAccumulatedMs = runtime.activeWorkAccumulatedMs;
		}
		writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
	} catch {
		// Best-effort local assistant state.
	}
}

export function saveFullWellnessState(path: string | undefined, params: { persistent: WellnessPersistentState; breakPending: boolean; breakSnoozedUntil: string | null; lastBreakAcknowledgedAt: string | null; activeWorkAccumulatedMs: number }): void {
	saveWellnessState(path ?? DEFAULT_STATE_PATH, params.persistent, {
		breakPending: params.breakPending,
		breakSnoozedUntil: params.breakSnoozedUntil,
		activeWorkAccumulatedMs: params.activeWorkAccumulatedMs,
	});
}

export function loadFullWellnessState(path?: string): { persistent: WellnessPersistentState; breakPending: boolean; breakSnoozedUntil: string | null; activeWorkAccumulatedMs: number } {
	const p = path ?? DEFAULT_STATE_PATH;
	const persistent = loadWellnessState(p);
	let breakPending = false;
	let breakSnoozedUntil: string | null = null;
	let activeWorkAccumulatedMs = 0;
	try {
		if (existsSync(p)) {
			const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
			if (typeof raw.breakPending === "boolean") breakPending = raw.breakPending;
			if (typeof raw.breakSnoozedUntil === "string") breakSnoozedUntil = raw.breakSnoozedUntil;
			if (typeof raw.activeWorkAccumulatedMs === "number" && Number.isFinite(raw.activeWorkAccumulatedMs)) activeWorkAccumulatedMs = raw.activeWorkAccumulatedMs as number;
		}
	} catch { /* use defaults */ }
	return { persistent, breakPending, breakSnoozedUntil, activeWorkAccumulatedMs };
}

function defaultPersistentState(): WellnessPersistentState {
	return { lastLunchFiredDate: null, lastDinnerFiredDate: null, lastBreakAcknowledgedAt: null };
}

function makeBreakEvent(id: string, now: Date): ProactiveEvent {
	return {
		id,
		watcherId: "wellness.break",
		kind: "wellness",
		priority: "important",
		title: "Time for a short reset",
		message: "Sir, you’ve been at it for about ninety minutes. A short reset may be cheaper than brute force.",
		createdAt: now.toISOString(),
		dedupeKey: "wellness:break",
		privacy: { mayStoreMessage: true },
	};
}

function makeLunchEvent(id: string, now: Date): ProactiveEvent {
	return {
		id,
		watcherId: "wellness.lunch",
		kind: "wellness",
		priority: "low",
		title: "Lunch check",
		message: "Tiny butlerly observation, sir: lunch is looking overdue.",
		createdAt: now.toISOString(),
		dedupeKey: `wellness:lunch:${localDateKey(now)}`,
		privacy: { mayStoreMessage: true },
	};
}

function makeDinnerEvent(id: string, now: Date): ProactiveEvent {
	return {
		id,
		watcherId: "wellness.dinner",
		kind: "wellness",
		priority: "low",
		title: "Dinner check",
		message: "Dinner may be worth defending, sir. The code will still be dramatic afterward.",
		createdAt: now.toISOString(),
		dedupeKey: `wellness:dinner:${localDateKey(now)}`,
		privacy: { mayStoreMessage: true },
	};
}

function isHourInWindow(date: Date, window: { start: number; end: number }): boolean {
	const hour = date.getHours();
	return hour >= window.start && hour < window.end;
}

export function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
