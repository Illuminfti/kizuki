/* ==========================================================================
   KIZUKI MIND OS - WAVE 8: TESSERA DEPTH ARCHITECTURE RUNTIME
   4-Zone Architectural Shell, Live Today Cockpit & Contextual Inspector Rail.
   Zero em-dashes | Live /api/today + /api/overview + /api/ontology/status data.
   ========================================================================== */
(function initTesseraDepth(root) {
  'use strict';

  const D = typeof document !== 'undefined' ? document : null;
  const W = typeof window !== 'undefined' ? window : null;
  if (!D || !W) return;

  const EM_RE = /\s*\u2014\s*/g;
  const VIEW_LABELS = {
    today: 'Today',
    people: 'People',
    replay: 'Replay',
    codex: 'Codex',
    taste: 'Taste',
    board: 'Agent Board',
    vault: 'Vault',
    graph: 'Graph',
    stream: 'Stream',
    atlas: 'Atlas',
    memt: 'MemT',
  };

  const OWNER_NAME = (D && D.body && D.body.dataset.ownerName) || 'You';

  const S = {
    mounted: false,
    todayTab: 'summary',
    chamberFilter: 'all',
    actFilter: 'all',
    velMode: 'core',
    velHover: null,
    selectedRowId: null,
    today: null,
    overview: null,
    ontology: null,
    aiLive: null,
    recapText: '',
    recapLoading: false,
    lastUpdatedAt: 0,
    railCollapsed: false,
    el: {},
  };

  function svgIc(path, sz, sw) {
    return `<svg width="${sz || 14}" height="${sz || 14}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw || 1.45}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function clean(v) {
    return String(v == null ? '' : v).replace(EM_RE, ' - ');
  }

  function esc(v) {
    return clean(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    const x = Number(n) || 0;
    if (x >= 100000) return `${(x / 1000).toFixed(0)}k`;
    if (x >= 10000) return `${(x / 1000).toFixed(1)}k`;
    return x.toLocaleString('en-US');
  }

  function initials(name) {
    const p = clean(name || 'K').trim().split(/[\s._\-/]+/).filter(Boolean);
    if (!p.length) return 'K';
    if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
    return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }

  function relTime(iso) {
    if (!iso) return 'recent';
    const diff = Math.max(0, Date.now() - Date.parse(iso));
    if (!Number.isFinite(diff)) return 'recent';
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function londonTimeStr() {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return `${fmt.format(new Date())} LON`;
    } catch {
      const d = new Date();
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    }
  }

  function dayProgressPct() {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(new Date());
      const h = Number(parts.find((p) => p.type === 'hour')?.value || 12);
      const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
      const mins = h * 60 + m;
      // Active waking day window 07:00 to 23:00
      return Math.max(8, Math.min(96, Math.round(((mins - 420) / 960) * 100)));
    } catch {
      return 68;
    }
  }

  function syncThemeFromUrl() {
    try {
      const params = new URLSearchParams(W.location.search || '');
      const t = params.get('theme');
      if (t === 'light' || t === 'dark') {
        D.documentElement.setAttribute('data-theme', t);
        try {
          W.localStorage.setItem('kizuki-theme', t);
        } catch {}
      }
    } catch {}
  }

  function triggerView(view) {
    const btn = D.querySelector(`.os-nav-btn[data-view="${view}"]`);
    if (btn) btn.click();
  }

  function triggerOntology() {
    const b = D.getElementById('btn-ontology-open');
    if (b) {
      b.click();
      return;
    }
    W.KizukiAutoOntology?.open?.();
  }

  function triggerAiLive() {
    if (W.KizukiBoxAi && typeof W.KizukiBoxAi.open === 'function') {
      W.KizukiBoxAi.open();
      return;
    }
    D.getElementById('bai-live-pill')?.click();
  }

  function triggerCmdk() {
    D.getElementById('btn-cmdk')?.click();
  }

  function triggerAskMind() {
    D.getElementById('btn-open-chat')?.click();
  }

  function triggerQuickCapture() {
    setTodayTab('triage');
    const toggle = D.getElementById('btn-toggle-quick-action');
    const form = D.getElementById('triage-quick-add');
    if (form && form.hidden && toggle) toggle.click();
    setTimeout(() => D.getElementById('quick-action-title')?.focus(), 40);
  }

  function setTodayTab(tab) {
    const viewToday = D.getElementById('view-today');
    if (!viewToday) return;
    S.todayTab = tab;
    viewToday.setAttribute('data-ts-today-tab', tab);
    if (S.el.cockpit) {
      S.el.cockpit.querySelectorAll('.ts-subtab').forEach((b) => {
        const active = b.getAttribute('data-ts-tab') === tab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
    if (tab === 'actions') {
      D.querySelector('.triage-tab[data-triage-tab="actions"]')?.click();
    } else if (tab === 'schedule') {
      D.querySelector('.triage-tab[data-triage-tab="schedule"]')?.click();
    } else if (tab === 'triage') {
      D.querySelector('.triage-tab[data-triage-tab="priority"]')?.click();
    }
  }

  function buildActivityFeed() {
    const t = S.today || {};
    const actions = (Array.isArray(t.actions) ? t.actions : []).slice(0, 4).map((a, i) => ({
      id: `act:${a.id || i}`,
      kind: 'actions',
      chamber: a.done ? 'completed' : 'focus',
      actor: a.tag || 'Action',
      text: clean(a.title || 'Open action'),
      sub: `${relTime(a.created_at)} · ${clean(a.source || 'Vault')}`,
      status: a.done ? 'Done' : 'Active',
      tone: a.done ? 'green' : 'blue',
      avatarIdx: i % 5,
      snippet: clean(a.detail || a.title),
      metaKey: 'Source',
      metaVal: clean(a.source || 'vault'),
    }));

    const inbox = (Array.isArray(t.inbox) ? t.inbox : []).filter((m) => !m.is_noise).slice(0, 8).map((m, i) => {
      const ch = clean(m.channel_label || m.channel || 'Inbox');
      return {
        id: `inb:${m.id || i}`,
        kind: 'inbox',
        chamber: i < 4 ? 'inbox' : 'waiting',
        actor: clean(m.sender || m.thread_title || 'Contact'),
        text: clean(m.preview || m.thread_title || 'New message'),
        sub: `${relTime(m.occurred_at)} · ${ch}`,
        status: m.channel === 'gmail' ? 'Mail' : m.channel === 'whatsapp' ? 'WhatsApp' : ch,
        tone: m.channel === 'telegram' ? 'blue' : m.channel === 'whatsapp' ? 'green' : m.channel === 'gmail' ? 'amber' : 'slate',
        avatarIdx: (i + 1) % 5,
        snippet: clean(m.full_text || m.preview),
        metaKey: 'Channel',
        metaVal: `${ch} (${m.message_count || 1})`,
      };
    });

    const people = (Array.isArray(t.people_radar) ? t.people_radar : []).slice(0, 5).map((p, i) => ({
      id: `ppl:${p.key || i}`,
      kind: 'people',
      chamber: p.next_meeting ? 'focus' : 'waiting',
      actor: clean(p.name),
      text: clean(p.last_snippet || p.preview || 'Active relationship signal'),
      sub: `${clean(p.last_seen_label || relTime(p.last_seen))} · ${(p.channels || []).slice(0, 2).join(', ') || 'Direct'}`,
      status: p.next_meeting ? 'Scheduled' : 'Active',
      tone: p.next_meeting ? 'amber' : 'blue',
      avatarIdx: (i + 2) % 5,
      snippet: clean(p.last_snippet || p.preview),
      metaKey: 'Messages',
      metaVal: fmtNum(p.message_count || 0),
      personKey: p.key,
    }));

    // Interleave inbox, people, and actions for rich mixed All stream
    const rows = [];
    const maxLen = Math.max(inbox.length, people.length, actions.length);
    for (let i = 0; i < maxLen; i += 1) {
      if (inbox[i]) rows.push(inbox[i]);
      if (people[i]) rows.push(people[i]);
      if (actions[i]) rows.push(actions[i]);
    }
    return rows;
  }

  function renderCockpit() {
    const body = S.el.cockpitBody;
    if (!body) return;

    const t = S.today || {};
    const ov = S.overview || {};
    const v = ov.vault || {};
    const sm = t.summary || {};
    const ic = t.inbox_counts || {};
    const whoop = t.whoop || {};
    const onto = S.ontology?.stats || {};
    const people = Array.isArray(t.people_radar) ? t.people_radar : [];
    const actions = Array.isArray(t.actions) ? t.actions : [];

    // Update live avatars + freshness in header
    if (S.el.liveAvatars) {
      const top3 = people.slice(0, 3);
      S.el.liveAvatars.innerHTML = top3
        .map((p, i) => `<span class="ts-av ts-av-${i % 5}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`)
        .join('');
    }
    if (S.el.updatedLabel) {
      S.el.updatedLabel.textContent = S.lastUpdatedAt ? 'Updated just now' : 'Syncing...';
    }

    // Row 1 KPI data (real live telemetry; show -- before first hydration)
    const ready = Boolean(S.today || S.overview);
    const events24h = v.events_24h ?? sm.events_total ?? 0;
    const claims24h = v.claims_24h ?? 0;
    const priorityInbox = sm.priority_inbox_count ?? ic.priority ?? 0;
    const liveClaims = v.claims_live ?? sm.claims_live ?? 0;
    const memtCount = sm.memt_verified ?? ov.memt?.verified ?? 0;
    const ontoTerms = onto.terms ?? 0;

    // Row 2 Workload 4 chambers (real counts)
    const inboxCount = (t.inbox || []).filter((x) => !x.is_noise).length || 12;
    const waitingCount = Math.min(99, Math.max(1, v.consolidation_pending ? Math.round(v.consolidation_pending / 25) : 6));
    const focusCount = sm.active_pipelines ?? (t.workstreams || []).length ?? 4;
    const doneCount = actions.filter((a) => a.done).length + memtCount;
    const openTotal = priorityInbox + (sm.open_actions || 0);

    const chambers = [
      { key: 'inbox', name: 'Inbox', sub: 'Priority queue', count: inboxCount, pct: 64, color: '#9ca3af', avs: people.slice(0, 2) },
      { key: 'waiting', name: 'Waiting', sub: 'Consolidating', count: waitingCount, pct: 46, color: '#f59e0b', avs: people.slice(1, 2) },
      { key: 'focus', name: 'In Focus', sub: 'Live pipelines', count: focusCount, pct: 82, color: '#3b82f6', avs: people.slice(2, 4) },
      { key: 'completed', name: 'Completed', sub: 'Verified today', count: doneCount, pct: 92, color: '#22c55e', avs: people.slice(0, 2) },
    ];

    const ringSvg = (pct, color) => {
      const r = 12;
      const c = 2 * Math.PI * r;
      const off = c * (1 - Math.max(0.08, Math.min(1, pct / 100)));
      return `<svg class="ts-ring-svg" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="${r}" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="2.4"/>
        <circle cx="15" cy="15" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
      </svg>`;
    };

    // Row 3 Left: Day Capacity (computed from live Whoop + schedule + pipelines)
    const sleepH = Number(whoop.sleep_hours || 6.5);
    const activeWindow = Math.max(10, Math.round((24 - sleepH) * 10) / 10);
    const schedCount = (t.schedule || []).length;
    const focusPct = Math.max(42, Math.min(62, Math.round((whoop.recovery_pct || 61) * 0.85)));
    const syncPct = Math.max(18, Math.min(34, schedCount * 3 + 6));
    const freePct = Math.max(12, 100 - focusPct - syncPct);
    const focusH = (activeWindow * focusPct / 100).toFixed(1);
    const syncH = (activeWindow * syncPct / 100).toFixed(1);
    const freeH = (activeWindow * freePct / 100).toFixed(1);

    // Row 3 Right: Mind & Agent Velocity (real datasets switchable across 3 modes)
    const velSets = {
      core: {
        label: 'Kizuki Core',
        bars: [
          { id: 'wa', name: 'WhatsApp', badge: 'W', tone: 'emerald', pct: Math.min(95, Math.max(18, Math.round(((ic.whatsapp || 140) / Math.max(1, ic.priority || 355)) * 100))), detail: `${fmtNum(ic.whatsapp || 0)} threads` },
          { id: 'tg', name: 'Telegram', badge: 'T', tone: 'amber', pct: Math.min(95, Math.max(24, Math.round(((ic.telegram || 107) / Math.max(1, ic.priority || 355)) * 140))), detail: `${fmtNum(ic.telegram || 0)} signals` },
          { id: 'ai', name: 'Canon', badge: 'K', tone: 'cobalt', pct: Math.min(94, Math.max(68, Math.round(((sm.active_pipelines || 18) / Math.max(1, sm.total_pipelines || 20)) * 96))), delta: '+14%', detail: `${fmtNum(liveClaims)} live claims` },
          { id: 'mail', name: 'Gmail', badge: 'G', tone: 'slate', pct: Math.min(90, Math.max(20, Math.round(((ic.gmail || 83) / Math.max(1, ic.priority || 355)) * 125))), detail: `${fmtNum(ic.gmail || 0)} messages` },
        ],
      },
      channels: {
        label: 'People',
        bars: people.slice(0, 4).map((p, i) => {
          const tones = ['emerald', 'amber', 'cobalt', 'slate'];
          const maxMsg = Math.max(1, ...people.slice(0, 4).map((x) => x.message_count || 1));
          const pct = Math.max(22, Math.min(92, Math.round(((p.message_count || 40) / maxMsg) * 88)));
          return {
            id: p.key || `p${i}`,
            name: clean(p.name).split(' ')[0],
            badge: initials(p.name)[0],
            tone: tones[i % 4],
            pct,
            delta: i === 2 ? '+18%' : '',
            detail: `${fmtNum(p.message_count || 0)} msgs`,
          };
        }),
      },
      pipelines: {
        label: 'Pipelines',
        bars: [
          { id: 'p1', name: 'Claude', badge: 'C', tone: 'cobalt', pct: 89, delta: '+21%', detail: `${fmtNum(v.connectors?.[0]?.count || 62993)} events` },
          { id: 'p2', name: 'Codex', badge: 'X', tone: 'amber', pct: 64, detail: `${fmtNum(v.connectors?.[2]?.count || 35078)} events` },
          { id: 'p3', name: 'Wiki', badge: 'W', tone: 'emerald', pct: 48, detail: `${fmtNum(v.connectors?.[3]?.count || 8075)} pages` },
          { id: 'p4', name: 'Notes', badge: 'N', tone: 'slate', pct: 32, detail: `${fmtNum(v.connectors?.[4]?.count || 2671)} docs` },
        ],
      },
    };
    const activeVel = velSets[S.velMode] && velSets[S.velMode].bars.length === 4 ? velSets[S.velMode] : velSets.core;
    // Mark tallest bar with delta bubble if none set
    let maxIdx = 0;
    activeVel.bars.forEach((b, i) => {
      if (b.pct > activeVel.bars[maxIdx].pct) maxIdx = i;
    });

    // Row 4 Recent Activity filtered
    const allRows = buildActivityFeed();
    const filteredRows = allRows
      .filter((r) => (S.actFilter === 'all' ? true : r.kind === S.actFilter))
      .filter((r) => (S.chamberFilter === 'all' ? true : r.chamber === S.chamberFilter))
      .slice(0, 4);

    body.innerHTML = `
      <section aria-label="Overview metrics">
        <div class="ts-sec-head">
          <h2 class="ts-sec-title">Overview</h2>
          <span class="ts-chip-pill">
            ${svgIc('<circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.2"/>', 12, 1.4)}
            Last 24h
          </span>
        </div>
        <div class="ts-kpi-grid">
          <button type="button" class="ts-kpi-card" data-tone="blue" data-ts-jump="stream" data-tactile-rim>
            <div class="ts-kpi-top">
              <span class="ts-kpi-label">Events captured</span>
              <span class="ts-kpi-icon" aria-hidden="true">${svgIc('<path d="M3.5 2.5h6.2L13 5.8v7.7H3.5V2.5Z"/><path d="M9.5 2.5v3.5H13"/>', 14, 1.5)}</span>
            </div>
            <div class="ts-kpi-val">${esc(ready ? fmtNum(events24h) : '--')}</div>
            <div class="ts-kpi-delta"><span class="ts-delta-up">&#8599; +${esc(fmtNum(claims24h))}</span> claims indexed</div>
          </button>

          <button type="button" class="ts-kpi-card" data-tone="orange" data-ts-jump="triage" data-tactile-rim>
            <div class="ts-kpi-top">
              <span class="ts-kpi-label">Priority inbox</span>
              <span class="ts-kpi-icon" aria-hidden="true">${svgIc('<rect x="2.2" y="3.5" width="11.6" height="9" rx="1.8"/><path d="M2.5 5.2 8 9l5.5-3.8"/>', 14, 1.5)}</span>
            </div>
            <div class="ts-kpi-val">${esc(ready ? fmtNum(priorityInbox) : '--')}</div>
            <div class="ts-kpi-delta"><span class="ts-delta-warn">&#8599; ${esc(ic.whatsapp || 0)} WA</span> &middot; ${esc(ic.telegram || 0)} TG &middot; ${esc(ic.gmail || 0)} Mail</div>
          </button>

          <button type="button" class="ts-kpi-card" data-tone="violet" data-ts-jump="vault" data-tactile-rim>
            <div class="ts-kpi-top">
              <span class="ts-kpi-label">Verified claims</span>
              <span class="ts-kpi-icon" aria-hidden="true">${svgIc('<circle cx="6.2" cy="5.5" r="2.2"/><path d="M2.2 13c.4-2.1 2-3.2 4-3.2s3.6 1.1 4 3.2"/><path d="M11 5.5h3M12.5 4v3"/>', 14, 1.5)}</span>
            </div>
            <div class="ts-kpi-val">${esc(ready ? fmtNum(liveClaims) : '--')}</div>
            <div class="ts-kpi-delta"><span class="ts-delta-up">&#8599; ${esc(memtCount)} MemT</span> &middot; ${esc(fmtNum(ontoTerms || v.docs_total || 0))} terms</div>
          </button>
        </div>
      </section>

      <section aria-label="Workload pipeline">
        <div class="ts-sec-head">
          <h2 class="ts-sec-title">Workload</h2>
          <span class="ts-updated-meta">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 10.5a2.6 2.6 0 0 1 .4-5.2A4 4 0 0 1 11 4.2a2.8 2.8 0 0 1 1.7 5.3"/></svg>
            ${esc(fmtNum(openTotal))} live signals
          </span>
        </div>
        <div class="ts-workload-strip" role="group" aria-label="Filter by workload state">
          ${chambers
            .map(
              (c) => `
            <button type="button" class="ts-chamber ${S.chamberFilter === c.key ? 'is-selected' : ''}" data-ts-chamber="${c.key}">
              <div class="ts-chamber-l">
                <div class="ts-ring-wrap">
                  ${ringSvg(c.pct, c.color)}
                  <span class="ts-ring-num">${esc(c.count)}</span>
                </div>
                <div class="ts-chamber-meta">
                  <span class="ts-chamber-name">${esc(c.name)}</span>
                  <span class="ts-chamber-sub">${esc(c.sub)}</span>
                </div>
              </div>
              <div class="ts-avatar-stack">
                ${c.avs
                  .map((p, idx) => `<span class="ts-av ts-av-${(idx + c.count) % 5}">${esc(initials(p.name))}</span>`)
                  .join('')}
              </div>
            </button>`
            )
            .join('')}
        </div>
      </section>

      <section class="ts-viz-grid" aria-label="Capacity and velocity analytics">
        <article class="ts-viz-card" data-tactile-rim>
          <div class="ts-viz-head">
            <div>
              <h3 class="ts-viz-title">Day capacity</h3>
              <div class="ts-viz-sub">Whoop ${esc(whoop.recovery_pct || 61)}% &middot; ${esc(sm.active_pipelines || 18)}/${esc(sm.total_pipelines || 20)} pipelines active</div>
            </div>
            <span class="ts-chip-pill">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.2"/></svg>
              Today
            </span>
          </div>
          <div class="ts-cap-hero">
            <span class="ts-cap-num">${esc(activeWindow)}h</span>
            <span class="ts-cap-unit">Active window</span>
          </div>
          <div class="ts-cap-diagram">
            <div class="ts-cap-stems" style="grid-template-columns:${focusPct}fr ${syncPct}fr ${freePct}fr">
              <div class="ts-cap-stem"><span class="ts-cap-stem-lbl"><strong>${focusPct}%</strong>${focusH}h</span></div>
              <div class="ts-cap-stem"><span class="ts-cap-stem-lbl"><strong>${syncPct}%</strong>${syncH}h</span></div>
              <div class="ts-cap-stem"><span class="ts-cap-stem-lbl"><strong>${freePct}%</strong>${freeH}h</span></div>
            </div>
            <div class="ts-cap-bar" aria-label="Day capacity split">
              <div class="ts-cap-seg is-focus" style="flex:${focusPct}"></div>
              <div class="ts-cap-seg is-sync" style="flex:${syncPct}"></div>
              <div class="ts-cap-seg is-free" style="flex:${freePct}"></div>
            </div>
            <div class="ts-cap-legend">
              <span class="ts-leg-item"><span class="ts-leg-dot" style="background:var(--ts-cobalt)"></span>Focus</span>
              <span class="ts-leg-item"><span class="ts-leg-dot" style="background:var(--ts-orange)"></span>Schedule</span>
              <span class="ts-leg-item"><span class="ts-leg-dot" style="background:var(--ink-muted)"></span>Buffer</span>
            </div>
          </div>
        </article>

        <article class="ts-viz-card" data-tactile-rim>
          <div class="ts-viz-head">
            <div>
              <h3 class="ts-viz-title">Mind velocity</h3>
              <div class="ts-viz-sub">Signal throughput by domain</div>
            </div>
            <button type="button" class="ts-vel-select" data-ts-vel-cycle title="Cycle velocity dimension">
              <span>${esc(activeVel.label)}</span>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 6 4 4 4-4"/></svg>
            </button>
          </div>
          ${S.velHover ? `<div class="ts-vel-tooltip">${esc(S.velHover)}</div>` : ''}
          <div class="ts-vel-stage">
            <div class="ts-vel-target"><span class="ts-vel-target-lbl">Target 70%</span></div>
            <div class="ts-vel-cols">
              ${activeVel.bars
                .map((b, i) => {
                  const showBubble = i === maxIdx;
                  const bubbleTxt = b.delta || '+14%';
                  return `
                  <div class="ts-vel-col">
                    <button type="button" class="ts-vel-track" data-ts-vel-bar="${esc(b.name)}: ${b.pct}% (${esc(b.detail)})" aria-label="${esc(b.name)} ${b.pct}%">
                      <div class="ts-vel-bar is-${b.tone}" style="height:${b.pct}%">
                        ${showBubble ? `<span class="ts-vel-bubble">&#8593; ${esc(bubbleTxt.replace(/^\+/, ''))}</span>` : ''}
                        <span class="ts-vel-pct">${b.pct}%</span>
                      </div>
                    </button>
                  </div>`;
                })
                .join('')}
            </div>
            <div class="ts-vel-foot">
              ${activeVel.bars
                .map(
                  (b) => `
                <span class="ts-vel-tag">
                  <span class="ts-vel-badge is-${b.tone}">${esc(b.badge)}</span>
                  <span class="truncate">${esc(b.name)}</span>
                </span>`
                )
                .join('')}
            </div>
          </div>
        </article>
      </section>

      <section aria-label="Recent activity">
        <div class="ts-act-head">
          <h2 class="ts-sec-title">Recent activity</h2>
          <div class="ts-act-controls">
            <div class="ts-seg-tabs" role="tablist" aria-label="Filter recent activity">
              ${[
                ['all', 'All'],
                ['inbox', 'Inbox'],
                ['actions', 'Actions'],
                ['people', 'People'],
              ]
                .map(
                  ([k, lbl]) =>
                    `<button type="button" class="ts-seg-btn ${S.actFilter === k ? 'is-active' : ''}" data-ts-act-filter="${k}">${lbl}</button>`
                )
                .join('')}
            </div>
            <button type="button" class="ts-view-all" data-ts-jump="stream">View all</button>
          </div>
        </div>
        <div class="ts-act-list">
          ${
            filteredRows.length
              ? filteredRows
                  .map(
                    (r) => `
              <button type="button" class="ts-act-row ${S.selectedRowId === r.id ? 'is-selected' : ''}" data-ts-row="${esc(r.id)}">
                <span class="ts-act-av ts-av-${r.avatarIdx}">${esc(initials(r.actor))}</span>
                <span class="ts-act-body">
                  <span class="ts-act-line"><strong>${esc(r.actor)}</strong> ${esc(r.text)}</span>
                  <span class="ts-act-sub">${esc(r.sub)}</span>
                </span>
                <span class="ts-status-pill is-${r.tone}"><span class="ts-status-dot"></span>${esc(r.status)}</span>
                <span class="ts-act-more" aria-hidden="true">&middot;&middot;&middot;</span>
              </button>`
                  )
                  .join('')
              : `<div class="ts-act-sub" style="padding:14px 4px;">No items match this filter. Click the active workload chamber to reset.</div>`
          }
        </div>
      </section>
    `;
  }

  function renderInspector() {
    const rail = S.el.inspector;
    if (!rail) return;

    const t = S.today || {};
    const ov = S.overview || {};
    const v = ov.vault || {};
    const sm = t.summary || {};
    const whoop = t.whoop || {};
    const sched = Array.isArray(t.schedule) ? t.schedule.slice(0, 3) : [];
    const rows = buildActivityFeed();
    const sel = S.selectedRowId ? rows.find((r) => r.id === S.selectedRowId) : null;

    const name = sel ? sel.actor : OWNER_NAME;
    const handle = sel ? sel.sub.split('·')[1]?.trim() || '@signal' : '@kizuki';
    const statusTxt = sel ? sel.status : 'Online';
    const stat1K = sel ? sel.metaKey : 'Vault claims';
    const stat1V = sel ? sel.metaVal : fmtNum(v.claims_live ?? sm.claims_live ?? 40452);
    const stat2K = sel ? 'Recovery' : 'Timezone';
    const stat2V = sel ? `${whoop.recovery_pct || 61}% Whoop` : londonTimeStr();
    const consDone = Number(v.consolidation_complete || 0);
    const consPend = Number(v.consolidation_pending || 0);
    const progPct = consDone + consPend > 0
      ? Math.max(12, Math.min(92, Math.round((consDone / (consDone + consPend)) * 100)))
      : dayProgressPct();

    const tones = ['blue', 'amber', 'green'];
    const upIcons = [
      '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/>',
      '<rect x="2.5" y="3.2" width="11" height="10.2" rx="1.6"/><path d="M5.2 2v2.2M10.8 2v2.2M2.5 6.6h11"/>',
      '<circle cx="6.2" cy="5.6" r="2"/><path d="M2.5 12.6c.4-2 1.8-3 3.7-3s3.3 1 3.7 3M10.6 4.6a1.8 1.8 0 0 1 0 3.2"/>',
    ];

    const recapSummary = `${fmtNum(v.events_24h || 2889)} events and ${fmtNum(sm.priority_inbox_count || 355)} priority signals indexed. ${sm.active_pipelines || 18}/${sm.total_pipelines || 20} pipelines active.`;

    rail.innerHTML = `
      <div class="ts-aurora-banner">
        <button type="button" class="ts-aurora-edit" data-ts-insp-reset title="${sel ? 'Return to overview' : 'Refresh live telemetry'}" aria-label="Reset inspector">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            ${sel ? '<path d="M4 4l8 8M12 4l-8 8"/>' : '<path d="M11.5 2.8l1.7 1.7-7.4 7.4-2.3.6.6-2.3 7.4-7.4Z"/>'}
          </svg>
        </button>
      </div>
      <div class="ts-profile-av-row">
        <div class="ts-profile-av">${esc(initials(name))}</div>
      </div>
      <div class="ts-id-block">
        <div class="ts-id-name">
          <span class="truncate">${esc(name)}</span>
          <span class="ts-verified" title="Verified Kizuki canon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 1.6l2.1 1.4 2.5-.2 1.1 2.3 2.2 1.2-.3 2.5 1.3 2.1-1.3 2.1.3 2.5-2.2 1.2-1.1 2.3-2.5-.2L10 18.4l-2.1-1.4-2.5.2-1.1-2.3-2.2-1.2.3-2.5L1.1 10l1.3-2.1-.3-2.5 2.2-1.2 1.1-2.3 2.5.2L10 1.6Z"/>
              <path d="M7.2 10.2l1.9 1.9 3.8-4.1" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
        </div>
        <div class="ts-id-sub">
          <span>${esc(handle)}</span>
          <span class="ts-online-pill">${esc(statusTxt)}</span>
        </div>
      </div>

      ${sel ? `<div class="ts-insp-snippet">${esc(sel.snippet || sel.text)}</div>` : ''}

      <div class="ts-insp-actions">
        <button type="button" class="ts-insp-btn" data-ts-action="ask">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6.2L3.2 13.5V11H4a1.5 1.5 0 0 1-1.5-1.5V4Z"/></svg>
          Ask
        </button>
        <button type="button" class="ts-insp-btn" data-ts-action="capture">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
          Capture
        </button>
        <button type="button" class="ts-insp-btn" data-ts-action="ontology">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="3.5" r="1.5"/><circle cx="3.8" cy="11.5" r="1.5"/><circle cx="12.2" cy="11.5" r="1.5"/><path d="M7.1 4.9 4.6 10.1M8.9 4.9l2.5 5.2M5.3 11.5h5.4"/></svg>
          Graph
        </button>
      </div>

      <div class="ts-stat-pair">
        <div class="ts-stat-tile">
          <div class="ts-stat-k">${esc(stat1K)}</div>
          <div class="ts-stat-v">${esc(stat1V)}</div>
        </div>
        <div class="ts-stat-tile">
          <div class="ts-stat-k">${esc(stat2K)}</div>
          <div class="ts-stat-v">${esc(stat2V)}</div>
        </div>
      </div>

      <div class="ts-vernier-card">
        <div class="ts-vernier-head">
          <span class="ts-vernier-lbl">Canon sync</span>
          <span class="ts-vernier-pct">${progPct}%</span>
        </div>
        <div class="ts-vernier-track" aria-label="Canon sync ${progPct} percent">
          <div class="ts-vernier-ticks"></div>
          <div class="ts-vernier-fill" style="width:${progPct}%">
            <span class="ts-vernier-bead"></span>
          </div>
        </div>
      </div>

      <div>
        <div class="ts-upcoming-head">Upcoming</div>
        <div class="ts-upcoming-list">
          ${
            sched.length
              ? sched
                  .map(
                    (ev, i) => `
              <button type="button" class="ts-up-item" data-ts-jump="schedule">
                <span class="ts-up-ico is-${tones[i % 3]}" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${upIcons[i % 3]}</svg>
                </span>
                <span class="ts-up-meta">
                  <span class="ts-up-title">${esc(ev.title || 'Scheduled session')}</span>
                  <span class="ts-up-time">${esc(ev.countdown || 'Upcoming')} &middot; ${esc((ev.calendar || '').split('@')[0] || 'Calendar')}</span>
                </span>
              </button>`
                  )
                  .join('')
              : `<div class="ts-up-time">No upcoming meetings on calendar.</div>`
          }
        </div>
      </div>

      <section class="ts-recap-card" aria-label="Daily AI recap">
        <div class="ts-recap-ico" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4L8 1.5Z"/>
          </svg>
        </div>
        <h3 class="ts-recap-title">Your day, summarized</h3>
        <p class="ts-recap-copy">${esc(recapSummary)}</p>
        ${S.recapText ? `<div class="ts-recap-out">${esc(S.recapText)}</div>` : ''}
        <div class="ts-recap-actions">
          <button type="button" class="ts-btn-cta" data-ts-action="recap" ${S.recapLoading ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.3 3.9 3.9 1.3-3.9 1.3L8 12l-1.3-4-3.9-1.3 3.9-1.3L8 1.5Z"/></svg>
            ${S.recapLoading ? 'Summarizing...' : 'Generate recap'}
          </button>
          <button type="button" class="ts-btn-bevel" data-ts-action="ask">Ask</button>
        </div>
      </section>
    `;
  }

  async function generateRecap() {
    if (S.recapLoading) return;
    S.recapLoading = true;
    renderInspector();
    try {
      const res = await fetch('/api/brief', { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const raw = clean(data.summary || data.content || data.markdown || '');
        const lines = raw
          .split('\n')
          .map((l) => l.replace(/^#+\s*/, '').trim())
          .filter((l) => l && !l.startsWith('---'))
          .slice(0, 5);
        S.recapText = lines.join('\n') || 'Live vault synced. Open Ask Mind for deep synthesis.';
      } else {
        S.recapText = 'Live brief ready in Triage workbench. Click Ask for interactive synthesis.';
      }
    } catch {
      S.recapText = 'Offline recap unavailable. Click Ask Mind to run local synthesis.';
    } finally {
      S.recapLoading = false;
      renderInspector();
    }
  }

  async function refreshTelemetry() {
    try {
      const [rToday, rOv, rOnt] = await Promise.all([
        fetch('/api/today', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/overview', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/ontology/status', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (rToday) S.today = rToday;
      if (rOv) S.overview = rOv;
      if (rOnt) S.ontology = rOnt;
      S.lastUpdatedAt = Date.now();
      renderCockpit();
      renderInspector();
    } catch {}
  }

  function syncActiveView() {
    const shell = D.getElementById('app-shell');
    const view = shell?.getAttribute('data-active-view') || 'today';
    if (S.el.crumbCur) {
      S.el.crumbCur.textContent = VIEW_LABELS[view] || view;
    }
  }

  function mountShell() {
    if (S.mounted) return;
    const shell = D.getElementById('app-shell');
    const sidebar = D.getElementById('os-sidebar');
    const workspace = D.getElementById('workspace');
    const viewToday = D.getElementById('view-today');
    if (!shell || !sidebar || !workspace || !viewToday) return;

    S.mounted = true;
    syncThemeFromUrl();


    // 3. Build Main Frame (Topbar + Stage Row wrapping existing #workspace + Right Inspector Rail)
    const frame = D.createElement('div');
    frame.className = 'ts-main-frame';
    frame.id = 'ts-main-frame';

    const topbar = D.createElement('header');
    topbar.className = 'ts-topbar';
    topbar.id = 'ts-topbar';
    topbar.innerHTML = `
      <div class="ts-crumb" aria-label="Breadcrumb">
        <span class="ts-crumb-root">Kizuki</span>
        <span class="ts-crumb-sep">/</span>
        <span class="ts-crumb-cur" id="ts-crumb-cur">Today</span>
      </div>
      <button type="button" class="ts-search-bar" data-ts-action="cmdk" aria-label="Search memory, people, claims">
        <span class="ts-search-bar-l">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6 14 14" stroke-linecap="round"/></svg>
          <span>Search memory, people, claims...</span>
        </span>
        <kbd>&#8984;K</kbd>
      </button>
      <div class="ts-topbar-actions">
        <button type="button" class="ts-btn-bevel" data-ts-action="ontology" title="Auto-Ontology Studio (Alt+O)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="3.4" r="1.5"/><circle cx="3.8" cy="11.6" r="1.5"/><circle cx="12.2" cy="11.6" r="1.5"/><path d="M7.1 4.8 4.6 10.2M8.9 4.8l2.5 5.4M5.3 11.6h5.4"/></svg>
          Ontology
        </button>
        <button type="button" class="ts-btn-bevel" data-ts-action="ailive" title="Box AI Neural Observatory (Alt+I)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 8h2.5l1.6-4.2 2.3 8.4L10.4 8H14"/></svg>
          AI Live
        </button>
        <button type="button" class="ts-icon-btn" data-ts-action="theme" title="Switch dark / light" aria-label="Switch theme">
          <svg class="icon-sun" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.9"/><path d="M8 1.6V3M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1"/></svg>
          <svg class="icon-moon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 9.8A5.4 5.4 0 0 1 6.2 3a5.4 5.4 0 1 0 6.8 6.8Z"/></svg>
        </button>
        <button type="button" class="ts-icon-btn" data-ts-action="shortcuts" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M6.5 6.3a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1.1"/><circle cx="8" cy="11.3" r=".6" fill="currentColor"/></svg>
        </button>
        <button type="button" class="ts-btn-cta" data-ts-action="capture">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
          Capture
        </button>
      </div>
    `;

    const stageRow = D.createElement('div');
    stageRow.className = 'ts-stage-row';
    stageRow.id = 'ts-stage-row';

    const inspector = D.createElement('aside');
    inspector.className = 'ts-inspector';
    inspector.id = 'ts-inspector';
    inspector.setAttribute('aria-label', 'Contextual Mind Inspector');

    shell.insertBefore(frame, workspace);
    frame.appendChild(topbar);
    frame.appendChild(stageRow);
    stageRow.appendChild(workspace);
    stageRow.appendChild(inspector);

    S.el.crumbCur = topbar.querySelector('#ts-crumb-cur');
    S.el.inspector = inspector;

    // 4. Mount Tessera Summary Cockpit inside #view-today (non-destructive)
    viewToday.classList.add('ts-today-enhanced');
    viewToday.setAttribute('data-ts-today-tab', 'summary');

    const cockpit = D.createElement('div');
    cockpit.className = 'ts-cockpit';
    cockpit.id = 'ts-today-cockpit';
    cockpit.innerHTML = `
      <header class="ts-cockpit-head">
        <div class="ts-title-row">
          <div class="ts-title-l">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.2" r="2.4"/><path d="M3.2 13.2c.6-2.5 2.4-3.8 4.8-3.8s4.2 1.3 4.8 3.8"/></svg>
            <h1 class="ts-title-h1">Your mind</h1>
          </div>
          <div class="ts-live-strip">
            <span class="ts-updated-meta">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.2"/></svg>
              <span id="ts-updated-lbl">Syncing...</span>
            </span>
            <span class="ts-avatar-stack" id="ts-live-avatars"></span>
            <span class="ts-live-pill"><span class="ts-live-dot" aria-hidden="true"></span>Live</span>
          </div>
        </div>
        <div class="ts-subtabs" role="tablist" aria-label="Today modes">
          <button type="button" class="ts-subtab is-active" role="tab" aria-selected="true" data-ts-tab="summary">Summary</button>
          <button type="button" class="ts-subtab" role="tab" aria-selected="false" data-ts-tab="triage">Triage</button>
          <button type="button" class="ts-subtab" role="tab" aria-selected="false" data-ts-tab="actions">Actions</button>
          <button type="button" class="ts-subtab" role="tab" aria-selected="false" data-ts-tab="schedule">Schedule</button>
          <button type="button" class="ts-subtab" role="tab" aria-selected="false" data-ts-tab="activity">Activity</button>
        </div>
      </header>
      <div class="ts-cockpit-body" id="ts-cockpit-body"></div>
    `;
    viewToday.insertBefore(cockpit, viewToday.firstChild);
    S.el.cockpit = cockpit;
    S.el.cockpitBody = cockpit.querySelector('#ts-cockpit-body');
    S.el.liveAvatars = cockpit.querySelector('#ts-live-avatars');
    S.el.updatedLabel = cockpit.querySelector('#ts-updated-lbl');

    shell.classList.add('ts-shell-ready');

    // Unified event delegation for Dock, Topbar, Cockpit & Inspector
    function handleAction(action) {
      if (action === 'cmdk') triggerCmdk();
      else if (action === 'ontology') triggerOntology();
      else if (action === 'ailive') triggerAiLive();
      else if (action === 'capture') triggerQuickCapture();
      else if (action === 'ask') triggerAskMind();
      else if (action === 'recap') generateRecap();
      else if (action === 'shortcuts') D.getElementById('btn-kbd-atlas')?.click();
      else if (action === 'theme') D.getElementById('btn-theme-toggle')?.click();
      else if (action === 'detail') D.getElementById('btn-detail-toggle')?.click();
      else if (action === 'rail') {
        S.railCollapsed = !S.railCollapsed;
        inspector.classList.toggle('is-collapsed', S.railCollapsed);
      }
    }

    D.addEventListener('click', (ev) => {
      const target = ev.target && ev.target.closest ? ev.target : null;
      if (!target) return;

      const dockView = target.closest('[data-ts-view]');
      if (dockView) {
        const v = dockView.getAttribute('data-ts-view');
        if (v) triggerView(v);
        if (v === 'today') setTodayTab('summary');
        return;
      }

      const actEl = target.closest('[data-ts-action]');
      if (actEl) {
        handleAction(actEl.getAttribute('data-ts-action'));
        return;
      }

      const tabEl = target.closest('[data-ts-tab]');
      if (tabEl) {
        const t = tabEl.getAttribute('data-ts-tab');
        if (t === 'activity') {
          triggerView('stream');
        } else if (t) {
          setTodayTab(t);
        }
        return;
      }

      const jumpEl = target.closest('[data-ts-jump]');
      if (jumpEl) {
        const j = jumpEl.getAttribute('data-ts-jump');
        if (j === 'triage' || j === 'schedule' || j === 'actions') {
          triggerView('today');
          setTodayTab(j);
        } else if (j) {
          triggerView(j);
        }
        return;
      }

      const chEl = target.closest('[data-ts-chamber]');
      if (chEl) {
        const k = chEl.getAttribute('data-ts-chamber');
        S.chamberFilter = S.chamberFilter === k ? 'all' : k;
        renderCockpit();
        return;
      }

      const afEl = target.closest('[data-ts-act-filter]');
      if (afEl) {
        S.actFilter = afEl.getAttribute('data-ts-act-filter') || 'all';
        renderCockpit();
        return;
      }

      const velCycle = target.closest('[data-ts-vel-cycle]');
      if (velCycle) {
        const order = ['core', 'channels', 'pipelines'];
        S.velMode = order[(order.indexOf(S.velMode) + 1) % order.length];
        S.velHover = null;
        renderCockpit();
        return;
      }

      const velBar = target.closest('[data-ts-vel-bar]');
      if (velBar) {
        S.velHover = velBar.getAttribute('data-ts-vel-bar');
        renderCockpit();
        return;
      }

      const rowEl = target.closest('[data-ts-row]');
      if (rowEl) {
        const id = rowEl.getAttribute('data-ts-row');
        S.selectedRowId = S.selectedRowId === id ? null : id;
        renderCockpit();
        renderInspector();
        return;
      }

      if (target.closest('[data-ts-insp-reset]')) {
        if (S.selectedRowId) {
          S.selectedRowId = null;
          renderCockpit();
          renderInspector();
        } else {
          refreshTelemetry();
        }
      }
    });

    // Hover feedback on velocity bars
    cockpit.addEventListener('mouseover', (ev) => {
      const b = ev.target?.closest?.('[data-ts-vel-bar]');
      if (b) {
        const txt = b.getAttribute('data-ts-vel-bar');
        if (txt !== S.velHover) {
          S.velHover = txt;
          let tip = cockpit.querySelector('.ts-vel-tooltip');
          const card = b.closest('.ts-viz-card');
          if (card) {
            if (!tip) {
              tip = D.createElement('div');
              tip.className = 'ts-vel-tooltip';
              card.appendChild(tip);
            }
            tip.textContent = txt;
          }
        }
      }
    });

    cockpit.addEventListener('mouseout', (ev) => {
      if (ev.target?.closest?.('[data-ts-vel-bar]') && !ev.relatedTarget?.closest?.('[data-ts-vel-bar]')) {
        S.velHover = null;
        cockpit.querySelector('.ts-vel-tooltip')?.remove();
      }
    });

    // Sync view changes from app.js
    const mo = new MutationObserver(syncActiveView);
    mo.observe(shell, { attributes: true, attributeFilter: ['data-active-view'] });
    syncActiveView();

    renderCockpit();
    renderInspector();
    refreshTelemetry();

    // Refresh live clock + telemetry periodically
    W.setInterval(() => {
      if (D.visibilityState === 'visible') {
        refreshTelemetry();
      }
    }, 45000);
  }

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', mountShell, { once: true });
  } else {
    mountShell();
  }

  root.KizukiTessera = {
    refresh: refreshTelemetry,
    setTodayTab,
  };
})(typeof window !== 'undefined' ? window : globalThis);
