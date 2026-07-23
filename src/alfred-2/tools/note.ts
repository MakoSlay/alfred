import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	constants,
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { OpenNoteToolCall, ReadNoteToolCall, SaveNoteToolCall, ToolExecutionContext, ToolResult } from "../tool-types.ts";
import { createStructuredFailure } from "../capabilities/outcome.ts";

export const MAX_NOTE_BYTES = 240 * 1024;
export const DEFAULT_NOTE_READ_BYTES = 64 * 1024;

export interface NoteSummary {
	filename: string;
	path: string;
	bytes: number;
	modifiedAt: string;
}

export interface ListNotesData {
	directory: string;
	notes: NoteSummary[];
}

export interface ReadNoteData extends NoteSummary {
	content: string;
}

export interface OpenNoteData {
	path: string;
	filename?: string;
	kind: "note" | "folder";
}

export interface SaveNoteData {
	path: string;
	filename: string;
	bytes: number;
	opened: boolean;
	overwrote: boolean;
	openError?: string;
}

export type NoteOpenFn = (path: string) => Promise<void>;

export interface SaveNoteOptions {
	notesDirectory?: string;
	openFile?: NoteOpenFn;
	/** Tool-loop reads stay bounded; the local dashboard may request the full note cap. */
	maxReadBytes?: number;
}

export function defaultNotesDirectory(): string {
	return join(homedir(), "Documents", "Alfred Notes");
}

export function resolveNotePath(filename: string, notesDirectory = defaultNotesDirectory()): string {
	if (!filename || filename !== filename.normalize("NFC")) throw new Error("Note filename must be non-empty normalized Unicode.");
	if (isAbsolute(filename) || filename.includes("/") || filename.includes("\\")) throw new Error("Note filename must be a single leaf name, not a path.");
	if (filename.startsWith(".") || filename.endsWith(".") || filename.endsWith(" ")) throw new Error("Note filename cannot be hidden or end with a dot or space.");
	if (/[\u0000-\u001F\u007F]/.test(filename)) throw new Error("Note filename contains control characters.");
	if (Buffer.byteLength(filename, "utf8") > 200) throw new Error("Note filename is too long.");
	if (!/\.(?:md|txt)$/i.test(filename)) throw new Error("Notes must use a .md or .txt extension.");
	const path = join(notesDirectory, filename);
	if (dirname(path) !== notesDirectory) throw new Error("Note path escapes the Alfred notes directory.");
	return path;
}

export async function saveNote(
	call: SaveNoteToolCall,
	ctx: ToolExecutionContext,
	options: SaveNoteOptions = {},
): Promise<ToolResult<SaveNoteData | undefined>> {
	const started = Date.now();
	const notesDirectory = options.notesDirectory ?? defaultNotesDirectory();
	let path: string;
	try {
		path = resolveNotePath(call.filename, notesDirectory);
	} catch (cause) {
		return failed(ctx, cause instanceof Error ? cause.message : String(cause), Date.now() - started, false);
	}

	if (!isWellFormedNoteContent(call.content)) return failed(ctx, "Note content contains an unpaired Unicode surrogate.", Date.now() - started, false);
	const bytes = Buffer.byteLength(call.content, "utf8");
	if (bytes > MAX_NOTE_BYTES) return failed(ctx, `Note content exceeds the ${MAX_NOTE_BYTES}-byte limit.`, Date.now() - started, false);

	try {
		prepareNotesDirectory(notesDirectory, true);
	} catch (cause) {
		return failed(ctx, `Could not prepare Alfred notes: ${message(cause)}`, Date.now() - started, true);
	}

	const existed = existsSync(path);
	if (existed) {
		try {
			if (lstatSync(path).isSymbolicLink()) return failed(ctx, "Refusing to overwrite a symbolic-link note.", Date.now() - started, false);
		} catch (cause) {
			return failed(ctx, `Could not inspect the existing note: ${message(cause)}`, Date.now() - started, true);
		}
		if (call.overwrite !== true) return failed(ctx, `Note already exists: ${path}. Set overwrite to true to replace it.`, Date.now() - started, false);
	}

	const temporary = join(notesDirectory, `.${call.filename}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			fchmodSync(fd, 0o600);
			writeFileSync(fd, call.content, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// Verify the complete UTF-8 payload before the atomic publish point.
		if (statSync(temporary).size !== bytes || readFileSync(temporary, "utf8") !== call.content) throw new Error("Note verification failed before publish.");
		if (call.overwrite === true) {
			renameSync(temporary, path);
		} else {
			// link is an atomic no-replace publication: an intervening creator wins
			// with EEXIST instead of being silently overwritten.
			linkSync(temporary, path);
			unlinkSync(temporary);
		}
		const directoryFd = openSync(notesDirectory, "r");
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
	} catch (cause) {
		try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
		return failed(ctx, `Could not save note: ${message(cause)}`, Date.now() - started, true);
	}

	let opened = false;
	let openError: string | undefined;
	if (call.open !== false) {
		try {
			await (options.openFile ?? defaultOpenFile)(path);
			opened = true;
		} catch (cause) {
			openError = message(cause);
		}
	}
	const data: SaveNoteData = { path, filename: call.filename, bytes, opened, overwrote: existed, ...(openError ? { openError } : {}) };
	const text = opened
		? `Saved and opened ${path} (${bytes} bytes).`
		: call.open === false
			? `Saved ${path} (${bytes} bytes).`
			: `Saved ${path} (${bytes} bytes), but could not open it: ${openError}`;
	return {
		tool: "save_note",
		toolCallId: ctx.toolCallId,
		success: true,
		text,
		displayText: text,
		data,
		retryable: false,
		safety: { risk: "mutation", confirmation: "confirm" },
		timingMs: Date.now() - started,
	};
}

export function isWellFormedNoteContent(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
			index++;
		} else if (code >= 0xDC00 && code <= 0xDFFF) {
			return false;
		}
	}
	return true;
}

export function listNotes(ctx: ToolExecutionContext, options: SaveNoteOptions = {}): ToolResult<ListNotesData | undefined> {
	const started = Date.now();
	const directory = options.notesDirectory ?? defaultNotesDirectory();
	try {
		if (!existsSync(directory)) return noteResult("list_notes", ctx, `No notes saved in ${directory}.`, { directory, notes: [] }, Date.now() - started);
		prepareNotesDirectory(directory, false);
		const notes = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(?:md|txt)$/i.test(entry.name))
			.map((entry): NoteSummary => {
				const path = resolveNotePath(entry.name, directory);
				const stat = statSync(path);
				return { filename: entry.name, path, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
			})
			.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
			.slice(0, 500);
		const text = notes.length
			? notes.map((note) => `${note.filename} (${note.bytes} bytes, ${note.modifiedAt})`).join("\n")
			: `No notes saved in ${directory}.`;
		return noteResult("list_notes", ctx, text, { directory, notes }, Date.now() - started);
	} catch (cause) {
		return failed(ctx, `Could not list Alfred notes: ${message(cause)}`, Date.now() - started, true, "list_notes");
	}
}

export function readNote(call: ReadNoteToolCall, ctx: ToolExecutionContext, options: SaveNoteOptions = {}): ToolResult<ReadNoteData | undefined> {
	const started = Date.now();
	const directory = options.notesDirectory ?? defaultNotesDirectory();
	try {
		prepareNotesDirectory(directory, false);
		const path = resolveNotePath(call.filename, directory);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let file;
		let fullContent: string;
		try {
			file = fstatSync(fd);
			if (!file.isFile()) throw new Error("Note is not a regular file.");
			if (file.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds the ${MAX_NOTE_BYTES}-byte read limit.`);
			fullContent = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
		if (!isWellFormedNoteContent(fullContent)) throw new Error("Note contains malformed Unicode.");
		const limit = Math.min(MAX_NOTE_BYTES, Math.max(1, options.maxReadBytes ?? DEFAULT_NOTE_READ_BYTES));
		const content = truncateUtf8(fullContent, limit);
		const truncated = content !== fullContent;
		const data: ReadNoteData = { filename: call.filename, path, bytes: file.size, modifiedAt: file.mtime.toISOString(), content };
		const result = noteResult("read_note", ctx, truncated ? `${content}\n[truncated; open the note or request a narrower excerpt]` : content, data, Date.now() - started);
		if (truncated) result.truncation = { truncated: true, originalBytes: file.size, shownBytes: Buffer.byteLength(content, "utf8"), limitBytes: limit };
		return result;
	} catch (cause) {
		return failed(ctx, `Could not read note: ${message(cause)}`, Date.now() - started, false, "read_note");
	}
}

export async function openNote(call: OpenNoteToolCall, ctx: ToolExecutionContext, options: SaveNoteOptions = {}): Promise<ToolResult<OpenNoteData | undefined>> {
	const started = Date.now();
	const directory = options.notesDirectory ?? defaultNotesDirectory();
	try {
		prepareNotesDirectory(directory, false);
		const path = call.filename ? resolveNotePath(call.filename, directory) : directory;
		if (call.filename) {
			const file = lstatSync(path);
			if (file.isSymbolicLink() || !file.isFile()) throw new Error("Note is not a regular file.");
		}
		await (options.openFile ?? defaultOpenFile)(path);
		const data: OpenNoteData = { path, ...(call.filename ? { filename: call.filename } : {}), kind: call.filename ? "note" : "folder" };
		return noteResult("open_note", ctx, call.filename ? `Opened note ${path}.` : `Opened Notes folder ${path}.`, data, Date.now() - started);
	} catch (cause) {
		return failed(ctx, `Could not open ${call.filename ? "note" : "Notes folder"}: ${message(cause)}`, Date.now() - started, true, "open_note");
	}
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	const code = value.charCodeAt(end - 1);
	if (code >= 0xD800 && code <= 0xDBFF) end--;
	return value.slice(0, Math.max(0, end));
}

function prepareNotesDirectory(directory: string, mutate: boolean): void {
	if (!existsSync(directory)) {
		if (!mutate) throw new Error("Alfred Notes folder does not exist yet.");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const stat = lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Alfred Notes location must be a regular directory, not a symbolic link.");
	if (mutate) chmodSync(directory, 0o700);
}

function noteResult<T>(tool: "list_notes" | "read_note" | "open_note", ctx: ToolExecutionContext, text: string, data: T, timingMs: number): ToolResult<T> {
	return {
		tool,
		toolCallId: ctx.toolCallId,
		success: true,
		text,
		displayText: text,
		data,
		retryable: false,
		safety: { risk: "read", confirmation: "none" },
		timingMs,
	};
}

function defaultOpenFile(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("open", [path], (error) => error ? reject(error) : resolve());
	});
}

function failed(ctx: ToolExecutionContext, text: string, timingMs: number, retryable: boolean, tool: "save_note" | "list_notes" | "read_note" | "open_note" = "save_note"): ToolResult<undefined> {
	return {
		tool,
		toolCallId: ctx.toolCallId,
		success: false,
		text,
		displayText: text,
		retryable,
		failure: createStructuredFailure({
			stage: "execute",
			code: retryable ? "execution.internal_error" : "contract.invalid_input",
			component: tool.replaceAll("_", "-"),
			message: text,
			retryable,
			detector: { id: `alfred.${tool.replaceAll("_", "-")}.typed`, version: 1 },
		}),
		safety: tool === "save_note" ? { risk: "mutation", confirmation: "confirm" } : { risk: "read", confirmation: "none" },
		timingMs,
	};
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
