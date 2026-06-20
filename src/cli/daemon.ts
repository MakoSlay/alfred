import { randomBytes } from "node:crypto";
import { createAlfredDaemon, type AlfredDaemon, type AlfredDaemonConfig } from "../daemon/index.ts";
import { formatHostForUrl } from "../lib/host-formatting.ts";

export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 47_321;

export type DaemonTokenSource = "env" | "generated";

export interface DaemonCliConfig {
	readonly host: string;
	readonly port: number;
	readonly authToken: string;
	readonly tokenSource: DaemonTokenSource;
	readonly dashboardUrl: string;
	readonly daemonConfig: Pick<AlfredDaemonConfig, "host" | "port" | "authToken">;
}

type DaemonSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface DaemonSignalEmitter {
	once(signal: DaemonSignal, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface RunDaemonCliOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: Pick<NodeJS.WriteStream, "write">;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly createDaemon?: (config: Pick<AlfredDaemonConfig, "host" | "port" | "authToken">) => AlfredDaemon;
	readonly randomToken?: () => string;
	readonly signals?: DaemonSignalEmitter;
	readonly shutdownTimeoutMs?: number;
}

export function parseDaemonCliConfig(
	env: NodeJS.ProcessEnv = process.env,
	randomToken: () => string = createLocalAuthToken,
): DaemonCliConfig {
	const host = parseAlfredHost(env.ALFRED_HOST);
	const port = parseAlfredPort(env.ALFRED_PORT);
	const configuredToken = normalizedEnvValue(env.ALFRED_LOCAL_TOKEN);
	const tokenSource: DaemonTokenSource = configuredToken ? "env" : "generated";
	const authToken = configuredToken ?? randomToken();
	const dashboardUrl = `http://${formatHostForUrl(host)}:${port}/dashboard`;

	return {
		host,
		port,
		authToken,
		tokenSource,
		dashboardUrl,
		daemonConfig: { host, port, authToken },
	};
}

export function formatDaemonStartupMessage(config: DaemonCliConfig): string {
	const lines = [
		"Alfred daemon starting",
		`Listening: http://${formatHostForUrl(config.host)}:${config.port}`,
		`Dashboard: ${config.dashboardUrl}`,
	];

	if (config.tokenSource === "generated") {
		lines.push("Auth token: generated for this process; value is printed after startup succeeds and will not be persisted.");
	} else {
		lines.push("Auth token: using ALFRED_LOCAL_TOKEN from the environment; value is not printed.");
		lines.push("Use API header: x-alfred-auth: <your ALFRED_LOCAL_TOKEN>");
	}

	lines.push("Shutdown: press Ctrl+C or send SIGTERM/SIGHUP.");
	return `${lines.join("\n")}\n`;
}

export function formatDaemonStartedMessage(config: DaemonCliConfig, started: { host: string; port: number }): string {
	const lines = [
		`Alfred daemon ready on http://${formatHostForUrl(started.host)}:${started.port}`,
		`Dashboard: ${config.dashboardUrl}`,
	];
	if (config.tokenSource === "generated") {
		lines.push(`Generated token: ${config.authToken}`);
		lines.push("Use API header: x-alfred-auth: <generated token above>");
	}
	return `${lines.join("\n")}\n`;
}

export function formatDaemonStartupError(error: unknown, config?: DaemonCliConfig): string {
	if (isNodeError(error) && error.code === "EADDRINUSE") {
		const endpoint = config ? `${formatHostForUrl(config.host)}:${config.port}` : "configured address";
		return `Failed to start Alfred daemon: ${endpoint} is already in use. Set ALFRED_PORT to a free local port or stop the existing daemon.\n`;
	}
	if (error instanceof Error) {
		return `Failed to start Alfred daemon: ${error.message}\n`;
	}
	return "Failed to start Alfred daemon: unknown startup error.\n";
}

export async function runDaemonCli(options: RunDaemonCliOptions = {}): Promise<number> {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	let config: DaemonCliConfig;
	try {
		config = parseDaemonCliConfig(options.env, options.randomToken);
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : "Invalid Alfred daemon configuration"}\n`);
		return 1;
	}

	const daemon = (options.createDaemon ?? createAlfredDaemon)(config.daemonConfig);
	stdout.write(formatDaemonStartupMessage(config));

	try {
		const started = await daemon.start();
		stdout.write(formatDaemonStartedMessage(config, started));
	} catch (error) {
		stderr.write(formatDaemonStartupError(error, config));
		return 1;
	}

	await waitForShutdown(daemon, stdout, options.signals ?? process, options.shutdownTimeoutMs ?? 5_000);
	return 0;
}

function parseAlfredHost(rawHost: string | undefined): string {
	const value = normalizedEnvValue(rawHost) ?? DEFAULT_DAEMON_HOST;
	const host = value === "[::1]" ? "::1" : value;
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
		throw new Error(`Invalid ALFRED_HOST ${JSON.stringify(rawHost)}: expected a loopback host (127.0.0.1, localhost, or ::1).`);
	}
	return host;
}

function parseAlfredPort(rawPort: string | undefined): number {
	const value = normalizedEnvValue(rawPort);
	if (!value) return DEFAULT_DAEMON_PORT;
	if (!/^\d+$/.test(value)) {
		throw new Error(`Invalid ALFRED_PORT ${JSON.stringify(rawPort)}: expected an integer between 1 and 65535.`);
	}
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid ALFRED_PORT ${JSON.stringify(rawPort)}: expected an integer between 1 and 65535.`);
	}
	return port;
}

function normalizedEnvValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function createLocalAuthToken(): string {
	return randomBytes(24).toString("base64url");
}

async function waitForShutdown(
	daemon: AlfredDaemon,
	stdout: Pick<NodeJS.WriteStream, "write">,
	processLike: DaemonSignalEmitter,
	shutdownTimeoutMs: number,
): Promise<void> {
	await new Promise<void>((resolve) => {
		let stopping = false;
		const shutdown = (signal: NodeJS.Signals) => {
			if (stopping) return;
			stopping = true;
			stdout.write(`Received ${signal}; stopping Alfred daemon...\n`);
			void withTimeout(daemon.stop(), shutdownTimeoutMs, `Alfred daemon shutdown timed out after ${shutdownTimeoutMs}ms`)
				.then(() => {
					stdout.write("Alfred daemon stopped.\n");
				})
				.catch((error: unknown) => {
					stdout.write(`Alfred daemon stopped with cleanup error: ${error instanceof Error ? error.message : String(error)}\n`);
				})
				.finally(resolve);
		};
		processLike.once("SIGINT", shutdown);
		processLike.once("SIGTERM", shutdown);
		processLike.once("SIGHUP", shutdown);
	});
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && typeof error.code === "string";
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const exitCode = await runDaemonCli();
	process.exitCode = exitCode;
}
