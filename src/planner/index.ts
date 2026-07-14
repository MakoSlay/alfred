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
import { isSafeRelativeMarkdownPath, isSafeRelativePath, normalizeHttpUrl } from "../validation/open.ts";

export const DEFAULT_PLANNER_MAX_INPUT_CHARS = 4_000;
export const MAX_PLANNER_MESSAGE_CHARS = 8_000;
export const DEFAULT_PLANNER_TIMEOUT_MS = 15_000;
export const DEFAULT_PLANNER_MAX_TOKENS = 500;

export type AlfredTargetKindHint = "workspace" | "tab" | "surface" | "chat";

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
	| { kind: "draft_message_to_target"; targetPhrase: string; targetKindHint?: AlfredTargetKindHint; message: string }
	/** Legacy contract retained for existing injected planners/tests. New planners should emit draft_message_to_target. */
	| { kind: "draft_message"; targetRef?: AlfredRef; targetName?: string; message: string }
	| { kind: "open_file"; path: string }
	| { kind: "open_markdown"; path: string }
	| { kind: "open_url"; url: string }
	| { kind: "open_browser"; url?: string }
	| { kind: "list_targets" }
	| { kind: "read_notifications"; filter?: "all" | "unread"; countOnly?: boolean };

export interface AlfredPlannerResult {
	ok: boolean;
	intent?: AlfredPlannerIntent;
	errors?: AlfredError[];
	sanitizedInputSummary: RedactedText;
}

export interface AlfredPlanner {
	plan(input: AlfredPlannerInput): Promise<AlfredPlannerResult>;
}

export interface AlfredPlannerMessage {
	role: "system" | "user";
	content: string;
}

export interface AlfredLlmPlannerConfig {
	endpoint: string;
	model: string;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	fetchImpl?: typeof fetch;
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

export function buildPlannerMessages(input: AlfredPlannerInput): AlfredPlannerMessage[] {
	return [
		{ role: "system", content: buildPlannerSystemPrompt() },
		{ role: "user", content: buildPlannerUserPrompt(input) },
	];
}

export function buildPlannerSystemPrompt(): string {
	return `You are Alfred's Ask planner.
Return exactly one JSON object and nothing else. Do not use markdown.
Do not execute tools. Pick from the allowed tools only. Alfred daemon code will validate targets, permissions, paths, URLs, and risk before executing or proposing anything.
Allowed tool JSON shapes:
{"kind":"draft_message_to_target","targetPhrase":"visible tab/workspace phrase","targetKindHint":"workspace|tab|surface|chat","message":"text to send after confirmation"}
{"kind":"open_file","path":"safe/relative/path"}
{"kind":"open_markdown","path":"safe/relative/file.md"}
{"kind":"open_url","url":"https://example.com"}
{"kind":"open_browser","url":"https://example.com"}
{"kind":"list_targets"}
{"kind":"read_notifications","filter":"all|unread","countOnly":false}
{"kind":"none","reason":"short reason"}
Rules:
- Never output direct-send, execute, shell, browser-click/type, delete, close, or mutation actions.
- If the user wants Alfred to ask, tell, message, or send text to a visible tab/chat/workspace, output draft_message_to_target. Sends require confirmation later.
- For phrases like "look at the named project tab and ask X", use the visible target phrase from the request, targetKindHint "tab", and message "X".
- If a user mentions both a workspace context and a specific tab/chat/surface, prefer the explicit tab/chat/surface as the target.
- Never invent targets. Use a visible target label/ref/workspace label phrase. If unsure, output {"kind":"none","reason":"..."}.
- The message field is exactly what Alfred should send to the target, not narration about Alfred.`;
}

export function buildPlannerUserPrompt(input: AlfredPlannerInput): string {
	const targets = input.visibleTargets.length > 0
		? input.visibleTargets.map(formatTargetForPlannerPrompt).join("\n")
		: "(none)";
	const capabilities = input.allowedCapabilities.length > 0 ? input.allowedCapabilities.join(", ") : "(none)";
	return `User input: ${input.inputText}
Current workspace ref: ${input.currentWorkspaceRef ?? "unknown"}
Source capabilities: ${capabilities}
Visible targets:
${targets}
Return one JSON object now.`;
}

export function createOpenAiToolPlanner(config: AlfredLlmPlannerConfig): AlfredPlanner {
	return {
		async plan(input) {
			const sanitizedInputSummary = plannerInputSummary(input.inputText, input.maxInputChars);
			const content = await callChatModel(config, buildPlannerMessages(input));
			if (!content.trim()) {
				return { ok: true, intent: { kind: "none", reason: "Planner returned empty output." }, sanitizedInputSummary };
			}
			return parsePlannerIntent(content, sanitizedInputSummary);
		},
	};
}

export function createPlannerFromEnv(env: NodeJS.ProcessEnv = process.env): AlfredPlanner | undefined {
	const enabled = readEnv(env, "ALFRED_PLANNER_ENABLED", "ALFRED_LLM_ENABLED");
	if (enabled && /^(?:0|false|no|off)$/i.test(enabled)) return undefined;
	const endpoint = readEnv(env, "ALFRED_LLM_ENDPOINT", "ALFRED_AI_ENDPOINT", "AI_ENDPOINT");
	const model = readEnv(env, "ALFRED_LLM_MODEL", "ALFRED_AI_MODEL", "AI_MODEL");
	const shouldEnable = enabled ? /^(?:1|true|yes|on)$/i.test(enabled) : Boolean(endpoint || model);
	if (!shouldEnable) return undefined;
	return createOpenAiToolPlanner({
		endpoint: endpoint ?? "http://localhost:11434/v1",
		model: model ?? "llama3.2",
		apiKey: readEnv(env, "ALFRED_LLM_API_KEY", "ALFRED_AI_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"),
		temperature: parseOptionalNumber(readEnv(env, "ALFRED_LLM_TEMPERATURE", "ALFRED_AI_TEMPERATURE")),
		maxTokens: parseOptionalInteger(readEnv(env, "ALFRED_LLM_MAX_TOKENS", "ALFRED_AI_MAX_TOKENS")),
		timeoutMs: parseOptionalInteger(readEnv(env, "ALFRED_LLM_TIMEOUT_MS", "ALFRED_AI_TIMEOUT_MS")),
		thinkingLevel: parseThinkingLevel(readEnv(env, "ALFRED_LLM_THINKING_LEVEL", "ALFRED_AI_THINKING_LEVEL")),
	});
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
	if (intent.kind === "draft_message_to_target") {
		if (intent.confirmBeforeSend === false || intent.requireConfirmation === false || intent.bypassConfirmation === true) {
			return { ok: false, errors: [{ code: "unsupported_action", message: "Planner draft intents must require confirmation before send.", retryable: false }] };
		}
		const message = requiredPlannerMessage(intent.message);
		if (!message.ok) return message;
		const targetPhrase = optionalShortString(intent.targetPhrase, 300);
		if (!targetPhrase) {
			return { ok: false, errors: [{ code: "target_not_found", message: "Planner draft intent must include targetPhrase.", retryable: false }] };
		}
		const targetKindHint = parseTargetKindHint(intent.targetKindHint);
		if (intent.targetKindHint !== undefined && !targetKindHint) {
			return { ok: false, errors: [{ code: "invalid_request", message: "Planner targetKindHint must be workspace, tab, surface, or chat.", retryable: false }] };
		}
		return { ok: true, intent: { kind: "draft_message_to_target", targetPhrase, targetKindHint, message: message.value } };
	}
	if (intent.kind === "draft_message") {
		if (intent.confirmBeforeSend === false || intent.requireConfirmation === false || intent.bypassConfirmation === true) {
			return { ok: false, errors: [{ code: "unsupported_action", message: "Planner draft intents must require confirmation before send.", retryable: false }] };
		}
		const message = requiredPlannerMessage(intent.message);
		if (!message.ok) return message;
		const targetRef = optionalShortString(intent.targetRef, 300);
		const targetName = optionalShortString(intent.targetName, 300);
		if (!targetRef && !targetName) {
			return { ok: false, errors: [{ code: "target_not_found", message: "Planner draft intent must include targetRef or targetName.", retryable: false }] };
		}
		return { ok: true, intent: { kind: "draft_message", targetRef, targetName, message: message.value } };
	}
	if (intent.kind === "open_file") {
		const path = optionalShortString(intent.path, 1_000);
		if (!path || !isSafeRelativePath(path)) return { ok: false, errors: [{ code: "invalid_request", message: "Planner open_file path must be a safe relative path.", retryable: false }] };
		return { ok: true, intent: { kind: "open_file", path } };
	}
	if (intent.kind === "open_markdown") {
		const path = optionalShortString(intent.path, 1_000);
		if (!path || !isSafeRelativeMarkdownPath(path)) return { ok: false, errors: [{ code: "invalid_request", message: "Planner open_markdown path must be a safe relative markdown path.", retryable: false }] };
		return { ok: true, intent: { kind: "open_markdown", path } };
	}
	if (intent.kind === "open_url") {
		const url = typeof intent.url === "string" ? normalizeHttpUrl(intent.url) : null;
		if (!url) return { ok: false, errors: [{ code: "invalid_request", message: "Planner open_url URL must be a valid http(s) URL.", retryable: false }] };
		return { ok: true, intent: { kind: "open_url", url } };
	}
	if (intent.kind === "open_browser") {
		const url = intent.url === undefined ? undefined : typeof intent.url === "string" ? normalizeHttpUrl(intent.url) : null;
		if (url === null) return { ok: false, errors: [{ code: "invalid_request", message: "Planner open_browser URL must be a valid http(s) URL when provided.", retryable: false }] };
		return { ok: true, intent: url ? { kind: "open_browser", url } : { kind: "open_browser" } };
	}
	if (intent.kind === "list_targets") {
		return { ok: true, intent: { kind: "list_targets" } };
	}
	if (intent.kind === "read_notifications") {
		if (intent.filter !== undefined && intent.filter !== "all" && intent.filter !== "unread") {
			return { ok: false, errors: [{ code: "invalid_request", message: "Planner read_notifications filter must be all or unread.", retryable: false }] };
		}
		if (intent.countOnly !== undefined && typeof intent.countOnly !== "boolean") {
			return { ok: false, errors: [{ code: "invalid_request", message: "Planner read_notifications countOnly must be boolean.", retryable: false }] };
		}
		return { ok: true, intent: { kind: "read_notifications", filter: intent.filter, countOnly: intent.countOnly } };
	}
	return { ok: false, errors: [{ code: "unsupported_action", message: "Planner intent kind is not supported.", retryable: false }] };
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

function formatTargetForPlannerPrompt(target: AlfredTarget): string {
	const parts = [
		`- label=${JSON.stringify(target.label)}`,
		`ref=${JSON.stringify(target.ref)}`,
		`kind=${JSON.stringify(target.kind)}`,
	];
	if (target.surfaceRef) parts.push(`surfaceRef=${JSON.stringify(target.surfaceRef)}`);
	if (target.workspaceRef) parts.push(`workspaceRef=${JSON.stringify(target.workspaceRef)}`);
	if (target.workspaceLabel) parts.push(`workspaceLabel=${JSON.stringify(target.workspaceLabel)}`);
	if (target.current) parts.push("current=true");
	if (target.selected) parts.push("selected=true");
	if (target.capabilities.length > 0) parts.push(`capabilities=${JSON.stringify(target.capabilities)}`);
	return parts.join(" ");
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
	if (kind.includes("send") && kind !== "draft_message" && kind !== "draft_message_to_target") return true;
	return value.sendNow === true || value.execute === true || value.autoConfirm === true || value.bypassConfirmation === true;
}

function requiredPlannerMessage(value: unknown): { ok: true; value: string } | { ok: false; errors: AlfredError[] } {
	const message = typeof value === "string" ? value.trim() : "";
	if (!message) {
		return { ok: false, errors: [{ code: "invalid_request", message: "Planner draft intent is missing message text.", retryable: false }] };
	}
	if (message.length > MAX_PLANNER_MESSAGE_CHARS) {
		return { ok: false, errors: [{ code: "invalid_request", message: "Planner draft message exceeds the configured size limit.", retryable: false }] };
	}
	return { ok: true, value: message };
}

function parseTargetKindHint(value: unknown): AlfredTargetKindHint | undefined {
	if (value !== "workspace" && value !== "tab" && value !== "surface" && value !== "chat") return undefined;
	return value;
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

async function callChatModel(config: AlfredLlmPlannerConfig, messages: AlfredPlannerMessage[]): Promise<string> {
	const endpoint = config.endpoint || "http://localhost:11434/v1";
	const model = config.model || "llama3.2";
	const apiKey = config.apiKey ?? "";
	const temperature = config.temperature ?? 0;
	const maxTokens = config.maxTokens ?? DEFAULT_PLANNER_MAX_TOKENS;
	const timeoutMs = config.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
	const url = chatCompletionsUrl(endpoint);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const payload: Record<string, unknown> = { model, messages, temperature, max_tokens: maxTokens };
	if (isDeepSeekModel(model, endpoint)) {
		const effort = deepSeekReasoningEffort(config.thinkingLevel ?? "xhigh");
		payload.thinking = { type: effort ? "enabled" : "disabled" };
		if (effort) payload.reasoning_effort = effort;
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const fetchImpl = config.fetchImpl ?? fetch;
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
		return data.choices?.[0]?.message?.content?.trim() ?? "";
	} finally {
		clearTimeout(timeoutId);
	}
}

function normalizeEndpoint(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/chat/completions") ? trimmed.slice(0, -"/chat/completions".length) : trimmed;
}

function chatCompletionsUrl(endpoint: string): string {
	return `${normalizeEndpoint(endpoint)}/chat/completions`;
}

function isDeepSeekModel(model: string, endpoint: string): boolean {
	return model.toLowerCase().includes("deepseek") || normalizeEndpoint(endpoint).includes("deepseek.com");
}

function deepSeekReasoningEffort(level: AlfredLlmPlannerConfig["thinkingLevel"]): string | null {
	switch (level) {
		case "off": return null;
		case "minimal":
		case "low": return "low";
		case "medium": return "medium";
		case "high": return "high";
		case "xhigh": return "max";
		default: return "max";
	}
}

function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
	const parsed = parseOptionalNumber(value);
	return parsed === undefined ? undefined : Math.floor(parsed);
}

function parseThinkingLevel(value: string | undefined): AlfredLlmPlannerConfig["thinkingLevel"] | undefined {
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	return undefined;
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
