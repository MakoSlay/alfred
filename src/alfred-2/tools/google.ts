import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	CalendarTodayToolCall,
	CalendarUpcomingToolCall,
	DocsReadToolCall,
	DocsSearchToolCall,
	GmailReadToolCall,
	GmailSearchToolCall,
	ToolExecutionContext,
	ToolResult,
} from "../tool-types.ts";
import { createStructuredFailure } from "../capabilities/outcome.ts";
import type { StructuredFailure } from "../capabilities/failure-codes.ts";

const DEFAULT_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/calendar.readonly",
	"https://www.googleapis.com/auth/documents.readonly",
	"https://www.googleapis.com/auth/drive.metadata.readonly",
];
const TOKEN_SKEW_MS = 60_000;
const MAX_TEXT_CHARS = 12_000;

type FetchLike = typeof fetch;

export interface GoogleOAuthClient {
	clientId: string;
	clientSecret: string;
}

export interface GoogleToken {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	scope?: string;
	expires_in?: number;
	expiry_date?: number;
}

export interface GoogleToolDeps {
	fetchImpl?: FetchLike;
	now?: () => Date;
	clientPath?: string;
	tokenPath?: string;
}

export interface GmailSummary {
	id: string;
	threadId?: string;
	from?: string;
	subject?: string;
	date?: string;
	snippet?: string;
}

export interface GmailMessage extends GmailSummary {
	body: string;
}

export interface CalendarEventSummary {
	id: string;
	summary: string;
	start: string;
	end?: string;
	location?: string;
	attendees?: string[];
	htmlLink?: string;
}

export interface GoogleDocSummary {
	id: string;
	name: string;
	modifiedTime?: string;
	webViewLink?: string;
}

export interface GoogleDocContent extends GoogleDocSummary {
	text: string;
}

export function googleClientPath(env: NodeJS.ProcessEnv = process.env): string {
	return expandHome(env["GOOGLE_OAUTH_CLIENT_PATH"]?.trim() || "~/.alfred/google/oauth-client.json");
}

export function googleTokenPath(env: NodeJS.ProcessEnv = process.env): string {
	return expandHome(env["GOOGLE_OAUTH_TOKEN_PATH"]?.trim() || "~/.alfred/google/token.json");
}

export function googleScopes(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env["GOOGLE_SCOPES"]?.trim();
	if (!raw) return DEFAULT_SCOPES;
	return raw.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
}

export function expandHome(pathText: string): string {
	if (pathText === "~") return homedir();
	if (pathText.startsWith("~/")) return join(homedir(), pathText.slice(2));
	if (pathText.startsWith("$HOME/")) return join(homedir(), pathText.slice("$HOME/".length));
	if (pathText === "$HOME") return homedir();
	return pathText;
}

export function loadGoogleOAuthClient(path = googleClientPath()): GoogleOAuthClient {
	if (!existsSync(path)) {
		throw new Error(`Google OAuth client file is missing at ${path}. Set GOOGLE_OAUTH_CLIENT_PATH or run the setup step.`);
	}
	return parseGoogleOAuthClient(readFileSync(path, "utf8"));
}

export function parseGoogleOAuthClient(jsonText: string): GoogleOAuthClient {
	const parsed = JSON.parse(jsonText) as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
	const app = parsed.installed ?? parsed.web;
	const clientId = app?.client_id;
	const clientSecret = app?.client_secret;
	if (typeof clientId !== "string" || typeof clientSecret !== "string") {
		throw new Error("Google OAuth client JSON must contain installed.client_id and installed.client_secret.");
	}
	return { clientId, clientSecret };
}

export function loadGoogleToken(path = googleTokenPath()): GoogleToken | null {
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GoogleToken>;
	if (typeof parsed.access_token !== "string") return null;
	return parsed as GoogleToken;
}

export function saveGoogleToken(token: GoogleToken, path = googleTokenPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function buildGoogleAuthUrl(params: { client: GoogleOAuthClient; redirectUri: string; scopes?: string[]; state?: string }): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", params.client.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", (params.scopes?.length ? params.scopes : DEFAULT_SCOPES).join(" "));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	if (params.state) url.searchParams.set("state", params.state);
	return url.toString();
}

export async function exchangeGoogleAuthCode(params: { client: GoogleOAuthClient; code: string; redirectUri: string; fetchImpl?: FetchLike; now?: () => Date }): Promise<GoogleToken> {
	const fetchImpl = params.fetchImpl ?? fetch;
	const body = new URLSearchParams({
		client_id: params.client.clientId,
		client_secret: params.client.clientSecret,
		code: params.code,
		grant_type: "authorization_code",
		redirect_uri: params.redirectUri,
	});
	const res = await fetchImpl("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status} ${sanitize(await res.text().catch(() => ""))}`);
	return normalizeToken(await res.json() as GoogleToken, params.now ?? (() => new Date()));
}

async function refreshGoogleAccessToken(params: { client: GoogleOAuthClient; token: GoogleToken; tokenPath: string; fetchImpl: FetchLike; now: () => Date }): Promise<GoogleToken> {
	if (!params.token.refresh_token) throw new Error("Google token is expired and has no refresh_token. Run npm run google:auth again.");
	const body = new URLSearchParams({
		client_id: params.client.clientId,
		client_secret: params.client.clientSecret,
		refresh_token: params.token.refresh_token,
		grant_type: "refresh_token",
	});
	const res = await params.fetchImpl("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!res.ok) throw new Error(`Google token refresh failed: HTTP ${res.status} ${sanitize(await res.text().catch(() => ""))}`);
	const refreshed = normalizeToken(await res.json() as GoogleToken, params.now);
	const merged = { ...params.token, ...refreshed, refresh_token: refreshed.refresh_token ?? params.token.refresh_token };
	saveGoogleToken(merged, params.tokenPath);
	return merged;
}

function normalizeToken(token: GoogleToken, now: () => Date): GoogleToken {
	const expiresIn = typeof token.expires_in === "number" ? token.expires_in : undefined;
	return {
		...token,
		expiry_date: token.expiry_date ?? (expiresIn ? now().getTime() + expiresIn * 1000 : undefined),
	};
}

async function googleAccessToken(deps: GoogleToolDeps = {}): Promise<string> {
	const clientPath = deps.clientPath ?? googleClientPath();
	const tokenPath = deps.tokenPath ?? googleTokenPath();
	const client = loadGoogleOAuthClient(clientPath);
	const token = loadGoogleToken(tokenPath);
	if (!token) throw new Error(`Google account is not authorized. Run npm run google:auth to create ${tokenPath}.`);
	const now = deps.now ?? (() => new Date());
	if (!token.expiry_date || token.expiry_date - TOKEN_SKEW_MS > now().getTime()) return token.access_token;
	return (await refreshGoogleAccessToken({ client, token, tokenPath, fetchImpl: deps.fetchImpl ?? fetch, now })).access_token;
}

async function googleJson<T>(url: string, deps: GoogleToolDeps = {}): Promise<T> {
	const token = await googleAccessToken(deps);
	const res = await (deps.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) throw new Error(`Google API failed: HTTP ${res.status} ${sanitize(await res.text().catch(() => ""))}`);
	return await res.json() as T;
}

export async function gmailSearch(toolCall: GmailSearchToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}): Promise<ToolResult<GmailSummary[]>> {
	const t0 = Date.now();
	try {
		const maxResults = clampInt(toolCall.maxResults ?? 10, 1, 20);
		const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
		url.searchParams.set("q", toolCall.query);
		url.searchParams.set("maxResults", String(maxResults));
		const list = await googleJson<{ messages?: Array<{ id: string; threadId?: string }> }>(url.toString(), deps);
		const messages = list.messages ?? [];
		const summaries = await Promise.all(messages.map((message) => gmailMetadata(message.id, deps)));
		return result("gmail_search", ctx, true, formatGmailSummaries(summaries), summaries, t0);
	} catch (error) {
		return result<GmailSummary[]>("gmail_search", ctx, false, `Gmail search failed: ${errorMessage(error)}`, undefined, t0, true, googleFailure(error));
	}
}

export async function gmailRead(toolCall: GmailReadToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}): Promise<ToolResult<GmailMessage>> {
	const t0 = Date.now();
	try {
		const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(toolCall.messageId)}`);
		url.searchParams.set("format", "full");
		const raw = await googleJson<GmailApiMessage>(url.toString(), deps);
		const message = gmailApiMessageToMessage(raw);
		return result("gmail_read", ctx, true, formatGmailMessage(message), message, t0);
	} catch (error) {
		return result<GmailMessage>("gmail_read", ctx, false, `Gmail read failed: ${errorMessage(error)}`, undefined, t0, true, googleFailure(error));
	}
}

async function gmailMetadata(messageId: string, deps: GoogleToolDeps): Promise<GmailSummary> {
	const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
	url.searchParams.set("format", "metadata");
	for (const header of ["From", "Subject", "Date"]) url.searchParams.append("metadataHeaders", header);
	return gmailApiMessageToSummary(await googleJson<GmailApiMessage>(url.toString(), deps));
}

export async function calendarToday(toolCall: CalendarTodayToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}): Promise<ToolResult<CalendarEventSummary[]>> {
	const start = deps.now?.() ?? new Date();
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return calendarUpcoming({ tool: "calendar_upcoming", calendarId: toolCall.calendarId, timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: 50 }, ctx, deps, "calendar_today");
}

export async function calendarUpcoming(toolCall: CalendarUpcomingToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}, toolName: "calendar_upcoming" | "calendar_today" = "calendar_upcoming"): Promise<ToolResult<CalendarEventSummary[]>> {
	const t0 = Date.now();
	try {
		const calendarId = toolCall.calendarId ?? "primary";
		const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
		url.searchParams.set("singleEvents", "true");
		url.searchParams.set("orderBy", "startTime");
		url.searchParams.set("timeMin", toolCall.timeMin ?? (deps.now?.() ?? new Date()).toISOString());
		if (toolCall.timeMax) url.searchParams.set("timeMax", toolCall.timeMax);
		url.searchParams.set("maxResults", String(clampInt(toolCall.maxResults ?? 10, 1, 50)));
		const data = await googleJson<{ items?: CalendarApiEvent[] }>(url.toString(), deps);
		const events = (data.items ?? []).map(calendarApiEventToSummary);
		return result(toolName, ctx, true, formatCalendarEvents(events), events, t0);
	} catch (error) {
		return result<CalendarEventSummary[]>(toolName, ctx, false, `Calendar read failed: ${errorMessage(error)}`, undefined, t0, true, googleFailure(error));
	}
}

export async function docsSearch(toolCall: DocsSearchToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}): Promise<ToolResult<GoogleDocSummary[]>> {
	const t0 = Date.now();
	try {
		const url = new URL("https://www.googleapis.com/drive/v3/files");
		url.searchParams.set("q", buildDriveDocsQuery(toolCall.query));
		url.searchParams.set("pageSize", String(clampInt(toolCall.maxResults ?? 10, 1, 20)));
		url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
		url.searchParams.set("orderBy", "modifiedTime desc");
		const data = await googleJson<{ files?: GoogleDocSummary[] }>(url.toString(), deps);
		const docs = data.files ?? [];
		return result("docs_search", ctx, true, formatDocSummaries(docs), docs, t0);
	} catch (error) {
		return result<GoogleDocSummary[]>("docs_search", ctx, false, `Google Docs search failed: ${errorMessage(error)}`, undefined, t0, true, googleFailure(error));
	}
}

export async function docsRead(toolCall: DocsReadToolCall, ctx: ToolExecutionContext, deps: GoogleToolDeps = {}): Promise<ToolResult<GoogleDocContent>> {
	const t0 = Date.now();
	try {
		const data = await googleJson<GoogleDocsApiDocument>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(toolCall.documentId)}`, deps);
		const text = truncate(extractGoogleDocText(data), MAX_TEXT_CHARS);
		const doc = { id: toolCall.documentId, name: data.title ?? "Untitled Google Doc", text };
		return result("docs_read", ctx, true, `${doc.name}\n\n${text || "(empty document)"}`, doc, t0);
	} catch (error) {
		return result<GoogleDocContent>("docs_read", ctx, false, `Google Docs read failed: ${errorMessage(error)}`, undefined, t0, true, googleFailure(error));
	}
}

export function buildDriveDocsQuery(query: string): string {
	const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	return `mimeType='application/vnd.google-apps.document' and trashed=false and (name contains '${escaped}' or fullText contains '${escaped}')`;
}

export function extractGoogleDocText(value: unknown): string {
	const chunks: string[] = [];
	walkDoc(value, chunks);
	return chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function walkDoc(value: unknown, chunks: string[]): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) walkDoc(item, chunks);
		return;
	}
	const obj = value as Record<string, unknown>;
	const textRun = obj.textRun as Record<string, unknown> | undefined;
	if (textRun && typeof textRun.content === "string") chunks.push(textRun.content);
	for (const [key, child] of Object.entries(obj)) {
		if (key === "textRun") continue;
		walkDoc(child, chunks);
	}
}

interface GmailApiMessage {
	id: string;
	threadId?: string;
	snippet?: string;
	payload?: GmailPayload;
}

interface GmailPayload {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPayload[];
	headers?: Array<{ name?: string; value?: string }>;
}

interface CalendarApiEvent {
	id: string;
	summary?: string;
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
	location?: string;
	attendees?: Array<{ email?: string; displayName?: string }>;
	htmlLink?: string;
}

interface GoogleDocsApiDocument {
	title?: string;
	body?: unknown;
}

function gmailApiMessageToSummary(message: GmailApiMessage): GmailSummary {
	return {
		id: message.id,
		threadId: message.threadId,
		from: header(message.payload, "from"),
		subject: header(message.payload, "subject") || "(no subject)",
		date: header(message.payload, "date"),
		snippet: message.snippet,
	};
}

function gmailApiMessageToMessage(message: GmailApiMessage): GmailMessage {
	const summary = gmailApiMessageToSummary(message);
	return { ...summary, body: truncate(extractGmailBody(message.payload), MAX_TEXT_CHARS) };
}

function header(payload: GmailPayload | undefined, name: string): string | undefined {
	return payload?.headers?.find((header) => header.name?.toLowerCase() === name)?.value;
}

function extractGmailBody(payload: GmailPayload | undefined): string {
	if (!payload) return "";
	const plain = collectParts(payload, "text/plain").join("\n").trim();
	if (plain) return plain;
	return stripHtml(collectParts(payload, "text/html").join("\n")).trim();
}

function collectParts(payload: GmailPayload, mimeType: string): string[] {
	const chunks: string[] = [];
	if (payload.mimeType === mimeType && payload.body?.data) chunks.push(decodeBase64Url(payload.body.data));
	for (const part of payload.parts ?? []) chunks.push(...collectParts(part, mimeType));
	return chunks;
}

export function decodeBase64Url(text: string): string {
	const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

function calendarApiEventToSummary(event: CalendarApiEvent): CalendarEventSummary {
	return {
		id: event.id,
		summary: event.summary ?? "(busy)",
		start: event.start?.dateTime ?? event.start?.date ?? "unknown",
		end: event.end?.dateTime ?? event.end?.date,
		location: event.location,
		attendees: event.attendees?.map((attendee) => attendee.displayName || attendee.email || "unknown").filter(Boolean),
		htmlLink: event.htmlLink,
	};
}

function formatGmailSummaries(messages: GmailSummary[]): string {
	if (!messages.length) return "No Gmail messages matched.";
	return messages.map((m, index) => `${index + 1}. ${m.subject ?? "(no subject)"}\nFrom: ${m.from ?? "unknown"}\nDate: ${m.date ?? "unknown"}\nID: ${m.id}\n${m.snippet ?? ""}`.trim()).join("\n\n");
}

function formatGmailMessage(message: GmailMessage): string {
	return `Subject: ${message.subject ?? "(no subject)"}\nFrom: ${message.from ?? "unknown"}\nDate: ${message.date ?? "unknown"}\nID: ${message.id}\n\n${message.body || "(empty message)"}`;
}

function formatCalendarEvents(events: CalendarEventSummary[]): string {
	if (!events.length) return "No calendar events found.";
	return events.map((event, index) => `${index + 1}. ${event.summary}\nStart: ${event.start}${event.end ? `\nEnd: ${event.end}` : ""}${event.location ? `\nLocation: ${event.location}` : ""}`).join("\n\n");
}

function formatDocSummaries(docs: GoogleDocSummary[]): string {
	if (!docs.length) return "No Google Docs matched.";
	return docs.map((doc, index) => `${index + 1}. ${doc.name}\nID: ${doc.id}${doc.modifiedTime ? `\nModified: ${doc.modifiedTime}` : ""}${doc.webViewLink ? `\nURL: ${doc.webViewLink}` : ""}`).join("\n\n");
}

function result<T>(tool: ToolResult<T>["tool"], ctx: ToolExecutionContext, success: boolean, text: string, data: T | undefined, t0: number, retryable = false, failure?: StructuredFailure): ToolResult<T> {
	return {
		tool,
		toolCallId: ctx.toolCallId,
		success,
		text,
		data,
		retryable,
		failure,
		safety: { risk: "external", confirmation: "none" },
		timingMs: Date.now() - t0,
	};
}

function clampInt(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]` : text;
}

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n");
}

function sanitize(text: string): string {
	return text.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[redacted]"')
		.replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[redacted]"')
		.slice(0, 500);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function googleFailure(error: unknown): StructuredFailure {
	const message = errorMessage(error);
	const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
	if (error instanceof Error && (error.name === "AbortError" || /\b(?:timed? out|timeout)\b/i.test(message))) {
		return createStructuredFailure({ stage: "execute", code: "execution.timeout", component: "google-tools", message, retryable: true, timedOut: true, detector: { id: "alfred.google.timeout", version: 1 } });
	}
	if (/OAuth client file is missing/.test(message)) {
		return createStructuredFailure({ stage: "execute", code: "precondition.missing_config", component: "google-tools", message, retryable: false, configKeysMissing: ["GOOGLE_OAUTH_CLIENT_PATH"], detector: { id: "alfred.google.config", version: 1 } });
	}
	if (/not authorized|no refresh_token/.test(message)) {
		return createStructuredFailure({ stage: "authorize", code: "precondition.missing_credentials", component: "google-tools", message, retryable: false, configKeysMissing: ["GOOGLE_OAUTH_TOKEN_PATH"], detector: { id: "alfred.google.credentials", version: 1 } });
	}
	if (status === 429) {
		return createStructuredFailure({ stage: "execute", code: "execution.rate_limited", component: "google-tools", message, retryable: true, rateLimited: true, httpStatus: status, detector: { id: "alfred.google.http", version: 1 } });
	}
	if (status >= 500 && status <= 599) {
		return createStructuredFailure({ stage: "execute", code: "execution.provider_5xx", component: "google-tools", message, retryable: true, httpStatus: status, detector: { id: "alfred.google.http", version: 1 } });
	}
	if (error instanceof TypeError || /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network)\b/i.test(message)) {
		return createStructuredFailure({ stage: "execute", code: "execution.network_transient", component: "google-tools", message, retryable: true, detector: { id: "alfred.google.network", version: 1 } });
	}
	return createStructuredFailure({ stage: "execute", code: "execution.internal_error", component: "google-tools", message, retryable: false, detector: { id: "alfred.google.unclassified", version: 1 } });
}

export function googleConfigStatus(env: NodeJS.ProcessEnv = process.env): { clientPath: string; tokenPath: string; scopes: string[]; hasClient: boolean; hasToken: boolean } {
	const clientPath = googleClientPath(env);
	const tokenPath = googleTokenPath(env);
	return {
		clientPath: resolve(clientPath),
		tokenPath: resolve(tokenPath),
		scopes: googleScopes(env),
		hasClient: existsSync(clientPath),
		hasToken: existsSync(tokenPath),
	};
}
