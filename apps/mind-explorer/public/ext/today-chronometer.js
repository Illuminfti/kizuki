/* ==========================================================================
   KIZUKI MIND OS - TODAY SOLAR CHRONOMETER & LIVE DAY-ARC INSTRUMENT
   The Protagonist: recessed 52px machined 24h circadian horizon track with
   Vernier hour ticks, clickable solar event capsules, sweeping glowing
   vermilion NOW jewel needle, live London quartz readout, and inline 20-LED
   pipeline micro-bar.
   Auto-mounts beneath .brief-hero / above [data-slot="today-radar"].
   Full ?detail=off subtraction proof (0px layout shift) & reduced-motion.
   Zero em-dashes | Zero outbound sending | Local read-only telemetry.
   ========================================================================== */
(function initTodayChronometer(root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const MINUTES_IN_DAY = 1440;
  const LONDON_TZ = 'Europe/London';
  const REFRESH_INTERVAL_MS = 60000;
  const TICK_INTERVAL_MS = 1000;
  const MAJOR_HOURS = [6, 9, 12, 15, 18, 21];

  const state = {
    hostEl: null,
    today: null,
    health: null,
    events: [],
    hoveredId: null,
    fetching: false,
    lastFetchAt: 0,
    tickTimer: null,
    refreshTimer: null,
    observer: null,
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

  function triggerTactile(kind) {
    try {
      if (root && root.KizukiTactile && typeof root.KizukiTactile.clickDetent === 'function') {
        root.KizukiTactile.clickDetent(kind || 'tick');
        return;
      }
      if (root && root.KizukiSound && typeof root.KizukiSound.click === 'function') {
        root.KizukiSound.click();
      }
    } catch {
      // Tactile audio is strictly optional.
    }
  }

  function prefersReducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function getLondonClock(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date();
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: LONDON_TZ,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      const parts = fmt.formatToParts(d);
      let hh = 0;
      let mm = 0;
      let ss = 0;
      for (let i = 0; i < parts.length; i += 1) {
        const p = parts[i];
        if (p.type === 'hour') hh = parseInt(p.value, 10) || 0;
        else if (p.type === 'minute') mm = parseInt(p.value, 10) || 0;
        else if (p.type === 'second') ss = parseInt(p.value, 10) || 0;
      }
      if (hh === 24) hh = 0;
      return {
        hh,
        mm,
        ss,
        minutesOfDay: hh * 60 + mm + ss / 60,
        formatted: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
      };
    } catch {
      const hh = d.getUTCHours();
      const mm = d.getUTCMinutes();
      const ss = d.getUTCSeconds();
      return {
        hh,
        mm,
        ss,
        minutesOfDay: hh * 60 + mm + ss / 60,
        formatted: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
      };
    }
  }

  function isoToLondonMinutes(isoStr) {
    if (!isoStr) return null;
    const ms = Date.parse(isoStr);
    if (!Number.isFinite(ms)) return null;
    const clk = getLondonClock(new Date(ms));
    return {
      minutes: clk.hh * 60 + clk.mm,
      hhmm: `${String(clk.hh).padStart(2, '0')}:${String(clk.mm).padStart(2, '0')}`,
      ms,
    };
  }

  function formatDurationCompact(deltaMinutes) {
    const mins = Math.max(0, Math.round(deltaMinutes));
    if (mins < 1) return 'now';
    if (mins < 60) return `in ${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }

  function normalizeEventKey(title) {
    return stripEmDash(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function classifyEventTone(ev) {
    const title = String(ev.title || '').toLowerCase();
    const cal = String(ev.calendar || '').toLowerCase();
    const participants = Array.isArray(ev.participants) ? ev.participants.length : 0;
    if (ev.is_now) return 'is-now';
    if (/\b(school|pick\s*up|family|kids|dinner|home)\b/.test(title)) return 'is-family';
    if (ev.meet_url || participants >= 2) return 'is-sync';
    if (cal.includes('work') || cal.includes('company')) return 'is-work';
    return 'is-default';
  }

  function buildSolarEvents(schedule) {
    if (!Array.isArray(schedule)) return [];
    const todayItems = schedule.filter((ev) => ev && ev.is_today);
    const parsed = [];

    for (let i = 0; i < todayItems.length; i += 1) {
      const ev = todayItems[i];
      const startInfo = isoToLondonMinutes(ev.start);
      if (!startInfo) continue;
      const endInfo = isoToLondonMinutes(ev.end);
      const startMin = startInfo.minutes;
      let endMin = endInfo ? endInfo.minutes : startMin + 45;
      if (endMin <= startMin) {
        endMin = Math.min(MINUTES_IN_DAY, startMin + 45);
      }
      const durationMin = Math.max(20, Math.min(MINUTES_IN_DAY - startMin, endMin - startMin));
      const normTitle = normalizeEventKey(ev.title);

      // Deduplicate twin mirrored calendar entries (same title overlapping in time)
      const existing = parsed.find(
        (p) =>
          p.normTitle === normTitle &&
          Math.abs(p.startMin - startMin) <= 45 &&
          p.startMin <= endMin &&
          startMin <= p.endMin,
      );
      if (existing) {
        existing.startMin = Math.min(existing.startMin, startMin);
        existing.endMin = Math.max(existing.endMin, startMin + durationMin);
        existing.durationMin = existing.endMin - existing.startMin;
        if (!existing.meetUrl && ev.meet_url) existing.meetUrl = ev.meet_url;
        if (ev.is_now) existing.isNow = true;
        continue;
      }

      const rawParticipants = Array.isArray(ev.participants) ? ev.participants : [];
      const participants = rawParticipants
        .map((p) => (typeof p === 'string' ? p : p && (p.name || p.email || '')))
        .filter(Boolean);

      parsed.push({
        id: String(ev.id || `ev-${i}`),
        title: stripEmDash(ev.title || 'Event'),
        normTitle,
        calendar: stripEmDash(ev.calendar || ''),
        startMin,
        endMin: startMin + durationMin,
        durationMin,
        startLabel: startInfo.hhmm,
        endLabel: endInfo ? endInfo.hhmm : '',
        startMs: startInfo.ms,
        endMs: endInfo ? endInfo.ms : startInfo.ms + durationMin * 60000,
        isNow: Boolean(ev.is_now),
        countdown: stripEmDash(ev.countdown || ''),
        participants,
        meetUrl: ev.meet_url || null,
        tone: classifyEventTone(ev),
        lane: 0,
      });
    }

    parsed.sort((a, b) => a.startMin - b.startMin || b.durationMin - a.durationMin);

    // Assign up to 2 lanes cleanly so concurrent events never stack on top of each other
    const laneEnds = [-1, -1];
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      const visualSpanMin = Math.max(item.durationMin, 34);
      const visualEnd = item.startMin + visualSpanMin;
      if (item.startMin >= laneEnds[0]) {
        item.lane = 0;
        laneEnds[0] = visualEnd;
      } else if (item.startMin >= laneEnds[1]) {
        item.lane = 1;
        laneEnds[1] = visualEnd;
      } else {
        const pick = laneEnds[0] <= laneEnds[1] ? 0 : 1;
        item.lane = pick;
        laneEnds[pick] = Math.max(laneEnds[pick], visualEnd);
      }
    }

    const hasSecondLane = parsed.some((item) => item.lane === 1);
    for (let i = 0; i < parsed.length; i += 1) {
      parsed[i].dualLane = hasSecondLane;
    }
    return parsed;
  }

  function computeNextEventReadout(events, nowMin) {
    if (!Array.isArray(events) || events.length === 0) {
      return { tag: 'SCHEDULE', text: 'Open solar horizon', eventId: null, isLive: false };
    }
    const active = events.find((e) => nowMin >= e.startMin && nowMin < e.endMin) || events.find((e) => e.isNow);
    const upcoming = events.find((e) => e.startMin > nowMin);

    if (upcoming && !active) {
      return {
        tag: 'NEXT',
        text: `${upcoming.title} ${formatDurationCompact(upcoming.startMin - nowMin)}`,
        eventId: upcoming.id,
        isLive: false,
      };
    }
    if (active && upcoming) {
      return {
        tag: 'NOW',
        text: `${active.title} · Next: ${upcoming.title} ${formatDurationCompact(upcoming.startMin - nowMin)}`,
        eventId: active.id,
        isLive: true,
      };
    }
    if (active) {
      return {
        tag: 'NOW',
        text: `${active.title} (${active.startLabel}${active.endLabel ? `-${active.endLabel}` : ''})`,
        eventId: active.id,
        isLive: true,
      };
    }
    const last = events[events.length - 1];
    return {
      tag: 'DONE',
      text: `${events.length} events complete · last ${last.startLabel}`,
      eventId: last.id,
      isLive: false,
    };
  }

  function buildVernierSvg() {
    // 24h precision Vernier ruler: 48 half-hour hairlines, 24 hour ticks, 6 major ticks
    const lines = [];
    for (let half = 0; half <= 48; half += 1) {
      const x = ((half / 48) * 1000).toFixed(2);
      const isHour = half % 2 === 0;
      const hour = half / 2;
      const isMajor = isHour && hour > 0 && hour < 24 && hour % 3 === 0;
      const y2 = isMajor ? 10 : isHour ? 6.5 : 3.5;
      const cls = isMajor ? 'tc-tick-major' : isHour ? 'tc-tick-hour' : 'tc-tick-sub';
      lines.push(`<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${y2}"/>`);
    }
    const labels = MAJOR_HOURS.map((h) => {
      const pct = ((h / 24) * 100).toFixed(3);
      return `<span class="tc-hour-label tabular" style="left:${pct}%">${String(h).padStart(2, '0')}</span>`;
    }).join('');

    return (
      `<div class="tc-vernier-layer" data-tactile-layer="vernier" aria-hidden="true">` +
        `<svg class="tc-vernier-svg" viewBox="0 0 1000 12" preserveAspectRatio="none">${lines.join('')}</svg>` +
        `<div class="tc-hour-labels">${labels}</div>` +
      `</div>`
    );
  }

  function renderPipelineMicroBar() {
    const summary = state.today && state.today.summary ? state.today.summary : null;
    const total = Math.max(1, Math.min(24, Number(summary && summary.total_pipelines) || 20));
    const active = Math.max(0, Math.min(total, Number(summary && summary.active_pipelines) || 0));
    const degraded = Math.max(0, total - active);
    const boardOnline = state.health ? state.health.boardOnline !== false : true;
    const openTasks = state.health && state.health.totals ? Number(state.health.totals.openTasks) || 0 : null;

    const leds = [];
    for (let i = 0; i < total; i += 1) {
      const isLit = i < active;
      leds.push(`<span class="tc-led${isLit ? ' is-lit' : ' is-warn'}" aria-hidden="true"></span>`);
    }

    const titleParts = [`${active}/${total} active pipelines`];
    if (degraded > 0) titleParts.push(`${degraded} degraded`);
    titleParts.push(boardOnline ? 'board online' : 'board offline');
    if (openTasks !== null) titleParts.push(`${openTasks} open tasks`);

    return (
      `<div class="tc-pipe-micro" title="${escAttr(titleParts.join(' · '))}" aria-label="${escAttr(titleParts.join(', '))}">` +
        `<span class="tc-pipe-led-bar" role="presentation">${leds.join('')}</span>` +
        `<span class="tc-pipe-readout tabular">${active}/${total}</span>` +
        `<span class="tc-pipe-unit">PIPES</span>` +
      `</div>`
    );
  }

  function renderCapsules(events, nowMin) {
    if (!events.length) return '';
    return events
      .map((ev) => {
        const leftPct = Math.max(0.4, Math.min(96.5, (ev.startMin / MINUTES_IN_DAY) * 100));
        const rawWidthPct = (ev.durationMin / MINUTES_IN_DAY) * 100;
        const widthPct = Math.max(2.6, Math.min(100 - leftPct - 0.4, rawWidthPct));
        const isLive = ev.isNow || (nowMin >= ev.startMin && nowMin < ev.endMin);
        const isPast = !isLive && nowMin >= ev.endMin;
        const laneCls = ev.dualLane ? (ev.lane === 1 ? ' is-lane-b' : ' is-lane-a') : ' is-lane-single';
        const showInlineLabel = widthPct >= 5.2;
        const tooltipAlign = leftPct > 60 ? ' is-tip-right' : leftPct < 30 ? ' is-tip-left' : '';
        const timeRange = ev.endLabel ? `${ev.startLabel}-${ev.endLabel}` : ev.startLabel;
        const metaLine = ev.participants.length > 0
          ? `${ev.participants.length} attendee${ev.participants.length === 1 ? '' : 's'}${ev.meetUrl ? ' · Meet' : ''}`
          : ev.calendar || 'Calendar event';

        return (
          `<button type="button" ` +
            `class="tc-capsule ${ev.tone}${laneCls}${isLive ? ' is-live' : ''}${isPast ? ' is-past' : ''}${tooltipAlign}" ` +
            `style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%" ` +
            `data-select-today="meeting:${escAttr(ev.id)}" ` +
            `data-event-id="${escAttr(ev.id)}" ` +
            `data-tc-capsule="1" ` +
            `aria-label="${escAttr(`${ev.startLabel} ${ev.title}. Click to open meeting brief.`)}">` +
            `<span class="tc-capsule-dot" aria-hidden="true"></span>` +
            `${showInlineLabel ? `<span class="tc-capsule-label">${escHtml(ev.title)}</span>` : ''}` +
            `<span class="tc-tooltip" role="tooltip">` +
              `<span class="tc-tooltip-time tabular">${escHtml(timeRange)}${isLive ? ' · LIVE' : ev.countdown ? ` · ${escHtml(ev.countdown)}` : ''}</span>` +
              `<span class="tc-tooltip-title">${escHtml(ev.title)}</span>` +
              `<span class="tc-tooltip-meta">${escHtml(metaLine)} · Click to prep</span>` +
            `</span>` +
          `</button>`
        );
      })
      .join('');
  }

  function render() {
    const host = state.hostEl;
    if (!host || !host.isConnected) return;

    const clk = getLondonClock(new Date());
    const nowPct = Math.max(0.5, Math.min(99.5, (clk.minutesOfDay / MINUTES_IN_DAY) * 100));
    const nextInfo = computeNextEventReadout(state.events, clk.minutesOfDay);
    const needleFlagCls = nowPct > 88 ? ' is-edge-right' : nowPct < 10 ? ' is-edge-left' : '';

    const nextHtml = nextInfo.eventId
      ? `<button type="button" class="tc-next-trigger${nextInfo.isLive ? ' is-live' : ''}" data-select-today="meeting:${escAttr(nextInfo.eventId)}" title="Open meeting brief">` +
          `<span class="tc-next-tag">${escHtml(nextInfo.tag)}</span>` +
          `<span class="tc-next-copy">${escHtml(nextInfo.text)}</span>` +
        `</button>`
      : `<span class="tc-next-static">` +
          `<span class="tc-next-tag">${escHtml(nextInfo.tag)}</span>` +
          `<span class="tc-next-copy">${escHtml(nextInfo.text)}</span>` +
        `</span>`;

    host.innerHTML =
      `<section class="tc-chronometer" data-tactile="chronometer" data-tactile-rim aria-label="Today Solar Chronometer">` +
        `<div class="tc-bezel-specular" data-tactile-layer="specular" aria-hidden="true"></div>` +
        `<div class="tc-bezel-row">` +
          `<div class="tc-quartz-group">` +
            `<span class="tc-jewel-dot" aria-hidden="true"></span>` +
            `<span class="tc-quartz-clock tabular" data-tc-ref="clock">LON ${escHtml(clk.formatted)}</span>` +
            `<span class="tc-bezel-sep" aria-hidden="true">·</span>` +
            `${nextHtml}` +
          `</div>` +
          `<div class="tc-bezel-right">` +
            `${renderPipelineMicroBar()}` +
          `</div>` +
        `</div>` +
        `<div class="tc-track-shell">` +
          `<div class="tc-track" role="region" aria-label="24-hour London solar day arc">` +
            `<div class="tc-sky-band" data-tactile-layer="sky" aria-hidden="true"></div>` +
            `${buildVernierSvg()}` +
            `<div class="tc-events-layer">${renderCapsules(state.events, clk.minutesOfDay)}</div>` +
            `<div class="tc-now-needle${needleFlagCls}" data-tc-ref="needle" style="left:${nowPct.toFixed(4)}%" aria-hidden="true">` +
              `<span class="tc-now-glow" data-tactile-layer="glow"></span>` +
              `<span class="tc-now-cap"></span>` +
              `<span class="tc-now-stem"></span>` +
              `<span class="tc-now-flag tabular">NOW</span>` +
            `</div>` +
          `</div>` +
        `</div>` +
      `</section>`;
  }

  function tickClockInPlace() {
    const host = state.hostEl;
    if (!host || !host.isConnected) return;
    const clk = getLondonClock(new Date());
    const clockEl = host.querySelector('[data-tc-ref="clock"]');
    if (clockEl) {
      clockEl.textContent = `LON ${clk.formatted}`;
    }
    const needleEl = host.querySelector('[data-tc-ref="needle"]');
    if (needleEl) {
      const nowPct = Math.max(0.5, Math.min(99.5, (clk.minutesOfDay / MINUTES_IN_DAY) * 100));
      needleEl.style.left = `${nowPct.toFixed(4)}%`;
      needleEl.classList.toggle('is-edge-right', nowPct > 88);
      needleEl.classList.toggle('is-edge-left', nowPct < 10);
    }
  }

  async function fetchTelemetry(force) {
    if (state.fetching && !force) return;
    if (!force && Date.now() - state.lastFetchAt < 12000 && state.today) return;
    state.fetching = true;

    try {
      const [todayRes, healthRes] = await Promise.all([
        fetch('/api/today?includeNoise=false', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/agent-board/health', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (todayRes && typeof todayRes === 'object') {
        state.today = todayRes;
        state.events = buildSolarEvents(todayRes.schedule || []);
      }
      if (healthRes && typeof healthRes === 'object') {
        state.health = healthRes;
      }
      state.lastFetchAt = Date.now();
    } finally {
      state.fetching = false;
      render();
    }
  }

  function bindHostEvents(host) {
    if (host.__tcBound) return;
    host.__tcBound = true;
    host.addEventListener('click', (event) => {
      const btn = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-tc-capsule], .tc-next-trigger')
        : null;
      if (btn) {
        triggerTactile('tick');
      }
    });
  }

  function ensureMounted() {
    const viewToday = document.getElementById('view-today');
    if (!viewToday) return;
    const detailBody = viewToday.querySelector('#detail-body');
    if (!detailBody) return;

    const briefHero = detailBody.querySelector('.brief-hero');
    const radarSlot = detailBody.querySelector('[data-slot="today-radar"]');
    if (!briefHero && !radarSlot) {
      // Not on Morning Brief view (e.g. viewing an individual inbox thread or meeting)
      return;
    }

    const parent = (radarSlot && radarSlot.parentNode) || (briefHero && briefHero.parentNode);
    if (!parent) return;

    let host = parent.querySelector('[data-today-chronometer-host="1"]');
    if (!host) {
      host = document.createElement('div');
      host.className = 'tc-chronometer-host';
      host.setAttribute('data-today-chronometer-host', '1');
      if (radarSlot && radarSlot.parentNode === parent) {
        parent.insertBefore(host, radarSlot);
      } else if (briefHero && briefHero.nextSibling) {
        parent.insertBefore(host, briefHero.nextSibling);
      } else {
        parent.appendChild(host);
      }
    }

    const changedHost = state.hostEl !== host;
    state.hostEl = host;
    bindHostEvents(host);

    if (changedHost || !host.firstElementChild) {
      render();
    }
    if (!state.today || Date.now() - state.lastFetchAt > REFRESH_INTERVAL_MS) {
      fetchTelemetry(false);
    }
  }

  function startTimers() {
    if (!state.tickTimer) {
      const interval = prefersReducedMotion() ? 15000 : TICK_INTERVAL_MS;
      state.tickTimer = setInterval(tickClockInPlace, interval);
    }
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        if (state.hostEl && state.hostEl.isConnected) {
          fetchTelemetry(true);
        }
      }, REFRESH_INTERVAL_MS);
    }
  }

  function bootstrap() {
    ensureMounted();
    startTimers();

    const detailBody = document.getElementById('detail-body');
    if (detailBody && typeof MutationObserver !== 'undefined') {
      state.observer = new MutationObserver(() => {
        ensureMounted();
      });
      state.observer.observe(detailBody, { childList: true, subtree: true });
    }

    window.addEventListener('kizuki:board-sse', () => {
      if (state.hostEl && state.hostEl.isConnected) {
        fetchTelemetry(true);
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
      bootstrap();
    }
  }

  root.KizukiTodayChronometer = {
    mount: ensureMounted,
    refresh: () => fetchTelemetry(true),
    getState: () => ({
      mounted: Boolean(state.hostEl && state.hostEl.isConnected),
      eventCount: state.events.length,
      clock: getLondonClock(new Date()).formatted,
    }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
