import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const UNDO_DIR = join(homedir(), ".alfred", "undo");
const UNDO_INDEX_PATH = join(UNDO_DIR, "undo-index.json");

export interface UndoEntry {
	id: string;
	originalPath: string;
	backupPath: string;
	timestamp: string;
	tool: string;
	preview: string;
}

function loadUndoHistoryFromDisk(): UndoEntry[] {
	if (!existsSync(UNDO_INDEX_PATH)) return [];
	try {
		const raw = readFileSync(UNDO_INDEX_PATH, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const normalized: UndoEntry[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const candidate = item as Record<string, unknown>;
			if (
				typeof candidate.id !== "string" ||
				typeof candidate.originalPath !== "string" ||
				typeof candidate.backupPath !== "string" ||
				typeof candidate.timestamp !== "string" ||
				typeof candidate.tool !== "string" ||
				typeof candidate.preview !== "string"
			) {
				continue;
			}
			if (!existsSync(candidate.backupPath)) continue;
			normalized.push({
				id: candidate.id,
				originalPath: candidate.originalPath,
				backupPath: candidate.backupPath,
				timestamp: candidate.timestamp,
				tool: candidate.tool,
				preview: candidate.preview,
			});
		}
		return sortUndoHistory(normalized);
	} catch {
		return [];
	}
}

function persistUndoHistory(entries: UndoEntry[]): void {
	if (entries.length === 0 && !existsSync(UNDO_DIR)) return;
	ensureUndoDir();
	try {
		writeFileSync(UNDO_INDEX_PATH, JSON.stringify(entries, null, 2), "utf-8");
	} catch {
		// non-fatal
	}
}

function sortUndoHistory(entries: UndoEntry[]): UndoEntry[] {
	return [...entries].sort((a, b) => {
		const ta = Date.parse(a.timestamp);
		const tb = Date.parse(b.timestamp);
		if (Number.isNaN(ta) || Number.isNaN(tb)) return a.id.localeCompare(b.id);
		if (ta !== tb) return tb - ta;
		return a.id.localeCompare(b.id);
	});
}

let undoHistory: UndoEntry[] = loadUndoHistoryFromDisk();

export function ensureUndoDir(): string {
	if (!existsSync(UNDO_DIR)) mkdirSync(UNDO_DIR, { recursive: true });
	return UNDO_DIR;
}

export function saveUndoBackup(filePath: string, tool: string): UndoEntry | null {
	if (!existsSync(filePath)) return null;
	ensureUndoDir();
	const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const backupPath = join(UNDO_DIR, id);
	try {
		copyFileSync(filePath, backupPath);
		const entry: UndoEntry = {
			id,
			originalPath: filePath,
			backupPath,
			timestamp: new Date().toISOString(),
			tool,
			preview: `Backup of ${basename(filePath)} before ${tool}`,
		};
		return entry;
	} catch {
		return null;
	}
}

export function undoLastEdit(): UndoEntry | null {
	undoHistory = loadUndoHistoryFromDisk();
	const latest = undoHistory[0];
	if (!latest) return null;
	return undoById(latest.id);
}

export function recordUndo(entry: UndoEntry): void {
	undoHistory = [entry, ...undoHistory.filter((candidate) => candidate.id !== entry.id)];
	undoHistory = sortUndoHistory(undoHistory).slice(0, 50);
	persistUndoHistory(undoHistory);
}

export function getUndoHistory(): UndoEntry[] {
	undoHistory = sortUndoHistory(loadUndoHistoryFromDisk());
	return [...undoHistory];
}

function removeUndoEntryById(id: string): void {
	undoHistory = undoHistory.filter((entry) => entry.id !== id);
	persistUndoHistory(undoHistory);
}

function restoreEntry(entry: UndoEntry): UndoEntry | null {
	if (!existsSync(entry.backupPath)) {
		removeUndoEntryById(entry.id);
		return null;
	}
	try {
		const dir = dirname(entry.originalPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		copyFileSync(entry.backupPath, entry.originalPath);
		rmSync(entry.backupPath, { force: true });
		removeUndoEntryById(entry.id);
		return {
			...entry,
			timestamp: new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

export function undoByOriginalPath(originalPath: string): UndoEntry | null {
	undoHistory = loadUndoHistoryFromDisk();
	const matches = undoHistory.filter((entry) => entry.originalPath === originalPath);
	if (matches.length === 0) return null;
	return restoreEntry(matches[0]!);
}

export function undoById(id: string): UndoEntry | null {
	if (!id) return null;
	undoHistory = loadUndoHistoryFromDisk();
	const entry = undoHistory.find((candidate) => candidate.id === id);
	if (!entry) return null;
	return restoreEntry(entry);
}

export function clearUndoHistory(): number {
	undoHistory = loadUndoHistoryFromDisk();
	for (const entry of undoHistory) {
		rmSync(entry.backupPath, { force: true });
	}
	const removed = undoHistory.length;
	undoHistory = [];
	if (existsSync(UNDO_INDEX_PATH)) rmSync(UNDO_INDEX_PATH, { force: true });
	return removed;
}
