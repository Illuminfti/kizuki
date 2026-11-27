/* ==========================================================================
   KIZUKI MIND OS - TODAY ACTION PLANE & NEXT-MOVE RADAR (C2 + C1)
   Registers into window.KizukiSlots('today-radar') with fallback mounting
   directly beneath .kos-pulse-strip inside #view-today.
   Keyboard: 1-5 focus | A approve | R revise | D defer/draft | S snooze | X dismiss | U undo
   Zero em-dashes | Local draft only (never sends outbound messages)
   ========================================================================== */
(function initTodayRadar(root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const UNDO_WINDOW_MS = 30000;

  const KIND_META = Object.freeze({
    decision: { label: 'DECISION GATE', cls: 'is-decision' },
    reply_owed: { label: 'REPLY OWED', cls: 'is-reply' },
    meeting_prep: { label: 'MEETING PREP', cls: 'is-meeting' },
    drift_alert: { label: 'DRIFT ALERT', cls: 'is-drift' },
    pipeline_alert: { label: 'PIPELINE', cls: 'is-pipeline' },
    action_due: { label: 'ACTION DUE', cls: 'is-action' },
  });

  const state = {
    mountedRoot: null,
    data: null,
    moves: [],
    loading: false,
    error: '',
    focusedIndex: 0,
    reviseMoveId: null,
    reviseNote: '',
    busyMoveIds: new Set(),
    stampingMoves: new Map(), // moveId -> verdict
    rollbackMoveId: null,
    inlineErrors: new Map(),
    drafts: new Map(), // moveId -> { loading, engine, text, error }
    actionReceipts: new Map(), // moveId -> string
    undoBanner: null, // { type: 'decision'|'triage', move, verdict?, threadId?, idempotencyKey?, action?, expiresAt, timerId }
    sseRefreshTimer: null,
    undoTickTimer: null,
    lastFetchAt: 0,
  };

  function stripEmDash(value) {
    return String(value == null ? '' : value).replace(EM_DASH_RE, ' - ');
  }

  function escHtml(value) {
    return stripEmDash(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    return escHtml(value).replace(/`/g, '&#96;');
  }

  function prefersReducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function clickDetent(kind) {
    try {
      if (root && root.KizukiTactile && typeof root.KizukiTactile.clickDetent === 'function') {
        root.KizukiTactile.clickDetent(kind || 'stamp');
      }
    } catch {
      // Optional tactile feedback must never block interaction.
    }
  }

  function playSound(method) {
    const s = root && root.KizukiSound;
    if (!s || typeof s[method] !== 'function') return;
    try {
      s[method]();
    } catch {
      // Optional sound feedback must never block interaction.
    }
  }

  function makeIdempotencyKey(prefix, id) {
    const clean = String(id || 'item').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}:${clean}:${Date.now()}:${rand}`;
  }

  function isTodayViewActive() {
    const viewEl = document.getElementById('view-today');
    if (!viewEl) return false;
    return viewEl.classList.contains('is-active') && !viewEl.hidden;
  }

  function isAnyModalOpen() {
    const ids = ['cmdk-modal', 'chat-modal', 'kbw-dispatch-modal-backdrop', 'replay-import-modal'];
    for (let i = 0; i < ids.length; i += 1) {
      const el = document.getElementById(ids[i]);
      if (el && !el.hidden && (el.classList.contains('is-open') || el.offsetParent !== null)) {
        return true;
      }
    }
    const cmdPlane = document.querySelector('[data-kizuki-command-plane][data-open="true"]');
    return Boolean(cmdPlane);
  }

  function isEditableEl(el) {
    if (!el || typeof el !== 'object') return false;
    const tag = String(el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable);
  }

  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  async function fetchNextMoves(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (state.loading && !o.force) return;
    state.loading = true;
    if (!state.data) render();

    try {
      const res = await apiJson('/api/today/next-moves?limit=5', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        state.error = stripEmDash(res.data?.error || `Failed to load Next Moves (${res.status})`);
      } else {
        state.data = res.data;
        state.moves = Array.isArray(res.data?.moves) ? res.data.moves.slice(0, 5) : [];
        state.error = '';
        state.lastFetchAt = Date.now();
        if (state.focusedIndex >= state.moves.length) {
          state.focusedIndex = Math.max(0, state.moves.length - 1);
        }
      }
    } catch (err) {
      state.error = stripEmDash((err && err.message) || 'Network error loading Next Moves');
    } finally {
      state.loading = false;
      render();
    }
  }

  function clearUndoBanner() {
    if (state.undoBanner && state.undoBanner.timerId) {
      clearTimeout(state.undoBanner.timerId);
    }
    if (state.undoTickTimer) {
      clearInterval(state.undoTickTimer);
      state.undoTickTimer = null;
    }
    state.undoBanner = null;
  }

  function setUndoBanner(banner) {
    clearUndoBanner();
    const expiresAt = banner.expiresAt || Date.now() + UNDO_WINDOW_MS;
    const msLeft = Math.max(1000, expiresAt - Date.now());
    const timerId = setTimeout(() => {
      clearUndoBanner();
      render();
    }, msLeft);
    state.undoBanner = Object.assign({}, banner, { expiresAt, timerId });
    state.undoTickTimer = setInterval(() => {
      if (!state.undoBanner || Date.now() >= state.undoBanner.expiresAt) {
        clearUndoBanner();
      }
      updateUndoCountdownDom();
    }, 1000);
  }

  function updateUndoCountdownDom() {
    const rootEl = state.mountedRoot;
    if (!rootEl) return;
    const span = rootEl.querySelector('[data-tr-ref="undo-secs"]');
    if (!span || !state.undoBanner) return;
    const secs = Math.max(0, Math.ceil((state.undoBanner.expiresAt - Date.now()) / 1000));
    span.textContent = `${secs}s`;
  }

  function triggerRollbackFlash(moveId) {
    state.rollbackMoveId = moveId;
    render();
    setTimeout(() => {
      if (state.rollbackMoveId === moveId) {
        state.rollbackMoveId = null;
        render();
      }
    }, 550);
  }

  function removeMoveOptimistic(moveId) {
    const idx = state.moves.findIndex((m) => m.id === moveId);
    if (idx === -1) return { move: null, idx: -1 };
    const [removed] = state.moves.splice(idx, 1);
    if (state.focusedIndex >= state.moves.length) {
      state.focusedIndex = Math.max(0, state.moves.length - 1);
    }
    return { move: removed, idx };
  }

  function restoreMoveAt(move, idx) {
    if (!move) return;
    if (state.moves.some((m) => m.id === move.id)) return;
    const safeIdx = Math.max(0, Math.min(state.moves.length, idx));
    state.moves.splice(safeIdx, 0, move);
    state.focusedIndex = safeIdx;
  }

  async function executeDecisionStamp(move, verdict, customNote) {
    if (!move || !move.target || !move.target.threadId) return;
    if (state.stampingMoves.has(move.id)) return;
    const threadId = String(move.target.threadId);
    const idempotencyKey = makeIdempotencyKey(`today-${verdict}`, threadId);

    state.inlineErrors.delete(move.id);
    state.reviseMoveId = null;
    state.reviseNote = '';

    clickDetent('stamp');
    playSound('advance');

    // Start durable write-back immediately while showing the engraved die-stamp seal
    const stampPromise = apiJson('/api/decisions/stamp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId,
        verdict,
        ...(customNote ? { note: stripEmDash(customNote) } : {}),
        idempotencyKey,
      }),
    });

    const sealDelayMs = prefersReducedMotion() ? 0 : 250;
    let removed = null;
    let removedIdx = -1;
    let didRemove = false;

    const commitOptimisticRemoval = () => {
      if (didRemove) return;
      didRemove = true;
      state.stampingMoves.delete(move.id);
      const resRem = removeMoveOptimistic(move.id);
      removed = resRem.move || move;
      removedIdx = resRem.idx >= 0 ? resRem.idx : 0;
      setUndoBanner({
        type: 'decision',
        move: removed,
        idx: removedIdx,
        threadId,
        verdict,
        idempotencyKey,
        label: `Stamped ${verdict.toUpperCase()} on #${threadId}`,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      });
      render();
    };

    if (sealDelayMs > 0) {
      state.stampingMoves.set(move.id, verdict);
      render();
      await new Promise((resolve) => setTimeout(resolve, sealDelayMs));
    }

    commitOptimisticRemoval();

    const res = await stampPromise;

    if (!res.ok || !res.data || res.data.ok === false) {
      // Rollback on non-200
      state.stampingMoves.delete(move.id);
      clearUndoBanner();
      restoreMoveAt(removed || move, removedIdx >= 0 ? removedIdx : 0);
      const errText =
        res.status === 422
          ? `Secret guard (422): ${stripEmDash(res.data?.message || res.data?.error || 'Blocked secret in note')}`
          : stripEmDash(res.data?.error || res.data?.message || `Stamp failed (${res.status})`);
      state.inlineErrors.set(move.id, errText);
      triggerRollbackFlash(move.id);
      return;
    }

    const expiresMs = res.data.undoExpiresAt ? Date.parse(res.data.undoExpiresAt) : NaN;
    if (state.undoBanner && state.undoBanner.threadId === threadId && Number.isFinite(expiresMs)) {
      setUndoBanner(Object.assign({}, state.undoBanner, { expiresAt: expiresMs }));
    }

    try {
      window.dispatchEvent(
        new CustomEvent('kizuki:decision-stamped', {
          detail: {
            threadId,
            verdict,
            replyId: res.data.replyId,
            stampedAt: res.data.stampedAt,
            deduplicated: Boolean(res.data.deduplicated),
          },
        }),
      );
    } catch {
      // ignore
    }
    render();
  }

  async function executeTriage(move, action, hours) {
    if (!move) return;
    state.inlineErrors.delete(move.id);
    const { move: removed, idx } = removeMoveOptimistic(move.id);
    playSound('click');

    const label =
      action === 'snooze'
        ? `Snoozed "${stripEmDash(move.title).slice(0, 44)}" for ${hours || 4}h`
        : `Dismissed "${stripEmDash(move.title).slice(0, 44)}"`;

    setUndoBanner({
      type: 'triage',
      move: removed || move,
      idx,
      action,
      label,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    });
    render();

    const res = await apiJson('/api/today/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: move.id,
        action,
        ...(action === 'snooze' ? { hours: hours || 4 } : {}),
      }),
    });

    if (!res.ok) {
      clearUndoBanner();
      restoreMoveAt(removed || move, idx);
      state.inlineErrors.set(
        move.id,
        stripEmDash(res.data?.error || `Triage failed (${res.status})`),
      );
      triggerRollbackFlash(move.id);
      return;
    }
    render();
  }

  async function executeUndo() {
    const banner = state.undoBanner;
    if (!banner) return;
    clearUndoBanner();
    playSound('click');

    if (banner.type === 'decision') {
      const res = await apiJson('/api/decisions/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: banner.threadId,
          idempotencyKey: makeIdempotencyKey('undo', banner.threadId),
        }),
      });
      if (!res.ok) {
        state.error = stripEmDash(res.data?.error || `Undo failed (${res.status})`);
        render();
        return;
      }
      restoreMoveAt(banner.move, banner.idx);
      try {
        window.dispatchEvent(
          new CustomEvent('kizuki:decision-stamped', {
            detail: { threadId: banner.threadId, retracted: true },
          }),
        );
      } catch {
        // ignore
      }
      render();
      fetchNextMoves({ force: true });
      return;
    }

    if (banner.type === 'triage') {
      const res = await apiJson('/api/today/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: banner.move.id, action: 'restore' }),
      });
      if (!res.ok) {
        state.error = stripEmDash(res.data?.error || `Restore failed (${res.status})`);
        render();
        return;
      }
      restoreMoveAt(banner.move, banner.idx);
      render();
      fetchNextMoves({ force: true });
    }
  }

  async function executeLocalDraft(move, mode) {
    if (!move) return;
    playSound('click');
    const draftKind = mode === 'prep' ? 'meeting_prep' : 'reply';
    state.drafts.set(move.id, { loading: true, engine: '', text: '', error: '' });
    render();

    const evidenceSummary = Array.isArray(move.evidence)
      ? move.evidence.map((e) => e.label).join(' | ')
      : '';
    const contextText = stripEmDash(
      `${move.title}\nWhy now: ${move.why_now}${evidenceSummary ? `\nEvidence: ${evidenceSummary}` : ''}`,
    );

    const res = await apiJson('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: draftKind,
        title: stripEmDash(move.title),
        context_text: contextText,
        thread_key: move.target?.threadId || move.id,
        instructions:
          draftKind === 'meeting_prep'
            ? 'Write a crisp 4-bullet meeting prep brief with objective, key context, and 2 opening questions. Zero em-dashes.'
            : 'Write a concise, direct reply draft in the owner voice. Local draft only. Zero em-dashes.',
      }),
    });

    if (!res.ok || !res.data) {
      state.drafts.set(move.id, {
        loading: false,
        engine: '',
        text: '',
        error: stripEmDash(res.data?.error || `Draft generation failed (${res.status})`),
      });
    } else {
      state.drafts.set(move.id, {
        loading: false,
        engine: stripEmDash(res.data.engine || 'Local'),
        text: stripEmDash(res.data.draft || ''),
        error: '',
      });
    }
    render();
  }

  async function executeMakeAction(move) {
    if (!move) return;
    playSound('click');
    state.busyMoveIds.add(move.id);
    render();

    const tag =
      move.kind === 'reply_owed' || move.kind === 'drift_alert' ? 'Reply' : 'Work';

    const res = await apiJson('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'add',
        title: stripEmDash(move.title),
        detail: stripEmDash(move.why_now),
        tag,
        source: `today-radar:${move.kind}`,
      }),
    });

    state.busyMoveIds.delete(move.id);
    if (!res.ok) {
      state.inlineErrors.set(
        move.id,
        stripEmDash(res.data?.error || `Could not create action (${res.status})`),
      );
    } else {
      state.actionReceipts.set(move.id, 'Added to Today Actions');
    }
    render();
  }

  function openReviseInput(move) {
    if (!move) return;
    playSound('click');
    state.reviseMoveId = state.reviseMoveId === move.id ? null : move.id;
    state.reviseNote = '';
    render();
    if (state.reviseMoveId && state.mountedRoot) {
      const inp = state.mountedRoot.querySelector('[data-tr-ref="revise-input"]');
      if (inp && typeof inp.focus === 'function') inp.focus();
    }
  }

  function renderVerbButtons(move) {
    const verbs = Array.isArray(move.verbs) ? move.verbs : [];
    const btns = [];

    for (let i = 0; i < verbs.length; i += 1) {
      const v = verbs[i];
      if (v === 'approve') {
        btns.push(
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-approve" data-tr-action="approve" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">Approve</span><kbd class="tr-kbd">A</kbd>` +
          `</button>`,
        );
      } else if (v === 'revise') {
        btns.push(
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-revise" data-tr-action="revise" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">Revise</span><kbd class="tr-kbd">R</kbd>` +
          `</button>`,
        );
      } else if (v === 'defer') {
        btns.push(
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-defer" data-tr-action="defer" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">Defer</span><kbd class="tr-kbd">D</kbd>` +
          `</button>`,
        );
      } else if (v === 'draft_reply') {
        btns.push(
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-primary" data-tr-action="draft_reply" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">Draft Reply (Local)</span><kbd class="tr-kbd">D</kbd>` +
          `</button>`,
        );
      } else if (v === 'prep') {
        btns.push(
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-primary" data-tr-action="prep" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">Prep Brief</span>` +
          `</button>`,
        );
      } else if (v === 'make_action') {
        btns.push(
          `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="make_action" data-move-id="${escAttr(move.id)}">` +
            `<span class="tr-btn-label">+ Action</span>` +
          `</button>`,
        );
      } else if (v === 'snooze') {
        btns.push(
          `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="snooze" data-move-id="${escAttr(move.id)}" title="Snooze 4 hours">` +
            `<span class="tr-btn-label">Snooze</span><kbd class="tr-kbd">S</kbd>` +
          `</button>`,
        );
      } else if (v === 'dismiss') {
        btns.push(
          `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="dismiss" data-move-id="${escAttr(move.id)}" title="Dismiss from Today">` +
            `<span class="tr-btn-label">Dismiss</span><kbd class="tr-kbd">X</kbd>` +
          `</button>`,
        );
      }
    }
    return btns.join('');
  }

  function renderCard(move, index) {
    const meta = KIND_META[move.kind] || { label: String(move.kind || 'MOVE').toUpperCase(), cls: '' };
    const isFocused = index === state.focusedIndex;
    const isRollback = state.rollbackMoveId === move.id;
    const stampedVerdict = state.stampingMoves.get(move.id) || '';
    const errText = state.inlineErrors.get(move.id) || '';
    const receiptText = state.actionReceipts.get(move.id) || '';
    const draft = state.drafts.get(move.id) || null;
    const revising = state.reviseMoveId === move.id;

    const evidenceHtml = Array.isArray(move.evidence) && move.evidence.length > 0
      ? `<div class="tr-evidence">${move.evidence
          .slice(0, 4)
          .map((ev) => `<span class="tr-chip" data-ev-kind="${escAttr(ev.kind)}">${escHtml(ev.label)}</span>`)
          .join('')}</div>`
      : '';

    const recHtml = move.recommendation
      ? `<div class="tr-rec"><span class="tr-rec-label">REC</span><span class="tr-rec-body">${escHtml(move.recommendation)}</span></div>`
      : '';

    const stampLabelMap = { approve: 'APPROVED', revise: 'REVISED', defer: 'DEFERRED' };
    const stampSealHtml = stampedVerdict
      ? `<div class="tr-stamp-seal is-${escAttr(stampedVerdict)}" role="status" aria-live="polite">` +
          `<span class="tr-stamp-seal-text">${escHtml(stampLabelMap[stampedVerdict] || stampedVerdict.toUpperCase())}</span>` +
        `</div>`
      : '';

    const reviseHtml = revising
      ? `<form class="tr-revise-form" data-tr-form="revise" data-move-id="${escAttr(move.id)}">` +
          `<input type="text" class="tr-revise-input" data-tr-ref="revise-input" placeholder="Revision note (Enter to stamp, Esc to cancel)..." value="${escAttr(state.reviseNote)}" />` +
          `<button type="submit" class="tr-btn tr-detent-btn tr-btn-revise"><span class="tr-btn-label">Stamp Revise</span></button>` +
          `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="revise-cancel"><span class="tr-btn-label">Cancel</span></button>` +
        `</form>`
      : '';

    const errHtml = errText
      ? `<div class="tr-inline-error" role="alert">${escHtml(errText)}</div>`
      : '';

    const receiptHtml = receiptText
      ? `<div class="tr-inline-receipt" role="status">${escHtml(receiptText)}</div>`
      : '';

    let draftHtml = '';
    if (draft) {
      if (draft.loading) {
        draftHtml = `<div class="tr-draft-box is-loading">Synthesizing local draft...</div>`;
      } else if (draft.error) {
        draftHtml = `<div class="tr-inline-error" role="alert">${escHtml(draft.error)}</div>`;
      } else if (draft.text) {
        draftHtml =
          `<div class="tr-draft-box">` +
            `<div class="tr-draft-head">` +
              `<span class="tr-draft-badge">LOCAL DRAFT ONLY - NEVER SENT (${escHtml(draft.engine)})</span>` +
              `<div class="tr-draft-tools">` +
                `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="copy-draft" data-move-id="${escAttr(move.id)}">Copy</button>` +
                `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="close-draft" data-move-id="${escAttr(move.id)}">Close</button>` +
              `</div>` +
            `</div>` +
            `<pre class="tr-draft-text">${escHtml(draft.text)}</pre>` +
          `</div>`;
      }
    }

    return (
      `<article class="tr-card ${meta.cls}${isFocused ? ' is-focused' : ''}${isRollback ? ' is-rollback' : ''}${stampedVerdict ? ' is-stamping' : ''}" ` +
        `data-tr-card="1" data-move-index="${index + 1}" data-move-id="${escAttr(move.id)}" data-move-kind="${escAttr(move.kind)}"${stampedVerdict ? ` data-stamped-verdict="${escAttr(stampedVerdict)}"` : ''} tabindex="0">` +
        `${stampSealHtml}` +
        `<div class="tr-card-top">` +
          `<div class="tr-card-title-row">` +
            `<kbd class="tr-rank-kbd">${index + 1}</kbd>` +
            `<span class="tr-kind-tag ${meta.cls}">${escHtml(meta.label)}</span>` +
            `<h3 class="tr-card-title">${escHtml(move.title)}</h3>` +
          `</div>` +
          `<span class="tr-score tabular" title="Deterministic urgency score">${Math.round(Number(move.score) || 0)}</span>` +
        `</div>` +
        `<p class="tr-why">${escHtml(move.why_now)}</p>` +
        `${recHtml}` +
        `${evidenceHtml}` +
        `<div class="tr-verbs">${renderVerbButtons(move)}</div>` +
        `${reviseHtml}` +
        `${errHtml}` +
        `${receiptHtml}` +
        `${draftHtml}` +
      `</article>`
    );
  }

  function render() {
    const container = state.mountedRoot;
    if (!container || !container.isConnected) return;

    const counts = state.data?.counts || {
      decisions: 0,
      replies_owed: 0,
      meetings_soon: 0,
      drifting: 0,
      pipelines_degraded: 0,
      actions_due: 0,
    };

    const pills = [];
    if (counts.decisions > 0) pills.push(`<span class="tr-stat-pill is-decision tabular">${counts.decisions} decision${counts.decisions === 1 ? '' : 's'}</span>`);
    if (counts.replies_owed > 0) pills.push(`<span class="tr-stat-pill is-reply tabular">${counts.replies_owed} repl${counts.replies_owed === 1 ? 'y' : 'ies'}</span>`);
    if (counts.meetings_soon > 0) pills.push(`<span class="tr-stat-pill is-meeting tabular">${counts.meetings_soon} in 90m</span>`);
    if (counts.drifting > 0) pills.push(`<span class="tr-stat-pill is-drift tabular">${counts.drifting} drift</span>`);
    if (counts.pipelines_degraded > 0) pills.push(`<span class="tr-stat-pill is-pipeline tabular">${counts.pipelines_degraded} pipe</span>`);

    let undoHtml = '';
    if (state.undoBanner) {
      const secs = Math.max(0, Math.ceil((state.undoBanner.expiresAt - Date.now()) / 1000));
      undoHtml =
        `<div class="tr-undo-toast" role="status" aria-live="polite">` +
          `<span class="tr-undo-copy">${escHtml(state.undoBanner.label)}</span>` +
          `<button type="button" class="tr-btn tr-detent-btn tr-btn-undo" data-tr-action="undo">` +
            `<span class="tr-btn-label">Undo</span><kbd class="tr-kbd">U</kbd><span class="tabular" data-tr-ref="undo-secs">${secs}s</span>` +
          `</button>` +
        `</div>`;
    }

    let bodyHtml = '';
    if (state.loading && !state.data) {
      bodyHtml = `<div class="tr-empty">Scoring next moves from board gates, 1:1 replies, and schedule...</div>`;
    } else if (state.error && state.moves.length === 0) {
      bodyHtml = `<div class="tr-inline-error" role="alert">${escHtml(state.error)}</div>`;
    } else if (state.moves.length === 0) {
      bodyHtml = `<div class="tr-empty">No urgent moves pending. Decision gates, human replies, and 90m preps are clear.</div>`;
    } else {
      bodyHtml = `<div class="tr-list">${state.moves.map((m, i) => renderCard(m, i)).join('')}</div>`;
    }

    container.innerHTML =
      `<section class="tr-radar-shell" aria-label="Today Next-Move Radar">` +
        `<header class="tr-header">` +
          `<div class="tr-header-left">` +
            `<span class="tr-eyebrow">NEXT MOVES</span>` +
            `<div class="tr-stat-pills">${pills.join('')}</div>` +
          `</div>` +
          `<div class="tr-header-right">` +
            `<span class="tr-kbd-legend" aria-hidden="true">` +
              `<kbd class="tr-kbd">1-5</kbd> focus ` +
              `<kbd class="tr-kbd">A</kbd> approve ` +
              `<kbd class="tr-kbd">R</kbd> revise ` +
              `<kbd class="tr-kbd">D</kbd> defer/draft ` +
              `<kbd class="tr-kbd">S</kbd> snooze ` +
              `<kbd class="tr-kbd">X</kbd> dismiss ` +
              `<kbd class="tr-kbd">U</kbd> undo` +
            `</span>` +
            `<button type="button" class="tr-btn tr-btn-ghost" data-tr-action="refresh" title="Refresh Next Moves">Refresh</button>` +
          `</div>` +
        `</header>` +
        `${undoHtml}` +
        `${state.error && state.moves.length > 0 ? `<div class="tr-inline-error" role="alert">${escHtml(state.error)}</div>` : ''}` +
        `${bodyHtml}` +
      `</section>`;
  }

  function handleContainerClick(event) {
    const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!target) return;

    const actionEl = target.closest('[data-tr-action]');
    if (actionEl) {
      const action = actionEl.getAttribute('data-tr-action');
      const moveId = actionEl.getAttribute('data-move-id') || '';
      const move = state.moves.find((m) => m.id === moveId) || state.moves[state.focusedIndex] || null;

      if (action === 'refresh') {
        fetchNextMoves({ force: true });
        return;
      }
      if (action === 'undo') {
        executeUndo();
        return;
      }
      if (action === 'revise-cancel') {
        state.reviseMoveId = null;
        state.reviseNote = '';
        render();
        return;
      }
      if (action === 'close-draft') {
        state.drafts.delete(moveId);
        render();
        return;
      }
      if (action === 'copy-draft') {
        const d = state.drafts.get(moveId);
        if (d && d.text && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(d.text).catch(() => {});
          actionEl.textContent = 'Copied';
          setTimeout(() => {
            if (actionEl.isConnected) actionEl.textContent = 'Copy';
          }, 1400);
        }
        return;
      }
      if (!move) return;

      if (action === 'approve') {
        executeDecisionStamp(move, 'approve');
      } else if (action === 'revise') {
        openReviseInput(move);
      } else if (action === 'defer') {
        executeDecisionStamp(move, 'defer');
      } else if (action === 'draft_reply') {
        executeLocalDraft(move, 'reply');
      } else if (action === 'prep') {
        executeLocalDraft(move, 'prep');
      } else if (action === 'make_action') {
        executeMakeAction(move);
      } else if (action === 'snooze') {
        executeTriage(move, 'snooze', 4);
      } else if (action === 'dismiss') {
        executeTriage(move, 'dismiss');
      }
      return;
    }

    const cardEl = target.closest('[data-tr-card]');
    if (cardEl) {
      const idx = Number(cardEl.getAttribute('data-move-index')) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < state.moves.length) {
        state.focusedIndex = idx;
        render();
      }
    }
  }

  function handleContainerSubmit(event) {
    const form = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-tr-form="revise"]')
      : null;
    if (!form) return;
    event.preventDefault();
    const moveId = form.getAttribute('data-move-id') || '';
    const move = state.moves.find((m) => m.id === moveId);
    const input = form.querySelector('[data-tr-ref="revise-input"]');
    const note = input ? input.value.trim() : '';
    if (move) {
      executeDecisionStamp(move, 'revise', note || 'Needs revision before proceeding.');
    }
  }

  function handleContainerInput(event) {
    if (event.target && event.target.getAttribute && event.target.getAttribute('data-tr-ref') === 'revise-input') {
      state.reviseNote = event.target.value || '';
    }
  }

  function onGlobalKeyDown(event) {
    if (!isTodayViewActive()) return;
    if (!state.mountedRoot || !state.mountedRoot.isConnected) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isAnyModalOpen()) return;

    const target = event.target;
    if (target && target.getAttribute && target.getAttribute('data-tr-ref') === 'revise-input') {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.reviseMoveId = null;
        state.reviseNote = '';
        render();
      }
      return;
    }
    if (isEditableEl(target) || isEditableEl(document.activeElement)) return;

    const key = String(event.key || '').toLowerCase();

    if (key === 'u' && state.undoBanner) {
      event.preventDefault();
      event.stopImmediatePropagation();
      executeUndo();
      return;
    }

    if (state.moves.length === 0) return;

    if (key >= '1' && key <= '5') {
      const idx = Number(key) - 1;
      if (idx < state.moves.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.focusedIndex = idx;
        playSound('click');
        render();
        const card = state.mountedRoot.querySelector(`[data-move-index="${idx + 1}"]`);
        if (card && typeof card.scrollIntoView === 'function') {
          card.scrollIntoView({ block: 'nearest' });
        }
      }
      return;
    }

    const move = state.moves[state.focusedIndex];
    if (!move) return;
    const verbs = new Set(Array.isArray(move.verbs) ? move.verbs : []);

    if (key === 'a' && verbs.has('approve')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      executeDecisionStamp(move, 'approve');
      return;
    }
    if (key === 'r' && verbs.has('revise')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openReviseInput(move);
      return;
    }
    if (key === 'd') {
      if (verbs.has('defer')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        executeDecisionStamp(move, 'defer');
        return;
      }
      if (verbs.has('draft_reply')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        executeLocalDraft(move, 'reply');
        return;
      }
      if (verbs.has('prep')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        executeLocalDraft(move, 'prep');
        return;
      }
    }
    if (key === 's' && verbs.has('snooze')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      executeTriage(move, 'snooze', 4);
      return;
    }
    if (key === 'x' && verbs.has('dismiss')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      executeTriage(move, 'dismiss');
    }
  }

  function bindRootListeners(el) {
    if (el.__todayRadarBound) return;
    el.__todayRadarBound = true;
    el.addEventListener('click', handleContainerClick);
    el.addEventListener('submit', handleContainerSubmit);
    el.addEventListener('input', handleContainerInput);
  }

  function mountInto(targetEl) {
    if (!targetEl) return;
    state.mountedRoot = targetEl;
    bindRootListeners(targetEl);
    render();
    if (!state.data || Date.now() - state.lastFetchAt > 4000) {
      fetchNextMoves({ force: true });
    }
  }

  function ensureFallbackMount() {
    const viewToday = document.getElementById('view-today');
    if (!viewToday) return;
    const detailBody = viewToday.querySelector('#detail-body');
    if (!detailBody) return;

    // 1. Prefer explicit host slot [data-slot="today-radar"] if present
    const explicitSlot = viewToday.querySelector('[data-slot="today-radar"]');
    if (explicitSlot) {
      if (state.mountedRoot !== explicitSlot) {
        mountInto(explicitSlot);
      }
      return;
    }

    // Only mount fallback when Morning Brief is rendered (indicated by .kos-pulse-strip or #today-system-pulse-slot)
    const pulseStrip = detailBody.querySelector('.kos-pulse-strip');
    const pulseSlot = detailBody.querySelector('#today-system-pulse-slot');
    const anchor = pulseSlot || pulseStrip;
    if (!anchor || !anchor.parentNode) return;

    let fallbackHost = detailBody.querySelector('[data-today-radar-fallback="1"]');
    if (!fallbackHost) {
      fallbackHost = document.createElement('div');
      fallbackHost.className = 'today-radar-host';
      fallbackHost.setAttribute('data-today-radar-fallback', '1');
      if (anchor.nextSibling) {
        anchor.parentNode.insertBefore(fallbackHost, anchor.nextSibling);
      } else {
        anchor.parentNode.appendChild(fallbackHost);
      }
    }
    if (state.mountedRoot !== fallbackHost || !fallbackHost.innerHTML) {
      mountInto(fallbackHost);
    }
  }

  function scheduleSseRefresh() {
    if (state.sseRefreshTimer) return;
    state.sseRefreshTimer = setTimeout(() => {
      state.sseRefreshTimer = null;
      if (state.mountedRoot && state.mountedRoot.isConnected) {
        fetchNextMoves({ force: true });
      }
    }, 750);
  }

  function registerWithSlotSystem() {
    if (root.KizukiSlots && typeof root.KizukiSlots.register === 'function') {
      root.KizukiSlots.register('today-radar', function onSlotMount(slotEl) {
        mountInto(slotEl);
      });
    }
  }

  function bootstrap() {
    registerWithSlotSystem();
    ensureFallbackMount();

    const detailBody = document.getElementById('detail-body');
    if (detailBody && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => {
        ensureFallbackMount();
      });
      obs.observe(detailBody, { childList: true, subtree: true });
    }

    document.addEventListener('keydown', onGlobalKeyDown, true);
    window.addEventListener('kizuki:board-sse', scheduleSseRefresh);
    window.addEventListener('kizuki:decision-stamped', scheduleSseRefresh);
  }

  if (root.KizukiSlots && typeof root.KizukiSlots.register === 'function') {
    registerWithSlotSystem();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
      bootstrap();
    }
  }

  root.KizukiTodayRadar = {
    mount: mountInto,
    refresh: () => fetchNextMoves({ force: true }),
    getState: () => ({
      moves: state.moves.slice(),
      focusedIndex: state.focusedIndex,
      undoActive: Boolean(state.undoBanner),
    }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
