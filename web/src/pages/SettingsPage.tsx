import type { AlfredEventsConnection, DashboardState } from "../api/types";

function RuleList({ items }: { items: string[] }) {
  return <ol className="rule-list">{items.map((item) => <li key={item}>{item}</li>)}</ol>;
}

export type ThemeId = "estate" | "cave" | "concierge";

const THEMES: Array<{ id: ThemeId; label: string; detail: string }> = [
  { id: "estate", label: "Old-money butler", detail: "Graphite, brass, restrained" },
  { id: "cave", label: "Underground console", detail: "Sharp, tactical, quiet" },
  { id: "concierge", label: "Cyber concierge", detail: "Violet, teal, atmospheric" },
];

export function SettingsPage({ state, theme, onThemeChange, connection }: { state: DashboardState; theme: ThemeId; onThemeChange: (theme: ThemeId) => void; connection: AlfredEventsConnection }) {
  const listener = state.listener;
  return (
    <div className="page-stack">
      <section className="panel section-panel"><span className="eyebrow">Appearance</span><h2>Visual direction</h2><p>The final identity comes later; these existing trials remain available during migration.</p><div className="theme-grid">{THEMES.map((option) => <button aria-pressed={theme === option.id} className={theme === option.id ? "theme-option theme-option--active" : "theme-option"} key={option.id} onClick={() => onThemeChange(option.id)} type="button"><strong>{option.label}</strong><span>{option.detail}</span></button>)}</div></section>
      <section className="settings-grid">
        <article className="panel section-panel"><span className="eyebrow">Identity</span><h2>Butler profile</h2><p>{state.personality.identity}</p><div className="tag-row">{state.personality.archetypes.map((item) => <span className="tag" key={item}>{item}</span>)}</div><h3>Address style</h3><p>{state.personality.addressStyle}</p></article>
        <article className="panel section-panel"><span className="eyebrow">Runtime</span><h2>Local session</h2><dl className="definition-list"><div><dt>Session</dt><dd>{state.sessionId}</dd></div><div><dt>Listener</dt><dd>{listener.provider} · {listener.running ? listener.state.replaceAll("_", " ") : "stopped"}</dd></div><div><dt>Microphone</dt><dd>{listener.micActive ? "active" : "idle"}</dd></div><div><dt>Events</dt><dd>{connection}</dd></div><div><dt>PR watcher</dt><dd>{state.prWatcher.enabled ? "enabled" : "off"}</dd></div></dl>{listener.lastError ? <p className="error-text">{listener.lastError}</p> : <p>{listener.detail}</p>}</article>
      </section>
      <section className="settings-grid">
        <article className="panel section-panel"><span className="eyebrow">Response policy</span><h2>How Alfred answers</h2><RuleList items={state.personality.responseStyle} /></article>
        <article className="panel section-panel"><span className="eyebrow">Output policy</span><h2>Speech and screen</h2><h3>Spoken</h3><RuleList items={state.personality.spokenOutputContract} /><h3>On screen</h3><RuleList items={state.personality.screenOutputContract} /><h3>TTS controls</h3><RuleList items={state.personality.ttsStyleControls} /></article>
      </section>
    </div>
  );
}
