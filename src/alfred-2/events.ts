import type { ServerResponse } from "node:http";

export type AlfredEvent =
	| { type: "ask:start"; requestId: string; text: string }
	| { type: "ask:done"; requestId: string; displayText: string }
	| { type: "ask:error"; requestId: string; message: string }
	| { type: "tool:start"; requestId: string; tool: string }
	| { type: "tool:done"; requestId: string; tool: string; ok: boolean }
	| { type: "confirmation:created"; requestId: string; count: number }
	| { type: "speech:start"; requestId: string; provider: string }
	| { type: "speech:done"; requestId: string; provider: string }
	| { type: "speech:error"; requestId: string; provider: string; message: string };

export interface AlfredEventBus {
	subscribe(res: ServerResponse): void;
	publish(event: AlfredEvent): void;
	close(): void;
	readonly subscriberCount: number;
}

export function createAlfredEventBus(options: { heartbeatMs?: number } = {}): AlfredEventBus {
	const subscribers = new Set<ServerResponse>();
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const heartbeat = setInterval(() => {
		for (const response of subscribers) write(response, ": heartbeat\n\n");
	}, heartbeatMs);
	heartbeat.unref();

	return {
		subscribe(response) {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders?.();
		subscribers.add(response);
		write(response, ": connected\n\n");
		response.once("close", () => subscribers.delete(response));
	},
	publish(event) {
		const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
		for (const response of subscribers) write(response, payload);
	},
	close() {
		clearInterval(heartbeat);
		for (const response of subscribers) response.end();
		subscribers.clear();
	},
	get subscriberCount() {
		return subscribers.size;
	},
	};
}

function write(response: ServerResponse, chunk: string): void {
	if (response.destroyed || response.writableEnded) return;
	try {
		response.write(chunk);
	} catch {
		// A close event removes disconnected subscribers; writes are best-effort.
	}
}
