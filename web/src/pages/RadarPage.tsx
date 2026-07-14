import type { AlfredEvent, DashboardState } from "../api/types";
import { AlfredWaveform } from "../components/AlfredWaveform";
import { CommandBox } from "../components/CommandBox";

const QUICK_PROMPTS = [
  "what needs my attention right now?",
  "what can you do?",
  "refresh context and summarize current state",
  "inspect this session and summarize recent tool activity",
];

export function RadarPage({ state, busy, onAsk, events }: {
  state: DashboardState;
  busy: boolean;
  onAsk: (text: string) => Promise<void>;
  events: AlfredEvent[];
}) {
  const stats = [
    [state.pendingConfirmations, "Pending approvals"],
    [state.tools.count, "Tools available"],
    [state.undoCount, "Undo snapshots"],
    [state.profileFacts.length, "Profile facts"],
    [state.currentContextTokens.toLocaleString(), "Current context"],
    [state.sessionTokens.toLocaleString(), "Session tokens"],
    [state.toolRounds, "Tool rounds"],
  ] as const;

  return (
    <div className="page-stack">
      <section className="hero panel">
        <div className="hero__copy">
          <span className="eyebrow">Work radar</span>
          <h2>Good evening. Shall we make ourselves useful?</h2>
          <p>Talk first; inspect second. Alfred keeps the important state close without turning the opening screen into a junk drawer.</p>
          <CommandBox busy={busy} onSubmit={onAsk} />
          <div className="quick-prompts">
            {QUICK_PROMPTS.map((prompt) => <button disabled={busy} key={prompt} onClick={() => void onAsk(prompt)} type="button">{prompt}</button>)}
          </div>
        </div>
        <div className="hero__presence"><div className="wave-orb"><AlfredWaveform /></div></div>
      </section>

      <section className="metric-grid" aria-label="Session metrics">
        {stats.map(([value, label]) => <article className="metric panel" key={label}><strong>{value}</strong><span>{label}</span></article>)}
      </section>

      <section className="panel section-panel">
        <div className="section-heading"><div><span className="eyebrow">Live</span><h2>Current activity</h2></div><span className="count-badge">{events.length}</span></div>
        <div className="live-activity" aria-live="polite">{events.length === 0 ? <p className="empty-state">Waiting for live activity.</p> : events.slice(-6).reverse().map((event, index) => <div key={`${event.requestId}-${event.type}-${index}`}><span>{event.type.replace(":", " ")}</span><code>{event.requestId}</code></div>)}</div>
      </section>

      <section className="panel section-panel">
        <div className="section-heading"><div><span className="eyebrow">Recall</span><h2>Recent responses</h2></div><span className="count-badge">{state.recentResponses.length}</span></div>
        <div className="response-list">
          {state.recentResponses.length === 0 ? <p className="empty-state">No Alfred responses recorded yet.</p> : state.recentResponses.slice().reverse().map((response) => (
            <article className="response-card" key={`${response.requestId ?? response.timestamp}-${response.timestamp}`}>
              <header><time>{new Date(response.timestamp).toLocaleString()}</time><span>{response.executed ? response.ok === false ? "Command failed" : "Command ran" : "Reply"}</span></header>
              <p className="response-card__question">You: {response.userText}</p>
              <p className="response-card__answer">{response.responseText || response.displayText || response.speech}</p>
              {response.command ? <code>ran: {response.command}</code> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
