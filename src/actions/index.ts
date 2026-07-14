import type { AlfredActionRiskLevel, AlfredCapability, AlfredEvent, AlfredId, AlfredRef, AlfredSource, AlfredTarget, PendingAction, TemporaryGrant } from "../contracts/runtime.ts";
import type { CmuxWorldModelAdapter } from "../cmux/index.ts";
import { isSafeRelativeMarkdownPath, isSafeRelativePath, normalizeHttpUrl } from "../validation/open.ts";
export type { PendingAction, TemporaryGrant } from "../contracts/runtime.ts";

// ─── risk levels ───

export type ActionRiskLevel = AlfredActionRiskLevel;

export const SAFE_RISK: ActionRiskLevel = "safe";
export const CONFIRMATION_REQUIRED_RISK: ActionRiskLevel = "confirmation_required";
export const RESTRICTED_RISK: ActionRiskLevel = "restricted";

// ─── action metadata ───

export interface ActionMetadata {
	/** Unique action id, e.g. "cmux.sendText" or "loop.start" */
	id: string;
	/** Human-readable description for previews and audit */
	description: string;
	/** Risk level used by permission policy */
	riskLevel: ActionRiskLevel;
	/** Capabilities the action source must have */
	requiredSourceCapabilities: AlfredCapability[];
	/** Capabilities the target must support (empty = target-agnostic) */
	requiredTargetCapabilities: AlfredCapability[];
	/** Audit event category for lifecycle events */
	auditCategory: string;
}

// ─── registered action ───

export interface RegisteredAction<Input = Record<string, unknown>, Output = Record<string, unknown>> {
	metadata: ActionMetadata;
	/** Validate raw input; return null if valid, or a list of error messages */
	validateInput(input: unknown): string[] | null;
	/** Build a preview object for confirmation UI; called before execution */
	buildPreview(input: Input, target?: AlfredTarget): Record<string, unknown>;
	/** Execute the action; only called after policy approval */
	handler(input: Input, context: ActionHandlerContext): Promise<CmuxActionResult<Output>>;
}

// ─── handler context ───

export interface ActionHandlerContext {
	target?: AlfredTarget;
	source: AlfredSource;
	requestId: AlfredId;
	now: () => Date;
	cmux: Pick<CmuxWorldModelAdapter,
		| "readSurface"
		| "sendTextToSurface"
		| "sendTextToWorkspace"
		| "sendKeyToSurface"
		| "capabilities"
		| "listNotifications"
		| "dismissNotification"
		| "dismissAllReadNotifications"
		| "markNotificationRead"
		| "markAllNotificationsRead"
		| "openNotification"
		| "jumpToUnreadNotification"
		| "clearNotifications"
		| "setStatus"
		| "clearStatus"
		| "listStatus"
		| "setProgress"
		| "clearProgress"
		| "log"
		| "sidebarState"
		| "openMarkdown"
		| "openDiff"
		| "openFile"
		| "openUrl"
		| "openBrowserSurface"
	>;
}

// ─── result types ───

export type CmuxActionResult<T = Record<string, unknown>> =
	| { ok: true; value: T }
	| { ok: false; error: { code: string; message: string; retryable: boolean } };

export type ProposeActionResult =
	| { ok: true; pending: PendingAction; event: AlfredEvent }
	| { ok: false; decision: Exclude<PolicyDecision, { allowed: true }>; event: AlfredEvent };

// ─── policy decision ───

export type PolicyDecision =
	| { allowed: true }
	| { allowed: false; reason: PolicyDenialReason; message: string };

export type PolicyDenialReason =
	| "unknown_action"
	| "invalid_input"
	| "capability_missing"
	| "restricted_without_grant"
	| "target_incompatible"
	| "expired_grant";

// ─── registry ───

export interface ActionRegistry {
	/** Register an action handler */
	register<Input, Output>(action: RegisteredAction<Input, Output>): void;
	/** List all registered action metadata */
	list(): ActionMetadata[];
	/** Look up an action by id */
	get(actionId: string): RegisteredAction | undefined;
	/** Evaluate policy: should this action be allowed, require confirmation, or be denied? */
	evaluatePolicy(params: EvaluatePolicyParams): PolicyDecision;
	/** Validate policy and propose a pending action record from input */
	propose(params: ProposeActionParams): ProposeActionResult;
	/** Edit a pending action's input and rebuild its preview before approval. */
	updateInput(pendingId: AlfredId, input: Record<string, unknown>, source?: AlfredSource, target?: AlfredTarget): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null; decision?: Exclude<PolicyDecision, { allowed: true }> };
	/** Approve a confirmation-required or restricted pending action before execution */
	approve(pendingId: AlfredId, source?: AlfredSource, target?: AlfredTarget): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null };
	/** Validate and execute a safe action or an approved risky pending action */
	execute(pendingId: AlfredId, context: ActionHandlerContext): Promise<{ ok: boolean; pending: PendingAction; event: AlfredEvent }>;
	/** Cancel a pending action */
	cancel(pendingId: AlfredId, reason?: string): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null };
	/** List all current pending actions */
	listPending(): PendingAction[];
}

export interface EvaluatePolicyParams {
	actionId: string;
	input: unknown;
	source: AlfredSource;
	target?: AlfredTarget;
	grant?: TemporaryGrant;
}

export interface ProposeActionParams {
	actionId: string;
	input: Record<string, unknown>;
	source: AlfredSource;
	target?: AlfredTarget;
	grant?: TemporaryGrant;
	/** Whether the input is editable before approval */
	editable?: boolean;
	ttlMs?: number;
}

export interface ActionRegistryDependencies {
	now?: () => Date;
	nextId?: (prefix: string) => string;
	defaultTtlMs?: number;
}

export function createActionRegistry(deps: ActionRegistryDependencies = {}): ActionRegistry {
	const now = deps.now ?? (() => new Date());
	const nextId = deps.nextId ?? defaultNextId;
	const defaultTtlMs = deps.defaultTtlMs ?? 5 * 60 * 1000;
	const actions = new Map<string, RegisteredAction>();
	const pendingActions = new Map<string, PendingAction>();
	const consumedGrantIds = new Set<AlfredId>();

	function register<Input, Output>(action: RegisteredAction<Input, Output>): void {
		actions.set(action.metadata.id, action as RegisteredAction);
	}

	function list(): ActionMetadata[] {
		return [...actions.values()].map((action) => ({ ...action.metadata }));
	}

	function get(actionId: string): RegisteredAction | undefined {
		return actions.get(actionId);
	}

	function evaluatePolicy(params: EvaluatePolicyParams): PolicyDecision {
		const action = actions.get(params.actionId);
		if (!action) {
			return { allowed: false, reason: "unknown_action", message: `Unknown action: ${params.actionId}` };
		}

		// Validate input
		if (params.input !== undefined) {
			const errors = action.validateInput(params.input);
			if (errors) {
				return { allowed: false, reason: "invalid_input", message: `Input validation failed: ${errors.join("; ")}` };
			}
		}

		const targetCapabilityDecision = evaluateTargetAwareCapabilities(action, params);
		if (targetCapabilityDecision) return targetCapabilityDecision;

		const targetRefDecision = evaluateInputTargetRef(params);
		if (targetRefDecision) return targetRefDecision;

		// Check source capabilities
		for (const cap of action.metadata.requiredSourceCapabilities) {
			if (!params.source.capabilities.includes(cap)) {
				return { allowed: false, reason: "capability_missing", message: `Source lacks capability: ${cap}` };
			}
		}

		// Check target capabilities. A target-requiring action must not pass policy without a target.
		if (action.metadata.requiredTargetCapabilities.length > 0) {
			if (!params.target) {
				return { allowed: false, reason: "target_incompatible", message: `Action ${params.actionId} requires a compatible target.` };
			}
			for (const cap of action.metadata.requiredTargetCapabilities) {
				if (!params.target.capabilities.includes(cap)) {
					return { allowed: false, reason: "target_incompatible", message: `Target does not support capability: ${cap}` };
				}
			}
		}

		// Restricted actions require a temporary scoped grant.
		if (action.metadata.riskLevel === RESTRICTED_RISK) {
			if (!params.grant || params.grant.actionMetaId !== params.actionId) {
				return { allowed: false, reason: "restricted_without_grant", message: `Action ${params.actionId} requires a temporary scoped grant.` };
			}
			if (params.grant.grantedBy.id !== params.source.id || params.grant.grantedBy.kind !== params.source.kind) {
				return { allowed: false, reason: "restricted_without_grant", message: `Grant for action ${params.actionId} was issued to a different source.` };
			}
			if (params.grant.expiresAt && params.grant.expiresAt <= now().toISOString()) {
				return { allowed: false, reason: "expired_grant", message: `Grant for action ${params.actionId} has expired.` };
			}
			if (params.grant.scope === "one_action" && consumedGrantIds.has(params.grant.id)) {
				return { allowed: false, reason: "expired_grant", message: `Grant for action ${params.actionId} has already been used.` };
			}
			if (params.grant.targetRef && (!params.target || !targetMatchesRef(params.target, params.grant.targetRef))) {
				return { allowed: false, reason: "target_incompatible", message: `Grant for action ${params.actionId} is scoped to a different target.` };
			}
		}

		// safe and confirmation_required are allowed through policy (but confirmation may be needed later)
		return { allowed: true };
	}

	function propose(params: ProposeActionParams): ProposeActionResult {
		const action = actions.get(params.actionId);
		const createdAt = now().toISOString();
		const decision = evaluatePolicy({
			actionId: params.actionId,
			input: params.input,
			source: params.source,
			target: params.target,
			grant: params.grant,
		});
		if (!decision.allowed) {
			return {
				ok: false,
				decision,
				event: {
					id: nextId("evt"),
					kind: "action.denied",
					createdAt,
					source: { kind: params.source.kind, id: params.source.id, label: params.source.label },
					target: params.target,
					summary: `Denied ${params.actionId}: ${decision.message}`,
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		if (!action) {
			// Kept for TypeScript exhaustiveness; evaluatePolicy already denies unknown actions.
			throw new Error(`Unknown action passed policy: ${params.actionId}`);
		}
		const pending: PendingAction = {
			id: nextId("pending"),
			actionId: params.actionId,
			actionMetaId: action.metadata.id,
			label: action.metadata.description,
			riskLevel: action.metadata.riskLevel,
			target: params.target ? { ...params.target, capabilities: [...params.target.capabilities] } : undefined,
			preview: action.buildPreview(params.input, params.target),
			input: { ...params.input },
			proposedBy: { ...params.source, capabilities: [...params.source.capabilities] },
			createdAt,
			expiresAt: new Date(Date.parse(createdAt) + (params.ttlMs ?? defaultTtlMs)).toISOString(),
			status: "pending",
			editable: params.editable ?? (action.metadata.riskLevel === CONFIRMATION_REQUIRED_RISK),
			grant: params.grant,
		};
		pendingActions.set(pending.id, pending);
		return {
			ok: true,
			pending,
			event: {
				id: nextId("evt"),
				kind: "action.proposed",
				createdAt,
				source: { kind: params.source.kind, id: params.source.id, label: params.source.label },
				target: pending.target,
				actionId: pending.id,
				summary: `Proposed ${pending.label}.`,
				redaction: { status: "not_needed" },
				retention: { policy: "session", expiresAt: pending.expiresAt },
			},
		};
	}

	function updateInput(pendingId: AlfredId, input: Record<string, unknown>, source?: AlfredSource, target?: AlfredTarget): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null; decision?: Exclude<PolicyDecision, { allowed: true }> } {
		const createdAt = now().toISOString();
		const pending = pendingActions.get(pendingId);
		if (!pending) {
			return { ok: false, pending: null, event: null };
		}
		if (pending.status !== "pending" || !pending.editable) {
			return { ok: false, pending, event: null };
		}
		const action = actions.get(pending.actionMetaId);
		if (!action) {
			pending.status = "failed";
			return { ok: false, pending, event: null };
		}
		const editingSource = source ?? pending.proposedBy;
		const editingTarget = target ?? pending.target;
		const decision = evaluatePolicy({
			actionId: pending.actionMetaId,
			input,
			source: editingSource,
			target: editingTarget,
			grant: pending.grant,
		});
		if (!decision.allowed) {
			return {
				ok: false,
				pending,
				decision,
				event: {
					id: nextId("evt"),
					kind: "action.denied",
					createdAt,
					source: { kind: editingSource.kind, id: editingSource.id, label: editingSource.label },
					target: editingTarget,
					actionId: pending.id,
					summary: `Edit denied for ${pending.label}: ${decision.message}`,
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		pending.input = { ...input };
		pending.target = editingTarget ? { ...editingTarget, capabilities: [...editingTarget.capabilities] } : undefined;
		pending.preview = action.buildPreview(pending.input, pending.target);
		return {
			ok: true,
			pending,
			event: {
				id: nextId("evt"),
				kind: "action.edited",
				createdAt,
				source: { kind: editingSource.kind, id: editingSource.id, label: editingSource.label },
				target: pending.target,
				actionId: pending.id,
				summary: `Edited ${pending.label}.`,
				redaction: { status: "not_needed" },
				retention: { policy: "session", expiresAt: pending.expiresAt },
			},
		};
	}

	function approve(pendingId: AlfredId, source?: AlfredSource, target?: AlfredTarget): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null } {
		const createdAt = now().toISOString();
		const pending = pendingActions.get(pendingId);
		if (!pending) {
			return {
				ok: false,
				pending: null,
				event: {
					id: nextId("evt"),
					kind: "error.raised",
					createdAt,
					source: source ? { kind: source.kind, id: source.id, label: source.label } : undefined,
					summary: "Pending action not found.",
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		if (pending.status !== "pending") {
			return { ok: false, pending, event: null };
		}
		if (pending.expiresAt <= createdAt) {
			pending.status = "expired";
			return {
				ok: false,
				pending,
				event: {
					id: nextId("evt"),
					kind: "action.expired",
					createdAt,
					source: source ? { kind: source.kind, id: source.id, label: source.label } : undefined,
					target: pending.target,
					actionId: pending.id,
					summary: `Pending action ${pending.label} has expired.`,
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		const approvingSource = source ?? pending.proposedBy;
		const approvingTarget = target ?? pending.target;
		const decision = evaluatePolicy({
			actionId: pending.actionMetaId,
			input: pending.input,
			source: approvingSource,
			target: approvingTarget,
			grant: pending.grant,
		});
		if (!decision.allowed) {
			pending.status = "denied";
			return {
				ok: false,
				pending,
				event: {
					id: nextId("evt"),
					kind: "action.denied",
					createdAt,
					source: { kind: approvingSource.kind, id: approvingSource.id, label: approvingSource.label },
					target: pending.target,
					actionId: pending.id,
					summary: `Approval denied for ${pending.label}: ${decision.message}`,
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		pending.target = approvingTarget ? { ...approvingTarget, capabilities: [...approvingTarget.capabilities] } : undefined;
		pending.status = "approved";
		return {
			ok: true,
			pending,
			event: {
				id: nextId("evt"),
				kind: "action.approved",
				createdAt,
				source: { kind: approvingSource.kind, id: approvingSource.id, label: approvingSource.label },
				target: pending.target,
				actionId: pending.id,
				summary: `Approved ${pending.label}.`,
				redaction: { status: "not_needed" },
				retention: { policy: "session" },
			},
		};
	}

	async function execute(pendingId: AlfredId, context: ActionHandlerContext): Promise<{ ok: boolean; pending: PendingAction; event: AlfredEvent }> {
		const createdAt = context.now().toISOString();
		const pending = pendingActions.get(pendingId);
		const baseEvent: AlfredEvent = {
			id: nextId("evt"),
			kind: "error.raised",
			createdAt,
			requestId: context.requestId,
			source: { kind: context.source.kind, id: context.source.id, label: context.source.label },
			summary: "Action execution attempted.",
			redaction: { status: "not_needed" },
			retention: { policy: "short", expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString() },
		};

		if (!pending) {
			return {
				ok: false,
				pending: { id: pendingId, actionId: "", actionMetaId: "", label: "Unknown", riskLevel: CONFIRMATION_REQUIRED_RISK, preview: {}, input: {}, proposedBy: context.source, createdAt, expiresAt: createdAt, status: "expired", editable: false },
				event: { ...baseEvent, kind: "error.raised", summary: "Pending action not found or already resolved." },
			};
		}

		if (pending.status !== "pending" && pending.status !== "approved") {
			return {
				ok: false,
				pending,
				event: { ...baseEvent, kind: "action.denied", actionId: pending.id, summary: `Pending action is ${pending.status} and cannot be executed.` },
			};
		}

		if (pending.expiresAt <= createdAt) {
			pending.status = "expired";
			return {
				ok: false,
				pending,
				event: { ...baseEvent, kind: "action.expired", actionId: pending.id, summary: `Pending action ${pending.label} has expired.` },
			};
		}

		const action = actions.get(pending.actionMetaId);
		if (!action) {
			pending.status = "failed";
			return {
				ok: false,
				pending,
				event: { ...baseEvent, kind: "error.raised", summary: `Action ${pending.actionMetaId} is not registered.` },
			};
		}

		if (action.metadata.riskLevel !== SAFE_RISK && pending.status !== "approved") {
			return {
				ok: false,
				pending,
				event: { ...baseEvent, kind: "action.denied", actionId: pending.id, target: pending.target, summary: `${pending.label} requires approval before execution.` },
			};
		}

		const executionTarget = context.target ?? pending.target;
		const executionContext: ActionHandlerContext = { ...context, target: executionTarget };
		const policy = evaluatePolicy({
			actionId: pending.actionMetaId,
			input: pending.input,
			source: context.source,
			target: executionTarget,
			grant: pending.grant,
		});
		if (!policy.allowed) {
			pending.status = "failed";
			return {
				ok: false,
				pending,
				event: { ...baseEvent, kind: "action.denied", actionId: pending.id, target: pending.target, summary: `Execution policy denied ${pending.label}: ${policy.message}` },
			};
		}

		pending.status = "executing";
		const result = await action.handler(pending.input, executionContext);
		if (pending.grant?.scope === "one_action") {
			consumedGrantIds.add(pending.grant.id);
		}
		if (result.ok) {
			pending.status = "executed";
			pending.result = result.value;
			// keep in map for audit trail, do not delete
			return {
				ok: true,
				pending,
				event: {
					...baseEvent,
					kind: "action.executed",
					target: pending.target,
					actionId: pending.id,
					summary: `${pending.label} executed successfully.`,
				},
			};
		}

		pending.status = "failed";
		return {
			ok: false,
			pending,
			event: {
				...baseEvent,
				kind: "action.failed",
				target: pending.target,
				actionId: pending.id,
				summary: `${pending.label} failed: ${result.error.message}`,
			},
		};
	}

	function cancel(pendingId: AlfredId, reason?: string): { ok: boolean; pending: PendingAction | null; event: AlfredEvent | null } {
		const createdAt = now().toISOString();
		const pending = pendingActions.get(pendingId);
		if (!pending) {
			return {
				ok: false,
				pending: null,
				event: {
					id: nextId("evt"),
					kind: "error.raised",
					createdAt,
					summary: "Pending action not found.",
					redaction: { status: "not_needed" },
					retention: { policy: "session" },
				},
			};
		}
		if (pending.status !== "pending" && pending.status !== "approved") {
			return { ok: false, pending, event: null };
		}
		pending.status = "cancelled";
		pendingActions.delete(pendingId);
		return {
			ok: true,
			pending,
			event: {
				id: nextId("evt"),
				kind: "action.cancelled",
				createdAt,
				target: pending.target,
				actionId: pending.id,
				summary: `Cancelled ${pending.label}${reason ? `: ${reason}` : ""}.`,
				redaction: { status: "not_needed" },
				retention: { policy: "session" },
			},
		};
	}

	function listPending(): PendingAction[] {
		return [...pendingActions.values()].filter((pending) => pending.status === "pending" || pending.status === "approved" || pending.status === "executing");
	}

	return { register, list, get, evaluatePolicy, propose, updateInput, approve, execute, cancel, listPending };
}

// ─── built-in action handlers ───

export function registerBuiltinActions(registry: ActionRegistry): void {
	// ─── cmux.sendText (confirmation required) ───
	registry.register<{ text: string; targetRef: string }, { ref: string }>({
		metadata: {
			id: "cmux.sendText",
			description: "Send text to a cmux target",
			riskLevel: CONFIRMATION_REQUIRED_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-send",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.text !== "string" || !input.text.trim()) return ["Input.text must be a non-empty string."];
			if (typeof input.targetRef !== "string" || !input.targetRef.trim()) return ["Input.targetRef must be a valid target ref."];
			return null;
		},
		buildPreview(input: { text: string; targetRef: string }, target?: AlfredTarget) {
			return {
				type: "cmux.sendText",
				textPreview: input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text,
				textLength: input.text.length,
				targetLabel: target?.label ?? input.targetRef,
				targetKind: target?.kind ?? "unknown",
			};
		},
		async handler(input: { text: string; targetRef: string }, context: ActionHandlerContext) {
			if (!context.target) {
				return { ok: false, error: { code: "target_not_found", message: "No live target resolved.", retryable: true } };
			}
			const result = context.target.kind === "cmux-workspace"
				? await context.cmux.sendTextToWorkspace(context.target.ref, input.text)
				: await context.cmux.sendTextToSurface(context.target.surfaceRef ?? context.target.ref, input.text);
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: result.value as unknown as { ref: string } };
		},
	});

	// ─── cmux.sendKey (confirmation required) ───
	registry.register<{ key: string; targetRef: string }, { surfaceRef: string; key: string }>({
		metadata: {
			id: "cmux.sendKey",
			description: "Send a keypress to a cmux surface",
			riskLevel: CONFIRMATION_REQUIRED_RISK,
			requiredSourceCapabilities: ["surface.send"],
			requiredTargetCapabilities: ["surface.send"],
			auditCategory: "cmux-keypress",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.key !== "string" || !input.key.trim()) return ["Input.key must be a non-empty string."];
			if (typeof input.targetRef !== "string" || !input.targetRef.trim()) return ["Input.targetRef must be a valid surface ref."];
			return null;
		},
		buildPreview(input: { key: string; targetRef: string }, target?: AlfredTarget) {
			return {
				type: "cmux.sendKey",
				key: input.key,
				targetLabel: target?.label ?? input.targetRef,
			};
		},
		async handler(input: { key: string; targetRef: string }, context: ActionHandlerContext) {
			if (!context.target) {
				return { ok: false, error: { code: "target_not_found", message: "No live target resolved.", retryable: true } };
			}
			const surfaceRef = context.target.surfaceRef ?? context.target.ref;
			const result = await context.cmux.sendKeyToSurface(surfaceRef, input.key);
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: result.value };
		},
	});

	// ─── cmux.readNotifications (safe) ───
	registry.register<{ filter?: "all" | "unread"; countOnly?: boolean }, { notifications: unknown[] }>({
		metadata: {
			id: "cmux.readNotifications",
			description: "Read cmux notifications",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-notification",
		},
		validateInput(input: unknown): string[] | null {
			if (input === undefined) return null;
			if (!isRecord(input)) return ["Input must be an object."];
			if (input.filter !== undefined && input.filter !== "all" && input.filter !== "unread") return ["Input.filter must be all or unread."];
			if (input.countOnly !== undefined && typeof input.countOnly !== "boolean") return ["Input.countOnly must be boolean."];
			return null;
		},
		buildPreview(input: { filter?: "all" | "unread"; countOnly?: boolean }) {
			return { type: "cmux.readNotifications", filter: input.filter ?? "all", countOnly: input.countOnly === true };
		},
		async handler(_input, context: ActionHandlerContext) {
			const result = await context.cmux.listNotifications();
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { notifications: result.value } };
		},
	});

	// ─── cmux.openDiff (safe) ───
	registry.register<{ unstaged?: boolean; staged?: boolean; branch?: boolean }, { opened: boolean }>({
		metadata: {
			id: "cmux.openDiff",
			description: "Open a cmux diff view",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-open",
		},
		validateInput(): string[] | null {
			return null;
		},
		buildPreview(input) {
			return { type: "cmux.openDiff", unstaged: input.unstaged, staged: input.staged, branch: input.branch };
		},
		async handler(input, context: ActionHandlerContext) {
			const result = await context.cmux.openDiff({
				unstaged: input.unstaged,
				staged: input.staged,
				branch: input.branch,
				workspaceRef: context.target?.workspaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { opened: result.value.opened } };
		},
	});

	// ─── cmux.openMarkdown (safe) ───
	registry.register<{ path: string }, { path: string }>({
		metadata: {
			id: "cmux.openMarkdown",
			description: "Open a markdown file in cmux preview",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-open",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.path !== "string" || !input.path.trim()) return ["Input.path must be a non-empty string."];
			if (!isSafeRelativeMarkdownPath(input.path)) return ["Input.path must be a safe relative markdown path."];
			return null;
		},
		buildPreview(input: { path: string }) {
			return { type: "cmux.openMarkdown", path: input.path };
		},
		async handler(input: { path: string }, context: ActionHandlerContext) {
			const result = await context.cmux.openMarkdown(input.path, {
				workspaceRef: context.target?.workspaceRef,
				surfaceRef: context.target?.surfaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { path: result.value.path } };
		},
	});

	// ─── cmux.openFile (safe) ───
	registry.register<{ path: string }, { path: string }>({
		metadata: {
			id: "cmux.openFile",
			description: "Open a file in cmux file preview",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-open",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.path !== "string" || !input.path.trim()) return ["Input.path must be a non-empty string."];
			if (!isSafeRelativePath(input.path)) return ["Input.path must be a safe relative path."];
			return null;
		},
		buildPreview(input: { path: string }) {
			return { type: "cmux.openFile", path: input.path };
		},
		async handler(input: { path: string }, context: ActionHandlerContext) {
			const result = await context.cmux.openFile(input.path, {
				workspaceRef: context.target?.workspaceRef,
				surfaceRef: context.target?.surfaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { path: result.value.path } };
		},
	});

	// ─── cmux.openUrl (safe) ───
	registry.register<{ url: string }, { url: string }>({
		metadata: {
			id: "cmux.openUrl",
			description: "Open a URL in cmux",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-open",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.url !== "string" || !input.url.trim()) return ["Input.url must be a non-empty string."];
			if (!normalizeHttpUrl(input.url)) return ["Input.url must be a valid http(s) URL."];
			return null;
		},
		buildPreview(input: { url: string }) {
			return { type: "cmux.openUrl", url: input.url };
		},
		async handler(input: { url: string }, context: ActionHandlerContext) {
			const result = await context.cmux.openUrl(input.url, {
				workspaceRef: context.target?.workspaceRef,
				surfaceRef: context.target?.surfaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { url: result.value.url } };
		},
	});

	// ─── cmux.setStatus (safe) ───
	registry.register<{ key: string; value: string; icon?: string; color?: string }, { key: string; value: string }>({
		metadata: {
			id: "cmux.setStatus",
			description: "Write Alfred status to the cmux sidebar",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "sidebar-telemetry",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.key !== "string" || !input.key.trim()) return ["Input.key must be a non-empty string."];
			if (typeof input.value !== "string") return ["Input.value must be a string."];
			return null;
		},
		buildPreview(input) {
			return { type: "cmux.setStatus", key: input.key, value: input.value };
		},
		async handler(input, context: ActionHandlerContext) {
			const result = await context.cmux.setStatus(input.key, input.value, {
				icon: input.icon,
				color: input.color,
				workspaceRef: context.target?.workspaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { key: result.value.key, value: result.value.value } };
		},
	});

	// ─── cmux.setProgress (safe) ───
	registry.register<{ value: number; label?: string }, { value: number }>({
		metadata: {
			id: "cmux.setProgress",
			description: "Write Alfred progress to the cmux sidebar",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "sidebar-telemetry",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.value !== "number" || !Number.isFinite(input.value)) return ["Input.value must be a finite number."];
			if (input.label !== undefined && typeof input.label !== "string") return ["Input.label must be a string."];
			return null;
		},
		buildPreview(input) {
			return { type: "cmux.setProgress", value: input.value, label: input.label };
		},
		async handler(input, context: ActionHandlerContext) {
			const result = await context.cmux.setProgress(input.value, {
				label: input.label,
				workspaceRef: context.target?.workspaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { value: result.value.value } };
		},
	});

	// ─── cmux.log (safe) ───
	registry.register<{ message: string; level?: string; source?: string }, { logged: boolean }>({
		metadata: {
			id: "cmux.log",
			description: "Write Alfred log entry to the cmux sidebar",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "sidebar-telemetry",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.message !== "string" || !input.message.trim()) return ["Input.message must be a non-empty string."];
			return null;
		},
		buildPreview(input) {
			return { type: "cmux.log", message: input.message, level: input.level };
		},
		async handler(input, context: ActionHandlerContext) {
			const result = await context.cmux.log(input.message, {
				level: input.level,
				source: input.source ?? "alfred",
				workspaceRef: context.target?.workspaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { logged: true } };
		},
	});

	// ─── cmux.openBrowserSurface (safe - open only, no mutation) ───
	registry.register<{ url?: string }, { opened: boolean }>({
		metadata: {
			id: "cmux.openBrowserSurface",
			description: "Open a browser surface in cmux (read/snapshot only)",
			riskLevel: SAFE_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "cmux-open",
		},
		validateInput(input: unknown): string[] | null {
			if (input === undefined) return null;
			if (!isRecord(input)) return ["Input must be an object."];
			if (input.url !== undefined && (typeof input.url !== "string" || !normalizeHttpUrl(input.url))) return ["Input.url must be a valid http(s) URL."];
			return null;
		},
		buildPreview(input: { url?: string }) {
			return { type: "cmux.openBrowserSurface", url: input.url };
		},
		async handler(input: { url?: string }, context: ActionHandlerContext) {
			const result = await context.cmux.openBrowserSurface(input.url, {
				workspaceRef: context.target?.workspaceRef,
			});
			if (!result.ok) {
				return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: true } };
			}
			return { ok: true, value: { opened: true } };
		},
	});

	// ─── browser.click (restricted) ───
	registry.register<{ selector: string }, { clicked: boolean }>({
		metadata: {
			id: "browser.click",
			description: "Click an element in a cmux browser surface (requires temporary grant)",
			riskLevel: RESTRICTED_RISK,
			requiredSourceCapabilities: [],
			requiredTargetCapabilities: [],
			auditCategory: "browser-mutation",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.selector !== "string" || !input.selector.trim()) return ["Input.selector must be a non-empty string."];
			return null;
		},
		buildPreview(input: { selector: string }) {
			return { type: "browser.click", selector: input.selector };
		},
		async handler() {
			return { ok: false, error: { code: "cmux_unavailable", message: "Browser automation handler not yet implemented.", retryable: false } };
		},
	});

	// ─── loop.start (confirmation required) ───
	registry.register<{ targetRef: string; goal: string; maxTurns: number }, { loopId: string }>({
		metadata: {
			id: "loop.start",
			description: "Start a daemon-owned watcher loop",
			riskLevel: CONFIRMATION_REQUIRED_RISK,
			requiredSourceCapabilities: ["loop.manage"],
			requiredTargetCapabilities: ["surface.read"],
			auditCategory: "loop-control",
		},
		validateInput(input: unknown): string[] | null {
			if (!isRecord(input)) return ["Input must be an object."];
			if (typeof input.targetRef !== "string" || !input.targetRef.trim()) return ["Input.targetRef must be a valid target ref."];
			if (typeof input.goal !== "string" || !input.goal.trim()) return ["Input.goal must be a non-empty string."];
			return null;
		},
		buildPreview(input) {
			return { type: "loop.start", targetRef: input.targetRef, goalPreview: input.goal.slice(0, 100) };
		},
		async handler() {
			return { ok: false, error: { code: "internal_error", message: "Loop start through action registry not yet connected to loop manager.", retryable: false } };
		},
	});
}

// ─── helpers ───

function evaluateTargetAwareCapabilities(action: RegisteredAction, params: EvaluatePolicyParams): PolicyDecision | null {
	if (action.metadata.id.startsWith("browser.")) {
		if (!params.target) {
			return { allowed: false, reason: "target_incompatible", message: `${action.metadata.id} requires a resolved browser target.` };
		}
		if (params.target.kind !== "cmux-surface") {
			return { allowed: false, reason: "target_incompatible", message: `${action.metadata.id} requires a cmux browser surface target.` };
		}
	}
	if (action.metadata.id !== "cmux.sendText") return null;
	if (!params.target) {
		return { allowed: false, reason: "target_incompatible", message: "cmux.sendText requires a resolved target." };
	}
	const capability: AlfredCapability = params.target.kind === "cmux-workspace" ? "workspace.send" : "surface.send";
	if (!params.source.capabilities.includes(capability)) {
		return { allowed: false, reason: "capability_missing", message: `Source lacks capability: ${capability}` };
	}
	if (!params.target.capabilities.includes(capability)) {
		return { allowed: false, reason: "target_incompatible", message: `Target does not support capability: ${capability}` };
	}
	return null;
}

function evaluateInputTargetRef(params: EvaluatePolicyParams): PolicyDecision | null {
	if (!params.target || !isRecord(params.input) || typeof params.input.targetRef !== "string") return null;
	if (targetMatchesRef(params.target, params.input.targetRef)) return null;
	return { allowed: false, reason: "target_incompatible", message: `Input targetRef ${params.input.targetRef} does not match resolved target ${params.target.ref}.` };
}

function targetMatchesRef(target: AlfredTarget, ref: string): boolean {
	return [target.ref, target.surfaceRef, target.workspaceRef].filter(Boolean).includes(ref);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultNextId(prefix: string): string {
	const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (crypto?.randomUUID) {
		return `${prefix}_${crypto.randomUUID()}`;
	}
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
