/* ==========================================================================
   KIZUKI MIND OS - INSTRUMENT HUD LAYER (window.KizukiInstrument)
   Linear x Teenage Engineering tactile hardware command console:
   1. 0ms Keyboard Shortcut Atlas Modal ('?' or #btn-kbd-atlas)
   2. Live 'G' Workspace Chord Engine (1.4s bottom-right indicator pill)
   3. Live Ambient Europe/London Clock & Engine Telemetry Pill (30s interval)
   4. Machined 3D Specular Rim Tilt (single passive listener, <= 2.2deg)
   5. Sound Toggle Button Binding synced with window.KizukiSound
   Strict invariants: zero em-dashes, zero XSS, zero idle RAF loops,
   zero interference with text inputs or open modals.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiInstrument = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (globalRoot) {
  'use strict';

  const STYLE_TAG_ID = 'kizuki-instrument-hud-styles';
  const ATLAS_BACKDROP_ID = 'kbd-atlas-backdrop';
  const ATLAS_MODAL_ID = 'kbd-atlas-modal';
  const CHORD_PILL_ID = 'kbd-chord-pill';
  const DEFAULT_TILT_SELECTOR = '.profile-banner, .taste-question-card, .codex-hero-card';
  const DEFAULT_ATLAS_TRIGGER_SELECTOR = '#btn-kbd-atlas, [data-kbd-atlas-trigger]';
  const CHORD_TIMEOUT_MS = 1400;
  const CLOCK_INTERVAL_MS = 30000;
  const MAX_TILT_DEG = 2.2;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const CHORD_ORDER = [
    { key: 't', view: 'today', label: 'Today', fullLabel: 'Today' },
    { key: 'b', view: 'board', label: 'Board', fullLabel: 'Agent Board' },
    { key: 'p', view: 'people', label: 'People', fullLabel: 'People' },
    { key: 'r', view: 'replay', label: 'Replay', fullLabel: 'Replay' },
    { key: 'c', view: 'codex', label: 'Codex', fullLabel: 'Codex' },
    { key: 'k', view: 'taste', label: 'Taste', fullLabel: 'Taste Studio' },
    { key: 'v', view: 'vault', label: 'Vault', fullLabel: 'Vault' },
    { key: 'g', view: 'graph', label: 'Graph', fullLabel: 'Graph' },
    { key: 's', view: 'stream', label: 'Stream', fullLabel: 'Stream' },
    { key: 'a', view: 'atlas', label: 'Atlas', fullLabel: 'Atlas' },
    { key: 'm', view: 'memt', label: 'MemT', fullLabel: 'MemT' },
  ];

  const CHORD_MAP = Object.create(null);
  for (let i = 0; i < CHORD_ORDER.length; i += 1) {
    CHORD_MAP[CHORD_ORDER[i].key] = CHORD_ORDER[i];
  }

  const SHORTCUT_COLUMNS = [
    {
      id: 'workspace-chords',
      title: 'Workspace Chords',
      subtitle: 'G + key',
      items: CHORD_ORDER.map(function (entry) {
        return {
          keys: ['G', entry.key.toUpperCase()],
          sep: ' ',
          label: entry.fullLabel,
          view: entry.view,
        };
      }),
    },
    {
      id: 'global-instruments',
      title: 'Global Instruments',
      subtitle: 'Anywhere',
      items: [
        { keys: ['\u2318K'], label: 'Omni-Search' },
        { keys: ['\u2318J'], label: 'Multi-Turn Mind Chat' },
        { keys: ['?'], label: 'Shortcut Atlas' },
        { keys: ['Esc'], label: 'Close / Blur' },
      ],
    },
    {
      id: 'today-triage',
      title: 'Today & Triage',
      subtitle: 'Workbench',
      items: [
        { keys: ['J', 'K'], sep: '/', label: 'Next / Prev item' },
        { keys: ['A'], label: 'Quick Add Action' },
        { keys: ['D'], label: 'Focus Draft Composer' },
        { keys: ['X'], label: 'Toggle Action' },
      ],
    },
    {
      id: 'agent-board',
      title: 'Agent Board',
      subtitle: 'Board & Flow Deck',
      items: [
        { keys: ['J', 'K'], sep: '/', label: 'Step Thread' },
        { keys: ['A', 'R', 'D'], sep: '/', label: 'Approve / Revise / Defer Gate' },
        { keys: ['1-4'], label: 'Stage Tabs' },
        { keys: ['/', '[['], sep: '\u00B7', label: 'Slash / Context' },
        { keys: ['B'], label: 'G4 Brief' },
      ],
    },
    {
      id: 'taste-replay',
      title: 'Taste & Replay',
      subtitle: 'Studio & Map',
      items: [
        { keys: ['1', '2', '3', '4'], sep: ' ', label: 'Pick Option' },
        { keys: ['S'], label: 'Skip' },
        { keys: ['U'], label: 'Undo' },
        { keys: ['Space'], label: 'Play / Pause Year' },
        { keys: ['\u2190', '\u2192'], sep: '/', label: 'Step Day' },
      ],
    },
  ];

  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock']);

  // Runtime controller state
  let customWin = null;
  let customDoc = null;
  let initialized = false;
  let onSwitchViewCb = null;
  let onAtlasOpenCb = null;
  let onAtlasCloseCb = null;
  let atlasTriggerSelector = DEFAULT_ATLAS_TRIGGER_SELECTOR;

  let atlasOpen = false;
  let atlasReturnFocusEl = null;

  let chordArmed = false;
  let chordTimer = null;

  let boundKeydown = null;
  let boundClick = null;
  let boundBlur = null;

  // Ambient clock controllers
  const clockControllers = new Set();
  let latestEngineStatus = 'G4 \u00B7 5 Gardeners';

  // Sound toggle controllers
  const soundControllers = new Set();

  // Tactile tilt state (single passive delegated pointer listener)
  let tiltBound = false;
  let tiltSelectors = [];
  let tiltMaxDeg = MAX_TILT_DEG;
  let tiltActiveCard = null;
  let tiltPendingCard = null;
  let tiltPendingX = 0;
  let tiltPendingY = 0;
  let tiltPendingRaf = null;
  let boundTiltMove = null;
  let boundTiltOut = null;
  let boundTiltBlur = null;

  // =========================================================================
  // ENVIRONMENT & GUARD HELPERS
  // =========================================================================

  function getWin() {
    if (customWin) return customWin;
    if (typeof window !== 'undefined') return window;
    if (globalRoot && globalRoot.window) return globalRoot.window;
    return null;
  }

  function getDoc() {
    if (customDoc) return customDoc;
    if (typeof document !== 'undefined') return document;
    const w = getWin();
    return w && w.document ? w.document : null;
  }

  function getSoundApi() {
    const w = getWin();
    if (w && w.KizukiSound) return w.KizukiSound;
    if (globalRoot && globalRoot.KizukiSound) return globalRoot.KizukiSound;
    return null;
  }

  function playSoundClick() {
    const sound = getSoundApi();
    if (sound && typeof sound.click === 'function') {
      try {
        sound.click();
      } catch (_) {
        // Audio context may be locked before gesture
      }
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

  function prefersReducedMotion() {
    const w = getWin();
    try {
      if (w && w.KizukiMotion && typeof w.KizukiMotion.prefersReducedMotion === 'function') {
        return Boolean(w.KizukiMotion.prefersReducedMotion());
      }
    } catch (_) {
      // Fallback to matchMedia
    }
    if (w && typeof w.matchMedia === 'function') {
      try {
        return Boolean(w.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function supportsFineHoverPointer() {
    const w = getWin();
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      return Boolean(w.matchMedia('(hover: hover) and (pointer: fine)').matches);
    } catch (_) {
      return false;
    }
  }

  function isDetailOn() {
    const doc = getDoc();
    if (!doc || !doc.documentElement || typeof doc.documentElement.getAttribute !== 'function') {
      return true;
    }
    return doc.documentElement.getAttribute('data-detail') === 'on';
  }

  function clamp(val, min, max) {
    if (val < min) return min;
    if (val > max) return max;
    return val;
  }

  function isEditableNode(node) {
    if (!node || typeof node !== 'object') return false;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable === true) return true;
    if (typeof node.getAttribute === 'function') {
      const ce = node.getAttribute('contenteditable');
      if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
      const role = node.getAttribute('role');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    }
    if (typeof node.closest === 'function') {
      try {
        if (node.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')) {
          return true;
        }
      } catch (_) {
        // Ignore selector errors on synthetic nodes
      }
    }
    return false;
  }

  function isEditableContext(target) {
    const doc = getDoc();
    const active = doc ? doc.activeElement : null;
    return isEditableNode(target) || isEditableNode(active);
  }

  function isElementVisible(node) {
    if (!node) return false;
    if (node.hidden === true) return false;
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return false;
    if (typeof node.closest === 'function') {
      try {
        if (node.closest('[hidden]')) return false;
      } catch (_) {
        // Ignore
      }
    }
    const w = getWin();
    if (w && typeof w.getComputedStyle === 'function') {
      try {
        const cs = w.getComputedStyle(node);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      } catch (_) {
        // Ignore
      }
    }
    return true;
  }

  function isBlockingModalOpen() {
    const doc = getDoc();
    if (!doc) return false;

    const selectors = [
      '#cmdk-backdrop',
      '#chat-modal-backdrop',
      '#chat-modal',
      '#kbw-dispatch-modal-backdrop',
      '#replay-import-backdrop',
      '.codex-modal',
      '.codex-modal-backdrop',
      '[data-codex-modal-backdrop]',
      '[role="dialog"][aria-modal="true"]',
    ];

    if (typeof doc.querySelectorAll === 'function') {
      for (let i = 0; i < selectors.length; i += 1) {
        let matches = null;
        try {
          matches = doc.querySelectorAll(selectors[i]);
        } catch (_) {
          matches = null;
        }
        if (!matches || !matches.length) continue;
        for (let j = 0; j < matches.length; j += 1) {
          const el = matches[j];
          if (!el) continue;
          if (el.id === ATLAS_MODAL_ID || el.id === ATLAS_BACKDROP_ID) continue;
          if (typeof el.closest === 'function') {
            try {
              if (el.closest('#' + ATLAS_BACKDROP_ID)) continue;
            } catch (_) {
              // Ignore
            }
          }
          if (isElementVisible(el)) return true;
        }
      }
      return false;
    }

    if (typeof doc.querySelector === 'function') {
      for (let i = 0; i < selectors.length; i += 1) {
        let el = null;
        try {
          el = doc.querySelector(selectors[i]);
        } catch (_) {
          el = null;
        }
        if (!el || el.id === ATLAS_MODAL_ID || el.id === ATLAS_BACKDROP_ID) continue;
        if (isElementVisible(el)) return true;
      }
    }

    return false;
  }

  // =========================================================================
  // SCOPED STYLES INJECTION (DARK + LIGHT + MOBILE + DETAIL + REDUCED MOTION)
  // =========================================================================

  function ensureStyles() {
    const doc = getDoc();
    if (!doc || !doc.head || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
      return;
    }
    if (doc.getElementById(STYLE_TAG_ID)) return;

    const style = doc.createElement('style');
    style.id = STYLE_TAG_ID;
    style.textContent = [
      /* 1. 0ms Instant Keyboard Shortcut Atlas Modal */
      '#' + ATLAS_BACKDROP_ID + ' {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 1400;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 20px;',
      '  background: var(--scrim-bg, rgba(0, 0, 0, 0.72));',
      '  backdrop-filter: blur(8px);',
      '  -webkit-backdrop-filter: blur(8px);',
      '}',
      '#' + ATLAS_BACKDROP_ID + '[hidden] {',
      '  display: none !important;',
      '}',
      '#' + ATLAS_MODAL_ID + ' {',
      '  width: 100%;',
      '  max-width: 1140px;',
      '  max-height: min(86vh, 680px);',
      '  display: flex;',
      '  flex-direction: column;',
      '  overflow: hidden;',
      '  border-radius: var(--radius-lg, 12px);',
      '  background: var(--surface-overlay, #111111);',
      '  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.16));',
      '  box-shadow: var(--shadow-modal, 0 0 0 1px rgba(255, 255, 255, 0.12), 0 24px 64px rgba(0, 0, 0, 0.85));',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: var(--font-sans, system-ui, sans-serif);',
      '}',
      '.kbd-atlas-head {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 12px;',
      '  padding: 14px 18px;',
      '  border-bottom: 1px solid var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  background: var(--surface-raised, #0a0a0a);',
      '}',
      '.kbd-atlas-title-group {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  min-width: 0;',
      '}',
      '.kbd-atlas-title {',
      '  margin: 0;',
      '  font-size: var(--t-base, 13px);',
      '  font-weight: 600;',
      '  letter-spacing: -0.01em;',
      '  color: var(--ink-primary, #ededed);',
      '}',
      '.kbd-atlas-badge {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  padding: 2px 7px;',
      '  border-radius: var(--radius-xs, 4px);',
      '  border: 1px solid var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  background: var(--surface-inset, #0d0d0f);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: var(--t-xs, 11px);',
      '  font-weight: 500;',
      '  letter-spacing: 0.04em;',
      '  text-transform: uppercase;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '}',
      '.kbd-atlas-close {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 28px;',
      '  height: 28px;',
      '  border-radius: var(--radius-sm, 6px);',
      '  border: 1px solid transparent;',
      '  background: transparent;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  cursor: pointer;',
      '  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;',
      '}',
      '.kbd-atlas-close:hover {',
      '  background: var(--btn-ghost-hover, rgba(255, 255, 255, 0.06));',
      '  border-color: var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  color: var(--ink-primary, #ededed);',
      '}',
      '.kbd-atlas-close:focus-visible {',
      '  outline: 2px solid var(--border-focus, #3291ff);',
      '  outline-offset: 1px;',
      '}',
      '.kbd-atlas-grid {',
      '  display: grid;',
      '  grid-template-columns: 1.18fr 1.08fr 0.96fr 1.02fr 1.04fr;',
      '  gap: 0;',
      '  padding: 0;',
      '  overflow-y: auto;',
      '}',
      '.kbd-atlas-col {',
      '  padding: 14px;',
      '  border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.055));',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 10px;',
      '  min-width: 0;',
      '}',
      '.kbd-atlas-col:last-child {',
      '  border-right: none;',
      '}',
      '.kbd-atlas-col-head {',
      '  display: flex;',
      '  align-items: baseline;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding-bottom: 8px;',
      '  border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.055));',
      '  white-space: nowrap;',
      '  flex-wrap: nowrap;',
      '}',
      '.kbd-atlas-col-title {',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  letter-spacing: 0.04em;',
      '  text-transform: uppercase;',
      '  color: var(--ink-primary, #ededed);',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.kbd-atlas-col-sub {',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 10px;',
      '  color: var(--ink-muted, #737373);',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.kbd-atlas-list {',
      '  list-style: none;',
      '  margin: 0;',
      '  padding: 0;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '}',
      '.kbd-atlas-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding: 5px 6px;',
      '  border-radius: var(--radius-sm, 6px);',
      '  font-size: 12px;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '}',
      '.kbd-atlas-row-btn {',
      '  width: 100%;',
      '  border: 0;',
      '  background: transparent;',
      '  text-align: left;',
      '  font: inherit;',
      '  color: inherit;',
      '  cursor: pointer;',
      '  transition: background-color 120ms ease, color 120ms ease;',
      '}',
      '.kbd-atlas-row-btn:hover {',
      '  background: var(--btn-ghost-hover, rgba(255, 255, 255, 0.06));',
      '  color: var(--ink-primary, #ededed);',
      '}',
      '.kbd-atlas-row-btn:focus-visible {',
      '  outline: 2px solid var(--border-focus, #3291ff);',
      '  outline-offset: -1px;',
      '}',
      '.kbd-atlas-label {',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '.kbd-atlas-keys {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 3px;',
      '  flex-shrink: 0;',
      '}',
      '.kbd-atlas-sep {',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 10px;',
      '  color: var(--ink-muted, #737373);',
      '  padding: 0 1px;',
      '}',
      '.kbd-keycap {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  min-width: 20px;',
      '  height: 20px;',
      '  padding: 0 5px;',
      '  border-radius: 4px;',
      '  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.16));',
      '  background: var(--surface-inset, #0d0d0f);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 1px 0 rgba(0, 0, 0, 0.45);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 10.5px;',
      '  font-weight: 500;',
      '  line-height: 1;',
      '  color: var(--ink-primary, #ededed);',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '.kbd-atlas-foot {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 12px;',
      '  padding: 10px 18px;',
      '  border-top: 1px solid var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  background: var(--surface-raised, #0a0a0a);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 11px;',
      '  color: var(--ink-muted, #737373);',
      '}',
      '.kbd-atlas-foot-group {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '}',
      /* 2. Whisper-Compact Bottom-Right G Chord Pill */
      '#' + CHORD_PILL_ID + ' {',
      '  position: fixed;',
      '  right: 16px;',
      '  bottom: 16px;',
      '  z-index: 1350;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 6px;',
      '  max-width: min(calc(100vw - 32px), 780px);',
      '  padding: 7px 11px;',
      '  border-radius: var(--radius-md, 8px);',
      '  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.18));',
      '  background: var(--surface-overlay, #111111);',
      '  box-shadow: var(--shadow-float, 0 8px 24px rgba(0, 0, 0, 0.72));',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 11px;',
      '  line-height: 1.3;',
      '  pointer-events: none;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '#' + CHORD_PILL_ID + '[hidden] {',
      '  display: none !important;',
      '}',
      '.kbd-chord-lead {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  color: var(--ink-primary, #ededed);',
      '  font-weight: 500;',
      '}',
      '.kbd-chord-lead .kbd-keycap {',
      '  border-color: var(--tint-amber-border, rgba(245, 166, 35, 0.35));',
      '  background: var(--tint-amber-bg, rgba(245, 166, 35, 0.12));',
      '  color: var(--accent-amber, #f5a623);',
      '}',
      '.kbd-chord-list {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 4px 8px;',
      '}',
      '.kbd-chord-item {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  white-space: nowrap;',
      '}',
      '.kbd-chord-item-key {',
      '  color: var(--ink-primary, #ededed);',
      '  font-weight: 600;',
      '}',
      '.kbd-chord-dot {',
      '  color: var(--ink-disabled, #525252);',
      '}',
      /* 3. Ambient London Clock & Telemetry Pill */
      '.instrument-ambient-pill {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 7px;',
      '  min-width: 0;',
      '  max-width: 100%;',
      '  padding: 3px 8px;',
      '  border-radius: var(--radius-sm, 6px);',
      '  border: 1px solid var(--border-hairline, rgba(255, 255, 255, 0.09));',
      '  background: var(--surface-inset, #0d0d0f);',
      '  font-family: var(--font-mono, monospace);',
      '  font-size: 10.5px;',
      '  line-height: 1.3;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-variant-numeric: tabular-nums;',
      '  white-space: nowrap;',
      '}',
      '.instrument-clock-dot {',
      '  width: 5px;',
      '  height: 5px;',
      '  border-radius: 9999px;',
      '  background: var(--accent-green, #46a758);',
      '  flex-shrink: 0;',
      '}',
      '.instrument-clock-time {',
      '  color: var(--ink-primary, #ededed);',
      '  font-weight: 500;',
      '  letter-spacing: 0.02em;',
      '}',
      '.instrument-clock-sep {',
      '  color: var(--ink-disabled, #525252);',
      '}',
      '.instrument-clock-engine {',
      '  color: var(--ink-muted, #737373);',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      /* 4. Sound Toggle Button States */
      '.instrument-sound-btn {',
      '  position: relative;',
      '}',
      '.instrument-sound-btn[data-sound-state="on"] {',
      '  color: var(--ink-primary, #ededed);',
      '}',
      '.instrument-sound-btn[data-sound-state="off"] {',
      '  color: var(--ink-muted, #737373);',
      '}',
      '.instrument-sound-btn svg {',
      '  display: block;',
      '  pointer-events: none;',
      '}',
      /* 5. Machined 3D Specular Rim Tilt (strictly fine hover + detail=on + motion ok) */
      '@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {',
      '  html[data-detail="on"] .profile-banner,',
      '  html[data-detail="on"] .taste-question-card,',
      '  html[data-detail="on"] .codex-hero-card,',
      '  html[data-detail="on"] [data-tactile-tilt="bound"] {',
      '    transform: perspective(960px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg));',
      '    transform-style: preserve-3d;',
      '    transition: transform 360ms cubic-bezier(0.23, 1, 0.32, 1), border-color 180ms cubic-bezier(0.23, 1, 0.32, 1);',
      '  }',
      '  html[data-detail="on"] .profile-banner[data-tilt-active="on"],',
      '  html[data-detail="on"] .taste-question-card[data-tilt-active="on"],',
      '  html[data-detail="on"] .codex-hero-card[data-tilt-active="on"],',
      '  html[data-detail="on"] [data-tactile-tilt="bound"][data-tilt-active="on"] {',
      '    transition: transform 90ms cubic-bezier(0.23, 1, 0.32, 1), border-color 180ms cubic-bezier(0.23, 1, 0.32, 1);',
      '  }',
      '  html[data-detail="on"] .profile-banner::before,',
      '  html[data-detail="on"] .taste-question-card::before,',
      '  html[data-detail="on"] .codex-hero-card::before,',
      '  html[data-detail="on"] [data-tactile-tilt="bound"]::before {',
      '    content: "";',
      '    position: absolute;',
      '    inset: 0;',
      '    border-radius: inherit;',
      '    padding: 1px;',
      '    pointer-events: none;',
      '    z-index: 2;',
      '    opacity: var(--rim-opacity, 0);',
      '    background: conic-gradient(',
      '      from var(--rim-angle, 135deg) at 50% 50%,',
      '      rgba(255, 255, 255, 0.30) 0deg,',
      '      rgba(255, 255, 255, 0.08) 52deg,',
      '      rgba(255, 255, 255, 0.0) 130deg,',
      '      rgba(255, 255, 255, 0.04) 245deg,',
      '      rgba(255, 255, 255, 0.30) 360deg',
      '    );',
      '    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);',
      '    -webkit-mask-composite: xor;',
      '    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);',
      '    mask-composite: exclude;',
      '    transition: opacity 220ms cubic-bezier(0.23, 1, 0.32, 1);',
      '  }',
      '  html[data-theme="light"][data-detail="on"] .profile-banner::before,',
      '  html[data-theme="light"][data-detail="on"] .taste-question-card::before,',
      '  html[data-theme="light"][data-detail="on"] .codex-hero-card::before,',
      '  html[data-theme="light"][data-detail="on"] [data-tactile-tilt="bound"]::before {',
      '    background: conic-gradient(',
      '      from var(--rim-angle, 135deg) at 50% 50%,',
      '      rgba(0, 0, 0, 0.22) 0deg,',
      '      rgba(0, 0, 0, 0.06) 52deg,',
      '      rgba(0, 0, 0, 0.0) 130deg,',
      '      rgba(0, 0, 0, 0.03) 245deg,',
      '      rgba(0, 0, 0, 0.22) 360deg',
      '    );',
      '  }',
      '}',
      'html[data-detail="off"] .profile-banner::before,',
      'html[data-detail="off"] .taste-question-card::before,',
      'html[data-detail="off"] .codex-hero-card::before,',
      'html[data-detail="off"] [data-tactile-tilt="bound"]::before {',
      '  opacity: 0 !important;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .profile-banner,',
      '  .taste-question-card,',
      '  .codex-hero-card,',
      '  [data-tactile-tilt="bound"] {',
      '    transform: none !important;',
      '  }',
      '  .profile-banner::before,',
      '  .taste-question-card::before,',
      '  .codex-hero-card::before,',
      '  [data-tactile-tilt="bound"]::before {',
      '    opacity: 0 !important;',
      '  }',
      '}',
      /* Light theme polish for keycaps */
      'html[data-theme="light"] .kbd-keycap {',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 0 rgba(0, 0, 0, 0.08);',
      '}',
      /* Responsive 5-col -> 2-col -> 1-col */
      '@media (max-width: 1080px) {',
      '  .kbd-atlas-grid {',
      '    grid-template-columns: repeat(2, minmax(0, 1fr));',
      '  }',
      '  .kbd-atlas-col {',
      '    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.055));',
      '  }',
      '  .kbd-atlas-col:nth-child(2n) {',
      '    border-right: none;',
      '  }',
      '  .kbd-atlas-col:last-child:nth-child(odd) {',
      '    grid-column: 1 / -1;',
      '    border-right: none;',
      '  }',
      '}',
      '@media (max-width: 560px) {',
      '  .kbd-atlas-grid {',
      '    grid-template-columns: 1fr;',
      '  }',
      '  .kbd-atlas-col {',
      '    border-right: none;',
      '  }',
      '  .kbd-atlas-foot {',
      '    flex-direction: column;',
      '    align-items: flex-start;',
      '    gap: 4px;',
      '  }',
      '}',
    ].join('\n');

    doc.head.appendChild(style);
  }

  // =========================================================================
  // SAFE SVG BUILDER (ZERO innerHTML, ZERO XSS)
  // =========================================================================

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

  function createCloseIconSvg(doc) {
    const svg = createSvgEl(doc, 'svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
    });
    svg.appendChild(createSvgEl(doc, 'path', {
      d: 'M4 4L12 12M12 4L4 12',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    }));
    return svg;
  }

  function createSoundIconSvg(doc, enabled) {
    const svg = createSvgEl(doc, 'svg', {
      width: 13,
      height: 13,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
    });
    svg.appendChild(createSvgEl(doc, 'path', {
      d: 'M2.5 6.2H5L8.2 3.4V12.6L5 9.8H2.5V6.2Z',
      stroke: 'currentColor',
      'stroke-width': '1.3',
      'stroke-linejoin': 'round',
    }));
    if (enabled) {
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M10.5 5.6C11.4 6.4 11.9 7.2 11.9 8C11.9 8.8 11.4 9.6 10.5 10.4',
        stroke: 'currentColor',
        'stroke-width': '1.3',
        'stroke-linecap': 'round',
      }));
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M12.3 3.9C13.6 5.1 14.3 6.5 14.3 8C14.3 9.5 13.6 10.9 12.3 12.1',
        stroke: 'currentColor',
        'stroke-width': '1.3',
        'stroke-linecap': 'round',
      }));
    } else {
      svg.appendChild(createSvgEl(doc, 'path', {
        d: 'M10.8 6L14 9.2M14 6L10.8 9.2',
        stroke: 'currentColor',
        'stroke-width': '1.35',
        'stroke-linecap': 'round',
      }));
    }
    return svg;
  }

  // =========================================================================
  // 1. KEYBOARD SHORTCUT ATLAS MODAL (0ms INSTANT)
  // =========================================================================

  function ensureAtlasDom() {
    const doc = getDoc();
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return null;

    let backdrop = typeof doc.getElementById === 'function' ? doc.getElementById(ATLAS_BACKDROP_ID) : null;
    if (backdrop) return backdrop;

    ensureStyles();

    backdrop = doc.createElement('div');
    backdrop.id = ATLAS_BACKDROP_ID;
    backdrop.className = 'kbd-atlas-backdrop';
    backdrop.hidden = true;
    backdrop.setAttribute('data-instrument-atlas', 'true');

    const modal = doc.createElement('div');
    modal.id = ATLAS_MODAL_ID;
    modal.className = 'kbd-atlas-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'kbd-atlas-title');
    modal.setAttribute('tabindex', '-1');

    // Header
    const head = doc.createElement('header');
    head.className = 'kbd-atlas-head';

    const titleGroup = doc.createElement('div');
    titleGroup.className = 'kbd-atlas-title-group';

    const title = doc.createElement('h2');
    title.id = 'kbd-atlas-title';
    title.className = 'kbd-atlas-title';
    title.textContent = 'Keyboard Shortcut Atlas';

    const badge = doc.createElement('span');
    badge.className = 'kbd-atlas-badge';
    badge.textContent = '0ms \u00B7 Chord Engine';

    titleGroup.appendChild(title);
    titleGroup.appendChild(badge);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'btn-kbd-atlas-close';
    closeBtn.className = 'kbd-atlas-close';
    closeBtn.setAttribute('aria-label', 'Close Keyboard Shortcut Atlas (Esc)');
    closeBtn.appendChild(createCloseIconSvg(doc));
    closeBtn.addEventListener('click', function () {
      closeAtlas();
    });

    head.appendChild(titleGroup);
    head.appendChild(closeBtn);

    // 4-Column Grid
    const grid = doc.createElement('div');
    grid.className = 'kbd-atlas-grid';

    for (let c = 0; c < SHORTCUT_COLUMNS.length; c += 1) {
      const colData = SHORTCUT_COLUMNS[c];
      const colEl = doc.createElement('section');
      colEl.className = 'kbd-atlas-col';
      colEl.setAttribute('data-atlas-col', colData.id);
      colEl.setAttribute('aria-label', colData.title);

      const colHead = doc.createElement('div');
      colHead.className = 'kbd-atlas-col-head';

      const colTitle = doc.createElement('span');
      colTitle.className = 'kbd-atlas-col-title';
      colTitle.textContent = colData.title;

      const colSub = doc.createElement('span');
      colSub.className = 'kbd-atlas-col-sub';
      colSub.textContent = colData.subtitle;

      colHead.appendChild(colTitle);
      colHead.appendChild(colSub);

      const list = doc.createElement('ul');
      list.className = 'kbd-atlas-list';

      for (let r = 0; r < colData.items.length; r += 1) {
        const item = colData.items[r];
        const li = doc.createElement('li');

        const isJumpable = Boolean(item.view);
        const rowEl = doc.createElement(isJumpable ? 'button' : 'div');
        rowEl.className = isJumpable ? 'kbd-atlas-row kbd-atlas-row-btn' : 'kbd-atlas-row';
        if (isJumpable) {
          rowEl.type = 'button';
          rowEl.setAttribute('data-atlas-jump-view', item.view);
          rowEl.addEventListener('click', (function (viewName) {
            return function () {
              closeAtlas({ restoreFocus: false });
              playSoundClick();
              dispatchViewSwitch(viewName);
            };
          })(item.view));
        }

        const labelEl = doc.createElement('span');
        labelEl.className = 'kbd-atlas-label';
        labelEl.textContent = item.label;

        const keysEl = doc.createElement('span');
        keysEl.className = 'kbd-atlas-keys';

        for (let k = 0; k < item.keys.length; k += 1) {
          if (k > 0 && item.sep && item.sep !== ' ') {
            const sepEl = doc.createElement('span');
            sepEl.className = 'kbd-atlas-sep';
            sepEl.textContent = item.sep;
            keysEl.appendChild(sepEl);
          }
          const kbd = doc.createElement('kbd');
          kbd.className = 'kbd-keycap';
          kbd.textContent = item.keys[k];
          keysEl.appendChild(kbd);
        }

        rowEl.appendChild(labelEl);
        rowEl.appendChild(keysEl);
        li.appendChild(rowEl);
        list.appendChild(li);
      }

      colEl.appendChild(colHead);
      colEl.appendChild(list);
      grid.appendChild(colEl);
    }

    // Footer
    const foot = doc.createElement('footer');
    foot.className = 'kbd-atlas-foot';

    const leftHint = doc.createElement('span');
    leftHint.className = 'kbd-atlas-foot-group';
    const gCap = doc.createElement('kbd');
    gCap.className = 'kbd-keycap';
    gCap.textContent = 'G';
    const leftText = doc.createElement('span');
    leftText.textContent = 'then letter switches workspace instantly';
    leftHint.appendChild(gCap);
    leftHint.appendChild(leftText);

    const rightHint = doc.createElement('span');
    rightHint.className = 'kbd-atlas-foot-group';
    const qCap = doc.createElement('kbd');
    qCap.className = 'kbd-keycap';
    qCap.textContent = '?';
    const sepText = doc.createElement('span');
    sepText.textContent = 'or';
    const escCap = doc.createElement('kbd');
    escCap.className = 'kbd-keycap';
    escCap.textContent = 'Esc';
    const rightText = doc.createElement('span');
    rightText.textContent = 'to close';
    rightHint.appendChild(qCap);
    rightHint.appendChild(sepText);
    rightHint.appendChild(escCap);
    rightHint.appendChild(rightText);

    foot.appendChild(leftHint);
    foot.appendChild(rightHint);

    modal.appendChild(head);
    modal.appendChild(grid);
    modal.appendChild(foot);
    backdrop.appendChild(modal);

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) {
        closeAtlas();
      }
    });

    doc.body.appendChild(backdrop);
    return backdrop;
  }

  function openAtlas() {
    cancelChord();
    const doc = getDoc();
    if (!doc) return false;
    const backdrop = ensureAtlasDom();
    if (!backdrop) return false;

    atlasReturnFocusEl = doc.activeElement || null;
    backdrop.hidden = false;
    atlasOpen = true;

    const modal = typeof doc.getElementById === 'function' ? doc.getElementById(ATLAS_MODAL_ID) : null;
    if (modal && typeof modal.focus === 'function') {
      try {
        modal.focus({ preventScroll: true });
      } catch (_) {
        try {
          modal.focus();
        } catch (_) {
          // Ignore focus errors in synthetic environments
        }
      }
    }

    if (typeof onAtlasOpenCb === 'function') {
      try {
        onAtlasOpenCb();
      } catch (_) {
        // Ignore callback errors
      }
    }
    return true;
  }

  function closeAtlas(opts) {
    const options = opts || {};
    const doc = getDoc();
    const backdrop = doc && typeof doc.getElementById === 'function'
      ? doc.getElementById(ATLAS_BACKDROP_ID)
      : null;

    if (backdrop) {
      backdrop.hidden = true;
    }
    const wasOpen = atlasOpen;
    atlasOpen = false;

    if (wasOpen && options.restoreFocus !== false && atlasReturnFocusEl && typeof atlasReturnFocusEl.focus === 'function') {
      try {
        atlasReturnFocusEl.focus({ preventScroll: true });
      } catch (_) {
        try {
          atlasReturnFocusEl.focus();
        } catch (_) {
          // Ignore
        }
      }
    }
    atlasReturnFocusEl = null;

    if (wasOpen && typeof onAtlasCloseCb === 'function') {
      try {
        onAtlasCloseCb();
      } catch (_) {
        // Ignore
      }
    }
    return wasOpen;
  }

  function toggleAtlas() {
    if (atlasOpen) {
      closeAtlas();
      return false;
    }
    openAtlas();
    return true;
  }

  function isAtlasOpen() {
    return atlasOpen;
  }

  // =========================================================================
  // 2. LIVE 'G' WORKSPACE CHORD ENGINE
  // =========================================================================

  function ensureChordPillDom() {
    const doc = getDoc();
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return null;

    let pill = typeof doc.getElementById === 'function' ? doc.getElementById(CHORD_PILL_ID) : null;
    if (pill) return pill;

    ensureStyles();

    pill = doc.createElement('div');
    pill.id = CHORD_PILL_ID;
    pill.className = 'kbd-chord-pill';
    pill.hidden = true;
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');

    const lead = doc.createElement('span');
    lead.className = 'kbd-chord-lead';
    const gKey = doc.createElement('kbd');
    gKey.className = 'kbd-keycap';
    gKey.textContent = 'G';
    const arrow = doc.createElement('span');
    arrow.textContent = '->';
    lead.appendChild(gKey);
    lead.appendChild(arrow);

    const list = doc.createElement('span');
    list.className = 'kbd-chord-list';

    for (let i = 0; i < CHORD_ORDER.length; i += 1) {
      if (i > 0) {
        const dot = doc.createElement('span');
        dot.className = 'kbd-chord-dot';
        dot.textContent = '\u00B7';
        list.appendChild(dot);
      }
      const entry = CHORD_ORDER[i];
      const item = doc.createElement('span');
      item.className = 'kbd-chord-item';

      const k = doc.createElement('span');
      k.className = 'kbd-chord-item-key';
      k.textContent = entry.key.toUpperCase();

      const lbl = doc.createElement('span');
      lbl.textContent = entry.label;

      item.appendChild(k);
      item.appendChild(lbl);
      list.appendChild(item);
    }

    pill.appendChild(lead);
    pill.appendChild(list);
    doc.body.appendChild(pill);
    return pill;
  }

  function armChord() {
    if (chordTimer) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
    chordArmed = true;
    const pill = ensureChordPillDom();
    if (pill) {
      pill.hidden = false;
    }
    chordTimer = setTimeout(function () {
      cancelChord();
    }, CHORD_TIMEOUT_MS);
  }

  function cancelChord() {
    if (chordTimer) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
    const wasArmed = chordArmed;
    chordArmed = false;
    const doc = getDoc();
    const pill = doc && typeof doc.getElementById === 'function' ? doc.getElementById(CHORD_PILL_ID) : null;
    if (pill) {
      pill.hidden = true;
    }
    return wasArmed;
  }

  function isChordArmed() {
    return chordArmed;
  }

  function dispatchViewSwitch(viewName) {
    if (!viewName) return false;
    if (typeof onSwitchViewCb === 'function') {
      onSwitchViewCb(viewName);
      return true;
    }
    const doc = getDoc();
    if (doc && typeof doc.querySelector === 'function') {
      const btn = doc.querySelector('.os-nav-btn[data-view="' + viewName + '"]');
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function handleKeydown(e) {
    if (!e || e.isComposing) return;
    const key = typeof e.key === 'string' ? e.key : '';
    if (!key) return;
    const lower = key.toLowerCase();
    const hasMod = Boolean(e.metaKey || e.ctrlKey || e.altKey);

    // When Atlas is open, capture Esc or ? cleanly without leaking to underlying views
    if (atlasOpen) {
      if (key === 'Escape' || (!hasMod && key === '?' && !isEditableContext(e.target))) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        closeAtlas();
      }
      return;
    }

    // Modifier combinations cancel any armed chord and pass straight through
    if (hasMod) {
      if (chordArmed && !MODIFIER_KEYS.has(key)) {
        cancelChord();
      }
      return;
    }

    // Never interfere with text inputs, contenteditable, or other open modals
    if (isEditableContext(e.target) || isBlockingModalOpen()) {
      if (chordArmed) cancelChord();
      return;
    }

    if (e.repeat) return;

    // Complete or cancel an armed 'G' chord
    if (chordArmed) {
      if (MODIFIER_KEYS.has(key)) return;

      if (key === 'Escape') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        cancelChord();
        return;
      }

      if (!e.shiftKey && Object.prototype.hasOwnProperty.call(CHORD_MAP, lower)) {
        const entry = CHORD_MAP[lower];
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        cancelChord();
        playSoundClick();
        dispatchViewSwitch(entry.view);
        return;
      }

      cancelChord();
      // Fall through so '?' immediately after 'G' can still open Atlas
    }

    // '?' opens Keyboard Shortcut Atlas instantly (0ms)
    if (key === '?') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      toggleAtlas();
      return;
    }

    // Bare 'g' arms the Workspace Chord Engine
    if (lower === 'g' && !e.shiftKey) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      armChord();
    }
  }

  function handleDelegatedClick(e) {
    if (!e || !e.target || typeof e.target.closest !== 'function') return;
    let trigger = null;
    try {
      trigger = e.target.closest(atlasTriggerSelector);
    } catch (_) {
      trigger = null;
    }
    if (!trigger) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    playSoundClick();
    toggleAtlas();
  }

  // =========================================================================
  // 3. LIVE AMBIENT LONDON CLOCK & ENGINE TELEMETRY PILL
  // =========================================================================

  function formatLondonTime(date) {
    const d = date instanceof Date ? date : new Date();
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return 'LON ' + fmt.format(d);
    } catch (_) {
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return 'LON ' + hh + ':' + mm;
    }
  }

  function resolveEl(elOrSelector) {
    if (!elOrSelector) return null;
    if (typeof elOrSelector === 'string') {
      const doc = getDoc();
      return doc && typeof doc.querySelector === 'function' ? doc.querySelector(elOrSelector) : null;
    }
    return elOrSelector;
  }

  function mountAmbientClock(elOrSelector, opts) {
    const target = resolveEl(elOrSelector);
    const doc = getDoc();
    if (!target || !doc || typeof doc.createElement !== 'function') return null;

    ensureStyles();

    const options = opts || {};
    let currentStatus = typeof options.engineText === 'string'
      ? options.engineText
      : (typeof options.statusText === 'string' ? options.statusText : latestEngineStatus);
    const getStatusFn = typeof options.getStatus === 'function' ? options.getStatus : null;
    const intervalMs = typeof options.intervalMs === 'number' && options.intervalMs >= 5000
      ? options.intervalMs
      : CLOCK_INTERVAL_MS;

    // Clear target safely
    while (target.firstChild) {
      target.removeChild(target.firstChild);
    }

    const pill = doc.createElement('div');
    pill.className = 'instrument-ambient-pill';
    pill.setAttribute('data-instrument-clock', 'true');

    const dot = doc.createElement('span');
    dot.className = 'instrument-clock-dot';
    dot.setAttribute('aria-hidden', 'true');

    const timeEl = doc.createElement('span');
    timeEl.className = 'instrument-clock-time tabular';

    const sepEl = doc.createElement('span');
    sepEl.className = 'instrument-clock-sep';
    sepEl.textContent = '\u00B7';
    sepEl.setAttribute('aria-hidden', 'true');

    const engineEl = doc.createElement('span');
    engineEl.className = 'instrument-clock-engine';

    pill.appendChild(dot);
    pill.appendChild(timeEl);
    pill.appendChild(sepEl);
    pill.appendChild(engineEl);
    target.appendChild(pill);

    function render(nowDate) {
      timeEl.textContent = formatLondonTime(nowDate || new Date());
      const resolvedStatus = getStatusFn ? String(getStatusFn() || '') : currentStatus;
      if (resolvedStatus) {
        engineEl.textContent = resolvedStatus;
        engineEl.hidden = false;
        sepEl.hidden = false;
      } else {
        engineEl.textContent = '';
        engineEl.hidden = true;
        sepEl.hidden = true;
      }
      pill.title = resolvedStatus
        ? 'London live clock (' + timeEl.textContent + ') | ' + resolvedStatus
        : 'London live clock (' + timeEl.textContent + ')';
    }

    render(new Date());

    let timerId = setInterval(function () {
      if (doc.hidden) return;
      render(new Date());
    }, intervalMs);

    const onVisibilityChange = function () {
      if (!doc.hidden) {
        render(new Date());
      }
    };
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    const controller = {
      el: pill,
      update: function (date) {
        render(date || new Date());
      },
      setStatus: function (statusText) {
        currentStatus = statusText == null ? '' : String(statusText);
        render(new Date());
      },
      destroy: function () {
        if (timerId != null) {
          clearInterval(timerId);
          timerId = null;
        }
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
        clockControllers.delete(controller);
      },
    };

    clockControllers.add(controller);
    return controller;
  }

  function setEngineStatus(statusText) {
    latestEngineStatus = statusText == null ? '' : String(statusText);
    clockControllers.forEach(function (ctrl) {
      ctrl.setStatus(latestEngineStatus);
    });
  }

  // =========================================================================
  // 4. MACHINED 3D SPECULAR RIM TILT (<= 2.2deg, SINGLE PASSIVE LISTENER)
  // =========================================================================

  function computeTiltValues(rect, clientX, clientY, maxDeg) {
    const cap = typeof maxDeg === 'number' && maxDeg > 0 ? Math.min(maxDeg, MAX_TILT_DEG) : MAX_TILT_DEG;
    if (!rect || !rect.width || !rect.height) {
      return { tiltX: 0, tiltY: 0, rimAngle: 135 };
    }
    const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
    const tiltX = clamp((0.5 - ny) * 2 * cap, -cap, cap);
    const tiltY = clamp((nx - 0.5) * 2 * cap, -cap, cap);
    const dx = clientX - (rect.left + rect.width * 0.5);
    const dy = clientY - (rect.top + rect.height * 0.5);
    const rimAngle = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
    return {
      tiltX: Number(tiltX.toFixed(2)),
      tiltY: Number(tiltY.toFixed(2)),
      rimAngle: Number(rimAngle.toFixed(1)),
    };
  }

  function findTiltCard(target) {
    if (!target || typeof target.closest !== 'function' || !tiltSelectors.length) return null;
    const combined = tiltSelectors.join(', ');
    try {
      return target.closest(combined);
    } catch (_) {
      for (let i = 0; i < tiltSelectors.length; i += 1) {
        try {
          const hit = target.closest(tiltSelectors[i]);
          if (hit) return hit;
        } catch (_) {
          // Skip invalid selector
        }
      }
      return null;
    }
  }

  function resetCardTilt(card) {
    if (!card || !card.style) return;
    if (typeof card.removeAttribute === 'function') {
      card.removeAttribute('data-tilt-active');
    }
    card.style.setProperty('--tilt-x', '0deg');
    card.style.setProperty('--tilt-y', '0deg');
    card.style.setProperty('--rim-opacity', '0');
  }

  function applyPendingTilt() {
    tiltPendingRaf = null;
    const card = tiltPendingCard;
    tiltPendingCard = null;
    if (!card) return;

    if (!isDetailOn() || prefersReducedMotion() || !supportsFineHoverPointer()) {
      resetCardTilt(card);
      if (tiltActiveCard === card) tiltActiveCard = null;
      return;
    }

    if (typeof card.getBoundingClientRect !== 'function' || !card.style) return;
    const rect = card.getBoundingClientRect();
    const vals = computeTiltValues(rect, tiltPendingX, tiltPendingY, tiltMaxDeg);

    if (typeof card.setAttribute === 'function') {
      card.setAttribute('data-tactile-tilt', 'bound');
      card.setAttribute('data-tilt-active', 'on');
    }
    card.style.setProperty('--tilt-x', vals.tiltX + 'deg');
    card.style.setProperty('--tilt-y', vals.tiltY + 'deg');
    card.style.setProperty('--rim-angle', vals.rimAngle + 'deg');
    card.style.setProperty('--rim-opacity', '1');
  }

  function bindTactileTilt(selector, opts) {
    const doc = getDoc();
    const w = getWin();
    if (!doc || typeof doc.addEventListener !== 'function') return null;

    ensureStyles();

    const options = opts || {};
    if (typeof options.maxDeg === 'number' && options.maxDeg > 0) {
      tiltMaxDeg = Math.min(options.maxDeg, MAX_TILT_DEG);
    }

    const rawList = Array.isArray(selector)
      ? selector
      : String(selector || DEFAULT_TILT_SELECTOR).split(',');

    for (let i = 0; i < rawList.length; i += 1) {
      const s = String(rawList[i] || '').trim();
      if (s && tiltSelectors.indexOf(s) === -1) {
        tiltSelectors.push(s);
      }
    }

    if (tiltBound) {
      return { unbind: unbindTactileTilt };
    }

    boundTiltMove = function (e) {
      if (!e || e.pointerType === 'touch') return;
      if (!isDetailOn() || prefersReducedMotion() || !supportsFineHoverPointer()) {
        if (tiltActiveCard) {
          resetCardTilt(tiltActiveCard);
          tiltActiveCard = null;
        }
        return;
      }

      const card = findTiltCard(e.target);
      if (tiltActiveCard && tiltActiveCard !== card) {
        resetCardTilt(tiltActiveCard);
        tiltActiveCard = null;
      }
      if (!card) return;

      tiltActiveCard = card;
      tiltPendingCard = card;
      tiltPendingX = e.clientX;
      tiltPendingY = e.clientY;

      if (tiltPendingRaf == null) {
        tiltPendingRaf = requestFrame(applyPendingTilt);
        if (tiltPendingRaf == null) {
          applyPendingTilt();
        }
      }
    };

    boundTiltOut = function (e) {
      if (!tiltActiveCard) return;
      const related = e && e.relatedTarget ? e.relatedTarget : null;
      if (related && typeof tiltActiveCard.contains === 'function' && tiltActiveCard.contains(related)) {
        return;
      }
      const leftCard = tiltActiveCard;
      tiltActiveCard = null;
      if (tiltPendingCard === leftCard) {
        tiltPendingCard = null;
      }
      if (tiltPendingRaf != null) {
        cancelFrame(tiltPendingRaf);
        tiltPendingRaf = null;
      }
      resetCardTilt(leftCard);
    };

    boundTiltBlur = function () {
      if (tiltPendingRaf != null) {
        cancelFrame(tiltPendingRaf);
        tiltPendingRaf = null;
      }
      tiltPendingCard = null;
      if (tiltActiveCard) {
        resetCardTilt(tiltActiveCard);
        tiltActiveCard = null;
      }
    };

    doc.addEventListener('pointermove', boundTiltMove, { passive: true });
    doc.addEventListener('pointerout', boundTiltOut, { passive: true });
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('blur', boundTiltBlur, { passive: true });
    }
    tiltBound = true;

    return { unbind: unbindTactileTilt };
  }

  function unbindTactileTilt() {
    const doc = getDoc();
    const w = getWin();
    if (tiltPendingRaf != null) {
      cancelFrame(tiltPendingRaf);
      tiltPendingRaf = null;
    }
    tiltPendingCard = null;
    if (tiltActiveCard) {
      resetCardTilt(tiltActiveCard);
      tiltActiveCard = null;
    }
    if (tiltBound && doc && typeof doc.removeEventListener === 'function') {
      if (boundTiltMove) doc.removeEventListener('pointermove', boundTiltMove);
      if (boundTiltOut) doc.removeEventListener('pointerout', boundTiltOut);
    }
    if (tiltBound && w && typeof w.removeEventListener === 'function' && boundTiltBlur) {
      w.removeEventListener('blur', boundTiltBlur);
    }
    boundTiltMove = null;
    boundTiltOut = null;
    boundTiltBlur = null;
    tiltBound = false;
    tiltSelectors = [];
  }

  // =========================================================================
  // 5. SOUND TOGGLE BUTTON BINDING (SYNCED WITH window.KizukiSound)
  // =========================================================================

  function mountSoundToggle(btnElOrSelector, opts) {
    const btn = resolveEl(btnElOrSelector);
    const doc = getDoc();
    const w = getWin();
    if (!btn || !doc || typeof doc.createElement !== 'function') return null;

    ensureStyles();

    const options = opts || {};
    let fallbackEnabled = true;

    function readEnabled() {
      const sound = getSoundApi();
      if (sound && typeof sound.isEnabled === 'function') {
        try {
          return Boolean(sound.isEnabled());
        } catch (_) {
          return fallbackEnabled;
        }
      }
      return fallbackEnabled;
    }

    function sync() {
      const enabled = readEnabled();
      fallbackEnabled = enabled;

      if (btn.classList && typeof btn.classList.add === 'function') {
        btn.classList.add('instrument-sound-btn');
        btn.classList.toggle('is-sound-on', enabled);
        btn.classList.toggle('is-muted', !enabled);
      }
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.setAttribute('data-sound-state', enabled ? 'on' : 'off');
      btn.setAttribute('aria-label', enabled ? 'Mute interface sounds' : 'Unmute interface sounds');
      btn.setAttribute('title', enabled ? 'Interface sound: ON (click to mute)' : 'Interface sound: MUTED (click to enable)');

      while (btn.firstChild) {
        btn.removeChild(btn.firstChild);
      }
      btn.appendChild(createSoundIconSvg(doc, enabled));

      const sr = doc.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = enabled ? 'Sound On' : 'Sound Off';
      btn.appendChild(sr);

      return enabled;
    }

    function onClick() {
      const sound = getSoundApi();
      let nextEnabled;
      if (sound && typeof sound.toggle === 'function') {
        try {
          const toggled = sound.toggle();
          nextEnabled = typeof toggled === 'boolean' ? toggled : readEnabled();
        } catch (_) {
          nextEnabled = !readEnabled();
        }
      } else if (sound && typeof sound.setEnabled === 'function') {
        nextEnabled = !readEnabled();
        try {
          sound.setEnabled(nextEnabled);
        } catch (_) {
          // Ignore
        }
      } else {
        nextEnabled = !fallbackEnabled;
        fallbackEnabled = nextEnabled;
      }

      if (nextEnabled) {
        playSoundClick();
      }
      sync();

      if (typeof options.onChange === 'function') {
        try {
          options.onChange(nextEnabled);
        } catch (_) {
          // Ignore
        }
      }
    }

    function onExternalChange() {
      sync();
    }

    btn.addEventListener('click', onClick);
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('kizuki:sound-change', onExternalChange);
    }

    sync();

    const controller = {
      el: btn,
      sync: sync,
      isEnabled: readEnabled,
      destroy: function () {
        btn.removeEventListener('click', onClick);
        if (w && typeof w.removeEventListener === 'function') {
          w.removeEventListener('kizuki:sound-change', onExternalChange);
        }
        soundControllers.delete(controller);
      },
    };

    soundControllers.add(controller);
    return controller;
  }

  // =========================================================================
  // LIFECYCLE: INIT & DESTROY
  // =========================================================================

  function init(opts) {
    const options = opts || {};
    if (options.window) customWin = options.window;
    if (options.document) customDoc = options.document;

    if (typeof options.onSwitchView === 'function') {
      onSwitchViewCb = options.onSwitchView;
    }
    if (typeof options.onAtlasOpen === 'function') {
      onAtlasOpenCb = options.onAtlasOpen;
    }
    if (typeof options.onAtlasClose === 'function') {
      onAtlasCloseCb = options.onAtlasClose;
    }
    if (typeof options.atlasTriggerSelector === 'string' && options.atlasTriggerSelector.trim()) {
      atlasTriggerSelector = options.atlasTriggerSelector.trim();
    }
    if (typeof options.engineStatus === 'string') {
      latestEngineStatus = options.engineStatus;
    }

    const doc = getDoc();
    const w = getWin();

    ensureStyles();

    if (!initialized && doc && typeof doc.addEventListener === 'function') {
      boundKeydown = handleKeydown;
      boundClick = handleDelegatedClick;
      boundBlur = function () {
        cancelChord();
      };

      // Capture phase ensures G-chord second keys never bleed into single-key view shortcuts
      doc.addEventListener('keydown', boundKeydown, true);
      doc.addEventListener('click', boundClick);
      if (w && typeof w.addEventListener === 'function') {
        w.addEventListener('blur', boundBlur);
      }
      initialized = true;
    }

    if (options.clockEl) {
      mountAmbientClock(options.clockEl, options.clockOptions);
    }
    if (options.soundBtnEl) {
      mountSoundToggle(options.soundBtnEl, options.soundOptions);
    }
    if (options.bindTilt !== false) {
      bindTactileTilt(options.tiltSelector || DEFAULT_TILT_SELECTOR, options.tiltOptions);
    }

    return api;
  }

  function destroy() {
    cancelChord();
    closeAtlas({ restoreFocus: false });

    const doc = getDoc();
    const w = getWin();

    if (initialized && doc && typeof doc.removeEventListener === 'function') {
      if (boundKeydown) doc.removeEventListener('keydown', boundKeydown, true);
      if (boundClick) doc.removeEventListener('click', boundClick);
    }
    if (initialized && w && typeof w.removeEventListener === 'function' && boundBlur) {
      w.removeEventListener('blur', boundBlur);
    }

    boundKeydown = null;
    boundClick = null;
    boundBlur = null;
    initialized = false;

    clockControllers.forEach(function (ctrl) {
      ctrl.destroy();
    });
    soundControllers.forEach(function (ctrl) {
      ctrl.destroy();
    });
    unbindTactileTilt();

    onSwitchViewCb = null;
    onAtlasOpenCb = null;
    onAtlasCloseCb = null;
    atlasTriggerSelector = DEFAULT_ATLAS_TRIGGER_SELECTOR;
    customWin = null;
    customDoc = null;
  }

  const api = {
    init: init,
    destroy: destroy,
    openAtlas: openAtlas,
    closeAtlas: closeAtlas,
    toggleAtlas: toggleAtlas,
    isAtlasOpen: isAtlasOpen,
    armChord: armChord,
    cancelChord: cancelChord,
    isChordArmed: isChordArmed,
    mountAmbientClock: mountAmbientClock,
    setEngineStatus: setEngineStatus,
    formatLondonTime: formatLondonTime,
    bindTactileTilt: bindTactileTilt,
    unbindTactileTilt: unbindTactileTilt,
    computeTiltValues: computeTiltValues,
    mountSoundToggle: mountSoundToggle,
    CHORD_MAP: CHORD_MAP,
    SHORTCUT_COLUMNS: SHORTCUT_COLUMNS,
    MAX_TILT_DEG: MAX_TILT_DEG,
  };

  return api;
});
