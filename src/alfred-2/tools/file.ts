import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync } from "node:fs";
import { resolve, sep, dirname, basename, relative, normalize } from "node:path";
import { homedir } from "node:os";
import {
	ALFRED_AUTONOMOUS_DEFAULTS,
	type ToolExecutionContext,
	type ToolResult,
	type ToolSafetyMetadata,
} from "../tool-types.ts";
import { saveUndoBackup, recordUndo } from "../undo.ts";

// ---------------------------------------------------------------------------
// File edit input type
// ---------------------------------------------------------------------------

export interface FileEdit {
	oldText: string;
	newText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size to read (1 MiB). Larger files are rejected before reading. */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Bytes to sample for binary detection. */
const BINARY_SAMPLE_BYTES = 8_192;

// ---------------------------------------------------------------------------
// resolveFilePath
// ---------------------------------------------------------------------------

export function resolveFilePath(rawPath: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const resolved = resolve(resolvedCwd, rawPath);

	// Normalize both to handle trailing slashes and symlink inconsistencies.
	const normCwd = normalize(resolvedCwd) + sep;
	const normTarget = normalize(resolved) + sep;

	if (!normTarget.startsWith(normCwd)) {
		throw Object.assign(
			new Error(`Path escapes the workspace cwd: ${rawPath}`),
			{ code: "PATH_ESCAPES_CWD" },
		);
	}

	return resolved;
}

// ---------------------------------------------------------------------------
// validatePathSafety
// ---------------------------------------------------------------------------

const BLOCKED_PREFIXES = [
	"/etc/",
	"/etc",
	"/boot/",
	"/boot",
	"/sys/",
	"/sys",
	"/proc/",
	"/proc",
	"/dev/",
	"/dev",
	"/Library/",
	"/Library",
	"/System/",
	"/System",
];

const BLOCKED_COMPONENTS = new Set([".ssh"]);

const CONFIRMATION_DOTFILES = new Set([
	".env",
	".gitconfig",
	".npmrc",
	".aws",
	".config",
	".local",
	".bashrc",
	".zshrc",
	".profile",
	".bash_profile",
	".zprofile",
]);

export function validatePathSafety(
	absolutePath: string,
	cwd: string,
): ToolSafetyMetadata {
	const homedirPath = homedir();
	const resolvedHome = resolve(homedirPath);

	// 1. Check blocked prefixes (system config paths).
	for (const prefix of BLOCKED_PREFIXES) {
		if (absolutePath === prefix || absolutePath.startsWith(prefix + sep)) {
			return {
				risk: "destructive",
				confirmation: "blocked",
				blockedReason: `Path is a protected system location: ${absolutePath}`,
			};
		}
	}

	// 2. Check blocked path components (.ssh etc.).
	const relativePath = relative(cwd, absolutePath);
	const components = relativePath.split(sep);
	for (const comp of components) {
		if (BLOCKED_COMPONENTS.has(comp)) {
			return {
				risk: "destructive",
				confirmation: "blocked",
				blockedReason: `Path contains blocked component "${comp}": ${absolutePath}`,
			};
		}
	}

	// 3. Check for Alfred daemon env file.
	if (absolutePath === resolve(resolvedHome, ".alfred", "daemon.env")) {
		return {
			risk: "mutation",
			confirmation: "confirm",
			preview: `Alfred daemon environment file: ${absolutePath}. Changes may affect the running daemon.`,
		};
	}

	// 4. Check for dotfiles / .env that need confirmation.
	const base = basename(absolutePath);
	if (base === ".env") {
		return {
			risk: "mutation",
			confirmation: "confirm",
			preview: `Environment file: ${absolutePath}.`,
		};
	}

	// Check if any path component after cwd is a hidden directory or if the file itself is a dotfile.
	for (const comp of components) {
		if (comp.startsWith(".") && CONFIRMATION_DOTFILES.has(comp)) {
			return {
				risk: "mutation",
				confirmation: "confirm",
				preview: `Dotfile / hidden path: ${absolutePath}.`,
			};
		}
	}

	// Check if the base name is any dotfile (files starting with .)
	if (base.startsWith(".") && base !== "." && base !== "..") {
		return {
			risk: "mutation",
			confirmation: "confirm",
			preview: `Dotfile: ${absolutePath}.`,
		};
	}

	return { risk: "read", confirmation: "none" };
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

export function readFile(
	ctx: ToolExecutionContext,
	path: string,
	offset?: number,
	limit?: number,
): ToolResult<string | undefined> {
	const t0 = Date.now();

	if (!ctx.cwd) {
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: "No workspace cwd available. Cannot resolve file paths.",
			retryable: false,
			safety: { risk: "read", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	let absolutePath: string;
	try {
		absolutePath = resolveFilePath(path, ctx.cwd);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: message,
			retryable: false,
			safety: { risk: "read", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	const safety = validatePathSafety(absolutePath, ctx.cwd);
	if (safety.confirmation === "blocked") {
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: safety.blockedReason ?? "Path is blocked for safety.",
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	// Check exists and is not a directory.
	try {
		const st = lstatSync(absolutePath);
		if (st.isDirectory()) {
			return {
				tool: "read_file",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Path is a directory, not a file: ${absolutePath}`,
				retryable: false,
				safety,
				timingMs: Date.now() - t0,
			};
		}
	} catch {
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `File not found: ${absolutePath}`,
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	// Size check before reading.
	const stat = statSync(absolutePath);
	if (stat.size > MAX_FILE_SIZE_BYTES) {
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `File too large (${stat.size} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`,
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	const raw = readFileSync(absolutePath, "utf8");

	// Binary detection: null bytes in the first sample.
	const sample = raw.slice(0, BINARY_SAMPLE_BYTES);
	if (sample.includes("\0")) {
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `File appears to be binary (contains null bytes): ${absolutePath}`,
			retryable: false,
			safety: { ...safety, risk: "read" },
			timingMs: Date.now() - t0,
		};
	}

	// Apply offset / limit (line-based, 0-indexed offset).
	const lines = raw.split("\n");
	let selected = lines;
	if (offset !== undefined) {
		if (offset < 0 || offset >= lines.length) {
			return {
				tool: "read_file",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Offset ${offset} is out of range (file has ${lines.length} lines, 0-indexed).`,
				retryable: true,
				safety,
				timingMs: Date.now() - t0,
			};
		}
		selected = lines.slice(offset);
	}
	if (limit !== undefined && limit > 0) {
		selected = selected.slice(0, limit);
	}

	let text = selected.join("\n");
	const outputLimit = ALFRED_AUTONOMOUS_DEFAULTS.toolOutputLimitBytes;
	const originalBytes = Buffer.byteLength(text, "utf8");

	if (originalBytes > outputLimit) {
		const truncated = Buffer.from(text, "utf8").subarray(0, outputLimit).toString("utf8");
		const shownBytes = Buffer.byteLength(truncated, "utf8");
		return {
			tool: "read_file",
			toolCallId: ctx.toolCallId,
			success: true,
			text: `${truncated}\n[truncated ${originalBytes - shownBytes} bytes]`,
			data: text,
			truncation: { truncated: true, originalBytes, shownBytes, limitBytes: outputLimit },
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	return {
		tool: "read_file",
		toolCallId: ctx.toolCallId,
		success: true,
		text,
		data: text,
		retryable: false,
		safety,
		timingMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

export function writeFile(
	ctx: ToolExecutionContext,
	path: string,
	content: string,
): ToolResult<{ overwrote: boolean } | undefined> {
	const t0 = Date.now();

	if (!ctx.cwd) {
		return {
			tool: "write_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: "No workspace cwd available. Cannot resolve file paths.",
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	let absolutePath: string;
	try {
		absolutePath = resolveFilePath(path, ctx.cwd);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "write_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: message,
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	const safety = validatePathSafety(absolutePath, ctx.cwd);
	if (safety.confirmation === "blocked") {
		return {
			tool: "write_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: safety.blockedReason ?? "Path is blocked for safety.",
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	const alreadyExists = existsSync(absolutePath);

	// Create parent directories.
	const dir = dirname(absolutePath);
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "write_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `Failed to create parent directories: ${message}`,
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	try {
		const undoEntry = saveUndoBackup(absolutePath, "write_file");
		if (undoEntry) recordUndo(undoEntry);
		writeFileSync(absolutePath, content, "utf8");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "write_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `Failed to write file: ${message}`,
			retryable: true,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	const overwriteNote = alreadyExists ? " (overwrote existing file)" : "";

	return {
		tool: "write_file",
		toolCallId: ctx.toolCallId,
		success: true,
		text: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${absolutePath}${overwriteNote}.`,
		data: { overwrote: alreadyExists },
		retryable: false,
		safety: {
			...safety,
			...(alreadyExists ? { risk: "mutation" as const, preview: `Overwrote existing file: ${absolutePath}` } : {}),
		},
		timingMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

export function editFile(
	ctx: ToolExecutionContext,
	path: string,
	edits: FileEdit[],
): ToolResult<{ diff: string } | undefined> {
	const t0 = Date.now();

	if (!ctx.cwd) {
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: "No workspace cwd available. Cannot resolve file paths.",
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	if (edits.length === 0) {
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: "No edits provided.",
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	let absolutePath: string;
	try {
		absolutePath = resolveFilePath(path, ctx.cwd);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: message,
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}

	const safety = validatePathSafety(absolutePath, ctx.cwd);
	if (safety.confirmation === "blocked") {
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: safety.blockedReason ?? "Path is blocked for safety.",
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	if (!existsSync(absolutePath)) {
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `File not found: ${absolutePath}`,
			retryable: false,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	const original = readFileSync(absolutePath, "utf8");
	const originalLines = original.split("\n");

	// Find all occurrences for each edit. Each must match exactly once.
	interface ResolvedEdit {
		index: number;
		oldText: string;
		newText: string;
		startPos: number;
		endPos: number;
	}

	const resolved: ResolvedEdit[] = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i]!;
		const occurrences: number[] = [];
		let pos = 0;
		while ((pos = original.indexOf(edit.oldText, pos)) !== -1) {
			occurrences.push(pos);
			pos += edit.oldText.length;
		}

		if (occurrences.length === 0) {
			return {
				tool: "edit_file",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Edit ${i + 1}: oldText was not found in the file. Verify the exact text (including whitespace) and try again.`,
				retryable: true,
				safety,
				timingMs: Date.now() - t0,
			};
		}

		if (occurrences.length > 1) {
			return {
				tool: "edit_file",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Edit ${i + 1}: oldText matches ${occurrences.length} locations in the file. Narrow the oldText to make it unique. For example, include more surrounding lines or a unique adjacent identifier.`,
				retryable: true,
				safety,
				timingMs: Date.now() - t0,
			};
		}

		resolved.push({
			index: i,
			oldText: edit.oldText,
			newText: edit.newText,
			startPos: occurrences[0]!,
			endPos: occurrences[0]! + edit.oldText.length,
		});
	}

	// Check for overlapping edits.
	resolved.sort((a, b) => a.startPos - b.startPos);
	for (let i = 1; i < resolved.length; i++) {
		if (resolved[i]!.startPos < resolved[i - 1]!.endPos) {
			return {
				tool: "edit_file",
				toolCallId: ctx.toolCallId,
				success: false,
				text: `Edits ${resolved[i - 1]!.index + 1} and ${resolved[i]!.index + 1} overlap. Adjust the oldText values so they target distinct, non-overlapping regions of the file.`,
				retryable: true,
				safety,
				timingMs: Date.now() - t0,
			};
		}
	}

	// Apply edits from end to start to preserve positions.
	resolved.sort((a, b) => b.startPos - a.startPos);

	let modified = original;
	for (const edit of resolved) {
		modified = modified.slice(0, edit.startPos) + edit.newText + modified.slice(edit.endPos);
	}

	// Build diff preview.
	const undoEntry = saveUndoBackup(absolutePath, "edit_file");
	if (undoEntry) recordUndo(undoEntry);
	const diffLines = buildDiffPreview(originalLines, resolved);
	const diffText = diffLines.join("\n");

	try {
		writeFileSync(absolutePath, modified, "utf8");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool: "edit_file",
			toolCallId: ctx.toolCallId,
			success: false,
			text: `Failed to write file: ${message}`,
			retryable: true,
			safety,
			timingMs: Date.now() - t0,
		};
	}

	return {
		tool: "edit_file",
		toolCallId: ctx.toolCallId,
		success: true,
		text: `Applied ${edits.length} edit(s) to ${absolutePath}:\n\n${diffText}`,
		data: { diff: diffText },
		retryable: false,
		safety,
		timingMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// buildDiffPreview
// ---------------------------------------------------------------------------

function buildDiffPreview(
	originalLines: string[],
	sortedEdits: { index: number; oldText: string; newText: string; startPos: number }[],
): string[] {
	const contextLines = 2;
	const result: string[] = [];

	// Sort back to original order for display.
	const editsInOrder = [...sortedEdits].sort((a, b) => a.index - b.index);

	for (const edit of editsInOrder) {
		// Find the line numbers for this edit.
		let startLine = 0;
		let pos = 0;
		for (let i = 0; i < originalLines.length; i++) {
			const lineLen = originalLines[i]!.length + 1; // +1 for \n
			if (pos + lineLen > edit.startPos) {
				startLine = i;
				break;
			}
			pos += lineLen;
		}

		const ctxStart = Math.max(0, startLine - contextLines);
		const ctxEnd = Math.min(originalLines.length, startLine + edit.oldText.split("\n").length + contextLines);

		result.push(`@@ Edit ${edit.index + 1} (lines ${ctxStart + 1}-${ctxEnd}) @@`);

		for (let i = ctxStart; i < ctxEnd; i++) {
			const isRemovedLine =
				i >= startLine && i < startLine + edit.oldText.split("\n").length;
			if (isRemovedLine) {
				result.push(`-${originalLines[i]}`);
			} else {
				result.push(` ${originalLines[i]}`);
			}
		}

		// Show new text.
		for (const line of edit.newText.split("\n")) {
			result.push(`+${line}`);
		}

		result.push("");
	}

	return result;
}
