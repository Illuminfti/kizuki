/* ==========================================================================
   KIZUKI MIND EXPLORER - EVIL RABBIT MULTIPLAYER AGENT BOARD CONTROLLER
   3-Pane Evil Code Studio powered by:
     - window.KizukiUiSdk (@ui-sdk/core)
     - window.KizukiBoardMesh (Spatial Multi-Agent Mesh Canvas)
     - window.KizukiBoardArtifacts (Rich Stream, Specs, Diffs, Mind Pills, Ribbon)
     - window.KizukiBoardComposerSdk (Slash Commands, [[Context]], Board Hotkeys)
     - window.KizukiBoardContextStage (Local LLM Brief, Verdicts, Context Stage)
   Exports: window.KizukiAgentBoardView = { mount, load, destroy, unmount, getState }
   Zero external deps | Zero XSS | Zero em-dashes | Live SSE + Tactile Audio
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiAgentBoardView = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiAgentBoardView = api;
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
    const COMPANION_STYLE_ID = 'kizuki-agent-board-companion-css';

    const CANONICAL_AGENTS = Object.freeze([
      { actor: 'claude', handle: '@claude', displayName: 'Claude', role: 'Surgical Execution', brand: 'claude', glyph: '*' },
      { actor: 'codex', handle: '@codex', displayName: 'Codex', role: 'Deep Reasoning', brand: 'codex', glyph: '</>' },
      { actor: 'orchestrator', handle: '@orchestrator', displayName: 'Orchestrator', role: 'Operations Lead', brand: 'brain', glyph: '>_' },
      { actor: 'brain', handle: '@brain', displayName: 'Brain', role: 'Memory & Synthesis', brand: 'brain', glyph: '>_' },
      { actor: 'dreamer', handle: '@dreamer', displayName: 'Dreamer', role: 'Nightly Synthesis', brand: 'designer', glyph: 'II' },
      { actor: 'board-keeper', handle: '@board-keeper', displayName: 'Board Keeper', role: 'Dispatcher', brand: 'brain', glyph: '>_' },
      { actor: 'antigravity-swarm', handle: '@antigravity-swarm', displayName: 'Designer', role: 'Visual & Swarm', brand: 'designer', glyph: 'II' },
      { actor: 'scout-fleet', handle: '@scout-fleet', displayName: 'Scout Fleet', role: 'Scout Fleet', brand: 'codex', glyph: '</>' },
    ]);

    const DOCK_AGENTS = Object.freeze([
      { id: 'claude', handle: 'claude', label: 'Claude', brand: 'claude', glyph: '*' },
      { id: 'codex', handle: 'codex', label: 'Codex', brand: 'codex', glyph: '</>' },
      { id: 'designer', handle: 'antigravity-swarm', label: 'Designer / Neon', brand: 'designer', glyph: 'II' },
      { id: 'brain', handle: 'orchestrator', label: 'Brain / Orchestrator', brand: 'brain', glyph: '>_' },
      { id: 'owner', handle: 'owner', label: 'Owner', brand: 'owner', glyph: '' },
    ]);

    const ICONS = Object.freeze({
      rooms:
        '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1.1"/><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1.1"/><rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1.1"/><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1.1"/></svg>',
      feed:
        '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="3.4" r="1.7"/><circle cx="3.6" cy="12" r="1.7"/><circle cx="12.4" cy="12" r="1.7"/><path d="M7.2 4.9 4.4 10.5M8.8 4.9l2.8 5.6M5.3 12h5.4"/></svg>',
      blockers:
        '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.3"/><circle cx="8" cy="10.9" r="0.6" fill="currentColor"/></svg>',
      taste:
        '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6 8 2.2Z"/></svg>',
      plus:
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
      chevronDown:
        '<svg class="eb-room-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8"/></svg>',
      arrowUp:
        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5"/><path d="M4.2 7.2 8 3.4l3.8 3.8"/></svg>',
      arrowDown:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9"/><path d="M4.2 8.8 8 12.6l3.8-3.8"/></svg>',
      refresh:
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.35-3.45"/><path d="M13.2 2.8v2.8h-2.8"/></svg>',
      close:
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
      reply:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 4.2 2.6 8l3.8 3.8"/><path d="M3 8h6.4a4 4 0 0 1 4 4v.4"/></svg>',
      ownerMark:
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3.4"/></svg>',
    });

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

    function getGlobalModule(name) {
      const w = getWin();
      if (w && w[name] && typeof w[name] === 'object') return w[name];
      if (root && root[name] && typeof root[name] === 'object') return root[name];
      if (typeof globalThis !== 'undefined' && globalThis[name] && typeof globalThis[name] === 'object') {
        return globalThis[name];
      }
      return null;
    }

    function getUiSdk() {
      return getGlobalModule('KizukiUiSdk');
    }

    function getBoardMesh() {
      return getGlobalModule('KizukiBoardMesh');
    }

    function getBoardArtifacts() {
      return getGlobalModule('KizukiBoardArtifacts');
    }

    function getBoardComposerSdk() {
      return getGlobalModule('KizukiBoardComposerSdk');
    }

    function getBoardContextStage() {
      return getGlobalModule('KizukiBoardContextStage');
    }

    function getCurrentTheme(doc) {
      const d = doc || getDoc();
      if (d && d.documentElement && typeof d.documentElement.getAttribute === 'function') {
        const attr = d.documentElement.getAttribute('data-theme');
        if (attr === 'light' || attr === 'dark') return attr;
      }
      return 'dark';
    }

    function getCurrentDetail(doc, win) {
      const w = win || getWin();
      if (w && w.location && typeof w.location.search === 'string') {
        try {
          const sp = new URLSearchParams(w.location.search);
          const q = sp.get('detail');
          if (q === 'off' || q === 'on') return q;
        } catch {
          // ignore malformed search
        }
      }
      const d = doc || getDoc();
      if (d && d.documentElement && typeof d.documentElement.getAttribute === 'function') {
        const attr = d.documentElement.getAttribute('data-detail');
        if (attr === 'off' || attr === 'on') return attr;
      }
      return 'on';
    }

    function playSound(method) {
      const w = getWin();
      const sound = (w && w.KizukiSound) || (root && root.KizukiSound);
      if (!sound || typeof sound[method] !== 'function') return;
      try {
        sound[method]();
      } catch {
        // Optional audio feedback must never block UI interactions
      }
    }

    function stripEmDash(value) {
      return String(value == null ? '' : value)
        .replace(EM_DASH_RE, ' - ')
        .replace(EN_DASH_RE, ' - ');
    }

    function humanizeMentions(value) {
      return stripEmDash(value == null ? '' : value)
        .replace(/@\[local:user:[^\]+]+\+([^\]]+)\]/gi, '@$1')
        .replace(/@\[local:user:([^\]+]+)\]/gi, '@$1')
        .replace(/@\[tailscale:user:([^\]@]+)@[^\]]+\]/gi, '@$1')
        .replace(/@\[tailscale:user:([^\]]+)\]/gi, '@$1')
        .replace(/@ubuntu\/([a-zA-Z0-9._-]+)/gi, '@$1');
    }

    function normalizeTitleForCompare(str) {
      return humanizeMentions(str || '')
        .replace(/^#+\s*/, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/\.{3,}$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function isTitleDuplicatedByBody(title, rawText) {
      const normTitle = normalizeTitleForCompare(title);
      if (!normTitle) return true;
      const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n');
      const firstLine = lines.map((l) => l.trim()).find(Boolean) || '';
      const normFirst = normalizeTitleForCompare(firstLine);
      const normAll = normalizeTitleForCompare(rawText);
      if (!normFirst && !normAll) return false;
      if (normFirst === normTitle || normFirst.startsWith(normTitle) || normTitle.startsWith(normFirst)) {
        return true;
      }
      if (normAll.startsWith(normTitle)) return true;
      const strippedPrefix = normFirst
        .replace(/^\[rsi\s+(?:high|medium|low)\s*\/\s*[^\]]+\]\s*/i, '')
        .replace(/^(?:debrief\s+\S+(?:\s+\[[^\]]+\])?|dream\s+\d{4}-\d{2}-\d{2}|taste|ab\s+lint)\s*:\s*/i, '')
        .trim();
      if (
        strippedPrefix &&
        (strippedPrefix === normTitle ||
          strippedPrefix.startsWith(normTitle) ||
          normTitle.startsWith(strippedPrefix))
      ) {
        return true;
      }
      return false;
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

    function ensureCompanionStyles(doc) {
      const d = doc || getDoc();
      if (!d || !d.head || typeof d.getElementById !== 'function') return;
      if (d.getElementById(COMPANION_STYLE_ID)) return;
      try {
        const style = d.createElement('style');
        style.id = COMPANION_STYLE_ID;
        style.textContent = [
          ':where(.eb-telemetry-ribbon-slot){flex-shrink:0;min-width:0;}',
          ':where(.eb-telemetry-ribbon-slot[hidden]){display:none;}',
          ':where(.eb-telemetry-ribbon){display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-height:34px;padding:4px 12px;background:var(--eb-recessed-bg,#111114);border-bottom:1px solid var(--eb-border,rgba(255,255,255,0.08));font-variant-numeric:tabular-nums;}',
          ':where(.eb-ribbon-tabs){display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--eb-frame-bg,#0c0c0e);border:1px solid var(--eb-border,rgba(255,255,255,0.08));}',
          ':where(html[data-theme="light"] .eb-ribbon-tabs){background:#e9e9ee;border-color:rgba(0,0,0,0.09);}',
          ':where(.eb-ribbon-tab){display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ink-muted,#8e8e98);font-family:var(--font-sans,system-ui,sans-serif);font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;}',
          ':where(.eb-ribbon-tab:hover){color:var(--ink-primary,#f4f4f5);}',
          ':where(.eb-ribbon-tab.is-active){background:var(--eb-card-selected,#202026);border-color:var(--eb-border-strong,rgba(255,255,255,0.14));color:var(--ink-primary,#f4f4f5);}',
          ':where(html[data-theme="light"] .eb-ribbon-tab.is-active){background:#ffffff;border-color:rgba(0,0,0,0.12);color:#141416;}',
          ':where(.eb-ribbon-count){font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;opacity:0.8;}',
          ':where(.eb-telemetry-rollup){display:inline-flex;align-items:center;min-width:0;max-width:100%;}',
          ':where(.eb-telemetry-rollup-btn){display:inline-flex;align-items:center;gap:6px;height:22px;max-width:100%;padding:0 8px;border-radius:6px;border:1px solid var(--eb-border,rgba(255,255,255,0.08));background:var(--eb-pill-bg,rgba(255,255,255,0.05));color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;cursor:pointer;white-space:nowrap;overflow:hidden;}',
          ':where(.eb-telemetry-rollup-btn:hover){background:var(--eb-pill-hover,rgba(255,255,255,0.09));color:var(--ink-primary,#f4f4f5);}',
          ':where(.eb-telemetry-rollup-dot){width:5px;height:5px;border-radius:50%;background:var(--eb-live,#34d399);flex-shrink:0;}',
          ':where(.eb-telemetry-rollup-text){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
          ':where(.eb-telemetry-rollup-cta){color:var(--ink-primary,#f4f4f5);font-weight:500;flex-shrink:0;}',
          ':where(.eb-telemetry-quiet){font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--ink-muted,#71717a);}',
          ':where(.eb-signal-badge){display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:5px;border:1px solid var(--eb-border,rgba(255,255,255,0.10));background:var(--eb-pill-bg,rgba(255,255,255,0.05));color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:9.5px;font-weight:500;letter-spacing:0.03em;text-transform:uppercase;white-space:nowrap;}',
          ':where(.eb-signal-dot){width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0;}',
          ':where(.eb-signal-badge.is-decision){color:var(--eb-revise-ink,#fcd34d);background:var(--eb-revise-bg,rgba(245,158,11,0.12));border-color:var(--eb-revise-border,rgba(245,158,11,0.32));}',
          ':where(.eb-signal-badge.is-debate){color:var(--eb-codex,#56b6f9);background:var(--eb-codex-bg,rgba(86,182,249,0.12));border-color:var(--eb-codex-border,rgba(86,182,249,0.28));}',
          ':where(.eb-signal-badge.is-rsi){color:var(--eb-claude,#e2845d);background:var(--eb-claude-bg,rgba(226,132,93,0.12));border-color:var(--eb-claude-border,rgba(226,132,93,0.28));}',
          ':where(.eb-signal-badge.is-taste){color:var(--eb-designer,#b48eff);background:var(--eb-designer-bg,rgba(180,142,255,0.12));border-color:var(--eb-designer-border,rgba(180,142,255,0.28));}',
          ':where(.eb-signal-badge.is-debrief){color:var(--eb-brain,#4ade80);background:var(--eb-brain-bg,rgba(74,222,128,0.12));border-color:var(--eb-brain-border,rgba(74,222,128,0.28));}',
          ':where(.eb-rich-message){display:flex;flex-direction:column;gap:6px;min-width:0;}',
          ':where(.eb-rich-p){margin:0;line-height:1.52;word-break:break-word;}',
          ':where(.eb-rich-list){margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;}',
          ':where(.eb-rich-quote){margin:0;padding:4px 10px;border-left:2px solid var(--eb-border-strong,rgba(255,255,255,0.18));color:var(--ink-secondary,#a1a1aa);}',
          ':where(.eb-meta-pill-row,.eb-mind-pills,.eb-artifact-strip){display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-width:0;}',
          ':where(.eb-kv-row){display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.45;}',
          ':where(.eb-kv-key){font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-muted,#71717a);flex-shrink:0;}',
          ':where(.eb-section-label){font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-secondary,#a1a1aa);margin-top:4px;}',
          ':where(.eb-reply-strip){display:flex;align-items:center;gap:8px;margin-top:6px;padding:6px 9px;border-radius:8px;border:1px solid var(--eb-border-subtle,rgba(255,255,255,0.06));background:var(--eb-recessed-bg,#111114);color:var(--ink-secondary,#a1a1aa);cursor:pointer;min-width:0;}',
          ':where(.eb-reply-strip:hover){background:var(--eb-card-hover,#1d1d21);border-color:var(--eb-border-strong,rgba(255,255,255,0.14));}',
          ':where(.eb-reply-latest){display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;font-size:12px;overflow:hidden;}',
          ':where(.eb-reply-author){font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;font-weight:500;flex-shrink:0;}',
          ':where(.eb-reply-excerpt){color:var(--ink-muted,#8e8e98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
          ':where(.eb-reply-view-all){border:0;background:transparent;padding:0;color:var(--ink-primary,#f4f4f5);font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;}',
          ':where(.eb-copy-btn){display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;border:1px solid var(--eb-border,rgba(255,255,255,0.10));background:var(--eb-pill-bg,rgba(255,255,255,0.06));color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;cursor:pointer;}',
          ':where(.eb-copy-btn.is-copied){color:var(--eb-brain,#4ade80);border-color:var(--eb-brain-border,rgba(74,222,128,0.30));}',
          ':where(.eb-artifact-pill){display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:5px;border:1px solid var(--eb-border,rgba(255,255,255,0.09));background:var(--eb-recessed-bg,#111114);color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;text-decoration:none;cursor:pointer;max-width:100%;}',
          ':where(.eb-artifact-tag){font-size:9px;font-weight:600;opacity:0.75;letter-spacing:0.04em;}',
          ':where(.eb-spec-summary){display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;}',
          ':where(.eb-spec-summary-left,.eb-spec-summary-right){display:inline-flex;align-items:center;gap:6px;min-width:0;}',
          ':where(.eb-mesh-mount-host){width:100%;height:340px;min-height:340px;flex-shrink:0;}',
          '@media (max-width:460px){:where(.eb-mesh-mount-host){height:320px;min-height:320px;}}',
          ':where(.eb-mesh-mount-host.is-expanded){width:auto;height:auto;min-height:0;}',
          ':where(.eb-composer-trigger-btn){display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--ink-muted,#8e8e98);font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;font-weight:500;cursor:pointer;}',
          ':where(.eb-composer-trigger-btn:hover,.eb-composer-trigger-btn[aria-expanded="true"]){background:var(--eb-pill-bg,rgba(255,255,255,0.06));border-color:var(--eb-border,rgba(255,255,255,0.09));color:var(--ink-primary,#f4f4f5);}',
          ':where(.eb-room-option.is-mission){border-bottom:1px solid var(--eb-border-subtle,rgba(255,255,255,0.06));margin-bottom:4px;padding-bottom:8px;}',
          /* Visual Thread Spine (24px machined strip) */
          ':where(.eb-thread-spine){display:flex;align-items:center;gap:8px;height:24px;padding:0 8px;margin-top:7px;border-radius:6px;border:1px solid var(--eb-border-subtle,rgba(255,255,255,0.065));background:var(--eb-recessed-bg,#111114);cursor:pointer;min-width:0;font-variant-numeric:tabular-nums;transition:border-color 110ms ease,background-color 110ms ease;}',
          ':where(.eb-thread-spine:hover){border-color:var(--eb-border-strong,rgba(255,255,255,0.14));background:var(--eb-card-hover,#1d1d21);}',
          ':where(.eb-spine-avatars){display:inline-flex;align-items:center;flex-shrink:0;}',
          ':where(.eb-spine-avatar){position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--eb-recessed-bg,#111114);background:var(--eb-card-bg,#18181b);font-family:var(--font-mono,ui-monospace,monospace);font-size:8.5px;font-weight:600;line-height:1;letter-spacing:-0.05em;margin-left:-5px;flex-shrink:0;}',
          ':where(.eb-spine-avatar:first-child){margin-left:0;}',
          ':where(.eb-spine-avatar.is-claude){color:var(--eb-claude,#e2845d);background:var(--eb-claude-bg,rgba(217,119,87,0.16));}',
          ':where(.eb-spine-avatar.is-codex){color:var(--eb-codex,#56b6f9);background:var(--eb-codex-bg,rgba(56,189,248,0.16));}',
          ':where(.eb-spine-avatar.is-designer,.eb-spine-avatar.is-worker){color:var(--eb-designer,#b48eff);background:var(--eb-designer-bg,rgba(167,139,250,0.16));}',
          ':where(.eb-spine-avatar.is-brain){color:var(--eb-brain,#4ade80);background:var(--eb-brain-bg,rgba(52,211,153,0.16));}',
          ':where(.eb-spine-avatar.is-owner){color:var(--eb-owner-ink,#0d0d0f);background:var(--eb-owner-bg,#ededed);}',
          ':where(.eb-spine-avatar.is-owner svg){width:9px;height:9px;}',
          ':where(.eb-spine-track){position:relative;flex:1 1 auto;height:12px;min-width:36px;display:flex;align-items:center;}',
          ':where(.eb-spine-bar){width:100%;height:1px;background:var(--eb-border-strong,rgba(255,255,255,0.14));}',
          ':where(.eb-spine-tick){position:absolute;top:50%;width:2.5px;height:3px;transform:translate(-50%,-50%);border-radius:1px;}',
          ':where(.eb-spine-momentum){display:inline-flex;align-items:center;gap:6px;flex-shrink:0;color:var(--ink-muted,#8e8e98);}',
          ':where(.eb-spine-spark){display:block;width:60px;height:16px;flex-shrink:0;}',
          ':where(.eb-spine-count){font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:500;color:var(--ink-secondary,#a1a1aa);min-width:14px;text-align:right;font-variant-numeric:tabular-nums;}',
          /* Collapsible Long Log Walls + Hairline 2-Cell GOAL / DONE-CHECK Table */
          ':where(.eb-collapsible-body){display:flex;flex-direction:column;gap:6px;min-width:0;}',
          ':where(.eb-collapsible-summary){display:flex;flex-direction:column;gap:6px;min-width:0;}',
          ':where(.eb-collapsible-body.is-expanded .eb-collapsible-summary){display:none;}',
          ':where(.eb-exec-preview){display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--ink-primary,#f4f4f5);font-size:13px;line-height:1.48;}',
          ':where(.eb-exec-preview .eb-rich-p){margin:0;}',
          ':where(.eb-exec-kv-table){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--eb-border,rgba(255,255,255,0.09));border-radius:7px;background:var(--eb-recessed-bg,#111114);overflow:hidden;min-width:0;}',
          ':where(.eb-exec-kv-table.is-single){grid-template-columns:minmax(0,1fr);}',
          ':where(.eb-exec-kv-cell){display:flex;flex-direction:column;gap:2px;padding:6px 9px;min-width:0;}',
          ':where(.eb-exec-kv-cell + .eb-exec-kv-cell){border-left:1px solid var(--eb-border,rgba(255,255,255,0.09));}',
          ':where(.eb-exec-kv-label){font-family:var(--font-mono,ui-monospace,monospace);font-size:9.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted,#71717a);}',
          ':where(.eb-exec-kv-val){font-size:12px;line-height:1.4;color:var(--ink-secondary,#d4d4d8);word-break:break-word;}',
          ':where(.eb-collapsible-panel){display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 190ms cubic-bezier(0.16,1,0.3,1),opacity 160ms ease;}',
          ':where(.eb-collapsible-body.is-expanded .eb-collapsible-panel){grid-template-rows:1fr;opacity:1;}',
          ':where(.eb-collapsible-inner){overflow:hidden;min-height:0;}',
          ':where(.eb-collapsible-toggle){align-self:flex-start;display:inline-flex;align-items:center;gap:7px;height:22px;padding:0 8px;border-radius:5px;border:1px solid var(--eb-border,rgba(255,255,255,0.10));background:var(--eb-pill-bg,rgba(255,255,255,0.05));color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:500;cursor:pointer;transition:background-color 110ms ease,border-color 110ms ease,color 110ms ease;}',
          ':where(.eb-collapsible-toggle:hover){background:var(--eb-pill-hover,rgba(255,255,255,0.09));border-color:var(--eb-border-strong,rgba(255,255,255,0.16));color:var(--ink-primary,#f4f4f5);}',
          ':where(.eb-collapsible-toggle-meta){color:var(--ink-muted,#71717a);font-size:9.5px;font-variant-numeric:tabular-nums;}',
          '@media (max-width:460px){:where(.eb-exec-kv-table){grid-template-columns:minmax(0,1fr);}:where(.eb-exec-kv-cell + .eb-exec-kv-cell){border-left:0;border-top:1px solid var(--eb-border,rgba(255,255,255,0.09));}}',
          /* Live SSE Arrival Sweep (240ms top-edge scaleX 0->1 + knife-edge reveal) */
          '@keyframes eb-arrival-sweep{from{transform:scaleX(0);opacity:0.95;}to{transform:scaleX(1);opacity:0;}}',
          '@keyframes eb-arrival-reveal{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
          ':where(.eb-thread-card.eb-just-arrived){position:relative;overflow:hidden;animation:eb-arrival-reveal 240ms cubic-bezier(0.16,1,0.3,1) both;}',
          ':where(.eb-thread-card.eb-just-arrived)::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--eb-live,#34d399),var(--eb-codex,#56b6f9));transform-origin:left center;pointer-events:none;z-index:3;animation:eb-arrival-sweep 240ms cubic-bezier(0.16,1,0.3,1) forwards;}',
          /* Live 6-Row Real-Time Event Tape + Compact Presence Roster */
          ':where(.eb-event-tape){display:flex;flex-direction:column;max-height:280px;overflow-y:auto;border-radius:10px;border:1px solid var(--eb-border,rgba(255,255,255,0.085));background:var(--eb-recessed-bg,#111114);font-family:var(--font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;}',
          ':where(.eb-event-tape-row){display:grid;grid-template-columns:54px 70px minmax(64px,92px) minmax(68px,112px) minmax(0,1fr);align-items:center;gap:8px;min-height:28px;padding:4px 9px;border-bottom:1px solid var(--eb-border-subtle,rgba(255,255,255,0.055));font-size:10.5px;color:var(--ink-secondary,#a1a1aa);background:transparent;text-align:left;width:100%;border-left:0;border-right:0;border-top:0;contain:layout style;}',
          ':where(.eb-event-tape-row:last-child){border-bottom:0;}',
          ':where(.eb-event-tape-row.is-clickable){cursor:pointer;transition:background-color 110ms ease,color 110ms ease;}',
          ':where(.eb-event-tape-row.is-clickable:hover){background:var(--eb-card-hover,#1d1d21);color:var(--ink-primary,#f4f4f5);}',
          ':where(.eb-event-tape-row.is-fresh){background:rgba(52,211,153,0.07);}',
          ':where(.eb-event-tape-time){color:var(--ink-muted,#71717a);font-size:9.5px;white-space:nowrap;}',
          ':where(.eb-event-tape-kind){display:inline-flex;align-items:center;justify-content:center;height:16px;padding:0 5px;border-radius:4px;font-size:9px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;border:1px solid var(--eb-border,rgba(255,255,255,0.10));background:var(--eb-pill-bg,rgba(255,255,255,0.05));color:var(--ink-secondary,#a1a1aa);white-space:nowrap;}',
          ':where(.eb-event-tape-kind.is-board,.eb-event-tape-kind.is-decision){color:var(--eb-revise-ink,#fcd34d);border-color:rgba(245,158,11,0.32);background:rgba(245,158,11,0.11);}',
          ':where(.eb-event-tape-kind.is-action,.eb-event-tape-kind.is-debate){color:var(--eb-codex,#56b6f9);border-color:rgba(86,182,249,0.30);background:rgba(86,182,249,0.11);}',
          ':where(.eb-event-tape-kind.is-telemetry,.eb-event-tape-kind.is-hello){color:var(--eb-brain,#4ade80);border-color:rgba(74,222,128,0.28);background:rgba(74,222,128,0.10);}',
          ':where(.eb-event-tape-actor){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-primary,#f4f4f5);font-weight:500;}',
          ':where(.eb-event-tape-chan){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-muted,#8e8e98);}',
          ':where(.eb-event-tape-msg){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-secondary,#d4d4d8);}',
          ':where(.eb-roster-compact-grid){display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:6px;}',
          ':where(.eb-roster-compact-row){display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 9px;border-radius:9px;background:var(--eb-card-bg,#18181b);border:1px solid var(--eb-border-subtle,rgba(255,255,255,0.06));cursor:pointer;min-width:0;transition:background-color 110ms ease,border-color 110ms ease;}',
          ':where(.eb-roster-compact-row:hover){background:var(--eb-card-hover,#1d1d21);border-color:var(--eb-border-strong,rgba(255,255,255,0.14));}',
          /* Full-Stage Spatial Command Mode */
          ':where(.eb-shell.is-spatial-expanded){grid-template-columns:54px minmax(0,1fr);}',
          ':where(.eb-shell.is-spatial-expanded .eb-center-stage){display:none;}',
          ':where(.eb-shell.is-spatial-expanded .eb-right-stage){display:flex;}',
          ':where(.eb-shell.is-spatial-expanded .eb-mesh-mount-host:not(.is-expanded)){min-height:520px;height:calc(100vh - 210px);}',
          ':where(.eb-spatial-toggle-btn){display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--eb-border,rgba(255,255,255,0.10));background:var(--eb-pill-bg,rgba(255,255,255,0.05));color:var(--ink-secondary,#a1a1aa);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;font-weight:500;cursor:pointer;}',
          ':where(.eb-spatial-toggle-btn:hover){background:var(--eb-pill-hover,rgba(255,255,255,0.09));color:var(--ink-primary,#f4f4f5);}',
          '@media (max-width:640px){:where(.eb-event-tape-row){grid-template-columns:46px 52px minmax(0,1fr);}:where(.eb-event-tape-actor,.eb-event-tape-chan){display:none;}}',
          '@media (prefers-reduced-motion:reduce){:where(.eb-collapsible-panel){transition:none;}:where(.eb-thread-card.eb-just-arrived),.eb-thread-card.eb-just-arrived::before{animation:none !important;}}',
        ].join('\n');
        d.head.appendChild(style);
      } catch {
        // Ignore in minimal mock DOMs
      }
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

    function clampPct(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return 0;
      return Math.max(0, Math.min(100, Math.round(num)));
    }

    function safeArray(val) {
      return Array.isArray(val) ? val : [];
    }

    function titleCaseSlug(slug) {
      const acronyms = {
        ui: 'UI',
        ux: 'UX',
        ai: 'AI',
        api: 'API',
        os: 'OS',
        db: 'DB',
        sse: 'SSE',
        pr: 'PR',
        qa: 'QA',
      };
      return stripEmDash(slug || '')
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => {
          const low = part.toLowerCase();
          if (acronyms[low]) return acronyms[low];
          return low.charAt(0).toUpperCase() + low.slice(1);
        })
        .join(' ');
    }

    function extractActorSlug(rawActor, rawProfile) {
      const profile = rawProfile ? String(rawProfile).trim().replace(/^@+/, '') : '';
      if (profile) return profile;
      const clean = String(rawActor || '').trim().replace(/^@+/, '');
      if (!clean) return null;
      if (clean.includes('+')) {
        const afterPlus = clean.split('+').slice(1).join('+').trim();
        return afterPlus || null;
      }
      const colonMatch = /^(?:local|tailscale):user:[^:+]+:(.+)$/i.exec(clean);
      if (colonMatch && colonMatch[1]) {
        return colonMatch[1].trim() || null;
      }
      if (/^(?:local|tailscale):user:[^:+]+$/i.test(clean)) {
        return null;
      }
      return clean;
    }

    function parseAgentIdentity(rawActor, rawBrand, rawRole, rawDisplayName, rawProfile) {
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
        return {
          handle: slug || 'ubuntu',
          brand: 'owner',
          glyph: '',
          label: explicitDisplay || 'Owner',
        };
      }

      if (lower.includes('claude') || explicitBrand === 'claude') {
        const short = (slug || '').replace(/^(?:w-)?claude[-_]?/i, '').trim();
        return {
          handle: slug || 'claude',
          brand: 'claude',
          glyph: '*',
          label: explicitDisplay || (short ? `Claude · ${short}` : 'Claude'),
        };
      }

      if (lower.includes('codex') || lower.includes('scout-fleet') || explicitBrand === 'codex') {
        let fallback = 'Codex';
        if (lower.includes('codex')) {
          const short = (slug || '').replace(/^(?:w-)?codex[-_]?/i, '').trim();
          fallback = short ? `Codex · ${short}` : 'Codex';
        } else if (slug) {
          fallback = titleCaseSlug(slug);
        }
        return {
          handle: slug || 'codex',
          brand: 'codex',
          glyph: '</>',
          label: explicitDisplay || fallback,
        };
      }

      if (
        lower.includes('designer') ||
        lower.includes('design') ||
        lower.includes('neon') ||
        lower.includes('antigravity') ||
        lower.includes('visual') ||
        lower.includes('rabbit') ||
        lower === 'scribe-ui' ||
        lower === 'scribe-web' ||
        lower === 'scribe-motion' ||
        lower === 'scribe-films' ||
        lower === 'scribe-video' ||
        lower === 'scribe-playbook' ||
        explicitBrand === 'designer' ||
        explicitBrand === 'neon'
      ) {
        const fallback =
          lower === 'antigravity' || lower === 'antigravity-swarm'
            ? 'Designer'
            : titleCaseSlug(slug || 'designer');
        return {
          handle: slug || 'designer',
          brand: 'designer',
          glyph: 'II',
          label: explicitDisplay || fallback,
        };
      }

      if (
        lower.includes('board-keeper') ||
        lower.includes('orchestrator') ||
        lower.includes('brain') ||
        lower.includes('dreamer') ||
        lower === 'kizuki' ||
        lower === 'dispatch' ||
        lower.includes('daemon') ||
        lower.includes('ambient') ||
        explicitBrand === 'brain' ||
        explicitBrand === 'orchestrator'
      ) {
        return {
          handle: slug || 'brain',
          brand: 'brain',
          glyph: '>_',
          label: explicitDisplay || titleCaseSlug(slug || 'brain'),
        };
      }

      if (slug) {
        return {
          handle: slug,
          brand: 'worker',
          glyph: 'II',
          label: explicitDisplay || titleCaseSlug(slug),
        };
      }

      const roleLow = String(rawRole || '').toLowerCase();
      if (roleLow === 'owner' || roleLow === 'human') {
        return { handle: 'owner', brand: 'owner', glyph: '', label: explicitDisplay || 'Owner' };
      }
      return {
        handle: 'agent',
        brand: 'brain',
        glyph: '>_',
        label: explicitDisplay || 'Agent',
      };
    }

    function normalizeBrand(rawActor, rawBrand, rawRole) {
      return parseAgentIdentity(rawActor, rawBrand, rawRole, '', null).brand;
    }

    function formatShortThreadId(rawId) {
      const s = String(rawId == null ? '' : rawId).trim();
      if (!s) return '';
      if (/^\d+$/.test(s)) return `#${s}`;
      if (s.startsWith('key:')) {
        const tail = s.split(':').pop() || s.slice(4);
        return `#${tail.slice(0, 8)}`;
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) {
        return `#${s.slice(0, 8)}`;
      }
      if (s.length > 14) {
        return `#${s.slice(0, 8)}`;
      }
      return `#${s}`;
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

    function buildCanvasCardCopy(item) {
      const rawBody = stripEmDash(item.text || '').replace(/\r\n/g, '\n').trim();
      const firstLine =
        rawBody
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean) || '';
      const sourceTitle = humanizeMentions(
        item.title || firstLine || `Thread ${formatShortThreadId(item.threadId)}`
      )
        .replace(/\s+/g, ' ')
        .trim();
      const titleText = truncateWordBoundary(sourceTitle, 84);
      const titleBase = titleText.replace(/\.{3}$/, '').trim();

      let candidate = humanizeMentions(item.blockedReason || '').replace(/\s+/g, ' ').trim();
      if (!candidate) {
        const flatBody = humanizeMentions(rawBody).replace(/\s+/g, ' ').trim();
        if (
          !flatBody ||
          flatBody.toLowerCase() === sourceTitle.toLowerCase() ||
          flatBody.toLowerCase() === titleBase.toLowerCase() ||
          flatBody.length <= titleBase.length + 6
        ) {
          candidate = '';
        } else if (flatBody.toLowerCase().startsWith(titleBase.toLowerCase())) {
          candidate = flatBody.slice(titleBase.length).replace(/^[\s.,:;!?-]+/, '').trim();
        } else if (firstLine && rawBody.length > firstLine.length) {
          const rest = rawBody.slice(rawBody.indexOf(firstLine) + firstLine.length);
          candidate = rest.replace(/\s+/g, ' ').trim();
        } else {
          candidate = flatBody;
        }
      } else if (candidate.toLowerCase().startsWith(titleBase.toLowerCase())) {
        candidate = candidate.slice(titleBase.length).replace(/^[\s.,:;!?-]+/, '').trim();
      }

      const excerpt = candidate ? truncateWordBoundary(candidate, 160) : '';
      return { titleText, excerpt };
    }

    function normalizeLabels(rawLabels) {
      if (!rawLabels) return [];
      if (Array.isArray(rawLabels)) {
        return rawLabels.map((x) => stripEmDash(String(x))).filter(Boolean);
      }
      if (typeof rawLabels === 'object') {
        return Object.keys(rawLabels)
          .filter((k) => rawLabels[k] != null && String(rawLabels[k]).trim() !== '')
          .map((k) => {
            const val = stripEmDash(String(rawLabels[k]));
            return val === 'true' || val === '1' ? stripEmDash(k) : `${stripEmDash(k)}:${val}`;
          });
      }
      return [];
    }

    function isTelemetryItem(rawItem) {
      if (!rawItem || typeof rawItem !== 'object') return false;
      if (rawItem.signal && typeof rawItem.signal === 'object') {
        if (typeof rawItem.signal.isTelemetry === 'boolean') return rawItem.signal.isTelemetry;
        if (String(rawItem.signal.signalKind || '').toLowerCase() === 'telemetry') return true;
      }
      if (typeof rawItem.isTelemetry === 'boolean') return rawItem.isTelemetry;
      const labels = rawItem.labels && typeof rawItem.labels === 'object' ? rawItem.labels : null;
      if (labels && !Array.isArray(labels)) {
        const k = String(labels.kind || labels.type || '').toLowerCase();
        if (k === 'telemetry' || k === 'heartbeat' || k === 'wake') return true;
      }
      const text = String(rawItem.text || rawItem.body || rawItem.message || '').trim();
      if (!text) return false;
      if (/^fleet health\b/i.test(text)) return true;
      if (/\bwoke up\b/i.test(text) && text.length < 220) return true;
      if (/^(?:heartbeat|health check|watch ping|status ping|ticker|cron ping)\b/i.test(text)) return true;
      return false;
    }

    function classifyTelemetryBucket(rawItem) {
      const text = String((rawItem && (rawItem.text || rawItem.body || rawItem.message)) || '').trim();
      if (/\bwoke up\b/i.test(text)) return { kind: 'wakePings', label: 'wake pings' };
      if (/fleet health/i.test(text)) return { kind: 'fleetHealth', label: 'fleet health' };
      if (/ticker|price|alert/i.test(text)) return { kind: 'tickerAlerts', label: 'ticker alerts' };
      return { kind: 'heartbeats', label: 'heartbeats' };
    }

    function buildClientTelemetrySummary(rawItems) {
      const buckets = Object.create(null);
      const list = safeArray(rawItems);
      for (let i = 0; i < list.length; i += 1) {
        const it = list[i];
        if (!isTelemetryItem(it)) continue;
        const spec = classifyTelemetryBucket(it);
        if (!buckets[spec.kind]) {
          buckets[spec.kind] = {
            kind: spec.kind,
            label: spec.label,
            count: 0,
            latestAt: it.createdAt || it.at || '',
            channels: [],
            sample: truncateWordBoundary(it.text || it.body || '', 88),
          };
        }
        buckets[spec.kind].count += 1;
        const ch = String(it.channel || '').trim();
        if (ch && buckets[spec.kind].channels.indexOf(ch) === -1) {
          buckets[spec.kind].channels.push(ch);
        }
      }
      return Object.keys(buckets)
        .map((k) => buckets[k])
        .sort((a, b) => b.count - a.count);
    }

    function normalizeReplyPreviewItems(rawList) {
      return safeArray(rawList)
        .filter((x) => x && typeof x === 'object')
        .map((entry) =>
          Object.assign({}, entry, {
            text: entry.text || entry.body || entry.preview || entry.excerpt || entry.summary || '',
            preview: entry.preview || entry.excerpt || entry.text || entry.body || '',
          })
        );
    }

    function extractRoomFields(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const channel = String(r.channel || r.path || r.name || '').replace(/^#+/, '').trim();
      const group = String(r.group || (channel.includes('/') ? channel.split('/')[0] : channel) || 'other');
      const groupLabel = stripEmDash(r.groupLabel || group);
      const threads = Number(r.threads || 0);
      const messages = Number(r.messages || 0);
      const openTasks = Number(r.openTasks || 0);
      const blockedCount = Number(r.blockedTasks != null ? r.blockedTasks : r.blockedCount || 0);
      const lastAt = r.lastAt || null;
      const lastPreview = humanizeMentions(r.lastPreview || '');
      return {
        raw: r,
        channel,
        path: channel,
        name: stripEmDash(r.name || channel),
        group,
        groupLabel,
        project: stripEmDash(r.project || group),
        threads: Number.isFinite(threads) ? threads : 0,
        messages: Number.isFinite(messages) ? messages : 0,
        openTasks: Number.isFinite(openTasks) ? openTasks : 0,
        blockedCount: Number.isFinite(blockedCount) ? blockedCount : 0,
        lastAt,
        lastPreview,
      };
    }

    function extractItemFields(raw) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const id = item.id != null ? String(item.id) : item.numericId != null ? String(item.numericId) : '';
      const eventId = item.eventId != null ? String(item.eventId) : item.event_id != null ? String(item.event_id) : '';
      const numericRe = item.re != null && /^\d+$/.test(String(item.re)) ? String(item.re) : '';
      const numericId = /^\d+$/.test(id) ? id : item.numericId != null ? String(item.numericId) : '';
      const threadId = String(
        numericRe ||
          numericId ||
          (item.threadId != null
            ? item.threadId
            : item.thread_id != null
              ? item.thread_id
              : item.thread != null
                ? item.thread
                : eventId || id)
      );
      const channel = String(item.channel || item.room || item.board || '');
      const rawActor = String(
        item.byActor ||
          item.by ||
          item.author ||
          item.actor ||
          item.sender ||
          item.from ||
          'agent'
      ).replace(/^@+/, '');
      const meta = parseAgentIdentity(
        rawActor,
        item.brand,
        item.role,
        item.displayName || item.authorName,
        item.byProfile || item.profile
      );
      const actor = meta.handle;
      const rawVia = String(
        item.via ||
          item.host ||
          item.node ||
          item.machine ||
          (meta.brand === 'owner' ? '' : 'local-host')
      );
      const via = /^local:user:/i.test(rawVia) ? '' : rawVia;
      const title = humanizeMentions(item.title || '');
      const text = String(
        item.text != null
          ? item.text
          : item.body != null
            ? item.body
            : item.content != null
              ? item.content
              : item.message || item.summary || ''
      );
      const createdAt =
        item.createdAt ||
        item.created_at ||
        item.lastAt ||
        item.timestamp ||
        item.ts ||
        item.at ||
        '';
      const taskState = String(
        item.taskState ||
          (item.task && item.task.state) ||
          item.status ||
          item.state ||
          item.taskStatus ||
          ''
      ).toLowerCase();
      const isBlocked = Boolean(item.isBlocked || (item.task && item.task.blocked) || taskState === 'blocked');
      const isPaused = Boolean(item.isPaused || item.paused || taskState === 'paused');
      const isOpenTask = Boolean(item.isOpenTask || taskState === 'ready' || taskState === 'open' || taskState === 'claimed');
      const labels = normalizeLabels(item.labels || item.tags);
      const replyCount = Number(
        typeof item.replies === 'number'
          ? item.replies
          : item.replyCount != null
            ? item.replyCount
            : item.reply_count != null
              ? item.reply_count
              : item.repliesCount || 0
      );
      const blockedReason = stripEmDash(
        (item.task && item.task.blocked && item.task.blocked.reason) ||
          (item.task && item.task.reason) ||
          item.reason ||
          ''
      );
      const taskOwner = stripEmDash((item.task && (item.task.owner || item.task.for)) || '');

      return {
        raw: item,
        id,
        eventId,
        threadId,
        channel,
        actor,
        brand: meta.brand,
        glyph: meta.glyph,
        displayName: meta.label,
        via: stripEmDash(via),
        title,
        text,
        createdAt,
        taskState,
        isBlocked,
        isPaused,
        isOpenTask,
        blockedReason,
        taskOwner,
        labels,
        replyCount: Number.isFinite(replyCount) ? replyCount : 0,
      };
    }

    function mentionBrandClass(handle) {
      const b = normalizeBrand(handle, '', '');
      return `is-${b}`;
    }

    function highlightMentionsInEscaped(escapedText) {
      return escapedText.replace(
        /(^|[\s(>])(@[a-zA-Z0-9][a-zA-Z0-9_.-]{0,38})/g,
        function (_match, prefix, handle) {
          const cleanHandle = handle.replace(/^@+/, '');
          const brandCls = mentionBrandClass(cleanHandle);
          return `${prefix}<button type="button" class="eb-mention-tag ${brandCls}" data-mention="${escAttr(cleanHandle)}">${handle}</button>`;
        }
      );
    }

    function renderSafeInline(text) {
      let escaped = escHtml(text);
      escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      escaped = highlightMentionsInEscaped(escaped);
      return escaped;
    }

    function sanitizeExternalHtml(html) {
      return stripEmDash(String(html || ''))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
        .replace(/<embed\b[^>]*>/gi, '')
        .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
    }

    function highlightMentionsInSafeHtml(html) {
      return html.replace(/(^|>)([^<]+)/g, function (_m, lead, segment) {
        return lead + highlightMentionsInEscaped(segment);
      });
    }

    function renderFallbackMessageBody(text, hostHooks) {
      const cleaned = stripEmDash(text || '').trim();
      if (!cleaned) return '<p>(empty message)</p>';

      if (hostHooks && typeof hostHooks.renderMarkdown === 'function') {
        try {
          const rendered = hostHooks.renderMarkdown(cleaned);
          if (typeof rendered === 'string' && rendered.trim()) {
            return highlightMentionsInSafeHtml(sanitizeExternalHtml(rendered));
          }
        } catch {
          // Fallback to internal strict escaped renderer
        }
      }

      const lines = cleaned.replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let inCode = false;
      let codeBuf = [];

      function flushCode() {
        if (inCode) {
          out.push(`<pre><code>${escHtml(codeBuf.join('\n'))}</code></pre>`);
          codeBuf = [];
          inCode = false;
        }
      }

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
          if (inCode) {
            flushCode();
          } else {
            inCode = true;
            codeBuf = [];
          }
          continue;
        }
        if (inCode) {
          codeBuf.push(line);
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed) continue;
        out.push(`<p>${renderSafeInline(trimmed)}</p>`);
      }
      flushCode();
      return out.join('');
    }

    function renderRichOrFallbackBody(rawItem, item, hostHooks, opts) {
      const artifactsMod = getBoardArtifacts();
      if (artifactsMod && typeof artifactsMod.renderRichMessage === 'function') {
        try {
          const payload = Object.assign({}, rawItem && typeof rawItem === 'object' ? rawItem : {}, {
            text: item.text,
          });
          const rendered = artifactsMod.renderRichMessage(payload, {
            compact: Boolean(opts && opts.compact),
            collapsible: Boolean(opts && opts.collapsible),
            expanded: Boolean(opts && opts.expanded),
            logKey: (opts && opts.logKey) || item.threadId || item.id || '',
          });
          if (rendered && typeof rendered.html === 'string' && rendered.html.trim()) {
            return rendered.html;
          }
        } catch {
          // Fall through to safe fallback renderer
        }
      }
      return renderFallbackMessageBody(item.text, hostHooks);
    }

    /* ========================================================================
       @ui-sdk/core (window.KizukiUiSdk) INTEGRATED PRIMITIVES
       ======================================================================== */

    function makeStore(initialState) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.createStore === 'function') {
        const st = sdk.createStore(initialState);
        return {
          get: () => st.get(),
          set: (patch) => st.set(patch),
          subscribe: (fn) => st.subscribe(fn),
          batch: (fn) => (typeof st.batch === 'function' ? st.batch(fn) : fn()),
          raw: st,
        };
      }
      let state = Object.assign({}, initialState);
      const listeners = new Set();
      return {
        get: () => state,
        set: (patch) => {
          const next = typeof patch === 'function' ? patch(state) : Object.assign({}, state, patch);
          state = next;
          listeners.forEach((fn) => {
            try {
              fn(state);
            } catch {
              // ignore
            }
          });
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        batch: (fn) => fn(),
        raw: null,
      };
    }

    function makeTypeahead(options) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.createTypeahead === 'function') {
        return sdk.createTypeahead(options);
      }
      const getItems = typeof options.getItems === 'function' ? options.getItems : () => [];
      const getLabel = typeof options.getLabel === 'function' ? options.getLabel : (x) => String(x || '');
      const getKeywords = typeof options.getKeywords === 'function' ? options.getKeywords : null;
      let lastResults = [];
      return {
        filter(query) {
          const q = String(query == null ? '' : query).trim().toLowerCase();
          const items = getItems() || [];
          const out = [];
          for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const label = String(getLabel(item) || '');
            const low = label.toLowerCase();
            if (!q) {
              out.push({ item, label, score: 0, ranges: [], matchType: 'all', index: i });
              continue;
            }
            const idx = low.indexOf(q);
            if (idx !== -1) {
              out.push({
                item,
                label,
                score: idx === 0 ? 100 : 50,
                ranges: [[idx, idx + q.length]],
                matchType: idx === 0 ? 'prefix' : 'substring',
                index: i,
              });
              continue;
            }
            if (getKeywords) {
              const kws = getKeywords(item) || [];
              if (kws.some((kw) => String(kw || '').toLowerCase().includes(q))) {
                out.push({ item, label, score: 30, ranges: [], matchType: 'keyword', index: i });
              }
            }
          }
          if (q) {
            out.sort((a, b) => b.score - a.score || a.index - b.index);
          }
          lastResults = out;
          return out;
        },
        reset() {
          return this.filter('');
        },
        getResults() {
          return lastResults;
        },
        destroy() {
          lastResults = [];
        },
      };
    }

    function makeSelection(options) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.createSelection === 'function') {
        return sdk.createSelection(options);
      }
      let activeIndex = typeof options.initialIndex === 'number' ? options.initialIndex : -1;
      function resolveItems() {
        const raw = typeof options.getItems === 'function' ? options.getItems() : [];
        return raw ? Array.from(raw) : [];
      }
      function syncDom(items) {
        for (let i = 0; i < items.length; i += 1) {
          const el = items[i];
          if (!el || typeof el.setAttribute !== 'function') continue;
          if (i === activeIndex) {
            el.setAttribute('data-active', 'true');
            el.setAttribute('aria-selected', 'true');
          } else {
            if (typeof el.removeAttribute === 'function') el.removeAttribute('data-active');
            el.setAttribute('aria-selected', 'false');
          }
        }
      }
      function setActiveIndex(idx) {
        const items = resolveItems();
        activeIndex = items.length === 0 || idx < 0 || idx >= items.length ? -1 : idx;
        syncDom(items);
        return activeIndex;
      }
      return {
        getActiveIndex: () => activeIndex,
        getActiveItem: () => {
          const items = resolveItems();
          return activeIndex >= 0 && activeIndex < items.length ? items[activeIndex] : null;
        },
        setActiveIndex,
        moveNext: () => {
          const items = resolveItems();
          if (!items.length) return setActiveIndex(-1);
          return setActiveIndex((activeIndex + 1 + items.length) % items.length);
        },
        movePrev: () => {
          const items = resolveItems();
          if (!items.length) return setActiveIndex(-1);
          return setActiveIndex((activeIndex - 1 + items.length) % items.length);
        },
        selectActive: (ev) => {
          const items = resolveItems();
          if (activeIndex >= 0 && activeIndex < items.length && typeof options.onSelect === 'function') {
            options.onSelect(items[activeIndex], activeIndex, ev || null);
            return items[activeIndex];
          }
          return null;
        },
        handleKeyDown(ev) {
          if (!ev) return false;
          if (ev.key === 'ArrowDown') {
            if (ev.preventDefault) ev.preventDefault();
            this.moveNext();
            return true;
          }
          if (ev.key === 'ArrowUp') {
            if (ev.preventDefault) ev.preventDefault();
            this.movePrev();
            return true;
          }
          if (ev.key === 'Enter') {
            if (activeIndex >= 0) {
              if (ev.preventDefault) ev.preventDefault();
              this.selectActive(ev);
              return true;
            }
          }
          return false;
        },
        sync: () => {
          const items = resolveItems();
          if (activeIndex >= items.length) activeIndex = items.length - 1;
          syncDom(items);
          return activeIndex;
        },
        reset: () => setActiveIndex(-1),
        destroy: () => {
          activeIndex = -1;
        },
      };
    }

    function makeFocusRecovery(options) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.createFocusRecovery === 'function') {
        return sdk.createFocusRecovery(options);
      }
      let captured = null;
      const doc = getDoc();
      return {
        capture(el) {
          captured = el !== undefined ? el : doc ? doc.activeElement : null;
          return captured;
        },
        restore() {
          const fb = typeof options.fallback === 'function' ? options.fallback() : options.fallback;
          const target = captured && captured.isConnected !== false ? captured : fb;
          if (target && typeof target.focus === 'function') {
            try {
              target.focus();
            } catch {
              // ignore
            }
            return { restored: true, element: target };
          }
          return { restored: false, element: null };
        },
        clear() {
          captured = null;
        },
        destroy() {
          captured = null;
        },
      };
    }

    function makeDismissable(options) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.createDismissable === 'function') {
        return sdk.createDismissable(options);
      }
      const doc = getDoc();
      let active = false;
      function onKey(ev) {
        if (!active || !ev || ev.key !== 'Escape') return;
        if (typeof options.onDismiss === 'function') options.onDismiss('escape', ev);
      }
      function onDown(ev) {
        if (!active || !ev) return;
        const el = typeof options.el === 'function' ? options.el() : options.el;
        if (el && typeof el.contains === 'function' && el.contains(ev.target)) return;
        const ignores = safeArray(options.ignoreEls);
        for (let i = 0; i < ignores.length; i += 1) {
          if (ignores[i] && typeof ignores[i].contains === 'function' && ignores[i].contains(ev.target)) {
            return;
          }
        }
        if (typeof options.onDismiss === 'function') options.onDismiss('outside-click', ev);
      }
      function activate() {
        if (active || !doc) return;
        active = true;
        doc.addEventListener('keydown', onKey, true);
        doc.addEventListener('pointerdown', onDown, true);
      }
      function deactivate() {
        if (!active || !doc) return;
        active = false;
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('pointerdown', onDown, true);
      }
      if (options.enabled !== false) activate();
      return {
        activate,
        deactivate,
        isActive: () => active,
        destroy: deactivate,
      };
    }

    function makePopup(options) {
      const sdk = getUiSdk();
      const triggerEl = options.triggerEl || null;
      const contentEl = options.contentEl || null;
      if (sdk && typeof sdk.createPopup === 'function') {
        return sdk.createPopup(options);
      }
      let openState = false;
      const focusRec = makeFocusRecovery({ fallback: () => triggerEl });
      const dismiss = makeDismissable({
        el: contentEl,
        ignoreEls: triggerEl ? [triggerEl] : [],
        enabled: false,
        onDismiss: (reason) => close({ reason }),
      });

      function open() {
        if (openState) return false;
        if (options.restoreFocus !== false) focusRec.capture();
        openState = true;
        if (triggerEl) triggerEl.setAttribute('aria-expanded', 'true');
        if (contentEl) {
          contentEl.hidden = false;
          contentEl.removeAttribute('hidden');
          contentEl.setAttribute('data-state', 'open');
        }
        dismiss.activate();
        if (typeof options.onOpenChange === 'function') options.onOpenChange(true, { placement: options.placement });
        return true;
      }

      function close(closeOpts) {
        if (!openState) return false;
        const cOpts = closeOpts || {};
        openState = false;
        dismiss.deactivate();
        if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
        if (contentEl) {
          contentEl.hidden = true;
          contentEl.setAttribute('hidden', '');
          contentEl.setAttribute('data-state', 'closed');
        }
        if (options.restoreFocus !== false && cOpts.restoreFocus !== false) {
          focusRec.restore();
        }
        if (typeof options.onOpenChange === 'function') {
          options.onOpenChange(false, { reason: cOpts.reason || 'programmatic' });
        }
        return true;
      }

      return {
        open,
        close,
        toggle: () => (openState ? close({ reason: 'toggle' }) : open()),
        reposition: () => ({ x: 0, y: 0, placement: options.placement || 'bottom-start', flipped: false }),
        isOpen: () => openState,
        destroy: () => {
          close({ reason: 'destroy', restoreFocus: false });
          dismiss.destroy();
          focusRec.destroy();
        },
      };
    }

    /* ========================================================================
       HTTP HELPER
       ======================================================================== */

    async function apiFetchJson(url, opts) {
      const fetchFn =
        typeof fetch === 'function'
          ? fetch
          : root && typeof root.fetch === 'function'
            ? root.fetch.bind(root)
            : null;
      if (!fetchFn) {
        throw new Error('Fetch API unavailable');
      }
      const res = await fetchFn(url, opts);
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const baseMsg = stripEmDash(
          (body && (body.message || body.error || body.detail)) ||
            `Request failed (${res.status})`
        ).trim();
        const ruleParts = [];
        if (body && body.rule) {
          const cleanRule = stripEmDash(body.rule).trim();
          if (cleanRule) ruleParts.push(cleanRule);
        }
        if (body && Array.isArray(body.findings)) {
          body.findings.forEach((f) => {
            const r = f && (f.ruleId || f.rule);
            if (r) {
              const cleanR = stripEmDash(String(r)).trim();
              if (cleanR && ruleParts.indexOf(cleanR) === -1) ruleParts.push(cleanR);
            }
          });
        }
        const rulesStr = ruleParts.join(', ');
        const fullMsg =
          rulesStr && !baseMsg.toLowerCase().includes(rulesStr.toLowerCase())
            ? `${baseMsg} (${rulesStr})`
            : baseMsg;
        const err = new Error(fullMsg);
        err.status = res.status;
        err.payload = body;
        throw err;
      }
      return body || {};
    }

    function makeIdempotencyKey() {
      return `eb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /* ========================================================================
       CONTROLLER INSTANCE
       ======================================================================== */

    let activeInstance = null;

    function createController(containerEl, hostHooks) {
      const hooks = hostHooks && typeof hostHooks === 'object' ? hostHooks : {};
      const doc = getDoc();
      const win = getWin();
      const sdk = getUiSdk();

      ensureCompanionStyles(doc);

      if (sdk && typeof sdk.definePrimitive === 'function') {
        try {
          const studioPrimitive = sdk.definePrimitive({
            name: 'evil-rabbit-agent-board',
            state: () => ({ mounted: true }),
            slots: {
              root: { attrs: () => ({ 'data-ui-sdk': 'agent-board' }) },
            },
          });
          if (typeof studioPrimitive === 'function') {
            const inst = studioPrimitive();
            if (inst && typeof inst.destroy === 'function') {
              inst.destroy();
            }
          }
        } catch {
          // Optional metadata registration
        }
      }

      const store = makeStore({
        mounted: true,
        mode: 'rooms', // 'rooms' | 'feed' | 'blockers' | 'taste'
        channel: 'mission', // 'mission' default landing, or any room path
        signalFilter: 'signal', // 'signal' | 'all' | 'telemetry'
        stage: 'thread', // 'thread' | 'canvas' | 'context' | 'live'
        mobileStageOpen: false,
        agentFilter: '',
        roomQuery: '',
        roomGroup: '',
        mentionQuery: '',
        mentionRange: null,
        replyTargetId: null,
        replyTargetPaused: false,
        resumePaused: false,
        composerDraft: '',
        sending: false,
        loadingStream: false,
        loadingThread: false,
        showJumpLatest: false,
        sseStatus: 'connecting', // 'connecting' | 'connected' | 'reconnecting' | 'offline'
        health: null,
        synthReady: false,
        sseHost: null,
        hostHistory: [],
        pairTraffic: [],
        spatialExpanded: false,
        missionData: null,
        telemetrySummary: [],
        telemetryCount: 0,
        signalCount: 0,
        rooms: [],
        roomGroups: [],
        roomsTotal: 0,
        streamItems: [],
        selectedThreadId: null,
        threadDetail: null,
        contextByKey: Object.create(null),
        briefByThread: Object.create(null),
        decisions: [],
        blockers: {
          counts: { attentionTotal: 0, paused: 0, stalled: 0, escalations: 0, orchestratorQueue: 0, intake: 0 },
          orchestratorQueue: [],
          escalations: [],
          paused: [],
          stalled: [],
          intake: [],
        },
        agents: CANONICAL_AGENTS.slice(),
        meshNodes: [],
        seats: [],
        capacityBlockers: [],
        activeRuns: [],
        sseEvents: [],
        banner: null, // { tone: 'ok'|'error'|'info', text: string }
      });

      const cleanups = [];
      let destroyed = false;
      let eventSource = null;
      let sseReconnectTimer = null;
      let sseRetryCount = 0;
      let sseRefreshDebounce = null;
      let bannerTimer = null;
      let loadSeq = 0;
      let contextSeq = 0;

      const HOST_HISTORY_MAX = 120;
      const expandedLogIds = new Set();
      const knownStreamIds = new Set();
      const justArrivedIds = new Set();
      let hasInitialStreamLoaded = false;
      let pendingSseBoardArrival = false;
      let justArrivedClearTimer = null;

      // Wave 2 module instances
      let meshInstance = null;
      let meshMountHost = null;
      let meshExpanded = false;
      let composerSdk = null;
      let keyboardSdk = null;

      // Render Evil Code 3-Pane Studio Shell
      containerEl.innerHTML = buildShellHtml();

      const refs = {
        shell: containerEl.querySelector('.eb-shell'),
        dock: containerEl.querySelector('.eb-dock'),
        dockBlockersBadge: containerEl.querySelector('[data-eb-ref="dock-blockers-badge"]'),
        dockAgents: containerEl.querySelector('.eb-dock-agents'),
        roomTrigger: containerEl.querySelector('[data-eb-ref="room-trigger"]'),
        roomTriggerDot: containerEl.querySelector('[data-eb-ref="room-trigger-dot"]'),
        roomTriggerHash: containerEl.querySelector('[data-eb-ref="room-trigger-hash"]'),
        roomTriggerLabel: containerEl.querySelector('[data-eb-ref="room-trigger-label"]'),
        roomPopupEl: containerEl.querySelector('[data-eb-ref="room-popup"]'),
        roomSearchInput: containerEl.querySelector('[data-eb-ref="room-search"]'),
        roomGroupsEl: containerEl.querySelector('[data-eb-ref="room-groups"]'),
        roomListEl: containerEl.querySelector('[data-eb-ref="room-list"]'),
        newThreadBtn: containerEl.querySelector('[data-eb-ref="new-thread-btn"]'),
        centerHeadRight: containerEl.querySelector('[data-eb-ref="center-head-right"]'),
        telemetryRibbonSlot: containerEl.querySelector('[data-eb-ref="telemetry-ribbon-slot"]'),
        feedScroll: containerEl.querySelector('[data-eb-ref="feed-scroll"]'),
        jumpLatestBtn: containerEl.querySelector('[data-eb-ref="jump-latest"]'),
        mentionPopupEl: containerEl.querySelector('[data-eb-ref="mention-popup"]'),
        mentionListEl: containerEl.querySelector('[data-eb-ref="mention-list"]'),
        slashPopupEl: containerEl.querySelector('[data-eb-ref="slash-popup"]'),
        contextPopupEl: containerEl.querySelector('[data-eb-ref="context-popup"]'),
        composerAttachmentsEl: containerEl.querySelector('[data-eb-ref="composer-attachments"]'),
        composerInput: containerEl.querySelector('[data-eb-ref="composer-input"]'),
        composerAtBtn: containerEl.querySelector('[data-eb-ref="composer-at-btn"]'),
        composerSlashBtn: containerEl.querySelector('[data-eb-ref="composer-slash-btn"]'),
        composerContextBtn: containerEl.querySelector('[data-eb-ref="composer-context-btn"]'),
        composerTargetSlot: containerEl.querySelector('[data-eb-ref="composer-target-slot"]'),
        sendBtn: containerEl.querySelector('[data-eb-ref="send-btn"]'),
        inlineBanner: containerEl.querySelector('[data-eb-ref="inline-banner"]'),
        stageTabs: containerEl.querySelector('[data-eb-ref="stage-tabs"]'),
        stageBody: containerEl.querySelector('[data-eb-ref="stage-body"]'),
      };

      /* --------------------------------------------------------------------
         HOST NAVIGATION BRIDGE (Kizuki Mind OS Views)
         -------------------------------------------------------------------- */

      function jumpToMindView(view, target, opts) {
        const v = String(view || '').trim().toLowerCase();
        const t = String(target || '').trim();
        const o = opts && typeof opts === 'object' ? opts : {};

        if ((v === 'people' || o.kind === 'person') && t && typeof hooks.openPerson === 'function') {
          hooks.openPerson(t);
          return true;
        }
        if ((v === 'vault' || o.kind === 'vault' || o.kind === 'doc') && t && typeof hooks.openDoc === 'function') {
          hooks.openDoc(t);
          return true;
        }
        if (v === 'replay' && t && typeof hooks.openReplayDay === 'function') {
          hooks.openReplayDay(t);
          return true;
        }
        if (typeof hooks.openView === 'function') {
          hooks.openView(v || 'vault', t, o);
          return true;
        }
        if (typeof hooks.switchView === 'function') {
          const payload = Object.assign({}, o);
          if (v === 'replay' && t) payload.day = t;
          else if (v === 'taste' && t) payload.domain = t;
          else if (v === 'codex' && t) {
            if (t === 'ideas' || t === 'actions' || t === 'philosophies') payload.section = t;
            else payload.itemId = t;
          } else if (v === 'vault' && t) payload.q = t;
          else if (v === 'people' && t) payload.person = t;
          hooks.switchView(v || 'vault', payload);
          return true;
        }
        if (o.kind === 'commit' && t) {
          if (win && win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
            Promise.resolve(win.navigator.clipboard.writeText(t)).catch(() => {});
          }
          showFeedback(`Copied commit ${t.slice(0, 8)}`, 'ok');
          return true;
        }
        return false;
      }

      function resolvePostChannel(channel) {
        const ch = String(channel || '').replace(/^#+/, '').trim();
        if (!ch || ch === 'mission') return 'box';
        return ch;
      }

      function resolveActiveThreadChannel() {
        const st = store.get();
        if (st.threadDetail && st.threadDetail.root && st.threadDetail.root.channel) {
          return String(st.threadDetail.root.channel).replace(/^#+/, '').trim();
        }
        if (st.selectedThreadId) {
          const hit = st.streamItems.find((it) => extractItemFields(it).threadId === st.selectedThreadId);
          if (hit) {
            const f = extractItemFields(hit);
            if (f.channel) return f.channel.replace(/^#+/, '').trim();
          }
        }
        return resolvePostChannel(st.channel);
      }

      function isBoardVisible() {
        if (!containerEl) return false;
        let cur = containerEl;
        let depth = 0;
        while (cur && depth < 6) {
          depth += 1;
          if (cur.hidden === true) return false;
          if (typeof cur.getAttribute === 'function') {
            const h = cur.getAttribute('hidden');
            if (h !== null && h !== 'false') return false;
            if (cur.getAttribute('aria-hidden') === 'true') return false;
          }
          if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) {
            return false;
          }
          if (cur.id === 'view-board') break;
          cur = cur.parentElement || cur.parentNode || null;
        }
        return true;
      }

      /* --------------------------------------------------------------------
         @ui-sdk/core POPUP 1: ROOM SWITCHER (Mission Signal + 101+ rooms)
         -------------------------------------------------------------------- */

      const roomTypeahead = makeTypeahead({
        getItems: () => {
          const st = store.get();
          const grp = st.roomGroup.trim().toLowerCase();
          if (!grp) return st.rooms;
          return st.rooms.filter((r) => {
            const g = String(r.group || '').toLowerCase();
            const c = String(r.channel || '').toLowerCase();
            return g === grp || c === grp || c.startsWith(`${grp}/`);
          });
        },
        getLabel: (r) => r.channel || r.name || '',
        getKeywords: (r) => [r.group, r.groupLabel, r.name, r.lastPreview].filter(Boolean),
        maxResults: 120,
      });
      cleanups.push(() => roomTypeahead.destroy && roomTypeahead.destroy());

      const roomFocusRecovery = makeFocusRecovery({
        doc,
        fallback: () => refs.roomTrigger,
      });
      cleanups.push(() => roomFocusRecovery.destroy && roomFocusRecovery.destroy());

      const roomSelection = makeSelection({
        getItems: () =>
          refs.roomListEl ? Array.from(refs.roomListEl.querySelectorAll('.eb-room-option')) : [],
        loop: true,
        orientation: 'vertical',
        selectOnSpace: false,
        inputEl: refs.roomSearchInput,
        idPrefix: 'eb-room-opt',
        onSelect: (optionEl) => {
          const channel = optionEl && optionEl.getAttribute('data-room-path');
          if (channel) selectRoom(channel);
        },
      });
      cleanups.push(() => roomSelection.destroy && roomSelection.destroy());

      const roomPopup = makePopup({
        doc,
        triggerEl: refs.roomTrigger,
        contentEl: refs.roomPopupEl,
        placement: 'bottom-start',
        offset: 6,
        strategy: 'fixed',
        closeOnOutsideClick: true,
        closeOnEscape: true,
        restoreFocus: true,
        onOpenChange: (isOpen) => {
          if (isOpen) {
            roomFocusRecovery.capture(refs.roomTrigger);
            renderRoomPopover();
            roomSelection.setActiveIndex(0, { scroll: false });
            if (refs.roomSearchInput && typeof refs.roomSearchInput.focus === 'function') {
              try {
                refs.roomSearchInput.focus();
              } catch {
                // ignore
              }
            }
          } else {
            roomSelection.reset();
          }
        },
      });
      cleanups.push(() => roomPopup.destroy && roomPopup.destroy());

      const replyDismissable = makeDismissable({
        doc,
        el: containerEl,
        enabled: false,
        closeOnOutsideClick: false,
        closeOnEscape: true,
        onDismiss: (reason) => {
          if (
            reason === 'escape' &&
            store.get().replyTargetId &&
            !roomPopup.isOpen() &&
            !mentionPopup.isOpen() &&
            !(composerSdk && composerSdk.isOpen())
          ) {
            startNewThreadInRoom();
          }
        },
      });
      cleanups.push(() => replyDismissable.destroy && replyDismissable.destroy());

      /* --------------------------------------------------------------------
         @ui-sdk/core POPUP 2: @mention AUTOCOMPLETE (top-start)
         -------------------------------------------------------------------- */

      function getAllMentionAgents() {
        const st = store.get();
        const seen = new Set();
        const merged = [];

        function pushAgent(item) {
          const rawActor = String(item.actor || item.handle || '').replace(/^@+/, '').trim();
          if (!rawActor) return;
          const meta = parseAgentIdentity(rawActor, item.brand, item.role, item.displayName, item.profile);
          const handle = meta.handle;
          if (!handle) return;
          const key = handle.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          merged.push({
            actor: handle,
            displayName: meta.label,
            role: stripEmDash(item.role || item.profile || 'Agent'),
            brand: meta.brand,
            glyph: meta.glyph,
            activeRecent: item.activeRecent !== false,
          });
        }

        safeArray(st.agents).forEach(pushAgent);
        CANONICAL_AGENTS.forEach(pushAgent);
        return merged;
      }

      const mentionTypeahead = makeTypeahead({
        getItems: () => getAllMentionAgents(),
        getLabel: (a) => a.actor,
        getKeywords: (a) => [a.displayName, a.role, `@${a.actor}`],
        maxResults: 24,
      });
      cleanups.push(() => mentionTypeahead.destroy && mentionTypeahead.destroy());

      const mentionSelection = makeSelection({
        getItems: () =>
          refs.mentionListEl ? Array.from(refs.mentionListEl.querySelectorAll('.eb-mention-item')) : [],
        loop: true,
        orientation: 'vertical',
        selectOnSpace: false,
        inputEl: refs.composerInput,
        idPrefix: 'eb-mention-opt',
        onSelect: (optionEl) => {
          const actor = optionEl && optionEl.getAttribute('data-mention-actor');
          if (actor) insertMentionHandle(actor);
        },
      });
      cleanups.push(() => mentionSelection.destroy && mentionSelection.destroy());

      const mentionAnchorEl =
        (refs.composerInput &&
          typeof refs.composerInput.closest === 'function' &&
          refs.composerInput.closest('.eb-composer')) ||
        refs.composerAtBtn;
      const mentionPopup = makePopup({
        doc,
        triggerEl: mentionAnchorEl,
        contentEl: refs.mentionPopupEl,
        placement: 'top-start',
        offset: 8,
        strategy: 'fixed',
        closeOnOutsideClick: true,
        closeOnEscape: true,
        restoreFocus: false,
        onOpenChange: (isOpen) => {
          if (isOpen) {
            if (composerSdk && typeof composerSdk.closeAll === 'function') {
              composerSdk.closeAll(false);
            }
            if (refs.mentionPopupEl && refs.mentionPopupEl.style) {
              refs.mentionPopupEl.style.bottom = 'auto';
              refs.mentionPopupEl.style.right = 'auto';
            }
            renderMentionPopover();
            mentionSelection.setActiveIndex(0, { scroll: false });
            if (mentionPopup && typeof mentionPopup.reposition === 'function') {
              mentionPopup.reposition();
            }
          } else {
            mentionSelection.reset();
          }
        },
      });
      cleanups.push(() => mentionPopup.destroy && mentionPopup.destroy());

      /* --------------------------------------------------------------------
         INLINE TOAST / FEEDBACK BANNER
         -------------------------------------------------------------------- */

      function showFeedback(text, tone) {
        const clean = stripEmDash(text || '');
        const nextTone = tone || 'info';
        store.set({ banner: clean ? { text: clean, tone: nextTone } : null });
        renderInlineBanner();
        if (bannerTimer) {
          clearTimeout(bannerTimer);
          bannerTimer = null;
        }
        if (clean) {
          bannerTimer = setTimeout(() => {
            if (destroyed) return;
            store.set({ banner: null });
            renderInlineBanner();
          }, nextTone === 'error' ? 7000 : 3400);
        }
        if (clean && typeof hooks.showToast === 'function') {
          try {
            hooks.showToast(clean, nextTone === 'ok' ? 'success' : nextTone);
          } catch {
            // ignore host toast failure
          }
        }
      }

      /* --------------------------------------------------------------------
         SPATIAL MESH CANVAS LIFECYCLE (window.KizukiBoardMesh)
         -------------------------------------------------------------------- */

      function resolveSynthReady(st) {
        const cur = st || store.get();
        return Boolean(
          cur.synthReady === true ||
            (cur.missionData && cur.missionData.synthReady === true) ||
            (cur.health &&
              (cur.health.synthReady === true ||
                cur.health.localLlmOnline === true ||
                (cur.health.localLlm && cur.health.localLlm.ready === true)))
        );
      }

      function finiteOrNull(val) {
        if (val === null || val === undefined || val === '') return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
      }

      function pushHostHistorySample(hostObj, history) {
        const list = Array.isArray(history) ? history : [];
        if (!hostObj || typeof hostObj !== 'object') return list;
        const load1 = finiteOrNull(hostObj.load1);
        const cpus = finiteOrNull(hostObj.cpus);
        const memAvail = finiteOrNull(hostObj.mem_available_gib);
        const memTotal = finiteOrNull(hostObj.mem_total_gib);
        if (load1 === null && cpus === null && memAvail === null && memTotal === null) {
          return list;
        }
        const rawTs = finiteOrNull(hostObj.ts);
        const sample = {
          ts: rawTs !== null && rawTs >= 1000000000000 ? rawTs : Date.now(),
          load1,
          cpus,
          mem_available_gib: memAvail,
          mem_total_gib: memTotal,
        };
        const next = list.concat([sample]);
        return next.length > HOST_HISTORY_MAX ? next.slice(next.length - HOST_HISTORY_MAX) : next;
      }

      function computePairTraffic(st) {
        const state = st || store.get();
        const buckets = Object.create(null);

        function bump(rawFrom, rawTo, rawBrand, rawAt) {
          const from = extractActorSlug(rawFrom, '') || String(rawFrom || '').replace(/^@+/, '').trim();
          const to = String(rawTo || '').replace(/^#+/, '').trim();
          if (!from || !to) return;
          const key = `${from.toLowerCase()}->${to.toLowerCase()}`;
          const tsMs = rawAt ? Date.parse(String(rawAt)) : 0;
          const validMs = Number.isFinite(tsMs) ? tsMs : 0;
          if (!buckets[key]) {
            const meta = parseAgentIdentity(from, rawBrand || '', '', '', null);
            buckets[key] = {
              from: meta.handle,
              to,
              actor: meta.handle,
              channel: to,
              brand: meta.brand,
              count: 0,
              lastAt: rawAt ? String(rawAt) : '',
              lastAtMs: validMs,
            };
          }
          buckets[key].count += 1;
          if (validMs > buckets[key].lastAtMs) {
            buckets[key].lastAtMs = validMs;
            buckets[key].lastAt = String(rawAt || '');
          }
        }

        const missionItems =
          state.missionData && Array.isArray(state.missionData.items)
            ? state.missionData.items
            : [];
        const sourceItems = missionItems.length ? missionItems : safeArray(state.streamItems);

        for (let i = 0; i < sourceItems.length; i += 1) {
          const raw = sourceItems[i];
          if (!raw || typeof raw !== 'object') continue;
          const f = extractItemFields(raw);
          if (f.channel) {
            bump(f.actor, f.channel, f.brand, f.createdAt);
            const previews = Array.isArray(raw.replyPreview) ? raw.replyPreview : [];
            for (let j = 0; j < previews.length; j += 1) {
              const rp = previews[j];
              if (!rp || typeof rp !== 'object') continue;
              bump(
                rp.byProfile || rp.byActor || rp.by || rp.actor || '',
                f.channel,
                rp.brand || '',
                rp.createdAt || f.createdAt
              );
            }
            const parts = Array.isArray(raw.participants) ? raw.participants : [];
            for (let j = 0; j < parts.length; j += 1) {
              const p = parts[j];
              const handle = typeof p === 'string' ? p : p && (p.handle || p.by || p.actor || '');
              if (handle && handle.toLowerCase() !== f.actor.toLowerCase()) {
                bump(handle, f.channel, typeof p === 'object' && p ? p.brand : '', f.createdAt);
              }
            }
          }
        }

        const events = safeArray(state.sseEvents);
        for (let i = 0; i < events.length; i += 1) {
          const ev = events[i];
          if (!ev || typeof ev !== 'object') continue;
          if (ev.actor && ev.channel) {
            bump(ev.actor, ev.channel, '', ev.at);
          }
        }

        return Object.keys(buckets)
          .map((k) => buckets[k])
          .sort((a, b) => b.count - a.count || b.lastAtMs - a.lastAtMs)
          .slice(0, 60);
      }

      function markJustArrived(ids) {
        const list = safeArray(ids)
          .map((v) => String(v == null ? '' : v).trim())
          .filter(Boolean);
        if (!list.length) return;
        for (let i = 0; i < list.length; i += 1) {
          justArrivedIds.add(list[i]);
        }
        if (justArrivedClearTimer) {
          clearTimeout(justArrivedClearTimer);
        }
        justArrivedClearTimer = setTimeout(() => {
          justArrivedClearTimer = null;
          justArrivedIds.clear();
        }, 1600);
      }

      function buildMeshPayload() {
        const st = store.get();
        const pairTraffic =
          Array.isArray(st.pairTraffic) && st.pairTraffic.length
            ? st.pairTraffic
            : computePairTraffic(st);
        return {
          health: st.health,
          agents: st.agents,
          meshNodes: st.meshNodes,
          seats: st.seats,
          capacityBlockers: st.capacityBlockers,
          activeRuns: st.activeRuns,
          rooms: st.rooms,
          mission: st.missionData,
          blockers: st.blockers,
          decisions: st.decisions,
          host: st.sseHost,
          hostHistory: safeArray(st.hostHistory),
          pairTraffic,
          sseEvents: safeArray(st.sseEvents),
          synthReady: resolveSynthReady(st),
          selectedAgent: st.agentFilter || null,
          selectedRoom: st.channel && st.channel !== 'mission' ? st.channel : null,
        };
      }

      function setSpatialExpanded(nextExpanded) {
        const target = Boolean(nextExpanded);
        const hostEl =
          meshMountHost || (refs.stageBody && refs.stageBody.querySelector('[data-eb-ref="mesh-mount"]'));
        const reducedMotion =
          Boolean(
            win &&
              typeof win.matchMedia === 'function' &&
              win.matchMedia('(prefers-reduced-motion: reduce)').matches
          );
        let firstRect = null;
        if (!reducedMotion && hostEl && typeof hostEl.getBoundingClientRect === 'function') {
          try {
            firstRect = hostEl.getBoundingClientRect();
          } catch {
            firstRect = null;
          }
        }

        meshExpanded = target;
        store.set({ spatialExpanded: meshExpanded });
        if (refs.shell) {
          refs.shell.classList.toggle('is-spatial-expanded', meshExpanded);
          refs.shell.setAttribute('data-spatial-expanded', meshExpanded ? 'true' : 'false');
        }
        if (hostEl) {
          hostEl.classList.toggle('is-expanded', meshExpanded);
          const nextH = win && win.innerWidth && win.innerWidth <= 460 ? '320px' : '340px';
          hostEl.style.height = meshExpanded ? '' : nextH;
          if (
            firstRect &&
            firstRect.width > 0 &&
            firstRect.height > 0 &&
            typeof hostEl.getBoundingClientRect === 'function' &&
            typeof hostEl.animate === 'function'
          ) {
            try {
              const lastRect = hostEl.getBoundingClientRect();
              if (lastRect && lastRect.width > 0 && lastRect.height > 0) {
                const dx = firstRect.left - lastRect.left;
                const dy = firstRect.top - lastRect.top;
                const sx = firstRect.width / lastRect.width;
                const sy = firstRect.height / lastRect.height;
                if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
                  hostEl.animate(
                    [
                      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
                      { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
                    ],
                    { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
                  );
                }
              }
            } catch {
              // Ignore FLIP animation failures in headless/mock DOMs
            }
          }
        }

        if (meshInstance && typeof meshInstance.setExpanded === 'function') {
          try {
            meshInstance.setExpanded(meshExpanded);
          } catch {
            // ignore
          }
        }
        if (meshInstance && typeof meshInstance.resize === 'function') {
          try {
            meshInstance.resize();
          } catch {
            // ignore
          }
        }
        renderDock();
        if (store.get().stage === 'live') {
          const existingSections = refs.stageBody && refs.stageBody.querySelector('[data-eb-ref="live-sections"]');
          if (existingSections) existingSections.innerHTML = renderLiveSectionsHtml();
        }
      }

      function toggleSpatialCommandMode() {
        const st = store.get();
        if (st.stage !== 'live') {
          meshExpanded = true;
          store.set({ spatialExpanded: true });
          setStage('live', { mobileOpen: true, preserveSpatialExpanded: true });
          setSpatialExpanded(true);
          return;
        }
        setSpatialExpanded(!meshExpanded);
      }

      function unmountMesh() {
        if (meshInstance && typeof meshInstance.destroy === 'function') {
          try {
            meshInstance.destroy();
          } catch {
            // ignore mesh destroy errors
          }
        }
        meshInstance = null;
        meshMountHost = null;
      }

      function syncMeshData() {
        if (!meshInstance || typeof meshInstance.update !== 'function') return;
        try {
          meshInstance.update(buildMeshPayload());
        } catch {
          // ignore
        }
      }

      function mountOrUpdateMesh(hostEl) {
        if (!hostEl) return;
        const meshMod = getBoardMesh();
        if (!meshMod || typeof meshMod.mount !== 'function') return;

        if (meshInstance && meshMountHost === hostEl) {
          syncMeshData();
          return;
        }

        unmountMesh();
        meshMountHost = hostEl;
        hostEl.classList.toggle('is-expanded', meshExpanded);
        const compactMeshHeight = win && win.innerWidth && win.innerWidth <= 460 ? '320px' : '340px';
        hostEl.style.height = meshExpanded ? '' : compactMeshHeight;

        try {
          meshInstance = meshMod.mount(hostEl, {
            initialData: buildMeshPayload(),
            theme: getCurrentTheme(doc),
            detail: getCurrentDetail(doc, win),
            expanded: meshExpanded,
            onSelectAgent: (ag) => {
              const handle =
                (ag && (ag.handle || ag.actor || ag.profile)) ||
                (typeof ag === 'string' ? ag : '');
              if (handle) toggleAgentFilter(handle, false);
            },
            onSelectRoom: (channel) => {
              if (channel) selectRoom(channel);
            },
            onSelectDecision: (decision) => {
              const tid =
                typeof decision === 'string' || typeof decision === 'number'
                  ? String(decision).trim()
                  : decision && typeof decision === 'object'
                    ? String(
                        decision.threadId ||
                          decision.thread_id ||
                          decision.numericId ||
                          decision.id ||
                          decision.re ||
                          ''
                      ).trim()
                    : '';
              if (meshExpanded) {
                setSpatialExpanded(false);
              }
              if (tid) {
                openThreadInspector(tid, { switchMobile: true });
              } else {
                setStage('canvas', { mobileOpen: true });
              }
            },
            onToggleExpand: (isExpanded) => {
              setSpatialExpanded(Boolean(isExpanded));
            },
          });
        } catch {
          meshInstance = null;
          meshMountHost = null;
        }
      }

      function triggerMeshPulse(eventPayload) {
        if (!meshInstance || typeof meshInstance.triggerPulse !== 'function') return;
        try {
          meshInstance.triggerPulse(eventPayload);
        } catch {
          // ignore
        }
      }

      function syncThemeAndDetailToMesh() {
        if (!meshInstance) return;
        const nextTheme = getCurrentTheme(doc);
        const nextDetail = getCurrentDetail(doc, win);
        if (typeof meshInstance.setTheme === 'function') {
          try {
            meshInstance.setTheme(nextTheme);
          } catch {
            // ignore
          }
        }
        if (typeof meshInstance.setDetail === 'function') {
          try {
            meshInstance.setDetail(nextDetail);
          } catch {
            // ignore
          }
        }
      }

      // Sync theme (kizuki:theme) and ?detail=on|off attribute changes to meshInstance
      const onThemeEvent = (evt) => {
        if (destroyed || !meshInstance) return;
        const detailTheme = evt && evt.detail && (evt.detail.theme || evt.detail);
        if (detailTheme === 'light' || detailTheme === 'dark') {
          if (typeof meshInstance.setTheme === 'function') meshInstance.setTheme(detailTheme);
        } else {
          syncThemeAndDetailToMesh();
        }
      };
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('kizuki:theme', onThemeEvent);
        cleanups.push(() => win.removeEventListener('kizuki:theme', onThemeEvent));
      }
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('kizuki:theme', onThemeEvent);
        cleanups.push(() => doc.removeEventListener('kizuki:theme', onThemeEvent));
      }
      const MutationObserverCtor =
        (win && typeof win.MutationObserver === 'function' && win.MutationObserver) ||
        (typeof MutationObserver === 'function' ? MutationObserver : null);
      if (MutationObserverCtor && doc && doc.documentElement) {
        try {
          const mo = new MutationObserverCtor(() => {
            if (!destroyed) syncThemeAndDetailToMesh();
          });
          mo.observe(doc.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'data-detail'],
          });
          cleanups.push(() => mo.disconnect());
        } catch {
          // Ignore in minimal mock DOMs
        }
      }

      /* --------------------------------------------------------------------
         DATA LOADERS (REST CONTRACT: agent-board-api.ts + board-mind-bridge.ts)
         -------------------------------------------------------------------- */

      function computeBlockerTotal(blockersObj) {
        if (!blockersObj || typeof blockersObj !== 'object') return 0;
        const c = blockersObj.counts && typeof blockersObj.counts === 'object' ? blockersObj.counts : null;
        if (c && Number.isFinite(Number(c.attentionTotal))) return Number(c.attentionTotal);
        if (c && Number.isFinite(Number(c.total))) return Number(c.total);
        return (
          safeArray(blockersObj.paused).length +
          safeArray(blockersObj.stalled).length +
          safeArray(blockersObj.escalations).length +
          safeArray(blockersObj.orchestratorQueue).length
        );
      }

      async function fetchHealth() {
        try {
          const data = await apiFetchJson('/api/agent-board/health');
          if (destroyed) return;
          const patch = { health: data };
          if (typeof data.synthReady === 'boolean') {
            patch.synthReady = data.synthReady;
          } else if (typeof data.localLlmOnline === 'boolean') {
            patch.synthReady = data.localLlmOnline;
          } else if (data.localLlm && typeof data.localLlm.ready === 'boolean') {
            patch.synthReady = data.localLlm.ready;
          }
          if (Array.isArray(data.seats) && data.seats.length) {
            patch.seats = data.seats;
          }
          if (Array.isArray(data.mesh) && data.mesh.length) {
            patch.meshNodes = data.mesh;
          } else if (data.mesh && Array.isArray(data.mesh.nodes)) {
            patch.meshNodes = data.mesh.nodes;
          }
          if (data.host && typeof data.host === 'object') {
            patch.sseHost = Object.assign({}, store.get().sseHost || {}, data.host);
            patch.hostHistory = pushHostHistorySample(patch.sseHost, store.get().hostHistory);
          }
          store.set(patch);
          if (
            typeof hooks.updateNavCount === 'function' &&
            data.totals &&
            Number.isFinite(Number(data.totals.channels))
          ) {
            try {
              hooks.updateNavCount(Number(data.totals.channels));
            } catch {
              // ignore
            }
          }
          if (store.get().stage === 'live') {
            renderStage();
            syncMeshData();
          }
        } catch {
          // Non-fatal
        }
      }

      async function fetchRooms() {
        try {
          const data = await apiFetchJson('/api/agent-board/rooms?sort=recent');
          if (destroyed) return;
          const rooms = safeArray(data.rooms).map(extractRoomFields).filter((r) => r.channel);
          const groups = safeArray(data.groups);
          const total = Number.isFinite(Number(data.total)) ? Number(data.total) : rooms.length;
          store.set({ rooms, roomGroups: groups, roomsTotal: total });
          if (typeof hooks.updateNavCount === 'function' && total > 0) {
            try {
              hooks.updateNavCount(total);
            } catch {
              // ignore
            }
          }
          renderHeader();
          if (roomPopup.isOpen()) {
            renderRoomPopover();
            roomSelection.sync({ scroll: false });
          }
          if (store.get().stage === 'live') renderStage();
        } catch {
          // Non-fatal
        }
      }

      async function fetchAgents() {
        try {
          const data = await apiFetchJson('/api/agent-board/agents');
          if (destroyed) return;
          const patch = {};
          if (Array.isArray(data.agents) && data.agents.length) {
            patch.agents = data.agents;
          }
          if (Array.isArray(data.meshNodes)) patch.meshNodes = data.meshNodes;
          if (Array.isArray(data.seats)) patch.seats = data.seats;
          if (Array.isArray(data.capacityBlockers)) patch.capacityBlockers = data.capacityBlockers;
          if (Array.isArray(data.activeRuns)) patch.activeRuns = data.activeRuns;
          store.set(patch);
          renderDock();
          if (mentionPopup.isOpen()) {
            renderMentionPopover();
            mentionSelection.sync({ scroll: false });
          }
          if (store.get().stage === 'live') renderStage();
        } catch {
          // Non-fatal
        }
      }

      async function fetchBlockers() {
        try {
          const data = await apiFetchJson('/api/agent-board/blockers');
          if (destroyed) return;
          const nextBlockers = {
            counts: data.counts || {},
            orchestratorQueue: safeArray(data.orchestratorQueue),
            escalations: safeArray(data.escalations),
            paused: safeArray(data.paused),
            stalled: safeArray(data.stalled),
            intake: safeArray(data.intake),
          };
          store.set({ blockers: nextBlockers });
          renderDock();
          if (store.get().mode === 'blockers') renderStream();
          if (store.get().stage === 'canvas') renderStage();
          if (store.get().stage === 'live') syncMeshData();
        } catch {
          // Non-fatal
        }
      }

      async function fetchDecisions() {
        try {
          const data = await apiFetchJson('/api/agent-board/threads?channel=kizuki%2Fdecisions&limit=25&state=all');
          if (destroyed) return;
          store.set({ decisions: safeArray(data.threads || data.items) });
          if (store.get().stage === 'canvas') renderStage();
          if (store.get().stage === 'live') syncMeshData();
        } catch {
          try {
            const data = await apiFetchJson('/api/agent-board/rooms/kizuki%2Fdecisions/threads?limit=25&state=all');
            if (destroyed) return;
            store.set({ decisions: safeArray(data.threads || data.items) });
            if (store.get().stage === 'canvas') renderStage();
            if (store.get().stage === 'live') syncMeshData();
          } catch {
            // Non-fatal
          }
        }
      }

      async function fetchMissionSnapshot() {
        try {
          const data = await apiFetchJson('/api/agent-board/mission?limit=20&includeTelemetry=false');
          if (destroyed) return;
          const patch = { missionData: data };
          if (typeof data.synthReady === 'boolean') patch.synthReady = data.synthReady;
          patch.pairTraffic = computePairTraffic(Object.assign({}, store.get(), patch));
          store.set(patch);
          if (store.get().stage === 'live') {
            renderStage();
            syncMeshData();
          }
        } catch {
          // Non-fatal
        }
      }

      function applyAgentFilter(items, author) {
        if (!author) return items;
        const needle = String(author).toLowerCase();
        return items.filter((x) => {
          const f = extractItemFields(x);
          return (
            f.actor.toLowerCase().includes(needle) ||
            f.displayName.toLowerCase().includes(needle) ||
            f.brand === needle
          );
        });
      }

      function applySignalFilterToItems(rawItems, signalFilter) {
        const list = safeArray(rawItems);
        if (signalFilter === 'all') return list;
        if (signalFilter === 'telemetry') {
          return list.filter((it) => isTelemetryItem(it));
        }
        return list.filter((it) => !isTelemetryItem(it));
      }

      function pickRichestTopThread(items) {
        const list = safeArray(items);
        if (!list.length) return null;
        let bestWithReplies = null;
        let bestReplyCount = 0;
        for (let i = 0; i < list.length; i += 1) {
          const f = extractItemFields(list[i]);
          if (f.replyCount > bestReplyCount) {
            bestReplyCount = f.replyCount;
            bestWithReplies = list[i];
          }
        }
        return bestWithReplies || list[0];
      }

      async function fetchStream(opts) {
        const seq = ++loadSeq;
        const st = store.get();
        const mode = (opts && opts.mode) || st.mode;
        const channel = (opts && opts.channel) || st.channel || 'mission';
        const author = opts && opts.agentFilter !== undefined ? opts.agentFilter : st.agentFilter;
        const signalFilter = (opts && opts.signalFilter) || st.signalFilter || 'signal';

        store.set({ loadingStream: true });
        renderStream();

        try {
          let items = [];
          let telemetryCount = 0;
          let signalCount = 0;
          let telemetrySummary = [];
          let missionPatch = null;

          if (mode === 'feed') {
            const params = new URLSearchParams();
            params.set('limit', '50');
            if (author) params.set('author', author);
            if (signalFilter === 'signal') params.set('signalOnly', 'true');
            const data = await apiFetchJson(`/api/agent-board/feed?${params.toString()}`);
            const rawItems = safeArray(data.items);
            const clientSummary = buildClientTelemetrySummary(rawItems);
            telemetryCount = Number.isFinite(Number(data.telemetryCount))
              ? Number(data.telemetryCount)
              : rawItems.filter(isTelemetryItem).length;
            signalCount = Number.isFinite(Number(data.signalCount))
              ? Number(data.signalCount)
              : rawItems.length - rawItems.filter(isTelemetryItem).length;
            telemetrySummary = Array.isArray(data.telemetrySummary) ? data.telemetrySummary : clientSummary;
            items = applySignalFilterToItems(rawItems, signalFilter);
          } else if (mode === 'blockers') {
            await fetchBlockers();
            if (destroyed || seq !== loadSeq) return;
            const b = store.get().blockers;
            const combined = []
              .concat(safeArray(b.escalations).map((x) => Object.assign({ taskState: 'blocked' }, x)))
              .concat(safeArray(b.paused).map((x) => Object.assign({ isPaused: true, taskState: 'paused' }, x)))
              .concat(safeArray(b.stalled).map((x) => Object.assign({ isBlocked: true, taskState: 'stalled' }, x)))
              .concat(safeArray(b.orchestratorQueue).map((x) => Object.assign({ taskState: 'ready' }, x)));
            items = applyAgentFilter(combined, author);
            signalCount = items.length;
            telemetryCount = 0;
          } else if (mode === 'rooms' && channel === 'mission') {
            const includeTelemetry = signalFilter !== 'signal';
            let data = null;
            try {
              data = await apiFetchJson(
                `/api/agent-board/mission?limit=40&includeTelemetry=${includeTelemetry ? 'true' : 'false'}`
              );
              missionPatch = data;
            } catch {
              // Graceful fallback to #box threads if /mission is unavailable
              data = await apiFetchJson('/api/agent-board/threads?channel=box&limit=40&state=all');
            }
            const rawItems = safeArray(data.items || data.threads);
            const clientSummary = buildClientTelemetrySummary(rawItems);
            telemetryCount = Number.isFinite(Number(data.telemetryCount))
              ? Number(data.telemetryCount)
              : rawItems.filter(isTelemetryItem).length;
            signalCount = Number.isFinite(Number(data.signalCount))
              ? Number(data.signalCount)
              : rawItems.filter((x) => !isTelemetryItem(x)).length;
            telemetrySummary =
              Array.isArray(data.telemetrySummary) && data.telemetrySummary.length
                ? data.telemetrySummary
                : clientSummary;
            items = applyAgentFilter(applySignalFilterToItems(rawItems, signalFilter), author);
          } else {
            const params = new URLSearchParams();
            params.set('channel', channel);
            params.set('limit', '40');
            params.set('state', 'all');
            if (signalFilter === 'signal') params.set('signalOnly', 'true');
            let data = null;
            try {
              data = await apiFetchJson(`/api/agent-board/threads?${params.toString()}`);
            } catch {
              data = await apiFetchJson(
                `/api/agent-board/rooms/${encodeURIComponent(channel)}/threads?limit=40&state=all${signalFilter === 'signal' ? '&signalOnly=true' : ''}`
              );
            }
            const rawItems = safeArray(data.threads || data.items);
            const clientSummary = buildClientTelemetrySummary(rawItems);
            telemetryCount = Number.isFinite(Number(data.telemetryCount))
              ? Number(data.telemetryCount)
              : rawItems.filter(isTelemetryItem).length;
            signalCount = Number.isFinite(Number(data.signalCount))
              ? Number(data.signalCount)
              : rawItems.filter((x) => !isTelemetryItem(x)).length;
            telemetrySummary =
              Array.isArray(data.telemetrySummary) && data.telemetrySummary.length
                ? data.telemetrySummary
                : clientSummary;
            items = applyAgentFilter(applySignalFilterToItems(rawItems, signalFilter), author);
          }

          if (destroyed || seq !== loadSeq) return;
          if (hasInitialStreamLoaded && pendingSseBoardArrival) {
            const freshIds = [];
            for (let i = 0; i < items.length; i += 1) {
              const f = extractItemFields(items[i]);
              const key = f.threadId || f.id;
              if (key && !knownStreamIds.has(key)) {
                freshIds.push(key);
                if (f.id && f.id !== key) freshIds.push(f.id);
              }
            }
            if (freshIds.length) markJustArrived(freshIds);
          }
          for (let i = 0; i < items.length; i += 1) {
            const f = extractItemFields(items[i]);
            if (f.threadId) knownStreamIds.add(f.threadId);
            if (f.id) knownStreamIds.add(f.id);
          }
          hasInitialStreamLoaded = true;
          pendingSseBoardArrival = false;

          const patch = {
            streamItems: items,
            loadingStream: false,
            telemetryCount,
            signalCount,
            telemetrySummary,
          };
          if (missionPatch) {
            patch.missionData = missionPatch;
            if (typeof missionPatch.synthReady === 'boolean') {
              patch.synthReady = missionPatch.synthReady;
            }
          }
          patch.pairTraffic = computePairTraffic(Object.assign({}, store.get(), patch));
          store.set(patch);
          renderHeader();
          renderTelemetryRibbonSlot();
          renderStream();
          if (store.get().stage === 'live') {
            renderStage();
            syncMeshData();
          }

          if (!store.get().selectedThreadId && items.length > 0) {
            const preferredRaw = pickRichestTopThread(items);
            const preferred = extractItemFields(preferredRaw);
            const targetId = preferred.threadId || preferred.id || preferred.eventId;
            if (targetId) {
              await selectThread(targetId, { silent: true });
            }
          }
        } catch (err) {
          if (destroyed || seq !== loadSeq) return;
          store.set({ loadingStream: false });
          renderTelemetryRibbonSlot();
          renderStream();
          showFeedback(err && err.message ? err.message : 'Unable to load stream', 'error');
        }
      }

      async function selectThread(threadId, opts) {
        return fetchThreadDetail(threadId, opts);
      }

      async function fetchThreadDetail(threadId, opts) {
        if (!threadId) return;
        const tid = String(threadId);
        store.set({ selectedThreadId: tid, loadingThread: true });
        if (!opts || !opts.silent) renderStage();

        try {
          const data = await apiFetchJson(`/api/agent-board/threads/${encodeURIComponent(tid)}`);
          if (destroyed) return;
          if (store.get().selectedThreadId !== tid) return;
          store.set({
            threadDetail: {
              root: data.root || null,
              replies: safeArray(data.replies),
              runs: safeArray(data.runs),
              pause: data.pause || null,
            },
            loadingThread: false,
          });
          renderStage();
          renderStream();
          if (store.get().stage === 'context') {
            const ch = (data.root && data.root.channel) || resolveActiveThreadChannel();
            fetchThreadContext(tid, ch);
          }
        } catch (err) {
          if (destroyed) return;
          store.set({ loadingThread: false });
          renderStage();
          if (!opts || !opts.silent) {
            showFeedback(err && err.message ? err.message : `Failed to load thread #${tid}`, 'error');
          }
        }
      }

      async function fetchThreadContext(threadId, channel) {
        const tid = String(threadId || store.get().selectedThreadId || '').trim();
        const ch = resolvePostChannel(channel || resolveActiveThreadChannel());
        if (!tid && !ch) return;
        const key = `${tid}:${ch}`;
        const seq = ++contextSeq;

        const prevMap = store.get().contextByKey || Object.create(null);
        const existing = prevMap[key] || { data: null, loading: false, error: '' };
        const nextMap = Object.assign(Object.create(null), prevMap, {
          [key]: Object.assign({}, existing, { loading: true, error: '' }),
        });
        store.set({ contextByKey: nextMap });
        if (store.get().stage === 'context') renderStage();

        try {
          const ctxMod = getBoardContextStage();
          let res;
          if (ctxMod && typeof ctxMod.fetchContext === 'function') {
            res = await ctxMod.fetchContext({ threadId: tid, channel: ch });
          } else {
            const qs = new URLSearchParams();
            if (tid) qs.set('threadId', tid);
            if (ch) qs.set('channel', ch);
            const data = await apiFetchJson(`/api/agent-board/context?${qs.toString()}`);
            res = { ok: true, data };
          }
          if (destroyed || seq !== contextSeq) return;
          const curMap = store.get().contextByKey || Object.create(null);
          const updated = Object.assign(Object.create(null), curMap, {
            [key]: res && res.ok
              ? { loading: false, data: res.data || {}, error: '' }
              : { loading: false, data: existing.data, error: (res && res.error) || 'Context lookup failed' },
          });
          store.set({ contextByKey: updated });
          if (store.get().stage === 'context') renderStage();
        } catch (err) {
          if (destroyed || seq !== contextSeq) return;
          const curMap = store.get().contextByKey || Object.create(null);
          const updated = Object.assign(Object.create(null), curMap, {
            [key]: { loading: false, data: existing.data, error: (err && err.message) || 'Context lookup failed' },
          });
          store.set({ contextByKey: updated });
          if (store.get().stage === 'context') renderStage();
        }
      }

      function collectThreadKeys(explicitId, threadObj) {
        const keys = new Set();
        function addKey(val) {
          if (val == null) return;
          const s = String(val).trim();
          if (s) keys.add(s);
        }
        const st = store.get();
        const exp = explicitId != null ? String(explicitId).trim() : '';
        addKey(exp);

        const src = threadObj || (st.threadDetail && st.threadDetail.root) || null;
        if (src && typeof src === 'object') {
          const rootObj = src.root && typeof src.root === 'object' ? src.root : src;
          const extracted = extractItemFields(rootObj);
          const candidateKeys = [
            extracted.threadId,
            extracted.id,
            extracted.eventId,
            rootObj.id,
            rootObj.numericId,
            rootObj.threadId,
            rootObj.eventId,
          ]
            .filter((v) => v != null && String(v).trim() !== '')
            .map((v) => String(v).trim());

          const matchesActive =
            !exp ||
            exp === st.selectedThreadId ||
            candidateKeys.indexOf(exp) !== -1;

          if (matchesActive) {
            addKey(st.selectedThreadId);
            for (let i = 0; i < candidateKeys.length; i += 1) {
              addKey(candidateKeys[i]);
            }
          }
        } else if (!exp || exp === st.selectedThreadId) {
          addKey(st.selectedThreadId);
        }

        return Array.from(keys);
      }

      function getBriefEntryForThread(explicitId, threadObj) {
        const map = store.get().briefByThread || Object.create(null);
        const keys = collectThreadKeys(explicitId, threadObj);
        for (let i = 0; i < keys.length; i += 1) {
          if (map[keys[i]]) return map[keys[i]];
        }
        return null;
      }

      function setBriefEntryForThread(explicitId, threadObj, patchOrUpdater) {
        const cur = store.get().briefByThread || Object.create(null);
        const keys = collectThreadKeys(explicitId, threadObj);
        if (!keys.length) return;
        let existing = null;
        for (let i = 0; i < keys.length; i += 1) {
          if (cur[keys[i]]) {
            existing = cur[keys[i]];
            break;
          }
        }
        const nextEntry =
          typeof patchOrUpdater === 'function'
            ? patchOrUpdater(existing || {})
            : Object.assign({}, existing || {}, patchOrUpdater);
        const nextMap = Object.assign(Object.create(null), cur);
        for (let i = 0; i < keys.length; i += 1) {
          nextMap[keys[i]] = nextEntry;
        }
        store.set({ briefByThread: nextMap });
      }

      async function runLocalLlmBrief(threadId, channel, opts) {
        const tid = String(threadId || store.get().selectedThreadId || '').trim();
        const ch = resolvePostChannel(channel || resolveActiveThreadChannel());
        if (!tid) {
          showFeedback('Select a thread first to run Local LLM Brief.', 'info');
          return null;
        }
        const activeThread = store.get().threadDetail || null;
        setBriefEntryForThread(tid, activeThread, { status: 'loading', loading: true, error: '' });
        renderStage();

        try {
          const ctxMod = getBoardContextStage();
          let res;
          if (ctxMod && typeof ctxMod.synthesizeThread === 'function') {
            res = await ctxMod.synthesizeThread({
              threadId: tid,
              channel: ch,
              force: Boolean(opts && opts.force),
            });
          } else {
            const data = await apiFetchJson('/api/agent-board/synthesize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ threadId: tid, channel: ch, force: Boolean(opts && opts.force) }),
            });
            res = { ok: true, data };
          }
          if (destroyed) return null;
          if (res && res.ok) {
            playSound('advance');
            setBriefEntryForThread(tid, store.get().threadDetail || activeThread, {
              status: 'ready',
              loading: false,
              error: '',
              result: res.data || {},
            });
            renderStage();
            return res.data;
          }
          const errMsg = (res && res.error) || 'Local LLM synthesis failed';
          setBriefEntryForThread(tid, store.get().threadDetail || activeThread, {
            status: 'error',
            loading: false,
            error: errMsg,
          });
          renderStage();
          showFeedback(errMsg, 'error');
          return null;
        } catch (err) {
          if (destroyed) return null;
          const errMsg = (err && err.message) || 'Local LLM synthesis failed';
          setBriefEntryForThread(tid, store.get().threadDetail || activeThread, {
            status: 'error',
            loading: false,
            error: errMsg,
          });
          renderStage();
          showFeedback(errMsg, 'error');
          return null;
        }
      }

      async function promoteThreadToCodex(params) {
        const p = params && typeof params === 'object' ? params : {};
        const tid = String(p.threadId || store.get().selectedThreadId || '').trim();
        const ch = resolvePostChannel(p.channel || resolveActiveThreadChannel());
        const section = String(p.section || 'actions').trim().toLowerCase();
        if (!tid) {
          showFeedback('Select a thread first to promote to Codex.', 'info');
          return { ok: false, error: 'No thread selected' };
        }
        try {
          const ctxMod = getBoardContextStage();
          let res;
          if (ctxMod && typeof ctxMod.promoteToCodex === 'function') {
            res = await ctxMod.promoteToCodex({
              threadId: tid,
              channel: ch,
              section,
              title: p.title,
              summary: p.summary,
              directive: p.directive,
            });
          } else {
            const data = await apiFetchJson('/api/agent-board/promote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                threadId: tid,
                channel: ch,
                section,
                title: p.title,
                summary: p.summary,
                directive: p.directive,
              }),
            });
            res = { ok: true, data: Object.assign({ section }, data) };
          }
          if (destroyed) return res;
          if (res && res.ok) {
            const codexItem =
              res.data && res.data.codexItem && typeof res.data.codexItem === 'object'
                ? res.data.codexItem
                : null;
            setBriefEntryForThread(tid, store.get().threadDetail || null, {
              promoteSection: (codexItem && codexItem.section) || section,
              promoteReceipt: Object.assign(
                { section, title: p.title || `Thread #${tid}` },
                res.data || {}
              ),
              promoteError: '',
            });
          } else {
            setBriefEntryForThread(tid, store.get().threadDetail || null, {
              promoteError: (res && res.error) || 'Failed to promote to Codex',
            });
          }
          return res;
        } catch (err) {
          return { ok: false, error: (err && err.message) || 'Failed to promote to Codex' };
        }
      }

      /* --------------------------------------------------------------------
         REAL-TIME SSE STREAM (/api/agent-board/stream)
         Handles: open, hello, board, action, telemetry, message, offline, error
         Coalesces SSE DOM flushes into one requestAnimationFrame per burst and
         dispatches kizuki:board-sse CustomEvents for cross-module listeners.
         -------------------------------------------------------------------- */

      const MAX_EVENT_TAPE_ROWS = 60;
      let sseRafId = null;
      let sseRafUsesTimeout = false;
      const pendingSseFlush = {
        stageHeader: false,
        stage: false,
        liveTape: false,
        stream: false,
        mesh: false,
      };

      function fastDomSig(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i += 1) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
      }

      function cancelSseDomFlush() {
        if (sseRafId !== null) {
          if (sseRafUsesTimeout) {
            clearTimeout(sseRafId);
          } else if (win && typeof win.cancelAnimationFrame === 'function') {
            win.cancelAnimationFrame(sseRafId);
          } else if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(sseRafId);
          }
          sseRafId = null;
          sseRafUsesTimeout = false;
        }
        pendingSseFlush.stageHeader = false;
        pendingSseFlush.stage = false;
        pendingSseFlush.liveTape = false;
        pendingSseFlush.stream = false;
        pendingSseFlush.mesh = false;
      }

      function flushSseDom() {
        sseRafId = null;
        sseRafUsesTimeout = false;
        if (destroyed) return;
        const doStageHeader = pendingSseFlush.stageHeader;
        const doStage = pendingSseFlush.stage;
        const doLiveTape = pendingSseFlush.liveTape;
        const doStream = pendingSseFlush.stream;
        const doMesh = pendingSseFlush.mesh;

        pendingSseFlush.stageHeader = false;
        pendingSseFlush.stage = false;
        pendingSseFlush.liveTape = false;
        pendingSseFlush.stream = false;
        pendingSseFlush.mesh = false;

        if (doStream) {
          renderStream();
        }
        if (doStage) {
          renderStage();
        } else {
          if (doStageHeader) {
            renderStageHeader();
          }
          if (doLiveTape && store.get().stage === 'live') {
            patchLiveStageIncremental();
          }
        }
        if (doMesh && store.get().stage === 'live') {
          syncMeshData();
        }
      }

      function scheduleSseDomFlush(flags) {
        if (destroyed) return;
        if (flags && flags.stageHeader) pendingSseFlush.stageHeader = true;
        if (flags && flags.stage) pendingSseFlush.stage = true;
        if (flags && flags.liveTape) pendingSseFlush.liveTape = true;
        if (flags && flags.stream) pendingSseFlush.stream = true;
        if (flags && flags.mesh) pendingSseFlush.mesh = true;
        if (sseRafId !== null) return;

        const raf =
          (win && typeof win.requestAnimationFrame === 'function' && win.requestAnimationFrame.bind(win)) ||
          (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
        if (raf) {
          sseRafUsesTimeout = false;
          sseRafId = raf(flushSseDom);
        } else {
          sseRafUsesTimeout = true;
          sseRafId = setTimeout(flushSseDom, 16);
        }
      }

      function emitBoardSseEvent(kind, parsed, entry) {
        const target = win || (typeof window !== 'undefined' ? window : null);
        if (!target || typeof target.dispatchEvent !== 'function') return;
        const EventCtor =
          (target && target.CustomEvent) ||
          (typeof CustomEvent === 'function' ? CustomEvent : null);
        if (!EventCtor) return;
        try {
          target.dispatchEvent(
            new EventCtor('kizuki:board-sse', {
              detail: {
                kind: String(kind || 'event'),
                data: parsed || {},
                entry: entry || null,
                at: Date.now(),
              },
            }),
          );
        } catch {
          // Never allow external listener errors to disrupt board SSE stream
        }
      }

      function parseSseData(rawData) {
        if (!rawData) return {};
        if (typeof rawData === 'object') return rawData;
        try {
          return JSON.parse(String(rawData));
        } catch {
          return { text: String(rawData) };
        }
      }

      function applyLiveTelemetryPayload(parsed) {
        if (!parsed || typeof parsed !== 'object') return;
        const st = store.get();
        const patch = {};
        const hostObj =
          (parsed.host && typeof parsed.host === 'object' && parsed.host) ||
          (parsed.hostname || parsed.load1 != null || parsed.mem_available_gib != null || parsed.cpus != null
            ? parsed
            : null);
        if (hostObj) {
          const mergedHost = Object.assign({}, st.sseHost || {}, hostObj);
          patch.sseHost = mergedHost;
          patch.hostHistory = pushHostHistorySample(mergedHost, st.hostHistory);
        }
        if (Array.isArray(parsed.seats) && parsed.seats.length) {
          patch.seats = parsed.seats;
        }
        if (typeof parsed.synthReady === 'boolean') {
          patch.synthReady = parsed.synthReady;
        }
        if (Object.keys(patch).length) {
          store.set(patch);
          if (store.get().stage === 'live') {
            scheduleSseDomFlush({ liveTape: true, mesh: true });
          }
        }
      }

      function scheduleSseRefresh() {
        if (sseRefreshDebounce) clearTimeout(sseRefreshDebounce);
        sseRefreshDebounce = setTimeout(() => {
          if (destroyed) return;
          sseRefreshDebounce = null;
          const st = store.get();
          fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
          if (st.selectedThreadId) {
            fetchThreadDetail(st.selectedThreadId, { silent: true });
          }
          fetchBlockers();
        }, 650);
      }

      function pushSseLog(kind, rawData) {
        const parsed = parseSseData(rawData);
        const rawTid =
          parsed &&
          (parsed.threadId || parsed.thread_id || parsed.re || parsed.numericId || parsed.id || '');
        const hostSummary =
          parsed && parsed.host && typeof parsed.host === 'object'
            ? `Host load ${Number(parsed.host.load1 || 0).toFixed(2)} · ${Number(parsed.host.mem_available_gib || 0).toFixed(1)} GiB free${parsed.active_runs != null ? ` · ${parsed.active_runs} runs` : ''}`
            : '';
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: stripEmDash(kind || 'event'),
          at: new Date().toISOString(),
          threadId: rawTid ? String(rawTid).trim() : '',
          channel: stripEmDash((parsed && (parsed.channel || parsed.room)) || ''),
          actor: stripEmDash((parsed && (parsed.byActor || parsed.author || parsed.actor || parsed.agent || parsed.by)) || ''),
          summary: stripEmDash(
            hostSummary ||
              (parsed && (parsed.summary || parsed.text || parsed.action || parsed.status || parsed.type)) ||
              (typeof rawData === 'string' && !rawData.trim().startsWith('{') ? rawData.slice(0, 140) : 'live update')
          ),
          isFresh: true,
        };
        const st = store.get();
        const next = [entry].concat(st.sseEvents).slice(0, MAX_EVENT_TAPE_ROWS);
        const pairTraffic = computePairTraffic(Object.assign({}, st, { sseEvents: next }));
        store.set({ sseEvents: next, pairTraffic });
        emitBoardSseEvent(kind, parsed, entry);
        if (store.get().stage === 'live') {
          scheduleSseDomFlush({ liveTape: true, mesh: true });
        }
        return { parsed, entry };
      }

      function disconnectSse() {
        cancelSseDomFlush();
        if (sseReconnectTimer) {
          clearTimeout(sseReconnectTimer);
          sseReconnectTimer = null;
        }
        if (sseRefreshDebounce) {
          clearTimeout(sseRefreshDebounce);
          sseRefreshDebounce = null;
        }
        if (eventSource) {
          try {
            eventSource.close();
          } catch {
            // ignore
          }
          eventSource = null;
        }
      }

      function connectSse() {
        if (destroyed || eventSource) return;
        const EventSourceCtor =
          (win && typeof win.EventSource === 'function' && win.EventSource) ||
          (typeof EventSource === 'function' ? EventSource : null);
        if (!EventSourceCtor) {
          store.set({ sseStatus: 'offline' });
          renderStageHeader();
          return;
        }

        store.set({ sseStatus: sseRetryCount > 0 ? 'reconnecting' : 'connecting' });
        renderStageHeader();

        try {
          const es = new EventSourceCtor('/api/agent-board/stream');
          eventSource = es;

          es.addEventListener('open', () => {
            if (destroyed) return;
            sseRetryCount = 0;
            store.set({ sseStatus: 'connected' });
            scheduleSseDomFlush({ stageHeader: true, liveTape: store.get().stage === 'live' });
          });

          es.addEventListener('hello', (evt) => {
            if (destroyed) return;
            sseRetryCount = 0;
            const parsed = parseSseData(evt && evt.data);
            store.set({ sseStatus: 'connected' });
            applyLiveTelemetryPayload(parsed);
            pushSseLog('hello', parsed);
            scheduleSseDomFlush({ stageHeader: true });
          });

          es.addEventListener('board', (evt) => {
            if (destroyed) return;
            const { parsed } = pushSseLog('board', evt && evt.data);
            pendingSseBoardArrival = true;
            const incomingIds = [];
            if (parsed && typeof parsed === 'object') {
              if (parsed.id != null) incomingIds.push(String(parsed.id));
              if (parsed.threadId != null) incomingIds.push(String(parsed.threadId));
              if (parsed.re != null) incomingIds.push(String(parsed.re));
              if (parsed.numericId != null) incomingIds.push(String(parsed.numericId));
              if (incomingIds.length) markJustArrived(incomingIds);

              // Optimistically insert new live card with eb-just-arrived sweep if payload carries body text
              const hasBody = Boolean(parsed.text || parsed.body || parsed.message);
              const st = store.get();
              const incomingCh = String(parsed.channel || parsed.room || '').replace(/^#+/, '').trim();
              const matchesRoom =
                st.mode === 'feed' ||
                st.channel === 'mission' ||
                !incomingCh ||
                incomingCh === st.channel;
              if (hasBody && matchesRoom && !isTelemetryItem(parsed)) {
                const candidate = extractItemFields(parsed);
                const key = candidate.threadId || candidate.id;
                const exists =
                  key &&
                  st.streamItems.some((it) => {
                    const ef = extractItemFields(it);
                    return ef.threadId === key || ef.id === key;
                  });
                if (!exists) {
                  const nextItems = [parsed].concat(st.streamItems);
                  store.set({ streamItems: nextItems });
                  if (key) knownStreamIds.add(key);
                  scheduleSseDomFlush({ stream: true });
                }
              }
            }
            triggerMeshPulse({
              channel: (parsed && (parsed.channel || parsed.room)) || '',
              actor: (parsed && (parsed.byActor || parsed.author || parsed.actor || parsed.by)) || '',
              type: 'board',
            });
            scheduleSseRefresh();
          });

          es.addEventListener('action', (evt) => {
            if (destroyed) return;
            const { parsed } = pushSseLog('action', evt && evt.data);
            triggerMeshPulse({
              channel: (parsed && (parsed.channel || parsed.room)) || '',
              actor: (parsed && (parsed.byActor || parsed.author || parsed.actor || parsed.agent)) || '',
              type: 'action',
            });
            scheduleSseRefresh();
            fetchAgents();
          });

          es.addEventListener('telemetry', (evt) => {
            if (destroyed) return;
            const { parsed } = pushSseLog('telemetry', evt && evt.data);
            applyLiveTelemetryPayload(parsed);
            triggerMeshPulse({
              channel: (parsed && (parsed.channel || parsed.room)) || '',
              actor: (parsed && (parsed.actor || parsed.agent)) || '',
              type: 'telemetry',
            });
            fetchHealth();
            fetchAgents();
          });

          es.addEventListener('offline', (evt) => {
            if (destroyed) return;
            store.set({ sseStatus: 'offline' });
            pushSseLog('offline', (evt && evt.data) || { status: 'cockpit stream offline' });
            scheduleSseDomFlush({ stageHeader: true, liveTape: store.get().stage === 'live' });
          });

          es.addEventListener('message', (evt) => {
            if (destroyed) return;
            const { parsed } = pushSseLog('message', evt && evt.data);
            triggerMeshPulse({
              channel: (parsed && (parsed.channel || parsed.room)) || '',
              actor: (parsed && (parsed.byActor || parsed.author || parsed.actor)) || '',
              type: 'message',
            });
            scheduleSseRefresh();
          });

          es.addEventListener('error', () => {
            if (destroyed) return;
            disconnectSse();
            sseRetryCount += 1;
            const backoffMs = Math.min(15000, 1200 * Math.pow(1.6, Math.min(sseRetryCount, 6)));
            store.set({ sseStatus: 'reconnecting' });
            renderStageHeader();
            sseReconnectTimer = setTimeout(() => {
              if (destroyed || (doc && doc.hidden)) return;
              connectSse();
            }, backoffMs);
          });
        } catch {
          store.set({ sseStatus: 'offline' });
          renderStageHeader();
        }
      }

      if (doc) {
        const onVis = () => {
          if (destroyed) return;
          if (doc.hidden) disconnectSse();
          else connectSse();
        };
        doc.addEventListener('visibilitychange', onVis);
        cleanups.push(() => doc.removeEventListener('visibilitychange', onVis));
      }

      /* --------------------------------------------------------------------
         INTERACTIONS
         -------------------------------------------------------------------- */

      function setSignalFilter(nextFilter) {
        const valid = nextFilter === 'all' || nextFilter === 'telemetry' ? nextFilter : 'signal';
        const st = store.get();
        if (st.signalFilter === valid) return;
        playSound('click');
        store.set({ signalFilter: valid });
        renderTelemetryRibbonSlot();
        fetchStream({ mode: st.mode, channel: st.channel, signalFilter: valid });
      }

      function toggleSignalFilter() {
        const cur = store.get().signalFilter;
        setSignalFilter(cur === 'signal' ? 'all' : 'signal');
      }

      function selectRoom(roomPath) {
        const clean = String(roomPath || 'mission').replace(/^#+/, '').trim() || 'mission';
        playSound('click');
        roomPopup.close({ reason: 'select', restoreFocus: false });
        replyDismissable.deactivate();
        store.set({
          channel: clean,
          mode: clean === 'box/taste' ? 'taste' : 'rooms',
          mobileStageOpen: false,
          selectedThreadId: null,
          threadDetail: null,
          replyTargetId: null,
          replyTargetPaused: false,
          resumePaused: false,
          roomQuery: '',
        });
        if (refs.roomSearchInput) refs.roomSearchInput.value = '';
        renderShellAttrs();
        renderDock();
        renderHeader();
        renderTelemetryRibbonSlot();
        renderComposerTarget();
        fetchStream({
          mode: clean === 'box/taste' ? 'taste' : 'rooms',
          channel: clean,
          signalFilter: store.get().signalFilter,
        });
      }

      function cycleRoom(delta) {
        const st = store.get();
        const ordered = ['mission'];
        const seen = new Set(['mission']);
        const missionRooms = st.missionData && Array.isArray(st.missionData.activeRooms)
          ? st.missionData.activeRooms
          : [];
        for (let i = 0; i < missionRooms.length; i += 1) {
          const ch = String(missionRooms[i] && missionRooms[i].channel || '').trim();
          if (ch && !seen.has(ch)) {
            seen.add(ch);
            ordered.push(ch);
          }
        }
        for (let i = 0; i < st.rooms.length && ordered.length < 24; i += 1) {
          const ch = st.rooms[i].channel;
          if (ch && !seen.has(ch)) {
            seen.add(ch);
            ordered.push(ch);
          }
        }
        if (ordered.length <= 1) return;
        const curIdx = Math.max(0, ordered.indexOf(st.channel));
        const nextIdx = (curIdx + delta + ordered.length) % ordered.length;
        selectRoom(ordered[nextIdx]);
      }

      function setMode(mode) {
        playSound('click');
        const patch = { mode, mobileStageOpen: false };
        if (mode === 'taste') {
          patch.channel = 'box/taste';
          patch.replyTargetId = null;
          patch.replyTargetPaused = false;
          patch.resumePaused = false;
          replyDismissable.deactivate();
        }
        store.set(patch);
        renderShellAttrs();
        renderDock();
        renderHeader();
        renderTelemetryRibbonSlot();
        renderComposerTarget();
        fetchStream({
          mode,
          channel: patch.channel || store.get().channel,
          signalFilter: store.get().signalFilter,
        });
      }

      function setStage(stage, opts) {
        const valid =
          stage === 'canvas' || stage === 'context' || stage === 'live' ? stage : 'thread';
        playSound('click');
        const openMobile = opts && opts.mobileOpen !== undefined ? Boolean(opts.mobileOpen) : true;
        if (valid !== 'live') {
          unmountMesh();
          if (meshExpanded) {
            meshExpanded = false;
            store.set({ spatialExpanded: false });
          }
        } else if (!(opts && opts.preserveSpatialExpanded)) {
          store.set({ spatialExpanded: meshExpanded });
        }
        store.set({ stage: valid, mobileStageOpen: openMobile });
        renderShellAttrs();
        renderDock();
        renderStageHeader();
        renderStage();
        if (valid === 'canvas') {
          fetchBlockers();
          fetchDecisions();
        } else if (valid === 'context') {
          const st = store.get();
          fetchThreadContext(st.selectedThreadId, resolveActiveThreadChannel());
        } else if (valid === 'live') {
          fetchHealth();
          fetchAgents();
          fetchBlockers();
          fetchDecisions();
          if (!store.get().missionData) fetchMissionSnapshot();
          connectSse();
        }
      }

      function setMobilePane(pane) {
        playSound('click');
        if (pane === 'stream') {
          store.set({ mobileStageOpen: false });
          renderShellAttrs();
          renderHeader();
          return;
        }
        const stage =
          pane === 'canvas' || pane === 'context' || pane === 'live' ? pane : 'thread';
        setStage(stage, { mobileOpen: true });
      }

      function openThreadInspector(threadId, opts) {
        if (!threadId) return;
        playSound('click');
        const tid = String(threadId);
        const curStage = store.get().stage;
        const targetStage = opts && opts.preserveStage && (curStage === 'context' || curStage === 'thread')
          ? curStage
          : 'thread';
        if (targetStage !== 'live') unmountMesh();
        const patch = { selectedThreadId: tid, stage: targetStage };
        if (opts && opts.switchMobile) patch.mobileStageOpen = true;
        store.set(patch);
        renderShellAttrs();
        renderStageHeader();
        fetchThreadDetail(tid);
      }

      function navigateStreamThread(delta) {
        const st = store.get();
        const items = safeArray(st.streamItems);
        if (!items.length) return null;
        let curIdx = items.findIndex((it) => extractItemFields(it).threadId === st.selectedThreadId);
        if (curIdx < 0) curIdx = delta > 0 ? -1 : 0;
        const nextIdx = (curIdx + delta + items.length) % items.length;
        const f = extractItemFields(items[nextIdx]);
        const tid = f.threadId || f.id;
        if (!tid) return null;
        openThreadInspector(tid, { preserveStage: true });
        if (refs.feedScroll && typeof refs.feedScroll.querySelector === 'function') {
          return refs.feedScroll.querySelector(`.eb-thread-card[data-thread-id="${tid.replace(/"/g, '')}"]`);
        }
        return null;
      }

      function focusComposerForReply(threadId, opts) {
        const tid = threadId ? String(threadId) : null;
        const isPaused = Boolean(opts && opts.paused);
        const shouldResume = Boolean(opts && opts.resumePaused);
        store.set({
          replyTargetId: tid,
          replyTargetPaused: isPaused,
          resumePaused: shouldResume,
          mobileStageOpen: false,
        });
        if (tid) replyDismissable.activate();
        else replyDismissable.deactivate();
        renderShellAttrs();
        renderComposerTarget();
        if (opts && opts.prefill && refs.composerInput && (opts.forcePrefill || !refs.composerInput.value.trim())) {
          refs.composerInput.value = stripEmDash(opts.prefill);
          store.set({ composerDraft: refs.composerInput.value });
          syncComposerHeight();
        }
        if (refs.composerInput && typeof refs.composerInput.focus === 'function') {
          try {
            refs.composerInput.focus();
          } catch {
            // ignore
          }
        }
      }

      function startNewThreadInRoom() {
        playSound('click');
        replyDismissable.deactivate();
        store.set({
          replyTargetId: null,
          replyTargetPaused: false,
          resumePaused: false,
          mobileStageOpen: false,
        });
        renderShellAttrs();
        renderComposerTarget();
        if (refs.composerInput && typeof refs.composerInput.focus === 'function') {
          try {
            refs.composerInput.focus();
          } catch {
            // ignore
          }
        }
      }

      function toggleAgentFilter(handle, prefillMention) {
        const clean = String(handle || '').replace(/^@+/, '').trim();
        if (!clean) return;
        playSound('click');
        if (prefillMention) {
          insertMentionHandle(clean);
          return;
        }
        const st = store.get();
        const nextFilter = st.agentFilter === clean ? '' : clean;
        store.set({ agentFilter: nextFilter, mobileStageOpen: false });
        renderShellAttrs();
        renderDock();
        renderHeader();
        if (st.stage === 'live') syncMeshData();
        fetchStream({
          mode: st.mode,
          channel: st.channel,
          agentFilter: nextFilter,
          signalFilter: st.signalFilter,
        });
      }

      function insertMentionHandle(handle) {
        const clean = String(handle || '').replace(/^@+/, '').trim();
        if (!clean || !refs.composerInput) return;
        const el = refs.composerInput;
        const val = String(el.value || '');
        const st = store.get();
        const range = st.mentionRange;
        const token = `@${clean} `;
        let nextVal = val;
        let caretPos = val.length + token.length;

        if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
          nextVal = val.slice(0, range.start) + token + val.slice(range.end);
          caretPos = range.start + token.length;
        } else {
          const pos = Number.isFinite(el.selectionStart) ? el.selectionStart : val.length;
          const needsSpace = pos > 0 && !/\s$/.test(val.slice(0, pos));
          const insertStr = (needsSpace ? ' ' : '') + token;
          nextVal = val.slice(0, pos) + insertStr + val.slice(pos);
          caretPos = pos + insertStr.length;
        }

        el.value = nextVal;
        store.set({ composerDraft: nextVal, mentionQuery: '', mentionRange: null, mobileStageOpen: false });
        mentionPopup.close({ reason: 'select', restoreFocus: false });
        renderShellAttrs();
        try {
          el.focus();
          if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(caretPos, caretPos);
          }
        } catch {
          // ignore
        }
        syncComposerHeight();
      }

      function inspectMentionTriggerFromInput() {
        const el = refs.composerInput;
        if (!el) return;
        if (composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen()) {
          if (mentionPopup.isOpen()) {
            store.set({ mentionQuery: '', mentionRange: null });
            mentionPopup.close({ reason: 'sdk-active', restoreFocus: false });
          }
          return;
        }
        const val = String(el.value || '');
        const pos = Number.isFinite(el.selectionStart) ? el.selectionStart : val.length;
        const before = val.slice(0, pos);
        const match = /(^|[\s(])@([a-zA-Z0-9_-]{0,30})$/.exec(before);
        if (match) {
          const atStart = pos - match[2].length - 1;
          store.set({
            mentionQuery: match[2],
            mentionRange: { start: atStart, end: pos },
          });
          if (!mentionPopup.isOpen()) {
            mentionPopup.open();
          } else {
            renderMentionPopover();
            mentionSelection.setActiveIndex(0, { scroll: false });
          }
        } else if (mentionPopup.isOpen()) {
          store.set({ mentionQuery: '', mentionRange: null });
          mentionPopup.close({ reason: 'blur-trigger', restoreFocus: false });
        }
      }

      function syncComposerHeight() {
        const el = refs.composerInput;
        if (!el || !el.style) return;
        el.style.height = 'auto';
        const sh = Number(el.scrollHeight || 0);
        if (sh > 0) {
          el.style.height = `${Math.min(136, Math.max(36, sh))}px`;
        }
      }

      function withComposerProvenance(bodyText) {
        if (composerSdk && typeof composerSdk.composeMessageWithProvenance === 'function') {
          return composerSdk.composeMessageWithProvenance(bodyText);
        }
        return stripEmDash(bodyText || '').trim();
      }

      function clearComposerAttachments() {
        if (composerSdk && typeof composerSdk.clearAttachments === 'function') {
          composerSdk.clearAttachments();
        }
      }

      /* --------------------------------------------------------------------
         SLASH COMMAND EXECUTION (/decide, /task, /unblock, /brief, /promote, /taste, /signal, /mesh)
         -------------------------------------------------------------------- */

      async function handleSlashCommand(payload) {
        if (!payload || !payload.command) return;
        const st = store.get();
        const cmd = payload.command;

        if (cmd === 'signal') {
          toggleSignalFilter();
          showFeedback(`Stream filter: ${store.get().signalFilter}`, 'info');
          return;
        }

        if (cmd === 'mesh') {
          setStage('live', { mobileOpen: true });
          return;
        }

        if (cmd === 'brief') {
          if (st.stage !== 'thread' && st.stage !== 'context') {
            setStage('thread', { mobileOpen: true });
          }
          await runLocalLlmBrief(st.selectedThreadId, resolveActiveThreadChannel(), { force: true });
          return;
        }

        if (cmd === 'promote') {
          const res = await promoteThreadToCodex({
            threadId: st.selectedThreadId,
            channel: resolveActiveThreadChannel(),
            section: payload.section || 'ideas',
          });
          if (res && res.ok) {
            playSound('advance');
            showFeedback(`Promoted #${st.selectedThreadId} to Codex (${payload.section || 'ideas'})`, 'ok');
            renderStage();
          } else {
            showFeedback((res && res.error) || 'Failed to promote thread', 'error');
          }
          return;
        }

        if (cmd === 'unblock') {
          const targetTid = st.replyTargetId || st.selectedThreadId;
          if (!targetTid) {
            showFeedback('Select a paused or blocked thread first before using /unblock.', 'error');
            return;
          }
          const finalBody = withComposerProvenance(payload.note || 'Resuming paused task.');
          try {
            const res = await apiFetchJson('/api/agent-board/reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                threadId: String(targetTid),
                text: finalBody,
                resumePaused: true,
              }),
            });
            if (destroyed) return;
            clearComposerAttachments();
            playSound('advance');
            showFeedback(`Unblocked #${targetTid}${res && res.id ? ` (msg #${res.id})` : ''}`, 'ok');
            fetchThreadDetail(targetTid, { silent: true });
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            fetchBlockers();
          } catch (err) {
            showFeedback((err && err.message) || 'Failed to unblock thread', 'error');
          }
          return;
        }

        if (cmd === 'decide') {
          const targetChannel =
            !st.channel || st.channel === 'mission' || st.channel === 'box'
              ? 'kizuki/decisions'
              : resolvePostChannel(st.channel);
          const bodyText = withComposerProvenance(payload.formattedBody || payload.question);
          if (!bodyText) return;
          try {
            const res = await apiFetchJson('/api/agent-board/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel: targetChannel,
                text: bodyText,
                idempotencyKey: makeIdempotencyKey(),
              }),
            });
            if (destroyed) return;
            clearComposerAttachments();
            playSound('advance');
            showFeedback(`Decision card posted to #${targetChannel}${res && res.id ? ` (#${res.id})` : ''}`, 'ok');
            fetchDecisions();
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            if (res && res.id) fetchThreadDetail(String(res.id), { silent: true });
          } catch (err) {
            showFeedback((err && err.message) || 'Failed to post decision card', 'error');
          }
          return;
        }

        if (cmd === 'task') {
          const targetChannel = st.channel === 'mission' ? 'box/work' : resolvePostChannel(st.channel);
          const bodyText = withComposerProvenance(payload.formattedBody || payload.goal);
          if (!bodyText) return;
          try {
            const res = await apiFetchJson('/api/agent-board/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel: targetChannel,
                text: bodyText,
                idempotencyKey: makeIdempotencyKey(),
              }),
            });
            if (destroyed) return;
            clearComposerAttachments();
            playSound('advance');
            showFeedback(`Task dispatched to #${targetChannel}${res && res.id ? ` (#${res.id})` : ''}`, 'ok');
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            if (res && res.id) fetchThreadDetail(String(res.id), { silent: true });
          } catch (err) {
            showFeedback((err && err.message) || 'Failed to dispatch task', 'error');
          }
          return;
        }

        if (cmd === 'taste') {
          const ruleText = payload.rule ? `taste: ${payload.rule}` : '';
          const bodyText = withComposerProvenance(ruleText);
          if (!bodyText) return;
          try {
            const res = await apiFetchJson('/api/agent-board/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel: 'box/taste',
                text: bodyText,
                idempotencyKey: makeIdempotencyKey(),
              }),
            });
            if (destroyed) return;
            clearComposerAttachments();
            playSound('advance');
            showFeedback(`Taste rule posted to #box/taste${res && res.id ? ` (#${res.id})` : ''}`, 'ok');
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
          } catch (err) {
            showFeedback((err && err.message) || 'Failed to post taste rule', 'error');
          }
        }
      }

      async function submitComposer() {
        const st = store.get();
        if (st.sending) return;
        const rawText = stripEmDash((refs.composerInput && refs.composerInput.value) || '').trim();
        if (!rawText) return;

        // Intercept slash commands submitted via Send button
        if (rawText.charAt(0) === '/' && composerSdk && typeof composerSdk.parseSlashCommand === 'function') {
          const parsed = composerSdk.parseSlashCommand(rawText);
          if (parsed) {
            if (parsed.definition && parsed.definition.requiresArgs && !parsed.args) {
              showFeedback(`Usage: ${parsed.definition.usage}`, 'info');
              return;
            }
            if (refs.composerInput) refs.composerInput.value = '';
            store.set({ composerDraft: '' });
            syncComposerHeight();
            await handleSlashCommand(parsed);
            return;
          }
        }

        const text = withComposerProvenance(rawText);
        if (!text) return;

        store.set({ sending: true });
        renderComposerTarget();

        try {
          if (st.replyTargetId) {
            const payload = {
              threadId: String(st.replyTargetId),
              text,
              resumePaused: Boolean(st.resumePaused),
            };
            const res = await apiFetchJson('/api/agent-board/reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (destroyed) return;
            if (refs.composerInput) refs.composerInput.value = '';
            clearComposerAttachments();
            store.set({
              sending: false,
              composerDraft: '',
              resumePaused: false,
            });
            syncComposerHeight();
            playSound('advance');
            showFeedback(
              `Replied to #${st.replyTargetId}${res && res.id ? ` (msg #${res.id})` : ''}`,
              'ok'
            );
            fetchThreadDetail(st.replyTargetId, { silent: true });
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            fetchBlockers();
          } else {
            const channel = resolvePostChannel(st.channel);
            const payload = {
              channel,
              text,
              idempotencyKey: makeIdempotencyKey(),
            };
            const res = await apiFetchJson('/api/agent-board/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (destroyed) return;
            if (refs.composerInput) refs.composerInput.value = '';
            clearComposerAttachments();
            store.set({ sending: false, composerDraft: '' });
            syncComposerHeight();
            playSound('advance');
            const postedChannel = (res && res.channel) || channel;
            showFeedback(
              `Posted to #${postedChannel}${res && res.id ? ` (#${res.id})` : ''}`,
              'ok'
            );
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            if (res && res.id) {
              fetchThreadDetail(String(res.id), { silent: true });
            }
          }
        } catch (err) {
          if (destroyed) return;
          store.set({ sending: false });
          renderComposerTarget();
          const isSecretBlock = err && err.status === 422;
          const msg = isSecretBlock
            ? `Blocked by secret guard (422): ${err.message || 'Sensitive credential detected'}`
            : (err && err.message) || 'Failed to send message';
          showFeedback(msg, 'error');
        }
      }

      /* --------------------------------------------------------------------
         ATTACH WAVE 2 COMPOSER 2.0, KEYBOARD SDK & CONTEXT STAGE EVENTS
         -------------------------------------------------------------------- */

      const composerSdkMod = getBoardComposerSdk();
      if (composerSdkMod && typeof composerSdkMod.attachComposerPlugins === 'function' && getUiSdk()) {
        try {
          composerSdk = composerSdkMod.attachComposerPlugins({
            textareaEl: refs.composerInput,
            slashPopupEl: refs.slashPopupEl,
            contextPopupEl: refs.contextPopupEl,
            attachmentsBarEl: refs.composerAttachmentsEl,
            slashTriggerEl: refs.composerSlashBtn,
            contextTriggerEl: refs.composerContextBtn,
            getRoom: () => resolvePostChannel(store.get().channel),
            getThread: () => {
              const st = store.get();
              if (st.threadDetail && st.threadDetail.root) {
                return Object.assign(
                  { id: st.selectedThreadId, threadId: st.selectedThreadId },
                  st.threadDetail.root
                );
              }
              return st.selectedThreadId ? { id: st.selectedThreadId, threadId: st.selectedThreadId } : null;
            },
            onExecuteSlash: (payload) => {
              handleSlashCommand(payload);
            },
            onToast: (msg, tone) => showFeedback(msg, tone),
          });
          cleanups.push(() => {
            if (composerSdk && typeof composerSdk.destroy === 'function') {
              composerSdk.destroy();
            }
            composerSdk = null;
          });
        } catch {
          composerSdk = null;
        }
      }

      if (composerSdkMod && typeof composerSdkMod.attachBoardKeyboard === 'function') {
        try {
          keyboardSdk = composerSdkMod.attachBoardKeyboard({
            rootEl: containerEl,
            isActive: () => !destroyed && isBoardVisible(),
            hasOpenModal: () =>
              Boolean(
                roomPopup.isOpen() ||
                  mentionPopup.isOpen() ||
                  (composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen())
              ),
            onNextThread: () => navigateStreamThread(1),
            onPrevThread: () => navigateStreamThread(-1),
            onReply: () => {
              const st = store.get();
              if (st.selectedThreadId) {
                const paused = Boolean(st.threadDetail && st.threadDetail.pause);
                focusComposerForReply(st.selectedThreadId, { paused });
              } else {
                startNewThreadInRoom();
              }
            },
            onFocusComposer: () => startNewThreadInRoom(),
            onSwitchStage: (stageName) => setStage(stageName),
            onPrevRoom: () => cycleRoom(-1),
            onNextRoom: () => cycleRoom(1),
            onToggleSignal: () => toggleSignalFilter(),
            onSynthesize: () => {
              const st = store.get();
              if (st.stage !== 'thread' && st.stage !== 'context') {
                setStage('thread', { mobileOpen: true });
              }
              runLocalLlmBrief(st.selectedThreadId, resolveActiveThreadChannel(), { force: true });
            },
            onEscape: () => {
              if (roomPopup.isOpen()) roomPopup.close({ reason: 'escape' });
              if (mentionPopup.isOpen()) mentionPopup.close({ reason: 'escape', restoreFocus: false });
              if (composerSdk && typeof composerSdk.closeAll === 'function') composerSdk.closeAll(false);
            },
          });
          cleanups.push(() => {
            if (keyboardSdk && typeof keyboardSdk.destroy === 'function') {
              keyboardSdk.destroy();
            }
            keyboardSdk = null;
          });
        } catch {
          keyboardSdk = null;
        }
      }

      const ctxStageMod = getBoardContextStage();
      if (ctxStageMod && typeof ctxStageMod.bindEvents === 'function' && refs.stageBody) {
        const detachCtxEvents = ctxStageMod.bindEvents(refs.stageBody, {
          onSynthesize: ({ threadId, channel }) => {
            runLocalLlmBrief(threadId || store.get().selectedThreadId, channel || resolveActiveThreadChannel(), {
              force: true,
            });
          },
          pasteToComposer: (directive, meta) => {
            const tid = (meta && meta.threadId) || store.get().selectedThreadId;
            focusComposerForReply(tid, { prefill: directive, forcePrefill: true });
          },
          onPromote: (params) => promoteThreadToCodex(params),
          onPromoted: () => {
            renderStage();
          },
          onVerdictPosted: (_result, meta) => {
            const st = store.get();
            if (meta && meta.threadId) {
              fetchThreadDetail(meta.threadId, { silent: true });
            }
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            fetchBlockers();
            fetchDecisions();
          },
          openPerson: (key) => jumpToMindView('people', key, { kind: 'person' }),
          openDoc: (docPath) => jumpToMindView('vault', docPath, { kind: 'doc' }),
          openVaultSearch: (query) => jumpToMindView('vault', query, { q: query }),
          openCodex: (opts) =>
            jumpToMindView('codex', (opts && (opts.itemId || opts.section)) || 'actions', opts || {}),
          openTaste: (opts) =>
            jumpToMindView('taste', (opts && opts.domain) || 'all', opts || {}),
          openReplay: (day) => jumpToMindView('replay', day, { day }),
          openCommit: (sha) => jumpToMindView('codex', sha, { kind: 'commit' }),
          switchView: (view, opts) => jumpToMindView(view, (opts && (opts.target || opts.day || opts.domain || opts.q)) || '', opts || {}),
          openThread: ({ threadId }) => {
            if (threadId) openThreadInspector(threadId, { switchMobile: true });
          },
          showToast: (msg, tone) => showFeedback(msg, tone),
        });
        if (typeof detachCtxEvents === 'function') {
          cleanups.push(detachCtxEvents);
        }
      }

      /* --------------------------------------------------------------------
         RENDERERS (1:1 ALIGNED WITH agent-board.css + board-deep.css)
         -------------------------------------------------------------------- */

      function renderShellAttrs() {
        const st = store.get();
        if (refs.shell) {
          refs.shell.setAttribute('data-mode', st.mode);
          refs.shell.setAttribute('data-stage', st.stage);
          refs.shell.setAttribute('data-mobile-pane', st.mobileStageOpen ? 'stage' : 'stream');
          refs.shell.setAttribute('data-spatial-expanded', meshExpanded && st.stage === 'live' ? 'true' : 'false');
          refs.shell.classList.toggle('is-stage-open', Boolean(st.mobileStageOpen));
          refs.shell.classList.toggle('is-spatial-expanded', Boolean(meshExpanded && st.stage === 'live'));
        }
        const toggles = containerEl.querySelectorAll('.eb-mobile-pane-btn[data-mobile-pane]');
        for (let i = 0; i < toggles.length; i += 1) {
          const btn = toggles[i];
          const pane = btn.getAttribute('data-mobile-pane');
          const active = st.mobileStageOpen ? pane === st.stage || pane === 'stage' : pane === 'stream';
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      }

      function renderDock() {
        const st = store.get();
        if (refs.dock) {
          const modeBtns = refs.dock.querySelectorAll('[data-eb-mode]');
          for (let i = 0; i < modeBtns.length; i += 1) {
            const btn = modeBtns[i];
            const active = !(meshExpanded && st.stage === 'live') && btn.getAttribute('data-eb-mode') === st.mode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          }
          const spatialBtn = refs.dock.querySelector('[data-eb-action="spatial-command"]');
          if (spatialBtn) {
            const spatialActive = Boolean(st.stage === 'live' && meshExpanded);
            spatialBtn.classList.toggle('is-active', spatialActive);
            spatialBtn.setAttribute('aria-pressed', spatialActive ? 'true' : 'false');
          }
        }

        const blockerCount = computeBlockerTotal(st.blockers);
        if (refs.dockBlockersBadge) {
          refs.dockBlockersBadge.textContent = blockerCount > 99 ? '99+' : blockerCount > 0 ? String(blockerCount) : '';
          refs.dockBlockersBadge.hidden = blockerCount <= 0;
          refs.dockBlockersBadge.classList.toggle('is-blocked', blockerCount > 0);
        }

        if (refs.dockAgents) {
          const liveByActor = Object.create(null);
          safeArray(st.agents).forEach((a) => {
            if (a && a.actor) liveByActor[String(a.actor).toLowerCase()] = a;
            if (a && a.handle) liveByActor[String(a.handle).toLowerCase()] = a;
          });

          refs.dockAgents.innerHTML = DOCK_AGENTS.map((a) => {
            const active = st.agentFilter && st.agentFilter.toLowerCase() === a.handle.toLowerCase();
            const live = liveByActor[a.handle.toLowerCase()] || liveByActor[a.id];
            const isOnline = !live || live.activeRecent !== false;
            const inner = a.brand === 'owner' ? ICONS.ownerMark : escHtml(a.glyph);
            return (
              `<button type="button" class="eb-dock-agent is-${escAttr(a.brand)}${isOnline ? ' is-online' : ''}${active ? ' is-active' : ''}" ` +
              `data-agent-handle="${escAttr(a.handle)}" ` +
              `title="${escAttr(a.label)} (click to filter, Shift+click to @mention)" ` +
              `aria-label="${escAttr(a.label)}" aria-pressed="${active ? 'true' : 'false'}">` +
              `${inner}</button>`
            );
          }).join('');
        }
      }

      function renderHeader() {
        const st = store.get();
        const isMission = st.mode === 'rooms' && st.channel === 'mission';
        const currentRoom = isMission ? null : st.rooms.find((r) => r.channel === st.channel);
        if (refs.roomTriggerDot) {
          refs.roomTriggerDot.className = `eb-room-dot${
            !isMission && currentRoom && currentRoom.blockedCount > 0 ? ' is-blocked' : ''
          }`;
        }
        if (refs.roomTriggerHash) {
          refs.roomTriggerHash.hidden = isMission || st.mode === 'feed' || st.mode === 'blockers';
        }
        if (refs.roomTriggerLabel) {
          if (st.mode === 'feed') {
            refs.roomTriggerLabel.textContent = 'Live Feed';
          } else if (st.mode === 'blockers') {
            refs.roomTriggerLabel.textContent = 'Blockers';
          } else if (isMission) {
            refs.roomTriggerLabel.textContent = 'Mission Signal';
          } else {
            refs.roomTriggerLabel.textContent = st.channel || 'box';
          }
        }

        if (refs.centerHeadRight) {
          const parts = [];
          if (st.agentFilter) {
            parts.push(
              `<button type="button" class="eb-filter-chip" data-action="clear-agent-filter" title="Clear @${escAttr(st.agentFilter)} filter">` +
                `<span>@${escHtml(st.agentFilter)}</span>` +
                `${ICONS.close}` +
              `</button>`
            );
          }
          parts.push(
            `<div class="eb-mobile-pane-toggle" role="group" aria-label="Switch pane">` +
              `<button type="button" class="eb-mobile-pane-btn${!st.mobileStageOpen ? ' is-active' : ''}" data-mobile-pane="stream" aria-pressed="${!st.mobileStageOpen ? 'true' : 'false'}">Stream</button>` +
              `<button type="button" class="eb-mobile-pane-btn${st.mobileStageOpen && st.stage === 'thread' ? ' is-active' : ''}" data-mobile-pane="thread" aria-pressed="${st.mobileStageOpen && st.stage === 'thread' ? 'true' : 'false'}">Thread</button>` +
              `<button type="button" class="eb-mobile-pane-btn${st.mobileStageOpen && st.stage === 'canvas' ? ' is-active' : ''}" data-mobile-pane="canvas" aria-pressed="${st.mobileStageOpen && st.stage === 'canvas' ? 'true' : 'false'}">Canvas</button>` +
              `<button type="button" class="eb-mobile-pane-btn${st.mobileStageOpen && st.stage === 'context' ? ' is-active' : ''}" data-mobile-pane="context" aria-pressed="${st.mobileStageOpen && st.stage === 'context' ? 'true' : 'false'}">Context</button>` +
              `<button type="button" class="eb-mobile-pane-btn${st.mobileStageOpen && st.stage === 'live' ? ' is-active' : ''}" data-mobile-pane="live" aria-pressed="${st.mobileStageOpen && st.stage === 'live' ? 'true' : 'false'}">live</button>` +
            `</div>`
          );
          parts.push(
            `<button type="button" class="eb-icon-btn" data-action="refresh" title="Refresh board" aria-label="Refresh board">${ICONS.refresh}</button>`
          );
          refs.centerHeadRight.innerHTML = parts.join('');
        }
      }

      function renderTelemetryRibbonSlot() {
        if (!refs.telemetryRibbonSlot) return;
        const st = store.get();
        if (st.mode === 'blockers') {
          refs.telemetryRibbonSlot.hidden = true;
          refs.telemetryRibbonSlot.innerHTML = '';
          return;
        }

        const artifactsMod = getBoardArtifacts();
        let ribbonHtml = '';
        if (artifactsMod && typeof artifactsMod.renderTelemetryRibbon === 'function') {
          ribbonHtml = artifactsMod.renderTelemetryRibbon(
            st.telemetrySummary,
            st.telemetryCount,
            st.signalFilter
          );
        } else {
          const mode = st.signalFilter || 'signal';
          ribbonHtml =
            `<div class="eb-telemetry-ribbon" data-eb-active-filter="${escAttr(mode)}">` +
              `<div class="eb-ribbon-tabs" role="tablist">` +
                `<button type="button" class="eb-ribbon-tab${mode === 'signal' ? ' is-active' : ''}" data-eb-stream-filter="signal">Signal</button>` +
                `<button type="button" class="eb-ribbon-tab${mode === 'all' ? ' is-active' : ''}" data-eb-stream-filter="all">All</button>` +
                `<button type="button" class="eb-ribbon-tab${mode === 'telemetry' ? ' is-active' : ''}" data-eb-stream-filter="telemetry">Telemetry${st.telemetryCount > 0 ? ` <span class="eb-ribbon-count">${st.telemetryCount}</span>` : ''}</button>` +
              `</div>` +
            `</div>`;
        }

        let drawerHtml = '';
        if (st.signalFilter !== 'signal' && Array.isArray(st.telemetrySummary) && st.telemetrySummary.length > 0) {
          const chips = st.telemetrySummary
            .slice(0, 6)
            .map((b) => {
              const label = stripEmDash((b && (b.label || b.kind)) || 'telemetry');
              const count = Number(b && b.count) || 0;
              const sample = b && b.sample ? stripEmDash(b.sample) : '';
              return (
                `<span class="eb-telemetry-chip is-live" title="${escAttr(sample || label)}">` +
                  `<span class="eb-telemetry-chip-dot" aria-hidden="true"></span>` +
                  `<span>${escHtml(String(count))} ${escHtml(label)}</span>` +
                `</span>`
              );
            })
            .join('');
          drawerHtml =
            `<div class="eb-telemetry-drawer">` +
              `<div class="eb-telemetry-drawer-head">` +
                `<span>Telemetry Rollup (${st.telemetryCount})</span>` +
                `<button type="button" class="eb-telemetry-toggle" data-eb-stream-filter="signal">Hide Noise</button>` +
              `</div>` +
              `<div class="eb-telemetry-chips">${chips}</div>` +
            `</div>`;
        }

        refs.telemetryRibbonSlot.hidden = false;
        refs.telemetryRibbonSlot.innerHTML = ribbonHtml + drawerHtml;
      }

      function renderRoomPopover() {
        if (!refs.roomListEl) return;
        const st = store.get();
        const matches = roomTypeahead.filter(st.roomQuery);

        if (refs.roomGroupsEl) {
          const groupEntries = [{ id: '', label: `All (${st.roomsTotal || st.rooms.length})` }];
          if (st.roomGroups.length) {
            st.roomGroups.slice(0, 8).forEach((g) => {
              if (typeof g === 'string') {
                groupEntries.push({ id: g, label: g });
              } else if (g && g.id) {
                groupEntries.push({
                  id: String(g.id),
                  label: stripEmDash(g.label || g.id),
                });
              }
            });
          } else {
            Array.from(new Set(st.rooms.map((r) => r.group).filter(Boolean)))
              .slice(0, 8)
              .forEach((g) => groupEntries.push({ id: g, label: g }));
          }

          refs.roomGroupsEl.innerHTML = groupEntries
            .map((g) => {
              const active = st.roomGroup === g.id;
              return (
                `<button type="button" class="eb-room-group-btn${active ? ' is-active' : ''}" ` +
                `data-room-group="${escAttr(g.id)}" aria-selected="${active ? 'true' : 'false'}">` +
                `${escHtml(g.label)}</button>`
              );
            })
            .join('');
        }

        const qLow = String(st.roomQuery || '').trim().toLowerCase();
        const showMissionPin =
          !st.roomGroup &&
          (!qLow ||
            'mission signal'.includes(qLow) ||
            'mission'.includes(qLow) ||
            'signal'.includes(qLow));

        const rows = [];
        if (showMissionPin) {
          const isMissionCurrent = st.mode === 'rooms' && st.channel === 'mission';
          const activeRoomCount =
            st.missionData && Array.isArray(st.missionData.activeRooms)
              ? st.missionData.activeRooms.length
              : 0;
          const missionBadge =
            activeRoomCount > 0
              ? `${activeRoomCount} active`
              : st.signalCount > 0
                ? `${st.signalCount}`
                : 'live';
          rows.push(
            `<button type="button" role="option" class="eb-room-option is-mission${isMissionCurrent ? ' is-selected' : ''}" ` +
              `data-room-path="mission" aria-selected="${isMissionCurrent ? 'true' : 'false'}">` +
              `<span class="eb-room-option-main">` +
                `<span class="eb-room-dot" aria-hidden="true"></span>` +
                `<span class="eb-room-option-path">Mission Signal</span>` +
              `</span>` +
              `<span class="eb-room-option-meta">` +
                `<span class="eb-room-count">${escHtml(missionBadge)}</span>` +
              `</span>` +
            `</button>`
          );
        }

        for (let i = 0; i < matches.length; i += 1) {
          const room = matches[i].item;
          const isCurrent = room.channel === st.channel;
          rows.push(
            `<button type="button" role="option" class="eb-room-option${isCurrent ? ' is-selected' : ''}" ` +
            `data-room-path="${escAttr(room.channel)}" aria-selected="${isCurrent ? 'true' : 'false'}">` +
              `<span class="eb-room-option-main">` +
                `<span class="eb-room-hash">#</span>` +
                `<span class="eb-room-option-path">${escHtml(room.channel)}</span>` +
              `</span>` +
              `<span class="eb-room-option-meta">` +
                `${room.blockedCount > 0 ? `<span class="eb-room-blocked-pill">${room.blockedCount}</span>` : ''}` +
                `<span class="eb-room-count">${room.threads || room.messages}</span>` +
              `</span>` +
            `</button>`
          );
        }

        if (!rows.length) {
          refs.roomListEl.innerHTML = '<div class="eb-empty"><p class="eb-empty-title">No matching rooms</p></div>';
          return;
        }
        refs.roomListEl.innerHTML = rows.join('');
      }

      function renderMentionPopover() {
        if (!refs.mentionListEl) return;
        const st = store.get();
        const matches = mentionTypeahead.filter(st.mentionQuery);
        if (!matches.length) {
          refs.mentionListEl.innerHTML = '<div class="eb-empty"><p class="eb-empty-title">No matching agents</p></div>';
          return;
        }
        refs.mentionListEl.innerHTML = matches
          .map((m) => {
            const ag = m.item;
            return (
              `<button type="button" role="option" class="eb-mention-item" data-mention-actor="${escAttr(ag.actor)}" aria-selected="false">` +
                `<span class="eb-agent-glyph is-${escAttr(ag.brand)}">${escHtml(ag.glyph || '@')}</span>` +
                `<span class="eb-mention-meta">` +
                  `<span class="eb-mention-handle">@${escHtml(ag.actor)}</span>` +
                  `<span class="eb-mention-role">${escHtml(ag.role)}</span>` +
                `</span>` +
              `</button>`
            );
          })
          .join('');
      }

      function statusChipClass(item) {
        if (item.isBlocked || item.isPaused || item.taskState === 'blocked' || item.taskState === 'stalled' || item.taskState === 'paused') {
          return 'is-blocked';
        }
        if (item.taskState === 'done' || item.taskState === 'resolved' || item.taskState === 'shipped') {
          return 'is-done';
        }
        if (item.taskState === 'claimed' || item.taskState === 'running' || item.taskState === 'in_progress') {
          return 'is-claimed';
        }
        if (item.taskState === 'ready' || item.taskState === 'open' || item.isOpenTask) {
          return 'is-ready';
        }
        return '';
      }

      function resolveSemanticStatusBadge(item) {
        if (!item || typeof item !== 'object') return null;
        const ts = String(item.taskState || '').toLowerCase();
        // Deduplicated canonical state: NEVER render both paused and blocked for the same item
        if (item.isPaused || ts === 'paused') {
          return { label: 'paused', cls: 'is-blocked' };
        }
        if (ts === 'stalled') {
          return { label: 'stalled', cls: 'is-blocked' };
        }
        if (item.isBlocked || ts === 'blocked') {
          return { label: 'blocked', cls: 'is-blocked' };
        }
        if (ts === 'done' || ts === 'resolved' || ts === 'shipped' || ts === 'completed') {
          return { label: ts, cls: 'is-done' };
        }
        if (ts === 'claimed' || ts === 'running' || ts === 'in_progress') {
          return { label: ts, cls: 'is-claimed' };
        }
        if (ts === 'ready' || ts === 'open' || item.isOpenTask) {
          return { label: ts || 'open', cls: 'is-ready' };
        }
        return null;
      }

      function renderMessageCardHtml(rawItem, opts) {
        const item = extractItemFields(rawItem);
        const st = store.get();
        const artifactsMod = getBoardArtifacts();
        const isSelected = st.selectedThreadId && st.selectedThreadId === item.threadId;
        const isCompactReply = Boolean(opts && opts.isReplyCard);
        const isThreadRoot = Boolean(opts && opts.isThreadRoot);
        const isStreamCard = !isCompactReply && !isThreadRoot;
        const showRoomTag =
          isStreamCard &&
          (st.channel === 'mission' || st.mode === 'feed' || st.mode === 'blockers') &&
          item.channel;

        const glyphContent = item.brand === 'owner' ? ICONS.ownerMark : escHtml(item.glyph);
        const statusBadge = resolveSemanticStatusBadge(item);
        const chipHtml = statusBadge
          ? `<span class="eb-status-chip ${statusBadge.cls}" data-eb-status="${escAttr(statusBadge.label)}">${escHtml(statusBadge.label)}</span>`
          : '';

        let signalBadgeHtml = '';
        if (
          !isCompactReply &&
          artifactsMod &&
          typeof artifactsMod.renderSignalBadge === 'function' &&
          rawItem &&
          rawItem.signal &&
          (rawItem.signal.signalKind || rawItem.signal.kind) &&
          (rawItem.signal.signalKind || rawItem.signal.kind) !== 'work'
        ) {
          signalBadgeHtml = artifactsMod.renderSignalBadge(rawItem.signal);
        }

        const needsResolve =
          item.isPaused ||
          item.isBlocked ||
          item.taskState === 'blocked' ||
          item.taskState === 'stalled' ||
          item.taskState === 'open' ||
          item.taskState === 'ready';

        const metaBits = [];
        // Never duplicate paused/blocked or status badge text in the footer metadata note
        if (item.taskOwner) metaBits.push(item.taskOwner);
        if (!isCompactReply && !isStreamCard && item.replyCount > 0) {
          metaBits.push(`${item.replyCount} ${item.replyCount === 1 ? 'reply' : 'replies'}`);
        }
        const metaNoteHtml = metaBits.length
          ? `<span class="eb-msg-meta-note">${escHtml(metaBits.join(' · '))}</span>`
          : '';

        let threadSpineHtml = '';
        if (
          isStreamCard &&
          artifactsMod &&
          typeof artifactsMod.renderThreadSpineHtml === 'function'
        ) {
          threadSpineHtml = artifactsMod.renderThreadSpineHtml(
            Object.assign({}, rawItem && typeof rawItem === 'object' ? rawItem : {}, {
              threadId: item.threadId,
              id: item.id,
              by: (rawItem && rawItem.by) || item.actor,
              brand: item.brand,
              displayName: item.displayName,
              createdAt: item.createdAt,
              replies: item.replyCount,
            })
          );
        }

        let replyPreviewHtml = '';
        if (
          isStreamCard &&
          artifactsMod &&
          typeof artifactsMod.renderReplyPreviewStrip === 'function' &&
          (item.replyCount > 0 || (rawItem && Array.isArray(rawItem.replyPreview) && rawItem.replyPreview.length > 0))
        ) {
          const normalizedPreviews = normalizeReplyPreviewItems(rawItem && rawItem.replyPreview);
          replyPreviewHtml = artifactsMod.renderReplyPreviewStrip(
            {
              items: normalizedPreviews,
              participants: safeArray(rawItem && rawItem.participants),
            },
            item.replyCount,
            item.threadId
          );
        }

        const cardLogKey = item.threadId || item.id || '';
        const isJustArrived =
          isStreamCard &&
          Boolean(
            (item.threadId && justArrivedIds.has(item.threadId)) ||
              (item.id && justArrivedIds.has(item.id))
          );

        const wrapperClass = isCompactReply
          ? 'eb-thread-reply-card'
          : isThreadRoot
            ? 'eb-thread-root'
            : `eb-thread-card${isSelected ? ' is-selected' : ''}${isJustArrived ? ' eb-just-arrived' : ''}`;

        return (
          `<article class="${wrapperClass}" data-thread-id="${escAttr(item.threadId)}" data-msg-id="${escAttr(item.id)}"${isSelected ? ' data-thread-active="true"' : ''}>` +
            `<div class="eb-msg-row">` +
              `<header class="eb-msg-head">` +
                `<span class="eb-author-glyph is-${escAttr(item.brand)}" aria-hidden="true">${glyphContent}</span>` +
                `<button type="button" class="eb-author is-${escAttr(item.brand)}" style="background:none;border:0;padding:0;cursor:pointer;" data-action="filter-actor" data-actor="${escAttr(item.actor)}">${escHtml(item.displayName)}</button>` +
                `${item.via ? `<span class="eb-msg-via">via ${escHtml(item.via)}</span>` : ''}` +
                `${showRoomTag ? `<button type="button" class="eb-msg-room-tag" style="border:0;cursor:pointer;" data-action="open-room" data-room="${escAttr(item.channel)}">#${escHtml(item.channel)}</button>` : ''}` +
                `${signalBadgeHtml}` +
                `${chipHtml}` +
                `${item.id ? `<span class="eb-msg-id" title="#${escAttr(item.id)}">${escHtml(formatShortThreadId(item.id))}</span>` : ''}` +
                `${item.createdAt ? `<time class="eb-msg-time">${escHtml(formatRelativeTime(item.createdAt))}</time>` : ''}` +
              `</header>` +
              `${item.title && !isTitleDuplicatedByBody(item.title, item.text) ? `<h4 class="eb-msg-title">${escHtml(item.title)}</h4>` : ''}` +
              `<div class="eb-msg-body">${renderRichOrFallbackBody(rawItem, item, hooks, {
                compact: isCompactReply,
                collapsible: isStreamCard,
                expanded: Boolean(cardLogKey && expandedLogIds.has(cardLogKey)),
                logKey: cardLogKey,
              })}</div>` +
              `${threadSpineHtml}` +
              `${replyPreviewHtml}` +
              `${
                !isCompactReply
                  ? `<div class="eb-msg-actions">` +
                      `<button type="button" class="eb-pill-btn" data-action="reply" data-thread-id="${escAttr(item.threadId)}" data-paused="${item.isPaused ? '1' : '0'}">${ICONS.reply}<span>Reply</span></button>` +
                      `${
                        needsResolve
                          ? `<button type="button" class="eb-pill-btn is-resolve" data-action="resolve" data-thread-id="${escAttr(item.threadId)}" data-paused="${item.isPaused ? '1' : '0'}">Resolve</button>`
                          : `<button type="button" class="eb-pill-btn eb-inspect-btn" data-action="inspect" data-thread-id="${escAttr(item.threadId)}">Inspect</button>`
                      }` +
                      `${metaNoteHtml}` +
                    `</div>`
                  : ''
              }` +
            `</div>` +
          `</article>`
        );
      }

      function renderStream() {
        if (!refs.feedScroll) return;
        const st = store.get();

        if (st.loadingStream && st.streamItems.length === 0) {
          refs.feedScroll.innerHTML =
            '<div class="eb-loading"><p class="eb-empty-title">Loading multiplayer stream...</p></div>';
          return;
        }

        if (!st.streamItems.length) {
          let msg;
          if (st.agentFilter) {
            msg = `No messages from @${st.agentFilter} in this view.`;
          } else if (st.mode === 'blockers') {
            msg = 'Zero active blockers across the fleet.';
          } else if (st.signalFilter === 'telemetry') {
            msg = 'No telemetry heartbeats in this window.';
          } else if (st.channel === 'mission') {
            msg = 'No high-signal threads in the current window. Switch to All or pick a room.';
          } else {
            msg = `No signal threads in #${st.channel || 'box'} yet. Switch to All or start one below.`;
          }
          refs.feedScroll.innerHTML = `<div class="eb-empty"><p class="eb-empty-title">${escHtml(msg)}</p></div>`;
          return;
        }

        // Keyed DOM node reuse by thread id (avoids blind innerHTML nuking on SSE ticks)
        const d = doc || getDoc();
        if (!d || typeof d.createElement !== 'function') {
          refs.feedScroll.innerHTML = st.streamItems.map((item) => renderMessageCardHtml(item)).join('');
          return;
        }

        const existingByKey = new Map();
        const staleNodes = [];
        let child = refs.feedScroll.firstElementChild;
        while (child) {
          const nextSibling = child.nextElementSibling;
          const k =
            (child.getAttribute && (child.getAttribute('data-thread-id') || child.getAttribute('data-msg-id'))) ||
            '';
          if (k && child.classList && child.classList.contains('eb-thread-card') && !existingByKey.has(k)) {
            existingByKey.set(k, child);
          } else {
            staleNodes.push(child);
          }
          child = nextSibling;
        }
        for (let i = 0; i < staleNodes.length; i += 1) {
          if (staleNodes[i].parentNode === refs.feedScroll) {
            refs.feedScroll.removeChild(staleNodes[i]);
          }
        }

        const scratch = d.createElement('div');
        const nextOrder = [];
        const usedKeys = new Set();

        for (let i = 0; i < st.streamItems.length; i += 1) {
          const rawItem = st.streamItems[i];
          const html = renderMessageCardHtml(rawItem);
          const sig = fastDomSig(html);
          const fields = extractItemFields(rawItem);
          const baseKey = String(fields.threadId || fields.id || `idx-${i}`);
          const key = usedKeys.has(baseKey) ? `${baseKey}::${i}` : baseKey;
          usedKeys.add(key);

          let node = existingByKey.get(key);
          if (node) {
            existingByKey.delete(key);
            if (node.getAttribute('data-eb-sig') !== sig) {
              scratch.innerHTML = html;
              const freshEl = scratch.firstElementChild;
              if (freshEl) {
                node.className = freshEl.className;
                if (freshEl.hasAttribute('data-thread-active')) {
                  node.setAttribute('data-thread-active', 'true');
                } else {
                  node.removeAttribute('data-thread-active');
                }
                node.innerHTML = freshEl.innerHTML;
                node.setAttribute('data-eb-sig', sig);
              }
            }
          } else {
            scratch.innerHTML = html;
            node = scratch.firstElementChild;
            if (node) {
              node.setAttribute('data-eb-sig', sig);
            }
          }
          if (node) {
            nextOrder.push(node);
          }
        }

        for (const leftover of existingByKey.values()) {
          if (leftover.parentNode === refs.feedScroll) {
            refs.feedScroll.removeChild(leftover);
          }
        }

        let cursor = refs.feedScroll.firstElementChild;
        for (let i = 0; i < nextOrder.length; i += 1) {
          const desired = nextOrder[i];
          if (desired === cursor) {
            cursor = cursor.nextElementSibling;
          } else {
            refs.feedScroll.insertBefore(desired, cursor || null);
          }
        }
      }

      function renderComposerTarget() {
        const st = store.get();
        const postChannel = resolvePostChannel(st.channel);
        if (refs.composerTargetSlot) {
          if (st.replyTargetId) {
            refs.composerTargetSlot.innerHTML =
              `<span class="eb-composer-target">` +
                `<span>Replying to #${escHtml(st.replyTargetId)}</span>` +
                `<button type="button" class="eb-composer-target-clear" data-action="clear-reply-target" title="Switch to new thread in #${escAttr(postChannel)}" aria-label="Clear reply target">${ICONS.close}</button>` +
              `</span>` +
              `${
                st.replyTargetPaused
                  ? `<label class="eb-filter-chip" style="height:24px;"><input type="checkbox" data-action="toggle-resume"${st.resumePaused ? ' checked' : ''}><span>Resume paused</span></label>`
                  : ''
              }`;
          } else {
            refs.composerTargetSlot.innerHTML =
              `<span class="eb-composer-target">#${escHtml(postChannel)}</span>`;
          }
        }

        if (refs.composerInput) {
          refs.composerInput.placeholder = st.replyTargetId
            ? `Reply to #${st.replyTargetId}, /command, @mention, or [[context]]...`
            : `Message #${postChannel} (/command, @mention, [[context]])...`;
        }

        if (refs.sendBtn) {
          refs.sendBtn.disabled = Boolean(st.sending);
        }
      }

      function renderInlineBanner() {
        if (!refs.inlineBanner) return;
        const banner = store.get().banner;
        if (!banner || !banner.text) {
          refs.inlineBanner.hidden = true;
          refs.inlineBanner.textContent = '';
          return;
        }
        refs.inlineBanner.hidden = false;
        refs.inlineBanner.className = banner.tone === 'error' ? 'eb-error-banner' : 'eb-sse-pill';
        refs.inlineBanner.textContent = stripEmDash(banner.text);
      }

      function renderStageHeader() {
        const st = store.get();
        if (refs.stageTabs) {
          const tabs = refs.stageTabs.querySelectorAll('[data-stage]');
          for (let i = 0; i < tabs.length; i += 1) {
            const btn = tabs[i];
            const active = btn.getAttribute('data-stage') === st.stage;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
          }
          const liveDot = refs.stageTabs.querySelector('.eb-live-dot');
          if (liveDot) {
            liveDot.className = `eb-live-dot${
              st.sseStatus === 'reconnecting' || st.sseStatus === 'connecting'
                ? ' is-polling'
                : st.sseStatus === 'offline'
                  ? ' is-offline'
                  : ''
            }`;
          }
        }
      }

      function renderThreadStage() {
        const st = store.get();
        if (st.loadingThread && !st.threadDetail) {
          return '<div class="eb-loading"><p class="eb-empty-title">Loading thread...</p></div>';
        }
        if (!st.threadDetail || !st.threadDetail.root) {
          return '<div class="eb-empty"><p class="eb-empty-title">Select a thread from the stream to inspect root, replies, and runs.</p></div>';
        }

        const detail = st.threadDetail;
        const rootItem = extractItemFields(detail.root);
        const replies = safeArray(detail.replies);
        const runs = safeArray(detail.runs);
        const pause = detail.pause;
        const activeCh = rootItem.channel || resolvePostChannel(st.channel);
        const ctxMod = getBoardContextStage();
        const activeThreadKey = st.selectedThreadId || rootItem.threadId || rootItem.id;
        const briefState = getBriefEntryForThread(activeThreadKey, detail);

        const briefCardHtml =
          ctxMod && typeof ctxMod.renderLocalLlmBriefCard === 'function'
            ? ctxMod.renderLocalLlmBriefCard(briefState, {
                placement: 'thread',
                thread: detail,
                threadId: activeThreadKey,
                channel: activeCh,
              })
            : '';

        const needsVerdict = Boolean(
          pause ||
            rootItem.isBlocked ||
            rootItem.isPaused ||
            /decision/i.test(activeCh) ||
            (ctxMod && typeof ctxMod.needsDecisionVerdict === 'function' && ctxMod.needsDecisionVerdict(detail))
        );
        const verdictBarHtml =
          needsVerdict && ctxMod && typeof ctxMod.renderDecisionVerdictBar === 'function'
            ? ctxMod.renderDecisionVerdictBar(detail, { channel: activeCh })
            : '';

        const pauseBanner = pause
          ? `<div class="eb-error-banner" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">` +
              `<span><strong>Paused:</strong> ${escHtml(
                (typeof pause === 'object' && (pause.reason || pause.message)) || 'Waiting for operator reply'
              )}</span>` +
              `<button type="button" class="eb-ship-btn" data-action="reply-unblock" data-thread-id="${escAttr(rootItem.threadId)}">Reply &amp; Unblock</button>` +
            `</div>`
          : '';

        const runsHtml = runs.length
          ? `<div class="eb-thread-runs">` +
              runs
                .slice(0, 6)
                .map((run) => {
                  const r = run && typeof run === 'object' ? run : {};
                  const status = stripEmDash(r.status || r.state || 'run');
                  const seat = stripEmDash(r.seat || r.agent || r.harness || 'worker');
                  const model = stripEmDash(r.model || '');
                  const dur = r.duration || (r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '');
                  const okCls =
                    String(status).toLowerCase().includes('fail') || Number(r.exitCode) > 0
                      ? 'is-failed'
                      : String(status).toLowerCase().includes('run')
                        ? 'is-running'
                        : 'is-ok';
                  return (
                    `<div class="eb-run-strip ${okCls}">` +
                      `<div class="eb-run-strip-left">` +
                        `<span class="eb-run-strip-cmd">${escHtml(seat)}</span>` +
                        `${model ? `<span class="eb-run-strip-metric">${escHtml(model)}</span>` : ''}` +
                      `</div>` +
                      `<div class="eb-run-strip-right">` +
                        `<span class="eb-meta-pill">${escHtml(status)}</span>` +
                        `${dur ? `<span class="eb-run-strip-metric">${escHtml(String(dur))}</span>` : ''}` +
                      `</div>` +
                    `</div>`
                  );
                })
                .join('') +
            `</div>`
          : '';

        return (
          `<div class="eb-thread-view">` +
            `${briefCardHtml}` +
            `${verdictBarHtml}` +
            `${pauseBanner}` +
            `${renderMessageCardHtml(detail.root, { isThreadRoot: true })}` +
            `<div class="eb-thread-meta-grid">` +
              `<div class="eb-meta-card"><span class="eb-meta-label">Thread</span><span class="eb-meta-value" title="#${escAttr(rootItem.threadId)}">${escHtml(formatShortThreadId(rootItem.threadId))}</span></div>` +
              `<div class="eb-meta-card"><span class="eb-meta-label">Room</span><span class="eb-meta-value">#${escHtml(activeCh)}</span></div>` +
              `<div class="eb-meta-card"><span class="eb-meta-label">Status</span><span class="eb-meta-value">${escHtml(rootItem.isPaused || pause ? 'paused' : rootItem.taskState || 'open')}</span></div>` +
              `<div class="eb-meta-card"><span class="eb-meta-label">Active Runs</span><span class="eb-meta-value">${runs.length}</span></div>` +
            `</div>` +
            `${runsHtml}` +
            `<div class="eb-thread-replies-head">` +
              `<span>Replies (${replies.length})</span>` +
              `<button type="button" class="eb-pill-btn" data-action="reply" data-thread-id="${escAttr(rootItem.threadId)}" data-paused="${pause || rootItem.isPaused ? '1' : '0'}">${ICONS.reply}<span>Reply</span></button>` +
            `</div>` +
            `<div class="eb-thread-replies">` +
              `${
                replies.length
                  ? replies.map((r) => renderMessageCardHtml(r, { isReplyCard: true })).join('')
                  : '<div class="eb-empty"><p class="eb-empty-title">No replies yet.</p></div>'
              }` +
            `</div>` +
          `</div>`
        );
      }

      function renderCanvasCard(rawItem, badgeLabel, isBlocked) {
        const item = extractItemFields(rawItem);
        const { titleText, excerpt } = buildCanvasCardCopy(item);
        const shortId = formatShortThreadId(item.threadId);
        const ctxMod = getBoardContextStage();
        const cardChannel =
          item.channel || (badgeLabel === 'Decision' ? 'kizuki/decisions' : resolvePostChannel(store.get().channel));
        const verdictHtml =
          ctxMod && typeof ctxMod.renderDecisionVerdictBar === 'function' && item.threadId
            ? ctxMod.renderDecisionVerdictBar(
                Object.assign({}, rawItem && typeof rawItem === 'object' ? rawItem : {}, {
                  threadId: item.threadId,
                  channel: cardChannel,
                  isPaused: item.isPaused || badgeLabel === 'Paused',
                  isBlocked: item.isBlocked || isBlocked,
                }),
                { compact: true, channel: cardChannel }
              )
            : '';

        return (
          `<article class="eb-canvas-card${isBlocked ? ' is-blocked' : ''}">` +
            `<div class="eb-msg-head eb-canvas-card-head">` +
              `<span class="eb-author-glyph is-${escAttr(item.brand)}">${item.brand === 'owner' ? ICONS.ownerMark : escHtml(item.glyph)}</span>` +
              `<span class="eb-author is-${escAttr(item.brand)}" title="${escAttr(item.displayName)}">${escHtml(item.displayName)}</span>` +
              `<span class="eb-status-chip ${isBlocked ? 'is-blocked' : 'is-ready'}">${escHtml(badgeLabel)}</span>` +
              `${shortId ? `<span class="eb-msg-id eb-canvas-card-id" title="#${escAttr(item.threadId)}">${escHtml(shortId)}</span>` : ''}` +
            `</div>` +
            `<h4 class="eb-canvas-card-title">${escHtml(titleText)}</h4>` +
            `${excerpt ? `<p class="eb-canvas-card-excerpt">${escHtml(excerpt)}</p>` : ''}` +
            `${verdictHtml}` +
            `<div class="eb-canvas-card-actions">` +
              `<button type="button" class="eb-pill-btn" data-action="inspect" data-thread-id="${escAttr(item.threadId)}">Open Thread</button>` +
              `<button type="button" class="eb-ship-btn" data-action="reply-unblock" data-thread-id="${escAttr(item.threadId)}">Reply &amp; Unblock</button>` +
            `</div>` +
          `</article>`
        );
      }

      function renderCanvasStage() {
        const st = store.get();
        const b = st.blockers || {};
        const decisions = safeArray(st.decisions);
        const blockedList = []
          .concat(safeArray(b.paused).map((x) => ({ item: x, tag: 'Paused' })))
          .concat(safeArray(b.stalled).map((x) => ({ item: x, tag: 'Stalled' })))
          .concat(safeArray(b.escalations).map((x) => ({ item: x, tag: 'Escalation' })))
          .concat(safeArray(b.orchestratorQueue).map((x) => ({ item: x, tag: 'Orchestrator Queue' })));
        const intake = safeArray(b.intake);

        return (
          `<div class="eb-canvas-grid">` +
            `<section class="eb-canvas-section">` +
              `<header class="eb-canvas-section-head">` +
                `<h4 class="eb-canvas-section-title">Open Decisions · kizuki/decisions</h4>` +
                `<span class="eb-canvas-section-count">${decisions.length}</span>` +
              `</header>` +
              `<div class="eb-canvas-cards">` +
                `${
                  decisions.length
                    ? decisions.slice(0, 8).map((d) => renderCanvasCard(d, 'Decision', false)).join('')
                    : '<div class="eb-empty"><p class="eb-empty-title">No open decisions in kizuki/decisions.</p></div>'
                }` +
              `</div>` +
            `</section>` +
            `<section class="eb-canvas-section">` +
              `<header class="eb-canvas-section-head">` +
                `<h4 class="eb-canvas-section-title">Paused &amp; Blocked Tasks</h4>` +
                `<span class="eb-canvas-section-count">${blockedList.length}</span>` +
              `</header>` +
              `<div class="eb-canvas-cards">` +
                `${
                  blockedList.length
                    ? blockedList.slice(0, 10).map((e) => renderCanvasCard(e.item, e.tag, true)).join('')
                    : '<div class="eb-empty"><p class="eb-empty-title">No paused or blocked tasks.</p></div>'
                }` +
              `</div>` +
            `</section>` +
            `<section class="eb-canvas-section">` +
              `<header class="eb-canvas-section-head">` +
                `<h4 class="eb-canvas-section-title">Recent Intake Queue</h4>` +
                `<span class="eb-canvas-section-count">${intake.length}</span>` +
              `</header>` +
              `<div class="eb-canvas-cards">` +
                `${
                  intake.length
                    ? intake.slice(0, 8).map((item) => renderCanvasCard(item, 'Intake', false)).join('')
                    : '<div class="eb-empty"><p class="eb-empty-title">Intake queue is clear.</p></div>'
                }` +
              `</div>` +
            `</section>` +
          `</div>`
        );
      }

      function renderContextStageHtml() {
        const st = store.get();
        const ctxMod = getBoardContextStage();
        const tid = st.selectedThreadId || '';
        const ch = resolveActiveThreadChannel();
        const key = `${tid}:${ch}`;
        const ctxEntry = (st.contextByKey && st.contextByKey[key]) || { data: null, loading: false, error: '' };
        const briefState = getBriefEntryForThread(tid, st.threadDetail);

        if (ctxMod && typeof ctxMod.renderContextStage === 'function') {
          return ctxMod.renderContextStage(
            {
              thread: st.threadDetail || (tid ? { threadId: tid, channel: ch } : null),
              threadId: tid,
              channel: ch,
              contextData: ctxEntry.data,
              briefState,
              loading: Boolean(ctxEntry.loading),
            },
            hooks
          );
        }

        return '<div class="eb-empty"><p class="eb-empty-title">Context stage module unavailable.</p></div>';
      }

      function formatTapeClock(isoOrMs) {
        if (!isoOrMs) return '--:--';
        const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs));
        if (!Number.isFinite(ts)) return formatRelativeTime(isoOrMs) || '--:--';
        const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diffSec < 60) return `${diffSec}s ago`;
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
      }

      function buildLiveEventTapeRows(st) {
        const rows = [];
        const sseList = safeArray(st.sseEvents);
        for (let i = 0; i < sseList.length && rows.length < MAX_EVENT_TAPE_ROWS; i += 1) {
          const ev = sseList[i];
          if (!ev || typeof ev !== 'object') continue;
          const actorClean = extractActorSlug(ev.actor, '') || ev.actor || 'system';
          const meta = parseAgentIdentity(actorClean, '', '', '', null);
          rows.push({
            id: String(ev.id || `sse-${i}`),
            at: ev.at,
            kind: String(ev.kind || 'event').toLowerCase(),
            actor: meta.handle,
            brand: meta.brand,
            channel: ev.channel || 'stream',
            summary: truncateWordBoundary(humanizeMentions(ev.summary || 'live update'), 96),
            threadId: ev.threadId || '',
            isFresh: Boolean(ev.isFresh && i === 0),
          });
        }

        if (rows.length < 6) {
          const fallbackSrc =
            st.missionData && Array.isArray(st.missionData.items) && st.missionData.items.length
              ? st.missionData.items
              : safeArray(st.streamItems);
          for (let i = 0; i < fallbackSrc.length && rows.length < 6; i += 1) {
            const raw = fallbackSrc[i];
            if (!raw || typeof raw !== 'object') continue;
            const f = extractItemFields(raw);
            const sigKind =
              (raw.signal && (raw.signal.signalKind || raw.signal.kind)) ||
              (f.isBlocked || f.isPaused ? 'decision' : 'board');
            const summarySrc = f.title || f.text || `Thread #${f.threadId}`;
            rows.push({
              id: `fallback-${f.threadId || f.id || i}`,
              at: f.createdAt,
              kind: String(sigKind || 'board').toLowerCase(),
              actor: f.actor,
              brand: f.brand,
              channel: f.channel || 'box',
              summary: truncateWordBoundary(humanizeMentions(summarySrc), 96),
              threadId: f.threadId || f.id || '',
              isFresh: false,
            });
          }
        }
        return rows.slice(0, MAX_EVENT_TAPE_ROWS);
      }

      function renderLiveTapeRowInner(row) {
        const kindSlug = row.kind.replace(/[^a-z0-9_-]/g, '') || 'event';
        return (
          `<span class="eb-event-tape-time">${escHtml(formatTapeClock(row.at))}</span>` +
          `<span class="eb-event-tape-kind is-${escAttr(kindSlug)}">${escHtml(row.kind)}</span>` +
          `<span class="eb-event-tape-actor is-${escAttr(row.brand)}">@${escHtml(row.actor)}</span>` +
          `<span class="eb-event-tape-chan">#${escHtml(row.channel)}</span>` +
          `<span class="eb-event-tape-msg">${escHtml(row.summary)}</span>`
        );
      }

      function patchLiveStageIncremental() {
        if (!refs.stageBody) return;
        const existingSections = refs.stageBody.querySelector('[data-eb-ref="live-sections"]');
        if (!existingSections) {
          renderStage();
          return;
        }
        const st = store.get();
        const tapeHost = existingSections.querySelector('[data-eb-ref="live-event-tape"]');
        const headerHost = existingSections.querySelector('.eb-live-header');
        if (!tapeHost || !headerHost) {
          existingSections.innerHTML = renderLiveSectionsHtml();
          return;
        }

        // Update live header pill & host telemetry text without rebuilding roster
        const sseHost = st.sseHost || null;
        const sseClass =
          st.sseStatus === 'connected'
            ? ''
            : st.sseStatus === 'reconnecting' || st.sseStatus === 'connecting'
              ? ' is-polling'
              : ' is-offline';
        const sseLabel =
          st.sseStatus === 'connected'
            ? 'SSE Stream Connected'
            : st.sseStatus === 'reconnecting'
              ? 'Reconnecting SSE...'
              : st.sseStatus === 'connecting'
                ? 'Connecting SSE...'
                : 'SSE Offline';
        const pillEl = headerHost.querySelector('.eb-sse-pill');
        if (pillEl) {
          const nextCls = `eb-sse-pill${sseClass}`;
          if (pillEl.className !== nextCls) pillEl.className = nextCls;
          const dotEl = pillEl.querySelector('.eb-live-dot');
          const nextDotCls = `eb-live-dot${sseClass}`;
          if (dotEl && dotEl.className !== nextDotCls) dotEl.className = nextDotCls;
          const labelSpan = pillEl.lastElementChild;
          if (labelSpan && labelSpan.textContent !== sseLabel) labelSpan.textContent = sseLabel;
        }
        const metaEl = headerHost.querySelector('.eb-msg-meta-note');
        if (metaEl) {
          const hostTelemetryBits = [];
          if (sseHost) {
            if (sseHost.cpus != null) hostTelemetryBits.push(`${sseHost.cpus} CPUs`);
            if (sseHost.load1 != null) hostTelemetryBits.push(`load ${Number(sseHost.load1).toFixed(2)}`);
            if (sseHost.mem_available_gib != null) {
              hostTelemetryBits.push(`${Number(sseHost.mem_available_gib).toFixed(1)} GiB free`);
            }
          }
          if (st.hostHistory && st.hostHistory.length) {
            hostTelemetryBits.push(`${st.hostHistory.length}/120 samples`);
          }
          const nextMeta = hostTelemetryBits.length
            ? hostTelemetryBits.join(' · ')
            : `${st.roomsTotal || st.rooms.length} rooms · ${safeArray(st.agents).length} agents`;
          if (metaEl.textContent !== nextMeta) metaEl.textContent = nextMeta;
        }

        // Recycle up to 60 Live Event Tape row DOM nodes in place
        const d = doc || getDoc();
        const tapeRows = buildLiveEventTapeRows(st);
        if (!d || typeof d.createElement !== 'function') return;

        while (tapeHost.children.length > tapeRows.length) {
          tapeHost.removeChild(tapeHost.lastElementChild);
        }
        for (let i = 0; i < tapeRows.length; i += 1) {
          const row = tapeRows[i];
          const clickable = Boolean(row.threadId);
          const rowCls = `eb-event-tape-row${clickable ? ' is-clickable' : ''}${row.isFresh ? ' is-fresh' : ''}`;
          const desiredTag = clickable ? 'BUTTON' : 'DIV';
          let el = tapeHost.children[i];
          if (!el || el.tagName !== desiredTag) {
            const replacement = d.createElement(clickable ? 'button' : 'div');
            if (clickable) replacement.setAttribute('type', 'button');
            if (el) {
              tapeHost.replaceChild(replacement, el);
            } else {
              tapeHost.appendChild(replacement);
            }
            el = replacement;
          }
          const sig = `${row.id}|${row.isFresh ? 1 : 0}|${formatTapeClock(row.at)}`;
          if (el.getAttribute('data-eb-tape-sig') !== sig) {
            el.className = rowCls;
            if (clickable) {
              el.setAttribute('data-action', 'open-tape-thread');
              el.setAttribute('data-thread-id', row.threadId);
            } else {
              el.removeAttribute('data-action');
              el.removeAttribute('data-thread-id');
            }
            el.innerHTML = renderLiveTapeRowInner(row);
            el.setAttribute('data-eb-tape-sig', sig);
          }
        }
      }

      function renderLiveSectionsHtml() {
        const st = store.get();
        const agents = safeArray(st.agents);
        const sseHost = st.sseHost || null;

        const sseClass =
          st.sseStatus === 'connected'
            ? ''
            : st.sseStatus === 'reconnecting' || st.sseStatus === 'connecting'
              ? ' is-polling'
              : ' is-offline';
        const sseLabel =
          st.sseStatus === 'connected'
            ? 'SSE Stream Connected'
            : st.sseStatus === 'reconnecting'
              ? 'Reconnecting SSE...'
              : st.sseStatus === 'connecting'
                ? 'Connecting SSE...'
                : 'SSE Offline';

        const hostTelemetryBits = [];
        if (sseHost) {
          if (sseHost.cpus != null) hostTelemetryBits.push(`${sseHost.cpus} CPUs`);
          if (sseHost.load1 != null) hostTelemetryBits.push(`load ${Number(sseHost.load1).toFixed(2)}`);
          if (sseHost.mem_available_gib != null) {
            hostTelemetryBits.push(`${Number(sseHost.mem_available_gib).toFixed(1)} GiB free`);
          }
        }
        if (st.hostHistory && st.hostHistory.length) {
          hostTelemetryBits.push(`${st.hostHistory.length}/120 samples`);
        }

        const tapeRows = buildLiveEventTapeRows(st);
        const tapeHtml = tapeRows.length
          ? `<div class="eb-event-tape" data-eb-ref="live-event-tape" role="log" aria-label="Live event tape">` +
              tapeRows
                .map((row) => {
                  const kindSlug = row.kind.replace(/[^a-z0-9_-]/g, '') || 'event';
                  const clickable = Boolean(row.threadId);
                  const rowCls = `eb-event-tape-row${clickable ? ' is-clickable' : ''}${row.isFresh ? ' is-fresh' : ''}`;
                  const tag = clickable ? 'button' : 'div';
                  const extraAttrs = clickable
                    ? ` type="button" data-action="open-tape-thread" data-thread-id="${escAttr(row.threadId)}"`
                    : '';
                  return (
                    `<${tag} class="${rowCls}"${extraAttrs}>` +
                      `<span class="eb-event-tape-time">${escHtml(formatTapeClock(row.at))}</span>` +
                      `<span class="eb-event-tape-kind is-${escAttr(kindSlug)}">${escHtml(row.kind)}</span>` +
                      `<span class="eb-event-tape-actor is-${escAttr(row.brand)}">@${escHtml(row.actor)}</span>` +
                      `<span class="eb-event-tape-chan">#${escHtml(row.channel)}</span>` +
                      `<span class="eb-event-tape-msg">${escHtml(row.summary)}</span>` +
                    `</${tag}>`
                  );
                })
                .join('') +
            `</div>`
          : '<div class="eb-empty"><p class="eb-empty-title">Listening for live SSE board, action, and telemetry events...</p></div>';

        const rosterHtml = agents.length
          ? `<div class="eb-roster-compact-grid">` +
              agents
                .slice(0, 12)
                .map((ag) => {
                  const rawActor = String(ag.actor || ag.handle || 'agent').replace(/^@+/, '');
                  const meta = parseAgentIdentity(rawActor, ag.brand, ag.role, ag.displayName, ag.profile);
                  const msgCount = Number(ag.messagesCount != null ? ag.messagesCount : ag.messageCount || 0);
                  const isOnline = ag.activeRecent !== false && String(ag.status || '').toLowerCase() !== 'offline';
                  return (
                    `<div class="eb-roster-compact-row" data-action="mention-filtered" data-handle="${escAttr(meta.handle)}" title="Click to @mention ${escAttr(meta.label)}">` +
                      `<div class="eb-roster-left">` +
                        `<span class="eb-agent-glyph is-${escAttr(meta.brand)}">${meta.brand === 'owner' ? ICONS.ownerMark : escHtml(meta.glyph)}</span>` +
                        `<div class="eb-roster-info">` +
                          `<span class="eb-roster-name">${escHtml(meta.label)}</span>` +
                          `<span class="eb-roster-role">@${escHtml(meta.handle)}</span>` +
                        `</div>` +
                      `</div>` +
                      `<div class="eb-roster-right">` +
                        `<span class="eb-room-count">${msgCount}</span>` +
                        `<span class="eb-live-dot${isOnline ? '' : ' is-offline'}"></span>` +
                      `</div>` +
                    `</div>`
                  );
                })
                .join('') +
            `</div>`
          : '<div class="eb-empty"><p class="eb-empty-title">No agent presence loaded.</p></div>';

        return (
          `<div class="eb-live-header">` +
            `<span class="eb-sse-pill${sseClass}"><span class="eb-live-dot${sseClass}"></span><span>${escHtml(sseLabel)}</span></span>` +
            `<span class="eb-msg-meta-note">${
              hostTelemetryBits.length
                ? escHtml(hostTelemetryBits.join(' · '))
                : `${st.roomsTotal || st.rooms.length} rooms · ${agents.length} agents`
            }</span>` +
            `<button type="button" class="eb-spatial-toggle-btn" data-eb-action="spatial-command" title="Toggle Full-Stage Spatial Command Mode (M)">` +
              `${meshExpanded ? 'Exit Full Stage' : 'Full Stage'} <span class="eb-keycap">M</span>` +
            `</button>` +
          `</div>` +
          `<section class="eb-live-section" data-eb-section="event-tape">` +
            `<h4 class="eb-live-section-title">LIVE EVENT TAPE</h4>` +
            `${tapeHtml}` +
          `</section>` +
          `<section class="eb-live-section" data-eb-section="presence-roster">` +
            `<h4 class="eb-live-section-title">Live Agent Presence Roster</h4>` +
            `${rosterHtml}` +
          `</section>`
        );
      }

      function renderStage() {
        renderStageHeader();
        if (!refs.stageBody) return;
        const st = store.get();
        if (st.stage === 'live') {
          let existingHost = refs.stageBody.querySelector('[data-eb-ref="mesh-mount"]');
          let existingSections = refs.stageBody.querySelector('[data-eb-ref="live-sections"]');
          if (!existingHost || !existingSections) {
            unmountMesh();
            refs.stageBody.innerHTML =
              `<div class="eb-live-panel">` +
                `<div class="eb-mesh-shell eb-mesh-mount-host" data-eb-ref="mesh-mount"></div>` +
                `<div class="eb-live-sections" data-eb-ref="live-sections" style="display:flex;flex-direction:column;gap:14px;"></div>` +
              `</div>`;
            existingHost = refs.stageBody.querySelector('[data-eb-ref="mesh-mount"]');
            existingSections = refs.stageBody.querySelector('[data-eb-ref="live-sections"]');
          }
          if (existingSections) {
            existingSections.innerHTML = renderLiveSectionsHtml();
          }
          mountOrUpdateMesh(existingHost);
          return;
        }

        unmountMesh();
        if (st.stage === 'canvas') {
          refs.stageBody.innerHTML = renderCanvasStage();
        } else if (st.stage === 'context') {
          refs.stageBody.innerHTML = renderContextStageHtml();
        } else {
          refs.stageBody.innerHTML = renderThreadStage();
        }
      }

      /* --------------------------------------------------------------------
         DOM EVENT WIRING
         -------------------------------------------------------------------- */

      function on(el, eventName, handler, opts) {
        if (!el || typeof el.addEventListener !== 'function') return;
        el.addEventListener(eventName, handler, opts);
        cleanups.push(() => {
          try {
            el.removeEventListener(eventName, handler, opts);
          } catch {
            // ignore
          }
        });
      }

      on(containerEl, 'click', (event) => {
        const target = event && event.target && typeof event.target.closest === 'function' ? event.target : null;
        if (!target) return;

        // 1. Copy code / diff / path buttons from KizukiBoardArtifacts
        const copyBtn = target.closest('[data-eb-copy-code], [data-eb-artifact-action="copyPath"]');
        if (copyBtn) {
          const artifactsMod = getBoardArtifacts();
          if (artifactsMod && typeof artifactsMod.copyCodeHandler === 'function') {
            artifactsMod.copyCodeHandler(copyBtn);
          }
          return;
        }

        // 2. Artifact doc pills
        const docArtifactBtn = target.closest('[data-eb-artifact-action="openDoc"]');
        if (docArtifactBtn) {
          const docTarget = docArtifactBtn.getAttribute('data-eb-artifact-target');
          if (docTarget) jumpToMindView('vault', docTarget, { kind: 'doc' });
          return;
        }

        // 3. Kizuki Mind Pills (.eb-mind-pill[data-eb-mind-view])
        const mindPill = target.closest('.eb-mind-pill[data-eb-mind-view]');
        if (mindPill) {
          playSound('click');
          const view = mindPill.getAttribute('data-eb-mind-view');
          const mindTarget = mindPill.getAttribute('data-eb-mind-target');
          const kind = mindPill.getAttribute('data-eb-mind-kind');
          jumpToMindView(view, mindTarget, { kind });
          return;
        }

        // 4. Colored inline Agent Mention Chips (.eb-mention-chip[data-eb-mention-filter] / .eb-run-seat)
        const mentionFilterBtn = target.closest('[data-eb-mention-filter]');
        if (mentionFilterBtn) {
          toggleAgentFilter(mentionFilterBtn.getAttribute('data-eb-mention-filter'), Boolean(event.shiftKey));
          return;
        }

        // 5. Cross-thread references & Reply preview strips ([data-eb-open-thread])
        const openThreadBtn = target.closest('[data-eb-open-thread]');
        if (openThreadBtn) {
          const tid = openThreadBtn.getAttribute('data-eb-open-thread');
          if (tid) openThreadInspector(tid, { switchMobile: true });
          return;
        }

        // 6. Signal / All / Telemetry ribbon & rollup button
        const streamFilterBtn = target.closest('[data-eb-stream-filter]');
        if (streamFilterBtn) {
          const nextFilter = streamFilterBtn.getAttribute('data-eb-stream-filter');
          if (nextFilter) setSignalFilter(nextFilter);
          return;
        }

        // 7. Spatial Command Mode dock icon & live header toggle
        const spatialBtn = target.closest('[data-eb-action="spatial-command"]');
        if (spatialBtn) {
          playSound('click');
          toggleSpatialCommandMode();
          return;
        }

        const mobileBtn = target.closest('.eb-mobile-pane-btn[data-mobile-pane]');
        if (mobileBtn) {
          setMobilePane(mobileBtn.getAttribute('data-mobile-pane'));
          return;
        }

        const modeBtn = target.closest('[data-eb-mode]');
        if (modeBtn) {
          setMode(modeBtn.getAttribute('data-eb-mode'));
          return;
        }

        const dockAgent = target.closest('[data-agent-handle]');
        if (dockAgent) {
          toggleAgentFilter(dockAgent.getAttribute('data-agent-handle'), Boolean(event.shiftKey));
          return;
        }

        if (target.closest('[data-eb-ref="room-trigger"]')) {
          playSound('click');
          roomPopup.toggle();
          return;
        }

        const groupBtn = target.closest('[data-room-group]');
        if (groupBtn) {
          store.set({ roomGroup: groupBtn.getAttribute('data-room-group') || '' });
          renderRoomPopover();
          roomSelection.setActiveIndex(0, { scroll: false });
          return;
        }

        const roomOpt = target.closest('[data-room-path]');
        if (roomOpt) {
          selectRoom(roomOpt.getAttribute('data-room-path'));
          return;
        }

        if (target.closest('[data-eb-ref="new-thread-btn"]')) {
          startNewThreadInRoom();
          return;
        }

        if (target.closest('[data-eb-ref="composer-at-btn"]')) {
          playSound('click');
          store.set({ mentionQuery: '', mentionRange: null });
          mentionPopup.toggle();
          return;
        }

        const mentionOpt = target.closest('[data-mention-actor]');
        if (mentionOpt) {
          insertMentionHandle(mentionOpt.getAttribute('data-mention-actor'));
          return;
        }

        if (target.closest('[data-eb-ref="send-btn"]')) {
          submitComposer();
          return;
        }

        if (target.closest('[data-eb-ref="jump-latest"]')) {
          playSound('click');
          if (refs.feedScroll) {
            refs.feedScroll.scrollTop = refs.feedScroll.scrollHeight;
          }
          store.set({ showJumpLatest: false });
          if (refs.jumpLatestBtn) refs.jumpLatestBtn.hidden = true;
          return;
        }

        const stageTab = target.closest('.eb-stage-tab[data-stage]');
        if (stageTab) {
          setStage(stageTab.getAttribute('data-stage'));
          return;
        }

        const inlineMention = target.closest('.eb-mention-tag[data-mention]');
        if (inlineMention) {
          insertMentionHandle(inlineMention.getAttribute('data-mention'));
          return;
        }

        const actionEl = target.closest('[data-action]');
        if (actionEl) {
          const action = actionEl.getAttribute('data-action');
          const threadId = actionEl.getAttribute('data-thread-id');
          const isPaused = actionEl.getAttribute('data-paused') === '1';

          if (action === 'toggle-expand-log') {
            playSound('click');
            const wrap = actionEl.closest('.eb-collapsible-body');
            if (wrap) {
              const logKey =
                actionEl.getAttribute('data-eb-log-key') ||
                wrap.getAttribute('data-eb-log-key') ||
                '';
              const nextExpanded = !wrap.classList.contains('is-expanded');
              wrap.classList.toggle('is-expanded', nextExpanded);
              wrap.setAttribute('data-eb-expanded', nextExpanded ? 'true' : 'false');
              actionEl.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
              const panel = wrap.querySelector('.eb-collapsible-panel');
              if (panel) panel.setAttribute('aria-hidden', nextExpanded ? 'false' : 'true');
              const labelEl = actionEl.querySelector('.eb-collapsible-toggle-label');
              if (labelEl) labelEl.textContent = nextExpanded ? 'Collapse' : 'Expand full log';
              if (logKey) {
                if (nextExpanded) expandedLogIds.add(logKey);
                else expandedLogIds.delete(logKey);
              }
            }
            return;
          }
          if (action === 'open-tape-thread') {
            if (meshExpanded) setSpatialExpanded(false);
            if (threadId) openThreadInspector(threadId, { switchMobile: true });
            return;
          }
          if (action === 'refresh') {
            playSound('click');
            const st = store.get();
            fetchHealth();
            fetchRooms();
            fetchAgents();
            fetchBlockers();
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter });
            if (st.selectedThreadId) fetchThreadDetail(st.selectedThreadId, { silent: true });
            if (st.stage === 'canvas') fetchDecisions();
            if (st.stage === 'context') fetchThreadContext(st.selectedThreadId, resolveActiveThreadChannel());
            return;
          }
          if (action === 'reply') {
            focusComposerForReply(threadId, { paused: isPaused });
            openThreadInspector(threadId);
            return;
          }
          if (action === 'inspect') {
            openThreadInspector(threadId, { switchMobile: true });
            return;
          }
          if (action === 'resolve') {
            openThreadInspector(threadId);
            focusComposerForReply(threadId, {
              paused: isPaused,
              resumePaused: isPaused,
              prefill: isPaused ? 'Resuming and resolving: ' : 'Resolved: ',
            });
            return;
          }
          if (action === 'reply-unblock') {
            openThreadInspector(threadId);
            focusComposerForReply(threadId, { paused: true, resumePaused: true });
            return;
          }
          if (action === 'clear-reply-target') {
            startNewThreadInRoom();
            return;
          }
          if (action === 'clear-agent-filter') {
            const st = store.get();
            store.set({ agentFilter: '' });
            renderDock();
            renderHeader();
            if (st.stage === 'live') syncMeshData();
            fetchStream({
              mode: st.mode,
              channel: st.channel,
              agentFilter: '',
              signalFilter: st.signalFilter,
            });
            return;
          }
          if (action === 'mention-filtered') {
            insertMentionHandle(actionEl.getAttribute('data-handle'));
            return;
          }
          if (action === 'filter-actor') {
            toggleAgentFilter(actionEl.getAttribute('data-actor'), false);
            return;
          }
          if (action === 'open-room') {
            selectRoom(actionEl.getAttribute('data-room'));
            return;
          }
        }
      });

      on(containerEl, 'change', (event) => {
        const target = event && event.target;
        if (target && target.getAttribute && target.getAttribute('data-action') === 'toggle-resume') {
          store.set({ resumePaused: Boolean(target.checked) });
        }
      });

      // Room Switcher Search + Keyboard Selection
      on(refs.roomSearchInput, 'input', () => {
        store.set({ roomQuery: refs.roomSearchInput.value || '' });
        renderRoomPopover();
        roomSelection.setActiveIndex(0, { scroll: false });
      });

      on(refs.roomSearchInput, 'keydown', (event) => {
        if (!roomPopup.isOpen()) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          roomPopup.close({ reason: 'escape' });
          roomFocusRecovery.restore();
          return;
        }
        roomSelection.handleKeyDown(event);
      });

      on(refs.roomTrigger, 'keydown', (event) => {
        if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && !roomPopup.isOpen()) {
          event.preventDefault();
          roomPopup.open();
        }
      });

      // Composer Input: @mention Trigger + Enter/Cmd+Enter Send
      on(refs.composerInput, 'input', () => {
        store.set({ composerDraft: refs.composerInput.value || '' });
        syncComposerHeight();
        inspectMentionTriggerFromInput();
      });

      on(refs.composerInput, 'keydown', (event) => {
        if (composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen()) {
          return;
        }
        if (mentionPopup.isOpen()) {
          if (event.key === 'Escape') {
            event.preventDefault();
            mentionPopup.close({ reason: 'escape', restoreFocus: false });
            return;
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            mentionSelection.selectActive(event);
            return;
          }
          if (mentionSelection.handleKeyDown(event)) {
            return;
          }
        }

        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
          event.preventDefault();
          submitComposer();
        }
      });

      // Global Board Hotkey M: Jump straight into live & toggle Expanded Full-Stage Spatial Command Mode
      function isEditableTarget(el) {
        let cur = el;
        let depth = 0;
        while (cur && depth < 12) {
          depth += 1;
          const tag = typeof cur.tagName === 'string' ? cur.tagName.toUpperCase() : '';
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
          if (cur.isContentEditable === true) return true;
          if (typeof cur.getAttribute === 'function') {
            const ce = cur.getAttribute('contenteditable');
            if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
            const role = cur.getAttribute('role');
            if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
          }
          cur = cur.parentElement || cur.parentNode || null;
        }
        return false;
      }

      on(doc, 'keydown', (event) => {
        if (destroyed || !event || event.defaultPrevented || event.isComposing) return;
        if (!isBoardVisible()) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const key = String(event.key || '');
        if (key === 'Escape' && meshExpanded) {
          const popupOpen =
            roomPopup.isOpen() ||
            mentionPopup.isOpen() ||
            (composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen());
          if (!popupOpen) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            setSpatialExpanded(false);
          }
          return;
        }

        if (key !== 'm' && key !== 'M') return;
        const activeEl = doc ? doc.activeElement : null;
        if (isEditableTarget(event.target) || isEditableTarget(activeEl)) return;
        if (
          roomPopup.isOpen() ||
          mentionPopup.isOpen() ||
          (composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen())
        ) {
          return;
        }

        if (typeof event.preventDefault === 'function') event.preventDefault();
        playSound('click');
        toggleSpatialCommandMode();
      });

      // Scroll listener for floating jump-to-latest pill
      on(refs.feedScroll, 'scroll', () => {
        const el = refs.feedScroll;
        if (!el) return;
        const distFromBottom = (el.scrollHeight || 0) - (el.scrollTop || 0) - (el.clientHeight || 0);
        const shouldShow = distFromBottom > 120;
        if (shouldShow !== store.get().showJumpLatest) {
          store.set({ showJumpLatest: shouldShow });
          if (refs.jumpLatestBtn) refs.jumpLatestBtn.hidden = !shouldShow;
        }
      });

      // Initial render
      renderShellAttrs();
      renderDock();
      renderHeader();
      renderTelemetryRibbonSlot();
      renderComposerTarget();
      renderStage();

      return {
        async load(opts) {
          if (destroyed) return;
          const o = opts && typeof opts === 'object' ? opts : {};
          const patch = {};
          if (o.channel) {
            const cleanCh = String(o.channel).replace(/^#+/, '').trim();
            if (cleanCh) {
              patch.channel = cleanCh;
              patch.mode = cleanCh === 'box/taste' ? 'taste' : 'rooms';
            }
          }
          if (o.mode && (o.mode === 'rooms' || o.mode === 'feed' || o.mode === 'blockers' || o.mode === 'taste')) {
            patch.mode = o.mode;
            if (o.mode === 'taste') patch.channel = 'box/taste';
          }
          if (o.signalFilter && (o.signalFilter === 'signal' || o.signalFilter === 'all' || o.signalFilter === 'telemetry')) {
            patch.signalFilter = o.signalFilter;
          }
          if (o.stage && (o.stage === 'thread' || o.stage === 'canvas' || o.stage === 'context' || o.stage === 'live')) {
            patch.stage = o.stage;
          }
          if (o.threadId) {
            patch.selectedThreadId = String(o.threadId);
            patch.stage = o.stage || 'thread';
          }
          if (Object.keys(patch).length) store.set(patch);

          renderShellAttrs();
          renderDock();
          renderHeader();
          renderTelemetryRibbonSlot();
          renderComposerTarget();
          renderStage();

          const st = store.get();
          const tasks = [
            fetchHealth(),
            fetchRooms(),
            fetchAgents(),
            fetchBlockers(),
            fetchStream({ mode: st.mode, channel: st.channel, signalFilter: st.signalFilter }),
          ];
          if (st.selectedThreadId) {
            tasks.push(fetchThreadDetail(st.selectedThreadId));
          }
          if (st.stage === 'canvas') {
            tasks.push(fetchDecisions());
          } else if (st.stage === 'context') {
            tasks.push(fetchThreadContext(st.selectedThreadId, resolveActiveThreadChannel()));
          } else if (st.stage === 'live' && st.channel !== 'mission') {
            tasks.push(fetchMissionSnapshot());
          }
          connectSse();
          await Promise.allSettled(tasks);
        },

        destroy() {
          if (destroyed) return;
          destroyed = true;
          disconnectSse();
          unmountMesh();
          if (bannerTimer) {
            clearTimeout(bannerTimer);
            bannerTimer = null;
          }
          if (justArrivedClearTimer) {
            clearTimeout(justArrivedClearTimer);
            justArrivedClearTimer = null;
          }
          justArrivedIds.clear();
          while (cleanups.length) {
            const fn = cleanups.pop();
            try {
              if (typeof fn === 'function') fn();
            } catch {
              // ignore cleanup errors
            }
          }
          composerSdk = null;
          keyboardSdk = null;
          containerEl.innerHTML = '';
        },

        getState() {
          const st = store.get();
          return Object.assign({}, st, {
            roomPopoverOpen: roomPopup.isOpen(),
            mentionPopoverOpen: mentionPopup.isOpen(),
            composerSdkOpen: Boolean(composerSdk && typeof composerSdk.isOpen === 'function' && composerSdk.isOpen()),
            meshMounted: Boolean(meshInstance),
            meshExpanded,
            spatialExpanded: Boolean(meshExpanded && st.stage === 'live'),
            hostHistory: safeArray(st.hostHistory),
            pairTraffic:
              Array.isArray(st.pairTraffic) && st.pairTraffic.length
                ? st.pairTraffic
                : computePairTraffic(st),
            composerAttachments:
              composerSdk && typeof composerSdk.getAttachments === 'function'
                ? composerSdk.getAttachments()
                : [],
          });
        },
      };
    }

    function buildShellHtml() {
      return (
        `<div class="eb-shell" data-mode="rooms" data-stage="thread" data-mobile-pane="stream" data-spatial-expanded="false">` +
          `<aside class="eb-dock" aria-label="Agent Board Navigation">` +
            `<div class="eb-dock-top">` +
              `<button type="button" class="eb-dock-btn is-active" data-eb-mode="rooms" title="Rooms &amp; Mission Signal" aria-label="Rooms" aria-pressed="true">${ICONS.rooms}</button>` +
              `<button type="button" class="eb-dock-btn" data-eb-action="spatial-command" title="Spatial Command Mode (M)" aria-label="Spatial Command Mode" aria-pressed="false">${ICONS.feed}</button>` +
              `<button type="button" class="eb-dock-btn" data-eb-mode="blockers" title="Blockers" aria-label="Blockers" aria-pressed="false">${ICONS.blockers}<span class="eb-dock-badge" data-eb-ref="dock-blockers-badge" hidden></span></button>` +
              `<button type="button" class="eb-dock-btn" data-eb-mode="taste" title="Taste Board (box/taste)" aria-label="Taste Board" aria-pressed="false">${ICONS.taste}</button>` +
            `</div>` +
            `<div class="eb-dock-divider" aria-hidden="true"></div>` +
            `<div class="eb-dock-agents" aria-label="Live Agents"></div>` +
          `</aside>` +
          `<section class="eb-center-stage" aria-label="Multiplayer Stream">` +
            `<header class="eb-center-head">` +
              `<div class="eb-center-head-left">` +
                `<div class="eb-room-picker">` +
                  `<button type="button" class="eb-room-trigger" data-eb-ref="room-trigger" aria-haspopup="listbox" aria-expanded="false">` +
                    `<span class="eb-room-dot" data-eb-ref="room-trigger-dot" aria-hidden="true"></span>` +
                    `<span class="eb-room-hash" data-eb-ref="room-trigger-hash" hidden>#</span>` +
                    `<span class="eb-room-label" data-eb-ref="room-trigger-label">Mission Signal</span>` +
                    `${ICONS.chevronDown}` +
                  `</button>` +
                  `<div class="eb-room-popup" data-eb-ref="room-popup" role="dialog" aria-label="Switch Room" hidden>` +
                    `<div class="eb-room-search-wrap">` +
                      `<input type="search" class="eb-room-search" data-eb-ref="room-search" placeholder="Search Mission Signal or 101+ rooms..." autocomplete="off">` +
                    `</div>` +
                    `<div class="eb-room-groups" data-eb-ref="room-groups"></div>` +
                    `<div class="eb-room-list" data-eb-ref="room-list" role="listbox" aria-label="Rooms"></div>` +
                  `</div>` +
                `</div>` +
                `<button type="button" class="eb-new-thread-btn" data-eb-ref="new-thread-btn" title="New thread in current room" aria-label="New thread">${ICONS.plus}</button>` +
              `</div>` +
              `<div class="eb-center-head-right" data-eb-ref="center-head-right"></div>` +
            `</header>` +
            `<div class="eb-telemetry-ribbon-slot" data-eb-ref="telemetry-ribbon-slot"></div>` +
            `<div class="eb-feed-scroll" data-eb-ref="feed-scroll"></div>` +
            `<div class="eb-composer-wrap">` +
              `<button type="button" class="eb-jump-latest" data-eb-ref="jump-latest" title="Jump to latest" aria-label="Jump to latest" hidden>${ICONS.arrowDown}</button>` +
              `<div class="eb-mention-popup" data-eb-ref="mention-popup" role="listbox" aria-label="Mention agent" hidden>` +
                `<div class="eb-mention-header">Mention agent</div>` +
                `<div class="eb-mention-list" data-eb-ref="mention-list"></div>` +
              `</div>` +
              `<div class="eb-slash-popup" data-eb-ref="slash-popup" hidden></div>` +
              `<div class="eb-context-popup" data-eb-ref="context-popup" hidden></div>` +
              `<div class="eb-composer">` +
                `<div class="eb-composer-attachments" data-eb-ref="composer-attachments" hidden></div>` +
                `<textarea class="eb-composer-input" data-eb-ref="composer-input" rows="2" placeholder="Message #box (/command, @mention, [[context]])..."></textarea>` +
                `<div class="eb-composer-bar">` +
                  `<div class="eb-composer-left">` +
                    `<button type="button" class="eb-mention-btn" data-eb-ref="composer-at-btn" title="Mention agent (@)" aria-label="Mention agent" aria-haspopup="listbox" aria-expanded="false">@</button>` +
                    `<button type="button" class="eb-composer-trigger-btn" data-eb-ref="composer-slash-btn" title="Slash commands (/)" aria-label="Slash commands" aria-haspopup="listbox" aria-expanded="false">/</button>` +
                    `<button type="button" class="eb-composer-trigger-btn" data-eb-ref="composer-context-btn" title="Attach Kizuki Mind context ([[)" aria-label="Attach Kizuki context" aria-haspopup="listbox" aria-expanded="false">[[</button>` +
                    `<span data-eb-ref="composer-target-slot"></span>` +
                  `</div>` +
                  `<div class="eb-composer-right">` +
                    `<span class="eb-composer-hint">Enter send</span>` +
                    `<button type="button" class="eb-send-btn" data-eb-ref="send-btn" title="Send message" aria-label="Send message">${ICONS.arrowUp}</button>` +
                  `</div>` +
                `</div>` +
              `</div>` +
              `<div class="eb-error-banner" data-eb-ref="inline-banner" role="status" aria-live="polite" style="margin-top:6px;pointer-events:auto;" hidden></div>` +
            `</div>` +
          `</section>` +
          `<aside class="eb-right-stage" aria-label="Live Stage">` +
            `<header class="eb-stage-head">` +
              `<div class="eb-stage-tabs" data-eb-ref="stage-tabs" role="tablist" aria-label="Stage view">` +
                `<button type="button" class="eb-stage-tab is-active" role="tab" data-stage="thread" aria-selected="true">Thread</button>` +
                `<button type="button" class="eb-stage-tab" role="tab" data-stage="canvas" aria-selected="false">Canvas</button>` +
                `<button type="button" class="eb-stage-tab" role="tab" data-stage="context" aria-selected="false">Context</button>` +
                `<button type="button" class="eb-stage-tab" role="tab" data-stage="live" aria-selected="false"><span class="eb-live-dot" aria-hidden="true"></span> live</button>` +
              `</div>` +
              `<div class="eb-stage-actions">` +
                `<div class="eb-mobile-pane-toggle" role="group" aria-label="Back to stream">` +
                  `<button type="button" class="eb-mobile-pane-btn" data-mobile-pane="stream" aria-pressed="false">Stream</button>` +
                `</div>` +
                `<button type="button" class="eb-icon-btn" data-action="refresh" title="Refresh stage" aria-label="Refresh stage">${ICONS.refresh}</button>` +
              `</div>` +
            `</header>` +
            `<div class="eb-stage-body" data-eb-ref="stage-body"></div>` +
          `</aside>` +
        `</div>`
      );
    }

    function mount(containerEl, hostHooks) {
      if (!containerEl) {
        throw new Error('KizukiAgentBoardView.mount requires a container element');
      }
      if (activeInstance) {
        activeInstance.destroy();
        activeInstance = null;
      }
      activeInstance = createController(containerEl, hostHooks);
      return activeInstance;
    }

    function load(opts) {
      if (!activeInstance) return Promise.resolve();
      return activeInstance.load(opts);
    }

    function destroy() {
      if (activeInstance) {
        activeInstance.destroy();
        activeInstance = null;
      }
    }

    function getState() {
      return activeInstance ? activeInstance.getState() : null;
    }

    return {
      mount,
      load,
      destroy,
      unmount: destroy,
      getState,
    };
  }
);
