/* Kizuki Mind Explorer - Braun / Teenage Engineering Vernier Time Scrubber & Year Replay Console */
/* Pure ES2022, zero dependencies, zero innerHTML XSS, 0% idle CPU, GPU translate3d vernier needle */

(function initKizukiReplayScrubberModule(global) {
  'use strict';

  const STYLE_TAG_ID = 'kizuki-vernier-base-styles';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOME_LAT = 51.4015;
  const HOME_LNG = -0.0757;
  const AWAY_THRESHOLD_KM = 30;
  const MAJOR_TRIP_KM = 120;
  const DEG_TO_RAD = Math.PI / 180;
  const EARTH_RADIUS_KM = 6371;
  const PLAY_INTERVAL_1X_MS = 1450;
  const PLAY_INTERVAL_2X_MS = 750;
  const DRAG_COMMIT_DEBOUNCE_MS = 180;
  const WHEEL_STEP_THRESHOLD = 24;
  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  function getWin() {
    if (typeof window !== 'undefined' && window) return window;
    if (global && global.window) return global.window;
    if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
    return null;
  }

  function getDoc(containerEl) {
    if (containerEl && containerEl.ownerDocument) return containerEl.ownerDocument;
    if (typeof document !== 'undefined' && document) return document;
    const w = getWin();
    return (w && w.document) || null;
  }

  function clamp(val, min, max) {
    return val < min ? min : (val > max ? max : val);
  }

  function stripEmDash(str) {
    return String(str == null ? '' : str).replace(/\u2014/g, '-').replace(/\s+/g, ' ').trim();
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLng = (lng2 - lng1) * DEG_TO_RAD;
    const a =
      Math.sin(dLat * 0.5) * Math.sin(dLat * 0.5) +
      Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLng * 0.5) * Math.sin(dLng * 0.5);
    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function parseIsoDate(dayIso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso || '').trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const date = Number(m[3]);
    if (month < 0 || month > 11 || date < 1 || date > 31) return null;
    const ts = Date.UTC(year, month, date);
    const check = new Date(ts);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month ||
      check.getUTCDate() !== date
    ) {
      return null;
    }
    const yearStart = Date.UTC(year, 0, 1);
    const nextYearStart = Date.UTC(year + 1, 0, 1);
    const daysInYear = Math.round((nextYearStart - yearStart) / 86400000);
    const dayOfYear = Math.round((ts - yearStart) / 86400000) + 1;
    return {
      iso: m[1] + '-' + m[2] + '-' + m[3],
      year,
      month,
      date,
      ts,
      dayOfYear,
      daysInYear,
    };
  }

  function formatReadoutDate(parsed) {
    if (!parsed) return 'NO DATE';
    return MONTH_NAMES[parsed.month] + ' ' + parsed.date + ', ' + parsed.year;
  }

  function formatCoords(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    const latStr = Math.abs(lat).toFixed(2) + '\u00b0' + (lat >= 0 ? 'N' : 'S');
    const lngStr = Math.abs(lng).toFixed(2) + '\u00b0' + (lng >= 0 ? 'E' : 'W');
    return latStr + ' ' + lngStr;
  }

  function finiteOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function nonNegInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  }

  function normalizeDayRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const parsed = parseIsoDate(raw.day);
    if (!parsed) return null;

    let lat = finiteOrNull(raw.lat);
    let lng = finiteOrNull(raw.lng);
    let coordLabel = '';

    if ((lat === null || lng === null) && Array.isArray(raw.coords) && raw.coords.length > 0) {
      for (let i = 0; i < raw.coords.length; i += 1) {
        const c = raw.coords[i];
        if (!c || typeof c !== 'object') continue;
        const clat = finiteOrNull(c.lat);
        const clng = finiteOrNull(c.lng);
        if (clat !== null && clng !== null) {
          lat = clat;
          lng = clng;
          if (c.label) coordLabel = stripEmDash(c.label);
          break;
        }
      }
    }

    const hasFiniteCoords = lat !== null && lng !== null;
    const hasGps =
      raw.has_gps === true ||
      hasFiniteCoords ||
      (Array.isArray(raw.coords) && raw.coords.length > 0 && raw.has_gps !== false);

    const placeCandidates = [
      raw.primary_location,
      raw.primary_place,
      coordLabel,
      Array.isArray(raw.places) && raw.places.length > 0 ? raw.places[0] : '',
    ];
    let primaryLocation = '';
    for (let i = 0; i < placeCandidates.length; i += 1) {
      const cleaned = stripEmDash(placeCandidates[i]);
      if (cleaned) {
        primaryLocation = cleaned;
        break;
      }
    }

    const distKm = hasFiniteCoords ? haversineKm(HOME_LAT, HOME_LNG, lat, lng) : 0;
    const isAway =
      Boolean(raw.is_away) ||
      Boolean(raw.is_trip) ||
      (hasFiniteCoords && distKm >= AWAY_THRESHOLD_KM);

    const whoopRecovery = finiteOrNull(raw.whoop_recovery);

    return {
      day: parsed.iso,
      parsed,
      primary_location: primaryLocation,
      has_gps: Boolean(hasGps),
      lat,
      lng,
      total_events: nonNegInt(raw.total_events),
      photo_count: nonNegInt(raw.photo_count),
      whoop_recovery: whoopRecovery,
      distance_from_home_km: Math.round(distKm * 10) / 10,
      is_away: isAway,
      is_trip: Boolean(raw.is_trip) || (hasFiniteCoords && distKm >= MAJOR_TRIP_KM),
      ratio: 0,
      raw,
    };
  }

  function normalizeAndSortDays(daysArray) {
    if (!Array.isArray(daysArray) || daysArray.length === 0) {
      return { allDays: [], gpsDays: [], tripSpans: [], spanStartTs: 0, spanEndTs: 0, singleYear: null };
    }

    const byDay = new Map();
    for (let i = 0; i < daysArray.length; i += 1) {
      const rec = normalizeDayRecord(daysArray[i]);
      if (!rec) continue;
      const existing = byDay.get(rec.day);
      if (!existing) {
        byDay.set(rec.day, rec);
      } else {
        const existingScore = (existing.has_gps ? 10 : 0) + existing.photo_count + existing.total_events;
        const nextScore = (rec.has_gps ? 10 : 0) + rec.photo_count + rec.total_events;
        if (nextScore >= existingScore) {
          byDay.set(rec.day, rec);
        }
      }
    }

    const allDays = Array.from(byDay.values()).sort((a, b) => a.parsed.ts - b.parsed.ts);
    if (allDays.length === 0) {
      return { allDays: [], gpsDays: [], tripSpans: [], spanStartTs: 0, spanEndTs: 0, singleYear: null };
    }

    // Detect multi-day away trips (away days separated by <= 2 calendar days)
    const awayDays = allDays.filter((d) => d.is_away);
    const tripSpans = [];
    let run = [];

    function flushRun(group) {
      if (group.length === 0) return;
      const isMultiDay = group.length >= 2;
      const hasMajorFlight = group.some((d) => d.distance_from_home_km >= MAJOR_TRIP_KM || d.is_trip);
      if (isMultiDay || hasMajorFlight) {
        for (let k = 0; k < group.length; k += 1) {
          group[k].is_trip = true;
        }
        tripSpans.push({
          startDay: group[0],
          endDay: group[group.length - 1],
          count: group.length,
        });
      }
    }

    for (let i = 0; i < awayDays.length; i += 1) {
      const cur = awayDays[i];
      if (run.length === 0) {
        run.push(cur);
      } else {
        const prev = run[run.length - 1];
        const gapDays = Math.round((cur.parsed.ts - prev.parsed.ts) / 86400000);
        if (gapDays <= 2) {
          run.push(cur);
        } else {
          flushRun(run);
          run = [cur];
        }
      }
    }
    flushRun(run);

    // Determine chronological ruler span: full calendar year when all days fall in one year
    const firstYear = allDays[0].parsed.year;
    const lastYear = allDays[allDays.length - 1].parsed.year;
    let singleYear = null;
    let spanStartTs;
    let spanEndTs;

    if (firstYear === lastYear) {
      singleYear = firstYear;
      spanStartTs = Date.UTC(firstYear, 0, 1);
      spanEndTs = Date.UTC(firstYear, 11, 31);
    } else {
      spanStartTs = Date.UTC(firstYear, allDays[0].parsed.month, 1);
      spanEndTs = Date.UTC(lastYear, allDays[allDays.length - 1].parsed.month + 1, 0);
    }

    const spanDelta = Math.max(86400000, spanEndTs - spanStartTs);
    for (let i = 0; i < allDays.length; i += 1) {
      const d = allDays[i];
      d.ratio = clamp((d.parsed.ts - spanStartTs) / spanDelta, 0, 1);
    }

    const gpsDays = allDays.filter((d) => d.has_gps);
    return { allDays, gpsDays, tripSpans, spanStartTs, spanEndTs, singleYear };
  }

  function buildMonthMarkers(spanStartTs, spanEndTs, singleYear) {
    const spanDelta = Math.max(86400000, spanEndTs - spanStartTs);
    const markers = [];

    if (singleYear !== null) {
      for (let m = 0; m < 12; m += 1) {
        const ts = Date.UTC(singleYear, m, 1);
        markers.push({
          label: MONTH_NAMES[m],
          ratio: clamp((ts - spanStartTs) / spanDelta, 0, 1),
          monthIndex: m,
        });
      }
      return markers;
    }

    const startDate = new Date(spanStartTs);
    const endDate = new Date(spanEndTs);
    let y = startDate.getUTCFullYear();
    let m = startDate.getUTCMonth();
    const endY = endDate.getUTCFullYear();
    const endM = endDate.getUTCMonth();
    const totalMonths = (endY - y) * 12 + (endM - m) + 1;
    const stride = totalMonths > 18 ? Math.ceil(totalMonths / 12) : 1;
    let idx = 0;

    while (y < endY || (y === endY && m <= endM)) {
      if (idx % stride === 0) {
        const ts = Date.UTC(y, m, 1);
        markers.push({
          label: m === 0 ? MONTH_NAMES[m] + ' ' + String(y).slice(2) : MONTH_NAMES[m],
          ratio: clamp((ts - spanStartTs) / spanDelta, 0, 1),
          monthIndex: idx,
        });
      }
      idx += 1;
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
    return markers;
  }

  function buildMeta(dayRec, poolIndex, poolLength, filterMode) {
    if (!dayRec) return null;
    return {
      day: dayRec.day,
      primary_location: dayRec.primary_location || null,
      has_gps: dayRec.has_gps,
      lat: dayRec.lat,
      lng: dayRec.lng,
      total_events: dayRec.total_events,
      photo_count: dayRec.photo_count,
      whoop_recovery: dayRec.whoop_recovery,
      is_away: dayRec.is_away,
      is_trip: dayRec.is_trip,
      distance_from_home_km: dayRec.distance_from_home_km,
      index: poolIndex,
      total: poolLength,
      filter: filterMode,
      raw: dayRec.raw,
    };
  }

  function playDetentSound() {
    try {
      const w = getWin();
      const sound = (w && w.KizukiSound) || (global && global.KizukiSound);
      if (sound && typeof sound.tick === 'function') {
        sound.tick();
      }
    } catch (_) {
      // Never allow audio hook failure to disrupt scrubbing
    }
  }

  function requestFrame(cb) {
    const w = getWin();
    if (w && typeof w.requestAnimationFrame === 'function') {
      return w.requestAnimationFrame(cb);
    }
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(cb);
    }
    return setTimeout(cb, 16);
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
      return;
    }
    clearTimeout(id);
  }

  function createSvgEl(doc, tag, attrs) {
    const el = typeof doc.createElementNS === 'function'
      ? doc.createElementNS(SVG_NS, tag)
      : doc.createElement(tag);
    if (attrs) {
      const keys = Object.keys(attrs);
      for (let i = 0; i < keys.length; i += 1) {
        el.setAttribute(keys[i], String(attrs[keys[i]]));
      }
    }
    return el;
  }

  function createIconSvg(doc, kind) {
    const svg = createSvgEl(doc, 'svg', {
      width: '12',
      height: '12',
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': 'true',
      class: 'vernier-icon',
    });

    if (kind === 'prev') {
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M8.5 2.2L3.5 6l5 3.8V2.2Z',
        fill: 'currentColor',
      }));
    } else if (kind === 'next') {
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M3.5 2.2L8.5 6l-5 3.8V2.2Z',
        fill: 'currentColor',
      }));
    } else if (kind === 'play') {
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M3 2.1L9.8 6 3 9.9V2.1Z',
        fill: 'currentColor',
      }));
    } else if (kind === 'pause') {
      svg.appendChild(createSvgEl(doc, 'rect', {
        x: '2.6',
        y: '2.2',
        width: '2.3',
        height: '7.6',
        rx: '0.6',
        fill: 'currentColor',
      }));
      svg.appendChild(createSvgEl(doc, 'rect', {
        x: '7.1',
        y: '2.2',
        width: '2.3',
        height: '7.6',
        rx: '0.6',
        fill: 'currentColor',
      }));
    }
    return svg;
  }

  function ensureBaseStyles(doc) {
    if (!doc || !doc.head || typeof doc.getElementById !== 'function') return;
    if (doc.getElementById(STYLE_TAG_ID)) return;

    const style = doc.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = [
      ':where(.vernier-scrubber) {',
      '  --vn-bg: var(--surface-raised, #0a0a0a);',
      '  --vn-track-bg: var(--surface-inset, #0d0d0f);',
      '  --vn-border: var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  --vn-border-strong: var(--border-strong, rgba(255, 255, 255, 0.16));',
      '  --vn-ink: var(--ink-primary, #ededed);',
      '  --vn-ink-sub: var(--ink-secondary, #a1a1a1);',
      '  --vn-ink-muted: var(--ink-muted, #737373);',
      '  --vn-gps: var(--accent-green, #46a758);',
      '  --vn-trip: var(--accent-cyan, #50e3c2);',
      '  --vn-needle: #ff453a;',
      '  --vn-needle-cap: #ededed;',
      '  --vn-tick-minor: rgba(255, 255, 255, 0.14);',
      '  --vn-tick-major: rgba(255, 255, 255, 0.34);',
      '  --vn-tick-day: rgba(255, 255, 255, 0.24);',
      '  --vn-bezel-minor: rgba(255, 255, 255, 0.12);',
      '  --vn-bezel-major: rgba(255, 255, 255, 0.28);',
      '  --vn-font-mono: var(--font-mono, "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace);',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 8px;',
      '  padding: 10px 12px 11px;',
      '  margin-top: 10px;',
      '  border-radius: var(--radius-md, 10px);',
      '  background: var(--vn-bg);',
      '  border: 1px solid var(--vn-border);',
      '  user-select: none;',
      '  -webkit-user-select: none;',
      '}',
      ':where(html[data-theme="light"] .vernier-scrubber) {',
      '  --vn-needle: #d93025;',
      '  --vn-needle-cap: #171717;',
      '  --vn-tick-minor: rgba(0, 0, 0, 0.13);',
      '  --vn-tick-major: rgba(0, 0, 0, 0.36);',
      '  --vn-tick-day: rgba(0, 0, 0, 0.24);',
      '  --vn-bezel-minor: rgba(0, 0, 0, 0.13);',
      '  --vn-bezel-major: rgba(0, 0, 0, 0.30);',
      '}',
      ':where(.vernier-transport) {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  flex-wrap: wrap;',
      '}',
      ':where(.vernier-controls) {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  flex-wrap: wrap;',
      '}',
      ':where(.vernier-btn), :where(.vernier-pill) {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 5px;',
      '  height: 26px;',
      '  padding: 0 8px;',
      '  border-radius: 6px;',
      '  border: 1px solid var(--vn-border);',
      '  background: var(--vn-track-bg);',
      '  color: var(--vn-ink-sub);',
      '  font-family: var(--vn-font-mono);',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  line-height: 1;',
      '  cursor: pointer;',
      '  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;',
      '}',
      ':where(.vernier-btn-step) { width: 26px; padding: 0; }',
      ':where(.vernier-btn:hover), :where(.vernier-pill:hover) {',
      '  border-color: var(--vn-border-strong);',
      '  color: var(--vn-ink);',
      '}',
      ':where(.vernier-btn:disabled), :where(.vernier-pill:disabled) {',
      '  opacity: 0.4;',
      '  cursor: not-allowed;',
      '}',
      ':where(.vernier-btn-play) {',
      '  min-width: 78px;',
      '  color: var(--vn-ink);',
      '}',
      ':where(.vernier-btn-play.is-playing) {',
      '  border-color: rgba(255, 69, 58, 0.45);',
      '  color: var(--vn-needle);',
      '}',
      ':where(.vernier-pill.is-active) {',
      '  border-color: rgba(70, 167, 88, 0.42);',
      '  color: var(--vn-ink);',
      '}',
      ':where(.vernier-pill-dot) {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 999px;',
      '  background: var(--vn-gps);',
      '  flex-shrink: 0;',
      '}',
      ':where(.vernier-pill:not(.is-active) .vernier-pill-dot) {',
      '  background: var(--vn-ink-muted);',
      '}',
      ':where(.vernier-scrubber .vernier-readout) {',
      '  width: 100%;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  flex-wrap: nowrap;',
      '  min-height: 28px;',
      '  padding: 4px 10px;',
      '  box-sizing: border-box;',
      '  border-radius: 6px;',
      '  border: 1px solid var(--vn-border);',
      '  background: var(--vn-track-bg);',
      '  font-family: var(--vn-font-mono);',
      '  font-size: 11px;',
      '  line-height: 1.25;',
      '  color: var(--vn-ink-sub);',
      '  font-variant-numeric: tabular-nums;',
      '  max-width: 100%;',
      '  overflow: hidden;',
      '}',
      ':where(.vernier-readout-main) {',
      '  display: block;',
      '  flex: 1 1 auto;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      ':where(.vernier-readout-date) { color: var(--vn-ink); font-weight: 500; letter-spacing: 0.03em; }',
      ':where(.vernier-readout-place) { color: var(--vn-ink); }',
      ':where(.vernier-readout-coords) { color: var(--vn-trip); }',
      ':where(.vernier-readout-sep) { color: var(--vn-ink-muted); margin: 0 5px; user-select: none; }',
      ':where(.vernier-readout-counter) { color: var(--vn-ink-muted); flex-shrink: 0; margin-left: auto; white-space: nowrap; }',
      ':where(.vernier-track) {',
      '  position: relative;',
      '  height: 48px;',
      '  border-radius: 7px;',
      '  border: 1px solid var(--vn-border);',
      '  background: var(--vn-track-bg);',
      '  cursor: ew-resize;',
      '  touch-action: pan-y;',
      '  outline: none;',
      '  overflow: hidden;',
      '}',
      ':where(.vernier-track:focus-visible) {',
      '  border-color: var(--border-focus, #3291ff);',
      '}',
      ':where(.vernier-track.is-dragging) {',
      '  touch-action: none;',
      '  cursor: grabbing;',
      '  border-color: var(--vn-border-strong);',
      '}',
      ':where(.vernier-track-inner) {',
      '  position: absolute;',
      '  inset: 0 14px;',
      '}',
      ':where(.vernier-ruler-svg) {',
      '  display: block;',
      '  width: 100%;',
      '  height: 32px;',
      '  overflow: visible;',
      '}',
      ':where(.vernier-months) {',
      '  position: relative;',
      '  height: 15px;',
      '  width: 100%;',
      '  pointer-events: none;',
      '}',
      ':where(.vernier-month-label) {',
      '  position: absolute;',
      '  top: 1px;',
      '  transform: translateX(-50%);',
      '  font-family: var(--vn-font-mono);',
      '  font-size: var(--t-xs, 11px);',
      '  letter-spacing: 0.04em;',
      '  color: var(--vn-ink-muted);',
      '  white-space: nowrap;',
      '}',
      ':where(.vernier-month-label.is-first) { transform: translateX(0); }',
      ':where(.vernier-month-label.is-last) { transform: translateX(-100%); }',
      ':where(.vernier-needle) {',
      '  position: absolute;',
      '  top: 0;',
      '  left: 0;',
      '  width: 2px;',
      '  height: 34px;',
      '  margin-left: -1px;',
      '  pointer-events: none;',
      '  will-change: transform;',
      '  transform: translate3d(0px, 0, 0);',
      '}',
      ':where(.vernier-needle-cap) {',
      '  position: absolute;',
      '  top: 0;',
      '  left: 50%;',
      '  width: 11px;',
      '  height: 8px;',
      '  transform: translateX(-50%);',
      '  clip-path: polygon(0 0, 100% 0, 100% 42%, 50% 100%, 0 42%);',
      '  background: linear-gradient(180deg, #f59e0b 0 2px, #e5e7eb 2px, #9ca3af 100%);',
      '  opacity: 0;',
      '  visibility: hidden;',
      '}',
      ':where(html[data-detail="on"] .vernier-needle-cap) {',
      '  opacity: 1;',
      '  visibility: visible;',
      '}',
      ':where(html[data-theme="light"][data-detail="on"] .vernier-needle-cap) {',
      '  background: linear-gradient(180deg, #d97706 0 2px, #3f3f46 2px, #18181b 100%);',
      '}',
      ':where(html[data-detail="off"] .vernier-needle-cap) {',
      '  opacity: 0;',
      '  visibility: hidden;',
      '}',
      ':where(.vernier-needle-blade) {',
      '  position: absolute;',
      '  top: 2px;',
      '  left: 50%;',
      '  width: 1.5px;',
      '  height: 30px;',
      '  transform: translateX(-50%);',
      '  background: var(--vn-needle);',
      '  box-shadow: none;',
      '}',
      ':where(html[data-detail="on"] .vernier-needle-blade) {',
      '  top: 6px;',
      '  height: 26px;',
      '  box-shadow: 0 0 8px rgba(239, 68, 68, 0.55);',
      '}',
      ':where(html[data-detail="off"] .vernier-needle-blade) {',
      '  top: 2px;',
      '  height: 30px;',
      '  box-shadow: none;',
      '}',
      ':where(html[data-detail="off"] .vernier-top-bezel-ticks),',
      ':where(html[data-detail="off"] .vernier-minor-ticks) {',
      '  opacity: 0;',
      '}',
      ':where(.vernier-hover-line) {',
      '  position: absolute;',
      '  top: 2px;',
      '  left: 0;',
      '  width: 1px;',
      '  height: 29px;',
      '  pointer-events: none;',
      '  background: var(--vn-border-strong);',
      '  opacity: 0;',
      '  transform: translate3d(0px, 0, 0);',
      '}',
      ':where(.vernier-hover-line.is-visible) { opacity: 1; }',
      '@media (max-width: 640px) {',
      '  :where(.vernier-readout-coords), :where(.vernier-readout-sep-coords) { display: none; }',
      '}',
      '@media (max-width: 560px) {',
      '  :where(.vernier-month-label[data-odd="1"]) { display: none; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  :where(.vernier-btn), :where(.vernier-pill) { transition: none; }',
      '}',
    ].join('\n');

    doc.head.appendChild(style);
  }

  function isElementHidden(el) {
    if (!el) return true;
    if (el.isConnected === false) return true;
    let node = el;
    while (node) {
      if (node.hidden === true) return true;
      if (typeof node.getAttribute === 'function' && node.getAttribute('hidden') !== null) {
        return true;
      }
      if (node.style && node.style.display === 'none') return true;
      node = node.parentElement || node.parentNode;
    }
    return false;
  }

  function mount(containerEl, opts) {
    if (!containerEl || typeof containerEl.appendChild !== 'function') {
      throw new Error('KizukiReplayScrubber.mount requires a valid container element');
    }

    const options = opts && typeof opts === 'object' ? opts : {};
    const onSelectDay = typeof options.onSelectDay === 'function' ? options.onSelectDay : null;
    const onPreviewDay = typeof options.onPreviewDay === 'function' ? options.onPreviewDay : null;
    const onPlayStateChange = typeof options.onPlayStateChange === 'function' ? options.onPlayStateChange : null;

    const doc = getDoc(containerEl);
    const win = getWin();
    ensureBaseStyles(doc);

    // Internal state
    let destroyed = false;
    let allDays = [];
    let gpsDays = [];
    let tripSpans = [];
    let spanStartTs = 0;
    let spanEndTs = 0;
    let singleYear = null;
    let filterMode = options.defaultFilter === 'all' ? 'all' : 'gps';
    let userExplicitFilter = false;
    let speed = options.defaultSpeed === 2 ? 2 : 1;
    let activeDayIso = null;
    let lastCommittedDay = null;
    let isPlaying = false;
    let playTimer = null;
    let isDragging = false;
    let activePointerId = null;
    let dragRafId = null;
    let pendingPreviewDay = null;
    let lastPreviewedDay = null;
    let commitDebounceTimer = null;
    let wheelAccum = 0;
    let wheelCommitTimer = null;
    let trackInnerWidth = 0;
    let resizeObserver = null;
    let intersectionObserver = null;
    let globalPlayListenersAttached = false;

    // Build DOM cleanly (zero innerHTML)
    const root = doc.createElement('div');
    root.className = 'vernier-shell vernier-scrubber';
    root.setAttribute('data-playing', 'false');
    root.setAttribute('data-filter', filterMode);
    root.setAttribute('data-speed', String(speed));

    // 1. Transport bar
    const transport = doc.createElement('div');
    transport.className = 'vernier-transport';

    const controls = doc.createElement('div');
    controls.className = 'vernier-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Year replay transport controls');

    const prevBtn = doc.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'vernier-btn vernier-btn-step vernier-prev';
    prevBtn.setAttribute('aria-label', 'Previous day');
    prevBtn.title = 'Previous stop (Left Arrow)';
    prevBtn.appendChild(createIconSvg(doc, 'prev'));

    const playBtn = doc.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'vernier-btn vernier-btn-play';
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.setAttribute('aria-label', 'Replay year');
    playBtn.title = 'Auto-replay year stops (Space)';
    const playIconSlot = doc.createElement('span');
    playIconSlot.className = 'vernier-play-icon';
    playIconSlot.appendChild(createIconSvg(doc, 'play'));
    const playLabel = doc.createElement('span');
    playLabel.className = 'vernier-play-label';
    playLabel.textContent = 'Replay';
    playBtn.appendChild(playIconSlot);
    playBtn.appendChild(playLabel);

    const nextBtn = doc.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'vernier-btn vernier-btn-step vernier-next';
    nextBtn.setAttribute('aria-label', 'Next day');
    nextBtn.title = 'Next stop (Right Arrow)';
    nextBtn.appendChild(createIconSvg(doc, 'next'));

    const speedBtn = doc.createElement('button');
    speedBtn.type = 'button';
    speedBtn.className = 'vernier-pill vernier-speed-pill';
    speedBtn.setAttribute('aria-label', 'Toggle replay speed');
    speedBtn.title = 'Toggle replay speed (1x / 2x)';
    speedBtn.textContent = speed + 'x';

    const filterBtn = doc.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'vernier-pill vernier-filter-pill' + (filterMode === 'gps' ? ' is-active' : '');
    filterBtn.setAttribute('aria-pressed', filterMode === 'gps' ? 'true' : 'false');
    filterBtn.setAttribute('aria-label', 'Filter GPS days or all days');
    filterBtn.title = 'Switch between GPS stops and all active days';
    const filterDot = doc.createElement('span');
    filterDot.className = 'vernier-pill-dot';
    filterDot.setAttribute('aria-hidden', 'true');
    const filterLabel = doc.createElement('span');
    filterLabel.className = 'vernier-filter-label';
    filterLabel.textContent = filterMode === 'gps' ? 'GPS Only' : 'All Days';
    filterBtn.appendChild(filterDot);
    filterBtn.appendChild(filterLabel);

    controls.appendChild(prevBtn);
    controls.appendChild(playBtn);
    controls.appendChild(nextBtn);
    controls.appendChild(speedBtn);
    controls.appendChild(filterBtn);

    // Live monospaced readout pill
    const readout = doc.createElement('div');
    readout.className = 'vernier-readout tabular';
    readout.setAttribute('aria-live', 'polite');

    const readoutMain = doc.createElement('span');
    readoutMain.className = 'vernier-readout-main';

    const readoutCounter = doc.createElement('span');
    readoutCounter.className = 'vernier-readout-counter';
    readoutCounter.hidden = true;

    readout.appendChild(readoutMain);
    readout.appendChild(readoutCounter);

    function renderReadoutSegments(segments) {
      while (readoutMain.firstChild) {
        readoutMain.removeChild(readoutMain.firstChild);
      }
      const cleanSegments = [];
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        if (!seg) continue;
        const text = String(seg.text == null ? '' : seg.text).trim();
        if (!text) continue;
        cleanSegments.push({
          className: seg.className || '',
          text,
          hideOnMobile: Boolean(seg.hideOnMobile),
        });
      }
      for (let i = 0; i < cleanSegments.length; i += 1) {
        const seg = cleanSegments[i];
        if (i > 0) {
          const sep = doc.createElement('span');
          sep.className = seg.hideOnMobile
            ? 'vernier-readout-sep vernier-readout-sep-coords'
            : 'vernier-readout-sep';
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '\u00b7';
          readoutMain.appendChild(sep);
        }
        const el = doc.createElement('span');
        if (seg.className) el.className = seg.className;
        el.textContent = seg.text;
        readoutMain.appendChild(el);
      }
    }

    renderReadoutSegments([
      { className: 'vernier-readout-date', text: 'NO DAYS' },
      { className: 'vernier-readout-place', text: 'Waiting for timeline' },
    ]);

    transport.appendChild(controls);
    transport.appendChild(readout);

    // 2. Machined millimeter ruler track
    const track = doc.createElement('div');
    track.className = 'vernier-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Year vernier time scrubber');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '0');
    track.setAttribute('aria-valuenow', '0');
    track.setAttribute('aria-valuetext', 'No days loaded');

    const trackInner = doc.createElement('div');
    trackInner.className = 'vernier-track-inner';

    const rulerSvg = createSvgEl(doc, 'svg', {
      class: 'vernier-ruler-svg',
      viewBox: '0 0 1000 32',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });

    const monthsRow = doc.createElement('div');
    monthsRow.className = 'vernier-months';
    monthsRow.setAttribute('aria-hidden', 'true');

    const hoverLine = doc.createElement('div');
    hoverLine.className = 'vernier-hover-line';
    hoverLine.setAttribute('aria-hidden', 'true');

    const needle = doc.createElement('div');
    needle.className = 'vernier-needle';
    needle.setAttribute('aria-hidden', 'true');
    const needleCap = doc.createElement('span');
    needleCap.className = 'vernier-needle-cap';
    const needleBlade = doc.createElement('span');
    needleBlade.className = 'vernier-needle-blade';
    needle.appendChild(needleCap);
    needle.appendChild(needleBlade);

    trackInner.appendChild(rulerSvg);
    trackInner.appendChild(monthsRow);
    trackInner.appendChild(hoverLine);
    trackInner.appendChild(needle);
    track.appendChild(trackInner);

    root.appendChild(transport);
    root.appendChild(track);

    // Mount cleanly inside containerEl
    while (containerEl.firstChild) {
      containerEl.removeChild(containerEl.firstChild);
    }
    containerEl.appendChild(root);

    function getActivePool() {
      if (filterMode === 'gps' && gpsDays.length > 0) {
        return gpsDays;
      }
      return allDays;
    }

    function findDayRecord(dayIso) {
      if (!dayIso) return null;
      for (let i = 0; i < allDays.length; i += 1) {
        if (allDays[i].day === dayIso) return allDays[i];
      }
      return null;
    }

    function findPoolIndex(dayIso, pool) {
      if (!dayIso || !pool || pool.length === 0) return -1;
      for (let i = 0; i < pool.length; i += 1) {
        if (pool[i].day === dayIso) return i;
      }
      return -1;
    }

    function measureTrackWidth() {
      if (typeof trackInner.getBoundingClientRect === 'function') {
        const rect = trackInner.getBoundingClientRect();
        if (rect && Number.isFinite(rect.width) && rect.width > 0) {
          trackInnerWidth = rect.width;
          return trackInnerWidth;
        }
      }
      if (Number.isFinite(trackInner.clientWidth) && trackInner.clientWidth > 0) {
        trackInnerWidth = trackInner.clientWidth;
        return trackInnerWidth;
      }
      return trackInnerWidth;
    }

    function positionNeedle(ratio) {
      const clamped = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1);
      const w = measureTrackWidth();
      if (w > 0) {
        const px = Math.round(clamped * w * 100) / 100;
        needle.style.left = '0px';
        needle.style.transform = 'translate3d(' + px + 'px, 0, 0)';
      } else {
        needle.style.left = (clamped * 100).toFixed(4) + '%';
        needle.style.transform = 'translate3d(0px, 0, 0)';
      }
    }

    function syncTransportUi() {
      const pool = getActivePool();
      const hasAny = pool.length > 0;
      prevBtn.disabled = !hasAny;
      nextBtn.disabled = !hasAny;
      playBtn.disabled = pool.length < 2;
      filterBtn.disabled = allDays.length === 0 || gpsDays.length === 0;

      root.setAttribute('data-playing', isPlaying ? 'true' : 'false');
      root.setAttribute('data-filter', filterMode);
      root.setAttribute('data-speed', String(speed));

      playBtn.classList.toggle('is-playing', isPlaying);
      playBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
      playBtn.setAttribute('aria-label', isPlaying ? 'Pause year replay' : 'Replay year');
      while (playIconSlot.firstChild) {
        playIconSlot.removeChild(playIconSlot.firstChild);
      }
      playIconSlot.appendChild(createIconSvg(doc, isPlaying ? 'pause' : 'play'));
      playLabel.textContent = isPlaying ? 'Pause' : 'Replay';

      speedBtn.textContent = speed + 'x';
      const isGpsActive = filterMode === 'gps' && gpsDays.length > 0;
      filterBtn.classList.toggle('is-active', isGpsActive);
      filterBtn.setAttribute('aria-pressed', isGpsActive ? 'true' : 'false');
      filterLabel.textContent = isGpsActive ? 'GPS Only' : 'All Days';
    }

    function updateReadoutAndNeedle(dayRec) {
      const pool = getActivePool();
      const poolIdx = dayRec ? findPoolIndex(dayRec.day, pool) : -1;

      if (!dayRec) {
        renderReadoutSegments([
          { className: 'vernier-readout-date', text: 'NO DAYS' },
          { className: 'vernier-readout-place', text: 'No replay stops' },
        ]);
        readoutCounter.hidden = true;
        readoutCounter.textContent = '';
        track.setAttribute('aria-valuemax', '0');
        track.setAttribute('aria-valuenow', '0');
        track.setAttribute('aria-valuetext', 'No days loaded');
        positionNeedle(0);
        return;
      }

      const dateText = formatReadoutDate(dayRec.parsed);
      const placeText = dayRec.primary_location || (dayRec.has_gps ? 'GPS Location' : 'Activity Day');
      const coordsText = formatCoords(dayRec.lat, dayRec.lng);

      const metaParts = [];
      if (dayRec.photo_count > 0) {
        metaParts.push(dayRec.photo_count + (dayRec.photo_count === 1 ? ' photo' : ' photos'));
      } else if (dayRec.total_events > 0) {
        metaParts.push(dayRec.total_events + (dayRec.total_events === 1 ? ' event' : ' events'));
      }
      if (dayRec.whoop_recovery !== null) {
        metaParts.push('Whoop ' + Math.round(dayRec.whoop_recovery) + '%');
      }
      const cleanMetaParts = metaParts.filter(Boolean);

      renderReadoutSegments([
        { className: 'vernier-readout-date', text: dateText },
        { className: 'vernier-readout-place', text: placeText },
        { className: 'vernier-readout-coords', text: coordsText, hideOnMobile: true },
        { className: 'vernier-readout-meta', text: cleanMetaParts.join(' \u00b7 ') },
      ]);

      if (pool.length > 0 && poolIdx >= 0) {
        readoutCounter.hidden = false;
        readoutCounter.textContent = (poolIdx + 1) + '/' + pool.length;
      } else if (allDays.length > 0) {
        readoutCounter.hidden = false;
        readoutCounter.textContent = pool.length + ' stops';
      } else {
        readoutCounter.hidden = true;
      }

      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(Math.max(0, pool.length - 1)));
      track.setAttribute('aria-valuenow', String(Math.max(0, poolIdx)));
      track.setAttribute(
        'aria-valuetext',
        dateText + ' - ' + placeText + (coordsText ? ' (' + coordsText + ')' : '')
      );

      positionNeedle(dayRec.ratio);
    }

    function renderRuler() {
      while (rulerSvg.firstChild) {
        rulerSvg.removeChild(rulerSvg.firstChild);
      }
      while (monthsRow.firstChild) {
        monthsRow.removeChild(monthsRow.firstChild);
      }

      // 1. Machined baseline hairline
      rulerSvg.appendChild(createSvgEl(doc, 'line', {
        x1: '0',
        y1: '30',
        x2: '1000',
        y2: '30',
        stroke: 'var(--vn-tick-minor)',
        'stroke-width': '1',
        'vector-effect': 'non-scaling-stroke',
      }));

      // 1b. Top-edge graduated millimeter vernier bezel scale (detail=on hardware layer)
      const topBezelGroup = createSvgEl(doc, 'g', {
        class: 'vernier-top-bezel-ticks',
      });
      const topTickCount = 100;
      for (let i = 0; i <= topTickCount; i += 1) {
        const x = ((i / topTickCount) * 1000).toFixed(2);
        const isMajor = i % 10 === 0;
        const isMid = !isMajor && i % 5 === 0;
        topBezelGroup.appendChild(createSvgEl(doc, 'line', {
          x1: x,
          y1: '0',
          x2: x,
          y2: isMajor ? '8.5' : (isMid ? '5.5' : '3.5'),
          stroke: isMajor ? 'var(--vn-bezel-major)' : 'var(--vn-bezel-minor)',
          'stroke-width': isMajor ? '1.15' : '1',
          'vector-effect': 'non-scaling-stroke',
        }));
      }
      rulerSvg.appendChild(topBezelGroup);

      // 2. Fine bottom millimeter graduations across the track (stripped in detail=off)
      const minorGroup = createSvgEl(doc, 'g', {
        class: 'vernier-minor-ticks',
      });
      const minorCount = 120;
      for (let i = 0; i <= minorCount; i += 1) {
        const x = ((i / minorCount) * 1000).toFixed(2);
        const isMid = i % 5 === 0;
        minorGroup.appendChild(createSvgEl(doc, 'line', {
          x1: x,
          y1: isMid ? '23' : '26',
          x2: x,
          y2: '30',
          stroke: 'var(--vn-tick-minor)',
          'stroke-width': '1',
          'vector-effect': 'non-scaling-stroke',
        }));
      }
      rulerSvg.appendChild(minorGroup);

      if (allDays.length === 0) return;

      // 3. Major month boundary graduations & crisp un-stretched DOM month labels
      const monthMarkers = buildMonthMarkers(spanStartTs, spanEndTs, singleYear);
      for (let i = 0; i < monthMarkers.length; i += 1) {
        const m = monthMarkers[i];
        const x = (m.ratio * 1000).toFixed(2);
        rulerSvg.appendChild(createSvgEl(doc, 'line', {
          x1: x,
          y1: '18',
          x2: x,
          y2: '30',
          stroke: 'var(--vn-tick-major)',
          'stroke-width': '1.1',
          'vector-effect': 'non-scaling-stroke',
        }));

        const lbl = doc.createElement('span');
        lbl.className = 'vernier-month-label';
        if (i === 0) lbl.classList.add('is-first');
        else if (i === monthMarkers.length - 1 && m.ratio > 0.94) lbl.classList.add('is-last');
        if (i % 2 === 1) lbl.setAttribute('data-odd', '1');
        lbl.style.left = (m.ratio * 100).toFixed(3) + '%';
        lbl.textContent = m.label;
        monthsRow.appendChild(lbl);
      }

      // 4. Multi-day away trip bands along the track bed
      for (let i = 0; i < tripSpans.length; i += 1) {
        const span = tripSpans[i];
        const x1 = span.startDay.ratio * 1000;
        const x2 = Math.max(x1 + 3, span.endDay.ratio * 1000);
        rulerSvg.appendChild(createSvgEl(doc, 'rect', {
          x: x1.toFixed(2),
          y: '26',
          width: (x2 - x1).toFixed(2),
          height: '4',
          fill: 'var(--vn-trip)',
          opacity: '0.26',
        }));
      }

      // 5. Day ticks: subtle non-GPS days, bright emerald GPS pips, tallest trip beacons
      const showNonGpsBright = filterMode === 'all' || gpsDays.length === 0;
      for (let i = 0; i < allDays.length; i += 1) {
        const d = allDays[i];
        const x = (d.ratio * 1000).toFixed(2);

        if (d.has_gps) {
          const isTrip = d.is_trip;
          const isAway = d.is_away;
          const topY = isTrip ? 5 : (isAway ? 9 : 14);
          const color = isTrip ? 'var(--vn-trip)' : 'var(--vn-gps)';
          rulerSvg.appendChild(createSvgEl(doc, 'line', {
            x1: x,
            y1: String(topY),
            x2: x,
            y2: '30',
            stroke: color,
            'stroke-width': isTrip ? '2' : '1.5',
            opacity: isTrip ? '0.96' : '0.82',
            'vector-effect': 'non-scaling-stroke',
          }));
        } else if (showNonGpsBright) {
          const activityBoost = Math.min(7, Math.floor(Math.sqrt(d.total_events)));
          const topY = 25 - activityBoost;
          rulerSvg.appendChild(createSvgEl(doc, 'line', {
            x1: x,
            y1: String(topY),
            x2: x,
            y2: '30',
            stroke: 'var(--vn-tick-day)',
            'stroke-width': '1',
            opacity: '0.7',
            'vector-effect': 'non-scaling-stroke',
          }));
        }
      }
    }

    function clearPendingDragWork() {
      if (dragRafId !== null) {
        cancelFrame(dragRafId);
        dragRafId = null;
      }
      if (commitDebounceTimer !== null) {
        clearTimeout(commitDebounceTimer);
        commitDebounceTimer = null;
      }
      pendingPreviewDay = null;
    }

    function clearWheelTimer() {
      if (wheelCommitTimer !== null) {
        clearTimeout(wheelCommitTimer);
        wheelCommitTimer = null;
      }
    }

    function emitPreview(dayRec) {
      if (!dayRec || !onPreviewDay) return;
      if (lastPreviewedDay === dayRec.day) return;
      lastPreviewedDay = dayRec.day;
      const pool = getActivePool();
      const idx = findPoolIndex(dayRec.day, pool);
      onPreviewDay(dayRec.day, buildMeta(dayRec, idx, pool.length, filterMode));
    }

    function emitSelect(dayRec) {
      if (!dayRec || !onSelectDay) return;
      lastCommittedDay = dayRec.day;
      lastPreviewedDay = dayRec.day;
      const pool = getActivePool();
      const idx = findPoolIndex(dayRec.day, pool);
      onSelectDay(dayRec.day, buildMeta(dayRec, idx, pool.length, filterMode));
    }

    function schedulePreview(dayRec) {
      if (!dayRec) return;
      pendingPreviewDay = dayRec;
      if (dragRafId !== null) return;
      dragRafId = requestFrame(() => {
        dragRafId = null;
        if (destroyed) return;
        const target = pendingPreviewDay;
        pendingPreviewDay = null;
        if (target) {
          emitPreview(target);
        }
      });
    }

    function scheduleDebouncedCommit(dayRec) {
      if (commitDebounceTimer !== null) {
        clearTimeout(commitDebounceTimer);
      }
      commitDebounceTimer = setTimeout(() => {
        commitDebounceTimer = null;
        if (destroyed || !dayRec) return;
        if (lastCommittedDay !== dayRec.day) {
          emitSelect(dayRec);
        }
      }, DRAG_COMMIT_DEBOUNCE_MS);
    }

    function findNearestDayForRatio(ratio) {
      const pool = getActivePool();
      if (pool.length === 0) return null;
      if (pool.length === 1) return pool[0];

      // Binary search for closest ratio in sorted pool
      let lo = 0;
      let hi = pool.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pool[mid].ratio < ratio) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      if (lo === 0) return pool[0];
      const prev = pool[lo - 1];
      const curr = pool[lo];
      return Math.abs(ratio - prev.ratio) <= Math.abs(curr.ratio - ratio) ? prev : curr;
    }

    function ratioFromClientX(clientX) {
      if (typeof trackInner.getBoundingClientRect !== 'function') return 0;
      const rect = trackInner.getBoundingClientRect();
      if (!rect || rect.width <= 0) return 0;
      return clamp((clientX - rect.left) / rect.width, 0, 1);
    }

    function scrubToClientX(clientX, { commitOnDebounce = true } = {}) {
      const ratio = ratioFromClientX(clientX);
      const nearest = findNearestDayForRatio(ratio);
      if (!nearest) return null;

      if (nearest.day !== activeDayIso) {
        activeDayIso = nearest.day;
        updateReadoutAndNeedle(nearest);
        playDetentSound();
        schedulePreview(nearest);
        if (commitOnDebounce) {
          scheduleDebouncedCommit(nearest);
        }
      } else {
        updateReadoutAndNeedle(nearest);
      }
      return nearest;
    }

    // Play / Pause timer lifecycle (zero runaway timers, 0% CPU when paused)
    function onGlobalKeyDownWhilePlaying(e) {
      if (e && e.key === 'Escape' && isPlaying) {
        pause();
      }
    }

    function onVisibilityChangeWhilePlaying() {
      if (doc && doc.hidden && isPlaying) {
        pause();
      }
    }

    function attachGlobalPlayListeners() {
      if (globalPlayListenersAttached) return;
      globalPlayListenersAttached = true;
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('keydown', onGlobalKeyDownWhilePlaying);
      } else if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', onGlobalKeyDownWhilePlaying);
      }
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChangeWhilePlaying);
      }
    }

    function detachGlobalPlayListeners() {
      if (!globalPlayListenersAttached) return;
      globalPlayListenersAttached = false;
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('keydown', onGlobalKeyDownWhilePlaying);
      } else if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', onGlobalKeyDownWhilePlaying);
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChangeWhilePlaying);
      }
    }

    function scheduleNextPlayTick() {
      if (!isPlaying || destroyed) return;
      if (playTimer !== null) {
        clearTimeout(playTimer);
        playTimer = null;
      }
      const intervalMs = speed === 2 ? PLAY_INTERVAL_2X_MS : PLAY_INTERVAL_1X_MS;
      playTimer = setTimeout(() => {
        playTimer = null;
        if (!isPlaying || destroyed) return;
        if ((doc && doc.hidden) || isElementHidden(root)) {
          pause();
          return;
        }

        const pool = getActivePool();
        if (pool.length === 0) {
          pause();
          return;
        }

        let nextIdx = -1;
        const curIdx = findPoolIndex(activeDayIso, pool);
        if (curIdx >= 0) {
          nextIdx = curIdx + 1;
        } else if (activeDayIso) {
          nextIdx = pool.findIndex((d) => d.day > activeDayIso);
          if (nextIdx < 0) {
            pause();
            return;
          }
        } else {
          nextIdx = 0;
        }

        if (nextIdx >= pool.length) {
          pause();
          return;
        }

        const nextRec = pool[nextIdx];
        activeDayIso = nextRec.day;
        updateReadoutAndNeedle(nextRec);
        playDetentSound();
        emitSelect(nextRec);

        if (nextIdx >= pool.length - 1) {
          // Reached end of year cleanly: pause after displaying the final stop
          pause();
          return;
        }
        scheduleNextPlayTick();
      }, intervalMs);
    }

    function pause() {
      if (playTimer !== null) {
        clearTimeout(playTimer);
        playTimer = null;
      }
      detachGlobalPlayListeners();
      if (!isPlaying) return false;
      isPlaying = false;
      syncTransportUi();
      if (onPlayStateChange) {
        onPlayStateChange(false);
      }
      return true;
    }

    function play() {
      if (destroyed) return false;
      const pool = getActivePool();
      if (pool.length < 2) return false;
      if (isPlaying) return true;

      clearPendingDragWork();
      clearWheelTimer();

      // If currently at the final stop (or unset), restart cleanly from index 0
      const curIdx = findPoolIndex(activeDayIso, pool);
      if (curIdx < 0 || curIdx >= pool.length - 1) {
        const startRec = pool[0];
        activeDayIso = startRec.day;
        updateReadoutAndNeedle(startRec);
        playDetentSound();
        emitSelect(startRec);
      }

      isPlaying = true;
      attachGlobalPlayListeners();
      syncTransportUi();
      if (onPlayStateChange) {
        onPlayStateChange(true);
      }
      scheduleNextPlayTick();
      return true;
    }

    function togglePlay() {
      return isPlaying ? pause() : play();
    }

    function step(delta) {
      if (destroyed) return null;
      const dNum = Number(delta);
      if (!Number.isFinite(dNum) || dNum === 0) return activeDayIso;

      if (isPlaying) pause();
      clearPendingDragWork();
      clearWheelTimer();

      const pool = getActivePool();
      if (pool.length === 0) return null;

      let targetIdx = findPoolIndex(activeDayIso, pool);
      if (targetIdx >= 0) {
        targetIdx = clamp(targetIdx + Math.trunc(dNum), 0, pool.length - 1);
      } else if (activeDayIso) {
        if (dNum > 0) {
          const nextGreater = pool.findIndex((item) => item.day > activeDayIso);
          targetIdx = nextGreater >= 0 ? clamp(nextGreater + Math.trunc(dNum) - 1, 0, pool.length - 1) : pool.length - 1;
        } else {
          let prevLess = -1;
          for (let i = pool.length - 1; i >= 0; i -= 1) {
            if (pool[i].day < activeDayIso) {
              prevLess = i;
              break;
            }
          }
          targetIdx = prevLess >= 0 ? clamp(prevLess + Math.trunc(dNum) + 1, 0, pool.length - 1) : 0;
        }
      } else {
        targetIdx = dNum > 0 ? 0 : pool.length - 1;
      }

      const nextRec = pool[targetIdx];
      if (!nextRec) return null;

      const changed = nextRec.day !== activeDayIso;
      activeDayIso = nextRec.day;
      updateReadoutAndNeedle(nextRec);
      if (changed) {
        playDetentSound();
        emitSelect(nextRec);
      }
      return activeDayIso;
    }

    function setFilter(nextMode) {
      const desired = nextMode === 'all' ? 'all' : 'gps';
      userExplicitFilter = true;
      filterMode = desired === 'gps' && gpsDays.length === 0 ? 'all' : desired;
      renderRuler();
      syncTransportUi();
      updateReadoutAndNeedle(findDayRecord(activeDayIso));
    }

    function setSpeed(nextSpeed) {
      speed = nextSpeed === 2 ? 2 : 1;
      syncTransportUi();
      if (isPlaying) {
        scheduleNextPlayTick();
      }
    }

    function setActiveDay(dayIso) {
      if (destroyed) return;
      const rec = findDayRecord(dayIso);
      if (!rec) return;
      activeDayIso = rec.day;
      lastCommittedDay = rec.day;
      lastPreviewedDay = rec.day;
      updateReadoutAndNeedle(rec);
    }

    function setDays(daysArray, nextActiveDayIso) {
      if (destroyed) return;
      pause();
      clearPendingDragWork();
      clearWheelTimer();

      const normalized = normalizeAndSortDays(daysArray);
      allDays = normalized.allDays;
      gpsDays = normalized.gpsDays;
      tripSpans = normalized.tripSpans;
      spanStartTs = normalized.spanStartTs;
      spanEndTs = normalized.spanEndTs;
      singleYear = normalized.singleYear;

      if (!userExplicitFilter) {
        filterMode = gpsDays.length > 0 ? 'gps' : 'all';
      } else if (filterMode === 'gps' && gpsDays.length === 0) {
        filterMode = 'all';
      }

      const pool = getActivePool();
      let chosen = null;
      if (nextActiveDayIso) {
        chosen = findDayRecord(nextActiveDayIso);
      }
      if (!chosen && activeDayIso) {
        chosen = findDayRecord(activeDayIso);
      }
      if (!chosen && pool.length > 0) {
        chosen = pool[0];
      }

      activeDayIso = chosen ? chosen.day : null;
      lastCommittedDay = activeDayIso;
      lastPreviewedDay = activeDayIso;

      renderRuler();
      syncTransportUi();
      updateReadoutAndNeedle(chosen);
    }

    // Event handlers
    function onPrevClick() {
      step(-1);
    }

    function onNextClick() {
      step(1);
    }

    function onPlayClick() {
      togglePlay();
    }

    function onSpeedClick() {
      setSpeed(speed === 1 ? 2 : 1);
    }

    function onFilterClick() {
      if (gpsDays.length === 0) return;
      setFilter(filterMode === 'gps' ? 'all' : 'gps');
    }

    function onTrackPointerDown(e) {
      if (destroyed || allDays.length === 0) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      if (isPlaying) pause();
      clearWheelTimer();

      isDragging = true;
      activePointerId = e.pointerId;
      track.classList.add('is-dragging');
      hoverLine.classList.remove('is-visible');

      if (typeof track.focus === 'function') {
        try {
          track.focus({ preventScroll: true });
        } catch (_) {
          track.focus();
        }
      }

      if (typeof track.setPointerCapture === 'function' && e.pointerId != null) {
        try {
          track.setPointerCapture(e.pointerId);
        } catch (_) {
          // Synthetic pointer events in tests may not have an active browser pointer
        }
      }

      scrubToClientX(e.clientX, { commitOnDebounce: true });
    }

    function onTrackPointerMove(e) {
      if (destroyed || allDays.length === 0) return;
      if (isDragging) {
        if (activePointerId != null && e.pointerId != null && e.pointerId !== activePointerId) return;
        scrubToClientX(e.clientX, { commitOnDebounce: true });
        return;
      }

      // Hover hairline preview on non-touch desktop pointers
      if (e.pointerType === 'mouse' || !e.pointerType) {
        const ratio = ratioFromClientX(e.clientX);
        const w = measureTrackWidth();
        if (w > 0) {
          hoverLine.style.transform = 'translate3d(' + (ratio * w).toFixed(2) + 'px, 0, 0)';
          hoverLine.classList.add('is-visible');
        }
      }
    }

    function finishPointerDrag(e, shouldCommit) {
      if (!isDragging) return;
      if (activePointerId != null && e && e.pointerId != null && e.pointerId !== activePointerId) return;

      isDragging = false;
      const releasedId = activePointerId;
      activePointerId = null;
      track.classList.remove('is-dragging');

      if (typeof track.releasePointerCapture === 'function' && releasedId != null) {
        try {
          track.releasePointerCapture(releasedId);
        } catch (_) {
          // Ignore if already released
        }
      }

      // Flush pending preview and cancel debounce timer
      const pending = pendingPreviewDay;
      clearPendingDragWork();
      if (pending && shouldCommit) {
        emitPreview(pending);
      }

      if (shouldCommit && activeDayIso) {
        const rec = findDayRecord(activeDayIso);
        if (rec && lastCommittedDay !== rec.day) {
          emitSelect(rec);
        }
      }
    }

    function onTrackPointerUp(e) {
      finishPointerDrag(e, true);
    }

    function onTrackPointerCancel(e) {
      finishPointerDrag(e, false);
    }

    function onTrackPointerLeave() {
      hoverLine.classList.remove('is-visible');
    }

    function onTrackWheel(e) {
      if (destroyed || allDays.length === 0) return;
      const absX = Math.abs(e.deltaX || 0);
      const absY = Math.abs(e.deltaY || 0);
      const isFocused = doc && doc.activeElement === track;
      const isHorizontalIntent = absX > absY && absX >= 2;
      const isShiftWheel = Boolean(e.shiftKey) && absY >= 2;

      if (!isHorizontalIntent && !isShiftWheel && !isFocused) {
        return;
      }

      if (typeof e.preventDefault === 'function') {
        e.preventDefault();
      }
      if (isPlaying) pause();

      const rawDelta = isHorizontalIntent ? e.deltaX : e.deltaY;
      wheelAccum += rawDelta;

      if (Math.abs(wheelAccum) >= WHEEL_STEP_THRESHOLD) {
        const steps = wheelAccum > 0
          ? Math.floor(wheelAccum / WHEEL_STEP_THRESHOLD)
          : Math.ceil(wheelAccum / WHEEL_STEP_THRESHOLD);
        wheelAccum -= steps * WHEEL_STEP_THRESHOLD;

        const pool = getActivePool();
        if (pool.length === 0) return;

        let curIdx = findPoolIndex(activeDayIso, pool);
        if (curIdx < 0) curIdx = 0;
        const nextIdx = clamp(curIdx + steps, 0, pool.length - 1);
        const nextRec = pool[nextIdx];
        if (nextRec && nextRec.day !== activeDayIso) {
          activeDayIso = nextRec.day;
          updateReadoutAndNeedle(nextRec);
          playDetentSound();
          schedulePreview(nextRec);
          clearWheelTimer();
          wheelCommitTimer = setTimeout(() => {
            wheelCommitTimer = null;
            if (!destroyed && activeDayIso && lastCommittedDay !== activeDayIso) {
              const committedRec = findDayRecord(activeDayIso);
              if (committedRec) emitSelect(committedRec);
            }
          }, DRAG_COMMIT_DEBOUNCE_MS);
        }
      }
    }

    function onTrackKeyDown(e) {
      if (destroyed || !e) return;
      const pool = getActivePool();
      if (e.key === 'Escape') {
        if (isPlaying) {
          e.preventDefault();
          pause();
        }
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (pool.length === 0) return;

      const jump = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        step(-jump);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        step(jump);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        step(-5);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        step(5);
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (isPlaying) pause();
        const first = pool[0];
        if (first && first.day !== activeDayIso) {
          activeDayIso = first.day;
          updateReadoutAndNeedle(first);
          playDetentSound();
          emitSelect(first);
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        if (isPlaying) pause();
        const last = pool[pool.length - 1];
        if (last && last.day !== activeDayIso) {
          activeDayIso = last.day;
          updateReadoutAndNeedle(last);
          playDetentSound();
          emitSelect(last);
        }
      }
    }

    function onWindowResize() {
      if (destroyed) return;
      const rec = findDayRecord(activeDayIso);
      if (rec) positionNeedle(rec.ratio);
    }

    // Bind listeners
    prevBtn.addEventListener('click', onPrevClick);
    nextBtn.addEventListener('click', onNextClick);
    playBtn.addEventListener('click', onPlayClick);
    speedBtn.addEventListener('click', onSpeedClick);
    filterBtn.addEventListener('click', onFilterClick);

    track.addEventListener('pointerdown', onTrackPointerDown);
    track.addEventListener('pointermove', onTrackPointerMove);
    track.addEventListener('pointerup', onTrackPointerUp);
    track.addEventListener('pointercancel', onTrackPointerCancel);
    track.addEventListener('pointerleave', onTrackPointerLeave);
    track.addEventListener('wheel', onTrackWheel, { passive: false });
    track.addEventListener('keydown', onTrackKeyDown);

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (destroyed) return;
        const rec = findDayRecord(activeDayIso);
        if (rec) positionNeedle(rec.ratio);
      });
      resizeObserver.observe(trackInner);
    } else if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', onWindowResize);
    }

    if (typeof IntersectionObserver === 'function') {
      intersectionObserver = new IntersectionObserver((entries) => {
        if (!isPlaying || destroyed) return;
        for (let i = 0; i < entries.length; i += 1) {
          if (entries[i].target === root && !entries[i].isIntersecting) {
            pause();
            break;
          }
        }
      }, { threshold: 0 });
      intersectionObserver.observe(root);
    }

    syncTransportUi();

    function destroy() {
      if (destroyed) return;
      pause();
      destroyed = true;
      clearPendingDragWork();
      clearWheelTimer();

      prevBtn.removeEventListener('click', onPrevClick);
      nextBtn.removeEventListener('click', onNextClick);
      playBtn.removeEventListener('click', onPlayClick);
      speedBtn.removeEventListener('click', onSpeedClick);
      filterBtn.removeEventListener('click', onFilterClick);

      track.removeEventListener('pointerdown', onTrackPointerDown);
      track.removeEventListener('pointermove', onTrackPointerMove);
      track.removeEventListener('pointerup', onTrackPointerUp);
      track.removeEventListener('pointercancel', onTrackPointerCancel);
      track.removeEventListener('pointerleave', onTrackPointerLeave);
      track.removeEventListener('wheel', onTrackWheel);
      track.removeEventListener('keydown', onTrackKeyDown);

      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      } else if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('resize', onWindowResize);
      }
      if (intersectionObserver) {
        intersectionObserver.disconnect();
        intersectionObserver = null;
      }
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    }

    function getState() {
      const pool = getActivePool();
      return {
        destroyed,
        playing: isPlaying,
        speed,
        filter: filterMode,
        activeDay: activeDayIso,
        totalDays: allDays.length,
        gpsDays: gpsDays.length,
        poolDays: pool.length,
        orderedDays: allDays.map((d) => d.day),
        poolOrder: pool.map((d) => d.day),
        tripDays: allDays.filter((d) => d.is_trip).map((d) => d.day),
      };
    }

    return {
      setDays,
      setActiveDay,
      play,
      pause,
      togglePlay,
      step,
      setFilter,
      setSpeed,
      getState,
      destroy,
    };
  }

  const api = {
    mount,
    _normalizeAndSortDays: normalizeAndSortDays,
    _formatCoords: formatCoords,
    _formatReadoutDate: formatReadoutDate,
  };

  if (typeof global !== 'undefined' && global) {
    global.KizukiReplayScrubber = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
