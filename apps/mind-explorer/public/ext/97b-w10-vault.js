/* Wave 10 vault: library composition (doubles as a filter), source-typed rows, document
   masthead, reading facts, document shape with scroll-spy, and related docs.
   Enhances the DOM app.js renders inside #view-vault. Every number is read from what app.js
   already rendered from /api/docs (category chip counts) or counted from the open document;
   the source of a path is resolved with the same rule the server uses (classifyDocCategory in
   vault-api.ts), so typing never depends on an extra request. Nothing is invented. */
(function () {
  'use strict';

  const ROOT_ID = 'view-vault';
  const WORDS_PER_MIN = 230;
  const STALE_DAYS = 30;

  // Source families: tone carries meaning (canon, knowledge, captures, agent sessions, archive).
  // label mirrors DOC_CATEGORY_DEFS in vault-api.ts; the chip label from app.js wins when present.
  const CAT_META = {
    all: { icon: 'layers', tone: 'slate', family: 'All', label: 'All' },
    owner: { icon: 'star', tone: 'cobalt', family: 'Canon', label: 'Owner & Canon' },
    dashboards: { icon: 'pulse', tone: 'cobalt', family: 'Canon', label: 'Dashboards' },
    world: { icon: 'globe', tone: 'violet', family: 'Knowledge', label: 'World Model' },
    entities: { icon: 'people', tone: 'violet', family: 'Knowledge', label: 'Entities' },
    facts: { icon: 'check', tone: 'violet', family: 'Knowledge', label: 'Facts' },
    notes: { icon: 'doc', tone: 'emerald', family: 'Capture', label: 'Vault Notes' },
    obsidian: { icon: 'brain', tone: 'emerald', family: 'Capture', label: 'Obsidian' },
    'apple-notes': { icon: 'doc', tone: 'emerald', family: 'Capture', label: 'Apple Notes' },
    'wispr-flow': { icon: 'mic', tone: 'emerald', family: 'Capture', label: 'Wispr Meetings' },
    sources: { icon: 'inbox', tone: 'emerald', family: 'Capture', label: 'Sources & Captures' },
    claude: { icon: 'spark', tone: 'orange', family: 'Agent', label: 'Claude Sessions' },
    codex: { icon: 'bolt', tone: 'orange', family: 'Agent', label: 'Codex Sessions' },
    archive: { icon: 'archive', tone: 'slate', family: 'Archive', label: 'Archive' },
  };
  const FAMILY_ORDER = ['Canon', 'Knowledge', 'Capture', 'Agent', 'Archive', 'Other'];
  const FAMILY_TONE = { Canon: 'cobalt', Knowledge: 'violet', Capture: 'emerald', Agent: 'orange', Archive: 'slate', Other: 'slate' };
  const PERSON_TYPES = new Set(['person', 'people', 'contact', 'human']);
  // Frontmatter keys the masthead or facts already show; hidden from the metadata chips.
  const SHOWN_FM_KEYS = new Set([
    'title', 'type', 'status', 'sensitivity', 'participants', 'attendees', 'people', 'with',
    'duration_min', 'generated_at', 'updated_at', 'updated', 'x-updated', 'x-reviewed', 'x-next-review',
    'occurred_at', 'sources', 'source_ids', 'x-confidence', 'source',
  ]);

  const spy = { heads: [], raf: 0, total: 0 };
  let lastDocSig = '';

  function K() { return window.KizukiKit || null; }
  function root() { return document.getElementById(ROOT_ID); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function catMeta(key) {
    const k = String(key || '').toLowerCase();
    return CAT_META[k] || { icon: 'folder', tone: 'slate', family: 'Other', label: '' };
  }
  function esc(s) { const k = K(); return k ? k.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'); }
  function numFmt(n) { return Number(n).toLocaleString('en-GB'); }
  function pctLabel(f) {
    const p = f * 100;
    if (p > 0 && p < 1) return '<1%';
    return Math.round(p) + '%';
  }

  /* ------------------------------------------------------------ source typing */
  // Same rule as classifyDocCategory() in vault-api.ts. Every path maps to one source;
  // the server's fallback is 'notes', so nothing is left untyped.
  function classifyPath(path) {
    const p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p) return '';
    if (p.startsWith('obsidian/')) return 'obsidian';
    if (p.startsWith('apple-notes/')) return 'apple-notes';
    if (p.startsWith('wispr-flow/')) return 'wispr-flow';
    if (p === 'owner-anchors.md' || p === 'owner-notes.md' || p === 'CANON.md' || p === 'SCHEMA.md' || p.startsWith('owner-notes/')) return 'owner';
    if (p.startsWith('dashboards/')) return 'dashboards';
    if (/^(?:auto\/)?world\//.test(p)) return 'world';
    if (/^(?:auto\/)?entities\//.test(p)) return 'entities';
    if (/^(?:auto\/)?facts\//.test(p)) return 'facts';
    if (p.startsWith('auto/kizuki.markdown-folder/')) return 'notes';
    if (p.startsWith('auto/kizuki.claude-code-sessions/')) return 'claude';
    if (p.startsWith('auto/kizuki.codex-sessions/')) return 'codex';
    if (/^(?:auto\/sources|sources|auto\/captures|auto\/kizuki\.import-legacy-events|events)\//.test(p)) return 'sources';
    if (p.startsWith('archive/')) return 'archive';
    return 'notes';
  }

  // Source directories per key (DOC_CATEGORY_DEFS dirs plus the classifier's aliases), used to
  // show only the folder trail below the source itself.
  const CAT_DIRS = {
    dashboards: ['dashboards'], world: ['auto/world', 'world'], entities: ['auto/entities', 'entities'],
    facts: ['auto/facts', 'facts'], notes: ['auto/kizuki.markdown-folder'], obsidian: ['obsidian'],
    'apple-notes': ['apple-notes'], 'wispr-flow': ['wispr-flow'], claude: ['auto/kizuki.claude-code-sessions'],
    codex: ['auto/kizuki.codex-sessions'], archive: ['archive'], owner: ['owner-notes'],
    sources: ['auto/sources', 'sources', 'auto/captures', 'auto/kizuki.import-legacy-events', 'events'],
  };
  function folderTrail(path, key) {
    const p = String(path || '').replace(/^\/+/, '');
    const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (!folder) return '';
    for (const d of CAT_DIRS[key] || []) {
      if (folder === d) return '';
      if (folder.startsWith(d + '/')) return folder.slice(d.length + 1);
    }
    return folder;
  }

  // Counts and labels app.js already rendered into the category chips ("Label: 1,234 docs").
  // The server's category counts partition the vault, so their sum is the vault total.
  function catsFromButtons() {
    const out = [];
    $$('#vault-cat-list .vault-cat-btn').forEach((btn) => {
      const key = String(btn.getAttribute('data-vault-cat') || '').toLowerCase();
      if (!key || key === 'all') return;
      const m = /^(.*):\s*([\d,]+) docs$/.exec(btn.getAttribute('title') || '');
      if (!m) return;
      const n = Number(m[2].replace(/,/g, ''));
      if (!Number.isFinite(n)) return;
      out.push({ key, label: m[1], count: n });
    });
    return out;
  }

  function labelFor(key) {
    if (!key) return '';
    const btn = document.querySelector('#vault-cat-list .vault-cat-btn[data-vault-cat="' + CSS.escape(key) + '"]');
    const m = btn && /^(.*):\s*[\d,]+ docs$/.exec(btn.getAttribute('title') || '');
    return (m && m[1]) || catMeta(key).label || key;
  }

  function filterCategory(key) {
    const btn = document.querySelector('#vault-cat-list .vault-cat-btn[data-vault-cat="' + CSS.escape(key) + '"]');
    if (btn) btn.click();
  }

  /* ------------------------------------------------------------ sidebar */
  function libraryState() {
    const cats = catsFromButtons();
    if (cats.length) return { cats };
    const list = document.getElementById('vault-doc-list');
    const failed = !!(list && /Failed to load/i.test(list.textContent || ''));
    return { cats: [], failed };
  }

  function renderLibraryCard() {
    const r = root();
    const k = K();
    if (!r || !k) return;
    const head = $('.vault-sidebar-head', r);
    if (!head) return;
    let card = $('.k10v-lib', r);
    if (!card) {
      card = document.createElement('section');
      card.className = 'k10v-lib';
      card.setAttribute('aria-label', 'Vault library composition');
      head.insertAdjacentElement('afterend', card);
    }
    const html = libraryHtml(libraryState(), activeCategory());
    if (card.innerHTML !== html) card.innerHTML = html;
  }

  // Pure: src = { cats: [{key,label,count}], failed }. Shared with the storyboard.
  function libraryHtml(src, active) {
    const k = K();
    if (!k) return '';
    const cats = src && Array.isArray(src.cats) ? src.cats.filter((c) => Number.isFinite(Number(c.count)) && c.count > 0) : [];
    if (!cats.length) {
      const msg = src && src.failed ? 'Composition unavailable' : 'Counting documents';
      return '<div class="k10v-lib-top"><span class="k10v-lib-title">Library</span>' + k.unavailable(msg) + '</div>' +
        '<div class="k10v-bar is-empty" aria-hidden="true"></div>';
    }
    const sum = cats.reduce((a, c) => a + c.count, 0);
    const fam = {};
    cats.forEach((c) => {
      const f = catMeta(c.key).family;
      fam[f] = (fam[f] || 0) + c.count;
    });
    const sorted = cats.slice().sort((a, b) => {
      const fa = FAMILY_ORDER.indexOf(catMeta(a.key).family);
      const fb = FAMILY_ORDER.indexOf(catMeta(b.key).family);
      return fa - fb || b.count - a.count;
    });
    const activeCat = active && active !== 'all' ? cats.find((c) => c.key === active) || null : null;
    const segs = sorted
      .map((c) => {
        const m = catMeta(c.key);
        const w = (c.count / sum) * 100;
        return '<span class="k10v-seg k10-tone-' + m.tone + (activeCat && activeCat.key === c.key ? ' is-active' : '') + '" style="flex-grow:' + w.toFixed(3) +
          '" data-k10v-cat="' + esc(c.key) + '" title="' + esc(c.label + ': ' + numFmt(c.count) + ' docs (' + pctLabel(c.count / sum) + '). Click to filter') + '"></span>';
      })
      .join('');
    const legend = FAMILY_ORDER.filter((f) => fam[f])
      .map((f) => '<span class="k10v-leg k10-tone-' + FAMILY_TONE[f] + '"><span class="k10v-leg-dot" aria-hidden="true"></span>' + esc(f) +
        '<span class="k10v-leg-n">' + pctLabel(fam[f] / sum) + '</span></span>')
      .join('');
    const right = activeCat
      ? '<span class="k10v-lib-total"><b>' + numFmt(activeCat.count) + '</b> of ' + numFmt(sum) + '</span>'
      : '<span class="k10v-lib-total"><b>' + numFmt(sum) + '</b> docs</span>';
    const title = activeCat ? esc(activeCat.label) + '<span class="k10v-lib-share">' + pctLabel(activeCat.count / sum) + '</span>' : 'Library';
    return '<div class="k10v-lib-top"><span class="k10v-lib-title">' + title + '</span>' + right + '</div>' +
      '<div class="k10v-bar" role="img" aria-label="' + esc('Vault composition: ' + FAMILY_ORDER.filter((f) => fam[f]).map((f) => f + ' ' + pctLabel(fam[f] / sum)).join(', ')) + '">' + segs + '</div>' +
      '<div class="k10v-legend">' + legend + '</div>';
  }

  function activeCategory() {
    const btn = $('#vault-cat-list .vault-cat-btn.is-active');
    return btn ? String(btn.getAttribute('data-vault-cat') || '').toLowerCase() : 'all';
  }

  // Chips stay app.js buttons (one scrolling row). Only the active chip carries its family tone.
  function enhanceCategories() {
    const list = document.getElementById('vault-cat-list');
    if (!list) return;
    list.classList.add('k10v-cats');
    $$('.vault-cat-btn', list).forEach((btn) => {
      const key = String(btn.getAttribute('data-vault-cat') || '').toLowerCase();
      if (btn.dataset.k10vCat === key) return;
      btn.dataset.k10vCat = key;
      btn.classList.add('k10v-cat', 'k10-tone-' + catMeta(key).tone);
    });
    const act = $('.vault-cat-btn.is-active', list);
    if (act && list.scrollWidth > list.clientWidth) {
      const l = act.offsetLeft - list.offsetLeft;
      if (l < list.scrollLeft || l + act.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = Math.max(0, l - 12);
    }
  }

  function enhanceDocList() {
    const k = K();
    const list = document.getElementById('vault-doc-list');
    if (!k || !list) return;
    $$('.vault-doc-item', list).forEach((item) => {
      const path = item.getAttribute('data-open-doc') || '';
      const key = classifyPath(path);
      if (item.dataset.k10vCat === key && item.querySelector('.k10v-tile')) return;
      const m = catMeta(key);
      if (item.dataset.k10vTone) item.classList.remove('k10-tone-' + item.dataset.k10vTone);
      item.classList.add('k10v-doc', 'k10-tone-' + m.tone);
      item.dataset.k10vCat = key;
      item.dataset.k10vTone = m.tone;
      let tile = item.querySelector('.k10v-tile');
      if (!tile) {
        tile = document.createElement('span');
        tile.className = 'k10v-tile';
        item.insertBefore(tile, item.firstChild);
      }
      tile.setAttribute('title', labelFor(key));
      tile.setAttribute('aria-hidden', 'true');
      tile.innerHTML = k.icon(m.icon, 13);
    });
  }

  /* ------------------------------------------------------------ document */
  // Prefer the parser app.js itself uses (markdown.js); the small regex parser is a fallback.
  function parseFrontmatter(md) {
    const text = String(md || '');
    const KM = window.KizukiMarkdown;
    if (KM && typeof KM.parseFrontmatter === 'function') {
      try {
        const res = KM.parseFrontmatter(text);
        if (res && res.frontmatter && typeof res.frontmatter === 'object') {
          const out = {};
          Object.keys(res.frontmatter).forEach((key) => { out[key.toLowerCase()] = res.frontmatter[key]; });
          return out;
        }
      } catch (_) { /* fall through */ }
    }
    return parseFrontmatterLite(text);
  }

  function parseFrontmatterLite(md) {
    const out = {};
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''));
    if (!m) return out;
    let listKey = null;
    m[1].split(/\r?\n/).forEach((line) => {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey) {
        let v = item[1].trim();
        if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); } }
        if (v) out[listKey].push(v);
        return;
      }
      const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      listKey = null;
      if (!kv) return;
      if (kv[2].trim() === '') {
        listKey = kv[1].toLowerCase();
        out[listKey] = [];
        return;
      }
      let v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean); }
      } else if (/^".*"$/.test(v)) {
        try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); }
      }
      out[kv[1].toLowerCase()] = v;
    });
    return out;
  }

  function str(v) { return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; }

  function countWords(text) {
    const t = String(text || '').trim();
    if (!t) return 0;
    const m = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
    return m ? m.length : 0;
  }

  function readTime(words) {
    if (!Number.isFinite(words) || words <= 0) return null;
    if (words < WORDS_PER_MIN / 2) return '<1 min read';
    return Math.round(words / WORDS_PER_MIN) + ' min read';
  }

  function headingLevelFor(content) {
    const counts = [1, 2, 3, 4].map((l) => content.querySelectorAll('h' + l).length);
    if (counts[1] >= 2) return 'h1, h2';
    if (counts[2] >= 2) return 'h1, h2, h3';
    if (counts[0] >= 2) return 'h1';
    return 'h1, h2, h3';
  }

  function buildSections(content) {
    const sel = headingLevelFor(content);
    const sections = [];
    let cur = { id: '', title: 'Opening', words: 0, el: null };
    Array.prototype.forEach.call(content.children, (node) => {
      if (node.matches && node.matches(sel)) {
        if (cur.words > 0 || cur.el) sections.push(cur);
        if (!node.id) node.id = 'k10v-h-' + sections.length + '-' + (K() ? K().hash(node.textContent).toString(36) : sections.length);
        cur = { id: node.id, title: node.textContent.trim() || 'Untitled section', words: 0, el: node };
      } else {
        cur.words += countWords(node.textContent);
      }
    });
    if (cur.words > 0 || cur.el) sections.push(cur);
    return sections;
  }

  function ageDays(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (Date.now() - t) / 86400000 : null;
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 0) {
      const d = Math.ceil(-s / 86400);
      return d <= 1 ? 'today' : 'in ' + d + 'd';
    }
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 45) return Math.round(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.round(s / (86400 * 30.44)) + ' mo ago';
    return Math.floor(s / (86400 * 365.25)) + 'y ago';
  }

  function absDate(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const opts = d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return d.toLocaleDateString('en-GB', opts);
  }

  // Names listed in frontmatter (meeting participants, attendees, people). Opaque ids are skipped.
  function peopleFrom(fm) {
    const seen = new Set();
    const out = [];
    ['participants', 'attendees', 'people', 'with'].forEach((key) => {
      const v = fm[key];
      const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : [];
      list.forEach((raw) => {
        const name = String(raw == null ? '' : raw).trim();
        if (!name || name.length > 60 || /^[0-9A-Z]{20,}$/i.test(name) || /^[a-f0-9-]{20,}$/i.test(name) || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        out.push(name);
      });
    });
    return out;
  }

  // Which date this document carries, with the label that matches its meaning.
  function freshnessFrom(fm) {
    const pick = [
      ['occurred_at', 'Held'],
      ['updated_at', 'Updated'], ['updated', 'Updated'], ['x-updated', 'Updated'],
      ['generated_at', 'Generated'],
      ['x-reviewed', 'Reviewed'],
    ];
    for (const [key, label] of pick) {
      const v = str(fm[key]);
      if (v && Number.isFinite(Date.parse(v))) return { label, iso: v };
    }
    return null;
  }

  function currentDocPath() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('doc');
    if (fromUrl) return fromUrl;
    return $$('#doc-path .crumb-btn').map((b) => b.textContent.trim()).join('/');
  }

  function ensureSlot(id, cls, anchor, where) {
    let el = document.getElementById(id);
    if (!el && anchor) {
      el = document.createElement('div');
      el.id = id;
      el.className = cls;
      anchor.insertAdjacentElement(where, el);
    }
    return el;
  }

  function renderDocChrome() {
    const r = root();
    const k = K();
    if (!r || !k) return;
    const header = $('.doc-header', r);
    const content = document.getElementById('doc-content');
    const crumbBar = header && $('.doc-crumb-bar', header);
    if (!header || !content || !crumbBar) return;
    const mast = ensureSlot('k10v-mast', 'k10v-mast', crumbBar, 'afterend');
    const facts = ensureSlot('k10v-facts', 'k10v-facts', header, 'afterend');
    const loading = !!content.querySelector(':scope > .skeleton-block');
    const failed = !!content.querySelector(':scope > .empty-state');
    const raw = (document.getElementById('doc-raw-view') || {}).textContent || '';
    if (loading || failed || !raw.trim()) {
      if (!loading) { mast.hidden = true; facts.hidden = true; lastDocSig = ''; }
      r.classList.toggle('k10v-has-doc', false);
      return;
    }
    const path = currentDocPath();
    const relCount = $$('#doc-related-list .related-doc-item').length;
    const sig = path + '|' + raw.length + '|' + k.hash(raw) + '|' + relCount + '|' + catsFromButtons().length;
    r.classList.add('k10v-has-doc');
    mast.hidden = false;
    facts.hidden = false;
    if (sig === lastDocSig && mast.innerHTML && facts.innerHTML) { onScroll(); return; }
    lastDocSig = sig;

    const fm = parseFrontmatter(raw);
    const catKey = classifyPath(path);
    const title = (document.getElementById('doc-title') || {}).textContent || path;
    const mv = mastheadParts({ path, title, catKey, catLabel: labelFor(catKey), fm });
    mast.className = mv.className;
    mast.innerHTML = mv.html;
    tidyFrontmatter();

    const sections = buildSections(content);
    const counts = {
      links: content.querySelectorAll('a[href], [data-open-wikilink], [data-open-doc]').length,
      related: relCount,
    };
    facts.innerHTML = factsHtml(sections, counts, fm);
    spy.heads = sections.map((s, i) => ({ idx: i, id: s.id, el: s.el, title: s.title })).filter((h) => h.el);
    spy.heads.forEach((h, n) => { h.ord = n + 1; });
    spy.total = spy.heads.length;
    onScroll();
  }

  // Hide metadata chips that the masthead or facts already show, and keep the rest behind
  // the app's own "Metadata (n)" disclosure at every width.
  function tidyFrontmatter() {
    const bar = document.getElementById('doc-frontmatter');
    if (!bar) return;
    let shown = 0;
    $$('.fm-chip', bar).forEach((chip) => {
      const key = ((chip.querySelector('.fm-key') || {}).textContent || '').trim().toLowerCase();
      const dup = SHOWN_FM_KEYS.has(key);
      chip.classList.toggle('k10v-fm-dup', dup);
      if (!dup) shown += 1;
    });
    const toggle = $('.frontmatter-toggle-btn', bar);
    if (toggle) toggle.textContent = 'More metadata (' + shown + ')';
    bar.classList.toggle('k10v-fm-none', shown === 0);
  }

  // Pure: masthead for a document. o = {path, title, catKey, catLabel, fm}. Shared with the storyboard.
  function mastheadParts(o) {
    const k = K();
    const fm = o.fm || {};
    const path = String(o.path || '');
    const title = o.title || path;
    const m = catMeta(o.catKey);
    const type = str(fm.type);
    const status = str(fm.status);
    const sensitivity = str(fm.sensitivity);
    const confidence = str(fm['x-confidence']);
    const isPerson = PERSON_TYPES.has(type.toLowerCase());
    const label = o.catLabel || (o.catKey ? catMeta(o.catKey).label : '');
    const folder = folderTrail(path, o.catKey);
    const source = label
      ? '<button type="button" class="k10v-mast-src" data-k10v-filter="' + esc(o.catKey) + '" title="' + esc('Show all ' + label) + '">' +
        '<span class="k10v-mast-tile" aria-hidden="true">' + k.icon(m.icon, 14) + '</span><span>' + esc(label) + '</span></button>'
      : '<span class="k10v-mast-src is-static"><span class="k10v-mast-tile" aria-hidden="true">' + k.icon('folder', 14) + '</span><span>Unfiled</span></span>';
    const crumbs = folder
      ? '<span class="k10v-mast-path" title="' + esc(path) + '">' + esc(folder.split('/').join(' / ')) + '</span>'
      : '';
    const chips = [
      type ? k.chip(type.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase()), 'slate', { dot: false }) : '',
      status ? k.chip(status.charAt(0).toUpperCase() + status.slice(1), status.toLowerCase() === 'active' ? 'emerald' : 'slate') : '',
      confidence ? k.chip(confidence.charAt(0).toUpperCase() + confidence.slice(1) + ' confidence', 'slate', { dot: false }) : '',
      sensitivity ? k.chip(sensitivity.charAt(0).toUpperCase() + sensitivity.slice(1), 'slate', { icon: 'eye', dot: false }) : '',
    ].join('');
    const people = peopleFrom(fm);
    const peopleRow = people.length
      ? '<div class="k10v-people" title="' + esc(people.join(', ')) + '">' + k.avatarStack(people.map((n) => ({ name: n })), { max: 4, size: 24 }) +
        '<span class="k10v-people-names">' + esc(people.slice(0, 2).join(', ') + (people.length > 2 ? ' +' + (people.length - 2) : '')) + '</span></div>'
      : '';
    const portrait = isPerson
      ? '<span class="k10v-mast-av">' + k.avatar({ name: title, key: path, avatar_url: fm.avatar_url, photo: fm.photo }, { size: 44, ring: m.tone }) + '</span>'
      : '';
    return {
      className: 'k10v-mast k10-tone-' + m.tone + (isPerson ? ' is-person' : ''),
      html: portrait + '<div class="k10v-mast-id">' + source + crumbs + '</div>' +
        '<div class="k10v-mast-side">' + (chips ? '<div class="k10v-mast-chips">' + chips + '</div>' : '') + peopleRow + '</div>',
    };
  }

  // Pure: facts plates + document shape. sections = [{id, title, words, el}], counts = {links, related}.
  function factsHtml(sections, counts, fm) {
    const k = K();
    fm = fm || {};
    counts = counts || {};
    sections = sections || [];
    const words = sections.reduce((a, s) => a + s.words, 0);
    const heads = sections.filter((s) => s.el || s.id);
    const longest = heads.length ? heads.reduce((a, s) => (s.words > a.words ? s : a), heads[0]) : null;
    const srcList = Array.isArray(fm.sources) ? fm.sources : Array.isArray(fm.source_ids) ? fm.source_ids : null;
    const dur = parseFloat(fm.duration_min);
    const fresh = freshnessFrom(fm);
    const review = str(fm['x-next-review']);
    const reviewAge = review ? ageDays(review) : null;

    const cells = [
      { label: 'Length', value: words, unit: 'words', sub: readTime(words) || 'No body text', icon: 'doc' },
      {
        label: 'Related', value: counts.related, icon: 'link',
        sub: Number.isFinite(counts.links) ? counts.links + (counts.links === 1 ? ' link in text' : ' links in text') : null,
      },
    ];
    if (Number.isFinite(dur)) cells.push({ label: 'Duration', value: Math.round(dur * 10) / 10, unit: 'min', sub: 'Recorded meeting', icon: 'mic' });
    else if (srcList) cells.push({ label: 'Sources', value: srcList.length, sub: srcList.length === 1 ? 'Cited record' : 'Cited records', icon: 'inbox' });
    if (fresh) {
      const age = ageDays(fresh.iso);
      const stale = age != null && age > STALE_DAYS && fresh.label !== 'Held';
      cells.push({ label: fresh.label, text: relTime(fresh.iso), sub: (stale ? 'Stale · ' : '') + absDate(fresh.iso), icon: 'clock', warn: stale, title: stale ? 'Older than ' + STALE_DAYS + ' days' : '' });
    }
    if (review && reviewAge != null) {
      const overdue = reviewAge > 0;
      cells.push({ label: 'Next review', text: overdue ? 'Overdue' : relTime(review), sub: (overdue ? 'Was due ' : 'Due ') + absDate(review), icon: 'calendar', warn: overdue, title: overdue ? 'Review date has passed' : '' });
    }

    const cellHtml = cells
      .slice(0, 5)
      .map((c) => {
        const isText = c.text != null;
        const missing = !isText && (c.value == null || !Number.isFinite(Number(c.value)));
        const val = isText ? esc(c.text) : esc(k.fmt(missing ? null : c.value)) + (c.unit && !missing ? '<span class="k10v-fact-unit">' + esc(c.unit) + '</span>' : '');
        return '<div class="k10v-fact' + (missing ? ' is-empty' : '') + (c.warn ? ' is-warn' : '') + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' +
          '<span class="k10v-fact-label">' + esc(c.label) + '</span>' +
          '<span class="k10v-fact-ic" aria-hidden="true">' + k.icon(c.icon, 13) + '</span>' +
          '<span class="k10v-fact-val">' + val + '</span>' +
          '<span class="k10v-fact-sub">' + esc(missing ? 'Unavailable' : c.sub || '') + '</span></div>';
      })
      .join('');

    let shape = '';
    if (sections.length >= 2 && words > 0) {
      const segs = sections.slice(0, 40)
        .map((s, i) => {
          const w = Math.max(s.words, 1);
          const label = s.title + ': ' + numFmt(s.words) + ' words';
          return s.id
            ? '<button type="button" class="k10v-shape-seg" style="flex-grow:' + w + '" data-k10v-jump="' + esc(s.id) + '" data-k10v-idx="' + i + '" title="' + esc(label) + '" aria-label="' + esc('Jump to ' + label) + '"></button>'
            : '<span class="k10v-shape-seg is-lead" style="flex-grow:' + w + '" data-k10v-idx="' + i + '" title="' + esc(label) + '"></span>';
        })
        .join('');
      shape = '<div class="k10v-shape">' +
        '<div class="k10v-shape-head"><span>Document shape</span><span class="k10v-shape-pos" id="k10v-shape-pos">' +
        esc(heads.length + (heads.length === 1 ? ' section' : ' sections') + (longest && longest.words ? ' · longest: ' + longest.title : '')) + '</span></div>' +
        '<div class="k10v-shape-bar" role="group" aria-label="Sections by length">' + segs + '</div></div>';
    }
    return '<div class="k10v-fact-row" data-n="' + Math.min(cells.length, 5) + '">' + cellHtml + '</div>' + shape;
  }

  /* ------------------------------------------------------------ related docs */
  function enhanceRelated() {
    const k = K();
    const r = root();
    const list = document.getElementById('doc-related-list');
    if (!k || !list || !r) return;
    const items = [];
    $$('.related-doc-item', list).forEach((btn) => {
      const path = btn.getAttribute('data-open-doc') || '';
      const wiki = btn.getAttribute('data-open-wikilink') || '';
      const title = (btn.querySelector('.related-doc-title') || btn).textContent.trim();
      const key = path ? classifyPath(path) : '';
      const label = key ? labelFor(key) : 'Wikilink';
      items.push({ path, wiki, title, catKey: key, catLabel: label });
      if (btn.classList.contains('k10v-rel') && btn.dataset.k10vCat === key) return;
      if (btn.dataset.k10vTone) btn.classList.remove('k10-tone-' + btn.dataset.k10vTone);
      const m = catMeta(key);
      btn.classList.add('k10v-rel', 'k10-tone-' + m.tone);
      btn.dataset.k10vCat = key;
      btn.dataset.k10vTone = m.tone;
      let tile = btn.querySelector('.k10v-tile');
      if (!tile) {
        tile = document.createElement('span');
        tile.className = 'k10v-tile';
        tile.setAttribute('aria-hidden', 'true');
        btn.insertBefore(tile, btn.firstChild);
      }
      tile.innerHTML = k.icon(key ? m.icon : 'link', 12);
      const badge = btn.querySelector('.related-doc-cat');
      if (badge) badge.textContent = label;
    });
    renderNextGrid(items);
  }

  function renderNextGrid(items) {
    const k = K();
    const r = root();
    const inner = r && $('.vault-reader-inner', r);
    if (!k || !inner) return;
    let next = document.getElementById('k10v-next');
    if (!next) {
      next = document.createElement('section');
      next.id = 'k10v-next';
      next.className = 'k10v-next';
      next.setAttribute('aria-label', 'Continue reading');
      inner.appendChild(next);
    }
    if (!items.length || !r.classList.contains('k10v-has-doc')) {
      next.hidden = true;
      next.innerHTML = '';
      return;
    }
    next.hidden = false;
    const html = nextGridHtml(items);
    if (next.innerHTML !== html) next.innerHTML = html;
  }

  // Pure: items = [{path, wiki, title, catKey, catLabel}]. Shared with the storyboard.
  function nextGridHtml(items) {
    const k = K();
    if (!k) return '';
    items = items || [];
    if (!items.length) return k.emptyState({ title: 'No linked documents', body: 'This document has no related docs or wikilinks yet.', icon: 'link', compact: true });
    return k.sectionHead('Continue reading', '', { level: 3, sub: items.length + (items.length === 1 ? ' linked document' : ' linked documents') }) +
      '<div class="k10v-next-grid">' +
      items.slice(0, 6)
        .map((it) => {
          const m = catMeta(it.catKey);
          const attr = it.path ? 'data-open-doc="' + esc(it.path) + '"' : 'data-open-wikilink="' + esc(it.wiki) + '"';
          const folder = it.path ? folderTrail(it.path, it.catKey) : '';
          return '<button type="button" class="k10v-next-card k10-tone-' + m.tone + '" ' + attr + '>' +
            '<span class="k10v-next-top"><span class="k10v-tile" aria-hidden="true">' + k.icon(it.path ? m.icon : 'link', 13) + '</span>' +
            '<span class="k10v-next-cat">' + esc(it.catLabel || (it.path ? 'Document' : 'Wikilink')) + '</span></span>' +
            '<span class="k10v-next-title">' + esc(it.title) + '</span>' +
            (folder ? '<span class="k10v-next-path">' + esc(folder) + '</span>' : '') + '</button>';
        })
        .join('') +
      '</div>';
  }

  /* ------------------------------------------------------------ scroll-spy */
  function onScroll() {
    if (spy.raf) return;
    spy.raf = requestAnimationFrame(() => {
      spy.raf = 0;
      const scroller = document.getElementById('vault-reader-wrap');
      if (!scroller) return;
      $$('.k10v-shape-seg.is-current').forEach((s) => s.classList.remove('is-current'));
      $$('#doc-toc-list .toc-link.k10v-current').forEach((s) => { s.classList.remove('k10v-current'); s.removeAttribute('aria-current'); });
      if (!spy.heads.length) return;
      const top = scroller.getBoundingClientRect().top + 96;
      let cur = null;
      for (const h of spy.heads) {
        if (!h.el.isConnected) continue;
        if (h.el.getBoundingClientRect().top <= top) cur = h; else break;
      }
      const pos = document.getElementById('k10v-shape-pos');
      if (pos && pos.dataset.base == null) pos.dataset.base = pos.textContent;
      if (!cur) {
        if (pos) pos.textContent = pos.dataset.base;
        return;
      }
      if (pos) pos.textContent = cur.ord + ' of ' + spy.total + ' · ' + cur.title;
      const seg = document.querySelector('.k10v-shape-seg[data-k10v-idx="' + cur.idx + '"]');
      if (seg) seg.classList.add('is-current');
      const link = cur.id && document.querySelector('#doc-toc-list .toc-link[data-toc-id="' + CSS.escape(cur.id) + '"]');
      if (link) { link.classList.add('k10v-current'); link.setAttribute('aria-current', 'location'); }
    });
  }

  /* ------------------------------------------------------------ wiring */
  let docTimer = 0;
  function scheduleDoc() {
    clearTimeout(docTimer);
    docTimer = setTimeout(() => {
      renderDocChrome();
      enhanceRelated();
    }, 0);
  }

  function refreshSidebar() {
    renderLibraryCard();
    enhanceCategories();
    enhanceDocList();
  }

  function observe(id, fn, opts) {
    const el = document.getElementById(id);
    if (!el) return;
    // Work only while Vault is on screen; activation re-renders everything anyway.
    new MutationObserver(() => { if (document.body.classList.contains('view-vault')) fn(); }).observe(el, opts || { childList: true });
  }

  function init() {
    const r = root();
    if (!r || r.dataset.k10v === '1') return;
    r.dataset.k10v = '1';
    observe('vault-cat-list', () => { refreshSidebar(); });
    observe('vault-doc-list', () => { enhanceDocList(); renderLibraryCard(); });
    observe('doc-content', scheduleDoc);
    observe('doc-related-list', scheduleDoc);
    observe('doc-frontmatter', tidyFrontmatter);
    observe('doc-toc-list', onScroll);

    const scroller = document.getElementById('vault-reader-wrap');
    if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });

    r.addEventListener('click', (e) => {
      const filt = e.target.closest('[data-k10v-filter], .k10v-seg[data-k10v-cat]');
      if (filt) {
        const key = filt.getAttribute('data-k10v-filter') || filt.getAttribute('data-k10v-cat');
        if (key) filterCategory(key);
        return;
      }
      const seg = e.target.closest('[data-k10v-jump]');
      if (!seg) return;
      const target = document.getElementById(seg.getAttribute('data-k10v-jump'));
      if (!target) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });

    // Act only on the transition into the vault view, not on every body class change.
    let wasActive = false;
    const activate = () => {
      const on = document.body.classList.contains('view-vault');
      if (on && !wasActive) { refreshSidebar(); scheduleDoc(); }
      wasActive = on;
    };
    new MutationObserver(activate).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    activate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KizukiVault10 = { classifyPath, parseFrontmatter, countWords, catMeta, peopleFrom, libraryHtml, mastheadParts, factsHtml, nextGridHtml, FAMILY_TONE };
})();
