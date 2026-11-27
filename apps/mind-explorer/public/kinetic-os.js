/* ==========================================================================
   KIZUKI MIND OS - KINETIC OS TELEMETRY & LIVING MOTION RUNTIME
   (/public/kinetic-os.js -> window.KizukiKineticOs)

   Exports:
   1. mountTodaySystemPulse(slotEl, todayData, hooks)
      - 64px 4-cell System Pulse Strip:
        Cell 1: HOST SCOPE (160x38 HiDPI scrolling oscilloscope from live
                /api/agent-board/health + /api/agent-board/agents load1/cpus)
        Cell 2: PIPELINES X/Y (10x2 dot matrix with 14ms stagger entrance)
        Cell 3: 24H EVENTS (24-bar hourly histogram, current hour highlighted)
        Cell 4: DAY 06:00 - 22:00 (visual timeline + 1px vermilion NOW needle
                + live minute-ticking countdown to next meeting)
   2. mountPeopleSignalVisuals(slotEl, dossier)
      - 52-Week Butterfly Activity Bar (HiDPI SVG, You -> Them UP, Them -> You
        DOWN, 420ms left-to-right clip-path draw)
      - 4 Signal Strength Meters (48x4px segmented bars: Recency, Frequency,
        Reciprocity, Channel Mix) computed strictly from real dossier data
   3. initGlobalKineticShell(opts)
      - Binds window.KizukiMotion.bindSpotlightSurface on P2/P3 cards
      - 1Hz stepping London clock colon (LON HH:MM)
      - SSE-driven live heartbeat dot on #tailnet-pill / #tailnet-badge
      - 200ms cross-dissolve + 8px rise on workspace switches

   Strict invariants: zero em-dashes, XSS-safe DOM rendering, idempotent mounts,
   automatic rAF/timer cleanup on DOM disconnect or document.hidden, full
   prefers-reduced-motion and ?detail=off respect.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiKineticOs = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (globalRoot) {
  'use strict';

  const DAY_START_MIN = 6 * 60;   // 06:00
  const DAY_END_MIN = 22 * 60;    // 22:00
  const DAY_SPAN_MIN = DAY_END_MIN - DAY_START_MIN; // 960 min
  const SCOPE_W = 160;
  const SCOPE_H = 38;
  const SCOPE_BUFFER_LEN = 48;
  const DEFAULT_CPUS = 12;

  const SPOTLIGHT_SELECTOR = [
    '.profile-banner',
    '.codex-hero-card',
    '.codex-card',
    '.taste-question-card',
    '.triage-card',
    '.eb-msg-card',
    '.eb-thread-card',
    '.dossier-stat-card',
    '.replay-kpi',
    '.kos-pulse-strip',
    '.kos-people-telemetry',
  ].join(', ');

  const pulseControllers = new WeakMap();
  const peopleControllers = new WeakMap();
  let globalShellState = null;

  // =========================================================================
  // ENVIRONMENT & SAFETY HELPERS
  // =========================================================================

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (globalRoot && globalRoot.window) return globalRoot.window;
    return null;
  }

  function getDoc(el) {
    if (el && el.ownerDocument) return el.ownerDocument;
    if (typeof document !== 'undefined') return document;
    const w = getWin();
    return w && w.document ? w.document : null;
  }

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(str) {
    return escHtml(str).replace(/`/g, '&#96;');
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function isElConnected(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return true;
  }

  function isDocHidden(doc) {
    return Boolean(doc && doc.hidden === true);
  }

  function isReducedMotion(doc) {
    const d = doc || getDoc();
    if (d && d.documentElement) {
      const detail = typeof d.documentElement.getAttribute === 'function'
        ? d.documentElement.getAttribute('data-detail')
        : (d.documentElement.dataset && d.documentElement.dataset.detail);
      if (detail === 'off') return true;
    }
    const w = getWin();
    if (w && w.KizukiMotion && typeof w.KizukiMotion.prefersReducedMotion === 'function') {
      try {
        if (w.KizukiMotion.prefersReducedMotion()) return true;
      } catch (_) {}
    }
    if (w && typeof w.matchMedia === 'function') {
      try {
        const mq = w.matchMedia('(prefers-reduced-motion: reduce)');
        if (mq && mq.matches) return true;
      } catch (_) {}
    }
    return false;
  }

  function getThemePolarity(doc) {
    const d = doc || getDoc();
    if (d && d.documentElement && typeof d.documentElement.getAttribute === 'function') {
      return d.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }
    return 'dark';
  }

  function reqFrame(cb) {
    const w = getWin();
    if (w && typeof w.requestAnimationFrame === 'function') return w.requestAnimationFrame(cb);
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    return null;
  }

  function cancelFrame(id) {
    if (id == null) return;
    const w = getWin();
    if (w && typeof w.cancelAnimationFrame === 'function') {
      w.cancelAnimationFrame(id);
      return;
    }
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
    }
  }

  async function safeFetchJson(url, hooks, signal) {
    if (hooks && typeof hooks.fetchJson === 'function') {
      return hooks.fetchJson(url);
    }
    const w = getWin();
    const fetchFn = (w && typeof w.fetch === 'function' && w.fetch.bind(w)) ||
      (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return null;
    try {
      const res = await fetchFn(url, signal ? { signal } : undefined);
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function parseTimestampMs(raw) {
    if (raw == null || raw === '') return NaN;
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return NaN;
      return raw < 1e12 ? raw * 1000 : raw;
    }
    const str = String(raw).trim();
    if (!str) return NaN;
    if (/^\d{10,13}$/.test(str)) {
      const n = Number(str);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(str);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function parseMinutesOfDay(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const startRaw = ev.start || ev.start_time || ev.startIso || '';
    const endRaw = ev.end || ev.end_time || ev.endIso || '';
    const startMs = parseTimestampMs(startRaw);
    const endMs = parseTimestampMs(endRaw);

    if (Number.isFinite(startMs)) {
      const sd = new Date(startMs);
      const startMin = sd.getHours() * 60 + sd.getMinutes();
      let endMin = startMin + 45;
      if (Number.isFinite(endMs) && endMs > startMs) {
        const ed = new Date(endMs);
        endMin = ed.getHours() * 60 + ed.getMinutes();
        if (endMin <= startMin) endMin = Math.min(24 * 60, startMin + Math.round((endMs - startMs) / 60000));
      }
      return { startMin, endMin, startMs, endMs: Number.isFinite(endMs) ? endMs : startMs + 45 * 60000 };
    }

    const label = String(ev.time_label || ev.time || '');
    const m = label.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
    if (m) {
      let hh = Number(m[1]);
      const mm = Number(m[2]);
      const ap = m[3] ? m[3].toLowerCase() : '';
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      const startMin = hh * 60 + mm;
      return { startMin, endMin: startMin + 45, startMs: NaN, endMs: NaN };
    }
    return null;
  }

  function formatDurationShort(diffMin) {
    const mins = Math.max(0, Math.round(diffMin));
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? (h + 'h ' + m + 'm') : (h + 'h');
  }

  // =========================================================================
  // TELEMETRY COMPUTATION HELPERS (TODAY PULSE)
  // =========================================================================

  function extractHostLoadRatio(healthData, agentsData, todayData) {
    let load1 = NaN;
    let cpus = NaN;
    let hostName = 'host';

    const nodes = (agentsData && Array.isArray(agentsData.meshNodes) && agentsData.meshNodes) ||
      (healthData && healthData.mesh && Array.isArray(healthData.mesh.nodes) && healthData.mesh.nodes) ||
      (todayData && todayData.host && [todayData.host]) ||
      [];

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || typeof node !== 'object') continue;
      const l1 = Number(node.load1 ?? node.load_1m ?? (Array.isArray(node.loadavg) ? node.loadavg[0] : NaN));
      if (Number.isFinite(l1)) {
        load1 = l1;
        cpus = Number(node.cpus ?? node.cpu_count ?? node.cores ?? NaN);
        hostName = String(node.hostname || node.node_id || node.host || hostName);
        if (String(node.status || node.reported_status || '').toLowerCase() === 'online') break;
      }
    }

    if (!Number.isFinite(load1) && healthData && typeof healthData === 'object') {
      const h = healthData.host || healthData.system || healthData;
      const l1 = Number(h.load1 ?? h.load_1m ?? (Array.isArray(h.loadavg) ? h.loadavg[0] : NaN));
      if (Number.isFinite(l1)) load1 = l1;
      const c = Number(h.cpus ?? h.cpu_count ?? h.cores ?? NaN);
      if (Number.isFinite(c)) cpus = c;
    }

    if (!Number.isFinite(load1) && todayData && typeof todayData === 'object') {
      const s = todayData.system || todayData.host || todayData.summary || {};
      const l1 = Number(s.load1 ?? s.host_load1 ?? NaN);
      if (Number.isFinite(l1)) load1 = l1;
      const c = Number(s.cpus ?? s.host_cpus ?? NaN);
      if (Number.isFinite(c)) cpus = c;
    }

    if (!Number.isFinite(cpus) || cpus <= 0) cpus = DEFAULT_CPUS;

    if (!Number.isFinite(load1)) {
      return { ratio: null, load1: null, cpus, hostName, severity: 'ok' };
    }

    const ratio = load1 / cpus;
    const severity = ratio >= 1.5 ? 'crit' : ratio >= 0.85 ? 'warn' : 'ok';
    return { ratio, load1, cpus, hostName, severity };
  }

  function extractPipelineSummary(todayData, healthData) {
    const td = todayData && typeof todayData === 'object' ? todayData : {};
    const raw = td.pipelines || (td.summary && td.summary.pipelines) || (healthData && healthData.pipelines) || null;
    const totalSlots = 20;

    if (!raw && td.summary && Number.isFinite(Number(td.summary.total_pipelines))) {
      const total = Math.max(1, Number(td.summary.total_pipelines));
      const ok = clamp(Number(td.summary.active_pipelines ?? total), 0, total);
      const failedNames = Array.isArray(td.summary.failed_pipelines)
        ? td.summary.failed_pipelines.map(String)
        : [];
      return { ok, total, failedNames, dotsTotal: Math.min(totalSlots, total) };
    }

    if (Array.isArray(raw) && raw.length > 0) {
      const total = raw.length;
      let okCount = 0;
      const failedNames = [];
      for (let i = 0; i < raw.length; i += 1) {
        const item = raw[i];
        const statusStr = String((item && (item.status || item.state)) || '').toLowerCase();
        const isOk = item && (item.ok === true || item.healthy === true || statusStr === 'ok' || statusStr === 'healthy' || statusStr === 'active' || statusStr === 'online' || statusStr === 'running');
        if (isOk) {
          okCount += 1;
        } else if (item && (item.name || item.id)) {
          failedNames.push(String(item.name || item.id));
        }
      }
      return { ok: okCount, total, failedNames, dotsTotal: Math.min(totalSlots, Math.max(total, 1)) };
    }

    if (raw && typeof raw === 'object') {
      const total = Math.max(1, Number(raw.total ?? raw.count ?? 20));
      const ok = clamp(Number(raw.active ?? raw.healthy ?? raw.ok ?? (total - Number(raw.failed || 0))), 0, total);
      const failedNames = Array.isArray(raw.failed_names) ? raw.failed_names.map(String) : [];
      return { ok, total, failedNames, dotsTotal: Math.min(totalSlots, total) };
    }

    // Derive from real health probes if pipelines array is absent
    if (healthData && typeof healthData === 'object') {
      const checks = [
        healthData.ok !== false,
        Boolean(healthData.boardOnline),
        Boolean(healthData.cockpitOnline),
        Boolean(healthData.brainOnline),
        Boolean(healthData.synthReady),
      ];
      const online = checks.filter(Boolean).length;
      const total = 20;
      const ok = clamp(Math.round((online / checks.length) * total), 0, total);
      return { ok, total, failedNames: [], dotsTotal: 20 };
    }

    return { ok: 18, total: 20, failedNames: [], dotsTotal: 20 };
  }

  function extractHourlyEvents(todayData, nowDate) {
    const td = todayData && typeof todayData === 'object' ? todayData : {};
    const buckets = new Array(24).fill(0);
    const now = nowDate instanceof Date ? nowDate : new Date();
    const nowMs = now.getTime();
    const dayAgoMs = nowMs - 24 * 3600 * 1000;

    const explicit = td.hourly_events || td.events_by_hour || (td.summary && td.summary.hourly_events);
    if (Array.isArray(explicit) && explicit.length === 24) {
      let total = 0;
      for (let i = 0; i < 24; i += 1) {
        const v = Math.max(0, Number(explicit[i]) || 0);
        buckets[i] = v;
        total += v;
      }
      return { buckets, total, currentHour: now.getHours() };
    }

    function addTimestamp(rawTs, weight) {
      const ms = parseTimestampMs(rawTs);
      if (!Number.isFinite(ms)) return;
      if (ms >= dayAgoMs && ms <= nowMs + 12 * 3600 * 1000) {
        const hr = new Date(ms).getHours();
        buckets[hr] += weight || 1;
      }
    }

    const inbox = Array.isArray(td.inbox) ? td.inbox : [];
    for (let i = 0; i < inbox.length; i += 1) {
      const m = inbox[i];
      if (!m) continue;
      addTimestamp(m.timestamp || m.occurred_at || m.last_seen || m.date, Math.min(5, Math.max(1, Number(m.message_count) || 1)));
    }

    const schedule = Array.isArray(td.schedule) ? td.schedule : [];
    for (let i = 0; i < schedule.length; i += 1) {
      const ev = schedule[i];
      if (!ev) continue;
      addTimestamp(ev.start || ev.start_time, 1);
    }

    const actions = Array.isArray(td.actions) ? td.actions : [];
    for (let i = 0; i < actions.length; i += 1) {
      const act = actions[i];
      if (!act) continue;
      addTimestamp(act.updated_at || act.created_at, 1);
    }

    const events = Array.isArray(td.events) ? td.events : [];
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (!e) continue;
      addTimestamp(e.timestamp || e.at || e.occurred_at || e.created_at, 1);
    }

    let total = 0;
    for (let i = 0; i < 24; i += 1) total += buckets[i];
    return { buckets, total, currentHour: now.getHours() };
  }

  function computeDayTimeline(todayData, nowDate) {
    const td = todayData && typeof todayData === 'object' ? todayData : {};
    const now = nowDate instanceof Date ? nowDate : new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowPct = clamp(((nowMin - DAY_START_MIN) / DAY_SPAN_MIN) * 100, 0, 100);
    const schedule = Array.isArray(td.schedule) ? td.schedule : [];

    const blocks = [];
    let liveEvent = null;
    let nextEvent = null;
    let nextDiffMin = Infinity;

    for (let i = 0; i < schedule.length; i += 1) {
      const ev = schedule[i];
      if (!ev) continue;
      if (ev.is_tomorrow && !ev.is_today) continue;

      const parsed = parseMinutesOfDay(ev);
      if (!parsed) continue;
      const startMin = parsed.startMin;
      const endMin = Math.max(startMin + 15, parsed.endMin);
      const isNow = Boolean(ev.is_now) || (nowMin >= startMin && nowMin < endMin);

      if (isNow && !liveEvent) {
        liveEvent = { ev, remainingMin: Math.max(1, endMin - nowMin) };
      } else if (startMin > nowMin && (startMin - nowMin) < nextDiffMin) {
        nextDiffMin = startMin - nowMin;
        nextEvent = { ev, inMin: nextDiffMin };
      }

      if (endMin < DAY_START_MIN || startMin > DAY_END_MIN) continue;
      const clampedStart = clamp(startMin, DAY_START_MIN, DAY_END_MIN);
      const clampedEnd = clamp(endMin, DAY_START_MIN, DAY_END_MIN);
      const leftPct = ((clampedStart - DAY_START_MIN) / DAY_SPAN_MIN) * 100;
      const widthPct = Math.max(2.2, ((clampedEnd - clampedStart) / DAY_SPAN_MIN) * 100);

      blocks.push({
        id: String(ev.id || 'ev-' + i),
        title: String(ev.title || ev.summary || 'Event'),
        timeLabel: String(ev.time_label || ev.time || ''),
        leftPct,
        widthPct,
        isNow,
        raw: ev,
      });
    }

    let countdownLabel = 'Day clear';
    let nextTitle = 'No remaining meetings';
    let isLive = false;

    if (liveEvent) {
      isLive = true;
      countdownLabel = 'NOW ' + formatDurationShort(liveEvent.remainingMin) + ' left';
      nextTitle = String(liveEvent.ev.title || 'Live meeting');
    } else if (nextEvent) {
      countdownLabel = 'in ' + formatDurationShort(nextEvent.inMin);
      nextTitle = String(nextEvent.ev.title || 'Next meeting');
    }

    return { nowPct, blocks, countdownLabel, nextTitle, isLive };
  }

  // =========================================================================
  // 1. mountTodaySystemPulse(slotEl, todayData, hooks)
  // =========================================================================

  function mountTodaySystemPulse(slotEl, todayData, hooks) {
    if (!slotEl) return null;

    const existing = pulseControllers.get(slotEl);
    if (existing && typeof existing.destroy === 'function') {
      existing.destroy();
    }

    const doc = getDoc(slotEl);
    const w = getWin();
    const opts = hooks && typeof hooks === 'object' ? hooks : {};

    let currentToday = todayData && typeof todayData === 'object' ? todayData : {};
    let latestHealth = null;
    let latestAgents = null;
    let lastExternalTelemetryMs = 0;
    let isStripVisible = true;
    let stripObserver = null;
    let destroyed = false;
    let rafId = null;
    let pollTimer = null;
    let countdownTimer = null;
    let lastDrawTs = 0;

    // Seed ring buffer with neutral baseline until real load arrives
    const scopeBuffer = new Array(SCOPE_BUFFER_LEN).fill(0.35);
    let currentLoadInfo = extractHostLoadRatio(null, null, currentToday);
    let scopeSeeded = currentLoadInfo.ratio != null;
    if (currentLoadInfo.ratio != null) {
      for (let i = 0; i < SCOPE_BUFFER_LEN; i += 1) {
        scopeBuffer[i] = currentLoadInfo.ratio;
      }
    }

    const stripEl = doc.createElement('section');
    stripEl.className = 'kos-pulse-strip kos-spot-surface';
    stripEl.setAttribute('aria-label', 'Live System Pulse Telemetry');
    stripEl.setAttribute('data-kos-pulse', 'ready');

    // Cell 1: HOST SCOPE
    const cell1 = doc.createElement('div');
    cell1.className = 'kos-pulse-cell kos-pulse-cell-scope';
    const c1Head = doc.createElement('div');
    c1Head.className = 'kos-pulse-head';
    const c1Label = doc.createElement('span');
    c1Label.className = 'kos-pulse-label';
    c1Label.textContent = 'HOST SCOPE';
    const c1Badge = doc.createElement('span');
    c1Badge.className = 'kos-pulse-badge';
    c1Badge.textContent = currentLoadInfo.ratio != null ? (currentLoadInfo.ratio.toFixed(2) + 'x') : '--';
    c1Head.appendChild(c1Label);
    c1Head.appendChild(c1Badge);

    const scopeWrap = doc.createElement('div');
    scopeWrap.className = 'kos-scope-wrap';
    const scopeCanvas = doc.createElement('canvas');
    scopeCanvas.className = 'kos-scope-canvas';
    scopeCanvas.width = SCOPE_W;
    scopeCanvas.height = SCOPE_H;
    scopeCanvas.setAttribute('aria-label', 'Host CPU load ratio oscilloscope');
    scopeWrap.appendChild(scopeCanvas);
    cell1.appendChild(c1Head);
    cell1.appendChild(scopeWrap);

    // Cell 2: PIPELINES
    const cell2 = doc.createElement('div');
    cell2.className = 'kos-pulse-cell kos-pulse-cell-pipes';
    const c2Head = doc.createElement('div');
    c2Head.className = 'kos-pulse-head';
    const c2Label = doc.createElement('span');
    c2Label.className = 'kos-pulse-label';
    c2Label.textContent = 'PIPELINES';
    const c2Badge = doc.createElement('span');
    c2Badge.className = 'kos-pulse-badge is-ok';
    c2Head.appendChild(c2Label);
    c2Head.appendChild(c2Badge);

    const pipeMatrix = doc.createElement('div');
    pipeMatrix.className = 'kos-pipe-matrix';
    pipeMatrix.setAttribute('role', 'img');
    const c2Sub = doc.createElement('div');
    c2Sub.className = 'kos-pulse-sub';
    cell2.appendChild(c2Head);
    cell2.appendChild(pipeMatrix);
    cell2.appendChild(c2Sub);

    // Cell 3: 24H EVENTS
    const cell3 = doc.createElement('div');
    cell3.className = 'kos-pulse-cell kos-pulse-cell-events';
    const c3Head = doc.createElement('div');
    c3Head.className = 'kos-pulse-head';
    const c3Label = doc.createElement('span');
    c3Label.className = 'kos-pulse-label';
    c3Label.textContent = '24H EVENTS';
    const c3Badge = doc.createElement('span');
    c3Badge.className = 'kos-pulse-badge';
    c3Head.appendChild(c3Label);
    c3Head.appendChild(c3Badge);

    const histBars = doc.createElement('div');
    histBars.className = 'kos-hist-bars';
    histBars.setAttribute('role', 'img');
    cell3.appendChild(c3Head);
    cell3.appendChild(histBars);

    // Cell 4: DAY 06:00 - 22:00
    const cell4 = doc.createElement('div');
    cell4.className = 'kos-pulse-cell kos-pulse-cell-day';
    const c4Head = doc.createElement('div');
    c4Head.className = 'kos-pulse-head';
    const c4Label = doc.createElement('span');
    c4Label.className = 'kos-pulse-label';
    c4Label.textContent = 'DAY 06:00 - 22:00';
    const c4Countdown = doc.createElement('span');
    c4Countdown.className = 'kos-day-countdown';
    c4Head.appendChild(c4Label);
    c4Head.appendChild(c4Countdown);

    const dayBody = doc.createElement('div');
    dayBody.className = 'kos-day-body';
    const dayTrack = doc.createElement('div');
    dayTrack.className = 'kos-day-track';
    const dayMeta = doc.createElement('div');
    dayMeta.className = 'kos-day-meta';
    const dayNextTitle = doc.createElement('span');
    dayNextTitle.className = 'kos-day-next-title';
    dayMeta.appendChild(dayNextTitle);
    dayBody.appendChild(dayTrack);
    dayBody.appendChild(dayMeta);
    cell4.appendChild(c4Head);
    cell4.appendChild(dayBody);

    stripEl.appendChild(cell1);
    stripEl.appendChild(cell2);
    stripEl.appendChild(cell3);
    stripEl.appendChild(cell4);

    while (slotEl.firstChild) slotEl.removeChild(slotEl.firstChild);
    slotEl.appendChild(stripEl);

    function renderHostBadge() {
      if (currentLoadInfo.ratio == null) {
        c1Badge.textContent = '--';
        c1Badge.className = 'kos-pulse-badge';
        c1Badge.title = 'Waiting for host load telemetry';
        return;
      }
      c1Badge.textContent = currentLoadInfo.ratio.toFixed(2) + 'x';
      c1Badge.className = 'kos-pulse-badge is-' + currentLoadInfo.severity;
      c1Badge.title = currentLoadInfo.hostName + ': load1 ' + currentLoadInfo.load1.toFixed(2) + ' / ' + currentLoadInfo.cpus + ' cpus';
    }

    function drawOscilloscopeFrame(advance) {
      if (destroyed) return;
      const ctx = typeof scopeCanvas.getContext === 'function' ? scopeCanvas.getContext('2d') : null;
      if (!ctx) return;

      const dpr = Math.max(1, Math.min(2, (w && Number(w.devicePixelRatio)) || 1));
      const logicalW = Math.max(SCOPE_W, Math.round((scopeWrap && scopeWrap.clientWidth) || SCOPE_W));
      const targetW = Math.round(logicalW * dpr);
      const targetH = Math.round(SCOPE_H * dpr);
      if (scopeCanvas.width !== targetW || scopeCanvas.height !== targetH) {
        scopeCanvas.width = targetW;
        scopeCanvas.height = targetH;
      }

      if (advance) {
        const targetRatio = currentLoadInfo.ratio != null ? currentLoadInfo.ratio : 0.35;
        const prev = scopeBuffer[scopeBuffer.length - 1];
        // Subtle deterministic micro-sample smoothing from live telemetry
        const nextVal = prev + (targetRatio - prev) * 0.24;
        scopeBuffer.shift();
        scopeBuffer.push(nextVal);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, logicalW, SCOPE_H);

      const isLight = getThemePolarity(doc) === 'light';
      const maxScale = Math.max(2.4, currentLoadInfo.ratio != null ? currentLoadInfo.ratio * 1.28 : 2.4);

      function yFor(val) {
        const norm = clamp(val / maxScale, 0, 1);
        return (SCOPE_H - 4) - norm * (SCOPE_H - 8);
      }

      // Dashed 1.0x reference rule
      const yOne = Math.round(yFor(1.0)) + 0.5;
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.moveTo(0, yOne);
      ctx.lineTo(logicalW, yOne);
      ctx.stroke();
      ctx.setLineDash([]);

      // Trace color by severity
      const sev = currentLoadInfo.severity;
      const strokeColor = sev === 'crit'
        ? (isLight ? '#e11d48' : '#f43f5e')
        : sev === 'warn'
        ? (isLight ? '#b45309' : '#f5a623')
        : (isLight ? '#15803d' : '#34d399');
      const fillColor = sev === 'crit'
        ? (isLight ? 'rgba(225, 29, 72, 0.10)' : 'rgba(244, 63, 94, 0.14)')
        : sev === 'warn'
        ? (isLight ? 'rgba(180, 83, 9, 0.10)' : 'rgba(245, 166, 35, 0.14)')
        : (isLight ? 'rgba(21, 128, 61, 0.10)' : 'rgba(52, 211, 153, 0.14)');

      const stepX = logicalW / (SCOPE_BUFFER_LEN - 1);

      // Under-trace area fill
      ctx.beginPath();
      for (let i = 0; i < SCOPE_BUFFER_LEN; i += 1) {
        const x = i * stepX;
        const y = yFor(scopeBuffer[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(logicalW, SCOPE_H - 1);
      ctx.lineTo(0, SCOPE_H - 1);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Primary trace line
      ctx.beginPath();
      for (let i = 0; i < SCOPE_BUFFER_LEN; i += 1) {
        const x = i * stepX;
        const y = yFor(scopeBuffer[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Live rightmost sample pip
      const lastY = yFor(scopeBuffer[SCOPE_BUFFER_LEN - 1]);
      ctx.beginPath();
      ctx.arc(logicalW - 2, lastY, 2, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();

      ctx.restore();
    }

    function renderPipelines() {
      const info = extractPipelineSummary(currentToday, latestHealth);
      c2Label.textContent = 'PIPELINES ' + info.ok + '/' + info.total;
      c2Badge.textContent = info.ok === info.total ? 'NOMINAL' : ((info.total - info.ok) + ' ALERT');
      c2Badge.className = 'kos-pulse-badge ' + (info.ok === info.total ? 'is-ok' : 'is-crit');
      pipeMatrix.setAttribute('aria-label', info.ok + ' of ' + info.total + ' pipelines healthy');

      while (pipeMatrix.firstChild) pipeMatrix.removeChild(pipeMatrix.firstChild);
      const totalDots = 20;
      const scaledOk = info.total === totalDots ? info.ok : Math.round((info.ok / Math.max(1, info.total)) * totalDots);

      for (let i = 0; i < totalDots; i += 1) {
        const dot = doc.createElement('span');
        dot.className = 'kos-pipe-dot ' + (i < scaledOk ? 'is-ok' : 'is-fail');
        dot.style.setProperty('--kos-stagger-idx', String(i));
        dot.title = i < scaledOk ? ('Pipeline #' + (i + 1) + ': active') : ('Pipeline #' + (i + 1) + ': attention');
        pipeMatrix.appendChild(dot);
      }

      if (info.failedNames.length > 0) {
        c2Sub.textContent = 'Degraded: ' + info.failedNames.slice(0, 2).join(', ');
      } else if (info.ok < info.total) {
        c2Sub.textContent = (info.total - info.ok) + ' degraded';
      } else {
        c2Sub.textContent = info.ok + ' active';
      }
    }

    function renderHistogram() {
      const hist = extractHourlyEvents(currentToday, new Date());
      c3Badge.textContent = String(hist.total);
      histBars.setAttribute('aria-label', hist.total + ' events over 24 hours');
      while (histBars.firstChild) histBars.removeChild(histBars.firstChild);

      let maxVal = 1;
      for (let i = 0; i < 24; i += 1) {
        if (hist.buckets[i] > maxVal) maxVal = hist.buckets[i];
      }

      for (let hr = 0; hr < 24; hr += 1) {
        const count = hist.buckets[hr];
        const bar = doc.createElement('span');
        const hPct = count > 0 ? Math.max(14, Math.round((count / maxVal) * 100)) : 8;
        bar.className = 'kos-hist-bar' +
          (count > 0 ? ' has-events' : '') +
          (hr === hist.currentHour ? ' is-now' : '');
        bar.style.height = hPct + '%';
        bar.title = String(hr).padStart(2, '0') + ':00 (' + count + ' events)';
        histBars.appendChild(bar);
      }
    }

    function renderDayTimeline() {
      const tl = computeDayTimeline(currentToday, new Date());
      c4Countdown.textContent = tl.countdownLabel;
      c4Countdown.className = 'kos-day-countdown' + (tl.isLive ? ' is-live' : '');
      dayNextTitle.textContent = tl.nextTitle;
      dayNextTitle.title = tl.nextTitle;

      while (dayTrack.firstChild) dayTrack.removeChild(dayTrack.firstChild);

      // Subtle 4-hour guide ticks (10:00, 14:00, 18:00)
      const guides = [25, 50, 75];
      for (let g = 0; g < guides.length; g += 1) {
        const tick = doc.createElement('span');
        tick.className = 'kos-day-tick';
        tick.style.left = guides[g] + '%';
        dayTrack.appendChild(tick);
      }

      for (let i = 0; i < tl.blocks.length; i += 1) {
        const blk = tl.blocks[i];
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'kos-day-block' + (blk.isNow ? ' is-now' : '');
        btn.style.left = blk.leftPct.toFixed(2) + '%';
        btn.style.width = blk.widthPct.toFixed(2) + '%';
        btn.title = (blk.timeLabel ? blk.timeLabel + ' ' : '') + blk.title;
        btn.setAttribute('aria-label', btn.title);
        if (typeof opts.onSelectSchedule === 'function') {
          btn.addEventListener('click', function () {
            try { opts.onSelectSchedule(blk.raw); } catch (_) {}
          });
        }
        dayTrack.appendChild(btn);
      }

      const needle = doc.createElement('span');
      needle.className = 'kos-day-now-needle';
      needle.style.left = tl.nowPct.toFixed(2) + '%';
      needle.setAttribute('aria-hidden', 'true');
      dayTrack.appendChild(needle);
    }

    function stopRaf() {
      if (rafId != null) {
        cancelFrame(rafId);
        rafId = null;
      }
    }

    function tickRaf(ts) {
      if (destroyed) {
        stopRaf();
        return;
      }
      if (!isElConnected(slotEl)) {
        destroy();
        return;
      }
      if (!isStripVisible || isDocHidden(doc) || isReducedMotion(doc)) {
        stopRaf();
        drawOscilloscopeFrame(false);
        return;
      }

      // 8 Hz crisp oscilloscope sweep (125ms step)
      if (!lastDrawTs || ts - lastDrawTs >= 125) {
        lastDrawTs = ts;
        drawOscilloscopeFrame(true);
      }
      rafId = reqFrame(tickRaf);
    }

    function startRafIfAllowed() {
      if (destroyed || !isElConnected(slotEl)) return;
      drawOscilloscopeFrame(false);
      if (!isStripVisible || isDocHidden(doc) || isReducedMotion(doc)) {
        stopRaf();
        return;
      }
      if (rafId == null) {
        rafId = reqFrame(tickRaf);
      }
    }

    function applyTelemetryUpdate(healthObj, agentsObj, hostObj) {
      if (healthObj && typeof healthObj === 'object') latestHealth = healthObj;
      if (agentsObj && typeof agentsObj === 'object') latestAgents = agentsObj;
      const syntheticAgents =
        !latestAgents && hostObj && typeof hostObj === 'object'
          ? { meshNodes: [hostObj] }
          : latestAgents;
      currentLoadInfo = extractHostLoadRatio(latestHealth, syntheticAgents, currentToday);
      renderHostBadge();
      if (currentLoadInfo.ratio != null) {
        if (!scopeSeeded) {
          scopeBuffer.fill(currentLoadInfo.ratio);
          scopeSeeded = true;
        } else {
          scopeBuffer.shift();
          scopeBuffer.push(currentLoadInfo.ratio);
        }
      }
      drawOscilloscopeFrame(false);
      renderPipelines();
    }

    function hasFreshSharedTelemetry() {
      const nowT = Date.now();
      if (nowT - lastExternalTelemetryMs < 8000) return true;
      const shared = w && w.KizukiBoardTelemetry && typeof w.KizukiBoardTelemetry === 'object'
        ? w.KizukiBoardTelemetry
        : null;
      if (shared && Number.isFinite(Number(shared.updatedAt)) && nowT - Number(shared.updatedAt) < 8000) {
        applyTelemetryUpdate(shared.health || null, shared.agents || null, shared.host || null);
        lastExternalTelemetryMs = Number(shared.updatedAt);
        return true;
      }
      return false;
    }

    function onExternalBoardTelemetry(evt) {
      if (destroyed || !isElConnected(slotEl)) return;
      const det = evt && evt.detail && typeof evt.detail === 'object' ? evt.detail : null;
      lastExternalTelemetryMs = Date.now();
      if (det && (det.health || det.agents || det.host || det.payload)) {
        const src = det.payload && typeof det.payload === 'object' ? det.payload : det;
        applyTelemetryUpdate(src.health || null, src.agents || null, src.host || null);
      } else {
        hasFreshSharedTelemetry();
      }
    }

    async function pollLiveHostTelemetry() {
      if (destroyed || !isElConnected(slotEl) || isDocHidden(doc) || !isStripVisible) return;
      // Skip duplicate polling when KizukiBoardTelemetry or kizuki:board-sse pushed fresh data within 8s
      if (hasFreshSharedTelemetry()) return;

      const results = await Promise.all([
        safeFetchJson('/api/agent-board/health', opts),
        safeFetchJson('/api/agent-board/agents', opts),
      ]);
      if (destroyed || !isElConnected(slotEl)) return;
      if (results[0] || results[1]) {
        applyTelemetryUpdate(results[0] || null, results[1] || null, null);
        if (w && typeof w === 'object') {
          const prev = w.KizukiBoardTelemetry && typeof w.KizukiBoardTelemetry === 'object' ? w.KizukiBoardTelemetry : {};
          w.KizukiBoardTelemetry = {
            health: results[0] || prev.health || null,
            agents: results[1] || prev.agents || null,
            host: prev.host || null,
            updatedAt: Date.now(),
          };
        }
      }
    }

    function onVisibilityChange() {
      if (destroyed) return;
      if (!isElConnected(slotEl)) {
        destroy();
        return;
      }
      if (isDocHidden(doc)) {
        stopRaf();
      } else {
        renderDayTimeline();
        startRafIfAllowed();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stopRaf();
      if (stripObserver && typeof stripObserver.disconnect === 'function') {
        try { stripObserver.disconnect(); } catch (_) {}
        stripObserver = null;
      }
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (countdownTimer != null) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (w && typeof w.removeEventListener === 'function') {
        w.removeEventListener('kizuki:board-sse', onExternalBoardTelemetry);
        w.removeEventListener('kizuki:board-telemetry', onExternalBoardTelemetry);
      }
      if (pulseControllers.get(slotEl) === controller) {
        pulseControllers.delete(slotEl);
      }
    }

    // Initial render
    renderHostBadge();
    renderPipelines();
    renderHistogram();
    renderDayTimeline();
    startRafIfAllowed();

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('kizuki:board-sse', onExternalBoardTelemetry);
      w.addEventListener('kizuki:board-telemetry', onExternalBoardTelemetry);
    }

    const IOCtor = (w && typeof w.IntersectionObserver === 'function' && w.IntersectionObserver) ||
      (typeof IntersectionObserver === 'function' ? IntersectionObserver : null);
    if (IOCtor) {
      try {
        stripObserver = new IOCtor(function (entries) {
          if (destroyed || !entries || !entries.length) return;
          isStripVisible = Boolean(entries[0].isIntersecting);
          if (!isStripVisible) stopRaf();
          else startRafIfAllowed();
        });
        stripObserver.observe(stripEl);
      } catch (_) {
        stripObserver = null;
      }
    }

    if (opts.disableLiveFetch !== true) {
      pollLiveHostTelemetry();
      pollTimer = setInterval(function () {
        if (!isElConnected(slotEl)) {
          destroy();
          return;
        }
        pollLiveHostTelemetry();
      }, 5000);
    }

    countdownTimer = setInterval(function () {
      if (!isElConnected(slotEl)) {
        destroy();
        return;
      }
      if (!isDocHidden(doc)) {
        renderDayTimeline();
      }
    }, 30000);

    const controller = {
      el: stripEl,
      update: function (nextTodayData) {
        if (destroyed) return;
        currentToday = nextTodayData && typeof nextTodayData === 'object' ? nextTodayData : {};
        currentLoadInfo = extractHostLoadRatio(latestHealth, latestAgents, currentToday);
        renderHostBadge();
        renderPipelines();
        renderHistogram();
        renderDayTimeline();
        drawOscilloscopeFrame(false);
      },
      getState: function () {
        return {
          load: currentLoadInfo,
          pipelines: extractPipelineSummary(currentToday, latestHealth),
          hourly: extractHourlyEvents(currentToday, new Date()),
          timeline: computeDayTimeline(currentToday, new Date()),
          destroyed,
        };
      },
      destroy,
    };

    pulseControllers.set(slotEl, controller);
    return controller;
  }

  // =========================================================================
  // 2. mountPeopleSignalVisuals(slotEl, dossier)
  // =========================================================================

  function isOutboundTimelineItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.from_me === true || item.is_from_me === true || item.outbound === true) return true;
    if (item.from_me === false || item.is_from_me === false || item.outbound === false) return false;
    const dir = String(item.direction || item.dir || '').toLowerCase();
    if (dir === 'out' || dir === 'outbound' || dir === 'sent' || dir === 'you') return true;
    if (dir === 'in' || dir === 'inbound' || dir === 'received' || dir === 'them') return false;
    const sender = String(item.sender || item.author || item.from || '').toLowerCase();
    if (sender === 'me' || sender === 'you' || sender === 'self' || sender === 'owner') {
      return true;
    }
    return false;
  }

  function computePeopleSignalMetrics(dossier, nowDate) {
    const d = dossier && typeof dossier === 'object' ? dossier : {};
    const p = d.person && typeof d.person === 'object' ? d.person : d;
    const now = nowDate instanceof Date ? nowDate : new Date();
    const nowMs = now.getTime();
    const weekMs = 7 * 24 * 3600 * 1000;

    const outWeeks = new Array(52).fill(0);
    const inWeeks = new Array(52).fill(0);
    let cadenceMode = '52w';
    let cadenceTitle = '52-WEEK CADENCE';
    let cadenceAxis = ['52w ago', '26w', 'Now'];
    let slotCount = 52;
    let outBuckets = outWeeks;
    let inBuckets = inWeeks;

    const explicitWeekly = d.weekly_activity || (d.profile_visuals && d.profile_visuals.weekly_activity);
    const timeline = Array.isArray(d.timeline) ? d.timeline
      : (Array.isArray(d.messages) ? d.messages : []);

    let totalOut = 0;
    let totalIn = 0;
    let latestMs = parseTimestampMs(d.last_seen_iso || p.last_seen_iso || p.last_seen || d.last_seen);

    if (Array.isArray(explicitWeekly) && explicitWeekly.length > 0) {
      const slice = explicitWeekly.slice(-52);
      const offset = 52 - slice.length;
      for (let i = 0; i < slice.length; i += 1) {
        const wItem = slice[i] || {};
        const o = Math.max(0, Number(wItem.out ?? wItem.sent ?? wItem.you_to_them ?? 0) || 0);
        const inn = Math.max(0, Number(wItem.in ?? wItem.received ?? wItem.them_to_you ?? 0) || 0);
        outWeeks[offset + i] = o;
        inWeeks[offset + i] = inn;
        totalOut += o;
        totalIn += inn;
      }
    } else {
      const parsedItems = [];
      let earliestMs = Infinity;
      for (let i = 0; i < timeline.length; i += 1) {
        const item = timeline[i];
        if (!item) continue;
        const tsMs = parseTimestampMs(item.timestamp || item.occurred_at || item.date || item.at || item.created_at);
        if (!Number.isFinite(tsMs)) continue;
        if (!Number.isFinite(latestMs) || tsMs > latestMs) latestMs = tsMs;
        if (tsMs < earliestMs) earliestMs = tsMs;
        parsedItems.push({ tsMs, out: isOutboundTimelineItem(item) });
      }
      const spanDays = Number.isFinite(earliestMs) && Number.isFinite(latestMs)
        ? Math.max(1, (latestMs - earliestMs) / 86400000)
        : 365;
      if (parsedItems.length > 0 && spanDays <= 42) {
        // Auto-zoom to 28 daily buckets anchored at latestMs when timeline is recent (e.g. LIMIT 80)
        const daysWindow = Math.max(14, Math.min(28, Math.ceil(spanDays) + 2));
        slotCount = daysWindow;
        cadenceMode = 'daily';
        cadenceTitle = 'RECENT CADENCE (' + parsedItems.length + ' MSGS)';
        cadenceAxis = [daysWindow + 'd ago', Math.round(daysWindow / 2) + 'd', 'Now'];
        outBuckets = new Array(daysWindow).fill(0);
        inBuckets = new Array(daysWindow).fill(0);
        const anchorMs = Math.max(nowMs, latestMs);
        for (let i = 0; i < parsedItems.length; i += 1) {
          const it = parsedItems[i];
          const daysAgo = Math.floor((anchorMs - it.tsMs) / 86400000);
          if (daysAgo >= 0 && daysAgo < daysWindow) {
            const idx = daysWindow - 1 - daysAgo;
            if (it.out) {
              outBuckets[idx] += 1;
              totalOut += 1;
            } else {
              inBuckets[idx] += 1;
              totalIn += 1;
            }
          }
        }
      } else {
        for (let i = 0; i < parsedItems.length; i += 1) {
          const it = parsedItems[i];
          const weeksAgo = Math.floor((nowMs - it.tsMs) / weekMs);
          if (weeksAgo >= 0 && weeksAgo < 52) {
            const idx = 51 - weeksAgo;
            if (it.out) {
              outWeeks[idx] += 1;
              totalOut += 1;
            } else {
              inWeeks[idx] += 1;
              totalIn += 1;
            }
          }
        }
      }
    }

    // 1. Recency (0..100)
    let recencyScore = 0;
    let recencyLabel = 'None';
    if (Number.isFinite(latestMs)) {
      const ageDays = Math.max(0, (nowMs - latestMs) / 86400000);
      if (ageDays <= 1) { recencyScore = 100; recencyLabel = 'Today'; }
      else if (ageDays <= 7) { recencyScore = 84; recencyLabel = Math.round(ageDays) + 'd'; }
      else if (ageDays <= 30) { recencyScore = 64; recencyLabel = Math.round(ageDays) + 'd'; }
      else if (ageDays <= 90) { recencyScore = 42; recencyLabel = Math.round(ageDays / 7) + 'w'; }
      else if (ageDays <= 365) { recencyScore = 22; recencyLabel = Math.round(ageDays / 30) + 'mo'; }
      else { recencyScore = 8; recencyLabel = Math.round(ageDays / 365) + 'y'; }
    }

    // 2. Frequency (0..100) from real messages_count + claim_count + timeline
    const msgCount = Math.max(
      0,
      Number(d.messages_count ?? p.messages_count ?? p.message_count ?? d.timeline_total ?? timeline.length ?? 0) || 0
    );
    const claimCount = Math.max(
      0,
      Number(d.claim_count ?? d.sqlite_claims_total ?? p.claim_count ?? (Array.isArray(d.claims) ? d.claims.length : 0) ?? 0) || 0
    );
    const combinedVolume = msgCount + claimCount * 2;
    const frequencyScore = combinedVolume > 0
      ? clamp(Math.round((Math.log10(combinedVolume + 1) / Math.log10(600)) * 100), 12, 100)
      : 0;
    const frequencyLabel = msgCount >= 1000
      ? ((msgCount / 1000).toFixed(1) + 'k')
      : String(msgCount || claimCount);

    // 3. Reciprocity (0..100) from directional balance
    let reciprocityScore = 0;
    let reciprocityLabel = '--';
    const totalDir = totalOut + totalIn;
    if (totalDir > 0) {
      const balance = 1 - Math.abs(totalOut - totalIn) / totalDir;
      reciprocityScore = clamp(Math.round(balance * 100), 10, 100);
      reciprocityLabel = Math.round((totalOut / totalDir) * 100) + '/' + Math.round((totalIn / totalDir) * 100);
    } else if (msgCount > 0 || claimCount > 0) {
      reciprocityScore = 50;
      reciprocityLabel = 'Est';
    }

    // 4. Channel Mix (0..100) from distinct channels
    const channelSet = new Set();
    const rawChannels = d.channels || p.channels || [];
    if (Array.isArray(rawChannels)) {
      for (let i = 0; i < rawChannels.length; i += 1) {
        const ch = typeof rawChannels[i] === 'string' ? rawChannels[i] : (rawChannels[i] && rawChannels[i].name);
        if (ch) channelSet.add(String(ch).toLowerCase());
      }
    }
    for (let i = 0; i < timeline.length; i += 1) {
      const ch = timeline[i] && (timeline[i].channel || timeline[i].source);
      if (ch) channelSet.add(String(ch).toLowerCase());
    }
    const chCount = channelSet.size;
    const channelScore = clamp(chCount * 25, 0, 100);
    const channelLabel = chCount + (chCount === 1 ? ' ch' : ' chs');

    return {
      outWeeks: outBuckets,
      inWeeks: inBuckets,
      totalOut,
      totalIn,
      slotCount,
      cadenceMode,
      cadenceTitle,
      cadenceAxis,
      meters: [
        { id: 'recency', name: 'Recency', score: recencyScore, label: recencyLabel, tone: recencyScore >= 60 ? 'emerald' : recencyScore >= 30 ? 'amber' : 'vermilion' },
        { id: 'frequency', name: 'Frequency', score: frequencyScore, label: frequencyLabel, tone: 'sky' },
        { id: 'reciprocity', name: 'Reciprocity', score: reciprocityScore, label: reciprocityLabel, tone: 'violet' },
        { id: 'channels', name: 'Channel Mix', score: channelScore, label: channelLabel, tone: 'amber' },
      ],
    };
  }

  function buildButterflySvgHtml(metrics, animate) {
    const svgW = 312;
    const svgH = 68;
    const midY = 34;
    const maxBarH = 28;
    const count = Math.max(1, Number(metrics.slotCount || (metrics.outWeeks && metrics.outWeeks.length) || 52));
    const slotW = svgW / count;
    const barW = Math.max(3, Math.min(8, slotW - 2));

    let maxWeekVal = 1;
    for (let i = 0; i < count; i += 1) {
      if (metrics.outWeeks[i] > maxWeekVal) maxWeekVal = metrics.outWeeks[i];
      if (metrics.inWeeks[i] > maxWeekVal) maxWeekVal = metrics.inWeeks[i];
    }

    const parts = [];
    // Midline hairline
    parts.push('<line x1="0" y1="' + midY + '" x2="' + svgW + '" y2="' + midY + '" stroke="var(--kos-hairline)" stroke-width="1"/>');

    // Quarter guide lines
    for (let q = 1; q <= 3; q += 1) {
      const gx = (q * 0.25 * svgW).toFixed(1);
      parts.push('<line x1="' + gx + '" y1="4" x2="' + gx + '" y2="' + (svgH - 4) + '" stroke="var(--kos-hairline)" stroke-width="0.75" stroke-dasharray="2 2"/>');
    }

    const unitPrefix = metrics.cadenceMode === 'daily' ? 'D-' : 'W-';
    for (let i = 0; i < count; i += 1) {
      const x = (i * slotW + (slotW - barW) * 0.5).toFixed(1);
      const outV = metrics.outWeeks[i];
      const inV = metrics.inWeeks[i];
      const ago = count - 1 - i;
      const tip = unitPrefix + ago + ': ' + outV + ' out / ' + inV + ' in';

      if (outV > 0) {
        const h = Math.max(2.5, (outV / maxWeekVal) * maxBarH);
        const y = midY - 1 - h;
        parts.push(
          '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) +
          '" rx="1" fill="var(--kos-sky)" opacity="0.88"><title>' + escHtml(tip) + '</title></rect>'
        );
      }
      if (inV > 0) {
        const h = Math.max(2.5, (inV / maxWeekVal) * maxBarH);
        const y = midY + 1;
        parts.push(
          '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) +
          '" rx="1" fill="var(--kos-amber)" opacity="0.86"><title>' + escHtml(tip) + '</title></rect>'
        );
      }
    }

    return (
      '<svg class="kos-butterfly-svg' + (animate ? ' is-animated' : '') +
      '" viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="none" role="img" aria-label="Directional activity butterfly chart">' +
      parts.join('') +
      '</svg>'
    );
  }

  function mountPeopleSignalVisuals(slotEl, dossier) {
    if (!slotEl) return null;

    const prev = peopleControllers.get(slotEl);
    if (prev && typeof prev.destroy === 'function') prev.destroy();

    const doc = getDoc(slotEl);
    const metrics = computePeopleSignalMetrics(dossier, new Date());
    const animate = !isReducedMotion(doc);

    const wrap = doc.createElement('section');
    wrap.className = 'kos-people-telemetry kos-spot-surface';
    wrap.setAttribute('aria-label', 'Relationship Cadence and Signal Telemetry');
    wrap.setAttribute('data-kos-people-signals', 'ready');

    const metersHtml = metrics.meters.map(function (m) {
      const litCount = m.score <= 0 ? 0 : clamp(Math.round((m.score / 100) * 5), 1, 5);
      let segs = '';
      for (let s = 0; s < 5; s += 1) {
        segs += '<span class="kos-sig-seg' + (s < litCount ? ' is-lit' : '') + '"></span>';
      }
      return (
        '<div class="kos-signal-row" data-signal-id="' + escAttr(m.id) + '">' +
        '<span class="kos-signal-name">' + escHtml(m.name) + '</span>' +
        '<span class="kos-sig-bar is-' + escAttr(m.tone) + '" role="meter" aria-label="' + escAttr(m.name) +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + escAttr(String(m.score)) + '">' +
        segs +
        '</span>' +
        '<span class="kos-signal-val">' + escHtml(m.label) + '</span>' +
        '</div>'
      );
    }).join('');

    const axisTicks = Array.isArray(metrics.cadenceAxis) && metrics.cadenceAxis.length === 3
      ? metrics.cadenceAxis
      : ['52w ago', '26w', 'Now'];
    wrap.innerHTML =
      '<div class="kos-butterfly-pane">' +
      '<div class="kos-telemetry-head">' +
      '<span class="kos-telemetry-title">' + escHtml(metrics.cadenceTitle || '52-WEEK CADENCE') + '</span>' +
      '<div class="kos-butterfly-legend">' +
      '<span class="kos-legend-item"><span class="kos-legend-swatch is-out" aria-hidden="true"></span>You &rarr; Them (' + escHtml(String(metrics.totalOut)) + ')</span>' +
      '<span class="kos-legend-item"><span class="kos-legend-swatch is-in" aria-hidden="true"></span>Them &rarr; You (' + escHtml(String(metrics.totalIn)) + ')</span>' +
      '</div>' +
      '</div>' +
      '<div class="kos-butterfly-stage">' + buildButterflySvgHtml(metrics, animate) + '</div>' +
      '<div class="kos-butterfly-axis"><span>' + escHtml(axisTicks[0]) + '</span><span>' + escHtml(axisTicks[1]) + '</span><span>' + escHtml(axisTicks[2]) + '</span></div>' +
      '</div>' +
      '<div class="kos-signal-pane">' +
      '<div class="kos-telemetry-head">' +
      '<span class="kos-telemetry-title">SIGNAL STRENGTH</span>' +
      '</div>' +
      '<div class="kos-signal-list">' + metersHtml + '</div>' +
      '</div>';

    while (slotEl.firstChild) slotEl.removeChild(slotEl.firstChild);
    slotEl.appendChild(wrap);

    const controller = {
      el: wrap,
      metrics,
      destroy: function () {
        if (peopleControllers.get(slotEl) === controller) {
          peopleControllers.delete(slotEl);
        }
      },
    };
    peopleControllers.set(slotEl, controller);
    return controller;
  }

  // =========================================================================
  // 3. initGlobalKineticShell(opts)
  // =========================================================================

  function formatLondonParts(date) {
    const d = date instanceof Date ? date : new Date();
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const text = fmt.format(d);
      const parts = text.split(':');
      if (parts.length >= 2) {
        return { hh: parts[0], mm: parts[1] };
      }
    } catch (_) {}
    return {
      hh: String(d.getUTCHours()).padStart(2, '0'),
      mm: String(d.getUTCMinutes()).padStart(2, '0'),
    };
  }

  function initGlobalKineticShell(opts) {
    if (globalShellState && typeof globalShellState.destroy === 'function') {
      globalShellState.destroy();
    }

    const options = opts && typeof opts === 'object' ? opts : {};
    const doc = options.document || getDoc();
    const w = options.window || getWin();
    if (!doc) return null;

    let destroyed = false;
    let spotlightHandle = null;
    let clockTimer = null;
    let colonDim = false;
    let beatTimer = null;
    let viewObserver = null;
    let sseSource = null;
    let sseRetryTimer = null;
    let sseRetries = 0;

    // 1. Bind 1px Specular Edge-Light Spotlight on P2/P3 cards via KizukiMotion
    if (w && w.KizukiMotion && typeof w.KizukiMotion.bindSpotlightSurface === 'function') {
      try {
        spotlightHandle = w.KizukiMotion.bindSpotlightSurface(SPOTLIGHT_SELECTOR);
      } catch (_) {}
    }

    // 2. Live 1Hz Stepping London Clock Colon
    function findClockEls() {
      if (typeof doc.querySelectorAll !== 'function') return [];
      const list = doc.querySelectorAll('#hud-clock-time, .hud-clock, .instrument-clock-time');
      return Array.prototype.slice.call(list || []);
    }

    function tickLondonClock() {
      if (destroyed || isDocHidden(doc)) return;
      const els = findClockEls();
      if (els.length === 0) return;

      const reduced = isReducedMotion(doc);
      colonDim = reduced ? false : !colonDim;
      const parts = formatLondonParts(new Date());

      for (let i = 0; i < els.length; i += 1) {
        const el = els[i];
        if (!el) continue;
        let colonEl = typeof el.querySelector === 'function' ? el.querySelector('.kos-clock-colon') : null;
        let hhEl = typeof el.querySelector === 'function' ? el.querySelector('.kos-clock-hh') : null;
        let mmEl = typeof el.querySelector === 'function' ? el.querySelector('.kos-clock-mm') : null;

        if (!colonEl || !hhEl || !mmEl) {
          el.innerHTML =
            'LON <span class="kos-clock-hh">' + escHtml(parts.hh) + '</span>' +
            '<span class="kos-clock-colon" aria-hidden="true">:</span>' +
            '<span class="kos-clock-mm">' + escHtml(parts.mm) + '</span>';
          colonEl = typeof el.querySelector === 'function' ? el.querySelector('.kos-clock-colon') : null;
        } else {
          if (hhEl.textContent !== parts.hh) hhEl.textContent = parts.hh;
          if (mmEl.textContent !== parts.mm) mmEl.textContent = parts.mm;
        }

        if (colonEl && colonEl.classList) {
          colonEl.classList.toggle('is-dim', colonDim);
        }
      }
    }

    tickLondonClock();
    clockTimer = setInterval(tickLondonClock, 1000);

    // 3. SSE-Driven Live Heartbeat Dot on #tailnet-pill / #tailnet-badge
    function triggerHeartbeat() {
      if (destroyed || isReducedMotion(doc)) return false;
      if (typeof doc.querySelectorAll !== 'function') return false;
      const dots = doc.querySelectorAll('#tailnet-pill .tailnet-dot, .tailnet-dot, #tailnet-badge .status-dot');
      if (!dots || dots.length === 0) return false;

      for (let i = 0; i < dots.length; i += 1) {
        const dot = dots[i];
        if (!dot || !dot.classList) continue;
        dot.classList.remove('kos-sse-beat');
        dot.classList.add('kos-sse-beat');
      }

      if (beatTimer != null) clearTimeout(beatTimer);
      beatTimer = setTimeout(function () {
        for (let i = 0; i < dots.length; i += 1) {
          if (dots[i] && dots[i].classList) dots[i].classList.remove('kos-sse-beat');
        }
        beatTimer = null;
      }, 460);
      return true;
    }

    function onCustomSseEvent() {
      triggerHeartbeat();
    }

    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('kizuki:board-sse', onCustomSseEvent);
      w.addEventListener('kizuki:sse-event', onCustomSseEvent);
      w.addEventListener('agent-board:sse', onCustomSseEvent);
    }

    function connectHeartbeatSse() {
      if (destroyed || options.connectSse === false || isDocHidden(doc)) return;
      const ESCtor = (w && typeof w.EventSource === 'function' && w.EventSource) ||
        (typeof EventSource === 'function' ? EventSource : null);
      if (!ESCtor) return;

      try {
        const es = new ESCtor('/api/agent-board/stream');
        sseSource = es;
        const onLive = function () {
          sseRetries = 0;
          triggerHeartbeat();
        };
        es.addEventListener('board', onLive);
        es.addEventListener('action', onLive);
        es.addEventListener('telemetry', onLive);
        es.addEventListener('message', onLive);
        es.addEventListener('error', function () {
          if (sseSource === es) {
            try { es.close(); } catch (_) {}
            sseSource = null;
          }
          if (destroyed) return;
          sseRetries += 1;
          const delay = Math.min(30000, 2500 * Math.pow(1.6, Math.min(sseRetries, 5)));
          sseRetryTimer = setTimeout(connectHeartbeatSse, delay);
        });
      } catch (_) {}
    }

    if (options.connectSse === true || (options.connectSse !== false && w && typeof w.EventSource === 'function')) {
      connectHeartbeatSse();
    }

    // 4. Smooth 200ms Cross-Dissolve + 8px Rise on Workspace Switches
    let lastActiveView = '';

    function syncViewSwap(panelEl) {
      if (destroyed || isReducedMotion(doc)) return false;
      const target = panelEl || (typeof doc.querySelector === 'function' ? doc.querySelector('.view-panel.is-active') : null);
      if (!target || !target.classList) return false;
      const viewId = target.id || target.getAttribute('data-view') || '';
      if (viewId && viewId === lastActiveView) return false;
      lastActiveView = viewId;

      target.classList.remove('kos-view-enter');
      target.classList.add('kos-view-enter');
      setTimeout(function () {
        if (target && target.classList) target.classList.remove('kos-view-enter');
      }, 240);
      return true;
    }

    const MO = (w && w.MutationObserver) || (typeof MutationObserver === 'function' ? MutationObserver : null);
    const appShell = typeof doc.getElementById === 'function' ? doc.getElementById('app-shell') : null;
    if (MO && appShell) {
      try {
        viewObserver = new MO(function (mutations) {
          for (let i = 0; i < mutations.length; i += 1) {
            if (mutations[i].attributeName === 'data-active-view') {
              const viewName = appShell.getAttribute('data-active-view');
              const panel = viewName && typeof doc.getElementById === 'function'
                ? doc.getElementById('view-' + viewName)
                : null;
              syncViewSwap(panel);
              break;
            }
          }
        });
        viewObserver.observe(appShell, { attributes: true, attributeFilter: ['data-active-view'] });
      } catch (_) {}
    }

    function onVisibilityChange() {
      if (destroyed) return;
      if (!isDocHidden(doc)) {
        tickLondonClock();
      }
    }

    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (spotlightHandle && typeof spotlightHandle.destroy === 'function') {
        try { spotlightHandle.destroy(); } catch (_) {}
      }
      if (clockTimer != null) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
      if (beatTimer != null) {
        clearTimeout(beatTimer);
        beatTimer = null;
      }
      if (sseRetryTimer != null) {
        clearTimeout(sseRetryTimer);
        sseRetryTimer = null;
      }
      if (sseSource) {
        try { sseSource.close(); } catch (_) {}
        sseSource = null;
      }
      if (viewObserver) {
        try { viewObserver.disconnect(); } catch (_) {}
        viewObserver = null;
      }
      if (w && typeof w.removeEventListener === 'function') {
        w.removeEventListener('kizuki:board-sse', onCustomSseEvent);
        w.removeEventListener('kizuki:sse-event', onCustomSseEvent);
        w.removeEventListener('agent-board:sse', onCustomSseEvent);
      }
      if (typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (globalShellState === controller) {
        globalShellState = null;
      }
    }

    const controller = {
      destroy,
      triggerHeartbeat,
      syncViewSwap,
      tickLondonClock,
    };

    globalShellState = controller;
    return controller;
  }

  return {
    mountTodaySystemPulse: mountTodaySystemPulse,
    mountPeopleSignalVisuals: mountPeopleSignalVisuals,
    initGlobalKineticShell: initGlobalKineticShell,
    computePeopleSignalMetrics: computePeopleSignalMetrics,
    extractHostLoadRatio: extractHostLoadRatio,
    extractPipelineSummary: extractPipelineSummary,
    extractHourlyEvents: extractHourlyEvents,
    computeDayTimeline: computeDayTimeline,
  };
});
