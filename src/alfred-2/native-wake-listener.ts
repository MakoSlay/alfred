import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Alfred2Listener, Alfred2ListenerStatus } from "./listener-types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_WAKE_WORDS = ["alfred", "hey alfred", "okay alfred", "ok alfred"];

export type NativeWakeEvent =
	| { type: "wake"; text?: string }
	| { type: "command"; text: string };

export interface NativeWakeEngine {
	start(onEvent: (event: NativeWakeEvent) => void, onError: (error: Error) => void): Promise<void>;
	stop(): void;
	isRunning?(): boolean;
	getDetail?(): string;
}

export interface NativeCommandTranscriber {
	recordAndTranscribe(): Promise<string | null>;
	getDetail?(): string;
}

export interface NativeWakeListenerDependencies {
	wakeEngine?: NativeWakeEngine;
	transcriber?: NativeCommandTranscriber;
	postCommand?: (alfredUrl: string, text: string, metadata: Record<string, unknown>) => Promise<void>;
	now?: () => Date;
}

export interface NativeWakeListenerConfig {
	alfredUrl: string;
	wakeWords?: string[];
	debounceMs?: number;
	wakeCommand?: string;
	transcribeCommand?: string;
	dependencies?: NativeWakeListenerDependencies;
}

export function createNativeWakeListener(config: NativeWakeListenerConfig): Alfred2Listener {
	const wakeWords = config.wakeWords?.filter(Boolean) ?? DEFAULT_WAKE_WORDS;
	const debounceMs = config.debounceMs ?? 1_500;
	const now = config.dependencies?.now ?? (() => new Date());
	const postCommand = config.dependencies?.postCommand ?? postNativeCommandToAlfred;

	let running = false;
	let state: Alfred2ListenerStatus["state"] = "stopped";
	let lastWakeAt: string | null = null;
	let lastCommandAt: string | null = null;
	let lastError: string | null = null;
	let lastWakeMs = 0;
	let processing = false;

	const engine = config.dependencies?.wakeEngine ?? (config.wakeCommand ? createCommandWakeEngine(config.wakeCommand) : null);
	const transcriber = config.dependencies?.transcriber ?? (config.transcribeCommand ? createCommandTranscriber(config.transcribeCommand) : null);

	function setError(error: unknown): void {
		lastError = error instanceof Error ? error.message : String(error);
		state = "error";
		console.warn(`[native-wake] ${lastError}`);
	}

	async function submitCommand(text: string, wakeAt: string | null, source: "wake-transcript" | "post-wake-transcriber"): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		state = "posting";
		await postCommand(config.alfredUrl, trimmed, {
			wakeAt,
			source,
			wakeWords,
		});
		lastCommandAt = now().toISOString();
		state = running ? "wake_listening" : "stopped";
	}

	async function handleWakeEvent(event: NativeWakeEvent): Promise<void> {
		if (!running) return;
		const elapsed = Date.now() - lastWakeMs;
		if (lastWakeMs > 0 && elapsed < debounceMs) return;
		lastWakeMs = Date.now();
		lastWakeAt = now().toISOString();
		lastError = null;

		if (event.type === "command") {
			await submitCommand(event.text, lastWakeAt, "wake-transcript");
			return;
		}

		const inlineText = event.text?.trim();
		if (inlineText) {
			await submitCommand(inlineText, lastWakeAt, "wake-transcript");
			return;
		}

		if (!transcriber) {
			lastError = "Wake detected, but no native command transcriber is configured. Set ALFRED2_NATIVE_TRANSCRIBE_COMMAND or provide a transcriber.";
			state = running ? "wake_listening" : "stopped";
			console.warn(`[native-wake] ${lastError}`);
			return;
		}

		state = "transcribing";
		const transcript = await transcriber.recordAndTranscribe();
		if (!transcript?.trim()) {
			state = running ? "wake_listening" : "stopped";
			return;
		}
		await submitCommand(transcript, lastWakeAt, "post-wake-transcriber");
	}

	function onEvent(event: NativeWakeEvent): void {
		if (processing) return;
		processing = true;
		void handleWakeEvent(event)
			.catch(setError)
			.finally(() => {
				processing = false;
				if (running && state !== "error") state = "wake_listening";
			});
	}

	return {
		async start() {
			if (running) return;
			state = "starting";
			lastError = null;
			if (!engine) {
				running = false;
				state = "error";
				lastError = "Native wake listener requires ALFRED2_NATIVE_WAKE_COMMAND or an injected wake engine. The command should print WAKE, COMMAND: text, or JSON lines.";
				console.warn(`[native-wake] ${lastError}`);
				return;
			}
			running = true;
			try {
				await engine.start(onEvent, setError);
				state = "wake_listening";
				console.log(`[native-wake] Listening locally for wake phrase: ${wakeWords.join(", ")}`);
			} catch (error) {
				running = false;
				setError(error);
			}
		},
		stop() {
			running = false;
			state = "stopped";
			engine?.stop();
		},
		isRunning() {
			return running;
		},
		getStatus() {
			return {
				provider: "native",
				running,
				state,
				micActive: running,
				wakeWords,
				lastWakeAt,
				lastCommandAt,
				lastError,
				detail: [engine?.getDetail?.(), transcriber?.getDetail?.()].filter(Boolean).join(" · ") || undefined,
			};
		},
	};
}

export async function startNativeWakeListener(config: NativeWakeListenerConfig): Promise<Alfred2Listener> {
	const listener = createNativeWakeListener(config);
	await listener.start();
	return listener;
}

async function postNativeCommandToAlfred(alfredUrl: string, text: string, metadata: Record<string, unknown>): Promise<void> {
	const response = await fetch(alfredUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			text,
			source: "native-wake",
			nativeWake: metadata,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Alfred returned ${response.status}: ${body.slice(0, 500)}`);
	}
}

function createCommandWakeEngine(commandLine: string): NativeWakeEngine {
	let child: ReturnType<typeof spawn> | null = null;
	let running = false;
	let pending = "";

	return {
		async start(onEvent, onError) {
			if (running) return;
			const { command, args } = splitCommandLine(commandLine);
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
			running = true;
			const stdout = child.stdout;
			const stderr = child.stderr;
			if (!stdout || !stderr) throw new Error("Wake command did not expose stdout/stderr pipes");
			stdout.setEncoding("utf8");
			stdout.on("data", (chunk: string) => {
				pending += chunk;
				let index = pending.search(/\r?\n/);
				while (index >= 0) {
					const line = pending.slice(0, index).trim();
					pending = pending.slice(pending[index] === "\r" && pending[index + 1] === "\n" ? index + 2 : index + 1);
					const event = parseWakeLine(line);
					if (event) onEvent(event);
					index = pending.search(/\r?\n/);
				}
			});
			stderr.setEncoding("utf8");
			stderr.on("data", (chunk: string) => {
				const message = chunk.trim();
				if (message) console.warn(`[native-wake] helper: ${message}`);
			});
			child.on("error", (error) => {
				running = false;
				onError(error);
			});
			child.on("exit", (code, signal) => {
				running = false;
				if (code !== 0 && code !== null) onError(new Error(`Wake command exited with code ${code}`));
				else if (signal) onError(new Error(`Wake command exited from signal ${signal}`));
			});
		},
		stop() {
			running = false;
			child?.kill();
			child = null;
		},
		isRunning() {
			return running;
		},
		getDetail() {
			return `wake command: ${commandLine}`;
		},
	};
}

function createCommandTranscriber(commandLine: string): NativeCommandTranscriber {
	return {
		async recordAndTranscribe() {
			const { command, args } = splitCommandLine(commandLine);
			const { stdout } = await execFileAsync(command, args, {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				env: process.env,
			});
			return stdout.trim() || null;
		},
		getDetail() {
			return `transcribe command: ${commandLine}`;
		},
	};
}

function parseWakeLine(line: string): NativeWakeEvent | null {
	if (!line) return null;
	if (line.startsWith("{")) {
		try {
			const parsed = JSON.parse(line) as { type?: unknown; text?: unknown; command?: unknown };
			if (parsed.type === "wake") return { type: "wake", text: typeof parsed.text === "string" ? parsed.text : undefined };
			if (parsed.type === "command") {
				const text = typeof parsed.text === "string" ? parsed.text : typeof parsed.command === "string" ? parsed.command : "";
				return text.trim() ? { type: "command", text } : null;
			}
		} catch {
			return null;
		}
	}
	if (/^wake$/i.test(line)) return { type: "wake" };
	const commandMatch = line.match(/^command\s*:\s*(.+)$/i);
	if (commandMatch?.[1]?.trim()) return { type: "command", text: commandMatch[1] };
	return null;
}

function splitCommandLine(commandLine: string): { command: string; args: string[] } {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;
	for (const char of commandLine.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	if (!parts[0]) throw new Error("Command line is empty");
	return { command: parts[0], args: parts.slice(1) };
}
