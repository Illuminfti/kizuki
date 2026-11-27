/* ==========================================================================
   KIZUKI MIND EXPLORER - 120 FPS PURPOSEFUL MOTION CHOREOGRAPHY ENGINE
   Compositor-only (transform, opacity, clip-path, SVG stroke-dashoffset).
   Zero fake idle jitter, explicit property transitions only, zero layer spam,
   zero animation on Cmd+K (0ms instant), full prefers-reduced-motion respect.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiMotion = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const EASE_SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
  const STYLE_TAG_ID = 'kizuki-motion-base-styles';
  const DEFAULT_SPOTLIGHT_SELECTOR = '.profile-banner, .codex-hero-card';

  const numberRafMap = new WeakMap();
  const numberValMap = new WeakMap();
  const elementAnimMap = new WeakMap();
  const tabInkStateMap = new WeakMap();
  const tabInkObserverMap = new WeakMap();
  const copyStateMap = new WeakMap();

  const observedTabLists = new Set();
  let windowResizeBound = false;
  let windowResizeRaf = 0;

  let spotlightSelectors = new Set();
  let spotlightBound = false;
  let spotlightActiveSurface = null;
  let spotlightPendingRaf = 0;
  let spotlightPendingX = 0;
  let spotlightPendingY = 0;
  let spotlightPendingEl = null;

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
    return null;
  }

  function getDoc() {
    if (typeof document !== 'undefined') return document;
    const w = getWin();
    return w && w.document ? w.document : null;
  }

  function resolveElement(target, scope) {
    if (!target) return null;
    if (typeof target === 'string') {
      const root = scope || getDoc();
      return root && typeof root.querySelector === 'function' ? root.querySelector(target) : null;
    }
    return target;
  }

  function supportsWAAPI(el) {
    return Boolean(el && typeof el.animate === 'function');
  }

  function getNow() {
    const w = getWin();
    if (w && w.performance && typeof w.performance.now === 'function') {
      return w.performance.now();
    }
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function requestFrame(cb) {
    const w = getWin();
    if (w && typeof w.requestAnimationFrame === 'function') {
      return w.requestAnimationFrame(cb);
    }
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(cb);
    }
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

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureBaseStyles() {
    const doc = getDoc();
    if (!doc || !doc.head || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
      return;
    }
    if (doc.getElementById(STYLE_TAG_ID)) return;

    const style = doc.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = [
      ':where(.motion-tab-ink) {',
      '  position: absolute;',
      '  left: 0;',
      '  bottom: 0;',
      '  height: 2px;',
      '  width: 1px;',
      '  transform-origin: 0 50%;',
      '  background-color: var(--ink-primary, currentColor);',
      '  border-radius: 1px;',
      '  pointer-events: none;',
      '  z-index: 2;',
      '}',
      ':where([data-motion-ink="on"] .is-active, [data-motion-ink="on"] [aria-selected="true"]) {',
      '  border-bottom-color: transparent;',
      '}',
      '@media (hover: hover) and (pointer: fine) {',
      '  :where(.profile-banner, .codex-hero-card)::after {',
      '    content: "";',
      '    position: absolute;',
      '    inset: 0;',
      '    border-radius: inherit;',
      '    pointer-events: none;',
      '    opacity: var(--spot-opacity, 0);',
      '    background: radial-gradient(280px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(255, 255, 255, 0.055), transparent 65%);',
      '    transition: opacity 200ms ' + EASE_OUT + ';',
      '    z-index: 0;',
      '  }',
      '  :where(html[data-theme="light"] .profile-banner, html[data-theme="light"] .codex-hero-card)::after {',
      '    background: radial-gradient(280px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(0, 112, 243, 0.05), transparent 65%);',
      '  }',
      '  :where(html[data-detail="off"] .profile-banner, html[data-detail="off"] .codex-hero-card)::after {',
      '    opacity: 0;',
      '  }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  :where(.motion-tab-ink) {',
      '    transition: none;',
      '  }',
      '  :where(.profile-banner, .codex-hero-card)::after {',
      '    opacity: 0;',
      '    transition: none;',
      '  }',
      '}',
    ].join('\n');
    doc.head.appendChild(style);
  }

  function cancelTrackedAnim(el) {
    if (!el) return;
    const prev = elementAnimMap.get(el);
    if (!prev) return;
    elementAnimMap.delete(el);
    if (typeof prev.cleanup === 'function') {
      try { prev.cleanup(); } catch (_) {}
    }
    if (prev.anim && typeof prev.anim.cancel === 'function') {
      try { prev.anim.cancel(); } catch (_) {}
    }
  }

  function runTrackedWAAPI(el, keyframes, options, cleanupFn) {
    cancelTrackedAnim(el);
    if (!supportsWAAPI(el)) {
      if (typeof cleanupFn === 'function') {
        try { cleanupFn(); } catch (_) {}
      }
      return null;
    }

    let anim = null;
    try {
      anim = el.animate(keyframes, options);
    } catch (_) {
      if (typeof cleanupFn === 'function') {
        try { cleanupFn(); } catch (_) {}
      }
      return null;
    }

    const record = { anim: anim, cleanup: cleanupFn || null };
    elementAnimMap.set(el, record);

    const finalize = function (releaseFill) {
      if (elementAnimMap.get(el) === record) {
        elementAnimMap.delete(el);
      }
      if (typeof cleanupFn === 'function') {
        try { cleanupFn(); } catch (_) {}
      }
      // Release WAAPI fill once finished so native CSS states (:hover, sticky, opacity) take over cleanly.
      if (releaseFill && anim && typeof anim.cancel === 'function') {
        try { anim.cancel(); } catch (_) {}
      }
    };

    if (anim) {
      if ('onfinish' in anim || anim.onfinish === undefined) {
        anim.onfinish = function () { finalize(true); };
      }
      if ('oncancel' in anim || anim.oncancel === undefined) {
        anim.oncancel = function () { finalize(false); };
      }
    }

    return anim;
  }

  // =========================================================================
  // 1. PREFERS REDUCED MOTION + ?detail=off GATE
  // =========================================================================

  function prefersReducedMotion() {
    const doc = getDoc();
    if (doc && doc.documentElement) {
      const rootEl = doc.documentElement;
      if (rootEl.dataset && rootEl.dataset.detail === 'off') {
        return true;
      }
      if (typeof rootEl.getAttribute === 'function' && rootEl.getAttribute('data-detail') === 'off') {
        return true;
      }
    }

    const w = getWin();
    if (w && typeof w.matchMedia === 'function') {
      try {
        const mq = w.matchMedia('(prefers-reduced-motion: reduce)');
        if (mq && mq.matches) return true;
      } catch (_) {}
    }

    return false;
  }

  // =========================================================================
  // 2. INTERRUPTIBLE CUBIC EASE-OUT NUMERIC TWEEN (animateNumber)
  // =========================================================================

  function parseNumericFromText(text) {
    if (text == null) return null;
    const raw = String(text).trim();
    if (!raw || raw === '--' || raw === '-') return null;
    const match = raw.match(/-?\d[\d,]*(?:\.\d+)?\s*([KMBkmb])?/);
    if (!match) return null;
    const num = Number(match[0].replace(/[,\sKMBkmb]/g, ''));
    if (!Number.isFinite(num)) return null;
    const unit = match[1] ? match[1].toUpperCase() : '';
    if (unit === 'K') return num * 1e3;
    if (unit === 'M') return num * 1e6;
    if (unit === 'B') return num * 1e9;
    return num;
  }

  function addThousandsCommas(numStr) {
    const parts = numStr.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function formatNumberValue(val, opts) {
    const prefix = opts.prefix || '';
    const suffix = opts.suffix || '';
    const compact = Boolean(opts.compact);
    const hasExplicitDecimals = opts.decimals != null && Number.isFinite(Number(opts.decimals));
    const decimals = hasExplicitDecimals ? Math.max(0, Math.min(6, Math.round(Number(opts.decimals)))) : opts.inferredDecimals;

    const absVal = Math.abs(val);
    if (compact && absVal >= 1e3) {
      let scaled = val;
      let unit = '';
      if (absVal >= 1e9) {
        scaled = val / 1e9;
        unit = 'B';
      } else if (absVal >= 1e6) {
        scaled = val / 1e6;
        unit = 'M';
      } else {
        scaled = val / 1e3;
        unit = 'K';
      }
      const d = hasExplicitDecimals ? decimals : 1;
      let s = scaled.toFixed(d);
      if (!hasExplicitDecimals) {
        s = s.replace(/\.0+$/, '');
      }
      if (s === '-0') s = '0';
      return prefix + s + unit + suffix;
    }

    const factor = Math.pow(10, decimals);
    let rounded = Math.round(val * factor) / factor;
    if (Object.is(rounded, -0) || Math.abs(rounded) < 1e-12) rounded = 0;
    const fixed = decimals > 0 ? rounded.toFixed(decimals) : String(Math.round(rounded));
    return prefix + addThousandsCommas(fixed) + suffix;
  }

  function inferDecimals(target) {
    if (!Number.isFinite(target) || Math.floor(target) === target) return 0;
    const str = String(target);
    const dot = str.indexOf('.');
    if (dot === -1) return 0;
    return Math.min(2, str.length - dot - 1);
  }

  function animateNumber(elOrSel, targetVal, opts) {
    const el = resolveElement(elOrSel);
    if (!el) return null;

    const cfg = opts && typeof opts === 'object' ? opts : {};
    const duration = cfg.duration != null && Number.isFinite(Number(cfg.duration))
      ? Math.max(0, Number(cfg.duration))
      : 260;

    // Cancel any active RAF on this element so rapid switches remain 100% interruptible.
    const existingRaf = numberRafMap.get(el);
    if (existingRaf != null) {
      cancelFrame(existingRaf);
      numberRafMap.delete(el);
    }

    const prefix = cfg.prefix != null ? String(cfg.prefix) : '';
    const suffix = cfg.suffix != null ? String(cfg.suffix) : '';

    const numericTarget = targetVal == null || targetVal === '' ? NaN : Number(targetVal);
    if (!Number.isFinite(numericTarget)) {
      el.textContent = prefix + (targetVal == null ? '--' : String(targetVal)) + suffix;
      numberValMap.delete(el);
      if (el.dataset) delete el.dataset.motionNum;
      return null;
    }

    const formatOpts = {
      prefix: prefix,
      suffix: suffix,
      decimals: cfg.decimals,
      inferredDecimals: inferDecimals(numericTarget),
      compact: Boolean(cfg.compact),
    };

    let startVal = numberValMap.get(el);
    if (!Number.isFinite(startVal)) {
      if (el.dataset && el.dataset.motionNum != null && el.dataset.motionNum !== '') {
        const parsedData = Number(el.dataset.motionNum);
        if (Number.isFinite(parsedData)) startVal = parsedData;
      }
    }
    if (!Number.isFinite(startVal)) {
      const parsedText = parseNumericFromText(el.textContent);
      startVal = Number.isFinite(parsedText) ? parsedText : 0;
    }

    const finalFormatted = formatNumberValue(numericTarget, formatOpts);

    if (prefersReducedMotion() || duration <= 0 || Math.abs(numericTarget - startVal) < 1e-6) {
      el.textContent = finalFormatted;
      numberValMap.set(el, numericTarget);
      if (el.dataset) el.dataset.motionNum = String(numericTarget);
      return null;
    }

    let startTime = null;
    let cancelled = false;
    let rafId = null;

    const tick = function (now) {
      if (cancelled) return;
      const ts = typeof now === 'number' && Number.isFinite(now) ? now : getNow();
      if (startTime === null) startTime = ts;

      const elapsed = Math.max(0, ts - startTime);
      const t = duration > 0 ? Math.min(1, elapsed / duration) : 1;
      const eased = 1 - Math.pow(1 - t, 3);
      const current = startVal + (numericTarget - startVal) * eased;

      if (t >= 1) {
        el.textContent = finalFormatted;
        numberValMap.set(el, numericTarget);
        if (el.dataset) el.dataset.motionNum = String(numericTarget);
        numberRafMap.delete(el);
        return;
      }

      el.textContent = formatNumberValue(current, formatOpts);
      numberValMap.set(el, current);
      rafId = requestFrame(tick);
      if (rafId != null) {
        numberRafMap.set(el, rafId);
      } else {
        // Environment has no RAF: finish cleanly without stalling.
        el.textContent = finalFormatted;
        numberValMap.set(el, numericTarget);
        if (el.dataset) el.dataset.motionNum = String(numericTarget);
        numberRafMap.delete(el);
      }
    };

    rafId = requestFrame(tick);
    if (rafId == null) {
      el.textContent = finalFormatted;
      numberValMap.set(el, numericTarget);
      if (el.dataset) el.dataset.motionNum = String(numericTarget);
      return null;
    }

    numberRafMap.set(el, rafId);

    return {
      cancel: function () {
        if (cancelled) return;
        cancelled = true;
        const active = numberRafMap.get(el);
        if (active != null) {
          cancelFrame(active);
          numberRafMap.delete(el);
        }
      },
    };
  }

  // =========================================================================
  // 3. WAAPI STAGGER REVEAL (staggerReveal)
  // =========================================================================

  function staggerReveal(containerOrSel, selector, opts) {
    const container = resolveElement(containerOrSel);
    if (!container) return [];

    const cfg = opts && typeof opts === 'object' ? opts : {};
    const stepMs = cfg.stepMs != null && Number.isFinite(Number(cfg.stepMs)) ? Math.max(0, Number(cfg.stepMs)) : 24;
    const maxItems = cfg.maxItems != null && Number.isFinite(Number(cfg.maxItems)) ? Math.max(0, Math.floor(Number(cfg.maxItems))) : 10;
    const yPx = cfg.yPx != null && Number.isFinite(Number(cfg.yPx)) ? Number(cfg.yPx) : 6;
    const durationMs = cfg.durationMs != null && Number.isFinite(Number(cfg.durationMs)) ? Math.max(1, Number(cfg.durationMs)) : 220;

    let rawNodes = null;
    if (selector && typeof container.querySelectorAll === 'function') {
      rawNodes = container.querySelectorAll(selector);
    } else if (container.children) {
      rawNodes = container.children;
    }
    if (!rawNodes || rawNodes.length === 0) return [];

    const items = Array.prototype.slice.call(rawNodes);
    for (let i = 0; i < items.length; i += 1) {
      cancelTrackedAnim(items[i]);
    }

    if (prefersReducedMotion() || maxItems <= 0) {
      return [];
    }

    const anims = [];
    const limit = Math.min(items.length, maxItems);
    for (let i = 0; i < limit; i += 1) {
      const el = items[i];
      const anim = runTrackedWAAPI(
        el,
        [
          { opacity: 0.01, transform: 'translate3d(0, ' + yPx + 'px, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: durationMs,
          delay: i * stepMs,
          easing: EASE_OUT,
          fill: 'both',
        }
      );
      if (anim) anims.push(anim);
    }

    return anims;
  }

  // =========================================================================
  // 4. PEOPLE PROFILE VISUALS CHOREOGRAPHY (choreographProfileVisuals)
  // =========================================================================

  function safePathLength(el, fallback) {
    if (el && typeof el.getTotalLength === 'function') {
      try {
        const len = el.getTotalLength();
        if (Number.isFinite(len) && len > 0) return len;
      } catch (_) {}
    }
    return fallback;
  }

  function hasAnyClass(el, names) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') {
      for (let i = 0; i < names.length; i += 1) {
        if (el.classList.contains(names[i])) return true;
      }
      return false;
    }
    const cls = typeof el.className === 'string'
      ? el.className
      : (el.className && typeof el.className.baseVal === 'string' ? el.className.baseVal : '');
    const tokens = cls.split(/\s+/);
    for (let i = 0; i < names.length; i += 1) {
      if (tokens.indexOf(names[i]) !== -1) return true;
    }
    return false;
  }

  function queryList(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function choreographProfileVisuals(rootOrSel) {
    const root = rootOrSel ? resolveElement(rootOrSel) : getDoc();
    if (!root) return { animated: 0, reduced: false };

    const radarPolys = queryList(root, '.pv-radar-poly, .pv-radar-data');
    const cadenceBars = queryList(root, '.pv-cadence-bar');
    const leverageSegs = queryList(root, '.pv-leverage-seg, .pv-bar-ours, .pv-bar-theirs');
    const egoEdges = queryList(root, '.pv-ego-edge');
    const egoNodes = queryList(root, '.pv-ego-node');

    const allTargets = radarPolys.concat(cadenceBars, leverageSegs, egoEdges, egoNodes);
    for (let i = 0; i < allTargets.length; i += 1) {
      cancelTrackedAnim(allTargets[i]);
    }
    for (let i = 0; i < egoEdges.length; i += 1) {
      if (egoEdges[i].style) {
        egoEdges[i].style.strokeDasharray = '';
        egoEdges[i].style.strokeDashoffset = '';
      }
    }

    if (prefersReducedMotion()) {
      return { animated: 0, reduced: true };
    }

    let animated = 0;

    // 4.1 Radar polygon: scale(0.86) -> scale(1) + opacity 0 -> 1 from SVG center
    for (let i = 0; i < radarPolys.length; i += 1) {
      const poly = radarPolys[i];
      if (poly.style) {
        poly.style.transformBox = 'fill-box';
        poly.style.transformOrigin = '50% 50%';
      }
      const anim = runTrackedWAAPI(
        poly,
        [
          { transform: 'scale(0.86)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        {
          duration: 340,
          easing: EASE_OUT,
          fill: 'both',
        }
      );
      if (anim) animated += 1;
    }

    // 4.2 Cadence bars: scaleY(0.1) -> scaleY(1) from bottom origin, 18ms stagger
    const barLimit = Math.min(cadenceBars.length, 24);
    for (let i = 0; i < barLimit; i += 1) {
      const bar = cadenceBars[i];
      if (bar.style) {
        bar.style.transformBox = 'fill-box';
        bar.style.transformOrigin = '50% 100%';
      }
      const anim = runTrackedWAAPI(
        bar,
        [
          { transform: 'scaleY(0.1)', opacity: 0.2 },
          { transform: 'scaleY(1)', opacity: 1 },
        ],
        {
          duration: 280,
          delay: i * 18,
          easing: EASE_OUT,
          fill: 'both',
        }
      );
      if (anim) animated += 1;
    }

    // 4.3 Leverage segments: scaleX(0.2) -> scaleX(1), 300ms
    for (let i = 0; i < leverageSegs.length; i += 1) {
      const seg = leverageSegs[i];
      const fromRight = hasAnyClass(seg, ['pv-bar-theirs', 'is-theirs', 'is-right']);
      if (seg.style) {
        seg.style.transformBox = 'fill-box';
        seg.style.transformOrigin = fromRight ? '100% 50%' : '0% 50%';
      }
      const anim = runTrackedWAAPI(
        seg,
        [
          { transform: 'scaleX(0.2)', opacity: 0.35 },
          { transform: 'scaleX(1)', opacity: 1 },
        ],
        {
          duration: 300,
          delay: Math.min(i, 8) * 20,
          easing: EASE_OUT,
          fill: 'both',
        }
      );
      if (anim) animated += 1;
    }

    // 4.4 Ego edges: stroke-dashoffset draw-in (320ms)
    for (let i = 0; i < egoEdges.length; i += 1) {
      const edge = egoEdges[i];
      const len = Math.ceil(safePathLength(edge, 140));
      if (edge.style) {
        edge.style.strokeDasharray = len + ' ' + len;
      }
      const clearDash = function () {
        if (edge.style) {
          edge.style.strokeDasharray = '';
          edge.style.strokeDashoffset = '';
        }
      };
      const anim = runTrackedWAAPI(
        edge,
        [
          { strokeDashoffset: len, opacity: 0.15 },
          { strokeDashoffset: 0, opacity: 1 },
        ],
        {
          duration: 320,
          delay: Math.min(i, 12) * 16,
          easing: EASE_OUT,
          fill: 'both',
        },
        clearDash
      );
      if (anim) animated += 1;
    }

    // 4.5 Ego nodes: subtle pop-in scale(0.92) -> 1, 22ms stagger
    for (let i = 0; i < egoNodes.length; i += 1) {
      const node = egoNodes[i];
      if (node.style) {
        node.style.transformBox = 'fill-box';
        node.style.transformOrigin = '50% 50%';
      }
      const anim = runTrackedWAAPI(
        node,
        [
          { transform: 'scale(0.92)', opacity: 0.01 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        {
          duration: 240,
          delay: 36 + Math.min(i, 12) * 22,
          easing: EASE_OUT,
          fill: 'both',
        }
      );
      if (anim) animated += 1;
    }

    return { animated: animated, reduced: false };
  }

  // =========================================================================
  // 5. COMPOSITOR SLIDING TAB INK (syncSlidingTabInk)
  // =========================================================================

  function findDirectTabInk(tabListEl) {
    if (!tabListEl) return null;
    if (tabListEl.children) {
      for (let i = 0; i < tabListEl.children.length; i += 1) {
        const child = tabListEl.children[i];
        if (hasAnyClass(child, ['motion-tab-ink'])) return child;
      }
    }
    if (typeof tabListEl.querySelector === 'function') {
      return tabListEl.querySelector('.motion-tab-ink');
    }
    return null;
  }

  function measureTabGeometry(tabListEl, activeBtn) {
    if (!tabListEl || !activeBtn) return { x: 0, w: 0 };

    let x = 0;
    let w = 0;
    if (typeof activeBtn.getBoundingClientRect === 'function' && typeof tabListEl.getBoundingClientRect === 'function') {
      const btnRect = activeBtn.getBoundingClientRect();
      const listRect = tabListEl.getBoundingClientRect();
      if (btnRect && listRect && btnRect.width > 0) {
        x = (btnRect.left - listRect.left) + (tabListEl.scrollLeft || 0);
        w = btnRect.width;
      }
    }

    if (w <= 0 && typeof activeBtn.offsetWidth === 'number' && activeBtn.offsetWidth > 0) {
      x = typeof activeBtn.offsetLeft === 'number' ? activeBtn.offsetLeft : 0;
      w = activeBtn.offsetWidth;
    }

    return { x: x, w: w };
  }

  function applyTabInk(tabListEl, activeBtnSelector, forceInstant) {
    if (!tabListEl) return null;
    ensureBaseStyles();

    const doc = getDoc();
    const w = getWin();

    if (tabListEl.style && w && typeof w.getComputedStyle === 'function') {
      try {
        const computedPos = w.getComputedStyle(tabListEl).position;
        if (!computedPos || computedPos === 'static') {
          tabListEl.style.position = 'relative';
        }
      } catch (_) {}
    } else if (tabListEl.style && !tabListEl.style.position) {
      tabListEl.style.position = 'relative';
    }

    let ink = findDirectTabInk(tabListEl);
    if (!ink && doc && typeof doc.createElement === 'function') {
      ink = doc.createElement('span');
      ink.className = 'motion-tab-ink';
      if (ink.classList && typeof ink.classList.add === 'function') {
        ink.classList.add('motion-tab-ink');
      }
      if (typeof ink.setAttribute === 'function') {
        ink.setAttribute('aria-hidden', 'true');
      }
      if (ink.style) {
        ink.style.position = 'absolute';
        ink.style.left = '0';
        ink.style.bottom = '0';
        ink.style.height = '2px';
        ink.style.width = '1px';
        ink.style.transformOrigin = '0 50%';
        ink.style.backgroundColor = 'var(--ink-primary, currentColor)';
        ink.style.borderRadius = '1px';
        ink.style.pointerEvents = 'none';
        ink.style.zIndex = '2';
        ink.style.opacity = '0';
      }
      tabListEl.appendChild(ink);
    }
    if (!ink) return null;

    if (tabListEl.dataset) {
      tabListEl.dataset.motionInk = 'on';
    }

    let activeBtn = null;
    if (activeBtnSelector && typeof activeBtnSelector === 'object') {
      activeBtn = activeBtnSelector;
    } else if (typeof tabListEl.querySelector === 'function') {
      activeBtn = tabListEl.querySelector(activeBtnSelector || '.is-active, [aria-selected="true"]');
    }

    const prevState = tabInkStateMap.get(tabListEl);
    const storedSelector = typeof activeBtnSelector === 'string'
      ? activeBtnSelector
      : (prevState ? prevState.selector : '.is-active, [aria-selected="true"]');

    if (!activeBtn) {
      if (ink.style) ink.style.opacity = '0';
      tabInkStateMap.set(tabListEl, {
        placed: Boolean(prevState && prevState.placed),
        selector: storedSelector,
      });
      return ink;
    }

    const geom = measureTabGeometry(tabListEl, activeBtn);
    if (geom.w <= 0) {
      if (ink.style) ink.style.opacity = '0';
      tabInkStateMap.set(tabListEl, {
        placed: Boolean(prevState && prevState.placed),
        selector: storedSelector,
      });
      return ink;
    }

    const isFirstPlacement = !prevState || !prevState.placed;
    const instant = Boolean(forceInstant) || isFirstPlacement || prefersReducedMotion();
    const targetTransform = 'translate3d(' + geom.x.toFixed(2) + 'px, 0, 0) scaleX(' + geom.w.toFixed(2) + ')';

    if (ink.style) {
      ink.style.transition = instant
        ? 'none'
        : ('transform 200ms ' + EASE_OUT + ', opacity 160ms ' + EASE_OUT);
      ink.style.transform = targetTransform;
      ink.style.opacity = '1';
    }

    tabInkStateMap.set(tabListEl, {
      placed: true,
      selector: storedSelector,
      x: geom.x,
      w: geom.w,
    });

    return ink;
  }

  function scheduleTabResizeSync() {
    if (windowResizeRaf) return;
    const run = function () {
      windowResizeRaf = 0;
      observedTabLists.forEach(function (tabListEl) {
        if (!tabListEl || tabListEl.isConnected === false) {
          observedTabLists.delete(tabListEl);
          const obs = tabInkObserverMap.get(tabListEl);
          if (obs && typeof obs.disconnect === 'function') {
            try { obs.disconnect(); } catch (_) {}
          }
          tabInkObserverMap.delete(tabListEl);
          return;
        }
        const st = tabInkStateMap.get(tabListEl);
        applyTabInk(tabListEl, st ? st.selector : '.is-active, [aria-selected="true"]', true);
      });
    };
    const id = requestFrame(run);
    if (id != null) {
      windowResizeRaf = id;
    } else {
      run();
    }
  }

  function ensureTabResizeTracking(tabListEl) {
    observedTabLists.add(tabListEl);

    const w = getWin();
    const RO = (w && w.ResizeObserver) || (typeof ResizeObserver === 'function' ? ResizeObserver : null);
    if (RO && !tabInkObserverMap.has(tabListEl)) {
      try {
        const obs = new RO(function () {
          if (tabListEl.isConnected === false) {
            obs.disconnect();
            tabInkObserverMap.delete(tabListEl);
            observedTabLists.delete(tabListEl);
            return;
          }
          const st = tabInkStateMap.get(tabListEl);
          applyTabInk(tabListEl, st ? st.selector : '.is-active, [aria-selected="true"]', true);
        });
        obs.observe(tabListEl);
        tabInkObserverMap.set(tabListEl, obs);
      } catch (_) {}
    }

    if (!windowResizeBound && w && typeof w.addEventListener === 'function') {
      w.addEventListener('resize', scheduleTabResizeSync, { passive: true });
      windowResizeBound = true;
    }
  }

  function syncSlidingTabInk(tabListOrSel, activeBtnSelector) {
    const tabListEl = resolveElement(tabListOrSel);
    if (!tabListEl) return null;

    const ink = applyTabInk(tabListEl, activeBtnSelector, false);
    ensureTabResizeTracking(tabListEl);
    return ink;
  }

  // =========================================================================
  // 6. POINTER-FINE SPECULAR SPOTLIGHT SURFACE (bindSpotlightSurface)
  // =========================================================================

  function clearActiveSpotlight() {
    if (spotlightPendingRaf) {
      cancelFrame(spotlightPendingRaf);
      spotlightPendingRaf = 0;
    }
    spotlightPendingEl = null;

    if (spotlightActiveSurface) {
      if (spotlightActiveSurface.style && typeof spotlightActiveSurface.style.setProperty === 'function') {
        spotlightActiveSurface.style.setProperty('--spot-opacity', '0');
      }
      if (spotlightActiveSurface.dataset) {
        delete spotlightActiveSurface.dataset.spotActive;
      }
      spotlightActiveSurface = null;
    }
  }

  function flushSpotlightFrame() {
    spotlightPendingRaf = 0;
    const el = spotlightPendingEl;
    if (!el || el !== spotlightActiveSurface || prefersReducedMotion()) {
      if (prefersReducedMotion()) clearActiveSpotlight();
      return;
    }

    if (typeof el.getBoundingClientRect !== 'function' || !el.style || typeof el.style.setProperty !== 'function') {
      return;
    }

    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    const localX = Math.max(0, Math.min(rect.width, spotlightPendingX - rect.left));
    const localY = Math.max(0, Math.min(rect.height, spotlightPendingY - rect.top));

    el.style.setProperty('--spot-x', localX.toFixed(1) + 'px');
    el.style.setProperty('--spot-y', localY.toFixed(1) + 'px');
    el.style.setProperty('--spot-opacity', '1');
    if (el.dataset) el.dataset.spotActive = '1';
  }

  function handleSpotlightPointerMove(ev) {
    if (!ev || spotlightSelectors.size === 0) return;
    if (ev.pointerType && ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') {
      clearActiveSpotlight();
      return;
    }
    if (prefersReducedMotion()) {
      clearActiveSpotlight();
      return;
    }

    const combined = Array.from(spotlightSelectors).join(', ');
    const target = ev.target;
    const surface = target && typeof target.closest === 'function' ? target.closest(combined) : null;

    if (surface !== spotlightActiveSurface) {
      clearActiveSpotlight();
      spotlightActiveSurface = surface;
    }

    if (!surface) return;

    spotlightPendingEl = surface;
    spotlightPendingX = typeof ev.clientX === 'number' ? ev.clientX : 0;
    spotlightPendingY = typeof ev.clientY === 'number' ? ev.clientY : 0;

    if (!spotlightPendingRaf) {
      const id = requestFrame(flushSpotlightFrame);
      if (id != null) {
        spotlightPendingRaf = id;
      } else {
        flushSpotlightFrame();
      }
    }
  }

  function handleSpotlightPointerLeave() {
    clearActiveSpotlight();
  }

  function handleSpotlightPointerOut(ev) {
    if (!ev) return;
    if (!ev.relatedTarget) {
      clearActiveSpotlight();
    }
  }

  function attachSpotlightDelegation() {
    if (spotlightBound) return;
    const doc = getDoc();
    const w = getWin();
    if (!doc || typeof doc.addEventListener !== 'function') return;

    doc.addEventListener('pointermove', handleSpotlightPointerMove, { passive: true });
    if (doc.documentElement && typeof doc.documentElement.addEventListener === 'function') {
      doc.documentElement.addEventListener('pointerleave', handleSpotlightPointerLeave, { passive: true });
    }
    doc.addEventListener('pointerout', handleSpotlightPointerOut, { passive: true });
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('blur', handleSpotlightPointerLeave, { passive: true });
    }
    spotlightBound = true;
  }

  function detachSpotlightDelegation() {
    if (!spotlightBound) return;
    const doc = getDoc();
    const w = getWin();
    clearActiveSpotlight();
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('pointermove', handleSpotlightPointerMove);
      if (doc.documentElement && typeof doc.documentElement.removeEventListener === 'function') {
        doc.documentElement.removeEventListener('pointerleave', handleSpotlightPointerLeave);
      }
      doc.removeEventListener('pointerout', handleSpotlightPointerOut);
    }
    if (w && typeof w.removeEventListener === 'function') {
      w.removeEventListener('blur', handleSpotlightPointerLeave);
    }
    spotlightBound = false;
  }

  function supportsFineHover() {
    const w = getWin();
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      const mq = w.matchMedia('(hover: hover) and (pointer: fine)');
      return Boolean(mq && mq.matches);
    } catch (_) {
      return false;
    }
  }

  function bindSpotlightSurface(selector) {
    const sel = typeof selector === 'string' && selector.trim() ? selector.trim() : DEFAULT_SPOTLIGHT_SELECTOR;
    if (!supportsFineHover()) {
      return {
        active: false,
        destroy: function () {},
      };
    }

    ensureBaseStyles();
    spotlightSelectors.add(sel);
    attachSpotlightDelegation();

    let destroyed = false;
    return {
      active: true,
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        spotlightSelectors.delete(sel);
        if (spotlightSelectors.size === 0) {
          detachSpotlightDelegation();
        }
      },
    };
  }

  // =========================================================================
  // 7. WORKSPACE VIEW SWAP ENTRANCE (animateViewSwap)
  // =========================================================================

  function isInstantSurface(el) {
    if (!el) return true;
    const id = typeof el.id === 'string' ? el.id : '';
    if (id.indexOf('cmdk') !== -1) return true;
    if (hasAnyClass(el, ['cmdk-modal', 'cmdk-backdrop'])) return true;
    if (el.dataset && el.dataset.motion === 'instant') return true;
    if (typeof el.getAttribute === 'function' && el.getAttribute('data-motion') === 'instant') return true;
    return false;
  }

  function animateViewSwap(viewOrSel) {
    const viewEl = resolveElement(viewOrSel);
    if (!viewEl) return null;

    cancelTrackedAnim(viewEl);

    // Hard law: Cmd+K and high-frequency instant surfaces are ALWAYS 0ms instant.
    if (isInstantSurface(viewEl) || prefersReducedMotion()) {
      return null;
    }

    return runTrackedWAAPI(
      viewEl,
      [
        { opacity: 0.01, transform: 'translate3d(0, 5px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      {
        duration: 160,
        easing: EASE_OUT,
        fill: 'both',
      }
    );
  }

  // =========================================================================
  // 8. ZERO-SHIFT TACTILE COPY CONFIRMATION (flashCopySuccess)
  // =========================================================================

  const CHECK_ICON_SVG =
    '<svg class="motion-copy-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style="display:inline-block;flex-shrink:0;vertical-align:-0.125em;">' +
      '<path d="M2.25 6.25L4.75 8.75L9.75 3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function flashCopySuccess(btnOrSel, label) {
    const btnEl = resolveElement(btnOrSel);
    if (!btnEl) return false;

    const existing = copyStateMap.get(btnEl);
    let snapshot = existing;

    if (snapshot) {
      if (snapshot.timerId != null) {
        clearTimeout(snapshot.timerId);
        snapshot.timerId = null;
      }
    } else {
      const origHtml = typeof btnEl.innerHTML === 'string' ? btnEl.innerHTML : null;
      const origText = typeof btnEl.textContent === 'string' ? btnEl.textContent : '';
      const origMinWidth = btnEl.style ? btnEl.style.minWidth : '';
      const origAriaLabel = typeof btnEl.getAttribute === 'function' ? btnEl.getAttribute('aria-label') : null;
      let lockedWidth = 0;
      if (typeof btnEl.getBoundingClientRect === 'function') {
        const rect = btnEl.getBoundingClientRect();
        if (rect && rect.width > 0) {
          lockedWidth = Math.ceil(rect.width);
        }
      }
      snapshot = {
        origHtml: origHtml,
        origText: origText,
        origMinWidth: origMinWidth,
        origAriaLabel: origAriaLabel,
        hadVisibleText: origText.trim().length > 0,
        lockedWidth: lockedWidth,
        timerId: null,
      };
      copyStateMap.set(btnEl, snapshot);
    }

    const resolvedLabel = label !== undefined
      ? String(label)
      : (snapshot.hadVisibleText ? 'Copied' : '');

    if (btnEl.style && snapshot.lockedWidth > 0) {
      btnEl.style.minWidth = snapshot.lockedWidth + 'px';
    }
    if (btnEl.classList && typeof btnEl.classList.add === 'function') {
      btnEl.classList.add('is-copied');
    }
    if (btnEl.dataset) {
      btnEl.dataset.copied = 'true';
    }
    if (typeof btnEl.setAttribute === 'function') {
      btnEl.setAttribute('aria-label', resolvedLabel || 'Copied');
    }

    if (typeof btnEl.innerHTML === 'string') {
      const labelHtml = resolvedLabel
        ? '<span class="motion-copy-label" style="margin-left:4px;">' + escapeHtml(resolvedLabel) + '</span>'
        : '';
      btnEl.innerHTML = CHECK_ICON_SVG + labelHtml;
    } else {
      btnEl.textContent = resolvedLabel || 'Copied';
    }

    if (!prefersReducedMotion() && supportsWAAPI(btnEl)) {
      runTrackedWAAPI(
        btnEl,
        [
          { transform: 'scale(0.96)' },
          { transform: 'scale(1)' },
        ],
        {
          duration: 140,
          easing: EASE_OUT,
          fill: 'none',
        }
      );
    }

    snapshot.timerId = setTimeout(function () {
      const current = copyStateMap.get(btnEl);
      if (current !== snapshot) return;
      copyStateMap.delete(btnEl);

      if (snapshot.origHtml !== null && typeof btnEl.innerHTML === 'string') {
        btnEl.innerHTML = snapshot.origHtml;
      } else {
        btnEl.textContent = snapshot.origText;
      }
      if (btnEl.style) {
        btnEl.style.minWidth = snapshot.origMinWidth;
      }
      if (btnEl.classList && typeof btnEl.classList.remove === 'function') {
        btnEl.classList.remove('is-copied');
      }
      if (btnEl.dataset) {
        delete btnEl.dataset.copied;
      }
      if (typeof btnEl.setAttribute === 'function' && typeof btnEl.removeAttribute === 'function') {
        if (snapshot.origAriaLabel != null) {
          btnEl.setAttribute('aria-label', snapshot.origAriaLabel);
        } else {
          btnEl.removeAttribute('aria-label');
        }
      }
    }, 1200);

    return true;
  }

  // Shared editorial enter stagger (24ms stagger, 6px rise, prefers-reduced-motion aware)
  function enterStagger(containerOrSel, selector, opts) {
    const cfg = Object.assign({ stepMs: 24, yPx: 6, durationMs: 220, maxItems: 10 }, opts || {});
    return staggerReveal(containerOrSel, selector, cfg);
  }

  return {
    EASE_OUT: EASE_OUT,
    EASE_SPRING: EASE_SPRING,
    EASE_DRAWER: EASE_DRAWER,
    EASE_IN_OUT: EASE_IN_OUT,
    prefersReducedMotion: prefersReducedMotion,
    animateNumber: animateNumber,
    staggerReveal: staggerReveal,
    enterStagger: enterStagger,
    choreographProfileVisuals: choreographProfileVisuals,
    syncSlidingTabInk: syncSlidingTabInk,
    bindSpotlightSurface: bindSpotlightSurface,
    animateViewSwap: animateViewSwap,
    flashCopySuccess: flashCopySuccess,
  };
});
