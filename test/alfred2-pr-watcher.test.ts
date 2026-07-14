import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProactiveEventStore } from "../src/alfred-2/proactive/event-store.ts";
import type { RuntimeInterruptionState } from "../src/alfred-2/proactive/types.ts";
import { PrNotificationWatcher, formatPrWatchMemoryForContext, type PrWatcherExecFn } from "../src/alfred-2/watchers/pr-notifications.ts";

function runtime(now = new Date("2026-07-03T10:45:00Z")): RuntimeInterruptionState {
	return {
		muted: false,
		mutedUntil: null,
		meetingState: "not_in_meeting",
		microphoneState: "inactive",
		now,
	};
}

function execFake(): { exec: PrWatcherExecFn; calls: string[] } {
	const calls: string[] = [];
	const exec: PrWatcherExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (key === "gh api /user") {
			return { stdout: JSON.stringify({ login: "octo-user" }), stderr: "", exitCode: 0 };
		}
		if (key.startsWith("gh api -X GET /notifications")) {
			return {
				stdout: JSON.stringify([
					{
						id: "n1",
						reason: "comment",
						updated_at: "2026-07-03T10:40:00Z",
						subject: { type: "PullRequest", title: "Improve prompt journal", url: "https://api.github.com/repos/acme/alfred/pulls/7" },
						repository: { full_name: "acme/alfred" },
					},
					{
						id: "n2",
						reason: "review_requested",
						updated_at: "2026-07-03T10:41:00Z",
						subject: { type: "PullRequest", title: "Someone else's PR", url: "https://api.github.com/repos/acme/alfred/pulls/8" },
						repository: { full_name: "acme/alfred" },
					},
					{
						id: "n3",
						reason: "mention",
						updated_at: "2026-07-03T10:42:00Z",
						subject: { type: "Issue", title: "Not a PR", url: "https://api.github.com/repos/acme/alfred/issues/9" },
						repository: { full_name: "acme/alfred" },
					},
				]),
				stderr: "",
				exitCode: 0,
			};
		}
		if (key === "gh api /repos/acme/alfred/pulls/7") {
			return { stdout: JSON.stringify({ number: 7, title: "Improve prompt journal", html_url: "https://github.com/acme/alfred/pull/7", user: { login: "octo-user" } }), stderr: "", exitCode: 0 };
		}
		if (key === "gh api /repos/acme/alfred/pulls/8") {
			return { stdout: JSON.stringify({ number: 8, title: "Someone else's PR", html_url: "https://github.com/acme/alfred/pull/8", user: { login: "someone-else" } }), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected call: ${key}`, exitCode: 1 };
	};
	return { exec, calls };
}

test("PR watcher notifies for unread notifications on PRs authored by the user and writes simple memory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "alfred-pr-watch-"));
	try {
		const statePath = join(dir, "state.json");
		const memoryPath = join(dir, "memory.md");
		const notifications: string[] = [];
		const speeches: string[] = [];
		const { exec, calls } = execFake();
		const watcher = new PrNotificationWatcher({
			eventStore: new ProactiveEventStore(),
			exec,
			statePath,
			memoryPath,
			idFactory: () => "pr-watch-test",
			delivery: {
				notify: async (_title, body) => { notifications.push(body); },
				speak: async (text) => { speeches.push(text); return true; },
				isMuted: () => false,
			},
		});

		const first = await watcher.tick({ runtime: runtime() });
		assert.equal(first.length, 1);
		assert.equal(first[0]?.event.kind, "pr_notification");
		assert.equal(notifications.length, 1);
		assert.equal(speeches.length, 1);
		assert.match(speeches[0] ?? "", /unread GitHub notification from 2026-07-03/);
		assert.match(speeches[0] ?? "", /pull request 7/);

		const memory = readFileSync(memoryPath, "utf8");
		assert.match(memory, /Alfred surfaced 2026-07-03/);
		assert.match(memory, /GitHub notification updated 2026-07-03/);
		assert.match(memory, /PR #7 acme\/alfred: comment — Improve prompt journal — https:\/\/github.com\/acme\/alfred\/pull\/7/);
		assert.doesNotMatch(memory, /Someone else's PR/);
		assert.match(formatPrWatchMemoryForContext(memoryPath), /Note: line timestamps marked "Alfred surfaced"/);
		assert.match(formatPrWatchMemoryForContext(memoryPath), /GitHub notification updated 2026-07-03/);

		const second = await watcher.tick({ runtime: runtime(new Date("2026-07-03T10:46:00Z")) });
		assert.equal(second.length, 0, "same notification update should not be emitted twice");
		assert.equal(calls.filter((call) => call === "gh api /user").length, 1, "login is cached");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PR watcher context labels legacy bare timestamps as Alfred surfaced time", () => {
	const dir = mkdtempSync(join(tmpdir(), "alfred-pr-watch-context-"));
	try {
		const memoryPath = join(dir, "memory.md");
		writeFileSync(memoryPath, [
			"# PR Watch Memory",
			"",
			"- 2026-07-03 11:16 PR #2882 acme/alfred: mention — Old entry — https://github.com/acme/alfred/pull/2882",
			"",
		].join("\n"));
		const context = formatPrWatchMemoryForContext(memoryPath);
		assert.match(context, /Alfred surfaced 2026-07-03 11:16; GitHub notification updated unknown PR #2882/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
