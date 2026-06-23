import type { AlfredCapability, AlfredError, AlfredRef, AlfredTarget } from "../contracts/runtime.ts";

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

export type SafeAskActionId = "cmux.openDiff" | "cmux.openMarkdown" | "cmux.openUrl" | "cmux.readNotifications";

export type AlfredPreWorldRoute =
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "needs_world" };

export type AlfredDeterministicRoute =
	| { kind: "list_targets" }
	| { kind: "current_workspace" }
	| { kind: "pending_actions" }
	| { kind: "safe_action"; actionId: SafeAskActionId; input: Record<string, unknown> }
	| { kind: "send_key"; intent: KeyIntent }
	| { kind: "draft_message"; intent: DraftIntent }
	| { kind: "no_match" };

export interface RouteAskInput {
	inputText: string;
	targets: readonly AlfredTarget[];
	currentWorkspaceRef?: AlfredRef;
}

export function routeAskBeforeWorld(inputText: string): AlfredPreWorldRoute {
	if (isConfirmInput(inputText)) return { kind: "confirm" };
	if (isCancelInput(inputText)) return { kind: "cancel" };
	return { kind: "needs_world" };
}

export function routeAskWithWorld(input: RouteAskInput): AlfredDeterministicRoute {
	const inputText = input.inputText;
	const targets = [...input.targets];
	if (isTargetListInput(inputText)) return { kind: "list_targets" };
	if (isCurrentWorkspaceInput(inputText)) return { kind: "current_workspace" };
	if (isPendingActionsInput(inputText)) return { kind: "pending_actions" };
	if (isOpenDiffInput(inputText)) return { kind: "safe_action", actionId: "cmux.openDiff", input: { unstaged: true } };
	const markdownPath = parseOpenMarkdownInput(inputText);
	if (markdownPath) return { kind: "safe_action", actionId: "cmux.openMarkdown", input: { path: markdownPath } };
	const urlToOpen = parseOpenUrlInput(inputText);
	if (urlToOpen) return { kind: "safe_action", actionId: "cmux.openUrl", input: { url: urlToOpen } };
	if (isReadNotificationsInput(inputText)) return { kind: "safe_action", actionId: "cmux.readNotifications", input: {} };
	const keyIntent = resolveSendKeyIntent(inputText, targets, input.currentWorkspaceRef);
	if (keyIntent) return { kind: "send_key", intent: keyIntent };
	const draftIntent = resolveDraftIntent(inputText, targets, input.currentWorkspaceRef);
	if (draftIntent) return { kind: "draft_message", intent: draftIntent };
	return { kind: "no_match" };
}

export function resolvePlannerDraftIntent(intent: PlannerDraftMessageIntent, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): PlannerDraftResolution {
	const refMatches = intent.targetRef ? targetRefMatches(targets, intent.targetRef) : [];
	if (intent.targetRef && refMatches.length !== 1) {
		return {
			ok: false,
			error: {
				code: refMatches.length > 1 ? "target_ambiguous" : "target_not_found",
				message: refMatches.length > 1 ? "Planner targetRef matched multiple visible targets." : "Planner targetRef did not match a visible target.",
				retryable: false,
			},
		};
	}
	if (intent.targetName) {
		const namedMatches = bestTargetMatches(currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets, normalizeForMatch(intent.targetName));
		if (!intent.targetRef) {
			if (namedMatches.length !== 1) {
				return {
					ok: false,
					error: {
						code: namedMatches.length > 1 ? "target_ambiguous" : "target_not_found",
						message: namedMatches.length > 1 ? "Planner targetName matched multiple visible targets." : "Planner targetName did not match a visible target.",
						retryable: false,
					},
				};
			}
			const target = namedMatches[0]!;
			return { ok: true, intent: { target, message: intent.message, confidence: target.confidence ?? "unknown" } };
		}
		if (namedMatches.length === 1 && refMatches[0] && !sameTarget(namedMatches[0]!, refMatches[0])) {
			return {
				ok: false,
				error: { code: "target_ambiguous", message: "Planner targetRef and targetName identified different visible targets.", retryable: false },
			};
		}
	}
	const target = refMatches[0];
	if (!target) {
		return { ok: false, error: { code: "target_not_found", message: "Planner draft target could not be resolved.", retryable: false } };
	}
	return { ok: true, intent: { target, message: intent.message, confidence: target.confidence ?? "exact" } };
}

function targetRefMatches(targets: AlfredTarget[], targetRef: AlfredRef): AlfredTarget[] {
	return targets.filter((target) => requiredSendCapabilities(target).length > 0 && (target.ref === targetRef || target.surfaceRef === targetRef || target.workspaceRef === targetRef));
}

function sameTarget(left: AlfredTarget, right: AlfredTarget): boolean {
	return left.ref === right.ref || (left.surfaceRef !== undefined && left.surfaceRef === right.surfaceRef);
}

export function resolveSendKeyIntent(inputText: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): KeyIntent | null {
	const normalized = inputText.trim();
	const sendKey = normalized.match(/^(?:send\s+key|press)\s+(.+?)\s+(?:to|in|on)\s+(.+)$/i);
	if (!sendKey?.[1] || !sendKey[2]) return null;
	const key = normalizeKeyName(sendKey[1]);
	if (!key) return null;
	const scopedTargets = currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets;
	const matches = bestTargetMatches(scopedTargets, normalizeForMatch(sendKey[2]));
	if (matches.length !== 1) return null;
	const target = matches[0]!;
	return { target, key, confidence: target.confidence ?? "unknown" };
}

function normalizeKeyName(value: string): string {
	return value.trim().replace(/^the\s+/i, "").replace(/\s+/g, " ");
}

export function resolveDraftIntent(inputText: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): DraftIntent | null {
	const normalized = inputText.trim();
	const useSession = normalized.match(/^(?:use|talk to|work with|ask)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+and\s+(.+)$/i);
	if (useSession?.[1] && useSession[2]) {
		return resolveTargetAndMessage(useSession[1], useSession[2], targets, currentWorkspaceRef);
	}
	const askSession = normalized.match(/^(?:ask|tell|message|send)\s+(?:my|the)?\s*(.+?)\s+(?:session|chat|tab)(?:\s+in\s+this\s+workspace)?\s+(?:to|that|saying)\s+(.+)$/i);
	if (askSession?.[1] && askSession[2]) {
		return resolveTargetAndMessage(askSession[1], askSession[2], targets, currentWorkspaceRef);
	}
	const command = normalized.match(/^(?:tell|send|message|ask)\s+(.+)$/i);
	if (!command?.[1]) return null;
	const tokens = command[1].trim().split(/\s+/).filter(Boolean);
	for (let index = Math.min(tokens.length - 1, 8); index >= 1; index -= 1) {
		const targetPhrase = tokens.slice(0, index).join(" ");
		const message = tokens.slice(index).join(" ").trim();
		if (!message) continue;
		const resolved = resolveTargetAndMessage(targetPhrase, message, targets, currentWorkspaceRef);
		if (resolved) return resolved;
	}
	return null;
}

function resolveTargetAndMessage(targetPhrase: string, message: string, targets: AlfredTarget[], currentWorkspaceRef?: AlfredRef): DraftIntent | null {
	const scopedTargets = currentWorkspaceRef ? prioritizeCurrentWorkspace(targets, currentWorkspaceRef) : targets;
	const matches = bestTargetMatches(scopedTargets, normalizeForMatch(targetPhrase));
	if (matches.length !== 1) return null;
	const target = matches[0]!;
	return { target, message: message.trim(), confidence: target.confidence ?? "unknown" };
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

export function isOpenDiffInput(inputText: string): boolean {
	return /^(?:open|show)\s+(?:the\s+)?(?:diff|changes)(?:\s+view)?$/i.test(inputText.trim());
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
			previous[j] = Math.min(
				previous[j]! + 1,
				previous[j - 1]! + 1,
				last + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			last = old;
		}
	}
	return previous[right.length]!;
}
