/* Kizuki Mind Explorer - Canvas2D Force-Directed Topology Graph Engine */
/* Pure ES2022, zero dependencies, HiDPI crisp, zero ctx.filter, sleeps cleanly at rest */

(function initKizukiGraphModule(global) {
  'use strict';

  function hashString(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function clamp(val, min, max) {
    return val < min ? min : (val > max ? max : val);
  }

  function easeOutCubic(t) {
    const inv = 1 - t;
    return 1 - inv * inv * inv;
  }

  function evalQuadPoint(p0x, p0y, cpx, cpy, p2x, p2y, t) {
    const inv = 1 - t;
    return {
      x: inv * inv * p0x + 2 * inv * t * cpx + t * t * p2x,
      y: inv * inv * p0y + 2 * inv * t * cpy + t * t * p2y,
    };
  }

  function evalQuadTangent(p0x, p0y, cpx, cpy, p2x, p2y, t) {
    const inv = 1 - t;
    return {
      x: 2 * inv * (cpx - p0x) + 2 * t * (p2x - cpx),
      y: 2 * inv * (cpy - p0y) + 2 * t * (p2y - cpy),
    };
  }

  function trimQuadBezier(p0x, p0y, cpx, cpy, p2x, p2y, startPad, endPad) {
    const chord = Math.hypot(p2x - p0x, p2y - p0y) || 1;
    if (chord <= startPad + endPad + 4) {
      return null;
    }

    let t0 = clamp(startPad / chord, 0.008, 0.44);
    for (let iter = 0; iter < 2; iter += 1) {
      const pt = evalQuadPoint(p0x, p0y, cpx, cpy, p2x, p2y, t0);
      const d = Math.hypot(pt.x - p0x, pt.y - p0y) || 1;
      t0 = clamp(t0 * (startPad / d), 0.004, 0.46);
    }

    let u1 = clamp(endPad / chord, 0.008, 0.44);
    for (let iter = 0; iter < 2; iter += 1) {
      const pt = evalQuadPoint(p0x, p0y, cpx, cpy, p2x, p2y, 1 - u1);
      const d = Math.hypot(pt.x - p2x, pt.y - p2y) || 1;
      u1 = clamp(u1 * (endPad / d), 0.004, 0.46);
    }

    const t1 = 1 - u1;
    if (t1 <= t0 + 0.04) {
      return null;
    }

    const a = evalQuadPoint(p0x, p0y, cpx, cpy, p2x, p2y, t0);
    const c = evalQuadPoint(p0x, p0y, cpx, cpy, p2x, p2y, t1);
    // Exact quadratic Bezier blossom b(t0, t1) for the trimmed sub-curve control point
    const w0 = (1 - t0) * (1 - t1);
    const w1 = (1 - t0) * t1 + t0 * (1 - t1);
    const w2 = t0 * t1;
    const bx = w0 * p0x + w1 * cpx + w2 * p2x;
    const by = w0 * p0y + w1 * cpy + w2 * p2y;

    return {
      ax: a.x,
      ay: a.y,
      bx,
      by,
      cx: c.x,
      cy: c.y,
      arcLen: Math.hypot(c.x - a.x, c.y - a.y),
    };
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
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
    const nearestX = clamp(cx, box.x1, box.x2);
    const nearestY = clamp(cy, box.y1, box.y2);
    const dx = cx - nearestX;
    const dy = cy - nearestY;
    return dx * dx + dy * dy < r * r;
  }

  function classifyNodeKind(node) {
    const rawKind = String(node.kind || '').toLowerCase();
    const rawType = String(node.type || '').toLowerCase();
    const rawCat = String(node.category || '').toLowerCase();
    const rawGroup = String(node.group || '').toLowerCase();
    const rawSource = String(node.source_kind || '').toLowerCase();
    const joined = rawKind + ' ' + rawType + ' ' + rawCat + ' ' + rawGroup + ' ' + rawSource;

    if (joined.includes('stale') || joined.includes('conflict') || joined.includes('attention') || joined.includes('warning')) {
      return 'attention';
    }
    if (joined.includes('memt') || joined.includes('recipe') || joined.includes('experience') || joined.includes('procedural')) {
      return 'memt';
    }
    if (
      rawKind === 'connector' ||
      rawKind === 'source' ||
      rawKind === 'sources' ||
      rawType === 'connector' ||
      rawType === 'source' ||
      rawType === 'sources' ||
      rawCat === 'connector' ||
      rawCat === 'source' ||
      rawCat === 'sources' ||
      rawSource === 'connector' ||
      joined.includes('connector') ||
      joined.includes('sources') ||
      joined.includes('feed') ||
      joined.includes('channel')
    ) {
      return 'connector';
    }
    if (
      rawSource === 'claim_v2_semantics' ||
      rawKind === 'concept' ||
      rawKind === 'concepts' ||
      rawKind === 'claim' ||
      rawType === 'concept' ||
      rawType === 'concepts' ||
      rawType === 'claim' ||
      rawCat === 'concept' ||
      rawCat === 'concepts' ||
      rawCat === 'claim'
    ) {
      return 'concept';
    }
    if (
      node.consolidated === true ||
      rawSource === 'world_consolidation' ||
      joined.includes('consolidated') ||
      joined.includes('world_object') ||
      joined.includes('world') ||
      rawKind === 'entity' ||
      rawType === 'entity' ||
      rawCat === 'entity'
    ) {
      return 'consolidated';
    }
    if (joined.includes('source')) {
      return 'connector';
    }
    return 'concept';
  }

  function resolvePalette() {
    const docEl = document.documentElement;
    const rootStyle = getComputedStyle(docEl);
    const themeAttr = docEl.getAttribute('data-theme');
    const isLight = themeAttr === 'light';
    const read = (name, fallback) => {
      const val = rootStyle.getPropertyValue(name).trim();
      return val || fallback;
    };

    const fontSans = read(
      '--font-sans',
      "'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    );
    const fontMono = read(
      '--font-mono',
      "'Geist Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    );

    return {
      isLight,
      fontSans,
      fontMono,
      // Balanced cartographic canvas grounds: #050507 dark, #ffffff light
      canvas: isLight ? '#ffffff' : '#050507',
      sunken: isLight ? '#fafafa' : '#050507',
      raised: read('--surface-raised', isLight ? '#ffffff' : '#0b0c10'),
      overlay: read('--surface-overlay', isLight ? '#f5f5f7' : '#121318'),
      border: read('--border-hairline', isLight ? 'rgba(23, 23, 23, 0.10)' : 'rgba(255, 255, 255, 0.10)'),
      borderStrong: read('--border-strong', isLight ? 'rgba(23, 23, 23, 0.20)' : 'rgba(255, 255, 255, 0.18)'),
      inkPrimary: read('--ink-primary', isLight ? '#171717' : '#ededed'),
      inkSecondary: read('--ink-secondary', isLight ? '#45454a' : '#a6a8b1'),
      inkMuted: read('--ink-muted', isLight ? '#71717a' : '#737682'),
      amber: isLight ? '#d97706' : '#f59e0b',
      teal: isLight ? '#059669' : '#34d399',
      cobalt: isLight ? '#2563eb' : '#3b82f6',
      violet: isLight ? '#7c3aed' : '#a855f7',
      rose: read('--accent-rose', isLight ? '#e11d48' : '#ff0080'),
      secondaryHub: isLight ? '#52525b' : '#8a8d98',
      slate: isLight ? '#52525b' : '#a1a1aa',

      // 4-category semantic legend palette (World / MemT / Concepts / Sources)
      catWorld: isLight ? '#d97706' : '#f59e0b',
      catWorldRgb: isLight ? '217, 119, 6' : '245, 158, 11',
      catWorldFill: isLight ? 'rgba(217, 119, 6, 0.14)' : 'rgba(245, 158, 11, 0.18)',
      catWorldRing: isLight ? 'rgba(217, 119, 6, 0.36)' : 'rgba(245, 158, 11, 0.38)',
      catMemt: isLight ? '#059669' : '#34d399',
      catMemtRgb: isLight ? '5, 150, 105' : '52, 211, 153',
      catMemtFill: isLight ? 'rgba(5, 150, 105, 0.14)' : 'rgba(52, 211, 153, 0.16)',
      catMemtRing: isLight ? 'rgba(5, 150, 105, 0.36)' : 'rgba(52, 211, 153, 0.38)',
      catConcept: isLight ? '#2563eb' : '#3b82f6',
      catConceptRgb: isLight ? '37, 99, 235' : '59, 130, 246',
      catConceptFill: isLight ? 'rgba(37, 99, 235, 0.14)' : 'rgba(59, 130, 246, 0.16)',
      catConceptRing: isLight ? 'rgba(37, 99, 235, 0.36)' : 'rgba(59, 130, 246, 0.38)',
      catSource: isLight ? '#7c3aed' : '#a855f7',
      catSourceRgb: isLight ? '124, 58, 237' : '168, 85, 247',
      catSourceFill: isLight ? 'rgba(124, 58, 237, 0.14)' : 'rgba(168, 85, 247, 0.18)',
      catSourceRing: isLight ? 'rgba(124, 58, 237, 0.36)' : 'rgba(168, 85, 247, 0.38)',
      catAttentionRgb: isLight ? '225, 29, 72' : '255, 0, 128',
      canvasRgb: isLight ? '255, 255, 255' : '5, 5, 7',
      socketCore: isLight ? '#ffffff' : '#050507',
      specularArc: isLight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.22)',

      // Dual-ring cartographic node tokens
      nodeBody: isLight ? '#ffffff' : '#090a0f',
      nodeActiveTint: isLight ? 'rgba(37, 99, 235, 0.08)' : 'rgba(59, 130, 246, 0.12)',
      hubOuterRing: isLight ? 'rgba(23, 23, 23, 0.20)' : 'rgba(237, 237, 237, 0.22)',
      hubOuterRingActive: isLight ? 'rgba(37, 99, 235, 0.54)' : 'rgba(59, 130, 246, 0.58)',
      hubInnerRing: isLight ? 'rgba(23, 23, 23, 0.84)' : 'rgba(237, 237, 237, 0.86)',
      hubCoreCenter: isLight ? '#141417' : '#f4f5f7',
      hubCoreSecondary: isLight ? '#52525b' : '#9498a6',
      focusHalo: isLight ? 'rgba(37, 99, 235, 0.88)' : 'rgba(59, 130, 246, 0.92)',
      focusHaloOuter: isLight ? 'rgba(37, 99, 235, 0.22)' : 'rgba(59, 130, 246, 0.28)',
      hoverHalo: isLight ? 'rgba(37, 99, 235, 0.66)' : 'rgba(59, 130, 246, 0.72)',
      egoRim: isLight ? 'rgba(37, 99, 235, 0.44)' : 'rgba(59, 130, 246, 0.48)',

      // Category fills
      connectorFill: isLight ? 'rgba(124, 58, 237, 0.14)' : 'rgba(168, 85, 247, 0.18)',
      connectorFillActive: isLight ? 'rgba(124, 58, 237, 0.24)' : 'rgba(168, 85, 247, 0.28)',
      memtFill: isLight ? 'rgba(5, 150, 105, 0.14)' : 'rgba(52, 211, 153, 0.16)',
      memtFillActive: isLight ? 'rgba(5, 150, 105, 0.24)' : 'rgba(52, 211, 153, 0.26)',

      // Label pills, leader ticks & predicate pills
      pillBg: isLight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(10, 11, 16, 0.90)',
      pillBgActive: isLight ? 'rgba(247, 250, 255, 0.98)' : 'rgba(14, 17, 26, 0.96)',
      pillBorder: isLight ? 'rgba(23, 23, 23, 0.13)' : 'rgba(255, 255, 255, 0.11)',
      pillBorderEgo: isLight ? 'rgba(37, 99, 235, 0.34)' : 'rgba(59, 130, 246, 0.36)',
      pillBorderActive: isLight ? 'rgba(37, 99, 235, 0.74)' : 'rgba(59, 130, 246, 0.78)',
      leaderTick: isLight ? 'rgba(23, 23, 23, 0.26)' : 'rgba(255, 255, 255, 0.28)',
      leaderTickActive: isLight ? 'rgba(37, 99, 235, 0.68)' : 'rgba(59, 130, 246, 0.74)',

      // Edges & architectural focal field
      edgeIdle: isLight ? 'rgba(23, 23, 23,' : 'rgba(226, 232, 240,',
      edgeEgoOrigin: isLight ? 'rgba(37, 99, 235,' : 'rgba(59, 130, 246,',
      edgeEgoTarget: isLight ? 'rgba(59, 130, 246,' : 'rgba(125, 196, 255,',
      dotGrid: isLight ? 'rgba(23, 23, 23, 0.085)' : 'rgba(255, 255, 255, 0.085)',
      majorTick: isLight ? 'rgba(23, 23, 23, 0.16)' : 'rgba(255, 255, 255, 0.15)',
      radarRing: isLight ? 'rgba(23, 23, 23, 0.055)' : 'rgba(255, 255, 255, 0.055)',
      radarTick: isLight ? 'rgba(23, 23, 23, 0.12)' : 'rgba(255, 255, 255, 0.12)',
      hubTick: isLight ? 'rgba(23, 23, 23, 0.32)' : 'rgba(237, 237, 237, 0.34)',
      sectorLabel: isLight ? 'rgba(23, 23, 23, 0.06)' : 'rgba(255, 255, 255, 0.08)',
      sectorLabelActive: isLight ? 'rgba(37, 99, 235, 0.18)' : 'rgba(59, 130, 246, 0.22)',
    };
  }

  const SECTOR_LABELS = [
    { key: 'consolidated', text: 'WORLD GRAPH', anchor: 'top', align: 'center' },
    { key: 'memt', text: 'MEMT PLAYBOOK', anchor: 'right', align: 'left' },
    { key: 'connector', text: 'MEMORY PIPELINES', anchor: 'left', align: 'right' },
    { key: 'concept', text: 'CONCEPTS', anchor: 'bottom', align: 'center' },
  ];

  const CAMERA_TWEEN_MS = 260;

  class KizukiGraph {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = options;
      this.palette = resolvePalette();

      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this._needsFitOnVisible = false;

      this.detailOn = options.detailOn !== false;
      this.reducedMotion = Boolean(
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );

      // Graph state
      this.allNodes = [];
      this.allEdges = [];
      this.nodeMap = new Map();
      this.visibleNodes = [];
      this.visibleEdges = [];
      this.adjacency = new Map();
      this.topHubIds = new Set();
      this.hubDegreeThreshold = 12;
      this.maxVisibleDegree = 12;

      // Filters
      this.filterKind = 'all';
      this.filterQuery = '';

      // Interaction & Highlighting
      this.hoveredId = null;
      this.selectedId = null;
      this._lastFocusId = null;
      this.citedIds = new Set();
      this.dragNode = null;
      this.isPanning = false;
      this.pointerMoved = false;
      this.pointerDownPos = { x: 0, y: 0 };
      this.lastPointerPos = { x: 0, y: 0 };
      this.activePointers = new Map();
      this.lastPinchDist = 0;
      this.egoBlend = 0;
      this._pulsePhase = 0;

      // Camera (world coordinates at center of viewport)
      this.cam = { x: 0, y: 0, zoom: 1 };
      this.camTarget = null;
      this.camTween = null;

      // Physics
      this.alpha = 0;
      this.alphaDecay = 0.024;
      this.velocityDecay = 0.72;
      this.rafId = null;
      this.lastFrameTime = 0;
      this.lastHudUpdate = 0;
      this._isVisible = true;
      this._destroyed = false;

      this._bindEvents();
      this._setupObservers();
      this.resize();
    }

    _canAnimate() {
      if (this._destroyed || !this._isVisible) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;
      if (this.canvas && this.canvas.isConnected === false) return false;
      if (this.canvas && typeof this.canvas.closest === 'function' && this.canvas.closest('[hidden]')) return false;
      return true;
    }

    _pauseRaf() {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }

    destroy() {
      this._destroyed = true;
      this._pauseRaf();
      if (this._ro && typeof this._ro.disconnect === 'function') {
        this._ro.disconnect();
        this._ro = null;
      }
      if (this._io && typeof this._io.disconnect === 'function') {
        this._io.disconnect();
        this._io = null;
      }
      if (this._themeObserver && typeof this._themeObserver.disconnect === 'function') {
        this._themeObserver.disconnect();
        this._themeObserver = null;
      }
      if (this._onVisibilityChange && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this._onVisibilityChange = null;
      }
    }

    _setupObservers() {
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.canvas.parentElement || this.canvas);
      } else {
        window.addEventListener('resize', () => this.resize());
      }

      if (typeof IntersectionObserver !== 'undefined') {
        try {
          this._io = new IntersectionObserver((entries) => {
            if (this._destroyed) return;
            const entry = entries && entries[0];
            const vis = Boolean(entry && entry.isIntersecting);
            this._isVisible = vis;
            if (!vis) {
              this._pauseRaf();
            } else {
              this.resize();
              this._drawOrWake();
            }
          }, { threshold: 0.01 });
          this._io.observe(this.canvas);
        } catch {
          this._io = null;
        }
      }

      if (typeof document !== 'undefined') {
        this._onVisibilityChange = () => {
          if (document.hidden) {
            this._pauseRaf();
          } else if (this._canAnimate()) {
            this._drawOrWake();
          }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }

      if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = (e) => {
          this.reducedMotion = Boolean(e.matches);
          if (this.reducedMotion) {
            if (this.camTween) {
              this.cam = { x: this.camTween.toX, y: this.camTween.toY, zoom: this.camTween.toZoom };
              this._cancelCameraTween();
            }
            const activeFocusId = this.hoveredId || this.selectedId;
            this.egoBlend = activeFocusId ? 1 : 0;
            this._lastFocusId = activeFocusId || null;
          }
          this._drawOrWake();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
      }

      if (typeof MutationObserver !== 'undefined' && document.documentElement) {
        this._themeObserver = new MutationObserver(() => {
          const nextIsLight = document.documentElement.getAttribute('data-theme') === 'light';
          if (nextIsLight !== this.palette.isLight) {
            this.refreshTheme();
          }
        });
        this._themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
      }
    }

    _shouldPulse() {
      if (!this.detailOn || this.reducedMotion) return false;
      const activeFocusId = this.hoveredId || this.selectedId;
      if (!activeFocusId) return false;
      let count = 0;
      for (let i = 0; i < this.visibleEdges.length; i += 1) {
        const e = this.visibleEdges[i];
        if (e.source.id === activeFocusId || e.target.id === activeFocusId) {
          count += 1;
          if (count > 28) return false;
        }
      }
      return count > 0;
    }

    _hasActiveAnimation() {
      const egoGoal = this.hoveredId || this.selectedId ? 1 : 0;
      return (
        this.alpha > 0.004 ||
        this.camTween !== null ||
        (!this.reducedMotion && Math.abs(egoGoal - this.egoBlend) > 0.008) ||
        this._shouldPulse()
      );
    }

    _emitCameraHud() {
      if (!this.options.onCameraUpdate) return;
      this.options.onCameraUpdate({
        x: this.cam.x,
        y: this.cam.y,
        zoom: this.cam.zoom,
        visibleCount: this.visibleNodes.length,
      });
    }

    _drawOrWake() {
      if (this._hasActiveAnimation()) {
        this.requestRender();
      } else {
        this._pauseRaf();
        this._draw();
        this._emitCameraHud();
      }
    }

    _cancelCameraTween() {
      this.camTween = null;
      this.camTarget = null;
    }

    _startCameraTween(target, duration = CAMERA_TWEEN_MS) {
      const toX = target.x;
      const toY = target.y;
      const toZoom = target.zoom;

      const nearTarget =
        Math.abs(toX - this.cam.x) < 0.25 &&
        Math.abs(toY - this.cam.y) < 0.25 &&
        Math.abs(toZoom - this.cam.zoom) < 0.0015;

      if (this.reducedMotion || duration <= 0 || nearTarget) {
        this.cam = { x: toX, y: toY, zoom: toZoom };
        this._cancelCameraTween();
        this._drawOrWake();
        return;
      }

      this.camTarget = { x: toX, y: toY, zoom: toZoom };
      this.camTween = {
        fromX: this.cam.x,
        fromY: this.cam.y,
        fromZoom: this.cam.zoom,
        toX,
        toY,
        toZoom,
        startTime: performance.now(),
        duration,
      };
      this.requestRender();
    }

    resize() {
      const parent = this.canvas.parentElement;
      const rect = parent ? parent.getBoundingClientRect() : this.canvas.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w < 10 || h < 10) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const wasHidden = this.width < 10 || this.height < 10;
      if (!wasHidden && w === this.width && h === this.height && dpr === this.dpr) return;

      this.width = w;
      this.height = h;
      this.dpr = dpr;

      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';

      if (wasHidden && this._needsFitOnVisible && this.visibleNodes.length > 0) {
        this._needsFitOnVisible = false;
        this.fitToScreen(true);
      }

      this._drawOrWake();
    }

    setDetail(enabled) {
      this.detailOn = Boolean(enabled);
      this.palette = resolvePalette();
      this._drawOrWake();
    }

    refreshTheme() {
      this.palette = resolvePalette();
      this._drawOrWake();
    }

    _setHoveredNode(node) {
      const nextId = node ? node.id : null;
      const changed = nextId !== this.hoveredId;
      this.hoveredId = nextId;
      if (nextId) {
        this._lastFocusId = nextId;
      }
      this.canvas.classList.toggle('is-pointer', Boolean(node));

      if (changed) {
        if (this.options.onHoverNode) {
          if (node) {
            const pos = this.worldToScreen(node.x, node.y);
            this.options.onHoverNode({ node: node.raw, x: pos.x, y: pos.y });
          } else {
            this.options.onHoverNode(null);
          }
        }
        this.requestRender();
      }
    }

    setData(rawNodes, rawEdges) {
      const prevPositions = new Map();
      for (const n of this.allNodes) {
        prevPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
      }

      const kindSectors = {
        consolidated: { start: -Math.PI * 0.85, span: Math.PI * 1.65, minR: 64, maxR: 255 },
        memt: { start: -Math.PI * 0.26, span: Math.PI * 0.44, minR: 255, maxR: 385 },
        connector: { start: -Math.PI * 0.90, span: Math.PI * 0.36, minR: 270, maxR: 395 },
        concept: { start: Math.PI * 0.28, span: Math.PI * 0.46, minR: 245, maxR: 410 },
        attention: { start: Math.PI * 0.10, span: Math.PI * 0.24, minR: 205, maxR: 320 },
      };

      const nodes = [];
      const map = new Map();
      const catCounts = { consolidated: 0, memt: 0, concept: 0, connector: 0, attention: 0 };

      (rawNodes || []).forEach((item) => {
        if (!item || !item.id) return;
        const id = String(item.id);
        const category = classifyNodeKind(item);
        const degree = Number(item.degree || 0);
        const claims = Number(item.claim_count || 0);
        // Logarithmic architectural pin radius: crisp 4.0px to 10.5px
        const logDeg = Math.log2(1 + Math.max(0, degree));
        const bonus =
          category === 'connector'
            ? 2.4
            : (category === 'memt' ? 0.9 : (category === 'consolidated' ? 0.6 : 0));
        const radius = clamp(3.9 + logDeg * 1.45 + bonus, 4.0, 10.5);

        const prev = prevPositions.get(id);
        let x;
        let y;
        if (prev) {
          x = prev.x;
          y = prev.y;
        } else {
          const idxInCat = catCounts[category] || 0;
          catCounts[category] = idxInCat + 1;
          const sec = kindSectors[category] || kindSectors.concept;
          const h1 = hashString(id + ':a');
          const golden = idxInCat * 2.3999632297;
          const angle =
            category === 'consolidated'
              ? golden
              : sec.start + ((idxInCat * 0.37 + h1 * 0.63) % 1) * sec.span;
          const radialT = Math.sqrt((idxInCat + 0.5) / Math.max(6, (rawNodes || []).length * 0.55));
          const dist = sec.minR + Math.min(1, radialT) * (sec.maxR - sec.minR) + (h1 - 0.5) * 32;
          x = Math.cos(angle) * dist * 1.15;
          y = Math.sin(angle) * dist * 0.90;
        }

        const nodeObj = {
          id,
          raw: item,
          label: String(item.label || item.id),
          kind: String(item.kind || category),
          category,
          consolidated: category === 'consolidated',
          degree,
          claim_count: claims,
          confidence: item.confidence !== undefined ? Number(item.confidence) : null,
          summary: item.summary || '',
          updated_at: item.updated_at || '',
          radius,
          x,
          y,
          vx: prev ? prev.vx * 0.25 : 0,
          vy: prev ? prev.vy * 0.25 : 0,
          pinned: false,
        };
        nodes.push(nodeObj);
        map.set(id, nodeObj);
      });

      const edges = [];
      const adj = new Map();
      for (const n of nodes) adj.set(n.id, new Set());

      (rawEdges || []).forEach((e) => {
        if (!e) return;
        const sId = typeof e.source === 'object' ? String(e.source.id) : String(e.source);
        const tId = typeof e.target === 'object' ? String(e.target.id) : String(e.target);
        if (sId === tId) return;
        const sNode = map.get(sId);
        const tNode = map.get(tId);
        if (!sNode || !tNode) return;

        const edgeHash = hashString(sId + '::' + tId);
        const curveSign = edgeHash >= 0.5 ? 1 : -1;
        const curveMag = 0.72 + ((edgeHash * 7.13) % 1) * 0.68;
        const pulseOffset = (edgeHash * 3.71) % 1;
        const pulseSpeed = 0.88 + ((edgeHash * 5.31) % 1) * 0.28;

        edges.push({
          source: sNode,
          target: tNode,
          predicate: String(e.predicate || ''),
          weight: clamp(Number(e.weight || 1), 0.3, 5),
          curveSign,
          curveMag,
          pulseOffset,
          pulseSpeed,
        });
        adj.get(sId).add(tId);
        adj.get(tId).add(sId);
      });

      for (const n of nodes) {
        const edgeDeg = adj.get(n.id).size;
        if (edgeDeg > n.degree) {
          n.degree = edgeDeg;
          const logDeg = Math.log2(1 + n.degree);
          const bonus =
            n.category === 'connector'
              ? 2.4
              : (n.category === 'memt' ? 0.9 : (n.category === 'consolidated' ? 0.6 : 0));
          n.radius = clamp(3.9 + logDeg * 1.45 + bonus, 4.0, 10.5);
        }
      }

      this.allNodes = nodes;
      this.allEdges = edges;
      this.nodeMap = map;
      this.adjacency = adj;

      this._applyFilterInternal();

      // Synchronous warmup for airy, non-overlapping initial constellation
      if (this.visibleNodes.length > 0) {
        this.alpha = 0.92;
        const warmSteps = this.reducedMotion ? 120 : 102;
        for (let i = 0; i < warmSteps; i += 1) {
          this._stepPhysics(1);
        }
        this.fitToScreen(true);
        if (this.reducedMotion) {
          this.alpha = 0;
        }
      }

      this._drawOrWake();
    }

    setFilter({ kind, query }) {
      if (kind !== undefined) this.filterKind = kind;
      if (query !== undefined) this.filterQuery = String(query || '').trim().toLowerCase();
      this._applyFilterInternal();
      this.alpha = Math.max(this.alpha, this.reducedMotion ? 0 : 0.36);
      if (this.visibleNodes.length > 0) {
        this.fitToScreen(this.reducedMotion);
      } else {
        this._drawOrWake();
      }
    }

    _applyFilterInternal() {
      const q = this.filterQuery;
      const kind = this.filterKind;

      const matched = new Set();
      for (const n of this.allNodes) {
        const kindOk =
          kind === 'all' ||
          (kind === 'consolidated' && n.category === 'consolidated') ||
          (kind === 'memt' && n.category === 'memt') ||
          (kind === 'concept' && (n.category === 'concept' || n.category === 'attention')) ||
          (kind === 'connector' && n.category === 'connector');

        if (!kindOk) continue;

        if (!q) {
          matched.add(n.id);
        } else {
          const hay = (n.label + ' ' + n.kind + ' ' + n.summary + ' ' + n.id).toLowerCase();
          if (hay.includes(q)) matched.add(n.id);
        }
      }

      this.visibleNodes = this.allNodes.filter((n) => matched.has(n.id));
      this.visibleEdges = this.allEdges.filter(
        (e) => matched.has(e.source.id) && matched.has(e.target.id)
      );
      this._recomputeHubThreshold();

      if (this.hoveredId && !matched.has(this.hoveredId)) {
        this._setHoveredNode(null);
      }

      if (this.options.onVisibleChange) {
        this.options.onVisibleChange({
          visibleCount: this.visibleNodes.length,
          totalCount: this.allNodes.length,
          edgeCount: this.visibleEdges.length,
        });
      }
    }

    getNodeById(id) {
      return this.nodeMap.get(String(id)) || null;
    }

    setSelected(id) {
      const nextId = id ? String(id) : null;
      if (nextId === this.selectedId) return;
      this.selectedId = nextId;
      if (nextId) {
        this._lastFocusId = nextId;
      }
      this.requestRender();
    }

    highlightNodes(ids) {
      this.citedIds = new Set((ids || []).map((id) => String(id)));
      this._drawOrWake();
    }

    focusNode(id, opts = {}) {
      const node = this.nodeMap.get(String(id));
      if (!node) return false;

      // Ensure node is visible if current filter hid it
      if (!this.visibleNodes.includes(node)) {
        this.filterKind = 'all';
        this.filterQuery = '';
        this._applyFilterInternal();
      }

      if (opts.select !== false) {
        this.selectedId = node.id;
        this._lastFocusId = node.id;
      }

      const targetZoom = clamp(opts.zoom || Math.max(this.cam.zoom, 1.35), 0.7, 3.2);
      // Offset slightly left on desktop when inspector drawer is open so node sits centered in open canvas
      const drawerOffsetWorld = (this.width > 768 ? 175 : 0) / targetZoom;
      const target = {
        x: node.x + drawerOffsetWorld,
        y: node.y,
        zoom: targetZoom,
      };

      if (this.reducedMotion || opts.instant) {
        this.cam = target;
        this._cancelCameraTween();
        this._drawOrWake();
      } else {
        this._startCameraTween(target, CAMERA_TWEEN_MS);
      }
      return true;
    }

    fitToScreen(instant = false) {
      if (this.visibleNodes.length === 0) return;
      if (this.width < 10 || this.height < 10) {
        this._needsFitOnVisible = true;
        return;
      }
      this._needsFitOnVisible = false;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (const n of this.visibleNodes) {
        if (n.x - n.radius < minX) minX = n.x - n.radius;
        if (n.x + n.radius > maxX) maxX = n.x + n.radius;
        if (n.y - n.radius < minY) minY = n.y - n.radius;
        if (n.y + n.radius > maxY) maxY = n.y + n.radius;
      }

      const spanX = Math.max(160, maxX - minX);
      const spanY = Math.max(160, maxY - minY);
      const padX = this.width < 600 ? 36 : 74;
      const topReserve = this.width < 600 ? 96 : 64;
      const bottomReserve = this.width < 600 ? 150 : 148;
      const availW = Math.max(120, this.width - padX * 2);
      const availH = Math.max(120, this.height - topReserve - bottomReserve);
      const zoom = clamp(Math.min(availW / spanX, availH / spanY), 0.32, 1.75);

      const centerOffsetY = ((bottomReserve - topReserve) * 0.5) / zoom;
      const target = {
        x: (minX + maxX) * 0.5,
        y: (minY + maxY) * 0.5 + centerOffsetY,
        zoom,
      };

      if (instant || this.reducedMotion) {
        this.cam = target;
        this._cancelCameraTween();
        this._drawOrWake();
      } else {
        this._startCameraTween(target, CAMERA_TWEEN_MS);
      }
    }

    zoomBy(factor, anchorScreenX, anchorScreenY) {
      this._cancelCameraTween();
      const nextZoom = clamp(this.cam.zoom * factor, 0.22, 4.5);
      const ax = anchorScreenX !== undefined ? anchorScreenX : this.width * 0.5;
      const ay = anchorScreenY !== undefined ? anchorScreenY : this.height * 0.5;

      const before = this.screenToWorld(ax, ay);
      this.cam.zoom = nextZoom;
      const after = this.screenToWorld(ax, ay);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
      this.requestRender();
    }

    reheat() {
      this.alpha = 0.75;
      this.requestRender();
    }

    worldToScreen(wx, wy) {
      return {
        x: (wx - this.cam.x) * this.cam.zoom + this.width * 0.5,
        y: (wy - this.cam.y) * this.cam.zoom + this.height * 0.5,
      };
    }

    screenToWorld(sx, sy) {
      return {
        x: (sx - this.width * 0.5) / this.cam.zoom + this.cam.x,
        y: (sy - this.height * 0.5) / this.cam.zoom + this.cam.y,
      };
    }

    _hitTest(sx, sy) {
      const world = this.screenToWorld(sx, sy);
      const hitPad = (this.width < 768 ? 14 : 7) / this.cam.zoom;
      let best = null;
      let bestDist = Infinity;

      for (let i = this.visibleNodes.length - 1; i >= 0; i -= 1) {
        const n = this.visibleNodes[i];
        const dx = world.x - n.x;
        const dy = world.y - n.y;
        const d = Math.hypot(dx, dy);
        const r = n.radius + hitPad;
        if (d <= r && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    }

    _bindEvents() {
      const c = this.canvas;

      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        c.setPointerCapture(e.pointerId);
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        this.activePointers.set(e.pointerId, { x: sx, y: sy });
        // Yield camera interpolation immediately to user interaction
        this._cancelCameraTween();

        if (this.activePointers.size === 2) {
          const pts = Array.from(this.activePointers.values());
          this.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          this.dragNode = null;
          this.isPanning = false;
          this._setHoveredNode(null);
          return;
        }

        this.pointerDownPos = { x: sx, y: sy };
        this.lastPointerPos = { x: sx, y: sy };
        this.pointerMoved = false;

        const hit = this._hitTest(sx, sy);
        if (hit) {
          this.dragNode = hit;
          hit.pinned = true;
          hit.vx = 0;
          hit.vy = 0;
          c.classList.add('is-dragging');
          this.alpha = Math.max(this.alpha, 0.25);
        } else {
          this.isPanning = true;
          c.classList.add('is-dragging');
        }
        this._setHoveredNode(null);
        this.requestRender();
      });

      c.addEventListener('pointermove', (e) => {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (this.activePointers.has(e.pointerId)) {
          this.activePointers.set(e.pointerId, { x: sx, y: sy });
        }

        // Two-finger pinch zoom
        if (this.activePointers.size === 2) {
          const pts = Array.from(this.activePointers.values());
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const midX = (pts[0].x + pts[1].x) * 0.5;
          const midY = (pts[0].y + pts[1].y) * 0.5;
          if (this.lastPinchDist > 8 && dist > 8) {
            this.zoomBy(dist / this.lastPinchDist, midX, midY);
          }
          this.lastPinchDist = dist;
          this.pointerMoved = true;
          return;
        }

        const dx = sx - this.lastPointerPos.x;
        const dy = sy - this.lastPointerPos.y;
        this.lastPointerPos = { x: sx, y: sy };

        if (Math.hypot(sx - this.pointerDownPos.x, sy - this.pointerDownPos.y) > 4) {
          this.pointerMoved = true;
        }

        if (this.dragNode) {
          const world = this.screenToWorld(sx, sy);
          this.dragNode.x = world.x;
          this.dragNode.y = world.y;
          this.dragNode.vx = 0;
          this.dragNode.vy = 0;
          this.alpha = Math.max(this.alpha, 0.18);
          this.requestRender();
          return;
        }

        if (this.isPanning) {
          this._cancelCameraTween();
          this.cam.x -= dx / this.cam.zoom;
          this.cam.y -= dy / this.cam.zoom;
          this.requestRender();
          return;
        }

        if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          const hit = this._hitTest(sx, sy);
          this._setHoveredNode(hit);
        }
      });

      const endPointer = (e) => {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        this.activePointers.delete(e.pointerId);
        if (this.activePointers.size < 2) {
          this.lastPinchDist = 0;
        }

        const wasDragNode = this.dragNode;
        if (wasDragNode) {
          wasDragNode.pinned = false;
          this.dragNode = null;
        }
        this.isPanning = false;
        c.classList.remove('is-dragging');

        if (!this.pointerMoved && this.activePointers.size === 0) {
          const hit = this._hitTest(sx, sy);
          if (hit) {
            this.selectedId = hit.id;
            this._lastFocusId = hit.id;
            if (this.options.onSelectNode) {
              this.options.onSelectNode(hit.raw);
            }
            // Gently pan if desktop inspector drawer would obscure the clicked node
            if (this.width > 768) {
              const screenPos = this.worldToScreen(hit.x, hit.y);
              if (screenPos.x > this.width - 404) {
                const drawerOffsetWorld = 175 / this.cam.zoom;
                this._startCameraTween(
                  { x: hit.x + drawerOffsetWorld, y: hit.y, zoom: this.cam.zoom },
                  CAMERA_TWEEN_MS
                );
              }
            }
          } else if (this.selectedId) {
            this.selectedId = null;
            if (this.options.onClearSelection) {
              this.options.onClearSelection();
            }
          }
          this.requestRender();
        }
      };

      c.addEventListener('pointerup', endPointer);
      c.addEventListener('pointercancel', endPointer);
      c.addEventListener('pointerleave', () => {
        if (!this.isPanning && !this.dragNode && this.hoveredId) {
          this._setHoveredNode(null);
        }
      });

      c.addEventListener('dblclick', (e) => {
        const rect = c.getBoundingClientRect();
        const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) {
          this.focusNode(hit.id, { zoom: Math.max(this.cam.zoom, 1.55) });
          if (this.options.onSelectNode) this.options.onSelectNode(hit.raw);
        } else {
          this.fitToScreen(false);
        }
      });

      c.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this._cancelCameraTween();
          const rect = c.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const delta = -clamp(e.deltaY, -120, 120);
          const factor = Math.exp(delta * 0.0022);
          this.zoomBy(factor, sx, sy);
          if (this.hoveredId) {
            const hit = this._hitTest(sx, sy);
            this._setHoveredNode(hit);
          }
        },
        { passive: false }
      );
    }

    _stepPhysics(dtScale) {
      const nodes = this.visibleNodes;
      const edges = this.visibleEdges;
      const nCount = nodes.length;
      if (nCount === 0) return;

      const alpha = this.alpha;
      const repelStrength = 4400;
      const centerPull = 0.0045;

      // Pairwise charge repulsion + generous collision cushion
      for (let i = 0; i < nCount; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nCount; j += 1) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = (hashString(a.id + b.id) - 0.5) * 2;
            dy = (hashString(b.id + a.id) - 0.5) * 2;
            d2 = dx * dx + dy * dy + 1;
          }
          const dist = Math.sqrt(d2);
          const minSep = a.radius + b.radius + 34;

          let force = (repelStrength / (d2 + 180)) * alpha;
          if (dist < minSep) {
            force += ((minSep - dist) / dist) * 0.62;
          }

          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!a.pinned) {
            a.vx -= fx;
            a.vy -= fy;
          }
          if (!b.pinned) {
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      // Edge springs
      for (let i = 0; i < edges.length; i += 1) {
        const e = edges[i];
        const a = e.source;
        const b = e.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ideal = 128 + (a.radius + b.radius) * 3.1;
        const springK = (0.026 + Math.min(e.weight, 3) * 0.005) * alpha;
        const diff = (dist - ideal) * springK;
        const fx = (dx / dist) * diff;
        const fy = (dy / dist) * diff;

        if (!a.pinned) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!b.pinned) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Gentle aspect-balanced gravity toward center + Velocity-Verlet damping
      const decay = this.velocityDecay;
      for (let i = 0; i < nCount; i += 1) {
        const n = nodes[i];
        if (n.pinned) continue;
        const pull = n.consolidated ? centerPull * 1.15 : centerPull * 0.85;
        n.vx += -n.x * pull * 0.85 * alpha;
        n.vy += -n.y * pull * 1.2 * alpha;

        n.vx *= decay;
        n.vy *= decay;

        const maxSpeed = 24;
        const speed = Math.hypot(n.vx, n.vy);
        if (speed > maxSpeed) {
          n.vx = (n.vx / speed) * maxSpeed;
          n.vy = (n.vy / speed) * maxSpeed;
        }

        n.x += n.vx * dtScale;
        n.y += n.vy * dtScale;
      }

      this.alpha = Math.max(0, this.alpha * (1 - this.alphaDecay));
      if (this.alpha < 0.004) this.alpha = 0;
    }

    requestRender() {
      if (!this._canAnimate()) {
        this._pauseRaf();
        return;
      }
      if (this.rafId !== null) return;
      this.lastFrameTime = performance.now();
      this.rafId = requestAnimationFrame((ts) => this._loop(ts));
    }

    _loop(now) {
      this.rafId = null;
      if (!this._canAnimate()) return;
      const dtMs = clamp(now - this.lastFrameTime, 4, 40);
      const dt = clamp(dtMs / 16.67, 0.25, 2.0);
      this.lastFrameTime = now;

      let needsMore = false;

      if (this.alpha > 0.004) {
        this._stepPhysics(dt);
        if (this.alpha > 0.004) {
          needsMore = true;
        }
      }

      // Deterministic 260ms cubic ease-out camera tween
      if (this.camTween) {
        const tw = this.camTween;
        const t = clamp((now - tw.startTime) / tw.duration, 0, 1);
        const ease = easeOutCubic(t);
        this.cam.x = tw.fromX + (tw.toX - tw.fromX) * ease;
        this.cam.y = tw.fromY + (tw.toY - tw.fromY) * ease;
        this.cam.zoom = tw.fromZoom * Math.pow(tw.toZoom / tw.fromZoom, ease);

        if (t >= 1) {
          this.cam.x = tw.toX;
          this.cam.y = tw.toY;
          this.cam.zoom = tw.toZoom;
          this._cancelCameraTween();
        } else {
          needsMore = true;
        }
      }

      // Smooth frame-rate-independent ego neighborhood attenuation blend
      const activeFocusId = this.hoveredId || this.selectedId;
      if (activeFocusId) {
        this._lastFocusId = activeFocusId;
      }
      const egoGoal = activeFocusId ? 1 : 0;
      if (!this.reducedMotion) {
        const diff = egoGoal - this.egoBlend;
        if (Math.abs(diff) > 0.008) {
          const factor = 1 - Math.exp(-dtMs / 52);
          this.egoBlend += diff * factor;
          needsMore = true;
        } else {
          this.egoBlend = egoGoal;
          if (egoGoal === 0) this._lastFocusId = null;
        }
      } else {
        this.egoBlend = egoGoal;
        if (egoGoal === 0) this._lastFocusId = null;
      }

      // Hover/selection-only photon pulse clock (strictly 0 FPS when unfocused)
      if (this._shouldPulse()) {
        this._pulsePhase = (this._pulsePhase + dtMs * 0.00058) % 1000;
        needsMore = true;
      }

      this._draw();

      if (this.options.onCameraUpdate && now - this.lastHudUpdate > 45) {
        this.lastHudUpdate = now;
        this._emitCameraHud();
      }

      if (needsMore) {
        this.rafId = requestAnimationFrame((ts) => this._loop(ts));
      } else {
        // Sleep cleanly at rest: 0% CPU until next pointer, wheel, resize, or selection event
        this._emitCameraHud();
      }
    }

    _recomputeHubThreshold() {
      if (!this.visibleNodes || this.visibleNodes.length === 0) {
        this.hubDegreeThreshold = 12;
        this.maxVisibleDegree = 12;
        this.topHubIds = new Set();
        return;
      }
      const sorted = this.visibleNodes.slice().sort((a, b) => b.degree - a.degree);
      const topCount = Math.max(1, Math.floor(sorted.length * 0.12));
      const cutoffIdx = Math.min(sorted.length - 1, topCount - 1);
      this.hubDegreeThreshold = Math.min(12, Math.max(3, sorted[cutoffIdx].degree));
      this.maxVisibleDegree = Math.max(12, sorted[0].degree || 12);

      const ids = new Set();
      for (let i = 0; i < sorted.length; i += 1) {
        const n = sorted[i];
        if (n.degree >= 12 || (i < topCount && n.degree >= 3)) {
          ids.add(n.id);
        }
      }
      this.topHubIds = ids;
    }

    _nodeColor(node) {
      switch (node.category) {
        case 'consolidated':
          return this.palette.catWorld;
        case 'memt':
          return this.palette.catMemt;
        case 'connector':
          return this.palette.catSource;
        case 'attention':
          return this.palette.rose;
        case 'concept':
        default:
          return this.palette.catConcept;
      }
    }

    _nodeColorRgb(node) {
      switch (node.category) {
        case 'consolidated':
          return this.palette.catWorldRgb;
        case 'memt':
          return this.palette.catMemtRgb;
        case 'connector':
          return this.palette.catSourceRgb;
        case 'attention':
          return this.palette.catAttentionRgb;
        case 'concept':
        default:
          return this.palette.catConceptRgb;
      }
    }

    _edgeControlPoint(sx, sy, tx, ty, edge) {
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy) || 1;
      const mag = edge && edge.curveMag ? edge.curveMag : 1;
      const sign = edge && edge.curveSign ? edge.curveSign : 1;
      const bend = clamp(len * 0.082, 5.5, 25) * mag * sign;
      return {
        x: (sx + tx) * 0.5 - (dy / len) * bend,
        y: (sy + ty) * 0.5 + (dx / len) * bend,
      };
    }

    _nodeCategoryFill(node) {
      switch (node.category) {
        case 'consolidated':
          return this.palette.catWorldFill;
        case 'memt':
          return this.palette.catMemtFill;
        case 'connector':
          return this.palette.catSourceFill;
        case 'concept':
        default:
          return this.palette.catConceptFill;
      }
    }

    _nodeCategoryRing(node) {
      switch (node.category) {
        case 'consolidated':
          return this.palette.catWorldRing;
        case 'memt':
          return this.palette.catMemtRing;
        case 'connector':
          return this.palette.catSourceRing;
        case 'concept':
        default:
          return this.palette.catConceptRing;
      }
    }

    _isDualRingHub(node, isSelected, isHovered) {
      if (isSelected || isHovered) return true;
      if (node.degree >= 12) return true;
      return Boolean(this.topHubIds && this.topHubIds.has(node.id));
    }

    _nodeVisualRadius(node, sr, isSelected, isHovered) {
      const dualRing = this._isDualRingHub(node, isSelected, isHovered);
      if (node.category === 'connector') {
        const s = dualRing ? clamp(sr * 1.9, 13, 18) : clamp(sr * 1.5, 8.5, 13.5);
        return s * 0.56 + (dualRing ? 3.2 : 0.8);
      }
      if (node.category === 'memt') {
        const d = dualRing ? sr * 1.18 : Math.max(4.4, sr * 0.92);
        return d + (dualRing ? 3.2 : 0.8);
      }
      if (node.category === 'attention') {
        const h = dualRing ? sr * 1.2 : Math.max(4.4, sr * 0.92);
        return h + (dualRing ? 3.0 : 0.8);
      }
      if (dualRing) {
        return sr + 3.2;
      }
      return Math.max(3.3, sr * 0.76);
    }

    _drawFocalField(ctx) {
      if (!this.detailOn) return;

      const z = this.cam.zoom;
      // Crisp 24px architectural dot-grid + 144px (6x) crosshair ticks
      let worldStep = 24;
      while (worldStep * z < 18) worldStep *= 2;
      while (worldStep * z > 44) worldStep *= 0.5;

      const topLeft = this.screenToWorld(0, 0);
      const bottomRight = this.screenToWorld(this.width, this.height);
      const startX = Math.floor(topLeft.x / worldStep) * worldStep;
      const startY = Math.floor(topLeft.y / worldStep) * worldStep;

      ctx.save();

      // 1. 24px architectural dot-grid
      ctx.fillStyle = this.palette.dotGrid;
      for (let x = startX; x <= bottomRight.x; x += worldStep) {
        const sx = Math.round((x - this.cam.x) * z + this.width * 0.5);
        for (let y = startY; y <= bottomRight.y; y += worldStep) {
          const sy = Math.round((y - this.cam.y) * z + this.height * 0.5);
          ctx.fillRect(sx, sy, 1, 1);
        }
      }

      // 2. 144px subtle architectural crosshair ticks (every 6th dot)
      const majorStep = worldStep * 6;
      const mStartX = Math.floor(topLeft.x / majorStep) * majorStep;
      const mStartY = Math.floor(topLeft.y / majorStep) * majorStep;
      ctx.strokeStyle = this.palette.majorTick;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = mStartX; x <= bottomRight.x; x += majorStep) {
        const sx = Math.round((x - this.cam.x) * z + this.width * 0.5) + 0.5;
        for (let y = mStartY; y <= bottomRight.y; y += majorStep) {
          const sy = Math.round((y - this.cam.y) * z + this.height * 0.5) + 0.5;
          ctx.moveTo(sx - 3.5, sy);
          ctx.lineTo(sx + 3.5, sy);
          ctx.moveTo(sx, sy - 3.5);
          ctx.lineTo(sx, sy + 3.5);
        }
      }
      ctx.stroke();

      // 3. Concentric architectural radar rings at r=180 and r=360 around world origin
      const origin = this.worldToScreen(0, 0);
      const rings = [180, 360];
      ctx.strokeStyle = this.palette.radarRing;
      ctx.lineWidth = 1;
      for (let i = 0; i < rings.length; i += 1) {
        const rPx = rings[i] * z;
        if (rPx < 24 || rPx > 4200) continue;
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, rPx, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Subtle cardinal registration ticks on the outer radar ring + origin crosshair
      const outerR = 360 * z;
      if (outerR >= 60 && outerR <= 4200) {
        ctx.strokeStyle = this.palette.radarTick;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < 4; k += 1) {
          const a = k * (Math.PI * 0.5);
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          ctx.moveTo(origin.x + cos * (outerR - 4), origin.y + sin * (outerR - 4));
          ctx.lineTo(origin.x + cos * (outerR + 4), origin.y + sin * (outerR + 4));
        }
        ctx.moveTo(origin.x - 5, origin.y);
        ctx.lineTo(origin.x + 5, origin.y);
        ctx.moveTo(origin.x, origin.y - 5);
        ctx.lineTo(origin.x, origin.y + 5);
        ctx.stroke();
      }

      // 4. Subtle outer-perimeter cluster watermarks positioned outside the dense node hull
      if (z >= 0.36 && this.visibleNodes.length > 0) {
        let hullMinX = Infinity;
        let hullMaxX = -Infinity;
        let hullMinY = Infinity;
        let hullMaxY = -Infinity;
        const presentCats = new Set();

        for (let i = 0; i < this.visibleNodes.length; i += 1) {
          const n = this.visibleNodes[i];
          presentCats.add(n.category);
          if (n.x - n.radius < hullMinX) hullMinX = n.x - n.radius;
          if (n.x + n.radius > hullMaxX) hullMaxX = n.x + n.radius;
          if (n.y - n.radius < hullMinY) hullMinY = n.y - n.radius;
          if (n.y + n.radius > hullMaxY) hullMaxY = n.y + n.radius;
        }

        const midX = (hullMinX + hullMaxX) * 0.5;
        const midY = (hullMinY + hullMaxY) * 0.5;
        const worldMargin = Math.max(46, 36 / Math.max(0.35, z));

        const labelOpacityScale = clamp((z - 0.36) / 0.25, 0.45, 1);
        ctx.font = '500 11px ' + this.palette.fontMono;
        if ('letterSpacing' in ctx) {
          ctx.letterSpacing = '0.16em';
        }
        ctx.textBaseline = 'middle';

        for (let i = 0; i < SECTOR_LABELS.length; i += 1) {
          const sec = SECTOR_LABELS[i];
          if (this.filterKind !== 'all' && this.filterKind !== sec.key) continue;
          if (!presentCats.has(sec.key) && this.visibleNodes.length > 4) continue;

          let wx = midX;
          let wy = midY;
          if (sec.anchor === 'top') {
            wx = midX;
            wy = hullMinY - worldMargin;
          } else if (sec.anchor === 'bottom') {
            wx = midX;
            wy = hullMaxY + worldMargin;
          } else if (sec.anchor === 'right') {
            wx = hullMaxX + worldMargin * 0.85;
            wy = hullMinY + (hullMaxY - hullMinY) * 0.28;
          } else if (sec.anchor === 'left') {
            wx = hullMinX - worldMargin * 0.85;
            wy = hullMinY + (hullMaxY - hullMinY) * 0.28;
          }

          const pos = this.worldToScreen(wx, wy);
          const textW = ctx.measureText(sec.text).width;
          const marginX = 24;
          const sx = sec.align === 'left'
            ? clamp(pos.x, marginX, this.width - textW - marginX)
            : (sec.align === 'right'
              ? clamp(pos.x, textW + marginX, this.width - marginX)
              : clamp(pos.x, textW * 0.5 + marginX, this.width - textW * 0.5 - marginX));
          const sy = clamp(pos.y, 68, this.height - 68);

          const x1 = sec.align === 'left' ? sx : (sec.align === 'right' ? sx - textW : sx - textW * 0.5);
          const wmBox = { x1: x1 - 14, y1: sy - 14, x2: x1 + textW + 14, y2: sy + 14 };

          // Skip watermark if any visible node sits inside its padded perimeter box
          let blockedByNode = false;
          for (let j = 0; j < this.visibleNodes.length; j += 1) {
            const n = this.visibleNodes[j];
            const np = this.worldToScreen(n.x, n.y);
            const nr = clamp(n.radius * Math.pow(z, 0.58), 3.4, 13.5) + 18;
            if (boxHitsCircle(wmBox, np.x, np.y, nr)) {
              blockedByNode = true;
              break;
            }
          }
          if (blockedByNode) continue;

          const isFilteredSector = this.filterKind === sec.key;
          ctx.globalAlpha = labelOpacityScale;
          ctx.fillStyle = isFilteredSector ? this.palette.sectorLabelActive : this.palette.sectorLabel;
          ctx.textAlign = sec.align;
          ctx.fillText(sec.text, sx, sy);
        }
      }

      ctx.restore();
    }

    _drawFocusHalo(ctx, node, sx, sy, sr, strokeColor, lineWidth, offset, withTicks = false) {
      const dualRing = this._isDualRingHub(node, true, true);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();

      if (node.category === 'connector') {
        const s = clamp(sr * 1.9, 13, 18) + offset * 2;
        roundRectPath(ctx, sx - s * 0.5, sy - s * 0.5, s, s, 6.5);
      } else if (node.category === 'memt') {
        const d = sr * 1.18 + offset + 1.5;
        ctx.moveTo(sx, sy - d);
        ctx.lineTo(sx + d, sy);
        ctx.lineTo(sx, sy + d);
        ctx.lineTo(sx - d, sy);
        ctx.closePath();
      } else if (node.category === 'attention') {
        const h = sr * 1.2 + offset + 1.2;
        ctx.moveTo(sx, sy - h);
        ctx.lineTo(sx + h * 0.92, sy + h * 0.78);
        ctx.lineTo(sx - h * 0.92, sy + h * 0.78);
        ctx.closePath();
      } else {
        const baseR = dualRing ? sr : Math.max(3.3, sr * 0.76);
        const haloR = baseR + offset;
        ctx.arc(sx, sy, haloR, 0, Math.PI * 2);
        if (withTicks) {
          for (let k = 0; k < 4; k += 1) {
            const a = k * (Math.PI * 0.5);
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            ctx.moveTo(sx + cos * (haloR + 0.5), sy + sin * (haloR + 0.5));
            ctx.lineTo(sx + cos * (haloR + 3.2), sy + sin * (haloR + 3.2));
          }
        }
      }
      ctx.stroke();
    }

    _drawCalibrationArc(ctx, node, sx, sy, gaugeR, color, isFocused, isEgo) {
      if (!this.detailOn) return;
      const maxDeg = Math.max(12, this.maxVisibleDegree || 24);
      const degNorm = clamp((node.degree - 2) / Math.max(10, maxDeg - 2), 0, 1);
      const sweepRad = ((40 + degNorm * 260) * Math.PI) / 180;
      const startRad = -Math.PI * 0.5;
      const endRad = startRad + sweepRad;

      ctx.save();
      ctx.globalAlpha *= isFocused ? 0.94 : (isEgo ? 0.80 : 0.68);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(sx, sy, gaugeR, startRad, endRad);
      ctx.stroke();

      if (node.degree >= 12 || isFocused) {
        const tipX = sx + Math.cos(endRad) * gaugeR;
        const tipY = sy + Math.sin(endRad) * gaugeR;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(tipX, tipY, 1.35, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawTerminalSocket(ctx, x, y, color, alpha, flashProgress) {
      ctx.save();
      if (flashProgress >= 0 && flashProgress <= 1) {
        const eased = easeOutCubic(flashProgress);
        const flashR = 2.1 + eased * 5.2;
        const inv = 1 - flashProgress;
        ctx.globalAlpha = inv * inv * alpha * 0.85;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.arc(x, y, flashR, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = this.palette.socketCore;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      if (flashProgress >= 0 && flashProgress < 0.55) {
        const coreGlow = (1 - flashProgress / 0.55) * alpha * 0.9;
        ctx.globalAlpha = coreGlow;
        ctx.fillStyle = this.palette.isLight ? color : '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawPhotonComet(ctx, sub, rawT, fromRgb, toRgb, toColor, dimStrength) {
      if (rawT <= 0.015 || rawT >= 0.995) return;
      const env = dimStrength * clamp(rawT * 9, 0, 1) * clamp((1 - rawT) * 9, 0, 1);
      if (env <= 0.02) return;

      const tailSpan = 0.19;
      const tailStart = Math.max(0, rawT - tailSpan);
      const steps = 5;

      ctx.save();
      ctx.lineCap = 'round';
      for (let s = 0; s < steps; s += 1) {
        const f0 = s / steps;
        const f1 = (s + 1) / steps;
        const tA = tailStart + (rawT - tailStart) * f0;
        const tB = tailStart + (rawT - tailStart) * f1;
        const pA = evalQuadPoint(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, tA);
        const pB = evalQuadPoint(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, tB);
        const segAlpha = env * (0.08 + f1 * f1 * 0.78);
        const segRgb = f1 > 0.45 ? toRgb : fromRgb;
        ctx.strokeStyle = 'rgba(' + segRgb + ', ' + segAlpha.toFixed(3) + ')';
        ctx.lineWidth = 0.65 + f1 * 1.6;
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.stroke();
      }

      const head = evalQuadPoint(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, rawT);
      const tan = evalQuadTangent(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, rawT);
      const tLen = Math.hypot(tan.x, tan.y) || 1;
      const ux = tan.x / tLen;
      const uy = tan.y / tLen;
      const px = -uy;
      const py = ux;

      // Outer semantic diamond head
      ctx.globalAlpha = env * 0.94;
      ctx.fillStyle = toColor;
      ctx.beginPath();
      ctx.moveTo(head.x + ux * 4.5, head.y + uy * 4.5);
      ctx.lineTo(head.x + px * 2.1, head.y + py * 2.1);
      ctx.lineTo(head.x - ux * 3.1, head.y - uy * 3.1);
      ctx.lineTo(head.x - px * 2.1, head.y - py * 2.1);
      ctx.closePath();
      ctx.fill();

      // Luminous inner specular diamond core
      ctx.globalAlpha = env * 0.96;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(head.x + ux * 2.4, head.y + uy * 2.4);
      ctx.lineTo(head.x + px * 1.0, head.y + py * 1.0);
      ctx.lineTo(head.x - ux * 1.6, head.y - uy * 1.6);
      ctx.lineTo(head.x - px * 1.0, head.y - py * 1.0);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    _drawShape(ctx, node, sx, sy, sr, color, stateFlags) {
      const { isSelected, isHovered, isEgo } = stateFlags;
      const isFocused = isSelected || isHovered;
      const isActive = isFocused || isEgo;
      const dualRing = this._isDualRingHub(node, isSelected, isHovered);
      const fillBg = this.palette.nodeBody;
      const catFill = this._nodeCategoryFill(node);
      const catRing = this._nodeCategoryRing(node);
      const strokeW = isFocused ? 1.75 : (isEgo ? 1.45 : 1.3);

      if (node.category === 'memt') {
        // MemT / experience: emerald diamond (#34d399 dark / #059669 light)
        if (dualRing) {
          const d = sr * 1.18;
          const dOuter = d + 3.2;
          ctx.save();
          ctx.globalAlpha *= isFocused ? 0.78 : (isEgo ? 0.58 : 0.45);
          ctx.beginPath();
          ctx.moveTo(sx, sy - dOuter);
          ctx.lineTo(sx + dOuter, sy);
          ctx.lineTo(sx, sy + dOuter);
          ctx.lineTo(sx - dOuter, sy);
          ctx.closePath();
          ctx.strokeStyle = isFocused ? this.palette.hubOuterRingActive : catRing;
          ctx.lineWidth = 0.9;
          ctx.stroke();
          ctx.restore();

          this._drawCalibrationArc(ctx, node, sx, sy, dOuter + 1.4, color, isFocused, isEgo);

          ctx.beginPath();
          ctx.moveTo(sx, sy - d);
          ctx.lineTo(sx + d, sy);
          ctx.lineTo(sx, sy + d);
          ctx.lineTo(sx - d, sy);
          ctx.closePath();
          ctx.fillStyle = fillBg;
          ctx.fill();
          ctx.fillStyle = isActive ? this.palette.memtFillActive : this.palette.memtFill;
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeW;
          ctx.stroke();

          if (this.detailOn) {
            ctx.save();
            ctx.strokeStyle = this.palette.specularArc;
            ctx.lineWidth = 1;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(sx - (d - 1.5) * 0.78, sy - (d - 1.5) * 0.22);
            ctx.lineTo(sx - (d - 1.5) * 0.12, sy - (d - 1.5) * 0.88);
            ctx.stroke();
            ctx.restore();
          }

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy, clamp(sr * 0.34, 1.9, 3.6), 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Standard/leaf MemT node: crisp single filled emerald diamond
          const d = Math.max(4.4, sr * 0.92);
          ctx.beginPath();
          ctx.moveTo(sx, sy - d);
          ctx.lineTo(sx + d, sy);
          ctx.lineTo(sx, sy + d);
          ctx.lineTo(sx - d, sy);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = isEgo ? this.palette.inkPrimary : this.palette.canvas;
          ctx.lineWidth = isEgo ? 1.15 : 1.0;
          ctx.stroke();
        }
      } else if (node.category === 'attention') {
        if (dualRing) {
          const h = sr * 1.2;
          const hOuter = h + 3.0;
          ctx.save();
          ctx.globalAlpha *= isFocused ? 0.72 : 0.44;
          ctx.beginPath();
          ctx.moveTo(sx, sy - hOuter);
          ctx.lineTo(sx + hOuter * 0.92, sy + hOuter * 0.78);
          ctx.lineTo(sx - hOuter * 0.92, sy + hOuter * 0.78);
          ctx.closePath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.9;
          ctx.stroke();
          ctx.restore();

          this._drawCalibrationArc(ctx, node, sx, sy, hOuter + 1.4, color, isFocused, isEgo);

          ctx.beginPath();
          ctx.moveTo(sx, sy - h);
          ctx.lineTo(sx + h * 0.92, sy + h * 0.78);
          ctx.lineTo(sx - h * 0.92, sy + h * 0.78);
          ctx.closePath();
          ctx.fillStyle = fillBg;
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeW;
          ctx.stroke();

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy + h * 0.14, 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const h = Math.max(4.4, sr * 0.92);
          ctx.beginPath();
          ctx.moveTo(sx, sy - h);
          ctx.lineTo(sx + h * 0.92, sy + h * 0.78);
          ctx.lineTo(sx - h * 0.92, sy + h * 0.78);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = this.palette.canvas;
          ctx.lineWidth = 1.0;
          ctx.stroke();
        }
      } else if (node.category === 'connector') {
        // Sources / connector: purple/violet rounded square (#a855f7 dark / #7c3aed light)
        if (dualRing) {
          const s = clamp(sr * 1.9, 13, 18);
          const sOuter = s + 6.4;
          ctx.save();
          ctx.globalAlpha *= isFocused ? 0.78 : (isEgo ? 0.56 : 0.44);
          ctx.beginPath();
          roundRectPath(ctx, sx - sOuter * 0.5, sy - sOuter * 0.5, sOuter, sOuter, 6.2);
          ctx.strokeStyle = isFocused ? this.palette.hubOuterRingActive : catRing;
          ctx.lineWidth = 0.9;
          ctx.stroke();
          ctx.restore();

          this._drawCalibrationArc(ctx, node, sx, sy, s * 0.56 + 4.6, color, isFocused, isEgo);

          ctx.beginPath();
          roundRectPath(ctx, sx - s * 0.5, sy - s * 0.5, s, s, 4.2);
          ctx.fillStyle = fillBg;
          ctx.fill();
          ctx.fillStyle = isActive ? this.palette.connectorFillActive : this.palette.connectorFill;
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = isFocused ? 1.75 : 1.35;
          ctx.stroke();

          if (this.detailOn) {
            const halfIn = s * 0.5 - 1.3;
            ctx.save();
            ctx.strokeStyle = this.palette.specularArc;
            ctx.lineWidth = 1;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(sx - halfIn, sy - halfIn * 0.2);
            ctx.lineTo(sx - halfIn, sy - halfIn + 2.8);
            ctx.quadraticCurveTo(sx - halfIn, sy - halfIn, sx - halfIn + 2.8, sy - halfIn);
            ctx.lineTo(sx + halfIn * 0.15, sy - halfIn);
            ctx.stroke();
            ctx.restore();
          }

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy, clamp(sr * 0.34, 2.2, 3.8), 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Standard/leaf Source node: crisp single filled violet rounded square
          const s = clamp(sr * 1.5, 8.5, 13.5);
          ctx.beginPath();
          roundRectPath(ctx, sx - s * 0.5, sy - s * 0.5, s, s, 3.0);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = isEgo ? this.palette.inkPrimary : this.palette.canvas;
          ctx.lineWidth = isEgo ? 1.15 : 1.0;
          ctx.stroke();
        }
      } else if (dualRing) {
        // Hub-only concentric dual-ring halo (top 12% by degree OR degree >= 12 OR hovered/selected)
        const isSuperHub = node.degree >= 12;
        const outerR = sr + 3.2;

        // 1. Subtle hairline outer orbital ring (+ 4 cardinal ticks on super-hubs)
        ctx.save();
        ctx.strokeStyle = isFocused ? this.palette.hubOuterRingActive : catRing;
        ctx.lineWidth = isFocused ? 1.05 : 0.9;
        ctx.beginPath();
        ctx.arc(sx, sy, outerR, 0, Math.PI * 2);
        if (this.detailOn && isSuperHub) {
          const tickOut = outerR + 2.6;
          for (let t = 0; t < 4; t += 1) {
            const angle = t * (Math.PI * 0.5);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            ctx.moveTo(sx + cos * outerR, sy + sin * outerR);
            ctx.lineTo(sx + cos * tickOut, sy + sin * tickOut);
          }
        }
        ctx.stroke();
        ctx.restore();

        // 1b. Degree-proportional outer calibration arc gauge (40..300 deg at outerR + 1.4px)
        this._drawCalibrationArc(ctx, node, sx, sy, outerR + 1.4, color, isFocused, isEgo);

        // 2. Main precision ring with opaque canvas-toned body + category tint
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fillStyle = fillBg;
        ctx.fill();
        ctx.fillStyle = isFocused ? this.palette.nodeActiveTint : catFill;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeW;
        ctx.stroke();

        // 2b. Upper-left optical lens specular arc catchlight (-145..-45 deg)
        if (this.detailOn && sr >= 4.2) {
          ctx.save();
          ctx.strokeStyle = this.palette.specularArc;
          ctx.lineWidth = 1;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(sx, sy, sr - 1.15, (-145 * Math.PI) / 180, (-45 * Math.PI) / 180);
          ctx.stroke();
          ctx.restore();
        }

        // 3. Crisp semantic inner core
        const coreR = clamp(sr * 0.42, 2.2, 4.2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, coreR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Standard/leaf World (amber) or Concept (blue) node: clean, crisp single filled circle
        const dotR = Math.max(3.3, sr * 0.76);
        ctx.beginPath();
        ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = isEgo ? this.palette.inkPrimary : this.palette.canvas;
        ctx.lineWidth = isEgo ? 1.2 : 1.0;
        ctx.stroke();
      }
    }

    _drawDirectionalChevron(ctx, tipX, tipY, ux, uy, size, color, alpha) {
      const wing = size * 0.56;
      const bx = tipX - ux * size;
      const by = tipY - uy * size;
      const px = -uy * wing;
      const py = ux * wing;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(bx + px, by + py);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(bx - px, by - py);
      ctx.stroke();
      ctx.restore();
    }

    _draw() {
      const w = this.width;
      const h = this.height;
      if (w < 10 || h < 10) return;

      const ctx = this.ctx;
      const dpr = this.dpr;
      const z = this.cam.zoom;

      ctx.save();
      ctx.scale(dpr, dpr);

      // Clear balanced cartographic canvas surface (#050507 dark / #ffffff light)
      ctx.fillStyle = this.palette.canvas;
      ctx.fillRect(0, 0, w, h);

      // Architectural focal field: 24px dot-grid, 144px crosshairs, r=180/360 radar rings, sector labels
      this._drawFocalField(ctx);

      const activeFocusId = this.hoveredId || this.selectedId;
      const effectiveFocusId = activeFocusId || (this.egoBlend > 0.005 ? this._lastFocusId : null);
      const egoSet = effectiveFocusId ? (this.adjacency.get(effectiveFocusId) || new Set()) : null;
      const dimStrength = effectiveFocusId ? this.egoBlend : 0;

      // 1. EDGES (semantic color-blended neural waveguides, then 3-pass optical 1-hop ego conduits)
      const curved = this.detailOn && !this.reducedMotion;
      const activeEdges = [];
      const pendingSockets = [];

      ctx.lineCap = 'round';
      for (let i = 0; i < this.visibleEdges.length; i += 1) {
        const e = this.visibleEdges[i];
        const s = this.worldToScreen(e.source.x, e.source.y);
        const t = this.worldToScreen(e.target.x, e.target.y);

        if (
          (s.x < -80 && t.x < -80) ||
          (s.x > w + 80 && t.x > w + 80) ||
          (s.y < -80 && t.y < -80) ||
          (s.y > h + 80 && t.y > h + 80)
        ) {
          continue;
        }

        const isEgoEdge = Boolean(
          effectiveFocusId && (e.source.id === effectiveFocusId || e.target.id === effectiveFocusId)
        );
        if (isEgoEdge) {
          activeEdges.push({ e, s, t });
          continue;
        }

        const isBackbone = e.source.degree >= 6 && e.target.degree >= 6;
        const baseAlpha = this.palette.isLight
          ? (isBackbone ? 0.20 : 0.15)
          : (isBackbone ? 0.22 : 0.16);
        const alpha = baseAlpha * (1 - dimStrength * 0.84);
        const srcRgb = this._nodeColorRgb(e.source);
        const tgtRgb = this._nodeColorRgb(e.target);
        const len = Math.hypot(t.x - s.x, t.y - s.y) || 1;

        if (srcRgb !== tgtRgb && len > 14) {
          const grad = ctx.createLinearGradient(s.x, s.y, t.x, t.y);
          grad.addColorStop(0, 'rgba(' + srcRgb + ', ' + alpha.toFixed(3) + ')');
          grad.addColorStop(1, 'rgba(' + tgtRgb + ', ' + alpha.toFixed(3) + ')');
          ctx.strokeStyle = grad;
        } else {
          ctx.strokeStyle = 'rgba(' + srcRgb + ', ' + alpha.toFixed(3) + ')';
        }
        ctx.lineWidth = isBackbone ? 1.25 : 0.9;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        if (curved) {
          const cp = this._edgeControlPoint(s.x, s.y, t.x, t.y, e);
          ctx.quadraticCurveTo(cp.x, cp.y, t.x, t.y);
        } else {
          ctx.lineTo(t.x, t.y);
        }
        ctx.stroke();
      }

      // Draw 1-hop ego neighborhood optical conduits (recessed trench + gradient conduit + inner filament + photon comet)
      const pendingPredicates = [];
      const pulseActive = Boolean(
        activeFocusId &&
        this.detailOn &&
        !this.reducedMotion &&
        activeEdges.length > 0 &&
        activeEdges.length <= 28 &&
        dimStrength > 0.2
      );
      const conduitWidth = 2.4 + dimStrength * 1.4;
      const trenchWidth = conduitWidth + 2.8;
      const trenchAlpha = 0.85 * clamp(dimStrength * 1.15, 0.2, 1);

      for (let i = 0; i < activeEdges.length; i += 1) {
        const { e, s, t } = activeEdges[i];
        const originIsSource = e.source.id === effectiveFocusId;
        const fromNode = originIsSource ? e.source : e.target;
        const toNode = originIsSource ? e.target : e.source;
        const fromPt = originIsSource ? s : t;
        const toPt = originIsSource ? t : s;

        const fromRgb = this._nodeColorRgb(fromNode);
        const toRgb = this._nodeColorRgb(toNode);
        const fromColor = this._nodeColor(fromNode);
        const toColor = this._nodeColor(toNode);

        const fromSr = clamp(fromNode.radius * Math.pow(z, 0.58), 3.4, 13.5);
        const toSr = clamp(toNode.radius * Math.pow(z, 0.58), 3.4, 13.5);
        const fromVisR = this._nodeVisualRadius(
          fromNode,
          fromSr,
          fromNode.id === this.selectedId,
          fromNode.id === this.hoveredId
        );
        const toVisR = this._nodeVisualRadius(
          toNode,
          toSr,
          toNode.id === this.selectedId,
          toNode.id === this.hoveredId
        );
        const fromStandoff = Math.max(fromSr + 3.2, fromVisR);
        const toStandoff = Math.max(toSr + 3.2, toVisR);

        const fullCp = curved
          ? this._edgeControlPoint(s.x, s.y, t.x, t.y, e)
          : { x: (fromPt.x + toPt.x) * 0.5, y: (fromPt.y + toPt.y) * 0.5 };

        const sub = trimQuadBezier(
          fromPt.x,
          fromPt.y,
          fullCp.x,
          fullCp.y,
          toPt.x,
          toPt.y,
          fromStandoff,
          toStandoff
        );

        if (!sub) {
          continue;
        }

        const traceConduit = () => {
          ctx.beginPath();
          ctx.moveTo(sub.ax, sub.ay);
          if (curved) {
            ctx.quadraticCurveTo(sub.bx, sub.by, sub.cx, sub.cy);
          } else {
            ctx.lineTo(sub.cx, sub.cy);
          }
        };

        // Pass (a): Canvas-toned recessed crossing trench for layered depth over background edges
        ctx.strokeStyle = 'rgba(' + this.palette.canvasRgb + ', ' + trenchAlpha.toFixed(3) + ')';
        ctx.lineWidth = trenchWidth;
        traceConduit();
        ctx.stroke();

        // Pass (b): Translucent semantic gradient conduit (sourceColor -> targetColor)
        const startAlpha = (this.palette.isLight ? 0.20 : 0.18) + dimStrength * (this.palette.isLight ? 0.54 : 0.58);
        const endAlpha = (this.palette.isLight ? 0.16 : 0.15) + dimStrength * (this.palette.isLight ? 0.46 : 0.50);
        if (sub.arcLen > 6) {
          const conduitGrad = ctx.createLinearGradient(sub.ax, sub.ay, sub.cx, sub.cy);
          conduitGrad.addColorStop(0, 'rgba(' + fromRgb + ', ' + startAlpha.toFixed(3) + ')');
          conduitGrad.addColorStop(1, 'rgba(' + toRgb + ', ' + endAlpha.toFixed(3) + ')');
          ctx.strokeStyle = conduitGrad;
        } else {
          ctx.strokeStyle = 'rgba(' + fromRgb + ', ' + startAlpha.toFixed(3) + ')';
        }
        ctx.lineWidth = conduitWidth;
        traceConduit();
        ctx.stroke();

        // Pass (c): Crisp luminous inner filament core (0.95px with bright white-tinted midpoint)
        const filStartA = 0.25 + dimStrength * 0.65;
        const filMidA = this.palette.isLight ? 0.26 + dimStrength * 0.58 : 0.24 + dimStrength * 0.68;
        const filEndA = 0.22 + dimStrength * 0.58;
        if (sub.arcLen > 6) {
          const filGrad = ctx.createLinearGradient(sub.ax, sub.ay, sub.cx, sub.cy);
          filGrad.addColorStop(0, 'rgba(' + fromRgb + ', ' + filStartA.toFixed(3) + ')');
          filGrad.addColorStop(0.5, 'rgba(248, 251, 255, ' + filMidA.toFixed(3) + ')');
          filGrad.addColorStop(1, 'rgba(' + toRgb + ', ' + filEndA.toFixed(3) + ')');
          ctx.strokeStyle = filGrad;
        } else {
          ctx.strokeStyle = 'rgba(248, 251, 255, ' + filMidA.toFixed(3) + ')';
        }
        ctx.lineWidth = 0.95;
        traceConduit();
        ctx.stroke();

        // Refined directional arrival chevron upstream of neighbor socket pin
        if (this.detailOn && dimStrength > 0.25 && sub.arcLen > 22) {
          const frac = clamp(1 - 9.0 / sub.arcLen, 0.56, 0.88);
          const chevPt = evalQuadPoint(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, frac);
          const chevTan = evalQuadTangent(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, frac);
          const tLen = Math.hypot(chevTan.x, chevTan.y) || 1;
          this._drawDirectionalChevron(
            ctx,
            chevPt.x,
            chevPt.y,
            chevTan.x / tLen,
            chevTan.y / tLen,
            4.6,
            toColor,
            dimStrength * 0.86
          );
        }

        // Hover/selection-activated traveling photon comet + docking flash timing
        let flashProgress = -1;
        if (pulseActive && sub.arcLen > 16) {
          const rawT = (this._pulsePhase * (e.pulseSpeed || 1) + (e.pulseOffset || 0)) % 1.32;
          if (rawT < 1.0) {
            this._drawPhotonComet(ctx, sub, rawT, fromRgb, toRgb, toColor, dimStrength);
          }
          if (rawT >= 0.94 && rawT <= 1.30) {
            flashProgress = clamp((rawT - 0.94) / 0.36, 0, 1);
          }
        }

        // Queue machined circular terminal socket pins for BOTH docking points (drawn cleanly over node rings)
        const socketAlpha = clamp(0.22 + dimStrength * 0.78, 0, 1);
        pendingSockets.push(
          { x: sub.ax, y: sub.ay, color: fromColor, alpha: socketAlpha, flash: -1 },
          { x: sub.cx, y: sub.cy, color: toColor, alpha: socketAlpha, flash: flashProgress }
        );

        if (e.predicate && z >= 0.65 && activeEdges.length <= 14 && dimStrength > 0.35) {
          const midPt = evalQuadPoint(sub.ax, sub.ay, sub.bx, sub.by, sub.cx, sub.cy, 0.5);
          pendingPredicates.push({ text: e.predicate, x: midPt.x, y: midPt.y, alpha: dimStrength * 0.94 });
        }
      }

      // 2. NODES (layered draw order: background dimmed -> ego/cited -> hovered/selected on top)
      const screenNodes = [];
      const layerBg = [];
      const layerMid = [];
      const layerTop = [];

      for (let i = 0; i < this.visibleNodes.length; i += 1) {
        const n = this.visibleNodes[i];
        const pos = this.worldToScreen(n.x, n.y);
        const sr = clamp(n.radius * Math.pow(z, 0.58), 3.4, 13.5);

        if (pos.x < -sr - 40 || pos.x > w + sr + 40 || pos.y < -sr - 40 || pos.y > h + sr + 40) {
          continue;
        }

        const isSelected = n.id === this.selectedId;
        const isHovered = n.id === this.hoveredId;
        const isEgo = Boolean(
          effectiveFocusId && (n.id === effectiveFocusId || (egoSet && egoSet.has(n.id)))
        );
        const isCited = this.citedIds.has(n.id);
        const alpha = effectiveFocusId && !isEgo && !isCited ? 1 - dimStrength * 0.78 : 1;

        const entry = { n, sx: pos.x, sy: pos.y, sr, isSelected, isHovered, isEgo, isCited, alpha };
        screenNodes.push(entry);

        if (isSelected || isHovered) {
          layerTop.push(entry);
        } else if (isEgo || isCited) {
          layerMid.push(entry);
        } else {
          layerBg.push(entry);
        }
      }

      const orderedLayers = [layerBg, layerMid, layerTop];
      for (let l = 0; l < orderedLayers.length; l += 1) {
        const bucket = orderedLayers[l];
        for (let i = 0; i < bucket.length; i += 1) {
          const item = bucket[i];
          const color = this._nodeColor(item.n);
          ctx.save();
          ctx.globalAlpha = item.alpha;

          // Geometry-matched outer focus halos for cited, hovered, and selected nodes
          if (item.isCited) {
            this._drawFocusHalo(ctx, item.n, item.sx, item.sy, item.sr, this.palette.teal, 1.4, 6.0);
          }

          if (item.isSelected) {
            if (this.detailOn) {
              this._drawFocusHalo(
                ctx,
                item.n,
                item.sx,
                item.sy,
                item.sr,
                this.palette.focusHaloOuter,
                0.9,
                8.8,
                true
              );
            }
            this._drawFocusHalo(
              ctx,
              item.n,
              item.sx,
              item.sy,
              item.sr,
              this.palette.focusHalo,
              1.65,
              5.4
            );
          } else if (item.isHovered) {
            if (this.detailOn) {
              this._drawFocusHalo(
                ctx,
                item.n,
                item.sx,
                item.sy,
                item.sr,
                this.palette.focusHaloOuter,
                0.8,
                8.0
              );
            }
            this._drawFocusHalo(
              ctx,
              item.n,
              item.sx,
              item.sy,
              item.sr,
              this.palette.hoverHalo,
              1.25,
              5.0
            );
          }

          this._drawShape(ctx, item.n, item.sx, item.sy, item.sr, color, item);
          ctx.restore();
        }
      }

      // 2b. MACHINED TERMINAL SOCKET PINS & NEIGHBOR DOCKING FLASHES ON ACTIVE EGO CONDUITS
      if (pendingSockets.length > 0) {
        for (let i = 0; i < pendingSockets.length; i += 1) {
          const sock = pendingSockets[i];
          this._drawTerminalSocket(ctx, sock.x, sock.y, sock.color, sock.alpha, sock.flash);
        }
      }

      // 3. DECLUTTERED HIGH-SIGNAL LABEL PILLS WITH STRICT SCREEN-SPACE COLLISION AVOIDANCE
      const isCleanLabel = (lbl) => {
        if (!lbl || lbl.length < 2) return false;
        if (lbl.length > 34) return false;
        if (/^[a-f0-9]{10,}/i.test(lbl)) return false;
        return true;
      };

      screenNodes.sort((a, b) => {
        const pa =
          (a.isSelected ? 3000 : 0) +
          (a.isHovered ? 2400 : 0) +
          (a.isCited ? 1400 : 0) +
          (a.isEgo ? 800 : 0) +
          (a.n.category === 'connector' ? 340 : 0) +
          (a.n.category === 'memt' ? 190 : 0) +
          (isCleanLabel(a.n.label) ? 160 : -120) +
          a.n.degree * 16;
        const pb =
          (b.isSelected ? 3000 : 0) +
          (b.isHovered ? 2400 : 0) +
          (b.isCited ? 1400 : 0) +
          (b.isEgo ? 800 : 0) +
          (b.n.category === 'connector' ? 340 : 0) +
          (b.n.category === 'memt' ? 190 : 0) +
          (isCleanLabel(b.n.label) ? 160 : -120) +
          b.n.degree * 16;
        return pb - pa;
      });

      // Register EVERY visible node's screen-space circle (r + 5px padding) as a HARD obstacle
      // BEFORE placing any label pill so no label pill ever overlaps a neighboring node.
      const nodeObstacles = [];
      for (let i = 0; i < screenNodes.length; i += 1) {
        const item = screenNodes[i];
        const visualR = this._nodeVisualRadius(item.n, item.sr, item.isSelected, item.isHovered);
        nodeObstacles.push({
          id: item.n.id,
          x: item.sx,
          y: item.sy,
          r: visualR + 5,
          visualR,
          critical: item.isSelected || item.isHovered,
        });
      }

      const placedBoxes = [];
      const sansFont = this.palette.fontSans;
      const maxLabels = z > 1.45 ? 44 : (z > 0.95 ? 24 : 16);
      let drawnLabels = 0;
      const viewPad = 8;

      for (let i = 0; i < screenNodes.length && drawnLabels < maxLabels; i += 1) {
        const item = screenNodes[i];
        const isPrimaryFocus = item.isSelected || item.isHovered;
        const mustShow = isPrimaryFocus || item.isEgo || item.isCited;
        const worthy =
          item.n.category === 'connector' ||
          (isCleanLabel(item.n.label) && (item.n.degree >= 5 || item.n.category === 'memt' || z >= 1.25));
        if (!mustShow && !worthy) continue;

        // Skip heavily dimmed non-ego labels while focused on an ego neighborhood
        if (effectiveFocusId && !mustShow && dimStrength > 0.65) continue;

        const fontSize = isPrimaryFocus ? 11.5 : 11;
        const fontWeight = isPrimaryFocus || item.n.category === 'connector' || item.n.degree >= 6 ? '500 ' : '400 ';
        ctx.font = fontWeight + fontSize + 'px ' + sansFont;

        const rawText = item.n.label;
        const text = rawText.length > 26 ? rawText.slice(0, 25) + '...' : rawText;
        const tw = ctx.measureText(text).width;

        const padX = 7;
        const pillW = Math.ceil(tw + padX * 2);
        const pillH = Math.round(fontSize + 8);
        const ownerEdgeR = this._nodeVisualRadius(item.n, item.sr, item.isSelected, item.isHovered);
        const nearGap = ownerEdgeR + (isPrimaryFocus ? 10 : 7);
        const farGap = ownerEdgeR + (isPrimaryFocus ? 20 : 17);
        const diagGap = ownerEdgeR + 8;

        // 12 clean placement slots: 4 close cardinal, 4 diagonal, 4 extended leader-line cardinal
        const candidates = [
          { cx: item.sx, cy: item.sy + nearGap + pillH * 0.5 },
          { cx: item.sx, cy: item.sy - nearGap - pillH * 0.5 },
          { cx: item.sx + nearGap + pillW * 0.5 + 2, cy: item.sy },
          { cx: item.sx - nearGap - pillW * 0.5 - 2, cy: item.sy },
          { cx: item.sx + diagGap + pillW * 0.36, cy: item.sy - diagGap - pillH * 0.5 },
          { cx: item.sx - diagGap - pillW * 0.36, cy: item.sy - diagGap - pillH * 0.5 },
          { cx: item.sx + diagGap + pillW * 0.36, cy: item.sy + diagGap + pillH * 0.5 },
          { cx: item.sx - diagGap - pillW * 0.36, cy: item.sy + diagGap + pillH * 0.5 },
          { cx: item.sx, cy: item.sy + farGap + pillH * 0.5 },
          { cx: item.sx, cy: item.sy - farGap - pillH * 0.5 },
          { cx: item.sx + farGap + pillW * 0.5 + 2, cy: item.sy },
          { cx: item.sx - farGap - pillW * 0.5 - 2, cy: item.sy },
        ];

        let chosenBox = null;
        let focusBestFallback = null;
        let focusBestPenalty = Infinity;

        for (let cIdx = 0; cIdx < candidates.length; cIdx += 1) {
          let x1 = Math.round(candidates[cIdx].cx - pillW * 0.5);
          let y1 = Math.round(candidates[cIdx].cy - pillH * 0.5);

          if (isPrimaryFocus) {
            x1 = clamp(x1, viewPad, Math.max(viewPad, w - pillW - viewPad));
            y1 = clamp(y1, viewPad, Math.max(viewPad, h - pillH - viewPad));
          }

          const box = { x1, y1, x2: x1 + pillW, y2: y1 + pillH };

          // Keep non-focus labels cleanly inside the viewport
          if (
            !isPrimaryFocus &&
            (box.x1 < viewPad || box.x2 > w - viewPad || box.y1 < viewPad || box.y2 > h - viewPad)
          ) {
            continue;
          }

          // Strict zero-overlap check against all already-placed label pills
          let hitsPlaced = false;
          for (let k = 0; k < placedBoxes.length; k += 1) {
            if (boxesOverlap(box, placedBoxes[k], 6, 5)) {
              hitsPlaced = true;
              break;
            }
          }
          if (hitsPlaced) continue;

          // Hard obstacle check against EVERY visible node circle (r + 5px padding)
          let nodeHitCount = 0;
          let hitsOwner = false;
          for (let k = 0; k < nodeObstacles.length; k += 1) {
            const obs = nodeObstacles[k];
            const checkR = obs.id === item.n.id ? obs.visualR + 3 : obs.r;
            if (boxHitsCircle(box, obs.x, obs.y, checkR)) {
              nodeHitCount += 1;
              if (obs.id === item.n.id) hitsOwner = true;
              if (!isPrimaryFocus) break;
            }
          }

          if (nodeHitCount === 0) {
            chosenBox = box;
            break;
          }

          if (isPrimaryFocus && !hitsOwner && nodeHitCount < focusBestPenalty) {
            focusBestPenalty = nodeHitCount;
            focusBestFallback = box;
          }
        }

        // Non-focus labels strictly refuse any slot that overlaps a visible node obstacle
        const finalBox = chosenBox || (isPrimaryFocus ? focusBestFallback : null);
        if (!finalBox) continue;

        placedBoxes.push(finalBox);
        drawnLabels += 1;

        const bx = finalBox.x1 + 0.5;
        const by = finalBox.y1 + 0.5;
        const bw = finalBox.x2 - finalBox.x1 - 1;
        const bh = finalBox.y2 - finalBox.y1 - 1;
        const textCenterX = finalBox.x1 + pillW * 0.5;
        const textCenterY = finalBox.y1 + pillH * 0.5 + 0.5;

        ctx.save();
        const pillAlpha = isPrimaryFocus
          ? 0.99
          : (item.isEgo || item.isCited ? 0.96 : item.alpha * 0.92);

        // Crisp 1px leader tick connecting each placed label pill to its owning node edge
        const anchorX = clamp(item.sx, finalBox.x1, finalBox.x2);
        const anchorY = clamp(item.sy, finalBox.y1, finalBox.y2);
        const ldx = anchorX - item.sx;
        const ldy = anchorY - item.sy;
        const lDist = Math.hypot(ldx, ldy);
        const startOffset = ownerEdgeR + 1.5;
        if (lDist > startOffset + 1.5) {
          const sxTick = item.sx + (ldx / lDist) * startOffset;
          const syTick = item.sy + (ldy / lDist) * startOffset;
          ctx.globalAlpha = pillAlpha * (isPrimaryFocus ? 0.95 : 0.85);
          ctx.strokeStyle = isPrimaryFocus
            ? this.palette.leaderTickActive
            : (item.isEgo ? this.palette.pillBorderEgo : this.palette.leaderTick);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sxTick, syTick);
          ctx.lineTo(anchorX, anchorY);
          ctx.stroke();
        }

        ctx.globalAlpha = pillAlpha;
        ctx.fillStyle = isPrimaryFocus ? this.palette.pillBgActive : this.palette.pillBg;
        ctx.beginPath();
        roundRectPath(ctx, bx, by, bw, bh, 4.5);
        ctx.fill();

        ctx.strokeStyle = isPrimaryFocus
          ? this.palette.pillBorderActive
          : (item.isEgo ? this.palette.pillBorderEgo : this.palette.pillBorder);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle =
          isPrimaryFocus || item.n.category === 'connector' || item.isEgo
            ? this.palette.inkPrimary
            : this.palette.inkSecondary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, textCenterX, textCenterY);
        ctx.restore();
      }

      // 4. ACTIVE EGO EDGE PREDICATE PILLS (collision-checked against node labels, nodes & each other)
      if (pendingPredicates.length > 0) {
        ctx.font = '400 11px ' + this.palette.fontMono;
        for (let i = 0; i < pendingPredicates.length; i += 1) {
          const p = pendingPredicates[i];
          const text = p.text.length > 20 ? p.text.slice(0, 19) + '.' : p.text;
          const tw = ctx.measureText(text).width;
          const pw = Math.ceil(tw + 10);
          const ph = 16;
          const x1 = Math.round(p.x - pw * 0.5);
          const y1 = Math.round(p.y - ph * 0.5);
          const box = { x1, y1, x2: x1 + pw, y2: y1 + ph };

          if (box.x1 < viewPad || box.x2 > w - viewPad || box.y1 < viewPad || box.y2 > h - viewPad) {
            continue;
          }

          let collides = false;
          for (let k = 0; k < placedBoxes.length; k += 1) {
            if (boxesOverlap(box, placedBoxes[k], 4, 4)) {
              collides = true;
              break;
            }
          }
          if (!collides) {
            for (let k = 0; k < nodeObstacles.length; k += 1) {
              const obs = nodeObstacles[k];
              if (boxHitsCircle(box, obs.x, obs.y, obs.r)) {
                collides = true;
                break;
              }
            }
          }
          if (collides) continue;

          placedBoxes.push(box);

          ctx.save();
          ctx.globalAlpha = p.alpha;
          ctx.fillStyle = this.palette.pillBg;
          ctx.strokeStyle = this.palette.pillBorderEgo;
          ctx.lineWidth = 1;
          ctx.beginPath();
          roundRectPath(ctx, box.x1 + 0.5, box.y1 + 0.5, pw - 1, ph - 1, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = this.palette.inkSecondary;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, box.x1 + pw * 0.5, box.y1 + ph * 0.5 + 0.5);
          ctx.restore();
        }
      }

      ctx.restore();
    }
  }

  global.KizukiGraph = KizukiGraph;
})(window);
