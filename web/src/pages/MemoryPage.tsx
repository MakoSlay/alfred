import { useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { DashboardState, KnowledgeImportRequest, KnowledgeSearchMatch, MemoryProvenance, ProfileFact } from "../api/types";

type MemoryTab = "profile" | "session" | "knowledge";

const MEMORY_TAB_KEY = "alfred2-memory-tab";
const TABS: MemoryTab[] = ["profile", "session", "knowledge"];

function savedTab(): MemoryTab {
  const value = localStorage.getItem(MEMORY_TAB_KEY);
  return TABS.includes(value as MemoryTab) ? value as MemoryTab : "profile";
}

function provenanceLabel(provenance: MemoryProvenance): string {
  const source = provenance.source === "manual" ? "Manual" : provenance.source[0]!.toUpperCase() + provenance.source.slice(1);
  return provenance.sourceId ? `${source} · ${provenance.sourceId}` : source;
}

export function MemoryPage({ state, onAdd, onDelete, onImportKnowledge, onDeleteKnowledge, onReindexKnowledge, onSearchKnowledge }: {
  state: DashboardState;
  onAdd: (fact: Pick<ProfileFact, "key" | "value" | "category">) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onImportKnowledge?: (input: KnowledgeImportRequest) => Promise<boolean>;
  onDeleteKnowledge?: (id: string) => Promise<boolean>;
  onReindexKnowledge?: (id: string) => Promise<boolean>;
  onSearchKnowledge?: (query: string) => Promise<KnowledgeSearchMatch[]>;
}) {
  const [activeTab, setActiveTab] = useState<MemoryTab>(savedTab);
  const [filter, setFilter] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState<ProfileFact["category"]>("preference");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");
  const [knowledgeType, setKnowledgeType] = useState<KnowledgeImportRequest["sourceType"]>("document");
  const [knowledgeLocation, setKnowledgeLocation] = useState<string | undefined>();
  const [knowledgeMimeType, setKnowledgeMimeType] = useState<string | undefined>();
  const [knowledgeBusy, setKnowledgeBusy] = useState<string | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeMatches, setKnowledgeMatches] = useState<KnowledgeSearchMatch[]>([]);
  const profile = state.memory.profile;
  const session = state.memory.session;
  const knowledge = state.memory.knowledge;
  const facts = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return !query ? profile.records : profile.records.filter((fact) => `${fact.key} ${fact.value} ${fact.category} ${fact.provenance.source}`.toLowerCase().includes(query));
  }, [filter, profile.records]);

  function selectTab(tab: MemoryTab, focus = false) {
    setActiveTab(tab);
    localStorage.setItem(MEMORY_TAB_KEY, tab);
    if (focus) window.requestAnimationFrame(() => document.getElementById(`memory-tab-${tab}`)?.focus());
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const current = TABS.indexOf(activeTab);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next]!, true);
  }

  async function deleteFact(id: string) {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || !value.trim()) return;
    setSaving(true);
    try {
      const saved = await onAdd({ key: key.trim(), value: value.trim(), category });
      if (saved) {
        setKey("");
        setValue("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function chooseKnowledgeFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setKnowledgeTitle(file.name.replace(/\.(?:txt|md|markdown)$/i, ""));
    setKnowledgeLocation(file.name);
    setKnowledgeMimeType(file.type || (/\.(?:md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain"));
    setKnowledgeContent(await file.text());
  }

  async function importKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onImportKnowledge || !knowledgeTitle.trim() || !knowledgeContent.trim()) return;
    const form = event.currentTarget;
    setKnowledgeBusy("import");
    try {
      const saved = await onImportKnowledge({ title: knowledgeTitle.trim(), content: knowledgeContent, sourceType: knowledgeType, location: knowledgeLocation, mimeType: knowledgeMimeType });
      if (saved) {
        setKnowledgeTitle("");
        setKnowledgeContent("");
        setKnowledgeLocation(undefined);
        setKnowledgeMimeType(undefined);
        setKnowledgeType("document");
        form.reset();
      }
    } finally {
      setKnowledgeBusy(null);
    }
  }

  async function searchKnowledge(event: FormEvent) {
    event.preventDefault();
    if (!onSearchKnowledge || !knowledgeQuery.trim()) return;
    setKnowledgeBusy("search");
    setKnowledgeMatches([]);
    try { setKnowledgeMatches(await onSearchKnowledge(knowledgeQuery.trim())); }
    finally { setKnowledgeBusy(null); }
  }

  async function mutateKnowledge(id: string, operation: "delete" | "reindex") {
    setKnowledgeBusy(`${operation}:${id}`);
    try {
      const changed = operation === "delete" ? await onDeleteKnowledge?.(id) : await onReindexKnowledge?.(id);
      if (changed && operation === "delete") setKnowledgeMatches((matches) => matches.filter((match) => match.sourceId !== id));
      if (changed && operation === "reindex") setKnowledgeMatches([]);
    } finally {
      setKnowledgeBusy(null);
    }
  }

  return (
    <div className="page-stack">
      <div aria-label="Memory categories" className="memory-tabs" role="tablist">
        {TABS.map((tab) => {
          const count = tab === "profile" ? profile.count : tab === "session" ? session.count : knowledge.count;
          return (
            <button
              aria-controls={`memory-panel-${tab}`}
              aria-selected={activeTab === tab}
              className="memory-tab"
              id={`memory-tab-${tab}`}
              key={tab}
              onClick={() => selectTab(tab)}
              onKeyDown={handleTabKey}
              role="tab"
              tabIndex={activeTab === tab ? 0 : -1}
              type="button"
            >
              <span>{tab[0]!.toUpperCase() + tab.slice(1)}</span><small>{count}</small>
            </button>
          );
        })}
      </div>

      <div aria-labelledby="memory-tab-profile" className="page-stack memory-tabpanel" hidden={activeTab !== "profile"} id="memory-panel-profile" role="tabpanel" tabIndex={activeTab === "profile" ? 0 : -1}>
          <section className="panel section-panel">
            <div className="section-heading"><div><span className="eyebrow">Profile memory</span><h2>Facts Alfred keeps</h2></div><span className="count-badge">{profile.count}</span></div>
            <form className="fact-form" onSubmit={submit}>
              <label>Key<input required value={key} onChange={(event) => setKey(event.target.value)} placeholder="response_style" /></label>
              <label className="fact-form__value">Value<input required value={value} onChange={(event) => setValue(event.target.value)} placeholder="Concise and direct" /></label>
              <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as ProfileFact["category"])}><option value="preference">Preference</option><option value="identity">Identity</option><option value="context">Context</option><option value="note">Note</option></select></label>
              <button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Remember"}</button>
            </form>
          </section>
          <section className="panel section-panel">
            <div className="filter-row"><input aria-label="Filter profile facts" onChange={(event) => setFilter(event.target.value)} placeholder="Filter facts" value={filter} /><span>{facts.length} shown</span></div>
            <div className="table-wrap"><table><thead><tr><th>Key</th><th>Value</th><th>Category</th><th>Provenance</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
              {facts.length === 0 ? <tr><td className="empty-state" colSpan={6}>No matching facts.</td></tr> : facts.map((fact) => <tr key={fact.id}><td><strong>{fact.key}</strong></td><td>{fact.value}</td><td><span className="tag">{fact.category}</span></td><td><span title={fact.provenance.timestamp}>{provenanceLabel(fact.provenance)}</span></td><td>{new Date(fact.updatedAt).toLocaleString()}</td><td><button className="button button--danger" disabled={deletingId === fact.id} onClick={() => { if (window.confirm(`Delete fact ${fact.key}?`)) void deleteFact(fact.id); }} type="button">{deletingId === fact.id ? "Deleting…" : "Delete"}</button></td></tr>)}
            </tbody></table></div>
          </section>
      </div>

      <div aria-labelledby="memory-tab-session" className="page-stack memory-tabpanel" hidden={activeTab !== "session"} id="memory-panel-session" role="tabpanel" tabIndex={activeTab === "session" ? 0 : -1}>
          <section className="panel section-panel">
            <div className="section-heading"><div><span className="eyebrow">Working memory</span><h2>Current session</h2></div><span className="count-badge">{session.count}</span></div>
            <p className="memory-boundary-note"><strong>Ephemeral.</strong> These sanitized summaries exist only for this Alfred process and are not written to profile or knowledge storage. Alfred's separate activity history may retain request and response metadata.</p>
            <dl className="definition-list"><div><dt>Context</dt><dd>{session.currentContextTokens.toLocaleString()} tokens</dd></div><div><dt>Usage</dt><dd>{session.cumulativeTotalTokens.toLocaleString()} cumulative tokens</dd></div></dl>
          </section>
          <section className="panel section-panel">
            <div className="table-wrap"><table><thead><tr><th>Request</th><th>Response</th><th>Tools</th><th>Outcome</th><th>When</th></tr></thead><tbody>
              {session.records.length === 0 ? <tr><td className="empty-state" colSpan={5}>No working-memory turns in this process yet.</td></tr> : session.records.slice().reverse().map((turn) => <tr key={turn.id}><td>{turn.userText}</td><td>{turn.finalSpeech}</td><td>{turn.toolsUsed.length ? turn.toolsUsed.join(", ") : "—"}</td><td>{turn.shortOutcome || "—"}</td><td>{new Date(turn.updatedAt).toLocaleString()}</td></tr>)}
            </tbody></table></div>
          </section>
      </div>

      <div aria-labelledby="memory-tab-knowledge" className="page-stack memory-tabpanel" hidden={activeTab !== "knowledge"} id="memory-panel-knowledge" role="tabpanel" tabIndex={activeTab === "knowledge" ? 0 : -1}>
          <section className="panel section-panel">
            <div className="section-heading"><div><span className="eyebrow">Knowledge sources</span><h2>Import Text or Markdown</h2></div><span className="count-badge">{knowledge.count}</span></div>
            <p className="memory-boundary-note"><strong>Local and lexical.</strong> Sources are chunked deterministically and searched without a vector database. Imported text can provide evidence, never instructions.</p>
            <form className="knowledge-form" onSubmit={importKnowledge}>
              <label>Title<input required value={knowledgeTitle} onChange={(event) => { setKnowledgeTitle(event.target.value); setKnowledgeLocation(undefined); }} placeholder="Project handbook" /></label>
              <label>Type<select value={knowledgeType} onChange={(event) => setKnowledgeType(event.target.value as KnowledgeImportRequest["sourceType"])}><option value="document">Document</option><option value="note">Note</option><option value="project">Project</option></select></label>
              <label>Text or Markdown file<input accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(event) => void chooseKnowledgeFile(event)} type="file" /></label>
              <label className="knowledge-form__content">Content<textarea required rows={7} value={knowledgeContent} onChange={(event) => { setKnowledgeContent(event.target.value); setKnowledgeLocation(undefined); setKnowledgeMimeType(undefined); }} placeholder="Paste plain text or Markdown here…" /></label>
              <button className="button button--primary" disabled={knowledgeBusy !== null || !onImportKnowledge} type="submit">{knowledgeBusy === "import" ? "Indexing…" : "Import and index"}</button>
            </form>
          </section>
          <section className="panel section-panel">
            <form className="filter-row" onSubmit={searchKnowledge}><input aria-label="Search knowledge" onChange={(event) => { setKnowledgeQuery(event.target.value); setKnowledgeMatches([]); }} placeholder="Search imported sources" value={knowledgeQuery} /><button className="button" disabled={knowledgeBusy !== null || !onSearchKnowledge} type="submit">{knowledgeBusy === "search" ? "Searching…" : "Search"}</button></form>
            {knowledgeMatches.length > 0 ? <div aria-live="polite" className="knowledge-results"><span className="eyebrow">Lexical matches</span>{knowledgeMatches.map((match) => <article key={match.citationId}><strong>{match.title}</strong><p>{match.text}</p><code>{match.citationId}</code></article>)}</div> : null}
            {knowledge.sources.length === 0 ? <div className="empty-state"><p>No knowledge sources yet.</p><p>Import a Text or Markdown file, or paste content above. Alfred will create the local source metadata and chunk index.</p></div> : <div className="tool-grid">{knowledge.sources.map((source) => <article className="tool-card" key={source.id}><header><h3>{source.title}</h3><span className="tag">{source.status}</span></header><p>{source.sourceType}{source.origin ? ` · ${source.origin === "assistant" ? "assistant-created" : source.origin}` : ""}{source.location ? ` · ${source.location}` : ""}</p><p>{source.chunkCount ?? 0} chunks · {source.sizeBytes?.toLocaleString() ?? 0} bytes</p>{source.error ? <p className="error-text" role="alert">{source.error}</p> : null}<div className="button-row"><button aria-label={`Reindex ${source.title}`} className="button" disabled={knowledgeBusy !== null || !onReindexKnowledge} onClick={() => void mutateKnowledge(source.id, "reindex")} type="button">{knowledgeBusy === `reindex:${source.id}` ? "Reindexing…" : "Reindex"}</button><button aria-label={`Delete ${source.title}`} className="button button--danger" disabled={knowledgeBusy !== null || !onDeleteKnowledge} onClick={() => { if (window.confirm(`Delete knowledge source ${source.title}?`)) void mutateKnowledge(source.id, "delete"); }} type="button">{knowledgeBusy === `delete:${source.id}` ? "Deleting…" : "Delete"}</button></div></article>)}</div>}
          </section>
      </div>
    </div>
  );
}
