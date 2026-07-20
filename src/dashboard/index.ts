export function renderDashboardHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alfred Local Dashboard</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg: #020712; --panel: rgba(8, 20, 34, 0.76); --panel-strong: rgba(10, 28, 48, 0.9); --border: rgba(105, 219, 255, 0.22); --border-strong: rgba(105, 219, 255, 0.48); --text: #ecfbff; --muted: #8fb3c7; --cyan: #66e7ff; --blue: #6aa8ff; --violet: #9d7cff; --danger: #ff5d7a; --warn: #ffd166; --ok: #71f6b1; --shadow: 0 24px 80px rgba(0, 0, 0, 0.45); }
* { box-sizing: border-box; }
html { min-width: 0; background: var(--bg); }
body { min-width: 0; margin: 0; padding: clamp(16px, 3vw, 32px); background: radial-gradient(circle at 16% 8%, rgba(102, 231, 255, 0.18), transparent 34rem), radial-gradient(circle at 82% 0%, rgba(157, 124, 255, 0.16), transparent 32rem), linear-gradient(135deg, #020712 0%, #07111f 48%, #020712 100%); color: var(--text); overflow-x: hidden; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(102, 231, 255, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(102, 231, 255, 0.035) 1px, transparent 1px); background-size: 44px 44px; mask-image: linear-gradient(to bottom, black, transparent 82%); }
body::after { content: ""; position: fixed; inset: 0; pointer-events: none; background: linear-gradient(180deg, transparent, rgba(102, 231, 255, 0.05) 50%, transparent); mix-blend-mode: screen; opacity: 0.55; }
header, main { position: relative; z-index: 1; width: min(100%, 1440px); margin-inline: auto; }
header { display: grid; gap: 18px; margin-bottom: 18px; }
h1 { margin: 0; font-size: clamp(2rem, 5vw, 4.8rem); line-height: 0.92; letter-spacing: -0.065em; text-transform: uppercase; text-shadow: 0 0 28px rgba(102, 231, 255, 0.22); }
h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 0.9rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); }
h2::before { content: ""; width: 9px; height: 9px; border-radius: 999px; background: var(--cyan); box-shadow: 0 0 14px var(--cyan); }
h3 { margin: 0 0 6px; font-size: 0.9rem; }
p { margin: 0; }
button, input, textarea { font: inherit; }
input, textarea { width: min(100%, 34rem); min-width: 0; padding: 11px 12px; border: 1px solid var(--border); border-radius: 12px; background: rgba(1, 8, 18, 0.82); color: var(--text); outline: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02); }
textarea { width: 100%; min-height: 7rem; margin-top: 8px; resize: vertical; }
input:focus, textarea:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(102, 231, 255, 0.12), inset 0 0 24px rgba(102, 231, 255, 0.05); }
button { padding: 10px 13px; cursor: pointer; border: 1px solid var(--border); border-radius: 12px; background: linear-gradient(180deg, rgba(102, 231, 255, 0.14), rgba(102, 231, 255, 0.04)); color: var(--text); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06); transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease; }
button:hover { border-color: var(--border-strong); box-shadow: 0 0 22px rgba(102, 231, 255, 0.12); transform: translateY(-1px); }
button.danger { color: var(--danger); border-color: rgba(255, 93, 122, 0.38); background: linear-gradient(180deg, rgba(255, 93, 122, 0.12), rgba(255, 93, 122, 0.03)); }
button.primary { color: #001018; border-color: rgba(113, 246, 177, 0.7); background: linear-gradient(135deg, var(--ok), var(--cyan)); font-weight: 800; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; color: var(--cyan); }
ul { min-width: 0; list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
li { min-width: 0; max-width: 100%; border: 1px solid rgba(105, 219, 255, 0.14); border-radius: 14px; padding: 12px; background: rgba(0, 9, 20, 0.34); overflow: hidden; overflow-wrap: anywhere; }
li strong, .metric strong { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.hero { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: clamp(18px, 4vw, 32px); border: 1px solid rgba(105, 219, 255, 0.2); border-radius: 28px; background: linear-gradient(135deg, rgba(102, 231, 255, 0.11), rgba(157, 124, 255, 0.06) 42%, rgba(2, 7, 18, 0.5)); box-shadow: var(--shadow); overflow: hidden; }
.hero::before { content: "ALFRED OS // LOCAL AGENT"; width: fit-content; color: var(--cyan); border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px; font-size: 0.74rem; letter-spacing: 0.16em; }
.copy { color: var(--muted); line-height: 1.52; overflow-wrap: anywhere; }
.token-card, section { min-width: 0; max-width: 100%; border: 1px solid var(--border); border-radius: 22px; padding: 16px; background: linear-gradient(180deg, var(--panel-strong), var(--panel)); box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,0.04); backdrop-filter: blur(18px); overflow: hidden; }
.token-card { position: relative; }
.token-card::after, section::after { content: ""; display: block; height: 1px; margin: 14px -16px -16px; background: linear-gradient(90deg, transparent, rgba(102, 231, 255, 0.42), transparent); }
.token-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 14px; min-width: 0; }
.token-row label { display: grid; gap: 6px; min-width: min(100%, 22rem); font-weight: 700; color: var(--text); }
.grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); align-items: start; min-width: 0; }
.grid > section { min-width: 0; }
.stack { display: grid; gap: 18px; min-width: 0; }
.status-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); min-width: 0; }
.metric { min-width: 0; border: 1px solid rgba(105, 219, 255, 0.14); border-radius: 16px; padding: 13px; background: rgba(0, 9, 20, 0.28); overflow: hidden; }
.metric strong { display: block; font-size: 1.04rem; }
.metric span, .meta { display: block; min-width: 0; margin-top: 5px; font-size: 0.84rem; color: var(--muted); overflow-wrap: anywhere; }
.pill { display: inline-flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; border-radius: 999px; padding: 4px 10px; margin-left: 8px; font-size: 0.78rem; border: 1px solid var(--border-strong); color: var(--cyan); background: rgba(102, 231, 255, 0.08); box-shadow: 0 0 18px rgba(102, 231, 255, 0.1); overflow-wrap: anywhere; }
.ok { color: var(--ok); }
.warning { color: var(--warn); }
.error { color: var(--danger); }
.empty { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.banner { border: 1px solid rgba(255, 209, 102, 0.46); border-radius: 14px; padding: 10px; color: var(--warn); background: rgba(255, 209, 102, 0.08); overflow-wrap: anywhere; }
pre { max-width: 100%; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; color: var(--muted); overflow: hidden; }
@media (max-width: 760px) { body { padding: 14px; } .token-row { display: grid; } button, input { width: 100%; } .pill { margin: 8px 0 0; } }
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
  <section aria-labelledby="ask-heading">
    <h2 id="ask-heading">Ask Alfred</h2>
    <p class="copy">Ask routes through <code>POST /ask</code>, the same authenticated pipeline used by legacy <code>/handle</code>. Sends still become pending action cards.</p>
    <textarea id="ask-input" spellcheck="true" placeholder="e.g. ask my Power Code session to run tests"></textarea>
    <div class="actions">
      <button id="ask-submit" class="primary" type="button">Ask Alfred</button>
    </div>
    <p id="ask-result" class="meta">No request sent yet.</p>
  </section>
  <div class="grid">
    <section aria-labelledby="loop-heading">
      <h2 id="loop-heading">Active loop</h2>
      <div id="loop"><p class="empty">No loop status loaded yet.</p></div>
    </section>
    <section aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Pending action cards</h2>
      <p class="copy">Review or edit before sending. Confirm and cancel buttons call authenticated APIs and never bypass draft-confirm.</p>
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
  const askInput = document.getElementById('ask-input');
  const askResult = document.getElementById('ask-result');

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
    counts.textContent = (surfaceItems?.length || 0) + ' targets · ' + (state?.pendingActions?.length || state?.pendingDrafts?.length || 0) + ' pending actions · ' + (state?.events?.length || 0) + ' events';
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
    const replies = line('meta', 'Replies: ' + (activeLoop.autonomousSend ? 'autonomous send' : 'draft + confirmation'));
    const meta = line('meta', 'Turns ' + activeLoop.turns + '/' + activeLoop.maxTurns + ' · started ' + activeLoop.startedAt + (activeLoop.lastActivityAt ? ' · last activity ' + activeLoop.lastActivityAt : '') + (activeLoop.observeMode ? ' · observe ' + activeLoop.observeMode : ''));
    loop.append(title, pill, goal, replies, meta);
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

  function renderPendingActions(actions, legacyDrafts) {
    drafts.replaceChildren();
    const items = actions?.length ? actions : legacyDrafts || [];
    if (!items?.length) return clearList(drafts, 'No pending actions. Pending actions are intentionally not persisted across daemon restarts.');
    const draftById = new Map((legacyDrafts || []).map((draft) => [draft.id, draft]));
    for (const pending of items) {
      const draft = draftById.get(pending.id) || (pending.text && pending.target ? pending : null);
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = pending.label || pending.actionMetaId || pending.target?.label || pending.id;
      const target = pending.target?.label || pending.target?.ref || draft?.target?.label || 'No target';
      const risk = pending.riskLevel || 'confirmation_required';
      const statusText = pending.status || draft?.status || 'pending';
      const meta = line('meta', 'Action ' + pending.id + ' · ' + (pending.actionMetaId || 'cmux.sendText') + ' · risk ' + risk + ' · status ' + statusText + ' · target ' + target);
      const expires = line('meta warning', 'Expires ' + (pending.expiresAt || draft?.expiresAt || 'unknown') + ' · proposed by ' + (pending.proposedBy?.label || pending.proposedBy?.kind || draft?.createdBy?.label || draft?.createdBy?.kind || 'unknown'));
      item.append(title, meta, expires);

      let editedText;
      const isSendText = (pending.actionMetaId || '') === 'cmux.sendText' || Boolean(draft?.text);
      if (isSendText) {
        const text = document.createElement('textarea');
        const redactionStatus = draft?.text?.redaction?.status;
        const editableText = Boolean(pending.editable ?? true) && redactionStatus !== 'contains_sensitive' && redactionStatus !== 'redacted';
        text.value = editableText ? (draft?.text?.value || '') : '';
        text.placeholder = editableText ? '' : '[redacted by Alfred; edit disabled]';
        text.disabled = !editableText;
        text.setAttribute('aria-label', 'Editable pending action text for ' + target);
        editedText = text;
        item.append(text);
      } else {
        const previewLabel = line('meta', 'Preview payload');
        const preview = document.createElement('pre');
        preview.textContent = pending.preview ? JSON.stringify(pending.preview, null, 2) : 'Preview unavailable.';
        item.append(previewLabel, preview);
      }

      const actionsNode = document.createElement('div');
      actionsNode.className = 'actions';
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'primary';
      confirm.textContent = isSendText ? 'Confirm send' : 'Approve action';
      confirm.addEventListener('click', () => confirmPendingAction(pending.id, target, editedText?.disabled ? undefined : editedText?.value).catch((error) => setStatus(error.message, 'error')));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'danger';
      cancel.textContent = isSendText ? 'Cancel draft' : 'Cancel action';
      cancel.addEventListener('click', () => cancelPendingAction(pending.id).catch((error) => setStatus(error.message, 'error')));
      actionsNode.append(confirm, cancel);
      item.append(actionsNode);
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

  function dashboardSource() {
    return {
      kind: 'web-ui',
      id: 'dashboard',
      label: 'Alfred dashboard',
      trustedLocalOnly: true,
      userIntent: 'typed',
      capabilities: ['world.read', 'surface.read', 'surface.send', 'workspace.send', 'loop.manage', 'history.read', 'history.write', 'config.read'],
      presentation: { wantsText: true, style: 'plain' }
    };
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
    renderPendingActions(state?.pendingActions || [], state?.pendingDrafts || []);
    renderEvents(state?.events || []);
    setStatus('Updated ' + new Date().toLocaleTimeString() + '. API requests used the local auth header.');
  }

  async function confirmPendingAction(pendingActionId, label, text) {
    if (!window.confirm('Approve this pending action for ' + label + '? This cannot be undone.')) return;
    setStatus('Approving pending action through authenticated /confirm...');
    await api('/confirm', { method: 'POST', body: JSON.stringify({ pendingActionId, text }) });
    await refresh();
  }

  async function cancelPendingAction(pendingActionId) {
    setStatus('Cancelling pending action through authenticated /cancel...');
    await api('/cancel', { method: 'POST', body: JSON.stringify({ pendingActionId, reason: 'dashboard cancel' }) });
    await refresh();
  }

  async function askAlfred() {
    if (!token()) {
      setStatus('Enter the local token before asking Alfred.', 'error');
      return;
    }
    const text = askInput.value.trim();
    if (!text) {
      askResult.textContent = 'Type a request first.';
      return;
    }
    setStatus('Sending Ask Alfred request through authenticated /ask...');
    const requestId = 'dashboard_' + Date.now().toString(36);
    const result = await api('/ask', {
      method: 'POST',
      body: JSON.stringify({
        requestId,
        createdAt: new Date().toISOString(),
        source: dashboardSource(),
        input: { text },
        policy: { requireConfirmationForSend: true }
      })
    });
    askResult.textContent = result.displayText || 'Alfred handled the request.';
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
  document.getElementById('ask-submit').addEventListener('click', () => askAlfred().catch((error) => setStatus(error.message, 'error')));
  if (token()) refresh().catch((error) => setStatus(error.message, 'error'));
})();
</script>
</body>
</html>`;
}
