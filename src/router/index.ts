import type { AlfredCapability, AlfredError, AlfredRef, AlfredTarget, AlfredTargetAlias, AlfredTargetAliasScope } from "../contracts/runtime.ts";

export interface DraftIntent {
	target: AlfredTarget;
	message: string;
	confidence: AlfredTarget["confidence"];
}

export interface KeyIntent {
	target: AlfredTarget;
	key: string;
	confidence: AlfredTarget["confidence"];
}

export interface PlannerDraftMessageIntent {
	kind: "draft_message";
	message: string;
	targetRef?: AlfredRef;
	targetName?: string;
}

export interface PlannerDraftResolution {
	ok: boolean;
	intent?: DraftIntent;
	error?: AlfredError;
}

export type SafeAskActionId = "cmux.openDiff" | "cmux.openMarkdown" | "cmux.openUrl" | "cmux.openBrowserSurface" | "cmux.readNotifications";

export type AlfredPreWorldRoute =
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "needs_world" };

export type AlfredDeterministicRoute =
	| { kind: "list_targets" }
	| { kind: "current_workspace" }
	| { kind: "pending_actions" }
	| { kind: "list_aliases" }
	| { kind: "remember_alias"; alias: string; scope: AlfredTargetAliasScope; targetPhrase?: string }
	| { kind: "forget_alias"; alias: string; scope?: AlfredTargetAliasScope }
	| { kind: "clarification"; code: "target_ambiguous" | "target_not_found" | "unsupported_action"; prompt: string; candidates: AlfredTarget[] }
	| { kind: "safe_action"; actionId: SafeAskActionId; input: Record<string, unknown> }
	| { kind: "send_key"; intent: KeyIntent }
	| { kind: "draft_message"; intent: DraftIntent }
	| { kind: "no_match" };

export interface RouteAskInput {
	inputText: string;
	targets: readonly AlfredTarget[];
	currentWorkspaceRef?: AlfredRef;
	aliases?: readonly AlfredTargetAlias[];
	recentTargets?: readonly AlfredTarget[];
}

export type TargetResolution =
	| { kind: "resolved"; target: AlfredTarget; confidence: AlfredTarget["confidence"] }
	| { kind: "ambiguous"; candidates: AlfredTarget[] }
	| { kind: "not_found" };

interface ResolveOptions {
	currentWorkspaceRef?: AlfredRef;
	aliases?: readonly AlfredTargetAlias[];
	recentTargets?: readonly AlfredTarget[];
}

export function routeAskBeforeWorld(inputText: string): AlfredPreWorldRoute {
	if (isConfirmInput(inputText)) return { kind: "confirm" };
	if (isCancelInput(inputText)) return { kind: "cancel" };
	return { kind: "needs_world" };
}

export function routeAskWithWorld(input: RouteAskInput): AlfredDeterministicRoute {
	const inputText = input.inputText;
	const targets = [...input.targets];
	const options: ResolveOptions = { currentWorkspaceRef: input.currentWorkspaceRef, aliases: input.aliases, recentTargets: input.recentTargets };
	if (isTargetListInput(inputText)) return { kind: "list_targets" };
	if (isCurrentWorkspaceInput(inputText)) return { kind: "current_workspace" };
	if (isPendingActionsInput(inputText)) return { kind: "pending_actions" };
	if (isListAliasesInput(inputText)) return { kind: "list_aliases" };
	const forgetAlias = parseForgetAliasInput(inputText);
	if (forgetAlias) return forgetAlias;
	const rememberAlias = parseRememberAliasInput(inputText);
	if (rememberAlias) return rememberAlias;
	if (isOpenDiffInput(inputText)) return { kind: "safe_action", actionId: "cmux.openDiff", input: { unstaged: true } };
	const browserInput = parseOpenBrowserInput(inputText);
	if (browserInput) return { kind: "safe_action", actionId: "cmux.openBrowserSurface", input: browserInput };
	const markdownPath = parseOpenMarkdownInput(inputText);
	if (markdownPath) return { kind: "safe_action", actionId: "cmux.openMarkdown", input: { path: markdownPath } };
	const urlToOpen = parseOpenUrlInput(inputText);
	if (urlToOpen) return { kind: "safe_action", actionId: "cmux.openUrl", input: { url: urlToOpen } };
	const unreadNotifications = parseUnreadNotificationsInput(inputText);
	if (unreadNotifications) return { kind: "safe_action", actionId: "cmux.readNotifications", input: unreadNotifications };
	if (isReadNotificationsInput(inputText)) return { kind: "safe_action", actionId: "cmux.readNotifications", input: {} };
	const keyIntent = resolveSendKeyIntent(inputText, targets, options);
	if (keyIntent.kind === "resolved") return { kind: "send_key", intent: keyIntent.intent };
	if (keyIntent.kind === "clarification") return keyIntent.route;
	const draftIntent = resolveDraftIntent(inputText, targets, options);
	if (draftIntent.kind === "resolved") return { kind: "draft_message", intent: draftIntent.intent };
	if (draftIntent.kind === "clarification") return draftIntent.route;
	if (/^(?:open|show|read|send|tell|message|ask|press|remember|forget)\b/i.test(inputText.trim())) {
		return { kind: "clarification", code: "unsupported_action", prompt: "I don't know how to do that yet. Try asking for targets, opening a diff/markdown/URL/browser, reading notifications, or drafting a message to a target.", candidates: [] };
	}
	return { kind: "no_match" };
}

export function resolvePlannerDraftIntent(intent: PlannerDraftMessageIntent, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef, aliases: readonly AlfredTargetAlias[] = [], recentTargets: readonly AlfredTarget[] = []): PlannerDraftResolution {
	if (intent.targetRef) {
		const refMatches = targetRefMatches(targets, intent.targetRef);
		if (refMatches.length !== 1) {
			return { ok: false, error: { code: refMatches.length > 1 ? "target_ambiguous" : "target_not_found", message: refMatches.length > 1 ? "Planner targetRef matched multiple visible targets." : "Planner targetRef did not match a visible target.", retryable: false } };
		}
		if (intent.targetName) {
			const named = resolveTargetPhrase(intent.targetName, targets, { currentWorkspaceRef, aliases, recentTargets });
			if (named.kind === "resolved" && !sameTarget(named.target, refMatches[0]!)) {
				return { ok: false, error: { code: "target_ambiguous", message: "Planner targetRef and targetName identified different visible targets.", retryable: false } };
			}
		}
		const target = refMatches[0]!;
		return { ok: true, intent: { target, message: intent.message, confidence: target.confidence ?? "exact" } };
	}
	if (intent.targetName) {
		const resolved = resolveTargetPhrase(intent.targetName, targets, { currentWorkspaceRef, aliases, recentTargets });
		if (resolved.kind === "resolved") return { ok: true, intent: { target: resolved.target, message: intent.message, confidence: resolved.confidence } };
		return { ok: false, error: { code: resolved.kind === "ambiguous" ? "target_ambiguous" : "target_not_found", message: resolved.kind === "ambiguous" ? "Planner targetName matched multiple visible targets." : "Planner targetName did not match a visible target.", retryable: false } };
	}
	return { ok: false, error: { code: "target_not_found", message: "Planner draft target could not be resolved.", retryable: false } };
}

function targetRefMatches(targets: AlfredTarget[], targetRef: AlfredRef): AlfredTarget[] {
	return targets.filter((target) => requiredSendCapabilities(target).length > 0 && (target.ref === targetRef || target.surfaceRef === targetRef || target.workspaceRef === targetRef));
}

function sameTarget(left: AlfredTarget, right: AlfredTarget): boolean {
	return left.ref === right.ref || (left.surfaceRef !== undefined && left.surfaceRef === right.surfaceRef);
}

export function resolveSendKeyIntent(inputText: string, targets: AlfredTarget[], options: ResolveOptions = {}): { kind: "resolved"; intent: KeyIntent } | { kind: "clarification"; route: Extract<AlfredDeterministicRoute, { kind: "clarification" }> } | { kind: "no_match" } {
	const normalized = inputText.trim();
	const sendKey = normalized.match(/^(?:send\s+key|press)\s+(.+?)\s+(?:to|in|on)\s+(.+)$/i);
	if (!sendKey?.[1] || !sendKey[2]) return { kind: "no_match" };
	const key = normalizeKeyName(sendKey[1]);
	if (!key) return { kind: "no_match" };
	const resolution = resolveTargetPhrase(sendKey[2], targets, options);
	if (resolution.kind === "resolved") return { kind: "resolved", intent: { target: resolution.target, key, confidence: resolution.confidence } };
	return { kind: "clarification", route: clarificationForTargetResolution(resolution, sendKey[2]) };
}

function normalizeKeyName(value: string): string {
	return value.trim().replace(/^the\s+/i, "").replace(/\s+/g, " ");
}

export function resolveDraftIntent(inputText: string, targets: AlfredTarget[], options: ResolveOptions = {}): { kind: "resolved"; intent: DraftIntent } | { kind: "clarification"; route: Extract<AlfredDeterministicRoute, { kind: "clarification" }> } | { kind: "no_match" } {
	const normalized = inputText.trim();
	const useSession = normalized.match(/^(?:use|talk to|work with|ask)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+and\s+(.+)$/i);
	if (useSession?.[1] && useSession[2]) return resolveTargetAndMessage(useSession[1], useSession[2], targets, options);
	const askSession = normalized.match(/^(?:ask|tell|message|send)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+(?:to|that|saying)\s+(.+)$/i);
	if (askSession?.[1] && askSession[2]) return resolveTargetAndMessage(askSession[1], askSession[2], targets, options);
	const command = normalized.match(/^(?:tell|send|message|ask)\s+(.+)$/i);
	if (!command?.[1]) return { kind: "no_match" };
	const tokens = command[1].trim().split(/\s+/).filter(Boolean);
	let lastClarification: Extract<AlfredDeterministicRoute, { kind: "clarification" }> | null = null;
	for (let index = Math.min(tokens.length - 1, 8); index >= 1; index -= 1) {
		const targetPhrase = tokens.slice(0, index).join(" ");
		const message = tokens.slice(index).join(" ").trim();
		if (!message) continue;
		const resolved = resolveTargetAndMessage(targetPhrase, message, targets, options);
		if (resolved.kind === "resolved") return resolved;
		if (resolved.kind === "clarification" && resolved.route.code === "target_ambiguous") return resolved;
		if (resolved.kind === "clarification") lastClarification = resolved.route;
	}
	return lastClarification ? { kind: "clarification", route: lastClarification } : { kind: "no_match" };
}

function resolveTargetAndMessage(targetPhrase: string, message: string, targets: AlfredTarget[], options: ResolveOptions): { kind: "resolved"; intent: DraftIntent } | { kind: "clarification"; route: Extract<AlfredDeterministicRoute, { kind: "clarification" }> } {
	const resolution = resolveTargetPhrase(targetPhrase, targets, options);
	if (resolution.kind === "resolved") return { kind: "resolved", intent: { target: resolution.target, message: message.trim(), confidence: resolution.confidence } };
	return { kind: "clarification", route: clarificationForTargetResolution(resolution, targetPhrase) };
}

export function resolveTargetPhrase(targetPhrase: string, targets: readonly AlfredTarget[], options: ResolveOptions = {}): TargetResolution {
	const normalizedQuery = normalizeForMatch(targetPhrase);
	if (!normalizedQuery) return { kind: "not_found" };
	const liveTargets = [...targets].filter((target) => requiredSendCapabilities(target).length > 0);
	const exactRefs = liveTargets.filter((target) => target.ref === targetPhrase || target.surfaceRef === targetPhrase || target.workspaceRef === targetPhrase);
	if (exactRefs.length === 1) return { kind: "resolved", target: withConfidence(exactRefs[0]!, "exact"), confidence: "exact" };
	if (exactRefs.length > 1) return { kind: "ambiguous", candidates: exactRefs };

	const workspaceAliases = (options.aliases ?? []).filter((alias) => alias.scope === "workspace" && alias.workspaceRef === options.currentWorkspaceRef && alias.normalizedAlias === normalizedQuery);
	const workspaceAliasResolution = resolveAliasMatches(workspaceAliases, liveTargets);
	if (workspaceAliasResolution) return workspaceAliasResolution;
	const globalAliases = (options.aliases ?? []).filter((alias) => alias.scope === "global" && alias.normalizedAlias === normalizedQuery);
	const globalAliasResolution = resolveAliasMatches(globalAliases, liveTargets);
	if (globalAliasResolution) return globalAliasResolution;

	const scoped = options.currentWorkspaceRef ? liveTargets.filter((target) => target.workspaceRef === options.currentWorkspaceRef || target.ref === options.currentWorkspaceRef) : [];
	const exactScoped = exactTitleMatches(scoped, normalizedQuery);
	if (exactScoped.length === 1) return { kind: "resolved", target: withConfidence(exactScoped[0]!, "exact"), confidence: "exact" };
	if (exactScoped.length > 1) return { kind: "ambiguous", candidates: exactScoped };
	const exactAll = exactTitleMatches(liveTargets, normalizedQuery);
	if (exactAll.length === 1) return { kind: "resolved", target: withConfidence(exactAll[0]!, "exact"), confidence: "exact" };
	if (exactAll.length > 1) return { kind: "ambiguous", candidates: exactAll };

	const recent = findRecentTargetInWorkspace(normalizedQuery, liveTargets, options);
	if (recent) return { kind: "resolved", target: withConfidence(recent, "inferred"), confidence: "inferred" };

	if (scoped.length > 0) {
		const scopedMatches = bestTargetMatches(scoped, normalizedQuery);
		if (scopedMatches.length === 1) return { kind: "resolved", target: scopedMatches[0]!, confidence: scopedMatches[0]!.confidence ?? "unknown" };
		if (scopedMatches.length > 1) return { kind: "ambiguous", candidates: scopedMatches };
	}
	const matches = bestTargetMatches(liveTargets, normalizedQuery);
	if (matches.length === 1) return { kind: "resolved", target: matches[0]!, confidence: matches[0]!.confidence ?? "unknown" };
	if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
	return { kind: "not_found" };
}

function resolveAliasMatches(aliases: readonly AlfredTargetAlias[], liveTargets: readonly AlfredTarget[]): TargetResolution | null {
	if (aliases.length === 0) return null;
	const live = aliases.map((alias) => liveTargets.find((target) => target.ref === alias.targetRef || target.surfaceRef === alias.targetRef || target.workspaceRef === alias.targetRef)).filter((target): target is AlfredTarget => Boolean(target));
	const unique = uniqueTargets(live);
	if (unique.length === 1) return { kind: "resolved", target: withConfidence(unique[0]!, "exact"), confidence: "exact" };
	if (unique.length > 1) return { kind: "ambiguous", candidates: unique };
	return { kind: "not_found" };
}

function exactTitleMatches(targets: readonly AlfredTarget[], normalizedQuery: string): AlfredTarget[] {
	return targets.filter((target) => [target.label, String(target.metadata?.normalizedTitle ?? "")].map(normalizeForMatch).filter(Boolean).some((label) => label === normalizedQuery));
}

function findRecentTargetInWorkspace(normalizedQuery: string, liveTargets: readonly AlfredTarget[], options: ResolveOptions): AlfredTarget | null {
	if (!options.currentWorkspaceRef) return null;
	const recentMatches = (options.recentTargets ?? []).filter((target) => target.workspaceRef === options.currentWorkspaceRef && normalizeForMatch(target.label) === normalizedQuery);
	for (const recent of recentMatches) {
		const live = liveTargets.find((target) => sameTarget(target, recent) || target.ref === recent.ref || target.surfaceRef === recent.surfaceRef);
		if (live) return live;
	}
	return null;
}

function uniqueTargets(targets: readonly AlfredTarget[]): AlfredTarget[] {
	const seen = new Set<string>();
	const result: AlfredTarget[] = [];
	for (const target of targets) {
		const key = target.surfaceRef ?? target.ref;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(target);
	}
	return result;
}

function withConfidence(target: AlfredTarget, confidence: AlfredTarget["confidence"]): AlfredTarget {
	return { ...target, confidence };
}

function clarificationForTargetResolution(resolution: Exclude<TargetResolution, { kind: "resolved" }>, targetPhrase: string): Extract<AlfredDeterministicRoute, { kind: "clarification" }> {
	if (resolution.kind === "ambiguous") {
		return { kind: "clarification", code: "target_ambiguous", prompt: `Which target did you mean by "${targetPhrase}"?`, candidates: resolution.candidates };
	}
	return { kind: "clarification", code: "target_not_found", prompt: `I couldn't find a live target named "${targetPhrase}".`, candidates: [] };
}

function prioritizeCurrentWorkspace(targets: AlfredTarget[], currentWorkspaceRef: AlfredRef): AlfredTarget[] {
	const current = targets.filter((target) => target.workspaceRef === currentWorkspaceRef || target.ref === currentWorkspaceRef);
	return current.length > 0 ? current : targets;
}

export function bestTargetMatches(targets: AlfredTarget[], normalizedQuery: string): AlfredTarget[] {
	if (!normalizedQuery) return [];
	const sendable = targets.filter((target) => requiredSendCapabilities(target).length > 0);
	const scored = sendable
		.map((target) => ({ target, score: matchScore(target, normalizedQuery) }))
		.filter(({ score }) => score < Number.POSITIVE_INFINITY)
		.sort((left, right) => left.score - right.score || targetKindPriority(left.target) - targetKindPriority(right.target));
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

function targetKindPriority(target: AlfredTarget): number {
	if (target.kind === "pi-chat" || target.kind === "codex-session" || target.kind === "cmux-surface" || target.kind === "terminal") return 0;
	if (target.kind === "cmux-workspace") return 1;
	return 2;
}

export function normalizeForMatch(value: string): string {
	return value.toLowerCase().replace(/^π\s*-\s*/i, "").replace(/[-_\s]+/g, " ").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

export function isTargetListInput(inputText: string): boolean {
	return /^(?:what\s+)?(?:targets|surfaces|workspaces)(?:\s+are\s+(?:active|visible|available))?\??$/i.test(inputText.trim())
		|| /^(?:what|which)\s+(?:targets|surfaces|workspaces)\s+(?:are\s+)?(?:active|visible|available)\??$/i.test(inputText.trim());
}

export function isCurrentWorkspaceInput(inputText: string): boolean {
	return /^(?:what|which)\s+(?:is\s+)?(?:the\s+)?current\s+workspace\??$/i.test(inputText.trim())
		|| /^where\s+am\s+i\??$/i.test(inputText.trim());
}

export function isPendingActionsInput(inputText: string): boolean {
	return /^(?:what\s+)?pending\s+actions(?:\s+(?:exist|are\s+there))?\??$/i.test(inputText.trim())
		|| /^(?:list|show)\s+(?:the\s+)?pending\s+actions\??$/i.test(inputText.trim());
}

function isListAliasesInput(inputText: string): boolean {
	return /^(?:list|show|what\s+are)\s+(?:target\s+)?aliases\??$/i.test(inputText.trim());
}

function parseRememberAliasInput(inputText: string): Extract<AlfredDeterministicRoute, { kind: "remember_alias" }> | null {
	const normalized = inputText.trim();
	const current = normalized.match(/^remember\s+(?:this|current)(?:\s+target|\s+surface|\s+session)?\s+as\s+(.+)$/i);
	if (current?.[1]) return { kind: "remember_alias", alias: current[1].trim(), scope: "workspace" };
	const globalCurrent = normalized.match(/^remember\s+(?:this|current)(?:\s+target|\s+surface|\s+session)?\s+globally\s+as\s+(.+)$/i);
	if (globalCurrent?.[1]) return { kind: "remember_alias", alias: globalCurrent[1].trim(), scope: "global" };
	const global = normalized.match(/^remember\s+(.+?)\s+globally\s+as\s+(.+)$/i);
	if (global?.[1] && global[2]) return { kind: "remember_alias", targetPhrase: global[1].trim(), alias: global[2].trim(), scope: "global" };
	const explicit = normalized.match(/^remember\s+(.+?)\s+as\s+(.+)$/i);
	if (explicit?.[1] && explicit[2]) return { kind: "remember_alias", targetPhrase: explicit[1].trim(), alias: explicit[2].trim(), scope: "workspace" };
	return null;
}

function parseForgetAliasInput(inputText: string): Extract<AlfredDeterministicRoute, { kind: "forget_alias" }> | null {
	const match = inputText.trim().match(/^forget\s+(?:target\s+)?alias\s+(.+)$/i);
	if (!match?.[1]) return null;
	let alias = match[1].trim();
	let scope: AlfredTargetAliasScope | undefined;
	if (/\s+globally$/i.test(alias)) {
		scope = "global";
		alias = alias.replace(/\s+globally$/i, "").trim();
	} else if (/\s+in\s+this\s+workspace$/i.test(alias)) {
		scope = "workspace";
		alias = alias.replace(/\s+in\s+this\s+workspace$/i, "").trim();
	}
	return alias ? { kind: "forget_alias", alias, scope } : null;
}

export function isOpenDiffInput(inputText: string): boolean {
	return /^(?:open|show)\s+(?:the\s+)?(?:diff|changes)(?:\s+view)?$/i.test(inputText.trim());
}

function parseOpenBrowserInput(inputText: string): Record<string, unknown> | null {
	const match = inputText.trim().match(/^(?:open|show|inspect)\s+(?:a\s+)?browser(?:\s+(https?:\/\/\S+))?$/i);
	const rawUrl = match?.[1]?.trim();
	if (!match) return null;
	if (!rawUrl) return {};
	try {
		const url = new URL(rawUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? { url: url.href } : null;
	} catch {
		return null;
	}
}

export function parseOpenMarkdownInput(inputText: string): string | null {
	const match = inputText.trim().match(/^(?:open|show)\s+(?:markdown|md)(?:\s+(?:file|preview))?\s+(.+)$/i);
	const path = match?.[1]?.trim();
	return path && isSafeRelativeMarkdownPath(path) ? path : null;
}

export function isSafeRelativeMarkdownPath(path: string): boolean {
	if (!/\.(?:md|markdown)$/i.test(path)) return false;
	if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("~") || path.startsWith("-")) return false;
	if (/^[a-z]:[\\/]/i.test(path)) return false;
	const parts = path.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 && parts.every((part) => part !== "." && part !== ".." && !part.startsWith("-"));
}

export function parseOpenUrlInput(inputText: string): string | null {
	const match = inputText.trim().match(/^(?:open|show)\s+(?:url\s+)?(https?:\/\/\S+)$/i);
	const rawUrl = match?.[1]?.trim();
	if (!rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

function parseUnreadNotificationsInput(inputText: string): Record<string, unknown> | null {
	const text = inputText.trim();
	if (/^(?:how\s+many|count)\s+unread\s+(?:cmux\s+)?notifications\??$/i.test(text)) return { filter: "unread", countOnly: true };
	if (/^(?:show|list|read)\s+unread\s+(?:cmux\s+)?notifications\??$/i.test(text)) return { filter: "unread" };
	return null;
}

export function isReadNotificationsInput(inputText: string): boolean {
	return /^(?:read|list|show)\s+(?:cmux\s+)?notifications\??$/i.test(inputText.trim())
		|| /^(?:what\s+)?notifications(?:\s+are\s+there)?\??$/i.test(inputText.trim());
}

export function isConfirmInput(inputText: string): boolean {
	return /^(yes|send that|confirm|go ahead|do it)$/i.test(inputText.trim());
}

export function isCancelInput(inputText: string): boolean {
	return /^(cancel|cancel that|never mind|nevermind|do not send|don't send)$/i.test(inputText.trim());
}

export function requiredSendCapabilities(target: AlfredTarget): AlfredCapability[] {
	if (target.kind === "cmux-workspace") return ["workspace.send"];
	if (target.surfaceRef || target.kind === "cmux-surface" || target.kind === "pi-chat" || target.kind === "codex-session" || target.kind === "terminal") return ["surface.send"];
	return [];
}

export function targetHasCapabilities(target: AlfredTarget, capabilities: readonly AlfredCapability[]): boolean {
	return capabilities.every((capability) => target.capabilities.includes(capability));
}

function levenshtein(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		let last = i - 1;
		previous[0] = i;
		for (let j = 1; j <= right.length; j += 1) {
			const old = previous[j]!;
			previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, last + (left[i - 1] === right[j - 1] ? 0 : 1));
			last = old;
		}
	}
	return previous[right.length]!;
}
