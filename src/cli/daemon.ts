import { randomBytes } from "node:crypto";
import { createAlfredDaemon, type AlfredDaemon, type AlfredDaemonConfig } from "../daemon/index.ts";

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

export interface RunDaemonCliOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: Pick<NodeJS.WriteStream, "write">;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly createDaemon?: (config: Pick<AlfredDaemonConfig, "host" | "port" | "authToken">) => AlfredDaemon;
	readonly randomToken?: () => string;
	readonly signals?: NodeJS.Process;
}

export function parseDaemonCliConfig(
	env: NodeJS.ProcessEnv = process.env,
	randomToken: () => string = createLocalAuthToken,
): DaemonCliConfig {
	const host = normalizedEnvValue(env.ALFRED_HOST) ?? DEFAULT_DAEMON_HOST;
	const port = parseAlfredPort(env.ALFRED_PORT);
	const configuredToken = normalizedEnvValue(env.ALFRED_LOCAL_TOKEN);
	const tokenSource: DaemonTokenSource = configuredToken ? "env" : "generated";
	const authToken = configuredToken ?? randomToken();
	const dashboardUrl = `http://${host}:${port}/dashboard`;

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
		`Listening: http://${config.host}:${config.port}`,
		`Dashboard: ${config.dashboardUrl}`,
	];

	if (config.tokenSource === "generated") {
		lines.push("Auth token: generated for this process only; it will not be persisted.");
		lines.push(`Generated token: ${config.authToken}`);
		lines.push("Use API header: x-alfred-auth: <generated token above>");
	} else {
		lines.push("Auth token: using ALFRED_LOCAL_TOKEN from the environment; value is not printed.");
		lines.push("Use API header: x-alfred-auth: <your ALFRED_LOCAL_TOKEN>");
	}

	lines.push("Shutdown: press Ctrl+C or send SIGTERM.");
	return `${lines.join("\n")}\n`;
}

export function formatDaemonStartedMessage(config: DaemonCliConfig, started: { host: string; port: number }): string {
	return `Alfred daemon ready on http://${started.host}:${started.port}\nDashboard: ${config.dashboardUrl}\n`;
}

export function formatDaemonStartupError(error: unknown, config?: DaemonCliConfig): string {
	if (isNodeError(error) && error.code === "EADDRINUSE") {
		const endpoint = config ? `${config.host}:${config.port}` : "configured address";
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

	await waitForShutdown(daemon, stdout, options.signals ?? process);
	return 0;
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
	processLike: NodeJS.Process,
): Promise<void> {
	await new Promise<void>((resolve) => {
		let stopping = false;
		const shutdown = (signal: NodeJS.Signals) => {
			if (stopping) return;
			stopping = true;
			stdout.write(`Received ${signal}; stopping Alfred daemon...\n`);
			void daemon.stop()
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
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const exitCode = await runDaemonCli();
	process.exitCode = exitCode;
}
