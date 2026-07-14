import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const execFileAsync = promisify(execFile);

const DEFAULT_EDGE_TTS_PATH = "/opt/homebrew/bin/edge-tts";
const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

export type TtsProvider = "fish" | "edge" | "macos";
type TtsFallbackProvider = "edge" | "macos" | "none";
type SpeechStyle = "auto" | "neutral" | "warm" | "calm" | "dry" | "reassuring" | "sarcastic";
type WitLevel = "off" | "light" | "medium";
type SarcasmLevel = "off" | "light" | "medium";

interface ResolvedTtsSettings {
	provider: TtsProvider;
	fallbackProvider: TtsFallbackProvider;
	fishApiKey: string;
	fishVoiceId: string;
	fishModel: string;
	fishSpeed: number;
	edgeVoice: string;
	edgeRate: string;
	edgeTtsPath: string;
	macosVoice: string;
	speechStyle: SpeechStyle;
	witLevel: WitLevel;
	sarcasmLevel: SarcasmLevel;
}

export interface PublicTtsSettings {
	provider: TtsProvider;
	fallbackProvider: TtsFallbackProvider;
	hasFishApiKey: boolean;
	fishVoiceId: string;
	fishModel: string;
	fishSpeed: number;
	edgeVoice: string;
	edgeRate: string;
	macosVoice: string;
	speechStyle: SpeechStyle;
	witLevel: WitLevel;
	sarcasmLevel: SarcasmLevel;
	lastProvider: TtsProvider | null;
	lastError: string | null;
}

export type TtsSettingsPatch = Partial<Record<
	"provider" |
	"fallbackProvider" |
	"fishVoiceId" |
	"fishModel" |
	"fishSpeed" |
	"edgeVoice" |
	"edgeRate" |
	"macosVoice" |
	"speechStyle" |
	"witLevel" |
	"sarcasmLevel",
	unknown
>>;

export type SpeechSuppressionReason = "muted" | "microphone_active" | "other";
export type SpeechSuppressionProviderResult = boolean | { suppressed: boolean; reason?: SpeechSuppressionReason; pause?: boolean };

export const DEFAULT_SPEECH_PAUSE_POLL_MS = 1_000;
export const DEFAULT_SPEECH_PAUSE_MAX_MS = 30 * 60 * 1000;

let runtimeOverrides: TtsSettingsPatch = {};
let currentSpeechController: AbortController | null = null;
let lastProvider: TtsProvider | null = null;
let lastError: string | null = null;
let speechSuppressionProvider: (() => SpeechSuppressionProviderResult) | null = null;

/** Show a macOS notification banner. Non-blocking, never throws. */
export async function notify(title: string, body: string): Promise<void> {
	try {
		await execFileAsync("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], {
			timeout: 5_000,
		});
	} catch {
		// macOS notifications are best-effort
	}
}

export function getTtsSettings(): PublicTtsSettings {
	const settings = resolveTtsSettings();
	return {
		provider: settings.provider,
		fallbackProvider: settings.fallbackProvider,
		hasFishApiKey: settings.fishApiKey.length > 0,
		fishVoiceId: settings.fishVoiceId,
		fishModel: settings.fishModel,
		fishSpeed: settings.fishSpeed,
		edgeVoice: settings.edgeVoice,
		edgeRate: settings.edgeRate,
		macosVoice: settings.macosVoice,
		speechStyle: settings.speechStyle,
		witLevel: settings.witLevel,
		sarcasmLevel: settings.sarcasmLevel,
		lastProvider,
		lastError,
	};
}

export function setSpeechSuppressionProvider(provider: (() => SpeechSuppressionProviderResult) | null): void {
	speechSuppressionProvider = provider;
}

export function getSpeechSuppressionState(): { suppressed: boolean; reason?: SpeechSuppressionReason; pause: boolean } {
	try {
		return normalizeSpeechSuppression(speechSuppressionProvider?.() ?? false);
	} catch {
		return { suppressed: false, pause: false };
	}
}

export function isSpeechSuppressedByRuntime(): boolean {
	return getSpeechSuppressionState().suppressed;
}

export function speechSilentModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	if (readEnvFlagValue(env.ALFRED_SILENT) || readEnvFlagValue(env.ALFRED_TTS_SILENT) || readEnvFlagValue(env.ALFRED_DISABLE_TTS)) return true;
	if (readEnvFlagValue(env.ALFRED_TEST_SPEECH)) return false;
	return Boolean(env.NODE_TEST_CONTEXT) || readEnvFlagValue(env.ALFRED_SILENT_TESTS);
}

export async function waitForPausedSpeechAllowed(options: { maxMs?: number; pollMs?: number } = {}): Promise<boolean> {
	const maxMs = options.maxMs ?? readEnvNumber("ALFRED_SPEECH_PAUSE_MAX_MS", DEFAULT_SPEECH_PAUSE_MAX_MS);
	const pollMs = options.pollMs ?? readEnvNumber("ALFRED_SPEECH_PAUSE_POLL_MS", DEFAULT_SPEECH_PAUSE_POLL_MS);
	const started = Date.now();
	let state = getSpeechSuppressionState();
	while (state.suppressed && state.pause && Date.now() - started < maxMs) {
		await delay(Math.max(1, pollMs));
		state = getSpeechSuppressionState();
	}
	return !state.suppressed;
}

export function updateTtsSettings(patch: TtsSettingsPatch): PublicTtsSettings {
	const next: TtsSettingsPatch = { ...runtimeOverrides };

	if (isProvider(patch.provider)) next.provider = patch.provider;
	if (isFallbackProvider(patch.fallbackProvider)) next.fallbackProvider = patch.fallbackProvider;
	if (typeof patch.fishVoiceId === "string") next.fishVoiceId = patch.fishVoiceId.trim();
	if (typeof patch.fishModel === "string") next.fishModel = normalizeFishModel(patch.fishModel);
	if (typeof patch.edgeVoice === "string") next.edgeVoice = patch.edgeVoice.trim();
	if (typeof patch.edgeRate === "string") next.edgeRate = patch.edgeRate.trim();
	if (typeof patch.macosVoice === "string") next.macosVoice = patch.macosVoice.trim();
	if (isSpeechStyle(patch.speechStyle)) next.speechStyle = patch.speechStyle;
	if (isWitLevel(patch.witLevel)) next.witLevel = patch.witLevel;
	if (isSarcasmLevel(patch.sarcasmLevel)) next.sarcasmLevel = patch.sarcasmLevel;
	if (typeof patch.fishSpeed === "number" && Number.isFinite(patch.fishSpeed)) {
		next.fishSpeed = clamp(patch.fishSpeed, 0.5, 2.0);
	} else if (typeof patch.fishSpeed === "string" && patch.fishSpeed.trim()) {
		const parsed = Number(patch.fishSpeed);
		if (Number.isFinite(parsed)) next.fishSpeed = clamp(parsed, 0.5, 2.0);
	}

	runtimeOverrides = next;
	return getTtsSettings();
}

export interface SpeechLifecycleEvent {
	type: "start" | "done" | "error";
	provider: TtsProvider;
	message?: string;
}

export interface SynthesizeSpeechOptions {
	signal?: AbortSignal;
	onEvent?: (event: SpeechLifecycleEvent) => void;
}

export interface SynthesizedSpeech {
	audio: Buffer;
	contentType: "audio/mpeg" | "audio/wav";
	provider: TtsProvider;
}

export async function speak(text: string, options: SynthesizeSpeechOptions = {}): Promise<boolean> {
	if (!text.trim()) return false;
	if (speechSilentModeFromEnv()) return false;
	const initialSuppression = getSpeechSuppressionState();
	if (initialSuppression.suppressed) {
		if (!initialSuppression.pause) return false;
		const allowed = await waitForPausedSpeechAllowed();
		if (!allowed) return false;
	}
	if (isSpeechSuppressedByRuntime()) return false;

	// Abort any currently-playing speech so we don't overlap
	if (currentSpeechController) {
		currentSpeechController.abort();
		currentSpeechController = null;
	}

	const controller = new AbortController();
	currentSpeechController = controller;

	const speechText = text.length > 500 ? text.slice(0, 497) + "..." : text;
	const settings = resolveTtsSettings();
	const plan = providerPlan(settings);

	let fallbackReason: string | null = null;
	let failedProvider: TtsProvider | null = null;
	try {
		for (const provider of plan) {
			if (controller.signal.aborted) return false;
			try {
				options.onEvent?.({ type: "start", provider });
				await speakWithProvider(provider, speechText, settings, controller.signal);
				lastProvider = provider;
				lastError = provider === settings.provider ? null : fallbackReason;
				options.onEvent?.({ type: "done", provider });
				return true;
			} catch (error: any) {
				if (error?.name === "AbortError" || controller.signal.aborted) return false;
				fallbackReason = `${provider}: ${formatError(error)}`;
				failedProvider = provider;
				lastError = fallbackReason;
			}
		}
		if (failedProvider) options.onEvent?.({ type: "error", provider: failedProvider, message: fallbackReason ?? "Speech failed" });
		return false;
	} finally {
		if (currentSpeechController === controller) {
			currentSpeechController = null;
		}
	}
}

export function stopSpeech(): void {
	currentSpeechController?.abort();
	currentSpeechController = null;
}

export async function synthesizeSpeech(text: string, options: SynthesizeSpeechOptions = {}): Promise<SynthesizedSpeech> {
	if (!text.trim()) throw new Error("text is required");
	const speechText = text.length > 500 ? `${text.slice(0, 497)}...` : text;
	const settings = resolveTtsSettings();
	let lastFailure: Error | null = null;
	let failedProvider: TtsProvider | null = null;
	for (const provider of providerPlan(settings)) {
		if (options.signal?.aborted) throw abortError();
		try {
			options.onEvent?.({ type: "start", provider });
			const result = await synthesizeWithProvider(provider, speechText, settings, options.signal);
			lastProvider = provider;
			lastError = provider === settings.provider ? null : lastFailure?.message ?? null;
			options.onEvent?.({ type: "done", provider });
			return result;
		} catch (cause) {
			if (options.signal?.aborted) throw abortError();
			lastFailure = cause instanceof Error ? cause : new Error(String(cause));
			failedProvider = provider;
			lastError = `${provider}: ${lastFailure.message}`;
		}
	}
	if (failedProvider) options.onEvent?.({ type: "error", provider: failedProvider, message: lastFailure?.message ?? "Speech synthesis failed" });
	throw lastFailure ?? new Error("No TTS provider succeeded.");
}

function resolveTtsSettings(): ResolvedTtsSettings {
	const provider = readProvider(runtimeOverrides.provider, process.env.ALFRED_TTS_PROVIDER, "edge");
	const fallbackProvider = readFallbackProvider(runtimeOverrides.fallbackProvider, process.env.ALFRED_TTS_FALLBACK, "edge");
	return {
		provider,
		fallbackProvider,
		fishApiKey: readString(undefined, process.env.FISH_AUDIO_API_KEY, ""),
		fishVoiceId: readString(runtimeOverrides.fishVoiceId, process.env.ALFRED_FISH_VOICE_ID, ""),
		fishModel: normalizeFishModel(readString(runtimeOverrides.fishModel, process.env.ALFRED_FISH_MODEL, "s2.1-pro")),
		fishSpeed: clamp(readNumber(runtimeOverrides.fishSpeed, process.env.ALFRED_FISH_SPEED ?? process.env.ALFRED_TTS_SPEED, 1.0), 0.5, 2.0),
		edgeVoice: readString(runtimeOverrides.edgeVoice, process.env.ALFRED_EDGE_VOICE, "en-GB-ThomasNeural"),
		edgeRate: readString(runtimeOverrides.edgeRate, process.env.ALFRED_EDGE_RATE ?? process.env.ALFRED_TTS_RATE, "+10%"),
		edgeTtsPath: readString(undefined, process.env.EDGE_TTS_PATH, DEFAULT_EDGE_TTS_PATH),
		macosVoice: readString(runtimeOverrides.macosVoice, process.env.ALFRED_MACOS_VOICE, ""),
		speechStyle: readSpeechStyle(runtimeOverrides.speechStyle, process.env.ALFRED_TTS_STYLE, "auto"),
		witLevel: readWitLevel(runtimeOverrides.witLevel, process.env.ALFRED_TTS_WIT, "medium"),
		sarcasmLevel: readSarcasmLevel(runtimeOverrides.sarcasmLevel, process.env.ALFRED_TTS_SARCASM, "light"),
	};
}

function providerPlan(settings: ResolvedTtsSettings): TtsProvider[] {
	const providers: TtsProvider[] = [];
	const add = (provider: TtsProvider) => {
		if (!providers.includes(provider)) providers.push(provider);
	};

	add(settings.provider);
	if (settings.fallbackProvider === "edge") add("edge");
	if (settings.fallbackProvider === "macos") add("macos");
	add("macos");
	return providers;
}

async function speakWithProvider(provider: TtsProvider, text: string, settings: ResolvedTtsSettings, signal: AbortSignal): Promise<void> {
	const styledText = renderSpeechText(text, provider, settings);
	switch (provider) {
		case "fish":
			return speakWithFish(styledText, settings, signal);
		case "edge":
			return speakWithEdge(styledText, settings, signal);
		case "macos":
			return speakWithMacos(styledText, settings, signal);
	}
}

async function speakWithFish(text: string, settings: ResolvedTtsSettings, signal: AbortSignal): Promise<void> {
	const result = await synthesizeWithFish(text, settings, signal);
	await playAudioBuffer(result.audio, "mp3", signal);
}

async function speakWithEdge(text: string, settings: ResolvedTtsSettings, signal: AbortSignal): Promise<void> {
	const result = await synthesizeWithEdge(text, settings, signal);
	await playAudioBuffer(result.audio, "mp3", signal);
}

async function speakWithMacos(text: string, settings: ResolvedTtsSettings, signal: AbortSignal): Promise<void> {
	const args = settings.macosVoice ? ["-v", settings.macosVoice, text] : [text];
	await execFileAsync("say", args, { timeout: 60_000, signal });
}

async function synthesizeWithProvider(provider: TtsProvider, text: string, settings: ResolvedTtsSettings, signal?: AbortSignal): Promise<SynthesizedSpeech> {
	const styledText = renderSpeechText(text, provider, settings);
	switch (provider) {
		case "fish": return synthesizeWithFish(styledText, settings, signal);
		case "edge": return synthesizeWithEdge(styledText, settings, signal);
		case "macos": return synthesizeWithMacos(styledText, settings, signal);
	}
}

async function synthesizeWithFish(text: string, settings: ResolvedTtsSettings, signal?: AbortSignal): Promise<SynthesizedSpeech> {
	if (!settings.fishApiKey) throw new Error("FISH_AUDIO_API_KEY is not set");
	const payload: Record<string, unknown> = {
		text,
		format: "mp3",
		prosody: { speed: settings.fishSpeed },
	};
	if (settings.fishVoiceId) payload.reference_id = settings.fishVoiceId;
	const response = await fetch(FISH_TTS_URL, {
		method: "POST",
		signal,
		headers: {
			"Authorization": `Bearer ${settings.fishApiKey}`,
			"Content-Type": "application/json",
			"model": settings.fishModel,
		},
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 180)}` : ""}`);
	}
	return { audio: Buffer.from(await response.arrayBuffer()), contentType: "audio/mpeg", provider: "fish" };
}

async function synthesizeWithEdge(text: string, settings: ResolvedTtsSettings, signal?: AbortSignal): Promise<SynthesizedSpeech> {
	const { stdout } = await execFileAsync(settings.edgeTtsPath, [
		"--voice", settings.edgeVoice,
		"--rate", settings.edgeRate,
		"--text", text,
		"--write-media", "-",
	], { timeout: 15_000, signal, encoding: "buffer" });
	return { audio: stdout, contentType: "audio/mpeg", provider: "edge" };
}

async function synthesizeWithMacos(text: string, settings: ResolvedTtsSettings, signal?: AbortSignal): Promise<SynthesizedSpeech> {
	const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const aiffPath = join(tmpdir(), `alfred-speech-${token}.aiff`);
	const wavPath = join(tmpdir(), `alfred-speech-${token}.wav`);
	try {
		const sayArgs = ["-o", aiffPath, ...(settings.macosVoice ? ["-v", settings.macosVoice] : []), text];
		await execFileAsync("say", sayArgs, { timeout: 60_000, signal });
		await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16", aiffPath, wavPath], { timeout: 30_000, signal });
		const audio = readFileSync(wavPath);
		if (audio.subarray(0, 4).toString("ascii") !== "RIFF" || audio.subarray(8, 12).toString("ascii") !== "WAVE") {
			throw new Error("macOS conversion did not produce WAV audio");
		}
		return { audio, contentType: "audio/wav", provider: "macos" };
	} finally {
		try { unlinkSync(aiffPath); } catch { /* cleanup */ }
		try { unlinkSync(wavPath); } catch { /* cleanup */ }
	}
}

async function playAudioBuffer(audio: Buffer, extension: "mp3", signal: AbortSignal): Promise<void> {
	const tmpFile = join(tmpdir(), `alfred-speech-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
	writeFileSync(tmpFile, audio);
	try {
		await execFileAsync("afplay", [tmpFile], { timeout: 60_000, signal });
	} finally {
		try { unlinkSync(tmpFile); } catch { /* cleanup */ }
	}
}

function renderSpeechText(text: string, provider: TtsProvider, settings: ResolvedTtsSettings): string {
	const existingTag = leadingDeliveryTag(text);
	const base = stripDeliveryTags(text).trim();
	const intent = classifySpeech(base);
	const spoken = applyWit(base, intent, settings);
	if (provider !== "fish") return spoken;
	if (existingTag) return `[${existingTag}] ${spoken}`;
	const tag = chooseFishTag(spoken, intent, settings);
	return tag ? `[${tag}] ${spoken}` : spoken;
}

type SpeechIntent = "error" | "confirmation" | "success" | "routine";

function classifySpeech(text: string): SpeechIntent {
	const lower = text.toLowerCase();
	if (/\b(error|failed|failure|couldn'?t|could not|cannot|can'?t|unavailable|missing|denied|expired|insufficient|not found|try again|problem)\b/.test(lower)) return "error";
	if (/\b(shall i|should i|confirm|approve|before executing|pending|ready\?|\?)\b/.test(lower)) return "confirmation";
	if (/\b(done|complete|completed|success|saved|ready|online|restored|reverted|created|updated|handled|sent|ran)\b/.test(lower)) return "success";
	return "routine";
}

function applyWit(text: string, intent: SpeechIntent, settings: ResolvedTtsSettings): string {
	if (settings.witLevel === "off" || intent === "error" || intent === "confirmation") return text;
	if (text.length > 120 || /\bsir\b/i.test(text)) return text;
	if (settings.witLevel === "light") return addSir(text);
	const suffix = intent === "success" && settings.sarcasmLevel !== "off"
		? " Neatly handled, sir."
		: " At your service, sir.";
	return `${trimTerminalPunctuation(text)}.${suffix}`;
}

function addSir(text: string): string {
	if (!text) return text;
	return `${trimTerminalPunctuation(text)}, sir.`;
}

function trimTerminalPunctuation(text: string): string {
	return text.trim().replace(/[.!?…]+$/u, "");
}

function chooseFishTag(text: string, intent: SpeechIntent, settings: ResolvedTtsSettings): string | null {
	if (settings.speechStyle === "neutral") return null;
	if (settings.speechStyle !== "auto") return fishTagForStyle(settings.speechStyle);
	if (intent === "error") return "reassuring";
	if (intent === "confirmation") return "calmly";
	if (settings.sarcasmLevel === "medium" && intent === "success") return "dryly";
	if (settings.sarcasmLevel === "light" && intent === "success" && text.length < 80) return "dryly";
	return "warmly";
}

function fishTagForStyle(style: SpeechStyle): string | null {
	switch (style) {
		case "neutral": return null;
		case "warm": return "warmly";
		case "calm": return "calmly";
		case "dry": return "dryly";
		case "reassuring": return "reassuring";
		case "sarcastic": return "sarcastically";
		case "auto": return "warmly";
	}
}

function leadingDeliveryTag(text: string): string | null {
	const match = text.trim().match(/^\[([a-z][a-z -]{1,32})\]\s*/i);
	return match?.[1]?.trim().toLowerCase() ?? null;
}

function stripDeliveryTags(text: string): string {
	return text.trim().replace(/^(?:\[[a-z][a-z -]{1,32}\]\s*)+/i, "");
}

function readProvider(value: unknown, env: string | undefined, fallback: TtsProvider): TtsProvider {
	if (isProvider(value)) return value;
	if (isProvider(env)) return env;
	return fallback;
}

function readFallbackProvider(value: unknown, env: string | undefined, fallback: TtsFallbackProvider): TtsFallbackProvider {
	if (isFallbackProvider(value)) return value;
	if (isFallbackProvider(env)) return env;
	return fallback;
}

function isProvider(value: unknown): value is TtsProvider {
	return value === "fish" || value === "edge" || value === "macos";
}

function isFallbackProvider(value: unknown): value is TtsFallbackProvider {
	return value === "edge" || value === "macos" || value === "none";
}

function readSpeechStyle(value: unknown, env: string | undefined, fallback: SpeechStyle): SpeechStyle {
	if (isSpeechStyle(value)) return value;
	if (isSpeechStyle(env)) return env;
	return fallback;
}

function readWitLevel(value: unknown, env: string | undefined, fallback: WitLevel): WitLevel {
	if (isWitLevel(value)) return value;
	if (isWitLevel(env)) return env;
	return fallback;
}

function readSarcasmLevel(value: unknown, env: string | undefined, fallback: SarcasmLevel): SarcasmLevel {
	if (isSarcasmLevel(value)) return value;
	if (isSarcasmLevel(env)) return env;
	return fallback;
}

function isSpeechStyle(value: unknown): value is SpeechStyle {
	return value === "auto" || value === "neutral" || value === "warm" || value === "calm" || value === "dry" || value === "reassuring" || value === "sarcastic";
}

function isWitLevel(value: unknown): value is WitLevel {
	return value === "off" || value === "light" || value === "medium";
}

function isSarcasmLevel(value: unknown): value is SarcasmLevel {
	return value === "off" || value === "light" || value === "medium";
}

function readString(value: unknown, env: string | undefined, fallback: string): string {
	if (typeof value === "string") return value.trim();
	if (typeof env === "string") return env.trim();
	return fallback;
}

function readNumber(value: unknown, env: string | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof env === "string" && env.trim()) {
		const parsed = Number(env);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function normalizeFishModel(value: unknown): string {
	const model = typeof value === "string" ? value.trim() : "";
	if (!model) return "s2.1-pro";
	if (model === "s2.1") return "s2.1-pro";
	return model;
}

function normalizeSpeechSuppression(value: SpeechSuppressionProviderResult): { suppressed: boolean; reason?: SpeechSuppressionReason; pause: boolean } {
	if (typeof value === "boolean") return { suppressed: value, reason: value ? "other" : undefined, pause: false };
	return { suppressed: value.suppressed, reason: value.reason, pause: Boolean(value.pause) || value.reason === "microphone_active" };
}

function readEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readEnvFlagValue(value: string | undefined): boolean {
	return /^(1|true|yes|on)$/i.test(value ?? "");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function abortError(): Error {
	const error = new Error("Speech synthesis aborted");
	error.name = "AbortError";
	return error;
}
