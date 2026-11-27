/* ==========================================================================
   KIZUKI MIND EXPLORER - LOCAL LLM THREAD SYNTHESIZER, DECISION VERDICTS
   & MIND CONTEXT STAGE (EVIL RABBIT / SWISS SPEC)
   Exports: window.KizukiBoardContextStage (UMD/IIFE)
   Zero external deps | 100% XSS-escaped | Zero em-dashes | Tactile Audio
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiBoardContextStage = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiBoardContextStage = api;
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
    const STYLE_ID = 'kizuki-board-context-stage-css';

    const CODEX_SECTIONS = Object.freeze([
      {
        id: 'actions',
        label: 'Action Plane',
        shortLabel: 'Actions',
        hint: 'Active commitment & execution track',
      },
      {
        id: 'ideas',
        label: 'Ideas Incubator',
        shortLabel: 'Ideas',
        hint: 'Thesis, experiment, or product seed',
      },
      {
        id: 'philosophies',
        label: 'Philosophies & Principles',
        shortLabel: 'Principles',
        hint: 'Durable operating rule or taste law',
      },
    ]);

    const VERDICT_SPECS = Object.freeze({
      approve: {
        key: 'approve',
        tag: 'APPROVE',
        label: 'Approve',
        shortcut: 'A',
        defaultNote: 'Approved to proceed.',
        pausedNote: 'Approved. Resuming paused execution.',
      },
      revise: {
        key: 'revise',
        tag: 'REVISE',
        label: 'Revise',
        shortcut: 'R',
        defaultNote: 'Needs revision before proceeding: ',
        pausedNote: 'Paused for revision: ',
      },
      defer: {
        key: 'defer',
        tag: 'DEFER',
        label: 'Defer',
        shortcut: 'D',
        defaultNote: 'Deferred for now. Revisit in the next cycle.',
        pausedNote: 'Deferred. Keeping paused until next cycle.',
      },
    });

    const ICONS = Object.freeze({
      spark:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4 8 1.8Z"/></svg>',
      arrowRight:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8h9.6"/><path d="M9.2 4.4 12.8 8l-3.6 3.6"/></svg>',
      chevronDown:
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8"/></svg>',
      paste:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.2" y="3.6" width="8.6" height="10.2" rx="1.6"/><path d="M6.2 3.6V2.6a.9.9 0 0 1 .9-.9h2.8a.9.9 0 0 1 .9.9v1"/><path d="M6.4 8h4.2M6.4 10.6h3"/></svg>',
      promote:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.6V3.4"/><path d="M4.4 7 8 3.4 11.6 7"/><path d="M3.2 13.4h9.6"/></svg>',
      refresh:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.35-3.45"/><path d="M13.2 2.8v2.8h-2.8"/></svg>',
      person:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.2" r="2.6"/><path d="M3.2 13.4c.7-2.4 2.5-3.6 4.8-3.6s4.1 1.2 4.8 3.6"/></svg>',
      doc:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.2h5.2l3 3v8.6a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8Z"/><path d="M9.2 2.2v3h3"/><path d="M5.6 8.2h4.8M5.6 10.8h3.4"/></svg>',
      codex:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.8"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8"/></svg>',
      taste:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6 8 2.2Z"/></svg>',
      replay:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.4" y="3.2" width="11.2" height="10.2" rx="1.6"/><path d="M5.4 2v2.4M10.6 2v2.4M2.4 6.6h11.2"/></svg>',
      commit:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.4"/><path d="M2 8h3.6M10.4 8H14"/></svg>',
      thread:
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.2h10a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H6.6L3.4 14v-2.2H3a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1Z"/></svg>',
      check:
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4 6.4 11.6 12.8 4.8"/></svg>',
      close:
        '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    });

    /* ========================================================================
       1. LOW-LEVEL HELPERS (XSS ESCAPING, SOUND, FORMATTERS)
       ======================================================================== */

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

    function playSound(method) {
      const w = getWin();
      const sound = (w && w.KizukiSound) || (root && root.KizukiSound);
      if (!sound || typeof sound[method] !== 'function') return;
      try {
        sound[method]();
      } catch {
        // Optional audio feedback must never interrupt UI interaction.
      }
    }

    function stripEmDash(value) {
      return String(value == null ? '' : value)
        .replace(EM_DASH_RE, ' - ')
        .replace(EN_DASH_RE, ' - ');
    }

    function escapeHtml(value) {
      return stripEmDash(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function safeArray(val) {
      return Array.isArray(val) ? val : [];
    }

    function truncateText(text, maxLen) {
      const clean = stripEmDash(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return '';
      if (clean.length <= maxLen) return clean;
      const cut = clean.slice(0, maxLen);
      const lastSpace = cut.lastIndexOf(' ');
      const end = lastSpace >= Math.floor(maxLen * 0.55) ? cut.slice(0, lastSpace) : cut;
      return `${end.replace(/[,;:.\-/\s]+$/, '')}...`;
    }

    function formatShortThreadId(rawId) {
      const s = String(rawId == null ? '' : rawId).trim();
      if (!s) return '';
      if (/^\d+$/.test(s)) return `#${s}`;
      if (s.startsWith('key:')) {
        const tail = s.split(':').pop() || s.slice(4);
        return `#${tail.slice(0, 8)}`;
      }
      if (s.length > 14) return `#${s.slice(0, 8)}`;
      return `#${s}`;
    }

    function formatLatency(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return '';
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s`;
      return `${Math.round(n)}ms`;
    }

    function formatRelativeTime(isoOrMs) {
      if (!isoOrMs) return '';
      const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs));
      if (!Number.isFinite(ts)) return stripEmDash(String(isoOrMs));
      const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (diffSec < 15) return 'just now';
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return `${diffDay}d ago`;
      return new Date(ts).toISOString().slice(0, 10);
    }

    function normalizeSection(section) {
      const low = String(section || '').trim().toLowerCase();
      if (low === 'ideas' || low === 'idea' || low === 'incubator') return 'ideas';
      if (low === 'philosophies' || low === 'philosophy' || low === 'principles') return 'philosophies';
      return 'actions';
    }

    function getSectionMeta(section) {
      const id = normalizeSection(section);
      return CODEX_SECTIONS.find((s) => s.id === id) || CODEX_SECTIONS[0];
    }

    function extractThreadIdentity(threadItem, fallbackChannel) {
      if (!threadItem || typeof threadItem !== 'object') {
        return {
          threadId: '',
          channel: String(fallbackChannel || 'box').replace(/^#+/, '').trim() || 'box',
          title: '',
          text: '',
          isPaused: false,
          isBlocked: false,
          taskState: '',
          createdAt: '',
          labels: {},
        };
      }
      const rootObj =
        threadItem.root && typeof threadItem.root === 'object' ? threadItem.root : threadItem;
      const numericFromRoot =
        rootObj.numericId != null && String(rootObj.numericId).trim()
          ? String(rootObj.numericId).trim()
          : rootObj.id != null && /^\d+$/.test(String(rootObj.id).trim())
            ? String(rootObj.id).trim()
            : '';
      const numericFromItem =
        threadItem.numericId != null && String(threadItem.numericId).trim()
          ? String(threadItem.numericId).trim()
          : threadItem.id != null && /^\d+$/.test(String(threadItem.id).trim())
            ? String(threadItem.id).trim()
            : '';
      const tid = String(
        numericFromRoot ||
          numericFromItem ||
          rootObj.id ||
          threadItem.id ||
          rootObj.eventId ||
          threadItem.eventId ||
          rootObj.threadId ||
          threadItem.threadId ||
          rootObj.thread ||
          ''
      ).trim();
      const ch = String(
        rootObj.channel || threadItem.channel || fallbackChannel || 'box'
      )
        .replace(/^#+/, '')
        .trim();
      const taskState = String(
        rootObj.taskState || (rootObj.task && rootObj.task.state) || threadItem.taskState || ''
      )
        .trim()
        .toLowerCase();
      const isPaused = Boolean(
        rootObj.isPaused ||
          threadItem.isPaused ||
          threadItem.pause ||
          taskState === 'paused'
      );
      const isBlocked = Boolean(
        rootObj.isBlocked ||
          threadItem.isBlocked ||
          (rootObj.task && rootObj.task.blocked) ||
          taskState === 'blocked' ||
          taskState === 'stalled'
      );
      const labels =
        rootObj.labels && typeof rootObj.labels === 'object'
          ? rootObj.labels
          : threadItem.labels && typeof threadItem.labels === 'object'
            ? threadItem.labels
            : {};

      return {
        threadId: tid,
        channel: ch || 'box',
        title: stripEmDash(rootObj.title || threadItem.title || '').trim(),
        text: stripEmDash(rootObj.text || rootObj.body || threadItem.text || '').trim(),
        isPaused,
        isBlocked,
        taskState,
        createdAt: String(rootObj.createdAt || rootObj.lastAt || threadItem.createdAt || '').trim(),
        labels,
      };
    }

    function needsDecisionVerdict(threadItem) {
      if (!threadItem || typeof threadItem !== 'object') return false;
      const info = extractThreadIdentity(threadItem);
      if (info.isPaused || info.isBlocked) return true;
      if (
        info.taskState === 'blocked' ||
        info.taskState === 'paused' ||
        info.taskState === 'waiting' ||
        info.taskState === 'review' ||
        info.taskState === 'needs_decision'
      ) {
        return true;
      }
      const chLow = info.channel.toLowerCase();
      if (
        chLow.includes('decision') ||
        chLow.includes('blocker') ||
        chLow.includes('escalation') ||
        chLow.includes('approval')
      ) {
        return true;
      }
      const labels = info.labels || {};
      if (
        labels.decision ||
        labels.verdict ||
        labels.needs_owner ||
        String(labels.kind || '').toLowerCase() === 'decision'
      ) {
        return true;
      }
      return false;
    }

    function normalizeBriefResult(briefState) {
      if (!briefState || typeof briefState !== 'object') {
        return { mode: 'idle', result: null, error: '' };
      }
      const status = String(briefState.status || '').toLowerCase();
      if (briefState.loading === true || status === 'loading' || status === 'pending') {
        return { mode: 'loading', result: null, error: '' };
      }
      if (briefState.error || status === 'error') {
        return {
          mode: 'error',
          result: null,
          error: stripEmDash(briefState.error || 'Synthesis request failed.'),
        };
      }
      const raw =
        (briefState.result && typeof briefState.result === 'object' && briefState.result) ||
        (briefState.data && typeof briefState.data === 'object' && briefState.data) ||
        (briefState.brief && typeof briefState.brief === 'object' && briefState.brief) ||
        briefState;

      const headline = stripEmDash(
        raw.headline || raw.summary || raw.title || ''
      ).trim();
      const decided = safeArray(raw.decided || raw.decisions || raw.agreed)
        .map((x) => stripEmDash(typeof x === 'string' ? x : (x && (x.text || x.label || x.summary)) || '').trim())
        .filter(Boolean);
      const blocked = safeArray(raw.blocked || raw.blockers || raw.risks || raw.openQuestions)
        .map((x) => stripEmDash(typeof x === 'string' ? x : (x && (x.text || x.label || x.reason)) || '').trim())
        .filter(Boolean);
      const nextActions = safeArray(raw.nextActions || raw.next_actions || raw.actions)
        .map((x) => stripEmDash(typeof x === 'string' ? x : (x && (x.text || x.label || x.action || x.summary)) || '').trim())
        .filter(Boolean);
      const rawNextMove = stripEmDash(
        raw.nextMove ||
          raw.next_move ||
          raw.nextStep ||
          raw.next_step ||
          raw.recommendation ||
          nextActions[0] ||
          ''
      ).trim();
      const nextMove =
        rawNextMove && headline && rawNextMove.toLowerCase() === headline.toLowerCase()
          ? nextActions.find((item) => item.toLowerCase() !== headline.toLowerCase()) || ''
          : rawNextMove;
      const suggestedDirective = stripEmDash(
        raw.suggestedDirective ||
          raw.suggested_directive ||
          raw.ownerDirective ||
          raw.owner_directive ||
          raw.directive ||
          nextMove ||
          ''
      ).trim();

      const hasResult = Boolean(
        headline ||
          decided.length ||
          blocked.length ||
          nextMove ||
          nextActions.length ||
          suggestedDirective ||
          status === 'ready' ||
          status === 'done' ||
          status === 'ok'
      );

      if (!hasResult) {
        return { mode: 'idle', result: null, error: '' };
      }

      const rawEngine = String(
        raw.engine || raw.source || raw.provider || (raw.usedG4 ? 'local-llm' : '')
      ).trim();
      const isG4 = /local-llm|g4|qwen|vllm|8003|llm/i.test(rawEngine) || raw.usedG4 === true;
      const engineLabel = isG4 ? 'Local LLM' : 'Deterministic';
      const latencyMs =
        raw.latencyMs != null
          ? raw.latencyMs
          : raw.latency_ms != null
            ? raw.latency_ms
            : raw.elapsedMs != null
              ? raw.elapsedMs
              : raw.durationMs;

      return {
        mode: 'result',
        error: '',
        result: {
          engine: rawEngine || (isG4 ? 'local-llm' : 'deterministic'),
          engineLabel,
          isG4,
          model: stripEmDash(raw.model || '').trim(),
          latencyMs: latencyMs != null ? Number(latencyMs) : null,
          headline: headline || 'Thread synthesis complete.',
          decided,
          blocked,
          nextMove,
          nextActions,
          suggestedDirective,
        },
      };
    }

    function normalizeContextData(contextData) {
      const src = contextData && typeof contextData === 'object' ? contextData : {};
      const ent = src.entities && typeof src.entities === 'object' ? src.entities : {};

      const people = safeArray(src.people || ent.people).map((p) => {
        if (typeof p === 'string') {
          return { key: p, name: stripEmDash(p), role: '', snippet: '' };
        }
        return {
          key: String(p.key || p.slug || p.id || p.name || '').trim(),
          name: stripEmDash(p.name || p.displayName || p.key || 'Person').trim(),
          role: stripEmDash(p.role || p.relation || p.organization || p.category || '').trim(),
          snippet: stripEmDash(p.snippet || p.reason || p.summary || '').trim(),
        };
      }).filter((p) => p.key || p.name);

      const vaultDocs = safeArray(
        src.vaultDocs || src.docs || src.vault || ent.vaultDocs || ent.docs || ent.vault
      ).map((d) => {
        if (typeof d === 'string') {
          const base = d.split('/').pop() || d;
          return { path: d, title: stripEmDash(base), folder: '', snippet: '' };
        }
        const docPath = String(d.path || d.docPath || d.id || '').trim();
        const fallbackName = docPath ? docPath.split('/').pop() : 'Vault Doc';
        return {
          path: docPath,
          title: stripEmDash(d.title || d.name || fallbackName).trim(),
          folder: stripEmDash(d.folder || d.category || d.section || '').trim(),
          snippet: stripEmDash(d.snippet || d.excerpt || d.summary || '').trim(),
        };
      }).filter((d) => d.path || d.title);

      const codexEntries = safeArray(
        src.codexEntries || src.codex || ent.codexEntries || ent.codex
      ).map((c) => {
        if (typeof c === 'string') {
          return { id: c, title: stripEmDash(c), section: 'actions', stage: '', summary: '' };
        }
        return {
          id: String(c.id || c.itemId || '').trim(),
          title: stripEmDash(c.title || c.name || c.text || 'Codex Entry').trim(),
          section: normalizeSection(c.section || c.plane || c.category || 'actions'),
          stage: stripEmDash(c.stage || c.status || '').trim(),
          summary: stripEmDash(c.summary || c.snippet || '').trim(),
        };
      }).filter((c) => c.id || c.title);

      const tasteRules = safeArray(
        src.tasteRules || src.taste || src.tasteDomains || ent.tasteRules || ent.taste
      ).map((t) => {
        if (typeof t === 'string') {
          return { id: '', domain: stripEmDash(t), title: stripEmDash(t), summary: '', polarity: '' };
        }
        const domain = stripEmDash(t.domain || t.category || 'general').trim();
        return {
          id: String(t.id || t.ruleId || '').trim(),
          domain,
          title: stripEmDash(t.title || t.rule || t.label || t.text || domain).trim(),
          summary: stripEmDash(t.summary || t.rationale || t.snippet || '').trim(),
          polarity: stripEmDash(t.polarity || t.signal || '').trim(),
        };
      }).filter((t) => t.title || t.domain);

      const replayDays = safeArray(
        src.replayDays || src.replay || src.days || ent.replayDays || ent.replay
      ).map((r) => {
        if (typeof r === 'string') {
          return { day: r, title: r, summary: '', count: null };
        }
        const day = String(r.day || r.date || r.id || '').trim();
        return {
          day,
          title: stripEmDash(r.title || r.label || day).trim(),
          summary: stripEmDash(r.summary || r.highlight || r.snippet || '').trim(),
          count: r.eventsCount != null ? Number(r.eventsCount) : r.count != null ? Number(r.count) : null,
        };
      }).filter((r) => r.day);

      const commits = safeArray(
        src.commits || src.commitShas || src.shas || ent.commits || ent.commitShas
      ).map((cm) => {
        if (typeof cm === 'string') {
          const clean = cm.trim();
          return { sha: clean, shortSha: clean.slice(0, 7), message: '', repo: '' };
        }
        const sha = String(cm.sha || cm.hash || cm.commit || cm.id || '').trim();
        return {
          sha,
          shortSha: String(cm.shortSha || sha.slice(0, 7)).trim(),
          message: stripEmDash(cm.message || cm.title || cm.summary || '').trim(),
          repo: stripEmDash(cm.repo || cm.repository || cm.branch || '').trim(),
        };
      }).filter((cm) => cm.sha);

      const relatedThreads = safeArray(
        src.relatedThreads || src.related || src.threads || []
      ).map((rt) => {
        const tid = String(rt.threadId || rt.id || rt.numericId || '').trim();
        const ch = String(rt.channel || rt.room || 'box').replace(/^#+/, '').trim();
        return {
          threadId: tid,
          channel: ch,
          title: stripEmDash(rt.title || rt.headline || rt.preview || rt.text || `Thread #${tid}`).trim(),
          preview: stripEmDash(rt.preview || rt.excerpt || rt.snippet || '').trim(),
          sharedEntities: safeArray(rt.sharedEntities || rt.matchedEntities || rt.sharedTerms || rt.reasons)
            .map((x) => stripEmDash(typeof x === 'string' ? x : (x && (x.label || x.name)) || '').trim())
            .filter(Boolean),
          lastAt: rt.lastAt || rt.createdAt || rt.updatedAt || '',
          replies: rt.replies != null ? Number(rt.replies) : null,
        };
      }).filter((rt) => rt.threadId);

      const totalEntities =
        people.length +
        vaultDocs.length +
        codexEntries.length +
        tasteRules.length +
        replayDays.length +
        commits.length;

      return {
        people,
        vaultDocs,
        codexEntries,
        tasteRules,
        replayDays,
        commits,
        relatedThreads,
        totalEntities,
      };
    }

    function inferQuickCrossRefs(threadInfo) {
      const ch = String(threadInfo.channel || 'box').toLowerCase();
      const rootSlug = ch.split('/')[0] || 'box';
      const subSlug = ch.split('/')[1] || '';
      const topicQuery = threadInfo.title
        ? truncateText(threadInfo.title, 42)
        : subSlug || rootSlug;

      let tasteDomain = 'ui';
      if (ch.includes('design') || ch.includes('ui') || ch.includes('taste')) tasteDomain = 'ui';
      else if (ch.includes('video') || ch.includes('film') || ch.includes('anime')) tasteDomain = 'video';
      else if (ch.includes('crypto') || ch.includes('trade')) tasteDomain = 'code';
      else if (ch.includes('web')) tasteDomain = 'web';

      let codexSection = 'actions';
      if (ch.includes('idea') || ch.includes('brainstorm') || ch.includes('scout')) codexSection = 'ideas';
      else if (ch.includes('taste') || ch.includes('philosophy') || ch.includes('doctrine')) codexSection = 'philosophies';

      const replayDay =
        threadInfo.createdAt && /^\d{4}-\d{2}-\d{2}/.test(threadInfo.createdAt)
          ? threadInfo.createdAt.slice(0, 10)
          : new Date().toISOString().slice(0, 10);

      return {
        room: threadInfo.channel || 'box',
        topicQuery,
        tasteDomain,
        codexSection,
        codexLabel: getSectionMeta(codexSection).label,
        replayDay,
      };
    }

    /* ========================================================================
       2. SCOPED LOW-SPECIFICITY EVIL RABBIT / SWISS SPEC STYLES
       Uses :where(...) so host/Agent 4 CSS overrides cleanly without fights.
       ======================================================================== */

    function getStyles() {
      return `
:where(.eb-brief-card) {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 13px;
  background: var(--eb-card-bg, #18181b);
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));
  color: var(--ink-primary, #f4f4f5);
  min-width: 0;
  box-sizing: border-box;
}
:where(.eb-brief-card.is-idle) {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 12px;
  background: var(--eb-stage-elevated, #17171a);
}
:where(.eb-brief-card.is-loading) {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 13px;
  background: var(--eb-stage-elevated, #17171a);
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.14));
}
:where(.eb-brief-bar-title) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-secondary, #a1a1aa);
  min-width: 0;
}
:where(.eb-brief-dot) {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--eb-live, #34d399);
  flex-shrink: 0;
}
:where(.eb-brief-dot.is-muted) {
  background: var(--ink-muted, #71717a);
}
:where(.eb-brief-bar-actions) {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  position: relative;
}
:where(.eb-brief-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 27px;
  padding: 0 11px;
  border-radius: 9999px;
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.06));
  color: var(--ink-primary, #f4f4f5);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
}
:where(.eb-brief-btn:hover) {
  background: var(--eb-pill-hover, rgba(255, 255, 255, 0.10));
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.22));
}
:where(.eb-brief-btn.is-primary) {
  background: var(--eb-ship-bg, #ededed);
  border-color: transparent;
  color: var(--eb-ship-ink, #0d0d0f);
  font-weight: 600;
}
:where(.eb-brief-btn.is-primary:hover) {
  background: var(--eb-ship-hover, #ffffff);
}
:where(.eb-brief-split) {
  position: relative;
  display: inline-flex;
  align-items: center;
}
:where(.eb-brief-split .eb-brief-split-main) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right-width: 0;
  padding-right: 9px;
}
:where(.eb-brief-split .eb-brief-split-caret) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  padding: 0 7px;
}
:where(.eb-brief-split-menu) {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 30;
  min-width: 196px;
  padding: 4px;
  border-radius: 11px;
  background: var(--eb-popover-bg, rgba(22, 22, 26, 0.98));
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
  box-shadow: var(--eb-shadow-popover, 0 12px 30px rgba(0, 0, 0, 0.48));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
:where(.eb-brief-split-menu[hidden]) {
  display: none;
}
:where(.eb-brief-split-opt) {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-primary, #f4f4f5);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-sans, system-ui, sans-serif);
}
:where(.eb-brief-split-opt:hover) {
  background: var(--eb-pill-hover, rgba(255, 255, 255, 0.09));
}
:where(.eb-brief-split-opt-label) {
  font-size: 12px;
  font-weight: 500;
}
:where(.eb-brief-split-opt-hint) {
  font-size: 10.5px;
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-status-bar) {
  display: flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  color: var(--ink-secondary, #a1a1aa);
}
:where(.eb-brief-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
:where(.eb-brief-head-left) {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  min-width: 0;
}
:where(.eb-brief-engine) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 9999px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
:where(.eb-brief-engine.is-g4) {
  background: rgba(52, 211, 153, 0.13);
  border: 1px solid rgba(52, 211, 153, 0.30);
  color: var(--eb-brain, #34d399);
}
:where(html[data-theme="light"] .eb-brief-engine.is-g4) {
  background: rgba(22, 163, 74, 0.10);
  border-color: rgba(22, 163, 74, 0.28);
  color: #15803d;
}
:where(.eb-brief-engine.is-deterministic) {
  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.09));
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-latency) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-headline) {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.42;
  letter-spacing: -0.01em;
  color: var(--ink-primary, #f4f4f5);
}
:where(.eb-brief-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
:where(.eb-brief-col) {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--eb-stage-elevated, #17171a);
  border: 1px solid var(--eb-border-subtle, rgba(255, 255, 255, 0.06));
  min-width: 0;
}
:where(.eb-brief-col-label) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-col.is-blocked .eb-brief-col-label) {
  color: var(--eb-warn, #f59e0b);
}
:where(.eb-brief-list) {
  margin: 0;
  padding-left: 15px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  line-height: 1.44;
  color: var(--ink-secondary, #d4d4d8);
}
:where(.eb-brief-list-empty) {
  margin: 0;
  font-size: 12px;
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-next) {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--eb-mention-bg, rgba(56, 189, 248, 0.10));
  border: 1px solid var(--eb-codex-border, rgba(56, 189, 248, 0.24));
  min-width: 0;
}
:where(.eb-brief-next-label) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--eb-codex, #56b6f9);
  flex-shrink: 0;
}
:where(.eb-brief-next-text) {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.42;
  color: var(--ink-primary, #f4f4f5);
  min-width: 0;
}
:where(.eb-brief-directive) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px;
  border-radius: 10px;
  background: var(--eb-frame-bg, #0d0d0f);
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));
}
:where(.eb-brief-directive-label) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted, #71717a);
}
:where(.eb-brief-directive-text) {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.48;
  color: var(--ink-primary, #f4f4f5);
  white-space: pre-wrap;
  word-break: break-word;
}
:where(.eb-brief-directive-actions) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 7px;
}
:where(.eb-brief-promote-inline) {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
:where(.eb-brief-section-select) {
  height: 27px;
  padding: 0 8px;
  border-radius: 9999px;
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
  background: var(--eb-card-bg, #18181b);
  color: var(--ink-primary, #f4f4f5);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  cursor: pointer;
}

/* Decision Verdict Bar (Evil Rabbit WCAG AA Spec) */
:where(.eb-verdict-wrap) {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
:where(.eb-verdict-bar) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
:where(.eb-verdict-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 9999px;
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
}
:where(.eb-verdict-wrap.is-compact .eb-verdict-btn) {
  height: 25px;
  padding: 0 9px;
  font-size: 11.5px;
}
:where(.eb-verdict-btn.is-approve) {
  background: var(--eb-ship-bg, #ededed);
  border-color: transparent;
  color: var(--eb-ship-ink, #0d0d0f);
  font-weight: 600;
}
:where(.eb-verdict-btn.is-approve:hover) {
  background: var(--eb-ship-hover, #ffffff);
}
:where(.eb-verdict-dot.is-approve) {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #16a34a;
  flex-shrink: 0;
}
:where(.eb-verdict-btn.is-revise) {
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(245, 158, 11, 0.34);
  color: #fbbf24;
}
:where(.eb-verdict-btn.is-revise:hover) {
  background: rgba(245, 158, 11, 0.22);
  border-color: rgba(245, 158, 11, 0.48);
}
:where(html[data-theme="light"] .eb-verdict-btn.is-revise) {
  background: rgba(180, 83, 9, 0.10);
  border-color: rgba(180, 83, 9, 0.30);
  color: #92400e;
}
:where(.eb-verdict-btn.is-defer) {
  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.06));
  border-color: var(--eb-border, rgba(255, 255, 255, 0.10));
  color: var(--ink-secondary, #a1a1aa);
}
:where(.eb-verdict-btn.is-defer:hover) {
  background: var(--eb-pill-hover, rgba(255, 255, 255, 0.10));
  color: var(--ink-primary, #f4f4f5);
}
:where(.eb-verdict-kbd) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid currentColor;
  opacity: 0.65;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 9.5px;
  font-weight: 500;
  line-height: 1;
}
:where(.eb-verdict-confirm) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 11px;
  background: var(--eb-stage-elevated, #17171a);
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
}
:where(.eb-verdict-note-input) {
  flex: 1 1 180px;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--eb-border-strong, rgba(255, 255, 255, 0.14));
  background: var(--eb-composer-bg, #19191d);
  color: var(--ink-primary, #f4f4f5);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
}
:where(.eb-verdict-note-input:focus) {
  outline: 2px solid var(--eb-border-focus, rgba(37, 99, 235, 0.65));
  outline-offset: 1px;
}
:where(.eb-verdict-resume-tag) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--eb-brain, #34d399);
  padding: 2px 7px;
  border-radius: 9999px;
  background: rgba(52, 211, 153, 0.12);
  border: 1px solid rgba(52, 211, 153, 0.28);
}
:where(.eb-verdict-error) {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(244, 63, 94, 0.10);
  border: 1px solid rgba(244, 63, 94, 0.30);
  color: var(--eb-danger, #f43f5e);
  font-size: 12px;
  line-height: 1.4;
}
:where(.eb-verdict-receipt),
:where(.eb-promote-receipt) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 11px;
  border-radius: 10px;
  background: rgba(52, 211, 153, 0.10);
  border: 1px solid rgba(52, 211, 153, 0.28);
  color: var(--eb-brain, #34d399);
  font-size: 12px;
}
:where(html[data-theme="light"] .eb-verdict-receipt),
:where(html[data-theme="light"] .eb-promote-receipt) {
  color: #15803d;
}

/* Context Stage (4th Right-Hand Stage Tab) */
:where(.eb-ctx-stage) {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
:where(.eb-ctx-section) {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}
:where(.eb-ctx-section-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
}
:where(.eb-ctx-section-title) {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted, #71717a);
}
:where(.eb-ctx-count) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted, #71717a);
}
:where(.eb-ctx-group-list) {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
:where(.eb-ctx-group) {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--eb-card-bg, #18181b);
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));
}
:where(.eb-ctx-group-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-muted, #71717a);
}
:where(.eb-ctx-entity-grid) {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
:where(.eb-ctx-entity-row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--eb-border-subtle, rgba(255, 255, 255, 0.06));
  background: var(--eb-stage-elevated, #17171a);
  color: var(--ink-primary, #f4f4f5);
  text-align: left;
  cursor: pointer;
  transition: background-color 130ms ease, border-color 130ms ease;
}
:where(.eb-ctx-entity-row:hover) {
  background: var(--eb-card-hover, #1d1d21);
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.15));
}
:where(.eb-ctx-entity-main) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
:where(.eb-ctx-entity-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.06));
  color: var(--ink-secondary, #a1a1aa);
  flex-shrink: 0;
}
:where(.eb-ctx-entity-copy) {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
:where(.eb-ctx-entity-title) {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-primary, #f4f4f5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:where(.eb-ctx-entity-sub) {
  font-size: 11px;
  color: var(--ink-muted, #71717a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:where(.eb-ctx-entity-tag) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--ink-secondary, #a1a1aa);
  padding: 2px 7px;
  border-radius: 9999px;
  background: var(--eb-pill-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--eb-border-subtle, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}
:where(.eb-ctx-quick-strip) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
:where(.eb-ctx-quick-card) {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));
  background: var(--eb-stage-elevated, #17171a);
  color: var(--ink-primary, #f4f4f5);
  text-align: left;
  cursor: pointer;
  min-width: 0;
  transition: background-color 130ms ease, border-color 130ms ease;
}
:where(.eb-ctx-quick-card:hover) {
  background: var(--eb-card-hover, #1d1d21);
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.16));
}
:where(.eb-ctx-related-list) {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
:where(.eb-ctx-related-row) {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.08));
  background: var(--eb-card-bg, #18181b);
  color: var(--ink-primary, #f4f4f5);
  text-align: left;
  cursor: pointer;
  min-width: 0;
  transition: background-color 130ms ease, border-color 130ms ease;
}
:where(.eb-ctx-related-row:hover) {
  background: var(--eb-card-hover, #1d1d21);
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.16));
}
:where(.eb-ctx-related-top) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--ink-muted, #71717a);
}
:where(.eb-ctx-related-title) {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-primary, #f4f4f5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:where(.eb-ctx-related-chips) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
:where(.eb-ctx-promote-bar) {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
:where(.eb-ctx-promote-btn) {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 11px;
  border-radius: 11px;
  border: 1px solid var(--eb-border, rgba(255, 255, 255, 0.09));
  background: var(--eb-card-bg, #18181b);
  color: var(--ink-primary, #f4f4f5);
  text-align: left;
  cursor: pointer;
  min-width: 0;
  transition: background-color 130ms ease, border-color 130ms ease;
}
:where(.eb-ctx-promote-btn:hover) {
  background: var(--eb-card-hover, #1d1d21);
  border-color: var(--eb-border-strong, rgba(255, 255, 255, 0.18));
}
:where(.eb-ctx-promote-btn-title) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
}
:where(.eb-ctx-promote-btn-hint) {
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--ink-muted, #71717a);
}
@media (max-width: 560px) {
  :where(.eb-brief-grid),
  :where(.eb-ctx-quick-strip),
  :where(.eb-ctx-promote-bar) {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  :where(.eb-brief-card, .eb-verdict-wrap, .eb-ctx-stage) * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
`;
    }

    function ensureStyles(targetDoc) {
      const doc = targetDoc || getDoc();
      if (!doc || !doc.head || typeof doc.getElementById !== 'function') return;
      if (doc.getElementById(STYLE_ID)) return;
      try {
        const styleEl = doc.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = getStyles();
        doc.head.appendChild(styleEl);
      } catch {
        // Non-DOM or constrained environment; ignore cleanly.
      }
    }

    /* ========================================================================
       3. RENDERER 1: renderLocalLlmBriefCard(briefState, opts)
       ======================================================================== */

    function renderPromoteSplitButton(threadId, channel, defaultSection) {
      const activeSection = normalizeSection(defaultSection || 'actions');
      const optionsHtml = CODEX_SECTIONS.map(
        (sec) =>
          `<button type="button" class="eb-brief-split-opt" role="menuitem" data-ctx-action="promote-codex" data-section="${escapeAttr(sec.id)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">` +
            `<span class="eb-brief-split-opt-label">${escapeHtml(sec.label)}</span>` +
            `<span class="eb-brief-split-opt-hint">${escapeHtml(sec.hint)}</span>` +
          `</button>`
      ).join('');

      return (
        `<div class="eb-brief-split" data-ctx-split="promote">` +
          `<button type="button" class="eb-brief-btn eb-brief-split-main" data-ctx-action="promote-codex" data-section="${escapeAttr(activeSection)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" title="Promote thread to Codex">` +
            `${ICONS.promote}<span>Promote -&gt; Codex</span>` +
          `</button>` +
          `<button type="button" class="eb-brief-btn eb-brief-split-caret" data-ctx-action="toggle-promote-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Choose Codex section">` +
            `${ICONS.chevronDown}` +
          `</button>` +
          `<div class="eb-brief-split-menu" data-ctx-ref="promote-menu" role="menu" hidden>${optionsHtml}</div>` +
        `</div>`
      );
    }

    function renderPromoteReceiptHtml(receipt) {
      if (!receipt || typeof receipt !== 'object') return '';
      const codexItem =
        receipt.codexItem && typeof receipt.codexItem === 'object' ? receipt.codexItem : null;
      const secMeta = getSectionMeta(
        (codexItem && codexItem.section) || receipt.section || 'actions'
      );
      const entryId = String(
        (codexItem && (codexItem.id || codexItem.itemId)) ||
          receipt.id ||
          receipt.itemId ||
          receipt.entryId ||
          ''
      ).trim();
      const title = stripEmDash(
        (codexItem && codexItem.title) || receipt.title || secMeta.label
      ).trim();
      return (
        `<div class="eb-promote-receipt" role="status" aria-live="polite">` +
          `<span>${ICONS.check} Promoted to Codex (${escapeHtml(secMeta.label)}): ${escapeHtml(truncateText(title, 64))}</span>` +
          `<button type="button" class="eb-brief-btn" data-ctx-action="open-codex" data-codex-section="${escapeAttr(secMeta.id)}" data-codex-id="${escapeAttr(entryId)}">` +
            `<span>Open in Codex</span>${ICONS.arrowRight}` +
          `</button>` +
        `</div>`
      );
    }

    function renderLocalLlmBriefCard(briefState, opts) {
      ensureStyles();
      const o = opts && typeof opts === 'object' ? opts : {};
      const threadInfo = extractThreadIdentity(o.thread, o.channel);
      const threadId = String(o.threadId || threadInfo.threadId || '').trim();
      const channel = String(o.channel || threadInfo.channel || 'box').replace(/^#+/, '').trim();
      const placement = String(o.placement || 'thread');
      const selectedSection = normalizeSection(o.section || (briefState && briefState.promoteSection) || 'actions');
      const promoteReceipt = o.promoteReceipt || (briefState && briefState.promoteReceipt) || null;
      const promoteError = stripEmDash(o.promoteError || (briefState && briefState.promoteError) || '').trim();
      const parsed = normalizeBriefResult(briefState);

      if (parsed.mode === 'loading') {
        return (
          `<section class="eb-brief-card is-loading" data-ctx-component="brief-card" data-placement="${escapeAttr(placement)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" aria-busy="true">` +
            `<div class="eb-brief-status-bar">` +
              `<span class="eb-brief-dot" aria-hidden="true"></span>` +
              `<span>Synthesizing thread on Local LLM (:8003)...</span>` +
            `</div>` +
            `<span class="eb-brief-latency">G4 :8003</span>` +
          `</section>`
        );
      }

      if (parsed.mode === 'error') {
        return (
          `<section class="eb-brief-card is-error" data-ctx-component="brief-card" data-placement="${escapeAttr(placement)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">` +
            `<div class="eb-brief-head">` +
              `<span class="eb-brief-bar-title"><span class="eb-brief-dot is-muted" aria-hidden="true"></span>LOCAL LLM // THREAD BRIEF</span>` +
              `<div class="eb-brief-bar-actions">` +
                `<button type="button" class="eb-brief-btn is-primary" data-ctx-action="brief-g4" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">&#10022; Brief with G4</button>` +
                `${renderPromoteSplitButton(threadId, channel, selectedSection)}` +
              `</div>` +
            `</div>` +
            `<div class="eb-verdict-error" role="alert">${escapeHtml(parsed.error)}</div>` +
            `<div data-ctx-ref="promote-feedback-slot">${promoteReceipt ? renderPromoteReceiptHtml(promoteReceipt) : ''}</div>` +
          `</section>`
        );
      }

      if (parsed.mode === 'idle' || !parsed.result) {
        return (
          `<section class="eb-brief-card is-idle" data-ctx-component="brief-card" data-placement="${escapeAttr(placement)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">` +
            `<div class="eb-brief-bar-title">` +
              `<span class="eb-brief-dot" aria-hidden="true"></span>` +
              `<span>LOCAL LLM // THREAD BRIEF</span>` +
            `</div>` +
            `<div class="eb-brief-bar-actions">` +
              `<button type="button" class="eb-brief-btn is-primary" data-ctx-action="brief-g4" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">&#10022; Brief with G4</button>` +
              `${renderPromoteSplitButton(threadId, channel, selectedSection)}` +
            `</div>` +
            `<div data-ctx-ref="promote-feedback-slot" style="flex:1 0 100%;display:contents;">` +
              `${promoteError ? `<div class="eb-verdict-error" style="flex:1 0 100%;" role="alert">${escapeHtml(promoteError)}</div>` : ''}` +
              `${promoteReceipt ? `<div style="flex:1 0 100%;">${renderPromoteReceiptHtml(promoteReceipt)}</div>` : ''}` +
            `</div>` +
          `</section>`
        );
      }

      const r = parsed.result;
      const engineClass = r.isG4 ? 'is-g4' : 'is-deterministic';
      const latencyStr = r.latencyMs != null ? formatLatency(r.latencyMs) : '';

      const decidedHtml = r.decided.length
        ? `<ul class="eb-brief-list">${r.decided.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : '<p class="eb-brief-list-empty">No locked decisions captured yet.</p>';

      const blockedHtml = r.blocked.length
        ? `<ul class="eb-brief-list">${r.blocked.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : '<p class="eb-brief-list-empty">No active blockers flagged.</p>';

      const extraActions = safeArray(r.nextActions).filter(
        (act) =>
          act &&
          act.toLowerCase() !== (r.nextMove || '').toLowerCase() &&
          act.toLowerCase() !== (r.headline || '').toLowerCase()
      );
      const nextMoveHtml = r.nextMove
        ? `<div class="eb-brief-next">` +
            `<span class="eb-brief-next-label">NEXT MOVE</span>` +
            `<div class="eb-brief-next-text">` +
              `<div>${escapeHtml(r.nextMove)}</div>` +
              `${
                extraActions.length
                  ? `<ul class="eb-brief-list" style="margin-top:4px;">${extraActions
                      .slice(0, 3)
                      .map((act) => `<li>${escapeHtml(act)}</li>`)
                      .join('')}</ul>`
                  : ''
              }` +
            `</div>` +
          `</div>`
        : '';

      const directiveText = r.suggestedDirective || r.nextMove || r.headline;
      const sectionOptionsHtml = CODEX_SECTIONS.map(
        (sec) =>
          `<option value="${escapeAttr(sec.id)}"${sec.id === selectedSection ? ' selected' : ''}>${escapeHtml(sec.id)} (${escapeHtml(sec.shortLabel)})</option>`
      ).join('');

      return (
        `<section class="eb-brief-card is-result" data-ctx-component="brief-card" data-placement="${escapeAttr(placement)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" data-directive="${escapeAttr(directiveText)}" data-headline="${escapeAttr(r.headline)}">` +
          `<div class="eb-brief-head">` +
            `<div class="eb-brief-head-left">` +
              `<span class="eb-brief-engine ${engineClass}">` +
                `<span class="eb-brief-dot${r.isG4 ? '' : ' is-muted'}" aria-hidden="true"></span>` +
                `<span>${escapeHtml(r.engineLabel)}</span>` +
              `</span>` +
              `${latencyStr ? `<span class="eb-brief-latency">${escapeHtml(latencyStr)}</span>` : ''}` +
              `${r.model ? `<span class="eb-brief-latency">${escapeHtml(r.model)}</span>` : ''}` +
            `</div>` +
            `<button type="button" class="eb-brief-btn" data-ctx-action="brief-g4" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" title="Re-synthesize with Local LLM">` +
              `${ICONS.refresh}<span>Re-brief</span>` +
            `</button>` +
          `</div>` +
          `<h4 class="eb-brief-headline">${escapeHtml(r.headline)}</h4>` +
          `<div class="eb-brief-grid">` +
            `<div class="eb-brief-col is-decided">` +
              `<span class="eb-brief-col-label">DECIDED</span>` +
              `${decidedHtml}` +
            `</div>` +
            `<div class="eb-brief-col is-blocked">` +
              `<span class="eb-brief-col-label">BLOCKED</span>` +
              `${blockedHtml}` +
            `</div>` +
          `</div>` +
          `${nextMoveHtml}` +
          `<div class="eb-brief-directive">` +
            `<span class="eb-brief-directive-label">OWNER DIRECTIVE</span>` +
            `<p class="eb-brief-directive-text" data-ctx-ref="directive-text">${escapeHtml(directiveText)}</p>` +
            `<div class="eb-brief-directive-actions">` +
              `<button type="button" class="eb-brief-btn is-primary" data-ctx-action="paste-directive" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" data-directive="${escapeAttr(directiveText)}">` +
                `${ICONS.paste}<span>Paste to Composer</span>` +
              `</button>` +
              `<div class="eb-brief-promote-inline">` +
                `<select class="eb-brief-section-select" data-ctx-ref="promote-section" aria-label="Codex target section">${sectionOptionsHtml}</select>` +
                `<button type="button" class="eb-brief-btn" data-ctx-action="promote-codex" data-section="${escapeAttr(selectedSection)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}">` +
                  `${ICONS.promote}<span>Promote to Codex</span>` +
                `</button>` +
              `</div>` +
            `</div>` +
          `</div>` +
          `<div data-ctx-ref="promote-feedback-slot">` +
            `${promoteError ? `<div class="eb-verdict-error" role="alert">${escapeHtml(promoteError)}</div>` : ''}` +
            `${promoteReceipt ? renderPromoteReceiptHtml(promoteReceipt) : ''}` +
          `</div>` +
        `</section>`
      );
    }

    /* ========================================================================
       4. RENDERER 2: renderDecisionVerdictBar(threadItem, opts)
       ======================================================================== */

    function buildVerdictText(verdictKey, threadItem, customNote) {
      const key = String(verdictKey || 'approve').toLowerCase();
      const spec = VERDICT_SPECS[key] || VERDICT_SPECS.approve;
      const info = extractThreadIdentity(threadItem);
      const note =
        customNote != null && String(customNote).trim()
          ? stripEmDash(customNote).trim()
          : info.isPaused
            ? spec.pausedNote
            : spec.defaultNote;
      const prefix = `[OWNER VERDICT: ${spec.tag}]`;
      if (note.toUpperCase().startsWith(prefix)) {
        return note;
      }
      return `${prefix} ${note}`.trim();
    }

    function renderDecisionVerdictBar(threadItem, opts) {
      ensureStyles();
      const o = opts && typeof opts === 'object' ? opts : {};
      const info = extractThreadIdentity(threadItem, o.channel);
      if (!info.threadId) return '';
      if (o.onlyWhenNeeded && !needsDecisionVerdict(threadItem)) return '';

      const compact = Boolean(o.compact || o.variant === 'canvas');
      const pendingKey = o.pendingVerdict ? String(o.pendingVerdict).toLowerCase() : '';
      const activeSpec = pendingKey && VERDICT_SPECS[pendingKey] ? VERDICT_SPECS[pendingKey] : null;
      const noteValue = activeSpec
        ? stripEmDash(
            o.pendingNote != null ? o.pendingNote : buildVerdictText(activeSpec.key, threadItem)
          )
        : '';
      const submitting = Boolean(o.submitting);
      const errorText = stripEmDash(o.error || '').trim();
      const errorStatus = o.errorStatus != null ? Number(o.errorStatus) : null;
      const submitted = o.submittedVerdict || null;

      const confirmHtml = activeSpec
        ? `<div class="eb-verdict-confirm" data-ctx-ref="verdict-confirm" data-verdict="${escapeAttr(activeSpec.key)}">` +
            `<input type="text" class="eb-verdict-note-input" data-ctx-ref="verdict-note-input" value="${escapeAttr(noteValue)}" aria-label="Owner verdict reply note" placeholder="[OWNER VERDICT: ${escapeAttr(activeSpec.tag)}] ..."${submitting ? ' disabled' : ''}>` +
            `${info.isPaused ? `<span class="eb-verdict-resume-tag" title="Will resume paused execution on post">resumePaused</span>` : ''}` +
            `<button type="button" class="eb-verdict-btn is-approve" data-ctx-action="verdict-confirm" data-verdict="${escapeAttr(activeSpec.key)}" data-thread-id="${escapeAttr(info.threadId)}" data-channel="${escapeAttr(info.channel)}" data-paused="${info.isPaused ? '1' : '0'}"${submitting ? ' disabled' : ''}>` +
              `${ICONS.check}<span>${submitting ? 'Posting...' : 'Confirm &amp; Post'}</span>` +
            `</button>` +
            `<button type="button" class="eb-verdict-btn is-defer" data-ctx-action="verdict-cancel" aria-label="Cancel verdict"${submitting ? ' disabled' : ''}>` +
              `${ICONS.close}<span>Cancel</span>` +
            `</button>` +
          `</div>`
        : '';

      const errorHtml = errorText
        ? `<div class="eb-verdict-error${errorStatus === 422 ? ' is-secret' : ''}" data-ctx-ref="verdict-error" role="alert">` +
            `${errorStatus === 422 ? '<strong>Secret guard (422):</strong> ' : ''}${escapeHtml(errorText)}` +
          `</div>`
        : '';

      const receiptHtml =
        submitted && submitted.tag
          ? `<div class="eb-verdict-receipt" data-ctx-ref="verdict-receipt" role="status" aria-live="polite">` +
              `<span>${ICONS.check} Posted verdict: <strong>${escapeHtml(submitted.tag)}</strong>${submitted.id ? ` (#${escapeHtml(submitted.id)})` : ''}${submitted.resumed ? ' · Resumed paused task' : ''}</span>` +
            `</div>`
          : '';

      return (
        `<div class="eb-verdict-wrap${compact ? ' is-compact' : ''}" data-ctx-component="verdict-bar" data-thread-id="${escapeAttr(info.threadId)}" data-channel="${escapeAttr(info.channel)}" data-paused="${info.isPaused ? '1' : '0'}">` +
          `<div class="eb-verdict-bar" role="group" aria-label="Owner decision verdicts for thread ${escapeAttr(formatShortThreadId(info.threadId))}">` +
            `<button type="button" class="eb-verdict-btn is-approve" data-ctx-action="verdict-select" data-verdict="approve" data-thread-id="${escapeAttr(info.threadId)}" data-channel="${escapeAttr(info.channel)}" data-paused="${info.isPaused ? '1' : '0'}" aria-expanded="${activeSpec && activeSpec.key === 'approve' ? 'true' : 'false'}">` +
              `<span class="eb-verdict-dot is-approve" aria-hidden="true"></span>` +
              `<span>Approve</span>` +
              `<kbd class="eb-verdict-kbd" aria-hidden="true">A</kbd>` +
            `</button>` +
            `<button type="button" class="eb-verdict-btn is-revise" data-ctx-action="verdict-select" data-verdict="revise" data-thread-id="${escapeAttr(info.threadId)}" data-channel="${escapeAttr(info.channel)}" data-paused="${info.isPaused ? '1' : '0'}" aria-expanded="${activeSpec && activeSpec.key === 'revise' ? 'true' : 'false'}">` +
              `<span>Revise</span>` +
              `<kbd class="eb-verdict-kbd" aria-hidden="true">R</kbd>` +
            `</button>` +
            `<button type="button" class="eb-verdict-btn is-defer" data-ctx-action="verdict-select" data-verdict="defer" data-thread-id="${escapeAttr(info.threadId)}" data-channel="${escapeAttr(info.channel)}" data-paused="${info.isPaused ? '1' : '0'}" aria-expanded="${activeSpec && activeSpec.key === 'defer' ? 'true' : 'false'}">` +
              `<span>Defer</span>` +
              `<kbd class="eb-verdict-kbd" aria-hidden="true">D</kbd>` +
            `</button>` +
          `</div>` +
          `<div data-ctx-ref="verdict-confirm-slot">${confirmHtml}</div>` +
          `<div data-ctx-ref="verdict-feedback-slot">${errorHtml}${receiptHtml}</div>` +
        `</div>`
      );
    }

    /* ========================================================================
       5. RENDERER 3: renderContextStage({ thread, channel, contextData, briefState, loading }, hooks)
       ======================================================================== */

    function renderEntityGroup(label, count, rowsHtml) {
      return (
        `<div class="eb-ctx-group">` +
          `<div class="eb-ctx-group-head">` +
            `<span>${escapeHtml(label)}</span>` +
            `<span class="eb-ctx-count">${count}</span>` +
          `</div>` +
          `<div class="eb-ctx-entity-grid">${rowsHtml}</div>` +
        `</div>`
      );
    }

    function renderLinkedEntitiesSection(ctx, threadInfo, loading) {
      if (loading && ctx.totalEntities === 0) {
        return (
          `<section class="eb-ctx-section" data-ctx-section="entities" aria-busy="true">` +
            `<header class="eb-ctx-section-head">` +
              `<h4 class="eb-ctx-section-title">Linked Kizuki Mind Entities</h4>` +
              `<span class="eb-ctx-count">resolving...</span>` +
            `</header>` +
            `<div class="eb-ctx-group"><p class="eb-brief-list-empty">Resolving people, vault docs, codex entries, taste rules, replay days, and commits...</p></div>` +
          `</section>`
        );
      }

      const groups = [];

      if (ctx.people.length) {
        const rows = ctx.people
          .map(
            (p) =>
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-person" data-person-key="${escapeAttr(p.key)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.person}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(p.name)}</span>` +
                    `${p.role || p.snippet ? `<span class="eb-ctx-entity-sub">${escapeHtml(p.role || p.snippet)}</span>` : ''}` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">People</span>` +
              `</button>`
          )
          .join('');
        groups.push(renderEntityGroup('People', ctx.people.length, rows));
      }

      if (ctx.vaultDocs.length) {
        const rows = ctx.vaultDocs
          .map(
            (d) =>
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-vault-doc" data-doc-path="${escapeAttr(d.path)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.doc}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(d.title)}</span>` +
                    `<span class="eb-ctx-entity-sub">${escapeHtml(d.snippet || d.path || d.folder)}</span>` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">Vault</span>` +
              `</button>`
          )
          .join('');
        groups.push(renderEntityGroup('Vault Docs', ctx.vaultDocs.length, rows));
      }

      if (ctx.codexEntries.length) {
        const rows = ctx.codexEntries
          .map((c) => {
            const sec = getSectionMeta(c.section);
            return (
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-codex" data-codex-section="${escapeAttr(sec.id)}" data-codex-id="${escapeAttr(c.id)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.codex}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(c.title)}</span>` +
                    `<span class="eb-ctx-entity-sub">${escapeHtml(c.summary || c.stage || sec.label)}</span>` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">${escapeHtml(sec.shortLabel)}</span>` +
              `</button>`
            );
          })
          .join('');
        groups.push(renderEntityGroup('Codex Entries', ctx.codexEntries.length, rows));
      }

      if (ctx.tasteRules.length) {
        const rows = ctx.tasteRules
          .map(
            (t) =>
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-taste" data-taste-domain="${escapeAttr(t.domain)}" data-taste-id="${escapeAttr(t.id)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.taste}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(t.title)}</span>` +
                    `${t.summary || t.polarity ? `<span class="eb-ctx-entity-sub">${escapeHtml(t.summary || t.polarity)}</span>` : ''}` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">Taste · ${escapeHtml(t.domain)}</span>` +
              `</button>`
          )
          .join('');
        groups.push(renderEntityGroup('Taste Domains & Rules', ctx.tasteRules.length, rows));
      }

      if (ctx.replayDays.length) {
        const rows = ctx.replayDays
          .map(
            (r) =>
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-replay" data-replay-day="${escapeAttr(r.day)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.replay}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(r.title)}</span>` +
                    `${r.summary ? `<span class="eb-ctx-entity-sub">${escapeHtml(r.summary)}</span>` : ''}` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">${r.count != null ? `${r.count} evts` : 'Replay'}</span>` +
              `</button>`
          )
          .join('');
        groups.push(renderEntityGroup('Replay Days', ctx.replayDays.length, rows));
      }

      if (ctx.commits.length) {
        const rows = ctx.commits
          .map(
            (cm) =>
              `<button type="button" class="eb-ctx-entity-row" data-ctx-action="open-commit" data-commit-sha="${escapeAttr(cm.sha)}" title="Copy commit ${escapeAttr(cm.sha)}">` +
                `<span class="eb-ctx-entity-main">` +
                  `<span class="eb-ctx-entity-icon">${ICONS.commit}</span>` +
                  `<span class="eb-ctx-entity-copy">` +
                    `<span class="eb-ctx-entity-title">${escapeHtml(cm.shortSha)}${cm.repo ? ` · ${escapeHtml(cm.repo)}` : ''}</span>` +
                    `${cm.message ? `<span class="eb-ctx-entity-sub">${escapeHtml(cm.message)}</span>` : ''}` +
                  `</span>` +
                `</span>` +
                `<span class="eb-ctx-entity-tag">SHA</span>` +
              `</button>`
          )
          .join('');
        groups.push(renderEntityGroup('Commit SHAs', ctx.commits.length, rows));
      }

      if (groups.length > 0) {
        return (
          `<section class="eb-ctx-section" data-ctx-section="entities">` +
            `<header class="eb-ctx-section-head">` +
              `<h4 class="eb-ctx-section-title">Linked Kizuki Mind Entities</h4>` +
              `<span class="eb-ctx-count">${ctx.totalEntities} linked</span>` +
            `</header>` +
            `<div class="eb-ctx-group-list">${groups.join('')}</div>` +
          `</section>`
        );
      }

      // Smart Quick Attach / Cross-Reference Strip (never a dead empty void)
      const qx = inferQuickCrossRefs(threadInfo);
      return (
        `<section class="eb-ctx-section" data-ctx-section="entities" data-ctx-empty="quick-attach">` +
          `<header class="eb-ctx-section-head">` +
            `<h4 class="eb-ctx-section-title">Quick Attach / Cross-Reference</h4>` +
            `<span class="eb-ctx-count">#${escapeHtml(qx.room)}</span>` +
          `</header>` +
          `<div class="eb-ctx-quick-strip">` +
            `<button type="button" class="eb-ctx-quick-card" data-ctx-action="open-codex" data-codex-section="${escapeAttr(qx.codexSection)}" data-codex-query="${escapeAttr(qx.topicQuery)}">` +
              `<span class="eb-ctx-promote-btn-title">${ICONS.codex}<span>Codex · ${escapeHtml(qx.codexLabel)}</span></span>` +
              `<span class="eb-ctx-promote-btn-hint">Cross-check #${escapeHtml(qx.room)} against active planes</span>` +
            `</button>` +
            `<button type="button" class="eb-ctx-quick-card" data-ctx-action="open-vault-search" data-query="${escapeAttr(qx.topicQuery)}">` +
              `<span class="eb-ctx-promote-btn-title">${ICONS.doc}<span>Vault · Search "${escapeHtml(truncateText(qx.topicQuery, 20))}"</span></span>` +
              `<span class="eb-ctx-promote-btn-hint">Inspect matching canon notes &amp; specs</span>` +
            `</button>` +
            `<button type="button" class="eb-ctx-quick-card" data-ctx-action="open-taste" data-taste-domain="${escapeAttr(qx.tasteDomain)}">` +
              `<span class="eb-ctx-promote-btn-title">${ICONS.taste}<span>Taste · ${escapeHtml(qx.tasteDomain)}</span></span>` +
              `<span class="eb-ctx-promote-btn-hint">Verify owner taste rules for this domain</span>` +
            `</button>` +
            `<button type="button" class="eb-ctx-quick-card" data-ctx-action="open-replay" data-replay-day="${escapeAttr(qx.replayDay)}">` +
              `<span class="eb-ctx-promote-btn-title">${ICONS.replay}<span>Replay · ${escapeHtml(qx.replayDay)}</span></span>` +
              `<span class="eb-ctx-promote-btn-hint">Jump to timeline context for this day</span>` +
            `</button>` +
          `</div>` +
        `</section>`
      );
    }

    function renderRelatedThreadsSection(ctx, threadInfo) {
      const related = ctx.relatedThreads;
      const bodyHtml = related.length
        ? `<div class="eb-ctx-related-list">` +
            related
              .map((rt) => {
                const chipsHtml = rt.sharedEntities.length
                  ? `<div class="eb-ctx-related-chips">${rt.sharedEntities
                      .slice(0, 4)
                      .map((chip) => `<span class="eb-ctx-entity-tag">${escapeHtml(chip)}</span>`)
                      .join('')}</div>`
                  : '';
                return (
                  `<button type="button" class="eb-ctx-related-row" data-ctx-action="open-related-thread" data-thread-id="${escapeAttr(rt.threadId)}" data-channel="${escapeAttr(rt.channel)}">` +
                    `<div class="eb-ctx-related-top">` +
                      `<span>#${escapeHtml(rt.channel)} · ${escapeHtml(formatShortThreadId(rt.threadId))}</span>` +
                      `<span>${rt.lastAt ? escapeHtml(formatRelativeTime(rt.lastAt)) : (rt.replies != null ? `${rt.replies} replies` : '')}</span>` +
                    `</div>` +
                    `<span class="eb-ctx-related-title">${escapeHtml(rt.title)}</span>` +
                    `${rt.preview && rt.preview !== rt.title ? `<span class="eb-ctx-entity-sub">${escapeHtml(truncateText(rt.preview, 110))}</span>` : ''}` +
                    `${chipsHtml}` +
                  `</button>`
                );
              })
              .join('') +
          `</div>`
        : `<div class="eb-ctx-group">` +
            `<p class="eb-brief-list-empty">No cross-room threads share explicit entities with #${escapeHtml(threadInfo.channel)} yet. Run Brief with G4 to surface topic links.</p>` +
          `</div>`;

      return (
        `<section class="eb-ctx-section" data-ctx-section="related-threads">` +
          `<header class="eb-ctx-section-head">` +
            `<h4 class="eb-ctx-section-title">Related Board Threads</h4>` +
            `<span class="eb-ctx-count">${related.length}</span>` +
          `</header>` +
          `${bodyHtml}` +
        `</section>`
      );
    }

    function renderPromoteSection(threadInfo, promoteReceipt, promoteError) {
      const buttonsHtml = CODEX_SECTIONS.map(
        (sec) =>
          `<button type="button" class="eb-ctx-promote-btn" data-ctx-action="promote-codex" data-section="${escapeAttr(sec.id)}" data-thread-id="${escapeAttr(threadInfo.threadId)}" data-channel="${escapeAttr(threadInfo.channel)}">` +
            `<span class="eb-ctx-promote-btn-title">${ICONS.promote}<span>${escapeHtml(sec.label)}</span></span>` +
            `<span class="eb-ctx-promote-btn-hint">${escapeHtml(sec.hint)}</span>` +
          `</button>`
      ).join('');

      return (
        `<section class="eb-ctx-section" data-ctx-section="promote-mind-os">` +
          `<header class="eb-ctx-section-head">` +
            `<h4 class="eb-ctx-section-title">Promote to Kizuki Mind OS</h4>` +
            `<span class="eb-ctx-count">Codex</span>` +
          `</header>` +
          `<div class="eb-ctx-promote-bar">${buttonsHtml}</div>` +
          `<div data-ctx-ref="promote-feedback-slot">` +
            `${promoteError ? `<div class="eb-verdict-error" role="alert">${escapeHtml(promoteError)}</div>` : ''}` +
            `${promoteReceipt ? renderPromoteReceiptHtml(promoteReceipt) : ''}` +
          `</div>` +
        `</section>`
      );
    }

    function renderContextStage(params, hooks) {
      ensureStyles();
      const p = params && typeof params === 'object' ? params : {};
      const threadInfo = extractThreadIdentity(p.thread, p.channel);
      if (p.threadId && String(p.threadId).trim()) {
        threadInfo.threadId = String(p.threadId).trim();
      }
      const loading = Boolean(p.loading);
      const briefState = p.briefState || null;
      const promoteReceipt = p.promoteReceipt || (briefState && briefState.promoteReceipt) || null;
      const promoteError = stripEmDash(p.promoteError || (briefState && briefState.promoteError) || '').trim();

      if (!threadInfo.threadId && !p.thread && !p.contextData && !loading) {
        return (
          `<div class="eb-ctx-stage" data-ctx-component="context-stage">` +
            `<div class="eb-ctx-group">` +
              `<p class="eb-brief-list-empty">Select a thread from the stream to synthesize on Local LLM, inspect linked Kizuki Mind entities, or promote to Codex.</p>` +
            `</div>` +
          `</div>`
        );
      }

      const ctx = normalizeContextData(p.contextData);

      const briefSectionHtml =
        `<section class="eb-ctx-section" data-ctx-section="executive-brief">` +
          `<header class="eb-ctx-section-head">` +
            `<h4 class="eb-ctx-section-title">Local LLM Executive Brief</h4>` +
            `<span class="eb-ctx-count">${threadInfo.threadId ? escapeHtml(formatShortThreadId(threadInfo.threadId)) : ''}</span>` +
          `</header>` +
          `${renderLocalLlmBriefCard(briefState, {
            placement: 'context',
            thread: p.thread,
            threadId: threadInfo.threadId,
            channel: threadInfo.channel,
            promoteReceipt,
            promoteError,
          })}` +
        `</section>`;

      const entitiesSectionHtml = renderLinkedEntitiesSection(ctx, threadInfo, loading);
      const relatedSectionHtml = renderRelatedThreadsSection(ctx, threadInfo);
      const promoteSectionHtml = renderPromoteSection(threadInfo, promoteReceipt, promoteError);

      return (
        `<div class="eb-ctx-stage" data-ctx-component="context-stage" data-thread-id="${escapeAttr(threadInfo.threadId)}" data-channel="${escapeAttr(threadInfo.channel)}">` +
          `${briefSectionHtml}` +
          `${entitiesSectionHtml}` +
          `${relatedSectionHtml}` +
          `${promoteSectionHtml}` +
        `</div>`
      );
    }

    /* ========================================================================
       6. API HELPERS (SYNTHESIZE, CONTEXT, PROMOTE, VERDICT REPLY)
       ======================================================================== */

    function resolveFetch(opts) {
      if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
      const w = getWin();
      if (w && typeof w.fetch === 'function') return w.fetch.bind(w);
      if (typeof fetch === 'function') return fetch;
      throw new Error('No fetch implementation available');
    }

    async function readJsonSafe(res) {
      const text = await res.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { message: text };
      }
    }

    function formatApiError(data, status, fallback) {
      const body = data && typeof data === 'object' ? data : {};
      const base = stripEmDash(
        body.message || body.error || body.detail || fallback || `Request failed (${status})`
      ).trim();
      const rulesList = [];
      if (body.rule && typeof body.rule === 'string') {
        const cleanRule = stripEmDash(body.rule).trim();
        if (cleanRule) rulesList.push(cleanRule);
      }
      const findings = safeArray(body.findings);
      for (let i = 0; i < findings.length; i += 1) {
        const r = findings[i] && (findings[i].ruleId || findings[i].rule);
        if (r) {
          const cleanR = stripEmDash(String(r)).trim();
          if (cleanR && rulesList.indexOf(cleanR) === -1) rulesList.push(cleanR);
        }
      }
      const rules = rulesList.join(', ');
      if (rules && !base.toLowerCase().includes(rules.toLowerCase())) {
        return `${base} (${rules})`;
      }
      return base;
    }

    async function synthesizeThread(params, opts) {
      const p = params && typeof params === 'object' ? params : {};
      const fn = resolveFetch(opts);
      const res = await fn('/api/agent-board/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: String(p.threadId || ''),
          channel: String(p.channel || 'box').replace(/^#+/, ''),
          force: Boolean(p.force),
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: formatApiError(data, res.status, `Synthesis failed (${res.status})`),
          data,
        };
      }
      return { ok: true, status: res.status, data };
    }

    async function fetchContext(params, opts) {
      const p = params && typeof params === 'object' ? params : {};
      const fn = resolveFetch(opts);
      const qs = new URLSearchParams();
      if (p.threadId) qs.set('threadId', String(p.threadId));
      if (p.channel) qs.set('channel', String(p.channel).replace(/^#+/, ''));
      const res = await fn(`/api/agent-board/context?${qs.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: formatApiError(data, res.status, `Context lookup failed (${res.status})`),
          data,
        };
      }
      return { ok: true, status: res.status, data };
    }

    async function promoteToCodex(params, opts) {
      const p = params && typeof params === 'object' ? params : {};
      const fn = resolveFetch(opts);
      const section = normalizeSection(p.section || 'actions');
      const res = await fn('/api/agent-board/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: String(p.threadId || ''),
          channel: String(p.channel || 'box').replace(/^#+/, ''),
          section,
          title: p.title ? stripEmDash(p.title) : undefined,
          summary: p.summary ? stripEmDash(p.summary) : undefined,
          directive: p.directive ? stripEmDash(p.directive) : undefined,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: formatApiError(data, res.status, `Promote failed (${res.status})`),
          data,
        };
      }
      return {
        ok: true,
        status: res.status,
        data: Object.assign({ section }, data),
      };
    }

    async function submitVerdict(params, opts) {
      const p = params && typeof params === 'object' ? params : {};
      const fn = resolveFetch(opts);
      const key = String(p.verdict || 'approve').toLowerCase();
      const spec = VERDICT_SPECS[key] || VERDICT_SPECS.approve;
      const isPaused = Boolean(p.resumePaused || p.isPaused);
      const rawNote =
        p.note != null
          ? stripEmDash(p.note).trim()
          : p.text != null
            ? stripEmDash(p.text).trim()
            : '';
      const idempotencyKey =
        p.idempotencyKey ||
        `board-stage:${String(p.threadId || '').replace(/[^a-zA-Z0-9._-]/g, '_')}:${spec.key}:${Date.now()}`;
      const payload = {
        threadId: String(p.threadId || ''),
        verdict: spec.key,
        ...(rawNote ? { note: rawNote } : {}),
        idempotencyKey,
        resumePaused: isPaused,
      };
      const res = await fn('/api/decisions/stamp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || data.ok === false) {
        const findings = safeArray(data.findings);
        return {
          ok: false,
          status: res.status,
          error: formatApiError(
            data,
            res.status,
            res.status === 422 ? 'Blocked by secret guard (gitleaks)' : `Decision stamp failed (${res.status})`
          ),
          findings,
          data,
        };
      }
      const w = getWin();
      if (w && typeof w.dispatchEvent === 'function' && typeof w.CustomEvent === 'function') {
        try {
          w.dispatchEvent(
            new w.CustomEvent('kizuki:decision-stamped', {
              detail: {
                threadId: data.threadId || payload.threadId,
                verdict: spec.key,
                replyId: data.replyId || '',
                stampedAt: data.stampedAt || '',
                deduplicated: Boolean(data.deduplicated),
              },
            })
          );
        } catch {
          // ignore
        }
      }
      return {
        ok: true,
        status: res.status,
        verdict: spec.key,
        tag: spec.tag,
        resumed: isPaused,
        deduplicated: Boolean(data.deduplicated),
        undoExpiresAt: data.undoExpiresAt || '',
        id: data.replyId || data.id || data.messageId || data.numericId || '',
        data,
      };
    }

    async function undoVerdict(params, opts) {
      const p = params && typeof params === 'object' ? params : {};
      const fn = resolveFetch(opts);
      const res = await fn('/api/decisions/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: String(p.threadId || ''),
          ...(p.note ? { note: stripEmDash(p.note) } : {}),
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || data.ok === false) {
        return {
          ok: false,
          status: res.status,
          error: formatApiError(data, res.status, `Undo failed (${res.status})`),
          data,
        };
      }
      const w = getWin();
      if (w && typeof w.dispatchEvent === 'function' && typeof w.CustomEvent === 'function') {
        try {
          w.dispatchEvent(
            new w.CustomEvent('kizuki:decision-stamped', {
              detail: {
                threadId: data.threadId || String(p.threadId || ''),
                retracted: true,
              },
            })
          );
        } catch {
          // ignore
        }
      }
      return { ok: true, status: res.status, retracted: true, data };
    }

    /* ========================================================================
       7. INTERACTIVE EVENT DELEGATION & KEYBOARD SHORTCUTS (A / R / D)
       ======================================================================== */

    function isEditableTarget(el) {
      if (!el || typeof el !== 'object') return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function pasteDirectiveFallback(directive, rootEl) {
      const doc = getDoc();
      const scope = (rootEl && typeof rootEl.closest === 'function' && rootEl.closest('#view-board')) || doc;
      if (!scope || typeof scope.querySelector !== 'function') return false;
      const input = scope.querySelector('[data-eb-ref="composer-input"]');
      if (!input) return false;
      input.value = stripEmDash(directive);
      try {
        const w = getWin();
        const Ev = (w && w.Event) || (typeof Event !== 'undefined' ? Event : null);
        if (Ev) input.dispatchEvent(new Ev('input', { bubbles: true }));
      } catch {
        // ignore
      }
      try {
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }
      } catch {
        // ignore
      }
      return true;
    }

    function openVerdictConfirmInWrap(wrapEl, verdictKey) {
      if (!wrapEl) return;
      const spec = VERDICT_SPECS[String(verdictKey || '').toLowerCase()];
      if (!spec) return;
      const threadId = wrapEl.getAttribute('data-thread-id') || '';
      const channel = wrapEl.getAttribute('data-channel') || 'box';
      const isPaused = wrapEl.getAttribute('data-paused') === '1';
      const slot = wrapEl.querySelector('[data-ctx-ref="verdict-confirm-slot"]');
      const feedbackSlot = wrapEl.querySelector('[data-ctx-ref="verdict-feedback-slot"]');
      if (feedbackSlot) feedbackSlot.innerHTML = '';

      const existing = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-ctx-ref="verdict-confirm"]') : null;
      if (existing && typeof existing.getAttribute === 'function' && existing.getAttribute('data-verdict') === spec.key) {
        slot.innerHTML = '';
        syncVerdictExpanded(wrapEl, '');
        return;
      }

      const prefill = buildVerdictText(spec.key, { isPaused });
      if (slot) {
        slot.innerHTML =
          `<div class="eb-verdict-confirm" data-ctx-ref="verdict-confirm" data-verdict="${escapeAttr(spec.key)}">` +
            `<input type="text" class="eb-verdict-note-input" data-ctx-ref="verdict-note-input" value="${escapeAttr(prefill)}" aria-label="Owner verdict reply note">` +
            `${isPaused ? '<span class="eb-verdict-resume-tag" title="Will resume paused execution on post">resumePaused</span>' : ''}` +
            `<button type="button" class="eb-verdict-btn is-approve" data-ctx-action="verdict-confirm" data-verdict="${escapeAttr(spec.key)}" data-thread-id="${escapeAttr(threadId)}" data-channel="${escapeAttr(channel)}" data-paused="${isPaused ? '1' : '0'}">` +
              `${ICONS.check}<span>Confirm &amp; Post</span>` +
            `</button>` +
            `<button type="button" class="eb-verdict-btn is-defer" data-ctx-action="verdict-cancel" aria-label="Cancel verdict">` +
              `${ICONS.close}<span>Cancel</span>` +
            `</button>` +
          `</div>`;
        syncVerdictExpanded(wrapEl, spec.key);
        const input = slot.querySelector('[data-ctx-ref="verdict-note-input"]');
        if (input && typeof input.focus === 'function') {
          try {
            input.focus();
            if (typeof input.setSelectionRange === 'function') {
              const len = input.value.length;
              input.setSelectionRange(len, len);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    function syncVerdictExpanded(wrapEl, activeVerdict) {
      if (!wrapEl || typeof wrapEl.querySelectorAll !== 'function') return;
      const btns = wrapEl.querySelectorAll('[data-ctx-action="verdict-select"]');
      for (let i = 0; i < btns.length; i += 1) {
        const b = btns[i];
        b.setAttribute('aria-expanded', b.getAttribute('data-verdict') === activeVerdict ? 'true' : 'false');
      }
    }

    function bindEvents(rootEl, hooks) {
      if (!rootEl || typeof rootEl.addEventListener !== 'function') {
        return function noop() {};
      }
      ensureStyles();
      const h = hooks && typeof hooks === 'object' ? hooks : {};

      function toast(msg, tone) {
        if (typeof h.showToast === 'function') {
          h.showToast(stripEmDash(msg), tone || 'info');
        }
      }

      async function handleVerdictConfirm(wrapEl, triggerBtn) {
        if (!wrapEl) return;
        const confirmBox = wrapEl.querySelector('[data-ctx-ref="verdict-confirm"]');
        const input = wrapEl.querySelector('[data-ctx-ref="verdict-note-input"]');
        const feedbackSlot = wrapEl.querySelector('[data-ctx-ref="verdict-feedback-slot"]');
        const slot = wrapEl.querySelector('[data-ctx-ref="verdict-confirm-slot"]');
        const verdict =
          (triggerBtn && triggerBtn.getAttribute('data-verdict')) ||
          (confirmBox && confirmBox.getAttribute('data-verdict')) ||
          'approve';
        const threadId = wrapEl.getAttribute('data-thread-id') || '';
        const channel = wrapEl.getAttribute('data-channel') || 'box';
        const isPaused = wrapEl.getAttribute('data-paused') === '1';
        const text = (input && input.value) || buildVerdictText(verdict, { isPaused });

        if (triggerBtn) triggerBtn.disabled = true;
        if (input) input.disabled = true;
        if (feedbackSlot) feedbackSlot.innerHTML = '';

        let result;
        try {
          if (typeof h.onSubmitVerdict === 'function') {
            result = await h.onSubmitVerdict({
              threadId,
              channel,
              verdict,
              text,
              resumePaused: isPaused,
            });
          } else {
            result = await submitVerdict(
              { threadId, channel, verdict, text, resumePaused: isPaused },
              { fetchImpl: h.fetchImpl }
            );
          }
        } catch (err) {
          result = {
            ok: false,
            status: (err && err.status) || 500,
            error: stripEmDash((err && err.message) || 'Failed to post verdict'),
          };
        }

        if (result && result.ok) {
          playSound('advance');
          if (slot) slot.innerHTML = '';
          syncVerdictExpanded(wrapEl, '');
          const tag = (VERDICT_SPECS[verdict] && VERDICT_SPECS[verdict].tag) || verdict.toUpperCase();
          if (feedbackSlot) {
            feedbackSlot.innerHTML =
              `<div class="eb-verdict-receipt" data-ctx-ref="verdict-receipt" role="status" aria-live="polite">` +
                `<span>${ICONS.check} Posted verdict: <strong>${escapeHtml(tag)}</strong>${result.id ? ` (#${escapeHtml(result.id)})` : ''}${isPaused ? ' · Resumed paused task' : ''}${result.deduplicated ? ' · Already stamped' : ''}</span>` +
                `<button type="button" class="eb-brief-btn" data-ctx-action="verdict-undo" data-thread-id="${escapeAttr(threadId)}" style="margin-left:8px;height:22px;padding:0 8px;font-size:11px;">Undo (30s)</button>` +
              `</div>`;
          }
          toast(`Verdict posted: ${tag}`, 'ok');
          if (typeof h.onVerdictPosted === 'function') {
            h.onVerdictPosted(result, { threadId, channel, verdict, text, resumePaused: isPaused });
          }
        } else {
          if (triggerBtn) triggerBtn.disabled = false;
          if (input) input.disabled = false;
          const status = (result && result.status) || 0;
          const errMsg = stripEmDash((result && result.error) || 'Failed to post verdict');
          if (feedbackSlot) {
            feedbackSlot.innerHTML =
              `<div class="eb-verdict-error${status === 422 ? ' is-secret' : ''}" data-ctx-ref="verdict-error" role="alert">` +
                `${status === 422 ? '<strong>Secret guard (422):</strong> ' : ''}${escapeHtml(errMsg)}` +
              `</div>`;
          }
          toast(errMsg, 'error');
        }
      }

      async function handlePromote(actionEl) {
        const threadId = actionEl.getAttribute('data-thread-id') || '';
        const channel = actionEl.getAttribute('data-channel') || 'box';
        const card = actionEl.closest('[data-ctx-component="brief-card"]');
        const sectionSelect = card && card.querySelector('[data-ctx-ref="promote-section"]');
        const section = normalizeSection(
          (sectionSelect && !actionEl.classList.contains('eb-brief-split-opt') && sectionSelect.value) ||
            actionEl.getAttribute('data-section') ||
            'actions'
        );
        const title = (card && card.getAttribute('data-headline')) || '';
        const directive = (card && card.getAttribute('data-directive')) || '';

        const splitMenu = actionEl.closest('[data-ctx-split="promote"]')?.querySelector('[data-ctx-ref="promote-menu"]');
        if (splitMenu) splitMenu.hidden = true;

        playSound('click');

        let res;
        try {
          if (typeof h.onPromote === 'function') {
            res = await h.onPromote({ threadId, channel, section, title, directive });
          } else {
            res = await promoteToCodex(
              { threadId, channel, section, title, directive },
              { fetchImpl: h.fetchImpl }
            );
          }
        } catch (err) {
          res = {
            ok: false,
            error: stripEmDash((err && err.message) || 'Failed to promote thread to Codex'),
          };
        }

        const stageEl = actionEl.closest('[data-ctx-component="context-stage"]') || rootEl;
        const feedbackSlot =
          (card && card.querySelector('[data-ctx-ref="promote-feedback-slot"]')) ||
          (stageEl && stageEl.querySelector('[data-ctx-ref="promote-feedback-slot"]'));

        if (res && res.ok) {
          playSound('advance');
          const secMeta = getSectionMeta(section);
          const receipt = Object.assign({ section: secMeta.id, title: title || `Thread #${threadId}` }, res.data || {});
          if (feedbackSlot) {
            feedbackSlot.innerHTML = renderPromoteReceiptHtml(receipt);
          }
          toast(`Promoted to Codex (${secMeta.label})`, 'ok');
          if (typeof h.onPromoted === 'function') {
            h.onPromoted(receipt, { threadId, channel, section: secMeta.id });
          }
        } else {
          const errMsg = stripEmDash((res && res.error) || 'Failed to promote to Codex');
          if (feedbackSlot) {
            feedbackSlot.innerHTML = `<div class="eb-verdict-error" role="alert">${escapeHtml(errMsg)}</div>`;
          }
          toast(errMsg, 'error');
        }
      }

      const onClick = (event) => {
        const target =
          event && event.target && typeof event.target.closest === 'function' ? event.target : null;
        if (!target) return;

        // Close open promote split menus when clicking outside
        const insideSplit = target.closest('[data-ctx-split="promote"]');
        if (!insideSplit && typeof rootEl.querySelectorAll === 'function') {
          const openMenus = rootEl.querySelectorAll('[data-ctx-ref="promote-menu"]:not([hidden])');
          for (let i = 0; i < openMenus.length; i += 1) {
            openMenus[i].hidden = true;
          }
        }

        const actionEl = target.closest('[data-ctx-action]');
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-ctx-action');

        if (action === 'toggle-promote-menu') {
          playSound('click');
          const split = actionEl.closest('[data-ctx-split="promote"]');
          const menu = split && split.querySelector('[data-ctx-ref="promote-menu"]');
          if (menu) {
            const nextOpen = menu.hidden;
            menu.hidden = !nextOpen;
            actionEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
          }
          return;
        }

        if (action === 'brief-g4') {
          playSound('click');
          const threadId = actionEl.getAttribute('data-thread-id') || '';
          const channel = actionEl.getAttribute('data-channel') || 'box';
          if (typeof h.onSynthesize === 'function') {
            h.onSynthesize({ threadId, channel });
          }
          return;
        }

        if (action === 'paste-directive') {
          playSound('click');
          const card = actionEl.closest('[data-ctx-component="brief-card"]');
          const directive =
            actionEl.getAttribute('data-directive') ||
            (card && card.getAttribute('data-directive')) ||
            '';
          const threadId = actionEl.getAttribute('data-thread-id') || '';
          const channel = actionEl.getAttribute('data-channel') || 'box';
          if (!directive) return;
          if (typeof h.pasteToComposer === 'function') {
            h.pasteToComposer(stripEmDash(directive), { threadId, channel });
          } else {
            pasteDirectiveFallback(directive, rootEl);
          }
          toast('Loaded owner directive into composer', 'ok');
          return;
        }

        if (action === 'promote-codex') {
          handlePromote(actionEl);
          return;
        }

        if (action === 'verdict-select') {
          playSound('click');
          const wrap = actionEl.closest('[data-ctx-component="verdict-bar"]');
          const verdict = actionEl.getAttribute('data-verdict');
          openVerdictConfirmInWrap(wrap, verdict);
          return;
        }

        if (action === 'verdict-cancel') {
          playSound('click');
          const wrap = actionEl.closest('[data-ctx-component="verdict-bar"]');
          if (wrap) {
            const slot = wrap.querySelector('[data-ctx-ref="verdict-confirm-slot"]');
            if (slot) slot.innerHTML = '';
            syncVerdictExpanded(wrap, '');
          }
          return;
        }

        if (action === 'verdict-confirm') {
          playSound('click');
          const wrap = actionEl.closest('[data-ctx-component="verdict-bar"]');
          handleVerdictConfirm(wrap, actionEl);
          return;
        }

        if (action === 'verdict-undo') {
          playSound('click');
          const wrap = actionEl.closest('[data-ctx-component="verdict-bar"]');
          const threadId = actionEl.getAttribute('data-thread-id') || (wrap && wrap.getAttribute('data-thread-id')) || '';
          const feedbackSlot = wrap && wrap.querySelector('[data-ctx-ref="verdict-feedback-slot"]');
          if (!threadId) return;
          actionEl.disabled = true;
          undoVerdict({ threadId }, { fetchImpl: h.fetchImpl }).then((undoRes) => {
            if (undoRes && undoRes.ok) {
              if (feedbackSlot) {
                feedbackSlot.innerHTML =
                  `<div class="eb-verdict-receipt" data-ctx-ref="verdict-receipt" role="status" aria-live="polite">` +
                    `<span>Verdict retracted for #${escapeHtml(threadId)}.</span>` +
                  `</div>`;
              }
              toast('Verdict retracted', 'info');
            } else {
              actionEl.disabled = false;
              const errMsg = stripEmDash((undoRes && undoRes.error) || 'Undo failed');
              if (feedbackSlot) {
                feedbackSlot.innerHTML = `<div class="eb-verdict-error" role="alert">${escapeHtml(errMsg)}</div>`;
              }
              toast(errMsg, 'error');
            }
          });
          return;
        }

        if (action === 'open-person') {
          playSound('click');
          const key = actionEl.getAttribute('data-person-key') || '';
          if (key && typeof h.openPerson === 'function') {
            h.openPerson(key);
          }
          return;
        }

        if (action === 'open-vault-doc') {
          playSound('click');
          const docPath = actionEl.getAttribute('data-doc-path') || '';
          const fn = h.openDoc || h.openVaultDoc;
          if (docPath && typeof fn === 'function') {
            fn(docPath);
          }
          return;
        }

        if (action === 'open-vault-search') {
          playSound('click');
          const query = actionEl.getAttribute('data-query') || '';
          if (typeof h.openVaultSearch === 'function') {
            h.openVaultSearch(query);
          } else if (typeof h.switchView === 'function') {
            h.switchView('vault', { q: query });
          }
          return;
        }

        if (action === 'open-codex') {
          playSound('click');
          const section = normalizeSection(actionEl.getAttribute('data-codex-section') || 'actions');
          const itemId = actionEl.getAttribute('data-codex-id') || '';
          const q = actionEl.getAttribute('data-codex-query') || '';
          if (typeof h.openCodex === 'function') {
            h.openCodex({ section, itemId: itemId || undefined, q: q || undefined });
          } else if (typeof h.switchView === 'function') {
            h.switchView('codex', { section, itemId: itemId || undefined, q: q || undefined });
          }
          return;
        }

        if (action === 'open-taste') {
          playSound('click');
          const domain = actionEl.getAttribute('data-taste-domain') || 'all';
          const id = actionEl.getAttribute('data-taste-id') || '';
          if (typeof h.openTaste === 'function') {
            h.openTaste({ domain, id: id || undefined });
          } else if (typeof h.switchView === 'function') {
            h.switchView('taste', { domain });
          }
          return;
        }

        if (action === 'open-replay') {
          playSound('click');
          const day = actionEl.getAttribute('data-replay-day') || '';
          if (day && typeof h.openReplay === 'function') {
            h.openReplay(day);
          } else if (typeof h.switchView === 'function') {
            h.switchView('replay', { day: day || undefined });
          }
          return;
        }

        if (action === 'open-commit') {
          playSound('click');
          const sha = actionEl.getAttribute('data-commit-sha') || '';
          if (!sha) return;
          if (typeof h.openCommit === 'function') {
            h.openCommit(sha);
            return;
          }
          const w = getWin();
          if (w && w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
            Promise.resolve(w.navigator.clipboard.writeText(sha)).catch(() => {});
          }
          toast(`Copied commit SHA ${sha.slice(0, 8)}`, 'ok');
          return;
        }

        if (action === 'open-related-thread') {
          playSound('click');
          const threadId = actionEl.getAttribute('data-thread-id') || '';
          const channel = actionEl.getAttribute('data-channel') || 'box';
          if (!threadId) return;
          if (typeof h.openThread === 'function') {
            h.openThread({ threadId, channel });
          } else if (typeof h.inspectThread === 'function') {
            h.inspectThread(threadId, channel);
          }
        }
      };

      const onKeyDown = (event) => {
        if (!event) return;
        const target = event.target;

        // Inside verdict note input: Enter confirms, Escape cancels
        if (target && typeof target.getAttribute === 'function' && target.getAttribute('data-ctx-ref') === 'verdict-note-input') {
          const wrap = target.closest('[data-ctx-component="verdict-bar"]');
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const confirmBtn = wrap && wrap.querySelector('[data-ctx-action="verdict-confirm"]');
            handleVerdictConfirm(wrap, confirmBtn);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            if (wrap) {
              const slot = wrap.querySelector('[data-ctx-ref="verdict-confirm-slot"]');
              if (slot) slot.innerHTML = '';
              syncVerdictExpanded(wrap, '');
            }
            return;
          }
          return;
        }

        // Single-key verdict shortcuts (A / R / D) when not typing and no modifiers
        if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(target)) {
          return;
        }
        const keyLow = String(event.key || '').toLowerCase();
        const shortcutMap = { a: 'approve', r: 'revise', d: 'defer' };
        const verdictKey = shortcutMap[keyLow];
        if (!verdictKey) return;

        const wrap =
          (target && typeof target.closest === 'function' && target.closest('[data-ctx-component="verdict-bar"]')) ||
          (typeof rootEl.querySelector === 'function' && rootEl.querySelector('[data-ctx-component="verdict-bar"]'));
        if (!wrap) return;
        event.preventDefault();
        playSound('click');
        openVerdictConfirmInWrap(wrap, verdictKey);
      };

      rootEl.addEventListener('click', onClick);
      rootEl.addEventListener('keydown', onKeyDown);

      return function detach() {
        try {
          rootEl.removeEventListener('click', onClick);
          rootEl.removeEventListener('keydown', onKeyDown);
        } catch {
          // ignore cleanup errors
        }
      };
    }

    return {
      renderLocalLlmBriefCard,
      renderDecisionVerdictBar,
      renderContextStage,
      bindEvents,
      attach: bindEvents,
      openVerdictConfirmInWrap,
      synthesizeThread,
      fetchContext,
      promoteToCodex,
      submitVerdict,
      undoVerdict,
      buildVerdictText,
      needsDecisionVerdict,
      normalizeBriefResult,
      normalizeContextData,
      ensureStyles,
      getStyles,
      escapeHtml,
      escapeAttr,
      stripEmDash,
      CODEX_SECTIONS,
      VERDICT_SPECS,
    };
  }
);
