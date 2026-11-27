/* Kizuki Unified Command Plane (Cmd+K Command + Cmd+J Ask Mind) */
/* Registers window.KizukiCommandPlane and slot "cmdk" with zero app.js edits */

(function initKizukiCommandPlane() {
  'use strict';

  const FRECENCY_KEY = 'kizuki' + '-cmdp-frecency-v1';
  const ASK_HISTORY_KEY = 'kizuki' + '-cmdp-ask-v1';
  const MAX_RECENTS = 18;
  const MAX_ASK_TURNS = 16;

  const VERB_CHEATSHEET = [
    { verb: 'open', syntax: 'open <view|entity>', desc: 'Jump to view, person, doc, or thread', write: false, example: 'open board' },
    { verb: 'approve', syntax: 'approve #thread [note]', desc: 'Stamp durable APPROVE via C1 ledger', write: true, example: 'approve #2494 ship now' },
    { verb: 'revise', syntax: 'revise #thread [note]', desc: 'Stamp durable REVISE via C1 ledger', write: true, example: 'revise #2494 tighten copy' },
    { verb: 'defer', syntax: 'defer #thread [note]', desc: 'Stamp durable DEFER via C1 ledger', write: true, example: 'defer #2494 revisit friday' },
    { verb: 'draft', syntax: 'draft <person> [topic]', desc: 'Local-only reply draft (never sends)', write: false, example: 'draft sam dinner tonight' },
    { verb: 'prep', syntax: 'prep <person|meeting>', desc: 'Local-only relationship or meeting prep', write: false, example: 'prep alex' },
    { verb: 'task', syntax: 'task <text> [@agent] [#room]', desc: 'Dispatch task to Agent Board room', write: true, example: 'task audit latency @codex #box' },
    { verb: 'note', syntax: 'note <text>', desc: 'Capture quick note into Mind Codex', write: true, example: 'note Encrypt hero needs one sharp enemy' },
    { verb: 'capture', syntax: 'capture <title> :: <summary>', desc: 'Add structured Codex entry', write: true, example: 'capture Calm Density :: 1px hairlines over bento #philosophy' },
    { verb: 'rule', syntax: 'rule prefer|avoid <text>', desc: 'Lock custom Taste Studio rule', write: true, example: 'rule avoid pastel template gradients' },
    { verb: 'snooze', syntax: 'snooze <id> [hours]', desc: 'Snooze Today triage item (default 4h)', write: true, example: 'snooze 2494 6h' },
    { verb: 'ask', syntax: 'ask <question>', desc: 'Hybrid lexical + semantic Ask Mind', write: false, example: 'ask people I should reconnect with' },
  ];

  const QUICK_VIEWS = [
    { id: 'view:today', kind: 'view', title: 'Today Workbench', subtitle: 'Brief, schedule, next moves, and inbox', badge: 'View', target: { view: 'today' }, verbs: ['open'] },
    { id: 'view:people', kind: 'view', title: 'People Dossiers', subtitle: 'Cross-channel timelines, 52w ledger, drift radar', badge: 'View', target: { view: 'people' }, verbs: ['open'] },
    { id: 'view:board', kind: 'view', title: 'Agent Board', subtitle: 'Live rooms, decision gates, blockers, and mesh', badge: 'View', target: { view: 'board' }, verbs: ['open'] },
    { id: 'view:codex', kind: 'view', title: 'Mind Codex', subtitle: 'Philosophies, interests, hobbies, ideas, actions', badge: 'View', target: { view: 'codex' }, verbs: ['open'] },
    { id: 'view:taste', kind: 'view', title: 'Taste Studio', subtitle: 'Calibration deck, prefer/avoid rules, taste vault', badge: 'View', target: { view: 'taste' }, verbs: ['open'] },
    { id: 'view:replay', kind: 'view', title: 'Life Replay', subtitle: 'Offline life map, trips, calendar, day stories', badge: 'View', target: { view: 'replay' }, verbs: ['open'] },
    { id: 'view:vault', kind: 'view', title: 'Vault Explorer', subtitle: 'Kizuki, Obsidian, Apple Notes, Wispr docs', badge: 'View', target: { view: 'vault' }, verbs: ['open'] },
    { id: 'view:graph', kind: 'view', title: 'Mind Graph', subtitle: 'World graph topology and node inspector', badge: 'View', target: { view: 'graph' }, verbs: ['open'] },
    { id: 'view:stream', kind: 'view', title: 'Live Event Stream', subtitle: 'Chronological events across pipelines', badge: 'View', target: { view: 'stream' }, verbs: ['open'] },
    { id: 'view:atlas', kind: 'view', title: 'World Atlas', subtitle: 'Resume, changed, stale, commitments, questions', badge: 'View', target: { view: 'atlas' }, verbs: ['open'] },
    { id: 'view:memt', kind: 'view', title: 'MemT Library', subtitle: 'Verified procedural rules and recipes', badge: 'View', target: { view: 'memt' }, verbs: ['open'] },
  ];

  const WRITE_VERBS = new Set(['approve', 'revise', 'defer', 'task', 'note', 'capture', 'rule', 'snooze']);
  const ALL_VERBS = new Set(VERB_CHEATSHEET.map((v) => v.verb));

  const ui = {
    open: false,
    mode: 'command', // 'command' | 'ask'
    showHelp: false,
    query: '',
    hits: [],
    selectedIndex: 0,
    selectedHitId: null,
    userNavigated: false,
    preview: null,
    parsedVerb: 'search',
    isWrite: false,
    confirmArmed: false,
    executing: false,
    semanticUsed: false,
    latencyText: '',
    receipt: null, // { ok, title, body, localOnly, verb }
    askTurns: loadAskHistory(),
    askPending: false,
    reqSeq: 0,
    semTimer: null,
    backdrop: null,
    input: null,
    body: null,
    meta: null,
    semBadge: null,
    previewBox: null,
    receiptBox: null,
    modeTabs: null,
  };

  function stripEmDash(str) {
    return String(str || '').replace(/\s*\u2014\s*/g, ' - ').replace(/\u2014/g, '-');
  }

  function escHtml(str) {
    return stripEmDash(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadRecents() {
    try {
      const raw = window.localStorage.getItem(FRECENCY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecents(items) {
    try {
      window.localStorage.setItem(FRECENCY_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
    } catch (_) {
      // ignore quota
    }
  }

  function recordFrecency(entry) {
    if (!entry || !entry.id || !entry.title) return;
    const now = Date.now();
    const list = loadRecents();
    const idx = list.findIndex((x) => x.id === entry.id);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        ...entry,
        count: (Number(list[idx].count) || 1) + 1,
        lastUsed: now,
      };
    } else {
      list.unshift({
        id: entry.id,
        kind: entry.kind || 'view',
        title: stripEmDash(entry.title),
        subtitle: stripEmDash(entry.subtitle || ''),
        badge: entry.badge || 'Recent',
        command: entry.command || '',
        target: entry.target || {},
        verbs: entry.verbs || ['open'],
        count: 1,
        lastUsed: now,
      });
    }
    list.sort((a, b) => computeFrecencyScore(b, now) - computeFrecencyScore(a, now));
    saveRecents(list);
  }

  function computeFrecencyScore(item, now) {
    const ageDays = Math.max(0, (now - (Number(item.lastUsed) || 0)) / 86_400_000);
    return (Number(item.count) || 1) / (1 + ageDays * 0.6);
  }

  function loadAskHistory() {
    try {
      const raw = window.localStorage.getItem(ASK_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(-MAX_ASK_TURNS) : [];
    } catch (_) {
      return [];
    }
  }

  function saveAskHistory() {
    try {
      window.localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(ui.askTurns.slice(-MAX_ASK_TURNS)));
    } catch (_) {
      // ignore
    }
  }

  function renderMarkdownSafe(text) {
    const clean = stripEmDash(text || '');
    if (window.KizukiMarkdown && typeof window.KizukiMarkdown.render === 'function') {
      try {
        return window.KizukiMarkdown.render(clean);
      } catch (_) {
        // fallback below
      }
    }
    return escHtml(clean).replace(/\n/g, '<br>');
  }

  function navigateToTarget(target) {
    if (!target || typeof target !== 'object') return;
    close();

    // Direct tab switch when only view navigation is requested
    const view = target.view;
    const hasDeepEntity = Boolean(target.personKey || target.docPath || target.threadId || target.itemId || target.nodeId || target.day);

    if (view && !hasDeepEntity) {
      const btn = document.querySelector('.os-nav-btn[data-view="' + view + '"]');
      if (btn) {
        btn.click();
        return;
      }
    }

    if (target.personKey) {
      const url = new URL(window.location.href);
      url.search = '?person=' + encodeURIComponent(target.personKey);
      window.location.href = url.toString();
      return;
    }

    if (target.docPath) {
      const url = new URL(window.location.href);
      url.search = '?doc=' + encodeURIComponent(target.docPath);
      window.location.href = url.toString();
      return;
    }

    if (target.threadId) {
      const params = new URLSearchParams();
      params.set('view', 'board');
      if (target.channel) params.set('channel', String(target.channel));
      params.set('thread', String(target.threadId));
      params.set('stage', 'thread');
      window.location.href = '/?' + params.toString();
      return;
    }

    if (target.itemId) {
      const params = new URLSearchParams();
      params.set('view', 'codex');
      if (target.section) params.set('section', String(target.section));
      params.set('itemId', String(target.itemId));
      window.location.href = '/?' + params.toString();
      return;
    }

    if (target.domain && view === 'taste') {
      const params = new URLSearchParams();
      params.set('view', 'taste');
      params.set('domain', String(target.domain));
      window.location.href = '/?' + params.toString();
      return;
    }

    if (target.nodeId) {
      window.location.href = '/?node=' + encodeURIComponent(String(target.nodeId));
      return;
    }

    if (view) {
      const btn = document.querySelector('.os-nav-btn[data-view="' + view + '"]');
      if (btn) {
        btn.click();
        return;
      }
      window.location.href = '/?view=' + encodeURIComponent(view);
    }
  }

  function buildVerbCommandForHit(verb, hit) {
    const t = hit.target || {};
    if (verb === 'open') return null;
    if (verb === 'approve' || verb === 'revise' || verb === 'defer') {
      const tid = t.threadId || hit.id.replace(/^board:/, '');
      return verb + ' #' + tid + ' ';
    }
    if (verb === 'draft') {
      const who = t.personKey || t.sender || hit.title;
      return 'draft ' + String(who).split(/\s+/)[0].toLowerCase() + ' ';
    }
    if (verb === 'prep') {
      const key = t.personKey || t.title || hit.title;
      return 'prep ' + String(key);
    }
    if (verb === 'snooze') {
      const sid = t.threadId || t.inboxId || t.meetingId || hit.id;
      return 'snooze ' + String(sid) + ' 4h';
    }
    if (verb === 'ask') {
      return 'ask What is the latest context on ' + stripEmDash(hit.title) + '?';
    }
    return verb + ' ' + stripEmDash(hit.title);
  }

  function ensureDom() {
    if (ui.backdrop && ui.backdrop.isConnected) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'kizuki-cmdp-backdrop';
    backdrop.className = 'cmdp-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = [
      '<div class="cmdp-modal" id="kizuki-cmdp-modal" role="dialog" aria-modal="true" aria-label="Kizuki Unified Command Plane">',
      '  <header class="cmdp-header">',
      '    <div class="cmdp-mode-tabs" role="tablist" aria-label="Palette Mode">',
      '      <button type="button" class="cmdp-mode-tab is-active" role="tab" data-cmdp-mode="command" aria-selected="true">Command <kbd>Cmd+K</kbd></button>',
      '      <button type="button" class="cmdp-mode-tab" role="tab" data-cmdp-mode="ask" aria-selected="false">Ask Mind <kbd>Cmd+J</kbd></button>',
      '    </div>',
      '    <div class="cmdp-header-right">',
      '      <span class="cmdp-sem-badge" id="cmdp-sem-badge" hidden>Semantic RRF</span>',
      '      <span class="cmdp-meta tabular" id="cmdp-meta">READY</span>',
      '      <button type="button" class="cmdp-help-btn" id="cmdp-help-btn" title="Command grammar cheat sheet (?)" aria-label="Toggle command grammar cheat sheet">?</button>',
      '    </div>',
      '  </header>',
      '  <div class="cmdp-input-row">',
      '    <span class="cmdp-prompt-glyph" id="cmdp-prompt-glyph">&gt;</span>',
      '    <input id="cmdp-input" class="cmdp-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type a verb (approve, task, prep, draft, capture, rule, ask) or search..." aria-label="Command or search input">',
      '    <button type="button" class="cmdp-clear-btn" id="cmdp-clear-btn" hidden aria-label="Clear input">Clear</button>',
      '  </div>',
      '  <div class="cmdp-preview-box" id="cmdp-preview-box" hidden></div>',
      '  <div class="cmdp-receipt-box" id="cmdp-receipt-box" hidden></div>',
      '  <div class="cmdp-body" id="cmdp-body" role="listbox" aria-label="Command results"></div>',
      '  <footer class="cmdp-footer">',
      '    <span><kbd>Tab</kbd> Switch Mode</span>',
      '    <span><kbd>&uarr;&darr;</kbd> Select</span>',
      '    <span><kbd>Enter</kbd> Run</span>',
      '    <span><kbd>Cmd+Enter</kbd> Confirm Write</span>',
      '    <span><kbd>?</kbd> Verbs</span>',
      '    <span><kbd>Esc</kbd> Close</span>',
      '  </footer>',
      '</div>',
    ].join('');

    document.body.appendChild(backdrop);

    ui.backdrop = backdrop;
    ui.input = backdrop.querySelector('#cmdp-input');
    ui.body = backdrop.querySelector('#cmdp-body');
    ui.meta = backdrop.querySelector('#cmdp-meta');
    ui.semBadge = backdrop.querySelector('#cmdp-sem-badge');
    ui.previewBox = backdrop.querySelector('#cmdp-preview-box');
    ui.receiptBox = backdrop.querySelector('#cmdp-receipt-box');
    ui.modeTabs = Array.from(backdrop.querySelectorAll('[data-cmdp-mode]'));

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        close();
        return;
      }
      const tabBtn = e.target.closest('[data-cmdp-mode]');
      if (tabBtn) {
        setMode(tabBtn.getAttribute('data-cmdp-mode') || 'command');
        return;
      }
      if (e.target.closest('#cmdp-help-btn')) {
        ui.showHelp = !ui.showHelp;
        renderBody();
        ui.input.focus();
        return;
      }
      if (e.target.closest('#cmdp-clear-btn')) {
        ui.input.value = '';
        ui.query = '';
        ui.receipt = null;
        ui.confirmArmed = false;
        handleInputChange('');
        ui.input.focus();
        return;
      }
      const confirmBtn = e.target.closest('[data-cmdp-confirm]');
      if (confirmBtn) {
        executeActiveCommand(true);
        return;
      }
      const copyBtn = e.target.closest('[data-cmdp-copy]');
      if (copyBtn && ui.receipt && ui.receipt.body) {
        try {
          navigator.clipboard.writeText(ui.receipt.body);
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
        } catch (_) {
          // ignore
        }
        return;
      }
      const exampleBtn = e.target.closest('[data-cmdp-example]');
      if (exampleBtn) {
        const ex = exampleBtn.getAttribute('data-cmdp-example') || '';
        ui.showHelp = false;
        setMode('command', { keepQuery: true });
        ui.input.value = ex;
        handleInputChange(ex);
        ui.input.focus();
        return;
      }
      const chipBtn = e.target.closest('[data-cmdp-chip-verb]');
      if (chipBtn) {
        e.stopPropagation();
        const verb = chipBtn.getAttribute('data-cmdp-chip-verb');
        const idx = Number(chipBtn.getAttribute('data-cmdp-idx'));
        const hit = ui.hits[idx];
        if (!hit || !verb) return;
        if (verb === 'open') {
          recordFrecency(hit);
          navigateToTarget(hit.target);
          return;
        }
        const cmd = buildVerbCommandForHit(verb, hit);
        if (!cmd) return;
        if (verb === 'ask') {
          setMode('ask', { keepQuery: true });
          const q = cmd.replace(/^ask\s+/i, '');
          ui.input.value = q;
          submitAskQuestion(q);
          return;
        }
        ui.input.value = cmd;
        handleInputChange(cmd);
        ui.input.focus();
        if (!WRITE_VERBS.has(verb) && (verb === 'prep' || (verb === 'draft' && !cmd.endsWith(' ')))) {
          executeActiveCommand(false);
        }
        return;
      }
      const askEntityChip = e.target.closest('[data-cmdp-entity-idx]');
      if (askEntityChip) {
        const turnIdx = Number(askEntityChip.getAttribute('data-cmdp-turn-idx'));
        const entIdx = Number(askEntityChip.getAttribute('data-cmdp-entity-idx'));
        const turn = ui.askTurns[turnIdx];
        const ent = turn && Array.isArray(turn.entities) ? turn.entities[entIdx] : null;
        if (ent && ent.target) {
          recordFrecency(ent);
          navigateToTarget(ent.target);
        }
        return;
      }
      const rowBtn = e.target.closest('[data-cmdp-row-idx]');
      if (rowBtn) {
        const idx = Number(rowBtn.getAttribute('data-cmdp-row-idx'));
        const hit = ui.hits[idx];
        if (hit) {
          activateHit(hit);
        }
      }
    });

    ui.input.addEventListener('input', () => {
      const val = ui.input.value;
      handleInputChange(val);
    });

    ui.input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        setMode(ui.mode === 'command' ? 'ask' : 'command');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (ui.showHelp) {
          ui.showHelp = false;
          renderBody();
          return;
        }
        close();
        return;
      }
      if (ui.mode === 'ask') {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const q = ui.input.value.trim();
          if (q) submitAskQuestion(q);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const forceConfirm = Boolean(e.metaKey || e.ctrlKey);
        if (ui.preview && ui.parsedVerb !== 'search') {
          if (ui.isWrite) {
            if (forceConfirm || ui.confirmArmed) {
              executeActiveCommand(true);
            } else {
              ui.confirmArmed = true;
              renderPreview();
            }
          } else {
            executeActiveCommand(false);
          }
          return;
        }
        const hit = ui.hits[ui.selectedIndex];
        if (hit) {
          activateHit(hit);
        } else if (ui.query.trim()) {
          setMode('ask', { keepQuery: true });
          submitAskQuestion(ui.query.trim());
        }
      }
    });
  }

  function setMode(nextMode, opts) {
    const mode = nextMode === 'ask' ? 'ask' : 'command';
    ui.mode = mode;
    ui.showHelp = false;
    ui.confirmArmed = false;

    if (ui.modeTabs) {
      ui.modeTabs.forEach((btn) => {
        const active = btn.getAttribute('data-cmdp-mode') === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    const glyph = ui.backdrop && ui.backdrop.querySelector('#cmdp-prompt-glyph');
    if (glyph) glyph.textContent = mode === 'ask' ? '?' : '>';

    if (ui.input) {
      ui.input.placeholder =
        mode === 'ask'
          ? 'Ask Mind anything across calendar, inbox, people, codex, taste, and board...'
          : 'Type a verb (approve, task, prep, draft, capture, rule, snooze, ask) or search...';
      if (!(opts && opts.keepQuery)) {
        ui.input.value = '';
        ui.query = '';
      }
      ui.input.focus();
    }

    if (mode === 'ask') {
      ui.preview = null;
      ui.parsedVerb = 'ask';
      ui.isWrite = false;
      renderPreview();
      renderReceipt();
      renderAskBody();
    } else {
      handleInputChange(ui.input ? ui.input.value : '');
    }
  }

  function moveSelection(delta) {
    if (ui.hits.length === 0) return;
    ui.userNavigated = true;
    ui.selectedIndex = (ui.selectedIndex + delta + ui.hits.length) % ui.hits.length;
    ui.selectedHitId = ui.hits[ui.selectedIndex] ? ui.hits[ui.selectedIndex].id : null;
    updateSelectedRowClasses();
  }

  function updateSelectedRowClasses() {
    if (!ui.body) return;
    const rows = ui.body.querySelectorAll('[data-cmdp-row-idx]');
    rows.forEach((el) => {
      const idx = Number(el.getAttribute('data-cmdp-row-idx'));
      const active = idx === ui.selectedIndex;
      el.classList.toggle('is-selected', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function activateHit(hit) {
    if (!hit) return;
    if (hit.command) {
      ui.input.value = hit.command;
      handleInputChange(hit.command);
      ui.input.focus();
      return;
    }
    recordFrecency(hit);
    navigateToTarget(hit.target);
  }

  function buildInstantLocalHits(query) {
    const q = query.trim().toLowerCase();
    const recents = loadRecents();

    if (!q) {
      const out = [];
      const seen = new Set();
      for (const r of recents.slice(0, 5)) {
        seen.add(r.id);
        out.push({ ...r, group: 'Recent', badge: r.badge || 'Recent' });
      }
      for (const v of QUICK_VIEWS) {
        if (seen.has(v.id)) continue;
        out.push({ ...v, group: 'Workspaces' });
      }
      return out;
    }

    const matches = [];
    const seen = new Set();
    for (const r of recents) {
      if ((r.title + ' ' + r.subtitle).toLowerCase().includes(q)) {
        seen.add(r.id);
        matches.push({ ...r, group: 'Recent' });
      }
    }
    for (const v of QUICK_VIEWS) {
      if (seen.has(v.id)) continue;
      if ((v.title + ' ' + v.subtitle + ' ' + v.id).toLowerCase().includes(q)) {
        seen.add(v.id);
        matches.push({ ...v, group: 'Workspaces' });
      }
    }
    return matches;
  }

  function handleInputChange(rawVal) {
    ui.query = rawVal;
    ui.confirmArmed = false;
    ui.receipt = null;
    renderReceipt();

    const clearBtn = ui.backdrop && ui.backdrop.querySelector('#cmdp-clear-btn');
    if (clearBtn) clearBtn.hidden = !rawVal.trim();

    if (ui.mode === 'ask') {
      return;
    }

    const trimmed = rawVal.trim();
    if (trimmed === '?') {
      ui.showHelp = true;
      ui.preview = null;
      renderPreview();
      renderBody();
      return;
    }
    ui.showHelp = false;

    if (ui.semTimer) {
      clearTimeout(ui.semTimer);
      ui.semTimer = null;
    }

    if (!trimmed) {
      ui.parsedVerb = 'search';
      ui.isWrite = false;
      ui.preview = null;
      ui.semanticUsed = false;
      ui.userNavigated = false;
      ui.selectedIndex = 0;
      ui.selectedHitId = null;
      ui.hits = buildInstantLocalHits('');
      updateBadges('READY', false);
      renderPreview();
      renderBody();
      return;
    }

    // Immediate synchronous local paint (<5ms keystroke-to-paint)
    const head = trimmed.split(/\s+/)[0].toLowerCase();
    const isKnownVerb = ALL_VERBS.has(head);
    ui.parsedVerb = isKnownVerb ? head : 'search';
    ui.isWrite = WRITE_VERBS.has(head);
    ui.semanticUsed = false;

    const localInstant = buildInstantLocalHits(trimmed);
    if (!ui.userNavigated) {
      ui.hits = localInstant;
      ui.selectedIndex = 0;
      ui.selectedHitId = ui.hits[0] ? ui.hits[0].id : null;
      renderBody();
    }

    const seq = ++ui.reqSeq;
    const t0 = performance.now();

    // Stage 1: Fast lexical resolve (<25ms server)
    fetch('/api/command/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
      body: JSON.stringify({ q: trimmed, includeSemantic: false, limit: 20 }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || seq !== ui.reqSeq || !ui.open || ui.mode !== 'command') return;
        const paintMs = Math.max(1, Math.round(performance.now() - t0));
        ui.parsedVerb = data.verb || 'search';
        ui.isWrite = Boolean(data.isWrite);
        ui.preview = data.preview || null;

        const serverHits = Array.isArray(data.hits) ? data.hits : [];
        mergeHitsWithoutJump(serverHits, false);
        updateBadges(paintMs + 'ms | ' + ui.hits.length + ' hits', false);
        renderPreview();
        renderBody();
      })
      .catch(() => {
        if (seq !== ui.reqSeq) return;
        updateBadges('LOCAL', false);
      });

    // Stage 2: Semantic RRF rerank (arrives softly without jumping selected row!)
    ui.semTimer = setTimeout(() => {
      fetch('/api/command/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        body: JSON.stringify({ q: trimmed, includeSemantic: true, limit: 20 }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || seq !== ui.reqSeq || !ui.open || ui.mode !== 'command') return;
          if (!data.semanticUsed) return;
          const serverHits = Array.isArray(data.hits) ? data.hits : [];
          ui.semanticUsed = true;
          mergeHitsWithoutJump(serverHits, true);
          updateBadges((data.lexicalMs || 0) + '+' + (data.semanticMs || 0) + 'ms', true);
          renderBody();
        })
        .catch(() => {
          // Semantic fallback silent
        });
    }, 80);
  }

  function mergeHitsWithoutJump(incomingHits, isSemanticUpdate) {
    if (!isSemanticUpdate || !ui.userNavigated || !ui.selectedHitId) {
      const prevSelectedId = ui.selectedHitId;
      ui.hits = incomingHits;
      if (prevSelectedId) {
        const foundIdx = ui.hits.findIndex((h) => h.id === prevSelectedId);
        if (foundIdx >= 0) {
          ui.selectedIndex = foundIdx;
          return;
        }
      }
      ui.selectedIndex = 0;
      ui.selectedHitId = ui.hits[0] ? ui.hits[0].id : null;
      return;
    }

    // User has actively navigated to a specific row: pin their selected row in-place
    // and update semantic scores / append new semantic discoveries below without shifting selection!
    const existingById = new Map(ui.hits.map((h) => [h.id, h]));
    const incomingById = new Map(incomingHits.map((h) => [h.id, h]));

    const stabilized = ui.hits.map((h) => {
      const sem = incomingById.get(h.id);
      return sem ? { ...h, semanticScore: sem.semanticScore, rrfScore: sem.rrfScore } : h;
    });

    for (const h of incomingHits) {
      if (!existingById.has(h.id)) {
        stabilized.push({ ...h, semanticDiscovery: true });
      }
    }

    ui.hits = stabilized;
    const pinnedIdx = ui.hits.findIndex((h) => h.id === ui.selectedHitId);
    if (pinnedIdx >= 0) ui.selectedIndex = pinnedIdx;
  }

  function updateBadges(metaText, semanticActive) {
    if (ui.meta) ui.meta.textContent = metaText;
    if (ui.semBadge) ui.semBadge.hidden = !semanticActive;
  }

  function renderPreview() {
    if (!ui.previewBox) return;
    if (!ui.preview || ui.mode !== 'command' || ui.showHelp) {
      ui.previewBox.hidden = true;
      ui.previewBox.innerHTML = '';
      return;
    }
    const p = ui.preview;
    const methodCls = p.requiresConfirm ? 'is-write' : 'is-read';
    const confirmLabel = ui.executing
      ? 'Executing...'
      : ui.confirmArmed
        ? 'Press Enter to Confirm'
        : p.requiresConfirm
          ? 'Confirm & Execute'
          : 'Run Now';

    ui.previewBox.hidden = false;
    ui.previewBox.innerHTML = [
      '<div class="cmdp-preview-inner ' + (ui.confirmArmed ? 'is-armed' : '') + '">',
      '  <div class="cmdp-preview-main">',
      '    <div class="cmdp-preview-top">',
      '      <span class="cmdp-method-pill ' + methodCls + '">' + escHtml(p.method) + '</span>',
      '      <code class="cmdp-endpoint">' + escHtml(p.endpoint) + '</code>',
      p.localOnly ? '<span class="cmdp-local-pill">LOCAL ONLY</span>' : '',
      '    </div>',
      '    <div class="cmdp-preview-summary">' + escHtml(p.summary) + '</div>',
      '  </div>',
      '  <button type="button" class="cmdp-confirm-btn ' + (ui.confirmArmed ? 'is-armed' : '') + '" data-cmdp-confirm="1"' + (ui.executing ? ' disabled' : '') + '>',
      '    ' + escHtml(confirmLabel),
      '  </button>',
      '</div>',
    ].join('');
  }

  function renderReceipt() {
    if (!ui.receiptBox) return;
    if (!ui.receipt) {
      ui.receiptBox.hidden = true;
      ui.receiptBox.innerHTML = '';
      return;
    }
    const r = ui.receipt;
    ui.receiptBox.hidden = false;
    ui.receiptBox.innerHTML = [
      '<div class="cmdp-receipt ' + (r.ok ? 'is-ok' : 'is-err') + '">',
      '  <div class="cmdp-receipt-head">',
      '    <span class="cmdp-receipt-title">' + escHtml(r.title) + '</span>',
      r.localOnly ? '<span class="cmdp-local-pill">LOCAL ONLY</span>' : '',
      r.body ? '<button type="button" class="cmdp-copy-btn" data-cmdp-copy="1">Copy</button>' : '',
      '  </div>',
      r.body ? '<div class="cmdp-receipt-body">' + renderMarkdownSafe(r.body) + '</div>' : '',
      '</div>',
    ].join('');
  }

  async function executeActiveCommand(confirm) {
    const q = (ui.query || '').trim();
    if (!q || ui.executing) return;
    ui.executing = true;
    renderPreview();

    try {
      const resp = await fetch('/api/command/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        body: JSON.stringify({ q, confirm: Boolean(confirm) }),
      });
      const data = await resp.json();
      ui.executing = false;
      ui.confirmArmed = false;

      if (!resp.ok || !data.ok) {
        ui.receipt = {
          ok: false,
          title: data.error === 'confirmation_required' ? 'Confirmation Required' : 'Command Blocked',
          body: data.message || data.error || 'Execution failed',
        };
        renderPreview();
        renderReceipt();
        return;
      }

      recordFrecency({
        id: 'cmd:' + q.toLowerCase().slice(0, 64),
        kind: 'command',
        title: q,
        subtitle: (ui.preview && ui.preview.summary) || 'Recent command',
        badge: data.verb || 'Cmd',
        command: q,
      });

      if (data.verb === 'open' && data.navigation) {
        navigateToTarget(data.navigation);
        return;
      }

      if (data.verb === 'ask') {
        const answerText = (data.result && (data.result.answer || data.result.response || data.result.text)) || JSON.stringify(data.result);
        ui.askTurns.push({
          q: q.replace(/^ask\s+/i, ''),
          answer: stripEmDash(answerText),
          engine: (data.result && data.result.engine) || 'Kizuki Mind',
          semanticUsed: Boolean(data.semanticUsed),
          entities: Array.isArray(data.entities) ? data.entities : [],
        });
        saveAskHistory();
        setMode('ask');
        return;
      }

      const bodyText =
        (data.result && (data.result.draft || data.result.summary || data.result.message)) ||
        (data.result && data.result.item && ('Saved Codex entry: ' + data.result.item.title)) ||
        (data.result && data.result.rule && ('Locked Taste rule: ' + data.result.rule.rule)) ||
        (data.result && data.result.until && ('Snoozed until ' + data.result.until)) ||
        ('Completed ' + data.verb + ' cleanly.');

      ui.receipt = {
        ok: true,
        title: (data.verb || 'Command').toUpperCase() + ' Executed',
        body: stripEmDash(String(bodyText)),
        localOnly: Boolean(data.local_only),
      };
      renderPreview();
      renderReceipt();
    } catch (err) {
      ui.executing = false;
      ui.confirmArmed = false;
      ui.receipt = {
        ok: false,
        title: 'Execution Error',
        body: stripEmDash(err && err.message ? err.message : 'Network error'),
      };
      renderPreview();
      renderReceipt();
    }
  }

  async function submitAskQuestion(question) {
    const q = String(question || '').trim();
    if (!q || ui.askPending) return;
    ui.askPending = true;
    ui.input.value = '';
    updateBadges('THINKING...', false);
    renderAskBody(q);

    try {
      const resp = await fetch('/api/command/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        body: JSON.stringify({ q: 'ask ' + q, confirm: false }),
      });
      const data = await resp.json();
      ui.askPending = false;

      const answerText =
        (data && data.result && (data.result.answer || data.result.response || data.result.text)) ||
        (data && data.message) ||
        'No response received.';

      ui.askTurns.push({
        q,
        answer: stripEmDash(String(answerText)),
        engine: (data && data.result && data.result.engine) || 'Kizuki Mind',
        semanticUsed: Boolean(data && data.semanticUsed),
        entities: Array.isArray(data && data.entities) ? data.entities : [],
      });
      saveAskHistory();
      updateBadges(ui.askTurns.length + ' turns', Boolean(data && data.semanticUsed));
      renderAskBody();
    } catch (err) {
      ui.askPending = false;
      ui.askTurns.push({
        q,
        answer: 'Error querying Ask Mind: ' + stripEmDash(err && err.message ? err.message : 'unknown'),
        engine: 'Error',
        semanticUsed: false,
        entities: [],
      });
      updateBadges('ERR', false);
      renderAskBody();
    }
  }

  function renderHelpSheet() {
    const cards = VERB_CHEATSHEET.map((item) => {
      return [
        '<div class="cmdp-help-card">',
        '  <div class="cmdp-help-top">',
        '    <code class="cmdp-help-syntax">' + escHtml(item.syntax) + '</code>',
        '    <span class="cmdp-help-badge ' + (item.write ? 'is-write' : 'is-read') + '">' + (item.write ? 'Confirm' : 'Instant') + '</span>',
        '  </div>',
        '  <div class="cmdp-help-desc">' + escHtml(item.desc) + '</div>',
        '  <button type="button" class="cmdp-example-btn" data-cmdp-example="' + escHtml(item.example) + '">Try: ' + escHtml(item.example) + '</button>',
        '</div>',
      ].join('');
    });
    return '<div class="cmdp-help-header">12 Actionable Command Verbs</div><div class="cmdp-help-grid">' + cards.join('') + '</div>';
  }

  function renderAskBody(pendingQuestion) {
    if (!ui.body) return;
    if (ui.showHelp) {
      ui.body.innerHTML = renderHelpSheet();
      return;
    }

    const parts = [];
    if (ui.askTurns.length === 0 && !pendingQuestion) {
      parts.push(
        '<div class="cmdp-ask-empty">' +
          '<div class="cmdp-ask-empty-title">Ask Mind with Hybrid Lexical + Semantic Recall</div>' +
          '<div class="cmdp-ask-empty-sub">Every question retrieves grounded vault, people, codex, taste, and board context before answering.</div>' +
          '<div class="cmdp-ask-starters">' +
          '  <button type="button" class="cmdp-example-btn" data-cmdp-example="ask people I should reconnect with">People to reconnect with</button>' +
          '  <button type="button" class="cmdp-example-btn" data-cmdp-example="ask what decisions are blocked on the board?">Blocked board decisions</button>' +
          '  <button type="button" class="cmdp-example-btn" data-cmdp-example="ask summarize my typography and copy taste rules">Typography & copy rules</button>' +
          '</div>' +
        '</div>'
      );
    } else {
      ui.askTurns.forEach((turn, tIdx) => {
        const chipsHtml = (turn.entities || [])
          .slice(0, 6)
          .map((ent, eIdx) => {
            return (
              '<button type="button" class="cmdp-entity-chip" data-cmdp-turn-idx="' + tIdx + '" data-cmdp-entity-idx="' + eIdx + '">' +
              '<span class="cmdp-entity-kind">' + escHtml(ent.badge || ent.kind || 'Ref') + '</span>' +
              '<span>' + escHtml(stripEmDash(ent.title || '').slice(0, 42)) + '</span>' +
              '</button>'
            );
          })
          .join('');

        parts.push(
          '<div class="cmdp-ask-turn">' +
            '<div class="cmdp-ask-q">' + escHtml(turn.q) + '</div>' +
            '<div class="cmdp-ask-a">' + renderMarkdownSafe(turn.answer) + '</div>' +
            '<div class="cmdp-ask-meta">' +
              '<span>' + escHtml(turn.engine || 'Kizuki Mind') + '</span>' +
              (turn.semanticUsed ? '<span class="cmdp-sem-inline">Semantic RRF</span>' : '') +
            '</div>' +
            (chipsHtml ? '<div class="cmdp-entity-chips">' + chipsHtml + '</div>' : '') +
          '</div>'
        );
      });
      if (pendingQuestion) {
        parts.push(
          '<div class="cmdp-ask-turn is-pending">' +
            '<div class="cmdp-ask-q">' + escHtml(pendingQuestion) + '</div>' +
            '<div class="cmdp-ask-a">Retrieving lexical + semantic context...</div>' +
          '</div>'
        );
      }
    }

    ui.body.innerHTML = '<div class="cmdp-ask-stream">' + parts.join('') + '</div>';
    ui.body.scrollTop = ui.body.scrollHeight;
  }

  function renderBody() {
    if (!ui.body) return;
    if (ui.mode === 'ask') {
      renderAskBody();
      return;
    }
    if (ui.showHelp) {
      ui.body.innerHTML = renderHelpSheet();
      return;
    }

    if (ui.hits.length === 0) {
      ui.body.innerHTML =
        '<div class="cmdp-empty">No direct hits yet. Press <kbd>Tab</kbd> to Ask Mind or type <kbd>?</kbd> for command verbs.</div>';
      return;
    }

    const rowsHtml = [];
    let lastGroup = '';

    ui.hits.forEach((hit, idx) => {
      const groupLabel = hit.group || (hit.semanticDiscovery ? 'Semantic Recall' : hit.kind ? hit.kind.toUpperCase() : 'Results');
      if (groupLabel !== lastGroup) {
        lastGroup = groupLabel;
        rowsHtml.push('<div class="cmdp-group-label">' + escHtml(groupLabel) + '</div>');
      }

      const selected = idx === ui.selectedIndex;
      const verbs = Array.isArray(hit.verbs) && hit.verbs.length > 0 ? hit.verbs.slice(0, 4) : ['open'];
      const chips = verbs
        .map((v) => {
          return (
            '<button type="button" class="cmdp-verb-chip ' + (WRITE_VERBS.has(v) ? 'is-write' : '') + '" data-cmdp-chip-verb="' + escHtml(v) + '" data-cmdp-idx="' + idx + '">' +
            escHtml(v) +
            '</button>'
          );
        })
        .join('');

      const semPill =
        typeof hit.semanticScore === 'number' && hit.semanticScore >= 0.45
          ? '<span class="cmdp-sem-score tabular" title="Semantic cosine similarity">' + Math.round(hit.semanticScore * 100) + '%</span>'
          : '';

      rowsHtml.push(
        '<div class="cmdp-row ' + (selected ? 'is-selected' : '') + '" role="option" aria-selected="' + (selected ? 'true' : 'false') + '" data-cmdp-row-idx="' + idx + '">' +
          '<div class="cmdp-row-main">' +
            '<div class="cmdp-row-title-line">' +
              '<span class="cmdp-row-title">' + escHtml(hit.title || hit.id) + '</span>' +
              '<span class="cmdp-row-badge">' + escHtml(hit.badge || hit.kind || '') + '</span>' +
              semPill +
            '</div>' +
            (hit.subtitle ? '<div class="cmdp-row-sub">' + escHtml(hit.subtitle) + '</div>' : '') +
          '</div>' +
          '<div class="cmdp-row-verbs">' + chips + '</div>' +
        '</div>'
      );
    });

    ui.body.innerHTML = rowsHtml.join('');
  }

  function open(mode) {
    ensureDom();
    ui.open = true;
    ui.backdrop.hidden = false;
    setMode(mode === 'ask' ? 'ask' : 'command');
  }

  function close() {
    ui.open = false;
    ui.confirmArmed = false;
    if (ui.semTimer) {
      clearTimeout(ui.semTimer);
      ui.semTimer = null;
    }
    if (ui.backdrop) {
      ui.backdrop.hidden = true;
    }
  }

  function toggle(mode) {
    const targetMode = mode === 'ask' ? 'ask' : 'command';
    if (ui.open && ui.mode === targetMode) {
      close();
    } else {
      open(targetMode);
    }
  }

  // Wire header trigger buttons without touching app.js
  function bindHeaderTriggers() {
    document.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('#btn-cmdk') || e.target.closest('#btn-mobile-cmdk')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          open('command');
        }
      },
      true
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindHeaderTriggers, { once: true });
  } else {
    bindHeaderTriggers();
  }

  if (window.KizukiSlots && typeof window.KizukiSlots.register === 'function') {
    window.KizukiSlots.register('cmdk', () => {
      ensureDom();
    });
  }

  window.KizukiCommandPlane = {
    open,
    close,
    toggle,
    isOpen: () => ui.open,
    getMode: () => ui.mode,
    setMode,
  };
})();
