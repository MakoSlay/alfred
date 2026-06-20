import type {
	AlfredCapability,
	AlfredError,
	AlfredHandleRequest,
	AlfredId,
	AlfredRef,
	AlfredSource,
	AlfredTarget,
	RedactedText,
} from "../contracts/runtime.ts";
import { redactedText } from "../contracts/runtime.ts";

export const DEFAULT_PLANNER_MAX_INPUT_CHARS = 4_000;
export const MAX_PLANNER_MESSAGE_CHARS = 8_000;

export interface AlfredPlannerInput {
	requestId: AlfredId;
	source: AlfredSource;
	inputText: string;
	currentWorkspaceRef?: AlfredRef;
	visibleTargets: AlfredTarget[];
	allowedCapabilities: AlfredCapability[];
	maxInputChars: number;
}

export type AlfredPlannerIntent =
	| { kind: "none"; reason?: string }
	| { kind: "draft_message"; targetRef?: AlfredRef; targetName?: string; message: string };

export interface AlfredPlannerResult {
	ok: boolean;
	intent?: AlfredPlannerIntent;
	errors?: AlfredError[];
	sanitizedInputSummary: RedactedText;
}

export interface AlfredPlanner {
	plan(input: AlfredPlannerInput): Promise<AlfredPlannerResult>;
}

interface SanitizedText {
	value: string;
	redaction: RedactedText["redaction"];
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
	{ name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "[redacted:api-key]" },
	{ name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, replacement: "[redacted:github-token]" },
	{ name: "env-secret", pattern: /\b([A-Z][A-Z0-9_]{2,}(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)\b/g, replacement: "$1=[redacted:secret]" },
	{ name: "labelled-secret", pattern: /\b(password|passwd|token|secret|api[_ -]?key)\s*[:=]\s*([^\s,;]+)/gi, replacement: "$1=[redacted:secret]" },
];

export function buildPlannerInput(request: AlfredHandleRequest, source: AlfredSource, visibleTargets: readonly AlfredTarget[]): AlfredPlannerInput {
	const maxInputChars = plannerInputLimit(request.policy?.maxTranscriptChars);
	const sanitizedInput = sanitizePlannerText(request.input?.text ?? "", maxInputChars);
	return {
		requestId: request.requestId,
		source: sanitizeSourceForPlanner(source),
		inputText: sanitizedInput.value,
		currentWorkspaceRef: request.context?.currentWorkspaceRef,
		visibleTargets: visibleTargets.map(sanitizeTargetForPlanner),
		allowedCapabilities: [...source.capabilities],
		maxInputChars,
	};
}

export function plannerInputSummary(inputText: string, maxInputChars: number = DEFAULT_PLANNER_MAX_INPUT_CHARS): RedactedText {
	const sanitized = sanitizePlannerText(inputText, maxInputChars);
	return redactedText(sanitized.value, sanitized.redaction);
}

export function parsePlannerIntent(content: string, sanitizedInputSummary: RedactedText = redactedText("")): AlfredPlannerResult {
	for (const candidate of extractJsonObjectCandidates(content)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const validation = validatePlannerIntent(parsed);
		if (validation.ok) {
			return { ok: true, intent: validation.intent, sanitizedInputSummary };
		}
		if (isDirectSendLike(parsed)) {
			return { ok: false, errors: validation.errors, sanitizedInputSummary };
		}
	}
	return {
		ok: false,
		errors: [{ code: "unsupported_action", message: "Planner output did not contain a supported action proposal.", retryable: false }],
		sanitizedInputSummary,
	};
}

export function validatePlannerResult(result: unknown, sanitizedInputSummary: RedactedText): AlfredPlannerResult {
	if (!isRecord(result)) {
		return {
			ok: false,
			errors: [{ code: "llm_unavailable", message: "Planner returned an invalid result envelope.", retryable: true }],
			sanitizedInputSummary,
		};
	}
	const errors = sanitizePlannerErrors(Array.isArray(result.errors) ? result.errors : undefined);
	if (result.ok !== true) {
		return {
			ok: false,
			errors: errors.length > 0 ? errors : [{ code: "llm_unavailable", message: "Planner did not return a usable action proposal.", retryable: true }],
			sanitizedInputSummary: coerceRedactedText(result.sanitizedInputSummary, sanitizedInputSummary),
		};
	}
	if (result.intent === undefined) {
		return { ok: true, intent: { kind: "none" }, sanitizedInputSummary: coerceRedactedText(result.sanitizedInputSummary, sanitizedInputSummary) };
	}
	const validation = validatePlannerIntent(result.intent);
	if (!validation.ok) {
		return { ok: false, errors: validation.errors, sanitizedInputSummary: coerceRedactedText(result.sanitizedInputSummary, sanitizedInputSummary) };
	}
	return { ok: true, intent: validation.intent, sanitizedInputSummary: coerceRedactedText(result.sanitizedInputSummary, sanitizedInputSummary) };
}

export function validatePlannerIntent(intent: unknown): { ok: true; intent: AlfredPlannerIntent } | { ok: false; errors: AlfredError[] } {
	if (!isRecord(intent)) {
		return { ok: false, errors: [{ code: "unsupported_action", message: "Planner intent must be an object.", retryable: false }] };
	}
	if (isDirectSendLike(intent)) {
		return { ok: false, errors: [{ code: "unsupported_action", message: "Direct send planner actions are not supported; planner sends must become drafts.", retryable: false }] };
	}
	if (intent.kind === "none") {
		return { ok: true, intent: { kind: "none", reason: optionalShortString(intent.reason, 500) } };
	}
	if (intent.kind !== "draft_message") {
		return { ok: false, errors: [{ code: "unsupported_action", message: "Planner intent kind is not supported.", retryable: false }] };
	}
	if (intent.confirmBeforeSend === false || intent.requireConfirmation === false || intent.bypassConfirmation === true) {
		return { ok: false, errors: [{ code: "unsupported_action", message: "Planner draft intents must require confirmation before send.", retryable: false }] };
	}
	const message = typeof intent.message === "string" ? intent.message.trim() : "";
	if (!message) {
		return { ok: false, errors: [{ code: "invalid_request", message: "Planner draft intent is missing message text.", retryable: false }] };
	}
	if (message.length > MAX_PLANNER_MESSAGE_CHARS) {
		return { ok: false, errors: [{ code: "invalid_request", message: "Planner draft message exceeds the configured size limit.", retryable: false }] };
	}
	const targetRef = optionalShortString(intent.targetRef, 300);
	const targetName = optionalShortString(intent.targetName, 300);
	if (!targetRef && !targetName) {
		return { ok: false, errors: [{ code: "target_not_found", message: "Planner draft intent must include targetRef or targetName.", retryable: false }] };
	}
	return { ok: true, intent: { kind: "draft_message", targetRef, targetName, message } };
}

export function extractJsonObjectCandidates(content: string): string[] {
	const trimmed = content.trim();
	const candidates = new Set<string>();
	if (trimmed) candidates.add(trimmed);
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.add(content.slice(start, index + 1).trim());
				start = -1;
			}
		}
	}
	return [...candidates];
}

export function sanitizePlannerText(raw: string, maxChars: number = DEFAULT_PLANNER_MAX_INPUT_CHARS): SanitizedText {
	const originalLength = raw.length;
	let value = raw.replace(/\s+/g, " ").trim();
	const rulesApplied: string[] = [];
	for (const rule of SECRET_PATTERNS) {
		const next = value.replace(rule.pattern, rule.replacement);
		if (next !== value) rulesApplied.push(rule.name);
		value = next;
	}
	const boundedMax = Math.max(0, Math.floor(maxChars));
	if (value.length > boundedMax) {
		if (boundedMax === 0) {
			value = "";
		} else if (boundedMax === 1) {
			value = "…";
		} else {
			value = `${value.slice(0, boundedMax - 1).trimEnd()}…`;
		}
		rulesApplied.push("max-input-chars");
	}
	return {
		value,
		redaction: rulesApplied.length > 0
			? { status: "redacted", rulesApplied, originalLength }
			: { status: "not_needed", originalLength },
	};
}

export function plannerInputLimit(policyMaxTranscriptChars?: number): number {
	if (!Number.isFinite(policyMaxTranscriptChars) || policyMaxTranscriptChars === undefined) {
		return DEFAULT_PLANNER_MAX_INPUT_CHARS;
	}
	return Math.max(0, Math.min(DEFAULT_PLANNER_MAX_INPUT_CHARS, Math.floor(policyMaxTranscriptChars)));
}

export function sanitizePlannerErrors(errors: readonly unknown[] | undefined): AlfredError[] {
	if (!errors) return [];
	return errors.slice(0, 5).map((error) => {
		if (!isRecord(error)) {
			return { code: "internal_error", message: "Planner returned an unknown error.", retryable: false } satisfies AlfredError;
		}
		const code = isAlfredErrorCode(error.code) ? error.code : "internal_error";
		const rawMessage = typeof error.message === "string" ? error.message : "Planner returned an error.";
		const message = sanitizePlannerText(rawMessage, 300).value || "Planner returned an error.";
		return {
			code,
			message,
			retryable: typeof error.retryable === "boolean" ? error.retryable : false,
			details: sanitizeErrorDetails(error.details),
		};
	});
}

function sanitizeSourceForPlanner(source: AlfredSource): AlfredSource {
	return {
		kind: source.kind,
		id: source.id,
		label: source.label,
		userIntent: source.userIntent,
		trustedLocalOnly: source.trustedLocalOnly,
		capabilities: [...source.capabilities],
	};
}

function sanitizeTargetForPlanner(target: AlfredTarget): AlfredTarget {
	return {
		kind: target.kind,
		ref: target.ref,
		label: target.label,
		workspaceRef: target.workspaceRef,
		workspaceLabel: target.workspaceLabel,
		surfaceRef: target.surfaceRef,
		current: target.current,
		selected: target.selected,
		confidence: target.confidence,
		capabilities: [...target.capabilities],
	};
}

function isDirectSendLike(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
	if (["send", "direct_send", "send_message", "execute_send", "cmux_send", "surface_send", "workspace_send"].includes(kind)) return true;
	if (kind.includes("send") && kind !== "draft_message") return true;
	return value.sendNow === true || value.execute === true || value.autoConfirm === true || value.bypassConfirmation === true;
}

function optionalShortString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function coerceRedactedText(value: unknown, fallback: RedactedText): RedactedText {
	if (!isRecord(value) || typeof value.value !== "string" || !isRecord(value.redaction)) return fallback;
	const status = value.redaction.status;
	if (status !== "not_needed" && status !== "redacted" && status !== "contains_sensitive" && status !== "unknown") return fallback;
	return { value: sanitizePlannerText(value.value, DEFAULT_PLANNER_MAX_INPUT_CHARS).value, redaction: { ...value.redaction, status } };
}

function sanitizeErrorDetails(details: unknown): AlfredError["details"] {
	if (!isRecord(details)) return undefined;
	const sanitized: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(details).slice(0, 10)) {
		if (typeof value === "string") sanitized[key] = sanitizePlannerText(value, 200).value;
		else if (typeof value === "number" || typeof value === "boolean" || value === null) sanitized[key] = value;
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function isAlfredErrorCode(value: unknown): value is AlfredError["code"] {
	return typeof value === "string" && [
		"invalid_request",
		"target_not_found",
		"target_ambiguous",
		"capability_denied",
		"confirmation_required",
		"confirmation_expired",
		"send_failed",
		"loop_already_running",
		"loop_not_found",
		"cmux_unavailable",
		"llm_unavailable",
		"unsupported_action",
		"not_found",
		"internal_error",
	].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
