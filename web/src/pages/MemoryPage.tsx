import { useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type {
  BaseMemoryRecord,
  DashboardState,
  KnowledgeImportRequest,
  KnowledgeSearchMatch,
  MemoryKind,
  MemoryProvenance,
  MemoryRecallResponse,
  ProfileFact,
} from "../api/types";

type MemoryTab = "profile" | "session" | "knowledge";

type ProfileEditSnapshot = {
  id: string;
  key: string;
  expectedUpdatedAt: string;
};

const MEMORY_TAB_KEY = "alfred2-memory-tab";
const TABS: MemoryTab[] = ["profile", "session", "knowledge"];

function savedTab(): MemoryTab {
  const value = localStorage.getItem(MEMORY_TAB_KEY);
  return TABS.includes(value as MemoryTab) ? value as MemoryTab : "profile";
}

function provenanceLabel(provenance: MemoryProvenance): string {
  return provenance.source === "manual" ? "Manual" : provenance.source[0]!.toUpperCase() + provenance.source.slice(1);
}

function ExactTime({ label, value }: { label: string; value: string }) {
  const parsed = new Date(value);
  return <div><dt>{label}</dt><dd><time dateTime={value}>{Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()}</time><code>{value}</code></dd></div>;
}

function MemoryMetadata({ record, indexedAt }: { record: BaseMemoryRecord; indexedAt?: string }) {
  const provenance = record.provenance;
  return (
    <details className="memory-metadata" open>
      <summary>Memory details</summary>
      <dl className="definition-list">
        <div><dt>Stable ID</dt><dd><code>{record.id}</code></dd></div>
        <div><dt>Source</dt><dd>{provenanceLabel(provenance)}</dd></div>
        {provenance.sourceId ? <div><dt>Source ID</dt><dd><code>{provenance.sourceId}</code></dd></div> : null}
        {provenance.requestId ? <div><dt>Request ID</dt><dd><code>{provenance.requestId}</code></dd></div> : null}
        {provenance.turnId ? <div><dt>Turn ID</dt><dd><code>{provenance.turnId}</code></dd></div> : null}
        {provenance.confidence !== undefined ? <div><dt>Confidence</dt><dd>{Math.round(provenance.confidence * 100)}%</dd></div> : null}
        <ExactTime label="Stored" value={provenance.timestamp} />
        <ExactTime label="Created" value={record.createdAt} />
        <ExactTime label="Updated" value={record.updatedAt} />
        {indexedAt ? <ExactTime label="Indexed" value={indexedAt} /> : null}
      </dl>
    </details>
  );
}

export function MemoryPage({ state, onAdd, onUpdate, onDelete, onClearSession, onRecall, onImportKnowledge, onDeleteKnowledge, onReindexKnowledge, onSearchKnowledge }: {
  state: DashboardState;
  onAdd: (fact: Pick<ProfileFact, "key" | "value" | "category">) => Promise<boolean>;
  onUpdate?: (id: string, fact: Pick<ProfileFact, "key" | "value" | "category">, expectedUpdatedAt: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onClearSession?: () => Promise<boolean>;
  onRecall?: (query: string, kinds: MemoryKind[]) => Promise<MemoryRecallResponse>;
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
  const [editing, setEditing] = useState<ProfileEditSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState("");
  const [clearingSession, setClearingSession] = useState(false);
  const [sessionStatus, setSessionStatus] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallKinds, setRecallKinds] = useState<Record<MemoryKind, boolean>>({ profile: true, session: true, knowledge: true });
  const [recallResult, setRecallResult] = useState<MemoryRecallResponse | null>(null);
  const [recallStatus, setRecallStatus] = useState("Enter a query to search Profile, Session, and Knowledge memory.");
  const [recallBusy, setRecallBusy] = useState(false);
  const recallSequence = useRef(0);
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

  function resetProfileForm(focusId?: string) {
    setEditing(null);
    setKey("");
    setValue("");
    setCategory("preference");
    if (focusId) window.requestAnimationFrame(() => document.getElementById(`edit-${focusId}`)?.focus());
  }

  function beginEdit(fact: ProfileFact) {
    setEditing({ id: fact.id, key: fact.key, expectedUpdatedAt: fact.updatedAt });
    setKey(fact.key);
    setValue(fact.value);
    setCategory(fact.category);
    setProfileStatus(`Editing ${fact.key}.`);
    window.requestAnimationFrame(() => document.getElementById("profile-memory-key")?.focus());
  }

  async function deleteFact(id: string) {
    const visibleIndex = facts.findIndex((fact) => fact.id === id);
    const nextFocusId = facts[visibleIndex + 1]?.id ?? facts[visibleIndex - 1]?.id;
    setDeletingId(id);
    setProfileStatus("Deleting profile memory…");
    try {
      const removed = await onDelete(id);
      if (!removed) {
        setProfileStatus("Profile memory was not deleted.");
        return;
      }
      if (editing?.id === id) resetProfileForm();
      setProfileStatus("Profile memory deleted. Related activity history and handoffs remain.");
      window.requestAnimationFrame(() => {
        const target = nextFocusId ? document.getElementById(`edit-${nextFocusId}`) : document.getElementById("profile-memory-filter");
        target?.focus();
      });
    } finally { setDeletingId(null); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || !value.trim()) return;
    setSaving(true);
    try {
      const input = { key: key.trim(), value: value.trim(), category };
      const saved = editing
        ? onUpdate ? await onUpdate(editing.id, input, editing.expectedUpdatedAt) : false
        : await onAdd(input);
      if (saved) {
        setProfileStatus(editing ? "Profile memory updated." : "Profile memory saved.");
        resetProfileForm(editing?.id);
      }
    } finally {
      setSaving(false);
    }
  }

  async function clearWorkingMemory() {
    if (!onClearSession || !window.confirm("Clear retained working-memory summaries? Token accounting, activity history, handoffs, profile facts, and Knowledge sources will remain.")) return;
    setClearingSession(true);
    setSessionStatus("Clearing retained working-memory summaries…");
    try {
      const cleared = await onClearSession();
      setSessionStatus(cleared ? "Working-memory summaries cleared. Token accounting and durable activity history remain." : "Working memory was not cleared.");
    } finally {
      setClearingSession(false);
    }
  }

  function invalidateRecall(status: string) {
    recallSequence.current += 1;
    setRecallBusy(false);
    setRecallResult(null);
    setRecallStatus(status);
  }

  function changeRecallQuery(next: string) {
    setRecallQuery(next);
    invalidateRecall(next.trim() ? "Submit to recall matching memory." : "Enter a query to search Profile, Session, and Knowledge memory.");
  }

  function changeRecallKind(kind: MemoryKind, checked: boolean) {
    setRecallKinds((current) => ({ ...current, [kind]: checked }));
    invalidateRecall(recallQuery.trim() ? "Memory-kind selection changed. Submit to recall matching memory." : "Enter a query to search Profile, Session, and Knowledge memory.");
  }

  async function submitRecall(event: FormEvent) {
    event.preventDefault();
    const query = recallQuery.trim();
    const kinds = (TABS as MemoryKind[]).filter((kind) => recallKinds[kind]);
    if (!onRecall || !query || kinds.length === 0) {
      setRecallStatus(kinds.length ? "Enter a recall query." : "Select at least one memory kind.");
      return;
    }
    const sequence = ++recallSequence.current;
    setRecallBusy(true);
    setRecallResult(null);
    setRecallStatus("Recalling memory…");
    try {
      const result = await onRecall(query, kinds);
      if (sequence !== recallSequence.current) return;
      setRecallResult(result);
      setRecallStatus(result.total ? `Found ${result.total} grouped memory result${result.total === 1 ? "" : "s"}.` : "No memory matched that query.");
    } catch (cause) {
      if (sequence !== recallSequence.current) return;
      setRecallStatus(cause instanceof Error ? `Recall failed: ${cause.message}` : "Recall failed.");
    } finally {
      if (sequence === recallSequence.current) setRecallBusy(false);
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
        setKnowledgeTitle(""); setKnowledgeContent(""); setKnowledgeLocation(undefined); setKnowledgeMimeType(undefined); setKnowledgeType("document"); form.reset();
      }
    } finally { setKnowledgeBusy(null); }
  }

  async function searchKnowledge(event: FormEvent) {
    event.preventDefault();
    if (!onSearchKnowledge || !knowledgeQuery.trim()) return;
    setKnowledgeBusy("search"); setKnowledgeMatches([]);
    try { setKnowledgeMatches(await onSearchKnowledge(knowledgeQuery.trim())); }
    finally { setKnowledgeBusy(null); }
  }

  async function mutateKnowledge(id: string, operation: "delete" | "reindex") {
    setKnowledgeBusy(`${operation}:${id}`);
    try {
      const changed = operation === "delete" ? await onDeleteKnowledge?.(id) : await onReindexKnowledge?.(id);
      if (changed && operation === "delete") setKnowledgeMatches((matches) => matches.filter((match) => match.sourceId !== id));
      if (changed && operation === "reindex") setKnowledgeMatches([]);
    } finally { setKnowledgeBusy(null); }
  }

  return (
    <div className="page-stack">
      <section className="panel section-panel" aria-labelledby="memory-recall-heading">
        <div className="section-heading"><div><span className="eyebrow">Unified recall</span><h2 id="memory-recall-heading">Recall memory</h2></div></div>
        <form className="memory-recall-form" onSubmit={submitRecall}>
          <label>Query<input required value={recallQuery} maxLength={500} onChange={(event) => changeRecallQuery(event.target.value)} placeholder="What do you remember about…" /></label>
          <fieldset><legend>Memory kinds</legend>{TABS.map((kind) => <label key={kind}><input checked={recallKinds[kind]} onChange={(event) => changeRecallKind(kind, event.target.checked)} type="checkbox" />{kind[0]!.toUpperCase() + kind.slice(1)}</label>)}</fieldset>
          <button className="button button--primary" disabled={recallBusy || !onRecall} type="submit">{recallBusy ? "Recalling…" : "Recall"}</button>
        </form>
        <div aria-busy={recallBusy} aria-live="polite" className="memory-recall-status" role="status">{recallStatus}</div>
        {recallResult?.total ? <div className="memory-recall-results">
          {recallResult.groups.profile.length ? <section aria-labelledby="recall-profile"><h3 id="recall-profile">Profile</h3>{recallResult.groups.profile.map(({ record }) => <article key={record.id}><strong>{record.key}</strong><p>{record.value}</p><MemoryMetadata record={record} /></article>)}</section> : null}
          {recallResult.groups.session.length ? <section aria-labelledby="recall-session"><h3 id="recall-session">Session</h3>{recallResult.groups.session.map(({ record }) => <article key={record.id}><strong>{record.userText}</strong><p>{record.shortOutcome || record.finalSpeech}</p><MemoryMetadata record={record} /></article>)}</section> : null}
          {recallResult.groups.knowledge.length ? <section aria-labelledby="recall-knowledge"><h3 id="recall-knowledge">Knowledge</h3>{recallResult.groups.knowledge.map(({ record, citation }) => <article key={citation.citationId}><strong>{record.title}</strong><p>{citation.text}</p><code>{citation.citationId}</code><MemoryMetadata indexedAt={record.indexedAt} record={record} /></article>)}</section> : null}
        </div> : null}
      </section>

      <div aria-label="Memory categories" className="memory-tabs" role="tablist">
        {TABS.map((tab) => {
          const count = tab === "profile" ? profile.count : tab === "session" ? session.count : knowledge.count;
          return <button aria-controls={`memory-panel-${tab}`} aria-selected={activeTab === tab} className="memory-tab" id={`memory-tab-${tab}`} key={tab} onClick={() => selectTab(tab)} onKeyDown={handleTabKey} role="tab" tabIndex={activeTab === tab ? 0 : -1} type="button"><span>{tab[0]!.toUpperCase() + tab.slice(1)}</span><small>{count}</small></button>;
        })}
      </div>

      <div aria-labelledby="memory-tab-profile" className="page-stack memory-tabpanel" hidden={activeTab !== "profile"} id="memory-panel-profile" role="tabpanel" tabIndex={activeTab === "profile" ? 0 : -1}>
        <section className="panel section-panel">
          <div className="section-heading"><div><span className="eyebrow">Profile memory</span><h2>{editing ? `Edit ${editing.key}` : "Facts Alfred keeps"}</h2></div><span className="count-badge">{profile.count}</span></div>
          <p className="memory-boundary-note"><strong>Durable.</strong> Deleting a profile fact removes that fact, not related activity history or handoffs.</p>
          <form className="fact-form" onSubmit={submit}>
            <label>Key<input id="profile-memory-key" required value={key} onChange={(event) => setKey(event.target.value)} placeholder="response_style" /></label>
            <label className="fact-form__value">Value<input required value={value} onChange={(event) => setValue(event.target.value)} placeholder="Concise and direct" /></label>
            <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as ProfileFact["category"])}><option value="preference">Preference</option><option value="identity">Identity</option><option value="context">Context</option><option value="note">Note</option></select></label>
            <button className="button button--primary" disabled={saving || Boolean(editing && !onUpdate)} type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Remember"}</button>
            {editing ? <button className="button" disabled={saving} onClick={() => resetProfileForm(editing.id)} type="button">Cancel edit</button> : null}
          </form>
        </section>
        <section className="panel section-panel">
          <div className="filter-row"><input aria-label="Filter profile facts" id="profile-memory-filter" onChange={(event) => setFilter(event.target.value)} placeholder="Filter facts" value={filter} /><span>{facts.length} shown</span></div>
          <div aria-live="polite" className="memory-operation-status" role="status">{profileStatus}</div>
          <div className="table-wrap"><table><thead><tr><th>Memory</th><th>Category</th><th>Details</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {facts.length === 0 ? <tr><td className="empty-state" colSpan={4}>No matching facts.</td></tr> : facts.map((fact) => <tr key={fact.id}><td><strong>{fact.key}</strong><p>{fact.value}</p></td><td><span className="tag">{fact.category}</span></td><td><MemoryMetadata record={fact} /></td><td><div className="button-row"><button aria-label={`Edit ${fact.key}`} className="button" disabled={saving || deletingId === fact.id} id={`edit-${fact.id}`} onClick={() => beginEdit(fact)} type="button">Edit</button><button aria-label={`Delete ${fact.key}`} className="button button--danger" disabled={deletingId === fact.id || saving} onClick={() => { if (window.confirm(`Delete fact ${fact.key}? This removes the profile fact only.`)) void deleteFact(fact.id); }} type="button">{deletingId === fact.id ? "Deleting…" : "Delete"}</button></div></td></tr>)}
          </tbody></table></div>
        </section>
      </div>

      <div aria-labelledby="memory-tab-session" className="page-stack memory-tabpanel" hidden={activeTab !== "session"} id="memory-panel-session" role="tabpanel" tabIndex={activeTab === "session" ? 0 : -1}>
        <section className="panel section-panel">
          <div className="section-heading"><div><span className="eyebrow">Working memory</span><h2>Current session</h2></div><span className="count-badge">{session.count}</span></div>
          <p className="memory-boundary-note"><strong>Ephemeral.</strong> Clear removes these retained summaries only. Token accounting, activity history, handoffs, profile facts, and Knowledge sources remain.</p>
          <dl className="definition-list"><div><dt>Context</dt><dd>{session.currentContextTokens.toLocaleString()} tokens</dd></div><div><dt>Usage</dt><dd>{session.cumulativeTotalTokens.toLocaleString()} cumulative tokens</dd></div></dl>
          <div className="button-row"><button className="button button--danger" disabled={clearingSession || !onClearSession || session.count === 0} onClick={() => void clearWorkingMemory()} type="button">{clearingSession ? "Clearing…" : "Clear working memory"}</button></div>
          <div aria-live="polite" role="status">{sessionStatus}</div>
        </section>
        <section className="panel section-panel">
          <div className="table-wrap"><table><thead><tr><th>Request</th><th>Response</th><th>Tools</th><th>Outcome</th><th>Details</th></tr></thead><tbody>
            {session.records.length === 0 ? <tr><td className="empty-state" colSpan={5}>No working-memory turns in this process yet.</td></tr> : session.records.slice().reverse().map((turn) => <tr key={turn.id}><td>{turn.userText}</td><td>{turn.finalSpeech}</td><td>{turn.toolsUsed.length ? turn.toolsUsed.join(", ") : "—"}</td><td>{turn.shortOutcome || "—"}</td><td><MemoryMetadata record={turn} /></td></tr>)}
          </tbody></table></div>
        </section>
      </div>

      <div aria-labelledby="memory-tab-knowledge" className="page-stack memory-tabpanel" hidden={activeTab !== "knowledge"} id="memory-panel-knowledge" role="tabpanel" tabIndex={activeTab === "knowledge" ? 0 : -1}>
        <section className="panel section-panel">
          <div className="section-heading"><div><span className="eyebrow">Knowledge sources</span><h2>Import Text or Markdown</h2></div><span className="count-badge">{knowledge.count}</span></div>
          <p className="memory-boundary-note"><strong>Durable, local, and lexical.</strong> Deleting a source removes its metadata and indexed chunks. Imported text is evidence, never instructions.</p>
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
          {knowledge.sources.length === 0 ? <div className="empty-state"><p>No knowledge sources yet.</p><p>Import a Text or Markdown file, or paste content above. Alfred will create the local source metadata and chunk index.</p></div> : <div className="tool-grid">{knowledge.sources.map((source) => <article className="tool-card" key={source.id}><header><h3>{source.title}</h3><span className="tag">{source.status}</span></header><p>{source.sourceType}{source.origin ? ` · ${source.origin === "assistant" ? "assistant-created" : source.origin}` : ""}{source.location ? ` · ${source.location}` : ""}</p><p>{source.chunkCount ?? 0} chunks · {source.sizeBytes?.toLocaleString() ?? 0} bytes</p><MemoryMetadata indexedAt={source.indexedAt} record={source} />{source.error ? <p className="error-text" role="alert">{source.error}</p> : null}<div className="button-row"><button aria-label={`Reindex ${source.title}`} className="button" disabled={knowledgeBusy !== null || !onReindexKnowledge} onClick={() => void mutateKnowledge(source.id, "reindex")} type="button">{knowledgeBusy === `reindex:${source.id}` ? "Reindexing…" : "Reindex"}</button><button aria-label={`Delete ${source.title}`} className="button button--danger" disabled={knowledgeBusy !== null || !onDeleteKnowledge} onClick={() => { if (window.confirm(`Delete knowledge source ${source.title}? This also removes its indexed chunks.`)) void mutateKnowledge(source.id, "delete"); }} type="button">{knowledgeBusy === `delete:${source.id}` ? "Deleting…" : "Delete"}</button></div></article>)}</div>}
        </section>
      </div>
    </div>
  );
}
