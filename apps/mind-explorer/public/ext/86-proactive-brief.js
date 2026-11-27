/* Kizuki Mind OS - Proactive Briefing, Meeting Preps & Commitment Radar (H4)
   De-boxified machined rail inside #view-today. Local drafts only, zero em-dashes. */
(function initProactiveBrief(root) {
  'use strict';
  const EM_RE = /\s*\u2014\s*/g;
  const KEY = 'kizuki.proactiveBrief.collapsed';
  const REFRESH_MS = 35000;

  const S = {
    host: null,
    data: null,
    loading: false,
    error: '',
    tab: null,
    picked: false,
    collapsed: readBool(),
    openMtg: null,
    md: new Map(),
    drafts: new Map(),
    checking: new Set(),
    undo: null,
    lastAt: 0,
    obs: null,
    sseTimer: null,
  };

  function readBool() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1'; } catch { return false; }
  }
  function saveBool(v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, v ? '1' : '0'); } catch {}
  }
  function clean(v) { return String(v == null ? '' : v).replace(EM_RE, ' - '); }
  function esc(v) {
    return clean(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function detent(k) {
    try { root?.KizukiTactile?.clickDetent?.(k || 'tick'); } catch {}
  }
  function reduced() {
    try { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }
  async function api(url, opts) {
    const r = await fetch(url, opts);
    let d = {};
    try { d = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data: d };
  }
  function pickTab(d) {
    const c = d?.counts || {};
    if ((c.meetings_24h || 0) > 0) return 'meetings';
    if ((c.commitments || 0) > 0) return 'commitments';
    if ((c.meeting_preps || 0) > 0) return 'meetings';
    if ((c.cross_signals || 0) > 0) return 'signals';
    return 'meetings';
  }

  async function fetchBriefing(force) {
    if (S.loading && !force) return;
    S.loading = true;
    if (!S.data) render();
    try {
      const r = await api(force ? '/api/intel/briefing?refresh=1' : '/api/intel/briefing', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) {
        S.error = clean(r.data?.error || `Briefing unavailable (${r.status})`);
      } else {
        S.data = r.data;
        S.error = '';
        S.lastAt = Date.now();
        if (!S.picked || !S.tab) S.tab = pickTab(r.data);
      }
    } catch (e) {
      S.error = clean(e?.message || 'Network error loading briefing');
    } finally {
      S.loading = false;
      render();
    }
  }

  async function loadPrepMd(id) {
    const hit = S.md.get(id);
    if (hit) return hit;
    const r = await api(`/api/intel/meeting-prep?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = r.ok && r.data?.markdown ? clean(r.data.markdown) : '';
    if (text) S.md.set(id, text);
    return text;
  }

  async function copyText(text, btn, label) {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText?.(text);
      if (btn?.isConnected) {
        btn.textContent = 'Copied';
        setTimeout(() => { if (btn.isConnected) btn.textContent = label; }, 1400);
      }
    } catch {}
  }

  function setUndo(id, label) {
    if (S.undo?.timer) clearTimeout(S.undo.timer);
    S.undo = { id, label, timer: setTimeout(() => { S.undo = null; render(); }, 15000) };
  }

  async function mutate(id, op, hours) {
    if (!id) return;
    detent(op === 'resolve' ? 'stamp' : 'tick');
    const post = (body) => api('/api/intel/commitment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (op === 'draft') {
      S.drafts.set(id, { loading: true, text: '', error: '' });
      render();
      const r = await post({ id, op: 'draft' });
      S.drafts.set(id, r.ok && r.data?.draft
        ? { loading: false, text: clean(r.data.draft), error: '' }
        : { loading: false, text: '', error: clean(r.data?.error || 'Draft failed') });
      render();
      return;
    }

    if (op === 'reopen') {
      if (S.undo?.timer) clearTimeout(S.undo.timer);
      S.undo = null;
      await post({ id, op: 'reopen' });
      fetchBriefing(true);
      return;
    }

    S.checking.add(id);
    render();
    const p = post({ id, op, ...(hours ? { hours } : {}) });
    if (!reduced()) await new Promise((r) => setTimeout(r, 150));

    const list = Array.isArray(S.data?.commitments) ? S.data.commitments : [];
    const idx = list.findIndex((c) => c.id === id);
    const removed = idx >= 0 ? list.splice(idx, 1)[0] : null;
    S.checking.delete(id);
    S.drafts.delete(id);
    if (S.data?.counts) S.data.counts.commitments = list.length;
    setUndo(id, op === 'resolve' ? 'Commitment marked done' : `Snoozed for ${hours || 24}h`);
    render();

    const r = await p;
    if (!r.ok) {
      if (removed && Array.isArray(S.data?.commitments)) {
        S.data.commitments.splice(Math.max(0, idx), 0, removed);
        if (S.data.counts) S.data.counts.commitments = S.data.commitments.length;
      }
      S.undo = null;
      S.error = clean(r.data?.error || `Action failed (${r.status})`);
      render();
    }
  }

  function renderSheet(m) {
    const atts = (m.attendees || []).length
      ? m.attendees.map((a) => {
          const meta = [a.tier, a.role, a.org].filter(Boolean).join(' · ');
          const touches = (a.last_touches || []).map((t) =>
            `<li class="pb-touch"><span class="pb-mono pb-touch-ch">${esc(t.channel)} · ${esc(t.age_label)}</span>` +
            `<span class="pb-touch-dir">${t.direction === 'out' ? 'You' : esc(a.name)}:</span> ${esc(t.excerpt)}</li>`
          ).join('');
          return `<div class="pb-att-row"><div class="pb-att-head"><span class="pb-att-name">${esc(a.name)}</span>` +
            `${meta ? `<span class="pb-att-meta">${esc(meta)}</span>` : ''}</div>` +
            `${touches ? `<ul class="pb-touch-list">${touches}</ul>` : '<div class="pb-muted-line">No recent touchpoints indexed.</div>'}</div>`;
        }).join('')
      : '<div class="pb-muted-line">Solo or unlisted attendee event.</div>';

    const loops = (m.open_loops || []).length
      ? `<div class="pb-sheet-sec"><div class="pb-sec-label">OPEN LOOPS</div><ul class="pb-bullet-list">` +
        m.open_loops.map((l) =>
          `<li><span class="pb-tag ${l.kind === 'owner_promise' ? 'is-promise' : 'is-ask'}">${l.kind === 'owner_promise' ? 'PROMISE' : 'ASK'}</span> ` +
          `<strong>${esc(l.person)}</strong> (${esc(l.channel)}, ${esc(l.age_label)}): ${esc(l.excerpt)}</li>`
        ).join('') + '</ul></div>'
      : '';

    const pts = (m.talking_points || []).length
      ? `<div class="pb-sheet-sec"><div class="pb-sec-label">TALKING POINTS</div><ul class="pb-bullet-list">` +
        m.talking_points.map((tp) => `<li>${esc(tp)}</li>`).join('') + '</ul></div>'
      : '';

    return `<div class="pb-prep-sheet" data-pb-sheet="${esc(m.id)}">` +
      `<div class="pb-sheet-bar"><span class="pb-mono">${esc(m.calendar)} · ${esc(m.countdown)}</span>` +
      `<div class="pb-sheet-tools">${m.meet_url ? `<a class="pb-btn pb-btn-ghost" href="${esc(m.meet_url)}" target="_blank" rel="noopener noreferrer">Join</a>` : ''}` +
      `<button type="button" class="pb-btn pb-btn-primary" data-pb-action="copy-brief" data-id="${esc(m.id)}">Copy Brief</button></div></div>` +
      `<div class="pb-sheet-sec"><div class="pb-sec-label">ATTENDEE DOSSIERS &amp; LAST TOUCHES</div>${atts}</div>${loops}${pts}</div>`;
  }

  function renderMeetings(list) {
    if (!list?.length) return '<div class="pb-empty">No upcoming meetings in the next 72 hours.</div>';
    return '<div class="pb-list">' + list.map((m) => {
      const open = S.openMtg === m.id;
      const names = (m.attendees || []).slice(0, 3).map((a) => a.name).join(', ');
      const loops = (m.open_loops || []).length ? `<span class="pb-meta-item is-warn">${m.open_loops.length} open loop${m.open_loops.length === 1 ? '' : 's'}</span>` : '';
      const cls = m.is_now ? 'is-live' : m.hours_until <= 3 ? 'is-urgent' : 'is-meeting';
      return `<article class="pb-row${open ? ' is-open' : ''}">` +
        `<button type="button" class="pb-row-trigger" data-pb-action="toggle-meeting" data-id="${esc(m.id)}" aria-expanded="${open}">` +
        `<div class="pb-row-main"><span class="pb-tag ${cls} tabular">${esc(m.countdown)}</span><span class="pb-row-title">${esc(m.title)}</span></div>` +
        `<div class="pb-row-meta">${names ? `<span class="pb-meta-item">${esc(names)}</span>` : ''}${loops}<span class="pb-chevron">${open ? 'Hide' : 'Prep'}</span></div>` +
        `</button>${open ? renderSheet(m) : ''}</article>`;
    }).join('') + '</div>';
  }

  function renderCommitments(list) {
    if (!list?.length) return '<div class="pb-empty">No open commitments pending. Promises, asks, and actions are clear.</div>';
    return '<div class="pb-list">' + list.map((c) => {
      const tag = c.kind === 'owner_promise' ? ['PROMISE', 'is-promise'] : c.kind === 'inbound_ask' ? ['ASK', 'is-ask'] : ['ACTION', 'is-action'];
      const d = S.drafts.get(c.id);
      let draftHtml = '';
      if (d) {
        if (d.loading) draftHtml = '<div class="pb-draft-tray">Building local draft...</div>';
        else if (d.error) draftHtml = `<div class="pb-error">${esc(d.error)}</div>`;
        else if (d.text) {
          draftHtml = `<div class="pb-draft-tray"><div class="pb-draft-head"><span class="pb-draft-badge">LOCAL DRAFT ONLY - NEVER SENT</span>` +
            `<div class="pb-draft-tools"><button type="button" class="pb-btn pb-btn-primary" data-pb-action="copy-draft" data-id="${esc(c.id)}">Copy</button>` +
            `<button type="button" class="pb-btn pb-btn-ghost" data-pb-action="close-draft" data-id="${esc(c.id)}">Close</button></div></div>` +
            `<pre class="pb-draft-text">${esc(d.text)}</pre></div>`;
        }
      }
      return `<article class="pb-row pb-commit-row${S.checking.has(c.id) ? ' is-checking' : ''}" data-pb-commit="${esc(c.id)}">` +
        `<div class="pb-commit-top"><div class="pb-commit-info"><div class="pb-row-main">` +
        `<span class="pb-tag ${tag[1]}">${tag[0]}</span><span class="pb-row-title">${esc(c.person_name)}</span>` +
        `<span class="pb-meta-item">${esc(c.tier)}</span><span class="pb-meta-item">${esc(c.channel)} · ${esc(c.age_label)}</span></div>` +
        `<p class="pb-excerpt">${esc(c.excerpt)}</p></div><div class="pb-actions">` +
        `<button type="button" class="pb-btn pb-btn-primary" data-pb-action="draft" data-id="${esc(c.id)}">Draft</button>` +
        `<button type="button" class="pb-btn pb-btn-done" data-pb-action="resolve" data-id="${esc(c.id)}">Done</button>` +
        `<button type="button" class="pb-btn pb-btn-ghost" data-pb-action="snooze" data-id="${esc(c.id)}" title="Snooze 24h">24h</button>` +
        `</div></div>${draftHtml}</article>`;
    }).join('') + '</div>';
  }

  function renderSignals(list) {
    if (!list?.length) return '<div class="pb-empty">No cross-channel convergence, board links, or cadence anomalies detected.</div>';
    return '<div class="pb-list">' + list.map((s) => {
      const tag = s.kind === 'convergence' ? ['CONVERGENCE', 'is-conv'] : s.kind === 'board_link' ? ['BOARD LINK', 'is-board'] : ['VELOCITY', 'is-vel'];
      const ev = (s.evidence || []).slice(0, 4).map((e) => `<span class="pb-meta-item">${esc(e)}</span>`).join('');
      return `<article class="pb-row pb-sig-row"><div class="pb-row-main"><span class="pb-tag ${tag[1]}">${tag[0]}</span>` +
        `<span class="pb-row-title">${esc(s.title)}</span></div><p class="pb-excerpt">${esc(s.detail)}</p>` +
        `${ev ? `<div class="pb-row-meta">${ev}</div>` : ''}</article>`;
    }).join('') + '</div>';
  }

  function render() {
    if (!S.host || !S.host.isConnected) return;
    const d = S.data;
    const c = d?.counts || { meeting_preps: 0, commitments: 0, cross_signals: 0 };
    const tab = S.tab || pickTab(d);
    const tabs = [
      ['meetings', 'Meeting Preps', c.meeting_preps || 0],
      ['commitments', 'Commitments', c.commitments || 0],
      ['signals', 'Signals', c.cross_signals || 0],
    ].map(([id, label, n]) =>
      `<button type="button" role="tab" aria-selected="${tab === id}" class="pb-tab${tab === id ? ' is-active' : ''}" data-pb-action="tab" data-tab="${id}">` +
      `<span>${label}</span><span class="pb-tab-n tabular">${n}</span></button>`
    ).join('');

    const undo = S.undo
      ? `<div class="pb-undo" role="status"><span>${esc(S.undo.label)}</span>` +
        `<button type="button" class="pb-btn pb-btn-done" data-pb-action="undo" data-id="${esc(S.undo.id)}">Undo</button></div>`
      : '';

    let body = '';
    if (!S.collapsed) {
      if (S.loading && !d) body = '<div class="pb-empty">Synthesizing meeting preps, commitments, and signals...</div>';
      else if (S.error && !d) body = `<div class="pb-error" role="alert">${esc(S.error)}</div>`;
      else if (tab === 'meetings') body = renderMeetings(d?.meeting_preps);
      else if (tab === 'commitments') body = renderCommitments(d?.commitments);
      else body = renderSignals(d?.cross_signals);
    }

    const ms = d && Number.isFinite(d.elapsed_ms)
      ? `<span class="pb-ms tabular" title="Cached briefing latency">${d.elapsed_ms < 1 ? '<1' : Math.round(d.elapsed_ms)}ms</span>`
      : '';

    S.host.innerHTML = `<section class="pb-shell${S.collapsed ? ' is-collapsed' : ''}" aria-label="Proactive Intelligence Strip">` +
      `<header class="pb-head"><div class="pb-head-left"><span class="pb-eyebrow">PROACTIVE BRIEF</span>` +
      `<div class="pb-tabs" role="tablist" aria-label="Proactive Intelligence Views">${tabs}</div></div>` +
      `<div class="pb-head-right">${ms}<button type="button" class="pb-btn pb-btn-ghost" data-pb-action="refresh">Refresh</button>` +
      `<button type="button" class="pb-btn pb-btn-ghost" data-pb-action="collapse" aria-expanded="${!S.collapsed}">${S.collapsed ? 'Expand' : 'Hide'}</button></div></header>` +
      `${undo}${S.error && d ? `<div class="pb-error" role="alert">${esc(S.error)}</div>` : ''}${body}</section>`;
  }

  function onClick(ev) {
    const el = ev.target?.closest?.('[data-pb-action]');
    if (!el) return;
    const act = el.getAttribute('data-pb-action');
    const id = el.getAttribute('data-id') || '';

    if (act === 'tab') {
      detent('tick');
      S.tab = el.getAttribute('data-tab') || 'meetings';
      S.picked = true;
      if (S.collapsed) { S.collapsed = false; saveBool(false); }
      render();
    } else if (act === 'collapse') {
      detent('tick');
      S.collapsed = !S.collapsed;
      saveBool(S.collapsed);
      render();
    } else if (act === 'refresh') {
      detent('tick');
      fetchBriefing(true);
    } else if (act === 'toggle-meeting') {
      detent('tick');
      S.openMtg = S.openMtg === id ? null : id;
      render();
      if (S.openMtg) void loadPrepMd(id);
    } else if (act === 'copy-brief') {
      detent('stamp');
      void loadPrepMd(id).then((md) => copyText(md, el, 'Copy Brief'));
    } else if (act === 'draft') {
      void mutate(id, 'draft');
    } else if (act === 'resolve') {
      void mutate(id, 'resolve');
    } else if (act === 'snooze') {
      void mutate(id, 'snooze', 24);
    } else if (act === 'undo') {
      void mutate(id, 'reopen');
    } else if (act === 'copy-draft') {
      const d = S.drafts.get(id);
      if (d?.text) void copyText(d.text, el, 'Copy');
    } else if (act === 'close-draft') {
      S.drafts.delete(id);
      render();
    }
  }

  function ensureMounted() {
    const detail = document.getElementById('view-today')?.querySelector('#detail-body');
    if (!detail) return;
    const anchor =
      detail.querySelector('[data-slot="today-radar"]') ||
      detail.querySelector('[data-today-radar-fallback="1"]') ||
      detail.querySelector('.brief-hero');
    if (!anchor?.parentNode) return;

    let host = detail.querySelector('[data-proactive-brief-host="1"]');
    if (!host) {
      host = document.createElement('div');
      host.className = 'pb-host';
      host.setAttribute('data-proactive-brief-host', '1');
      if (anchor.nextSibling) anchor.parentNode.insertBefore(host, anchor.nextSibling);
      else anchor.parentNode.appendChild(host);
    }
    const changed = S.host !== host;
    S.host = host;
    if (!host.__pbBound) { host.__pbBound = true; host.addEventListener('click', onClick); }
    if (changed || !host.firstElementChild) render();
    if (!S.data || Date.now() - S.lastAt > REFRESH_MS) void fetchBriefing(false);
  }

  function scheduleRefresh() {
    if (S.sseTimer) return;
    S.sseTimer = setTimeout(() => {
      S.sseTimer = null;
      if (S.host?.isConnected) void fetchBriefing(true);
    }, 900);
  }

  function boot() {
    ensureMounted();
    const detail = document.getElementById('detail-body');
    if (detail && typeof MutationObserver !== 'undefined') {
      S.obs = new MutationObserver(ensureMounted);
      S.obs.observe(detail, { childList: true, subtree: true });
    }
    window.addEventListener('kizuki:board-sse', scheduleRefresh);
    window.addEventListener('kizuki:decision-stamped', scheduleRefresh);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  root.KizukiProactiveBrief = {
    mount: ensureMounted,
    refresh: () => fetchBriefing(true),
    getState: () => ({ activeTab: S.tab, collapsed: S.collapsed, counts: S.data?.counts || null }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
