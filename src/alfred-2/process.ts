import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const ALFRED2_PID_FILE = join(homedir(), ".alfred", "alfred2.pid");

export interface PidFileOptions {
	pidFile?: string;
	pid?: number;
}

export interface AcquirePidFileResult {
	pidFile: string;
	pid: number;
	stalePid?: number;
}

export interface StopAlfred2Result {
	ok: boolean;
	status: "not_running" | "stale_removed" | "signaled" | "failed";
	pid?: number;
	pidFile: string;
	message: string;
}

export function readPidFile(pidFile = ALFRED2_PID_FILE): number | null {
	try {
		if (!existsSync(pidFile)) return null;
		const parsed = Number(readFileSync(pidFile, "utf-8").trim());
		return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

export function acquireAlfred2PidFile(options: PidFileOptions = {}): AcquirePidFileResult {
	const pidFile = options.pidFile ?? ALFRED2_PID_FILE;
	const pid = options.pid ?? process.pid;
	mkdirSync(dirname(pidFile), { recursive: true });

	const existingPid = readPidFile(pidFile);
	if (existingPid && existingPid !== pid) {
		if (isProcessRunning(existingPid)) {
			throw new Error(`Alfred 2.0 already appears to be running with PID ${existingPid}. Stop it with npm run alfred2:stop.`);
		}
		rmSync(pidFile, { force: true });
		writeFileSync(pidFile, `${pid}\n`, "utf-8");
		return { pidFile, pid, stalePid: existingPid };
	}

	writeFileSync(pidFile, `${pid}\n`, "utf-8");
	return { pidFile, pid };
}

export function releaseAlfred2PidFile(options: PidFileOptions = {}): void {
	const pidFile = options.pidFile ?? ALFRED2_PID_FILE;
	const pid = options.pid ?? process.pid;
	const existingPid = readPidFile(pidFile);
	if (existingPid === null || existingPid === pid) {
		rmSync(pidFile, { force: true });
	}
}

export async function stopAlfred2Process(options: PidFileOptions & { waitMs?: number } = {}): Promise<StopAlfred2Result> {
	const pidFile = options.pidFile ?? ALFRED2_PID_FILE;
	const pid = readPidFile(pidFile);
	if (!pid) {
		return { ok: true, status: "not_running", pidFile, message: "Alfred 2.0 is not running (no PID file)." };
	}
	if (!isProcessRunning(pid)) {
		rmSync(pidFile, { force: true });
		return { ok: true, status: "stale_removed", pid, pidFile, message: `Removed stale Alfred 2.0 PID file for PID ${pid}.` };
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		return { ok: false, status: "failed", pid, pidFile, message: `Failed to signal Alfred 2.0 PID ${pid}: ${String(error)}` };
	}

	const deadline = Date.now() + (options.waitMs ?? 3_000);
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!isProcessRunning(pid)) {
			rmSync(pidFile, { force: true });
			return { ok: true, status: "signaled", pid, pidFile, message: `Stopped Alfred 2.0 PID ${pid}.` };
		}
	}

	return { ok: true, status: "signaled", pid, pidFile, message: `Sent SIGTERM to Alfred 2.0 PID ${pid}.` };
}
