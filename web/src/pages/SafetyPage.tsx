import { useState } from "react";
import type { DashboardState } from "../api/types";

export function SafetyPage({ state, onToggleAutoConfirm, onToggleMute, onRestore, onClear }: {
  state: DashboardState;
  onToggleAutoConfirm: () => Promise<void>;
  onToggleMute: (minutes: number) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [minutes, setMinutes] = useState(10);
  return (
    <div className="page-stack">
      <section className="safety-grid">
        <article className="panel section-panel"><span className="eyebrow">Controls · session only</span><h2>Routine mutation approval</h2><p>{state.autoConfirm ? "Routine local mutations may proceed without another prompt for this session." : "Routine local mutations require confirmation."} This includes reversible file, Git, package, and shell changes. Sends, monitors, imports, schedules, destructive work, and blocked paths remain separately protected.</p><div className="button-row"><button className="button button--primary" onClick={() => void onToggleAutoConfirm()} type="button">{state.autoConfirm ? "Require routine mutation approval" : "Auto-approve routine mutations"}</button></div></article>
        <article className="panel section-panel"><span className="eyebrow">Speech</span><h2>{state.muted ? "Muted" : "Voice online"}</h2><p>{state.mutedUntil ? `Muted until ${new Date(state.mutedUntil).toLocaleString()}.` : "Ready to speak."}</p><div className="mute-controls"><label>Minutes<input min="1" max="1440" type="number" value={minutes} onChange={(event) => setMinutes(Math.max(1, Number(event.target.value)))} /></label><button className="button" onClick={() => void onToggleMute(minutes)} type="button">{state.muted ? "Unmute" : "Mute"}</button></div></article>
        <article className="panel section-panel"><span className="eyebrow">Telemetry</span><div className="telemetry-list"><span><strong>{state.pendingConfirmations}</strong> pending approvals</span><span><strong>{state.memoryTurns}</strong> memory turns</span><span><strong>{state.toolRounds}</strong> tool rounds</span><span><strong>{new Date(state.lastUpdated).toLocaleTimeString()}</strong> last refresh</span></div></article>
      </section>
      <section className="panel section-panel">
        <div className="section-heading"><div><span className="eyebrow">Background authority</span><h2>Observation and session monitors</h2></div></div>
        <p>{state.workAdvisor?.autonomousEnabled ? `Periodic Work Advisor observation is enabled for ${state.workAdvisor.workspace} every ${Math.round(state.workAdvisor.intervalMs / 60_000)} minutes.` : "Periodic Work Advisor observation is off."}</p>
        {state.sessionMonitors?.length ? <div className="table-wrap"><table><thead><tr><th>Target</th><th>Status</th><th>Reply policy</th></tr></thead><tbody>{state.sessionMonitors.map((monitor) => <tr key={monitor.id}><td>{monitor.workspaceName} / {monitor.surfaceTitle}</td><td>{monitor.status}</td><td><span className="tag">{monitor.replyMode === "send" ? "Autonomous send" : "Draft only"}</span></td></tr>)}</tbody></table></div> : <p className="empty-state">No session monitors.</p>}
      </section>
      <section className="panel section-panel">
        <div className="section-heading"><div><span className="eyebrow">Recovery</span><h2>Undo history</h2></div><button className="button button--danger" disabled={!state.undoHistory.length} onClick={() => { if (window.confirm("Clear all undo snapshots?")) void onClear(); }} type="button">Clear undo</button></div>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>File</th><th>Tool</th><th>Preview</th><th /></tr></thead><tbody>{state.undoHistory.length === 0 ? <tr><td className="empty-state" colSpan={5}>No undo snapshots yet.</td></tr> : state.undoHistory.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td className="path-cell">{entry.originalPath}</td><td><span className="tag">{entry.tool}</span></td><td>{entry.preview}</td><td><button className="button" onClick={() => { if (window.confirm(`Restore ${entry.originalPath}?`)) void onRestore(entry.id); }} type="button">Restore</button></td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
