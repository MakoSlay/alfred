import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
	resolveFilePath,
	validatePathSafety,
	readFile,
	writeFile,
	editFile,
	type FileEdit,
} from "../src/alfred-2/tools/file.ts";
import type { ToolExecutionContext } from "../src/alfred-2/tool-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
	return {
		requestId: `req-${randomUUID()}`,
		toolCallId: `tc-${randomUUID()}`,
		cwd: undefined,
		risk: "read",
		...overrides,
	};
}

function setupTmpDir(): string {
	const dir = resolve(tmpdir(), `alfred2-file-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupTmpDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// resolveFilePath
// ---------------------------------------------------------------------------

test("resolveFilePath resolves relative path against cwd", () => {
	const dir = setupTmpDir();
	try {
		const result = resolveFilePath("foo/bar.txt", dir);
		assert.equal(result, resolve(dir, "foo/bar.txt"));
	} finally {
		cleanupTmpDir(dir);
	}
});

test("resolveFilePath resolves absolute path when within cwd", () => {
	const dir = setupTmpDir();
	try {
		const absPath = resolve(dir, "sub/file.txt");
		mkdirSync(resolve(dir, "sub"), { recursive: true });
		writeFileSync(absPath, "hello", "utf8");
		const result = resolveFilePath(absPath, dir);
		assert.equal(result, absPath);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("resolveFilePath rejects paths that escape cwd via ..", () => {
	const dir = setupTmpDir();
	try {
		assert.throws(
			() => resolveFilePath("../outside.txt", dir),
			{ message: /escapes/ },
		);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("resolveFilePath rejects absolute path outside cwd", () => {
	const dir = setupTmpDir();
	try {
		assert.throws(
			() => resolveFilePath("/etc/passwd", dir),
			{ message: /escapes/ },
		);
	} finally {
		cleanupTmpDir(dir);
	}
});

// ---------------------------------------------------------------------------
// validatePathSafety
// ---------------------------------------------------------------------------

test("validatePathSafety flags .ssh as blocked", () => {
	const dir = setupTmpDir();
	try {
		const sshPath = resolve(dir, ".ssh", "id_rsa");
		const safety = validatePathSafety(sshPath, dir);
		assert.equal(safety.confirmation, "blocked");
		assert.equal(safety.risk, "destructive");
		assert.ok(safety.blockedReason?.includes(".ssh"));
	} finally {
		cleanupTmpDir(dir);
	}
});

test("validatePathSafety blocks /etc paths", () => {
	const safety = validatePathSafety("/etc/hosts", "/tmp");
	assert.equal(safety.confirmation, "blocked");
	assert.equal(safety.risk, "destructive");
	assert.ok(safety.blockedReason?.includes("/etc"));
});

test("validatePathSafety flags .env for confirmation", () => {
	const dir = setupTmpDir();
	try {
		const envPath = resolve(dir, ".env");
		const safety = validatePathSafety(envPath, dir);
		assert.equal(safety.confirmation, "confirm");
		assert.equal(safety.risk, "mutation");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("validatePathSafety flags dotfiles for confirmation", () => {
	const dir = setupTmpDir();
	try {
		const dotPath = resolve(dir, ".gitignore");
		const safety = validatePathSafety(dotPath, dir);
		assert.equal(safety.confirmation, "confirm");
		assert.equal(safety.risk, "mutation");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("validatePathSafety returns none for normal files", () => {
	const dir = setupTmpDir();
	try {
		const normalPath = resolve(dir, "src", "index.ts");
		const safety = validatePathSafety(normalPath, dir);
		assert.equal(safety.confirmation, "none");
		assert.equal(safety.risk, "read");
	} finally {
		cleanupTmpDir(dir);
	}
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

test("readFile reads entire file", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "hello.txt");
		writeFileSync(filePath, "Hello, world!\n", "utf8");

		const result = readFile(makeCtx({ cwd: dir }), "hello.txt");
		assert.equal(result.success, true);
		assert.equal(result.text, "Hello, world!\n");
		assert.equal(result.data, "Hello, world!\n");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("readFile supports offset and limit (line-based, 0-indexed)", () => {
	const dir = setupTmpDir();
	try {
		const lines = ["line0", "line1", "line2", "line3", "line4", "line5"];
		const filePath = resolve(dir, "lines.txt");
		writeFileSync(filePath, lines.join("\n"), "utf8");

		const result = readFile(makeCtx({ cwd: dir }), "lines.txt", 2, 2);
		assert.equal(result.success, true);
		assert.equal(result.text, "line2\nline3");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("readFile rejects binary files (null bytes)", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "binary.bin");
		const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]);
		writeFileSync(filePath, buf);

		const result = readFile(makeCtx({ cwd: dir }), "binary.bin");
		assert.equal(result.success, false);
		assert.match(result.text, /binary/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("readFile rejects directory paths", () => {
	const dir = setupTmpDir();
	try {
		const subDir = resolve(dir, "subdir");
		mkdirSync(subDir, { recursive: true });

		const result = readFile(makeCtx({ cwd: dir }), "subdir");
		assert.equal(result.success, false);
		assert.match(result.text, /directory/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("readFile fails when cwd is not set", () => {
	const result = readFile(makeCtx({ cwd: undefined }), "file.txt");
	assert.equal(result.success, false);
	assert.match(result.text, /No workspace cwd/);
});

test("readFile fails for path escaping cwd", () => {
	const dir = setupTmpDir();
	try {
		const result = readFile(makeCtx({ cwd: dir }), "../outside.txt");
		assert.equal(result.success, false);
		assert.match(result.text, /escapes/);
	} finally {
		cleanupTmpDir(dir);
	}
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

test("writeFile creates file and parent directories", () => {
	const dir = setupTmpDir();
	try {
		const result = writeFile(makeCtx({ cwd: dir }), "sub/deep/file.txt", "content");
		assert.equal(result.success, true);
		assert.equal(result.data?.overwrote, false);

		const fullPath = resolve(dir, "sub/deep/file.txt");
		assert.equal(existsSync(fullPath), true);
		assert.equal(readFileSync(fullPath, "utf8"), "content");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("writeFile detects overwrite when file exists", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "existing.txt");
		writeFileSync(filePath, "old content", "utf8");

		const result = writeFile(makeCtx({ cwd: dir }), "existing.txt", "new content");
		assert.equal(result.success, true);
		assert.equal(result.data?.overwrote, true);
		assert.match(result.text, /overwrote/);

		assert.equal(readFileSync(filePath, "utf8"), "new content");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("writeFile fails when cwd is not set", () => {
	const result = writeFile(makeCtx({ cwd: undefined }), "file.txt", "content");
	assert.equal(result.success, false);
	assert.match(result.text, /No workspace cwd/);
});

test("writeFile fails for path escaping cwd", () => {
	const dir = setupTmpDir();
	try {
		const result = writeFile(makeCtx({ cwd: dir }), "../outside.txt", "content");
		assert.equal(result.success, false);
		assert.match(result.text, /escapes/);
	} finally {
		cleanupTmpDir(dir);
	}
});

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

test("editFile succeeds with exact text replacement", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "sample.ts");
		writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "const x = 1;", newText: "const x = 42;" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "sample.ts", edits);
		assert.equal(result.success, true);
		assert.match(result.text, /Applied 1 edit/);
		assert.match(result.text, /const x = 1/); // diff shows old line
		assert.match(result.text, /const x = 42/); // diff shows new line
		assert.equal(result.data?.diff !== undefined, true);

		const updated = readFileSync(filePath, "utf8");
		assert.equal(updated, "const x = 42;\nconst y = 2;\n");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile succeeds with multiple non-overlapping edits", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "multi.ts");
		writeFileSync(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "const a = 1;", newText: "const a = 10;" },
			{ oldText: "const c = 3;", newText: "const c = 30;" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "multi.ts", edits);
		assert.equal(result.success, true);
		assert.match(result.text, /Applied 2 edit/);

		const updated = readFileSync(filePath, "utf8");
		assert.equal(updated, "const a = 10;\nconst b = 2;\nconst c = 30;\n");
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile fails when oldText is missing", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "missing.ts");
		writeFileSync(filePath, "hello world\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "this text does not exist", newText: "replacement" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "missing.ts", edits);
		assert.equal(result.success, false);
		assert.equal(result.retryable, true);
		assert.match(result.text, /not found/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile fails when oldText is duplicated and returns narrowing guidance", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "dupe.ts");
		writeFileSync(filePath, "import foo;\n// some code\nimport foo;\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "import foo;", newText: "import bar;" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "dupe.ts", edits);
		assert.equal(result.success, false);
		assert.equal(result.retryable, true);
		assert.match(result.text, /matches 2 locations/);
		assert.match(result.text, /Narrow/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile fails when edits overlap", () => {
	const dir = setupTmpDir();
	try {
		const filePath = resolve(dir, "overlap.ts");
		writeFileSync(filePath, "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "const x = 1;\nconst y = 2;", newText: "const a = 10;" },
			{ oldText: "const y = 2;\nconst z = 3;", newText: "const b = 20;" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "overlap.ts", edits);
		assert.equal(result.success, false);
		assert.equal(result.retryable, true);
		assert.match(result.text, /overlap/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile fails when file does not exist", () => {
	const dir = setupTmpDir();
	try {
		const edits: FileEdit[] = [
			{ oldText: "anything", newText: "something" },
		];
		const result = editFile(makeCtx({ cwd: dir }), "nonexistent.ts", edits);
		assert.equal(result.success, false);
		assert.match(result.text, /not found/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("editFile fails when cwd is not set", () => {
	const edits: FileEdit[] = [
		{ oldText: "anything", newText: "something" },
	];
	const result = editFile(makeCtx({ cwd: undefined }), "file.ts", edits);
	assert.equal(result.success, false);
	assert.match(result.text, /No workspace cwd/);
});

test("editFile blocks unsafe paths", () => {
	const dir = setupTmpDir();
	try {
		const sshDir = resolve(dir, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(resolve(sshDir, "config"), "Host example\n", "utf8");

		const edits: FileEdit[] = [
			{ oldText: "Host example", newText: "Host changed" },
		];
		const result = editFile(makeCtx({ cwd: dir }), ".ssh/config", edits);
		assert.equal(result.success, false);
		assert.match(result.text, /blocked/);
	} finally {
		cleanupTmpDir(dir);
	}
});

// ---------------------------------------------------------------------------
// End-to-end safety test
// ---------------------------------------------------------------------------

test("readFile blocks unsafe paths (.ssh)", () => {
	const dir = setupTmpDir();
	try {
		const sshDir = resolve(dir, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(resolve(sshDir, "id_rsa"), "fake key", "utf8");

		const result = readFile(makeCtx({ cwd: dir }), ".ssh/id_rsa");
		assert.equal(result.success, false);
		assert.match(result.text, /blocked/);
	} finally {
		cleanupTmpDir(dir);
	}
});

test("writeFile blocks unsafe paths (.ssh)", () => {
	const dir = setupTmpDir();
	try {
		const result = writeFile(makeCtx({ cwd: dir }), ".ssh/id_rsa", "bad");
		assert.equal(result.success, false);
		assert.match(result.text, /blocked/);
	} finally {
		cleanupTmpDir(dir);
	}
});
