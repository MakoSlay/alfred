import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProactiveEventStore, proactiveEventStore } from "../proactive/event-store.ts";
import type { ProactiveEvent, RuntimeInterruptionState } from "../proactive/types.ts";
import { notify as defaultNotify, speak as defaultSpeak } from "../speech.ts";
import { executeDelivery } from "./wellness.ts";
import type { ProactiveDeliveryFunctions, WatcherEmitResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_PR_WATCH_INTERVAL_MS = 2 * 60 * 1000;
export const DEFAULT_PR_WATCH_STATE_PATH = join(homedir(), ".alfred", "pr-watcher-state.json");
export const DEFAULT_PR_WATCH_MEMORY_PATH = join(homedir(), ".alfred", "pr-watch-memory.md");
export const DEFAULT_PR_WATCH_MEMORY_LINES = 80;
export const DEFAULT_PR_WATCH_MAX_PER_TICK = 3;

export interface PrWatcherExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type PrWatcherExecFn = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<PrWatcherExecResult>;

export interface PrWatcherState {
	seen: Record<string, string>;
	lastCheckedAt: string | null;
	lastError: string | null;
}

export interface PrWatcherStatus {
	lastCheckedAt: string | null;
	lastError: string | null;
	seenCount: number;
	memoryPath: string;
}

export interface PrNotificationWatcherOptions {
	eventStore?: ProactiveEventStore;
	delivery?: ProactiveDeliveryFunctions;
	exec?: PrWatcherExecFn;
	statePath?: string;
	memoryPath?: string;
	memoryLines?: number;
	maxPerTick?: number;
	idFactory?: () => string;
}

export interface PrNotificationTickInput {
	runtime: RuntimeInterruptionState;
}

interface GhNotification {
	id?: string;
	reason?: string;
	updated_at?: string;
	unread?: boolean;
	subject?: {
		title?: string;
		type?: string;
		url?: string;
		latest_comment_url?: string;
	};
	repository?: {
		full_name?: string;
		html_url?: string;
	};
}

interface GhPullRequest {
	number?: number;
	title?: string;
	html_url?: string;
	state?: string;
	user?: { login?: string };
}

interface PrMemoryEntry {
	/** When Alfred noticed and stored the notification. */
	surfacedAt: Date;
	/** GitHub notification thread update timestamp. This is the event time users care about. */
	notificationUpdatedAt: string;
	repo: string;
	number: number;
	title: string;
	reason: string;
	url: string;
}

const defaultExec: PrWatcherExecFn = async (command, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			timeout: options?.timeoutMs ?? 15_000,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
	} catch (error: any) {
		return {
			stdout: error?.stdout?.trim?.() ?? "",
			stderr: error?.stderr?.trim?.() ?? error?.message ?? "Command failed",
			exitCode: typeof error?.code === "number" ? error.code : 1,
		};
	}
};

export class PrNotificationWatcher {
	private readonly eventStore: ProactiveEventStore;
	private readonly delivery: ProactiveDeliveryFunctions;
	private readonly exec: PrWatcherExecFn;
	private readonly statePath: string;
	private readonly memoryPath: string;
	private readonly memoryLines: number;
	private readonly maxPerTick: number;
	private readonly idFactory: () => string;
	private state: PrWatcherState;
	private login: string | null = null;

	constructor(options: PrNotificationWatcherOptions = {}) {
		this.eventStore = options.eventStore ?? proactiveEventStore;
		this.delivery = options.delivery ?? {
			speak: defaultSpeak,
			notify: defaultNotify,
			isMuted: () => false,
		};
		this.exec = options.exec ?? defaultExec;
		this.statePath = options.statePath ?? DEFAULT_PR_WATCH_STATE_PATH;
		this.memoryPath = options.memoryPath ?? DEFAULT_PR_WATCH_MEMORY_PATH;
		this.memoryLines = options.memoryLines ?? DEFAULT_PR_WATCH_MEMORY_LINES;
		this.maxPerTick = options.maxPerTick ?? DEFAULT_PR_WATCH_MAX_PER_TICK;
		this.idFactory = options.idFactory ?? (() => `pr-watch-${randomUUID()}`);
		this.state = loadPrWatcherState(this.statePath);
	}

	async tick(input: PrNotificationTickInput): Promise<WatcherEmitResult[]> {
		const checkedAt = input.runtime.now.toISOString();
		try {
			const login = await this.getLogin();
			const notifications = await this.fetchNotifications();
			const pullNotifications = notifications
				.filter((notification) => notification.subject?.type === "PullRequest" && notification.id && notification.updated_at)
				.filter((notification) => this.state.seen[notification.id!] !== notification.updated_at)
				.sort((a, b) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime())
				.slice(0, Math.max(1, this.maxPerTick))
				.reverse();

			const emitted: WatcherEmitResult[] = [];
			for (const notification of pullNotifications) {
				const apiPath = apiPathFromSubjectUrl(notification.subject?.url);
				if (!apiPath || !notification.id || !notification.updated_at) continue;
				const pr = await this.fetchPullRequest(apiPath);
				if (!pr) continue;
				this.state.seen[notification.id] = notification.updated_at;
				if (pr.user?.login !== login || !pr.number || !pr.html_url) continue;

				const repo = notification.repository?.full_name ?? repoFromApiPath(apiPath) ?? "unknown repo";
				const title = pr.title || notification.subject?.title || "Untitled pull request";
				const reason = humanReason(notification.reason || "notification");
				appendPrWatchMemory({ surfacedAt: input.runtime.now, notificationUpdatedAt: notification.updated_at, repo, number: pr.number, title, reason, url: pr.html_url }, this.memoryPath, this.memoryLines);

				const event = makePrEvent({
					id: this.idFactory(),
					now: input.runtime.now,
					repo,
					number: pr.number,
					title,
					reason,
					url: pr.html_url,
					notificationId: notification.id,
					notificationUpdatedAt: notification.updated_at,
				});
				const decision = this.eventStore.decide(event, input.runtime);
				this.eventStore.recordEvent(event);
				const delivered = await executeDelivery(event, decision, this.delivery);
				if (delivered) this.eventStore.recordCooldownsForDecision(event, decision, input.runtime.now.getTime());
				emitted.push({ event, decision, delivered });
			}

			this.state.lastCheckedAt = checkedAt;
			this.state.lastError = null;
			trimSeen(this.state.seen);
			savePrWatcherState(this.statePath, this.state);
			return emitted;
		} catch (error) {
			this.state.lastCheckedAt = checkedAt;
			this.state.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
			savePrWatcherState(this.statePath, this.state);
			return [];
		}
	}

	getStatus(): PrWatcherStatus {
		return {
			lastCheckedAt: this.state.lastCheckedAt,
			lastError: this.state.lastError,
			seenCount: Object.keys(this.state.seen).length,
			memoryPath: this.memoryPath,
		};
	}

	private async getLogin(): Promise<string> {
		if (this.login) return this.login;
		const result = await this.exec("gh", ["api", "/user"], { timeoutMs: 10_000 });
		if (result.exitCode !== 0) throw new Error(result.stderr || "gh api user failed");
		const parsed = JSON.parse(result.stdout) as { login?: string };
		if (!parsed.login) throw new Error("Could not determine GitHub login.");
		this.login = parsed.login;
		return this.login;
	}

	private async fetchNotifications(): Promise<GhNotification[]> {
		const result = await this.exec("gh", ["api", "-X", "GET", "/notifications", "--paginate", "--slurp", "-F", "per_page=50", "-F", "all=false", "-F", "participating=false"], { timeoutMs: 20_000 });
		if (result.exitCode !== 0) throw new Error(result.stderr || "gh api notifications failed");
		return normalizeNotifications(JSON.parse(result.stdout));
	}

	private async fetchPullRequest(apiPath: string): Promise<GhPullRequest | null> {
		const result = await this.exec("gh", ["api", apiPath.startsWith("/") ? apiPath : `/${apiPath}`], { timeoutMs: 10_000 });
		if (result.exitCode !== 0) return null;
		return JSON.parse(result.stdout) as GhPullRequest;
	}
}

export function prWatcherEnabled(): boolean {
	return /^(1|true|yes|on)$/i.test(process.env.ALFRED_PR_WATCHER ?? "");
}

export function prWatcherIntervalMs(): number {
	const parsed = Number(process.env.ALFRED_PR_WATCH_INTERVAL_MS ?? "");
	return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : DEFAULT_PR_WATCH_INTERVAL_MS;
}

export function loadPrWatcherState(path = DEFAULT_PR_WATCH_STATE_PATH): PrWatcherState {
	try {
		if (!existsSync(path)) return defaultState();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PrWatcherState>;
		return {
			seen: parsed.seen && typeof parsed.seen === "object" ? { ...parsed.seen } : {},
			lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : null,
			lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
		};
	} catch {
		return defaultState();
	}
}

export function savePrWatcherState(path: string, state: PrWatcherState): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best-effort watcher state.
	}
}

export function appendPrWatchMemory(entry: PrMemoryEntry, path = DEFAULT_PR_WATCH_MEMORY_PATH, maxLines = DEFAULT_PR_WATCH_MEMORY_LINES): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const existingLines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
		const entries = existingLines.filter((line) => line.startsWith("- "));
		entries.push(formatMemoryLine(entry));
		const kept = entries.slice(-Math.max(1, maxLines));
		writeFileSync(path, ["# PR Watch Memory", "", ...kept, ""].join("\n"), "utf8");
	} catch {
		// Best-effort context memory.
	}
}

export function formatPrWatchMemoryForContext(path = DEFAULT_PR_WATCH_MEMORY_PATH, maxLines = 8): string {
	try {
		if (!existsSync(path)) return "PR WATCH MEMORY: (none)";
		const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.startsWith("- ")).slice(-Math.max(1, maxLines));
		return lines.length
			? `PR WATCH MEMORY:\nNote: line timestamps marked "Alfred surfaced" are when Alfred noticed the notification, not when GitHub created or updated it. Prefer "GitHub notification updated" when present.\n${lines.map(normalizeMemoryLineForContext).join("\n")}`
			: "PR WATCH MEMORY: (none)";
	} catch {
		return "PR WATCH MEMORY: (unavailable)";
	}
}

function defaultState(): PrWatcherState {
	return { seen: {}, lastCheckedAt: null, lastError: null };
}

function trimSeen(seen: Record<string, string>, max = 500): void {
	const entries = Object.entries(seen);
	if (entries.length <= max) return;
	for (const [key] of entries.slice(0, entries.length - max)) delete seen[key];
}

function normalizeNotifications(parsed: unknown): GhNotification[] {
	if (!Array.isArray(parsed)) return [];
	if (parsed.every((item) => Array.isArray(item))) return parsed.flat() as GhNotification[];
	return parsed as GhNotification[];
}

function apiPathFromSubjectUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.pathname.replace(/^\/+/, "");
	} catch {
		return url.replace(/^https:\/\/api\.github\.com\//, "").replace(/^\/+/, "") || null;
	}
}

function repoFromApiPath(apiPath: string): string | null {
	const match = apiPath.match(/^repos\/([^/]+\/[^/]+)\/pulls\/\d+$/);
	return match?.[1] ?? null;
}

function humanReason(reason: string): string {
	return reason.replace(/_/g, " ").replace(/\s+/g, " ").trim() || "notification";
}

function makePrEvent(params: {
	id: string;
	now: Date;
	repo: string;
	number: number;
	title: string;
	reason: string;
	url: string;
	notificationId: string;
	notificationUpdatedAt: string;
}): ProactiveEvent {
	const spokenRepo = params.repo.replace(/[\/_-]+/g, " ");
	return {
		id: params.id,
		watcherId: "github.pr-notifications",
		kind: "pr_notification",
		priority: "important",
		title: `PR ${params.number}: ${params.reason}`,
		message: `Sir, I found an unread GitHub notification from ${formatNotificationTimestamp(params.notificationUpdatedAt)}. Your pull request ${params.number} in ${spokenRepo} has a ${params.reason} notification. ${params.title}.`,
		createdAt: params.now.toISOString(),
		dedupeKey: `github-pr:${params.notificationId}:${params.notificationUpdatedAt}`,
		sourceRefs: [{ type: "github_pr", label: `${params.repo}#${params.number}`, url: params.url }],
		privacy: { mayStoreMessage: true },
		metadata: {
			repo: params.repo,
			number: params.number,
			reason: params.reason,
			notificationId: params.notificationId,
			notificationUpdatedAt: params.notificationUpdatedAt,
		},
	};
}

function formatMemoryLine(entry: PrMemoryEntry): string {
	return `- Alfred surfaced ${formatLocalMinute(entry.surfacedAt)}; GitHub notification updated ${formatNotificationTimestamp(entry.notificationUpdatedAt)} PR #${entry.number} ${entry.repo}: ${entry.reason} — ${entry.title} — ${entry.url}`;
}

function normalizeMemoryLineForContext(line: string): string {
	// Older entries started with a bare timestamp, which the model could mistake for
	// the GitHub notification date. Keep them readable while making the semantics explicit.
	return line.replace(/^- (\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+PR #/, "- Alfred surfaced $1; GitHub notification updated unknown PR #");
}

function formatNotificationTimestamp(value: string): string {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? formatLocalMinute(date) : value;
}

function formatLocalMinute(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${minute}`;
}
