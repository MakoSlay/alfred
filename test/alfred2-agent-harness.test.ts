import test from "node:test";
import assert from "node:assert/strict";
import { createAlfred2Agent, createFakeLlmClient, normalizeUsage, type LlmMessage } from "../src/alfred-2/agent.ts";

test("fake LLM sequence drives Alfred agent without network and preserves provider usage", async () => {
	const agent = createAlfred2Agent({
		endpoint: "https://example.invalid/v1",
		model: "fake-model",
		apiKey: "fake-key",
		llmClient: createFakeLlmClient([
			{ text: '{"speech":"Certainly, sir.","command":"echo hi"}', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, source: "provider" } },
		]),
	});

	const response = await agent.ask("say hi", "workspace summary");
	assert.equal(response.speech, "Certainly, sir.");
	assert.equal(response.command, "echo hi");
	assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17, source: "provider" });
});

test("agent estimates usage when fake LLM omits provider metadata", async () => {
	const agent = createAlfred2Agent({
		endpoint: "https://example.invalid/v1",
		model: "fake-model",
		apiKey: "fake-key",
		llmClient: createFakeLlmClient(['{"speech":"Done, sir."}']),
	});

	const response = await agent.ask("finish", "short context");
	assert.equal(response.speech, "Done, sir.");
	assert.equal(response.usage?.source, "estimate");
	assert.ok((response.usage?.totalTokens ?? 0) > 0);
});

test("normalizes partial provider usage conservatively", () => {
	const messages: LlmMessage[] = [{ role: "user", content: "hello" }];
	assert.deepEqual(normalizeUsage({ totalTokens: 99, source: "provider" }, messages, "hi"), {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 99,
		source: "provider",
	});
});
