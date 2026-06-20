import assert from "node:assert/strict";
import test from "node:test";
import type { AlfredDaemonConfig } from "../src/daemon/index.ts";
import {
	DEFAULT_DAEMON_HOST,
	DEFAULT_DAEMON_PORT,
	formatDaemonStartedMessage,
	formatDaemonStartupError,
	formatDaemonStartupMessage,
	parseDaemonCliConfig,
	runDaemonCli,
} from "../src/cli/daemon.ts";

test("daemon CLI env parsing uses safe defaults and generated token", () => {
	const config = parseDaemonCliConfig({}, () => "generated-test-token");

	assert.equal(config.host, DEFAULT_DAEMON_HOST);
	assert.equal(config.port, DEFAULT_DAEMON_PORT);
	assert.equal(config.authToken, "generated-test-token");
	assert.equal(config.tokenSource, "generated");
	assert.equal(config.dashboardUrl, "http://127.0.0.1:47321/dashboard");
	assert.deepEqual(config.daemonConfig, { host: "127.0.0.1", port: 47321, authToken: "generated-test-token" });
});

test("daemon CLI env parsing accepts loopback host, port, and configured token", () => {
	const config = parseDaemonCliConfig({
		ALFRED_HOST: "localhost",
		ALFRED_PORT: "47322",
		ALFRED_LOCAL_TOKEN: "configured-token",
	}, () => "unused-generated-token");

	assert.equal(config.host, "localhost");
	assert.equal(config.port, 47322);
	assert.equal(config.authToken, "configured-token");
	assert.equal(config.tokenSource, "env");
	assert.equal(config.dashboardUrl, "http://localhost:47322/dashboard");
});

test("daemon CLI formats IPv6 loopback dashboard URLs", () => {
	const config = parseDaemonCliConfig({ ALFRED_HOST: "::1", ALFRED_PORT: "47322" }, () => "generated-token");

	assert.equal(config.host, "::1");
	assert.equal(config.dashboardUrl, "http://[::1]:47322/dashboard");
	assert.match(formatDaemonStartupMessage(config), /Listening: http:\/\/\[::1\]:47322/);
});

test("daemon CLI rejects non-loopback ALFRED_HOST clearly", () => {
	assert.throws(
		() => parseDaemonCliConfig({ ALFRED_HOST: "0.0.0.0" }, () => "unused"),
		/Invalid ALFRED_HOST.*loopback host/,
	);
	assert.throws(
		() => parseDaemonCliConfig({ ALFRED_HOST: "192.168.1.10" }, () => "unused"),
		/Invalid ALFRED_HOST.*loopback host/,
	);
});

test("daemon CLI rejects invalid ALFRED_PORT clearly", () => {
	assert.throws(
		() => parseDaemonCliConfig({ ALFRED_PORT: "not-a-number" }, () => "unused"),
		/Invalid ALFRED_PORT.*integer between 1 and 65535/,
	);
	assert.throws(
		() => parseDaemonCliConfig({ ALFRED_PORT: "0" }, () => "unused"),
		/Invalid ALFRED_PORT.*integer between 1 and 65535/,
	);
});

test("daemon CLI prints generated token once only after startup succeeds", () => {
	const config = parseDaemonCliConfig({}, () => "generated-test-token");
	const startupMessage = formatDaemonStartupMessage(config);
	const startedMessage = formatDaemonStartedMessage(config, { host: config.host, port: config.port });
	const combinedMessage = `${startupMessage}${startedMessage}`;

	assert.match(startupMessage, /Alfred daemon starting/);
	assert.match(startupMessage, /Listening: http:\/\/127\.0\.0\.1:47321/);
	assert.match(startupMessage, /Dashboard: http:\/\/127\.0\.0\.1:47321\/dashboard/);
	assert.doesNotMatch(startupMessage, /generated-test-token/);
	assert.match(startedMessage, /Generated token: generated-test-token/);
	assert.match(startedMessage, /x-alfred-auth: <generated token above>/);
	assert.doesNotMatch(combinedMessage, /dashboard\?token=/);
	assert.equal([...combinedMessage.matchAll(/generated-test-token/g)].length, 1);
});

test("daemon CLI startup message redacts configured token", () => {
	const config = parseDaemonCliConfig({ ALFRED_LOCAL_TOKEN: "configured-secret-token" }, () => "unused-generated-token");
	const message = formatDaemonStartupMessage(config);

	assert.match(message, /using ALFRED_LOCAL_TOKEN from the environment; value is not printed/);
	assert.match(message, /x-alfred-auth: <your ALFRED_LOCAL_TOKEN>/);
	assert.doesNotMatch(message, /configured-secret-token/);
	assert.doesNotMatch(message, /unused-generated-token/);
	assert.doesNotMatch(message, /dashboard\?token=/);
});

test("daemon CLI formats bind-in-use failures with operator guidance", () => {
	const config = parseDaemonCliConfig({ ALFRED_PORT: "47321", ALFRED_LOCAL_TOKEN: "configured-token" });
	const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
	const message = formatDaemonStartupError(error, config);

	assert.match(message, /127\.0\.0\.1:47321 is already in use/);
	assert.match(message, /Set ALFRED_PORT/);
});

test("daemon CLI exits nonzero for invalid config before starting", async () => {
	let stdout = "";
	let stderr = "";
	const exitCode = await runDaemonCli({
		env: { ALFRED_PORT: "bad-port" },
		stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
		stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true; } },
		createDaemon: () => { throw new Error("should not start daemon"); },
	});

	assert.equal(exitCode, 1);
	assert.equal(stdout, "");
	assert.match(stderr, /Invalid ALFRED_PORT/);
});

test("daemon CLI exits nonzero for startup failure without leaking generated token", async () => {
	let stdout = "";
	let stderr = "";
	const exitCode = await runDaemonCli({
		env: {},
		randomToken: () => "generated-token-for-failed-start",
		stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
		stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true; } },
		createDaemon: (config) => ({
			config: {
				...config,
				allowedHosts: [],
				allowedOrigins: [],
				maxBodyBytes: 1,
			},
			async start() {
				throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
			},
			async stop() {},
		}),
	});

	assert.equal(exitCode, 1);
	assert.match(stderr, /already in use/);
	assert.doesNotMatch(stdout, /generated-token-for-failed-start/);
});

test("daemon CLI handles shutdown signals and stops the daemon", async () => {
	let stdout = "";
	let stopped = false;
	const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
	const signals = {
		once(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: (signal: NodeJS.Signals) => void) {
			listeners.set(signal, listener);
			return signals;
		},
	};
	const daemonConfig: AlfredDaemonConfig = {
		host: "127.0.0.1",
		port: 47321,
		authToken: "configured-token",
		allowedHosts: [],
		allowedOrigins: [],
		maxBodyBytes: 1,
	};

	const run = runDaemonCli({
		env: { ALFRED_LOCAL_TOKEN: "configured-token" },
		stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
		stderr: { write: () => true },
		signals,
		createDaemon: (config) => ({
			config: { ...daemonConfig, ...config },
			async start() { return { host: config.host, port: config.port, authToken: config.authToken }; },
			async stop() { stopped = true; },
		}),
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(listeners.has("SIGINT"), true);
	assert.equal(listeners.has("SIGTERM"), true);
	assert.equal(listeners.has("SIGHUP"), true);
	listeners.get("SIGTERM")?.("SIGTERM");

	assert.equal(await run, 0);
	assert.equal(stopped, true);
	assert.match(stdout, /Received SIGTERM; stopping Alfred daemon/);
	assert.match(stdout, /Alfred daemon stopped/);
});
