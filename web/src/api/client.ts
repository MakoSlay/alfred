import type {
  AskResponse,
  AutonomySettingsResponse,
  DashboardState,
  KnowledgeImportRequest,
  KnowledgeSearchResponse,
  KnowledgeSourceRecord,
  MemoryCandidateBatch,
  MemoryKind,
  MemoryRecallResponse,
  NoteContent,
  NotesResponse,
  ProfileFact,
  ReviewedMemoryCandidate,
  ToolsResponse,
  TtsSettings,
  TtsSettingsPatch,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : response.statusText || "Request failed";
    throw new Error(message);
  }
  return body as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const alfredApi = {
  state: () => request<DashboardState>("/dashboard/state"),
  updateAutonomy: (autoConfirm: boolean) => request<AutonomySettingsResponse>("/api/settings/autonomy", jsonInit("PUT", { autoConfirm })),
  tools: () => request<ToolsResponse>("/tools"),
  ask: (text: string, requestId: string = crypto.randomUUID(), options: {
    signal?: AbortSignal;
    playback?: "browser" | "server";
    confirm?: boolean;
    confirmationId?: string;
  } = {}) => request<AskResponse>("/ask", {
    ...jsonInit("POST", {
      text,
      requestId,
      playback: options.playback ?? "server",
      confirm: options.confirm,
      confirmationId: options.confirmationId,
    }),
    signal: options.signal,
  }),
  addFact: (fact: Pick<ProfileFact, "key" | "value" | "category">) =>
    request<{ ok: true; fact: ProfileFact }>("/dashboard/facts", jsonInit("POST", fact)),
  updateFact: (id: string, patch: Pick<ProfileFact, "key" | "value" | "category">, expectedUpdatedAt: string) =>
    request<{ ok: true; fact: ProfileFact }>(`/api/memory/profile/${encodeURIComponent(id)}`, jsonInit("PATCH", { ...patch, expectedUpdatedAt })),
  deleteFact: (id: string) =>
    request<{ ok: true; removed: true; id: string }>(`/api/memory/profile/${encodeURIComponent(id)}`, { method: "DELETE" }),
  clearSessionMemory: () =>
    request<{ ok: true; removed: number; removedCandidates: number; session: { count: number; currentContextTokens: number; cumulativeTotalTokens: number }; retained: string[] }>("/api/memory/session", { method: "DELETE" }),
  recallMemory: (query: string, kinds: MemoryKind[], limit = 5) =>
    request<MemoryRecallResponse & { ok: true }>("/api/memory/recall", jsonInit("POST", { query, kinds, limit })),
  extractMemoryCandidates: (turnIds: string[], requestId = crypto.randomUUID()) =>
    request<MemoryCandidateBatch & { ok: true }>("/api/memory/candidates/extract", jsonInit("POST", { requestId, turnIds })),
  acceptMemoryCandidate: (batchId: string, candidateId: string, write: Pick<ReviewedMemoryCandidate, "key" | "value" | "category">) =>
    request<{ ok: true; fact: ProfileFact; batchId: string; candidateId: string }>(`/api/memory/candidates/${encodeURIComponent(batchId)}/${encodeURIComponent(candidateId)}/accept`, jsonInit("POST", write)),
  rejectMemoryCandidate: (batchId: string, candidateId: string) =>
    request<{ ok: true; rejected: true; batchId: string; candidateId: string }>(`/api/memory/candidates/${encodeURIComponent(batchId)}/${encodeURIComponent(candidateId)}/reject`, jsonInit("POST", {})),
  importKnowledge: (input: KnowledgeImportRequest) =>
    request<{ ok: true; source: KnowledgeSourceRecord; created: boolean }>("/api/memory/knowledge/sources", jsonInit("POST", input)),
  deleteKnowledge: (id: string) =>
    request<{ ok: true; removed: true; id: string }>(`/api/memory/knowledge/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reindexKnowledge: (id: string) =>
    request<{ ok: true; source: KnowledgeSourceRecord }>(`/api/memory/knowledge/sources/${encodeURIComponent(id)}/reindex`, jsonInit("POST", {})),
  searchKnowledge: (query: string, limit = 5) =>
    request<KnowledgeSearchResponse>("/api/memory/knowledge/search", jsonInit("POST", { query, limit })),
  notes: () => request<NotesResponse>("/api/notes"),
  readNote: (filename: string) => request<NoteContent>(`/api/notes/${encodeURIComponent(filename)}`),
  openNote: (filename?: string) => request<{ ok: true; path: string; filename?: string; kind: "note" | "folder" }>("/api/notes/open", jsonInit("POST", filename ? { filename } : {})),
  restoreUndo: (id: string) =>
    request<{ ok: true; originalPath: string }>(`/dashboard/undo/${encodeURIComponent(id)}`, { method: "POST" }),
  clearUndo: () => request<{ ok: true; removed: number }>("/dashboard/undo", { method: "DELETE" }),
  updateTts: (settings: TtsSettingsPatch) =>
    request<{ ok: true; tts: TtsSettings }>("/dashboard/tts", jsonInit("POST", settings)),
  testTts: (text: string) =>
    request<{ ok: boolean; tts: TtsSettings; error?: string }>("/dashboard/tts/test", jsonInit("POST", { text })),
  mute: (durationMs: number) => request<{ ok: true }>("/mute", jsonInit("POST", { durationMs })),
  unmute: () => request<{ ok: true }>("/unmute", { method: "POST" }),
  voiceSettings: () => request<{ ok: true; tts: TtsSettings }>("/api/voice/settings"),
  updateVoiceSettings: (settings: TtsSettingsPatch) =>
    request<{ ok: true; tts: TtsSettings }>("/api/voice/settings", jsonInit("POST", settings)),
  synthesizeVoice: async (text: string, requestId: string, signal?: AbortSignal) => {
    const response = await fetch("/api/voice/synthesize", {
      ...jsonInit("POST", { text, requestId }),
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? response.statusText ?? "Speech synthesis failed");
    }
    return {
      audio: await response.blob(),
      provider: response.headers.get("X-Alfred-TTS-Provider") ?? "unknown",
    };
  },
  stopVoice: () => request<{ ok: true }>("/api/voice/stop", { method: "POST" }),
};
