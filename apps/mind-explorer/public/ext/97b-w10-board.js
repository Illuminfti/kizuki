/* Wave 10 / Agent board depth layer.
   Enhances the DOM rendered by agent-board-view.js (window.KizukiAgentBoardView), scoped to #view-board:
   - board header: room-scoped or board-wide stats (labelled as such), active agents, seat headroom
   - agent monograms in place of brand glyphs (stream, thread, replies, dock)
   - thread header banner with author, participants, replies, status and runs, plus a way back to the fleet
   - fleet overview in the thread pane: owner escalations, active agents, Routed queue, queues, rooms, seats
   Board numbers come from the controller's state (getState). Blockers are fetched here once per 30s so the
   layer knows when the queues really loaded: the controller seeds them with zeros before its own request lands. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__w10BoardBooted) return;
  window.__w10BoardBooted = true;

  const BRAND_TONE = { owner: 'cobalt', claude: 'orange', codex: 'emerald', designer: 'violet', brain: 'slate' };
  const BLOCKERS_TTL = 30000;

  function kit() {
    return window.KizukiKit || null;
  }
  function boardState() {
    const api = window.KizukiAgentBoardView;
    if (!api || typeof api.getState !== 'function') return null;
    try {
      return api.getState();
    } catch {
      return null;
    }
  }
  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  }
  function rel(ms) {
    if (ms == null) return '';
    const d = Math.max(0, Date.now() - ms);
    const m = Math.round(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
  }
  function sentence(s) {
    const t = String(s || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
  function agentName(a) {
    if (a && a.brand === 'owner' && ownerName()) return ownerName();
    return (a && (a.displayName || a.handle || a.actor)) || '';
  }
  function seenMs(a) {
    return toMs(a && (a.lastSeenMs != null ? a.lastSeenMs : a.lastSeenAt));
  }
  function ownerName() {
    const b = document.body;
    return (b && b.getAttribute('data-owner-name') || '').trim();
  }
  /* Only agents that came from /api/agent-board/agents carry lastSeen; canonical placeholders do not. */
  function liveAgents(st) {
    const list = Array.isArray(st && st.agents) ? st.agents : [];
    return list.filter((a) => a && seenMs(a) != null);
  }
  function byRecent(a, b) {
    return (seenMs(b) || 0) - (seenMs(a) || 0);
  }
  function isRoomScoped(st) {
    return Boolean(st && (st.mode === 'rooms' || !st.mode) && st.channel && st.channel !== 'mission');
  }
  function roomTitle(st) {
    if (!st) return 'Agent board';
    if (st.mode === 'feed') return 'Live feed';
    if (st.mode === 'blockers') return 'Blockers';
    if (st.mode === 'taste') return 'Taste board';
    if (st.channel === 'mission' || !st.channel) return 'Mission signal';
    return `#${st.channel}`;
  }
  /* The controller normalises rooms (missing counts become 0, lastAtMs dropped) and keeps the API row in .raw; read the API row first. */
  function roomData(r) {
    if (!r || typeof r !== 'object') return null;
    const raw = r.raw && typeof r.raw === 'object' ? r.raw : r;
    const pick = (k) => (raw[k] !== undefined ? raw[k] : r[k]);
    const blocked = raw.blockedTasks !== undefined ? raw.blockedTasks : raw.blockedCount !== undefined ? raw.blockedCount : r.blockedTasks;
    return {
      channel: r.channel || raw.channel,
      groupLabel: pick('groupLabel'),
      threads: num(pick('threads')),
      messages: num(pick('messages')),
      openTasks: num(pick('openTasks')),
      blockedTasks: num(blocked),
      lastAtMs: num(pick('lastAtMs')) || toMs(pick('lastAt')),
      lastAuthor: pick('lastAuthor') || '',
    };
  }
  function roomRecord(st) {
    if (!isRoomScoped(st)) return null;
    const rooms = Array.isArray(st.rooms) ? st.rooms : [];
    return roomData(rooms.find((r) => r && r.channel === st.channel) || null);
  }
  function blockersReady(st) {
    return Boolean(st && st.blockersLoaded && st.blockers && typeof st.blockers === 'object');
  }
  function byOldest(list) {
    return (Array.isArray(list) ? list : [])
      .slice()
      .sort((a, b) => (toMs(a && a.created_at) || Infinity) - (toMs(b && b.created_at) || Infinity));
  }

  /* ----------------------------------------------------- agent monograms */
  function hashStr(s) {
    const K = kit();
    if (K && typeof K.hash === 'function') return K.hash(String(s));
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  /* Session agents ("Claude · 0c28e1", "codex-9f8e7d") read by their short session id; named agents by initials. */
  function monoText(name, handle) {
    const src = `${name || ''} ${handle || ''}`;
    const m = src.match(/(?:^|[\s·:_-])([0-9a-f]{6,})\b/i);
    if (m) return m[1].slice(0, 2).toLowerCase();
    const parts = String(name || handle || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function agentAvatar(K, o) {
    const brand = String(o.brand || '').toLowerCase();
    const isOwner = brand === 'owner';
    const owner = ownerName();
    const name = isOwner && owner ? owner : o.name || o.handle || 'Agent';
    const size = Math.max(18, Math.min(64, Number(o.size) || 30));
    const text = isOwner && owner ? monoText(owner, '') : monoText(o.name, o.handle);
    const hue = hashStr(o.handle || o.name || '?') % 360;
    const badge = !isOwner && BRAND_TONE[brand] && size >= 24
      ? `<span class="w10b-av-brand k10-tone-${BRAND_TONE[brand]}" aria-hidden="true"></span>`
      : '';
    const label = isOwner && owner && o.name && o.name !== owner ? `${owner} (${o.name})` : name;
    return `<span class="w10b-av${isOwner ? ' is-owner' : ''}${size <= 24 ? ' is-xs' : ''}" style="--w10b-av-size:${size}px;--w10b-av-h:${hue}" role="img" aria-label="${K.esc(label)}" title="${K.esc(label)}"><span class="w10b-av-txt" aria-hidden="true">${K.esc(text)}</span>${badge}</span>`;
  }
  function agentStack(K, people, max) {
    const list = (Array.isArray(people) ? people : []).filter((p) => p && (p.name || p.handle));
    if (!list.length) return '';
    const shown = list.slice(0, max || 4);
    const extra = list.length - shown.length;
    return `<span class="w10b-stack" role="group" aria-label="${K.esc(list.map((p) => p.name || p.handle).join(', '))}">${shown
      .map((p) => agentAvatar(K, Object.assign({ size: 24 }, p)))
      .join('')}${extra > 0 ? `<span class="w10b-av w10b-av-more" style="--w10b-av-size:24px" title="${K.esc(list.slice(shown.length).map((p) => p.name || p.handle).join(', '))}">+${extra}</span>` : ''}</span>`;
  }

  function brandFromEl(el) {
    if (!el || !el.classList) return '';
    for (const c of el.classList) if (c.indexOf('is-') === 0) return c.slice(3);
    return '';
  }

  function enhanceAvatars(root, K) {
    const glyphs = root.querySelectorAll('.eb-author-glyph:not([data-w10b])');
    for (let i = 0; i < glyphs.length; i += 1) {
      const g = glyphs[i];
      const head = g.closest('.eb-msg-head');
      const author = head && head.querySelector('.eb-author');
      const name = author ? author.textContent.trim() : '';
      if (!name) continue;
      const brand = brandFromEl(g);
      const card = g.closest('article');
      const isReply = card && card.classList.contains('eb-thread-reply-card');
      g.setAttribute('data-w10b', '1');
      g.classList.add('w10b-glyph');
      g.innerHTML = agentAvatar(K, { name, handle: author.getAttribute('data-actor') || name, brand, size: isReply ? 24 : 30 });
      if (card) card.setAttribute('data-w10b-brand', brand || 'agent');
    }

    const dock = root.querySelectorAll('.eb-dock-agent:not([data-w10b])');
    for (let i = 0; i < dock.length; i += 1) {
      const b = dock[i];
      const name = b.getAttribute('aria-label') || b.getAttribute('data-agent-handle') || '';
      if (!name) continue;
      b.setAttribute('data-w10b', '1');
      b.classList.add('w10b-dock-agent');
      b.innerHTML = agentAvatar(K, { name, handle: b.getAttribute('data-agent-handle') || name, brand: brandFromEl(b), size: 30 });
    }
  }

  /* Raw labels from the board ("in_progress", "PATH", "BLACKWELL G4 // THREAD BRIEF") become sentence case. */
  const TAG_TEXT = { PATH: 'Path', DOC: 'Doc', SHA: 'Commit', LINK: 'Link' };
  function normaliseLabels(root) {
    const chips = root.querySelectorAll('.eb-status-chip:not([data-w10b])');
    for (let i = 0; i < chips.length; i += 1) {
      const c = chips[i];
      c.setAttribute('data-w10b', '1');
      if (c.children.length === 0) c.textContent = sentence(c.textContent);
    }
    const tags = root.querySelectorAll('.eb-artifact-tag:not([data-w10b])');
    for (let i = 0; i < tags.length; i += 1) {
      const t = tags[i];
      t.setAttribute('data-w10b', '1');
      const raw = t.textContent.trim();
      if (TAG_TEXT[raw]) t.textContent = TAG_TEXT[raw];
    }
    const briefs = root.querySelectorAll('.eb-brief-bar-title:not([data-w10b])');
    for (let i = 0; i < briefs.length; i += 1) {
      const b = briefs[i];
      b.setAttribute('data-w10b', '1');
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        if (/THREAD BRIEF/.test(n.nodeValue)) {
          const host = n.nodeValue.replace(/\/\/\s*THREAD BRIEF/i, '').trim();
          n.nodeValue = host ? `Thread brief · ${host}` : 'Thread brief';
        }
        n = walker.nextNode();
      }
    }
  }

  /* ---------------------------------------------------------- seat rings */
  function seatsHtml(K, seats) {
    const list = (Array.isArray(seats) ? seats : []).filter((s) => s && (s.label || s.id)).slice(0, 4);
    if (!list.length) return '';
    return `<div class="w10b-seats" role="list" aria-label="Model seat use against weekly cap">${list
      .map((s) => {
        const used = num(s.weekly_used_pct);
        const limit = num(s.weekly_limit_pct);
        const share = used == null ? null : limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : used;
        const over = used != null && limit != null && used >= limit;
        const tone = s.eligible === false || over ? 'rose' : share != null && share >= 75 ? 'orange' : 'emerald';
        const label = String(s.label || s.id);
        const caption = used == null
          ? 'No reading'
          : limit != null ? `${Math.round(used)}% used, cap ${Math.round(limit)}%` : `${Math.round(used)}% of week`;
        const aria = used == null
          ? `${label}: weekly use unavailable`
          : `${label}: ${Math.round(used)} percent of week used${limit != null ? `, ${Math.round(share)} percent of the ${Math.round(limit)} percent cap` : ''}${s.eligible === false ? ', not eligible' : ''}`;
        const title = `${label}${s.model ? ` · ${s.model}` : ''}${s.reason && s.reason !== 'ok' ? ` · ${s.reason}` : ''}`;
        return `<div class="w10b-seat${used == null ? ' is-empty' : ''}" role="listitem" title="${K.esc(title)}">${K.ring(share, tone, { size: 40, aria, label: share == null ? '--' : `${Math.round(share)}%` })}<span class="w10b-seat-text"><span class="w10b-seat-label k10-truncate">${K.esc(label)}</span><span class="w10b-seat-cap">${K.esc(caption)}${s.eligible === false && used != null ? ' · held' : ''}</span></span></div>`;
      })
      .join('')}</div>`;
  }

  /* ------------------------------------------------------- board header */
  function heroModel(st) {
    const totals = (st.health && st.health.totals) || {};
    const counts = (st.blockers && st.blockers.counts) || {};
    const ready = blockersReady(st);
    const live = liveAgents(st).slice().sort(byRecent);
    const active = live.filter((a) => a.activeRecent);
    const room = roomRecord(st);
    if (isRoomScoped(st)) {
      const sub = [];
      if (room) {
        if (room.groupLabel) sub.push(room.groupLabel);
        const last = room.lastAtMs;
        if (last) sub.push(`last post ${rel(last)}${room.lastAuthor ? ` by ${room.lastAuthor}` : ''}`);
      }
      return {
        scope: 'This room',
        subtitle: sub.length ? sub.join(' · ') : room ? '' : 'Room totals unavailable',
        active,
        stats: [
          { label: 'Threads', value: room ? room.threads : null, icon: 'chat', tone: 'slate' },
          { label: 'Open tasks', value: room ? room.openTasks : null, icon: 'check', tone: 'cobalt' },
          { label: 'Blocked', value: room ? room.blockedTasks : null, icon: 'alert', tone: 'rose', action: 'w10b-blockers' },
          { label: 'Messages', value: room ? room.messages : null, icon: 'pulse', tone: 'violet' },
        ],
      };
    }
    const subBits = [];
    if (num(totals.threads) != null) subBits.push(`${K_fmt(num(totals.threads))} threads in ${K_fmt(num(totals.channels))} rooms`);
    if (live[0]) subBits.push(`latest activity ${rel(seenMs(live[0]))} from ${agentName(live[0])}`);
    return {
      scope: 'Across all rooms',
      subtitle: subBits.length ? subBits.join(' · ') : 'Waiting for board totals',
      active,
      stats: [
        { label: 'Open tasks', value: num(totals.openTasks), icon: 'check', tone: 'cobalt' },
        { label: 'Blocked', value: num(totals.blocked), icon: 'alert', tone: 'rose', action: 'w10b-blockers' },
        { label: 'Escalated to you', value: ready ? num(counts.escalations) : null, icon: 'inbox', tone: 'orange', action: 'w10b-blockers' },
        { label: 'Active agents', value: live.length ? active.length : null, icon: 'people', tone: 'emerald' },
      ],
    };
  }
  function K_fmt(v) {
    const K = kit();
    return K ? K.fmt(v) : v == null ? '--' : String(v);
  }

  function heroHtml(st, K) {
    const m = heroModel(st);
    const crew = m.active.length
      ? `<div class="w10b-head-crew"><span class="w10b-head-crew-label">Active now</span>${agentStack(
          K,
          m.active.map((a) => ({ name: agentName(a), handle: a.handle || a.actor, brand: a.brand })),
          5
        )}</div>`
      : '';
    const title = roomTitle(st);
    return `<section class="w10b-head" aria-label="${K.esc(title)}">
      <div class="w10b-head-top">
        <div class="w10b-head-text">
          <div class="w10b-head-eyebrow">${K.icon('chat', 13)}<span>Agent board</span><span class="w10b-head-scope">${K.esc(m.scope)}</span></div>
          <h2 class="w10b-head-title k10-truncate">${K.esc(title)}</h2>
          ${m.subtitle ? `<p class="w10b-head-sub k10-truncate">${K.esc(m.subtitle)}</p>` : ''}
        </div>
      </div>
      <div class="w10b-head-stats">${m.stats.map((s) => K.statTile(s)).join('')}</div>
      ${crew}
    </section>`;
  }

  function heroSig(st) {
    const m = heroModel(st);
    return [
      roomTitle(st), m.scope, m.subtitle, m.stats.map((s) => s.value).join(','),
      m.active.map((a) => a.handle).slice(0, 6).join(','),
      document.documentElement.getAttribute('data-theme'),
    ].join('|');
  }

  function renderHero(view, st, K) {
    let host = view.querySelector(':scope > .w10b-hero');
    const sig = heroSig(st);
    if (host && host.getAttribute('data-sig') === sig) {
      if (view.firstElementChild !== host) view.insertBefore(host, view.firstElementChild);
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.className = 'w10b-hero w10b-own';
    }
    host.setAttribute('data-sig', sig);
    host.innerHTML = heroHtml(st, K);
    if (view.firstElementChild !== host) view.insertBefore(host, view.firstElementChild);
  }

  /* ------------------------------------------------------- thread banner */
  function threadStatusKey(root, pause) {
    const ts = String((root && root.taskState) || '').toLowerCase();
    if (pause || (root && root.isPaused) || ts === 'paused') return 'paused';
    if ((root && root.isBlocked) || ts === 'blocked' || ts === 'stalled') return 'blocked';
    if (ts === 'done' || ts === 'completed' || ts === 'resolved' || ts === 'shipped') return 'done';
    if (ts === 'claimed' || ts === 'running' || ts === 'in_progress') return 'claimed';
    if (ts === 'open' || ts === 'ready') return 'open';
    return 'discussion';
  }
  function threadStatus(root, pause) {
    if (pause || (root && root.isPaused)) return 'Paused';
    if (root && root.isBlocked) return 'Blocked';
    const ts = String((root && root.taskState) || '');
    return ts ? sentence(ts) : 'Discussion';
  }
  function threadPeople(d) {
    const people = [];
    const seen = new Set();
    [d.root].concat(Array.isArray(d.replies) ? d.replies : []).forEach((m) => {
      const name = m && (m.displayName || m.by);
      const key = m && (m.by || m.byActor || name);
      if (!name || seen.has(key)) return;
      seen.add(key);
      people.push({ name, handle: key, brand: m.brand });
    });
    return people;
  }

  function threadHeroHtml(d, K, opts) {
    const root = d && d.root;
    if (!root) return '';
    const o = opts || {};
    const replies = Array.isArray(d.replies) ? d.replies : [];
    const runs = Array.isArray(d.runs) ? d.runs : [];
    const people = threadPeople(d);
    const created = toMs(root.createdAtMs || root.createdAt);
    const last = toMs(root.lastAtMs || root.lastAt);
    const title = clip(root.title || root.text || `Thread ${root.id || ''}`, 160);
    const author = people[0] ? people[0].name : root.displayName || root.by || 'unknown';
    const subBits = [`Started by ${author}`];
    if (created) subBits.push(rel(created));
    if (last && created && last - created > 60000) subBits.push(`last activity ${rel(last)}`);
    const status = threadStatusKey(root, d.pause);
    const others = people.slice(1);
    const fleetBtn = o.fleetButton
      ? `<button type="button" class="w10b-btn" data-w10b-action="fleet" title="Show the fleet overview">${K.icon('people', 13)}<span>Fleet</span></button>`
      : '';
    const stat = (label, value, cls) => `<div class="w10b-tstat${cls ? ` ${cls}` : ''}${value == null ? ' is-empty' : ''}"><dt>${K.esc(label)}</dt><dd>${K.esc(K.fmt(value))}</dd></div>`;
    return `<section class="w10b-thero is-${status}" aria-label="${K.esc(title)}">
      ${K.coverArt(root.channel || 'thread', 'slate', { height: 120, art: 'contour' })}
      <div class="w10b-thero-body">
        <div class="w10b-thero-lead">${people[0] ? agentAvatar(K, Object.assign({}, people[0], { size: 44 })) : ''}</div>
        <div class="w10b-thero-text">
          <div class="w10b-thero-eyebrow"><span class="w10b-thero-room k10-truncate">${K.esc(root.channel ? `#${root.channel}` : 'Thread')}</span>${root.id ? `<span class="w10b-thero-id">#${K.esc(root.id)}</span>` : ''}</div>
          <h2 class="w10b-thero-title">${K.esc(title)}</h2>
          <p class="w10b-thero-sub k10-truncate">${K.esc(subBits.join(' · '))}</p>
        </div>
        <div class="w10b-thero-right">${others.length ? agentStack(K, others, 4) : ''}${fleetBtn}</div>
      </div>
      <dl class="w10b-thero-stats">
        ${stat('Status', threadStatus(root, d.pause), 'is-status')}
        ${stat('Replies', replies.length)}
        ${stat('Participants', people.length)}
        ${stat('Runs', runs.length)}
      </dl>
    </section>`;
  }

  function renderThreadHero(view, st, K) {
    const tv = view.querySelector('.eb-stage-body > .eb-thread-view');
    if (!tv) return;
    const d = st.threadDetail;
    const root = d && d.root;
    if (!root) return;
    const replies = Array.isArray(d.replies) ? d.replies : [];
    const runs = Array.isArray(d.runs) ? d.runs : [];
    const sig = [root.id, root.thread, replies.length, runs.length, root.taskState, root.isBlocked, root.isPaused, Boolean(d.pause), Math.floor(Date.now() / 60000)].join('|');
    const existing = tv.querySelector(':scope > .w10b-thread-hero');
    if (existing && existing.getAttribute('data-sig') === sig) return;
    const wrap = existing || document.createElement('div');
    wrap.className = 'w10b-thread-hero w10b-own';
    wrap.setAttribute('data-sig', sig);
    wrap.innerHTML = threadHeroHtml(d, K, { fleetButton: true });
    if (!existing) tv.insertBefore(wrap, tv.firstChild);
  }

  /* ----------------------------------------------------- fleet overview */
  function askRows(K, list) {
    return `<div class="w10b-asks">${list
      .map((q) => `<button type="button" class="w10b-ask" data-action="inspect" data-thread-id="${K.esc(q.id)}">
          ${agentAvatar(K, { name: q.by || 'agent', handle: q.by || '', brand: q.brand, size: 28 })}
          <span class="w10b-ask-body"><span class="w10b-ask-text">${K.esc(clip(q.title || q.text, 160))}</span><span class="w10b-ask-meta k10-truncate">${K.esc([q.channel ? `#${q.channel}` : '', q.by || '', rel(toMs(q.created_at))].filter(Boolean).join(' · '))}</span></span>
        </button>`)
      .join('')}</div>`;
  }

  function fleetHtml(st, K, opts) {
    const o = opts || {};
    const allLive = liveAgents(st).slice().sort(byRecent);
    const live = allLive.slice(0, 8);
    const liveCount = allLive.filter((a) => a.activeRecent).length;
    const filter = st.agentFilter || '';
    const agentsHtml = live.length
      ? `<div class="w10b-agents" role="list">${live
          .map((a) => {
            const name = agentName(a);
            const msgs = num(a.messagesCount);
            const roomsN = num(a.channelsCount);
            const sub = [msgs != null ? `${K.fmt(msgs)} ${msgs === 1 ? 'message' : 'messages'}` : '', roomsN != null ? `${K.fmt(roomsN)} ${roomsN === 1 ? 'room' : 'rooms'}` : '']
              .filter(Boolean)
              .join(' · ');
            const on = filter && filter === a.handle;
            return `<div role="listitem"><button type="button" class="w10b-agent${on ? ' is-on' : ''}" aria-pressed="${on ? 'true' : 'false'}" data-action="filter-actor" data-actor="${K.esc(a.handle || '')}" title="${on ? 'Clear the filter' : `Show only ${K.esc(name)}`}">
              ${agentAvatar(K, { name, handle: a.handle || a.actor, brand: a.brand, size: 32 })}
              <span class="w10b-agent-body"><span class="w10b-agent-name k10-truncate">${K.esc(name)}</span><span class="w10b-agent-sub k10-truncate">${K.esc(sub || (a.role ? String(a.role) : ''))}</span></span>
              <span class="w10b-agent-seen${a.activeRecent ? ' is-live' : ''}">${a.activeRecent ? '<span class="w10b-live-dot" aria-hidden="true"></span>' : ''}${K.esc(rel(seenMs(a)) || '--')}</span>
            </button></div>`;
          })
          .join('')}</div>`
      : K.unavailable('No agent has a recorded last-seen time yet');

    const ready = blockersReady(st);
    const bl = st.blockers || {};
    const c = bl.counts || {};
    const countOf = (k) => (num(c[k]) != null ? num(c[k]) : Array.isArray(bl[k]) ? bl[k].length : null);

    const escalations = ready ? byOldest(bl.escalations) : [];
    const escHtml = !ready
      ? K.unavailable('Queues loading')
      : escalations.length
        ? askRows(K, escalations.slice(0, 4))
        : `<div class="w10b-clear">${K.icon('check', 15)}<span class="w10b-clear-text"><span class="w10b-clear-title">Nothing is escalated to you</span><span class="w10b-clear-body">No blocked thread is routed to the owner right now.</span></span></div>`;
    const escCount = ready ? countOf('escalations') : null;

    const routed = ready ? byOldest(bl.routedQueue) : [];
    const routedCount = ready ? countOf('routedQueue') : null;

    const queueHtml = ready
      ? K.bars(
          [
            { label: 'Escalated to you', value: countOf('escalations'), tone: 'orange', icon: 'inbox' },
            { label: 'Routed queue', value: countOf('routedQueue'), tone: 'violet', icon: 'brain' },
            { label: 'Paused', value: countOf('paused'), tone: 'rose', icon: 'clock' },
            { label: 'Stalled', value: countOf('stalled'), tone: 'rose', icon: 'pulse' },
            { label: 'Intake', value: countOf('intake'), tone: 'slate', icon: 'inbox' },
          ],
          {}
        )
      : K.unavailable(st.blockersError ? 'Queues unavailable' : 'Queues loading');

    const rooms = (Array.isArray(st.rooms) ? st.rooms : []).map(roomData).filter((r) => r && r.channel).sort((a, b) => (b.lastAtMs || 0) - (a.lastAtMs || 0)).slice(0, 6);
    const maxThreads = Math.max(0, ...rooms.map((r) => r.threads || 0));
    const roomsHtml = rooms.length
      ? `<div class="w10b-rooms" role="list">${rooms
          .map((r) => {
            const t = r.threads;
            const blocked = r.blockedTasks || 0;
            const pct = t != null && maxThreads > 0 ? (t / maxThreads) * 100 : 0;
            const detail = [blocked > 0 ? `${K.fmt(blocked)} blocked` : '', rel(r.lastAtMs)].filter(Boolean).join(' · ');
            return `<div role="listitem"><button type="button" class="w10b-room${blocked > 0 ? ' has-blocked' : ''}" data-action="open-room" data-room="${K.esc(r.channel)}" title="Open #${K.esc(r.channel)}">
              <span class="w10b-room-name k10-truncate">#${K.esc(r.channel)}</span>
              <span class="w10b-room-track" aria-hidden="true"><span class="w10b-room-fill" style="width:${pct.toFixed(1)}%"></span></span>
              <span class="w10b-room-val">${K.esc(K.fmt(t))}<span class="w10b-room-detail">${K.esc(detail)}</span></span>
            </button></div>`;
          })
          .join('')}</div>`
      : K.unavailable('Rooms unavailable');

    const seatHtml = seatsHtml(K, st.seats);
    const back = o.backTo
      ? `<button type="button" class="w10b-btn" data-w10b-action="back" title="Return to thread #${K.esc(o.backTo)}">${K.icon('arrow', 13)}<span>Back to thread #${K.esc(o.backTo)}</span></button>`
      : `<span class="w10b-fleet-hint">${K.icon('arrow', 13)}<span>Pick a thread from the stream to open it here.</span></span>`;

    return `<div class="w10b-fleet-top"><div class="w10b-fleet-titles"><h2 class="w10b-fleet-title">Fleet overview</h2><span class="w10b-fleet-sub">Who is working, what is waiting, where the activity is.</span></div>${back}</div>
      <section class="w10b-fleet-sec is-asks">${K.sectionHead('Escalated to you', escCount != null ? K.chip(K.fmt(escCount), escCount > 0 ? 'orange' : 'emerald') : '', { level: 3, sub: 'Blocked threads routed to the owner, oldest first.' })}${escHtml}</section>
      <section class="w10b-fleet-sec">${K.sectionHead('Who is active', live.length ? K.chip(`${liveCount} live`, 'emerald') : '', { level: 3, sub: 'Most recent first. Select one to filter the stream.' })}${agentsHtml}</section>
      ${routed.length ? `<section class="w10b-fleet-sec">${K.sectionHead('Routed queue', routedCount != null ? K.chip(K.fmt(routedCount), 'violet') : '', { level: 3, sub: 'Blocked threads routed to a triage agent, oldest first.' })}${askRows(K, routed.slice(0, 4))}</section>` : ''}
      <div class="w10b-fleet-split">
        <section class="w10b-fleet-sec">${K.sectionHead('Queues', '', { level: 3, sub: 'Items per queue, board-wide' })}${queueHtml}</section>
        <section class="w10b-fleet-sec">${K.sectionHead('Recent rooms', '', { level: 3, sub: 'Threads per room. Select to open.' })}${roomsHtml}</section>
      </div>
      ${seatHtml ? `<section class="w10b-fleet-sec">${K.sectionHead('Seat headroom', '', { level: 3, sub: 'Ring shows the share of each seat’s weekly cap used' })}${seatHtml}</section>` : ''}`;
  }

  /* -------------------------------------------------- live blockers feed */
  const own = { data: null, loadedAt: 0, error: false, inflight: false, storeRef: null };
  function refreshBlockers(force) {
    if (own.inflight) return;
    if (!force && own.loadedAt && Date.now() - own.loadedAt < BLOCKERS_TTL) return;
    own.inflight = true;
    fetch('/api/agent-board/blockers', { cache: 'no-store', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        own.data = {
          counts: (data && data.counts) || {},
          routedQueue: Array.isArray(data && data.routedQueue) ? data.routedQueue : [],
          escalations: Array.isArray(data && data.escalations) ? data.escalations : [],
          paused: Array.isArray(data && data.paused) ? data.paused : [],
          stalled: Array.isArray(data && data.stalled) ? data.stalled : [],
          intake: Array.isArray(data && data.intake) ? data.intake : [],
        };
        own.loadedAt = Date.now();
        own.error = false;
      })
      .catch(() => {
        own.error = true;
        own.loadedAt = own.loadedAt || 0;
      })
      .finally(() => {
        own.inflight = false;
        schedule();
      });
  }
  function withBlockers(st) {
    if (st.blockers !== own.storeRef) {
      /* The controller refetched (after an action or SSE event); follow it. */
      if (own.storeRef) refreshBlockers(true);
      own.storeRef = st.blockers;
    }
    refreshBlockers(false);
    return Object.assign({}, st, {
      blockers: own.data || st.blockers,
      blockersLoaded: Boolean(own.data),
      blockersError: own.error && !own.data,
    });
  }

  /* ------------------------------------------------------ fleet mounting */
  const fleetMode = { forced: false, fromId: null };

  function renderFleet(view, st, K) {
    const body = view.querySelector('.eb-stage-body');
    if (!body) return;
    if (fleetMode.forced && st.selectedThreadId && st.selectedThreadId !== fleetMode.fromId) {
      fleetMode.forced = false;
    }
    const existing = body.querySelector(':scope > .w10b-fleet');
    /* A loader with no selected thread is a stale request (for example after a room switch), so the overview replaces it too. */
    const emptyOnly =
      st.stage === 'thread' &&
      !st.threadDetail &&
      (body.querySelector(':scope > .eb-empty') || (!st.selectedThreadId && body.querySelector(':scope > .eb-loading')));
    const forced = fleetMode.forced && st.stage === 'thread';
    body.classList.toggle('w10b-fleet-forced', Boolean(forced));
    if (!emptyOnly && !forced) {
      if (existing) existing.remove();
      return;
    }
    const backTo = forced && fleetMode.fromId ? fleetMode.fromId : null;
    const html = fleetHtml(st, K, { backTo });
    const sig = `${html.length}:${hashStr(html.replace(/\d+[mhd] ago|just now/g, ''))}:${Math.floor(Date.now() / 60000)}`;
    if (existing && existing.getAttribute('data-sig') === sig) return;
    const wrap = existing || document.createElement('div');
    wrap.className = 'w10b-fleet w10b-own';
    wrap.setAttribute('data-sig', sig);
    wrap.innerHTML = html;
    if (!existing) body.insertBefore(wrap, body.firstChild);
    if (forced && body.scrollTop > 0 && !existing) body.scrollTop = 0;
  }

  /* Builders take board state shaped like KizukiAgentBoardView.getState(); the storyboard renders them with real API data.
     Pass blockersLoaded: true only when the blockers object came from /api/agent-board/blockers. */
  window.KizukiW10Board = Object.freeze({
    heroHtml: (st) => (kit() ? heroHtml(st || {}, kit()) : ''),
    threadHeroHtml: (detail, opts) => (kit() ? threadHeroHtml(detail, kit(), opts) : ''),
    fleetHtml: (st, opts) => (kit() ? fleetHtml(st || {}, kit(), opts) : ''),
    seatsHtml: (seats) => (kit() ? seatsHtml(kit(), seats) : ''),
    agentAvatar: (o) => (kit() ? agentAvatar(kit(), o || {}) : ''),
  });

  /* --------------------------------------------------------- scheduler */
  let view = null;
  let timer = 0;
  let lastRun = 0;
  let observer = null;
  const THROTTLE = 250;

  function run() {
    timer = 0;
    lastRun = Date.now();
    if (!view || view.hidden || !view.querySelector('.eb-shell')) return;
    const K = kit();
    if (!K) return;
    const raw = boardState();
    try {
      enhanceAvatars(view, K);
      normaliseLabels(view);
      if (raw) {
        const st = withBlockers(raw);
        renderHero(view, st, K);
        renderThreadHero(view, st, K);
        renderFleet(view, st, K);
      }
    } catch (err) {
      if (window.console && console.warn) console.warn('[w10 board]', err);
    }
  }
  function schedule() {
    if (timer) return;
    const wait = Math.max(0, THROTTLE - (Date.now() - lastRun));
    timer = setTimeout(run, wait);
  }
  function isOwnMutation(m) {
    const t = m.target;
    const el = t && (t.nodeType === 1 ? t : t.parentElement);
    if (el && el.closest && el.closest('.w10b-own')) return true;
    if (m.type === 'childList') {
      const nodes = Array.from(m.addedNodes).concat(Array.from(m.removedNodes));
      return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && n.classList && n.classList.contains('w10b-own'));
    }
    return false;
  }
  function onClick(e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const ownBtn = t.closest('[data-w10b-action]');
    const k10 = t.closest('[data-k10-action="w10b-blockers"]');
    if (ownBtn) {
      const act = ownBtn.getAttribute('data-w10b-action');
      const st = boardState();
      if (act === 'fleet') {
        fleetMode.forced = true;
        fleetMode.fromId = (st && st.selectedThreadId) || null;
      } else if (act === 'back') {
        fleetMode.forced = false;
      }
      schedule();
      return;
    }
    if (k10) {
      const btn = view && view.querySelector('[data-eb-mode="blockers"]');
      if (btn) btn.click();
      return;
    }
    if (fleetMode.forced && t.closest('.w10b-ask, .eb-thread-card, [data-action="inspect"], [data-action="open-tape-thread"]')) {
      fleetMode.forced = false;
      schedule();
    }
  }
  function boot() {
    view = document.getElementById('view-board');
    if (!view || observer) return;
    observer = new MutationObserver((records) => {
      if (view.hidden) return;
      if (records.every(isOwnMutation)) return;
      schedule();
    });
    observer.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-stage'] });
    view.addEventListener('click', onClick);
    schedule();
    /* Health, rooms and seats land without DOM changes; a cheap signature check picks them up. */
    setInterval(() => {
      if (view && !view.hidden && !document.hidden) schedule();
    }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
