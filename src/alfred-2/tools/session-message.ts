import type { SendSessionMessageToolCall, ToolExecutionContext, ToolResult } from "../tool-types.ts";
import { createStructuredFailure } from "../capabilities/outcome.ts";
import type { FailureCode } from "../capabilities/failure-codes.ts";
import { defaultSessionExec, resolveSessionTarget, type InspectSessionOptions, type SessionExecFn } from "./session.ts";

export interface SendSessionMessageData {
	workspaceRef?: string;
	workspaceName?: string;
	surfaceRef?: string;
	surfaceTitle?: string;
	mode: "draft" | "send";
	text: string;
	cmuxArgs?: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SendSessionMessageOptions extends InspectSessionOptions {
	exec?: SessionExecFn;
	cmuxExecutable?: string;
}

export async function sendSessionMessage(
	toolCall: SendSessionMessageToolCall,
	ctx: ToolExecutionContext,
	options: SendSessionMessageOptions = {},
): Promise<ToolResult<SendSessionMessageData>> {
	const started = Date.now();
	const exec = options.exec ?? defaultSessionExec;
	const cmux = options.cmuxExecutable ?? "cmux";
	const mode = toolCall.mode ?? "draft";
	const target = await resolveSessionTarget(toolCall, ctx, options);
	if (target.kind !== "resolved") {
		return makeResult(ctx, false, target.message, {
			mode,
			text: toolCall.text,
		}, Date.now() - started, true, target.kind === "ambiguous" ? "resolution.ambiguous_target" : "resolution.target_not_found");
	}

	const { workspace, surface } = target.target;
	const textToSend = mode === "send" ? withEnter(toolCall.text) : toolCall.text;
	const args = ["send", "--workspace", workspace.ref, "--surface", surface.ref, textToSend];
	const result = await exec(cmux, args, { timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS });
	if (result.exitCode !== 0) {
		return makeResult(ctx, false, `cmux send failed for ${workspace.name} / ${surface.title}: ${result.stderr || "unknown error"}`, {
			workspaceRef: workspace.ref,
			workspaceName: workspace.name,
			surfaceRef: surface.ref,
			surfaceTitle: surface.title,
			mode,
			text: toolCall.text,
			cmuxArgs: args,
		}, Date.now() - started, true, "execution.exit_nonzero");
	}

	const action = mode === "send" ? "Sent" : "Drafted";
	return makeResult(ctx, true, `${action} message to ${workspace.name} / ${surface.title}.`, {
		workspaceRef: workspace.ref,
		workspaceName: workspace.name,
		surfaceRef: surface.ref,
		surfaceTitle: surface.title,
		mode,
		text: toolCall.text,
		cmuxArgs: args,
	}, Date.now() - started, false);
}

function withEnter(text: string): string {
	if (/((?:\\[nr])|[\n\r])$/.test(text)) return text;
	return `${text}\\n`;
}

function makeResult(
	ctx: ToolExecutionContext,
	success: boolean,
	text: string,
	data: SendSessionMessageData,
	timingMs: number,
	retryable: boolean,
	failureCode?: Extract<FailureCode, `resolution.${string}` | `execution.${string}`>,
): ToolResult<SendSessionMessageData> {
	return {
		tool: "send_session_message",
		toolCallId: ctx.toolCallId,
		success,
		text,
		data,
		displayText: text,
		retryable,
		failure: failureCode ? createStructuredFailure({
			stage: failureCode.startsWith("resolution.") ? "resolve" : "execute",
			code: failureCode,
			component: "send-session-message",
			message: text,
			retryable,
			detector: { id: "alfred.send-session-message.typed", version: 1 },
		}) : undefined,
		safety: { risk: "mutation", confirmation: "confirm" },
		timingMs,
		cwd: ctx.cwd,
		workspaceRef: data.workspaceRef ?? ctx.workspaceRef,
	};
}
