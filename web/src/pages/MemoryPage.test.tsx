import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("deletes profile memory by stable ID, announces the result, and restores focus", async () => {
    const user = userEvent.setup();
    let resolveDelete: ((removed: boolean) => void) | undefined;
    const onDelete = vi.fn(() => new Promise<boolean>((resolve) => { resolveDelete = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: "Delete theme" }));
    expect(onDelete).toHaveBeenCalledWith("profile-theme");
    expect(screen.getByRole("button", { name: "Delete theme" })).toBeDisabled();
    resolveDelete?.(true);
    expect(await screen.findByText(/Profile memory deleted/)).toBeVisible();
    expect(screen.getByLabelText("Filter profile facts")).toHaveFocus();
  });

  it("edits profile memory by stable ID, retains failed changes, and supports cancel", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(false);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onUpdate={onUpdate} />);

    const edit = screen.getByRole("button", { name: "Edit theme" });
    await user.click(edit);
    expect(screen.getByLabelText("Key")).toHaveValue("theme");
    expect(screen.getByLabelText("Value")).toHaveValue("estate");
    await user.clear(screen.getByLabelText("Key"));
    await user.type(screen.getByLabelText("Key"), "visual_theme");
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "cave");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onUpdate).toHaveBeenCalledWith("profile-theme", { key: "visual_theme", value: "cave", category: "preference" }, timestamp);
    expect(screen.getByLabelText("Key")).toHaveValue("visual_theme");
    await user.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.getByLabelText("Key")).toHaveValue("");
    expect(edit).toHaveFocus();
  });

  it("keeps the edit revision captured at open time across refreshes and deletion", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(true);
    const onUpdate = vi.fn().mockResolvedValue(false);
    const { rerender } = render(<MemoryPage state={dashboardState()} onAdd={onAdd} onDelete={vi.fn()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("button", { name: "Edit theme" }));
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "local edit");

    const refreshed = dashboardState();
    refreshed.memory.profile.records = [{ ...profileFact, value: "external edit", updatedAt: "2026-07-14T10:05:00.000Z" }];
    refreshed.profileFacts = refreshed.memory.profile.records;
    rerender(<MemoryPage state={refreshed} onAdd={onAdd} onDelete={vi.fn()} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onUpdate).toHaveBeenLastCalledWith("profile-theme", { key: "theme", value: "local edit", category: "preference" }, timestamp);

    const deleted = dashboardState();
    deleted.memory.profile = { persistent: true, count: 0, records: [] };
    deleted.profileFacts = [];
    rerender(<MemoryPage state={deleted} onAdd={onAdd} onDelete={vi.fn()} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onUpdate).toHaveBeenLastCalledWith("profile-theme", { key: "theme", value: "local edit", category: "preference" }, timestamp);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("clears session summaries with explicit retention copy", async () => {
    const user = userEvent.setup();
    const onClearSession = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onClearSession={onClearSession} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    await user.click(screen.getByRole("button", { name: "Clear working memory" }));
    expect(onClearSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Token accounting and durable activity history remain/)).toBeVisible();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/activity history, handoffs/));
  });

  it("shows full provenance identifiers and exact timestamps without hover", () => {
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} />);
    const profilePanel = screen.getByRole("tabpanel", { name: /Profile/ });
    expect(within(profilePanel).getByText("profile-theme")).toBeVisible();
    expect(screen.getByText("dashboard")).toBeVisible();
    expect(screen.getAllByText(timestamp).length).toBeGreaterThanOrEqual(3);
  });

  it("renders grouped unified recall and ignores stale responses", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: any) => void) | undefined;
    const first = new Promise<any>((resolve) => { resolveFirst = resolve; });
    const result = {
      query: "amber",
      kinds: ["profile", "session", "knowledge"] as const,
      limit: 5,
      total: 3,
      groups: {
        profile: [{ kind: "profile" as const, record: profileFact }],
        session: [{ kind: "session" as const, record: dashboardState().memory.session.records[0]! }],
        knowledge: [{
          kind: "knowledge" as const,
          record: { id: "knowledge-1", kind: "knowledge" as const, title: "Launch", sourceType: "document" as const, status: "indexed" as const, createdAt: timestamp, updatedAt: timestamp, indexedAt: timestamp, provenance: { source: "import" as const, timestamp } },
          citation: { citationId: "knowledge:knowledge-1:chunk-1", sourceId: "knowledge-1", chunkId: "chunk-1", title: "Launch", sourceType: "document" as const, chunkIndex: 0, text: "Amber launch notes.", score: 2 },
        }],
      },
      citations: [{ citationId: "knowledge:knowledge-1:chunk-1", sourceId: "knowledge-1", chunkId: "chunk-1", title: "Launch", sourceType: "document" as const, chunkIndex: 0, text: "Amber launch notes.", score: 2 }],
    };
    const onRecall = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(result);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onRecall={onRecall} />);
    const query = screen.getByLabelText("Query");
    await user.type(query, "old");
    await user.click(screen.getByRole("button", { name: "Recall" }));
    await user.clear(query);
    await user.type(query, "amber");
    await user.click(screen.getByRole("button", { name: "Recall" }));
    expect(await screen.findByText("Amber launch notes.")).toBeVisible();
    expect(screen.getByText("knowledge:knowledge-1:chunk-1")).toBeVisible();
    resolveFirst?.({ ...result, total: 0, groups: { profile: [], session: [], knowledge: [] }, citations: [] });
    await Promise.resolve();
    expect(screen.getByText(/Found 3 grouped memory results/)).toBeVisible();
  });

  it("invalidates pending recall when memory-kind filters change", async () => {
    const user = userEvent.setup();
    let resolveRecall: ((value: any) => void) | undefined;
    const pending = new Promise<any>((resolve) => { resolveRecall = resolve; });
    const onRecall = vi.fn().mockReturnValue(pending);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onRecall={onRecall} />);
    await user.type(screen.getByLabelText("Query"), "amber");
    await user.click(screen.getByRole("button", { name: "Recall" }));
    await user.click(screen.getByLabelText("Knowledge"));
    resolveRecall?.({ query: "amber", kinds: ["knowledge"], limit: 5, total: 1, groups: { profile: [], session: [], knowledge: [{ kind: "knowledge", record: { id: "knowledge-1", kind: "knowledge", title: "Launch", sourceType: "document", status: "indexed", createdAt: timestamp, updatedAt: timestamp, provenance: { source: "import", timestamp } }, citation: { citationId: "knowledge:1", sourceId: "knowledge-1", chunkId: "chunk-1", title: "Launch", sourceType: "document", chunkIndex: 0, text: "stale result", score: 1 } }] }, citations: [] });
    await Promise.resolve();
    expect(screen.queryByText("stale result")).not.toBeInTheDocument();
    expect(screen.getByText(/Memory-kind selection changed/)).toBeVisible();
  });

  it("extracts only explicitly selected user requests and keeps candidates ephemeral", async () => {
    const user = userEvent.setup();
    const state = dashboardState();
    state.memory.session.records.push({ ...state.memory.session.records[0]!, id: "session-other", userText: "My name is Unselected", provenance: { source: "conversation", requestId: "req-other", turnId: "turn-other", timestamp } });
    state.memory.session.count = 2;
    const onExtractCandidates = vi.fn().mockResolvedValue({
      batchId: "candidate-batch-1", requestId: "review-1", sessionId: state.sessionId, ephemeral: true, createdAt: timestamp, expiresAt: "2026-07-14T10:15:00.000Z", excluded: [],
      candidates: [{ id: "candidate-1", batchId: "candidate-batch-1", reviewRequestId: "review-1", ephemeral: true, key: "preference_concise_updates", value: "concise updates", category: "preference", source: { sessionId: state.sessionId, sessionRecordId: "session-turn", requestId: "req-test", timestamp, userText: "What changed?" } }],
    });
    render(<MemoryPage state={state} onAdd={vi.fn()} onDelete={vi.fn()} onExtractCandidates={onExtractCandidates} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    expect(screen.getByRole("button", { name: "Extract candidates" })).toBeDisabled();
    expect(screen.getByText(/reads only the selected user requests—not responses, tools, Knowledge, history, handoffs, or files/)).toBeVisible();
    await user.click(screen.getByLabelText("Select request: What changed?"));
    await user.click(screen.getByRole("button", { name: "Extract candidates" }));
    expect(onExtractCandidates).toHaveBeenCalledWith(["session-turn"]);
    expect(await screen.findByDisplayValue("concise updates")).toBeVisible();
    expect(screen.getByText(/Nothing is durable until you accept it/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /accept all/i })).not.toBeInTheDocument();
  });

  it("requires independent accept, edit, and reject decisions and blocks existing-key replacement", async () => {
    const user = userEvent.setup();
    const onExtractCandidates = vi.fn().mockResolvedValue({
      batchId: "candidate-batch-1", requestId: "review-1", sessionId: "session-test", ephemeral: true, createdAt: timestamp, expiresAt: "2026-07-14T10:15:00.000Z", excluded: [],
      candidates: [
        { id: "candidate-new", batchId: "candidate-batch-1", reviewRequestId: "review-1", ephemeral: true, key: "preferred_updates", value: "concise", category: "preference", source: { sessionId: "session-test", sessionRecordId: "session-turn", timestamp, userText: "What changed?" } },
        { id: "candidate-conflict", batchId: "candidate-batch-1", reviewRequestId: "review-1", ephemeral: true, key: "theme", value: "cave", category: "preference", source: { sessionId: "session-test", sessionRecordId: "session-turn", timestamp, userText: "What changed?" }, conflict: { type: "existing_key", record: profileFact } },
      ],
    });
    const onAcceptCandidate = vi.fn().mockResolvedValue(true);
    const onRejectCandidate = vi.fn().mockResolvedValue(true);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onExtractCandidates={onExtractCandidates} onAcceptCandidate={onAcceptCandidate} onRejectCandidate={onRejectCandidate} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    await user.click(screen.getByLabelText("Select request: What changed?"));
    await user.click(screen.getByRole("button", { name: "Extract candidates" }));
    const keyInputs = await screen.findAllByLabelText("Candidate key");
    await user.clear(keyInputs[0]!);
    await user.type(keyInputs[0]!, "preferred_status_updates");
    await user.click(screen.getAllByRole("button", { name: "Accept and save" })[0]!);
    expect(onAcceptCandidate).toHaveBeenCalledWith("candidate-batch-1", "candidate-new", { key: "preferred_status_updates", value: "concise", category: "preference" });
    expect(await screen.findByText(/Reviewed candidate saved/)).toBeVisible();

    const conflictAccept = screen.getByRole("button", { name: "Accept and save" });
    expect(conflictAccept).toBeDisabled();
    const remainingKey = screen.getByLabelText("Candidate key");
    await user.clear(remainingKey);
    await user.type(remainingKey, "preferred_visual_theme");
    expect(conflictAccept).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onRejectCandidate).toHaveBeenCalledWith("candidate-batch-1", "candidate-conflict");
    expect(onAcceptCandidate).toHaveBeenCalledTimes(1);
  });

  it("clears unaccepted candidates with session memory and does not let auto-confirm change review", async () => {
    const user = userEvent.setup();
    const state = dashboardState();
    state.autoConfirm = true;
    const onExtractCandidates = vi.fn().mockResolvedValue({
      batchId: "candidate-batch-1", requestId: "review-1", sessionId: state.sessionId, ephemeral: true, createdAt: timestamp, expiresAt: "2026-07-14T10:15:00.000Z", excluded: [],
      candidates: [{ id: "candidate-1", batchId: "candidate-batch-1", reviewRequestId: "review-1", ephemeral: true, key: "preferred_updates", value: "concise", category: "preference", source: { sessionId: state.sessionId, sessionRecordId: "session-turn", timestamp, userText: "What changed?" } }],
    });
    const onAcceptCandidate = vi.fn();
    const onClearSession = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={state} onAdd={vi.fn()} onDelete={vi.fn()} onClearSession={onClearSession} onExtractCandidates={onExtractCandidates} onAcceptCandidate={onAcceptCandidate} onRejectCandidate={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    await user.click(screen.getByLabelText("Select request: What changed?"));
    await user.click(screen.getByRole("button", { name: "Extract candidates" }));
    expect(await screen.findByRole("button", { name: "Accept and save" })).toBeEnabled();
    expect(onAcceptCandidate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear working memory" }));
    expect(screen.queryByRole("button", { name: "Accept and save" })).not.toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/unaccepted memory candidates/));
  });

  it("ignores an extraction response that resolves after session clearing", async () => {
    const user = userEvent.setup();
    let resolveExtraction!: (batch: any) => void;
    const pendingExtraction = new Promise<any>((resolve) => { resolveExtraction = resolve; });
    const onExtractCandidates = vi.fn().mockReturnValue(pendingExtraction);
    const onClearSession = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} onClearSession={onClearSession} onExtractCandidates={onExtractCandidates} onAcceptCandidate={vi.fn()} onRejectCandidate={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    await user.click(screen.getByLabelText("Select request: What changed?"));
    await user.click(screen.getByRole("button", { name: "Extract candidates" }));
    await user.click(screen.getByRole("button", { name: "Clear working memory" }));
    resolveExtraction({ batchId: "candidate-batch-stale", requestId: "review-stale", sessionId: "session-test", ephemeral: true, createdAt: timestamp, expiresAt: "2026-07-14T10:15:00.000Z", excluded: [], candidates: [{ id: "candidate-stale", batchId: "candidate-batch-stale", reviewRequestId: "review-stale", ephemeral: true, key: "preferred_updates", value: "concise", category: "preference", source: { sessionId: "session-test", sessionRecordId: "session-turn", timestamp, userText: "What changed?" } }] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept and save" })).not.toBeInTheDocument());
    expect(screen.getByText(/unaccepted candidates were cleared/)).toBeVisible();
  });

  it("uses valid definition-list semantics for session accounting", async () => {
    const user = userEvent.setup();
    render(<MemoryPage state={dashboardState()} onAdd={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /Session/ }));
    const panel = screen.getByRole("tabpanel", { name: /Session/ });
    const accounting = panel.querySelector("dl.definition-list");
    expect(accounting?.querySelector("dt")?.textContent).toBe("Context");
    expect(accounting?.querySelectorAll("dd")).toHaveLength(2);
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
