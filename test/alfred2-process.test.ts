import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireAlfred2PidFile, isProcessRunning, readPidFile, releaseAlfred2PidFile } from "../src/alfred-2/process.ts";

test("PID helpers acquire and release a pid file", () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "alfred2-pid-")), "alfred2.pid");
	const acquired = acquireAlfred2PidFile({ pidFile, pid: process.pid });
	assert.equal(acquired.pid, process.pid);
	assert.equal(readPidFile(pidFile), process.pid);
	releaseAlfred2PidFile({ pidFile, pid: process.pid });
	assert.equal(readPidFile(pidFile), null);
});

test("PID acquisition removes stale pid files", () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "alfred2-pid-")), "alfred2.pid");
	const stalePid = 999_999;
	writeFileSync(pidFile, `${stalePid}\n`, "utf-8");
	const acquired = acquireAlfred2PidFile({ pidFile, pid: process.pid });
	assert.equal(acquired.stalePid, stalePid);
	assert.equal(readPidFile(pidFile), process.pid);
	releaseAlfred2PidFile({ pidFile, pid: process.pid });
});

test("PID acquisition fails clearly when an active different process owns the file", () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "alfred2-pid-")), "alfred2.pid");
	writeFileSync(pidFile, `${process.pid}\n`, "utf-8");
	assert.equal(isProcessRunning(process.pid), true);
	assert.throws(() => acquireAlfred2PidFile({ pidFile, pid: process.pid + 1 }), /already appears to be running/);
});
