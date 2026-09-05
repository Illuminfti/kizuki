'use strict';
// This client keeps only its short-lived app capability in tab-scoped storage.
// Source content and search results stay in memory and are rendered as text.
const SESSION_KEY = 'kizuki.app.session';
const main = document.getElementById('main');
const dialog = document.getElementById('dialog');
const notice = document.getElementById('notification');
const state = { view: 'memory', status: null, sources: [], catalog: [], receipts: [], hits: null, query: '', degraded: [], busy: false, operation: null };
let bearer = null;
let noticeTimer;
let refreshSequence = 0;
let searchSequence = 0;
let pulseRunning = false;
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
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—'; }
function humanError(code) {
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
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/app/v1/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (response.status === 401) { disconnect(); throw Object.assign(new Error(humanError('unauthorized')), { code: 'unauthorized' }); }
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(humanError(result.error?.code || 'error')), { code: result.error?.code || 'error' });
    return result.data;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error('Kizuki is not responding. Your operation may still be running; reopen or refresh to check its state.'), { code: 'transport' });
  } finally { clearTimeout(timer); }
}
function disconnect() {
  bearer = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  state.hits = null; state.sources = []; state.receipts = []; state.status = null; state.operation = null;
  if (dialog.open) dialog.close();
  renderDisconnected();
}
function renderDisconnected() {
  main.replaceChildren(el('section', { class: 'empty-state' }, icon('lock'), el('h2', {}, 'Open Kizuki to continue'), el('p', {}, 'This private workspace opens from the Kizuki app on your device. Close this tab and open the app again to reconnect.')));
}
function navigate(view, focus = true) {
  if (!['memory', 'sources', 'activity', 'settings'].includes(view)) return;
  state.view = view;
  render();
  if (focus) main.focus({ preventScroll: true });
  if (view === 'activity' && state.status?.vault.ready) loadActivity();
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
    !ready && el('details', { class: 'result-details' }, el('summary', {}, 'Choose a different location'), el('div', { class: 'form-field' }, el('label', { for: 'setup-path' }, 'Workspace folder'), el('input', { id: 'setup-path', type: 'text', placeholder: state.status?.setup_location || 'Full folder path', autocomplete: 'off', spellcheck: 'false' }), el('small', {}, 'Use a new empty folder. Existing folders are never adopted automatically.'))),
    el('div', { class: 'getting-started' }, ...[['01', 'Connect once', 'Choose the information you want to bring along.'], ['02', 'Find it again', 'Search your saved sources, even without a model.'], ['03', 'Keep control', 'Inspect changes, undo them, or remove a source.']].map(([n,t,d]) => el('div', {}, el('span', { class: 'step-number' }, n), el('h3', {}, t), el('p', {}, d)))));
}
async function initialize() {
  const path = document.getElementById('setup-path')?.value.trim();
  await launchOperation('initialize', path ? { path } : {}, 'Creating your workspace', async () => { await refresh(); message('Your Kizuki is ready. Choose your first source.'); navigate('sources'); });
}
function renderMemory() {
  if (!state.status?.vault.ready || state.sources.length === 0) return renderWelcome();
  const field = el('input', { id: 'memory-query', type: 'search', placeholder: 'Find something you remember…', 'aria-label': 'Search your memory', autocomplete: 'off', spellcheck: 'false', maxlength: '2000' }); field.value = state.query;
  const form = el('form', { class: 'search-form', onsubmit: event => { event.preventDefault(); search(field.value); } }, icon('search'), field, el('button', { class: 'button button-primary', type: 'submit', disabled: state.busy }, 'Search'));
  const section = el('section', {}, heading('Your memory.', 'The original information, with a clear path back to its source.'), form, el('p', { class: 'search-hint' }, 'Search works on this device. Results reflect your current source permissions.'));
  if (state.busy) section.append(el('div', { class: 'opening', 'aria-busy': 'true', 'aria-label': 'Searching your memory' }, el('div', { class: 'skeleton skeleton-line' }), el('div', { class: 'skeleton skeleton-panel' })));
  else if (state.hits === null) section.append(empty('A place to find things again.', 'Search for a name, a phrase, or a detail from a source you’ve imported.'));
  else if (!state.hits.length) section.append(empty('Nothing matched this search.', 'Try a more specific word from the original source, or check that the source has finished importing.', button('Check sources', () => navigate('sources'))));
  else {
    section.append(el('div', { class: 'section-header' }, el('h2', {}, 'From your sources'), el('span', {}, `${state.hits.length} ${state.hits.length === 1 ? 'result' : 'results'}`)));
    const list = el('div', { class: 'result-list' });
    for (const hit of state.hits) {
      const citations = Array.isArray(hit.citations) ? hit.citations : [];
      list.append(el('article', { class: 'result-item' }, el('div', { class: 'result-meta' }, el('span', { class: 'badge' }, hit.scope === 'canon' ? 'Memory page' : 'Source evidence'), el('span', {}, hit.sensitivity === 'public' ? 'Public' : hit.sensitivity === 'internal' ? 'Internal' : 'Private')), el('h3', {}, hit.title || 'Saved information'), el('p', { class: 'result-text' }, hit.text), el('details', { class: 'result-details' }, el('summary', {}, 'View evidence references'), el('p', {}, 'A search result retains its source. Being shown here does not make a generated statement owner-authored.'), ...citations.map(id => el('p', {}, el('code', {}, id))))));
    }
    section.append(list);
  }
  if (state.degraded.length) section.append(el('div', { class: 'status-note' }, icon('info'), el('p', {}, 'Search is using an available local path. Some optional capabilities are unavailable; these results are not a complete view of every connected source.')));
  return section;
}
async function search(text) {
  const query = text.trim(); if (!query || state.busy) return;
  state.busy = true; state.query = query; state.hits = null;
  const sequence = ++searchSequence, epoch = state.status?.visibility_epoch;
  render();
  try { const data = await api('query', { text: query, limit: 20 }); if (sequence === searchSequence && epoch === state.status?.visibility_epoch) { state.hits = data.hits; state.degraded = data.degraded || []; } }
  catch (error) { message(error.message); }
  finally { state.busy = false; if (bearer) render(); }
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
      const row = el('div', { class: 'source-row' }, el('div', { class: 'source-icon' }, icon(providerIcon(source.connector_id))), el('div', { class: 'source-info' }, el('h3', {}, source.display_name), el('p', {}, el('span', { class: `badge${active ? ' badge-active' : ''}` }, status)), el('p', {}, `${safeCount(source.stored)} saved · ${dateText(source.last_run)}`), source.errors > 0 && el('p', {}, 'The last capture reported a problem. Check before relying on complete coverage.')));
      const actions = el('div', { class: 'source-actions' });
      if (active) actions.append(button('Import history', () => capture(source)), button('Privacy', () => privacy(source)));
      else if (removing) actions.append(button('Check removal', () => resumeRemoval(source)));
      else if (source.consent !== 'purged') actions.append(button('Review permission', () => consent(source), 'primary'));
      row.append(actions); list.append(row);
    }
    section.append(el('div', { class: 'section-header' }, el('h2', {}, 'Connected')), list);
  }
  section.append(el('div', { class: 'section-header' }, el('h2', {}, state.sources.length ? 'Add another source' : 'Choose your first source')));
  const catalog = el('div', { class: 'source-list' });
  for (const provider of state.catalog) catalog.append(el('div', { class: 'source-row' }, el('div', { class: 'source-icon' }, icon(providerIcon(provider.id))), el('div', { class: 'source-info' }, el('h3', {}, provider.title), el('p', {}, provider.id === 'markdown' ? 'Your Markdown notes, kept in a folder you choose.' : provider.id === 'gmail' ? 'Selected mail content, with a link back to its history.' : 'Selected calendar events and their changes.')), el('div', { class: 'source-actions' }, button(provider.available ? 'Connect' : 'Setup details', () => enrollment(provider), provider.available ? 'primary' : 'secondary'))));
  section.append(catalog, el('div', { class: 'status-note' }, icon('lock'), el('p', {}, 'Nothing is captured just by connecting. You choose the fields and give this source permission before Kizuki imports its history. Provider history and deletion coverage vary.')));
  return section;
}
function openDialog(title, description, symbol = 'info') {
  if (dialog.open) dialog.close();
  const content = el('div', {}, el('div', { class: 'dialog-top' }, el('div', {}, el('div', { class: 'source-icon' }, icon(symbol)), el('h2', { id: 'dialog-title' }, title)), el('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close dialog', onclick: () => dialog.close() }, icon('close'))), el('p', { class: 'dialog-description' }, description));
  dialog.replaceChildren(content); dialog.showModal(); return content;
}
function field(parent, label, id, placeholder = '', type = 'text') {
  const input = el('input', { id, type, placeholder, autocomplete: 'off', spellcheck: 'false' });
  parent.append(el('div', { class: 'form-field' }, el('label', { for: id }, label), input)); return input;
}
function enrollment(provider) {
  const content = openDialog(`Connect ${provider.title}`, provider.detail, providerIcon(provider.id));
  if (!provider.available) { content.append(el('div', { class: 'form-actions' }, button('Done', () => dialog.close(), 'primary'))); return; }
  const form = el('form'); content.append(form);
  let path, calendar;
  if (provider.id === 'markdown') { path = field(form, 'Folder location', 'source-path', '/path/to/your/notes'); form.append(el('small', {}, 'Choose an existing folder of Markdown files outside your Kizuki workspace. Original files stay in place.')); }
  if (provider.id === 'google-calendar') { calendar = field(form, 'Calendar ID', 'calendar-id', 'The calendar’s exact ID'); form.append(el('small', {}, 'Find this in Google Calendar settings under Integrate calendar. Calendar discovery is not available yet.')); }
  const selected = [];
  if (provider.fields.length) {
    const choices = el('fieldset', { class: 'field-choices' }, el('legend', {}, 'Information to keep'));
    for (const name of provider.fields) { const check = el('input', { type: 'checkbox', value: name, checked: name !== 'attachments', id: `field-${name}` }); selected.push(check); choices.append(el('label', { class: 'check-row', for: `field-${name}` }, check, name.charAt(0).toUpperCase() + name.slice(1))); }
    form.append(choices);
  }
  if (provider.id !== 'markdown') content.append(el('p', { class: 'dialog-description' }, provider.id === 'gmail' ? 'Google grants read-only mail access. Kizuki keeps only your selected fields. Sign-in opens Google in your system browser.' : 'Google grants read-only access to events on all calendars. Kizuki reads only the calendar you selected and keeps selected fields plus required identity and schedule metadata.'));
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'button button-primary' }, provider.id === 'markdown' ? 'Connect folder' : 'Continue to Google');
  form.append(errorLine, el('div', { class: 'form-actions' }, button('Cancel', () => dialog.close()), submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (path && !path.value.trim()) { errorLine.textContent = 'Enter the full path to your notes folder.'; path.focus(); return; }
    if (calendar && !calendar.value.trim()) { errorLine.textContent = 'Enter the exact calendar ID to continue.'; calendar.focus(); return; }
    const payload = { provider: provider.id, new_source: true, ...(path ? { path: path.value.trim() } : {}), ...(calendar ? { calendar_id: calendar.value.trim() } : {}), ...(selected.length ? { fields: selected.filter(x => x.checked).map(x => x.value) } : {}) };
    submit.disabled = true;
    await launchOperation('enroll', payload, provider.id === 'markdown' ? 'Connecting your folder' : 'Waiting for Google sign-in', async operation => {
      await refresh();
      const source = state.sources.find(x => x.source_key === operation.result?.source_key);
      if (source) consent(source); else { navigate('sources'); message('Connected. Review this source’s permission to import it.'); }
    });
  });
}
function consent(source) {
  const content = openDialog('Choose what Kizuki can use.', `Give ${source.display_name} permission to store selected information and make it available in your private memory.`, 'lock');
  content.append(el('div', { class: 'consent-summary' }, ...[['Use', 'Capture, search, context and local derivation'], ['Fields', source.required_fields.join(', ')], ['Privacy', 'Private, on this device'], ['Retention', 'Kept until you remove this source'], ['Backups', 'Included in exports you choose to create']].map(([label, value]) => el('div', {}, el('span', {}, label), el('strong', {}, value)))));
  content.append(el('p', { class: 'dialog-description' }, 'This permission does not send source data to an external model. Removing this source stops further use and begins removal from Kizuki’s owned stores. Your original files and provider account remain yours.'));
  const request = { source_key: source.source_key, expected_revision: source.revision, operation_id: crypto.randomUUID(), policy: { purposes: ['capture','recall','session','correction','audit','derive','extract','export'], allowed_fields: source.required_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } };
  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  const allow = button('Allow and import', async () => {
    allow.disabled = true; errorLine.textContent = '';
    try { await api('consent', request); dialog.close(); await refresh(); await capture(source); }
    catch (error) { errorLine.textContent = error.message; allow.disabled = false; }
  }, 'primary');
  content.append(errorLine, el('div', { class: 'form-actions' }, button('Not now', () => dialog.close()), allow));
}
async function capture(source) { await launchOperation('capture', { source_key: source.source_key, mode: 'backfill' }, 'Importing your history', async operation => { await refresh(); navigate('memory'); message(operation.counts ? `${safeCount(operation.counts.stored)} saved · ${safeCount(operation.counts.duplicates)} already present${operation.counts.errors ? ` · ${safeCount(operation.counts.errors)} problems reported` : ''}` : 'Capture completed. Check Sources for its latest coverage.'); }); }
function privacy(source) {
  const content = openDialog('This source stays under your control.', source.display_name, 'lock');
  content.append(el('div', { class: 'consent-summary' }, ...[['Current permission', source.consent], ['Fields needed by this connection', source.required_fields.join(', ')], ['Last capture', dateText(source.last_run)]].map(([label,value]) => el('div', {}, el('span', {}, label), el('strong', {}, value)))), el('p', { class: 'dialog-description' }, 'Remove this source to stop capture and start deleting its information from Kizuki. Removal may wait for another operation to release a store. The source stops being used immediately; original files and the provider account are unaffected.'), el('div', { class: 'form-actions' }, button('Keep source', () => dialog.close()), button('Remove source', async () => {
    state.hits = null; state.query = ''; state.receipts = [];
    await launchOperation('revoke', { source_key: source.source_key, expected_revision: source.revision, operation_id: crypto.randomUUID() }, 'Removing this source', async () => { await refresh(); navigate('sources'); message('The source is excluded. Check its status for any removal still pending.'); });
  }, 'danger')));
}
async function resumeRemoval(source) {
  if (!source.revoke_operation) { await refresh(); message('Refresh the source status before continuing removal.'); return; }
  await launchOperation('resume_revocation', { source_key: source.source_key, operation_id: source.revoke_operation }, 'Checking source removal', async () => { await refresh(); navigate('sources'); });
}
function renderActivity() {
  const section = el('section', {}, heading('A clear history.', 'See receipted changes to your memory. Undo restores the previous state when its receipt still applies.'));
  if (!state.receipts.length) { section.append(empty('No receipted changes yet.', 'Once Kizuki changes a memory page, its receipt will appear here. Capturing source evidence does not itself claim to have written a page.')); return section; }
  const list = el('ol', { class: 'activity-list' });
  for (const receipt of state.receipts) list.append(el('li', { class: 'activity-item' }, el('div', { class: 'activity-top' }, el('div', {}, el('h3', {}, receipt.page || 'Memory change'), el('p', {}, `${dateText(receipt.at)} · ${receipt.reverted ? 'Undone' : receipt.action}`)), !receipt.reverted && button('Undo', () => undo(receipt))), el('details', { class: 'result-details' }, el('summary', {}, 'Receipt reference'), el('code', {}, receipt.id))));
  section.append(list); return section;
}
async function loadActivity() { try { const result = await api('activity', { limit: 30 }); state.receipts = result.receipts; if (state.view === 'activity') render(); } catch (error) { message(error.message); } }
function undo(receipt) {
  const content = openDialog('Undo this change?', 'Kizuki will use the saved receipt to restore the previous state. If the page or a dependent change has moved on, the undo will refuse safely.', 'activity');
  content.append(el('div', { class: 'status-note' }, el('p', {}, receipt.page)), el('div', { class: 'form-actions' }, button('Keep change', () => dialog.close()), button('Undo change', () => launchOperation('undo', { receipt_id: receipt.id, cascade: false }, 'Undoing this change', async () => { state.hits = null; await refresh(); await loadActivity(); message('Change undone.'); }), 'primary')));
}
function renderSettings() {
  return el('section', {}, heading('Simply yours.', 'A local workspace, clear permissions, and room to grow when you need it.'), el('div', { class: 'settings-list' },
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Workspace'), el('p', {}, 'Your memory uses the same authoritative local vault as Kizuki’s other clients.')), el('span', { class: 'settings-value' }, state.status?.vault.name || 'Not created')),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Background activity'), el('p', {}, state.status?.service.detail || 'Status unavailable.')), el('span', { class: 'settings-value' }, state.status?.service.state || 'Unavailable')),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'Source privacy'), el('p', {}, 'Each source has its own permission. Sources connected here default to private storage and no external model egress.')), button('Manage sources', () => navigate('sources'))),
    el('div', { class: 'settings-row' }, el('div', {}, el('h3', {}, 'App session'), el('p', {}, 'This tab remembers only its local app capability. Search results and source content are not stored in browser storage.')), button('Disconnect tab', disconnect))),
    el('div', { class: 'status-note' }, icon('info'), el('p', {}, 'Capture and search work without a model. Automatic memory-page writing depends on a usable model and explicit source permission; a configured model name alone does not make it ready.')));
}
function renderOperation() {
  const operation = state.operation;
  if (!operation) return null;
  const running = operation.state === 'running';
  const title = running ? 'Working on your source' : operation.state === 'failed' ? 'This step needs attention' : operation.state === 'unknown' ? 'Completion is not yet confirmed' : 'Completed';
  const detail = running ? 'Your source checkpoint keeps progress recoverable. You can continue using the app.' : operation.error ? humanError(operation.error.code) : operation.result?.message || 'Check Sources for the current state.';
  return el('div', { class: 'job-status', role: 'status' }, icon(running ? 'clock' : operation.state === 'succeeded' ? 'check' : 'info'), el('div', {}, el('h3', {}, title), el('p', {}, detail)));
}
function render() {
  renderNavigation();
  if (!bearer) { renderDisconnected(); return; }
  if (!state.status) return;
  const content = !state.status.vault.ready ? renderWelcome() : state.view === 'memory' ? renderMemory() : state.view === 'sources' ? renderSources() : state.view === 'activity' ? renderActivity() : renderSettings();
  const operation = renderOperation(); if (operation) content.prepend(operation);
  main.replaceChildren(content);
}
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const status = await api('status');
    const [catalog, sources] = await Promise.all([api('catalog'), status.vault.ready ? api('sources') : Promise.resolve({ sources: [] })]);
    if (sequence !== refreshSequence || !bearer) return;
    state.status = status; state.catalog = catalog.sources; state.sources = sources.sources;
    searchSequence++; state.busy = false; state.hits = null; state.degraded = [];
    const pending = status.operations.find(op => op.state === 'running');
    if (pending) state.operation = pending;
    render();
  } catch (error) { if (bearer) { main.replaceChildren(empty('Let’s reconnect.', error.message, button('Try again', refresh, 'primary'))); } }
}
async function launchOperation(route, payload, title, done) {
  const content = openDialog(title, route === 'enroll' && payload.provider !== 'markdown' ? 'Continue in the Google sign-in window. Kizuki will show the result here when sign-in and local enrollment finish.' : 'Kizuki will confirm the result here. Closing this panel does not cancel an operation that has already started.', 'clock');
  const progress = el('div', { class: 'opening', 'aria-busy': 'true' }, el('div', { class: 'skeleton skeleton-line' }), el('p', {}, 'Starting…'));
  content.append(progress, el('div', { class: 'form-actions' }, button('Close panel', () => dialog.close())));
  try {
    const { operation_id } = await api(route, payload);
    for (let attempt = 0; attempt < 180; attempt++) {
      const operation = await api('operation', { id: operation_id }); state.operation = operation;
      if (operation.state !== 'running') {
        progress.setAttribute('aria-busy', 'false');
        if (operation.state !== 'succeeded') throw Object.assign(new Error(operation.error ? humanError(operation.error.code) : 'Completion is not confirmed. Check the source state before trying again.'), { code: operation.error?.code || 'unknown' });
        if (dialog.open && dialog.contains(content)) dialog.close();
        await done(operation); return;
      }
      const line = progress.querySelector('p'); if (line) line.textContent = 'In progress. Your original source stays in place.';
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('This is taking longer than expected. Close this panel and refresh to check its current state.');
  } catch (error) {
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
      searchSequence++; state.hits = null; state.receipts = [];
      await refresh();
      if (state.view === 'activity') await loadActivity();
      message('Your memory view was refreshed to match current permissions.');
    }
  } catch { if (bearer) { searchSequence++; state.hits = null; state.receipts = []; main.replaceChildren(empty('Let’s reconnect.', 'Kizuki could not confirm current permissions. Refresh before viewing saved information.', button('Refresh', refresh, 'primary'))); } }
  finally { pulseRunning = false; }
}
setInterval(checkVisibility, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVisibility(); });
window.addEventListener('pagehide', () => { searchSequence++; state.hits = null; state.sources = []; state.receipts = []; main.replaceChildren(); });
window.addEventListener('pageshow', event => { if (event.persisted && bearer) refresh(); });
