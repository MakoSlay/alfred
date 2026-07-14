import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizeSpeech, updateTtsSettings, type SpeechLifecycleEvent } from "../src/alfred-2/speech.ts";

test("synthesizeSpeech returns browser-playable Edge bytes without playing them", async () => {
	const directory = mkdtempSync(join(tmpdir(), "alfred-edge-test-"));
	const executable = join(directory, "edge-tts");
	writeFileSync(executable, "#!/bin/sh\nprintf 'ID3fake-mp3'\n", "utf8");
	chmodSync(executable, 0o755);
	const previousPath = process.env.EDGE_TTS_PATH;
	const events: SpeechLifecycleEvent[] = [];
	try {
		process.env.EDGE_TTS_PATH = executable;
		updateTtsSettings({ provider: "edge", fallbackProvider: "none" });
		const result = await synthesizeSpeech("Ready, sir.", { onEvent: (event) => events.push(event) });
		assert.equal(result.provider, "edge");
		assert.equal(result.contentType, "audio/mpeg");
		assert.equal(result.audio.toString("utf8"), "ID3fake-mp3");
		assert.deepEqual(events.map((event) => [event.type, event.provider]), [["start", "edge"], ["done", "edge"]]);
	} finally {
		if (previousPath === undefined) delete process.env.EDGE_TTS_PATH;
		else process.env.EDGE_TTS_PATH = previousPath;
		rmSync(directory, { recursive: true, force: true });
	}
});
