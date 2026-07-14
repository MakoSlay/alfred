import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildGoogleAuthUrl,
	exchangeGoogleAuthCode,
	googleClientPath,
	googleConfigStatus,
	googleScopes,
	googleTokenPath,
	loadGoogleOAuthClient,
	saveGoogleToken,
} from "./tools/google.ts";

loadDaemonEnv();

const clientPath = googleClientPath();
const tokenPath = googleTokenPath();
const scopes = googleScopes();
const client = loadGoogleOAuthClient(clientPath);
const state = randomUUID();
const server = http.createServer();

server.on("request", (req, res) => {
	void handleCallback(req, res).catch((error) => {
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end(`Google authorization failed: ${error instanceof Error ? error.message : String(error)}\n`);
		setTimeout(() => server.close(), 50);
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not determine local OAuth callback port.");
	const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
	const url = buildGoogleAuthUrl({ client, redirectUri, scopes, state });
	console.log("Opening Google OAuth login for Alfred...");
	console.log(`Client: ${clientPath}`);
	console.log(`Token will be saved to: ${tokenPath}`);
	console.log("");
	console.log(url);
	console.log("");
	console.log("If the browser does not open, paste the URL above into your browser.");
	openUrl(url);
});

async function handleCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("OAuth server is not listening.");
	const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
	const url = new URL(req.url ?? "/", redirectUri);
	if (url.pathname !== "/oauth2callback") {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found.\n");
		return;
	}
	if (url.searchParams.get("state") !== state) throw new Error("OAuth state did not match; refusing token exchange.");
	const error = url.searchParams.get("error");
	if (error) throw new Error(error);
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing OAuth code.");
	const token = await exchangeGoogleAuthCode({ client, code, redirectUri });
	saveGoogleToken(token, tokenPath);
	const status = googleConfigStatus();
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(`<h1>Alfred Google authorization complete</h1><p>You can close this tab.</p><p>Saved token for ${status.scopes.length} scopes.</p>`);
	console.log("Google authorization complete.");
	console.log(`Saved token: ${tokenPath}`);
	console.log(`Scopes: ${status.scopes.join(", ")}`);
	setTimeout(() => server.close(), 100);
}

server.on("close", () => process.exit(0));
server.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

function openUrl(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	execFile(command, args, () => {});
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
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		process.env[key] = value;
	}
}
