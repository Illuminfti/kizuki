/* ==========================================================================
   KIZUKI MIND EXPLORER - PERSONAL MIND CONSTELLATION CANVAS
   Interactive High-DPI Canvas2D Radial-Cluster Topology for Mind Codex
   Exports: window.KizukiCodexMap = { mount }
   Zero external deps | Zero XSS | Zero em-dashes | 0% CPU at rest
   ========================================================================== */
(function initKizukiCodexMap(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiCodexMap = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createFactory(root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const EN_DASH_RE = /\s*\u2013\s*/g;
  const MEMT_RULE_PREFIX_RE = /^MemT Rule \[[^\]]+\]:?\s*/i;
  const TWO_PI = Math.PI * 2;
  const STYLE_TAG_ID = 'kizuki-codex-constellation-styles';

  // World coordinate geometry (centered at 0,0)
  const WORLD_RADIUS = 360;
  const CORE_RING_R = 54;
  const PEOPLE_RING_R = 122;
  const ITEM_R_MIN = 176;
  const ITEM_R_MAX = 328;
  const ARC_RAIL_R = 344;
  const QUADRANT_LABEL_OFFSET = 22;
  const SECTOR_GAP_RAD = 0.11;
  const FILTER_STAGGER_MS = 5;
  const FILTER_NODE_MS = 240;
  const FILTER_ARC_MS = 300;
  const HOVER_TRANSITION_MS = 110;
  const PACKET_HUB_MS = 250;
  const PACKET_RELAY_MS = 260;
  const PACKET_RELAY_STAGGER_MS = 18;
  const PACKET_ARRIVE_FLASH_MS = 190;
  const MAX_OUTER_CALLOUTS = 6;
  const SHEET_WIDTH_DESKTOP = 342;

  const SECTORS = [
    {
      id: 'philosophies',
      label: 'Philosophies',
      shortLabel: 'Philosophies',
      // Upper-Left quadrant: PI -> 1.5*PI
      startAngle: Math.PI,
      endAngle: Math.PI * 1.5,
      darkColor: '#a78bfa',
      lightColor: '#7c3aed',
      darkRgb: [167, 139, 250],
      lightRgb: [124, 58, 237],
    },
    {
      id: 'interests',
      label: 'Interests & Passions',
      shortLabel: 'Interests',
      // Upper-Right quadrant: 1.5*PI -> 2*PI
      startAngle: Math.PI * 1.5,
      endAngle: TWO_PI,
      darkColor: '#38bdf8',
      lightColor: '#0284c7',
      darkRgb: [56, 189, 248],
      lightRgb: [2, 132, 199],
    },
    {
      id: 'hobbies',
      label: 'Hobbies & Craft',
      shortLabel: 'Hobbies',
      // Lower-Left quadrant: 0.5*PI -> PI
      startAngle: Math.PI * 0.5,
      endAngle: Math.PI,
      darkColor: '#34d399',
      lightColor: '#059669',
      darkRgb: [52, 211, 153],
      lightRgb: [5, 150, 105],
    },
    {
      id: 'ideas',
      label: 'Ideas & Ventures',
      shortLabel: 'Ideas',
      // Lower-Right quadrant: 0 -> 0.5*PI
      startAngle: 0,
      endAngle: Math.PI * 0.5,
      darkColor: '#fbbf24',
      lightColor: '#d97706',
      darkRgb: [251, 191, 36],
      lightRgb: [217, 119, 6],
    },
  ];

  const SECTOR_BY_ID = Object.create(null);
  for (let i = 0; i < SECTORS.length; i += 1) {
    SECTOR_BY_ID[SECTORS[i].id] = SECTORS[i];
  }

  function cleanText(val) {
    return String(val == null ? '' : val)
      .replace(EM_DASH_RE, ' - ')
      .replace(EN_DASH_RE, ' - ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatNodeDisplayTitle(rawTitle) {
    const cleaned = cleanText(rawTitle);
    const stripped = cleaned.replace(MEMT_RULE_PREFIX_RE, '').trim();
    return stripped || cleaned;
  }

  function truncateText(str, maxLen) {
    const s = cleanText(str);
    if (s.length <= maxLen) return s;
    const cut = s.slice(0, Math.max(1, maxLen - 3));
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= Math.floor(maxLen * 0.45)) {
      return cut.slice(0, lastSpace).trimEnd() + '...';
    }
    return cut.trimEnd() + '...';
  }

  function wrapLabelTwoLines(ctx, rawText, maxLineW) {
    const text = cleanText(rawText);
    if (!text) return { lines: [''], maxW: 0, truncated: false };
    const measure = function (s) {
      return typeof ctx.measureText === 'function' ? ctx.measureText(s).width : s.length * 6.4;
    };

    const fullW = measure(text);
    if (fullW <= maxLineW) {
      return { lines: [text], maxW: fullW, truncated: false };
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
      return { lines: [text], maxW: fullW, truncated: false };
    }

    // Try balanced 2-line split on word boundary first so labels never cut mid-word
    let line1 = '';
    let idx = 0;
    while (idx < words.length) {
      const next = line1 ? (line1 + ' ' + words[idx]) : words[idx];
      if (measure(next) <= maxLineW || !line1) {
        line1 = next;
        idx += 1;
      } else {
        break;
      }
    }

    if (idx >= words.length) {
      return { lines: [line1], maxW: measure(line1), truncated: false };
    }

    const restText = words.slice(idx).join(' ');
    const restW = measure(restText);
    if (restW <= maxLineW) {
      return {
        lines: [line1, restText],
        maxW: Math.max(measure(line1), restW),
        truncated: false,
      };
    }

    // Fit as many whole words as possible onto line 2 before adding ellipsis
    let line2 = '';
    while (idx < words.length) {
      const cand = line2 ? (line2 + ' ' + words[idx]) : words[idx];
      if (measure(cand + '...') <= maxLineW || !line2) {
        line2 = cand;
        idx += 1;
      } else {
        break;
      }
    }
    const finalLine2 = idx < words.length ? (line2 + '...') : line2;
    return {
      lines: [line1, finalLine2],
      maxW: Math.max(measure(line1), measure(finalLine2)),
      truncated: idx < words.length,
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function easeOutCubic(t) {
    const inv = 1 - clamp(t, 0, 1);
    return 1 - inv * inv * inv;
  }

  function evalQuadBezier(x0, y0, cpx, cpy, x1, y1, t) {
    const u = clamp(t, 0, 1);
    const omt = 1 - u;
    return {
      x: omt * omt * x0 + 2 * omt * u * cpx + u * u * x1,
      y: omt * omt * y0 + 2 * omt * u * cpy + u * u * y1,
    };
  }

  function approxQuadLength(x0, y0, cpx, cpy, x1, y1) {
    let total = 0;
    let px = x0;
    let py = y0;
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const pt = evalQuadBezier(x0, y0, cpx, cpy, x1, y1, i / steps);
      total += Math.hypot(pt.x - px, pt.y - py);
      px = pt.x;
      py = pt.y;
    }
    return Math.max(1, total);
  }

  function computeEdgeControlPoint(a, b, kind, sectorHubs) {
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    if (kind === 'person') {
      const hub = sectorHubs && (sectorHubs[b.sectorId] || sectorHubs[a.sectorId]);
      if (hub) {
        return {
          cpx: mx * 0.58 + hub.x * 0.28,
          cpy: my * 0.58 + hub.y * 0.28,
        };
      }
      const midDist = Math.hypot(mx, my) || 1;
      let cpx = mx * 0.72;
      let cpy = my * 0.72;
      if (midDist < CORE_RING_R * 1.1) {
        cpx += -(b.y - a.y) * 0.14;
        cpy += (b.x - a.x) * 0.14;
      }
      return { cpx, cpy };
    }
    // Hub-bundled quadratic Bezier curves: pull intra-sector edges toward quadrant hub centroid,
    // and cross-sector chords smoothly through the central hub corridor
    if (a.sectorId && a.sectorId === b.sectorId && sectorHubs && sectorHubs[a.sectorId]) {
      const hub = sectorHubs[a.sectorId];
      return {
        cpx: mx * 0.42 + hub.x * 0.58,
        cpy: my * 0.42 + hub.y * 0.58,
      };
    }
    return { cpx: mx * 0.28, cpy: my * 0.28 };
  }

  function computeHubArcControlPoint(node) {
    const dist = Math.hypot(node.x, node.y) || 1;
    const bend = Math.min(34, dist * 0.14);
    const nx = -node.y / dist;
    const ny = node.x / dist;
    return {
      cpx: node.x * 0.5 + nx * bend,
      cpy: node.y * 0.5 + ny * bend,
    };
  }

  function hashString(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function normalizeAngle(rad) {
    let a = rad % TWO_PI;
    if (a < 0) a += TWO_PI;
    return a;
  }

  function angleDiff(a, b) {
    let d = normalizeAngle(a) - normalizeAngle(b);
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return d;
  }

  function rgba(rgb, alpha) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + clamp(alpha, 0, 1).toFixed(3) + ')';
  }

  function mapSectionToSectorId(rawSection) {
    const s = String(rawSection || '').toLowerCase().trim();
    if (SECTOR_BY_ID[s]) return s;
    if (s === 'philosophy' || s === 'principles') return 'philosophies';
    if (s === 'interest' || s === 'passions') return 'interests';
    if (s === 'hobby' || s === 'craft') return 'hobbies';
    return 'ideas';
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w * 0.5, h * 0.5);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rad);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function boxesOverlap(a, b, padX, padY) {
    return (
      a.x1 - padX < b.x2 &&
      a.x2 + padX > b.x1 &&
      a.y1 - padY < b.y2 &&
      a.y2 + padY > b.y1
    );
  }

  function boxHitsCircle(box, cx, cy, r) {
    const nx = clamp(cx, box.x1, box.x2);
    const ny = clamp(cy, box.y1, box.y2);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function detectThemeLight(containerEl) {
    try {
      if (containerEl && typeof containerEl.closest === 'function') {
        const scoped = containerEl.closest('[data-theme]');
        if (scoped && typeof scoped.getAttribute === 'function') {
          const v = scoped.getAttribute('data-theme');
          if (v === 'light') return true;
          if (v === 'dark') return false;
        }
      }
      if (typeof document !== 'undefined' && document.documentElement) {
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'light') return true;
        if (attr === 'dark') return false;
      }
    } catch {
      // ignore environment access errors
    }
    return false;
  }

  function resolvePalette(containerEl) {
    const isLight = detectThemeLight(containerEl);
    let fontSans = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
    let fontMono = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

    try {
      if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement) {
        const cs = getComputedStyle(document.documentElement);
        const fs = cs.getPropertyValue('--font-sans').trim();
        const fm = cs.getPropertyValue('--font-mono').trim();
        if (fs) fontSans = fs;
        if (fm) fontMono = fm;
      }
    } catch {
      // keep Geist defaults
    }

    return {
      isLight,
      fontSans,
      fontMono,
      bg: isLight ? '#ffffff' : '#050507',
      gridDot: isLight ? 'rgba(15, 23, 42, 0.065)' : 'rgba(255, 255, 255, 0.055)',
      ring: isLight ? 'rgba(15, 23, 42, 0.09)' : 'rgba(255, 255, 255, 0.075)',
      ringFaint: isLight ? 'rgba(15, 23, 42, 0.048)' : 'rgba(255, 255, 255, 0.04)',
      crosshair: isLight ? 'rgba(15, 23, 42, 0.14)' : 'rgba(255, 255, 255, 0.12)',
      inkPrimary: isLight ? '#171717' : '#ededed',
      inkSecondary: isLight ? '#404040' : '#a1a1a1',
      inkMuted: isLight ? '#666666' : '#737373',
      personCore: isLight ? '#111827' : '#f8fafc',
      personRing: isLight ? '#171717' : '#ffffff',
      personHalo: isLight ? 'rgba(17, 24, 39, 0.14)' : 'rgba(255, 255, 255, 0.22)',
      personEdgeRest: isLight ? 'rgba(15, 23, 42, 0.17)' : 'rgba(248, 250, 252, 0.17)',
      personEdgeHover: isLight ? 'rgba(15, 23, 42, 0.72)' : 'rgba(248, 250, 252, 0.78)',
      chordRest: isLight ? 'rgba(15, 23, 42, 0.085)' : 'rgba(255, 255, 255, 0.08)',
      chordDim: isLight ? 'rgba(15, 23, 42, 0.025)' : 'rgba(255, 255, 255, 0.025)',
      labelBg: isLight ? 'rgba(255, 255, 255, 0.88)' : 'rgba(5, 5, 7, 0.84)',
      labelBorder: isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.12)',
      labelHighlightBg: isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(12, 13, 18, 0.94)',
      nodeInnerCut: isLight ? '#ffffff' : '#050507',
      sectorColor(sectorId) {
        const s = SECTOR_BY_ID[sectorId] || SECTORS[0];
        return isLight ? s.lightColor : s.darkColor;
      },
      sectorRgb(sectorId) {
        const s = SECTOR_BY_ID[sectorId] || SECTORS[0];
        return isLight ? s.lightRgb : s.darkRgb;
      },
    };
  }

  function ensureScopedStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(STYLE_TAG_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = [
      '.kcm-root{position:relative;width:100%;height:100%;min-height:540px;overflow:hidden;border-radius:var(--radius-lg,12px);border:1px solid var(--border-hairline,rgba(255,255,255,0.09));background:#050507;color:#ededed;font-family:var(--font-sans,"Geist",-apple-system,system-ui,sans-serif);user-select:none;-webkit-user-select:none;touch-action:none;}',
      '.kcm-root.is-light{background:#ffffff;color:#171717;border-color:rgba(15,23,42,0.10);}',
      '.kcm-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;}',
      '.kcm-canvas.is-dragging{cursor:grabbing;}',
      '.kcm-canvas.is-hovering{cursor:pointer;}',
      '.kcm-toolbar{position:absolute;top:12px;left:12px;right:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;pointer-events:none;z-index:4;flex-wrap:wrap;}',
      '.kcm-group{display:inline-flex;align-items:center;gap:4px;padding:3px;border-radius:8px;background:rgba(10,10,14,0.84);border:1px solid rgba(255,255,255,0.10);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);pointer-events:auto;box-shadow:0 4px 16px rgba(0,0,0,0.38);}',
      '.kcm-filter-group{max-width:calc(100% - 16px);overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none;-webkit-overflow-scrolling:touch;}',
      '.kcm-filter-group::-webkit-scrollbar{display:none;}',
      '.kcm-filter-group .kcm-btn{flex-shrink:0;white-space:nowrap;}',
      '.kcm-root.is-light .kcm-group{background:rgba(255,255,255,0.90);border-color:rgba(15,23,42,0.10);box-shadow:0 2px 10px rgba(15,23,42,0.07);}',
      '.kcm-btn{appearance:none;border:1px solid transparent;background:transparent;color:#b5b5bd;font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);font-weight:500;line-height:1;height:26px;padding:0 9px;border-radius:5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease;}',
      '.kcm-btn:hover{background:rgba(255,255,255,0.08);color:#ededed;}',
      '.kcm-btn.is-active{background:rgba(255,255,255,0.13);border-color:rgba(255,255,255,0.20);color:#ffffff;}',
      '.kcm-root.is-light .kcm-btn{color:#404040;}',
      '.kcm-root.is-light .kcm-btn:hover{background:rgba(15,23,42,0.06);color:#111827;}',
      '.kcm-root.is-light .kcm-btn.is-active{background:rgba(15,23,42,0.10);border-color:rgba(15,23,42,0.20);color:#111827;}',
      '.kcm-dot{width:6px;height:6px;border-radius:999px;display:inline-block;flex-shrink:0;}',
      '.kcm-diamond{width:6px;height:6px;transform:rotate(45deg);border:1.25px solid currentColor;display:inline-block;flex-shrink:0;}',
      '.kcm-zoom-readout{font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);color:#a1a1aa;padding:0 6px;min-width:42px;text-align:center;font-variant-numeric:tabular-nums;}',
      '.kcm-root.is-light .kcm-zoom-readout{color:#52525b;}',
      '.kcm-footer{position:absolute;left:12px;bottom:10px;max-width:calc(100% - 24px);display:inline-flex;align-items:center;gap:8px;padding:5px 11px;border-radius:7px;background:rgba(10,10,14,0.86);border:1px solid rgba(255,255,255,0.11);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);font-variant-numeric:tabular-nums;color:#c4c4cc;pointer-events:none;z-index:3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.kcm-root.is-light .kcm-footer{background:rgba(255,255,255,0.92);border-color:rgba(15,23,42,0.11);color:#374151;}',
      '.kcm-footer-item{display:inline-flex;align-items:center;gap:5px;}',
      '.kcm-footer-sep{opacity:0.45;}',
      '.kcm-sheet{position:absolute;top:52px;right:12px;bottom:12px;width:336px;max-width:calc(100% - 24px);z-index:8;display:flex;flex-direction:column;border-radius:10px;background:rgba(12,13,18,0.96);border:1px solid rgba(255,255,255,0.14);box-shadow:0 16px 40px rgba(0,0,0,0.62);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#ededed;overflow:hidden;opacity:0;pointer-events:none;transform:translate3d(18px,0,0);transition:transform 180ms cubic-bezier(0.23,1,0.32,1),opacity 160ms ease;}',
      '.kcm-sheet.is-open{opacity:1;pointer-events:auto;transform:translate3d(0,0,0);}',
      '.kcm-root.is-light .kcm-sheet{background:rgba(255,255,255,0.98);border-color:rgba(15,23,42,0.14);box-shadow:0 12px 32px rgba(15,23,42,0.14);color:#111827;}',
      '.kcm-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-bottom:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.025);flex-shrink:0;}',
      '.kcm-root.is-light .kcm-sheet-head{border-bottom-color:rgba(15,23,42,0.09);background:rgba(15,23,42,0.02);}',
      '.kcm-sheet-eyebrow{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#a1a1aa;}',
      '.kcm-root.is-light .kcm-sheet-eyebrow{color:#4b5563;}',
      '.kcm-sheet-close{appearance:none;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#d4d4d8;width:24px;height:24px;border-radius:5px;font-family:var(--font-mono,monospace);font-size:var(--t-sm,12px);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}',
      '.kcm-sheet-close:hover{background:rgba(255,255,255,0.10);color:#ffffff;}',
      '.kcm-root.is-light .kcm-sheet-close{border-color:rgba(15,23,42,0.14);color:#374151;}',
      '.kcm-root.is-light .kcm-sheet-close:hover{background:rgba(15,23,42,0.07);color:#111827;}',
      '.kcm-sheet-body{flex:1 1 auto;overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:11px;user-select:text;-webkit-user-select:text;}',
      '.kcm-sheet-title{margin:0;font-size:var(--t-md,15px);font-weight:600;line-height:1.3;color:#ffffff;letter-spacing:-0.015em;}',
      '.kcm-root.is-light .kcm-sheet-title{color:#111827;}',
      '.kcm-sheet-sub{margin:0;font-size:var(--t-sm,12px);line-height:1.45;color:#b4b4bc;}',
      '.kcm-root.is-light .kcm-sheet-sub{color:#4b5563;}',
      '.kcm-sheet-pills{display:flex;flex-wrap:wrap;gap:5px;}',
      '.kcm-sheet-pill{font-family:var(--font-mono,monospace);font-size:var(--t-xs,11px);padding:2px 7px;border-radius:4px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.10);color:#d4d4d8;}',
      '.kcm-root.is-light .kcm-sheet-pill{background:rgba(15,23,42,0.05);border-color:rgba(15,23,42,0.10);color:#374151;}',
      '.kcm-sheet-block{padding:9px 10px;border-radius:7px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:4px;}',
      '.kcm-root.is-light .kcm-sheet-block{background:rgba(15,23,42,0.025);border-color:rgba(15,23,42,0.08);}',
      '.kcm-sheet-block-lbl{font-family:var(--font-mono,monospace);font-size:var(--t-xs,11px);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#a1a1aa;}',
      '.kcm-root.is-light .kcm-sheet-block-lbl{color:#4b5563;}',
      '.kcm-sheet-block-text{margin:0;font-size:var(--t-base,13px);line-height:1.48;color:#e4e4e7;}',
      '.kcm-root.is-light .kcm-sheet-block-text{color:#1f2937;}',
      '.kcm-sheet-actions{display:flex;flex-wrap:wrap;gap:6px;padding-top:4px;}',
      '.kcm-sheet-btn{appearance:none;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#ededed;font-family:var(--font-mono,monospace);font-size:var(--t-xs,11px);font-weight:500;height:28px;padding:0 9px;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;}',
      '.kcm-sheet-btn:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.24);}',
      '.kcm-sheet-btn.is-primary{border-color:rgba(52,211,153,0.45);background:rgba(52,211,153,0.14);color:#6ee7b7;}',
      '.kcm-root.is-light .kcm-sheet-btn{border-color:rgba(15,23,42,0.14);background:rgba(15,23,42,0.04);color:#111827;}',
      '.kcm-root.is-light .kcm-sheet-btn:hover{background:rgba(15,23,42,0.09);}',
      '.kcm-root.is-light .kcm-sheet-btn.is-primary{border-color:rgba(4,120,87,0.35);background:rgba(4,120,87,0.10);color:#047857;}',
      '.kcm-sheet-crosslink{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:5px;border:1px solid rgba(56,189,248,0.32);background:rgba(56,189,248,0.10);color:#7dd3fc;font-family:var(--font-mono,monospace);font-size:var(--t-xs,11px);cursor:pointer;text-align:left;}',
      '.kcm-sheet-crosslink.is-conflicts{border-color:rgba(255,107,74,0.42);background:rgba(255,107,74,0.12);color:#ff8a6b;}',
      '.kcm-root.is-light .kcm-sheet-crosslink{color:#0369a1;background:rgba(3,105,161,0.08);border-color:rgba(3,105,161,0.26);}',
      '.kcm-root.is-light .kcm-sheet-crosslink.is-conflicts{color:#b91c1c;background:rgba(185,28,28,0.08);border-color:rgba(185,28,28,0.28);}',
      '.kcm-sheet-neighbor-list{display:flex;flex-direction:column;gap:4px;}',
      '.kcm-sheet-neighbor-btn{appearance:none;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#d4d4d8;font-family:var(--font-sans,sans-serif);font-size:var(--t-sm,12px);padding:6px 8px;border-radius:6px;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.kcm-sheet-neighbor-btn:hover{background:rgba(255,255,255,0.08);color:#ffffff;}',
      '.kcm-root.is-light .kcm-sheet-neighbor-btn{border-color:rgba(15,23,42,0.09);background:rgba(15,23,42,0.025);color:#1f2937;}',
      '.kcm-root.is-light .kcm-sheet-neighbor-btn:hover{background:rgba(15,23,42,0.06);}',
      '@media (max-width:640px){.kcm-root{min-height:480px;}.kcm-toolbar{top:8px;left:8px;right:8px;gap:6px;}.kcm-filter-group{max-width:100%;padding-right:20px;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);}.kcm-btn{font-size:var(--t-xs,11px);padding:0 7px;height:24px;}.kcm-footer{position:absolute;left:8px;right:8px;bottom:8px;max-width:none;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 7px;padding:5px 8px;font-size:var(--t-xs,11px);white-space:normal;}.kcm-sheet{top:auto;left:8px;right:8px;bottom:8px;width:auto;max-height:62%;}}',
      '.kcm-hud{position:absolute;top:0;left:0;z-index:6;pointer-events:none;width:284px;max-width:calc(100% - 24px);padding:11px 12px;border-radius:10px;background:rgba(11,12,16,0.95);border:1px solid rgba(255,255,255,0.14);box-shadow:0 12px 32px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.05);color:#ededed;opacity:0;visibility:hidden;transform:translate3d(0,0,0);transition:opacity 110ms ease;}',
      '.kcm-hud.is-visible{opacity:1;visibility:visible;}',
      '.kcm-root.is-light .kcm-hud{background:rgba(255,255,255,0.97);border-color:rgba(15,23,42,0.14);box-shadow:0 10px 28px rgba(15,23,42,0.12),0 0 0 1px rgba(15,23,42,0.04);color:#171717;}',
      '.kcm-hud-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);letter-spacing:0.04em;text-transform:uppercase;color:#b5b5bd;}',
      '.kcm-root.is-light .kcm-hud-top{color:#4b5563;}',
      '.kcm-hud-kind{display:inline-flex;align-items:center;gap:6px;font-weight:500;}',
      '.kcm-hud-score{padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.08);color:#ededed;font-weight:500;}',
      '.kcm-root.is-light .kcm-hud-score{background:rgba(15,23,42,0.07);color:#171717;}',
      '.kcm-hud-title{font-size:var(--t-base,13px);font-weight:600;line-height:1.3;margin:0 0 5px 0;color:#ffffff;letter-spacing:-0.01em;}',
      '.kcm-root.is-light .kcm-hud-title{color:#111827;}',
      '.kcm-hud-meta{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px;}',
      '.kcm-hud-pill{font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);line-height:1;padding:3px 6px;border-radius:4px;background:rgba(255,255,255,0.07);color:#d4d4d8;border:1px solid rgba(255,255,255,0.09);}',
      '.kcm-root.is-light .kcm-hud-pill{background:rgba(15,23,42,0.05);color:#374151;border-color:rgba(15,23,42,0.10);}',
      '.kcm-hud-excerpt{font-size:var(--t-sm,12px);line-height:1.45;color:#b5b5bd;margin:0 0 8px 0;}',
      '.kcm-root.is-light .kcm-hud-excerpt{color:#374151;}',
      '.kcm-hud-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.08);font-family:var(--font-mono,"Geist Mono",monospace);font-size:var(--t-xs,11px);color:#a1a1aa;}',
      '.kcm-root.is-light .kcm-hud-foot{border-top-color:rgba(15,23,42,0.08);color:#52525b;}',
      '.kcm-hud-cta{color:#ededed;font-weight:500;}',
      '.kcm-root.is-light .kcm-hud-cta{color:#111827;}',
      '@media (prefers-reduced-motion:reduce){.kcm-sheet{transition:none;}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ========================================================================
  // DETERMINISTIC RADIAL-CLUSTER TOPOLOGY BUILDER
  // ========================================================================

  function buildTopology(rawItems) {
    const items = Array.isArray(rawItems)
      ? rawItems.filter((it) => it && typeof it === 'object' && it.status !== 'archived')
      : [];

    const nodes = [];
    const nodeById = Object.create(null);
    const edges = [];
    const adjacency = Object.create(null);
    const edgeKeySet = Object.create(null);
    const sectorCounts = {
      philosophies: 0,
      interests: 0,
      hobbies: 0,
      ideas: 0,
    };

    function addAdj(aId, bId, edgeIdx) {
      if (!adjacency[aId]) adjacency[aId] = [];
      adjacency[aId].push({ neighborId: bId, edgeIdx });
    }

    function addEdge(sourceId, targetId, kind, reason, sectorId) {
      if (sourceId === targetId) return;
      const key = sourceId < targetId ? (sourceId + '||' + targetId) : (targetId + '||' + sourceId);
      if (edgeKeySet[key]) return;
      edgeKeySet[key] = true;
      const idx = edges.length;
      edges.push({
        id: key,
        sourceId,
        targetId,
        kind, // 'person' | 'domain' | 'tag'
        reason: cleanText(reason || ''),
        sectorId: sectorId || null,
      });
      addAdj(sourceId, targetId, idx);
      addAdj(targetId, sourceId, idx);
    }

    // Group items by orbital sector
    const bySector = {
      philosophies: [],
      interests: [],
      hobbies: [],
      ideas: [],
    };

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const sectorId = mapSectionToSectorId(it.section);
      bySector[sectorId].push(it);
      sectorCounts[sectorId] += 1;
    }

    // Place item nodes deterministically inside each sector wedge
    for (let sIdx = 0; sIdx < SECTORS.length; sIdx += 1) {
      const sector = SECTORS[sIdx];
      const list = bySector[sector.id];
      if (!list.length) continue;

      // Group by domain so related items cluster angularly
      const domainGroups = Object.create(null);
      for (let i = 0; i < list.length; i += 1) {
        const dKey = cleanText(list[i].domain || 'General').toLowerCase() || 'general';
        if (!domainGroups[dKey]) domainGroups[dKey] = [];
        domainGroups[dKey].push(list[i]);
      }

      const domainKeys = Object.keys(domainGroups).sort((a, b) => {
        const diff = domainGroups[b].length - domainGroups[a].length;
        return diff !== 0 ? diff : a.localeCompare(b);
      });

      const ordered = [];
      for (let d = 0; d < domainKeys.length; d += 1) {
        const grp = domainGroups[domainKeys[d]];
        grp.sort((a, b) => {
          const pDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
          if (pDiff !== 0) return pDiff;
          const lDiff = (Number(b.leverage_score) || 0) - (Number(a.leverage_score) || 0);
          if (lDiff !== 0) return lDiff;
          return cleanText(a.title).localeCompare(cleanText(b.title));
        });
        for (let k = 0; k < grp.length; k += 1) {
          ordered.push(grp[k]);
        }
      }

      const startA = sector.startAngle + SECTOR_GAP_RAD;
      const endA = sector.endAngle - SECTOR_GAP_RAD;
      const spanA = Math.max(0.2, endA - startA);
      const count = ordered.length;
      const sectorNodes = [];

      for (let i = 0; i < count; i += 1) {
        const item = ordered[i];
        const id = 'item:' + String(item.id || (sector.id + '_' + i));
        const leverage = clamp(Number(item.leverage_score) || 72, 0, 100);
        const pinned = Boolean(item.pinned);
        const seed = hashString(id + '|' + cleanText(item.title));

        // Angular position distributes evenly across the sector with subtle deterministic jitter
        const frac = count === 1 ? 0.5 : (i + 0.5) / count;
        const jitterA = (seed - 0.5) * Math.min(0.055, (spanA / Math.max(count, 2)) * 0.42);
        const angle = clamp(startA + frac * spanA + jitterA, startA + 0.02, endA - 0.02);

        // Radial tier: high-leverage / pinned gravitate toward inner prime orbit; alternating stagger avoids crowding
        const levNorm = (100 - leverage) / 100; // 0 = inner, 1 = outer
        const bandOffset = ((i % 3) - 1) * 18;
        const pinPull = pinned ? -24 : 0;
        const actionPush = String(item.section || '').toLowerCase() === 'actions' ? 28 : 0;
        const baseR = ITEM_R_MIN + 26 + levNorm * (ITEM_R_MAX - ITEM_R_MIN - 44) + bandOffset + pinPull + actionPush;
        const radiusR = clamp(baseR + (hashString(id + ':r') - 0.5) * 14, ITEM_R_MIN, ITEM_R_MAX);

        const nodeRadius = clamp(4.6 + (leverage / 100) * 3.4 + (pinned ? 1.6 : 0), 4.8, 10.2);

        const node = {
          id,
          kind: 'item',
          sectorId: sector.id,
          rawSection: String(item.section || sector.id),
          title: cleanText(item.title || 'Untitled Entry'),
          domain: cleanText(item.domain || 'General'),
          domainKey: cleanText(item.domain || 'General').toLowerCase(),
          stage: cleanText(item.stage || ''),
          conviction: cleanText(item.conviction || 'active'),
          leverage,
          pinned,
          tags: Array.isArray(item.tags)
            ? item.tags.map((t) => cleanText(t).toLowerCase()).filter(Boolean)
            : [],
          linkedPeople: Array.isArray(item.linked_people)
            ? item.linked_people.map((p) => cleanText(p)).filter(Boolean)
            : [],
          excerpt: truncateText(item.thesis || item.next_move || item.summary || item.subtitle || '', 148),
          item,
          angle,
          orbitR: radiusR,
          x: Math.cos(angle) * radiusR,
          y: Math.sin(angle) * radiusR,
          radius: nodeRadius,
          degree: 0,
        };
        nodes.push(node);
        nodeById[id] = node;
        sectorNodes.push(node);
      }

      // Deterministic collision relaxation strictly clamped inside the sector wedge
      const minSep = count > 22 ? 22 : 28;
      for (let iter = 0; iter < 18; iter += 1) {
        let moved = false;
        for (let i = 0; i < sectorNodes.length; i += 1) {
          const a = sectorNodes[i];
          for (let j = i + 1; j < sectorNodes.length; j += 1) {
            const b = sectorNodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            const target = a.radius + b.radius + minSep;
            if (dist < target) {
              if (dist < 0.001) {
                dx = Math.cos(a.angle + 0.5);
                dy = Math.sin(a.angle + 0.5);
                dist = 1;
              }
              const push = (target - dist) * 0.42;
              const ux = dx / dist;
              const uy = dy / dist;
              a.x -= ux * push;
              a.y -= uy * push;
              b.x += ux * push;
              b.y += uy * push;
              moved = true;
            }
          }
        }
        // Re-clamp into sector wedge
        for (let i = 0; i < sectorNodes.length; i += 1) {
          const n = sectorNodes[i];
          let a = normalizeAngle(Math.atan2(n.y, n.x));
          // Handle quadrant wrap cleanly
          const clampedA = clamp(a, startA + 0.025, endA - 0.025);
          const clampedR = clamp(Math.hypot(n.x, n.y), ITEM_R_MIN, ITEM_R_MAX);
          n.angle = clampedA;
          n.orbitR = clampedR;
          n.x = Math.cos(clampedA) * clampedR;
          n.y = Math.sin(clampedA) * clampedR;
        }
        if (!moved) break;
      }
    }

    // Extract Core People dynamically from item.linked_people[]
    const personMap = Object.create(null);
    const itemNodes = nodes.slice();

    for (let i = 0; i < itemNodes.length; i += 1) {
      const n = itemNodes[i];
      const seenForItem = Object.create(null);
      for (let p = 0; p < n.linkedPeople.length; p += 1) {
        const displayName = n.linkedPeople[p];
        const key = displayName.toLowerCase();
        if (!key || seenForItem[key]) continue;
        seenForItem[key] = true;
        if (!personMap[key]) {
          personMap[key] = {
            key,
            name: displayName,
            linkedItemNodes: [],
            sectorBreakdown: { philosophies: 0, interests: 0, hobbies: 0, ideas: 0 },
          };
        }
        personMap[key].linkedItemNodes.push(n);
        personMap[key].sectorBreakdown[n.sectorId] = (personMap[key].sectorBreakdown[n.sectorId] || 0) + 1;
      }
    }

    const personEntries = Object.keys(personMap).map((k) => personMap[k]);
    // Compute ideal angle for each person (circular mean of their linked items)
    for (let i = 0; i < personEntries.length; i += 1) {
      const entry = personEntries[i];
      let sumCos = 0;
      let sumSin = 0;
      for (let j = 0; j < entry.linkedItemNodes.length; j += 1) {
        const itNode = entry.linkedItemNodes[j];
        const weight = 0.6 + (itNode.leverage / 100) * 0.6 + (itNode.pinned ? 0.35 : 0);
        sumCos += Math.cos(itNode.angle) * weight;
        sumSin += Math.sin(itNode.angle) * weight;
      }
      if (Math.hypot(sumCos, sumSin) < 0.01) {
        entry.idealAngle = hashString(entry.key) * TWO_PI;
      } else {
        entry.idealAngle = normalizeAngle(Math.atan2(sumSin, sumCos));
      }
    }

    // Sort people around the ring deterministically by idealAngle, then name
    personEntries.sort((a, b) => {
      const d = a.idealAngle - b.idealAngle;
      if (Math.abs(d) > 1e-6) return d;
      return a.name.localeCompare(b.name);
    });

    // Separate people angles cleanly around the inner bridge ring
    const pCount = personEntries.length;
    if (pCount > 0) {
      const minAngGap = Math.min(0.46, (TWO_PI * 0.86) / Math.max(pCount, 1));
      const angles = personEntries.map((e) => e.idealAngle);
      for (let iter = 0; iter < 24; iter += 1) {
        let adjusted = false;
        for (let i = 0; i < pCount; i += 1) {
          const next = (i + 1) % pCount;
          if (i === next) continue;
          let gap = normalizeAngle(angles[next] - angles[i]);
          if (pCount > 1 && gap < minAngGap) {
            const delta = (minAngGap - gap) * 0.5;
            angles[i] = normalizeAngle(angles[i] - delta);
            angles[next] = normalizeAngle(angles[next] + delta);
            adjusted = true;
          }
        }
        if (!adjusted) break;
      }

      for (let i = 0; i < pCount; i += 1) {
        const entry = personEntries[i];
        const id = 'person:' + entry.key;
        const a = angles[i];
        const ringOffset = pCount > 9 ? ((i % 2 === 0 ? -1 : 1) * 10) : 0;
        const r = PEOPLE_RING_R + ringOffset;
        const linkedCount = entry.linkedItemNodes.length;
        const nodeRadius = clamp(6.6 + Math.sqrt(linkedCount) * 1.45, 7.0, 11.2);

        const pNode = {
          id,
          kind: 'person',
          sectorId: 'people',
          name: entry.name,
          title: entry.name,
          linkedCount,
          sectorBreakdown: entry.sectorBreakdown,
          topItems: entry.linkedItemNodes
            .slice()
            .sort((x, y) => y.leverage - x.leverage)
            .slice(0, 3)
            .map((x) => x.title),
          angle: a,
          orbitR: r,
          x: Math.cos(a) * r,
          y: Math.sin(a) * r,
          radius: nodeRadius,
          leverage: clamp(70 + linkedCount * 5, 70, 100),
          pinned: true,
          degree: 0,
        };
        nodes.push(pNode);
        nodeById[id] = pNode;

        for (let j = 0; j < entry.linkedItemNodes.length; j += 1) {
          const targetItemNode = entry.linkedItemNodes[j];
          addEdge(pNode.id, targetItemNode.id, 'person', entry.name, targetItemNode.sectorId);
        }
      }
    }

    // Build Domain chords (cross-sector bridges + clean within-domain chains)
    const byDomain = Object.create(null);
    for (let i = 0; i < itemNodes.length; i += 1) {
      const n = itemNodes[i];
      if (!n.domainKey || n.domainKey === 'general') continue;
      if (!byDomain[n.domainKey]) byDomain[n.domainKey] = [];
      byDomain[n.domainKey].push(n);
    }

    const domList = Object.keys(byDomain).sort();
    for (let d = 0; d < domList.length; d += 1) {
      const grp = byDomain[domList[d]];
      if (grp.length < 2) continue;
      // Sort by leverage desc so anchor is first
      grp.sort((a, b) => (b.leverage - a.leverage) || a.id.localeCompare(b.id));
      const hub = grp[0];
      // Connect every member to the domain hub + adjacent member in angular order for crisp structure
      for (let i = 1; i < grp.length; i += 1) {
        addEdge(hub.id, grp[i].id, 'domain', hub.domain, grp[i].sectorId);
      }
      // Also bridge across distinct sectors sharing this domain
      const byDomSector = Object.create(null);
      for (let i = 0; i < grp.length; i += 1) {
        if (!byDomSector[grp[i].sectorId]) byDomSector[grp[i].sectorId] = grp[i];
      }
      const domSectors = Object.keys(byDomSector);
      for (let i = 0; i < domSectors.length; i += 1) {
        for (let j = i + 1; j < domSectors.length; j += 1) {
          addEdge(
            byDomSector[domSectors[i]].id,
            byDomSector[domSectors[j]].id,
            'domain',
            hub.domain,
            byDomSector[domSectors[i]].sectorId
          );
        }
      }
    }

    // Build shared Tag chords (favoring cross-sector & concise fan-out to prevent hairballs)
    const byTag = Object.create(null);
    for (let i = 0; i < itemNodes.length; i += 1) {
      const n = itemNodes[i];
      for (let t = 0; t < n.tags.length; t += 1) {
        const tag = n.tags[t];
        if (!tag || tag.length < 2) continue;
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push(n);
      }
    }

    const tagList = Object.keys(byTag).sort();
    for (let t = 0; t < tagList.length; t += 1) {
      const tag = tagList[t];
      const grp = byTag[tag];
      if (grp.length < 2 || grp.length > 14) continue;
      grp.sort((a, b) => (b.leverage - a.leverage) || a.id.localeCompare(b.id));
      const anchor = grp[0];
      const maxLinks = Math.min(grp.length, 6);
      for (let i = 1; i < maxLinks; i += 1) {
        addEdge(anchor.id, grp[i].id, 'tag', '#' + tag, grp[i].sectorId);
      }
    }

    // Compute final degrees
    for (let i = 0; i < nodes.length; i += 1) {
      const adj = adjacency[nodes[i].id];
      nodes[i].degree = adj ? adj.length : 0;
    }

    // Compute quadrant hub centroids for graceful hub-bundled edge curves
    const sectorHubs = Object.create(null);
    for (let sIdx = 0; sIdx < SECTORS.length; sIdx += 1) {
      const sec = SECTORS[sIdx];
      let sx = 0;
      let sy = 0;
      let sc = 0;
      for (let i = 0; i < itemNodes.length; i += 1) {
        if (itemNodes[i].sectorId === sec.id) {
          sx += itemNodes[i].x;
          sy += itemNodes[i].y;
          sc += 1;
        }
      }
      if (sc > 0) {
        sectorHubs[sec.id] = { x: (sx / sc) * 0.78, y: (sy / sc) * 0.78 };
      } else {
        const midA = (sec.startAngle + sec.endAngle) * 0.5;
        sectorHubs[sec.id] = { x: Math.cos(midA) * 195, y: Math.sin(midA) * 195 };
      }
    }

    // Compute tight node world bounds for deterministic Auto-Fit camera solver
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (n.x - n.radius < minX) minX = n.x - n.radius;
      if (n.x + n.radius > maxX) maxX = n.x + n.radius;
      if (n.y - n.radius < minY) minY = n.y - n.radius;
      if (n.y + n.radius > maxY) maxY = n.y + n.radius;
    }
    if (!Number.isFinite(minX)) {
      minX = -WORLD_RADIUS;
      maxX = WORLD_RADIUS;
      minY = -WORLD_RADIUS;
      maxY = WORLD_RADIUS;
    }

    return {
      nodes,
      itemNodes,
      personNodes: nodes.filter((n) => n.kind === 'person'),
      nodeById,
      edges,
      adjacency,
      sectorCounts,
      sectorHubs,
      bounds: { minX, maxX, minY, maxY },
    };
  }

  // ========================================================================
  // MAIN MOUNTABLE CONSTELLATION CONTROLLER
  // ========================================================================

  function mount(containerEl, opts) {
    if (!containerEl) {
      throw new Error('KizukiCodexMap.mount requires a containerEl');
    }

    const options = opts && typeof opts === 'object' ? opts : {};
    const onSelectItem = typeof options.onSelectItem === 'function' ? options.onSelectItem : null;
    const onSelectPerson = typeof options.onSelectPerson === 'function' ? options.onSelectPerson : null;
    const renderSideSheetFn = typeof options.renderSideSheet === 'function' ? options.renderSideSheet : null;

    ensureScopedStyles();

    const state = {
      destroyed: false,
      isVisible: true,
      width: 800,
      height: 580,
      dpr: 1,
      palette: resolvePalette(containerEl),
      topology: buildTopology(options.items || []),
      stats: options.stats && typeof options.stats === 'object' ? Object.assign({}, options.stats) : null,
      activeFilter: 'all', // 'all' | 'philosophies' | 'interests' | 'hobbies' | 'ideas' | 'people'
      hoveredNodeId: null,
      selectedNodeId: null,
      hoverMix: 0,
      targetHoverMix: 0,
      hoverAnim: null,
      filterSweep: null,
      packetBurst: null,
      lastHudRect: null,
      cam: { x: 0, y: 0, scale: 1 },
      targetCam: { x: 0, y: 0, scale: 1 },
      dragging: false,
      dragMoved: false,
      dragStartX: 0,
      dragStartY: 0,
      dragOriginCamX: 0,
      dragOriginCamY: 0,
      pointerX: 0,
      pointerY: 0,
      rafId: null,
      panRafPending: false,
      reducedMotion: false,
      gridPattern: null,
      gridPatternLight: null,
      lastStats: { fitRatio: 0, labelCount: 0, overlapCount: 0, nodeCount: 0, linkCount: 0, zoom: 1, filter: 'all' },
    };

    let motionQuery = null;
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        state.reducedMotion = Boolean(motionQuery.matches);
      }
    } catch {
      state.reducedMotion = false;
    }

    function isMotionReduced() {
      if (state.reducedMotion) return true;
      if (options.detail === 'off') return true;
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          const docEl = document.documentElement;
          if (
            (docEl.dataset && docEl.dataset.detail === 'off') ||
            (typeof docEl.getAttribute === 'function' && docEl.getAttribute('data-detail') === 'off')
          ) {
            return true;
          }
        }
      } catch {
        // ignore non-DOM environments
      }
      return false;
    }

    // Build DOM shell safely (zero innerHTML with untrusted data)
    const rootEl = document.createElement('div');
    rootEl.className = 'kcm-root' + (state.palette.isLight ? ' is-light' : '');
    rootEl.setAttribute('role', 'region');
    rootEl.setAttribute('aria-label', 'Personal Mind Constellation');

    const canvas = document.createElement('canvas');
    canvas.className = 'kcm-canvas';
    canvas.setAttribute('aria-label', 'Interactive constellation graph of philosophies, interests, hobbies, ideas, and core people');
    rootEl.appendChild(canvas);

    // Top HUD toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'kcm-toolbar';

    const filterGroup = document.createElement('div');
    filterGroup.className = 'kcm-group kcm-filter-group';

    const filterButtons = Object.create(null);
    const filterDefs = [
      { id: 'all', label: 'All', dot: null },
      { id: 'philosophies', label: 'Philosophies', dot: 'philosophies' },
      { id: 'interests', label: 'Interests', dot: 'interests' },
      { id: 'hobbies', label: 'Hobbies', dot: 'hobbies' },
      { id: 'ideas', label: 'Ideas', dot: 'ideas' },
      { id: 'people', label: 'People', dot: 'people' },
    ];

    for (let i = 0; i < filterDefs.length; i += 1) {
      const def = filterDefs[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kcm-btn' + (def.id === 'all' ? ' is-active' : '');
      btn.setAttribute('data-kcm-filter', def.id);
      if (def.dot === 'people') {
        const dia = document.createElement('span');
        dia.className = 'kcm-diamond';
        btn.appendChild(dia);
      } else if (def.dot) {
        const dot = document.createElement('span');
        dot.className = 'kcm-dot';
        dot.setAttribute('data-kcm-dot', def.dot);
        dot.style.backgroundColor = state.palette.sectorColor(def.dot);
        btn.appendChild(dot);
      }
      const txt = document.createElement('span');
      txt.textContent = def.label;
      btn.appendChild(txt);
      filterGroup.appendChild(btn);
      filterButtons[def.id] = btn;
    }
    toolbar.appendChild(filterGroup);

    const viewGroup = document.createElement('div');
    viewGroup.className = 'kcm-group';

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'kcm-btn';
    zoomOutBtn.setAttribute('aria-label', 'Zoom out');
    zoomOutBtn.textContent = '-';

    const zoomReadout = document.createElement('span');
    zoomReadout.className = 'kcm-zoom-readout';
    zoomReadout.textContent = '100%';

    const zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'kcm-btn';
    zoomInBtn.setAttribute('aria-label', 'Zoom in');
    zoomInBtn.textContent = '+';

    const fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.className = 'kcm-btn';
    fitBtn.setAttribute('aria-label', 'Fit constellation to view');
    fitBtn.textContent = 'Fit';

    viewGroup.appendChild(zoomOutBtn);
    viewGroup.appendChild(zoomReadout);
    viewGroup.appendChild(zoomInBtn);
    viewGroup.appendChild(fitBtn);
    toolbar.appendChild(viewGroup);

    rootEl.appendChild(toolbar);

    // Bottom telemetry legend strip
    const footerEl = document.createElement('div');
    footerEl.className = 'kcm-footer';
    rootEl.appendChild(footerEl);

    // Floating HUD inspector pill (built strictly via textContent -> zero XSS)
    const hudEl = document.createElement('div');
    hudEl.className = 'kcm-hud';
    hudEl.setAttribute('role', 'status');
    hudEl.setAttribute('aria-live', 'polite');

    const hudTop = document.createElement('div');
    hudTop.className = 'kcm-hud-top';
    const hudKind = document.createElement('span');
    hudKind.className = 'kcm-hud-kind';
    const hudDot = document.createElement('span');
    hudDot.className = 'kcm-dot';
    const hudKindText = document.createElement('span');
    hudKind.appendChild(hudDot);
    hudKind.appendChild(hudKindText);
    const hudScore = document.createElement('span');
    hudScore.className = 'kcm-hud-score';
    hudTop.appendChild(hudKind);
    hudTop.appendChild(hudScore);

    const hudTitle = document.createElement('h4');
    hudTitle.className = 'kcm-hud-title';

    const hudMeta = document.createElement('div');
    hudMeta.className = 'kcm-hud-meta';

    const hudExcerpt = document.createElement('p');
    hudExcerpt.className = 'kcm-hud-excerpt';

    const hudFoot = document.createElement('div');
    hudFoot.className = 'kcm-hud-foot';
    const hudLinks = document.createElement('span');
    const hudCta = document.createElement('span');
    hudCta.className = 'kcm-hud-cta';
    hudFoot.appendChild(hudLinks);
    hudFoot.appendChild(hudCta);

    hudEl.appendChild(hudTop);
    hudEl.appendChild(hudTitle);
    hudEl.appendChild(hudMeta);
    hudEl.appendChild(hudExcerpt);
    hudEl.appendChild(hudFoot);
    rootEl.appendChild(hudEl);

    // Non-blocking right side sheet inside the stage
    const sheetEl = document.createElement('aside');
    sheetEl.className = 'kcm-sheet';
    sheetEl.setAttribute('aria-label', 'Selected Codex entry inspector');
    sheetEl.setAttribute('aria-hidden', 'true');

    const sheetHead = document.createElement('div');
    sheetHead.className = 'kcm-sheet-head';
    const sheetEyebrow = document.createElement('span');
    sheetEyebrow.className = 'kcm-sheet-eyebrow';
    const sheetCloseBtn = document.createElement('button');
    sheetCloseBtn.type = 'button';
    sheetCloseBtn.className = 'kcm-sheet-close';
    sheetCloseBtn.setAttribute('aria-label', 'Close side sheet');
    sheetCloseBtn.textContent = 'x';
    sheetHead.appendChild(sheetEyebrow);
    sheetHead.appendChild(sheetCloseBtn);

    const sheetBody = document.createElement('div');
    sheetBody.className = 'kcm-sheet-body';
    sheetEl.appendChild(sheetHead);
    sheetEl.appendChild(sheetBody);
    rootEl.appendChild(sheetEl);

    // Clear container and mount
    while (containerEl.firstChild) {
      containerEl.removeChild(containerEl.firstChild);
    }
    containerEl.appendChild(rootEl);

    const ctx = canvas.getContext('2d');

    function updateFooterTelemetry() {
      const topo = state.topology;
      const pal = state.palette;
      const sc = topo.sectorCounts || {};
      const st = state.stats || {};
      const philCount = st.philosophies != null ? Number(st.philosophies) : (sc.philosophies || 0);
      const intCount = st.interests != null ? Number(st.interests) : (sc.interests || 0);
      const hobCount = st.hobbies != null ? Number(st.hobbies) : (sc.hobbies || 0);
      const ideaCount = st.ideas != null ? Number(st.ideas) : (sc.ideas || 0);
      const decCount = st.decisions_open != null ? Number(st.decisions_open) : 0;

      while (footerEl.firstChild) {
        footerEl.removeChild(footerEl.firstChild);
      }

      const entries = [
        { label: philCount + ' Phil', sector: 'philosophies' },
        { label: intCount + ' Int', sector: 'interests' },
        { label: hobCount + ' Hob', sector: 'hobbies' },
        { label: ideaCount + ' Ideas', sector: 'ideas' },
        { label: decCount + ' Decisions', sector: null },
      ];

      for (let i = 0; i < entries.length; i += 1) {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'kcm-footer-sep';
          sep.textContent = '\u00B7';
          footerEl.appendChild(sep);
        }
        const item = document.createElement('span');
        item.className = 'kcm-footer-item';
        if (entries[i].sector) {
          const dot = document.createElement('span');
          dot.className = 'kcm-dot';
          dot.style.backgroundColor = pal.sectorColor(entries[i].sector);
          item.appendChild(dot);
        }
        const txt = document.createElement('span');
        txt.textContent = entries[i].label;
        item.appendChild(txt);
        footerEl.appendChild(item);
      }
    }

    function renderDefaultSideSheet(node) {
      while (sheetBody.firstChild) {
        sheetBody.removeChild(sheetBody.firstChild);
      }
      if (!node) return;
      const pal = state.palette;
      const sec = SECTOR_BY_ID[node.sectorId];
      sheetEyebrow.textContent = node.kind === 'person'
        ? 'CORE PERSON HUB'
        : ((sec ? sec.label : 'CODEX ENTRY').toUpperCase() + ' · LEV ' + Math.round(node.leverage));

      const title = document.createElement('h3');
      title.className = 'kcm-sheet-title';
      title.textContent = node.kind === 'person' ? node.name : formatNodeDisplayTitle(node.title);
      sheetBody.appendChild(title);

      if (node.kind === 'item' && node.item) {
        const it = node.item;
        if (it.subtitle) {
          const sub = document.createElement('p');
          sub.className = 'kcm-sheet-sub';
          sub.textContent = cleanText(it.subtitle);
          sheetBody.appendChild(sub);
        }

        const pills = document.createElement('div');
        pills.className = 'kcm-sheet-pills';
        const pillTexts = [
          it.domain || 'General',
          it.stage ? it.stage.toUpperCase() : (it.conviction ? it.conviction.toUpperCase() : ''),
          it.pinned ? 'PINNED' : '',
          node.degree + ' links',
        ].filter(Boolean);
        for (let i = 0; i < pillTexts.length; i += 1) {
          const p = document.createElement('span');
          p.className = 'kcm-sheet-pill';
          p.textContent = pillTexts[i];
          pills.appendChild(p);
        }
        sheetBody.appendChild(pills);

        const sections = [
          { lbl: 'CORE THESIS', val: it.thesis },
          { lbl: 'ANTI-PATTERN', val: it.anti_pattern },
          { lbl: 'SUMMARY', val: it.summary },
          { lbl: 'NEXT MOVE', val: it.next_move },
        ];
        for (let i = 0; i < sections.length; i += 1) {
          if (!sections[i].val) continue;
          const blk = document.createElement('div');
          blk.className = 'kcm-sheet-block';
          const lbl = document.createElement('span');
          lbl.className = 'kcm-sheet-block-lbl';
          lbl.textContent = sections[i].lbl;
          const txt = document.createElement('p');
          txt.className = 'kcm-sheet-block-text';
          txt.textContent = cleanText(sections[i].val);
          blk.appendChild(lbl);
          blk.appendChild(txt);
          sheetBody.appendChild(blk);
        }

        const actions = document.createElement('div');
        actions.className = 'kcm-sheet-actions';
        if (onSelectItem) {
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'kcm-sheet-btn is-primary';
          openBtn.textContent = 'Open in Cards View';
          openBtn.addEventListener('click', () => onSelectItem(it));
          actions.appendChild(openBtn);
        }
        if (actions.childNodes.length) {
          sheetBody.appendChild(actions);
        }
      } else if (node.kind === 'person') {
        const sub = document.createElement('p');
        sub.className = 'kcm-sheet-sub';
        sub.textContent = node.linkedCount + ' linked Codex entries across your Mind Constellation.';
        sheetBody.appendChild(sub);

        if (onSelectPerson) {
          const actions = document.createElement('div');
          actions.className = 'kcm-sheet-actions';
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'kcm-sheet-btn is-primary';
          openBtn.textContent = 'Open Person Dossier';
          openBtn.addEventListener('click', () => onSelectPerson(node.name));
          actions.appendChild(openBtn);
          sheetBody.appendChild(actions);
        }
      }

      // Connected constellation neighbors
      const neighbors = getRankedNeighbors(node.id, 6);
      if (neighbors.length) {
        const nBlk = document.createElement('div');
        nBlk.className = 'kcm-sheet-block';
        const nLbl = document.createElement('span');
        nLbl.className = 'kcm-sheet-block-lbl';
        nLbl.textContent = 'CONNECTED IN CONSTELLATION (' + neighbors.length + ')';
        nBlk.appendChild(nLbl);
        const nList = document.createElement('div');
        nList.className = 'kcm-sheet-neighbor-list';
        for (let i = 0; i < neighbors.length; i += 1) {
          const nb = neighbors[i].node;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'kcm-sheet-neighbor-btn';
          const left = document.createElement('span');
          left.textContent = nb.kind === 'person' ? nb.name : formatNodeDisplayTitle(nb.title);
          const right = document.createElement('span');
          right.className = 'kcm-dot';
          right.style.backgroundColor = nb.kind === 'person' ? pal.personCore : pal.sectorColor(nb.sectorId);
          btn.appendChild(left);
          btn.appendChild(right);
          btn.addEventListener('click', () => openSideSheet(nb));
          nList.appendChild(btn);
        }
        nBlk.appendChild(nList);
        sheetBody.appendChild(nBlk);
      }
    }

    function openSideSheet(node) {
      if (!node) {
        closeSideSheet();
        return;
      }
      state.selectedNodeId = node.id;
      setHoveredNode(null);
      const sec = SECTOR_BY_ID[node.sectorId];
      sheetEyebrow.textContent = node.kind === 'person'
        ? 'CORE PERSON HUB'
        : ((sec ? sec.label : 'CODEX ENTRY').toUpperCase() + ' · LEV ' + Math.round(node.leverage));

      if (renderSideSheetFn) {
        try {
          renderSideSheetFn(sheetBody, node, {
            closeSheet: closeSideSheet,
            selectNodeById(nid) {
              const target = state.topology.nodeById[nid];
              if (target) openSideSheet(target);
            },
            neighbors: getRankedNeighbors(node.id, 6).map((x) => x.node),
          });
        } catch {
          renderDefaultSideSheet(node);
        }
      } else {
        renderDefaultSideSheet(node);
      }

      sheetEl.classList.add('is-open');
      sheetEl.setAttribute('aria-hidden', 'false');
      scheduleRender(true);
    }

    function closeSideSheet() {
      if (!state.selectedNodeId && !sheetEl.classList.contains('is-open')) return;
      state.selectedNodeId = null;
      sheetEl.classList.remove('is-open');
      sheetEl.setAttribute('aria-hidden', 'true');
      scheduleRender(true);
    }

    function updateZoomReadout() {
      const pct = Math.round(state.cam.scale * 100);
      zoomReadout.textContent = pct + '%';
    }

    function syncFilterButtonDots() {
      const keys = Object.keys(filterButtons);
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const btn = filterButtons[k];
        if (!btn) continue;
        if (k === state.activeFilter) {
          btn.classList.add('is-active');
        } else {
          btn.classList.remove('is-active');
        }
        const dot = btn.querySelector ? btn.querySelector('[data-kcm-dot]') : null;
        if (dot) {
          dot.style.backgroundColor = state.palette.sectorColor(k);
        }
      }
    }

    function countVisibleItems() {
      const list = state.topology.itemNodes;
      if (state.activeFilter === 'all' || state.activeFilter === 'people') {
        return list.length;
      }
      let c = 0;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].sectorId === state.activeFilter) c += 1;
      }
      return c;
    }

    function isNodeFilterActive(node) {
      const f = state.activeFilter;
      if (f === 'all') return true;
      if (f === 'people') return node.kind === 'person';
      if (node.kind === 'item') return node.sectorId === f;
      // Person node stays highlighted if it bridges into the active sector
      return Boolean(node.sectorBreakdown && node.sectorBreakdown[f] > 0);
    }

    function worldToScreen(wx, wy) {
      return {
        x: state.width * 0.5 + state.cam.x + wx * state.cam.scale,
        y: state.height * 0.5 + state.cam.y + wy * state.cam.scale,
      };
    }

    function screenToWorld(sx, sy) {
      return {
        x: (sx - state.width * 0.5 - state.cam.x) / state.cam.scale,
        y: (sy - state.height * 0.5 - state.cam.y) / state.cam.scale,
      };
    }

    function getTargetNodesForFilter(filterId) {
      const f = filterId || state.activeFilter || 'all';
      const topo = state.topology;
      if (f === 'all') return topo.nodes;
      if (f === 'people') return topo.personNodes.length ? topo.personNodes : topo.nodes;
      const list = [];
      for (let i = 0; i < topo.itemNodes.length; i += 1) {
        if (topo.itemNodes[i].sectorId === f) list.push(topo.itemNodes[i]);
      }
      return list.length ? list : topo.nodes;
    }

    function computeFitTransform(filterOverride) {
      const f = filterOverride || state.activeFilter || 'all';
      const targetNodes = getTargetNodesForFilter(f);
      const isCompact = state.width < 520;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < targetNodes.length; i += 1) {
        const n = targetNodes[i];
        const padR = n.radius + 4;
        if (n.x - padR < minX) minX = n.x - padR;
        if (n.x + padR > maxX) maxX = n.x + padR;
        if (n.y - padR < minY) minY = n.y - padR;
        if (n.y + padR > maxY) maxY = n.y + padR;
      }

      if (!Number.isFinite(minX)) {
        const b = state.topology.bounds;
        minX = b.minX;
        maxX = b.maxX;
        minY = b.minY;
        maxY = b.maxY;
      }

      const spanX = Math.max(120, maxX - minX);
      const spanY = Math.max(120, maxY - minY);
      const sheetReserve = (state.selectedNodeId && state.width >= 760) ? (SHEET_WIDTH_DESKTOP + 12) : 0;
      const padX = isCompact ? 16 : 32;
      const padTop = isCompact ? 56 : 46;
      const padBottom = isCompact ? 40 : 38;
      const availW = Math.max(160, state.width - sheetReserve - padX * 2);
      const availH = Math.max(160, state.height - padTop - padBottom);
      const scale = clamp(Math.min(availW / spanX, availH / spanY), 0.35, 2.55);

      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const shiftX = -sheetReserve * 0.5;
      const shiftY = (padTop - padBottom) * 0.5;
      return {
        x: -cx * scale + shiftX,
        y: -cy * scale + shiftY,
        scale,
      };
    }

    function applyCanvasSize(shouldFit) {
      const rect = typeof rootEl.getBoundingClientRect === 'function' ? rootEl.getBoundingClientRect() : null;
      const rawW = (rect && rect.width) || rootEl.clientWidth || containerEl.clientWidth || 840;
      const rawH = (rect && rect.height) || rootEl.clientHeight || containerEl.clientHeight || 580;
      const w = Math.max(320, Math.round(rawW));
      const h = Math.max(280, Math.round(rawH));
      const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2);

      state.width = w;
      state.height = h;
      state.dpr = dpr;

      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (canvas.style) {
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }

      if (shouldFit) {
        const fit = computeFitTransform();
        state.cam.x = fit.x;
        state.cam.y = fit.y;
        state.cam.scale = fit.scale;
        state.targetCam.x = fit.x;
        state.targetCam.y = fit.y;
        state.targetCam.scale = fit.scale;
        updateZoomReadout();
      }
    }

    function hitTestScreen(sx, sy) {
      const pt = screenToWorld(sx, sy);
      const nodes = state.topology.nodes;
      let best = null;
      let bestScore = Infinity;

      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        const dx = pt.x - n.x;
        const dy = pt.y - n.y;
        const dist = Math.hypot(dx, dy);
        const hitR = Math.max(n.radius + 7, 13 / Math.max(state.cam.scale, 0.35));
        if (dist <= hitR) {
          // Slight priority for person nodes and active-filter nodes on close overlap
          const bias = (n.kind === 'person' ? -2.5 : 0) + (isNodeFilterActive(n) ? -1.5 : 4);
          const score = dist + bias;
          if (score < bestScore) {
            bestScore = score;
            best = n;
          }
        }
      }
      return best;
    }

    function updateHudForNode(node) {
      if (!node) {
        state.lastHudRect = null;
        hudEl.classList.remove('is-visible');
        return;
      }

      const pal = state.palette;
      while (hudMeta.firstChild) {
        hudMeta.removeChild(hudMeta.firstChild);
      }

      if (node.kind === 'person') {
        hudDot.className = 'kcm-diamond';
        hudDot.style.backgroundColor = 'transparent';
        hudDot.style.borderColor = pal.personRing;
        hudKindText.textContent = 'Core Person Hub';
        hudScore.textContent = node.linkedCount + (node.linkedCount === 1 ? ' LINK' : ' LINKS');
        hudTitle.textContent = node.name;

        for (let i = 0; i < SECTORS.length; i += 1) {
          const sec = SECTORS[i];
          const c = (node.sectorBreakdown && node.sectorBreakdown[sec.id]) || 0;
          if (c > 0) {
            const pill = document.createElement('span');
            pill.className = 'kcm-hud-pill';
            pill.textContent = c + ' ' + sec.shortLabel;
            hudMeta.appendChild(pill);
          }
        }

        hudExcerpt.textContent = node.topItems.length
          ? 'Connected to: ' + node.topItems.join(' | ')
          : 'Core bridge hub across Kizuki Mind Codex.';
        hudLinks.textContent = node.degree + ' constellation arcs';
        hudCta.textContent = 'Click for World-Model Profile';
      } else {
        const sec = SECTOR_BY_ID[node.sectorId] || SECTORS[0];
        hudDot.className = 'kcm-dot';
        hudDot.style.borderColor = 'transparent';
        hudDot.style.backgroundColor = pal.sectorColor(node.sectorId);
        hudKindText.textContent = sec.label;
        hudScore.textContent = 'LEV ' + Math.round(node.leverage);
        hudTitle.textContent = formatNodeDisplayTitle(node.title);

        const domPill = document.createElement('span');
        domPill.className = 'kcm-hud-pill';
        domPill.textContent = node.domain || 'General';
        hudMeta.appendChild(domPill);

        if (node.stage) {
          const stPill = document.createElement('span');
          stPill.className = 'kcm-hud-pill';
          stPill.textContent = node.stage.toUpperCase();
          hudMeta.appendChild(stPill);
        } else if (node.conviction) {
          const cvPill = document.createElement('span');
          cvPill.className = 'kcm-hud-pill';
          cvPill.textContent = node.conviction.toUpperCase();
          hudMeta.appendChild(cvPill);
        }

        if (node.pinned) {
          const pinPill = document.createElement('span');
          pinPill.className = 'kcm-hud-pill';
          pinPill.textContent = 'PINNED';
          hudMeta.appendChild(pinPill);
        }

        hudExcerpt.textContent = node.excerpt || 'Open this Codex entry to inspect thesis, evidence, and next move.';
        const pLen = node.linkedPeople.length;
        hudLinks.textContent = pLen > 0
          ? pLen + (pLen === 1 ? ' person' : ' people') + ' | ' + node.degree + ' links'
          : node.degree + (node.degree === 1 ? ' link' : ' links');
        hudCta.textContent = 'Click to inspect';
      }

      // Position floating HUD beside hovered node, clamped strictly inside container
      const pos = worldToScreen(node.x, node.y);
      const hudW = 276;
      const hudH = 166;
      const margin = 14;
      let left = pos.x + 18;
      let top = pos.y - 26;

      if (left + hudW + margin > state.width) {
        left = pos.x - hudW - 18;
      }
      if (left < margin) {
        left = margin;
      }
      if (top + hudH + margin > state.height) {
        top = state.height - hudH - margin;
      }
      if (top < 50) {
        top = 50;
      }

      state.lastHudRect = {
        x1: Math.round(left) - 6,
        y1: Math.round(top) - 6,
        x2: Math.round(left) + hudW + 6,
        y2: Math.round(top) + hudH + 6,
      };
      hudEl.style.transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
      hudEl.classList.add('is-visible');
    }

    // ======================================================================
    // CANVAS2D RENDERING ENGINE (HiDPI, zero ctx.filter, sleeps at rest)
    // ======================================================================

    function buildNeighborhoodSet(centerId) {
      const set = Object.create(null);
      if (!centerId) return set;
      set[centerId] = true;
      const adj = state.topology.adjacency[centerId] || [];
      for (let i = 0; i < adj.length; i += 1) {
        set[adj[i].neighborId] = true;
      }
      return set;
    }

    function computeQuadrantTitles(pal) {
      const isCompact = state.width < 520;
      const fontSize = 11;
      const fontStr = '600 ' + fontSize + 'px ' + pal.fontMono;
      const topLimit = isCompact ? 64 : 52;
      const bottomLimit = state.height - (isCompact ? 42 : 42);
      const edgePad = isCompact ? 10 : 16;
      const rightEdge = (state.selectedNodeId && state.width >= 760)
        ? (state.width - SHEET_WIDTH_DESKTOP - 24)
        : (state.width - edgePad);
      const items = [];

      ctx.save();
      ctx.font = fontStr;
      for (let i = 0; i < SECTORS.length; i += 1) {
        const sec = SECTORS[i];
        const isDimSector = state.activeFilter !== 'all' && state.activeFilter !== 'people' && state.activeFilter !== sec.id;
        // When semantically zoomed into a single quadrant, hide inactive quadrant corner labels
        if (isDimSector) continue;

        const a1 = sec.startAngle + SECTOR_GAP_RAD * 0.65;
        const a2 = sec.endAngle - SECTOR_GAP_RAD * 0.65;
        const midA = (a1 + a2) * 0.5;
        const count = state.topology.sectorCounts[sec.id] || 0;
        const baseLabel = isCompact ? sec.shortLabel : sec.label;
        const text = baseLabel.toUpperCase() + ' ' + count;
        const textW = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : text.length * 6.8;
        const textH = fontSize + 6;
        const isLeft = Math.cos(midA) < 0;
        const isTop = Math.sin(midA) < 0;
        // Keep right-side quadrant corner titles out of the way while the right side sheet is open
        if (!isLeft && state.selectedNodeId && state.width >= 760) continue;

        const align = isLeft ? 'left' : 'right';
        const sx = isLeft ? edgePad : Math.max(edgePad + textW, rightEdge);
        const sy = isTop ? (topLimit + textH * 0.5) : (bottomLimit - textH * 0.5);

        const x1 = align === 'right' ? (sx - textW) : sx;
        const x2 = align === 'right' ? sx : (sx + textW);
        const y1 = sy - textH * 0.5;
        const y2 = sy + textH * 0.5;

        const alpha = pal.isLight ? 0.96 : 0.94;

        items.push({
          sectorId: sec.id,
          rgb: pal.sectorRgb(sec.id),
          text,
          fontStr,
          align,
          sx,
          sy,
          alpha,
          box: {
            x1: x1 - 6,
            y1: y1 - 4,
            x2: x2 + 6,
            y2: y2 + 4,
          },
        });
      }
      ctx.restore();
      return items;
    }

    function getDotGridPattern(pal) {
      if (state.gridPattern && state.gridPatternLight === pal.isLight) {
        return state.gridPattern;
      }
      if (typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof ctx.createPattern !== 'function') {
        return null;
      }
      try {
        const tile = document.createElement('canvas');
        tile.width = 32;
        tile.height = 32;
        const tctx = tile.getContext('2d');
        if (!tctx) return null;
        tctx.fillStyle = pal.gridDot;
        tctx.fillRect(0, 0, 1, 1);
        state.gridPattern = ctx.createPattern(tile, 'repeat');
        state.gridPatternLight = pal.isLight;
        return state.gridPattern;
      } catch {
        return null;
      }
    }

    // Offscreen-cached 4-quadrant atmospheric wash (baked once per theme+filter so draw stays <16.7ms)
    let sectorWashCache = { key: '', canvas: null, size: 0 };

    function getSectorWashCanvas(pal, activeFilter) {
      if (typeof document === 'undefined') return null;
      const cacheKey = (pal.isLight ? 'L' : 'D') + '|' + String(activeFilter || 'all');
      if (sectorWashCache.canvas && sectorWashCache.key === cacheKey) {
        return sectorWashCache;
      }
      const radius = ARC_RAIL_R + 12;
      const dim = radius * 2;
      const off = document.createElement('canvas');
      off.width = dim;
      off.height = dim;
      const octx = off.getContext('2d');
      if (!octx) return null;

      octx.translate(radius, radius);
      for (let i = 0; i < SECTORS.length; i += 1) {
        const sec = SECTORS[i];
        const rgb = pal.sectorRgb(sec.id);
        const isDimSector = activeFilter !== 'all' && activeFilter !== 'people' && activeFilter !== sec.id;
        const peakAlpha = isDimSector ? 0.014 : (pal.isLight ? 0.048 : 0.058);
        const a1 = sec.startAngle + SECTOR_GAP_RAD * 0.45;
        const a2 = sec.endAngle - SECTOR_GAP_RAD * 0.45;
        const midA = (a1 + a2) * 0.5;
        const washCx = Math.cos(midA) * (ITEM_R_MIN + 78);
        const washCy = Math.sin(midA) * (ITEM_R_MIN + 78);
        const grad = octx.createRadialGradient(washCx, washCy, 14, washCx, washCy, 195);
        grad.addColorStop(0, rgba(rgb, peakAlpha));
        grad.addColorStop(0.55, rgba(rgb, peakAlpha * 0.52));
        grad.addColorStop(1, rgba(rgb, 0));

        octx.beginPath();
        octx.moveTo(0, 0);
        octx.arc(0, 0, ARC_RAIL_R + 10, a1, a2);
        octx.closePath();
        octx.fillStyle = grad;
        octx.fill();
      }
      sectorWashCache = { key: cacheKey, canvas: off, size: dim, radius };
      return sectorWashCache;
    }

    function drawBackgroundReticle(pal, quadrantTitles) {
      const w = state.width;
      const h = state.height;

      // Ground fill
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);

      // Cached 32x32 architectural dot matrix pattern (O(1) fillRect instead of 800+ calls/frame)
      const step = 32;
      const offX = ((state.cam.x % step) + step) % step;
      const offY = ((state.cam.y % step) + step) % step;
      const pat = getDotGridPattern(pal);
      if (pat) {
        ctx.save();
        ctx.translate(offX, offY);
        ctx.fillStyle = pat;
        ctx.fillRect(-step, -step, w + step * 2, h + step * 2);
        ctx.restore();
      } else {
        ctx.fillStyle = pal.gridDot;
        for (let gx = offX; gx < w; gx += step) {
          for (let gy = offY; gy < h; gy += step) {
            ctx.fillRect(gx - 0.5, gy - 0.5, 1, 1);
          }
        }
      }

      // World-space orbital rings and crosshair reticle
      ctx.save();
      ctx.translate(w * 0.5 + state.cam.x, h * 0.5 + state.cam.y);
      ctx.scale(state.cam.scale, state.cam.scale);

      const invScale = 1 / Math.max(state.cam.scale, 0.35);
      const isDetailOff = typeof document !== 'undefined' &&
        document.documentElement &&
        document.documentElement.getAttribute('data-detail') === 'off';

      // Subtle 4-quadrant radial atmospheric wash (offscreen-cached O(1) blit)
      if (!isDetailOff) {
        const wash = getSectorWashCanvas(pal, state.activeFilter);
        if (wash && wash.canvas) {
          ctx.drawImage(wash.canvas, -wash.radius, -wash.radius, wash.size, wash.size);
        }
      }

      // Concentric orbital rings
      const rings = [
        { r: CORE_RING_R, stroke: pal.ring, dash: null },
        { r: PEOPLE_RING_R, stroke: pal.ring, dash: [3, 5] },
        { r: 224, stroke: pal.ringFaint, dash: null },
        { r: 298, stroke: pal.ringFaint, dash: null },
      ];
      for (let i = 0; i < rings.length; i += 1) {
        const ring = rings[i];
        ctx.beginPath();
        ctx.arc(0, 0, ring.r, 0, TWO_PI);
        ctx.strokeStyle = ring.stroke;
        ctx.lineWidth = Math.max(0.75, 1 * invScale);
        if (typeof ctx.setLineDash === 'function') {
          ctx.setLineDash(ring.dash ? ring.dash.map((d) => d * invScale) : []);
        }
        ctx.stroke();
      }
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

      // Subtle concentric orbital tick ring around KIZUKI MIND core
      if (!isDetailOff) {
        const coreDialR = CORE_RING_R + 5.5;
        ctx.beginPath();
        ctx.arc(0, 0, CORE_RING_R - 4.5, 0, TWO_PI);
        ctx.strokeStyle = pal.ringFaint;
        ctx.lineWidth = Math.max(0.6, 0.75 * invScale);
        ctx.stroke();

        ctx.beginPath();
        for (let deg = 0; deg < 360; deg += 15) {
          const rad = (deg * Math.PI) / 180;
          const isCard = deg % 90 === 0;
          const tickIn = CORE_RING_R + 1.5;
          const tickOut = isCard ? (coreDialR + 2.5) : coreDialR;
          ctx.moveTo(Math.cos(rad) * tickIn, Math.sin(rad) * tickIn);
          ctx.lineTo(Math.cos(rad) * tickOut, Math.sin(rad) * tickOut);
        }
        ctx.strokeStyle = pal.crosshair;
        ctx.lineWidth = Math.max(0.6, 0.8 * invScale);
        ctx.stroke();
      }

      // Quadrant axis hairlines (0, 90, 180, 270 deg)
      ctx.strokeStyle = pal.ringFaint;
      ctx.lineWidth = Math.max(0.7, 0.9 * invScale);
      for (let q = 0; q < 4; q += 1) {
        const ang = q * Math.PI * 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * (CORE_RING_R + 8), Math.sin(ang) * (CORE_RING_R + 8));
        ctx.lineTo(Math.cos(ang) * (ARC_RAIL_R + 8), Math.sin(ang) * (ARC_RAIL_R + 8));
        ctx.stroke();
      }

      // Subtle degree graduation ticks on outer rail
      ctx.strokeStyle = pal.ring;
      ctx.lineWidth = Math.max(0.6, 0.8 * invScale);
      for (let deg = 0; deg < 360; deg += 15) {
        const rad = (deg * Math.PI) / 180;
        const inner = deg % 45 === 0 ? ARC_RAIL_R - 6 : ARC_RAIL_R - 3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(rad) * inner, Math.sin(rad) * inner);
        ctx.lineTo(Math.cos(rad) * ARC_RAIL_R, Math.sin(rad) * ARC_RAIL_R);
        ctx.stroke();
      }

      // 4 Colored Orbital Sector Arcs
      for (let i = 0; i < SECTORS.length; i += 1) {
        const sec = SECTORS[i];
        const rgb = pal.sectorRgb(sec.id);
        const isDimSector = state.activeFilter !== 'all' && state.activeFilter !== 'people' && state.activeFilter !== sec.id;
        const arcAlpha = isDimSector ? (pal.isLight ? 0.34 : 0.18) : 0.78;
        const a1 = sec.startAngle + SECTOR_GAP_RAD * 0.65;
        const a2 = sec.endAngle - SECTOR_GAP_RAD * 0.65;

        // Subtle tinted sector halo band
        ctx.beginPath();
        ctx.arc(0, 0, ARC_RAIL_R, a1, a2);
        ctx.strokeStyle = rgba(rgb, isDimSector ? (pal.isLight ? 0.08 : 0.04) : 0.14);
        ctx.lineWidth = 6 * invScale;
        ctx.stroke();

        // Crisp colored rail arc
        ctx.beginPath();
        ctx.arc(0, 0, ARC_RAIL_R, a1, a2);
        ctx.strokeStyle = rgba(rgb, arcAlpha);
        ctx.lineWidth = 1.6 * invScale;
        ctx.stroke();

        // End-cap ticks on sector arc
        const caps = [a1, a2];
        for (let c = 0; c < caps.length; c += 1) {
          ctx.beginPath();
          ctx.moveTo(Math.cos(caps[c]) * (ARC_RAIL_R - 5), Math.sin(caps[c]) * (ARC_RAIL_R - 5));
          ctx.lineTo(Math.cos(caps[c]) * (ARC_RAIL_R + 5), Math.sin(caps[c]) * (ARC_RAIL_R + 5));
          ctx.strokeStyle = rgba(rgb, arcAlpha);
          ctx.lineWidth = 1.2 * invScale;
          ctx.stroke();
        }
      }

      // Center Gravity Core: KIZUKI MIND subtle crosshair reticle
      const crossLen = 14;
      ctx.strokeStyle = pal.crosshair;
      ctx.lineWidth = 1 * invScale;
      ctx.beginPath();
      ctx.moveTo(-crossLen, 0);
      ctx.lineTo(-4, 0);
      ctx.moveTo(4, 0);
      ctx.lineTo(crossLen, 0);
      ctx.moveTo(0, -crossLen);
      ctx.lineTo(0, -4);
      ctx.moveTo(0, 4);
      ctx.lineTo(0, crossLen);
      ctx.stroke();

      // Core anchor point
      ctx.beginPath();
      ctx.arc(0, 0, 2.6, 0, TWO_PI);
      ctx.fillStyle = pal.inkPrimary;
      ctx.fill();

      ctx.restore();

      // Screen-space hub label (always crisp >= 11px, never shrinks below legibility floor)
      const hubScreen = worldToScreen(0, 0);
      if (
        hubScreen.x > -80 &&
        hubScreen.x < w + 80 &&
        hubScreen.y > -60 &&
        hubScreen.y < h + 60
      ) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '600 11.5px ' + pal.fontMono;
        ctx.fillStyle = pal.inkPrimary;
        ctx.fillText('KIZUKI MIND', hubScreen.x, hubScreen.y - Math.max(20, 24 * state.cam.scale));

        const coreSub = state.topology.itemNodes.length + ' NODES · ' + state.topology.personNodes.length + ' HUBS';
        ctx.font = '500 11px ' + pal.fontMono;
        ctx.fillStyle = pal.inkMuted;
        ctx.fillText(coreSub, hubScreen.x, hubScreen.y + Math.max(20, 25 * state.cam.scale));
        ctx.restore();
      }

      // Draw crisp screen-space quadrant titles outside the outer ring
      if (Array.isArray(quadrantTitles)) {
        ctx.save();
        for (let i = 0; i < quadrantTitles.length; i += 1) {
          const qt = quadrantTitles[i];
          ctx.font = qt.fontStr;
          ctx.textAlign = qt.align;
          ctx.textBaseline = 'middle';
          ctx.fillStyle = rgba(qt.rgb, qt.alpha);
          ctx.fillText(qt.text, qt.sx, qt.sy);
        }
        ctx.restore();
      }
    }

    function getNodeFilterEmphasis(node, now) {
      const target = isNodeFilterActive(node) ? 1 : 0;
      const sweep = state.filterSweep;
      if (!sweep || isMotionReduced()) return target;
      const prev = sweep.prevMap[node.id] != null ? sweep.prevMap[node.id] : target;
      const delay = sweep.delayMap[node.id] || 0;
      const elapsed = now - sweep.startTs - delay;
      if (elapsed <= 0) return prev;
      if (elapsed >= sweep.nodeDuration) return target;
      const e = easeOutCubic(elapsed / sweep.nodeDuration);
      return prev + (target - prev) * e;
    }

    function getNodeSweepSettle(node, now) {
      const sweep = state.filterSweep;
      if (!sweep || isMotionReduced()) return 1;
      const delay = sweep.delayMap[node.id] || 0;
      const elapsed = now - sweep.startTs - delay;
      if (elapsed <= 0) return 0;
      if (elapsed >= sweep.nodeDuration) return 1;
      return easeOutCubic(elapsed / sweep.nodeDuration);
    }

    function getFilterArcProgress(now) {
      const sweep = state.filterSweep;
      if (!sweep || isMotionReduced()) return 1;
      const elapsed = now - sweep.startTs;
      if (elapsed <= 0) return 0.01;
      if (elapsed >= sweep.arcDuration) return 1;
      return easeOutCubic(elapsed / sweep.arcDuration);
    }

    function drawEdges(pal, hoveredId, neighborSet, now) {
      const edges = state.topology.edges;
      if (!edges.length) return;
      const nodeById = state.topology.nodeById;
      const hasHover = Boolean(hoveredId);
      const hm = state.hoverMix;
      const arcProg = getFilterArcProgress(now);
      const animatingArcs = Boolean(state.filterSweep && !isMotionReduced() && arcProg < 0.998);

      ctx.save();
      ctx.translate(state.width * 0.5 + state.cam.x, state.height * 0.5 + state.cam.y);
      ctx.scale(state.cam.scale, state.cam.scale);
      const invScale = 1 / Math.max(state.cam.scale, 0.35);

      // Pass 0: Batch rest/dim edges by (strokeStyle, lineWidth) into <=8 stroke() calls when not animating arcs
      if (!animatingArcs) {
        if (typeof ctx.setLineDash === 'function') {
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        }
        const dimMul = hasHover ? (1 - 0.78 * hm) : 1;
        const buckets = Object.create(null);
        const bucketOrder = [];

        for (let i = 0; i < edges.length; i += 1) {
          const e = edges[i];
          const a = nodeById[e.sourceId];
          const b = nodeById[e.targetId];
          if (!a || !b) continue;
          if (hasHover && (e.sourceId === hoveredId || e.targetId === hoveredId)) continue;

          const filterOn = isNodeFilterActive(a) && isNodeFilterActive(b);
          const filterPartial = !filterOn && (isNodeFilterActive(a) || isNodeFilterActive(b));
          const filterMul = filterOn ? 1 : (filterPartial ? 0.24 : 0.08);

          let strokeStyle;
          let lineWidth;
          if (e.kind === 'person') {
            const rgb = SECTOR_BY_ID[e.sectorId] ? pal.sectorRgb(e.sectorId) : (pal.isLight ? [15, 23, 42] : [248, 250, 252]);
            strokeStyle = rgba(rgb, 0.17 * dimMul * filterMul);
            lineWidth = 0.9 * invScale;
          } else {
            const baseA = e.kind === 'domain' ? 0.11 : 0.085;
            const rgb = e.sectorId && SECTOR_BY_ID[e.sectorId]
              ? pal.sectorRgb(e.sectorId)
              : (pal.isLight ? [15, 23, 42] : [255, 255, 255]);
            strokeStyle = rgba(rgb, baseA * dimMul * filterMul);
            lineWidth = 0.8 * invScale;
          }

          const bKey = strokeStyle + '|' + (e.kind === 'person' ? 'p' : 'c');
          let bucket = buckets[bKey];
          if (!bucket) {
            bucket = { strokeStyle, lineWidth, segs: [] };
            buckets[bKey] = bucket;
            bucketOrder.push(bucket);
          }
          const cp = computeEdgeControlPoint(a, b, e.kind, state.topology.sectorHubs);
          bucket.segs.push(a.x, a.y, cp.cpx, cp.cpy, b.x, b.y);
        }

        for (let bIdx = 0; bIdx < bucketOrder.length; bIdx += 1) {
          const bucket = bucketOrder[bIdx];
          const segs = bucket.segs;
          ctx.beginPath();
          for (let s = 0; s < segs.length; s += 6) {
            ctx.moveTo(segs[s], segs[s + 1]);
            ctx.quadraticCurveTo(segs[s + 2], segs[s + 3], segs[s + 4], segs[s + 5]);
          }
          ctx.strokeStyle = bucket.strokeStyle;
          ctx.lineWidth = bucket.lineWidth;
          ctx.stroke();
        }
      }

      // Pass 1 (plus Pass 0 when animating lineDashOffset arcs): individual edge draw
      const startPass = animatingArcs ? 0 : 1;
      for (let pass = startPass; pass < 2; pass += 1) {
        if (pass === 1 && !hasHover) break;
        for (let i = 0; i < edges.length; i += 1) {
          const e = edges[i];
          const a = nodeById[e.sourceId];
          const b = nodeById[e.targetId];
          if (!a || !b) continue;

          const isIncident = hasHover && (e.sourceId === hoveredId || e.targetId === hoveredId);
          if (pass === 0 && isIncident) continue;
          if (pass === 1 && !isIncident) continue;

          const filterOn = isNodeFilterActive(a) && isNodeFilterActive(b);
          const filterPartial = !filterOn && (isNodeFilterActive(a) || isNodeFilterActive(b));
          const cp = computeEdgeControlPoint(a, b, e.kind, state.topology.sectorHubs);
          const cpx = cp.cpx;
          const cpy = cp.cpy;

          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);

          if (animatingArcs && filterOn && typeof ctx.setLineDash === 'function') {
            const arcLen = approxQuadLength(a.x, a.y, cpx, cpy, b.x, b.y);
            ctx.setLineDash([arcLen, arcLen]);
            ctx.lineDashOffset = arcLen * (1 - arcProg);
          } else if (typeof ctx.setLineDash === 'function') {
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
          }

          if (isIncident) {
            const accentSector = e.sectorId && SECTOR_BY_ID[e.sectorId] ? e.sectorId : (b.sectorId !== 'people' ? b.sectorId : a.sectorId);
            if (e.kind === 'person') {
              const rgb = SECTOR_BY_ID[accentSector] ? pal.sectorRgb(accentSector) : (pal.isLight ? [17, 24, 39] : [248, 250, 252]);
              ctx.strokeStyle = rgba(rgb, 0.28 + 0.52 * hm);
              ctx.lineWidth = (1.1 + 0.85 * hm) * invScale;
            } else {
              const rgb = SECTOR_BY_ID[accentSector] ? pal.sectorRgb(accentSector) : (pal.isLight ? [15, 23, 42] : [255, 255, 255]);
              ctx.strokeStyle = rgba(rgb, 0.22 + 0.48 * hm);
              ctx.lineWidth = (1.0 + 0.65 * hm) * invScale;
            }
            ctx.stroke();

            if (typeof ctx.setLineDash === 'function') {
              ctx.setLineDash([]);
              ctx.lineDashOffset = 0;
            }

            // Crisp directional chevron cue at t=0.58 from hovered node toward neighbor
            const fromNode = e.sourceId === hoveredId ? a : b;
            const toNode = e.sourceId === hoveredId ? b : a;
            const t = 0.58;
            const omt = 1 - t;
            const px = omt * omt * fromNode.x + 2 * omt * t * cpx + t * t * toNode.x;
            const py = omt * omt * fromNode.y + 2 * omt * t * cpy + t * t * toNode.y;
            const tx = 2 * omt * (cpx - fromNode.x) + 2 * t * (toNode.x - cpx);
            const ty = 2 * omt * (cpy - fromNode.y) + 2 * t * (toNode.y - cpy);
            const ang = Math.atan2(ty, tx);
            const sz = 4.2 * invScale;

            ctx.beginPath();
            ctx.moveTo(px + Math.cos(ang) * sz, py + Math.sin(ang) * sz);
            ctx.lineTo(px + Math.cos(ang + 2.45) * sz, py + Math.sin(ang + 2.45) * sz);
            ctx.lineTo(px + Math.cos(ang - 2.45) * sz, py + Math.sin(ang - 2.45) * sz);
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
          } else {
            const dimMul = hasHover ? (1 - 0.78 * hm) : 1;
            const filterMul = filterOn ? 1 : (filterPartial ? 0.24 : 0.08);
            if (e.kind === 'person') {
              const rgb = SECTOR_BY_ID[e.sectorId] ? pal.sectorRgb(e.sectorId) : (pal.isLight ? [15, 23, 42] : [248, 250, 252]);
              ctx.strokeStyle = rgba(rgb, 0.17 * dimMul * filterMul);
              ctx.lineWidth = 0.9 * invScale;
            } else {
              const baseA = e.kind === 'domain' ? 0.11 : 0.085;
              const rgb = e.sectorId && SECTOR_BY_ID[e.sectorId]
                ? pal.sectorRgb(e.sectorId)
                : (pal.isLight ? [15, 23, 42] : [255, 255, 255]);
              ctx.strokeStyle = rgba(rgb, baseA * dimMul * filterMul);
              ctx.lineWidth = 0.8 * invScale;
            }
            ctx.stroke();
          }
        }
      }

      if (typeof ctx.setLineDash === 'function') {
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      ctx.restore();
    }

    function drawPhotonAlongQuad(x0, y0, cpx, cpy, x1, y1, t, rgb, invScale, fade) {
      const clampedT = clamp(t, 0, 1);
      const tailSpan = 0.24;
      const tailStart = Math.max(0, clampedT - tailSpan);
      const steps = 10;

      ctx.lineCap = 'round';
      let prevPt = evalQuadBezier(x0, y0, cpx, cpy, x1, y1, tailStart);
      for (let s = 1; s <= steps; s += 1) {
        const u = s / steps;
        const st = tailStart + (clampedT - tailStart) * u;
        const pt = evalQuadBezier(x0, y0, cpx, cpy, x1, y1, st);
        ctx.beginPath();
        ctx.moveTo(prevPt.x, prevPt.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.strokeStyle = rgba(rgb, u * u * 0.85 * fade);
        ctx.lineWidth = (0.8 + u * 2.4) * invScale;
        ctx.stroke();
        prevPt = pt;
      }

      const head = evalQuadBezier(x0, y0, cpx, cpy, x1, y1, clampedT);
      // Outer crisp ring halo (pure alpha fill)
      ctx.beginPath();
      ctx.arc(head.x, head.y, 5.2 * invScale, 0, TWO_PI);
      ctx.fillStyle = rgba(rgb, 0.24 * fade);
      ctx.fill();

      // Core photon disc
      ctx.beginPath();
      ctx.arc(head.x, head.y, 2.8 * invScale, 0, TWO_PI);
      ctx.fillStyle = rgba(rgb, 0.96 * fade);
      ctx.fill();

      // Bright white center glint
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.3 * invScale, 0, TWO_PI);
      ctx.fillStyle = 'rgba(255,255,255,' + clamp(0.95 * fade, 0, 1).toFixed(3) + ')';
      ctx.fill();
    }

    function drawHoverSignalPackets(pal, hoveredId, now) {
      if (!hoveredId) return;
      const nodeById = state.topology.nodeById;
      const hNode = nodeById[hoveredId];
      if (!hNode) return;

      const hm = state.hoverMix;
      const hubCp = computeHubArcControlPoint(hNode);
      const hRgb = hNode.kind === 'person'
        ? (pal.isLight ? [17, 24, 39] : [248, 250, 252])
        : pal.sectorRgb(hNode.sectorId);

      ctx.save();
      ctx.translate(state.width * 0.5 + state.cam.x, state.height * 0.5 + state.cam.y);
      ctx.scale(state.cam.scale, state.cam.scale);
      const invScale = 1 / Math.max(state.cam.scale, 0.35);

      // Crisp curved carrier arc from KIZUKI MIND center hub -> hovered node
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(hubCp.cpx, hubCp.cpy, hNode.x, hNode.y);
      ctx.strokeStyle = rgba(hRgb, 0.34 * hm);
      ctx.lineWidth = 1.25 * invScale;
      ctx.stroke();

      // Live one-shot directional photon burst (skipped in reduced motion / detail=off)
      const burst = state.packetBurst;
      if (burst && burst.nodeId === hoveredId && !isMotionReduced()) {
        const elapsed = now - burst.startTs;

        // Stage 1: Photon packet from KIZUKI MIND hub -> hovered node
        if (elapsed >= 0 && elapsed <= PACKET_HUB_MS) {
          const t = easeOutCubic(elapsed / PACKET_HUB_MS);
          drawPhotonAlongQuad(0, 0, hubCp.cpx, hubCp.cpy, hNode.x, hNode.y, t, hRgb, invScale, 1);
        }

        // Arrival ring flash on hovered node
        if (elapsed >= PACKET_HUB_MS && elapsed <= PACKET_HUB_MS + PACKET_ARRIVE_FLASH_MS) {
          const u = easeOutCubic((elapsed - PACKET_HUB_MS) / PACKET_ARRIVE_FLASH_MS);
          ctx.beginPath();
          ctx.arc(hNode.x, hNode.y, hNode.radius + 3 + u * 11, 0, TWO_PI);
          ctx.strokeStyle = rgba(hRgb, 0.82 * (1 - u));
          ctx.lineWidth = (1.5 - u * 0.8) * invScale;
          ctx.stroke();
        }

        // Stage 2: Relayed directional photon packets from hovered node -> top connected neighbors
        for (let i = 0; i < burst.relays.length; i += 1) {
          const relay = burst.relays[i];
          const targetNode = nodeById[relay.targetId];
          if (!targetNode) continue;
          const rStart = PACKET_HUB_MS + i * PACKET_RELAY_STAGGER_MS;
          const rElapsed = elapsed - rStart;
          const rRgb = targetNode.kind === 'person'
            ? (pal.isLight ? [17, 24, 39] : [248, 250, 252])
            : pal.sectorRgb(targetNode.sectorId);

          if (rElapsed >= 0 && rElapsed <= PACKET_RELAY_MS) {
            const t = easeOutCubic(rElapsed / PACKET_RELAY_MS);
            const cp = computeEdgeControlPoint(hNode, targetNode, relay.kind, state.topology.sectorHubs);
            drawPhotonAlongQuad(hNode.x, hNode.y, cp.cpx, cp.cpy, targetNode.x, targetNode.y, t, rRgb, invScale, 0.92);
          } else if (rElapsed > PACKET_RELAY_MS && rElapsed <= PACKET_RELAY_MS + 160) {
            const u = easeOutCubic((rElapsed - PACKET_RELAY_MS) / 160);
            ctx.beginPath();
            ctx.arc(targetNode.x, targetNode.y, targetNode.radius + 2 + u * 8, 0, TWO_PI);
            ctx.strokeStyle = rgba(rRgb, 0.65 * (1 - u));
            ctx.lineWidth = (1.2 - u * 0.6) * invScale;
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    function drawNodes(pal, hoveredId, neighborSet, now) {
      const nodes = state.topology.nodes;
      const hasHover = Boolean(hoveredId);
      const hm = state.hoverMix;
      const hasSweep = Boolean(state.filterSweep && !isMotionReduced());

      ctx.save();
      ctx.translate(state.width * 0.5 + state.cam.x, state.height * 0.5 + state.cam.y);
      ctx.scale(state.cam.scale, state.cam.scale);
      const invScale = 1 / Math.max(state.cam.scale, 0.35);

      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        const isHovered = n.id === hoveredId;
        const isSelected = n.id === state.selectedNodeId;
        const isNeighbor = Boolean(neighborSet[n.id]);
        const emp = getNodeFilterEmphasis(n, now);

        const inactiveAlpha = state.activeFilter === 'all' ? 0.22 : 0.09;
        let alpha = inactiveAlpha + (0.96 - inactiveAlpha) * emp;
        if (hasHover) {
          if (isHovered || isSelected) alpha = 1;
          else if (isNeighbor) alpha = Math.max(alpha, 0.96);
          else alpha = alpha * (1 - hm) + 0.16 * hm;
        } else if (isSelected) {
          alpha = 1;
        }

        // Hover or selection lifts radius cleanly
        let r = n.radius + (isHovered ? 3 * hm : (isSelected ? 2.4 : 0));
        if (hasSweep && !isHovered) {
          const settle = getNodeSweepSettle(n, now);
          const seatScale = isNodeFilterActive(n) ? (0.86 + 0.14 * settle) : (1.0 - 0.08 * settle);
          r *= seatScale;
        }

        if (n.kind === 'person') {
          // Crisp diamond-ring anchor hub (zero per-node save/restore overhead)
          ctx.globalAlpha = clamp(alpha, 0.12, 1);

          // Outer subtle halo
          if (isHovered || isNeighbor) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 6.5, 0, TWO_PI);
            ctx.fillStyle = pal.personHalo;
            ctx.fill();
          }

          // Rotated outer diamond ring
          const dr = r + 2.8;
          ctx.beginPath();
          ctx.moveTo(n.x, n.y - dr);
          ctx.lineTo(n.x + dr, n.y);
          ctx.lineTo(n.x, n.y + dr);
          ctx.lineTo(n.x - dr, n.y);
          ctx.closePath();
          ctx.fillStyle = pal.nodeInnerCut;
          ctx.fill();
          ctx.strokeStyle = pal.personRing;
          ctx.lineWidth = (isHovered ? 1.8 : 1.25) * invScale;
          ctx.stroke();

          // Inner solid diamond core
          const ir = r * 0.52;
          ctx.beginPath();
          ctx.moveTo(n.x, n.y - ir);
          ctx.lineTo(n.x + ir, n.y);
          ctx.lineTo(n.x, n.y + ir);
          ctx.lineTo(n.x - ir, n.y);
          ctx.closePath();
          ctx.fillStyle = pal.personCore;
          ctx.fill();
        } else {
          // Codex Item node (colored orbital star/hub)
          const rgb = pal.sectorRgb(n.sectorId);
          const color = pal.sectorColor(n.sectorId);

          ctx.globalAlpha = clamp(alpha, 0.14, 1);

          // Soft concentric focus halo for pinned or hovered/neighbor nodes
          if (isHovered || (isNeighbor && hasHover) || n.pinned) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + (isHovered ? 7.5 : 4.2), 0, TWO_PI);
            ctx.fillStyle = rgba(rgb, isHovered ? 0.26 : (n.pinned ? 0.14 : 0.18));
            ctx.fill();
          }

          // Outer precision ring for pinned or hovered items
          if (n.pinned || isHovered) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 2.5, 0, TWO_PI);
            ctx.strokeStyle = rgba(rgb, isHovered ? 0.95 : 0.62);
            ctx.lineWidth = (isHovered ? 1.4 : 1.0) * invScale;
            ctx.stroke();
          }

          // Primary node disc
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, TWO_PI);
          ctx.fillStyle = color;
          ctx.fill();

          // Crisp center glint for high-leverage (>=85) items
          if (n.leverage >= 85 || isHovered) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, Math.max(1.6, r * 0.34), 0, TWO_PI);
            ctx.fillStyle = pal.nodeInnerCut;
            ctx.fill();
          }
        }
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function getRankedNeighbors(centerId, limit) {
      const adj = state.topology.adjacency[centerId] || [];
      const nodeById = state.topology.nodeById;
      const edges = state.topology.edges;
      const seen = Object.create(null);
      const list = [];

      for (let i = 0; i < adj.length; i += 1) {
        const nid = adj[i].neighborId;
        if (seen[nid] || nid === centerId) continue;
        const n = nodeById[nid];
        if (!n) continue;
        seen[nid] = true;
        const edge = edges[adj[i].edgeIdx];
        const priority =
          (n.kind === 'person' ? 5000 + n.degree * 10 : 3000 + n.leverage + (n.pinned ? 60 : 0) + n.degree * 8);
        list.push({ node: n, edge, priority });
      }

      list.sort((a, b) => (b.priority - a.priority) || a.node.id.localeCompare(b.node.id));
      return list.slice(0, limit || MAX_OUTER_CALLOUTS);
    }

    function drawOuterNeighborCallouts(pal, hoveredId, placedBoxes, topSafe, bottomSafe) {
      const placedIds = Object.create(null);
      if (!hoveredId) return placedIds;

      const topNeighbors = getRankedNeighbors(hoveredId, MAX_OUTER_CALLOUTS);
      if (!topNeighbors.length) return placedIds;

      const w = state.width;
      const hm = state.hoverMix;
      const centerS = worldToScreen(0, 0);
      const rimScreenR = ARC_RAIL_R * state.cam.scale;
      const elbowScreenR = rimScreenR + 12;
      const pillGapFromRim = 24;
      const padX = 7;
      const padY = 4;
      const fontSize = 11;
      const edgePad = 10;

      // Split into left & right hemispheres and sort strictly by angular Y order so leader rays never cross
      const leftSide = [];
      const rightSide = [];
      for (let i = 0; i < topNeighbors.length; i += 1) {
        const n = topNeighbors[i].node;
        const isLeft = Math.cos(n.angle) < 0;
        if (isLeft) leftSide.push(topNeighbors[i]);
        else rightSide.push(topNeighbors[i]);
      }

      const sortByScreenY = (a, b) => {
        const sa = worldToScreen(a.node.x, a.node.y);
        const sb = worldToScreen(b.node.x, b.node.y);
        return sa.y - sb.y;
      };
      leftSide.sort(sortByScreenY);
      rightSide.sort(sortByScreenY);

      const sides = [
        { list: rightSide, dir: 1 },
        { list: leftSide, dir: -1 },
      ];

      ctx.save();
      ctx.globalAlpha = clamp(0.25 + 0.75 * hm, 0, 1);

      for (let s = 0; s < sides.length; s += 1) {
        const group = sides[s].list;
        const dir = sides[s].dir;

        for (let i = 0; i < group.length; i += 1) {
          const n = group[i].node;
          const isPerson = n.kind === 'person';
          const displayTitle = isPerson ? n.title : formatNodeDisplayTitle(n.title);
          const labelText = truncateText(displayTitle, isPerson ? 18 : 20);
          const fontStr = '600 ' + fontSize + 'px ' + (isPerson ? pal.fontMono : pal.fontSans);
          ctx.font = fontStr;

          const measured = typeof ctx.measureText === 'function' ? ctx.measureText(labelText).width : labelText.length * 6;
          const dotReserve = 10;
          const boxW = Math.ceil(measured + padX * 2 + dotReserve);
          const boxH = Math.ceil(fontSize + padY * 2 + 2);

          const nodeS = worldToScreen(n.x, n.y);
          const elbowX = centerS.x + Math.cos(n.angle) * elbowScreenR;
          const elbowY = centerS.y + Math.sin(n.angle) * elbowScreenR;

          // Target X cleanly outside the outer compass rim
          let targetX;
          if (dir > 0) {
            const outsideRimX = Math.max(centerS.x + rimScreenR + 14, elbowX + pillGapFromRim);
            targetX = Math.min(w - edgePad - boxW, outsideRimX);
          } else {
            const outsideRimX = Math.min(centerS.x - rimScreenR - 14 - boxW, elbowX - pillGapFromRim - boxW);
            targetX = Math.max(edgePad, outsideRimX);
          }

          // Require callout pill to stay cleanly outside the compass rim on its side
          const pillEdgeNearRim = dir > 0 ? targetX : (targetX + boxW);
          const rimBoundary = centerS.x + dir * (rimScreenR * 0.72);
          if ((dir > 0 && pillEdgeNearRim < rimBoundary) || (dir < 0 && pillEdgeNearRim > rimBoundary)) {
            continue;
          }
          if (targetX < edgePad || targetX + boxW > w - edgePad) {
            continue;
          }

          const idealY = clamp(elbowY - boxH * 0.5, topSafe, bottomSafe - boxH);
          const stepY = boxH + 6;
          let chosenBox = null;

          // Collision-test ideal slot then step smoothly up/down so ZERO labels overlap
          const offsetsY = [0];
          for (let k = 1; k <= 8; k += 1) {
            offsetsY.push(k * stepY, -k * stepY);
          }

          for (let o = 0; o < offsetsY.length; o += 1) {
            const cy = idealY + offsetsY[o];
            if (cy < topSafe || cy + boxH > bottomSafe) continue;
            const candBox = { x1: targetX, y1: cy, x2: targetX + boxW, y2: cy + boxH };
            let collides = false;
            for (let b = 0; b < placedBoxes.length; b += 1) {
              if (boxesOverlap(candBox, placedBoxes[b], 5, 4)) {
                collides = true;
                break;
              }
            }
            if (!collides) {
              chosenBox = candBox;
              break;
            }
          }

          if (!chosenBox) continue;

          placedBoxes.push(chosenBox);
          placedIds[n.id] = true;

          const rgb = isPerson
            ? (pal.isLight ? [17, 24, 39] : [248, 250, 252])
            : pal.sectorRgb(n.sectorId);
          const anchorX = dir > 0 ? chosenBox.x1 : chosenBox.x2;
          const anchorY = (chosenBox.y1 + chosenBox.y2) * 0.5;
          const kneeX = dir > 0 ? Math.min(anchorX - 8, elbowX) : Math.max(anchorX + 8, elbowX);

          // Crisp hairline leader ray: node -> rim elbow -> pill edge
          ctx.beginPath();
          ctx.moveTo(nodeS.x, nodeS.y);
          ctx.lineTo(kneeX, elbowY);
          ctx.lineTo(anchorX, anchorY);
          ctx.strokeStyle = rgba(rgb, pal.isLight ? 0.48 : 0.56);
          ctx.lineWidth = 0.85;
          ctx.stroke();

          // Tiny precision terminal dot on pill rim anchor
          ctx.beginPath();
          ctx.arc(anchorX, anchorY, 1.8, 0, TWO_PI);
          ctx.fillStyle = rgba(rgb, 0.88);
          ctx.fill();

          // Outer callout pill + 1px top-edge specular highlight
          roundRectPath(ctx, chosenBox.x1, chosenBox.y1, boxW, boxH, 4);
          ctx.fillStyle = pal.labelHighlightBg;
          ctx.fill();
          ctx.strokeStyle = rgba(rgb, isPerson ? 0.36 : 0.52);
          ctx.lineWidth = 0.95;
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(chosenBox.x1 + 4.5, chosenBox.y1 + 0.75);
          ctx.lineTo(chosenBox.x2 - 4.5, chosenBox.y1 + 0.75);
          ctx.strokeStyle = pal.isLight ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.20)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Sector/person indicator dot inside pill
          const dotX = chosenBox.x1 + padX + 2.5;
          const dotY = chosenBox.y1 + boxH * 0.5;
          ctx.beginPath();
          ctx.arc(dotX, dotY, 2.4, 0, TWO_PI);
          ctx.fillStyle = isPerson ? pal.personCore : pal.sectorColor(n.sectorId);
          ctx.fill();

          ctx.font = fontStr;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = pal.inkPrimary;
          ctx.fillText(labelText, chosenBox.x1 + padX + dotReserve, dotY + 0.5);
        }
      }

      ctx.restore();
      return placedIds;
    }

    function drawCollisionAvoidedLabels(pal, hoveredId, neighborSet, quadrantTitles) {
      const nodes = state.topology.nodes;
      if (!nodes.length) return { labelCount: 0, overlapCount: 0, truncatedCount: 0 };
      const hasHover = Boolean(hoveredId);
      const w = state.width;
      const h = state.height;
      const isCompact = w < 520;
      const topSafe = isCompact ? 80 : 46;
      const bottomSafe = h - (isCompact ? 54 : 40);
      const rightSafe = (state.selectedNodeId && w >= 760) ? (w - SHEET_WIDTH_DESKTOP - 20) : (w - 10);

      const obstacleBoxes = [];
      const drawnLabelBoxes = [];

      // Register center KIZUKI MIND hub rect as a HARD OBSTACLE when visible
      const centerS = worldToScreen(0, 0);
      if (centerS.x > -80 && centerS.x < w + 80 && centerS.y > -60 && centerS.y < h + 60) {
        const hubHalfW = Math.max(CORE_RING_R * state.cam.scale + 8, 62);
        const hubHalfH = Math.max(CORE_RING_R * state.cam.scale + 6, 44);
        obstacleBoxes.push({
          x1: centerS.x - hubHalfW,
          y1: centerS.y - hubHalfH,
          x2: centerS.x + hubHalfW,
          y2: centerS.y + hubHalfH,
        });
      }

      // Register active quadrant title rects as HARD OBSTACLES
      if (Array.isArray(quadrantTitles)) {
        for (let q = 0; q < quadrantTitles.length; q += 1) {
          if (quadrantTitles[q] && quadrantTitles[q].box) {
            obstacleBoxes.push(quadrantTitles[q].box);
          }
        }
      }

      // Register floating HUD inspector card rect as HARD OBSTACLE when hovering
      if (hasHover && state.lastHudRect) {
        obstacleBoxes.push(state.lastHudRect);
      }

      // Render up to 6 angle-sorted outer compass-rim neighbor callout pills with leader rays
      const outerPlacedIds = hasHover
        ? drawOuterNeighborCallouts(pal, hoveredId, obstacleBoxes, topSafe, bottomSafe)
        : Object.create(null);

      // Build screen-space node list for circle collision avoidance
      const screenNodes = [];
      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        const s = worldToScreen(n.x, n.y);
        screenNodes.push({
          node: n,
          sx: s.x,
          sy: s.y,
          sr: n.radius * state.cam.scale + 2.5,
        });
      }

      // Rank candidates: selected/hovered first, then 1-hop neighbors, then highest-degree active nodes
      const candidates = [];
      for (let i = 0; i < screenNodes.length; i += 1) {
        const sn = screenNodes[i];
        const n = sn.node;
        if (outerPlacedIds[n.id]) continue;
        if (sn.sx < 14 || sn.sx > rightSafe - 4 || sn.sy < topSafe - 8 || sn.sy > bottomSafe + 8) continue;

        const isHovered = n.id === hoveredId;
        const isSelected = n.id === state.selectedNodeId;
        const isNeighbor = hasHover && Boolean(neighborSet[n.id]);

        if (hasHover) {
          if (!isHovered && !isSelected && !isNeighbor) continue;
        } else {
          if (!isNodeFilterActive(n) && !isSelected) continue;
        }

        let priority = 0;
        if (isHovered) priority = 12000;
        else if (isSelected) priority = 11000;
        else if (isNeighbor && n.kind === 'person') priority = 5500 + n.degree * 16;
        else if (isNeighbor) priority = 4500 + n.degree * 20 + n.leverage + (n.pinned ? 80 : 0);
        else if (n.kind === 'person') priority = 3400 + n.degree * 24;
        else priority = n.degree * 28 + (n.pinned ? 220 : 0) + n.leverage * 2;

        candidates.push({ sn, priority, isHovered, isSelected, isNeighbor });
      }

      candidates.sort((a, b) => (b.priority - a.priority) || a.sn.node.id.localeCompare(b.sn.node.id));

      const maxRestLabels = isCompact ? 16 : (state.cam.scale >= 1.45 ? 32 : 24);
      const maxLabels = hasHover ? 24 : maxRestLabels;

      let drawn = 0;
      let truncatedCount = 0;

      for (let i = 0; i < candidates.length && drawn < maxLabels; i += 1) {
        const entry = candidates[i];
        const n = entry.sn.node;
        const sx = entry.sn.sx;
        const sy = entry.sn.sy;
        const sr = entry.sn.sr;
        const isEmphasized = entry.isHovered || entry.isSelected || entry.isNeighbor;
        const isPerson = n.kind === 'person';

        const displayTitle = isPerson ? n.title : formatNodeDisplayTitle(n.title);
        const fontSize = (entry.isHovered || entry.isSelected) ? 11.5 : 11;
        const lineHeight = 13.5;
        const fontStr = (isEmphasized || isPerson ? '600 ' : '500 ') + fontSize + 'px ' + (isPerson ? pal.fontMono : pal.fontSans);
        ctx.font = fontStr;

        const maxLineW = isCompact ? 96 : (entry.isHovered ? 164 : (isPerson ? 124 : 138));
        const wrapped = wrapLabelTwoLines(ctx, displayTitle, maxLineW);
        const padX = isCompact ? 5 : 6;
        const padY = isCompact ? 3 : 4;
        const accentReserve = isPerson ? 0 : 4;
        const boxW = Math.ceil(wrapped.maxW + padX * 2 + accentReserve);
        const boxH = Math.ceil(wrapped.lines.length * lineHeight + padY * 2 - 1);

        // 12 clean candidate placement slots: outward radial, cardinal near, diagonal, and leader offsets
        const outRight = Math.cos(n.angle) >= 0;
        const outDown = Math.sin(n.angle) >= 0;
        const gap = sr + 5;
        const farGap = sr + 16;
        const diagGap = sr + 7;
        const offsets = [
          outRight
            ? { x: sx + gap, y: sy - boxH * 0.5, leader: false }
            : { x: sx - gap - boxW, y: sy - boxH * 0.5, leader: false },
          outDown
            ? { x: sx - boxW * 0.5, y: sy + gap, leader: false }
            : { x: sx - boxW * 0.5, y: sy - gap - boxH, leader: false },
          outRight
            ? { x: sx + farGap, y: sy - boxH * 0.5, leader: true }
            : { x: sx - farGap - boxW, y: sy - boxH * 0.5, leader: true },
          outDown
            ? { x: sx + diagGap, y: sy + diagGap, leader: true }
            : { x: sx + diagGap, y: sy - diagGap - boxH, leader: true },
          outDown
            ? { x: sx - diagGap - boxW, y: sy + diagGap, leader: true }
            : { x: sx - diagGap - boxW, y: sy - diagGap - boxH, leader: true },
          outRight
            ? { x: sx - gap - boxW, y: sy - boxH * 0.5, leader: false }
            : { x: sx + gap, y: sy - boxH * 0.5, leader: false },
          outDown
            ? { x: sx - boxW * 0.5, y: sy - gap - boxH, leader: false }
            : { x: sx - boxW * 0.5, y: sy + gap, leader: false },
          outDown
            ? { x: sx - boxW * 0.5, y: sy + farGap, leader: true }
            : { x: sx - boxW * 0.5, y: sy - farGap - boxH, leader: true },
          outRight
            ? { x: sx - farGap - boxW, y: sy - boxH * 0.5, leader: true }
            : { x: sx + farGap, y: sy - boxH * 0.5, leader: true },
          outDown
            ? { x: sx - boxW * 0.5, y: sy - farGap - boxH, leader: true }
            : { x: sx - boxW * 0.5, y: sy + farGap, leader: true },
          outRight
            ? { x: sx + farGap + 12, y: sy - boxH - 4, leader: true }
            : { x: sx - farGap - 12 - boxW, y: sy - boxH - 4, leader: true },
          outRight
            ? { x: sx + farGap + 12, y: sy + 4, leader: true }
            : { x: sx - farGap - 12 - boxW, y: sy + 4, leader: true },
        ];

        let chosen = null;
        let chosenLeader = false;
        for (let o = 0; o < offsets.length; o += 1) {
          const cand = offsets[o];
          const box = {
            x1: Math.round(cand.x),
            y1: Math.round(cand.y),
            x2: Math.round(cand.x + boxW),
            y2: Math.round(cand.y + boxH),
          };
          if (box.x1 < 8 || box.x2 > rightSafe || box.y1 < topSafe || box.y2 > bottomSafe) continue;

          let collides = false;
          const labelPadX = isCompact ? 2 : 3;
          const labelPadY = 2;
          for (let b = 0; b < drawnLabelBoxes.length; b += 1) {
            if (boxesOverlap(box, drawnLabelBoxes[b], labelPadX, labelPadY)) {
              collides = true;
              break;
            }
          }
          if (!collides) {
            for (let b = 0; b < obstacleBoxes.length; b += 1) {
              if (boxesOverlap(box, obstacleBoxes[b], 3, 2)) {
                collides = true;
                break;
              }
            }
          }
          if (!collides && !entry.isHovered && !entry.isSelected) {
            const nodeAvoidBias = isCompact ? -1.5 : 0.5;
            for (let k = 0; k < screenNodes.length; k += 1) {
              const other = screenNodes[k];
              if (other.node.id === n.id) continue;
              if (!isNodeFilterActive(other.node)) continue;
              const hitR = Math.max(2, other.sr + nodeAvoidBias);
              if (boxHitsCircle(box, other.sx, other.sy, hitR)) {
                collides = true;
                break;
              }
            }
          }
          if (!collides) {
            chosen = box;
            chosenLeader = Boolean(cand.leader);
            break;
          }
        }

        if (!chosen) continue;

        drawnLabelBoxes.push(chosen);
        drawn += 1;
        if (wrapped.truncated) truncatedCount += 1;

        // Crisp hairline leader line when offset from owner node
        if (chosenLeader) {
          const anchorX = clamp(sx, chosen.x1, chosen.x2);
          const anchorY = clamp(sy, chosen.y1, chosen.y2);
          const ldx = anchorX - sx;
          const ldy = anchorY - sy;
          const lDist = Math.hypot(ldx, ldy) || 1;
          if (lDist > sr + 2) {
            ctx.beginPath();
            ctx.moveTo(sx + (ldx / lDist) * (sr + 1.5), sy + (ldy / lDist) * (sr + 1.5));
            ctx.lineTo(anchorX, anchorY);
            ctx.strokeStyle = isPerson
              ? pal.labelBorder
              : rgba(pal.sectorRgb(n.sectorId), pal.isLight ? 0.42 : 0.48);
            ctx.lineWidth = 0.85;
            ctx.stroke();
          }
        }

        // Crisp pill backing + top-edge 1px machined specular highlight
        roundRectPath(ctx, chosen.x1, chosen.y1, boxW, boxH, 4.5);
        ctx.fillStyle = isEmphasized ? pal.labelHighlightBg : pal.labelBg;
        ctx.fill();

        if (isEmphasized || isPerson) {
          const borderCol = isPerson
            ? (pal.isLight ? 'rgba(17,24,39,0.28)' : 'rgba(255,255,255,0.28)')
            : rgba(pal.sectorRgb(n.sectorId), (entry.isHovered || entry.isSelected) ? 0.78 : 0.42);
          ctx.strokeStyle = borderCol;
          ctx.lineWidth = (entry.isHovered || entry.isSelected) ? 1.2 : 0.9;
          ctx.stroke();
        } else {
          ctx.strokeStyle = pal.labelBorder;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }

        // Top-edge 1px specular catchlight on callout pills
        ctx.beginPath();
        ctx.moveTo(chosen.x1 + 4.5, chosen.y1 + 0.75);
        ctx.lineTo(chosen.x2 - 4.5, chosen.y1 + 0.75);
        ctx.strokeStyle = pal.isLight
          ? 'rgba(255,255,255,0.86)'
          : (isEmphasized ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.14)');
        ctx.lineWidth = 1;
        ctx.stroke();

        // Subtle left sector accent stripe on item pills
        if (!isPerson) {
          ctx.fillStyle = pal.sectorColor(n.sectorId);
          ctx.fillRect(chosen.x1 + 2.5, chosen.y1 + 4, 2, boxH - 8);
        }

        ctx.font = fontStr;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isEmphasized || isPerson ? pal.inkPrimary : pal.inkSecondary;
        const textX = chosen.x1 + padX + accentReserve;
        for (let li = 0; li < wrapped.lines.length; li += 1) {
          const ly = chosen.y1 + padY + lineHeight * (li + 0.5) - 0.5;
          ctx.fillText(wrapped.lines[li], textX, ly);
        }
      }

      // Compute exact empirical overlap count across all placed label rectangles
      let overlapCount = 0;
      for (let i = 0; i < drawnLabelBoxes.length; i += 1) {
        for (let j = i + 1; j < drawnLabelBoxes.length; j += 1) {
          if (boxesOverlap(drawnLabelBoxes[i], drawnLabelBoxes[j], 0, 0)) {
            overlapCount += 1;
          }
        }
      }

      return {
        labelCount: drawn,
        overlapCount,
        truncatedCount,
      };
    }

    function publishCodexStats(labelStats, drawMs) {
      const targetNodes = getTargetNodesForFilter(state.activeFilter);
      let sMinX = Infinity;
      let sMaxX = -Infinity;
      let sMinY = Infinity;
      let sMaxY = -Infinity;
      for (let i = 0; i < targetNodes.length; i += 1) {
        const n = targetNodes[i];
        const sp = worldToScreen(n.x, n.y);
        const sr = n.radius * state.cam.scale;
        if (sp.x - sr < sMinX) sMinX = sp.x - sr;
        if (sp.x + sr > sMaxX) sMaxX = sp.x + sr;
        if (sp.y - sr < sMinY) sMinY = sp.y - sr;
        if (sp.y + sr > sMaxY) sMaxY = sp.y + sr;
      }
      const minDim = Math.max(1, Math.min(state.width, state.height));
      const boxW = Number.isFinite(sMinX) ? Math.max(0, sMaxX - sMinX) : 0;
      const boxH = Number.isFinite(sMinY) ? Math.max(0, sMaxY - sMinY) : 0;
      const fitRatio = Number((Math.max(boxW, boxH) / minDim).toFixed(3));

      state.lastStats = {
        fitRatio,
        labelCount: labelStats ? labelStats.labelCount : 0,
        overlapCount: labelStats ? labelStats.overlapCount : 0,
        truncatedCount: labelStats ? labelStats.truncatedCount : 0,
        nodeCount: state.topology.nodes.length,
        linkCount: state.topology.edges.length,
        zoom: Number(state.cam.scale.toFixed(3)),
        drawMs: Number.isFinite(drawMs) ? Number(drawMs.toFixed(2)) : 0,
        filter: state.activeFilter,
      };
      if (typeof window !== 'undefined') {
        window.__codexStats = Object.assign({}, state.lastStats);
      }
    }

    function draw() {
      if (state.destroyed || !ctx) return;

      const t0 = nowMs();
      const now = t0;
      ctx.save();
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

      const pal = state.palette;
      const hoveredId = state.hoveredNodeId;
      const neighborSet = buildNeighborhoodSet(hoveredId || state.selectedNodeId);
      const quadrantTitles = computeQuadrantTitles(pal);

      drawBackgroundReticle(pal, quadrantTitles);
      drawEdges(pal, hoveredId, neighborSet, now);
      drawHoverSignalPackets(pal, hoveredId, now);
      drawNodes(pal, hoveredId, neighborSet, now);
      const labelStats = drawCollisionAvoidedLabels(pal, hoveredId, neighborSet, quadrantTitles);

      // Empty state cue
      if (state.topology.itemNodes.length === 0) {
        ctx.font = '500 12px ' + pal.fontMono;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = pal.inkMuted;
        ctx.fillText('No Codex entries to map yet', state.width * 0.5, state.height * 0.5 + 68);
      }

      ctx.restore();
      publishCodexStats(labelStats, nowMs() - t0);
    }

    function pauseLoopIfHidden() {
      if (state.rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      state.panRafPending = false;
    }

    function isStageVisible() {
      if (state.destroyed || !state.isVisible) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;
      if (rootEl.isConnected === false) return false;
      if (typeof rootEl.closest === 'function' && rootEl.closest('[hidden]')) return false;
      return true;
    }

    function tickAnimation() {
      state.rafId = null;
      state.panRafPending = false;
      if (!isStageVisible()) return;

      const now = nowMs();
      const reduced = isMotionReduced();
      let needsMore = false;
      const lerpFactor = reduced ? 1 : 0.24;

      // 110ms deterministic hover depth transition
      if (state.hoverAnim) {
        if (reduced) {
          state.hoverMix = state.targetHoverMix;
          state.hoverAnim = null;
        } else {
          const t = clamp((now - state.hoverAnim.startTs) / state.hoverAnim.duration, 0, 1);
          state.hoverMix = state.hoverAnim.fromMix + (state.hoverAnim.toMix - state.hoverAnim.fromMix) * easeOutCubic(t);
          if (t >= 1) {
            state.hoverMix = state.hoverAnim.toMix;
            state.hoverAnim = null;
          } else {
            needsMore = true;
          }
        }
      } else {
        const dHover = state.targetHoverMix - state.hoverMix;
        if (Math.abs(dHover) > 0.004 && !reduced) {
          state.hoverMix += dHover * lerpFactor;
          needsMore = true;
        } else {
          state.hoverMix = state.targetHoverMix;
        }
      }

      // Angular re-seat filter sweep + lineDashOffset arc draw-in
      if (state.filterSweep) {
        if (reduced || now - state.filterSweep.startTs >= state.filterSweep.totalDuration) {
          state.filterSweep = null;
        } else {
          needsMore = true;
        }
      }

      // One-shot directional hover photon packet burst
      if (state.packetBurst) {
        if (
          reduced ||
          !state.hoveredNodeId ||
          state.packetBurst.nodeId !== state.hoveredNodeId ||
          now - state.packetBurst.startTs >= state.packetBurst.totalDuration
        ) {
          state.packetBurst = null;
        } else {
          needsMore = true;
        }
      }

      const dCamX = state.targetCam.x - state.cam.x;
      const dCamY = state.targetCam.y - state.cam.y;
      const dScale = state.targetCam.scale - state.cam.scale;
      if (!reduced && (Math.abs(dCamX) > 0.25 || Math.abs(dCamY) > 0.25 || Math.abs(dScale) > 0.002)) {
        state.cam.x += dCamX * lerpFactor;
        state.cam.y += dCamY * lerpFactor;
        state.cam.scale += dScale * lerpFactor;
        updateZoomReadout();
        needsMore = true;
      } else {
        state.cam.x = state.targetCam.x;
        state.cam.y = state.targetCam.y;
        state.cam.scale = state.targetCam.scale;
        updateZoomReadout();
      }

      if (state.hoveredNodeId) {
        const hNode = state.topology.nodeById[state.hoveredNodeId];
        if (hNode) updateHudForNode(hNode);
      }

      draw();

      if (needsMore && typeof requestAnimationFrame === 'function') {
        state.rafId = requestAnimationFrame(tickAnimation);
      }
    }

    function scheduleRender(animate) {
      if (state.destroyed) return;
      if (!isStageVisible()) {
        pauseLoopIfHidden();
        return;
      }
      if (!animate || isMotionReduced() || typeof requestAnimationFrame !== 'function') {
        state.hoverMix = state.targetHoverMix;
        state.hoverAnim = null;
        state.filterSweep = null;
        state.packetBurst = null;
        state.cam.x = state.targetCam.x;
        state.cam.y = state.targetCam.y;
        state.cam.scale = state.targetCam.scale;
        updateZoomReadout();
        draw();
        return;
      }
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(tickAnimation);
      }
    }

    function setHoveredNode(node) {
      const nextId = node ? node.id : null;
      if (nextId === state.hoveredNodeId) {
        if (node) updateHudForNode(node);
        return;
      }
      const now = nowMs();
      state.hoveredNodeId = nextId;
      state.targetHoverMix = nextId ? 1 : 0;

      if (isMotionReduced()) {
        state.hoverMix = state.targetHoverMix;
        state.hoverAnim = null;
        state.packetBurst = null;
      } else {
        state.hoverAnim = {
          startTs: now,
          fromMix: state.hoverMix,
          toMix: state.targetHoverMix,
          duration: HOVER_TRANSITION_MS,
        };
        if (nextId) {
          const topNeighbors = getRankedNeighbors(nextId, MAX_OUTER_CALLOUTS);
          const relays = topNeighbors.map((item) => ({
            targetId: item.node.id,
            kind: item.edge ? item.edge.kind : 'domain',
          }));
          const lastRelayEnd = relays.length > 0
            ? PACKET_HUB_MS + (relays.length - 1) * PACKET_RELAY_STAGGER_MS + PACKET_RELAY_MS + 160
            : PACKET_HUB_MS + PACKET_ARRIVE_FLASH_MS;
          state.packetBurst = {
            nodeId: nextId,
            startTs: now,
            relays,
            totalDuration: Math.max(PACKET_HUB_MS + PACKET_ARRIVE_FLASH_MS, lastRelayEnd),
          };
        } else {
          state.packetBurst = null;
        }
      }

      if (nextId) {
        canvas.classList.add('is-hovering');
        updateHudForNode(node);
      } else {
        canvas.classList.remove('is-hovering');
        updateHudForNode(null);
      }
      scheduleRender(true);
    }

    function zoomAt(factor, screenX, screenY, animate) {
      const prevScale = state.targetCam.scale;
      const nextScale = clamp(prevScale * factor, 0.28, 3.2);
      if (Math.abs(nextScale - prevScale) < 1e-4) return;

      const worldX = (screenX - state.width * 0.5 - state.targetCam.x) / prevScale;
      const worldY = (screenY - state.height * 0.5 - state.targetCam.y) / prevScale;

      state.targetCam.scale = nextScale;
      state.targetCam.x = screenX - state.width * 0.5 - worldX * nextScale;
      state.targetCam.y = screenY - state.height * 0.5 - worldY * nextScale;
      scheduleRender(animate !== false);
    }

    function fitView(animate) {
      const fit = computeFitTransform();
      state.targetCam.x = fit.x;
      state.targetCam.y = fit.y;
      state.targetCam.scale = fit.scale;
      scheduleRender(Boolean(animate));
    }

    function setFilter(filterId, filterOpts) {
      const valid = filterButtons[filterId] ? filterId : 'all';
      const prevFilter = state.activeFilter;
      const now = nowMs();
      const instant = Boolean(filterOpts && filterOpts.instant);

      // Snapshot current per-node emphasis BEFORE updating activeFilter
      const nodes = state.topology.nodes;
      const prevMap = Object.create(null);
      for (let i = 0; i < nodes.length; i += 1) {
        prevMap[nodes[i].id] = getNodeFilterEmphasis(nodes[i], now);
      }

      state.activeFilter = valid;
      syncFilterButtonDots();
      updateFooterTelemetry();

      // Semantic camera framing: zoom smoothly into that quadrant's bounding box
      const fit = computeFitTransform(valid);
      state.targetCam.x = fit.x;
      state.targetCam.y = fit.y;
      state.targetCam.scale = fit.scale;

      if (instant || valid === prevFilter || isMotionReduced() || typeof requestAnimationFrame !== 'function') {
        state.filterSweep = null;
        state.cam.x = fit.x;
        state.cam.y = fit.y;
        state.cam.scale = fit.scale;
        updateZoomReadout();
        draw();
        return;
      }

      // Compute angular sweep order (~5ms per node stagger, 240ms ease-out + 300ms arc draw-in)
      const activeSector = SECTOR_BY_ID[valid];
      const startAngle = activeSector ? activeSector.startAngle : Math.PI;
      const sorted = nodes.slice().sort((a, b) => {
        const da = normalizeAngle(a.angle - startAngle);
        const db = normalizeAngle(b.angle - startAngle);
        return da - db;
      });
      const delayMap = Object.create(null);
      const maxStaggerBudget = Math.min(sorted.length * FILTER_STAGGER_MS, 260);
      const perStep = sorted.length > 1 ? Math.min(FILTER_STAGGER_MS, maxStaggerBudget / (sorted.length - 1)) : 0;
      let maxDelay = 0;
      for (let i = 0; i < sorted.length; i += 1) {
        const delay = i * perStep;
        delayMap[sorted[i].id] = delay;
        if (delay > maxDelay) maxDelay = delay;
      }

      state.filterSweep = {
        startTs: now,
        nodeDuration: FILTER_NODE_MS,
        arcDuration: FILTER_ARC_MS,
        totalDuration: Math.max(maxDelay + FILTER_NODE_MS, FILTER_ARC_MS),
        prevMap,
        delayMap,
      };
      scheduleRender(true);
    }

    // ======================================================================
    // EVENT HANDLERS & OBSERVERS (all tracked for clean destroy())
    // ======================================================================

    const cleanups = [];
    function listen(target, type, handler, optsArg) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, optsArg);
      cleanups.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, handler, optsArg);
        }
      });
    }

    function getLocalPointer(ev) {
      const rect = typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0 };
      return {
        x: (ev.clientX || 0) - (rect.left || 0),
        y: (ev.clientY || 0) - (rect.top || 0),
      };
    }

    listen(canvas, 'pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const pt = getLocalPointer(ev);
      state.dragging = true;
      state.dragMoved = false;
      state.dragStartX = pt.x;
      state.dragStartY = pt.y;
      state.dragOriginCamX = state.cam.x;
      state.dragOriginCamY = state.cam.y;
      canvas.classList.add('is-dragging');
      if (typeof canvas.setPointerCapture === 'function' && ev.pointerId != null) {
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          // ignore synthetic pointer errors
        }
      }
    });

    listen(canvas, 'pointermove', (ev) => {
      const pt = getLocalPointer(ev);
      state.pointerX = pt.x;
      state.pointerY = pt.y;

      if (state.dragging) {
        const dx = pt.x - state.dragStartX;
        const dy = pt.y - state.dragStartY;
        if (Math.hypot(dx, dy) > 4) {
          state.dragMoved = true;
        }
        state.cam.x = state.dragOriginCamX + dx;
        state.cam.y = state.dragOriginCamY + dy;
        state.targetCam.x = state.cam.x;
        state.targetCam.y = state.cam.y;
        setHoveredNode(null);
        // Coalesce drag redraws to 1 per vsync so pan/zoom p99 stays well under 16.7ms
        if (!state.panRafPending && state.rafId === null && typeof requestAnimationFrame === 'function') {
          state.panRafPending = true;
          state.rafId = requestAnimationFrame(tickAnimation);
        } else if (typeof requestAnimationFrame !== 'function') {
          draw();
        }
        return;
      }

      const hit = hitTestScreen(pt.x, pt.y);
      setHoveredNode(hit);
    });

    function finishPointer(ev, isCancel) {
      if (!state.dragging) return;
      const wasDrag = state.dragMoved;
      state.dragging = false;
      state.dragMoved = false;
      canvas.classList.remove('is-dragging');

      if (!isCancel && !wasDrag) {
        const pt = getLocalPointer(ev);
        const hit = hitTestScreen(pt.x, pt.y);
        if (hit) {
          openSideSheet(hit);
        } else if (state.selectedNodeId) {
          closeSideSheet();
        }
      }
    }

    listen(sheetCloseBtn, 'click', () => closeSideSheet());
    if (typeof document !== 'undefined') {
      listen(document, 'keydown', (ev) => {
        if (ev && ev.key === 'Escape' && state.selectedNodeId) {
          closeSideSheet();
        }
      });
      listen(document, 'visibilitychange', () => {
        if (document.hidden) {
          pauseLoopIfHidden();
        } else if (isStageVisible()) {
          draw();
        }
      });
    }

    listen(canvas, 'pointerup', (ev) => finishPointer(ev, false));
    listen(canvas, 'pointercancel', (ev) => finishPointer(ev, true));
    listen(canvas, 'pointerleave', () => {
      if (!state.dragging) {
        setHoveredNode(null);
      }
    });

    listen(canvas, 'wheel', (ev) => {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const pt = getLocalPointer(ev);
      const delta = Number(ev.deltaY) || 0;
      const factor = delta < 0 ? 1.14 : (1 / 1.14);
      zoomAt(factor, pt.x, pt.y, true);
    }, { passive: false });

    listen(canvas, 'dblclick', () => {
      fitView(true);
    });

    // Toolbar actions
    listen(filterGroup, 'click', (ev) => {
      const btn = ev.target && typeof ev.target.closest === 'function'
        ? ev.target.closest('[data-kcm-filter]')
        : null;
      if (!btn) return;
      const f = btn.getAttribute('data-kcm-filter');
      if (f === state.activeFilter && f !== 'all') {
        setFilter('all');
      } else {
        setFilter(f);
      }
    });

    listen(zoomInBtn, 'click', () => zoomAt(1.25, state.width * 0.5, state.height * 0.5, true));
    listen(zoomOutBtn, 'click', () => zoomAt(1 / 1.25, state.width * 0.5, state.height * 0.5, true));
    listen(fitBtn, 'click', () => fitView(true));

    // ResizeObserver for responsive viewport tracking
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (state.destroyed) return;
        const prevW = state.width;
        const prevH = state.height;
        applyCanvasSize(false);
        if (Math.abs(state.width - prevW) > 12 || Math.abs(state.height - prevH) > 12) {
          fitView(false);
        } else if (isStageVisible()) {
          draw();
        }
      });
      resizeObserver.observe(rootEl);
    }

    // IntersectionObserver to pause rAF loops completely when hidden/offscreen (0% idle CPU)
    let intersectionObserver = null;
    if (typeof IntersectionObserver === 'function') {
      try {
        intersectionObserver = new IntersectionObserver((entries) => {
          if (state.destroyed) return;
          const entry = entries && entries[0];
          const vis = Boolean(entry && entry.isIntersecting);
          state.isVisible = vis;
          if (!vis) {
            pauseLoopIfHidden();
          } else {
            draw();
          }
        }, { threshold: 0.01 });
        intersectionObserver.observe(rootEl);
      } catch {
        intersectionObserver = null;
      }
    }

    // MutationObserver to auto-sync with document data-theme and data-detail changes
    let themeObserver = null;
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
      themeObserver = new MutationObserver(() => {
        if (state.destroyed) return;
        if (isMotionReduced()) {
          state.hoverAnim = null;
          state.filterSweep = null;
          state.packetBurst = null;
          state.hoverMix = state.targetHoverMix;
        }
        refreshTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-detail'],
      });
    }

    if (motionQuery) {
      const onMotionChange = (ev) => {
        state.reducedMotion = Boolean(ev && ev.matches);
        if (isMotionReduced()) {
          state.hoverAnim = null;
          state.filterSweep = null;
          state.packetBurst = null;
          state.hoverMix = state.targetHoverMix;
          draw();
        }
      };
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', onMotionChange);
        cleanups.push(() => motionQuery.removeEventListener('change', onMotionChange));
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(onMotionChange);
        cleanups.push(() => motionQuery.removeListener(onMotionChange));
      }
    }

    // Public controller methods
    function setItems(nextItems) {
      if (state.destroyed) return;
      state.hoveredNodeId = null;
      state.hoverMix = 0;
      state.targetHoverMix = 0;
      state.hoverAnim = null;
      state.filterSweep = null;
      state.packetBurst = null;
      state.lastHudRect = null;
      updateHudForNode(null);
      state.topology = buildTopology(nextItems || []);
      applyCanvasSize(true);
      updateFooterTelemetry();
      draw();
    }

    function resize() {
      if (state.destroyed) return;
      applyCanvasSize(false);
      draw();
    }

    function refreshTheme() {
      if (state.destroyed) return;
      state.palette = resolvePalette(containerEl);
      if (state.palette.isLight) {
        rootEl.classList.add('is-light');
      } else {
        rootEl.classList.remove('is-light');
      }
      syncFilterButtonDots();
      draw();
      if (state.hoveredNodeId) {
        const hNode = state.topology.nodeById[state.hoveredNodeId];
        if (hNode) updateHudForNode(hNode);
      }
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      pauseLoopIfHidden();
      if (resizeObserver && typeof resizeObserver.disconnect === 'function') {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (intersectionObserver && typeof intersectionObserver.disconnect === 'function') {
        intersectionObserver.disconnect();
        intersectionObserver = null;
      }
      if (themeObserver && typeof themeObserver.disconnect === 'function') {
        themeObserver.disconnect();
        themeObserver = null;
      }
      for (let i = 0; i < cleanups.length; i += 1) {
        try {
          cleanups[i]();
        } catch {
          // ignore cleanup errors
        }
      }
      cleanups.length = 0;
      if (rootEl.parentNode === containerEl) {
        containerEl.removeChild(rootEl);
      }
    }

    function setStats(nextStats) {
      if (state.destroyed) return;
      state.stats = nextStats && typeof nextStats === 'object' ? Object.assign({}, nextStats) : null;
      updateFooterTelemetry();
    }

    // Initial synchronous layout & paint (rafId remains null -> 0% CPU at rest)
    applyCanvasSize(true);
    syncFilterButtonDots();
    updateFooterTelemetry();
    draw();

    return {
      setItems,
      setStats,
      resize,
      refreshTheme,
      destroy,
      fitView,
      setFilter,
      openSideSheet(nodeId) {
        const node = state.topology.nodeById[nodeId];
        if (node) openSideSheet(node);
      },
      closeSheet: closeSideSheet,
      hitTest(sx, sy) {
        return hitTestScreen(sx, sy);
      },
      getStats() {
        return Object.assign({}, state.lastStats);
      },
      getDebugState() {
        return {
          rafId: state.rafId,
          isVisible: state.isVisible,
          width: state.width,
          height: state.height,
          isLight: state.palette.isLight,
          canvasBg: state.palette.bg,
          activeFilter: state.activeFilter,
          hoveredNodeId: state.hoveredNodeId,
          selectedNodeId: state.selectedNodeId,
          cam: { x: state.cam.x, y: state.cam.y, scale: state.cam.scale },
          stats: Object.assign({}, state.lastStats),
          nodeCount: state.topology.nodes.length,
          itemCount: state.topology.itemNodes.length,
          personCount: state.topology.personNodes.length,
          edgeCount: state.topology.edges.length,
          sectorCounts: Object.assign({}, state.topology.sectorCounts),
          bounds: Object.assign({}, state.topology.bounds),
          nodes: state.topology.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            sectorId: n.sectorId,
            title: n.title,
            x: n.x,
            y: n.y,
            radius: n.radius,
            degree: n.degree,
            screen: worldToScreen(n.x, n.y),
          })),
        };
      },
    };
  }

  return {
    mount,
    _buildTopology: buildTopology,
  };
});
