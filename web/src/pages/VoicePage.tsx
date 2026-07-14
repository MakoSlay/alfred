import { useEffect, useState } from "react";
import type { AlfredEvent, AlfredEventsConnection, TtsSettings, TtsSettingsPatch } from "../api/types";
import { VoiceOverlay } from "../components/voice/VoiceOverlay";
import { useAlfredVoice } from "../hooks/useAlfredVoice";

export function VoicePage({ settings, onSave, onTest, latestEvent, connection }: {
  settings: TtsSettings;
  onSave: (patch: TtsSettingsPatch) => Promise<boolean>;
  onTest: (text: string, patch: TtsSettingsPatch) => Promise<boolean>;
  latestEvent: AlfredEvent | null;
  connection: AlfredEventsConnection;
}) {
  const [draft, setDraft] = useState<TtsSettings>(settings);
  const [testText, setTestText] = useState("Done. Voice systems are online.");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [dirty, setDirty] = useState(false);
  const voice = useAlfredVoice(latestEvent);
  useEffect(() => {
    if (!dirty) setDraft(settings);
  }, [dirty, settings]);

  function patch<K extends keyof TtsSettings>(key: K, value: TtsSettings[K]) {
    setDirty(true);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const payload: TtsSettingsPatch = {
    provider: draft.provider,
    fallbackProvider: draft.fallbackProvider,
    fishVoiceId: draft.fishVoiceId,
    fishModel: draft.fishModel,
    fishSpeed: draft.fishSpeed,
    edgeVoice: draft.edgeVoice,
    edgeRate: draft.edgeRate,
    macosVoice: draft.macosVoice,
    speechStyle: draft.speechStyle,
    witLevel: draft.witLevel,
    sarcasmLevel: draft.sarcasmLevel,
  };

  async function save() {
    setBusy("save");
    try {
      if (await onSave(payload)) setDirty(false);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      if (await onTest(testText.trim() || "Certainly, sir. Alfred voice systems are online.", payload)) setDirty(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-stack">
      <VoiceOverlay
        activeRequestId={voice.activeRequestId}
        audioElement={voice.audioElement}
        canApprove={voice.canApprove}
        error={voice.error}
        finalTranscript={voice.finalTranscript}
        interimTranscript={voice.interimTranscript}
        onApprove={voice.approve}
        onInterrupt={voice.interrupt}
        onStart={voice.startListening}
        phase={voice.phase}
        responseText={voice.responseText}
        supported={voice.supported}
      />
      <div className="voice-layout">
      <section className="panel voice-presence">
        <span className="eyebrow">Voice presence</span>
        <h2>{settings.lastProvider ?? settings.provider}</h2>
        <p>{settings.lastError ? `Last fallback: ${settings.lastError}` : `Voice system ready · events ${connection}.`}</p>
        <div className="voice-facts"><span>Fish key <strong className={settings.hasFishApiKey ? "good-text" : "bad-text"}>{settings.hasFishApiKey ? "Set" : "Missing"}</strong></span><span>Tone <strong>{settings.speechStyle}</strong></span></div>
      </section>
      <section className="panel section-panel">
        <div className="section-heading"><div><span className="eyebrow">Voice Studio</span><h2>Delivery settings</h2></div></div>
        <div className="form-grid">
          <label>Provider<select value={draft.provider} onChange={(event) => patch("provider", event.target.value as TtsSettings["provider"])}><option value="fish">Fish</option><option value="edge">Edge</option><option value="macos">macOS</option></select></label>
          <label>Fallback<select value={draft.fallbackProvider} onChange={(event) => patch("fallbackProvider", event.target.value as TtsSettings["fallbackProvider"])}><option value="edge">Edge</option><option value="macos">macOS</option><option value="none">None</option></select></label>
          <label>Tone<select value={draft.speechStyle} onChange={(event) => patch("speechStyle", event.target.value as TtsSettings["speechStyle"])}>{["auto", "neutral", "warm", "calm", "dry", "reassuring", "sarcastic"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Wit<select value={draft.witLevel} onChange={(event) => patch("witLevel", event.target.value as TtsSettings["witLevel"])}>{["off", "light", "medium"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Sarcasm<select value={draft.sarcasmLevel} onChange={(event) => patch("sarcasmLevel", event.target.value as TtsSettings["sarcasmLevel"])}>{["off", "light", "medium"].map((value) => <option key={value}>{value}</option>)}</select></label>
        </div>
        <details className="advanced"><summary>Advanced provider settings</summary><div className="form-grid">
          <label>Fish voice ID<input value={draft.fishVoiceId} onChange={(event) => patch("fishVoiceId", event.target.value)} /></label>
          <label>Fish model<input value={draft.fishModel} onChange={(event) => patch("fishModel", event.target.value)} /></label>
          <label>Fish speed<input min="0.5" max="2" step="0.05" type="number" value={draft.fishSpeed} onChange={(event) => patch("fishSpeed", Number(event.target.value))} /></label>
          <label>Edge voice<input value={draft.edgeVoice} onChange={(event) => patch("edgeVoice", event.target.value)} /></label>
          <label>Edge rate<input value={draft.edgeRate} onChange={(event) => patch("edgeRate", event.target.value)} /></label>
          <label>macOS voice<input value={draft.macosVoice} onChange={(event) => patch("macosVoice", event.target.value)} /></label>
        </div></details>
        <label className="test-phrase">Test phrase<input value={testText} onChange={(event) => setTestText(event.target.value)} /></label>
        <div className="button-row"><button className="button button--primary" disabled={busy !== null} onClick={() => void save()} type="button">{busy === "save" ? "Saving…" : "Save voice"}</button><button className="button" disabled={busy !== null} onClick={() => void test()} type="button">{busy === "test" ? "Speaking…" : "Test voice"}</button></div>
      </section>
      </div>
    </div>
  );
}
