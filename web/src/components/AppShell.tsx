import type { ReactNode } from "react";
import type { DashboardState } from "../api/types";
import { AlfredWaveform } from "./AlfredWaveform";
import { StatusPill } from "./StatusPill";

export type PageId = "radar" | "voice" | "memory" | "safety" | "tools" | "settings";

const NAV_ITEMS: Array<{ id: PageId; label: string; glyph: string }> = [
  { id: "radar", label: "Radar", glyph: "R" },
  { id: "voice", label: "Voice", glyph: "V" },
  { id: "memory", label: "Memory", glyph: "M" },
  { id: "safety", label: "Safety", glyph: "S" },
  { id: "tools", label: "Tools", glyph: "T" },
  { id: "settings", label: "Settings", glyph: "·" },
];

export function AppShell({ page, onPageChange, state, notice, onRefresh, children }: {
  page: PageId;
  onPageChange: (page: PageId) => void;
  state: DashboardState | null;
  notice: string;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const pending = state?.pendingConfirmations ?? 0;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">A</div>
          <div><span className="eyebrow">Private operator</span><strong>Alfred</strong></div>
        </div>
        <nav className="nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "nav__item nav__item--active" : "nav__item"}
              key={item.id}
              onClick={() => onPageChange(item.id)}
              type="button"
            >
              <span className="nav__glyph">{item.glyph}</span>{item.label}
              {item.id === "memory" && state ? <small>{state.memory.profile.count}</small> : null}
              {item.id === "safety" && state && state.undoCount > 0 ? <small>{state.undoCount}</small> : null}
              {item.id === "tools" && state ? <small>{state.tools.count}</small> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar__presence">
          <AlfredWaveform compact />
          <p aria-live="polite" role="status">{notice || "Ready for instruction."}</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Local-first butler console</span>
            <h1>{NAV_ITEMS.find((item) => item.id === page)?.label}</h1>
          </div>
          <div className="topbar__status">
            <StatusPill tone={pending ? "warn" : state?.autoConfirm ? "good" : "quiet"}>
              {pending ? `${pending} approval${pending === 1 ? "" : "s"}` : state?.autoConfirm ? "Autonomous" : "Guarded"}
            </StatusPill>
            <StatusPill tone={state?.muted ? "bad" : "good"}>{state?.muted ? "Muted" : "Voice online"}</StatusPill>
            {state ? <code className="session-chip" title={state.sessionId}>{state.sessionId}</code> : null}
            <button className="button button--quiet" onClick={onRefresh} type="button">Refresh</button>
          </div>
        </header>
        <main className="content">{children}</main>
      </section>
    </div>
  );
}
