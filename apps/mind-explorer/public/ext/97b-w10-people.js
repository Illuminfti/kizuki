/* Kizuki Wave 10: People directory + dossier depth.
   Enhances #view-people after app.js renders it. Everything shown comes from /api/people,
   /api/people/dossier and /api/people/radar, the same endpoints the view already uses (the
   net coalescer answers repeat requests from its micro-cache). Missing data renders as an
   explicit unavailable state. Visuals are generated locally by window.KizukiKit. */
(function initW10People(root) {
  'use strict';
  if (!root.document || root.__k10People) return;
  root.__k10People = true;

  const doc = root.document;
  const DIR_TTL_MS = 2 * 60 * 1000;
  const DOSSIER_TTL_MS = 10 * 60 * 1000;
  const QUIET_DAYS = 14;
  const MODE_KEY = 'kizuki.people.mode';
  const TIER_ORDER = ['family', 'core', 'warm', 'active', 'ambient'];
  const TIER_LABEL = { family: 'Family', core: 'Core', warm: 'Warm', active: 'Active', ambient: 'Ambient', other: 'No tier recorded' };
  const TIER_TONE = { family: 'rose', core: 'violet', warm: 'orange', active: 'cobalt', ambient: 'slate', other: 'slate' };
  const CHANNEL_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram', imessage: 'iMessage', gmail: 'Gmail', calendar: 'Calendar' };
  // Plain-text placeholder the kit escapes unchanged; swapped for the status marks after.
  const SEEN_TOKEN = 'K10PSEENSUB';
  const CHANNEL_TONE = { whatsapp: 'emerald', telegram: 'cobalt', imessage: 'cobalt', gmail: 'rose', calendar: 'violet' };

  const st = {
    people: new Map(), // key(lower) -> item from /api/people
    dirSummary: null, // { total, profiled, core, channels, inner[], at } or { error, at }
    dirLoading: null,
    listUrls: new Map(), // url -> { at, failed }
    dossiers: new Map(), // key(lower) -> dossier (or { error, __k10pAt, tries })
    dossierLoading: new Map(),
    radar: null, // Map key(lower) -> { owed, drift, upcoming } or { error }
    radarLoading: null,
    mode: readMode(),
    galleryScroll: 0,
    scheduled: false,
  };

  function K() {
    return root.KizukiKit || null;
  }

  function readMode() {
    try {
      const v = root.localStorage.getItem(MODE_KEY);
      return v === 'cards' || v === 'faces' ? 'cards' : 'list';
    } catch (_) {
      return 'list';
    }
  }

  function writeMode(v) {
    try {
      root.localStorage.setItem(MODE_KEY, v);
    } catch (_) {
      /* storage blocked: mode stays per page load */
    }
  }

  function view() {
    return doc.getElementById('view-people');
  }

  function isActive() {
    const v = view();
    return Boolean(v && !v.hidden);
  }

  function tierKey(raw) {
    const t = String(raw || '').trim().toLowerCase();
    return TIER_ORDER.includes(t) ? t : 'other';
  }

  function num(v) {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  /* Initials discs (like Today and the radar) unless the API sends a real image. */
  function av(person, size, ring) {
    return K().avatar(person, { size, ring: ring || null, mode: 'initials' });
  }

  function personObj(item, fallbackName) {
    const o = { name: (item && item.name) || fallbackName || '' };
    if (item) {
      o.key = item.key;
      if (item.avatar_url) o.avatar_url = item.avatar_url;
      if (item.photo) o.photo = item.photo;
    }
    return o;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function absorbPeople(res) {
    const items = Array.isArray(res && res.items) ? res.items : Array.isArray(res && res.people) ? res.people : [];
    items.forEach((p) => {
      if (p && p.key) st.people.set(String(p.key).toLowerCase(), p);
    });
    return items;
  }

  /* Same URL app.js builds in loadPeople(), so the coalescer can answer it. */
  function currentListUrl() {
    const v = view();
    const params = new URLSearchParams();
    const q = v && v.querySelector('#people-search');
    if (q && q.value.trim()) params.set('q', q.value.trim());
    const pill = v && v.querySelector('#people-channel-pills .channel-pill.is-active[data-people-ch]');
    params.set('channel', (pill && pill.getAttribute('data-people-ch')) || 'all');
    params.set('limit', '80');
    return '/api/people?' + params.toString();
  }

  function daysSince(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return null;
    return (now - t) / 86400000;
  }

  /* Inner circle = every Family and Core person (channel=core lists all of them). */
  function innerStats(items, now) {
    const list = Array.isArray(items) ? items.filter((p) => p && p.key) : [];
    const quiet = [];
    let touched = 0;
    list.forEach((p) => {
      const d = daysSince(p.last_seen_iso || p.last_seen, now);
      if (d != null && d <= QUIET_DAYS) touched += 1;
      else quiet.push(p);
    });
    const fam = list.filter((p) => tierKey(p.relationship_tier) === 'family').length;
    return { total: list.length, touched, quiet, family: fam, core: list.length - fam };
  }

  function loadDirectory(force) {
    const fresh = st.dirSummary && Date.now() - st.dirSummary.at < DIR_TTL_MS;
    if (fresh && !force) return Promise.resolve(st.dirSummary);
    if (st.dirLoading) return st.dirLoading;
    const allUrl = '/api/people?channel=all&limit=80';
    st.dirLoading = Promise.all([getJson(allUrl), getJson('/api/people?channel=core&limit=80').catch(() => null)])
      .then(([res, core]) => {
        absorbPeople(res);
        if (core) absorbPeople(core);
        st.listUrls.set(allUrl, { at: Date.now() });
        const now = Date.now();
        st.dirSummary = {
          total: num(res.total),
          profiled: num(res.profiled_count),
          core: num(res.core_count),
          channels: Array.isArray(res.channels) ? res.channels : [],
          inner: core && Array.isArray(core.items) ? innerStats(core.items, now) : null,
          at: now,
        };
        return st.dirSummary;
      })
      .catch(() => {
        st.dirSummary = { error: true, at: Date.now(), channels: [], inner: null };
        return st.dirSummary;
      })
      .finally(() => {
        st.dirLoading = null;
      });
    return st.dirLoading;
  }

  function ensureListData() {
    const url = currentListUrl();
    const seen = st.listUrls.get(url);
    // A failed request waits 30s before retrying, so a struggling server is not hammered.
    if (seen && (!seen.failed || Date.now() - seen.at < 30000)) return;
    st.listUrls.set(url, { at: Date.now() });
    getJson(url)
      .then((res) => {
        absorbPeople(res);
        schedule();
      })
      .catch(() => st.listUrls.set(url, { at: Date.now(), failed: true }));
  }

  function loadRadar() {
    if (st.radar || st.radarLoading) return;
    st.radarLoading = getJson('/api/people/radar')
      .then((res) => {
        const m = new Map();
        const mark = (arr, field, val) => {
          (Array.isArray(arr) ? arr : []).forEach((r) => {
            if (!r || !r.key) return;
            const k = String(r.key).toLowerCase();
            const e = m.get(k) || {};
            e[field] = val(r);
            m.set(k, e);
          });
        };
        mark(res && res.owed_replies, 'owed', (r) => r.reason || 'Reply owed');
        mark(res && res.drifting, 'drift', (r) => r.reason || 'Quieter than usual');
        mark(res && res.upcoming_touch, 'upcoming', (r) => r.reason || 'Upcoming');
        st.radar = m;
      })
      .catch(() => {
        st.radar = { error: true };
      })
      .finally(() => {
        st.radarLoading = null;
        schedule();
      });
  }

  function loadDossier(key) {
    const k = String(key || '').toLowerCase();
    if (!k) return Promise.resolve(null);
    if (st.dossierLoading.has(k)) return st.dossierLoading.get(k);
    const prev = st.dossiers.get(k);
    const tries = prev && prev.error ? prev.tries || 1 : 0;
    const p = getJson('/api/people/dossier?key=' + encodeURIComponent(key) + '&limit=80&offset=0')
      .then((res) => {
        if (res && typeof res === 'object') res.__k10pAt = Date.now();
        st.dossiers.set(k, res);
        if (res && res.person && res.person.key) st.dossiers.set(String(res.person.key).toLowerCase(), res);
        return res;
      })
      .catch(() => {
        // Stamp failures so the retry backs off (30s, 60s, 120s, capped at 5 min).
        st.dossiers.set(k, { error: true, __k10pAt: Date.now(), tries: tries + 1 });
        return st.dossiers.get(k);
      })
      .finally(() => st.dossierLoading.delete(k));
    st.dossierLoading.set(k, p);
    return p;
  }

  /* ------------------------------------------------------------------ hero */
  function ringCell(o) {
    const kit = K();
    const tag = o.action ? 'button type="button"' : 'div';
    const close = o.action ? 'button' : 'div';
    return (
      '<' + tag + ' class="k10p-kpi' + (o.action ? ' is-action' : '') + '"' + (o.action ? ' data-k10p-act="' + kit.esc(o.action) + '"' : '') + '>' +
      kit.ring(o.pct, o.tone, { size: 34, stroke: 3.5, label: o.ringLabel, aria: o.aria }) +
      '<span class="k10p-kpi-text">' +
      '<span class="k10p-kpi-label">' + kit.esc(o.label) + '</span>' +
      '<span class="k10p-kpi-sub">' + o.sub + '</span>' +
      '</span>' +
      '</' + close + '>'
    );
  }

  function heroCellsHtml(sum) {
    const kit = K();
    const loading = !sum;
    const err = sum && sum.error;
    if (err) {
      return '<div class="k10p-kpi is-error">' + kit.icon('alert', 14) + '<span class="k10p-kpi-label">Directory summary unavailable</span></div>';
    }
    const total = loading ? null : sum.total;
    const prof = loading ? null : sum.profiled;
    const profPct = total && prof != null ? Math.round((prof / total) * 100) : null;
    const cells = [
      ringCell({
        pct: profPct,
        tone: 'cobalt',
        ringLabel: profPct == null ? '--' : profPct + '%',
        aria: profPct == null ? 'Profiled share unavailable' : profPct + '% of people have a profiled dossier',
        label: 'Profiled dossiers',
        sub: '<b>' + kit.esc(kit.fmt(prof)) + '</b> of ' + kit.esc(kit.fmt(total)) + ' people',
      }),
    ];
    const inner = loading ? null : sum.inner;
    if (inner && inner.total) {
      const pct = Math.round((inner.touched / inner.total) * 100);
      const q = inner.quiet.length;
      cells.push(
        ringCell({
          pct,
          tone: q ? 'orange' : 'emerald',
          ringLabel: String(inner.touched),
          aria: inner.touched + ' of ' + inner.total + ' family and core people contacted in the last ' + QUIET_DAYS + ' days',
          label: 'Family and core in touch',
          sub:
            '<b>' + inner.touched + '</b> of ' + inner.total + ' in ' + QUIET_DAYS + ' days' +
            (q ? '<span class="k10p-kpi-flag">' + q + ' quiet</span>' : ''),
          action: 'show-core',
        })
      );
    } else {
      cells.push(
        ringCell({
          pct: null,
          tone: 'slate',
          ringLabel: '--',
          aria: 'Family and core contact unavailable',
          label: 'Family and core in touch',
          sub: loading ? 'Loading' : 'Unavailable',
        })
      );
    }
    const channels = loading ? [] : sum.channels.filter((c) => num(c.count) != null);
    const max = channels.reduce((m, c) => Math.max(m, num(c.count)), 0);
    cells.push(
      '<div class="k10p-reach" role="group" aria-label="People per channel">' +
      '<span class="k10p-kpi-label">People per channel</span>' +
      (channels.length
        ? '<ul class="k10p-reach-list">' +
          channels
            .map((c) => {
              const n = num(c.count);
              const t = CHANNEL_TONE[c.id] || 'slate';
              const lbl = c.label || CHANNEL_LABEL[c.id] || c.id;
              return (
                '<li class="k10p-reach-item k10-tone-' + t + '" title="' + kit.esc(lbl + ': ' + n + ' people') + '">' +
                '<span class="k10p-reach-col" aria-hidden="true"><span style="height:' + (max ? Math.max(8, Math.round((n / max) * 100)) : 0) + '%"></span></span>' +
                '<span class="k10p-reach-val">' + kit.fmt(n) + '</span>' +
                '<span class="k10p-reach-label">' + kit.esc(lbl) + '</span>' +
                '</li>'
              );
            })
            .join('') +
          '</ul>'
        : '<span class="k10p-kpi-sub">' + (loading ? 'Loading' : 'Unavailable') + '</span>') +
      '</div>'
    );
    return cells.join('');
  }

  function modeSwitchHtml() {
    const kit = K();
    return (
      '<div class="k10p-mode" role="group" aria-label="Directory layout">' +
      '<button type="button" class="k10p-mode-btn" data-k10p-mode="list" aria-pressed="' + (st.mode === 'list') + '">' + kit.icon('layers', 13) + 'List</button>' +
      '<button type="button" class="k10p-mode-btn" data-k10p-mode="cards" aria-pressed="' + (st.mode === 'cards') + '">' + kit.icon('people', 13) + 'Cards</button>' +
      '</div>'
    );
  }

  function heroHtml(sum) {
    return (
      '<div class="k10p-hero-row">' +
      '<div class="k10p-kpis" data-k10p-cells>' + heroCellsHtml(sum) + '</div>' +
      '<div class="k10p-hero-mode">' + modeSwitchHtml() + '</div>' +
      '</div>'
    );
  }

  function ensureHero() {
    const v = view();
    const kit = K();
    if (!v || !kit) return;
    let hero = v.querySelector(':scope > .k10p-hero');
    if (!hero) {
      hero = doc.createElement('div');
      hero.className = 'k10p-hero';
      hero.setAttribute('data-k10p', 'hero');
      hero.innerHTML = heroHtml(st.dirSummary);
      hero.__at = st.dirSummary ? st.dirSummary.at : -1;
      v.prepend(hero);
    }
    if (!st.dirSummary || Date.now() - st.dirSummary.at > DIR_TTL_MS) {
      loadDirectory(Boolean(st.dirSummary)).then(schedule);
    }
    const at = st.dirSummary ? st.dirSummary.at : -1;
    if (hero.__at !== at) {
      // Only the figures are replaced; the List / Cards switch keeps its node and focus.
      const cells = hero.querySelector('[data-k10p-cells]');
      if (cells) cells.innerHTML = heroCellsHtml(st.dirSummary);
      hero.__at = at;
    }
    syncModeButtons(hero);
  }

  function syncModeButtons(scope) {
    (scope || doc).querySelectorAll('[data-k10p-mode]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-k10p-mode') === st.mode));
    });
  }

  /* ------------------------------------------------------------- list rows */
  function enhanceRows() {
    const kit = K();
    const list = doc.getElementById('people-list');
    if (!kit || !list) return;
    let missing = false;
    list.querySelectorAll('.person-row[data-person-key]').forEach((row) => {
      const key = row.getAttribute('data-person-key') || '';
      const item = st.people.get(key.toLowerCase());
      if (!item) missing = true;
      const sig = (item ? 'd' : 'n') + key;
      if (row.getAttribute('data-k10p') === sig) return;
      const slot = row.querySelector('.person-avatar');
      if (!slot) return;
      const nameEl = row.querySelector('.person-row-name');
      const name = (item && item.name) || (nameEl && nameEl.textContent) || key;
      const tier = tierKey(item && item.relationship_tier);
      const ring = tier === 'family' || tier === 'core' ? TIER_TONE[tier] : null;
      slot.classList.add('k10p-av-slot');
      slot.innerHTML = av(personObj(item, name), 32, ring);
      row.setAttribute('data-k10p', sig);
    });
    if (missing) ensureListData();
  }

  /* ----------------------------------------------------------------- cards */
  function galleryPeople() {
    const list = doc.getElementById('people-list');
    const rows = list ? Array.from(list.querySelectorAll('.person-row[data-person-key]')) : [];
    const radar = st.radar && !st.radar.error ? st.radar : null;
    return rows.map((row) => {
      const key = row.getAttribute('data-person-key') || '';
      const item = st.people.get(key.toLowerCase());
      const nameEl = row.querySelector('.person-row-name');
      const roleEl = row.querySelector('.person-role-line');
      const timeEl = row.querySelector('.person-row-time');
      return {
        key,
        item,
        name: (item && item.name) || (nameEl && nameEl.textContent) || key,
        role: item ? [item.role, item.org].filter(Boolean).join(' · ') : (roleEl && roleEl.textContent) || '',
        lastSeen: (item && item.last_seen_label) || (timeEl && timeEl.textContent) || '',
        tier: item ? tierKey(item.relationship_tier) : 'loading',
        signal: radar ? radar.get(key.toLowerCase()) || null : null,
        selected: row.classList.contains('is-selected'),
      };
    });
  }

  function signalHtml(sig) {
    const kit = K();
    if (!sig) return '';
    if (sig.owed) return '<span class="k10p-sig k10-tone-orange" title="' + kit.esc(sig.owed) + '">' + kit.icon('chat', 12) + 'Reply owed</span>';
    if (sig.drift) return '<span class="k10p-sig k10-tone-rose" title="' + kit.esc(sig.drift) + '">' + kit.icon('pulse', 12) + 'Quieter than usual</span>';
    if (sig.upcoming) return '<span class="k10p-sig k10-tone-cobalt" title="' + kit.esc(sig.upcoming) + '">' + kit.icon('calendar', 12) + 'Meeting soon</span>';
    return '';
  }

  function faceCard(p) {
    const kit = K();
    if (p.tier === 'loading' || !p.item) {
      return (
        '<button type="button" class="k10p-card is-loading" data-k10p-open="' + kit.esc(p.key) + '" aria-busy="true">' +
        '<span class="k10p-card-top">' + av({ name: p.name }, 40) +
        '<span class="k10p-card-id"><span class="k10p-card-name k10-truncate">' + kit.esc(p.name) + '</span>' +
        '<span class="k10p-card-role k10p-dim">Loading details</span></span></span>' +
        '<span class="k10p-card-foot"><span class="k10p-skel" aria-hidden="true"></span></span>' +
        '</button>'
      );
    }
    const it = p.item;
    const t = TIER_TONE[p.tier];
    const chans = Array.isArray(it.channels) ? it.channels : [];
    const counts = [];
    const msgs = num(it.message_count);
    const claims = num(it.claim_count);
    const mtgs = num(it.meeting_count);
    if (msgs) counts.push('<span><b>' + kit.fmt(msgs) + '</b> ' + plural(msgs, 'msg', 'msgs') + '</span>');
    if (claims) counts.push('<span><b>' + kit.fmt(claims) + '</b> ' + plural(claims, 'fact', 'facts') + '</span>');
    if (mtgs) counts.push('<span><b>' + kit.fmt(mtgs) + '</b> ' + plural(mtgs, 'mtg', 'mtgs') + '</span>');
    const dots = chans
      .map((c) => '<span class="k10p-ch k10-tone-' + (CHANNEL_TONE[c] || 'slate') + '" title="' + kit.esc(CHANNEL_LABEL[c] || c) + '"></span>')
      .join('');
    const ring = p.tier === 'family' || p.tier === 'core' ? t : null;
    return (
      '<button type="button" class="k10p-card' + (p.selected ? ' is-selected' : '') + '" data-k10p-open="' + kit.esc(p.key) + '">' +
      '<span class="k10p-card-top">' + av(personObj(p.item, p.name), 40, ring) +
      '<span class="k10p-card-id">' +
      '<span class="k10p-card-name k10-truncate">' + kit.esc(p.name) + '</span>' +
      '<span class="k10p-card-role">' + (p.role ? kit.esc(p.role) : '<span class="k10p-dim">No role recorded</span>') + '</span>' +
      '</span></span>' +
      (p.signal ? '<span class="k10p-card-sig">' + signalHtml(p.signal) + '</span>' : '') +
      '<span class="k10p-card-foot">' +
      '<span class="k10p-card-counts">' + (counts.length ? counts.join('') : '<span class="k10p-dim">No indexed activity</span>') + '</span>' +
      '<span class="k10p-card-seen">' +
      (dots ? '<span class="k10p-card-dots" aria-label="Channels: ' + kit.esc(chans.map((c) => CHANNEL_LABEL[c] || c).join(', ')) + '">' + dots + '</span>' : '') +
      kit.esc(p.lastSeen || '--') +
      '</span>' +
      '</span>' +
      '</button>'
    );
  }

  function circlesHtml(groups) {
    const kit = K();
    return (
      '<div class="k10p-circles" role="list" aria-label="Shown people by circle">' +
      groups
        .map(
          (g) =>
            '<div class="k10p-circle k10-tone-' + (TIER_TONE[g.t] || 'slate') + '" role="listitem" style="flex-grow:' + g.list.length + '">' +
            '<span class="k10p-circle-bar" aria-hidden="true"></span>' +
            '<span class="k10p-circle-label">' + kit.esc(TIER_LABEL[g.t] || 'Loading') + ' <b>' + g.list.length + '</b></span>' +
            '</div>'
        )
        .join('') +
      '</div>'
    );
  }

  function galleryEmptyHtml() {
    return K().emptyState({
      title: 'No people to show',
      body: 'The current search and filter match nobody.',
      icon: 'people',
    });
  }

  function gallerySub(shown, total, signals) {
    const bits = [shown + ' shown' + (total != null && total > shown ? ' of ' + K().fmt(total) : '') + ', in activity order'];
    if (signals) bits.push(signals + ' need' + (signals === 1 ? 's' : '') + ' you');
    return bits.join(' · ');
  }

  /* Family and core heads say how many of the whole circle this page shows. */
  function groupCount(g) {
    const inner = st.dirSummary && st.dirSummary.inner;
    const all = inner ? (g.t === 'family' ? inner.family : g.t === 'core' ? inner.core : null) : null;
    return all != null && all > g.list.length ? g.list.length + ' of ' + all : String(g.list.length);
  }

  function renderGallery() {
    const v = view();
    const kit = K();
    if (!v || !kit) return;
    let gal = v.querySelector(':scope > .k10p-gallery');
    if (!gal) {
      gal = doc.createElement('section');
      gal.className = 'k10p-gallery';
      gal.setAttribute('aria-label', 'People cards');
      v.appendChild(gal);
    }
    loadRadar();
    const people = galleryPeople();
    const totalEl = doc.getElementById('people-total-count');
    const total = totalEl ? num(String(totalEl.textContent || '').replace(/[^\d.]/g, '')) : null;
    const sig =
      (st.radar ? (st.radar.error ? 'e' : 'r') : '-') +
      (st.dirSummary ? st.dirSummary.at : 0) +
      '|' +
      total +
      '|' +
      people.map((p) => p.key + p.tier[0] + (p.selected ? 's' : '')).join(',');
    if (gal.__sig === sig) return;
    gal.__sig = sig;
    if (!people.length) {
      gal.innerHTML = '<div class="k10p-gallery-inner">' + galleryEmptyHtml() + '</div>';
      return;
    }
    const groups = TIER_ORDER.concat(['other', 'loading'])
      .map((t) => ({ t, list: people.filter((p) => p.tier === t) }))
      .filter((g) => g.list.length);
    const signals = people.filter((p) => p.signal && (p.signal.owed || p.signal.drift)).length;
    gal.innerHTML =
      '<div class="k10p-gallery-inner">' +
      kit.sectionHead('People by circle', '', { sub: gallerySub(people.length, total, signals) }) +
      circlesHtml(groups) +
      groups
        .map(
          (g) =>
            '<section class="k10p-group" aria-label="' + kit.esc(TIER_LABEL[g.t] || 'Loading details') + '">' +
            kit.sectionHead(TIER_LABEL[g.t] || 'Loading details', '<span class="k10p-count">' + groupCount(g) + '</span>', { level: 3 }) +
            '<div class="k10p-cards">' + g.list.map(faceCard).join('') + '</div>' +
            '</section>'
        )
        .join('') +
      '</div>';
  }

  function applyMode() {
    const v = view();
    if (!v) return;
    const was = v.classList.contains('k10p-is-cards');
    v.classList.toggle('k10p-is-cards', st.mode === 'cards');
    syncModeButtons(v);
    if (st.mode === 'cards') {
      renderGallery();
      if (!was) {
        const gal = v.querySelector(':scope > .k10p-gallery');
        if (gal) gal.scrollTop = st.galleryScroll;
      }
    }
  }

  /* --------------------------------------------------------------- dossier */
  function selectedKey() {
    try {
      const u = new URL(root.location.href);
      return u.searchParams.get('person') || '';
    } catch (_) {
      return '';
    }
  }

  function healthHtml(d) {
    const kit = K();
    const p = (d && d.person) || {};
    const pv = (d && d.profile_visuals) || {};
    const rec = pv.reciprocity_ratio || null;
    const ledger = pv.ledger || {};
    const weeks = Array.isArray(ledger.weeks) ? ledger.weeks : [];

    // Messages: direct messages only (the ledger's in + out), never meetings.
    const msgs = num(p.message_count != null ? p.message_count : d && d.timeline_total);
    const weekMsgs = weeks.map((w) => (num(w && w.in) || 0) + (num(w && w.out) || 0));
    const yearMsgs = weekMsgs.reduce((a, b) => a + b, 0);
    const msgSub = !weeks.length
      ? 'No weekly ledger'
      : yearMsgs > 0
        ? kit.fmt(yearMsgs) + ' in the last ' + weeks.length + ' weeks'
        : 'No direct messages in the last ' + weeks.length + ' weeks';

    // Your share: only when there is at least one message with a known direction.
    const youN = rec ? num(rec.you_count) : null;
    const themN = rec ? num(rec.them_count) : null;
    const dirTotal = (youN || 0) + (themN || 0);
    const youPct = rec && dirTotal > 0 ? num(rec.you_pct) : null;

    // Last contact: reply owed and drift come first, then streak, then usual gap.
    const streak = num(ledger.streak_weeks);
    const gap = num(ledger.median_gap_days);
    const drift = num(ledger.drift_z);
    const owed = ledger.last_inbound_unanswered === true;
    const drifting = drift != null && drift > 1.5;
    const seenBits = [];
    if (owed) seenBits.push('<span class="k10p-warn k10-tone-orange">Reply owed</span>');
    if (drifting) seenBits.push('<span class="k10p-warn k10-tone-rose">Quieter than usual</span>');
    if (streak && streak > 0) seenBits.push(kit.esc(streak + '-week streak'));
    else if (gap && gap > 0) seenBits.push(kit.esc('Usually every ' + (gap < 10 ? gap.toFixed(1).replace(/\.0$/, '') : Math.round(gap)) + 'd'));
    else if (p.history_span_label) seenBits.push(kit.esc('Known ' + p.history_span_label));

    const claims = num(d && d.sqlite_claims_total != null ? d.sqlite_claims_total : p.claim_count);
    const mtgs = d && Array.isArray(d.meetings) ? d.meetings.length : num(p.meeting_count);
    const docs = d && Array.isArray(d.related_docs) ? d.related_docs.length : null;

    const tiles = [
      kit.statTile({
        label: 'Messages',
        value: msgs,
        icon: 'chat',
        tone: 'cobalt',
        sub: msgSub,
        spark:
          weeks.length >= 2 && yearMsgs > 0
            ? kit.sparkline(weekMsgs, { width: 96, height: 28, tone: 'cobalt', aria: 'Messages per week, last ' + weeks.length + ' weeks' })
            : '',
      }),
      kit.statTile({
        label: 'Your share',
        value: youPct,
        unit: youPct == null ? '' : '%',
        icon: 'pulse',
        tone: 'violet',
        sub: youPct == null ? 'No direction data' : kit.fmt(youN) + ' from you · ' + kit.fmt(themN) + ' from them',
        spark:
          youPct == null
            ? ''
            : '<span class="k10p-split" role="img" aria-label="You sent ' + youPct + '% of messages">' +
              '<span class="k10p-split-you" style="width:' + Math.max(0, Math.min(100, youPct)) + '%"></span></span>',
      }),
      kit.statTile({
        label: 'Last contact',
        value: p.last_seen_label || null,
        icon: 'clock',
        tone: owed ? 'orange' : 'emerald',
        sub: seenBits.length ? SEEN_TOKEN : '',
      }).replace(SEEN_TOKEN, seenBits.join('<span class="k10p-sep" aria-hidden="true">·</span>')),
      kit.statTile({
        label: 'Known facts',
        value: claims,
        icon: 'brain',
        tone: 'orange',
        sub: [mtgs != null ? kit.fmt(mtgs) + plural(mtgs, ' meeting', ' meetings') : '', docs != null ? kit.fmt(docs) + plural(docs, ' doc', ' docs') : '']
          .filter(Boolean)
          .join(' · '),
      }),
    ];

    const nextTouch = ledger.next_touch ? String(ledger.next_touch) : '';

    const chans = Array.isArray(pv.channel_breakdown) ? pv.channel_breakdown : [];
    const chanBody = chans.length
      ? kit.bars(
          chans.map((c) => ({
            label: c.label || CHANNEL_LABEL[c.channel] || c.channel,
            value: num(c.count),
            tone: CHANNEL_TONE[c.channel] || 'slate',
            display: kit.fmt(num(c.count)) + (num(c.pct) != null ? ' · ' + num(c.pct) + '%' : ''),
          })),
          { empty: 'No channel history' }
        )
      : kit.unavailable('No channel history');

    const collabs = d && Array.isArray(d.collaborators) ? d.collaborators.filter((c) => c && (c.name || c.key)) : [];
    const circleBody = collabs.length
      ? '<div class="k10p-collabs">' +
        collabs
          .slice(0, 5)
          .map((c) => {
            const key = c.key || c.slug || '';
            const shared = num(c.shared_events);
            const row = kit.personRow(
              { name: c.name || key, key, avatar_url: c.avatar_url, photo: c.photo },
              {
                sub: c.note || '',
                right: shared != null ? kit.fmt(shared) : '',
                rightSub: shared != null ? plural(shared, 'shared event', 'shared events') : '',
                action: key ? 'open-person' : '',
                size: 26,
              }
            );
            return key ? row.replace('data-k10-action="open-person"', 'data-k10-action="open-person" data-open-person="' + kit.esc(key) + '"') : row;
          })
          .join('') +
        '</div>' +
        (collabs.length > 5
          ? '<button type="button" class="k10p-more" data-dossier-tab="network">' + (collabs.length - 5) + ' more in Network and loops' + kit.icon('arrow', 12) + '</button>'
          : '')
      : kit.emptyState({ title: 'No shared circle yet', body: 'Nobody else appears in meetings or threads with this person.', icon: 'people', compact: true });

    return (
      '<section class="k10p-health" aria-label="Relationship health">' +
      (nextTouch ? '<p class="k10p-next">' + kit.icon('arrow', 13) + '<span>' + kit.esc(nextTouch) + '</span></p>' : '') +
      '<div class="k10-grid-4 k10p-tiles">' + tiles.join('') + '</div>' +
      '<div class="k10-grid-2 k10p-pair">' +
      kit.card({ title: 'Channel mix', sub: chans.length ? 'Where the conversation happens' : '', body: chanBody }) +
      kit.card({
        title: 'Shared circle',
        sub: collabs.length ? collabs.length + plural(collabs.length, ' person', ' people') + ' seen together' : '',
        right: collabs.length ? kit.avatarStack(collabs.map((c) => ({ name: c.name || c.key, avatar_url: c.avatar_url, photo: c.photo })), { max: 4, size: 22, mode: 'initials' }) : '',
        body: circleBody,
      }) +
      '</div>' +
      '</section>'
    );
  }

  /* Cover band built from the real weekly cadence: one bar per week, height = interactions. */
  function coverHtml(d, key, tier) {
    const kit = K();
    const pv = (d && d.profile_visuals) || {};
    const cad = Array.isArray(pv.cadence_series) ? pv.cadence_series : [];
    const t = TIER_TONE[tier] || 'slate';
    const vals = cad.map((w) => num(w && w.total) || 0);
    const max = vals.reduce((m, v) => Math.max(m, v), 0);
    let ridge = '';
    if (vals.length >= 2 && max > 0) {
      const W = 320;
      const H = 48;
      const step = W / vals.length;
      ridge =
        '<svg class="k10p-cover-ridge" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
        vals
          .map((v, i) => {
            const h = v > 0 ? Math.max(2, (v / max) * (H - 4)) : 1;
            return '<rect x="' + (i * step + step * 0.18).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + (step * 0.64).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5"' + (i === vals.length - 1 ? ' class="is-now"' : v > 0 ? '' : ' class="is-zero"') + '/>';
          })
          .join('') +
        '</svg>';
    }
    const first = cad[0] && cad[0].week_label;
    const last = cad.length ? cad[cad.length - 1].week_label : '';
    const caption = ridge
      ? '<span class="k10p-cover-cap">Interactions per week' + (first && last ? ', ' + kit.esc(first) + ' to ' + kit.esc(last) : '') + '<b>Peak ' + kit.fmt(max) + '</b><i>Latest ' + kit.fmt(vals[vals.length - 1]) + '</i></span>'
      : '<span class="k10p-cover-cap">No weekly cadence recorded</span>';
    return (
      '<div class="k10p-cover k10-tone-' + t + (ridge ? '' : ' is-empty') + '" role="img" aria-label="' +
      kit.esc(ridge ? 'Interactions per week, messages and meetings, peak ' + max + ' in a week' : 'No weekly cadence recorded') +
      '" data-k10p-seed="' + kit.esc(key || '') + '">' +
      ridge +
      caption +
      '</div>'
    );
  }

  function enhanceDossier() {
    const kit = K();
    const body = doc.getElementById('people-detail-body');
    if (!kit || !body) return;
    const bannerEl = body.querySelector('.profile-banner');
    if (!bannerEl) return;
    const avEl = bannerEl.querySelector('.profile-avatar-xl');
    // Loading skeleton has no avatar; wait for the real dossier.
    if (!avEl) return;
    const key = selectedKey();
    if (!key) return;
    const k = key.toLowerCase();
    let d = st.dossiers.get(k);
    if (d && d.error) {
      const wait = Math.min(300000, 30000 * Math.pow(2, Math.max(0, (d.tries || 1) - 1)));
      // Failures are stamped, so a re-render inside the backoff window never refetches.
      if (Date.now() - d.__k10pAt < wait) return;
      d = null;
    } else if (d && bannerEl.getAttribute('data-k10p') !== k && Date.now() - (d.__k10pAt || 0) > DOSSIER_TTL_MS) {
      d = null;
    }
    if (!d) {
      if (!st.dossierLoading.has(k)) {
        loadDossier(key).then((res) => {
          // After a failure, wake once the backoff has passed so the retry is not left to chance.
          if (res && res.error) setTimeout(schedule, Math.min(300000, 30000 * Math.pow(2, Math.max(0, res.tries - 1))) + 50);
          else schedule();
        });
      }
      return;
    }
    const p = d.person || {};
    const tier = tierKey(p.relationship_tier || (d.world_model && d.world_model.relationship_tier) || p.tier);
    if (bannerEl.getAttribute('data-k10p') !== k) {
      bannerEl.setAttribute('data-k10p', k);
      bannerEl.classList.add('k10p-banner');
      bannerEl.insertAdjacentHTML('afterbegin', coverHtml(d, p.key || key, tier));
      avEl.classList.add('k10p-av-xl');
      avEl.innerHTML = av(personObj(p, p.name || key), 72, tier === 'family' || tier === 'core' ? TIER_TONE[tier] : 'slate');
    }
    if (!body.querySelector('.k10p-health')) {
      bannerEl.insertAdjacentHTML('afterend', healthHtml(d));
    }
  }

  /* ------------------------------------------------------------ scheduling */
  function run() {
    st.scheduled = false;
    if (!isActive() || !K()) return;
    ensureHero();
    enhanceRows();
    enhanceDossier();
    applyMode();
  }

  function schedule() {
    if (st.scheduled) return;
    st.scheduled = true;
    (root.requestAnimationFrame || setTimeout)(run);
  }

  function setMode(m) {
    const v = view();
    const gal = v && v.querySelector(':scope > .k10p-gallery');
    if (st.mode === 'cards' && gal) st.galleryScroll = gal.scrollTop;
    st.mode = m === 'cards' ? 'cards' : 'list';
    writeMode(st.mode);
    applyMode();
  }

  function onClick(e) {
    const modeBtn = e.target.closest('[data-k10p-mode]');
    if (modeBtn && view() && view().contains(modeBtn)) {
      setMode(modeBtn.getAttribute('data-k10p-mode'));
      return;
    }
    const act = e.target.closest('[data-k10p-act="show-core"]');
    if (act) {
      setMode('list');
      const pill = doc.querySelector('#people-channel-pills [data-people-ch="core"]');
      if (pill && !pill.classList.contains('is-active')) pill.click();
      return;
    }
    const card = e.target.closest('[data-k10p-open]');
    if (card && view() && view().contains(card)) {
      const key = card.getAttribute('data-k10p-open');
      setMode('list');
      const row = Array.from(doc.querySelectorAll('#people-list .person-row[data-person-key]')).find(
        (r) => r.getAttribute('data-person-key') === key
      );
      if (row) {
        row.click();
        row.focus({ preventScroll: false });
      }
    }
  }

  // Pure renderers, shared with the storyboard catalog (public/storyboard/people.html).
  root.KizukiW10People = Object.freeze({
    heroHtml,
    innerStats,
    faceCard,
    circlesHtml,
    galleryEmptyHtml,
    gallerySub,
    coverHtml,
    healthHtml,
    tierTone: (t) => TIER_TONE[tierKey(t)],
    avatar: (person, size, ring) => av(person, size, ring),
  });

  function start() {
    const v = view();
    // Only the real app view panel; the storyboard catalog reuses the id for scoping.
    if (!v || !v.classList.contains('view-panel')) return;
    const mo = new MutationObserver(schedule);
    mo.observe(v, { childList: true, subtree: true });
    const viewMo = new MutationObserver(schedule);
    viewMo.observe(v, { attributes: true, attributeFilter: ['hidden'] });
    v.addEventListener('click', onClick);
    const refresh = doc.getElementById('btn-people-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        st.dossiers.clear();
        st.listUrls.clear();
        st.radar = null;
        loadDirectory(true).then(schedule);
      });
    }
    // A synthesize/deepen action rewrites the dossier: drop the cached copy for that person.
    doc.addEventListener('click', (e) => {
      const syn = e.target.closest('[data-synthesize-person], #btn-people-synthesize');
      if (syn) st.dossiers.delete(selectedKey().toLowerCase());
    });
    schedule();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
