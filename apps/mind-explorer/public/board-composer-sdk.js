/* ==========================================================================
   KIZUKI MIND EXPLORER - BOARD COMPOSER & KEYBOARD SDK (@ui-sdk/core)
   Powered by window.KizukiUiSdk (createStore, createPopup, createTypeahead,
   createSelection, createFocusRecovery, createDismissable).

   Exports: window.KizukiBoardComposerSdk (and module.exports in CommonJS)
   Controllers:
     1. attachComposerPlugins(...) - Slash Command Palette (/) +
        Kizuki Mind Context Picker ([[) + Removable Context Chips
     2. attachBoardKeyboard(...)   - Scoped Board Navigation & Stage Hotkeys
   ========================================================================== */
(function initKizukiBoardComposerSdk(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiBoardComposerSdk = api;
  }
  if (typeof window !== 'undefined' && window !== root) {
    window.KizukiBoardComposerSdk = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function createKizukiBoardComposerSdk(root) {
    'use strict';

    const STYLE_TAG_ID = 'kizuki-board-composer-sdk-styles';
    const DEFAULT_DEBOUNCE_MS = 140;
    const MAX_CACHE_ENTRIES = 64;
    const MAX_RECENT_ITEMS = 12;

    /* ------------------------------------------------------------------------
       Utilities
       ------------------------------------------------------------------------ */

    function stripEmDash(value) {
      return String(value == null ? '' : value).replace(/\u2014/g, '-');
    }

    function getUiSdk() {
      if (typeof window !== 'undefined' && window.KizukiUiSdk) {
        return window.KizukiUiSdk;
      }
      if (root && root.KizukiUiSdk) {
        return root.KizukiUiSdk;
      }
      if (typeof globalThis !== 'undefined' && globalThis.KizukiUiSdk) {
        return globalThis.KizukiUiSdk;
      }
      return null;
    }

    function getDocument(el) {
      if (el && el.ownerDocument) return el.ownerDocument;
      if (typeof document !== 'undefined') return document;
      if (root && root.document) return root.document;
      return null;
    }

    function getWindow(doc, el) {
      const d = doc || getDocument(el);
      if (d && d.defaultView) return d.defaultView;
      if (typeof window !== 'undefined') return window;
      if (root && root.window) return root.window;
      return root || null;
    }

    function playSound(kind) {
      try {
        const win = getWindow();
        const sound =
          (win && win.KizukiSound) ||
          (root && root.KizukiSound) ||
          (typeof globalThis !== 'undefined' && globalThis.KizukiSound) ||
          null;
        if (sound && typeof sound[kind] === 'function') {
          sound[kind]();
        }
      } catch (_err) {
        // Sound is optional telemetry feedback
      }
    }

    function addListener(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return function noop() {};
      }
      target.addEventListener(type, handler, options);
      let active = true;
      return function remove() {
        if (!active) return;
        active = false;
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, handler, options);
        }
      };
    }

    function clearChildren(el) {
      if (!el) return;
      if (typeof el.removeChild === 'function') {
        while (el.firstChild) {
          el.removeChild(el.firstChild);
        }
      } else {
        el.textContent = '';
      }
    }

    function createEl(doc, tag, className, text) {
      if (!doc || typeof doc.createElement !== 'function') return null;
      const node = doc.createElement(tag);
      if (className) {
        if (typeof node.className === 'string' || 'className' in node) {
          node.className = className;
        } else if (typeof node.setAttribute === 'function') {
          node.setAttribute('class', className);
        }
      }
      if (text !== undefined && text !== null) {
        node.textContent = stripEmDash(text);
      }
      return node;
    }

    function appendHighlightedText(doc, parent, text, ranges, splitFn) {
      const clean = stripEmDash(text);
      if (!doc || !parent) return;
      if (!ranges || ranges.length === 0) {
        parent.textContent = clean;
        return;
      }
      const parts =
        typeof splitFn === 'function'
          ? splitFn(clean, ranges)
          : [{ text: clean, matched: false }];
      clearChildren(parent);
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!part || !part.text) continue;
        if (part.matched) {
          const mark = createEl(doc, 'mark', 'eb-sdk-match', part.text);
          if (mark) parent.appendChild(mark);
        } else if (typeof doc.createTextNode === 'function') {
          parent.appendChild(doc.createTextNode(part.text));
        } else {
          const span = createEl(doc, 'span', '', part.text);
          if (span) parent.appendChild(span);
        }
      }
    }

    function focusElement(el, caretPos) {
      if (!el) return;
      try {
        if (typeof el.focus === 'function') {
          el.focus({ preventScroll: true });
        }
      } catch (_err) {
        try {
          if (typeof el.focus === 'function') el.focus();
        } catch (_err2) {
          // Ignore focus failures on detached nodes
        }
      }
      if (typeof caretPos === 'number' && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(caretPos, caretPos);
        } catch (_err3) {
          // Ignore range failures
        }
      }
    }

    function dispatchInputEvent(el, doc) {
      if (!el || typeof el.dispatchEvent !== 'function') return;
      try {
        const win = getWindow(doc, el);
        if (win && typeof win.Event === 'function') {
          el.dispatchEvent(new win.Event('input', { bubbles: true }));
          return;
        }
        if (typeof Event === 'function') {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (_err) {
        // Ignore synthetic Event construction errors in minimal mocks
      }
    }

    function ensureStylesInjected(doc) {
      if (!doc || !doc.head || typeof doc.getElementById !== 'function') return;
      if (doc.getElementById(STYLE_TAG_ID)) return;
      const style = createEl(doc, 'style');
      if (!style) return;
      style.id = STYLE_TAG_ID;
      style.textContent = [
        '.eb-sdk-popup{position:fixed;bottom:auto;right:auto;z-index:60;width:min(380px,calc(100vw - 24px));border-radius:14px;background:var(--eb-popover-bg,rgba(22,22,26,0.96));border:1px solid var(--eb-border-strong,rgba(255,255,255,0.14));box-shadow:var(--eb-shadow-popover,0 16px 40px rgba(0,0,0,0.44));backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);padding:6px;pointer-events:auto;color:var(--ink-primary,#f3f4f6);}',
        '.eb-sdk-popup[hidden]{display:none;}',
        '.eb-sdk-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 6px;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-muted,#8e929b);}',
        '.eb-sdk-popup-list{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;}',
        '.eb-sdk-option{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--ink-secondary,#cbd5e1);text-align:left;cursor:pointer;font-family:var(--font-sans,system-ui,sans-serif);transition:background-color 110ms ease,border-color 110ms ease,color 110ms ease;}',
        '.eb-sdk-option:hover,.eb-sdk-option[data-active="true"]{background:var(--eb-pill-hover,rgba(255,255,255,0.08));color:var(--ink-primary,#f8fafc);}',
        '.eb-sdk-option[data-active="true"]{border-color:var(--eb-border,rgba(255,255,255,0.12));}',
        '.eb-sdk-option-main{display:flex;flex-direction:column;min-width:0;flex:1 1 auto;gap:1px;}',
        '.eb-sdk-option-top{display:flex;align-items:center;gap:6px;min-width:0;}',
        '.eb-sdk-cmd-name{font-family:var(--font-mono,ui-monospace,monospace);font-size:12.5px;font-weight:600;color:var(--ink-primary,#f8fafc);white-space:nowrap;}',
        '.eb-sdk-cmd-args{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--ink-muted,#8e929b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.eb-sdk-option-desc{font-size:11.5px;color:var(--ink-muted,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.eb-sdk-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;padding:2px 6px;border-radius:6px;font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;font-weight:600;letter-spacing:0.03em;text-transform:uppercase;border:1px solid var(--eb-border,rgba(255,255,255,0.12));background:rgba(255,255,255,0.05);color:var(--ink-secondary,#cbd5e1);}',
        '.eb-sdk-badge[data-kind="person"]{color:#93c5fd;border-color:rgba(147,197,253,0.28);background:rgba(59,130,246,0.12);}',
        '.eb-sdk-badge[data-kind="doc"]{color:#86efac;border-color:rgba(134,239,172,0.28);background:rgba(34,197,94,0.12);}',
        '.eb-sdk-badge[data-kind="codex"]{color:#fcd34d;border-color:rgba(252,211,77,0.28);background:rgba(245,158,11,0.12);}',
        '.eb-sdk-badge[data-kind="taste"]{color:#f9a8d4;border-color:rgba(249,168,212,0.28);background:rgba(236,72,153,0.12);}',
        '.eb-sdk-badge[data-kind="immediate"]{color:#67e8f9;border-color:rgba(103,232,249,0.28);background:rgba(6,182,212,0.12);}',
        '.eb-sdk-match{background:rgba(250,204,21,0.24);color:inherit;border-radius:3px;padding:0 1px;}',
        '.eb-sdk-empty{padding:12px 10px;font-size:12px;color:var(--ink-muted,#94a3b8);text-align:center;}',
        '.eb-sdk-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}',
        '.eb-sdk-chips[hidden]{display:none;}',
        '.eb-sdk-chip{display:inline-flex;align-items:center;gap:6px;max-width:260px;height:26px;padding:0 6px 0 8px;border-radius:999px;border:1px solid var(--eb-border-strong,rgba(255,255,255,0.14));background:var(--eb-pill-hover,rgba(255,255,255,0.06));color:var(--ink-primary,#f8fafc);font-size:11.5px;line-height:1;}',
        '.eb-sdk-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;}',
        '.eb-sdk-chip-remove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--ink-muted,#94a3b8);cursor:pointer;font-size:12px;line-height:1;}',
        '.eb-sdk-chip-remove:hover{background:rgba(255,255,255,0.12);color:var(--ink-primary,#fff);}',
      ].join('\n');
      try {
        doc.head.appendChild(style);
      } catch (_err) {
        // Ignore in minimal mock DOMs
      }
    }

    /* ------------------------------------------------------------------------
       Built-In High-Leverage Slash Commands
       ------------------------------------------------------------------------ */

    const SLASH_COMMANDS = Object.freeze([
      Object.freeze({
        name: 'decide',
        command: '/decide',
        usage: '/decide <question>',
        argHint: '<question>',
        requiresArgs: true,
        immediate: false,
        category: 'governance',
        description: 'Post formatted owner decision card to #kizuki/decisions or active room',
        keywords: Object.freeze(['decision', 'owner', 'card', 'vote', 'approve', 'kizuki/decisions']),
      }),
      Object.freeze({
        name: 'task',
        command: '/task',
        usage: '/task @agent <goal>',
        argHint: '@agent <goal>',
        requiresArgs: true,
        immediate: false,
        category: 'dispatch',
        description: 'Dispatch structured task with goal and verification prompt',
        keywords: Object.freeze(['assign', 'agent', 'goal', 'dispatch', 'work', 'verify']),
      }),
      Object.freeze({
        name: 'unblock',
        command: '/unblock',
        usage: '/unblock <note>',
        argHint: '<note>',
        requiresArgs: true,
        immediate: false,
        category: 'flow',
        description: 'Reply to selected paused/blocked thread with resumePaused: true',
        keywords: Object.freeze(['resume', 'paused', 'blocked', 'reply', 'continue']),
      }),
      Object.freeze({
        name: 'brief',
        command: '/brief',
        usage: '/brief',
        argHint: '',
        requiresArgs: false,
        immediate: true,
        category: 'intel',
        description: 'Run Local LLM (:8003) Executive Brief on current thread or room immediately',
        keywords: Object.freeze(['summary', 'synthesize', 'local-llm', 'g4', '8003', 'executive', 'tldr']),
      }),
      Object.freeze({
        name: 'promote',
        command: '/promote',
        usage: '/promote <ideas|actions|philosophies>',
        argHint: '<ideas|actions|philosophies>',
        requiresArgs: true,
        immediate: false,
        category: 'codex',
        description: 'Promote selected thread directly into Kizuki Codex',
        keywords: Object.freeze(['codex', 'ideas', 'actions', 'philosophies', 'save', 'canon']),
      }),
      Object.freeze({
        name: 'taste',
        command: '/taste',
        usage: '/taste <rule>',
        argHint: '<rule>',
        requiresArgs: true,
        immediate: false,
        category: 'taste',
        description: 'Broadcast a Taste preference rule straight to #box/taste',
        keywords: Object.freeze(['preference', 'rule', 'box/taste', 'style', 'verdict', 'aesthetic']),
      }),
      Object.freeze({
        name: 'signal',
        command: '/signal',
        usage: '/signal',
        argHint: '',
        requiresArgs: false,
        immediate: true,
        category: 'filter',
        description: 'Toggle Signal vs All telemetry filter',
        keywords: Object.freeze(['filter', 'telemetry', 'noise', 'all', 'toggle']),
      }),
      Object.freeze({
        name: 'mesh',
        command: '/mesh',
        usage: '/mesh',
        argHint: '',
        requiresArgs: false,
        immediate: true,
        category: 'stage',
        description: 'Jump straight to live Spatial Agent Mesh view',
        keywords: Object.freeze(['live', 'spatial', 'agent', 'stage', 'graph', 'network']),
      }),
    ]);

    const SLASH_COMMAND_MAP = Object.create(null);
    for (let i = 0; i < SLASH_COMMANDS.length; i += 1) {
      SLASH_COMMAND_MAP[SLASH_COMMANDS[i].name] = SLASH_COMMANDS[i];
    }

    function normalizePromoteSection(rawArgs) {
      const token = String(rawArgs || '').trim().toLowerCase().split(/\s+/)[0] || '';
      if (!token) return { section: 'ideas', valid: false };
      if (token === 'ideas' || token === 'idea') return { section: 'ideas', valid: true };
      if (token === 'actions' || token === 'action') return { section: 'actions', valid: true };
      if (token === 'philosophies' || token === 'philosophy' || token === 'phil') {
        return { section: 'philosophies', valid: true };
      }
      return { section: 'ideas', valid: false };
    }

    function parseSlashCommand(rawText, context) {
      const text = stripEmDash(rawText).trim();
      if (!text || text.charAt(0) !== '/') return null;

      const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) return null;

      const name = match[1].toLowerCase();
      const def = SLASH_COMMAND_MAP[name];
      if (!def) return null;

      const args = stripEmDash(match[2] || '').trim();
      const ctx = context && typeof context === 'object' ? context : {};
      const room = ctx.room ? String(ctx.room) : '';
      const thread = ctx.thread || null;
      const threadId = thread
        ? String(thread.id || thread.threadId || thread.thread_id || '')
        : '';

      const base = {
        command: def.name,
        raw: text,
        args,
        definition: def,
        room,
        thread,
        threadId: threadId || null,
      };

      if (def.name === 'decide') {
        const question = args;
        return Object.assign(base, {
          question,
          targetRoom: room || 'kizuki/decisions',
          recommendedRoom: 'kizuki/decisions',
          formattedBody: question
            ? [
                '**Owner Decision**',
                '',
                question,
                '',
                '- [ ] Approve',
                '- [ ] Revise',
                '- [ ] Hold',
              ].join('\n')
            : '',
        });
      }

      if (def.name === 'task') {
        const taskMatch = /^@([a-zA-Z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(args);
        const agent = taskMatch ? taskMatch[1] : '';
        const goal = taskMatch ? String(taskMatch[2] || '').trim() : args;
        const prefix = agent ? '@' + agent + ' ' : '';
        return Object.assign(base, {
          agent: agent || null,
          goal,
          formattedBody: goal
            ? [
                prefix + '[Task]',
                'Goal: ' + goal,
                'Verification: Attach concrete command output or rendered proof before marking done.',
              ].join('\n')
            : '',
        });
      }

      if (def.name === 'unblock') {
        return Object.assign(base, {
          note: args,
          resumePaused: true,
        });
      }

      if (def.name === 'brief') {
        return Object.assign(base, {
          target: threadId ? 'thread' : 'room',
          endpoint: ':8003',
        });
      }

      if (def.name === 'promote') {
        const parsed = normalizePromoteSection(args);
        const note = args
          .replace(/^(ideas?|actions?|philosoph(?:y|ies)|phil)\b\s*/i, '')
          .trim();
        return Object.assign(base, {
          section: parsed.section,
          validSection: parsed.valid,
          note,
        });
      }

      if (def.name === 'taste') {
        return Object.assign(base, {
          rule: args,
          targetRoom: 'box/taste',
        });
      }

      if (def.name === 'signal') {
        return Object.assign(base, {
          action: 'toggle-signal',
        });
      }

      if (def.name === 'mesh') {
        return Object.assign(base, {
          stage: 'live',
        });
      }

      return base;
    }

    /* ------------------------------------------------------------------------
       Kizuki Mind Context Normalization & Provenance Helpers
       ------------------------------------------------------------------------ */

    const CONTEXT_KIND_LABELS = Object.freeze({
      person: 'Person',
      doc: 'Vault Doc',
      codex: 'Codex',
      taste: 'Taste',
    });

    const DEFAULT_RECENT_CONTEXTS = Object.freeze([
      Object.freeze({
        kind: 'doc',
        id: 'doc:world/taste-codex.md',
        label: 'Taste Codex',
        target: 'world/taste-codex.md',
        subtitle: 'Vault doctrine and design taste ledger',
      }),
      Object.freeze({
        kind: 'codex',
        id: 'codex:ideas/active-priorities',
        label: 'Active Priorities',
        target: 'ideas/active-priorities',
        subtitle: 'Kizuki Codex ideas and strategic bets',
      }),
      Object.freeze({
        kind: 'taste',
        id: 'taste:zero-ai-slop',
        label: 'Zero AI slop and em-dash ban',
        target: 'box/taste#zero-ai-slop',
        subtitle: 'Taste preference rule',
      }),
      Object.freeze({
        kind: 'person',
        id: 'person:Owner',
        label: 'Owner',
        target: 'Owner',
        subtitle: 'Owner context and decision authority',
      }),
    ]);

    function normalizeContextKind(rawKind) {
      const k = String(rawKind || '').trim().toLowerCase();
      if (k === 'person' || k === 'people' || k === 'contact') return 'person';
      if (k === 'doc' || k === 'docs' || k === 'vault' || k === 'note' || k === 'file') return 'doc';
      if (k === 'codex' || k === 'idea' || k === 'action' || k === 'philosophy') return 'codex';
      if (k === 'taste' || k === 'rule' || k === 'memt' || k === 'preference') return 'taste';
      return 'doc';
    }

    function formatInlineToken(item) {
      if (!item || typeof item !== 'object') return '';
      const kind = normalizeContextKind(item.kind);
      const target = stripEmDash(item.target || item.path || item.label || item.id || '').trim();
      if (!target) return '';
      return '[[' + kind + ':' + target + ']]';
    }

    function formatSingleProvenance(item) {
      if (!item || typeof item !== 'object') return '';
      const kind = normalizeContextKind(item.kind);
      const label = stripEmDash(item.label || item.title || item.name || item.target || '').trim();
      const target = stripEmDash(item.target || item.path || item.id || label).trim();
      if (!label && !target) return '';
      return '[Kizuki ' + kind + ': ' + (label || target) + ' (' + (target || label) + ')]';
    }

    function formatAttachmentProvenance(attachments) {
      if (!Array.isArray(attachments) || attachments.length === 0) return '';
      const lines = [];
      for (let i = 0; i < attachments.length; i += 1) {
        const line = formatSingleProvenance(attachments[i]);
        if (line) lines.push(line);
      }
      return lines.join('\n');
    }

    function normalizeContextItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const kind = normalizeContextKind(raw.kind || raw.type || raw.category);
      const label = stripEmDash(
        raw.label || raw.title || raw.name || raw.display_name || raw.recommendation || raw.path || raw.target || ''
      ).trim();
      const target = stripEmDash(
        raw.target || raw.path || raw.handle || raw.slug || raw.id || label
      ).trim();
      if (!label && !target) return null;

      const finalLabel = label || target;
      const finalTarget = target || label;
      const key = kind + ':' + finalTarget.toLowerCase();
      const subtitle = stripEmDash(
        raw.subtitle || raw.role || raw.org || raw.domain || raw.category || raw.excerpt || raw.condition || ''
      ).trim();

      const item = {
        key,
        id: raw.id ? String(raw.id) : key,
        kind,
        categoryLabel: CONTEXT_KIND_LABELS[kind] || 'Context',
        label: finalLabel,
        target: finalTarget,
        subtitle,
      };
      item.token = formatInlineToken(item);
      item.provenance = formatSingleProvenance(item);
      return item;
    }

    function extractOmniSearchItems(data) {
      if (!data || typeof data !== 'object') return [];
      const groups = data.groups && typeof data.groups === 'object' ? data.groups : data;
      const out = [];
      const seen = Object.create(null);

      function pushItem(raw) {
        const norm = normalizeContextItem(raw);
        if (!norm || seen[norm.key]) return;
        seen[norm.key] = true;
        out.push(norm);
      }

      const people = Array.isArray(groups.people) ? groups.people : [];
      for (let i = 0; i < people.length; i += 1) {
        const p = people[i];
        if (!p || typeof p !== 'object') continue;
        const name = p.name || p.display_name || p.label || p.handle || '';
        pushItem({
          kind: 'person',
          id: p.id || ('person:' + name),
          label: name,
          target: name || p.handle || p.id,
          subtitle: p.role || p.company || p.org || p.email || p.summary || 'Person',
        });
      }

      const docs = Array.isArray(groups.docs) ? groups.docs : [];
      for (let i = 0; i < docs.length; i += 1) {
        const d = docs[i];
        if (!d || typeof d !== 'object') continue;
        pushItem({
          kind: 'doc',
          id: d.path || d.id,
          label: d.title || d.path || d.id,
          target: d.path || d.id || d.title,
          subtitle: d.path || d.category || d.excerpt || 'Vault Doc',
        });
      }

      const codex = Array.isArray(groups.codex)
        ? groups.codex
        : Array.isArray(data.codex)
          ? data.codex
          : [];
      for (let i = 0; i < codex.length; i += 1) {
        const c = codex[i];
        if (!c || typeof c !== 'object') continue;
        const sec = c.section ? String(c.section) + '/' : '';
        pushItem({
          kind: 'codex',
          id: c.id || (sec + (c.title || '')),
          label: c.title || c.label || c.id,
          target: c.target || (sec + (c.id || c.title || '')),
          subtitle: c.subtitle || c.domain || c.section || 'Codex Item',
        });
      }

      const taste = Array.isArray(groups.taste)
        ? groups.taste
        : Array.isArray(data.taste)
          ? data.taste
          : [];
      for (let i = 0; i < taste.length; i += 1) {
        const t = taste[i];
        if (!t || typeof t !== 'object') continue;
        pushItem({
          kind: 'taste',
          id: t.id || t.key || ('taste:' + i),
          label: t.rule || t.title || t.label || t.recommendation || t.text || '',
          target: t.target || t.id || ('box/taste#' + (t.slug || i)),
          subtitle: t.domain || t.category || t.condition || 'Taste Rule',
        });
      }

      const memt = Array.isArray(groups.memt) ? groups.memt : [];
      for (let i = 0; i < memt.length; i += 1) {
        const m = memt[i];
        if (!m || typeof m !== 'object') continue;
        pushItem({
          kind: 'taste',
          id: m.id || ('memt:' + i),
          label: m.recommendation || m.condition || m.label || '',
          target: m.target || ('taste/' + (m.id || m.domain || i)),
          subtitle: (m.domain ? m.domain + ': ' : '') + (m.condition || 'Taste Rule'),
        });
      }

      return out;
    }

    /* ------------------------------------------------------------------------
       Local Safe Primitives Adapter (direct delegation to window.KizukiUiSdk)
       ------------------------------------------------------------------------ */

    function requireSdkPrimitives() {
      const sdk = getUiSdk();
      if (!sdk) {
        throw new Error('KizukiBoardComposerSdk requires window.KizukiUiSdk (ui-sdk-core.js)');
      }
      return sdk;
    }

    /* ------------------------------------------------------------------------
       1. attachComposerPlugins(options)
       ------------------------------------------------------------------------ */

    function attachComposerPlugins(options) {
      const opts = options && typeof options === 'object' ? options : {};
      const textareaEl = opts.textareaEl || null;
      const slashPopupEl = opts.slashPopupEl || null;
      const contextPopupEl = opts.contextPopupEl || null;
      const attachmentsBarEl = opts.attachmentsBarEl || null;
      const slashTriggerEl = opts.slashTriggerEl || null;
      const contextTriggerEl = opts.contextTriggerEl || null;
      const getRoom = typeof opts.getRoom === 'function' ? opts.getRoom : function () { return ''; };
      const getThread = typeof opts.getThread === 'function' ? opts.getThread : function () { return null; };
      const onExecuteSlash = typeof opts.onExecuteSlash === 'function' ? opts.onExecuteSlash : null;
      const onAttachContext = typeof opts.onAttachContext === 'function' ? opts.onAttachContext : null;
      const onToast = typeof opts.onToast === 'function' ? opts.onToast : null;
      const insertMode = opts.insertMode || 'chip';
      const debounceMs = typeof opts.debounceMs === 'number' && opts.debounceMs >= 0
        ? opts.debounceMs
        : DEFAULT_DEBOUNCE_MS;

      const sdk = requireSdkPrimitives();
      const doc = getDocument(textareaEl || slashPopupEl || contextPopupEl || attachmentsBarEl);
      const win = getWindow(doc, textareaEl);
      ensureStylesInjected(doc);

      const cleanups = [];
      let destroyed = false;
      let suppressInputTrigger = false;
      let contextDebounceTimer = null;
      let contextRequestSeq = 0;
      let activeAbortController = null;

      const searchCache = new Map();
      const recentPool = [];
      const seedDefaults = Array.isArray(opts.recentDefaults) && opts.recentDefaults.length > 0
        ? opts.recentDefaults
        : DEFAULT_RECENT_CONTEXTS;
      for (let i = 0; i < seedDefaults.length; i += 1) {
        const norm = normalizeContextItem(seedDefaults[i]);
        if (norm) recentPool.push(norm);
      }

      let currentSlashResults = [];
      let currentSlashOptionEls = [];
      let currentContextCandidates = recentPool.slice();
      let currentContextResults = [];
      let currentContextOptionEls = [];

      const store = sdk.createStore({
        activePopup: 'none', // 'none' | 'slash' | 'context'
        slashQuery: '',
        slashRange: null,
        contextQuery: '',
        contextRange: null,
        contextLoading: false,
        contextError: '',
        attachments: [],
      });

      const focusRecovery = sdk.createFocusRecovery({
        doc,
        fallback: function () {
          return textareaEl;
        },
      });

      function emitToast(message, tone) {
        if (onToast) {
          onToast(stripEmDash(message), tone || 'info');
        }
      }

      function promoteRecentItem(item) {
        if (!item) return;
        for (let i = recentPool.length - 1; i >= 0; i -= 1) {
          if (recentPool[i].key === item.key) {
            recentPool.splice(i, 1);
          }
        }
        recentPool.unshift(item);
        if (recentPool.length > MAX_RECENT_ITEMS) {
          recentPool.length = MAX_RECENT_ITEMS;
        }
      }

      /* -- Slash Command Palette primitives -- */

      const slashTypeahead = sdk.createTypeahead({
        getItems: function () {
          return SLASH_COMMANDS;
        },
        getLabel: function (cmd) {
          return cmd.name;
        },
        getKeywords: function (cmd) {
          return [cmd.command, cmd.category, cmd.description].concat(cmd.keywords || []);
        },
      });

      const slashSelection = sdk.createSelection({
        getItems: function () {
          return currentSlashOptionEls;
        },
        loop: true,
        orientation: 'vertical',
        selectOnSpace: false,
        ariaTarget: textareaEl,
        idPrefix: 'kizuki-slash-opt',
        onSelect: function (_itemEl, idx, event) {
          const hit = currentSlashResults[idx];
          if (hit && hit.item) {
            handleSlashSelect(hit.item, event);
          }
        },
      });

      function getComposerAnchorEl(fallbackEl) {
        if (textareaEl && typeof textareaEl.closest === 'function') {
          const composerWrap = textareaEl.closest('.eb-composer');
          if (composerWrap) return composerWrap;
        }
        return textareaEl || fallbackEl || null;
      }

      function resetPopupPositionStyles(popupEl) {
        if (!popupEl || !popupEl.style) return;
        popupEl.style.bottom = 'auto';
        popupEl.style.right = 'auto';
      }

      resetPopupPositionStyles(slashPopupEl);
      resetPopupPositionStyles(contextPopupEl);

      const slashAnchorEl = getComposerAnchorEl(slashTriggerEl);
      const slashPopup = slashPopupEl
        ? sdk.createPopup({
            doc,
            triggerEl: slashAnchorEl,
            contentEl: slashPopupEl,
            placement: 'top-start',
            offset: 8,
            strategy: 'fixed',
            closeOnEscape: false,
            closeOnOutsideClick: false,
            restoreFocus: false,
            onOpenChange: function (isOpen) {
              if (isOpen) {
                resetPopupPositionStyles(slashPopupEl);
              }
              if (slashTriggerEl && typeof slashTriggerEl.setAttribute === 'function') {
                slashTriggerEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              }
            },
          })
        : null;

      const slashDismissable = slashPopupEl
        ? sdk.createDismissable({
            doc,
            el: slashPopupEl,
            ignoreEls: [textareaEl, slashTriggerEl].filter(Boolean),
            enabled: false,
            closeOnEscape: true,
            closeOnOutsideClick: true,
            onDismiss: function (reason) {
              closeSlash(reason, reason === 'escape');
            },
          })
        : null;

      if (slashPopupEl && typeof slashPopupEl.setAttribute === 'function') {
        slashPopupEl.setAttribute('role', 'listbox');
        slashPopupEl.setAttribute('aria-label', 'Slash commands');
        if (slashPopupEl.classList && typeof slashPopupEl.classList.add === 'function') {
          slashPopupEl.classList.add('eb-sdk-popup', 'eb-slash-popup');
        }
      }

      /* -- Kizuki Mind Context Picker primitives -- */

      const contextTypeahead = sdk.createTypeahead({
        getItems: function () {
          return currentContextCandidates;
        },
        getLabel: function (item) {
          return item.label;
        },
        getKeywords: function (item) {
          return [item.kind, item.categoryLabel, item.target, item.subtitle];
        },
        maxResults: 12,
      });

      const contextSelection = sdk.createSelection({
        getItems: function () {
          return currentContextOptionEls;
        },
        loop: true,
        orientation: 'vertical',
        selectOnSpace: false,
        ariaTarget: textareaEl,
        idPrefix: 'kizuki-ctx-opt',
        onSelect: function (_itemEl, idx, event) {
          const hit = currentContextResults[idx];
          if (hit && hit.item) {
            handleContextSelect(hit.item, event);
          }
        },
      });

      const contextAnchorEl = getComposerAnchorEl(contextTriggerEl);
      const contextPopup = contextPopupEl
        ? sdk.createPopup({
            doc,
            triggerEl: contextAnchorEl,
            contentEl: contextPopupEl,
            placement: 'top-start',
            offset: 8,
            strategy: 'fixed',
            closeOnEscape: false,
            closeOnOutsideClick: false,
            restoreFocus: false,
            onOpenChange: function (isOpen) {
              if (isOpen) {
                resetPopupPositionStyles(contextPopupEl);
              }
              if (contextTriggerEl && typeof contextTriggerEl.setAttribute === 'function') {
                contextTriggerEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              }
            },
          })
        : null;

      const contextDismissable = contextPopupEl
        ? sdk.createDismissable({
            doc,
            el: contextPopupEl,
            ignoreEls: [textareaEl, contextTriggerEl].filter(Boolean),
            enabled: false,
            closeOnEscape: true,
            closeOnOutsideClick: true,
            onDismiss: function (reason) {
              closeContext(reason, reason === 'escape');
            },
          })
        : null;

      if (contextPopupEl && typeof contextPopupEl.setAttribute === 'function') {
        contextPopupEl.setAttribute('role', 'listbox');
        contextPopupEl.setAttribute('aria-label', 'Kizuki Mind context picker');
        if (contextPopupEl.classList && typeof contextPopupEl.classList.add === 'function') {
          contextPopupEl.classList.add('eb-sdk-popup', 'eb-context-popup');
        }
      }

      if (attachmentsBarEl && attachmentsBarEl.classList && typeof attachmentsBarEl.classList.add === 'function') {
        attachmentsBarEl.classList.add('eb-sdk-chips', 'eb-attachments-bar');
      }

      /* -- Rendering: Slash Command Palette (zero innerHTML / zero XSS) -- */

      function renderSlashPopup() {
        if (!slashPopupEl || !doc) return;
        const st = store.get();
        const rawQuery = String(st.slashQuery || '').replace(/^\/+/, '');
        const hits = slashTypeahead.filter(rawQuery);
        currentSlashResults = hits;
        currentSlashOptionEls = [];

        clearChildren(slashPopupEl);

        const header = createEl(doc, 'div', 'eb-sdk-popup-head');
        const title = createEl(doc, 'span', '', 'Slash Commands');
        const hint = createEl(doc, 'span', '', 'Up/Down  Enter/Tab  Esc');
        if (header) {
          if (title) header.appendChild(title);
          if (hint) header.appendChild(hint);
          slashPopupEl.appendChild(header);
        }

        const list = createEl(doc, 'div', 'eb-sdk-popup-list');
        if (!list) return;

        if (hits.length === 0) {
          const empty = createEl(
            doc,
            'div',
            'eb-sdk-empty',
            'No matching command for "/' + rawQuery + '"'
          );
          if (empty) list.appendChild(empty);
          slashPopupEl.appendChild(list);
          slashSelection.reset();
          return;
        }

        for (let i = 0; i < hits.length; i += 1) {
          const hit = hits[i];
          const cmd = hit.item;
          const btn = createEl(doc, 'button', 'eb-sdk-option eb-slash-item');
          if (!btn) continue;
          btn.type = 'button';
          btn.setAttribute('role', 'option');
          btn.setAttribute('data-command', cmd.name);
          btn.setAttribute('data-index', String(i));
          btn.setAttribute('aria-selected', 'false');

          const main = createEl(doc, 'span', 'eb-sdk-option-main');
          const top = createEl(doc, 'span', 'eb-sdk-option-top');
          const nameEl = createEl(doc, 'span', 'eb-sdk-cmd-name');

          if (nameEl) {
            if (typeof doc.createTextNode === 'function') {
              nameEl.appendChild(doc.createTextNode('/'));
              const nameText = createEl(doc, 'span', '');
              if (nameText) {
                appendHighlightedText(doc, nameText, cmd.name, hit.ranges, slashTypeahead.splitRanges);
                nameEl.appendChild(nameText);
              }
            } else {
              nameEl.textContent = cmd.command;
            }
            if (top) top.appendChild(nameEl);
          }

          if (cmd.argHint && top) {
            const argEl = createEl(doc, 'span', 'eb-sdk-cmd-args', cmd.argHint);
            if (argEl) top.appendChild(argEl);
          }

          const descEl = createEl(doc, 'span', 'eb-sdk-option-desc', cmd.description);
          if (main) {
            if (top) main.appendChild(top);
            if (descEl) main.appendChild(descEl);
            btn.appendChild(main);
          }

          const badge = createEl(
            doc,
            'span',
            'eb-sdk-badge',
            cmd.immediate ? 'run' : cmd.category
          );
          if (badge) {
            badge.setAttribute('data-kind', cmd.immediate ? 'immediate' : cmd.category);
            btn.appendChild(badge);
          }

          (function bindOption(index, commandDef) {
            btn.addEventListener('mousedown', function onMouseDown(e) {
              if (e && typeof e.preventDefault === 'function') e.preventDefault();
            });
            btn.addEventListener('mouseenter', function onEnter() {
              slashSelection.setActiveIndex(index, { scroll: false });
            });
            btn.addEventListener('click', function onClick(e) {
              if (e && typeof e.preventDefault === 'function') e.preventDefault();
              handleSlashSelect(commandDef, e);
            });
          })(i, cmd);

          list.appendChild(btn);
          currentSlashOptionEls.push(btn);
        }

        slashPopupEl.appendChild(list);
        slashSelection.setActiveIndex(0, { scroll: false });
        if (slashPopup && slashPopup.isOpen()) {
          resetPopupPositionStyles(slashPopupEl);
          slashPopup.reposition();
        }
      }

      /* -- Rendering: Context Picker Popup (zero innerHTML / zero XSS) -- */

      function renderContextPopup() {
        if (!contextPopupEl || !doc) return;
        const st = store.get();
        const query = String(st.contextQuery || '').trim();
        const hits = contextTypeahead.filter(query);
        currentContextResults = hits;
        currentContextOptionEls = [];

        clearChildren(contextPopupEl);

        const header = createEl(doc, 'div', 'eb-sdk-popup-head');
        const titleText = query
          ? 'Kizuki Mind: ' + query
          : 'Kizuki Mind Context (Recent)';
        const statusText = st.contextLoading
          ? 'Searching...'
          : hits.length + ' match' + (hits.length === 1 ? '' : 'es');
        const title = createEl(doc, 'span', '', titleText);
        const meta = createEl(doc, 'span', '', statusText);
        if (header) {
          if (title) header.appendChild(title);
          if (meta) header.appendChild(meta);
          contextPopupEl.appendChild(header);
        }

        const list = createEl(doc, 'div', 'eb-sdk-popup-list');
        if (!list) return;

        if (hits.length === 0) {
          const emptyMsg = st.contextLoading
            ? 'Searching People, Vault Docs, Codex, and Taste...'
            : st.contextError
              ? 'Search unavailable: ' + st.contextError
              : 'No matches across People, Vault Docs, Codex, or Taste';
          const empty = createEl(doc, 'div', 'eb-sdk-empty', emptyMsg);
          if (empty) list.appendChild(empty);
          contextPopupEl.appendChild(list);
          contextSelection.reset();
          return;
        }

        for (let i = 0; i < hits.length; i += 1) {
          const hit = hits[i];
          const item = hit.item;
          const btn = createEl(doc, 'button', 'eb-sdk-option eb-context-item');
          if (!btn) continue;
          btn.type = 'button';
          btn.setAttribute('role', 'option');
          btn.setAttribute('data-kind', item.kind);
          btn.setAttribute('data-target', item.target);
          btn.setAttribute('data-index', String(i));
          btn.setAttribute('aria-selected', 'false');

          const badge = createEl(doc, 'span', 'eb-sdk-badge', item.categoryLabel);
          if (badge) {
            badge.setAttribute('data-kind', item.kind);
            btn.appendChild(badge);
          }

          const main = createEl(doc, 'span', 'eb-sdk-option-main');
          const labelEl = createEl(doc, 'span', 'eb-sdk-cmd-name');
          if (labelEl) {
            appendHighlightedText(doc, labelEl, item.label, hit.ranges, contextTypeahead.splitRanges);
            if (main) main.appendChild(labelEl);
          }

          const subText = item.subtitle && item.subtitle !== item.label
            ? item.subtitle
            : item.target;
          if (subText && main) {
            const subEl = createEl(doc, 'span', 'eb-sdk-option-desc', subText);
            if (subEl) main.appendChild(subEl);
          }

          if (main) btn.appendChild(main);

          (function bindCtxOption(index, ctxItem) {
            btn.addEventListener('mousedown', function onMouseDown(e) {
              if (e && typeof e.preventDefault === 'function') e.preventDefault();
            });
            btn.addEventListener('mouseenter', function onEnter() {
              contextSelection.setActiveIndex(index, { scroll: false });
            });
            btn.addEventListener('click', function onClick(e) {
              if (e && typeof e.preventDefault === 'function') e.preventDefault();
              handleContextSelect(ctxItem, e);
            });
          })(i, item);

          list.appendChild(btn);
          currentContextOptionEls.push(btn);
        }

        contextPopupEl.appendChild(list);
        contextSelection.setActiveIndex(0, { scroll: false });
        if (contextPopup && contextPopup.isOpen()) {
          resetPopupPositionStyles(contextPopupEl);
          contextPopup.reposition();
        }
      }

      /* -- Rendering: Removable Context Chips Bar (zero innerHTML / zero XSS) -- */

      function renderAttachmentsBar() {
        if (!attachmentsBarEl || !doc) return;
        const attachments = store.get().attachments || [];
        clearChildren(attachmentsBarEl);

        if (attachments.length === 0) {
          attachmentsBarEl.setAttribute('hidden', '');
          try {
            attachmentsBarEl.hidden = true;
          } catch (_err) {}
          return;
        }

        if (typeof attachmentsBarEl.removeAttribute === 'function') {
          attachmentsBarEl.removeAttribute('hidden');
        }
        try {
          attachmentsBarEl.hidden = false;
        } catch (_err) {}

        for (let i = 0; i < attachments.length; i += 1) {
          const att = attachments[i];
          const chip = createEl(doc, 'span', 'eb-sdk-chip eb-context-chip');
          if (!chip) continue;
          chip.setAttribute('data-kind', att.kind);
          chip.setAttribute('data-target', att.target);
          chip.setAttribute('data-key', att.key);
          chip.setAttribute('title', att.provenance);

          const badge = createEl(doc, 'span', 'eb-sdk-badge', att.categoryLabel);
          if (badge) {
            badge.setAttribute('data-kind', att.kind);
            chip.appendChild(badge);
          }

          const labelEl = createEl(doc, 'span', 'eb-sdk-chip-label', att.label);
          if (labelEl) chip.appendChild(labelEl);

          const removeBtn = createEl(doc, 'button', 'eb-sdk-chip-remove', 'x');
          if (removeBtn) {
            removeBtn.type = 'button';
            removeBtn.setAttribute('aria-label', 'Remove ' + att.label);
            removeBtn.setAttribute('data-action', 'remove-attachment');
            removeBtn.setAttribute('data-key', att.key);
            (function bindRemove(key) {
              removeBtn.addEventListener('click', function onRemove(e) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                removeAttachment(key);
              });
            })(att.key);
            chip.appendChild(removeBtn);
          }

          attachmentsBarEl.appendChild(chip);
        }
      }

      /* -- Open / Close Lifecycles -- */

      function isSlashOpen() {
        return Boolean(
          store.get().activePopup === 'slash' &&
            (!slashPopup || slashPopup.isOpen())
        );
      }

      function isContextOpen() {
        return Boolean(
          store.get().activePopup === 'context' &&
            (!contextPopup || contextPopup.isOpen())
        );
      }

      function openSlash(query, range) {
        if (destroyed) return false;
        if (isContextOpen()) {
          closeContext('switch', false);
        }

        focusRecovery.capture(textareaEl || undefined);
        const q = query !== undefined ? String(query) : '';
        const r = range !== undefined ? range : null;

        store.set({
          activePopup: 'slash',
          slashQuery: q,
          slashRange: r,
        });

        if (slashPopup && !slashPopup.isOpen()) {
          resetPopupPositionStyles(slashPopupEl);
          slashPopup.open();
        }
        if (slashDismissable) {
          slashDismissable.activate();
        }

        renderSlashPopup();
        playSound('tick');
        return true;
      }

      function closeSlash(reason, restoreFocus) {
        const wasOpen = store.get().activePopup === 'slash' || (slashPopup && slashPopup.isOpen());
        if (!wasOpen) return false;

        if (slashDismissable) {
          slashDismissable.deactivate();
        }
        if (slashPopup && slashPopup.isOpen()) {
          slashPopup.close({ reason: reason || 'close', restoreFocus: false });
        }
        slashSelection.reset();

        if (store.get().activePopup === 'slash') {
          store.set({ activePopup: 'none', slashQuery: '', slashRange: null });
        } else {
          store.set({ slashQuery: '', slashRange: null });
        }

        if (restoreFocus) {
          const res = focusRecovery.restore({ fallback: textareaEl });
          if (!res || !res.restored) {
            focusElement(textareaEl);
          }
        }
        return true;
      }

      function cancelPendingContextSearch() {
        if (contextDebounceTimer !== null) {
          clearTimeout(contextDebounceTimer);
          contextDebounceTimer = null;
        }
        if (activeAbortController && typeof activeAbortController.abort === 'function') {
          try {
            activeAbortController.abort();
          } catch (_err) {
            // Ignore abort errors
          }
        }
        activeAbortController = null;
      }

      function mergeCandidates(remoteItems) {
        const merged = [];
        const seen = Object.create(null);

        function addAll(list) {
          for (let i = 0; i < list.length; i += 1) {
            const it = list[i];
            if (!it || seen[it.key]) continue;
            seen[it.key] = true;
            merged.push(it);
          }
        }

        addAll(remoteItems || []);
        addAll(recentPool);
        return merged;
      }

      function runContextSearch(query) {
        const q = String(query || '').trim();
        const cacheKey = q.toLowerCase();

        if (!q) {
          cancelPendingContextSearch();
          currentContextCandidates = recentPool.slice();
          store.set({ contextLoading: false, contextError: '' });
          renderContextPopup();
          return;
        }

        if (searchCache.has(cacheKey)) {
          cancelPendingContextSearch();
          const cached = searchCache.get(cacheKey);
          currentContextCandidates = mergeCandidates(cached);
          store.set({ contextLoading: false, contextError: '' });
          renderContextPopup();
          return;
        }

        // Immediate local fuzzy preview from recent pool before network returns
        currentContextCandidates = recentPool.slice();
        store.set({ contextLoading: true, contextError: '' });
        renderContextPopup();

        cancelPendingContextSearch();
        const seq = ++contextRequestSeq;

        contextDebounceTimer = setTimeout(function executeFetch() {
          contextDebounceTimer = null;
          if (destroyed || seq !== contextRequestSeq) return;

          const fetchImpl =
            typeof opts.fetchFn === 'function'
              ? opts.fetchFn
              : win && typeof win.fetch === 'function'
                ? win.fetch.bind(win)
                : typeof fetch === 'function'
                  ? fetch
                  : null;

          if (!fetchImpl) {
            store.set({ contextLoading: false });
            renderContextPopup();
            return;
          }

          let fetchOpts = { headers: { Accept: 'application/json' } };
          if (typeof AbortController === 'function') {
            activeAbortController = new AbortController();
            fetchOpts.signal = activeAbortController.signal;
          }

          const url = '/api/omni-search?q=' + encodeURIComponent(q) + '&limit=8';
          Promise.resolve()
            .then(function () {
              return fetchImpl(url, fetchOpts);
            })
            .then(function (resp) {
              if (!resp) throw new Error('Empty response');
              if (typeof resp.ok === 'boolean' && !resp.ok) {
                throw new Error('HTTP ' + (resp.status || 500));
              }
              return typeof resp.json === 'function' ? resp.json() : resp;
            })
            .then(function (data) {
              if (destroyed || seq !== contextRequestSeq) return;
              const items = extractOmniSearchItems(data);
              if (searchCache.size >= MAX_CACHE_ENTRIES) {
                const oldestKey = searchCache.keys().next().value;
                searchCache.delete(oldestKey);
              }
              searchCache.set(cacheKey, items);
              currentContextCandidates = mergeCandidates(items);
              store.set({ contextLoading: false, contextError: '' });
              if (isContextOpen()) {
                renderContextPopup();
              }
            })
            .catch(function (err) {
              if (destroyed || seq !== contextRequestSeq) return;
              if (err && err.name === 'AbortError') return;
              store.set({
                contextLoading: false,
                contextError: err && err.message ? String(err.message) : 'Search failed',
              });
              if (isContextOpen()) {
                renderContextPopup();
              }
            });
        }, debounceMs);
      }

      function openContext(query, range) {
        if (destroyed) return false;
        if (isSlashOpen()) {
          closeSlash('switch', false);
        }

        focusRecovery.capture(textareaEl || undefined);
        const q = query !== undefined ? String(query) : '';
        const r = range !== undefined ? range : null;

        store.set({
          activePopup: 'context',
          contextQuery: q,
          contextRange: r,
        });

        if (contextPopup && !contextPopup.isOpen()) {
          resetPopupPositionStyles(contextPopupEl);
          contextPopup.open();
        }
        if (contextDismissable) {
          contextDismissable.activate();
        }

        runContextSearch(q);
        playSound('tick');
        return true;
      }

      function closeContext(reason, restoreFocus) {
        const wasOpen = store.get().activePopup === 'context' || (contextPopup && contextPopup.isOpen());
        if (!wasOpen) return false;

        cancelPendingContextSearch();
        if (contextDismissable) {
          contextDismissable.deactivate();
        }
        if (contextPopup && contextPopup.isOpen()) {
          contextPopup.close({ reason: reason || 'close', restoreFocus: false });
        }
        contextSelection.reset();

        if (store.get().activePopup === 'context') {
          store.set({
            activePopup: 'none',
            contextQuery: '',
            contextRange: null,
            contextLoading: false,
            contextError: '',
          });
        } else {
          store.set({
            contextQuery: '',
            contextRange: null,
            contextLoading: false,
            contextError: '',
          });
        }

        if (restoreFocus) {
          const res = focusRecovery.restore({ fallback: textareaEl });
          if (!res || !res.restored) {
            focusElement(textareaEl);
          }
        }
        return true;
      }

      function closeAll(restoreFocus) {
        const closedSlash = closeSlash('close-all', false);
        const closedCtx = closeContext('close-all', false);
        if ((closedSlash || closedCtx) && restoreFocus) {
          focusElement(textareaEl);
        }
        return closedSlash || closedCtx;
      }

      /* -- Selection Handlers -- */

      function executeSlashPayload(payload) {
        if (!payload) return false;
        playSound('click');
        if (onExecuteSlash) {
          onExecuteSlash(payload);
        }
        return true;
      }

      function handleSlashSelect(cmd, event) {
        if (!cmd) return;
        const st = store.get();
        const range = st.slashRange;
        const room = getRoom();
        const thread = getThread();

        closeSlash('select', false);

        if (cmd.immediate) {
          if (textareaEl) {
            const val = String(textareaEl.value || '');
            if (range && typeof range.start === 'number' && typeof range.end === 'number') {
              const nextVal = (val.slice(0, range.start) + val.slice(range.end)).replace(/^\s+/, '');
              textareaEl.value = nextVal;
              focusElement(textareaEl, 0);
              suppressInputTrigger = true;
              try {
                dispatchInputEvent(textareaEl, doc);
              } finally {
                suppressInputTrigger = false;
              }
            } else if (/^\s*\/[a-zA-Z0-9_-]*\s*$/.test(val)) {
              textareaEl.value = '';
              focusElement(textareaEl, 0);
              suppressInputTrigger = true;
              try {
                dispatchInputEvent(textareaEl, doc);
              } finally {
                suppressInputTrigger = false;
              }
            } else {
              focusElement(textareaEl);
            }
          }
          const payload = parseSlashCommand(cmd.command, { room, thread });
          executeSlashPayload(payload);
          return;
        }

        // Command with arguments: insert `/cmd ` and position caret for immediate typing
        const insertStr = cmd.command + ' ';
        if (textareaEl) {
          const val = String(textareaEl.value || '');
          let nextVal = insertStr + val;
          let caret = insertStr.length;

          if (range && typeof range.start === 'number' && typeof range.end === 'number') {
            const after = val.slice(range.end).replace(/^\s+/, '');
            nextVal = val.slice(0, range.start) + insertStr + after;
            caret = range.start + insertStr.length;
          } else if (val.trim().charAt(0) === '/') {
            const rest = val.replace(/^\s*\/[a-zA-Z0-9_-]*\s*/, '');
            nextVal = insertStr + rest;
            caret = insertStr.length;
          }

          textareaEl.value = nextVal;
          focusElement(textareaEl, caret);
          suppressInputTrigger = true;
          try {
            dispatchInputEvent(textareaEl, doc);
          } finally {
            suppressInputTrigger = false;
          }
        }

        playSound('click');
        emitToast(cmd.usage + ' - ' + cmd.description, 'info');
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
      }

      function handleContextSelect(item, event) {
        if (!item) return;
        const st = store.get();
        const range = st.contextRange;
        const useInline =
          insertMode === 'inline' ||
          insertMode === 'both' ||
          !attachmentsBarEl ||
          Boolean(event && event.shiftKey);
        const useChip = Boolean(attachmentsBarEl) && insertMode !== 'inline';

        closeContext('select', false);

        if (textareaEl) {
          const val = String(textareaEl.value || '');
          const tokenStr = useInline ? item.token + ' ' : '';
          let nextVal = val;
          let caret = val.length;

          if (range && typeof range.start === 'number' && typeof range.end === 'number') {
            nextVal = val.slice(0, range.start) + tokenStr + val.slice(range.end);
            caret = range.start + tokenStr.length;
          } else if (useInline) {
            const pos = typeof textareaEl.selectionStart === 'number'
              ? textareaEl.selectionStart
              : val.length;
            const needsSpace = pos > 0 && !/\s$/.test(val.slice(0, pos));
            const chunk = (needsSpace ? ' ' : '') + tokenStr;
            nextVal = val.slice(0, pos) + chunk + val.slice(pos);
            caret = pos + chunk.length;
          }

          if (nextVal !== val) {
            textareaEl.value = nextVal;
            focusElement(textareaEl, caret);
            suppressInputTrigger = true;
            try {
              dispatchInputEvent(textareaEl, doc);
            } finally {
              suppressInputTrigger = false;
            }
          } else {
            focusElement(textareaEl, caret);
          }
        }

        if (useChip || insertMode === 'inline') {
          addAttachment(item);
        }
        playSound('click');
      }

      /* -- Attachment Lifecycle API -- */

      function getAttachments() {
        const list = store.get().attachments || [];
        return list.map(function clone(att) {
          return Object.assign({}, att);
        });
      }

      function addAttachment(rawItem) {
        const norm = normalizeContextItem(rawItem);
        if (!norm) return null;

        const current = store.get().attachments || [];
        for (let i = 0; i < current.length; i += 1) {
          if (current[i].key === norm.key) {
            promoteRecentItem(norm);
            return Object.assign({}, current[i]);
          }
        }

        const next = current.concat([norm]);
        promoteRecentItem(norm);
        store.set({ attachments: next });
        renderAttachmentsBar();

        if (onAttachContext) {
          onAttachContext(Object.assign({}, norm), getAttachments());
        }
        return Object.assign({}, norm);
      }

      function removeAttachment(keyOrIndex) {
        const current = store.get().attachments || [];
        if (current.length === 0) return false;

        let next = null;
        if (typeof keyOrIndex === 'number') {
          if (keyOrIndex < 0 || keyOrIndex >= current.length) return false;
          next = current.slice(0, keyOrIndex).concat(current.slice(keyOrIndex + 1));
        } else {
          const needle = String(keyOrIndex || '');
          next = current.filter(function keep(att) {
            return att.key !== needle && att.id !== needle && att.target !== needle;
          });
          if (next.length === current.length) return false;
        }

        store.set({ attachments: next });
        renderAttachmentsBar();
        playSound('tick');

        if (onAttachContext) {
          onAttachContext(null, getAttachments());
        }
        return true;
      }

      function clearAttachments() {
        const current = store.get().attachments || [];
        if (current.length === 0) {
          renderAttachmentsBar();
          return;
        }
        store.set({ attachments: [] });
        renderAttachmentsBar();
        if (onAttachContext) {
          onAttachContext(null, []);
        }
      }

      function formatProvenance() {
        return formatAttachmentProvenance(store.get().attachments || []);
      }

      function composeMessageWithProvenance(bodyText) {
        const body = stripEmDash(bodyText).trim();
        const provenance = formatProvenance();
        if (!provenance) return body;
        if (!body) return provenance;
        return body + '\n\n' + provenance;
      }

      /* -- Composer Input Trigger Detection -- */

      function inspectTriggersFromTextarea() {
        if (!textareaEl || destroyed || suppressInputTrigger) return;
        const val = String(textareaEl.value || '');
        const pos = typeof textareaEl.selectionStart === 'number'
          ? textareaEl.selectionStart
          : val.length;
        const before = val.slice(0, pos);

        // 1. Check `[[` Context Picker trigger anywhere before caret
        const ctxMatch = /\[\[([^\]\[\n]{0,64})$/.exec(before);
        if (ctxMatch) {
          const start = pos - ctxMatch[0].length;
          const query = ctxMatch[1];
          const range = { start, end: pos };
          if (!isContextOpen()) {
            openContext(query, range);
          } else {
            store.set({ contextQuery: query, contextRange: range });
            runContextSearch(query);
          }
          return;
        }

        if (isContextOpen()) {
          closeContext('trigger-cleared', false);
        }

        // 2. Check `/` Slash Command trigger at start of input
        const slashMatch = /^(\s*)\/([a-zA-Z0-9_-]{0,24})$/.exec(before);
        if (slashMatch) {
          const start = slashMatch[1].length;
          const query = slashMatch[2];
          const range = { start, end: pos };
          if (!isSlashOpen()) {
            openSlash(query, range);
          } else {
            store.set({ slashQuery: query, slashRange: range });
            renderSlashPopup();
          }
          return;
        }

        if (isSlashOpen()) {
          closeSlash('trigger-cleared', false);
        }
      }

      /* -- Composer Event Listeners -- */

      if (textareaEl) {
        cleanups.push(
          addListener(textareaEl, 'input', inspectTriggersFromTextarea),
          addListener(
            textareaEl,
            'keydown',
            function onComposerKeyDown(event) {
              if (destroyed || !event) return;

              if (isSlashOpen()) {
                if (event.key === 'Escape') {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopPropagation === 'function') event.stopPropagation();
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  closeSlash('escape', true);
                  return;
                }
                if (event.key === 'Tab') {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  slashSelection.selectActive(event);
                  return;
                }
                if (slashSelection.handleKeyDown(event)) {
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  return;
                }
              }

              if (isContextOpen()) {
                if (event.key === 'Escape') {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopPropagation === 'function') event.stopPropagation();
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  closeContext('escape', true);
                  return;
                }
                if (event.key === 'Tab') {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  contextSelection.selectActive(event);
                  return;
                }
                if (contextSelection.handleKeyDown(event)) {
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  return;
                }
              }

              // Execute completed slash command line on Enter (non-Shift)
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.altKey &&
                textareaEl.value &&
                String(textareaEl.value).trim().charAt(0) === '/'
              ) {
                const parsed = parseSlashCommand(textareaEl.value, {
                  room: getRoom(),
                  thread: getThread(),
                });
                if (parsed) {
                  if (parsed.definition.requiresArgs && !parsed.args) {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopImmediatePropagation === 'function') {
                      event.stopImmediatePropagation();
                    }
                    emitToast('Usage: ' + parsed.definition.usage, 'warn');
                    return;
                  }
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                  }
                  textareaEl.value = '';
                  dispatchInputEvent(textareaEl, doc);
                  executeSlashPayload(parsed);
                }
              }
            },
            true
          )
        );
      }

      if (slashTriggerEl) {
        cleanups.push(
          addListener(slashTriggerEl, 'click', function onSlashTriggerClick(event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (isSlashOpen()) {
              closeSlash('toggle', true);
            } else {
              focusElement(textareaEl);
              openSlash('', null);
            }
          })
        );
      }

      if (contextTriggerEl) {
        cleanups.push(
          addListener(contextTriggerEl, 'click', function onContextTriggerClick(event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (isContextOpen()) {
              closeContext('toggle', true);
            } else {
              focusElement(textareaEl);
              openContext('', null);
            }
          })
        );
      }

      renderAttachmentsBar();

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        closeAll(false);
        cancelPendingContextSearch();
        while (cleanups.length > 0) {
          const fn = cleanups.pop();
          try {
            fn();
          } catch (_err) {
            // Ensure full cleanup
          }
        }
        slashSelection.destroy();
        slashTypeahead.destroy();
        if (slashDismissable) slashDismissable.destroy();
        if (slashPopup) slashPopup.destroy();

        contextSelection.destroy();
        contextTypeahead.destroy();
        if (contextDismissable) contextDismissable.destroy();
        if (contextPopup) contextPopup.destroy();

        focusRecovery.destroy();
        searchCache.clear();
      }

      return {
        getAttachments,
        clearAttachments,
        addAttachment,
        removeAttachment,
        formatProvenance,
        composeMessageWithProvenance,
        parseSlashCommand: function (text) {
          return parseSlashCommand(text, { room: getRoom(), thread: getThread() });
        },
        openSlash: function (query) {
          return openSlash(query !== undefined ? query : '', null);
        },
        openContext: function (query) {
          return openContext(query !== undefined ? query : '', null);
        },
        closeAll,
        isOpen: function () {
          return isSlashOpen() || isContextOpen();
        },
        destroy,
      };
    }

    /* ------------------------------------------------------------------------
       2. attachBoardKeyboard(options)
       ------------------------------------------------------------------------ */

    const STAGE_KEYS = Object.freeze({
      '1': Object.freeze({ stage: 'thread', index: 0, label: 'Thread' }),
      '2': Object.freeze({ stage: 'canvas', index: 1, label: 'Canvas' }),
      '3': Object.freeze({ stage: 'context', index: 2, label: 'Context' }),
      '4': Object.freeze({ stage: 'live', index: 3, label: 'live' }),
    });

    const BOARD_SHORTCUTS = Object.freeze([
      Object.freeze({ keys: 'J / K', action: 'Next / Previous thread in stream' }),
      Object.freeze({ keys: 'R', action: 'Reply to currently selected thread' }),
      Object.freeze({ keys: 'C', action: 'New thread in active room' }),
      Object.freeze({ keys: '1 / 2 / 3 / 4', action: 'Switch right stage (Thread | Canvas | Context | live)' }),
      Object.freeze({ keys: '[ / ]', action: 'Previous / Next active room' }),
      Object.freeze({ keys: 'S', action: 'Toggle Signal vs All telemetry filter' }),
      Object.freeze({ keys: 'B', action: 'Run Local LLM Executive Brief' }),
      Object.freeze({ keys: 'Esc', action: 'Close open popover or modal' }),
    ]);

    function isEditableElement(el) {
      let cur = el;
      let depth = 0;
      while (cur && depth < 12) {
        depth += 1;
        const tag = typeof cur.tagName === 'string' ? cur.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return true;
        }
        if (cur.isContentEditable === true) {
          return true;
        }
        if (typeof cur.getAttribute === 'function') {
          const ce = cur.getAttribute('contenteditable');
          if (ce === '' || ce === 'true' || ce === 'plaintext-only') {
            return true;
          }
          const role = cur.getAttribute('role');
          if (role === 'textbox' || role === 'combobox' || role === 'searchbox') {
            return true;
          }
        }
        cur = cur.parentElement || cur.parentNode || null;
      }
      return false;
    }

    function isElementVisible(el) {
      if (!el) return false;
      if (el.hidden === true) return false;
      if (typeof el.getAttribute === 'function') {
        const h = el.getAttribute('hidden');
        if (h !== null && h !== 'false') return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.getAttribute('data-state') === 'closed') return false;
      }
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) {
        return false;
      }
      return true;
    }

    function hasOpenOverlayInDom(doc, rootEl) {
      const sdk = getUiSdk();
      if (sdk && typeof sdk.getDismissStackSize === 'function' && doc) {
        if (sdk.getDismissStackSize(doc) > 0) {
          return true;
        }
      }

      if (!doc || typeof doc.querySelectorAll !== 'function') return false;
      const selector = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        '[role="listbox"][data-state="open"]',
        '[data-state="open"][data-ui-slot="content"]',
        'dialog[open]',
        '.cmdk-modal.is-open',
        '.modal.is-open',
      ].join(',');

      let nodes = [];
      try {
        nodes = doc.querySelectorAll(selector);
      } catch (_err) {
        return false;
      }

      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node || node === rootEl) continue;
        if (isElementVisible(node)) {
          return true;
        }
      }
      return false;
    }

    function scrollThreadElementIntoView(maybeEl, rootEl) {
      let target = maybeEl && typeof maybeEl.scrollIntoView === 'function' ? maybeEl : null;
      if (!target && rootEl && typeof rootEl.querySelector === 'function') {
        try {
          target = rootEl.querySelector(
            '[data-thread-active="true"], [aria-current="true"], .eb-thread-card.is-selected, .eb-stream-item.is-selected, [data-selected="true"]'
          );
        } catch (_err) {
          target = null;
        }
      }
      if (!target || typeof target.scrollIntoView !== 'function') return false;
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return true;
      } catch (_err) {
        try {
          target.scrollIntoView();
          return true;
        } catch (_err2) {
          return false;
        }
      }
    }

    function closeOpenPopoversInRoot(rootEl) {
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return false;
      let closedAny = false;
      try {
        const openPopovers = rootEl.querySelectorAll(
          '[role="dialog"][data-state="open"], [role="listbox"][data-state="open"], .eb-sdk-popup:not([hidden])'
        );
        for (let i = 0; i < openPopovers.length; i += 1) {
          const el = openPopovers[i];
          if (!isElementVisible(el)) continue;
          el.setAttribute('data-state', 'closed');
          el.setAttribute('hidden', '');
          try {
            el.hidden = true;
          } catch (_err) {}
          closedAny = true;
        }
      } catch (_err) {
        // Ignore querySelectorAll errors in minimal mocks
      }
      return closedAny;
    }

    function attachBoardKeyboard(options) {
      const opts = options && typeof options === 'object' ? options : {};
      const rootEl = opts.rootEl || null;
      const isActive =
        typeof opts.isActive === 'function'
          ? opts.isActive
          : function defaultIsActive() {
              return rootEl ? isElementVisible(rootEl) : true;
            };
      const hasOpenModal = typeof opts.hasOpenModal === 'function' ? opts.hasOpenModal : null;

      const doc = getDocument(rootEl);
      const listenerTarget = doc || rootEl;
      let destroyed = false;
      let enabled = true;

      function isOverlayBlocking() {
        if (hasOpenModal && hasOpenModal()) return true;
        return hasOpenOverlayInDom(doc, rootEl);
      }

      function handleKeyDown(event) {
        if (destroyed || !enabled || !event) return;
        if (event.defaultPrevented || event.isComposing) return;
        if (!isActive()) return;

        const key = String(event.key || '');

        // Escape always allowed to close open popovers cleanly
        if (key === 'Escape') {
          if (isOverlayBlocking()) {
            const closed = closeOpenPopoversInRoot(rootEl);
            if (typeof opts.onEscape === 'function') {
              opts.onEscape(event);
            }
            if (closed && typeof event.preventDefault === 'function') {
              event.preventDefault();
            }
          }
          return;
        }

        // Never intercept modified shortcuts (Cmd/Ctrl/Alt)
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        // Guard: no text input, textarea, select, or contentEditable focused
        const activeEl = doc ? doc.activeElement : null;
        if (isEditableElement(event.target) || isEditableElement(activeEl)) {
          return;
        }

        // Guard: no modal or popover open
        if (isOverlayBlocking()) {
          return;
        }

        const lower = key.length === 1 ? key.toLowerCase() : key;

        if (lower === 'j') {
          if (typeof opts.onNextThread === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            const activeThreadEl = opts.onNextThread(event);
            scrollThreadElementIntoView(activeThreadEl, rootEl);
            playSound('click');
          }
          return;
        }

        if (lower === 'k') {
          if (typeof opts.onPrevThread === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            const activeThreadEl = opts.onPrevThread(event);
            scrollThreadElementIntoView(activeThreadEl, rootEl);
            playSound('click');
          }
          return;
        }

        if (lower === 'r') {
          if (typeof opts.onReply === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onReply(event);
            playSound('click');
          }
          return;
        }

        if (lower === 'c') {
          if (typeof opts.onFocusComposer === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onFocusComposer(event);
            playSound('click');
          }
          return;
        }

        if (Object.prototype.hasOwnProperty.call(STAGE_KEYS, key)) {
          if (typeof opts.onSwitchStage === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            const stageSpec = STAGE_KEYS[key];
            opts.onSwitchStage(stageSpec.stage, stageSpec.index, event);
            playSound('click');
          }
          return;
        }

        if (key === '[') {
          if (typeof opts.onPrevRoom === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onPrevRoom(event);
            playSound('click');
          }
          return;
        }

        if (key === ']') {
          if (typeof opts.onNextRoom === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onNextRoom(event);
            playSound('click');
          }
          return;
        }

        if (lower === 's') {
          if (typeof opts.onToggleSignal === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onToggleSignal(event);
            playSound('click');
          }
          return;
        }

        if (lower === 'b') {
          if (typeof opts.onSynthesize === 'function') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            opts.onSynthesize(event);
            playSound('click');
          }
        }
      }

      const removeKeyListener = addListener(listenerTarget, 'keydown', handleKeyDown, false);

      return {
        setEnabled: function (next) {
          enabled = Boolean(next);
        },
        isEnabled: function () {
          return enabled && !destroyed;
        },
        getShortcuts: function () {
          return BOARD_SHORTCUTS.slice();
        },
        destroy: function () {
          if (destroyed) return;
          destroyed = true;
          removeKeyListener();
        },
      };
    }

    return {
      version: '1.0.0',
      SLASH_COMMANDS,
      BOARD_SHORTCUTS,
      parseSlashCommand,
      formatInlineToken,
      formatAttachmentProvenance,
      attachComposerPlugins,
      attachBoardKeyboard,
    };
  }
);
