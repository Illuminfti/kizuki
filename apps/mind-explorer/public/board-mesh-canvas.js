/* ==========================================================================
   KIZUKI MIND EXPLORER - FLAGSHIP KINETIC SPATIAL MESH ENGINE (V2)
   Flow Deck (Default) | Stack (3-Deck Dimetric) | Score (Tape-First Timeline)
   Exports: window.KizukiBoardMesh = { mount(containerEl, opts) }
   Instance: { update, triggerPulse, setTheme, setDetail, setLayer,
               setViewMode, setExpanded, resize, destroy, getState,
               stampDecision, hydratePendingDecisions, setMobileLane }
   Zero external deps | Zero XSS | Zero canvas blur | Zero em-dashes
   ========================================================================== */
(function initKizukiBoardMesh(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiBoardMesh = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiBoardMesh = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function createBoardMeshFactory(root) {
    'use strict';

    const TWO_PI = Math.PI * 2;
    const STYLE_TAG_ID = 'kizuki-board-mesh-canvas-styles';
    const EM_DASH_RE = /\s*\u2014\s*/g;
    const EN_DASH_RE = /\s*\u2013\s*/g;
    const FONT_SANS = '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const HOLD_STAMP_MS = 350;
    const ROLLBACK_SHAKE_MS = 340;
    const IDLE_THROTTLE_MS = 3000;
    const IDLE_PAUSE_MS = 5000;
    const SPARKLINE_MAX = 60;

    const PALETTES = {
      dark: {
        dark: true,
        p0: '#0a0a0c',
        p1: '#0d0d10',
        p2: '#141418',
        p3: '#1b1b21',
        p4: '#24242d',
        tray: '#101014',
        hairline: 'rgba(255, 255, 255, 0.08)',
        hairlineStrong: 'rgba(255, 255, 255, 0.16)',
        bevelTop: 'rgba(255, 255, 255, 0.095)',
        dotGrid: 'rgba(255, 255, 255, 0.042)',
        ink1: '#eeeef2',
        ink2: '#a0a2ae',
        ink3: '#747786',
        ink4: '#4c4e5b',
        vermilion: '#ef4444',
        vermilionHi: '#f87171',
        vermilionSoft: 'rgba(239, 68, 68, 0.15)',
        vermilionEdge: 'rgba(239, 68, 68, 0.56)',
        emerald: '#22c55e',
        emeraldHi: '#4ade80',
        emeraldSoft: 'rgba(34, 197, 94, 0.15)',
        amber: '#f59e0b',
        amberHi: '#fbbf24',
        amberSoft: 'rgba(245, 158, 11, 0.15)',
        cyan: '#38bdf8',
        claude: '#e07d59',
        violet: '#a78bfa',
        teal: '#2dd4bf',
        indigo: '#818cf8',
        memBlue: '#60a5fa',
        offline: '#52525b',
        segOff: 'rgba(255, 255, 255, 0.075)',
        deckTop: '#141419',
        deckLeft: '#0f0f13',
        deckRight: '#0b0b0f',
        deckGrid: 'rgba(255, 255, 255, 0.045)',
        glassTop: 'rgba(42, 46, 58, 0.42)',
        glassLeft: 'rgba(30, 34, 46, 0.56)',
        glassRight: 'rgba(20, 23, 32, 0.62)',
        hwTop: '#1e1e26',
        hwLeft: '#15151b',
        hwRight: '#101015',
        footprint: 'rgba(0, 0, 0, 0.34)',
        brushFill: 'rgba(56, 189, 248, 0.14)',
        brushEdge: 'rgba(56, 189, 248, 0.72)',
        brands: {
          owner: '#eeeef2',
          claude: '#e07d59',
          codex: '#38bdf8',
          brain: '#34d399',
          designer: '#a78bfa',
          worker: '#818cf8',
          bot: '#a0a2ae',
        },
      },
      light: {
        dark: false,
        p0: '#ebedf2',
        p1: '#f5f6f8',
        p2: '#ffffff',
        p3: '#f0f1f4',
        p4: '#e2e5ec',
        tray: '#eef0f5',
        hairline: 'rgba(15, 18, 26, 0.11)',
        hairlineStrong: 'rgba(15, 18, 26, 0.22)',
        bevelTop: 'rgba(255, 255, 255, 0.92)',
        dotGrid: 'rgba(15, 18, 26, 0.058)',
        ink1: '#12141a',
        ink2: '#484d5b',
        ink3: '#616778',
        ink4: '#8890a2',
        vermilion: '#dc2626',
        vermilionHi: '#dc2626',
        vermilionSoft: 'rgba(220, 38, 38, 0.10)',
        vermilionEdge: 'rgba(220, 38, 38, 0.48)',
        emerald: '#15803d',
        emeraldHi: '#16a34a',
        emeraldSoft: 'rgba(22, 163, 74, 0.12)',
        amber: '#b45309',
        amberHi: '#c2690a',
        amberSoft: 'rgba(194, 105, 10, 0.12)',
        cyan: '#0284c7',
        claude: '#c2542d',
        violet: '#7c3aed',
        teal: '#0d9488',
        indigo: '#4f46e5',
        memBlue: '#2563eb',
        offline: '#9498a8',
        segOff: 'rgba(15, 18, 26, 0.085)',
        deckTop: '#f8f9fb',
        deckLeft: '#e4e7ee',
        deckRight: '#d6dbe4',
        deckGrid: 'rgba(15, 18, 26, 0.065)',
        glassTop: 'rgba(255, 255, 255, 0.72)',
        glassLeft: 'rgba(224, 232, 245, 0.68)',
        glassRight: 'rgba(205, 214, 230, 0.74)',
        hwTop: '#ffffff',
        hwLeft: '#e4e7ef',
        hwRight: '#d3d8e3',
        footprint: 'rgba(15, 18, 26, 0.10)',
        brushFill: 'rgba(2, 132, 199, 0.12)',
        brushEdge: 'rgba(2, 132, 199, 0.68)',
        brands: {
          owner: '#12141a',
          claude: '#c2542d',
          codex: '#0284c7',
          brain: '#15803d',
          designer: '#7c3aed',
          worker: '#4f46e5',
          bot: '#484d5b',
        },
      },
    };

    function getWin() {
      if (typeof window !== 'undefined' && window) return window;
      if (root && root.window) return root.window;
      return root || null;
    }

    function getDoc(containerEl) {
      if (containerEl && containerEl.ownerDocument) return containerEl.ownerDocument;
      if (typeof document !== 'undefined' && document) return document;
      const w = getWin();
      return w && w.document ? w.document : null;
    }

    function cleanText(val) {
      return String(val == null ? '' : val)
        .replace(EM_DASH_RE, ' - ')
        .replace(EN_DASH_RE, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function sanitizeNoDashSlash(str) {
      return String(str || '')
        .replace(/-+\//g, '/')
        .replace(/\/-+/g, '/')
        .replace(/-+\.\./g, '..');
    }

    function trimSegmentClean(seg, maxChars) {
      const s = cleanText(seg);
      if (s.length <= maxChars) return s;
      if (maxChars <= 2) return s.slice(0, Math.max(1, maxChars));
      const parts = s.split(/[-_]+/).filter(Boolean);
      if (parts.length > 1 && parts[0].length <= maxChars && parts[0].length >= 3) {
        let acc = parts[0];
        for (let i = 1; i < parts.length; i += 1) {
          if (acc.length + 1 + parts[i].length <= maxChars) {
            acc += '-' + parts[i];
          } else {
            break;
          }
        }
        return acc;
      }
      const cut = s.slice(0, maxChars).replace(/[-_.\s/]+$/, '');
      return cut || s.slice(0, maxChars);
    }

    function middleEllipsisSegment(text, maxLen) {
      const s = cleanText(text);
      if (s.length <= maxLen) return sanitizeNoDashSlash(s);
      if (maxLen <= 5) return sanitizeNoDashSlash(s.slice(0, Math.max(1, maxLen)));

      const hasHash = s.startsWith('#');
      const body = hasHash ? s.slice(1) : s;
      const prefix = hasHash ? '#' : '';
      const budget = maxLen - prefix.length;

      if (body.includes('/')) {
        const segs = body.split('/').filter(Boolean);
        if (segs.length >= 2) {
          const first = segs[0];
          const last = segs[segs.length - 1];
          const sep = segs.length > 2 ? '/..' + '/' : '/';
          if (first.length + sep.length + last.length <= budget) {
            return sanitizeNoDashSlash(prefix + first + sep + last);
          }
          const avail = Math.max(4, budget - 1);
          const firstCap = Math.max(3, Math.floor(avail * 0.44));
          const lastCap = Math.max(3, avail - firstCap);
          const fClean = trimSegmentClean(first, firstCap);
          const lClean = trimSegmentClean(last, lastCap);
          return sanitizeNoDashSlash(prefix + fClean + '/' + lClean);
        }
      }

      const headLen = Math.max(2, Math.ceil((budget - 2) * 0.56));
      const tailLen = Math.max(2, budget - 2 - headLen);
      const head = body.slice(0, headLen).replace(/[-_.\s/]+$/, '');
      const tail = body.slice(body.length - tailLen).replace(/^[-_.\s/]+/, '');
      return sanitizeNoDashSlash(prefix + (head || body.slice(0, headLen)) + '..' + (tail || body.slice(body.length - tailLen)));
    }

    function truncateText(val, maxLen) {
      const s = cleanText(val);
      if (s.length <= maxLen) return sanitizeNoDashSlash(s);
      if (s.includes('/')) return middleEllipsisSegment(s, maxLen);
      const cut = s.slice(0, Math.max(1, maxLen - 2)).replace(/[-_.\s/]+$/, '');
      return sanitizeNoDashSlash((cut || s.slice(0, Math.max(1, maxLen - 2))) + '..');
    }

    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }

    function toNum(val) {
      if (val === null || val === undefined || val === '') return null;
      const n = Number(val);
      return Number.isFinite(n) ? n : null;
    }

    function nowMs() {
      const w = getWin();
      if (w && w.performance && typeof w.performance.now === 'function') {
        return w.performance.now();
      }
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
      return Date.now();
    }

    function hexToRgba(hex, alpha) {
      const a = clamp(Number(alpha) || 0, 0, 1);
      const raw = String(hex || '').trim();
      if (raw.startsWith('rgba(') || raw.startsWith('rgb(')) return raw;
      const clean = raw.replace('#', '');
      if (clean.length === 3) {
        const r = parseInt(clean[0] + clean[0], 16);
        const g = parseInt(clean[1] + clean[1], 16);
        const b = parseInt(clean[2] + clean[2], 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
        }
      } else if (clean.length === 6) {
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
        }
      }
      return 'rgba(148,163,184,' + a.toFixed(3) + ')';
    }

    function roundRectPath(ctx, x, y, w, h, r) {
      const rr = Math.min(r, Math.max(0, w * 0.5), Math.max(0, h * 0.5));
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.arcTo(x + w, y, x + w, y + rr, rr);
      ctx.lineTo(x + w, y + h - rr);
      ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
      ctx.lineTo(x + rr, y + h);
      ctx.arcTo(x, y + h, x, y + h - rr, rr);
      ctx.lineTo(x, y + rr);
      ctx.arcTo(x, y, x + rr, y, rr);
      ctx.closePath();
    }

    function fitText(ctx, text, maxW) {
      const s = sanitizeNoDashSlash(cleanText(text));
      if (maxW <= 8 || !s) return '';
      if (!ctx || typeof ctx.measureText !== 'function') {
        return truncateText(s, Math.max(2, Math.floor(maxW / 6.5)));
      }
      if (ctx.measureText(s).width <= maxW) return s;

      if (s.includes('/')) {
        for (let len = s.length - 1; len >= 6; len -= 1) {
          const cand = middleEllipsisSegment(s, len);
          if (ctx.measureText(cand).width <= maxW) return cand;
        }
      }

      let lo = 1;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const head = s.slice(0, mid).replace(/[-_.\s/]+$/, '');
        if (ctx.measureText((head || s.slice(0, mid)) + '..').width <= maxW) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      const best = s.slice(0, Math.max(1, lo)).replace(/[-_.\s/]+$/, '');
      return sanitizeNoDashSlash((best || s.slice(0, Math.max(1, lo))) + '..');
    }

    function wrapTwoLines(ctx, text, maxW) {
      const s = sanitizeNoDashSlash(cleanText(text));
      if (!s || maxW <= 12) return [''];
      if (!ctx || typeof ctx.measureText !== 'function' || ctx.measureText(s).width <= maxW) {
        return [s];
      }
      const words = s.split(' ');
      let line1 = '';
      let idx = 0;
      for (; idx < words.length; idx += 1) {
        const next = line1 ? line1 + ' ' + words[idx] : words[idx];
        if (ctx.measureText(next).width <= maxW) {
          line1 = next;
        } else {
          break;
        }
      }
      if (!line1) {
        return [fitText(ctx, s, maxW)];
      }
      const rest = words.slice(idx).join(' ');
      if (!rest) return [line1];
      return [line1, fitText(ctx, rest, maxW)];
    }

    function normalizeBrand(rawBrand, rawHandle, rawActor, rawRole) {
      const b = String(rawBrand || '').toLowerCase().trim();
      const h = String(rawHandle || '').toLowerCase().trim();
      const a = String(rawActor || '').toLowerCase().trim();
      const r = String(rawRole || '').toLowerCase().trim();
      const combined = h + ' ' + a;

      if (b === 'owner' || r === 'owner' || h === 'ubuntu' || h === 'owner') {
        return { brand: 'owner', glyph: '●' };
      }
      if (b === 'claude' || r === 'claude' || combined.includes('claude')) {
        return { brand: 'claude', glyph: '*' };
      }
      if (b === 'codex' || r === 'codex' || combined.includes('codex') || combined.includes('scout-fleet')) {
        return { brand: 'codex', glyph: '</>' };
      }
      if (
        b === 'brain' ||
        r === 'daemon' ||
        combined.includes('board-keeper') ||
        combined.includes('orchestrator') ||
        combined.includes('dispatch') ||
        combined.includes('brain')
      ) {
        return { brand: 'brain', glyph: '>_' };
      }
      if (
        b === 'designer' ||
        r === 'designer' ||
        combined.includes('dreamer') ||
        combined.includes('designer') ||
        combined.includes('neon')
      ) {
        return { brand: 'designer', glyph: 'II' };
      }
      if (b === 'worker' || r === 'worker' || combined.includes('scribe')) {
        return { brand: 'worker', glyph: 'II' };
      }
      return { brand: 'bot', glyph: 'II' };
    }

    function compactAgentLabel(ag, brand) {
      const disp = cleanText(ag.displayName || ag.handle || ag.actor || 'Agent');
      const handle = cleanText(ag.handle || '').toLowerCase();
      if (brand === 'owner' || handle === 'ubuntu' || handle === 'owner') {
        return 'Owner';
      }
      if (handle.includes('board-keeper')) return 'Keeper';
      if (handle.includes('dreamer')) return 'Dreamer';
      if (handle.includes('orchestrator')) return 'Orchestrator';
      if (handle.includes('dispatch')) return 'Dispatch';
      if (handle.startsWith('w-codex-')) return 'Codex ' + handle.replace('w-codex-', '');
      if (handle.startsWith('claude-')) return 'Claude ' + handle.slice(7, 11);
      if (disp.length <= 18) return sanitizeNoDashSlash(disp);
      return truncateText(disp, 18);
    }

    function compactRoomLabel(channel, maxLen) {
      const limit = maxLen || 20;
      const c = cleanText(channel).replace(/^#+/, '');
      if (!c) return '#board';
      return middleEllipsisSegment('#' + c, limit);
    }

    function dockedAgentLabel(node) {
      const handle = cleanText(node && (node.handle || node.actor || node.label || '')).toLowerCase();
      const label = cleanText(node && (node.shortLabel || node.label || 'Agent'));
      if (!node) return 'Agent';
      if (node.brand === 'owner' || handle === 'ubuntu' || handle === 'owner') {
        return 'Owner';
      }
      if (handle.includes('board-keeper') || handle.includes('keeper')) return 'Keeper';
      if (handle.includes('scribe')) return 'Scribe';
      if (handle.includes('dreamer')) return 'Dreamer';
      if (handle.includes('orchestrator')) return 'Orchestrator';
      if (handle.includes('dispatch')) return 'Dispatch';
      if (handle.includes('claude') || node.brand === 'claude') return 'Claude';
      if (handle.includes('codex') || handle.includes('scout-fleet') || node.brand === 'codex') return 'Codex';
      if (handle.includes('neon')) return 'Neon';
      const firstWord = label.split(/[\s/_-]+/).filter(Boolean)[0] || label;
      return sanitizeNoDashSlash(firstWord.slice(0, 10));
    }

    function dockedRoomLabel(channel) {
      const raw = cleanText(channel || '').replace(/^#+/, '').toLowerCase();
      if (!raw) return '#board';
      const firstSeg = raw.split('/')[0] || raw;
      if (firstSeg === 'agent-board' || firstSeg.startsWith('agent-')) return '#agent';
      if (firstSeg.startsWith('kizuki')) return '#kizuki';
      if (firstSeg.startsWith('design')) return '#design';
      if (firstSeg.startsWith('workspace')) return '#workspace';
      if (firstSeg.startsWith('final')) return '#final';
      const token = firstSeg.split(/[-_]+/).filter(Boolean)[0] || firstSeg;
      return sanitizeNoDashSlash('#' + token.slice(0, 9));
    }

    function dockedNodeLabel(node) {
      if (!node) return '';
      if (node.kind === 'OWNER') return 'Owner';
      if (node.kind === 'TRIGGER') return 'Dispatch';
      if (node.kind === 'AGENT') return dockedAgentLabel(node);
      if (node.kind === 'ROOM') return dockedRoomLabel(node.channel || node.label);
      if (node.kind === 'STORE') {
        if (node.storeKey === 'taste') return 'Taste';
        if (node.storeKey === 'vault') return 'Vault';
        if (node.storeKey === 'codex') return 'Codex';
        if (node.storeKey === 'memt') return 'MemT';
        if (node.storeKey === 'brain') return 'Brain';
      }
      return sanitizeNoDashSlash(node.shortLabel || node.label || '');
    }

    function formatAgeMs(ms) {
      const sec = Math.max(1, Math.floor(ms / 1000));
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm';
      const hr = Math.floor(min / 60);
      if (hr < 48) return hr + 'h';
      const d = Math.floor(hr / 24);
      const remH = hr % 24;
      return remH > 0 ? d + 'd ' + remH + 'h' : d + 'd';
    }

    function computeAgeProgress(ms) {
      const hours = Math.max(0.1, ms / 3600000);
      return clamp(18 + (Math.log2(1 + hours) / Math.log2(1 + 120)) * 80, 14, 98);
    }

    function parseTimestampMs(raw) {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw < 1e12 ? raw * 1000 : raw;
      }
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    }

    function formatClock(totalSec) {
      const norm = ((Math.floor(totalSec) % 86400) + 86400) % 86400;
      const hh = String(Math.floor(norm / 3600)).padStart(2, '0');
      const mm = String(Math.floor((norm % 3600) / 60)).padStart(2, '0');
      const ss = String(norm % 60).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    }

    function detectInitialTheme(doc, opts) {
      if (opts && (opts.theme === 'light' || opts.theme === 'dark')) return opts.theme;
      if (doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function') {
        const attr = doc.documentElement.getAttribute('data-theme');
        if (attr === 'light' || attr === 'dark') return attr;
      }
      return 'dark';
    }

    function detectInitialDetail(doc, opts) {
      if (opts && (opts.detail === 'on' || opts.detail === 'off')) return opts.detail;
      const w = getWin();
      if (w && w.location && typeof w.location.search === 'string') {
        try {
          const sp = new URLSearchParams(w.location.search);
          const qd = sp.get('detail');
          if (qd === 'off' || qd === 'on') return qd;
        } catch {
          // ignore
        }
      }
      if (doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function') {
        const attr = doc.documentElement.getAttribute('data-detail');
        if (attr === 'off' || attr === 'on') return attr;
      }
      return 'on';
    }

    function detectReducedMotion() {
      const w = getWin();
      if (!w || typeof w.matchMedia !== 'function') return false;
      try {
        return Boolean(w.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function ensureStyles(doc) {
      if (!doc || !doc.head) return;
      if (typeof doc.getElementById === 'function' && doc.getElementById(STYLE_TAG_ID)) return;
      const style = doc.createElement('style');
      style.id = STYLE_TAG_ID;
      style.textContent = [
        '.kbm-root{position:relative;width:100%;height:100%;min-height:320px;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;border:1px solid rgba(255,255,255,0.09);background:#0d0d10;color:#eeeef2;font-family:' + FONT_SANS + ';user-select:none;-webkit-user-select:none;box-sizing:border-box;}',
        '.kbm-root.is-light{background:#f5f6f8;color:#12141a;border-color:rgba(15,18,26,0.12);}',
        '.kbm-header{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:5px 10px;background:#141418;border-bottom:1px solid rgba(255,255,255,0.08);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06);z-index:3;min-width:0;}',
        '.kbm-root.is-light .kbm-header{background:#ffffff;border-bottom-color:rgba(15,18,26,0.10);box-shadow:inset 0 1px 0 rgba(255,255,255,0.95);}',
        '.kbm-header-left{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;overflow:hidden;}',
        '.kbm-svc-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:4px;background:#1b1b21;border:1px solid rgba(255,255,255,0.11);font-family:' + FONT_MONO + ';font-size:var(--t-xs,11px);font-weight:600;letter-spacing:0.03em;color:#eeeef2;white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums;}',
        '.kbm-root.is-light .kbm-svc-pill{background:#f0f1f4;border-color:rgba(15,18,26,0.13);color:#12141a;}',
        '.kbm-svc-dot{width:6px;height:6px;border-radius:999px;background:#22c55e;flex-shrink:0;}',
        '.kbm-svc-dot.is-warn{background:#f59e0b;}',
        '.kbm-svc-dot.is-down{background:#ef4444;}',
        '.kbm-narrator{font-family:' + FONT_MONO + ';font-size:var(--t-xs,11px);font-weight:500;color:#b2b4c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-variant-numeric:tabular-nums;}',
        '.kbm-root.is-light .kbm-narrator{color:#484d5b;}',
        '.kbm-controls{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;}',
        '.kbm-seg{display:inline-flex;align-items:center;gap:1px;padding:2px;border-radius:5px;background:#0a0a0c;border:1px solid rgba(255,255,255,0.09);}',
        '.kbm-root.is-light .kbm-seg{background:#e7e9ef;border-color:rgba(15,18,26,0.11);}',
        '.kbm-btn{appearance:none;border:1px solid transparent;background:transparent;color:#8c8f9e;font-family:' + FONT_MONO + ';font-size:var(--t-xs,11px);font-weight:500;line-height:1;height:20px;padding:0 7px;border-radius:3px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;transition:background-color 110ms ease,color 110ms ease,border-color 110ms ease;white-space:nowrap;}',
        '.kbm-btn:hover{color:#eeeef2;background:rgba(255,255,255,0.06);}',
        '.kbm-btn.is-active{background:#1b1b21;border-color:rgba(255,255,255,0.16);color:#ffffff;font-weight:600;}',
        '.kbm-root.is-light .kbm-btn{color:#555b6b;}',
        '.kbm-root.is-light .kbm-btn:hover{color:#12141a;background:rgba(15,18,26,0.05);}',
        '.kbm-root.is-light .kbm-btn.is-active{background:#ffffff;border-color:rgba(15,18,26,0.18);color:#12141a;}',
        '.kbm-expand-btn{height:24px;padding:0 8px;border-radius:5px;background:#1b1b21;border:1px solid rgba(255,255,255,0.11);color:#d8dae2;}',
        '.kbm-root.is-light .kbm-expand-btn{background:#f0f1f4;border-color:rgba(15,18,26,0.14);color:#222632;}',
        '.kbm-mobile-lanes{display:none;flex:0 0 auto;align-items:center;justify-content:space-between;gap:4px;padding:4px 8px;background:#101014;border-bottom:1px solid rgba(255,255,255,0.08);overflow:hidden;}',
        '.kbm-root.is-light .kbm-mobile-lanes{background:#eef0f5;border-bottom-color:rgba(15,18,26,0.10);}',
        '.kbm-mobile-lanes.is-shown{display:flex;}',
        '.kbm-lane-pill{appearance:none;border:1px solid rgba(255,255,255,0.10);background:transparent;color:#8c8f9e;font-family:' + FONT_MONO + ';font-size:10px;font-weight:500;height:20px;padding:0 6px;border-radius:4px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;flex:1 1 0;justify-content:center;min-width:0;}',
        '.kbm-lane-pill.is-active{background:#1b1b21;border-color:rgba(255,255,255,0.22);color:#ffffff;font-weight:600;}',
        '.kbm-root.is-light .kbm-lane-pill{border-color:rgba(15,18,26,0.12);color:#555b6b;}',
        '.kbm-root.is-light .kbm-lane-pill.is-active{background:#ffffff;border-color:rgba(15,18,26,0.24);color:#12141a;}',
        '.kbm-lane-dot{width:5px;height:5px;border-radius:999px;background:currentColor;opacity:0.45;flex-shrink:0;}',
        '.kbm-lane-pill.is-active .kbm-lane-dot{opacity:1;background:#38bdf8;}',
        '.kbm-stage-wrap{position:relative;flex:1 1 auto;min-height:0;width:100%;overflow:hidden;background:#0d0d10;touch-action:pan-y;}',
        '.kbm-root.is-light .kbm-stage-wrap{background:#f5f6f8;}',
        '.kbm-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:default;outline:none;}',
        '.kbm-canvas:focus-visible{box-shadow:inset 0 0 0 2px rgba(56,189,248,0.65);}',
        '.kbm-canvas.is-pointer{cursor:pointer;}',
        '.kbm-readout{flex:0 0 auto;height:26px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;background:#141418;border-top:1px solid rgba(255,255,255,0.08);font-family:' + FONT_MONO + ';font-size:var(--t-xs,11px);color:#8e91a0;white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums;}',
        '.kbm-root.is-light .kbm-readout{background:#ffffff;border-top-color:rgba(15,18,26,0.10);color:#555b6b;}',
        '.kbm-readout-main{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;}',
        '.kbm-readout-dot{width:6px;height:6px;border-radius:2px;flex-shrink:0;background:#38bdf8;}',
        '.kbm-readout-title{color:#eeeef2;font-weight:600;flex-shrink:0;}',
        '.kbm-root.is-light .kbm-readout-title{color:#12141a;}',
        '.kbm-readout-detail{color:#9a9dab;overflow:hidden;text-overflow:ellipsis;}',
        '.kbm-root.is-light .kbm-readout-detail{color:#484d5b;}',
        '.kbm-readout-right{color:#747786;flex-shrink:0;}',
        '.kbm-root.is-compact .kbm-header{min-height:32px;padding:4px 7px;gap:5px;}',
        '.kbm-root.is-compact .kbm-svc-pill{height:20px;padding:0 5px;font-size:10px;}',
        '.kbm-root.is-compact .kbm-narrator{font-size:10px;}',
        '.kbm-root.is-compact .kbm-btn{font-size:10px;padding:0 5px;height:19px;}',
        '.kbm-root.is-compact .kbm-expand-btn{height:22px;padding:0 6px;}',
        '.kbm-root.is-compact .kbm-readout{height:23px;padding:0 7px;font-size:10px;}',
        '@media (max-width:480px){.kbm-narrator{display:none;}.kbm-readout-right{display:none;}}',
        '@media (prefers-reduced-motion:reduce){.kbm-btn,.kbm-lane-pill{transition:none;}}',
      ].join('\n');
      doc.head.appendChild(style);
    }

    function evalCubic(p0, p1, p2, p3, t) {
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      return {
        x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
        y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
      };
    }

    function evalCubicTangent(p0, p1, p2, p3, t) {
      const mt = 1 - t;
      return {
        dx: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
        dy: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
      };
    }

    function sampleArcLengthPoint(geom, distPx) {
      const lut = geom.lut;
      if (!lut || lut.length === 0) return { x: geom.p0.x, y: geom.p0.y, angle: 0 };
      if (distPx <= 0) return lut[0];
      if (distPx >= geom.length) return lut[lut.length - 1];
      let lo = 0;
      let hi = lut.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (lut[mid].d < distPx) lo = mid;
        else hi = mid;
      }
      const a = lut[lo];
      const b = lut[hi];
      const span = Math.max(0.0001, b.d - a.d);
      const f = (distPx - a.d) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }

    function pointInPoly(px, py, poly) {
      if (!poly || poly.length < 3) return false;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect =
          yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-6) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function sampleDogleg(a, b, midY, u) {
      const seg1 = Math.abs(midY - a.y);
      const seg2 = Math.abs(b.x - a.x);
      const seg3 = Math.abs(b.y - midY);
      const total = seg1 + seg2 + seg3 || 1;
      const dist = clamp(u, 0, 1) * total;
      if (dist <= seg1) {
        const f = seg1 ? dist / seg1 : 0;
        return { x: a.x, y: a.y + (midY - a.y) * f };
      }
      if (dist <= seg1 + seg2) {
        const f = seg2 ? (dist - seg1) / seg2 : 0;
        return { x: a.x + (b.x - a.x) * f, y: midY };
      }
      const f = seg3 ? (dist - seg1 - seg2) / seg3 : 0;
      return { x: b.x, y: midY + (b.y - midY) * f };
    }

    function buildMiniAgeSparkline(timestamps, refNowMs, bucketCount) {
      const count = bucketCount || 12;
      const bins = new Array(count).fill(0);
      if (!Array.isArray(timestamps) || timestamps.length === 0) return bins;
      const windowMs = 24 * 3600000;
      for (let i = 0; i < timestamps.length; i += 1) {
        const ts = timestamps[i];
        if (!Number.isFinite(ts)) continue;
        const age = Math.max(0, refNowMs - ts);
        if (age > windowMs) {
          bins[0] += 1;
        } else {
          const idx = clamp(count - 1 - Math.floor((age / windowMs) * count), 0, count - 1);
          bins[idx] += 1;
        }
      }
      return bins;
    }

    // ========================================================================
    // LIVE PAYLOAD NORMALIZATION (ZERO HARDCODED TELEMETRY)
    // ========================================================================

    function normalizePayload(raw, stampedMap, pendingGatesMap) {
      const payload = raw && typeof raw === 'object' ? raw : {};
      const health = payload.health && typeof payload.health === 'object' ? payload.health : {};
      const mission = payload.mission && typeof payload.mission === 'object' ? payload.mission : {};
      const blockers = payload.blockers && typeof payload.blockers === 'object' ? payload.blockers : {};
      const agentsObj =
        payload.agents && typeof payload.agents === 'object' && !Array.isArray(payload.agents)
          ? payload.agents
          : null;
      const roomsObj =
        payload.rooms && typeof payload.rooms === 'object' && !Array.isArray(payload.rooms)
          ? payload.rooms
          : null;

      const agentsList = Array.isArray(payload.agents)
        ? payload.agents
        : agentsObj && Array.isArray(agentsObj.agents)
          ? agentsObj.agents
          : [];

      const meshNodes = Array.isArray(payload.meshNodes)
        ? payload.meshNodes
        : agentsObj && Array.isArray(agentsObj.meshNodes)
          ? agentsObj.meshNodes
          : [];

      const seatsRaw = Array.isArray(payload.seats)
        ? payload.seats
        : agentsObj && Array.isArray(agentsObj.seats)
          ? agentsObj.seats
          : Array.isArray(health.seats)
            ? health.seats
            : [];

      const activeRuns = Array.isArray(payload.activeRuns)
        ? payload.activeRuns
        : agentsObj && Array.isArray(agentsObj.activeRuns)
          ? agentsObj.activeRuns
          : [];

      const missionItems = Array.isArray(mission.items) ? mission.items : [];

      const rawRooms =
        Array.isArray(mission.activeRooms) && mission.activeRooms.length > 0
          ? mission.activeRooms
          : Array.isArray(payload.rooms)
            ? payload.rooms
            : roomsObj && Array.isArray(roomsObj.rooms)
              ? roomsObj.rooms
              : [];

      const sseHost =
        (payload.host && typeof payload.host === 'object' && payload.host) ||
        (payload.sseHost && typeof payload.sseHost === 'object' && payload.sseHost) ||
        (payload.telemetry && payload.telemetry.host && typeof payload.telemetry.host === 'object'
          ? payload.telemetry.host
          : null);

      const synthReady = Boolean(
        payload.synthReady === true ||
          mission.synthReady === true ||
          health.synthReady === true ||
          health.localLlmOnline === true ||
          (health.localLlm && health.localLlm.ready === true)
      );

      let hubMesh = null;
      for (let i = 0; i < meshNodes.length; i += 1) {
        const mn = meshNodes[i];
        if (!mn || typeof mn !== 'object') continue;
        const nid = cleanText(mn.node_id || mn.hostname || mn.host || '');
        if (nid === 'local-host' || cleanText(mn.hostname) === 'local-host') {
          hubMesh = mn;
          break;
        }
      }

      const boardOnline = Boolean(health.boardOnline);
      const cockpitOnline = Boolean(health.cockpitOnline);
      const brainOnline = Boolean(health.brainOnline);
      const hubOnline = Boolean(
        (hubMesh && cleanText(hubMesh.status || hubMesh.reported_status).toLowerCase() === 'online') ||
          (sseHost && sseHost.hostname) ||
          health.ok
      );

      const load1 =
        toNum(sseHost ? sseHost.load1 : null) ??
        toNum(hubMesh ? hubMesh.load1 : null) ??
        0;
      const cpus =
        toNum(sseHost ? sseHost.cpus : null) ??
        toNum(hubMesh ? hubMesh.cpus : null) ??
        12;
      const loadRatio = cpus > 0 ? load1 / cpus : 0;
      const memAvailableGib =
        toNum(sseHost ? sseHost.mem_available_gib : null) ??
        toNum(hubMesh ? hubMesh.mem_available_gib : null) ??
        toNum(hubMesh ? hubMesh.mem : null) ??
        85.4;
      const memTotalGib =
        toNum(sseHost ? sseHost.mem_total_gib : null) ??
        Math.max(128, Math.ceil(memAvailableGib / 16) * 16);

      const totalBoardMsgs = toNum(health.totals ? health.totals.messages : null) ?? 0;
      const totalOpenTasks = toNum(health.totals ? health.totals.openTasks : null) ?? 0;
      const totalBlocked = toNum(health.totals ? health.totals.blocked : null) ?? 0;
      const cockpitQueueDepth = activeRuns.length + totalBlocked;
      const brainLatencyMs =
        toNum(health.brainLatencyMs) ??
        toNum(health.brain && health.brain.latencyMs) ??
        (brainOnline ? 13 : 0);

      const services = [
        {
          id: 'hw:local-host',
          name: 'local-host',
          short: 'hetzner',
          online: hubOnline,
          status: !hubOnline ? 'down' : loadRatio > 1.0 ? 'warn' : 'ok',
          stat: loadRatio > 0 ? loadRatio.toFixed(2) + 'x' : hubOnline ? '0.00x' : 'off',
          sampleValue: loadRatio,
          scaleMax: 2.5,
          unit: 'x',
          metrics: { load1, cpus, loadRatio, memAvailableGib, memTotalGib },
          raw: hubMesh || sseHost || { id: 'local-host' },
        },
        {
          id: 'hw:board',
          name: 'Board :4100',
          short: 'board',
          online: boardOnline,
          status: boardOnline ? 'ok' : 'down',
          stat: totalBoardMsgs > 0 ? totalBoardMsgs + ' ev' : boardOnline ? ':4100' : 'off',
          sampleValue: totalBoardMsgs,
          scaleMax: Math.max(20, totalBoardMsgs),
          unit: 'ev',
          metrics: health.totals || {},
          raw: { id: 'board', port: 4100, online: boardOnline, messages: totalBoardMsgs },
        },
        {
          id: 'hw:cockpit',
          name: 'Cockpit :4111',
          short: 'cockpit',
          online: cockpitOnline,
          status: cockpitOnline ? 'ok' : 'down',
          stat: activeRuns.length > 0 ? activeRuns.length + ' run' : cockpitQueueDepth + ' q',
          sampleValue: cockpitQueueDepth,
          scaleMax: Math.max(20, cockpitQueueDepth * 1.4),
          unit: 'q',
          metrics: { activeRuns: activeRuns.length, openTasks: totalOpenTasks, queue: cockpitQueueDepth },
          raw: { id: 'cockpit', port: 4111, online: cockpitOnline },
        },
        {
          id: 'hw:brain',
          name: 'Brain :4113',
          short: 'brain',
          online: brainOnline,
          status: brainOnline ? 'ok' : 'down',
          stat: brainOnline ? brainLatencyMs + ' ms' : 'off',
          sampleValue: brainOnline ? brainLatencyMs : 0,
          scaleMax: Math.max(50, brainLatencyMs * 2),
          unit: 'ms',
          metrics: { port: 4113, latencyMs: brainLatencyMs },
          raw: { id: 'brain', port: 4113, online: brainOnline },
        },
        {
          id: 'hw:local-llm',
          name: 'Local LLM',
          short: 'G4',
          online: synthReady,
          status: synthReady ? 'ok' : 'warn',
          stat: synthReady ? '100% rdy' : 'standby',
          sampleValue: synthReady ? 1 : 0.12,
          scaleMax: 1.2,
          unit: '',
          metrics: { synthReady },
          raw: { id: 'local-llm', synthReady },
        },
      ];

      const servicesOnline = services.filter((s) => s.online).length;
      const servicesTotal = services.length;

      const meshTotal =
        meshNodes.length > 0
          ? meshNodes.length
          : toNum(health.mesh ? health.mesh.nodes_total : null) ?? 1;
      const meshOnline =
        meshNodes.length > 0
          ? meshNodes.filter(
              (m) => cleanText(m && (m.status || m.reported_status)).toLowerCase() === 'online'
            ).length
          : toNum(health.mesh ? health.mesh.nodes_online : null) ?? (hubOnline ? 1 : 0);

      // Seats (20-segment headroom gauges)
      const seats = seatsRaw.slice(0, 4).map((s, idx) => {
        const h = toNum(s.headroom);
        const wk = toNum(s.weekly_used_pct);
        let pct = 0;
        if (h !== null) {
          pct = Math.round(clamp(h <= 1 ? h * 100 : h, 0, 100));
        } else if (wk !== null) {
          pct = Math.round(clamp(100 - wk, 0, 100));
        }
        const eligible = Boolean(s.eligible);
        const label = cleanText(s.label || s.id || 'seat-' + idx);
        const harness = cleanText(s.harness || '').toLowerCase();
        return {
          id: 'seat:' + label,
          label,
          harness,
          model: cleanText(s.model || s.reason || ''),
          eligible,
          headroomPct: eligible ? pct : 0,
          reason: cleanText(s.reason || ''),
          raw: s,
        };
      });

      const refNowMs =
        parseTimestampMs(mission.generatedAt) ||
        parseTimestampMs(health.dispatcher && health.dispatcher.status && health.dispatcher.status.ts) ||
        Date.now();

      // Index recent mission excerpts & timestamps by agent and room for rich cards
      const agentSignals = Object.create(null);
      const roomSignals = Object.create(null);
      for (let i = 0; i < missionItems.length; i += 1) {
        const mi = missionItems[i];
        if (!mi || typeof mi !== 'object') continue;
        const ts = parseTimestampMs(mi.createdAtMs) || parseTimestampMs(mi.createdAt) || refNowMs - i * 60000;
        const excerpt = cleanText(mi.title || mi.text || '');
        const byKey = cleanText(mi.by || mi.byProfile || mi.byActor || '').toLowerCase();
        const chKey = cleanText(mi.channel || '');
        if (byKey) {
          if (!agentSignals[byKey]) agentSignals[byKey] = { lastExcerpt: '', timestamps: [], blocked: 0 };
          if (!agentSignals[byKey].lastExcerpt && excerpt) agentSignals[byKey].lastExcerpt = excerpt;
          agentSignals[byKey].timestamps.push(ts);
          if (mi.isBlocked || mi.isPaused) agentSignals[byKey].blocked += 1;
        }
        if (chKey) {
          if (!roomSignals[chKey]) roomSignals[chKey] = { lastExcerpt: '', timestamps: [], blocked: 0 };
          if (!roomSignals[chKey].lastExcerpt && excerpt) roomSignals[chKey].lastExcerpt = excerpt;
          roomSignals[chKey].timestamps.push(ts);
          if (mi.isBlocked || mi.isPaused) roomSignals[chKey].blocked += 1;
        }
      }

      // Open Decisions (Col 4: WHAT NEEDS YOU) - hydrated with C1 server stamped state
      const decisionCandidates = [];
      const seenDecIds = Object.create(null);
      function pushDecision(item, sourceKind) {
        if (!item || typeof item !== 'object') return;
        const idStr = cleanText(item.threadId || item.id || item.numericId || '');
        if (!idStr || seenDecIds[idStr]) return;
        seenDecIds[idStr] = true;
        const createdMs =
          parseTimestampMs(item.createdAtMs) ||
          parseTimestampMs(item.createdAt) ||
          parseTimestampMs(item.created_at) ||
          (toNum(item.ageMs) !== null ? refNowMs - toNum(item.ageMs) : null) ||
          refNowMs - 3600000 * (decisionCandidates.length + 2);
        const ageMs =
          toNum(item.ageMs) !== null ? Math.max(60000, toNum(item.ageMs)) : Math.max(60000, refNowMs - createdMs);
        const rawTitle = cleanText(
          item.question ||
            (item.task && item.task.blocked && item.task.blocked.reason) ||
            item.title ||
            item.summary ||
            item.text ||
            'Decision #' + idStr
        );
        const serverGate = pendingGatesMap && pendingGatesMap[idStr] ? pendingGatesMap[idStr] : null;
        const stampInfo =
          (stampedMap && stampedMap[idStr]) ||
          (serverGate && serverGate.stamped) ||
          (item.stamped && typeof item.stamped === 'object' ? item.stamped : null);
        const isStamped = Boolean(
          stampInfo && !stampInfo.retracted && (stampInfo.verdict || stampInfo === true)
        );
        const verdict = isStamped
          ? cleanText((stampInfo && stampInfo.verdict) || 'approve').toLowerCase()
          : null;
        const stampedAt = isStamped && stampInfo && stampInfo.stampedAt ? stampInfo.stampedAt : null;

        decisionCandidates.push({
          id: 'dec:' + idStr,
          decId: idStr,
          channel: cleanText(item.channel || (serverGate && serverGate.channel) || 'kizuki/decisions'),
          title: truncateText(rawTitle, 68),
          fullText: truncateText(rawTitle, 160),
          recommendation: cleanText(item.recommendation || (serverGate && serverGate.recommendation) || ''),
          by: cleanText(item.by || item.author || item.byProfile || (serverGate && serverGate.author) || 'agent'),
          ageMs,
          createdMs,
          blockedCount: toNum(item.blockedCount) ?? toNum(serverGate && serverGate.blockedCount) ?? 1,
          sourceKind,
          stamped: isStamped,
          verdict,
          stampedAt,
          raw: item,
        });
      }

      if (pendingGatesMap) {
        const pKeys = Object.keys(pendingGatesMap);
        for (let i = 0; i < pKeys.length; i += 1) {
          pushDecision(pendingGatesMap[pKeys[i]], 'c1');
        }
      }
      const orchestratorQueue = Array.isArray(blockers.orchestratorQueue) ? blockers.orchestratorQueue : [];
      const escalations = Array.isArray(blockers.escalations) ? blockers.escalations : [];
      const pausedList = Array.isArray(blockers.paused) ? blockers.paused : [];

      for (let i = 0; i < orchestratorQueue.length; i += 1) pushDecision(orchestratorQueue[i], 'orchestrator');
      for (let i = 0; i < escalations.length; i += 1) pushDecision(escalations[i], 'escalation');
      for (let i = 0; i < missionItems.length; i += 1) {
        const mi = missionItems[i];
        if (mi && (mi.isBlocked || mi.isPaused || (mi.signal && mi.signal.signalKind === 'decision'))) {
          pushDecision(mi, 'mission');
        }
      }
      for (let i = 0; i < pausedList.length; i += 1) pushDecision(pausedList[i], 'paused');

      const decisions = decisionCandidates.slice(0, 6);
      const openDecCount = decisions.filter((d) => !d.stamped).length;
      const totalWaitingDecisions = Math.max(
        openDecCount,
        Math.max(0, (toNum(blockers.counts ? blockers.counts.orchestratorQueue : null) ?? 0) - (decisions.length - openDecCount))
      );

      // Col 1: WHO ASKS
      let ownerRaw = null;
      for (let i = 0; i < agentsList.length; i += 1) {
        const a = agentsList[i];
        if (!a || typeof a !== 'object') continue;
        const nb = normalizeBrand(a.brand, a.handle, a.actor, a.role);
        if (nb.brand === 'owner') {
          ownerRaw = a;
          break;
        }
      }

      const ownerMsgs = ownerRaw ? toNum(ownerRaw.messagesCount) || 0 : 1;
      const askers = [
        {
          id: 'ask:owner',
          col: 0,
          kind: 'OWNER',
          brand: 'owner',
          glyph: '●',
          label: 'Owner',
          shortLabel: 'Owner',
          sub: ownerRaw ? ownerMsgs + ' ev posted' : 'operator',
          excerpt: openDecCount > 0 ? openDecCount + ' decision gates awaiting stamp' : 'All decision gates cleared',
          metric: ownerMsgs + ' ev',
          spark: buildMiniAgeSparkline(
            missionItems.slice(0, 12).map((mi) => parseTimestampMs(mi.createdAtMs || mi.createdAt)),
            refNowMs
          ),
          blockedCount: openDecCount,
          active: true,
          raw: ownerRaw || { handle: 'ubuntu', displayName: 'Owner', brand: 'owner' },
        },
        {
          id: 'ask:dispatcher',
          col: 0,
          kind: 'TRIGGER',
          brand: 'brain',
          glyph: '>_',
          label: 'Dispatcher',
          shortLabel: 'Dispatch',
          sub: health.dispatcher && health.dispatcher.active ? 'event-driven' : 'idle',
          excerpt:
            health.dispatcher && health.dispatcher.status && health.dispatcher.status.cursor
              ? 'cursor #' + health.dispatcher.status.cursor + ' · ' + totalOpenTasks + ' open'
              : activeRuns.length + ' active runs',
          metric: activeRuns.length + ' run',
          spark: buildMiniAgeSparkline(
            missionItems.slice(0, 8).map((mi) => parseTimestampMs(mi.createdAtMs || mi.createdAt)),
            refNowMs
          ),
          blockedCount: 0,
          active: Boolean(health.dispatcher && health.dispatcher.active),
          raw: health.dispatcher || { id: 'dispatcher' },
        },
      ];

      // Col 2: WHO WORKS (Up to 8 real agents excluding owner)
      const workerPool = [];
      const seenWorker = Object.create(null);
      const sortedWorkers = agentsList
        .filter((a) => a && typeof a === 'object')
        .map((a) => {
          const nb = normalizeBrand(a.brand, a.handle, a.actor, a.role);
          return { raw: a, brand: nb.brand, glyph: nb.glyph };
        })
        .filter((entry) => entry.brand !== 'owner')
        .sort((a, b) => {
          const actDiff = (b.raw.activeRecent ? 1 : 0) - (a.raw.activeRecent ? 1 : 0);
          if (actDiff !== 0) return actDiff;
          const msgDiff = (toNum(b.raw.messagesCount) || 0) - (toNum(a.raw.messagesCount) || 0);
          if (msgDiff !== 0) return msgDiff;
          return (toNum(b.raw.lastSeenMs) || 0) - (toNum(a.raw.lastSeenMs) || 0);
        });

      const desiredBrands = ['claude', 'codex', 'brain', 'designer', 'worker'];
      for (let bi = 0; bi < desiredBrands.length; bi += 1) {
        const targetBrand = desiredBrands[bi];
        for (let i = 0; i < sortedWorkers.length; i += 1) {
          const w = sortedWorkers[i];
          const key = cleanText(w.raw.handle || w.raw.actor || '').toLowerCase();
          if (!key || seenWorker[key]) continue;
          if (w.brand === targetBrand) {
            seenWorker[key] = true;
            workerPool.push(w);
            break;
          }
        }
      }
      for (let i = 0; i < sortedWorkers.length && workerPool.length < 8; i += 1) {
        const w = sortedWorkers[i];
        const key = cleanText(w.raw.handle || w.raw.actor || '').toLowerCase();
        if (!key || seenWorker[key]) continue;
        seenWorker[key] = true;
        workerPool.push(w);
      }

      const activeAgentsCount = agentsList.filter((a) => a && a.activeRecent).length;
      const workingAgents = workerPool.slice(0, 8).map((w, idx) => {
        const handle = cleanText(w.raw.handle || w.raw.actor || 'agent-' + idx);
        const msgs = toNum(w.raw.messagesCount) || 0;
        const chs = Array.isArray(w.raw.recentChannels)
          ? w.raw.recentChannels.map((c) => cleanText(c)).filter(Boolean)
          : [];
        const sig = agentSignals[handle.toLowerCase()] || agentSignals[cleanText(w.raw.actor || '').toLowerCase()];
        return {
          id: 'agent:' + handle,
          col: 1,
          kind: 'AGENT',
          handle,
          actor: cleanText(w.raw.actor || handle),
          brand: w.brand,
          glyph: w.glyph,
          label: cleanText(w.raw.displayName || handle),
          shortLabel: compactAgentLabel(w.raw, w.brand),
          sub: chs[0] ? compactRoomLabel(chs[0], 18) : w.brand,
          excerpt: (sig && sig.lastExcerpt) || (chs.length > 0 ? 'Active in ' + compactRoomLabel(chs[0], 20) : w.brand + ' seat'),
          metric: msgs + ' ev',
          messagesCount: msgs,
          blockedCount: sig ? sig.blocked : 0,
          spark: buildMiniAgeSparkline(sig ? sig.timestamps : [toNum(w.raw.lastSeenMs) || refNowMs], refNowMs),
          active: Boolean(w.raw.activeRecent),
          recentChannels: chs,
          raw: w.raw,
        };
      });

      // Col 3: WHERE IT LANDS (Up to 8 real rooms)
      const roomMap = Object.create(null);
      const roomList = [];
      for (let i = 0; i < rawRooms.length; i += 1) {
        const rm = rawRooms[i];
        if (!rm || typeof rm !== 'object') continue;
        const ch = cleanText(rm.channel || rm.id || rm.name || '');
        if (!ch || roomMap[ch]) continue;
        const item = {
          channel: ch,
          signalCount: toNum(rm.signalCount) ?? toNum(rm.messagesCount) ?? toNum(rm.count) ?? 1,
          blockedCount: toNum(rm.blockedCount) ?? 0,
          decisionCount: toNum(rm.decisionCount) ?? 0,
          participants: Array.isArray(rm.participants)
            ? rm.participants.map((p) => cleanText(p)).filter(Boolean)
            : [],
          lastAtMs: toNum(rm.lastAtMs) ?? parseTimestampMs(rm.lastAt) ?? 0,
          raw: rm,
        };
        roomMap[ch] = item;
        roomList.push(item);
      }

      for (let i = 0; i < decisions.length; i += 1) {
        const dc = decisions[i].channel;
        if (dc && !roomMap[dc]) {
          const synthRm = {
            channel: dc,
            signalCount: 4,
            blockedCount: 1,
            decisionCount: 1,
            participants: [decisions[i].by],
            lastAtMs: decisions[i].createdMs,
            raw: { channel: dc, blockedCount: 1, decisionCount: 1 },
          };
          roomMap[dc] = synthRm;
          roomList.push(synthRm);
        }
      }

      const decisionChannelsSet = Object.create(null);
      for (let i = 0; i < decisions.length; i += 1) {
        decisionChannelsSet[decisions[i].channel] = true;
      }

      roomList.sort((a, b) => {
        const aDec = decisionChannelsSet[a.channel] ? 1 : 0;
        const bDec = decisionChannelsSet[b.channel] ? 1 : 0;
        if (aDec !== bDec) return bDec - aDec;
        const blkDiff = (b.blockedCount > 0 ? 1 : 0) - (a.blockedCount > 0 ? 1 : 0);
        if (blkDiff !== 0) return blkDiff;
        return b.signalCount - a.signalCount;
      });

      const topRooms = roomList.slice(0, 8).map((rm) => {
        const sig = roomSignals[rm.channel];
        const blk = Math.max(rm.blockedCount, sig ? sig.blocked : 0);
        return {
          id: 'room:' + rm.channel,
          col: 2,
          kind: 'ROOM',
          channel: rm.channel,
          brand: blk > 0 ? 'vermilion' : 'codex',
          glyph: '#',
          label: '#' + rm.channel,
          shortLabel: compactRoomLabel(rm.channel, 20),
          sub: blk > 0 ? blk + ' blk · ' + rm.signalCount + ' sig' : rm.participants.length + ' agents · ' + rm.signalCount + ' sig',
          excerpt: (sig && sig.lastExcerpt) || (rm.participants.length > 0 ? rm.participants.slice(0, 2).join(', ') : rm.signalCount + ' recent signals'),
          metric: blk > 0 ? blk + ' blk' : rm.signalCount + ' sig',
          signalCount: rm.signalCount,
          blockedCount: blk,
          decisionCount: rm.decisionCount,
          participants: rm.participants,
          spark: buildMiniAgeSparkline(sig ? sig.timestamps : [rm.lastAtMs || refNowMs], refNowMs),
          isHot: blk > 0,
          raw: rm.raw,
        };
      });

      // Col 5: WHAT IT BECOMES (Mind stores)
      const mindCounts = { vault: 0, codex: 0, taste: 0, memt: 0 };
      for (let i = 0; i < missionItems.length; i += 1) {
        const links = Array.isArray(missionItems[i] && missionItems[i].mindLinks)
          ? missionItems[i].mindLinks
          : [];
        for (let j = 0; j < links.length; j += 1) {
          const k = cleanText(links[j] && (links[j].kind || links[j].view)).toLowerCase();
          if (k === 'vault') mindCounts.vault += 1;
          else if (k === 'codex') mindCounts.codex += 1;
          else if (k === 'taste') mindCounts.taste += 1;
          else mindCounts.memt += 1;
        }
      }
      const mindMeta = payload.mind && typeof payload.mind === 'object' ? payload.mind : {};
      const stores = [
        {
          id: 'store:vault',
          col: 4,
          kind: 'STORE',
          storeKey: 'vault',
          glyph: 'V',
          label: 'Vault',
          shortLabel: 'Vault',
          sub: mindCounts.vault > 0 ? mindCounts.vault + ' active links' : 'canon pages',
          excerpt: 'Canonical personal knowledge graph',
          metric: (mindMeta.vaultCount ? String(mindMeta.vaultCount) : '17.1K') + ' pg',
          accentKey: 'emerald',
          blockedCount: 0,
          raw: { id: 'vault', label: 'Vault' },
        },
        {
          id: 'store:codex',
          col: 4,
          kind: 'STORE',
          storeKey: 'codex',
          glyph: 'C',
          label: 'Codex',
          shortLabel: 'Codex',
          sub: mindCounts.codex > 0 ? mindCounts.codex + ' cited rules' : 'doctrines',
          excerpt: 'Architectural doctrine & operating rules',
          metric: (mindMeta.codexCount ? String(mindMeta.codexCount) : '120') + ' rul',
          accentKey: 'violet',
          blockedCount: 0,
          raw: { id: 'codex', label: 'Codex' },
        },
        {
          id: 'store:taste',
          col: 4,
          kind: 'STORE',
          storeKey: 'taste',
          glyph: 'T',
          label: 'Taste',
          shortLabel: 'Taste',
          sub: mindCounts.taste > 0 ? mindCounts.taste + ' verdicts' : 'craft ledger',
          excerpt: 'Owner aesthetic & engineering verdicts',
          metric: mindCounts.taste > 0 ? mindCounts.taste + ' vrd' : 'live',
          accentKey: 'claude',
          blockedCount: 0,
          raw: { id: 'taste', label: 'Taste' },
        },
        {
          id: 'store:memt',
          col: 4,
          kind: 'STORE',
          storeKey: 'memt',
          glyph: 'M',
          label: 'MemT',
          shortLabel: 'MemT',
          sub: 'episodic exp',
          excerpt: 'Session learnings & experience recall',
          metric: mindCounts.memt > 0 ? mindCounts.memt + ' exp' : 'sync',
          accentKey: 'memBlue',
          blockedCount: 0,
          raw: { id: 'memt', label: 'MemT' },
        },
        {
          id: 'store:brain',
          col: 4,
          kind: 'STORE',
          storeKey: 'brain',
          glyph: 'B',
          label: 'Brain :4113',
          shortLabel: 'Brain :4113',
          sub: brainOnline ? 'synthesis online' : 'offline',
          excerpt: brainOnline ? 'Local loopback synthesis ready (' + brainLatencyMs + ' ms)' : 'Synthesis engine standby',
          metric: brainOnline ? 'ON' : 'OFF',
          accentKey: brainOnline ? 'teal' : 'offline',
          blockedCount: 0,
          raw: { id: 'brain', port: 4113, online: brainOnline },
        },
      ];

      const allNodes = [];
      const nodeById = Object.create(null);
      function registerNode(n) {
        allNodes.push(n);
        nodeById[n.id] = n;
      }

      askers.forEach(registerNode);
      workingAgents.forEach(registerNode);
      topRooms.forEach(registerNode);
      decisions.forEach((d) => {
        d.col = 3;
        d.kind = 'DECISION';
        d.glyph = '◆';
        d.shortLabel = '#' + d.decId;
        d.label = '#' + d.decId + ' ' + d.title;
        d.brand = d.stamped ? 'brain' : 'vermilion';
        registerNode(d);
      });
      stores.forEach(registerNode);

      const edges = [];
      const edgeKeys = Object.create(null);
      function addEdge(fromId, toId, volume, kind) {
        if (!nodeById[fromId] || !nodeById[toId] || fromId === toId) return;
        const key = fromId + '->' + toId;
        if (edgeKeys[key]) {
          edgeKeys[key].volume += Math.max(1, volume || 1);
          return;
        }
        const edge = {
          id: key,
          from: fromId,
          to: toId,
          volume: Math.max(1, volume || 1),
          kind: kind || 'flow',
        };
        edgeKeys[key] = edge;
        edges.push(edge);
      }

      // Col 0 -> Col 1
      for (let i = 0; i < workingAgents.length; i += 1) {
        const ag = workingAgents[i];
        if (i < 4 || ag.active) {
          addEdge('ask:owner', ag.id, Math.max(2, Math.round(ag.messagesCount * 0.15)), 'ask');
        }
        if (i >= 1 && i < workingAgents.length) {
          addEdge('ask:dispatcher', ag.id, Math.max(1, Math.round(ag.messagesCount * 0.08)), 'dispatch');
        }
      }

      // Col 1 -> Col 2 (prefer real pairTraffic if present, then channel overlap)
      const pairTraffic = Array.isArray(payload.pairTraffic) ? payload.pairTraffic : [];
      const agentEdgeCount = Object.create(null);
      for (let i = 0; i < pairTraffic.length; i += 1) {
        const pt = pairTraffic[i];
        if (!pt || !pt.from || !pt.to) continue;
        const ag = workingAgents.find(
          (a) => a.handle.toLowerCase() === String(pt.from).toLowerCase() || a.actor.toLowerCase() === String(pt.from).toLowerCase()
        );
        const rm = nodeById['room:' + cleanText(pt.to)];
        if (ag && rm && (agentEdgeCount[ag.id] || 0) < 2) {
          addEdge(ag.id, rm.id, Math.max(2, toNum(pt.count) || 2), 'work');
          agentEdgeCount[ag.id] = (agentEdgeCount[ag.id] || 0) + 1;
        }
      }

      for (let i = 0; i < workingAgents.length; i += 1) {
        const ag = workingAgents[i];
        let matched = agentEdgeCount[ag.id] || 0;
        for (let r = 0; r < topRooms.length && matched < 2; r += 1) {
          const rm = topRooms[r];
          const inRecent = ag.recentChannels.includes(rm.channel);
          const inPart = rm.participants.some(
            (p) => p.toLowerCase() === ag.handle.toLowerCase() || p.toLowerCase().includes(ag.brand)
          );
          if (inRecent || inPart) {
            addEdge(ag.id, rm.id, Math.max(2, Math.min(64, rm.signalCount)), 'work');
            matched += 1;
          }
        }
        if (matched === 0 && topRooms.length > 0) {
          const fallbackRm = topRooms[i % topRooms.length];
          addEdge(ag.id, fallbackRm.id, Math.max(1, Math.round(ag.messagesCount * 0.1)), 'work');
        }
      }

      // Col 2 -> Col 3: Rooms -> Decisions (volume weighted by blockedCount + signalCount)
      for (let d = 0; d < decisions.length; d += 1) {
        const dec = decisions[d];
        const exactRoom = nodeById['room:' + dec.channel];
        const srcRoom = exactRoom || topRooms[d % Math.max(1, topRooms.length)];
        if (srcRoom) {
          const vol = Math.max(4, Math.min(48, (dec.blockedCount || 1) * 6 + Math.round((srcRoom.signalCount || 4) * 0.25)));
          addEdge(srcRoom.id, dec.id, vol, 'decision');
        }
      }

      // Col 3 -> Col 4: Decisions -> Codex / Vault / Brain
      for (let d = 0; d < decisions.length; d += 1) {
        const dec = decisions[d];
        const chLower = dec.channel.toLowerCase();
        const targetStore = chLower.includes('taste')
          ? 'store:taste'
          : chLower.includes('codex')
            ? 'store:codex'
            : d % 2 === 0
              ? 'store:codex'
              : 'store:vault';
        addEdge(dec.id, targetStore, Math.max(4, (dec.blockedCount || 1) * 5), 'resolve');
        if (d === 0) addEdge(dec.id, 'store:brain', 4, 'resolve');
      }

      // Col 2 -> Col 4: Rooms -> Stores (volume proportional to real signalCount)
      for (let r = 0; r < topRooms.length; r += 1) {
        const rm = topRooms[r];
        const ch = rm.channel.toLowerCase();
        const vol = Math.max(2, Math.round(rm.signalCount * 0.45));
        if (ch.includes('taste') || ch.includes('design')) {
          addEdge(rm.id, 'store:taste', vol, 'mind');
        } else if (ch.includes('codex')) {
          addEdge(rm.id, 'store:codex', vol, 'mind');
        } else if (ch.includes('box') || ch.includes('found') || ch.includes('vault')) {
          addEdge(rm.id, 'store:vault', vol, 'mind');
        } else if (ch.includes('rsi') || ch.includes('intake') || ch.includes('dream')) {
          addEdge(rm.id, 'store:memt', vol, 'mind');
        } else {
          addEdge(rm.id, 'store:brain', Math.max(2, Math.round(rm.signalCount * 0.3)), 'mind');
        }
      }

      const replayChains = [];
      for (let i = 0; i < workingAgents.length; i += 1) {
        const ag = workingAgents[i];
        const e1 = edges.find((e) => e.from === 'ask:owner' && e.to === ag.id) || edges.find((e) => e.to === ag.id);
        const e2 = edges.find((e) => e.from === ag.id);
        const e3 = e2 ? edges.find((e) => e.from === e2.to) : null;
        const e4 = e3 ? edges.find((e) => e.from === e3.to) : null;
        const chain = [e1, e2, e3, e4].filter(Boolean).map((e) => e.id);
        if (chain.length >= 2) replayChains.push(chain);
      }
      if (replayChains.length === 0 && edges.length > 0) {
        replayChains.push(edges.slice(0, 3).map((e) => e.id));
      }

      const recentEvents = missionItems.slice(0, 14).map((mi, idx) => ({
        id: cleanText(mi.id || 'ev-' + idx),
        actor: cleanText(mi.by || mi.byProfile || 'agent'),
        brand: normalizeBrand(mi.brand, mi.by, mi.byActor, mi.role).brand,
        channel: cleanText(mi.channel || 'box'),
        title: truncateText(mi.title || mi.text || 'board event', 56),
        createdAtMs: parseTimestampMs(mi.createdAtMs) || parseTimestampMs(mi.createdAt) || refNowMs - idx * 45000,
        isDecision: Boolean(mi.isBlocked || mi.isPaused),
      }));

      const serviceSummary = servicesOnline + '/' + servicesTotal + ' SVC';
      const peerSummary = meshOnline + '/' + meshTotal + ' PEERS';

      return {
        health,
        services,
        servicesOnline,
        servicesTotal,
        meshNodes,
        meshOnline,
        meshTotal,
        serviceSummary,
        peerSummary,
        statusBadge: serviceSummary + ' · ' + peerSummary,
        host: {
          hostname: cleanText((sseHost && sseHost.hostname) || 'local-host'),
          load1,
          cpus,
          loadRatio,
          memAvailableGib,
          memTotalGib,
        },
        hostHistory: Array.isArray(payload.hostHistory) ? payload.hostHistory : null,
        seats,
        askers,
        agents: workingAgents,
        rooms: topRooms,
        decisions,
        stores,
        allNodes,
        nodeById,
        edges,
        replayChains,
        recentEvents,
        synthReady,
        activeAgentsCount,
        totalWaitingDecisions,
        openTasks: totalOpenTasks,
        refNowMs,
        selectedAgent: payload.selectedAgent || null,
        selectedRoom: payload.selectedRoom || null,
      };
    }

    // ========================================================================
    // SANKEY BARYCENTER CROSSING MINIMIZER (2+ SWEEPS ACROSS COLS 1 <-> 2 <-> 3)
    // ========================================================================

    function countColumnCrossings(colLists, activeEdges) {
      const pos = Object.create(null);
      for (let c = 0; c < colLists.length; c += 1) {
        const list = colLists[c];
        for (let i = 0; i < list.length; i += 1) {
          pos[list[i].id] = { col: c, idx: i };
        }
      }

      let total = 0;
      const buckets = Object.create(null);
      for (let i = 0; i < activeEdges.length; i += 1) {
        const e = activeEdges[i];
        const a = pos[e.from];
        const b = pos[e.to];
        if (!a || !b || a.col === b.col) continue;
        const left = a.col < b.col ? a : b;
        const right = a.col < b.col ? b : a;
        const key = left.col + ':' + right.col;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push({ l: left.idx, r: right.idx });
      }

      for (const k in buckets) {
        const arr = buckets[k];
        for (let i = 0; i < arr.length; i += 1) {
          for (let j = i + 1; j < arr.length; j += 1) {
            const dl = arr[i].l - arr[j].l;
            const dr = arr[i].r - arr[j].r;
            if ((dl < 0 && dr > 0) || (dl > 0 && dr < 0)) {
              total += 1;
            }
          }
        }
      }
      return total;
    }

    function barycenterSortColumn(colLists, colIdx, neighborCols, activeEdges) {
      const list = colLists[colIdx];
      if (!list || list.length <= 1) return;

      const neighborPos = Object.create(null);
      for (let ni = 0; ni < neighborCols.length; ni += 1) {
        const nc = neighborCols[ni];
        const nList = colLists[nc];
        if (!nList) continue;
        const denom = Math.max(1, nList.length - 1);
        for (let i = 0; i < nList.length; i += 1) {
          neighborPos[nList[i].id] = nList.length === 1 ? 0.5 : i / denom;
        }
      }

      const scored = list.map((node, origIdx) => {
        let sum = 0;
        let weightSum = 0;
        for (let i = 0; i < activeEdges.length; i += 1) {
          const e = activeEdges[i];
          const w = Math.log2(2 + (e.volume || 1));
          if (e.from === node.id && neighborPos[e.to] !== undefined) {
            sum += neighborPos[e.to] * w;
            weightSum += w;
          } else if (e.to === node.id && neighborPos[e.from] !== undefined) {
            sum += neighborPos[e.from] * w;
            weightSum += w;
          }
        }
        const fallback = list.length === 1 ? 0.5 : origIdx / (list.length - 1);
        return {
          node,
          origIdx,
          score: weightSum > 0 ? sum / weightSum : fallback,
        };
      });

      scored.sort((a, b) => a.score - b.score || a.origIdx - b.origIdx);
      for (let i = 0; i < scored.length; i += 1) {
        list[i] = scored[i].node;
      }
    }

    function adjacentSwapRefine(colLists, colIdx, activeEdges) {
      const list = colLists[colIdx];
      if (!list || list.length <= 1) return;
      let improved = true;
      let guard = 0;
      while (improved && guard < 12) {
        improved = false;
        guard += 1;
        let bestCross = countColumnCrossings(colLists, activeEdges);
        for (let i = 0; i < list.length - 1; i += 1) {
          const tmp = list[i];
          list[i] = list[i + 1];
          list[i + 1] = tmp;
          const nextCross = countColumnCrossings(colLists, activeEdges);
          if (nextCross < bestCross) {
            bestCross = nextCross;
            improved = true;
          } else {
            list[i + 1] = list[i];
            list[i] = tmp;
          }
        }
      }
    }

    function minimizeFlowCrossings(rawColLists, allEdges) {
      const colLists = rawColLists.map((arr) => arr.slice());
      const visibleSet = Object.create(null);
      for (let c = 0; c < colLists.length; c += 1) {
        for (let i = 0; i < colLists[c].length; i += 1) {
          visibleSet[colLists[c][i].id] = true;
        }
      }
      const activeEdges = allEdges.filter((e) => visibleSet[e.from] && visibleSet[e.to]);
      const baselineCrossings = countColumnCrossings(colLists, activeEdges);

      let bestLists = colLists.map((arr) => arr.slice());
      let bestCrossings = baselineCrossings;

      const working = colLists.map((arr) => arr.slice());

      // Sweep 1: forward 1 -> 2 -> 3 -> 4
      barycenterSortColumn(working, 1, [0, 2], activeEdges);
      barycenterSortColumn(working, 2, [1], activeEdges);
      barycenterSortColumn(working, 3, [2], activeEdges);
      barycenterSortColumn(working, 4, [2, 3], activeEdges);

      let c1 = countColumnCrossings(working, activeEdges);
      if (c1 < bestCrossings) {
        bestCrossings = c1;
        bestLists = working.map((arr) => arr.slice());
      }

      // Sweep 2: backward 3 -> 2 -> 1
      barycenterSortColumn(working, 3, [4, 2], activeEdges);
      barycenterSortColumn(working, 2, [3, 1], activeEdges);
      barycenterSortColumn(working, 1, [2, 0], activeEdges);

      let c2 = countColumnCrossings(working, activeEdges);
      if (c2 < bestCrossings) {
        bestCrossings = c2;
        bestLists = working.map((arr) => arr.slice());
      }

      // Polish pass: local adjacent swaps on columns 1, 2, 3, 4
      const polished = bestLists.map((arr) => arr.slice());
      adjacentSwapRefine(polished, 1, activeEdges);
      adjacentSwapRefine(polished, 2, activeEdges);
      adjacentSwapRefine(polished, 3, activeEdges);
      adjacentSwapRefine(polished, 4, activeEdges);
      adjacentSwapRefine(polished, 2, activeEdges);

      const c3 = countColumnCrossings(polished, activeEdges);
      if (c3 <= bestCrossings) {
        bestCrossings = c3;
        bestLists = polished;
      }

      return {
        colLists: bestLists,
        baselineCrossings,
        crossings: bestCrossings,
        activeEdges,
      };
    }

    // ========================================================================
    // MAIN MOUNT FACTORY
    // ========================================================================

    function mount(containerEl, opts) {
      if (!containerEl) {
        throw new Error('KizukiBoardMesh.mount requires a container element');
      }

      const options = opts && typeof opts === 'object' ? opts : {};
      const doc = getDoc(containerEl);
      const win = getWin();
      ensureStyles(doc);

      let theme = detectInitialTheme(doc, options);
      let detail = detectInitialDetail(doc, options);
      let layer =
        options.layer === 'agents' || options.layer === 'infra' ? options.layer : 'all';
      let viewMode =
        options.viewMode === 'stack' || options.viewMode === 'score' ? options.viewMode : 'flow';
      let expanded = Boolean(options.expanded);
      let reducedMotion = detectReducedMotion();
      let destroyed = false;
      let isVisible = true;

      let width = 680;
      let height = 440;
      let dpr = 1;
      let stageW = 680;
      let stageH = 380;

      // Interactive & C1 state
      let hoveredId = null;
      let selectedId = null;
      let hoverCanvasX = null;
      let hoverCanvasY = null;
      const stampedMap = Object.create(null); // threadId -> { verdict, stampedAt, note }
      const pendingGatesMap = Object.create(null); // threadId -> PendingDecisionGate
      const stampAnimMap = Object.create(null); // nodeId -> startMs
      const shakeMap = Object.create(null); // nodeId -> { startMs, error }
      const flashMap = Object.create(null); // nodeId -> { startMs, color }
      let holdState = null; // { nodeId, decId, startMs, x, y, verdict }
      let lastStatusError = '';
      let lastPendingFetchMs = 0;

      // Mobile 5-lane snapping deck state
      let mobileLaneOffset = 0;
      let mobileLaneTarget = 0;
      let dragState = null; // { kind: 'mobile-deck'|'score-brush', startX, startOffset, moved }

      // Score brushable time window state (in scoreSimSec coordinates)
      let scoreBrush = null; // { startSec, endSec }
      let scoreLastMetrics = null;

      // Kinetic & smart pacing state
      let elapsedMs = 0;
      let lastFrameMs = nowMs();
      let lastRenderMs = 0;
      let lastActivityMs = nowMs();
      let rafId = null;
      let frameCount = 0;
      let staticRedraws = 0;
      let staticDirty = true;
      let staticCanvas = null;
      let staticCtx = null;
      let staticReady = false;
      let staticCacheW = 0;
      let staticCacheH = 0;
      let lastStackStaticSpringX = 0;
      let lastStackStaticSpringY = 0;
      let lastScoreStaticSec = -999;

      const photons = [];
      const chainQueue = [];
      let sseEventCount = 0;
      let bootBurstDone = false;

      // Pre-baked tiny radial glow sprites (zero canvas blur)
      const glowSpriteCache = Object.create(null);

      // Oscilloscope 60s ring buffer + per-service 60-sample real telemetry sparklines
      let scopeScrollSec = 60;
      let lastScopeSampleSec = 60;
      const scopeSamples = [];
      const scopeTicks = [];
      const serviceSparklines = Object.create(null);

      // Stack spring parallax
      let ptrTargetX = 0;
      let ptrTargetY = 0;
      let springX = 0;
      let springY = 0;
      let velX = 0;
      let velY = 0;

      // Score live timeline state
      let scoreSimSec = 0;
      const scoreBeams = [];
      const scoreStampArcs = Object.create(null);

      // Geometry caches
      const flowNodeRects = Object.create(null);
      const flowEdgeGeoms = Object.create(null);
      let stackHitTargets = [];
      let stackCalloutTargets = [];
      let scoreHitTargets = [];
      let lastFlowLayout = null;
      let lastFlowStats = {
        crossings: 0,
        baselineCrossings: 0,
        ribbons: 0,
        occupancyRatio: 0,
        staticRedraws: 0,
        frameCount: 0,
      };

      let rawLastPayload = options.initialData || {};
      let model = normalizePayload(rawLastPayload, stampedMap, pendingGatesMap);

      function publishStats() {
        const stats = {
          crossings: lastFlowStats.crossings,
          baselineCrossings: lastFlowStats.baselineCrossings,
          ribbons: lastFlowStats.ribbons,
          occupancyRatio: Number(lastFlowStats.occupancyRatio.toFixed(4)),
          staticRedraws,
          frameCount,
          viewMode,
          dpr,
          mobileLane: Math.round(mobileLaneTarget),
        };
        if (win && typeof win === 'object') {
          win.__flowDeckStats = stats;
        }
        return stats;
      }

      function markStaticDirty() {
        staticDirty = true;
      }

      function markActivity() {
        lastActivityMs = nowMs();
        ensureRaf();
      }

      function getGlowSprite(colorHex) {
        const key = String(colorHex || '#38bdf8');
        if (glowSpriteCache[key]) return glowSpriteCache[key];
        try {
          let buf = null;
          if (typeof OffscreenCanvas !== 'undefined') {
            buf = new OffscreenCanvas(24, 24);
          } else if (doc && typeof doc.createElement === 'function') {
            buf = doc.createElement('canvas');
            buf.width = 24;
            buf.height = 24;
          }
          if (!buf || typeof buf.getContext !== 'function') return null;
          const gctx = buf.getContext('2d');
          if (!gctx || typeof gctx.createRadialGradient !== 'function') return null;
          const grad = gctx.createRadialGradient(12, 12, 1, 12, 12, 11.5);
          grad.addColorStop(0, hexToRgba(key, 0.72));
          grad.addColorStop(0.42, hexToRgba(key, 0.24));
          grad.addColorStop(1, hexToRgba(key, 0));
          gctx.fillStyle = grad;
          gctx.fillRect(0, 0, 24, 24);
          glowSpriteCache[key] = buf;
          return buf;
        } catch {
          return null;
        }
      }

      function ensureStaticBuffer(pixelW, pixelH) {
        if (staticCanvas && staticCacheW === pixelW && staticCacheH === pixelH && staticCtx) {
          return true;
        }
        try {
          let buf = null;
          if (typeof OffscreenCanvas !== 'undefined') {
            buf = new OffscreenCanvas(pixelW, pixelH);
          } else if (doc && typeof doc.createElement === 'function') {
            buf = doc.createElement('canvas');
            buf.width = pixelW;
            buf.height = pixelH;
          }
          if (!buf || typeof buf.getContext !== 'function') {
            staticCanvas = null;
            staticCtx = null;
            return false;
          }
          const sctx = buf.getContext('2d');
          if (!sctx) {
            staticCanvas = null;
            staticCtx = null;
            return false;
          }
          staticCanvas = buf;
          staticCtx = sctx;
          staticCacheW = pixelW;
          staticCacheH = pixelH;
          staticDirty = true;
          staticReady = false;
          return true;
        } catch {
          staticCanvas = null;
          staticCtx = null;
          return false;
        }
      }

      function recordServiceSparklines(m, isInitial) {
        if (!m || !Array.isArray(m.services)) return;
        for (let i = 0; i < m.services.length; i += 1) {
          const svc = m.services[i];
          if (!serviceSparklines[svc.id]) {
            serviceSparklines[svc.id] = [];
          }
          const buf = serviceSparklines[svc.id];
          if (svc.id === 'hw:local-host' && isInitial && m.hostHistory && m.hostHistory.length >= 2) {
            buf.length = 0;
            const slice = m.hostHistory.slice(-SPARKLINE_MAX);
            for (let k = 0; k < slice.length; k += 1) {
              const hi = slice[k] || {};
              const lr =
                toNum(hi.loadRatio) ??
                (toNum(hi.load1) !== null ? toNum(hi.load1) / Math.max(1, m.host.cpus) : svc.sampleValue);
              buf.push(Math.max(0, lr));
            }
            continue;
          }
          const val = Number.isFinite(svc.sampleValue) ? svc.sampleValue : 0;
          if (buf.length === 0) {
            // Honest initial baseline: flat observed reading until live deltas arrive
            for (let k = 0; k < 12; k += 1) buf.push(val);
          } else {
            buf.push(val);
            if (buf.length > SPARKLINE_MAX) buf.shift();
          }
        }
      }

      function seedScopeHistory(m) {
        scopeSamples.length = 0;
        scopeTicks.length = 0;
        const baseRatio = m.host.loadRatio > 0 ? m.host.loadRatio : 0.45;
        const baseMem = m.host.memAvailableGib > 0 ? m.host.memAvailableGib : 85.4;

        if (m.hostHistory && m.hostHistory.length >= 2) {
          const hist = m.hostHistory.slice(-60);
          const n = hist.length;
          for (let i = 0; i < n; i += 1) {
            const hItem = hist[i] || {};
            const lr =
              toNum(hItem.loadRatio) ??
              (toNum(hItem.load1) !== null ? toNum(hItem.load1) / Math.max(1, m.host.cpus) : baseRatio);
            const mg = toNum(hItem.mem_available_gib) ?? toNum(hItem.memGib) ?? baseMem;
            scopeSamples.push({
              tSec: scopeScrollSec - (n - 1 - i),
              loadRatio: clamp(lr, 0, 3.5),
              memGib: clamp(mg, 1, m.host.memTotalGib),
            });
          }
        } else {
          for (let i = 60; i >= 0; i -= 1) {
            scopeSamples.push({
              tSec: scopeScrollSec - i,
              loadRatio: clamp(baseRatio, 0, 3.5),
              memGib: clamp(baseMem, 1, m.host.memTotalGib),
            });
          }
        }
        lastScopeSampleSec = scopeScrollSec;
      }

      function seedScoreBeams(m) {
        scoreBeams.length = 0;
        const evs = m.recentEvents;
        const count = Math.min(12, Math.max(4, evs.length));
        for (let i = 0; i < count; i += 1) {
          const ev = evs[i];
          const fromAgent = m.agents[i % Math.max(1, m.agents.length)];
          const toRoom =
            m.rooms.find((r) => ev && r.channel === ev.channel) ||
            m.rooms[i % Math.max(1, m.rooms.length)];
          if (!fromAgent || !toRoom) continue;
          scoreBeams.push({
            id: 'sb-' + i,
            timeSec: scoreSimSec - (count - i) * 28 - 8,
            fromId: fromAgent.id,
            toId: toRoom.id,
            brand: fromAgent.brand,
            label: ev ? ev.title : fromAgent.shortLabel + ' -> ' + toRoom.shortLabel,
            drawnAtMs: 0,
          });
        }
      }

      seedScopeHistory(model);
      seedScoreBeams(model);
      recordServiceSparklines(model, true);

      // ======================================================================
      // DOM SCAFFOLD (100% DOM APIs + textContent only)
      // ======================================================================

      const rootEl = doc.createElement('div');
      rootEl.className = 'kbm-root' + (theme === 'light' ? ' is-light' : '');
      rootEl.setAttribute('data-theme', theme);
      rootEl.setAttribute('data-detail', detail);
      rootEl.setAttribute('data-view-mode', viewMode);

      const headerEl = doc.createElement('div');
      headerEl.className = 'kbm-header';

      const headerLeft = doc.createElement('div');
      headerLeft.className = 'kbm-header-left';

      const svcPill = doc.createElement('div');
      svcPill.className = 'kbm-svc-pill';
      const svcDot = doc.createElement('span');
      svcDot.className = 'kbm-svc-dot';
      const svcText = doc.createElement('span');
      svcPill.appendChild(svcDot);
      svcPill.appendChild(svcText);

      const narratorEl = doc.createElement('div');
      narratorEl.className = 'kbm-narrator';

      headerLeft.appendChild(svcPill);
      headerLeft.appendChild(narratorEl);

      const controlsEl = doc.createElement('div');
      controlsEl.className = 'kbm-controls';

      const lensSeg = doc.createElement('div');
      lensSeg.className = 'kbm-seg';
      lensSeg.setAttribute('role', 'tablist');
      lensSeg.setAttribute('aria-label', 'Spatial Mesh Lens');

      const lensDefs = [
        { id: 'flow', label: 'Flow' },
        { id: 'stack', label: 'Stack' },
        { id: 'score', label: 'Score' },
      ];
      const lensButtons = Object.create(null);
      for (let i = 0; i < lensDefs.length; i += 1) {
        const def = lensDefs[i];
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'kbm-btn' + (def.id === viewMode ? ' is-active' : '');
        btn.setAttribute('data-lens', def.id);
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', def.id === viewMode ? 'true' : 'false');
        btn.textContent = def.label;
        lensButtons[def.id] = btn;
        lensSeg.appendChild(btn);
      }

      const expandBtn = doc.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'kbm-btn kbm-expand-btn';
      expandBtn.setAttribute('aria-label', expanded ? 'Dock view' : 'Expand view');
      expandBtn.textContent = expanded ? '↙ Dock' : '↗ Expand';

      controlsEl.appendChild(lensSeg);
      controlsEl.appendChild(expandBtn);

      headerEl.appendChild(headerLeft);
      headerEl.appendChild(controlsEl);

      // Mobile 5-lane snapping indicator strip (<480px Flow Deck)
      const mobileLaneBar = doc.createElement('div');
      mobileLaneBar.className = 'kbm-mobile-lanes';
      mobileLaneBar.setAttribute('role', 'tablist');
      mobileLaneBar.setAttribute('aria-label', 'Flow Deck Lanes');
      const mobileLaneLabels = ['ASKS', 'WORKS', 'LANDS', 'YOU', 'MIND'];
      const mobileLaneBtns = [];
      for (let i = 0; i < mobileLaneLabels.length; i += 1) {
        const lb = doc.createElement('button');
        lb.type = 'button';
        lb.className = 'kbm-lane-pill' + (i < 2 ? ' is-active' : '');
        lb.setAttribute('data-mobile-lane', String(i));
        lb.setAttribute('aria-label', 'Lane ' + (i + 1) + ': ' + mobileLaneLabels[i]);
        const dot = doc.createElement('span');
        dot.className = 'kbm-lane-dot';
        const txt = doc.createElement('span');
        txt.textContent = mobileLaneLabels[i];
        lb.appendChild(dot);
        lb.appendChild(txt);
        mobileLaneBtns.push(lb);
        mobileLaneBar.appendChild(lb);
      }

      const stageWrap = doc.createElement('div');
      stageWrap.className = 'kbm-stage-wrap';

      const canvas = doc.createElement('canvas');
      canvas.className = 'kbm-canvas';
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      canvas.setAttribute('aria-label', 'Kizuki Spatial Flow Deck. Hover to isolate causal chain, hold or Shift+Click decision gate to stamp, or press A, R, D.');
      stageWrap.appendChild(canvas);

      const readoutEl = doc.createElement('div');
      readoutEl.className = 'kbm-readout';
      const readoutMain = doc.createElement('div');
      readoutMain.className = 'kbm-readout-main';
      const readoutDot = doc.createElement('span');
      readoutDot.className = 'kbm-readout-dot';
      const readoutTitle = doc.createElement('span');
      readoutTitle.className = 'kbm-readout-title';
      const readoutDetail = doc.createElement('span');
      readoutDetail.className = 'kbm-readout-detail';
      readoutMain.appendChild(readoutDot);
      readoutMain.appendChild(readoutTitle);
      readoutMain.appendChild(readoutDetail);

      const readoutRight = doc.createElement('span');
      readoutRight.className = 'kbm-readout-right';
      readoutEl.appendChild(readoutMain);
      readoutEl.appendChild(readoutRight);

      rootEl.appendChild(headerEl);
      rootEl.appendChild(mobileLaneBar);
      rootEl.appendChild(stageWrap);
      rootEl.appendChild(readoutEl);

      while (containerEl.firstChild) {
        containerEl.removeChild(containerEl.firstChild);
      }
      containerEl.appendChild(rootEl);

      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

      // ======================================================================
      // PALETTE & COLOR HELPERS
      // ======================================================================

      function pal() {
        return PALETTES[theme] || PALETTES.dark;
      }

      function colorForBrand(brandKey) {
        const p = pal();
        if (brandKey === 'vermilion') return p.vermilion;
        if (brandKey === 'emerald') return p.emerald;
        if (brandKey === 'amber') return p.amber;
        if (brandKey === 'violet') return p.violet;
        if (brandKey === 'teal') return p.teal;
        if (brandKey === 'memBlue') return p.memBlue;
        if (brandKey === 'offline') return p.offline;
        return (p.brands && p.brands[brandKey]) || p.cyan;
      }

      function colorForNode(node) {
        const p = pal();
        if (!node) return p.cyan;
        if (node.kind === 'DECISION') {
          if (node.stamped) {
            if (node.verdict === 'revise') return p.amber;
            if (node.verdict === 'defer') return p.cyan;
            return p.emerald;
          }
          return p.vermilion;
        }
        if (node.kind === 'STORE') return colorForBrand(node.accentKey || 'emerald');
        if (node.kind === 'ROOM') return node.blockedCount > 0 ? p.vermilion : p.cyan;
        return colorForBrand(node.brand || 'bot');
      }

      function loadColor(ratio) {
        const p = pal();
        if (ratio > 1.0) return p.vermilion;
        if (ratio >= 0.7) return p.amber;
        return p.emerald;
      }

      function isMotionEnabled() {
        return detail !== 'off' && !reducedMotion;
      }

      function isDockedLayout() {
        return width < 720;
      }

      function isMobileDeckLayout() {
        return stageW < 480;
      }

      // ======================================================================
      // REAL C1 DECISION GATE HYDRATION & PERSISTENT STAMPING
      // ======================================================================

      async function hydratePendingDecisions(force) {
        if (destroyed || options.disableNetwork === true) return;
        const fetchFn =
          (typeof options.fetchImpl === 'function' && options.fetchImpl) ||
          (win && typeof win.fetch === 'function' && win.fetch.bind(win)) ||
          (typeof fetch === 'function' ? fetch : null);
        if (!fetchFn) return;

        const nowT = Date.now();
        if (!force && nowT - lastPendingFetchMs < 1500) return;
        lastPendingFetchMs = nowT;

        try {
          const res = await fetchFn('/api/decisions/pending', {
            headers: { Accept: 'application/json' },
          });
          if (!res || !res.ok || destroyed) return;
          const data = await res.json();
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data && data.pending)
              ? data.pending
              : Array.isArray(data && data.decisions)
                ? data.decisions
                : Array.isArray(data && data.gates)
                  ? data.gates
                  : [];

          let changed = false;
          for (let i = 0; i < list.length; i += 1) {
            const gate = list[i];
            if (!gate || !gate.threadId) continue;
            const tid = cleanText(gate.threadId);
            pendingGatesMap[tid] = gate;
            if (gate.stamped && typeof gate.stamped === 'object' && gate.stamped.verdict) {
              const prev = stampedMap[tid];
              if (!prev || prev.verdict !== gate.stamped.verdict || prev.stampedAt !== gate.stamped.stampedAt) {
                stampedMap[tid] = {
                  verdict: cleanText(gate.stamped.verdict).toLowerCase(),
                  stampedAt: gate.stamped.stampedAt || new Date().toISOString(),
                  note: gate.stamped.note || '',
                };
                changed = true;
              }
            }
          }

          if (list.length > 0 || changed) {
            model = normalizePayload(rawLastPayload, stampedMap, pendingGatesMap);
            syncHeader();
            syncReadout();
            markStaticDirty();
            computeFlowLayout();
            renderFrame(nowMs());
          }
        } catch {
          // C1 endpoint may be unavailable in offline/mock environments; keep graceful fallback
        }
      }

      async function submitDecisionStamp(dec, verdict, note) {
        if (!dec || destroyed) return { ok: false, error: 'invalid_decision' };
        const p = pal();
        const v = verdict === 'revise' || verdict === 'defer' ? verdict : 'approve';
        const tid = String(dec.decId);
        const prevStamped = dec.stamped;
        const prevVerdict = dec.verdict;
        const prevMapEntry = stampedMap[tid] || null;
        const stampedIso = new Date().toISOString();

        // Optimistic emerald burst immediately
        dec.stamped = true;
        dec.verdict = v;
        dec.stampedAt = stampedIso;
        stampedMap[tid] = { verdict: v, stampedAt: stampedIso, note: note || '', optimistic: true };
        stampAnimMap[dec.id] = nowMs();
        delete shakeMap[dec.id];
        lastStatusError = '';
        scoreStampArcs[dec.id] = { atSec: scoreSimSec, progress: 1, verdict: v };

        const burstCol = v === 'revise' ? p.amber : v === 'defer' ? p.cyan : p.emerald;
        for (let i = 0; i < model.edges.length; i += 1) {
          if (model.edges[i].from === dec.id) {
            spawnPhoton(model.edges[i].id, burstCol, 0);
          }
        }
        scopeTicks.push({ tSec: scopeScrollSec, color: burstCol });
        sseEventCount += 1;

        syncHeader();
        syncReadout();
        markStaticDirty();
        markActivity();
        renderFrame(nowMs());

        if (options.disableNetwork === true) {
          return { ok: true, threadId: tid, verdict: v, localOnly: true };
        }

        const fetchFn =
          (typeof options.fetchImpl === 'function' && options.fetchImpl) ||
          (win && typeof win.fetch === 'function' && win.fetch.bind(win)) ||
          (typeof fetch === 'function' ? fetch : null);

        if (!fetchFn) {
          return { ok: true, threadId: tid, verdict: v, localOnly: true };
        }

        const idempotencyKey = 'mesh:' + tid + ':' + v + ':' + Math.floor(Date.now() / 15000);
        try {
          const res = await fetchFn('/api/decisions/stamp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              threadId: tid,
              verdict: v,
              note: note || undefined,
              idempotencyKey,
            }),
          });

          let body = null;
          try {
            body = res ? await res.json() : null;
          } catch {
            body = null;
          }

          if (!res || !res.ok || (body && body.ok === false)) {
            const errMsg = (body && (body.error || body.message)) || ('HTTP ' + (res ? res.status : 0));
            throw new Error(errMsg);
          }

          if (destroyed) return { ok: true, threadId: tid, verdict: v };
          stampedMap[tid] = {
            verdict: (body && body.verdict) || v,
            stampedAt: (body && body.stampedAt) || stampedIso,
            note: note || '',
            optimistic: false,
          };
          dec.stamped = true;
          dec.verdict = stampedMap[tid].verdict;
          dec.stampedAt = stampedMap[tid].stampedAt;

          if (win && typeof win.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            try {
              win.dispatchEvent(
                new CustomEvent('kizuki:decision-stamped', {
                  detail: { threadId: tid, verdict: dec.verdict, response: body },
                })
              );
            } catch {
              // ignore
            }
          }
          syncHeader();
          syncReadout();
          markStaticDirty();
          renderFrame(nowMs());
          return body || { ok: true, threadId: tid, verdict: dec.verdict };
        } catch (err) {
          if (destroyed) return { ok: false, error: String(err && err.message ? err.message : err) };
          // Rollback optimistic state + trigger horizontal shake
          dec.stamped = prevStamped;
          dec.verdict = prevVerdict;
          if (prevMapEntry) stampedMap[tid] = prevMapEntry;
          else delete stampedMap[tid];
          delete scoreStampArcs[dec.id];

          const errText = cleanText(err && err.message ? err.message : 'Stamp failed');
          shakeMap[dec.id] = { startMs: nowMs(), error: errText };
          lastStatusError = 'Stamp failed (' + errText + ')';

          syncHeader();
          syncReadout();
          markStaticDirty();
          markActivity();
          renderFrame(nowMs());
          return { ok: false, error: errText };
        }
      }

      // ======================================================================
      // HEADER, MOBILE LANE DOTS & READOUT SYNCHRONIZATION
      // ======================================================================

      function syncMobileLaneBar() {
        const show = viewMode === 'flow' && isMobileDeckLayout();
        if (show) mobileLaneBar.classList.add('is-shown');
        else mobileLaneBar.classList.remove('is-shown');
        const activeStart = clamp(Math.round(mobileLaneTarget), 0, 3);
        for (let i = 0; i < mobileLaneBtns.length; i += 1) {
          const isVis = i === activeStart || i === activeStart + 1;
          mobileLaneBtns[i].classList.toggle('is-active', isVis);
          mobileLaneBtns[i].setAttribute('aria-selected', isVis ? 'true' : 'false');
        }
      }

      function syncHeader() {
        const compact = width < 560;
        if (compact) rootEl.classList.add('is-compact');
        else rootEl.classList.remove('is-compact');

        svcText.textContent = model.statusBadge;
        svcDot.className =
          'kbm-svc-dot' +
          (model.servicesOnline === model.servicesTotal
            ? ''
            : model.servicesOnline >= 3
              ? ' is-warn'
              : ' is-down');

        const latestSample = scopeSamples.length > 0 ? scopeSamples[scopeSamples.length - 1] : null;
        const liveRatio = latestSample ? latestSample.loadRatio : model.host.loadRatio;
        const openDecs = model.decisions.filter((d) => !d.stamped).length;
        const waitDisplay = Math.max(openDecs, model.totalWaitingDecisions);
        const activeDisp = Math.max(model.activeAgentsCount, 0);

        narratorEl.textContent = compact
          ? activeDisp + ' act · ' + waitDisplay + ' wait · ' + liveRatio.toFixed(2) + 'x'
          : activeDisp +
            ' agents active · ' +
            waitDisplay +
            ' waiting · G4 :8003 ' +
            (model.synthReady ? 'online' : 'standby') +
            ' · ' +
            liveRatio.toFixed(2) +
            'x';

        expandBtn.textContent = expanded ? '↙ Dock' : '↗ Expand';
        expandBtn.setAttribute('aria-label', expanded ? 'Dock spatial mesh' : 'Expand spatial mesh');

        for (let i = 0; i < lensDefs.length; i += 1) {
          const id = lensDefs[i].id;
          const btn = lensButtons[id];
          if (!btn) continue;
          const active = id === viewMode;
          if (active) btn.classList.add('is-active');
          else btn.classList.remove('is-active');
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        }

        syncMobileLaneBar();
      }

      function syncReadout() {
        const p = pal();
        if (lastStatusError) {
          readoutDot.style.background = p.vermilion;
          readoutTitle.textContent = 'GATE ERROR';
          readoutDetail.textContent = lastStatusError;
          readoutRight.textContent = 'reverted';
          return;
        }

        if (viewMode === 'score' && scoreBrush) {
          const tMin = Math.min(scoreBrush.startSec, scoreBrush.endSec);
          const tMax = Math.max(scoreBrush.startSec, scoreBrush.endSec);
          const spanS = Math.max(1, Math.round(tMax - tMin));
          const inWindow = scoreBeams.filter((b) => b.timeSec >= tMin && b.timeSec <= tMax).length;
          readoutDot.style.background = p.cyan;
          readoutTitle.textContent = 'WINDOW ' + spanS + 's';
          readoutDetail.textContent = inWindow + ' events in brushed slice · Double-click to clear brush';
          readoutRight.textContent = 'BRUSHED';
          return;
        }

        const focusId = hoveredId || selectedId;
        const node = focusId ? model.nodeById[focusId] : null;

        if (node) {
          readoutDot.style.background = colorForNode(node);
          readoutTitle.textContent = node.kind + ' ' + node.shortLabel;
          if (node.kind === 'DECISION') {
            readoutDetail.textContent =
              (node.stamped
                ? String(node.verdict || 'approved').toUpperCase() + ' · '
                : formatAgeMs(node.ageMs) + ' waiting · ') + node.fullText;
            readoutRight.textContent = node.stamped
              ? 'persisted via C1'
              : 'hold 350ms / Shift+Click / A·R·D';
          } else if (node.kind === 'AGENT') {
            readoutDetail.textContent =
              node.label +
              ' · ' +
              node.metric +
              ' · ' +
              (node.recentChannels.slice(0, 2).map((ch) => compactRoomLabel(ch, 18)).join(', ') || node.brand);
            readoutRight.textContent = selectedId === node.id ? 'pinned · click to clear' : 'click to pin & filter';
          } else if (node.kind === 'ROOM') {
            readoutDetail.textContent =
              compactRoomLabel(node.channel, 28) +
              ' · ' +
              node.signalCount +
              ' sig · ' +
              (node.blockedCount > 0 ? node.blockedCount + ' blk' : 'clear');
            readoutRight.textContent = selectedId === node.id ? 'pinned · click room' : 'click to open room';
          } else if (node.kind === 'STORE') {
            readoutDetail.textContent = node.label + ' · ' + node.metric + ' · ' + node.sub;
            readoutRight.textContent = 'mind store';
          } else {
            readoutDetail.textContent = node.label + ' · ' + (node.sub || '');
            readoutRight.textContent = node.kind.toLowerCase();
          }
          return;
        }

        if (focusId && focusId.startsWith('hw:')) {
          const svc = model.services.find((s) => s.id === focusId);
          if (svc) {
            readoutDot.style.background =
              svc.status === 'ok' ? p.emerald : svc.status === 'warn' ? p.amber : p.vermilion;
            readoutTitle.textContent = 'HW ' + svc.name;
            const buf = serviceSparklines[svc.id] || [];
            readoutDetail.textContent =
              (svc.online ? 'ONLINE' : 'OFFLINE') + ' · ' + svc.stat + ' · ' + buf.length + ' samples';
            readoutRight.textContent = model.host.hostname;
            return;
          }
        }
        if (focusId && focusId.startsWith('seat:')) {
          const seat = model.seats.find((s) => s.id === focusId);
          if (seat) {
            readoutDot.style.background =
              !seat.eligible || seat.headroomPct <= 15
                ? p.vermilion
                : seat.headroomPct < 50
                  ? p.amber
                  : p.emerald;
            readoutTitle.textContent = 'SEAT ' + seat.label;
            readoutDetail.textContent =
              seat.headroomPct + '% headroom · ' + (seat.model || seat.reason || seat.harness);
            readoutRight.textContent = seat.eligible ? 'eligible' : 'blocked';
            return;
          }
        }

        readoutDot.style.background = isMotionEnabled() ? p.emerald : p.ink3;
        const lensLabel = viewMode === 'flow' ? 'FLOW DECK' : viewMode === 'stack' ? '3-DECK STACK' : 'LIVE SCORE';
        readoutTitle.textContent = lensLabel;
        readoutDetail.textContent =
          viewMode === 'flow'
            ? 'Hover to isolate full chain · Click to pin · Hold 350ms or A/R/D on gate to stamp'
            : viewMode === 'stack'
              ? 'D3 Mind Stores · D2 Agents & Decisions · D1 Hardware & Seats · Pointer parallax'
              : 'Live telemetry tape · 82% NOW-line · Drag tape to brush window';
        readoutRight.textContent = isMotionEnabled() ? 'SSE ' + sseEventCount : 'STATIC';
      }

      // ======================================================================
      // FULL END-TO-END CAUSAL CHAIN ISOLATION (UPSTREAM + DOWNSTREAM DAG)
      // ======================================================================

      function getIncidentSets(focusId) {
        if (!focusId || !model.nodeById[focusId]) return null;
        const nodes = Object.create(null);
        const edgeSet = Object.create(null);
        nodes[focusId] = true;

        // Upstream BFS (toward Col 0)
        const upQueue = [focusId];
        const upSeen = Object.create(null);
        upSeen[focusId] = true;
        while (upQueue.length > 0) {
          const cur = upQueue.shift();
          for (let i = 0; i < model.edges.length; i += 1) {
            const e = model.edges[i];
            if (e.to === cur) {
              edgeSet[e.id] = true;
              nodes[e.from] = true;
              if (!upSeen[e.from]) {
                upSeen[e.from] = true;
                upQueue.push(e.from);
              }
            }
          }
        }

        // Downstream BFS (toward Col 4)
        const downQueue = [focusId];
        const downSeen = Object.create(null);
        downSeen[focusId] = true;
        while (downQueue.length > 0) {
          const cur = downQueue.shift();
          for (let i = 0; i < model.edges.length; i += 1) {
            const e = model.edges[i];
            if (e.from === cur) {
              edgeSet[e.id] = true;
              nodes[e.to] = true;
              if (!downSeen[e.to]) {
                downSeen[e.to] = true;
                downQueue.push(e.to);
              }
            }
          }
        }

        return { nodes, edges: edgeSet };
      }

      // ======================================================================
      // LENS 1: FLOW DECK LANE-FILL SOLVER + SANKEY RIBBON GEOMETRY
      // ======================================================================

      function computeFlowLayout() {
        for (const k in flowNodeRects) delete flowNodeRects[k];
        for (const k in flowEdgeGeoms) delete flowEdgeGeoms[k];

        const docked = isDockedLayout();
        const mobileDeck = isMobileDeckLayout();
        const padX = mobileDeck ? 8 : docked ? 6 : 14;
        const padTop = docked ? 6 : 10;
        const bottomBandH = clamp(
          Math.round(stageH * (docked ? 0.27 : 0.24)),
          docked ? 76 : 114,
          docked ? 100 : 196
        );
        const colHeaderH = docked ? 16 : 18;
        const headerGap = docked ? 8 : 14; // Pinned 14-16px above first row in expanded!
        const flowAreaH = Math.max(116, stageH - bottomBandH - padTop - 6);
        const nodesTop = padTop + colHeaderH + headerGap;
        const nodesH = Math.max(84, flowAreaH - colHeaderH - headerGap - (docked ? 6 : 10));

        const activeCols = [0, 1, 2, 3, 4];
        const allColTitles = docked
          ? ['ASKS', 'WORKS', 'LANDS', 'NEEDS YOU', 'BECOMES']
          : ['WHO ASKS', 'WHO WORKS', 'WHERE IT LANDS', 'WHAT NEEDS YOU', 'WHAT IT BECOMES'];

        const colBoxes = [];
        let gutterW;
        let scrollOffsetPx = 0;
        let mobileStride = 0;

        if (mobileDeck) {
          // 5-lane horizontally snapping deck: 2 visible lanes + crisp edge peek
          gutterW = 14;
          const colW = Math.max(118, Math.floor((stageW - padX * 2 - gutterW * 1.45) / 2.22));
          mobileStride = colW + gutterW;
          scrollOffsetPx = clamp(mobileLaneOffset, 0, 3) * mobileStride;
          for (let c = 0; c < 5; c += 1) {
            colBoxes.push({
              col: c,
              x: padX + c * mobileStride - scrollOffsetPx,
              y: padTop,
              w: colW,
              h: flowAreaH,
              title: allColTitles[c],
            });
          }
        } else {
          const colWeights = docked
            ? [0.14, 0.22, 0.23, 0.25, 0.16]
            : [0.145, 0.205, 0.23, 0.235, 0.185];
          gutterW = docked
            ? clamp(Math.floor(stageW * 0.03), 12, 22)
            : clamp(Math.floor(stageW * 0.044), 26, 54);
          const usableW = Math.max(220, stageW - padX * 2 - gutterW * 4);
          let curX = padX;
          for (let c = 0; c < 5; c += 1) {
            const cw = Math.floor(usableW * colWeights[c]);
            colBoxes.push({
              col: c,
              x: curX,
              y: padTop,
              w: cw,
              h: flowAreaH,
              title: allColTitles[c],
            });
            curX += cw + gutterW;
          }
        }

        // Dynamic visible slice counts based on available vertical stage height
        const gap = docked ? 4 : 8;
        const maxRowsInExpanded = Math.max(4, Math.min(8, Math.floor((nodesH + gap) / (58 + gap))));
        const rawColLists = [
          model.askers.slice(0, 3),
          model.agents.slice(0, docked ? 5 : maxRowsInExpanded),
          model.rooms.slice(0, docked ? 5 : maxRowsInExpanded),
          model.decisions.slice(0, docked ? 3 : Math.min(6, maxRowsInExpanded)),
          model.stores.slice(0, docked ? 4 : 5),
        ];

        // Barycenter crossing minimizer across columns 1 <-> 2 <-> 3 (and 4)
        const ordered = minimizeFlowCrossings(rawColLists, model.edges);
        const colLists = ordered.colLists;
        const activeEdges = ordered.activeEdges;

        // Lane-fill solver: pin top directly below header (14-16px), fill nodesH cleanly
        let lowestCardBottom = nodesTop;
        let highestHeaderTop = padTop;

        for (let idx = 0; idx < colBoxes.length; idx += 1) {
          const box = colBoxes[idx];
          const c = box.col;
          const list = colLists[c];
          const count = list.length;
          box.totalCount = c === 0
            ? model.askers.length
            : c === 1
              ? model.agents.length
              : c === 2
                ? model.rooms.length
                : c === 3
                  ? model.decisions.length
                  : model.stores.length;
          box.visibleCount = count;
          if (count === 0) continue;

          // Core lane-fill formula: clamp((nodesH - gap*(n-1)) / n, 44, 88) in expanded
          // Allow graceful upper expansion on ultra-tall canvases (>760px nodesH) so >=85% stage occupancy holds
          const rawFitH = Math.floor((nodesH - gap * Math.max(0, count - 1)) / count);
          let chipH;
          if (docked) {
            chipH = clamp(rawFitH, c === 3 ? 32 : 22, c === 3 ? 52 : 38);
          } else {
            const expandedCap = nodesH > 620 ? Math.min(132, Math.max(88, Math.floor((nodesH - gap * 4) / 5))) : 88;
            chipH = clamp(rawFitH, 44, expandedCap);
          }

          const startY = nodesTop;
          for (let i = 0; i < count; i += 1) {
            const node = list[i];
            const y = startY + i * (chipH + gap);
            if (y + chipH > lowestCardBottom) lowestCardBottom = y + chipH;
            flowNodeRects[node.id] = {
              x: box.x,
              y,
              w: box.w,
              h: chipH,
              col: c,
              node,
            };
          }
        }

        // Compute Sankey-true ribbon geometry with 2px gutters and sorted port offsets
        const outGroups = Object.create(null);
        const inGroups = Object.create(null);
        const edgeWidths = Object.create(null);

        for (let i = 0; i < activeEdges.length; i += 1) {
          const e = activeEdges[i];
          if (!flowNodeRects[e.from] || !flowNodeRects[e.to]) continue;
          if (!outGroups[e.from]) outGroups[e.from] = [];
          if (!inGroups[e.to]) inGroups[e.to] = [];
          outGroups[e.from].push(e);
          inGroups[e.to].push(e);
          const rawW = clamp(1.5 + 1.55 * Math.log2(1 + (e.volume || 1)), 1.5, 8.5);
          edgeWidths[e.id] = docked ? clamp(rawW * 0.65, 1.2, 4.6) : rawW;
        }

        // Sort ports by opposite node's vertical center so ribbons never twist at node face
        for (const fromId in outGroups) {
          outGroups[fromId].sort((a, b) => {
            const ra = flowNodeRects[a.to];
            const rb = flowNodeRects[b.to];
            return (ra.y + ra.h * 0.5) - (rb.y + rb.h * 0.5);
          });
        }
        for (const toId in inGroups) {
          inGroups[toId].sort((a, b) => {
            const ra = flowNodeRects[a.from];
            const rb = flowNodeRects[b.from];
            return (ra.y + ra.h * 0.5) - (rb.y + rb.h * 0.5);
          });
        }

        const portOutY = Object.create(null);
        const portInY = Object.create(null);
        const ribbonGutter = 2;

        function allocatePorts(groups, rectMap, outMap) {
          for (const nodeId in groups) {
            const list = groups[nodeId];
            const r = rectMap[nodeId];
            if (!r || list.length === 0) continue;
            const availH = Math.max(8, r.h - 10);
            let totalH = 0;
            for (let i = 0; i < list.length; i += 1) {
              totalH += edgeWidths[list[i].id];
            }
            totalH += ribbonGutter * Math.max(0, list.length - 1);
            const scale = totalH > availH ? availH / totalH : 1;
            const usedH = totalH * scale;
            let cursorY = r.y + (r.h - usedH) * 0.5;
            for (let i = 0; i < list.length; i += 1) {
              const e = list[i];
              const wScaled = edgeWidths[e.id] * scale;
              outMap[e.id] = cursorY + wScaled * 0.5;
              cursorY += wScaled + ribbonGutter * scale;
            }
          }
        }

        allocatePorts(outGroups, flowNodeRects, portOutY);
        allocatePorts(inGroups, flowNodeRects, portInY);

        for (let i = 0; i < activeEdges.length; i += 1) {
          const e = activeEdges[i];
          const sr = flowNodeRects[e.from];
          const dr = flowNodeRects[e.to];
          if (!sr || !dr) continue;

          const x1 = sr.x + sr.w;
          const y1 = portOutY[e.id] !== undefined ? portOutY[e.id] : sr.y + sr.h * 0.5;
          const x2 = dr.x;
          const y2 = portInY[e.id] !== undefined ? portInY[e.id] : dr.y + dr.h * 0.5;
          const g = Math.max(10, x2 - x1);

          const p0 = { x: x1, y: y1 };
          const p1 = { x: x1 + g * 0.46, y: y1 };
          const p2 = { x: x2 - g * 0.46, y: y2 };
          const p3 = { x: x2, y: y2 };
          const ribbonW = edgeWidths[e.id] || 2;

          const steps = 28;
          const lut = [];
          let accD = 0;
          let prev = p0;
          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps;
            const pt = evalCubic(p0, p1, p2, p3, t);
            if (s > 0) accD += Math.hypot(pt.x - prev.x, pt.y - prev.y);
            const tan = evalCubicTangent(p0, p1, p2, p3, t);
            lut.push({ x: pt.x, y: pt.y, d: accD, angle: Math.atan2(tan.dy, tan.dx) });
            prev = pt;
          }

          flowEdgeGeoms[e.id] = {
            edge: e,
            p0,
            p1,
            p2,
            p3,
            width: ribbonW,
            length: Math.max(1, accD),
            lut,
            dashSpeed: clamp(14 + Math.log2(1 + e.volume) * 5.2, 14, 42),
          };
        }

        // Compute vertical stage occupancy ratio (header + cards + bottom deck) / stageH
        const coveredVertical =
          Math.max(0, Math.min(stageH - bottomBandH, lowestCardBottom) - highestHeaderTop) + bottomBandH;
        const occupancyRatio = clamp(coveredVertical / Math.max(1, stageH), 0, 1);

        lastFlowStats = {
          crossings: ordered.crossings,
          baselineCrossings: ordered.baselineCrossings,
          ribbons: activeEdges.length,
          occupancyRatio,
          staticRedraws,
          frameCount,
        };
        publishStats();

        return {
          colBoxes,
          bottomY: stageH - bottomBandH,
          bottomH: bottomBandH,
          padX,
          docked,
          mobileDeck,
          mobileStride,
        };
      }

      // ======================================================================
      // FLOW DECK STATIC LAYER (RASTERIZED INTO OFFSCREEN CACHE)
      // ======================================================================

      function drawFlowStatic(sctx, layout) {
        const p = pal();
        const { colBoxes, bottomY, bottomH, padX, docked, mobileDeck } = layout;

        // Plane 0/1 Backdrop + architectural dot grid
        sctx.fillStyle = p.p1;
        sctx.fillRect(0, 0, stageW, stageH);

        sctx.fillStyle = p.dotGrid;
        const dotStep = 18;
        for (let y = 10; y < bottomY; y += dotStep) {
          for (let x = 10; x < stageW; x += dotStep) {
            sctx.fillRect(x, y, 1, 1);
          }
        }

        const focusId = hoveredId || selectedId;
        const incident = focusId ? getIncidentSets(focusId) : null;

        // Clip Flow lanes area cleanly (prevents mobile off-screen lane bleed)
        sctx.save();
        sctx.beginPath();
        sctx.rect(0, 0, stageW, bottomY);
        sctx.clip();

        // Subtle machined lane trays + pinned lane headers (14px above row 1)
        for (let c = 0; c < colBoxes.length; c += 1) {
          const cb = colBoxes[c];
          if (cb.x + cb.w < -16 || cb.x > stageW + 16) continue;

          // Subtle recessed lane chassis
          roundRectPath(sctx, cb.x - 3, cb.y - 2, cb.w + 6, cb.h + 2, 6);
          sctx.fillStyle = hexToRgba(p.tray, p.dark ? 0.56 : 0.65);
          sctx.fill();
          sctx.strokeStyle = hexToRgba(p.ink4, p.dark ? 0.18 : 0.12);
          sctx.lineWidth = 0.75;
          sctx.stroke();

          // Pinned lane header
          sctx.font = '600 ' + (docked ? '9' : '10') + 'px ' + FONT_MONO;
          sctx.fillStyle = p.ink3;
          sctx.textAlign = 'left';
          sctx.textBaseline = 'alphabetic';
          sctx.fillText(fitText(sctx, cb.title, cb.w - (docked ? 22 : 34)), cb.x + 3, cb.y + (docked ? 11 : 12.5));

          // Lane item count badge on right of header
          const countLabel =
            cb.totalCount > cb.visibleCount
              ? cb.visibleCount + '/' + cb.totalCount
              : String(cb.visibleCount);
          sctx.font = '500 ' + (docked ? '8.5' : '9.5') + 'px ' + FONT_MONO;
          sctx.fillStyle = p.ink4;
          sctx.textAlign = 'right';
          sctx.fillText(countLabel, cb.x + cb.w - 3, cb.y + (docked ? 11 : 12.5));

          sctx.strokeStyle = p.hairline;
          sctx.lineWidth = 1;
          sctx.beginPath();
          sctx.moveTo(cb.x, cb.y + (docked ? 14.5 : 17.5));
          sctx.lineTo(cb.x + cb.w, cb.y + (docked ? 14.5 : 17.5));
          sctx.stroke();
        }

        // L1: 4-Pass Aerospace Optical-Bus Conduits (Trench + Glass Conduit/Cladding + Waveguide/Ticks/Twin-Chevrons + Telemetry Badges)
        const craftOn = detail !== 'off';

        function formatConduitTelemetry(edge, srcNode, dstNode) {
          if (edge.kind === 'decision' && dstNode && dstNode.kind === 'DECISION') {
            if (dstNode.stamped) return String(dstNode.verdict || 'OK').toUpperCase();
            return Math.max(1, dstNode.blockedCount || 1) + ' blk';
          }
          if (edge.kind === 'resolve' && srcNode && srcNode.kind === 'DECISION') {
            if (!srcNode.stamped) return Math.max(1, srcNode.blockedCount || 1) + ' blk';
            return Math.max(1, Math.round(edge.volume || 1)) + ' ev';
          }
          if (edge.kind === 'work' && dstNode && dstNode.blockedCount > 0) {
            return dstNode.blockedCount + ' blk';
          }
          if ((edge.kind === 'ask' || edge.kind === 'dispatch') && dstNode && dstNode.active && (edge.volume || 1) <= 2) {
            return 'LIVE';
          }
          return Math.max(1, Math.round(edge.volume || 1)) + ' ev';
        }

        // Pre-plan up to 4 mid-conduit telemetry cutout badges on focused incident edges (non-overlapping)
        const telemetryBadges = [];
        const badgeDistByEdge = Object.create(null);
        if (craftOn && !docked && incident) {
          const badgeCandidates = [];
          for (const edgeId in flowEdgeGeoms) {
            if (!incident.edges[edgeId]) continue;
            const geom = flowEdgeGeoms[edgeId];
            if (!geom || geom.length < 64) continue;
            const direct = geom.edge.from === focusId || geom.edge.to === focusId ? 1 : 0;
            badgeCandidates.push({ edgeId, geom, direct, vol: geom.edge.volume || 1 });
          }
          badgeCandidates.sort((a, b) => b.direct - a.direct || b.vol - a.vol || b.geom.length - a.geom.length);

          sctx.save();
          sctx.font = '600 8.5px ' + FONT_MONO;
          const bh = 13;
          const ratios = [0.5, 0.42, 0.58];
          for (let i = 0; i < badgeCandidates.length && telemetryBadges.length < 4; i += 1) {
            const cand = badgeCandidates[i];
            const geom = cand.geom;
            const srcNode = model.nodeById[geom.edge.from];
            const dstNode = model.nodeById[geom.edge.to];
            const text = formatConduitTelemetry(geom.edge, srcNode, dstNode);
            const tw = typeof sctx.measureText === 'function' ? sctx.measureText(text).width : text.length * 5.2;
            const bw = Math.ceil(tw + 10);
            const accentCol =
              geom.edge.kind === 'decision' || (dstNode && dstNode.blockedCount > 0 && text.endsWith('blk'))
                ? colorForNode(dstNode)
                : colorForNode(srcNode);

            let chosen = null;
            for (let ri = 0; ri < ratios.length; ri += 1) {
              const dist = geom.length * ratios[ri];
              const pt = sampleArcLengthPoint(geom, dist);
              const bx = clamp(pt.x, bw * 0.5 + 4, stageW - bw * 0.5 - 4);
              const by = clamp(pt.y, bh * 0.5 + 4, bottomY - bh * 0.5 - 4);
              const x0 = bx - bw * 0.5;
              const y0 = by - bh * 0.5;

              let collides = false;
              for (let j = 0; j < telemetryBadges.length; j += 1) {
                const o = telemetryBadges[j];
                if (x0 < o.x0 + o.bw + 4 && x0 + bw + 4 > o.x0 && y0 < o.y0 + o.bh + 3 && y0 + bh + 3 > o.y0) {
                  collides = true;
                  break;
                }
              }
              if (!collides) {
                for (const nid in flowNodeRects) {
                  const nr = flowNodeRects[nid];
                  if (x0 < nr.x + nr.w + 3 && x0 + bw + 3 > nr.x && y0 < nr.y + nr.h + 2 && y0 + bh + 2 > nr.y) {
                    collides = true;
                    break;
                  }
                }
              }
              if (!collides) {
                chosen = { edgeId: cand.edgeId, dist, bx, by, x0, y0, bw, bh, text, accentCol };
                break;
              }
            }
            if (chosen) {
              telemetryBadges.push(chosen);
              badgeDistByEdge[cand.edgeId] = chosen.dist;
            }
          }
          sctx.restore();
        }

        for (const edgeId in flowEdgeGeoms) {
          const geom = flowEdgeGeoms[edgeId];
          const srcNode = model.nodeById[geom.edge.from];
          const dstNode = model.nodeById[geom.edge.to];
          const srcColor = colorForNode(srcNode);
          const dstColor = colorForNode(dstNode);
          const isInc = incident ? Boolean(incident.edges[edgeId]) : false;

          let conduitAlpha = p.dark ? 0.28 : 0.30;
          let coreAlpha = p.dark ? 0.58 : 0.54;
          if (incident) {
            conduitAlpha = isInc ? 0.78 : 0.11 * (p.dark ? 0.28 : 0.30);
            coreAlpha = isInc ? 0.96 : 0.05;
          } else if (layer === 'infra') {
            conduitAlpha *= 0.45;
            coreAlpha *= 0.45;
          }

          // Pass (a): Recessed dark crossing trench (+2.6px wider in p.p1) for crisp physical over/under depth
          if (!incident || isInc) {
            sctx.save();
            sctx.beginPath();
            sctx.moveTo(geom.p0.x, geom.p0.y);
            sctx.bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y);
            sctx.strokeStyle = hexToRgba(p.p1, p.dark ? 0.90 : 0.86);
            sctx.lineWidth = geom.width + 2.6;
            sctx.lineCap = 'butt';
            sctx.stroke();
            sctx.restore();
          }

          // Pass (b): Translucent volume-scaled glass conduit + dual-rail hairline optical cladding
          let grad = hexToRgba(srcColor, conduitAlpha);
          if (typeof sctx.createLinearGradient === 'function') {
            const gObj = sctx.createLinearGradient(geom.p0.x, geom.p0.y, geom.p3.x, geom.p3.y);
            gObj.addColorStop(0, hexToRgba(srcColor, conduitAlpha));
            gObj.addColorStop(1, hexToRgba(dstColor, conduitAlpha * 0.84));
            grad = gObj;
          }

          sctx.save();
          sctx.beginPath();
          sctx.moveTo(geom.p0.x, geom.p0.y);
          sctx.bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y);
          sctx.strokeStyle = grad;
          sctx.lineWidth = geom.width;
          sctx.lineCap = 'butt';
          sctx.stroke();

          // Dual-rail hairline optical cladding (+0.55px outer glass edge lines along upper/lower normals)
          if (craftOn && (!docked || isInc) && (!incident || isInc) && geom.lut && geom.lut.length >= 2) {
            const railOff = geom.width * 0.5 + 0.55;
            const lut = geom.lut;
            const railLW = isInc ? 0.8 : 0.6;

            // Upper optical cladding rail (crisp specular glass edge)
            sctx.beginPath();
            for (let li = 0; li < lut.length; li += 1) {
              const lp = lut[li];
              const rx = lp.x + Math.sin(lp.angle) * railOff;
              const ry = lp.y - Math.cos(lp.angle) * railOff;
              if (li === 0) sctx.moveTo(rx, ry);
              else sctx.lineTo(rx, ry);
            }
            sctx.strokeStyle = p.dark
              ? isInc
                ? 'rgba(255,255,255,0.46)'
                : 'rgba(255,255,255,0.18)'
              : hexToRgba(srcColor, isInc ? 0.72 : 0.34);
            sctx.lineWidth = railLW;
            sctx.lineCap = 'butt';
            sctx.stroke();

            // Lower optical cladding rail (chromatic glass rim)
            sctx.beginPath();
            for (let li = 0; li < lut.length; li += 1) {
              const lp = lut[li];
              const rx = lp.x - Math.sin(lp.angle) * railOff;
              const ry = lp.y + Math.cos(lp.angle) * railOff;
              if (li === 0) sctx.moveTo(rx, ry);
              else sctx.lineTo(rx, ry);
            }
            sctx.strokeStyle = hexToRgba(
              dstColor,
              isInc ? (p.dark ? 0.70 : 0.62) : p.dark ? 0.28 : 0.26
            );
            sctx.lineWidth = railLW;
            sctx.lineCap = 'butt';
            sctx.stroke();
          }
          sctx.restore();

          // Pass (c): Inner luminous waveguide filament + calibrated distance ticks + twin-chevron arrival head
          if (craftOn && (!incident || isInc)) {
            let coreGrad = hexToRgba(srcColor, coreAlpha);
            if (typeof sctx.createLinearGradient === 'function') {
              const cObj = sctx.createLinearGradient(geom.p0.x, geom.p0.y, geom.p3.x, geom.p3.y);
              cObj.addColorStop(0, hexToRgba(srcColor, coreAlpha));
              cObj.addColorStop(
                0.55,
                p.dark
                  ? 'rgba(255,255,255,' + (isInc ? '0.72' : '0.34') + ')'
                  : hexToRgba(srcColor, coreAlpha * 0.95)
              );
              cObj.addColorStop(1, hexToRgba(dstColor, coreAlpha));
              coreGrad = cObj;
            }
            sctx.save();
            sctx.beginPath();
            sctx.moveTo(geom.p0.x, geom.p0.y);
            sctx.bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y);
            sctx.strokeStyle = coreGrad;
            sctx.lineWidth = isInc ? 1.15 : 0.85;
            sctx.lineCap = 'butt';
            sctx.stroke();

            // Calibrated distance tick notches (3px perpendicular micro-marks every ~38px on focused/incident conduits)
            if (!docked && isInc && geom.length >= 48) {
              const skipDist = badgeDistByEdge[edgeId];
              sctx.beginPath();
              for (let d = 26; d <= geom.length - 20; d += 38) {
                if (skipDist !== undefined && Math.abs(d - skipDist) < 22) continue;
                const tp = sampleArcLengthPoint(geom, d);
                const nx = -Math.sin(tp.angle) * 1.5;
                const ny = Math.cos(tp.angle) * 1.5;
                sctx.moveTo(tp.x - nx, tp.y - ny);
                sctx.lineTo(tp.x + nx, tp.y + ny);
              }
              sctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.62)' : hexToRgba(srcColor, 0.74);
              sctx.lineWidth = 0.85;
              sctx.lineCap = 'butt';
              sctx.stroke();
            }

            // Sharp twin-chevron directional arrival head right before the target socket
            if (geom.length >= 14) {
              const leadDist = Math.max(4, geom.length - (docked ? 6.5 : 9.5));
              const cLen = docked ? 3.0 : 4.2;
              const cSpread = docked ? 1.85 : 2.55;

              const drawArrivalChevron = (distPos, scale, alphaVal, lw) => {
                const pt = sampleArcLengthPoint(geom, distPos);
                sctx.save();
                sctx.translate(pt.x, pt.y);
                sctx.rotate(pt.angle);
                sctx.beginPath();
                sctx.moveTo(-cLen * scale, -cSpread * scale);
                sctx.lineTo(0.6 * scale, 0);
                sctx.lineTo(-cLen * scale, cSpread * scale);
                sctx.strokeStyle = hexToRgba(dstColor, alphaVal);
                sctx.lineWidth = lw;
                sctx.lineCap = 'round';
                sctx.lineJoin = 'round';
                sctx.stroke();
                sctx.restore();
              };

              drawArrivalChevron(
                leadDist,
                1.0,
                isInc ? 0.96 : p.dark ? 0.72 : 0.64,
                isInc ? 1.3 : 1.0
              );

              if (geom.length >= 22 && (!docked || isInc)) {
                const trailDist = Math.max(2, leadDist - (docked ? 3.0 : 4.2));
                drawArrivalChevron(
                  trailDist,
                  0.82,
                  isInc ? 0.68 : p.dark ? 0.42 : 0.36,
                  isInc ? 1.0 : 0.8
                );
              }
            }
            sctx.restore();
          }
        }

        // Pass (d): Mid-Conduit Telemetry Cutout Badges (top 4 focused incident conduits when !docked)
        if (telemetryBadges.length > 0) {
          sctx.save();
          sctx.font = '600 8.5px ' + FONT_MONO;
          sctx.textAlign = 'center';
          sctx.textBaseline = 'middle';
          for (let i = 0; i < telemetryBadges.length; i += 1) {
            const b = telemetryBadges[i];
            roundRectPath(sctx, b.x0, b.y0, b.bw, b.bh, 3.5);
            sctx.fillStyle = p.p1;
            sctx.fill();
            sctx.strokeStyle = hexToRgba(b.accentCol, p.dark ? 0.88 : 0.82);
            sctx.lineWidth = 1;
            sctx.stroke();

            // Crisp top bevel glint on badge pill
            sctx.beginPath();
            sctx.moveTo(b.x0 + 3, b.y0 + 0.75);
            sctx.lineTo(b.x0 + b.bw - 3, b.y0 + 0.75);
            sctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.88)';
            sctx.lineWidth = 0.75;
            sctx.stroke();

            sctx.fillStyle = b.text.endsWith('blk') ? p.vermilionHi : p.ink1;
            sctx.fillText(b.text, b.bx, b.by + 0.5);
          }
          sctx.restore();
        }

        // Helper: Machined Multi-Ring Connector Socket & Strain-Relief Collar Stub
        function drawTerminalSocket(sx, sy, dir, accentCol, isFocusedSock, isPinLit) {
          if (!craftOn) {
            sctx.fillStyle = p.p4;
            sctx.strokeStyle = p.hairlineStrong;
            sctx.lineWidth = 0.8;
            sctx.beginPath();
            sctx.arc(sx, sy, 2.0, 0, TWO_PI);
            sctx.fill();
            sctx.stroke();
            return;
          }

          const rOuter = docked ? 2.6 : 3.2;
          const rPin = docked ? 1.2 : 1.5;
          const rHalo = docked ? 4.3 : 5.0;
          const stubLen = docked ? 2.0 : 3.5;
          const stubH = docked ? 2.6 : 3.2;

          // Outer focus halo ring on focused/selected node sockets
          if (isFocusedSock) {
            sctx.beginPath();
            sctx.arc(sx, sy, rHalo, 0, TWO_PI);
            sctx.strokeStyle = hexToRgba(accentCol, 0.55);
            sctx.lineWidth = 0.9;
            sctx.stroke();
          }

          // Horizontal metallic strain-relief collar stub protruding cleanly into the conduit
          const stubX = dir < 0 ? sx - rOuter - stubLen + 0.6 : sx + rOuter - 0.6;
          const stubY = sy - stubH * 0.5;
          sctx.fillStyle = p.p4;
          sctx.fillRect(stubX, stubY, stubLen, stubH);
          sctx.strokeStyle = isFocusedSock ? hexToRgba(accentCol, 0.82) : p.hairlineStrong;
          sctx.lineWidth = 0.8;
          sctx.strokeRect(stubX, stubY, stubLen, stubH);
          if (!docked) {
            sctx.beginPath();
            sctx.moveTo(stubX + 0.4, stubY + 0.5);
            sctx.lineTo(stubX + stubLen - 0.4, stubY + 0.5);
            sctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.85)';
            sctx.lineWidth = 0.65;
            sctx.stroke();
          }

          // Flanged circular terminal socket: recessed bezel ring + crisp metallic stroke
          sctx.beginPath();
          sctx.arc(sx, sy, rOuter, 0, TWO_PI);
          sctx.fillStyle = p.p1;
          sctx.fill();
          sctx.strokeStyle = isFocusedSock
            ? accentCol
            : p.dark
              ? 'rgba(255,255,255,0.30)'
              : 'rgba(15,18,26,0.34)';
          sctx.lineWidth = 1.0;
          sctx.stroke();

          // Inner luminous jewel pin (accent when active/incident, p.ink4 at rest)
          sctx.beginPath();
          sctx.arc(sx, sy, rPin, 0, TWO_PI);
          sctx.fillStyle = isPinLit ? accentCol : p.ink4;
          sctx.fill();

          if (isPinLit && !docked) {
            sctx.beginPath();
            sctx.arc(sx - 0.35, sy - 0.35, 0.52, 0, TWO_PI);
            sctx.fillStyle = 'rgba(255,255,255,0.84)';
            sctx.fill();
          }
        }

        // Machined Node Cards (Rich Multi-Line when tall, crisp chip when compact)
        for (const nodeId in flowNodeRects) {
          const r = flowNodeRects[nodeId];
          if (!r.node) continue;
          if (r.x + r.w < -16 || r.x > stageW + 16) continue;
          const node = r.node;
          const accent = colorForNode(node);
          const isFocus = focusId === nodeId;
          const isPinned = selectedId === nodeId;
          const isDimmed = incident && !incident.nodes[nodeId];
          const isIncNode = incident ? Boolean(incident.nodes[nodeId]) : false;

          sctx.save();
          if (isDimmed) sctx.globalAlpha = 0.12;

          const radius =
            node.col === 0 ? Math.min(10, r.h * 0.35) : node.col === 4 ? 4 : docked ? 4 : 6;

          roundRectPath(sctx, r.x, r.y, r.w, r.h, radius);
          sctx.fillStyle = isFocus ? p.p3 : p.p2;
          sctx.fill();

          let borderCol = p.hairline;
          if (node.kind === 'DECISION') {
            borderCol = node.stamped ? hexToRgba(accent, 0.70) : p.vermilionEdge;
          }
          if (isFocus || isPinned) borderCol = accent;
          sctx.strokeStyle = borderCol;
          sctx.lineWidth = isFocus || isPinned ? 1.4 : 1;
          sctx.stroke();

          // 1px Top-Edge Specular Keylight (aerospace machined bezel; stripped cleanly in detail=off)
          if (craftOn) {
            sctx.beginPath();
            sctx.moveTo(r.x + Math.max(2, radius * 0.8), r.y + 0.75);
            sctx.lineTo(r.x + r.w - Math.max(2, radius * 0.8), r.y + 0.75);
            sctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.85)';
            sctx.lineWidth = 1;
            sctx.stroke();
          }

          // Left accent rail on Mind Stores & active agents
          if (node.col === 4 || (node.kind === 'AGENT' && node.active && !docked)) {
            sctx.fillStyle = accent;
            sctx.fillRect(r.x + 0.5, r.y + 3, 2.4, r.h - 6);
          }

          // Machined Multi-Ring Connector Sockets & Collar Stubs (left input col > 0, right output col < 4)
          const sockFocused = isFocus || isPinned;
          const sockLit = incident
            ? isIncNode
            : Boolean(node.active || (node.kind === 'DECISION' && !node.stamped));
          const sockY = r.y + r.h * 0.5;
          if (node.col > 0) {
            drawTerminalSocket(r.x, sockY, -1, accent, sockFocused, sockLit);
          }
          if (node.col < 4) {
            drawTerminalSocket(r.x + r.w, sockY, 1, accent, sockFocused, sockLit);
          }

          // Strict inner clip so zero text ever escapes card bounds
          sctx.save();
          sctx.beginPath();
          sctx.rect(r.x + 2, r.y + 1, Math.max(1, r.w - 4), Math.max(1, r.h - 2));
          sctx.clip();

          if (node.kind === 'DECISION') {
            drawDecisionCardContent(sctx, r, node, p, accent, docked);
          } else {
            drawStandardCardContent(sctx, r, node, p, accent, docked);
          }

          sctx.restore();
          sctx.restore();
        }

        // Subtle edge peek shadow indicator on mobile 5-lane deck
        if (mobileDeck) {
          if (mobileLaneOffset < 2.95 && typeof sctx.createLinearGradient === 'function') {
            const rg = sctx.createLinearGradient(stageW - 22, 0, stageW, 0);
            rg.addColorStop(0, hexToRgba(p.p1, 0));
            rg.addColorStop(1, hexToRgba(p.p0, 0.72));
            sctx.fillStyle = rg;
            sctx.fillRect(stageW - 22, 0, 22, bottomY);
          }
          if (mobileLaneOffset > 0.05 && typeof sctx.createLinearGradient === 'function') {
            const lg = sctx.createLinearGradient(0, 0, 18, 0);
            lg.addColorStop(0, hexToRgba(p.p0, 0.72));
            lg.addColorStop(1, hexToRgba(p.p1, 0));
            sctx.fillStyle = lg;
            sctx.fillRect(0, 0, 18, bottomY);
          }
        }

        sctx.restore(); // end flow area clip

        // Bottom Instrument Deck (Static chassis + 60-sample sparklines + 20-seg seats + scope base)
        drawBottomHardwareAndScope(sctx, padX, bottomY, stageW - padX * 2, bottomH, docked);
      }

      function drawDecisionCardContent(sctx, r, node, p, accent, docked) {
        const padInner = docked ? 5 : 8;
        const dSize = docked ? 3.8 : 4.6;
        const dCx = r.x + padInner + dSize;
        const dCy = r.y + (docked ? 10 : 14);

        sctx.beginPath();
        sctx.moveTo(dCx, dCy - dSize);
        sctx.lineTo(dCx + dSize, dCy);
        sctx.lineTo(dCx, dCy + dSize);
        sctx.lineTo(dCx - dSize, dCy);
        sctx.closePath();
        sctx.fillStyle = accent;
        sctx.fill();

        sctx.font = '600 ' + (docked ? '9' : '10.5') + 'px ' + FONT_MONO;
        sctx.fillStyle = node.stamped ? (node.verdict === 'revise' ? p.amberHi : p.emeraldHi) : p.vermilionHi;
        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        sctx.fillText('#' + node.decId, dCx + dSize + 5, dCy + 0.5);

        const ageStr = node.stamped
          ? String(node.verdict || 'OK').toUpperCase()
          : formatAgeMs(node.ageMs);
        sctx.font = '600 ' + (docked ? '8.5' : '9.5') + 'px ' + FONT_MONO;
        sctx.fillStyle = node.stamped ? accent : p.ink2;
        sctx.textAlign = 'right';
        sctx.fillText(ageStr, r.x + r.w - padInner, dCy + 0.5);

        // Multi-line title when card is tall (>= 60px)
        const availW = Math.max(12, r.w - padInner * 2);
        if (r.h >= 62 && !docked) {
          sctx.font = '500 11px ' + FONT_SANS;
          sctx.fillStyle = p.ink1;
          sctx.textAlign = 'left';
          const lines = wrapTwoLines(sctx, node.title, availW);
          sctx.fillText(lines[0], r.x + padInner, r.y + 30);
          if (lines[1]) {
            sctx.fillText(lines[1], r.x + padInner, r.y + 44);
          }
          // Sub metadata row: channel + blocked count
          if (r.h >= 74) {
            sctx.font = '400 9.5px ' + FONT_MONO;
            sctx.fillStyle = p.ink3;
            const metaText = compactRoomLabel(node.channel, 18) + ' · ' + (node.blockedCount || 1) + ' blk';
            sctx.fillText(fitText(sctx, metaText, availW), r.x + padInner, r.y + r.h - 15);
          }
        } else if (r.h >= 30) {
          sctx.font = '500 ' + (docked ? '9' : '10.5') + 'px ' + FONT_SANS;
          sctx.fillStyle = p.ink1;
          sctx.textAlign = 'left';
          const titleY = docked ? r.y + r.h - 12 : r.y + r.h * 0.54;
          sctx.fillText(fitText(sctx, node.title, availW), r.x + padInner, titleY);
        }

        // Bottom age / verdict bar
        const barY = r.y + r.h - (docked ? 5 : 7);
        const barW = Math.max(8, r.w - padInner * 2);
        sctx.fillStyle = p.p0;
        sctx.fillRect(r.x + padInner, barY, barW, 2.5);
        const fillPct = node.stamped ? 100 : computeAgeProgress(node.ageMs);
        sctx.fillStyle = accent;
        sctx.fillRect(r.x + padInner, barY, (barW * fillPct) / 100, 2.5);
      }

      function drawStandardCardContent(sctx, r, node, p, accent, docked) {
        const padL = docked ? 4 : 8;
        const richCard = !docked && r.h >= 50;
        const topRowCy = richCard ? r.y + 17 : r.y + r.h * 0.5;
        const ultraNarrowDocked = docked && r.w < 74;
        const gSize = ultraNarrowDocked ? 8 : docked ? 13 : 20;
        const gx = r.x + padL + (node.col === 4 ? 2 : 0);
        const gy = topRowCy - gSize * 0.5;

        if (ultraNarrowDocked) {
          // Ultra-tight ASKS/BECOMES docked chip: recessed status LED instead of wide icon box
          const lCx = gx + 3.5;
          const lCy = topRowCy;
          sctx.beginPath();
          sctx.arc(lCx, lCy, 3.2, 0, TWO_PI);
          sctx.fillStyle = p.p0;
          sctx.fill();
          sctx.beginPath();
          sctx.arc(lCx, lCy, 2.2, 0, TWO_PI);
          sctx.fillStyle = accent;
          sctx.fill();
        } else {
          roundRectPath(sctx, gx, gy, gSize, gSize, node.col === 0 ? gSize * 0.5 : 4);
          sctx.fillStyle = p.p1;
          sctx.fill();
          sctx.strokeStyle = p.hairline;
          sctx.lineWidth = 0.85;
          sctx.stroke();

          sctx.font = '600 ' + (docked ? '7.5' : '9.5') + 'px ' + FONT_MONO;
          sctx.fillStyle = accent;
          sctx.textAlign = 'center';
          sctx.textBaseline = 'middle';
          sctx.fillText(node.glyph || '·', gx + gSize * 0.5, gy + gSize * 0.5 + 0.5);
        }

        // Right-aligned metric badge:
        // - Expanded: full bordered pill when r.w >= 108
        // - Docked: NEVER clip names for pills; only draw clean muted mono count when r.w >= 115,
        //   otherwise render a recessed 4.5px status LED for hot/active nodes (full count in hover readout)
        let rightEdge = r.x + r.w - padL;
        if (docked) {
          if (node.metric && r.w >= 115) {
            sctx.font = '500 8px ' + FONT_MONO;
            const compactMetric = cleanText(node.metric).replace(/\s+(ev|sig)$/i, '');
            const mw = Math.ceil(sctx.measureText(compactMetric).width);
            sctx.fillStyle = node.isHot ? p.vermilionHi : p.ink3;
            sctx.textAlign = 'right';
            sctx.textBaseline = 'middle';
            sctx.fillText(compactMetric, rightEdge, topRowCy + 0.5);
            rightEdge -= mw + 4;
          } else if (r.w >= 76 && (node.isHot || (node.kind === 'AGENT' && node.active))) {
            const ledX = rightEdge - 3;
            const ledY = topRowCy;
            sctx.beginPath();
            sctx.arc(ledX, ledY, 2.9, 0, TWO_PI);
            sctx.fillStyle = p.p0;
            sctx.fill();
            sctx.beginPath();
            sctx.arc(ledX, ledY, 1.9, 0, TWO_PI);
            sctx.fillStyle = node.isHot ? p.vermilion : p.emerald;
            sctx.fill();
            if (detail !== 'off') {
              sctx.beginPath();
              sctx.arc(ledX - 0.5, ledY - 0.5, 0.55, 0, TWO_PI);
              sctx.fillStyle = 'rgba(255,255,255,0.65)';
              sctx.fill();
            }
            rightEdge -= 8;
          }
        } else if (node.metric && r.w >= 108) {
          sctx.font = '500 9.5px ' + FONT_MONO;
          const mw = Math.ceil(sctx.measureText(node.metric).width) + 9;
          const mx = rightEdge - mw;
          const mh = 16;
          const my = topRowCy - mh * 0.5;
          roundRectPath(sctx, mx, my, mw, mh, 3);
          sctx.fillStyle = node.isHot ? p.vermilionSoft : p.p1;
          sctx.fill();
          sctx.strokeStyle = node.isHot ? p.vermilionEdge : p.hairline;
          sctx.lineWidth = 0.8;
          sctx.stroke();
          sctx.fillStyle = node.isHot ? p.vermilionHi : p.ink2;
          sctx.textAlign = 'center';
          sctx.textBaseline = 'middle';
          sctx.fillText(node.metric, mx + mw * 0.5, my + mh * 0.5 + 0.5);
          rightEdge = mx - 5;
        }

        // Primary label (crisp zero-clip canonical docked name in docked mode)
        const tx = gx + gSize + (ultraNarrowDocked ? 2 : docked ? 4 : 7);
        const availW = Math.max(8, rightEdge - tx);
        const displayLabel = docked ? dockedNodeLabel(node) : node.shortLabel;
        sctx.font = '600 ' + (docked ? (ultraNarrowDocked ? '9' : '9.5') : '11.5') + 'px ' + FONT_SANS;
        sctx.fillStyle = p.ink1;
        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        const showSubInChip = !richCard && !docked && r.h >= 34 && node.sub;
        sctx.fillText(
          fitText(sctx, displayLabel, availW),
          tx,
          showSubInChip ? r.y + r.h * 0.34 : topRowCy + 0.5
        );

        if (showSubInChip) {
          sctx.font = '400 9px ' + FONT_MONO;
          sctx.fillStyle = node.isHot ? p.vermilionHi : p.ink3;
          sctx.fillText(fitText(sctx, node.sub, availW), tx, r.y + r.h * 0.72);
        }

        // Rich multi-line expansion: last signal excerpt + micro age sparkline + blocked count
        if (richCard) {
          const fullW = Math.max(16, r.w - padL * 2 - (node.col === 4 ? 3 : 0));
          const excerptX = r.x + padL + (node.col === 4 ? 3 : 0);
          const excerptText = node.excerpt || node.sub || '';
          if (excerptText) {
            sctx.font = '400 10px ' + FONT_SANS;
            sctx.fillStyle = p.ink2;
            sctx.textAlign = 'left';
            sctx.textBaseline = 'middle';
            sctx.fillText(fitText(sctx, excerptText, fullW), excerptX, r.y + 37);
          }

          if (r.h >= 62) {
            const footY = r.y + r.h - 14;
            // Micro activity sparkline on left
            const spark = Array.isArray(node.spark) ? node.spark : null;
            if (spark && spark.length > 0) {
              const sw = Math.min(64, Math.floor(fullW * 0.45));
              const sh = 10;
              const barGap = 1.5;
              const bw = Math.max(1.5, (sw - barGap * (spark.length - 1)) / spark.length);
              let maxB = 1;
              for (let i = 0; i < spark.length; i += 1) {
                if (spark[i] > maxB) maxB = spark[i];
              }
              for (let i = 0; i < spark.length; i += 1) {
                const bh = spark[i] > 0 ? Math.max(2.5, (spark[i] / maxB) * sh) : 1.5;
                sctx.fillStyle = spark[i] > 0 ? hexToRgba(accent, 0.78) : p.segOff;
                sctx.fillRect(excerptX + i * (bw + barGap), footY + 4 - bh, bw, bh);
              }
            } else if (node.sub) {
              sctx.font = '400 9px ' + FONT_MONO;
              sctx.fillStyle = p.ink3;
              sctx.textAlign = 'left';
              sctx.fillText(fitText(sctx, node.sub, fullW * 0.65), excerptX, footY);
            }

            // Right micro status / blocked count
            const rightMeta =
              node.blockedCount > 0
                ? node.blockedCount + ' blk'
                : node.active
                  ? 'active'
                  : node.kind === 'STORE'
                    ? node.storeKey
                    : 'ready';
            sctx.font = '500 9px ' + FONT_MONO;
            sctx.fillStyle = node.blockedCount > 0 ? p.vermilionHi : p.ink3;
            sctx.textAlign = 'right';
            sctx.fillText(rightMeta, r.x + r.w - padL, footY);
          }
        }
      }

      // ======================================================================
      // FLOW DECK DYNAMIC LAYER (1 DRAWIMAGE BLIT + PHOTONS + HOLD RING + SHAKE)
      // ======================================================================

      function drawFlowDynamic(now, layout) {
        if (!ctx) return;
        const p = pal();
        const { docked, bottomY } = layout;
        const focusId = hoveredId || selectedId;
        const incident = focusId ? getIncidentSets(focusId) : null;
        const motion = isMotionEnabled();
        const timeSec = elapsedMs / 1000;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, stageW, bottomY);
        ctx.clip();

        // L2: Active drifting dashed carriers on edges
        if (motion) {
          for (const edgeId in flowEdgeGeoms) {
            const geom = flowEdgeGeoms[edgeId];
            const isInc = incident ? Boolean(incident.edges[edgeId]) : false;
            if (incident && !isInc) continue;
            const srcNode = model.nodeById[geom.edge.from];
            const srcColor = colorForNode(srcNode);
            const carrierAlpha = incident ? 0.85 : p.dark ? 0.36 : 0.40;
            ctx.beginPath();
            ctx.moveTo(geom.p0.x, geom.p0.y);
            ctx.bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y);
            ctx.setLineDash([3, 14]);
            ctx.lineDashOffset = -(timeSec * geom.dashSpeed);
            ctx.strokeStyle = hexToRgba(srcColor, carrierAlpha);
            ctx.lineWidth = clamp(geom.width * 0.34, 1.0, 2.0);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }

        // L3: Wavelength-Dispersed 3-Part Optical Comets + Harmonic Echo Ticks + Socket Reception Flashes
        if (photons.length > 0) {
          const craftOn = detail !== 'off';
          const tailLen = docked ? 16 : 26;
          const capLen = docked ? 7.5 : 10.8;
          const capH = docked ? 2.2 : 2.8;
          const coreH = docked ? 1.2 : 1.55;
          const echoDist1 = docked ? 4.5 : 6.0;
          const echoDist2 = docked ? 8.5 : 11.0;

          for (let i = 0; i < photons.length; i += 1) {
            const ph = photons[i];
            const geom = flowEdgeGeoms[ph.edgeId];
            if (!geom) continue;
            if (incident && !incident.edges[ph.edgeId]) continue;

            const progress = clamp(ph.distPx / Math.max(1, geom.length), 0, 1);

            const segs = 7;
            for (let s = 0; s < segs; s += 1) {
              const dA = ph.distPx - (s / segs) * tailLen;
              const dB = ph.distPx - ((s + 1) / segs) * tailLen;
              if (dA <= 0) break;
              const ptA = sampleArcLengthPoint(geom, Math.max(0, dA));
              const ptB = sampleArcLengthPoint(geom, Math.max(0, dB));
              const frac = 1 - s / segs;
              const quadFrac = frac * frac;
              ctx.beginPath();
              ctx.moveTo(ptA.x, ptA.y);
              ctx.lineTo(ptB.x, ptB.y);
              ctx.strokeStyle = hexToRgba(ph.color, quadFrac * 0.66);
              ctx.lineWidth = Math.max(0.45, capH * 0.88 * frac);
              ctx.lineCap = 'round';
              ctx.stroke();

              // Inner hot white-tinted chromatic dispersion core near comet head
              if (s < 3 && craftOn) {
                ctx.beginPath();
                ctx.moveTo(ptA.x, ptA.y);
                ctx.lineTo(ptB.x, ptB.y);
                ctx.strokeStyle = 'rgba(255,255,255,' + (quadFrac * 0.50).toFixed(3) + ')';
                ctx.lineWidth = Math.max(0.4, coreH * 0.68 * frac);
                ctx.lineCap = 'round';
                ctx.stroke();
              }
            }

            // 2 Calibrated Trailing Harmonic Echo Ticks spaced 6px and 11px behind along the Bezier tangent
            if (craftOn) {
              const d1 = ph.distPx - echoDist1;
              if (d1 > 1.5) {
                const ep1 = sampleArcLengthPoint(geom, d1);
                const e1Len = docked ? 2.2 : 3.1;
                const e1H = docked ? 1.25 : 1.7;
                ctx.save();
                ctx.translate(ep1.x, ep1.y);
                ctx.rotate(ep1.angle);
                // Perpendicular harmonic dispersion tick
                ctx.beginPath();
                ctx.moveTo(0, -e1H - 0.9);
                ctx.lineTo(0, e1H + 0.9);
                ctx.strokeStyle = hexToRgba(ph.color, p.dark ? 0.56 : 0.48);
                ctx.lineWidth = 0.85;
                ctx.stroke();
                // Faceted harmonic echo bead
                ctx.beginPath();
                ctx.moveTo(e1Len * 0.6, 0);
                ctx.lineTo(0, -e1H * 0.72);
                ctx.lineTo(-e1Len * 0.6, 0);
                ctx.lineTo(0, e1H * 0.72);
                ctx.closePath();
                ctx.fillStyle = hexToRgba(ph.color, 0.88);
                ctx.fill();
                ctx.fillStyle = 'rgba(255,255,255,0.88)';
                ctx.fillRect(-0.65, -0.55, 1.3, 1.1);
                ctx.restore();
              }

              const d2 = ph.distPx - echoDist2;
              if (d2 > 1.5) {
                const ep2 = sampleArcLengthPoint(geom, d2);
                const e2Len = docked ? 1.6 : 2.3;
                const e2H = docked ? 0.95 : 1.3;
                ctx.save();
                ctx.translate(ep2.x, ep2.y);
                ctx.rotate(ep2.angle);
                // Secondary perpendicular harmonic wing tick
                ctx.beginPath();
                ctx.moveTo(0, -e2H - 0.7);
                ctx.lineTo(0, e2H + 0.7);
                ctx.strokeStyle = hexToRgba(ph.color, p.dark ? 0.38 : 0.32);
                ctx.lineWidth = 0.75;
                ctx.stroke();
                // Secondary echo diamond
                ctx.beginPath();
                ctx.moveTo(e2Len * 0.6, 0);
                ctx.lineTo(0, -e2H * 0.7);
                ctx.lineTo(-e2Len * 0.6, 0);
                ctx.lineTo(0, e2H * 0.7);
                ctx.closePath();
                ctx.fillStyle = hexToRgba(ph.color, 0.60);
                ctx.fill();
                ctx.restore();
              }
            }

            const head = sampleArcLengthPoint(geom, ph.distPx);
            if (craftOn) {
              const sprite = getGlowSprite(ph.color);
              if (sprite) {
                try {
                  ctx.drawImage(sprite, head.x - 9, head.y - 9, 18, 18);
                } catch {
                  // fallback if mock context
                }
              }
            }

            ctx.save();
            ctx.translate(head.x, head.y);
            ctx.rotate(head.angle);

            // Crisp diamond/teardrop luminous head (accent jacket + pure white specular core)
            ctx.beginPath();
            ctx.moveTo(capLen * 0.54, 0);
            ctx.lineTo(capLen * 0.08, -capH * 0.62);
            ctx.quadraticCurveTo(-capLen * 0.24, -capH * 0.42, -capLen * 0.58, 0);
            ctx.quadraticCurveTo(-capLen * 0.24, capH * 0.42, capLen * 0.08, capH * 0.62);
            ctx.closePath();
            ctx.fillStyle = ph.color;
            ctx.fill();

            if (craftOn) {
              ctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.44)' : hexToRgba(ph.color, 0.85);
              ctx.lineWidth = 0.7;
              ctx.stroke();
            }

            // Pure white diamond specular core
            ctx.beginPath();
            ctx.moveTo(capLen * 0.36, 0);
            ctx.lineTo(capLen * 0.04, -coreH * 0.56);
            ctx.lineTo(-capLen * 0.28, 0);
            ctx.lineTo(capLen * 0.04, coreH * 0.56);
            ctx.closePath();
            ctx.fillStyle = p.dark ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.94)';
            ctx.fill();
            ctx.restore();

            // Concentric socket reception flash ring centered on geom.p3 when docking (progress > 0.92)
            if (craftOn && progress > 0.92) {
              const dockFrac = clamp((progress - 0.92) / 0.08, 0, 1);
              const ringR = 3.5 + dockFrac * 4.0;
              const ringAlpha = (1 - dockFrac * 0.72) * (p.dark ? 0.92 : 0.85);
              ctx.save();
              ctx.beginPath();
              ctx.arc(geom.p3.x, geom.p3.y, ringR, 0, TWO_PI);
              ctx.strokeStyle = hexToRgba(ph.color, ringAlpha);
              ctx.lineWidth = 1.0;
              ctx.stroke();

              const innerR = 2.2 + dockFrac * 2.1;
              ctx.beginPath();
              ctx.arc(geom.p3.x, geom.p3.y, innerR, 0, TWO_PI);
              ctx.strokeStyle = p.dark
                ? 'rgba(255,255,255,' + ((1 - dockFrac) * 0.84).toFixed(3) + ')'
                : hexToRgba(ph.color, (1 - dockFrac) * 0.72);
              ctx.lineWidth = 0.85;
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        // Dynamic overlays on nodes: arrival flash, stamp pop ring, rollback shake, 350ms hold ring
        for (const nodeId in flashMap) {
          const fl = flashMap[nodeId];
          const r = flowNodeRects[nodeId];
          const age = now - fl.startMs;
          if (!r || age >= 440) {
            delete flashMap[nodeId];
            continue;
          }
          const frac = age < 100 ? age / 100 : 1 - (age - 100) / 340;
          ctx.save();
          roundRectPath(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 6);
          ctx.strokeStyle = hexToRgba(fl.color || p.cyan, frac * 0.82);
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.restore();
        }

        for (const nodeId in stampAnimMap) {
          const start = stampAnimMap[nodeId];
          const r = flowNodeRects[nodeId];
          const age = now - start;
          if (!r || age >= 380) {
            delete stampAnimMap[nodeId];
            continue;
          }
          const prog = age / 380;
          const expand = prog * 7;
          const col = r.node ? colorForNode(r.node) : p.emerald;
          ctx.save();
          roundRectPath(ctx, r.x - expand, r.y - expand, r.w + expand * 2, r.h + expand * 2, 8);
          ctx.strokeStyle = hexToRgba(col, (1 - prog) * 0.85);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }

        for (const nodeId in shakeMap) {
          const sk = shakeMap[nodeId];
          const r = flowNodeRects[nodeId];
          const age = now - sk.startMs;
          if (!r || age >= ROLLBACK_SHAKE_MS) {
            delete shakeMap[nodeId];
            continue;
          }
          const prog = age / ROLLBACK_SHAKE_MS;
          const dx = Math.sin(prog * Math.PI * 5) * (1 - prog) * 6;
          ctx.save();
          roundRectPath(ctx, r.x + dx, r.y, r.w, r.h, 6);
          ctx.strokeStyle = hexToRgba(p.vermilion, 0.92);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }

        // 350ms Hold-to-Confirm radial progress ring on focused Decision Gate
        if (holdState) {
          const r = flowNodeRects[holdState.nodeId];
          if (r) {
            const prog = clamp((now - holdState.startMs) / HOLD_STAMP_MS, 0, 1);
            const cx = r.x + r.w - 18;
            const cy = r.y + r.h * 0.5;
            const rad = 11;
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, TWO_PI);
            ctx.fillStyle = hexToRgba(p.p0, 0.82);
            ctx.fill();
            ctx.strokeStyle = p.hairlineStrong;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, rad, -Math.PI * 0.5, -Math.PI * 0.5 + TWO_PI * prog);
            ctx.strokeStyle = p.emerald;
            ctx.lineWidth = 2.6;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.restore();

            if (prog >= 1) {
              const targetNode = r.node;
              const v = holdState.verdict || 'approve';
              holdState = null;
              if (targetNode) {
                submitDecisionStamp(targetNode, v);
              }
            }
          }
        }

        ctx.restore();
      }

      // ======================================================================
      // L4 DATA-TRUE HARDWARE RACK (60-SAMPLE REAL SPARKLINES) + SEATS + SCOPE
      // ======================================================================

      function drawBottomHardwareAndScope(tctx, x, y, w, h, docked) {
        const p = pal();

        tctx.strokeStyle = p.hairlineStrong;
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(0, Math.floor(y) + 0.5);
        tctx.lineTo(stageW, Math.floor(y) + 0.5);
        tctx.stroke();

        tctx.fillStyle = p.p0;
        tctx.fillRect(0, y + 1, stageW, h);

        const innerY = y + 6;
        const innerH = Math.max(54, h - 10);
        const gap = docked ? 6 : 10;

        if (docked) {
          const leftW = Math.floor((w - gap) * 0.50);
          const rightX = x + leftW + gap;
          const rightW = w - leftW - gap;

          const baysH = Math.floor(innerH * 0.56);
          drawHardwareRack(tctx, x, innerY, leftW, baysH, true);

          const seatY = innerY + baysH + 4;
          const seatH = innerH - baysH - 4;
          drawSeatGauges(tctx, x, seatY, leftW, seatH, true);

          drawOscilloscope(tctx, rightX, innerY, rightW, innerH, true);
        } else {
          const hwW = Math.floor((w - gap * 2) * 0.40);
          const seatW = Math.floor((w - gap * 2) * 0.25);
          const scopeW = w - hwW - seatW - gap * 2;

          drawHardwareRack(tctx, x, innerY, hwW, innerH, false);
          drawSeatGauges(tctx, x + hwW + gap, innerY, seatW, innerH, false);
          drawOscilloscope(tctx, x + hwW + seatW + gap * 2, innerY, scopeW, innerH, false);
        }
      }

      function drawHardwareRack(tctx, x, y, w, h, compact) {
        const p = pal();
        roundRectPath(tctx, x, y, w, h, 5);
        tctx.fillStyle = p.p1;
        tctx.fill();
        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 1;
        tctx.stroke();

        const hdrH = compact ? 12 : 16;
        tctx.font = '600 ' + (compact ? '8' : '9') + 'px ' + FONT_MONO;
        tctx.fillStyle = p.ink3;
        tctx.textAlign = 'left';
        tctx.textBaseline = 'middle';
        tctx.fillText('RUNS ON · ' + model.serviceSummary, x + 6, y + hdrH * 0.5 + 1);

        const svcs = model.services;
        const pad = compact ? 3 : 5;
        const bayGap = compact ? 3 : 5;
        const bayW = (w - pad * 2 - bayGap * (svcs.length - 1)) / svcs.length;
        const bayY = y + hdrH + 1;
        const bayH = Math.max(18, h - hdrH - pad - 1);

        if (compact && bayW < 42) {
          const rowY = bayY + bayH * 0.5;
          const dotGap = Math.max(24, (w - pad * 2) / svcs.length);
          for (let i = 0; i < svcs.length; i += 1) {
            const svc = svcs[i];
            const dx = x + pad + i * dotGap + 5;
            const ledCol =
              svc.status === 'ok' ? p.emerald : svc.status === 'warn' ? p.amber : p.vermilion;
            tctx.beginPath();
            tctx.arc(dx, rowY, 3, 0, TWO_PI);
            tctx.fillStyle = ledCol;
            tctx.fill();
            tctx.font = '500 8px ' + FONT_MONO;
            tctx.fillStyle = p.ink2;
            tctx.textAlign = 'left';
            tctx.textBaseline = 'middle';
            const tag = i === 0 ? 'HV' : i === 1 ? 'BD' : i === 2 ? 'CP' : i === 3 ? 'BR' : 'G4';
            tctx.fillText(tag, dx + 5.5, rowY + 0.5);
          }
          return;
        }

        for (let i = 0; i < svcs.length; i += 1) {
          const svc = svcs[i];
          const bx = x + pad + i * (bayW + bayGap);
          const isFocus = hoveredId === svc.id;
          const ledCol =
            svc.status === 'ok' ? p.emerald : svc.status === 'warn' ? p.amber : p.vermilion;

          roundRectPath(tctx, bx, bayY, bayW, bayH, 4);
          tctx.fillStyle = isFocus ? p.p3 : p.p2;
          tctx.fill();
          tctx.strokeStyle = isFocus ? ledCol : p.hairline;
          tctx.lineWidth = 0.85;
          tctx.stroke();

          // 1px top specular keylight on hardware bay
          if (detail !== 'off') {
            tctx.beginPath();
            tctx.moveTo(bx + 3, bayY + 0.75);
            tctx.lineTo(bx + bayW - 3, bayY + 0.75);
            tctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.85)';
            tctx.lineWidth = 1;
            tctx.stroke();
          }

          flowNodeRects[svc.id] = { x: bx, y: bayY, w: bayW, h: bayH, col: -1, node: null, hw: svc };

          // Recessed machined status LED bezel
          const ledR = compact ? 1.9 : 2.7;
          const ledCx = bx + (compact ? 5.0 : 7.5);
          const ledCy = bayY + (compact ? 6.5 : 10);
          tctx.beginPath();
          tctx.arc(ledCx, ledCy, ledR + 0.95, 0, TWO_PI);
          tctx.fillStyle = p.p0;
          tctx.fill();
          tctx.strokeStyle = p.hairlineStrong;
          tctx.lineWidth = 0.6;
          tctx.stroke();
          tctx.beginPath();
          tctx.arc(ledCx, ledCy, ledR, 0, TWO_PI);
          tctx.fillStyle = ledCol;
          tctx.fill();
          if (detail !== 'off') {
            tctx.beginPath();
            tctx.arc(ledCx - ledR * 0.3, ledCy - ledR * 0.3, Math.max(0.55, ledR * 0.28), 0, TWO_PI);
            tctx.fillStyle = 'rgba(255,255,255,0.68)';
            tctx.fill();
          }

          tctx.save();
          tctx.beginPath();
          tctx.rect(bx + 2, bayY + 1, Math.max(1, bayW - 4), Math.max(1, bayH - 2));
          tctx.clip();

          tctx.font = '500 ' + (compact ? '7.5' : '9') + 'px ' + FONT_MONO;
          tctx.fillStyle = p.ink1;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText(
            fitText(tctx, compact ? svc.short : svc.name, bayW - (compact ? 12.5 : 15)),
            bx + (compact ? 10.5 : 13),
            bayY + (compact ? 6.5 : 10)
          );

          // Exact last telemetry value labeled clearly
          if (!compact && bayH >= 48) {
            tctx.font = '600 9px ' + FONT_MONO;
            tctx.fillStyle = ledCol;
            tctx.textAlign = 'left';
            tctx.fillText(fitText(tctx, svc.stat, bayW - 8), bx + 5, bayY + 23);
          }

          // Real 60-sample per-service telemetry sparkline (NO fake ECG waves)
          const samples = serviceSparklines[svc.id] || [svc.sampleValue || 0];
          const spW = Math.max(16, bayW - 10);
          const spH = compact ? Math.max(8, bayH - 13) : Math.max(18, bayH - 34);
          const spX = bx + 5;
          const spY = bayY + bayH - spH - 4;

          // Shared baseline rule
          tctx.strokeStyle = p.hairline;
          tctx.lineWidth = 0.7;
          tctx.beginPath();
          tctx.moveTo(spX, spY + spH);
          tctx.lineTo(spX + spW, spY + spH);
          tctx.stroke();

          if (samples.length > 0) {
            let minV = samples[0];
            let maxV = samples[0];
            for (let k = 1; k < samples.length; k += 1) {
              if (samples[k] < minV) minV = samples[k];
              if (samples[k] > maxV) maxV = samples[k];
            }
            const rangeTop = Math.max(svc.scaleMax || 1, maxV * 1.15, 0.01);
            const rangeBot = maxV - minV < 0.001 ? 0 : Math.min(0, minV);
            const span = Math.max(0.01, rangeTop - rangeBot);
            const yAt = (val) => spY + spH - 1.5 - clamp((val - rangeBot) / span, 0, 1) * (spH - 3);
            const denom = Math.max(1, samples.length - 1);

            // Subtle vertical gradient area-fill underneath the 60-sample sparkline
            tctx.beginPath();
            for (let k = 0; k < samples.length; k += 1) {
              const px = spX + (k / denom) * spW;
              const py = yAt(samples[k]);
              if (k === 0) {
                tctx.moveTo(px, spY + spH);
                tctx.lineTo(px, py);
              } else {
                tctx.lineTo(px, py);
              }
            }
            tctx.lineTo(spX + spW, spY + spH);
            tctx.closePath();
            let spFill = hexToRgba(ledCol, 0.14);
            if (typeof tctx.createLinearGradient === 'function') {
              const sg = tctx.createLinearGradient(0, spY, 0, spY + spH);
              sg.addColorStop(0, hexToRgba(ledCol, p.dark ? 0.28 : 0.22));
              sg.addColorStop(1, hexToRgba(ledCol, 0.02));
              spFill = sg;
            }
            tctx.fillStyle = spFill;
            tctx.fill();

            // Crisp dual-stroke polyline (zero canvas blur)
            const drawTrace = (col, lw) => {
              tctx.beginPath();
              for (let k = 0; k < samples.length; k += 1) {
                const px = spX + (k / denom) * spW;
                const py = yAt(samples[k]);
                if (k === 0) tctx.moveTo(px, py);
                else tctx.lineTo(px, py);
              }
              tctx.strokeStyle = col;
              tctx.lineWidth = lw;
              tctx.lineJoin = 'round';
              tctx.stroke();
            };
            drawTrace(hexToRgba(ledCol, 0.24), 2.4);
            drawTrace(ledCol, 1.2);

            // Live rightmost sample pip
            const lastY = yAt(samples[samples.length - 1]);
            tctx.beginPath();
            tctx.arc(spX + spW - 1, lastY, 2, 0, TWO_PI);
            tctx.fillStyle = ledCol;
            tctx.fill();
          }

          tctx.restore();
        }
      }

      function drawSeatGauges(tctx, x, y, w, h, compact) {
        const p = pal();
        roundRectPath(tctx, x, y, w, h, 5);
        tctx.fillStyle = p.p1;
        tctx.fill();
        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 1;
        tctx.stroke();

        const hdrH = compact ? 0 : 16;
        if (!compact) {
          tctx.font = '600 9px ' + FONT_MONO;
          tctx.fillStyle = p.ink3;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText('SEAT HEADROOM (20-SEG)', x + 7, y + hdrH * 0.5 + 1);
        }

        const seats = model.seats;
        if (seats.length === 0) {
          tctx.font = '400 9.5px ' + FONT_MONO;
          tctx.fillStyle = p.ink3;
          tctx.textAlign = 'center';
          tctx.textBaseline = 'middle';
          tctx.fillText('No seat telemetry', x + w * 0.5, y + h * 0.5);
          return;
        }

        const padX = compact ? 5 : 7;
        const padY = compact ? 3 : 4;
        const availH = h - hdrH - padY * 2;
        const maxRows = compact ? Math.min(2, seats.length) : Math.min(3, seats.length);
        const rowH = availH / maxRows;

        for (let i = 0; i < maxRows; i += 1) {
          const seat = seats[i];
          const ry = y + hdrH + padY + i * rowH;
          const cy = ry + rowH * 0.5;
          const isWarn = !seat.eligible || seat.headroomPct <= 15;
          const segCol = isWarn
            ? p.vermilion
            : seat.headroomPct < 50
              ? p.amber
              : p.emerald;

          flowNodeRects[seat.id] = { x: x + 2, y: ry, w: w - 4, h: rowH, col: -1, node: null, seat };

          const lblW = compact ? 52 : 72;
          const pctW = compact ? 26 : 32;
          tctx.font = '500 ' + (compact ? '8' : '9.5') + 'px ' + FONT_MONO;
          tctx.fillStyle = p.ink1;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText(fitText(tctx, seat.label, lblW - 2), x + padX, cy);

          const segStartX = x + padX + lblW;
          const segAreaW = Math.max(40, w - padX * 2 - lblW - pctW - 4);
          const segGap = 1.5;
          const segW = Math.max(1.5, (segAreaW - segGap * 19) / 20);
          const segH = compact ? 6.5 : 9;
          const segTop = cy - segH * 0.5;
          const litCount = Math.round((seat.headroomPct / 100) * 20);

          // Recessed machined meter channel underneath the 20 segments
          if (detail !== 'off') {
            roundRectPath(tctx, segStartX - 1.5, segTop - 1.5, segAreaW + 3, segH + 3, 2);
            tctx.fillStyle = p.p0;
            tctx.fill();
            tctx.strokeStyle = p.hairline;
            tctx.lineWidth = 0.6;
            tctx.stroke();
          }

          for (let s = 0; s < 20; s += 1) {
            const sx = segStartX + s * (segW + segGap);
            const isLit = s < litCount;
            tctx.fillStyle = isLit ? segCol : isWarn && s === 0 ? hexToRgba(p.vermilion, 0.35) : p.segOff;
            tctx.fillRect(sx, segTop, segW, segH);
            // Crisp 1px top-edge bevel cap on lit headroom segments
            if (isLit && detail !== 'off') {
              tctx.fillStyle = p.dark ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.45)';
              tctx.fillRect(sx, segTop, segW, 1);
            }
          }

          tctx.font = '600 ' + (compact ? '8' : '9.5') + 'px ' + FONT_MONO;
          tctx.fillStyle = isWarn ? p.vermilionHi : p.emeraldHi;
          tctx.textAlign = 'right';
          tctx.fillText(seat.headroomPct + '%', x + w - padX, cy);
        }
      }

      function drawOscilloscope(tctx, x, y, w, h, compact) {
        const p = pal();
        roundRectPath(tctx, x, y, w, h, 5);
        tctx.fillStyle = p.p1;
        tctx.fill();
        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 1;
        tctx.stroke();

        const latest = scopeSamples.length > 0 ? scopeSamples[scopeSamples.length - 1] : null;
        const curRatio = latest ? latest.loadRatio : model.host.loadRatio;
        const curMem = latest ? latest.memGib : model.host.memAvailableGib;

        const hdrH = compact ? 18 : 24;
        tctx.font = '600 ' + (compact ? '8' : '9') + 'px ' + FONT_MONO;
        tctx.fillStyle = p.ink3;
        tctx.textAlign = 'left';
        tctx.textBaseline = 'middle';
        tctx.fillText(compact ? 'HOST 60S' : 'HOST LOAD & MEM · 60S', x + 7, y + hdrH * 0.5);

        tctx.font = '600 ' + (compact ? '12.5' : '18') + 'px ' + FONT_MONO;
        tctx.fillStyle = loadColor(curRatio);
        tctx.textAlign = 'right';
        tctx.fillText(curRatio.toFixed(2) + 'x', x + w - 7, y + hdrH * 0.52);

        if (!compact && w >= 220) {
          tctx.font = '400 9px ' + FONT_MONO;
          tctx.fillStyle = p.ink2;
          tctx.fillText(
            curMem.toFixed(1) + '/' + model.host.memTotalGib.toFixed(0) + 'G',
            x + w - 70,
            y + hdrH * 0.52
          );
        }

        const px = x + 4;
        const py = y + hdrH;
        const pw = Math.max(40, w - 8);
        const ph = Math.max(26, h - hdrH - 4);
        const tickStripH = compact ? 7 : 9;
        const plotH = Math.max(18, ph - tickStripH);

        tctx.save();
        tctx.beginPath();
        tctx.rect(px, py, pw, ph);
        tctx.clip();

        tctx.fillStyle = p.p0;
        tctx.fillRect(px, py, pw, ph);

        const maxRatio = Math.max(2.5, curRatio * 1.2);
        const windowSec = 60;
        const nowT = scopeScrollSec;
        const xForT = (tSec) => px + pw - ((nowT - tSec) / windowSec) * pw;
        const yForRatio = (r) => py + 4 + (1 - clamp(r, 0, maxRatio) / maxRatio) * (plotH - 8);
        const yForMem = (gib) =>
          py + 4 + (1 - clamp(gib / Math.max(1, model.host.memTotalGib), 0, 1)) * (plotH - 8);

        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 0.7;
        for (let g = 10; g < 60; g += 10) {
          const gx = px + pw - (g / windowSec) * pw;
          tctx.beginPath();
          tctx.moveTo(gx, py);
          tctx.lineTo(gx, py + plotH);
          tctx.stroke();
        }

        if (scopeSamples.length > 1) {
          tctx.beginPath();
          let started = false;
          let lastX = px + pw;
          for (let i = 0; i < scopeSamples.length; i += 1) {
            const s = scopeSamples[i];
            const sx = xForT(s.tSec);
            if (sx < px - 12) continue;
            const sy = yForMem(s.memGib);
            if (!started) {
              tctx.moveTo(sx, py + plotH);
              tctx.lineTo(sx, sy);
              started = true;
            } else {
              tctx.lineTo(sx, sy);
            }
            lastX = sx;
          }
          if (started) {
            tctx.lineTo(lastX, py + plotH);
            tctx.closePath();
            tctx.fillStyle = hexToRgba(p.memBlue, p.dark ? 0.12 : 0.11);
            tctx.fill();
          }
        }

        const yCap = Math.floor(yForRatio(1.0)) + 0.5;
        tctx.save();
        tctx.setLineDash([4, 3]);
        tctx.strokeStyle = p.dark ? 'rgba(255,255,255,0.28)' : 'rgba(15,18,26,0.32)';
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(px, yCap);
        tctx.lineTo(px + pw, yCap);
        tctx.stroke();
        tctx.setLineDash([]);
        tctx.font = '500 8.5px ' + FONT_MONO;
        const latestRatio = scopeSamples.length > 0 ? scopeSamples[scopeSamples.length - 1].loadRatio : 0;
        const placeBelow = latestRatio >= 0.92 && latestRatio <= 1.45 && yCap + 11 < py + ph;
        const capText = '1.0x CAP';
        const capW = Math.ceil(tctx.measureText(capText).width) + 6;
        const capBoxY = placeBelow ? yCap + 2 : Math.max(py + 1, yCap - 11);
        tctx.fillStyle = hexToRgba(p.p1, 0.92);
        tctx.fillRect(px + 2, capBoxY, capW, 10);
        tctx.fillStyle = p.ink3;
        tctx.textAlign = 'left';
        tctx.textBaseline = 'middle';
        tctx.fillText(capText, px + 5, capBoxY + 5.5);
        tctx.restore();

        for (let i = 1; i < scopeSamples.length; i += 1) {
          const a = scopeSamples[i - 1];
          const b = scopeSamples[i];
          const xA = xForT(a.tSec);
          const xB = xForT(b.tSec);
          if (xB < px - 6 || xA > px + pw + 6) continue;
          const yA = yForRatio(a.loadRatio);
          const yB = yForRatio(b.loadRatio);
          const col = loadColor(b.loadRatio);

          tctx.beginPath();
          tctx.moveTo(xA, yA);
          tctx.lineTo(xB, yB);
          tctx.strokeStyle = hexToRgba(col, 0.18);
          tctx.lineWidth = 3;
          tctx.lineCap = 'round';
          tctx.stroke();

          tctx.beginPath();
          tctx.moveTo(xA, yA);
          tctx.lineTo(xB, yB);
          tctx.strokeStyle = col;
          tctx.lineWidth = 1.25;
          tctx.stroke();
        }

        if (latest) {
          const lx = xForT(latest.tSec);
          const ly = yForRatio(latest.loadRatio);
          tctx.beginPath();
          tctx.arc(lx, ly, 2.4, 0, TWO_PI);
          tctx.fillStyle = loadColor(latest.loadRatio);
          tctx.fill();
        }

        const stripY = py + plotH;
        tctx.fillStyle = p.dark ? 'rgba(255,255,255,0.03)' : 'rgba(15,18,26,0.04)';
        tctx.fillRect(px, stripY, pw, tickStripH);
        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 0.8;
        tctx.beginPath();
        tctx.moveTo(px, stripY + 0.5);
        tctx.lineTo(px + pw, stripY + 0.5);
        tctx.stroke();

        for (let i = 0; i < scopeTicks.length; i += 1) {
          const tk = scopeTicks[i];
          const tx = xForT(tk.tSec);
          if (tx < px || tx > px + pw) continue;
          tctx.fillStyle = tk.color || p.cyan;
          tctx.fillRect(Math.round(tx), stripY + 1.5, 1.5, tickStripH - 3);
        }

        tctx.restore();
      }

      // ======================================================================
      // LENS 2: STACK (3-DECK 2:1 DIMETRIC ARCHITECTURAL MACHINE - STATIC/DYNAMIC)
      // ======================================================================

      const DECK_Z = { 3: 205, 2: 0, 1: -200 };

      function deckParallax(deckNum) {
        if (!isMotionEnabled()) return { px: 0, py: 0 };
        const factor = deckNum === 3 ? 1 : deckNum === 1 ? -1 : 0;
        return { px: springX * 6 * factor, py: springY * 4.5 * factor };
      }

      function isoProject(proj, gx, gy, deckNum, zExtra) {
        const z = DECK_Z[deckNum] + (zExtra || 0);
        const par = deckParallax(deckNum);
        return {
          x: proj.cx + (gx - gy) * proj.scale + par.px,
          y: proj.cy + (gx + gy) * proj.scale * 0.5 - z * proj.zScale + par.py,
        };
      }

      function drawIsoPrism(tctx, proj, gx, gy, w, d, hPx, deckNum, zBase, st) {
        const hw = w * 0.5;
        const hd = d * 0.5;
        const zTop = zBase + hPx / proj.zScale;

        const bN = isoProject(proj, gx - hw, gy - hd, deckNum, zBase);
        const bE = isoProject(proj, gx + hw, gy - hd, deckNum, zBase);
        const bS = isoProject(proj, gx + hw, gy + hd, deckNum, zBase);
        const bW = isoProject(proj, gx - hw, gy + hd, deckNum, zBase);

        const tN = isoProject(proj, gx - hw, gy - hd, deckNum, zTop);
        const tE = isoProject(proj, gx + hw, gy - hd, deckNum, zTop);
        const tS = isoProject(proj, gx + hw, gy + hd, deckNum, zTop);
        const tW = isoProject(proj, gx - hw, gy + hd, deckNum, zTop);

        if (st.footprint) {
          tctx.beginPath();
          tctx.moveTo(bN.x, bN.y + 3);
          tctx.lineTo(bE.x + 2, bE.y + 3);
          tctx.lineTo(bS.x, bS.y + 4);
          tctx.lineTo(bW.x - 2, bW.y + 3);
          tctx.closePath();
          tctx.fillStyle = st.footprint;
          tctx.fill();
        }

        tctx.beginPath();
        tctx.moveTo(tW.x, tW.y);
        tctx.lineTo(tS.x, tS.y);
        tctx.lineTo(bS.x, bS.y);
        tctx.lineTo(bW.x, bW.y);
        tctx.closePath();
        tctx.fillStyle = st.left;
        tctx.fill();

        tctx.beginPath();
        tctx.moveTo(tS.x, tS.y);
        tctx.lineTo(tE.x, tE.y);
        tctx.lineTo(bE.x, bE.y);
        tctx.lineTo(bS.x, bS.y);
        tctx.closePath();
        tctx.fillStyle = st.right;
        tctx.fill();

        tctx.beginPath();
        tctx.moveTo(tN.x, tN.y);
        tctx.lineTo(tE.x, tE.y);
        tctx.lineTo(tS.x, tS.y);
        tctx.lineTo(tW.x, tW.y);
        tctx.closePath();
        tctx.fillStyle = st.top;
        tctx.fill();
        tctx.lineWidth = st.strokeWidth || 1;
        tctx.strokeStyle = st.edge;
        tctx.stroke();

        tctx.beginPath();
        tctx.moveTo(tW.x, tW.y);
        tctx.lineTo(bW.x, bW.y);
        tctx.moveTo(tS.x, tS.y);
        tctx.lineTo(bS.x, bS.y);
        tctx.moveTo(tE.x, tE.y);
        tctx.lineTo(bE.x, bE.y);
        tctx.moveTo(bW.x, bW.y);
        tctx.lineTo(bS.x, bS.y);
        tctx.lineTo(bE.x, bE.y);
        tctx.strokeStyle = st.sideEdge || st.edge;
        tctx.stroke();

        if (st.bevel) {
          tctx.beginPath();
          tctx.moveTo(tW.x, tW.y);
          tctx.lineTo(tN.x, tN.y);
          tctx.lineTo(tE.x, tE.y);
          tctx.strokeStyle = st.bevel;
          tctx.lineWidth = 1;
          tctx.stroke();
        }
        if (st.accentRim) {
          tctx.beginPath();
          tctx.moveTo(tW.x, tW.y);
          tctx.lineTo(tS.x, tS.y);
          tctx.lineTo(tE.x, tE.y);
          tctx.strokeStyle = st.accentRim;
          tctx.lineWidth = 1.5;
          tctx.stroke();
        }

        return {
          tN,
          tE,
          tS,
          tW,
          centerTop: isoProject(proj, gx, gy, deckNum, zTop),
          poly: [tN, tE, bE, bS, bW, tW],
        };
      }

      let lastStackDynamicMeta = null;

      function drawStackStatic(tctx) {
        const p = pal();
        stackHitTargets = [];
        stackCalloutTargets = [];

        const scopeStripH = clamp(Math.round(stageH * 0.16), 54, 72);
        const areaH = Math.max(180, stageH - scopeStripH);

        tctx.fillStyle = p.p0;
        tctx.fillRect(0, 0, stageW, stageH);

        tctx.fillStyle = p.dotGrid;
        for (let y = 14; y < areaH; y += 26) {
          for (let x = 14; x < stageW; x += 26) {
            tctx.fillRect(x, y, 1, 1);
          }
        }

        if (stageW < 560) {
          drawStackDockedElevation(tctx, p, areaH);
          drawOscilloscope(tctx, 8, areaH + 4, stageW - 16, scopeStripH - 8, true);
          lastStackDynamicMeta = { docked: true, areaH };
          return;
        }

        const showCallouts = stageW >= 620;
        const calloutMargin = showCallouts ? clamp(stageW * 0.20, 145, 195) : 16;
        const usableW = Math.max(200, stageW - calloutMargin * 2);
        const usableH = Math.max(160, areaH - 44);
        const scale = clamp(Math.min(usableW / 8.6, usableH / 10.6), 20, 62);
        const zScale = clamp((usableH * 0.58) / 410, 0.36, 0.88);
        const proj = {
          cx: stageW * 0.5,
          cy: 24 + usableH * 0.51,
          scale,
          zScale,
          calloutMargin,
          showCallouts,
        };

        const anchors = [];
        const halfW = 2.25;
        const halfD = 1.75;
        tctx.save();
        tctx.setLineDash([2, 4]);
        tctx.strokeStyle = p.hairline;
        tctx.lineWidth = 1;
        const corners = [
          [-halfW, -halfD],
          [halfW, -halfD],
          [-halfW, halfD],
          [halfW, halfD],
        ];
        for (let i = 0; i < corners.length; i += 1) {
          const p3 = isoProject(proj, corners[i][0], corners[i][1], 3, 0);
          const p1 = isoProject(proj, corners[i][0], corners[i][1], 1, 0);
          tctx.beginPath();
          tctx.moveTo(p3.x, p3.y);
          tctx.lineTo(p1.x, p1.y);
          tctx.stroke();
        }
        tctx.setLineDash([]);
        tctx.restore();

        function drawDeckSlab(deckNum, label) {
          const slabH = deckNum === 1 ? 10 : deckNum === 2 ? 8 : 6;
          drawIsoPrism(tctx, proj, 0, 0, halfW * 2, halfD * 2, slabH, deckNum, -slabH / proj.zScale, {
            top: deckNum === 3 ? p.glassTop : p.deckTop,
            left: deckNum === 3 ? p.glassLeft : p.deckLeft,
            right: deckNum === 3 ? p.glassRight : p.deckRight,
            edge: p.hairlineStrong,
            bevel: p.bevelTop,
          });
          tctx.beginPath();
          for (let gx = -2; gx <= 2; gx += 0.5) {
            const a = isoProject(proj, gx, -halfD, deckNum, 0);
            const b = isoProject(proj, gx, halfD, deckNum, 0);
            tctx.moveTo(a.x, a.y);
            tctx.lineTo(b.x, b.y);
          }
          for (let gy = -1.5; gy <= 1.5; gy += 0.5) {
            const a = isoProject(proj, -halfW, gy, deckNum, 0);
            const b = isoProject(proj, halfW, gy, deckNum, 0);
            tctx.moveTo(a.x, a.y);
            tctx.lineTo(b.x, b.y);
          }
          tctx.strokeStyle = p.deckGrid;
          tctx.lineWidth = 1;
          tctx.stroke();

          const eastTip = isoProject(proj, halfW + 0.08, -halfD + 0.06, deckNum, 0);
          tctx.font = '600 8.5px ' + FONT_MONO;
          tctx.fillStyle = p.ink3;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'alphabetic';
          tctx.fillText(label, eastTip.x + 4, eastTip.y + 3);
        }

        drawDeckSlab(1, 'D1 · HW');
        const hwCoords = [
          { gx: -1.35, gy: -0.75, w: 1.05, d: 0.72, side: 'left' },
          { gx: 0.05, gy: -0.85, w: 0.92, d: 0.68, side: 'left' },
          { gx: 1.32, gy: -0.68, w: 0.92, d: 0.68, side: 'right' },
          { gx: -0.65, gy: 0.45, w: 0.92, d: 0.68, side: 'left' },
          { gx: 0.95, gy: 0.45, w: 1.08, d: 0.72, side: 'right' },
        ];
        const hwPts = [];
        for (let i = 0; i < model.services.length && i < hwCoords.length; i += 1) {
          const svc = model.services[i];
          const hc = hwCoords[i];
          const isSel = hoveredId === svc.id || selectedId === svc.id;
          const ledCol =
            svc.status === 'ok' ? p.emerald : svc.status === 'warn' ? p.amber : p.vermilion;
          const geom = drawIsoPrism(tctx, proj, hc.gx, hc.gy, hc.w, hc.d, 8, 1, 0, {
            top: isSel ? p.p3 : p.hwTop,
            left: p.hwLeft,
            right: p.hwRight,
            edge: isSel ? ledCol : p.hairlineStrong,
            bevel: p.bevelTop,
            footprint: p.footprint,
            accentRim: isSel ? ledCol : null,
            strokeWidth: isSel ? 1.5 : 1,
          });
          const ledX = (geom.tW.x + geom.tS.x) * 0.5;
          const ledY = (geom.tW.y + geom.tS.y) * 0.5 + 3.5;
          tctx.fillStyle = ledCol;
          tctx.fillRect(ledX - 3, ledY - 1.5, 6, 3);

          hwPts.push({ id: svc.id, gx: hc.gx, gy: hc.gy, deck: 1 });
          stackHitTargets.push({ id: svc.id, poly: geom.poly });
          if (i === 0 || i === 4) {
            anchors.push({
              id: svc.id,
              side: hc.side,
              x: hc.side === 'left' ? geom.tW.x : geom.tE.x,
              y: hc.side === 'left' ? geom.tW.y : geom.tE.y,
              label: svc.name,
              sub: svc.stat,
              accent: ledCol,
            });
          }
        }

        for (let i = 0; i < Math.min(3, model.seats.length); i += 1) {
          const seat = model.seats[i];
          const gx0 = -1.78 + i * 1.24;
          const slotW = 1.1;
          const segCol =
            !seat.eligible || seat.headroomPct <= 15
              ? p.vermilion
              : seat.headroomPct < 50
                ? p.amber
                : p.emerald;
          const lit = Math.round((seat.headroomPct / 100) * 20);
          for (let s = 0; s < 20; s += 1) {
            const sgx = gx0 + 0.04 + ((s + 0.5) / 20) * (slotW - 0.08);
            const pt = isoProject(proj, sgx, 1.48, 1, 2 / proj.zScale);
            tctx.fillStyle = s < lit ? segCol : p.segOff;
            tctx.fillRect(pt.x - 1, pt.y - 1.2, 2.2, 2.4);
          }
        }

        const d2Anchors = [
          { gx: -1.1, gy: -0.6 },
          { gx: 0.1, gy: -0.4 },
          { gx: 1.15, gy: -0.5 },
          { gx: -0.6, gy: 0.55 },
          { gx: 0.85, gy: 0.45 },
        ];
        const downRoutes = [];
        for (let i = 0; i < Math.min(hwPts.length, d2Anchors.length); i += 1) {
          const pFrom = isoProject(proj, d2Anchors[i].gx, d2Anchors[i].gy, 2, 0);
          const pTo = isoProject(proj, hwPts[i].gx, hwPts[i].gy, 1, 8 / proj.zScale);
          const midY = (pFrom.y + pTo.y) * 0.5;
          const col = i % 2 === 0 ? p.amber : p.cyan;
          downRoutes.push({ pFrom, pTo, midY, col, i });

          tctx.beginPath();
          tctx.moveTo(pFrom.x, pFrom.y);
          tctx.lineTo(pFrom.x, midY);
          tctx.lineTo(pTo.x, midY);
          tctx.lineTo(pTo.x, pTo.y);
          tctx.strokeStyle = hexToRgba(col, 0.25);
          tctx.lineWidth = 1;
          tctx.stroke();
        }

        drawDeckSlab(2, 'D2 · AGENTS');
        const roomCoords = [
          { gx: -1.1, gy: -0.7, w: 0.96, d: 0.72, side: 'left' },
          { gx: 0.2, gy: -0.75, w: 0.92, d: 0.70, side: 'right' },
          { gx: 1.25, gy: 0.25, w: 0.96, d: 0.72, side: 'right' },
          { gx: -0.95, gy: 0.65, w: 0.92, d: 0.68, side: 'left' },
        ];
        const agentCoords = [
          { gx: -1.65, gy: -0.1, side: 'left' },
          { gx: -0.35, gy: -0.1, side: 'left' },
          { gx: 0.75, gy: -0.25, side: 'right' },
          { gx: 0.25, gy: 0.82, side: 'right' },
          { gx: -1.45, gy: 1.15, side: 'left' },
        ];

        for (let i = 0; i < Math.min(roomCoords.length, model.rooms.length); i += 1) {
          const rm = model.rooms[i];
          const rc = roomCoords[i];
          const acc = colorForNode(rm);
          const isSel = hoveredId === rm.id || selectedId === rm.id;
          const geom = drawIsoPrism(tctx, proj, rc.gx, rc.gy, rc.w, rc.d, 6, 2, 0, {
            top: isSel ? p.p3 : p.p2,
            left: p.deckLeft,
            right: p.deckRight,
            edge: isSel ? acc : p.hairlineStrong,
            bevel: p.bevelTop,
            footprint: p.footprint,
            accentRim: rm.blockedCount > 0 ? hexToRgba(p.vermilion, 0.75) : null,
          });
          stackHitTargets.push({ id: rm.id, poly: geom.poly });
          if (i < 2) {
            anchors.push({
              id: rm.id,
              side: rc.side,
              x: rc.side === 'left' ? geom.tW.x : geom.tE.x,
              y: rc.side === 'left' ? geom.tW.y : geom.tE.y,
              label: rm.shortLabel,
              sub: rm.metric,
              accent: acc,
            });
          }
        }

        for (let i = 0; i < Math.min(agentCoords.length, model.agents.length); i += 1) {
          const ag = model.agents[i];
          const ac = agentCoords[i];
          const col = colorForNode(ag);
          const isSel = hoveredId === ag.id || selectedId === ag.id;
          const geom = drawIsoPrism(tctx, proj, ac.gx, ac.gy, 0.44, 0.44, 11, 2, 0, {
            top: isSel ? col : hexToRgba(col, p.dark ? 0.28 : 0.22),
            left: hexToRgba(col, 0.50),
            right: hexToRgba(col, 0.34),
            edge: col,
            bevel: p.bevelTop,
            footprint: p.footprint,
            strokeWidth: isSel ? 1.6 : 1.1,
          });
          tctx.font = '600 8.5px ' + FONT_MONO;
          tctx.fillStyle = isSel ? (p.dark ? '#0a0a0c' : '#ffffff') : p.ink1;
          tctx.textAlign = 'center';
          tctx.textBaseline = 'middle';
          tctx.fillText(ag.glyph, geom.centerTop.x, geom.centerTop.y);
          stackHitTargets.push({ id: ag.id, poly: geom.poly });
          if (i < 3) {
            anchors.push({
              id: ag.id,
              side: ac.side,
              x: ac.side === 'left' ? geom.tW.x : geom.tE.x,
              y: ac.side === 'left' ? geom.tW.y : geom.tE.y,
              label: ag.shortLabel,
              sub: ag.metric,
              accent: col,
            });
          }
        }

        // Decision anchors + diamond bases (drawn dynamically for gentle bob if motion enabled)
        for (let i = 0; i < Math.min(4, model.decisions.length); i += 1) {
          const dec = model.decisions[i];
          const dgx = 0.72 + (i % 2) * 0.52;
          const dgy = -0.75 + Math.floor(i / 2) * 0.55;
          const pDia = isoProject(proj, dgx, dgy, 2, 26 / proj.zScale);
          const r = 8;
          stackHitTargets.push({
            id: dec.id,
            poly: [
              { x: pDia.x, y: pDia.y - r },
              { x: pDia.x + r, y: pDia.y },
              { x: pDia.x, y: pDia.y + r },
              { x: pDia.x - r, y: pDia.y },
            ],
          });
          if (i === 0) {
            anchors.push({
              id: dec.id,
              side: 'right',
              x: pDia.x + r,
              y: pDia.y,
              label: model.decisions.filter((d) => !d.stamped).length + ' Open Decisions',
              sub: model.decisions.slice(0, 3).map((x) => '#' + x.decId).join(' · '),
              accent: colorForNode(dec),
            });
          }
        }

        const storeCoords = [
          { gx: -1.3, gy: -0.6, w: 1.0, d: 0.72, h: 14, side: 'left' },
          { gx: 0.0, gy: -0.7, w: 0.95, d: 0.70, h: 12, side: 'left' },
          { gx: 1.25, gy: -0.5, w: 0.92, d: 0.68, h: 10, side: 'right' },
          { gx: -0.65, gy: 0.6, w: 0.92, d: 0.68, h: 11, side: 'left' },
          { gx: 0.85, gy: 0.55, w: 0.98, d: 0.70, h: 13, side: 'right' },
        ];
        const upRoutes = [];
        for (let i = 0; i < Math.min(storeCoords.length, d2Anchors.length); i += 1) {
          const pFrom = isoProject(proj, d2Anchors[i].gx, d2Anchors[i].gy, 2, 10 / proj.zScale);
          const pTo = isoProject(proj, storeCoords[i].gx, storeCoords[i].gy, 3, 0);
          const midY = (pFrom.y + pTo.y) * 0.5;
          const col = i % 2 === 0 ? p.emerald : p.violet;
          upRoutes.push({ pFrom, pTo, midY, col, i });

          tctx.beginPath();
          tctx.moveTo(pFrom.x, pFrom.y);
          tctx.lineTo(pFrom.x, midY);
          tctx.lineTo(pTo.x, midY);
          tctx.lineTo(pTo.x, pTo.y);
          tctx.strokeStyle = hexToRgba(col, 0.28);
          tctx.lineWidth = 1;
          tctx.stroke();
        }

        drawDeckSlab(3, 'D3 · MIND');
        for (let i = 0; i < Math.min(storeCoords.length, model.stores.length); i += 1) {
          const st = model.stores[i];
          const sc = storeCoords[i];
          const acc = colorForNode(st);
          const isSel = hoveredId === st.id || selectedId === st.id;
          const geom = drawIsoPrism(tctx, proj, sc.gx, sc.gy, sc.w, sc.d, sc.h, 3, 0, {
            top: isSel ? hexToRgba(acc, 0.25) : p.glassTop,
            left: p.glassLeft,
            right: p.glassRight,
            edge: isSel ? acc : hexToRgba(acc, 0.58),
            bevel: p.bevelTop,
            accentRim: acc,
            footprint: p.footprint,
            strokeWidth: isSel ? 1.5 : 1,
          });
          tctx.font = '600 9px ' + FONT_MONO;
          tctx.fillStyle = p.ink1;
          tctx.textAlign = 'center';
          tctx.textBaseline = 'middle';
          tctx.fillText(st.metric, geom.centerTop.x, geom.centerTop.y);
          stackHitTargets.push({ id: st.id, poly: geom.poly });
          if (i === 0 || i === 1 || i === 4) {
            anchors.push({
              id: st.id,
              side: sc.side,
              x: sc.side === 'left' ? geom.tW.x : geom.tE.x,
              y: sc.side === 'left' ? geom.tW.y : geom.tE.y,
              label: st.label,
              sub: st.metric + ' · ' + st.sub,
              accent: acc,
            });
          }
        }

        if (proj.showCallouts) {
          drawStackCallouts(tctx, proj, p, anchors, areaH);
        }

        drawOscilloscope(tctx, 10, areaH + 4, stageW - 20, scopeStripH - 8, true);
        lastStackDynamicMeta = { docked: false, proj, downRoutes, upRoutes };
      }

      function drawStackDynamic() {
        if (!ctx || !lastStackDynamicMeta || lastStackDynamicMeta.docked) return;
        const p = pal();
        const { proj, downRoutes, upRoutes } = lastStackDynamicMeta;
        const tSec = isMotionEnabled() ? elapsedMs / 1000 : 2.1;

        for (let idx = 0; idx < downRoutes.length; idx += 1) {
          const rt = downRoutes[idx];
          for (let k = 0; k < 2; k += 1) {
            const u = (tSec * 0.42 + rt.i * 0.21 + k * 0.5) % 1;
            const pt = sampleDogleg(rt.pFrom, rt.pTo, rt.midY, u);
            const ptT = sampleDogleg(rt.pFrom, rt.pTo, rt.midY, Math.max(0, u - 0.08));
            ctx.beginPath();
            ctx.moveTo(ptT.x, ptT.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.strokeStyle = rt.col;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = p.dark ? '#ffffff' : rt.col;
            ctx.fillRect(pt.x - 1.8, pt.y - 1.8, 3.6, 3.6);
          }
        }

        for (let idx = 0; idx < upRoutes.length; idx += 1) {
          const rt = upRoutes[idx];
          for (let k = 0; k < 2; k += 1) {
            const u = (tSec * 0.46 + rt.i * 0.19 + k * 0.5) % 1;
            const pt = sampleDogleg(rt.pFrom, rt.pTo, rt.midY, u);
            const ptT = sampleDogleg(rt.pFrom, rt.pTo, rt.midY, Math.max(0, u - 0.08));
            ctx.beginPath();
            ctx.moveTo(ptT.x, ptT.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.strokeStyle = rt.col;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = p.dark ? '#ffffff' : rt.col;
            ctx.fillRect(pt.x - 1.8, pt.y - 1.8, 3.6, 3.6);
          }
        }

        // Decision diamonds floating above D2
        for (let i = 0; i < Math.min(4, model.decisions.length); i += 1) {
          const dec = model.decisions[i];
          const dgx = 0.72 + (i % 2) * 0.52;
          const dgy = -0.75 + Math.floor(i / 2) * 0.55;
          const bob = isMotionEnabled() ? Math.sin(tSec * 2.2 + i * 1.4) * 2.0 : 0;
          const elev = 18 + bob;
          const pFloor = isoProject(proj, dgx, dgy, 2, 8 / proj.zScale);
          const pDia = isoProject(proj, dgx, dgy, 2, (8 + elev) / proj.zScale);
          const col = colorForNode(dec);
          const isSel = hoveredId === dec.id || selectedId === dec.id;

          ctx.beginPath();
          ctx.moveTo(pFloor.x, pFloor.y);
          ctx.lineTo(pDia.x, pDia.y + 7);
          ctx.strokeStyle = hexToRgba(col, 0.65);
          ctx.lineWidth = 1;
          ctx.stroke();

          const r = isSel ? 8.5 : 7;
          const top = { x: pDia.x, y: pDia.y - r };
          const right = { x: pDia.x + r * 0.85, y: pDia.y };
          const bot = { x: pDia.x, y: pDia.y + r };
          const left = { x: pDia.x - r * 0.85, y: pDia.y };
          const mid = { x: pDia.x, y: pDia.y + 1.5 };

          ctx.beginPath();
          ctx.moveTo(top.x, top.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.lineTo(left.x, left.y);
          ctx.closePath();
          ctx.fillStyle = dec.stamped ? p.emeraldHi : p.vermilionHi;
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(top.x, top.y);
          ctx.lineTo(right.x, right.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(left.x, left.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.lineTo(bot.x, bot.y);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(col, 0.72);
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(right.x, right.y);
          ctx.lineTo(bot.x, bot.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(col, 0.52);
          ctx.fill();
        }
      }

      function drawStackDockedElevation(tctx, p, areaH) {
        const pad = 10;
        const bandGap = 8;
        const bandH = (areaH - pad * 2 - bandGap * 2) / 3;
        const bandW = stageW - pad * 2;
        const bands = [
          {
            deck: 3,
            title: 'D3 · MIND STORES',
            y: pad,
            accent: p.emerald,
            items: model.stores.map((s) => ({
              id: s.id,
              label: s.label,
              sub: s.metric,
              color: colorForNode(s),
            })),
          },
          {
            deck: 2,
            title: 'D2 · AGENTS, ROOMS & ' + model.decisions.length + ' DECISIONS',
            y: pad + bandH + bandGap,
            accent: p.cyan,
            items: model.agents.slice(0, 5).map((a) => ({
              id: a.id,
              label: a.shortLabel,
              sub: a.metric,
              color: colorForNode(a),
            })),
          },
          {
            deck: 1,
            title: 'D1 · HARDWARE SLABS & SEATS',
            y: pad + (bandH + bandGap) * 2,
            accent: p.amber,
            items: model.services.map((s) => ({
              id: s.id,
              label: s.short,
              sub: s.stat,
              color: s.status === 'ok' ? p.emerald : s.status === 'warn' ? p.amber : p.vermilion,
            })),
          },
        ];

        for (let b = 0; b < bands.length; b += 1) {
          const bd = bands[b];
          roundRectPath(tctx, pad, bd.y, bandW, bandH, 4);
          tctx.fillStyle = p.p1;
          tctx.fill();
          tctx.strokeStyle = p.hairlineStrong;
          tctx.lineWidth = 1;
          tctx.stroke();

          tctx.fillStyle = bd.accent;
          tctx.fillRect(pad, bd.y + 1, 3, bandH - 2);

          tctx.font = '600 8.5px ' + FONT_MONO;
          tctx.fillStyle = p.ink3;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'alphabetic';
          tctx.fillText(bd.title, pad + 9, bd.y + 13);

          const rowY = bd.y + 19;
          const rowH = Math.max(20, bandH - 24);
          const count = Math.max(1, bd.items.length);
          const gap = 5;
          const cellW = (bandW - 18 - gap * (count - 1)) / count;

          for (let i = 0; i < bd.items.length; i += 1) {
            const it = bd.items[i];
            const cx = pad + 9 + i * (cellW + gap);
            const isSel = hoveredId === it.id || selectedId === it.id;

            roundRectPath(tctx, cx, rowY, cellW, rowH, 3);
            tctx.fillStyle = isSel ? p.p3 : p.p2;
            tctx.fill();
            tctx.strokeStyle = isSel ? it.color : p.hairline;
            tctx.lineWidth = 1;
            tctx.stroke();

            tctx.save();
            tctx.beginPath();
            tctx.rect(cx + 2, rowY + 1, Math.max(1, cellW - 4), Math.max(1, rowH - 2));
            tctx.clip();

            tctx.fillStyle = it.color;
            tctx.fillRect(cx + 5, rowY + 5, 4.5, 4.5);

            tctx.font = '600 9px ' + FONT_SANS;
            tctx.fillStyle = p.ink1;
            tctx.textAlign = 'left';
            tctx.fillText(fitText(tctx, it.label, cellW - 10), cx + 5, rowY + Math.min(rowH - 11, 21));

            tctx.font = '400 8px ' + FONT_MONO;
            tctx.fillStyle = p.ink3;
            tctx.fillText(fitText(tctx, it.sub, cellW - 10), cx + 5, rowY + Math.min(rowH - 4, 32));
            tctx.restore();

            stackCalloutTargets.push({ id: it.id, x: cx, y: rowY, w: cellW, h: rowH });
          }
        }
      }

      function drawStackCallouts(tctx, proj, p, anchors, areaH) {
        const leftList = anchors.filter((a) => a.side === 'left').sort((a, b) => a.y - b.y);
        const rightList = anchors.filter((a) => a.side === 'right').sort((a, b) => a.y - b.y);
        const minPitch = 28;
        const topBound = 24;
        const botBound = areaH - 22;

        function solveY(list) {
          if (!list.length) return [];
          const ys = list.map((it) => clamp(it.y, topBound, botBound));
          for (let i = 1; i < ys.length; i += 1) {
            if (ys[i] - ys[i - 1] < minPitch) ys[i] = ys[i - 1] + minPitch;
          }
          if (ys[ys.length - 1] > botBound) {
            ys[ys.length - 1] = botBound;
            for (let i = ys.length - 2; i >= 0; i -= 1) {
              if (ys[i + 1] - ys[i] < minPitch) ys[i] = ys[i + 1] - minPitch;
            }
          }
          return ys;
        }

        const leftEdgeX = Math.min(proj.calloutMargin - 8, 168);
        const rightEdgeX = Math.max(stageW - proj.calloutMargin + 8, stageW - 168);

        function renderSide(list, ys, isLeft) {
          for (let i = 0; i < list.length; i += 1) {
            const it = list[i];
            const ly = ys[i];
            const isFocus = hoveredId === it.id || selectedId === it.id;
            const targetX = isLeft ? leftEdgeX : rightEdgeX;
            const dy = ly - it.y;
            const signX = isLeft ? -1 : 1;
            const maxDiag = Math.max(8, Math.abs(targetX - it.x) - 12);
            const diag = Math.min(Math.abs(dy), maxDiag);
            const ex = it.x + signX * diag;
            const ey = it.y + (dy >= 0 ? 1 : -1) * diag;

            tctx.save();
            tctx.beginPath();
            tctx.moveTo(it.x, it.y);
            tctx.lineTo(ex, ey);
            if (Math.abs(ey - ly) > 0.5) tctx.lineTo(ex, ly);
            tctx.lineTo(targetX, ly);
            tctx.strokeStyle = isFocus ? it.accent : p.hairlineStrong;
            tctx.lineWidth = isFocus ? 1.4 : 1;
            tctx.stroke();

            tctx.fillStyle = it.accent;
            tctx.fillRect(it.x - 1.8, it.y - 1.8, 3.6, 3.6);

            const boxW = Math.min(152, proj.calloutMargin - 16);
            const boxH = 22;
            const boxX = isLeft ? targetX - boxW - 4 : targetX + 4;
            const boxY = ly - boxH * 0.5;

            tctx.fillStyle = isFocus ? p.p3 : p.p1;
            tctx.fillRect(boxX, boxY, boxW, boxH);
            tctx.strokeStyle = isFocus ? it.accent : p.hairline;
            tctx.lineWidth = 1;
            tctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

            tctx.fillStyle = it.accent;
            tctx.fillRect(isLeft ? boxX + boxW - 2 : boxX, boxY, 2, boxH);

            const tx = isLeft ? boxX + boxW - 6 : boxX + 6;
            tctx.textAlign = isLeft ? 'right' : 'left';
            tctx.textBaseline = 'alphabetic';
            tctx.font = '600 9.5px ' + FONT_SANS;
            tctx.fillStyle = p.ink1;
            tctx.fillText(fitText(tctx, it.label, boxW - 12), tx, boxY + 9.5);
            tctx.font = '400 8px ' + FONT_MONO;
            tctx.fillStyle = p.ink3;
            tctx.fillText(fitText(tctx, it.sub, boxW - 12), tx, boxY + 18.5);

            stackCalloutTargets.push({ id: it.id, x: boxX, y: boxY, w: boxW, h: boxH });
            tctx.restore();
          }
        }

        renderSide(leftList, solveY(leftList), true);
        renderSide(rightList, solveY(rightList), false);
      }

      // ======================================================================
      // LENS 3: SCORE (STATIC/DYNAMIC SPLIT + BRUSHABLE WINDOW + C1 MARKS)
      // ======================================================================

      function buildScoreLanes(tapeTop, tapeH, docked) {
        const groups = [
          {
            title: 'HUMANS',
            lanes: model.askers.slice(0, 1).map((a) => ({
              id: a.id,
              glyph: a.glyph,
              label: a.shortLabel,
              colorKey: a.brand,
              node: a,
            })),
          },
          {
            title: 'AGENTS',
            lanes: model.agents.slice(0, docked ? 3 : 4).map((a) => ({
              id: a.id,
              glyph: a.glyph,
              label: a.shortLabel,
              colorKey: a.brand,
              node: a,
            })),
          },
          {
            title: 'ROOMS',
            lanes: model.rooms.slice(0, docked ? 3 : 4).map((r) => ({
              id: r.id,
              glyph: '#',
              label: r.shortLabel,
              colorKey: r.blockedCount > 0 ? 'vermilion' : 'codex',
              node: r,
            })),
          },
          {
            title: 'MIND',
            lanes: model.stores.slice(0, docked ? 2 : 3).map((s) => ({
              id: s.id,
              glyph: s.glyph,
              label: s.label,
              colorKey: s.accentKey || 'emerald',
              node: s,
            })),
          },
        ];

        const totalLanes = groups.reduce((acc, g) => acc + g.lanes.length, 0);
        const groupHdrH = docked ? 13 : 16;
        const availForLanes = Math.max(80, tapeH - groupHdrH * groups.length);
        const laneH = clamp(Math.floor(availForLanes / Math.max(1, totalLanes)), 15, 28);

        const flat = [];
        const laneById = Object.create(null);
        const groupHeaders = [];
        let curY = tapeTop;

        for (let g = 0; g < groups.length; g += 1) {
          groupHeaders.push({ title: groups[g].title, y: curY, h: groupHdrH });
          curY += groupHdrH;
          for (let i = 0; i < groups[g].lanes.length; i += 1) {
            const ln = groups[g].lanes[i];
            const entry = {
              id: ln.id,
              glyph: ln.glyph,
              label: ln.label,
              colorKey: ln.colorKey,
              node: ln.node,
              y: curY,
              h: laneH,
              cy: curY + laneH * 0.5,
            };
            flat.push(entry);
            laneById[entry.id] = entry;
            curY += laneH;
          }
        }
        return { flat, laneById, groupHeaders };
      }

      function drawScoreStatic(tctx) {
        const p = pal();
        scoreHitTargets = [];

        const docked = isDockedLayout();
        const railW = docked ? clamp(Math.floor(stageW * 0.26), 98, 132) : clamp(Math.floor(stageW * 0.19), 148, 188);
        const rulerH = docked ? 18 : 22;
        const scopeH = clamp(Math.round(stageH * 0.24), 62, 92);
        const tapeH = Math.max(120, stageH - scopeH - rulerH);
        const tapeX = railW;
        const tapeW = Math.max(120, stageW - railW);

        const nowX = Math.floor(tapeX + tapeW * 0.82) + 0.5;
        const pastSec = 360;
        const pxPerSec = (tapeW * 0.82) / pastSec;
        const timeToX = (tSec) => nowX + (tSec - scoreSimSec) * pxPerSec;
        const xToTime = (px) => scoreSimSec + (px - nowX) / pxPerSec;

        scoreLastMetrics = { railW, rulerH, scopeH, tapeH, tapeX, tapeW, nowX, pxPerSec, timeToX, xToTime };

        tctx.fillStyle = p.p0;
        tctx.fillRect(0, 0, stageW, stageH);

        tctx.fillStyle = p.p1;
        tctx.fillRect(0, 0, railW, stageH);
        tctx.strokeStyle = p.hairlineStrong;
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(railW - 0.5, 0);
        tctx.lineTo(railW - 0.5, stageH);
        tctx.stroke();

        tctx.fillStyle = p.p2;
        tctx.fillRect(0, 0, stageW, rulerH);
        tctx.strokeStyle = p.hairline;
        tctx.beginPath();
        tctx.moveTo(0, rulerH - 0.5);
        tctx.lineTo(stageW, rulerH - 0.5);
        tctx.stroke();

        tctx.font = '600 8.5px ' + FONT_MONO;
        tctx.fillStyle = p.ink3;
        tctx.textAlign = 'left';
        tctx.textBaseline = 'middle';
        tctx.fillText('SWIMLANES · 6m', 8, rulerH * 0.5);

        tctx.fillStyle = p.dark ? 'rgba(255,255,255,0.018)' : 'rgba(15,18,26,0.03)';
        tctx.fillRect(nowX, rulerH, stageW - nowX, stageH - rulerH);

        const { flat, laneById, groupHeaders } = buildScoreLanes(rulerH, tapeH, docked);
        scoreLastMetrics.laneById = laneById;
        scoreLastMetrics.flat = flat;

        for (let g = 0; g < groupHeaders.length; g += 1) {
          const gh = groupHeaders[g];
          tctx.fillStyle = p.p2;
          tctx.fillRect(0, gh.y, railW - 1, gh.h);
          tctx.fillStyle = p.dark ? 'rgba(255,255,255,0.025)' : 'rgba(15,18,26,0.03)';
          tctx.fillRect(tapeX, gh.y, tapeW, gh.h);
          tctx.strokeStyle = p.hairline;
          tctx.beginPath();
          tctx.moveTo(0, gh.y + gh.h - 0.5);
          tctx.lineTo(stageW, gh.y + gh.h - 0.5);
          tctx.stroke();

          tctx.font = '600 8px ' + FONT_MONO;
          tctx.fillStyle = p.ink3;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText(gh.title, 8, gh.y + gh.h * 0.5);
        }

        for (let i = 0; i < flat.length; i += 1) {
          const ln = flat[i];
          const isFocus = hoveredId === ln.id || selectedId === ln.id;
          if (isFocus) {
            tctx.fillStyle = p.p2;
            tctx.fillRect(0, ln.y, railW - 1, ln.h);
            tctx.fillStyle = p.dark ? 'rgba(255,255,255,0.03)' : 'rgba(15,18,26,0.035)';
            tctx.fillRect(tapeX, ln.y, tapeW, ln.h);
          }

          tctx.strokeStyle = p.hairline;
          tctx.lineWidth = 0.65;
          tctx.beginPath();
          tctx.moveTo(0, ln.y + ln.h - 0.5);
          tctx.lineTo(stageW, ln.y + ln.h - 0.5);
          tctx.stroke();

          const col = colorForBrand(ln.colorKey);
          tctx.fillStyle = col;
          tctx.fillRect(6, ln.cy - 4, 2.5, 8);

          tctx.font = '500 ' + (docked ? '8.5' : '10') + 'px ' + FONT_MONO;
          tctx.fillStyle = p.ink1;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText(fitText(tctx, ln.label, railW - 18), 13, ln.cy + 0.5);

          scoreHitTargets.push({ id: ln.id, x: 0, y: ln.y, w: railW, h: ln.h });
        }

        const baseClock = Math.floor(model.refNowMs / 1000) + scoreSimSec;
        const stepSec = 60;
        const firstTick = Math.floor((scoreSimSec - pastSec) / stepSec) * stepSec;
        const endTick = scoreSimSec + (stageW - nowX) / pxPerSec;
        tctx.font = '500 8.5px ' + FONT_MONO;
        for (let t = firstTick; t <= endTick; t += stepSec) {
          const x = Math.floor(timeToX(t)) + 0.5;
          if (x < tapeX + 4 || x > stageW - 4) continue;
          tctx.strokeStyle = p.hairline;
          tctx.lineWidth = 0.8;
          tctx.beginPath();
          tctx.moveTo(x, rulerH - 4);
          tctx.lineTo(x, stageH);
          tctx.stroke();

          if (Math.abs(x - nowX) > 34 && x + 46 < stageW) {
            tctx.fillStyle = t > scoreSimSec ? p.ink4 : p.ink3;
            tctx.textAlign = 'left';
            tctx.textBaseline = 'middle';
            const lbl = t > scoreSimSec ? '+' + Math.round((t - scoreSimSec) / 60) + 'm' : formatClock(baseClock - (scoreSimSec - t));
            tctx.fillText(lbl, x + 3, rulerH * 0.5);
          }
        }

        // Agent run capsules
        for (let i = 0; i < model.agents.length; i += 1) {
          const ag = model.agents[i];
          const ln = laneById[ag.id];
          if (!ln) continue;
          const runStartSec = scoreSimSec - (195 - i * 38);
          const isRunning = ag.active || i < 2;
          const runEndSec = isRunning ? scoreSimSec : scoreSimSec - (32 + i * 16);
          const x1 = Math.max(tapeX + 2, timeToX(runStartSec));
          const x2 = Math.min(nowX, timeToX(runEndSec));
          if (x2 <= x1 + 4) continue;
          const col = colorForNode(ag);

          roundRectPath(tctx, x1, ln.y + 3, x2 - x1, ln.h - 6, 3.5);
          tctx.fillStyle = hexToRgba(col, isRunning ? 0.22 : 0.13);
          tctx.fill();
          tctx.strokeStyle = hexToRgba(col, isRunning ? 0.88 : 0.52);
          tctx.lineWidth = 1;
          tctx.stroke();

          if (isRunning && x2 >= nowX - 2) {
            tctx.fillStyle = col;
            tctx.fillRect(Math.floor(x2) - 2, ln.y + 4, 2, ln.h - 8);
          }
          if (x2 - x1 > 56) {
            tctx.font = '500 8.5px ' + FONT_MONO;
            tctx.fillStyle = p.ink1;
            tctx.textAlign = 'left';
            tctx.fillText(fitText(tctx, ag.sub || ag.shortLabel, x2 - x1 - 12), x1 + 5, ln.cy + 0.5);
          }
        }

        // Persistent Decision Ledger Marks curving into MIND/Codex
        const codexLn = laneById['store:codex'] || flat[flat.length - 1];
        for (let i = 0; i < model.decisions.length; i += 1) {
          const dec = model.decisions[i];
          if (!dec.stamped || !codexLn) continue;
          const srcLn = laneById['room:' + dec.channel] || flat[Math.min(flat.length - 2, 2 + i)];
          if (!srcLn) continue;
          const arc = scoreStampArcs[dec.id] || { atSec: scoreSimSec - 16 - i * 18, progress: 1 };
          const sx = clamp(timeToX(arc.atSec), tapeX + 12, nowX - 10);
          const col = colorForNode(dec);

          tctx.save();
          tctx.strokeStyle = col;
          tctx.lineWidth = 1.6;
          tctx.beginPath();
          tctx.moveTo(sx, srcLn.cy);
          tctx.quadraticCurveTo(sx + 38, (srcLn.cy + codexLn.cy) * 0.5, sx, codexLn.cy);
          tctx.stroke();

          // Emerald ledger diamond marker
          tctx.beginPath();
          tctx.moveTo(sx, srcLn.cy - 4.5);
          tctx.lineTo(sx + 4.5, srcLn.cy);
          tctx.lineTo(sx, srcLn.cy + 4.5);
          tctx.lineTo(sx - 4.5, srcLn.cy);
          tctx.closePath();
          tctx.fillStyle = col;
          tctx.fill();
          tctx.restore();
        }

        // Waiting vermilion decision diamonds riding the NOW-line
        for (let i = 0; i < model.decisions.length; i += 1) {
          const dec = model.decisions[i];
          if (dec.stamped) continue;
          const targetLn = laneById['room:' + dec.channel] || flat[Math.min(flat.length - 1, 2 + i)];
          if (!targetLn) continue;
          const tailLen = clamp(32 + i * 24, 28, tapeW * 0.35);
          const cy = targetLn.cy;
          const isSel = hoveredId === dec.id || selectedId === dec.id;

          let tGrad = p.vermilion;
          if (typeof tctx.createLinearGradient === 'function') {
            tGrad = tctx.createLinearGradient(nowX - tailLen, cy, nowX, cy);
            tGrad.addColorStop(0, hexToRgba(p.vermilion, 0.10));
            tGrad.addColorStop(1, p.vermilion);
          }
          tctx.strokeStyle = tGrad;
          tctx.lineWidth = isSel ? 2.4 : 1.7;
          tctx.beginPath();
          tctx.moveTo(nowX - tailLen, cy);
          tctx.lineTo(nowX - 6, cy);
          tctx.stroke();

          const r = isSel ? 6 : 5;
          tctx.beginPath();
          tctx.moveTo(nowX, cy - r);
          tctx.lineTo(nowX + r, cy);
          tctx.lineTo(nowX, cy + r);
          tctx.lineTo(nowX - r, cy);
          tctx.closePath();
          tctx.fillStyle = p.vermilion;
          tctx.fill();
          tctx.strokeStyle = '#ffffff';
          tctx.lineWidth = 1;
          tctx.stroke();

          const tag = '#' + dec.decId;
          tctx.font = '600 8.5px ' + FONT_MONO;
          const tw = Math.ceil(tctx.measureText(tag).width) + 7;
          const tx = nowX - tw - 9;
          roundRectPath(tctx, tx, targetLn.y + 3, tw, targetLn.h - 6, 3);
          tctx.fillStyle = p.p1;
          tctx.fill();
          tctx.strokeStyle = isSel ? p.vermilion : p.vermilionEdge;
          tctx.lineWidth = 1;
          tctx.stroke();
          tctx.fillStyle = p.vermilionHi;
          tctx.textAlign = 'left';
          tctx.textBaseline = 'middle';
          tctx.fillText(tag, tx + 3.5, cy + 0.5);

          scoreHitTargets.push({ id: dec.id, x: tx - 2, y: targetLn.y, w: tw + 18, h: targetLn.h });
        }

        // Vermilion NOW hairline
        tctx.strokeStyle = p.vermilion;
        tctx.lineWidth = 1.5;
        tctx.beginPath();
        tctx.moveTo(nowX, 0);
        tctx.lineTo(nowX, stageH);
        tctx.stroke();

        roundRectPath(tctx, nowX - 16, 2.5, 32, rulerH - 5, 3);
        tctx.fillStyle = p.vermilion;
        tctx.fill();
        tctx.font = '600 8.5px ' + FONT_MONO;
        tctx.fillStyle = '#ffffff';
        tctx.textAlign = 'center';
        tctx.textBaseline = 'middle';
        tctx.fillText('NOW', nowX, rulerH * 0.5 + 0.5);

        // Shared-Axis Host Scope beneath Score tape
        const scopeTop = rulerH + tapeH;
        tctx.strokeStyle = p.hairlineStrong;
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(0, scopeTop + 0.5);
        tctx.lineTo(stageW, scopeTop + 0.5);
        tctx.stroke();

        const latest = scopeSamples.length > 0 ? scopeSamples[scopeSamples.length - 1] : null;
        const curRatio = latest ? latest.loadRatio : model.host.loadRatio;
        const curMem = latest ? latest.memGib : model.host.memAvailableGib;

        tctx.font = '600 8px ' + FONT_MONO;
        tctx.fillStyle = p.ink3;
        tctx.textAlign = 'left';
        tctx.textBaseline = 'alphabetic';
        tctx.fillText('HOST SCOPE', 8, scopeTop + 14);
        tctx.font = '600 14px ' + FONT_MONO;
        tctx.fillStyle = loadColor(curRatio);
        tctx.fillText(curRatio.toFixed(2) + 'x', 8, scopeTop + 33);
        tctx.font = '400 8.5px ' + FONT_MONO;
        tctx.fillStyle = p.ink2;
        tctx.fillText('MEM ' + curMem.toFixed(1) + 'G', 8, scopeTop + 48);

        const plotTop = scopeTop + 8;
        const plotH = Math.max(24, scopeH - 16);
        const maxRatio = Math.max(2.5, curRatio * 1.2);
        const yForRatio = (r) => plotTop + (1 - clamp(r, 0, maxRatio) / maxRatio) * plotH;
        const yForMem = (g) => plotTop + (1 - clamp(g / Math.max(1, model.host.memTotalGib), 0, 1)) * plotH;

        const yCap = Math.floor(yForRatio(1.0)) + 0.5;
        tctx.save();
        tctx.setLineDash([4, 3]);
        tctx.strokeStyle = hexToRgba(p.vermilion, 0.45);
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(tapeX, yCap);
        tctx.lineTo(stageW, yCap);
        tctx.stroke();
        tctx.setLineDash([]);
        tctx.font = '500 8px ' + FONT_MONO;
        tctx.fillStyle = p.vermilionHi;
        tctx.fillText('1.0x', tapeX + 4, yCap - 3);
        tctx.restore();

        if (scopeSamples.length > 1) {
          const spanX = nowX - tapeX;
          tctx.beginPath();
          for (let i = 0; i < scopeSamples.length; i += 1) {
            const sx = tapeX + (i / (scopeSamples.length - 1)) * spanX;
            const sy = yForMem(scopeSamples[i].memGib);
            if (i === 0) tctx.moveTo(sx, sy);
            else tctx.lineTo(sx, sy);
          }
          tctx.strokeStyle = hexToRgba(p.teal, 0.68);
          tctx.lineWidth = 1.2;
          tctx.stroke();

          for (let i = 1; i < scopeSamples.length; i += 1) {
            const xA = tapeX + ((i - 1) / (scopeSamples.length - 1)) * spanX;
            const xB = tapeX + (i / (scopeSamples.length - 1)) * spanX;
            const yA = yForRatio(scopeSamples[i - 1].loadRatio);
            const yB = yForRatio(scopeSamples[i].loadRatio);
            const col = loadColor(scopeSamples[i].loadRatio);
            tctx.beginPath();
            tctx.moveTo(xA, yA);
            tctx.lineTo(xB, yB);
            tctx.strokeStyle = hexToRgba(col, 0.18);
            tctx.lineWidth = 3;
            tctx.stroke();

            tctx.beginPath();
            tctx.moveTo(xA, yA);
            tctx.lineTo(xB, yB);
            tctx.strokeStyle = col;
            tctx.lineWidth = 1.3;
            tctx.stroke();
          }

          tctx.fillStyle = loadColor(curRatio);
          tctx.beginPath();
          tctx.arc(nowX, yForRatio(curRatio), 3, 0, TWO_PI);
          tctx.fill();
        }
      }

      function drawScoreDynamic(now) {
        if (!ctx || !scoreLastMetrics) return;
        const p = pal();
        const { rulerH, tapeX, nowX, timeToX, laneById } = scoreLastMetrics;

        // Dynamic causal vertical beams
        for (let i = 0; i < scoreBeams.length; i += 1) {
          const bm = scoreBeams[i];
          const fromLn = laneById[bm.fromId];
          const toLn = laneById[bm.toId];
          if (!fromLn || !toLn) continue;
          const bx = Math.floor(timeToX(bm.timeSec)) + 0.5;
          if (bx < tapeX + 2 || bx > nowX + 2) continue;

          const col = colorForBrand(bm.brand);
          const drawFrac = bm.drawnAtMs > 0 ? clamp((now - bm.drawnAtMs) / 110, 0.08, 1) : 1;
          const y1 = fromLn.cy;
          const y2 = toLn.cy;
          const curY2 = y1 + (y2 - y1) * drawFrac;
          const dir = y2 >= y1 ? 1 : -1;

          ctx.strokeStyle = hexToRgba(col, 0.86);
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(bx, y1);
          ctx.lineTo(bx, curY2);
          ctx.stroke();

          ctx.fillStyle = p.p0;
          ctx.beginPath();
          ctx.arc(bx, y1, 2.5, 0, TWO_PI);
          ctx.fill();
          ctx.strokeStyle = col;
          ctx.stroke();

          if (drawFrac > 0.85) {
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(bx, y2, 2.5, 0, TWO_PI);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(bx - 2.8, y2 - dir * 5);
            ctx.lineTo(bx, y2 - dir * 2);
            ctx.lineTo(bx + 2.8, y2 - dir * 5);
            ctx.strokeStyle = col;
            ctx.stroke();
          }
        }

        // Brushable time window highlight
        if (scoreBrush) {
          const bx1 = clamp(timeToX(Math.min(scoreBrush.startSec, scoreBrush.endSec)), tapeX, stageW);
          const bx2 = clamp(timeToX(Math.max(scoreBrush.startSec, scoreBrush.endSec)), tapeX, stageW);
          if (bx2 - bx1 >= 2) {
            ctx.save();
            ctx.fillStyle = p.brushFill;
            ctx.fillRect(bx1, rulerH, bx2 - bx1, stageH - rulerH);
            ctx.strokeStyle = p.brushEdge;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(bx1 + 0.5, rulerH);
            ctx.lineTo(bx1 + 0.5, stageH);
            ctx.moveTo(bx2 - 0.5, rulerH);
            ctx.lineTo(bx2 - 0.5, stageH);
            ctx.stroke();
            ctx.restore();
          }
        }

        // Unbroken hover vertical crosshair scrubber
        if (hoverCanvasX !== null && hoverCanvasX >= tapeX && hoverCanvasX <= stageW) {
          const hx = Math.floor(hoverCanvasX) + 0.5;
          ctx.save();
          ctx.setLineDash([3, 2]);
          ctx.strokeStyle = p.ink1;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hx, rulerH);
          ctx.lineTo(hx, stageH);
          ctx.stroke();
          ctx.restore();
        }
      }

      // ======================================================================
      // PHOTON SPAWNING & SIMULATION STEP
      // ======================================================================

      function spawnPhoton(edgeId, overrideColor, initialRatio) {
        const geom = flowEdgeGeoms[edgeId];
        if (!geom) return;
        const srcNode = model.nodeById[geom.edge.from];
        const col = overrideColor || colorForNode(srcNode);
        if (photons.length >= 24) photons.shift();
        const docked = isDockedLayout();
        const vol = Math.max(1, geom.edge.volume || 1);
        const speedPx = clamp(
          (docked ? 112 : 164) + Math.log2(1 + vol) * (docked ? 22 : 32),
          docked ? 112 : 164,
          docked ? 240 : 340
        );
        photons.push({
          edgeId,
          distPx: geom.length * (initialRatio || 0),
          speedPx,
          color: col,
        });
      }

      function seedInitialPhotons() {
        if (bootBurstDone) return;
        bootBurstDone = true;
        photons.length = 0;
        const edgeIds = Object.keys(flowEdgeGeoms);
        const picks = Math.min(4, edgeIds.length);
        for (let i = 0; i < picks; i += 1) {
          const idx = Math.floor((i * edgeIds.length) / picks);
          spawnPhoton(edgeIds[idx], null, 0.20 + i * 0.16);
        }
      }

      function enqueueChain(chainIds) {
        if (!chainIds || chainIds.length === 0) return;
        for (let i = 0; i < chainIds.length; i += 1) {
          chainQueue.push({ dueMs: elapsedMs + i * 210, edgeId: chainIds[i] });
        }
      }

      function hasActiveDynamicWork() {
        if (photons.length > 0 || chainQueue.length > 0 || holdState !== null) return true;
        for (const k in stampAnimMap) return true;
        for (const k in flashMap) return true;
        for (const k in shakeMap) return true;
        if (Math.abs(mobileLaneTarget - mobileLaneOffset) > 0.004) return true;
        if (
          viewMode === 'stack' &&
          (Math.abs(ptrTargetX - springX) > 0.004 ||
            Math.abs(ptrTargetY - springY) > 0.004 ||
            Math.abs(velX) > 0.01 ||
            Math.abs(velY) > 0.01)
        ) {
          return true;
        }
        return false;
      }

      function stepSimulation(dtSec, now) {
        elapsedMs += dtSec * 1000;

        // Smooth mobile 5-lane snapping interpolation
        if (Math.abs(mobileLaneTarget - mobileLaneOffset) > 0.004 && (!dragState || dragState.kind !== 'mobile-deck')) {
          const lerp = clamp(dtSec * 14, 0.08, 0.45);
          mobileLaneOffset += (mobileLaneTarget - mobileLaneOffset) * lerp;
          if (Math.abs(mobileLaneTarget - mobileLaneOffset) <= 0.004) {
            mobileLaneOffset = mobileLaneTarget;
          }
          markStaticDirty();
        }

        // Flush scheduled chain hops
        for (let i = chainQueue.length - 1; i >= 0; i -= 1) {
          if (elapsedMs >= chainQueue[i].dueMs) {
            const hop = chainQueue.splice(i, 1)[0];
            spawnPhoton(hop.edgeId, null, 0);
          }
        }

        // Advance L3 photon packets along arc-length LUT
        for (let i = photons.length - 1; i >= 0; i -= 1) {
          const ph = photons[i];
          const geom = flowEdgeGeoms[ph.edgeId];
          if (!geom) {
            photons.splice(i, 1);
            continue;
          }
          ph.distPx += ph.speedPx * dtSec;
          if (ph.distPx >= geom.length) {
            flashMap[geom.edge.to] = { startMs: now, color: ph.color };
            scopeTicks.push({ tSec: scopeScrollSec, color: ph.color });
            if (scopeTicks.length > 90) scopeTicks.shift();
            photons.splice(i, 1);
          }
        }

        // Stack spring parallax integration (k=220, d=26)
        if (viewMode === 'stack') {
          const ax = (ptrTargetX - springX) * 220 - velX * 26;
          const ay = (ptrTargetY - springY) * 220 - velY * 26;
          velX += ax * dtSec;
          velY += ay * dtSec;
          springX += velX * dtSec;
          springY += velY * dtSec;
          if (
            Math.abs(springX - lastStackStaticSpringX) > 0.006 ||
            Math.abs(springY - lastStackStaticSpringY) > 0.006
          ) {
            lastStackStaticSpringX = springX;
            lastStackStaticSpringY = springY;
            markStaticDirty();
          }
        }

        // Score gentle live drift only while active
        if (viewMode === 'score' && now - lastActivityMs < IDLE_PAUSE_MS) {
          scoreSimSec += dtSec * 1.1;
          if (Math.abs(scoreSimSec - lastScoreStaticSec) >= 0.8) {
            lastScoreStaticSec = scoreSimSec;
            markStaticDirty();
          }
        }
      }

      // ======================================================================
      // 2-LAYER COMPOSITE RENDERER & SMART FRAME PACING (60 -> 30 -> 0 FPS)
      // ======================================================================

      function renderFrame(now) {
        if (destroyed || !ctx) return;
        frameCount += 1;

        const pixelW = Math.max(1, Math.round(stageW * dpr));
        const pixelH = Math.max(1, Math.round(stageH * dpr));
        const hasStaticBuf = ensureStaticBuffer(pixelW, pixelH);

        if (viewMode === 'flow') {
          if (staticDirty || !staticReady || !lastFlowLayout) {
            lastFlowLayout = computeFlowLayout();
            if (hasStaticBuf && staticCtx) {
              staticCtx.save();
              if (typeof staticCtx.setTransform === 'function') {
                staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
              }
              staticCtx.clearRect(0, 0, stageW, stageH);
              drawFlowStatic(staticCtx, lastFlowLayout);
              staticCtx.restore();
              staticRedraws += 1;
              staticDirty = false;
              staticReady = true;
            }
          }

          ctx.save();
          if (typeof ctx.setTransform === 'function') {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          ctx.clearRect(0, 0, stageW, stageH);

          let blitted = false;
          if (hasStaticBuf && staticCanvas && staticReady && typeof ctx.drawImage === 'function') {
            try {
              ctx.drawImage(staticCanvas, 0, 0, stageW, stageH);
              blitted = true;
            } catch {
              blitted = false;
            }
          }
          if (!blitted) {
            drawFlowStatic(ctx, lastFlowLayout);
            staticRedraws += 1;
            staticDirty = false;
          }

          drawFlowDynamic(now, lastFlowLayout);
          ctx.restore();
        } else if (viewMode === 'stack') {
          if (staticDirty || !staticReady) {
            if (hasStaticBuf && staticCtx) {
              staticCtx.save();
              if (typeof staticCtx.setTransform === 'function') {
                staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
              }
              staticCtx.clearRect(0, 0, stageW, stageH);
              drawStackStatic(staticCtx);
              staticCtx.restore();
              staticRedraws += 1;
              staticDirty = false;
              staticReady = true;
            }
          }

          ctx.save();
          if (typeof ctx.setTransform === 'function') {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          ctx.clearRect(0, 0, stageW, stageH);

          let blitted = false;
          if (hasStaticBuf && staticCanvas && staticReady && typeof ctx.drawImage === 'function') {
            try {
              ctx.drawImage(staticCanvas, 0, 0, stageW, stageH);
              blitted = true;
            } catch {
              blitted = false;
            }
          }
          if (!blitted) {
            drawStackStatic(ctx);
            staticRedraws += 1;
            staticDirty = false;
          }

          drawStackDynamic();
          ctx.restore();
        } else {
          if (staticDirty || !staticReady) {
            if (hasStaticBuf && staticCtx) {
              staticCtx.save();
              if (typeof staticCtx.setTransform === 'function') {
                staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
              }
              staticCtx.clearRect(0, 0, stageW, stageH);
              drawScoreStatic(staticCtx);
              staticCtx.restore();
              staticRedraws += 1;
              staticDirty = false;
              staticReady = true;
            }
          }

          ctx.save();
          if (typeof ctx.setTransform === 'function') {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          ctx.clearRect(0, 0, stageW, stageH);

          let blitted = false;
          if (hasStaticBuf && staticCanvas && staticReady && typeof ctx.drawImage === 'function') {
            try {
              ctx.drawImage(staticCanvas, 0, 0, stageW, stageH);
              blitted = true;
            } catch {
              blitted = false;
            }
          }
          if (!blitted) {
            drawScoreStatic(ctx);
            staticRedraws += 1;
            staticDirty = false;
          }

          drawScoreDynamic(now);
          ctx.restore();
        }

        publishStats();
      }

      function stopRaf() {
        if (rafId !== null && win && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(rafId);
        }
        rafId = null;
      }

      function shouldAnimate() {
        if (destroyed || !isVisible) return false;
        if (doc && doc.hidden === true) return false;
        return isMotionEnabled();
      }

      function tick(ts) {
        rafId = null;
        if (destroyed) return;
        const now = typeof ts === 'number' && Number.isFinite(ts) ? ts : nowMs();
        const dtSec = clamp((now - lastFrameMs) / 1000, 0, 0.064);
        lastFrameMs = now;

        if (!shouldAnimate()) {
          renderFrame(now);
          return;
        }

        const idleMs = now - lastActivityMs;
        const activeWork = hasActiveDynamicWork();

        // Pause rAF completely once idle past threshold with no active particles/animations (<2% CPU)
        if (idleMs >= IDLE_PAUSE_MS && !activeWork) {
          stopRaf();
          return;
        }

        // Drop to 30 FPS after 3s with no pointer/SSE activity
        if (idleMs >= IDLE_THROTTLE_MS && now - lastRenderMs < 33) {
          if (win && typeof win.requestAnimationFrame === 'function') {
            rafId = win.requestAnimationFrame(tick);
          }
          return;
        }

        stepSimulation(dtSec, now);
        renderFrame(now);
        lastRenderMs = now;

        if (win && typeof win.requestAnimationFrame === 'function') {
          rafId = win.requestAnimationFrame(tick);
        }
      }

      function ensureRaf() {
        if (rafId !== null || !shouldAnimate()) return;
        if (win && typeof win.requestAnimationFrame === 'function') {
          lastFrameMs = nowMs();
          rafId = win.requestAnimationFrame(tick);
        }
      }

      // ======================================================================
      // POINTER, HOLD-TO-STAMP, MOBILE SWIPE, SCORE BRUSH & KEYBOARD A/R/D
      // ======================================================================

      function getCanvasPoint(evt) {
        if (!evt) return { x: -1, y: -1 };
        if (typeof canvas.getBoundingClientRect === 'function') {
          const rect = canvas.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
          }
        }
        return { x: evt.offsetX || 0, y: evt.offsetY || 0 };
      }

      function hitTest(px, py) {
        if (viewMode === 'flow') {
          for (const id in flowNodeRects) {
            const r = flowNodeRects[id];
            if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
              return id;
            }
          }
          return null;
        }
        if (viewMode === 'stack') {
          for (let i = stackCalloutTargets.length - 1; i >= 0; i -= 1) {
            const c = stackCalloutTargets[i];
            if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
              return c.id;
            }
          }
          for (let i = stackHitTargets.length - 1; i >= 0; i -= 1) {
            if (pointInPoly(px, py, stackHitTargets[i].poly)) {
              return stackHitTargets[i].id;
            }
          }
          return null;
        }
        if (viewMode === 'score') {
          for (let i = scoreHitTargets.length - 1; i >= 0; i -= 1) {
            const c = scoreHitTargets[i];
            if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
              return c.id;
            }
          }
          return null;
        }
        return null;
      }

      function setMobileLane(laneIdx) {
        const clampedTarget = clamp(Number(laneIdx) || 0, 0, 3);
        mobileLaneTarget = clampedTarget;
        if (!isMotionEnabled()) {
          mobileLaneOffset = mobileLaneTarget;
        }
        syncMobileLaneBar();
        markStaticDirty();
        markActivity();
        renderFrame(nowMs());
      }

      function handlePointerDown(evt) {
        if (destroyed) return;
        markActivity();
        const pt = getCanvasPoint(evt);
        const hit = hitTest(pt.x, pt.y);

        // Score tape horizontal brush drag
        if (viewMode === 'score' && scoreLastMetrics && pt.x >= scoreLastMetrics.tapeX && pt.y >= scoreLastMetrics.rulerH) {
          const tSec = scoreLastMetrics.xToTime(pt.x);
          dragState = { kind: 'score-brush', startX: pt.x, startSec: tSec, moved: false };
          return;
        }

        // Mobile 5-lane horizontal swipe drag
        if (viewMode === 'flow' && isMobileDeckLayout() && lastFlowLayout && pt.y < lastFlowLayout.bottomY) {
          dragState = {
            kind: 'mobile-deck',
            startX: pt.x,
            startOffset: mobileLaneOffset,
            moved: false,
          };
        }

        // Decision Gate 350ms hold-to-confirm ring
        const node = hit ? model.nodeById[hit] : null;
        if (node && node.kind === 'DECISION' && !evt.shiftKey) {
          holdState = {
            nodeId: node.id,
            decId: node.decId,
            startMs: nowMs(),
            x: pt.x,
            y: pt.y,
            verdict: 'approve',
          };
          ensureRaf();
        }
      }

      function handlePointerMove(evt) {
        if (destroyed) return;
        const pt = getCanvasPoint(evt);
        hoverCanvasX = pt.x;
        hoverCanvasY = pt.y;
        markActivity();

        if (dragState && dragState.kind === 'mobile-deck' && lastFlowLayout && lastFlowLayout.mobileStride > 0) {
          const dx = pt.x - dragState.startX;
          if (Math.abs(dx) > 6) {
            dragState.moved = true;
            holdState = null;
            mobileLaneOffset = clamp(dragState.startOffset - dx / lastFlowLayout.mobileStride, 0, 3);
            mobileLaneTarget = Math.round(mobileLaneOffset);
            syncMobileLaneBar();
            markStaticDirty();
            renderFrame(nowMs());
          }
          return;
        }

        if (dragState && dragState.kind === 'score-brush' && scoreLastMetrics) {
          const dx = Math.abs(pt.x - dragState.startX);
          if (dx > 5) {
            dragState.moved = true;
            scoreBrush = {
              startSec: dragState.startSec,
              endSec: scoreLastMetrics.xToTime(pt.x),
            };
            syncReadout();
            renderFrame(nowMs());
          }
          return;
        }

        if (holdState && Math.hypot(pt.x - holdState.x, pt.y - holdState.y) > 10) {
          holdState = null;
        }

        if (viewMode === 'stack' && isMotionEnabled() && stageW > 0 && stageH > 0) {
          ptrTargetX = clamp((pt.x / stageW - 0.5) * 2, -1, 1);
          ptrTargetY = clamp((pt.y / stageH - 0.5) * 2, -1, 1);
        }

        const hit = hitTest(pt.x, pt.y);
        if (hit !== hoveredId) {
          hoveredId = hit;
          if (hit) canvas.classList.add('is-pointer');
          else canvas.classList.remove('is-pointer');
          syncReadout();
          markStaticDirty();
          renderFrame(nowMs());
        } else if (viewMode === 'score') {
          renderFrame(nowMs());
        }
      }

      function handlePointerUp() {
        if (destroyed) return;
        if (dragState && dragState.kind === 'mobile-deck') {
          if (dragState.moved) {
            mobileLaneTarget = clamp(Math.round(mobileLaneOffset), 0, 3);
            syncMobileLaneBar();
            markActivity();
          }
          dragState = null;
        } else if (dragState && dragState.kind === 'score-brush') {
          dragState = null;
        }
        holdState = null;
      }

      function handlePointerLeave() {
        if (destroyed) return;
        hoverCanvasX = null;
        hoverCanvasY = null;
        ptrTargetX = 0;
        ptrTargetY = 0;
        holdState = null;
        dragState = null;
        if (hoveredId !== null) {
          hoveredId = null;
          canvas.classList.remove('is-pointer');
          syncReadout();
          markStaticDirty();
        }
        renderFrame(nowMs());
      }

      function handleCanvasClick(evt) {
        if (destroyed) return;
        if (dragState && dragState.moved) return;
        markActivity();
        const pt = getCanvasPoint(evt);
        const hit = hitTest(pt.x, pt.y);
        if (!hit) {
          if (selectedId !== null) {
            selectedId = null;
            lastStatusError = '';
            syncReadout();
            markStaticDirty();
            renderFrame(nowMs());
          }
          return;
        }

        // Toggle pin if clicking already-pinned non-decision node
        const node = model.nodeById[hit];
        if (node && node.kind !== 'DECISION' && selectedId === hit) {
          selectedId = null;
          syncReadout();
          markStaticDirty();
          renderFrame(nowMs());
          return;
        }

        selectedId = hit;
        lastStatusError = '';
        syncReadout();
        markStaticDirty();

        if (!node) {
          if (hit.startsWith('hw:') && typeof options.onSelectHost === 'function') {
            const svc = model.services.find((s) => s.id === hit);
            if (svc) options.onSelectHost(svc.raw);
          }
          renderFrame(nowMs());
          return;
        }

        if (node.kind === 'AGENT') {
          triggerPulse({
            actor: node.handle || node.actor,
            channel: node.recentChannels && node.recentChannels[0] ? node.recentChannels[0] : '',
            type: 'select',
          });
          if (typeof options.onSelectAgent === 'function') {
            options.onSelectAgent(node.raw || { actor: node.actor, handle: node.handle, displayName: node.label });
          }
        } else if (node.kind === 'ROOM') {
          triggerPulse({ channel: node.channel, type: 'select' });
          if (typeof options.onSelectRoom === 'function') {
            options.onSelectRoom(node.channel, node.raw);
          }
        } else if (node.kind === 'DECISION') {
          if (evt && evt.shiftKey) {
            submitDecisionStamp(node, 'approve');
          } else {
            if (typeof canvas.focus === 'function') {
              try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
            }
            if (typeof options.onSelectDecision === 'function') {
              options.onSelectDecision(node.raw || node);
            } else if (typeof options.onSelectRoom === 'function' && node.channel) {
              options.onSelectRoom(node.channel, node.raw);
            }
          }
        } else if (node.kind === 'STORE' && typeof options.onSelectHost === 'function') {
          options.onSelectHost(node.raw);
        }
        renderFrame(nowMs());
      }

      function handleCanvasDblClick() {
        if (destroyed) return;
        if (viewMode === 'score' && scoreBrush) {
          scoreBrush = null;
          syncReadout();
          renderFrame(nowMs());
        }
      }

      function handleKeyDown(evt) {
        if (destroyed || !evt || evt.metaKey || evt.ctrlKey || evt.altKey) return;
        const key = String(evt.key || '').toLowerCase();
        const focusId = selectedId || hoveredId;
        const node = focusId ? model.nodeById[focusId] : null;

        if (node && node.kind === 'DECISION') {
          if (key === 'a' || key === 'r' || key === 'd') {
            if (typeof evt.preventDefault === 'function') evt.preventDefault();
            if (typeof evt.stopPropagation === 'function') evt.stopPropagation();
            const verdict = key === 'a' ? 'approve' : key === 'r' ? 'revise' : 'defer';
            submitDecisionStamp(node, verdict);
            return;
          }
        }

        if (viewMode === 'flow' && isMobileDeckLayout()) {
          if (key === 'arrowright') {
            if (typeof evt.preventDefault === 'function') evt.preventDefault();
            setMobileLane(mobileLaneTarget + 1);
          } else if (key === 'arrowleft') {
            if (typeof evt.preventDefault === 'function') evt.preventDefault();
            setMobileLane(mobileLaneTarget - 1);
          }
        }
      }

      function handleWheel(evt) {
        if (destroyed || !evt) return;
        if (viewMode === 'flow' && isMobileDeckLayout() && Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
          if (typeof evt.preventDefault === 'function') evt.preventDefault();
          const step = evt.deltaX > 0 ? 1 : -1;
          setMobileLane(mobileLaneTarget + step);
        }
      }

      function handleMobileLaneClick(evt) {
        const target =
          evt && evt.target && typeof evt.target.closest === 'function'
            ? evt.target.closest('button[data-mobile-lane]')
            : evt && evt.target;
        if (!target || typeof target.getAttribute !== 'function') return;
        const idx = Number(target.getAttribute('data-mobile-lane'));
        if (Number.isFinite(idx)) {
          // Clicking lane 4 (index 4) snaps offset to 3 so lanes 3 & 4 are visible
          setMobileLane(clamp(idx >= 4 ? 3 : idx, 0, 3));
        }
      }

      function handleLensClick(evt) {
        const target =
          evt && evt.target && typeof evt.target.closest === 'function'
            ? evt.target.closest('button[data-lens]')
            : evt && evt.target;
        if (!target || typeof target.getAttribute !== 'function') return;
        const nextMode = target.getAttribute('data-lens');
        if (nextMode === 'flow' || nextMode === 'stack' || nextMode === 'score') {
          setViewMode(nextMode);
        }
      }

      function handleExpandClick() {
        expanded = !expanded;
        syncHeader();
        if (typeof options.onToggleExpand === 'function') {
          options.onToggleExpand(expanded);
        }
        resize();
      }

      function handleVisibilityChange() {
        if (destroyed) return;
        if (doc && doc.hidden) {
          stopRaf();
        } else {
          markActivity();
        }
      }

      function handleBoardSseEvent(evt) {
        if (destroyed) return;
        const det = evt && evt.detail ? evt.detail : null;
        if (det && typeof det === 'object') {
          triggerPulse(det);
        }
        hydratePendingDecisions(false);
      }

      canvas.addEventListener('pointerdown', handlePointerDown);
      canvas.addEventListener('pointermove', handlePointerMove);
      canvas.addEventListener('pointerup', handlePointerUp);
      canvas.addEventListener('pointercancel', handlePointerUp);
      canvas.addEventListener('mousemove', handlePointerMove);
      canvas.addEventListener('mouseleave', handlePointerLeave);
      canvas.addEventListener('click', handleCanvasClick);
      canvas.addEventListener('dblclick', handleCanvasDblClick);
      canvas.addEventListener('keydown', handleKeyDown);
      canvas.addEventListener('wheel', handleWheel, { passive: false });
      lensSeg.addEventListener('click', handleLensClick);
      mobileLaneBar.addEventListener('click', handleMobileLaneClick);
      expandBtn.addEventListener('click', handleExpandClick);
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', handleVisibilityChange);
      }
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('kizuki:board-sse', handleBoardSseEvent);
      }

      let mql = null;
      function handleMotionChange(e) {
        reducedMotion = Boolean(e && e.matches);
        if (!shouldAnimate()) stopRaf();
        else markActivity();
        syncReadout();
        markStaticDirty();
        renderFrame(nowMs());
      }
      if (win && typeof win.matchMedia === 'function') {
        try {
          mql = win.matchMedia('(prefers-reduced-motion: reduce)');
          if (mql && typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', handleMotionChange);
          }
        } catch {
          mql = null;
        }
      }

      let intersectionObserver = null;
      const IntersectionObserverCtor =
        (win && typeof win.IntersectionObserver === 'function' && win.IntersectionObserver) ||
        (typeof IntersectionObserver === 'function' ? IntersectionObserver : null);
      if (IntersectionObserverCtor) {
        try {
          intersectionObserver = new IntersectionObserverCtor(function onIntersect(entries) {
            if (destroyed || !entries || !entries.length) return;
            isVisible = Boolean(entries[0].isIntersecting);
            if (!isVisible) stopRaf();
            else markActivity();
          });
          intersectionObserver.observe(rootEl);
        } catch {
          intersectionObserver = null;
        }
      }

      // ======================================================================
      // PUBLIC INSTANCE METHODS (BACKWARD-COMPATIBLE + C1 & MOBILE APIs)
      // ======================================================================

      function findAgentByActor(rawActor) {
        const needle = cleanText(rawActor).toLowerCase().replace(/^@+/, '');
        if (!needle) return null;
        for (let i = 0; i < model.agents.length; i += 1) {
          const ag = model.agents[i];
          if (
            ag.handle.toLowerCase() === needle ||
            ag.actor.toLowerCase() === needle ||
            ag.label.toLowerCase() === needle ||
            ag.actor.toLowerCase().includes(needle) ||
            needle.includes(ag.handle.toLowerCase())
          ) {
            return ag;
          }
        }
        return null;
      }

      function triggerPulse(event) {
        if (destroyed) return;
        const ev = event && typeof event === 'object' ? event : {};
        const channel = cleanText(ev.channel || ev.room || '');
        const actor = cleanText(ev.actor || ev.author || ev.by || ev.byActor || '');
        const ag = findAgentByActor(actor);
        const rm = channel ? model.nodeById['room:' + channel] || null : null;
        const pulseColor = ag ? colorForNode(ag) : pal().cyan;

        sseEventCount += 1;
        scopeTicks.push({ tSec: scopeScrollSec, color: pulseColor });
        if (scopeTicks.length > 90) scopeTicks.shift();

        const fromId = ag ? ag.id : model.agents[0] ? model.agents[0].id : 'ask:owner';
        const toId = rm ? rm.id : model.rooms[0] ? model.rooms[0].id : 'store:vault';
        scoreBeams.push({
          id: 'pulse-' + sseEventCount,
          timeSec: scoreSimSec,
          fromId,
          toId,
          brand: ag ? ag.brand : 'codex',
          label: cleanText(ev.title || ev.type || 'live event'),
          drawnAtMs: nowMs(),
        });
        if (scoreBeams.length > 48) scoreBeams.shift();

        const chain = [];
        if (ag && rm) {
          const direct = model.edges.find((e) => e.from === ag.id && e.to === rm.id);
          if (direct) chain.push(direct.id);
          const nextE = model.edges.find((e) => e.from === rm.id);
          if (nextE) chain.push(nextE.id);
        } else if (ag) {
          const eOut = model.edges.find((e) => e.from === ag.id);
          if (eOut) chain.push(eOut.id);
        } else if (rm) {
          const eIn = model.edges.find((e) => e.to === rm.id);
          if (eIn) chain.push(eIn.id);
          const eOut = model.edges.find((e) => e.from === rm.id);
          if (eOut) chain.push(eOut.id);
        } else if (model.replayChains.length > 0) {
          chain.push.apply(chain, model.replayChains[0]);
        }

        if (isMotionEnabled()) {
          if (chain.length > 0) {
            spawnPhoton(chain[0], pulseColor, 0);
            if (chain.length > 1) enqueueChain(chain.slice(1));
          }
          markActivity();
        } else {
          markStaticDirty();
          renderFrame(nowMs());
        }
      }

      function update(payload) {
        if (destroyed) return;
        rawLastPayload = payload && typeof payload === 'object' ? payload : {};
        const prevLoad = model.host.loadRatio;
        model = normalizePayload(rawLastPayload, stampedMap, pendingGatesMap);

        // Publish shared board telemetry snapshot so kinetic-os.js avoids duplicate polling
        if (win && typeof win === 'object' && (rawLastPayload.health || rawLastPayload.agents || rawLastPayload.host)) {
          win.KizukiBoardTelemetry = {
            health: rawLastPayload.health || null,
            agents: rawLastPayload.agents || null,
            host: rawLastPayload.host || model.host,
            meshNodes: rawLastPayload.meshNodes || model.meshNodes,
            updatedAt: Date.now(),
          };
        }

        recordServiceSparklines(model, false);

        if (model.hostHistory && model.hostHistory.length >= 2) {
          seedScopeHistory(model);
        } else if (model.host.loadRatio > 0 && Math.abs(model.host.loadRatio - prevLoad) > 0.001) {
          scopeScrollSec += 1;
          scopeSamples.push({
            tSec: scopeScrollSec,
            loadRatio: clamp(model.host.loadRatio, 0, 3.5),
            memGib: clamp(model.host.memAvailableGib, 1, model.host.memTotalGib),
          });
          while (scopeSamples.length > 64) scopeSamples.shift();
        }

        if (model.selectedAgent) {
          const matched = findAgentByActor(
            typeof model.selectedAgent === 'string'
              ? model.selectedAgent
              : model.selectedAgent.handle || model.selectedAgent.actor
          );
          selectedId = matched ? matched.id : selectedId;
        } else if (model.selectedRoom && model.nodeById['room:' + cleanText(model.selectedRoom)]) {
          selectedId = 'room:' + cleanText(model.selectedRoom);
        }

        if (hoveredId && !model.nodeById[hoveredId] && !hoveredId.startsWith('hw:') && !hoveredId.startsWith('seat:')) {
          hoveredId = null;
        }

        syncHeader();
        syncReadout();
        markStaticDirty();
        lastFlowLayout = computeFlowLayout();
        if (photons.length === 0 && !bootBurstDone) seedInitialPhotons();
        renderFrame(nowMs());
      }

      function setTheme(nextTheme) {
        if (destroyed) return;
        const normalized = nextTheme === 'light' ? 'light' : 'dark';
        if (normalized === theme) return;
        theme = normalized;
        rootEl.setAttribute('data-theme', theme);
        if (theme === 'light') rootEl.classList.add('is-light');
        else rootEl.classList.remove('is-light');
        syncReadout();
        markStaticDirty();
        renderFrame(nowMs());
      }

      function setDetail(nextDetail) {
        if (destroyed) return;
        const normalized = nextDetail === 'off' ? 'off' : 'on';
        if (normalized === detail) return;
        detail = normalized;
        rootEl.setAttribute('data-detail', detail);
        if (!shouldAnimate()) {
          stopRaf();
        } else {
          markActivity();
        }
        syncReadout();
        markStaticDirty();
        renderFrame(nowMs());
      }

      function setLayer(nextLayer) {
        if (destroyed) return;
        if (nextLayer !== 'all' && nextLayer !== 'agents' && nextLayer !== 'infra') return;
        layer = nextLayer;
        markStaticDirty();
        renderFrame(nowMs());
      }

      function setViewMode(nextMode) {
        if (destroyed) return;
        if (nextMode !== 'flow' && nextMode !== 'stack' && nextMode !== 'score') return;
        if (nextMode === viewMode) return;
        viewMode = nextMode;
        rootEl.setAttribute('data-view-mode', viewMode);
        hoveredId = null;
        hoverCanvasX = null;
        hoverCanvasY = null;
        holdState = null;
        dragState = null;
        syncHeader();
        syncReadout();
        markStaticDirty();
        markActivity();
        renderFrame(nowMs());
      }

      function setExpanded(nextExpanded) {
        if (destroyed) return;
        expanded = Boolean(nextExpanded);
        syncHeader();
        resize();
        if (win && typeof win.requestAnimationFrame === 'function') {
          win.requestAnimationFrame(() => {
            if (!destroyed) resize();
          });
        }
        setTimeout(() => {
          if (!destroyed) resize();
        }, 200);
        setTimeout(() => {
          if (!destroyed) resize();
        }, 360);
      }

      function resize() {
        if (destroyed) return;
        if (canvas.style) {
          canvas.style.width = '100%';
          canvas.style.height = '100%';
        }
        let nextW = width;
        let nextH = height;

        if (typeof rootEl.getBoundingClientRect === 'function') {
          const rect = rootEl.getBoundingClientRect();
          if (rect && rect.width > 0) nextW = Math.round(rect.width);
          if (rect && rect.height > 0) nextH = Math.round(rect.height);
        }
        if (nextW <= 0 && rootEl.clientWidth > 0) nextW = rootEl.clientWidth;
        if (nextH <= 0 && rootEl.clientHeight > 0) nextH = rootEl.clientHeight;
        if (nextW <= 0) nextW = 640;
        if (nextH <= 0) nextH = 440;

        width = nextW;
        height = nextH;

        let sW = nextW;
        let sH = Math.max(200, nextH - 62);
        if (typeof stageWrap.getBoundingClientRect === 'function') {
          const sr = stageWrap.getBoundingClientRect();
          if (sr && sr.width > 0) sW = Math.round(sr.width);
          if (sr && sr.height > 0) sH = Math.round(sr.height);
        }
        stageW = Math.max(240, sW);
        stageH = Math.max(200, sH);

        // Cap DPR strictly at 2 for crisp 60 FPS performance
        const rawDpr = win && Number(win.devicePixelRatio) > 0 ? Number(win.devicePixelRatio) : 1;
        dpr = clamp(rawDpr, 1, 2);

        canvas.width = Math.max(1, Math.round(stageW * dpr));
        canvas.height = Math.max(1, Math.round(stageH * dpr));

        syncHeader();
        syncReadout();
        markStaticDirty();
        lastFlowLayout = computeFlowLayout();
        if (photons.length === 0 && !bootBurstDone) seedInitialPhotons();
        renderFrame(nowMs());
      }

      let resizeObserver = null;
      const ResizeObserverCtor =
        (win && typeof win.ResizeObserver === 'function' && win.ResizeObserver) ||
        (typeof ResizeObserver === 'function' ? ResizeObserver : null);
      if (ResizeObserverCtor) {
        try {
          resizeObserver = new ResizeObserverCtor(function onResize() {
            if (!destroyed) resize();
          });
          resizeObserver.observe(rootEl);
          resizeObserver.observe(stageWrap);
        } catch {
          resizeObserver = null;
        }
      }

      function handleWinResize() {
        if (!destroyed) resize();
      }
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('resize', handleWinResize);
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopRaf();
        photons.length = 0;
        chainQueue.length = 0;
        holdState = null;
        dragState = null;
        staticCanvas = null;
        staticCtx = null;
        if (resizeObserver && typeof resizeObserver.disconnect === 'function') {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        if (intersectionObserver && typeof intersectionObserver.disconnect === 'function') {
          intersectionObserver.disconnect();
          intersectionObserver = null;
        }
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('resize', handleWinResize);
          win.removeEventListener('kizuki:board-sse', handleBoardSseEvent);
        }
        if (doc && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        if (mql && typeof mql.removeEventListener === 'function') {
          mql.removeEventListener('change', handleMotionChange);
        }
        canvas.removeEventListener('pointerdown', handlePointerDown);
        canvas.removeEventListener('pointermove', handlePointerMove);
        canvas.removeEventListener('pointerup', handlePointerUp);
        canvas.removeEventListener('pointercancel', handlePointerUp);
        canvas.removeEventListener('mousemove', handlePointerMove);
        canvas.removeEventListener('mouseleave', handlePointerLeave);
        canvas.removeEventListener('click', handleCanvasClick);
        canvas.removeEventListener('dblclick', handleCanvasDblClick);
        canvas.removeEventListener('keydown', handleKeyDown);
        canvas.removeEventListener('wheel', handleWheel);
        lensSeg.removeEventListener('click', handleLensClick);
        mobileLaneBar.removeEventListener('click', handleMobileLaneClick);
        expandBtn.removeEventListener('click', handleExpandClick);
        if (rootEl.parentNode) {
          rootEl.parentNode.removeChild(rootEl);
        }
      }

      function stampDecision(threadId, verdict, note) {
        const tid = cleanText(threadId);
        const dec = model.decisions.find((d) => d.decId === tid || d.id === tid || d.id === 'dec:' + tid);
        if (!dec) return Promise.resolve({ ok: false, error: 'not_found' });
        return submitDecisionStamp(dec, verdict || 'approve', note);
      }

      function getState() {
        const flowNodes = [];
        for (const id in flowNodeRects) {
          const r = flowNodeRects[id];
          if (!r.node) continue;
          flowNodes.push({
            id: r.node.id,
            kind: r.node.kind,
            col: r.col,
            label: r.node.label,
            shortLabel: r.node.shortLabel,
            metric: r.node.metric || '',
            stamped: Boolean(r.node.stamped),
            verdict: r.node.verdict || null,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
          });
        }
        return {
          viewMode,
          theme,
          detail,
          layer,
          expanded,
          compactMode: isDockedLayout(),
          mobileDeck: isMobileDeckLayout(),
          mobileLane: Math.round(mobileLaneTarget),
          width,
          height,
          stageW,
          stageH,
          dpr,
          statusBadge: model.statusBadge,
          serviceSummary: model.serviceSummary,
          peerSummary: model.peerSummary,
          narrator: narratorEl.textContent,
          nodeCount: model.allNodes.length,
          visibleNodeCount: flowNodes.length,
          edgeCount: model.edges.length,
          decisionsCount: model.decisions.length,
          activePulseCount: photons.length,
          rafActive: rafId !== null,
          hoveredNodeId: hoveredId,
          selectedNodeId: selectedId,
          stats: publishStats(),
          nodes: flowNodes,
        };
      }

      // Initial boot
      syncHeader();
      syncReadout();
      resize();
      ensureRaf();
      hydratePendingDecisions(true);

      return {
        update,
        triggerPulse,
        setTheme,
        setDetail,
        setLayer,
        setViewMode,
        setExpanded,
        resize,
        destroy,
        getState,
        stampDecision,
        hydratePendingDecisions,
        setMobileLane,
      };
    }

    return {
      mount,
      compactRoomLabel,
      middleEllipsisSegment,
      minimizeFlowCrossings,
    };
  }
);
