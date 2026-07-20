import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, ProfileFact } from "./api/types";

const api = vi.hoisted(() => ({
  state: vi.fn(),
  tools: vi.fn(),
  addFact: vi.fn(),
  updateFact: vi.fn(),
  deleteFact: vi.fn(),
  clearSessionMemory: vi.fn(),
  recallMemory: vi.fn(),
  importKnowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
  reindexKnowledge: vi.fn(),
  searchKnowledge: vi.fn(),
  ask: vi.fn(),
  updateAutonomy: vi.fn(),
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
    tools: { count: 26, names: [] },
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

describe("Autonomy controls", () => {
  it("uses the typed session posture API and keeps approvals and monitor authority visible", async () => {
    const user = userEvent.setup();
    const initial = state([]);
    initial.pendingConfirmations = 2;
    initial.sessionMonitors = [{
      id: "monitor-1",
      workspaceRef: "workspace:1",
      workspaceName: "Main",
      surfaceRef: "surface:1",
      surfaceTitle: "Pi chat",
      status: "running",
      replyMode: "send",
      turns: 1,
      maxTurns: 6,
      startedAt: timestamp,
      lastActivityAt: timestamp,
    }];
    api.state.mockResolvedValue(initial);
    api.updateAutonomy.mockResolvedValue({ ok: true, autoConfirm: true, scope: "session" });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Safety/ }));
    expect(screen.getByText("2 approvals")).toBeVisible();
    expect(screen.getByText("1 autonomous-send monitor")).toBeVisible();
    expect(screen.getByText("Autonomous send")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Auto-approve routine mutations" }));
    expect(api.updateAutonomy).toHaveBeenCalledWith(true);
    expect(api.ask).not.toHaveBeenCalled();
  });
});

describe("Memory lifecycle actions", () => {
  it("updates a profile fact through the revision-checked API", async () => {
    const user = userEvent.setup();
    const original = fact("profile-theme", "theme", "estate");
    const updated = { ...original, key: "visual_theme", value: "cave", updatedAt: "2026-07-14T10:05:00.000Z" };
    api.state.mockResolvedValueOnce(state([original])).mockResolvedValue(state([updated]));
    api.updateFact.mockResolvedValue({ ok: true, fact: updated });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Edit theme" }));
    await user.clear(screen.getByLabelText("Key"));
    await user.type(screen.getByLabelText("Key"), "visual_theme");
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "cave");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(api.updateFact).toHaveBeenCalledWith("profile-theme", { key: "visual_theme", value: "cave", category: "preference" }, timestamp);
    expect(await screen.findByText("cave")).toBeVisible();
  });

  it("returns profile deletion success to the page for local status and focus handling", async () => {
    const user = userEvent.setup();
    const original = fact("profile-theme", "theme", "estate");
    api.state.mockResolvedValueOnce(state([original])).mockResolvedValue(state([]));
    api.deleteFact.mockResolvedValue({ ok: true, removed: true, id: original.id });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Delete theme" }));
    expect(api.deleteFact).toHaveBeenCalledWith("profile-theme");
    expect(await screen.findByText(/Profile memory deleted/)).toBeVisible();
    expect(screen.getByLabelText("Filter profile facts")).toHaveFocus();
  });

  it("clears working-memory summaries while reporting retained history", async () => {
    const user = userEvent.setup();
    const initial = state([]);
    initial.memoryTurns = 1;
    initial.memory.session = {
      ephemeral: true, count: 1, currentContextTokens: 12, cumulativeTotalTokens: 42,
      records: [{ id: "session-1", kind: "session", ephemeral: true, userText: "hello", finalSpeech: "hello", toolsUsed: [], workspaceHint: "", shortOutcome: "answered", createdAt: timestamp, updatedAt: timestamp, provenance: { source: "conversation", timestamp } }],
    };
    const cleared = state([]);
    cleared.memory.session.currentContextTokens = 12;
    cleared.memory.session.cumulativeTotalTokens = 42;
    api.state.mockResolvedValueOnce(initial).mockResolvedValue(cleared);
    api.clearSessionMemory.mockResolvedValue({ ok: true, removed: 1, session: { count: 0, currentContextTokens: 12, cumulativeTotalTokens: 42 }, retained: ["activity history"] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: /Session/ }));
    await user.click(screen.getByRole("button", { name: "Clear working memory" }));
    expect(api.clearSessionMemory).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/durable activity history were retained/)).toBeVisible();
    expect(screen.getByText("42 cumulative tokens")).toBeVisible();
  });
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
