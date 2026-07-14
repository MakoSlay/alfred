import type {
	ProactiveDecision,
	ProactiveDelivery,
	ProactiveEvent,
	ReadonlyCooldownState,
	RuntimeInterruptionState,
} from "./types.ts";

export const WELLNESS_COOLDOWN_MS = 90 * 60 * 1000;
export const STUCK_WORK_COOLDOWN_MS = 20 * 60 * 1000;
export const SLACK_ATTENTION_COOLDOWN_MS = 0;
export const TODO_COOLDOWN_MS = 60 * 60 * 1000;
export const PR_NOTIFICATION_COOLDOWN_MS = 20 * 60 * 1000;
export const GLOBAL_SPEECH_COOLDOWN_MS = 30 * 60 * 1000;

export const GLOBAL_SPEECH_COOLDOWN_KEY = "global:speech";

export function cooldownWindowForKind(kind: ProactiveEvent["kind"]): number {
	switch (kind) {
		case "wellness":
			return WELLNESS_COOLDOWN_MS;
		case "stuck_work":
			return STUCK_WORK_COOLDOWN_MS;
		case "slack_attention":
			return SLACK_ATTENTION_COOLDOWN_MS;
		case "todo":
			return TODO_COOLDOWN_MS;
		case "pr_notification":
			return PR_NOTIFICATION_COOLDOWN_MS;
		case "meeting":
			return 0;
	}
}

export function cooldownKeyForEvent(event: Pick<ProactiveEvent, "kind" | "watcherId" | "dedupeKey">): string {
	return `${event.kind}:${event.dedupeKey ?? event.watcherId}`;
}

export function decideProactiveDelivery(
	event: ProactiveEvent,
	runtime: RuntimeInterruptionState,
	cooldownState: ReadonlyCooldownState,
): ProactiveDecision {
	const nowMs = runtime.now.getTime();
	const kindCooldownKey = cooldownKeyForEvent(event);
	const kindWindowMs = cooldownWindowForKind(event.kind);
	const kindOnCooldown = kindWindowMs > 0 && cooldownState.isOnCooldown(kindCooldownKey, kindWindowMs, nowMs);
	const speechOnCooldown = cooldownState.isOnCooldown(GLOBAL_SPEECH_COOLDOWN_KEY, GLOBAL_SPEECH_COOLDOWN_MS, nowMs);
	const bypassCooldown = event.priority === "urgent";
	const onCooldown = !bypassCooldown && (kindOnCooldown || speechOnCooldown);
	const cooldownKeysChecked = [kindCooldownKey, GLOBAL_SPEECH_COOLDOWN_KEY];

	const base = baseDelivery(event);
	if (runtime.muted) {
		return withSuppress(base, "muted", cooldownKeysChecked, onCooldown);
	}

	if (onCooldown) {
		return withSuppress(base, kindOnCooldown ? "kind_cooldown" : "speech_cooldown", cooldownKeysChecked, true);
	}

	const deliveries = new Set<ProactiveDelivery>(base);
	const canNotify = notificationAllowedByPriority(event);
	const canSpeech = runtime.meetingState === "not_in_meeting";

	if (runtime.meetingState === "unknown") {
		if (unknownMeetingNotificationAllowed(event)) deliveries.add("notification");
		return decision([...deliveries], "meeting_unknown", cooldownKeysChecked, false);
	}

	if (runtime.meetingState === "in_meeting" || runtime.meetingState === "maybe_in_meeting") {
		if (canNotify && isImportantOrUrgent(event)) deliveries.add("notification");
		return decision([...deliveries], runtime.meetingState, cooldownKeysChecked, false);
	}

	if (event.kind === "slack_attention") {
		if (slackNotificationAllowed(event)) deliveries.add("notification");
		if (slackSpeechAllowed(event) && canSpeech) deliveries.add("speech");
		return decision([...deliveries], deliveries.has("speech") || deliveries.has("notification") ? undefined : "slack_not_actionable", cooldownKeysChecked, false);
	}

	if (canNotify) deliveries.add("notification");
	if (canSpeech && speechEligibleByPriority(event)) deliveries.add("speech");
	if (event.suggestedAction) deliveries.add("draft");

	return decision([...deliveries], undefined, cooldownKeysChecked, false);
}

function baseDelivery(event: ProactiveEvent): ProactiveDelivery[] {
	if (event.priority === "silent") return ["store_only"];
	return ["dashboard"];
}

function notificationAllowedByPriority(event: ProactiveEvent): boolean {
	return event.priority !== "silent" && event.priority !== "low";
}

function speechEligibleByPriority(event: ProactiveEvent): boolean {
	return event.priority === "important" || event.priority === "urgent";
}

function isImportantOrUrgent(event: ProactiveEvent): boolean {
	return event.priority === "important" || event.priority === "urgent";
}

function unknownMeetingNotificationAllowed(event: ProactiveEvent): boolean {
	if (event.kind === "wellness") return false;
	if (event.kind === "stuck_work") return isImportantOrUrgent(event);
	if (event.kind === "slack_attention") return event.priority === "urgent";
	return event.priority === "important" || event.priority === "urgent";
}

function slackNotificationAllowed(event: ProactiveEvent): boolean {
	if (event.priority === "urgent") return true;
	return event.priority === "important" && Boolean(event.metadata?.slack?.requiresAction);
}

function slackSpeechAllowed(event: ProactiveEvent): boolean {
	if (event.priority !== "urgent") return false;
	const slack = event.metadata?.slack;
	if (!slack) return false;
	if (slack.missed === true && slack.likelyForgotten === true && slack.requiresAction === true && slack.reviewed === false && slack.previouslySurfaced !== true) return true;
	const createdAtMs = slack.itemCreatedAt ? new Date(slack.itemCreatedAt).getTime() : NaN;
	const eventCreatedAtMs = new Date(event.createdAt).getTime();
	const olderThanTwoHours = Number.isFinite(createdAtMs) && Number.isFinite(eventCreatedAtMs) && eventCreatedAtMs - createdAtMs >= 2 * 60 * 60 * 1000;
	return olderThanTwoHours && slack.requiresAction === true && slack.reviewed === false && slack.previouslySurfaced !== true;
}

function withSuppress(
	deliveries: ProactiveDelivery[],
	suppressReason: string,
	cooldownKeysChecked: string[],
	onCooldown: boolean,
): ProactiveDecision {
	return decision(deliveries, suppressReason, cooldownKeysChecked, onCooldown);
}

function decision(
	deliveries: ProactiveDelivery[],
	suppressReason: string | undefined,
	cooldownKeysChecked: string[],
	onCooldown: boolean,
): ProactiveDecision {
	return {
		deliveries: [...new Set(deliveries)],
		suppressReason,
		cooldownKeysChecked,
		onCooldown,
	};
}
