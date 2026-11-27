/* ==========================================================================
   KIZUKI MIND EXPLORER - CROSS-OS AGENT BOARD WIDGETS & DISPATCH KIT
   Evil Rabbit Matte-Graphite Embeddable Widgets for Today, People, Codex, Taste
   Exports: window.KizukiBoardWidgets = {
     mountTodayPulse,
     mountPersonBoard,
     mountCodexBoardBadge,
     mountTasteBoardLedger,
     openBoardDispatchModal,
     closeBoardDispatchModal,
     clearCache,
     escHtml,
     stripEmDash,
   }
   Zero external deps | 100% XSS-escaped | Zero em-dashes | Fail-soft offline
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiBoardWidgets = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiBoardWidgets = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function (root) {
    'use strict';

    const EM_DASH_RE = /\s*\u2014\s*/g;
    const EN_DASH_RE = /\s*\u2013\s*/g;

    const TODAY_PULSE_TTL_MS = 15000;
    const ENTITY_THREADS_TTL_MS = 30000;
    const ROOMS_TTL_MS = 60000;
    const STYLE_ID = 'kizuki-board-os-widgets-css';
    const MODAL_BACKDROP_ID = 'kbw-dispatch-modal-backdrop';
    const ACTION_TOAST_ID = 'kbw-action-toast';

    const DEFAULT_ROOMS = Object.freeze([
      { channel: 'box/work', groupLabel: 'Box', label: 'box/work' },
      { channel: 'kizuki/decisions', groupLabel: 'Kizuki', label: 'kizuki/decisions' },
      { channel: 'box/taste', groupLabel: 'Box', label: 'box/taste' },
      { channel: 'design/work', groupLabel: 'Design', label: 'design/work' },
      { channel: 'agent-board/work', groupLabel: 'Agent Board', label: 'agent-board/work' },
      { channel: 'box', groupLabel: 'Box', label: 'box' },
    ]);

    const DISPATCH_TARGETS = Object.freeze([
      { id: '', handle: '', label: 'Broadcast', brand: 'owner', glyph: '#' },
      { id: 'claude', handle: '@claude', label: '@claude', brand: 'claude', glyph: '*' },
      { id: 'codex', handle: '@codex', label: '@codex', brand: 'codex', glyph: '</>' },
      { id: 'orchestrator', handle: '@orchestrator', label: '@orchestrator', brand: 'brain', glyph: '>_' },
      { id: 'board-keeper', handle: '@board-keeper', label: '@board-keeper', brand: 'brain', glyph: '>_' },
      { id: 'dreamer', handle: '@dreamer', label: '@dreamer', brand: 'designer', glyph: 'II' },
    ]);

    const ICONS = Object.freeze({
      board:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1.1"/><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1.1"/><rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1.1"/><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1.1"/></svg>',
      send:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h10.5"/><path d="M9.2 4.2 13 8l-3.8 3.8"/></svg>',
      plus:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
      close:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
      spark:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6 8 2.2Z"/></svg>',
      reply:
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 4.2 2.6 8l3.8 3.8"/><path d="M3 8h6.4a4 4 0 0 1 4 4v.4"/></svg>',
      alert:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8v3.5"/><circle cx="8" cy="11.1" r="0.65" fill="currentColor"/></svg>',
      ownerDot:
        '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/></svg>',
    });

    const WIDGET_CSS = [
      '/* Scoped Evil Rabbit Matte-Graphite Cross-OS Board Widgets (.kbw-*) */',
      '.kbw-card {',
      '  position: relative;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 10px;',
      '  padding: 12px 14px;',
      '  border-radius: 12px;',
      '  background: var(--eb-stage-bg, #141416);',
      '  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));',
      '  box-shadow: var(--eb-shadow-stage, 0 1px 0 rgba(255, 255, 255, 0.03) inset);',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: var(--font-sans, "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif);',
      '  min-width: 0;',
      '}',
      '.kbw-card.is-compact { padding: 10px 12px; gap: 8px; }',
      '.kbw-card.is-offline { background: var(--eb-card-bg, #18181b); }',
      '.kbw-head {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  flex-wrap: wrap;',
      '}',
      '.kbw-title-wrap {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 7px;',
      '  min-width: 0;',
      '}',
      '.kbw-live-dot {',
      '  width: 7px;',
      '  height: 7px;',
      '  border-radius: 9999px;',
      '  background: var(--eb-live, #34d399);',
      '  box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.16);',
      '  flex: 0 0 auto;',
      '}',
      '.kbw-live-dot.is-offline {',
      '  background: var(--ink-muted, #737373);',
      '  box-shadow: none;',
      '}',
      '.kbw-title {',
      '  font-size: 12.5px;',
      '  font-weight: 600;',
      '  letter-spacing: -0.01em;',
      '  color: var(--ink-primary, #ededed);',
      '  margin: 0;',
      '}',
      '.kbw-sub-badge {',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 10.5px;',
      '  font-weight: 500;',
      '  padding: 1px 6px;',
      '  border-radius: 9999px;',
      '  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.055));',
      '  border: 1px solid var(--eb-border-subtle, rgba(255, 255, 255, 0.06));',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '.kbw-head-actions {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  flex-wrap: wrap;',
      '}',
      '.kbw-btn {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 5px;',
      '  padding: 4px 9px;',
      '  border-radius: 7px;',
      '  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.135));',
      '  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.055));',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: inherit;',
      '  font-size: 11.5px;',
      '  font-weight: 500;',
      '  line-height: 1.25;',
      '  cursor: pointer;',
      '  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;',
      '  white-space: nowrap;',
      '}',
      '.kbw-btn:hover { background: var(--eb-pill-hover, rgba(255, 255, 255, 0.095)); border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.22)); }',
      '.kbw-btn:focus-visible { outline: 2px solid var(--eb-border-focus, rgba(37, 99, 235, 0.65)); outline-offset: 1px; }',
      '.kbw-btn.is-primary {',
      '  background: var(--eb-ship-bg, #ededed);',
      '  color: var(--eb-ship-ink, #0d0d0f);',
      '  border-color: transparent;',
      '  font-weight: 600;',
      '}',
      '.kbw-btn.is-primary:hover { background: var(--eb-ship-hover, #ffffff); }',
      '.kbw-btn.is-send {',
      '  background: var(--eb-send-bg, #2563eb);',
      '  color: var(--eb-send-ink, #ffffff);',
      '  border-color: transparent;',
      '  font-weight: 500;',
      '}',
      '.kbw-btn.is-send:hover { background: var(--eb-send-hover, #1d4ed8); }',
      '.kbw-btn:disabled { opacity: 0.55; cursor: not-allowed; }',
      '.kbw-kpi-row {',
      '  display: flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 6px;',
      '}',
      '.kbw-kpi-pill {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  padding: 4px 9px;',
      '  border-radius: 9999px;',
      '  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.075));',
      '  background: var(--eb-card-bg, #18181b);',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-family: inherit;',
      '  font-size: 11.5px;',
      '  font-weight: 500;',
      '  font-variant-numeric: tabular-nums;',
      '  cursor: pointer;',
      '  transition: background-color 120ms ease, border-color 120ms ease;',
      '}',
      '.kbw-kpi-pill:hover { background: var(--eb-card-hover, #1d1d21); color: var(--ink-primary, #ededed); }',
      '.kbw-kpi-num { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); font-weight: 600; color: var(--ink-primary, #ededed); }',
      '.kbw-kpi-pill.is-warn .kbw-kpi-num { color: var(--eb-warn, #f59e0b); }',
      '.kbw-kpi-pill.is-danger .kbw-kpi-num { color: var(--eb-danger, #f43f5e); }',
      '.kbw-brand-dots { display: inline-flex; align-items: center; gap: 3px; }',
      '.kbw-brand-dot {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 9999px;',
      '  display: inline-block;',
      '  background: var(--eb-brain, #4ade80);',
      '}',
      '.kbw-brand-dot.is-claude { background: var(--eb-claude, #e2845d); }',
      '.kbw-brand-dot.is-codex { background: var(--eb-codex, #56b6f9); }',
      '.kbw-brand-dot.is-designer { background: var(--eb-designer, #b48eff); }',
      '.kbw-brand-dot.is-brain { background: var(--eb-brain, #4ade80); }',
      '.kbw-brand-dot.is-worker { background: var(--eb-worker, #a5b4fc); }',
      '.kbw-brand-dot.is-owner { background: var(--eb-owner, #ededed); }',
      '.kbw-thread-list {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 6px;',
      '}',
      '.kbw-thread-row {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 5px;',
      '  padding: 8px 10px;',
      '  border-radius: 9px;',
      '  background: var(--eb-card-bg, #18181b);',
      '  border: 1px solid var(--eb-border-subtle, rgba(255, 255, 255, 0.055));',
      '  cursor: pointer;',
      '  content-visibility: auto;',
      '  contain-intrinsic-size: auto 76px;',
      '  transition: background-color 120ms ease, border-color 120ms ease;',
      '  min-width: 0;',
      '}',
      '.kbw-thread-row:hover { background: var(--eb-card-hover, #1d1d21); border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.135)); }',
      '.kbw-thread-row:focus-visible { outline: 2px solid var(--eb-border-focus, rgba(37, 99, 235, 0.65)); outline-offset: 1px; }',
      '.kbw-thread-top {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  min-width: 0;',
      '}',
      '.kbw-glyph {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  min-width: 20px;',
      '  height: 18px;',
      '  padding: 0 4px;',
      '  border-radius: 5px;',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 10px;',
      '  font-weight: 600;',
      '  line-height: 1;',
      '  flex: 0 0 auto;',
      '  background: var(--eb-brain-bg, rgba(52, 211, 153, 0.13));',
      '  color: var(--eb-brain, #4ade80);',
      '  border: 1px solid var(--eb-brain-border, rgba(52, 211, 153, 0.28));',
      '}',
      '.kbw-glyph.is-claude { background: var(--eb-claude-bg, rgba(217, 119, 87, 0.13)); color: var(--eb-claude, #e2845d); border-color: var(--eb-claude-border, rgba(217, 119, 87, 0.28)); }',
      '.kbw-glyph.is-codex { background: var(--eb-codex-bg, rgba(56, 189, 248, 0.13)); color: var(--eb-codex, #56b6f9); border-color: var(--eb-codex-border, rgba(56, 189, 248, 0.28)); }',
      '.kbw-glyph.is-designer { background: var(--eb-designer-bg, rgba(167, 139, 250, 0.14)); color: var(--eb-designer, #b48eff); border-color: var(--eb-designer-border, rgba(167, 139, 250, 0.28)); }',
      '.kbw-glyph.is-brain { background: var(--eb-brain-bg, rgba(52, 211, 153, 0.13)); color: var(--eb-brain, #4ade80); border-color: var(--eb-brain-border, rgba(52, 211, 153, 0.28)); }',
      '.kbw-glyph.is-worker { background: var(--eb-worker-bg, rgba(129, 140, 248, 0.14)); color: var(--eb-worker, #a5b4fc); border-color: var(--eb-worker-border, rgba(129, 140, 248, 0.28)); }',
      '.kbw-glyph.is-owner { background: var(--eb-owner-bg, #ededed); color: var(--eb-owner-ink, #0d0d0f); border-color: transparent; }',
      '.kbw-thread-title {',
      '  font-size: 12.5px;',
      '  font-weight: 500;',
      '  color: var(--ink-primary, #ededed);',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '  flex: 1 1 auto;',
      '  min-width: 0;',
      '}',
      '.kbw-thread-excerpt {',
      '  font-size: 11.5px;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '.kbw-thread-meta {',
      '  display: flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 6px;',
      '  font-size: 11px;',
      '  color: var(--ink-muted, #737373);',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '.kbw-room-tag {',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 10.5px;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.055));',
      '  padding: 1px 6px;',
      '  border-radius: 5px;',
      '}',
      '.kbw-status-pill {',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 10px;',
      '  padding: 1px 5px;',
      '  border-radius: 4px;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.03em;',
      '}',
      '.kbw-status-pill.is-blocked { background: rgba(244, 63, 94, 0.14); color: var(--eb-danger, #f43f5e); }',
      '.kbw-status-pill.is-open { background: rgba(245, 158, 11, 0.14); color: var(--eb-warn, #f59e0b); }',
      '.kbw-thread-row.is-blocked-pulse { border-left: 2px solid var(--eb-danger, #f43f5e); }',
      '.kbw-age-bar-row {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  margin-top: 1px;',
      '}',
      '.kbw-age-track {',
      '  flex: 1 1 auto;',
      '  height: 3px;',
      '  border-radius: 9999px;',
      '  background: rgba(244, 63, 94, 0.16);',
      '  overflow: hidden;',
      '}',
      '.kbw-age-fill {',
      '  height: 100%;',
      '  border-radius: 9999px;',
      '  background: linear-gradient(90deg, #ef4444 0%, #f43f5e 100%);',
      '}',
      '.kbw-age-label {',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 10px;',
      '  font-weight: 500;',
      '  letter-spacing: 0.03em;',
      '  color: #fb7185;',
      '  font-variant-numeric: tabular-nums;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.kbw-mind-links {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 4px;',
      '}',
      '.kbw-mind-pill {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  padding: 1px 6px;',
      '  border-radius: 9999px;',
      '  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.09));',
      '  background: var(--eb-mention-bg, rgba(56, 189, 248, 0.12));',
      '  color: var(--eb-mention-ink, #7dd3fc);',
      '  font-family: inherit;',
      '  font-size: 10.5px;',
      '  font-weight: 500;',
      '  cursor: pointer;',
      '}',
      '.kbw-mind-pill:hover { filter: brightness(1.12); }',
      '.kbw-inline-strip {',
      '  display: flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 6px;',
      '  font-family: var(--font-sans, "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif);',
      '}',
      '.kbw-codex-pill {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  padding: 3px 8px;',
      '  border-radius: 9999px;',
      '  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.12));',
      '  background: var(--eb-card-bg, #18181b);',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 11px;',
      '  font-variant-numeric: tabular-nums;',
      '  cursor: pointer;',
      '  transition: background-color 120ms ease, border-color 120ms ease;',
      '}',
      '.kbw-codex-pill:hover { background: var(--eb-card-hover, #1d1d21); border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.22)); }',
      '.kbw-codex-dispatch-btn {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  padding: 3px 8px;',
      '  border-radius: 9999px;',
      '  border: 1px dashed var(--eb-border-strong, rgba(255, 255, 255, 0.16));',
      '  background: transparent;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-family: inherit;',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  cursor: pointer;',
      '}',
      '.kbw-codex-dispatch-btn:hover { color: var(--ink-primary, #ededed); border-style: solid; background: var(--eb-pill-bg, rgba(255, 255, 255, 0.055)); }',
      '.kbw-empty-note {',
      '  font-size: 12px;',
      '  color: var(--ink-muted, #737373);',
      '  padding: 6px 2px;',
      '}',
      '.kbw-offline-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  font-size: 12px;',
      '  color: var(--ink-secondary, #a1a1a1);',
      '}',
      /* Singleton Evil Rabbit Dispatch Modal */
      '.kbw-modal-backdrop {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 9600;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 16px;',
      '  background: var(--scrim-bg, rgba(0, 0, 0, 0.68));',
      '  backdrop-filter: blur(6px);',
      '  -webkit-backdrop-filter: blur(6px);',
      '}',
      '.kbw-modal {',
      '  width: min(560px, 100%);',
      '  max-height: calc(100vh - 32px);',
      '  overflow-y: auto;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 12px;',
      '  padding: 16px 18px;',
      '  border-radius: 14px;',
      '  background: var(--eb-stage-bg, #141416);',
      '  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));',
      '  box-shadow: var(--eb-shadow-popover, 0 18px 48px rgba(0, 0, 0, 0.64));',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: var(--font-sans, "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif);',
      '}',
      '.kbw-modal-head {',
      '  display: flex;',
      '  align-items: flex-start;',
      '  justify-content: space-between;',
      '  gap: 10px;',
      '}',
      '.kbw-modal-title { margin: 0; font-size: 14.5px; font-weight: 600; letter-spacing: -0.015em; }',
      '.kbw-modal-sub { margin: 3px 0 0; font-size: 11.5px; color: var(--ink-secondary, #a1a1a1); }',
      '.kbw-modal-close {',
      '  appearance: none;',
      '  width: 26px;',
      '  height: 26px;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  border-radius: 7px;',
      '  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));',
      '  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.055));',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  cursor: pointer;',
      '}',
      '.kbw-modal-close:hover { color: var(--ink-primary, #ededed); background: var(--eb-pill-hover, rgba(255, 255, 255, 0.1)); }',
      '.kbw-field { display: flex; flex-direction: column; gap: 6px; }',
      '.kbw-label {',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.05em;',
      '  color: var(--ink-muted, #737373);',
      '}',
      '.kbw-room-quick-row, .kbw-agent-row {',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 5px;',
      '}',
      '.kbw-chip {',
      '  appearance: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  padding: 4px 8px;',
      '  border-radius: 7px;',
      '  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));',
      '  background: var(--eb-card-bg, #18181b);',
      '  color: var(--ink-secondary, #a1a1a1);',
      '  font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace);',
      '  font-size: 11px;',
      '  cursor: pointer;',
      '}',
      '.kbw-chip:hover { color: var(--ink-primary, #ededed); background: var(--eb-card-hover, #1d1d21); }',
      '.kbw-chip.is-active {',
      '  color: var(--ink-primary, #ededed);',
      '  background: var(--eb-pill-active, rgba(255, 255, 255, 0.12));',
      '  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.24));',
      '}',
      '.kbw-room-controls {',
      '  display: grid;',
      '  grid-template-columns: 1fr 1.25fr;',
      '  gap: 6px;',
      '}',
      '.kbw-input, .kbw-select, .kbw-textarea {',
      '  width: 100%;',
      '  box-sizing: border-box;',
      '  border-radius: 8px;',
      '  border: 1px solid var(--eb-composer-border, rgba(255, 255, 255, 0.11));',
      '  background: var(--eb-composer-bg, #19191d);',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: inherit;',
      '  font-size: 12.5px;',
      '  padding: 7px 10px;',
      '}',
      '.kbw-input:focus, .kbw-select:focus, .kbw-textarea:focus {',
      '  outline: none;',
      '  border-color: var(--eb-border-focus, rgba(37, 99, 235, 0.65));',
      '}',
      '.kbw-textarea {',
      '  min-height: 112px;',
      '  resize: vertical;',
      '  line-height: 1.48;',
      '}',
      '.kbw-modal-error {',
      '  display: flex;',
      '  align-items: flex-start;',
      '  gap: 8px;',
      '  padding: 8px 10px;',
      '  border-radius: 8px;',
      '  background: rgba(244, 63, 94, 0.12);',
      '  border: 1px solid rgba(244, 63, 94, 0.34);',
      '  color: var(--eb-danger, #f43f5e);',
      '  font-size: 12px;',
      '  line-height: 1.4;',
      '}',
      '.kbw-modal-error[hidden] { display: none; }',
      '.kbw-modal-foot {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 10px;',
      '  flex-wrap: wrap;',
      '}',
      '.kbw-modal-hint { font-size: 11px; color: var(--ink-muted, #737373); font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }',
      '.kbw-action-toast {',
      '  position: fixed;',
      '  right: 18px;',
      '  bottom: 18px;',
      '  z-index: 9700;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 9px 12px;',
      '  border-radius: 10px;',
      '  background: var(--eb-popover-bg, rgba(22, 22, 26, 0.96));',
      '  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.15));',
      '  box-shadow: var(--eb-shadow-popover, 0 14px 36px rgba(0, 0, 0, 0.56));',
      '  color: var(--ink-primary, #ededed);',
      '  font-family: var(--font-sans, "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif);',
      '  font-size: 12px;',
      '}',
      '@media (max-width: 640px) {',
      '  .kbw-room-controls { grid-template-columns: 1fr; }',
      '  .kbw-action-toast { left: 12px; right: 12px; bottom: 12px; justify-content: space-between; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .kbw-btn, .kbw-kpi-pill, .kbw-thread-row, .kbw-codex-pill { transition: none; }',
      '}',
    ].join('\n');

    // In-memory TTL caches & in-flight deduplication maps
    let seqCounter = 0;
    let todayPulseCache = null; // { ts, data }
    let todayPulseInFlight = null;
    const entityThreadsCache = new Map(); // cacheKey -> { ts, data }
    const entityThreadsInFlight = new Map();
    let roomsCache = null; // { ts, rooms }
    let roomsInFlight = null;

    // Singleton modal state
    const modalState = {
      open: false,
      backdropEl: null,
      prevFocusEl: null,
      keydownHandler: null,
      submitting: false,
      rooms: DEFAULT_ROOMS.slice(),
      selectedChannel: 'box/work',
      selectedAgent: '',
      payload: null,
      hooks: null,
    };

    let actionToastTimer = null;

    function getWin() {
      if (typeof window !== 'undefined' && window) return window;
      if (root && root.window) return root.window;
      return root || null;
    }

    function getDoc() {
      if (typeof document !== 'undefined' && document) return document;
      const w = getWin();
      return w && w.document ? w.document : null;
    }

    function getFetch() {
      const w = getWin();
      if (w && typeof w.fetch === 'function') return w.fetch.bind(w);
      if (typeof fetch === 'function') return fetch;
      if (root && typeof root.fetch === 'function') return root.fetch.bind(root);
      return null;
    }

    function playSound(method) {
      const w = getWin();
      const sound = (w && w.KizukiSound) || (root && root.KizukiSound);
      if (!sound || typeof sound[method] !== 'function') return;
      try {
        sound[method]();
      } catch (_) {
        // Audio feedback must never break UI flow
      }
    }

    function stripEmDash(value) {
      return String(value == null ? '' : value)
        .replace(EM_DASH_RE, ' - ')
        .replace(EN_DASH_RE, ' - ');
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

    function safeArray(val) {
      return Array.isArray(val) ? val : [];
    }

    function normalizeChannel(ch) {
      return stripEmDash(String(ch || '').replace(/^#+/, '').trim());
    }

    function truncateWordBoundary(text, maxLen) {
      const clean = stripEmDash(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return '';
      if (clean.length <= maxLen) return clean;
      const slice = clean.slice(0, maxLen);
      const lastSpace = slice.lastIndexOf(' ');
      const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
      return `${cut.replace(/[,;:.\-/\s]+$/, '')}...`;
    }

    function formatShortThreadId(rawId) {
      const s = String(rawId == null ? '' : rawId).trim();
      if (!s) return '';
      if (/^\d+$/.test(s)) return `#${s}`;
      if (s.startsWith('key:')) {
        const tail = s.split(':').pop() || s.slice(4);
        return `#${tail.slice(0, 8)}`;
      }
      if (s.length > 12) return `#${s.slice(0, 8)}`;
      return `#${s}`;
    }

    function formatRelativeTime(isoOrMs) {
      if (!isoOrMs) return '';
      const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs));
      if (!Number.isFinite(ts)) return stripEmDash(String(isoOrMs));
      const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (diffSec < 10) return 'just now';
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return `${diffDay}d ago`;
      return new Date(ts).toISOString().slice(0, 10);
    }

    function extractActorSlug(rawActor, rawProfile) {
      const profile = rawProfile ? String(rawProfile).trim().replace(/^@+/, '') : '';
      if (profile) return profile;
      const clean = String(rawActor || '').trim().replace(/^@+/, '');
      if (!clean) return '';
      if (clean.includes('+')) {
        return clean.split('+').slice(1).join('+').trim();
      }
      const colonMatch = /^(?:local|tailscale):user:[^:+]+:(.+)$/i.exec(clean);
      if (colonMatch && colonMatch[1]) return colonMatch[1].trim();
      if (/^(?:local|tailscale):user:[^:+]+$/i.test(clean)) return '';
      return clean;
    }

    function parseAgentIdentity(rawActor, rawBrand, rawDisplayName, rawProfile) {
      const actorStr = String(rawActor || '').trim();
      const slug = extractActorSlug(actorStr, rawProfile);
      const lower = (slug || '').toLowerCase();
      const explicitBrand = String(rawBrand || '').toLowerCase();
      const explicitDisplay =
        rawDisplayName && !/^local:user:/i.test(String(rawDisplayName))
          ? stripEmDash(rawDisplayName).trim()
          : '';

      if (
        (!slug && /^(?:local|tailscale):user:[^:+]+$/i.test(actorStr)) ||
        lower === 'owner' ||
        lower === 'ubuntu' ||
        lower === 'owner' ||
        lower === 'self' ||
        (!slug && explicitBrand === 'owner')
      ) {
        return { handle: slug || 'owner', brand: 'owner', glyph: '', label: explicitDisplay || 'Owner' };
      }
      if (lower.includes('claude') || explicitBrand === 'claude') {
        return { handle: slug || 'claude', brand: 'claude', glyph: '*', label: explicitDisplay || 'Claude' };
      }
      if (lower.includes('codex') || lower.includes('scout-fleet') || explicitBrand === 'codex') {
        return { handle: slug || 'codex', brand: 'codex', glyph: '</>', label: explicitDisplay || 'Codex' };
      }
      if (
        lower.includes('designer') ||
        lower.includes('neon') ||
        lower.includes('dreamer') ||
        lower.includes('antigravity') ||
        explicitBrand === 'designer' ||
        explicitBrand === 'neon'
      ) {
        return {
          handle: slug || 'designer',
          brand: 'designer',
          glyph: 'II',
          label: explicitDisplay || (lower.includes('dreamer') ? 'Dreamer' : 'Designer'),
        };
      }
      if (
        lower.includes('orchestrator') ||
        lower.includes('brain') ||
        lower.includes('board-keeper') ||
        lower.includes('daemon') ||
        lower.includes('ambient') ||
        lower === 'kizuki' ||
        explicitBrand === 'brain' ||
        explicitBrand === 'orchestrator'
      ) {
        return {
          handle: slug || 'orchestrator',
          brand: 'brain',
          glyph: '>_',
          label: explicitDisplay || (slug ? slug : 'Brain'),
        };
      }
      if (slug) {
        return { handle: slug, brand: 'worker', glyph: 'II', label: explicitDisplay || slug };
      }
      return { handle: 'agent', brand: 'brain', glyph: '>_', label: explicitDisplay || 'Agent' };
    }

    function renderGlyphBadgeHtml(identity) {
      const id = identity || { brand: 'brain', glyph: '>_', label: 'Agent' };
      const inner = id.brand === 'owner' ? ICONS.ownerDot : escHtml(id.glyph || '>_');
      return `<span class="kbw-glyph is-${escAttr(id.brand)}" title="${escAttr(id.label)}">${inner}</span>`;
    }

    function ensureStylesInjected() {
      const doc = getDoc();
      if (!doc || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
        return;
      }
      if (doc.getElementById(STYLE_ID)) return;
      const head = doc.head || (doc.getElementsByTagName && doc.getElementsByTagName('head')[0]) || doc.documentElement;
      if (!head || typeof head.appendChild !== 'function') return;
      const styleEl = doc.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = WIDGET_CSS;
      head.appendChild(styleEl);
    }

    function invokeOpenBoard(hooks, opts) {
      const h = hooks && typeof hooks === 'object' ? hooks : {};
      const payload = Object.assign({}, opts || {});
      if (payload.channel) payload.channel = normalizeChannel(payload.channel);
      if (typeof h.openBoard === 'function') {
        h.openBoard(payload);
        return;
      }
      const w = getWin();
      if (w && w.KizukiAgentBoardView && typeof w.KizukiAgentBoardView.load === 'function') {
        w.KizukiAgentBoardView.load(payload);
      }
      if (w && typeof w.dispatchEvent === 'function' && typeof w.CustomEvent === 'function') {
        try {
          w.dispatchEvent(new w.CustomEvent('kizuki:open-board', { detail: payload }));
        } catch (_) {
          // ignore
        }
      }
    }

    function invokeShowToast(hooks, message, tone, opts) {
      const h = hooks && typeof hooks === 'object' ? hooks : {};
      const cleanMsg = stripEmDash(message || '');
      if (typeof h.showToast === 'function') {
        try {
          h.showToast(cleanMsg, tone || 'info', opts);
        } catch (_) {
          // ignore
        }
      }
    }

    function showActionToast(message, actionLabel, onAction) {
      const doc = getDoc();
      if (!doc || !doc.body || typeof doc.createElement !== 'function') return;
      ensureStylesInjected();
      if (actionToastTimer) {
        clearTimeout(actionToastTimer);
        actionToastTimer = null;
      }
      const existing = typeof doc.getElementById === 'function' ? doc.getElementById(ACTION_TOAST_ID) : null;
      if (existing && typeof existing.remove === 'function') existing.remove();

      const toast = doc.createElement('div');
      toast.id = ACTION_TOAST_ID;
      toast.className = 'kbw-action-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.innerHTML =
        `<span class="kbw-live-dot" aria-hidden="true"></span>` +
        `<span>${escHtml(message)}</span>` +
        `<button type="button" class="kbw-btn is-primary" data-kbw-toast-action="open">${escHtml(actionLabel || 'Open Thread in Board')}</button>` +
        `<button type="button" class="kbw-modal-close" data-kbw-toast-action="dismiss" aria-label="Dismiss">${ICONS.close}</button>`;

      const dismiss = () => {
        if (actionToastTimer) {
          clearTimeout(actionToastTimer);
          actionToastTimer = null;
        }
        if (toast && typeof toast.remove === 'function') toast.remove();
      };

      toast.addEventListener('click', (ev) => {
        const btn = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-toast-action]')
          : null;
        if (!btn) return;
        const act = btn.getAttribute('data-kbw-toast-action');
        if (act === 'open' && typeof onAction === 'function') {
          dismiss();
          onAction();
        } else if (act === 'dismiss') {
          dismiss();
        }
      });

      doc.body.appendChild(toast);
      actionToastTimer = setTimeout(dismiss, 6500);
    }

    async function fetchJson(url, options) {
      const fetchFn = getFetch();
      if (!fetchFn) {
        const err = new Error('Fetch API unavailable');
        err.offline = true;
        throw err;
      }
      const res = await fetchFn(url, options);
      let data = null;
      try {
        if (res && typeof res.json === 'function') {
          data = await res.json();
        } else if (res && typeof res.text === 'function') {
          const txt = await res.text();
          data = txt ? JSON.parse(txt) : null;
        }
      } catch (_) {
        data = null;
      }
      return {
        ok: Boolean(res && res.ok),
        status: res && typeof res.status === 'number' ? res.status : 0,
        data,
      };
    }

    function humanizeActorsInText(text) {
      return stripEmDash(text == null ? '' : text)
        .replace(/@\[(?:local|tailscale):user:[^\]+]+\+([^\]]+)\]/gi, '@$1')
        .replace(/@\[(?:local|tailscale):user:([^\]@]+)@[^\]]+\]/gi, '@$1')
        .replace(/@\[(?:local|tailscale):user:([^\]]+)\]/gi, '@$1')
        .replace(/@ubuntu\/([a-zA-Z0-9._-]+)/gi, '@$1');
    }

    function normalizeMindLink(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const kind = String(raw.kind || raw.type || '').toLowerCase().trim();
      const view = String(raw.view || raw.targetView || '').toLowerCase().trim();
      const target = String(raw.target || raw.id || raw.key || raw.path || raw.slug || '').trim();
      const key = String(raw.key || raw.id || raw.target || raw.path || raw.slug || '').trim();
      const label = stripEmDash(raw.label || raw.name || raw.title || target || key).trim();
      if (!label) return null;
      return {
        kind: kind || (raw.path ? 'doc' : view || 'person'),
        view,
        target: target || key || label,
        key: key || target || label,
        path: String(raw.path || '').trim(),
        channel: normalizeChannel(raw.channel || ''),
        threadId: String(raw.threadId || '').trim(),
        label: truncateWordBoundary(label, 28),
      };
    }

    function extractStructuredFenceSummary(text) {
      const str = String(text == null ? '' : text);
      const match = /```[^\n]*\r?\n([\s\S]*?)(?:```|$)/.exec(str);
      if (!match || !match[1]) return '';
      const body = match[1].trim();
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          const cand =
            parsed.summary || parsed.rule || parsed.title || parsed.verdict ||
            parsed.takeaway || parsed.note || parsed.statement || parsed.text || '';
          if (typeof cand === 'string' && cand.trim()) return cand.trim();
        }
      } catch (_) {
        const fieldMatch = /"(?:summary|rule|title|verdict|takeaway|note|statement|text)"\s*:\s*"([^"\\]{4,180})/.exec(body);
        if (fieldMatch && fieldMatch[1]) return fieldMatch[1].trim();
      }
      return '';
    }

    function stripStructuredFences(text) {
      const str = String(text == null ? '' : text);
      if (!str.includes('```')) return str;
      return str
        .replace(/```[^\n]*\r?\n?[\s\S]*?```/g, ' ')
        .replace(/```[a-zA-Z0-9_#@:./+-]*[\s\S]*$/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function computeBlockedAgeInfo(t) {
      const rawTs = t.blockedAt || t.lastAt || t.createdAt;
      if (!rawTs) return { ageLabel: 'waiting', pct: 35 };
      const ts = typeof rawTs === 'number' ? rawTs : Date.parse(String(rawTs));
      if (!Number.isFinite(ts)) return { ageLabel: 'waiting', pct: 35 };
      const diffMs = Math.max(0, Date.now() - ts);
      const totalMin = Math.floor(diffMs / 60000);
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      let ageLabel;
      if (days >= 1) {
        ageLabel = `${days}d ${String(hours).padStart(2, '0')}h`;
      } else if (hours >= 1) {
        ageLabel = `${hours}h ${String(mins).padStart(2, '0')}m`;
      } else {
        ageLabel = `${Math.max(1, mins)}m`;
      }
      const hoursFloat = diffMs / 3600000;
      const pct = Math.round(Math.max(14, Math.min(100, (Math.log1p(hoursFloat) / Math.log1p(72)) * 100)));
      return { ageLabel, pct };
    }

    function normalizeThreadItem(raw, fallbackChannel) {
      const outer = raw && typeof raw === 'object' ? raw : {};
      const msg = outer.root && typeof outer.root === 'object' ? outer.root : outer;
      const threadId = String(
        msg.threadId || msg.thread || msg.id || msg.numericId || msg.rootId ||
        outer.threadId || outer.thread || outer.id || outer.numericId || outer.rootId || ''
      ).trim();
      const channel = normalizeChannel(
        msg.channel || msg.room || outer.channel || outer.room || fallbackChannel || 'box'
      );
      const rawTextUnfenced = humanizeActorsInText(
        msg.text || msg.preview || msg.summary || msg.snippet ||
        outer.text || outer.preview || outer.summary || outer.snippet || ''
      ).trim();
      const rawText = (stripStructuredFences(rawTextUnfenced) || extractStructuredFenceSummary(rawTextUnfenced)).trim();
      const firstLine = rawText.split('\n').map((l) => l.trim()).find(Boolean) || '';
      const rawTitleCandidate = humanizeActorsInText(
        msg.title || msg.subject || outer.title || outer.subject || firstLine || `Thread ${formatShortThreadId(threadId)}`
      ).trim();
      const rawTitle = (
        stripStructuredFences(rawTitleCandidate) ||
        extractStructuredFenceSummary(rawTitleCandidate) ||
        firstLine ||
        `Thread ${formatShortThreadId(threadId)}`
      ).trim();
      const title = truncateWordBoundary(rawTitle, 84);
      const rawExcerptUnfenced = humanizeActorsInText(
        msg.excerpt || msg.summary || outer.excerpt || outer.summary || ''
      );
      let excerpt = (
        stripStructuredFences(rawExcerptUnfenced) ||
        extractStructuredFenceSummary(rawExcerptUnfenced)
      ).replace(/\s+/g, ' ').trim();
      if (!excerpt && rawText && rawText.toLowerCase() !== rawTitle.toLowerCase()) {
        excerpt = truncateWordBoundary(rawText, 120);
      } else if (excerpt) {
        excerpt = truncateWordBoundary(excerpt, 120);
      }
      if (excerpt && excerpt.toLowerCase() === title.toLowerCase()) {
        excerpt = '';
      }
      const identity = parseAgentIdentity(
        msg.byActor || msg.by || msg.author || msg.lastAuthor || msg.agent ||
        outer.byActor || outer.by || outer.author || outer.lastAuthor || outer.agent,
        msg.brand || msg.lastBrand || outer.brand || outer.lastBrand,
        msg.displayName || msg.authorName || outer.displayName || outer.authorName,
        msg.byProfile || outer.byProfile
      );
      const replyPreview = outer.replyPreview !== undefined ? outer.replyPreview : (msg.replyPreview ?? null);
      const repliesRaw =
        msg.replies ?? msg.replyCount ?? msg.repliesCount ?? msg.messagesCount ??
        outer.replies ?? outer.replyCount ?? outer.repliesCount ?? outer.messagesCount ??
        (Array.isArray(replyPreview) ? replyPreview.length : 0);
      const replies = Number.isFinite(Number(repliesRaw)) ? Math.max(0, Number(repliesRaw)) : 0;
      const lastAt =
        msg.lastAt || msg.updatedAt || msg.createdAt || msg.lastAtMs || msg.createdAtMs ||
        outer.lastAt || outer.updatedAt || outer.createdAt || outer.lastAtMs || outer.createdAtMs || '';
      const createdAt =
        msg.createdAt || msg.createdAtMs || outer.createdAt || outer.createdAtMs || '';
      const blockedAt =
        (msg.task && msg.task.blocked && (msg.task.blocked.since || msg.task.blocked.at)) ||
        (outer.task && outer.task.blocked && (outer.task.blocked.since || outer.task.blocked.at)) ||
        msg.blockedAt || outer.blockedAt || '';
      const rawParticipants = safeArray(
        (Array.isArray(outer.participants) && outer.participants.length ? outer.participants : null) ||
        msg.participants || msg.agents || outer.agents
      );
      const participants = rawParticipants
        .slice(0, 4)
        .map((p) => {
          if (typeof p === 'string') return parseAgentIdentity(p, '', '', null);
          return parseAgentIdentity(p.actor || p.handle || p.by, p.brand, p.displayName || p.label, p.profile);
        });
      const mindLinks = safeArray(
        (Array.isArray(msg.mindLinks) && msg.mindLinks.length ? msg.mindLinks : null) ||
        outer.mindLinks || msg.links || outer.links || msg.entities || outer.entities
      )
        .map(normalizeMindLink)
        .filter(Boolean)
        .slice(0, 3);

      const taskState = String(
        msg.taskState || (msg.task && msg.task.state) ||
        outer.taskState || (outer.task && outer.task.state) || ''
      ).toLowerCase();
      const isBlocked = Boolean(
        msg.isBlocked || outer.isBlocked || taskState === 'blocked' ||
        (msg.task && msg.task.blocked) || (outer.task && outer.task.blocked)
      );
      const isOpenTask = Boolean(
        msg.isOpenTask || outer.isOpenTask ||
        taskState === 'open' || taskState === 'ready' || taskState === 'running'
      );
      const signal = outer.signal !== undefined ? outer.signal : (msg.signal ?? null);
      const matchedTerms = safeArray(outer.matchedTerms || msg.matchedTerms);

      return {
        threadId,
        shortId: formatShortThreadId(threadId || msg.numericId || outer.numericId),
        channel,
        title,
        excerpt,
        identity,
        replies,
        lastAt,
        createdAt,
        blockedAt,
        participants,
        mindLinks,
        isBlocked,
        isOpenTask,
        signal,
        matchedTerms,
        replyPreview,
      };
    }

    function normalizeRoomsList(raw) {
      const list = safeArray(raw && raw.rooms ? raw.rooms : raw);
      const seen = new Set();
      const merged = [];
      const addRoom = (ch, groupLabel) => {
        const clean = normalizeChannel(ch);
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        merged.push({
          channel: clean,
          groupLabel: stripEmDash(groupLabel || clean.split('/')[0] || 'Rooms'),
          label: clean,
        });
      };
      DEFAULT_ROOMS.forEach((r) => addRoom(r.channel, r.groupLabel));
      list.forEach((r) => {
        if (typeof r === 'string') addRoom(r, '');
        else if (r && r.channel) addRoom(r.channel, r.groupLabel || r.group || '');
      });
      return merged;
    }

    function isSlotActive(slotEl, seq) {
      if (!slotEl || slotEl.__kbwSeq !== seq) return false;
      if (slotEl.isConnected === false) return false;
      return true;
    }

    function beginSlotMount(slotEl) {
      const seq = ++seqCounter;
      slotEl.__kbwSeq = seq;
      return seq;
    }

    function renderOfflineCardHtml(title, subtitle, showRetry) {
      return (
        `<section class="kbw-card is-compact is-offline" data-kbw-widget="offline">` +
          `<div class="kbw-offline-row">` +
            `<div class="kbw-title-wrap">` +
              `<span class="kbw-live-dot is-offline" aria-hidden="true"></span>` +
              `<span class="kbw-title">${escHtml(title)}</span>` +
              `<span class="kbw-sub-badge">${escHtml(subtitle || 'Offline')}</span>` +
            `</div>` +
            `<div class="kbw-head-actions">` +
              (showRetry
                ? `<button type="button" class="kbw-btn" data-kbw-action="retry">Retry</button>`
                : '') +
              `<button type="button" class="kbw-btn" data-kbw-action="open-board-default">Open Board -&gt;</button>` +
            `</div>` +
          `</div>` +
        `</section>`
      );
    }

    function renderThreadRowHtml(t, opts) {
      const showExcerpt = !(opts && opts.compact);
      const replyLabel = t.replies === 1 ? '1 reply' : `${t.replies} replies`;
      const relTime = formatRelativeTime(t.lastAt);
      const participantHtml = t.participants.length > 1
        ? `<span class="kbw-brand-dots" aria-label="Participating agents">${t.participants
            .map((p) => `<span class="kbw-brand-dot is-${escAttr(p.brand)}" title="${escAttr(p.label)}"></span>`)
            .join('')}</span>`
        : '';
      const statusHtml = t.isBlocked
        ? `<span class="kbw-status-pill is-blocked">Blocked</span>`
        : t.isOpenTask
          ? `<span class="kbw-status-pill is-open">Open</span>`
          : '';
      const linksHtml = t.mindLinks.length
        ? `<span class="kbw-mind-links">${t.mindLinks
            .map(
              (link) =>
                `<button type="button" class="kbw-mind-pill" ` +
                  `data-kbw-mind-kind="${escAttr(link.kind)}" ` +
                  `data-kbw-mind-view="${escAttr(link.view || '')}" ` +
                  `data-kbw-mind-target="${escAttr(link.target || link.key)}" ` +
                  `data-kbw-mind-key="${escAttr(link.key)}" ` +
                  `data-kbw-mind-path="${escAttr(link.path)}" ` +
                  `data-kbw-mind-channel="${escAttr(link.channel)}" ` +
                  `data-kbw-mind-thread="${escAttr(link.threadId)}"` +
                `>${escHtml(link.label)}</button>`
            )
            .join('')}</span>`
        : '';

      const showBlockedAgeBar = Boolean(opts && opts.showBlockedAgeBar && t.isBlocked);
      let blockedAgeHtml = '';
      if (showBlockedAgeBar) {
        const ageInfo = computeBlockedAgeInfo(t);
        blockedAgeHtml =
          `<div class="kbw-age-bar-row" aria-label="Blocked waiting age ${escAttr(ageInfo.ageLabel)}">` +
            `<div class="kbw-age-track" aria-hidden="true"><div class="kbw-age-fill" style="width:${escAttr(String(ageInfo.pct))}%"></div></div>` +
            `<span class="kbw-age-label">${escHtml(ageInfo.ageLabel)}</span>` +
          `</div>`;
      }

      return (
        `<div class="kbw-thread-row${showBlockedAgeBar ? ' is-blocked-pulse' : ''}" role="button" tabindex="0" ` +
          `data-kbw-action="open-thread" ` +
          `data-kbw-channel="${escAttr(t.channel)}" ` +
          `data-kbw-thread-id="${escAttr(t.threadId)}">` +
          `<div class="kbw-thread-top">` +
            renderGlyphBadgeHtml(t.identity) +
            `<span class="kbw-thread-title">${escHtml(t.title)}</span>` +
            statusHtml +
          `</div>` +
          (showExcerpt && t.excerpt
            ? `<div class="kbw-thread-excerpt">${escHtml(t.excerpt)}</div>`
            : '') +
          blockedAgeHtml +
          `<div class="kbw-thread-meta">` +
            `<span class="kbw-room-tag">#${escHtml(t.channel)}</span>` +
            `<span>${escHtml(t.identity.label)}</span>` +
            participantHtml +
            `<span class="kbw-reply-count">${ICONS.reply} ${escHtml(replyLabel)}</span>` +
            (relTime ? `<span>${escHtml(relTime)}</span>` : '') +
            linksHtml +
          `</div>` +
        `</div>`
      );
    }

    function handleMindLinkClick(linkEl, hooks) {
      const h = hooks && typeof hooks === 'object' ? hooks : {};
      const kind = (linkEl.getAttribute('data-kbw-mind-kind') || '').toLowerCase().trim();
      const view = (linkEl.getAttribute('data-kbw-mind-view') || '').toLowerCase().trim();
      const target = linkEl.getAttribute('data-kbw-mind-target') || '';
      const key = linkEl.getAttribute('data-kbw-mind-key') || '';
      const docPath = linkEl.getAttribute('data-kbw-mind-path') || '';
      const channel = linkEl.getAttribute('data-kbw-mind-channel') || '';
      const threadId = linkEl.getAttribute('data-kbw-mind-thread') || '';
      const resolvedTarget = target || docPath || key;
      playSound('tick');

      if (kind === 'person' || view === 'person' || view === 'people') {
        if (typeof h.openPerson === 'function' && resolvedTarget) {
          h.openPerson(resolvedTarget);
          return;
        }
        if (typeof h.openView === 'function') {
          h.openView('people', resolvedTarget);
          return;
        }
      }
      if (kind === 'doc' || kind === 'vault' || kind === 'note' || view === 'vault' || view === 'doc') {
        if (typeof h.openDoc === 'function' && (docPath || resolvedTarget)) {
          h.openDoc(docPath || resolvedTarget);
          return;
        }
        if (typeof h.openView === 'function') {
          h.openView('vault', docPath || resolvedTarget);
          return;
        }
      }
      const viewTarget = view || (
        kind === 'codex' || kind === 'taste' || kind === 'replay' || kind === 'commit'
          ? kind
          : ''
      );
      if (viewTarget && typeof h.openView === 'function') {
        h.openView(viewTarget, resolvedTarget);
        return;
      }
      if (channel || threadId) {
        invokeOpenBoard(h, { channel: channel || 'box', threadId: threadId || undefined, stage: threadId ? 'thread' : undefined });
        return;
      }
      if (docPath && typeof h.openDoc === 'function') {
        h.openDoc(docPath);
      } else if (key && typeof h.openPerson === 'function') {
        h.openPerson(key);
      }
    }

    // =========================================================================
    // 1. TODAY MISSION PULSE WIDGET
    // =========================================================================
    async function loadTodayPulse(forceRefresh) {
      const now = Date.now();
      if (!forceRefresh && todayPulseCache && now - todayPulseCache.ts < TODAY_PULSE_TTL_MS) {
        return todayPulseCache.data;
      }
      if (!forceRefresh && todayPulseInFlight) {
        return todayPulseInFlight;
      }
      const req = fetchJson('/api/agent-board/today-pulse')
        .then((res) => {
          todayPulseInFlight = null;
          if (!res.ok || !res.data) {
            return { available: false };
          }
          const data = res.data;
          todayPulseCache = { ts: Date.now(), data };
          return data;
        })
        .catch(() => {
          todayPulseInFlight = null;
          return { available: false };
        });
      todayPulseInFlight = req;
      return req;
    }

    function fastRowSig(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    function patchKeyedThreadList(listEl, threads, opts) {
      const doc = getDoc();
      if (!listEl || !doc || typeof doc.createElement !== 'function') return false;
      const existingByKey = new Map();
      let child = listEl.firstElementChild;
      while (child) {
        const next = child.nextElementSibling;
        const k = child.getAttribute && child.getAttribute('data-kbw-thread-id');
        if (k && child.classList && child.classList.contains('kbw-thread-row') && !existingByKey.has(k)) {
          existingByKey.set(k, child);
        } else {
          listEl.removeChild(child);
        }
        child = next;
      }

      const scratch = doc.createElement('div');
      const nextOrder = [];
      for (let i = 0; i < threads.length; i += 1) {
        const t = threads[i];
        const html = renderThreadRowHtml(t, opts);
        const sig = fastRowSig(html);
        const key = String(t.threadId || `row-${i}`);
        let node = existingByKey.get(key);
        if (node) {
          existingByKey.delete(key);
          if (node.getAttribute('data-kbw-sig') !== sig) {
            scratch.innerHTML = html;
            const fresh = scratch.firstElementChild;
            if (fresh) {
              node.className = fresh.className;
              node.innerHTML = fresh.innerHTML;
              node.setAttribute('data-kbw-sig', sig);
            }
          }
        } else {
          scratch.innerHTML = html;
          node = scratch.firstElementChild;
          if (node) node.setAttribute('data-kbw-sig', sig);
        }
        if (node) nextOrder.push(node);
      }

      for (const leftover of existingByKey.values()) {
        if (leftover.parentNode === listEl) listEl.removeChild(leftover);
      }

      let cursor = listEl.firstElementChild;
      for (let i = 0; i < nextOrder.length; i += 1) {
        const desired = nextOrder[i];
        if (desired === cursor) {
          cursor = cursor.nextElementSibling;
        } else {
          listEl.insertBefore(desired, cursor || null);
        }
      }
      return true;
    }

    function renderTodayPulseInto(slotEl, data, hooks, onRetry) {
      ensureStylesInjected();
      if (!data || data.available === false || data.ok === false || data.boardOnline === false) {
        slotEl.innerHTML = renderOfflineCardHtml('Agent Board Mission Pulse', 'Board offline', true);
        const card = slotEl.firstElementChild;
        if (card) {
          card.addEventListener('click', (ev) => {
            const btn = ev.target && typeof ev.target.closest === 'function'
              ? ev.target.closest('[data-kbw-action]')
              : null;
            if (!btn) return;
            const act = btn.getAttribute('data-kbw-action');
            if (act === 'retry' && typeof onRetry === 'function') onRetry();
            if (act === 'open-board-default') invokeOpenBoard(hooks, { mode: 'rooms', channel: 'box' });
          });
        }
        return;
      }

      const counts = data.counts || data.kpis || data.totals || {};
      const openDecisions = Number(
        data.openDecisions ??
        counts.openDecisions ??
        counts.decisions ??
        counts.openTasks ??
        (Array.isArray(data.decisions) ? data.decisions.length : 0)
      ) || 0;
      const blocked = Number(
        data.blocked ??
        counts.blocked ??
        counts.blockers ??
        counts.attentionTotal ??
        (Array.isArray(data.blockers) ? data.blockers.length : 0)
      ) || 0;
      const rawAgents = safeArray(data.activeAgents || data.agents);
      const activeAgentsCount = Number(
        data.activeAgentsCount ??
        counts.activeAgents ??
        (typeof data.activeAgents === 'number' ? data.activeAgents : rawAgents.length)
      ) || 0;

      const agentBrands = rawAgents.length
        ? rawAgents
            .slice(0, 5)
            .map((a) =>
              typeof a === 'string'
                ? parseAgentIdentity(a, '', '', null)
                : parseAgentIdentity(a.actor || a.handle || a.name, a.brand, a.displayName, a.profile)
            )
        : activeAgentsCount > 0
          ? [
              { brand: 'claude', label: 'Claude' },
              { brand: 'codex', label: 'Codex' },
              { brand: 'brain', label: 'Orchestrator' },
            ].slice(0, Math.min(3, activeAgentsCount))
          : [];

      const rawThreads = safeArray(
        data.threads || data.topThreads || data.highlights || data.items
      );
      const threads = rawThreads.slice(0, 4).map((t) => normalizeThreadItem(t, 'box'));

      const brandDotsHtml = agentBrands.length
        ? `<span class="kbw-brand-dots" aria-hidden="true">${agentBrands
            .map((a) => `<span class="kbw-brand-dot is-${escAttr(a.brand)}" title="${escAttr(a.label)}"></span>`)
            .join('')}</span>`
        : '';

      // Reuse already-mounted Today Pulse card & patch thread rows by key
      const existingCard =
        slotEl.firstElementChild &&
        slotEl.firstElementChild.getAttribute &&
        slotEl.firstElementChild.getAttribute('data-kbw-widget') === 'today-pulse'
          ? slotEl.firstElementChild
          : null;
      if (existingCard && threads.length > 0) {
        const existingList = existingCard.querySelector('.kbw-thread-list');
        const kpiRow = existingCard.querySelector('.kbw-kpi-row');
        if (existingList && kpiRow) {
          const decNum = kpiRow.querySelector('[data-kbw-action="open-decisions"] .kbw-kpi-num');
          if (decNum) decNum.textContent = String(openDecisions);
          const blkNum = kpiRow.querySelector('[data-kbw-action="open-blockers"] .kbw-kpi-num');
          if (blkNum) blkNum.textContent = String(blocked);
          const agNum = kpiRow.querySelector('[data-kbw-action="open-agents"] .kbw-kpi-num');
          if (agNum) agNum.textContent = String(activeAgentsCount);
          if (patchKeyedThreadList(existingList, threads, { showBlockedAgeBar: true })) {
            return;
          }
        }
      }

      slotEl.innerHTML =
        `<section class="kbw-card" data-kbw-widget="today-pulse">` +
          `<header class="kbw-head">` +
            `<div class="kbw-title-wrap">` +
              `<span class="kbw-live-dot" aria-hidden="true"></span>` +
              `<h3 class="kbw-title">Agent Board Mission Pulse</h3>` +
              (counts.channels ? `<span class="kbw-sub-badge">${escHtml(String(counts.channels))} rooms</span>` : '') +
            `</div>` +
            `<div class="kbw-head-actions">` +
              `<button type="button" class="kbw-btn is-primary" data-kbw-action="dispatch-today">${ICONS.plus} Dispatch Task</button>` +
              `<button type="button" class="kbw-btn" data-kbw-action="open-board">Open in Board -&gt;</button>` +
            `</div>` +
          `</header>` +
          `<div class="kbw-kpi-row" role="group" aria-label="Agent Board status">` +
            `<button type="button" class="kbw-kpi-pill${openDecisions > 0 ? ' is-warn' : ''}" data-kbw-action="open-decisions">` +
              `<span class="kbw-kpi-num">${escHtml(String(openDecisions))}</span> Open Decisions` +
            `</button>` +
            `<button type="button" class="kbw-kpi-pill${blocked > 0 ? ' is-danger' : ''}" data-kbw-action="open-blockers">` +
              `<span class="kbw-kpi-num">${escHtml(String(blocked))}</span> Blocked` +
            `</button>` +
            `<button type="button" class="kbw-kpi-pill" data-kbw-action="open-agents">` +
              brandDotsHtml +
              `<span class="kbw-kpi-num">${escHtml(String(activeAgentsCount))}</span> Active Agents` +
            `</button>` +
          `</div>` +
          (threads.length
            ? `<div class="kbw-thread-list">${threads.map((t) => renderThreadRowHtml(t, { showBlockedAgeBar: true })).join('')}</div>`
            : `<div class="kbw-empty-note">Board is quiet. Dispatch a task to kick off a multi-agent thread.</div>`) +
        `</section>`;

      const card = slotEl.firstElementChild;
      if (!card) return;

      const handleActivation = (ev) => {
        const mindPill = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-mind-kind]')
          : null;
        if (mindPill) {
          ev.stopPropagation();
          handleMindLinkClick(mindPill, hooks);
          return;
        }
        const actionEl = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-action]')
          : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-kbw-action');
        playSound('tick');
        if (action === 'open-board') {
          invokeOpenBoard(hooks, { mode: 'rooms', channel: 'box' });
        } else if (action === 'open-decisions') {
          invokeOpenBoard(hooks, { channel: 'kizuki/decisions', stage: 'canvas' });
        } else if (action === 'open-blockers') {
          invokeOpenBoard(hooks, { mode: 'blockers' });
        } else if (action === 'open-agents') {
          invokeOpenBoard(hooks, { mode: 'feed', stage: 'live' });
        } else if (action === 'dispatch-today') {
          openBoardDispatchModal(
            {
              sourceKind: 'today',
              sourceId: 'today-pulse',
              sourceLabel: 'Today Morning Brief',
              defaultChannel: 'box/work',
              defaultAgent: 'claude',
              defaultText: '',
            },
            hooks
          );
        } else if (action === 'open-thread') {
          invokeOpenBoard(hooks, {
            channel: actionEl.getAttribute('data-kbw-channel') || 'box',
            threadId: actionEl.getAttribute('data-kbw-thread-id') || undefined,
            stage: 'thread',
          });
        }
      };

      card.addEventListener('click', handleActivation);
      card.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const row = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.kbw-thread-row[data-kbw-action="open-thread"]')
          : null;
        if (!row) return;
        ev.preventDefault();
        handleActivation(ev);
      });
    }

    function mountTodayPulse(slotEl, hooks) {
      if (!slotEl) return Promise.resolve(null);
      ensureStylesInjected();
      const seq = beginSlotMount(slotEl);
      const retry = () => mountTodayPulseForce(slotEl, hooks);

      // Instant synchronous render when 15s cache is warm (zero flicker!)
      if (todayPulseCache && Date.now() - todayPulseCache.ts < TODAY_PULSE_TTL_MS) {
        renderTodayPulseInto(slotEl, todayPulseCache.data, hooks, retry);
        return Promise.resolve(todayPulseCache.data);
      }

      return loadTodayPulse(false).then((data) => {
        if (!isSlotActive(slotEl, seq)) return null;
        renderTodayPulseInto(slotEl, data, hooks, retry);
        return data;
      });
    }

    function mountTodayPulseForce(slotEl, hooks) {
      if (!slotEl) return Promise.resolve(null);
      const seq = beginSlotMount(slotEl);
      return loadTodayPulse(true).then((data) => {
        if (!isSlotActive(slotEl, seq)) return null;
        renderTodayPulseInto(slotEl, data, hooks, () => mountTodayPulseForce(slotEl, hooks));
        return data;
      });
    }

    // =========================================================================
    // ENTITY THREADS LOADER (SHARED 30S TTL CACHE FOR PERSON / CODEX / TASTE)
    // =========================================================================
    async function loadEntityThreads(kind, key, limit, opts) {
      const cleanKind = String(kind || '').trim().toLowerCase();
      const cleanKey = String(key || '').trim();
      const lim = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 6;
      const cacheKey = `${cleanKind}:${cleanKey}:${lim}`;
      const forceRefresh = Boolean(opts && opts.forceRefresh);
      const now = Date.now();

      if (!forceRefresh && entityThreadsCache.has(cacheKey)) {
        const entry = entityThreadsCache.get(cacheKey);
        if (now - entry.ts < ENTITY_THREADS_TTL_MS) {
          return entry.data;
        }
      }
      if (!forceRefresh && entityThreadsInFlight.has(cacheKey)) {
        return entityThreadsInFlight.get(cacheKey);
      }

      const url = `/api/agent-board/entity-threads?kind=${encodeURIComponent(cleanKind)}&key=${encodeURIComponent(cleanKey)}&limit=${encodeURIComponent(String(lim))}`;
      const preferFallback = Boolean(
        opts && opts.fallbackUrl && (opts.preferFallback || (cleanKind === 'taste' && cleanKey.toLowerCase() === 'all'))
      );

      const req = (async () => {
        try {
          if (preferFallback && opts && opts.fallbackUrl) {
            const fbDirect = await fetchJson(opts.fallbackUrl);
            if (fbDirect.ok && fbDirect.data && fbDirect.data.available !== false) {
              const fbThreads = safeArray(fbDirect.data.threads || fbDirect.data.items);
              if (fbThreads.length > 0) {
                const payload = Object.assign({ available: true }, fbDirect.data);
                entityThreadsCache.set(cacheKey, { ts: Date.now(), data: payload });
                return payload;
              }
            }
          }
          const res = await fetchJson(url);
          if (res.ok && res.data && res.data.available !== false) {
            const list = safeArray(res.data.threads || res.data.items);
            if (list.length === 0 && opts && opts.fallbackUrl) {
              const fbEmpty = await fetchJson(opts.fallbackUrl);
              if (fbEmpty.ok && fbEmpty.data && fbEmpty.data.available !== false) {
                const payload = Object.assign({ available: true }, fbEmpty.data);
                entityThreadsCache.set(cacheKey, { ts: Date.now(), data: payload });
                return payload;
              }
            }
            const payload = Object.assign({ available: true }, res.data);
            entityThreadsCache.set(cacheKey, { ts: Date.now(), data: payload });
            return payload;
          }
          if (opts && opts.fallbackUrl) {
            const fb = await fetchJson(opts.fallbackUrl);
            if (fb.ok && fb.data && fb.data.available !== false) {
              const payload = Object.assign({ available: true }, fb.data);
              entityThreadsCache.set(cacheKey, { ts: Date.now(), data: payload });
              return payload;
            }
          }
          if (res.data && res.data.available === false) {
            return { available: false, threads: [] };
          }
          return { available: false, threads: [] };
        } catch (_) {
          if (opts && opts.fallbackUrl) {
            try {
              const fb = await fetchJson(opts.fallbackUrl);
              if (fb.ok && fb.data && fb.data.available !== false) {
                const payload = Object.assign({ available: true }, fb.data);
                entityThreadsCache.set(cacheKey, { ts: Date.now(), data: payload });
                return payload;
              }
            } catch (_) {
              // fall through
            }
          }
          return { available: false, threads: [] };
        } finally {
          entityThreadsInFlight.delete(cacheKey);
        }
      })();

      entityThreadsInFlight.set(cacheKey, req);
      return req;
    }

    // =========================================================================
    // 2. PERSON PROFILE AGENT BOARD DISCUSSIONS WIDGET
    // =========================================================================
    function renderPersonBoardInto(slotEl, personObj, data, hooks, onRetry) {
      ensureStylesInjected();
      const personName = stripEmDash(personObj.name || personObj.key || 'Person').trim();
      const personKey = String(personObj.key || personObj.name || '').trim();
      const handles = safeArray(personObj.handles).map((h) => stripEmDash(String(h)).trim()).filter(Boolean);

      if (!data || data.available === false) {
        slotEl.innerHTML = renderOfflineCardHtml('Agent Board Discussions', 'Board offline', true);
        const card = slotEl.firstElementChild;
        if (card) {
          card.addEventListener('click', (ev) => {
            const btn = ev.target && typeof ev.target.closest === 'function'
              ? ev.target.closest('[data-kbw-action]')
              : null;
            if (!btn) return;
            const act = btn.getAttribute('data-kbw-action');
            if (act === 'retry' && typeof onRetry === 'function') onRetry();
            if (act === 'open-board-default') invokeOpenBoard(hooks, { mode: 'rooms', channel: 'box' });
          });
        }
        return;
      }

      const rawThreads = safeArray(data.threads || data.items);
      const threads = rawThreads.slice(0, 6).map((t) => normalizeThreadItem(t, 'box'));

      const existingPersonCard =
        slotEl.firstElementChild &&
        slotEl.firstElementChild.getAttribute &&
        slotEl.firstElementChild.getAttribute('data-kbw-widget') === 'person-board' &&
        slotEl.firstElementChild.getAttribute('data-kbw-person-key') === personKey
          ? slotEl.firstElementChild
          : null;
      if (existingPersonCard && threads.length > 0) {
        const existingList = existingPersonCard.querySelector('.kbw-thread-list');
        const badge = existingPersonCard.querySelector('.kbw-sub-badge');
        if (existingList) {
          if (badge) badge.textContent = String(threads.length);
          if (patchKeyedThreadList(existingList, threads)) {
            return;
          }
        }
      }

      slotEl.innerHTML =
        `<section class="kbw-card" data-kbw-widget="person-board" data-kbw-person-key="${escAttr(personKey)}">` +
          `<header class="kbw-head">` +
            `<div class="kbw-title-wrap">` +
              `<span class="kbw-live-dot" aria-hidden="true"></span>` +
              `<h3 class="kbw-title">Agent Board Discussions</h3>` +
              `<span class="kbw-sub-badge">${escHtml(String(threads.length))}</span>` +
            `</div>` +
            `<div class="kbw-head-actions">` +
              `<button type="button" class="kbw-btn is-primary" data-kbw-action="brief-person">${ICONS.plus} Brief Agents on ${escHtml(personName)}</button>` +
            `</div>` +
          `</header>` +
          (threads.length
            ? `<div class="kbw-thread-list">${threads.map((t) => renderThreadRowHtml(t)).join('')}</div>`
            : `<div class="kbw-empty-note">No Agent Board threads mention ${escHtml(personName)} yet.</div>`) +
        `</section>`;

      const card = slotEl.firstElementChild;
      if (!card) return;

      const handleClick = (ev) => {
        const mindPill = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-mind-kind]')
          : null;
        if (mindPill) {
          ev.stopPropagation();
          handleMindLinkClick(mindPill, hooks);
          return;
        }
        const actionEl = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-action]')
          : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-kbw-action');
        playSound('tick');
        if (action === 'brief-person') {
          const handleSuffix = handles.length ? ` (${handles.slice(0, 3).join(', ')})` : '';
          openBoardDispatchModal(
            {
              sourceKind: 'person',
              sourceId: personKey,
              sourceLabel: personName,
              defaultChannel: 'box/work',
              defaultAgent: 'orchestrator',
              defaultText: `Brief on ${personName}${handleSuffix}: `,
            },
            hooks
          );
        } else if (action === 'open-thread') {
          invokeOpenBoard(hooks, {
            channel: actionEl.getAttribute('data-kbw-channel') || 'box',
            threadId: actionEl.getAttribute('data-kbw-thread-id') || undefined,
            stage: 'thread',
          });
        }
      };

      card.addEventListener('click', handleClick);
      card.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const row = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.kbw-thread-row[data-kbw-action="open-thread"]')
          : null;
        if (!row) return;
        ev.preventDefault();
        handleClick(ev);
      });
    }

    function mountPersonBoard(slotEl, person, hooks) {
      if (!slotEl) return Promise.resolve(null);
      ensureStylesInjected();
      const seq = beginSlotMount(slotEl);
      const personObj = typeof person === 'string'
        ? { key: person, name: person }
        : (person && typeof person === 'object' ? person : { key: '', name: 'Person' });
      const key = String(personObj.key || personObj.name || '').trim();
      if (!key) {
        renderPersonBoardInto(slotEl, personObj, { available: true, threads: [] }, hooks, null);
        return Promise.resolve({ available: true, threads: [] });
      }

      const cacheKey = `person:${key}:6`;
      const cached = entityThreadsCache.get(cacheKey);
      const retry = () => {
        const retrySeq = beginSlotMount(slotEl);
        return loadEntityThreads('person', key, 6, { forceRefresh: true }).then((data) => {
          if (!isSlotActive(slotEl, retrySeq)) return null;
          renderPersonBoardInto(slotEl, personObj, data, hooks, retry);
          return data;
        });
      };

      if (cached && Date.now() - cached.ts < ENTITY_THREADS_TTL_MS) {
        renderPersonBoardInto(slotEl, personObj, cached.data, hooks, retry);
        return Promise.resolve(cached.data);
      }

      return loadEntityThreads('person', key, 6).then((data) => {
        if (!isSlotActive(slotEl, seq)) return null;
        renderPersonBoardInto(slotEl, personObj, data, hooks, retry);
        return data;
      });
    }

    // =========================================================================
    // 3. CODEX INLINE LINKED BOARD THREAD BADGE + DISPATCH LAUNCHER
    // =========================================================================
    function defaultChannelForCodexSection(section) {
      const s = String(section || '').toLowerCase();
      if (s.includes('decision') || s.includes('philosoph') || s.includes('principle')) {
        return 'kizuki/decisions';
      }
      if (s.includes('taste') || s.includes('design') || s.includes('aesthetic')) {
        return 'box/taste';
      }
      return 'box/work';
    }

    function renderCodexBoardBadgeInto(slotEl, itemObj, data, hooks) {
      ensureStylesInjected();
      const itemId = String(itemObj.id || itemObj.title || '').trim();
      const itemTitle = stripEmDash(itemObj.title || itemId || 'Codex Item').trim();
      const itemSection = stripEmDash(itemObj.section || 'codex').trim();
      const itemSummary = stripEmDash(itemObj.summary || '').trim();

      const offline = !data || data.available === false;
      const rawThreads = offline ? [] : safeArray(data.threads || data.items);
      const threads = rawThreads.slice(0, 4).map((t) => normalizeThreadItem(t, 'box/work'));

      const pillsHtml = threads
        .map((t) => {
          const replyText = t.replies === 1 ? '1 reply' : `${t.replies} replies`;
          const label = `${t.shortId || '#thread'} · ${t.channel} · ${replyText}`;
          return (
            `<button type="button" class="kbw-codex-pill" ` +
              `data-kbw-action="open-thread" ` +
              `data-kbw-channel="${escAttr(t.channel)}" ` +
              `data-kbw-thread-id="${escAttr(t.threadId)}" ` +
              `title="${escAttr(t.title)}">` +
              `<span class="kbw-brand-dot is-${escAttr(t.identity.brand)}" aria-hidden="true"></span>` +
              `<span>${escHtml(label)}</span>` +
            `</button>`
          );
        })
        .join('');

      const offlineHtml = offline
        ? `<span class="kbw-sub-badge" title="Agent Board offline">Board offline</span>`
        : '';

      slotEl.innerHTML =
        `<div class="kbw-inline-strip" data-kbw-widget="codex-badge" data-kbw-codex-id="${escAttr(itemId)}">` +
          pillsHtml +
          offlineHtml +
          `<button type="button" class="kbw-codex-dispatch-btn" data-kbw-action="dispatch-codex">` +
            `${ICONS.plus} Dispatch to Board` +
          `</button>` +
        `</div>`;

      const strip = slotEl.firstElementChild;
      if (!strip) return;

      strip.addEventListener('click', (ev) => {
        const btn = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-action]')
          : null;
        if (!btn) return;
        ev.stopPropagation();
        const action = btn.getAttribute('data-kbw-action');
        playSound('tick');
        if (action === 'open-thread') {
          invokeOpenBoard(hooks, {
            channel: btn.getAttribute('data-kbw-channel') || 'box/work',
            threadId: btn.getAttribute('data-kbw-thread-id') || undefined,
            stage: 'thread',
          });
        } else if (action === 'dispatch-codex') {
          const summarySnippet = itemSummary ? `\n\nContext: ${truncateWordBoundary(itemSummary, 240)}` : '';
          openBoardDispatchModal(
            {
              sourceKind: 'codex',
              sourceId: itemId,
              sourceLabel: itemTitle,
              defaultChannel: defaultChannelForCodexSection(itemSection),
              defaultAgent: itemSection.toLowerCase().includes('action') ? 'claude' : 'codex',
              defaultText: `[Codex · ${itemSection}] ${itemTitle}${summarySnippet}`,
            },
            hooks
          );
        }
      });
    }

    function mountCodexBoardBadge(slotEl, item, hooks) {
      if (!slotEl) return Promise.resolve(null);
      ensureStylesInjected();
      const seq = beginSlotMount(slotEl);
      const itemObj = item && typeof item === 'object' ? item : { id: String(item || ''), title: String(item || ''), section: 'codex' };
      const lookupKey = String(itemObj.id || itemObj.title || '').trim();
      if (!lookupKey) {
        renderCodexBoardBadgeInto(slotEl, itemObj, { available: true, threads: [] }, hooks);
        return Promise.resolve({ available: true, threads: [] });
      }

      const cacheKey = `codex:${lookupKey}:4`;
      const cached = entityThreadsCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < ENTITY_THREADS_TTL_MS) {
        renderCodexBoardBadgeInto(slotEl, itemObj, cached.data, hooks);
        return Promise.resolve(cached.data);
      }

      return loadEntityThreads('codex', lookupKey, 4).then((data) => {
        if (!isSlotActive(slotEl, seq)) return null;
        renderCodexBoardBadgeInto(slotEl, itemObj, data, hooks);
        return data;
      });
    }

    // =========================================================================
    // 4. TASTE STUDIO LIVE #box/taste AGENT CONSENSUS LEDGER
    // =========================================================================
    function renderTasteBoardLedgerInto(slotEl, domain, data, hooks, onRetry) {
      ensureStylesInjected();
      const cleanDomain = stripEmDash(domain || 'all').trim() || 'all';
      const domainTag = cleanDomain.toLowerCase() === 'all' ? '' : `<span class="kbw-sub-badge">${escHtml(cleanDomain)}</span>`;

      if (!data || data.available === false) {
        slotEl.innerHTML = renderOfflineCardHtml('Live #box/taste Agent Consensus Ledger', 'Board offline', true);
        const card = slotEl.firstElementChild;
        if (card) {
          card.addEventListener('click', (ev) => {
            const btn = ev.target && typeof ev.target.closest === 'function'
              ? ev.target.closest('[data-kbw-action]')
              : null;
            if (!btn) return;
            const act = btn.getAttribute('data-kbw-action');
            if (act === 'retry' && typeof onRetry === 'function') onRetry();
            if (act === 'open-board-default') invokeOpenBoard(hooks, { channel: 'box/taste', mode: 'taste' });
          });
        }
        return;
      }

      const rawThreads = safeArray(data.threads || data.items);
      const threads = rawThreads.slice(0, 6).map((t) => normalizeThreadItem(t, 'box/taste'));

      slotEl.innerHTML =
        `<section class="kbw-card" data-kbw-widget="taste-ledger" data-kbw-domain="${escAttr(cleanDomain)}">` +
          `<header class="kbw-head">` +
            `<div class="kbw-title-wrap">` +
              `<span class="kbw-live-dot" aria-hidden="true"></span>` +
              `<h3 class="kbw-title">Live #box/taste Agent Consensus Ledger</h3>` +
              domainTag +
            `</div>` +
            `<div class="kbw-head-actions">` +
              `<button type="button" class="kbw-btn is-primary" data-kbw-action="broadcast-taste">${ICONS.spark} Broadcast Rule to Agents</button>` +
              `<button type="button" class="kbw-btn" data-kbw-action="open-taste-room">Open #box/taste</button>` +
            `</div>` +
          `</header>` +
          (threads.length
            ? `<div class="kbw-thread-list">${threads.map((t) => renderThreadRowHtml(t)).join('')}</div>`
            : `<div class="kbw-empty-note">No recent #box/taste dispatches yet. Broadcast a rule to align every agent.</div>`) +
        `</section>`;

      const card = slotEl.firstElementChild;
      if (!card) return;

      const handleClick = (ev) => {
        const mindPill = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-mind-kind]')
          : null;
        if (mindPill) {
          ev.stopPropagation();
          handleMindLinkClick(mindPill, hooks);
          return;
        }
        const actionEl = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('[data-kbw-action]')
          : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-kbw-action');
        playSound('tick');
        if (action === 'open-taste-room') {
          invokeOpenBoard(hooks, { channel: 'box/taste', mode: 'taste' });
        } else if (action === 'broadcast-taste') {
          const domainPrefix = cleanDomain.toLowerCase() === 'all' ? 'Taste Rule' : `Taste Rule · ${cleanDomain}`;
          openBoardDispatchModal(
            {
              sourceKind: 'taste',
              sourceId: cleanDomain,
              sourceLabel: `Taste Studio (${cleanDomain})`,
              defaultChannel: 'box/taste',
              defaultAgent: '',
              defaultText: `[${domainPrefix}] `,
            },
            hooks
          );
        } else if (action === 'open-thread') {
          invokeOpenBoard(hooks, {
            channel: actionEl.getAttribute('data-kbw-channel') || 'box/taste',
            threadId: actionEl.getAttribute('data-kbw-thread-id') || undefined,
            mode: 'taste',
            stage: 'thread',
          });
        }
      };

      card.addEventListener('click', handleClick);
      card.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const row = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.kbw-thread-row[data-kbw-action="open-thread"]')
          : null;
        if (!row) return;
        ev.preventDefault();
        handleClick(ev);
      });
    }

    function mountTasteBoardLedger(slotEl, opts, hooks) {
      if (!slotEl) return Promise.resolve(null);
      ensureStylesInjected();
      const seq = beginSlotMount(slotEl);
      const o = opts && typeof opts === 'object' ? opts : {};
      const domain = String(o.domain || 'all').trim() || 'all';
      const fallbackUrl = '/api/agent-board/rooms/box%2Ftaste/threads?limit=6';
      const preferFallback = domain.toLowerCase() === 'all';
      const cacheKey = `taste:${domain}:6`;
      const cached = entityThreadsCache.get(cacheKey);

      const retry = () => {
        const retrySeq = beginSlotMount(slotEl);
        return loadEntityThreads('taste', domain, 6, { forceRefresh: true, fallbackUrl, preferFallback }).then((data) => {
          if (!isSlotActive(slotEl, retrySeq)) return null;
          renderTasteBoardLedgerInto(slotEl, domain, data, hooks, retry);
          return data;
        });
      };

      if (cached && Date.now() - cached.ts < ENTITY_THREADS_TTL_MS) {
        renderTasteBoardLedgerInto(slotEl, domain, cached.data, hooks, retry);
        return Promise.resolve(cached.data);
      }

      return loadEntityThreads('taste', domain, 6, { fallbackUrl, preferFallback }).then((data) => {
        if (!isSlotActive(slotEl, seq)) return null;
        renderTasteBoardLedgerInto(slotEl, domain, data, hooks, retry);
        return data;
      });
    }

    // =========================================================================
    // 5. SINGLETON EVIL RABBIT BOARD DISPATCH MODAL
    // =========================================================================
    async function loadLiveRooms() {
      const now = Date.now();
      if (roomsCache && now - roomsCache.ts < ROOMS_TTL_MS) {
        return roomsCache.rooms;
      }
      if (roomsInFlight) return roomsInFlight;
      roomsInFlight = fetchJson('/api/agent-board/rooms?sort=recent')
        .then((res) => {
          roomsInFlight = null;
          if (!res.ok || !res.data) return DEFAULT_ROOMS.slice();
          const normalized = normalizeRoomsList(res.data);
          roomsCache = { ts: Date.now(), rooms: normalized };
          return normalized;
        })
        .catch(() => {
          roomsInFlight = null;
          return DEFAULT_ROOMS.slice();
        });
      return roomsInFlight;
    }

    function getFocusableElements(container) {
      if (!container || typeof container.querySelectorAll !== 'function') return [];
      const nodes = container.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      return Array.prototype.slice.call(nodes || []);
    }

    function closeBoardDispatchModal() {
      const doc = getDoc();
      if (modalState.keydownHandler && doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', modalState.keydownHandler, true);
      }
      modalState.keydownHandler = null;
      if (modalState.backdropEl && typeof modalState.backdropEl.remove === 'function') {
        modalState.backdropEl.remove();
      } else if (doc && typeof doc.getElementById === 'function') {
        const el = doc.getElementById(MODAL_BACKDROP_ID);
        if (el && typeof el.remove === 'function') el.remove();
      }
      modalState.backdropEl = null;
      modalState.open = false;
      modalState.submitting = false;

      const prev = modalState.prevFocusEl;
      modalState.prevFocusEl = null;
      if (prev && typeof prev.focus === 'function' && prev.isConnected !== false) {
        try {
          prev.focus();
        } catch (_) {
          // ignore focus restore failures
        }
      }
    }

    function renderRoomSelectOptionsHtml(rooms, selectedChannel, filterQuery) {
      const q = String(filterQuery || '').trim().toLowerCase();
      const list = rooms.filter((r) => !q || r.channel.toLowerCase().includes(q) || r.groupLabel.toLowerCase().includes(q));
      const hasSelected = list.some((r) => r.channel === selectedChannel);
      const finalRooms = hasSelected || !selectedChannel
        ? list
        : [{ channel: selectedChannel, groupLabel: 'Selected', label: selectedChannel }].concat(list);
      return finalRooms
        .map(
          (r) =>
            `<option value="${escAttr(r.channel)}"${r.channel === selectedChannel ? ' selected' : ''}>` +
              `#${escHtml(r.channel)}` +
            `</option>`
        )
        .join('');
    }

    function buildDefaultDraftText(payload) {
      if (payload && typeof payload.defaultText === 'string' && payload.defaultText.length > 0) {
        return stripEmDash(payload.defaultText);
      }
      const kind = stripEmDash(payload && payload.sourceKind ? payload.sourceKind : '').trim();
      const label = stripEmDash(payload && payload.sourceLabel ? payload.sourceLabel : '').trim();
      if (kind && label) return `[${kind}] ${label}\n`;
      if (label) return `${label}\n`;
      return '';
    }

    function buildDispatchModalInnerHtml(payload, selectedChannel, selectedAgent, rooms) {
      const sourceKind = stripEmDash(payload.sourceKind || 'mind-os').trim();
      const sourceLabel = stripEmDash(payload.sourceLabel || 'Kizuki Mind OS').trim();
      const draftText = buildDefaultDraftText(payload);

      const quickRoomsHtml = DEFAULT_ROOMS.slice(0, 5)
        .map(
          (r) =>
            `<button type="button" class="kbw-chip${r.channel === selectedChannel ? ' is-active' : ''}" ` +
              `data-kbw-quick-room="${escAttr(r.channel)}" aria-pressed="${r.channel === selectedChannel ? 'true' : 'false'}">` +
              `#${escHtml(r.channel)}` +
            `</button>`
        )
        .join('');

      const agentChipsHtml = DISPATCH_TARGETS.map((a) => {
        const active = a.id === selectedAgent;
        const glyph = a.brand === 'owner'
          ? `<span class="kbw-brand-dot is-owner" aria-hidden="true"></span>`
          : `<span class="kbw-brand-dot is-${escAttr(a.brand)}" aria-hidden="true"></span>`;
        return (
          `<button type="button" class="kbw-chip${active ? ' is-active' : ''}" ` +
            `data-kbw-target-agent="${escAttr(a.id)}" aria-pressed="${active ? 'true' : 'false'}">` +
            `${glyph}<span>${escHtml(a.label)}</span>` +
          `</button>`
        );
      }).join('');

      return (
        `<div class="kbw-modal" role="dialog" aria-modal="true" aria-labelledby="kbw-dispatch-modal-title">` +
          `<header class="kbw-modal-head">` +
            `<div>` +
              `<h2 class="kbw-modal-title" id="kbw-dispatch-modal-title">Dispatch to Agent Board</h2>` +
              `<p class="kbw-modal-sub">Source: ${escHtml(sourceKind)} · ${escHtml(sourceLabel)}</p>` +
            `</div>` +
            `<button type="button" class="kbw-modal-close" data-kbw-modal-action="close" aria-label="Close dispatch modal">${ICONS.close}</button>` +
          `</header>` +
          `<div class="kbw-field">` +
            `<label class="kbw-label" for="kbw-room-select">Destination Room</label>` +
            `<div class="kbw-room-quick-row">${quickRoomsHtml}</div>` +
            `<div class="kbw-room-controls">` +
              `<input type="search" id="kbw-room-filter" class="kbw-input" data-kbw-ref="room-filter" placeholder="Filter 101+ rooms..." autocomplete="off">` +
              `<select id="kbw-room-select" class="kbw-select" data-kbw-ref="room-select" aria-label="Board room">` +
                renderRoomSelectOptionsHtml(rooms, selectedChannel, '') +
              `</select>` +
            `</div>` +
          `</div>` +
          `<div class="kbw-field">` +
            `<span class="kbw-label">Target Agent</span>` +
            `<div class="kbw-agent-row" role="group" aria-label="Target agent">${agentChipsHtml}</div>` +
          `</div>` +
          `<div class="kbw-field">` +
            `<label class="kbw-label" for="kbw-dispatch-text">Brief / Instruction</label>` +
            `<textarea id="kbw-dispatch-text" class="kbw-textarea" data-kbw-ref="text" rows="5" placeholder="Write the instruction or context for the agents...">${escHtml(draftText)}</textarea>` +
          `</div>` +
          `<div class="kbw-modal-error" data-kbw-ref="error" role="alert" hidden></div>` +
          `<footer class="kbw-modal-foot">` +
            `<span class="kbw-modal-hint">Cmd/Ctrl+Enter to dispatch</span>` +
            `<div class="kbw-head-actions">` +
              `<button type="button" class="kbw-btn" data-kbw-modal-action="close">Cancel</button>` +
              `<button type="button" class="kbw-btn is-send" data-kbw-modal-action="submit">${ICONS.send} Dispatch to Board</button>` +
            `</div>` +
          `</footer>` +
        `</div>`
      );
    }

    function openBoardDispatchModal(payload, hooks) {
      const doc = getDoc();
      if (!doc || !doc.body || typeof doc.createElement !== 'function') {
        return null;
      }
      ensureStylesInjected();

      const p = payload && typeof payload === 'object' ? payload : {};
      const h = hooks && typeof hooks === 'object' ? hooks : {};
      const selectedChannel = normalizeChannel(p.defaultChannel || 'box/work') || 'box/work';
      const rawAgent = String(p.defaultAgent || '').replace(/^@+/, '').trim().toLowerCase();
      const selectedAgent = DISPATCH_TARGETS.some((a) => a.id === rawAgent) ? rawAgent : '';

      // Singleton: if already open, keep previous focus and replace contents cleanly
      let backdrop = typeof doc.getElementById === 'function' ? doc.getElementById(MODAL_BACKDROP_ID) : null;
      if (!backdrop) {
        modalState.prevFocusEl = doc.activeElement || null;
        backdrop = doc.createElement('div');
        backdrop.id = MODAL_BACKDROP_ID;
        backdrop.className = 'kbw-modal-backdrop';
        doc.body.appendChild(backdrop);
      }

      // Remove any stale keydown handler before attaching fresh one
      if (modalState.keydownHandler && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', modalState.keydownHandler, true);
      }

      modalState.open = true;
      modalState.submitting = false;
      modalState.backdropEl = backdrop;
      modalState.selectedChannel = selectedChannel;
      modalState.selectedAgent = selectedAgent;
      modalState.payload = p;
      modalState.hooks = h;

      const initialRooms = roomsCache ? roomsCache.rooms : DEFAULT_ROOMS.slice();
      modalState.rooms = initialRooms;
      backdrop.innerHTML = buildDispatchModalInnerHtml(p, selectedChannel, selectedAgent, initialRooms);

      const modalEl = backdrop.firstElementChild;
      const roomFilterEl = modalEl ? modalEl.querySelector('[data-kbw-ref="room-filter"]') : null;
      const roomSelectEl = modalEl ? modalEl.querySelector('[data-kbw-ref="room-select"]') : null;
      const textEl = modalEl ? modalEl.querySelector('[data-kbw-ref="text"]') : null;
      const errorEl = modalEl ? modalEl.querySelector('[data-kbw-ref="error"]') : null;
      const submitBtn = modalEl ? modalEl.querySelector('[data-kbw-modal-action="submit"]') : null;

      function setInlineError(msg) {
        if (!errorEl) return;
        if (!msg) {
          errorEl.hidden = true;
          errorEl.innerHTML = '';
          return;
        }
        errorEl.hidden = false;
        errorEl.innerHTML = `${ICONS.alert}<span>${escHtml(msg)}</span>`;
      }

      function syncRoomUi(channel) {
        const clean = normalizeChannel(channel) || 'box/work';
        modalState.selectedChannel = clean;
        if (roomSelectEl) {
          if (!modalState.rooms.some((r) => r.channel === clean)) {
            modalState.rooms = [{ channel: clean, groupLabel: 'Custom', label: clean }].concat(modalState.rooms);
            roomSelectEl.innerHTML = renderRoomSelectOptionsHtml(
              modalState.rooms,
              clean,
              roomFilterEl ? roomFilterEl.value : ''
            );
          }
          roomSelectEl.value = clean;
        }
        if (modalEl && typeof modalEl.querySelectorAll === 'function') {
          const quickBtns = modalEl.querySelectorAll('[data-kbw-quick-room]');
          quickBtns.forEach((btn) => {
            const active = btn.getAttribute('data-kbw-quick-room') === clean;
            if (btn.classList) btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
        }
      }

      function syncAgentUi(agentId) {
        modalState.selectedAgent = agentId || '';
        if (modalEl && typeof modalEl.querySelectorAll === 'function') {
          const agentBtns = modalEl.querySelectorAll('[data-kbw-target-agent]');
          agentBtns.forEach((btn) => {
            const active = (btn.getAttribute('data-kbw-target-agent') || '') === modalState.selectedAgent;
            if (btn.classList) btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
        }
      }

      async function handleSubmit() {
        if (modalState.submitting) return;
        const rawDraft = textEl ? String(textEl.value || '') : '';
        const trimmed = rawDraft.trim();
        if (!trimmed) {
          setInlineError('Write a brief or instruction before dispatching.');
          if (textEl && typeof textEl.focus === 'function') textEl.focus();
          return;
        }

        const channel = normalizeChannel(
          (roomSelectEl && roomSelectEl.value) || modalState.selectedChannel || 'box/work'
        );
        const targetAgent = modalState.selectedAgent || '';
        const mentionToken = targetAgent ? `@${targetAgent}` : '';
        const hasMention = mentionToken
          ? new RegExp(`(^|\\s)@${targetAgent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(trimmed)
          : true;
        const finalText = mentionToken && !hasMention ? `${mentionToken} ${trimmed}` : trimmed;

        modalState.submitting = true;
        setInlineError('');
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Dispatching...';
        }

        const resolvedSourceId = String(p.sourceId || p.sourceLabel || 'mind-os').trim().slice(0, 120) || 'mind-os';
        const labels = {
          source: String(p.sourceKind || 'mind-os').slice(0, 64),
          source_id: resolvedSourceId,
        };
        if (targetAgent) labels.target = targetAgent;

        const body = {
          channel,
          text: finalText,
          sourceKind: p.sourceKind || 'mind-os',
          sourceId: resolvedSourceId,
          sourceLabel: p.sourceLabel || '',
          labels,
          idempotencyKey: `kbw:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        };
        if (targetAgent) {
          body.targetAgent = targetAgent;
          body.agent = targetAgent;
        }

        try {
          const res = await fetchJson('/api/agent-board/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          const isSecretBlocked =
            res.status === 422 ||
            (res.data && (res.data.error === 'secret_detected' || res.data.code === 'secret_detected'));

          if (isSecretBlocked) {
            const rule = res.data && res.data.rule ? ` (${res.data.rule})` : '';
            const detail =
              (res.data && (res.data.message || res.data.detail)) ||
              `Secret pattern detected${rule}.`;
            // Preserve the draft strictly! Never clear textEl.value on 422.
            setInlineError(`Blocked by secret scanner${rule}: ${detail} Edit your draft and retry.`);
            modalState.submitting = false;
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = `${ICONS.send} Dispatch to Board`;
            }
            if (textEl && typeof textEl.focus === 'function') textEl.focus();
            return { ok: false, status: 422, error: 'secret_detected' };
          }

          if (!res.ok || (res.data && res.data.ok === false)) {
            const msg =
              (res.data && (res.data.message || res.data.error)) ||
              `Dispatch failed (HTTP ${res.status || 'offline'}). Draft preserved.`;
            setInlineError(msg);
            modalState.submitting = false;
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = `${ICONS.send} Dispatch to Board`;
            }
            return { ok: false, status: res.status, error: msg };
          }

          // Success! Invalidate caches, play advance sound, close modal, show toast with 1-click jump.
          clearCache();
          playSound('advance');

          const created = res.data || {};
          const createdThreadId = String(
            created.threadId || created.id || (created.thread && created.thread.id) || ''
          ).trim();
          const createdChannel = normalizeChannel(created.channel || channel) || channel;

          closeBoardDispatchModal();

          const toastMsg = `Dispatched to #${createdChannel}${createdThreadId ? ` (${formatShortThreadId(createdThreadId)})` : ''}`;
          const jumpToThread = () =>
            invokeOpenBoard(h, {
              channel: createdChannel,
              threadId: createdThreadId || undefined,
              stage: 'thread',
            });

          if (typeof h.showToast === 'function') {
            invokeShowToast(h, toastMsg, 'success', {
              actionLabel: 'Open Thread in Board',
              onAction: jumpToThread,
              channel: createdChannel,
              threadId: createdThreadId,
            });
          } else {
            showActionToast(toastMsg, 'Open Thread in Board', jumpToThread);
          }

          return { ok: true, channel: createdChannel, threadId: createdThreadId };
        } catch (err) {
          const msg = (err && err.message) ? `Network error: ${err.message}. Draft preserved.` : 'Board unreachable. Draft preserved.';
          setInlineError(msg);
          modalState.submitting = false;
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `${ICONS.send} Dispatch to Board`;
          }
          return { ok: false, status: 0, error: msg };
        }
      }

      // Bind backdrop & modal interactions (fresh handlers on new inner HTML)
      backdrop.onclick = (ev) => {
        if (ev.target === backdrop) {
          closeBoardDispatchModal();
        }
      };

      if (modalEl) {
        modalEl.addEventListener('click', (ev) => {
          const target = ev.target;
          if (!target || typeof target.closest !== 'function') return;

          const quickRoomBtn = target.closest('[data-kbw-quick-room]');
          if (quickRoomBtn) {
            playSound('tick');
            syncRoomUi(quickRoomBtn.getAttribute('data-kbw-quick-room'));
            return;
          }

          const agentBtn = target.closest('[data-kbw-target-agent]');
          if (agentBtn) {
            playSound('tick');
            syncAgentUi(agentBtn.getAttribute('data-kbw-target-agent'));
            return;
          }

          const actionBtn = target.closest('[data-kbw-modal-action]');
          if (actionBtn) {
            const act = actionBtn.getAttribute('data-kbw-modal-action');
            if (act === 'close') {
              closeBoardDispatchModal();
            } else if (act === 'submit') {
              handleSubmit();
            }
          }
        });
      }

      if (roomSelectEl) {
        roomSelectEl.addEventListener('change', () => {
          syncRoomUi(roomSelectEl.value);
        });
      }

      if (roomFilterEl && roomSelectEl) {
        roomFilterEl.addEventListener('input', () => {
          roomSelectEl.innerHTML = renderRoomSelectOptionsHtml(
            modalState.rooms,
            modalState.selectedChannel,
            roomFilterEl.value
          );
        });
      }

      if (textEl) {
        textEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            handleSubmit();
          }
        });
      }

      modalState.keydownHandler = (ev) => {
        if (!modalState.open) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeBoardDispatchModal();
          return;
        }
        if (ev.key === 'Tab' && modalEl) {
          const focusables = getFocusableElements(modalEl);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = doc.activeElement;
          if (ev.shiftKey) {
            if (active === first || !modalEl.contains(active)) {
              ev.preventDefault();
              last.focus();
            }
          } else if (active === last || !modalEl.contains(active)) {
            ev.preventDefault();
            first.focus();
          }
        }
      };

      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', modalState.keydownHandler, true);
      }

      // Focus textarea immediately
      if (textEl && typeof textEl.focus === 'function') {
        textEl.focus();
      }

      // Hydrate all 101+ live rooms asynchronously without losing current selection
      loadLiveRooms().then((rooms) => {
        if (!modalState.open || modalState.backdropEl !== backdrop) return;
        modalState.rooms = rooms;
        if (roomSelectEl) {
          roomSelectEl.innerHTML = renderRoomSelectOptionsHtml(
            rooms,
            modalState.selectedChannel,
            roomFilterEl ? roomFilterEl.value : ''
          );
          roomSelectEl.value = modalState.selectedChannel;
        }
      });

      return {
        close: closeBoardDispatchModal,
        submit: handleSubmit,
        backdropEl: backdrop,
      };
    }

    function clearCache() {
      todayPulseCache = null;
      todayPulseInFlight = null;
      entityThreadsCache.clear();
      entityThreadsInFlight.clear();
      roomsCache = null;
      roomsInFlight = null;
    }

    return {
      mountTodayPulse,
      mountPersonBoard,
      mountCodexBoardBadge,
      mountTasteBoardLedger,
      openBoardDispatchModal,
      closeBoardDispatchModal,
      clearCache,
      escHtml,
      stripEmDash,
    };
  }
);
