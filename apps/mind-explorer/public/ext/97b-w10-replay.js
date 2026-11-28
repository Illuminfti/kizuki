/* Kizuki Wave 10: Life Replay depth layer.
   Adds a day hero with a signature drawn from the day's own timestamps, day KPI plates, an
   hour-by-hour day shape, people / build / agenda cards, and icon decoration on the existing
   rail and tab panel. Every value comes from GET /api/replay/day (the same request app.js
   just made, so the hyper cache serves it) or from attributes app.js already rendered.
   Nothing is invented: a field missing from the day packet renders as '--' or "Not in this
   day packet", which is kept distinct from a real empty list.

   Units, used the same way everywhere:
   - session: one work item (a Claude Code / Codex / Antigravity conversation on this day).
     Its `time` is its first step, so hourly charts count sessions *started* per hour.
   - step: one captured event inside a session (work[].count).
   - message: one comms item, timed exactly. */
(function initKizukiReplayW10() {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__w10ReplayInit) return;
  window.__w10ReplayInit = true;

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CACHE_MAX = 5;
  const dayCache = new Map();
  const inflight = new Map();
  let renderedDay = null;
  let renderTok = 0;
  let peopleExpanded = false;
  let peopleExpandedDay = null;
  let scheduled = 0;
  let observed = false;

  /* Only Build and Message carry colour in the timeline; the rest stay neutral. */
  const KIND = {
    work: { icon: 'bolt', tone: 'cobalt', label: 'Build' },
    comms: { icon: 'chat', tone: 'violet', label: 'Message' },
    meeting: { icon: 'calendar', tone: 'slate', label: 'Meeting' },
    doc: { icon: 'doc', tone: 'slate', label: 'Note' },
    place: { icon: 'map', tone: 'slate', label: 'Place' },
    health: { icon: 'pulse', tone: 'slate', label: 'Body' },
  };
  const CHANNEL = {
    telegram: 'Telegram', gmail: 'Gmail', whatsapp: 'WhatsApp', imessage: 'iMessage',
    slack: 'Slack', discord: 'Discord', sms: 'SMS', email: 'Email', calendar: 'Calendar', x: 'X',
  };
  const SOURCE = {
    'antigravity-neon': 'Antigravity', 'claude-code': 'Claude Code', codex: 'Codex',
  };
  const CHAT_CHANNELS = new Set(['telegram', 'whatsapp', 'imessage', 'sms', 'slack', 'discord']);
  /* Senders that are software, not people. Matched on the display name or the address key. */
  const AUTO_NAME = /\[bot\]$|(^|\s)bot$|\b(no-?reply|notifications?|newsletters?|receipts?|alerts?|digest|mailer)\b/i;
  const AUTO_KEY = /(^|-)(no-?reply|notifications?|newsletters?|alerts?|receipts?|digest|mailer|marketing|info|news|updates)(-|$)|substack-com|-bot$/;

  const kit = () => window.KizukiKit || null;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const has = (d, k) => Boolean(d) && Array.isArray(d[k]);
  const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
  const clean = (s) => String(s == null ? '' : s).replace(/\s*—\s*/g, ' - ').replace(/\s+/g, ' ').trim();
  const channelName = (c) => CHANNEL[String(c || '').toLowerCase()] || clean(c) || 'Other';
  const n0 = (n) => Number(n).toLocaleString('en-GB');
  const plural = (n, one, many) => n0(n) + ' ' + (Number(n) === 1 ? one : many);
  const pad2 = (h) => String(h).padStart(2, '0');
  const MISSING = 'Not in this day packet';
  /* Same rule as replay-api.ts slugify(), so client keys match person keys. */
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';

  /* Same parsing app.js uses (extractReplayHhmm) so hours line up with the timeline. */
  function hhmm(iso) {
    const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
    return m ? m[1] + ':' + m[2] : '';
  }
  function hourFloat(iso) {
    const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  }
  function durLabel(mins) {
    if (!isNum(mins) || mins <= 0) return '';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm';
  }
  function fullDate(day) {
    if (!DAY_RE.test(day || '')) return day || '';
    const d = new Date(day + 'T12:00:00Z');
    try {
      return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(',', '');
    } catch (_) {
      return day;
    }
  }
  function placePhrase(label) {
    const s = clean(label);
    const m = s.match(/^GPS\s*\(([-\d.]+),\s*([-\d.]+)\)$/i);
    return m ? 'Near ' + m[1] + ', ' + m[2] : s;
  }
  function emailName(e) {
    const s = String(e || '').trim();
    const named = s.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
    if (named) return clean(named[1]);
    if (!s.includes('@')) return clean(s);
    const local = s.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+$/, '').trim();
    return local.replace(/\b\w/g, (c) => c.toUpperCase()) || s;
  }
  function listNames(names, max) {
    const shown = names.slice(0, max);
    const rest = names.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ' and ' + plural(rest, 'other', 'others') : '');
  }

  /* ------------------------------------------------------------ data */
  function currentDay() {
    try {
      const p = new URLSearchParams(window.location.search).get('day');
      if (p && DAY_RE.test(p)) return p;
    } catch (_) { /* ignore */ }
    const row = $('#replay-days-list .replay-day-row.is-selected');
    const d = row && row.getAttribute('data-replay-day');
    return d && DAY_RE.test(d) ? d : null;
  }

  /* app.js keeps its day cache in a private closure, so this re-reads the same URL. The hyper
     cache answers it; this module keeps only the last few packets. */
  function getDay(day) {
    if (dayCache.has(day)) return Promise.resolve(dayCache.get(day));
    if (inflight.has(day)) return inflight.get(day);
    const p = fetch('/api/replay/day?day=' + encodeURIComponent(day), { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        inflight.delete(day);
        if (data && data.day === day) {
          dayCache.delete(day);
          dayCache.set(day, data);
          while (dayCache.size > CACHE_MAX) dayCache.delete(dayCache.keys().next().value);
        }
        return data;
      });
    inflight.set(day, p);
    return p;
  }

  /* One per item at the hour of its timestamp. For work this is sessions started, never steps:
     a session's steps can run for hours after its first timestamp. */
  function hourly(list) {
    if (!list) return null;
    const out = new Array(24).fill(0);
    let any = false;
    for (const it of list) {
      const h = hourFloat(it && it.time);
      if (h === null) continue;
      out[Math.min(23, Math.floor(h))] += 1;
      any = true;
    }
    return any ? out : null;
  }

  function classifyPeople(d) {
    const people = arr(d.people);
    const keys = new Set(people.map((p) => p.key));
    const direct = new Map();
    const threads = new Map();
    for (const c of arr(d.comms)) {
      const ch = String(c.channel || '').toLowerCase();
      if (!CHAT_CHANNELS.has(ch)) continue;
      const title = clean(c.thread_title);
      const id = ch + '|' + title;
      const t = threads.get(id) || { id, title, channel: ch, count: 0, senders: new Map(), mine: 0 };
      t.count += 1;
      const sender = clean(c.sender);
      const sk = slug(sender);
      if (sender && keys.has(sk)) t.senders.set(sk, sender);
      else t.mine += 1;
      threads.set(id, t);
    }
    const groups = [];
    threads.forEach((t) => {
      const others = Array.from(t.senders.keys());
      const tk = slug(t.title);
      /* A 1:1-shaped thread: titled after its only counterpart, or only you wrote in a thread
         titled after a person. Anything else is a group or channel. */
      const isDirect = t.title && ((others.length === 1 && others[0] === tk) || (others.length === 0 && keys.has(tk)));
      if (isDirect) {
        const prev = direct.get(tk) || { mine: 0, theirs: 0 };
        prev.mine += t.mine;
        prev.theirs += t.count - t.mine;
        direct.set(tk, prev);
      }
      else groups.push({ title: t.title || 'Untitled thread', channel: t.channel, count: t.count, members: Array.from(t.senders.values()) });
    });
    groups.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

    const out = { direct: [], email: [], groupOnly: [], automated: [], groups };
    for (const p of people) {
      const name = clean(p.name);
      const key = String(p.key || '');
      const chans = arr(p.channels).map((c) => String(c).toLowerCase());
      if (!/\p{L}/u.test(name) || AUTO_NAME.test(name) || AUTO_KEY.test(key)) { out.automated.push(p); continue; }
      if (direct.has(key) || chans.includes('calendar')) {
        const f = direct.get(key);
        /* flow: who wrote in the 1:1 thread, read from senders; calendar-only people have none. */
        out.direct.push(Object.assign({}, p, { flow: f ? (f.mine && f.theirs ? 'two-way' : f.mine ? 'sent only' : 'received only') : '' }));
      }
      else if (chans.length && chans.every((c) => c === 'gmail' || c === 'email')) out.email.push(p);
      else out.groupOnly.push(p);
    }
    const byCount = (a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || clean(a.name).localeCompare(clean(b.name));
    /* Two-way conversations first, then by volume. */
    const rank = (p) => (p.flow === 'two-way' ? 0 : p.flow === '' ? 1 : 2);
    out.direct.sort((a, b) => rank(a) - rank(b) || byCount(a, b));
    out.email.sort(byCount);
    out.groupOnly.sort(byCount);
    return out;
  }

  function derive(d) {
    d = d || {};
    const s = d.summary || {};
    const work = arr(d.work);
    const comms = arr(d.comms);
    const meetings = arr(d.meetings);
    const places = arr(d.places);
    const workH = has(d, 'work') ? hourly(work) : null;
    const commsH = has(d, 'comms') ? hourly(comms) : null;
    const meetH = has(d, 'meetings') ? hourly(meetings) : null;
    /* First and last are real timestamps of something that happened. */
    const times = []
      .concat(work.map((w) => w.time), comms.map((c) => c.time), meetings.map((m) => m.time), places.map((p) => p.time), arr(d.docs).map((x) => x.time))
      .map((t) => ({ t, h: hourFloat(t) }))
      .filter((x) => x.h !== null)
      .sort((a, b) => a.h - b.h);
    const first = times.length ? hhmm(times[0].t) : '';
    const last = times.length ? hhmm(times[times.length - 1].t) : '';
    /* Peak hour: the hour with the most timed starts (sessions started + messages + meetings
       starting). Every part is reported next to it so the number is never ambiguous. */
    let peak = null;
    if (workH || commsH || meetH) {
      for (let h = 0; h < 24; h++) {
        const a = workH ? workH[h] : 0;
        const b = commsH ? commsH[h] : 0;
        const c = meetH ? meetH[h] : 0;
        const v = a + b + c;
        if (v > 0 && (!peak || v > peak.value)) peak = { hour: h, value: v, sessions: a, messages: b, meetings: c };
      }
    }
    let bookedMins = 0;
    const spans = [];
    for (const m of meetings) {
      const a = hourFloat(m.time);
      const b = hourFloat(m.end_time);
      if (a !== null && b !== null && b > a) spans.push([a, b]);
    }
    /* Booked time is the union of meeting spans, so overlapping events are not double counted. */
    spans.sort((p, q) => p[0] - q[0]);
    let cur = null;
    for (const sp of spans) {
      if (!cur || sp[0] > cur[1]) { if (cur) bookedMins += (cur[1] - cur[0]) * 60; cur = sp.slice(); } else cur[1] = Math.max(cur[1], sp[1]);
    }
    if (cur) bookedMins += (cur[1] - cur[0]) * 60;

    const projects = new Map();
    const sources = new Map();
    let steps = 0;
    for (const w of work) {
      const k = clean(w.project) || 'Unlabelled';
      const n = isNum(w.count) && Number(w.count) > 0 ? Number(w.count) : 1;
      const e = projects.get(k) || { name: k, steps: 0, sessions: 0 };
      e.steps += n;
      e.sessions += 1;
      projects.set(k, e);
      const src = SOURCE[String(w.source || '').toLowerCase()] || clean(w.source) || 'Other';
      sources.set(src, (sources.get(src) || 0) + 1);
      steps += n;
    }
    const channels = new Map();
    for (const c of comms) {
      const k = channelName(c.channel);
      channels.set(k, (channels.get(k) || 0) + 1);
    }
    const sessionsCount = isNum(s.work_sessions) ? Number(s.work_sessions) : has(d, 'work') ? work.length : null;
    return {
      s, work, comms, meetings, places, workH, commsH, first, last, peak, bookedMins,
      steps: has(d, 'work') ? steps : null,
      sessionsCount,
      projects: Array.from(projects.values()).sort((a, b) => b.steps - a.steps),
      sources: Array.from(sources.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      channels: Array.from(channels.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      who: classifyPeople(d),
      firstMeeting: meetings.map((m) => hhmm(m.time)).filter(Boolean).sort()[0] || '',
    };
  }

  /* ------------------------------------------------------------ builders */
  /* The day signature: sessions started and messages per half hour, drawn as one quiet
     cobalt contour with meeting spans as bands. It is the day's own shape, not decoration. */
  function signatureSvg(x) {
    const W = 720;
    const H = 180;
    const bins = new Array(48).fill(0);
    let any = false;
    const add = (list) => list.forEach((it) => {
      const h = hourFloat(it && it.time);
      if (h === null) return;
      bins[Math.min(47, Math.floor(h * 2))] += 1;
      any = true;
    });
    add(x.work);
    add(x.comms);
    const bands = x.meetings
      .map((m) => ({ a: hourFloat(m.time), b: hourFloat(m.end_time) }))
      .filter((o) => o.a !== null)
      .map((o) => {
        const b = o.b !== null && o.b > o.a ? o.b : Math.min(24, o.a + 0.5);
        return '<rect class="w10r-sig-band" x="' + ((o.a / 24) * W).toFixed(1) + '" y="0" width="' + (((b - o.a) / 24) * W).toFixed(1) + '" height="' + H + '"/>';
      })
      .join('');
    const ticks = [6, 12, 18].map((h) => '<path class="w10r-sig-tick" d="M' + ((h / 24) * W).toFixed(1) + ' 0V' + H + '"/>').join('');
    let line = '';
    if (any) {
      /* Square-root scale keeps a few long bursts from flattening the rest of the day. */
      const max = Math.sqrt(Math.max(...bins));
      const pts = bins.map((v, i) => [((i + 0.5) / 48) * W, H - 14 - (max > 0 ? Math.sqrt(v) / max : 0) * (H - 44)]);
      let path = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const mx = (p0[0] + p1[0]) / 2;
        path += ' C' + mx.toFixed(1) + ' ' + p0[1].toFixed(1) + ' ' + mx.toFixed(1) + ' ' + p1[1].toFixed(1) + ' ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
      }
      const lastX = pts[pts.length - 1][0].toFixed(1);
      line = '<path class="w10r-sig-area" d="' + path + ' L' + lastX + ' ' + H + ' L' + pts[0][0].toFixed(1) + ' ' + H + ' Z"/><path class="w10r-sig-line" d="' + path + '"/>';
    }
    if (!line && !bands) return '';
    return '<svg class="w10r-sig-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" focusable="false">' + ticks + bands + line + '</svg>';
  }

  function heroHtml(d, x) {
    const K = kit();
    const s = x.s;
    const facts = [];
    const loc = s.primary_location || (x.places[0] && x.places[0].label);
    if (loc) facts.push(['map', placePhrase(loc), 'Primary place']);
    if (x.first && x.last) facts.push(['clock', x.first === x.last ? 'Active at ' + x.first : x.first + ' to ' + x.last, 'First and last timestamped activity']);
    if (x.peak) facts.push(['pulse', 'Peak hour ' + pad2(x.peak.hour) + ':00', 'Most sessions started, messages and meetings begun in one hour']);
    const anyTimedField = has(d, 'work') || has(d, 'comms') || has(d, 'meetings') || has(d, 'places');
    const factsHtml = facts.length
      ? '<ul class="w10r-hero-facts">' + facts.map((f) =>
          '<li title="' + K.esc(f[2]) + '"><span class="w10r-hero-fic" aria-hidden="true">' + K.icon(f[0], 13) + '</span>' + K.esc(f[1]) + '</li>').join('') + '</ul>'
      : '<p class="k10-banner-sub">' + K.esc(anyTimedField ? 'No timed activity recorded for this day' : 'Activity detail is not in this day packet') + '</p>';
    const direct = x.who.direct;
    let right = '';
    if (has(d, 'people')) {
      right = direct.length
        ? '<div class="w10r-hero-people">' +
            K.avatarStack(direct.map((p) => ({ name: clean(p.name), key: p.key })), { max: 5, size: 28, mode: 'initials' }) +
            '<span class="w10r-hero-people-label">' + K.esc(plural(direct.length, 'person', 'people')) + ' in direct touch</span>' +
          '</div>'
        : '<div class="w10r-hero-people"><span class="w10r-hero-people-label">No direct conversations</span></div>';
    }
    return '<section class="k10-banner k10-tone-cobalt w10r-hero-banner" aria-label="Day overview">' +
      '<div class="w10r-sig" aria-hidden="true">' + signatureSvg(x) + '</div>' +
      '<div class="k10-banner-body">' +
        '<div class="k10-banner-text"><div class="k10-banner-title">' + K.esc(fullDate(d.day)) + '</div>' + factsHtml + '</div>' +
        (right ? '<div class="k10-banner-right">' + right + '</div>' : '') +
      '</div>' +
    '</section>';
  }

  function kpisHtml(d, x) {
    const K = kit();
    const s = x.s;
    const w = d.whoop || null;
    const count = (sumKey, listKey) => (isNum(s[sumKey]) ? Number(s[sumKey]) : has(d, listKey) ? d[listKey].length : null);

    let buildSub;
    if (!has(d, 'work')) buildSub = MISSING;
    else if (!x.work.length) buildSub = 'No sessions captured';
    else buildSub = plural(x.steps, 'step', 'steps') + ' · ' + plural(x.projects.length, 'project', 'projects');

    let msgSub;
    if (!has(d, 'comms')) msgSub = MISSING;
    else if (!x.comms.length) msgSub = 'No messages captured';
    else msgSub = x.channels.slice(0, 2).map((c) => c.name).join(', ') + (x.channels.length > 2 ? ' +' + (x.channels.length - 2) : '');

    let meetSub;
    if (!has(d, 'meetings')) meetSub = MISSING;
    else if (!x.meetings.length) meetSub = 'Nothing on the calendar';
    else meetSub = [durLabel(x.bookedMins) ? durLabel(x.bookedMins) + ' booked' : '', x.firstMeeting ? 'first ' + x.firstMeeting : ''].filter(Boolean).join(' · ') || 'Times not recorded';

    let noteSub;
    const claims = isNum(s.claims_count) ? Number(s.claims_count) : has(d, 'claims') ? d.claims.length : null;
    if (claims === null) noteSub = 'Claims ' + MISSING.toLowerCase();
    else noteSub = claims > 0 ? plural(claims, 'claim', 'claims') + ' captured' : 'No claims captured';

    const recovery = w && isNum(w.recovery_pct) ? Number(w.recovery_pct) : null;
    const bodyParts = [];
    if (w && isNum(w.sleep_hours)) bodyParts.push(Number(w.sleep_hours).toFixed(1).replace(/\.0$/, '') + 'h sleep');
    if (w && isNum(w.hrv_ms)) bodyParts.push(Math.round(w.hrv_ms) + 'ms HRV');
    else if (w && isNum(w.rhr_bpm)) bodyParts.push(Math.round(w.rhr_bpm) + ' bpm resting');
    const bodyTone = recovery === null ? 'slate' : recovery >= 67 ? 'emerald' : recovery >= 34 ? 'orange' : 'rose';
    const noWhoop = !w;

    const tiles = [
      K.statTile({
        label: 'Build sessions', icon: 'bolt', tone: 'cobalt',
        value: x.sessionsCount, sub: buildSub,
        spark: x.workH ? K.sparkline(x.workH, { width: 132, height: 28, tone: 'cobalt', min: 0, aria: 'Build sessions started per hour' }) : '',
      }),
      K.statTile({
        label: 'Messages', icon: 'chat', tone: 'violet',
        value: count('messages_count', 'comms'), sub: msgSub,
        spark: x.commsH ? K.sparkline(x.commsH, { width: 132, height: 28, tone: 'violet', min: 0, aria: 'Messages per hour' }) : '',
      }),
      K.statTile({ label: 'Meetings', icon: 'calendar', tone: 'orange', value: count('meetings_count', 'meetings'), sub: meetSub }),
      K.statTile({ label: 'Notes touched', icon: 'doc', tone: 'emerald', value: count('docs_count', 'docs'), sub: noteSub }),
      K.statTile({
        label: 'Recovery', icon: 'pulse', tone: bodyTone,
        value: recovery, unit: recovery === null ? '' : '%',
        sub: noWhoop ? 'No Whoop data' : (bodyParts.join(' · ') || 'No recovery score'),
      }).replace('class="k10-stat ', 'class="k10-stat' + (noWhoop ? ' w10r-kpi-quiet' : '') + ' '),
    ];
    return '<div class="w10r-kpis' + (noWhoop ? ' has-quiet' : '') + '" role="group" aria-label="Day totals">' + tiles.join('') + '</div>';
  }

  function laneCells(series, tone, unit) {
    const max = series ? Math.max(...series) : 0;
    let cells = '';
    for (let h = 0; h < 24; h++) {
      const v = series ? series[h] : 0;
      const pct = max > 0 ? Math.max(v > 0 ? 8 : 0, Math.round((v / max) * 100)) : 0;
      cells += '<span class="w10r-cell' + (v > 0 ? ' has-v' : '') + '" style="--h:' + pct + '%" title="' +
        pad2(h) + ':00 · ' + n0(v) + ' ' + unit + '"></span>';
    }
    return '<div class="w10r-lane-track is-cols k10-tone-' + tone + '">' + cells + '</div>';
  }

  function shapeHtml(d, x) {
    const K = kit();
    const fields = ['work', 'comms', 'meetings', 'places'];
    if (!fields.some((f) => has(d, f))) {
      return K.card({
        title: 'Day shape',
        body: K.emptyState({ title: 'Unavailable', body: 'This day packet has no timed fields.', icon: 'clock', compact: true }),
      });
    }
    const anything = x.workH || x.commsH || x.meetings.length || x.places.length;
    if (!anything) {
      return K.card({
        title: 'Day shape',
        body: K.emptyState({ title: 'No timed activity', body: 'Nothing with a timestamp was captured for this day.', icon: 'clock', compact: true }),
      });
    }
    const total = (a) => (a ? a.reduce((p, c) => p + c, 0) : 0);
    // Meetings: greedy lane packing so overlapping calendar blocks stay readable.
    const lanesEnd = [];
    const blocks = x.meetings
      .map((m) => ({ m, a: hourFloat(m.time), b: hourFloat(m.end_time) }))
      .filter((o) => o.a !== null)
      .sort((p, q) => p.a - q.a)
      .map((o) => {
        const end = o.b !== null && o.b > o.a ? o.b : Math.min(24, o.a + 0.5);
        let lane = lanesEnd.findIndex((e) => e <= o.a + 1e-6);
        if (lane === -1) { lane = lanesEnd.length; lanesEnd.push(end); } else lanesEnd[lane] = end;
        return { ...o, end, lane };
      });
    const laneCount = Math.max(1, Math.min(3, lanesEnd.length));
    const hiddenBlocks = blocks.filter((o) => o.lane >= 3).length;
    const meetBlocks = blocks
      .filter((o) => o.lane < 3)
      .map((o) => {
        const left = (o.a / 24) * 100;
        const width = Math.max(0.8, ((o.end - o.a) / 24) * 100);
        const t = clean(o.m.title) || 'Untitled';
        /* CSS hides the text in blocks too narrow for a word; the agenda lists every title. */
        const label = '<span class="w10r-block-t">' + K.esc(t) + '</span>';
        return '<span class="w10r-block" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;top:calc(' + o.lane + ' * var(--w10r-lane-h))" title="' +
          K.esc(hhmm(o.m.time) + (o.m.end_time ? '-' + hhmm(o.m.end_time) : '') + ' ' + t) + '">' + label + '</span>';
      })
      .join('');
    const pins = x.places
      .map((p) => ({ p, h: hourFloat(p.time) }))
      .filter((o) => o.h !== null)
      .map((o) => '<span class="w10r-pin" style="left:' + ((o.h / 24) * 100).toFixed(2) + '%" title="' + K.esc(hhmm(o.p.time) + ' ' + placePhrase(o.p.label)) + '"></span>')
      .join('');

    const lane = (label, totalTxt, tone, icon, inner) =>
      '<div class="w10r-lane">' +
        '<div class="w10r-lane-label k10-tone-' + tone + '"><span class="w10r-lane-ic">' + K.icon(icon, 12) + '</span>' +
          '<span class="w10r-lane-name">' + K.esc(label) + '</span><span class="w10r-lane-total">' + K.esc(totalTxt) + '</span></div>' +
        inner +
      '</div>';
    const none = (field, emptyTxt) => '<span class="w10r-lane-none">' + (has(d, field) ? emptyTxt : MISSING) + '</span>';

    const axis = '<div class="w10r-axis" aria-hidden="true"><span></span><div class="w10r-axis-ticks">' +
      ['00', '06', '12', '18', '24'].map((t) => '<span>' + t + '</span>').join('') + '</div></div>';

    let sub = '';
    if (x.peak) {
      const parts = [];
      if (x.peak.sessions) parts.push(plural(x.peak.sessions, 'session', 'sessions') + ' started');
      if (x.peak.messages) parts.push(plural(x.peak.messages, 'message', 'messages'));
      if (x.peak.meetings) parts.push(plural(x.peak.meetings, 'meeting', 'meetings') + ' began');
      sub = 'Peak hour ' + pad2(x.peak.hour) + ':00: ' + parts.join(', ');
    }

    const body =
      '<div class="w10r-shape" role="img" aria-label="' + K.esc('Hour by hour activity. ' + (sub || '')) + '">' +
        lane('Sessions', has(d, 'work') ? n0(total(x.workH)) : '--', 'cobalt', 'bolt', laneCells(x.workH, 'cobalt', 'sessions started')) +
        lane('Messages', has(d, 'comms') ? n0(total(x.commsH)) : '--', 'violet', 'chat', laneCells(x.commsH, 'violet', 'messages')) +
        lane('Meetings', has(d, 'meetings') ? n0(x.meetings.length) : '--', 'orange', 'calendar',
          '<div class="w10r-lane-track is-blocks k10-tone-orange" style="--w10r-lanes:' + laneCount + '">' + (meetBlocks || none('meetings', 'None')) + '</div>') +
        lane('Places', has(d, 'places') ? n0(x.places.length) : '--', 'emerald', 'map',
          '<div class="w10r-lane-track is-pins k10-tone-emerald">' + (pins || none('places', 'No GPS')) + '</div>') +
        axis +
      '</div>' +
      (hiddenBlocks ? '<div class="w10r-foot-note">' + K.esc(plural(hiddenBlocks, 'more overlapping meeting', 'more overlapping meetings') + ' in the agenda') + '</div>' : '');
    const right = x.first ? K.chip(x.first === x.last ? x.first : x.first + ' to ' + x.last, 'slate', { icon: 'clock', dot: false }) : '';
    return K.card({ title: 'Day shape', sub: sub || undefined, right, body });
  }

  /* person.count is messages plus meetings attended (replay-api.ts people map). */
  function unitFor(p) {
    const ch = arr(p.channels);
    const one = Number(p.count) === 1;
    if (ch.length && ch.every((c) => c === 'calendar')) return one ? 'meeting' : 'meetings';
    if (!ch.includes('calendar')) return one ? 'message' : 'messages';
    return one ? 'message or meeting' : 'messages and meetings';
  }

  function peopleHtml(d, x) {
    const K = kit();
    if (!has(d, 'people')) {
      return K.card({
        title: 'People in touch',
        body: K.emptyState({ title: 'Unavailable', body: 'People are not in this day packet.', icon: 'people', compact: true }),
      });
    }
    const w = x.who;
    const humans = w.direct.length + w.email.length + w.groupOnly.length;
    if (!humans && !w.groups.length) {
      return K.card({
        title: 'People in touch',
        body: K.emptyState({
          title: 'No conversations',
          body: w.automated.length ? 'Only automated senders wrote on this day.' : 'No messages or meetings with people were captured on this day.',
          icon: 'people', compact: true,
        }),
      });
    }
    const LIMIT = 6;
    const expanded = peopleExpanded && peopleExpandedDay === d.day;
    const rows = w.direct.slice(0, expanded ? w.direct.length : LIMIT).map((p) =>
      K.personRow({ name: clean(p.name) || 'Unknown', key: p.key || p.name }, {
        sub: [arr(p.channels).map(channelName).join(', '), p.flow ? p.flow.charAt(0).toUpperCase() + p.flow.slice(1) : ''].filter(Boolean).join(' · '),
        right: isNum(p.count) ? n0(p.count) : '--',
        rightSub: unitFor(p),
        size: 26,
        action: 'replay-person',
      })
    ).join('');
    const more = w.direct.length > LIMIT
      ? '<button type="button" class="w10r-more" data-w10r-toggle-people="1" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
          (expanded ? 'Show fewer' : 'Show all ' + n0(w.direct.length)) + '</button>'
      : '';
    const section = (title, count, inner) =>
      '<div class="w10r-ppl-sec"><div class="w10r-sub-head"><span>' + K.esc(title) + '</span><span class="w10r-sub-count">' + K.esc(n0(count)) + '</span></div>' + inner + '</div>';
    const crowd = (list, verb) => {
      const people = list.map((p) => ({ name: clean(p.name), key: p.key }));
      return '<div class="w10r-crowd">' + K.avatarStack(people, { max: 5, size: 24, mode: 'initials' }) +
        '<span class="w10r-crowd-t k10-truncate">' + K.esc(listNames(people.map((p) => p.name), 3) + verb) + '</span></div>';
    };
    let body = '';
    body += w.direct.length
      ? section('Direct', w.direct.length, '<div class="w10r-people">' + rows + '</div>' + more)
      : section('Direct', 0, '<p class="w10r-none">No one-to-one threads or meetings</p>');
    if (w.email.length) body += section('Email', w.email.length, crowd(w.email, ''));
    if (w.groupOnly.length) body += section('Only in group chats', w.groupOnly.length, crowd(w.groupOnly, ''));
    if (w.groups.length) {
      body += section('Busiest groups and channels', w.groups.length, K.bars(w.groups.slice(0, 4).map((g) => ({
        label: g.title, value: g.count, tone: 'violet',
        detail: channelName(g.channel) + (g.members.length > 1 ? ' · ' + g.members.length + ' people' : ''),
      }))));
    }
    if (w.automated.length) {
      body += '<p class="w10r-foot-note" title="' + K.esc(w.automated.map((p) => clean(p.name)).join(', ')) + '">' +
        K.esc(plural(w.automated.length, 'automated sender', 'automated senders') + ' not counted as people') + '</p>';
    }
    const subParts = [plural(w.direct.length, 'direct', 'direct')];
    if (w.email.length) subParts.push(n0(w.email.length) + ' by email');
    if (w.groupOnly.length) subParts.push(n0(w.groupOnly.length) + ' only in groups');
    return K.card({
      title: 'People in touch',
      sub: subParts.join(' · '),
      right: '<button type="button" class="w10r-link" data-w10r-open-tab="people">All messages' + K.icon('arrow', 12) + '</button>',
      body,
    });
  }

  function workHtml(d, x) {
    const K = kit();
    if (!has(d, 'work')) {
      return K.card({
        title: 'Build focus',
        body: K.emptyState({ title: 'Unavailable', body: 'Build sessions are not in this day packet.', icon: 'bolt', compact: true }),
      });
    }
    if (!x.projects.length) {
      return K.card({
        title: 'Build focus',
        body: K.emptyState({ title: 'No build sessions', body: 'No coding or agent sessions were captured on this day.', icon: 'bolt', compact: true }),
      });
    }
    const totalSteps = x.steps || 0;
    const items = x.projects.slice(0, 6).map((p) => ({
      label: p.name, value: p.steps, tone: 'cobalt', icon: 'layers',
      display: n0(p.steps) + (totalSteps > 0 ? ' · ' + Math.round((p.steps / totalSteps) * 100) + '%' : ''),
      detail: plural(p.sessions, 'session', 'sessions'),
    }));
    const rest = x.projects.length > 6 ? '<div class="w10r-foot-note">' + K.esc('+' + (x.projects.length - 6) + ' more projects') + '</div>' : '';
    const src = x.sources.length
      ? '<div class="w10r-src">' + x.sources.map((s) => K.chip(s.name + ' ' + n0(s.value), '', { dot: false })).join('') + '</div>'
      : '';
    return K.card({
      title: 'Build focus',
      sub: 'Steps per project · ' + plural(totalSteps, 'step', 'steps') + ' across ' + plural(x.work.length, 'session', 'sessions'),
      body: K.bars(items) + rest + src,
    });
  }

  function agendaHtml(d, x) {
    const K = kit();
    if (!has(d, 'meetings')) {
      return K.card({
        title: 'Agenda',
        body: K.emptyState({ title: 'Unavailable', body: 'The calendar is not in this day packet.', icon: 'calendar', compact: true }),
      });
    }
    if (!x.meetings.length) {
      return K.card({
        title: 'Agenda',
        body: K.emptyState({ title: 'Nothing scheduled', body: 'No calendar events or meeting notes on this day.', icon: 'calendar', compact: true }),
      });
    }
    const rows = x.meetings.map((m) => {
      const a = hhmm(m.time);
      const b = hhmm(m.end_time);
      const ppl = arr(m.participants).map((p) => ({ name: emailName(p) })).filter((p) => p.name);
      const docPath = m.doc_path || m.wispr_doc_path || '';
      const tag = docPath ? 'button type="button"' : 'div';
      const close = docPath ? 'button' : 'div';
      const sub = [clean(m.location), ppl.length ? plural(ppl.length, 'attendee', 'attendees') : 'No attendees listed', docPath ? 'Note attached' : ''].filter(Boolean).join(' · ');
      return '<' + tag + ' class="w10r-agenda-row"' + (docPath ? ' data-open-doc="' + K.esc(docPath) + '"' : '') + '>' +
        '<span class="w10r-agenda-time"><span>' + K.esc(a || '--:--') + '</span>' + (b && b !== a ? '<span class="w10r-agenda-end">' + K.esc(b) + '</span>' : '') + '</span>' +
        '<span class="w10r-agenda-main"><span class="w10r-agenda-title k10-truncate">' + K.esc(clean(m.title) || 'Untitled') + '</span>' +
          '<span class="w10r-agenda-sub k10-truncate">' + K.esc(sub) + '</span></span>' +
        (ppl.length ? '<span class="w10r-agenda-ppl">' + K.avatarStack(ppl, { max: 3, size: 22, mode: 'initials' }) + '</span>' : docPath ? '<span class="w10r-agenda-ppl w10r-agenda-doc" aria-hidden="true">' + K.icon('doc', 14) + '</span>' : '') +
      '</' + close + '>';
    }).join('');
    return K.card({
      title: 'Agenda',
      sub: plural(x.meetings.length, 'event', 'events') + (durLabel(x.bookedMins) ? ' · ' + durLabel(x.bookedMins) + ' booked' : ''),
      body: '<div class="w10r-agenda">' + rows + '</div>',
    });
  }

  function overviewHtml(d, x) {
    return '<div class="w10r-overview"><div class="w10r-col">' + agendaHtml(d, x) + workHtml(d, x) + '</div>' + peopleHtml(d, x) + '</div>';
  }

  /* ------------------------------------------------------------ mount */
  function ensureSlot(id, ref, where) {
    let el = document.getElementById(id);
    if (!el && ref && ref.parentNode) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'w10r-slot';
      if (where === 'before') ref.parentNode.insertBefore(el, ref);
      else ref.parentNode.insertBefore(el, ref.nextSibling);
    }
    return el;
  }

  function clearStage() {
    ['w10r-hero', 'w10r-kpis', 'w10r-shape', 'w10r-overview'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    const stage = $('#replay-stage');
    if (stage) stage.classList.remove('w10r-ready');
    renderedDay = null;
  }

  function linkPeople(root) {
    $$('[data-k10-person]', root).forEach((el) => {
      if (!el.hasAttribute('data-open-person')) el.setAttribute('data-open-person', el.getAttribute('data-k10-person'));
    });
  }

  function renderOverview(d, x) {
    const ov = document.getElementById('w10r-overview');
    if (!ov) return;
    ov.innerHTML = overviewHtml(d, x);
    linkPeople(ov);
  }

  function renderStage(d) {
    const K = kit();
    const stage = $('#replay-stage');
    const map = $('#replay-map-card');
    const kpis = $('#replay-kpis');
    const rhythm = $('#replay-rhythm-container');
    const tabs = $('#replay-subtabs');
    if (!K || !stage || !map || !kpis || !rhythm || !tabs) return;
    if (peopleExpandedDay !== d.day) { peopleExpanded = false; peopleExpandedDay = d.day; }
    const x = derive(d);
    const hero = ensureSlot('w10r-hero', map, 'before');
    const kp = ensureSlot('w10r-kpis', map, 'before');
    const shape = ensureSlot('w10r-shape', rhythm, 'after');
    ensureSlot('w10r-overview', tabs, 'before');
    hero.innerHTML = heroHtml(d, x);
    kp.innerHTML = kpisHtml(d, x);
    shape.innerHTML = shapeHtml(d, x);
    renderOverview(d, x);
    stage.classList.add('w10r-ready');
    renderedDay = d.day;
  }

  async function syncStage(force) {
    const day = currentDay();
    const title = $('#replay-day-title');
    const noDay = !day || (title && /select a day/i.test(title.textContent || ''));
    if (noDay) {
      clearStage();
      return;
    }
    const heroEl = document.getElementById('w10r-hero');
    if (!force && day === renderedDay && heroEl && heroEl.firstElementChild) return;
    const tok = ++renderTok;
    const stage = $('#replay-stage');
    if (stage && renderedDay && renderedDay !== day && !dayCache.has(day)) stage.classList.add('w10r-stale');
    const data = await getDay(day);
    if (tok !== renderTok) return;
    if (stage) stage.classList.remove('w10r-stale');
    if (!data) {
      if (renderedDay !== day) clearStage();
      return;
    }
    if (currentDay() !== day) return;
    renderStage(data);
  }

  /* -------------------------------------------- decorate app-rendered DOM */
  function decorateTimeline(panel, K) {
    $$('.replay-event:not([data-w10r])', panel).forEach((ev) => {
      ev.setAttribute('data-w10r', '1');
      const kind = String(ev.getAttribute('data-kind') || 'work').toLowerCase();
      const meta = KIND[kind] || KIND.work;
      const rail = $('.replay-event-rail', ev);
      if (rail) {
        const tile = document.createElement('span');
        tile.className = 'w10r-ev-ic k10-tone-' + meta.tone;
        tile.setAttribute('aria-hidden', 'true');
        tile.innerHTML = K.icon(meta.icon, 12);
        rail.appendChild(tile);
      }
      const kindEl = $('.replay-event-kind', ev);
      if (kindEl) kindEl.textContent = meta.label;
      if (kind === 'comms') {
        const t = $('.replay-event-title', ev);
        if (t) {
          const sender = clean(t.textContent).replace(/\s*\([^)]+\)\s*$/, '');
          if (sender) {
            const wrap = document.createElement('span');
            wrap.className = 'w10r-ev-av';
            wrap.innerHTML = K.avatar({ name: sender }, { size: 20, mode: 'initials' });
            t.parentNode.insertBefore(wrap, t);
          }
        }
      }
    });
  }

  function decoratePeopleTab(panel, K) {
    $$('.collab-chip:not([data-w10r])', panel).forEach((chip) => {
      chip.setAttribute('data-w10r', '1');
      const old = $('.person-avatar', chip);
      const name = clean(($('.collab-chip-name', chip) || {}).textContent || '');
      if (old && name) {
        const tmp = document.createElement('span');
        tmp.innerHTML = K.avatar({ name, key: chip.getAttribute('data-open-person') || name }, { size: 24, mode: 'initials' });
        if (tmp.firstElementChild) old.replaceWith(tmp.firstElementChild);
      }
    });
    $$('.replay-work-row[data-open-person]:not([data-w10r])', panel).forEach((row) => {
      row.setAttribute('data-w10r', '1');
      const proj = $('.replay-work-project', row);
      const name = proj ? clean(proj.textContent).split(' · ')[0] : '';
      if (!name) return;
      const av = document.createElement('span');
      av.className = 'w10r-row-av';
      av.innerHTML = K.avatar({ name, key: row.getAttribute('data-open-person') }, { size: 24, mode: 'initials' });
      row.insertBefore(av, row.firstChild);
      row.classList.add('w10r-has-av');
    });
  }

  function decoratePanel() {
    const K = kit();
    const panel = $('#replay-tabpanel');
    if (!K || !panel) return;
    decorateTimeline(panel, K);
    decoratePeopleTab(panel, K);
  }

  /* Rail counts come from the day index, which counts differently from the open day packet
     (the packet drops boilerplate agent steps). Say so where the number sits. */
  function decorateRail() {
    const list = $('#replay-days-list');
    if (!list) return;
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    $$('.replay-day-row[data-replay-day]:not([data-w10r])', list).forEach((row) => {
      row.setAttribute('data-w10r', '1');
      const pv = $('.replay-day-preview', row);
      const sg = $('.replay-day-signals', row);
      if (pv && sg && norm(pv.textContent) && norm(sg.textContent).includes(norm(pv.textContent))) pv.classList.add('w10r-dup');
      const ct = $('.replay-day-count', row);
      if (ct && !ct.title) ct.title = 'All events in the day index. The open day can differ after noise filtering.';
      if (sg && !sg.title) sg.title = 'Counts from the day index';
    });
  }

  /* Read-only builders for the storyboard catalog (public/storyboard/replay.html). */
  const build = (fn) => (day) => fn(day || {}, derive(day || {}));
  window.KizukiReplayW10 = Object.freeze({
    hero: build(heroHtml),
    kpis: build(kpisHtml),
    shape: build(shapeHtml),
    people: build(peopleHtml),
    work: build(workHtml),
    agenda: build(agendaHtml),
    overview: build(overviewHtml),
    classify: (day) => classifyPeople(day || {}),
    kinds: KIND,
  });

  /* ------------------------------------------------------------ wiring */
  function isActive() {
    const v = document.getElementById('view-replay');
    return Boolean(v && !v.hidden);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      if (!isActive()) return;
      decorateRail();
      decoratePanel();
      syncStage(false);
    });
  }

  function observe() {
    if (observed) return;
    const view = document.getElementById('view-replay');
    const kpis = document.getElementById('replay-kpis');
    const title = document.getElementById('replay-day-title');
    const panel = document.getElementById('replay-tabpanel');
    const list = document.getElementById('replay-days-list');
    if (!view || !kpis || !title || !panel || !list) return;
    observed = true;
    const mo = new MutationObserver(schedule);
    [kpis, title, panel, list].forEach((el) => mo.observe(el, { childList: true }));
    const viewMo = new MutationObserver(() => {
      if (isActive()) schedule();
    });
    viewMo.observe(view, { attributes: true, attributeFilter: ['hidden'] });

    view.addEventListener('click', (e) => {
      const target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      const toggle = target.closest('[data-w10r-toggle-people]');
      if (toggle) {
        const d = renderedDay && dayCache.get(renderedDay);
        if (!d) return;
        peopleExpanded = !peopleExpanded;
        peopleExpandedDay = d.day;
        renderOverview(d, derive(d));
        const btn = document.querySelector('#w10r-overview [data-w10r-toggle-people]');
        if (btn) btn.focus();
        return;
      }
      const open = target.closest('[data-w10r-open-tab]');
      if (open) {
        const tab = document.querySelector('#replay-subtabs [data-replay-tab="' + open.getAttribute('data-w10r-open-tab') + '"]');
        if (!tab) return;
        tab.click();
        tab.focus({ preventScroll: true });
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const tabs = document.getElementById('replay-subtabs');
        if (tabs) tabs.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      }
    });
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
})();
