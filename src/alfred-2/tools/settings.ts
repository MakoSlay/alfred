import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getTtsSettings, updateTtsSettings, type TtsSettingsPatch } from "../speech.ts";
import type { SetVoiceSettingsToolCall, ToolExecutionContext, ToolResult } from "../tool-types.ts";

export function setVoiceSettings(toolCall: SetVoiceSettingsToolCall, ctx: ToolExecutionContext): ToolResult {
	const patch: TtsSettingsPatch = {};
	if (toolCall.fishSpeed !== undefined) patch.fishSpeed = toolCall.fishSpeed;
	if (toolCall.edgeRate !== undefined) patch.edgeRate = toolCall.edgeRate;
	if (toolCall.speechStyle !== undefined) patch.speechStyle = toolCall.speechStyle;
	if (toolCall.witLevel !== undefined) patch.witLevel = toolCall.witLevel;
	if (toolCall.sarcasmLevel !== undefined) patch.sarcasmLevel = toolCall.sarcasmLevel;
	if (toolCall.provider !== undefined) patch.provider = toolCall.provider;
	if (toolCall.fallbackProvider !== undefined) patch.fallbackProvider = toolCall.fallbackProvider;

	const settings = updateTtsSettings(patch);
	persistVoiceSettings(toolCall, settings);

	return {
		tool: "set_voice_settings",
		toolCallId: ctx.toolCallId,
		success: true,
		text: `Voice settings updated: provider=${settings.provider}, fishSpeed=${settings.fishSpeed}, edgeRate=${settings.edgeRate}, tone=${settings.speechStyle}, wit=${settings.witLevel}, sarcasm=${settings.sarcasmLevel}.`,
		data: settings,
		displayText: "Voice settings updated.",
		retryable: false,
		safety: { risk: "mutation", confirmation: "none" },
		cwd: ctx.cwd,
		workspaceRef: ctx.workspaceRef,
	};
}

function persistVoiceSettings(toolCall: SetVoiceSettingsToolCall, settings: ReturnType<typeof getTtsSettings>): void {
	const envUpdates: Record<string, string> = {};
	if (toolCall.fishSpeed !== undefined) envUpdates.ALFRED_FISH_SPEED = String(settings.fishSpeed);
	if (toolCall.edgeRate !== undefined) envUpdates.ALFRED_EDGE_RATE = settings.edgeRate;
	if (toolCall.speechStyle !== undefined) envUpdates.ALFRED_TTS_STYLE = settings.speechStyle;
	if (toolCall.witLevel !== undefined) envUpdates.ALFRED_TTS_WIT = settings.witLevel;
	if (toolCall.sarcasmLevel !== undefined) envUpdates.ALFRED_TTS_SARCASM = settings.sarcasmLevel;
	if (toolCall.provider !== undefined) envUpdates.ALFRED_TTS_PROVIDER = settings.provider;
	if (toolCall.fallbackProvider !== undefined) envUpdates.ALFRED_TTS_FALLBACK = settings.fallbackProvider;
	if (Object.keys(envUpdates).length === 0) return;
	persistDaemonEnvSettings(envUpdates);
}

function persistDaemonEnvSettings(settings: Record<string, string>): void {
	const envPath = process.env.ALFRED_DAEMON_ENV ?? join(homedir(), ".alfred", "daemon.env");
	try {
		mkdirSync(dirname(envPath), { recursive: true });
		const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
		const pending = new Map(Object.entries(settings));
		const lines = existing.map((line) => {
			let trimmed = line.trim();
			const exported = trimmed.startsWith("export ");
			if (exported) trimmed = trimmed.slice("export ".length).trim();
			if (!trimmed.includes("=")) return line;
			const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
			const value = pending.get(key);
			if (value === undefined) return line;
			pending.delete(key);
			return `${exported ? "export " : ""}${key}=${value}`;
		});
		for (const [key, value] of pending) lines.push(`export ${key}=${value}`);
		writeFileSync(envPath, `${lines.join("\n").trimEnd()}\n`, "utf8");
	} catch {
		// Runtime settings are already updated; persistence is best-effort.
	}
}
