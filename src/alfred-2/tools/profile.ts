import {
	type RememberToolCall,
	type RecallToolCall,
	type ToolExecutionContext,
	type ToolResult,
} from "../tool-types.ts";
import {
	getDefaultProfileStore,
	type ProfileStore,
	type UserFact,
} from "../profile.ts";

export function rememberProfileFact(
	toolCall: RememberToolCall,
	ctx: ToolExecutionContext,
	store: ProfileStore = getDefaultProfileStore(),
): ToolResult<UserFact> {
	const t0 = Date.now();
	try {
		const fact = store.rememberProfileMemory(
			{
				key: toolCall.key,
				value: toolCall.value,
				category: toolCall.category,
			},
			{
				source: "tool",
				sourceId: ctx.toolCallId,
				requestId: ctx.requestId,
				turnId: ctx.turnId,
				timestamp: new Date().toISOString(),
			},
		);
		return {
			tool: "remember",
			toolCallId: ctx.toolCallId,
			success: true,
			text: `Remembered: ${fact.key} = ${fact.value} (${fact.category})`,
			data: fact,
			retryable: false,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	} catch (cause) {
		return {
			tool: "remember",
			toolCallId: ctx.toolCallId,
			success: false,
			text: cause instanceof Error ? cause.message : "Could not persist profile memory.",
			retryable: true,
			safety: { risk: "mutation", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}
}

export function recallProfile(
	toolCall: RecallToolCall,
	ctx: ToolExecutionContext,
	store: ProfileStore = getDefaultProfileStore(),
): ToolResult<UserFact[]> {
	const t0 = Date.now();
	try {
		const facts = store.recallFact(toolCall.query);
		if (facts.length === 0) {
			const allContext = store.formatProfileForContext();
			return {
				tool: "recall",
				toolCallId: ctx.toolCallId,
				success: true,
				text: allContext,
				data: [],
				retryable: false,
				safety: { risk: "read", confirmation: "none" },
				timingMs: Date.now() - t0,
			};
		}
		const text = facts.map((fact) => `- ${fact.key}: ${fact.value} [${fact.category}]`).join("\n");
		return {
			tool: "recall",
			toolCallId: ctx.toolCallId,
			success: true,
			text,
			data: facts,
			retryable: false,
			safety: { risk: "read", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	} catch (cause) {
		return {
			tool: "recall",
			toolCallId: ctx.toolCallId,
			success: false,
			text: cause instanceof Error ? cause.message : "Could not load profile memory.",
			retryable: true,
			safety: { risk: "read", confirmation: "none" },
			timingMs: Date.now() - t0,
		};
	}
}

export function getProfileContext(store: ProfileStore = getDefaultProfileStore()): string {
	return store.formatProfileForContext();
}
