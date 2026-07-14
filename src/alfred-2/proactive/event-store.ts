import type {
	ProactiveDecision,
	ProactiveDelivery,
	ProactiveEvent,
	ReadonlyCooldownState,
	RuntimeInterruptionState,
	StoredProactiveEvent,
} from "./types.ts";
import { GLOBAL_SPEECH_COOLDOWN_KEY, cooldownKeyForEvent, decideProactiveDelivery } from "./policy.ts";

export const PROACTIVE_EVENT_CAP = 200;

export class ProactiveEventStore {
	private readonly events: StoredProactiveEvent[] = [];
	private readonly eventDedupeKeys = new Map<string, string>();
	private readonly lastFiredAt = new Map<string, number>();

	getCooldownSnapshot(): ReadonlyCooldownState {
		const map = new Map(this.lastFiredAt);
		return {
			lastFiredAt: map,
			isOnCooldown(key: string, windowMs: number, nowMs = Date.now()): boolean {
				if (windowMs <= 0) return false;
				const last = map.get(key);
				return typeof last === "number" && nowMs - last < windowMs;
			},
		};
	}

	decide(event: ProactiveEvent, runtime: RuntimeInterruptionState): ProactiveDecision {
		return decideProactiveDelivery(event, runtime, this.getCooldownSnapshot());
	}

	recordEvent(event: ProactiveEvent): StoredProactiveEvent {
		const stored = redactForStorage(event);
		const existingIndex = event.dedupeKey
			? this.events.findIndex((candidate) => candidate.kind === stored.kind && this.eventDedupeKeys.get(candidate.id) === event.dedupeKey)
			: -1;
		if (existingIndex >= 0) {
			const [removed] = this.events.splice(existingIndex, 1);
			if (removed) this.eventDedupeKeys.delete(removed.id);
		}
		this.events.push(stored);
		if (event.dedupeKey) this.eventDedupeKeys.set(stored.id, event.dedupeKey);
		while (this.events.length > PROACTIVE_EVENT_CAP) {
			const removed = this.events.shift();
			if (removed) this.eventDedupeKeys.delete(removed.id);
		}
		return stored;
	}

	decideAndRecord(event: ProactiveEvent, runtime: RuntimeInterruptionState): ProactiveDecision {
		const decision = this.decide(event, runtime);
		this.recordEvent(event);
		this.recordCooldownsForDecision(event, decision);
		return decision;
	}

	recordCooldownsForDecision(event: ProactiveEvent, decision: ProactiveDecision, nowMs = new Date(event.createdAt).getTime()): void {
		if (!Number.isFinite(nowMs)) nowMs = Date.now();
		if (!hasInterruptiveDelivery(decision.deliveries)) return;
		this.lastFiredAt.set(cooldownKeyForEvent(event), nowMs);
		if (decision.deliveries.includes("speech")) {
			this.lastFiredAt.set(GLOBAL_SPEECH_COOLDOWN_KEY, nowMs);
		}
	}

	getRecentEvents(limit = PROACTIVE_EVENT_CAP): StoredProactiveEvent[] {
		return this.events.slice(-limit).reverse().map((event) => cloneStoredEvent(event));
	}

	getCooldownEntries(): Array<{ key: string; lastFiredAt: number }> {
		return [...this.lastFiredAt.entries()].map(([key, lastFiredAt]) => ({ key, lastFiredAt }));
	}

	clear(): void {
		this.events.length = 0;
		this.eventDedupeKeys.clear();
		this.lastFiredAt.clear();
	}
}

export const proactiveEventStore = new ProactiveEventStore();

export function redactForStorage(event: ProactiveEvent): StoredProactiveEvent {
	const mayStoreMessage = storageMayKeepMessage(event);
	if (!mayStoreMessage) {
		return {
			id: event.id,
			watcherId: event.watcherId,
			kind: event.kind,
			priority: event.priority,
			title: event.title,
			createdAt: event.createdAt,
		};
	}
	const clone: StoredProactiveEvent = {
		id: event.id,
		watcherId: event.watcherId,
		kind: event.kind,
		priority: event.priority,
		title: event.title,
		createdAt: event.createdAt,
		privacy: { ...event.privacy, mayStoreMessage },
	};
	if (event.dedupeKey) clone.dedupeKey = event.dedupeKey;
	clone.message = event.message;
	if (event.sourceRefs) clone.sourceRefs = event.sourceRefs.map((ref) => ({ ...ref }));
	if (event.suggestedAction) clone.suggestedAction = { ...event.suggestedAction };
	if (event.metadata) clone.metadata = structuredClone(event.metadata);
	return clone;
}

function storageMayKeepMessage(event: ProactiveEvent): boolean {
	if (!event.privacy.mayStoreMessage) return false;
	if (event.privacy.containsSlackContent || event.privacy.containsTerminalContent) return false;
	if (event.kind === "slack_attention" || event.kind === "stuck_work") return false;
	return true;
}

function hasInterruptiveDelivery(deliveries: ProactiveDelivery[]): boolean {
	return deliveries.includes("notification") || deliveries.includes("speech");
}

function cloneStoredEvent(event: StoredProactiveEvent): StoredProactiveEvent {
	return structuredClone(event);
}
