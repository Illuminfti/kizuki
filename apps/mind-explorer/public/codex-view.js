/* ==========================================================================
   KIZUKI MIND EXPLORER - MIND CODEX & ACTION PLANE CONTROLLER
   Dual-Polarity (Dark + Light) Personal Operating Codex Workspace
   Exports: window.KizukiCodexView = { mount, load, getState, openCaptureModal }
   Zero external deps | Zero XSS | Zero em-dashes | Defensive helper hooks
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiCodexView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const EN_DASH_RE = /\s*\u2013\s*/g;

  const SECTIONS = [
    {
      id: 'philosophies',
      label: 'Philosophies & Principles',
      shortLabel: 'Philosophies',
      icon: 'compass',
      description: 'Operating theses, creative doctrines, craft laws, and verified rules.',
    },
    {
      id: 'interests',
      label: 'Interests & Passions',
      shortLabel: 'Interests',
      icon: 'bookmark',
      description: 'Clustered X bookmarks, Taste Vault references, and active research threads.',
    },
    {
      id: 'hobbies',
      label: 'Hobbies & Craft',
      shortLabel: 'Hobbies',
      icon: 'layers',
      description: 'Hands-on labs, trading experiments, generative art, and personal life anchors.',
    },
    {
      id: 'ideas',
      label: 'Ideas Incubator',
      shortLabel: 'Ideas',
      icon: 'sparkles',
      description: 'Active companies, product incubations, and staged concepts from spark to shipped.',
    },
    {
      id: 'actions',
      label: 'Action Plane',
      shortLabel: 'Actions',
      icon: 'check-circle',
      description: 'Live owner actions, open high-stakes decisions, commitments, and next moves.',
    },
  ];

  const SECTION_MAP = Object.create(null);
  for (let i = 0; i < SECTIONS.length; i += 1) {
    SECTION_MAP[SECTIONS[i].id] = SECTIONS[i];
  }

  const STAGES = ['spark', 'validating', 'building', 'shipped', 'parked'];
  const PIPELINE_STAGES = [
    { id: 'spark', label: 'Spark', color: 'var(--accent-amber, #f5a623)' },
    { id: 'validating', label: 'Validating', color: 'var(--accent-blue, #3291ff)' },
    { id: 'building', label: 'Building', color: 'var(--accent-violet, #a78bfa)' },
    { id: 'shipped', label: 'Shipped', color: 'var(--codex-emerald, #10b981)' },
  ];

  const NEXT_STAGE_MAP = {
    spark: 'validating',
    validating: 'building',
    building: 'shipped',
    parked: 'validating',
  };

  const STAGE_LABEL = {
    spark: 'Spark',
    validating: 'Validating',
    building: 'Building',
    shipped: 'Shipped',
    parked: 'Parked',
  };

  const CONVICTION_LABEL = {
    core: 'CORE',
    active: 'ACTIVE',
    testing: 'TESTING',
  };

  const DOMAIN_PALETTE = [
    'var(--codex-stripe-philosophies, #a78bfa)',
    'var(--codex-stripe-interests, #3291ff)',
    'var(--codex-stripe-ideas, #f5a623)',
    'var(--codex-stripe-hobbies, #46a758)',
    'var(--codex-stripe-actions, #10b981)',
    'var(--accent-cyan, #22b8cf)',
    'var(--ink-muted, #888888)',
  ];

  const FALLBACK_ICONS = {
    compass: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><polygon points="10.4 5.6 9.1 9.1 5.6 10.4 6.9 6.9 10.4 5.6"/></svg>',
    bookmark: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a.8.8 0 0 1 .8.8v10.2L8 10.7l-4.8 2.8V3.3a.8.8 0 0 1 .8-.8Z"/></svg>',
    layers: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="8 2 14 5.3 8 8.6 2 5.3 8 2"/><polyline points="2 8.3 8 11.6 14 8.3"/><polyline points="2 11.3 8 14.3 14 11.3"/></svg>',
    sparkles: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6 8 2.2Z"/><path d="M12.6 10.8 13.2 12.3 14.7 12.9 13.2 13.5 12.6 15 12 13.5 10.5 12.9 12 12.3 12.6 10.8Z"/></svg>',
    'check-circle': '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><polyline points="5.3 8.1 7.2 10 10.9 6.2"/></svg>',
    plus: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
    pin: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 2.4 13.6 6.2 11.5 8.3 10.4 11.4 7.7 8.7 4.6 11.8 4.2 11.4 7.3 8.3 4.6 5.6 7.7 4.5 9.8 2.4Z"/></svg>',
    edit: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.9 2.7a1.5 1.5 0 0 1 2.1 2.1L6 11.8l-2.9.8.8-2.9 7-7Z"/></svg>',
    doc: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.2h5.4L12.8 5.6v8.2a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8Z"/><polyline points="9.2 2.4 9.2 5.8 12.6 5.8"/></svg>',
    bolt: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="8.9 1.8 3.6 8.8 7.8 8.8 7.1 14.2 12.4 7.2 8.2 7.2 8.9 1.8"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8h9"/><polyline points="8.8 4.3 12.5 8 8.8 11.7"/></svg>',
    external: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M6.8 9.2 13.5 2.5"/><path d="M12.5 9.2v3.5a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.3a.8.8 0 0 1 .8-.8h3.5"/></svg>',
    refresh: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.6"/><polyline points="13.4 2.6 13.4 5.5 10.5 5.5"/></svg>',
    grid: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.3" y="2.3" width="4.6" height="4.6" rx="1"/><rect x="9.1" y="2.3" width="4.6" height="4.6" rx="1"/><rect x="2.3" y="9.1" width="4.6" height="4.6" rx="1"/><rect x="9.1" y="9.1" width="4.6" height="4.6" rx="1"/></svg>',
    columns: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="2.5" width="3.1" height="11" rx=".7"/><rect x="6.5" y="2.5" width="3.1" height="8.2" rx=".7"/><rect x="10.8" y="2.5" width="3.1" height="9.6" rx=".7"/></svg>',
    clock: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><polyline points="8 4.6 8 8 10.4 9.5"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 4.3 13 4.3"/><path d="M5.6 4.3V3a.8.8 0 0 1 .8-.8h3.2a.8.8 0 0 1 .8.8v1.3"/><path d="M4.2 4.3 4.9 13a.8.8 0 0 0 .8.8h4.6a.8.8 0 0 0 .8-.8l.7-8.7"/></svg>',
    network: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="3.2" r="1.7"/><circle cx="3.4" cy="12" r="1.7"/><circle cx="12.6" cy="12" r="1.7"/><line x1="7.1" y1="4.7" x2="4.3" y2="10.5"/><line x1="8.9" y1="4.7" x2="11.7" y2="10.5"/><line x1="5.1" y1="12" x2="10.9" y2="12"/></svg>',
    board: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1"/><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1"/><rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1"/><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1"/></svg>',
  };

  function stripEmDash(val) {
    return String(val == null ? '' : val)
      .replace(EM_DASH_RE, ' - ')
      .replace(EN_DASH_RE, ' - ');
  }

  function escHtml(val) {
    return stripEmDash(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(val) {
    return escHtml(val).replace(/`/g, '&#96;');
  }

  function isSafeHttpUrl(url) {
    if (typeof url !== 'string') return false;
    const t = url.trim();
    if (!/^https?:\/\/[^\s<>"'`]+$/i.test(t)) return false;
    return !/[\u0000-\u001f\u007f]/.test(t);
  }

  function clampNum(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n);
  }

  function formatShortDate(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
    if (m) return m[1];
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return stripEmDash(iso).slice(0, 16);
    return d.toISOString().slice(0, 10);
  }

  function formatTimestamp(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return formatShortDate(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  function formatLikes(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  const CODEX_ICON_MAP = {
    philosophies: 'philosophy',
    philosophy: 'philosophy',
    compass: 'philosophy',
    interests: 'interest',
    interest: 'interest',
    hobbies: 'hobby',
    hobby: 'hobby',
    flame: 'hobby',
    ideas: 'idea',
    idea: 'idea',
    lightbulb: 'idea',
    actions: 'action_plane',
    action: 'action_plane',
    zap: 'action_plane',
    sparkles: 'sparkle_ai',
    sparkle: 'sparkle_ai',
    ai: 'sparkle_ai',
    promote: 'plus',
    plus: 'plus',
    doc: 'book',
    'file-text': 'book',
    book: 'book',
    pin: 'pin',
    edit: 'edit',
    trash: 'trash',
    'arrow-right': 'arrow_right',
    advance: 'arrow_right',
    external: 'external',
    check: 'check',
    replay: 'replay',
    clock: 'clock',
    network: 'network',
  };

  function getIcon(name, fallbackKey) {
    const mapped = CODEX_ICON_MAP[name] || CODEX_ICON_MAP[fallbackKey] || name;
    try {
      const lib = root && root.KizukiIcons;
      if (lib && typeof lib.svg === 'function') {
        if (typeof lib.has !== 'function' || lib.has(mapped)) {
          const out = lib.svg(mapped, { size: 13 });
          if (typeof out === 'string' && out.indexOf('<svg') !== -1) return out;
        }
      }
    } catch {
      // ignore helper error and use fallback icon
    }
    return FALLBACK_ICONS[fallbackKey || name] || FALLBACK_ICONS.sparkles;
  }

  function fallbackMarkdownToHtml(md) {
    const clean = stripEmDash(md || '').trim();
    if (!clean) return '<p>No analysis returned.</p>';
    const lines = clean.split(/\r?\n/);
    const out = [];
    let inList = false;
    let listTag = 'ul';

    function closeList() {
      if (inList) {
        out.push(`</${listTag}>`);
        inList = false;
      }
    }

    function inlineFmt(text) {
      let s = escHtml(text);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return s;
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) {
        closeList();
        continue;
      }
      const hMatch = /^#{1,4}\s+(.+)$/.exec(line);
      if (hMatch) {
        closeList();
        out.push(`<h4>${inlineFmt(hMatch[1])}</h4>`);
        continue;
      }
      const ulMatch = /^[-*]\s+(.+)$/.exec(line);
      if (ulMatch) {
        if (!inList || listTag !== 'ul') {
          closeList();
          listTag = 'ul';
          inList = true;
          out.push('<ul>');
        }
        out.push(`<li>${inlineFmt(ulMatch[1])}</li>`);
        continue;
      }
      const olMatch = /^\d+\.\s+(.+)$/.exec(line);
      if (olMatch) {
        if (!inList || listTag !== 'ol') {
          closeList();
          listTag = 'ol';
          inList = true;
          out.push('<ol>');
        }
        out.push(`<li>${inlineFmt(olMatch[1])}</li>`);
        continue;
      }
      const bqMatch = /^>\s*(.+)$/.exec(line);
      if (bqMatch) {
        closeList();
        out.push(`<blockquote>${inlineFmt(bqMatch[1])}</blockquote>`);
        continue;
      }
      closeList();
      out.push(`<p>${inlineFmt(line)}</p>`);
    }
    closeList();
    return out.join('');
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `Request failed (${res.status})`;
      throw new Error(stripEmDash(msg));
    }
    return body || {};
  }

  function createCodexController() {
    const state = {
      mounted: false,
      container: null,
      hooks: {},
      loading: false,
      error: null,
      activeSection: 'philosophies',
      viewMode: 'grid',
      ideasViewMode: 'pipeline',
      searchQuery: '',
      filterDomain: 'all',
      filterStage: 'all',
      filterConviction: 'all',
      filterPinnedOnly: false,
      actionFilter: 'open',
      bookmarkDomainFilter: 'all',
      highlightItemId: null,
      data: null,
      allItems: [],
      ownerActions: [],
      aiBusyMap: Object.create(null),
      aiTransientMap: Object.create(null),
      aiCollapsedMap: Object.create(null),
      modalOpen: false,
      modalEditingId: null,
      modalSaving: false,
      quickActionBusy: false,
      loadSeq: 0,
      shellRendered: false,
      crosslinks: [],
    };

    let boundKeydown = null;
    let constellationCtrl = null;

    function playSound(method) {
      try {
        const sound = (root && root.KizukiSound) || (typeof window !== 'undefined' && window.KizukiSound);
        if (sound && typeof sound[method] === 'function') {
          sound[method]();
        }
      } catch {
        // ignore optional sound errors
      }
    }

    function getConstellationLib() {
      try {
        const lib = (root && root.KizukiCodexMap) || (typeof window !== 'undefined' && window.KizukiCodexMap);
        return lib && typeof lib.mount === 'function' ? lib : null;
      } catch {
        return null;
      }
    }

    function destroyConstellation() {
      if (constellationCtrl) {
        try {
          if (typeof constellationCtrl.destroy === 'function') {
            constellationCtrl.destroy();
          }
        } catch {
          // ignore cleanup errors
        }
        constellationCtrl = null;
      }
    }

    function notify(msg, tone) {
      const text = stripEmDash(msg);
      try {
        if (state.hooks && typeof state.hooks.showToast === 'function') {
          state.hooks.showToast(text, tone || 'info');
        }
      } catch {
        // ignore toast errors
      }
    }

    function renderMdSafe(md) {
      const clean = stripEmDash(md || '');
      try {
        if (state.hooks && typeof state.hooks.renderMarkdown === 'function') {
          const rendered = state.hooks.renderMarkdown(clean);
          if (typeof rendered === 'string' && rendered.trim()) {
            return stripEmDash(rendered);
          }
        }
      } catch {
        // fallback below
      }
      try {
        if (root && root.KizukiMarkdown && typeof root.KizukiMarkdown.renderMarkdown === 'function') {
          const rendered = root.KizukiMarkdown.renderMarkdown(clean);
          if (typeof rendered === 'string' && rendered.trim()) {
            return stripEmDash(rendered);
          }
        }
      } catch {
        // fallback below
      }
      return fallbackMarkdownToHtml(clean);
    }

    function updateHostNavCount() {
      try {
        if (state.hooks && typeof state.hooks.updateNavCount === 'function' && state.data && state.data.stats) {
          state.hooks.updateNavCount(Number(state.data.stats.total) || 0);
        }
      } catch {
        // ignore hook errors
      }
    }

    function runMotionStagger(parentEl, selector) {
      try {
        if (!parentEl) return;
        const m = root && root.KizukiMotion;
        if (m && typeof m.staggerReveal === 'function') {
          m.staggerReveal(parentEl, selector || '.codex-card, .codex-pipeline-col, .codex-action-panel');
        }
      } catch {
        // ignore optional motion errors
      }
    }

    function runSlidingTabInk(containerEl, activeEl) {
      try {
        if (!containerEl || !activeEl) return;
        const m = root && root.KizukiMotion;
        if (m && typeof m.syncSlidingTabInk === 'function') {
          m.syncSlidingTabInk(containerEl, activeEl);
        }
      } catch {
        // ignore optional motion errors
      }
    }

    function normalizeOwnerActions(rawList) {
      if (!Array.isArray(rawList)) return [];
      return rawList.map((a, idx) => ({
        id: String(a.id || `act_${idx}`),
        title: stripEmDash(a.title || a.text || 'Untitled action'),
        detail: stripEmDash(a.detail || a.notes || ''),
        tag: stripEmDash(a.tag || 'Work'),
        source: stripEmDash(a.source || 'Owner'),
        done: Boolean(a.done !== undefined ? a.done : a.completed),
        created_at: a.created_at || '',
      }));
    }

    function getAllCodexItems() {
      if (state.data && Array.isArray(state.data.items)) return state.data.items;
      return Array.isArray(state.allItems) ? state.allItems : [];
    }

    function syncAllItemsCache() {
      if (state.data && Array.isArray(state.data.items)) {
        state.allItems = state.data.items.slice();
      }
    }

    function findItemById(id) {
      if (!id) return null;
      const items = getAllCodexItems();
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].id === id) return items[i];
      }
      const decisions = (state.data && Array.isArray(state.data.open_decisions)) ? state.data.open_decisions : [];
      for (let i = 0; i < decisions.length; i += 1) {
        if (decisions[i].id === id) return decisions[i];
      }
      return null;
    }

    function replaceItemInState(updatedItem) {
      if (!updatedItem || !updatedItem.id || !state.data) return;
      if (Array.isArray(state.data.items)) {
        const idx = state.data.items.findIndex((x) => x.id === updatedItem.id);
        if (idx !== -1) state.data.items[idx] = updatedItem;
        else state.data.items.unshift(updatedItem);
      }
      if (Array.isArray(state.data.open_decisions)) {
        const didx = state.data.open_decisions.findIndex((x) => x.id === updatedItem.id);
        if (didx !== -1) state.data.open_decisions[didx] = updatedItem;
      }
      syncAllItemsCache();
    }

    function matchesSearch(item, q) {
      if (!q) return true;
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return true;
      const hay = [
        item.title,
        item.subtitle,
        item.summary,
        item.thesis || '',
        item.anti_pattern || '',
        item.next_move || '',
        item.domain || '',
        item.source_label || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        Array.isArray(item.linked_people) ? item.linked_people.join(' ') : '',
      ].join(' ').toLowerCase();
      for (let i = 0; i < tokens.length; i += 1) {
        if (hay.indexOf(tokens[i]) === -1) return false;
      }
      return true;
    }

    function getFilteredItemsForSection(sectionId) {
      const all = getAllCodexItems();
      const q = state.searchQuery.trim();
      return all.filter((item) => {
        if (item.status === 'archived') return false;
        if (sectionId && sectionId !== 'all' && item.section !== sectionId) return false;
        if (state.filterPinnedOnly && !item.pinned) return false;
        if (state.filterDomain !== 'all' && String(item.domain || '').toLowerCase() !== state.filterDomain.toLowerCase()) {
          return false;
        }
        if (sectionId === 'ideas' && state.filterStage !== 'all' && item.stage !== state.filterStage) {
          return false;
        }
        if (sectionId === 'philosophies' && state.filterConviction !== 'all' && item.conviction !== state.filterConviction) {
          return false;
        }
        return matchesSearch(item, q);
      });
    }

    function getSectionMeta(sectionId) {
      if (sectionId === 'all') {
        return {
          id: 'all',
          label: 'All Mind Codex',
          description: 'Unified view across philosophies, interests, hobbies, ideas, and active execution.',
        };
      }
      const apiSections = (state.data && Array.isArray(state.data.sections)) ? state.data.sections : [];
      const fromApi = apiSections.find((s) => s.id === sectionId);
      const fallback = SECTION_MAP[sectionId] || SECTIONS[0];
      return {
        id: fallback.id,
        label: stripEmDash((fromApi && fromApi.label) || fallback.label),
        description: stripEmDash((fromApi && fromApi.description) || fallback.description),
        count: fromApi ? fromApi.count : 0,
      };
    }

    function renderDomainBalanceHtml(domains) {
      const list = Array.isArray(domains) ? domains.slice(0, 6) : [];
      if (!list.length) {
        return '<div class="codex-dist-head"><span>Domain Balance</span><span>0</span></div>';
      }

      const totalCount = Math.max(1, list.reduce((a, b) => a + (Number(b.count) || 0), 0));
      const barHtml = `<div class="codex-dist-bar" role="img" aria-label="Domain balance distribution">${list.map((d, idx) => {
        const pct = Math.max(4, Number(d.pct) || Math.round(((Number(d.count) || 0) / totalCount) * 100));
        const color = DOMAIN_PALETTE[idx % DOMAIN_PALETTE.length];
        return `<div class="codex-dist-seg" style="width:${pct}%;background-color:${color}" data-viz-tip="${escAttr(d.domain)}: ${d.count} items (${pct}%)"></div>`;
      }).join('')}</div>`;

      const legendHtml = list.map((d, idx) => {
        const color = DOMAIN_PALETTE[idx % DOMAIN_PALETTE.length];
        const active = state.filterDomain.toLowerCase() === String(d.domain || '').toLowerCase();
        return (
          `<button type="button" class="codex-dist-legend-item" data-codex-domain-filter="${escAttr(d.domain)}" ` +
          `style="background:none;border:none;padding:0;cursor:pointer;text-align:left;${active ? 'color:var(--ink-primary);font-weight:600;' : ''}">` +
          `<span class="codex-dist-legend-dot" style="background-color:${color}"></span>` +
          `<span>${escHtml(d.domain)}</span>` +
          `<span class="codex-dist-legend-count">${Number(d.count) || 0}</span>` +
          `</button>`
        );
      }).join('');

      return (
        `<div class="codex-dist-head">` +
        `<span>Domain Balance</span>` +
        `<span>${list.length} active</span>` +
        `</div>` +
        barHtml +
        `<div class="codex-dist-legend">${legendHtml}</div>`
      );
    }

    function renderIdeasFunnelHtml(stagesObj) {
      const stages = stagesObj || { spark: 0, validating: 0, building: 0, shipped: 0, parked: 0 };

      // Attempt optional KizukiCharts.renderCodexFunnelSvg integration
      try {
        const charts = root && root.KizukiCharts;
        if (charts && typeof charts.renderCodexFunnelSvg === 'function') {
          const out = charts.renderCodexFunnelSvg(stages, { width: 720, height: 84 });
          if (typeof out === 'string' && out.indexOf('<svg') !== -1) {
            return (
              `<div class="codex-action-panel" style="padding:12px 14px;">` +
              `<div class="codex-bookmarks-header"><span>Ideas Pipeline Funnel</span><span>Spark -> Validating -> Building -> Shipped</span></div>` +
              `<div class="codex-funnel-svg-wrap">${out}</div>` +
              `</div>`
            );
          }
          if (out && typeof out.outerHTML === 'string' && out.outerHTML.indexOf('<svg') !== -1) {
            return (
              `<div class="codex-action-panel" style="padding:12px 14px;">` +
              `<div class="codex-bookmarks-header"><span>Ideas Pipeline Funnel</span><span>Spark -> Validating -> Building -> Shipped</span></div>` +
              `<div class="codex-funnel-svg-wrap">${out.outerHTML}</div>` +
              `</div>`
            );
          }
        }
      } catch {
        // use built-in SVG funnel below
      }

      const vals = PIPELINE_STAGES.map((s) => Number(stages[s.id]) || 0);
      const maxVal = Math.max(1, ...vals);
      const totalActive = vals.reduce((a, b) => a + b, 0);
      const parked = Number(stages.parked) || 0;

      const colW = 172;
      const gap = 10;
      const svgW = PIPELINE_STAGES.length * colW + (PIPELINE_STAGES.length - 1) * gap;
      const svgH = 74;

      const cells = PIPELINE_STAGES.map((st, idx) => {
        const count = Number(stages[st.id]) || 0;
        const x = idx * (colW + gap);
        const fillW = Math.max(10, Math.round((count / maxVal) * (colW - 24)));
        const isActive = state.filterStage === st.id;
        return (
          `<g data-codex-stage-filter="${st.id}" style="cursor:pointer;">` +
          `<rect x="${x}" y="2" width="${colW}" height="68" rx="8" fill="var(--surface-inset)" stroke="${isActive ? st.color : 'var(--border-hairline)'}" stroke-width="${isActive ? '1.5' : '1'}"/>` +
          `<circle cx="${x + 16}" cy="20" r="3.5" fill="${st.color}"/>` +
          `<text x="${x + 26}" y="23.5" fill="var(--ink-secondary)" font-family="var(--font-mono)" font-size="11" font-weight="500">${escHtml(st.label.toUpperCase())}</text>` +
          `<text x="${x + colW - 14}" y="25" text-anchor="end" fill="var(--ink-primary)" font-family="var(--font-mono)" font-size="16" font-weight="600">${count}</text>` +
          `<rect x="${x + 12}" y="44" width="${colW - 24}" height="7" rx="3.5" fill="var(--codex-track-bg)"/>` +
          `<rect x="${x + 12}" y="44" width="${count > 0 ? fillW : 0}" height="7" rx="3.5" fill="${st.color}"/>` +
          `<text x="${x + 12}" y="63" fill="var(--ink-muted)" font-family="var(--font-mono)" font-size="11">${totalActive > 0 ? Math.round((count / totalActive) * 100) : 0}% of active</text>` +
          `</g>`
        );
      }).join('');

      return (
        `<div class="codex-action-panel" style="padding:12px 14px;">` +
        `<div class="codex-bookmarks-header">` +
        `<span>Ideas Pipeline Funnel</span>` +
        `<span>${totalActive} active${parked > 0 ? ` | ${parked} parked` : ''}</span>` +
        `</div>` +
        `<svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Ideas Incubator stage funnel" style="display:block;max-width:100%;overflow:visible;">` +
        cells +
        `</svg>` +
        `</div>`
      );
    }

    function renderPeoplePills(people) {
      if (!Array.isArray(people) || !people.length) return '';
      return (
        `<div class="codex-people-pills">` +
        people.slice(0, 6).map((name) => (
          `<button type="button" class="codex-person-pill" data-codex-open-person="${escAttr(name)}" title="Open dossier for ${escAttr(name)}">` +
          `<span>${escHtml(name)}</span>` +
          `</button>`
        )).join('') +
        `</div>`
      );
    }

    function getBoardWidgets() {
      try {
        const w = (root && root.KizukiBoardWidgets) || (typeof window !== 'undefined' && window.KizukiBoardWidgets);
        return w && typeof w === 'object' ? w : null;
      } catch {
        return null;
      }
    }

    function extractBoardOrigin(item) {
      if (!item || typeof item !== 'object') return null;
      const idStr = String(item.id || '').trim();
      const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t || '').trim()) : [];
      let threadId = '';
      let channel = '';
      let hasBoardTag = false;

      for (let i = 0; i < tags.length; i += 1) {
        const t = tags[i];
        const lower = t.toLowerCase();
        if (lower === 'agent-board' || lower === 'board') {
          hasBoardTag = true;
        } else if (lower.indexOf('thread:') === 0) {
          hasBoardTag = true;
          const val = t.slice(7).replace(/^#+/, '').trim();
          if (val) threadId = val;
        } else if (lower.indexOf('channel:') === 0) {
          hasBoardTag = true;
          const val = t.slice(8).replace(/^#+/, '').trim();
          if (val) channel = val;
        }
      }

      const isBoardId = idStr.indexOf('codex_board_') === 0;
      if (!isBoardId && !hasBoardTag) return null;

      if (!threadId && item.thread_id) {
        threadId = String(item.thread_id).replace(/^#+/, '').trim();
      }
      if (!threadId && isBoardId) {
        const suffix = idStr.slice('codex_board_'.length).trim();
        const numMatch = /^(\d+)/.exec(suffix);
        threadId = numMatch ? numMatch[1] : suffix;
      }
      if (!channel && item.channel) {
        channel = String(item.channel).replace(/^#+/, '').trim();
      }
      if (!channel) {
        channel = item.section === 'actions' ? 'kizuki/decisions' : 'box/work';
      }

      return {
        threadId,
        channel,
      };
    }

    async function fetchCodexCrosslinksSilent() {
      try {
        const raw = await fetchJson('/api/crosslinks?kind=codex');
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.links)) return raw.links;
        if (raw && Array.isArray(raw.crosslinks)) return raw.crosslinks;
        if (raw && Array.isArray(raw.items)) return raw.items;
        return [];
      } catch {
        return [];
      }
    }

    function getCodexItemCrosslinks(item) {
      if (!item || typeof item !== 'object') return [];
      const out = [];
      const seen = Object.create(null);

      function addLink(raw) {
        if (!raw || typeof raw !== 'object') return;
        const tasteDomain = String(raw.domain || raw.taste_domain || raw.tasteDomain || '').trim();
        const ruleText = stripEmDash(
          raw.taste_rule || raw.tasteRule || raw.target_title || raw.targetTitle || raw.rule || raw.title || ''
        ).trim();
        if (!ruleText) return;
        const relRaw = String(raw.relation || raw.kind || raw.type || 'reinforces').toLowerCase();
        const relation = relRaw.includes('conflict') ? 'conflicts' : 'reinforces';
        const score = Number.isFinite(Number(raw.score || raw.similarity))
          ? Math.round(Number(raw.score || raw.similarity) * (Number(raw.score || raw.similarity) <= 1 ? 100 : 1))
          : null;
        const key = `${ruleText.toLowerCase()}::${relation}`;
        if (seen[key]) return;
        seen[key] = true;
        out.push({ domain: tasteDomain || 'all', title: ruleText, relation, score });
      }

      if (Array.isArray(item.links)) {
        for (let i = 0; i < item.links.length; i += 1) {
          addLink(item.links[i]);
        }
      }

      const itemId = String(item.id || '').trim();
      const itemTitleLower = stripEmDash(item.title || '').trim().toLowerCase();
      const crosslinks = Array.isArray(state.crosslinks) ? state.crosslinks : [];
      for (let i = 0; i < crosslinks.length; i += 1) {
        const cl = crosslinks[i];
        if (!cl || typeof cl !== 'object') continue;
        const clCodexId = String(cl.codex_id || cl.codexId || cl.principle_id || cl.source_id || cl.sourceId || '').trim();
        const clCodexTitle = stripEmDash(cl.codex_title || cl.codexTitle || cl.source_title || '').trim().toLowerCase();
        if ((itemId && clCodexId && clCodexId === itemId) || (itemTitleLower && clCodexTitle && clCodexTitle === itemTitleLower)) {
          addLink(cl);
        }
      }

      return out.slice(0, 4);
    }

    function openTasteCrosslink(domain) {
      playSound('click');
      const dom = domain && domain !== 'all' ? domain : 'all';
      if (state.hooks && typeof state.hooks.openTaste === 'function') {
        state.hooks.openTaste({ domain: dom, tab: 'rules' });
        return;
      }
      if (typeof document !== 'undefined') {
        const tasteNavBtn = document.querySelector('[data-view="taste"], [data-nav-view="taste"]');
        if (tasteNavBtn && typeof tasteNavBtn.click === 'function') {
          tasteNavBtn.click();
        }
      }
      if (root && root.KizukiTasteView && typeof root.KizukiTasteView.load === 'function') {
        root.KizukiTasteView.load({ domain: dom, tab: 'rules' });
      }
    }

    function renderBoardOriginBadge(item) {
      const origin = extractBoardOrigin(item);
      if (!origin) return '';
      const label = origin.threadId ? `Board #${origin.threadId}` : 'Board';
      const title = origin.threadId
        ? `Open origin thread #${origin.threadId} in #${origin.channel}`
        : `Open Agent Board room #${origin.channel}`;
      return (
        `<button type="button" class="codex-person-pill codex-board-origin-pill" ` +
        `data-codex-open-board-thread="${escAttr(origin.threadId)}" ` +
        `data-codex-open-board-channel="${escAttr(origin.channel)}" ` +
        `title="${escAttr(title)}">` +
        `${getIcon('board', 'board')} <span>${escHtml(label)}</span>` +
        `</button>`
      );
    }

    function renderAiPanel(item) {
      const busyMode = state.aiBusyMap[item.id];
      const transient = state.aiTransientMap[item.id];
      const briefMd = (transient && transient.brief_md) || item.ai_brief || '';
      const engine = (transient && transient.engine) || item.ai_engine || 'Local AI';
      const latencyMs = transient && transient.latency_ms;
      const updatedAt = (transient && transient.updated_at) || item.ai_updated_at || '';
      const collapsed = Boolean(state.aiCollapsedMap[item.id]);

      if (busyMode) {
        const modeLabel = busyMode === 'challenge' ? 'Pressure-Testing' : busyMode === 'next_moves' ? 'Synthesizing Next 3 Moves' : 'Sharpening Thesis';
        return (
          `<div class="codex-ai-insight" aria-live="polite">` +
          `<div class="codex-ai-insight-head">` +
          `<span class="codex-ai-engine-badge">${getIcon('sparkles', 'sparkles')} ${escHtml(modeLabel)}...</span>` +
          `<span class="codex-ai-timestamp">Dual-Engine G4 -> MiniMax</span>` +
          `</div>` +
          `<div class="codex-ai-insight-body"><p>Running live synthesis on this Codex entry...</p></div>` +
          `</div>`
        );
      }

      if (!briefMd || collapsed) {
        if (briefMd && collapsed) {
          return (
            `<div class="codex-ai-insight" style="padding:7px 10px;">` +
            `<div class="codex-ai-insight-head" style="padding-bottom:0;border-bottom:none;">` +
            `<span class="codex-ai-engine-badge">${getIcon('sparkles', 'sparkles')} ${escHtml(engine)}</span>` +
            `<button type="button" class="codex-action-btn" data-codex-toggle-ai="${escAttr(item.id)}">Show Brief</button>` +
            `</div>` +
            `</div>`
          );
        }
        return '';
      }

      const engineLabel = latencyMs ? `${engine} (${latencyMs}ms)` : engine;
      return (
        `<div class="codex-ai-insight">` +
        `<div class="codex-ai-insight-head">` +
        `<span class="codex-ai-engine-badge">${getIcon('sparkles', 'sparkles')} ${escHtml(engineLabel)}</span>` +
        `<div style="display:inline-flex;align-items:center;gap:6px;">` +
        (updatedAt ? `<span class="codex-ai-timestamp">${escHtml(formatTimestamp(updatedAt))}</span>` : '') +
        `<button type="button" class="codex-action-btn" style="height:20px;padding:0 6px;" data-codex-toggle-ai="${escAttr(item.id)}">Hide</button>` +
        `</div>` +
        `</div>` +
        `<div class="codex-ai-insight-body">${renderMdSafe(briefMd)}</div>` +
        `</div>`
      );
    }

    function renderBookmarkRow(bm, opts) {
      const showDomain = opts && opts.showDomain;
      const authorRaw = stripEmDash(bm.author || 'Unknown');
      const handle = authorRaw.startsWith('@') ? authorRaw : `@${authorRaw.replace(/^@+/, '')}`;
      const safeUrl = isSafeHttpUrl(bm.url) ? bm.url : '';
      const dateStr = formatShortDate(bm.date || '');
      const likes = Number(bm.likes) || 0;

      return (
        `<div class="codex-bookmark-row">` +
        `<div class="codex-bookmark-head">` +
        `<span class="codex-bookmark-author">${escHtml(handle)}${showDomain && bm.domain ? `<span class="codex-bookmark-handle">${escHtml(bm.domain)}</span>` : ''}</span>` +
        (dateStr ? `<span class="codex-bookmark-date">${escHtml(dateStr)}</span>` : '') +
        `</div>` +
        `<p class="codex-bookmark-snippet">${escHtml(bm.text || '')}</p>` +
        `<div class="codex-bookmark-foot">` +
        `<span class="codex-bookmark-likes">${likes > 0 ? `${escHtml(formatLikes(likes))} likes` : 'Bookmarked signal'}</span>` +
        (safeUrl
          ? `<a class="codex-bookmark-link" href="${escAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">Open on X ${getIcon('external', 'external')}</a>`
          : `<span>Saved</span>`) +
        `</div>` +
        `</div>`
      );
    }

    function renderCardActions(item, mode) {
      const busy = Boolean(state.aiBusyMap[item.id]);
      const btns = [];

      if (mode === 'philosophies') {
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="challenge"${busy ? ' disabled' : ''}>${getIcon('sparkles', 'sparkles')} Pressure-Test</button>`
        );
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="sharpen"${busy ? ' disabled' : ''}>Sharpen</button>`
        );
      } else if (mode === 'ideas') {
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="next_moves"${busy ? ' disabled' : ''}>${getIcon('sparkles', 'sparkles')} Next 3 Moves</button>`
        );
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="challenge"${busy ? ' disabled' : ''}>Challenge</button>`
        );
      } else {
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="sharpen"${busy ? ' disabled' : ''}>${getIcon('sparkles', 'sparkles')} Sharpen</button>`
        );
        btns.push(
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="next_moves"${busy ? ' disabled' : ''}>Next 3 Moves</button>`
        );
      }

      btns.push(
        `<button type="button" class="codex-action-btn is-primary" data-codex-promote="${escAttr(item.id)}">${getIcon('bolt', 'bolt')} ${mode === 'ideas' ? 'Promote to Today' : 'Promote to Action'}</button>`
      );
      btns.push(
        `<button type="button" class="codex-action-btn" data-codex-send-board="${escAttr(item.id)}" title="Dispatch to Agent Board">${getIcon('board', 'board')} Board</button>`
      );

      if (item.vault_doc_path) {
        btns.push(
          `<button type="button" class="codex-action-btn" data-codex-open-doc="${escAttr(item.vault_doc_path)}">${getIcon('doc', 'doc')} Open Doc</button>`
        );
      }

      if (mode === 'hobbies' && item.updated_at && typeof state.hooks.openReplayDay === 'function') {
        const day = formatShortDate(item.updated_at);
        if (day) {
          btns.push(
            `<button type="button" class="codex-action-btn" data-codex-open-replay="${escAttr(day)}">${getIcon('clock', 'clock')} Replay</button>`
          );
        }
      }

      btns.push(
        `<button type="button" class="codex-action-btn${item.pinned ? ' is-pinned' : ''}" data-codex-pin="${escAttr(item.id)}" aria-pressed="${item.pinned ? 'true' : 'false'}">${getIcon('pin', 'pin')} ${item.pinned ? 'Pinned' : 'Pin'}</button>`
      );
      btns.push(
        `<button type="button" class="codex-action-btn" data-codex-edit="${escAttr(item.id)}">${getIcon('edit', 'edit')} Edit</button>`
      );

      return `<div class="codex-card-actions">${btns.join('')}</div>`;
    }

    function renderCodexCard(item) {
      const sec = item.section || 'philosophies';
      const conv = item.conviction || 'active';
      const score = clampNum(item.leverage_score, 0, 100, 75);
      const isHighlighted = state.highlightItemId && state.highlightItemId === item.id;
      const cardClasses = [
        'codex-card',
        `is-${sec}`,
        item.pinned ? 'is-pinned' : '',
      ].filter(Boolean).join(' ');

      const headBadges = [];
      if (sec === 'ideas' && item.stage) {
        headBadges.push(
          `<button type="button" class="codex-stage is-${escAttr(item.stage)}" data-codex-advance-stage="${escAttr(item.id)}" title="Click to advance stage">${escHtml(STAGE_LABEL[item.stage] || item.stage)}</button>`
        );
      } else {
        headBadges.push(
          `<span class="codex-conviction is-${escAttr(conv)}">${escHtml(CONVICTION_LABEL[conv] || conv.toUpperCase())}</span>`
        );
      }

      let bodyHtml = '';

      if (sec === 'philosophies') {
        const thesisText = item.thesis || item.summary || '';
        const antiText = item.anti_pattern || '';
        if (thesisText || antiText) {
          bodyHtml += `<div class="codex-thesis-box">`;
          if (thesisText) {
            bodyHtml += `<div class="codex-thesis-row is-thesis"><span class="codex-thesis-label">CORE THESIS</span><span class="codex-thesis-text">${escHtml(thesisText)}</span></div>`;
          }
          if (antiText) {
            bodyHtml += `<div class="codex-thesis-row is-antipattern"><span class="codex-thesis-label">ANTI-PATTERN</span><span class="codex-thesis-text">${escHtml(antiText)}</span></div>`;
          }
          bodyHtml += `</div>`;
        }
        if (item.summary && item.thesis && item.summary !== item.thesis) {
          bodyHtml += `<p class="codex-card-subtitle">${escHtml(item.summary)}</p>`;
        }
      } else if (sec === 'interests') {
        if (item.summary) {
          bodyHtml += `<p class="codex-card-subtitle">${escHtml(item.summary)}</p>`;
        }
        if (item.thesis) {
          bodyHtml += (
            `<div class="codex-thesis-box">` +
            `<div class="codex-thesis-row is-thesis"><span class="codex-thesis-label">SIGNAL THESIS</span><span class="codex-thesis-text">${escHtml(item.thesis)}</span></div>` +
            `</div>`
          );
        }
        if (Array.isArray(item.bookmarks) && item.bookmarks.length > 0) {
          bodyHtml += (
            `<div class="codex-bookmarks-list">` +
            `<div class="codex-bookmarks-header"><span>Embedded X Bookmarks</span><span>${item.bookmarks.length} signals</span></div>` +
            item.bookmarks.slice(0, 3).map((bm) => renderBookmarkRow(bm, { showDomain: false })).join('') +
            `</div>`
          );
        }
      } else if (sec === 'hobbies') {
        if (item.summary) {
          bodyHtml += `<p class="codex-card-subtitle">${escHtml(item.summary)}</p>`;
        }
        if (item.thesis || item.anti_pattern) {
          bodyHtml += `<div class="codex-thesis-box">`;
          if (item.thesis) {
            bodyHtml += `<div class="codex-thesis-row is-thesis"><span class="codex-thesis-label">CRAFT FOCUS</span><span class="codex-thesis-text">${escHtml(item.thesis)}</span></div>`;
          }
          if (item.anti_pattern) {
            bodyHtml += `<div class="codex-thesis-row is-antipattern"><span class="codex-thesis-label">AVOID</span><span class="codex-thesis-text">${escHtml(item.anti_pattern)}</span></div>`;
          }
          bodyHtml += `</div>`;
        }
      } else {
        if (item.summary) {
          bodyHtml += `<p class="codex-card-subtitle">${escHtml(item.summary)}</p>`;
        }
        if (item.thesis || item.anti_pattern) {
          bodyHtml += `<div class="codex-thesis-box">`;
          if (item.thesis) {
            bodyHtml += `<div class="codex-thesis-row is-thesis"><span class="codex-thesis-label">THESIS</span><span class="codex-thesis-text">${escHtml(item.thesis)}</span></div>`;
          }
          if (item.anti_pattern) {
            bodyHtml += `<div class="codex-thesis-row is-antipattern"><span class="codex-thesis-label">ANTI-PATTERN</span><span class="codex-thesis-text">${escHtml(item.anti_pattern)}</span></div>`;
          }
          bodyHtml += `</div>`;
        }
      }

      if (item.next_move) {
        const nextStage = sec === 'ideas' && item.stage ? NEXT_STAGE_MAP[item.stage] : null;
        bodyHtml += (
          `<div class="codex-next-move">` +
          `<div class="codex-next-move-copy">` +
          `<span class="codex-next-move-label">Next Move</span>` +
          `<span class="codex-next-move-text">${escHtml(item.next_move)}</span>` +
          `</div>` +
          (nextStage
            ? `<button type="button" class="codex-stage-advance-btn" data-codex-advance-stage="${escAttr(item.id)}" title="Advance to ${escAttr(STAGE_LABEL[nextStage])}">Advance ${getIcon('arrow', 'arrow')}</button>`
            : '') +
          `</div>`
        );
      } else if (sec === 'ideas' && item.stage && NEXT_STAGE_MAP[item.stage]) {
        const nextStage = NEXT_STAGE_MAP[item.stage];
        bodyHtml += (
          `<div class="codex-next-move">` +
          `<div class="codex-next-move-copy">` +
          `<span class="codex-next-move-label">Pipeline Stage</span>` +
          `<span class="codex-next-move-text">Ready to advance from ${escHtml(STAGE_LABEL[item.stage])} to ${escHtml(STAGE_LABEL[nextStage])}</span>` +
          `</div>` +
          `<button type="button" class="codex-stage-advance-btn" data-codex-advance-stage="${escAttr(item.id)}">Advance ${getIcon('arrow', 'arrow')}</button>` +
          `</div>`
        );
      }

      bodyHtml += renderPeoplePills(item.linked_people);
      bodyHtml += renderAiPanel(item);

      return (
        `<article class="${cardClasses}" data-codex-item-id="${escAttr(item.id)}"${isHighlighted ? ' style="box-shadow:0 0 0 2px var(--border-focus);"' : ''}>` +
        `<div class="codex-card-head">` +
        `<div class="codex-card-title-row">` +
        `<h3 class="codex-card-title">${escHtml(item.title)}</h3>` +
        headBadges.join('') +
        `</div>` +
        (item.subtitle ? `<p class="codex-card-subtitle">${escHtml(item.subtitle)}</p>` : '') +
        `<div class="codex-card-meta">` +
        `<span class="codex-domain-pill">${escHtml(item.domain || 'General')}</span>` +
        (item.source_label ? `<span class="codex-pill">${escHtml(item.source_label)}</span>` : '') +
        renderBoardOriginBadge(item) +
        `<span class="codex-leverage" title="Leverage score ${score}/100">` +
        `<span class="codex-leverage-label">LEV ${score}</span>` +
        `<span class="codex-leverage-bar"><span class="codex-leverage-fill" style="width:${score}%"></span></span>` +
        `</span>` +
        `</div>` +
        `</div>` +
        bodyHtml +
        renderCardActions(item, sec) +
        `</article>`
      );
    }

    function renderIdeasKanban(items) {
      const grouped = { spark: [], validating: [], building: [], shipped: [], parked: [] };
      for (let i = 0; i < items.length; i += 1) {
        const st = items[i].stage && grouped[items[i].stage] ? items[i].stage : 'spark';
        grouped[st].push(items[i]);
      }

      const colsHtml = PIPELINE_STAGES.map((col) => {
        const list = grouped[col.id];
        const cardsHtml = list.length
          ? list.map((item) => {
              const nextStage = NEXT_STAGE_MAP[item.stage || col.id];
              const busy = Boolean(state.aiBusyMap[item.id]);
              const score = clampNum(item.leverage_score, 0, 100, 75);
              return (
                `<div class="codex-pipeline-card" data-codex-item-id="${escAttr(item.id)}">` +
                `<div class="codex-pipeline-card-head">` +
                `<h4 class="codex-pipeline-card-title">${escHtml(item.title)}</h4>` +
                `<span class="codex-leverage-label">L${score}</span>` +
                `</div>` +
                `<div class="codex-card-meta">` +
                `<span class="codex-domain-pill">${escHtml(item.domain || 'Venture')}</span>` +
                (item.pinned ? `<span class="codex-conviction is-core">PIN</span>` : '') +
                renderBoardOriginBadge(item) +
                `</div>` +
                `<p class="codex-pipeline-card-sub">${escHtml(item.next_move || item.summary || item.subtitle || '')}</p>` +
                renderPeoplePills(item.linked_people) +
                renderAiPanel(item) +
                `<div class="codex-pipeline-card-actions codex-pipeline-card-foot">` +
                `<div class="codex-pipeline-card-pills">` +
                `<button type="button" class="codex-action-btn is-primary" data-codex-promote="${escAttr(item.id)}" title="Promote to Today Action">Promote</button>` +
                `<button type="button" class="codex-action-btn" data-codex-send-board="${escAttr(item.id)}" title="Dispatch to Agent Board">Board</button>` +
                `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="next_moves"${busy ? ' disabled' : ''} title="Next 3 Moves (AI)">AI</button>` +
                (item.vault_doc_path ? `<button type="button" class="codex-action-btn" data-codex-open-doc="${escAttr(item.vault_doc_path)}" title="Open Source Doc">Doc</button>` : '') +
                `<button type="button" class="codex-action-btn" data-codex-edit="${escAttr(item.id)}" title="Edit">Edit</button>` +
                `</div>` +
                `<div class="codex-pipeline-card-advance">` +
                (nextStage
                  ? `<button type="button" class="codex-stage-advance-btn" data-codex-advance-stage="${escAttr(item.id)}" title="Move to ${escAttr(STAGE_LABEL[nextStage])}">Advance ${getIcon('arrow', 'arrow')}</button>`
                  : `<span class="codex-stage is-shipped">Shipped</span>`) +
                `</div>` +
                `</div>` +
                `</div>`
              );
            }).join('')
          : `<div class="codex-empty" style="padding:18px 12px;"><p class="codex-empty-desc">No items in ${escHtml(col.label)}.</p></div>`;

        return (
          `<section class="codex-pipeline-col" aria-label="${escAttr(col.label)} column">` +
          `<div class="codex-pipeline-head">` +
          `<span class="codex-pipeline-title"><span class="codex-section-dot" style="background-color:${col.color}"></span>${escHtml(col.label)}</span>` +
          `<span class="codex-pipeline-count">${list.length}</span>` +
          `</div>` +
          `<div class="codex-pipeline-body">${cardsHtml}</div>` +
          `</section>`
        );
      }).join('');

      let parkedHtml = '';
      if (grouped.parked.length > 0) {
        const isOpenAttr = state.filterStage === 'parked' ? ' open' : '';
        parkedHtml = (
          `<details class="codex-parked-drawer"${isOpenAttr}>` +
          `<summary class="codex-parked-summary">` +
          `<span class="codex-parked-title"><span class="codex-section-dot" style="background-color:var(--ink-muted)"></span>Parked Ideas (${grouped.parked.length})</span>` +
          `<span class="codex-parked-hint">Click to inspect or revive to Validating</span>` +
          `</summary>` +
          `<div class="codex-parked-body">` +
          `<div class="codex-card-grid">` +
          grouped.parked.map((item) => renderCodexCard(item)).join('') +
          `</div>` +
          `</div>` +
          `</details>`
        );
      }

      return `<div class="codex-pipeline">${colsHtml}</div>${parkedHtml}`;
    }

    function renderBookmarksExplorer() {
      const allBookmarks = (state.data && Array.isArray(state.data.recent_bookmarks)) ? state.data.recent_bookmarks : [];
      if (!allBookmarks.length) return '';

      const domainCounts = Object.create(null);
      for (let i = 0; i < allBookmarks.length; i += 1) {
        const d = allBookmarks[i].domain || 'General';
        domainCounts[d] = (domainCounts[d] || 0) + 1;
      }
      const domains = Object.keys(domainCounts).sort((a, b) => domainCounts[b] - domainCounts[a]);

      const q = state.searchQuery.trim().toLowerCase();
      const filtered = allBookmarks.filter((bm) => {
        if (state.bookmarkDomainFilter !== 'all' && String(bm.domain || '').toLowerCase() !== state.bookmarkDomainFilter.toLowerCase()) {
          return false;
        }
        if (q) {
          const hay = `${bm.author || ''} ${bm.text || ''} ${bm.domain || ''}`.toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });

      const chipsHtml = (
        `<button type="button" class="codex-filter-chip${state.bookmarkDomainFilter === 'all' ? ' is-active' : ''}" data-codex-bm-domain="all">All (${allBookmarks.length})</button>` +
        domains.slice(0, 6).map((dom) => (
          `<button type="button" class="codex-filter-chip${state.bookmarkDomainFilter === dom ? ' is-active' : ''}" data-codex-bm-domain="${escAttr(dom)}">${escHtml(dom)} (${domainCounts[dom]})</button>`
        )).join('')
      );

      return (
        `<section class="codex-bookmarks-explorer" aria-label="X Bookmarks Signal Feed">` +
        `<div class="codex-action-panel-head">` +
        `<h3 class="codex-action-panel-title">X Bookmarks Signal Feed</h3>` +
        `<span class="codex-pill">${filtered.length} of ${allBookmarks.length}</span>` +
        `</div>` +
        `<div class="codex-filters">${chipsHtml}</div>` +
        (filtered.length
          ? `<div class="codex-bookmarks-list">${filtered.slice(0, 18).map((bm) => renderBookmarkRow(bm, { showDomain: true })).join('')}</div>`
          : `<div class="codex-empty" style="padding:20px;"><p class="codex-empty-desc">No bookmarks match this filter.</p></div>`) +
        `</section>`
      );
    }

    function renderActionPlane() {
      const q = state.searchQuery.trim().toLowerCase();
      const ownerActions = state.ownerActions.filter((act) => {
        if (state.actionFilter === 'open' && act.done) return false;
        if (state.actionFilter === 'done' && !act.done) return false;
        if (q) {
          const hay = `${act.title} ${act.detail} ${act.tag} ${act.source}`.toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });

      const openCount = state.ownerActions.filter((a) => !a.done).length;
      const doneCount = state.ownerActions.filter((a) => a.done).length;

      const codexActions = getFilteredItemsForSection('actions');
      const commitments = codexActions.filter((i) => i.id.indexOf('action_commit_') === 0 || (Array.isArray(i.tags) && i.tags.indexOf('commitment') !== -1));

      const decisionIds = Object.create(null);
      const decisions = [];
      const rawDecisions = (state.data && Array.isArray(state.data.open_decisions)) ? state.data.open_decisions : [];
      for (let i = 0; i < rawDecisions.length; i += 1) {
        const d = rawDecisions[i];
        if (d.status === 'archived') continue;
        if (!matchesSearch(d, state.searchQuery.trim())) continue;
        if (state.filterDomain !== 'all' && String(d.domain || '').toLowerCase() !== state.filterDomain.toLowerCase()) continue;
        decisionIds[d.id] = true;
        decisions.push(d);
      }

      const ventureMoves = codexActions.filter((i) => {
        if (decisionIds[i.id]) return false;
        if (i.id.indexOf('action_commit_') === 0) return false;
        if (i.id.indexOf('action_owner_') === 0) return false;
        if (Array.isArray(i.tags) && i.tags.indexOf('commitment') !== -1) return false;
        return true;
      });

      const liveActionsHtml = ownerActions.length
        ? ownerActions.map((act) => (
            `<div class="codex-action-row${act.done ? ' is-done' : ''}" data-owner-action-id="${escAttr(act.id)}">` +
            `<input type="checkbox" class="codex-action-check" data-codex-toggle-action="${escAttr(act.id)}"${act.done ? ' checked' : ''} aria-label="Toggle ${escAttr(act.title)}">` +
            `<div class="codex-action-content">` +
            `<p class="codex-action-title">${escHtml(act.title)}</p>` +
            (act.detail ? `<p class="codex-action-detail">${escHtml(act.detail)}</p>` : '') +
            `<div class="codex-action-meta">` +
            `<span class="codex-action-tag">${escHtml(act.tag || 'Work')}</span>` +
            `<span class="codex-action-source">${escHtml(act.source || 'Owner')}</span>` +
            `</div>` +
            `</div>` +
            `<div class="codex-action-controls">` +
            `<button type="button" class="codex-action-btn is-danger" data-codex-delete-action="${escAttr(act.id)}" title="Delete action">${getIcon('trash', 'trash')}</button>` +
            `</div>` +
            `</div>`
          )).join('')
        : `<div class="codex-empty" style="padding:22px 14px;"><p class="codex-empty-title">No ${escHtml(state.actionFilter === 'done' ? 'completed' : 'open')} actions</p><p class="codex-empty-desc">Add an action above or promote any Codex philosophy, idea, or commitment.</p></div>`;

      const commitmentsHtml = commitments.length
        ? (
          `<div class="codex-bookmarks-header" style="margin-top:8px;"><span>LifeOS Commitments</span><span>${commitments.length} open</span></div>` +
          `<div class="codex-action-list">` +
          commitments.map((c) => (
            `<div class="codex-action-row" data-codex-item-id="${escAttr(c.id)}">` +
            `<div class="codex-action-content">` +
            `<p class="codex-action-title">${escHtml(c.title)}</p>` +
            (c.summary ? `<p class="codex-action-detail">${escHtml(c.summary)}</p>` : '') +
            `<div class="codex-action-meta">` +
            `<span class="codex-action-tag">${escHtml(c.domain || 'Execution')}</span>` +
            `<span class="codex-action-source">${escHtml(c.source_label || 'Commitments')}</span>` +
            `</div>` +
            renderPeoplePills(c.linked_people) +
            `</div>` +
            `<div class="codex-action-controls" style="flex-direction:column;align-items:flex-end;">` +
            `<button type="button" class="codex-action-btn is-primary" data-codex-promote="${escAttr(c.id)}">Move to Today</button>` +
            (c.vault_doc_path ? `<button type="button" class="codex-action-btn" data-codex-open-doc="${escAttr(c.vault_doc_path)}">Doc</button>` : '') +
            `</div>` +
            `</div>`
          )).join('') +
          `</div>`
        )
        : '';

      function renderDecisionCard(item, badgeLabel) {
        const busy = Boolean(state.aiBusyMap[item.id]);
        const score = clampNum(item.leverage_score, 0, 100, 88);
        return (
          `<article class="codex-decision-card" data-codex-item-id="${escAttr(item.id)}">` +
          `<div class="codex-card-title-row">` +
          `<h4 class="codex-decision-title">${escHtml(item.title)}</h4>` +
          `<span class="codex-conviction is-${escAttr(item.conviction || 'core')}">${escHtml(badgeLabel)}</span>` +
          `</div>` +
          `<div class="codex-card-meta">` +
          `<span class="codex-domain-pill">${escHtml(item.domain || 'Strategy')}</span>` +
          renderBoardOriginBadge(item) +
          `<span class="codex-leverage-label">LEV ${score}</span>` +
          `</div>` +
          `<p class="codex-decision-summary">${escHtml(item.summary || item.subtitle || '')}</p>` +
          (item.next_move
            ? `<div class="codex-next-move"><div class="codex-next-move-copy"><span class="codex-next-move-label">Next Move</span><span class="codex-next-move-text">${escHtml(item.next_move)}</span></div></div>`
            : '') +
          renderPeoplePills(item.linked_people) +
          renderAiPanel(item) +
          `<div class="codex-card-actions">` +
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="challenge"${busy ? ' disabled' : ''}>${getIcon('sparkles', 'sparkles')} Pressure-Test</button>` +
          `<button type="button" class="codex-action-btn is-ai" data-codex-synth="${escAttr(item.id)}" data-synth-mode="next_moves"${busy ? ' disabled' : ''}>Next 3 Moves</button>` +
          `<button type="button" class="codex-action-btn is-primary" data-codex-promote="${escAttr(item.id)}">${getIcon('bolt', 'bolt')} Promote</button>` +
          `<button type="button" class="codex-action-btn" data-codex-send-board="${escAttr(item.id)}" title="Dispatch to Agent Board">${getIcon('board', 'board')} Board</button>` +
          (item.vault_doc_path ? `<button type="button" class="codex-action-btn" data-codex-open-doc="${escAttr(item.vault_doc_path)}">${getIcon('doc', 'doc')} Open Doc</button>` : '') +
          `<button type="button" class="codex-action-btn" data-codex-edit="${escAttr(item.id)}">${getIcon('edit', 'edit')} Edit</button>` +
          `</div>` +
          `</article>`
        );
      }

      const rightCardsHtml = [
        ...decisions.map((d) => renderDecisionCard(d, 'DECISION')),
        ...ventureMoves.map((m) => renderDecisionCard(m, 'VENTURE MOVE')),
      ].join('');

      return (
        `<div class="codex-action-grid">` +
        `<section class="codex-action-panel" aria-label="Live Actions and Commitments">` +
        `<div class="codex-action-panel-head">` +
        `<h3 class="codex-action-panel-title">Live Actions &amp; Commitments</h3>` +
        `<div class="codex-filters" style="flex:0 0 auto;">` +
        `<button type="button" class="codex-filter-chip${state.actionFilter === 'open' ? ' is-active' : ''}" data-codex-action-filter="open">Open (${openCount})</button>` +
        `<button type="button" class="codex-filter-chip${state.actionFilter === 'done' ? ' is-active' : ''}" data-codex-action-filter="done">Done (${doneCount})</button>` +
        `<button type="button" class="codex-filter-chip${state.actionFilter === 'all' ? ' is-active' : ''}" data-codex-action-filter="all">All (${state.ownerActions.length})</button>` +
        `</div>` +
        `</div>` +
        `<form class="codex-quick-action" data-codex-quick-action-form>` +
        `<input type="text" name="title" placeholder="+ Add action to Today..." autocomplete="off" aria-label="Add new action">` +
        `<select name="tag" class="codex-select" style="width:auto;height:28px;font-size:11.5px;padding:0 8px;" aria-label="Action tag">` +
        `<option value="Work">Work</option>` +
        `<option value="Venture">Venture</option>` +
        `<option value="Personal">Personal</option>` +
        `<option value="Principle">Principle</option>` +
        `<option value="Research">Research</option>` +
        `</select>` +
        `<button type="submit" class="codex-btn-primary" style="height:28px;padding:0 10px;"${state.quickActionBusy ? ' disabled' : ''}>Add</button>` +
        `</form>` +
        `<div class="codex-action-list">${liveActionsHtml}</div>` +
        commitmentsHtml +
        `</section>` +
        `<section class="codex-action-panel" aria-label="Open Strategic Decisions and Active Venture Moves">` +
        `<div class="codex-action-panel-head">` +
        `<h3 class="codex-action-panel-title">Open Strategic Decisions &amp; Venture Moves</h3>` +
        `<span class="codex-pill">${decisions.length + ventureMoves.length} active</span>` +
        `</div>` +
        (rightCardsHtml
          ? `<div class="codex-action-list">${rightCardsHtml}</div>`
          : `<div class="codex-empty" style="padding:24px 14px;"><p class="codex-empty-title">No matching decisions</p><p class="codex-empty-desc">Clear search or domain filters to view open strategic decisions.</p></div>`) +
        `</section>` +
        `</div>`
      );
    }

    function renderKpiRow() {
      const stats = (state.data && state.data.stats) || {
        total: 0,
        philosophies: 0,
        interests: 0,
        hobbies: 0,
        ideas: 0,
        actions_open: 0,
        actions_done: 0,
        bookmarks: 0,
        decisions_open: 0,
        pinned: 0,
      };
      const stages = (state.data && state.data.stages) || { spark: 0, validating: 0, building: 0, shipped: 0, parked: 0 };
      const openOwnerCount = state.ownerActions.filter((a) => !a.done).length;
      const corePhilCount = getAllCodexItems().filter((i) => i.section === 'philosophies' && i.conviction === 'core' && i.status !== 'archived').length;
      const combinedOpenActions = openOwnerCount + (Number(stats.decisions_open) || 0);

      return (
        `<div class="codex-kpi-row">` +
        `<button type="button" class="codex-kpi-card" data-codex-section="philosophies" style="text-align:left;cursor:pointer;">` +
        `<span class="codex-kpi-label"><span>Philosophies</span><span class="codex-section-dot is-philosophies"></span></span>` +
        `<span class="codex-kpi-value">${Number(stats.philosophies) || 0}</span>` +
        `<span class="codex-kpi-meta">${corePhilCount} core theses | ${Number(stats.pinned) || 0} pinned</span>` +
        `</button>` +
        `<button type="button" class="codex-kpi-card" data-codex-section="interests" style="text-align:left;cursor:pointer;">` +
        `<span class="codex-kpi-label"><span>Interests &amp; Hobbies</span><span class="codex-section-dot is-interests"></span></span>` +
        `<span class="codex-kpi-value">${(Number(stats.interests) || 0) + (Number(stats.hobbies) || 0)}</span>` +
        `<span class="codex-kpi-meta">${Number(stats.bookmarks) || 0} X bookmarks indexed</span>` +
        `</button>` +
        `<button type="button" class="codex-kpi-card" data-codex-section="ideas" style="text-align:left;cursor:pointer;">` +
        `<span class="codex-kpi-label"><span>Active Ideas</span><span class="codex-section-dot is-ideas"></span></span>` +
        `<span class="codex-kpi-value">${Number(stats.ideas) || 0}</span>` +
        `<span class="codex-kpi-meta">${Number(stages.building) || 0} building | ${Number(stages.validating) || 0} validating</span>` +
        `</button>` +
        `<button type="button" class="codex-kpi-card" data-codex-section="actions" style="text-align:left;cursor:pointer;">` +
        `<span class="codex-kpi-label"><span>Open Actions &amp; Decisions</span><span class="codex-section-dot is-actions"></span></span>` +
        `<span class="codex-kpi-value">${combinedOpenActions}</span>` +
        `<span class="codex-kpi-meta">${openOwnerCount} tasks | ${Number(stats.decisions_open) || 0} decisions</span>` +
        `</button>` +
        `</div>`
      );
    }

    function renderFilterChipsHtml() {
      const sec = state.activeSection;
      const chips = [];

      const hasAnyFilter = state.filterPinnedOnly || state.filterDomain !== 'all' || state.filterStage !== 'all' || state.filterConviction !== 'all';
      chips.push(
        `<button type="button" class="codex-filter-chip${!hasAnyFilter ? ' is-active' : ''}" data-codex-reset-filters>All</button>`
      );
      chips.push(
        `<button type="button" class="codex-filter-chip${state.filterPinnedOnly ? ' is-active' : ''}" data-codex-toggle-pinned>Pinned</button>`
      );

      if (sec === 'philosophies') {
        ['core', 'active', 'testing'].forEach((lvl) => {
          chips.push(
            `<button type="button" class="codex-filter-chip${state.filterConviction === lvl ? ' is-active' : ''}" data-codex-conviction-filter="${lvl}">${CONVICTION_LABEL[lvl]}</button>`
          );
        });
      }

      if (sec === 'ideas') {
        STAGES.forEach((st) => {
          chips.push(
            `<button type="button" class="codex-filter-chip${state.filterStage === st ? ' is-active' : ''}" data-codex-stage-filter="${st}">${STAGE_LABEL[st]}</button>`
          );
        });
      }

      // Top domains relevant to current section
      const secItems = getAllCodexItems().filter((i) => i.status !== 'archived' && (sec === 'all' || i.section === sec));
      const domCounts = Object.create(null);
      for (let i = 0; i < secItems.length; i += 1) {
        const d = secItems[i].domain || 'General';
        domCounts[d] = (domCounts[d] || 0) + 1;
      }
      const topDomains = Object.keys(domCounts).sort((a, b) => domCounts[b] - domCounts[a]).slice(0, 5);
      topDomains.forEach((dom) => {
        const active = state.filterDomain.toLowerCase() === dom.toLowerCase();
        chips.push(
          `<button type="button" class="codex-filter-chip${active ? ' is-active' : ''}" data-codex-domain-filter="${escAttr(dom)}">${escHtml(dom)}</button>`
        );
      });

      return chips.join('');
    }

    function renderRailHtml() {
      const stats = (state.data && state.data.stats) || { total: 0, pinned: 0, actions_open: 0, bookmarks: 0 };
      const apiSections = (state.data && Array.isArray(state.data.sections)) ? state.data.sections : [];
      const countById = Object.create(null);
      for (let i = 0; i < apiSections.length; i += 1) {
        countById[apiSections[i].id] = apiSections[i].count;
      }

      const navButtons = SECTIONS.map((sec) => {
        const active = state.activeSection === sec.id;
        const count = countById[sec.id] !== undefined ? countById[sec.id] : 0;
        return (
          `<button type="button" class="codex-section-btn${active ? ' is-active' : ''}" role="tab" aria-selected="${active ? 'true' : 'false'}" data-codex-section="${sec.id}">` +
          `<div class="codex-section-btn-row">` +
          `<span class="codex-section-btn-label">` +
          `<span class="codex-section-dot is-${sec.id}"></span>` +
          `${getIcon(sec.icon, sec.icon)}` +
          `<span>${escHtml(sec.label)}</span>` +
          `</span>` +
          `<span class="codex-section-count">${count}</span>` +
          `</div>` +
          `<span class="codex-section-desc">${escHtml(sec.description)}</span>` +
          `</button>`
        );
      }).join('');

      const domains = (state.data && Array.isArray(state.data.domains)) ? state.data.domains : [];

      return (
        `<div class="codex-rail-head">` +
        `<span class="codex-rail-eyebrow">Mind Codex</span>` +
        `<h2 class="codex-rail-title">Operating System</h2>` +
        `</div>` +
        `<div class="codex-rail-summary">` +
        `<div class="codex-rail-stat"><span class="codex-rail-stat-value">${Number(stats.total) || 0}</span><span class="codex-rail-stat-label">Codex Entries</span></div>` +
        `<div class="codex-rail-stat"><span class="codex-rail-stat-value">${Number(stats.pinned) || 0}</span><span class="codex-rail-stat-label">Pinned Core</span></div>` +
        `</div>` +
        `<nav class="codex-section-nav" role="tablist" aria-label="Mind Codex sections">${navButtons}</nav>` +
        `<div class="codex-dist-block">${renderDomainBalanceHtml(domains)}</div>` +
        `<button type="button" class="codex-capture-btn" data-codex-open-capture>${getIcon('plus', 'plus')} Capture to Codex</button>`
      );
    }

    function renderHeaderControlsHtml() {
      const meta = getSectionMeta(state.activeSection);
      const isMap = state.viewMode === 'map';
      const viewToggleHtml = state.activeSection === 'ideas'
        ? (
          `<div class="codex-view-toggle" role="tablist" aria-label="Ideas view mode">` +
          `<button type="button" class="codex-view-btn${!isMap && state.viewMode === 'grid' ? ' is-active' : ''}" data-codex-view="grid" data-codex-ideas-view="grid">${getIcon('grid', 'grid')} Grid</button>` +
          `<button type="button" class="codex-view-btn${!isMap && state.viewMode === 'pipeline' ? ' is-active' : ''}" data-codex-view="pipeline" data-codex-ideas-view="pipeline">${getIcon('columns', 'columns')} Pipeline</button>` +
          `<button type="button" class="codex-view-btn${isMap ? ' is-active' : ''}" data-codex-view="map">${getIcon('network', 'network')} Mind Map</button>` +
          `</div>`
        )
        : (
          `<div class="codex-view-toggle" role="tablist" aria-label="Codex view mode">` +
          `<button type="button" class="codex-view-btn${!isMap ? ' is-active' : ''}" data-codex-view="grid">${getIcon('grid', 'grid')} Cards</button>` +
          `<button type="button" class="codex-view-btn${isMap ? ' is-active' : ''}" data-codex-view="map">${getIcon('network', 'network')} Mind Map</button>` +
          `</div>`
        );

      return {
        title: meta.label,
        subtitle: meta.description,
        actionsHtml:
          viewToggleHtml +
          `<button type="button" class="codex-btn-secondary" data-codex-refresh title="Reload Mind Codex">${getIcon('refresh', 'refresh')} Refresh</button>` +
          `<button type="button" class="codex-btn-primary" data-codex-open-capture>${getIcon('plus', 'plus')} Capture</button>`,
        filtersHtml: renderFilterChipsHtml(),
      };
    }

    function renderMainContentHtml() {
      if (state.loading && !state.data) {
        return `<div class="codex-empty"><p class="codex-empty-title">Loading Mind Codex...</p><p class="codex-empty-desc">Assembling theses, X bookmarks, craft anchors, ventures, and active decisions.</p></div>`;
      }
      if (state.error && !state.data) {
        return (
          `<div class="codex-empty">` +
          `<p class="codex-empty-title">Unable to load Mind Codex</p>` +
          `<p class="codex-empty-desc">${escHtml(state.error)}</p>` +
          `<button type="button" class="codex-btn-primary" data-codex-refresh>Retry</button>` +
          `</div>`
        );
      }

      if (state.viewMode === 'map') {
        return `<div class="codex-constellation-wrap" id="codex-constellation-host"></div>`;
      }

      const kpiHtml = renderKpiRow();

      const sec = state.activeSection;

      if (sec === 'actions') {
        return kpiHtml + renderActionPlane();
      }

      const items = getFilteredItemsForSection(sec);

      if (sec === 'ideas') {
        const funnelHtml = renderIdeasFunnelHtml(state.data && state.data.stages);
        const bodyHtml = state.viewMode === 'pipeline'
          ? renderIdeasKanban(items)
          : (items.length
              ? `<div class="codex-card-grid">${items.map((item) => renderCodexCard(item)).join('')}</div>`
              : `<div class="codex-empty"><p class="codex-empty-title">No matching ideas</p><p class="codex-empty-desc">Adjust your stage or search filter, or capture a new venture concept.</p><button type="button" class="codex-btn-primary" data-codex-open-capture>${getIcon('plus', 'plus')} Capture Idea</button></div>`);
        return kpiHtml + funnelHtml + bodyHtml;
      }

      if (sec === 'interests') {
        const gridHtml = items.length
          ? `<div class="codex-card-grid">${items.map((item) => renderCodexCard(item)).join('')}</div>`
          : `<div class="codex-empty"><p class="codex-empty-title">No matching interest clusters</p><p class="codex-empty-desc">Try clearing search or domain filters.</p></div>`;
        return kpiHtml + gridHtml + renderBookmarksExplorer();
      }

      const gridHtml = items.length
        ? `<div class="codex-card-grid">${items.map((item) => renderCodexCard(item)).join('')}</div>`
        : (
          `<div class="codex-empty">` +
          `<p class="codex-empty-title">No entries match these filters</p>` +
          `<p class="codex-empty-desc">Reset filters or add a fresh entry directly to ${escHtml(getSectionMeta(sec).label)}.</p>` +
          `<div style="display:flex;gap:8px;margin-top:4px;">` +
          `<button type="button" class="codex-btn-secondary" data-codex-reset-filters>Reset Filters</button>` +
          `<button type="button" class="codex-btn-primary" data-codex-open-capture>${getIcon('plus', 'plus')} Capture</button>` +
          `</div>` +
          `</div>`
        );

      return kpiHtml + gridHtml;
    }

    function renderModalHtml() {
      if (!state.modalOpen) return '';
      const editingItem = state.modalEditingId ? findItemById(state.modalEditingId) : null;
      const defaultSection = editingItem ? editingItem.section : (state.activeSection === 'all' ? 'ideas' : state.activeSection);
      const isEdit = Boolean(editingItem);

      const domains = (state.data && Array.isArray(state.data.domains))
        ? state.data.domains.map((d) => d.domain).filter(Boolean)
        : [];
      const domainOptions = domains.map((d) => `<option value="${escAttr(d)}"></option>`).join('');

      const titleVal = editingItem ? editingItem.title : '';
      const subtitleVal = editingItem ? (editingItem.subtitle || '') : '';
      const domainVal = editingItem ? (editingItem.domain || '') : '';
      const convVal = editingItem ? (editingItem.conviction || 'active') : 'active';
      const stageVal = editingItem ? (editingItem.stage || 'spark') : 'spark';
      const levVal = editingItem ? clampNum(editingItem.leverage_score, 0, 100, 80) : 80;
      const summaryVal = editingItem ? (editingItem.summary || '') : '';
      const thesisVal = editingItem ? (editingItem.thesis || '') : '';
      const antiVal = editingItem ? (editingItem.anti_pattern || '') : '';
      const nextVal = editingItem ? (editingItem.next_move || '') : '';
      const tagsVal = editingItem && Array.isArray(editingItem.tags) ? editingItem.tags.join(', ') : '';
      const peopleVal = editingItem && Array.isArray(editingItem.linked_people) ? editingItem.linked_people.join(', ') : '';
      const pinnedVal = editingItem ? Boolean(editingItem.pinned) : false;

      return (
        `<div class="codex-modal-backdrop" data-codex-modal-backdrop role="dialog" aria-modal="true" aria-labelledby="codex-modal-heading">` +
        `<form class="codex-modal" data-codex-capture-form>` +
        `<div class="codex-modal-head">` +
        `<h3 class="codex-modal-title" id="codex-modal-heading">${isEdit ? 'Edit Codex Entry' : 'Capture to Mind Codex'}</h3>` +
        `<button type="button" class="codex-modal-close" data-codex-close-modal aria-label="Close modal">x</button>` +
        `</div>` +
        `<div class="codex-modal-body">` +
        `<input type="hidden" name="id" value="${escAttr(editingItem ? editingItem.id : '')}">` +
        `<div class="codex-form-grid">` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-title">Title</label>` +
        `<input id="codex-f-title" class="codex-input" name="title" type="text" required placeholder="Sharp title for thesis, interest, hobby, or idea..." value="${escAttr(titleVal)}">` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-section">Section</label>` +
        `<select id="codex-f-section" class="codex-select" name="section">` +
        SECTIONS.map((s) => `<option value="${s.id}"${defaultSection === s.id ? ' selected' : ''}>${escHtml(s.label)}</option>`).join('') +
        `</select>` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-domain">Domain</label>` +
        `<input id="codex-f-domain" class="codex-input" name="domain" type="text" list="codex-domain-suggestions" placeholder="AI Agents, Creative Craft, Film..." value="${escAttr(domainVal)}">` +
        `<datalist id="codex-domain-suggestions">${domainOptions}</datalist>` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-conviction">Conviction</label>` +
        `<select id="codex-f-conviction" class="codex-select" name="conviction">` +
        `<option value="core"${convVal === 'core' ? ' selected' : ''}>Core</option>` +
        `<option value="active"${convVal === 'active' ? ' selected' : ''}>Active</option>` +
        `<option value="testing"${convVal === 'testing' ? ' selected' : ''}>Testing</option>` +
        `</select>` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-stage">Idea Stage</label>` +
        `<select id="codex-f-stage" class="codex-select" name="stage">` +
        STAGES.map((st) => `<option value="${st}"${stageVal === st ? ' selected' : ''}>${STAGE_LABEL[st]}</option>`).join('') +
        `</select>` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-leverage">Leverage Score (0-100)</label>` +
        `<input id="codex-f-leverage" class="codex-input" name="leverage_score" type="number" min="0" max="100" value="${levVal}">` +
        `</div>` +
        `<div class="codex-field" style="justify-content:flex-end;">` +
        `<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-top:16px;">` +
        `<input type="checkbox" class="codex-action-check" name="pinned"${pinnedVal ? ' checked' : ''} style="margin:0;">` +
        `<span>Pin to Top</span>` +
        `</label>` +
        `</div>` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-subtitle">Subtitle</label>` +
        `<input id="codex-f-subtitle" class="codex-input" name="subtitle" type="text" placeholder="One-line framing..." value="${escAttr(subtitleVal)}">` +
        `</div>` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-summary">Summary</label>` +
        `<textarea id="codex-f-summary" class="codex-textarea" name="summary" placeholder="Concrete context, stakes, and current reality...">${escHtml(summaryVal)}</textarea>` +
        `</div>` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-thesis">Core Thesis</label>` +
        `<textarea id="codex-f-thesis" class="codex-textarea" style="min-height:66px;" name="thesis" placeholder="What you affirmatively believe or optimize for...">${escHtml(thesisVal)}</textarea>` +
        `</div>` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-anti">Anti-Pattern / Enemy</label>` +
        `<textarea id="codex-f-anti" class="codex-textarea" style="min-height:60px;" name="anti_pattern" placeholder="What this principle explicitly rejects...">${escHtml(antiVal)}</textarea>` +
        `</div>` +
        `<div class="codex-field is-full">` +
        `<label for="codex-f-next">Next Move</label>` +
        `<input id="codex-f-next" class="codex-input" name="next_move" type="text" placeholder="Single concrete next execution step..." value="${escAttr(nextVal)}">` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-tags">Tags (comma separated)</label>` +
        `<input id="codex-f-tags" class="codex-input" name="tags" type="text" placeholder="thesis, craft, solana" value="${escAttr(tagsVal)}">` +
        `</div>` +
        `<div class="codex-field">` +
        `<label for="codex-f-people">Linked People (comma separated)</label>` +
        `<input id="codex-f-people" class="codex-input" name="linked_people" type="text" placeholder="Alex Rivera, Sam Chen" value="${escAttr(peopleVal)}">` +
        `</div>` +
        `</div>` +
        `</div>` +
        (isEdit
          ? `<div class="codex-modal-board-slot" data-codex-board-slot="${escAttr(editingItem.id)}" style="padding:10px 16px;border-top:1px solid var(--border-hairline);flex-shrink:0;"></div>`
          : '') +
        `<div class="codex-modal-foot">` +
        (isEdit
          ? `<button type="button" class="codex-action-btn is-danger" style="margin-right:auto;height:32px;padding:0 10px;" data-codex-delete-item="${escAttr(editingItem.id)}">${getIcon('trash', 'trash')} Delete</button>`
          : '') +
        `<button type="button" class="codex-btn-secondary" data-codex-close-modal>Cancel</button>` +
        `<button type="submit" class="codex-btn-primary"${state.modalSaving ? ' disabled' : ''}>${state.modalSaving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Save to Codex')}</button>` +
        `</div>` +
        `</form>` +
        `</div>`
      );
    }

    function ensureShellStructure() {
      if (!state.container) return;
      if (state.shellRendered && state.container.querySelector('.codex-shell')) return;

      state.container.innerHTML = (
        `<div class="codex-shell">` +
        `<aside class="codex-rail" data-codex-rail aria-label="Mind Codex Navigation"></aside>` +
        `<div class="codex-main" data-codex-main>` +
        `<header class="codex-header">` +
        `<div class="codex-header-top">` +
        `<div class="codex-header-copy">` +
        `<h1 class="codex-title" data-codex-title>Philosophies &amp; Principles</h1>` +
        `<p class="codex-subtitle" data-codex-subtitle></p>` +
        `</div>` +
        `<div class="codex-header-actions" data-codex-header-actions></div>` +
        `</div>` +
        `<div class="codex-toolbar">` +
        `<div class="codex-search-wrap">` +
        `<input type="search" class="codex-search" data-codex-search placeholder="Search theses, bookmarks, ventures, people..." aria-label="Search Mind Codex">` +
        `</div>` +
        `<div class="codex-filters" data-codex-filters></div>` +
        `</div>` +
        `</header>` +
        `<div class="codex-content" data-codex-content></div>` +
        `</div>` +
        `</div>` +
        `<div data-codex-modal-host></div>`
      );
      state.shellRendered = true;
    }

    function renderConstellationSideSheet(sheetBodyEl, node, helpers) {
      if (!sheetBodyEl || !node) return;
      const neighbors = Array.isArray(helpers && helpers.neighbors) ? helpers.neighbors : [];

      if (node.kind === 'person') {
        const secBadges = Object.keys(node.sectorBreakdown || {})
          .filter((k) => Number(node.sectorBreakdown[k]) > 0)
          .map((k) => `<span class="kcm-sheet-pill">${Number(node.sectorBreakdown[k])} ${escHtml(k)}</span>`)
          .join('');
        const neighborHtml = neighbors.length
          ? `<div class="kcm-sheet-block">` +
              `<span class="kcm-sheet-block-lbl">Linked Codex Entries (${neighbors.length})</span>` +
              `<div class="kcm-sheet-neighbor-list">` +
                neighbors.map((nb) => (
                  `<button type="button" class="kcm-sheet-neighbor-btn" data-kcm-sheet-select="${escAttr(nb.id)}">` +
                    `<span>${escHtml(nb.title || nb.name)}</span>` +
                    `<span class="kcm-sheet-pill">${escHtml(nb.sectorId || '')}</span>` +
                  `</button>`
                )).join('') +
              `</div>` +
            `</div>`
          : '';

        sheetBodyEl.innerHTML =
          `<h3 class="kcm-sheet-title">${escHtml(node.name)}</h3>` +
          `<p class="kcm-sheet-sub">${Number(node.linkedCount) || 0} linked entries across your Mind Constellation.</p>` +
          (secBadges ? `<div class="kcm-sheet-pills">${secBadges}</div>` : '') +
          `<div class="kcm-sheet-actions">` +
            `<button type="button" class="kcm-sheet-btn is-primary" data-codex-open-person="${escAttr(node.name)}">Open Person Dossier</button>` +
          `</div>` +
          neighborHtml;

        sheetBodyEl.querySelectorAll('[data-kcm-sheet-select]').forEach((btn) => {
          btn.addEventListener('click', () => {
            if (helpers && typeof helpers.selectNodeById === 'function') {
              helpers.selectNodeById(btn.getAttribute('data-kcm-sheet-select'));
            }
          });
        });
        return;
      }

      const item = node.item || findItemById(String(node.id || '').replace(/^item:/, ''));
      if (!item) return;
      const score = clampNum(item.leverage_score, 0, 100, 75);
      const nextStage = item.section === 'ideas' && item.stage ? NEXT_STAGE_MAP[item.stage] : null;
      const crosslinks = getCodexItemCrosslinks(item);

      const blocks = [];
      if (item.thesis) {
        blocks.push(`<div class="kcm-sheet-block"><span class="kcm-sheet-block-lbl">Core Thesis</span><p class="kcm-sheet-block-text">${escHtml(item.thesis)}</p></div>`);
      }
      if (item.anti_pattern) {
        blocks.push(`<div class="kcm-sheet-block"><span class="kcm-sheet-block-lbl">Anti-Pattern</span><p class="kcm-sheet-block-text">${escHtml(item.anti_pattern)}</p></div>`);
      }
      if (item.summary && item.summary !== item.thesis) {
        blocks.push(`<div class="kcm-sheet-block"><span class="kcm-sheet-block-lbl">Summary</span><p class="kcm-sheet-block-text">${escHtml(item.summary)}</p></div>`);
      }
      if (item.next_move) {
        blocks.push(`<div class="kcm-sheet-block"><span class="kcm-sheet-block-lbl">Next Move</span><p class="kcm-sheet-block-text">${escHtml(item.next_move)}</p></div>`);
      }

      const tasteCrosslinksHtml = crosslinks.length
        ? `<div class="kcm-sheet-block">` +
            `<span class="kcm-sheet-block-lbl">Taste Studio Crosslinks (${crosslinks.length})</span>` +
            `<div class="kcm-sheet-actions">` +
              crosslinks.map((cl) => (
                `<button type="button" class="kcm-sheet-crosslink is-${cl.relation}" data-codex-open-taste="${escAttr(cl.domain)}">` +
                  `<span>${cl.relation === 'conflicts' ? 'CONFLICT' : 'TASTE'}: ${escHtml(cl.title)}</span>` +
                  (cl.score != null ? `<span>${cl.score}%</span>` : '') +
                `</button>`
              )).join('') +
            `</div>` +
          `</div>`
        : '';

      const neighborHtml = neighbors.length
        ? `<div class="kcm-sheet-block">` +
            `<span class="kcm-sheet-block-lbl">Connected Nodes (${neighbors.length})</span>` +
            `<div class="kcm-sheet-neighbor-list">` +
              neighbors.map((nb) => (
                `<button type="button" class="kcm-sheet-neighbor-btn" data-kcm-sheet-select="${escAttr(nb.id)}">` +
                  `<span>${escHtml(nb.kind === 'person' ? nb.name : nb.title)}</span>` +
                  `<span class="kcm-sheet-pill">${escHtml(nb.kind === 'person' ? 'Person' : nb.sectorId)}</span>` +
                `</button>`
              )).join('') +
            `</div>` +
          `</div>`
        : '';

      const boardSlotId = `codex-sheet-board-${escAttr(item.id)}`;
      sheetBodyEl.innerHTML =
        `<h3 class="kcm-sheet-title">${escHtml(item.title)}</h3>` +
        (item.subtitle ? `<p class="kcm-sheet-sub">${escHtml(item.subtitle)}</p>` : '') +
        `<div class="kcm-sheet-pills">` +
          `<span class="kcm-sheet-pill">${escHtml(item.domain || 'General')}</span>` +
          (item.stage ? `<span class="kcm-sheet-pill">${escHtml(STAGE_LABEL[item.stage] || item.stage)}</span>` : '') +
          (item.conviction ? `<span class="kcm-sheet-pill">${escHtml(CONVICTION_LABEL[item.conviction] || item.conviction.toUpperCase())}</span>` : '') +
          `<span class="kcm-sheet-pill">LEV ${score}</span>` +
          renderBoardOriginBadge(item) +
        `</div>` +
        blocks.join('') +
        `<div class="kcm-sheet-actions">` +
          `<button type="button" class="kcm-sheet-btn is-primary" data-codex-promote="${escAttr(item.id)}">${getIcon('bolt', 'bolt')} Promote</button>` +
          (nextStage ? `<button type="button" class="kcm-sheet-btn" data-codex-advance-stage="${escAttr(item.id)}">Advance -> ${escHtml(STAGE_LABEL[nextStage])}</button>` : '') +
          `<button type="button" class="kcm-sheet-btn" data-codex-pin="${escAttr(item.id)}">${item.pinned ? 'Unpin' : 'Pin'}</button>` +
          `<button type="button" class="kcm-sheet-btn" data-codex-send-board="${escAttr(item.id)}">Board</button>` +
          `<button type="button" class="kcm-sheet-btn" data-codex-edit="${escAttr(item.id)}">Edit</button>` +
          (item.vault_doc_path ? `<button type="button" class="kcm-sheet-btn" data-codex-open-doc="${escAttr(item.vault_doc_path)}">Open Doc</button>` : '') +
          `<button type="button" class="kcm-sheet-btn" data-kcm-open-cards="${escAttr(item.id)}">Open Card</button>` +
        `</div>` +
        renderPeoplePills(item.linked_people) +
        `<div id="${boardSlotId}" data-codex-sheet-board-slot="${escAttr(item.id)}"></div>` +
        tasteCrosslinksHtml +
        neighborHtml;

      sheetBodyEl.querySelectorAll('[data-kcm-sheet-select]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (helpers && typeof helpers.selectNodeById === 'function') {
            helpers.selectNodeById(btn.getAttribute('data-kcm-sheet-select'));
          }
        });
      });

      const openCardBtn = sheetBodyEl.querySelector('[data-kcm-open-cards]');
      if (openCardBtn) {
        openCardBtn.addEventListener('click', () => {
          const targetSection = item.section && SECTION_MAP[item.section] ? item.section : state.activeSection;
          state.activeSection = targetSection;
          state.viewMode = 'grid';
          if (targetSection === 'ideas') state.ideasViewMode = 'grid';
          state.filterDomain = 'all';
          state.filterStage = 'all';
          state.filterConviction = 'all';
          state.filterPinnedOnly = false;
          state.highlightItemId = item.id ? String(item.id) : null;
          playSound('click');
          render({ animate: true });
        });
      }

      // Mount live Board discussions badge inside the side sheet when available
      const boardSlot = sheetBodyEl.querySelector('[data-codex-sheet-board-slot]');
      const widgets = getBoardWidgets();
      if (boardSlot && widgets && typeof widgets.mountCodexBoardBadge === 'function') {
        try {
          widgets.mountCodexBoardBadge(boardSlot, item, {
            openBoard: state.hooks && state.hooks.openBoard,
            showToast: state.hooks && state.hooks.showToast,
          });
        } catch {
          // ignore optional board widget error
        }
      }
    }

    function mountConstellationIfNeeded(contentEl) {
      if (state.viewMode !== 'map' || !contentEl) return;
      const hostEl = contentEl.querySelector('#codex-constellation-host');
      if (!hostEl) return;

      const mapLib = getConstellationLib();
      if (!mapLib) {
        hostEl.innerHTML = (
          `<div class="codex-empty" style="padding:36px 20px;">` +
          `<p class="codex-empty-title">Mind Map canvas unavailable</p>` +
          `<p class="codex-empty-desc">Constellation module is not loaded in this view. Switch back to Cards to browse entries.</p>` +
          `<button type="button" class="codex-btn-secondary" data-codex-view="grid">${getIcon('grid', 'grid')} Back to Cards</button>` +
          `</div>`
        );
        return;
      }

      const allCodexItems = Array.isArray(state.allItems) && state.allItems.length
        ? state.allItems
        : getAllCodexItems();

      try {
        const ctrl = mapLib.mount(hostEl, {
          items: allCodexItems,
          stats: state.data && state.data.stats,
          activeSection: state.activeSection,
          renderSideSheet: renderConstellationSideSheet,
          onSelectItem(item) {
            if (!item) return;
            const targetSection = item.section && SECTION_MAP[item.section] ? item.section : state.activeSection;
            state.activeSection = targetSection;
            state.viewMode = 'grid';
            if (targetSection === 'ideas') {
              state.ideasViewMode = 'grid';
            }
            state.filterDomain = 'all';
            state.filterStage = 'all';
            state.filterConviction = 'all';
            state.filterPinnedOnly = false;
            state.highlightItemId = item.id ? String(item.id) : null;
            playSound('click');
            render({ animate: true });
          },
          onSelectPerson(name) {
            if (name && state.hooks && typeof state.hooks.openPerson === 'function') {
              playSound('click');
              state.hooks.openPerson(name);
            }
          },
        });
        constellationCtrl = ctrl || null;
        if (constellationCtrl && typeof constellationCtrl.setFilter === 'function') {
          // Default to full auto-fit overview unless user actively selected a quadrant while in map mode
          constellationCtrl.setFilter('all', { instant: true });
        }
      } catch {
        constellationCtrl = null;
      }
    }

    function render(opts) {
      if (!state.mounted || !state.container) return;
      ensureShellStructure();

      // Always tear down any active constellation instance before DOM replacement
      destroyConstellation();

      const preserveSearch = opts && opts.preserveSearch;
      const animate = opts && opts.animate;

      const railEl = state.container.querySelector('[data-codex-rail]');
      const mainEl = state.container.querySelector('[data-codex-main]');
      const titleEl = state.container.querySelector('[data-codex-title]');
      const subtitleEl = state.container.querySelector('[data-codex-subtitle]');
      const actionsEl = state.container.querySelector('[data-codex-header-actions]');
      const filtersEl = state.container.querySelector('[data-codex-filters]');
      const searchEl = state.container.querySelector('[data-codex-search]');
      const contentEl = state.container.querySelector('[data-codex-content]');
      const modalHostEl = state.container.querySelector('[data-codex-modal-host]');
      const isConstellationMode = state.viewMode === 'map';

      if (mainEl) mainEl.classList.toggle('is-constellation-mode', isConstellationMode);
      if (contentEl) contentEl.classList.toggle('is-constellation-mode', isConstellationMode);

      const hdr = renderHeaderControlsHtml();

      if (railEl) railEl.innerHTML = renderRailHtml();
      if (titleEl) titleEl.textContent = hdr.title;
      if (subtitleEl) subtitleEl.textContent = hdr.subtitle;
      if (actionsEl) actionsEl.innerHTML = hdr.actionsHtml;
      if (filtersEl) filtersEl.innerHTML = hdr.filtersHtml;
      if (searchEl && !preserveSearch && searchEl.value !== state.searchQuery) {
        searchEl.value = state.searchQuery;
      }
      if (contentEl) {
        contentEl.innerHTML = renderMainContentHtml();
        mountConstellationIfNeeded(contentEl);
      }
      if (modalHostEl) modalHostEl.innerHTML = renderModalHtml();

      // Sync optional sliding tab ink on view toggle
      const viewToggle = actionsEl && actionsEl.querySelector('.codex-view-toggle');
      const activeViewBtn = viewToggle && viewToggle.querySelector('.codex-view-btn.is-active');
      if (viewToggle && activeViewBtn) {
        runSlidingTabInk(viewToggle, activeViewBtn);
      }

      if (animate && contentEl && state.viewMode !== 'map') {
        runMotionStagger(contentEl);
      }

      if (state.highlightItemId && contentEl) {
        const target = contentEl.querySelector(`[data-codex-item-id="${CSS.escape ? CSS.escape(state.highlightItemId) : state.highlightItemId.replace(/"/g, '\\"')}"]`);
        if (target && typeof target.scrollIntoView === 'function') {
          try {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch {
            target.scrollIntoView();
          }
          state.highlightItemId = null;
        }
      }

      hydrateModalBoardSlots();
    }

    function hydrateModalBoardSlots() {
      if (!state.container) return;
      const slots = state.container.querySelectorAll('[data-codex-board-slot]');
      if (!slots || !slots.length) return;
      const widgets = getBoardWidgets();
      if (!widgets || typeof widgets.mountCodexBoardBadge !== 'function') return;
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        const itemId = slot.getAttribute('data-codex-board-slot');
        if (!itemId) continue;
        const item = findItemById(itemId);
        if (!item) continue;
        try {
          widgets.mountCodexBoardBadge(slot, item, {
            openBoard: state.hooks && state.hooks.openBoard,
            showToast: state.hooks && state.hooks.showToast,
          });
        } catch {
          // ignore optional board widget hydration errors
        }
      }
    }

    function openCaptureModal(itemId) {
      state.modalOpen = true;
      state.modalEditingId = itemId || null;
      state.modalSaving = false;
      render({ preserveSearch: true });
      const titleInput = state.container && state.container.querySelector('#codex-f-title');
      if (titleInput) {
        setTimeout(() => {
          try {
            titleInput.focus();
          } catch {
            // ignore
          }
        }, 20);
      }
    }

    function closeCaptureModal() {
      if (!state.modalOpen) return;
      state.modalOpen = false;
      state.modalEditingId = null;
      state.modalSaving = false;
      render({ preserveSearch: true });
    }

    async function load(opts) {
      const options = opts || {};
      const seq = ++state.loadSeq;

      if (options.section && (SECTION_MAP[options.section] || options.section === 'all')) {
        state.activeSection = options.section;
        state.filterStage = 'all';
        state.filterConviction = 'all';
        if (state.viewMode !== 'map') {
          state.viewMode = options.section === 'ideas' ? state.ideasViewMode : 'grid';
        }
      }
      if (options.viewMode === 'grid' || options.viewMode === 'pipeline' || options.viewMode === 'map') {
        state.viewMode = options.viewMode;
        if (options.viewMode === 'grid' || options.viewMode === 'pipeline') {
          state.ideasViewMode = options.viewMode;
        }
      }
      if (typeof options.q === 'string') {
        state.searchQuery = options.q;
      }
      if (options.itemId) {
        state.highlightItemId = String(options.itemId);
      }

      state.loading = true;
      state.error = null;
      if (!state.data) {
        render({ preserveSearch: true });
      }

      try {
        const [codexRes, actionsRes, crosslinksRes] = await Promise.all([
          fetchJson('/api/codex?section=all'),
          fetchJson('/api/actions').catch(() => ({ ok: true, actions: [] })),
          fetchCodexCrosslinksSilent(),
        ]);
        if (seq !== state.loadSeq) return codexRes;

        state.data = codexRes;
        state.crosslinks = Array.isArray(crosslinksRes) ? crosslinksRes : [];
        syncAllItemsCache();
        state.ownerActions = normalizeOwnerActions(actionsRes && actionsRes.actions);
        state.loading = false;
        state.error = null;

        if (state.highlightItemId && !options.section) {
          const found = findItemById(state.highlightItemId);
          if (found && SECTION_MAP[found.section]) {
            state.activeSection = found.section;
            if (state.viewMode === 'map') {
              state.viewMode = 'grid';
            }
          }
        }

        updateHostNavCount();
        render({ animate: true });
        return codexRes;
      } catch (err) {
        if (seq !== state.loadSeq) return null;
        state.loading = false;
        state.error = stripEmDash((err && err.message) || 'Failed to fetch Mind Codex');
        render({ preserveSearch: true });
        notify(state.error, 'error');
        return null;
      }
    }

    async function handlePinToggle(id) {
      const item = findItemById(id);
      if (!item) return;
      const nextPinned = !item.pinned;
      item.pinned = nextPinned;
      render({ preserveSearch: true });
      try {
        const res = await fetchJson('/api/codex/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, pinned: nextPinned }),
        });
        if (res && res.item) replaceItemInState(res.item);
        if (res && res.stats && state.data) state.data.stats = res.stats;
        updateHostNavCount();
        render({ preserveSearch: true });
        notify(nextPinned ? `Pinned "${item.title}"` : `Unpinned "${item.title}"`, 'success');
      } catch (err) {
        item.pinned = !nextPinned;
        render({ preserveSearch: true });
        notify(`Pin update failed: ${err.message}`, 'error');
      }
    }

    async function handleAdvanceStage(id) {
      const item = findItemById(id);
      if (!item) return;
      const current = item.stage || 'spark';
      const nextStage = NEXT_STAGE_MAP[current];
      if (!nextStage) {
        notify(`"${item.title}" is already Shipped.`, 'info');
        return;
      }
      const prevStage = item.stage;
      item.stage = nextStage;
      if (state.data && state.data.stages) {
        if (prevStage && state.data.stages[prevStage] > 0) state.data.stages[prevStage] -= 1;
        state.data.stages[nextStage] = (state.data.stages[nextStage] || 0) + 1;
      }
      syncAllItemsCache();
      playSound('advance');
      render({ preserveSearch: true });

      try {
        const res = await fetchJson('/api/codex/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, stage: nextStage }),
        });
        if (res && res.item) replaceItemInState(res.item);
        if (res && res.stats && state.data) state.data.stats = res.stats;
        render({ preserveSearch: true });
        notify(`Moved "${item.title}" to ${STAGE_LABEL[nextStage]}.`, 'success');
      } catch (err) {
        item.stage = prevStage;
        await load();
        notify(`Stage advance failed: ${err.message}`, 'error');
      }
    }

    async function handlePromoteToAction(id) {
      const item = findItemById(id);
      if (!item) return;
      try {
        const res = await fetchJson('/api/codex/promote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: item.id,
            title: item.next_move || `Act on: ${item.title}`,
            detail: item.summary || item.thesis || '',
            createNote: false,
          }),
        });
        playSound('advance');
        notify(`Promoted "${item.title}" to Today Actions.`, 'success');
        // Refresh actions list so Action Plane reflects immediately
        const actionsRes = await fetchJson('/api/actions').catch(() => null);
        if (actionsRes && Array.isArray(actionsRes.actions)) {
          state.ownerActions = normalizeOwnerActions(actionsRes.actions);
        }
        if (res && res.item) replaceItemInState(res.item);
        render({ preserveSearch: true });
      } catch (err) {
        notify(`Promote failed: ${err.message}`, 'error');
      }
    }

    async function handleSynthesize(id, mode) {
      const item = findItemById(id);
      if (!item || state.aiBusyMap[id]) return;
      const safeMode = (mode === 'sharpen' || mode === 'next_moves' || mode === 'challenge') ? mode : 'sharpen';

      state.aiBusyMap[id] = safeMode;
      state.aiCollapsedMap[id] = false;
      render({ preserveSearch: true });

      try {
        const res = await fetchJson('/api/codex/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, mode: safeMode }),
        });
        delete state.aiBusyMap[id];

        const briefMd = stripEmDash((res && (res.brief_md || (res.item && res.item.ai_brief))) || '');
        const engine = stripEmDash((res && (res.engine || (res.item && res.item.ai_engine))) || 'Dual-Engine AI');
        const latencyMs = res && Number(res.latency_ms);
        const updatedAt = (res && res.item && res.item.ai_updated_at) || new Date().toISOString();

        state.aiTransientMap[id] = {
          brief_md: briefMd,
          engine,
          latency_ms: Number.isFinite(latencyMs) ? latencyMs : undefined,
          updated_at: updatedAt,
        };
        if (res && res.item) {
          replaceItemInState(res.item);
        } else if (briefMd) {
          item.ai_brief = briefMd;
          item.ai_engine = engine;
          item.ai_updated_at = updatedAt;
          syncAllItemsCache();
        }
        playSound('chime');
        render({ preserveSearch: true });
        notify(`Synthesis ready via ${engine}.`, 'success');
      } catch (err) {
        delete state.aiBusyMap[id];
        render({ preserveSearch: true });
        notify(`AI synthesis failed: ${err.message}`, 'error');
      }
    }

    async function handleSaveModal(formEl) {
      if (state.modalSaving) return;
      const fd = new FormData(formEl);
      const title = stripEmDash(String(fd.get('title') || '')).trim();
      if (!title) {
        notify('Title is required.', 'error');
        return;
      }

      const section = String(fd.get('section') || 'ideas');
      const tagsRaw = String(fd.get('tags') || '');
      const peopleRaw = String(fd.get('linked_people') || '');

      const payload = {
        section,
        title,
        subtitle: stripEmDash(String(fd.get('subtitle') || '')).trim(),
        summary: stripEmDash(String(fd.get('summary') || '')).trim(),
        thesis: stripEmDash(String(fd.get('thesis') || '')).trim(),
        anti_pattern: stripEmDash(String(fd.get('anti_pattern') || '')).trim(),
        next_move: stripEmDash(String(fd.get('next_move') || '')).trim(),
        domain: stripEmDash(String(fd.get('domain') || '')).trim() || 'Personal',
        conviction: String(fd.get('conviction') || 'active'),
        leverage_score: clampNum(fd.get('leverage_score'), 0, 100, 80),
        pinned: fd.get('pinned') === 'on',
        tags: tagsRaw.split(',').map((s) => s.trim()).filter(Boolean),
        linked_people: peopleRaw.split(',').map((s) => s.trim()).filter(Boolean),
      };

      const id = String(fd.get('id') || '').trim();
      if (id) payload.id = id;
      if (section === 'ideas') {
        payload.stage = String(fd.get('stage') || 'spark');
      }

      state.modalSaving = true;
      render({ preserveSearch: true });

      try {
        const res = await fetchJson('/api/codex/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.modalOpen = false;
        state.modalEditingId = null;
        state.modalSaving = false;

        if (SECTION_MAP[section]) {
          state.activeSection = section;
        }
        await load({ section: state.activeSection });
        notify(id ? `Updated "${title}".` : `Captured "${title}" to Mind Codex.`, 'success');
        return res;
      } catch (err) {
        state.modalSaving = false;
        render({ preserveSearch: true });
        notify(`Save failed: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleDeleteItem(id) {
      if (!id) return;
      try {
        try {
          await fetchJson(`/api/codex/item?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (delErr) {
          // Fallback to POST { action: "delete", id } if DELETE not supported
          await fetchJson('/api/codex/item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id }),
          });
        }
        state.modalOpen = false;
        state.modalEditingId = null;
        await load({ section: state.activeSection });
        notify('Removed entry from Mind Codex.', 'info');
      } catch (err) {
        notify(`Delete failed: ${err.message}`, 'error');
      }
    }

    async function handleQuickActionAdd(formEl) {
      if (state.quickActionBusy) return;
      const input = formEl.querySelector('input[name="title"]');
      const tagSel = formEl.querySelector('select[name="tag"]');
      const title = stripEmDash(input ? input.value : '').trim();
      if (!title) return;
      const tag = tagSel ? tagSel.value : 'Work';

      state.quickActionBusy = true;
      render({ preserveSearch: true });
      try {
        const res = await fetchJson('/api/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            op: 'add',
            action: 'add',
            title,
            tag,
            source: 'Mind Codex',
          }),
        });
        state.quickActionBusy = false;
        if (res && Array.isArray(res.actions)) {
          state.ownerActions = normalizeOwnerActions(res.actions);
        } else {
          const fresh = await fetchJson('/api/actions').catch(() => null);
          if (fresh && Array.isArray(fresh.actions)) {
            state.ownerActions = normalizeOwnerActions(fresh.actions);
          }
        }
        render({ preserveSearch: true });
        const freshInput = state.container && state.container.querySelector('[data-codex-quick-action-form] input[name="title"]');
        if (freshInput) freshInput.focus();
        notify(`Added action "${title}".`, 'success');
      } catch (err) {
        state.quickActionBusy = false;
        render({ preserveSearch: true });
        notify(`Could not add action: ${err.message}`, 'error');
      }
    }

    async function handleToggleOwnerAction(id) {
      const target = state.ownerActions.find((a) => a.id === id);
      if (!target) return;
      const prev = target.done;
      target.done = !prev;
      render({ preserveSearch: true });
      try {
        const res = await fetchJson('/api/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'toggle', action: 'toggle', id }),
        });
        if (res && Array.isArray(res.actions)) {
          state.ownerActions = normalizeOwnerActions(res.actions);
        }
        render({ preserveSearch: true });
      } catch (err) {
        target.done = prev;
        render({ preserveSearch: true });
        notify(`Action toggle failed: ${err.message}`, 'error');
      }
    }

    async function handleDeleteOwnerAction(id) {
      const prevList = state.ownerActions.slice();
      state.ownerActions = state.ownerActions.filter((a) => a.id !== id);
      render({ preserveSearch: true });
      try {
        const res = await fetchJson('/api/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'delete', action: 'delete', id }),
        });
        if (res && Array.isArray(res.actions)) {
          state.ownerActions = normalizeOwnerActions(res.actions);
        }
        render({ preserveSearch: true });
        notify('Deleted action.', 'info');
      } catch (err) {
        state.ownerActions = prevList;
        render({ preserveSearch: true });
        notify(`Delete failed: ${err.message}`, 'error');
      }
    }

    function handleSendToBoard(id) {
      const item = findItemById(id);
      if (!item) return;
      const defaultChannel = item.section === 'actions' ? 'kizuki/decisions' : 'box/work';
      const defaultAgent = item.section === 'ideas' ? 'claude' : 'codex';
      const defaultText = [
        stripEmDash(item.title || '').trim(),
        stripEmDash(item.summary || item.thesis || item.next_move || '').trim(),
      ].filter(Boolean).join('\n\n');
      const widgets = getBoardWidgets();
      playSound('click');
      if (widgets && typeof widgets.openBoardDispatchModal === 'function') {
        widgets.openBoardDispatchModal(
          {
            sourceKind: 'codex',
            sourceId: item.id,
            sourceLabel: item.title,
            defaultChannel,
            defaultAgent,
            defaultText,
          },
          {
            openBoard: state.hooks && state.hooks.openBoard,
            showToast: state.hooks && state.hooks.showToast,
          }
        );
        return;
      }
      if (state.hooks && typeof state.hooks.openBoard === 'function') {
        state.hooks.openBoard({ channel: 'box/work' });
      }
    }

    function bindEvents(container) {
      container.addEventListener('click', (ev) => {
        const target = ev.target && ev.target.closest ? ev.target : null;
        if (!target) return;

        // Close modal on backdrop click or close button
        if (target.hasAttribute('data-codex-modal-backdrop')) {
          closeCaptureModal();
          return;
        }
        if (target.closest('[data-codex-close-modal]')) {
          closeCaptureModal();
          return;
        }

        const sectionBtn = target.closest('[data-codex-section]');
        if (sectionBtn) {
          const nextSec = sectionBtn.getAttribute('data-codex-section');
          if (nextSec && (SECTION_MAP[nextSec] || nextSec === 'all')) {
            state.activeSection = nextSec;
            state.filterDomain = 'all';
            state.filterStage = 'all';
            state.filterConviction = 'all';
            state.filterPinnedOnly = false;
            playSound('click');
            if (state.viewMode === 'map' && constellationCtrl && typeof constellationCtrl.setFilter === 'function' && nextSec !== 'actions') {
              // Smooth semantic camera filter glide without tearing down the constellation
              const railEl = state.container.querySelector('[data-codex-rail]');
              const titleEl = state.container.querySelector('[data-codex-title]');
              const subtitleEl = state.container.querySelector('[data-codex-subtitle]');
              const meta = getSectionMeta(nextSec);
              if (railEl) railEl.innerHTML = renderRailHtml();
              if (titleEl) titleEl.textContent = meta.label;
              if (subtitleEl) subtitleEl.textContent = meta.description;
              constellationCtrl.setFilter(nextSec === 'all' ? 'all' : nextSec);
              return;
            }
            if (state.viewMode !== 'map') {
              state.viewMode = nextSec === 'ideas' ? state.ideasViewMode : 'grid';
            } else if (nextSec === 'actions') {
              state.viewMode = 'grid';
            }
            render({ animate: true });
          }
          return;
        }

        const tasteLinkBtn = target.closest('[data-codex-open-taste]');
        if (tasteLinkBtn) {
          openTasteCrosslink(tasteLinkBtn.getAttribute('data-codex-open-taste') || 'all');
          return;
        }

        if (target.closest('[data-codex-open-capture]')) {
          openCaptureModal(null);
          return;
        }

        if (target.closest('[data-codex-refresh]')) {
          load({ section: state.activeSection });
          return;
        }

        const viewBtn = target.closest('[data-codex-view], [data-codex-ideas-view]');
        if (viewBtn) {
          const mode = viewBtn.getAttribute('data-codex-view') || viewBtn.getAttribute('data-codex-ideas-view');
          if (mode === 'grid' || mode === 'pipeline' || mode === 'map') {
            setViewMode(mode);
          }
          return;
        }

        if (target.closest('[data-codex-reset-filters]')) {
          state.filterDomain = 'all';
          state.filterStage = 'all';
          state.filterConviction = 'all';
          state.filterPinnedOnly = false;
          state.searchQuery = '';
          render();
          return;
        }

        if (target.closest('[data-codex-toggle-pinned]')) {
          state.filterPinnedOnly = !state.filterPinnedOnly;
          render({ preserveSearch: true });
          return;
        }

        const convBtn = target.closest('[data-codex-conviction-filter]');
        if (convBtn) {
          const val = convBtn.getAttribute('data-codex-conviction-filter');
          state.filterConviction = state.filterConviction === val ? 'all' : val;
          render({ preserveSearch: true });
          return;
        }

        const stageBtn = target.closest('[data-codex-stage-filter]');
        if (stageBtn) {
          const val = stageBtn.getAttribute('data-codex-stage-filter');
          state.filterStage = state.filterStage === val ? 'all' : val;
          render({ preserveSearch: true });
          return;
        }

        const domBtn = target.closest('[data-codex-domain-filter]');
        if (domBtn) {
          const val = domBtn.getAttribute('data-codex-domain-filter');
          state.filterDomain = state.filterDomain.toLowerCase() === String(val || '').toLowerCase() ? 'all' : val;
          render({ preserveSearch: true });
          return;
        }

        const bmDomBtn = target.closest('[data-codex-bm-domain]');
        if (bmDomBtn) {
          state.bookmarkDomainFilter = bmDomBtn.getAttribute('data-codex-bm-domain') || 'all';
          render({ preserveSearch: true });
          return;
        }

        const actFilterBtn = target.closest('[data-codex-action-filter]');
        if (actFilterBtn) {
          state.actionFilter = actFilterBtn.getAttribute('data-codex-action-filter') || 'open';
          render({ preserveSearch: true });
          return;
        }

        const personBtn = target.closest('[data-codex-open-person]');
        if (personBtn) {
          const name = personBtn.getAttribute('data-codex-open-person');
          if (name && state.hooks && typeof state.hooks.openPerson === 'function') {
            state.hooks.openPerson(name);
          }
          return;
        }

        const docBtn = target.closest('[data-codex-open-doc]');
        if (docBtn) {
          const docPath = docBtn.getAttribute('data-codex-open-doc');
          if (docPath && state.hooks && typeof state.hooks.openDoc === 'function') {
            state.hooks.openDoc(docPath);
          }
          return;
        }

        const replayBtn = target.closest('[data-codex-open-replay]');
        if (replayBtn) {
          const day = replayBtn.getAttribute('data-codex-open-replay');
          if (day && state.hooks && typeof state.hooks.openReplayDay === 'function') {
            state.hooks.openReplayDay(day);
          }
          return;
        }

        const pinBtn = target.closest('[data-codex-pin]');
        if (pinBtn) {
          handlePinToggle(pinBtn.getAttribute('data-codex-pin'));
          return;
        }

        const advBtn = target.closest('[data-codex-advance-stage]');
        if (advBtn) {
          handleAdvanceStage(advBtn.getAttribute('data-codex-advance-stage'));
          return;
        }

        const promoteBtn = target.closest('[data-codex-promote]');
        if (promoteBtn) {
          handlePromoteToAction(promoteBtn.getAttribute('data-codex-promote'));
          return;
        }

        const sendBoardBtn = target.closest('[data-codex-send-board]');
        if (sendBoardBtn) {
          handleSendToBoard(sendBoardBtn.getAttribute('data-codex-send-board'));
          return;
        }

        const boardOriginBtn = target.closest('[data-codex-open-board-thread]');
        if (boardOriginBtn) {
          const threadId = String(boardOriginBtn.getAttribute('data-codex-open-board-thread') || '').trim();
          const channel = String(boardOriginBtn.getAttribute('data-codex-open-board-channel') || '').trim() || 'box/work';
          playSound('click');
          if (state.hooks && typeof state.hooks.openBoard === 'function') {
            const navOpts = { channel };
            if (threadId) {
              navOpts.threadId = threadId;
              navOpts.stage = 'thread';
            }
            state.hooks.openBoard(navOpts);
          }
          return;
        }

        const synthBtn = target.closest('[data-codex-synth]');
        if (synthBtn) {
          handleSynthesize(
            synthBtn.getAttribute('data-codex-synth'),
            synthBtn.getAttribute('data-synth-mode') || 'sharpen'
          );
          return;
        }

        const toggleAiBtn = target.closest('[data-codex-toggle-ai]');
        if (toggleAiBtn) {
          const id = toggleAiBtn.getAttribute('data-codex-toggle-ai');
          state.aiCollapsedMap[id] = !state.aiCollapsedMap[id];
          render({ preserveSearch: true });
          return;
        }

        const editBtn = target.closest('[data-codex-edit]');
        if (editBtn) {
          openCaptureModal(editBtn.getAttribute('data-codex-edit'));
          return;
        }

        const delItemBtn = target.closest('[data-codex-delete-item]');
        if (delItemBtn) {
          handleDeleteItem(delItemBtn.getAttribute('data-codex-delete-item'));
          return;
        }

        const delActBtn = target.closest('[data-codex-delete-action]');
        if (delActBtn) {
          handleDeleteOwnerAction(delActBtn.getAttribute('data-codex-delete-action'));
          return;
        }
      });

      container.addEventListener('change', (ev) => {
        const chk = ev.target && ev.target.closest ? ev.target.closest('[data-codex-toggle-action]') : null;
        if (chk) {
          handleToggleOwnerAction(chk.getAttribute('data-codex-toggle-action'));
        }
      });

      container.addEventListener('input', (ev) => {
        const search = ev.target && ev.target.closest ? ev.target.closest('[data-codex-search]') : null;
        if (search) {
          state.searchQuery = search.value || '';
          render({ preserveSearch: true });
        }
      });

      container.addEventListener('submit', (ev) => {
        const captureForm = ev.target && ev.target.closest ? ev.target.closest('[data-codex-capture-form]') : null;
        if (captureForm) {
          ev.preventDefault();
          handleSaveModal(captureForm);
          return;
        }
        const quickForm = ev.target && ev.target.closest ? ev.target.closest('[data-codex-quick-action-form]') : null;
        if (quickForm) {
          ev.preventDefault();
          handleQuickActionAdd(quickForm);
        }
      });

      if (typeof document !== 'undefined') {
        if (boundKeydown) {
          document.removeEventListener('keydown', boundKeydown);
        }
        boundKeydown = (ev) => {
          if (ev.key === 'Escape' && state.modalOpen) {
            closeCaptureModal();
          }
        };
        document.addEventListener('keydown', boundKeydown);
      }
    }

    function setViewMode(mode) {
      if (mode !== 'grid' && mode !== 'pipeline' && mode !== 'map') return;
      const nextMode = (mode === 'pipeline' && state.activeSection !== 'ideas') ? 'grid' : mode;
      if (state.activeSection === 'ideas' && (nextMode === 'grid' || nextMode === 'pipeline')) {
        state.ideasViewMode = nextMode;
      }
      const changed = state.viewMode !== nextMode;
      state.viewMode = nextMode;
      if (changed) {
        playSound('click');
      }
      render({ preserveSearch: true, animate: true });
    }

    function destroy() {
      destroyConstellation();
      if (typeof document !== 'undefined' && boundKeydown) {
        document.removeEventListener('keydown', boundKeydown);
        boundKeydown = null;
      }
      state.mounted = false;
    }

    function mount(containerEl, hostHooks) {
      if (!containerEl) return;
      const isNewContainer = state.container !== containerEl;
      if (isNewContainer) {
        destroyConstellation();
      }
      state.container = containerEl;
      state.hooks = hostHooks && typeof hostHooks === 'object' ? hostHooks : {};
      state.mounted = true;
      if (isNewContainer) {
        state.shellRendered = false;
        bindEvents(containerEl);
      }
      render();
    }

    function getState() {
      return {
        mounted: state.mounted,
        activeSection: state.activeSection,
        viewMode: state.viewMode,
        ideasViewMode: state.ideasViewMode,
        searchQuery: state.searchQuery,
        itemCount: getAllCodexItems().length,
        allItemsCount: Array.isArray(state.allItems) ? state.allItems.length : 0,
        ownerActionCount: state.ownerActions.length,
        modalOpen: state.modalOpen,
        hasConstellation: Boolean(constellationCtrl),
      };
    }

    return {
      mount,
      load,
      getState,
      setViewMode,
      destroy,
      openCaptureModal,
      closeCaptureModal,
    };
  }

  return createCodexController();
});
