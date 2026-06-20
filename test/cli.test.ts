import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_DAEMON_HOST,
	DEFAULT_DAEMON_PORT,
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

test("daemon CLI env parsing accepts host, port, and configured token", () => {
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

test("daemon CLI startup message prints generated token once and omits it from dashboard URL", () => {
	const config = parseDaemonCliConfig({}, () => "generated-test-token");
	const message = formatDaemonStartupMessage(config);

	assert.match(message, /Alfred daemon starting/);
	assert.match(message, /Listening: http:\/\/127\.0\.0\.1:47321/);
	assert.match(message, /Dashboard: http:\/\/127\.0\.0\.1:47321\/dashboard/);
	assert.match(message, /Generated token: generated-test-token/);
	assert.match(message, /x-alfred-auth: <generated token above>/);
	assert.doesNotMatch(message, /dashboard\?token=/);
	assert.equal([...message.matchAll(/generated-test-token/g)].length, 1);
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

test("daemon CLI exits nonzero for startup failure", async () => {
	let stderr = "";
	const exitCode = await runDaemonCli({
		env: { ALFRED_LOCAL_TOKEN: "configured-token" },
		stdout: { write: () => true },
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
});
