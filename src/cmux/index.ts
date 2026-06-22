import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AlfredCapability, AlfredTarget } from "../contracts/runtime.ts";

const execFileAsync = promisify(execFile);

export interface CmuxExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeout?: number;
	encoding?: BufferEncoding;
	maxBuffer?: number;
}

export type CmuxExec = (
	file: string,
	args: readonly string[],
	options?: CmuxExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface CmuxAdapterOptions {
	execFile?: CmuxExec;
	cmuxExecutable?: string;
	processEnv?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface CmuxWorkspaceInfo {
	id: string;
	ref: string;
	title: string;
	selected: boolean;
	currentDirectory?: string;
	target: AlfredTarget;
}

export interface CmuxSurfaceInfo {
	ref: string;
	title: string;
	normalizedTitle: string;
	workspaceRef: string;
	workspaceTitle: string;
	selected: boolean;
	current: boolean;
	target: AlfredTarget;
}

export interface CmuxIdentifyInfo {
	workspaceId?: string;
	workspaceRef?: string;
	surfaceRef?: string;
	tabRef?: string;
	paneRef?: string;
	windowRef?: string;
}

export interface CmuxNotificationInfo {
	id: string;
	title: string;
	subtitle?: string;
	body?: string;
	isRead: boolean;
	createdAt: string;
	workspaceId?: string;
	surfaceId?: string;
	tabTitle?: string;
}

export interface CmuxSidebarState {
	tabId?: string;
	color?: string;
	cwd?: string;
	focusedCwd?: string;
	focusedPanel?: string;
	gitBranch?: string;
	gitDirty?: boolean;
	prRef?: string;
	prState?: string;
	prLabel?: string;
	ports: string[];
	progress?: { value: number; label?: string };
	statusCount: number;
	logCount: number;
}

export interface CmuxStatusEntry {
	key: string;
	value: string;
	icon?: string;
	color?: string;
	priority?: number;
}

export interface CmuxError {
	code: "cmux_unavailable" | "parse_failed" | "target_not_found" | "command_failed";
	message: string;
	stderr?: string;
}

export type CmuxResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: CmuxError };

export interface CmuxWorldModelAdapter {
	// Workspace / surface discovery
	listWorkspaces(): Promise<CmuxResult<CmuxWorkspaceInfo[]>>;
	identifyCurrent(): Promise<CmuxResult<CmuxIdentifyInfo>>;
	listSurfaces(workspaceRef?: string): Promise<CmuxResult<CmuxSurfaceInfo[]>>;
	listTargets(): Promise<CmuxResult<AlfredTarget[]>>;
	findTargets(query: string, options?: { workspaceRef?: string }): Promise<CmuxResult<AlfredTarget[]>>;

	// Terminal I/O
	readSurface(surfaceRef: string, options?: { lines?: number }): Promise<CmuxResult<{ text: string }>>;
	sendTextToSurface(surfaceRef: string, text: string): Promise<CmuxResult<{ surfaceRef: string }>>;
	sendTextToWorkspace(workspaceRef: string, text: string): Promise<CmuxResult<{ workspaceRef: string }>>;
	sendKeyToSurface(surfaceRef: string, key: string): Promise<CmuxResult<{ surfaceRef: string; key: string }>>;

	// Capabilities
	capabilities(): Promise<CmuxResult<{ accessMode: string; methods: string[]; version: number; protocol: string }>>;

	// Notifications
	listNotifications(): Promise<CmuxResult<CmuxNotificationInfo[]>>;
	dismissNotification(id: string): Promise<CmuxResult<{ id: string }>>;
	dismissAllReadNotifications(): Promise<CmuxResult<{ dismissed: boolean }>>;
	markNotificationRead(id: string): Promise<CmuxResult<{ id: string }>>;
	markAllNotificationsRead(): Promise<CmuxResult<{ marked: boolean }>>;
	openNotification(id: string): Promise<CmuxResult<{ id: string }>>;
	jumpToUnreadNotification(): Promise<CmuxResult<{ jumped: boolean }>>;
	clearNotifications(workspaceRef?: string): Promise<CmuxResult<{ cleared: boolean }>>;

	// Sidebar status / progress / log
	setStatus(key: string, value: string, options?: { icon?: string; color?: string; priority?: number; workspaceRef?: string }): Promise<CmuxResult<{ key: string; value: string }>>;
	clearStatus(key: string, options?: { workspaceRef?: string }): Promise<CmuxResult<{ key: string; cleared: boolean }>>;
	listStatus(workspaceRef?: string): Promise<CmuxResult<CmuxStatusEntry[]>>;
	setProgress(value: number, options?: { label?: string; workspaceRef?: string }): Promise<CmuxResult<{ value: number }>>;
	clearProgress(options?: { workspaceRef?: string }): Promise<CmuxResult<{ cleared: boolean }>>;
	log(message: string, options?: { level?: string; source?: string; workspaceRef?: string }): Promise<CmuxResult<{ logged: boolean }>>;
	sidebarState(workspaceRef?: string): Promise<CmuxResult<CmuxSidebarState>>;

	// Markdown / diff / file / URL / browser open
	openMarkdown(path: string, options?: { workspaceRef?: string; surfaceRef?: string; focus?: boolean }): Promise<CmuxResult<{ path: string }>>;
	openDiff(options?: { source?: string; unstaged?: boolean; staged?: boolean; branch?: boolean; lastTurn?: boolean; workspaceRef?: string; surfaceRef?: string; cwd?: string; base?: string; focus?: boolean }): Promise<CmuxResult<{ opened: boolean }>>;
	openFile(path: string, options?: { workspaceRef?: string; surfaceRef?: string; paneRef?: string; focus?: boolean }): Promise<CmuxResult<{ path: string }>>;
	openUrl(url: string, options?: { workspaceRef?: string; surfaceRef?: string; paneRef?: string; focus?: boolean }): Promise<CmuxResult<{ url: string }>>;
	openBrowserSurface(url?: string, options?: { workspaceRef?: string; focus?: boolean }): Promise<CmuxResult<{ opened: boolean }>>;
}

interface RawWorkspace {
	id?: string;
	ref?: string;
	title?: string;
	selected?: boolean;
	current_directory?: string;
}

interface RawSurface {
	ref?: string;
	title?: string;
	type?: string;
	selected?: boolean;
	focused?: boolean;
	here?: boolean;
	selected_in_pane?: boolean;
	pane_ref?: string;
}

interface RawNotification {
	id?: string;
	title?: string;
	subtitle?: string;
	body?: string;
	is_read?: boolean;
	created_at?: string;
	workspace_id?: string;
	surface_id?: string;
	tab_title?: string;
}

export function createCmuxWorldModelAdapter(options: CmuxAdapterOptions = {}): CmuxWorldModelAdapter {
	const exec = options.execFile ?? (execFileAsync as CmuxExec);
	const cmux = options.cmuxExecutable ?? "cmux";
	const env = options.processEnv ?? process.env;
	const timeout = options.timeoutMs ?? 5_000;

	async function runCmux(args: readonly string[]): Promise<CmuxResult<string>> {
		try {
			const { stdout } = await exec(cmux, args, {
				encoding: "utf8",
				timeout,
				env,
				maxBuffer: 1024 * 1024,
			});
			return { ok: true, value: stdout };
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "command_failed",
					message: stringifyError(error),
					stderr: stderrFromError(error),
				},
			};
		}
	}

	async function runCmuxJson(args: readonly string[]): Promise<CmuxResult<unknown>> {
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		try {
			return { ok: true, value: JSON.parse(raw.value) as unknown };
		} catch (error) {
			return { ok: false, error: { code: "parse_failed", message: stringifyError(error) } };
		}
	}

	// ─── workspace / surface discovery ───

	async function listWorkspaces(): Promise<CmuxResult<CmuxWorkspaceInfo[]>> {
		const raw = await runCmuxJson(["workspace", "list", "--json", "--id-format", "both"]);
		if (!raw.ok) return raw;
		const workspaces = ((raw.value as { workspaces?: RawWorkspace[] }).workspaces ?? [])
			.map(toWorkspaceInfo)
			.filter((workspace) => workspace.ref && workspace.title);
		return { ok: true, value: workspaces };
	}

	async function identifyCurrent(): Promise<CmuxResult<CmuxIdentifyInfo>> {
		const envWorkspace = env.CMUX_WORKSPACE_ID?.trim();
		const envSurface = env.CMUX_SURFACE_ID?.trim();
		const envTab = env.CMUX_TAB_ID?.trim();
		const envPane = env.CMUX_PANE_ID?.trim();
		const envWindow = env.CMUX_WINDOW_ID?.trim();
		const envIdentity: CmuxIdentifyInfo = {
			workspaceId: envWorkspace && !envWorkspace.startsWith("workspace:") ? envWorkspace : undefined,
			workspaceRef: envWorkspace?.startsWith("workspace:") ? envWorkspace : undefined,
			surfaceRef: envSurface?.startsWith("surface:") ? envSurface : undefined,
			tabRef: envTab?.startsWith("tab:") || envTab?.startsWith("surface:") ? envTab : undefined,
			paneRef: envPane?.startsWith("pane:") ? envPane : undefined,
			windowRef: envWindow?.startsWith("window:") ? envWindow : undefined,
		};
		if (envIdentity.surfaceRef || envIdentity.tabRef || envIdentity.paneRef || envIdentity.windowRef) {
			return { ok: true, value: envIdentity };
		}
		const raw = await runCmuxJson(["identify", "--id-format", "both"]);
		if (!raw.ok) {
			if (envWorkspace) return { ok: true, value: envIdentity };
			return raw;
		}
		const parsed = raw.value as {
			caller?: { workspace_id?: string; workspace_ref?: string; surface_ref?: string; tab_ref?: string; pane_ref?: string; window_ref?: string };
			focused?: { workspace_id?: string; workspace_ref?: string; surface_ref?: string; tab_ref?: string; pane_ref?: string; window_ref?: string };
		};
		const current = parsed.caller ?? parsed.focused ?? {};
		return {
			ok: true,
			value: {
				workspaceId: current.workspace_id,
				workspaceRef: current.workspace_ref,
				surfaceRef: current.surface_ref,
				tabRef: current.tab_ref,
				paneRef: current.pane_ref,
				windowRef: current.window_ref,
			},
		};
	}

	async function listSurfaces(workspaceRef?: string): Promise<CmuxResult<CmuxSurfaceInfo[]>> {
		const workspacesResult = await listWorkspaces();
		if (!workspacesResult.ok) return workspacesResult;
		const current = await identifyCurrent();
		const currentValue = current.ok ? current.value : {};
		const selectedWorkspaceRef = workspaceRef ?? currentValue.workspaceRef ?? workspacesResult.value.find((workspace) => workspace.selected)?.ref;
		if (!selectedWorkspaceRef) {
			return { ok: false, error: { code: "target_not_found", message: "No workspace is selected or current." } };
		}
		const workspace = workspacesResult.value.find((candidate) => candidate.ref === selectedWorkspaceRef);
		if (!workspace) {
			return { ok: false, error: { code: "target_not_found", message: `Workspace not found: ${selectedWorkspaceRef}` } };
		}
		return await listSurfacesForWorkspace(workspace, currentValue);
	}

	async function listTargets(): Promise<CmuxResult<AlfredTarget[]>> {
		const workspaces = await listWorkspaces();
		if (!workspaces.ok) return workspaces;
		const current = await identifyCurrent();
		const currentValue = current.ok ? current.value : {};
		const targets: AlfredTarget[] = workspaces.value.map((workspace) => workspace.target);
		for (const workspace of workspaces.value) {
			const surfaces = await listSurfacesForWorkspace(workspace, currentValue);
			if (surfaces.ok) {
				targets.push(...surfaces.value.map((surface) => surface.target));
			}
		}
		return { ok: true, value: targets };
	}

	async function findTargets(query: string, options?: { workspaceRef?: string }): Promise<CmuxResult<AlfredTarget[]>> {
		const normalizedQuery = normalizeForMatch(query);
		if (!normalizedQuery) return { ok: true, value: [] };
		if (["current surface", "current chat", "this chat", "current tab", "this tab"].includes(normalizedQuery)) {
			const current = await identifyCurrent();
			if (!current.ok || !current.value.surfaceRef) {
				return { ok: true, value: [] };
			}
			const surfaces = await listSurfaces(current.value.workspaceRef ?? options?.workspaceRef);
			if (!surfaces.ok) return surfaces;
			return { ok: true, value: surfaces.value.filter((surface) => surface.ref === current.value.surfaceRef).map((surface) => surface.target) };
		}
		if (["current workspace", "this workspace"].includes(normalizedQuery)) {
			const current = await identifyCurrent();
			const currentValue = current.ok ? current.value : {};
			const workspaces = await listWorkspaces();
			if (!workspaces.ok) return workspaces;
			const workspace = workspaces.value.find((candidate) => candidate.ref === currentValue.workspaceRef || candidate.id === currentValue.workspaceId || candidate.selected);
			return { ok: true, value: workspace ? [workspace.target] : [] };
		}

		const workspaces = await listWorkspaces();
		if (!workspaces.ok) return workspaces;
		const surfaces = options?.workspaceRef
			? await listSurfaces(options.workspaceRef)
			: await listAllSurfaces(workspaces.value);
		if (!surfaces.ok) return surfaces;

		const candidates = [...surfaces.value.map((surface) => surface.target), ...workspaces.value.map((workspace) => workspace.target)];
		return { ok: true, value: bestTargetMatches(candidates, normalizedQuery) };
	}

	// ─── terminal I/O ───

	async function readSurface(surfaceRef: string, opts?: { lines?: number }): Promise<CmuxResult<{ text: string }>> {
		const lines = String(Math.max(20, opts?.lines ?? 120));
		const raw = await runCmux(["read-screen", "--surface", surfaceRef, "--scrollback", "--lines", lines]);
		if (!raw.ok) return raw;
		return { ok: true, value: { text: raw.value } };
	}

	async function sendTextToSurface(surfaceRef: string, text: string): Promise<CmuxResult<{ surfaceRef: string }>> {
		const sent = await runCmux(["send", "--surface", surfaceRef, text]);
		if (!sent.ok) return sent;
		const enter = await runCmux(["send-key", "--surface", surfaceRef, "enter"]);
		if (!enter.ok) return enter;
		return { ok: true, value: { surfaceRef } };
	}

	async function sendTextToWorkspace(workspaceRef: string, text: string): Promise<CmuxResult<{ workspaceRef: string }>> {
		const sent = await runCmux(["send", "--workspace", workspaceRef, text]);
		if (!sent.ok) return sent;
		const enter = await runCmux(["send-key", "--workspace", workspaceRef, "enter"]);
		if (!enter.ok) return enter;
		return { ok: true, value: { workspaceRef } };
	}

	async function sendKeyToSurface(surfaceRef: string, key: string): Promise<CmuxResult<{ surfaceRef: string; key: string }>> {
		const sent = await runCmux(["send-key", "--surface", surfaceRef, key]);
		if (!sent.ok) return sent;
		return { ok: true, value: { surfaceRef, key } };
	}

	// ─── capabilities ───

	async function capabilities(): Promise<CmuxResult<{ accessMode: string; methods: string[]; version: number; protocol: string }>> {
		const raw = await runCmuxJson(["capabilities"]);
		if (!raw.ok) return raw;
		const caps = raw.value as { access_mode?: string; methods?: string[]; version?: number; protocol?: string };
		return { ok: true, value: { accessMode: caps.access_mode ?? "unknown", methods: caps.methods ?? [], version: caps.version ?? 0, protocol: caps.protocol ?? "unknown" } };
	}

	// ─── notifications ───

	async function listNotifications(): Promise<CmuxResult<CmuxNotificationInfo[]>> {
		const raw = await runCmuxJson(["list-notifications", "--json", "--id-format", "both"]);
		if (!raw.ok) return raw;
		const arr = Array.isArray(raw.value) ? raw.value : [];
		return { ok: true, value: arr.map(toNotificationInfo) };
	}

	async function dismissNotification(id: string): Promise<CmuxResult<{ id: string }>> {
		const raw = await runCmux(["dismiss-notification", "--id", id]);
		if (!raw.ok) return raw;
		return { ok: true, value: { id } };
	}

	async function dismissAllReadNotifications(): Promise<CmuxResult<{ dismissed: boolean }>> {
		const raw = await runCmux(["dismiss-notification", "--all-read"]);
		if (!raw.ok) return raw;
		return { ok: true, value: { dismissed: true } };
	}

	async function markNotificationRead(id: string): Promise<CmuxResult<{ id: string }>> {
		const raw = await runCmux(["mark-notification-read", "--id", id]);
		if (!raw.ok) return raw;
		return { ok: true, value: { id } };
	}

	async function markAllNotificationsRead(): Promise<CmuxResult<{ marked: boolean }>> {
		const raw = await runCmux(["mark-notification-read", "--all"]);
		if (!raw.ok) return raw;
		return { ok: true, value: { marked: true } };
	}

	async function openNotification(id: string): Promise<CmuxResult<{ id: string }>> {
		const raw = await runCmux(["open-notification", "--id", id]);
		if (!raw.ok) return raw;
		return { ok: true, value: { id } };
	}

	async function jumpToUnreadNotification(): Promise<CmuxResult<{ jumped: boolean }>> {
		const raw = await runCmux(["jump-to-unread"]);
		if (!raw.ok) return raw;
		return { ok: true, value: { jumped: true } };
	}

	async function clearNotifications(workspaceRef?: string): Promise<CmuxResult<{ cleared: boolean }>> {
		const args = workspaceRef ? ["clear-notifications", "--workspace", workspaceRef] : ["clear-notifications"];
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { cleared: true } };
	}

	// ─── sidebar status / progress / log ───

	async function setStatus(key: string, value: string, opts?: { icon?: string; color?: string; priority?: number; workspaceRef?: string }): Promise<CmuxResult<{ key: string; value: string }>> {
		const args = ["set-status", key, value];
		if (opts?.icon) args.push("--icon", opts.icon);
		if (opts?.color) args.push("--color", opts.color);
		if (opts?.priority !== undefined) args.push("--priority", String(opts.priority));
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { key, value } };
	}

	async function clearStatus(key: string, opts?: { workspaceRef?: string }): Promise<CmuxResult<{ key: string; cleared: boolean }>> {
		const args = ["clear-status", key];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { key, cleared: true } };
	}

	async function listStatus(workspaceRef?: string): Promise<CmuxResult<CmuxStatusEntry[]>> {
		const args = workspaceRef ? ["list-status", "--workspace", workspaceRef] : ["list-status"];
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: parseStatusEntries(raw.value) };
	}

	async function setProgress(value: number, opts?: { label?: string; workspaceRef?: string }): Promise<CmuxResult<{ value: number }>> {
		const clamped = Math.max(0, Math.min(1, value));
		const args = ["set-progress", String(clamped)];
		if (opts?.label) args.push("--label", opts.label);
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { value: clamped } };
	}

	async function clearProgress(opts?: { workspaceRef?: string }): Promise<CmuxResult<{ cleared: boolean }>> {
		const args = ["clear-progress"];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { cleared: true } };
	}

	async function log(message: string, opts?: { level?: string; source?: string; workspaceRef?: string }): Promise<CmuxResult<{ logged: boolean }>> {
		const args = ["log"];
		if (opts?.level) args.push("--level", opts.level);
		if (opts?.source) args.push("--source", opts.source);
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		args.push(message);
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { logged: true } };
	}

	async function sidebarState(workspaceRef?: string): Promise<CmuxResult<CmuxSidebarState>> {
		const args = workspaceRef ? ["sidebar-state", "--workspace", workspaceRef] : ["sidebar-state"];
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: parseSidebarState(raw.value) };
	}

	// ─── markdown / diff / file / URL / browser open ───

	async function openMarkdown(path: string, opts?: { workspaceRef?: string; surfaceRef?: string; focus?: boolean }): Promise<CmuxResult<{ path: string }>> {
		const args = ["markdown", "open", path];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		if (opts?.surfaceRef) args.push("--surface", opts.surfaceRef);
		if (opts?.focus !== undefined) args.push("--focus", String(opts.focus));
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { path } };
	}

	async function openDiff(opts?: { source?: string; unstaged?: boolean; staged?: boolean; branch?: boolean; lastTurn?: boolean; workspaceRef?: string; surfaceRef?: string; cwd?: string; base?: string; focus?: boolean }): Promise<CmuxResult<{ opened: boolean }>> {
		const args = ["diff"];
		if (opts?.source) args.push("--source", opts.source);
		if (opts?.unstaged) args.push("--unstaged");
		if (opts?.staged) args.push("--staged");
		if (opts?.branch) args.push("--branch");
		if (opts?.lastTurn) args.push("--last-turn");
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		if (opts?.surfaceRef) args.push("--surface", opts.surfaceRef);
		if (opts?.cwd) args.push("--cwd", opts.cwd);
		if (opts?.base) args.push("--base", opts.base);
		if (opts?.focus !== undefined) args.push("--focus", String(opts.focus));
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { opened: true } };
	}

	async function openFile(path: string, opts?: { workspaceRef?: string; surfaceRef?: string; paneRef?: string; focus?: boolean }): Promise<CmuxResult<{ path: string }>> {
		const args = ["open", path];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		if (opts?.surfaceRef) args.push("--surface", opts.surfaceRef);
		if (opts?.paneRef) args.push("--pane", opts.paneRef);
		if (opts?.focus !== undefined) args.push("--focus", String(opts.focus));
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { path } };
	}

	async function openUrl(url: string, opts?: { workspaceRef?: string; surfaceRef?: string; paneRef?: string; focus?: boolean }): Promise<CmuxResult<{ url: string }>> {
		const args = ["open", url];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		if (opts?.surfaceRef) args.push("--surface", opts.surfaceRef);
		if (opts?.paneRef) args.push("--pane", opts.paneRef);
		if (opts?.focus !== undefined) args.push("--focus", String(opts.focus));
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { url } };
	}

	async function openBrowserSurface(url?: string, opts?: { workspaceRef?: string; focus?: boolean }): Promise<CmuxResult<{ opened: boolean }>> {
		const args = url ? ["browser", "open", url] : ["browser", "open"];
		if (opts?.workspaceRef) args.push("--workspace", opts.workspaceRef);
		if (opts?.focus !== undefined) args.push("--focus", String(opts.focus));
		const raw = await runCmux(args);
		if (!raw.ok) return raw;
		return { ok: true, value: { opened: true } };
	}

	// ─── internal helpers ───

	async function listSurfacesForWorkspace(workspace: CmuxWorkspaceInfo, currentValue: CmuxIdentifyInfo): Promise<CmuxResult<CmuxSurfaceInfo[]>> {
		const raw = await runCmuxJson(["tree", "--workspace", workspace.ref, "--json", "--id-format", "both"]);
		if (!raw.ok) {
			// fallback: try text-based tree output
			return listSurfacesForWorkspaceText(workspace, currentValue);
		}
		const surfaces = parseJsonTree(raw.value, workspace, currentValue);
		if (surfaces === null) {
			return listSurfacesForWorkspaceText(workspace, currentValue);
		}
		return { ok: true, value: surfaces };
	}

	async function listSurfacesForWorkspaceText(workspace: CmuxWorkspaceInfo, currentValue: CmuxIdentifyInfo): Promise<CmuxResult<CmuxSurfaceInfo[]>> {
		const raw = await runCmux(["tree", "--workspace", workspace.ref]);
		if (!raw.ok) return raw;
		return { ok: true, value: parseTextTree(raw.value, workspace, currentValue) };
	}

	async function listAllSurfaces(workspaces: CmuxWorkspaceInfo[]): Promise<CmuxResult<CmuxSurfaceInfo[]>> {
		const current = await identifyCurrent();
		const currentValue = current.ok ? current.value : {};
		const all: CmuxSurfaceInfo[] = [];
		for (const workspace of workspaces) {
			const surfaces = await listSurfacesForWorkspace(workspace, currentValue);
			if (surfaces.ok) {
				all.push(...surfaces.value);
			}
		}
		return { ok: true, value: all };
	}

	return {
		listWorkspaces,
		identifyCurrent,
		listSurfaces,
		listTargets,
		findTargets,
		readSurface,
		sendTextToSurface,
		sendTextToWorkspace,
		sendKeyToSurface,
		capabilities,
		listNotifications,
		dismissNotification,
		dismissAllReadNotifications,
		markNotificationRead,
		markAllNotificationsRead,
		openNotification,
		jumpToUnreadNotification,
		clearNotifications,
		setStatus,
		clearStatus,
		listStatus,
		setProgress,
		clearProgress,
		log,
		sidebarState,
		openMarkdown,
		openDiff,
		openFile,
		openUrl,
		openBrowserSurface,
	};
}

// ─── workspace parsing ───

function toWorkspaceInfo(raw: RawWorkspace): CmuxWorkspaceInfo {
	const capabilities: AlfredCapability[] = ["world.read", "workspace.send"];
	const ref = raw.ref ?? "";
	const title = (raw.title ?? "").trim();
	return {
		id: raw.id ?? "",
		ref,
		title,
		selected: raw.selected ?? false,
		currentDirectory: raw.current_directory || undefined,
		target: {
			kind: "cmux-workspace",
			ref,
			label: title,
			workspaceRef: ref,
			workspaceLabel: title,
			selected: raw.selected ?? false,
			confidence: "exact",
			capabilities,
			metadata: { currentDirectory: raw.current_directory ?? null },
		},
	};
}

// ─── JSON tree parsing (cmux tree --json) ───

function parseJsonTree(treeJson: unknown, workspace: CmuxWorkspaceInfo, current: CmuxIdentifyInfo): CmuxSurfaceInfo[] | null {
	if (typeof treeJson !== "object" || treeJson === null) return null;
	const windows = (treeJson as { windows?: unknown[] }).windows;
	if (!Array.isArray(windows) || windows.length === 0) return null;

	const surfaces: CmuxSurfaceInfo[] = [];
	for (const windowEntry of windows) {
		if (typeof windowEntry !== "object" || windowEntry === null) continue;
		const workspaces = (windowEntry as { workspaces?: unknown[] }).workspaces;
		if (!Array.isArray(workspaces)) continue;
		for (const wsEntry of workspaces) {
			if (typeof wsEntry !== "object" || wsEntry === null) continue;
			const ws = wsEntry as { panes?: unknown[] };
			if (!Array.isArray(ws.panes)) continue;
			for (const paneEntry of ws.panes) {
				if (typeof paneEntry !== "object" || paneEntry === null) continue;
				const pane = paneEntry as { surfaces?: unknown[] };
				if (!Array.isArray(pane.surfaces)) continue;
				for (const surfaceEntry of pane.surfaces) {
					const sf = surfaceEntry as RawSurface;
					const ref = sf.ref ?? "";
					const title = (sf.title ?? "").trim();
					if (!ref || !title) continue;
					surfaces.push(toSurfaceInfo(ref, title, sf, workspace, current));
				}
			}
		}
	}
	return surfaces;
}

function toSurfaceInfo(ref: string, title: string, raw: RawSurface, workspace: CmuxWorkspaceInfo, current: CmuxIdentifyInfo): CmuxSurfaceInfo {
	const selected = raw.selected ?? raw.selected_in_pane ?? false;
	const isCurrent = current.surfaceRef === ref || current.tabRef === ref;
	const processKind = inferProcessKind(title);
	const kind = targetKindForProcess(processKind);
	const capabilities: AlfredCapability[] = ["surface.read", "surface.send"];
	return {
		ref,
		title,
		normalizedTitle: normalizeTitle(title),
		workspaceRef: workspace.ref,
		workspaceTitle: workspace.title,
		selected,
		current: isCurrent,
		target: {
			kind,
			ref,
			label: title,
			workspaceRef: workspace.ref,
			workspaceLabel: workspace.title,
			surfaceRef: ref,
			processKind,
			current: isCurrent,
			selected,
			confidence: "exact",
			capabilities,
			metadata: { normalizedTitle: normalizeTitle(title) },
		},
	};
}

// ─── text-based tree parsing (fallback) ───

function parseTextTree(tree: string, workspace: CmuxWorkspaceInfo, current: CmuxIdentifyInfo): CmuxSurfaceInfo[] {
	const surfaces: CmuxSurfaceInfo[] = [];
	for (const line of tree.split("\n")) {
		const match = line.match(/surface\s+(surface:\d+)\s+\[terminal\]\s+"([^"]+)"(\s+\[selected\])?/);
		if (!match) continue;
		const ref = match[1] ?? "";
		const title = (match[2] ?? "").trim();
		const selected = Boolean(match[3]);
		const processKind = inferProcessKind(title);
		const kind = targetKindForProcess(processKind);
		const capabilities: AlfredCapability[] = ["surface.read", "surface.send"];
		surfaces.push({
			ref,
			title,
			normalizedTitle: normalizeTitle(title),
			workspaceRef: workspace.ref,
			workspaceTitle: workspace.title,
			selected,
			current: current.surfaceRef === ref || current.tabRef === ref,
			target: {
				kind,
				ref,
				label: title,
				workspaceRef: workspace.ref,
				workspaceLabel: workspace.title,
				surfaceRef: ref,
				processKind,
				current: current.surfaceRef === ref || current.tabRef === ref,
				selected,
				confidence: "exact",
				capabilities,
				metadata: { normalizedTitle: normalizeTitle(title) },
			},
		});
	}
	return surfaces;
}

// ─── notification parsing ───

function toNotificationInfo(raw: RawNotification): CmuxNotificationInfo {
	return {
		id: raw.id ?? "",
		title: raw.title ?? "",
		subtitle: raw.subtitle,
		body: raw.body,
		isRead: raw.is_read ?? false,
		createdAt: raw.created_at ?? "",
		workspaceId: raw.workspace_id,
		surfaceId: raw.surface_id,
		tabTitle: raw.tab_title,
	};
}

// ─── sidebar state parsing ───

function parseSidebarState(raw: string): CmuxSidebarState {
	const state: CmuxSidebarState = { ports: [], statusCount: 0, logCount: 0 };
	for (const line of raw.split("\n")) {
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		switch (key) {
			case "tab": state.tabId = value; break;
			case "color": state.color = value; break;
			case "cwd": state.cwd = value; break;
			case "focused_cwd": state.focusedCwd = value; break;
			case "focused_panel": state.focusedPanel = value; break;
			case "git_branch": {
				const parts = value.split(/\s+/);
				state.gitBranch = parts[0];
				state.gitDirty = parts.includes("dirty");
				break;
			}
			case "pr": {
				const prParts = value.split(/\s+/);
				state.prRef = prParts[1];
				state.prState = prParts[0];
				break;
			}
			case "pr_label": state.prLabel = value; break;
			case "ports": state.ports = value ? value.split(/\s*,\s*/).filter(Boolean) : []; break;
			case "progress": {
				if (value !== "none") {
					const parsed = parseFloat(value);
					if (!isNaN(parsed)) state.progress = { value: parsed };
				}
				break;
			}
			case "status_count": state.statusCount = parseInt(value, 10) || 0; break;
			case "log_count": state.logCount = parseInt(value, 10) || 0; break;
		}
	}
	return state;
}

function parseStatusEntries(raw: string): CmuxStatusEntry[] {
	const entries: CmuxStatusEntry[] = [];
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const rest = line.slice(eq + 1).trim();
		const optionMatch = rest.match(/^(.*?)(?:\s+icon=([^\s]+))?(?:\s+color=([^\s]+))?(?:\s+priority=(\d+))?$/);
		const value = (optionMatch?.[1] ?? rest).trim();
		entries.push({
			key,
			value,
			icon: optionMatch?.[2],
			color: optionMatch?.[3],
			priority: optionMatch?.[4] ? Number(optionMatch[4]) : undefined,
		});
	}
	return entries;
}

// ─── process kind / target kind inference ───

function inferProcessKind(title: string): NonNullable<AlfredTarget["processKind"]> {
	const normalized = normalizeForMatch(title);
	if (title.startsWith("π - ") || normalized.startsWith("pi ")) return "pi";
	if (normalized.includes("codex")) return "codex";
	if (normalized.includes("shell") || normalized.includes("terminal")) return "shell";
	return "unknown";
}

function targetKindForProcess(processKind: NonNullable<AlfredTarget["processKind"]>): AlfredTarget["kind"] {
	if (processKind === "pi") return "pi-chat";
	if (processKind === "codex") return "codex-session";
	if (processKind === "shell") return "terminal";
	return "cmux-surface";
}

function bestTargetMatches(targets: AlfredTarget[], normalizedQuery: string): AlfredTarget[] {
	const scored = targets
		.map((target) => ({ target, score: matchScore(target, normalizedQuery) }))
		.filter(({ score }) => score < Number.POSITIVE_INFINITY)
		.sort((left, right) => left.score - right.score || left.target.label.localeCompare(right.target.label));
	if (scored.length === 0) return [];
	const best = scored[0]?.score ?? Number.POSITIVE_INFINITY;
	return scored.filter(({ score }) => score === best).map(({ target, score }) => ({
		...target,
		confidence: score === 0 ? "exact" : score === 1 ? "prefix" : score === 2 ? "substring" : "fuzzy",
	}));
}

function matchScore(target: AlfredTarget, normalizedQuery: string): number {
	const labels = [target.label, String(target.metadata?.normalizedTitle ?? "")].map(normalizeForMatch).filter(Boolean);
	if (labels.some((label) => label === normalizedQuery)) return 0;
	if (labels.some((label) => label.startsWith(normalizedQuery))) return 1;
	if (labels.some((label) => label.includes(normalizedQuery))) return 2;
	const fuzzyDistance = Math.min(...labels.map((label) => levenshtein(label, normalizedQuery)));
	const shortest = Math.min(...labels.map((label) => label.length));
	return fuzzyDistance <= Math.max(2, Math.floor(shortest * 0.25)) ? 3 + fuzzyDistance / 100 : Number.POSITIVE_INFINITY;
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/^π\s*-\s*/i, "").replace(/[-_\s]+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
	return normalizeTitle(value).replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i += 1) dp[i]![0] = i;
	for (let j = 0; j <= b.length; j += 1) dp[0]![j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		for (let j = 1; j <= b.length; j += 1) {
			dp[i]![j] = Math.min(
				dp[i - 1]![j]! + 1,
				dp[i]![j - 1]! + 1,
				dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dp[a.length]![b.length]!;
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stderrFromError(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : undefined;
}
