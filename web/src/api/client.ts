import type {
  AskResponse,
  DashboardState,
  KnowledgeImportRequest,
  KnowledgeSearchResponse,
  KnowledgeSourceRecord,
  ProfileFact,
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
  deleteFact: (id: string) =>
    request<{ ok: true; removed: true; id: string }>(`/dashboard/facts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  importKnowledge: (input: KnowledgeImportRequest) =>
    request<{ ok: true; source: KnowledgeSourceRecord; created: boolean }>("/api/memory/knowledge/sources", jsonInit("POST", input)),
  deleteKnowledge: (id: string) =>
    request<{ ok: true; removed: true; id: string }>(`/api/memory/knowledge/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reindexKnowledge: (id: string) =>
    request<{ ok: true; source: KnowledgeSourceRecord }>(`/api/memory/knowledge/sources/${encodeURIComponent(id)}/reindex`, jsonInit("POST", {})),
  searchKnowledge: (query: string, limit = 5) =>
    request<KnowledgeSearchResponse>("/api/memory/knowledge/search", jsonInit("POST", { query, limit })),
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
