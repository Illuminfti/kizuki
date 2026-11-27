/* Kizuki Instant Streaming Ask (Alt+A) & 1-Second Quick Capture (Alt+N)
 * Zero edits to app.js. Streams grounded evidence in <25ms + live tokens via SSE.
 */
(function initKizukiInstantAsk() {
  'use strict';

  const KIND_META = [
    { id: 'action', label: 'Action', key: '1', placeholder: 'Next concrete action to ship...' },
    { id: 'note', label: 'Note', key: '2', placeholder: 'Local vault note title...' },
    { id: 'codex', label: 'Codex', key: '3', placeholder: 'Idea or principle for Mind Codex...' },
    { id: 'memt', label: 'MemT', key: '4', placeholder: 'Procedural lesson or rule...' },
  ];

  const state = {
    askOpen: false,
    captureOpen: false,
    streaming: false,
    abortCtrl: null,
    history: [],
    citations: [],
    suggestedActions: [],
    lastQuery: '',
    answerText: '',
    captureKind: 'action',
    recentCaptures: [],
    els: {},
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

  function getActiveView() {
    const shell = document.getElementById('app-shell');
    return (shell && shell.getAttribute('data-active-view')) || 'today';
  }

  function renderMarkdownWithCitations(text) {
    const clean = stripEmDash(text || '');
    let html;
    if (window.KizukiMarkdown && typeof window.KizukiMarkdown.render === 'function') {
      try {
        html = window.KizukiMarkdown.render(clean);
      } catch (_) {
        html = escHtml(clean).replace(/\n/g, '<br>');
      }
    } else {
      html = escHtml(clean).replace(/\n/g, '<br>');
    }
    return html.replace(/\[(\d{1,2})\]/g, function (match, num) {
      const idx = Number(num);
      if (idx >= 1 && idx <= state.citations.length) {
        return '<button type="button" class="iask-cit-pill" data-cit-jump="' + idx + '" title="Jump to evidence [' + idx + ']">[' + idx + ']</button>';
      }
      return match;
    });
  }

  function navigateToCitation(cit) {
    if (!cit) return;
    closeAll();
    const ref = cit.targetRef || {};
    const view = cit.targetView || ref.view || '';

    if (ref.personKey) {
      const url = new URL(window.location.href);
      url.search = '?person=' + encodeURIComponent(ref.personKey);
      window.location.href = url.toString();
      return;
    }
    if (ref.docPath) {
      const url = new URL(window.location.href);
      url.search = '?doc=' + encodeURIComponent(ref.docPath);
      window.location.href = url.toString();
      return;
    }
    if (ref.threadId) {
      const params = new URLSearchParams();
      params.set('view', 'board');
      if (ref.channel) params.set('channel', String(ref.channel));
      params.set('thread', String(ref.threadId));
      params.set('stage', 'thread');
      window.location.href = '/?' + params.toString();
      return;
    }
    if (ref.itemId) {
      const params = new URLSearchParams();
      params.set('view', 'codex');
      if (ref.section) params.set('section', String(ref.section));
      params.set('itemId', String(ref.itemId));
      window.location.href = '/?' + params.toString();
      return;
    }
    if (ref.nodeId) {
      window.location.href = '/?node=' + encodeURIComponent(String(ref.nodeId));
      return;
    }
    if (ref.domain && view === 'taste') {
      const params = new URLSearchParams();
      params.set('view', 'taste');
      params.set('domain', String(ref.domain));
      window.location.href = '/?' + params.toString();
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

  function injectUtilityTriggers() {
    // 1. Desktop rail cluster directly under Search button (0px CLS, exact sidebar width)
    const railControls = document.querySelector('.os-rail-controls');
    if (railControls && !document.getElementById('iask-rail-cluster')) {
      const cluster = document.createElement('div');
      cluster.id = 'iask-rail-cluster';
      cluster.className = 'iask-rail-cluster';
      cluster.innerHTML = [
        '<button type="button" class="iask-pill-btn" id="btn-instant-ask" title="Instant Streaming Ask (Alt+A)" aria-label="Open Instant Streaming Ask">',
        '  <span class="iask-pill-label">Ask</span>',
        '  <kbd class="iask-kbd">Alt+A</kbd>',
        '</button>',
        '<button type="button" class="iask-pill-btn" id="btn-quick-capture" title="1-Second Quick Capture (Alt+N)" aria-label="Open Quick Capture">',
        '  <span class="iask-pill-label">Note</span>',
        '  <kbd class="iask-kbd">Alt+N</kbd>',
        '</button>',
      ].join('');
      railControls.appendChild(cluster);
      cluster.querySelector('#btn-instant-ask').addEventListener('click', function () {
        openAsk();
      });
      cluster.querySelector('#btn-quick-capture').addEventListener('click', function () {
        openCapture();
      });
    }

    // 2. Compact mobile utility trigger (single icon, never overflows 390px)
    const mobileRight = document.querySelector('.mobile-topbar-right');
    if (mobileRight && !document.getElementById('btn-mobile-capture')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btn-mobile-capture';
      btn.className = 'icon-toggle-btn';
      btn.setAttribute('aria-label', 'Quick Capture (Alt+N)');
      btn.setAttribute('title', 'Quick Capture (Alt+N)');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      const themeBtn = document.getElementById('btn-mobile-theme');
      if (themeBtn && themeBtn.parentNode === mobileRight) {
        mobileRight.insertBefore(btn, themeBtn);
      } else {
        mobileRight.appendChild(btn);
      }
      btn.addEventListener('click', function () {
        openCapture();
      });
    }
  }

  function ensureAskDom() {
    if (state.els.askBackdrop && state.els.askBackdrop.isConnected) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'kizuki-iask-backdrop';
    backdrop.className = 'iask-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = [
      '<aside class="iask-drawer" id="kizuki-iask-drawer" role="dialog" aria-modal="true" aria-label="Instant Grounded Ask">',
      '  <header class="iask-head">',
      '    <div class="iask-head-left">',
      '      <span class="iask-title">Instant Ask</span>',
      '      <span class="iask-telemetry" id="iask-telemetry">READY</span>',
      '    </div>',
      '    <div class="iask-head-right">',
      '      <button type="button" class="iask-icon-btn" id="iask-open-capture" title="Quick Capture (Alt+N)">+ Capture</button>',
      '      <button type="button" class="iask-icon-btn" id="iask-close" aria-label="Close Instant Ask (Esc)">Esc</button>',
      '    </div>',
      '  </header>',
      '  <div class="iask-body" id="iask-body">',
      '    <div class="iask-evidence-section" id="iask-evidence-section" hidden>',
      '      <div class="iask-section-label"><span>Grounded Evidence</span><span id="iask-evidence-count">0 sources</span></div>',
      '      <div class="iask-evidence-grid" id="iask-evidence-grid"></div>',
      '    </div>',
      '    <div class="iask-answer-card" id="iask-answer-card">Ask anything across People, Agent Board, Codex, Inbox, Vault Docs, and MemT. Grounded evidence loads in under 25ms.</div>',
      '    <div class="iask-actions-strip" id="iask-actions-strip" hidden></div>',
      '  </div>',
      '  <form class="iask-form" id="iask-form">',
      '    <div class="iask-input-row">',
      '      <textarea id="iask-input" class="iask-textarea" rows="1" placeholder="Ask your mind anything..." autocomplete="off"></textarea>',
      '      <button type="submit" class="iask-submit" id="iask-submit">Stream</button>',
      '    </div>',
      '    <div class="iask-footer-hints">',
      '      <span><kbd class="iask-kbd">Alt+A</kbd> Ask &nbsp; <kbd class="iask-kbd">Alt+N</kbd> Capture</span>',
      '      <span><kbd class="iask-kbd">Enter</kbd> Send &nbsp; <kbd class="iask-kbd">Esc</kbd> Close</span>',
      '    </div>',
      '  </form>',
      '</aside>',
    ].join('');

    document.body.appendChild(backdrop);

    state.els.askBackdrop = backdrop;
    state.els.telemetry = backdrop.querySelector('#iask-telemetry');
    state.els.evSection = backdrop.querySelector('#iask-evidence-section');
    state.els.evCount = backdrop.querySelector('#iask-evidence-count');
    state.els.evGrid = backdrop.querySelector('#iask-evidence-grid');
    state.els.answerCard = backdrop.querySelector('#iask-answer-card');
    state.els.actionsStrip = backdrop.querySelector('#iask-actions-strip');
    state.els.askForm = backdrop.querySelector('#iask-form');
    state.els.askInput = backdrop.querySelector('#iask-input');
    state.els.askSubmit = backdrop.querySelector('#iask-submit');

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop || e.target.closest('#iask-close')) {
        closeAsk();
        return;
      }
      if (e.target.closest('#iask-open-capture')) {
        openCapture({ title: state.lastQuery || '' });
        return;
      }
      const evCard = e.target.closest('[data-ev-index]');
      if (evCard) {
        const idx = Number(evCard.getAttribute('data-ev-index'));
        const cit = state.citations.find(function (c) { return c.index === idx; });
        if (cit) navigateToCitation(cit);
        return;
      }
      const citPill = e.target.closest('[data-cit-jump]');
      if (citPill) {
        const idx = Number(citPill.getAttribute('data-cit-jump'));
        const card = state.els.evGrid.querySelector('[data-ev-index="' + idx + '"]');
        if (card) {
          card.classList.add('is-highlighted');
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          setTimeout(function () { card.classList.remove('is-highlighted'); }, 1200);
        }
        return;
      }
      const actBtn = e.target.closest('[data-suggested-idx]');
      if (actBtn) {
        const idx = Number(actBtn.getAttribute('data-suggested-idx'));
        const act = state.suggestedActions[idx];
        if (act) runSuggestedAction(act, actBtn);
      }
    });

    state.els.askForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const q = (state.els.askInput.value || '').trim();
      if (!q) return;
      state.els.askInput.value = '';
      runAskStream(q);
    });

    state.els.askInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        state.els.askForm.requestSubmit();
      }
    });
  }

  function ensureCaptureDom() {
    if (state.els.capBackdrop && state.els.capBackdrop.isConnected) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'kizuki-icap-backdrop';
    backdrop.className = 'icap-backdrop';
    backdrop.hidden = true;
    const kindsHtml = KIND_META.map(function (k) {
      const active = k.id === state.captureKind ? ' is-active' : '';
      return '<button type="button" class="icap-kind-btn' + active + '" data-cap-kind="' + k.id + '"><span>' + k.label + '</span><kbd class="iask-kbd">' + k.key + '</kbd></button>';
    }).join('');

    backdrop.innerHTML = [
      '<div class="icap-modal" id="kizuki-icap-modal" role="dialog" aria-modal="true" aria-label="1-Second Quick Capture">',
      '  <header class="iask-head">',
      '    <div class="iask-head-left">',
      '      <span class="iask-title">Quick Capture</span>',
      '      <span class="iask-telemetry">LOCAL 0600</span>',
      '    </div>',
      '    <div class="iask-head-right">',
      '      <button type="button" class="iask-icon-btn" id="icap-close" aria-label="Close Quick Capture (Esc)">Esc</button>',
      '    </div>',
      '  </header>',
      '  <div class="icap-kinds" id="icap-kinds">' + kindsHtml + '</div>',
      '  <form class="icap-form" id="icap-form">',
      '    <input id="icap-title" class="icap-field" type="text" placeholder="Next concrete action to ship..." autocomplete="off" required>',
      '    <textarea id="icap-body" class="icap-field" rows="3" placeholder="Optional context, snippet, or verification detail..."></textarea>',
      '    <div class="icap-row-2">',
      '      <input id="icap-domain" class="icap-field" type="text" placeholder="Domain (work, design, infra...)" autocomplete="off">',
      '      <input id="icap-tags" class="icap-field" type="text" placeholder="Tags (comma separated)" autocomplete="off">',
      '    </div>',
      '    <div class="icap-status" id="icap-status" hidden></div>',
      '    <div class="iask-footer-hints">',
      '      <span>Keys <kbd class="iask-kbd">1</kbd>-<kbd class="iask-kbd">4</kbd> switch kind &nbsp; <kbd class="iask-kbd">Cmd+Enter</kbd> Save</span>',
      '      <button type="submit" class="iask-submit" id="icap-submit">Save Local</button>',
      '    </div>',
      '  </form>',
      '  <div class="icap-recent" id="icap-recent" hidden></div>',
      '</div>',
    ].join('');

    document.body.appendChild(backdrop);

    state.els.capBackdrop = backdrop;
    state.els.capKinds = backdrop.querySelector('#icap-kinds');
    state.els.capForm = backdrop.querySelector('#icap-form');
    state.els.capTitle = backdrop.querySelector('#icap-title');
    state.els.capBody = backdrop.querySelector('#icap-body');
    state.els.capDomain = backdrop.querySelector('#icap-domain');
    state.els.capTags = backdrop.querySelector('#icap-tags');
    state.els.capStatus = backdrop.querySelector('#icap-status');
    state.els.capRecent = backdrop.querySelector('#icap-recent');

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop || e.target.closest('#icap-close')) {
        closeCapture();
        return;
      }
      const kBtn = e.target.closest('[data-cap-kind]');
      if (kBtn) {
        setCaptureKind(kBtn.getAttribute('data-cap-kind') || 'action');
      }
    });

    state.els.capForm.addEventListener('submit', function (e) {
      e.preventDefault();
      submitQuickCapture();
    });

    backdrop.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitQuickCapture();
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && document.activeElement !== state.els.capTitle && document.activeElement !== state.els.capBody && document.activeElement !== state.els.capDomain && document.activeElement !== state.els.capTags) {
        const hit = KIND_META.find(function (k) { return k.key === e.key; });
        if (hit) {
          e.preventDefault();
          setCaptureKind(hit.id);
        }
      }
    });
  }

  function setCaptureKind(kind) {
    state.captureKind = kind;
    const meta = KIND_META.find(function (k) { return k.id === kind; }) || KIND_META[0];
    if (state.els.capTitle) state.els.capTitle.placeholder = meta.placeholder;
    if (state.els.capKinds) {
      state.els.capKinds.querySelectorAll('[data-cap-kind]').forEach(function (btn) {
        btn.classList.toggle('is-active', btn.getAttribute('data-cap-kind') === kind);
      });
    }
  }

  function renderEvidenceCards(citations) {
    state.citations = Array.isArray(citations) ? citations : [];
    if (!state.els.evGrid || !state.els.evSection) return;
    if (state.citations.length === 0) {
      state.els.evSection.hidden = true;
      state.els.evGrid.innerHTML = '';
      return;
    }
    state.els.evSection.hidden = false;
    state.els.evCount.textContent = state.citations.length + (state.citations.length === 1 ? ' source' : ' sources');
    state.els.evGrid.innerHTML = state.citations
      .map(function (c) {
        return [
          '<button type="button" class="iask-ev-card" data-ev-index="' + c.index + '" title="' + escHtml(c.meta || c.kind) + '">',
          '  <div class="iask-ev-top"><span class="iask-ev-num">[' + c.index + ']</span><span class="iask-ev-kind">' + escHtml(c.kind) + '</span></div>',
          '  <div class="iask-ev-title">' + escHtml(c.title) + '</div>',
          '  <div class="iask-ev-snippet">' + escHtml(c.snippet || c.meta || '') + '</div>',
          '</button>',
        ].join('');
      })
      .join('');
  }

  function renderSuggestedActions(actions) {
    state.suggestedActions = Array.isArray(actions) ? actions : [];
    if (!state.els.actionsStrip) return;
    if (state.suggestedActions.length === 0) {
      state.els.actionsStrip.hidden = true;
      state.els.actionsStrip.innerHTML = '';
      return;
    }
    state.els.actionsStrip.hidden = false;
    state.els.actionsStrip.innerHTML = state.suggestedActions
      .map(function (a, i) {
        return '<button type="button" class="iask-act-btn" data-suggested-idx="' + i + '">' + escHtml(a.label) + '</button>';
      })
      .join('');
  }

  async function runSuggestedAction(act, btnEl) {
    if (act.kind === 'open') {
      navigateToCitation({ targetView: act.targetView, targetRef: act.targetRef || {} });
      return;
    }
    btnEl.disabled = true;
    try {
      const resp = await fetch('/api/capture/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        body: JSON.stringify({
          kind: act.kind,
          title: act.title,
          body: act.body || state.answerText.slice(0, 800),
          domain: act.domain || 'general',
          personKey: act.personKey || '',
        }),
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        btnEl.classList.add('is-saved');
        btnEl.textContent = 'Saved';
      } else {
        btnEl.textContent = data.error ? String(data.error).slice(0, 28) : 'Failed';
        btnEl.disabled = false;
      }
    } catch (_) {
      btnEl.textContent = 'Retry';
      btnEl.disabled = false;
    }
  }

  async function runAskStream(query, opts) {
    ensureAskDom();
    if (state.abortCtrl) {
      try { state.abortCtrl.abort(); } catch (_) { /* ignore */ }
    }
    const ctrl = new AbortController();
    state.abortCtrl = ctrl;
    state.streaming = true;
    state.lastQuery = query;
    state.answerText = '';
    renderEvidenceCards([]);
    renderSuggestedActions([]);
    state.els.telemetry.textContent = 'GATHERING...';
    state.els.answerCard.innerHTML = '<span style="color:var(--ink-muted)">Gathering grounded evidence...</span>';

    try {
      const resp = await fetch('/api/interact/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        signal: ctrl.signal,
        body: JSON.stringify({
          input: query,
          history: state.history.slice(-6),
          contextView: getActiveView(),
          fastOnly: Boolean(opts && opts.fastOnly),
        }),
      });

      if (!resp.ok || !resp.body) {
        state.els.telemetry.textContent = 'ERROR';
        state.els.answerCard.textContent = 'Could not start streaming ask (HTTP ' + resp.status + ').';
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let currentEvent = 'message';

      const dispatchEvent = function (evName, dataStr) {
        if (!dataStr) return;
        let payload;
        try {
          payload = JSON.parse(dataStr);
        } catch (_) {
          return;
        }
        if (evName === 'evidence') {
          renderEvidenceCards(payload.citations || []);
          const ms = typeof payload.first_evidence_ms === 'number' ? Math.round(payload.first_evidence_ms) : 0;
          state.els.telemetry.textContent = ms + 'ms EVIDENCE';
          if (!state.answerText) {
            state.els.answerCard.innerHTML = '<span style="color:var(--ink-muted)">Synthesizing from ' + (payload.citations ? payload.citations.length : 0) + ' grounded sources...</span>';
          }
        } else if (evName === 'delta') {
          state.answerText += stripEmDash(payload.text || '');
          state.els.answerCard.innerHTML = renderMarkdownWithCitations(state.answerText);
        } else if (evName === 'done') {
          if (Array.isArray(payload.citations) && payload.citations.length > 0 && state.citations.length === 0) {
            renderEvidenceCards(payload.citations);
          }
          renderSuggestedActions(payload.suggested_actions || []);
          const totalMs = typeof payload.elapsed_ms === 'number' ? Math.round(payload.elapsed_ms) : 0;
          const evMs = typeof payload.first_evidence_ms === 'number' ? Math.round(payload.first_evidence_ms) : 0;
          state.els.telemetry.textContent = evMs + 'ms EV | ' + totalMs + 'ms TOTAL';
          if (state.answerText.trim()) {
            state.history.push({ role: 'user', content: query });
            state.history.push({ role: 'assistant', content: state.answerText.slice(0, 800) });
            if (state.history.length > 12) state.history = state.history.slice(-12);
          }
        }
      };

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');

          if (line === '') {
            currentEvent = 'message';
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dispatchEvent(currentEvent, line.slice(5).trim());
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      state.els.telemetry.textContent = 'OFFLINE';
      state.els.answerCard.textContent = 'Streaming request interrupted.';
    } finally {
      state.streaming = false;
    }
  }

  async function refreshRecentCaptures() {
    if (!state.els.capRecent) return;
    try {
      const resp = await fetch('/api/capture/recent?limit=6');
      if (!resp.ok) return;
      const data = await resp.json();
      const items = Array.isArray(data.items) ? data.items : [];
      state.recentCaptures = items;
      if (items.length === 0) {
        state.els.capRecent.hidden = true;
        return;
      }
      state.els.capRecent.hidden = false;
      state.els.capRecent.innerHTML =
        '<div class="iask-section-label"><span>Recent Captures</span><span>' + items.length + '</span></div>' +
        items
          .map(function (it) {
            return '<div class="icap-recent-row"><span class="icap-recent-title">' + escHtml(it.label || it.title) + '</span><span>' + escHtml(it.kind) + '</span></div>';
          })
          .join('');
    } catch (_) {
      // fail-soft
    }
  }

  async function submitQuickCapture() {
    const title = (state.els.capTitle.value || '').trim();
    if (!title) return;
    const body = (state.els.capBody.value || '').trim();
    const domain = (state.els.capDomain.value || '').trim();
    const tagsRaw = (state.els.capTags.value || '').trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];

    state.els.capStatus.hidden = false;
    state.els.capStatus.className = 'icap-status';
    state.els.capStatus.textContent = 'Saving locally...';

    try {
      const resp = await fetch('/api/capture/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kizuki-Request': '1' },
        body: JSON.stringify({
          kind: state.captureKind,
          title: title,
          body: body,
          domain: domain || 'general',
          tags: tags,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        state.els.capStatus.className = 'icap-status is-err';
        state.els.capStatus.textContent = stripEmDash(data.error || 'Could not save capture');
        return;
      }
      state.els.capStatus.className = 'icap-status is-ok';
      state.els.capStatus.textContent = 'Saved ' + stripEmDash(data.label || data.id);
      state.els.capTitle.value = '';
      state.els.capBody.value = '';
      state.els.capTags.value = '';
      refreshRecentCaptures();
    } catch (_) {
      state.els.capStatus.className = 'icap-status is-err';
      state.els.capStatus.textContent = 'Network error saving local capture.';
    }
  }

  function openAsk(initialQuery) {
    closeCapture();
    ensureAskDom();
    state.askOpen = true;
    state.els.askBackdrop.hidden = false;
    if (initialQuery && typeof initialQuery === 'string' && initialQuery.trim()) {
      runAskStream(initialQuery.trim());
    } else if (state.els.askInput) {
      setTimeout(function () { state.els.askInput.focus(); }, 20);
    }
  }

  function closeAsk() {
    state.askOpen = false;
    if (state.abortCtrl) {
      try { state.abortCtrl.abort(); } catch (_) { /* ignore */ }
    }
    if (state.els.askBackdrop) state.els.askBackdrop.hidden = true;
  }

  function openCapture(preset) {
    closeAsk();
    ensureCaptureDom();
    state.captureOpen = true;
    state.els.capBackdrop.hidden = false;
    if (state.els.capStatus) state.els.capStatus.hidden = true;
    if (preset && preset.kind) setCaptureKind(preset.kind);
    if (preset && preset.title && state.els.capTitle) state.els.capTitle.value = stripEmDash(preset.title);
    if (preset && preset.body && state.els.capBody) state.els.capBody.value = stripEmDash(preset.body);
    refreshRecentCaptures();
    setTimeout(function () {
      if (state.els.capTitle) state.els.capTitle.focus();
    }, 20);
  }

  function closeCapture() {
    state.captureOpen = false;
    if (state.els.capBackdrop) state.els.capBackdrop.hidden = true;
  }

  function closeAll() {
    closeAsk();
    closeCapture();
  }

  function hookLegacyAskForm() {
    // Seamlessly upgrade Ask-mode submissions inside #chat-form without touching app.js
    document.addEventListener(
      'submit',
      function (e) {
        const form = e.target;
        if (!form || form.id !== 'chat-form') return;
        const activeModeBtn = form.querySelector('.mode-btn.is-active');
        const mode = activeModeBtn ? activeModeBtn.getAttribute('data-mode') : 'ask';
        if (mode !== 'ask') return;
        const inputEl = document.getElementById('chat-input');
        const query = inputEl ? String(inputEl.value || '').trim() : '';
        if (!query) return;

        e.preventDefault();
        e.stopImmediatePropagation();
        inputEl.value = '';
        const legacyBackdrop = document.getElementById('chat-modal-backdrop');
        if (legacyBackdrop) legacyBackdrop.hidden = true;
        openAsk(query);
      },
      true,
    );
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (state.captureOpen) {
          e.preventDefault();
          closeCapture();
        } else if (state.askOpen) {
          e.preventDefault();
          closeAsk();
        }
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const lower = String(e.key || '').toLowerCase();
        if (lower === 'a' || e.code === 'KeyA') {
          e.preventDefault();
          if (state.askOpen) closeAsk();
          else openAsk();
        } else if (lower === 'n' || e.code === 'KeyN') {
          e.preventDefault();
          if (state.captureOpen) closeCapture();
          else openCapture();
        }
      }
    });
  }

  function boot() {
    injectUtilityTriggers();
    hookLegacyAskForm();
    bindGlobalKeys();
  }

  window.KizukiInstantAsk = {
    openAsk: openAsk,
    closeAsk: closeAsk,
    openCapture: openCapture,
    closeCapture: closeCapture,
    closeAll: closeAll,
    askStream: runAskStream,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
