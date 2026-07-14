import { useMemo, useState } from "react";
import type { AlfredEvent, ToolContract } from "../api/types";

export function ToolsPage({ tools, onAskCapabilities, events }: { tools: ToolContract[]; onAskCapabilities: () => Promise<void>; events: AlfredEvent[] }) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return !query ? tools : tools.filter((tool) => `${tool.name} ${tool.description} ${tool.confirm}`.toLowerCase().includes(query));
  }, [filter, tools]);

  return (
    <section className="panel section-panel">
      <div className="section-heading"><div><span className="eyebrow">Tool registry</span><h2>Capabilities</h2></div><button className="button button--primary" onClick={() => void onAskCapabilities()} type="button">Ask Alfred</button></div>
      <div className="filter-row"><input aria-label="Filter tools" onChange={(event) => setFilter(event.target.value)} placeholder="Filter tools" value={filter} /><span>{visible.length} of {tools.length}</span></div>
      <div className="tool-live" aria-live="polite">{events.filter((event) => event.type === "tool:start" || event.type === "tool:done").slice(-1).map((event) => <span key={`${event.requestId}-${event.type}`}>{event.type === "tool:start" ? "Running" : event.ok ? "Completed" : "Failed"}: {event.tool}</span>)}</div>
      <div className="tool-grid">
        {visible.length === 0 ? <p className="empty-state">No matching tools.</p> : visible.map((tool) => <article className="tool-card" key={tool.name}><header><h3>{tool.name}</h3><span className={`tag tag--${tool.confirm === "none" ? "safe" : "warn"}`}>{tool.confirm}</span></header><p>{tool.description}</p><details><summary>Contract</summary><pre>{JSON.stringify(tool.schema, null, 2)}</pre></details></article>)}
      </div>
    </section>
  );
}
