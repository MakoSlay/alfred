import type { HistoryEntry } from "./history.ts";
import { formatHistoryForContext } from "./history.ts";

export interface RagContextResult {
	text: string;
	includedPacks: string[];
	omittedPacks: string[];
}

const DEFAULT_MAX_CONTEXT_CHARS = 8_000;
const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "what", "when", "where", "which", "who", "why", "how",
	"are", "was", "were", "you", "your", "can", "could", "should", "would", "there", "have", "has", "had",
	"about", "right", "now", "please", "tell", "check", "show", "into", "from", "then", "than", "them", "they",
]);

export function buildRelevantSystemContext(params: {
	userText: string;
	fullContext: string;
	recentHistory: HistoryEntry[];
	maxChars?: number;
}): RagContextResult {
	const maxChars = params.maxChars ?? envMaxContextChars();
	const sections = splitContextSections(params.fullContext);
	const intent = classifyIntent(params.userText);
	const includedPacks: string[] = ["date"];
	const omittedPacks: string[] = [];
	const blocks: string[] = [];

	blocks.push(sections.date || currentDateLine());

	if (intent.includeWorkspaces) {
		includedPacks.push("workspaces");
		blocks.push(capBlock(sections.workspaces || "WORKSPACES: unavailable", 4_500));
	} else {
		omittedPacks.push("workspaces");
	}

	if (intent.includeNotifications) {
		includedPacks.push("notifications");
		blocks.push(capBlock(sections.notifications || "NOTIFICATIONS: unavailable", 2_000));
	} else {
		omittedPacks.push("notifications");
	}

	if (intent.includePrMemory) {
		includedPacks.push("pr-watch-memory");
		blocks.push(capBlock(sections.prWatchMemory || "PR WATCH MEMORY: unavailable", 1_500));
	} else {
		omittedPacks.push("pr-watch-memory");
	}

	if (intent.includeCmuxHint) {
		includedPacks.push("cmux-hint");
		blocks.push("CMUX: Use registered Alfred tools such as inspect_session, refresh_context, and bash rather than raw cmux discovery unless necessary.");
	} else {
		omittedPacks.push("cmux-reference");
	}

	const history = relevantHistory(params.userText, params.recentHistory, intent.includeAllHistory);
	if (history.length > 0) {
		includedPacks.push("recent-history");
		blocks.push(`RECENT RELEVANT ACTIVITY:\n${capBlock(formatHistoryForContext(history), 1_500)}`);
	} else {
		omittedPacks.push("recent-history");
	}

	blocks.push(`RAG CONTEXT PACKS: included ${includedPacks.join(", ")}; omitted ${omittedPacks.join(", ")}. Use tools to retrieve omitted live context if needed.`);

	return {
		text: capBlock(blocks.filter(Boolean).join("\n\n"), maxChars),
		includedPacks,
		omittedPacks,
	};
}

function classifyIntent(userText: string): { includeWorkspaces: boolean; includeNotifications: boolean; includePrMemory: boolean; includeCmuxHint: boolean; includeAllHistory: boolean } {
	const lower = userText.toLowerCase();
	const isEmail = /\b(email|emails|gmail|mail|inbox)\b/.test(lower);
	const isCalendar = /\b(calendar|meeting|meetings|event|events|schedule)\b/.test(lower);
	const isDocs = /\b(doc|docs|document|documents|google doc)\b/.test(lower);
	const workspaceLike = /\b(workspace|workspaces|tab|tabs|session|sessions|pane|terminal|cmux|screen|inspect|running|stuck)\b/.test(lower);
	const gitLike = /\b(git|github|pr\b|prs\b|pull request|branch|branches|dirty|ci\b|checks?|merge|review)\b/.test(lower);
	const notificationLike = /\b(notification|notifications|alert|alerts|attention|urgent|unread)\b/.test(lower);
	const historyLike = /\b(history|recent|last|previous|what did|recall|handoff)\b/.test(lower);

	return {
		includeWorkspaces: !isEmail && !isCalendar && !isDocs && (workspaceLike || gitLike || /\b(pending work|current state|what changed)\b/.test(lower)),
		includeNotifications: !isEmail && (notificationLike || /\battention right now\b/.test(lower)),
		includePrMemory: !isEmail && (gitLike || notificationLike || /\battention right now\b/.test(lower)),
		includeCmuxHint: workspaceLike,
		includeAllHistory: historyLike,
	};
}

function splitContextSections(context: string): { date?: string; workspaces?: string; notifications?: string; prWatchMemory?: string } {
	const beforeCmux = context.split(/\nCMUX COMMANDS REFERENCE:/)[0] ?? context;
	const lines = beforeCmux.split("\n");
	const dateLines: string[] = [];
	const workspaceLines: string[] = [];
	const notificationLines: string[] = [];
	const prWatchMemoryLines: string[] = [];
	let section: "date" | "workspaces" | "notifications" | "prWatchMemory" | "other" = "date";

	for (const line of lines) {
		if (/^WORKSPACES\b/.test(line)) section = "workspaces";
		else if (/^NOTIFICATIONS\b/.test(line.trim())) section = "notifications";
		else if (/^PR WATCH MEMORY\b/.test(line.trim())) section = "prWatchMemory";

		if (section === "date") dateLines.push(line);
		else if (section === "workspaces") workspaceLines.push(line);
		else if (section === "notifications") notificationLines.push(line);
		else if (section === "prWatchMemory") prWatchMemoryLines.push(line);
	}

	return {
		date: dateLines.join("\n").trim() || undefined,
		workspaces: workspaceLines.join("\n").trim() || undefined,
		notifications: notificationLines.join("\n").trim() || undefined,
		prWatchMemory: prWatchMemoryLines.join("\n").trim() || undefined,
	};
}

function relevantHistory(userText: string, entries: HistoryEntry[], includeAll: boolean): HistoryEntry[] {
	if (includeAll) return entries.slice(-8);
	const queryTokens = tokenize(userText);
	if (queryTokens.size === 0) return entries.slice(-2);
	return entries
		.map((entry, index) => ({ entry, index, score: scoreHistory(entry, queryTokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.index - a.index)
		.slice(0, 3)
		.sort((a, b) => a.index - b.index)
		.map((item) => item.entry);
}

function scoreHistory(entry: HistoryEntry, queryTokens: Set<string>): number {
	const text = `${entry.userText} ${entry.speech} ${entry.toolSummary ?? ""}`.toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (text.includes(token)) score++;
	}
	return score;
}

function tokenize(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^a-z0-9#]+/).filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function capBlock(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n[rag-truncated ${text.length - maxChars} chars]`;
}

function envMaxContextChars(): number {
	const parsed = parseInt(process.env.ALFRED_RAG_CONTEXT_MAX_CHARS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTEXT_CHARS;
}

function currentDateLine(): string {
	const now = new Date();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
	return `CURRENT DATE/TIME: ${now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} (${timeZone}; UTC ${now.toISOString()})`;
}
