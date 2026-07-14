import { useEffect, useRef, useState } from "react";
import type { AlfredEvent, AlfredEventsConnection } from "../api/types";

const EVENT_TYPES: AlfredEvent["type"][] = [
  "ask:start",
  "ask:done",
  "ask:error",
  "tool:start",
  "tool:done",
  "confirmation:created",
  "speech:start",
  "speech:done",
  "speech:error",
];

export function useAlfredEvents(onReconnect?: () => void | Promise<void>) {
  const [connection, setConnection] = useState<AlfredEventsConnection>("connecting");
  const [events, setEvents] = useState<AlfredEvent[]>([]);
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  useEffect(() => {
    const source = new EventSource("/api/events");
    const listeners = new Map<string, EventListener>();

    source.onopen = () => {
      setConnection("connected");
      void reconnectRef.current?.();
    };
    source.onerror = () => setConnection(source.readyState === EventSource.CONNECTING ? "connecting" : "disconnected");

    for (const type of EVENT_TYPES) {
      const listener: EventListener = (rawEvent) => {
        if (!(rawEvent instanceof MessageEvent)) return;
        const event = parseEvent(rawEvent.data, type);
        if (!event) return;
        setEvents((current) => [...current.slice(-49), event]);
      };
      source.addEventListener(type, listener);
      listeners.set(type, listener);
    }

    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }, []);

  return { connection, events, latestEvent: events.at(-1) ?? null };
}

function parseEvent(raw: unknown, expectedType: AlfredEvent["type"]): AlfredEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type !== expectedType || typeof value.requestId !== "string" || !value.requestId) return null;
    switch (expectedType) {
      case "ask:start": return typeof value.text === "string" ? value as unknown as AlfredEvent : null;
      case "ask:done": return typeof value.displayText === "string" ? value as unknown as AlfredEvent : null;
      case "ask:error": return typeof value.message === "string" ? value as unknown as AlfredEvent : null;
      case "tool:start": return typeof value.tool === "string" ? value as unknown as AlfredEvent : null;
      case "tool:done": return typeof value.tool === "string" && typeof value.ok === "boolean" ? value as unknown as AlfredEvent : null;
      case "confirmation:created": return typeof value.count === "number" ? value as unknown as AlfredEvent : null;
      case "speech:start":
      case "speech:done": return typeof value.provider === "string" ? value as unknown as AlfredEvent : null;
      case "speech:error": return typeof value.provider === "string" && typeof value.message === "string" ? value as unknown as AlfredEvent : null;
    }
  } catch {
    return null;
  }
}
