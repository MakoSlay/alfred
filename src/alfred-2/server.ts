import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createOpenAiCompatibleLlmClient, type AgentResponse, type Alfred2AgentConfig, type LlmClient } from "./agent.ts";
import { createMinimalSystemContext, gatherSystemContext, estimateTokens } from "./context.ts";
import { buildRelevantSystemContext } from "./context-rag.ts";
import { runToolLoop } from "./tool-loop.ts";
import { speak, notify, getTtsSettings, updateTtsSettings, setSpeechSuppressionProvider, synthesizeSpeech, stopSpeech, type PublicTtsSettings, type SpeechLifecycleEvent } from "./speech.ts";
import { createHistoryStore, formatHistoryForContext, getDefaultHistoryStore } from "./history.ts";
import { clearSessionTurns, createSessionMemory, getSessionMemoryRecords } from "./memory.ts";
import { createProfileStore, getDefaultProfileStore, ProfileMemoryConflictError } from "./profile.ts";
import { createKnowledgeStore, getDefaultKnowledgeDirectory } from "./knowledge.ts";
import { MAX_MEMORY_RECALL_LIMIT, MAX_MEMORY_RECALL_QUERY_LENGTH, recallMemory } from "./memory/recall.ts";
import type { MemoryDashboardState, MemoryKind, ProfileMemoryCategory, ProfileMemoryRecord } from "./memory-types.ts";
import { serveDashboardAsset } from "./dashboard-assets.ts";
import { createAlfredEventBus, type AlfredEventBus } from "./events.ts";
import { getPersonalityConfig, type AlfredPersonalityConfig } from "./personality.ts";
import { formatSpeechForTts } from "./speech-formatter.ts";
import {
	getUndoHistory,
	undoByOriginalPath,
	undoById,
	clearUndoHistory,
} from "./undo.ts";
import { createConfirmationPreview, hashPayload, PendingConfirmationStore, ttlForRisk } from "./confirmation.ts";
import type { AlfredToolCall } from "./tool-types.ts";
import { ALFRED_TOOL_NAMES as REGISTERED_TOOLS } from "./tool-types.ts";
import type { Alfred2ListenerStatus } from "./listener-types.ts";
import { createOffListenerStatus } from "./listener-types.ts";
import { getSnapshot, restoreActiveWorkAccumulator, SAMPLE_INTERVAL_MS, startActivitySampler, stopActivitySampler } from "./activity/sampler.ts";
import { createRuntimeInterruptionState } from "./proactive/runtime-state.ts";
import { WellnessWatcher, saveFullWellnessState, loadFullWellnessState } from "./watchers/wellness.ts";
import { PrNotificationWatcher, prWatcherEnabled, prWatcherIntervalMs as resolvePrWatcherIntervalMs, type PrWatcherStatus } from "./watchers/pr-notifications.ts";
import { WorkAdvisor, DEFAULT_WORK_ADVISOR_INTERVAL_MS, shouldConsumeScheduledWorkReview } from "./watchers/work-advisor.ts";
import { GoalJobStore, ScheduledJobRunner, parseScheduledTimestamp, validRecurrenceMinutes, validWorkReviewTargetRefs } from "./goals.ts";
import { createStructuredFailure, createTaskOutcomeFinalizer, type TaskOutcome, type TaskOutcomeFinalizer } from "./capabilities/outcome.ts";
import { SessionMonitorManager } from "./session-monitor.ts";

export interface Alfred2AgentLike {
	ask(userText: string, systemContext: string): Promise<AgentResponse>;
}

export interface Alfred2Config {
	port: number;
	host: string;
	llm: Alfred2AgentConfig;
	agent?: Alfred2AgentLike;
	listenerStatus?: () => Alfred2ListenerStatus;
	/** Additive SR-0 test/integration hook. Outcomes are not persisted. */
	onTaskOutcome?: (outcome: TaskOutcome) => void;
	/** Optional isolated profile path for embedded runtimes and tests. */
	profileFile?: string;
	/** Optional isolated durable activity-history path for embedded runtimes and tests. */
	historyFile?: string;
	/** Optional isolated knowledge directory for embedded runtimes and tests. */
	knowledgeDirectory?: string;
	/** Optional isolated durable goal/job path for embedded runtimes and tests. */
	goalJobFile?: string;
	/** Optional isolated work-advisor state path for embedded runtimes and tests. */
	workAdvisorStateFile?: string;
}

export interface Alfred2ServerHandle {
	port: number;
	host: string;
	close(): Promise<void>;
}

interface DashboardRecentResponse {
	requestId?: string;
	timestamp: string;
	userText: string;
	responseText: string;
	speech: string;
	displayText?: string;
	executed: boolean;
	command?: string;
	ok?: boolean;
}

interface DashboardState {
	sessionId: string;
	muted: boolean;
	mutedUntil: string | null;
	autoConfirm: boolean;
	autoConfirmScope: "session";
	sessionMonitors: ReturnType<SessionMonitorManager["list"]>;
	sessionTokens: number;
	currentContextTokens: number;
	maxContextTokens: number;
	toolRounds: number;
	pendingConfirmations: number;
	/** Compatibility projection retained while consumers move to memory.profile.records. */
	profileFacts: ProfileMemoryRecord[];
	/** Compatibility count retained while consumers move to memory.session.count. */
	memoryTurns: number;
	memory: MemoryDashboardState;
	undoCount: number;
	undoHistory: Array<{ id: string; originalPath: string; backupPath: string; timestamp: string; tool: string; preview: string }>;
	tools: { count: number; names: string[] };
	tts: PublicTtsSettings;
	personality: AlfredPersonalityConfig;
	listener: Alfred2ListenerStatus;
	prWatcher: ({ enabled: false } | ({ enabled: true; intervalMs: number } & PrWatcherStatus));
	workAdvisor: { autonomousEnabled: boolean; workspace: string | null; intervalMs: number; status: ReturnType<WorkAdvisor["getStatus"]> };
	goals: ReturnType<GoalJobStore["listGoals"]>;
	scheduledJobs: ReturnType<GoalJobStore["listJobs"]>;
	recentResponses: DashboardRecentResponse[];
	lastUpdated: string;
}

interface DashboardToolContract {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	examples: string[];
	confirm: "none" | "confirm" | "explicit" | "mixed";
}

const TOOL_CONTRACTS: DashboardToolContract[] = [
	{
		name: "bash",
		description: "Execute a single shell command in the resolved workspace.",
		schema: {
			tool: "bash",
			command: "string",
			cwd: "optional string",
			workspaceRef: "optional string",
			timeoutMs: "optional number",
		},
		examples: [
			'{ "tool": "bash", "command": "ls -la" }',
			'{ "tool": "bash", "command": "npm run test", "timeoutMs": 30000 }',
		],
		confirm: "mixed",
	},
	{
		name: "read_file",
		description: "Read file contents from the resolved workspace path.",
		schema: {
			tool: "read_file",
			path: "string",
			cwd: "optional string",
			workspaceRef: "optional string",
		},
		examples: [
			'{ "tool": "read_file", "path": "src/index.ts" }',
		],
		confirm: "none",
	},
	{
		name: "write_file",
		description: "Write an entire file at the given path.",
		schema: {
			tool: "write_file",
			path: "string",
			content: "string",
			cwd: "optional string",
			workspaceRef: "optional string",
		},
		examples: [
			'{ "tool": "write_file", "path": "notes.txt", "content": "Hello" }',
		],
		confirm: "confirm",
	},
	{
		name: "edit_file",
		description: "Perform exact text replacements in a file (requires unique oldText matches).",
		schema: {
			tool: "edit_file",
			path: "string",
			oldText: "string",
			newText: "string",
			cwd: "optional string",
			workspaceRef: "optional string",
		},
		examples: [
			'{ "tool": "edit_file", "path": "README.md", "oldText": "Hello", "newText": "Hi" }',
		],
		confirm: "confirm",
	},
	{
		name: "web_search",
		description: "Search the web via configured provider and summarize the top results.",
		schema: {
			tool: "web_search",
			query: "string",
			numResults: "optional number",
		},
		examples: [
			'{ "tool": "web_search", "query": "latest TypeScript errors" }',
		],
		confirm: "none",
	},
	{
		name: "fetch_content",
		description: "Fetch and extract readable content from a URL.",
		schema: {
			tool: "fetch_content",
			url: "string",
		},
		examples: [
			'{ "tool": "fetch_content", "url": "https://example.com" }',
		],
		confirm: "none",
	},
	{
		name: "remember",
		description: "Persist a user fact for future context.",
		schema: {
			tool: "remember",
			key: "string",
			value: "string",
			category: "optional preference|identity|context|note",
		},
		examples: [
			'{ "tool": "remember", "key": "theme", "value": "dark", "category": "preference" }',
		],
		confirm: "none",
	},
	{
		name: "recall",
		description: "Recall matching profile, session, and Knowledge memory in grouped results.",
		schema: {
			tool: "recall",
			query: "required string",
			kinds: "optional array of profile|session|knowledge",
			limit: "optional integer 1-10 per group",
		},
		examples: [
			'{ "tool": "recall", "query": "theme" }',
			'{ "tool": "recall", "query": "launch", "kinds": ["session", "knowledge"], "limit": 5 }',
		],
		confirm: "none",
	},
	{
		name: "search_knowledge",
		description: "Search indexed local Text and Markdown sources with deterministic lexical ranking.",
		schema: {
			tool: "search_knowledge",
			query: "string",
			topK: "optional number 1-10",
			sourceId: "optional source id",
		},
		examples: [
			'{ "tool": "search_knowledge", "query": "release checklist", "topK": 5 }',
		],
		confirm: "none",
	},
	{
		name: "import_knowledge",
		description: "Import a workspace Text/Markdown file or save explicitly requested assistant-created content into local Knowledge.",
		schema: {
			tool: "import_knowledge",
			path: "workspace-relative .txt/.md path, mutually exclusive with content",
			content: "assistant-created content, mutually exclusive with path",
			title: "optional for path; required for content",
			sourceType: "optional document|note|project",
		},
		examples: [
			'{ "tool": "import_knowledge", "path": "docs/handbook.md", "title": "Team handbook" }',
			'{ "tool": "import_knowledge", "title": "Release research", "content": "# Findings\\n...", "sourceType": "note" }',
		],
		confirm: "confirm",
	},
	{
		name: "set_voice_settings",
		description: "Change Alfred voice/TTS settings such as speaking speed, tone, wit, sarcasm, provider, or fallback.",
		schema: {
			tool: "set_voice_settings",
			fishSpeed: "optional number 0.5-2.0",
			edgeRate: "optional percentage string, e.g. +10%",
			speechStyle: "optional auto|neutral|warm|calm|dry|reassuring|sarcastic",
			witLevel: "optional off|light|medium",
			sarcasmLevel: "optional off|light|medium",
			provider: "optional fish|edge|macos",
			fallbackProvider: "optional edge|macos|none",
		},
		examples: [
			'{ "tool": "set_voice_settings", "fishSpeed": 1.1, "edgeRate": "+10%" }',
			'{ "tool": "set_voice_settings", "speechStyle": "dry", "witLevel": "light" }',
		],
		confirm: "none",
	},
	{
		name: "refresh_context",
		description: "Force-refresh Alfred's workspace/git/PR/notification context when cached state may be stale.",
		schema: {
			tool: "refresh_context",
			forceFresh: "optional boolean, default true",
		},
		examples: [
			'{ "tool": "refresh_context", "forceFresh": true }',
		],
		confirm: "none",
	},
	{
		name: "inspect_session",
		description: "Inspect a cmux workspace or specific tab. Workspace-only mode auto-picks the best tab(s); add tabHint or surfaceRef to target a specific tab.",
		schema: {
			tool: "inspect_session",
			workspaceName: "optional workspace display name",
			workspaceRef: "optional workspace ref, e.g. workspace:11",
			tabHint: "optional tab/surface title hint",
			surfaceRef: "optional surface ref, e.g. surface:29",
			lines: "optional number 20-1000, default 160",
			scrollback: "optional boolean, default true",
			maxSurfaces: "optional number 1-5, default 1. How many tabs to inspect in workspace-only mode.",
		},
		examples: [
			'{ "tool": "inspect_session", "workspaceName": "Collectors Survey" }',
			'{ "tool": "inspect_session", "workspaceRef": "workspace:11" }',
			'{ "tool": "inspect_session", "workspaceName": "kpi-strings", "maxSurfaces": 2 }',
			'{ "tool": "inspect_session", "workspaceName": "Collectors Survey", "tabHint": "local CI runs", "lines": 160 }',
			'{ "tool": "inspect_session", "workspaceRef": "workspace:11", "surfaceRef": "surface:29", "lines": 160 }',
		],
		confirm: "none",
	},
	{
		name: "send_session_message",
		description: "Draft or send a one-off text message into a targeted cmux tab. Requires confirmation before execution.",
		schema: {
			tool: "send_session_message",
			workspaceName: "optional workspace display name",
			workspaceRef: "optional workspace ref, e.g. workspace:11",
			tabHint: "optional tab/surface title hint; required unless surfaceRef is provided",
			surfaceRef: "optional surface ref, e.g. surface:29; required unless tabHint is provided",
			text: "message text to type",
			mode: "optional draft|send, default draft. send appends Enter.",
		},
		examples: [
			'{ "tool": "send_session_message", "workspaceName": "Collectors Survey", "tabHint": "Pi chat", "text": "I am checking this now.", "mode": "draft" }',
			'{ "tool": "send_session_message", "workspaceRef": "workspace:11", "surfaceRef": "surface:29", "text": "Done.", "mode": "send" }',
		],
		confirm: "confirm",
	},
	{
		name: "start_session_monitor",
		description: "Start a background monitor for a targeted cmux tab. Default behavior drafts replies for review; autonomous send requires replyMode send and explicit confirmation.",
		schema: {
			tool: "start_session_monitor",
			workspaceName: "optional workspace display name",
			workspaceRef: "optional workspace ref, e.g. workspace:11",
			tabHint: "optional tab/surface title hint; required unless surfaceRef is provided",
			surfaceRef: "optional surface ref, e.g. surface:29; required unless tabHint is provided",
			goal: "monitoring goal/instructions",
			replyMode: "optional draft|send, default draft",
			pollIntervalMs: "optional number 1000-600000, default 12000",
			maxTurns: "optional number 1-24, default 6",
		},
		examples: [
			'{ "tool": "start_session_monitor", "workspaceName": "Collectors Survey", "tabHint": "Pi chat", "goal": "Watch for a direct question and draft a concise reply.", "replyMode": "draft" }',
			'{ "tool": "start_session_monitor", "workspaceRef": "workspace:11", "surfaceRef": "surface:29", "goal": "Answer simple status questions.", "replyMode": "send" }',
		],
		confirm: "mixed",
	},
	{
		name: "poll_session_monitor",
		description: "Poll an authorized session monitor immediately instead of waiting for its timer.",
		schema: { tool: "poll_session_monitor", monitorId: "optional monitor id" },
		examples: ['{ "tool": "poll_session_monitor" }'],
		confirm: "none",
	},
	{
		name: "session_monitor_status",
		description: "Read current cmux session monitor status.",
		schema: { tool: "session_monitor_status", monitorId: "optional monitor id" },
		examples: ['{ "tool": "session_monitor_status" }'],
		confirm: "none",
	},
	{
		name: "stop_session_monitor",
		description: "Stop an active cmux session monitor.",
		schema: { tool: "stop_session_monitor", monitorId: "optional monitor id" },
		examples: ['{ "tool": "stop_session_monitor" }'],
		confirm: "none",
	},
	{
		name: "gmail_search",
		description: "Search Gmail read-only using Gmail search syntax and return message IDs plus metadata.",
		schema: { tool: "gmail_search", query: "string", maxResults: "optional number 1-20" },
		examples: ['{ "tool": "gmail_search", "query": "newer_than:7d", "maxResults": 10 }'],
		confirm: "none",
	},
	{
		name: "gmail_read",
		description: "Read a Gmail message by ID from gmail_search.",
		schema: { tool: "gmail_read", messageId: "string" },
		examples: ['{ "tool": "gmail_read", "messageId": "18fabc123" }'],
		confirm: "none",
	},
	{
		name: "calendar_today",
		description: "Read today's Google Calendar events from the primary calendar unless calendarId is provided.",
		schema: { tool: "calendar_today", calendarId: "optional string" },
		examples: ['{ "tool": "calendar_today" }'],
		confirm: "none",
	},
	{
		name: "calendar_upcoming",
		description: "Read upcoming Google Calendar events.",
		schema: { tool: "calendar_upcoming", calendarId: "optional string", maxResults: "optional number 1-50", timeMin: "optional ISO string", timeMax: "optional ISO string" },
		examples: ['{ "tool": "calendar_upcoming", "maxResults": 10 }'],
		confirm: "none",
	},
	{
		name: "docs_search",
		description: "Search Google Docs via Drive metadata/full-text search and return document IDs.",
		schema: { tool: "docs_search", query: "string", maxResults: "optional number 1-20" },
		examples: ['{ "tool": "docs_search", "query": "project notes" }'],
		confirm: "none",
	},
	{
		name: "docs_read",
		description: "Read text content from a Google Doc by document ID.",
		schema: { tool: "docs_read", documentId: "string" },
		examples: ['{ "tool": "docs_read", "documentId": "1AbCdEf..." }'],
		confirm: "none",
	},
	{
		name: "wellness_status",
		description: "Read current wellness state: work minutes, break timer, last break, meal reminders.",
		schema: { tool: "wellness_status" },
		examples: [
			'{ "tool": "wellness_status" }',
		],
		confirm: "none",
	},
	{
		name: "log_break",
		description: "Log that the user took a break. Resets the active work timer and records the break timestamp.",
		schema: { tool: "log_break" },
		examples: [
			'{ "tool": "log_break" }',
		],
		confirm: "none",
	},
	{
		name: "list_goals",
		description: "List durable goals, optionally filtered by status.",
		schema: { tool: "list_goals", status: "optional active|completed|all" },
		examples: ['{ "tool": "list_goals", "status": "active" }'],
		confirm: "none",
	},
	{
		name: "create_goal",
		description: "Create a durable goal from a natural-language objective.",
		schema: { tool: "create_goal", title: "string", notes: "optional string" },
		examples: ['{ "tool": "create_goal", "title": "Ship Work Radar" }'],
		confirm: "none",
	},
	{
		name: "update_goal",
		description: "Update or complete a durable goal by ID or exact title.",
		schema: { tool: "update_goal", goalIdOrTitle: "string", title: "optional string", notes: "optional string", status: "optional active|completed" },
		examples: ['{ "tool": "update_goal", "goalIdOrTitle": "Ship Work Radar", "status": "completed" }'],
		confirm: "none",
	},
	{
		name: "list_scheduled_jobs",
		description: "List durable reminders and scheduled work reviews.",
		schema: { tool: "list_scheduled_jobs", enabledOnly: "optional boolean" },
		examples: ['{ "tool": "list_scheduled_jobs", "enabledOnly": true }'],
		confirm: "none",
	},
	{
		name: "schedule_job",
		description: "Schedule a bounded reminder or work review. Never executes arbitrary commands.",
		schema: { tool: "schedule_job", kind: "reminder|work_review", title: "string", runAt: "RFC3339 timestamp with explicit timezone", recurrenceMinutes: "optional integer 15..525600", workspaceRef: "required for work_review", surfaceRef: "required for work_review" },
		examples: ['{ "tool": "schedule_job", "kind": "reminder", "title": "Check CI", "runAt": "2026-07-16T16:00:00Z" }'],
		confirm: "confirm",
	},
	{
		name: "cancel_scheduled_job",
		description: "Cancel a durable scheduled job by ID.",
		schema: { tool: "cancel_scheduled_job", jobId: "string" },
		examples: ['{ "tool": "cancel_scheduled_job", "jobId": "job-example" }'],
		confirm: "none",
	},
	{
		name: "review_current_work",
		description: "Review the exact focused cmux work surface for evidence-grounded status or advice.",
		schema: { tool: "review_current_work" },
		examples: ['{ "tool": "review_current_work" }'],
		confirm: "none",
	},
];

export async function startAlfred2(config: Alfred2Config): Promise<Alfred2ServerHandle> {
	if (!isLoopbackHost(config.host)) throw new Error(`Alfred 2 must bind to a loopback host, not ${config.host}.`);
	const llmClient = config.llm.llmClient ?? (config.agent ? createAgentBackedLlmClient(config.agent) : createOpenAiCompatibleLlmClient(config.llm));
	const sessionId = `session-${randomUUID()}`;
	const sessionMemory = createSessionMemory();
	const profileStore = config.profileFile ? createProfileStore(config.profileFile) : getDefaultProfileStore();
	const knowledgeStore = createKnowledgeStore(config.knowledgeDirectory ?? (config.profileFile ? join(dirname(config.profileFile), "knowledge") : getDefaultKnowledgeDirectory()));
	const historyStore = config.historyFile ? createHistoryStore(config.historyFile) : getDefaultHistoryStore();
	const { loadHistory, addHistoryEntry, getRecentHistory, searchHistory, saveHistory } = historyStore;
	const goalJobStore = new GoalJobStore({ path: config.goalJobFile ?? (config.historyFile ? join(dirname(config.historyFile), "goals-and-jobs.json") : undefined) });
	const confirmationStore = new PendingConfirmationStore<AlfredToolCall>();
	const sessionMonitorManager = new SessionMonitorManager({ llmClient });
	const eventBus = createAlfredEventBus();
	let autoConfirm = false;
	let mutedUntil: string | null = null;
	let toolRoundTotal = 0;

	// Load persisted command history
	loadHistory();

	// Load persisted wellness state: restore work accumulator and break timers across restarts.
	const savedWellness = loadFullWellnessState();
	restoreActiveWorkAccumulator(savedWellness.activeWorkAccumulatedMs);

	// Save history on shutdown. Keep handler refs so embedded/test server closes do not leak listeners.
	const saveHistoryOnSignal = () => saveHistory();
	process.on("SIGTERM", saveHistoryOnSignal);
	process.on("SIGINT", saveHistoryOnSignal);
	process.on("beforeExit", saveHistoryOnSignal);

	// Also save history periodically so we don't lose entries on hard kill
	const historySaveInterval = setInterval(saveHistory, 10_000);
	historySaveInterval.unref();

	function isMuted(): boolean {
		if (mutedUntil && mutedUntil <= new Date().toISOString()) {
			mutedUntil = null;
		}
		return mutedUntil !== null;
	}

	setSpeechSuppressionProvider(() => {
		if (isMuted()) return { suppressed: true, reason: "muted", pause: false };
		if (isMicrophoneActive()) return { suppressed: true, reason: "microphone_active", pause: true };
		return { suppressed: false };
	});
	const wellnessWatcher = new WellnessWatcher({
		delivery: { speak, notify, isMuted },
		initialBreakPending: savedWellness.breakPending,
		initialBreakSnoozedUntil: savedWellness.breakSnoozedUntil,
		initialLastBreakAcknowledgedAt: savedWellness.persistent.lastBreakAcknowledgedAt,
	});
	const prWatchEnabled = prWatcherEnabled();
	const prWatchIntervalMs = resolvePrWatcherIntervalMs();
	const prWatcher = prWatchEnabled
		? new PrNotificationWatcher({ delivery: { speak, notify, isMuted } })
		: null;
	const runtimeInterruptionState = () => createRuntimeInterruptionState({ muted: isMuted(), mutedUntil, activitySnapshot: getSnapshot() });
	const workAdvisorWorkspace = process.env.ALFRED_WORK_ADVISOR_WORKSPACE?.trim();
	const workAdvisorRequested = /^(1|true|yes|on)$/i.test(process.env.ALFRED_WORK_ADVISOR ?? "");
	const workAdvisorAutonomousEnabled = workAdvisorRequested && Boolean(workAdvisorWorkspace);
	if (workAdvisorRequested && !workAdvisorWorkspace) console.warn("[work-advisor] background observation requires ALFRED_WORK_ADVISOR_WORKSPACE to scope the grant.");
	const workAdvisorIntervalMs = Math.max(60_000, Number.parseInt(process.env.ALFRED_WORK_ADVISOR_INTERVAL_MS ?? "", 10) || DEFAULT_WORK_ADVISOR_INTERVAL_MS);
	// The advisor is always available for explicit, confirmation-scoped requests.
	// Only periodic background observation is controlled by ALFRED_WORK_ADVISOR.
	const workAdvisor = new WorkAdvisor({ llmClient, delivery: { speak, notify, isMuted }, runtime: runtimeInterruptionState, history: () => getRecentHistory(5), statePath: config.workAdvisorStateFile ?? (config.historyFile ? join(dirname(config.historyFile), "work-advisor-state.json") : undefined) });
	const scheduledJobRunner = new ScheduledJobRunner({
		store: goalJobStore,
		delivery: { speak, notify, isMuted },
		runtime: runtimeInterruptionState,
		onWorkReview: async (job) => shouldConsumeScheduledWorkReview(await workAdvisor.tick({ targetWorkspace: job.workspaceRef, targetSurface: job.surfaceRef })),
	});
	let prWatchInFlight = false;
	let workAdvisorInFlight = false;
	startActivitySampler();
	const wellnessInterval = setInterval(() => {
		const snapshot = getSnapshot();
		const runtime = createRuntimeInterruptionState({
			muted: isMuted(),
			mutedUntil,
			activitySnapshot: snapshot,
		});
		wellnessWatcher.tick({ snapshot, runtime }).then((result) => {
			saveFullWellnessState(undefined, {
				persistent: result.persistentState,
				breakPending: result.state.breakPending,
				breakSnoozedUntil: result.state.breakSnoozedUntil,
				lastBreakAcknowledgedAt: result.state.lastBreakAcknowledgedAt,
				activeWorkAccumulatedMs: snapshot.activeWorkAccumulatedMs,
			});
		}).catch(() => {});
	}, SAMPLE_INTERVAL_MS);
	wellnessInterval.unref();

	function saveWellnessNow(): void {
		const ws = wellnessWatcher.getState();
		const ps = wellnessWatcher.getPersistentState();
		saveFullWellnessState(undefined, {
			persistent: ps,
			breakPending: ws.breakPending,
			breakSnoozedUntil: ws.breakSnoozedUntil,
			lastBreakAcknowledgedAt: ws.lastBreakAcknowledgedAt,
			activeWorkAccumulatedMs: getSnapshot().activeWorkAccumulatedMs,
		});
	}

	async function tickPrWatcher(): Promise<void> {
		if (!prWatcher || prWatchInFlight) return;
		prWatchInFlight = true;
		try {
			const snapshot = getSnapshot();
			const runtime = createRuntimeInterruptionState({
				muted: isMuted(),
				mutedUntil,
				activitySnapshot: snapshot,
			});
			await prWatcher.tick({ runtime });
		} finally {
			prWatchInFlight = false;
		}
	}

	const prWatchInterval = prWatcher
		? setInterval(() => { void tickPrWatcher(); }, prWatchIntervalMs)
		: null;
	prWatchInterval?.unref();
	if (prWatcher) void tickPrWatcher();
	const scheduledJobInterval = setInterval(() => { void scheduledJobRunner.tick().catch(() => {}); }, 30_000);
	scheduledJobInterval.unref();
	void scheduledJobRunner.tick().catch(() => {});
	const workAdvisorInterval = workAdvisorAutonomousEnabled ? setInterval(() => {
		if (workAdvisorInFlight) return;
		workAdvisorInFlight = true;
		void workAdvisor.tick({ targetWorkspace: workAdvisorWorkspace }).catch(() => {}).finally(() => { workAdvisorInFlight = false; });
	}, workAdvisorIntervalMs) : null;
	workAdvisorInterval?.unref();

	function buildDashboardState(): DashboardState {
		const profile = profileStore.loadProfile();
		const profileRecords: ProfileMemoryRecord[] = profile.facts.map((fact) => ({
			id: fact.id,
			kind: "profile",
			key: fact.key,
			value: fact.value,
			category: fact.category,
			createdAt: fact.createdAt,
			updatedAt: fact.updatedAt,
			provenance: { ...fact.provenance },
		}));
		const sessionRecords = getSessionMemoryRecords(sessionMemory);
		const knowledgeSources = knowledgeStore.listSources();
		const undoHistory = getUndoHistory();
		const recentResponses = getRecentHistory(8)
			.filter((entry) => (entry.displayText || entry.speech || "").trim().length > 0)
			.map((entry) => ({
				requestId: entry.requestId,
				timestamp: entry.timestamp,
				userText: entry.userText,
				responseText: entry.displayText || entry.speech,
				speech: entry.speech,
				displayText: entry.displayText,
				executed: entry.executed,
				command: entry.command,
				ok: entry.ok,
			}));
		isMuted();
		return {
			sessionId,
			muted: mutedUntil !== null,
			mutedUntil,
			autoConfirm,
			autoConfirmScope: "session",
			sessionMonitors: sessionMonitorManager.list(),
			sessionTokens: sessionMemory.cumulativeTotalTokens,
			currentContextTokens: sessionMemory.currentContextTokens,
			maxContextTokens: sessionMemory.maxContextTokens,
			toolRounds: toolRoundTotal,
			pendingConfirmations: confirmationStore.count(),
			profileFacts: profileRecords,
			memoryTurns: sessionRecords.length,
			memory: {
				profile: { persistent: true, count: profileRecords.length, records: profileRecords },
				session: {
					ephemeral: true,
					count: sessionRecords.length,
					records: sessionRecords,
					currentContextTokens: sessionMemory.currentContextTokens,
					cumulativeTotalTokens: sessionMemory.cumulativeTotalTokens,
				},
				knowledge: { persistent: true, available: true, count: knowledgeSources.length, sources: knowledgeSources },
			},
			undoCount: undoHistory.length,
			undoHistory,
			tools: {
				count: REGISTERED_TOOLS.length,
				names: [...REGISTERED_TOOLS],
			},
			tts: getTtsSettings(),
			personality: getPersonalityConfig(),
			listener: config.listenerStatus?.() ?? createOffListenerStatus(),
			prWatcher: prWatcher ? { enabled: true, intervalMs: prWatchIntervalMs, ...prWatcher.getStatus() } : { enabled: false },
			workAdvisor: { autonomousEnabled: workAdvisorAutonomousEnabled, workspace: workAdvisorWorkspace ?? null, intervalMs: workAdvisorIntervalMs, status: workAdvisor.getStatus() },
			goals: goalJobStore.listGoals(),
			scheduledJobs: goalJobStore.listJobs(),
			recentResponses,
			lastUpdated: new Date().toISOString(),
		};
	}

	function notifyAction(message: string): void {
		notify("Alfred", message).catch(() => {});
	}

	function isMicrophoneActive(): boolean {
		return getSnapshot().microphoneState === "active";
	}

	function stripSpeechIfMuted(response: { speech: string; displayText: string }): { speech: string; displayText: string } {
		if (isMuted()) {
			return { speech: "", displayText: `[muted] ${response.displayText}` };
		}
		return response;
	}

	async function handleMute(durationMs: number): Promise<{ speech: string; displayText: string }> {
		if (durationMs <= 0 || durationMs > 24 * 3600 * 1000) {
			return { speech: "", displayText: "Mute duration must be between 1 second and 24 hours." };
		}
		mutedUntil = new Date(Date.now() + durationMs).toISOString();
		const minutes = Math.round(durationMs / 60000);
		const speech = `Muted for ${minutes} minute${minutes === 1 ? "" : "s"}.`;
		return { speech, displayText: speech };
	}

	async function handleUnmute(): Promise<{ speech: string; displayText: string }> {
		const wasMuted = mutedUntil !== null;
		mutedUntil = null;
		const msg = wasMuted ? "Unmuted. I'll speak again." : "I wasn't muted.";
		return { speech: msg, displayText: msg };
	}

	async function handleMuteStatus(): Promise<{ speech: string; displayText: string; muted: boolean; mutedUntil: string | null }> {
		isMuted();
		if (!mutedUntil) {
			return { speech: "", displayText: "Not muted.", muted: false, mutedUntil: null };
		}
		const remainingMs = Math.max(0, new Date(mutedUntil).getTime() - Date.now());
		const remainingMin = Math.ceil(remainingMs / 60000);
		const msg = `Muted for another ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.`;
		return { speech: msg, displayText: msg, muted: true, mutedUntil };
	}

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.host}`);
		const stateChanging = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
		const privateRead = url.pathname === "/dashboard/state" || isPrivateApiPath(url.pathname) || url.pathname === "/api/goals" || url.pathname === "/api/scheduled-jobs";
		if ((stateChanging || privateRead) && !isAllowedLocalOrigin(req.headers.origin)) {
			res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: false, error: "State-changing and private API requests must originate from a loopback origin." }));
			return;
		}

		// Health
		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, health: "ok" }));
			return;
		}

		// Live events are ephemeral. Dashboard state remains the hydration/reconnect authority.
		if (req.method === "GET" && url.pathname === "/api/events") {
			eventBus.subscribe(res);
			return;
		}

		// Tool contract endpoint (must be checked before dashboard pages)
		if (req.method === "GET" && url.pathname === "/tools") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: true,
				count: TOOL_CONTRACTS.length,
				names: REGISTERED_TOOLS,
				contracts: TOOL_CONTRACTS,
			}));
			return;
		}

		// Dashboard state polling endpoint
		if (req.method === "GET" && url.pathname === "/dashboard/state") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, ...buildDashboardState() }));
			return;
		}

		if (req.method === "PUT" && url.pathname === "/api/settings/autonomy") {
			const body = await readJsonBody(req);
			if (typeof body?.autoConfirm !== "boolean" || Object.keys(body).some((key) => key !== "autoConfirm")) {
				throw new HttpRequestError(400, "autoConfirm must be the only field and must be a boolean.");
			}
			autoConfirm = body.autoConfirm;
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, autoConfirm, scope: "session" }));
			return;
		}

		// Runtime TTS controls. API keys stay in the daemon environment; the dashboard only edits non-secret voice settings.
		if (req.method === "GET" && url.pathname === "/dashboard/tts") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, tts: getTtsSettings() }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/dashboard/tts") {
			const body = await readJsonBody(req);
			const tts = updateTtsSettings(body ?? {});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, tts }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/dashboard/tts/test") {
			const body = await readJsonBody(req);
			const text = typeof body?.text === "string" && body.text.trim() ? body.text.trim() : "Certainly, sir. Alfred voice systems are online.";
			const ok = await speak(text);
			res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok, tts: getTtsSettings(), error: ok ? undefined : "No TTS provider succeeded." }));
			return;
		}

		// Browser voice API. Compatibility dashboard TTS routes above remain supported.
		if (req.method === "GET" && url.pathname === "/api/voice/settings") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, tts: getTtsSettings() }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/voice/settings") {
			const body = await readJsonBody(req);
			const tts = updateTtsSettings(body ?? {});
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, tts }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/voice/synthesize") {
			const body = await readJsonBody(req);
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			const requestId = typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : `req-${randomUUID()}`;
			if (!text) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, requestId, error: "text is required" }));
				return;
			}
			try {
				const synthesized = await synthesizeSpeech(text, {
					onEvent: (event) => publishSpeechEvent(eventBus, requestId, event),
				});
				res.writeHead(200, {
					"Content-Type": synthesized.contentType,
					"Content-Length": synthesized.audio.length,
					"Cache-Control": "no-store",
					"X-Alfred-TTS-Provider": synthesized.provider,
				});
				res.end(synthesized.audio);
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, requestId, error: message }));
			}
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/voice/stop") {
			stopSpeech();
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		// Built React dashboard. Keep all /dashboard API routes above this static surface.
		if (req.method === "GET" && serveDashboardAsset(url.pathname, res)) {
			return;
		}

		// Undo restore endpoint
		if (req.method === "POST") {
			const undoMatch = url.pathname.match(/^\/dashboard\/undo\/([^/]+)$/);
			if (undoMatch) {
				const id = decodeURIComponent(undoMatch[1] ?? "");
				const restored = undoById(id);
				if (restored) {
					notifyAction(`Restored ${restored.originalPath} from undo entry ${restored.id}.`);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: true,
						restored: true,
						tool: restored.tool,
						id: restored.id,
						originalPath: restored.originalPath,
					}));
				} else {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Undo entry not found or backup missing." }));
				}
				return;
			}
		}

		// Undo clear-all endpoint
		if (req.method === "DELETE" && url.pathname === "/dashboard/undo") {
			const removed = clearUndoHistory();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, removed }));
			return;
		}

		// Add profile fact
		if (req.method === "POST" && url.pathname === "/dashboard/facts") {
			const body = await readJsonBody(req);
			const key = typeof body?.key === "string" ? body.key.trim() : "";
			const value = typeof body?.value === "string" ? body.value.trim() : "";
			const category = typeof body?.category === "string" ? body.category.trim() || undefined : undefined;
			if (!key || !value) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "key and value are required" }));
				return;
			}
			const normalizedCategory = category as "preference" | "identity" | "context" | "note" | undefined;
			if (normalizedCategory !== undefined && !["preference", "identity", "context", "note"].includes(normalizedCategory)) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "Invalid category." }));
				return;
			}
			const fact = profileStore.rememberProfileMemory(
				{ key, value, category: normalizedCategory },
				{
					source: "manual",
					sourceId: "dashboard",
					requestId: typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : undefined,
					timestamp: new Date().toISOString(),
				},
			);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, fact }));
			return;
		}

		// Stable-ID profile edits use optimistic concurrency so a stale dashboard
		// cannot overwrite a newer manual or tool-authored fact.
		if (req.method === "PATCH") {
			const factMatch = url.pathname.match(/^\/(?:api\/memory\/profile|dashboard\/facts)\/([^/]+)$/);
			if (factMatch) {
				const body = await readJsonBody(req);
				const allowed = new Set(["key", "value", "category", "expectedUpdatedAt"]);
				if (!body || Object.keys(body).some((key) => !allowed.has(key)) || typeof body.expectedUpdatedAt !== "string" || !body.expectedUpdatedAt.trim()) {
					throw new HttpRequestError(400, "expectedUpdatedAt is required and only key, value, category, and expectedUpdatedAt are supported.");
				}
				if (body.key === undefined && body.value === undefined && body.category === undefined) throw new HttpRequestError(400, "At least one profile memory field must be updated.");
				if (body.key !== undefined && (typeof body.key !== "string" || !body.key.trim())) throw new HttpRequestError(400, "Profile memory key must be a non-empty string.");
				if (body.value !== undefined && (typeof body.value !== "string" || !body.value.trim())) throw new HttpRequestError(400, "Profile memory value must be a non-empty string.");
				if (body.category !== undefined && !["preference", "identity", "context", "note"].includes(String(body.category))) throw new HttpRequestError(400, "Invalid category.");
				try {
					const fact = profileStore.updateProfileMemory(
						decodePathSegment(factMatch[1] ?? ""),
						{
							key: typeof body.key === "string" ? body.key : undefined,
							value: typeof body.value === "string" ? body.value : undefined,
							category: body.category as ProfileMemoryCategory | undefined,
						},
						body.expectedUpdatedAt,
						{ source: "manual", sourceId: "dashboard", timestamp: new Date().toISOString() },
					);
					res.writeHead(fact ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify(fact ? { ok: true, fact } : { ok: false, error: "Profile memory not found." }));
				} catch (cause) {
					if (!(cause instanceof ProfileMemoryConflictError)) throw cause;
					res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, code: cause.code, error: cause.message }));
				}
				return;
			}
		}

		// Profile deletion removes only the fact with this stable ID.
		if (req.method === "DELETE") {
			const factMatch = url.pathname.match(/^\/(?:api\/memory\/profile|dashboard\/facts)\/([^/]+)$/);
			if (factMatch) {
				const id = decodePathSegment(factMatch[1] ?? "");
				const removed = profileStore.forgetProfileMemory(id);
				res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify(removed
					? { ok: true, removed: true, id }
					: { ok: false, removed: false, error: "Profile memory not found." }));
				return;
			}
		}

		if (req.method === "DELETE" && url.pathname === "/api/memory/session") {
			const removed = clearSessionTurns(sessionMemory);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({
				ok: true,
				removed,
				session: {
					count: sessionMemory.turns.length,
					currentContextTokens: sessionMemory.currentContextTokens,
					cumulativeTotalTokens: sessionMemory.cumulativeTotalTokens,
				},
				retained: ["token accounting", "activity history", "handoffs", "profile memory", "knowledge sources"],
			}));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/memory/recall") {
			const body = await readJsonBody(req);
			if (!body || Object.keys(body).some((key) => !["query", "kinds", "limit"].includes(key))) throw new HttpRequestError(400, "Only query, kinds, and limit are supported.");
			const query = typeof body.query === "string" ? body.query.trim() : "";
			if (!query) throw new HttpRequestError(400, "query is required");
			if (query.length > MAX_MEMORY_RECALL_QUERY_LENGTH) throw new HttpRequestError(400, `query must be at most ${MAX_MEMORY_RECALL_QUERY_LENGTH} characters`);
			if (body?.kinds !== undefined && (!Array.isArray(body.kinds) || body.kinds.length === 0 || body.kinds.some((kind) => !["profile", "session", "knowledge"].includes(String(kind))))) throw new HttpRequestError(400, "kinds must be a non-empty array containing profile, session, or knowledge");
			if (body?.limit !== undefined && (!Number.isInteger(body.limit) || typeof body.limit !== "number" || body.limit < 1 || body.limit > MAX_MEMORY_RECALL_LIMIT)) throw new HttpRequestError(400, `limit must be an integer from 1 to ${MAX_MEMORY_RECALL_LIMIT}`);
			try {
				const result = recallMemory({ query, kinds: body?.kinds as MemoryKind[] | undefined, limit: body?.limit as number | undefined }, { profile: profileStore, session: sessionMemory, knowledge: knowledgeStore });
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true, ...result }));
			} catch (cause) {
				logPrivateMemoryFailure("api-recall", cause);
				res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "Memory recall is temporarily unavailable." }));
			}
			return;
		}

		// Import Text/Markdown into the local lexical knowledge index. The /api/memory
		// routes are canonical; dashboard aliases remain convenient for existing clients.
		if (req.method === "GET" && (url.pathname === "/api/memory/knowledge/sources" || url.pathname === "/dashboard/knowledge/sources")) {
			const sources = knowledgeStore.listSources();
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, count: sources.length, sources }));
			return;
		}

		if (req.method === "POST" && (url.pathname === "/api/memory/knowledge/sources" || url.pathname === "/dashboard/knowledge/sources")) {
			const body = await readKnowledgeJsonBody(req);
			if (body?.sourceType !== undefined && !["document", "note", "project"].includes(String(body.sourceType))) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "Invalid knowledge source type." }));
				return;
			}
			try {
				const result = knowledgeStore.ingest({
					title: typeof body?.title === "string" ? body.title : "",
					content: typeof body?.content === "string" ? body.content : "",
					sourceType: body?.sourceType === "note" || body?.sourceType === "project" ? body.sourceType : "document",
					location: typeof body?.location === "string" ? body.location : undefined,
					mimeType: typeof body?.mimeType === "string" ? body.mimeType : undefined,
				});
				res.writeHead(result.created ? 201 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true, ...result }));
			} catch (cause) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
			}
			return;
		}

		if (req.method === "DELETE") {
			const sourceMatch = url.pathname.match(/^\/(?:api\/memory|dashboard)\/knowledge\/sources\/([^/]+)$/);
			if (sourceMatch) {
				const id = decodePathSegment(sourceMatch[1] ?? "");
				const removed = knowledgeStore.deleteSource(id);
				res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify(removed ? { ok: true, removed: true, id } : { ok: false, removed: false, error: "Knowledge source not found." }));
				return;
			}
		}

		if (req.method === "POST") {
			const reindexMatch = url.pathname.match(/^\/(?:api\/memory|dashboard)\/knowledge\/sources\/([^/]+)\/reindex$/);
			if (reindexMatch) {
				const id = decodePathSegment(reindexMatch[1] ?? "");
				const body = await readKnowledgeJsonBody(req);
				try {
					const source = knowledgeStore.reindexSource(id, typeof body?.content === "string" ? body.content : undefined);
					res.writeHead(source ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify(source ? { ok: true, source } : { ok: false, error: "Knowledge source not found." }));
				} catch (cause) {
					res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
				}
				return;
			}
		}

		if (req.method === "POST" && (url.pathname === "/api/memory/knowledge/search" || url.pathname === "/dashboard/knowledge/search")) {
			const body = await readKnowledgeJsonBody(req);
			const query = typeof body?.query === "string" ? body.query.trim() : "";
			if (!query) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "query is required" }));
				return;
			}
			const matches = knowledgeStore.search(query, {
				limit: typeof body?.limit === "number" ? body.limit : undefined,
				sourceId: typeof body?.sourceId === "string" ? body.sourceId : undefined,
			});
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, query, matches }));
			return;
		}

		// Durable goals and bounded scheduled jobs. Jobs can remind or request a
		// work-advisor review; they can never execute arbitrary commands/tools.
		if (req.method === "GET" && url.pathname === "/api/goals") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, store: goalJobStore.getStatus(), goals: goalJobStore.listGoals() }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/goals") {
			const body = await readJsonBody(req);
			try {
				const goal = goalJobStore.createGoal(typeof body?.title === "string" ? body.title : "", typeof body?.notes === "string" ? body.notes : undefined);
				res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true, goal }));
			} catch (cause) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
			}
			return;
		}

		if (req.method === "PATCH") {
			const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
			if (goalMatch) {
				const body = await readJsonBody(req);
				try {
					const status = body?.status === "active" || body?.status === "completed" ? body.status : undefined;
					const goal = goalJobStore.updateGoal(decodeURIComponent(goalMatch[1] ?? ""), {
						title: typeof body?.title === "string" ? body.title : undefined,
						notes: typeof body?.notes === "string" ? body.notes : undefined,
						status,
					});
					res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: true, goal }));
				} catch (cause) {
					res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
				}
				return;
			}
		}

		if (req.method === "GET" && url.pathname === "/api/scheduled-jobs") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, store: goalJobStore.getStatus(), jobs: goalJobStore.listJobs() }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/scheduled-jobs") {
			const body = await readJsonBody(req);
			try {
				if (body?.kind !== "reminder" && body?.kind !== "work_review") throw new Error("kind must be reminder or work_review.");
				if (typeof body.title !== "string" || !body.title.trim()) throw new Error("title is required.");
				if (typeof body.runAt !== "string" || !parseScheduledTimestamp(body.runAt)) throw new Error("runAt must be an RFC3339 timestamp with an explicit timezone.");
				if (body.recurrenceMinutes !== undefined && (typeof body.recurrenceMinutes !== "number" || !validRecurrenceMinutes(body.recurrenceMinutes))) throw new Error("recurrenceMinutes is outside the supported range.");
				if (body.kind === "work_review" && !validWorkReviewTargetRefs(typeof body.workspaceRef === "string" ? body.workspaceRef : undefined, typeof body.surfaceRef === "string" ? body.surfaceRef : undefined)) throw new Error("work_review requires exact workspaceRef and surfaceRef values.");
				const toolCall: AlfredToolCall = {
					tool: "schedule_job",
					kind: body.kind,
					title: typeof body.title === "string" ? body.title : "",
					runAt: typeof body.runAt === "string" ? body.runAt : "",
					recurrenceMinutes: typeof body.recurrenceMinutes === "number" ? body.recurrenceMinutes : undefined,
					workspaceRef: typeof body.workspaceRef === "string" ? body.workspaceRef : undefined,
					surfaceRef: typeof body.surfaceRef === "string" ? body.surfaceRef : undefined,
				};
				// Validate through the store contract without mutating it by checking the
				// same fields here; execution occurs only through the confirmation flow.
				const preview = createConfirmationPreview(toolCall);
				const now = new Date();
				const confirmationId = `confirm-${randomUUID()}`;
				confirmationStore.add({
					confirmationId,
					requestId: `api-schedule-${randomUUID()}`,
					toolCallId: `tool-${randomUUID()}`,
					tool: "schedule_job",
					risk: "mutation",
					payload: toolCall,
					payloadHash: hashPayload(toolCall),
					preview,
					createdAt: now.toISOString(),
					expiresAt: new Date(now.getTime() + ttlForRisk("mutation")).toISOString(),
				});
				res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true, requiresConfirmation: true, confirmationId, preview }));
			} catch (cause) {
				res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
			}
			return;
		}

		if (req.method === "DELETE") {
			const jobMatch = url.pathname.match(/^\/api\/scheduled-jobs\/([^/]+)$/);
			if (jobMatch) {
				try {
					const id = decodeURIComponent(jobMatch[1] ?? "");
					const removed = goalJobStore.cancelJob(id);
					res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify(removed ? { ok: true, removed: true, id } : { ok: false, removed: false, error: "Scheduled job not found." }));
				} catch (cause) {
					res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
				}
				return;
			}
		}

		// Mute endpoints
		if (req.method === "POST" && url.pathname === "/mute") {
			const body = await readJsonBody(req);
			const durationMs = typeof body?.durationMs === "number" ? body.durationMs : 0;
			const result = await handleMute(durationMs);
			if (result.displayText) notifyAction(result.displayText);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, ...result, mutedUntil }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/unmute") {
			const result = await handleUnmute();
			if (result.displayText) notifyAction(result.displayText);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, ...result, mutedUntil }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/mute/status") {
			const result = await handleMuteStatus();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, ...result, muted: mutedUntil !== null }));
			return;
		}

		// Main ask endpoint (Alfred 2.0: /ask, Alfred 1.x compat: /handle)
		if (req.method === "POST" && (url.pathname === "/ask" || url.pathname === "/" || url.pathname === "/handle")) {
			const body = await readJsonBody(req);
			const requestId = typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : `req-${randomUUID()}`;
			const userText = typeof body?.text === "string" ? body.text.trim() : typeof (body as any)?.input?.text === "string" ? (body as any).input.text.trim() : "";
			const turnId = typeof body?.turnId === "string" && body.turnId.trim() ? body.turnId.trim() : undefined;
			const outcomeFinalizer = createTaskOutcomeFinalizer({
				requestId,
				turnId,
				sessionId,
				onFinalize: config.onTaskOutcome,
			});
			trackAskResponse(res, eventBus, requestId, outcomeFinalizer);

			if (!userText) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, requestId, sessionId, error: "text is required" }));
				return;
			}
			eventBus.publish({ type: "ask:start", requestId, text: userText });

			// Deterministic utility route: mute / unmute / status
			const muteMatch = userText.match(/^(?:mute|silence|shut up|be quiet|quiet)(?:\s+(?:alfred|yourself))?(?:\s+for)?\s+(\d+)\s*(second|seconds|sec|s|minute|minutes|min|m|hour|hours|hr|h)s?$/i);
			if (muteMatch) {
				const amount = Number(muteMatch[1]);
				const unit = (muteMatch[2] ?? "").toLowerCase();
				let ms = 0;
				if (unit.startsWith("s")) ms = amount * 1000;
				else if (unit.startsWith("mi")) ms = amount * 60 * 1000;
				else if (unit.startsWith("h")) ms = amount * 3600 * 1000;
				const result = stripSpeechIfMuted(await handleMute(ms));
				if (result.displayText) notifyAction(result.displayText);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, ...result, muted: isMuted() }));
				return;
			}

			if (/^(?:unmute|unmute alfred|unsilence|stop muting)$/i.test(userText)) {
				const result = await handleUnmute();
				if (result.displayText) notifyAction(result.displayText);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, ...result, muted: isMuted() }));
				return;
			}

			if (/^(?:are you muted|mute status|muted\?|silence status|is alfred muted)/i.test(userText)) {
				const result = await handleMuteStatus();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, ...result }));
				return;
			}

			const snoozeBreakMatch = userText.match(/^(?:snooze(?: the)? break(?: for)?|remind me in)\s+(\d+)\s*(?:minutes?|mins?|m)?(?:\s+(?:about|for)\s+(?:the\s+)?break)?\.?$/i);
			if (/^(?:snooze(?: the)? break|remind me in\s*20(?:\s*(?:minutes?|mins?|m))?(?:\s+(?:about|for)\s+(?:the\s+)?break)?\.?$)$/i.test(userText) || snoozeBreakMatch) {
				const minutes = snoozeBreakMatch?.[1] ? Number(snoozeBreakMatch[1]) : undefined;
				wellnessWatcher.snoozeBreak(Number.isFinite(minutes) && minutes! > 0 ? minutes : undefined);
			saveWellnessNow();
				const state = wellnessWatcher.getState();
				const msg = `Break reminder snoozed${state.breakSnoozedUntil ? ` until ${new Date(state.breakSnoozedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}` : ""}.`;
				notifyAction(msg);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, wellness: state }));
				return;
			}

			if (/^(?:(?:acknowledge|dismiss)(?: the)? break|break done|(?:i\s+)?(?:took|had)(?: a)? break)\.?$/i.test(userText)) {
				wellnessWatcher.acknowledgeBreak("user_acknowledged");
			saveWellnessNow();
				const msg = "Break acknowledged. Timer reset, sir.";
				notifyAction(msg);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, wellness: wellnessWatcher.getState() }));
				return;
			}

		if (/^(?:wellness|break|work)\s+status|how\s+long\s+(?:have\s+i\s+been\s+)?working|how\s+(?:much\s+)?long(?:er)?\s+(?:until|till|before)\s+(?:my\s+)?(?:next\s+)?break|when(?:'s|\s+is)\s+(?:my\s+)?(?:next\s+)?break|did\s+i\s+take\s+a\s+break\s+today|when\s+did\s+i\s+last\s+take\s+a\s+break|how\s+long\s+(?:until|till)\s+lunch|how\s+long\s+(?:until|till)\s+dinner/i.test(userText)) {
			const now = new Date();
			const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
			const snapshot = getSnapshot();
			const ws = wellnessWatcher.getState();
			const ps = wellnessWatcher.getPersistentState();
			const minutesWorked = Math.round(snapshot.activeWorkAccumulatedMinutes);
			const minutesUntilBreak = Math.max(0, 90 - minutesWorked);
			const lastBreak = ws.lastBreakAcknowledgedAt;
			const lunchFired = ps.lastLunchFiredDate === today;
			const dinnerFired = ps.lastDinnerFiredDate === today;

			const parts: string[] = [];
			parts.push(minutesWorked > 0 ? `You've been working for about ${minutesWorked} minute${minutesWorked === 1 ? "" : "s"}.` : "You haven't started a work session yet.");
			if (minutesUntilBreak > 0) parts.push(`Next break reminder in about ${minutesUntilBreak} minute${minutesUntilBreak === 1 ? "" : "s"}.`);
			else if (ws.breakPending) parts.push("Break reminder is pending delivery.");
			else parts.push("You're due for a break, sir.");
			if (lastBreak) parts.push(`Last break logged at ${new Date(lastBreak).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}.`);
			if (lunchFired) parts.push("Lunch reminder already sent today.");
			if (dinnerFired) parts.push("Dinner reminder already sent today.");

			const speech = parts.join(" ");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, requestId, sessionId, speech, displayText: speech, wellness: { minutesWorked, minutesUntilBreak, lastBreak, breakPending: ws.breakPending, lunchFired, dinnerFired } }));
			return;
		}

			// Deterministic date/time answers. Do not let the LLM hallucinate calendar facts.
			if (/^(?:what(?:'s| is) (?:the )?(?:date|day|time)(?: today| now)?\??|what (?:date|day|time) is it(?: today| now)?\??|what day is it today\??|today(?:'s| is)? date\??|current (?:date|day|time)\??)$/i.test(userText)) {
				const msg = formatCurrentDateAnswer(userText);
				addHistoryEntry({
					requestId,
					sessionId,
					timestamp: new Date().toISOString(),
					userText,
					executed: false,
					requiresConfirmation: false,
					speech: msg,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				return;
			}

			if (/^(?:how did you get that date|where did you get that date|how do you know the date)\??$/i.test(userText)) {
				const msg = formatDateSourceAnswer();
				addHistoryEntry({
					requestId,
					sessionId,
					timestamp: new Date().toISOString(),
					userText,
					executed: false,
					requiresConfirmation: false,
					speech: msg,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				return;
			}

			const speedMatch = userText.match(/^(?:set|change|increase|decrease|make)\s+(?:your\s+)?(?:speaking|talking|speech|voice)\s+speed\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:x)?\.?$/i);
			if (speedMatch) {
				const requestedSpeed = Number(speedMatch[1]);
				const fishSpeed = Math.min(2, Math.max(0.5, Number.isFinite(requestedSpeed) ? requestedSpeed : 1));
				const edgeRate = formatEdgeRateForSpeed(fishSpeed);
				const tts = updateTtsSettings({ fishSpeed, edgeRate });
				persistDaemonEnvSettings({ ALFRED_FISH_SPEED: String(tts.fishSpeed), ALFRED_EDGE_RATE: tts.edgeRate });
				const msg = `Speaking speed set to ${tts.fishSpeed}x, sir.`;
				addHistoryEntry({
					requestId,
					sessionId,
					timestamp: new Date().toISOString(),
					userText,
					executed: false,
					requiresConfirmation: false,
					speech: msg,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, tts }));
				return;
			}

			// Deterministic tool listing response
			if (/^(?:what can you do|what tools can you do|list tools|show tools|tools help|help me)\s*$/i.test(userText)) {
				const names = TOOL_CONTRACTS.map((tool) => tool.name).join(", ");
				const msg = `I can operate ${TOOL_CONTRACTS.length} core tools: ${names}.`;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, tools: TOOL_CONTRACTS }));
				return;
			}

			// Auto-confirm toggles (session scoped). When an approval is pending,
			// natural replies like "go ahead" must flow into the confirmation resolver
			// instead of turning on global auto-confirm.
			if (confirmationStore.count() === 0 && /^(?:yes to all|stop asking|auto (?:confirm|approve)|don't ask|dont ask|stop confirming|approve all|confirm all)$/i.test(userText)) {
				autoConfirm = true;
				const msg = "Routine local mutation auto-approval is enabled for this session. Sends, monitors, imports, schedules, and destructive work still require approval.";
				notifyAction(msg);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, autoConfirm }));
				return;
			}
			if (/^(?:stop auto confirm|stop auto approve|ask again|resume asking|careful mode|be careful)$/i.test(userText)) {
				autoConfirm = false;
				const msg = "Auto-confirm disabled. I'll ask before each edit again.";
				notifyAction(msg);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg, autoConfirm }));
				return;
			}

			// Deterministic fact delete route for dashboard actions
			const forgetMatch = userText.match(/^(?:forget|delete|remove)\s+(?:fact\s+)?(.+)$/i);
			if (forgetMatch && forgetMatch[1]) {
				const key = forgetMatch[1].trim();
				if (!key) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: "I need a fact key to forget.", displayText: "I need a fact key to forget." }));
					return;
				}
				const removed = profileStore.forgetProfileMemory(key) || profileStore.forgetFact(key);
				if (removed) {
					const msg = `Forgot ${key}.`;
					notifyAction(msg);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				} else {
					const msg = `No fact named "${key}" was found.`;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				}
				return;
			}

			// Deterministic undo-by-id
			const undoIdMatch = userText.match(/^undo\s+(undo-[a-z0-9-]+)$/i);
			if (undoIdMatch && undoIdMatch[1]) {
				const restored = undoById(undoIdMatch[1]);
				if (restored) {
					const msg = `Reverted ${restored.originalPath} using ${restored.tool}.`;
					notifyAction(msg);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				} else {
					const msg = "No undo backup found for that entry, sir.";
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				}
				return;
			}

			// Deterministic undo last
			if (/^(?:undo that|undo|revert that|revert last|undo last|undo last edit)$/i.test(userText)) {
				const history = getUndoHistory();
				const last = history[0];
				if (last) {
					const restored = undoByOriginalPath(last.originalPath);
					const msg = restored
						? `Reverted ${basename(restored.originalPath)} to before the last edit.`
						: "Couldn't restore the file, sir.";
					notifyAction(msg);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				} else {
					const msg = "Nothing to undo, sir.";
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: msg, displayText: msg }));
				}
				return;
			}

			// Handle history queries deterministically (zero LLM tokens)
			const historySearchMatch = userText.match(/^(?:what did (?:I|we|you) (?:just )?(?:do|run|execute)|search history for|find (?:in )?history) (.+)$/i);
			if (historySearchMatch) {
				const results = searchHistory(historySearchMatch[1]!.trim());
				const text = results.length > 0
					? `Found ${results.length} matching entries:\n${formatHistoryForContext(results)}`
					: "No matching history found.";
				notifyAction(text.slice(0, 200));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: "", displayText: text, historyResults: results }));
				return;
			}

			if (/^(?:what did (?:I|we|you) (?:just )?(?:do|run|execute)|show (?:my |the )?(?:recent )?(?:command )?history|what (?:have|has) (?:I|we|you) done|recall|what was (?:the |my )?last)/i.test(userText)) {
				const recent = getRecentHistory(10);
				const text = recent.length > 0
					? `Recent activity:\n${formatHistoryForContext(recent)}`
					: "No activity recorded yet.";
				notifyAction(text.slice(0, 200));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, requestId, sessionId, speech: "", displayText: text, historyResults: recent }));
				return;
			}

			// Gather context and call agent. Use live cmux/git context only when the request needs it;
			// simple chat/web/mail/calendar requests get a minimal clock context to avoid seconds of discovery.
			const contextStart = Date.now();
			const forceFreshContext = shouldForceFreshContext(userText);
			const fullSystemContextNeeded = shouldUseFullSystemContext(userText);
			const context = fullSystemContextNeeded ? await gatherSystemContext(forceFreshContext) : createMinimalSystemContext();
			const recentHistory = getRecentHistory(10);
			const ragContext = buildRelevantSystemContext({
				userText,
				fullContext: context.text,
				recentHistory,
			});
			const fullContext = ragContext.text;
			const contextMs = Date.now() - contextStart;

			const agentStart = Date.now();
			const loopResult = await runToolLoop({
				llmClient,
				userText,
				systemContext: fullContext,
				requestId,
				sessionId,
				turnId,
				profileStore,
				knowledgeStore,
				confirm: body?.confirm === true,
				confirmationId: typeof body?.confirmationId === "string" ? body.confirmationId : undefined,
				autoConfirm,
				sessionMonitorManager,
				goalJobStore,
				workAdvisor,
				memory: sessionMemory,
				confirmationStore,
				speakAcknowledgements: body?.playback !== "browser",
				onSpeechEvent: (event) => publishSpeechEvent(eventBus, requestId, event),
				onEvent: (event) => {
					if (event.type === "tool_call") {
						eventBus.publish({ type: "tool:start", requestId, tool: event.tool ?? event.message });
					} else if (event.type === "tool_result") {
						eventBus.publish({ type: "tool:done", requestId, tool: event.tool ?? "unknown", ok: event.ok === true });
					} else if (event.type === "confirmation_required") {
						eventBus.publish({ type: "confirmation:created", requestId, count: confirmationStore.count() });
					}
				},
			});
			toolRoundTotal += loopResult.toolRounds;
			const agentMs = Date.now() - agentStart;

			const speechFormatterStart = Date.now();
			const speechFormatter = await formatSpeechForTts({
				llmClient,
				userText,
				speech: loopResult.speech,
				displayText: loopResult.displayText,
			});
			const speechFormatterMs = Date.now() - speechFormatterStart;
			const presentedSpeech = speechFormatter.speech;

			// Save to history
			addHistoryEntry({
				requestId,
				sessionId,
				timestamp: new Date().toISOString(),
				userText,
				command: loopResult.command,
				executed: loopResult.executed,
				requiresConfirmation: loopResult.requiresConfirmation,
				speech: presentedSpeech,
				displayText: loopResult.displayText,
				stdout: loopResult.commandResult?.stdout?.slice(0, 500),
				stderr: loopResult.commandResult?.stderr?.slice(0, 500),
				ok: loopResult.commandResult?.ok,
				toolSummary: loopResult.toolResults.map((result) => `${result.tool}:${result.success ? "ok" : "failed"}`).join(", "),
			});

			// Strip speech if muted
			const finalResponse = stripSpeechIfMuted({
				speech: presentedSpeech,
				displayText: loopResult.displayText,
			});

			// Show macOS notification for executed commands or display text
			if (loopResult.executed && loopResult.command) {
				notify("Alfred", presentedSpeech || `Ran: ${loopResult.command}`).catch(() => {});
			} else if (finalResponse.displayText && !loopResult.executed && !loopResult.requiresConfirmation) {
				notify("Alfred", finalResponse.displayText.slice(0, 200)).catch(() => {});
			}

			// Speak (unless muted) — auto-aborts any previous speech
			if (finalResponse.speech && body?.playback !== "browser") {
				speak(finalResponse.speech, {
					onEvent: (event) => publishSpeechEvent(eventBus, requestId, event),
				}).catch(() => {});
			}

			// Token estimate
			const contextTokens = estimateTokens(fullContext);
			const savedTokens = 7 * 500;

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: true,
				requestId,
				sessionId,
				speech: finalResponse.speech,
				displayText: finalResponse.displayText,
				command: loopResult.command,
				executed: loopResult.executed,
				requiresConfirmation: loopResult.requiresConfirmation,
				confirmationPrompt: loopResult.confirmationPrompt,
				confirmationId: loopResult.confirmationId,
				commandResult: loopResult.commandResult ?? undefined,
				toolResults: loopResult.toolResults,
				citations: loopResult.citations,
				muted: isMuted(),
				timing: { contextMs, agentMs, speechFormatterMs, totalMs: contextMs + agentMs + speechFormatterMs },
				tokens: { context: contextTokens, currentPrompt: loopResult.currentContextTokens, maxPrompt: loopResult.maxContextTokens, saved: savedTokens, llm: loopResult.usage, speechFormatter: speechFormatter.usage, speechFormatterInputEstimate: speechFormatter.inputTokensEstimate, session: loopResult.sessionTokens },
				trace: {
					sessionId,
					requestId,
					source: loopResult.toolResults[loopResult.toolResults.length - 1]?.tool ?? "final",
					toolCount: loopResult.toolRounds,
					toolRoundsTotal: toolRoundTotal,
					retries: loopResult.parserRetries,
					usage: loopResult.usage,
					outcome: loopResult.outcome,
					speechFormatter: {
						used: speechFormatter.used,
						model: speechFormatter.model,
						maxTokens: speechFormatter.maxTokens,
						error: speechFormatter.error,
					},
					rag: {
						mode: fullSystemContextNeeded ? "full" : "minimal",
						includedPacks: ragContext.includedPacks,
						omittedPacks: ragContext.omittedPacks,
						contextTokensEstimate: contextTokens,
					},
					events: loopResult.events,
				},
				handoffPath: loopResult.handoffPath,
				memory: {
					turns: sessionMemory.turns.length,
					tokens: loopResult.sessionTokens,
					currentContextTokens: loopResult.currentContextTokens,
					maxContextTokens: loopResult.maxContextTokens,
					pendingConfirmations: confirmationStore.count(),
				},
			}));
			return;
		}

		// 404
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "Not found" }));
	}

	const server = http.createServer((req, res) => {
		void handleRequest(req, res).catch((cause) => {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (res.writableEnded) return;
			if (res.headersSent) {
				res.destroy();
				return;
			}
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (isPrivateMemoryRequest(req)) headers["Cache-Control"] = "no-store";
			res.writeHead(cause instanceof HttpRequestError ? cause.statusCode : 500, headers);
			res.end(JSON.stringify({ ok: false, error: message }));
		});
	});

	return new Promise((resolve, reject) => {
		server.listen(config.port, config.host, () => {
			const address = server.address();
			const actualPort = typeof address === "object" && address ? address.port : config.port;
			resolve({
				port: actualPort,
				host: config.host,
				close: async () => {
					clearInterval(historySaveInterval);
					clearInterval(wellnessInterval);
					if (prWatchInterval) clearInterval(prWatchInterval);
					if (workAdvisorInterval) clearInterval(workAdvisorInterval);
					clearInterval(scheduledJobInterval);
					process.off("SIGTERM", saveHistoryOnSignal);
					process.off("SIGINT", saveHistoryOnSignal);
					process.off("beforeExit", saveHistoryOnSignal);
					stopActivitySampler();
					sessionMonitorManager.close();
					eventBus.close();
					setSpeechSuppressionProvider(null);
					saveHistory();
					await new Promise<void>((closeResolve, closeReject) => {
						server.close((error) => error ? closeReject(error) : closeResolve());
					});
				},
			});
		});
		server.on("error", reject);
	});
}

function shouldForceFreshContext(userText: string): boolean {
	const lower = userText.toLowerCase();
	return /\b(pending work|what changed|dirty workspace|dirty workspaces|git status|branch|branches|pr\b|prs\b|pull request|ci\b|checks?\b|notification|notifications|current state|latest state|right now|up to date|stale|refresh context)\b/.test(lower);
}

function shouldUseFullSystemContext(userText: string): boolean {
	const lower = userText.toLowerCase();
	// Live desktop/workspace context is expensive: cmux, git, and sidebar probes can dominate latency.
	// Only pay that cost for requests likely to need a cwd, workspace/session state, git/CI state, or local file/action context.
	return /\b(workspace|workspaces|tab|tabs|session|sessions|pane|panes|terminal|terminals|cmux|screen|inspect|running|stuck|blocked|pending work|current state|latest state|what changed|dirty|git|github|pr\b|prs\b|pull request|branch|branches|ci\b|checks?|notification|notifications|alert|alerts|attention|file|files|folder|folders|directory|directories|repo|repository|project|code|diff|run|execute|command|shell|bash|open|launch|close|kill|test|typecheck|lint|build|read|edit|write|change|create|delete|remove|move|copy|rename|commit|push|pull|status)\b/.test(lower);
}

function formatEdgeRateForSpeed(speed: number): string {
	const percent = Math.round((speed - 1) * 100);
	return `${percent >= 0 ? "+" : ""}${percent}%`;
}

function persistDaemonEnvSettings(settings: Record<string, string>): void {
	const envPath = process.env.ALFRED_DAEMON_ENV ?? join(homedir(), ".alfred", "daemon.env");
	try {
		mkdirSync(dirname(envPath), { recursive: true });
		const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
		const pending = new Map(Object.entries(settings));
		const lines = existing.map((line) => {
			let trimmed = line.trim();
			const exported = trimmed.startsWith("export ");
			if (exported) trimmed = trimmed.slice("export ".length).trim();
			if (!trimmed.includes("=")) return line;
			const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
			const value = pending.get(key);
			if (value === undefined) return line;
			pending.delete(key);
			return `${exported ? "export " : ""}${key}=${value}`;
		});
		for (const [key, value] of pending) lines.push(`export ${key}=${value}`);
		writeFileSync(envPath, `${lines.filter((line, index) => line.trim() || index < lines.length - 1).join("\n").trimEnd()}\n`, "utf8");
	} catch {
		// Runtime settings are already updated; persistence is best-effort.
	}
}

function formatCurrentDateAnswer(userText: string): string {
	const now = new Date();
	const lower = userText.toLowerCase();
	const date = now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
	const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
	if (lower.includes("time") && !lower.includes("date") && !lower.includes("day")) {
		return `It is ${time}, sir.`;
	}
	if (lower.includes("time")) {
		return `Today is ${date}, and it is ${time}, sir.`;
	}
	return `Today is ${date}, sir.`;
}

function formatDateSourceAnswer(): string {
	const now = new Date();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
	return `I read it from this Mac's system clock, sir: ${now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} (${timeZone}; UTC ${now.toISOString()}).`;
}

function createAgentBackedLlmClient(agent: Alfred2AgentLike): LlmClient {
	return {
		async complete(request) {
			const lastMessage = request.messages[request.messages.length - 1]?.content ?? "";
			const response = await agent.ask(lastMessage, "");
			return {
				text: JSON.stringify(response.command ? { speech: response.speech, command: response.command, displayText: response.displayText } : { speech: response.speech, displayText: response.displayText }),
				usage: response.usage,
			};
		},
	};
}

function trackAskResponse(res: ServerResponse, eventBus: AlfredEventBus, requestId: string, outcomeFinalizer: TaskOutcomeFinalizer): void {
	const originalEnd = res.end;
	let settled = false;
	res.once("close", () => {
		if (settled) return;
		settled = true;
		const message = "Request connection closed before a response was delivered.";
		outcomeFinalizer.fail(createStructuredFailure({
			stage: "deliver",
			code: "outcome.unclassified",
			component: "ask-boundary",
			message,
			retryable: true,
			detector: { id: "alfred.ask-boundary-close", version: 1 },
		}));
		eventBus.publish({ type: "ask:error", requestId, message });
	});
	res.end = function(this: ServerResponse, chunk?: any, encodingOrCallback?: any, callback?: any): ServerResponse {
		if (!settled) {
			settled = true;
			let payload: Record<string, unknown> | null = null;
			try {
				const raw = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
				payload = raw ? JSON.parse(raw) as Record<string, unknown> : null;
			} catch {
				payload = null;
			}
			const trace = payload?.trace && typeof payload.trace === "object" ? payload.trace as Record<string, unknown> : undefined;
			const loopOutcome = trace?.outcome && typeof trace.outcome === "object" ? trace.outcome as TaskOutcome : undefined;
			if (loopOutcome) {
				outcomeFinalizer.finalize({
					status: loopOutcome.status,
					terminalFailure: loopOutcome.terminalFailure,
					completedOperationKeys: loopOutcome.completedOperationKeys,
					requiredOperationKeys: loopOutcome.requiredOperationKeys,
					operationLineageKeys: loopOutcome.operationLineageKeys,
				});
			} else if (res.statusCode >= 400 || payload?.ok === false) {
				const message = typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${res.statusCode}`;
				outcomeFinalizer.fail(createStructuredFailure({
					stage: res.statusCode >= 500 ? "deliver" : "route",
					code: res.statusCode >= 500 ? "execution.internal_error" : "contract.invalid_input",
					component: "ask-boundary",
					message,
					retryable: res.statusCode >= 500,
					detector: { id: "alfred.ask-boundary", version: 1 },
				}));
			} else {
				outcomeFinalizer.complete();
			}
			if (res.statusCode >= 400 || payload?.ok === false) {
				const message = typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${res.statusCode}`;
				eventBus.publish({ type: "ask:error", requestId, message });
			} else {
				const displayText = typeof payload?.displayText === "string"
					? payload.displayText
					: typeof payload?.speech === "string" ? payload.speech : "";
				eventBus.publish({ type: "ask:done", requestId, displayText });
			}
		}
		return originalEnd.call(this, chunk, encodingOrCallback, callback);
	} as ServerResponse["end"];
}

function publishSpeechEvent(eventBus: AlfredEventBus, requestId: string, event: SpeechLifecycleEvent): void {
	if (event.type === "start") eventBus.publish({ type: "speech:start", requestId, provider: event.provider });
	else if (event.type === "done") eventBus.publish({ type: "speech:done", requestId, provider: event.provider });
	else eventBus.publish({ type: "speech:error", requestId, provider: event.provider, message: event.message ?? "Speech failed" });
}

class HttpRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isPrivateApiPath(pathname: string): boolean {
	return pathname === "/api/memory" || pathname.startsWith("/api/memory/") || pathname.startsWith("/dashboard/knowledge/");
}

function isPrivateMemoryRequest(req: IncomingMessage): boolean {
	try {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		return pathname === "/dashboard/state"
			|| pathname === "/dashboard/facts"
			|| pathname.startsWith("/dashboard/facts/")
			|| pathname.startsWith("/dashboard/knowledge/")
			|| pathname === "/api/memory"
			|| pathname.startsWith("/api/memory/");
	} catch {
		return false;
	}
}

function logPrivateMemoryFailure(component: string, cause: unknown): void {
	const detail = cause instanceof Error ? cause.message : String(cause);
	console.warn(`[memory:${component}] ${detail.slice(0, 500)}`);
}

function decodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new HttpRequestError(400, "Path identifier is malformed.");
	}
}

function isAllowedLocalOrigin(origin: string | undefined): boolean {
	if (!origin) return true;
	try {
		return isLoopbackHost(new URL(origin).hostname);
	} catch {
		return false;
	}
}

async function readKnowledgeJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	return readJsonBody(req, 5 * 1024 * 1024);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown> | null> {
	const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") throw new HttpRequestError(415, "JSON requests require Content-Type: application/json.");
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			if (!tooLarge) chunks.push(chunk);
		});
		req.on("end", () => {
			if (tooLarge) {
				reject(new HttpRequestError(413, `Request body exceeds ${maxBytes} bytes.`));
				return;
			}
			const raw = Buffer.concat(chunks).toString("utf-8");
			if (!raw) {
				resolve(null);
				return;
			}
			try {
				const value = JSON.parse(raw) as unknown;
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object.");
				resolve(value as Record<string, unknown>);
			} catch {
				reject(new HttpRequestError(400, "Request body must contain a valid JSON object."));
			}
		});
		req.on("error", (error) => reject(new HttpRequestError(400, `Could not read request body: ${error.message}`)));
	});
}
