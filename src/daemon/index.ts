import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AlfredEvent, AlfredHandleRequest, AlfredHandleResponse, AlfredTarget, RetentionMetadata } from "../contracts/runtime.ts";
import { sourceHasCapabilities } from "../contracts/runtime.ts";
import { createCmuxWorldModelAdapter, type CmuxWorldModelAdapter } from "../cmux/index.ts";

export interface AlfredDaemonConfig {
	readonly host: string;
	readonly port: number;
	readonly authToken: string;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly maxBodyBytes: number;
}

export interface AlfredDaemonStateSnapshot {
	health: "ok" | "degraded";
	pendingDrafts: [];
	activeLoop: null;
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
}

export interface AlfredDaemonDependencies {
	cmux?: Pick<CmuxWorldModelAdapter, "listTargets">;
	now?: () => Date;
}

export interface AlfredDaemon {
	readonly config: AlfredDaemonConfig;
	start(): Promise<{ host: string; port: number; authToken: string }>;
	stop(): Promise<void>;
}

interface DaemonState {
	recentTargets: AlfredTarget[];
	events: AlfredEvent[];
}

export function defaultDaemonConfig(overrides: Partial<AlfredDaemonConfig> = {}): AlfredDaemonConfig {
	const host = overrides.host ?? "127.0.0.1";
	const port = overrides.port ?? 47_321;
	return {
		host,
		port,
		authToken: overrides.authToken ?? process.env.ALFRED_LOCAL_TOKEN ?? randomBytes(24).toString("base64url"),
		allowedHosts: overrides.allowedHosts ?? ["127.0.0.1", "localhost", "::1", "[::1]"],
		allowedOrigins: overrides.allowedOrigins ?? [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
		maxBodyBytes: overrides.maxBodyBytes ?? 128 * 1024,
	};
}

export function createAlfredDaemon(
	config: Partial<AlfredDaemonConfig> = {},
	dependencies: AlfredDaemonDependencies = {},
): AlfredDaemon {
	const resolvedConfig = defaultDaemonConfig(config);
	const state: DaemonState = { recentTargets: [], events: [] };
	const cmux = dependencies.cmux ?? createCmuxWorldModelAdapter();
	const now = dependencies.now ?? (() => new Date());
	const server = http.createServer((request, response) => {
		void handleDaemonRequest(request, response, resolvedConfig, state, cmux, now);
	});

	return {
		config: resolvedConfig,
		async start() {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(resolvedConfig.port, resolvedConfig.host, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address() as AddressInfo;
			return { host: resolvedConfig.host, port: address.port, authToken: resolvedConfig.authToken };
		},
		async stop() {
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

async function handleDaemonRequest(
	request: IncomingMessage,
	response: ServerResponse,
	config: AlfredDaemonConfig,
	state: DaemonState,
	cmux: Pick<CmuxWorldModelAdapter, "listTargets">,
	now: () => Date,
): Promise<void> {
	const guard = guardRequest(request, config);
	if (!guard.ok) {
		writeJson(response, guard.status, { ok: false, error: guard.error });
		return;
	}

	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
	if (request.method === "GET" && url.pathname === "/health") {
		writeJson(response, 200, { ok: true, health: "ok" });
		return;
	}

	if (request.method === "GET" && url.pathname === "/state") {
		writeJson(response, 200, snapshotState(state));
		return;
	}

	if (request.method === "GET" && url.pathname === "/surfaces") {
		const targets = await cmux.listTargets();
		if (!targets.ok) {
			writeJson(response, 503, {
				ok: false,
				error: {
					code: "cmux_unavailable",
					message: targets.error.message,
					retryable: true,
				},
			});
			return;
		}
		state.recentTargets = targets.value;
		writeJson(response, 200, { ok: true, targets: targets.value });
		return;
	}

	if (request.method === "POST" && url.pathname === "/handle") {
		const body = await readJsonBody<AlfredHandleRequest>(request, config.maxBodyBytes);
		if (!body.ok) {
			writeJson(response, 400, { ok: false, error: { code: "invalid_request", message: body.error, retryable: false } });
			return;
		}
		const result = handleRequest(body.value, state, now);
		writeJson(response, result.ok ? 200 : 400, result);
		return;
	}

	if (request.method === "POST" && ["/confirm", "/cancel", "/send"].includes(url.pathname)) {
		writeJson(response, 501, {
			ok: false,
			error: {
				code: "unsupported_action",
				message: `${url.pathname} is reserved for Task 005 action execution and is not enabled yet.`,
				retryable: false,
			},
		});
		return;
	}

	writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Route not found", retryable: false } });
}

function handleRequest(request: AlfredHandleRequest, state: DaemonState, now: () => Date): AlfredHandleResponse {
	if (!request.input?.text?.trim()) {
		return {
			requestId: request.requestId,
			createdAt: now().toISOString(),
			ok: false,
			displayText: "Alfred needs input text to handle a request.",
			proposedActions: [],
			events: [],
			errors: [{ code: "invalid_request", message: "input.text is required", retryable: false }],
		};
	}
	const allowedCapabilities = request.policy?.allowedCapabilities ?? request.source.capabilities;
	const effectiveSource = {
		...request.source,
		capabilities: request.source.capabilities.filter((capability) => allowedCapabilities.includes(capability)),
	};
	if (!sourceHasCapabilities(effectiveSource, ["world.read"])) {
		return {
			requestId: request.requestId,
			createdAt: now().toISOString(),
			ok: false,
			displayText: "Alfred cannot handle that request because the source lacks world.read.",
			proposedActions: [],
			events: [],
			errors: [{ code: "capability_denied", message: "Missing world.read capability", retryable: false }],
		};
	}
	const createdAt = now().toISOString();
	const event: AlfredEvent = {
		id: `evt_${request.requestId}`,
		kind: "request.received",
		createdAt,
		requestId: request.requestId,
		source: { kind: request.source.kind, id: request.source.id, label: request.source.label },
		summary: `Handled ${request.source.kind} request without executing privileged actions.`,
		redaction: { status: "not_needed" },
		retention: defaultEventRetention(createdAt),
	};
	state.events.unshift(event);
	state.events = state.events.slice(0, 100);
	return {
		requestId: request.requestId,
		createdAt,
		ok: true,
		displayText: "Alfred daemon received the request. Action planning is reserved for the next milestone.",
		proposedActions: [],
		events: [event],
		nextStatePatch: request.context?.visibleTargets?.[0] ? { rememberTarget: request.context.visibleTargets[0] } : undefined,
	};
}

function guardRequest(request: IncomingMessage, config: AlfredDaemonConfig): { ok: true } | { ok: false; status: number; error: { code: string; message: string; retryable: boolean } } {
	if (request.method === "OPTIONS") {
		return { ok: false, status: 403, error: { code: "cors_forbidden", message: "CORS preflight is not allowed for Alfred local control APIs.", retryable: false } };
	}
	const hostHeader = request.headers.host;
	if (!hostHeader || !hostAllowed(hostHeader, config.allowedHosts)) {
		return { ok: false, status: 403, error: { code: "host_forbidden", message: "Host header is not allowed.", retryable: false } };
	}
	const origin = request.headers.origin;
	if (origin && !originAllowed(origin, config.allowedOrigins, config.allowedHosts)) {
		return { ok: false, status: 403, error: { code: "origin_forbidden", message: "Origin is not allowed.", retryable: false } };
	}
	if (request.url !== "/health" && !authAllowed(request, config.authToken)) {
		return { ok: false, status: 401, error: { code: "auth_required", message: "Missing or invalid Alfred local auth token.", retryable: false } };
	}
	return { ok: true };
}

function authAllowed(request: IncomingMessage, authToken: string): boolean {
	const headerToken = request.headers["x-alfred-auth"];
	if (headerToken === authToken) return true;
	const authorization = request.headers.authorization;
	return authorization === `Bearer ${authToken}`;
}

function hostAllowed(hostHeader: string, allowedHosts: readonly string[]): boolean {
	const host = hostHeader.startsWith("[")
		? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
		: hostHeader.split(":")[0] ?? "";
	const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
	return allowedHosts.some((allowed) => allowed.replace(/^\[/, "").replace(/\]$/, "") === normalized);
}

function originAllowed(origin: string, allowedOrigins: readonly string[], allowedHosts: readonly string[]): boolean {
	if (allowedOrigins.includes(origin)) return true;
	try {
		const parsed = new URL(origin);
		return hostAllowed(parsed.host, allowedHosts);
	} catch {
		return false;
	}
}

async function readJsonBody<T>(request: IncomingMessage, maxBytes: number): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let total = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buffer.length;
		if (total > maxBytes) return { ok: false, error: "Request body is too large" };
		chunks.push(buffer);
	}
	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T };
	} catch {
		return { ok: false, error: "Request body must be valid JSON" };
	}
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

function snapshotState(state: DaemonState): AlfredDaemonStateSnapshot {
	return {
		health: "ok",
		pendingDrafts: [],
		activeLoop: null,
		recentTargets: state.recentTargets,
		events: state.events,
	};
}

function defaultEventRetention(createdAt: string): RetentionMetadata {
	return {
		policy: "short",
		expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
		reason: "daemon request audit event",
	};
}
