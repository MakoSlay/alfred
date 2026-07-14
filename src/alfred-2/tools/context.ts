import { gatherSystemContext } from "../context.ts";
import type { RefreshContextToolCall, ToolExecutionContext, ToolResult } from "../tool-types.ts";

export async function refreshContext(toolCall: RefreshContextToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
	const started = Date.now();
	const context = await gatherSystemContext(toolCall.forceFresh !== false);
	return {
		tool: "refresh_context",
		toolCallId: ctx.toolCallId,
		success: true,
		text: context.text,
		data: {
			gatheredAt: context.gatheredAt,
			workspaceCount: context.workspaceCount,
			prCount: context.prCount,
			notificationCount: context.notificationCount,
		},
		displayText: `Context refreshed: ${context.workspaceCount} workspace(s), ${context.prCount} PR signal(s), ${context.notificationCount} notification(s).`,
		retryable: false,
		safety: { risk: "read", confirmation: "none" },
		timingMs: Date.now() - started,
		cwd: ctx.cwd,
		workspaceRef: ctx.workspaceRef,
	};
}
