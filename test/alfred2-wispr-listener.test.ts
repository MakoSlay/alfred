import test from "node:test";
import assert from "node:assert/strict";
import { extractWakeCommand, stripWakeWord } from "../src/alfred-2/wispr-listener.ts";

test("stripWakeWord accepts Alfred wake phrase with punctuation", () => {
	assert.equal(stripWakeWord("Alfred open Firefox"), "open Firefox");
	assert.equal(stripWakeWord("Alfred, open Firefox"), "open Firefox");
	assert.equal(stripWakeWord("hey Alfred: what's happening in sandbox?"), "what's happening in sandbox?");
	assert.equal(stripWakeWord("ok Alfred - mute for 30 minutes"), "mute for 30 minutes");
});

test("stripWakeWord ignores non-wake text and empty commands", () => {
	assert.equal(stripWakeWord("Tell me about Alfred Nobel"), null);
	assert.equal(stripWakeWord("Alfred"), null);
	assert.equal(stripWakeWord("Hey Alfred,"), null);
});

test("extractWakeCommand gates on raw ASR and prefers formatted text", () => {
	assert.equal(extractWakeCommand({
		asrText: "alfred open firefox",
		formattedText: "Alfred, open Firefox.",
		editedText: null,
	}), "open Firefox.");

	assert.equal(extractWakeCommand({
		asrText: "open firefox",
		formattedText: "Alfred, open Firefox.",
		editedText: null,
	}), null);
});
