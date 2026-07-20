import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InspectSessionToolCall, ToolExecutionContext, ToolResult } from "../tool-types.ts";
import { createStructuredFailure } from "../capabilities/outcome.ts";
import type { FailureCode } from "../capabilities/failure-codes.ts";

const execFileAsync = promisify(execFile);

export interface SessionExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type SessionExecFn = (
	command: string,
	args: string[],
	options?: { timeoutMs?: number },
) => Promise<SessionExecResult>;

export interface InspectSessionOptions {
	exec?: SessionExecFn;
	systemContext?: string;
	cmuxExecutable?: string;
}

export interface SessionWorkspaceCandidate {
	ref: string;
	name: string;
	selected?: boolean;
}

export interface SessionSurfaceCandidate {
	ref: string;
	title: string;
	selected?: boolean;
	score?: number;
}

export interface InspectedSurface {
	ref: string;
	title: string;
	screenText: string;
}

export interface InspectSessionData {
	workspaceRef?: string;
	workspaceName?: string;
	surfaceRef?: string;
	surfaceTitle?: string;
	screenText?: string;
	/** Populated when workspace-only mode inspects multiple surfaces. */
	inspectedSurfaces?: InspectedSurface[];
	candidates?: SessionSurfaceCandidate[];
	workspaceCandidates?: SessionWorkspaceCandidate[];
}

export interface SessionTargetToolCall {
	workspaceName?: string;
	workspaceRef?: string;
	tabHint?: string;
	surfaceRef?: string;
}

export interface ResolvedSessionTarget {
	workspace: SessionWorkspaceCandidate;
	surface: SessionSurfaceCandidate;
	surfaces: SessionSurfaceCandidate[];
}

const DEFAULT_LINES = 160;
const DEFAULT_TIMEOUT_MS = 5_000;

export const defaultSessionExec: SessionExecFn = async (command, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			encoding: "utf8",
			timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
	} catch (error: any) {
		return {
			stdout: error?.stdout?.trimEnd?.() ?? "",
			stderr: error?.stderr?.trimEnd?.() ?? error?.message ?? "Command failed",
			exitCode: typeof error?.code === "number" ? error.code : 1,
		};
	}
};

export async function inspectSession(
	toolCall: InspectSessionToolCall,
	ctx: ToolExecutionContext,
	options: InspectSessionOptions = {},
): Promise<ToolResult<InspectSessionData>> {
	const started = Date.now();
	const exec = options.exec ?? defaultSessionExec;
	const cmux = options.cmuxExecutable ?? "cmux";
	const lines = clampLines(toolCall.lines ?? DEFAULT_LINES);
	const scrollback = toolCall.scrollback !== false;
	const isWorkspaceOnly = !toolCall.surfaceRef && !toolCall.tabHint;

	const workspaceResolution = await resolveWorkspace(toolCall, ctx, options.systemContext ?? "", exec, cmux);
	if (workspaceResolution.kind === "ambiguous") {
		return makeResult(ctx, false, `Multiple workspaces matched: ${formatWorkspaceCandidates(workspaceResolution.candidates)}`, {
			workspaceCandidates: workspaceResolution.candidates,
		}, Date.now() - started, true, "resolution.ambiguous_target");
	}
	if (workspaceResolution.kind === "missing") {
		return makeResult(ctx, false, workspaceResolution.message, {
			workspaceCandidates: workspaceResolution.candidates,
		}, Date.now() - started, true, "resolution.target_not_found");
	}

	const workspace = workspaceResolution.workspace;
	const surfaces = await listSurfaces(workspace.ref, exec, cmux);
	if (!surfaces.ok) {
		return makeResult(ctx, false, surfaces.message, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
		}, Date.now() - started, true, "execution.exit_nonzero");
	}

	// Workspace-only mode: auto-pick the best surface(s) and inspect them.
	if (isWorkspaceOnly) {
		return inspectWorkspaceSurfaces(workspace, surfaces.value, lines, scrollback, toolCall.maxSurfaces ?? 1, exec, cmux, ctx, started);
	}

	const surfaceResolution = resolveSurface(toolCall, surfaces.value);
	if (surfaceResolution.kind === "ambiguous") {
		return makeResult(ctx, false, `Multiple tabs matched "${toolCall.tabHint ?? toolCall.surfaceRef ?? "current tab"}": ${formatSurfaceCandidates(surfaceResolution.candidates)}`, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
			candidates: surfaceResolution.candidates,
		}, Date.now() - started, true, "resolution.ambiguous_target");
	}
	if (surfaceResolution.kind === "missing") {
		return makeResult(ctx, false, surfaceResolution.message, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
			candidates: surfaceResolution.candidates,
		}, Date.now() - started, true, "resolution.target_not_found");
	}

	const surface = surfaceResolution.surface;
	const result = await readSurfaceScreen(workspace.ref, surface.ref, surface.title, lines, scrollback, exec, cmux);
	if (!result.ok) {
		return makeResult(ctx, false, result.error, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
			surfaceRef: surface.ref,
			surfaceTitle: surface.title,
		}, Date.now() - started, true, "execution.exit_nonzero");
	}

	return makeResult(ctx, true, result.text, {
		workspaceRef: workspace.ref,
		workspaceName: workspace.name,
		surfaceRef: surface.ref,
		surfaceTitle: surface.title,
		screenText: result.text,
		candidates: surfaces.value,
		inspectedSurfaces: [{ ref: surface.ref, title: surface.title, screenText: result.text }],
	}, Date.now() - started, false);
}

export async function resolveSessionTarget(
	toolCall: SessionTargetToolCall,
	ctx: ToolExecutionContext,
	options: InspectSessionOptions = {},
): Promise<
	| { kind: "resolved"; target: ResolvedSessionTarget }
	| { kind: "ambiguous"; message: string; workspaceCandidates?: SessionWorkspaceCandidate[]; candidates?: SessionSurfaceCandidate[] }
	| { kind: "missing"; message: string; workspaceCandidates?: SessionWorkspaceCandidate[]; candidates?: SessionSurfaceCandidate[] }
> {
	const exec = options.exec ?? defaultSessionExec;
	const cmux = options.cmuxExecutable ?? "cmux";
	const workspaceResolution = await resolveWorkspace(toolCall, ctx, options.systemContext ?? "", exec, cmux);
	if (workspaceResolution.kind === "ambiguous") {
		return { kind: "ambiguous", message: `Multiple workspaces matched: ${formatWorkspaceCandidates(workspaceResolution.candidates)}`, workspaceCandidates: workspaceResolution.candidates };
	}
	if (workspaceResolution.kind === "missing") {
		return { kind: "missing", message: workspaceResolution.message, workspaceCandidates: workspaceResolution.candidates };
	}

	const workspace = workspaceResolution.workspace;
	const surfaces = await listSurfaces(workspace.ref, exec, cmux);
	if (!surfaces.ok) return { kind: "missing", message: surfaces.message };
	if (!toolCall.surfaceRef && !toolCall.tabHint) {
		return { kind: "missing", message: `send_session_message requires a tabHint or surfaceRef. Visible tabs: ${formatSurfaceCandidates(surfaces.value)}`, candidates: surfaces.value };
	}

	const surfaceResolution = resolveSurface(toolCall, surfaces.value);
	if (surfaceResolution.kind === "ambiguous") {
		return { kind: "ambiguous", message: `Multiple tabs matched "${toolCall.tabHint ?? toolCall.surfaceRef ?? "target tab"}": ${formatSurfaceCandidates(surfaceResolution.candidates)}`, candidates: surfaceResolution.candidates };
	}
	if (surfaceResolution.kind === "missing") {
		return { kind: "missing", message: surfaceResolution.message, candidates: surfaceResolution.candidates };
	}
	return { kind: "resolved", target: { workspace, surface: surfaceResolution.surface, surfaces: surfaces.value } };
}

type SurfaceScreenResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

async function readSurfaceScreen(
	workspaceRef: string,
	surfaceRef: string,
	surfaceTitle: string,
	lines: number,
	scrollback: boolean,
	exec: SessionExecFn,
	cmux: string,
): Promise<SurfaceScreenResult> {
	const args = ["read-screen", "--workspace", workspaceRef, "--surface", surfaceRef];
	if (scrollback) args.push("--scrollback");
	args.push("--lines", String(lines));
	const result = await exec(cmux, args, { timeoutMs: DEFAULT_TIMEOUT_MS });
	if (result.exitCode !== 0) {
		return { ok: false, error: `cmux read-screen failed for ${surfaceTitle}: ${result.stderr || "unknown error"}` };
	}
	return { ok: true, text: result.stdout || "(screen is empty)" };
}

/**
 * Rank surfaces for workspace-only auto-inspection.
 * Prefers: selected/focused > Pi/chat/agent titles > non-idle > active > recency.
 */
function rankSurfaces(surfaces: SessionSurfaceCandidate[]): SessionSurfaceCandidate[] {
	return [...surfaces].sort((a, b) => {
		// Selected surfaces first
		const aSel = a.selected ? 1 : 0;
		const bSel = b.selected ? 1 : 0;
		if (aSel !== bSel) return bSel - aSel;

		// Pi/chat/agent/codex titles next
		const aPi = isLikelyAgentSurface(a.title);
		const bPi = isLikelyAgentSurface(b.title);
		if (aPi !== bPi) return (bPi ? 1 : 0) - (aPi ? 1 : 0);

		// Then by existing score if present
		const aScore = a.score ?? 0;
		const bScore = b.score ?? 0;
		return bScore - aScore;
	});
}

function isLikelyAgentSurface(title: string): boolean {
	return /\b(pi|\u03c0|codex|agent|chat|assistant|backend|local ci|terminal)\b/i.test(title);
}

async function inspectWorkspaceSurfaces(
	workspace: SessionWorkspaceCandidate,
	surfaces: SessionSurfaceCandidate[],
	lines: number,
	scrollback: boolean,
	maxSurfaces: number,
	exec: SessionExecFn,
	cmux: string,
	ctx: ToolExecutionContext,
	started: number,
): Promise<ToolResult<InspectSessionData>> {
	if (surfaces.length === 0) {
		return makeResult(ctx, true, `Workspace "${workspace.name}" has no visible tabs.`, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
		}, Date.now() - started, false);
	}

	const ranked = rankSurfaces(surfaces);
	const selected = ranked.slice(0, maxSurfaces);

	const inspected: InspectedSurface[] = [];
	const parts: string[] = [];
	let successfulReads = 0;

	for (const surface of selected) {
		const result = await readSurfaceScreen(workspace.ref, surface.ref, surface.title, lines, scrollback, exec, cmux);
		if (result.ok) {
			successfulReads++;
			inspected.push({ ref: surface.ref, title: surface.title, screenText: result.text });
			parts.push(`### ${surface.title} (${surface.ref})${surface.selected ? " [focused]" : ""}\n${result.text}`);
		} else {
			inspected.push({ ref: surface.ref, title: surface.title, screenText: `(read failed: ${result.error})` });
			parts.push(`### ${surface.title} (${surface.ref})${surface.selected ? " [focused]" : ""}\n(read failed: ${result.error})`);
		}
	}

	const skipped = surfaces.length - selected.length;
	let summary = `Inspected ${inspected.length} tab(s) in "${workspace.name}"${skipped > 0 ? ` (${skipped} others skipped)` : ""}:\n\n`;
	summary += parts.join("\n\n");

	const primary = inspected[0];
	return makeResult(ctx, successfulReads > 0, summary, {
		workspaceRef: workspace.ref,
		workspaceName: workspace.name,
		surfaceRef: primary?.ref,
		surfaceTitle: primary?.title,
		screenText: primary?.screenText,
		inspectedSurfaces: inspected,
		candidates: surfaces,
	}, Date.now() - started, successfulReads === 0, successfulReads === 0 ? "execution.exit_nonzero" : undefined);
}

function makeResult(
	ctx: ToolExecutionContext,
	success: boolean,
	text: string,
	data: InspectSessionData,
	timingMs: number,
	retryable: boolean,
	failureCode?: Extract<FailureCode, `resolution.${string}` | `execution.${string}`>,
): ToolResult<InspectSessionData> {
	const primaryLabel = data.surfaceTitle
		? `${data.workspaceName ?? data.workspaceRef} / ${data.surfaceTitle}`
		: data.workspaceName ?? data.workspaceRef ?? "unknown workspace";
	const countLabel = data.inspectedSurfaces && data.inspectedSurfaces.length > 1
		? ` (${data.inspectedSurfaces.length} tabs)`
		: "";
	return {
		tool: "inspect_session",
		toolCallId: ctx.toolCallId,
		success,
		text,
		data,
		displayText: success
			? `Screen for ${primaryLabel}${countLabel}:\n${text}`
			: text,
		retryable,
		failure: failureCode ? createStructuredFailure({
			stage: failureCode.startsWith("resolution.") ? "resolve" : "execute",
			code: failureCode,
			component: "inspect-session",
			message: text,
			retryable,
			detector: { id: "alfred.inspect-session.typed", version: 1 },
		}) : undefined,
		safety: { risk: "read", confirmation: "none" },
		timingMs,
		cwd: ctx.cwd,
		workspaceRef: data.workspaceRef ?? ctx.workspaceRef,
	};
}

async function resolveWorkspace(
	toolCall: SessionTargetToolCall,
	ctx: ToolExecutionContext,
	systemContext: string,
	exec: SessionExecFn,
	cmux: string,
): Promise<
	| { kind: "resolved"; workspace: SessionWorkspaceCandidate }
	| { kind: "ambiguous"; candidates: SessionWorkspaceCandidate[] }
	| { kind: "missing"; message: string; candidates?: SessionWorkspaceCandidate[] }
> {
	const contextWorkspaces = parseWorkspacesFromContext(systemContext);
	const requestedRef = nonEmpty(toolCall.workspaceRef);
	if (requestedRef) {
		const fromContext = contextWorkspaces.find((workspace) => workspace.ref === requestedRef);
		return { kind: "resolved", workspace: fromContext ?? { ref: requestedRef, name: requestedRef } };
	}

	if (toolCall.workspaceName) {
		const contextMatch = bestWorkspaceMatches(contextWorkspaces, toolCall.workspaceName);
		if (contextMatch.kind !== "missing") return contextMatch;

		const listed = await listWorkspaces(exec, cmux);
		if (!listed.ok) {
			return {
				kind: "missing",
				message: `Could not resolve workspace "${toolCall.workspaceName}" from context, and cmux workspace list failed: ${listed.message}`,
				candidates: contextWorkspaces,
			};
		}
		return bestWorkspaceMatches(listed.value, toolCall.workspaceName);
	}

	const contextRef = nonEmpty(ctx.workspaceRef);
	if (contextRef) {
		const fromContext = contextWorkspaces.find((workspace) => workspace.ref === contextRef);
		return { kind: "resolved", workspace: fromContext ?? { ref: contextRef, name: contextRef } };
	}

	const selected = contextWorkspaces.find((workspace) => workspace.selected) ?? contextWorkspaces[0];
	if (selected) return { kind: "resolved", workspace: selected };
	return { kind: "missing", message: "No workspace was specified and no current workspace was available." };
}

function parseWorkspacesFromContext(systemContext: string): SessionWorkspaceCandidate[] {
	const workspaces: SessionWorkspaceCandidate[] = [];
	for (const line of systemContext.split("\n")) {
		const match = line.match(/^\s*(.+?)( \[current\])? \| ref:([^|\s]+)(?:\s|\||$)/);
		if (!match) continue;
		workspaces.push({
			name: match[1]!.trim(),
			selected: Boolean(match[2]),
			ref: match[3]!.trim(),
		});
	}
	return workspaces;
}

async function listWorkspaces(exec: SessionExecFn, cmux: string): Promise<{ ok: true; value: SessionWorkspaceCandidate[] } | { ok: false; message: string }> {
	const result = await exec(cmux, ["workspace", "list", "--json", "--id-format", "both"], { timeoutMs: DEFAULT_TIMEOUT_MS });
	if (result.exitCode !== 0) return { ok: false, message: result.stderr || "cmux workspace list failed" };
	try {
		const parsed = JSON.parse(result.stdout) as { workspaces?: Array<{ ref?: string; title?: string; selected?: boolean }> };
		return {
			ok: true,
			value: (parsed.workspaces ?? [])
				.filter((workspace) => workspace.ref && workspace.title)
				.map((workspace) => ({ ref: workspace.ref!, name: workspace.title!.trim(), selected: Boolean(workspace.selected) })),
		};
	} catch (error) {
		return { ok: false, message: `Could not parse cmux workspace list: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function listSurfaces(workspaceRef: string, exec: SessionExecFn, cmux: string): Promise<{ ok: true; value: SessionSurfaceCandidate[] } | { ok: false; message: string }> {
	const json = await exec(cmux, ["tree", "--workspace", workspaceRef, "--json", "--id-format", "both"], { timeoutMs: DEFAULT_TIMEOUT_MS });
	if (json.exitCode === 0) {
		try {
			const parsed = JSON.parse(json.stdout) as unknown;
			const surfaces = parseSurfacesFromJsonTree(parsed);
			// Trust successful JSON parsing even when zero surfaces (empty workspace).
			return { ok: true, value: surfaces };
		} catch {
			// Fall through to text parsing.
		}
	}

	const text = await exec(cmux, ["tree", "--workspace", workspaceRef], { timeoutMs: DEFAULT_TIMEOUT_MS });
	if (text.exitCode === 0) {
		return { ok: true, value: parseSurfacesFromText(text.stdout) };
	}

	const legacy = await exec(cmux, ["list-pane-surfaces", "--workspace", workspaceRef], { timeoutMs: DEFAULT_TIMEOUT_MS });
	if (legacy.exitCode === 0) {
		return { ok: true, value: parseSurfacesFromText(legacy.stdout) };
	}

	return { ok: false, message: json.stderr || text.stderr || legacy.stderr || `Could not list tabs for ${workspaceRef}.` };
}

function parseSurfacesFromJsonTree(tree: unknown): SessionSurfaceCandidate[] {
	const surfaces: SessionSurfaceCandidate[] = [];
	walkJson(tree, (value) => {
		const ref = typeof value.ref === "string" ? value.ref : undefined;
		const title = typeof value.title === "string" ? value.title.trim() : undefined;
		if (ref?.startsWith("surface:") && title) {
			const rawScore = typeof value.relevance_score === "number" && Number.isFinite(value.relevance_score)
				? value.relevance_score
				: typeof value.score === "number" && Number.isFinite(value.score)
					? value.score
					: undefined;
			surfaces.push({
				ref,
				title,
				selected: Boolean(value.selected ?? value.selected_in_pane ?? value.focused ?? value.here),
				score: rawScore,
			});
		}
	});
	return dedupeSurfaces(surfaces);
}

function walkJson(value: unknown, visit: (obj: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) walkJson(item, visit);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const obj = value as Record<string, unknown>;
	visit(obj);
	for (const nested of Object.values(obj)) walkJson(nested, visit);
}

function parseSurfacesFromText(text: string): SessionSurfaceCandidate[] {
	const surfaces: SessionSurfaceCandidate[] = [];
	for (const line of text.split("\n")) {
		const quoted = line.match(/\b(surface:\d+)\b.*?"([^"]+)".*?(\[selected\]|selected)?/i);
		if (quoted) {
			surfaces.push({ ref: quoted[1]!, title: quoted[2]!.trim(), selected: Boolean(quoted[3]) });
			continue;
		}
		const plain = line.match(/\b(surface:\d+)\b\s+(.+?)\s*$/i);
		if (plain) surfaces.push({ ref: plain[1]!, title: plain[2]!.replace(/\[selected\]/i, "").trim(), selected: /\[selected\]|selected/i.test(line) });
	}
	return dedupeSurfaces(surfaces);
}

function resolveSurface(
	toolCall: SessionTargetToolCall,
	surfaces: SessionSurfaceCandidate[],
):
	| { kind: "resolved"; surface: SessionSurfaceCandidate }
	| { kind: "ambiguous"; candidates: SessionSurfaceCandidate[] }
	| { kind: "missing"; message: string; candidates: SessionSurfaceCandidate[] } {
	if (toolCall.surfaceRef) {
		const known = surfaces.find((surface) => surface.ref === toolCall.surfaceRef);
		return known
			? { kind: "resolved", surface: known }
			: { kind: "missing", message: `Surface ref ${toolCall.surfaceRef} is not currently visible. Visible tabs: ${formatSurfaceCandidates(surfaces)}`, candidates: surfaces };
	}
	// When neither surfaceRef nor tabHint is provided, this branch is unreachable from
	// inspectSession (gated by isWorkspaceOnly), but remains as a defensive fallback.
	if (!toolCall.tabHint) {
		const selected = surfaces.filter((surface) => surface.selected);
		if (selected.length === 1) return { kind: "resolved", surface: selected[0]! };
		if (surfaces.length === 1) return { kind: "resolved", surface: surfaces[0]! };
		return { kind: "missing", message: `No tab hint was provided. Visible tabs: ${formatSurfaceCandidates(surfaces)}`, candidates: surfaces };
	}

	const scored = surfaces
		.map((surface) => ({ ...surface, score: scoreMatch(surface.title, toolCall.tabHint!) }))
		.filter((surface) => (surface.score ?? 0) > 0)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	if (scored.length === 0) {
		return { kind: "missing", message: `No tabs matched "${toolCall.tabHint}". Visible tabs: ${formatSurfaceCandidates(surfaces)}`, candidates: surfaces };
	}
	const best = scored[0]!;
	const tied = scored.filter((surface) => Math.abs((surface.score ?? 0) - (best.score ?? 0)) < 0.05);
	if (tied.length > 1) return { kind: "ambiguous", candidates: tied };
	return { kind: "resolved", surface: best };
}

function bestWorkspaceMatches(workspaces: SessionWorkspaceCandidate[], query: string):
	| { kind: "resolved"; workspace: SessionWorkspaceCandidate }
	| { kind: "ambiguous"; candidates: SessionWorkspaceCandidate[] }
	| { kind: "missing"; message: string; candidates: SessionWorkspaceCandidate[] } {
	const scored = workspaces
		.map((workspace) => ({ ...workspace, score: scoreMatch(workspace.name, query) }))
		.filter((workspace) => (workspace.score ?? 0) > 0)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	if (scored.length === 0) return { kind: "missing", message: `No workspace matched "${query}".`, candidates: workspaces };
	const best = scored[0]!;
	const tied = scored.filter((workspace) => Math.abs((workspace.score ?? 0) - (best.score ?? 0)) < 0.05);
	if (tied.length > 1) return { kind: "ambiguous", candidates: tied };
	return { kind: "resolved", workspace: best };
}

function scoreMatch(text: string, query: string): number {
	const haystack = normalize(text);
	const needle = normalize(query);
	if (!haystack || !needle) return 0;
	if (haystack === needle) return 1;
	if (haystack.includes(needle)) return 0.95;
	const terms = needle.split(" ").filter(Boolean);
	if (terms.length > 0 && terms.every((term) => haystack.includes(term))) return 0.85;
	if (editDistance(haystack, needle) <= 2) return 0.8;
	return 0;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function dedupeSurfaces(surfaces: SessionSurfaceCandidate[]): SessionSurfaceCandidate[] {
	const map = new Map<string, SessionSurfaceCandidate>();
	for (const surface of surfaces) {
		if (!map.has(surface.ref)) map.set(surface.ref, surface);
	}
	return [...map.values()];
}

function formatSurfaceCandidates(candidates: SessionSurfaceCandidate[] = []): string {
	return candidates.map((candidate) => `${candidate.title} (${candidate.ref})`).join(", ") || "none";
}

function formatWorkspaceCandidates(candidates: SessionWorkspaceCandidate[] = []): string {
	return candidates.map((candidate) => `${candidate.name} (${candidate.ref})`).join(", ") || "none";
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function clampLines(lines: number): number {
	if (!Number.isFinite(lines)) return DEFAULT_LINES;
	return Math.max(20, Math.min(1_000, Math.floor(lines)));
}

function editDistance(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
	for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
		}
	}
	return dp[a.length]![b.length]!;
}
