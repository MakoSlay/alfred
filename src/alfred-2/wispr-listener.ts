import { execFile } from "node:child_process";
import { existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Alfred2Listener, Alfred2ListenerStatus } from "./listener-types.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_DB_PATH = "~/Library/Application Support/Wispr Flow/flow.sqlite";
const DEFAULT_LOG_PATH = "~/Library/Logs/Wispr Flow/main.log";
const DEFAULT_WAKE_WORDS = ["alfred", "hey alfred", "okay alfred", "ok alfred"];

const LOG_LISTENING_RE = /updateDictationStatus:\s*listening/i;
const LOG_IDLE_RE = /updateDictationStatus:\s*idle/i;
const LOG_DISMISSED_RE = /updateDictationStatus:\s*dismissed/i;

export interface WisprTranscript {
	id: string;
	timestamp: string;
	asrText: string | null;
	formattedText: string | null;
	editedText: string | null;
	pastedText: string | null;
	app: string | null;
	status: string | null;
	transcriptCommand: string | null;
}

export interface WisprListenerConfig {
	alfredUrl: string;
	dbPath?: string;
	logPath?: string;
	wakeWords?: string[];
	pollIntervalMs?: number;
	settleDelayMs?: number;
	flushTimeoutMs?: number;
}

export interface WisprListener extends Alfred2Listener {}

export function expandHome(input: string): string {
	return input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wakeWordPattern(wakeWord: string): RegExp {
	const words = wakeWord.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
	const separator = "[\\s,.:;!?\\-]+";
	const phrase = words.join(separator);
	return new RegExp(`^\\s*${phrase}(?:\\b|${separator}|$)[\\s,.:;!?\\-]*(.*)$`, "i");
}

/**
 * If text starts with a configured wake phrase, return the remaining command.
 * This intentionally tolerates Wispr punctuation like "Alfred, open Firefox".
 */
export function stripWakeWord(text: string, wakeWords: string[] = DEFAULT_WAKE_WORDS): string | null {
	for (const wakeWord of wakeWords) {
		const match = text.match(wakeWordPattern(wakeWord));
		if (match) {
			const command = (match[1] ?? "").trim();
			return command.length > 0 ? command : null;
		}
	}
	return null;
}

/**
 * Use raw ASR to decide whether this was intended for Alfred, then prefer
 * Wispr's formatted/edited text for the command we send to Alfred.
 */
export function extractWakeCommand(transcript: Pick<WisprTranscript, "asrText" | "formattedText" | "editedText">, wakeWords: string[] = DEFAULT_WAKE_WORDS): string | null {
	const rawText = transcript.asrText?.trim() ?? "";
	const rawCommand = stripWakeWord(rawText, wakeWords);
	if (!rawCommand) return null;

	const polishedText = (transcript.editedText || transcript.formattedText || "").trim();
	return stripWakeWord(polishedText, wakeWords) ?? rawCommand;
}

function isNewerTimestamp(timestamp: string, previous: string | null): boolean {
	return !previous || timestamp > previous;
}

async function readLatestTranscript(dbPath: string): Promise<WisprTranscript | null> {
	const query = `
		SELECT
			transcriptEntityId AS id,
			timestamp,
			asrText,
			formattedText,
			editedText,
			pastedText,
			app,
			status,
			transcriptCommand
		FROM History
		WHERE COALESCE(asrText, '') <> '' OR COALESCE(formattedText, '') <> '' OR COALESCE(editedText, '') <> ''
		ORDER BY timestamp DESC
		LIMIT 1;
	`;

	try {
		const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, query], {
			encoding: "utf8",
			maxBuffer: 512 * 1024,
		});
		const rows = JSON.parse(stdout || "[]") as WisprTranscript[];
		return rows[0] ?? null;
	} catch (error) {
		console.warn(`[wispr] Could not read Wispr Flow DB: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

async function postToAlfred(alfredUrl: string, text: string, transcript: WisprTranscript): Promise<void> {
	const response = await fetch(alfredUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			text,
			source: "wispr-flow",
			wispr: {
				id: transcript.id,
				timestamp: transcript.timestamp,
				app: transcript.app,
				status: transcript.status,
				transcriptCommand: transcript.transcriptCommand,
			},
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Alfred returned ${response.status}: ${body.slice(0, 500)}`);
	}

}

export function createWisprListener(config: WisprListenerConfig): WisprListener {
	const dbPath = expandHome(config.dbPath ?? DEFAULT_DB_PATH);
	const logPath = expandHome(config.logPath ?? DEFAULT_LOG_PATH);
	const wakeWords = config.wakeWords ?? DEFAULT_WAKE_WORDS;
	const pollIntervalMs = config.pollIntervalMs ?? 1_000;
	const settleDelayMs = config.settleDelayMs ?? 150;
	const flushTimeoutMs = config.flushTimeoutMs ?? 2_000;

	let running = false;
	let stopped = false;
	let dictationActive = false;
	let lastTimestamp: string | null = null;
	let lastWakeAt: string | null = null;
	let lastCommandAt: string | null = null;
	let lastError: string | null = null;
	const processedIds = new Set<string>();
	let watched = false;
	let fallbackTimer: NodeJS.Timeout | null = null;

	async function initializeCursor(): Promise<void> {
		const latest = await readLatestTranscript(dbPath);
		if (latest) {
			lastTimestamp = latest.timestamp;
			processedIds.add(latest.id);
		}
	}

	async function processLatestTranscript(options: { waitForFlush?: boolean } = {}): Promise<void> {
		const waitForFlush = options.waitForFlush ?? false;
		const deadline = Date.now() + (waitForFlush ? flushTimeoutMs : 1);
		while (!stopped && Date.now() < deadline) {
			const latest = await readLatestTranscript(dbPath);
			if (latest && !processedIds.has(latest.id) && isNewerTimestamp(latest.timestamp, lastTimestamp)) {
				processedIds.add(latest.id);
				lastTimestamp = latest.timestamp;

				const command = extractWakeCommand(latest, wakeWords);
				if (!command) return;

				lastWakeAt = new Date().toISOString();
				console.log(`[wispr] Alfred wake phrase detected → ${command}`);
				try {
					await postToAlfred(config.alfredUrl, command, latest);
					lastCommandAt = new Date().toISOString();
					lastError = null;
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error);
					console.warn(`[wispr] Failed to send command to Alfred: ${lastError}`);
				}
				return;
			}
			if (!waitForFlush) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	function handleLogChunk(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			if (LOG_LISTENING_RE.test(line)) {
				dictationActive = true;
			} else if (LOG_DISMISSED_RE.test(line)) {
				dictationActive = false;
			} else if (LOG_IDLE_RE.test(line)) {
				dictationActive = false;
				setTimeout(() => {
					void processLatestTranscript({ waitForFlush: true });
				}, settleDelayMs);
			}
		}
	}

	function startLogWatcher(): boolean {
		if (!existsSync(logPath)) return false;

		let position = statSync(logPath).size;
		let pending = "";

		const readNewBytes = () => {
			if (stopped) return;
			try {
				const stat = statSync(logPath);
				if (stat.size < position) {
					position = 0;
					pending = "";
				}
				if (stat.size === position) return;

				const start = position;
				const end = stat.size;
				position = end;
				void (async () => {
					const file = await open(logPath, "r");
					try {
						const length = end - start;
						const buffer = Buffer.alloc(length);
						await file.read(buffer, 0, length, start);
						const text = pending + buffer.toString("utf8");
						const lastNewline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
						if (lastNewline === -1) {
							pending = text;
							return;
						}
						pending = text.slice(lastNewline + 1);
						handleLogChunk(text.slice(0, lastNewline + 1));
					} finally {
						await file.close();
					}
				})().catch((error) => console.warn(`[wispr] Error reading log file: ${error instanceof Error ? error.message : String(error)}`));
			} catch (error) {
				console.warn(`[wispr] Error watching log file: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		watchFile(logPath, { interval: 100 }, readNewBytes);
		watched = true;
		return true;
	}

	function startPollingFallback(): void {
		fallbackTimer = setInterval(() => {
			void processLatestTranscript();
		}, pollIntervalMs);
	}

	return {
		async start() {
			if (running) return;
			if (!existsSync(dbPath)) {
				lastError = `Wispr Flow DB not found: ${dbPath}`;
				console.warn(`[wispr] ${lastError}`);
				return;
			}

			stopped = false;
			running = true;
			await initializeCursor();

			if (startLogWatcher()) {
				console.log(`[wispr] Listening for wake phrase via Wispr log: ${logPath}`);
			} else {
				console.warn(`[wispr] Log file not found, falling back to DB polling: ${logPath}`);
				startPollingFallback();
			}
			console.log(`[wispr] Wake phrases: ${wakeWords.join(", ")}`);
		},
		stop() {
			stopped = true;
			running = false;
			if (watched) {
				unwatchFile(logPath);
				watched = false;
			}
			if (fallbackTimer) {
				clearInterval(fallbackTimer);
				fallbackTimer = null;
			}
		},
		isRunning() {
			return running;
		},
		getStatus(): Alfred2ListenerStatus {
			return {
				provider: "wispr",
				running,
				state: running ? (dictationActive ? "recording_command" : "wake_listening") : "stopped",
				micActive: running && dictationActive,
				wakeWords,
				lastWakeAt,
				lastCommandAt,
				lastError,
				detail: watched ? `Wispr log: ${logPath}` : `Wispr DB polling: ${dbPath}`,
			};
		},
	};
}

export async function startWisprListener(config: WisprListenerConfig): Promise<WisprListener> {
	const listener = createWisprListener(config);
	await listener.start();
	return listener;
}
