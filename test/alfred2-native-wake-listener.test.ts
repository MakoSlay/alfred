import test from "node:test";
import assert from "node:assert/strict";
import { createNativeWakeListener, type NativeWakeEngine, type NativeWakeEvent } from "../src/alfred-2/native-wake-listener.ts";

class FakeWakeEngine implements NativeWakeEngine {
	running = false;
	emit: ((event: NativeWakeEvent) => void) | null = null;
	async start(onEvent: (event: NativeWakeEvent) => void): Promise<void> {
		this.running = true;
		this.emit = onEvent;
	}
	stop(): void {
		this.running = false;
	}
	isRunning(): boolean {
		return this.running;
	}
	getDetail(): string {
		return "fake wake engine";
	}
}

test("native wake listener posts command text emitted by the wake engine", async () => {
	const engine = new FakeWakeEngine();
	const posts: Array<{ url: string; text: string; metadata: Record<string, unknown> }> = [];
	const listener = createNativeWakeListener({
		alfredUrl: "http://127.0.0.1:47321/ask",
		wakeWords: ["alfred"],
		dependencies: {
			wakeEngine: engine,
			postCommand: async (url, text, metadata) => {
				posts.push({ url, text, metadata });
			},
		},
	});

	await listener.start();
	engine.emit?.({ type: "command", text: "open Firefox" });
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(posts.length, 1);
	assert.equal(posts[0]?.url, "http://127.0.0.1:47321/ask");
	assert.equal(posts[0]?.text, "open Firefox");
	assert.equal(posts[0]?.metadata.source, "wake-transcript");
	const status = listener.getStatus();
	assert.equal(status.provider, "native");
	assert.equal(status.running, true);
	assert.equal(status.state, "wake_listening");
	assert.equal(status.micActive, true);
	assert.ok(status.lastWakeAt);
	assert.ok(status.lastCommandAt);
});

test("native wake listener can use a post-wake transcriber", async () => {
	const engine = new FakeWakeEngine();
	const posts: string[] = [];
	const listener = createNativeWakeListener({
		alfredUrl: "http://127.0.0.1:47321/ask",
		dependencies: {
			wakeEngine: engine,
			transcriber: {
				async recordAndTranscribe() {
					return "what needs my attention";
				},
			},
			postCommand: async (_url, text) => {
				posts.push(text);
			},
		},
	});

	await listener.start();
	engine.emit?.({ type: "wake" });
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(posts, ["what needs my attention"]);
});

test("native wake listener debounces repeated wake events", async () => {
	const engine = new FakeWakeEngine();
	const posts: string[] = [];
	const listener = createNativeWakeListener({
		alfredUrl: "http://127.0.0.1:47321/ask",
		debounceMs: 60_000,
		dependencies: {
			wakeEngine: engine,
			postCommand: async (_url, text) => {
				posts.push(text);
			},
		},
	});

	await listener.start();
	engine.emit?.({ type: "command", text: "first command" });
	engine.emit?.({ type: "command", text: "duplicate command" });
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(posts, ["first command"]);
});

test("native wake listener fails soft when no engine is configured", async () => {
	const listener = createNativeWakeListener({
		alfredUrl: "http://127.0.0.1:47321/ask",
	});

	await listener.start();
	const status = listener.getStatus();
	assert.equal(status.running, false);
	assert.equal(status.state, "error");
	assert.match(status.lastError ?? "", /requires ALFRED2_NATIVE_WAKE_COMMAND/);
});
