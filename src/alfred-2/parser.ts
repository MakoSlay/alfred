import { ALFRED_TOOL_NAMES, isRegisteredToolName, type AlfredFinalSpeech, type AlfredToolCall, type AlfredToolName, type ToolRiskLevel } from "./tool-types.ts";
import type { FailureCode } from "./capabilities/failure-codes.ts";
import { MAX_RECURRENCE_MINUTES, MIN_RECURRENCE_MINUTES, parseScheduledTimestamp, validRecurrenceMinutes, validWorkReviewTargetRefs } from "./goals.ts";
import { validateBashCommandShape } from "./bash-command.ts";
import { isWellFormedNoteContent, MAX_NOTE_BYTES, resolveNotePath } from "./tools/note.ts";

export interface ParserDiagnostics {
	rawLength: number;
	thinkStripped: boolean;
	codeFenceStripped: boolean;
	balancedExtractionUsed: boolean;
	warnings: string[];
	schemaError?: string;
	retryCount: number;
}

export type AlfredParseResult =
	| { kind: "final"; value: AlfredFinalSpeech; diagnostics: ParserDiagnostics }
	| { kind: "tool"; value: AlfredToolCall; diagnostics: ParserDiagnostics }
	| { kind: "retryable_error"; error: string; failureCode: Extract<FailureCode, `parser.${string}`>; diagnostics: ParserDiagnostics }
	| { kind: "terminal_error"; error: string; failureCode: Extract<FailureCode, `parser.${string}`>; finalResponse: AlfredFinalSpeech; diagnostics: ParserDiagnostics };

export interface ParseOptions {
	registeredTools?: readonly string[];
	retryCount?: number;
	maxResponseChars?: number;
}

const DEFAULT_MAX_RESPONSE_CHARS = 256_000;
const GRACEFUL_PARSER_FAILURE: AlfredFinalSpeech = {
	speech: "I couldn't parse my own plan cleanly, sir. Please try that again.",
	displayText: "Parser failed after a repair attempt; no tool was executed.",
};

export function parseAlfredModelResponse(raw: string, options: ParseOptions = {}): AlfredParseResult {
	const retryCount = options.retryCount ?? 0;
	const diagnostics: ParserDiagnostics = {
		rawLength: raw.length,
		thinkStripped: false,
		codeFenceStripped: false,
		balancedExtractionUsed: false,
		warnings: [],
		retryCount,
	};

	if (!raw.trim()) {
		return terminal("empty response", diagnostics, "parser.invalid_output");
	}
	if (raw.length > (options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS)) {
		return terminal("response too large", diagnostics, "parser.invalid_output");
	}

	let text = raw.trim();
	const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	if (withoutThink !== text) {
		diagnostics.thinkStripped = true;
		text = withoutThink;
	}

	const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	if (fenced) {
		diagnostics.codeFenceStripped = true;
		text = fenced[1]!.trim();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (strictError) {
		const extraction = extractSingleBalancedObject(text);
		if (extraction.kind === "none") {
			return retryableOrTerminal(`malformed JSON: ${errorMessage(strictError)}`, diagnostics, retryCount, "parser.invalid_output");
		}
		if (extraction.kind === "multiple") {
			return terminal("multiple competing top-level JSON objects", diagnostics, "parser.invalid_output");
		}
		diagnostics.balancedExtractionUsed = true;
		if (extraction.before.trim()) diagnostics.warnings.push("ignored prose before JSON object");
		if (extraction.after.trim()) diagnostics.warnings.push("ignored prose after JSON object");
		try {
			parsed = JSON.parse(extraction.objectText);
		} catch (extractionError) {
			return retryableOrTerminal(`malformed JSON: ${errorMessage(extractionError)}`, diagnostics, retryCount, "parser.invalid_output");
		}
	}

	const validation = validateParsedModelObject(parsed, options.registeredTools ?? ALFRED_TOOL_NAMES);
	if (validation.kind === "final" || validation.kind === "tool") {
		return { kind: validation.kind, value: validation.value as any, diagnostics };
	}
	const validationError = validation.error ?? "schema validation failed";
	diagnostics.schemaError = validationError;
	return retryableOrTerminal(validationError, diagnostics, retryCount, validation.failureCode ?? "parser.invalid_output");
}

export function buildParserRetryPrompt(error: string, registeredTools: readonly string[] = ALFRED_TOOL_NAMES): string {
	return `Your previous response could not be parsed: ${error}.\nReturn exactly one JSON object and nothing else.\nValid final response: {"speech":"..."}\nValid tool call: {"tool":"<registeredTool>", ...tool arguments...}\nRegistered tools: ${registeredTools.join(", ")}.\nDo not use Markdown fences, prose, or multiple JSON objects.`;
}

interface ValidationResult {
	kind: "final" | "tool" | "invalid";
	value?: AlfredFinalSpeech | AlfredToolCall;
	error?: string;
	failureCode?: Extract<FailureCode, `parser.${string}`>;
}

function validateParsedModelObject(value: unknown, registeredTools: readonly string[]): ValidationResult {
	if (!isPlainObject(value)) return { kind: "invalid", error: "response must be a JSON object" };
	const obj = value as Record<string, unknown>;
	const hasSpeech = Object.prototype.hasOwnProperty.call(obj, "speech");
	const hasTool = Object.prototype.hasOwnProperty.call(obj, "tool");

	if (hasSpeech && !hasTool) {
		const allowed = new Set(["speech", "displayText", "citations"]);
		const extra = Object.keys(obj).filter((key) => !allowed.has(key));
		if (extra.length) return { kind: "invalid", error: `final speech has unsupported field(s): ${extra.join(", ")}` };
		if (typeof obj.speech !== "string" || obj.speech.trim().length === 0) {
			return { kind: "invalid", error: "final speech requires non-empty string field: speech" };
		}
		if (obj.displayText !== undefined && typeof obj.displayText !== "string") {
			return { kind: "invalid", error: "displayText must be a string when provided" };
		}
		if (obj.citations !== undefined && (!Array.isArray(obj.citations) || obj.citations.length > 10 || obj.citations.some((citation) => typeof citation !== "string" || citation.length === 0))) {
			return { kind: "invalid", error: "citations must be an array of at most 10 non-empty citation IDs" };
		}
		return {
			kind: "final",
			value: {
				speech: obj.speech.trim(),
				displayText: typeof obj.displayText === "string" ? obj.displayText : undefined,
				citations: Array.isArray(obj.citations) ? [...new Set(obj.citations as string[])] : undefined,
			},
		};
	}

	if (hasSpeech && hasTool) return { kind: "invalid", error: "response cannot contain both speech and tool" };
	if (!hasTool) return { kind: "invalid", error: "response must contain either speech or tool" };
	if (typeof obj.tool !== "string") return { kind: "invalid", error: "tool must be a string" };
	if (!registeredTools.includes(obj.tool)) {
		return { kind: "invalid", error: `unknown tool: ${obj.tool}. Registered tools: ${registeredTools.join(", ")}`, failureCode: "parser.unknown_tool" };
	}
	if (!isRegisteredToolName(obj.tool, ALFRED_TOOL_NAMES)) {
		return { kind: "invalid", error: `tool is registered for this parser but has no local schema: ${obj.tool}` };
	}

	return validateToolCall(obj, obj.tool);
}

function validateToolCall(obj: Record<string, unknown>, tool: AlfredToolName): ValidationResult {
	const common = new Set(["tool", "requestId", "toolCallId", "cwd", "workspaceRef", "timeoutMs", "risk"]);
	for (const key of ["requestId", "toolCallId", "cwd", "workspaceRef"]) {
		if (obj[key] !== undefined && typeof obj[key] !== "string") return { kind: "invalid", error: `${key} must be a string when provided` };
	}
	if (obj.timeoutMs !== undefined && (!Number.isFinite(obj.timeoutMs) || typeof obj.timeoutMs !== "number" || obj.timeoutMs <= 0)) {
		return { kind: "invalid", error: "timeoutMs must be a positive number when provided" };
	}
	if (obj.risk !== undefined && !isRisk(obj.risk)) return { kind: "invalid", error: "risk must be read, external, mutation, or destructive" };

	function rejectExtra(allowedSpecific: string[]): string | null {
		const allowed = new Set([...common, ...allowedSpecific]);
		const extra = Object.keys(obj).filter((key) => !allowed.has(key));
		return extra.length ? `tool ${tool} has unsupported field(s): ${extra.join(", ")}` : null;
	}
	function requireString(key: string): string | null {
		return typeof obj[key] === "string" && (obj[key] as string).length > 0 ? null : `${tool} requires non-empty string field: ${key}`;
	}

	let error: string | null = null;
	switch (tool) {
		case "bash":
			error = rejectExtra(["command", "scope"]);
			if (!error) error = requireString("command");
			if (!error && obj.scope !== undefined && obj.scope !== "workspace" && obj.scope !== "host") error = "bash scope must be workspace or host";
			if (!error && obj.scope === "host" && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "host-scoped bash cannot set cwd or workspaceRef";
			if (!error) error = validateBashCommandShape(String(obj.command));
			break;
		case "read_file":
			error = rejectExtra(["path"]);
			if (!error) error = requireString("path");
			break;
		case "write_file":
			error = rejectExtra(["path", "content"]);
			if (!error) error = requireString("path");
			if (!error && typeof obj.content !== "string") error = "write_file requires string field: content";
			break;
		case "edit_file":
			error = rejectExtra(["path", "oldText", "newText"]);
			if (!error) error = requireString("path");
			if (!error && typeof obj.oldText !== "string") error = "edit_file requires string field: oldText";
			if (!error && typeof obj.newText !== "string") error = "edit_file requires string field: newText";
			break;
		case "save_note":
			error = rejectExtra(["filename", "content", "open", "overwrite"]);
			if (!error && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "save_note cannot override cwd or workspaceRef";
			if (!error) error = requireString("filename");
			if (!error && typeof obj.content !== "string") error = "save_note requires string field: content";
			if (!error && typeof obj.content === "string" && !isWellFormedNoteContent(obj.content)) error = "save_note content contains an unpaired Unicode surrogate";
			if (!error && typeof obj.content === "string" && Buffer.byteLength(obj.content, "utf8") > MAX_NOTE_BYTES) error = `save_note content exceeds the ${MAX_NOTE_BYTES}-byte limit`;
			if (!error && obj.open !== undefined && typeof obj.open !== "boolean") error = "open must be boolean when provided";
			if (!error && obj.overwrite !== undefined && typeof obj.overwrite !== "boolean") error = "overwrite must be boolean when provided";
			if (!error) {
				try { resolveNotePath(String(obj.filename), "/alfred-notes"); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
			}
			break;
		case "list_notes":
			error = rejectExtra([]);
			if (!error && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "list_notes cannot override cwd or workspaceRef";
			break;
		case "read_note":
			error = rejectExtra(["filename"]);
			if (!error && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "read_note cannot override cwd or workspaceRef";
			if (!error) error = requireString("filename");
			if (!error) {
				try { resolveNotePath(String(obj.filename), "/alfred-notes"); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
			}
			break;
		case "open_note":
			error = rejectExtra(["filename"]);
			if (!error && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "open_note cannot override cwd or workspaceRef";
			if (!error && obj.filename !== undefined && typeof obj.filename !== "string") error = "filename must be a string when provided";
			if (!error && typeof obj.filename === "string") {
				try { resolveNotePath(obj.filename, "/alfred-notes"); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
			}
			break;
		case "web_search":
			error = rejectExtra(["query", "numResults"]);
			if (!error) error = requireString("query");
			if (!error && obj.numResults !== undefined && (!Number.isFinite(obj.numResults) || typeof obj.numResults !== "number" || obj.numResults < 1 || obj.numResults > 10)) {
				error = "numResults must be a number from 1 to 10 when provided";
			}
			break;
		case "fetch_content":
			error = rejectExtra(["url"]);
			if (!error) error = requireString("url");
			break;

		case "remember":
			error = rejectExtra(["key", "value", "category"]);
			if (!error) error = requireString("key");
			if (!error) error = requireString("value");
			if (!error && obj.category !== undefined && !["preference", "identity", "context", "note"].includes(String(obj.category))) {
				error = "category must be preference, identity, context, or note when provided";
			}
			break;
		case "recall": {
			error = rejectExtra(["query", "kinds", "limit"]);
			const query = typeof obj.query === "string" ? obj.query.trim() : "";
			if (!error && !query) error = "recall requires non-empty string field: query";
			if (!error && query.length > 500) error = "query must be at most 500 characters";
			if (!error && obj.kinds !== undefined && (!Array.isArray(obj.kinds) || obj.kinds.length === 0 || obj.kinds.some((kind) => !["profile", "session", "knowledge"].includes(String(kind))))) error = "kinds must be a non-empty array containing profile, session, or knowledge";
			if (!error && obj.limit !== undefined && (!Number.isInteger(obj.limit) || typeof obj.limit !== "number" || obj.limit < 1 || obj.limit > 10)) error = "limit must be an integer from 1 to 10 when provided";
			if (!error) obj.query = query;
			break;
		}
		case "search_knowledge":
			error = rejectExtra(["query", "topK", "limit", "sourceId"]);
			if (!error) error = requireString("query");
			if (!error && obj.topK !== undefined && (!Number.isFinite(obj.topK) || typeof obj.topK !== "number" || obj.topK < 1 || obj.topK > 10)) error = "topK must be a number from 1 to 10 when provided";
			if (!error && obj.limit !== undefined && (!Number.isFinite(obj.limit) || typeof obj.limit !== "number" || obj.limit < 1 || obj.limit > 10)) error = "limit must be a number from 1 to 10 when provided";
			if (!error && obj.sourceId !== undefined && typeof obj.sourceId !== "string") error = "sourceId must be a string when provided";
			break;
		case "import_knowledge": {
			error = rejectExtra(["path", "content", "title", "sourceType"]);
			if (!error && (obj.cwd !== undefined || obj.workspaceRef !== undefined)) error = "import_knowledge cannot override cwd or workspaceRef";
			const hasPath = typeof obj.path === "string" && obj.path.trim().length > 0;
			const hasContent = typeof obj.content === "string" && obj.content.trim().length > 0;
			if (!error && hasPath === hasContent) error = "import_knowledge requires exactly one of path or content";
			if (!error && hasContent && (typeof obj.title !== "string" || obj.title.trim().length === 0)) error = "import_knowledge content requires a non-empty title";
			if (!error && obj.title !== undefined && typeof obj.title !== "string") error = "title must be a string when provided";
			if (!error && obj.sourceType !== undefined && !["document", "note", "project"].includes(String(obj.sourceType))) error = "sourceType must be document, note, or project when provided";
			break;
		}
		case "set_voice_settings":
			error = rejectExtra(["fishSpeed", "edgeRate", "speechStyle", "witLevel", "sarcasmLevel", "provider", "fallbackProvider"]);
			if (!error && obj.fishSpeed !== undefined && (!Number.isFinite(obj.fishSpeed) || typeof obj.fishSpeed !== "number" || obj.fishSpeed < 0.5 || obj.fishSpeed > 2)) error = "fishSpeed must be a number from 0.5 to 2 when provided";
			if (!error && obj.edgeRate !== undefined && (typeof obj.edgeRate !== "string" || !/^[+-]?\d+%$/.test(obj.edgeRate))) error = "edgeRate must be a percentage string like +10%";
			if (!error && obj.speechStyle !== undefined && !["auto", "neutral", "warm", "calm", "dry", "reassuring", "sarcastic"].includes(String(obj.speechStyle))) error = "speechStyle must be auto, neutral, warm, calm, dry, reassuring, or sarcastic";
			if (!error && obj.witLevel !== undefined && !["off", "light", "medium"].includes(String(obj.witLevel))) error = "witLevel must be off, light, or medium";
			if (!error && obj.sarcasmLevel !== undefined && !["off", "light", "medium"].includes(String(obj.sarcasmLevel))) error = "sarcasmLevel must be off, light, or medium";
			if (!error && obj.provider !== undefined && !["fish", "edge", "macos"].includes(String(obj.provider))) error = "provider must be fish, edge, or macos";
			if (!error && obj.fallbackProvider !== undefined && !["edge", "macos", "none"].includes(String(obj.fallbackProvider))) error = "fallbackProvider must be edge, macos, or none";
			if (!error && obj.fishSpeed === undefined && obj.edgeRate === undefined && obj.speechStyle === undefined && obj.witLevel === undefined && obj.sarcasmLevel === undefined && obj.provider === undefined && obj.fallbackProvider === undefined) error = "set_voice_settings requires at least one setting field";
			break;
		case "refresh_context":
			error = rejectExtra(["forceFresh"]);
			if (!error && obj.forceFresh !== undefined && typeof obj.forceFresh !== "boolean") error = "forceFresh must be a boolean when provided";
			break;
		case "inspect_session":
			error = rejectExtra(["workspaceName", "tabHint", "surfaceRef", "lines", "scrollback", "maxSurfaces"]);
			if (!error && obj.workspaceName !== undefined && typeof obj.workspaceName !== "string") error = "workspaceName must be a string when provided";
			if (!error && obj.tabHint !== undefined && typeof obj.tabHint !== "string") error = "tabHint must be a string when provided";
			if (!error && obj.surfaceRef !== undefined && typeof obj.surfaceRef !== "string") error = "surfaceRef must be a string when provided";
			if (!error && obj.lines !== undefined && (!Number.isFinite(obj.lines) || typeof obj.lines !== "number" || obj.lines < 20 || obj.lines > 1000)) error = "lines must be a number from 20 to 1000 when provided";
			if (!error && obj.scrollback !== undefined && typeof obj.scrollback !== "boolean") error = "scrollback must be a boolean when provided";
			if (!error && obj.maxSurfaces !== undefined && (!Number.isFinite(obj.maxSurfaces) || typeof obj.maxSurfaces !== "number" || obj.maxSurfaces < 1 || obj.maxSurfaces > 5)) error = "maxSurfaces must be a number from 1 to 5 when provided";
			if (!error && obj.workspaceName === undefined && obj.workspaceRef === undefined) error = "inspect_session requires workspaceName or workspaceRef";
			// tabHint and surfaceRef are optional; when absent the tool auto-picks the best surface(s) in the workspace.
			break;
		case "send_session_message":
			error = rejectExtra(["workspaceName", "tabHint", "surfaceRef", "text", "mode"]);
			if (!error && obj.workspaceName !== undefined && typeof obj.workspaceName !== "string") error = "workspaceName must be a string when provided";
			if (!error && obj.tabHint !== undefined && typeof obj.tabHint !== "string") error = "tabHint must be a string when provided";
			if (!error && obj.surfaceRef !== undefined && typeof obj.surfaceRef !== "string") error = "surfaceRef must be a string when provided";
			if (!error && obj.workspaceName === undefined && obj.workspaceRef === undefined) error = "send_session_message requires workspaceName or workspaceRef";
			if (!error && obj.tabHint === undefined && obj.surfaceRef === undefined) error = "send_session_message requires tabHint or surfaceRef";
			if (!error) error = requireString("text");
			if (!error && obj.mode !== undefined && !["draft", "send"].includes(String(obj.mode))) error = "mode must be draft or send when provided";
			break;
		case "start_session_monitor":
			error = rejectExtra(["workspaceName", "tabHint", "surfaceRef", "goal", "replyMode", "pollIntervalMs", "maxTurns"]);
			if (!error && obj.workspaceName !== undefined && typeof obj.workspaceName !== "string") error = "workspaceName must be a string when provided";
			if (!error && obj.tabHint !== undefined && typeof obj.tabHint !== "string") error = "tabHint must be a string when provided";
			if (!error && obj.surfaceRef !== undefined && typeof obj.surfaceRef !== "string") error = "surfaceRef must be a string when provided";
			if (!error && obj.workspaceName === undefined && obj.workspaceRef === undefined) error = "start_session_monitor requires workspaceName or workspaceRef";
			if (!error && obj.tabHint === undefined && obj.surfaceRef === undefined) error = "start_session_monitor requires tabHint or surfaceRef";
			if (!error) error = requireString("goal");
			if (!error && obj.replyMode !== undefined && !["draft", "send"].includes(String(obj.replyMode))) error = "replyMode must be draft or send when provided";
			if (!error && obj.pollIntervalMs !== undefined && (!Number.isFinite(obj.pollIntervalMs) || typeof obj.pollIntervalMs !== "number" || obj.pollIntervalMs < 1000 || obj.pollIntervalMs > 600000)) error = "pollIntervalMs must be a number from 1000 to 600000 when provided";
			if (!error && obj.maxTurns !== undefined && (!Number.isFinite(obj.maxTurns) || typeof obj.maxTurns !== "number" || obj.maxTurns < 1 || obj.maxTurns > 24)) error = "maxTurns must be a number from 1 to 24 when provided";
			break;
		case "poll_session_monitor":
		case "session_monitor_status":
		case "stop_session_monitor":
			error = rejectExtra(["monitorId"]);
			if (!error && obj.monitorId !== undefined && typeof obj.monitorId !== "string") error = "monitorId must be a string when provided";
			break;
		case "gmail_search":
			error = rejectExtra(["query", "maxResults"]);
			if (!error) error = requireString("query");
			if (!error && obj.maxResults !== undefined && (!Number.isFinite(obj.maxResults) || typeof obj.maxResults !== "number" || obj.maxResults < 1 || obj.maxResults > 20)) error = "maxResults must be a number from 1 to 20 when provided";
			break;
		case "gmail_read":
			error = rejectExtra(["messageId"]);
			if (!error) error = requireString("messageId");
			break;
		case "calendar_today":
			error = rejectExtra(["calendarId"]);
			if (!error && obj.calendarId !== undefined && typeof obj.calendarId !== "string") error = "calendarId must be a string when provided";
			break;
		case "calendar_upcoming":
			error = rejectExtra(["calendarId", "maxResults", "timeMin", "timeMax"]);
			if (!error && obj.calendarId !== undefined && typeof obj.calendarId !== "string") error = "calendarId must be a string when provided";
			if (!error && obj.maxResults !== undefined && (!Number.isFinite(obj.maxResults) || typeof obj.maxResults !== "number" || obj.maxResults < 1 || obj.maxResults > 50)) error = "maxResults must be a number from 1 to 50 when provided";
			if (!error && obj.timeMin !== undefined && typeof obj.timeMin !== "string") error = "timeMin must be an ISO string when provided";
			if (!error && obj.timeMax !== undefined && typeof obj.timeMax !== "string") error = "timeMax must be an ISO string when provided";
			break;
		case "docs_search":
			error = rejectExtra(["query", "maxResults"]);
			if (!error) error = requireString("query");
			if (!error && obj.maxResults !== undefined && (!Number.isFinite(obj.maxResults) || typeof obj.maxResults !== "number" || obj.maxResults < 1 || obj.maxResults > 20)) error = "maxResults must be a number from 1 to 20 when provided";
			break;
		case "docs_read":
			error = rejectExtra(["documentId"]);
			if (!error) error = requireString("documentId");
			break;
		case "log_break":
			error = rejectExtra([]);
			break;
		case "wellness_status":
			error = rejectExtra([]);
			break;
		case "list_goals":
			error = rejectExtra(["status"]);
			if (!error && obj.status !== undefined && !["active", "completed", "all"].includes(String(obj.status))) error = "status must be active, completed, or all";
			break;
		case "create_goal":
			error = rejectExtra(["title", "notes"]);
			if (!error) error = requireString("title");
			if (!error && obj.notes !== undefined && typeof obj.notes !== "string") error = "notes must be a string when provided";
			break;
		case "update_goal":
			error = rejectExtra(["goalIdOrTitle", "title", "notes", "status"]);
			if (!error) error = requireString("goalIdOrTitle");
			if (!error && obj.title !== undefined && typeof obj.title !== "string") error = "title must be a string when provided";
			if (!error && obj.notes !== undefined && typeof obj.notes !== "string") error = "notes must be a string when provided";
			if (!error && obj.status !== undefined && !["active", "completed"].includes(String(obj.status))) error = "status must be active or completed when provided";
			if (!error && obj.title === undefined && obj.notes === undefined && obj.status === undefined) error = "update_goal requires title, notes, or status";
			break;
		case "list_scheduled_jobs":
			error = rejectExtra(["enabledOnly"]);
			if (!error && obj.enabledOnly !== undefined && typeof obj.enabledOnly !== "boolean") error = "enabledOnly must be a boolean when provided";
			break;
		case "schedule_job":
			error = rejectExtra(["kind", "title", "runAt", "recurrenceMinutes", "surfaceRef"]);
			if (!error && !["reminder", "work_review"].includes(String(obj.kind))) error = "kind must be reminder or work_review";
			if (!error) error = requireString("title");
			if (!error) error = requireString("runAt");
			if (!error && !parseScheduledTimestamp(String(obj.runAt))) error = "runAt must be an RFC3339 timestamp with an explicit timezone";
			if (!error && obj.recurrenceMinutes !== undefined && (typeof obj.recurrenceMinutes !== "number" || !validRecurrenceMinutes(obj.recurrenceMinutes))) error = `recurrenceMinutes must be an integer of at least ${MIN_RECURRENCE_MINUTES} and at most ${MAX_RECURRENCE_MINUTES}`;
			if (!error && obj.kind === "work_review" && !validWorkReviewTargetRefs(typeof obj.workspaceRef === "string" ? obj.workspaceRef : undefined, typeof obj.surfaceRef === "string" ? obj.surfaceRef : undefined)) error = "work_review requires exact workspaceRef and surfaceRef values";
			break;
		case "cancel_scheduled_job":
			error = rejectExtra(["jobId"]);
			if (!error) error = requireString("jobId");
			break;
		case "review_current_work":
			error = rejectExtra([]);
			break;
	}
	if (error) return { kind: "invalid", error, failureCode: "parser.invalid_tool_arguments" };
	return { kind: "tool", value: obj as unknown as AlfredToolCall };
}

function extractSingleBalancedObject(text: string): { kind: "none" } | { kind: "multiple" } | { kind: "single"; objectText: string; before: string; after: string } {
	const matches: Array<{ start: number; end: number }> = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				matches.push({ start, end: i + 1 });
				start = -1;
			}
		}
	}

	if (matches.length === 0) return { kind: "none" };
	if (matches.length > 1) return { kind: "multiple" };
	const only = matches[0]!;
	return {
		kind: "single",
		objectText: text.slice(only.start, only.end),
		before: text.slice(0, only.start),
		after: text.slice(only.end),
	};
}

function retryableOrTerminal(error: string, diagnostics: ParserDiagnostics, retryCount: number, failureCode: Extract<FailureCode, `parser.${string}`>): AlfredParseResult {
	diagnostics.schemaError = error;
	if (retryCount >= 1) return terminal(error, diagnostics, failureCode);
	return { kind: "retryable_error", error, failureCode, diagnostics };
}

function terminal(error: string, diagnostics: ParserDiagnostics, failureCode: Extract<FailureCode, `parser.${string}`>): AlfredParseResult {
	diagnostics.schemaError = error;
	return { kind: "terminal_error", error, failureCode, finalResponse: GRACEFUL_PARSER_FAILURE, diagnostics };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRisk(value: unknown): value is ToolRiskLevel {
	return value === "read" || value === "external" || value === "mutation" || value === "destructive";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
