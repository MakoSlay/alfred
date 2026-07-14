import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAlfred2, type Alfred2ServerHandle } from "./server.ts";
import { acquireAlfred2PidFile, releaseAlfred2PidFile } from "./process.ts";
import { startWisprListener } from "./wispr-listener.ts";
import { startNativeWakeListener } from "./native-wake-listener.ts";
import { getTtsSettings } from "./speech.ts";
import type { Alfred2Listener, Alfred2ListenerProvider } from "./listener-types.ts";
import { createOffListenerStatus } from "./listener-types.ts";

loadDaemonEnv();

const PORT = parseInt(process.env.ALFRED2_PORT ?? "47321", 10);
const HOST = process.env.ALFRED2_HOST ?? "127.0.0.1";
const ENDPOINT = process.env.ALFRED_LLM_ENDPOINT ?? "https://api.deepseek.com/v1";
const MODEL = process.env.ALFRED_LLM_MODEL ?? "deepseek-chat";
const API_KEY = process.env.ALFRED_LLM_API_KEY ?? "";
const LISTENER_PROVIDER = resolveListenerProvider();

if (!API_KEY) {
	console.error("ALFRED_LLM_API_KEY is required. Set it in your environment.");
	process.exit(1);
}

const tts = getTtsSettings();

console.log(`Starting Alfred 2.0 on http://${HOST}:${PORT}`);
console.log(`LLM: ${MODEL} @ ${ENDPOINT}`);
console.log(`Speech: ${tts.provider}${tts.fallbackProvider !== "none" ? ` → ${tts.fallbackProvider}` : ""} → macOS say (emergency)`);
console.log(`Voice listener: ${LISTENER_PROVIDER}`);
console.log("");

const pidFile = acquireAlfred2PidFile();
console.log(`PID file: ${pidFile.pidFile}`);

let server: Alfred2ServerHandle | null = null;
let voiceListener: Alfred2Listener | null = null;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	voiceListener?.stop();
	await server?.close().catch(() => {});
	releaseAlfred2PidFile();
	process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));
process.once("beforeExit", () => releaseAlfred2PidFile());
process.once("uncaughtException", (error) => {
	console.error(error);
	releaseAlfred2PidFile();
	process.exit(1);
});
process.once("unhandledRejection", (error) => {
	console.error(error);
	releaseAlfred2PidFile();
	process.exit(1);
});

try {
	server = await startAlfred2({
		port: PORT,
		host: HOST,
		llm: {
			endpoint: ENDPOINT,
			model: MODEL,
			apiKey: API_KEY,
		},
		listenerStatus: () => voiceListener?.getStatus() ?? createOffListenerStatus(LISTENER_PROVIDER),
	});

	voiceListener = await startConfiguredListener(LISTENER_PROVIDER, `http://${server.host}:${server.port}/ask`);
} catch (error) {
	console.error(error);
	releaseAlfred2PidFile();
	process.exit(1);
}

console.log(`Alfred 2.0 ready on http://${server.host}:${server.port}`);
console.log(LISTENER_PROVIDER === "native" ? `Say the native wake word, then your command.` : LISTENER_PROVIDER === "wispr" ? `Say: "Alfred open Firefox" anywhere Wispr Flow can dictate.` : `Voice listener is off; use /ask or the dashboard.`);
console.log(`Try: curl -X POST http://${server.host}:${server.port}/ask -H 'Content-Type: application/json' -d '{"text":"what workspaces do I have"}'`);

function resolveListenerProvider(): Alfred2ListenerProvider {
	const explicit = process.env.ALFRED2_LISTENER?.trim().toLowerCase();
	if (explicit === "off" || explicit === "none" || explicit === "0") return "off";
	if (explicit === "wispr") return "wispr";
	if (explicit === "native") return "native";
	if (explicit) {
		console.warn(`Unknown ALFRED2_LISTENER=${process.env.ALFRED2_LISTENER}; falling back to wispr.`);
	}
	return process.env.ALFRED2_WISPR_LISTENER === "0" ? "off" : "wispr";
}

async function startConfiguredListener(provider: Alfred2ListenerProvider, alfredUrl: string): Promise<Alfred2Listener | null> {
	const wakeWords = process.env.ALFRED2_WAKE_WORDS?.split(",").map((word) => word.trim()).filter(Boolean);
	if (provider === "off") return null;
	if (provider === "native") {
		return startNativeWakeListener({
			alfredUrl,
			wakeWords,
			wakeCommand: process.env.ALFRED2_NATIVE_WAKE_COMMAND,
			transcribeCommand: process.env.ALFRED2_NATIVE_TRANSCRIBE_COMMAND,
			debounceMs: process.env.ALFRED2_NATIVE_WAKE_DEBOUNCE_MS ? parseInt(process.env.ALFRED2_NATIVE_WAKE_DEBOUNCE_MS, 10) : undefined,
		});
	}
	return startWisprListener({
		alfredUrl,
		dbPath: process.env.WISPR_DB_PATH,
		logPath: process.env.WISPR_LOG_PATH,
		wakeWords,
	});
}

function loadDaemonEnv(): void {
	const envPath = process.env.ALFRED_DAEMON_ENV ?? join(homedir(), ".alfred", "daemon.env");
	if (!existsSync(envPath)) return;
	const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		let trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
		if (!trimmed.includes("=")) continue;
		const index = trimmed.indexOf("=");
		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
		if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}
