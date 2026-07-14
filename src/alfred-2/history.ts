import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryEntry {
	requestId?: string;
	sessionId?: string;
	timestamp: string;
	userText: string;
	command?: string;
	executed: boolean;
	requiresConfirmation: boolean;
	speech: string;
	/** Full visible response shown to dashboard/API users. May be longer than speech. */
	displayText?: string;
	stdout?: string;
	stderr?: string;
	ok?: boolean;
	toolSummary?: string;
	importance: "low" | "normal" | "high";
}

export interface HistoryStore {
	readonly filePath: string;
	loadHistory(): HistoryEntry[];
	saveHistory(): void;
	addHistoryEntry(entry: Omit<HistoryEntry, "importance">): void;
	getRecentHistory(count?: number): HistoryEntry[];
	searchHistory(query: string): HistoryEntry[];
}

const DEFAULT_HISTORY_FILE = join(homedir(), ".alfred", "history.json");
const MAX_MEMORY_ENTRIES = 200;
const MAX_DISK_ENTRIES = 1000;
const HIGH_IMPORTANCE_KEEP = 200;

function determineImportance(entry: Omit<HistoryEntry, "importance">): HistoryEntry["importance"] {
	if (entry.requiresConfirmation && entry.executed) return "high";
	if (entry.command && /\b(npm|git|pip|brew|cp|mv|mkdir|write|echo.*>)\b/.test(entry.command)) return "high";
	if (entry.executed && entry.ok === false) return "normal";
	if (entry.command && /\b(open|ls|cat|head|tail|grep|find|which|echo|date|pwd)\b/.test(entry.command)) return "low";
	return "normal";
}

function trimHistory(history: HistoryEntry[], limit: number): HistoryEntry[] {
	if (history.length <= limit) return history;
	const highEntries = history.filter((entry) => entry.importance === "high");
	const otherEntries = history.filter((entry) => entry.importance !== "high");
	const keptHigh = highEntries.slice(-HIGH_IMPORTANCE_KEEP);
	const availableSlots = limit - keptHigh.length;
	const keptOther = otherEntries.slice(-Math.max(availableSlots, 0));
	return [...keptOther, ...keptHigh].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);
}

export function createHistoryStore(filePath: string = DEFAULT_HISTORY_FILE): HistoryStore {
	let history: HistoryEntry[] = [];
	let dirty = false;

	function ensureDir(): void {
		const directory = dirname(filePath);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}

	function loadHistory(): HistoryEntry[] {
		ensureDir();
		try {
			if (!existsSync(filePath)) {
				history = [];
				return history;
			}
			chmodSync(filePath, 0o600);
			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			history = Array.isArray(parsed) ? parsed as HistoryEntry[] : [];
		} catch {
			history = [];
		}
		dirty = false;
		return history;
	}

	function saveHistory(): void {
		if (!dirty) return;
		ensureDir();
		try {
			writeFileSync(filePath, JSON.stringify(history, null, 2), { encoding: "utf-8", mode: 0o600 });
			chmodSync(filePath, 0o600);
			dirty = false;
		} catch {
			// History persistence is non-fatal to the assistant runtime.
		}
	}

	function addHistoryEntry(entry: Omit<HistoryEntry, "importance">): void {
		history.push({ ...entry, importance: determineImportance(entry) });
		dirty = true;
		history = trimHistory(history, MAX_MEMORY_ENTRIES);
		history = trimHistory(history, MAX_DISK_ENTRIES);
		if (history.length % 5 === 0) saveHistory();
	}

	function getRecentHistory(count = 10): HistoryEntry[] {
		return history.slice(-count);
	}

	function searchHistory(query: string): HistoryEntry[] {
		const lower = query.toLowerCase();
		return history
			.filter(
				(entry) =>
					entry.userText.toLowerCase().includes(lower)
					|| (entry.command && entry.command.toLowerCase().includes(lower))
					|| entry.speech.toLowerCase().includes(lower),
			)
			.slice(-20);
	}

	return { filePath, loadHistory, saveHistory, addHistoryEntry, getRecentHistory, searchHistory };
}

export function formatHistoryForContext(entries: HistoryEntry[]): string {
	if (entries.length === 0) return "(no recent history)";
	return entries
		.map(
			(entry) =>
				`[${entry.timestamp.slice(11, 19)}] ${entry.userText} → ${entry.speech}${entry.command ? ` (ran: ${entry.command})` : ""}`,
		)
		.join("\n");
}

const defaultHistoryStore = createHistoryStore();

export function getDefaultHistoryStore(): HistoryStore {
	return defaultHistoryStore;
}

export const loadHistory = (): HistoryEntry[] => defaultHistoryStore.loadHistory();
export const saveHistory = (): void => defaultHistoryStore.saveHistory();
export const addHistoryEntry = (entry: Omit<HistoryEntry, "importance">): void => defaultHistoryStore.addHistoryEntry(entry);
export const getRecentHistory = (count = 10): HistoryEntry[] => defaultHistoryStore.getRecentHistory(count);
export const searchHistory = (query: string): HistoryEntry[] => defaultHistoryStore.searchHistory(query);
