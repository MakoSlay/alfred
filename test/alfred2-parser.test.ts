import test from "node:test";
import assert from "node:assert/strict";
import { buildParserRetryPrompt, parseAlfredModelResponse } from "../src/alfred-2/parser.ts";

function assertKind<T extends ReturnType<typeof parseAlfredModelResponse>["kind"]>(result: ReturnType<typeof parseAlfredModelResponse>, kind: T): Extract<ReturnType<typeof parseAlfredModelResponse>, { kind: T }> {
	assert.equal(result.kind, kind, JSON.stringify(result));
	return result as Extract<ReturnType<typeof parseAlfredModelResponse>, { kind: T }>;
}

test("parses strict valid final speech JSON", () => {
	const result = assertKind(parseAlfredModelResponse('{"speech":"Done, sir.","displayText":"Done."}'), "final");
	assert.equal(result.value.speech, "Done, sir.");
	assert.equal(result.value.displayText, "Done.");
});

test("parses strict valid tool JSON", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"bash","command":"npm test","cwd":"/tmp/project"}'), "tool");
	assert.equal(result.value.tool, "bash");
	assert.equal(result.value.cwd, "/tmp/project");
});

test("parses inspect_session tool JSON", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"inspect_session","workspaceName":"Collectors Survey","tabHint":"local CI runs","lines":160}'), "tool");
	assert.equal(result.value.tool, "inspect_session");
	assert.equal(result.value.workspaceName, "Collectors Survey");
});

test("parses send_session_message tool JSON", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"send_session_message","workspaceName":"Collectors Survey","tabHint":"Pi chat","text":"On it.","mode":"draft"}'), "tool");
	assert.equal(result.value.tool, "send_session_message");
	assert.equal(result.value.text, "On it.");
	assert.equal(result.value.mode, "draft");
});

test("send_session_message requires a tab target", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"send_session_message","workspaceName":"Collectors Survey","text":"On it."}'), "retryable_error");
	assert.match(result.error, /tabHint or surfaceRef/);
});

test("parses start_session_monitor tool JSON", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"start_session_monitor","workspaceName":"Collectors Survey","tabHint":"Pi chat","goal":"watch for questions","replyMode":"draft","pollIntervalMs":5000,"maxTurns":3}'), "tool");
	assert.equal(result.value.tool, "start_session_monitor");
	assert.equal(result.value.goal, "watch for questions");
	assert.equal(result.value.replyMode, "draft");
});

test("start_session_monitor requires a goal and target", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"start_session_monitor","workspaceName":"Collectors Survey","goal":"watch"}'), "retryable_error");
	assert.match(result.error, /tabHint or surfaceRef/);
});

test("parses session monitor management tools", () => {
	assert.equal(assertKind(parseAlfredModelResponse('{"tool":"poll_session_monitor","monitorId":"monitor-1"}'), "tool").value.tool, "poll_session_monitor");
	assert.equal(assertKind(parseAlfredModelResponse('{"tool":"session_monitor_status"}'), "tool").value.tool, "session_monitor_status");
	assert.equal(assertKind(parseAlfredModelResponse('{"tool":"stop_session_monitor","monitorId":"monitor-1"}'), "tool").value.tool, "stop_session_monitor");
});

test("parses JSON inside fenced code block", () => {
	const result = assertKind(parseAlfredModelResponse('```json\n{"tool":"read_file","path":"package.json"}\n```'), "tool");
	assert.equal(result.value.tool, "read_file");
	assert.equal(result.diagnostics.codeFenceStripped, true);
});

test("strips DeepSeek think block before JSON", () => {
	const result = assertKind(parseAlfredModelResponse('<think>I should answer.</think>\n{"speech":"Certainly, sir."}'), "final");
	assert.equal(result.value.speech, "Certainly, sir.");
	assert.equal(result.diagnostics.thinkStripped, true);
});

test("extracts a balanced object with prose before and after", () => {
	const result = assertKind(parseAlfredModelResponse('Here is the JSON: {"speech":"Yes, sir."} That is all.'), "final");
	assert.equal(result.diagnostics.balancedExtractionUsed, true);
	assert.match(result.diagnostics.warnings.join("\n"), /before JSON/);
	assert.match(result.diagnostics.warnings.join("\n"), /after JSON/);
});

test("malformed JSON is retryable on first attempt", () => {
	const result = assertKind(parseAlfredModelResponse('{"speech":"oops"'), "retryable_error");
	assert.match(result.error, /malformed JSON/);
});

test("unknown tool is retryable on first attempt", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"teleport","target":"moon"}'), "retryable_error");
	assert.match(result.error, /unknown tool/);
});

test("schema-invalid JSON is retryable on first attempt", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"bash"}'), "retryable_error");
	assert.match(result.error, /command/);
});

test("remember rejects unsupported profile categories", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"remember","key":"theme","value":"dark","category":"knowledge"}'), "retryable_error");
	assert.match(result.error, /category must be preference, identity, context, or note/);
});

test("repeated parser failure is terminal graceful response", () => {
	const result = assertKind(parseAlfredModelResponse('{"tool":"bash"}', { retryCount: 1 }), "terminal_error");
	assert.match(result.finalResponse.speech, /couldn't parse/);
});

test("multiple top-level JSON objects are terminal and execute nothing", () => {
	const result = assertKind(parseAlfredModelResponse('{"speech":"one"} {"speech":"two"}'), "terminal_error");
	assert.match(result.error, /multiple/);
});

test("parser retry prompt includes registered tools and JSON-only instruction", () => {
	const prompt = buildParserRetryPrompt("unknown tool", ["bash", "read_file"]);
	assert.match(prompt, /Registered tools: bash, read_file/);
	assert.match(prompt, /exactly one JSON object/);
});
