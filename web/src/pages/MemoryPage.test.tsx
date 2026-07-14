import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeProfileFact, upsertProfileFact } from "../App";
import type { DashboardState, ProfileFact } from "../api/types";
import { MemoryPage } from "./MemoryPage";

const timestamp = "2026-07-14T10:00:00.000Z";
const profileFact: ProfileFact = {
  id: "profile-theme",
  kind: "profile",
  key: "theme",
  value: "estate",
  category: "preference",
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance: { source: "manual", sourceId: "dashboard", timestamp },
};

function dashboardState(): DashboardState {
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
    profileFacts: [profileFact],
    memoryTurns: 1,
    memory: {
      profile: { persistent: true, count: 1, records: [profileFact] },
      session: {
        ephemeral: true,
        count: 1,
        currentContextTokens: 42,
        cumulativeTotalTokens: 100,
        records: [{
          id: "session-turn",
          kind: "session",
          ephemeral: true,
          userText: "What changed?",
          finalSpeech: "The memory taxonomy, sir.",
          toolsUsed: ["read_file"],
          workspaceHint: "Alfred",
          shortOutcome: "Reviewed taxonomy.",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: { source: "conversation", requestId: "req-test", timestamp },
        }],
      },
      knowledge: { persistent: true, available: true, count: 0, sources: [] },
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

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("profile state reconciliation", () => {
  it("keeps canonical and compatibility profile projections synchronized", () => {
    const state = dashboardState();
    const added: ProfileFact = { ...profileFact, id: "profile-tone", key: "tone", value: "concise" };
    const withAdded = upsertProfileFact(state, added);
    expect(withAdded.memory.profile.count).toBe(2);
    expect(withAdded.profileFacts.map((fact) => fact.id)).toEqual(["profile-theme", "profile-tone"]);

    const withoutOriginal = removeProfileFact(withAdded, "profile-theme");
    expect(withoutOriginal.memory.profile.count).toBe(1);
    expect(withoutOriginal.memory.profile.records[0]?.id).toBe("profile-tone");
    expect(withoutOriginal.profileFacts[0]?.id).toBe("profile-tone");
  });
});

describe("MemoryPage", () => {
  it("supports accessible automatic tab activation with arrow, Home, and End keys", async () => {
    const user = userEvent.setup();
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} />);

    const profileTab = screen.getByRole("tab", { name: /Profile/ });
    const sessionTab = screen.getByRole("tab", { name: /Session/ });
    const knowledgeTab = screen.getByRole("tab", { name: /Knowledge/ });
    expect(profileTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /Profile/ })).toBeVisible();

    profileTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(sessionTab).toHaveFocus();
    expect(sessionTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /Session/ })).toBeVisible();

    await user.keyboard("{End}");
    expect(knowledgeTab).toHaveFocus();
    expect(knowledgeTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(profileTab).toHaveFocus();
    expect(profileTab).toHaveAttribute("aria-selected", "true");
  });

  it("retains form values when a memory write fails and marks required fields", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(false);
    render(<MemoryPage state={dashboardState()} onAdd={onAdd} onDelete={vi.fn()} />);

    const key = screen.getByLabelText("Key");
    const value = screen.getByLabelText("Value");
    expect(key).toBeRequired();
    expect(value).toBeRequired();
    await user.type(key, "response_style");
    await user.type(value, "Concise");
    await user.click(screen.getByRole("button", { name: "Remember" }));

    expect(onAdd).toHaveBeenCalledWith({ key: "response_style", value: "Concise", category: "preference" });
    expect(key).toHaveValue("response_style");
    expect(value).toHaveValue("Concise");
  });

  it("deletes profile memory by stable ID and prevents duplicate submission", async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("profile-theme");
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    resolveDelete?.();
  });

  it("uses valid definition-list semantics for session accounting", async () => {
    const user = userEvent.setup();
    const { container } = render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    expect(container.querySelector("dl.definition-list dt")?.textContent).toBe("Context");
    expect(container.querySelectorAll("dl.definition-list dd")).toHaveLength(2);
  });

  it("deletes and reindexes knowledge sources by stable ID", async () => {
    const user = userEvent.setup();
    const state = dashboardState();
    state.memory.knowledge = {
      persistent: true,
      available: true,
      count: 1,
      sources: [{
        id: "knowledge-source-1",
        kind: "knowledge",
        title: "Handbook",
        sourceType: "document",
        status: "indexed",
        chunkCount: 2,
        sizeBytes: 420,
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: { source: "import", timestamp },
      }],
    };
    const onDeleteKnowledge = vi.fn().mockResolvedValue(true);
    const onReindexKnowledge = vi.fn().mockResolvedValue(true);
    const onSearchKnowledge = vi.fn().mockResolvedValue([{ citationId: "knowledge:knowledge-source-1:chunk-1", sourceId: "knowledge-source-1", chunkId: "chunk-1", title: "Handbook", sourceType: "document", chunkIndex: 0, text: "Stale indexed passage.", score: 1 }]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={state} onAdd={vi.fn()} onDelete={vi.fn()} onDeleteKnowledge={onDeleteKnowledge} onReindexKnowledge={onReindexKnowledge} onSearchKnowledge={onSearchKnowledge} />);
    await user.click(screen.getByRole("tab", { name: /Knowledge/ }));
    await user.type(screen.getByLabelText("Search knowledge"), "indexed");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Stale indexed passage.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reindex Handbook" }));
    expect(onReindexKnowledge).toHaveBeenCalledWith("knowledge-source-1");
    expect(screen.queryByText("Stale indexed passage.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete Handbook" }));
    expect(onDeleteKnowledge).toHaveBeenCalledWith("knowledge-source-1");
  });

  it("imports pasted knowledge and searches lexical matches", async () => {
    const user = userEvent.setup();
    const onImportKnowledge = vi.fn().mockResolvedValue(true);
    const onSearchKnowledge = vi.fn().mockResolvedValue([{
      citationId: "knowledge:source-1:chunk-1",
      sourceId: "source-1",
      chunkId: "chunk-1",
      title: "Launch plan",
      sourceType: "document",
      chunkIndex: 0,
      text: "The amber readiness review happens Thursday.",
      score: 2.1,
    }]);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onImportKnowledge={onImportKnowledge} onSearchKnowledge={onSearchKnowledge} />);
    await user.click(screen.getByRole("tab", { name: /Knowledge/ }));
    await user.type(screen.getByLabelText("Title"), "Launch plan");
    await user.type(screen.getByLabelText("Content"), "The amber readiness review happens Thursday.");
    await user.click(screen.getByRole("button", { name: "Import and index" }));
    expect(onImportKnowledge).toHaveBeenCalledWith({ title: "Launch plan", content: "The amber readiness review happens Thursday.", sourceType: "document", location: undefined, mimeType: undefined });
    expect(screen.getByLabelText("Title")).toHaveValue("");

    await user.type(screen.getByLabelText("Search knowledge"), "amber readiness");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearchKnowledge).toHaveBeenCalledWith("amber readiness");
    expect(await screen.findByText("The amber readiness review happens Thursday.")).toBeVisible();
    expect(screen.getByText("knowledge:source-1:chunk-1")).toBeVisible();
    await user.type(screen.getByLabelText("Search knowledge"), " changed");
    expect(screen.queryByText("knowledge:source-1:chunk-1")).not.toBeInTheDocument();
  });
});
