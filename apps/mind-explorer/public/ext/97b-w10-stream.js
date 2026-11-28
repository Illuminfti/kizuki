/* Kizuki Wave 10: Event Stream view.
   Enhances #view-stream after app.js renders it:
   - reads read-only clones of the /api/stream and /api/overview responses the app already makes,
     so rows can be enriched without extra requests
   - overview strip in the Today style: KPI tiles plus a 30-day daily volume chart (replay index)
   - sources rail: monogram per connector, real counts, share bars, last event age, stale sources flagged,
     imported archives grouped after the live sources; drives the existing filter pills
   - day group headers, sender initials for message and email events, source monograms on every row
   Everything is scoped to #view-stream and idempotent. Missing data renders as an unavailable state. */
(function () {
  'use strict';
  if (window.__KZ_W10_STREAM__) return;
  window.__KZ_W10_STREAM__ = true;

  var ROOT_ID = 'view-stream';
  var NARROW_MQ = '(max-width: 1180px)';
  var EVENT_CAP = 1200;
  var STALE_MS = 24 * 3600000;
  var HOUR = 3600000;
  var DAY = 86400000;

  var events = new Map();
  var lastResponse = null;
  var connectors = [];
  var allTotal = null;
  var latestBySource = null; /* id -> Date | null, from /api/overview vault.connectors */
  var overviewAt = 0;
  var overviewPending = null;
  var replayIndex = null;
  var replayFetchedAt = 0;
  var replayPending = null;
  var fallbackPending = false;
  var attempted = new Set();
  var attemptedKey = '';
  var railExpanded = false;
  var listObserver = null;
  var applying = false;
  var scheduled = 0;

  var FAMILY = {
    agents: { tone: 'violet', label: 'Agent sessions' },
    messages: { tone: 'cobalt', label: 'Messages' },
    notes: { tone: 'emerald', label: 'Notes and saves' },
    life: { tone: 'orange', label: 'Life signals' },
    legacy: { tone: 'slate', label: 'Imported' },
  };

  var SOURCES = {
    'kizuki.claude-code-sessions': { mono: 'Cc', family: 'agents' },
    'kizuki.codex-sessions': { mono: 'Cx', family: 'agents' },
    'mac-claude-sessions': { mono: 'Cc', family: 'agents' },
    'mac-codex-sessions': { mono: 'Cx', family: 'agents' },
    'antigravity-neon': { mono: 'Ag', family: 'agents' },
    telegram: { mono: 'Tg', family: 'messages' },
    whatsapp: { mono: 'Wa', family: 'messages' },
    'mac-imessage': { mono: 'iM', family: 'messages' },
    gmail: { mono: 'Gm', family: 'messages' },
    'kizuki.markdown-folder': { mono: 'Md', family: 'notes' },
    'kizuki.import-legacy-wiki': { mono: 'Wk', family: 'legacy' },
    'mac-obsidian': { mono: 'Ob', family: 'notes' },
    'mac-notes': { mono: 'Nt', family: 'notes' },
    'x-bookmarks': { mono: 'X', family: 'notes' },
    whoop: { mono: 'Wh', family: 'life' },
    'mac-calendar': { mono: 'Ca', family: 'life' },
    'wispr-flow': { mono: 'Wf', family: 'life' },
    'kizuki.wispr-flow': { mono: 'Wf', family: 'life' },
    'kizuki.import-legacy-events': { mono: 'Le', family: 'legacy' },
  };

  var PLATFORM_LABEL = { telegram: 'Telegram', whatsapp: 'WhatsApp', imessage: 'iMessage', email: 'Email', x: 'X' };
  var PLATFORM_SOURCE = { telegram: 'telegram', whatsapp: 'whatsapp', imessage: 'mac-imessage', email: 'gmail', x: 'x-bookmarks' };

  function K() { return window.KizukiKit || null; }
  function root() { return document.getElementById(ROOT_ID); }
  function esc(s) {
    var k = K();
    if (k) return k.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isActive() {
    var r = root();
    return !!r && !r.hidden;
  }
  function isImported(id) { return /import-legacy/.test(String(id || '')); }
  function num(n) { return typeof n === 'number' && Number.isFinite(n); }

  /* ---------------------------------------------------------- source identity */
  function labelFor(id) {
    for (var i = 0; i < connectors.length; i++) if (connectors[i].id === id) return connectors[i].label || id;
    var tail = String(id || '').replace(/^kizuki\./, '').replace(/[-_.]+/g, ' ').trim();
    return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : 'Unknown source';
  }
  function sourceMeta(id, label) {
    var known = SOURCES[id];
    if (known) return { mono: known.mono, family: known.family, tone: FAMILY[known.family].tone };
    var k = K();
    var text = label || labelFor(id);
    return { mono: k ? k.initials(text).slice(0, 2) : text.slice(0, 2), family: isImported(id) ? 'legacy' : 'unknown', tone: 'slate' };
  }
  function familyLabel(id) {
    var m = sourceMeta(id);
    return FAMILY[m.family] ? FAMILY[m.family].label : 'Other source';
  }
  function monogram(id, label, size, extraClass) {
    var m = sourceMeta(id, label);
    var px = size || 28;
    var name = label || labelFor(id);
    var mono = m.mono.length > 1 ? m.mono.charAt(0).toUpperCase() + m.mono.slice(1) : m.mono;
    return '<span class="w10s-mono k10-tone-' + m.tone + (extraClass ? ' ' + extraClass : '') + '" style="--w10s-mono:' + px + 'px" role="img" aria-label="' + esc(name) + '" title="' + esc(name) + '">' + esc(mono) + '</span>';
  }

  /* ---------------------------------------------------------- data capture */
  function slim(ev) {
    var ft = ev.full_text != null ? String(ev.full_text) : '';
    return {
      id: String(ev.id || ev.event_id || ''),
      connector: ev.connector || ev.connector_id || ev.source || '',
      connector_label: ev.connector_label || '',
      kind: ev.kind || '',
      observed_at: ev.observed_at || ev.occurred_at || ev.created_at || ev.timestamp || null,
      title: ev.title != null ? String(ev.title).slice(0, 400) : '',
      preview: ev.preview != null ? String(ev.preview).slice(0, 600) : '',
      full_text: ft.slice(0, 1200),
      avatar_url: ev.avatar_url || ev.sender_avatar_url || '',
    };
  }
  function remember(ev) {
    var s = slim(ev);
    if (!s.id) return;
    if (events.has(s.id)) events.delete(s.id);
    events.set(s.id, s);
    while (events.size > EVENT_CAP) events.delete(events.keys().next().value);
  }

  function filterKey(f) { return f.connector + '\u0000' + f.q; }

  function ingestStream(url, data) {
    if (!data || typeof data !== 'object') return;
    var items = Array.isArray(data.items) ? data.items : Array.isArray(data.events) ? data.events : [];
    for (var i = 0; i < items.length; i++) if (items[i]) remember(items[i]);
    var params;
    try { params = new URL(url, location.origin).searchParams; } catch (e) { params = new URLSearchParams(); }
    var conn = params.get('connector') || 'all';
    var q = (params.get('q') || '').trim();
    if (Array.isArray(data.connectors) && data.connectors.length) {
      connectors = data.connectors.map(function (c) {
        return { id: String(c.id || c.connector_id || c), label: c.label || '', count: num(c.count) ? c.count : null };
      });
    }
    var total = data.total != null ? Number(data.total) : data.total_count != null ? Number(data.total_count) : null;
    if (conn === 'all' && !q && Number.isFinite(total)) allTotal = total;
    var hasMore = data.has_more !== undefined ? !!data.has_more : data.hasMore !== undefined ? !!data.hasMore : null;
    /* Our own fallback slices update counts but never stand in for the page the app asked for. */
    if (!attempted.has(url)) {
      lastResponse = { connector: conn, q: q, total: Number.isFinite(total) ? total : null, hasMore: hasMore };
    } else if (lastResponse && lastResponse.connector === conn && lastResponse.q === q && Number.isFinite(total)) {
      lastResponse.total = total;
    }
  }

  function ingestOverview(data) {
    var list = data && data.vault && Array.isArray(data.vault.connectors) ? data.vault.connectors : null;
    if (!list) return;
    var map = {};
    list.forEach(function (c) {
      var id = String(c.id || c.connector_id || '');
      if (!id) return;
      var d = c.latest ? new Date(c.latest) : null;
      map[id] = d && !isNaN(d.getTime()) ? d : null;
    });
    latestBySource = map;
    overviewAt = Date.now();
  }

  /* Own requests only: the module reads what it fetched instead of wrapping the app-wide fetch. */
  function getJson(url, ingest) {
    return window.fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (data) { if (data) ingest(url, data); })
      .catch(function () {});
  }

  function currentFilter() {
    var r = root();
    var active = r && r.querySelector('#stream-connectors .filter-pill.is-active[data-stream-conn]');
    var input = r && r.querySelector('#stream-search');
    return {
      connector: active ? active.getAttribute('data-stream-conn') || 'all' : 'all',
      q: input ? String(input.value || '').trim() : '',
    };
  }

  /* Rows drawn before this file saw their response have no captured data. Refetch only the missing
     range, once per URL per filter (the server's hot cache answers it). */
  function ensureRowData(firstIdx, lastIdx) {
    if (firstIdx < 0) return;
    if (fallbackPending) return;
    var f = currentFilter();
    var key = filterKey(f);
    if (key !== attemptedKey) { attemptedKey = key; attempted.clear(); }
    var limit = Math.min(100, lastIdx - firstIdx + 1);
    var params = new URLSearchParams();
    if (f.connector !== 'all') params.set('connector', f.connector);
    if (f.q) params.set('q', f.q);
    params.set('limit', String(limit));
    params.set('offset', String(firstIdx));
    var url = '/api/stream?' + params.toString();
    if (attempted.has(url)) return;
    attempted.add(url);
    fallbackPending = true;
    getJson(url, ingestStream)
      .then(function () { fallbackPending = false; schedule(); });
  }

  function loadReplayIndex() {
    if (replayIndex && Date.now() - replayFetchedAt < 120000) return;
    if (replayPending) return;
    replayPending = window.fetch('/api/replay/index', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        replayIndex = d && Array.isArray(d.days) ? d : null;
        replayFetchedAt = Date.now();
        replayPending = null;
        schedule();
      })
      .catch(function () { replayPending = null; replayFetchedAt = Date.now(); schedule(); });
  }

  /* The app requests /api/overview at boot; only if that was missed do we ask once (cached 2 minutes). */
  function ensureOverview() {
    if (latestBySource || overviewPending) return;
    if (overviewAt && Date.now() - overviewAt < 120000) return;
    overviewAt = Date.now();
    overviewPending = getJson('/api/overview', function (_u, d) { ingestOverview(d); })
      .then(function () { overviewPending = null; schedule(); });
  }

  /* ---------------------------------------------------------- dates */
  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseTime(ev) {
    var raw = ev && (ev.observed_at || ev.occurred_at || ev.created_at || ev.timestamp);
    if (!raw) return null;
    var d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  function dayLabel(d) {
    var now = new Date();
    var y = new Date(now); y.setDate(now.getDate() - 1);
    var t = new Date(now); t.setDate(now.getDate() + 1);
    var k = dayKey(d);
    var full = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    if (k === dayKey(now)) return { main: 'Today', sub: full };
    if (k === dayKey(y)) return { main: 'Yesterday', sub: full };
    if (k === dayKey(t)) return { main: 'Tomorrow', sub: full };
    return { main: full, sub: '' };
  }
  /* Clock time when both ends fall on the same day, otherwise the date. */
  function stamp(d, other) { return dayKey(d) === dayKey(other) ? clock(d) : shortDate(d); }
  function shortDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function clock(d) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function age(d) {
    var s = Math.round(Math.abs(Date.now() - d.getTime()) / 1000);
    if (s < 60) return '';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo';
    return Math.floor(s / (86400 * 365)) + 'y';
  }
  function relative(d) {
    var a = age(d);
    if (!a) return 'just now';
    return d.getTime() > Date.now() ? 'in ' + a : a + ' ago';
  }

  /* Freshness of one connector from its latest event. Future dates are reported, never treated as fresh. */
  function freshness(id) {
    if (!latestBySource) return { state: 'unknown' };
    if (!(id in latestBySource)) return { state: 'unknown' };
    var d = latestBySource[id];
    if (!d) return { state: 'unknown' };
    var diff = Date.now() - d.getTime();
    if (diff < -5 * 60000) return { state: 'future', date: d };
    if (diff > STALE_MS) return { state: 'stale', date: d };
    return { state: 'live', date: d };
  }

  /* ---------------------------------------------------------- event parsing */
  var BOT_RE = /(no-?reply|notifications?|noreply|\[bot\]|newsletter|mailer|support|team|info@|digest|news)/i;

  function cleanKind(kind) {
    var s = String(kind || 'event').replace(/[_-]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function norm(s) { return String(s || '').replace(/(…|\.\.\.)\s*$/, '').replace(/\s+/g, ' ').trim(); }

  /* Line 2 must add information: drop a preview that repeats the title, keep only its continuation. */
  function continuation(title, preview) {
    var t = norm(title).toLowerCase();
    var p = norm(preview);
    if (!p) return '';
    var pl = p.toLowerCase();
    if (!t) return p;
    if (pl === t || t.indexOf(pl) === 0) return '';
    if (pl.indexOf(t) === 0) {
      /* Restart at the word the title was cut inside, so the continuation never begins mid-word. */
      var cut = t.length;
      if (/\S/.test(p.charAt(cut)) && /\S/.test(p.charAt(cut - 1))) {
        var sp = p.lastIndexOf(' ', cut);
        cut = sp > 0 ? sp + 1 : cut;
      }
      var rest = p.slice(cut).replace(/^[\s.,:;\-]+/, '').trim();
      return rest ? '\u2026' + rest : '';
    }
    return p;
  }

  function parseEvent(ev, domTitle, domPreview) {
    var out = { title: domTitle || '', preview: domPreview || '', sender: '', chat: '', platform: '', senderIsOrg: false, direction: '' };
    if (!ev) return out;
    var title = String(ev.title || '');
    var text = String(ev.full_text || ev.preview || '');

    var m = title.match(/^\s*\[(Telegram|WhatsApp)\s*\|\s*([^|\]]*)\|\s*([^\]]*)\]:?\s*([\s\S]*)$/i) ||
      text.match(/^\s*\[(Telegram|WhatsApp)\s*\|\s*([^|\]]*)\|\s*([^\]]*)\]:?\s*([\s\S]*)$/i);
    if (m) {
      out.platform = m[1].toLowerCase();
      out.chat = m[2].trim();
      out.sender = m[3].trim();
      var body = (text.match(/^\s*\[[^\]]*\]:?\s*([\s\S]*)$/) || [])[1] || m[4] || '';
      out.title = body.replace(/\s+/g, ' ').trim() || out.title;
      out.preview = '';
      if (out.chat === out.sender) out.chat = '';
      return out;
    }
    m = text.match(/^\s*\[iMessage\s*\|\s*([^|\]]*)\|([^\]]*)\]\s*([\s\S]*)$/i);
    if (m) {
      out.platform = 'imessage';
      out.direction = m[1].trim().toLowerCase();
      var segs = m[2].split('|');
      for (var i = 0; i < segs.length; i++) {
        var kv = segs[i].split(':');
        var key = (kv.shift() || '').trim().toLowerCase();
        var val = kv.join(':').trim();
        if (key === 'from' && val) out.sender = val;
        if (key === 'chat' && val) out.chat = val;
      }
      if (out.direction === 'outbound' && !out.sender) out.sender = ownerName() || 'You';
      out.title = m[3].replace(/\s+/g, ' ').trim() || out.title;
      out.preview = '';
      if (out.chat === out.sender) out.chat = '';
      return out;
    }
    if (/^Email\s*\(/i.test(title) || String(ev.kind).toLowerCase() === 'email') {
      out.platform = 'email';
      var subj = title.replace(/^Email\s*\([^)]*\):\s*/i, '').trim();
      var from = text.match(/^From:\s*(.+)$/im);
      if (from) {
        var raw = from[1].trim();
        var name = raw.replace(/<[^>]*>/g, '').replace(/^["']|["']$/g, '').trim();
        var addr = (raw.match(/<([^>]+)>/) || [])[1] || (raw.indexOf('@') > -1 ? raw : '');
        out.sender = name || addr;
        out.senderIsOrg = BOT_RE.test(raw);
      }
      var bodyStart = text.split(/\n\s*\n/).slice(1).join(' ')
        .replace(/<#\/?part[^>]*>/gi, ' ')
        .replace(/<[^>]{1,200}>/g, ' ')
        .replace(/https?:\/\/([^\/\s?#]+)[^\s)]*/gi, '$1')
        .replace(/\s+/g, ' ').trim();
      out.title = subj || out.title;
      out.preview = continuation(out.title, bodyStart).slice(0, 160);
      return out;
    }
    m = title.match(/^X Bookmark by @([\w.]+)\s*(?:\(([^)]*)\))?/i);
    if (m) {
      out.platform = 'x';
      out.sender = (m[2] || '').trim() || '@' + m[1];
      out.chat = '@' + m[1];
      var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
        return l && !/^#/.test(l) && !/^(URL|Author|Date|Saved|Bookmarked|Likes|Media)\s*:/i.test(l);
      });
      if (lines[0]) out.title = lines[0].slice(0, 200);
      out.preview = '';
      return out;
    }
    /* Everything else (agent sessions, notes, dictation): line 2 carries the continuation of the text. */
    var fullTitle = out.title || title;
    out.preview = continuation(fullTitle, ev.preview || text || out.preview);
    return out;
  }

  function rowSourceId(ev) { return String((ev && (ev.connector || ev.connector_id || ev.source)) || ''); }
  function ownerName() { return (document.body && document.body.getAttribute('data-owner-name') || '').trim(); }

  /* ---------------------------------------------------------- row enhancement */
  function enhanceRow(row, ev, k) {
    var head = row.querySelector('.stream-row-head');
    if (!head) return;
    var sig = (ev ? ev.id : 'none') + '|' + (row.classList.contains('is-expanded') ? 1 : 0);
    if (head.getAttribute('data-w10s') === sig) return;

    var domTitleEl = head.querySelector('.stream-row-title');
    var domPreviewEl = head.querySelector('.stream-row-preview');
    var domTitle = domTitleEl ? domTitleEl.textContent : '';
    var domPreview = domPreviewEl ? domPreviewEl.textContent : '';
    var appPill = head.querySelector('.badge-neutral');
    var appName = appPill ? appPill.textContent.trim() : '';
    var badge = head.querySelector('.badge span');
    var built = headHtml(ev, { domTitle: domTitle, domPreview: domPreview, appName: appName, connLabel: !ev && badge ? badge.textContent : '' }, k);
    head.innerHTML = built.html;
    head.setAttribute('data-w10s', sig);
    row.classList.add('w10s-row', 'k10-tone-' + built.tone);
  }

  /* Builds the row head markup from an event; also used by the storyboard. */
  function headHtml(ev, ctx, k) {
    var c = ctx || {};
    var domTitle = c.domTitle || (ev && ev.title ? String(ev.title) : '');
    var domPreview = c.domPreview || '';
    var appName = c.appName || '';
    var conn = rowSourceId(ev);
    var connLabel = c.connLabel || (ev && ev.connector_label) || (conn ? labelFor(conn) : '');
    var parsed = parseEvent(ev, domTitle, domPreview);
    var originSource = parsed.platform && PLATFORM_SOURCE[parsed.platform] ? PLATFORM_SOURCE[parsed.platform] : conn;
    var d = parseTime(ev);
    var kind = ev ? cleanKind(ev.kind) : '';

    var owner = ownerName();
    var isOwner = !!(owner && parsed.sender && parsed.sender.toLowerCase() === owner.toLowerCase());
    if (parsed.direction === 'outbound') isOwner = true;
    var senderShown = isOwner ? 'You' : parsed.sender;
    var originTone = sourceMeta(originSource || conn).tone;
    var platformName = PLATFORM_LABEL[parsed.platform] || labelFor(originSource);
    var lead;
    if (parsed.sender) {
      /* Real names get initials, never a generated likeness; a photo is used only when the event carries one. */
      var person = { name: isOwner && owner ? owner : parsed.sender };
      if (ev && ev.avatar_url) person.avatar_url = ev.avatar_url;
      var avatarHtml = k.avatar(person, { size: 32, mode: ev && ev.avatar_url ? 'auto' : 'initials', ring: isOwner ? 'slate' : undefined });
      lead = '<span class="w10s-lead has-sender' + (isOwner ? ' is-owner' : '') + '">' + avatarHtml +
        '<span class="w10s-dot k10-tone-' + originTone + '" role="img" aria-label="' + esc(platformName) + '" title="' + esc(platformName) + '"></span></span>';
    } else {
      lead = '<span class="w10s-lead">' + monogram(originSource || conn, connLabel, 32) + '</span>';
    }

    var originLabel = originSource && originSource !== conn ? platformName : connLabel;
    var metaBits = [];
    metaBits.push('<span class="w10s-meta-src"' + (originSource !== conn && connLabel ? ' title="' + esc('Captured via ' + connLabel) + '"' : '') + '>' + esc(originLabel || 'Unknown source') + '</span>');
    if (parsed.chat && parsed.chat !== parsed.sender) {
      var chatText = parsed.platform === 'x' ? parsed.chat : (isOwner ? 'to ' : 'in ') + parsed.chat;
      metaBits.push('<span class="w10s-meta-chat k10-truncate">' + esc(chatText) + '</span>');
    }
    if (appName) metaBits.push('<span class="w10s-meta-app">' + esc(appName) + '</span>');
    if (kind && !/^(Message|Email|Event)$/i.test(kind)) metaBits.push('<span class="w10s-meta-kind">' + esc(kind) + '</span>');

    var titleText = (parsed.title || domTitle || kind || 'Event').slice(0, 200);
    var preview = continuation(titleText, parsed.preview).slice(0, 180);

    var timeHtml = d
      ? '<time class="stream-row-time w10s-time tabular" datetime="' + esc(d.toISOString()) + '" title="' + esc(d.toLocaleString('en-GB')) + '"><span class="w10s-clock">' + esc(clock(d)) + '</span><span class="w10s-rel">' + esc(relative(d)) + '</span></time>'
      : '<span class="stream-row-time w10s-time tabular"><span class="w10s-clock">--</span><span class="w10s-rel">No time</span></span>';

    var html =
      lead +
      '<span class="w10s-main">' +
      '<span class="w10s-line1">' +
      (parsed.sender ? '<strong class="w10s-sender">' + esc(senderShown) + '</strong>' : '') +
      '<span class="stream-row-title">' + esc(titleText) + '</span>' +
      '</span>' +
      '<span class="w10s-line2">' + metaBits.join('') +
      (preview ? '<span class="stream-row-preview">' + esc(preview) + '</span>' : '') +
      '</span>' +
      '</span>' +
      timeHtml +
      '<svg class="stream-row-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return { html: html, tone: originTone };
  }

  function dayHeaderHtml(g, k) {
    var lbl = g.date ? dayLabel(g.date) : { main: 'Time unavailable', sub: '' };
    var right = '<span class="w10s-day-count tabular">' + esc(k.fmt(g.shown)) + ' shown</span>' +
      (num(g.captured) ? '<span class="w10s-day-sep" aria-hidden="true"></span><span class="w10s-day-total tabular" title="Events captured that day, from the replay index">' + esc(k.fmt(g.captured)) + ' captured that day</span>' : '');
    return '<h3 class="w10s-day-title">' + esc(lbl.main) + (lbl.sub ? '<span class="w10s-day-sub">' + esc(lbl.sub) + '</span>' : '') + '</h3>' +
      '<span class="w10s-day-right">' + right + '</span>';
  }

  function enhanceList(k) {
    var r = root();
    var list = r && r.querySelector('#stream-list');
    if (!list) return;
    var rows = Array.prototype.slice.call(list.querySelectorAll(':scope > .stream-row'));
    var oldHeads = list.querySelectorAll(':scope > .w10s-day');
    if (!rows.length) {
      oldHeads.forEach(function (n) { n.remove(); });
      list.removeAttribute('data-w10s-days');
      return;
    }

    var firstMissing = -1, lastMissing = -1;
    var groups = [];
    var current = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var ev = events.get(row.getAttribute('data-stream-id') || '') || null;
      if (!ev) { if (firstMissing < 0) firstMissing = i; lastMissing = i; }
      enhanceRow(row, ev, k);
      var d = parseTime(ev);
      var key = d ? dayKey(d) : 'unknown';
      if (!current || current.key !== key) {
        current = { key: key, date: d, rows: [] };
        groups.push(current);
      }
      current.rows.push(row);
    }
    ensureRowData(firstMissing, lastMissing);

    var f = currentFilter();
    var indexByDay = {};
    if (replayIndex && f.connector === 'all' && !f.q) replayIndex.days.forEach(function (dd) { indexByDay[dd.day] = dd; });
    var anyKnown = groups.some(function (g) { return g.key !== 'unknown'; });
    var specs = anyKnown ? groups.map(function (g) {
      var idx = indexByDay[g.key];
      return { key: g.key, date: g.date, first: g.rows[0], shown: g.rows.length, captured: idx && num(idx.total_events) ? idx.total_events : null };
    }) : [];

    /* Skip the rebuild when nothing changed and every header still sits before its first row. */
    var sig = JSON.stringify(specs.map(function (s) { return [s.key, s.shown, s.captured, s.first.getAttribute('data-stream-id')]; }));
    var intact = oldHeads.length === specs.length && specs.every(function (s, j) { return oldHeads[j].nextElementSibling === s.first; });
    if (list.getAttribute('data-w10s-days') === sig && intact) return;
    oldHeads.forEach(function (n) { n.remove(); });
    specs.forEach(function (s) {
      var el = document.createElement('div');
      el.className = 'w10s-day';
      el.setAttribute('role', 'listitem');
      el.innerHTML = dayHeaderHtml({ date: s.date, shown: s.shown, captured: s.captured }, k);
      list.insertBefore(el, s.first);
    });
    list.setAttribute('data-w10s-days', sig);
  }

  /* ---------------------------------------------------------- volume series */
  function replaySeries(days) {
    if (!replayIndex) return null;
    var byDay = {};
    replayIndex.days.forEach(function (d) { byDay[d.day] = d; });
    var now = new Date();
    var vals = [];
    var labels = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now); d.setDate(now.getDate() - i);
      var rec = byDay[dayKey(d)];
      vals.push(rec && num(rec.total_events) ? rec.total_events : null);
      labels.push(d);
    }
    return { vals: vals, labels: labels };
  }

  /* Buckets the loaded events of one connector. The app loads a contiguous newest-first page, so every
     event between the oldest loaded one and the newest is present: empty buckets are real zeros. */
  function loadedSeries(list) {
    var times = list.map(parseTime).filter(Boolean).map(function (d) { return d.getTime(); });
    if (times.length < 3) return null;
    var max = Math.max.apply(null, times);
    var min = Math.min.apply(null, times);
    var span = max - min;
    var units = [[5 * 60000, '5 minutes'], [15 * 60000, '15 minutes'], [HOUR, 'hour'], [6 * HOUR, '6 hours'], [DAY, 'day'], [7 * DAY, 'week'], [30 * DAY, 'month'], [365 * DAY, 'year']];
    var unit = units[units.length - 1];
    for (var u = 0; u < units.length; u++) {
      if (Math.ceil(span / units[u][0]) + 1 <= 60) { unit = units[u]; break; }
    }
    var buckets = Math.ceil(span / unit[0]) + 1;
    var start = max - (buckets - 1) * unit[0];
    var vals = new Array(buckets).fill(0);
    var counted = 0;
    times.forEach(function (t) {
      var b = Math.floor((t - start) / unit[0]);
      if (b < 0 || b >= buckets) return;
      vals[b] += 1;
      counted += 1;
    });
    var nonZero = vals.filter(function (v) { return v > 0; }).length;
    return { vals: vals, unit: unit[1], count: counted, nonZero: nonZero, oldest: new Date(min), newest: new Date(max) };
  }

  /* Column chart. Missing values draw a dashed stub on the baseline instead of a bar, so a gap never
     reads as volume. Also used by the storyboard. */
  function columnsHtml(vals, o) {
    var opt = o || {};
    var w = 300, h = opt.height || 64;
    var n = vals.length;
    var finite = vals.filter(num);
    if (finite.length < 2) return '';
    var max = Math.max.apply(null, finite) || 1;
    var gap = n > 40 ? 1 : 2;
    var bw = (w - gap * (n - 1)) / n;
    var hi = opt.highlight != null ? opt.highlight : n - 1;
    var out = [];
    for (var i = 0; i < n; i++) {
      var x = i * (bw + gap);
      var v = vals[i];
      var t = opt.titles ? opt.titles[i] : '';
      if (!num(v)) {
        out.push('<line class="w10s-col-gap" x1="' + x.toFixed(1) + '" x2="' + (x + bw).toFixed(1) + '" y1="' + (h - 0.75) + '" y2="' + (h - 0.75) + '">' + (t ? '<title>' + esc(t) + '</title>' : '') + '</line>');
        continue;
      }
      var bh = v > 0 ? Math.max(2, (v / max) * (h - 2)) : 1;
      out.push('<rect class="w10s-col' + (i === hi ? ' is-hi' : '') + (v === 0 ? ' is-zero' : '') + '" x="' + x.toFixed(1) + '" y="' + (h - bh).toFixed(1) + '" width="' + Math.max(0.6, bw).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="' + Math.min(1.5, bw / 3).toFixed(1) + '">' + (t ? '<title>' + esc(t) + '</title>' : '') + '</rect>');
    }
    return '<svg class="w10s-cols" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opt.aria || 'Volume chart') + '">' + out.join('') + '</svg>';
  }

  function chartCardHtml(o, k) {
    var body = o.chart
      ? '<div class="w10s-chart-plot">' + o.chart + '</div>' +
        (o.axis ? '<div class="w10s-chart-axis tabular"><span>' + esc(o.axis[0]) + '</span><span>' + esc(o.axis[1]) + '</span></div>' : '')
      : '<div class="w10s-chart-empty">' + k.unavailable(o.empty || 'Unavailable') + '</div>';
    return '<section class="w10s-chart k10-tone-' + (o.tone || 'cobalt') + '" aria-label="' + esc(o.title) + '">' +
      '<header class="w10s-chart-head"><h2 class="w10s-chart-title">' + esc(o.title) + '</h2>' +
      (o.right ? '<span class="w10s-chart-right tabular">' + esc(o.right) + '</span>' : '') + '</header>' +
      body + (o.foot ? '<p class="w10s-chart-foot tabular">' + esc(o.foot) + '</p>' : '') + '</section>';
  }

  /* ---------------------------------------------------------- hero */
  function ensureShell() {
    var r = root();
    if (!r) return null;
    var layout = r.querySelector('.stream-layout');
    if (!layout) return null;
    var hero = layout.querySelector(':scope > #w10s-hero');
    if (!hero) {
      hero = document.createElement('div');
      hero.id = 'w10s-hero';
      hero.className = 'w10s-hero';
      var header = layout.querySelector(':scope > .view-header');
      if (header && header.nextSibling) layout.insertBefore(hero, header.nextSibling);
      else layout.insertBefore(hero, layout.firstChild);
    }
    var rail = layout.querySelector(':scope > #w10s-rail');
    if (!rail) {
      rail = document.createElement('aside');
      rail.id = 'w10s-rail';
      rail.className = 'w10s-rail';
      rail.setAttribute('aria-label', 'Sources');
      layout.appendChild(rail);
    }
    var toolbar = layout.querySelector(':scope > .stream-toolbar');
    if (toolbar && !toolbar.querySelector('#w10s-active')) {
      var chip = document.createElement('div');
      chip.id = 'w10s-active';
      chip.className = 'w10s-active';
      chip.setAttribute('aria-live', 'polite');
      toolbar.insertBefore(chip, toolbar.firstChild);
    }
    layout.classList.add('w10s-layout');
    return { layout: layout, hero: hero, rail: rail };
  }

  function loadedEvents() {
    var list = [];
    var r = root();
    if (r) r.querySelectorAll('#stream-list > .stream-row').forEach(function (row) {
      var ev = events.get(row.getAttribute('data-stream-id') || '');
      if (ev) list.push(ev);
    });
    return list;
  }
  function newestOf(list) {
    var best = null;
    list.forEach(function (ev) { var d = parseTime(ev); if (d && (!best || d > best)) best = d; });
    return best;
  }

  function freshSummary() {
    var live = connectors.filter(function (c) { return !isImported(c.id); });
    if (!latestBySource || !live.length) return null;
    var fresh = 0, stale = [], unknown = 0;
    live.forEach(function (c) {
      var f = freshness(c.id);
      if (f.state === 'live') fresh += 1;
      else if (f.state === 'stale') stale.push({ c: c, d: f.date });
      else unknown += 1;
    });
    stale.sort(function (a, b) { return a.d - b.d; });
    return { total: live.length, fresh: fresh, stale: stale, unknown: unknown };
  }

  function heroModel(k) {
    var f = currentFilter();
    var fresh = !!lastResponse && lastResponse.connector === f.connector && lastResponse.q === f.q;
    var list = fresh ? loadedEvents() : [];
    var total = fresh ? lastResponse.total : null;
    var sumCounts = connectors.reduce(function (s, c) { return s + (num(c.count) ? c.count : 0); }, 0);
    var m = { mode: 'all', tiles: [], chart: null, summary: [] };

    if (f.q) {
      m.mode = 'search';
      var matches = total;
      if (!num(matches) && fresh) matches = list.length ? (lastResponse.hasMore ? k.fmt(list.length) + '+' : list.length) : 0;
      var newest = newestOf(list);
      var bySrc = {};
      list.forEach(function (ev) {
        var p = parseEvent(ev, '', '');
        var src = p.platform && PLATFORM_SOURCE[p.platform] ? PLATFORM_SOURCE[p.platform] : rowSourceId(ev);
        bySrc[src] = (bySrc[src] || 0) + 1;
      });
      var srcIds = Object.keys(bySrc).sort(function (a, b) { return bySrc[b] - bySrc[a]; });
      m.ident = { kind: 'search', q: f.q, scope: f.connector === 'all' ? 'All sources' : labelFor(f.connector), conn: f.connector };
      m.tiles = [
        { label: 'Matches', value: fresh ? matches : null, sub: fresh ? (list.length ? k.fmt(list.length) + ' loaded below' : 'Nothing matched') : 'Loading', icon: 'search', tone: 'cobalt' },
        { label: 'Newest match', value: newest ? relative(newest) : null, sub: newest ? shortDate(newest) + ', ' + clock(newest) : fresh ? 'No timestamps' : 'Loading', icon: 'clock', tone: 'slate' },
      ];
      var bars = srcIds.slice(0, 4).map(function (id) {
        return { label: labelFor(id), value: bySrc[id], tone: sourceMeta(id).tone };
      });
      m.chart = {
        title: 'Matches by source',
        right: srcIds.length ? srcIds.length + (srcIds.length === 1 ? ' source' : ' sources') : '',
        html: bars.length ? '<div class="w10s-chart-bars">' + k.bars(bars) + '</div>' : '',
        empty: fresh ? 'No matches loaded' : 'Loading matches',
        foot: list.length ? 'Across the ' + k.fmt(list.length) + ' loaded results' + (srcIds.length > 4 ? ', top 4 shown' : '') : '',
        tone: 'cobalt',
      };
      m.summary = [fresh ? k.fmt(matches) + ' matches' : 'Searching', newest ? 'newest ' + relative(newest) : ''];
    } else if (f.connector !== 'all') {
      m.mode = 'source';
      var c = null;
      connectors.forEach(function (x) { if (x.id === f.connector) c = x; });
      var count = c && num(c.count) ? c.count : total;
      var share = num(count) && sumCounts > 0 ? count / sumCounts * 100 : null;
      var fr = freshness(f.connector);
      var last = fr.date || newestOf(list);
      var ls = loadedSeries(list);
      m.ident = { kind: 'source', conn: f.connector, label: labelFor(f.connector), family: familyLabel(f.connector), fresh: fr };
      m.tiles = [
        { label: 'Events', value: count, sub: share == null ? 'Share unavailable' : (share < 0.1 ? 'Under 0.1%' : (Math.round(share * 10) / 10) + '%') + ' of all events', icon: 'layers', tone: sourceMeta(f.connector).tone },
        { label: 'Last event', value: last ? relative(last) : null, sub: last ? shortDate(last) + ', ' + clock(last) : 'No timestamp', icon: 'clock', tone: fr.state === 'stale' ? 'orange' : 'slate' },
      ];
      var showSeries = ls && ls.nonZero >= 3;
      m.chart = {
        title: ls ? 'Events per ' + ls.unit : 'Volume',
        right: ls ? k.fmt(ls.count) + ' loaded' : '',
        html: showSeries ? columnsHtml(ls.vals, { aria: 'Events per ' + ls.unit + ' across the ' + ls.count + ' loaded events' }) : '',
        axis: showSeries ? [stamp(ls.oldest, ls.newest), stamp(ls.newest, ls.oldest)] : null,
        empty: fresh ? 'Too few loaded events for a trend' : 'Loading events',
        foot: showSeries ? 'Every event from ' + stamp(ls.oldest, ls.newest) + ' to ' + stamp(ls.newest, ls.oldest) + ' is loaded; load more to extend it' : '',
        tone: sourceMeta(f.connector).tone,
      };
      m.summary = [num(count) ? k.fmt(count) + ' events' : '', last ? 'last ' + relative(last) : ''];
    } else {
      var wide = replaySeries(31);
      var series = wide ? { vals: wide.vals.slice(1), labels: wide.labels.slice(1) } : null;
      var known = series ? series.vals.filter(num) : [];
      var todayRec = series ? series.vals[series.vals.length - 1] : null;
      /* Today is still in progress, so the average covers the 30 full days before it. */
      var fullDays = wide ? wide.vals.slice(0, 30).filter(num) : [];
      var avg = fullDays.length ? Math.round(fullDays.reduce(function (a, b) { return a + b; }, 0) / fullDays.length) : null;
      var evTotal = allTotal != null ? allTotal : total;
      var todayDay = null;
      if (replayIndex) replayIndex.days.forEach(function (dd) { if (dd.day === dayKey(new Date())) todayDay = dd; });
      var mix = todayDay ? [['work_count', 'build'], ['comms_count', 'messages'], ['meetings_count', 'meetings'], ['docs_count', 'docs'], ['photo_count', 'photos']]
        .filter(function (p) { return num(todayDay[p[0]]) && todayDay[p[0]] > 0; })
        .sort(function (x, y) { return todayDay[y[0]] - todayDay[x[0]]; })
        .slice(0, 3).map(function (p) { return k.fmt(todayDay[p[0]]) + ' ' + p[1]; }).join(', ') : '';
      m.tiles = [
        { label: 'Events captured', value: evTotal, sub: connectors.length ? 'Across ' + connectors.length + ' sources' : 'Loading', icon: 'pulse', tone: 'cobalt' },
        { label: 'Captured today', value: todayRec, sub: mix || (replayIndex ? (num(todayRec) ? 'No breakdown indexed' : 'Today not indexed yet') : 'Loading'), icon: 'calendar', tone: 'emerald' },
        { label: 'Daily average', value: avg, sub: fullDays.length ? (fullDays.length < 30 ? 'Over ' + fullDays.length + ' indexed full days' : 'Last 30 full days, today excluded') : (replayIndex ? 'No indexed days' : 'Loading'), icon: 'graph', tone: 'violet' },
      ];
      var peak = -1, peakIdx = -1;
      if (series) series.vals.forEach(function (v, i) { if (num(v) && v > peak) { peak = v; peakIdx = i; } });
      var titles = series ? series.vals.map(function (v, i) { return shortDate(series.labels[i]) + ': ' + (num(v) ? k.fmt(v) + ' events' : 'not indexed'); }) : null;
      m.chart = {
        title: 'Daily volume, last 30 days',
        right: known.length && known.length < 30 ? known.length + ' of 30 days indexed' : '',
        html: series && known.length >= 2 ? columnsHtml(series.vals, { titles: titles, aria: 'Events captured per day over the last 30 days; ' + known.length + ' of 30 days indexed' + (peakIdx >= 0 ? ', peak ' + peak + ' on ' + shortDate(series.labels[peakIdx]) : '') }) : '',
        axis: series ? [shortDate(series.labels[0]), 'Today'] : null,
        empty: replayIndex === null && replayFetchedAt && !replayPending ? 'Daily volume unavailable' : 'Loading daily volume',
        foot: peakIdx >= 0 ? 'Peak ' + k.fmt(peak) + ' on ' + shortDate(series.labels[peakIdx]) + (known.length < 30 ? '. Dashes mark days missing from the replay index' : '') : '',
        tone: 'cobalt',
      };
      m.summary = [num(evTotal) ? k.fmt(evTotal) + ' events' : '', connectors.length ? connectors.length + ' sources' : '', num(todayRec) ? k.fmt(todayRec) + ' today' : ''];
    }
    return m;
  }

  function identHtml(m, k) {
    var i = m.ident;
    if (i.kind === 'source') {
      var st = i.fresh.state === 'live' ? k.chip('Live', 'emerald', { dot: true })
        : i.fresh.state === 'stale' ? k.chip('Quiet ' + age(i.fresh.date), 'orange', { dot: true })
        : i.fresh.state === 'future' ? k.chip('Future-dated', 'slate', { dot: true })
        : '';
      return '<div class="w10s-ident">' + monogram(i.conn, i.label, 40, 'w10s-mono-hero') +
        '<div class="w10s-ident-text"><span class="w10s-ident-eyebrow">' + esc(i.family) + '</span>' +
        '<h2 class="w10s-ident-title k10-truncate">' + esc(i.label) + '</h2>' +
        '<span class="w10s-ident-row">' + st + '<button type="button" class="w10s-link" data-w10s-conn="all">All sources</button></span></div></div>';
    }
    return '<div class="w10s-ident"><span class="w10s-ident-ic" aria-hidden="true">' + k.icon('search', 18) + '</span>' +
      '<div class="w10s-ident-text"><span class="w10s-ident-eyebrow">Search in ' + esc(i.scope) + '</span>' +
      '<h2 class="w10s-ident-title k10-truncate">“' + esc(i.q) + '”</h2>' +
      '<span class="w10s-ident-row"><span class="w10s-ident-note">Ranked by relevance</span></span></div></div>';
  }

  function renderHero(shell, k) {
    var m = heroModel(k);
    var tiles = m.tiles.map(function (t) { return k.statTile(t); }).join('');
    var chart = m.chart ? chartCardHtml({ title: m.chart.title, right: m.chart.right, chart: m.chart.html, axis: m.chart.axis, empty: m.chart.empty, foot: m.chart.foot, tone: m.chart.tone }, k) : '';
    var summary = m.summary.filter(Boolean);
    var html = '<div class="w10s-hero-grid is-' + m.mode + '">' + (m.ident ? identHtml(m, k) : '') + tiles + chart + '</div>' +
      '<p class="w10s-summary tabular">' + (summary.length ? summary.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') : '<span>Loading</span>') + '</p>';
    if (shell.hero.getAttribute('data-sig') === html) return;
    shell.hero.setAttribute('data-sig', html);
    shell.hero.innerHTML = html;
  }

  /* ---------------------------------------------------------- sources rail */
  function sourceButtonHtml(c, o, k) {
    var opt = o || {};
    var active = !!opt.active;
    var max = opt.max || 0;
    var sum = opt.sum || 0;
    var hasCount = num(c.count);
    var pct = hasCount && max > 0 ? Math.max(1.5, (c.count / max) * 100) : 0;
    var share = hasCount && sum > 0 ? (c.count / sum) * 100 : null;
    var shareTxt = share == null ? 'Share unavailable' : share < 0.1 ? 'Under 0.1%' : (Math.round(share * 10) / 10) + '%';
    var label = c.label || labelFor(c.id);
    var fr = opt.fresh || freshness(c.id);
    var ageTxt = fr.state === 'live' || fr.state === 'stale' ? (age(fr.date) ? age(fr.date) + ' ago' : 'just now')
      : fr.state === 'future' ? 'Future-dated' : '';
    var title = label + ': ' + (hasCount ? k.fmt(c.count) + ' events, ' + shareTxt + ' of all' : 'count unavailable') +
      (fr.date ? '. Last event ' + fr.date.toLocaleString('en-GB') : '') + (fr.state === 'stale' ? ' (quiet for over 24 hours)' : '');
    return '<button type="button" class="w10s-src k10-tone-' + sourceMeta(c.id, label).tone + (active ? ' is-active' : '') + (hasCount ? '' : ' is-empty') + (fr.state === 'stale' ? ' is-stale' : '') + '" data-w10s-conn="' + esc(c.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" title="' + esc(title) + '">' +
      monogram(c.id, label, 26) +
      '<span class="w10s-src-main"><span class="w10s-src-label k10-truncate">' + esc(label) + '</span>' +
      '<span class="w10s-src-bar" aria-hidden="true"><span style="width:' + pct.toFixed(1) + '%"></span></span></span>' +
      '<span class="w10s-src-num"><span class="w10s-src-count tabular">' + esc(k.fmt(hasCount ? c.count : null)) + '</span>' +
      '<span class="w10s-src-age tabular' + (fr.state === 'stale' ? ' k10-tone-orange' : '') + '">' + (fr.state === 'stale' ? '<span class="w10s-stale-dot" aria-hidden="true"></span>' : '') + esc(ageTxt || shareTxt) + '</span></span>' +
      '</button>';
  }

  function renderRail(shell, k) {
    var f = currentFilter();
    var sorted = connectors.slice().sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
    var live = sorted.filter(function (c) { return !isImported(c.id); });
    var imported = sorted.filter(function (c) { return isImported(c.id); });
    var sum = sorted.reduce(function (s, c) { return s + (num(c.count) ? c.count : 0); }, 0);
    var max = sorted.reduce(function (m, c) { return Math.max(m, num(c.count) ? c.count : 0); }, 0);
    var LIMIT = 8;
    var hidden = Math.max(0, live.length - LIMIT);
    var narrow = !!(window.matchMedia && window.matchMedia(NARROW_MQ).matches);
    var expanded = railExpanded || narrow;
    var shownLive = expanded ? live : live.slice(0, LIMIT);
    if (!expanded && f.connector !== 'all' && !isImported(f.connector) && !shownLive.some(function (c) { return c.id === f.connector; })) {
      live.forEach(function (c) { if (c.id === f.connector) shownLive.push(c); });
    }
    var freshKey = latestBySource ? sorted.map(function (c) { var fr = freshness(c.id); return fr.state + (fr.date ? age(fr.date) : ''); }).join(',') : '';
    var sig = JSON.stringify([f.connector, expanded, narrow, sorted.map(function (c) { return c.id + ':' + c.count; }), freshKey]);
    var focused = document.activeElement && shell.rail.contains(document.activeElement) ? document.activeElement : null;
    var focusId = focused ? focused.getAttribute('data-w10s-conn') || (focused.hasAttribute('data-w10s-more') ? '__more' : '') : '';

    if (shell.rail.getAttribute('data-sig') === sig) return;
    shell.rail.setAttribute('data-sig', sig);

    if (!sorted.length) {
      shell.rail.innerHTML = '<div class="w10s-rail-head"><h2 class="w10s-rail-title">Sources</h2></div>' +
        k.emptyState({ title: 'Sources loading', body: 'Connector counts appear once the stream responds.', icon: 'layers', compact: true });
      return;
    }

    function item(c) { return sourceButtonHtml(c, { active: f.connector === c.id, max: max, sum: sum }, k); }
    var allActive = f.connector === 'all';
    var fs = freshSummary();
    var allBtn = '<button type="button" class="w10s-src w10s-src-all k10-tone-slate' + (allActive ? ' is-active' : '') + '" data-w10s-conn="all" aria-pressed="' + (allActive ? 'true' : 'false') + '">' +
      '<span class="w10s-mono w10s-mono-all k10-tone-slate" style="--w10s-mono:26px" aria-hidden="true">' + k.icon('layers', 13) + '</span>' +
      '<span class="w10s-src-main"><span class="w10s-src-label">All sources</span></span>' +
      '<span class="w10s-src-num"><span class="w10s-src-count tabular">' + esc(k.fmt(sum || null)) + '</span><span class="w10s-src-age tabular">' + esc(sorted.length + ' sources') + '</span></span>' +
      '</button>';

    var sub = fs && fs.stale.length ? fs.stale.length + (fs.stale.length === 1 ? ' source' : ' sources') + ' quiet for over 24h' : 'Events and last activity per connector';
    shell.rail.innerHTML =
      '<div class="w10s-rail-head"><h2 class="w10s-rail-title">Sources</h2><span class="w10s-rail-sub tabular">' + esc(sub) + '</span></div>' +
      '<div class="w10s-rail-list" role="group" aria-label="Filter stream by source">' + allBtn + shownLive.map(item).join('') +
      (imported.length ? '<div class="w10s-rail-group" role="presentation"><span>Imported archives</span></div>' + imported.map(item).join('') : '') +
      '</div>' +
      (hidden && !narrow ? '<button type="button" class="w10s-rail-more" data-w10s-more aria-expanded="' + (railExpanded ? 'true' : 'false') + '">' + (railExpanded ? 'Show fewer sources' : 'Show ' + hidden + ' more live sources') + '</button>' : '');

    var strip = shell.rail.querySelector('.w10s-rail-list');
    var activeBtn = strip && strip.querySelector('.w10s-src.is-active');
    if (strip && activeBtn && strip.scrollWidth > strip.clientWidth + 1) {
      strip.scrollLeft = Math.max(0, activeBtn.offsetLeft - strip.offsetLeft - 12);
    }
    if (focusId) {
      var target = focusId === '__more' ? shell.rail.querySelector('[data-w10s-more]')
        : shell.rail.querySelector('[data-w10s-conn="' + (window.CSS && CSS.escape ? CSS.escape(focusId) : focusId) + '"]');
      if (target) target.focus({ preventScroll: true });
    }
  }

  function renderActiveChip(k) {
    var el = root() && root().querySelector('#w10s-active');
    if (!el) return;
    var f = currentFilter();
    var html = '';
    if (f.connector !== 'all') {
      html = '<span class="w10s-active-label">Showing</span>' +
        '<span class="w10s-active-chip">' + monogram(f.connector, labelFor(f.connector), 20) + '<span>' + esc(labelFor(f.connector)) + '</span>' +
        '<button type="button" class="w10s-active-clear" data-w10s-conn="all" aria-label="Clear source filter, show all sources">' +
        '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>';
    } else {
      var n = connectors.length;
      html = '<span class="w10s-active-label">' + (f.q ? 'Matches across all ' : 'Showing all ') + (n ? esc(k.fmt(n)) + ' ' : '') + 'sources' + (f.q ? '' : ', newest first') + '</span>';
    }
    if (el.getAttribute('data-sig') !== html) {
      el.setAttribute('data-sig', html);
      el.innerHTML = html;
    }
  }

  /* ---------------------------------------------------------- render loop */
  function apply() {
    scheduled = 0;
    var k = K();
    if (!k || !isActive()) return;
    var shell = ensureShell();
    if (!shell) return;
    if (!replayIndex && !replayPending && Date.now() - replayFetchedAt > 120000) loadReplayIndex();
    if (connectors.length) ensureOverview();
    applying = true;
    try {
      renderHero(shell, k);
      renderRail(shell, k);
      renderActiveChip(k);
      enhanceList(k);
    } catch (err) {
      if (window.console && console.warn) console.warn('[w10 stream]', err);
    } finally {
      if (listObserver) listObserver.takeRecords();
      applying = false;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(apply);
  }

  function onClick(e) {
    var r = root();
    if (!r || !r.contains(e.target)) return;
    var more = e.target.closest('[data-w10s-more]');
    if (more) {
      railExpanded = !railExpanded;
      schedule();
      return;
    }
    var btn = e.target.closest('[data-w10s-conn]');
    if (!btn) return;
    var id = btn.getAttribute('data-w10s-conn');
    var pills = r.querySelectorAll('#stream-connectors [data-stream-conn]');
    for (var i = 0; i < pills.length; i++) {
      if (pills[i].getAttribute('data-stream-conn') === id) {
        pills[i].click();
        break;
      }
    }
    if (!btn.closest('#w10s-rail')) {
      var all = r.querySelector('.w10s-src-all');
      if (all) all.focus({ preventScroll: true });
    }
  }

  function boot() {
    var r = root();
    if (!r) return;
    document.addEventListener('click', onClick);
    listObserver = new MutationObserver(function () { if (!applying) schedule(); });
    var list = r.querySelector('#stream-list');
    if (list) listObserver.observe(list, { childList: true });
    var pills = r.querySelector('#stream-connectors');
    if (pills) listObserver.observe(pills, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    var count = r.querySelector('#stream-count');
    if (count) listObserver.observe(count, { childList: true, characterData: true, subtree: true });
    new MutationObserver(function () { if (isActive()) schedule(); }).observe(r, { attributes: true, attributeFilter: ['hidden'] });
    if (window.matchMedia) {
      var mq = window.matchMedia(NARROW_MQ);
      var onMq = function () { if (isActive()) schedule(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
    if (isActive()) schedule();
  }

  window.KizukiStreamW10 = {
    monogram: monogram,
    sourceMeta: sourceMeta,
    parseEvent: parseEvent,
    headHtml: function (ev, ctx) { return headHtml(ev, ctx, K()).html; },
    dayHeaderHtml: function (g) { return dayHeaderHtml(g, K()); },
    sourceButtonHtml: function (c, o) { return sourceButtonHtml(c, o, K()); },
    columnsHtml: columnsHtml,
    chartCardHtml: function (o) { return chartCardHtml(o, K()); },
    loadedSeries: loadedSeries,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
