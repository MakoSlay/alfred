import type { StructuredFailure } from "./capabilities/failure-codes.ts";
import type { KnowledgeCitation, MemoryKind } from "./memory-types.ts";

export const ALFRED_TOOL_NAMES = [
	"bash",
	"read_file",
	"write_file",
	"edit_file",
	"save_note",
	"list_notes",
	"read_note",
	"open_note",
	"web_search",
	"fetch_content",
	"remember",
	"recall",
	"search_knowledge",
	"import_knowledge",
	"set_voice_settings",
	"refresh_context",
	"inspect_session",
	"send_session_message",
	"start_session_monitor",
	"poll_session_monitor",
	"session_monitor_status",
	"stop_session_monitor",
	"gmail_search",
	"gmail_read",
	"calendar_today",
	"calendar_upcoming",
	"docs_search",
	"docs_read",
	"log_break",
	"wellness_status",
	"list_goals",
	"create_goal",
	"update_goal",
	"list_scheduled_jobs",
	"schedule_job",
	"cancel_scheduled_job",
	"review_current_work",
] as const;

export type AlfredToolName = typeof ALFRED_TOOL_NAMES[number];

export const ALFRED_TOOL_PROMPT_SNIPPETS: Record<AlfredToolName, string> = {
	bash: 'bash: {"tool":"bash","command":"single-line bash command","scope":"workspace|host","cwd":"optional workspace cwd","workspaceRef":"optional","timeoutMs":30000} — scope defaults to workspace; use host only for machine-wide inspection such as macOS apps, processes, CPU, or memory, without cwd/workspaceRef',
	read_file: 'read_file: {"tool":"read_file","path":"relative or absolute path","cwd":"optional","workspaceRef":"optional"}',
	write_file: 'write_file: {"tool":"write_file","path":"...","content":"..."}',
	edit_file: 'edit_file: {"tool":"edit_file","path":"...","oldText":"exact text to replace","newText":"replacement"}',
	save_note: 'save_note: {"tool":"save_note","filename":"copyable-note.md","content":"full UTF-8 note","open":true,"overwrite":false} — saves under ~/Documents/Alfred Notes and opens it by default; always requires confirmation; no workspace needed',
	list_notes: 'list_notes: {"tool":"list_notes"} — lists the user-visible Markdown/text notes in ~/Documents/Alfred Notes',
	read_note: 'read_note: {"tool":"read_note","filename":"copyable-note.md"} — reads a saved user note by safe leaf filename',
	open_note: 'open_note: {"tool":"open_note","filename":"optional-note.md"} — opens a saved note, or the Notes folder when filename is omitted',
	web_search: 'web_search: {"tool":"web_search","query":"search query","numResults":5}',
	fetch_content: 'fetch_content: {"tool":"fetch_content","url":"https://..."}',
	remember: 'remember: {"tool":"remember","key":"fact name","value":"fact value","category":"preference|identity|context|note"}',
	recall: 'recall: {"tool":"recall","query":"terms to find","kinds":["profile","session","knowledge"],"limit":5} — unified grouped memory recall; limit is 1-10 per group; Knowledge results may be cited',
	search_knowledge: 'search_knowledge: {"tool":"search_knowledge","query":"terms to find","topK":5,"sourceId":"optional source id"} — searches imported Text/Markdown; cite returned IDs in the final citations array',
	import_knowledge: 'import_knowledge: {"tool":"import_knowledge","path":"workspace-relative .txt/.md file","title":"optional"} or {"tool":"import_knowledge","title":"required note title","content":"assistant-created note","sourceType":"note"} — persistent mutation; use only when explicitly asked',
	set_voice_settings: 'set_voice_settings: {"tool":"set_voice_settings","fishSpeed":1.1,"edgeRate":"+10%","speechStyle":"auto|neutral|warm|calm|dry|reassuring|sarcastic","witLevel":"off|light|medium","sarcasmLevel":"off|light|medium"}',
	refresh_context: 'refresh_context: {"tool":"refresh_context","forceFresh":true}',
	inspect_session: 'inspect_session: {"tool":"inspect_session","workspaceName":"Project workspace"} or {"tool":"inspect_session","workspaceRef":"workspace:11"} — workspace-only auto-inspector; add tabHint or surfaceRef to target a specific tab. maxSurfaces (1-5) controls how many tabs to inspect when running workspace-only.',
	send_session_message: 'send_session_message: {"tool":"send_session_message","workspaceName":"Project workspace","tabHint":"Pi chat","text":"message text","mode":"draft|send"} — draft writes text only; send appends Enter. Requires confirmation.',
	start_session_monitor: 'start_session_monitor: {"tool":"start_session_monitor","workspaceName":"Project workspace","tabHint":"Pi chat","goal":"what to watch for","replyMode":"draft|send","pollIntervalMs":12000,"maxTurns":6} — starts a background cmux monitor; confirmation required. draft is default; send means autonomous Enter sends.',
	poll_session_monitor: 'poll_session_monitor: {"tool":"poll_session_monitor","monitorId":"optional"} — manually poll an authorized monitor now.',
	session_monitor_status: 'session_monitor_status: {"tool":"session_monitor_status","monitorId":"optional"}',
	stop_session_monitor: 'stop_session_monitor: {"tool":"stop_session_monitor","monitorId":"optional"}',
	gmail_search: 'gmail_search: {"tool":"gmail_search","query":"from:person@example.com newer_than:7d","maxResults":10}',
	gmail_read: 'gmail_read: {"tool":"gmail_read","messageId":"message id from gmail_search"}',
	calendar_today: 'calendar_today: {"tool":"calendar_today"}',
	calendar_upcoming: 'calendar_upcoming: {"tool":"calendar_upcoming","maxResults":10}',
	docs_search: 'docs_search: {"tool":"docs_search","query":"project notes","maxResults":10}',
	docs_read: 'docs_read: {"tool":"docs_read","documentId":"doc id from docs_search"}',
	log_break: 'log_break: {"tool":"log_break"}',
	wellness_status: 'wellness_status: {"tool":"wellness_status"}',
	list_goals: 'list_goals: {"tool":"list_goals","status":"active|completed|all"} — use for natural-language questions about goals',
	create_goal: 'create_goal: {"tool":"create_goal","title":"goal","notes":"optional context"} — use when the user naturally asks to remember or track an objective',
	update_goal: 'update_goal: {"tool":"update_goal","goalIdOrTitle":"ID or exact title","title":"optional new title","notes":"optional notes","status":"active|completed"} — update or complete a goal',
	list_scheduled_jobs: 'list_scheduled_jobs: {"tool":"list_scheduled_jobs","enabledOnly":true}',
	schedule_job: 'schedule_job: {"tool":"schedule_job","kind":"reminder|work_review","title":"what to remind/review","runAt":"RFC3339 timestamp with timezone","recurrenceMinutes":15,"workspaceRef":"required for work_review","surfaceRef":"required for work_review"} — recurrence must be 15..525600 minutes; confirmation required',
	cancel_scheduled_job: 'cancel_scheduled_job: {"tool":"cancel_scheduled_job","jobId":"job ID"}',
	review_current_work: 'review_current_work: {"tool":"review_current_work"} — inspect the exact focused cmux work surface and provide evidence-grounded status/advice',
};

export function formatAlfredToolPrompt(names: readonly AlfredToolName[] = ALFRED_TOOL_NAMES): string {
	return names.map((name) => `- ${ALFRED_TOOL_PROMPT_SNIPPETS[name]}`).join("\n");
}

export type ToolRiskLevel = "read" | "external" | "mutation" | "destructive";
export type ConfirmationRequirement = "none" | "confirm" | "explicit" | "blocked";

export interface ToolExecutionContext {
	requestId: string;
	toolCallId: string;
	turnId?: string;
	/** Resolved from cmux; Alfred's process cwd/repo is never an implicit fallback. */
	cwd?: string;
	workspaceRef?: string;
	timeoutMs?: number;
	risk: ToolRiskLevel;
}

export interface ToolSafetyMetadata {
	risk: ToolRiskLevel;
	confirmation: ConfirmationRequirement;
	confirmationId?: string;
	confirmationHash?: string;
	expiresAt?: string;
	preview?: string;
	blockedReason?: string;
}

export interface ToolOutputTruncation {
	truncated: boolean;
	originalBytes?: number;
	shownBytes?: number;
	limitBytes?: number;
}

export interface ToolResult<TData = unknown> {
	toolCallId: string;
	tool: AlfredToolName;
	success: boolean;
	text: string;
	data?: TData;
	displayText?: string;
	truncation?: ToolOutputTruncation;
	retryable?: boolean;
	failure?: StructuredFailure;
	safety: ToolSafetyMetadata;
	timingMs?: number;
	cwd?: string;
	workspaceRef?: string;
}

export interface BashToolCall {
	tool: "bash";
	command: string;
	/** Workspace is the default. Host runs machine-wide inspection from a neutral temporary directory. */
	scope?: "workspace" | "host";
	cwd?: string;
	workspaceRef?: string;
	timeoutMs?: number;
	risk?: ToolRiskLevel;
	requestId?: string;
	toolCallId?: string;
}

export interface ReadFileToolCall {
	tool: "read_file";
	path: string;
	cwd?: string;
	workspaceRef?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface WriteFileToolCall {
	tool: "write_file";
	path: string;
	content: string;
	cwd?: string;
	workspaceRef?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface EditFileToolCall {
	tool: "edit_file";
	path: string;
	oldText: string;
	newText: string;
	cwd?: string;
	workspaceRef?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface SaveNoteToolCall {
	tool: "save_note";
	/** Safe leaf filename ending in .md or .txt. Notes are stored under ~/Documents/Alfred Notes. */
	filename: string;
	content: string;
	/** Open with the system default application after saving. Defaults to true. */
	open?: boolean;
	/** Existing notes are never replaced unless this exact confirmed flag is true. */
	overwrite?: boolean;
	requestId?: string;
	toolCallId?: string;
}

export interface ListNotesToolCall {
	tool: "list_notes";
	requestId?: string;
	toolCallId?: string;
}

export interface ReadNoteToolCall {
	tool: "read_note";
	filename: string;
	requestId?: string;
	toolCallId?: string;
}

export interface OpenNoteToolCall {
	tool: "open_note";
	/** Omit to open the user-visible Notes folder. */
	filename?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface WebSearchToolCall {
	tool: "web_search";
	query: string;
	numResults?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface FetchContentToolCall {
	tool: "fetch_content";
	url: string;
	requestId?: string;
	toolCallId?: string;
}
export interface RememberToolCall {
	tool: "remember";
	key: string;
	value: string;
	category?: "preference" | "identity" | "context" | "note";
	requestId?: string;
	toolCallId?: string;
}

export interface RecallToolCall {
	tool: "recall";
	query: string;
	kinds?: MemoryKind[];
	limit?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface SearchKnowledgeToolCall {
	tool: "search_knowledge";
	query: string;
	topK?: number;
	/** Compatibility alias for topK. */
	limit?: number;
	sourceId?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface ImportKnowledgeToolCall {
	tool: "import_knowledge";
	/** Workspace-relative Text/Markdown file to import. Mutually exclusive with content. */
	path?: string;
	/** Assistant-created content to save as a clearly marked knowledge source. */
	content?: string;
	title?: string;
	sourceType?: "document" | "note" | "project";
	requestId?: string;
	toolCallId?: string;
}

export interface SetVoiceSettingsToolCall {
	tool: "set_voice_settings";
	fishSpeed?: number;
	edgeRate?: string;
	speechStyle?: "auto" | "neutral" | "warm" | "calm" | "dry" | "reassuring" | "sarcastic";
	witLevel?: "off" | "light" | "medium";
	sarcasmLevel?: "off" | "light" | "medium";
	provider?: "fish" | "edge" | "macos";
	fallbackProvider?: "edge" | "macos" | "none";
	requestId?: string;
	toolCallId?: string;
}

export interface RefreshContextToolCall {
	tool: "refresh_context";
	forceFresh?: boolean;
	requestId?: string;
	toolCallId?: string;
}

export interface InspectSessionToolCall {
	tool: "inspect_session";
	workspaceName?: string;
	workspaceRef?: string;
	tabHint?: string;
	surfaceRef?: string;
	lines?: number;
	scrollback?: boolean;
	/** Max surfaces to auto-inspect when no tabHint or surfaceRef is given (1-5, default 1). */
	maxSurfaces?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface SendSessionMessageToolCall {
	tool: "send_session_message";
	workspaceName?: string;
	workspaceRef?: string;
	tabHint?: string;
	surfaceRef?: string;
	text: string;
	/** draft types the text only; send appends Enter. Defaults to draft. */
	mode?: "draft" | "send";
	requestId?: string;
	toolCallId?: string;
}

export interface StartSessionMonitorToolCall {
	tool: "start_session_monitor";
	workspaceName?: string;
	workspaceRef?: string;
	tabHint?: string;
	surfaceRef?: string;
	goal: string;
	/** draft places text in the target input buffer; send appends Enter. Defaults to draft. */
	replyMode?: "draft" | "send";
	pollIntervalMs?: number;
	maxTurns?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface PollSessionMonitorToolCall {
	tool: "poll_session_monitor";
	monitorId?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface SessionMonitorStatusToolCall {
	tool: "session_monitor_status";
	monitorId?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface StopSessionMonitorToolCall {
	tool: "stop_session_monitor";
	monitorId?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface GmailSearchToolCall {
	tool: "gmail_search";
	query: string;
	maxResults?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface GmailReadToolCall {
	tool: "gmail_read";
	messageId: string;
	requestId?: string;
	toolCallId?: string;
}

export interface CalendarTodayToolCall {
	tool: "calendar_today";
	calendarId?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface CalendarUpcomingToolCall {
	tool: "calendar_upcoming";
	calendarId?: string;
	maxResults?: number;
	timeMin?: string;
	timeMax?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface DocsSearchToolCall {
	tool: "docs_search";
	query: string;
	maxResults?: number;
	requestId?: string;
	toolCallId?: string;
}

export interface DocsReadToolCall {
	tool: "docs_read";
	documentId: string;
	requestId?: string;
	toolCallId?: string;
}

export interface WellnessStatusToolCall {
	tool: "wellness_status";
	requestId?: string;
	toolCallId?: string;
}

export interface LogBreakToolCall {
	tool: "log_break";
	requestId?: string;
	toolCallId?: string;
}

export interface ListGoalsToolCall {
	tool: "list_goals";
	status?: "active" | "completed" | "all";
	requestId?: string;
	toolCallId?: string;
}

export interface CreateGoalToolCall {
	tool: "create_goal";
	title: string;
	notes?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface UpdateGoalToolCall {
	tool: "update_goal";
	goalIdOrTitle: string;
	title?: string;
	notes?: string;
	status?: "active" | "completed";
	requestId?: string;
	toolCallId?: string;
}

export interface ListScheduledJobsToolCall {
	tool: "list_scheduled_jobs";
	enabledOnly?: boolean;
	requestId?: string;
	toolCallId?: string;
}

export interface ScheduleJobToolCall {
	tool: "schedule_job";
	kind: "reminder" | "work_review";
	title: string;
	runAt: string;
	recurrenceMinutes?: number;
	workspaceRef?: string;
	surfaceRef?: string;
	requestId?: string;
	toolCallId?: string;
}

export interface CancelScheduledJobToolCall {
	tool: "cancel_scheduled_job";
	jobId: string;
	requestId?: string;
	toolCallId?: string;
}

export interface ReviewCurrentWorkToolCall {
	tool: "review_current_work";
	requestId?: string;
	toolCallId?: string;
}

export type AlfredToolCall =
	| BashToolCall
	| ReadFileToolCall
	| WriteFileToolCall
	| EditFileToolCall
	| SaveNoteToolCall
	| ListNotesToolCall
	| ReadNoteToolCall
	| OpenNoteToolCall
	| WebSearchToolCall
	| FetchContentToolCall
	| RememberToolCall
	| RecallToolCall
	| SearchKnowledgeToolCall
	| ImportKnowledgeToolCall
	| SetVoiceSettingsToolCall
	| RefreshContextToolCall
	| InspectSessionToolCall
	| SendSessionMessageToolCall
	| StartSessionMonitorToolCall
	| PollSessionMonitorToolCall
	| SessionMonitorStatusToolCall
	| StopSessionMonitorToolCall
	| GmailSearchToolCall
	| GmailReadToolCall
	| CalendarTodayToolCall
	| CalendarUpcomingToolCall
	| DocsSearchToolCall
	| DocsReadToolCall
	| LogBreakToolCall
	| WellnessStatusToolCall
	| ListGoalsToolCall
	| CreateGoalToolCall
	| UpdateGoalToolCall
	| ListScheduledJobsToolCall
	| ScheduleJobToolCall
	| CancelScheduledJobToolCall
	| ReviewCurrentWorkToolCall;

export interface AlfredFinalSpeech {
	speech: string;
	displayText?: string;
	/** Citation IDs returned by search_knowledge during this request. */
	citations?: string[];
}

export type AlfredModelTurn = AlfredFinalSpeech | AlfredToolCall;

export interface TokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	source: "provider" | "estimate";
}

export interface SessionAccounting {
	sessionId: string;
	cumulativeInputTokens: number;
	cumulativeOutputTokens: number;
	cumulativeTotalTokens: number;
	warningThresholdTokens: number;
	handoffThresholdTokens: number;
	lastHandoffAt?: string;
}

export interface PendingConfirmation<TPayload = AlfredToolCall> {
	confirmationId: string;
	requestId: string;
	toolCallId: string;
	tool: AlfredToolName;
	risk: ToolRiskLevel;
	payload: TPayload;
	payloadHash: string;
	/** Execution context resolved when the action was presented for approval. */
	executionContext?: { cwd?: string; workspaceRef?: string; notesDirectory?: string };
	/** Process-only task state used to continue the original request after approval. */
	continuation?: {
		originalUserText: string;
		messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
		rawAssistantText: string;
		completedActions: string[];
		availableCitations: KnowledgeCitation[];
		workspaceResolution: {
			workspace?: { ref: string; name: string; cwd?: string; selected: boolean };
			cwd?: string;
			ambiguous: boolean;
			note?: string;
		};
		resolvedCwd?: string;
	};
	preview: string;
	createdAt: string;
	expiresAt: string;
}

export interface DisplaySurfaceResponse {
	/** Short spoken result only. */
	speech: string;
	/** Full detail for API/HTTP consumers. */
	displayText: string;
	/** Request-scoped, validated local knowledge citations. */
	citations?: KnowledgeCitation[];
	/** Optional short macOS notification summary; never full logs, diffs, or secrets. */
	notificationText?: string;
}

export interface WorkspaceResolutionContract {
	/** cmux ref, e.g. workspace:8. Names are display-only after boundary resolution. */
	workspaceRef?: string;
	workspaceName?: string;
	activePaneCwd?: string;
	activeRepoRoot?: string;
	/** If false, repo/file/CI mutations must not silently fall back to Alfred's repo. */
	cmuxAvailable: boolean;
	ambiguous?: boolean;
	resolutionNote?: string;
}

export interface AlfredAutonomousDefaults {
	maxToolRounds: number;
	maxRequestMs: number;
	standardBashTimeoutMs: number;
	testTimeoutMs: number;
	buildTimeoutMs: number;
	toolOutputLimitBytes: number;
	sessionWarnTokens: number;
	sessionHandoffTokens: number;
	confirmationTtlMs: number;
	destructiveConfirmationTtlMs: number;
	workspaceAliasesPath: string;
	handoffDir: string;
	webProvider: "exa";
	webDefaultResults: number;
	webMaxResults: number;
}

export const ALFRED_AUTONOMOUS_DEFAULTS: AlfredAutonomousDefaults = {
	maxToolRounds: 64,
	maxRequestMs: 10 * 60_000,
	standardBashTimeoutMs: 30_000,
	testTimeoutMs: 300_000,
	buildTimeoutMs: 300_000,
	toolOutputLimitBytes: 64 * 1024,
	sessionWarnTokens: 80_000,
	sessionHandoffTokens: 100_000,
	confirmationTtlMs: 300_000,
	destructiveConfirmationTtlMs: 60_000,
	workspaceAliasesPath: "~/.alfred/workspace-aliases.json",
	handoffDir: "~/.alfred/handoffs",
	webProvider: "exa",
	webDefaultResults: 5,
	webMaxResults: 10,
};

export const DEFERRED_ALFRED_TOOLS = [
	"subagents",
	"intercom",
	"vision_video_analysis",
	"long_running_background_workers",
] as const;

export function isRegisteredToolName(value: string, registeredTools: readonly string[] = ALFRED_TOOL_NAMES): value is AlfredToolName {
	return registeredTools.includes(value);
}
