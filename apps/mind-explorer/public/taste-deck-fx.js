/* ==========================================================================
   KIZUKI MIND EXPLORER - TASTE DECK FX & 8-AXIS GENOME RADAR
   Exports: window.KizukiTasteFx = {
     renderTasteGenomeRadarSvg,
     renderRadar,
     updateRadar,
     hydrateRadar,
     recordRadarSnapshot,
     getRadarState,
     resetRadarHistory,
     wrapCardInPhysicalStack,
     dealCard,
     stampVerdictLock,
     animateCardPeel,
     animateDeckPromote,
     RADAR_AXES,
     ensureStyles,
     isMotionBypassed,
   }
   Zero external deps | Zero XSS | Zero NaN | Zero em-dashes | Compositor-only
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiTasteFx = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const SAFE_CLASS_RE = /[^a-zA-Z0-9_-]+/g;
  const STYLE_TAG_ID = 'kizuki-taste-fx-styles';
  const EASE_PEEL = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const PEEL_DURATION_MS = 190;
  const PROMOTE_DURATION_MS = 220;
  const DEAL_DURATION_MS = 220;
  const LOCK_STAMP_DURATION_MS = 110;
  const RADAR_SPRING_STIFFNESS = 220;
  const RADAR_SPRING_DAMPING = 22;
  const RADAR_SPRING_MAX_MS = 480;
  const RADAR_GHOST_FADE_MS = 1400;
  const RADAR_GHOST_ALPHA = 0.28;
  const RADAR_HOVER_DURATION_MS = 110;
  const RADAR_HOVER_RADIUS_DELTA = 2.5;

  const VIEWBOX_W = 540;
  const VIEWBOX_H = 380;
  const CENTER_X = 270;
  const CENTER_Y = 186;
  const OUTER_RADIUS = 126;
  const ORIGIN_SEED_RADIUS = 4.5;
  const RING_SCALES = Object.freeze([0.25, 0.5, 0.75, 1.0]);

  const RADAR_AXES = Object.freeze([
    Object.freeze({ id: 'ui_product', shortLabel: 'UI CRAFT', defaultLabel: 'UI & Product Craft' }),
    Object.freeze({ id: 'typography_copy', shortLabel: 'TYPOGRAPHY', defaultLabel: 'Typography & Copy' }),
    Object.freeze({ id: 'visual_brand', shortLabel: 'BRAND', defaultLabel: 'Visual & Brand' }),
    Object.freeze({ id: 'motion_feel', shortLabel: 'MOTION', defaultLabel: 'Motion & Interaction' }),
    Object.freeze({ id: 'video_anime', shortLabel: 'FILM & ANIME', defaultLabel: 'Film, Video & Anime' }),
    Object.freeze({ id: 'merch_objects', shortLabel: 'MERCH', defaultLabel: 'Personal Style & Merch' }),
    Object.freeze({ id: 'spaces_life', shortLabel: 'SPACES', defaultLabel: 'Spaces & Travel' }),
    Object.freeze({ id: 'agent_ops', shortLabel: 'AGENT OPS', defaultLabel: 'Agent Behavior' }),
  ]);

  let radarInstanceSeq = 0;
  const activeAnimMap = new WeakMap();
  const activeWaapiElements = new Set();
  const radarHistoryMap = new Map();
  const activeRadarAnimMap = new WeakMap();
  const hydratedRadarSet = new WeakSet();
  const offscreenElSet = new WeakSet();
  let sharedIntersectionObserver = null;
  let visibilityListenerBound = false;

  function resolveGapTier(pct, minPct, maxPct) {
    const p = clampPct(pct);
    const hasSpread = Number.isFinite(minPct) && Number.isFinite(maxPct) && (maxPct - minPct) >= 10;
    if (p >= 100) return 'calibrated';
    if (p < 75 || (hasSpread && p <= minPct && p < 95)) return 'gap';
    if (p < 85) return 'mid';
    return 'strong';
  }

  function ensureVisibilityTracking(el) {
    if (!el || typeof el !== 'object') return;
    const win = getWin();
    const doc = getDoc();

    if (!visibilityListenerBound && doc && typeof doc.addEventListener === 'function') {
      visibilityListenerBound = true;
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) {
          pauseAllOffscreenAnimations();
        }
      });
    }

    if (win && typeof win.IntersectionObserver === 'function') {
      if (!sharedIntersectionObserver) {
        try {
          sharedIntersectionObserver = new win.IntersectionObserver(function (entries) {
            for (let i = 0; i < entries.length; i += 1) {
              const entry = entries[i];
              const target = entry && entry.target;
              if (!target) continue;
              if (entry.isIntersecting) {
                offscreenElSet.delete(target);
              } else {
                offscreenElSet.add(target);
                cancelRadarAnim(target, true);
                cancelElementAnim(target);
              }
            }
          }, { threshold: 0.01 });
        } catch (_) {
          sharedIntersectionObserver = null;
        }
      }
      if (sharedIntersectionObserver && typeof sharedIntersectionObserver.observe === 'function') {
        try {
          sharedIntersectionObserver.observe(el);
        } catch (_) {
          // ignore synthetic DOM elements
        }
      }
    }
  }

  function isElementOffscreen(el) {
    const doc = getDoc();
    if (doc && doc.hidden === true) return true;
    if (!el) return false;
    if (offscreenElSet.has(el)) return true;
    if (el.isConnected === false) return true;
    if (typeof el.closest === 'function') {
      if (el.closest('[hidden]')) return true;
    }
    return false;
  }

  function pauseAllOffscreenAnimations() {
    activeWaapiElements.forEach(function (el) {
      if (isElementOffscreen(el)) {
        cancelElementAnim(el);
      }
    });
  }

  function getDoc() {
    if (typeof document !== 'undefined') return document;
    if (root && root.document) return root.document;
    return null;
  }

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (root && root.window) return root.window;
    return root || null;
  }

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

  function fmtNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.round(n * 100) / 100;
    return Object.is(rounded, -0) ? '0' : String(rounded);
  }

  function toNonNegInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function clampPct(value) {
    if (typeof value === 'string') {
      const cleaned = value.trim().replace(/%$/, '');
      if (!cleaned) return 0;
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(100, Math.round(parsed)));
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function parseGardenerLevel(raw) {
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw <= 0) return 0;
      return Math.max(1, Math.min(5, Math.round(raw)));
    }
    if (typeof raw === 'string') {
      const match = raw.trim().match(/(\d+)/);
      if (!match) return 0;
      const lvl = Number(match[1]);
      if (!Number.isFinite(lvl) || lvl <= 0) return 0;
      return Math.max(1, Math.min(5, Math.round(lvl)));
    }
    if (typeof raw === 'object') {
      const direct =
        raw.depth_level != null ? raw.depth_level :
        raw.cultivation_level != null ? raw.cultivation_level :
        raw.gardener_depth != null ? raw.gardener_depth :
        raw.depth != null ? raw.depth :
        raw.level != null ? raw.level :
        raw.depth_label != null ? raw.depth_label :
        raw.stage != null ? raw.stage : null;
      if (direct != null) return parseGardenerLevel(direct);
      if (Array.isArray(raw.mastery_stages) && raw.mastery_stages.length > 0) {
        return Math.max(1, Math.min(5, raw.mastery_stages.length));
      }
      if (Array.isArray(raw.mastery_path) && raw.mastery_path.length > 0) {
        return Math.max(1, Math.min(5, raw.mastery_path.length));
      }
    }
    return 0;
  }

  function extractGardenerDepthMap(domains, opts) {
    const map = Object.create(null);
    let hasAny = false;

    function record(domainId, rawVal) {
      const id = String(domainId || '').trim();
      if (!id) return;
      const lvl = parseGardenerLevel(rawVal);
      if (lvl > 0) {
        map[id] = lvl;
        hasAny = true;
      }
    }

    function ingestSource(src) {
      if (!src) return;
      if (Array.isArray(src)) {
        for (let i = 0; i < src.length; i += 1) {
          const item = src[i];
          if (!item || typeof item !== 'object') continue;
          const id = item.domain || item.id;
          if (id) record(id, item);
        }
        return;
      }
      if (typeof src === 'object') {
        if (src.domains && typeof src.domains === 'object') {
          ingestSource(src.domains);
        }
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i];
          if (k === 'domains' || k === 'stats' || k === 'gardeners' || k === 'activity_log' || k === 'scheduler') {
            continue;
          }
          record(k, src[k]);
        }
      }
    }

    const o = opts && typeof opts === 'object' ? opts : {};
    ingestSource(o.gardenersData);
    ingestSource(o.gardenerData);
    ingestSource(o.gardenerDomains);
    ingestSource(o.gardeners);
    ingestSource(o.cultivation);

    if (Array.isArray(domains)) {
      for (let i = 0; i < domains.length; i += 1) {
        const d = domains[i];
        if (!d || typeof d !== 'object') continue;
        const id = d.id || d.domain;
        if (!id || map[id]) continue;
        const lvl = parseGardenerLevel(
          d.gardener_depth != null ? d.gardener_depth :
          d.depth_level != null ? d.depth_level :
          d.cultivation_level != null ? d.cultivation_level : null
        );
        if (lvl > 0) {
          map[id] = lvl;
          hasAny = true;
        }
      }
    }

    return { map, hasAny };
  }

  function isMotionBypassed() {
    const doc = getDoc();
    if (doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function') {
      if (doc.documentElement.getAttribute('data-detail') === 'off') {
        return { bypassed: true, reason: 'detail-off' };
      }
    }
    const win = getWin();
    if (win && typeof win.matchMedia === 'function') {
      try {
        const mq = win.matchMedia('(prefers-reduced-motion: reduce)');
        if (mq && mq.matches) {
          return { bypassed: true, reason: 'reduced-motion' };
        }
      } catch (_) {
        // ignore matchMedia errors in synthetic environments
      }
    }
    return { bypassed: false, reason: '' };
  }

  function ensureStyles() {
    const doc = getDoc();
    if (!doc || !doc.head || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
      return false;
    }
    if (doc.getElementById(STYLE_TAG_ID)) return true;

    const style = doc.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = [
      '#view-taste .tfx-deck-stack, .tfx-deck-stack {',
      '  position: relative;',
      '  display: block;',
      '  width: 100%;',
      '  min-width: 0;',
      '  padding-top: 18px;',
      '  padding-bottom: 0;',
      '  margin-bottom: 0;',
      '  isolation: isolate;',
      '}',
      '#view-taste .tfx-deck-stack > :not(.tfx-under-card), .tfx-deck-stack > :not(.tfx-under-card) {',
      '  position: relative;',
      '  z-index: 3;',
      '}',
      '#view-taste .tfx-under-card, .tfx-under-card {',
      '  position: absolute;',
      '  bottom: auto;',
      '  pointer-events: none;',
      '  transform: translate3d(0, 0, 0);',
      '  transform-origin: 50% 100%;',
      '  transition: transform 200ms ' + EASE_PEEL + ', opacity 200ms ' + EASE_PEEL + ', border-color 160ms ease;',
      '}',
      '#view-taste .tfx-under-card.is-depth-1, .tfx-under-card.is-depth-1 {',
      '  z-index: 2;',
      '  top: 10px;',
      '  left: 10px;',
      '  right: 10px;',
      '  bottom: auto;',
      '  height: 28px;',
      '  border-radius: 12px 12px 0 0;',
      '  background-color: var(--surface-inset, #111113);',
      '  border: 1px solid rgba(255, 255, 255, 0.14);',
      '  border-bottom: none;',
      '  opacity: 1;',
      '  transform: translate3d(0, 0, 0);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 -2px 8px rgba(0, 0, 0, 0.28);',
      '}',
      '#view-taste .tfx-under-card.is-depth-2, .tfx-under-card.is-depth-2 {',
      '  z-index: 1;',
      '  top: 2px;',
      '  left: 22px;',
      '  right: 22px;',
      '  bottom: auto;',
      '  height: 22px;',
      '  border-radius: 10px 10px 0 0;',
      '  background-color: var(--surface-canvas, #09090b);',
      '  border: 1px solid rgba(255, 255, 255, 0.08);',
      '  border-bottom: none;',
      '  opacity: 0.92;',
      '  transform: translate3d(0, 0, 0);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);',
      '}',
      '#view-taste .tfx-deck-stack.is-advancing .tfx-under-card.is-depth-1 {',
      '  transform: translate3d(0, 4px, 0);',
      '  opacity: 1;',
      '}',
      '#view-taste .tfx-deck-stack.is-advancing .tfx-under-card.is-depth-2 {',
      '  transform: translate3d(0, 5px, 0);',
      '  opacity: 0.96;',
      '}',
      'html[data-theme="light"] #view-taste .tfx-under-card.is-depth-1, html[data-theme="light"] .tfx-under-card.is-depth-1 {',
      '  background-color: var(--surface-inset, #f4f4f5);',
      '  border-color: #d4d4d8;',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 -1px 4px rgba(0, 0, 0, 0.05);',
      '}',
      'html[data-theme="light"] #view-taste .tfx-under-card.is-depth-2, html[data-theme="light"] .tfx-under-card.is-depth-2 {',
      '  background-color: var(--surface-canvas, #fafafa);',
      '  border-color: #e4e4e7;',
      '  opacity: 0.96;',
      '  box-shadow: none;',
      '}',
      'html[data-detail="off"] #view-taste .tfx-deck-stack, html[data-detail="off"] .tfx-deck-stack {',
      '  padding-top: 18px;',
      '  padding-bottom: 0;',
      '  margin-bottom: 0;',
      '}',
      'html[data-detail="off"] #view-taste .tfx-under-card, html[data-detail="off"] .tfx-under-card {',
      '  display: block !important;',
      '  opacity: 0 !important;',
      '  transform: translate3d(0, 8px, 0) !important;',
      '  pointer-events: none;',
      '}',
      '@media (max-width: 640px) {',
      '  #view-taste .tfx-deck-stack, .tfx-deck-stack {',
      '    padding-top: 18px;',
      '    padding-bottom: 0;',
      '  }',
      '  #view-taste .tfx-under-card, .tfx-under-card {',
      '    bottom: auto;',
      '  }',
      '  #view-taste .tfx-under-card.is-depth-1, .tfx-under-card.is-depth-1 {',
      '    top: 10px;',
      '    left: 10px;',
      '    right: 10px;',
      '    height: 28px;',
      '    transform: translate3d(0, 0, 0);',
      '  }',
      '  #view-taste .tfx-under-card.is-depth-2, .tfx-under-card.is-depth-2 {',
      '    top: 2px;',
      '    left: 22px;',
      '    right: 22px;',
      '    height: 22px;',
      '    transform: translate3d(0, 0, 0);',
      '  }',
      '}',
      ':where(.tfx-genome-radar-svg) {',
      '  display: block;',
      '  width: 100%;',
      '  max-width: 560px;',
      '  height: auto;',
      '  overflow: visible;',
      '  user-select: none;',
      '}',
      ':where(.tfx-genome-poly) {',
      '  transition: opacity 180ms ' + EASE_PEEL + ';',
      '}',
      ':where(.tfx-genome-ghost) {',
      '  pointer-events: none;',
      '  transition: opacity ' + RADAR_GHOST_FADE_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1);',
      '}',
      ':where(.tfx-weekly-baseline-poly) {',
      '  fill: none;',
      '  stroke: var(--ink-muted, #8b949e);',
      '  stroke-opacity: 0.48;',
      '  stroke-width: 1.25;',
      '  stroke-dasharray: 4 3;',
      '  pointer-events: none;',
      '}',
      'html[data-theme="light"] .tfx-weekly-baseline-poly {',
      '  stroke: rgba(15, 23, 42, 0.36);',
      '}',
      ':where(.tfx-weekly-delta-seg) {',
      '  stroke: var(--accent-cyan, #38bdf8);',
      '  stroke-width: 2;',
      '  stroke-linecap: round;',
      '  pointer-events: none;',
      '}',
      'html[data-theme="light"] .tfx-weekly-delta-seg {',
      '  stroke: #0369a1;',
      '}',
      ':where(.tfx-radar-vertex.is-tier-calibrated .tfx-radar-dot) { fill: #34d399; }',
      ':where(.tfx-radar-vertex.is-tier-strong .tfx-radar-dot) { fill: #38bdf8; }',
      ':where(.tfx-radar-vertex.is-tier-mid .tfx-radar-dot) { fill: #fbbf24; }',
      ':where(.tfx-radar-vertex.is-tier-gap .tfx-radar-dot) { fill: #ff6b4a; }',
      'html[data-theme="light"] .tfx-radar-vertex.is-tier-calibrated .tfx-radar-dot { fill: #047857; }',
      'html[data-theme="light"] .tfx-radar-vertex.is-tier-strong .tfx-radar-dot { fill: #0369a1; }',
      'html[data-theme="light"] .tfx-radar-vertex.is-tier-mid .tfx-radar-dot { fill: #b45309; }',
      'html[data-theme="light"] .tfx-radar-vertex.is-tier-gap .tfx-radar-dot { fill: #c2410c; }',
      ':where(.tfx-radar-gap-ring) {',
      '  fill: none;',
      '  stroke: #ff6b4a;',
      '  stroke-opacity: 0.82;',
      '  stroke-width: 1.45;',
      '  stroke-dasharray: 2.5 2;',
      '  pointer-events: none;',
      '}',
      'html[data-theme="light"] .tfx-radar-gap-ring {',
      '  stroke: #c2410c;',
      '}',
      ':where(.tfx-radar-axis-label.is-tier-calibrated .tfx-radar-axis-pct) { fill: #34d399; }',
      ':where(.tfx-radar-axis-label.is-tier-strong .tfx-radar-axis-pct) { fill: #38bdf8; }',
      ':where(.tfx-radar-axis-label.is-tier-mid .tfx-radar-axis-pct) { fill: #fbbf24; }',
      ':where(.tfx-radar-axis-label.is-tier-gap .tfx-radar-axis-pct) { fill: #ff6b4a; }',
      'html[data-theme="light"] .tfx-radar-axis-label.is-tier-calibrated .tfx-radar-axis-pct { fill: #047857; }',
      'html[data-theme="light"] .tfx-radar-axis-label.is-tier-strong .tfx-radar-axis-pct { fill: #0369a1; }',
      'html[data-theme="light"] .tfx-radar-axis-label.is-tier-mid .tfx-radar-axis-pct { fill: #b45309; }',
      'html[data-theme="light"] .tfx-radar-axis-label.is-tier-gap .tfx-radar-axis-pct { fill: #c2410c; }',
      ':where(.tfx-radar-axis-name) {',
      '  fill: var(--ink-secondary, #b3b3b8);',
      '}',
      'html[data-theme="light"] .tfx-radar-axis-name {',
      '  fill: #374151;',
      '}',
      ':where(.tfx-radar-scale-tick) {',
      '  fill: var(--ink-muted, #8c8c96);',
      '}',
      ':where(html[data-detail="off"] .tfx-genome-glow),',
      ':where(html[data-detail="off"] .tfx-genome-ghost),',
      ':where(html[data-detail="off"] .tfx-radar-compass),',
      ':where(html[data-detail="off"] .tfx-radar-vertex-halo),',
      ':where(html[data-detail="off"] .tfx-lock-stamp) {',
      '  opacity: 0;',
      '  pointer-events: none;',
      '}',
      ':where(.tfx-radar-compass-ring) {',
      '  fill: none;',
      '  stroke: rgba(255, 255, 255, 0.11);',
      '  stroke-width: 0.85;',
      '}',
      ':where(.tfx-radar-compass-tick) {',
      '  stroke: rgba(255, 255, 255, 0.16);',
      '  stroke-width: 0.8;',
      '}',
      ':where(.tfx-radar-compass-tick.is-major) {',
      '  stroke: rgba(255, 255, 255, 0.30);',
      '  stroke-width: 1.05;',
      '}',
      'html[data-theme="light"] .tfx-radar-compass-ring {',
      '  stroke: rgba(15, 23, 42, 0.14);',
      '}',
      'html[data-theme="light"] .tfx-radar-compass-tick {',
      '  stroke: rgba(15, 23, 42, 0.18);',
      '}',
      'html[data-theme="light"] .tfx-radar-compass-tick.is-major {',
      '  stroke: rgba(15, 23, 42, 0.34);',
      '}',
      'html[data-theme="light"] .tfx-gardener-poly {',
      '  fill: rgba(13, 148, 136, 0.14);',
      '  stroke: #0f766e;',
      '  stroke-opacity: 0.86;',
      '  stroke-width: 1.4;',
      '}',
      'html[data-theme="light"] .tfx-genome-ghost {',
      '  stroke: #0f766e;',
      '}',
      'html[data-theme="light"] .tfx-radar-scale-tick {',
      '  fill: rgba(23, 23, 23, 0.72);',
      '  opacity: 1;',
      '}',
      'html[data-theme="light"] .tfx-radar-legend-gardener {',
      '  stroke: #0f766e;',
      '  stroke-opacity: 0.9;',
      '}',
      'html[data-theme="light"] .tfx-radar-legend text {',
      '  fill: rgba(23, 23, 23, 0.78);',
      '}',
      'html[data-theme="light"] .tfx-radar-ring {',
      '  stroke: rgba(15, 23, 42, 0.16);',
      '}',
      'html[data-theme="light"] .tfx-radar-ring.is-ring-100 {',
      '  stroke: rgba(15, 23, 42, 0.28);',
      '}',
      'html[data-theme="light"] .tfx-radar-spoke {',
      '  stroke: rgba(15, 23, 42, 0.14);',
      '}',
      'html[data-theme="light"] .tfx-radar-spoke.is-cardinal {',
      '  stroke: rgba(15, 23, 42, 0.22);',
      '}',
      ':where(.tfx-radar-spoke) {',
      '  transition: stroke ' + RADAR_HOVER_DURATION_MS + 'ms ease, stroke-width ' + RADAR_HOVER_DURATION_MS + 'ms ease, stroke-opacity ' + RADAR_HOVER_DURATION_MS + 'ms ease;',
      '}',
      ':where(.tfx-radar-spoke.is-tier-gap) {',
      '  stroke: rgba(255, 107, 74, 0.42);',
      '  stroke-width: 1.25;',
      '}',
      'html[data-theme="light"] .tfx-radar-spoke.is-tier-gap {',
      '  stroke: rgba(194, 65, 12, 0.36);',
      '}',
      ':where(.tfx-radar-spoke.is-hovered) {',
      '  stroke: var(--accent-cyan, #50e3c2);',
      '  stroke-width: 1.85;',
      '  stroke-opacity: 0.94;',
      '}',
      'html[data-theme="light"] .tfx-radar-spoke.is-hovered {',
      '  stroke: #0f766e;',
      '  stroke-opacity: 0.92;',
      '}',
      ':where(.tfx-radar-hit),',
      ':where(.tfx-radar-axis-label) {',
      '  cursor: pointer;',
      '  outline: none;',
      '}',
      ':where(.tfx-radar-dot) {',
      '  transition: r ' + RADAR_HOVER_DURATION_MS + 'ms ' + EASE_PEEL + ', fill ' + RADAR_HOVER_DURATION_MS + 'ms ease;',
      '}',
      ':where(.tfx-radar-vertex:hover .tfx-radar-dot),',
      ':where(.tfx-radar-vertex.is-hovered .tfx-radar-dot),',
      ':where(.tfx-radar-hit:focus-visible + .tfx-radar-dot) {',
      '  r: 7px;',
      '}',
      ':where(.tfx-radar-vertex.is-active:hover .tfx-radar-dot),',
      ':where(.tfx-radar-vertex.is-active.is-hovered .tfx-radar-dot) {',
      '  r: 7.5px;',
      '}',
      ':where(.tfx-radar-hover-readout) {',
      '  opacity: 0;',
      '  pointer-events: none;',
      '  transition: opacity ' + RADAR_HOVER_DURATION_MS + 'ms ease;',
      '}',
      ':where(.tfx-radar-hover-readout.is-visible) {',
      '  opacity: 1;',
      '}',
      ':where(.tfx-radar-hover-bg) {',
      '  fill: var(--surface-raised, rgba(16, 16, 20, 0.96));',
      '  stroke: var(--accent-cyan, rgba(80, 227, 194, 0.55));',
      '  stroke-width: 1;',
      '}',
      'html[data-theme="light"] .tfx-radar-hover-bg {',
      '  fill: rgba(255, 255, 255, 0.98);',
      '  stroke: rgba(15, 118, 110, 0.48);',
      '}',
      ':where(.tfx-radar-hover-text) {',
      '  fill: var(--ink-primary, #ededed);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: var(--t-xs, 11px);',
      '  font-weight: 600;',
      '  font-variant-numeric: tabular-nums;',
      '  letter-spacing: 0.03em;',
      '}',
      'html[data-theme="light"] .tfx-radar-hover-text {',
      '  fill: #111827;',
      '}',
      ':where(.tfx-radar-axis-label:hover .tfx-radar-axis-name),',
      ':where(.tfx-radar-axis-label.is-hovered .tfx-radar-axis-name),',
      ':where(.tfx-radar-axis-label:focus-visible .tfx-radar-axis-name) {',
      '  fill: var(--ink-primary, #ededed);',
      '}',
      'html[data-theme="light"] .tfx-radar-axis-label:hover .tfx-radar-axis-name,',
      'html[data-theme="light"] .tfx-radar-axis-label.is-hovered .tfx-radar-axis-name,',
      'html[data-theme="light"] .tfx-radar-axis-label:focus-visible .tfx-radar-axis-name {',
      '  fill: #111827;',
      '}',
      ':where(.tfx-radar-axis-label.is-active .tfx-radar-axis-name) {',
      '  fill: var(--ink-primary, #ededed);',
      '  font-weight: 600;',
      '}',
      'html[data-theme="light"] .tfx-radar-axis-label.is-active .tfx-radar-axis-name {',
      '  fill: #111827;',
      '}',
      '.tfx-lock-stamp {',
      '  position: absolute;',
      '  top: 12px;',
      '  right: 14px;',
      '  z-index: 6;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  padding: 3px 9px;',
      '  border-radius: 999px;',
      '  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);',
      '  font-size: var(--t-xs, 11px);',
      '  font-weight: 600;',
      '  letter-spacing: 0.09em;',
      '  line-height: 1.2;',
      '  text-transform: uppercase;',
      '  pointer-events: none;',
      '  user-select: none;',
      '  transform-origin: center;',
      '  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);',
      '}',
      '.tfx-lock-stamp::before {',
      '  content: "";',
      '  width: 5px;',
      '  height: 5px;',
      '  border-radius: 999px;',
      '  background-color: currentColor;',
      '}',
      '.tfx-lock-stamp.is-emerald {',
      '  background-color: rgba(20, 83, 45, 0.9);',
      '  border: 1px solid rgba(70, 167, 88, 0.85);',
      '  color: #6ee79c;',
      '}',
      '.tfx-lock-stamp.is-vermilion {',
      '  background-color: rgba(127, 29, 29, 0.92);',
      '  border: 1px solid rgba(239, 68, 68, 0.85);',
      '  color: #ff8a80;',
      '}',
      'html[data-theme="light"] .tfx-lock-stamp.is-emerald {',
      '  background-color: rgba(236, 253, 245, 0.96);',
      '  border-color: #16a34a;',
      '  color: #15803d;',
      '  box-shadow: 0 2px 8px rgba(22, 163, 74, 0.14);',
      '}',
      'html[data-theme="light"] .tfx-lock-stamp.is-vermilion {',
      '  background-color: rgba(254, 242, 242, 0.96);',
      '  border-color: #dc2626;',
      '  color: #b91c1c;',
      '  box-shadow: 0 2px 8px rgba(220, 38, 38, 0.14);',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  #view-taste .tfx-under-card,',
      '  .tfx-under-card,',
      '  :where(.tfx-radar-dot),',
      '  :where(.tfx-radar-spoke),',
      '  :where(.tfx-radar-hover-readout),',
      '  :where(.tfx-genome-ghost),',
      '  :where(.tfx-genome-poly) {',
      '    transition: none;',
      '  }',
      '}',
    ].join('\n');

    doc.head.appendChild(style);
    return true;
  }

  function polarPoint(index, radius) {
    const angle = -Math.PI / 2 + (index * (2 * Math.PI)) / 8;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: CENTER_X + radius * cos,
      y: CENTER_Y + radius * sin,
      cos,
      sin,
    };
  }

  function computeLabelPosition(index) {
    const outer = polarPoint(index, OUTER_RADIUS);
    switch (index) {
      case 0: // 12 o'clock: UI CRAFT
        return { anchor: 'middle', x: CENTER_X, nameY: 22, pctY: 38 };
      case 1: // 1:30: TYPOGRAPHY
        return { anchor: 'start', x: outer.x + 15, nameY: outer.y - 8, pctY: outer.y + 8 };
      case 2: // 3 o'clock: BRAND
        return { anchor: 'start', x: outer.x + 16, nameY: outer.y - 5, pctY: outer.y + 11 };
      case 3: // 4:30: MOTION
        return { anchor: 'start', x: outer.x + 15, nameY: outer.y - 2, pctY: outer.y + 14 };
      case 4: // 6 o'clock: FILM & ANIME
        return { anchor: 'middle', x: CENTER_X, nameY: 334, pctY: 350 };
      case 5: // 7:30: MERCH
        return { anchor: 'end', x: outer.x - 15, nameY: outer.y - 2, pctY: outer.y + 14 };
      case 6: // 9 o'clock: SPACES
        return { anchor: 'end', x: outer.x - 16, nameY: outer.y - 5, pctY: outer.y + 11 };
      case 7: // 10:30: AGENT OPS
      default:
        return { anchor: 'end', x: outer.x - 15, nameY: outer.y - 8, pctY: outer.y + 8 };
    }
  }

  function normalizeRadarDomains(domains) {
    const byId = Object.create(null);
    if (Array.isArray(domains)) {
      for (let i = 0; i < domains.length; i += 1) {
        const item = domains[i];
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || item.domain || '').trim();
        if (id) byId[id] = item;
      }
    } else if (domains && typeof domains === 'object') {
      const keys = Object.keys(domains);
      for (let i = 0; i < keys.length; i += 1) {
        const id = keys[i];
        if (domains[id] && typeof domains[id] === 'object') {
          byId[id] = domains[id];
        }
      }
    }

    return RADAR_AXES.map(function (axis) {
      const raw = byId[axis.id] || {};
      const answered = toNonNegInt(raw.answered);
      const total = toNonNegInt(raw.total);
      const pct = raw.pct != null && raw.pct !== ''
        ? clampPct(raw.pct)
        : (total > 0 ? clampPct((answered / total) * 100) : 0);
      const traits = Array.isArray(raw.signature_traits)
        ? raw.signature_traits.map(function (t) { return stripEmDash(t).trim(); }).filter(Boolean)
        : [];
      const topTrait = traits.length > 0
        ? traits[0]
        : (total > 0 && answered >= total ? 'Calibrated' : 'Pending calibration');
      const fullLabel = stripEmDash(raw.label || axis.defaultLabel).trim() || axis.defaultLabel;

      return {
        id: axis.id,
        shortLabel: axis.shortLabel,
        label: fullLabel,
        answered,
        total,
        pct,
        topTrait,
      };
    });
  }

  function computeAxisGeometry(axes) {
    const radii = [];
    const points = [];
    const pcts = [];
    for (let i = 0; i < axes.length; i += 1) {
      const d = axes[i];
      const calRadius = d.pct > 0
        ? Math.max(5.5, (d.pct / 100) * OUTER_RADIUS)
        : ORIGIN_SEED_RADIUS;
      const cp = polarPoint(i, calRadius);
      radii.push(Math.round(calRadius * 100) / 100);
      points.push(fmtNum(cp.x) + ',' + fmtNum(cp.y));
      pcts.push(d.pct);
    }
    return {
      radii,
      points,
      pointsStr: points.join(' '),
      pcts,
    };
  }

  function resolveRadarKey(opts) {
    if (opts && typeof opts.radarKey === 'string' && opts.radarKey.trim()) {
      return opts.radarKey.trim();
    }
    return 'default';
  }

  function recordRadarSnapshot(domains, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const radarKey = resolveRadarKey(o);
    if (!o.force && radarHistoryMap.has(radarKey)) {
      return radarHistoryMap.get(radarKey);
    }
    const axes = normalizeRadarDomains(domains);
    const geom = computeAxisGeometry(axes);
    const entry = {
      radarKey,
      axes,
      pcts: geom.pcts,
      radii: geom.radii,
      points: geom.points,
      pointsStr: geom.pointsStr,
      previous: null,
      hasDelta: false,
      deltaDomains: [],
      timestamp: Date.now(),
    };
    radarHistoryMap.set(radarKey, entry);
    return entry;
  }

  function getRadarState(radarKey) {
    const key = typeof radarKey === 'string' && radarKey.trim() ? radarKey.trim() : 'default';
    return radarHistoryMap.get(key) || null;
  }

  function resetRadarHistory(radarKey) {
    if (typeof radarKey === 'string' && radarKey.trim()) {
      radarHistoryMap.delete(radarKey.trim());
    } else {
      radarHistoryMap.clear();
    }
  }

  /**
   * Renders a museum-grade 8-axis octagonal calibration fingerprint radar SVG.
   * Stores previous 8-axis polygon coordinates per radarKey so changes emit a
   * dashed ghost trail (alpha 0.28) and spring-morph metadata for hydrateRadar().
   * @param {Array|Object} domains - Calibrated taste domains from /api/taste
   * @param {Object} [opts] - Optional config: { activeDomain, gardenersData, gardenerData, gardeners, className, ariaLabel, radarKey, recordSnapshot }
   * @returns {string} Self-contained SVG markup
   */
  function renderTasteGenomeRadarSvg(domains, opts) {
    ensureStyles();

    const o = opts && typeof opts === 'object' ? opts : {};
    const axes = normalizeRadarDomains(domains);
    const geom = computeAxisGeometry(axes);
    const radarKey = resolveRadarKey(o);
    const prevEntry = radarHistoryMap.get(radarKey) || null;

    const deltaMap = Object.create(null);
    const deltaDomains = [];
    if (prevEntry && Array.isArray(prevEntry.pcts) && prevEntry.pcts.length === axes.length) {
      for (let i = 0; i < axes.length; i += 1) {
        const diff = axes[i].pct - prevEntry.pcts[i];
        if (diff !== 0) {
          deltaMap[axes[i].id] = diff;
          deltaDomains.push({
            id: axes[i].id,
            prevPct: prevEntry.pcts[i],
            nextPct: axes[i].pct,
            delta: diff,
          });
        }
      }
    }
    const hasDelta = deltaDomains.length > 0 && Boolean(prevEntry && prevEntry.pointsStr);
    const prevPointsStr = hasDelta ? prevEntry.pointsStr : geom.pointsStr;
    const prevRadii = hasDelta ? prevEntry.radii.slice() : geom.radii.slice();

    if (o.recordSnapshot !== false) {
      radarHistoryMap.set(radarKey, {
        radarKey,
        axes,
        pcts: geom.pcts.slice(),
        radii: geom.radii.slice(),
        points: geom.points.slice(),
        pointsStr: geom.pointsStr,
        previous: prevEntry
          ? {
              pcts: prevEntry.pcts.slice(),
              radii: prevEntry.radii.slice(),
              points: prevEntry.points.slice(),
              pointsStr: prevEntry.pointsStr,
            }
          : null,
        hasDelta,
        deltaDomains: deltaDomains.slice(),
        timestamp: Date.now(),
      });
    }

    const gardenerInfo = extractGardenerDepthMap(domains, o);
    const activeDomain = typeof o.activeDomain === 'string' ? o.activeDomain.trim() : '';
    const extraClass = typeof o.className === 'string'
      ? o.className.trim().split(/\s+/).map(function (c) { return c.replace(SAFE_CLASS_RE, ''); }).filter(Boolean).join(' ')
      : '';
    const svgClass = extraClass ? ('tfx-genome-radar-svg ' + extraClass) : 'tfx-genome-radar-svg';
    const ariaLabel = stripEmDash(o.ariaLabel || '8-axis Taste Genome calibration radar').trim();

    radarInstanceSeq += 1;
    const uid = 'tfx-gr-' + radarInstanceSeq;
    const fillGradId = uid + '-fill';
    const fillRadId = uid + '-radfill';
    const strokeGradId = uid + '-stroke';
    const glowFilterId = uid + '-glow';

    // 0. Concentric precision compass bezel + 32 radial vernier graduation hairlines
    const compassR = OUTER_RADIUS + 7;
    const compassTicks = [];
    for (let t = 0; t < 32; t += 1) {
      const ang = -Math.PI / 2 + (t * (2 * Math.PI)) / 32;
      const isMajor = t % 4 === 0;
      const rIn = compassR - (isMajor ? 4.5 : 2.4);
      const rOut = compassR + (isMajor ? 1.5 : 0);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      compassTicks.push(
        '<line class="tfx-radar-compass-tick' + (isMajor ? ' is-major' : '') + '" ' +
          'x1="' + fmtNum(CENTER_X + rIn * c) + '" y1="' + fmtNum(CENTER_Y + rIn * s) + '" ' +
          'x2="' + fmtNum(CENTER_X + rOut * c) + '" y2="' + fmtNum(CENTER_Y + rOut * s) + '" />'
      );
    }
    const compassSvg =
      '<g class="tfx-radar-compass" aria-hidden="true">' +
        '<circle class="tfx-radar-compass-ring" cx="' + CENTER_X + '" cy="' + CENTER_Y + '" r="' + compassR + '" stroke-dasharray="1.5 3.5" />' +
        '<circle class="tfx-radar-compass-ring" cx="' + CENTER_X + '" cy="' + CENTER_Y + '" r="' + fmtNum(OUTER_RADIUS * 0.5) + '" stroke-opacity="0.55" />' +
        compassTicks.join('') +
      '</g>';

    // 1. 4 concentric octagonal calibration rings (25%, 50%, 75%, 100%)
    const ringsSvg = RING_SCALES.map(function (scale, ringIdx) {
      const pts = [];
      for (let i = 0; i < 8; i += 1) {
        const p = polarPoint(i, OUTER_RADIUS * scale);
        pts.push(fmtNum(p.x) + ',' + fmtNum(p.y));
      }
      const isOuter = ringIdx === RING_SCALES.length - 1;
      const isMid = ringIdx === 1;
      const stroke = isOuter
        ? 'var(--border-strong, rgba(255, 255, 255, 0.16))'
        : 'var(--border-hairline, rgba(255, 255, 255, 0.09))';
      const dashAttr = isMid ? ' stroke-dasharray="2 2.5"' : '';
      return (
        '<polygon class="tfx-radar-ring is-ring-' + Math.round(scale * 100) + '" ' +
          'points="' + pts.join(' ') + '" fill="none" stroke="' + stroke + '" ' +
          'stroke-width="' + (isOuter ? '1.15' : '0.85') + '"' + dashAttr + ' />'
      );
    }).join('');

    // Compute min/max calibration percentages for distance-from-100% color encoding
    let minPct = 100;
    let maxPct = 0;
    for (let i = 0; i < axes.length; i += 1) {
      if (axes[i].pct < minPct) minPct = axes[i].pct;
      if (axes[i].pct > maxPct) maxPct = axes[i].pct;
    }

    // Optional weekly 7d baseline polygon & delta ticks
    const weeklyPrevMap = (o.weeklyPrevPcts && typeof o.weeklyPrevPcts === 'object') ? o.weeklyPrevPcts : null;
    const weeklyDeltaOpt = (o.weeklyDeltas && typeof o.weeklyDeltas === 'object') ? o.weeklyDeltas : null;
    const weeklyPrevByIdx = [];
    const weeklyBaselinePts = [];
    const weeklyDeltaSegs = [];
    let hasWeeklyBaseline = false;
    let hasNonZeroWeeklyBaseline = false;
    for (let i = 0; i < axes.length; i += 1) {
      const d = axes[i];
      let prevWeekPct = d.pct;
      if (weeklyPrevMap && weeklyPrevMap[d.id] != null && Number.isFinite(Number(weeklyPrevMap[d.id]))) {
        prevWeekPct = clampPct(weeklyPrevMap[d.id]);
      } else if (weeklyDeltaOpt && weeklyDeltaOpt[d.id] != null && Number.isFinite(Number(weeklyDeltaOpt[d.id]))) {
        prevWeekPct = clampPct(d.pct - Number(weeklyDeltaOpt[d.id]));
      }
      weeklyPrevByIdx.push(prevWeekPct);
      if (prevWeekPct !== d.pct) {
        hasWeeklyBaseline = true;
      }
      if (prevWeekPct > 0) {
        hasNonZeroWeeklyBaseline = true;
      }
      const prevR = prevWeekPct > 0 ? Math.max(5.5, (prevWeekPct / 100) * OUTER_RADIUS) : ORIGIN_SEED_RADIUS;
      const wp = polarPoint(i, prevR);
      weeklyBaselinePts.push(fmtNum(wp.x) + ',' + fmtNum(wp.y));
      if (prevWeekPct > 0 && prevWeekPct < d.pct) {
        const curP = polarPoint(i, geom.radii[i]);
        weeklyDeltaSegs.push(
          '<line class="tfx-weekly-delta-seg" x1="' + fmtNum(wp.x) + '" y1="' + fmtNum(wp.y) + '" ' +
            'x2="' + fmtNum(curP.x) + '" y2="' + fmtNum(curP.y) + '" />'
        );
      }
    }

    // 2. Crisp calibration scale ticks (50, 100) along 12 o'clock spoke (>=11px floor)
    const scaleTicksSvg = [0.5, 1.0].map(function (scale) {
      const pctTick = Math.round(scale * 100);
      const y = CENTER_Y - OUTER_RADIUS * scale + 4;
      return (
        '<text class="tfx-radar-scale-tick" x="' + fmtNum(CENTER_X + 6) + '" y="' + fmtNum(y) + '" ' +
          'text-anchor="start" font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" ' +
          'font-variant-numeric="tabular-nums" aria-hidden="true">' +
          pctTick +
        '</text>'
      );
    }).join('');

    // 3. 8 radial spokes (4 cardinal hairlines subtly crisper than 4 diagonals; gap spoke highlighted)
    const spokesSvg = axes.map(function (axis, i) {
      const outer = polarPoint(i, OUTER_RADIUS);
      const isCardinal = i % 2 === 0;
      const tier = resolveGapTier(axis.pct, minPct, maxPct);
      const stroke = isCardinal
        ? 'var(--border-strong, rgba(255, 255, 255, 0.16))'
        : 'var(--border-hairline, rgba(255, 255, 255, 0.09))';
      return (
        '<line class="tfx-radar-spoke is-tier-' + tier + (isCardinal ? ' is-cardinal' : '') + '" ' +
          'data-axis-index="' + i + '" data-taste-radar-domain="' + escAttr(axis.id) + '" ' +
          'x1="' + CENTER_X + '" y1="' + CENTER_Y + '" ' +
          'x2="' + fmtNum(outer.x) + '" y2="' + fmtNum(outer.y) + '" ' +
          'stroke="' + stroke + '" stroke-width="' + (isCardinal ? '1.05' : '0.85') + '" />'
      );
    }).join('');

    // 4. Primary calibration polygon + optional Gardener depth polygon + vertices + labels
    const calPts = geom.points;
    const gardenerPts = [];
    const verticesSvg = [];
    const labelsSvg = [];

    for (let i = 0; i < axes.length; i += 1) {
      const d = axes[i];
      const cp = polarPoint(i, geom.radii[i]);
      const tier = resolveGapTier(d.pct, minPct, maxPct);
      const isGapTier = tier === 'gap';

      const gLvl = gardenerInfo.map[d.id] || 0;
      if (gardenerInfo.hasAny) {
        const gRadius = gLvl > 0
          ? Math.max(10, (gLvl / 5) * OUTER_RADIUS)
          : ORIGIN_SEED_RADIUS;
        const gp = polarPoint(i, gRadius);
        gardenerPts.push(fmtNum(gp.x) + ',' + fmtNum(gp.y));
      }

      const isActive = activeDomain === d.id;
      const weekDeltaVal = weeklyDeltaOpt && Number.isFinite(Number(weeklyDeltaOpt[d.id]))
        ? Math.round(Number(weeklyDeltaOpt[d.id]))
        : (weeklyPrevMap && Number.isFinite(Number(weeklyPrevMap[d.id])) ? (d.pct - clampPct(weeklyPrevMap[d.id])) : 0);
      const deltaVal = deltaMap[d.id] || weekDeltaVal || 0;
      const deltaSuffix = deltaVal !== 0 ? (' (' + (deltaVal > 0 ? '+' : '') + deltaVal + '%)') : '';
      const gapNote = d.pct < 100 ? (' [' + (100 - d.pct) + '% to calibrated]') : ' [100% calibrated]';
      const tipBase = d.label + ': ' + d.answered + '/' + d.total + ' (' + d.pct + '%)' + deltaSuffix + gapNote + ' - ' + d.topTrait;
      const tipFull = gLvl > 0 ? (tipBase + ' [Gardener L' + gLvl + ']') : tipBase;
      const escapedTip = escAttr(tipFull);
      const escapedId = escAttr(d.id);
      const escapedAria = escAttr('Select ' + d.label + ' (' + d.pct + '%)');
      const baseR = isActive ? '5.4' : (isGapTier ? '5.0' : '4.2');

      const dotFill = tier === 'calibrated'
        ? '#34d399'
        : tier === 'strong'
          ? '#38bdf8'
          : tier === 'mid'
            ? '#fbbf24'
            : '#ff6b4a';

      verticesSvg.push(
        '<g class="tfx-radar-vertex is-tier-' + tier + (isActive ? ' is-active' : '') + '" ' +
          'data-axis-index="' + i + '" ' +
          'data-gap-tier="' + tier + '" ' +
          'data-taste-radar-domain="' + escapedId + '" ' +
          'data-axis-short="' + escAttr(d.shortLabel) + '" ' +
          'data-axis-pct="' + d.pct + '" ' +
          'data-axis-answered="' + d.answered + '" ' +
          'data-axis-total="' + d.total + '" ' +
          'data-axis-delta="' + deltaVal + '">' +
          '<circle class="tfx-radar-hit" cx="' + fmtNum(cp.x) + '" cy="' + fmtNum(cp.y) + '" r="14" ' +
            'fill="transparent" stroke="none" tabindex="0" role="button" ' +
            'aria-label="' + escapedAria + '" ' +
            'data-axis-index="' + i + '" ' +
            'data-viz-tip="' + escapedTip + '" ' +
            'data-taste-radar-domain="' + escapedId + '">' +
            '<title>' + escHtml(tipFull) + '</title>' +
          '</circle>' +
          '<circle class="tfx-radar-vertex-halo" cx="' + fmtNum(cp.x) + '" cy="' + fmtNum(cp.y) + '" r="' + fmtNum(Number(baseR) + 3.2) + '" ' +
            'fill="none" stroke="' + dotFill + '" stroke-opacity="0.34" stroke-width="1.05" ' +
            'style="pointer-events:none;" />' +
          (isGapTier
            ? '<circle class="tfx-radar-gap-ring" cx="' + fmtNum(cp.x) + '" cy="' + fmtNum(cp.y) + '" r="9.6" />'
            : '') +
          (isActive
            ? '<circle class="tfx-radar-active-ring" cx="' + fmtNum(cp.x) + '" cy="' + fmtNum(cp.y) + '" r="8.4" ' +
                'fill="none" stroke="var(--accent-cyan, #38bdf8)" stroke-opacity="0.82" stroke-width="1.5" ' +
                'style="pointer-events:none;" />'
            : '') +
          '<circle class="tfx-radar-dot" cx="' + fmtNum(cp.x) + '" cy="' + fmtNum(cp.y) + '" r="' + baseR + '" ' +
            'data-base-r="' + baseR + '" ' +
            'fill="' + dotFill + '" stroke="var(--surface-raised, #0a0a0a)" stroke-width="1.5" ' +
            'style="pointer-events:none;" />' +
          '<circle class="tfx-radar-dot-core" cx="' + fmtNum(cp.x - 0.8) + '" cy="' + fmtNum(cp.y - 0.8) + '" r="1.35" ' +
            'fill="#ffffff" fill-opacity="0.72" style="pointer-events:none;" />' +
        '</g>'
      );

      const pos = computeLabelPosition(i);
      const prevWeekPct = weeklyPrevByIdx[i] != null ? weeklyPrevByIdx[i] : d.pct;
      const showInlineWeekDelta = weekDeltaVal > 0 && prevWeekPct > 0 && weekDeltaVal < d.pct;
      const weekTag = showInlineWeekDelta ? (' +' + weekDeltaVal) : '';
      const pctReadout = gLvl > 0 ? (d.pct + '%' + weekTag + ' · L' + gLvl) : (d.pct + '%' + weekTag);

      labelsSvg.push(
        '<g class="tfx-radar-axis-label is-tier-' + tier + (isActive ? ' is-active' : '') + '" ' +
          'data-axis-index="' + i + '" ' +
          'data-gap-tier="' + tier + '" ' +
          'tabindex="0" role="button" aria-label="' + escapedAria + '" ' +
          'data-viz-tip="' + escapedTip + '" ' +
          'data-taste-radar-domain="' + escapedId + '">' +
          '<title>' + escHtml(tipFull) + '</title>' +
          '<text class="tfx-radar-axis-name" x="' + fmtNum(pos.x) + '" y="' + fmtNum(pos.nameY) + '" ' +
            'text-anchor="' + pos.anchor + '" ' +
            'font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" ' +
            'letter-spacing="0.04em">' +
            escHtml(d.shortLabel) +
          '</text>' +
          '<text class="tfx-radar-axis-pct" x="' + fmtNum(pos.x) + '" y="' + fmtNum(pos.pctY) + '" ' +
            'text-anchor="' + pos.anchor + '" ' +
            'font-family="var(--font-mono, monospace)" font-size="12" font-weight="600" ' +
            'font-variant-numeric="tabular-nums">' +
            escHtml(pctReadout) +
          '</text>' +
        '</g>'
      );
    }

    const weeklyPolySvg = hasWeeklyBaseline
      ? (
          (hasNonZeroWeeklyBaseline
            ? '<polygon class="tfx-weekly-baseline-poly" points="' + weeklyBaselinePts.join(' ') + '" />'
            : '<circle class="tfx-weekly-baseline-poly" cx="' + CENTER_X + '" cy="' + CENTER_Y + '" r="10" />') +
          weeklyDeltaSegs.join('')
        )
      : '';

    const ghostPolySvg = hasDelta
      ? (
          '<polygon class="tfx-genome-ghost" points="' + prevPointsStr + '" ' +
            'fill="none" stroke="var(--accent-cyan, #38bdf8)" stroke-opacity="1" ' +
            'stroke-width="1.45" stroke-dasharray="4 3" stroke-linejoin="round" ' +
            'opacity="' + RADAR_GHOST_ALPHA + '" data-ghost-active="true" ' +
            'style="pointer-events:none;opacity:' + RADAR_GHOST_ALPHA + ';" />'
        )
      : '';

    const gardenerPolySvg = gardenerInfo.hasAny
      ? (
          '<polygon class="tfx-gardener-poly" points="' + gardenerPts.join(' ') + '" ' +
            'fill="var(--tint-cyan-bg, rgba(56, 189, 248, 0.08))" ' +
            'stroke="var(--accent-cyan, #38bdf8)" stroke-opacity="0.72" ' +
            'stroke-width="1.25" stroke-dasharray="3 2.5" stroke-linejoin="round" ' +
            'style="pointer-events:none;" />'
        )
      : '';

    const legendItems = [];
    legendItems.push(
      '<circle cx="16" cy="368" r="3.5" fill="#34d399" />' +
      '<text x="25" y="372" font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" fill="var(--ink-muted, #8c8c96)">100%</text>'
    );
    legendItems.push(
      '<circle cx="78" cy="368" r="3.5" fill="#ff6b4a" />' +
      '<text x="87" y="372" font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" fill="var(--ink-muted, #8c8c96)">GAP</text>'
    );
    if (hasWeeklyBaseline) {
      legendItems.push(
        '<line x1="138" y1="368" x2="154" y2="368" stroke="var(--ink-muted, #8c8c96)" stroke-width="1.4" stroke-dasharray="3 2" />' +
        '<text x="160" y="372" font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" fill="var(--ink-muted, #8c8c96)">7D PRIOR</text>'
      );
    }
    if (gardenerInfo.hasAny) {
      legendItems.push(
        '<line class="tfx-radar-legend-gardener" x1="398" y1="368" x2="414" y2="368" stroke="var(--accent-cyan, #38bdf8)" stroke-width="1.5" stroke-dasharray="2.5 2" />' +
        '<text x="420" y="372" font-family="var(--font-mono, monospace)" font-size="11" font-weight="500" fill="var(--ink-muted, #8c8c96)">GARDENER L1-L5</text>'
      );
    }
    const legendSvg = '<g class="tfx-radar-legend" aria-hidden="true">' + legendItems.join('') + '</g>';

    const hoverReadoutSvg =
      '<g class="tfx-radar-hover-readout" aria-hidden="true" transform="translate(' + CENTER_X + ', ' + CENTER_Y + ')">' +
        '<rect class="tfx-radar-hover-bg" x="-90" y="-13" width="180" height="26" rx="6" />' +
        '<text class="tfx-radar-hover-text" x="0" y="4" text-anchor="middle"></text>' +
      '</g>';

    return (
      '<svg class="' + svgClass + '" viewBox="0 0 ' + VIEWBOX_W + ' ' + VIEWBOX_H + '" width="100%" ' +
        'role="img" aria-label="' + escAttr(ariaLabel) + '" ' +
        'data-radar-key="' + escAttr(radarKey) + '" ' +
        'data-has-delta="' + (hasDelta ? 'true' : 'false') + '" ' +
        'data-prev-radii="' + escAttr(prevRadii.join(',')) + '" ' +
        'data-target-radii="' + escAttr(geom.radii.join(',')) + '" ' +
        'data-prev-points="' + escAttr(prevPointsStr) + '" ' +
        'data-target-points="' + escAttr(geom.pointsStr) + '" ' +
        'style="display:block;width:100%;max-width:560px;height:auto;overflow:visible;">' +
        '<defs>' +
          '<radialGradient id="' + fillRadId + '" cx="50%" cy="50%" r="58%">' +
            '<stop offset="0%" stop-color="var(--accent-cyan, #38bdf8)" stop-opacity="0.06" />' +
            '<stop offset="68%" stop-color="var(--accent-green, #34d399)" stop-opacity="0.20" />' +
            '<stop offset="100%" stop-color="var(--accent-cyan, #38bdf8)" stop-opacity="0.32" />' +
          '</radialGradient>' +
          '<linearGradient id="' + fillGradId + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
            '<stop offset="0%" stop-color="var(--accent-green, #34d399)" stop-opacity="0.26" />' +
            '<stop offset="100%" stop-color="var(--accent-cyan, #38bdf8)" stop-opacity="0.14" />' +
          '</linearGradient>' +
          '<linearGradient id="' + strokeGradId + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
            '<stop offset="0%" stop-color="var(--accent-green, #34d399)" />' +
            '<stop offset="55%" stop-color="var(--accent-cyan, #38bdf8)" />' +
            '<stop offset="100%" stop-color="var(--accent-green, #34d399)" />' +
          '</linearGradient>' +
          '<filter id="' + glowFilterId + '" x="-20%" y="-20%" width="140%" height="140%">' +
            '<feGaussianBlur stdDeviation="2.4" result="blur" />' +
            '<feMerge>' +
              '<feMergeNode in="blur" />' +
              '<feMergeNode in="SourceGraphic" />' +
            '</feMerge>' +
          '</filter>' +
        '</defs>' +
        '<g class="tfx-radar-grid">' +
          compassSvg +
          ringsSvg +
          spokesSvg +
          scaleTicksSvg +
          '<line x1="' + fmtNum(CENTER_X - 4) + '" y1="' + CENTER_Y + '" x2="' + fmtNum(CENTER_X + 4) + '" y2="' + CENTER_Y + '" stroke="var(--border-strong, rgba(255, 255, 255, 0.22))" stroke-width="1" />' +
          '<line x1="' + CENTER_X + '" y1="' + fmtNum(CENTER_Y - 4) + '" x2="' + CENTER_X + '" y2="' + fmtNum(CENTER_Y + 4) + '" stroke="var(--border-strong, rgba(255, 255, 255, 0.22))" stroke-width="1" />' +
        '</g>' +
        gardenerPolySvg +
        weeklyPolySvg +
        ghostPolySvg +
        '<polygon class="tfx-genome-glow" points="' + calPts.join(' ') + '" ' +
          'fill="none" stroke="url(#' + strokeGradId + ')" stroke-opacity="0.45" ' +
          'stroke-width="2.4" stroke-linejoin="round" filter="url(#' + glowFilterId + ')" ' +
          'style="pointer-events:none;" />' +
        '<polygon class="tfx-genome-poly" points="' + calPts.join(' ') + '" ' +
          'fill="url(#' + fillRadId + ')" stroke="url(#' + strokeGradId + ')" ' +
          'stroke-width="2" stroke-linejoin="round" />' +
        '<g class="tfx-radar-vertices">' + verticesSvg.join('') + '</g>' +
        '<g class="tfx-radar-labels">' + labelsSvg.join('') + '</g>' +
        hoverReadoutSvg +
        legendSvg +
      '</svg>'
    );
  }

  function parseRadiiAttr(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split(',').map(function (s) { return Number(s); });
    if (parts.length !== 8) return null;
    for (let i = 0; i < parts.length; i += 1) {
      if (!Number.isFinite(parts[i])) return null;
    }
    return parts;
  }

  function applyRadarGeometryToSvg(svgEl, radii) {
    if (!svgEl || !Array.isArray(radii) || radii.length !== 8) return;
    const pts = [];
    for (let i = 0; i < 8; i += 1) {
      const p = polarPoint(i, radii[i]);
      const fx = fmtNum(p.x);
      const fy = fmtNum(p.y);
      pts.push(fx + ',' + fy);
      if (typeof svgEl.querySelector === 'function') {
        const vGroup = svgEl.querySelector('.tfx-radar-vertex[data-axis-index="' + i + '"]');
        if (vGroup && typeof vGroup.querySelector === 'function') {
          const hit = vGroup.querySelector('.tfx-radar-hit');
          const dot = vGroup.querySelector('.tfx-radar-dot');
          const dotCore = vGroup.querySelector('.tfx-radar-dot-core');
          const halo = vGroup.querySelector('.tfx-radar-vertex-halo');
          const ring = vGroup.querySelector('.tfx-radar-active-ring');
          const gapRing = vGroup.querySelector('.tfx-radar-gap-ring');
          if (hit) { hit.setAttribute('cx', fx); hit.setAttribute('cy', fy); }
          if (dot) { dot.setAttribute('cx', fx); dot.setAttribute('cy', fy); }
          if (dotCore) { dotCore.setAttribute('cx', fmtNum(p.x - 0.8)); dotCore.setAttribute('cy', fmtNum(p.y - 0.8)); }
          if (halo) { halo.setAttribute('cx', fx); halo.setAttribute('cy', fy); }
          if (ring) { ring.setAttribute('cx', fx); ring.setAttribute('cy', fy); }
          if (gapRing) { gapRing.setAttribute('cx', fx); gapRing.setAttribute('cy', fy); }
        }
      }
    }
    const ptsStr = pts.join(' ');
    if (typeof svgEl.querySelector === 'function') {
      const poly = svgEl.querySelector('.tfx-genome-poly');
      const glow = svgEl.querySelector('.tfx-genome-glow');
      if (poly) poly.setAttribute('points', ptsStr);
      if (glow) glow.setAttribute('points', ptsStr);
    }
  }

  function cancelRadarAnim(svgEl, snapTarget) {
    if (!svgEl || typeof svgEl !== 'object') return;
    const active = activeRadarAnimMap.get(svgEl);
    if (!active) return;
    activeRadarAnimMap.delete(svgEl);
    if (active.rafId != null) {
      const win = getWin();
      if (win && typeof win.cancelAnimationFrame === 'function') {
        try { win.cancelAnimationFrame(active.rafId); } catch (_) {}
      }
    }
    if (active.ghostTimer != null) {
      clearTimeout(active.ghostTimer);
    }
    if (active.ghostAnim && typeof active.ghostAnim.cancel === 'function') {
      try { active.ghostAnim.cancel(); } catch (_) {}
    }
    if (snapTarget && active.targetRadii) {
      applyRadarGeometryToSvg(svgEl, active.targetRadii);
    }
  }

  function bindRadarHoverReadout(svgEl) {
    if (!svgEl || hydratedRadarSet.has(svgEl) || typeof svgEl.addEventListener !== 'function') {
      return false;
    }
    hydratedRadarSet.add(svgEl);

    let currentIdx = -1;

    function clearHover() {
      if (currentIdx < 0) return;
      const prevIdx = currentIdx;
      currentIdx = -1;
      const spoke = svgEl.querySelector('.tfx-radar-spoke[data-axis-index="' + prevIdx + '"]');
      const vertex = svgEl.querySelector('.tfx-radar-vertex[data-axis-index="' + prevIdx + '"]');
      const label = svgEl.querySelector('.tfx-radar-axis-label[data-axis-index="' + prevIdx + '"]');
      if (spoke && spoke.classList) spoke.classList.remove('is-hovered');
      if (vertex && vertex.classList) {
        vertex.classList.remove('is-hovered');
        const dot = vertex.querySelector('.tfx-radar-dot');
        if (dot) {
          const baseR = dot.getAttribute('data-base-r') || '3.3';
          dot.setAttribute('r', baseR);
        }
      }
      if (label && label.classList) label.classList.remove('is-hovered');
      const readout = svgEl.querySelector('.tfx-radar-hover-readout');
      if (readout && readout.classList) readout.classList.remove('is-visible');
    }

    function setHover(idx) {
      if (!Number.isInteger(idx) || idx < 0 || idx > 7) {
        clearHover();
        return;
      }
      if (currentIdx === idx) return;
      clearHover();
      currentIdx = idx;

      const spoke = svgEl.querySelector('.tfx-radar-spoke[data-axis-index="' + idx + '"]');
      const vertex = svgEl.querySelector('.tfx-radar-vertex[data-axis-index="' + idx + '"]');
      const label = svgEl.querySelector('.tfx-radar-axis-label[data-axis-index="' + idx + '"]');
      if (spoke && spoke.classList) spoke.classList.add('is-hovered');
      if (label && label.classList) label.classList.add('is-hovered');
      if (vertex && vertex.classList) {
        vertex.classList.add('is-hovered');
        const dot = vertex.querySelector('.tfx-radar-dot');
        if (dot) {
          const baseR = Number(dot.getAttribute('data-base-r') || '3.3');
          const nextR = Number.isFinite(baseR) ? (baseR + RADAR_HOVER_RADIUS_DELTA) : (3.3 + RADAR_HOVER_RADIUS_DELTA);
          dot.setAttribute('r', fmtNum(nextR));
        }
      }

      const readout = svgEl.querySelector('.tfx-radar-hover-readout');
      if (readout && vertex) {
        const shortName = vertex.getAttribute('data-axis-short') || RADAR_AXES[idx].shortLabel;
        const pct = vertex.getAttribute('data-axis-pct') || '0';
        const answered = vertex.getAttribute('data-axis-answered') || '0';
        const total = vertex.getAttribute('data-axis-total') || '0';
        const delta = Number(vertex.getAttribute('data-axis-delta') || '0');
        const deltaPart = delta !== 0 ? (' ' + (delta > 0 ? '+' : '') + delta + '%') : '';
        const textContent = shortName + ' ' + pct + '%' + deltaPart + ' (' + answered + '/' + total + ')';
        const textEl = readout.querySelector('.tfx-radar-hover-text');
        const bgEl = readout.querySelector('.tfx-radar-hover-bg');
        if (textEl) textEl.textContent = textContent;
        const estWidth = Math.max(120, Math.min(260, Math.round(textContent.length * 7.2 + 22)));
        if (bgEl) {
          bgEl.setAttribute('x', fmtNum(-estWidth / 2));
          bgEl.setAttribute('width', fmtNum(estWidth));
        }
        const dot = vertex.querySelector('.tfx-radar-dot');
        const dotX = dot ? Number(dot.getAttribute('cx')) : CENTER_X;
        const dotY = dot ? Number(dot.getAttribute('cy')) : CENTER_Y;
        const halfW = estWidth / 2 + 8;
        const rx = Math.max(halfW, Math.min(VIEWBOX_W - halfW, Number.isFinite(dotX) ? dotX : CENTER_X));
        const rawY = Number.isFinite(dotY) ? (dotY < 96 ? dotY + 28 : dotY - 26) : CENTER_Y;
        const ry = Math.max(20, Math.min(VIEWBOX_H - 22, rawY));
        readout.setAttribute('transform', 'translate(' + fmtNum(rx) + ', ' + fmtNum(ry) + ')');
        if (readout.classList) readout.classList.add('is-visible');
      }
    }

    function resolveIndexFromEvent(ev) {
      const target = ev && ev.target;
      if (!target || typeof target.closest !== 'function') return -1;
      const host = target.closest('[data-axis-index]');
      if (!host) return -1;
      const parsed = Number(host.getAttribute('data-axis-index'));
      return Number.isInteger(parsed) ? parsed : -1;
    }

    svgEl.addEventListener('mouseover', function (ev) {
      const idx = resolveIndexFromEvent(ev);
      if (idx >= 0) setHover(idx);
    });
    svgEl.addEventListener('mouseout', function (ev) {
      const related = ev && ev.relatedTarget;
      if (related && typeof related.closest === 'function') {
        const nextHost = related.closest('[data-axis-index]');
        if (nextHost && svgEl.contains && svgEl.contains(nextHost)) {
          const nextIdx = Number(nextHost.getAttribute('data-axis-index'));
          if (Number.isInteger(nextIdx) && nextIdx === currentIdx) return;
        }
      }
      clearHover();
    });
    svgEl.addEventListener('focusin', function (ev) {
      const idx = resolveIndexFromEvent(ev);
      if (idx >= 0) setHover(idx);
    });
    svgEl.addEventListener('focusout', function () {
      clearHover();
    });
    return true;
  }

  /**
   * Hydrates a rendered 8-axis radar SVG with:
   * 1. Interactive vertex/spoke hover readout (+2.5px dot radius in 110ms)
   * 2. Spring-animated polygon morph (stiffness 220, damping 22, ~320ms) when delta exists
   * 3. Dashed ghost trail (alpha 0.28) fading smoothly over 1.4s
   * @param {Element} svgOrContainer - `.tfx-genome-radar-svg` or wrapper container
   * @returns {{ hydrated: boolean, morphed: boolean, bypassed: boolean }}
   */
  function hydrateRadar(svgOrContainer) {
    ensureStyles();
    if (!svgOrContainer) {
      return { hydrated: false, morphed: false, bypassed: false };
    }
    const svgEl =
      svgOrContainer.classList && svgOrContainer.classList.contains('tfx-genome-radar-svg')
        ? svgOrContainer
        : (typeof svgOrContainer.querySelector === 'function'
            ? svgOrContainer.querySelector('.tfx-genome-radar-svg')
            : null);

    if (!svgEl) {
      return { hydrated: false, morphed: false, bypassed: false };
    }

    bindRadarHoverReadout(svgEl);
    ensureVisibilityTracking(svgEl);

    const hasDelta = svgEl.getAttribute && svgEl.getAttribute('data-has-delta') === 'true';
    const alreadyPlayed = svgEl.getAttribute && svgEl.getAttribute('data-morph-played') === 'true';
    if (!hasDelta || alreadyPlayed) {
      return { hydrated: true, morphed: false, bypassed: false };
    }

    if (typeof svgEl.setAttribute === 'function') {
      svgEl.setAttribute('data-morph-played', 'true');
    }

    const prevRadii = parseRadiiAttr(svgEl.getAttribute('data-prev-radii'));
    const targetRadii = parseRadiiAttr(svgEl.getAttribute('data-target-radii'));
    const bypass = isMotionBypassed();
    const offscreen = isElementOffscreen(svgEl);
    const ghostEl = typeof svgEl.querySelector === 'function'
      ? svgEl.querySelector('.tfx-genome-ghost')
      : null;

    if (bypass.bypassed || offscreen || !prevRadii || !targetRadii) {
      if (targetRadii) applyRadarGeometryToSvg(svgEl, targetRadii);
      if (ghostEl) {
        if (ghostEl.style) ghostEl.style.opacity = '0';
        if (typeof ghostEl.setAttribute === 'function') {
          ghostEl.setAttribute('opacity', '0');
          ghostEl.setAttribute('data-ghost-active', 'false');
        }
      }
      return { hydrated: true, morphed: false, bypassed: Boolean(bypass.bypassed || offscreen) };
    }

    cancelRadarAnim(svgEl, false);
    const animHandle = { rafId: null, ghostTimer: null, ghostAnim: null, targetRadii };
    activeRadarAnimMap.set(svgEl, animHandle);

    // Ghost trail fade: crisp dashed outline starting at alpha 0.28 fading cleanly over 1.4s
    if (ghostEl) {
      if (typeof ghostEl.animate === 'function') {
        try {
          animHandle.ghostAnim = ghostEl.animate(
            [
              { opacity: RADAR_GHOST_ALPHA },
              { opacity: RADAR_GHOST_ALPHA * 0.72, offset: 0.35 },
              { opacity: 0 },
            ],
            {
              duration: RADAR_GHOST_FADE_MS,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              fill: 'forwards',
            }
          );
        } catch (_) {
          if (ghostEl.style) ghostEl.style.opacity = '0';
        }
      } else if (ghostEl.style) {
        ghostEl.style.opacity = '0';
      }
      animHandle.ghostTimer = setTimeout(function () {
        if (ghostEl && typeof ghostEl.setAttribute === 'function') {
          ghostEl.setAttribute('opacity', '0');
          ghostEl.setAttribute('data-ghost-active', 'false');
        }
        if (ghostEl && ghostEl.style) {
          ghostEl.style.opacity = '0';
        }
      }, RADAR_GHOST_FADE_MS + 40);
    }

    // Spring-animate polygon vertices (stiffness 220, damping 22, ~320ms)
    const win = getWin();
    const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
    if (!raf) {
      applyRadarGeometryToSvg(svgEl, targetRadii);
      return { hydrated: true, morphed: true, bypassed: false };
    }

    const cur = prevRadii.slice();
    const vel = [0, 0, 0, 0, 0, 0, 0, 0];
    applyRadarGeometryToSvg(svgEl, cur);

    let startTs = null;
    let lastTs = null;

    function step(ts) {
      if (activeRadarAnimMap.get(svgEl) !== animHandle) return;
      if (isElementOffscreen(svgEl)) {
        cancelRadarAnim(svgEl, true);
        return;
      }
      if (startTs == null) {
        startTs = ts;
        lastTs = ts;
      }
      const dt = Math.min(0.032, Math.max(0.004, (ts - lastTs) / 1000));
      lastTs = ts;

      let maxDisp = 0;
      let maxVel = 0;
      for (let i = 0; i < 8; i += 1) {
        const disp = cur[i] - targetRadii[i];
        const accel = -RADAR_SPRING_STIFFNESS * disp - RADAR_SPRING_DAMPING * vel[i];
        vel[i] += accel * dt;
        cur[i] = Math.max(ORIGIN_SEED_RADIUS, cur[i] + vel[i] * dt);
        const absD = Math.abs(cur[i] - targetRadii[i]);
        const absV = Math.abs(vel[i]);
        if (absD > maxDisp) maxDisp = absD;
        if (absV > maxVel) maxVel = absV;
      }

      applyRadarGeometryToSvg(svgEl, cur);

      const elapsed = ts - startTs;
      if ((maxDisp < 0.08 && maxVel < 0.15) || elapsed >= RADAR_SPRING_MAX_MS) {
        applyRadarGeometryToSvg(svgEl, targetRadii);
        animHandle.rafId = null;
        return;
      }
      animHandle.rafId = raf(step);
    }

    animHandle.rafId = raf(step);
    return { hydrated: true, morphed: true, bypassed: false };
  }

  /**
   * Renders and hydrates an updated 8-axis radar into a container element,
   * automatically preserving previous coordinates for spring morph + ghost trail.
   * @param {Element} containerEl - Container holding the radar SVG
   * @param {Array|Object} domains - Calibrated taste domains
   * @param {Object} [opts] - Radar options
   * @returns {{ svg: Element|null, html: string, state: Object|null, hydration: Object }}
   */
  function updateRadar(containerEl, domains, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const html = renderTasteGenomeRadarSvg(domains, o);
    const radarKey = resolveRadarKey(o);
    let svg = null;
    let hydration = { hydrated: false, morphed: false, bypassed: false };
    if (containerEl && typeof containerEl === 'object') {
      if ('innerHTML' in containerEl) {
        containerEl.innerHTML = html;
        svg = typeof containerEl.querySelector === 'function'
          ? containerEl.querySelector('.tfx-genome-radar-svg')
          : null;
        if (svg) {
          hydration = hydrateRadar(svg);
        }
      }
    }
    return {
      svg,
      html,
      state: getRadarState(radarKey),
      hydration,
    };
  }

  /**
   * Wraps the active `.taste-question-card` HTML inside a physical 3-card Pantone /
   * Dieter Rams index deck with 0, 1, or 2 under-cards reflecting remaining queue depth.
   * @param {string} cardHtml - Active question card HTML
   * @param {number} remainingCount - Total remaining cards including the top card
   * @returns {string} Wrapped HTML
   */
  function wrapCardInPhysicalStack(cardHtml, remainingCount) {
    ensureStyles();

    const safeHtml = typeof cardHtml === 'string' ? cardHtml : '';
    const count = toNonNegInt(remainingCount);
    const stackDepth = count > 2 ? 2 : (count > 1 ? 1 : 0);

    let underCardsHtml = '';
    if (stackDepth >= 2) {
      underCardsHtml +=
        '<div class="tfx-under-card is-depth-2" aria-hidden="true" data-stack-layer="2"></div>';
    }
    if (stackDepth >= 1) {
      underCardsHtml +=
        '<div class="tfx-under-card is-depth-1" aria-hidden="true" data-stack-layer="1"></div>';
    }

    return (
      '<div class="tfx-deck-stack" data-remaining="' + count + '" data-stack-depth="' + stackDepth + '">' +
        underCardsHtml +
        safeHtml +
      '</div>'
    );
  }

  function cancelElementAnim(el) {
    if (!el || typeof el !== 'object') return;
    activeWaapiElements.delete(el);
    const prev = activeAnimMap.get(el);
    if (!prev) return;
    activeAnimMap.delete(el);
    if (typeof prev.cleanup === 'function') {
      try { prev.cleanup(); } catch (_) {}
    }
    if (prev.anim && typeof prev.anim.cancel === 'function') {
      try { prev.anim.cancel(); } catch (_) {}
    }
  }

  function runWaapiSafe(el, keyframes, options) {
    if (!el || typeof el.animate !== 'function') {
      return Promise.resolve({ skipped: true, reason: 'no-waapi' });
    }
    ensureVisibilityTracking(el);
    if (isElementOffscreen(el)) {
      return Promise.resolve({ skipped: true, reason: 'offscreen' });
    }

    cancelElementAnim(el);
    activeWaapiElements.add(el);

    const prevWillChange = el.style ? el.style.willChange : '';
    if (el.style) {
      el.style.willChange = 'transform, opacity';
    }

    let anim;
    try {
      anim = el.animate(keyframes, options);
    } catch (_) {
      activeWaapiElements.delete(el);
      if (el.style) el.style.willChange = prevWillChange;
      return Promise.resolve({ skipped: true, reason: 'animate-error' });
    }

    return new Promise(function (resolve) {
      let settled = false;
      let timerId = null;

      function finish(status) {
        if (settled) return;
        settled = true;
        activeWaapiElements.delete(el);
        if (timerId != null) {
          clearTimeout(timerId);
          timerId = null;
        }
        if (activeAnimMap.get(el) && activeAnimMap.get(el).anim === anim) {
          activeAnimMap.delete(el);
        }
        if (el.style) {
          el.style.willChange = prevWillChange;
        }
        resolve({ skipped: false, status });
      }

      activeAnimMap.set(el, {
        anim,
        cleanup: function () {
          finish('cancelled');
        },
      });

      const duration = options && Number.isFinite(Number(options.duration))
        ? Number(options.duration)
        : PEEL_DURATION_MS;

      if (anim && anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(
          function () { finish('finished'); },
          function () { finish('aborted'); }
        );
      } else if (anim) {
        anim.onfinish = function () { finish('finished'); };
        anim.oncancel = function () { finish('cancelled'); };
      }

      timerId = setTimeout(function () {
        finish('timeout');
      }, Math.max(0, duration) + 80);
    });
  }

  /**
   * Stamps a crisp LOCKED vermilion/emerald micro-pill (scale 1.25 -> 1 in 110ms)
   * onto the active deck card with 0px CLS before card peel.
   * Returns immediately when prefers-reduced-motion or data-detail="off" is active.
   * @param {Element} cardEl - Active `.taste-question-card` element
   * @param {Object} [opts] - Optional { tone: 'emerald' | 'vermilion', label?: string }
   * @returns {Promise<{skipped: boolean, tone: string, reason?: string, status?: string}>}
   */
  function stampVerdictLock(cardEl, opts) {
    ensureStyles();

    const o = opts && typeof opts === 'object' ? opts : {};
    const tone = o.tone === 'vermilion' ? 'vermilion' : 'emerald';
    const label = stripEmDash(o.label || 'LOCKED').trim() || 'LOCKED';

    if (!cardEl || typeof cardEl !== 'object') {
      return Promise.resolve({ skipped: true, tone, reason: 'no-element' });
    }

    const bypass = isMotionBypassed();
    if (bypass.bypassed) {
      return Promise.resolve({ skipped: true, tone, reason: bypass.reason });
    }

    const doc = getDoc();
    if (!doc || typeof doc.createElement !== 'function' || typeof cardEl.appendChild !== 'function') {
      return Promise.resolve({ skipped: true, tone, reason: 'no-dom' });
    }

    if (typeof cardEl.querySelectorAll === 'function') {
      const existing = cardEl.querySelectorAll('.tfx-lock-stamp');
      for (let i = 0; i < existing.length; i += 1) {
        if (existing[i] && typeof existing[i].remove === 'function') {
          existing[i].remove();
        }
      }
    }

    const pill = doc.createElement('span');
    pill.className = 'tfx-lock-stamp is-' + tone;
    pill.setAttribute('data-tfx-lock-stamp', 'true');
    pill.setAttribute('data-tfx-lock-tone', tone);
    pill.setAttribute('aria-hidden', 'true');
    pill.textContent = label;
    cardEl.appendChild(pill);

    if (typeof pill.animate !== 'function') {
      return Promise.resolve({ skipped: false, tone, status: 'instant' });
    }

    return runWaapiSafe(
      pill,
      [
        { transform: 'scale(1.25) translate3d(0, 0, 0)', opacity: 0 },
        { transform: 'scale(1) translate3d(0, 0, 0)', opacity: 1 },
      ],
      {
        duration: LOCK_STAMP_DURATION_MS,
        easing: EASE_PEEL,
        fill: 'forwards',
      }
    ).then(function (res) {
      return {
        skipped: Boolean(res && res.skipped),
        tone,
        status: res && res.status,
        reason: res && res.reason,
      };
    });
  }

  /**
   * Compositor-only physical card peel animation via WAAPI (`190ms cubic-bezier(0.23, 1, 0.32, 1)`).
   * For `chosen` verdicts, stamps the crisp `LOCKED` micro-pill (`110ms`) first, then slides
   * the card cleanly out while lifting the underlying Pantone/Rams stack card into position.
   * Returns a Promise that resolves cleanly; 0ms instant under prefers-reduced-motion or data-detail="off".
   * @param {Element} cardEl - Active `.taste-question-card` element
   * @param {'chosen'|'skip'|'undo'} [mode='chosen'] - Peel direction / mode
   * @param {Object} [opts] - Optional `{ tone?: 'emerald'|'vermilion', skipStamp?: boolean }`
   * @returns {Promise<{skipped: boolean, mode: string, reason?: string, status?: string}>}
   */
  function animateCardPeel(cardEl, mode, opts) {
    ensureStyles();

    const o = opts && typeof opts === 'object' ? opts : {};
    const rawMode = typeof mode === 'string' ? mode.trim().toLowerCase() : 'chosen';
    const normalizedMode = rawMode === 'skip' || rawMode === 'left'
      ? 'skip'
      : rawMode === 'undo'
        ? 'undo'
        : 'chosen';

    if (!cardEl || typeof cardEl.animate !== 'function') {
      return Promise.resolve({ skipped: true, mode: normalizedMode, reason: 'no-element-or-waapi' });
    }

    const bypass = isMotionBypassed();
    if (bypass.bypassed) {
      return Promise.resolve({ skipped: true, mode: normalizedMode, reason: bypass.reason });
    }

    function runPeelOut() {
      let keyframes;
      let fill = 'forwards';

      if (normalizedMode === 'skip') {
        keyframes = [
          { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: 'translate3d(-24px, 4px, 0) rotate(-1.4deg) scale(0.985)', opacity: 0 },
        ];
      } else if (normalizedMode === 'undo') {
        fill = 'none';
        keyframes = [
          { transform: 'translate3d(-24px, 4px, 0) rotate(-1.4deg) scale(0.985)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1 },
        ];
      } else {
        keyframes = [
          { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: 'translate3d(28px, -8px, 0) rotate(1.6deg) scale(0.985)', opacity: 0 },
        ];
      }

      // Lift underlying Pantone/Rams stack cards cleanly toward top position as the top card peels off
      const stackEl = typeof cardEl.closest === 'function' ? cardEl.closest('.tfx-deck-stack') : cardEl.parentElement;
      if (normalizedMode !== 'undo' && stackEl && typeof stackEl.querySelector === 'function') {
        const under1 = stackEl.querySelector('.tfx-under-card.is-depth-1');
        if (under1 && typeof under1.animate === 'function') {
          runWaapiSafe(
            under1,
            [
              { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
              { transform: 'translate3d(0, 8px, 0) scale(1.012)', opacity: 1 },
            ],
            { duration: PEEL_DURATION_MS, easing: EASE_PEEL, fill: 'forwards' }
          );
        }
        const under2 = stackEl.querySelector('.tfx-under-card.is-depth-2');
        if (under2 && typeof under2.animate === 'function') {
          runWaapiSafe(
            under2,
            [
              { transform: 'translate3d(0, 0, 0)', opacity: 0.92 },
              { transform: 'translate3d(0, 7px, 0)', opacity: 0.98 },
            ],
            { duration: PEEL_DURATION_MS, easing: EASE_PEEL, fill: 'forwards' }
          );
        }
      }

      return runWaapiSafe(cardEl, keyframes, {
        duration: PEEL_DURATION_MS,
        easing: EASE_PEEL,
        fill,
      }).then(function (res) {
        return {
          skipped: Boolean(res && res.skipped),
          mode: normalizedMode,
          status: res && res.status,
          reason: res && res.reason,
        };
      });
    }

    if (normalizedMode === 'chosen' && !o.skipStamp) {
      return stampVerdictLock(cardEl, o).then(function () {
        return runPeelOut();
      });
    }

    return runPeelOut();
  }

  /**
   * Deals a Taste Deck card along a subtle physical arc (`220ms`: `translateY(10px) rotate(1.5deg)` ->
   * `scale(1.01)` micro-settle -> resting `0`) while settling the Pantone/Rams under-cards.
   * Strictly 0ms instant swap with 0px CLS under prefers-reduced-motion or data-detail="off".
   * @param {Element} stackOrCardEl - `.tfx-deck-stack` container or `.taste-question-card` element
   * @returns {Promise<{skipped: boolean, reason?: string, status?: string}>}
   */
  function dealCard(stackOrCardEl) {
    ensureStyles();

    if (!stackOrCardEl) {
      return Promise.resolve({ skipped: true, reason: 'no-element' });
    }

    const bypass = isMotionBypassed();
    if (bypass.bypassed) {
      return Promise.resolve({ skipped: true, reason: bypass.reason });
    }

    let topCard = null;
    if (
      stackOrCardEl.classList &&
      stackOrCardEl.classList.contains('taste-question-card')
    ) {
      topCard = stackOrCardEl;
    } else if (typeof stackOrCardEl.querySelector === 'function') {
      topCard = stackOrCardEl.querySelector('.taste-question-card');
      if (!topCard && stackOrCardEl.children && stackOrCardEl.children.length) {
        for (let i = 0; i < stackOrCardEl.children.length; i += 1) {
          const child = stackOrCardEl.children[i];
          const cls = child && child.className ? String(child.className) : '';
          if (cls.indexOf('tfx-under-card') === -1) {
            topCard = child;
            break;
          }
        }
      }
    }
    if (!topCard) {
      topCard = stackOrCardEl;
    }

    if (!topCard || typeof topCard.animate !== 'function') {
      return Promise.resolve({ skipped: true, reason: 'no-waapi' });
    }

    const stackEl =
      topCard !== stackOrCardEl
        ? stackOrCardEl
        : (typeof topCard.closest === 'function' ? topCard.closest('.tfx-deck-stack') : null);

    if (stackEl && typeof stackEl.querySelector === 'function') {
      const under1 = stackEl.querySelector('.tfx-under-card.is-depth-1');
      if (under1 && typeof under1.animate === 'function') {
        runWaapiSafe(
          under1,
          [
            { transform: 'translate3d(0, -6px, 0)', opacity: 0.78 },
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
          ],
          { duration: DEAL_DURATION_MS, easing: EASE_PEEL, fill: 'none' }
        );
      }
      const under2 = stackEl.querySelector('.tfx-under-card.is-depth-2');
      if (under2 && typeof under2.animate === 'function') {
        runWaapiSafe(
          under2,
          [
            { transform: 'translate3d(0, -6px, 0)', opacity: 0 },
            { transform: 'translate3d(0, 0, 0)', opacity: 0.92 },
          ],
          { duration: DEAL_DURATION_MS, easing: EASE_PEEL, fill: 'none' }
        );
      }
    }

    return runWaapiSafe(
      topCard,
      [
        { transform: 'translate3d(0, 10px, 0) rotate(1.5deg) scale(0.985)', opacity: 0.76, offset: 0 },
        { transform: 'translate3d(0, -1px, 0) rotate(-0.15deg) scale(1.01)', opacity: 1, offset: 0.72 },
        { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1, offset: 1 },
      ],
      { duration: DEAL_DURATION_MS, easing: EASE_PEEL, fill: 'none' }
    );
  }

  /**
   * Springs the newly promoted top card into active position via the tactile card-deal arc.
   * @param {Element} stackEl - `.tfx-deck-stack` container (or top card element directly)
   * @returns {Promise<{skipped: boolean, reason?: string, status?: string}>}
   */
  function animateDeckPromote(stackEl) {
    return dealCard(stackEl);
  }

  return Object.freeze({
    renderTasteGenomeRadarSvg,
    renderRadar: renderTasteGenomeRadarSvg,
    updateRadar,
    hydrateRadar,
    recordRadarSnapshot,
    getRadarState,
    resetRadarHistory,
    wrapCardInPhysicalStack,
    dealCard,
    stampVerdictLock,
    animateCardPeel,
    animateDeckPromote,
    resolveGapTier,
    observeVisibility: ensureVisibilityTracking,
    pauseOffscreen: pauseAllOffscreenAnimations,
    RADAR_AXES,
    ensureStyles,
    isMotionBypassed,
  });
});
