import test from "node:test";
import assert from "node:assert/strict";
import { ALFRED_AUTONOMOUS_DEFAULTS, ALFRED_TOOL_NAMES, ALFRED_TOOL_PROMPT_SNIPPETS, DEFERRED_ALFRED_TOOLS, formatAlfredToolPrompt, isRegisteredToolName } from "../src/alfred-2/tool-types.ts";

test("tool registry contains first-phase tools and excludes deferred capabilities", () => {
	assert.deepEqual([...ALFRED_TOOL_NAMES], [
		"bash",
		"read_file",
		"write_file",
		"edit_file",
		"web_search",
		"fetch_content",
		"remember",
		"recall",
		"search_knowledge",
		"import_knowledge",
		"set_voice_settings",
		"refresh_context",
		"inspect_session",
		"send_session_message",
		"start_session_monitor",
		"poll_session_monitor",
		"session_monitor_status",
		"stop_session_monitor",
		"gmail_search",
		"gmail_read",
		"calendar_today",
		"calendar_upcoming",
		"docs_search",
		"docs_read",
		"log_break",
		"wellness_status",
	]);
	assert.ok(DEFERRED_ALFRED_TOOLS.includes("subagents"));
	assert.equal(isRegisteredToolName("bash"), true);
	assert.equal(isRegisteredToolName("subagents"), false);
});

test("tool prompt inventory is generated from the registered tool list", () => {
	const prompt = formatAlfredToolPrompt();
	for (const name of ALFRED_TOOL_NAMES) {
		assert.equal(typeof ALFRED_TOOL_PROMPT_SNIPPETS[name], "string");
		assert.match(prompt, new RegExp(`- ${name}:`));
	}
	assert.equal(Object.keys(ALFRED_TOOL_PROMPT_SNIPPETS).sort().join(","), [...ALFRED_TOOL_NAMES].sort().join(","));
});

test("autonomous defaults encode token, confirmation, web, and timeout decisions", () => {
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.sessionWarnTokens, 80_000);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.sessionHandoffTokens, 100_000);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.confirmationTtlMs, 300_000);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.destructiveConfirmationTtlMs, 60_000);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.webProvider, "exa");
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.webDefaultResults, 5);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.webMaxResults, 10);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.standardBashTimeoutMs, 30_000);
	assert.equal(ALFRED_AUTONOMOUS_DEFAULTS.testTimeoutMs, 300_000);
});
