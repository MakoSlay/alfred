import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { formatPrWatchMemoryForContext } from "./watchers/pr-notifications.ts";

const execFileAsync = promisify(execFile);

export interface SystemContext {
	text: string;
	workspaceCount: number;
	prCount: number;
	notificationCount: number;
	gatheredAt: string;
}

interface CmuxWorkspace {
	ref: string;
	title: string;
	current_directory?: string;
	selected?: boolean;
	pinned?: boolean;
	index?: number;
	latest_submitted_at?: string | null;
	listening_ports?: number[];
	remote?: {
		active_terminal_sessions?: number;
	};
}

let cachedContext: SystemContext | null = null;
let cacheTime = 0;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_WORKSPACE_LIMIT = 10;
const DEFAULT_CMUX_TIMEOUT_MS = 8_000;
const DEFAULT_GIT_TIMEOUT_MS = 1_500;
const DEFAULT_WORKSPACE_RECENCY_PATH = join(homedir(), ".alfred", "workspace-recency.json");

interface WorkspaceRecencyEntry {
	title: string;
	lastSeenAt: string;
}

interface WorkspaceRecencyState {
	workspaces: Record<string, WorkspaceRecencyEntry>;
}

function contextCacheTtlMs(): number {
	const parsed = Number(process.env.ALFRED_CONTEXT_CACHE_MS ?? "");
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

function contextWorkspaceLimit(): number {
	const parsed = Number(process.env.ALFRED_CONTEXT_WORKSPACE_LIMIT ?? "");
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WORKSPACE_LIMIT;
}

function contextCmuxTimeoutMs(): number {
	const parsed = Number(process.env.ALFRED_CONTEXT_CMUX_TIMEOUT_MS ?? "");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CMUX_TIMEOUT_MS;
}

function contextGitTimeoutMs(): number {
	const parsed = Number(process.env.ALFRED_CONTEXT_GIT_TIMEOUT_MS ?? "");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GIT_TIMEOUT_MS;
}

export function createMinimalSystemContext(): SystemContext {
	const lines: string[] = [];
	pushCurrentDate(lines);
	lines.push("");
	lines.push("WORKSPACES: omitted for this request. Use refresh_context or ask a workspace/git/session question for live workspace state.");
	lines.push("\nNOTIFICATIONS: omitted for this request.");
	lines.push(`\n${formatPrWatchMemoryForContext()}`);
	return {
		text: lines.join("\n"),
		workspaceCount: 0,
		prCount: 0,
		notificationCount: 0,
		gatheredAt: new Date().toISOString(),
	};
}

export async function gatherSystemContext(forceFresh = false): Promise<SystemContext> {
	const now = Date.now();
	if (!forceFresh && cachedContext && (now - cacheTime) < contextCacheTtlMs()) {
		return cachedContext;
	}

	const lines: string[] = [];
	let workspaceCount = 0;
	let prCount = 0;
	let notificationCount = 0;

	pushCurrentDate(lines);
	lines.push("");

	// Gather cmux workspaces
	try {
		const { stdout } = await execFileAsync("cmux", ["workspace", "list", "--json"], {
			timeout: Math.max(contextCmuxTimeoutMs(), 1_000),
			encoding: "utf8",
		});
		const data = JSON.parse(stdout) as { workspaces?: CmuxWorkspace[] };
		const workspaces = data.workspaces ?? [];
		workspaceCount = workspaces.length;

		const recency = updateWorkspaceRecency(workspaces);
		const selectedWorkspaces = selectRelevantWorkspaces(workspaces, contextWorkspaceLimit(), recency);
		const omittedCount = Math.max(0, workspaces.length - selectedWorkspaces.length);
		lines.push(`WORKSPACES (${workspaces.length}; showing ${selectedWorkspaces.length} recent/relevant${omittedCount ? `, omitted ${omittedCount}` : ""}):`);

		const summaries = await Promise.all(selectedWorkspaces.map(summarizeWorkspace));
		for (const summary of summaries) {
			lines.push(...summary.lines);
			prCount += summary.prCount;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[context] cmux workspace list unavailable: ${message}`);
		lines.push(`WORKSPACES: (cmux unavailable: ${message.slice(0, 160)})`);
	}

	// Gather notifications
	try {
		const { stdout: notifRaw } = await execFileAsync("cmux", ["list-notifications"], {
			timeout: contextCmuxTimeoutMs(),
			encoding: "utf8",
		});
		// cmux list-notifications outputs text format
		const notifLines = notifRaw.trim().split("\n").filter(l => l.trim());
		notificationCount = notifLines.length;
		if (notifLines.length > 0) {
			lines.push(`\nNOTIFICATIONS (${notifLines.length}):`);
			for (const nl of notifLines.slice(0, 10)) {
				lines.push(`  ${nl.trim()}`);
			}
		} else {
			lines.push(`\nNOTIFICATIONS: none`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[context] cmux notifications unavailable: ${message}`);
		lines.push(`\nNOTIFICATIONS: (unavailable: ${message.slice(0, 160)})`);
	}

	lines.push(`\n${formatPrWatchMemoryForContext()}`);

	const text = lines.join("\n");

	// The cmux help text is large. Alfred's tool registry is the normal capability surface;
	// include raw cmux help only for explicit debugging/back-compat.
	let cmuxReference = "";
	if (/^(1|true|yes|on)$/i.test(process.env.ALFRED_INCLUDE_CMUX_HELP ?? "")) {
		try {
			const { stdout: cmuxHelp } = await execFileAsync("cmux", ["help"], {
				timeout: contextCmuxTimeoutMs(),
				encoding: "utf8",
			});
			cmuxReference = `\nCMUX COMMANDS REFERENCE:\n${cmuxHelp.trim()}`;
		} catch {
			// cmux help unavailable
		}
	}

	const context: SystemContext = {
		text: text + cmuxReference,
		workspaceCount,
		prCount,
		notificationCount,
		gatheredAt: new Date().toISOString(),
	};

	cachedContext = context;
	cacheTime = Date.now();
	return context;
}

export function selectRelevantWorkspaces(workspaces: CmuxWorkspace[], limit: number, recency: WorkspaceRecencyState = { workspaces: {} }): CmuxWorkspace[] {
	const safeLimit = Math.max(1, limit);
	return [...workspaces]
		.sort((a, b) => workspaceRelevanceScore(b, recency) - workspaceRelevanceScore(a, recency))
		.slice(0, safeLimit)
		.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
}

function workspaceRelevanceScore(workspace: CmuxWorkspace, recency: WorkspaceRecencyState): number {
	const cmuxLatest = workspace.latest_submitted_at ? Date.parse(workspace.latest_submitted_at) : Number.NaN;
	const rememberedLatest = Date.parse(recency.workspaces[workspace.ref]?.lastSeenAt ?? "");
	const latest = Math.max(
		Number.isFinite(cmuxLatest) ? cmuxLatest : 0,
		Number.isFinite(rememberedLatest) ? rememberedLatest : 0,
	);
	const latestScore = latest > 0 ? latest / 1_000 : 0;
	const index = workspace.index ?? 1_000;
	return latestScore
		+ (workspace.selected ? 10_000_000_000 : 0)
		+ ((workspace.remote?.active_terminal_sessions ?? 0) > 0 ? 1_000_000_000 : 0)
		+ ((workspace.listening_ports?.length ?? 0) > 0 ? 100_000_000 : 0)
		+ (workspace.pinned ? 10_000_000 : 0)
		+ Math.max(0, 10_000 - index);
}

function updateWorkspaceRecency(workspaces: CmuxWorkspace[], now = new Date()): WorkspaceRecencyState {
	const state = loadWorkspaceRecency();
	let changed = false;
	for (const workspace of workspaces) {
		const latest = workspace.latest_submitted_at ? new Date(workspace.latest_submitted_at) : null;
		const shouldMarkNow = workspace.selected || ((workspace.remote?.active_terminal_sessions ?? 0) > 0);
		const seenAt = shouldMarkNow ? now : latest && Number.isFinite(latest.getTime()) ? latest : null;
		if (!seenAt) continue;
		const current = Date.parse(state.workspaces[workspace.ref]?.lastSeenAt ?? "");
		if (!Number.isFinite(current) || seenAt.getTime() > current || state.workspaces[workspace.ref]?.title !== workspace.title) {
			state.workspaces[workspace.ref] = { title: workspace.title, lastSeenAt: seenAt.toISOString() };
			changed = true;
		}
	}
	if (changed) saveWorkspaceRecency(state);
	return state;
}

function loadWorkspaceRecency(path = workspaceRecencyPath()): WorkspaceRecencyState {
	try {
		if (!existsSync(path)) return { workspaces: {} };
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceRecencyState>;
		return { workspaces: parsed.workspaces && typeof parsed.workspaces === "object" ? { ...parsed.workspaces } : {} };
	} catch {
		return { workspaces: {} };
	}
}

function saveWorkspaceRecency(state: WorkspaceRecencyState, path = workspaceRecencyPath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort recency memory; Alfred can still fall back to cmux ordering.
	}
}

function workspaceRecencyPath(): string {
	return process.env.ALFRED_WORKSPACE_RECENCY_PATH?.trim() || DEFAULT_WORKSPACE_RECENCY_PATH;
}

async function summarizeWorkspace(ws: CmuxWorkspace): Promise<{ lines: string[]; prCount: number }> {
	const lines: string[] = [];
	let prCount = 0;
	const cwd = ws.current_directory ?? "unknown";
	const marker = ws.selected ? " [current]" : "";
	let gitInfo = "";

	const [branchResult, statusResult, sidebarResult] = await Promise.all([
		cwd && cwd !== "unknown"
			? execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: contextGitTimeoutMs(), encoding: "utf8" }).then((r) => r.stdout.trim()).catch(() => "")
			: Promise.resolve(""),
		cwd && cwd !== "unknown"
			? execFileAsync("git", ["-C", cwd, "status", "--porcelain"], { timeout: contextGitTimeoutMs(), encoding: "utf8" }).then((r) => r.stdout.trim()).catch(() => null)
			: Promise.resolve<string | null>(null),
		execFileAsync("cmux", ["sidebar-state", "--workspace", ws.ref], { timeout: contextCmuxTimeoutMs(), encoding: "utf8" }).then((r) => r.stdout).catch(() => ""),
	]);

	if (branchResult) {
		gitInfo = ` | branch: ${branchResult}`;
		gitInfo += statusResult === null ? " (status unknown)" : statusResult.length > 0 ? " (DIRTY)" : " (clean)";
	}

	lines.push(`  ${ws.title}${marker} | ref:${ws.ref} | ${cwd}${gitInfo}`);

	if (sidebarResult) {
		let tabCount = 0;
		let activeTabCount = 0;
		for (const line of sidebarResult.split("\n")) {
			if (line.startsWith("pr=")) {
				const prInfo = line.substring(3).trim();
				if (prInfo && prInfo !== "none") {
					lines.push(`    PR: ${prInfo}`);
					prCount++;
				}
			}
			if (line.startsWith("git_branch=")) {
				const branchInfo = line.substring(11).trim();
				if (branchInfo && !gitInfo) {
					lines.push(`    ${branchInfo}`);
				}
			}
			if (line.startsWith("status_count=")) {
				tabCount = parseInt(line.substring(13).trim(), 10) || 0;
			}
			// Count active (non-Ready) tabs from pi-cmux-status lines
			if (line.includes("pi-cmux-status") && !line.includes("Ready")) {
				activeTabCount++;
			}
		}
		if (tabCount > 0) {
			const summary = activeTabCount > 0
				? `${tabCount} tabs (${activeTabCount} active)`
				: `${tabCount} tabs`;
			lines.push(`    ${summary}`);
		}
	}

	return { lines, prCount };
}

function pushCurrentDate(lines: string[]): void {
	const currentDate = new Date();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
	lines.push(`CURRENT DATE/TIME: ${currentDate.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} (${timeZone}; UTC ${currentDate.toISOString()})`);
}

export function estimateTokens(text: string): number {
	// Rough heuristic: ~3.5 chars/token for mixed code+prose.
	// Not suitable for precise billing; used for context-pressure gating only.
	return Math.ceil(text.length / 3.5);
}
