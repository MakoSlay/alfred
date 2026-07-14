import { estimateTokens } from "./context.ts";
import type { LlmClient } from "./agent.ts";
import type { TokenUsage } from "./tool-types.ts";

export interface SpeechFormatterOptions {
	llmClient: LlmClient;
	userText: string;
	speech: string;
	displayText: string;
	model?: string;
	enabled?: boolean;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface SpeechFormatterResult {
	speech: string;
	used: boolean;
	model: string | null;
	maxTokens: number;
	inputTokensEstimate: number;
	usage?: Partial<TokenUsage>;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MIN_OUTPUT_TOKENS = 256;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;

const SPEECH_FORMATTER_SYSTEM_PROMPT = `You are Alfred's spoken-voice presenter.

Rewrite the draft into the exact text that should be spoken aloud by text-to-speech.

Requirements:
- Keep the meaning and facts. Do not add new facts, recommendations, numbers, names, or caveats.
- Make it sound like Alfred: a confident private butler with medium wit and a big personality.
- Keep it concise, but not bland. It should feel human, polished, and spoken.
- No Markdown, bullets, numbered-list markers, code fences, backticks, asterisks, emoji, raw URLs, or decorative separators.
- Avoid symbols that TTS may read literally: hyphens, em dashes, slashes, pipes, arrows, brackets, hashes, underscores, and file-path punctuation.
- Speak IDs naturally when useful. Example: PR #3079 becomes pull request three zero seven nine.
- Put no explanations around the answer.

Return exactly one JSON object: {"speech":"..."}`;

export type SpeechFormatterMode = "off" | "auto" | "always";

export function speechFormatterEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return speechFormatterModeFromEnv(env) !== "off";
}

export function speechFormatterModeFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechFormatterMode {
	const raw = env.ALFRED_SPEECH_FORMATTER_ENABLED?.trim();
	if (raw === undefined || raw === "") return "auto";
	if (/^(1|true|yes|on)$/i.test(raw)) return "always";
	if (/^(auto|dynamic|smart)$/i.test(raw)) return "auto";
	return "off";
}

export function speechFormatterModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	return (env.ALFRED_SPEECH_FORMATTER_MODEL || env.ALFRED_LLM_MODEL || "deepseek-v4-flash").trim() || "deepseek-v4-flash";
}

export function dynamicSpeechFormatterMaxTokens(speech: string, displayText: string, env: NodeJS.ProcessEnv = process.env): number {
	const explicit = parseInt(env.ALFRED_SPEECH_FORMATTER_MAX_TOKENS ?? "", 10);
	if (Number.isFinite(explicit) && explicit > 0) return clamp(explicit, 64, 8_000);

	const cap = parseInt(env.ALFRED_SPEECH_FORMATTER_MAX_TOKEN_CAP ?? "", 10);
	const maxCap = Number.isFinite(cap) && cap > 0 ? clamp(cap, 256, 8_000) : DEFAULT_MAX_OUTPUT_TOKENS;
	const sourceTokens = estimateTokens(`${speech}\n${displayText}`);
	return clamp(Math.ceil(sourceTokens * 1.5) + 80, DEFAULT_MIN_OUTPUT_TOKENS, maxCap);
}

export async function formatSpeechForTts(options: SpeechFormatterOptions): Promise<SpeechFormatterResult> {
	const original = options.speech.trim();
	const model = options.model ?? speechFormatterModelFromEnv();
	const maxTokens = options.maxTokens ?? dynamicSpeechFormatterMaxTokens(original, options.displayText);
	const inputText = formatterInput(options.userText, original, options.displayText);
	const inputTokensEstimate = estimateTokens(`${SPEECH_FORMATTER_SYSTEM_PROMPT}\n${inputText}`);

	if (!original) {
		return { speech: "", used: false, model: null, maxTokens, inputTokensEstimate };
	}
	const mode = options.enabled === true ? "always" : options.enabled === false ? "off" : speechFormatterModeFromEnv();
	if (mode === "off" || (mode === "auto" && !speechNeedsFormatter(original, options.displayText))) {
		return { speech: original, used: false, model: null, maxTokens, inputTokensEstimate };
	}

	try {
		const response = await options.llmClient.complete({
			model,
			temperature: 0.2,
			maxTokens,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			messages: [
				{ role: "system", content: SPEECH_FORMATTER_SYSTEM_PROMPT },
				{ role: "user", content: inputText },
			],
		});
		const formatted = parseFormatterSpeech(response.text);
		if (!formatted) {
			return { speech: original, used: false, model, maxTokens, inputTokensEstimate, usage: response.usage, error: "formatter returned no speech" };
		}
		return { speech: formatted, used: true, model, maxTokens, inputTokensEstimate, usage: response.usage };
	} catch (error) {
		return { speech: original, used: false, model, maxTokens, inputTokensEstimate, error: formatError(error) };
	}
}

export function speechNeedsFormatter(speech: string, displayText: string): boolean {
	const text = speech.trim();
	if (!text) return false;
	if (text.length > 180) return true;
	if (/```|`|\*\*|__|^\s*[-*•]\s+/m.test(text)) return true;
	if (/https?:\/\//i.test(text)) return true;
	if (/[|→←↔]/.test(text)) return true;
	if (/[—#]/.test(text) && /\b(PR|issue|ticket|branch|commit|file|path|http|www)\b|#\d+/i.test(text)) return true;
	if (/\b[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\b/.test(text)) return true;
	if (/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|rb|go|rs|java|css|html|yml|yaml)\b/.test(text)) return true;
	if (displayText.trim().length > Math.max(240, text.length * 2) && /[:\n#*`|—/-]/.test(displayText)) return true;
	return false;
}

function formatterInput(userText: string, speech: string, displayText: string): string {
	return [
		`USER REQUEST:\n${userText || "(not provided)"}`,
		`DRAFT SPEECH:\n${speech}`,
		`SCREEN DISPLAY TEXT:\n${displayText || speech}`,
	].join("\n\n");
}

function parseFormatterSpeech(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	const json = extractFirstJsonObject(text);
	if (json) {
		try {
			const parsed = JSON.parse(json) as { speech?: unknown };
			if (typeof parsed.speech === "string" && parsed.speech.trim()) return parsed.speech.trim();
		} catch {
			// Fall through to raw text cleanup.
		}
	}
	return text.replace(/^['"]|['"]$/g, "").trim() || null;
}

function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}
