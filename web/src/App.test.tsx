import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, ProfileFact } from "./api/types";

const api = vi.hoisted(() => ({
  state: vi.fn(),
  tools: vi.fn(),
  addFact: vi.fn(),
  deleteFact: vi.fn(),
  ask: vi.fn(),
  restoreUndo: vi.fn(),
  clearUndo: vi.fn(),
  updateTts: vi.fn(),
  testTts: vi.fn(),
  mute: vi.fn(),
  unmute: vi.fn(),
}));

vi.mock("./api/client", () => ({ alfredApi: api }));
vi.mock("./hooks/useAlfredEvents", () => ({
  useAlfredEvents: () => ({ connection: "connected", events: [], latestEvent: null }),
}));

import App from "./App";

const timestamp = "2026-07-14T10:00:00.000Z";

function fact(id: string, key: string, value: string): ProfileFact {
  return {
    id,
    kind: "profile",
    key,
    value,
    category: "preference",
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: { source: "manual", timestamp },
  };
}

function state(records: ProfileFact[]): DashboardState {
  return {
    ok: true,
    sessionId: "session-test",
    muted: false,
    mutedUntil: null,
    autoConfirm: false,
    sessionTokens: 0,
    currentContextTokens: 0,
    maxContextTokens: 0,
    toolRounds: 0,
    pendingConfirmations: 0,
    profileFacts: records,
    memoryTurns: 0,
    memory: {
      profile: { persistent: true, count: records.length, records },
      session: { ephemeral: true, count: 0, records: [], currentContextTokens: 0, cumulativeTotalTokens: 0 },
      knowledge: { persistent: true, available: false, count: 0, sources: [] },
    },
    undoCount: 0,
    undoHistory: [],
    tools: { count: 24, names: [] },
    tts: {
      provider: "edge",
      fallbackProvider: "macos",
      hasFishApiKey: false,
      fishVoiceId: "",
      fishModel: "",
      fishSpeed: 1,
      edgeVoice: "en-GB-RyanNeural",
      edgeRate: "+0%",
      macosVoice: "Daniel",
      speechStyle: "auto",
      witLevel: "light",
      sarcasmLevel: "off",
      lastProvider: null,
      lastError: null,
    },
    personality: {
      identity: "Alfred",
      archetypes: [],
      addressStyle: "sir",
      responseStyle: [],
      spokenOutputContract: [],
      screenOutputContract: [],
      ttsStyleControls: [],
    },
    listener: {
      provider: "off",
      running: false,
      state: "off",
      micActive: false,
      wakeWords: [],
      lastWakeAt: null,
      lastCommandAt: null,
      lastError: null,
    },
    prWatcher: { enabled: false },
    recentResponses: [],
    lastUpdated: timestamp,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("alfred2-page", "memory");
  vi.clearAllMocks();
  api.tools.mockResolvedValue({ ok: true, count: 0, names: [], contracts: [] });
});

describe("App hydration ordering", () => {
  it("ignores an older dashboard response that resolves after a newer refresh", async () => {
    const user = userEvent.setup();
    const older = deferred<DashboardState>();
    const oldFact = fact("profile-old", "theme", "old");
    const newFact = fact("profile-new", "theme", "newest");
    api.state.mockImplementationOnce(() => older.promise).mockResolvedValueOnce(state([newFact]));

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("newest")).toBeVisible();

    older.resolve(state([oldFact]));
    await waitFor(() => expect(screen.getByText("newest")).toBeVisible());
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });

  it("does not let a pending pre-mutation refresh overwrite a successful local add", async () => {
    const user = userEvent.setup();
    const baseFact = fact("profile-theme", "theme", "estate");
    const addedFact = fact("profile-tone", "tone", "concise");
    const staleRefresh = deferred<DashboardState>();
    api.state
      .mockResolvedValueOnce(state([baseFact]))
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockResolvedValueOnce(state([baseFact, addedFact]));
    api.addFact.mockResolvedValue({ ok: true, fact: addedFact });

    render(<App />);
    expect(await screen.findByText("estate")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.type(screen.getByLabelText("Key"), "tone");
    await user.type(screen.getByLabelText("Value"), "concise");
    await user.click(screen.getByRole("button", { name: "Remember" }));
    expect(await screen.findByText("concise")).toBeVisible();

    staleRefresh.resolve(state([baseFact]));
    await waitFor(() => expect(screen.getByText("concise")).toBeVisible());
  });
});
