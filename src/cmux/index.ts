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
	listWorkspaces(): Promise<CmuxResult<CmuxWorkspaceInfo[]>>;
	identifyCurrent(): Promise<CmuxResult<CmuxIdentifyInfo>>;
	listSurfaces(workspaceRef?: string): Promise<CmuxResult<CmuxSurfaceInfo[]>>;
	listTargets(): Promise<CmuxResult<AlfredTarget[]>>;
	findTargets(query: string, options?: { workspaceRef?: string }): Promise<CmuxResult<AlfredTarget[]>>;
	readSurface(surfaceRef: string, options?: { lines?: number }): Promise<CmuxResult<{ text: string }>>;
	sendTextToSurface(surfaceRef: string, text: string): Promise<CmuxResult<{ surfaceRef: string }>>;
	sendTextToWorkspace(workspaceRef: string, text: string): Promise<CmuxResult<{ workspaceRef: string }>>;
	sendKeyToSurface(surfaceRef: string, key: string): Promise<CmuxResult<{ surfaceRef: string; key: string }>>;
}

interface RawWorkspace {
	id?: string;
	ref?: string;
	title?: string;
	selected?: boolean;
	current_directory?: string;
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

	async function listWorkspaces(): Promise<CmuxResult<CmuxWorkspaceInfo[]>> {
		const raw = await runCmux(["workspace", "list", "--json", "--id-format", "both"]);
		if (!raw.ok) return raw;
		try {
			const parsed = JSON.parse(raw.value) as { workspaces?: RawWorkspace[] };
			const workspaces = (parsed.workspaces ?? []).map(toWorkspaceInfo).filter((workspace) => workspace.ref && workspace.title);
			return { ok: true, value: workspaces };
		} catch (error) {
			return { ok: false, error: { code: "parse_failed", message: stringifyError(error) } };
		}
	}

	async function identifyCurrent(): Promise<CmuxResult<CmuxIdentifyInfo>> {
		if (env.CMUX_WORKSPACE_ID?.trim()) {
			return { ok: true, value: { workspaceId: env.CMUX_WORKSPACE_ID.trim() } };
		}
		const raw = await runCmux(["identify", "--id-format", "both"]);
		if (!raw.ok) return raw;
		try {
			const parsed = JSON.parse(raw.value) as {
				caller?: { workspace_id?: string; workspace_ref?: string; surface_ref?: string; tab_ref?: string };
				focused?: { workspace_id?: string; workspace_ref?: string; surface_ref?: string; tab_ref?: string };
			};
			const current = parsed.caller ?? parsed.focused ?? {};
			return {
				ok: true,
				value: {
					workspaceId: current.workspace_id,
					workspaceRef: current.workspace_ref,
					surfaceRef: current.surface_ref,
					tabRef: current.tab_ref,
				},
			};
		} catch (error) {
			return { ok: false, error: { code: "parse_failed", message: stringifyError(error) } };
		}
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

	async function readSurface(surfaceRef: string, options?: { lines?: number }): Promise<CmuxResult<{ text: string }>> {
		const lines = String(Math.max(20, options?.lines ?? 120));
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

	async function listSurfacesForWorkspace(workspace: CmuxWorkspaceInfo, currentValue: CmuxIdentifyInfo): Promise<CmuxResult<CmuxSurfaceInfo[]>> {
		const raw = await runCmux(["tree", "--workspace", workspace.ref]);
		if (!raw.ok) return raw;
		return { ok: true, value: parseSurfaceTree(raw.value, workspace, currentValue) };
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
	};
}

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

function parseSurfaceTree(tree: string, workspace: CmuxWorkspaceInfo, current: CmuxIdentifyInfo): CmuxSurfaceInfo[] {
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
