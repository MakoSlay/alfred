export type ProactivePriority = "silent" | "low" | "normal" | "important" | "urgent";
export type ProactiveKind = "wellness" | "stuck_work" | "slack_attention" | "meeting" | "todo" | "pr_notification";
export type ProactiveDelivery = "store_only" | "dashboard" | "notification" | "speech" | "draft";

export type MeetingState = "in_meeting" | "maybe_in_meeting" | "not_in_meeting" | "unknown";
export type MicrophoneState = "active" | "inactive" | "unknown";

export interface RuntimeInterruptionState {
	muted: boolean;
	mutedUntil: string | null;
	meetingState: MeetingState;
	meetingEvidence?: string[];
	microphoneState?: MicrophoneState;
	microphoneEvidence?: string[];
	explicitAllowMeetingSpeech?: boolean;
	now: Date;
}

export interface ProactiveSourceRef {
	type: string;
	label: string;
	url?: string;
}

export interface ProactiveSuggestedAction {
	label: string;
	draftText?: string;
	requiresConfirmation: true;
}

export interface ProactivePrivacy {
	mayStoreMessage: boolean;
	containsSlackContent?: boolean;
	containsTerminalContent?: boolean;
}

export interface SlackAttentionMetadata {
	itemCreatedAt?: string;
	requiresAction?: boolean;
	reviewed?: boolean;
	previouslySurfaced?: boolean;
	missed?: boolean;
	likelyForgotten?: boolean;
}

export interface ProactiveEvent {
	id: string;
	watcherId: string;
	kind: ProactiveKind;
	priority: ProactivePriority;
	title: string;
	message: string;
	createdAt: string;
	dedupeKey?: string;
	sourceRefs?: ProactiveSourceRef[];
	suggestedAction?: ProactiveSuggestedAction;
	privacy: ProactivePrivacy;
	metadata?: Record<string, unknown> & {
		slack?: SlackAttentionMetadata;
	};
}

export type StoredProactiveEvent =
	| (Pick<ProactiveEvent, "id" | "kind" | "priority" | "watcherId" | "createdAt" | "title"> & { message?: never })
	| (Omit<ProactiveEvent, "message"> & { message?: string });

export interface ReadonlyCooldownState {
	lastFiredAt: ReadonlyMap<string, number>;
	isOnCooldown(key: string, windowMs: number, nowMs?: number): boolean;
}

export interface ProactiveDecision {
	deliveries: ProactiveDelivery[];
	suppressReason?: string;
	cooldownKeysChecked: string[];
	onCooldown: boolean;
}
