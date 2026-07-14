import { createHash, randomUUID } from "node:crypto";
import {
	ALFRED_AUTONOMOUS_DEFAULTS,
	type AlfredToolCall,
	type AlfredToolName,
	type PendingConfirmation,
	type ToolRiskLevel,
} from "./tool-types.ts";

/**
 * Deterministic text preview for a pending confirmation.
 * Shows the exact command/payload and the resolved cwd so the user can
 * review exactly what will execute.
 */
export function createConfirmationPreview(toolCall: AlfredToolCall, cwd?: string): string {
	const cwdLine = cwd ? `\nCwd: ${cwd}` : "";
	switch (toolCall.tool) {
		case "bash":
			return `[BASH] ${toolCall.command}${cwdLine}`;
		case "write_file":
			return `[WRITE] ${toolCall.path}${cwdLine}`;
		case "edit_file":
			return `[EDIT] ${toolCall.path}\nOld: ${toolCall.oldText.slice(0, 200)}${toolCall.oldText.length > 200 ? "..." : ""}\nNew: ${toolCall.newText.slice(0, 200)}${toolCall.newText.length > 200 ? "..." : ""}${cwdLine}`;
		case "read_file":
			return `[READ] ${toolCall.path}${cwdLine}`;
		case "web_search":
			return `[SEARCH] ${toolCall.query}`;
		case "fetch_content":
			return `[FETCH] ${toolCall.url}`;

		case "remember":
			return `[REMEMBER] ${toolCall.key} = ${toolCall.value}`;
		case "recall":
			return `[RECALL] ${toolCall.query ?? "all facts"}`;
		case "search_knowledge":
			return `[SEARCH_KNOWLEDGE] ${toolCall.query}`;
		case "import_knowledge":
			return toolCall.path
				? `[IMPORT_KNOWLEDGE]\nFile: ${toolCall.path}\nTitle: ${toolCall.title ?? "from filename"}${cwdLine}`
				: `[IMPORT_KNOWLEDGE — ASSISTANT CREATED]\nTitle: ${toolCall.title}\nContent (${Buffer.byteLength(toolCall.content ?? "", "utf8")} bytes):\n${toolCall.content ?? ""}`;
		case "set_voice_settings":
			return `[VOICE_SETTINGS] ${JSON.stringify({ fishSpeed: toolCall.fishSpeed, edgeRate: toolCall.edgeRate, speechStyle: toolCall.speechStyle, witLevel: toolCall.witLevel, sarcasmLevel: toolCall.sarcasmLevel, provider: toolCall.provider, fallbackProvider: toolCall.fallbackProvider })}`;
		case "refresh_context":
			return `[REFRESH_CONTEXT]\nForce fresh: ${toolCall.forceFresh !== false ? "yes" : "no"}`;
		case "inspect_session":
			return `[INSPECT_SESSION]\nWorkspace: ${toolCall.workspaceRef ?? toolCall.workspaceName ?? "current"}\nTab: ${toolCall.surfaceRef ?? toolCall.tabHint ?? "selected"}\nLines: ${toolCall.lines ?? 160}`;
		case "send_session_message":
			return `[SEND_SESSION_MESSAGE]\nWorkspace: ${toolCall.workspaceRef ?? toolCall.workspaceName ?? "current"}\nTab: ${toolCall.surfaceRef ?? toolCall.tabHint ?? "selected"}\nMode: ${toolCall.mode ?? "draft"}\nText: ${toolCall.text}`;
		case "start_session_monitor":
			return `[START_SESSION_MONITOR]\nWorkspace: ${toolCall.workspaceRef ?? toolCall.workspaceName ?? "current"}\nTab: ${toolCall.surfaceRef ?? toolCall.tabHint ?? "selected"}\nReply mode: ${toolCall.replyMode ?? "draft"}\nPoll interval: ${toolCall.pollIntervalMs ?? 12000} ms\nMax turns: ${toolCall.maxTurns ?? 6}\nGoal: ${toolCall.goal}`;
		case "poll_session_monitor":
			return `[POLL_SESSION_MONITOR] ${toolCall.monitorId ?? "active monitor"}`;
		case "session_monitor_status":
			return `[SESSION_MONITOR_STATUS] ${toolCall.monitorId ?? "all monitors"}`;
		case "stop_session_monitor":
			return `[STOP_SESSION_MONITOR] ${toolCall.monitorId ?? "active monitor"}`;
		case "gmail_search":
			return `[GMAIL_SEARCH] ${toolCall.query}`;
		case "gmail_read":
			return `[GMAIL_READ] ${toolCall.messageId}`;
		case "calendar_today":
			return `[CALENDAR_TODAY] ${toolCall.calendarId ?? "primary"}`;
		case "calendar_upcoming":
			return `[CALENDAR_UPCOMING] ${toolCall.calendarId ?? "primary"} max=${toolCall.maxResults ?? 10}`;
		case "docs_search":
			return `[DOCS_SEARCH] ${toolCall.query}`;
		case "docs_read":
			return `[DOCS_READ] ${toolCall.documentId}`;
		case "log_break":
			return `[LOG_BREAK] Reset active work timer and record break`;
		case "wellness_status":
			return `[WELLNESS_STATUS]`;
	}
}

/**
 * Compute a SHA256 hex digest of a tool call payload for integrity verification.
 * Uses deterministic JSON serialization so the same payload always produces the
 * same hash.
 */
export function hashPayload(payload: AlfredToolCall): string {
	const json = JSON.stringify(payload, Object.keys(payload).sort());
	return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Determine the expiry TTL for a given risk level using implementation defaults.
 */
export function ttlForRisk(risk: ToolRiskLevel): number {
	if (risk === "destructive") return ALFRED_AUTONOMOUS_DEFAULTS.destructiveConfirmationTtlMs;
	return ALFRED_AUTONOMOUS_DEFAULTS.confirmationTtlMs;
}

/**
 * In-memory store for pending tool call confirmations.
 *
 * Every stored confirmation includes an integrity hash (SHA256 of the exact
 * payload). On confirmation execution the stored payload is used — never a
 * regenerated LLM command.
 *
 * Expired confirmations are removed on read (get, getSole) and also via an
 * explicit expire() call.
 */
export class PendingConfirmationStore<P extends AlfredToolCall = AlfredToolCall> {
	private readonly store = new Map<string, PendingConfirmation<P>>();

	/**
	 * Store a new pending confirmation. Computes the payload hash if not already
	 * set, generates an id if missing, and sets expiry based on risk.
	 */
	add(confirmation: PendingConfirmation<P>): PendingConfirmation<P> {
		if (!confirmation.confirmationId) {
			(confirmation as { confirmationId: string }).confirmationId = `confirm-${randomUUID()}`;
		}
		if (!confirmation.payloadHash) {
			(confirmation as { payloadHash: string }).payloadHash = hashPayload(confirmation.payload);
		}
		if (!confirmation.createdAt) {
			(confirmation as { createdAt: string }).createdAt = new Date().toISOString();
		}
		if (!confirmation.expiresAt) {
			const ttl = ttlForRisk(confirmation.risk);
			(confirmation as { expiresAt: string }).expiresAt = new Date(Date.now() + ttl).toISOString();
		}
		this.store.set(confirmation.confirmationId, confirmation);
		return confirmation;
	}

	/** Retrieve a confirmation while preserving whether an existing entry expired. */
	lookup(id: string): { kind: "found"; confirmation: PendingConfirmation<P> } | { kind: "expired" } | { kind: "missing" } {
		const confirmation = this.store.get(id);
		if (!confirmation) return { kind: "missing" };
		if (new Date(confirmation.expiresAt) <= new Date()) {
			this.store.delete(id);
			return { kind: "expired" };
		}
		return { kind: "found", confirmation };
	}

	/**
	 * Retrieve a confirmation by id. Returns null if not found or if expired.
	 */
	get(id: string): PendingConfirmation<P> | null {
		const result = this.lookup(id);
		return result.kind === "found" ? result.confirmation : null;
	}

	/**
	 * Return the sole pending confirmation, or null if zero or more than one exist.
	 * Used for voice "yes"/"confirm" when there must be exactly one pending item.
	 */
	getSole(): PendingConfirmation<P> | null {
		this.expire();
		if (this.store.size !== 1) return null;
		return [...this.store.values()][0]!;
	}

	/**
	 * Remove a confirmation by id. Returns true if it was found and removed.
	 */
	remove(id: string): boolean {
		return this.store.delete(id);
	}

	/**
	 * Remove all expired confirmations.
	 */
	expire(): void {
		const now = new Date();
		for (const [id, confirmation] of this.store) {
			if (new Date(confirmation.expiresAt) <= now) {
				this.store.delete(id);
			}
		}
	}

	/**
	 * Return the count of non-expired confirmations.
	 */
	count(): number {
		this.expire();
		return this.store.size;
	}

	/**
	 * Verify that a confirmation's stored hash matches its payload.
	 * Returns false (and removes the confirmation) if tampering is detected.
	 */
	verifyIntegrity(id: string): boolean {
		const confirmation = this.get(id);
		if (!confirmation) return false;
		const expected = hashPayload(confirmation.payload);
		if (confirmation.payloadHash !== expected) {
			this.store.delete(id);
			return false;
		}
		return true;
	}

	/**
	 * Return all non-expired confirmations. Useful for resolving natural-language
	 * approval/denial messages against the exact stored payloads.
	 */
	list(): PendingConfirmation<P>[] {
		this.expire();
		return [...this.store.values()];
	}

	/**
	 * Return all non-expired confirmation ids. Useful for listing pending items
	 * when multiple exist and the user must choose.
	 */
	listIds(): string[] {
		return this.list().map((confirmation) => confirmation.confirmationId);
	}
}
