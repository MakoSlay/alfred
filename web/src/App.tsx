import { useCallback, useEffect, useRef, useState } from "react";
import { alfredApi } from "./api/client";
import type { DashboardState, ProfileFact, ToolContract, TtsSettingsPatch } from "./api/types";
import { AppShell, type PageId } from "./components/AppShell";
import { MemoryPage } from "./pages/MemoryPage";
import { RadarPage } from "./pages/RadarPage";
import { SafetyPage } from "./pages/SafetyPage";
import { SettingsPage, type ThemeId } from "./pages/SettingsPage";
import { ToolsPage } from "./pages/ToolsPage";
import { VoicePage } from "./pages/VoicePage";
import { useAlfredEvents } from "./hooks/useAlfredEvents";

const PAGE_KEY = "alfred2-page";
const THEME_KEY = "alfred2-vibe";
const PAGE_IDS: PageId[] = ["radar", "voice", "memory", "safety", "tools", "settings"];
const THEME_IDS: ThemeId[] = ["estate", "cave", "concierge"];

function savedPage(): PageId {
  const value = localStorage.getItem(PAGE_KEY);
  if (value === "home") return "radar";
  if (value === "personality") return "settings";
  return PAGE_IDS.includes(value as PageId) ? value as PageId : "radar";
}

function savedTheme(): ThemeId {
  const value = localStorage.getItem(THEME_KEY);
  return THEME_IDS.includes(value as ThemeId) ? value as ThemeId : "estate";
}

export function upsertProfileFact(state: DashboardState, fact: ProfileFact): DashboardState {
  const exists = state.memory.profile.records.some((record) => record.id === fact.id);
  const records = exists
    ? state.memory.profile.records.map((record) => record.id === fact.id ? fact : record)
    : [...state.memory.profile.records, fact];
  return {
    ...state,
    profileFacts: records,
    memory: {
      ...state.memory,
      profile: { ...state.memory.profile, count: records.length, records },
    },
  };
}

export function removeProfileFact(state: DashboardState, id: string): DashboardState {
  const records = state.memory.profile.records.filter((record) => record.id !== id);
  return {
    ...state,
    profileFacts: records,
    memory: {
      ...state.memory,
      profile: { ...state.memory.profile, count: records.length, records },
    },
  };
}

export default function App() {
  const [page, setPage] = useState<PageId>(savedPage);
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [state, setState] = useState<DashboardState | null>(null);
  const [tools, setTools] = useState<ToolContract[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready for instruction.");
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [stateResult, toolsResult] = await Promise.allSettled([alfredApi.state(), alfredApi.tools()]);
    if (sequence !== refreshSequence.current) return;
    if (stateResult.status === "fulfilled") setState(stateResult.value);
    if (toolsResult.status === "fulfilled") setTools(toolsResult.value.contracts);

    const failures = [stateResult, toolsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    setError(failures.length ? `Dashboard data may be stale: ${failures.join(" · ")}` : null);
  }, []);

  const { connection, events, latestEvent } = useAlfredEvents(refresh);

  useEffect(() => {
    if (latestEvent?.type === "ask:done" || latestEvent?.type === "ask:error" || latestEvent?.type === "confirmation:created") void refresh();
  }, [latestEvent, refresh]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  function changePage(nextPage: PageId) {
    setPage(nextPage);
    localStorage.setItem(PAGE_KEY, nextPage);
  }

  async function runAction(action: () => Promise<string | void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setNotice(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function ask(text: string) {
    await runAction(async () => {
      const response = await alfredApi.ask(text);
      if (response.tools) setTools(response.tools);
      return response.displayText || response.speech || "Done.";
    });
  }

  async function addFact(fact: Pick<ProfileFact, "key" | "value" | "category">): Promise<boolean> {
    return runAction(async () => {
      const result = await alfredApi.addFact(fact);
      ++refreshSequence.current;
      setState((current) => current ? upsertProfileFact(current, result.fact) : current);
      return "Fact saved. A small miracle of administration.";
    });
  }

  async function deleteFact(id: string) {
    await runAction(async () => {
      await alfredApi.deleteFact(id);
      ++refreshSequence.current;
      setState((current) => current ? removeProfileFact(current, id) : current);
      return "Fact forgotten.";
    });
  }

  async function restoreUndo(id: string) {
    await runAction(async () => { const result = await alfredApi.restoreUndo(id); return `Restored ${result.originalPath}.`; });
  }

  async function clearUndo() {
    await runAction(async () => { const result = await alfredApi.clearUndo(); return `Cleared ${result.removed} undo entries.`; });
  }

  async function toggleAutoConfirm() {
    if (!state) return;
    await ask(state.autoConfirm ? "stop auto confirm" : "yes to all");
  }

  async function toggleMute(minutes: number) {
    if (!state) return;
    await runAction(async () => {
      if (state.muted) { await alfredApi.unmute(); return "Unmuted."; }
      await alfredApi.mute(minutes * 60_000);
      return `Muted for ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    });
  }

  async function saveTts(patch: TtsSettingsPatch): Promise<boolean> {
    return runAction(async () => { await alfredApi.updateTts(patch); return "Voice settings saved."; });
  }

  async function testTts(text: string, patch: TtsSettingsPatch): Promise<boolean> {
    return runAction(async () => {
      await alfredApi.updateTts(patch);
      const result = await alfredApi.testTts(text);
      return result.ok ? `Voice test played via ${result.tts.lastProvider ?? result.tts.provider}.` : result.error ?? "Voice test failed.";
    });
  }

  if (!state) {
    return <div className="loading-screen"><div className="brand__mark">A</div><h1>Alfred</h1><p>{error ?? "Preparing the console…"}</p><button className="button" onClick={() => void refresh()} type="button">Retry</button></div>;
  }

  let content;
  switch (page) {
    case "radar": content = <RadarPage busy={busy} events={events} onAsk={ask} state={state} />; break;
    case "voice": content = <VoicePage connection={connection} latestEvent={latestEvent} onSave={saveTts} onTest={testTts} settings={state.tts} />; break;
    case "memory": content = <MemoryPage onAdd={addFact} onDelete={deleteFact} state={state} />; break;
    case "safety": content = <SafetyPage onClear={clearUndo} onRestore={restoreUndo} onToggleAutoConfirm={toggleAutoConfirm} onToggleMute={toggleMute} state={state} />; break;
    case "tools": content = <ToolsPage events={events} onAskCapabilities={() => ask("what can you do?")} tools={tools} />; break;
    case "settings": content = <SettingsPage connection={connection} onThemeChange={setTheme} state={state} theme={theme} />; break;
  }

  return <AppShell notice={notice} onPageChange={changePage} onRefresh={() => void refresh()} page={page} state={state}>{error ? <div className="error-banner" role="alert">{error}</div> : null}{content}</AppShell>;
}
