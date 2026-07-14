import type {
  BaseMemoryRecord,
  KnowledgeSourceRecord,
  MemoryDashboardState,
  MemoryKind,
  MemoryProvenance,
  MemoryProvenanceSource,
  ProfileMemoryRecord,
  SessionMemoryRecord,
} from "../../../src/alfred-2/memory-types";

export type TtsProvider = "fish" | "edge" | "macos";
export type TtsFallbackProvider = "edge" | "macos" | "none";
export type SpeechStyle = "auto" | "neutral" | "warm" | "calm" | "dry" | "reassuring" | "sarcastic";
export type WitLevel = "off" | "light" | "medium";

export interface TtsSettings {
  provider: TtsProvider;
  fallbackProvider: TtsFallbackProvider;
  hasFishApiKey: boolean;
  fishVoiceId: string;
  fishModel: string;
  fishSpeed: number;
  edgeVoice: string;
  edgeRate: string;
  macosVoice: string;
  speechStyle: SpeechStyle;
  witLevel: WitLevel;
  sarcasmLevel: WitLevel;
  lastProvider: TtsProvider | null;
  lastError: string | null;
}

export type TtsSettingsPatch = Omit<Partial<TtsSettings>, "hasFishApiKey" | "lastProvider" | "lastError">;

export type {
  BaseMemoryRecord,
  KnowledgeSourceRecord,
  MemoryDashboardState,
  MemoryKind,
  MemoryProvenance,
  MemoryProvenanceSource,
  SessionMemoryRecord,
};

export type ProfileFact = ProfileMemoryRecord;
export type DashboardMemoryState = MemoryDashboardState;

export interface UndoEntry {
  id: string;
  originalPath: string;
  backupPath: string;
  timestamp: string;
  tool: string;
  preview: string;
}

export interface RecentResponse {
  requestId?: string;
  timestamp: string;
  userText: string;
  responseText: string;
  speech: string;
  displayText?: string;
  executed: boolean;
  command?: string;
  ok?: boolean;
}

export interface PersonalityConfig {
  identity: string;
  archetypes: string[];
  addressStyle: string;
  responseStyle: string[];
  spokenOutputContract: string[];
  screenOutputContract: string[];
  ttsStyleControls: string[];
}

export interface ListenerStatus {
  provider: "off" | "wispr" | "native";
  running: boolean;
  state: string;
  micActive: boolean;
  wakeWords: string[];
  lastWakeAt: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  detail?: string;
}

export interface DashboardState {
  ok: boolean;
  sessionId: string;
  muted: boolean;
  mutedUntil: string | null;
  autoConfirm: boolean;
  sessionTokens: number;
  currentContextTokens: number;
  maxContextTokens: number;
  toolRounds: number;
  pendingConfirmations: number;
  /** Compatibility projection; canonical records are in memory.profile.records. */
  profileFacts: ProfileFact[];
  /** Compatibility count; canonical session state is in memory.session. */
  memoryTurns: number;
  memory: DashboardMemoryState;
  undoCount: number;
  undoHistory: UndoEntry[];
  tools: { count: number; names: string[] };
  tts: TtsSettings;
  personality: PersonalityConfig;
  listener: ListenerStatus;
  prWatcher: { enabled: boolean; [key: string]: unknown };
  recentResponses: RecentResponse[];
  lastUpdated: string;
}

export interface ToolContract {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  examples: string[];
  confirm: "none" | "confirm" | "explicit" | "mixed";
}

export interface ToolsResponse {
  ok: boolean;
  count: number;
  names: string[];
  contracts: ToolContract[];
}

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

export type AlfredEventsConnection = "connecting" | "connected" | "disconnected";

export interface AskResponse {
  ok: boolean;
  requestId: string;
  sessionId: string;
  speech: string;
  displayText: string;
  command?: string;
  executed?: boolean;
  requiresConfirmation?: boolean;
  confirmationPrompt?: string;
  confirmationId?: string;
  tools?: ToolContract[];
}
