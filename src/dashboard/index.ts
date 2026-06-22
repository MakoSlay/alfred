export function renderDashboardHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alfred Local Dashboard</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --border: color-mix(in srgb, CanvasText 18%, transparent); --panel: color-mix(in srgb, CanvasText 4%, transparent); --muted: color-mix(in srgb, CanvasText 68%, transparent); --danger: #dc2626; --warn: #b45309; --ok: #15803d; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
header { display: grid; gap: 16px; margin-bottom: 20px; }
h1 { margin: 0; font-size: clamp(1.6rem, 3vw, 2.15rem); }
h2 { margin: 0 0 10px; font-size: 1rem; }
h3 { margin: 0 0 6px; font-size: 0.9rem; }
p { margin: 0; }
button, input { font: inherit; }
input { width: min(100%, 32rem); padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: Canvas; color: CanvasText; }
button { padding: 8px 11px; cursor: pointer; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: CanvasText; }
button:hover { border-color: color-mix(in srgb, CanvasText 38%, transparent); }
button.danger { color: var(--danger); }
button.primary { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
li { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 10px; padding: 10px; }
.hero { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.copy { color: var(--muted); line-height: 1.45; }
.token-card, section { border: 1px solid var(--border); border-radius: 14px; padding: 14px; background: var(--panel); }
.token-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 10px; }
.token-row label { display: grid; gap: 5px; font-weight: 600; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
.stack { display: grid; gap: 16px; }
.status-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.metric { border: 1px solid color-mix(in srgb, CanvasText 10%, transparent); border-radius: 10px; padding: 10px; }
.metric span, .meta { display: block; margin-top: 4px; font-size: 0.84rem; color: var(--muted); }
.pill { display: inline-flex; align-items: center; gap: 6px; width: fit-content; border-radius: 999px; padding: 3px 8px; font-size: 0.82rem; border: 1px solid var(--border); }
.ok { color: var(--ok); }
.warning { color: var(--warn); }
.error { color: var(--danger); }
.empty { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.banner { border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); border-radius: 10px; padding: 10px; color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); }
pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; color: var(--muted); }
</style>
</head>
<body>
<header>
  <div class="hero">
    <h1>Alfred Local Dashboard</h1>
    <p class="copy">Operate the standalone local Alfred daemon without putting the local token in a URL. The dashboard HTML is public on localhost, but every daemon API call below still sends <code>x-alfred-auth</code>.</p>
  </div>
  <div class="token-card" aria-labelledby="token-heading">
    <h2 id="token-heading">Local authentication</h2>
    <p class="copy">Paste the daemon token printed in the terminal after <code>npm run daemon</code> starts. Saving stores it only in this browser's <code>localStorage</code> as a local convenience; it is not embedded in this page, logged by the dashboard, or added to the address bar.</p>
    <div class="token-row">
      <label>Daemon token
        <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the local daemon token from your terminal">
      </label>
      <button id="save-token" type="button">Save locally</button>
      <button id="clear-token" type="button">Forget token</button>
      <button id="refresh" class="primary" type="button">Refresh daemon state</button>
    </div>
    <p id="status" class="meta" role="status">Idle. Enter the local token, then refresh.</p>
  </div>
</header>
<main class="stack">
  <section aria-labelledby="health-heading">
    <h2 id="health-heading">Daemon health</h2>
    <div class="status-grid">
      <div class="metric"><strong id="health">Unknown</strong><span>Health</span></div>
      <div class="metric"><strong id="endpoint">Unknown</strong><span>Endpoint</span></div>
      <div class="metric"><strong id="last-refresh">Never</strong><span>Last refresh</span></div>
      <div class="metric"><strong id="counts">—</strong><span>Visible items</span></div>
    </div>
    <div id="warnings" class="meta">Storage warnings will appear here if Alfred starts in degraded mode.</div>
  </section>
  <div class="grid">
    <section aria-labelledby="loop-heading">
      <h2 id="loop-heading">Active loop</h2>
      <div id="loop"><p class="empty">No loop status loaded yet.</p></div>
    </section>
    <section aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Pending drafts</h2>
      <p class="copy">Review before sending. Confirm and cancel buttons call authenticated APIs and never bypass draft-confirm.</p>
      <ul id="drafts"><li class="empty">Not loaded.</li></ul>
    </section>
    <section aria-labelledby="surfaces-heading">
      <h2 id="surfaces-heading">Visible surfaces and workspaces</h2>
      <p class="copy">Labels and summaries are rendered as text only. Alfred may redact sensitive fields before they reach this UI.</p>
      <ul id="surfaces"><li class="empty">Not loaded.</li></ul>
    </section>
    <section aria-labelledby="events-heading">
      <h2 id="events-heading">Recent activity</h2>
      <p class="copy">Audit events are redaction-aware and persisted according to Alfred's local retention policy.</p>
      <ul id="events"><li class="empty">Not loaded.</li></ul>
    </section>
  </div>
</main>
<script>
(() => {
  const STORAGE_KEY = 'alfred.localToken';
  const tokenInput = document.getElementById('token');
  const status = document.getElementById('status');
  const surfaces = document.getElementById('surfaces');
  const drafts = document.getElementById('drafts');
  const events = document.getElementById('events');
  const health = document.getElementById('health');
  const endpoint = document.getElementById('endpoint');
  const lastRefresh = document.getElementById('last-refresh');
  const counts = document.getElementById('counts');
  const warnings = document.getElementById('warnings');
  const loop = document.getElementById('loop');

  tokenInput.value = localStorage.getItem(STORAGE_KEY) || '';
  endpoint.textContent = window.location.origin;

  function setStatus(message, tone = 'neutral') {
    status.textContent = message;
    status.className = tone === 'error' ? 'meta error' : tone === 'warning' ? 'meta warning' : 'meta';
  }

  function token() {
    return tokenInput.value.trim();
  }

  function authHeaders(json = false) {
    const headers = { 'x-alfred-auth': token() };
    if (json) headers['content-type'] = 'application/json';
    return headers;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.errors?.[0]?.message || response.statusText || 'Request failed';
      throw new Error(message);
    }
    return body;
  }

  function clearList(node, emptyText) {
    node.replaceChildren();
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = emptyText;
    node.append(item);
  }

  function line(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  function safeRedactedText(text) {
    if (!text) return '';
    const status = text.redaction?.status;
    if (status === 'contains_sensitive' || status === 'redacted') return '[redacted by Alfred]';
    return text.value || '';
  }

  function renderHealth(state, surfaceItems) {
    const healthText = state?.health || 'unknown';
    health.textContent = healthText;
    health.className = healthText === 'ok' ? 'ok' : healthText === 'degraded' ? 'warning' : '';
    lastRefresh.textContent = new Date().toLocaleTimeString();
    counts.textContent = (surfaceItems?.length || 0) + ' targets · ' + (state?.pendingDrafts?.length || 0) + ' drafts · ' + (state?.events?.length || 0) + ' events';
    warnings.replaceChildren();
    const items = state?.storageWarnings || [];
    if (!items.length) {
      warnings.textContent = 'Storage healthy. Pending drafts and raw transcripts remain ephemeral by design.';
      return;
    }
    for (const warning of items) {
      const banner = document.createElement('div');
      banner.className = 'banner';
      banner.textContent = warning;
      warnings.append(banner);
    }
  }

  function renderLoop(activeLoop) {
    loop.replaceChildren();
    if (!activeLoop) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No active daemon-owned loop. Start loops through the loop API or voice/Pi bridge when that bridge is enabled.';
      loop.append(empty);
      return;
    }
    const title = document.createElement('strong');
    title.textContent = activeLoop.target?.label || activeLoop.target?.ref || activeLoop.id;
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = activeLoop.status;
    const goal = line('meta', 'Goal: ' + safeRedactedText(activeLoop.goal));
    const meta = line('meta', 'Turns ' + activeLoop.turns + '/' + activeLoop.maxTurns + ' · started ' + activeLoop.startedAt + (activeLoop.lastActivityAt ? ' · last activity ' + activeLoop.lastActivityAt : '') + (activeLoop.observeMode ? ' · observe ' + activeLoop.observeMode : ''));
    loop.append(title, pill, goal, meta);
  }

  function renderSurfaces(targets) {
    surfaces.replaceChildren();
    if (!targets?.length) return clearList(surfaces, 'No cmux targets visible.');
    for (const target of targets.slice(0, 80)) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = target.label || target.ref;
      const meta = line('meta', target.kind + ' · ' + target.ref + (target.workspaceLabel ? ' · ' + target.workspaceLabel : '') + (target.current ? ' · current' : '') + (target.processKind ? ' · ' + target.processKind : ''));
      item.append(title, meta);
      surfaces.append(item);
    }
  }

  function renderDrafts(items) {
    drafts.replaceChildren();
    if (!items?.length) return clearList(drafts, 'No pending drafts. Drafts are intentionally not persisted across daemon restarts.');
    for (const draft of items) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = draft.target?.label || draft.target?.ref || draft.id;
      const text = document.createElement('pre');
      text.textContent = safeRedactedText(draft.text) || '[empty draft]';
      const expires = line('meta warning', 'Expires ' + draft.expiresAt + ' · created by ' + (draft.createdBy?.label || draft.createdBy?.kind || 'unknown'));
      const actions = document.createElement('div');
      actions.className = 'actions';
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'primary';
      confirm.textContent = 'Confirm send';
      confirm.addEventListener('click', () => confirmDraft(draft.id, draft.target?.label || draft.target?.ref || draft.id).catch((error) => setStatus(error.message, 'error')));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'danger';
      cancel.textContent = 'Cancel draft';
      cancel.addEventListener('click', () => cancelDraft(draft.id).catch((error) => setStatus(error.message, 'error')));
      actions.append(confirm, cancel);
      item.append(title, text, expires, actions);
      drafts.append(item);
    }
  }

  function renderEvents(items) {
    events.replaceChildren();
    if (!items?.length) return clearList(events, 'No recent activity.');
    for (const event of items.slice(0, 80)) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = event.summary || event.kind;
      const meta = line('meta', event.kind + ' · ' + event.createdAt + ' · retention ' + (event.retention?.policy || 'unknown') + ' · redaction ' + (event.redaction?.status || 'unknown'));
      item.append(title, meta);
      events.append(item);
    }
  }

  async function refresh() {
    if (!token()) {
      setStatus('Enter the local token printed in the daemon terminal before loading daemon state.', 'error');
      return;
    }
    setStatus('Refreshing authenticated daemon state...');
    const [state, surfaceData] = await Promise.all([api('/state'), api('/surfaces')]);
    const surfaceItems = surfaceData?.targets || [];
    renderHealth(state, surfaceItems);
    renderLoop(state?.activeLoop || null);
    renderSurfaces(surfaceItems);
    renderDrafts(state?.pendingDrafts || []);
    renderEvents(state?.events || []);
    setStatus('Updated ' + new Date().toLocaleTimeString() + '. API requests used the local auth header.');
  }

  async function confirmDraft(draftId, label) {
    if (!window.confirm('Send this pending draft to ' + label + '? This cannot be undone.')) return;
    setStatus('Confirming draft through authenticated /confirm...');
    await api('/confirm', { method: 'POST', body: JSON.stringify({ draftId }) });
    await refresh();
  }

  async function cancelDraft(draftId) {
    setStatus('Cancelling draft through authenticated /cancel...');
    await api('/cancel', { method: 'POST', body: JSON.stringify({ draftId, reason: 'dashboard cancel' }) });
    await refresh();
  }

  document.getElementById('save-token').addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEY, token());
    setStatus('Token saved in this browser only. It is still sent only as an auth header.');
  });
  document.getElementById('clear-token').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    tokenInput.value = '';
    setStatus('Token removed from localStorage.');
  });
  document.getElementById('refresh').addEventListener('click', () => refresh().catch((error) => setStatus(error.message, 'error')));
  if (token()) refresh().catch((error) => setStatus(error.message, 'error'));
})();
</script>
</body>
</html>`;
}
