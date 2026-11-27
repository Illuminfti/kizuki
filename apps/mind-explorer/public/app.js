/* Kizuki Mind OS - Personal Mind OS Shell & Multi-View Controller */
/* Consumes live Kizuki Mind Explorer APIs with defensive null-safe normalization */

(function initKizukiMindOS() {
  'use strict';

  // S0-c: Disjoint UI slot registry for extension modules (today-radar, people-radar, person-prep, cmdk)
  if (!window.KizukiSlots) {
    const slotHandlers = new Map();
    const slotTargets = new Map();
    window.KizukiSlots = {
      register(name, fn) {
        if (!name || typeof fn !== 'function') return;
        slotHandlers.set(name, fn);
        const existing = slotTargets.get(name);
        if (existing && existing.root && existing.root.isConnected) {
          try { fn(existing.root, existing.ctx || {}); } catch (err) { console.warn('[KizukiSlots]', name, err); }
        }
      },
      mount(name, root, ctx) {
        if (!name || !root) return;
        slotTargets.set(name, { root, ctx: ctx || {} });
        const fn = slotHandlers.get(name);
        if (typeof fn === 'function') {
          try { fn(root, ctx || {}); } catch (err) { console.warn('[KizukiSlots]', name, err); }
        }
      },
      has(name) { return slotHandlers.has(name); },
      remountAll() {
        slotTargets.forEach((entry, name) => {
          const fn = slotHandlers.get(name);
          if (typeof fn === 'function' && entry.root && entry.root.isConnected) {
            try { fn(entry.root, entry.ctx || {}); } catch (err) { console.warn('[KizukiSlots]', name, err); }
          }
        });
      },
    };
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const VALID_VIEWS = new Set(['today', 'people', 'replay', 'codex', 'taste', 'board', 'vault', 'graph', 'stream', 'atlas', 'memt']);
  const CHAT_STORAGE_KEY = 'kizuki-mind-chat-v2';
  const THEME_STORAGE_KEY = 'kizuki-theme';
  const MAX_CHAT_TURNS = 40;

  const CANONICAL_VAULT_CATS = [
    { key: 'all', label: 'All' },
    { key: 'obsidian', label: 'Obsidian' },
    { key: 'apple-notes', label: 'Apple Notes' },
    { key: 'wispr-flow', label: 'Wispr Meetings' },
    { key: 'dashboards', label: 'Dashboards' },
    { key: 'owner', label: 'Owner' },
    { key: 'world', label: 'World' },
    { key: 'entities', label: 'Entities' },
    { key: 'facts', label: 'Facts' },
    { key: 'notes', label: 'Notes' },
    { key: 'claude', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
    { key: 'sources', label: 'Sources' },
    { key: 'archive', label: 'Archive' },
  ];

  const CHANNEL_META = {
    whatsapp: { short: 'WA', label: 'WhatsApp', dot: 'ch-wa' },
    imessage: { short: 'iMsg', label: 'iMessage', dot: 'ch-imsg' },
    gmail: { short: 'Gmail', label: 'Gmail', dot: 'ch-gmail' },
    telegram: { short: 'TG', label: 'Telegram', dot: 'ch-tg' },
    calendar: { short: 'Cal', label: 'Calendar', dot: 'ch-cal' },
  };

  const CHAT_MODE_CONFIG = {
    ask: {
      label: 'Ask Mind',
      submit: 'Ask',
      placeholder: 'Ask your mind anything across calendar, inbox, Obsidian, Apple Notes, and Kizuki...',
      badgeClass: 'badge-amber',
    },
    tell: {
      label: 'Tell / Anchor',
      submit: 'Anchor',
      placeholder: 'Anchor a fact, decision, or operating rule into your vault...',
      badgeClass: 'badge-cobalt',
    },
    memt: {
      label: 'Save Recipe',
      submit: 'Save Recipe',
      placeholder: 'Write the verified recommendation to store in MemT...',
      badgeClass: 'badge-teal',
    },
    reflex: {
      label: 'Reflex Check',
      submit: 'Check',
      placeholder: 'Check a plan, decision, or commitment for blind spots...',
      badgeClass: 'badge-rose',
    },
  };

  // =========================================================================
  // APPLICATION STATE
  // =========================================================================
  const state = {
    view: 'today',
    theme: 'dark',
    detailOn: true,
    sidebarOpen: false,
    dirCollapsed: false,
    vaultSidebarOpen: false,

    // Pulse / Telemetry
    pulse: null,
    overview: null,

    // View 1: Today 3-Pane Master-Detail
    today: null,
    todayNextMoves: null,
    todayLoaded: false,
    todayTab: 'priority', // priority | actions | schedule | all
    todayChannel: 'all', // all | whatsapp | imessage | gmail | telegram
    includeNoise: false,
    todayRows: [], // flattened visible selectable triage rows
    todayBaselineCount: null,
    selectedTodayId: 'morning-brief',
    todayMobileDetailOpen: false,
    mobileComposerExpanded: false,
    peopleCountPrefetched: false,
    meetingBriefCache: new Map(), // meetingId -> { md, engine, latency_ms }
    inboxDraftCache: new Map(), // inboxId -> { md, engine, latency_ms }
    composerMode: 'draft', // draft | action | ask
    composerBusy: false,
    lastDraftMd: '',
    lastDraftMeta: null,
    tickerTargetMeetingId: null,

    // View 2: People Cross-Channel Dossiers & World-Model Intelligence
    peopleLoaded: false,
    peopleTotal: 0,
    peopleItems: [],
    peopleQuery: '',
    peopleChannel: 'all',
    peopleSearchTimer: null,
    selectedPersonKey: null,
    selectedDossier: null,
    peopleMobileDetailOpen: false,
    peopleAiOutput: null, // { kind, md, engine, latency_ms }
    peopleDossierTab: 'overview', // overview | leverage | history | network | card
    peopleHistoryFilter: 'all', // all | whatsapp | telegram | imessage | gmail | claims
    peopleHistoryQuery: '',
    peopleHistorySearchTimer: null,
    peopleHistoryLoadingMore: false,
    peopleNoteOpen: false,
    peopleNoteKind: 'insight',
    peopleNoteBusy: false,
    peopleSynthesizingKey: null,
    peopleFetchSeq: 0,
    peopleFetchAbort: null,

    // View 3: Life Replay (Time Machine + Private Offline Map)
    replayLoaded: false,
    replayLoading: false,
    replayYear: null,
    replayIndex: null,
    replayIndexCache: new Map(), // year -> ReplayIndexResponse
    replayDayCache: new Map(), // day -> ReplayDayResponse
    replayFilter: '',
    replaySelectedDay: null,
    replayDay: null,
    replayDayLoading: false,
    replaySubTab: 'timeline', // timeline | places | work | people
    replayMapRegion: 'day', // day | uk | europe | world
    replayFocusedPlaceKey: null,
    replayStoryBusy: false,
    replayStoryMeta: null, // { engine, cached, latency_ms }
    replayMobileDetailOpen: false,
    replayImportOpen: false,
    replayImportBusy: false,
    replayTotalActiveDays: null,
    replayPrefetched: false,

    // View 4, 5 & 6: Mind Codex, Taste Studio & Agent Board
    codexMounted: false,
    codexTotal: null,
    tasteMounted: false,
    tasteNavLabel: null,
    boardMounted: false,
    boardChannel: null,
    boardThreadId: null,
    boardStage: null,

    // View 6: Vault Explorer
    vaultCategory: 'all',
    vaultQuery: '',
    vaultSort: 'recent',
    vaultOffset: 0,
    vaultLimit: 60,
    vaultTotal: 0,
    vaultHasMore: false,
    vaultDocs: [],
    vaultCategories: {},
    vaultLoaded: false,
    vaultSearchTimer: null,
    activeDocPath: null,
    activeDoc: null,
    docRawMode: false,
    docEditMode: false,
    docIsNewNote: false,

    // View 4: Mind Graph Workspace
    graphInitialized: false,
    graphLoading: false,
    graphData: { nodes: [], edges: [], stats: {} },
    graphFilterKind: 'all',
    graphSearch: '',
    dirTab: 'world',
    dirSearch: '',
    breadcrumbs: [],
    selectedNodeId: null,
    selectedNodeDetail: null,

    // View 5: Event Stream
    streamEvents: [],
    streamConnectors: [],
    streamConnector: 'all',
    streamQuery: '',
    streamOffset: 0,
    streamLimit: 40,
    streamTotal: 0,
    streamHasMore: false,
    streamLoaded: false,
    streamSearchTimer: null,
    expandedEventIds: new Set(),

    // View 6: World Atlas
    atlasData: null,
    atlasTab: 'all',

    // View 7: MemT Library
    memtData: null,
    memtDomain: 'all',
    memtSearch: '',

    // Multi-Turn Mind Chat Modal
    chatOpen: false,
    chatMode: 'ask',
    chatContext: null, // { type, id?, path?, key?, label, title? }
    chatBusy: false,
    chatMessages: [],

    // Omni-Search Command Palette
    cmdkOpen: false,
    cmdkItems: [],
    cmdkIndex: 0,
    cmdkSearchTimer: null,
  };

  let graph = null;
  let replayMap = null;
  let replayScrubberCtrl = null;

  // =========================================================================
  // FORMATTING, SANITIZATION & MARKDOWN BRIDGE
  // =========================================================================
  function escHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripEmDash(str) {
    return String(str || '').replace(/\u2014/g, ' - ');
  }

  function iconSvg(name, opts) {
    const lib = window.KizukiIcons;
    if (!lib || typeof lib.svg !== 'function') return '';
    try {
      return lib.svg(name, opts || { size: 12 });
    } catch (_) {
      return '';
    }
  }

  function vaultCatIconName(catKey) {
    const k = String(catKey || '').toLowerCase();
    if (k === 'all') return 'layers';
    if (k === 'obsidian') return 'obsidian';
    if (k === 'apple-notes' || k === 'notes') return 'apple_notes';
    if (k === 'wispr-flow' || k === 'wispr') return 'wispr';
    if (k === 'dashboards') return 'today';
    if (k === 'owner') return 'pin';
    if (k === 'world') return 'atlas';
    if (k === 'entities') return 'people';
    if (k === 'facts') return 'check';
    if (k === 'claude') return 'claude';
    if (k === 'codex') return 'codex';
    if (k === 'sources') return 'stream';
    if (k === 'archive') return 'vault';
    return 'book';
  }

  function streamConnectorIconName(connId) {
    const s = String(connId || '').toLowerCase();
    if (s.includes('wispr')) return 'wispr';
    if (s.includes('whatsapp') || s === 'wa') return 'whatsapp';
    if (s.includes('telegram') || s === 'tg') return 'telegram';
    if (s.includes('imessage') || s === 'imsg') return 'imessage';
    if (s.includes('gmail') || s.includes('mail')) return 'gmail';
    if (s.includes('cal')) return 'calendar';
    if (s.includes('whoop')) return 'whoop';
    if (s.includes('claude')) return 'claude';
    if (s.includes('codex')) return 'codex_agent';
    if (s.includes('obsidian')) return 'obsidian';
    if (s.includes('apple-notes') || s.includes('notes')) return 'apple_notes';
    if (s.includes('photo')) return 'camera';
    if (s.includes('github') || s.includes('git')) return 'github';
    if (s.includes('x_') || s.includes('twitter') || s.includes('bookmark')) return 'x_social';
    if (s.includes('map') || s.includes('location') || s.includes('gps')) return 'map_pin';
    if (s.includes('wiki')) return 'book';
    if (s.includes('markdown') || s.includes('vault')) return 'layers';
    if (s.includes('antigravity') || s.includes('neon')) return 'sparkle_ai';
    if (s.includes('legacy-events') || s.includes('event')) return 'stream';
    return 'stream';
  }

  function atlasPanelIconName(panelKey) {
    const k = String(panelKey || '').toLowerCase();
    if (k === 'resume') return 'today';
    if (k === 'changed') return 'stream';
    if (k === 'stale') return 'clock';
    if (k === 'commitments') return 'action_plane';
    if (k === 'questions') return 'sparkle_ai';
    if (k === 'people') return 'people';
    return 'atlas';
  }

  function normalizeChannel(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (s.includes('whatsapp') || s === 'wa') return 'whatsapp';
    if (s.includes('imessage') || s === 'imsg' || s === 'sms' || s.includes('messages')) return 'imessage';
    if (s.includes('gmail') || s.includes('mail') || s === 'email') return 'gmail';
    if (s.includes('telegram') || s === 'tg') return 'telegram';
    if (s.includes('cal')) return 'calendar';
    return s || 'inbox';
  }

  function channelInfo(raw) {
    const key = normalizeChannel(raw);
    return CHANNEL_META[key] || { short: key.slice(0, 5).toUpperCase() || 'MSG', label: raw || 'Message', dot: 'ch-other' };
  }

  function formatCompact(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '--';
    if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (Math.abs(num) >= 10000) return (num / 1000).toFixed(1) + 'K';
    if (Math.abs(num) >= 1000) return num.toLocaleString('en-US');
    return String(Math.round(num));
  }

  function formatCatCount(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '';
    if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(num));
  }

  function formatBytes(b) {
    const num = Number(b);
    if (!Number.isFinite(num) || num <= 0) return '';
    if (num >= 1048576) return (num / 1048576).toFixed(1) + ' MB';
    if (num >= 1024) return (num / 1024).toFixed(1) + ' KB';
    return num + ' B';
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) {
      const aheadMin = Math.round(Math.abs(diffMs) / 60000);
      if (aheadMin < 60) return 'in ' + Math.max(1, aheadMin) + 'm';
      const aheadHr = Math.round(aheadMin / 60);
      if (aheadHr < 24) return 'in ' + aheadHr + 'h';
      return d.toISOString().slice(0, 10);
    }
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return diffDay + 'd ago';
    return d.toISOString().slice(0, 10);
  }

  function formatLatency(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num) || num < 0) return '';
    return (num / 1000).toFixed(1) + 's';
  }

  function formatHistoricalLastSeen(person) {
    if (!person || typeof person !== 'object') return 'No recent msg';
    if (person.last_seen_label && typeof person.last_seen_label === 'string') {
      const lbl = stripEmDash(person.last_seen_label).trim();
      if (lbl) {
        if (!/^20\d\d-\d\d-\d\d/.test(lbl)) return lbl;
        const parsedLbl = new Date(lbl);
        if (Number.isNaN(parsedLbl.getTime()) || parsedLbl.getTime() <= Date.now()) {
          return lbl;
        }
      }
    }
    const iso = person.last_seen_iso || person.last_seen || person.last_message_at || null;
    if (iso) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          return formatRelativeTime(iso);
        }
        return person.next_meeting ? 'Upcoming' : 'No recent msg';
      }
    }
    return person.next_meeting ? 'Upcoming' : 'No recent msg';
  }

  function formatNextMeetingPill(nextMeeting) {
    if (!nextMeeting) return '';
    if (typeof nextMeeting === 'string') {
      const clean = stripEmDash(nextMeeting).trim();
      if (!clean) return '';
      return (
        '<div class="person-next-meeting-pill">' +
        '<span class="ch-dot ch-cal" aria-hidden="true"></span>' +
        '<span>Next: ' + escHtml(clean) + '</span>' +
        '</div>'
      );
    }
    const title = stripEmDash(nextMeeting.title || nextMeeting.summary || 'Meeting').trim();
    const when = stripEmDash(
      nextMeeting.countdown ||
        nextMeeting.countdown_label ||
        nextMeeting.time_label ||
        formatRelativeTime(nextMeeting.start) ||
        ''
    ).trim();
    const suffix = when ? ' (' + when + ')' : '';
    return (
      '<div class="person-next-meeting-pill">' +
      '<span class="ch-dot ch-cal" aria-hidden="true"></span>' +
      '<span>Next: ' + escHtml(title + suffix) + '</span>' +
      '</div>'
    );
  }

  function extractMeetUrl(explicitUrl, fallbackText) {
    const candidates = [explicitUrl, fallbackText];
    for (const src of candidates) {
      const s = String(src || '');
      if (!s) continue;
      if (/^https?:\/\/\S+$/i.test(s.trim())) {
        return s.trim();
      }
      const m = s.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>)"']*)?/i);
      if (m) return m[0];
    }
    return '';
  }

  function normalizeHeadingText(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/\bkizuki\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function titlesSubstantiallyMatch(aStr, bStr) {
    const a = normalizeHeadingText(aStr);
    const b = normalizeHeadingText(bStr);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const ta = new Set(a.split(' ').filter(Boolean));
    const tb = new Set(b.split(' ').filter(Boolean));
    const smaller = Math.min(ta.size, tb.size);
    if (smaller === 0) return false;
    let overlap = 0;
    for (const tok of ta) {
      if (tb.has(tok)) overlap += 1;
    }
    return overlap / smaller >= 0.7;
  }

  function cleanMeetingBody(rawText, title) {
    let txt = stripEmDash(String(rawText || '')).replace(/\r\n/g, '\n');
    if (!txt.trim()) return '';

    // Strip Google Calendar boilerplate delimited by -::~:~:: markers
    txt = txt.replace(/-::~:~::[\s\S]*?(?:::-|\n\n|$)/g, '\n');
    txt = txt.replace(/^[-:~]{8,}$/gm, '');

    // Strip MIME part markers and raw HTML tags (e.g. <#part...>, <b>, <br>)
    txt = txt.replace(/<#\/?part[^>]*>/gi, '');
    txt = txt.replace(/<br\s*\/?>/gi, '\n');
    txt = txt.replace(/<\/?(?:b|strong|i|em|u|p|div|span|a|font|html|body|ul|ol|li)[^>]*>/gi, '');
    txt = txt.replace(/&nbsp;/gi, ' ');

    // Strip raw calendar dump metadata lines and Google Meet join footer lines
    const lines = txt.split('\n');
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        kept.push('');
        continue;
      }
      if (/^(?:Calendar|Start|End|When|Where|Location|Participants|Attendees|Organizer|Status|Meeting ID|Video call link)\s*:/i.test(trimmed)) {
        continue;
      }
      if (/^Join with Google Meet/i.test(trimmed) || /^Or dial:\s*/i.test(trimmed) || /^More phone numbers:/i.test(trimmed)) {
        continue;
      }
      if (/^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(trimmed)) {
        continue;
      }
      if (/^Please do not edit this section/i.test(trimmed)) {
        continue;
      }
      // Strip duplicate leading H1/H2 matching event title
      const headingMatch = trimmed.match(/^#{1,2}\s+(.+)$/);
      if (headingMatch && kept.every((k) => !k.trim()) && titlesSubstantiallyMatch(headingMatch[1], title)) {
        continue;
      }
      kept.push(line);
    }

    return kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function inferDocCategory(docObj, path) {
    if (docObj && typeof docObj === 'object' && docObj.category) {
      return String(docObj.category).toLowerCase();
    }
    const seg = String(path || '').split('/').filter(Boolean)[0] || '';
    if (seg && !seg.endsWith('.md')) return seg.toLowerCase();
    return 'vault';
  }

  function stripDuplicateLeadingH1(containerEl, headerTitle) {
    if (!containerEl || !headerTitle) return null;
    const firstEl = containerEl.firstElementChild;
    if (!firstEl || firstEl.tagName !== 'H1') return null;
    if (titlesSubstantiallyMatch(headerTitle, firstEl.textContent)) {
      const removed = { id: firstEl.id || '', text: firstEl.textContent.trim() };
      firstEl.remove();
      return removed;
    }
    return null;
  }

  function formatConfidence(val) {
    if (val === null || val === undefined || val === '') return '--';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val);
    const pct = num <= 1 ? Math.round(num * 100) : Math.round(num);
    return Math.max(0, Math.min(100, pct)) + '%';
  }

  function confidencePercent(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 75;
    const pct = num <= 1 ? num * 100 : num;
    return Math.max(4, Math.min(100, Math.round(pct)));
  }

  function initialsForName(name, fallbackKey) {
    const clean = String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .trim();
    const src =
      clean ||
      String(fallbackKey || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .trim();
    if (!src) return 'P';
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase() || 'P';
    return ((Array.from(parts[0])[0] || '') + (Array.from(parts[parts.length - 1])[0] || '')).toUpperCase() || 'P';
  }

  function safePersonInitials(person, fallbackName) {
    const raw = String((person && person.initials) || '').trim();
    if (raw && !raw.includes('?')) return raw.toUpperCase();
    return initialsForName((person && person.name) || fallbackName || '', (person && person.key) || '');
  }

  function badgeClassForKind(kind, consolidated) {
    const k = String(kind || '').toLowerCase();
    if (k.includes('stale') || k.includes('conflict') || k.includes('attention')) return 'badge-rose';
    if (k.includes('memt') || k.includes('recipe') || k.includes('experience')) return 'badge-teal';
    if (consolidated || k.includes('consolidated') || k.includes('world')) return 'badge-amber';
    if (k.includes('concept') || k.includes('situation')) return 'badge-cobalt';
    return '';
  }

  function renderRichInline(text) {
    const clean = stripEmDash(text === null || text === undefined ? '' : String(text));
    if (!clean) return '';
    if (window.KizukiPersonVisuals && typeof window.KizukiPersonVisuals.renderInlineMd === 'function') {
      try {
        return window.KizukiPersonVisuals.renderInlineMd(clean);
      } catch (_) {
        // fallback below
      }
    }
    let out = escHtml(clean);
    out = out.replace(/`([^`]+)`/g, '<code class="wm-inline-code">$1</code>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="wm-inline-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
    out = out.replace(/\*\*/g, '');
    return out;
  }

  function fallbackRenderMarkdown(mdText) {
    const raw = stripEmDash(String(mdText || '')).replace(/\r\n/g, '\n');
    if (!raw.trim()) return '<p class="empty-state">No content available.</p>';
    return raw
      .split('\n\n')
      .map((block) => '<p>' + renderRichInline(block.trim()).replace(/\n/g, '<br>') + '</p>')
      .join('\n');
  }

  function renderMarkdownHtml(mdText) {
    const clean = stripEmDash(mdText || '');
    if (!clean.trim()) return '<p class="empty-state">No content available.</p>';
    if (window.KizukiMarkdown && typeof window.KizukiMarkdown.render === 'function') {
      try {
        return window.KizukiMarkdown.render(clean);
      } catch (_) {
        // fallback below
      }
    }
    return fallbackRenderMarkdown(clean);
  }

  function renderMarkdownDocument(mdText) {
    const clean = stripEmDash(mdText || '');
    if (window.KizukiMarkdown && typeof window.KizukiMarkdown.renderDocument === 'function') {
      try {
        const res = window.KizukiMarkdown.renderDocument(clean);
        if (res && typeof res === 'object') {
          return {
            html: res.html || '<p class="empty-state">Empty document.</p>',
            frontmatter: res.frontmatter && typeof res.frontmatter === 'object' ? res.frontmatter : {},
            toc: Array.isArray(res.toc) ? res.toc : [],
          };
        }
      } catch (_) {
        // fallback below
      }
    }
    return {
      html: renderMarkdownHtml(clean),
      frontmatter: {},
      toc: [],
    };
  }

  function formatTimestampSlug(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      '-' +
      pad(date.getHours()) +
      pad(date.getMinutes())
    );
  }

  function titleFromPath(path) {
    const p = String(path || '');
    const base = p.split('/').pop() || p;
    return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';
  }

  function shortConnectorName(id) {
    const s = String(id || '').replace(/^kizuki\./, '');
    if (!s) return 'Vault';
    return s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function isMobileViewport() {
    return window.innerWidth <= 960;
  }

  // =========================================================================
  // TOAST NOTIFICATIONS & CLIPBOARD (P0-1: Keyed replacement, close button, auto-dismiss)
  // =========================================================================
  const activeToastsByKey = new Map();

  function dismissToastEl(el, key) {
    if (!el || !el.isConnected) return;
    if (key && activeToastsByKey.get(key) === el) {
      activeToastsByKey.delete(key);
    }
    el.style.opacity = '0';
    el.style.transition = 'opacity 160ms ease';
    setTimeout(() => {
      if (el.isConnected) el.remove();
    }, 180);
  }

  function clearTransientToasts() {
    const stack = $('#toast-stack');
    if (!stack) return;
    stack.querySelectorAll('.toast-item:not(.is-error)').forEach((el) => {
      const k = el.dataset.toastKey || '';
      if (k && activeToastsByKey.get(k) === el) activeToastsByKey.delete(k);
      el.remove();
    });
  }

  function showToast(message, tone = 'info', key = '') {
    const stack = $('#toast-stack');
    if (!stack) return;
    const toneClass =
      tone === 'error' ? 'is-error' : tone === 'success' ? 'is-success' : tone === 'warn' ? 'is-warn' : 'is-info';
    if (key && activeToastsByKey.has(key)) {
      const prev = activeToastsByKey.get(key);
      if (prev && prev._timer) clearTimeout(prev._timer);
      if (prev && prev.isConnected) prev.remove();
      activeToastsByKey.delete(key);
    }
    while (stack.children.length >= 2) {
      stack.firstElementChild.remove();
    }
    const el = document.createElement('div');
    el.className = 'toast-item ' + toneClass;
    if (key) el.dataset.toastKey = key;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = stripEmDash(message);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => {
      if (el._timer) clearTimeout(el._timer);
      dismissToastEl(el, key);
    });

    el.appendChild(msgSpan);
    el.appendChild(closeBtn);
    stack.appendChild(el);
    if (key) activeToastsByKey.set(key, el);

    const ttl = tone === 'error' ? 5000 : 3200;
    el._timer = setTimeout(() => dismissToastEl(el, key), ttl);
  }

  async function copyToClipboard(text, successMsg) {
    const payload = String(text || '');
    if (!payload.trim()) {
      showToast('Nothing to copy yet.', 'warn');
      return false;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (successMsg) showToast(successMsg, 'success');
      return true;
    } catch (_) {
      showToast('Clipboard copy blocked by browser.', 'error');
      return false;
    }
  }

  // =========================================================================
  // API CLIENT & URL STATE
  // =========================================================================
  async function apiGet(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (text ? ': ' + text.slice(0, 120) : ''));
    }
    return res.json();
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Kizuki-Request': '1',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid JSON response' }));
    if (!res.ok && data.ok !== false) {
      return { ok: false, error: data.error || 'HTTP ' + res.status };
    }
    return data;
  }

  function updateUrlParams(updates) {
    try {
      const url = new URL(window.location.href);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === undefined || v === '') {
          url.searchParams.delete(k);
        } else {
          url.searchParams.set(k, String(v));
        }
      }
      window.history.replaceState({}, '', url.toString());
    } catch (_) {
      // ignore restricted history
    }
  }

  // =========================================================================
  // THEME POLARITY, DETAIL MODE & MOBILE DRAWER
  // =========================================================================
  function initThemePreference() {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('theme');
    let saved = null;
    try {
      saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch (_) {
      // ignore
    }
    if (param === 'light' || param === 'dark') {
      state.theme = param;
    } else if (saved === 'light' || saved === 'dark') {
      state.theme = saved;
    } else {
      state.theme = 'dark';
    }
    applyTheme(false);
  }

  function applyTheme(updateUrl) {
    document.documentElement.setAttribute('data-theme', state.theme);
    const label = $('#theme-toggle-text');
    if (label) label.textContent = state.theme === 'dark' ? 'Light' : 'Dark';
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch (_) {
      // ignore
    }
    if (graph && typeof graph.refreshTheme === 'function') {
      graph.refreshTheme();
    }
    if (replayMap && typeof replayMap.refreshTheme === 'function') {
      replayMap.refreshTheme();
    }
    if (state.replayLoaded && state.replayIndex) {
      renderReplayHeatmap();
    }
    if (updateUrl) updateUrlParams({ theme: state.theme });
  }

  function initDetailPreference() {
    const params = new URLSearchParams(window.location.search);
    const param = String(params.get('detail') || '').trim().toLowerCase();
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (param === 'off') {
      state.detailOn = false;
    } else if (param === 'on') {
      state.detailOn = true;
    } else {
      state.detailOn = !reduced;
    }
    applyDetailMode(false);
  }

  function applyDetailMode(updateUrl) {
    const val = state.detailOn ? 'on' : 'off';
    document.documentElement.dataset.detail = val;
    const btn = $('#btn-detail-toggle');
    const label = $('#detail-toggle-text');
    if (btn) btn.setAttribute('aria-pressed', state.detailOn ? 'true' : 'false');
    if (label) label.textContent = state.detailOn ? 'Grid' : 'Flat';
    if (graph && typeof graph.setDetail === 'function') {
      graph.setDetail(state.detailOn);
    }
    if (updateUrl) updateUrlParams({ detail: val });
  }

  function setMobileSidebarOpen(open) {
    state.sidebarOpen = Boolean(open);
    const sidebar = $('#os-sidebar');
    const backdrop = $('#sidebar-backdrop');
    const shell = $('#app-shell');
    const menuBtn = $('#btn-mobile-menu');
    document.body.classList.toggle('mobile-drawer-open', state.sidebarOpen);
    if (sidebar) {
      sidebar.classList.toggle('is-open', state.sidebarOpen);
      sidebar.classList.toggle('is-mobile-open', state.sidebarOpen);
    }
    if (shell) shell.classList.toggle('sidebar-open', state.sidebarOpen);
    if (backdrop) {
      backdrop.hidden = !state.sidebarOpen;
      backdrop.classList.toggle('is-open', state.sidebarOpen);
    }
    if (menuBtn) menuBtn.setAttribute('aria-expanded', state.sidebarOpen ? 'true' : 'false');
  }

  function setMobileComposerExpanded(expanded, { focusInput = false } = {}) {
    state.mobileComposerExpanded = Boolean(expanded);
    const composer = $('#detail-composer');
    const bar = $('#mobile-composer-bar');
    const toggleBtn = $('#btn-mobile-composer-toggle');
    if (composer) composer.classList.toggle('is-expanded', state.mobileComposerExpanded);
    if (bar) bar.setAttribute('aria-expanded', state.mobileComposerExpanded ? 'true' : 'false');
    if (toggleBtn) toggleBtn.textContent = state.mobileComposerExpanded ? 'Collapse' : 'Compose';
    if (state.mobileComposerExpanded && focusInput) {
      const inp = $('#composer-input');
      if (inp) setTimeout(() => inp.focus(), 40);
    }
  }

  function setTodayMobileDetail(open) {
    state.todayMobileDetailOpen = Boolean(open);
    const shell = $('#today-master-detail');
    const pane = $('#today-detail-pane');
    document.body.classList.toggle(
      'mobile-detail-open',
      state.todayMobileDetailOpen || state.peopleMobileDetailOpen || state.replayMobileDetailOpen
    );
    if (shell) shell.classList.toggle('is-detail-open', state.todayMobileDetailOpen);
    if (pane) {
      pane.classList.toggle('is-open', state.todayMobileDetailOpen);
      pane.classList.toggle('is-mobile-open', state.todayMobileDetailOpen);
    }
    if (!state.todayMobileDetailOpen) {
      setMobileComposerExpanded(false);
    }
  }

  function setPeopleMobileDetail(open) {
    state.peopleMobileDetailOpen = Boolean(open);
    const shell = $('#people-master-detail');
    const pane = $('#people-detail-pane');
    document.body.classList.toggle(
      'mobile-detail-open',
      state.todayMobileDetailOpen || state.peopleMobileDetailOpen || state.replayMobileDetailOpen
    );
    if (shell) shell.classList.toggle('is-detail-open', state.peopleMobileDetailOpen);
    if (pane) {
      pane.classList.toggle('is-open', state.peopleMobileDetailOpen);
      pane.classList.toggle('is-mobile-open', state.peopleMobileDetailOpen);
    }
  }

  function setReplayMobileDetail(open) {
    state.replayMobileDetailOpen = Boolean(open);
    const shell = $('#replay-shell');
    const stage = $('#replay-stage');
    document.body.classList.toggle(
      'mobile-detail-open',
      state.todayMobileDetailOpen || state.peopleMobileDetailOpen || state.replayMobileDetailOpen
    );
    if (shell) shell.classList.toggle('is-detail-open', state.replayMobileDetailOpen);
    if (stage) {
      stage.classList.toggle('is-open', state.replayMobileDetailOpen);
      stage.classList.toggle('is-mobile-open', state.replayMobileDetailOpen);
    }
    if (state.replayMobileDetailOpen) {
      requestAnimationFrame(() => {
        if (replayMap) replayMap.resize();
        if (replayScrubberCtrl && typeof replayScrubberCtrl.setActiveDay === 'function' && state.replaySelectedDay) {
          replayScrubberCtrl.setActiveDay(state.replaySelectedDay);
        }
      });
      setTimeout(() => {
        if (replayMap) replayMap.resize();
        if (replayScrubberCtrl && typeof replayScrubberCtrl.setActiveDay === 'function' && state.replaySelectedDay) {
          replayScrubberCtrl.setActiveDay(state.replaySelectedDay);
        }
      }, 260);
    }
  }

  function toggleSubSidebar(forceCollapsed) {
    const shell = $('#app-shell');
    if (state.view === 'vault') {
      state.vaultSidebarOpen = forceCollapsed !== undefined ? !Boolean(forceCollapsed) : !state.vaultSidebarOpen;
      if (shell) shell.classList.toggle('vault-sidebar-open', state.vaultSidebarOpen);
      return;
    }
    if (state.view === 'graph') {
      state.dirCollapsed = forceCollapsed !== undefined ? Boolean(forceCollapsed) : !state.dirCollapsed;
      if (shell) shell.classList.toggle('dir-collapsed', state.dirCollapsed);
      if (graph) setTimeout(() => graph.resize(), 220);
    }
  }

  // =========================================================================
  // VIEW SWITCHING (10 WORKSPACE VIEWS, DEFAULT: TODAY)
  // =========================================================================
  function formatTasteNavCount(stats, fallbackVal) {
    if (stats && typeof stats === 'object') {
      const answered = Number(stats.answered_count);
      const total = Number(stats.total_questions);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(answered)) {
        return answered + '/' + total;
      }
      if (stats.calibration_pct !== undefined && stats.calibration_pct !== null) {
        return Math.round(Number(stats.calibration_pct)) + '%';
      }
    }
    if (fallbackVal !== undefined && fallbackVal !== null && fallbackVal !== '') {
      return String(fallbackVal);
    }
    return '--';
  }

  function ensureCodexMounted() {
    if (state.codexMounted) return true;
    const codexEl = $('#view-codex');
    const api = window.KizukiCodexView;
    if (!codexEl || !api || typeof api.mount !== 'function') return false;
    api.mount(codexEl, {
      openPerson: (key) => {
        if (!key) return;
        if (!state.peopleLoaded) loadPeople();
        openPersonDossier(key, { jumpView: true, openMobileDetail: true });
      },
      openDoc: (docPath) => {
        if (docPath) openVaultDoc(docPath);
      },
      openReplayDay: (dayStr) => {
        if (!dayStr) return;
        const yr = Number(String(dayStr).slice(0, 4));
        if (Number.isFinite(yr)) state.replayYear = yr;
        switchView('replay', { day: String(dayStr), openMobileDetail: isMobileViewport() });
      },
      openBoard: (opts = {}) => switchView('board', opts),
      showToast: (msg, tone) => showToast(msg, tone || 'info'),
      renderMarkdown: (md) => renderMarkdownHtml(md),
      updateNavCount: (count) => {
        const num = Number(count);
        if (Number.isFinite(num)) {
          state.codexTotal = num;
          setNavCount('nav-count-codex', formatCompact(num));
        }
      },
    });
    state.codexMounted = true;
    return true;
  }

  function ensureTasteMounted() {
    if (state.tasteMounted) return true;
    const tasteEl = $('#view-taste');
    const api = window.KizukiTasteView;
    if (!tasteEl || !api || typeof api.mount !== 'function') return false;
    api.mount(tasteEl, {
      openDoc: (docPath) => {
        if (docPath) openVaultDoc(docPath);
      },
      openBoard: (opts = {}) => switchView('board', opts),
      showToast: (msg, tone) => showToast(msg, tone || 'info'),
      updateNavCount: (val, stats) => {
        const label = formatTasteNavCount(stats, val);
        state.tasteNavLabel = label;
        setNavCount('nav-count-taste', label);
      },
    });
    state.tasteMounted = true;
    return true;
  }

  function openBoardMindView(view, target) {
    const v = String(view || '').toLowerCase();
    const obj = target && typeof target === 'object' ? target : {};
    const id = typeof target === 'string' ? target : '';
    if (v === 'people' || v === 'person') {
      const personKey = id || obj.key || obj.person || obj.id || '';
      if (personKey) {
        if (!state.peopleLoaded) loadPeople();
        openPersonDossier(personKey, { jumpView: true, openMobileDetail: true });
      } else {
        switchView('people');
      }
      return;
    }
    if (v === 'vault' || v === 'doc' || v === 'docs') {
      const docPath = id || obj.path || obj.doc || '';
      if (docPath) openVaultDoc(docPath);
      else switchView('vault');
      return;
    }
    if (v === 'codex') {
      switchView('codex', {
        section: obj.section || undefined,
        itemId: id || obj.itemId || obj.id || undefined,
        q: obj.q || undefined,
      });
      return;
    }
    if (v === 'taste') {
      switchView('taste', {
        domain: id || obj.domain || undefined,
        tab: obj.tab || undefined,
      });
      return;
    }
    if (v === 'replay') {
      const dayStr = id || obj.day || '';
      if (dayStr) {
        const yr = Number(String(dayStr).slice(0, 4));
        if (Number.isFinite(yr)) state.replayYear = yr;
        switchView('replay', { day: String(dayStr), openMobileDetail: isMobileViewport() });
      } else {
        switchView('replay');
      }
      return;
    }
    if (v === 'commit') {
      const sha = id || obj.sha || obj.id || '';
      if (sha) {
        copyToClipboard(sha, 'Copied commit ' + sha.slice(0, 12));
      } else {
        switchView('stream');
      }
      return;
    }
    if (v === 'board' || v === 'agent-board') {
      switchView('board', id ? { channel: id } : obj);
      return;
    }
    if (v) switchView(v, obj);
  }

  function ensureBoardMounted() {
    if (state.boardMounted) return true;
    const boardEl = $('#view-board');
    const api = window.KizukiAgentBoardView;
    if (!boardEl || !api || typeof api.mount !== 'function') return false;
    api.mount(boardEl, {
      showToast: (msg, tone) => showToast(msg, tone || 'info'),
      renderMarkdown: (md) => renderMarkdownHtml(md),
      openDoc: (docPath) => {
        if (docPath) openVaultDoc(docPath);
      },
      openPerson: (key) => {
        if (!key) return;
        if (!state.peopleLoaded) loadPeople();
        openPersonDossier(key, { jumpView: true, openMobileDetail: true });
      },
      openView: openBoardMindView,
      updateNavCount: (n) => {
        if (n !== null && n !== undefined && n !== '') {
          setNavCount('nav-count-board', typeof n === 'number' ? formatCompact(n) : String(n));
        }
      },
    });
    state.boardMounted = true;
    return true;
  }

  function prefetchCodexAndTasteStats() {
    apiGet('/api/codex?section=all')
      .then((res) => {
        const total = Number(res && res.stats && res.stats.total);
        if (Number.isFinite(total)) {
          state.codexTotal = total;
          setNavCount('nav-count-codex', formatCompact(total));
        }
      })
      .catch(() => {});

    apiGet('/api/taste?domain=all')
      .then((res) => {
        if (res && res.stats) {
          const label = formatTasteNavCount(res.stats);
          state.tasteNavLabel = label;
          setNavCount('nav-count-taste', label);
        }
      })
      .catch(() => {});

    apiGet('/api/agent-board/health')
      .then((res) => {
        const channels = Number(res && res.totals && res.totals.channels);
        if (Number.isFinite(channels) && channels >= 0) {
          setNavCount('nav-count-board', formatCompact(channels));
        }
      })
      .catch(() => {});
  }

  function switchView(rawView, opts = {}) {
    let viewName = String(rawView || 'today').toLowerCase();
    if (viewName === 'overview' || viewName === 'inbox' || viewName === 'home') viewName = 'today';
    if (viewName === 'brief') viewName = 'vault';
    if (viewName === 'mind-codex') viewName = 'codex';
    if (viewName === 'taste-studio') viewName = 'taste';
    if (viewName === 'agent-board') viewName = 'board';
    if (!VALID_VIEWS.has(viewName)) viewName = 'today';

    // W2-2: Ensure lazy view chunk is loaded before mounting view modules
    if (
      !opts._chunkEnsured &&
      window.KizukiLoader &&
      typeof window.KizukiLoader.chunkForView === 'function' &&
      typeof window.KizukiLoader.isLoaded === 'function' &&
      typeof window.KizukiLoader.ensure === 'function'
    ) {
      const neededChunk = window.KizukiLoader.chunkForView(viewName);
      if (neededChunk && !window.KizukiLoader.isLoaded(neededChunk)) {
        window.KizukiLoader.ensure(viewName)
          .then(() => switchView(viewName, { ...opts, _chunkEnsured: true }))
          .catch(() => switchView(viewName, { ...opts, _chunkEnsured: true }));
        return;
      }
    }

    const prevView = state.view;
    if (prevView === 'replay' && viewName !== 'replay') {
      if (replayScrubberCtrl && typeof replayScrubberCtrl.pause === 'function') {
        replayScrubberCtrl.pause();
      }
      if (state.replayMobileDetailOpen) {
        setReplayMobileDetail(false);
      }
    }

    state.view = viewName;
    setMobileSidebarOpen(false);
    document.body.classList.toggle('view-today', viewName === 'today');
    document.body.classList.toggle('view-is-today', viewName === 'today');
    clearTransientToasts();
    if (state.todayLoaded) {
      updateTodaySidebarWidgets();
    }

    const shell = $('#app-shell');
    if (shell) {
      shell.setAttribute('data-active-view', viewName);
      shell.classList.remove('vault-sidebar-open');
      state.vaultSidebarOpen = false;
    }

    $$('.os-nav-btn[data-view]').forEach((btn) => {
      const active = btn.dataset.view === viewName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    let activePanelEl = null;
    $$('.view-panel').forEach((panel) => {
      const active = panel.id === 'view-' + viewName;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
      if (active) activePanelEl = panel;
    });

    if (activePanelEl && window.KizukiMotion && typeof window.KizukiMotion.animateViewSwap === 'function') {
      window.KizukiMotion.animateViewSwap(activePanelEl);
    }

    if (viewName === 'board') {
      const explicitThread = opts.threadId || opts.thread;
      const nextChannel = opts.channel ? String(opts.channel) : '';
      const changingChannel = Boolean(nextChannel && nextChannel !== String(state.boardChannel || ''));
      const changingMode = Boolean(opts.mode && !explicitThread);
      if (!explicitThread && (changingChannel || changingMode || opts.threadId === null || opts.thread === null)) {
        state.boardThreadId = null;
      }
      if (nextChannel) state.boardChannel = nextChannel;
      if (explicitThread) state.boardThreadId = String(explicitThread);
      if (opts.stage) state.boardStage = String(opts.stage);
    }

    if (opts.updateUrl !== false) {
      updateUrlParams({
        view: viewName,
        doc: viewName === 'vault' ? state.activeDocPath : null,
        person: viewName === 'people' ? state.selectedPersonKey : null,
        day: viewName === 'replay' ? state.replaySelectedDay : null,
        section: viewName === 'codex' ? (opts.section || null) : null,
        domain: viewName === 'taste' ? (opts.domain || null) : null,
        channel: viewName === 'board' ? (opts.channel || state.boardChannel || null) : null,
        thread: viewName === 'board' ? (opts.threadId || opts.thread || state.boardThreadId || null) : null,
        stage: viewName === 'board' ? (opts.stage || state.boardStage || null) : null,
        mode: viewName === 'board' ? (opts.mode || null) : null,
      });
    }

    if (viewName === 'today' && !state.todayLoaded) {
      loadToday();
    } else if (viewName === 'people' && !state.peopleLoaded) {
      loadPeople();
    } else if (viewName === 'codex') {
      if (ensureCodexMounted() && window.KizukiCodexView && typeof window.KizukiCodexView.load === 'function') {
        window.KizukiCodexView.load({
          section: opts.section,
          itemId: opts.itemId,
          q: opts.q,
        });
      }
    } else if (viewName === 'taste') {
      if (ensureTasteMounted() && window.KizukiTasteView && typeof window.KizukiTasteView.load === 'function') {
        window.KizukiTasteView.load({
          domain: opts.domain,
          tab: opts.tab,
        });
      }
    } else if (viewName === 'board') {
      if (ensureBoardMounted() && window.KizukiAgentBoardView && typeof window.KizukiAgentBoardView.load === 'function') {
        window.KizukiAgentBoardView.load({
          channel: opts.channel || state.boardChannel || undefined,
          threadId: opts.threadId || opts.thread || state.boardThreadId || undefined,
          stage: opts.stage || state.boardStage || undefined,
          mode: opts.mode || undefined,
        });
      }
    } else if (viewName === 'replay') {
      ensureReplayMapReady();
      const autoOpenMobileStage =
        opts.openMobileDetail !== undefined ? Boolean(opts.openMobileDetail) : isMobileViewport();
      if (!state.replayLoaded && !state.replayLoading) {
        loadReplayIndex({
          year: state.replayYear || undefined,
          targetDay: opts.day || state.replaySelectedDay || undefined,
          openMobileDetail: autoOpenMobileStage,
        });
      } else {
        if (opts.day && opts.day !== state.replaySelectedDay) {
          selectReplayDay(opts.day, { openMobileDetail: autoOpenMobileStage });
        } else if (autoOpenMobileStage && isMobileViewport() && state.replaySelectedDay) {
          setReplayMobileDetail(true);
        }
        requestAnimationFrame(() => {
          if (replayMap) {
            replayMap.resize();
            syncReplayMap();
          }
          if (replayScrubberCtrl && typeof replayScrubberCtrl.setActiveDay === 'function' && state.replaySelectedDay) {
            replayScrubberCtrl.setActiveDay(state.replaySelectedDay);
          }
        });
      }
    } else if (viewName === 'vault') {
      if (!state.vaultLoaded) loadVaultDocs({ reset: true });
      if (!state.activeDocPath && !opts.skipAutoOpen) {
        openVaultDoc('dashboards/executive-digest-latest.md', { fallbackFirst: true });
      }
    } else if (viewName === 'graph') {
      ensureGraphReady();
      requestAnimationFrame(() => {
        if (graph) graph.resize();
      });
    } else if (viewName === 'stream' && !state.streamLoaded) {
      loadStream({ reset: true });
    } else if (viewName === 'atlas' && !state.atlasData) {
      loadAtlas();
    } else if (viewName === 'memt' && !state.memtData) {
      loadMemt();
    }
  }

  // =========================================================================
  // PULSE TELEMETRY & SIDEBAR COUNTS
  // =========================================================================
  function setNavCount(id, value) {
    const el = $('#' + id);
    if (el && value !== null && value !== undefined && value !== '') {
      el.textContent = String(value);
    }
  }

  function getCanonicalEventsTotal() {
    const s = (state.today && state.today.summary) || {};
    const pVault = (state.pulse && state.pulse.vault) || {};
    const oVault = (state.overview && state.overview.vault) || {};
    const candidates = [s.events_total, pVault.events_total, oVault.events_total, state.streamTotal]
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length === 0) return null;
    return Math.max(...candidates);
  }

  function syncUnifiedCounters() {
    const s = (state.today && state.today.summary) || {};
    const p = state.pulse || {};
    const o = state.overview || {};
    const pVault = p.vault || {};
    const oVault = o.vault || {};
    const memt = Object.assign({}, o.memt || {}, p.memt || {});

    // Today: exact visible triage row count (matches 1 / N footer)
    if (state.todayBaselineCount !== null && state.todayBaselineCount !== undefined) {
      setNavCount('nav-count-today', String(state.todayBaselineCount));
    }

    // People: authoritative total (never fall back to people_radar length)
    const peopleTotal = s.people_total ?? p.people_total ?? o.people_total ?? (state.peopleTotal > 0 ? state.peopleTotal : null);
    if (peopleTotal !== null && peopleTotal !== undefined && Number(peopleTotal) > 0) {
      state.peopleTotal = Number(peopleTotal);
      setNavCount('nav-count-people', formatCompact(peopleTotal));
    }

    // Replay: total active days across archive
    const replayDays =
      state.replayTotalActiveDays ??
      (state.replayIndex && state.replayIndex.stats ? state.replayIndex.stats.total_days_with_activity : null) ??
      s.replay_days ??
      p.replay_days ??
      o.replay_days ??
      null;
    if (replayDays !== null && replayDays !== undefined && Number(replayDays) > 0) {
      state.replayTotalActiveDays = Number(replayDays);
      setNavCount('nav-count-replay', formatCompact(replayDays));
    }

    // Vault docs total
    const docsMeta = p.docs_summary || p.docs || p.vault_docs || {};
    const docsTotal = s.docs_total ?? docsMeta.total ?? p.docs_total ?? p.doc_count ?? (state.vaultTotal > 0 ? state.vaultTotal : null);
    if (docsTotal !== null && docsTotal !== undefined && Number(docsTotal) > 0) {
      state.vaultTotal = Number(docsTotal);
      const compactDocs = formatCompact(docsTotal);
      setNavCount('nav-count-vault', compactDocs);
      const vaultSearchInput = $('#vault-search');
      if (vaultSearchInput) vaultSearchInput.placeholder = 'Search ' + compactDocs + ' docs...';
      const cmdkSearchInput = $('#cmdk-input');
      if (cmdkSearchInput) cmdkSearchInput.placeholder = 'Search calendar, inbox, people, ' + compactDocs + ' docs, MemT, or nodes...';
    }

    // Graph nodes count
    const graphNodes =
      (state.graphData.nodes.length > 0 ? state.graphData.nodes.length : null) ??
      s.graph_nodes ??
      p.graph_nodes ??
      o.graph_nodes ??
      null;
    if (graphNodes !== null && graphNodes !== undefined && Number(graphNodes) > 0) {
      setNavCount('nav-count-graph', formatCompact(graphNodes));
    }

    // Stream + Graph KPI Events total (always unified, never stale)
    const eventsTotal = getCanonicalEventsTotal();
    if (eventsTotal !== null) {
      setNavCount('nav-count-stream', formatCompact(eventsTotal));
      const mEv = $('#metric-events');
      if (mEv) mEv.textContent = formatCompact(eventsTotal);
    }

    // Graph KPI Claims & World
    const claimsLive = s.claims_live ?? pVault.claims_live ?? oVault.claims_live;
    const worldCount = s.consolidation_complete ?? pVault.consolidation_complete ?? oVault.consolidation_complete;
    const mCl = $('#metric-claims');
    const mCo = $('#metric-consolidated');
    if (mCl && claimsLive !== undefined) mCl.textContent = formatCompact(claimsLive);
    if (mCo && worldCount !== undefined) mCo.textContent = formatCompact(worldCount);

    // Atlas panels count (hydrated immediately on boot, never '--')
    const atlasPanels =
      s.atlas_panels ??
      p.atlas_panels ??
      o.atlas_panels ??
      (state.atlasData && Array.isArray(state.atlasData.panels) ? state.atlasData.panels.length : null) ??
      (state.todayLoaded ? 6 : null);
    if (atlasPanels !== null && atlasPanels !== undefined && Number(atlasPanels) > 0) {
      setNavCount('nav-count-atlas', String(atlasPanels));
    }

    // MemT verified count
    const memtVerified = s.memt_verified ?? memt.verified;
    const memtTotal = s.memt_total ?? memt.total;
    if (memtVerified !== undefined && memtVerified !== null) {
      setNavCount('nav-count-memt', String(memtVerified));
      const mMemt = $('#metric-memt');
      if (mMemt) mMemt.textContent = String(memtVerified) + (memtTotal !== undefined ? '/' + memtTotal : '');
    }
  }

  function updateSidebarTelemetry(daemon, vault, memt, docsTotal) {
    const badge = $('#tailnet-badge');
    const statusText = $('#tailnet-status-text');
    if (badge) {
      badge.classList.remove('is-offline');
      badge.classList.add('is-online');
      const ver = daemon && daemon.version ? ' v' + daemon.version : '';
      const ev24 = vault && vault.events_24h !== undefined ? ' | +' + vault.events_24h + ' events (24h)' : '';
      badge.title = 'Private Tailscale vault online' + ver + ev24;
    }
    if (statusText) statusText.textContent = 'tailnet';

    if (docsTotal) {
      state.vaultTotal = Number(docsTotal);
    }
    syncUnifiedCounters();
  }

  async function loadPulseTelemetry() {
    const [pulseRes, overviewRes] = await Promise.allSettled([
      apiGet('/api/pulse'),
      apiGet('/api/overview'),
    ]);

    const pulse = pulseRes.status === 'fulfilled' ? pulseRes.value : null;
    const overview = overviewRes.status === 'fulfilled' ? overviewRes.value : null;
    state.pulse = pulse;
    state.overview = overview;

    if (!pulse && !overview) {
      const badge = $('#tailnet-badge');
      if (badge) {
        badge.classList.remove('is-online');
        badge.classList.add('is-offline');
      }
      const statusText = $('#tailnet-status-text');
      if (statusText) statusText.textContent = 'offline';
      return;
    }

    const p = pulse || {};
    const o = Object.assign({}, overview || {}, p.overview || {});
    const vault = Object.assign({}, o.vault || {}, p.vault || {});
    const memt = Object.assign({}, o.memt || {}, p.memt || {});
    const daemon = Object.assign({}, o.daemon || {}, p.daemon || {});
    const docsMeta = p.docs_summary || p.docs || p.vault_docs || {};
    const docsTotal = docsMeta.total ?? p.docs_total ?? p.doc_count ?? null;

    updateSidebarTelemetry(daemon, vault, memt, docsTotal);
    if (state.today && state.selectedTodayId === 'morning-brief') {
      renderTodayDetailPane();
    }
  }

  // =========================================================================
  // VIEW 1: TODAY PERSONAL OS (3-PANE MASTER-DETAIL)
  // =========================================================================
  function formatScheduleTime(startIso, isToday, isTomorrow) {
    if (!startIso) return '';
    const d = new Date(startIso);
    if (Number.isNaN(d.getTime())) return String(startIso).slice(0, 16);
    const hhmm =
      String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    if (isToday) return hhmm;
    if (isTomorrow) return 'Tom ' + hhmm;
    const monDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return monDay + ' ' + hhmm;
  }

  function formatShortDate(dateStr) {
    if (!dateStr) return '--';
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      }
    }
    return String(dateStr);
  }

  function normalizeTodayData(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const schedule = (Array.isArray(d.schedule) ? d.schedule : []).map((m, idx) => {
      const isToday = Boolean(m.is_today);
      const isTomorrow = Boolean(m.is_tomorrow);
      const timeLabel = m.time_label || m.time || formatScheduleTime(m.start || m.start_time, isToday, isTomorrow);
      return {
        id: String(m.id || 'sched-' + idx),
        title: stripEmDash(m.title || m.summary || 'Calendar Event'),
        start: m.start || m.start_time || '',
        end: m.end || m.end_time || '',
        time_label: timeLabel,
        is_today: isToday,
        is_tomorrow: isTomorrow,
        calendar: m.calendar || m.calendar_name || m.source || 'Calendar',
        status: String(m.status || (m.is_now ? 'now' : 'upcoming')).toLowerCase(),
        is_now: Boolean(m.is_now || String(m.status || '').toLowerCase() === 'now'),
        countdown: m.countdown || m.countdown_label || '',
        participants: Array.isArray(m.participants) ? m.participants : (Array.isArray(m.attendees) ? m.attendees : []),
        location: m.location || '',
        meet_url: extractMeetUrl(m.meet_url || m.hangout_link || m.meeting_url || '', (m.location || '') + '\n' + (m.raw_text || m.description || m.body || '')),
        dial_in: stripEmDash(m.dial_in || m.phone || ''),
        body: stripEmDash(m.body ?? m.clean_description ?? m.description ?? m.notes ?? m.raw_text ?? ''),
        description: stripEmDash(m.body ?? m.clean_description ?? m.description ?? m.notes ?? m.raw_text ?? ''),
        raw_text: stripEmDash(m.raw_text || ''),
        related_docs: Array.isArray(m.related_docs) ? m.related_docs : [],
        related_messages: Array.isArray(m.related_messages) ? m.related_messages : [],
      };
    });

    const actions = (Array.isArray(d.actions) ? d.actions : []).map((a, idx) => ({
      id: String(a.id || 'act-' + idx),
      title: stripEmDash(a.title || a.text || 'Untitled action'),
      detail: stripEmDash(a.detail || a.notes || a.description || ''),
      tag: a.tag || a.category || 'Work',
      source: a.source || 'Owner',
      done: Boolean(a.done ?? a.completed),
      created_at: a.created_at || '',
      updated_at: a.updated_at || '',
    }));

    const inbox = (Array.isArray(d.inbox) ? d.inbox : []).map((msg, idx) => {
      const ch = normalizeChannel(msg.channel || msg.source || msg.connector);
      return {
        id: String(msg.id || 'msg-' + idx),
        channel: ch,
        channel_label: msg.channel_label || channelInfo(ch).label,
        thread_key: msg.thread_key || '',
        sender: stripEmDash(msg.sender || msg.from || msg.name || msg.contact || 'Unknown'),
        person_key: msg.person_key || msg.sender_key || msg.key || '',
        title: stripEmDash(msg.thread_title || msg.title || msg.subject || msg.sender || 'Message'),
        subject: stripEmDash(msg.subject || msg.thread_title || ''),
        snippet: stripEmDash(msg.preview || msg.snippet || msg.summary || ''),
        body: stripEmDash(msg.full_text || msg.body || msg.text || msg.preview || msg.snippet || ''),
        timestamp: msg.occurred_at || msg.timestamp || msg.last_seen || msg.date || '',
        age: msg.age || '',
        is_noise: Boolean(msg.is_noise || msg.noise),
        noise_reason: msg.noise_reason || '',
        message_count: Number(msg.message_count || msg.count || 1),
      };
    });

    const people_radar = Array.isArray(d.people_radar) ? d.people_radar : [];
    const workstreams = Array.isArray(d.workstreams) ? d.workstreams : [];
    const inbox_counts = d.inbox_counts && typeof d.inbox_counts === 'object' ? d.inbox_counts : {};
    const whoop = d.whoop && typeof d.whoop === 'object' ? d.whoop : null;
    const summary = d.summary && typeof d.summary === 'object' ? d.summary : {};
    const owner_anchors =
      typeof d.owner_anchors === 'string'
        ? d.owner_anchors
        : (d.owner_anchors && (d.owner_anchors.content || d.owner_anchors.markdown)) || '';

    return {
      generated_at: d.generated_at || new Date().toISOString(),
      summary,
      schedule,
      actions,
      inbox,
      inbox_counts,
      people_radar,
      whoop,
      workstreams,
      owner_anchors,
    };
  }

  async function loadToday({ silent = false } = {}) {
    const listEl = $('#triage-list');
    if (!silent && !state.todayLoaded && listEl) {
      listEl.innerHTML = '<div class="panel-body"><div class="skeleton-block"></div></div>';
    }
    try {
      const nextMovesPromise = apiGet('/api/today/next-moves').catch(() => null);
      const data = await apiGet('/api/today?includeNoise=' + (state.includeNoise ? 'true' : 'false'));
      state.today = normalizeTodayData(data);
      state.todayLoaded = true;

      updateTodaySidebarWidgets();
      renderTodayTriageList();
      renderTodayDetailPane();

      nextMovesPromise.then((nm) => {
        if (!nm || typeof nm !== 'object') return;
        state.todayNextMoves = nm;
        if (state.view === 'today' && state.selectedTodayId === 'morning-brief') {
          renderTodayDetailPane();
        }
      });
    } catch (err) {
      if (listEl) {
        listEl.innerHTML =
          '<div class="empty-state">Unable to load Today workbench (' + escHtml(err.message) + ').</div>';
      }
      const bodyEl = $('#detail-body');
      if (bodyEl && !state.today) {
        bodyEl.innerHTML =
          '<div class="empty-state">Waiting for /api/today backend. Check Kizuki Explorer server.</div>';
      }
    }
  }

  function updateTodaySidebarWidgets() {
    if (!state.today) return;
    const { schedule, actions, inbox_counts, whoop, summary } = state.today;

    const openActions = actions.filter((a) => !a.done).length;
    const tabActEl = $('#tab-count-actions');
    if (tabActEl) tabActEl.textContent = String(openActions);
    const tabSchedEl = $('#tab-count-schedule');
    if (tabSchedEl) tabSchedEl.textContent = String(schedule.length);

    syncUnifiedCounters();

    // Defensive fallback if summary.people_total was omitted by backend
    if (!summary.people_total && !state.peopleTotal && !state.peopleCountPrefetched) {
      state.peopleCountPrefetched = true;
      apiGet('/api/people?limit=1')
        .then((res) => {
          const total = Number(res && (res.total ?? (Array.isArray(res.items) ? res.items.length : 0)));
          if (Number.isFinite(total) && total > 0) {
            state.peopleTotal = total;
            syncUnifiedCounters();
          }
        })
        .catch(() => {});
    }

    // Noise toggle button
    const noiseBtn = $('#btn-noise-toggle');
    const noiseText = $('#noise-toggle-text');
    const derivedNoise =
      inbox_counts.all !== undefined && inbox_counts.priority !== undefined
        ? Math.max(0, Number(inbox_counts.all) - Number(inbox_counts.priority))
        : 0;
    const filteredCount = Number(
      inbox_counts.noise_filtered ?? inbox_counts.filtered_noise ?? inbox_counts.noise ?? derivedNoise
    );
    if (noiseBtn) {
      noiseBtn.setAttribute('aria-pressed', state.includeNoise ? 'true' : 'false');
      noiseBtn.classList.toggle('is-active', state.includeNoise);
    }
    if (noiseText) {
      if (state.includeNoise) {
        noiseText.textContent = 'Showing spam / crypto' + (filteredCount > 0 ? ' (' + filteredCount + ')' : '');
      } else {
        noiseText.textContent = 'Spam / crypto filtered' + (filteredCount > 0 ? ' (' + filteredCount + ')' : '');
      }
    }

    // Filter out past events whose start time was more than 45 minutes ago (unless currently live)
    const nowMs = Date.now();
    const upcomingSchedule = schedule.filter((ev) => {
      if (ev.is_now) return true;
      if (ev.start) {
        const startMs = Date.parse(ev.start);
        if (Number.isFinite(startMs)) {
          return (nowMs - startMs) <= 45 * 60 * 1000;
        }
      }
      const cd = String(ev.countdown || '').toLowerCase();
      if (cd.includes('ago')) {
        if (/\d+\s*h/.test(cd) || /\d+\s*d/.test(cd)) return false;
        const mMatch = cd.match(/(\d+)\s*m/);
        if (mMatch && Number(mMatch[1]) > 45) return false;
      }
      return true;
    });

    // Pinned Rail Next Up (suppressed on Today so events render once in Unified Day Timeline)
    const railNext = $('#rail-next-up');
    if (railNext) {
      if (state.view === 'today') {
        railNext.innerHTML = '';
      } else {
        const top3 = upcomingSchedule.slice(0, 3);
        if (top3.length === 0) {
          railNext.innerHTML = '<div class="rail-empty">Clear calendar ahead.</div>';
        } else {
          railNext.innerHTML = top3
            .map((ev) => {
              const isNow = ev.is_now;
              const timeBadge = isNow
                ? '<span class="badge-now" style="white-space:nowrap;flex-shrink:0;">NOW</span>'
                : ev.countdown
                ? '<span class="badge-countdown" style="white-space:nowrap;flex-shrink:0;">' + escHtml(ev.countdown) + '</span>'
                : '';
              return (
                '<button type="button" class="rail-agenda-item' +
                (isNow ? ' is-now' : '') +
                '" data-jump-meeting="' +
                escHtml(ev.id) +
                '">' +
                '<span class="rail-agenda-top">' +
                '<span class="rail-agenda-time tabular">' + escHtml(ev.time_label || formatRelativeTime(ev.start) || 'Soon') + '</span>' +
                timeBadge +
                '</span>' +
                '<span class="rail-agenda-title">' + escHtml(ev.title) + '</span>' +
                '</button>'
              );
            })
            .join('');
        }
      }
    }

    // Mobile Sticky Next-Up Ticker
    const tickerEl = $('#mobile-ticker-text');
    const tickerBtn = $('#mobile-next-up-ticker');
    if (tickerEl) {
      const nowEv = upcomingSchedule.find((s) => s.is_now);
      const nextEv = upcomingSchedule.find((s) => !s.is_now) || upcomingSchedule[1] || null;
      const primaryTarget = nowEv || upcomingSchedule[0] || null;
      state.tickerTargetMeetingId = primaryTarget ? primaryTarget.id : null;
      const parts = [];
      if (nowEv) {
        parts.push('Now: ' + (nowEv.time_label ? nowEv.time_label + ' ' : '') + nowEv.title);
      } else if (upcomingSchedule[0]) {
        parts.push('Next: ' + (upcomingSchedule[0].time_label ? upcomingSchedule[0].time_label + ' ' : '') + upcomingSchedule[0].title);
      }
      if (nowEv && nextEv && nextEv.id !== nowEv.id) {
        parts.push('Next: ' + (nextEv.time_label ? nextEv.time_label + ' ' : '') + nextEv.title);
      }
      tickerEl.textContent = parts.length > 0 ? parts.join(' \u00b7 ') : 'No upcoming meetings today';
      if (tickerBtn) tickerBtn.classList.toggle('has-now', Boolean(nowEv));
    }

    // Whoop Telemetry (Rail + Mobile Pill) with honest stale handling
    const railWhoopEl = $('#rail-whoop');
    const mobileWhoopPill = $('#mobile-whoop-pill');
    const whoopDateEl = $('#rail-whoop-date');
    const whoopMetricsEl = $('#rail-whoop-metrics');
    const whoopBarEl = $('#rail-whoop-bar');
    const mobileWhoopText = $('#mobile-whoop-text');
    if (whoop) {
      const rec = whoop.recovery_pct ?? whoop.recovery;
      const hrv = whoop.hrv_ms ?? whoop.hrv;
      const sleep = whoop.sleep_hours ?? whoop.sleep;
      const shortDate = whoop.date_label || formatShortDate(whoop.date);
      let ageDays = whoop.age_days !== undefined && whoop.age_days !== null ? Number(whoop.age_days) : null;
      if (ageDays === null && whoop.date) {
        const wd = new Date(whoop.date);
        if (!Number.isNaN(wd.getTime())) {
          ageDays = (Date.now() - wd.getTime()) / 86400000;
        }
      }
      const isStale = Boolean(whoop.is_stale) || (ageDays !== null && Number.isFinite(ageDays) && ageDays > 2);
      const isStaleOld = ageDays !== null && Number.isFinite(ageDays) && ageDays > 14;

      if (railWhoopEl) {
        railWhoopEl.classList.toggle('is-stale', isStale);
        railWhoopEl.classList.toggle('is-stale-old', isStaleOld);
      }
      if (mobileWhoopPill) {
        mobileWhoopPill.classList.toggle('is-stale', isStale);
        mobileWhoopPill.title = isStale
          ? 'Whoop telemetry stale (' + shortDate + ')'
          : 'Latest Whoop recovery (' + shortDate + ')';
      }

      if (whoopDateEl) {
        whoopDateEl.textContent = isStale ? String(shortDate) : String(shortDate);
      }
      const metricParts = [];
      if (rec !== undefined && rec !== null) metricParts.push('<strong>' + escHtml(Math.round(Number(rec))) + '%</strong> Rec');
      if (hrv !== undefined && hrv !== null) metricParts.push('<strong>' + escHtml(hrv) + 'ms</strong> HRV');
      if (sleep !== undefined && sleep !== null) metricParts.push('<strong>' + escHtml(sleep) + 'h</strong>');
      if (whoopMetricsEl) {
        if (isStale) {
          const syncedLabel = shortDate && shortDate !== '--' ? shortDate : 'earlier';
          whoopMetricsEl.textContent = 'Whoop: ' + syncedLabel + ' (stale)';
        } else {
          whoopMetricsEl.innerHTML = metricParts.length > 0 ? metricParts.join(' <span class="whoop-sep">\u00b7</span> ') : 'No recent Whoop sync';
        }
      }
      if (whoopBarEl && Number.isFinite(Number(rec))) {
        const clamped = Math.max(0, Math.min(100, Math.round(Number(rec))));
        whoopBarEl.style.width = clamped + '%';
        whoopBarEl.className =
          'whoop-bar-fill ' + (isStale ? 'is-stale' : clamped >= 67 ? 'is-green' : clamped >= 34 ? 'is-amber' : 'is-red');
      }
      if (mobileWhoopText) {
        mobileWhoopText.textContent = rec !== undefined && rec !== null ? 'WHOOP ' + Math.round(Number(rec)) + '%' : '--';
      }
    } else {
      if (railWhoopEl) railWhoopEl.classList.add('is-stale');
      if (mobileWhoopPill) mobileWhoopPill.classList.add('is-stale');
      if (whoopDateEl) whoopDateEl.textContent = '--';
      if (whoopMetricsEl) whoopMetricsEl.textContent = 'Whoop offline';
      if (mobileWhoopText) mobileWhoopText.textContent = '--';
    }
  }

  function buildTodayTriageRows() {
    if (!state.today) return [];
    const { schedule, actions, inbox } = state.today;
    const rows = [];

    // Pinned Row #0: Morning Brief
    rows.push({
      id: 'morning-brief',
      kind: 'brief',
      group: 'brief',
    });

    const showSchedule = state.todayTab === 'schedule' || state.todayTab === 'all';
    const showActions = state.todayTab === 'priority' || state.todayTab === 'actions' || state.todayTab === 'all';
    const showInbox = state.todayTab === 'priority' || state.todayTab === 'all';

    if (showSchedule) {
      const schedItems = state.todayTab === 'priority' ? schedule.slice(0, 4) : schedule;
      for (const ev of schedItems) {
        rows.push({
          id: 'meeting:' + ev.id,
          kind: 'meeting',
          group: 'schedule_actions',
          data: ev,
        });
      }
    }

    if (showActions) {
      const actItems =
        state.todayTab === 'priority'
          ? actions.filter((a) => !a.done).slice(0, 8)
          : actions;
      for (const act of actItems) {
        rows.push({
          id: 'action:' + act.id,
          kind: 'action',
          group: 'schedule_actions',
          data: act,
        });
      }
    }

    if (showInbox) {
      const filteredInbox = inbox.filter((m) => {
        if (!state.includeNoise && m.is_noise) return false;
        if (state.todayChannel !== 'all' && m.channel !== state.todayChannel) return false;
        return true;
      });
      const capped = state.todayTab === 'priority' ? filteredInbox.slice(0, 24) : filteredInbox;
      for (const msg of capped) {
        rows.push({
          id: 'inbox:' + msg.id,
          kind: 'inbox',
          group: 'inbox',
          data: msg,
        });
      }
    }

    return rows;
  }

  function syncTodayFilterChrome() {
    $$('.triage-tab[data-triage-tab]').forEach((t) => {
      const active = t.dataset.triageTab === state.todayTab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('#today-channel-pills [data-ch]').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.ch === state.todayChannel);
    });
    const subbar = $('.triage-subbar');
    if (subbar) {
      subbar.hidden = state.todayTab === 'actions' || state.todayTab === 'schedule';
    }
  }

  function renderTodayTriageList() {
    const listEl = $('#triage-list');
    if (!listEl || !state.today) return;

    syncTodayFilterChrome();

    const rows = buildTodayTriageRows();
    state.todayRows = rows;

    const triageCountEl = $('#today-triage-count');
    if (triageCountEl) triageCountEl.textContent = String(rows.length);
    if (state.todayTab === 'priority' && state.todayChannel === 'all') {
      state.todayBaselineCount = rows.length;
      syncUnifiedCounters();
    }

    // Ensure selectedTodayId stays valid (allow direct meeting selection from Unified Day Timeline)
    const isDirectMeetingSelection =
      String(state.selectedTodayId || '').startsWith('meeting:') &&
      (state.today.schedule || []).some((ev) => 'meeting:' + ev.id === state.selectedTodayId);
    if (!isDirectMeetingSelection && !rows.some((r) => r.id === state.selectedTodayId)) {
      state.selectedTodayId = rows[0] ? rows[0].id : 'morning-brief';
    }

    const schedActRows = rows.filter((r) => r.group === 'schedule_actions');
    const inboxRows = rows.filter((r) => r.group === 'inbox');
    const summary = state.today.summary || {};

    const html = [];

    // Row #0: Morning Brief
    const briefSelected = state.selectedTodayId === 'morning-brief';
    const briefHeadline = stripEmDash(
      summary.day_title ||
        summary.date_label ||
        new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    );
    const openActCount = state.today.actions.filter((a) => !a.done).length;
    html.push(
      '<button type="button" class="triage-row is-briefing' +
        (briefSelected ? ' is-selected' : '') +
        '" role="option" aria-selected="' +
        (briefSelected ? 'true' : 'false') +
        '" data-kind="briefing" data-triage-id="morning-brief">' +
        '<div class="triage-row-top">' +
        '<span class="triage-row-title-wrap"><span class="triage-row-title">Morning Brief</span></span>' +
        '<span class="triage-row-time">' + escHtml(briefHeadline) + '</span>' +
        '</div>' +
        '<div class="triage-row-sub">' +
        '<span class="triage-row-preview">' +
        escHtml(
          state.today.schedule.length +
            ' events \u00b7 ' +
            openActCount +
            ' open actions \u00b7 ' +
            state.today.workstreams.length +
            ' workstreams'
        ) +
        '</span>' +
        '<span class="triage-row-meta"><span class="badge badge-neutral">Brief</span></span>' +
        '</div>' +
        '</button>'
    );

    if (schedActRows.length > 0) {
      html.push(
        '<div class="triage-group-label"><span>Schedule &amp; Actions</span><span class="tabular">' +
          schedActRows.length +
          '</span></div>'
      );

      for (const row of schedActRows) {
        const selected = state.selectedTodayId === row.id;
        if (row.kind === 'meeting') {
          const ev = row.data;
          const badgeHtml = ev.is_now
            ? '<span class="badge-now" style="white-space:nowrap;flex-shrink:0;">NOW</span>'
            : ev.countdown
            ? '<span class="badge-countdown" style="white-space:nowrap;flex-shrink:0;">' + escHtml(ev.countdown) + '</span>'
            : '<span class="triage-row-time" style="white-space:nowrap;flex-shrink:0;">' + escHtml(ev.time_label || 'Today') + '</span>';
          html.push(
            '<button type="button" class="triage-row is-schedule' +
              (selected ? ' is-selected' : '') +
              '" role="option" aria-selected="' +
              (selected ? 'true' : 'false') +
              '" data-kind="schedule" data-triage-id="' +
              escHtml(row.id) +
              '">' +
              '<div class="triage-row-top">' +
              '<span class="triage-row-title-wrap">' +
              '<span class="ch-dot ch-cal" aria-hidden="true"></span>' +
              '<span class="triage-row-title">' +
              escHtml((ev.time_label ? ev.time_label + ' \u00b7 ' : '') + ev.title) +
              '</span>' +
              '</span>' +
              badgeHtml +
              '</div>' +
              '<div class="triage-row-sub">' +
              '<span class="triage-row-preview">' +
              escHtml(ev.calendar + (ev.participants.length ? ' \u00b7 ' + ev.participants.slice(0, 2).join(', ') : '')) +
              '</span>' +
              '<span class="triage-row-meta"><span class="badge badge-neutral">Brief</span></span>' +
              '</div>' +
              '</button>'
          );
        } else if (row.kind === 'action') {
          const act = row.data;
          html.push(
            '<div class="triage-row is-action' +
              (selected ? ' is-selected' : '') +
              (act.done ? ' is-done' : '') +
              '" role="option" tabindex="0" aria-selected="' +
              (selected ? 'true' : 'false') +
              '" data-kind="action" data-triage-id="' +
              escHtml(row.id) +
              '">' +
              '<input type="checkbox" class="action-check" data-toggle-action="' +
              escHtml(act.id) +
              '" aria-label="Mark action ' +
              escHtml(act.title) +
              ' complete"' +
              (act.done ? ' checked' : '') +
              '>' +
              '<div class="triage-row-body">' +
              '<div class="triage-row-top">' +
              '<span class="triage-row-title">' + escHtml(act.title) + '</span>' +
              '<span class="badge badge-neutral">' + escHtml(act.tag || 'Work') + '</span>' +
              '</div>' +
              (act.detail
                ? '<div class="triage-row-sub"><span class="triage-row-preview">' +
                  escHtml(act.detail) +
                  '</span><span class="triage-row-time">' +
                  escHtml(act.done ? 'Done' : act.source || 'Open') +
                  '</span></div>'
                : '') +
              '</div>' +
              '</div>'
          );
        }
      }
    }

    if (inboxRows.length > 0 || state.todayTab === 'priority' || state.todayTab === 'all') {
      html.push(
        '<div class="triage-group-label"><span>Human Priority Inbox</span><span class="tabular">' +
          inboxRows.length +
          '</span></div>'
      );

      if (inboxRows.length === 0) {
        html.push('<div class="dir-empty">No inbox messages match this channel filter.</div>');
      } else {
        for (const row of inboxRows) {
          const msg = row.data;
          const selected = state.selectedTodayId === row.id;
          const ch = channelInfo(msg.channel);
          const age = msg.age || formatRelativeTime(msg.timestamp);
          const displayTitle =
            msg.title && msg.title.toLowerCase() !== msg.sender.toLowerCase()
              ? msg.sender + ' \u00b7 ' + msg.title
              : msg.sender;
          html.push(
            '<button type="button" class="triage-row is-inbox' +
              (selected ? ' is-selected' : '') +
              (msg.is_noise ? ' is-noise' : '') +
              '" role="option" aria-selected="' +
              (selected ? 'true' : 'false') +
              '" data-kind="inbox" data-triage-id="' +
              escHtml(row.id) +
              '">' +
              '<div class="triage-row-top">' +
              '<span class="triage-row-title-wrap">' +
              '<span class="ch-dot ' + escHtml(ch.dot) + '" aria-hidden="true"></span>' +
              '<span class="triage-row-title">' + escHtml(displayTitle) + '</span>' +
              '</span>' +
              '<span class="triage-row-time tabular">' + escHtml(age) + '</span>' +
              '</div>' +
              '<div class="triage-row-sub">' +
              '<span class="triage-row-preview">' + escHtml(msg.snippet || msg.body.slice(0, 96)) + '</span>' +
              '<span class="triage-row-meta"><span class="badge badge-neutral">' + escHtml(msg.is_noise ? 'Noise' : ch.short) + '</span></span>' +
              '</div>' +
              '</button>'
          );
        }
      }
    }

    listEl.innerHTML = html.join('');
    updateTriagePositionCounter();
  }

  function updateTriagePositionCounter() {
    const posEl = $('#triage-pos-counter');
    if (!posEl) return;
    const idx = state.todayRows.findIndex((r) => r.id === state.selectedTodayId);
    const total = Math.max(1, state.todayRows.length);
    posEl.textContent = (idx >= 0 ? idx + 1 : 1) + ' / ' + total;
  }

  function getSelectedTodayRow() {
    const direct = state.todayRows.find((r) => r.id === state.selectedTodayId);
    if (direct) return direct;
    if (state.today && String(state.selectedTodayId || '').startsWith('meeting:')) {
      const targetId = String(state.selectedTodayId).slice('meeting:'.length);
      const ev = (state.today.schedule || []).find((item) => String(item.id) === targetId);
      if (ev) return { id: 'meeting:' + ev.id, kind: 'meeting', group: 'schedule_actions', data: ev };
    }
    return { id: 'morning-brief', kind: 'brief' };
  }

  function selectTodayRow(rowId, { openMobileDetail = false } = {}) {
    state.selectedTodayId = rowId;
    setMobileComposerExpanded(false);

    const listEl = $('#triage-list');
    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(rowId) : String(rowId).replace(/"/g, '\\"');
    let activeEl = listEl ? $('[data-triage-id="' + escapedId + '"]', listEl) : null;

    if (activeEl && listEl) {
      // O(1) selection sync without destroying #triage-list DOM on J/K keypresses
      const prevSelected = $$('.triage-row.is-selected', listEl);
      for (const prev of prevSelected) {
        if (prev !== activeEl) {
          prev.classList.remove('is-selected');
          prev.setAttribute('aria-selected', 'false');
        }
      }
      activeEl.classList.add('is-selected');
      activeEl.setAttribute('aria-selected', 'true');
      updateTriagePositionCounter();
    } else {
      renderTodayTriageList();
      activeEl = listEl ? $('[data-triage-id="' + escapedId + '"]', listEl) : null;
    }

    renderTodayDetailPane();
    if (openMobileDetail && isMobileViewport()) {
      setTodayMobileDetail(true);
    }
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  function moveTodaySelection(delta) {
    if (state.todayRows.length === 0) return;
    const curIdx = state.todayRows.findIndex((r) => r.id === state.selectedTodayId);
    const nextIdx =
      curIdx === -1
        ? 0
        : Math.max(0, Math.min(state.todayRows.length - 1, curIdx + delta));
    selectTodayRow(state.todayRows[nextIdx].id, { openMobileDetail: false });
  }

  function normalizeCardCompareText(raw) {
    return stripEmDash(String(raw || ''))
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function polishBoardThreadCards(container, kind) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const rows = container.querySelectorAll('.kbw-thread-row');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const titleEl = row.querySelector('.kbw-thread-title');
      const excerptEl = row.querySelector('.kbw-thread-excerpt');
      const roomEl = row.querySelector('.kbw-room-tag');
      const replyEl = row.querySelector('.kbw-reply-count');
      const statusEl = row.querySelector('.kbw-status-pill');

      const titleText = titleEl ? titleEl.textContent.trim() : '';
      const excerptText = excerptEl ? excerptEl.textContent.trim() : '';
      const normTitle = normalizeCardCompareText(titleText);
      const normExcerpt = normalizeCardCompareText(excerptText);
      const isDuplicate =
        !normExcerpt ||
        normExcerpt === normTitle ||
        (normTitle.length >= 12 && normExcerpt.startsWith(normTitle) && normExcerpt.length - normTitle.length < 18) ||
        (normExcerpt.length >= 12 && normTitle.startsWith(normExcerpt));

      if (isDuplicate) {
        const room = roomEl ? roomEl.textContent.trim() : '#box';
        const replies = replyEl ? replyEl.textContent.trim() : '';
        const status = statusEl ? statusEl.textContent.trim().toLowerCase() : '';
        let replacement = '';
        if (kind === 'mission') {
          if (status.includes('block')) {
            replacement = 'Next step: Review blocker and record decision in ' + room + (replies ? ' (' + replies + ')' : '') + '.';
          } else {
            replacement = 'Next step: Inspect latest agent update in ' + room + (replies ? ' (' + replies + ')' : '') + '.';
          }
        } else {
          const metaParts = [room, replies].filter(Boolean);
          replacement = metaParts.length > 0 ? 'Active discussion in ' + metaParts.join(' \u00b7 ') : '';
        }
        if (excerptEl) {
          if (replacement) {
            excerptEl.textContent = replacement;
            excerptEl.classList.add('is-recommendation');
          } else {
            excerptEl.remove();
          }
        } else if (replacement && kind === 'mission') {
          const added = document.createElement('div');
          added.className = 'kbw-thread-excerpt is-recommendation';
          added.textContent = replacement;
          const topEl = row.querySelector('.kbw-thread-top');
          if (topEl && topEl.parentNode) {
            topEl.parentNode.insertBefore(added, topEl.nextSibling);
          }
        }
      }
    }
  }

  function observeAndPolishBoardCards(container, kind) {
    if (!container) return;
    polishBoardThreadCards(container, kind);
    if (typeof MutationObserver === 'function') {
      const obs = new MutationObserver(() => {
        polishBoardThreadCards(container, kind);
      });
      obs.observe(container, { childList: true, subtree: true });
      setTimeout(() => {
        try { obs.disconnect(); } catch (_) {}
      }, 8000);
    }
  }

  function renderTodayDetailPane() {
    const bodyEl = $('#detail-body');
    const crumbEl = $('#detail-breadcrumb');
    const primaryBtn = $('#btn-detail-primary');
    const ctxLabel = $('#composer-context-label');
    if (!bodyEl || !state.today) return;

    const row = getSelectedTodayRow();
    $('#composer-output').hidden = true;

    if (row.kind === 'brief') {
      if (crumbEl) {
        crumbEl.innerHTML =
          '<span class="breadcrumb-parent">Today</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">Morning Brief</span>';
      }
      if (primaryBtn) primaryBtn.textContent = 'Open Vault';
      if (ctxLabel) ctxLabel.textContent = 'Morning Brief';
      bodyEl.innerHTML = buildMorningBriefHtml();

      const radarSlot = $('#today-radar-slot', bodyEl);
      if (radarSlot && window.KizukiSlots && typeof window.KizukiSlots.mount === 'function') {
        window.KizukiSlots.mount('today-radar', radarSlot, {
          todayData: state.today,
          nextMoves: state.todayNextMoves,
          switchView,
          openChatModal,
          openPerson: (key) => {
            if (!key) return;
            if (!state.peopleLoaded) loadPeople();
            openPersonDossier(key, { jumpView: true, openMobileDetail: true });
          },
          reloadToday: () => loadToday({ silent: true }),
        });
      }

      const pulsePayload = Object.assign({}, state.today, { schedule: [] });
      window.KizukiKineticOs?.mountTodaySystemPulse($('#today-system-pulse-slot', bodyEl), pulsePayload, {
        openBoard: (opts) => switchView('board', opts),
      });
      const boardSlot = $('#today-board-section', bodyEl);
      if (boardSlot && window.KizukiBoardWidgets && typeof window.KizukiBoardWidgets.mountTodayPulse === 'function') {
        const mountRes = window.KizukiBoardWidgets.mountTodayPulse(boardSlot, {
          openBoard: (opts = {}) => switchView('board', opts),
          openPerson: (key) => {
            if (!key) return;
            if (!state.peopleLoaded) loadPeople();
            openPersonDossier(key, { jumpView: true, openMobileDetail: true });
          },
          openDoc: (docPath) => {
            if (docPath) openVaultDoc(docPath);
          },
          openView: openBoardMindView,
          showToast: (msg, tone) => showToast(msg, tone || 'info'),
        });
        observeAndPolishBoardCards(boardSlot, 'mission');
        if (mountRes && typeof mountRes.then === 'function') {
          mountRes.then(() => polishBoardThreadCards(boardSlot, 'mission')).catch(() => {});
        }
      }
      if (window.KizukiMotion && typeof window.KizukiMotion.enterStagger === 'function') {
        window.KizukiMotion.enterStagger(bodyEl, '.brief-hero, .today-radar-slot > *, .brief-section');
      }
      return;
    }

    if (row.kind === 'meeting') {
      const ev = row.data;
      if (crumbEl) {
        crumbEl.innerHTML =
          '<span class="breadcrumb-parent">Calendar</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">' +
          escHtml(ev.calendar) +
          '</span>';
      }
      if (primaryBtn) primaryBtn.textContent = 'Prep Brief';
      if (ctxLabel) ctxLabel.textContent = ev.title;
      bodyEl.innerHTML = buildMeetingDetailHtml(ev);
      return;
    }

    if (row.kind === 'inbox') {
      const msg = row.data;
      const ch = channelInfo(msg.channel);
      if (crumbEl) {
        crumbEl.innerHTML =
          '<span class="breadcrumb-parent">' +
          escHtml(ch.label) +
          '</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">' +
          escHtml(msg.sender) +
          '</span>';
      }
      if (primaryBtn) primaryBtn.textContent = 'Generate Draft';
      if (ctxLabel) ctxLabel.textContent = ch.short + ': ' + msg.sender;
      bodyEl.innerHTML = buildInboxDetailHtml(msg);
      return;
    }

    if (row.kind === 'action') {
      const act = row.data;
      if (crumbEl) {
        crumbEl.innerHTML =
          '<span class="breadcrumb-parent">Actions</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">' +
          escHtml(act.tag || 'Task') +
          '</span>';
      }
      if (primaryBtn) primaryBtn.textContent = 'Ask Next Steps';
      if (ctxLabel) ctxLabel.textContent = act.title;
      bodyEl.innerHTML = buildActionDetailHtml(act);
    }
  }

  function buildMorningBriefHtml() {
    const t = state.today;
    const s = t.summary || {};
    const pulseVault = (state.pulse && state.pulse.vault) || (state.overview && state.overview.vault) || {};

    const dateHeading = stripEmDash(
      s.day_title ||
        s.date_heading ||
        new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + '.'
    );
    const pipesActive = s.active_pipelines ?? s.pipelines_active ?? pulseVault.pipelines_active ?? 17;
    const pipesTotal = s.total_pipelines ?? s.pipelines_total ?? pulseVault.pipelines_total ?? 19;
    const eventsTotal = getCanonicalEventsTotal() ?? s.events_total ?? pulseVault.events_total ?? 138500;
    const docsTotal = s.docs_total ?? state.vaultTotal ?? 16928;
    const memtCount = s.memt_verified ?? 14;

    const statusLine =
      pipesActive +
      '/' +
      pipesTotal +
      ' pipelines \u00b7 ' +
      formatCompact(eventsTotal) +
      ' events \u00b7 ' +
      formatCompact(docsTotal) +
      ' docs';

    // Workstreams GFM Table
    let workstreamsHtml = '<p class="panel-subtitle">No active workstreams returned yet.</p>';
    if (t.workstreams.length > 0) {
      const rowsHtml = t.workstreams
        .slice(0, 10)
        .map((w) => {
          const name = stripEmDash(w.name || w.title || 'Workstream');
          const domain = stripEmDash(w.domain || 'General');
          const stText = stripEmDash(w.state || w.status || 'Active');
          const stLower = stText.toLowerCase();
          const stClass = stLower.includes('motion') || stLower.includes('progress')
            ? 'is-motion'
            : stLower.includes('block')
            ? 'is-blocked'
            : stLower.includes('warn') || stLower.includes('stale') || stLower.includes('pending')
            ? 'is-attention'
            : 'is-active';
          const ctxText = stripEmDash(w.context || w.summary || '');
          const nextStep = stripEmDash(w.next_move || w.next_action || w.next || '');
          return (
            '<tr>' +
            '<td data-label="Workstream"><strong>' + escHtml(name) + '</strong><div class="panel-subtitle">' + escHtml(domain) + '</div></td>' +
            '<td data-label="State"><span class="status-pill ' + stClass + '"><span class="status-dot" aria-hidden="true"></span>' + escHtml(stText) + '</span></td>' +
            '<td data-label="Context">' + escHtml(ctxText || 'Active') + '</td>' +
            '<td data-label="Next Move"><span class="workstream-next-move">' + escHtml(nextStep || 'Track') + '</span></td>' +
            '</tr>'
          );
        })
        .join('');
      workstreamsHtml =
        '<div class="md-table-wrap"><table class="gfm-table brief-workstreams-table">' +
        '<thead><tr><th>Workstream</th><th>State</th><th>Context</th><th>Next Move</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody></table></div>';
    }

    // What Needs You Now interactive checklist (2-way synced with Pane 2!)
    const checklistHtml =
      t.actions.length === 0
        ? '<p class="panel-subtitle">No open actions. Press A or + Action to add one.</p>'
        : '<div class="detail-checklist">' +
          t.actions
            .slice(0, 12)
            .map((a) => {
              return (
                '<div class="check-row' +
                (a.done ? ' is-done' : '') +
                '">' +
                '<label class="check-row-left">' +
                '<input type="checkbox" class="action-check" data-toggle-action="' +
                escHtml(a.id) +
                '"' +
                (a.done ? ' checked' : '') +
                '>' +
                '<span class="check-label">' + escHtml(a.title) + '</span>' +
                '</label>' +
                '<span class="check-meta">' +
                '<span class="badge badge-neutral">' + escHtml(a.tag || 'Work') + '</span>' +
                (a.done
                  ? '<button type="button" class="btn-ghost btn-xs" data-toggle-action-btn="' + escHtml(a.id) + '">Reopen</button>'
                  : '<button type="button" class="btn-ghost btn-xs" data-select-today="action:' + escHtml(a.id) + '">Open</button>') +
                '</span>' +
                '</div>'
              );
            })
            .join('') +
          '</div>';

    // Pinned People Dossiers
    const peopleHtml =
      t.people_radar.length === 0
        ? '<p class="panel-subtitle">No recent cross-channel contacts indexed.</p>'
        : '<div class="brief-people-grid">' +
          t.people_radar
            .slice(0, 8)
            .map((p) => {
              const chs = Array.isArray(p.channels) ? p.channels : [];
              const dots = chs
                .slice(0, 4)
                .map((c) => '<span class="ch-dot ' + escHtml(channelInfo(c).dot) + '" title="' + escHtml(channelInfo(c).label) + '"></span>')
                .join('');
              return (
                '<button type="button" class="brief-person-card" data-open-person="' +
                escHtml(p.key || p.name) +
                '">' +
                '<span class="person-avatar is-sm">' + escHtml(p.initials || initialsForName(p.name)) + '</span>' +
                '<span class="person-row-main">' +
                '<span class="person-row-name">' + escHtml(stripEmDash(p.name)) + '</span>' +
                '<span class="person-row-sub">' + escHtml(stripEmDash(p.preview || p.last_snippet || formatHistoricalLastSeen(p) || 'Open dossier')) + '</span>' +
                '</span>' +
                '<span class="person-ch-dots">' + dots + '</span>' +
                '</button>'
              );
            })
            .join('') +
          '</div>';

    // Owner Anchors
    const anchorsHtml = t.owner_anchors
      ? '<div class="detail-brief-card markdown-prose">' + renderMarkdownHtml(t.owner_anchors) + '</div>'
      : '<p class="panel-subtitle">No owner-anchors.md found yet. Click Edit Anchors to create one.</p>';

    // Whoop Telemetry: fresh (<=48h) shows radial arc pod; stale (>48h) demotes to quiet single-line footnote
    let whoopPodHtml = '';
    let staleSensorFootnoteHtml = '';
    if (t.whoop) {
      const w = t.whoop;
      const rec = w.recovery_pct ?? w.recovery;
      const hrv = w.hrv_ms ?? w.hrv;
      const sleep = w.sleep_hours ?? w.sleep;
      const rhr = w.rhr_bpm ?? w.rhr;
      const shortDate = w.date_label || formatShortDate(w.date);
      let ageDays = w.age_days !== undefined && w.age_days !== null ? Number(w.age_days) : null;
      if (ageDays === null && w.date) {
        const wd = new Date(w.date);
        if (!Number.isNaN(wd.getTime())) ageDays = (Date.now() - wd.getTime()) / 86400000;
      }
      const isStale = Boolean(w.is_stale) || (ageDays !== null && Number.isFinite(ageDays) && ageDays > 2);
      if (isStale) {
        const dateLabel = shortDate && shortDate !== '--' ? shortDate : 'earlier';
        staleSensorFootnoteHtml =
          '<p class="brief-sensor-footnote">Whoop last synced ' + escHtml(dateLabel) + ' (stale)</p>';
      } else if (
        window.KizukiCharts &&
        typeof window.KizukiCharts.renderWhoopGaugeSvg === 'function' &&
        ((rec !== undefined && rec !== null) || (hrv !== undefined && hrv !== null) || (sleep !== undefined && sleep !== null))
      ) {
        const gaugeSvg = window.KizukiCharts.renderWhoopGaugeSvg({
          recovery: rec,
          hrv: hrv,
          sleepHours: sleep,
          rhr: rhr,
          size: 76,
          hideSubRow: true,
        });
        const headerLabel = shortDate && shortDate !== '--' ? 'Whoop \u00b7 ' + shortDate : 'Whoop';
        const readoutParts = [];
        if (hrv !== undefined && hrv !== null) readoutParts.push('<span><strong>' + escHtml(String(Math.round(Number(hrv)))) + '</strong>ms HRV</span>');
        if (sleep !== undefined && sleep !== null) readoutParts.push('<span><strong>' + escHtml(String(Number(sleep).toFixed(1))) + '</strong>h Sleep</span>');
        if (readoutParts.length < 2 && rhr !== undefined && rhr !== null) {
          readoutParts.push('<span><strong>' + escHtml(String(Math.round(Number(rhr)))) + '</strong> RHR</span>');
        }
        whoopPodHtml =
          '<div class="brief-whoop-pod" style="display:flex;align-items:center;gap:10px;flex-shrink:0;padding:8px 12px;border-radius:var(--r-md);border:1px solid var(--border-hairline);background:var(--surface-raised);" aria-label="Whoop recovery gauge">' +
          gaugeSvg +
          (readoutParts.length > 0
            ? '<div class="brief-whoop-readout tabular" style="display:flex;flex-direction:column;gap:3px;font-family:var(--font-mono);font-size:var(--t-xs);color:var(--ink-secondary);line-height:1.35;">' +
              '<span style="font-size:var(--t-xs);letter-spacing:0.05em;text-transform:uppercase;color:var(--ink-muted);">' + escHtml(headerLabel) + '</span>' +
              readoutParts.join('') +
              '</div>'
            : '') +
          '</div>';
      }
    }

    // Crisp 2-line Editorial Lede from Contract C2 (/api/today/next-moves) with concise fallback
    let briefLedeHtml = '';
    const nm = state.todayNextMoves;
    if (nm && typeof nm.lede === 'string' && nm.lede.trim()) {
      briefLedeHtml = escHtml(stripEmDash(nm.lede.trim()));
    } else if (nm && Array.isArray(nm.moves) && nm.moves.length > 0) {
      const topMove = nm.moves[0];
      const topTitle = stripEmDash(topMove.title || '').trim();
      const topWhy = stripEmDash(topMove.why_now || '').trim();
      const restCount = Math.max(0, nm.moves.length - 1);
      briefLedeHtml =
        '<strong>' + escHtml(topTitle || 'Top priority') + '</strong>' +
        (topWhy ? ': ' + escHtml(topWhy) : '') +
        (restCount > 0 ? ' Plus ' + escHtml(String(restCount)) + ' more ranked ' + (restCount === 1 ? 'move' : 'moves') + ' below.' : '');
    } else {
      const nextMeeting = (t.schedule || []).find((ev) => ev.is_now) || (t.schedule || [])[0] || null;
      const openActionsCount = t.actions.filter((a) => !a.done).length;
      const topWorkstream = t.workstreams[0] ? stripEmDash(t.workstreams[0].name || t.workstreams[0].title || '') : '';
      const ledeParts = [];
      if (nextMeeting) {
        ledeParts.push(
          (nextMeeting.is_now ? 'Live now: ' : 'Next up: ') +
            '<strong>' + escHtml(stripEmDash(nextMeeting.title)) + '</strong>' +
            (nextMeeting.time_label ? ' (' + escHtml(nextMeeting.time_label) + ')' : '')
        );
      } else {
        ledeParts.push('Calendar is clear ahead');
      }
      if (openActionsCount > 0) {
        ledeParts.push('<strong>' + escHtml(String(openActionsCount)) + ' open ' + (openActionsCount === 1 ? 'action' : 'actions') + '</strong> awaiting execution');
      } else if (topWorkstream) {
        ledeParts.push('leading workstream <strong>' + escHtml(topWorkstream) + '</strong>');
      }
      briefLedeHtml = ledeParts.join('. ') + '.';
    }

    // Unified Today Day Timeline (each calendar event rendered ONCE on Today)
    let unifiedTimelineHtml = '';
    if (Array.isArray(t.schedule) && t.schedule.length > 0) {
      const seenEventIds = new Set();
      const uniqueSchedule = [];
      for (const ev of t.schedule) {
        const eid = String(ev.id || (ev.title + '|' + (ev.start || ev.time_label || '')));
        if (seenEventIds.has(eid)) continue;
        seenEventIds.add(eid);
        uniqueSchedule.push(ev);
      }
      unifiedTimelineHtml =
        '<section class="brief-section" id="today-day-timeline" aria-label="Today Day Timeline">' +
        '<div class="brief-section-head">' +
        '<h3 class="brief-section-title">Day Timeline</h3>' +
        '<span class="brief-section-meta tabular">' + escHtml(String(uniqueSchedule.length)) + (uniqueSchedule.length === 1 ? ' event' : ' events') + '</span>' +
        '</div>' +
        '<div class="today-timeline-list">' +
        uniqueSchedule
          .map((ev) => {
            const isNow = Boolean(ev.is_now);
            const badgeHtml = isNow
              ? '<span class="badge-now">LIVE NOW</span>'
              : ev.countdown
              ? '<span class="badge-countdown">' + escHtml(ev.countdown) + '</span>'
              : '';
            const metaParts = [
              ev.calendar ? stripEmDash(ev.calendar) : '',
              Array.isArray(ev.participants) && ev.participants.length > 0
                ? ev.participants.slice(0, 3).map((p) => (typeof p === 'string' ? p : p.name || p.email || '')).filter(Boolean).join(', ')
                : '',
            ].filter(Boolean);
            return (
              '<button type="button" class="today-timeline-item' + (isNow ? ' is-now' : '') + '" data-select-today="meeting:' + escHtml(ev.id) + '" data-event-id="' + escHtml(ev.id) + '">' +
              '<span class="today-timeline-time tabular">' + escHtml(ev.time_label || formatRelativeTime(ev.start) || 'Scheduled') + '</span>' +
              '<span class="today-timeline-main">' +
              '<span class="today-timeline-title">' + escHtml(stripEmDash(ev.title)) + '</span>' +
              (metaParts.length > 0 ? '<span class="today-timeline-meta">' + escHtml(metaParts.join(' \u00b7 ')) + '</span>' : '') +
              '</span>' +
              '<span class="today-timeline-right">' + badgeHtml + '</span>' +
              '</button>'
            );
          })
          .join('') +
        '</div>' +
        '</section>';
    }

    const openActionItems = t.actions.filter((a) => !a.done);
    const actionsSectionHtml =
      t.actions.length > 0
        ? '<section class="brief-section">' +
          '<div class="brief-section-head"><h3 class="brief-section-title">What Needs You Now</h3><span class="brief-section-meta tabular">' +
          openActionItems.length +
          ' open \u00b7 ' +
          t.actions.filter((a) => a.done).length +
          ' done</span></div>' +
          checklistHtml +
          '</section>'
        : '';

    return (
      '<div class="detail-inner">' +
      '<header class="brief-hero">' +
      '<div class="brief-eyebrow">' +
      '<span class="brief-eyebrow-left"><span class="status-dot" aria-hidden="true"></span>Personal Mind OS Brief</span>' +
      '<span class="tabular">' + escHtml(statusLine) + '</span>' +
      '</div>' +
      '<div class="brief-hero-row" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;position:relative;z-index:1;">' +
      '<div class="brief-hero-main" style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:8px;">' +
      '<h2 class="brief-title">' + escHtml(dateHeading) + '</h2>' +
      '<p class="brief-lede">' + briefLedeHtml + '</p>' +
      '</div>' +
      whoopPodHtml +
      '</div>' +
      '</header>' +
      '<div id="today-radar-slot" class="today-radar-slot" data-slot="today-radar"></div>' +
      unifiedTimelineHtml +
      '<div id="today-system-pulse-slot" class="kos-pulse-slot"></div>' +
      '<section class="brief-section" id="today-board-section" data-board-widget="today-pulse"></section>' +
      '<section class="brief-section">' +
      '<div class="brief-section-head"><h3 class="brief-section-title">Active Workstreams</h3><span class="brief-section-meta tabular">' +
      t.workstreams.length +
      ' tracked</span></div>' +
      workstreamsHtml +
      '</section>' +
      actionsSectionHtml +
      '<section class="brief-section">' +
      '<div class="brief-section-head"><h3 class="brief-section-title">Pinned People Dossiers</h3>' +
      '<button type="button" class="btn-ghost btn-xs" data-nav-jump="people">All People &rarr;</button></div>' +
      peopleHtml +
      '</section>' +
      '<section class="brief-section">' +
      '<div class="brief-section-head"><h3 class="brief-section-title">Owner Anchors</h3>' +
      '<button type="button" class="btn-secondary btn-xs" data-edit-anchors="true">Edit Anchors</button></div>' +
      anchorsHtml +
      '</section>' +
      staleSensorFootnoteHtml +
      '</div>'
    );
  }

  function buildMeetingDetailHtml(ev) {
    const cached = state.meetingBriefCache.get(ev.id);
    const statusBadge = ev.is_now
      ? '<span class="badge-now">LIVE NOW</span>'
      : ev.countdown
      ? '<span class="badge-countdown">' + escHtml(ev.countdown) + '</span>'
      : '<span class="badge badge-blue">Scheduled</span>';

    const participantsHtml =
      ev.participants.length > 0
        ? '<div class="context-chips">' +
          ev.participants
            .map((p) => {
              const name = typeof p === 'string' ? p : (p.name || p.email || '');
              const key = typeof p === 'object' && p.key ? p.key : name;
              return (
                '<button type="button" class="ctx-chip" data-open-person="' +
                escHtml(key) +
                '">' +
                escHtml(name) +
                '</button>'
              );
            })
            .join('') +
          '</div>'
        : '';

    const isPrepLoading = state.inFlightPrepId === ev.id;
    const briefBlock = cached
      ? '<div class="detail-brief-card">' +
        '<div class="detail-section-head">' +
        '<span class="badge badge-cyan">' + escHtml(cached.engine || 'Local Prep Brief') + '</span>' +
        '<div class="composer-actions">' +
        (cached.latency_ms !== undefined ? '<span class="detail-section-meta tabular">' + escHtml(formatLatency(cached.latency_ms)) + '</span>' : '') +
        '<button type="button" class="btn-ghost btn-xs" data-copy-text="' + escHtml(cached.md) + '">Copy Brief</button>' +
        '</div>' +
        '</div>' +
        '<div class="markdown-prose">' + renderMarkdownHtml(cached.md) + '</div>' +
        '</div>'
      : '<div class="detail-brief-card">' +
        '<p class="brief-prose">Synthesize cross-channel context (WhatsApp, Gmail, iMessage, Obsidian, Apple Notes, MemT) into a structured GFM meeting prep table.</p>' +
        '<div><button type="button" class="btn-secondary btn-sm" data-run-meeting-prep="' + escHtml(ev.id) + '"' + (isPrepLoading ? ' disabled' : '') + '>' + (isPrepLoading ? 'Generating Prep Brief...' : 'Generate AI Meeting Prep Brief') + '</button></div>' +
        '</div>';

    const relMsgsHtml =
      ev.related_messages.length > 0
        ? '<section class="detail-section"><div class="detail-section-head"><h3 class="detail-kicker">Related Messages</h3></div>' +
          '<div class="thread-messages">' +
          ev.related_messages
            .slice(0, 6)
            .map((m) => {
              const ch = channelInfo(m.channel);
              return (
                '<div class="thread-msg">' +
                '<div class="thread-msg-head">' +
                '<span class="thread-msg-sender"><span class="ch-dot ' + escHtml(ch.dot) + '"></span>' + escHtml(stripEmDash(m.sender || ch.label)) + '</span>' +
                '<span class="thread-msg-time">' + escHtml(formatRelativeTime(m.timestamp || m.occurred_at)) + '</span>' +
                '</div>' +
                '<div class="thread-msg-body">' + escHtml(stripEmDash(m.snippet || m.preview || m.text || '')) + '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div></section>'
        : '';

    const relDocsHtml =
      ev.related_docs.length > 0
        ? '<section class="detail-section"><div class="detail-section-head"><h3 class="detail-kicker">Related Vault &amp; Notes Docs</h3></div>' +
          '<div class="related-docs-list">' +
          ev.related_docs
            .slice(0, 6)
            .map((d) => {
              const p = typeof d === 'string' ? d : (d.path || '');
              const title = typeof d === 'string' ? titleFromPath(d) : (d.title || titleFromPath(p));
              return (
                '<button type="button" class="related-doc-item" data-open-doc="' + escHtml(p) + '">' +
                '<span>' + escHtml(title) + '</span>' +
                '<span class="related-doc-path">' + escHtml(d.category || '.md') + '</span>' +
                '</button>'
              );
            })
            .join('') +
          '</div></section>'
        : '';

    const meetUrl = extractMeetUrl(ev.meet_url, (ev.location || '') + '\n' + (ev.raw_text || ev.body || ev.description || ''));
    const meetJoinHtml = meetUrl
      ? '<div class="meet-join-bar">' +
        '<a class="btn-meet-join" href="' + escHtml(meetUrl) + '" target="_blank" rel="noopener noreferrer">Join Google Meet</a>' +
        (ev.dial_in ? '<span class="meet-join-meta meet-dial-in tabular">' + escHtml(ev.dial_in) + '</span>' : '') +
        '</div>'
      : '';
    const cleanedBody = cleanMeetingBody(ev.body || ev.description, ev.title);
    const cleanLocation = ev.location && !/^https:\/\/meet\.google\.com\//i.test(ev.location.trim()) ? ev.location : '';

    return (
      '<div class="detail-inner">' +
      '<div class="detail-hero">' +
      '<div class="detail-title-row">' +
      '<h2 class="detail-title">' + escHtml(ev.title) + '</h2>' +
      statusBadge +
      '</div>' +
      '<div class="detail-meta-bar tabular">' +
      '<span class="meta-item">' + escHtml(ev.time_label || formatRelativeTime(ev.start) || 'Scheduled') + '</span>' +
      '<span>\u00b7</span>' +
      '<span class="meta-item">Calendar: ' + escHtml(ev.calendar) + '</span>' +
      (cleanLocation ? '<span>\u00b7</span><span class="meta-item">' + escHtml(cleanLocation) + '</span>' : '') +
      '</div>' +
      meetJoinHtml +
      participantsHtml +
      (cleanedBody ? '<div class="detail-brief-card markdown-prose">' + renderMarkdownHtml(cleanedBody) + '</div>' : '') +
      '</div>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">AI Meeting Prep Brief</h3>' +
      (cached ? '<button type="button" class="btn-ghost btn-xs" data-run-meeting-prep="' + escHtml(ev.id) + '">Regenerate</button>' : '') +
      '</div>' +
      briefBlock +
      '</section>' +
      relMsgsHtml +
      relDocsHtml +
      '</div>'
    );
  }

  function buildInboxDetailHtml(msg) {
    const ch = channelInfo(msg.channel);
    const cached = state.inboxDraftCache.get(msg.id);
    const personKey = msg.person_key || msg.sender;

    const isDraftLoading = state.inFlightDraftId === msg.id;
    const draftBlock = cached
      ? '<div class="detail-brief-card">' +
        '<div class="detail-section-head">' +
        '<div class="composer-actions">' +
        '<span class="badge badge-cyan">' + escHtml(cached.engine || 'Local Draft Reply') + '</span>' +
        '<span class="badge badge-neutral">Local only</span>' +
        '</div>' +
        '<button type="button" class="btn-ghost btn-xs" data-copy-text="' + escHtml(cached.md) + '">Copy Draft</button>' +
        '</div>' +
        '<div class="markdown-prose">' + renderMarkdownHtml(cached.md) + '</div>' +
        '</div>'
      : '<div class="detail-brief-card">' +
        '<p class="brief-prose">Draft a grounded reply locally using your cross-channel history and vault memory. Never sends outbound.</p>' +
        '<div><button type="button" class="btn-secondary btn-sm" data-run-inbox-draft="' + escHtml(msg.id) + '"' + (isDraftLoading ? ' disabled' : '') + '>' + (isDraftLoading ? 'Drafting Local Reply...' : 'Generate Local Draft Reply') + '</button></div>' +
        '</div>';

    return (
      '<div class="detail-inner">' +
      '<div class="detail-hero">' +
      '<div class="detail-title-row">' +
      '<h2 class="detail-title">' + escHtml(msg.title || msg.subject || msg.sender) + '</h2>' +
      '<span class="badge badge-neutral"><span class="ch-dot ' + escHtml(ch.dot) + '"></span>' + escHtml(ch.label) + '</span>' +
      '</div>' +
      '<div class="detail-meta-bar">' +
      '<button type="button" class="btn-ghost btn-xs" data-open-person="' + escHtml(personKey) + '">' + escHtml(msg.sender) + ' (Open Dossier \u2192)</button>' +
      '<span>\u00b7</span>' +
      '<span class="tabular">' + escHtml(msg.age || formatRelativeTime(msg.timestamp) || 'Recent') + '</span>' +
      (msg.message_count > 1 ? '<span>\u00b7</span><span class="tabular">' + msg.message_count + ' messages</span>' : '') +
      (msg.is_noise ? '<span class="badge badge-amber">Noise / Promo</span>' : '') +
      '</div>' +
      '</div>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Message Content</h3></div>' +
      '<div class="detail-brief-card markdown-prose">' + renderMarkdownHtml(msg.body || msg.snippet || 'No message body.') + '</div>' +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Local Draft Reply</h3></div>' +
      draftBlock +
      '</section>' +
      '</div>'
    );
  }

  function buildActionDetailHtml(act) {
    return (
      '<div class="detail-inner">' +
      '<div class="detail-hero">' +
      '<div class="detail-title-row">' +
      '<label class="check-row-left">' +
      '<input type="checkbox" class="action-check" data-toggle-action="' + escHtml(act.id) + '"' + (act.done ? ' checked' : '') + '>' +
      '<h2 class="detail-title' + (act.done ? ' is-done' : '') + '">' + escHtml(act.title) + '</h2>' +
      '</label>' +
      '<span class="badge ' + (act.done ? 'badge-cyan' : 'badge-amber') + '">' + (act.done ? 'Done' : 'Open') + '</span>' +
      '</div>' +
      '<div class="detail-meta-bar">' +
      '<span class="badge badge-neutral">' + escHtml(act.tag || 'Work') + '</span>' +
      '<span>\u00b7</span>' +
      '<span>Source: ' + escHtml(act.source || 'Owner') + '</span>' +
      (act.updated_at ? '<span>\u00b7</span><span class="tabular">' + escHtml(formatRelativeTime(act.updated_at)) + '</span>' : '') +
      '</div>' +
      '</div>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Action Detail</h3></div>' +
      '<div class="detail-brief-card markdown-prose">' +
      renderMarkdownHtml(act.detail || 'No extra detail recorded yet. Use Ask Mind below to break down concrete next steps.') +
      '</div>' +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-actions">' +
      '<button type="button" class="btn-secondary btn-sm" data-toggle-action-btn="' + escHtml(act.id) + '">' +
      (act.done ? 'Reopen Action' : 'Mark Complete') +
      '</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-board-dispatch-action="' + escHtml(act.id) + '">Dispatch to Board</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-ask-action-steps="' + escHtml(act.id) + '">Ask Mind for Next Steps</button>' +
      '<button type="button" class="btn-ghost btn-sm" data-delete-action="' + escHtml(act.id) + '">Delete Action</button>' +
      '</div>' +
      '</section>' +
      '</div>'
    );
  }

  // Actions CRUD (POST /api/actions)
  async function mutateAction(payload) {
    try {
      const res = await apiPost('/api/actions', payload);
      if (res.ok === false) {
        showToast(res.error || 'Action update failed.', 'error');
        return null;
      }
      if (state.today && Array.isArray(res.actions)) {
        state.today.actions = res.actions.map((a, idx) => ({
          id: String(a.id || 'act-' + idx),
          title: stripEmDash(a.title || a.text || 'Untitled action'),
          detail: stripEmDash(a.detail || a.notes || ''),
          tag: a.tag || 'Work',
          source: a.source || 'Owner',
          done: Boolean(a.done ?? a.completed),
          created_at: a.created_at || '',
          updated_at: a.updated_at || '',
        }));
        updateTodaySidebarWidgets();
        renderTodayTriageList();
        renderTodayDetailPane();
      } else {
        await loadToday({ silent: true });
      }
      return res;
    } catch (err) {
      showToast('Action error: ' + err.message, 'error');
      return null;
    }
  }

  async function runMeetingPrep(meetingId) {
    if (!state.today) return;
    const ev = state.today.schedule.find((s) => s.id === meetingId);
    if (!ev || state.inFlightPrepId === ev.id) return;

    state.inFlightPrepId = ev.id;
    renderTodayDetailPane();
    showToast('Generating local meeting prep brief for ' + ev.title + '...', 'info', 'prep:' + ev.id);
    const t0 = performance.now();
    const contextText = [
      'Meeting: ' + ev.title,
      'Time: ' + (ev.time_label || ev.start || ''),
      'Calendar: ' + ev.calendar,
      ev.participants.length ? 'Participants: ' + ev.participants.join(', ') : '',
      ev.description ? 'Details: ' + ev.description : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await apiPost('/api/draft', {
        kind: 'meeting_prep',
        title: ev.title,
        context_text: contextText,
      });
      const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
      if (res.ok === false) {
        showToast(res.error || 'Meeting prep failed.', 'error', 'prep:' + ev.id);
        return;
      }
      const md = stripEmDash(res.draft_md || res.answer_md || res.draft || res.answer || 'Prep brief ready.');
      state.meetingBriefCache.set(ev.id, {
        md,
        engine: res.engine || 'Local Vault + G4',
        latency_ms: elapsed,
      });
      state.lastDraftMd = md;
      state.lastDraftMeta = { title: 'Meeting Prep: ' + ev.title, kind: 'meeting_prep' };
      showToast('Meeting prep brief ready.', 'success', 'prep:' + ev.id);
    } catch (err) {
      showToast('Meeting prep error: ' + err.message, 'error', 'prep:' + ev.id);
    } finally {
      if (state.inFlightPrepId === ev.id) state.inFlightPrepId = null;
      renderTodayDetailPane();
    }
  }

  async function runInboxDraft(inboxId, customPrompt = '') {
    if (!state.today) return;
    const msg = state.today.inbox.find((m) => m.id === inboxId);
    if (!msg || state.inFlightDraftId === msg.id) return;

    state.inFlightDraftId = msg.id;
    renderTodayDetailPane();
    showToast('Drafting local reply for ' + msg.sender + '...', 'info', 'draft:' + msg.id);
    const t0 = performance.now();
    const contextText = [
      'Channel: ' + channelInfo(msg.channel).label,
      'From: ' + msg.sender,
      msg.title ? 'Thread: ' + msg.title : '',
      'Timestamp: ' + (msg.timestamp || msg.age || ''),
      'Message:\n' + (msg.body || msg.snippet || ''),
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await apiPost('/api/draft', {
        kind: 'reply',
        title: msg.title || msg.sender,
        context_text: contextText,
        instructions: customPrompt,
        thread_key: msg.thread_key || undefined,
      });
      const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
      if (res.ok === false) {
        showToast(res.error || 'Draft generation failed.', 'error', 'draft:' + msg.id);
        return;
      }
      const md = stripEmDash(res.draft_md || res.answer_md || res.draft || res.answer || '');
      state.inboxDraftCache.set(msg.id, {
        md,
        engine: res.engine || 'Local Draft',
        latency_ms: elapsed,
      });
      state.lastDraftMd = md;
      state.lastDraftMeta = { title: 'Reply Draft: ' + msg.sender, kind: 'reply' };
      showComposerOutput(md, res.engine || 'Local Draft', elapsed);
      showToast('Local draft ready (no outbound send).', 'success', 'draft:' + msg.id);
    } catch (err) {
      showToast('Draft error: ' + err.message, 'error', 'draft:' + msg.id);
    } finally {
      if (state.inFlightDraftId === msg.id) state.inFlightDraftId = null;
      renderTodayDetailPane();
    }
  }

  // =========================================================================
  // DOCKED BOTTOM LOCAL ACTION COMPOSER (TODAY PANE 3)
  // =========================================================================
  function setComposerMode(mode) {
    state.composerMode = mode;
    $$('.comp-tab[data-composer-mode]').forEach((tab) => {
      const active = tab.dataset.composerMode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const input = $('#composer-input');
    const runBtn = $('#btn-composer-run');
    if (mode === 'action') {
      if (input) input.placeholder = 'Write a new action item (e.g. Review weekly architecture priorities)...';
      if (runBtn) runBtn.textContent = 'Add Action';
    } else if (mode === 'ask') {
      if (input) input.placeholder = 'Ask your Mind a question about this item or your vault...';
      if (runBtn) runBtn.textContent = 'Ask Mind';
    } else {
      if (input) input.placeholder = 'Describe tone, key points, or click Run / Refine to generate a local draft...';
      if (runBtn) runBtn.textContent = 'Run / Refine';
    }
  }

  function showComposerOutput(mdText, engineLabel, latencyMs) {
    const wrap = $('#composer-output');
    const body = $('#composer-output-body');
    const eng = $('#composer-output-engine');
    const lat = $('#composer-output-latency');
    if (!wrap || !body) return;
    wrap.hidden = false;
    setMobileComposerExpanded(true);
    if (eng) eng.textContent = engineLabel || 'Local Draft';
    if (lat) lat.textContent = latencyMs !== undefined ? formatLatency(latencyMs) : '';
    body.innerHTML = renderMarkdownHtml(mdText);
  }

  async function handleComposerSubmit(e) {
    e.preventDefault();
    if (state.composerBusy) return;
    const inputEl = $('#composer-input');
    const runBtn = $('#btn-composer-run');
    const text = inputEl ? inputEl.value.trim() : '';
    const row = getSelectedTodayRow();

    if (state.composerMode === 'action') {
      if (!text) {
        if (inputEl) inputEl.focus();
        return;
      }
      state.composerBusy = true;
      if (runBtn) runBtn.disabled = true;
      const sourceLabel =
        row.kind === 'meeting'
          ? 'Calendar: ' + row.data.title
          : row.kind === 'inbox'
          ? channelInfo(row.data.channel).label + ': ' + row.data.sender
          : 'Today';
      const res = await mutateAction({ op: 'add', title: text, tag: 'Work', source: sourceLabel });
      state.composerBusy = false;
      if (runBtn) runBtn.disabled = false;
      if (res && res.ok !== false) {
        if (inputEl) inputEl.value = '';
        showToast('Added action item.', 'success');
      }
      return;
    }

    state.composerBusy = true;
    if (runBtn) runBtn.disabled = true;
    const t0 = performance.now();

    try {
      if (state.composerMode === 'ask') {
        const prompt =
          text ||
          (row.kind === 'meeting'
            ? 'Give me key context and prep questions for ' + row.data.title
            : row.kind === 'inbox'
            ? 'Summarize history and suggested response for ' + row.data.sender + ': ' + row.data.subject
            : row.kind === 'action'
            ? 'What are the fastest concrete next steps for: ' + row.data.title
            : 'Summarize my highest priorities for today.');
        const res = await apiPost('/api/interact', { mode: 'ask', input: prompt });
        const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
        if (res.ok === false) {
          showToast(res.error || 'Ask Mind failed.', 'error');
        } else {
          const md = stripEmDash(res.answer_md || res.answer || 'Completed.');
          state.lastDraftMd = md;
          state.lastDraftMeta = { title: 'Mind Answer', kind: 'ask' };
          showComposerOutput(md, res.engine || (res.synthesized ? 'Local LLM + Vault' : 'Vault Grounded'), elapsed);
        }
      } else {
        const kind =
          row.kind === 'meeting'
            ? 'meeting_prep'
            : row.kind === 'inbox'
            ? 'reply'
            : 'context_brief';
        const title =
          row.kind === 'meeting'
            ? row.data.title
            : row.kind === 'inbox'
            ? (row.data.title || row.data.sender)
            : row.kind === 'action'
            ? row.data.title
            : 'Morning Brief';
        const contextText =
          row.kind === 'meeting'
            ? [
                'Meeting: ' + row.data.title,
                'Time: ' + (row.data.time_label || row.data.start || ''),
                'Calendar: ' + row.data.calendar,
                row.data.participants.length ? 'Participants: ' + row.data.participants.join(', ') : '',
                row.data.description || '',
              ]
                .filter(Boolean)
                .join('\n')
            : row.kind === 'inbox'
            ? [
                'Channel: ' + channelInfo(row.data.channel).label,
                'From: ' + row.data.sender,
                'Thread: ' + (row.data.title || ''),
                row.data.body || row.data.snippet || '',
              ]
                .filter(Boolean)
                .join('\n')
            : row.kind === 'action'
            ? 'Action: ' + row.data.title + '\nTag: ' + row.data.tag + '\nDetail: ' + (row.data.detail || '')
            : 'Today Morning Brief across active workstreams, open actions, and priority inbox.';
        const res = await apiPost('/api/draft', {
          kind,
          title,
          context_text: contextText,
          instructions: text,
          thread_key: row.kind === 'inbox' && row.data.thread_key ? row.data.thread_key : undefined,
        });
        const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
        if (res.ok === false) {
          showToast(res.error || 'Draft generation failed.', 'error');
        } else {
          const md = stripEmDash(res.draft_md || res.answer_md || res.draft || res.answer || '');
          state.lastDraftMd = md;
          state.lastDraftMeta = { title, kind };
          showComposerOutput(md, res.engine || 'Local Draft', elapsed);
        }
      }
    } catch (err) {
      showToast('Composer error: ' + err.message, 'error');
    } finally {
      state.composerBusy = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  async function saveDraftToVault(mdOverride, titleOverride) {
    const inputVal = $('#composer-input') ? $('#composer-input').value.trim() : '';
    const contentBody = String(mdOverride || state.lastDraftMd || inputVal || '').trim();
    if (!contentBody) {
      showToast('Generate or type a draft before saving to Vault.', 'warn');
      return;
    }
    const now = new Date();
    const path = 'owner-notes/draft-' + formatTimestampSlug(now) + '.md';
    const title = stripEmDash(
      titleOverride || (state.lastDraftMeta && state.lastDraftMeta.title) || 'Local Draft ' + formatTimestampSlug(now)
    );
    const mdDoc = [
      '---',
      'title: "' + title.replace(/"/g, "'") + '"',
      'created_at: ' + now.toISOString(),
      'source: kizuki-mind-os-composer',
      'local_only: true',
      '---',
      '',
      '# ' + title,
      '',
      contentBody,
      '',
    ].join('\n');

    try {
      const res = await apiPost('/api/docs/save', { path, content: mdDoc });
      if (res.ok === false) {
        showToast(res.error || 'Could not save draft to Vault.', 'error');
        return;
      }
      showToast('Saved draft to ' + (res.path || path), 'success');
      if (state.vaultLoaded) loadVaultDocs({ reset: true });
    } catch (err) {
      showToast('Save error: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // VIEW 2: PEOPLE CROSS-CHANNEL DOSSIERS & WORLD-MODEL INTELLIGENCE
  // =========================================================================
  const PEOPLE_NOTE_KINDS = [
    { key: 'insight', label: 'Insight', placeholder: 'Record a verified insight or behavioral read...' },
    { key: 'taste', label: 'Taste', placeholder: 'Record a taste, aesthetic preference, or sensibility...' },
    { key: 'leverage', label: 'Leverage', placeholder: 'Record how we win, align, or create mutual leverage...' },
    { key: 'risk', label: 'Risk', placeholder: 'Record an exposure, dependency, or watch-out...' },
    { key: 'wrong', label: 'Wrong', placeholder: 'Correct an inaccurate claim or outdated assumption...' },
    { key: 'open_loop', label: 'Open Loop', placeholder: 'Track an active commitment, ask, or unresolved loop...' },
  ];

  function asCleanList(val) {
    if (!val) return [];
    if (typeof val === 'string') {
      return val
        .split('\n')
        .map((line) => stripEmDash(line.replace(/^\s*[-*•]\s*/, '')).trim())
        .filter(Boolean);
    }
    if (!Array.isArray(val)) return [];
    return val
      .map((item) => {
        if (typeof item === 'string') return stripEmDash(item).trim();
        if (item && typeof item === 'object') {
          const text =
            item.text ||
            item.summary ||
            item.statement ||
            item.description ||
            item.title ||
            item.label ||
            item.value ||
            '';
          return stripEmDash(text).trim();
        }
        return '';
      })
      .filter(Boolean);
  }

  function normalizeProfileTier(person, wm) {
    const wmSchema = String((wm && wm.schema_version) || '').toLowerCase().trim();
    const pTier = String((person && person.profile_tier) || (person && person.schema_version) || '').toLowerCase().trim();
    if (
      wmSchema === 'person-card-v2' ||
      wmSchema === 'v2' ||
      wmSchema === 'world_model_v2' ||
      wmSchema === 'world-model-v2' ||
      wmSchema === 'synthesized' ||
      pTier === 'v2' ||
      pTier === 'person-card-v2' ||
      pTier === 'world_model_v2' ||
      pTier === 'world-model-v2' ||
      pTier === 'synthesized'
    ) {
      return 'v2';
    }
    if (
      wmSchema === 'person-card-v1' ||
      wmSchema === 'lifeos' ||
      wmSchema === 'v1' ||
      wmSchema === 'card' ||
      pTier === 'lifeos' ||
      pTier === 'person-card-v1' ||
      pTier === 'v1'
    ) {
      return 'lifeos';
    }
    if (wmSchema === 'none') return 'none';
    if (wm && typeof wm.full_markdown === 'string' && wm.full_markdown.trim().length > 40) return 'lifeos';
    return 'none';
  }

  function personTierRingClass(tierRaw) {
    const lower = String(tierRaw || '').toLowerCase();
    if (lower.includes('family')) return 'is-family';
    if (lower.includes('core') || lower.includes('inner')) return 'is-core';
    if (lower.includes('active')) return 'is-active';
    if (lower.includes('warm')) return 'is-warm';
    return '';
  }

  function normalizeTrajectory(raw) {
    const t = String(raw || '').toUpperCase().trim();
    if (!t) return null;
    if (t.includes('RIS') || t === 'UP' || t === 'GROWING' || t === 'WARMING') {
      return { code: 'RISING', arrow: '\u25b2', cls: 'is-rising', label: 'RISING' };
    }
    if (t.includes('COOL') || t === 'DOWN' || t === 'FADING' || t === 'DECLINING') {
      return { code: 'COOLING', arrow: '\u25bc', cls: 'is-cooling', label: 'COOLING' };
    }
    if (t.includes('STOP') || t === 'DORMANT' || t === 'INACTIVE') {
      return { code: 'STOPPED', arrow: '\u25bc', cls: 'is-stopped', label: 'STOPPED' };
    }
    if (t.includes('STAB') || t === 'FLAT' || t === 'STEADY') {
      return { code: 'STABLE', arrow: '\u2022', cls: 'is-stable', label: 'STABLE' };
    }
    return { code: t, arrow: '\u2022', cls: 'is-stable', label: t };
  }

  function formatPersonTierBadge(tierRaw, compact) {
    const raw = String(tierRaw || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    let cls = 'person-tier-badge';
    let label = raw;
    if (lower.includes('family')) {
      cls += ' is-family';
      label = 'Family';
    } else if (lower.includes('core') || lower.includes('inner')) {
      cls += ' is-core';
      label = 'Core';
    } else if (lower.includes('active')) {
      if (compact) return '';
      cls += ' is-active';
      label = 'Active';
    } else if (lower.includes('warm')) {
      if (compact) return '';
      cls += ' is-warm';
      label = 'Warm';
    } else if (compact) {
      return '';
    }
    return '<span class="' + cls + '">' + escHtml(label) + '</span>';
  }

  function formatPersonListLastSeen(p) {
    const tier = normalizeProfileTier(p, null);
    const hasMessages = Number(p.message_count || 0) > 0;
    const rawLabel = String(p.last_seen_label || '').trim();
    if (rawLabel) return stripEmDash(rawLabel);
    const computed = formatHistoricalLastSeen(p);
    if (computed === 'No recent msg' && !hasMessages && (tier === 'v2' || tier === 'lifeos')) {
      return 'LifeOS';
    }
    return computed;
  }

  function formatHistorySpan(person, wm) {
    if (person && person.history_span_label) {
      return stripEmDash(String(person.history_span_label));
    }
    const first = (person && person.first_seen) || (wm && wm.first_seen) || '';
    if (first) {
      const m = String(first).match(/\b(20\d\d|19\d\d)\b/);
      if (m) return 'Since ' + m[1];
      return stripEmDash(String(first)).slice(0, 12);
    }
    return '--';
  }

  function isSelfTimelineItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.is_self === true || item.is_outbound === true || item.from_me === true) return true;
    const dir = String(item.direction || '').toLowerCase().trim();
    if (dir === 'outbound' || dir === 'out' || dir === 'sent' || dir === 'you' || dir === 'self') return true;
    const sender = String(item.sender || item.speaker || '').toLowerCase().trim();
    if (sender === 'you' || sender === 'me' || sender === 'self') return true;
    return false;
  }

  function normalizeHandles(rawHandles) {
    const out = [];
    if (!rawHandles) return out;
    if (Array.isArray(rawHandles)) {
      for (const h of rawHandles) {
        if (typeof h === 'string' && h.trim()) {
          out.push({ kind: 'link', label: stripEmDash(h.trim()), value: h.trim() });
        } else if (h && typeof h === 'object') {
          const val = String(h.value || h.handle || h.url || '').trim();
          if (!val) continue;
          const kind = String(h.kind || h.type || h.platform || 'handle').toLowerCase();
          const label = h.label ? stripEmDash(h.label) : val;
          out.push({ kind, label, value: val });
        }
      }
      return out;
    }
    if (typeof rawHandles !== 'object') return out;

    const pushHandle = (kind, prefix, rawVal) => {
      const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
      for (const v of vals) {
        const s = String(v || '').trim();
        if (!s) continue;
        if (kind === 'tg') {
          const clean = s.startsWith('@') ? s : '@' + s.replace(/^https?:\/\/t\.me\//i, '');
          out.push({ kind: 'tg', label: 'TG ' + clean, value: clean, href: 'https://t.me/' + clean.replace(/^@/, '') });
        } else if (kind === 'x') {
          const clean = s.startsWith('@') ? s : '@' + s.replace(/^https?:\/\/(?:x|twitter)\.com\//i, '');
          out.push({ kind: 'x', label: 'X ' + clean, value: clean, href: 'https://x.com/' + clean.replace(/^@/, '') });
        } else if (kind === 'gh') {
          const clean = s.replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '');
          out.push({ kind: 'gh', label: 'GH ' + clean, value: clean, href: 'https://github.com/' + clean });
        } else if (kind === 'email') {
          out.push({ kind: 'email', label: s, value: s, href: 'mailto:' + s });
        } else if (kind === 'url') {
          const href = /^https?:\/\//i.test(s) ? s : 'https://' + s;
          const display = s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
          out.push({ kind: 'url', label: display, value: href, href });
        } else {
          out.push({ kind, label: (prefix ? prefix + ' ' : '') + s, value: s });
        }
      }
    };

    pushHandle('tg', 'TG', rawHandles.telegram ?? rawHandles.tg);
    pushHandle('x', 'X', rawHandles.x ?? rawHandles.twitter);
    pushHandle('gh', 'GH', rawHandles.github ?? rawHandles.gh);
    pushHandle('email', '', rawHandles.email ?? rawHandles.emails);
    pushHandle('url', '', rawHandles.url ?? rawHandles.website ?? rawHandles.urls);
    return out;
  }

  function contactIconSvg(kind) {
    if (window.KizukiIcons && typeof window.KizukiIcons.contactIconForKind === 'function') {
      return window.KizukiIcons.contactIconForKind(kind, { size: 12 });
    }
    const k = String(kind || '').toLowerCase();
    if (k === 'email') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3.2" width="12" height="9.6" rx="1.6" stroke="currentColor" stroke-width="1.35"/><path d="M2.6 4.4L8 8.6L13.4 4.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (k === 'phone') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.3 2.5h2.2l1 2.8-1.4 1.1a7.6 7.6 0 0 0 3.5 3.5l1.1-1.4 2.8 1v2.2a1.3 1.3 0 0 1-1.4 1.3C6.8 12.7 3.3 9.2 3 3.9A1.3 1.3 0 0 1 4.3 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    }
    if (k === 'telegram' || k === 'tg') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.8 2.8L2.3 7.3l3.3 1.2 1.3 3.9 2.1-2.1 3 2.2 1.8-9.7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.6 8.5L11 5.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    }
    if (k === 'x') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2.8L13 13.2M12.6 2.8L3.4 13.2" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';
    }
    if (k === 'github' || k === 'gh' || k === 'repo') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.2 12.2c-2.6.8-2.6-1.3-3.7-1.6m7.4 3.2v-2.1a1.8 1.8 0 0 0-.5-1.4c1.7-.2 3.5-.8 3.5-3.8a3 3 0 0 0-.8-2 2.8 2.8 0 0 0-.1-2s-.6-.2-2.1.8a7.2 7.2 0 0 0-3.8 0c-1.5-1-2.1-.8-2.1-.8a2.8 2.8 0 0 0-.1 2 3 3 0 0 0-.8 2c0 3 1.8 3.6 3.5 3.8a1.8 1.8 0 0 0-.5 1.4v2.1" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (k === 'linkedin') {
      return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 7v4.2M5.2 4.8v.1M7.8 11.2V7m0 1.4a1.6 1.6 0 0 1 3 .7v2.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.3"/><path d="M2.6 8h10.8M8 2.4c1.5 1.6 2.3 3.5 2.3 5.6S9.5 12 8 13.6C6.5 12 5.7 10.1 5.7 8S6.5 4 8 2.4Z" stroke="currentColor" stroke-width="1.2"/></svg>';
  }

  function normalizeContactLinks(contactLinks, fallbackHandles) {
    const out = [];
    const seen = new Set();
    const pushItem = (raw) => {
      if (!raw || typeof raw !== 'object') return;
      let kind = String(raw.kind || raw.type || raw.platform || 'web').toLowerCase().trim();
      if (kind === 'tg') kind = 'telegram';
      if (kind === 'gh') kind = 'github';
      if (kind === 'twitter') kind = 'x';
      if (kind === 'url' || kind === 'website') kind = 'web';
      if (kind === 'mail') kind = 'email';
      if (kind === 'tel' || kind === 'mobile') kind = 'phone';
      const value = stripEmDash(String(raw.value || raw.handle || raw.href || raw.label || '')).trim();
      if (!value) return;
      const dedupeKey = kind + '|' + value.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      let href = raw.href && typeof raw.href === 'string' ? raw.href.trim() : null;
      const isCopyKind = kind === 'email' || kind === 'phone' || Boolean(raw.copyable && (!href || /^mailto:|^tel:/i.test(href)));
      if (!href && !isCopyKind) {
        if (kind === 'telegram') href = 'https://t.me/' + value.replace(/^@/, '');
        else if (kind === 'x') href = 'https://x.com/' + value.replace(/^@/, '');
        else if (kind === 'github') href = 'https://github.com/' + value.replace(/^@/, '');
        else if (/^https?:\/\//i.test(value)) href = value;
      }
      const rawLabel = stripEmDash(String(raw.label || value)).replace(/^(?:TG|X|GH)\s+/i, '').trim();
      out.push({
        kind,
        label: rawLabel || value,
        value,
        href: href && /^https?:\/\//i.test(href) ? href : null,
        copyable: isCopyKind || !href || !/^https?:\/\//i.test(href),
      });
    };

    if (Array.isArray(contactLinks) && contactLinks.length > 0) {
      for (const item of contactLinks) pushItem(item);
    }
    if (out.length === 0 && fallbackHandles) {
      for (const h of normalizeHandles(fallbackHandles)) {
        pushItem({
          kind: h.kind,
          label: h.label,
          value: h.value,
          href: h.href || null,
          copyable: h.kind === 'email' || h.kind === 'phone' || !h.href,
        });
      }
    }
    return out;
  }

  function renderContactLinksBar(contactLinks, fallbackHandles) {
    const items = normalizeContactLinks(contactLinks, fallbackHandles);
    if (items.length === 0) return '';
    return (
      '<div class="profile-contact-bar" aria-label="Contact and relevant links">' +
      items
        .slice(0, 10)
        .map((item) => {
          const icon = '<span class="contact-pill-icon">' + contactIconSvg(item.kind) + '</span>';
          if (item.kind !== 'email' && item.kind !== 'phone' && item.href) {
            return (
              '<a class="contact-pill is-' + escHtml(item.kind) + '" href="' + escHtml(item.href) + '" target="_blank" rel="noopener noreferrer" title="' + escHtml(item.href) + '">' +
              icon +
              '<span class="contact-pill-label">' + escHtml(item.label) + '</span>' +
              '</a>'
            );
          }
          return (
            '<button type="button" class="contact-pill is-' + escHtml(item.kind) + '" data-copy-text="' + escHtml(item.value) + '" title="Copy ' + escHtml(item.value) + '">' +
            icon +
            '<span class="contact-pill-label">' + escHtml(item.label) + '</span>' +
            '<span class="contact-pill-copy">Copy</span>' +
            '</button>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function renderBulletListHtml(items, emptyText) {
    const clean = asCleanList(items);
    if (clean.length === 0) {
      return emptyText ? '<p class="panel-subtitle">' + escHtml(emptyText) + '</p>' : '';
    }
    return '<ul class="wm-list">' + clean.map((line) => '<li>' + renderRichInline(line) + '</li>').join('') + '</ul>';
  }

  function renderGfmTable(headers, rows, emptyText) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return emptyText ? '<p class="panel-subtitle">' + escHtml(emptyText) + '</p>' : '';
    }
    return (
      '<div class="md-table-wrap"><table class="md-table gfm-table"><thead><tr>' +
      headers.map((h) => '<th>' + escHtml(h) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows
        .map(
          (cols) =>
            '<tr>' +
            cols.map((cell) => '<td>' + renderRichInline(cell || '--') + '</td>').join('') +
            '</tr>'
        )
        .join('') +
      '</tbody></table></div>'
    );
  }

  function renderClaimCardHtml(claim) {
    if (!claim || typeof claim !== 'object') return '';
    const predicate = stripEmDash(claim.predicate || claim.kind || claim.category || 'claim').trim();
    const text = stripEmDash(claim.text || claim.object_text || claim.claim || claim.summary || claim.value || '').trim();
    if (!text) return '';
    const conf = claim.confidence !== undefined && claim.confidence !== null ? formatConfidence(claim.confidence) : '';
    const rawDate = claim.date || claim.observed_at || claim.created_at || claim.updated_at || '';
    const dateLabel = rawDate ? formatShortDate(rawDate) : '';
    const source = stripEmDash(claim.source || claim.source_connector || '').trim();
    return (
      '<article class="claim-card">' +
      '<div class="claim-card-head">' +
      '<span class="claim-kind-badge">' + escHtml(predicate) + '</span>' +
      '<span class="claim-meta tabular">' +
      (conf ? '<span>' + escHtml(conf) + '</span>' : '') +
      (dateLabel ? '<span>' + escHtml(dateLabel) + '</span>' : '') +
      '</span>' +
      '</div>' +
      '<div class="claim-body">' + escHtml(text) + '</div>' +
      (source ? '<div class="claim-source">' + escHtml(source) + '</div>' : '') +
      '</article>'
    );
  }

  function renderTimelineMessageHtml(item, personName) {
    const info = channelInfo(item.channel || item.source);
    const rawTs = item.occurred_at || item.timestamp || item.date || '';
    const when = formatRelativeTime(rawTs);
    const isSelf = isSelfTimelineItem(item);
    const rawSpeaker = stripEmDash(item.sender || item.speaker || '').trim();
    const senderLabel = isSelf
      ? 'You'
      : rawSpeaker && !/^(inbound|in|received)$/i.test(rawSpeaker)
      ? rawSpeaker
      : personName || 'Contact';
    const senderBadge =
      '<span class="timeline-sender-badge' +
      (isSelf ? ' is-self' : '') +
      '">' +
      escHtml(senderLabel) +
      '</span>';
    const subjText = stripEmDash(item.thread_title || item.subject || '').trim();
    const subj =
      subjText && subjText.toLowerCase() !== String(personName || '').toLowerCase()
        ? '<div class="timeline-subject">' + escHtml(subjText) + '</div>'
        : '';
    const text = stripEmDash(item.full_text || item.body || item.text || item.preview || item.snippet || '').trim();
    return (
      '<article class="timeline-item' +
      (isSelf ? ' is-self' : '') +
      '">' +
      '<div class="timeline-head">' +
      '<span class="timeline-channel">' +
      '<span class="ch-dot ' + escHtml(info.dot) + '" aria-hidden="true"></span>' +
      '<span>' + escHtml(info.label) + '</span>' +
      senderBadge +
      '</span>' +
      '<span class="timeline-time tabular">' + escHtml(when) + '</span>' +
      '</div>' +
      subj +
      '<div class="timeline-body">' + escHtml(text.slice(0, 720)) + '</div>' +
      '</article>'
    );
  }

  function renderEmptyProfileBanner(person, key, claimsTotal, opts = {}) {
    const name = stripEmDash((person && person.name) || key || 'this contact');
    const msgCount = Number((person && person.message_count) || 0);
    const isBusy = state.peopleSynthesizingKey === key;
    const isDeepen = Boolean(opts.deepen);
    const heading = isDeepen
      ? 'Deepen ' + name + ' to World Model v2'
      : 'Synthesize World-Model Profile for ' + name;
    const bodyText = isDeepen
      ? 'This card is missing full asymmetric leverage, tastes, or falsifiable hypotheses. Synthesize now to upgrade the dossier from live messages and Kizuki claims.'
      : formatCompact(msgCount) +
        ' cross-channel messages and ' +
        formatCompact(claimsTotal) +
        ' Kizuki claims are indexed and ready. Synthesize a World Model v2 dossier for canonical read, tastes, philosophies, and asymmetric leverage.';
    const btnLabel = isBusy
      ? 'Synthesizing...'
      : isDeepen
      ? 'Deepen to World Model v2'
      : 'Synthesize World-Model Profile';
    return (
      '<div class="wm-empty-profile-banner">' +
      '<div class="wm-empty-profile-copy">' +
      '<h3 class="wm-empty-profile-title">' + escHtml(heading) + '</h3>' +
      '<p class="wm-empty-profile-desc">' + escHtml(bodyText) + '</p>' +
      '</div>' +
      '<button type="button" class="btn-primary btn-sm" data-synthesize-person="' +
      escHtml(key) +
      '"' +
      (isBusy ? ' disabled' : '') +
      '>' +
      escHtml(btnLabel) +
      '</button>' +
      '</div>'
    );
  }

  function syncPersonInDirectoryList(dossier) {
    if (!dossier || !dossier.person) return;
    const updated = dossier.person;
    const wm = dossier.world_model || {};
    const targetKey = String(updated.key || state.selectedPersonKey || '').toLowerCase();
    const idx = state.peopleItems.findIndex((item) => String(item.key || '').toLowerCase() === targetKey);
    if (idx < 0) return;
    const prev = state.peopleItems[idx];
    const resolvedTier = normalizeProfileTier(updated, wm);
    state.peopleItems[idx] = Object.assign({}, prev, {
      name: updated.name || prev.name,
      initials: safePersonInitials(updated, prev.name),
      role: updated.role || wm.role || prev.role,
      org: updated.org || wm.org || prev.org,
      profile_tier: resolvedTier !== 'none' ? resolvedTier : prev.profile_tier,
      relationship_tier: updated.relationship_tier || wm.relationship_tier || prev.relationship_tier,
      trajectory: updated.trajectory || wm.trajectory || prev.trajectory,
      claim_count: dossier.sqlite_claims_total ?? updated.claim_count ?? prev.claim_count,
      message_count: updated.message_count ?? prev.message_count,
      meeting_count: Array.isArray(dossier.meetings) ? dossier.meetings.length : prev.meeting_count,
    });
    renderPeopleList();
  }

  async function loadPeople() {
    const listEl = $('#people-list');
    if (listEl && !state.peopleLoaded) {
      listEl.innerHTML = '<div class="panel-body"><div class="skeleton-block"></div></div>';
    }
    const params = new URLSearchParams();
    if (state.peopleQuery.trim()) params.set('q', state.peopleQuery.trim());
    params.set('channel', state.peopleChannel || 'all');
    params.set('limit', '80');

    try {
      const res = await apiGet('/api/people?' + params.toString());
      state.peopleLoaded = true;
      const items = Array.isArray(res.items) ? res.items : Array.isArray(res.people) ? res.people : [];
      state.peopleItems = items;
      state.peopleTotal = Number(res.total ?? items.length);

      const totalEl = $('#people-total-count');
      if (totalEl) totalEl.textContent = formatCompact(state.peopleTotal);
      if (!state.peopleQuery.trim() && state.peopleChannel === 'all' && state.peopleTotal > 0) {
        syncUnifiedCounters();
      }

      renderPeopleList();
      if (!state.selectedPersonKey && items.length > 0 && !isMobileViewport()) {
        openPersonDossier(items[0].key, { openMobileDetail: false });
      }
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = '<div class="empty-state">Failed to load People directory (' + escHtml(err.message) + ').</div>';
      }
    }
  }

  function renderPeopleList() {
    const listEl = $('#people-list');
    if (!listEl) return;

    const viewPeople = $('#view-people');
    if (viewPeople) {
      let radarSlot =
        viewPeople.querySelector('[data-slot="people-radar"]') ||
        viewPeople.querySelector('[data-kizuki-slot="people-radar"]') ||
        $('#people-radar-auto-slot', viewPeople);
      if (!radarSlot) {
        radarSlot = document.createElement('div');
        radarSlot.id = 'people-radar-slot';
        radarSlot.className = 'people-radar-slot';
        const shell = $('#people-master-detail', viewPeople);
        if (shell) viewPeople.insertBefore(radarSlot, shell);
        else viewPeople.prepend(radarSlot);
      }
      radarSlot.setAttribute('data-slot', 'people-radar');
      radarSlot.setAttribute('data-kizuki-slot', 'people-radar');
      if (window.KizukiSlots && typeof window.KizukiSlots.mount === 'function') {
        window.KizukiSlots.mount('people-radar', radarSlot, {
          peopleItems: state.peopleItems,
          openPerson: (key) => openPersonDossier(key, { openMobileDetail: true }),
          reloadPeople: () => loadPeople(),
        });
      }
    }

    if (state.peopleItems.length === 0) {
      listEl.innerHTML = '<div class="dir-empty">No people match this search or filter.</div>';
      return;
    }

    listEl.innerHTML = state.peopleItems
      .map((p) => {
        const key = String(p.key || p.name || '');
        const selected = state.selectedPersonKey === key;
        const chs = Array.isArray(p.channels) ? p.channels : [];
        const dotsHtml = chs
          .slice(0, 5)
          .map((c) => '<span class="ch-dot ' + escHtml(channelInfo(c).dot) + '" title="' + escHtml(channelInfo(c).label) + '"></span>')
          .join('');
        const lastSeen = formatPersonListLastSeen(p);
        const profileTier = normalizeProfileTier(p, null);
        const depthBadgeHtml =
          profileTier === 'v2'
            ? '<span class="person-depth-badge is-v2" title="World Model v2 dossier">v2</span>'
            : profileTier === 'lifeos'
            ? '<span class="person-depth-badge is-lifeos" title="LifeOS dossier card">Card</span>'
            : '';
        const tierBadgeHtml = formatPersonTierBadge(p.relationship_tier || p.tier, true);
        const traj = normalizeTrajectory(p.trajectory);
        const trajHtml =
          traj && (traj.code === 'RISING' || traj.code === 'COOLING' || traj.code === 'STOPPED')
            ? '<span class="person-trajectory ' + traj.cls + '" title="Trajectory: ' + escHtml(traj.label) + '">' + traj.arrow + '</span>'
            : '';

        const roleParts = [stripEmDash(p.role || '').trim(), stripEmDash(p.org || '').trim()].filter(Boolean);
        const roleLine =
          roleParts.length > 0
            ? roleParts.join(' \u00b7 ')
            : stripEmDash(p.preview || p.last_message_preview || p.last_snippet || '');

        const countParts = [];
        const msgCount = Number(p.message_count || 0);
        const claimCount = Number(p.claim_count || 0);
        const mtgCount = Number(p.meeting_count || 0);
        if (msgCount > 0) countParts.push(formatCompact(msgCount) + ' msgs');
        if (claimCount > 0) countParts.push(formatCompact(claimCount) + ' claims');
        if (mtgCount > 0) countParts.push(formatCompact(mtgCount) + ' mtgs');
        const countsLine = countParts.length > 0 ? countParts.join(' \u00b7 ') : 'Indexed contact';

        return (
          '<button type="button" class="person-row' +
          (selected ? ' is-selected' : '') +
          '" role="option" aria-selected="' +
          (selected ? 'true' : 'false') +
          '" data-person-key="' +
          escHtml(key) +
          '">' +
          '<span class="person-avatar">' + escHtml(safePersonInitials(p)) + '</span>' +
          '<span class="person-row-main">' +
          '<span class="person-row-head">' +
          '<span class="person-row-name">' + escHtml(stripEmDash(p.name || key)) + '</span>' +
          depthBadgeHtml +
          tierBadgeHtml +
          trajHtml +
          '</span>' +
          (roleLine ? '<span class="person-role-line">' + escHtml(roleLine) + '</span>' : '') +
          '<span class="person-counts-meta tabular">' + escHtml(countsLine) + '</span>' +
          '</span>' +
          '<span class="person-row-right">' +
          '<span class="person-ch-dots">' + dotsHtml + '</span>' +
          '<span class="person-row-time tabular">' + escHtml(lastSeen) + '</span>' +
          '</span>' +
          '</button>'
        );
      })
      .join('');
  }

  async function openPersonDossier(personKey, { openMobileDetail = true, jumpView = false, tab, forceRefresh = false } = {}) {
    const nextKey = String(personKey || '').trim();
    if (!nextKey) return;
    if (jumpView && state.view !== 'people') {
      switchView('people', { updateUrl: false });
    }

    const prevKey = String(state.selectedPersonKey || '').trim();
    const isSamePerson = prevKey !== '' && prevKey.toLowerCase() === nextKey.toLowerCase();

    // Set selectedPersonKey BEFORE opening mobile slide-over so mobile never flashes blank
    state.selectedPersonKey = nextKey;

    const listMatch = state.peopleItems.find(
      (item) =>
        String(item.key || '').toLowerCase() === nextKey.toLowerCase() ||
        String(item.name || '').toLowerCase() === nextKey.toLowerCase()
    );
    const optimisticName = stripEmDash(
      (listMatch && listMatch.name) ||
        (isSamePerson && state.selectedDossier && state.selectedDossier.person && state.selectedDossier.person.name) ||
        nextKey
    );

    const crumbEl = $('#people-breadcrumb');
    if (crumbEl) {
      crumbEl.innerHTML =
        '<span class="breadcrumb-parent">People</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">' +
        escHtml(optimisticName) +
        '</span>';
    }

    if (!isSamePerson) {
      state.peopleAiOutput = null;
      state.peopleDossierTab = tab || 'overview';
      state.peopleHistoryFilter = 'all';
      state.peopleHistoryQuery = '';
      state.peopleHistoryLoadingMore = false;
      state.peopleNoteOpen = false;
    } else if (tab) {
      state.peopleDossierTab = tab;
    }

    updateUrlParams({ view: 'people', person: state.selectedPersonKey });
    renderPeopleList();

    if (openMobileDetail && isMobileViewport()) {
      setPeopleMobileDetail(true);
    }

    if (isSamePerson && state.selectedDossier && !forceRefresh) {
      renderPersonDossier(state.selectedDossier);
      return;
    }

    if (state.peopleFetchAbort) {
      try {
        state.peopleFetchAbort.abort();
      } catch (_) {
        // ignore abort error
      }
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    state.peopleFetchAbort = controller;
    const seq = ++state.peopleFetchSeq;

    const bodyEl = $('#people-detail-body');
    if (bodyEl && (!isSamePerson || !state.selectedDossier)) {
      bodyEl.innerHTML =
        '<div class="detail-inner">' +
        '<div class="profile-banner"><div class="profile-banner-top"><div class="profile-banner-main">' +
        '<div class="profile-name-row"><h2 class="detail-title">' + escHtml(optimisticName) + '</h2></div>' +
        '<p class="profile-subtitle">Loading cross-channel dossier...</p>' +
        '</div></div></div>' +
        '<div class="skeleton-block"></div>' +
        '</div>';
    }

    try {
      const url = '/api/people/dossier?key=' + encodeURIComponent(nextKey) + '&limit=80&offset=0';
      const fetchRes = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!fetchRes.ok) {
        const text = await fetchRes.text().catch(() => '');
        throw new Error('HTTP ' + fetchRes.status + (text ? ': ' + text.slice(0, 120) : ''));
      }
      const res = await fetchRes.json();
      if (seq !== state.peopleFetchSeq) return;
      if (state.peopleFetchAbort === controller) state.peopleFetchAbort = null;
      if (res && res.person && res.person.key) {
        state.selectedPersonKey = String(res.person.key);
        updateUrlParams({ view: 'people', person: state.selectedPersonKey });
      }
      state.selectedDossier = res;
      renderPeopleList();
      renderPersonDossier(res);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== state.peopleFetchSeq) return;
      if (state.peopleFetchAbort === controller) state.peopleFetchAbort = null;
      if (bodyEl) {
        bodyEl.innerHTML = '<div class="empty-state">Unable to load person dossier (' + escHtml(err.message) + ').</div>';
      }
    }
  }

  const selectPerson = openPersonDossier;

  function renderPersonNoteDrawer() {
    if (!state.peopleNoteOpen) return '';
    const activeKindObj = PEOPLE_NOTE_KINDS.find((k) => k.key === state.peopleNoteKind) || PEOPLE_NOTE_KINDS[0];
    return (
      '<form class="wm-note-drawer" id="wm-note-form">' +
      '<div class="wm-card-head">' +
      '<span class="wm-card-kicker">Log Verified Observation or Correction</span>' +
      '<button type="button" class="btn-ghost btn-xs" data-close-note-drawer="true" aria-label="Close observation drawer">&times;</button>' +
      '</div>' +
      '<div class="wm-note-kinds" role="radiogroup" aria-label="Observation kind">' +
      PEOPLE_NOTE_KINDS.map((k) => {
        const active = state.peopleNoteKind === k.key;
        return (
          '<button type="button" class="wm-note-kind-pill' +
          (active ? ' is-active' : '') +
          '" data-note-kind="' +
          escHtml(k.key) +
          '" aria-pressed="' +
          (active ? 'true' : 'false') +
          '">' +
          escHtml(k.label) +
          '</button>'
        );
      }).join('') +
      '</div>' +
      '<label for="wm-note-input" class="sr-only">Observation text</label>' +
      '<input id="wm-note-input" class="wm-note-input" type="text" placeholder="' +
      escHtml(activeKindObj.placeholder) +
      '" autocomplete="off" required>' +
      '<div class="wm-note-footer">' +
      '<span class="wm-note-hint">Appended to person dossier immediately as owner-verified signal.</span>' +
      '<div class="composer-actions">' +
      '<button type="button" class="btn-ghost btn-xs" data-close-note-drawer="true">Cancel</button>' +
      '<button type="submit" class="btn-primary btn-sm" id="btn-wm-note-submit"' +
      (state.peopleNoteBusy ? ' disabled' : '') +
      '>' +
      (state.peopleNoteBusy ? 'Saving...' : 'Save Observation') +
      '</button>' +
      '</div>' +
      '</div>' +
      '</form>'
    );
  }

  function renderProfileVisualDeck(dossier, person, wm, schemaVersion, claimsTotal, timelineTotal, meetings) {
    const pv = (dossier && dossier.profile_visuals && typeof dossier.profile_visuals === 'object') ? dossier.profile_visuals : null;
    const viz = window.KizukiPersonVisuals || null;
    if (!pv && !viz) return '';

    const arch = (pv && pv.archetype && typeof pv.archetype === 'object') ? pv.archetype : {};
    const axes = pv && Array.isArray(pv.axes) ? pv.axes : [];
    const cadence = pv && Array.isArray(pv.cadence_series) ? pv.cadence_series : [];
    const channels = pv && Array.isArray(pv.channel_breakdown) ? pv.channel_breakdown : [];
    const reciprocity = (pv && pv.reciprocity_ratio && typeof pv.reciprocity_ratio === 'object') ? pv.reciprocity_ratio : null;
    const leverageBal = (pv && pv.leverage_balance && typeof pv.leverage_balance === 'object') ? pv.leverage_balance : null;

    let radarSvg = '';
    if (viz && typeof viz.renderTraitRadarSvg === 'function' && axes.length > 0) {
      try {
        radarSvg = viz.renderTraitRadarSvg(axes);
      } catch (_) {
        radarSvg = '';
      }
    }

    let cadenceSvg = '';
    if (viz && typeof viz.renderCadenceSparklineSvg === 'function' && (cadence.length > 0 || channels.length > 0 || reciprocity)) {
      try {
        cadenceSvg = viz.renderCadenceSparklineSvg(cadence, channels, reciprocity);
      } catch (_) {
        cadenceSvg = '';
      }
    }

    let leverageSvg = '';
    if (viz && typeof viz.renderLeverageBalanceSvg === 'function' && leverageBal) {
      try {
        leverageSvg = viz.renderLeverageBalanceSvg(leverageBal);
      } catch (_) {
        leverageSvg = '';
      }
    }

    const firstClean = (list) => {
      const items = asCleanList(list);
      if (items.length === 0) return '';
      const raw = items[0];
      return raw.length > 110 ? raw.slice(0, 107).trim() + '...' : raw;
    };

    const operatingMode = stripEmDash(arch.operating_mode || firstClean(wm.operating_loop) || arch.tagline || '').trim();
    const commsRegister = stripEmDash(arch.comms_register || wm.communication_style || '').trim();
    const decisionTrigger = stripEmDash(arch.decision_trigger || firstClean(wm.philosophies_decision_model) || firstClean(wm.our_leverage) || '').trim();
    const blindSpot = stripEmDash(arch.blind_spot || firstClean(wm.do_not_assume) || firstClean(wm.degraders) || firstClean(wm.their_leverage) || '').trim();
    const basisNote = stripEmDash(
      arch.basis_note ||
        'Derived from ' +
          formatCompact(person.message_count ?? timelineTotal) +
          ' messages, ' +
          formatCompact(claimsTotal) +
          ' claims, and ' +
          (schemaVersion === 'v2' ? 'World Model v2' : schemaVersion === 'lifeos' ? 'LifeOS Card' : 'live telemetry') +
          '.'
    ).trim();

    const specRows = [
      { key: 'Operating Mode', val: operatingMode || 'Observed across active threads' },
      { key: 'Comms Register', val: commsRegister || 'Cross-channel direct' },
      { key: 'Decision Trigger', val: decisionTrigger || 'Evidence-grounded alignment' },
      { key: 'Blind Spot', val: blindSpot || 'Verify unconfirmed assumptions' },
    ];

    const hasRadarPanel = Boolean(radarSvg || operatingMode || decisionTrigger || blindSpot);
    const hasCadencePanel = Boolean(cadenceSvg || leverageSvg);
    if (!hasRadarPanel && !hasCadencePanel) return '';

    const cadenceSum = cadence.reduce((acc, w) => acc + Number((w && w.total) || 0), 0);
    const totalInteractions = Math.max(
      cadenceSum,
      Number(person.message_count ?? timelineTotal ?? 0) + (Array.isArray(meetings) ? meetings.length : 0)
    );
    const interactionsLabel = formatCompact(totalInteractions) + ' interactions';

    const radarPanelHtml = hasRadarPanel
      ? '<article class="visual-panel is-radar">' +
        '<header class="visual-panel-head">' +
        '<h3 class="detail-kicker">PSYCHOGRAPHIC SIGNATURE</h3>' +
        '<span class="pv-meta-pill">Falsifiable</span>' +
        '</header>' +
        '<div class="pv-radar-layout">' +
        (radarSvg ? '<div class="pv-radar-stage">' + radarSvg + '</div>' : '') +
        '<div class="pv-traits-spec">' +
        specRows
          .map(
            (r) =>
              '<div class="pv-spec-row">' +
              '<span class="pv-spec-key">' + escHtml(r.key) + '</span>' +
              '<span class="pv-spec-val">' + renderRichInline(r.val) + '</span>' +
              '</div>'
          )
          .join('') +
        '</div>' +
        '</div>' +
        (basisNote ? '<p class="pv-basis-note">' + escHtml(basisNote) + '</p>' : '') +
        '</article>'
      : '';

    const cadencePanelHtml = hasCadencePanel
      ? '<article class="visual-panel is-cadence">' +
        '<header class="visual-panel-head">' +
        '<h3 class="detail-kicker">CADENCE &amp; ASYMMETRIC BALANCE</h3>' +
        '<span class="pv-meta-pill tabular">' + escHtml(interactionsLabel) + '</span>' +
        '</header>' +
        cadenceSvg +
        leverageSvg +
        '</article>'
      : '';

    return '<section class="profile-visuals-grid" aria-label="Visual intelligence deck">' + radarPanelHtml + cadencePanelHtml + '</section>';
  }

  function renderEgoConstellationPanel(dossier, { compact = false } = {}) {
    const pv = (dossier && dossier.profile_visuals && typeof dossier.profile_visuals === 'object') ? dossier.profile_visuals : null;
    const ego = pv && pv.ego_graph && typeof pv.ego_graph === 'object' ? pv.ego_graph : null;
    const nodes = ego && Array.isArray(ego.nodes) ? ego.nodes : [];
    if (nodes.length < 2) return '';
    const viz = window.KizukiPersonVisuals || null;
    if (!viz || typeof viz.renderEgoGraphSvg !== 'function') return '';
    let egoSvg = '';
    try {
      egoSvg = viz.renderEgoGraphSvg(ego);
    } catch (_) {
      return '';
    }
    if (!egoSvg) return '';
    const personNodes = nodes.filter((n) => n && n.kind === 'person' && n.key).length;
    const metaLabel = personNodes > 0 ? personNodes + ' people \u00b7 ' + nodes.length + ' nodes' : nodes.length + ' connected';
    return (
      '<section class="visual-panel is-ego is-full' + (compact ? ' is-compact' : '') + '" aria-label="Ego-network constellation">' +
      '<header class="visual-panel-head">' +
      '<h3 class="detail-kicker">EGO-NETWORK CONSTELLATION</h3>' +
      '<div class="composer-actions">' +
      '<span class="pv-meta-pill tabular">' + escHtml(metaLabel) + '</span>' +
      '<span class="pv-meta-pill">Click node to jump</span>' +
      (compact ? '<button type="button" class="btn-ghost btn-xs" data-dossier-tab="network">Network &amp; Loops &rarr;</button>' : '') +
      '</div>' +
      '</header>' +
      egoSvg +
      '</section>'
    );
  }

  function renderOverviewTab(dossier, person, wm, schemaVersion, claims, claimsTotal, timeline, meetings) {
    const key = String(person.key || state.selectedPersonKey || '');
    const name = stripEmDash(person.name || key || 'Person');
    const timelineTotal = Number((dossier && dossier.timeline_total) ?? person.message_count ?? timeline.length ?? 0);
    const visualDeckHtml = renderProfileVisualDeck(dossier, person, wm, schemaVersion, claimsTotal, timelineTotal, meetings);
    const egoCompactHtml = renderEgoConstellationPanel(dossier, { compact: true });

    if (schemaVersion === 'none') {
      const recentMsgsHtml =
        timeline.length === 0
          ? '<p class="panel-subtitle">No cross-channel messages indexed yet.</p>'
          : '<div class="dossier-timeline">' +
            timeline
              .slice(0, 6)
              .map((m) => renderTimelineMessageHtml(m, name))
              .join('') +
            '</div>';
      const claimsPreviewHtml =
        claims.length === 0
          ? '<p class="panel-subtitle">No SQLite world claims indexed yet.</p>'
          : '<div class="claim-list">' +
            claims
              .slice(0, 6)
              .map((c) => renderClaimCardHtml(c))
              .join('') +
            '</div>';
      return (
        visualDeckHtml +
        renderEmptyProfileBanner(person, key, claimsTotal, { deepen: false }) +
        '<section class="detail-section">' +
        '<div class="detail-section-head">' +
        '<h3 class="detail-kicker">Recent Cross-Channel Messages</h3>' +
        '<button type="button" class="btn-ghost btn-xs" data-dossier-tab="history">Open Full History &rarr;</button>' +
        '</div>' +
        recentMsgsHtml +
        '</section>' +
        (claims.length > 0
          ? '<section class="detail-section">' +
            '<div class="detail-section-head">' +
            '<h3 class="detail-kicker">Kizuki World Claims</h3>' +
            '<span class="detail-section-meta tabular">' + formatCompact(claimsTotal) + '</span>' +
            '</div>' +
            claimsPreviewHtml +
            '</section>'
          : '') +
        egoCompactHtml
      );
    }

    const canonicalRead = stripEmDash(wm.canonical_read || wm.summary || '').trim();
    const operatingLoop = asCleanList(wm.operating_loop);
    const ourLeverage = asCleanList(wm.our_leverage);
    const theirLeverage = asCleanList(wm.their_leverage);
    const tastes = asCleanList(wm.tastes_preferences);
    const philosophies = asCleanList(wm.philosophies_decision_model);

    // Goals & Motivations (supports { explicit, inferred } or { observed, inferred } or flat array)
    let goalsExplicit = [];
    let goalsInferred = [];
    if (wm.goals_motivations && typeof wm.goals_motivations === 'object' && !Array.isArray(wm.goals_motivations)) {
      goalsExplicit = asCleanList(wm.goals_motivations.explicit || wm.goals_motivations.observed || wm.goals_motivations.explicitly_observed);
      goalsInferred = asCleanList(wm.goals_motivations.inferred || wm.goals_motivations.hypothesized);
    } else {
      goalsExplicit = asCleanList(wm.goals_explicit || wm.goals_motivations);
      goalsInferred = asCleanList(wm.goals_inferred);
    }

    // At a Glance (table rows or key-value object or fallback Why They Matter)
    let glanceHtml = '';
    const glanceRows = [];
    if (Array.isArray(wm.at_a_glance)) {
      for (const row of wm.at_a_glance) {
        if (row && typeof row === 'object') {
          const k = stripEmDash(row.label || row.field || row.key || row.dimension || '').trim();
          const v = stripEmDash(row.value || row.detail || row.read || '').trim();
          if (k || v) glanceRows.push([k || 'Field', v || '--']);
        } else if (typeof row === 'string' && row.trim()) {
          const idx = row.indexOf(':');
          if (idx > 0) glanceRows.push([row.slice(0, idx).trim(), row.slice(idx + 1).trim()]);
          else glanceRows.push(['Note', row.trim()]);
        }
      }
    } else if (wm.at_a_glance && typeof wm.at_a_glance === 'object') {
      for (const [k, v] of Object.entries(wm.at_a_glance)) {
        if (v !== null && v !== undefined && String(v).trim()) {
          glanceRows.push([k.replace(/_/g, ' '), String(v)]);
        }
      }
    }
    const whyMatter = asCleanList(wm.why_they_matter);
    if (glanceRows.length > 0) {
      glanceHtml =
        '<div class="wm-kv-wrap"><table class="wm-kv-table"><tbody>' +
        glanceRows
          .map(
            (r) =>
              '<tr><th>' +
              renderRichInline(r[0] || '') +
              '</th><td>' +
              renderRichInline(r[1] || '--') +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>';
    } else if (whyMatter.length > 0) {
      glanceHtml = renderBulletListHtml(whyMatter, '');
    } else {
      glanceHtml = '<p class="panel-subtitle">No at-a-glance summary captured yet.</p>';
    }

    const ownerNotes = Array.isArray(wm.owner_notes) ? wm.owner_notes : [];
    const canonicalBadgeHtml =
      schemaVersion === 'v2'
        ? '<span class="person-depth-badge is-v2">World Model v2</span>'
        : schemaVersion === 'lifeos'
        ? '<span class="person-depth-badge is-lifeos">LifeOS Card</span>'
        : '';

    const canonicalSection =
      '<section class="wm-canonical-read">' +
      '<div class="detail-section-head">' +
      '<h3 class="detail-kicker">Canonical Read</h3>' +
      canonicalBadgeHtml +
      '</div>' +
      (canonicalRead
        ? '<div class="wm-canonical-prose">' + renderMarkdownHtml(canonicalRead) + '</div>'
        : '<p class="panel-subtitle">No canonical summary written yet.</p>') +
      (operatingLoop.length > 0
        ? '<div class="wm-operating-loop">' +
          '<div class="wm-subhead">Operating Loop</div>' +
          renderBulletListHtml(operatingLoop, '') +
          '</div>'
        : '') +
      '</section>';

    const leveragePreviewSection =
      ourLeverage.length > 0 || theirLeverage.length > 0
        ? '<section class="detail-section">' +
          '<div class="detail-section-head">' +
          '<h3 class="detail-kicker">Asymmetric Leverage Preview</h3>' +
          '<button type="button" class="btn-ghost btn-xs" data-dossier-tab="leverage">Full Leverage &amp; Playbook &rarr;</button>' +
          '</div>' +
          '<div class="leverage-grid">' +
          '<div class="leverage-card is-ours">' +
          '<h4 class="wm-card-title">Our Edge / How We Win</h4>' +
          renderBulletListHtml(ourLeverage.slice(0, 3), 'No edge signals yet.') +
          '</div>' +
          '<div class="leverage-card is-theirs">' +
          '<h4 class="wm-card-title">Their Edge / Exposure &amp; Watch-Outs</h4>' +
          renderBulletListHtml(theirLeverage.slice(0, 3), 'No exposure watch-outs yet.') +
          '</div>' +
          '</div>' +
          '</section>'
        : renderEmptyProfileBanner(person, key, claimsTotal, { deepen: true });

    const psychGrid =
      '<div class="wm-grid-2">' +
      '<section class="wm-card">' +
      '<h3 class="wm-card-title">Tastes, Preferences &amp; Sensibilities</h3>' +
      renderBulletListHtml(tastes, 'Run Deepen Profile to extract tastes and sensibilities.') +
      '</section>' +
      '<section class="wm-card">' +
      '<h3 class="wm-card-title">Philosophies &amp; Decision Model</h3>' +
      renderBulletListHtml(philosophies, 'Run Deepen Profile to map their decision model.') +
      '</section>' +
      '</div>';

    const motivationsBody =
      goalsExplicit.length > 0 || goalsInferred.length > 0
        ? (goalsExplicit.length > 0
            ? '<div class="wm-subhead">Explicitly observed</div>' + renderBulletListHtml(goalsExplicit, '')
            : '') +
          (goalsInferred.length > 0
            ? '<div class="wm-subhead">Inferred</div>' + renderBulletListHtml(goalsInferred, '')
            : '')
        : '<p class="panel-subtitle">No explicit or inferred goals recorded yet.</p>';

    const motivationsGrid =
      '<div class="wm-grid-2">' +
      '<section class="wm-card">' +
      '<h3 class="wm-card-title">Goals &amp; Motivations</h3>' +
      motivationsBody +
      '</section>' +
      '<section class="wm-card">' +
      '<h3 class="wm-card-title">' + (glanceRows.length > 0 ? 'At a Glance' : 'Why They Matter') + '</h3>' +
      glanceHtml +
      '</section>' +
      '</div>';

    const ownerNotesSection =
      ownerNotes.length > 0
        ? '<section class="wm-card wm-owner-notes">' +
          '<div class="detail-section-head">' +
          '<h3 class="wm-card-title">Owner Observations</h3>' +
          '<span class="detail-section-meta tabular">' + ownerNotes.length + ' verified</span>' +
          '</div>' +
          '<div class="wm-owner-notes-list">' +
          ownerNotes
            .map((n) => {
              if (typeof n === 'string') {
                return '<div class="wm-owner-note-item"><span class="badge badge-neutral">Note</span><span class="wm-owner-note-text">' + renderRichInline(n) + '</span></div>';
              }
              const kindLabel = stripEmDash(n.kind || 'insight').replace(/_/g, ' ');
              const dateLabel = n.date ? formatShortDate(n.date) : n.created_at ? formatShortDate(n.created_at) : '';
              const text = stripEmDash(n.text || n.note || n.content || '').trim();
              if (!text) return '';
              return (
                '<div class="wm-owner-note-item">' +
                '<span class="badge badge-neutral">' + escHtml(kindLabel) + '</span>' +
                (dateLabel ? '<span class="wm-owner-note-date tabular">' + escHtml(dateLabel) + '</span>' : '') +
                '<span class="wm-owner-note-text">' + renderRichInline(text) + '</span>' +
                '</div>'
              );
            })
            .filter(Boolean)
            .join('') +
          '</div>' +
          '</section>'
        : '';

    return visualDeckHtml + canonicalSection + leveragePreviewSection + psychGrid + motivationsGrid + ownerNotesSection + egoCompactHtml;
  }

  function renderLeverageTab(person, wm, claimsTotal) {
    const key = String(person.key || state.selectedPersonKey || '');
    const ourLeverage = asCleanList(wm.our_leverage);
    const whyTheyMatter = asCleanList(wm.why_they_matter);
    const theirLeverage = asCleanList(wm.their_leverage);
    const doNotAssume = asCleanList(wm.do_not_assume);
    const trustBuilders = asCleanList(wm.trust_builders);
    const degraders = asCleanList(wm.degraders);
    const playbook = asCleanList(wm.engagement_playbook);

    const hypothesesRaw = Array.isArray(wm.hypotheses) ? wm.hypotheses : [];
    const hypothesisRows = hypothesesRaw
      .map((h) => {
        if (!h || typeof h !== 'object') return null;
        const judgment = h.judgment || h.hypothesis || h.claim || h.topic || '';
        const read = h.current_read || h.read || h.assessment || h.status || '';
        const conf = h.confidence !== undefined && h.confidence !== null ? formatConfidence(h.confidence) : '--';
        const falsifier = h.falsifier || h.update_signal || h.falsifier_signal || h.disconfirming_evidence || '';
        if (!judgment && !read) return null;
        return [judgment, read, conf, falsifier];
      })
      .filter(Boolean);

    const evidenceRaw = Array.isArray(wm.evidence_table)
      ? wm.evidence_table
      : Array.isArray(wm.evidence_interpretation)
      ? wm.evidence_interpretation
      : [];
    const evidenceRows = evidenceRaw
      .map((e) => {
        if (!e || typeof e !== 'object') return null;
        const sig = e.evidence || e.signal || e.observation || e.fact || '';
        const interp = e.interpretation || e.meaning || e.read || e.implication || '';
        const src = e.source || e.date || e.confidence || '';
        if (!sig && !interp) return null;
        return [sig, interp, src];
      })
      .filter(Boolean);

    const missingStrategic =
      ourLeverage.length === 0 ||
      theirLeverage.length === 0 ||
      trustBuilders.length === 0 ||
      playbook.length === 0 ||
      hypothesisRows.length === 0;

    const oursCombined = [...ourLeverage, ...whyTheyMatter.filter((w) => !ourLeverage.includes(w))];
    const theirsCombined = [...theirLeverage, ...doNotAssume.filter((d) => !theirLeverage.includes(d))];

    const playbookHtml =
      playbook.length === 0
        ? '<p class="panel-subtitle">No numbered engagement playbook yet.</p>'
        : '<ol class="playbook-list">' +
          playbook
            .map((step, idx) => {
              const num = String(idx + 1).padStart(2, '0');
              return (
                '<li class="playbook-item">' +
                '<span class="playbook-step-num tabular">' + num + '</span>' +
                '<span class="playbook-step-body">' + renderRichInline(step) + '</span>' +
                '</li>'
              );
            })
            .join('') +
          '</ol>';

    return (
      (missingStrategic ? renderEmptyProfileBanner(person, key, claimsTotal, { deepen: true }) : '') +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Asymmetric Leverage Map</h3></div>' +
      '<div class="leverage-grid">' +
      '<div class="leverage-card is-ours">' +
      '<h4 class="wm-card-title">Our Edge / How We Win &amp; Align</h4>' +
      renderBulletListHtml(oursCombined, 'No leverage points synthesized yet.') +
      '</div>' +
      '<div class="leverage-card is-theirs">' +
      '<h4 class="wm-card-title">Their Edge / Exposure, Dependencies &amp; Watch-Outs</h4>' +
      renderBulletListHtml(theirsCombined, 'No exposure watch-outs synthesized yet.') +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Trust Dynamics</h3></div>' +
      '<div class="trust-grid">' +
      '<div class="trust-card is-build">' +
      '<h4 class="wm-card-title">What Builds Trust</h4>' +
      renderBulletListHtml(trustBuilders, 'No trust builders captured yet.') +
      '</div>' +
      '<div class="trust-card is-degrade">' +
      '<h4 class="wm-card-title">What Degrades Relationship</h4>' +
      renderBulletListHtml(degraders, 'No relationship degraders captured yet.') +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Engagement Playbook</h3><span class="detail-section-meta tabular">' +
      playbook.length +
      ' steps</span></div>' +
      playbookHtml +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">World-Model Judgments &amp; Falsifiable Hypotheses</h3><span class="detail-section-meta tabular">' +
      hypothesisRows.length +
      '</span></div>' +
      renderGfmTable(
        ['Judgment', 'Current Read', 'Confidence', 'Falsifier / Update Signal'],
        hypothesisRows,
        'No falsifiable hypotheses synthesized yet.'
      ) +
      '</section>' +
      (evidenceRows.length > 0
        ? '<section class="detail-section">' +
          '<div class="detail-section-head"><h3 class="detail-kicker">Evidence &amp; Interpretation</h3><span class="detail-section-meta tabular">' +
          evidenceRows.length +
          '</span></div>' +
          renderGfmTable(['Evidence', 'Interpretation', 'Source'], evidenceRows, '') +
          '</section>'
        : '')
    );
  }

  function renderHistoryTab(dossier, person, wm, timeline, claims, claimsTotal) {
    const name = stripEmDash(person.name || state.selectedPersonKey || 'Person');
    const relTimeline = Array.isArray(wm.relationship_timeline) ? wm.relationship_timeline : [];

    const sentimentHtml =
      relTimeline.length > 0
        ? '<section class="detail-section">' +
          '<div class="detail-section-head"><h3 class="detail-kicker">Relationship Sentiment Trajectory Arc</h3><span class="detail-section-meta tabular">' +
          relTimeline.length +
          ' milestones</span></div>' +
          '<div class="sentiment-timeline">' +
          relTimeline
            .map((ev) => {
              if (!ev || typeof ev !== 'object') return '';
              const rawSent = String(ev.sentiment || ev.tone || 'neutral').toLowerCase();
              const sentCls = rawSent.includes('pos') || rawSent === 'up' ? 'is-positive' : rawSent.includes('neg') || rawSent === 'down' ? 'is-negative' : 'is-neutral';
              const sentGlyph = sentCls === 'is-positive' ? '\u25b2' : sentCls === 'is-negative' ? '\u25bc' : '\u2022';
              const sentWord = sentCls === 'is-positive' ? 'positive' : sentCls === 'is-negative' ? 'negative' : 'neutral';
              const dateStr = stripEmDash(ev.date || ev.period || ev.when || '').trim();
              const titleStr = stripEmDash(ev.title || ev.label || '').trim();
              const summary = stripEmDash(ev.summary || ev.event || ev.text || ev.title || '').trim();
              if (!summary) return '';
              return (
                '<div class="sentiment-item ' + sentCls + '">' +
                '<span class="sentiment-marker ' + sentCls + '" aria-hidden="true">' + sentGlyph + '</span>' +
                '<div class="sentiment-head">' +
                '<span class="sentiment-date tabular">' + escHtml(dateStr || '--') + '</span>' +
                '<span class="sentiment-marker ' + sentCls + '">' + sentGlyph + ' ' + escHtml(sentWord) + '</span>' +
                '</div>' +
                (titleStr && titleStr !== summary ? '<div class="sentiment-label">' + renderRichInline(titleStr) + '</div>' : '') +
                '<p class="sentiment-note">' + renderRichInline(summary) + '</p>' +
                '</div>'
              );
            })
            .filter(Boolean)
            .join('') +
          '</div>' +
          '</section>'
        : '';

    const activeFilter = state.peopleHistoryFilter || 'all';
    const qLower = (state.peopleHistoryQuery || '').trim().toLowerCase();
    const filterDefs = [
      { key: 'all', label: 'All' },
      { key: 'whatsapp', label: 'WA', dot: 'ch-wa' },
      { key: 'telegram', label: 'TG', dot: 'ch-tg' },
      { key: 'imessage', label: 'iMsg', dot: 'ch-imsg' },
      { key: 'gmail', label: 'Gmail', dot: 'ch-gmail' },
      { key: 'claims', label: 'Claims' },
    ];

    const filteredClaims = qLower
      ? claims.filter((c) => {
          const hay = [c.predicate, c.kind, c.text, c.object_text, c.claim, c.summary].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(qLower);
        })
      : claims;

    const timelineTotal = Number(dossier.timeline_total ?? (activeFilter === 'all' && !qLower ? person.message_count ?? timeline.length : timeline.length));
    const showingCount = activeFilter === 'claims' ? filteredClaims.length : timeline.length;
    const totalCountForBar = activeFilter === 'claims' ? (qLower ? filteredClaims.length : Math.max(claimsTotal, filteredClaims.length)) : Math.max(timelineTotal, timeline.length);

    const toolbarHtml =
      '<div class="history-toolbar">' +
      '<div class="history-toolbar-top">' +
      '<label for="people-history-search" class="sr-only">Search messages and claims</label>' +
      '<input id="people-history-search" class="history-search-input" type="search" placeholder="Search messages &amp; claims..." value="' +
      escHtml(state.peopleHistoryQuery || '') +
      '" autocomplete="off" spellcheck="false">' +
      '<span class="history-count tabular">Showing ' +
      escHtml(formatCompact(showingCount)) +
      ' of ' +
      escHtml(formatCompact(totalCountForBar)) +
      '</span>' +
      '</div>' +
      '<div class="history-filter-pills" role="group" aria-label="Filter dossier history">' +
      filterDefs
        .map((f) => {
          const active = activeFilter === f.key;
          return (
            '<button type="button" class="channel-pill' +
            (active ? ' is-active' : '') +
            '" data-history-filter="' +
            escHtml(f.key) +
            '">' +
            (f.dot ? '<span class="ch-dot ' + escHtml(f.dot) + '" aria-hidden="true"></span>' : '') +
            escHtml(f.label) +
            '</button>'
          );
        })
        .join('') +
      '</div>' +
      '</div>';

    let bodyHtml = '';
    if (activeFilter === 'claims') {
      bodyHtml =
        filteredClaims.length === 0
          ? '<p class="panel-subtitle">No Kizuki SQLite claims match this filter.</p>'
          : '<div class="claim-list">' + filteredClaims.map((c) => renderClaimCardHtml(c)).join('') + '</div>';
    } else {
      const hasMore =
        dossier.timeline_has_more !== undefined
          ? Boolean(dossier.timeline_has_more)
          : timeline.length < timelineTotal;
      const msgsHtml =
        timeline.length === 0
          ? '<p class="panel-subtitle">No messages match this channel or search query.</p>'
          : '<div class="dossier-timeline">' +
            timeline.map((m) => renderTimelineMessageHtml(m, name)).join('') +
            '</div>';
      const loadMoreHtml = hasMore
        ? '<button type="button" class="history-load-more" id="btn-people-load-more" data-load-more-history="true"' +
          (state.peopleHistoryLoadingMore ? ' disabled' : '') +
          '>' +
          (state.peopleHistoryLoadingMore ? 'Loading messages...' : 'Load 80 more messages') +
          '</button>'
        : '';

      const inlineClaimsHtml =
        activeFilter === 'all' && filteredClaims.length > 0
          ? '<section class="detail-section">' +
            '<div class="detail-section-head">' +
            '<h3 class="detail-kicker">Kizuki SQLite World Claims</h3>' +
            '<button type="button" class="btn-ghost btn-xs" data-history-filter="claims">View all ' +
            escHtml(formatCompact(Math.max(claimsTotal, filteredClaims.length))) +
            ' claims &rarr;</button>' +
            '</div>' +
            '<div class="claim-list">' +
            filteredClaims.slice(0, 12).map((c) => renderClaimCardHtml(c)).join('') +
            '</div>' +
            '</section>'
          : '';

      bodyHtml = msgsHtml + loadMoreHtml + inlineClaimsHtml;
    }

    return sentimentHtml + toolbarHtml + bodyHtml;
  }

  function renderNetworkTab(dossier, wm, meetings, relatedDocs) {
    const openLoopsRaw = Array.isArray(wm.open_loops) ? wm.open_loops : [];
    const openLoopRows = openLoopsRaw
      .map((l) => {
        if (typeof l === 'string' && l.trim()) return [l.trim(), 'Open', '--'];
        if (!l || typeof l !== 'object') return null;
        const loopText = l.loop || l.open_loop || l.title || l.text || l.item || '';
        const loopState = l.state || l.status || 'Open';
        const ownerNext = l.owner || l.next_evidence || l.owner_next_evidence || l.next_step || '--';
        if (!loopText) return null;
        return [loopText, loopState, ownerNext];
      })
      .filter(Boolean);

    const contradictions = asCleanList(wm.contradictions);
    const collaborators = Array.isArray(dossier.collaborators)
      ? dossier.collaborators
      : Array.isArray(wm.collaborators)
      ? wm.collaborators
      : [];

    const collabHtml =
      collaborators.length === 0
        ? '<p class="panel-subtitle">No shared collaborator dyads detected yet.</p>'
        : '<div class="collab-grid">' +
          collaborators
            .slice(0, 24)
            .map((c) => {
              const slug = String(c.key || c.slug || c.name || '').trim();
              const cname = stripEmDash(c.name || slug);
              const sharedCount = Number(c.shared_meetings ?? c.meetings_count ?? c.count ?? 0);
              return (
                '<button type="button" class="collab-chip" data-open-person="' +
                escHtml(slug) +
                '">' +
                '<span class="collab-chip-left">' +
                '<span class="person-avatar is-sm">' + escHtml(safePersonInitials(c, cname)) + '</span>' +
                '<span class="collab-chip-name">' + escHtml(cname) + '</span>' +
                '</span>' +
                (sharedCount > 0 ? '<span class="collab-chip-count tabular">' + escHtml(String(sharedCount)) + ' mtgs</span>' : '') +
                '</button>'
              );
            })
            .join('') +
          '</div>';

    const meetingsHtml =
      meetings.length === 0
        ? '<p class="panel-subtitle">No shared calendar meetings found.</p>'
        : '<div class="related-docs-list">' +
          meetings
            .slice(0, 20)
            .map((m) => {
              const isUpcoming = Boolean(m.is_upcoming) || (m.start && Date.parse(m.start) > Date.now());
              const badge = isUpcoming
                ? '<span class="badge-countdown">' + escHtml(m.countdown || 'Upcoming') + '</span>'
                : '';
              const when = m.time_label || formatScheduleTime(m.start, false, false) || formatRelativeTime(m.start);
              return (
                '<div class="related-doc-item">' +
                '<span class="related-doc-title-wrap">' +
                badge +
                '<span>' + escHtml(stripEmDash(m.title || 'Meeting')) + '</span>' +
                '</span>' +
                '<span class="related-doc-path tabular">' + escHtml(when) + '</span>' +
                '</div>'
              );
            })
            .join('') +
          '</div>';

    const docsHtml =
      relatedDocs.length === 0
        ? '<p class="panel-subtitle">No linked Obsidian, Apple Notes, or Vault documents found.</p>'
        : '<div class="related-docs-list">' +
          relatedDocs
            .slice(0, 16)
            .map((d) => {
              const pth = typeof d === 'string' ? d : d.path || '';
              const title = typeof d === 'string' ? titleFromPath(d) : d.title || titleFromPath(pth);
              return (
                '<button type="button" class="related-doc-item" data-open-doc="' + escHtml(pth) + '">' +
                '<span>' + escHtml(stripEmDash(title)) + '</span>' +
                '<span class="related-doc-path">' + escHtml(d.category || '.md') + '</span>' +
                '</button>'
              );
            })
            .join('') +
          '</div>';

    const egoPanelHtml = renderEgoConstellationPanel(dossier, { compact: false });

    return (
      egoPanelHtml +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Open Loops</h3><span class="detail-section-meta tabular">' +
      openLoopRows.length +
      '</span></div>' +
      renderGfmTable(['Open Loop', 'State', 'Owner / Next Evidence'], openLoopRows, 'No open loops tracked for this person.') +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Contradictions &amp; Changing State</h3><span class="detail-section-meta tabular">' +
      contradictions.length +
      '</span></div>' +
      renderBulletListHtml(contradictions, 'No active contradictions or shifting positions logged.') +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Collaborators &amp; Relationship Dyads</h3><span class="detail-section-meta tabular">' +
      collaborators.length +
      '</span></div>' +
      collabHtml +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Shared Calendar Meetings</h3><span class="detail-section-meta tabular">' +
      meetings.length +
      '</span></div>' +
      meetingsHtml +
      '</section>' +
      '<section class="detail-section">' +
      '<div class="detail-section-head"><h3 class="detail-kicker">Related Vault, Obsidian &amp; Apple Notes</h3><span class="detail-section-meta tabular">' +
      relatedDocs.length +
      '</span></div>' +
      docsHtml +
      '</section>'
    );
  }

  function renderFullCardTab(person, wm, claimsTotal) {
    const key = String(person.key || state.selectedPersonKey || '');
    const md = stripEmDash(wm.full_markdown || '').trim();
    if (!md) {
      return renderEmptyProfileBanner(person, key, claimsTotal, { deepen: false });
    }
    const sourcePath = String(wm.source_path || '').trim();
    return (
      '<section class="detail-section">' +
      '<div class="detail-section-head">' +
      '<h3 class="detail-kicker">Full World-Model Card (.md)</h3>' +
      '<div class="composer-actions">' +
      (sourcePath
        ? '<button type="button" class="btn-secondary btn-xs" data-open-doc="' + escHtml(sourcePath) + '">Open in Vault</button>'
        : '') +
      '<button type="button" class="btn-ghost btn-xs" data-copy-person-md="true">Copy Markdown</button>' +
      '</div>' +
      '</div>' +
      '<div class="markdown-prose wm-full-card">' + renderMarkdownHtml(md) + '</div>' +
      '</section>'
    );
  }

  function renderPersonDossier(dossier) {
    const bodyEl = $('#people-detail-body');
    const crumbEl = $('#people-breadcrumb');
    const noteBtn = $('#btn-people-note');
    const prepBtn = $('#btn-people-prep');
    const draftBtn = $('#btn-people-draft');
    const synthBtn = $('#btn-people-synthesize');
    if (!bodyEl) return;

    const p = (dossier && dossier.person) || {};
    const wm = (dossier && dossier.world_model) || {};
    const key = String(p.key || state.selectedPersonKey || '');
    const name = stripEmDash(p.name || key || 'Person');
    const channels = Array.isArray(p.channels) ? p.channels : [];
    const timeline = Array.isArray(dossier && dossier.timeline) ? dossier.timeline : [];
    const meetings = Array.isArray(dossier && dossier.meetings) ? dossier.meetings : [];
    const relatedDocs = Array.isArray(dossier && dossier.related_docs) ? dossier.related_docs : [];
    const claims = Array.isArray(dossier && dossier.sqlite_claims) ? dossier.sqlite_claims : [];
    const claimsTotal = Number((dossier && dossier.sqlite_claims_total) ?? p.claim_count ?? claims.length ?? 0);
    const schemaVersion = normalizeProfileTier(p, wm);
    const isProfiled = schemaVersion === 'v2' || schemaVersion === 'lifeos';
    const isSynthBusy = state.peopleSynthesizingKey === key;

    if (crumbEl) {
      crumbEl.innerHTML =
        '<span class="breadcrumb-parent">People</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-leaf">' +
        escHtml(name) +
        '</span>';
    }
    if (noteBtn) {
      noteBtn.hidden = false;
      noteBtn.classList.toggle('is-active', Boolean(state.peopleNoteOpen));
    }
    if (prepBtn) prepBtn.hidden = false;
    if (draftBtn) draftBtn.hidden = false;
    if (synthBtn) {
      synthBtn.hidden = false;
      synthBtn.disabled = isSynthBusy;
      synthBtn.textContent = isSynthBusy ? 'Synthesizing...' : isProfiled ? 'Deepen Profile' : 'Synthesize Profile';
    }

    const visuals = (dossier && dossier.profile_visuals && typeof dossier.profile_visuals === 'object') ? dossier.profile_visuals : {};
    const archetype = visuals.archetype && typeof visuals.archetype === 'object' ? visuals.archetype : {};
    const archetypeTitle = stripEmDash(archetype.title || '').trim();
    const archetypeTagline = stripEmDash(archetype.tagline || '').trim();

    const roleParts = [stripEmDash(p.role || wm.role || '').trim(), stripEmDash(p.org || wm.org || '').trim()].filter(Boolean);
    const roleText = roleParts.length > 0 ? roleParts.join(' \u00b7 ') : archetypeTagline;
    const roleSubHtml = roleText ? '<div class="dossier-role-sub profile-role-line">' + escHtml(roleText) + '</div>' : '';
    const taglineSubHtml =
      roleParts.length > 0 && archetypeTagline && archetypeTagline.toLowerCase() !== roleText.toLowerCase()
        ? '<p class="profile-subtitle">' + escHtml(archetypeTagline) + '</p>'
        : '';

    const tierRaw = p.relationship_tier || wm.relationship_tier || p.tier;
    const tierRingCls = personTierRingClass(tierRaw);
    const tierBadgeHtml = formatPersonTierBadge(tierRaw, false);
    const depthBadgeHtml =
      schemaVersion === 'v2'
        ? '<span class="person-depth-badge is-v2">World Model v2</span>'
        : schemaVersion === 'lifeos'
        ? '<span class="person-depth-badge is-lifeos">LifeOS Card</span>'
        : claimsTotal > 0
        ? '<span class="person-depth-badge is-claims">Claims + Live</span>'
        : '<span class="person-depth-badge is-live">Live Messages</span>';

    const rawConf = wm.confidence ?? p.confidence;
    let confBadgeHtml = '';
    if (rawConf !== undefined && rawConf !== null && String(rawConf).trim()) {
      const confText = typeof rawConf === 'number' ? formatConfidence(rawConf) : stripEmDash(String(rawConf));
      const confLower = confText.toLowerCase();
      const confNum = typeof rawConf === 'number' ? (rawConf <= 1 ? rawConf * 100 : rawConf) : parseFloat(confText);
      const confTierCls =
        confLower.includes('high') || (Number.isFinite(confNum) && confNum >= 75)
          ? ' is-high'
          : confLower.includes('med') || (Number.isFinite(confNum) && confNum >= 45)
          ? ' is-medium'
          : ' is-low';
      confBadgeHtml = '<span class="wm-confidence-pill' + confTierCls + '">Confidence: ' + escHtml(confText) + '</span>';
    }

    const traj = normalizeTrajectory(wm.trajectory || p.trajectory);
    const trajPillHtml = traj
      ? '<span class="person-trajectory ' + traj.cls + '">' + traj.arrow + ' ' + escHtml(traj.label) + '</span>'
      : '';

    const channelBadges = channels
      .map((c) => {
        const info = channelInfo(c);
        return '<span class="badge badge-neutral"><span class="ch-dot ' + escHtml(info.dot) + '"></span>' + escHtml(info.label) + '</span>';
      })
      .join('');

    const upcomingFallback =
      meetings
        .filter((m) => {
          if (!m || !m.start) return false;
          const t = new Date(m.start).getTime();
          return Number.isFinite(t) && t > Date.now();
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0] || null;
    const nextMeeting = p.next_meeting || (dossier && dossier.next_meeting) || upcomingFallback;
    const nextMeetingHtml = formatNextMeetingPill(nextMeeting);
    const lastSeenVal = formatHistoricalLastSeen(Object.assign({}, p, { next_meeting: nextMeeting }));
    const historySpan = formatHistorySpan(p, wm);

    const aiBoxHtml = state.peopleAiOutput
      ? '<section class="detail-section"><div class="detail-brief-card">' +
        '<div class="detail-section-head">' +
        '<div class="composer-actions">' +
        '<span class="badge badge-cyan">' + escHtml(state.peopleAiOutput.engine || 'Local Draft') + '</span>' +
        '<span class="badge badge-neutral">Local only</span>' +
        (state.peopleAiOutput.latency_ms ? '<span class="detail-section-meta tabular">' + escHtml(formatLatency(state.peopleAiOutput.latency_ms)) + '</span>' : '') +
        '</div>' +
        '<div class="composer-actions">' +
        '<button type="button" class="btn-ghost btn-xs" data-copy-text="' + escHtml(state.peopleAiOutput.md) + '">Copy</button>' +
        '<button type="button" class="btn-secondary btn-xs" data-save-person-draft="true">Save to Vault</button>' +
        '<button type="button" class="btn-ghost btn-xs" data-dismiss-person-ai="true" aria-label="Dismiss output">&times;</button>' +
        '</div>' +
        '</div>' +
        '<div class="markdown-prose">' + renderMarkdownHtml(state.peopleAiOutput.md) + '</div>' +
        '</div></section>'
      : '';

    const timelineTotal = Number((dossier && dossier.timeline_total) ?? p.message_count ?? timeline.length ?? 0);
    const historyCountLabel = formatCompact(timelineTotal + claimsTotal);
    const validTabs = new Set(['overview', 'leverage', 'history', 'network', 'card']);
    const activeTab = validTabs.has(state.peopleDossierTab) ? state.peopleDossierTab : 'overview';
    const subtabs = [
      { key: 'overview', label: 'Overview', count: '' },
      { key: 'leverage', label: 'Leverage & Playbook', count: '' },
      { key: 'history', label: 'History', count: historyCountLabel },
      { key: 'network', label: 'Network & Loops', count: '' },
      { key: 'card', label: 'Full Card .md', count: '' },
    ];

    const subtabsHtml =
      '<nav class="dossier-subtabs" role="tablist" aria-label="Dossier workbench sections">' +
      subtabs
        .map((t) => {
          const active = activeTab === t.key;
          return (
            '<button type="button" class="dossier-subtab' +
            (active ? ' is-active' : '') +
            '" role="tab" aria-selected="' +
            (active ? 'true' : 'false') +
            '" data-dossier-tab="' +
            escHtml(t.key) +
            '">' +
            '<span>' + escHtml(t.label) + '</span>' +
            (t.count ? '<span class="dossier-subtab-count tabular">' + escHtml(t.count) + '</span>' : '') +
            '</button>'
          );
        })
        .join('') +
      '</nav>';

    let tabBodyHtml = '';
    if (activeTab === 'leverage') {
      tabBodyHtml = renderLeverageTab(p, wm, claimsTotal);
    } else if (activeTab === 'history') {
      tabBodyHtml = renderHistoryTab(dossier, p, wm, timeline, claims, claimsTotal);
    } else if (activeTab === 'network') {
      tabBodyHtml = renderNetworkTab(dossier, wm, meetings, relatedDocs);
    } else if (activeTab === 'card') {
      tabBodyHtml = renderFullCardTab(p, wm, claimsTotal);
    } else {
      tabBodyHtml = renderOverviewTab(dossier, p, wm, schemaVersion, claims, claimsTotal, timeline, meetings);
    }

    const contactBarHtml = renderContactLinksBar(visuals.contact_links, wm.handles);

    // Contract C3: 18px editorial relationship summary sentence
    const ledger = (visuals && visuals.ledger && typeof visuals.ledger === 'object') ? visuals.ledger : null;
    let relationshipSummary = ledger && typeof ledger.summary_sentence === 'string'
      ? stripEmDash(ledger.summary_sentence).trim()
      : '';
    if (!relationshipSummary && wm.canonical_read) {
      const firstSent = stripEmDash(String(wm.canonical_read))
        .replace(/[#*_`>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/(?<=[.!?])\s+/)[0];
      if (firstSent && firstSent.length >= 16) relationshipSummary = firstSent;
    }
    if (!relationshipSummary) {
      const msgTotal = Number(p.message_count ?? timelineTotal ?? 0);
      const chNames = channels.slice(0, 3).map((c) => channelInfo(c).label);
      const parts = [];
      if (roleText) parts.push(roleText);
      if (msgTotal > 0) {
        parts.push(formatCompact(msgTotal) + ' messages' + (chNames.length ? ' across ' + chNames.join(', ') : ''));
      }
      if (historySpan && historySpan !== '--' && historySpan !== 'Unknown') {
        parts.push('spanning ' + historySpan);
      }
      if (parts.length > 0) {
        relationshipSummary = parts.join(', ') + '.';
      }
    }
    const relationshipSummaryHtml = relationshipSummary
      ? '<p class="dossier-relationship-lede">' + escHtml(relationshipSummary) + '</p>'
      : '';

    // Full-width 52-week relationship ribbon (Area 5 KizukiPersonVisuals preferred, fallback KizukiCharts)
    let ribbonSvgHtml = '';
    const pvViz = window.KizukiPersonVisuals || null;
    if (pvViz && typeof pvViz.renderRelationshipLedgerRibbon === 'function' && ledger && Array.isArray(ledger.weeks) && ledger.weeks.length > 0) {
      try { ribbonSvgHtml = pvViz.renderRelationshipLedgerRibbon(ledger, visuals.channel_breakdown, visuals.reciprocity_ratio); } catch (_) { ribbonSvgHtml = ''; }
    } else if (pvViz && typeof pvViz.renderRelationshipLedgerSvg === 'function' && ledger) {
      try { ribbonSvgHtml = pvViz.renderRelationshipLedgerSvg(ledger, visuals); } catch (_) { ribbonSvgHtml = ''; }
    } else if (window.KizukiCharts && typeof window.KizukiCharts.renderRelationshipRibbonSvg === 'function') {
      try { ribbonSvgHtml = window.KizukiCharts.renderRelationshipRibbonSvg(ledger, visuals, p, meetings); } catch (_) { ribbonSvgHtml = ''; }
    }

    const ribbonMetaBits = [];
    if (ledger) {
      if (ledger.last_inbound_unanswered) ribbonMetaBits.push('<span><strong>Reply owed</strong></span>');
      if (Number.isFinite(Number(ledger.drift_z)) && Number(ledger.drift_z) > 1.5) {
        ribbonMetaBits.push('<span>Drift <strong>+' + escHtml(Number(ledger.drift_z).toFixed(1)) + 's</strong></span>');
      }
      if (Number.isFinite(Number(ledger.streak_weeks)) && Number(ledger.streak_weeks) > 0) {
        ribbonMetaBits.push('<span>Streak <strong>' + escHtml(String(ledger.streak_weeks)) + 'w</strong></span>');
      }
      if (ledger.next_touch) {
        ribbonMetaBits.push('<span>Next: <strong>' + escHtml(stripEmDash(String(ledger.next_touch))) + '</strong></span>');
      }
    }
    const ribbonSectionHtml = ribbonSvgHtml
      ? '<section class="dossier-ribbon-section" aria-label="52-week relationship cadence ribbon">' +
        '<div class="dossier-ribbon-head">' +
        '<h3 class="detail-kicker">52-Week Relationship Ledger</h3>' +
        (ribbonMetaBits.length > 0 ? '<div class="dossier-ribbon-metrics tabular">' + ribbonMetaBits.join('') + '</div>' : '') +
        '</div>' +
        '<div class="dossier-ribbon-stage">' + ribbonSvgHtml + '</div>' +
        '</section>'
      : '';

    // Sleek inline definition row (strictly omitting zero-value / empty stats like MEETINGS 0)
    const defItems = [];
    const msgTotalNum = Number(p.message_count ?? timelineTotal ?? 0);
    if (msgTotalNum > 0) defItems.push({ term: 'Messages', val: formatCompact(msgTotalNum) });
    if (claimsTotal > 0) defItems.push({ term: 'World Claims', val: formatCompact(claimsTotal) });
    if (meetings.length > 0) defItems.push({ term: 'Meetings', val: formatCompact(meetings.length) });
    if (lastSeenVal && lastSeenVal !== '--' && lastSeenVal !== 'Unknown' && lastSeenVal !== 'None') {
      defItems.push({ term: 'Last Seen', val: lastSeenVal });
    }
    if (historySpan && historySpan !== '--' && historySpan !== 'Unknown' && historySpan !== 'None') {
      defItems.push({ term: 'Span', val: historySpan });
    }
    const defRowHtml = defItems.length > 0
      ? '<dl class="dossier-def-row">' +
        defItems
          .map(
            (item) =>
              '<div class="dossier-def-pair">' +
              '<dt class="dossier-def-term">' + escHtml(item.term) + '</dt>' +
              '<dd class="dossier-def-val tabular">' + escHtml(item.val) + '</dd>' +
              '</div>'
          )
          .join('') +
        '</dl>'
      : '';

    bodyEl.innerHTML =
      '<div class="detail-inner">' +
      '<header class="profile-banner">' +
      '<div class="profile-banner-top">' +
      '<span class="profile-avatar-xl' + (tierRingCls ? ' ' + tierRingCls : '') + '">' + escHtml(safePersonInitials(p, name)) + '</span>' +
      '<div class="profile-banner-main">' +
      '<div class="profile-name-row">' +
      '<h2 class="detail-title">' + escHtml(name) + '</h2>' +
      (archetypeTitle ? '<span class="profile-archetype-chip">' + escHtml(archetypeTitle) + '</span>' : '') +
      '</div>' +
      roleSubHtml +
      taglineSubHtml +
      '<div class="dossier-meta-badges">' +
      tierBadgeHtml +
      depthBadgeHtml +
      confBadgeHtml +
      trajPillHtml +
      channelBadges +
      nextMeetingHtml +
      '</div>' +
      '</div>' +
      '</div>' +
      contactBarHtml +
      '</header>' +
      relationshipSummaryHtml +
      '<div id="person-prep-slot" class="person-prep-slot" data-slot="person-prep" data-kizuki-slot="person-prep"></div>' +
      renderPersonNoteDrawer() +
      ribbonSectionHtml +
      defRowHtml +
      '<div id="person-signal-visuals-slot" class="kos-people-slot"></div>' +
      '<section class="dossier-section" id="person-board-mentions-slot" data-board-widget="person-board"></section>' +
      aiBoxHtml +
      subtabsHtml +
      '<div class="dossier-tabpanel" role="tabpanel">' +
      tabBodyHtml +
      '</div>' +
      '</div>';

    const prepSlot = $('#person-prep-slot', bodyEl);
    if (prepSlot && window.KizukiSlots && typeof window.KizukiSlots.mount === 'function') {
      window.KizukiSlots.mount('person-prep', prepSlot, {
        dossier,
        person: p,
        key,
        name,
        openChatModal,
        runPersonAiAction,
      });
    }

    window.KizukiKineticOs?.mountPeopleSignalVisuals($('#person-signal-visuals-slot', bodyEl), dossier);

    const personBoardSlot = $('#person-board-mentions-slot', bodyEl);
    if (personBoardSlot && window.KizukiBoardWidgets && typeof window.KizukiBoardWidgets.mountPersonBoard === 'function') {
      const rawHandles = (dossier && dossier.handles) || p.handles || wm.handles || [];
      const personHandles = Array.isArray(rawHandles)
        ? rawHandles
        : rawHandles && typeof rawHandles === 'object'
        ? Object.values(rawHandles).flat().filter(Boolean)
        : [];
      const boardRes = window.KizukiBoardWidgets.mountPersonBoard(
        personBoardSlot,
        {
          key: (dossier && dossier.key) || key,
          name: (dossier && (dossier.name || dossier.title)) || name,
          handles: personHandles,
        },
        {
          openBoard: (opts = {}) => switchView('board', opts),
          openPerson: (pKey) => {
            if (!pKey) return;
            if (!state.peopleLoaded) loadPeople();
            openPersonDossier(pKey, { jumpView: true, openMobileDetail: true });
          },
          openDoc: (docPath) => {
            if (docPath) openVaultDoc(docPath);
          },
          openView: openBoardMindView,
          showToast: (msg, tone) => showToast(msg, tone || 'info'),
        }
      );
      observeAndPolishBoardCards(personBoardSlot, 'person-board');
      if (boardRes && typeof boardRes.then === 'function') {
        boardRes.then(() => polishBoardThreadCards(personBoardSlot, 'person-board')).catch(() => {});
      }
    }

    if (window.KizukiMotion) {
      requestAnimationFrame(() => {
        const subtabsEl = $('.dossier-subtabs', bodyEl);
        if (subtabsEl && typeof window.KizukiMotion.syncSlidingTabInk === 'function') {
          window.KizukiMotion.syncSlidingTabInk(subtabsEl, '.is-active');
        }
        if ((activeTab === 'overview' || activeTab === 'network') && typeof window.KizukiMotion.choreographProfileVisuals === 'function') {
          window.KizukiMotion.choreographProfileVisuals(bodyEl);
        }
        if (typeof window.KizukiMotion.enterStagger === 'function') {
          window.KizukiMotion.enterStagger(bodyEl, '.profile-banner, .dossier-relationship-lede, .dossier-ribbon-section, .dossier-def-row, .dossier-section');
        }
      });
    }
  }

  async function synthesizePersonProfile(personKey) {
    const key = String(personKey || state.selectedPersonKey || '').trim();
    if (!key) return;
    if (state.peopleSynthesizingKey === key) return;

    const currentName =
      (state.selectedDossier && state.selectedDossier.person && state.selectedDossier.person.name) || key;
    state.peopleSynthesizingKey = key;
    if (state.selectedDossier && state.selectedPersonKey === key) {
      renderPersonDossier(state.selectedDossier);
    }
    showToast('Synthesizing world-model profile for ' + currentName + '...', 'info', 'synth:' + key);

    try {
      const res = await apiPost('/api/people/synthesize', { key });
      if (!res || res.ok === false) {
        state.peopleSynthesizingKey = null;
        if (state.selectedDossier && state.selectedPersonKey === key) {
          renderPersonDossier(state.selectedDossier);
        }
        showToast((res && res.error) || 'Profile synthesis failed.', 'error', 'synth:' + key);
        return;
      }

      const freshDossier =
        res.dossier ||
        (await apiGet('/api/people/dossier?key=' + encodeURIComponent(key) + '&limit=80&offset=0'));
      state.peopleSynthesizingKey = null;
      if (state.selectedPersonKey === key) {
        state.selectedDossier = freshDossier;
        renderPersonDossier(freshDossier);
      }
      syncPersonInDirectoryList(freshDossier);
      showToast('World-model profile saved (' + (res.engine || 'world-model-v2') + ').', 'success', 'synth:' + key);
    } catch (err) {
      state.peopleSynthesizingKey = null;
      if (state.selectedDossier && state.selectedPersonKey === key) {
        renderPersonDossier(state.selectedDossier);
      }
      showToast('Synthesis error: ' + err.message, 'error', 'synth:' + key);
    }
  }

  async function submitPersonObservation(personKey, kind, text) {
    const key = String(personKey || state.selectedPersonKey || '').trim();
    const cleanText = stripEmDash(String(text || '')).trim();
    if (!key || !cleanText) {
      showToast('Enter an observation before saving.', 'warn');
      return;
    }
    if (state.peopleNoteBusy) return;
    state.peopleNoteBusy = true;
    if (state.selectedDossier) renderPersonDossier(state.selectedDossier);

    try {
      const res = await apiPost('/api/people/note', {
        key,
        kind: kind || 'insight',
        text: cleanText,
      });
      state.peopleNoteBusy = false;
      if (!res || res.ok === false) {
        if (state.selectedDossier) renderPersonDossier(state.selectedDossier);
        showToast((res && res.error) || 'Could not save observation.', 'error');
        return;
      }

      state.peopleNoteOpen = false;
      if (res.dossier && state.selectedPersonKey === key) {
        state.selectedDossier = res.dossier;
        syncPersonInDirectoryList(res.dossier);
      } else if (state.selectedPersonKey === key) {
        const refreshed = await apiGet('/api/people/dossier?key=' + encodeURIComponent(key) + '&limit=80&offset=0');
        state.selectedDossier = refreshed;
        syncPersonInDirectoryList(refreshed);
      }
      if (state.selectedDossier) renderPersonDossier(state.selectedDossier);
      showToast('Observation saved to dossier.', 'success');
    } catch (err) {
      state.peopleNoteBusy = false;
      if (state.selectedDossier) renderPersonDossier(state.selectedDossier);
      showToast('Error saving observation: ' + err.message, 'error');
    }
  }

  async function filterPersonHistory({ preserveFocus = false } = {}) {
    if (!state.selectedPersonKey || !state.selectedDossier) return;
    const key = state.selectedPersonKey;
    const filter = state.peopleHistoryFilter || 'all';
    const q = (state.peopleHistoryQuery || '').trim();
    const bodyEl = $('#people-detail-body');
    const prevScroll = bodyEl ? bodyEl.scrollTop : 0;

    if (filter === 'claims') {
      renderPersonDossier(state.selectedDossier);
      if (bodyEl) bodyEl.scrollTop = prevScroll;
      if (preserveFocus) {
        const inp = $('#people-history-search');
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }
      return;
    }

    const params = new URLSearchParams();
    params.set('key', key);
    params.set('limit', '80');
    params.set('offset', '0');
    if (filter !== 'all') params.set('channel', filter);
    if (q) params.set('q', q);

    try {
      const res = await apiGet('/api/people/dossier?' + params.toString());
      if (state.selectedPersonKey !== key) return;
      state.selectedDossier = Object.assign({}, state.selectedDossier, {
        timeline: Array.isArray(res.timeline) ? res.timeline : [],
        timeline_total: res.timeline_total ?? (Array.isArray(res.timeline) ? res.timeline.length : 0),
        timeline_has_more: res.timeline_has_more,
        sqlite_claims: Array.isArray(res.sqlite_claims) ? res.sqlite_claims : state.selectedDossier.sqlite_claims,
        sqlite_claims_total: res.sqlite_claims_total ?? state.selectedDossier.sqlite_claims_total,
      });
      renderPersonDossier(state.selectedDossier);
      if (bodyEl) bodyEl.scrollTop = prevScroll;
      if (preserveFocus) {
        const inp = $('#people-history-search');
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }
    } catch (err) {
      showToast('History filter failed: ' + err.message, 'error');
    }
  }

  async function loadMorePersonHistory() {
    if (!state.selectedPersonKey || !state.selectedDossier || state.peopleHistoryLoadingMore) return;
    const key = state.selectedPersonKey;
    const existing = Array.isArray(state.selectedDossier.timeline) ? state.selectedDossier.timeline : [];
    const offset = existing.length;
    const filter = state.peopleHistoryFilter || 'all';
    const q = (state.peopleHistoryQuery || '').trim();
    const bodyEl = $('#people-detail-body');
    const prevScroll = bodyEl ? bodyEl.scrollTop : 0;

    state.peopleHistoryLoadingMore = true;
    renderPersonDossier(state.selectedDossier);
    if (bodyEl) bodyEl.scrollTop = prevScroll;

    const params = new URLSearchParams();
    params.set('key', key);
    params.set('limit', '80');
    params.set('offset', String(offset));
    if (filter !== 'all' && filter !== 'claims') params.set('channel', filter);
    if (q) params.set('q', q);

    try {
      const res = await apiGet('/api/people/dossier?' + params.toString());
      state.peopleHistoryLoadingMore = false;
      if (state.selectedPersonKey !== key) return;
      const incoming = Array.isArray(res.timeline) ? res.timeline : [];
      const seen = new Set(existing.map((m) => m.id || (m.occurred_at + '|' + (m.preview || m.full_text || '').slice(0, 40))));
      const merged = existing.slice();
      for (const item of incoming) {
        const sig = item.id || (item.occurred_at + '|' + (item.preview || item.full_text || '').slice(0, 40));
        if (!seen.has(sig)) {
          seen.add(sig);
          merged.push(item);
        }
      }
      const nextTotal = res.timeline_total ?? state.selectedDossier.timeline_total ?? merged.length;
      const hasMore =
        res.timeline_has_more !== undefined
          ? Boolean(res.timeline_has_more)
          : incoming.length >= 80 && merged.length < nextTotal;

      state.selectedDossier = Object.assign({}, state.selectedDossier, {
        timeline: merged,
        timeline_total: nextTotal,
        timeline_has_more: hasMore,
      });
      renderPersonDossier(state.selectedDossier);
      if (bodyEl) bodyEl.scrollTop = prevScroll;
    } catch (err) {
      state.peopleHistoryLoadingMore = false;
      if (state.selectedDossier) {
        renderPersonDossier(state.selectedDossier);
        if (bodyEl) bodyEl.scrollTop = prevScroll;
      }
      showToast('Failed to load more messages: ' + err.message, 'error');
    }
  }

  async function runPersonAiAction(kind) {
    if (!state.selectedDossier || !state.selectedPersonKey) return;
    const person = state.selectedDossier.person || { name: state.selectedPersonKey };
    const wm = state.selectedDossier.world_model || {};
    const name = stripEmDash(person.name || state.selectedPersonKey);
    const recentMsgs = (state.selectedDossier.timeline || [])
      .slice(0, 10)
      .map((m) => '[' + channelInfo(m.channel).short + ' ' + formatRelativeTime(m.occurred_at) + ']: ' + stripEmDash(m.preview || m.full_text || '').slice(0, 220))
      .join('\n');
    const recentMeetings = (state.selectedDossier.meetings || [])
      .slice(0, 5)
      .map((m) => '- ' + stripEmDash(m.title) + ' (' + formatScheduleTime(m.start, false, false) + ')')
      .join('\n');

    const tastes = asCleanList(wm.tastes_preferences).slice(0, 6);
    const ourEdge = asCleanList(wm.our_leverage).slice(0, 6);
    const theirEdge = asCleanList(wm.their_leverage).slice(0, 6);
    const playbook = asCleanList(wm.engagement_playbook).slice(0, 6);
    const trustBuilders = asCleanList(wm.trust_builders).slice(0, 4);
    const degraders = asCleanList(wm.degraders).slice(0, 4);

    const contextText = [
      'Person: ' + name + (person.role || person.org ? ' (' + [person.role, person.org].filter(Boolean).join(' / ') + ')' : ''),
      'Channels: ' + (Array.isArray(person.channels) ? person.channels.join(', ') : ''),
      wm.canonical_read ? 'Canonical World-Model Read:\n' + stripEmDash(wm.canonical_read) : '',
      tastes.length ? 'Tastes, Preferences & Sensibilities:\n- ' + tastes.join('\n- ') : '',
      ourEdge.length ? 'Our Leverage / How We Win:\n- ' + ourEdge.join('\n- ') : '',
      theirEdge.length ? 'Their Leverage / Exposure & Watch-Outs:\n- ' + theirEdge.join('\n- ') : '',
      playbook.length ? 'Engagement Playbook:\n- ' + playbook.join('\n- ') : '',
      trustBuilders.length ? 'What Builds Trust:\n- ' + trustBuilders.join('\n- ') : '',
      degraders.length ? 'What Degrades Relationship:\n- ' + degraders.join('\n- ') : '',
      recentMsgs ? 'Recent cross-channel messages:\n' + recentMsgs : '',
      recentMeetings ? 'Shared meetings:\n' + recentMeetings : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    showToast((kind === 'meeting_prep' ? 'Generating calibrated brief for ' : 'Drafting calibrated local message to ') + name + '...');
    const t0 = performance.now();
    try {
      const res = await apiPost('/api/draft', {
        kind: kind === 'meeting_prep' ? 'meeting_prep' : 'reply',
        title: name,
        context_text: contextText,
      });
      const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
      if (res.ok === false) {
        showToast(res.error || 'Generation failed.', 'error');
        return;
      }
      const md = stripEmDash(res.draft_md || res.answer_md || res.draft || res.answer || '');
      state.peopleAiOutput = {
        kind,
        md,
        engine: res.engine || (kind === 'meeting_prep' ? 'Person Prep Brief' : 'Local Message Draft'),
        latency_ms: elapsed,
      };
      renderPersonDossier(state.selectedDossier);
      showToast('Ready (local only).', 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // VIEW 3: LIFE REPLAY (TIME-MACHINE CALENDAR + PRIVATE OFFLINE LIFE MAP)
  // =========================================================================
  const REPLAY_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REPLAY_MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const REPLAY_WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const REPLAY_WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function parseReplayDayUtc(dayStr) {
    if (!dayStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayStr))) return null;
    const parts = String(dayStr).split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

  function formatReplayFullDate(dayStr) {
    const dt = parseReplayDayUtc(dayStr);
    if (!dt) return String(dayStr || 'Select a day');
    return (
      REPLAY_WEEKDAYS_LONG[dt.getUTCDay()] +
      ', ' +
      REPLAY_MONTHS_SHORT[dt.getUTCMonth()] +
      ' ' +
      dt.getUTCDate() +
      ', ' +
      dt.getUTCFullYear()
    );
  }

  function formatReplayRowDate(dayStr) {
    const dt = parseReplayDayUtc(dayStr);
    if (!dt) return String(dayStr || '');
    return (
      REPLAY_WEEKDAYS_SHORT[dt.getUTCDay()] +
      ', ' +
      REPLAY_MONTHS_SHORT[dt.getUTCMonth()] +
      ' ' +
      dt.getUTCDate()
    );
  }

  function formatReplayMonthGroup(dayStr) {
    const dt = parseReplayDayUtc(dayStr);
    if (!dt) return 'Archive';
    return REPLAY_MONTHS_LONG[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
  }

  function formatReplayTripRange(startDay, endDay) {
    const a = parseReplayDayUtc(startDay);
    const b = parseReplayDayUtc(endDay);
    if (!a) return String(startDay || '');
    const startLabel = REPLAY_MONTHS_SHORT[a.getUTCMonth()] + ' ' + a.getUTCDate();
    if (!b || startDay === endDay) return startLabel;
    const endLabel =
      a.getUTCMonth() === b.getUTCMonth()
        ? String(b.getUTCDate())
        : REPLAY_MONTHS_SHORT[b.getUTCMonth()] + ' ' + b.getUTCDate();
    return startLabel + ' - ' + endLabel;
  }

  function extractReplayHhmm(iso) {
    if (!iso) return '';
    const m = String(iso).match(/T(\d{2}:\d{2})/);
    return m ? m[1] : '';
  }

  function whoopToneClass(zone, recovery) {
    const z = String(zone || '').toLowerCase();
    if (z.includes('green') || z.includes('high')) return 'green';
    if (z.includes('yellow') || z.includes('amber') || z.includes('mid') || z.includes('med')) return 'amber';
    if (z.includes('red') || z.includes('low')) return 'red';
    const pct = Number(recovery);
    if (Number.isFinite(pct)) {
      if (pct >= 67) return 'green';
      if (pct >= 34) return 'amber';
      return 'red';
    }
    return '';
  }

  function replaySourceBadgeMeta(rawSource) {
    const s = String(rawSource || '').toLowerCase();
    if (s.includes('photo')) return { label: 'Apple Photos', cls: 'is-photos' };
    if (s.includes('calendar') || s.includes('flight')) return { label: 'Calendar', cls: 'is-calendar' };
    if (s.includes('google') || s.includes('maps')) return { label: 'Google Maps', cls: 'is-maps' };
    return { label: stripEmDash(rawSource || 'Location'), cls: '' };
  }

  function replayAgentBadgeMeta(rawSource) {
    const s = String(rawSource || '').toLowerCase();
    if (s.includes('claude')) return { label: 'Claude Code', cls: 'is-claude' };
    if (s.includes('codex')) return { label: 'Codex', cls: 'is-codex' };
    if (s.includes('antigravity') || s.includes('neon') || s.includes('gemini')) {
      return { label: 'Antigravity', cls: 'is-antigravity' };
    }
    return { label: stripEmDash(rawSource || 'Session'), cls: '' };
  }

  function findTripForDay(dayStr) {
    const trips = (state.replayIndex && Array.isArray(state.replayIndex.trips)) ? state.replayIndex.trips : [];
    for (const t of trips) {
      if (t && dayStr >= t.start_day && dayStr <= t.end_day) return t;
    }
    return null;
  }

  function pickBestTripDay(trip) {
    if (!trip) return null;
    const days = (state.replayIndex && Array.isArray(state.replayIndex.days)) ? state.replayIndex.days : [];
    const matching = days.filter((d) => d && d.day >= trip.start_day && d.day <= trip.end_day);
    if (matching.length === 0) return trip.start_day;
    matching.sort((a, b) => {
      const gpsA = Array.isArray(a.coords) && a.coords.length > 0 ? 1 : 0;
      const gpsB = Array.isArray(b.coords) && b.coords.length > 0 ? 1 : 0;
      const scoreA = gpsA * 25 + (Number(a.photo_count) || 0) * 4 + (Number(a.total_events) || 0);
      const scoreB = gpsB * 25 + (Number(b.photo_count) || 0) * 4 + (Number(b.total_events) || 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.day.localeCompare(b.day);
    });
    return matching[0].day;
  }

  function pickDefaultReplayDay(indexData) {
    if (!indexData || !Array.isArray(indexData.days) || indexData.days.length === 0) return null;
    const gpsDay = indexData.days.find((d) => Array.isArray(d.coords) && d.coords.length > 0 && d.total_events > 0);
    return (gpsDay && gpsDay.day) || indexData.days[0].day;
  }

  function ensureReplayMapReady() {
    if (replayMap) return replayMap;
    const canvas = $('#replay-map-canvas');
    if (!canvas || typeof window.KizukiReplayMap !== 'function') return null;

    replayMap = new window.KizukiReplayMap(canvas, {
      onSelectDay: (day) => {
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
        const yr = Number(day.slice(0, 4));
        if (state.replayYear && Number.isFinite(yr) && yr !== state.replayYear) {
          loadReplayIndex({ year: yr, targetDay: day, openMobileDetail: isMobileViewport() });
        } else {
          selectReplayDay(day, { openMobileDetail: isMobileViewport(), focusMap: false });
        }
      },
      onHoverPoint: (rawPoint, sx, sy) => {
        renderReplayMapTooltip(rawPoint, sx, sy);
      },
    });
    return replayMap;
  }

  function renderReplayMapTooltip(rawPoint, sx, sy) {
    const tip = $('#replay-map-tooltip');
    const card = $('#replay-map-card');
    if (!tip || !card) return;
    if (!rawPoint) {
      tip.hidden = true;
      return;
    }

    const title = stripEmDash(rawPoint.label || rawPoint.title || rawPoint.primary_place || 'Location');
    const hhmm = extractReplayHhmm(rawPoint.time);
    const metaParts = [];
    if (rawPoint.day) metaParts.push(formatReplayRowDate(rawPoint.day) + ', ' + String(rawPoint.day).slice(0, 4));
    if (hhmm) metaParts.push(hhmm);
    if (Number(rawPoint.photo_count) > 0) metaParts.push(rawPoint.photo_count + ' photos');
    if (rawPoint.source) metaParts.push(replaySourceBadgeMeta(rawPoint.source).label);

    tip.innerHTML =
      '<div class="replay-map-tooltip-title">' + escHtml(title) + '</div>' +
      (metaParts.length > 0 ? '<div class="replay-map-tooltip-meta">' + escHtml(metaParts.join(' \u00b7 ')) + '</div>' : '');
    tip.hidden = false;

    const cardRect = card.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 10;
    let left = sx + 14;
    let top = sy - tipRect.height - 12;
    if (left + tipRect.width + pad > cardRect.width) {
      left = Math.max(pad, sx - tipRect.width - 14);
    }
    if (top < pad) {
      top = Math.min(cardRect.height - tipRect.height - pad, sy + 14);
    }
    tip.style.left = Math.max(pad, Math.round(left)) + 'px';
    tip.style.top = Math.max(pad, Math.round(top)) + 'px';
  }

  function syncReplayMapRegionButtons() {
    $$('#replay-map-modes [data-map-region]').forEach((btn) => {
      const active = btn.dataset.mapRegion === state.replayMapRegion;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setReplayMapRegion(region) {
    const valid = region === 'day' || region === 'uk' || region === 'europe' || region === 'world' ? region : 'day';
    state.replayMapRegion = valid;
    syncReplayMapRegionButtons();
    const map = ensureReplayMapReady();
    if (map) {
      map.setRegion(valid);
    }
  }

  function getActiveDayMapPoints() {
    const dayData = state.replayDay;
    const out = [];
    if (dayData && Array.isArray(dayData.places)) {
      for (const p of dayData.places) {
        if (p && p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined) {
          const lat = Number(p.lat);
          const lng = Number(p.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            out.push({
              day: dayData.day,
              lat,
              lng,
              label: p.label,
              time: p.time,
              source: p.source,
              photo_count: p.photo_count || 0,
            });
          }
        }
      }
    }
    if (out.length === 0 && state.replayIndex && state.replaySelectedDay) {
      const row = (state.replayIndex.days || []).find((d) => d.day === state.replaySelectedDay);
      if (row && Array.isArray(row.coords)) {
        for (const c of row.coords) {
          if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
            out.push({
              day: row.day,
              lat: Number(c.lat),
              lng: Number(c.lng),
              label: c.label || row.primary_place || 'Location',
              source: 'apple-photos-moment',
              photo_count: row.photo_count || 0,
            });
          }
        }
      }
    }
    return out;
  }

  function syncReplayMap({ forceFocusDay = false } = {}) {
    const map = ensureReplayMapReady();
    const idx = state.replayIndex;
    const archivePoints = (idx && Array.isArray(idx.map_points)) ? idx.map_points : [];
    const allDayPoints = getActiveDayMapPoints();
    let dayPointsToShow = allDayPoints;

    if (state.replayFocusedPlaceKey) {
      const match = allDayPoints.find((p) => (p.lat.toFixed(4) + ',' + p.lng.toFixed(4)) === state.replayFocusedPlaceKey);
      if (match) {
        dayPointsToShow = [match];
      }
    }

    if (map) {
      map.resize();
      map.setData({
        points: archivePoints,
        dayPoints: dayPointsToShow,
        selectedDay: state.replaySelectedDay,
      });
      if (forceFocusDay) {
        state.replayMapRegion = dayPointsToShow.length > 0 ? 'day' : 'uk';
        map.setRegion(state.replayMapRegion);
        syncReplayMapRegionButtons();
      }
    }

    const hudDot = $('#replay-map-hud-dot') || $('.replay-map-hud-dot');
    if (hudDot) {
      hudDot.classList.add('is-active-dot');
    }

    const hudText = $('#replay-map-hud-text');
    if (hudText) {
      const isNarrow = window.innerWidth < 480;
      const parts = [];
      if (allDayPoints.length > 0 && state.replaySelectedDay) {
        if (isNarrow) {
          parts.push(allDayPoints.length + (allDayPoints.length === 1 ? ' pin' : ' pins'));
        } else {
          parts.push(allDayPoints.length + (allDayPoints.length === 1 ? ' pin on ' : ' pins on ') + formatReplayRowDate(state.replaySelectedDay));
        }
      }
      if (archivePoints.length > 0) {
        parts.push(
          formatCompact(archivePoints.length) +
            (isNarrow ? ' GPS' : ' GPS pins') +
            (state.replayYear ? ' (' + state.replayYear + ')' : '')
        );
      } else if (idx && idx.stats && idx.stats.total_gps_days > 0) {
        parts.push(formatCompact(idx.stats.total_gps_days) + (isNarrow ? ' GPS' : ' GPS days'));
      }
      parts.push(isNarrow ? 'Offline' : 'Private offline map');
      hudText.textContent = parts.join(' \u00b7 ');
    }
  }

  async function prefetchReplayIndex() {
    if (state.replayPrefetched || state.replayLoaded || state.replayLoading) return;
    state.replayPrefetched = true;
    try {
      const data = await apiGet('/api/replay/index');
      if (!data || typeof data !== 'object') return;
      if (data.stats && Number(data.stats.total_days_with_activity) > 0) {
        state.replayTotalActiveDays = Number(data.stats.total_days_with_activity);
        setNavCount('nav-count-replay', formatCompact(state.replayTotalActiveDays));
      }
      if (data.selected_year) {
        state.replayIndexCache.set(Number(data.selected_year), data);
      }
    } catch (_) {
      // Quiet background prefetch; Replay view will handle errors visibly when opened
    }
  }

  function ensureReplayScrubberMounted() {
    if (replayScrubberCtrl) return replayScrubberCtrl;
    const host = $('#replay-vernier-host');
    if (!host || !window.KizukiReplayScrubber || typeof window.KizukiReplayScrubber.mount !== 'function') {
      return null;
    }
    replayScrubberCtrl = window.KizukiReplayScrubber.mount(host, {
      onSelectDay(dayIso) {
        if (dayIso && dayIso !== state.replaySelectedDay) {
          selectReplayDay(dayIso);
        }
      },
      onPreviewDay(dayIso, meta) {
        const map = replayMap || ensureReplayMapReady();
        if (map && meta && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)) {
          map.setData({
            selectedDay: dayIso,
            dayPoints: [
              {
                day: dayIso,
                lat: meta.lat,
                lng: meta.lng,
                label: meta.primary_location || dayIso,
                isActive: true,
              },
            ],
            points: state.replayIndex && Array.isArray(state.replayIndex.map_points)
              ? state.replayIndex.map_points
              : [],
          });
        }
      },
    });
    return replayScrubberCtrl;
  }

  async function loadReplayIndex({ year, targetDay, openMobileDetail = false, forceRefresh = false } = {}) {
    state.replayLoading = true;
    const requestedYear = Number.isFinite(Number(year)) ? Number(year) : null;
    try {
      let data = null;
      if (!forceRefresh && requestedYear && state.replayIndexCache.has(requestedYear)) {
        data = state.replayIndexCache.get(requestedYear);
      } else {
        const qs = requestedYear ? '?year=' + encodeURIComponent(String(requestedYear)) : '';
        data = await apiGet('/api/replay/index' + qs);
        if (data && data.selected_year) {
          state.replayIndexCache.set(Number(data.selected_year), data);
        }
      }

      state.replayIndex = data;
      state.replayYear = Number(data.selected_year || requestedYear || new Date().getUTCFullYear());
      state.replayLoaded = true;
      state.replayLoading = false;

      if (data.stats && Number(data.stats.total_days_with_activity) > 0) {
        state.replayTotalActiveDays = Number(data.stats.total_days_with_activity);
      }
      syncUnifiedCounters();

      const statsBadge = $('#replay-stats-badge');
      if (statsBadge && data.stats) {
        const gpsDays = Number(data.stats.total_gps_days || 0);
        statsBadge.textContent = formatCompact(gpsDays) + ' GPS days';
        statsBadge.title =
          formatCompact(data.stats.total_days_with_activity || 0) +
          ' active days, ' +
          formatCompact(data.stats.total_places || 0) +
          ' places, ' +
          formatCompact(data.stats.total_trips || 0) +
          ' trips';
      }

      renderReplayYearPills();
      renderReplayTrips();

      const daysInYear = Array.isArray(data.days) ? data.days : [];
      let chosenDay = targetDay && /^\d{4}-\d{2}-\d{2}$/.test(targetDay) ? targetDay : null;
      if (!chosenDay && state.replaySelectedDay && daysInYear.some((d) => d.day === state.replaySelectedDay)) {
        chosenDay = state.replaySelectedDay;
      }
      if (!chosenDay) {
        chosenDay = pickDefaultReplayDay(data);
      }

      renderReplayHeatmap();
      renderReplayDaysList();

      const scrubber = ensureReplayScrubberMounted();
      if (scrubber && typeof scrubber.setDays === 'function') {
        scrubber.setDays(daysInYear, chosenDay || state.replaySelectedDay);
      }

      if (chosenDay) {
        await selectReplayDay(chosenDay, {
          openMobileDetail,
          focusMap: true,
          forceRefresh,
        });
      } else {
        state.replaySelectedDay = null;
        state.replayDay = null;
        renderReplayStage();
        syncReplayMap({ forceFocusDay: false });
      }
    } catch (err) {
      state.replayLoading = false;
      const list = $('#replay-days-list');
      if (list) {
        list.innerHTML =
          '<div class="replay-empty-state">Unable to load Life Replay index: ' + escHtml(err.message) + '</div>';
      }
      const panel = $('#replay-tabpanel');
      if (panel) {
        panel.innerHTML =
          '<div class="replay-empty-state">Replay API unavailable (' + escHtml(err.message) + ').</div>';
      }
      showToast('Failed to load Life Replay: ' + err.message, 'error', 'replay-load');
    }
  }

  function renderReplayYearPills() {
    const container = $('#replay-year-pills');
    if (!container || !state.replayIndex) return;
    const years = Array.isArray(state.replayIndex.available_years) ? state.replayIndex.available_years : [];
    if (years.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = years
      .slice(0, 6)
      .map((yr) => {
        const active = Number(yr) === Number(state.replayYear);
        return (
          '<button type="button" class="replay-year-pill' +
          (active ? ' is-active' : '') +
          '" role="tab" aria-selected="' +
          (active ? 'true' : 'false') +
          '" aria-pressed="' +
          (active ? 'true' : 'false') +
          '" data-replay-year="' +
          escHtml(String(yr)) +
          '">' +
          escHtml(String(yr)) +
          '</button>'
        );
      })
      .join('');
  }

  function renderReplayHeatmap() {
    const grid = $('#replay-heatmap-grid');
    const monthsEl = $('#replay-heatmap-months');
    const statEl = $('#replay-heatmap-stat');
    if (!grid || !state.replayIndex) return;

    const year = Number(state.replayYear || state.replayIndex.selected_year || new Date().getUTCFullYear());
    const days = Array.isArray(state.replayIndex.days) ? state.replayIndex.days : [];
    const byDay = new Map();
    let gpsCountYear = 0;
    for (const d of days) {
      byDay.set(d.day, d);
      if (Array.isArray(d.coords) && d.coords.length > 0) gpsCountYear += 1;
    }

    if (statEl) {
      statEl.textContent = days.length + ' active days \u00b7 ' + gpsCountYear + ' GPS';
    }

    // Month labels are rendered aligned inside the responsive 53-week SVG
    if (monthsEl) {
      monthsEl.innerHTML = '';
      monthsEl.hidden = true;
    }

    const jan1 = new Date(Date.UTC(year, 0, 1));
    const dec31 = new Date(Date.UTC(year, 11, 31));
    const padStart = jan1.getUTCDay(); // 0 = Sun ... 6 = Sat
    const pitch = 7;
    const cellSize = 5.4;
    const xOrigin = 5;
    const yOrigin = 20;
    const isLight = state.theme === 'light';
    const pipOnLow = isLight ? '#2563eb' : '#3291ff';

    const monthTexts = [];
    const rectParts = [];
    const pipParts = [];
    let lastLabelCol = -10;
    let cellIdx = padStart;

    const cursor = new Date(jan1.getTime());
    while (cursor <= dec31) {
      const col = Math.floor(cellIdx / 7);
      const row = cellIdx % 7;
      const x = xOrigin + col * pitch;
      const y = yOrigin + row * pitch;

      if (cursor.getUTCDate() === 1) {
        const monthIdx = cursor.getUTCMonth();
        const label = REPLAY_MONTHS_SHORT[monthIdx] || '';
        if (label && col - lastLabelCol >= 3 && x <= 362) {
          monthTexts.push(
            '<text class="heatmap-month-label" x="' + x + '" y="12" fill="var(--ink-faint)" font-family="var(--font-mono)" font-size="8.2" letter-spacing="0.02em">' +
              escHtml(label) +
              '</text>'
          );
          lastLabelCol = col;
        }
      }

      const isoDay = cursor.toISOString().slice(0, 10);
      const item = byDay.get(isoDay);
      const intensity = item ? Math.max(0, Math.min(4, Number(item.intensity) || 0)) : 0;
      const hasGps = Boolean(item && Array.isArray(item.coords) && item.coords.length > 0);
      const isSelected = isoDay === state.replaySelectedDay;
      const titleParts = [formatReplayFullDate(isoDay)];
      if (item) {
        if (item.primary_place) titleParts.push(stripEmDash(item.primary_place));
        titleParts.push(item.total_events + ' events');
        if (item.photo_count > 0) titleParts.push(item.photo_count + ' photos');
      } else {
        titleParts.push('No recorded events');
      }
      const titleText = titleParts.join(' \u00b7 ');
      const strokeColor = isSelected ? 'var(--ink-primary)' : 'var(--replay-heat-' + intensity + '-border)';
      const strokeW = isSelected ? '1.15' : '0.45';

      rectParts.push(
        '<rect class="heatmap-cell is-l' +
          intensity +
          (hasGps ? ' has-gps' : '') +
          (isSelected ? ' is-selected' : '') +
          '" data-replay-day="' +
          isoDay +
          '" data-intensity="' +
          intensity +
          '" x="' +
          x +
          '" y="' +
          y +
          '" width="' +
          cellSize +
          '" height="' +
          cellSize +
          '" rx="1.2" ry="1.2" fill="var(--replay-heat-' +
          intensity +
          ')" stroke="' +
          strokeColor +
          '" stroke-width="' +
          strokeW +
          '" tabindex="0" role="button" aria-label="' +
          escHtml(titleText) +
          '"><title>' +
          escHtml(titleText) +
          '</title></rect>'
      );

      if (hasGps) {
        const pipFill = intensity >= 2 ? '#ffffff' : pipOnLow;
        pipParts.push(
          '<circle class="heatmap-gps-pip' +
            (intensity >= 2 ? ' is-on-filled' : ' is-on-low') +
            '" cx="' +
            (x + 4.35).toFixed(2) +
            '" cy="' +
            (y + 1.05).toFixed(2) +
            '" r="0.95" fill="' +
            pipFill +
            '" pointer-events="none"/>'
        );
      }

      cellIdx += 1;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    grid.classList.add('is-svg-heatmap');
    grid.innerHTML =
      '<svg class="heatmap-svg" viewBox="0 0 382 82" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Daily activity and GPS heatmap for ' +
      escHtml(String(year)) +
      '">' +
      '<g class="heatmap-svg-months">' + monthTexts.join('') + '</g>' +
      '<g class="heatmap-svg-cells">' + rectParts.join('') + '</g>' +
      '<g class="heatmap-svg-pips">' + pipParts.join('') + '</g>' +
      '</svg>';
  }

  function renderReplayTrips() {
    const strip = $('#replay-trips-strip');
    if (!strip || !state.replayIndex) return;
    const trips = Array.isArray(state.replayIndex.trips) ? state.replayIndex.trips : [];
    if (trips.length === 0) {
      strip.hidden = true;
      strip.innerHTML = '';
      return;
    }

    strip.hidden = false;
    strip.innerHTML = trips
      .map((trip) => {
        const active =
          Boolean(state.replaySelectedDay) &&
          state.replaySelectedDay >= trip.start_day &&
          state.replaySelectedDay <= trip.end_day;
        const bestDay = pickBestTripDay(trip);
        const metaParts = [formatReplayTripRange(trip.start_day, trip.end_day)];
        if (Number(trip.photo_count) > 0) metaParts.push(trip.photo_count + ' photos');
        return (
          '<button type="button" class="trip-chip' +
          (active ? ' is-active' : '') +
          '" data-replay-trip-id="' +
          escHtml(trip.id) +
          '" data-replay-trip-day="' +
          escHtml(bestDay) +
          '" title="' +
          escHtml(stripEmDash(trip.title) + ' (' + formatReplayTripRange(trip.start_day, trip.end_day) + ')') +
          '">' +
          '<span class="trip-chip-top">' +
          '<span class="trip-chip-name">' + escHtml(stripEmDash(trip.title)) + '</span>' +
          '<span class="trip-chip-badge">' + escHtml(String(trip.days_count || 1)) + 'd</span>' +
          '</span>' +
          '<span class="trip-chip-meta">' + escHtml(metaParts.join(' \u00b7 ')) + '</span>' +
          '</button>'
        );
      })
      .join('');
  }

  function getFilteredReplayDays() {
    const days = (state.replayIndex && Array.isArray(state.replayIndex.days)) ? state.replayIndex.days : [];
    const q = String(state.replayFilter || '').trim().toLowerCase();
    if (!q) return days;

    const trips = (state.replayIndex && Array.isArray(state.replayIndex.trips)) ? state.replayIndex.trips : [];
    return days.filter((d) => {
      const trip = trips.find((t) => d.day >= t.start_day && d.day <= t.end_day);
      const hay = [
        d.day,
        formatReplayFullDate(d.day),
        formatReplayRowDate(d.day),
        d.primary_place || '',
        Array.isArray(d.places) ? d.places.join(' ') : '',
        d.headline || '',
        trip ? trip.title : '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function renderReplayDaysList() {
    const list = $('#replay-days-list');
    if (!list || !state.replayIndex) return;

    const filtered = getFilteredReplayDays();
    if (filtered.length === 0) {
      list.innerHTML =
        '<div class="replay-empty-state">No days match "' + escHtml(state.replayFilter) + '".</div>';
      return;
    }

    const groups = new Map();
    for (const d of filtered) {
      const monthKey = d.day.slice(0, 7);
      if (!groups.has(monthKey)) {
        groups.set(monthKey, { label: formatReplayMonthGroup(d.day), items: [] });
      }
      groups.get(monthKey).items.push(d);
    }

    const html = [];
    for (const group of groups.values()) {
      html.push(
        '<div class="replay-days-group-label">' +
          '<span>' + escHtml(group.label) + '</span>' +
          '<span class="tabular">' + group.items.length + 'd</span>' +
        '</div>'
      );

      for (const d of group.items) {
        const selected = d.day === state.replaySelectedDay;
        const trip = findTripForDay(d.day);
        const placeLabel = d.primary_place || (trip ? trip.primary_place : '');
        const wTone = whoopToneClass(d.whoop_zone, d.whoop_recovery);
        const sigParts = [];
        if (d.meetings_count > 0) sigParts.push(d.meetings_count + (d.meetings_count === 1 ? ' mtg' : ' mtgs'));
        if (d.work_count > 0) sigParts.push(Number(d.work_count).toLocaleString() + (d.work_count === 1 ? ' build event' : ' build events'));
        if (d.photo_count > 0) sigParts.push(d.photo_count + (d.photo_count === 1 ? ' photo' : ' photos'));

        html.push(
          '<button type="button" class="replay-day-row' +
            (selected ? ' is-selected' : '') +
            '" data-replay-day="' +
            escHtml(d.day) +
            '" role="option" aria-selected="' +
            (selected ? 'true' : 'false') +
            '">' +
            '<div class="replay-day-row-top">' +
              '<div class="replay-day-date-group">' +
                '<span class="replay-day-date">' + escHtml(formatReplayRowDate(d.day)) + '</span>' +
                (placeLabel
                  ? '<span class="replay-day-place' + (trip ? ' is-trip' : '') + '">' + escHtml(stripEmDash(placeLabel)) + '</span>'
                  : '') +
              '</div>' +
              '<div class="replay-day-right">' +
                (wTone
                  ? '<span class="replay-whoop-dot is-' +
                    wTone +
                    '" title="Whoop recovery ' +
                    escHtml(d.whoop_recovery != null ? d.whoop_recovery + '%' : wTone) +
                    '" aria-hidden="true"></span>'
                  : '') +
                '<span class="replay-day-count">' + escHtml(formatCompact(d.total_events || 0)) + ' ev</span>' +
              '</div>' +
            '</div>' +
            '<div class="replay-day-row-sub">' +
              '<span class="replay-day-preview">' + escHtml(stripEmDash(d.headline || 'Recorded activity')) + '</span>' +
              (sigParts.length > 0 ? '<span class="replay-day-signals">' + escHtml(sigParts.join(' \u00b7 ')) + '</span>' : '') +
            '</div>' +
          '</button>'
        );
      }
    }

    list.innerHTML = html.join('');
  }

  function updateReplayRailSelection() {
    $$('#replay-heatmap-grid .heatmap-cell[data-replay-day]').forEach((cell) => {
      const sel = cell.getAttribute('data-replay-day') === state.replaySelectedDay;
      cell.classList.toggle('is-selected', sel);
      if (cell.tagName && cell.tagName.toLowerCase() === 'rect') {
        const level = cell.getAttribute('data-intensity') || '0';
        cell.setAttribute('stroke', sel ? 'var(--ink-primary)' : 'var(--replay-heat-' + level + '-border)');
        cell.setAttribute('stroke-width', sel ? '1.15' : '0.45');
      }
    });
    $$('#replay-days-list .replay-day-row[data-replay-day]').forEach((row) => {
      const sel = row.dataset.replayDay === state.replaySelectedDay;
      row.classList.toggle('is-selected', sel);
      row.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
    renderReplayTrips();
  }

  async function selectReplayDay(dayStr, { openMobileDetail = false, focusMap = true, forceRefresh = false } = {}) {
    if (!dayStr || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return;

    state.replaySelectedDay = dayStr;
    if (replayScrubberCtrl && typeof replayScrubberCtrl.setActiveDay === 'function') {
      replayScrubberCtrl.setActiveDay(dayStr);
    }
    state.replayFocusedPlaceKey = null;
    state.replayStoryMeta = null;
    updateReplayRailSelection();

    if (state.view === 'replay') {
      updateUrlParams({ view: 'replay', day: dayStr });
    }
    if (openMobileDetail && isMobileViewport()) {
      setReplayMobileDetail(true);
    }

    const titleEl = $('#replay-day-title');
    if (titleEl) titleEl.textContent = formatReplayFullDate(dayStr);

    if (!forceRefresh && state.replayDayCache.has(dayStr)) {
      state.replayDay = state.replayDayCache.get(dayStr);
      state.replayDayLoading = false;
      renderReplayStage();
      syncReplayMap({ forceFocusDay: focusMap });
      return;
    }

    state.replayDayLoading = true;
    const panel = $('#replay-tabpanel');
    if (panel) panel.innerHTML = '<div class="skeleton-block"></div>';

    try {
      const data = await apiGet('/api/replay/day?day=' + encodeURIComponent(dayStr));
      if (state.replaySelectedDay !== dayStr) return;
      state.replayDay = data;
      state.replayDayCache.set(dayStr, data);
      state.replayDayLoading = false;
      renderReplayStage();
      syncReplayMap({ forceFocusDay: focusMap });
    } catch (err) {
      if (state.replaySelectedDay !== dayStr) return;
      state.replayDayLoading = false;
      if (panel) {
        panel.innerHTML =
          '<div class="replay-empty-state">Unable to load day replay for ' +
          escHtml(dayStr) +
          ': ' +
          escHtml(err.message) +
          '</div>';
      }
      showToast('Failed to load ' + dayStr + ': ' + err.message, 'error', 'replay-day');
    }
  }

  function stepReplayDay(delta) {
    if (!state.replaySelectedDay) return;
    let targetDay = null;
    if (state.replayDay) {
      targetDay = delta < 0 ? state.replayDay.prev_active_day : state.replayDay.next_active_day;
    }
    if (!targetDay && state.replayIndex && Array.isArray(state.replayIndex.days)) {
      const days = state.replayIndex.days; // descending newest-first
      const idx = days.findIndex((d) => d.day === state.replaySelectedDay);
      if (idx >= 0) {
        const nextIdx = delta < 0 ? idx + 1 : idx - 1;
        if (nextIdx >= 0 && nextIdx < days.length) targetDay = days[nextIdx].day;
      }
    }
    if (!targetDay) return;

    const targetYear = Number(targetDay.slice(0, 4));
    if (state.replayYear && Number.isFinite(targetYear) && targetYear !== state.replayYear) {
      loadReplayIndex({ year: targetYear, targetDay, openMobileDetail: state.replayMobileDetailOpen });
    } else {
      selectReplayDay(targetDay, { openMobileDetail: state.replayMobileDetailOpen, focusMap: true });
    }
  }

  function renderReplayStage() {
    const day = state.replayDay;
    const titleEl = $('#replay-day-title');
    const locBadge = $('#replay-location-badge');
    const prevBtn = $('#btn-replay-prev');
    const nextBtn = $('#btn-replay-next');
    const storyBtn = $('#btn-replay-story');
    const kpisEl = $('#replay-kpis');

    if (!day) {
      if (titleEl) titleEl.textContent = 'Select a day';
      if (locBadge) locBadge.hidden = true;
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (storyBtn) {
        storyBtn.disabled = true;
        storyBtn.textContent = 'Synthesize Day Story';
      }
      if (kpisEl) kpisEl.innerHTML = '';
      renderReplayRhythm();
      renderReplayStory();
      renderReplayTabPanel();
      return;
    }

    if (titleEl) titleEl.textContent = formatReplayFullDate(day.day);

    const primaryLoc = day.summary && day.summary.primary_location ? stripEmDash(day.summary.primary_location) : '';
    if (locBadge) {
      if (primaryLoc) {
        locBadge.textContent = primaryLoc;
        locBadge.hidden = false;
      } else {
        locBadge.hidden = true;
      }
    }

    if (prevBtn) prevBtn.disabled = !day.prev_active_day;
    if (nextBtn) nextBtn.disabled = !day.next_active_day;

    if (storyBtn) {
      storyBtn.disabled = state.replayStoryBusy;
      storyBtn.textContent = state.replayStoryBusy
        ? 'Synthesizing...'
        : day.story_md
        ? 'Regenerate Story'
        : 'Synthesize Day Story';
    }

    if (kpisEl) {
      const s = day.summary || {};
      const places = Array.isArray(day.places) ? day.places : [];
      const gpsPins = places.filter((p) => p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined).length;
      const peopleCount = Array.isArray(day.people) ? day.people.length : 0;
      const meetings = Array.isArray(day.meetings) ? day.meetings : [];
      const whoop = day.whoop || null;
      const wTone = whoop ? whoopToneClass(whoop.zone, whoop.recovery_pct) : '';
      const whoopVal =
        whoop && whoop.recovery_pct !== null && whoop.recovery_pct !== undefined
          ? whoop.recovery_pct + '%'
          : whoop && whoop.sleep_hours !== null && whoop.sleep_hours !== undefined
          ? whoop.sleep_hours + 'h'
          : '--';
      const whoopSubParts = [];
      if (whoop && whoop.sleep_hours !== null && whoop.sleep_hours !== undefined) whoopSubParts.push(whoop.sleep_hours + 'h');
      if (whoop && whoop.hrv_ms !== null && whoop.hrv_ms !== undefined) whoopSubParts.push(whoop.hrv_ms + 'ms HRV');
      else if (whoop && whoop.rhr_bpm !== null && whoop.rhr_bpm !== undefined) whoopSubParts.push(whoop.rhr_bpm + ' RHR');
      const whoopSub = whoopSubParts.length > 0 ? whoopSubParts.join(' \u00b7 ') : (whoop ? stripEmDash(whoop.summary).slice(0, 24) : 'No Whoop');

      const workSessionsNum = Number(s.work_sessions || 0);
      const docsCountNum = Number(s.docs_count || 0);
      const claimsCountNum = Number(s.claims_count || 0);
      const firstMeetingTitle =
        meetings.length > 0 ? stripEmDash(meetings[0].title || '').replace(/\s+/g, ' ').trim() : '';

      const rawKpis = [
        {
          label: 'Where',
          val: primaryLoc || (places.length > 0 ? stripEmDash(places[0].label) : ''),
          sub: places.length + (places.length === 1 ? ' place' : ' places') + (gpsPins > 0 ? ' \u00b7 ' + gpsPins + ' GPS' : ''),
          cls: '',
          present: Boolean(primaryLoc || places.length > 0),
        },
        {
          label: 'Work',
          val: workSessionsNum.toLocaleString(),
          sub: [docsCountNum > 0 ? docsCountNum + ' docs' : '', claimsCountNum > 0 ? claimsCountNum + ' claims' : ''].filter(Boolean).join(' \u00b7 ') || 'Build activity',
          cls: '',
          present: workSessionsNum > 0 || docsCountNum > 0 || claimsCountNum > 0,
        },
        {
          label: 'Messages',
          val: formatCompact(s.messages_count || 0),
          sub: peopleCount + (peopleCount === 1 ? ' person' : ' people'),
          cls: '',
          present: Number(s.messages_count || 0) > 0,
        },
        {
          label: 'Meetings',
          val: String(s.meetings_count || 0),
          sub: firstMeetingTitle || 'Scheduled',
          cls: '',
          present: Number(s.meetings_count || 0) > 0,
        },
        {
          label: 'Photos',
          val: formatCompact(s.photo_count || 0),
          sub: 'Apple Photos',
          cls: '',
          present: Number(s.photo_count || 0) > 0,
        },
        {
          label: 'Body / Whoop',
          val: whoopVal,
          sub: whoopSub,
          cls: wTone ? 'is-whoop-' + wTone : '',
          present: Boolean(whoop && whoopVal && whoopVal !== '--' && whoopSub !== 'No Whoop'),
        },
      ];

      const kpis = rawKpis.filter((k) => {
        if (!k.present) return false;
        const v = String(k.val || '').trim();
        return v !== '' && v !== '0' && v !== '--' && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'unrecorded';
      });

      kpisEl.innerHTML = kpis
        .map(
          (k) =>
            '<div class="replay-kpi ' + k.cls + '">' +
              '<span class="replay-kpi-label">' + escHtml(k.label) + '</span>' +
              '<span class="replay-kpi-val" title="' + escHtml(k.val) + '">' + escHtml(k.val) + '</span>' +
              '<span class="replay-kpi-sub" title="' + escHtml(k.sub) + '">' + escHtml(k.sub) + '</span>' +
            '</div>'
        )
        .join('');
    }

    renderReplayStory();
    renderReplayRhythm();
    renderReplayTabPanel();
    if (window.KizukiMotion && typeof window.KizukiMotion.enterStagger === 'function') {
      const scrollEl = $('#replay-scroll');
      if (scrollEl) {
        window.KizukiMotion.enterStagger(scrollEl, '.replay-kpis > .replay-kpi, .replay-story-card');
      }
    }
  }

  function renderReplayRhythm() {
    const container = $('#replay-rhythm-container');
    if (!container) return;
    const day = state.replayDay;
    const charts = window.KizukiCharts;
    if (!day || !charts || typeof charts.renderDayRhythmSvg !== 'function') {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    const hasEvents =
      (Array.isArray(day.timeline) && day.timeline.length > 0) ||
      (Array.isArray(day.work) && day.work.length > 0) ||
      (Array.isArray(day.comms) && day.comms.length > 0) ||
      (Array.isArray(day.meetings) && day.meetings.length > 0) ||
      (Array.isArray(day.places) && day.places.length > 0);
    if (!hasEvents) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    const svgHtml = charts.renderDayRhythmSvg(day);
    if (!svgHtml) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML =
      '<section class="replay-rhythm-bar" aria-label="24-hour day rhythm waveform">' +
      '<div class="replay-rhythm-head">' +
      '<span class="replay-rhythm-title">' + iconSvg('stream', { size: 12 }) + '<span>24-Hour Day Rhythm</span></span>' +
      '</div>' +
      svgHtml +
      '</section>';
  }

  function isMetadataDumpStory(md) {
    if (!md) return true;
    const raw = String(md);
    const plain = raw.replace(/[*_`]+/g, '');
    if (/^\s*#{0,3}\s*day at a glance\b/im.test(plain) && /\bheadline\s*:/i.test(plain)) return true;
    if (/\bdate\s*:/i.test(plain) && /\bheadline\s*:/i.test(plain) && /\b(primary location|activity totals)\s*:/i.test(plain)) return true;
    const lines = plain
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length === 0) return true;
    const metaLines = lines.filter((l) => /^(-|\*)?\s*(date|headline|primary location|activity totals|places|where|work|meetings|messages|whoop|summary)\s*:/i.test(l) || (l.includes('|') && l.split('|').length >= 3));
    return metaLines.length >= Math.max(1, Math.ceil(lines.length * 0.4));
  }

  function buildReplayNarrativeProse(day) {
    const s = (day && day.summary) || {};
    const places = Array.isArray(day && day.places) ? day.places : [];
    const meetings = Array.isArray(day && day.meetings) ? day.meetings : [];
    const work = Array.isArray(day && day.work) ? day.work : [];
    const people = Array.isArray(day && day.people) ? day.people : [];
    const docs = Array.isArray(day && day.docs) ? day.docs : [];
    const whoop = day && day.whoop ? day.whoop : null;

    const primaryLoc = s.primary_location
      ? stripEmDash(s.primary_location)
      : places.length > 0
      ? stripEmDash(places[0].label)
      : '';
    const extraPlaces = places
      .map((p) => stripEmDash(p.label || '').trim())
      .filter((lbl, idx, arr) => lbl && lbl !== primaryLoc && arr.indexOf(lbl) === idx)
      .slice(0, 3);

    const sentences = [];
    const locPhrase = primaryLoc
      ? 'Anchored in ' + primaryLoc + (extraPlaces.length > 0 ? ' with stops at ' + extraPlaces.join(', ') : '')
      : 'Recorded activity across the day';

    const mtgCount = Number(s.meetings_count || meetings.length || 0);
    const workCount = Number(s.work_sessions || 0);
    const topProjects = work
      .map((w) => stripEmDash(w.project || w.title || '').trim())
      .filter((p, idx, arr) => p && arr.indexOf(p) === idx)
      .slice(0, 2);

    if (mtgCount > 0 && workCount > 0) {
      const firstMtg = meetings[0] ? stripEmDash(meetings[0].title || '').trim() : '';
      sentences.push(
        locPhrase +
          ', balancing ' +
          mtgCount +
          (mtgCount === 1 ? ' meeting' : ' meetings') +
          (firstMtg ? ' (' + firstMtg + ')' : '') +
          ' alongside ' +
          workCount.toLocaleString() +
          ' build events' +
          (topProjects.length > 0 ? ' across ' + topProjects.join(' and ') : '') +
          '.'
      );
    } else if (workCount > 0) {
      sentences.push(
        locPhrase +
          ' with ' +
          workCount.toLocaleString() +
          ' build events' +
          (topProjects.length > 0 ? ' focused on ' + topProjects.join(' and ') : '') +
          (docs.length > 0 ? ' and ' + docs.length + (docs.length === 1 ? ' vault document updated' : ' vault documents updated') : '') +
          '.'
      );
    } else if (mtgCount > 0) {
      const mtgNames = meetings.slice(0, 2).map((m) => stripEmDash(m.title || '').trim()).filter(Boolean);
      sentences.push(
        locPhrase +
          ' around ' +
          mtgCount +
          (mtgCount === 1 ? ' meeting' : ' meetings') +
          (mtgNames.length > 0 ? ' including ' + mtgNames.join(' and ') : '') +
          '.'
      );
    } else {
      sentences.push(locPhrase + '.');
    }

    const msgCount = Number(s.messages_count || 0);
    if (msgCount > 0 || people.length > 0) {
      const topContacts = people
        .slice(0, 3)
        .map((p) => stripEmDash(p.name || p.key || '').trim())
        .filter(Boolean);
      sentences.push(
        'Exchanged ' +
          msgCount.toLocaleString() +
          (msgCount === 1 ? ' message' : ' messages') +
          (people.length > 0 ? ' with ' + people.length + (people.length === 1 ? ' contact' : ' contacts') : '') +
          (topContacts.length > 0 ? ', led by ' + topContacts.join(', ') : '') +
          '.'
      );
    }

    if (whoop && (whoop.recovery_pct != null || whoop.sleep_hours != null)) {
      const bioParts = [];
      if (whoop.recovery_pct != null) bioParts.push(whoop.recovery_pct + '% recovery');
      if (whoop.sleep_hours != null) bioParts.push(whoop.sleep_hours + 'h sleep');
      if (whoop.hrv_ms != null) bioParts.push(whoop.hrv_ms + 'ms HRV');
      if (bioParts.length > 0) {
        sentences.push('Biometrics logged ' + bioParts.join(', ') + '.');
      }
    }

    return '<p>' + escHtml(sentences.join(' ')) + '</p>';
  }

  function buildReplayPlaceChipsHtml(day) {
    const places = Array.isArray(day && day.places) ? day.places : [];
    if (places.length === 0) return '';
    const seen = new Set();
    const chips = [];
    for (const p of places) {
      const label = stripEmDash(p.label || '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hasCoords = p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined;
      const coordKey = hasCoords ? Number(p.lat).toFixed(4) + ',' + Number(p.lng).toFixed(4) : '';
      if (hasCoords) {
        chips.push(
          '<button type="button" class="replay-place-chip" data-replay-focus-place="' + escHtml(coordKey) + '">' +
            '<span class="replay-place-chip-dot" aria-hidden="true"></span>' +
            '<span>' + escHtml(label) + '</span>' +
          '</button>'
        );
      } else {
        chips.push(
          '<span class="replay-place-chip">' +
            '<span>' + escHtml(label) + '</span>' +
          '</span>'
        );
      }
      if (chips.length >= 8) break;
    }
    return chips.length > 0
      ? '<div class="replay-story-places" aria-label="Places visited">' + chips.join('') + '</div>'
      : '';
  }

  function renderReplayStory() {
    const container = $('#replay-story-container');
    if (!container) return;
    const day = state.replayDay;
    if (!day) {
      container.innerHTML = '';
      return;
    }

    const placeChipsHtml = buildReplayPlaceChipsHtml(day);

    if (state.replayStoryBusy) {
      container.innerHTML =
        '<section class="replay-story-card" aria-label="Day Story">' +
          '<div class="replay-story-head">' +
            '<div class="replay-story-title-group">' +
              '<h3 class="replay-story-kicker">Day Story</h3>' +
              '<span class="replay-story-badge is-live">Synthesizing...</span>' +
            '</div>' +
          '</div>' +
          '<div class="replay-story-empty">Weaving places, work sessions, meetings, messages, docs, and biometrics for ' +
          escHtml(formatReplayFullDate(day.day)) + '...</div>' +
        '</section>';
      return;
    }

    if (day.story_md && !isMetadataDumpStory(day.story_md)) {
      const meta = state.replayStoryMeta || {};
      const badgeLabel = meta.engine
        ? stripEmDash(meta.engine) + (meta.latency_ms ? ' \u00b7 ' + formatLatency(meta.latency_ms) : '')
        : 'Cached in Vault';
      const badgeCls = meta.engine && !meta.cached ? 'is-live' : 'is-cached';

      container.innerHTML =
        '<section class="replay-story-card" aria-label="Day Story">' +
          '<div class="replay-story-head">' +
            '<div class="replay-story-title-group">' +
              '<h3 class="replay-story-kicker">Day Story</h3>' +
              '<span class="replay-story-badge ' + badgeCls + '">' + escHtml(badgeLabel) + '</span>' +
            '</div>' +
            '<div class="replay-story-actions">' +
              '<button type="button" class="btn-secondary btn-xs" data-replay-story-copy="1">Copy</button>' +
            '</div>' +
          '</div>' +
          '<div class="replay-story-body replay-story-prose markdown-prose">' + renderMarkdownHtml(stripEmDash(day.story_md)) + '</div>' +
          placeChipsHtml +
        '</section>';
      return;
    }

    container.innerHTML =
      '<section class="replay-story-card" aria-label="Day Story">' +
        '<div class="replay-story-head">' +
          '<div class="replay-story-title-group">' +
            '<h3 class="replay-story-kicker">Day Story</h3>' +
            '<span class="replay-story-badge">Grounded Local Narrative</span>' +
          '</div>' +
        '</div>' +
        '<div class="replay-story-body replay-story-prose">' + buildReplayNarrativeProse(day) + '</div>' +
        placeChipsHtml +
      '</section>';
  }

  function findPersonKeyInDay(senderName, day) {
    if (!senderName || !day || !Array.isArray(day.people)) return '';
    const needle = String(senderName).trim().toLowerCase();
    for (const p of day.people) {
      if (!p) continue;
      if (String(p.name || '').trim().toLowerCase() === needle || String(p.key || '').trim().toLowerCase() === needle) {
        return p.key || p.name;
      }
    }
    return '';
  }

  function renderReplayTabPanel() {
    const panel = $('#replay-tabpanel');
    if (!panel) return;
    const day = state.replayDay;

    const timeline = day && Array.isArray(day.timeline) ? day.timeline : [];
    const places = day && Array.isArray(day.places) ? day.places : [];
    const work = day && Array.isArray(day.work) ? day.work : [];
    const docs = day && Array.isArray(day.docs) ? day.docs : [];
    const claims = day && Array.isArray(day.claims) ? day.claims : [];
    const people = day && Array.isArray(day.people) ? day.people : [];
    const meetings = day && Array.isArray(day.meetings) ? day.meetings : [];
    const comms = day && Array.isArray(day.comms) ? day.comms : [];

    const cTimeline = $('#replay-tab-count-timeline');
    const cPlaces = $('#replay-tab-count-places');
    const cWork = $('#replay-tab-count-work');
    const cPeople = $('#replay-tab-count-people');
    if (cTimeline) cTimeline.textContent = String(timeline.length);
    if (cPlaces) cPlaces.textContent = String(places.length);
    if (cWork) cWork.textContent = String(work.length + docs.length + claims.length);
    if (cPeople) cPeople.textContent = String(people.length + meetings.length);

    $$('#replay-subtabs [data-replay-tab]').forEach((tab) => {
      const active = tab.dataset.replayTab === state.replaySubTab;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (window.KizukiMotion && typeof window.KizukiMotion.syncSlidingTabInk === 'function') {
      const replayTabsEl = $('#replay-subtabs');
      if (replayTabsEl) {
        requestAnimationFrame(() => window.KizukiMotion.syncSlidingTabInk(replayTabsEl, '.is-active'));
      }
    }

    if (!day) {
      panel.innerHTML = '<div class="replay-empty-state">Select any day from the calendar or list to replay it.</div>';
      return;
    }

    if (state.replaySubTab === 'timeline') {
      if (timeline.length === 0) {
        panel.innerHTML = '<div class="replay-empty-state">No timeline events recorded for this day.</div>';
        return;
      }
      panel.innerHTML =
        '<div class="replay-storyboard">' +
        timeline
          .map((ev) => {
            const kind = String(ev.kind || 'work').toLowerCase();
            const links = [];
            if (kind === 'doc' && ev.detail) {
              links.push(
                '<button type="button" class="replay-link-chip" data-open-doc="' +
                  escHtml(ev.detail) +
                  '">Open in Vault &rarr;</button>'
              );
            }
            if (kind === 'comms' && ev.title) {
              const sender = ev.title.replace(/\s*\([^)]+\)\s*$/, '').trim();
              const pKey = findPersonKeyInDay(sender, day);
              if (pKey) {
                links.push(
                  '<button type="button" class="replay-link-chip" data-open-person="' +
                    escHtml(pKey) +
                    '">Dossier: ' + escHtml(stripEmDash(sender)) + ' &rarr;</button>'
                );
              }
            }
            if (kind === 'place' && ev.lat !== null && ev.lat !== undefined && ev.lng !== null && ev.lng !== undefined) {
              const coordKey = Number(ev.lat).toFixed(4) + ',' + Number(ev.lng).toFixed(4);
              links.push(
                '<button type="button" class="replay-link-chip" data-replay-focus-place="' +
                  escHtml(coordKey) +
                  '">Focus Map (' + escHtml(coordKey) + ')</button>'
              );
            }
            if (ev.meta && kind !== 'doc') {
              links.push('<span class="replay-link-chip">' + escHtml(stripEmDash(ev.meta)) + '</span>');
            }

            return (
              '<article class="replay-event is-' + escHtml(kind) + '" data-kind="' + escHtml(kind) + '">' +
                '<div class="replay-event-time">' + escHtml(ev.hhmm || extractReplayHhmm(ev.time) || '--:--') + '</div>' +
                '<div class="replay-event-rail"><span class="replay-event-dot is-' + escHtml(kind) + '" aria-hidden="true"></span></div>' +
                '<div class="replay-event-body">' +
                  '<div class="replay-event-head">' +
                    '<span class="replay-event-title">' + escHtml(stripEmDash(ev.title)) + '</span>' +
                    '<span class="replay-event-kind">' + escHtml(kind) + '</span>' +
                  '</div>' +
                  (ev.detail ? '<div class="replay-event-detail">' + escHtml(stripEmDash(ev.detail)) + '</div>' : '') +
                  (links.length > 0 ? '<div class="replay-event-links">' + links.join('') + '</div>' : '') +
                '</div>' +
              '</article>'
            );
          })
          .join('') +
        '</div>';
      return;
    }

    if (state.replaySubTab === 'places') {
      if (places.length === 0) {
        panel.innerHTML =
          '<div class="replay-empty-state">No physical locations recorded on ' +
          escHtml(formatReplayFullDate(day.day)) +
          '. Use Import Maps to enrich your history with Google Maps Timeline.</div>';
        return;
      }
      panel.innerHTML =
        '<div class="replay-places-grid">' +
        places
          .map((p) => {
            const hasCoords = p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined;
            const coordKey = hasCoords ? Number(p.lat).toFixed(4) + ',' + Number(p.lng).toFixed(4) : '';
            const isFocused = Boolean(hasCoords && state.replayFocusedPlaceKey === coordKey);
            const startHhmm = extractReplayHhmm(p.time);
            const endHhmm = extractReplayHhmm(p.end_time);
            const timeRange = startHhmm && endHhmm && endHhmm !== startHhmm ? startHhmm + ' - ' + endHhmm : startHhmm || 'All day';
            const srcBadge = replaySourceBadgeMeta(p.source);
            const subLine = [
              hasCoords ? Number(p.lat).toFixed(4) + ', ' + Number(p.lng).toFixed(4) : '',
              p.address ? stripEmDash(p.address) : '',
              p.detail ? stripEmDash(p.detail) : '',
            ]
              .filter(Boolean)
              .join(' \u00b7 ');
            const tag = hasCoords ? 'button' : 'div';
            const attrs = hasCoords
              ? 'type="button" class="replay-place-card is-clickable' + (isFocused ? ' is-active' : '') + '" data-replay-focus-place="' + escHtml(coordKey) + '"'
              : 'class="replay-place-card"';

            return (
              '<' + tag + ' ' + attrs + '>' +
                '<div class="replay-place-head">' +
                  '<span class="replay-place-name">' + escHtml(stripEmDash(p.label)) + '</span>' +
                  '<span class="replay-place-time">' + escHtml(timeRange) + '</span>' +
                '</div>' +
                (subLine ? '<div class="replay-place-coords" title="' + escHtml(subLine) + '">' + escHtml(subLine) + '</div>' : '') +
                '<div class="replay-place-foot">' +
                  (Number(p.photo_count) > 0
                    ? '<span class="replay-photo-badge">' + escHtml(String(p.photo_count)) + ' photos</span>'
                    : '') +
                  '<span class="replay-source-badge ' + srcBadge.cls + '">' + escHtml(srcBadge.label) + '</span>' +
                '</div>' +
              '</' + tag + '>'
            );
          })
          .join('') +
        '</div>';
      return;
    }

    if (state.replaySubTab === 'work') {
      const workRows = work.length > 0
        ? '<div class="replay-work-list">' +
          work
            .map((w) => {
              const badge = replayAgentBadgeMeta(w.source);
              return (
                '<div class="replay-work-row">' +
                  '<div class="replay-work-main">' +
                    '<span class="replay-work-project">' + escHtml(stripEmDash(w.project + ': ' + w.title)) + '</span>' +
                    '<span class="replay-work-sub" title="' + escHtml(stripEmDash(w.summary)) + '">' +
                      escHtml(extractReplayHhmm(w.time) + (w.summary ? ' \u00b7 ' + stripEmDash(w.summary) : '')) +
                    '</span>' +
                  '</div>' +
                  '<div class="replay-work-meta">' +
                    '<span class="replay-agent-badge ' + badge.cls + '">' + escHtml(badge.label) + '</span>' +
                    '<span class="replay-card-count">' + escHtml(String(w.count || 1)) + 'x</span>' +
                  '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>'
        : '<div class="replay-empty-state">No coding or agent sessions captured on this day.</div>';

      const docRows = docs.length > 0
        ? '<div class="replay-docs-list">' +
          docs
            .map((d) => (
              '<button type="button" class="replay-doc-row" data-open-doc="' + escHtml(d.path) + '">' +
                '<div class="replay-doc-main">' +
                  '<span class="replay-doc-title">' + escHtml(stripEmDash(d.title || titleFromPath(d.path))) + '</span>' +
                  '<span class="replay-doc-path">' + escHtml(d.path) + '</span>' +
                '</div>' +
                '<div class="replay-work-meta">' +
                  '<span class="replay-agent-badge">' + escHtml(stripEmDash(d.category || 'vault')) + '</span>' +
                '</div>' +
              '</button>'
            ))
            .join('') +
          '</div>'
        : '<div class="replay-empty-state">No Vault, Obsidian, or Apple Notes docs modified on this day.</div>';

      const claimsCard = claims.length > 0
        ? '<section class="replay-card">' +
            '<div class="replay-card-head">' +
              '<h3 class="replay-card-title">Kizuki Claims Captured</h3>' +
              '<span class="replay-card-count">' + claims.length + '</span>' +
            '</div>' +
            '<div class="replay-work-list">' +
              claims
                .map((c) => (
                  '<div class="replay-work-row">' +
                    '<div class="replay-work-main">' +
                      '<span class="replay-work-project">' + escHtml(stripEmDash(c.text)) + '</span>' +
                      '<span class="replay-work-sub">' +
                        escHtml([extractReplayHhmm(c.time), c.target ? stripEmDash(c.target) : ''].filter(Boolean).join(' \u00b7 ')) +
                      '</span>' +
                    '</div>' +
                    '<div class="replay-work-meta">' +
                      '<span class="replay-agent-badge">' + escHtml(stripEmDash(c.kind || 'claim')) + '</span>' +
                    '</div>' +
                  '</div>'
                ))
                .join('') +
            '</div>' +
          '</section>'
        : '';

      panel.innerHTML =
        '<div class="replay-grid-2">' +
          '<section class="replay-card">' +
            '<div class="replay-card-head">' +
              '<h3 class="replay-card-title">Coding &amp; Agent Sessions</h3>' +
              '<span class="replay-card-count">' + work.length + '</span>' +
            '</div>' +
            workRows +
          '</section>' +
          '<section class="replay-card">' +
            '<div class="replay-card-head">' +
              '<h3 class="replay-card-title">Vault &amp; Notes Touched</h3>' +
              '<span class="replay-card-count">' + docs.length + '</span>' +
            '</div>' +
            docRows +
          '</section>' +
        '</div>' +
        claimsCard;
      return;
    }

    // Sub-tab: people
    const peopleCards = people.length > 0
      ? '<div class="replay-people-list">' +
        people
          .map((p) => {
            const pKey = p.key || p.name;
            const chs = Array.isArray(p.channels) ? p.channels.map((c) => channelInfo(c).short).join('/') : '';
            return (
              '<button type="button" class="collab-chip" data-open-person="' +
                escHtml(pKey) +
                '" title="' + escHtml(stripEmDash(p.latest_snippet || p.name)) + '">' +
                '<span class="collab-chip-left">' +
                  '<span class="person-avatar is-sm">' + escHtml(safePersonInitials(p, p.name)) + '</span>' +
                  '<span class="collab-chip-name">' + escHtml(stripEmDash(p.name)) + '</span>' +
                '</span>' +
                '<span class="collab-chip-count tabular">' + escHtml((chs ? chs + ' ' : '') + String(p.count || 1)) + '</span>' +
              '</button>'
            );
          })
          .join('') +
        '</div>'
      : '<div class="replay-empty-state">No direct messages captured on this day.</div>';

    const meetingsCard =
      '<section class="replay-card">' +
        '<div class="replay-card-head">' +
          '<h3 class="replay-card-title">Meetings &amp; Notes</h3>' +
          '<span class="replay-card-count">' + meetings.length + '</span>' +
        '</div>' +
        (meetings.length > 0
          ? '<div class="replay-work-list">' +
            meetings
              .map((m) => {
                const startT = extractReplayHhmm(m.time);
                const endT = extractReplayHhmm(m.end_time);
                const timeStr = startT && endT && endT !== startT ? startT + ' - ' + endT : startT;
                const docPath = m.doc_path || m.wispr_doc_path || '';
                const sub = [
                  timeStr,
                  m.location ? stripEmDash(m.location) : '',
                  Array.isArray(m.participants) && m.participants.length > 0 ? m.participants.slice(0, 4).join(', ') : '',
                ]
                  .filter(Boolean)
                  .join(' \u00b7 ');
                const tag = docPath ? 'button' : 'div';
                const attrs = docPath
                  ? 'type="button" class="replay-work-row is-clickable" data-open-doc="' + escHtml(docPath) + '"'
                  : 'class="replay-work-row"';
                const metaBadges = [];
                if (docPath) {
                  metaBadges.push(
                    '<span class="replay-agent-badge badge-amber k-ch-wispr" style="display:inline-flex;align-items:center;gap:4px;">' +
                      iconSvg('wispr', { size: 11 }) +
                      '<span>Wispr Note</span></span>'
                  );
                }
                if (m.calendar) {
                  metaBadges.push('<span class="replay-agent-badge">' + escHtml(stripEmDash(m.calendar)) + '</span>');
                }
                return (
                  '<' + tag + ' ' + attrs + '>' +
                    '<div class="replay-work-main">' +
                      '<span class="replay-work-project">' + escHtml(stripEmDash(m.title)) + '</span>' +
                      (sub ? '<span class="replay-work-sub">' + escHtml(sub) + '</span>' : '') +
                    '</div>' +
                    (metaBadges.length > 0 ? '<div class="replay-work-meta">' + metaBadges.join('') + '</div>' : '') +
                  '</' + tag + '>'
                );
              })
              .join('') +
            '</div>'
          : '<div class="replay-empty-state">No meetings or notes recorded on this day.</div>') +
      '</section>';

    const commsCard =
      '<section class="replay-card">' +
        '<div class="replay-card-head">' +
          '<h3 class="replay-card-title">Message Highlights</h3>' +
          '<span class="replay-card-count">' + comms.length + '</span>' +
        '</div>' +
        (comms.length > 0
          ? '<div class="replay-work-list">' +
            comms
              .slice(0, 30)
              .map((c) => {
                const info = channelInfo(c.channel);
                const pKey = findPersonKeyInDay(c.sender, day);
                const tag = pKey ? 'button' : 'div';
                const attrs = pKey
                  ? 'type="button" class="replay-work-row" data-open-person="' + escHtml(pKey) + '"'
                  : 'class="replay-work-row"';
                return (
                  '<' + tag + ' ' + attrs + '>' +
                    '<div class="replay-work-main">' +
                      '<span class="replay-work-project">' +
                        escHtml(stripEmDash(c.sender)) +
                        (c.thread_title && c.thread_title !== c.sender ? ' \u00b7 ' + escHtml(stripEmDash(c.thread_title)) : '') +
                      '</span>' +
                      '<span class="replay-work-sub" title="' + escHtml(stripEmDash(c.snippet)) + '">' +
                        escHtml([extractReplayHhmm(c.time), stripEmDash(c.snippet)].filter(Boolean).join(' \u00b7 ')) +
                      '</span>' +
                    '</div>' +
                    '<div class="replay-work-meta">' +
                      '<span class="replay-agent-badge">' + escHtml(info.short) + '</span>' +
                    '</div>' +
                  '</' + tag + '>'
                );
              })
              .join('') +
            '</div>'
          : '<div class="replay-empty-state">No message snippets recorded on this day.</div>') +
      '</section>';

    panel.innerHTML =
      '<section class="replay-card">' +
        '<div class="replay-card-head">' +
          '<h3 class="replay-card-title">People Contacted</h3>' +
          '<span class="replay-card-count">' + people.length + '</span>' +
        '</div>' +
        peopleCards +
      '</section>' +
      '<div class="replay-grid-2">' +
        meetingsCard +
        commsCard +
      '</div>';
  }

  async function synthesizeReplayStory({ regenerate = false } = {}) {
    const dayStr = state.replaySelectedDay;
    if (!dayStr || state.replayStoryBusy) return;

    state.replayStoryBusy = true;
    renderReplayStage();
    showToast('Synthesizing day story for ' + formatReplayRowDate(dayStr) + '...', 'info', 'replay-story');
    const started = performance.now();

    try {
      const res = await apiPost('/api/replay/story', { day: dayStr, regenerate: Boolean(regenerate) });
      if (!res || res.ok === false || res.error) {
        throw new Error((res && res.error) || 'Story synthesis failed');
      }
      const md = stripEmDash(res.story_md || res.md || res.markdown || res.answer || '');
      if (!md.trim()) {
        throw new Error('Synthesizer returned empty story');
      }

      if (state.replayDay && state.replayDay.day === dayStr) {
        state.replayDay.story_md = md;
        state.replayDayCache.set(dayStr, state.replayDay);
      }
      state.replayStoryMeta = {
        engine: res.engine || 'Local Day Synthesizer',
        cached: Boolean(res.cached),
        latency_ms: res.latency_ms || Math.round(performance.now() - started),
      };
      state.replayStoryBusy = false;
      renderReplayStage();
      showToast('Day story ready for ' + formatReplayRowDate(dayStr) + '.', 'success', 'replay-story');
    } catch (err) {
      state.replayStoryBusy = false;
      renderReplayStage();
      showToast('Story synthesis failed: ' + err.message, 'error', 'replay-story');
    }
  }

  function openReplayImportModal() {
    state.replayImportOpen = true;
    const backdrop = $('#replay-import-backdrop');
    if (backdrop) backdrop.hidden = false;
    const status = $('#replay-import-status');
    if (status && !state.replayImportBusy) {
      status.hidden = true;
      status.className = 'replay-import-receipt';
      status.textContent = '';
    }
    const fileInput = $('#replay-import-file');
    if (fileInput) fileInput.value = '';
  }

  function closeReplayImportModal() {
    state.replayImportOpen = false;
    const backdrop = $('#replay-import-backdrop');
    if (backdrop) backdrop.hidden = true;
    const dz = $('#replay-import-dropzone');
    if (dz) dz.classList.remove('is-dragover');
  }

  async function handleReplayImportFile(file) {
    if (!file || state.replayImportBusy) return;
    const statusEl = $('#replay-import-status');
    const setStatus = (cls, msg) => {
      if (!statusEl) return;
      statusEl.hidden = false;
      statusEl.className = 'replay-import-receipt ' + cls;
      statusEl.textContent = stripEmDash(msg);
    };

    state.replayImportBusy = true;
    setStatus('is-loading', 'Reading ' + file.name + ' (' + formatBytes(file.size) + ')...');

    try {
      const rawText = await file.text();
      try {
        JSON.parse(rawText);
      } catch (_) {
        throw new Error('Selected file is not valid JSON. Choose Timeline.json, Records.json, or Semantic Location History.');
      }

      setStatus('is-loading', 'Uploading and indexing GPS history into local vault...');
      const res = await fetch('/api/replay/import-location', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Kizuki-Request': '1',
        },
        body: rawText,
      });
      const data = await res.json().catch(() => ({ ok: false, error: 'Invalid server JSON response' }));
      if (!res.ok || data.ok === false || data.error) {
        throw new Error(data.error || 'HTTP ' + res.status);
      }

      const importedCount = Number(data.imported_count || 0);
      const uniqueDays = Number(data.unique_days || 0);
      const fmt = data.format ? ' (' + data.format + ')' : '';
      setStatus(
        'is-success',
        'Imported ' +
          formatCompact(importedCount) +
          ' location records across ' +
          formatCompact(uniqueDays) +
          ' unique days' +
          fmt +
          '. Refreshing Life Map...'
      );
      showToast(
        'Imported ' + formatCompact(importedCount) + ' GPS records across ' + uniqueDays + ' days.',
        'success',
        'replay-import'
      );

      state.replayIndexCache.clear();
      state.replayDayCache.clear();
      await loadReplayIndex({
        year: state.replayYear || undefined,
        targetDay: state.replaySelectedDay || undefined,
        forceRefresh: true,
      });
      setStatus(
        'is-success',
        'Done: imported ' +
          formatCompact(importedCount) +
          ' location records across ' +
          formatCompact(uniqueDays) +
          ' unique days' +
          fmt +
          '. Life Map updated.'
      );
    } catch (err) {
      setStatus('is-error', 'Import failed: ' + err.message);
      showToast('Maps import failed: ' + err.message, 'error', 'replay-import');
    } finally {
      state.replayImportBusy = false;
    }
  }

  // =========================================================================
  // VIEW 4: FULL VAULT MARKDOWN EXPLORER + READER + EDITOR (16.9K DOCS)
  // =========================================================================
  function extractDocItems(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    if (Array.isArray(res.items)) return res.items;
    if (Array.isArray(res.docs)) return res.docs;
    if (Array.isArray(res.files)) return res.files;
    return [];
  }

  function extractDocsTotal(res) {
    if (!res || typeof res !== 'object') return 0;
    return Number(res.total ?? res.total_count ?? res.count ?? extractDocItems(res).length ?? 0);
  }

  function extractDocCategories(res) {
    if (!res || typeof res !== 'object') return {};
    const raw = res.categories || res.counts_by_category || res.facets || null;
    if (!raw) return {};
    if (Array.isArray(raw)) {
      const map = {};
      for (const item of raw) {
        if (!item) continue;
        const key = String(item.key || item.id || item.name || item.category || '').toLowerCase();
        if (key) map[key] = Number(item.count ?? item.total ?? 0);
      }
      return map;
    }
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      map[String(k).toLowerCase()] = Number(v || 0);
    }
    return map;
  }

  async function loadVaultDocs({ reset = false } = {}) {
    if (reset) {
      state.vaultOffset = 0;
      state.vaultDocs = [];
    }
    const listEl = $('#vault-doc-list');
    if (reset && listEl) {
      listEl.innerHTML = '<div class="dir-empty">Loading vault documents...</div>';
    }

    const params = new URLSearchParams();
    if (state.vaultCategory && state.vaultCategory !== 'all') params.set('category', state.vaultCategory);
    if (state.vaultQuery.trim()) params.set('q', state.vaultQuery.trim());
    params.set('sort', state.vaultSort);
    params.set('limit', String(state.vaultLimit));
    params.set('offset', String(state.vaultOffset));

    try {
      const res = await apiGet('/api/docs?' + params.toString());
      state.vaultLoaded = true;
      const items = extractDocItems(res);
      const total = extractDocsTotal(res);
      const cats = extractDocCategories(res);

      if (Object.keys(cats).length > 0) {
        state.vaultCategories = Object.assign({}, state.vaultCategories, cats);
      }
      if (state.vaultCategory === 'all' && !state.vaultQuery.trim() && total > 0) {
        state.vaultCategories.all = total;
        state.vaultTotal = total;
        const compactTotal = formatCompact(total);
        setNavCount('nav-count-vault', compactTotal);
        const vaultSearchInput = $('#vault-search');
        if (vaultSearchInput) vaultSearchInput.placeholder = 'Search ' + compactTotal + ' docs...';
      }

      state.vaultDocs = reset ? items : state.vaultDocs.concat(items);
      state.vaultOffset = state.vaultDocs.length;
      state.vaultHasMore =
        res.has_more !== undefined
          ? Boolean(res.has_more)
          : res.hasMore !== undefined
          ? Boolean(res.hasMore)
          : state.vaultDocs.length < total;

      const countEl = $('#vault-result-count');
      if (countEl) countEl.textContent = formatCompact(total) + ' docs';

      renderVaultCategories();
      renderVaultDocList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = '<div class="dir-empty">Failed to load vault docs: ' + escHtml(err.message) + '</div>';
      }
    }
  }

  function renderVaultCategories() {
    const el = $('#vault-cat-list');
    if (!el) return;
    const counts = Object.assign({}, state.vaultCategories || {});

    if (counts.all === undefined || counts.all === null) {
      if (state.vaultTotal > 0) {
        counts.all = state.vaultTotal;
      } else {
        const summed = Object.entries(counts)
          .filter(([k]) => k !== 'all')
          .reduce((acc, [, v]) => acc + (Number(v) || 0), 0);
        if (summed > 0) counts.all = summed;
      }
    }

    const seen = new Set();
    const list = [];

    for (const c of CANONICAL_VAULT_CATS) {
      seen.add(c.key);
      const cnt = counts[c.key];
      if (c.key !== 'all' && state.vaultLoaded && (cnt === undefined || Number(cnt) <= 0) && state.vaultCategory !== c.key) {
        continue;
      }
      list.push({ key: c.key, label: c.label, count: cnt });
    }
    for (const [k, v] of Object.entries(counts)) {
      if (!seen.has(k) && Number(v) > 0) {
        const niceLabel = k
          .split(/[-_]+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        list.push({ key: k, label: niceLabel, count: v });
      }
    }

    el.innerHTML = list
      .map((cat) => {
        const active = state.vaultCategory === cat.key;
        const formatted = cat.count !== undefined && cat.count !== null ? formatCatCount(cat.count) : '';
        const countBadge = formatted ? '<span class="vault-cat-count">' + escHtml(formatted) + '</span>' : '';
        const titleAttr =
          cat.count !== undefined && cat.count !== null
            ? ' title="' + escHtml(cat.label + ': ' + Number(cat.count).toLocaleString('en-US') + ' docs') + '"'
            : '';
        const catIcon = iconSvg(vaultCatIconName(cat.key), { size: 12, className: 'k-pill-icon' });
        return (
          '<button type="button" class="vault-cat-btn' +
          (active ? ' is-active' : '') +
          '" role="tab" aria-selected="' +
          (active ? 'true' : 'false') +
          '" data-vault-cat="' +
          escHtml(cat.key) +
          '"' +
          titleAttr +
          '>' +
          '<span style="display:inline-flex;align-items:center;gap:5px;">' + catIcon + '<span>' + escHtml(cat.label) + '</span></span>' +
          countBadge +
          '</button>'
        );
      })
      .join('');
  }

  function renderVaultDocList() {
    const el = $('#vault-doc-list');
    const pagWrap = $('#vault-pagination');
    if (!el) return;

    if (state.vaultDocs.length === 0) {
      el.innerHTML = '<div class="dir-empty">No documents match this filter.</div>';
      if (pagWrap) pagWrap.hidden = true;
      return;
    }

    el.innerHTML = state.vaultDocs
      .map((doc) => {
        const path = doc.path || doc.rel_path || '';
        const title = stripEmDash(doc.title || titleFromPath(path));
        const wisprDateMatch = String(path).match(/^wispr-flow\/(\d{4}-\d{2}-\d{2})-/i)
          || (String(doc.category || '').toLowerCase() === 'wispr-flow' && String(path).match(/(?:^|\/)(\d{4}-\d{2}-\d{2})-/));
        const when = wisprDateMatch
          ? formatShortDate(wisprDateMatch[1])
          : formatRelativeTime(doc.updated_at || doc.mtime || doc.modified_at);
        const bytes = formatBytes(doc.size_bytes ?? doc.bytes ?? doc.size);
        const excerpt = stripEmDash(doc.excerpt || doc.preview || '');
        const active = state.activeDocPath === path;
        return (
          '<button type="button" class="vault-doc-item' +
          (active ? ' is-active' : '') +
          '" role="listitem" data-open-doc="' +
          escHtml(path) +
          '">' +
          '<span class="vault-doc-title">' + escHtml(title) + '</span>' +
          '<div class="vault-doc-meta">' +
          '<span class="vault-doc-path">' + escHtml(path) + '</span>' +
          '<span class="tabular">' + escHtml(when || bytes) + '</span>' +
          '</div>' +
          (excerpt ? '<span class="vault-doc-excerpt">' + escHtml(excerpt.slice(0, 96)) + '</span>' : '') +
          '</button>'
        );
      })
      .join('');

    if (pagWrap) pagWrap.hidden = !state.vaultHasMore;
  }

  function isDocEditable(path, apiFlag) {
    if (typeof apiFlag === 'boolean') return apiFlag;
    const p = String(path || '').toLowerCase();
    return (
      p === 'owner-anchors.md' ||
      p.startsWith('owner-notes/') ||
      p.startsWith('owner/') ||
      p.startsWith('notes/')
    );
  }

  async function openVaultDoc(docPath, opts = {}) {
    if (!docPath) return;
    if (state.view !== 'vault') {
      switchView('vault', { skipAutoOpen: true, updateUrl: false });
    }

    state.docEditMode = false;
    state.docRawMode = false;
    state.docIsNewNote = false;
    $('#doc-editor-wrap').hidden = true;
    $('#doc-raw-view').hidden = true;
    $('#doc-content').hidden = false;
    $('#btn-doc-raw').setAttribute('aria-pressed', 'false');
    $('#doc-content').innerHTML = '<div class="skeleton-block"></div>';

    try {
      const data = await apiGet('/api/docs/read?path=' + encodeURIComponent(docPath));
      const path = data.path || docPath;
      const md = data.content ?? data.markdown ?? data.body ?? '';
      const parsed = renderMarkdownDocument(md);
      const mergedFm = Object.assign({}, parsed.frontmatter || {}, data.frontmatter || {});
      const title = stripEmDash(data.title || mergedFm.title || titleFromPath(path));
      const editable = isDocEditable(path, data.editable ?? data.writable);

      state.activeDocPath = path;
      state.activeDoc = {
        path,
        title,
        markdown: md,
        html: parsed.html,
        frontmatter: mergedFm,
        toc: parsed.toc,
        editable,
        updated_at: data.updated_at || data.mtime || data.modified_at || null,
        bytes: data.size_bytes ?? data.bytes ?? data.size ?? md.length,
        related: Array.isArray(data.related_docs)
          ? data.related_docs
          : Array.isArray(data.related)
          ? data.related
          : [],
      };

      updateUrlParams({ view: 'vault', doc: path });
      renderActiveDoc();
      renderVaultDocList();

      if (opts.edit && editable) {
        enterDocEditor(false);
      }
    } catch (err) {
      if (opts.fallbackFirst && state.vaultDocs.length > 0 && state.vaultDocs[0].path !== docPath) {
        openVaultDoc(state.vaultDocs[0].path, { fallbackFirst: false });
        return;
      }
      if (opts.edit && isDocEditable(docPath)) {
        state.activeDocPath = docPath;
        state.activeDoc = {
          path: docPath,
          title: titleFromPath(docPath),
          markdown: '# ' + titleFromPath(docPath) + '\n\n',
          html: '',
          frontmatter: {},
          toc: [],
          editable: true,
          updated_at: null,
          bytes: 0,
          related: [],
        };
        renderActiveDoc();
        enterDocEditor(false);
        return;
      }
      $('#doc-title').textContent = titleFromPath(docPath);
      $('#doc-content').innerHTML =
        '<div class="empty-state">Unable to open document "' + escHtml(docPath) + '" (' + escHtml(err.message) + ').</div>';
    }
  }

  function renderDocBreadcrumbs(path) {
    const el = $('#doc-path');
    if (!el) return;
    const segments = String(path || '').split('/').filter(Boolean);
    if (segments.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = segments
      .map((seg, idx) => {
        const atEnd = idx === segments.length - 1;
        const sep = idx > 0 ? '<span class="crumb-sep" aria-hidden="true">/</span>' : '';
        if (atEnd) return sep + '<span class="crumb-btn is-current">' + escHtml(seg) + '</span>';
        const catKey = idx === 0 ? seg.toLowerCase() : '';
        return sep + '<button type="button" class="crumb-btn" data-vault-crumb="' + escHtml(catKey) + '">' + escHtml(seg) + '</button>';
      })
      .join('');
  }

  function isOpaqueRecordId(str) {
    const s = String(str || '').trim();
    if (s.length < 18) return false;
    return (
      /^[0-9A-HJKMNP-TV-Z]{20,}$/i.test(s) ||
      /^[a-f0-9]{20,}$/i.test(s) ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)
    );
  }

  function formatFrontmatterValue(key, rawVal) {
    let v = rawVal;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) v = parsed;
        } catch (_) {
          // keep as string
        }
      }
    }

    const lowerKey = String(key || '').toLowerCase();
    const recordArrayKey =
      lowerKey === 'sources' ||
      lowerKey === 'source_ids' ||
      lowerKey === 'evidence' ||
      lowerKey === 'event_ids' ||
      lowerKey === 'claim_ids' ||
      lowerKey === 'records';

    if (Array.isArray(v)) {
      const items = v
        .map((item) => (item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item).trim()))
        .filter(Boolean);
      if (items.length === 0) return null;

      if (recordArrayKey || items.every((item) => isOpaqueRecordId(item))) {
        return {
          text: items.length + (items.length === 1 ? ' record' : ' records'),
          tooltip: items.slice(0, 8).join(', ') + (items.length > 8 ? ' ... (' + items.length + ' total)' : ''),
        };
      }
      if (items.length <= 2 && items.every((item) => item.length <= 24 && !isOpaqueRecordId(item))) {
        const joined = items.join(', ');
        return { text: joined, tooltip: joined };
      }
      const first = items[0];
      if (first.length <= 24 && !isOpaqueRecordId(first)) {
        return {
          text: first + ' +' + (items.length - 1) + ' more',
          tooltip: items.slice(0, 10).join(', '),
        };
      }
      return {
        text: items.length + (items.length === 1 ? ' record' : ' records'),
        tooltip: items.slice(0, 6).join(', '),
      };
    }

    if (typeof v === 'object' && v !== null) {
      const rawJson = JSON.stringify(v);
      if (rawJson.length <= 40) return { text: rawJson, tooltip: rawJson };
      return { text: Object.keys(v).length + ' fields', tooltip: rawJson.slice(0, 200) };
    }

    const str = String(v).trim();
    if (!str) return null;
    if (isOpaqueRecordId(str)) return { text: str.slice(0, 8) + '...', tooltip: str };
    return { text: str.length > 48 ? str.slice(0, 45) + '...' : str, tooltip: str };
  }

  function renderFrontmatterBar(fm) {
    const bar = $('#doc-frontmatter');
    if (!bar) return;
    const NOISY_INTERNAL_RE = /^(?:x-legacy-title-source|x-source-record-id|x-legacy-|x-source-|x-internal-|source_record_id)$/i;

    const rawEntries = Object.entries(fm || {}).filter(([k, v]) => {
      if (String(k || '').toLowerCase() === 'title') return false;
      if (v === null || v === undefined) return false;
      if (Array.isArray(v)) return v.length > 0;
      return String(v).trim() !== '';
    });

    const filteredEntries =
      rawEntries.length > 6
        ? rawEntries.filter(([k]) => !NOISY_INTERNAL_RE.test(String(k || '')))
        : rawEntries;

    const chips = [];
    for (const [k, v] of filteredEntries) {
      const formatted = formatFrontmatterValue(k, v);
      if (!formatted) continue;
      chips.push({ key: k, text: formatted.text, tooltip: formatted.tooltip });
      if (chips.length >= 8) break;
    }

    if (chips.length === 0) {
      bar.hidden = true;
      bar.classList.add('is-mobile-collapsed');
      bar.innerHTML = '';
      return;
    }

    bar.hidden = false;
    bar.classList.add('is-mobile-collapsed');
    const chipsHtml = chips
      .map(
        (chip) =>
          '<span class="fm-chip" title="' +
          escHtml(chip.key + ': ' + chip.tooltip) +
          '"><span class="fm-key">' +
          escHtml(chip.key) +
          '</span><span class="fm-val">' +
          escHtml(chip.text) +
          '</span></span>'
      )
      .join('');
    bar.innerHTML =
      '<button type="button" class="frontmatter-toggle-btn" data-toggle-frontmatter="true" aria-expanded="false">Metadata (' +
      chips.length +
      ')</button>' +
      '<div class="fm-grid frontmatter-chips">' +
      chipsHtml +
      '</div>';
  }

  function renderDocToc(toc) {
    const el = $('#doc-toc-list');
    if (!el) return;
    let items = Array.isArray(toc) ? toc : [];
    if (items.length === 0) {
      const headings = $$('#doc-content h1, #doc-content h2, #doc-content h3, #doc-content h4');
      items = headings.map((h, i) => {
        if (!h.id) h.id = 'sec-' + i + '-' + h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
        return { id: h.id, text: h.textContent.trim(), level: Number(h.tagName.slice(1)) || 2 };
      });
    }
    if (items.length === 0) {
      el.innerHTML = '<p class="panel-subtitle">No headings in document.</p>';
      return;
    }
    el.innerHTML = items
      .map((item) => {
        const lvl = Math.max(2, Math.min(3, Number(item.level || 2)));
        return (
          '<button type="button" class="toc-link level-' + lvl + '" data-toc-id="' + escHtml(item.id || '') + '">' +
          escHtml(item.text || item.title || '') +
          '</button>'
        );
      })
      .join('');
  }

  function renderDocRelated(doc) {
    const el = $('#doc-related-list');
    if (!el) return;
    const related = Array.isArray(doc.related) ? doc.related : [];
    const wikiMatches = [];
    if (related.length === 0 && doc.markdown) {
      const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const seen = new Set();
      let m;
      while ((m = re.exec(doc.markdown)) !== null && wikiMatches.length < 8) {
        const target = m[1].trim();
        if (target && !seen.has(target.toLowerCase())) {
          seen.add(target.toLowerCase());
          wikiMatches.push(target);
        }
      }
    }
    if (related.length > 0) {
      const isCaptureNoise = (r) => {
        const p = typeof r === 'string' ? r : (r.path || '');
        const t = typeof r === 'string' ? titleFromPath(r) : (r.title || titleFromPath(p));
        return (
          /^capture from kizuki\.markdown[-_.]?folder/i.test(String(t || '').trim()) ||
          /capture[-_ ]from[-_ ]kizuki[-_.]markdown/i.test(String(p || ''))
        );
      };
      const activeDocPathLower = String(doc.path || '').trim().toLowerCase();
      const activeDocTitleLower = String(doc.title || '').trim().toLowerCase();
      const seenPaths = new Set(activeDocPathLower ? [activeDocPathLower] : []);
      const seenTitles = new Set(activeDocTitleLower ? [activeDocTitleLower] : []);
      const deduped = related.filter((r) => {
        if (!r) return false;
        const p = String(typeof r === 'string' ? r : (r.path || '')).trim();
        const t = String(typeof r === 'string' ? titleFromPath(r) : (r.title || titleFromPath(p))).trim().toLowerCase();
        const key = p.toLowerCase();
        if (!key || seenPaths.has(key) || (t && seenTitles.has(t))) return false;
        seenPaths.add(key);
        if (t) seenTitles.add(t);
        return true;
      });
      const nonNoise = deduped.filter((r) => !isCaptureNoise(r));
      const finalRel = (nonNoise.length > 0 ? nonNoise : deduped).slice(0, 10);

      el.innerHTML = finalRel
        .map((r) => {
          const p = typeof r === 'string' ? r : (r.path || '');
          const label = stripEmDash(typeof r === 'string' ? titleFromPath(r) : (r.title || titleFromPath(p)));
          const cat = inferDocCategory(r, p);
          return (
            '<button type="button" class="related-doc-item is-stacked" data-open-doc="' + escHtml(p) + '">' +
            '<span class="related-doc-title">' + escHtml(label) + '</span>' +
            '<span class="related-doc-cat badge badge-neutral">' + escHtml(cat) + '</span>' +
            '</button>'
          );
        })
        .join('');
    } else if (wikiMatches.length > 0) {
      el.innerHTML = wikiMatches
        .map(
          (w) =>
            '<button type="button" class="related-doc-item is-stacked" data-open-wikilink="' + escHtml(w) + '">' +
            '<span class="related-doc-title">' + escHtml(stripEmDash(w)) + '</span>' +
            '<span class="related-doc-cat badge badge-neutral">link</span>' +
            '</button>'
        )
        .join('');
    } else {
      el.innerHTML = '<p class="panel-subtitle">No linked documents.</p>';
    }
  }

  function renderActiveDoc() {
    const doc = state.activeDoc;
    if (!doc) return;
    renderDocBreadcrumbs(doc.path);
    const headerTitle = stripEmDash(doc.title || titleFromPath(doc.path));
    $('#doc-title').textContent = headerTitle;
    const metaParts = [];
    if (doc.updated_at) metaParts.push('Updated ' + formatRelativeTime(doc.updated_at));
    if (doc.bytes) metaParts.push(formatBytes(doc.bytes));
    if (doc.editable) metaParts.push('Editable');
    $('#doc-meta').textContent = metaParts.join(' / ');
    $('#btn-doc-edit').hidden = !doc.editable;
    renderFrontmatterBar(doc.frontmatter);
    const contentEl = $('#doc-content');
    contentEl.innerHTML = doc.html || renderMarkdownHtml(doc.markdown);
    const removedH1 = stripDuplicateLeadingH1(contentEl, headerTitle);
    const filteredToc = removedH1 && Array.isArray(doc.toc)
      ? doc.toc.filter((item, idx) => {
          if (idx === 0 && Number(item.level || 2) === 1) {
            if ((removedH1.id && item.id === removedH1.id) || titlesSubstantiallyMatch(item.text || item.title, removedH1.text)) {
              return false;
            }
          }
          return true;
        })
      : doc.toc;
    $('#doc-raw-view').textContent = doc.markdown || '';
    renderDocToc(filteredToc);
    renderDocRelated(doc);
    const scroller = $('#vault-reader-wrap');
    if (scroller) scroller.scrollTop = 0;
  }

  function enterDocEditor(isNewNote) {
    state.docEditMode = true;
    state.docIsNewNote = Boolean(isNewNote);
    state.docRawMode = false;
    $('#btn-doc-raw').setAttribute('aria-pressed', 'false');
    $('#doc-content').hidden = true;
    $('#doc-raw-view').hidden = true;
    $('#doc-editor-wrap').hidden = false;

    const statusEl = $('#doc-save-status');
    statusEl.className = 'doc-editor-status tabular';
    statusEl.textContent = isNewNote ? 'New markdown note' : 'Editing ' + (state.activeDoc ? state.activeDoc.path : '');

    const pathWrap = $('#doc-new-path-wrap');
    const pathInput = $('#doc-new-path-input');
    const textarea = $('#doc-editor-textarea');

    if (isNewNote) {
      const defaultPath = 'owner-notes/note-' + formatTimestampSlug() + '.md';
      pathWrap.hidden = false;
      pathInput.value = defaultPath;
      $('#doc-title').textContent = 'New Vault Note';
      $('#doc-meta').textContent = 'Draft markdown note';
      renderDocBreadcrumbs(defaultPath);
      renderFrontmatterBar({});
      textarea.value = '# New Note\n\n';
      textarea.focus();
    } else if (state.activeDoc) {
      pathWrap.hidden = true;
      textarea.value = state.activeDoc.markdown || '';
      textarea.focus();
    }
  }

  function exitDocEditor() {
    state.docEditMode = false;
    state.docIsNewNote = false;
    $('#doc-editor-wrap').hidden = true;
    $('#doc-content').hidden = false;
    if (state.activeDoc) renderActiveDoc();
  }

  async function saveActiveDoc() {
    const saveBtn = $('#btn-doc-save');
    const statusEl = $('#doc-save-status');
    const textarea = $('#doc-editor-textarea');
    const content = textarea.value;
    const targetPath = state.docIsNewNote
      ? $('#doc-new-path-input').value.trim()
      : (state.activeDoc && state.activeDoc.path);

    if (!targetPath) {
      statusEl.className = 'doc-editor-status is-error tabular';
      statusEl.textContent = 'Provide a file path (e.g. owner-notes/note.md).';
      return;
    }

    saveBtn.disabled = true;
    statusEl.className = 'doc-editor-status tabular';
    statusEl.textContent = 'Saving...';

    try {
      const res = await apiPost('/api/docs/save', { path: targetPath, content });
      if (res.ok === false) {
        statusEl.className = 'doc-editor-status is-error tabular';
        statusEl.textContent = res.error || 'Failed to save document.';
        showToast(res.error || 'Save failed.', 'error');
        return;
      }

      const savedPath = res.path || targetPath;
      statusEl.className = 'doc-editor-status is-saved tabular';
      statusEl.textContent = 'Saved.';
      showToast('Saved ' + savedPath, 'success');
      state.docEditMode = false;
      state.docIsNewNote = false;
      $('#doc-editor-wrap').hidden = true;
      $('#doc-content').hidden = false;

      await openVaultDoc(savedPath);
      loadVaultDocs({ reset: true });
      if (savedPath === 'owner-anchors.md') loadToday({ silent: true });
    } catch (err) {
      statusEl.className = 'doc-editor-status is-error tabular';
      statusEl.textContent = err.message || 'Network error.';
      showToast('Save error: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function openWikilink(targetName) {
    const q = String(targetName || '').trim();
    if (!q) return;
    switchView('vault', { skipAutoOpen: true });
    try {
      const res = await apiGet('/api/docs?q=' + encodeURIComponent(q) + '&limit=8');
      const items = extractDocItems(res);
      if (items.length > 0) {
        const lower = q.toLowerCase();
        const exact = items.find((d) => {
          const p = String(d.path || '').toLowerCase();
          const t = String(d.title || titleFromPath(p)).toLowerCase();
          return t === lower || p.endsWith('/' + lower + '.md') || p === lower + '.md';
        });
        await openVaultDoc((exact || items[0]).path);
        return;
      }
      state.vaultQuery = q;
      const searchInput = $('#vault-search');
      if (searchInput) searchInput.value = q;
      loadVaultDocs({ reset: true });
      showToast('No exact wikilink match for "' + q + '"; showing search results.');
    } catch (err) {
      showToast('Wikilink lookup failed: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // VIEW 4: 3-ZONE MIND GRAPH WORKSPACE (LAZY-INIT + PREFETCH)
  // =========================================================================
  function ensureGraphReady() {
    if (!graph) {
      const canvas = $('#graph-canvas');
      if (canvas && window.KizukiGraph) {
        graph = new window.KizukiGraph(canvas, {
          detailOn: state.detailOn,
          onSelectNode: (node) => openNodeInspector(node),
          onClearSelection: () => closeNodeInspector(),
          onHoverNode: (payload) => renderGraphTooltip(payload),
          onCameraUpdate: ({ x, y, zoom, visibleCount }) => {
            const vx = $('#vernier-x');
            const vy = $('#vernier-y');
            const vz = $('#vernier-z');
            const vn = $('#vernier-n');
            if (vx) vx.textContent = x.toFixed(1);
            if (vy) vy.textContent = y.toFixed(1);
            if (vz) vz.textContent = zoom.toFixed(2) + 'x';
            if (vn) vn.textContent = String(visibleCount);
          },
          onVisibleChange: ({ visibleCount }) => {
            if (state.graphData.nodes.length > 0 && visibleCount === 0) {
              setGraphOverlay('empty', 'No nodes match filter', 'Clear the search query or switch kind filter pills.', false);
            } else if (visibleCount > 0) {
              setGraphOverlay(null);
            }
          },
        });
      }
    }

    if (state.graphData.nodes.length > 0 && !state.graphInitialized && graph) {
      state.graphInitialized = true;
      graph.resize();
      graph.setData(state.graphData.nodes, state.graphData.edges);
      setGraphOverlay(null);
    } else if (state.graphData.nodes.length === 0 && !state.graphLoading) {
      loadGraphData({ mountNow: true });
    }
  }

  function renderGraphTooltip(payload) {
    const tip = $('#graph-tooltip');
    if (!tip) return;
    if (!payload || !payload.node) {
      tip.hidden = true;
      return;
    }
    const node = payload.node;
    const summary = stripEmDash(node.summary || '').trim();
    tip.hidden = false;
    tip.innerHTML =
      '<div class="graph-tooltip-head">' +
      '<span class="graph-tooltip-title">' + escHtml(node.label || node.id) + '</span>' +
      '<span class="graph-tooltip-kind">' + escHtml(node.kind || 'node') + '</span>' +
      '</div>' +
      (summary ? '<div class="graph-tooltip-summary">' + escHtml(summary.slice(0, 140)) + '</div>' : '') +
      '<div class="graph-tooltip-meta">' +
      (node.claim_count ? '<span>' + node.claim_count + ' claims</span>' : '') +
      (node.degree ? '<span>' + node.degree + ' links</span>' : '') +
      '</div>';

    const stage = $('#graph-stage');
    const maxX = stage ? stage.clientWidth - 296 : 600;
    const maxY = stage ? stage.clientHeight - 130 : 400;
    tip.style.left = Math.max(12, Math.min(maxX, Math.round((payload.x || 0) + 14))) + 'px';
    tip.style.top = Math.max(54, Math.min(maxY, Math.round((payload.y || 0) + 14))) + 'px';
  }

  function setGraphOverlay(mode, title, desc, showRetry) {
    const el = $('#graph-overlay-state');
    if (!el) return;
    if (!mode) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    $('#graph-state-title').textContent = title || '';
    $('#graph-state-desc').textContent = desc || '';
    $('#btn-graph-retry').hidden = !showRetry;
  }

  function classifyGraphNodeBucket(n) {
    const joined = (String(n.kind || '') + ' ' + String(n.group || '') + ' ' + String(n.source_kind || '')).toLowerCase();
    if (joined.includes('memt') || joined.includes('recipe') || joined.includes('experience') || joined.includes('procedural')) {
      return 'memt';
    }
    if (joined.includes('connector') || joined.includes('source') || joined.includes('feed') || joined.includes('channel')) {
      return 'connector';
    }
    if (n.consolidated || joined.includes('consolidated') || joined.includes('world_object') || joined.includes('world')) {
      return 'consolidated';
    }
    return 'concept';
  }

  function updateFilterCounts(nodes) {
    const counts = { all: 0, consolidated: 0, memt: 0, concept: 0, connector: 0 };
    for (const n of nodes) {
      counts.all += 1;
      const bucket = classifyGraphNodeBucket(n);
      counts[bucket] += 1;
    }
    Object.keys(counts).forEach((key) => {
      const el = $('[data-count-kind="' + key + '"]');
      if (el) el.textContent = String(counts[key]);
    });
    setNavCount('nav-count-graph', String(counts.all));
    syncUnifiedCounters();
  }

  async function loadGraphData({ mountNow = false } = {}) {
    if (state.graphLoading) return;
    state.graphLoading = true;
    if (mountNow || state.view === 'graph') {
      setGraphOverlay('loading', 'Mapping Mind Graph...', 'Loading consolidated world objects, concepts, and MemT recipes.', false);
    }
    try {
      const data = await apiGet('/api/graph?limit=180&kind=all&q=');
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      const edges = Array.isArray(data.edges) ? data.edges : [];
      state.graphData = { nodes, edges, stats: data.stats || {} };
      updateFilterCounts(nodes);
      renderMindDirectory();

      if (state.view === 'graph' || mountNow) {
        ensureGraphReady();
        if (graph && !state.graphInitialized) {
          state.graphInitialized = true;
          graph.resize();
          graph.setData(nodes, edges);
        }
        if (nodes.length === 0) {
          setGraphOverlay('empty', 'No graph nodes returned', 'The vault graph query returned 0 nodes.', true);
        } else {
          setGraphOverlay(null);
        }
      }
    } catch (err) {
      if (state.view === 'graph' || mountNow) {
        setGraphOverlay('error', 'Failed to load Mind Graph', err.message || 'Check Kizuki Explorer backend connection.', true);
      }
    } finally {
      state.graphLoading = false;
    }
  }

  function renderMindDirectory() {
    const list = $('#dir-list');
    if (!list) return;
    const nodes = state.graphData.nodes || [];
    const q = state.dirSearch.trim().toLowerCase();

    const filtered = nodes.filter((n) => {
      const bucket = classifyGraphNodeBucket(n);
      if (state.dirTab === 'memt') {
        if (bucket !== 'memt') return false;
      } else if (state.dirTab === 'concepts') {
        if (bucket !== 'concept') return false;
      } else if (state.dirTab === 'sources') {
        if (bucket !== 'connector') return false;
      } else {
        if (bucket !== 'consolidated') return false;
      }
      if (!q) return true;
      const hay = (String(n.label || '') + ' ' + String(n.summary || '') + ' ' + String(n.kind || '')).toLowerCase();
      return hay.includes(q);
    });

    filtered.sort((a, b) => {
      const sa = (a.consolidated ? 200 : 0) + Number(a.degree || 0) * 10 + Math.min(200, Number(a.claim_count || 0));
      const sb = (b.consolidated ? 200 : 0) + Number(b.degree || 0) * 10 + Math.min(200, Number(b.claim_count || 0));
      return sb - sa;
    });

    const capped = filtered.slice(0, 60);
    if (capped.length === 0) {
      list.innerHTML = '<div class="dir-empty">No matching nodes in this group.</div>';
      return;
    }

    list.innerHTML = capped
      .map((n) => {
        const k = String(n.kind || '').toLowerCase();
        const dotClass =
          k.includes('memt') ? 'is-memt' :
          k.includes('connector') ? 'is-connector' :
          k.includes('stale') || k.includes('attention') ? 'is-attention' :
          n.consolidated ? 'is-consolidated' : '';
        const selected = state.selectedNodeId === n.id ? ' is-selected' : '';
        const countVal = Number(n.claim_count || n.degree || 0);
        const countLabel = countVal > 0 ? formatCompact(countVal) : '';
        const summary = stripEmDash(String(n.summary || '')).replace(/\s+/g, ' ').trim();
        return (
          '<button type="button" class="dir-item' + selected + '" role="listitem" data-dir-node="' + escHtml(n.id) + '">' +
          '<div class="dir-item-top">' +
          '<span class="dir-dot ' + dotClass + '" aria-hidden="true"></span>' +
          '<span class="dir-item-title">' + escHtml(n.label || n.id) + '</span>' +
          (countLabel ? '<span class="dir-item-count">' + escHtml(countLabel) + '</span>' : '') +
          '</div>' +
          (summary ? '<div class="dir-item-sub">' + escHtml(summary.slice(0, 88)) + '</div>' : '') +
          '</button>'
        );
      })
      .join('');
  }

  function pushBreadcrumb(node) {
    if (!node || !node.id) return;
    const id = String(node.id);
    const label = String(node.label || id);
    const existingIdx = state.breadcrumbs.findIndex((b) => b.id === id);
    if (existingIdx !== -1) state.breadcrumbs = state.breadcrumbs.slice(0, existingIdx + 1);
    else {
      state.breadcrumbs.push({ id, label });
      if (state.breadcrumbs.length > 5) state.breadcrumbs.shift();
    }
    renderBreadcrumbs();
  }

  function renderBreadcrumbs() {
    const bar = $('#graph-breadcrumbs');
    if (!bar) return;
    if (state.breadcrumbs.length === 0) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    bar.innerHTML = state.breadcrumbs
      .map((b, idx) => {
        const atEnd = idx === state.breadcrumbs.length - 1;
        return (
          (idx > 0 ? '<span class="crumb-sep" aria-hidden="true">/</span>' : '') +
          '<button type="button" class="crumb-btn' + (atEnd ? ' is-current' : '') + '" data-jump-node="' + escHtml(b.id) + '">' +
          escHtml(b.label) +
          '</button>'
        );
      })
      .join('');
  }

  async function openNodeInspector(nodeOrId) {
    const id = typeof nodeOrId === 'object' ? nodeOrId.id : String(nodeOrId);
    if (!id) return;

    state.selectedNodeId = id;
    const drawer = $('#node-inspector');
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    const shell = $('#app-shell');
    if (shell) shell.classList.add('inspector-open');

    const graphNode = graph ? graph.getNodeById(id) : state.graphData.nodes.find((n) => n.id === id);
    if (graphNode) {
      pushBreadcrumb(graphNode);
      renderMindDirectory();
      renderInspectorHeader({
        id: graphNode.id,
        label: graphNode.label,
        kind: graphNode.kind,
        consolidated: graphNode.consolidated,
        confidence: graphNode.confidence,
        updated_at: graphNode.updated_at,
        claim_count: graphNode.claim_count,
        summary: graphNode.summary || 'Loading full node claims and neighbors...',
      });
    } else {
      $('#inspector-title').textContent = id;
      $('#inspector-summary').innerHTML = '<p>Loading node details...</p>';
    }

    try {
      const detail = await apiGet('/api/node/' + encodeURIComponent(id));
      if (state.selectedNodeId !== id) return;
      state.selectedNodeDetail = detail;
      renderInspectorFull(detail);
    } catch (err) {
      if (state.selectedNodeId !== id) return;
      $('#inspector-claims-list').innerHTML =
        '<p class="empty-state">Unable to load full node detail (' + escHtml(err.message) + ').</p>';
    }
  }

  function renderInspectorHeader(node) {
    const badges = ['<span class="badge ' + badgeClassForKind(node.kind, node.consolidated) + '">' + escHtml(node.kind || 'node') + '</span>'];
    if (node.consolidated) badges.push('<span class="badge badge-amber">Consolidated</span>');
    $('#inspector-badges').innerHTML = badges.join('');
    $('#inspector-title').textContent = node.label || node.id;

    const claimsCount = Array.isArray(node.claims) ? node.claims.length : (node.claim_count !== undefined ? node.claim_count : '--');
    $('#inspector-metrics').innerHTML =
      '<div class="metric-cell"><span class="metric-cell-label">Confidence</span><span class="metric-cell-val tabular">' +
      escHtml(formatConfidence(node.confidence)) + '</span></div>' +
      '<div class="metric-cell"><span class="metric-cell-label">Claims</span><span class="metric-cell-val tabular">' +
      escHtml(String(claimsCount)) + '</span></div>' +
      '<div class="metric-cell"><span class="metric-cell-label">Updated</span><span class="metric-cell-val tabular">' +
      escHtml(formatRelativeTime(node.updated_at) || 'Unknown') + '</span></div>';

    $('#inspector-summary').innerHTML = renderMarkdownHtml(
      node.summary || 'No consolidated summary recorded yet for this node.'
    );
  }

  function renderInspectorRelatedDocs(docs) {
    const sec = $('#inspector-related-docs-section');
    const listEl = $('#inspector-related-docs');
    const countEl = $('#inspector-related-docs-count');
    if (!sec || !listEl) return;

    const arr = Array.isArray(docs) ? docs.slice(0, 6) : [];
    if (arr.length === 0) {
      sec.hidden = true;
      listEl.innerHTML = '';
      if (countEl) countEl.textContent = '0';
      return;
    }

    sec.hidden = false;
    if (countEl) countEl.textContent = String(arr.length);
    listEl.innerHTML = arr
      .map((d) => {
        const path = typeof d === 'string' ? d : (d.path || '');
        const title = typeof d === 'string' ? titleFromPath(d) : (d.title || titleFromPath(path));
        return (
          '<button type="button" class="related-doc-btn" data-open-doc="' + escHtml(path) + '">' +
          '<span>' + escHtml(title) + '</span>' +
          '<span class="related-doc-path">' + escHtml(d.category || '.md') + '</span>' +
          '</button>'
        );
      })
      .join('');
  }

  function renderInspectorFull(detail) {
    renderInspectorHeader(detail);

    const memtSec = $('#inspector-memt-section');
    const memtBox = $('#inspector-memt-block');
    if (detail.memt_experience) {
      const m = detail.memt_experience;
      memtSec.hidden = false;
      const rows = [];
      if (m.domain) rows.push('<div class="memt-kv"><span class="memt-kv-label">Domain</span><span class="memt-kv-val">' + escHtml(m.domain) + '</span></div>');
      if (m.condition) rows.push('<div class="memt-kv"><span class="memt-kv-label">Condition</span><span class="memt-kv-val">' + escHtml(m.condition) + '</span></div>');
      if (m.recommendation) rows.push('<div class="memt-kv"><span class="memt-kv-label">Recommendation</span><span class="memt-kv-val">' + escHtml(m.recommendation) + '</span></div>');
      if (m.verification) rows.push('<div class="memt-kv"><span class="memt-kv-label">Verification</span><span class="memt-kv-val tabular">' + escHtml(m.verification) + '</span></div>');
      memtBox.innerHTML = rows.join('') || '<span class="memt-kv-val">' + escHtml(JSON.stringify(m)) + '</span>';
    } else {
      memtSec.hidden = true;
      memtBox.innerHTML = '';
    }

    const relatedDocs = detail.related_docs || detail.docs || [];
    if (Array.isArray(relatedDocs) && relatedDocs.length > 0) {
      renderInspectorRelatedDocs(relatedDocs);
    } else if (detail.label && detail.label.length >= 3) {
      renderInspectorRelatedDocs([]);
      const nodeId = detail.id;
      apiGet('/api/docs?q=' + encodeURIComponent(detail.label) + '&limit=4')
        .then((res) => {
          if (state.selectedNodeId !== nodeId) return;
          renderInspectorRelatedDocs(extractDocItems(res));
        })
        .catch(() => {});
    } else {
      renderInspectorRelatedDocs([]);
    }

    const neighbors = Array.isArray(detail.neighbors) ? detail.neighbors : [];
    $('#inspector-neighbors-count').textContent = String(neighbors.length);
    const nContainer = $('#inspector-neighbors-list');
    if (neighbors.length === 0) {
      nContainer.innerHTML = '<span class="panel-subtitle">No direct neighbors indexed.</span>';
    } else {
      nContainer.innerHTML = neighbors
        .map((nb) => {
          const pred = nb.predicate ? '<span class="neighbor-pred">' + escHtml(nb.predicate) + '</span>' : '';
          return '<button type="button" class="neighbor-chip" data-jump-node="' + escHtml(nb.id) + '"><span>' + escHtml(nb.label || nb.id) + '</span>' + pred + '</button>';
        })
        .join('');
    }

    const claims = Array.isArray(detail.claims) ? detail.claims : [];
    $('#inspector-claims-count').textContent = String(claims.length);
    const cContainer = $('#inspector-claims-list');
    if (claims.length === 0) {
      cContainer.innerHTML = '<p class="panel-subtitle">No live claims attached.</p>';
    } else {
      cContainer.innerHTML = claims
        .map((cl) => {
          const pred = cl.predicate ? '<span class="claim-predicate">' + escHtml(cl.predicate) + '</span>' : '<span>claim</span>';
          const metaParts = [];
          if (cl.confidence !== undefined && cl.confidence !== null) metaParts.push(formatConfidence(cl.confidence));
          if (cl.authority) metaParts.push(String(cl.authority));
          if (cl.created_at) metaParts.push(formatRelativeTime(cl.created_at));
          return (
            '<div class="claim-row">' +
            '<div class="claim-meta">' + pred + ' <span class="tabular">' + escHtml(metaParts.join(' / ')) + '</span></div>' +
            '<p class="claim-text">' + escHtml(stripEmDash(cl.text || cl.claim || '')) + '</p>' +
            '</div>'
          );
        })
        .join('');
    }
  }

  function closeNodeInspector() {
    state.selectedNodeId = null;
    state.selectedNodeDetail = null;
    const drawer = $('#node-inspector');
    if (drawer) {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    const shell = $('#app-shell');
    if (shell) shell.classList.remove('inspector-open');
    renderMindDirectory();
    if (graph) graph.setSelected(null);
  }

  function jumpToGraphNode(nodeId) {
    if (!nodeId) return;
    if (state.view !== 'graph') switchView('graph');
    else ensureGraphReady();

    const focusNow = () => {
      if (graph && graph.getNodeById(nodeId)) {
        graph.focusNode(nodeId, { select: true, zoom: 1.45 });
      }
      openNodeInspector(nodeId);
    };
    if (state.graphData.nodes.length === 0) {
      loadGraphData({ mountNow: true }).then(() => requestAnimationFrame(focusNow));
    } else {
      requestAnimationFrame(focusNow);
    }
  }

  // =========================================================================
  // VIEW 5: LIVE EVENT STREAM (ALL 18 SOURCE PILLS)
  // =========================================================================
  async function loadStream({ reset = false } = {}) {
    if (reset) {
      state.streamOffset = 0;
      state.streamEvents = [];
    }
    const listEl = $('#stream-list');
    if (reset && listEl) {
      listEl.innerHTML = '<div class="panel-body"><div class="skeleton-block"></div></div>';
    }

    const params = new URLSearchParams();
    if (state.streamConnector && state.streamConnector !== 'all') params.set('connector', state.streamConnector);
    if (state.streamQuery.trim()) params.set('q', state.streamQuery.trim());
    params.set('limit', String(state.streamLimit));
    params.set('offset', String(state.streamOffset));

    try {
      const res = await apiGet('/api/stream?' + params.toString());
      state.streamLoaded = true;
      const items = Array.isArray(res.items) ? res.items : (Array.isArray(res.events) ? res.events : []);
      const total = Number(res.total ?? res.total_count ?? items.length);

      state.streamEvents = reset ? items : state.streamEvents.concat(items);
      state.streamOffset = state.streamEvents.length;
      state.streamTotal = total;
      state.streamHasMore =
        res.has_more !== undefined
          ? Boolean(res.has_more)
          : res.hasMore !== undefined
          ? Boolean(res.hasMore)
          : state.streamEvents.length < total;

      if (Array.isArray(res.connectors) && res.connectors.length > 0) {
        state.streamConnectors = res.connectors;
      } else if (state.streamConnectors.length === 0 && state.overview && state.overview.vault && Array.isArray(state.overview.vault.connectors)) {
        state.streamConnectors = state.overview.vault.connectors;
      }

      const countEl = $('#stream-count');
      if (countEl) countEl.textContent = formatCompact(total) + ' events';
      if (state.streamConnector === 'all' && !state.streamQuery.trim() && total > 0) {
        syncUnifiedCounters();
      }

      renderStreamConnectors();
      renderStreamList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = '<div class="empty-state">Failed to load event stream: ' + escHtml(err.message) + '</div>';
      }
    }
  }

  function renderStreamConnectors() {
    const el = $('#stream-connectors');
    if (!el) return;
    const pills = [
      '<button type="button" class="filter-pill ' + (state.streamConnector === 'all' ? 'is-active' : '') + '" data-stream-conn="all">' +
      iconSvg('layers', { size: 12, className: 'k-pill-icon' }) +
      '<span>All</span></button>',
    ];
    for (const c of state.streamConnectors) {
      const id = c.id || c.connector_id || String(c);
      const label = c.label || shortConnectorName(id);
      const count = c.count !== undefined ? ' <span class="pill-count tabular">' + escHtml(formatCompact(c.count)) + '</span>' : '';
      const connIcon = iconSvg(streamConnectorIconName(id), { size: 12, className: 'k-pill-icon' });
      pills.push(
        '<button type="button" class="filter-pill ' + (state.streamConnector === id ? 'is-active' : '') + '" data-stream-conn="' + escHtml(id) + '">' +
        connIcon + '<span>' + escHtml(label) + '</span>' + count + '</button>'
      );
    }
    el.innerHTML = pills.join('');
  }

  const WISPR_APP_BUNDLE_MAP = {
    'com.t3tools.t3code': 'T3 Code',
    'com.operasoftware.opera': 'Opera',
    'com.apple.safari': 'Safari',
    'com.google.chrome': 'Chrome',
    'com.tinyspeck.slackmacgap': 'Slack',
    'com.todesktop.230313mzl4w4u92': 'Cursor',
    'md.obsidian': 'Obsidian',
    'com.apple.mobilesms': 'Messages',
    'com.apple.mail': 'Mail',
    'com.mitchellh.ghostty': 'Ghostty',
    'com.googlecode.iterm2': 'iTerm',
    'ru.keepcoder.telegram': 'Telegram',
  };

  function mapWisprBundleId(bundleId) {
    const raw = String(bundleId || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (WISPR_APP_BUNDLE_MAP[lower]) return WISPR_APP_BUNDLE_MAP[lower];
    const lastSeg = raw.split('.').filter(Boolean).pop() || raw;
    if (lastSeg === lastSeg.toLowerCase()) {
      return lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1);
    }
    return lastSeg;
  }

  function parseWisprPrefix(text) {
    const raw = String(text || '');
    const match = raw.match(/^\s*\[Wispr Flow(?:\s+[^\]|]+)?(?:\s*\|([^\]]+))?\]\s*/i);
    if (!match) {
      return { matched: false, appName: '', urlHost: '', clean: raw.trim() };
    }
    let appName = '';
    let urlHost = '';
    const metaStr = match[1] || '';
    if (metaStr) {
      for (const seg of metaStr.split('|')) {
        const idx = seg.indexOf(':');
        if (idx === -1) continue;
        const k = seg.slice(0, idx).trim().toLowerCase();
        const v = seg.slice(idx + 1).trim();
        if (k === 'app' && v) appName = mapWisprBundleId(v);
        else if (k === 'url' && v) urlHost = v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      }
    }
    return {
      matched: true,
      appName,
      urlHost,
      clean: raw.slice(match[0].length).trim(),
    };
  }

  function renderStreamList() {
    const el = $('#stream-list');
    const moreBtn = $('#btn-stream-load-more');
    if (!el) return;

    if (state.streamEvents.length === 0) {
      el.innerHTML = '<div class="empty-state">No events match the current stream filter.</div>';
      if (moreBtn) moreBtn.hidden = true;
      return;
    }

    el.innerHTML = state.streamEvents
      .map((ev, idx) => {
        const evId = String(ev.id || ev.event_id || 'ev-' + idx);
        const expanded = state.expandedEventIds.has(evId);
        const rawConn = String(ev.connector || ev.connector_id || ev.source || 'vault');
        const rawConnLower = rawConn.toLowerCase();
        const conn = ev.connector_label || shortConnectorName(rawConn);
        const kind = ev.kind || 'event';
        const kindLower = String(kind).toLowerCase();
        let title = stripEmDash(ev.title || ev.summary || ev.preview || ev.snippet || kind);
        let preview = stripEmDash(ev.preview || ev.snippet || ev.summary || '').replace(/\s+/g, ' ').trim();
        let bodyMd = ev.full_text || ev.markdown || ev.body || ev.content || preview || title;
        const when = formatRelativeTime(ev.observed_at || ev.occurred_at || ev.created_at || ev.timestamp);
        const docPath = ev.doc_path || ev.path || '';
        const isWispr =
          rawConnLower.includes('wispr') ||
          title.trim().startsWith('[Wispr Flow') ||
          preview.trim().startsWith('[Wispr Flow');

        let wisprAppPill = '';
        if (isWispr) {
          const parsedTitle = parseWisprPrefix(title);
          const parsedPreview = parseWisprPrefix(preview);
          const parsedBody = parseWisprPrefix(bodyMd);
          const appName = parsedTitle.appName || parsedPreview.appName || parsedBody.appName;
          const urlHost = parsedTitle.urlHost || parsedPreview.urlHost || parsedBody.urlHost;
          if (appName) {
            const pillTitle = urlHost ? ' title="' + escHtml(appName + ' (' + urlHost + ')') + '"' : '';
            wisprAppPill =
              '<span class="badge badge-neutral" style="flex-shrink:0;color:var(--ink-secondary);"' +
              pillTitle +
              '>' +
              escHtml(appName) +
              '</span>';
          }
          const cleanTitle = parsedTitle.clean;
          const cleanPreview = parsedPreview.clean;
          if (cleanTitle) {
            title = cleanTitle;
            preview = cleanPreview && cleanPreview !== cleanTitle && !cleanPreview.startsWith(cleanTitle)
              ? cleanPreview
              : '';
          } else if (cleanPreview) {
            title = cleanPreview;
            preview = '';
          } else {
            title = parsedBody.clean || kind;
            preview = '';
          }
          if (parsedBody.matched && parsedBody.clean) {
            bodyMd = parsedBody.clean;
          }
        }

        let badgeTone = 'badge-cobalt';
        if (isWispr) {
          if (kindLower === 'meeting_note' || kindLower === 'meeting_transcript') {
            badgeTone = 'badge-amber';
          } else if (kindLower === 'voice_dictation') {
            badgeTone = 'badge-cyan';
          } else {
            badgeTone = 'badge-teal';
          }
        }
        const connIcon = iconSvg(streamConnectorIconName(rawConn), { size: 11, className: 'k-pill-icon' });
        const kindTone = isWispr && (kindLower === 'meeting_note' || kindLower === 'meeting_transcript')
          ? ' badge-amber'
          : isWispr && kindLower === 'voice_dictation'
          ? ' badge-cyan'
          : '';

        return (
          '<article class="stream-row' + (expanded ? ' is-expanded' : '') + '" role="listitem" data-stream-id="' + escHtml(evId) + '">' +
          '<button type="button" class="stream-row-head" data-toggle-stream="' + escHtml(evId) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
          '<svg class="stream-row-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<span class="badge ' + badgeTone + '" style="display:inline-flex;align-items:center;gap:4px;">' + connIcon + '<span>' + escHtml(conn) + '</span></span>' +
          wisprAppPill +
          '<span class="stream-row-title">' + escHtml(title.slice(0, 120)) + '</span>' +
          (preview && preview !== title ? '<span class="stream-row-preview">' + escHtml(preview.slice(0, 110)) + '</span>' : '') +
          '<span class="stream-row-time tabular">' + escHtml(when) + '</span>' +
          '</button>' +
          '<div class="stream-row-detail">' +
          '<div class="stream-row-meta"><span class="badge' + kindTone + '">' + escHtml(kind) + '</span>' +
          (ev.source_record_id ? '<span class="badge tabular">' + escHtml(ev.source_record_id) + '</span>' : '') +
          '</div>' +
          '<div class="markdown-prose">' + (expanded ? renderMarkdownHtml(bodyMd) : '') + '</div>' +
          '<div class="stream-row-actions">' +
          '<button type="button" class="btn-primary btn-sm" data-stream-ask="' + escHtml(evId) + '">Ask Mind</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-stream-anchor="' + escHtml(evId) + '">Anchor</button>' +
          (docPath ? '<button type="button" class="btn-ghost btn-sm" data-open-doc="' + escHtml(docPath) + '">Open Doc</button>' : '') +
          '</div>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');

    if (moreBtn) moreBtn.hidden = !state.streamHasMore;
  }

  // =========================================================================
  // VIEW 6: WORLD ATLAS (ALL 6 HYDRATED PANELS)
  // =========================================================================
  async function loadAtlas() {
    const grid = $('#atlas-panels-grid');
    if (grid) grid.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block"></div>';
    try {
      const data = await apiGet('/api/atlas');
      state.atlasData = data;
      renderAtlas();
    } catch (err) {
      if (grid) grid.innerHTML = '<div class="empty-state">Failed to load World Atlas: ' + escHtml(err.message) + '</div>';
    }
  }

  function findAtlasPanel(panels, key) {
    if (!panels) return null;
    const target = String(key || '').toLowerCase();
    if (Array.isArray(panels)) {
      return (
        panels.find((p) => {
          if (!p || typeof p !== 'object') return false;
          const pKey = String(p.panel || p.key || p.id || '').toLowerCase();
          if (pKey === target) return true;
          const pName = String(p.name || p.title || '').toLowerCase();
          return pName === target || pName.includes(target);
        }) || null
      );
    }
    if (typeof panels === 'object') return panels[key] || panels[target] || null;
    return null;
  }

  function normalizePanelItems(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'object') {
      if (Array.isArray(val.entries)) return val.entries;
      if (Array.isArray(val.items)) return val.items;
      if (Array.isArray(val.rows)) return val.rows;
      if (val.panel || val.status || val.source) return [];
      return Object.entries(val).map(([k, v]) => ({
        title: k,
        text: typeof v === 'string' ? v : JSON.stringify(v),
      }));
    }
    if (typeof val === 'string') {
      return val.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => ({ title: line }));
    }
    return [];
  }

  function renderAtlas() {
    const data = state.atlasData;
    if (!data) return;

    const panels = data.panels || [];
    const baseDefs = [
      { key: 'resume', label: 'Resume Now', glyph: 'glyph-ring' },
      { key: 'changed', label: 'What Changed', glyph: 'glyph-dot' },
      { key: 'stale', label: 'Stale / Attention', glyph: 'glyph-dot' },
      { key: 'commitments', label: 'Commitments', glyph: 'glyph-diamond' },
      { key: 'questions', label: 'Open Questions', glyph: 'glyph-dot' },
      { key: 'people', label: 'People & Contacts', glyph: 'glyph-square' },
    ];

    const panelDefs = baseDefs.filter((def) => def.key !== 'changed' || Boolean(findAtlasPanel(panels, 'changed')));
    const changedTab = $('[data-atlas-tab="changed"]');
    if (changedTab) changedTab.hidden = !Boolean(findAtlasPanel(panels, 'changed'));

    const totalItems = panelDefs.reduce((acc, def) => acc + normalizePanelItems(findAtlasPanel(panels, def.key)).length, 0);
    const livePanelsCount = panelDefs.filter((def) => {
      const raw = findAtlasPanel(panels, def.key);
      return raw && (raw.hydrated || String(raw.source || '').toLowerCase().includes('live') || normalizePanelItems(raw).length > 0);
    }).length;
    const highlights = Array.isArray(data.consolidated_highlights) ? data.consolidated_highlights : [];

    setNavCount('nav-count-atlas', String(panelDefs.length));
    const metaEl = $('#atlas-status-meta');
    if (metaEl) {
      metaEl.textContent =
        totalItems > 0
          ? livePanelsCount + ' hydrated panels / ' + totalItems + ' active items / ' + highlights.length + ' consolidated world objects.'
          : 'Live operational panels and consolidated world objects.';
    }

    const filteredDefs = state.atlasTab === 'all' ? panelDefs : panelDefs.filter((p) => p.key === state.atlasTab);
    const grid = $('#atlas-panels-grid');
    grid.innerHTML = filteredDefs
      .map((def) => {
        const rawPanel = findAtlasPanel(panels, def.key);
        const items = normalizePanelItems(rawPanel);
        const panelTitle = rawPanel && typeof rawPanel === 'object' && rawPanel.title ? stripEmDash(rawPanel.title) : def.label;
        const rawSource = rawPanel && typeof rawPanel === 'object' ? String(rawPanel.source || '') : '';
        const isLiveSource = rawSource.toLowerCase().includes('live') || (!rawSource && Boolean(rawPanel && rawPanel.hydrated));
        const sourcePill = isLiveSource
          ? '<span class="badge badge-teal" title="' + escHtml(rawSource || 'vault-live') + '">live</span>'
          : '<span class="badge badge-neutral" title="' + escHtml(rawSource || 'atlas') + '">atlas</span>';

        const bodyHtml =
          items.length === 0
            ? '<p class="empty-state">Quiet: no active items in ' + escHtml(panelTitle.toLowerCase()) + '.</p>'
            : items
                .slice(0, 14)
                .map((item) => {
                  if (typeof item === 'string') {
                    const cleanLine = stripEmDash(item);
                    return (
                      '<button type="button" class="atlas-row is-clickable" data-atlas-ask="' +
                      escHtml('Explain this ' + panelTitle + ' item from my Kizuki vault: ' + cleanLine) +
                      '"><span class="atlas-row-title">' + escHtml(cleanLine) + '</span></button>'
                    );
                  }
                  const title = stripEmDash(item.label || item.title || item.name || item.subject || item.text || item.summary || 'Item');
                  const rawDesc = stripEmDash(item.summary || item.detail || item.reason || (item.text && item.text !== title ? item.text : ''));
                  const desc = rawDesc && rawDesc.trim() !== title.trim() ? rawDesc : '';
                  const meta = item.updated_at ? formatRelativeTime(item.updated_at) : (item.age || item.status || item.kind || '');
                  const nodeId = item.node_id || item.entity_id || item.id || null;
                  const docPath = item.doc_path || item.path || null;
                  const actionAttr = docPath
                    ? 'data-open-doc="' + escHtml(docPath) + '"'
                    : nodeId
                    ? 'data-jump-node="' + escHtml(nodeId) + '"'
                    : 'data-atlas-ask="' + escHtml('Synthesize context and next actions for "' + title + '"' + (desc ? ' (' + desc.slice(0, 140) + ')' : '')) + '"';
                  return (
                    '<button type="button" class="atlas-row is-clickable" ' + actionAttr + '>' +
                    '<div class="atlas-row-top"><span class="atlas-row-title">' + escHtml(title) + '</span>' +
                    (meta ? '<span class="atlas-row-meta">' + escHtml(meta) + '</span>' : '') +
                    '</div>' +
                    (desc ? '<p class="atlas-row-desc">' + escHtml(desc) + '</p>' : '') +
                    '</button>'
                  );
                })
                .join('');

        const panelIcon = iconSvg(atlasPanelIconName(def.key), { size: 13 }) || '<span class="glyph ' + def.glyph + '" aria-hidden="true"></span>';
        return (
          '<section class="atlas-panel">' +
          '<header class="atlas-panel-head">' +
          '<h2 class="atlas-panel-title">' + panelIcon + '<span>' + escHtml(panelTitle) + '</span></h2>' +
          '<div class="atlas-panel-head-right">' + sourcePill + '<span class="section-count tabular">' + items.length + '</span></div>' +
          '</header>' +
          '<div class="atlas-panel-body">' + bodyHtml + '</div>' +
          '</section>'
        );
      })
      .join('');

    $('#atlas-highlights-count').textContent = String(highlights.length);
    const hlGrid = $('#atlas-highlights-grid');
    if (highlights.length === 0) {
      hlGrid.innerHTML = '<div class="empty-state">No consolidated highlights returned.</div>';
    } else {
      hlGrid.innerHTML = highlights
        .map((h) => {
          const id = h.id || h.node_id || '';
          const docPath = h.doc_path || h.path || '';
          const label = stripEmDash(h.label || h.title || h.name || id || 'World Object');
          const summary = stripEmDash(h.summary || h.text || '');
          const claims = h.claim_count !== undefined ? h.claim_count + ' claims' : '';
          const updated = formatRelativeTime(h.updated_at || h.completed_at);
          const actionAttr = docPath ? 'data-open-doc="' + escHtml(docPath) + '"' : 'data-jump-node="' + escHtml(id) + '"';
          return (
            '<button type="button" class="highlight-item" ' + actionAttr + '>' +
            '<div class="highlight-top"><span class="highlight-title">' + escHtml(label) + '</span>' +
            '<span class="badge badge-amber">' + escHtml(h.kind || 'world') + '</span></div>' +
            '<p class="highlight-summary">' + escHtml(summary || 'Open in Mind Graph to inspect linked claims and neighbors.') + '</p>' +
            '<div class="highlight-foot"><span>' + escHtml(claims) + '</span><span>' + escHtml(updated) + '</span></div>' +
            '</button>'
          );
        })
        .join('');
    }
  }

  // =========================================================================
  // VIEW 7: MEMT PROCEDURAL LIBRARY
  // =========================================================================
  async function loadMemt() {
    const listEl = $('#memt-list');
    if (listEl) listEl.innerHTML = '<div class="skeleton-block"></div>';
    try {
      const data = await apiGet('/api/memt');
      state.memtData = data;
      const exps = Array.isArray(data.experiences) ? data.experiences : [];
      const st = data.status || {};
      const verifiedCount = st.verified !== undefined ? st.verified : exps.filter((e) => e.verified !== false).length;
      setNavCount('nav-count-memt', String(verifiedCount));
      $('#memt-status-meta').textContent = verifiedCount + ' verified procedural recipes indexed across active domains.';
      renderMemtDomainPills(exps);
      renderMemtList();
    } catch (err) {
      if (listEl) listEl.innerHTML = '<div class="empty-state">Failed to load MemT library: ' + escHtml(err.message) + '</div>';
    }
  }

  function renderMemtDomainPills(exps) {
    const counts = new Map();
    for (const exp of exps) {
      const d = String(exp.domain || 'general').toLowerCase();
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    const domains = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const container = $('#memt-domain-pills');
    const html = [
      '<button type="button" class="filter-pill ' + (state.memtDomain === 'all' ? 'is-active' : '') + '" data-memt-domain="all">All <span class="pill-count tabular">' + exps.length + '</span></button>',
    ];
    for (const [domain, count] of domains) {
      html.push(
        '<button type="button" class="filter-pill pill-teal ' + (state.memtDomain === domain ? 'is-active' : '') + '" data-memt-domain="' + escHtml(domain) + '">' +
        escHtml(domain) + ' <span class="pill-count tabular">' + count + '</span></button>'
      );
    }
    container.innerHTML = html.join('');
  }

  function renderMemtList() {
    const exps = state.memtData && Array.isArray(state.memtData.experiences) ? state.memtData.experiences : [];
    const q = state.memtSearch.trim().toLowerCase();

    const filtered = exps.filter((exp) => {
      const dom = String(exp.domain || 'general').toLowerCase();
      if (state.memtDomain !== 'all' && dom !== state.memtDomain) return false;
      if (!q) return true;
      const hay = [exp.domain, exp.condition, exp.recommendation, exp.verification, exp.title, exp.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    const listEl = $('#memt-list');
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No MemT recipes match the current filter.</div>';
      return;
    }

    listEl.innerHTML = filtered
      .map((exp, idx) => {
        const domain = exp.domain || 'general';
        const verified = exp.verified !== false && exp.status !== 'unverified';
        const condition = stripEmDash(exp.condition || exp.title || exp.trigger || 'Condition');
        const rec = stripEmDash(exp.recommendation || exp.action || exp.text || '');
        const verif = stripEmDash(exp.verification || exp.proof || '');
        const updated = formatRelativeTime(exp.updated_at || exp.created_at);
        const pct = confidencePercent(exp.confidence);
        const uses = exp.use_count ?? exp.uses;
        const reflexPrompt = 'Run a reflex check against MemT rule (' + domain + '): ' + condition + ' -> ' + rec;

        return (
          '<article class="memt-card" data-memt-idx="' + idx + '">' +
          '<div class="memt-card-head">' +
          '<div class="memt-badges"><span class="badge badge-teal">' + escHtml(domain) + '</span>' +
          '<span class="badge ' + (verified ? 'badge-amber' : '') + '">' + (verified ? 'Verified' : escHtml(exp.status || 'Draft')) + '</span></div>' +
          '<div class="conf-bar" title="Confidence ' + pct + '%"><span class="conf-bar-track"><span class="conf-bar-fill" style="width:' + pct + '%"></span></span><span>' + pct + '%</span></div>' +
          '</div>' +
          '<div class="memt-condition">' + escHtml(condition) + '</div>' +
          '<p class="memt-recommendation">' + escHtml(rec) + '</p>' +
          (verif ? '<div class="memt-verification"><strong>Proof:</strong> ' + escHtml(verif) + '</div>' : '') +
          '<div class="highlight-foot">' +
          '<span>' + escHtml([uses !== undefined ? uses + ' uses' : '', updated].filter(Boolean).join(' / ') || 'Verified') + '</span>' +
          '<div class="memt-card-actions">' +
          (verif ? '<button type="button" class="btn-ghost btn-sm" data-copy-text="' + escHtml(verif) + '">Copy Proof</button>' : '') +
          '<button type="button" class="btn-secondary btn-sm" data-reflex-prompt="' + escHtml(reflexPrompt) + '">Reflex Test</button>' +
          '</div></div></article>'
        );
      })
      .join('');
  }

  async function handleAddRecipeFormSubmit(e) {
    e.preventDefault();
    const domain = $('#recipe-domain').value.trim();
    const condition = $('#recipe-condition').value.trim();
    const recommendation = $('#recipe-recommendation').value.trim();
    const verification = $('#recipe-verification').value.trim();
    const feedback = $('#recipe-form-feedback');
    const btn = $('#recipe-submit');

    feedback.classList.remove('is-error');
    if (!domain || !condition || !recommendation) {
      feedback.classList.add('is-error');
      feedback.textContent = 'Domain, trigger condition, and recommendation are required.';
      return;
    }

    btn.disabled = true;
    feedback.textContent = 'Saving recipe to Kizuki MemT...';

    try {
      const res = await apiPost('/api/interact', {
        mode: 'memt',
        input: condition + ' -> ' + recommendation,
        domain,
        condition,
        recommendation,
        verification,
      });

      if (!res.ok) {
        feedback.classList.add('is-error');
        feedback.textContent = res.error || 'Failed to save MemT recipe.';
      } else {
        feedback.textContent = 'Saved verified recipe to MemT.';
        showToast('Saved MemT recipe in ' + domain, 'success');
        $('#memt-add-form').reset();
        await Promise.all([loadMemt(), loadPulseTelemetry()]);
        setTimeout(() => {
          $('#memt-add-form-wrap').hidden = true;
          feedback.textContent = '';
        }, 900);
      }
    } catch (err) {
      feedback.classList.add('is-error');
      feedback.textContent = err.message || 'Network error while saving recipe.';
    } finally {
      btn.disabled = false;
    }
  }

  // =========================================================================
  // FULL MULTI-TURN MIND CHAT MODAL (CMD+J - ZERO FLOATING OVERLAP)
  // =========================================================================
  function loadPersistedChat() {
    try {
      const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) state.chatMessages = parsed.slice(-MAX_CHAT_TURNS);
    } catch (_) {
      // ignore
    }
    syncChatUi();
  }

  function persistChat() {
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.chatMessages.slice(-MAX_CHAT_TURNS)));
    } catch (_) {
      // ignore
    }
  }

  function openChatModal({ mode, context, prompt, autoSubmit = false } = {}) {
    if (mode) setChatMode(mode);
    if (context !== undefined) setChatContext(context);
    state.chatOpen = true;
    const backdrop = $('#chat-modal-backdrop');
    if (backdrop) backdrop.hidden = false;
    syncChatUi();

    const input = $('#chat-input');
    if (prompt !== undefined && input) {
      input.value = prompt;
      autoResizeTextarea(input);
    }
    if (autoSubmit && prompt) {
      $('#chat-form').requestSubmit();
    } else if (input) {
      input.focus();
    }
  }

  function closeChatModal() {
    state.chatOpen = false;
    const backdrop = $('#chat-modal-backdrop');
    if (backdrop) backdrop.hidden = true;
    if (graph) graph.highlightNodes([]);
  }

  function setChatMode(mode) {
    if (!CHAT_MODE_CONFIG[mode]) return;
    state.chatMode = mode;
    const cfg = CHAT_MODE_CONFIG[mode];
    $$('#chat-form .mode-btn[data-mode]').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const memtFields = $('#chat-memt-fields');
    if (memtFields) memtFields.hidden = mode !== 'memt';
    const input = $('#chat-input');
    if (input) input.placeholder = cfg.placeholder;
    const subLbl = $('#chat-submit-label');
    if (subLbl) subLbl.textContent = cfg.submit;
  }

  function setChatContext(ctx) {
    state.chatContext = ctx || null;
    const chip = $('#chat-context-chip');
    const prefix = $('#chat-context-prefix');
    const label = $('#chat-context-label');
    if (!chip) return;
    if (!state.chatContext) {
      chip.hidden = true;
      if (label) label.textContent = '';
      return;
    }
    chip.hidden = false;
    if (state.chatContext.type === 'doc') {
      if (prefix) prefix.textContent = 'Doc';
      if (label) label.textContent = state.chatContext.title || state.chatContext.path;
    } else if (state.chatContext.type === 'person') {
      if (prefix) prefix.textContent = 'Person';
      if (label) label.textContent = state.chatContext.label || state.chatContext.key;
    } else if (state.chatContext.type === 'node') {
      if (prefix) prefix.textContent = 'Node';
      if (label) label.textContent = state.chatContext.label || state.chatContext.id;
    } else if (state.chatContext.type === 'board') {
      if (prefix) prefix.textContent = 'Board';
      const chPart = state.chatContext.channel ? '#' + String(state.chatContext.channel).replace(/^#/, '') : '';
      const threadPart = state.chatContext.threadId ? '#' + String(state.chatContext.threadId).replace(/^#/, '') : '';
      if (label) label.textContent = state.chatContext.label || [chPart, threadPart].filter(Boolean).join(' / ') || 'Agent Board';
    } else {
      if (prefix) prefix.textContent = state.chatContext.type || 'Context';
      if (label) label.textContent = state.chatContext.label || '';
    }
  }

  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  }

  function syncChatUi() {
    const countBadge = $('#chat-history-count');
    const starters = $('#chat-starters');
    const sidebarBadge = $('#sidebar-chat-badge');
    const engineBadge = $('#response-engine-badge');
    const latBadge = $('#response-latency');
    const turnCount = state.chatMessages.length;
    if (countBadge) countBadge.textContent = turnCount + (turnCount === 1 ? ' turn' : ' turns');
    if (starters) starters.hidden = turnCount > 0;
    if (sidebarBadge) sidebarBadge.textContent = turnCount > 0 ? String(turnCount) : '\u2318J';

    const lastAssistant = [...state.chatMessages].reverse().find((m) => m.role === 'assistant' && !m.pending);
    if (lastAssistant) {
      if (engineBadge && lastAssistant.engine) engineBadge.textContent = lastAssistant.engine;
      if (latBadge) latBadge.textContent = lastAssistant.latencyMs !== undefined ? formatLatency(lastAssistant.latencyMs) : '';
    } else if (latBadge && turnCount === 0) {
      latBadge.textContent = '';
    }

    renderChatMessages();
  }

  function renderChatMessages() {
    const container = $('#chat-messages');
    if (!container) return;
    if (state.chatMessages.length === 0) {
      container.innerHTML =
        '<div class="empty-state">Ask across your Calendar, WhatsApp, iMessage, Gmail, Telegram, Obsidian, Apple Notes, and Kizuki Mind Graph.</div>';
      return;
    }

    container.innerHTML = state.chatMessages
      .map((msg) => {
        if (msg.role === 'user') {
          const cfg = CHAT_MODE_CONFIG[msg.mode] || CHAT_MODE_CONFIG.ask;
          const ctxBadge = msg.context
            ? '<span class="badge">' + escHtml((msg.context.type || 'Ctx') + ': ' + (msg.context.title || msg.context.label || msg.context.path || '')) + '</span>'
            : '';
          return (
            '<div class="chat-msg is-user">' +
            '<div class="chat-msg-meta">' +
            '<span class="badge ' + cfg.badgeClass + '">' + escHtml(cfg.label) + '</span>' +
            ctxBadge +
            (msg.timestamp ? '<span>' + escHtml(formatRelativeTime(msg.timestamp)) + '</span>' : '') +
            '</div>' +
            '<div>' + escHtml(msg.text) + '</div>' +
            '</div>'
          );
        }

        const cits = Array.isArray(msg.citations) ? msg.citations.filter((c) => c && (c.id || c.path)) : [];
        const citHtml =
          cits.length > 0
            ? '<div class="chat-citations"><span class="citations-label">Cited:</span><div class="citation-chips">' +
              cits
                .map((c) => {
                  if (c.kind === 'board' || String(c.id || '').startsWith('board:')) {
                    const threadId = String(c.id || '').replace(/^board:/, '').trim();
                    let boardChannel = String(c.channel || '').replace(/^#+/, '').trim();
                    if (!boardChannel && c.label) {
                      const chMatch = /\(([^)\s]+)\)/.exec(String(c.label));
                      if (chMatch && chMatch[1]) {
                        boardChannel = chMatch[1].replace(/^#+/, '').trim();
                      }
                    }
                    const fullLabel = stripEmDash(c.label || c.title || (threadId ? '#' + threadId : c.id));
                    return (
                      '<button type="button" class="citation-chip chat-cite-chip" title="' +
                      escHtml(fullLabel) +
                      '" data-open-board-thread="' +
                      escHtml(threadId) +
                      '"' +
                      (boardChannel ? ' data-board-channel="' + escHtml(boardChannel) + '"' : '') +
                      '>' +
                      escHtml(fullLabel) +
                      '</button>'
                    );
                  }
                  if (c.path && !c.id) {
                    const fullTitle = stripEmDash(c.title || titleFromPath(c.path));
                    return (
                      '<button type="button" class="citation-chip chat-cite-chip" title="' +
                      escHtml(fullTitle) +
                      '" data-open-doc="' +
                      escHtml(c.path) +
                      '">' +
                      escHtml(fullTitle) +
                      '</button>'
                    );
                  }
                  const fullLabel = stripEmDash(c.label || c.title || c.id);
                  return (
                    '<button type="button" class="citation-chip chat-cite-chip" title="' +
                    escHtml(fullLabel) +
                    '" data-jump-node="' +
                    escHtml(c.id) +
                    '">' +
                    escHtml(fullLabel) +
                    '</button>'
                  );
                })
                .join('') +
              '</div></div>'
            : '';

        const receiptHtml = msg.receipt
          ? '<div class="response-receipt">' + escHtml(typeof msg.receipt === 'string' ? msg.receipt : JSON.stringify(msg.receipt)) + '</div>'
          : '';

        return (
          '<div class="chat-msg is-assistant' + (msg.isError ? ' is-error' : '') + '">' +
          '<div class="chat-msg-head">' +
          '<div class="chat-msg-meta">' +
          '<span class="badge ' + (msg.isError ? 'badge-rose' : 'badge-neutral') + '">' + escHtml(msg.engine || 'Vault + G4') + '</span>' +
          (msg.latencyMs !== undefined ? '<span class="tabular">' + escHtml(formatLatency(msg.latencyMs)) + '</span>' : '') +
          '</div>' +
          (!msg.pending
            ? '<div class="composer-actions">' +
              '<button type="button" class="btn-ghost btn-xs" data-send-ask-to-board="' + escHtml(msg.id || '') + '">Send to Board</button>' +
              '<button type="button" class="btn-ghost btn-xs" data-copy-text="' + escHtml(msg.text || '') + '">Copy</button>' +
              '</div>'
            : '') +
          '</div>' +
          '<div class="markdown-prose">' + renderMarkdownHtml(msg.text || '') + '</div>' +
          receiptHtml +
          citHtml +
          '</div>'
        );
      })
      .join('');

    container.scrollTop = container.scrollHeight;
  }

  async function saveChatToNote() {
    if (state.chatMessages.length === 0) {
      showToast('No Mind Chat messages to save yet.');
      return;
    }
    const now = new Date();
    const path = 'owner-notes/chat-' + formatTimestampSlug(now) + '.md';
    const lines = [
      '---',
      'title: Mind Chat ' + now.toISOString().slice(0, 16).replace('T', ' '),
      'created_at: ' + now.toISOString(),
      'source: kizuki-mind-os',
      'turns: ' + state.chatMessages.length,
      '---',
      '',
      '# Mind Chat Transcript',
      '',
    ];

    for (const msg of state.chatMessages) {
      if (msg.pending) continue;
      if (msg.role === 'user') {
        const modeLabel = (CHAT_MODE_CONFIG[msg.mode] && CHAT_MODE_CONFIG[msg.mode].label) || 'Ask Mind';
        lines.push('## User (' + modeLabel + ')');
        lines.push(msg.text || '');
        lines.push('');
      } else {
        lines.push('### Kizuki Mind (' + (msg.engine || 'Vault + G4') + ')');
        lines.push('');
        lines.push(msg.text || '');
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    try {
      const res = await apiPost('/api/docs/save', { path, content: lines.join('\n') });
      if (res.ok === false) {
        showToast(res.error || 'Could not save chat note.', 'error');
        return;
      }
      showToast('Saved chat transcript to ' + (res.path || path), 'success');
      if (state.vaultLoaded) loadVaultDocs({ reset: true });
    } catch (err) {
      showToast('Failed to save chat note: ' + err.message, 'error');
    }
  }

  async function handleChatSubmit(e) {
    e.preventDefault();
    if (state.chatBusy) return;

    const inputEl = $('#chat-input');
    const text = inputEl.value.trim();
    const mode = state.chatMode;
    if (!text) {
      inputEl.focus();
      return;
    }

    const ctxSnapshot = state.chatContext ? { ...state.chatContext } : null;
    const payload = { mode, input: text };
    if (ctxSnapshot) {
      if (ctxSnapshot.type === 'node') payload.nodeId = ctxSnapshot.id;
      else if (ctxSnapshot.type === 'doc') payload.contextDocPath = ctxSnapshot.path;
      else if (ctxSnapshot.type === 'person') payload.personKey = ctxSnapshot.key;
      else if (ctxSnapshot.type === 'board') {
        if (ctxSnapshot.channel) payload.boardChannel = ctxSnapshot.channel;
        if (ctxSnapshot.threadId) payload.boardThreadId = ctxSnapshot.threadId;
      }
    }

    const history = state.chatMessages
      .filter((m) => !m.pending && !m.isError)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.text }));
    if (history.length > 0) payload.history = history;

    if (mode === 'memt') {
      const domain = $('#chat-memt-domain').value.trim();
      const condition = $('#chat-memt-condition').value.trim();
      const verification = $('#chat-memt-verification').value.trim();
      if (domain) payload.domain = domain;
      if (condition) payload.condition = condition;
      payload.recommendation = text;
      if (verification) payload.verification = verification;
    }

    const userMsg = {
      id: 'u-' + Date.now(),
      role: 'user',
      mode,
      text,
      context: ctxSnapshot,
      timestamp: new Date().toISOString(),
    };
    const pendingMsg = {
      id: 'a-' + Date.now(),
      role: 'assistant',
      mode,
      engine: mode === 'ask' ? 'Querying Vault + G4...' : 'Executing...',
      text: 'Working against live Kizuki vault...',
      pending: true,
    };

    state.chatMessages.push(userMsg, pendingMsg);
    if (state.chatMessages.length > MAX_CHAT_TURNS) {
      state.chatMessages = state.chatMessages.slice(-MAX_CHAT_TURNS);
    }

    state.chatBusy = true;
    const submitBtn = $('#chat-submit');
    if (submitBtn) submitBtn.disabled = true;
    inputEl.value = '';
    autoResizeTextarea(inputEl);
    syncChatUi();

    const t0 = performance.now();
    try {
      const res = await apiPost('/api/interact', payload);
      const elapsed = res.latency_ms ?? Math.round(performance.now() - t0);
      const idx = state.chatMessages.findIndex((m) => m.id === pendingMsg.id);

      if (!res.ok) {
        const errTurn = {
          id: pendingMsg.id,
          role: 'assistant',
          mode,
          engine: 'Error',
          latencyMs: elapsed,
          text: res.error || 'Request failed without an error message.',
          isError: true,
          timestamp: new Date().toISOString(),
        };
        if (idx !== -1) state.chatMessages[idx] = errTurn;
      } else {
        const answerText = stripEmDash(
          res.answer_md ||
            res.answer ||
            (typeof res.result === 'string'
              ? res.result
              : res.result
              ? '```json\n' + JSON.stringify(res.result, null, 2) + '\n```'
              : 'Completed.')
        );
        const engineLabel =
          res.engine ||
          (res.synthesized
            ? 'Local LLM + Vault'
            : mode === 'tell'
            ? 'Vault Anchored'
            : mode === 'memt'
            ? 'MemT Stored'
            : mode === 'reflex'
            ? 'Reflex Check'
            : 'Vault Grounded');

        const cits = Array.isArray(res.citations) ? res.citations : [];
        const finalTurn = {
          id: pendingMsg.id,
          role: 'assistant',
          mode,
          engine: engineLabel,
          latencyMs: elapsed,
          text: answerText,
          receipt: res.receipt || null,
          citations: cits,
          isError: false,
          timestamp: new Date().toISOString(),
        };
        if (idx !== -1) state.chatMessages[idx] = finalTurn;

        const engineBadge = $('#response-engine-badge');
        const latBadge = $('#response-latency');
        if (engineBadge) engineBadge.textContent = engineLabel;
        if (latBadge) latBadge.textContent = formatLatency(elapsed);

        if (mode === 'memt') {
          $('#chat-memt-domain').value = '';
          $('#chat-memt-condition').value = '';
          $('#chat-memt-verification').value = '';
          showToast('Saved procedural recipe to MemT', 'success');
          loadMemt();
          loadPulseTelemetry();
        } else if (mode === 'tell') {
          showToast('Anchored update into Kizuki vault', 'success');
          loadPulseTelemetry();
          loadToday({ silent: true });
          if (state.selectedNodeId) openNodeInspector(state.selectedNodeId);
        }
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      const idx = state.chatMessages.findIndex((m) => m.id === pendingMsg.id);
      if (idx !== -1) {
        state.chatMessages[idx] = {
          id: pendingMsg.id,
          role: 'assistant',
          mode,
          engine: 'Network Error',
          latencyMs: elapsed,
          text: err.message || 'Could not reach /api/interact.',
          isError: true,
          timestamp: new Date().toISOString(),
        };
      }
    } finally {
      state.chatBusy = false;
      if (submitBtn) submitBtn.disabled = false;
      persistChat();
      syncChatUi();
    }
  }

  // =========================================================================
  // OMNI-SEARCH COMMAND PALETTE (CMD+K / CTRL+K)
  // =========================================================================
  function openCmdk() {
    state.cmdkOpen = true;
    const backdrop = $('#cmdk-backdrop');
    backdrop.hidden = false;
    const input = $('#cmdk-input');
    input.value = '';
    $('#cmdk-meta').textContent = 'ESC';
    renderCmdkBaseResults('');
    input.focus();
  }

  function closeCmdk() {
    state.cmdkOpen = false;
    $('#cmdk-backdrop').hidden = true;
    if (state.cmdkSearchTimer) {
      clearTimeout(state.cmdkSearchTimer);
      state.cmdkSearchTimer = null;
    }
  }

  function renderCmdkList(groups, opts = {}) {
    const container = $('#cmdk-results');
    const flat = [];
    const html = [];

    for (const group of groups) {
      if (!group.items || group.items.length === 0) continue;
      html.push('<div class="cmdk-group-label">' + escHtml(group.label) + '</div>');
      for (const item of group.items) {
        const idx = flat.length;
        flat.push(item);
        html.push(
          '<button type="button" class="cmdk-item ' + (idx === 0 ? 'is-active is-selected' : '') + '" role="option" data-cmdk-idx="' + idx + '">' +
          '<div class="cmdk-item-main">' +
          '<span class="cmdk-item-title">' + escHtml(stripEmDash(item.title)) + '</span>' +
          (item.sub ? '<span class="cmdk-item-sub">' + escHtml(stripEmDash(item.sub)) + '</span>' : '') +
          '</div>' +
          (item.badge ? '<span class="badge ' + (item.badgeClass || '') + '">' + escHtml(item.badge) + '</span>' : '') +
          '</button>'
        );
      }
    }

    state.cmdkItems = flat;
    state.cmdkIndex = 0;

    if (flat.length === 0) {
      container.innerHTML = opts.searching
        ? '<div class="empty-state">Searching vault, people &amp; codex...</div>'
        : '<div class="empty-state">No matches found across calendar, inbox, people, codex, or vault.</div>';
    } else {
      container.innerHTML = html.join('');
    }
  }

  function renderCmdkBaseResults(query, opts = {}) {
    const q = query.trim().toLowerCase();

    const commands = [
      { title: 'Today Workbench', sub: 'Morning brief, schedule, actions, and human priority inbox', badge: 'View', action: () => switchView('today') },
      { title: 'People Cross-Channel Dossiers', sub: 'Interleaved WhatsApp, Telegram, iMessage, Gmail timelines', badge: 'View', action: () => switchView('people') },
      { title: 'Life Replay Time Machine', sub: 'Private offline life map, GPS trips, contribution calendar, and AI day stories', badge: 'View', action: () => switchView('replay') },
      { title: 'Mind Codex & Action Plane', sub: 'Philosophies, Interests, Hobbies, Ideas, Actions', badge: 'View', action: () => switchView('codex') },
      { title: 'Taste Studio & Fine-Tuning', sub: 'Rapid 1-4 multiple-choice taste calibration & Taste Vault', badge: 'View', action: () => switchView('taste') },
      { title: 'Agent Board Multiplayer', sub: 'Live @vercel/board rooms, Claude/Codex/Orchestrator threads, blockers & fleet', badge: 'View', action: () => switchView('board') },
      { title: 'Agent Board: Mission Signal', sub: 'Jump straight into Agent Board active mission signal and rooms', badge: 'Board', badgeClass: 'badge-cyan', action: () => switchView('board') },
      { title: 'Agent Board: Open Blockers', sub: 'Review escalated blockers and owner decisions on canvas', badge: 'Blockers', badgeClass: 'badge-amber', action: () => switchView('board', { mode: 'blockers', stage: 'canvas' }) },
      { title: 'Agent Board: Spatial Mesh Live', sub: 'Open live spatial mesh canvas and agent telemetry stage', badge: 'Live', badgeClass: 'badge-cyan', action: () => switchView('board', { stage: 'live' }) },
      { title: 'Vault Explorer' + (state.vaultTotal > 0 ? ' (' + formatCompact(state.vaultTotal) + ' Docs)' : ''), sub: 'Kizuki, Obsidian, Apple Notes, and Wispr Meetings markdown reader & editor', badge: 'View', action: () => switchView('vault') },
      { title: 'Mind Graph Topology', sub: 'Interactive force-directed world graph & inspector', badge: 'View', action: () => switchView('graph') },
      { title: 'Live Event Stream', sub: 'Chronological events across connected pipelines', badge: 'View', action: () => switchView('stream') },
      { title: 'World Atlas', sub: 'Resume, changed, stale, commitments, questions, people', badge: 'View', action: () => switchView('atlas') },
      { title: 'MemT Procedural Library', sub: 'Verified operating rules and repeatable recipes', badge: 'View', action: () => switchView('memt') },
      { title: 'Open Multi-Turn Mind Chat', sub: 'Ask Mind, anchor facts, save recipes, run reflex check', badge: '\u2318J', badgeClass: 'badge-amber', action: () => openChatModal({ mode: 'ask' }) },
      {
        title: 'Create New Vault Note',
        sub: 'Draft a markdown note in owner-notes/',
        badge: 'Note',
        badgeClass: 'badge-cyan',
        action: () => {
          switchView('vault', { skipAutoOpen: true });
          enterDocEditor(true);
        },
      },
      {
        title: 'Toggle Theme (' + (state.theme === 'dark' ? 'Dark -> Light' : 'Light -> Dark') + ')',
        sub: 'Switch Vercel Geist polarity',
        badge: 'Theme',
        action: () => {
          state.theme = state.theme === 'dark' ? 'light' : 'dark';
          applyTheme(true);
        },
      },
    ].filter((c) => !q || (c.title + ' ' + c.sub).toLowerCase().includes(q));

    renderCmdkList([{ label: 'Quick Actions & Workspaces', items: commands }], opts);
  }

  function jumpToTodayRowEnsuringVisible(targetId) {
    switchView('today');
    if (!targetId) return;
    const isVisible = state.todayRows.some((r) => r.id === targetId);
    if (!isVisible && state.today) {
      state.todayTab = 'all';
      state.todayChannel = 'all';
      renderTodayTriageList();
    }
    selectTodayRow(targetId, { openMobileDetail: true });
  }

  async function runOmniSearch(query) {
    const q = query.trim();
    if (!q) {
      $('#cmdk-meta').textContent = 'ESC';
      renderCmdkBaseResults('');
      return;
    }

    $('#cmdk-meta').textContent = '...';
    try {
      let data = null;
      try {
        data = await apiGet('/api/omni-search?q=' + encodeURIComponent(q));
      } catch (_) {
        // Fallback to /api/search + /api/docs if omni-search is unavailable
        const [sRes, dRes] = await Promise.allSettled([
          apiGet('/api/search?q=' + encodeURIComponent(q)),
          apiGet('/api/docs?q=' + encodeURIComponent(q) + '&limit=6'),
        ]);
        const s = sRes.status === 'fulfilled' ? sRes.value : {};
        const d = dRes.status === 'fulfilled' ? extractDocItems(dRes.value) : [];
        data = {
          query: q,
          groups: {
            calendar: [],
            inbox: [],
            people: [],
            codex: [],
            docs: d,
            memt: s.memt_hits || [],
            nodes: s.world_hits || [],
          },
        };
      }

      if (!state.cmdkOpen || $('#cmdk-input').value.trim() !== q) return;
      const g = (data && data.groups) || {};
      const total = data && data.total !== undefined ? data.total + ' hits' : 'OK';
      $('#cmdk-meta').textContent = total;

      const groups = [];

      if (Array.isArray(g.calendar) && g.calendar.length > 0) {
        groups.push({
          label: 'Calendar',
          items: g.calendar.slice(0, 5).map((ev) => ({
            title: ev.title || ev.summary || 'Calendar Event',
            sub: (ev.time_label || formatRelativeTime(ev.start)) + (ev.calendar ? ' \u00b7 ' + ev.calendar : ''),
            badge: 'Calendar',
            badgeClass: 'badge-blue',
            action: () => {
              if (ev.id) jumpToTodayRowEnsuringVisible('meeting:' + ev.id);
              else switchView('today');
            },
          })),
        });
      }

      if (Array.isArray(g.inbox) && g.inbox.length > 0) {
        groups.push({
          label: 'Inbox',
          items: g.inbox.slice(0, 6).map((m) => {
            const info = channelInfo(m.channel || m.source);
            const msgTitle = m.thread_title || m.subject || m.title || m.preview || m.snippet || 'Message';
            return {
              title: (m.sender ? m.sender + ' \u00b7 ' : '') + msgTitle,
              sub: m.preview || m.snippet || formatRelativeTime(m.occurred_at || m.timestamp),
              badge: info.short,
              action: () => {
                if (m.id) jumpToTodayRowEnsuringVisible('inbox:' + m.id);
                else switchView('today');
              },
            };
          }),
        });
      }

      const codexHits = Array.isArray(data && data.codex)
        ? data.codex
        : Array.isArray(g.codex)
        ? g.codex
        : [];
      if (codexHits.length > 0) {
        groups.push({
          label: 'Mind Codex',
          items: codexHits.slice(0, 6).map((hit) => ({
            title: hit.title || hit.id || 'Codex Entry',
            sub: [hit.domain, hit.subtitle || hit.summary].filter(Boolean).join(' \u00b7 '),
            badge: hit.stage || hit.section || 'Codex',
            badgeClass: 'badge-amber',
            action: () => switchView('codex', { section: hit.section, itemId: hit.id }),
          })),
        });
      }

      if (Array.isArray(g.people) && g.people.length > 0) {
        groups.push({
          label: 'People',
          items: g.people.slice(0, 6).map((p) => ({
            title: p.name || p.key,
            sub: p.preview || p.last_snippet || (Array.isArray(p.channels) ? p.channels.join(', ') : 'Dossier'),
            badge: 'Person',
            badgeClass: 'badge-violet',
            action: () => openPersonDossier(p.key || p.name, { jumpView: true, openMobileDetail: true }),
          })),
        });
      }

      if (Array.isArray(g.docs) && g.docs.length > 0) {
        groups.push({
          label: 'Vault & Notes' + (state.vaultTotal > 0 ? ' (' + formatCompact(state.vaultTotal) + ')' : ''),
          items: g.docs.slice(0, 6).map((d) => ({
            title: d.title || titleFromPath(d.path),
            sub: d.path,
            badge: d.category || '.md',
            action: () => openVaultDoc(d.path),
          })),
        });
      }

      if (Array.isArray(g.memt) && g.memt.length > 0) {
        groups.push({
          label: 'MemT',
          items: g.memt.slice(0, 5).map((m) => ({
            title: m.condition || m.title || m.label || m.id || 'Recipe',
            sub: m.recommendation || m.summary || m.domain || '',
            badge: m.domain || 'MemT',
            badgeClass: 'badge-teal',
            action: () => {
              state.memtSearch = q;
              const ms = $('#memt-search');
              if (ms) ms.value = q;
              switchView('memt');
              if (state.memtData) renderMemtList();
            },
          })),
        });
      }

      if (Array.isArray(g.nodes) && g.nodes.length > 0) {
        groups.push({
          label: 'Graph Nodes',
          items: g.nodes.slice(0, 6).map((w) => ({
            title: w.label || w.title || w.name || w.id,
            sub: w.summary || w.kind || '',
            badge: w.kind || 'Node',
            badgeClass: badgeClassForKind(w.kind, true),
            action: () => jumpToGraphNode(w.id),
          })),
        });
      }

      const boardHits = Array.isArray(g.board)
        ? g.board
        : Array.isArray(data && data.board)
        ? data.board
        : [];
      if (boardHits.length > 0) {
        groups.push({
          label: 'Agent Board',
          items: boardHits.slice(0, 6).map((hit) => {
            const ch = String(hit.channel || 'box').replace(/^#/, '');
            const title = hit.title || hit.subject || hit.preview || hit.text || ('Thread #' + (hit.id || ''));
            const replyCount = Number(hit.reply_count ?? hit.replies ?? hit.replyCount ?? 0);
            const replyLabel = replyCount === 1 ? '1 reply' : replyCount + ' replies';
            return {
              title: '#' + ch + ' \u00b7 ' + title + ' \u00b7 ' + replyLabel,
              sub: hit.snippet || hit.preview || (hit.author ? 'by ' + hit.author : 'Open thread in Agent Board'),
              badge: 'Board',
              badgeClass: 'badge-cyan',
              action: () => switchView('board', { channel: hit.channel, threadId: hit.id, stage: 'thread' }),
            };
          }),
        });
      }

      groups.push({
        label: 'Mind Chat',
        items: [
          {
            title: 'Ask Mind: "' + q + '"',
            sub: 'Run grounded query across Calendar, Inbox, Obsidian, Apple Notes, and Kizuki',
            badge: 'Ask G4',
            badgeClass: 'badge-amber',
            action: () => openChatModal({ mode: 'ask', prompt: q, autoSubmit: true }),
          },
        ],
      });

      renderCmdkList(groups);
    } catch (_) {
      $('#cmdk-meta').textContent = 'LOCAL';
      renderCmdkBaseResults(q);
    }
  }

  function updateCmdkSelection(nextIdx) {
    if (state.cmdkItems.length === 0) return;
    state.cmdkIndex = (nextIdx + state.cmdkItems.length) % state.cmdkItems.length;
    $$('.cmdk-item').forEach((el, idx) => {
      const sel = idx === state.cmdkIndex;
      el.classList.toggle('is-active', sel);
      el.classList.toggle('is-selected', sel);
      if (sel) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function executeCmdkItem(idx) {
    const item = state.cmdkItems[idx];
    if (!item) return;
    closeCmdk();
    if (item.action) item.action();
  }

  // =========================================================================
  // GLOBAL EVENT WIRING
  // =========================================================================
  function bindGlobalEvents() {
    // Sidebar & Mobile Navigation
    $$('.os-nav-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    const toggleTheme = () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(true);
    };
    $('#btn-theme-toggle').addEventListener('click', toggleTheme);
    $('#btn-mobile-theme').addEventListener('click', toggleTheme);

    $('#btn-detail-toggle').addEventListener('click', () => {
      state.detailOn = !state.detailOn;
      applyDetailMode(true);
    });

    $('#btn-brand-home').addEventListener('click', () => {
      switchView('today');
      selectTodayRow('morning-brief', { openMobileDetail: false });
    });
    $('#btn-mobile-home').addEventListener('click', () => {
      switchView('today');
      setTodayMobileDetail(false);
    });

    $('#btn-mobile-menu').addEventListener('click', () => setMobileSidebarOpen(!state.sidebarOpen));
    $('#btn-sidebar-close').addEventListener('click', () => setMobileSidebarOpen(false));
    $('#sidebar-backdrop').addEventListener('click', () => setMobileSidebarOpen(false));

    $('#btn-mobile-cmdk').addEventListener('click', openCmdk);
    $('#btn-cmdk').addEventListener('click', openCmdk);
    $('#btn-mobile-chat').addEventListener('click', () => openChatModal());
    $('#btn-open-chat').addEventListener('click', () => {
      setMobileSidebarOpen(false);
      openChatModal();
    });

    $('#mobile-whoop-pill').addEventListener('click', () => {
      switchView('today');
      selectTodayRow('morning-brief', { openMobileDetail: true });
    });
    $('#mobile-next-up-ticker').addEventListener('click', () => {
      switchView('today');
      if (state.tickerTargetMeetingId) {
        selectTodayRow('meeting:' + state.tickerTargetMeetingId, { openMobileDetail: true });
      } else {
        selectTodayRow('morning-brief', { openMobileDetail: true });
      }
    });

    // Today Pane 2 Controls
    $('#btn-toggle-quick-action').addEventListener('click', () => {
      const form = $('#triage-quick-add');
      form.hidden = !form.hidden;
      if (!form.hidden) $('#quick-action-title').focus();
    });
    $('#btn-quick-action-cancel').addEventListener('click', () => {
      $('#triage-quick-add').hidden = true;
    });
    $('#quick-action-title').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        $('#triage-quick-add').hidden = true;
        e.currentTarget.blur();
      }
    });
    $('#triage-quick-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const titleInput = $('#quick-action-title');
      const tagSelect = $('#quick-action-tag');
      const title = titleInput.value.trim();
      if (!title) return;
      const res = await mutateAction({ op: 'add', title, tag: tagSelect.value || 'Work', source: 'Today Quick Add' });
      if (res && res.ok !== false) {
        titleInput.value = '';
        $('#triage-quick-add').hidden = true;
        showToast('Added action: ' + title, 'success');
      }
    });

    $$('.triage-tab[data-triage-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.todayTab = tab.dataset.triageTab;
        syncTodayFilterChrome();
        renderTodayTriageList();
        renderTodayDetailPane();
      });
    });

    $('#today-channel-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-ch]');
      if (!pill) return;
      state.todayChannel = pill.dataset.ch;
      $$('#today-channel-pills [data-ch]').forEach((p) => p.classList.toggle('is-active', p === pill));
      renderTodayTriageList();
    });

    $('#btn-noise-toggle').addEventListener('click', () => {
      state.includeNoise = !state.includeNoise;
      loadToday({ silent: true });
    });

    // Today Pane 3 Topbar & Mobile Back
    $('#btn-today-back').addEventListener('click', () => setTodayMobileDetail(false));
    $('#btn-detail-primary').addEventListener('click', () => {
      const row = getSelectedTodayRow();
      if (row.kind === 'brief') {
        switchView('vault');
      } else if (row.kind === 'meeting') {
        runMeetingPrep(row.data.id);
      } else if (row.kind === 'inbox') {
        if (isMobileViewport()) setMobileComposerExpanded(true);
        runInboxDraft(row.data.id);
      } else if (row.kind === 'action') {
        openChatModal({
          mode: 'ask',
          context: { type: 'Action', label: row.data.title },
          prompt: 'Give me concrete, minimal next steps to finish this action: "' + row.data.title + '"',
          autoSubmit: true,
        });
      }
    });

    // Today Docked Composer (with Mobile Collapsible Toggle)
    const mobileComposerBar = $('#mobile-composer-bar');
    if (mobileComposerBar) {
      mobileComposerBar.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextExpanded = !state.mobileComposerExpanded;
        setMobileComposerExpanded(nextExpanded, { focusInput: nextExpanded });
      });
      mobileComposerBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const nextExpanded = !state.mobileComposerExpanded;
          setMobileComposerExpanded(nextExpanded, { focusInput: nextExpanded });
        }
      });
    }
    $$('.comp-tab[data-composer-mode]').forEach((tab) => {
      tab.addEventListener('click', () => {
        setComposerMode(tab.dataset.composerMode);
        setMobileComposerExpanded(true, { focusInput: true });
      });
    });
    $('#composer-form').addEventListener('submit', handleComposerSubmit);
    $('#composer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.blur();
        setMobileComposerExpanded(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#composer-form').requestSubmit();
      }
    });
    $('#btn-composer-copy').addEventListener('click', () => {
      const txt = state.lastDraftMd || $('#composer-input').value.trim();
      copyToClipboard(txt, 'Copied local draft to clipboard.');
    });
    $('#btn-composer-output-copy').addEventListener('click', () => {
      copyToClipboard(state.lastDraftMd, 'Copied draft output to clipboard.');
    });
    $('#btn-composer-output-close').addEventListener('click', () => {
      $('#composer-output').hidden = true;
    });
    $('#btn-composer-save').addEventListener('click', () => saveDraftToVault());

    // People Controls
    $('#btn-people-refresh').addEventListener('click', () => loadPeople());
    $('#btn-people-back').addEventListener('click', () => setPeopleMobileDetail(false));
    $('#people-search').addEventListener('input', (e) => {
      state.peopleQuery = e.target.value;
      if (state.peopleSearchTimer) clearTimeout(state.peopleSearchTimer);
      state.peopleSearchTimer = setTimeout(() => loadPeople(), 180);
    });
    $('#people-channel-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-people-ch], [data-channel]');
      if (!pill) return;
      state.peopleChannel = pill.dataset.peopleCh || pill.dataset.channel || 'all';
      $$('#people-channel-pills [data-people-ch], #people-channel-pills [data-channel]').forEach((p) =>
        p.classList.toggle('is-active', p === pill)
      );
      loadPeople();
    });
    $('#btn-people-note').addEventListener('click', () => {
      if (!state.selectedDossier) return;
      state.peopleNoteOpen = !state.peopleNoteOpen;
      renderPersonDossier(state.selectedDossier);
      if (state.peopleNoteOpen) {
        const inp = $('#wm-note-input');
        if (inp) setTimeout(() => inp.focus(), 20);
      }
    });
    $('#btn-people-prep').addEventListener('click', () => runPersonAiAction('meeting_prep'));
    $('#btn-people-draft').addEventListener('click', () => runPersonAiAction('reply'));
    $('#btn-people-synthesize').addEventListener('click', () => {
      if (state.selectedPersonKey) synthesizePersonProfile(state.selectedPersonKey);
    });

    const peopleDetailBody = $('#people-detail-body');
    peopleDetailBody.addEventListener('click', (e) => {
      const targetEl = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (!targetEl) return;

      const tabBtn = targetEl.closest('[data-dossier-tab]');
      if (tabBtn && state.selectedDossier) {
        e.stopPropagation();
        const nextTab = tabBtn.getAttribute('data-dossier-tab') || 'overview';
        const isInlineJump = !tabBtn.classList.contains('dossier-subtab');
        const prevScroll = peopleDetailBody.scrollTop;
        state.peopleDossierTab = nextTab;
        renderPersonDossier(state.selectedDossier);
        if (isInlineJump) {
          const subtabsEl = $('.dossier-subtabs', peopleDetailBody);
          if (subtabsEl) subtabsEl.scrollIntoView({ block: 'nearest' });
        } else {
          peopleDetailBody.scrollTop = prevScroll;
        }
        return;
      }

      const openPersonEl = targetEl.closest('[data-open-person]');
      if (openPersonEl) {
        const key = openPersonEl.getAttribute('data-open-person');
        if (key) {
          e.stopPropagation();
          if (key.toLowerCase() !== String(state.selectedPersonKey || '').toLowerCase()) {
            selectPerson(key, { openMobileDetail: true });
          }
        }
        return;
      }

      const synthTrigger = targetEl.closest('[data-synthesize-person]');
      if (synthTrigger) {
        const key = synthTrigger.getAttribute('data-synthesize-person') || state.selectedPersonKey;
        if (key) synthesizePersonProfile(key);
        return;
      }

      const noteKindBtn = targetEl.closest('[data-note-kind]');
      if (noteKindBtn && state.selectedDossier) {
        const prevVal = ($('#wm-note-input') && $('#wm-note-input').value) || '';
        state.peopleNoteKind = noteKindBtn.getAttribute('data-note-kind') || 'insight';
        renderPersonDossier(state.selectedDossier);
        const inp = $('#wm-note-input');
        if (inp) {
          inp.value = prevVal;
          inp.focus();
        }
        return;
      }

      const closeNoteBtn = targetEl.closest('[data-close-note-drawer]');
      if (closeNoteBtn && state.selectedDossier) {
        state.peopleNoteOpen = false;
        renderPersonDossier(state.selectedDossier);
        return;
      }

      const dismissAiBtn = targetEl.closest('[data-dismiss-person-ai]');
      if (dismissAiBtn && state.selectedDossier) {
        state.peopleAiOutput = null;
        renderPersonDossier(state.selectedDossier);
        return;
      }

      const histFilterBtn = targetEl.closest('[data-history-filter]');
      if (histFilterBtn && state.selectedDossier) {
        state.peopleHistoryFilter = histFilterBtn.getAttribute('data-history-filter') || 'all';
        filterPersonHistory();
        return;
      }

      const loadMoreBtn = targetEl.closest('[data-load-more-history]');
      if (loadMoreBtn) {
        loadMorePersonHistory();
        return;
      }

      const copyMdBtn = targetEl.closest('[data-copy-person-md]');
      if (copyMdBtn && state.selectedDossier) {
        const md = (state.selectedDossier.world_model && state.selectedDossier.world_model.full_markdown) || '';
        copyToClipboard(md, 'Copied full world-model card markdown.');
      }
    });

    peopleDetailBody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const targetEl = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (!targetEl) return;
      const openPersonEl = targetEl.closest('[data-open-person]');
      if (openPersonEl) {
        const key = openPersonEl.getAttribute('data-open-person');
        if (key) {
          e.preventDefault();
          e.stopPropagation();
          if (key.toLowerCase() !== String(state.selectedPersonKey || '').toLowerCase()) {
            selectPerson(key, { openMobileDetail: true });
          }
        }
      }
    });

    peopleDetailBody.addEventListener('submit', (e) => {
      const form = e.target.closest('#wm-note-form');
      if (!form) return;
      e.preventDefault();
      const inp = $('#wm-note-input', form);
      const text = inp ? inp.value.trim() : '';
      submitPersonObservation(state.selectedPersonKey, state.peopleNoteKind, text);
    });

    peopleDetailBody.addEventListener('input', (e) => {
      const histInput = e.target.closest('#people-history-search');
      if (!histInput) return;
      state.peopleHistoryQuery = histInput.value;
      if (state.peopleHistorySearchTimer) clearTimeout(state.peopleHistorySearchTimer);
      state.peopleHistorySearchTimer = setTimeout(() => {
        filterPersonHistory({ preserveFocus: true });
      }, 200);
    });

    // Life Replay Controls
    $('#btn-replay-back').addEventListener('click', () => setReplayMobileDetail(false));
    $('#btn-replay-prev').addEventListener('click', () => stepReplayDay(-1));
    $('#btn-replay-next').addEventListener('click', () => stepReplayDay(1));
    $('#btn-replay-import').addEventListener('click', openReplayImportModal);
    $('#btn-replay-import-close').addEventListener('click', closeReplayImportModal);
    $('#btn-replay-import-done').addEventListener('click', closeReplayImportModal);
    $('#replay-import-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#replay-import-backdrop')) closeReplayImportModal();
    });

    const replayImportFile = $('#replay-import-file');
    replayImportFile.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleReplayImportFile(f);
    });
    const replayDropzone = $('#replay-import-dropzone');
    replayDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      replayDropzone.classList.add('is-dragover');
    });
    replayDropzone.addEventListener('dragleave', () => {
      replayDropzone.classList.remove('is-dragover');
    });
    replayDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      replayDropzone.classList.remove('is-dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleReplayImportFile(f);
    });

    $('#btn-replay-story').addEventListener('click', () => {
      synthesizeReplayStory({ regenerate: Boolean(state.replayDay && state.replayDay.story_md) });
    });

    $('#replay-year-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-replay-year]');
      if (!btn) return;
      const yr = Number(btn.dataset.replayYear);
      if (Number.isFinite(yr) && yr !== state.replayYear) {
        loadReplayIndex({ year: yr });
      }
    });

    $('#replay-heatmap-grid').addEventListener('click', (e) => {
      const targetEl = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      const cell = targetEl ? targetEl.closest('[data-replay-day]') : null;
      if (!cell) return;
      const day = cell.getAttribute('data-replay-day');
      if (day) selectReplayDay(day, { openMobileDetail: isMobileViewport(), focusMap: true });
    });
    $('#replay-heatmap-grid').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const targetEl = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      const cell = targetEl ? targetEl.closest('[data-replay-day]') : null;
      if (!cell) return;
      const day = cell.getAttribute('data-replay-day');
      if (day) {
        e.preventDefault();
        selectReplayDay(day, { openMobileDetail: isMobileViewport(), focusMap: true });
      }
    });

    $('#replay-trips-strip').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-replay-trip-day]');
      if (!chip) return;
      const day = chip.dataset.replayTripDay;
      if (day) {
        state.replayMapRegion = 'day';
        selectReplayDay(day, { openMobileDetail: isMobileViewport(), focusMap: true });
      }
    });

    $('#replay-day-filter').addEventListener('input', (e) => {
      state.replayFilter = e.target.value;
      renderReplayDaysList();
    });

    $('#replay-days-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-replay-day]');
      if (!row) return;
      const day = row.dataset.replayDay;
      if (day) selectReplayDay(day, { openMobileDetail: isMobileViewport(), focusMap: true });
    });

    $('#replay-map-modes').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-map-region]');
      if (!btn) return;
      state.replayFocusedPlaceKey = null;
      setReplayMapRegion(btn.dataset.mapRegion);
      syncReplayMap({ forceFocusDay: false });
    });
    $('#btn-replay-map-in').addEventListener('click', () => {
      if (replayMap) replayMap.zoomBy(1.45);
    });
    $('#btn-replay-map-out').addEventListener('click', () => {
      if (replayMap) replayMap.zoomBy(1 / 1.45);
    });
    $('#btn-replay-map-fit').addEventListener('click', () => {
      state.replayFocusedPlaceKey = null;
      if (replayMap) {
        syncReplayMap({ forceFocusDay: false });
        replayMap.fitView();
      }
      if (state.replaySubTab === 'places') renderReplayTabPanel();
    });

    $('#replay-subtabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-replay-tab]');
      if (!tab) return;
      state.replaySubTab = tab.dataset.replayTab || 'timeline';
      renderReplayTabPanel();
    });

    $('#replay-story-container').addEventListener('click', (e) => {
      const regenBtn = e.target.closest('[data-replay-story-regen]');
      if (regenBtn) {
        synthesizeReplayStory({ regenerate: regenBtn.getAttribute('data-replay-story-regen') === '1' });
        return;
      }
      const copyBtn = e.target.closest('[data-replay-story-copy]');
      if (copyBtn && state.replayDay && state.replayDay.story_md) {
        copyToClipboard(state.replayDay.story_md, 'Copied AI Day Story markdown.');
      }
    });

    $('#replay-tabpanel').addEventListener('click', (e) => {
      const focusBtn = e.target.closest('[data-replay-focus-place]');
      if (focusBtn) {
        const key = focusBtn.getAttribute('data-replay-focus-place');
        state.replayFocusedPlaceKey = state.replayFocusedPlaceKey === key ? null : key;
        state.replayMapRegion = 'day';
        syncReplayMap({ forceFocusDay: true });
        if (state.replaySubTab === 'places') renderReplayTabPanel();
        const mapCard = $('#replay-map-card');
        if (mapCard) mapCard.scrollIntoView({ behavior: state.detailOn ? 'smooth' : 'auto', block: 'nearest' });
      }
    });

    window.addEventListener('resize', () => {
      if (replayMap && state.view === 'replay') {
        replayMap.resize();
        syncReplayMap({ forceFocusDay: false });
      }
    });

    // Vault Controls
    $('#btn-vault-sidebar-toggle').addEventListener('click', () => toggleSubSidebar());
    $('#vault-search').addEventListener('input', (e) => {
      state.vaultQuery = e.target.value;
      if (state.vaultSearchTimer) clearTimeout(state.vaultSearchTimer);
      state.vaultSearchTimer = setTimeout(() => loadVaultDocs({ reset: true }), 180);
    });
    $('#vault-sort').addEventListener('change', (e) => {
      state.vaultSort = e.target.value;
      loadVaultDocs({ reset: true });
    });
    $('#vault-cat-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-vault-cat]');
      if (!btn) return;
      state.vaultCategory = btn.dataset.vaultCat;
      await loadVaultDocs({ reset: true });
      if (state.vaultDocs.length > 0) {
        const activeInList = state.vaultDocs.some((d) => (d.path || d.rel_path || '') === state.activeDocPath);
        if (!activeInList) {
          const firstPath = state.vaultDocs[0].path || state.vaultDocs[0].rel_path || '';
          if (firstPath) {
            await openVaultDoc(firstPath);
          }
        }
      }
    });
    $('#btn-vault-load-more').addEventListener('click', () => loadVaultDocs({ reset: false }));
    $('#btn-new-note').addEventListener('click', () => enterDocEditor(true));
    $('#btn-doc-edit').addEventListener('click', () => enterDocEditor(false));
    $('#btn-doc-cancel').addEventListener('click', () => exitDocEditor());
    $('#btn-doc-save').addEventListener('click', () => saveActiveDoc());
    $('#btn-doc-copy').addEventListener('click', () => {
      if (state.activeDoc) copyToClipboard(state.activeDoc.markdown || '', 'Copied markdown to clipboard.');
    });
    $('#btn-doc-raw').addEventListener('click', () => {
      if (!state.activeDoc || state.docEditMode) return;
      state.docRawMode = !state.docRawMode;
      $('#btn-doc-raw').setAttribute('aria-pressed', state.docRawMode ? 'true' : 'false');
      $('#doc-content').hidden = state.docRawMode;
      $('#doc-raw-view').hidden = !state.docRawMode;
    });
    $('#btn-doc-ask').addEventListener('click', () => {
      if (!state.activeDoc) return;
      openChatModal({
        mode: 'ask',
        context: { type: 'doc', path: state.activeDoc.path, title: state.activeDoc.title || titleFromPath(state.activeDoc.path) },
      });
    });

    // Graph Controls
    $('#btn-graph-dir-toggle').addEventListener('click', () => toggleSubSidebar());
    $$('.dir-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.dirTab = tab.dataset.dirTab || 'world';
        $$('.dir-tab').forEach((t) => {
          const active = t === tab;
          t.classList.toggle('is-active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        renderMindDirectory();
      });
    });
    $('#dir-search').addEventListener('input', (e) => {
      state.dirSearch = e.target.value;
      renderMindDirectory();
    });
    $('#dir-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-dir-node]');
      if (!row) return;
      const targetId = row.getAttribute('data-dir-node');
      if (targetId) {
        jumpToGraphNode(targetId);
        if (isMobileViewport()) toggleSubSidebar(true);
      }
    });
    $$('.filter-pill[data-kind]').forEach((pill) => {
      pill.addEventListener('click', () => {
        state.graphFilterKind = pill.dataset.kind;
        $$('.filter-pill[data-kind]').forEach((p) => p.classList.toggle('is-active', p === pill));
        if (graph) graph.setFilter({ kind: state.graphFilterKind, query: state.graphSearch });
      });
    });
    const graphSearch = $('#graph-search');
    const clearSearchBtn = $('#btn-graph-search-clear');
    graphSearch.addEventListener('input', () => {
      state.graphSearch = graphSearch.value;
      clearSearchBtn.hidden = !state.graphSearch;
      if (graph) graph.setFilter({ kind: state.graphFilterKind, query: state.graphSearch });
    });
    clearSearchBtn.addEventListener('click', () => {
      graphSearch.value = '';
      state.graphSearch = '';
      clearSearchBtn.hidden = true;
      if (graph) graph.setFilter({ kind: state.graphFilterKind, query: '' });
      graphSearch.focus();
    });
    $('#btn-zoom-in').addEventListener('click', () => graph && graph.zoomBy(1.3));
    $('#btn-zoom-out').addEventListener('click', () => graph && graph.zoomBy(1 / 1.3));
    $('#btn-fit-graph').addEventListener('click', () => graph && graph.fitToScreen(false));
    $('#btn-reheat-graph').addEventListener('click', () => graph && graph.reheat());
    $('#btn-graph-retry').addEventListener('click', () => loadGraphData({ mountNow: true }));

    // Node Inspector Actions
    $('#inspector-close').addEventListener('click', closeNodeInspector);
    $('#btn-ask-node').addEventListener('click', () => {
      const node = state.selectedNodeDetail || (graph && state.selectedNodeId ? graph.getNodeById(state.selectedNodeId) : null);
      if (!node) return;
      openChatModal({
        mode: 'ask',
        context: { type: 'node', id: node.id, label: node.label || node.id },
        prompt: 'Synthesize everything Kizuki knows about "' + (node.label || node.id) + '" and highlight next actions.',
        autoSubmit: true,
      });
    });
    $('#btn-reflex-node').addEventListener('click', () => {
      const node = state.selectedNodeDetail || (graph && state.selectedNodeId ? graph.getNodeById(state.selectedNodeId) : null);
      if (!node) return;
      openChatModal({
        mode: 'reflex',
        context: { type: 'node', id: node.id, label: node.label || node.id },
        prompt: 'Run a reflex check on assumptions, staleness, and blind spots related to "' + (node.label || node.id) + '".',
        autoSubmit: true,
      });
    });
    $('#btn-teach-node').addEventListener('click', () => {
      const node = state.selectedNodeDetail || (graph && state.selectedNodeId ? graph.getNodeById(state.selectedNodeId) : null);
      if (!node) return;
      openChatModal({
        mode: 'tell',
        context: { type: 'node', id: node.id, label: node.label || node.id },
        prompt: 'Correction / update for ' + (node.label || node.id) + ': ',
      });
    });

    // Stream Controls
    $('#btn-stream-refresh').addEventListener('click', () => loadStream({ reset: true }));
    $('#btn-stream-load-more').addEventListener('click', () => loadStream({ reset: false }));
    $('#stream-search').addEventListener('input', (e) => {
      state.streamQuery = e.target.value;
      if (state.streamSearchTimer) clearTimeout(state.streamSearchTimer);
      state.streamSearchTimer = setTimeout(() => loadStream({ reset: true }), 180);
    });
    $('#stream-connectors').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-stream-conn]');
      if (!pill) return;
      state.streamConnector = pill.dataset.streamConn;
      loadStream({ reset: true });
    });

    // Atlas Controls
    $('#atlas-panel-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-atlas-tab]');
      if (!tab) return;
      state.atlasTab = tab.dataset.atlasTab;
      $$('[data-atlas-tab]').forEach((t) => t.classList.toggle('is-active', t === tab));
      renderAtlas();
    });
    $('#btn-atlas-refresh').addEventListener('click', () => loadAtlas());

    // MemT Controls
    $('#btn-toggle-recipe-form').addEventListener('click', () => {
      const wrap = $('#memt-add-form-wrap');
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) $('#recipe-domain').focus();
    });
    $('#btn-cancel-recipe-form').addEventListener('click', () => {
      $('#memt-add-form-wrap').hidden = true;
    });
    $('#memt-add-form').addEventListener('submit', handleAddRecipeFormSubmit);
    $('#memt-search').addEventListener('input', (e) => {
      state.memtSearch = e.target.value;
      renderMemtList();
    });
    $('#memt-domain-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-memt-domain]');
      if (!pill) return;
      state.memtDomain = pill.dataset.memtDomain;
      $$('[data-memt-domain]').forEach((p) => p.classList.toggle('is-active', p === pill));
      renderMemtList();
    });

    // Multi-Turn Mind Chat Modal Controls
    $('#chat-modal-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#chat-modal-backdrop')) closeChatModal();
    });
    $('#btn-chat-close').addEventListener('click', closeChatModal);
    $('#btn-chat-clear').addEventListener('click', () => {
      state.chatMessages = [];
      persistChat();
      syncChatUi();
      showToast('Cleared Mind Chat history.');
    });
    $('#btn-chat-save-note').addEventListener('click', saveChatToNote);
    $('#btn-detach-context').addEventListener('click', () => setChatContext(null));
    $$('#chat-form .mode-btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setChatMode(btn.dataset.mode);
        $('#chat-input').focus();
      });
    });
    $$('#chat-starters .starter-chip[data-starter-prompt]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const mode = chip.getAttribute('data-starter-mode') || 'ask';
        const prompt = chip.getAttribute('data-starter-prompt') || '';
        openChatModal({ mode, prompt, autoSubmit: true });
      });
    });
    $('#chat-form').addEventListener('submit', handleChatSubmit);
    const chatInput = $('#chat-input');
    chatInput.addEventListener('input', () => autoResizeTextarea(chatInput));
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#chat-form').requestSubmit();
      }
    });

    // Omni-Search Command Palette Controls
    $('#cmdk-backdrop').addEventListener('click', (e) => {
      if (e.target === $('#cmdk-backdrop')) closeCmdk();
    });
    $('#cmdk-input').addEventListener('input', (e) => {
      const val = e.target.value;
      const willSearch = val.trim().length >= 2;
      renderCmdkBaseResults(val, { searching: willSearch });
      if (state.cmdkSearchTimer) clearTimeout(state.cmdkSearchTimer);
      if (willSearch) {
        $('#cmdk-meta').textContent = '...';
        state.cmdkSearchTimer = setTimeout(() => runOmniSearch(val), 180);
      } else {
        $('#cmdk-meta').textContent = 'ESC';
      }
    });
    $('#cmdk-results').addEventListener('click', (e) => {
      const item = e.target.closest('[data-cmdk-idx]');
      if (item) executeCmdkItem(Number(item.dataset.cmdkIdx));
    });

    // Delegated Checkbox Change (2-Way Synced Action Toggles)
    document.addEventListener('change', (e) => {
      const chk = e.target.closest('input.action-check[data-toggle-action]');
      if (!chk) return;
      e.stopPropagation();
      const id = chk.getAttribute('data-toggle-action');
      if (id) mutateAction({ op: 'toggle', id });
    });

    // Global Delegated Clicks
    document.addEventListener('click', async (e) => {
      if (e.target.closest('input.action-check[data-toggle-action]')) {
        e.stopPropagation();
        return;
      }

      const jumpMeeting = e.target.closest('[data-jump-meeting]');
      if (jumpMeeting) {
        const mid = jumpMeeting.getAttribute('data-jump-meeting');
        switchView('today');
        selectTodayRow('meeting:' + mid, { openMobileDetail: true });
        return;
      }

      const triageRow = e.target.closest('[data-triage-id]');
      if (triageRow) {
        const rid = triageRow.getAttribute('data-triage-id');
        if (rid) selectTodayRow(rid, { openMobileDetail: true });
        return;
      }

      const selectTodayBtn = e.target.closest('[data-select-today]');
      if (selectTodayBtn) {
        const rid = selectTodayBtn.getAttribute('data-select-today');
        if (rid) selectTodayRow(rid, { openMobileDetail: true });
        return;
      }

      const prepBtn = e.target.closest('[data-run-meeting-prep]');
      if (prepBtn) {
        const mid = prepBtn.getAttribute('data-run-meeting-prep');
        if (mid) runMeetingPrep(mid);
        return;
      }

      const draftBtn = e.target.closest('[data-run-inbox-draft]');
      if (draftBtn) {
        const iid = draftBtn.getAttribute('data-run-inbox-draft');
        if (iid) runInboxDraft(iid);
        return;
      }

      const toggleActBtn = e.target.closest('[data-toggle-action-btn]');
      if (toggleActBtn) {
        const aid = toggleActBtn.getAttribute('data-toggle-action-btn');
        if (aid) mutateAction({ op: 'toggle', id: aid });
        return;
      }

      const delActBtn = e.target.closest('[data-delete-action]');
      if (delActBtn) {
        const aid = delActBtn.getAttribute('data-delete-action');
        if (aid) {
          const res = await mutateAction({ op: 'delete', id: aid });
          if (res && res.ok !== false) {
            showToast('Deleted action item.');
            selectTodayRow('morning-brief', { openMobileDetail: false });
          }
        }
        return;
      }

      const dispatchActionBtn = e.target.closest('[data-board-dispatch-action]');
      if (dispatchActionBtn && state.today) {
        const aid = dispatchActionBtn.getAttribute('data-board-dispatch-action');
        const act = state.today.actions.find((a) => a.id === aid);
        if (act && window.KizukiBoardWidgets && typeof window.KizukiBoardWidgets.openBoardDispatchModal === 'function') {
          const actText = act.text || act.title || '';
          const defaultText = act.text || (act.detail ? actText + '\n\n' + act.detail : actText);
          window.KizukiBoardWidgets.openBoardDispatchModal(
            {
              sourceKind: 'today',
              sourceId: act.id,
              sourceLabel: actText,
              defaultChannel: 'box/work',
              defaultText,
            },
            {
              openBoard: (opts = {}) => switchView('board', opts),
              showToast: (msg, tone) => showToast(msg, tone || 'info'),
            }
          );
        }
        return;
      }

      const sendAskBoardBtn = e.target.closest('[data-send-ask-to-board]');
      if (sendAskBoardBtn) {
        const mid = sendAskBoardBtn.getAttribute('data-send-ask-to-board');
        const msg = state.chatMessages.find((m) => String(m.id || '') === String(mid || ''));
        const msgText = (msg && msg.text) || '';
        if (window.KizukiBoardWidgets && typeof window.KizukiBoardWidgets.openBoardDispatchModal === 'function') {
          window.KizukiBoardWidgets.openBoardDispatchModal(
            {
              sourceKind: 'ask',
              sourceId: 'ask-reply',
              sourceLabel: 'Ask Mind Synthesis',
              defaultChannel: 'box/work',
              defaultText: msgText,
            },
            {
              openBoard: (opts = {}) => {
                closeChatModal();
                switchView('board', opts);
              },
              showToast: (m, tone) => showToast(m, tone || 'info'),
            }
          );
        }
        return;
      }

      const askStepsBtn = e.target.closest('[data-ask-action-steps]');
      if (askStepsBtn && state.today) {
        const aid = askStepsBtn.getAttribute('data-ask-action-steps');
        const act = state.today.actions.find((a) => a.id === aid);
        if (act) {
          openChatModal({
            mode: 'ask',
            context: { type: 'Action', label: act.title },
            prompt: 'Break down the fastest concrete next steps for: "' + act.title + '"' + (act.detail ? ' (' + act.detail + ')' : ''),
            autoSubmit: true,
          });
        }
        return;
      }

      const editAnchorsBtn = e.target.closest('[data-edit-anchors]');
      if (editAnchorsBtn) {
        openVaultDoc('owner-anchors.md', { edit: true });
        return;
      }

      const navJumpBtn = e.target.closest('[data-nav-jump]');
      if (navJumpBtn) {
        switchView(navJumpBtn.getAttribute('data-nav-jump'));
        return;
      }

      const personCard = e.target.closest('[data-open-person]');
      if (personCard) {
        const key = personCard.getAttribute('data-open-person');
        if (key) {
          if (!state.peopleLoaded) loadPeople();
          openPersonDossier(key, { jumpView: true, openMobileDetail: true });
        }
        return;
      }

      const personRow = e.target.closest('[data-person-key]');
      if (personRow) {
        const key = personRow.getAttribute('data-person-key');
        if (key) openPersonDossier(key, { openMobileDetail: true });
        return;
      }

      const savePersonDraft = e.target.closest('[data-save-person-draft]');
      if (savePersonDraft && state.peopleAiOutput) {
        const p = state.selectedDossier && state.selectedDossier.person;
        saveDraftToVault(state.peopleAiOutput.md, (state.peopleAiOutput.engine || 'Draft') + ' - ' + ((p && p.name) || state.selectedPersonKey));
        return;
      }

      const copyCodeBtn = e.target.closest('[data-copy-code]');
      if (copyCodeBtn) {
        let codeText = copyCodeBtn.getAttribute('data-copy-code') || '';
        if (!codeText || codeText === 'true' || codeText === '1') {
          const wrap = copyCodeBtn.closest('.md-code-block, .code-block, pre') || copyCodeBtn.parentElement;
          const codeEl = wrap ? wrap.querySelector('code') : null;
          codeText = codeEl ? codeEl.textContent : '';
        }
        const ok = await copyToClipboard(codeText, 'Copied code block.');
        if (ok) {
          const prev = copyCodeBtn.textContent;
          copyCodeBtn.textContent = 'Copied';
          setTimeout(() => { copyCodeBtn.textContent = prev || 'Copy'; }, 1200);
        }
        return;
      }

      const copyTextBtn = e.target.closest('[data-copy-text]');
      if (copyTextBtn) {
        const txt = copyTextBtn.getAttribute('data-copy-text') || '';
        const ok = await copyToClipboard(txt, 'Copied ' + (txt.length > 42 ? txt.slice(0, 42) + '...' : txt));
        if (ok) {
          const copyTag = copyTextBtn.querySelector('.contact-pill-copy');
          if (copyTag) {
            const prevTag = copyTag.textContent;
            copyTextBtn.classList.add('is-copied');
            copyTag.textContent = 'Copied';
            setTimeout(() => {
              copyTextBtn.classList.remove('is-copied');
              copyTag.textContent = prevTag || 'Copy';
            }, 1400);
          } else {
            const prev = copyTextBtn.textContent;
            copyTextBtn.textContent = 'Copied';
            setTimeout(() => { copyTextBtn.textContent = prev; }, 1200);
          }
        }
        return;
      }

      const openDocBtn = e.target.closest('[data-open-doc]');
      if (openDocBtn) {
        const docPath = openDocBtn.getAttribute('data-open-doc');
        if (docPath) {
          closeChatModal();
          openVaultDoc(docPath);
          if (isMobileViewport() && state.view === 'vault') {
            const shell = $('#app-shell');
            if (shell) shell.classList.remove('vault-sidebar-open');
            state.vaultSidebarOpen = false;
          }
        }
        return;
      }

      const wikiBtn = e.target.closest('[data-open-wikilink]');
      if (wikiBtn) {
        e.preventDefault();
        const target = wikiBtn.getAttribute('data-open-wikilink');
        if (target) openWikilink(target);
        return;
      }

      const openBoardThreadBtn = e.target.closest('[data-open-board-thread]');
      if (openBoardThreadBtn) {
        const threadId = openBoardThreadBtn.getAttribute('data-open-board-thread') || '';
        const channel = openBoardThreadBtn.getAttribute('data-board-channel') || undefined;
        closeChatModal();
        switchView('board', {
          threadId: threadId || undefined,
          channel,
          stage: 'thread',
        });
        return;
      }

      const jumpBtn = e.target.closest('[data-jump-node]');
      if (jumpBtn) {
        const targetId = jumpBtn.getAttribute('data-jump-node');
        if (targetId) {
          closeChatModal();
          jumpToGraphNode(targetId);
        }
        return;
      }

      const tocBtn = e.target.closest('[data-toc-id]');
      if (tocBtn) {
        const id = tocBtn.getAttribute('data-toc-id');
        const target = id ? document.getElementById(id) : null;
        if (target) target.scrollIntoView({ behavior: state.detailOn ? 'smooth' : 'auto', block: 'start' });
        return;
      }

      const fmToggle = e.target.closest('[data-toggle-frontmatter]');
      if (fmToggle) {
        const bar = $('#doc-frontmatter');
        if (bar) {
          const collapsed = bar.classList.toggle('is-mobile-collapsed');
          fmToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        return;
      }

      const crumbBtn = e.target.closest('[data-vault-crumb]');
      if (crumbBtn) {
        const cat = crumbBtn.getAttribute('data-vault-crumb');
        if (cat) {
          state.vaultCategory = cat;
          loadVaultDocs({ reset: true });
        }
        return;
      }

      const toggleStreamBtn = e.target.closest('[data-toggle-stream]');
      if (toggleStreamBtn) {
        const evId = toggleStreamBtn.getAttribute('data-toggle-stream');
        if (state.expandedEventIds.has(evId)) state.expandedEventIds.delete(evId);
        else state.expandedEventIds.add(evId);
        renderStreamList();
        return;
      }

      const streamAskBtn = e.target.closest('[data-stream-ask]');
      if (streamAskBtn) {
        const evId = streamAskBtn.getAttribute('data-stream-ask');
        const ev = state.streamEvents.find((item, i) => String(item.id || item.event_id || 'ev-' + i) === evId);
        if (ev) {
          openChatModal({
            mode: 'ask',
            prompt: 'Explain context and implications of this event: ' + (ev.title || ev.summary || ev.preview || evId),
            autoSubmit: true,
          });
        }
        return;
      }

      const streamAnchorBtn = e.target.closest('[data-stream-anchor]');
      if (streamAnchorBtn) {
        const evId = streamAnchorBtn.getAttribute('data-stream-anchor');
        const ev = state.streamEvents.find((item, i) => String(item.id || item.event_id || 'ev-' + i) === evId);
        if (ev) {
          openChatModal({
            mode: 'tell',
            prompt: 'Anchor from event: ' + (ev.title || ev.summary || ev.preview || evId),
          });
        }
        return;
      }

      const atlasAskBtn = e.target.closest('[data-atlas-ask]');
      if (atlasAskBtn) {
        const prompt = atlasAskBtn.getAttribute('data-atlas-ask') || '';
        if (prompt) openChatModal({ mode: 'ask', prompt, autoSubmit: true });
        return;
      }

      const reflexBtn = e.target.closest('[data-reflex-prompt]');
      if (reflexBtn) {
        const prompt = reflexBtn.getAttribute('data-reflex-prompt') || '';
        if (prompt) openChatModal({ mode: 'reflex', prompt, autoSubmit: true });
      }
    });

    // Global Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const lower = e.key.toLowerCase();

      if (mod && lower === 'k') {
        e.preventDefault();
        if (window.KizukiCommandPlane && typeof window.KizukiCommandPlane.toggle === 'function') {
          window.KizukiCommandPlane.toggle('command');
          return;
        }
        if (state.cmdkOpen) closeCmdk();
        else openCmdk();
        return;
      }

      if (mod && lower === 'j') {
        e.preventDefault();
        if (window.KizukiCommandPlane && typeof window.KizukiCommandPlane.toggle === 'function') {
          window.KizukiCommandPlane.toggle('ask');
          return;
        }
        if (state.cmdkOpen) closeCmdk();
        if (state.chatOpen) closeChatModal();
        else openChatModal();
        return;
      }

      if (mod && lower === 's' && state.docEditMode && state.view === 'vault') {
        e.preventDefault();
        saveActiveDoc();
        return;
      }

      if (state.cmdkOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeCmdk();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          updateCmdkSelection(state.cmdkIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          updateCmdkSelection(state.cmdkIndex - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          executeCmdkItem(state.cmdkIndex);
        }
        return;
      }

      if (e.key === 'Escape') {
        if (state.replayImportOpen) {
          closeReplayImportModal();
        } else if (state.chatOpen) {
          closeChatModal();
        } else if (state.sidebarOpen) {
          setMobileSidebarOpen(false);
        } else if (state.selectedNodeId) {
          closeNodeInspector();
        } else if (state.docEditMode) {
          exitDocEditor();
        } else if (state.todayMobileDetailOpen) {
          setTodayMobileDetail(false);
        } else if (state.peopleMobileDetailOpen) {
          setPeopleMobileDetail(false);
        } else if (state.replayMobileDetailOpen) {
          setReplayMobileDetail(false);
        }
        return;
      }

      const inInput =
        document.activeElement &&
        (document.activeElement.tagName === 'INPUT' ||
          document.activeElement.tagName === 'TEXTAREA' ||
          document.activeElement.tagName === 'SELECT' ||
          document.activeElement.isContentEditable);

      const kbwDispatchEl = document.getElementById('kbw-dispatch-modal-backdrop');
      const kbwDispatchOpen = Boolean(
        kbwDispatchEl &&
          !kbwDispatchEl.hidden &&
          (kbwDispatchEl.offsetParent !== null ||
            (typeof kbwDispatchEl.getClientRects === 'function' && kbwDispatchEl.getClientRects().length > 0))
      );

      if (inInput || state.chatOpen || state.replayImportOpen || kbwDispatchOpen) return;

      if (e.key === '/' && !mod && !e.altKey) {
        e.preventDefault();
        openCmdk();
        return;
      }

      if (state.view === 'replay' && !mod && !e.altKey) {
        if ((e.key === ' ' || e.code === 'Space') && !e.defaultPrevented) {
          const activeEl = document.activeElement;
          const targetEl = e.target && typeof e.target.closest === 'function' ? e.target : null;
          const activeTag = activeEl ? activeEl.tagName : '';
          const activeRole = activeEl ? activeEl.getAttribute('role') : '';
          const inInteractiveControl =
            activeTag === 'BUTTON' ||
            activeTag === 'A' ||
            activeRole === 'slider' ||
            activeRole === 'button' ||
            Boolean(targetEl && targetEl.closest('button, a, input, textarea, select, [role="slider"], [role="button"], [role="dialog"]'));
          const atlasOpen = Boolean(
            window.KizukiInstrument &&
              typeof window.KizukiInstrument.isAtlasOpen === 'function' &&
              window.KizukiInstrument.isAtlasOpen()
          );
          if (!inInteractiveControl && !atlasOpen && replayScrubberCtrl && typeof replayScrubberCtrl.togglePlay === 'function') {
            e.preventDefault();
            replayScrubberCtrl.togglePlay();
            return;
          }
        }
        if (e.key === 'ArrowLeft' || e.key === '[') {
          e.preventDefault();
          stepReplayDay(-1);
          return;
        }
        if (e.key === 'ArrowRight' || e.key === ']') {
          e.preventDefault();
          stepReplayDay(1);
          return;
        }
      }

      if (state.view === 'today' && !mod && !e.altKey) {
        if (lower === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveTodaySelection(1);
          return;
        }
        if (lower === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveTodaySelection(-1);
          return;
        }
        if (lower === 'a') {
          e.preventDefault();
          const form = $('#triage-quick-add');
          form.hidden = false;
          $('#quick-action-title').focus();
          return;
        }
        if (lower === 'd') {
          e.preventDefault();
          setComposerMode('draft');
          setMobileComposerExpanded(true, { focusInput: true });
          return;
        }
      }

      if (lower === 'b' && (state.view === 'graph' || state.view === 'vault')) {
        e.preventDefault();
        toggleSubSidebar();
      } else if (state.view === 'graph') {
        if (lower === 'f') {
          e.preventDefault();
          if (graph) graph.fitToScreen(false);
        } else if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          if (graph) graph.zoomBy(1.25);
        } else if (e.key === '-') {
          e.preventDefault();
          if (graph) graph.zoomBy(0.8);
        }
      }
    });
  }

  // =========================================================================
  // BOOTSTRAP
  // =========================================================================
  function bootstrap() {
    initThemePreference();
    initDetailPreference();
    loadPersistedChat();
    if (isMobileViewport()) {
      const shell = $('#app-shell');
      if (shell) shell.classList.add('dir-collapsed');
      state.dirCollapsed = true;
    }

    bindGlobalEvents();

    if (window.KizukiCharts && typeof window.KizukiCharts.bindInteractiveTooltips === 'function') {
      window.KizukiCharts.bindInteractiveTooltips(document.body);
    }
    if (window.KizukiMotion && typeof window.KizukiMotion.bindSpotlightSurface === 'function') {
      window.KizukiMotion.bindSpotlightSurface('.profile-banner, .codex-hero-card');
    }
    if (window.KizukiSound && typeof window.KizukiSound.bindGlobalSounds === 'function') {
      window.KizukiSound.bindGlobalSounds(document.body);
    }
    if (window.KizukiInstrument && typeof window.KizukiInstrument.init === 'function') {
      window.KizukiInstrument.init({
        onSwitchView: (v) => switchView(v),
        clockEl: '#ambient-clock-slot',
        clockOptions: { engineText: 'G4' },
        soundBtnEl: '#btn-sound-toggle',
        tiltSelector: '.profile-banner, .taste-question-card, .codex-hero-card',
      });
    }
    window.KizukiKineticOs?.initGlobalKineticShell();

    const params = new URLSearchParams(window.location.search);
    const paramView = params.get('view');
    const paramDoc = params.get('doc');
    const paramNode = params.get('node');
    const paramPerson = params.get('person');
    const paramDay = params.get('day');
    const paramSection = params.get('section');
    const paramItemId = params.get('itemId') || params.get('item');
    const paramQ = params.get('q');
    const paramDomain = params.get('domain');
    const paramTab = params.get('tab');
    const paramChannel = params.get('channel');
    const paramThread = params.get('thread') || params.get('threadId');
    const paramStage = params.get('stage');
    const paramMode = params.get('mode');

    if (paramDoc) {
      switchView('vault', { skipAutoOpen: true, updateUrl: false });
      openVaultDoc(paramDoc);
    } else if (paramNode) {
      switchView('graph', { updateUrl: false });
      jumpToGraphNode(paramNode);
    } else if (paramPerson) {
      switchView('people', { updateUrl: false });
      loadPeople();
      openPersonDossier(paramPerson, { openMobileDetail: true });
    } else if (paramDay && /^\d{4}-\d{2}-\d{2}$/.test(paramDay)) {
      const yr = Number(paramDay.slice(0, 4));
      state.replaySelectedDay = paramDay;
      state.replayYear = Number.isFinite(yr) ? yr : null;
      switchView('replay', { updateUrl: false, day: paramDay, openMobileDetail: isMobileViewport() });
    } else if (paramView) {
      const lowerView = String(paramView).toLowerCase();
      if (lowerView === 'codex' || lowerView === 'mind-codex') {
        switchView('codex', {
          updateUrl: false,
          section: paramSection || undefined,
          itemId: paramItemId || undefined,
          q: paramQ || undefined,
        });
      } else if (lowerView === 'taste' || lowerView === 'taste-studio') {
        switchView('taste', {
          updateUrl: false,
          domain: paramDomain || undefined,
          tab: paramTab || undefined,
        });
      } else if (lowerView === 'board' || lowerView === 'agent-board') {
        switchView('board', {
          updateUrl: false,
          channel: paramChannel || undefined,
          threadId: paramThread || undefined,
          stage: paramStage || undefined,
          mode: paramMode || undefined,
        });
      } else {
        switchView(paramView, { updateUrl: false });
      }
    } else {
      switchView('today', { updateUrl: false });
    }

    // Parallel initial hydration of Today workbench + live vault pulse + Codex/Taste nav counts
    loadToday();
    loadPulseTelemetry();
    prefetchCodexAndTasteStats();

    // Background prefetch Graph topology + Replay active day count
    setTimeout(() => {
      if (state.graphData.nodes.length === 0 && !state.graphLoading) {
        loadGraphData({ mountNow: state.view === 'graph' });
      }
      if (state.view !== 'replay') {
        prefetchReplayIndex();
      }
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
