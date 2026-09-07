'use strict';
// This client keeps only its short-lived app capability in tab-scoped storage.
// Source content and search results stay in memory and are rendered as text.
const SESSION_KEY = 'kizuki.app.session';
const main = document.getElementById('main');
const dialog = document.getElementById('dialog');
const notice = document.getElementById('notification');
const state = { view: 'memory', status: null, service: null, model: null, modelError: false, agents: null, agentsError: false, sources: [], catalog: [], receipts: [], hits: null, query: '', degraded: [], busy: false, operation: null };
let bearer = null;
let noticeTimer;
let dialogCleanup = null;
let refreshSequence = 0;
let searchSequence = 0;
let pulseRunning = false;
let privacyGeneration = 0;
let activitySequence = 0;
let serviceSequence = 0;
let modelSequence = 0;
let agentsSequence = 0;
let privateViewValid = true;
const icons = {
  memory: ['M7 3.5h10a2 2 0 0 1 2 2v15l-7-3-7 3v-15a2 2 0 0 1 2-2Z', 'M9 8h6M9 11.5h4'],
  sources: ['M5 4h4v4H5zM15 16h4v4h-4zM4 16h5v4H4z', 'M7 8v3a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3M7 14v2M15 4h5v5h-5zM15 7h-3a5 5 0 0 0-5 5'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  settings: ['M5 4v16M12 4v16M19 4v16', 'M3 8h4M10 16h4M17 9h4'],
  folder: ['M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  mail: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z', 'm3 6 9 7 9-7'],
  calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M8 3v4M16 3v4', 'M8 14h2M14 14h2M8 17h2'],
  search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z', 'm16 16 5 5'],
  lock: ['M7 10V7a5 5 0 0 1 10 0v3M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z', 'M12 14v3'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  check: ['m5 12 4 4L19 6'],
  close: ['m6 6 12 12M18 6 6 18'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v6M12 7h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
  for (const d of icons[name] || icons.info) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    for (const [key, value] of Object.entries({ d, stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
    svg.append(path);
  }
  return svg;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'checked') node[key] = !!value;
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false && child !== true) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(text, run, kind = 'secondary', extra = {}) { return el('button', { type: 'button', class: `button button-${kind}`, onclick: run, ...extra }, text); }
function message(text) { clearTimeout(noticeTimer); notice.textContent = text; notice.hidden = false; noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500); }
function dateText(value) { if (!value) return 'Not captured yet'; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Time unavailable'; }
function providerIcon(id) { return id.includes('calendar') ? 'calendar' : id.includes('gmail') ? 'mail' : 'folder'; }
function resultTitle(hit) {
  if (hit.scope === 'canon' && /^[a-f0-9]{64}$/i.test(String(hit.title))) return 'Memory page';
  if (hit.scope === 'ledger' && String(hit.title).startsWith('kizuki.')) {
    const first = String(hit.text).split(/\r?\n/, 1)[0].trim();
    if (/^#{1,6}\s+/.test(first)) return first.replace(/^#{1,6}\s+/, '').slice(0, 160);
    return hit.title.includes('markdown') ? 'Local notes' : hit.title.includes('calendar') ? 'Calendar evidence' : hit.title.includes('gmail') ? 'Mail evidence' : 'Source evidence';
  }
  return hit.title || 'Saved information';
}
function sourceLabel(source) {
  const name = source.connector_id.includes('markdown') ? 'Local notes' : source.connector_id.includes('google-calendar') ? 'Google Calendar' : source.connector_id.includes('gmail') ? 'Gmail' : source.display_name;
  const key = source.source_key;
  let length = Math.min(8, key.length);
  while (length < key.length && state.sources.some(other => other.source_key !== key && other.source_key.slice(-length) === key.slice(-length))) length++;
  return `${name} · ${key.slice(-length)}`;
}
function staleResponse() { return Object.assign(new Error('Response superseded.'), { code: 'stale_response' }); }
function invalidatePrivateView() {
  privacyGeneration++; refreshSequence++; searchSequence++; activitySequence++; serviceSequence++; modelSequence++; agentsSequence++;
  privateViewValid = false;
  state.busy = false; state.hits = null; state.query = ''; state.degraded = []; state.sources = []; state.receipts = []; state.service = null; state.model = null; state.modelError = false; state.agents = null; state.agentsError = false; state.operation = null;
  clearDialogTransient();
  if (dialog.open) closeDialog();
  dialog.replaceChildren();
  clearTimeout(noticeTimer); notice.textContent = ''; notice.hidden = true;
  main.replaceChildren();
}
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—'; }
function humanError(code) {
  if (code === 'service_unavailable') return 'Your workspace is saved, but background activity needs attention. Open Settings to check it and retry.';
  if (code === 'invalid_request') return 'Check the selected fields and entered details, then try again.';
  if (code === 'unauthorized') return 'This app session has ended. Open Kizuki again on this device to reconnect.';
  if (/revision|conflict|stale|busy/.test(code)) return 'Something changed while you were working. Refresh to check the current state, then try again.';
  if (/consent|grant|source_capture_denied/.test(code)) return 'This source needs your permission before Kizuki can use it. Review its privacy settings to continue.';
  if (/duplicate|identity/.test(code)) return 'This account or folder may already be connected. Check your existing sources before trying again.';
  if (/config|unavailable/.test(code)) return 'This connection needs a little setup on this device. Check its setup details, then try again.';
  if (/timeout|unknown/.test(code)) return 'This step has not confirmed completion. Refresh to check its state before trying again.';
  return 'This step could not be completed. Refresh to check its current state before trying again.';
}
async function api(route, payload = {}) {
  if (!bearer) throw Object.assign(new Error(humanError('unauthorized')), { code: 'unauthorized' });
  const session = bearer, generation = privacyGeneration;
  const current = () => session === bearer && generation === privacyGeneration;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/app/v1/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!current()) throw staleResponse();
    if (response.status === 401) { disconnect(); throw Object.assign(new Error(humanError('unauthorized')), { code: 'unauthorized' }); }
    const result = await response.json();
    if (!current()) throw staleResponse();
    if (!result.ok) throw Object.assign(new Error(humanError(result.error?.code || 'error')), { code: result.error?.code || 'error' });
    return result.data;
  } catch (error) {
    if (!current()) throw staleResponse();
    if (error?.code) throw error;
    throw Object.assign(new Error('Kizuki is not responding. Your operation may still be running; reopen or refresh to check its state.'), { code: 'transport' });
  } finally { clearTimeout(timer); }
}
function disconnect() {
  invalidatePrivateView();
  bearer = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  state.hits = null; state.sources = []; state.receipts = []; state.status = null; state.operation = null;
  if (dialog.open) closeDialog();
  renderDisconnected();
}
function renderDisconnected() {
  main.replaceChildren(el('section', { class: 'empty-state' }, icon('lock'), el('h2', {}, 'Open Kizuki to continue'), el('p', {}, 'This private workspace opens from the Kizuki app on your device. Close this tab and open the app again to reconnect.')));
}
function navigate(view, focus = true) {
  if (!['memory', 'sources', 'activity', 'settings'].includes(view)) return;
  if (dialog.open) closeDialog();
  state.view = view;
  render();
  if (focus) main.focus({ preventScroll: true });
  if (view === 'activity' && state.status?.vault.ready) loadActivity();
  if (view === 'settings' && state.status?.vault.ready) { loadService(); loadAgents(); }
  if (['settings', 'sources'].includes(view) && state.status?.vault.ready) loadModel();
}
function renderNavigation() {
  document.getElementById('navigation').replaceChildren(...[['memory', 'Memory'], ['sources', 'Sources'], ['activity', 'Activity'], ['settings', 'Settings']].map(([id, title]) => el('a', { class: 'nav-link', href: `#${id}`, 'aria-current': state.view === id ? 'page' : undefined, onclick: event => { event.preventDefault(); navigate(id); } }, icon(id), title)));
  document.getElementById('view-label').textContent = state.view.charAt(0).toUpperCase() + state.view.slice(1);
}
function heading(title, description, action) { return el('div', { class: 'page-heading' }, el('div', {}, el('h1', {}, title), description && el('p', {}, description)), action); }
function empty(title, description, action) { return el('section', { class: 'empty-state' }, icon('memory'), el('h2', {}, title), el('p', {}, description), action); }
function welcomeIllustration() {
  const box = el('div', { class: 'welcome-illustration', 'aria-hidden': 'true' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 720 145');
  const shape = (tag, attrs) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
  shape('path', { d: 'M126 73H580', stroke: 'var(--line)', 'stroke-width': '1.5', 'stroke-dasharray': '3 7', fill: 'none' });
  for (const [x,y,width,height] of [[66,42,70,64],[171,27,74,83],[461,34,73,76],[577,47,69,60]]) {
    shape('rect', { x, y, width, height, rx: 12, fill: 'var(--canvas)', stroke: 'var(--line)', class: 'illustration-sheet' });
    shape('path', { d: `M${x+17} ${y+22}h${width-34}M${x+17} ${y+33}h${width-40}`, stroke: 'var(--quiet)', 'stroke-width': '2', 'stroke-linecap': 'round', opacity: '.45' });
  }
  shape('rect', { x: '312', y: '22', width: '96', height: '96', rx: '25', fill: 'var(--canvas)', stroke: 'var(--line)', class: 'illustration-sheet' });
  shape('path', { d: 'M342 44v51M378 44l-27 25 27 26', fill: 'none', stroke: 'var(--ink)', 'stroke-width': '4.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  shape('circle', { cx: '378', cy: '44', r: '4', fill: 'var(--accent)' }); box.append(svg); return box;
}
function renderWelcome() {
  const ready = state.status?.vault.ready;
  return el('section', { class: 'welcome' }, el('div', { class: 'eyebrow' }, 'A little less to remember'), el('h1', {}, 'Make room for', el('br'), 'what matters.'), el('p', {}, 'Bring your notes and everyday information into one private place. Find the original, see what changed, and stay in control.'), welcomeIllustration(),
    el('div', { class: 'setup-card' }, el('div', { class: 'setup-card-body' }, el('div', {}, el('h2', {}, ready ? 'Start with one source.' : 'Your memory starts here.'), el('p', {}, ready ? 'Choose a folder or an account. You decide what Kizuki can keep before anything is imported.' : 'Create a private workspace on this device. You can connect your first source when you’re ready.')), button(ready ? 'Connect a source' : 'Create my Kizuki', () => ready ? navigate('sources') : initialize(), 'primary')), el('div', { class: 'setup-card-footer' }, icon('lock'), ready ? 'Your files stay yours. No model is needed to capture and search.' : `Saved on this device${state.status?.setup_location ? ` · ${state.status.setup_location}` : ''}`)),
    !ready && el('p', {}, state.status?.setup_supervisor === 'none' ? 'Background activity is unavailable on this device. You can capture and search while the app is open.' : state.status?.setup_no_service ? 'Background activity is turned off for this setup. You can enable it later in Settings.' : 'Kizuki will keep your permitted sources up to date in the background, even after you close the app.'),
    !ready && el('details', { class: 'result-details' }, el('summary', {}, 'Setup options'), el('div', { class: 'form-field' }, el('label', { for: 'setup-path' }, 'Workspace folder'), el('input', { id: 'setup-path', type: 'text', placeholder: state.status?.setup_location || 'Full folder path', autocomplete: 'off', spellcheck: 'false' }), el('small', {}, 'Use a new empty folder. Existing folders are never adopted automatically.')), el('label', { class: 'check-row', for: 'setup-no-service' }, el('input', { id: 'setup-no-service', type: 'checkbox', checked: state.status?.setup_no_service, disabled: state.status?.setup_no_service }), 'Turn off background activity for now')),
    el('div', { class: 'getting-started' }, ...[['01', 'Connect once', 'Choose the information you want to bring along.'], ['02', 'Find it again', 'Search your saved sources, even without a model.'], ['03', 'Keep control', 'Inspect changes, undo them, or remove a source.']].map(([n,t,d]) => el('div', {}, el('span', { class: 'step-number' }, n), el('h3', {}, t), el('p', {}, d)))));
}
async function initialize() {
  const path = document.getElementById('setup-path')?.value.trim();
  const no_service = document.getElementById('setup-no-service')?.checked === true;
  await launchOperation('initialize', { ...(path ? { path } : {}), no_service }, 'Creating your workspace', async () => { await refresh(); message('Your Kizuki is ready. Choose your first source. Background activity is shown in Settings.'); navigate('sources'); });
}
function renderMemory() {
  if (!state.status?.vault.ready || state.sources.length === 0) return renderWelcome();
  const field = el('input', { id: 'memory-query', type: 'search', placeholder: 'Find something you remember…', 'aria-label': 'Search your memory', autocomplete: 'off', spellcheck: 'false', maxlength: '2000' }); field.value = state.query;
  const form = el('form', { class: 'search-form', onsubmit: event => { event.preventDefault(); search(field.value); } }, icon('search'), field, el('button', { class: 'button button-primary', type: 'submit', disabled: state.busy }, 'Search'));
  const section = el('section', {}, heading('Your memory.', 'The original information, with a clear path back to its source.', button('Organise now', runPass)), form, el('p', { class: 'search-hint' }, 'Search works on this device. Organising memory pages needs a model and separate permission for each source.'));
  if (state.busy) section.append(el('div', { class: 'opening', 'aria-busy': 'true', 'aria-label': 'Searching your memory' }, el('div', { class: 'skeleton skeleton-line' }), el('div', { class: 'skeleton skeleton-panel' })));
  else if (state.hits === null) section.append(empty('A place to find things again.', 'Search for a name, a phrase, or a detail from a source you’ve imported.'));
  else if (!state.hits.length) section.append(empty('Nothing matched this search.', 'Try a more specific word from the original source, or check that the source has finished importing.', button('Check sources', () => navigate('sources'))));
  else {
    section.append(el('div', { class: 'section-header' }, el('h2', {}, 'From your sources'), el('span', {}, `${state.hits.length} ${state.hits.length === 1 ? 'result' : 'results'}`)));
    const list = el('div', { class: 'result-list' });
    for (const hit of state.hits) {
      const citations = Array.isArray(hit.citations) ? hit.citations : [];
      list.append(el('article', { class: 'result-item' }, el('div', { class: 'result-meta' }, el('span', { class: 'badge' }, hit.scope === 'canon' ? 'Memory page' : 'Source evidence'), el('span', {}, hit.sensitivity === 'public' ? 'Public' : hit.sensitivity === 'internal' ? 'Internal' : 'Private')), el('h3', {}, resultTitle(hit)), el('p', { class: 'result-text' }, hit.text), el('details', { class: 'result-details' }, el('summary', {}, 'View evidence references'), el('p', {}, 'Use these references to check the original information.'), ...citations.map(id => el('p', {}, el('code', {}, id)))), hit.scope === 'canon' && button('Correct memory', () => correction(hit))));
    }
    section.append(list);
  }
  if (state.degraded.length) section.append(el('div', { class: 'status-note' }, icon('info'), el('p', {}, 'Search is using an available local path. Some optional capabilities are unavailable; these results are not a complete view of every connected source.')));
  return section;
}
async function correction(hit) {
  if (hit.scope !== 'canon' || !privateViewValid || !bearer) return;
  const content = openDialog('Correct this memory', 'Checking the visible beliefs recorded for this memory page…', 'memory');
  let claims = [], disposed = false, previewSequence = 0, preview = null;
  let choice, statement, value, beliefDetails, previewPanel, apply;
  dialogCleanup = () => {
    disposed = true; previewSequence++; preview = null; claims.length = 0; claims = [];
    if (statement) statement.value = ''; if (value) value.value = '';
    if (choice) { choice.value = ''; choice.replaceChildren(); }
    beliefDetails?.replaceChildren(); previewPanel?.replaceChildren(); content.replaceChildren();
  };
  const current = () => !disposed && privateViewValid && bearer && dialog.open && dialog.contains(content);
  try {
    const targets = await api('correction_targets', { page_id: hit.id });
    if (!current()) return;
    claims = targets.claims;
    content.querySelector('.dialog-description').textContent = 'Choose one recorded belief. Corrections change your memory pages; quoted source information stays unchanged.';
    if (!claims.length) { content.append(el('p', { class: 'status-note' }, 'No correctable beliefs are available for this page under your current permissions.')); return; }
    if (targets.truncated) content.append(el('p', { class: 'status-note' }, 'This list is limited. Additional beliefs may exist for this page.'));
    const form = el('form'); content.append(form);
    choice = el('select', { id: 'correction-claim' }, ...claims.map(claim => el('option', { value: claim.claim_id }, claim.body.slice(0, 120)))); choice.value = claims[0].claim_id;
    form.append(el('div', { class: 'form-field' }, el('label', { for: 'correction-claim' }, 'Recorded belief'), choice));
    beliefDetails = el('div', { class: 'belief-details' }); form.append(beliefDetails);
    const selected = () => claims.find(claim => claim.claim_id === choice.value);
    const showBelief = () => {
      const claim = selected(); beliefDetails.replaceChildren(); if (!claim) return;
      beliefDetails.append(el('blockquote', {}, claim.body), el('dl', { class: 'grant-summary' }, ...[['Subject', claim.subject], ['Relationship', claim.predicate], ['Current value', claim.object]].map(([label, item]) => el('div', {}, el('dt', {}, label), el('dd', {}, item)))), el('details', { class: 'result-details' }, el('summary', {}, 'Belief reference'), el('code', {}, claim.claim_id), el('p', {}, `Recorded authority: ${claim.authority} · Privacy: ${claim.sensitivity}`)));
    }; showBelief();
    const mode = el('select', { id: 'correction-mode' }, el('option', { value: 'deny' }, 'Deny this belief'), el('option', { value: 'replace' }, 'Replace its value')); mode.value = 'deny';
    form.append(el('div', { class: 'form-field' }, el('label', { for: 'correction-mode' }, 'What should change?'), mode), el('p', { class: 'model-note' }, 'Deny marks this belief as wrong without asserting a replacement. Replace uses the exact new value you enter below.'));
    const replacement = el('div'); value = field(replacement, 'New value', 'correction-value', 'The exact replacement value'); value.setAttribute('maxlength', '1024'); replacement.hidden = true; form.append(replacement);
    statement = el('textarea', { id: 'correction-statement', rows: '3', maxlength: '2000', placeholder: 'Explain the correction in your own words.', autocomplete: 'off' });
    form.append(el('div', { class: 'form-field' }, el('label', { for: 'correction-statement' }, 'Your correction'), statement));
    const errorLine = el('p', { class: 'form-error', role: 'alert' });
    const previewButton = el('button', { type: 'submit', class: 'button button-secondary' }, 'Preview correction');
    previewPanel = el('div', { class: 'correction-preview', 'aria-live': 'polite', tabindex: '-1' });
    const invalidatePreview = () => { previewSequence++; preview = null; previewPanel.replaceChildren(); previewButton.disabled = false; if (apply) apply.disabled = true; errorLine.textContent = ''; };
    for (const input of [choice, mode, statement, value]) { input.addEventListener('input', invalidatePreview); input.addEventListener('change', invalidatePreview); }
    choice.addEventListener('change', showBelief);
    mode.addEventListener('change', () => { replacement.hidden = mode.value !== 'replace'; if (replacement.hidden) value.value = ''; });
    const request = () => {
      const claim = selected();
      if (!claim) throw new Error('Choose a recorded belief before previewing.');
      if (!['deny', 'replace'].includes(mode.value)) throw new Error('Choose whether to deny this belief or replace its value.');
      if (!statement.value.trim() || statement.value.length > 2000) throw new Error('Explain the correction in your own words, using up to 2,000 characters.');
      if (mode.value === 'replace' && (!value.value.trim() || value.value.length > 1024)) throw new Error('Enter an explicit new value, using up to 1,024 characters.');
      return { claim_id: claim.claim_id, statement: statement.value, ...(mode.value === 'replace' ? { object: value.value } : {}) };
    };
    apply = button('Apply correction', async () => {
      if (!current() || !preview) return;
      let payload; try { payload = request(); } catch (error) { invalidatePreview(); errorLine.textContent = error.message; return; }
      if (JSON.stringify(payload) !== JSON.stringify(preview.request)) { invalidatePreview(); errorLine.textContent = 'The correction changed. Preview it again before applying.'; return; }
      await launchOperation('correct', payload, 'Applying your correction', async operation => {
        await refresh();
        if (bearer && privateViewValid && state.operation?.id === operation.id) navigate('activity');
      });
    }, 'primary', { disabled: true });
    form.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', closeDialog), previewButton), previewPanel, el('div', { class: 'form-actions' }, apply));
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!current()) return;
      invalidatePreview();
      let payload; try { payload = request(); } catch (error) { errorLine.textContent = error.message; return; }
      const sequence = ++previewSequence; previewButton.disabled = true;
      try {
        const result = await api('correction_preview', payload);
        if (!current() || sequence !== previewSequence) return;
        preview = { request: payload };
        const count = result.affected_pages;
        previewPanel.replaceChildren(el('h3', {}, 'Preview'), el('p', {}, result.answer), el('p', {}, Number.isSafeInteger(count) && count >= 0 ? `${safeCount(count)} memory ${count === 1 ? 'page' : 'pages'} currently affected.` : 'Current affected-page count unavailable.'), el('p', { class: 'model-note' }, 'Applying checks your current permissions again. The result may differ if the memory or source permissions change.'));
        apply.disabled = false;
        previewPanel.focus({ preventScroll: true }); apply.scrollIntoView({ block: 'nearest' });
      } catch (error) { if (current() && sequence === previewSequence && error.code !== 'stale_response') errorLine.textContent = error.message; }
      finally { if (current() && sequence === previewSequence) previewButton.disabled = false; }
    });
  } catch (error) { if (current() && error.code !== 'stale_response') content.append(el('p', { class: 'form-error', role: 'alert' }, error.message)); }
}
async function search(text) {
  const query = text.trim(); if (!query || state.busy || !privateViewValid || !bearer) return;
  state.busy = true; state.query = query; state.hits = null;
  const sequence = ++searchSequence, epoch = state.status?.visibility_epoch;
  render();
  try { const data = await api('query', { text: query, limit: 20 }); if (sequence === searchSequence && epoch === state.status?.visibility_epoch) { state.hits = data.hits; state.degraded = data.degraded || []; } }
  catch (error) { if (sequence === searchSequence && error.code !== 'stale_response') message(error.message); }
  finally { if (sequence === searchSequence) { state.busy = false; if (bearer) render(); } }
}
function renderSources() {
  if (!state.status?.vault.ready) return renderWelcome();
  const section = el('section', {}, heading('Your sources.', 'Connect the parts of your life you want to remember. Each source has its own permission and history.'));
  if (state.sources.length) {
    const list = el('div', { class: 'source-list' });
    for (const source of state.sources) {
      const active = source.consent === 'active';
      const removing = source.consent === 'denied';
      const status = active ? 'Permission granted' : source.consent === 'purged' ? 'Removed' : removing ? 'Removal pending' : 'Needs permission';
      const row = el('div', { class: 'source-row' }, el('div', { class: 'source-icon' }, icon(providerIcon(source.connector_id))), el('div', { class: 'source-info' }, el('h3', {}, sourceLabel(source)), el('p', {}, el('span', { class: `badge${active ? ' badge-active' : ''}` }, status)), el('p', {}, `${safeCount(source.stored)} new in the last check · ${dateText(source.last_run)}`), source.errors > 0 && el('p', {}, 'The last capture reported a problem. Check before relying on complete coverage.')));
      const actions = el('div', { class: 'source-actions' });
      if (active) actions.append(button('Import history', () => capture(source)), button('Privacy', () => privacy(source)));
      else if (removing) actions.append(button('Check removal', () => resumeRemoval(source)));
      else if (source.consent !== 'purged') actions.append(button('Review permission', () => consent(source), 'primary'));
      row.append(actions);
      const card = el('div', { class: 'source-card' }, row);
      if (active) card.append(sourceModelControls(source));
      list.append(card);
    }
    section.append(el('div', { class: 'section-header' }, el('h2', {}, 'Connected')), list);
  }
  section.append(el('div', { class: 'section-header' }, el('h2', {}, state.sources.length ? 'Add another source' : 'Choose your first source')));
  const catalog = el('div', { class: 'source-list' });
  for (const provider of state.catalog) catalog.append(el('div', { class: 'source-row' }, el('div', { class: 'source-icon' }, icon(providerIcon(provider.id))), el('div', { class: 'source-info' }, el('h3', {}, provider.title), el('p', {}, provider.id === 'markdown' ? 'Your Markdown notes, kept in a folder you choose.' : provider.id === 'gmail' ? 'Selected mail content, with a link back to its history.' : 'Selected calendar events and their changes.')), el('div', { class: 'source-actions' }, button(provider.available ? 'Connect' : 'Setup details', () => enrollment(provider), provider.available ? 'primary' : 'secondary'))));
  section.append(catalog, el('div', { class: 'status-note' }, icon('lock'), el('p', {}, 'Nothing is captured just by connecting. You choose the fields and give this source permission before Kizuki imports its history. Provider history and deletion coverage vary.')));
  return section;
}
function clearDialogSecrets() { const key = dialog.querySelector('#model-key'); if (key) key.value = ''; }
function clearDialogTransient() { clearDialogSecrets(); const cleanup = dialogCleanup; dialogCleanup = null; if (cleanup) cleanup(); }
function closeDialog() { clearDialogTransient(); dialog.close(); }
dialog.addEventListener('cancel', clearDialogTransient);
dialog.addEventListener('close', () => { if (!dialog.open) clearDialogTransient(); });
function openDialog(title, description, symbol = 'info') {
  if (dialog.open) closeDialog();
  const content = el('div', {}, el('div', { class: 'dialog-top' }, el('div', {}, el('div', { class: 'source-icon' }, icon(symbol)), el('h2', { id: 'dialog-title' }, title)), el('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close dialog', onclick: () => closeDialog() }, icon('close'))), el('p', { class: 'dialog-description' }, description));
  dialog.replaceChildren(content); dialog.showModal(); return content;
}
function field(parent, label, id, placeholder = '', type = 'text') {
  const input = el('input', { id, type, placeholder, autocomplete: 'off', spellcheck: 'false' });
  parent.append(el('div', { class: 'form-field' }, el('label', { for: id }, label), input)); return input;
}
function enrollment(provider) {
  const content = openDialog(`Connect ${provider.title}`, provider.detail, providerIcon(provider.id));
  if (!provider.available) { content.append(el('div', { class: 'form-actions' }, button('Done', () => closeDialog(), 'primary'))); return; }
  const form = el('form'); content.append(form);
  let path, calendar;
  if (provider.id === 'markdown') { path = field(form, 'Folder location', 'source-path', '/path/to/your/notes'); form.append(el('small', {}, 'Choose an existing folder of Markdown files outside your Kizuki workspace. Original files stay in place.')); }
  if (provider.id === 'google-calendar') { calendar = field(form, 'Calendar ID', 'calendar-id', 'The calendar’s exact ID'); form.append(el('small', {}, 'Find this in Google Calendar settings under Integrate calendar. Calendar discovery is not available yet.')); }
  const selected = [];
  if (provider.id !== 'markdown' && provider.fields.length) {
    const choices = el('fieldset', { class: 'field-choices' }, el('legend', {}, 'Information to keep'));
    for (const name of provider.fields) { const check = el('input', { type: 'checkbox', value: name, checked: name !== 'attachments', id: `field-${name}` }); selected.push(check); choices.append(el('label', { class: 'check-row', for: `field-${name}` }, check, name.charAt(0).toUpperCase() + name.slice(1))); }
    form.append(choices);
  }
  if (provider.id !== 'markdown') content.append(el('p', { class: 'dialog-description' }, provider.id === 'gmail' ? 'Google grants read-only mail access. Kizuki keeps only your selected fields. Sign-in opens Google in your system browser.' : 'Google grants read-only access to events on all calendars. Kizuki reads only the calendar you selected and keeps selected fields plus required identity and schedule metadata.'));
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'button button-primary' }, provider.id === 'markdown' ? 'Connect folder' : 'Continue to Google');
  form.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', () => closeDialog()), submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (path && !path.value.trim()) { errorLine.textContent = 'Enter the full path to your notes folder.'; path.focus(); return; }
    if (calendar && !calendar.value.trim()) { errorLine.textContent = 'Enter the exact calendar ID to continue.'; calendar.focus(); return; }
    if (provider.id === 'gmail' && !selected.some(x => x.checked)) { errorLine.textContent = 'Choose at least one kind of information to keep.'; selected[0]?.focus(); return; }
    const payload = { provider: provider.id, ...(provider.id !== 'markdown' ? { new_source: true } : {}), ...(path ? { path: path.value.trim() } : {}), ...(calendar ? { calendar_id: calendar.value.trim() } : {}), ...(selected.length ? { fields: selected.filter(x => x.checked).map(x => x.value) } : {}) };
    submit.disabled = true;
    await launchOperation('enroll', payload, provider.id === 'markdown' ? 'Connecting your folder' : 'Waiting for Google sign-in', async operation => {
      await refresh();
      const source = state.sources.find(x => x.source_key === operation.result?.source_key);
      if (source) consent(source); else { navigate('sources'); message('Connected. Review this source’s permission to import it.'); }
    });
  });
}
function consent(source) {
  const content = openDialog('Choose what Kizuki can use.', `Give ${sourceLabel(source)} permission to store selected information and make it available in your private memory.`, 'lock');
  content.append(el('div', { class: 'consent-summary' }, ...[['Use', 'Save and find this source'], ['Fields', source.required_fields.join(', ')], ['Privacy', 'Private, on this device'], ['Retention', 'Kept until you remove this source'], ['Backups', 'Included in exports you choose to create']].map(([label, value]) => el('div', {}, el('span', {}, label), el('strong', {}, value)))));
  content.append(el('p', { class: 'dialog-description' }, 'This permission does not let a model use source data. Removing this source stops further use and begins removal from Kizuki’s owned stores. Your original files and provider account remain yours.'));
  const request = { source_key: source.source_key, expected_revision: source.revision, operation_id: crypto.randomUUID(), policy: { purposes: ['capture','recall','session','correction','audit','derive','extract','export'], allowed_fields: source.required_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } };
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const allow = button('Allow and import', async () => {
    allow.disabled = true; errorLine.textContent = '';
    try { await api('consent', request); closeDialog(); await refresh(); await capture(source); }
    catch (error) { errorLine.textContent = error.message; allow.disabled = false; }
  }, 'primary');
  content.append(errorLine, el('div', { class: 'form-actions' }, button('Not now', () => closeDialog()), allow));
}
async function capture(source) { await launchOperation('capture', { source_key: source.source_key, mode: 'backfill' }, 'Importing your history', async operation => { await refresh(); navigate('memory'); message(operation.counts ? `${safeCount(operation.counts.stored)} saved · ${safeCount(operation.counts.duplicates)} already present${operation.counts.errors ? ` · ${safeCount(operation.counts.errors)} problems reported` : ''}` : 'Capture completed. Check Sources for its latest coverage.'); }); }
function privacy(source) {
  const content = openDialog('This source stays under your control.', sourceLabel(source), 'lock');
  content.append(el('div', { class: 'consent-summary' }, ...[['Current permission', source.consent], ['Fields needed by this connection', source.required_fields.join(', ')], ['Last capture', dateText(source.last_run)]].map(([label,value]) => el('div', {}, el('span', {}, label), el('strong', {}, value)))), el('p', { class: 'dialog-description' }, 'Remove this source to stop capture and start deleting its information from Kizuki. Removal may wait for another operation to release a store. The source stops being used immediately; original files and the provider account are unaffected.'), el('div', { class: 'form-actions' }, button('Keep source', () => closeDialog()), button('Remove source', async () => {
    const label = sourceLabel(source);
    invalidatePrivateView();
    await launchOperation('revoke', { source_key: source.source_key, expected_revision: source.revision, operation_id: crypto.randomUUID() }, `Removing ${label}`, async () => { await refresh(); navigate('sources'); message('The source is excluded. Check its status for any removal still pending.'); });
  }, 'danger')));
}
async function resumeRemoval(source) {
  if (!source.revoke_operation) { await refresh(); message('Refresh the source status before continuing removal.'); return; }
  await launchOperation('resume_revocation', { source_key: source.source_key, operation_id: source.revoke_operation }, `Checking removal · ${sourceLabel(source)}`, async () => { await refresh(); navigate('sources'); });
}
function renderActivity() {
  const section = el('section', {}, heading('A clear history.', 'See receipted changes to your memory. Undo restores the previous state when its receipt still applies.'));
  if (!state.receipts.length) { section.append(empty('No receipted changes yet.', 'Imported sources are searchable right away. Changes to your memory pages appear here when they happen.')); return section; }
  const list = el('ol', { class: 'activity-list' });
  for (const receipt of state.receipts) list.append(el('li', { class: 'activity-item' }, el('div', { class: 'activity-top' }, el('div', {}, el('h3', {}, receipt.page || 'Memory change'), el('p', {}, `${dateText(receipt.at)} · ${receipt.reverted ? 'Undone' : receipt.action}`)), !receipt.reverted && button('Undo', () => undo(receipt))), el('details', { class: 'result-details' }, el('summary', {}, 'Receipt reference'), el('code', {}, receipt.id))));
  section.append(list); return section;
}
async function loadActivity() {
  if (!bearer || !privateViewValid) return;
  const sequence = ++activitySequence, session = bearer, generation = privacyGeneration, epoch = state.status?.visibility_epoch;
  const current = () => sequence === activitySequence && session === bearer && generation === privacyGeneration && epoch === state.status?.visibility_epoch && privateViewValid;
  try {
    const result = await api('activity', { limit: 30 });
    if (!current()) return;
    state.receipts = result.receipts;
    if (state.view === 'activity') render();
  } catch (error) { if (current() && error.code !== 'stale_response') message(error.message); }
}
function undo(receipt) {
  const content = openDialog('Undo this change?', 'Kizuki will use the saved receipt to restore the previous state. If the page or a dependent change has moved on, the undo will refuse safely.', 'activity');
  content.append(el('div', { class: 'status-note' }, el('p', {}, receipt.page)), el('div', { class: 'form-actions' }, button('Keep change', () => closeDialog()), button('Undo change', () => launchOperation('undo', { receipt_id: receipt.id, cascade: false }, 'Undoing this change', async () => { state.hits = null; await refresh(); await loadActivity(); message('Change undone.'); }), 'primary')));
}
async function loadService() {
  const sequence = ++serviceSequence;
  state.service = null;
  if (state.view === 'settings') render();
  try {
    const service = await api('service_status');
    if (sequence !== serviceSequence || !bearer || !privateViewValid) return;
    state.service = service;
    if (state.view === 'settings') render();
  } catch (error) {
    if (sequence === serviceSequence && bearer && error.code !== 'stale_response') message(error.message);
  }
}
async function loadModel() {
  if (!bearer || !privateViewValid) return null;
  const sequence = ++modelSequence;
  try {
    const model = await api('model_status');
    if (sequence !== modelSequence || !bearer || !privateViewValid) return null;
    state.model = model; state.modelError = false;
    if (['settings', 'sources'].includes(state.view)) render();
    return model;
  } catch (error) {
    if (sequence === modelSequence && bearer && privateViewValid && error.code !== 'stale_response') {
      state.model = null; state.modelError = true;
      if (['settings', 'sources'].includes(state.view)) render();
      message(error.message);
    }
    return null;
  }
}
function modelIdentity(model) {
  return model?.selection.kind === 'openai_compatible'
    ? el('div', { class: 'model-identity' }, el('strong', {}, model.selection.model), el('code', {}, model.selection.model_endpoint)) : null;
}
function renderModelSettings() {
  const model = state.model, selected = model?.selection.kind === 'openai_compatible';
  const test = model?.last_test?.revision === model?.revision ? model?.last_test : null;
  return el('section', { class: 'model-settings', 'aria-labelledby': 'model-settings-title' },
    el('div', { class: 'section-header' }, el('h2', { id: 'model-settings-title' }, 'Organise with a model'), el('span', { class: `badge${selected ? ' badge-active' : ''}` }, model ? selected ? 'Model selected' : 'Off' : state.modelError ? 'Setup needs attention' : 'Checking setup')),
    el('p', {}, 'A model can turn permitted source information into memory pages. Capture and search work with this turned off.'), modelIdentity(model),
    el('p', { class: 'model-note' }, model?.credential === 'unavailable' ? 'The saved key is unavailable. Replace it in model settings before testing.' : model?.credential === 'configured' ? 'An API key is saved on this device. Its value is never shown here.' : selected ? 'No API key is saved. Some local models do not need one.' : 'Choose an OpenAI-compatible service or a compatible model running on this device.'),
    test && el('p', { class: 'model-test-result', role: 'status' }, `${test.outcome === 'succeeded' ? 'Connection test passed' : 'Connection test failed'} · ${dateText(test.at)}${test.outcome === 'succeeded' ? ` · ${safeCount(test.latency_ms)} ms` : '. Check your settings and retry'}. This is the last test in this app session.`),
    el('div', { class: 'model-actions' }, button(model ? 'Model settings' : 'Check model settings', modelSettings, 'primary'), selected && button('Test connection', () => testModel(model))),
    el('p', { class: 'model-note' }, 'Saving settings or testing the connection gives no source permission. Choose which sources this model may use in Sources.'));
}
async function modelSettings() {
  const loading = openDialog('Model settings', 'Checking the current saved settings…', 'settings');
  const model = await loadModel();
  if (!dialog.open || !dialog.contains(loading)) return;
  if (!model) { loading.append(el('p', { class: 'form-error', role: 'alert' }, 'The saved settings could not be read. Close this panel and retry; existing settings have not been replaced.')); return; }
  const content = openDialog('Model settings', 'Choose how Kizuki organises memory pages. Saving does not contact the model or let it use any source.', 'settings');
  const form = el('form');
  const kind = el('select', { id: 'model-kind' }, el('option', { value: 'none' }, 'Off — capture and search only'), el('option', { value: 'openai_compatible' }, 'OpenAI-compatible model'));
  kind.value = model.selection.kind;
  form.append(el('div', { class: 'form-field' }, el('label', { for: 'model-kind' }, 'Model connection'), kind));
  const base = field(form, 'Base URL', 'model-url', 'https://your-provider.example/v1', 'url');
  const name = field(form, 'Model name', 'model-name', 'The model ID from your provider');
  if (model.selection.kind === 'openai_compatible') { base.value = model.selection.base_url; name.value = model.selection.model; }
  form.append(el('p', { class: 'model-note' }, 'Use the API base URL and exact model name supplied by your service. You can also use a compatible local server.'));
  const key = field(form, 'API key (optional)', 'model-key', model.credential === 'configured' ? 'Leave blank to keep the saved key' : 'Enter a key if your service needs one', 'password');
  key.setAttribute('autocomplete', 'new-password'); key.setAttribute('maxlength', '1024');
  form.append(el('p', { class: 'model-note' }, 'The key is saved privately on this device. This field is cleared when you save or close the panel.'));
  const clear = el('input', { type: 'checkbox', id: 'model-clear-key' });
  form.append(el('label', { class: 'check-row', for: 'model-clear-key' }, clear, 'Remove the saved API key'));
  const updateFields = () => { const off = kind.value === 'none'; base.disabled = off; name.disabled = off; key.disabled = off || clear.checked; if (key.disabled) key.value = ''; };
  kind.addEventListener('change', updateFields); clear.addEventListener('change', updateFields); updateFields();
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const save = el('button', { type: 'submit', class: 'button button-primary' }, 'Save model settings');
  form.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', closeDialog), save)); content.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (save.disabled) return;
    const off = kind.value === 'none';
    if (!off && (!base.value.trim() || !name.value.trim())) { errorLine.textContent = 'Enter the base URL and model name, or turn the connection off.'; (!base.value.trim() ? base : name).focus(); return; }
    if (new TextEncoder().encode(key.value).length > 1024) { key.value = ''; errorLine.textContent = 'This key is too long. Use an API key of no more than 1,024 bytes.'; key.focus(); return; }
    const payload = { expected_revision: model.revision, selection: off ? { kind: 'none' } : { kind: 'openai_compatible', base_url: base.value.trim(), model: name.value.trim() }, credential: clear.checked ? { action: 'clear' } : !off && key.value ? { action: 'replace', value: key.value } : { action: 'keep' } };
    key.value = ''; save.disabled = true; errorLine.textContent = '';
    modelSequence++;
    try {
      const saved = await api('model_save', payload);
      if (!bearer || !privateViewValid) return;
      modelSequence++;
      state.model = saved; state.modelError = false;
      // Grants must be re-read from the host after any configuration change.
      for (const source of state.sources) source.model_consent = 'unavailable';
      if (dialog.contains(content)) closeDialog(); render();
      message('Model settings saved. No source permission was granted. Test the connection, then review Sources.');
      void refresh();
    } catch (error) { if (error.code !== 'stale_response' && dialog.open && dialog.contains(content)) { errorLine.textContent = error.message; save.disabled = false; } }
    finally { if (payload.credential.action === 'replace') payload.credential.value = ''; }
  });
}
async function testModel(model) {
  await launchOperation('model_test', { expected_revision: model.revision }, 'Test your model connection', async () => {});
  await loadModel();
}
function sourceModelControls(source) {
  const consent = source.model_consent;
  const detail = consent === 'current' ? 'Model permission granted for the current connection.' : consent === 'different_model' ? 'Permission is for a different model. It does not allow the current connection to use this source.' : consent === 'local_only' ? 'Local only. No model may use this source.' : 'Model permission could not be confirmed. Refresh before relying on it.';
  return el('div', { class: 'source-model' }, el('div', {}, el('h4', {}, 'Model use'), el('p', {}, detail), state.model?.selection.kind === 'openai_compatible' && el('p', { class: 'model-current-label' }, 'Current connection'), modelIdentity(state.model)), el('div', { class: 'model-actions' },
    state.model?.selection.kind === 'openai_compatible' && consent !== 'current' && button('Review model permission', () => modelConsent(source, true)),
    (!state.model || state.model.selection.kind === 'none') && button('Set up a model', () => navigate('settings')),
    ['current', 'different_model', 'unavailable'].includes(consent) && button('Withdraw model permission', () => modelConsent(source, false))));
}
async function modelConsent(source, allow) {
  const loading = openDialog('Model permission', 'Checking the current model before showing this permission…', 'lock');
  const model = await loadModel();
  if (!dialog.open || !dialog.contains(loading)) return;
  if (!model || (allow && model.selection.kind !== 'openai_compatible')) { loading.append(el('p', { class: 'form-error', role: 'alert' }, 'Choose a model in Settings, then review this permission again.')); return; }
  const content = openDialog(allow ? 'Allow this model to use this source?' : 'Withdraw model permission?', sourceLabel(source), 'lock');
  content.append(el('div', {}, modelIdentity(model), el('p', { class: 'dialog-description' }, allow ? 'This source’s permitted information may be sent to the exact model connection shown above to organise memory pages. The model provider controls retention of information it receives. This also applies to a model running on this device.' : 'Stop future model use of this source. Local capture and search stay permitted. This does not recall information a provider has already received.'),
    source.model_consent === 'different_model' && el('p', { class: 'status-note' }, 'The previous permission belongs to a different model. Allowing this connection replaces that model permission.')));
  const request = { source_key: source.source_key, expected_revision: source.revision, expected_model_revision: model.revision, operation_id: crypto.randomUUID(), allow };
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const confirm = button(allow ? 'Allow this model' : 'Withdraw permission', async () => {
    confirm.disabled = true;
    try {
      await api('source_model_consent', request);
      if (dialog.contains(content)) closeDialog();
      await refresh();
      if (bearer && privateViewValid) message(allow ? 'Model permission saved for this source. Use Organise now in Memory to run a processing pass.' : 'Model permission withdrawn. Local capture and search remain available.');
    } catch (error) { if (error.code !== 'stale_response' && dialog.open && dialog.contains(content)) { errorLine.textContent = error.message; confirm.disabled = false; } }
  }, allow ? 'primary' : 'danger');
  content.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', closeDialog), confirm));
}
function runSummary(operation) {
  const run = operation.result?.run;
  if (!run) return 'A run receipt has not been returned. Refresh to check the outcome; memory writes are not confirmed.';
  return `${safeCount(run.canon_writes)} memory ${run.canon_writes === 1 ? 'write' : 'writes'} · ${safeCount(run.claims_extracted)} details extracted · ${safeCount(run.model_calls)} model ${run.model_calls === 1 ? 'call' : 'calls'}. ${run.model_configured ? 'Only sources with matching model permission can be used.' : 'No model was configured; capture and search remain available.'} Run status: ${run.status}.`;
}
async function runPass() {
  await launchOperation('run_pass', {}, 'Organising your memory', async () => { await refresh(); });
}
const agentReadTools = [['search', 'Search memory'], ['get_page', 'Read memory pages'], ['query_entities', 'Find entities'], ['timeline', 'Read timelines'], ['context_packet', 'Get relevant context'], ['graph_neighbors', 'Explore connections'], ['system_health', 'Check system health']];
async function loadAgents() {
  if (!bearer || !privateViewValid) return;
  const sequence = ++agentsSequence;
  try {
    const result = await api('agents');
    if (sequence !== agentsSequence || !privateViewValid || !bearer) return;
    state.agents = result.agents; state.agentsError = false;
    if (state.view === 'settings') render();
  } catch (error) {
    if (sequence === agentsSequence && privateViewValid && bearer && error.code !== 'stale_response') {
      state.agents = null; state.agentsError = true;
      if (state.view === 'settings') render();
      message(error.message);
    }
  }
}
function grantSummary(grant) {
  if (!grant) return el('p', {}, 'The current grant is unavailable.');
  const scope = (items, all) => items === null ? all : items.length ? items.join(', ') : 'None';
  const rows = [['Sensitivity ceiling', grant.ceiling], ['Record types', scope(grant.types, 'All record types')], ['Subjects', scope(grant.subjects, 'All subjects')], ['From', grant.since || 'No start limit'], ['Until', grant.until || 'No end limit'], ['Tools', grant.tools.length ? grant.tools.map(tool => agentReadTools.find(([id]) => id === tool)?.[1] || tool).join(', ') : 'None'], ['Requests per minute', grant.rate_limit_per_minute], ['Owner correction relay', grant.relay_owner_corrections ? 'On' : 'Off']];
  return el('dl', { class: 'grant-summary' }, ...rows.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value))));
}
function renderAgents() {
  const section = el('section', { class: 'agent-settings', 'aria-labelledby': 'agent-settings-title' }, el('div', { class: 'section-header' }, el('h2', { id: 'agent-settings-title' }, 'Let an agent read your memory'), button('Set up an agent', agentEnrollment)), el('p', {}, 'Give each assistant its own limited access. Review what it may read, then add its launch configuration to that assistant on this device.'));
  if (!state.agents) section.append(el('p', { class: 'model-note' }, state.agentsError ? 'Agent access could not be checked. Refresh before relying on its status.' : 'Checking existing agents…'), button('Refresh agents', loadAgents));
  else if (!state.agents.length) section.append(el('p', { class: 'model-note' }, 'No agents are connected yet. The setup starts with read-only access to public information.'));
  else for (const agent of state.agents) section.append(el('article', { class: 'agent-row' }, el('div', { class: 'section-header' }, el('h3', {}, agent.name), el('span', { class: 'badge' }, agent.revoked_at ? 'Revoked' : 'Enrolled')), el('details', { class: 'result-details' }, el('summary', {}, 'View all permissions'), grantSummary(agent.grant)), !agent.revoked_at && button('Revoke access', () => agentRevoke(agent))));
  return section;
}
function agentEnrollment() {
  const content = openDialog('Set up a read-only agent', 'Choose the information this assistant may read. It will have its own identity, separate from your owner access.', 'lock');
  const form = el('form'); content.append(form);
  const name = field(form, 'Agent name', 'agent-name', 'research-helper'); name.setAttribute('maxlength', '64');
  const ceiling = el('select', { id: 'agent-ceiling' }, ...[['public', 'Public only'], ['personal', 'Public and personal'], ['private', 'Public, personal and private']].map(([value, label]) => el('option', { value }, label))); ceiling.value = 'public';
  form.append(el('div', { class: 'form-field' }, el('label', { for: 'agent-ceiling' }, 'Sensitivity ceiling'), ceiling), el('p', { class: 'model-note' }, 'Imported sources are private by default. A public-only agent may see no source information. A higher ceiling still respects your source permissions.'));
  const choices = el('fieldset', { class: 'field-choices' }, el('legend', {}, 'Read tools'));
  const tools = agentReadTools.map(([id, label]) => { const check = el('input', { type: 'checkbox', id: `agent-tool-${id}`, value: id, checked: ['search', 'get_page'].includes(id) }); check.value = id; choices.append(el('label', { class: 'check-row', for: `agent-tool-${id}` }, check, label)); return check; }); form.append(choices);
  const scopeFields = el('details', { class: 'result-details' }, el('summary', {}, 'Narrow by type, subject or time (optional)')); form.append(scopeFields);
  const types = field(scopeFields, 'Record types (optional)', 'agent-types', 'person, fact');
  const subjects = field(scopeFields, 'Subjects (optional)', 'agent-subjects', 'person:ada');
  scopeFields.append(el('p', { class: 'model-note' }, 'Use exact type or subject IDs, separated by commas. Leave a field blank to include all within the sensitivity ceiling.'));
  const since = field(scopeFields, 'From (your local time, optional)', 'agent-since', '', 'datetime-local');
  const until = field(scopeFields, 'Until (your local time, optional)', 'agent-until', '', 'datetime-local');
  const rate = field(form, 'Requests per minute', 'agent-rate', '60', 'number'); rate.value = '60'; rate.setAttribute('min', '1'); rate.setAttribute('max', '1000'); rate.setAttribute('step', '1');
  form.append(el('p', { class: 'model-note' }, 'Owner correction relay: off. This setup grants no correction or proposal tools.'));
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  form.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', closeDialog), el('button', { type: 'submit', class: 'button button-primary' }, 'Review access')));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name.value.trim())) { errorLine.textContent = 'Use 2–64 lowercase letters, numbers or hyphens, starting with a letter or number.'; name.focus(); return; }
    const limit = Number(rate.value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) { errorLine.textContent = 'Choose between 1 and 1,000 requests per minute.'; rate.focus(); return; }
    const scope = input => input.value.trim() ? input.value.split(',').map(value => value.trim()).filter(Boolean) : null;
    let start = null, end = null;
    try { start = since.value ? new Date(since.value).toISOString() : null; end = until.value ? new Date(until.value).toISOString() : null; } catch { errorLine.textContent = 'Enter a valid start and end time, or leave them blank.'; return; }
    if (start && end && start > end) { errorLine.textContent = 'The start time must be before the end time.'; since.focus(); return; }
    const request = { name: name.value.trim(), operation_id: crypto.randomUUID(), grant: { ceiling: ceiling.value, types: scope(types), subjects: scope(subjects), since: start, until: end, tools: tools.filter(check => check.checked).map(check => check.value), rate_limit_per_minute: limit, relay_owner_corrections: false } };
    const review = openDialog('Review this agent’s access', request.name, 'lock');
    review.append(grantSummary(request.grant), el('p', { class: 'dialog-description' }, 'Only these permissions will be granted. The next step creates a private credential file on this device; its secret value will not appear in the browser.'), el('div', { class: 'form-actions' }, button('Cancel', closeDialog), button('Create agent', () => launchOperation('agent_enroll', request, 'Creating agent access', async operation => { await loadAgents(); showAgentResult(operation); }), 'primary')));
  });
}
function agentLaunchConfig(mcp) {
  if (!mcp || typeof mcp.command !== 'string' || !mcp.command || !Array.isArray(mcp.args) || !mcp.args.every(arg => typeof arg === 'string')) return null;
  if ([mcp.command, ...mcp.args].some(value => /kzk_|--owner|--token(?:=|$)/.test(value))) return null;
  const refs = mcp.args.filter(arg => arg === '--token-ref').length, at = mcp.args.indexOf('--token-ref');
  if (refs !== 1 || !mcp.args[at + 1]?.startsWith('file:') || mcp.args[at + 1].length <= 5 || !mcp.args.includes('--vault')) return null;
  return { command: mcp.command, args: [...mcp.args] };
}
function showAgentResult(operation) {
  if (!bearer || !privateViewValid || state.operation?.id !== operation.id || !operation.result?.agent) return;
  const { receipt, mcp } = operation.result.agent;
  const content = openDialog('Agent access result', receipt.name, 'lock');
  content.append(el('p', { class: 'dialog-description' }, `Access: ${receipt.authority}. Enrollment: ${receipt.status}. Credential file: ${receipt.credential}.`));
  const config = receipt.authority === 'active' && receipt.credential === 'ready' ? agentLaunchConfig(mcp) : null;
  if (config) {
    const serialized = JSON.stringify(config, null, 2);
    const text = el('textarea', { class: 'launch-config', readonly: '', rows: '8', 'aria-label': 'Agent MCP launch configuration', spellcheck: 'false' }); text.value = serialized;
    content.append(el('p', { class: 'dialog-description' }, 'Add this launch configuration to your assistant’s MCP settings on this device. It refers to a private file; it contains no secret token. Kizuki has not changed another app’s settings.'), text, button('Copy launch configuration', async () => {
      try { await navigator.clipboard.writeText(serialized); if (dialog.contains(content) && privateViewValid) message('Launch configuration copied. Add it to your assistant’s MCP settings.'); }
      catch { if (dialog.contains(content) && privateViewValid) { text.focus(); text.select(); message('Select and copy the launch configuration from this field.'); } }
    }));
  } else if (receipt.authority === 'active') content.append(el('p', { class: 'form-error', role: 'alert' }, 'A usable scoped launch configuration was not returned. No owner access will be substituted.'));
  if (receipt.grant) content.append(grantSummary(receipt.grant));
  content.append(el('div', { class: 'form-actions' }, button('Done', closeDialog, 'primary')));
}
function agentRevoke(agent) {
  const content = openDialog('Revoke this agent’s access?', agent.name, 'lock');
  content.append(grantSummary(agent.grant), el('p', { class: 'dialog-description' }, 'This stops the agent’s access, including existing connections. Its name and credential file are retained; it cannot be reused as a new identity.'), el('div', { class: 'form-actions' }, button('Keep access', closeDialog), button('Revoke access', () => launchOperation('agent_revoke', { name: agent.name }, 'Revoking agent access', async operation => { await loadAgents(); showAgentResult(operation); }), 'danger')));
}
function renderSettings() {
  return el('section', {}, heading('Simply yours.', 'A local workspace, clear permissions, and room to grow when you need it.'), renderModelSettings(), renderAgents(), el('div', { class: 'settings-list' },
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Workspace'), el('p', {}, 'Your memory stays in a local folder you control.')), el('span', { class: 'settings-value' }, state.status?.vault.name || 'Not created')),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Background activity'), el('p', {}, state.service?.detail || 'Refresh to check background activity.'), state.service && el('small', {}, `Checked ${dateText(state.service.checked_at)}`)), el('div', { class: 'form-actions' }, button('Refresh', loadService), state.service && state.service.state !== 'active' && state.service.kind !== 'none' && button('Enable background activity', () => launchOperation('install_service', {}, 'Setting up background activity', async () => { await refresh(); await loadService(); }), 'primary'))),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Source privacy'), el('p', {}, 'Each source has its own permission. Imported content stays on this device unless you separately allow a model to use it.')), button('Manage sources', () => navigate('sources'))),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'App session'), el('p', {}, 'This tab remembers only its local app capability. Search results and source content are not stored in browser storage.')), button('Disconnect tab', disconnect))),
    el('div', { class: 'status-note' }, icon('info'), el('p', {}, 'Search works without a model. Automatic organisation needs a working model and your permission to use each source.')));
}
function renderOperation() {
  const operation = state.operation;
  if (!operation) return null;
  const running = operation.state === 'running';
  const title = operation.kind === 'correct' ? (running ? 'Applying your correction' : 'Correction result') : operation.kind === 'agent_enroll' || operation.kind === 'agent_revoke' ? (running ? 'Updating agent access' : 'Agent access result') : operation.kind === 'model_test' ? (running ? 'Testing your model connection' : operation.state === 'succeeded' ? 'Connection test completed' : 'Connection test needs attention') : operation.kind === 'run_pass' ? (running ? 'Organising your memory' : operation.state === 'succeeded' ? 'Processing run completed' : 'Processing needs attention') : running ? 'Working on your source' : operation.state === 'failed' ? 'This step needs attention' : operation.state === 'unknown' ? 'Completion is not yet confirmed' : operation.kind === 'capture' ? 'Import progress saved' : 'Completed';
  const detail = operation.kind === 'correct' && operation.result ? operation.result.message : operation.result?.agent ? `Access: ${operation.result.agent.receipt.authority}. Enrollment: ${operation.result.agent.receipt.status}.` : operation.kind === 'run_pass' && !running && !operation.error ? runSummary(operation) : operation.kind === 'model_test' && !operation.error ? 'This test uses a made-up prompt. It does not use your imported information or grant source permission.' : running ? 'Your source checkpoint keeps progress recoverable. You can continue using the app.' : operation.error ? humanError(operation.error.code) : operation.kind === 'capture' && operation.counts ? `${safeCount(operation.counts.stored)} saved this time. Check Sources for the latest history and any problems.` : 'Check Sources or Activity for the current state.';
  return el('div', { class: 'job-status', role: 'status' }, icon(running ? 'clock' : operation.state === 'succeeded' ? 'check' : 'info'), el('div', {}, el('h3', {}, title), el('p', {}, detail), operation.kind === 'correct' && Number.isSafeInteger(operation.result?.rewritten_pages) && el('p', {}, `${safeCount(operation.result.rewritten_pages)} memory ${operation.result.rewritten_pages === 1 ? 'page' : 'pages'} rewritten.`), operation.kind === 'correct' && operation.result?.receipt_id && el('details', { class: 'result-details' }, el('summary', {}, 'Correction receipt'), el('code', {}, operation.result.receipt_id)), operation.result?.run?.run_id && el('details', { class: 'result-details' }, el('summary', {}, 'Run receipt'), el('code', {}, operation.result.run.run_id)), operation.result?.agent && button('Agent setup details', () => showAgentResult(operation))));
}
function render() {
  renderNavigation();
  if (!bearer) { renderDisconnected(); return; }
  if (!privateViewValid) { main.replaceChildren(empty('Refreshing your workspace.', 'Checking current permissions before showing saved information.')); return; }
  if (!state.status) return;
  const content = !state.status.vault.ready ? renderWelcome() : state.view === 'memory' ? renderMemory() : state.view === 'sources' ? renderSources() : state.view === 'activity' ? renderActivity() : renderSettings();
  const operation = renderOperation(); if (operation) content.prepend(operation);
  main.replaceChildren(content);
}
function reconcileOperation(operations) {
  if (state.operation) {
    state.operation = operations.find(job => job.id === state.operation.id) || { ...state.operation, state: 'unknown', error: null };
  } else {
    state.operation = operations.find(job => job.state === 'running') || operations.at(-1) || null;
  }
}
function updateOperationBanner() {
  if (!bearer || !privateViewValid) return;
  const existing = main.querySelector('.job-status'), next = renderOperation();
  if (existing) { if (next) existing.replaceWith(next); else existing.remove(); }
  else if (next) main.querySelector('section')?.prepend(next);
}
async function refresh() {
  let sequence = ++refreshSequence;
  try {
    const status = await api('status');
    if (sequence !== refreshSequence || !bearer) return;
    if (state.status && status.visibility_epoch !== state.status.visibility_epoch) { invalidatePrivateView(); sequence = ++refreshSequence; }
    const [catalog, sources] = await Promise.all([api('catalog'), status.vault.ready ? api('sources') : Promise.resolve({ sources: [] })]);
    if (sequence !== refreshSequence || !bearer) return;
    state.status = status; state.catalog = catalog.sources; state.sources = sources.sources; privateViewValid = true;
    searchSequence++; state.busy = false; state.hits = null; state.degraded = [];
    reconcileOperation(status.operations);
    render();
    if (status.vault.ready && ['settings', 'sources'].includes(state.view)) void loadModel();
    if (status.vault.ready && state.view === 'settings') void loadAgents();
  } catch (error) { if (bearer && sequence === refreshSequence && error.code !== 'stale_response') { invalidatePrivateView(); main.replaceChildren(empty('Let’s reconnect.', error.message, button('Try again', refresh, 'primary'))); } }
}
async function launchOperation(route, payload, title, done) {
  const session = bearer, generation = privacyGeneration;
  const current = () => session === bearer && generation === privacyGeneration;
  const content = openDialog(title, route === 'model_test' ? 'This sends one made-up prompt to your saved model. None of your imported information is included, and source permissions stay unchanged.' : route === 'run_pass' ? 'Kizuki will process permitted sources and report the resulting memory writes. A model can use only sources with matching model permission.' : route === 'enroll' && payload.provider !== 'markdown' ? 'Continue in the Google sign-in window. Kizuki will show the result here when sign-in and local enrollment finish.' : 'Kizuki will confirm the result here. Closing this panel does not cancel an operation that has already started.', 'clock');
  const progress = el('div', { class: 'opening', 'aria-busy': 'true' }, el('div', { class: 'skeleton skeleton-line' }), el('p', {}, 'Starting…'));
  content.append(progress, el('div', { class: 'form-actions' }, button('Close panel', () => closeDialog())));
  try {
    const { operation_id } = await api(route, payload);
    for (let attempt = 0; attempt < 180; attempt++) {
      if (!current()) return;
      const operation = await api('operation', { id: operation_id });
      if (!current()) return;
      state.operation = operation; updateOperationBanner();
      if (operation.state !== 'running') {
        progress.setAttribute('aria-busy', 'false');
        if (route === 'initialize' && operation.error?.code === 'service_unavailable') {
          if (dialog.open && dialog.contains(content)) closeDialog();
          await refresh();
          if (session === bearer && privateViewValid && state.status?.vault.ready) {
            navigate('settings');
            message(humanError('service_unavailable'));
          }
          return;
        }
        if (operation.state !== 'succeeded') throw Object.assign(new Error(operation.error ? humanError(operation.error.code) : 'Completion is not confirmed. Check the source state before trying again.'), { code: operation.error?.code || 'unknown' });
        if (dialog.open && dialog.contains(content)) closeDialog();
        await done(operation); return;
      }
      const line = progress.querySelector('p'); if (line) line.textContent = route === 'model_test' ? 'Waiting for the model to answer the test prompt…' : route === 'run_pass' ? 'Processing. The completed run will have a receipt.' : 'In progress. Your original source stays in place.';
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('This is taking longer than expected. Close this panel and refresh to check its current state.');
  } catch (error) {
    if (!current() || error.code === 'stale_response') return;
    progress.setAttribute('aria-busy', 'false'); progress.replaceChildren(el('p', { class: 'form-error', role: 'alert' }, error.message));
    if (!dialog.open || !dialog.contains(content)) message(error.message);
  }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.querySelector('.wordmark').addEventListener('click', event => { event.preventDefault(); navigate('memory'); });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); navigate('memory', false); document.getElementById('memory-query')?.focus(); }
});
try {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token !== null) {
    history.replaceState(null, '', location.pathname + location.search);
    if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) sessionStorage.setItem(SESSION_KEY, token);
  }
  bearer = sessionStorage.getItem(SESSION_KEY);
} catch { bearer = null; }
renderNavigation();
if (bearer) refresh(); else renderDisconnected();
async function checkVisibility() {
  if (!bearer || !state.status || document.hidden || pulseRunning) return;
  pulseRunning = true;
  try {
    const current = await api('status');
    if (current.visibility_epoch !== state.status.visibility_epoch) {
      invalidatePrivateView();
      await refresh();
      if (state.view === 'activity') await loadActivity();
      if (bearer && privateViewValid) message('Your memory view was refreshed to match current permissions.');
    } else { reconcileOperation(current.operations); updateOperationBanner(); }
  } catch (error) { if (bearer && error.code !== 'stale_response') { invalidatePrivateView(); main.replaceChildren(empty('Let’s reconnect.', 'Kizuki could not confirm current permissions. Refresh before viewing saved information.', button('Refresh', refresh, 'primary'))); } }
  finally { pulseRunning = false; }
}
setInterval(checkVisibility, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVisibility(); });
window.addEventListener('pagehide', invalidatePrivateView);
window.addEventListener('pageshow', event => { if (event.persisted && bearer) refresh(); });
