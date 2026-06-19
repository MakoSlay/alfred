import {
	DEFAULT_DRAFT_TTL_MS,
	redactedText,
	type AlfredDraft,
	type AlfredDraftAction,
	type AlfredEvent,
	type AlfredHandleRequest,
	type AlfredHandleResponse,
	type AlfredSource,
	type AlfredTarget,
} from "../contracts/runtime.ts";

export function piCommandSource(overrides: Partial<AlfredSource> = {}): AlfredSource {
	return {
		kind: "pi-command",
		id: "pi-main-session",
		label: "/alfred",
		userIntent: "typed",
		trustedLocalOnly: true,
		capabilities: ["world.read", "surface.read", "surface.send", "loop.manage"],
		presentation: { wantsSpeech: true, wantsText: true, style: "butler" },
		...overrides,
	};
}

export function cliSource(overrides: Partial<AlfredSource> = {}): AlfredSource {
	return {
		kind: "cli",
		id: "alfred-cli",
		trustedLocalOnly: true,
		capabilities: ["world.read", "history.read"],
		presentation: { wantsText: true, style: "plain" },
		...overrides,
	};
}

export function powerCodeTarget(overrides: Partial<AlfredTarget> = {}): AlfredTarget {
	return {
		kind: "pi-chat",
		ref: "surface:42",
		label: "π - Power Code",
		workspaceRef: "workspace:9",
		workspaceLabel: "Powerco",
		surfaceRef: "surface:42",
		processKind: "pi",
		confidence: "fuzzy",
		capabilities: ["surface.read", "surface.send"],
		...overrides,
	};
}

export function powerCodeDraftRequest(): AlfredHandleRequest {
	return {
		requestId: "req_powerco_001",
		createdAt: "2026-06-19T21:00:00.000Z",
		source: piCommandSource(),
		input: {
			text: "those are good suggestions. use my power co session in this workspace and try to implement ways to fix it",
		},
		context: {
			currentWorkspaceRef: "workspace:9",
			currentSurfaceRef: "surface:20",
			visibleTargets: [powerCodeTarget()],
		},
		policy: { requireConfirmationForSend: true, maxTranscriptChars: 12_000 },
	};
}

export function powerCodeDraftResponse(): AlfredHandleResponse {
	const createdAt = "2026-06-19T21:00:00.200Z";
	const expiresAt = new Date(Date.parse(createdAt) + DEFAULT_DRAFT_TTL_MS).toISOString();
	const source = piCommandSource();
	const target = powerCodeTarget({ capabilities: ["surface.read", "surface.send"] });
	const draftText = redactedText("Try implementing ways to fix it.");
	const action: AlfredDraftAction = {
		id: "act_draft_001",
		kind: "draft",
		createdAt,
		requestedBy: source,
		target,
		requiredCapabilities: ["surface.send"],
		status: "pending_confirmation",
		draftText,
		confirmBeforeSend: true,
		expiresAt,
	};
	const draft: AlfredDraft = {
		id: "draft_powerco_001",
		target,
		text: draftText,
		createdAt,
		expiresAt,
		status: "pending",
		createdBy: source,
	};
	const event: AlfredEvent = {
		id: "evt_draft_001",
		kind: "draft.created",
		createdAt,
		requestId: "req_powerco_001",
		actionId: action.id,
		summary: "Created draft for π - Power Code.",
		redaction: { status: "not_needed" },
		retention: { policy: "session", expiresAt },
	};
	return {
		requestId: "req_powerco_001",
		createdAt,
		ok: true,
		speech: "Shall I send that to π - Power Code, sir?",
		displayText: "Draft ready for π - Power Code. Confirm before sending.",
		proposedActions: [action],
		pendingDraft: draft,
		events: [event],
	};
}
