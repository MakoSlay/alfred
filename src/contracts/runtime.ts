export type AlfredId = string;
export type IsoTimestamp = string;
export type AlfredRef = string;

export type AlfredSourceKind = "pi-command" | "cli" | "web-ui" | "voice" | "text" | "system";
export type AlfredTargetKind = "cmux-workspace" | "cmux-surface" | "pi-chat" | "codex-session" | "terminal" | "unknown";
export type AlfredActionKind = "draft" | "confirm" | "cancel" | "send" | "loop.start" | "loop.stop" | "loop.status" | "status";
export type AlfredActionRiskLevel = "safe" | "confirmation_required" | "restricted";
export type PendingActionStatus = "pending" | "approved" | "cancelled" | "denied" | "expired" | "executing" | "executed" | "failed";
export type AlfredCapability =
	| "world.read"
	| "surface.read"
	| "surface.send"
	| "workspace.send"
	| "loop.manage"
	| "loop.autonomousSend"
	| "history.read"
	| "history.write"
	| "config.read";

export const ALFRED_CONTRACT_VERSION = "0.1.0";
export const DEFAULT_DRAFT_TTL_MS = 5 * 60 * 1000;

export interface AlfredSource {
	kind: AlfredSourceKind;
	id: AlfredId;
	label?: string;
	sessionId?: string;
	userIntent?: "spoken" | "typed" | "button" | "automation";
	trustedLocalOnly: boolean;
	capabilities: AlfredCapability[];
	presentation?: {
		wantsSpeech?: boolean;
		wantsText?: boolean;
		style?: "butler" | "plain" | "compact";
	};
}

export interface AlfredTarget {
	kind: AlfredTargetKind;
	ref: AlfredRef;
	label: string;
	workspaceRef?: AlfredRef;
	workspaceLabel?: string;
	surfaceRef?: AlfredRef;
	processKind?: "pi" | "codex" | "shell" | "node" | "python" | "unknown";
	current?: boolean;
	selected?: boolean;
	confidence?: "exact" | "prefix" | "substring" | "fuzzy" | "inferred" | "unknown";
	capabilities: AlfredCapability[];
	metadata?: Record<string, string | number | boolean | null>;
}

export type AlfredTargetAliasScope = "workspace" | "global";

export interface AlfredTargetAlias {
	id: AlfredId;
	alias: string;
	normalizedAlias: string;
	scope: AlfredTargetAliasScope;
	targetRef: AlfredRef;
	targetKind: AlfredTargetKind;
	targetLabel: string;
	workspaceRef?: AlfredRef;
	workspaceLabel?: string;
	surfaceRef?: AlfredRef;
	createdAt: IsoTimestamp;
	updatedAt: IsoTimestamp;
	lastSeenAt?: IsoTimestamp;
	createdBy: Pick<AlfredSource, "kind" | "id" | "label">;
}

export interface AlfredHandleRequest {
	requestId: AlfredId;
	createdAt: IsoTimestamp;
	source: AlfredSource;
	input: {
		text: string;
		locale?: string;
		transcriptionConfidence?: number;
	};
	context?: {
		currentWorkspaceRef?: AlfredRef;
		currentSurfaceRef?: AlfredRef;
		visibleTargets?: AlfredTarget[];
		activeDraftId?: AlfredId;
		activeLoopId?: AlfredId;
	};
	policy?: {
		dryRun?: boolean;
		requireConfirmationForSend?: boolean;
		maxTranscriptChars?: number;
		allowedCapabilities?: AlfredCapability[];
	};
}

export interface AlfredHandleResponse {
	requestId: AlfredId;
	createdAt: IsoTimestamp;
	ok: boolean;
	speech?: string;
	displayText: string;
	proposedActions: AlfredAction[];
	/** Canonical approval record for confirmation-required/restricted actions. */
	pendingAction?: PendingAction;
	/** Compatibility view for legacy draft-confirm callers. Derived from pendingAction. */
	pendingDraft?: AlfredDraft;
	activeLoop?: AlfredLoopSummary;
	events: AlfredEvent[];
	errors?: AlfredError[];
	fallback?: AlfredFallback;
	nextStatePatch?: AlfredStatePatch;
}

export type AlfredAction =
	| AlfredDraftAction
	| AlfredConfirmAction
	| AlfredCancelAction
	| AlfredSendAction
	| AlfredLoopStartAction
	| AlfredLoopStopAction
	| AlfredLoopStatusAction
	| AlfredStatusAction;

export interface AlfredBaseAction {
	id: AlfredId;
	kind: AlfredActionKind;
	createdAt: IsoTimestamp;
	requestedBy: AlfredSource;
	target?: AlfredTarget;
	requiredCapabilities: AlfredCapability[];
	status: "proposed" | "pending_confirmation" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
	reason?: string;
}

export interface AlfredDraftAction extends AlfredBaseAction {
	kind: "draft";
	target: AlfredTarget;
	draftText: RedactedText;
	confirmBeforeSend: true;
	expiresAt: IsoTimestamp;
}

export interface AlfredConfirmAction extends AlfredBaseAction {
	kind: "confirm";
	draftId: AlfredId;
}

export interface AlfredCancelAction extends AlfredBaseAction {
	kind: "cancel";
	draftId?: AlfredId;
	loopId?: AlfredId;
}

export interface AlfredSendAction extends AlfredBaseAction {
	kind: "send";
	target: AlfredTarget;
	text: RedactedText;
	confirmationId?: AlfredId;
	transport: "cmux-send-workspace" | "cmux-send-surface";
}

export interface AlfredLoopStartAction extends AlfredBaseAction {
	kind: "loop.start";
	target: AlfredTarget;
	goal: RedactedText;
	maxTurns: number;
	silent: boolean;
}

export interface AlfredLoopStopAction extends AlfredBaseAction {
	kind: "loop.stop";
	loopId: AlfredId;
	interruptTarget?: boolean;
}

export interface AlfredLoopStatusAction extends AlfredBaseAction {
	kind: "loop.status";
	loopId?: AlfredId;
}

export interface AlfredStatusAction extends AlfredBaseAction {
	kind: "status";
	scope: "world" | "target" | "history" | "capabilities";
}

export interface AlfredDraft {
	id: AlfredId;
	target: AlfredTarget;
	text: RedactedText;
	createdAt: IsoTimestamp;
	expiresAt: IsoTimestamp;
	status: "pending" | "confirmed" | "sent" | "cancelled" | "expired" | "failed";
	createdBy: AlfredSource;
}

export interface TemporaryGrant {
	id: AlfredId;
	actionMetaId: string;
	scope: "one_action" | "time_window" | "this_session";
	expiresAt?: IsoTimestamp;
	grantedBy: AlfredSource;
	grantedAt: IsoTimestamp;
	/** Optional target binding for restricted grants. */
	targetRef?: AlfredRef;
}

export interface PendingAction {
	id: AlfredId;
	actionId: string;
	/** Resolved action metadata id. */
	actionMetaId: string;
	/** Human-readable label for cards. */
	label: string;
	/** Risk level at time of proposal. */
	riskLevel: AlfredActionRiskLevel;
	/** Resolved target snapshot; approval/execution integrations should re-resolve live targets before side effects. */
	target?: AlfredTarget;
	/** Preview payload built by the action. */
	preview: Record<string, unknown>;
	/** Validated input payload. */
	input: Record<string, unknown>;
	/** Source that proposed the action. */
	proposedBy: AlfredSource;
	createdAt: IsoTimestamp;
	expiresAt: IsoTimestamp;
	status: PendingActionStatus;
	/** Whether the input is editable before approval. */
	editable: boolean;
	/** Result payload after execution. */
	result?: Record<string, unknown>;
	/** Grant that authorized restricted execution, if any. */
	grant?: TemporaryGrant;
}

export interface AlfredLoopSummary {
	id: AlfredId;
	target: AlfredTarget;
	goal: RedactedText;
	status: "running" | "waiting" | "needs_user" | "done" | "stopped" | "failed";
	turns: number;
	maxTurns: number;
	/** Whether this loop may send replies without creating a draft. */
	autonomousSend?: boolean;
	startedAt: IsoTimestamp;
	lastActivityAt?: IsoTimestamp;
	observeMode?: "screen" | "session-current" | "session-file" | "adapter";
}

export interface AlfredStatePatch {
	rememberTarget?: AlfredTarget;
	rememberDraftId?: AlfredId | null;
	rememberLastSpeech?: RedactedText;
	rememberLastSentText?: RedactedText;
	activeLoopId?: AlfredId | null;
}

export type AlfredEventKind =
	| "request.received"
	| "world.observed"
	| "draft.created"
	| "draft.confirmed"
	| "draft.cancelled"
	| "action.proposed"
	| "action.approved"
	| "action.edited"
	| "action.cancelled"
	| "action.denied"
	| "action.expired"
	| "action.executed"
	| "action.failed"
	| "send.started"
	| "send.succeeded"
	| "send.failed"
	| "loop.started"
	| "loop.waiting"
	| "loop.replied"
	| "loop.needs_user"
	| "loop.done"
	| "loop.stopped"
	| "error.raised"
	| "fallback.used";

export interface AlfredEvent {
	id: AlfredId;
	kind: AlfredEventKind;
	createdAt: IsoTimestamp;
	requestId?: AlfredId;
	source?: Pick<AlfredSource, "kind" | "id" | "label">;
	target?: AlfredTarget;
	actionId?: AlfredId;
	loopId?: AlfredId;
	summary: string;
	data?: Record<string, unknown>;
	redaction: RedactionMetadata;
	retention: RetentionMetadata;
}

export interface RedactedText {
	value: string;
	redaction: RedactionMetadata;
}

export interface RedactionMetadata {
	status: "not_needed" | "redacted" | "contains_sensitive" | "unknown";
	rulesApplied?: string[];
	originalLength?: number;
}

export interface RetentionMetadata {
	policy: "ephemeral" | "session" | "short" | "manual";
	expiresAt?: IsoTimestamp;
	reason?: string;
}

export interface AlfredError {
	code:
		| "invalid_request"
		| "target_not_found"
		| "target_ambiguous"
		| "capability_denied"
		| "confirmation_required"
		| "confirmation_expired"
		| "send_failed"
		| "loop_already_running"
		| "loop_not_found"
		| "cmux_unavailable"
		| "llm_unavailable"
		| "unsupported_action"
		| "not_found"
		| "internal_error";
	message: string;
	retryable: boolean;
	details?: Record<string, string | number | boolean | null>;
}

export interface AlfredFallback {
	kind: "none" | "local-pi" | "ask-clarification" | "retry-later" | "manual";
	reason: string;
}

export function redactedText(value: string, redaction: RedactionMetadata = { status: "not_needed" }): RedactedText {
	return { value, redaction };
}

export function isPrivilegedCapability(capability: AlfredCapability): boolean {
	return capability === "surface.send" || capability === "workspace.send" || capability === "loop.manage" || capability === "loop.autonomousSend";
}

export function sourceHasCapabilities(source: AlfredSource, required: readonly AlfredCapability[]): boolean {
	return required.every((capability) => source.capabilities.includes(capability));
}
