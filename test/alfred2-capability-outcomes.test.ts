import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import { createStructuredFailure, createTaskOutcomeFinalizer, type TaskOutcome } from "../src/alfred-2/capabilities/outcome.ts";
import { parseAlfredModelResponse } from "../src/alfred-2/parser.ts";
import { startAlfred2 } from "../src/alfred-2/server.ts";
import { runToolLoop } from "../src/alfred-2/tool-loop.ts";
import { fetchContent, webSearch } from "../src/alfred-2/tools/web.ts";

const CONTEXT = "WORKSPACES (1):\n  Main [current] | ref:workspace:1 | /tmp/main | branch: main (clean)";

function temporaryProfile(): { directory: string; file: string; historyFile: string } {
	const directory = mkdtempSync(join(tmpdir(), "alfred2-outcome-profile-"));
	return { directory, file: join(directory, "profile.json"), historyFile: join(directory, "history.json") };
}

function loop(responses: string[], overrides: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
	return runToolLoop({
		llmClient: createFakeLlmClient(responses),
		userText: "test request",
		systemContext: CONTEXT,
		requestId: "req-outcome",
		sessionId: "sess-outcome",
		speakAcknowledgements: false,
		...overrides,
	});
}

test("versioned finalizer bounds, redacts, and finalizes only once", () => {
	const outcomes: TaskOutcome[] = [];
	const finalizer = createTaskOutcomeFinalizer({ requestId: "req-1", sessionId: "sess-1", onFinalize: (outcome) => outcomes.push(outcome) });
	const failure = createStructuredFailure({
		stage: "execute",
		code: "execution.internal_error",
		component: "test",
		message: `API_KEY=secret ${"x".repeat(2_000)}`,
		retryable: false,
	});
	const first = finalizer.fail(failure);
	const second = finalizer.complete();
	assert.equal(first, second);
	assert.equal(outcomes.length, 1);
	assert.equal(first.contractVersion, 1);
	assert.equal(first.terminalFailure?.contractVersion, 1);
	assert.equal(first.status, "failed");
	assert.ok((first.terminalFailure?.message.length ?? 0) <= 1_000);
	assert.doesNotMatch(first.terminalFailure?.message ?? "", /secret/);
	assert.doesNotMatch(createStructuredFailure({ stage: "execute", code: "execution.internal_error", component: "test", message: '{"apiKey":"super-secret-value"} Authorization: Basic abc123', retryable: false }).message, /super-secret|abc123/);
	assert.deepEqual(first.requiredOperationKeys, []);
	assert.deepEqual(first.completedOperationKeys, []);
	assert.deepEqual(first.operationLineageKeys, []);
	assert.equal(Object.isFrozen(first), true);
});

test("parser-invalid output is distinct from unknown tool and invalid arguments", () => {
	const invalid = parseAlfredModelResponse("not json", { retryCount: 1 });
	const unknown = parseAlfredModelResponse('{"tool":"teleport"}', { retryCount: 1 });
	const badArgs = parseAlfredModelResponse('{"tool":"bash"}', { retryCount: 1 });
	assert.equal(invalid.kind, "terminal_error");
	assert.equal(unknown.kind, "terminal_error");
	assert.equal(badArgs.kind, "terminal_error");
	if (invalid.kind === "terminal_error" && unknown.kind === "terminal_error" && badArgs.kind === "terminal_error") {
		assert.equal(invalid.failureCode, "parser.invalid_output");
		assert.equal(unknown.failureCode, "parser.unknown_tool");
		assert.equal(badArgs.failureCode, "parser.invalid_tool_arguments");
	}
});

test("tool loop maps success, parser failure, max rounds, ambiguity, timeout, and handoff", async () => {
	const success = await loop(['{"speech":"Done, sir."}']);
	assert.equal(success.outcome.status, "completed");
	assert.equal(success.outcome.terminalFailure, undefined);

	const unknown = await loop(['{"tool":"teleport"}', '{"tool":"teleport"}']);
	assert.equal(unknown.outcome.status, "failed");
	assert.equal(unknown.outcome.terminalFailure?.code, "parser.unknown_tool");
	assert.notEqual(unknown.outcome.status, "needs_capability");

	const maxRounds = await loop(['{"tool":"bash","command":"true"}', '{"tool":"bash","command":"true"}'], {
		maxToolRounds: 1,
		executeBash: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
	});
	assert.equal(maxRounds.outcome.terminalFailure?.code, "budget.max_rounds");

	const ambiguous = await loop(['{"tool":"bash","command":"pwd"}'], {
		userText: "use Maine",
		systemContext: "WORKSPACES (2):\n  Main [current] | ref:workspace:1 | /tmp/main\n  Maine | ref:workspace:2 | /tmp/maine",
	});
	assert.equal(ambiguous.outcome.status, "needs_user_input");
	assert.equal(ambiguous.outcome.terminalFailure?.code, "resolution.ambiguous_target");

	const timeout = await loop([], { maxRequestMs: -1 });
	assert.equal(timeout.outcome.status, "failed");
	assert.equal(timeout.outcome.terminalFailure?.code, "budget.request_timeout");

	const handoff = await loop([], { initialSessionTokens: 99, sessionHandoffTokens: 1 });
	assert.equal(handoff.outcome.status, "handed_off");
	assert.equal(handoff.outcome.terminalFailure?.code, "budget.context_handoff");
});

test("provider rate limits, 5xx responses, and network errors produce distinct terminal outcomes", async () => {
	const providerLoop = (cause: Error) => runToolLoop({
		llmClient: { async complete() { throw cause; } },
		userText: "provider test",
		systemContext: CONTEXT,
		requestId: "req-provider",
		sessionId: "sess-provider",
		speakAcknowledgements: false,
	});
	const limited = await providerLoop(new Error("LLM error: HTTP 429"));
	const unavailable = await providerLoop(new Error("LLM error: HTTP 503"));
	const network = await providerLoop(new TypeError("network unavailable"));
	assert.equal(limited.outcome.terminalFailure?.code, "execution.rate_limited");
	assert.equal(unavailable.outcome.terminalFailure?.code, "execution.provider_5xx");
	assert.equal(network.outcome.terminalFailure?.code, "execution.network_transient");
	assert.equal(limited.outcome.status, "failed");
});

test("policy block is distinct from confirmation pending", async () => {
	const blocked = await loop(['{"tool":"read_file","path":"~/.ssh/config"}']);
	assert.equal(blocked.outcome.status, "blocked");
	assert.equal(blocked.outcome.terminalFailure?.code, "policy.blocked");

	const pending = await loop(['{"tool":"write_file","path":"note.txt","content":"hello"}']);
	assert.equal(pending.outcome.status, "needs_user_input");
	assert.equal(pending.outcome.terminalFailure?.code, "confirmation.required");
});

test("unresolved bash failure is terminal while a later successful recovery completes", async () => {
	let calls = 0;
	const recovered = await loop(['{"tool":"bash","command":"false"}', '{"tool":"bash","command":"true"}', '{"speech":"Recovered, sir."}'], {
		executeBash: async () => ++calls === 1
			? ({ ok: false, stdout: "", stderr: "exit 2", exitCode: 2 })
			: ({ ok: true, stdout: "recovered", stderr: "", exitCode: 0 }),
	});
	assert.equal(recovered.toolResults[0]?.failure?.code, "execution.exit_nonzero");
	assert.equal(recovered.outcome.status, "completed");
	assert.equal(recovered.outcome.terminalFailure, undefined);

	const timedOut = await loop(['{"tool":"bash","command":"sleep 10"}', '{"speech":"It timed out, sir."}'], {
		executeBash: async () => ({ ok: false, stdout: "", stderr: "timed out", timedOut: true }),
	});
	assert.equal(timedOut.toolResults[0]?.failure?.code, "execution.timeout");
	assert.equal(timedOut.outcome.status, "failed");
	assert.equal(timedOut.outcome.terminalFailure?.code, "execution.timeout");
});

test("missing configuration, rate limit, provider 5xx, and network failure stay distinct", async () => {
	const missing = await webSearch({ tool: "web_search", query: "test" }, { requestId: "r", toolCallId: "t", risk: "external" }, null);
	assert.equal(missing.failure?.code, "precondition.missing_config");

	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => new Response("limited", { status: 429 })) as typeof fetch;
		const limited = await fetchContent({ tool: "fetch_content", url: "https://example.com" }, { requestId: "r", toolCallId: "t1", risk: "external" }, null);
		assert.equal(limited.failure?.code, "execution.rate_limited");

		globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
		const unavailable = await fetchContent({ tool: "fetch_content", url: "https://example.com" }, { requestId: "r", toolCallId: "t2", risk: "external" }, null);
		assert.equal(unavailable.failure?.code, "execution.provider_5xx");

		globalThis.fetch = (async () => { throw new TypeError("network unavailable"); }) as typeof fetch;
		const network = await fetchContent({ tool: "fetch_content", url: "https://example.com" }, { requestId: "r", toolCallId: "t3", risk: "external" }, null);
		assert.equal(network.failure?.code, "execution.network_transient");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("ask boundary finalizes invalid, deterministic, loop, and unexpected exception paths once", async () => {
	const profile = temporaryProfile();
	const outcomes: TaskOutcome[] = [];
	let agentMode: "ok" | "throw" = "ok";
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { if (agentMode === "throw") throw new Error("provider exploded"); return { speech: "Done, sir.", displayText: "Done, sir." }; } },
		onTaskOutcome: (outcome) => outcomes.push(outcome),
		profileFile: profile.file,
		historyFile: profile.historyFile,
	});
	const base = `http://${server.host}:${server.port}`;
	try {
		const ask = (body: Record<string, unknown>) => fetch(`${base}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await ask({ requestId: "invalid", text: "" })).status, 400);
		assert.equal((await ask({ requestId: "deterministic", text: "what time is it" })).status, 200);
		assert.equal((await ask({ requestId: "loop", text: "say hello" })).status, 200);
		agentMode = "throw";
		assert.equal((await ask({ requestId: "exception", text: "tell me a joke" })).status, 200);
		assert.deepEqual(outcomes.map((outcome) => [outcome.requestId, outcome.status, outcome.terminalFailure?.code]), [
			["invalid", "failed", "contract.invalid_input"],
			["deterministic", "completed", undefined],
			["loop", "completed", undefined],
			["exception", "failed", "execution.internal_error"],
		]);
		assert.equal(new Set(outcomes.map((outcome) => outcome.requestId)).size, 4);
	} finally {
		await server.close();
		rmSync(profile.directory, { recursive: true, force: true });
	}
});

test("a throwing outcome observer cannot break or duplicate the response", async () => {
	const profile = temporaryProfile();
	let calls = 0;
	const server = await startAlfred2({
		host: "127.0.0.1",
		port: 0,
		llm: { endpoint: "https://example.invalid/v1", model: "fake", apiKey: "fake" },
		agent: { async ask() { return { speech: "Done, sir.", displayText: "Done, sir." }; } },
		onTaskOutcome: () => { calls++; throw new Error("observer failed"); },
		profileFile: profile.file,
		historyFile: profile.historyFile,
	});
	try {
		const response = await fetch(`http://${server.host}:${server.port}/ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "observer", text: "what time is it" }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json() as { ok: boolean }).ok, true);
		assert.equal(calls, 1);
	} finally {
		await server.close();
		rmSync(profile.directory, { recursive: true, force: true });
	}
});
