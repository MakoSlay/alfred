import test from "node:test";
import assert from "node:assert/strict";
import { createFakeLlmClient } from "../src/alfred-2/agent.ts";
import {
	dynamicSpeechFormatterMaxTokens,
	formatSpeechForTts,
	speechFormatterEnabledFromEnv,
	speechFormatterModeFromEnv,
	speechNeedsFormatter,
} from "../src/alfred-2/speech-formatter.ts";
import { setSpeechSuppressionProvider, speak, speechSilentModeFromEnv, waitForPausedSpeechAllowed } from "../src/alfred-2/speech.ts";


test("speech is silent by default under the node test runner", async () => {
	assert.equal(speechSilentModeFromEnv({ NODE_TEST_CONTEXT: "child-v8" }), true);
	assert.equal(speechSilentModeFromEnv({ ALFRED_SILENT_TESTS: "1" }), true);
	assert.equal(speechSilentModeFromEnv({ ALFRED_TEST_SPEECH: "1", NODE_TEST_CONTEXT: "child-v8" }), false);
	assert.equal(await speak("This must not play during tests."), false);
});

test("microphone speech suppression pauses until runtime allows speech", async () => {
	let micActive = true;
	setSpeechSuppressionProvider(() => micActive ? { suppressed: true, reason: "microphone_active", pause: true } : { suppressed: false });
	try {
		const waiting = waitForPausedSpeechAllowed({ maxMs: 200, pollMs: 5 });
		setTimeout(() => { micActive = false; }, 20);
		assert.equal(await waiting, true);
	} finally {
		setSpeechSuppressionProvider(null);
	}
});

test("runtime speech suppression blocks TTS before provider execution", async () => {
	setSpeechSuppressionProvider(() => true);
	try {
		assert.equal(await speak("This must not play."), false);
	} finally {
		setSpeechSuppressionProvider(null);
	}
});

test("speech formatter supports off, auto, and always modes from env", () => {
	assert.equal(speechFormatterModeFromEnv({}), "auto");
	assert.equal(speechFormatterModeFromEnv({ ALFRED_SPEECH_FORMATTER_ENABLED: "true" }), "always");
	assert.equal(speechFormatterModeFromEnv({ ALFRED_SPEECH_FORMATTER_ENABLED: "auto" }), "auto");
	assert.equal(speechFormatterModeFromEnv({ ALFRED_SPEECH_FORMATTER_ENABLED: "0" }), "off");
	assert.equal(speechFormatterEnabledFromEnv({ ALFRED_SPEECH_FORMATTER_ENABLED: "auto" }), true);
});

test("speech formatter auto mode only rewrites screen-like speech", async () => {
	const original = process.env.ALFRED_SPEECH_FORMATTER_ENABLED;
	try {
		process.env.ALFRED_SPEECH_FORMATTER_ENABLED = "auto";
		const simple = await formatSpeechForTts({
			llmClient: createFakeLlmClient([]),
			userText: "hello",
			speech: "Hello, sir.",
			displayText: "Hello, sir.",
		});
		assert.equal(simple.used, false);
		assert.equal(simple.speech, "Hello, sir.");
		assert.equal(speechNeedsFormatter("**PR #3079** — checks passing.", "PR #3079 — checks passing."), true);

		const autoFormatted = await formatSpeechForTts({
			llmClient: createFakeLlmClient(['{"speech":"Pull request three zero seven nine has checks passing, sir."}']),
			userText: "which PR?",
			speech: "**PR #3079** — checks passing.",
			displayText: "PR #3079 — checks passing.",
		});
		assert.equal(autoFormatted.used, true);
		assert.equal(autoFormatted.speech, "Pull request three zero seven nine has checks passing, sir.");
	} finally {
		if (original === undefined) delete process.env.ALFRED_SPEECH_FORMATTER_ENABLED;
		else process.env.ALFRED_SPEECH_FORMATTER_ENABLED = original;
	}
});

test("speech formatter rewrites speech with configured model", async () => {
	const result = await formatSpeechForTts({
		llmClient: createFakeLlmClient(['{"speech":"Pull request three zero seven nine looks closest to merge, sir."}']),
		userText: "which PR should I work on?",
		speech: "**PR #3079** — Add use_legacy_kpi_labels flag - checks passing.",
		displayText: "PR #3079 — Add use_legacy_kpi_labels flag — checks passing.",
		enabled: true,
		model: "deepseek-v4-flash",
	});
	assert.equal(result.used, true);
	assert.equal(result.model, "deepseek-v4-flash");
	assert.equal(result.speech, "Pull request three zero seven nine looks closest to merge, sir.");
	assert.equal(result.maxTokens >= 256, true);
});

test("speech formatter falls back to original speech on provider errors", async () => {
	const result = await formatSpeechForTts({
		llmClient: createFakeLlmClient([]),
		userText: "hello",
		speech: "Original speech, sir.",
		displayText: "Original speech, sir.",
		enabled: true,
	});
	assert.equal(result.used, false);
	assert.equal(result.speech, "Original speech, sir.");
	assert.match(result.error ?? "", /exhausted/);
});

test("dynamic speech formatter token budget scales with long screen text", () => {
	const shortBudget = dynamicSpeechFormatterMaxTokens("Done, sir.", "Done.", {});
	const longBudget = dynamicSpeechFormatterMaxTokens("Summary, sir.", "x".repeat(2400), {});
	assert.equal(shortBudget, 256);
	assert.equal(longBudget > shortBudget, true);
	assert.equal(longBudget <= 1200, true);
});
