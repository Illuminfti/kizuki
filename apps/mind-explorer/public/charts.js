/* ==========================================================================
   KIZUKI MIND EXPLORER - INTERACTIVE DATA VISUALIZATIONS & MICRO-CHARTS
   Vercel Geist / Bloomberg / Linear Dual-Polarity Inline SVG Engine
   Pure SVG + lightweight delegated tooltip engine. Zero external libraries.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiCharts = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const EM_DASH_SPACED_RE = /\s*\u2014\s*/g;
  const EM_DASH_RAW_RE = /\u2014/g;
  let clipIdCounter = 0;

  function nextClipId(prefix) {
    clipIdCounter = (clipIdCounter + 1) % 1000000;
    return prefix + '-' + clipIdCounter;
  }

  function stripEmDash(str) {
    return String(str == null ? '' : str)
      .replace(EM_DASH_SPACED_RE, ' - ')
      .replace(EM_DASH_RAW_RE, '-');
  }

  function escapeHtml(str) {
    return stripEmDash(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeNum(val, fallback) {
    if (val === null || val === undefined || val === '') {
      return fallback === undefined ? 0 : fallback;
    }
    const n = Number(val);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function nullableNum(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(val, min, max, fallback) {
    const n = safeNum(val, fallback);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function fmt(val, digits) {
    const n = safeNum(val, 0);
    const d = digits == null ? 2 : digits;
    const fixed = Number(n.toFixed(d));
    return Object.is(fixed, -0) ? '0' : String(fixed);
  }

  function truncate(str, maxLen) {
    const clean = stripEmDash(str).trim();
    if (!maxLen || clean.length <= maxLen) return clean;
    if (maxLen <= 2) return clean.slice(0, maxLen);
    const budget = maxLen - 1;
    const head = clean.slice(0, budget);
    if (clean.charAt(budget) && !/[\s\/\-]/.test(clean.charAt(budget))) {
      const m = head.match(/^(.*?)[\s\/\-]+[^\s\/\-]*$/);
      if (m && m[1].length >= Math.floor(budget * 0.45)) {
        return m[1].replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
      }
    }
    return head.replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
  }

  function pad2(n) {
    const v = Math.max(0, Math.floor(safeNum(n, 0)));
    return v < 10 ? '0' + v : String(v);
  }

  function polarPoint(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * r,
      y: cy + Math.sin(rad) * r,
    };
  }

  function describeArc(cx, cy, r, startDeg, endDeg) {
    const sweep = endDeg - startDeg;
    if (!Number.isFinite(sweep) || Math.abs(sweep) < 0.05) return '';
    const clampedEnd = Math.abs(sweep) >= 359.9 ? startDeg + 359.9 * Math.sign(sweep) : endDeg;
    const start = polarPoint(cx, cy, r, startDeg);
    const end = polarPoint(cx, cy, r, clampedEnd);
    const largeArc = Math.abs(clampedEnd - startDeg) > 180 ? 1 : 0;
    const sweepFlag = clampedEnd >= startDeg ? 1 : 0;
    return (
      'M ' + fmt(start.x) + ' ' + fmt(start.y) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 ' + largeArc + ' ' + sweepFlag + ' ' +
      fmt(end.x) + ' ' + fmt(end.y)
    );
  }

  // =========================================================================
  // 1. WHOOP RECOVERY 220-DEGREE RADIAL ARC GAUGE
  // =========================================================================

  function renderWhoopGaugeSvg(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const rawRec = o.recovery !== undefined ? o.recovery : o.recovery_pct;
    const rawHrv = o.hrv !== undefined ? o.hrv : o.hrv_ms;
    const rawSleep = o.sleepHours !== undefined ? o.sleepHours : o.sleep_hours;
    const rawRhr = o.rhr !== undefined ? o.rhr : o.rhr_bpm;

    const recNum = nullableNum(rawRec);
    const hasRec = recNum !== null;
    const pct = hasRec ? Math.round(clamp(recNum, 0, 100, 0)) : null;

    const hrvNum = nullableNum(rawHrv);
    const sleepNum = nullableNum(rawSleep);
    const rhrNum = nullableNum(rawRhr);

    const requestedSize = nullableNum(o.size);
    const compact = requestedSize !== null && requestedSize <= 94;
    const hideSubRow = o.hideSubRow === true || (o.hideSubRow !== false && requestedSize !== null && requestedSize <= 88);
    const vbW = compact ? 88 : 112;
    const vbH = compact ? 64 : (hideSubRow ? 70 : 78);
    const outW = requestedSize !== null ? Math.round(clamp(requestedSize, 56, 240, vbW)) : vbW;
    const outH = Math.round((outW * vbH) / vbW);

    // 220-degree sweep centered symmetrically at top apex (270 deg): 160 deg -> 380 deg
    const startDeg = 160;
    const sweepDeg = 220;
    const endDeg = startDeg + sweepDeg;

    const hasSubTelemetry = !hideSubRow && !compact && (hrvNum !== null || sleepNum !== null || rhrNum !== null);
    const cx = vbW / 2;
    const cy = compact ? 38.5 : (hasSubTelemetry ? 44.5 : 47);
    const radius = compact ? 27.5 : (hasSubTelemetry ? 33.5 : 35.5);
    const strokeW = compact ? 4.5 : 5.25;

    let zoneKey = 'none';
    let zoneLabel = 'No reading';
    let arcColor = 'var(--ink-muted, #737373)';
    if (hasRec) {
      if (pct >= 67) {
        zoneKey = 'green';
        zoneLabel = 'Green';
        arcColor = 'var(--k-whoop-green, #34d399)';
      } else if (pct >= 34) {
        zoneKey = 'amber';
        zoneLabel = 'Amber';
        arcColor = 'var(--k-whoop-amber, #f59e0b)';
      } else {
        zoneKey = 'red';
        zoneLabel = 'Red';
        arcColor = 'var(--k-whoop-red, #f87171)';
      }
    }

    const trackPath = describeArc(cx, cy, radius, startDeg, endDeg);

    // Calibrated threshold ticks at 0%, 34%, 67%, 100%
    const tickFractions = [0, 0.34, 0.67, 1];
    const ticksSvg = tickFractions.map(function (frac) {
      const angle = startDeg + frac * sweepDeg;
      const inner = polarPoint(cx, cy, radius + strokeW * 0.5 + 1.4, angle);
      const outer = polarPoint(cx, cy, radius + strokeW * 0.5 + (compact ? 3.4 : 4.2), angle);
      const isZoneBoundary = frac > 0 && frac < 1;
      const stroke = isZoneBoundary
        ? 'var(--border-strong, rgba(255, 255, 255, 0.22))'
        : 'var(--border-hairline, rgba(255, 255, 255, 0.12))';
      return (
        '<line class="k-whoop-tick" x1="' + fmt(inner.x) + '" y1="' + fmt(inner.y) + '" ' +
          'x2="' + fmt(outer.x) + '" y2="' + fmt(outer.y) + '" ' +
          'stroke="' + stroke + '" stroke-width="1" stroke-linecap="round" />'
      );
    }).join('');

    let valueArcSvg = '';
    if (hasRec) {
      const fillEndDeg = startDeg + (pct / 100) * sweepDeg;
      if (pct > 0) {
        const fillPath = describeArc(cx, cy, radius, startDeg, fillEndDeg);
        valueArcSvg +=
          '<path class="k-whoop-fill is-' + zoneKey + '" d="' + fillPath + '" ' +
            'fill="none" stroke="' + arcColor + '" stroke-width="' + fmt(strokeW) + '" ' +
            'stroke-linecap="round" />';
      }
      const tipPt = polarPoint(cx, cy, radius, fillEndDeg);
      valueArcSvg +=
        '<circle class="k-whoop-knob is-' + zoneKey + '" cx="' + fmt(tipPt.x) + '" cy="' + fmt(tipPt.y) + '" ' +
          'r="' + fmt(compact ? 2.1 : 2.5) + '" fill="' + arcColor + '" ' +
          'stroke="var(--surface-raised, #0a0a0a)" stroke-width="1.2" />';
    }

    const valFontSize = compact ? 15.5 : 19;
    const pctFontSize = compact ? 9.5 : 11;
    const valY = compact ? (cy + 3.5) : (cy + 3.5);
    const captionY = compact ? (cy + 15.5) : (cy + 16);

    const centerValueSvg = hasRec
      ? (
        '<text class="k-whoop-value" x="' + fmt(cx) + '" y="' + fmt(valY) + '" text-anchor="middle" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="' + fmt(valFontSize) + '" ' +
          'font-weight="600" font-variant-numeric="tabular-nums" fill="var(--ink-primary, #ededed)">' +
          pct +
          '<tspan font-size="' + fmt(pctFontSize) + '" font-weight="500" fill="var(--ink-secondary, #a1a1a1)">%</tspan>' +
        '</text>'
      )
      : (
        '<text class="k-whoop-value is-empty" x="' + fmt(cx) + '" y="' + fmt(valY) + '" text-anchor="middle" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="' + fmt(valFontSize) + '" ' +
          'font-weight="500" font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">--</text>'
      );

    let subTelemetrySvg = '';
    if (hasSubTelemetry) {
      const miniParts = [];
      if (hrvNum !== null) miniParts.push('HRV ' + Math.round(clamp(hrvNum, 0, 500, 0)));
      if (sleepNum !== null) miniParts.push(fmt(clamp(sleepNum, 0, 24, 0), 1) + 'h');
      if (miniParts.length < 2 && rhrNum !== null) miniParts.push(Math.round(clamp(rhrNum, 20, 220, 0)) + 'bpm');
      if (miniParts.length > 0) {
        subTelemetrySvg =
          '<text class="k-whoop-sub" x="' + fmt(cx) + '" y="73.5" text-anchor="middle" ' +
            'font-family="var(--font-mono, ui-monospace, monospace)" font-size="8" font-weight="500" ' +
            'font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">' +
            escapeHtml(miniParts.join(' \u00b7 ')) +
          '</text>';
      }
    }

    const tipParts = [
      hasRec ? ('Whoop Recovery: ' + pct + '% (' + zoneLabel + ')') : 'Whoop Recovery: No reading',
    ];
    if (hrvNum !== null) tipParts.push('HRV ' + Math.round(clamp(hrvNum, 0, 500, 0)) + ' ms');
    if (sleepNum !== null) tipParts.push('Sleep ' + fmt(clamp(sleepNum, 0, 24, 0), 1) + ' h');
    if (rhrNum !== null) tipParts.push('RHR ' + Math.round(clamp(rhrNum, 20, 220, 0)) + ' bpm');
    const tipText = tipParts.join(' | ');

    return (
      '<svg class="k-whoop-gauge is-' + zoneKey + '" viewBox="0 0 ' + vbW + ' ' + vbH + '" ' +
        'width="' + outW + '" height="' + outH + '" role="img" aria-label="' + escapeHtml(tipText) + '" ' +
        'data-viz-tip="' + escapeHtml(tipText) + '" data-tooltip="' + escapeHtml(tipText) + '" ' +
        'style="display:block;overflow:visible;flex-shrink:0;">' +
        '<g class="k-whoop-ticks">' + ticksSvg + '</g>' +
        '<path class="k-whoop-track" d="' + trackPath + '" fill="none" ' +
          'stroke="var(--border-hairline, rgba(255, 255, 255, 0.11))" ' +
          'stroke-width="' + fmt(strokeW) + '" stroke-linecap="round" />' +
        valueArcSvg +
        centerValueSvg +
        '<text class="k-whoop-caption" x="' + fmt(cx) + '" y="' + fmt(captionY) + '" text-anchor="middle" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="' + (compact ? '7.5' : '8') + '" ' +
          'font-weight="500" letter-spacing="0.12em" fill="var(--ink-muted, #737373)">REC</text>' +
        subTelemetrySvg +
      '</svg>'
    );
  }

  // =========================================================================
  // 2. REPLAY 24-HOUR DAY RHYTHM MICRO-CHART (640 x 76)
  // =========================================================================

  const RHYTHM_LANES = {
    work: {
      key: 'work',
      label: 'Work',
      shortUnit: 'work',
      color: 'var(--accent-violet, #a78bfa)',
    },
    comms: {
      key: 'comms',
      label: 'Comms',
      shortUnit: 'msgs',
      color: 'var(--accent-sky, #38bdf8)',
    },
    meetings: {
      key: 'meetings',
      label: 'Mtgs',
      shortUnit: 'mtg',
      color: 'var(--accent-amber, #f5a623)',
    },
    location: {
      key: 'location',
      label: 'Places',
      shortUnit: 'loc',
      color: 'var(--k-rhythm-loc, #34d399)',
    },
  };

  function parseHourFromValue(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number' && Number.isFinite(val)) {
      if (val >= 0 && val <= 23 && Number.isInteger(val)) return val;
      if (val > 1e9) {
        const d = new Date(val > 1e12 ? val : val * 1000);
        return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
      }
      return null;
    }
    const s = String(val).trim();
    if (!s) return null;

    // Direct HH:MM or HH:MM:SS (with optional AM/PM)
    const hhmmMatch = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap]m))?$/i);
    if (hhmmMatch) {
      let h = Number(hhmmMatch[1]);
      const m = Number(hhmmMatch[2]);
      const ampm = hhmmMatch[3] ? hhmmMatch[3].toLowerCase() : '';
      if (m < 0 || m > 59) return null;
      if (ampm) {
        if (h < 1 || h > 12) return null;
        if (ampm === 'pm' && h !== 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
      }
      return h >= 0 && h <= 23 ? h : null;
    }

    // ISO-like YYYY-MM-DD[T ]HH:MM
    const isoMatch = s.match(/\d{4}-\d{2}-\d{2}[T\s](\d{2}):(\d{2})/);
    if (isoMatch) {
      const h = Number(isoMatch[1]);
      const m = Number(isoMatch[2]);
      return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? h : null;
    }

    // Fallback generic Date parse
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) {
      const d = new Date(parsed);
      return d.getHours();
    }
    return null;
  }

  function extractItemHour(item) {
    if (!item || typeof item !== 'object') return null;
    const candidates = [item.hhmm, item.time, item.start_time, item.timestamp, item.ts, item.at, item.hour];
    for (let i = 0; i < candidates.length; i += 1) {
      const h = parseHourFromValue(candidates[i]);
      if (h !== null) return h;
    }
    return null;
  }

  function mapTimelineKindToLane(kind) {
    const k = String(kind == null ? '' : kind).toLowerCase().trim();
    if (k === 'work' || k === 'doc' || k === 'docs' || k === 'code' || k === 'commit') return 'work';
    if (k === 'comms' || k === 'comm' || k === 'message' || k === 'messages' || k === 'chat' || k === 'email') return 'comms';
    if (k === 'meeting' || k === 'meetings' || k === 'calendar' || k === 'event') return 'meetings';
    if (k === 'place' || k === 'places' || k === 'photo' || k === 'photos' || k === 'location' || k === 'gps') return 'location';
    return null;
  }

  function bucketDayRhythm(dayPacket) {
    const pkt = dayPacket && typeof dayPacket === 'object' ? dayPacket : {};

    function makeEmpty24() {
      const arr = [];
      for (let h = 0; h < 24; h += 1) {
        arr.push({ work: 0, comms: 0, meetings: 0, location: 0, photos: 0 });
      }
      return arr;
    }

    const dedicated = makeEmpty24();
    const fromTimeline = makeEmpty24();
    const laneSeenInDedicated = { work: false, comms: false, meetings: false, location: false };

    // 1. Dedicated lane arrays
    if (Array.isArray(pkt.work)) {
      for (let i = 0; i < pkt.work.length; i += 1) {
        const item = pkt.work[i];
        const h = extractItemHour(item);
        if (h === null) continue;
        const weight = Math.max(1, Math.min(50, Math.round(safeNum(item.count, 1))));
        dedicated[h].work += weight;
        laneSeenInDedicated.work = true;
      }
    }

    if (Array.isArray(pkt.docs)) {
      for (let i = 0; i < pkt.docs.length; i += 1) {
        const h = extractItemHour(pkt.docs[i]);
        if (h === null) continue;
        dedicated[h].work += 1;
        laneSeenInDedicated.work = true;
      }
    }

    if (Array.isArray(pkt.comms)) {
      for (let i = 0; i < pkt.comms.length; i += 1) {
        const item = pkt.comms[i];
        const h = extractItemHour(item);
        if (h === null) continue;
        const weight = Math.max(1, Math.min(50, Math.round(safeNum(item.count, 1))));
        dedicated[h].comms += weight;
        laneSeenInDedicated.comms = true;
      }
    }

    if (Array.isArray(pkt.meetings)) {
      for (let i = 0; i < pkt.meetings.length; i += 1) {
        const h = extractItemHour(pkt.meetings[i]);
        if (h === null) continue;
        dedicated[h].meetings += 1;
        laneSeenInDedicated.meetings = true;
      }
    }

    if (Array.isArray(pkt.places)) {
      for (let i = 0; i < pkt.places.length; i += 1) {
        const item = pkt.places[i];
        const h = extractItemHour(item);
        if (h === null) continue;
        const photos = Math.max(0, Math.min(50, Math.round(safeNum(item.photo_count, 0))));
        dedicated[h].location += 1;
        dedicated[h].photos += photos;
        laneSeenInDedicated.location = true;
      }
    }

    // Optional timestamped people entries if no comms array was provided
    if (!laneSeenInDedicated.comms && Array.isArray(pkt.people)) {
      for (let i = 0; i < pkt.people.length; i += 1) {
        const item = pkt.people[i];
        const h = extractItemHour(item);
        if (h === null) continue;
        const weight = Math.max(1, Math.min(50, Math.round(safeNum(item.count, 1))));
        dedicated[h].comms += weight;
        laneSeenInDedicated.comms = true;
      }
    }

    // 2. Unified timeline fallback (fills any lane not present in dedicated arrays,
    //    and captures extra hours without double-counting)
    if (Array.isArray(pkt.timeline)) {
      for (let i = 0; i < pkt.timeline.length; i += 1) {
        const item = pkt.timeline[i];
        const h = extractItemHour(item);
        if (h === null) continue;
        const lane = mapTimelineKindToLane(item && item.kind);
        if (!lane) continue;
        fromTimeline[h][lane] += 1;
      }
    }

    // 3. Merge per-hour per-lane using Math.max to eliminate double-counting while
    //    preserving timeline-only lanes (e.g. comms present in timeline when comms[] omitted)
    const buckets = [];
    let maxTotal = 0;
    let totalEvents = 0;
    let peakHour = -1;

    for (let h = 0; h < 24; h += 1) {
      const work = laneSeenInDedicated.work
        ? Math.max(dedicated[h].work, fromTimeline[h].work)
        : fromTimeline[h].work;
      const comms = laneSeenInDedicated.comms
        ? Math.max(dedicated[h].comms, fromTimeline[h].comms)
        : fromTimeline[h].comms;
      const meetings = laneSeenInDedicated.meetings
        ? Math.max(dedicated[h].meetings, fromTimeline[h].meetings)
        : fromTimeline[h].meetings;
      const location = laneSeenInDedicated.location
        ? Math.max(dedicated[h].location, fromTimeline[h].location)
        : fromTimeline[h].location;
      const photos = dedicated[h].photos;

      const locScore = location + (photos > 0 ? Math.min(photos, 6) : 0);
      const total = work + comms + meetings + location;

      // Pick dominant lane (tie-break: meetings > work > comms > location)
      let dominant = 'work';
      let bestScore = -1;
      const order = [
        { k: 'meetings', v: meetings },
        { k: 'work', v: work },
        { k: 'comms', v: comms },
        { k: 'location', v: locScore > 0 ? Math.max(location, photos > 0 ? 1 : 0) : 0 },
      ];
      for (let j = 0; j < order.length; j += 1) {
        if (order[j].v > bestScore) {
          bestScore = order[j].v;
          dominant = order[j].k;
        }
      }

      if (total > maxTotal) {
        maxTotal = total;
        peakHour = h;
      }
      totalEvents += total;

      buckets.push({
        hour: h,
        work: work,
        comms: comms,
        meetings: meetings,
        location: location,
        photos: photos,
        total: total,
        dominant: dominant,
      });
    }

    return {
      buckets: buckets,
      maxTotal: maxTotal,
      totalEvents: totalEvents,
      peakHour: peakHour,
    };
  }

  function formatHourTooltip(b) {
    const startLbl = pad2(b.hour) + ':00';
    const endLbl = pad2(b.hour + 1) + ':00';
    const parts = [];
    if (b.work > 0) parts.push(b.work + ' work');
    if (b.comms > 0) parts.push(b.comms + (b.comms === 1 ? ' msg' : ' msgs'));
    if (b.meetings > 0) parts.push(b.meetings + (b.meetings === 1 ? ' mtg' : ' mtgs'));
    if (b.location > 0) {
      const locTxt = b.location + (b.location === 1 ? ' place' : ' places');
      parts.push(b.photos > 0 ? (locTxt + ', ' + b.photos + (b.photos === 1 ? ' photo' : ' photos')) : locTxt);
    }
    return startLbl + ' - ' + endLbl + ': ' + (parts.length ? parts.join(', ') : '0 events');
  }

  function renderDayRhythmSvg(dayPacket) {
    const data = bucketDayRhythm(dayPacket);
    const W = 640;
    const H = 58;
    const plotLeft = 10;
    const plotRight = 630;
    const plotTop = 6;
    const plotBottom = 42;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;
    const slotW = plotW / 24;
    const barW = 16;

    // Responsive HTML header strip above the SVG: lane legend + peak readout
    const legendItems = [
      { key: 'work', label: 'Work', color: RHYTHM_LANES.work.color },
      { key: 'comms', label: 'Comms', color: RHYTHM_LANES.comms.color },
      { key: 'meetings', label: 'Mtgs', color: RHYTHM_LANES.meetings.color },
      { key: 'location', label: 'Places', color: RHYTHM_LANES.location.color },
    ];
    const headerLegendHtml = legendItems.map(function (it) {
      return (
        '<span class="k-rhythm-legend-item" style="display:inline-flex;align-items:center;gap:5px;">' +
          '<span style="width:6px;height:6px;border-radius:999px;background:' + it.color + ';flex-shrink:0;" aria-hidden="true"></span>' +
          '<span>' + escapeHtml(it.label) + '</span>' +
        '</span>'
      );
    }).join('');

    let peakCalloutHtml = '';
    if (data.peakHour >= 0 && data.maxTotal > 0) {
      const peakStart = pad2(data.peakHour) + ':00';
      const peakEnd = pad2(data.peakHour + 1) + ':00';
      const peakLabel = 'PEAK ' + peakStart + '-' + peakEnd + ' \u00b7 ' + data.maxTotal + ' / ' + data.totalEvents + ' total';
      peakCalloutHtml =
        '<span class="k-rhythm-peak-label" style="color:var(--ink-secondary, #a1a1a1);font-weight:500;">' +
          escapeHtml(peakLabel) +
        '</span>';
    } else {
      peakCalloutHtml =
        '<span class="k-rhythm-peak-label is-empty" style="color:var(--ink-muted, #737373);font-weight:500;">24H QUIET DAY</span>';
    }

    const headerBarHtml =
      '<div class="k-rhythm-meta-bar" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;margin-bottom:8px;font-family:var(--font-mono, ui-monospace, monospace);font-size:var(--t-xs, 11px);line-height:1.35;font-variant-numeric:tabular-nums;">' +
        '<div class="k-rhythm-legend" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;color:var(--ink-muted, #737373);">' +
          headerLegendHtml +
        '</div>' +
        peakCalloutHtml +
      '</div>';

    // Subtle quarter-day vertical hairlines (06:00, 12:00, 18:00) + mid horizontal dashed guide
    const gridSvg = [6, 12, 18].map(function (hr) {
      const gx = plotLeft + hr * slotW;
      return (
        '<line x1="' + fmt(gx) + '" y1="' + plotTop + '" x2="' + fmt(gx) + '" y2="' + plotBottom + '" ' +
          'stroke="var(--border-subtle, rgba(255, 255, 255, 0.055))" stroke-width="1" />'
      );
    }).join('') +
      '<line x1="' + plotLeft + '" y1="' + fmt(plotTop + plotH * 0.5) + '" x2="' + plotRight + '" y2="' + fmt(plotTop + plotH * 0.5) + '" ' +
        'stroke="var(--border-subtle, rgba(255, 255, 255, 0.055))" stroke-dasharray="2 3" stroke-width="1" />' +
      '<line x1="' + plotLeft + '" y1="' + plotBottom + '" x2="' + plotRight + '" y2="' + plotBottom + '" ' +
        'stroke="var(--border-strong, rgba(255, 255, 255, 0.16))" stroke-width="1" />';

    // 24 vertical bars
    const scaleMax = data.maxTotal > 0 ? data.maxTotal : 1;
    const barsSvg = data.buckets.map(function (b) {
      const slotX = plotLeft + b.hour * slotW;
      const bx = slotX + (slotW - barW) / 2;
      const isPeak = b.hour === data.peakHour && b.total > 0;

      if (b.total <= 0) {
        return (
          '<rect class="k-rhythm-bar is-empty" data-hour="' + b.hour + '" ' +
            'x="' + fmt(bx) + '" y="' + fmt(plotBottom - 2) + '" width="' + fmt(barW) + '" height="2" rx="1" ' +
            'fill="var(--border-hairline, rgba(255, 255, 255, 0.09))" />'
        );
      }

      const rawH = (b.total / scaleMax) * (plotH - 3);
      const barH = Math.max(4, Math.min(plotH - 2, rawH));
      const by = plotBottom - barH;
      const laneMeta = RHYTHM_LANES[b.dominant] || RHYTHM_LANES.work;
      const tip = formatHourTooltip(b);
      const escapedTip = escapeHtml(tip);

      const peakDot = isPeak
        ? '<circle class="k-rhythm-peak-dot" cx="' + fmt(bx + barW / 2) + '" cy="' + fmt(Math.max(plotTop - 2, by - 3.5)) + '" r="1.8" fill="' + laneMeta.color + '" />'
        : '';

      return (
        '<g class="k-rhythm-bar is-active is-' + laneMeta.key + (isPeak ? ' is-peak' : '') + '" ' +
          'data-hour="' + b.hour + '" data-lane="' + laneMeta.key + '" ' +
          'data-tooltip="' + escapedTip + '" data-viz-tip="' + escapedTip + '" ' +
          'tabindex="0" role="img" aria-label="' + escapedTip + '" style="cursor:pointer;">' +
          '<rect x="' + fmt(slotX) + '" y="' + fmt(plotTop - 2) + '" width="' + fmt(slotW) + '" height="' + fmt(plotH + 3) + '" fill="transparent" />' +
          '<rect class="k-rhythm-rect" x="' + fmt(bx) + '" y="' + fmt(by) + '" width="' + fmt(barW) + '" height="' + fmt(barH) + '" rx="2" ' +
            'fill="' + laneMeta.color + '" fill-opacity="' + (isPeak ? '0.96' : '0.82') + '" />' +
          peakDot +
        '</g>'
      );
    }).join('');

    const emptyNoticeSvg = data.totalEvents === 0
      ? (
        '<text x="' + (W / 2) + '" y="' + fmt(plotTop + plotH / 2 + 2) + '" text-anchor="middle" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="9.5" fill="var(--ink-muted, #737373)">' +
          'No timestamped events recorded for this day' +
        '</text>'
      )
      : '';

    // Clean 6-hour time ticks: 00:00, 06:00, 12:00, 18:00, 24:00
    const ticks = [
      { label: '00:00', x: plotLeft, anchor: 'start' },
      { label: '06:00', x: plotLeft + 6 * slotW, anchor: 'middle' },
      { label: '12:00', x: plotLeft + 12 * slotW, anchor: 'middle' },
      { label: '18:00', x: plotLeft + 18 * slotW, anchor: 'middle' },
      { label: '24:00', x: plotRight, anchor: 'end' },
    ];
    const ticksSvg = ticks.map(function (t) {
      return (
        '<text x="' + fmt(t.x) + '" y="54" text-anchor="' + t.anchor + '" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="9" font-weight="500" ' +
          'font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">' +
          t.label +
        '</text>'
      );
    }).join('');

    const dayStr = dayPacket && dayPacket.day ? stripEmDash(dayPacket.day) : 'selected day';
    const ariaLabel = '24-hour activity rhythm for ' + dayStr + ': ' + data.totalEvents + ' total events';

    return (
      '<div class="k-day-rhythm-wrap">' +
        headerBarHtml +
        '<svg class="k-day-rhythm-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" ' +
          'role="img" aria-label="' + escapeHtml(ariaLabel) + '" ' +
          'style="display:block;width:100%;height:auto;overflow:visible;">' +
          '<g class="k-rhythm-grid">' + gridSvg + '</g>' +
          '<g class="k-rhythm-bars">' + barsSvg + '</g>' +
          emptyNoticeSvg +
          '<g class="k-rhythm-ticks">' + ticksSvg + '</g>' +
        '</svg>' +
      '</div>'
    );
  }

  // =========================================================================
  // 3. CODEX IDEAS INCUBATOR PIPELINE FUNNEL (640 x 76)
  // =========================================================================

  const CODEX_STAGE_META = [
    { key: 'spark', label: 'Spark', color: 'var(--ink-secondary, #a1a1a1)' },
    { key: 'validating', label: 'Validating', color: 'var(--accent-amber, #f5a623)' },
    { key: 'building', label: 'Building', color: 'var(--accent-blue, #3291ff)' },
    { key: 'shipped', label: 'Shipped', color: 'var(--accent-green, #46a758)' },
    { key: 'parked', label: 'Parked', color: 'var(--ink-faint, #666666)' },
  ];

  function renderCodexFunnelSvg(stages, opts) {
    const src = stages && typeof stages === 'object' ? stages : {};
    const activeStage = String(
      (opts && opts.activeStage) || src.activeStage || src.active || ''
    ).toLowerCase().trim();

    const items = CODEX_STAGE_META.map(function (meta) {
      const count = Math.max(0, Math.round(safeNum(src[meta.key], 0)));
      return {
        key: meta.key,
        label: meta.label,
        color: meta.color,
        count: count,
      };
    });

    const total = items.reduce(function (acc, it) { return acc + it.count; }, 0);
    for (let i = 0; i < items.length; i += 1) {
      items[i].pct = total > 0 ? Math.round((items[i].count / total) * 100) : 0;
    }

    const W = 640;
    const H = 76;
    const barX = 2;
    const barY = 8;
    const barW = 636;
    const barH = 12;
    const clipId = nextClipId('k-funnel-clip');

    // Compute proportional widths for non-zero segments with crisp 2px gaps
    const nonZero = items.filter(function (it) { return it.count > 0; });
    const gap = 2;
    const barSegsSvg = [];

    if (nonZero.length > 0 && total > 0) {
      const availW = Math.max(1, barW - gap * (nonZero.length - 1));
      const minSegW = Math.min(10, availW / nonZero.length);
      const rawWidths = nonZero.map(function (it) {
        return Math.max(minSegW, (it.count / total) * availW);
      });
      const rawSum = rawWidths.reduce(function (a, b) { return a + b; }, 0);
      const scale = rawSum > 0 ? availW / rawSum : 1;

      let cursorX = barX;
      for (let i = 0; i < nonZero.length; i += 1) {
        const it = nonZero[i];
        const segW = i === nonZero.length - 1
          ? Math.max(2, (barX + barW) - cursorX)
          : Math.max(2, rawWidths[i] * scale);
        const isActive = activeStage === it.key;
        const word = it.count === 1 ? 'idea' : 'ideas';
        const tip = it.label + ': ' + it.count + ' ' + word + ' (' + it.pct + '%)';
        const escapedTip = escapeHtml(tip);

        barSegsSvg.push(
          '<g class="k-funnel-seg is-' + it.key + (isActive ? ' is-active' : '') + '" ' +
            'data-codex-stage="' + it.key + '" data-viz-tip="' + escapedTip + '" data-tooltip="' + escapedTip + '" ' +
            'tabindex="0" role="button" aria-label="Filter ' + escapeHtml(it.label) + ' stage (' + it.count + ')" style="cursor:pointer;">' +
            '<rect x="' + fmt(cursorX) + '" y="' + barY + '" width="' + fmt(segW) + '" height="' + barH + '" ' +
              'fill="' + it.color + '" fill-opacity="' + (activeStage && !isActive ? '0.45' : '0.92') + '" />' +
          '</g>'
        );
        cursorX += segW + gap;
      }
    }

    // 5 clickable stage readout cells below the segmented pipeline bar
    const cellGap = 8;
    const cellW = (barW - cellGap * 4) / 5;
    const cellY = 30;
    const cellH = 42;

    const cellsSvg = items.map(function (it, idx) {
      const cx = barX + idx * (cellW + cellGap);
      const isActive = activeStage === it.key;
      const word = it.count === 1 ? 'idea' : 'ideas';
      const tip = it.label + ': ' + it.count + ' ' + word + ' (' + it.pct + '%) - Click to filter';
      const escapedTip = escapeHtml(tip);

      const cardFill = isActive
        ? 'var(--surface-selected, rgba(255, 255, 255, 0.08))'
        : 'var(--surface-inset, rgba(128, 128, 128, 0.06))';
      const cardStroke = isActive
        ? it.color
        : 'var(--border-hairline, rgba(255, 255, 255, 0.09))';

      // Directional pipeline chevron between Spark -> Validating -> Building -> Shipped
      let connectorSvg = '';
      if (idx < 3) {
        const arrowX = cx + cellW + cellGap / 2;
        const arrowY = cellY + cellH / 2;
        connectorSvg =
          '<path class="k-funnel-arrow" d="M ' + fmt(arrowX - 1.8) + ' ' + fmt(arrowY - 3) +
            ' L ' + fmt(arrowX + 1.6) + ' ' + fmt(arrowY) +
            ' L ' + fmt(arrowX - 1.8) + ' ' + fmt(arrowY + 3) + '" ' +
            'fill="none" stroke="var(--ink-faint, #666666)" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />';
      } else if (idx === 3) {
        const sepX = cx + cellW + cellGap / 2;
        connectorSvg =
          '<line class="k-funnel-sep" x1="' + fmt(sepX) + '" y1="' + (cellY + 9) + '" ' +
            'x2="' + fmt(sepX) + '" y2="' + (cellY + cellH - 9) + '" ' +
            'stroke="var(--border-strong, rgba(255, 255, 255, 0.16))" stroke-dasharray="2 2" stroke-width="1" />';
      }

      return (
        '<g class="k-funnel-cell is-' + it.key + (isActive ? ' is-active' : '') + (it.count === 0 ? ' is-zero' : '') + '" ' +
          'data-codex-stage="' + it.key + '" data-viz-tip="' + escapedTip + '" data-tooltip="' + escapedTip + '" ' +
          'tabindex="0" role="button" aria-label="Filter ' + escapeHtml(it.label) + ' stage (' + it.count + ')" style="cursor:pointer;">' +
          '<rect x="' + fmt(cx) + '" y="' + cellY + '" width="' + fmt(cellW) + '" height="' + cellH + '" rx="6" ' +
            'fill="' + cardFill + '" stroke="' + cardStroke + '" stroke-width="' + (isActive ? '1.25' : '1') + '" />' +
          '<circle cx="' + fmt(cx + 12) + '" cy="' + (cellY + 13.5) + '" r="2.8" fill="' + it.color + '" />' +
          '<text x="' + fmt(cx + 19.5) + '" y="' + (cellY + 16.5) + '" ' +
            'font-family="var(--font-mono, ui-monospace, monospace)" font-size="8.5" font-weight="500" ' +
            'letter-spacing="0.06em" fill="var(--ink-secondary, #a1a1a1)">' +
            escapeHtml(it.label.toUpperCase()) +
          '</text>' +
          '<text x="' + fmt(cx + 10) + '" y="' + (cellY + 34.5) + '" ' +
            'font-family="var(--font-mono, ui-monospace, monospace)" font-size="13.5" font-weight="600" ' +
            'font-variant-numeric="tabular-nums" fill="' + (it.count > 0 ? 'var(--ink-primary, #ededed)' : 'var(--ink-muted, #737373)') + '">' +
            it.count +
          '</text>' +
          '<text x="' + fmt(cx + cellW - 10) + '" y="' + (cellY + 34) + '" text-anchor="end" ' +
            'font-family="var(--font-mono, ui-monospace, monospace)" font-size="9.5" font-weight="500" ' +
            'font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">' +
            it.pct + '%' +
          '</text>' +
        '</g>' +
        connectorSvg
      );
    }).join('');

    const ariaLabel = 'Ideas incubator pipeline: ' +
      items.map(function (it) { return it.label + ' ' + it.count; }).join(', ');

    return (
      '<svg class="k-codex-funnel-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" ' +
        'role="img" aria-label="' + escapeHtml(ariaLabel) + '" ' +
        'style="display:block;width:100%;height:auto;overflow:visible;">' +
        '<defs>' +
          '<clipPath id="' + clipId + '">' +
            '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="4" />' +
          '</clipPath>' +
        '</defs>' +
        '<rect class="k-funnel-track" x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="4" ' +
          'fill="var(--surface-inset, rgba(128, 128, 128, 0.14))" ' +
          'stroke="var(--border-hairline, rgba(255, 255, 255, 0.09))" stroke-width="1" />' +
        '<g class="k-funnel-bar" clip-path="url(#' + clipId + ')">' + barSegsSvg.join('') + '</g>' +
        '<g class="k-funnel-cells">' + cellsSvg + '</g>' +
      '</svg>'
    );
  }

  // =========================================================================
  // 4. CODEX DOMAIN TAXONOMY BALANCE BAR (640 x dynamic height)
  // =========================================================================

  const DOMAIN_PALETTE_CYCLE = [
    'var(--accent-violet, #a78bfa)',
    'var(--accent-cyan, #50e3c2)',
    'var(--accent-blue, #3291ff)',
    'var(--accent-amber, #f5a623)',
    'var(--accent-green, #46a758)',
    'var(--accent-sky, #38bdf8)',
    'var(--ink-secondary, #a1a1a1)',
    'var(--ink-faint, #666666)',
  ];

  function resolveDomainColor(domainName, fallbackIndex) {
    const key = String(domainName == null ? '' : domainName).toLowerCase();
    if (key.includes('ai') || key.includes('agent') || key.includes('model')) return 'var(--accent-violet, #a78bfa)';
    if (key.includes('design') || key.includes('craft') || key.includes('taste') || key.includes('ui')) return 'var(--accent-cyan, #50e3c2)';
    if (key.includes('solana') || key.includes('crypto') || key.includes('defi') || key.includes('chain')) return 'var(--accent-green, #46a758)';
    if (key.includes('film') || key.includes('media') || key.includes('anime') || key.includes('video')) return 'var(--accent-amber, #f5a623)';
    if (key.includes('venture') || key.includes('startup') || key.includes('business') || key.includes('invest')) return 'var(--accent-blue, #3291ff)';
    if (key.includes('family') || key.includes('life') || key.includes('health') || key.includes('people')) return 'var(--accent-sky, #38bdf8)';
    if (key === 'other') return 'var(--ink-faint, #666666)';
    return DOMAIN_PALETTE_CYCLE[fallbackIndex % DOMAIN_PALETTE_CYCLE.length];
  }

  function renderDomainBalanceSvg(domains) {
    const rawList = Array.isArray(domains) ? domains : [];
    const cleaned = [];

    for (let i = 0; i < rawList.length; i += 1) {
      const d = rawList[i];
      if (!d || typeof d !== 'object') continue;
      const name = stripEmDash(d.domain || d.name || d.label || '').trim();
      const count = Math.max(0, Math.round(safeNum(d.count, 0)));
      const rawPct = nullableNum(d.pct);
      if (!name) continue;
      if (count <= 0 && (rawPct === null || rawPct <= 0)) continue;
      cleaned.push({
        domain: name,
        count: count,
        rawPct: rawPct,
      });
    }

    // Sort descending by count (then rawPct)
    cleaned.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return safeNum(b.rawPct, 0) - safeNum(a.rawPct, 0);
    });

    // Cap to top 7 + Other so layout stays crisp and predictable
    let normalized = cleaned;
    if (cleaned.length > 8) {
      const top = cleaned.slice(0, 7);
      const rest = cleaned.slice(7);
      const otherCount = rest.reduce(function (acc, it) { return acc + it.count; }, 0);
      const otherPct = rest.reduce(function (acc, it) { return acc + Math.max(0, safeNum(it.rawPct, 0)); }, 0);
      top.push({ domain: 'Other', count: otherCount, rawPct: otherPct });
      normalized = top;
    }

    const totalCount = normalized.reduce(function (acc, it) { return acc + it.count; }, 0);
    const totalRawPct = normalized.reduce(function (acc, it) { return acc + Math.max(0, safeNum(it.rawPct, 0)); }, 0);

    const usedColors = new Set();
    const entries = normalized.map(function (it, idx) {
      const share = totalCount > 0
        ? (it.count / totalCount) * 100
        : (totalRawPct > 0 ? (Math.max(0, safeNum(it.rawPct, 0)) / totalRawPct) * 100 : 0);
      let color = resolveDomainColor(it.domain, idx);
      if (usedColors.has(color)) {
        for (let c = 0; c < DOMAIN_PALETTE_CYCLE.length; c += 1) {
          if (!usedColors.has(DOMAIN_PALETTE_CYCLE[c])) {
            color = DOMAIN_PALETTE_CYCLE[c];
            break;
          }
        }
      }
      usedColors.add(color);
      return {
        domain: it.domain,
        count: it.count,
        share: clamp(share, 0, 100, 0),
        pct: Math.round(clamp(share, 0, 100, 0)),
        color: color,
      };
    });

    const W = 640;
    const barX = 2;
    const barY = 20;
    const barW = 636;
    const barH = 10;
    const cols = 4;
    const rows = entries.length > 0 ? Math.ceil(entries.length / cols) : 1;
    const H = entries.length > 0 ? (42 + rows * 20) : 54;
    const clipId = nextClipId('k-domain-clip');

    const headerRight = entries.length > 0
      ? (totalCount > 0 ? (totalCount + ' entries \u00b7 ' + entries.length + (entries.length === 1 ? ' domain' : ' domains')) : (entries.length + ' domains'))
      : '0 domains';

    const segsSvg = [];
    if (entries.length > 0) {
      const gap = 1.5;
      const availW = Math.max(1, barW - gap * (entries.length - 1));
      const minW = Math.min(6, availW / entries.length);
      const rawW = entries.map(function (it) {
        return Math.max(minW, (it.share / 100) * availW);
      });
      const sumW = rawW.reduce(function (a, b) { return a + b; }, 0);
      const scale = sumW > 0 ? availW / sumW : 1;

      let cursorX = barX;
      for (let i = 0; i < entries.length; i += 1) {
        const it = entries[i];
        const segW = i === entries.length - 1
          ? Math.max(2, (barX + barW) - cursorX)
          : Math.max(2, rawW[i] * scale);
        const itemWord = it.count === 1 ? 'entry' : 'entries';
        const tip = it.domain + ': ' + it.count + ' ' + itemWord + ' (' + it.pct + '%)';
        const escapedTip = escapeHtml(tip);
        const escapedDomain = escapeHtml(it.domain);

        segsSvg.push(
          '<g class="k-domain-seg" data-codex-domain="' + escapedDomain + '" ' +
            'data-viz-tip="' + escapedTip + '" data-tooltip="' + escapedTip + '" ' +
            'tabindex="0" role="button" aria-label="' + escapedTip + '" style="cursor:pointer;">' +
            '<rect x="' + fmt(cursorX) + '" y="' + barY + '" width="' + fmt(segW) + '" height="' + barH + '" ' +
              'fill="' + it.color + '" fill-opacity="0.9" />' +
          '</g>'
        );
        cursorX += segW + gap;
      }
    }

    let legendSvg = '';
    if (entries.length > 0) {
      const colW = barW / cols;
      legendSvg = entries.map(function (it, idx) {
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        const lx = barX + col * colW;
        const ly = 44 + row * 20;
        const shortName = truncate(it.domain, 15);
        const itemWord = it.count === 1 ? 'entry' : 'entries';
        const tip = it.domain + ': ' + it.count + ' ' + itemWord + ' (' + it.pct + '%)';
        const escapedTip = escapeHtml(tip);
        const escapedDomain = escapeHtml(it.domain);

        return (
          '<g class="k-domain-legend-item" data-codex-domain="' + escapedDomain + '" ' +
            'data-viz-tip="' + escapedTip + '" data-tooltip="' + escapedTip + '" ' +
            'tabindex="0" role="button" aria-label="' + escapedTip + '" style="cursor:pointer;">' +
            '<rect x="' + fmt(lx) + '" y="' + fmt(ly - 8) + '" width="' + fmt(colW - 6) + '" height="16" rx="3" fill="transparent" />' +
            '<rect x="' + fmt(lx + 1) + '" y="' + fmt(ly - 3.5) + '" width="6.5" height="6.5" rx="1.5" fill="' + it.color + '" />' +
            '<text x="' + fmt(lx + 12) + '" y="' + fmt(ly + 2.5) + '" ' +
              'font-family="var(--font-sans, system-ui, sans-serif)" font-size="10" font-weight="500" ' +
              'fill="var(--ink-secondary, #a1a1a1)">' +
              escapeHtml(shortName) +
            '</text>' +
            '<text x="' + fmt(lx + colW - 10) + '" y="' + fmt(ly + 2.5) + '" text-anchor="end" ' +
              'font-family="var(--font-mono, ui-monospace, monospace)" font-size="9.5" font-weight="500" ' +
              'font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">' +
              it.pct + '% (' + it.count + ')' +
            '</text>' +
          '</g>'
        );
      }).join('');
    } else {
      legendSvg =
        '<text x="' + (W / 2) + '" y="46" text-anchor="middle" ' +
          'font-family="var(--font-mono, ui-monospace, monospace)" font-size="9.5" fill="var(--ink-muted, #737373)">' +
          'No Codex domains indexed yet' +
        '</text>';
    }

    const ariaLabel = entries.length > 0
      ? ('Codex domain balance: ' + entries.map(function (it) { return it.domain + ' ' + it.pct + '%'; }).join(', '))
      : 'Codex domain balance: empty';

    return (
      '<svg class="k-domain-balance-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" ' +
        'role="img" aria-label="' + escapeHtml(ariaLabel) + '" ' +
        'style="display:block;width:100%;height:auto;overflow:visible;">' +
        '<defs>' +
          '<clipPath id="' + clipId + '">' +
            '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="4" />' +
          '</clipPath>' +
        '</defs>' +
        '<g class="k-domain-header">' +
          '<text x="' + barX + '" y="11" font-family="var(--font-mono, ui-monospace, monospace)" ' +
            'font-size="8.5" font-weight="500" letter-spacing="0.08em" fill="var(--ink-muted, #737373)">DOMAIN BALANCE</text>' +
          '<text x="' + (barX + barW) + '" y="11" text-anchor="end" font-family="var(--font-mono, ui-monospace, monospace)" ' +
            'font-size="8.5" font-weight="500" font-variant-numeric="tabular-nums" fill="var(--ink-secondary, #a1a1a1)">' +
            escapeHtml(headerRight) +
          '</text>' +
        '</g>' +
        '<rect class="k-domain-track" x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="4" ' +
          'fill="var(--surface-inset, rgba(128, 128, 128, 0.14))" ' +
          'stroke="var(--border-hairline, rgba(255, 255, 255, 0.09))" stroke-width="1" />' +
        '<g class="k-domain-bar" clip-path="url(#' + clipId + ')">' + segsSvg.join('') + '</g>' +
        '<g class="k-domain-legend">' + legendSvg + '</g>' +
      '</svg>'
    );
  }

  // =========================================================================
  // 5. DELEGATED INTERACTIVE TOOLTIP ENGINE (.k-viz-tooltip)
  // =========================================================================

  const boundRoots = typeof WeakMap === 'function' ? new WeakMap() : null;
  const TIP_STYLE_ID = 'k-viz-tooltip-styles';
  const TIP_SELECTOR = '[data-viz-tip]';

  function ensureTooltipStyles(doc) {
    if (!doc || !doc.head || doc.getElementById(TIP_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = TIP_STYLE_ID;
    style.textContent =
      '.k-viz-tooltip{' +
        'position:fixed;top:0;left:0;z-index:var(--z-toast,90);pointer-events:none;' +
        'max-width:min(320px,calc(100vw - 20px));padding:6px 9px;border-radius:var(--radius-sm,6px);' +
        'background:var(--surface-overlay,#111111);color:var(--ink-primary,#ededed);' +
        'border:1px solid var(--border-strong,rgba(255,255,255,0.16));' +
        'box-shadow:var(--shadow-float,0 8px 24px -4px rgba(0,0,0,0.72));' +
        'font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;line-height:1.4;' +
        'font-variant-numeric:tabular-nums;white-space:pre-line;word-break:break-word;' +
        'opacity:0;visibility:hidden;transform:translate3d(-9999px,-9999px,0);' +
        'transition:opacity 110ms var(--ease-out,cubic-bezier(0.23,1,0.32,1));' +
        'will-change:transform,opacity;' +
      '}' +
      '.k-viz-tooltip.is-visible{opacity:1;visibility:visible;}' +
      '.k-rhythm-bar.is-active:hover .k-rhythm-rect,.k-rhythm-bar.is-active:focus-visible .k-rhythm-rect{fill-opacity:1;}' +
      '.k-funnel-seg:hover rect,.k-domain-seg:hover rect{fill-opacity:1;}' +
      '.k-funnel-cell:hover rect{stroke:var(--border-hover,rgba(255,255,255,0.24));}' +
      '.k-domain-legend-item:hover text{fill:var(--ink-primary,#ededed);}' +
      '@media (prefers-reduced-motion:reduce){.k-viz-tooltip{transition:none;}}';
    doc.head.appendChild(style);
  }

  function ensureTooltipElement(doc) {
    if (!doc || !doc.body) return null;
    ensureTooltipStyles(doc);
    let el = doc.querySelector('.k-viz-tooltip');
    if (!el) {
      el = doc.createElement('div');
      el.className = 'k-viz-tooltip';
      el.setAttribute('role', 'tooltip');
      el.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(el);
    }
    return el;
  }

  function findTipTarget(node, rootEl) {
    if (!node || typeof node.closest !== 'function') return null;
    const match = node.closest(TIP_SELECTOR);
    if (!match) return null;
    if (rootEl && typeof rootEl.contains === 'function' && !rootEl.contains(match)) {
      return null;
    }
    return match;
  }

  function readTipText(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const primary = el.getAttribute('data-viz-tip');
    const clean = stripEmDash(primary || '').trim();
    return clean;
  }

  function bindInteractiveTooltips(rootEl) {
    const doc = (rootEl && rootEl.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    const targetRoot = rootEl || (doc && doc.body);
    if (!doc || !targetRoot || typeof targetRoot.addEventListener !== 'function') {
      return function noop() {};
    }

    if (boundRoots && boundRoots.has(targetRoot)) {
      return boundRoots.get(targetRoot);
    }

    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    let activeTarget = null;
    let tipEl = null;

    function getTipEl() {
      if (!tipEl || !tipEl.isConnected) {
        tipEl = ensureTooltipElement(doc);
      }
      return tipEl;
    }

    function positionAt(clientX, clientY) {
      const el = getTipEl();
      if (!el) return;
      const vw = win && Number.isFinite(win.innerWidth) ? win.innerWidth : 1280;
      const vh = win && Number.isFinite(win.innerHeight) ? win.innerHeight : 800;
      const margin = 10;
      const rect = typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : { width: 160, height: 28 };
      const tipW = rect.width || 160;
      const tipH = rect.height || 28;

      let x = clientX - tipW / 2;
      let y = clientY - tipH - 12;
      if (y < margin) {
        y = clientY + 14;
      }
      x = Math.max(margin, Math.min(vw - tipW - margin, x));
      y = Math.max(margin, Math.min(vh - tipH - margin, y));

      el.style.transform = 'translate3d(' + Math.round(x) + 'px, ' + Math.round(y) + 'px, 0)';
    }

    function showForTarget(el, clientX, clientY) {
      const text = readTipText(el);
      if (!text) {
        hide();
        return;
      }
      const tip = getTipEl();
      if (!tip) return;
      activeTarget = el;
      if (tip.textContent !== text) {
        tip.textContent = text;
      }
      tip.classList.add('is-visible');
      tip.setAttribute('aria-hidden', 'false');
      positionAt(clientX, clientY);
    }

    function hide() {
      activeTarget = null;
      if (!tipEl) return;
      tipEl.classList.remove('is-visible');
      tipEl.setAttribute('aria-hidden', 'true');
      tipEl.style.transform = 'translate3d(-9999px, -9999px, 0)';
    }

    function onPointerEnter(evt) {
      const found = findTipTarget(evt.target, targetRoot);
      if (!found) return;
      showForTarget(found, safeNum(evt.clientX, 0), safeNum(evt.clientY, 0));
    }

    function onPointerMove(evt) {
      const found = findTipTarget(evt.target, targetRoot);
      if (!found) {
        if (activeTarget) hide();
        return;
      }
      if (found !== activeTarget) {
        showForTarget(found, safeNum(evt.clientX, 0), safeNum(evt.clientY, 0));
      } else {
        positionAt(safeNum(evt.clientX, 0), safeNum(evt.clientY, 0));
      }
    }

    function onPointerLeave(evt) {
      if (evt.target === targetRoot) {
        hide();
        return;
      }
      if (activeTarget && evt.target === activeTarget) {
        const next = findTipTarget(evt.relatedTarget, targetRoot);
        if (!next) {
          hide();
        }
      }
    }

    function onFocusIn(evt) {
      const found = findTipTarget(evt.target, targetRoot);
      if (!found || typeof found.getBoundingClientRect !== 'function') return;
      const r = found.getBoundingClientRect();
      showForTarget(found, r.left + r.width / 2, r.top);
    }

    function onFocusOut(evt) {
      if (!activeTarget) return;
      const next = findTipTarget(evt.relatedTarget, targetRoot);
      if (!next) hide();
    }

    function onKeyDown(evt) {
      if (evt && evt.key === 'Escape' && activeTarget) {
        hide();
      }
    }

    function onScroll() {
      if (activeTarget) hide();
    }

    targetRoot.addEventListener('pointerenter', onPointerEnter, true);
    targetRoot.addEventListener('pointermove', onPointerMove, { passive: true });
    targetRoot.addEventListener('pointerleave', onPointerLeave, true);
    targetRoot.addEventListener('focusin', onFocusIn, true);
    targetRoot.addEventListener('focusout', onFocusOut, true);
    doc.addEventListener('keydown', onKeyDown);
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }

    function unbind() {
      hide();
      targetRoot.removeEventListener('pointerenter', onPointerEnter, true);
      targetRoot.removeEventListener('pointermove', onPointerMove);
      targetRoot.removeEventListener('pointerleave', onPointerLeave, true);
      targetRoot.removeEventListener('focusin', onFocusIn, true);
      targetRoot.removeEventListener('focusout', onFocusOut, true);
      doc.removeEventListener('keydown', onKeyDown);
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('scroll', onScroll, true);
      }
      if (boundRoots) boundRoots.delete(targetRoot);
    }

    if (boundRoots) boundRoots.set(targetRoot, unbind);
    return unbind;
  }

  // =========================================================================
  // 5. FULL-WIDTH 52-WEEK DUAL-SIDED RELATIONSHIP CADENCE RIBBON
  // =========================================================================
  function renderRelationshipRibbonSvg(ledger, visuals, person, meetings) {
    const rawWeeks =
      ledger && Array.isArray(ledger.weeks) && ledger.weeks.length > 0
        ? ledger.weeks
        : null;
    const fallbackSeries =
      !rawWeeks && visuals && Array.isArray(visuals.cadence_series) && visuals.cadence_series.length > 0
        ? visuals.cadence_series
        : null;
    if (!rawWeeks && !fallbackSeries) return '';

    const weeks = [];
    if (rawWeeks) {
      const slice = rawWeeks.slice(-52);
      while (weeks.length + slice.length < 52) {
        weeks.push({ weekStart: '', out: 0, in: 0, meetings: 0 });
      }
      for (let i = 0; i < slice.length; i += 1) {
        const w = slice[i] || {};
        weeks.push({
          weekStart: String(w.weekStart || w.week || ''),
          out: Math.max(0, safeNum(w.out, 0)),
          in: Math.max(0, safeNum(w.in, 0)),
          meetings: Math.max(0, safeNum(w.meetings, 0)),
        });
      }
    } else {
      const slice = fallbackSeries.slice(-52);
      while (weeks.length + slice.length < 52) {
        weeks.push({ weekStart: '', out: 0, in: 0, meetings: 0 });
      }
      for (let i = 0; i < slice.length; i += 1) {
        const w = slice[i] || {};
        const tot = Math.max(0, safeNum(w.total ?? w.count, 0));
        const outVal = w.out != null ? Math.max(0, safeNum(w.out, 0)) : Math.round(tot * 0.5);
        const inVal = w.in != null ? Math.max(0, safeNum(w.in, 0)) : Math.max(0, tot - outVal);
        weeks.push({
          weekStart: String(w.weekStart || w.label || w.date || ''),
          out: outVal,
          in: inVal,
          meetings: Math.max(0, safeNum(w.meetings, 0)),
        });
      }
    }

    let maxVal = 1;
    for (let i = 0; i < weeks.length; i += 1) {
      if (weeks[i].out > maxVal) maxVal = weeks[i].out;
      if (weeks[i].in > maxVal) maxVal = weeks[i].in;
    }

    const W = 720;
    const H = 96;
    const padL = 8;
    const padR = 8;
    const axisY = 44;
    const halfH = 30;
    const colW = (W - padL - padR) / 52;
    const barW = Math.max(4, colW - 3.2);

    const marks = [];
    for (let i = 0; i < 52; i += 1) {
      const w = weeks[i];
      const x = padL + i * colW + (colW - barW) * 0.5;
      const tipText =
        (w.weekStart || 'Week ' + (i + 1)) +
        ': ' + w.out + ' sent, ' + w.in + ' received' +
        (w.meetings > 0 ? ', ' + w.meetings + ' mtgs' : '');

      if (w.out > 0) {
        const h = Math.max(3, (w.out / maxVal) * halfH);
        marks.push(
          '<rect class="pv-cadence-bar" x="' + fmt(x) + '" y="' + fmt(axisY - h - 1) +
            '" width="' + fmt(barW) + '" height="' + fmt(h) + '" rx="1.5" ' +
            'fill="var(--accent-green, #46a758)" opacity="0.88" data-tip="' + escAttr(tipText) + '"/>'
        );
      }
      if (w.in > 0) {
        const h = Math.max(3, (w.in / maxVal) * halfH);
        marks.push(
          '<rect class="pv-cadence-bar" x="' + fmt(x) + '" y="' + fmt(axisY + 2) +
            '" width="' + fmt(barW) + '" height="' + fmt(h) + '" rx="1.5" ' +
            'fill="var(--accent-blue, #3291ff)" opacity="0.82" data-tip="' + escAttr(tipText) + '"/>'
        );
      }
      if (w.out === 0 && w.in === 0) {
        marks.push(
          '<rect x="' + fmt(x) + '" y="' + fmt(axisY - 1) +
            '" width="' + fmt(barW) + '" height="2" rx="1" ' +
            'fill="var(--border-hairline, rgba(255,255,255,0.10))"/>'
        );
      }
      if (w.meetings > 0) {
        marks.push(
          '<circle cx="' + fmt(x + barW * 0.5) + '" cy="' + fmt(axisY + 0.5) +
            '" r="2.2" fill="var(--accent-amber, #f5a623)" data-tip="' + escAttr(tipText) + '"/>'
        );
      }
    }

    const qLabels = [
      { idx: 0, text: '52w ago' },
      { idx: 13, text: '39w' },
      { idx: 26, text: '26w' },
      { idx: 39, text: '13w' },
      { idx: 51, text: 'Now' },
    ];
    const axisTicks = qLabels
      .map((q) => {
        const x = padL + q.idx * colW + (q.idx === 51 ? colW : 0);
        const anchor = q.idx === 0 ? 'start' : q.idx === 51 ? 'end' : 'middle';
        return (
          '<text x="' + fmt(x) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '" ' +
            'font-family="var(--font-mono, ui-monospace, monospace)" font-size="11" ' +
            'fill="var(--ink-muted, #8a8a8a)">' + escHtml(q.text) + '</text>'
        );
      })
      .join('');

    return (
      '<svg class="k-ledger-ribbon-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="52-week dual-sided relationship cadence ribbon (outbound above, inbound below)">' +
        '<line x1="' + padL + '" y1="' + axisY + '" x2="' + (W - padR) + '" y2="' + axisY + '" ' +
          'stroke="var(--border-strong, rgba(255,255,255,0.16))" stroke-width="1"/>' +
        '<text x="' + padL + '" y="11" font-family="var(--font-mono, ui-monospace, monospace)" font-size="11" fill="var(--ink-muted, #8a8a8a)">OUTBOUND</text>' +
        '<text x="' + (W - padR) + '" y="11" text-anchor="end" font-family="var(--font-mono, ui-monospace, monospace)" font-size="11" fill="var(--ink-muted, #8a8a8a)">INBOUND BELOW</text>' +
        marks.join('') +
        axisTicks +
      '</svg>'
    );
  }

  return {
    renderWhoopGaugeSvg: renderWhoopGaugeSvg,
    renderDayRhythmSvg: renderDayRhythmSvg,
    renderCodexFunnelSvg: renderCodexFunnelSvg,
    renderDomainBalanceSvg: renderDomainBalanceSvg,
    renderRelationshipRibbonSvg: renderRelationshipRibbonSvg,
    bindInteractiveTooltips: bindInteractiveTooltips,
  };
});
