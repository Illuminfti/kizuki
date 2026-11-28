/* Wave 10: World Atlas depth layer.
   Enhances #view-atlas after app.js renders it: a Today-style overview (one stat tile per API
   panel, an honest coverage chip and note), an activity card (24h sparkline plus freshness),
   people in play, sentence-case panel heads, age-tinted row meta, cross-panel notes, any API
   panel app.js does not render (for example corrections), and world-object claim meters.
   Every number comes from GET /api/atlas. Capped slices show as "10+", never as totals.
   Rows are matched to entries by position and title; a row that does not match is left alone. */
(function w10Atlas() {
  'use strict';
  if (window.__w10Atlas) return;
  window.__w10Atlas = true;

  const D = document;
  /* Panels app.js renders, in its render order. */
  const APP_ORDER = ['resume', 'changed', 'stale', 'commitments', 'questions', 'people'];
  /* Display order for tiles and freshness rows; unknown panels go before people. */
  const SHOW_ORDER = ['resume', 'changed', 'stale', 'commitments', 'questions', 'corrections'];
  const DEFS = {
    resume: { stat: 'Resume', icon: 'arrow' },
    changed: { stat: 'Changed', icon: 'pulse' },
    stale: { stat: 'Needs attention', icon: 'clock', tone: 'orange' },
    commitments: { stat: 'Commitments', icon: 'check' },
    questions: { stat: 'Questions & blockers', short: 'Questions', icon: 'alert' },
    people: { stat: 'People', icon: 'people' },
    corrections: { stat: 'Corrections', icon: 'layers' },
  };
  /* Server-side slice sizes for vault-live hydration (vault-api.ts hydrateAtlasPanelEntries). */
  const SLICE = { people: 12 };
  const SLICE_DEFAULT = 10;
  const BUCKETS = [
    { key: 'fresh', label: 'Last hour', max: 3600e3 },
    { key: 'today', label: 'Last 24h', max: 86400e3 },
    { key: 'week', label: 'This week', max: 7 * 86400e3 },
    { key: 'older', label: 'Older', max: Infinity },
  ];
  const GAP_WORDS = {
    coverage: 'coverage incomplete',
    pending_consolidation: 'consolidation pending',
    traversal_limit: 'traversal limit reached',
  };

  const cache = { data: null, promise: null, error: null };
  let scheduled = false;
  let activityOpen = null;
  let noteOpen = null;
  const isNarrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  let ticker = 0;

  const K = () => window.KizukiKit || null;
  const root = () => D.getElementById('view-atlas');

  function fetchAtlas(force) {
    if (!force && cache.data) return Promise.resolve(cache.data);
    if (!force && cache.promise) return cache.promise;
    cache.promise = fetch('/api/atlas', { headers: { Accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        cache.data = d && typeof d === 'object' ? d : null;
        cache.error = null;
        return cache.data;
      })
      .catch((err) => {
        cache.error = err && err.message ? err.message : 'Request failed';
        cache.data = null;
        return null;
      })
      .finally(() => {
        cache.promise = null;
      });
    return cache.promise;
  }

  /* ------------------------------------------------------------ helpers */
  function panelKey(p) {
    return String((p && (p.panel || p.key || p.id)) || '').toLowerCase();
  }
  function entriesOf(p) {
    if (!p || typeof p !== 'object') return null;
    if (Array.isArray(p.entries)) return p.entries;
    if (Array.isArray(p.items)) return p.items;
    if (Array.isArray(p.rows)) return p.rows;
    return null;
  }
  function ts(v) {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  }
  function rel(t, now) {
    if (t == null) return null;
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function relTime(t, now, prefix) {
    const kit = K();
    const r = rel(t, now);
    if (!r) return '';
    const iso = new Date(t).toISOString();
    return '<time class="w10a-rel" datetime="' + iso + '" data-w10-prefix="' + kit.esc(prefix || '') + '" title="' +
      kit.esc(new Date(t).toLocaleString('en-GB')) + '">' + kit.esc((prefix || '') + r) + '</time>';
  }
  function bucketOf(t, now) {
    if (t == null) return null;
    const age = Math.max(0, now - t);
    return BUCKETS.find((b) => age < b.max) || BUCKETS[BUCKETS.length - 1];
  }
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 24);
  }
  function cleanError(e) {
    return String(e || '').replace(/^error:\s*/i, '').replace(/[.;\s]+$/, '').trim();
  }
  function sentence(s) {
    const t = String(s || '').trim().replace(/_/g, ' ');
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }
  function listWords(arr) {
    if (arr.length <= 1) return arr.join('');
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  }
  function personName(p) {
    return p ? String(p.label || p.title || p.name || '').trim() : '';
  }
  function avatarOf(kit, p, size) {
    const person = { name: p.name, id: p.id, avatar_url: p.avatar_url, photo: p.photo };
    return kit.avatar(person, { size, mode: p.avatar_url || p.photo ? 'auto' : 'initials' });
  }

  /* ------------------------------------------------------------ data model (built once per pass) */
  function model(data) {
    const now = Date.now();
    const list = data && Array.isArray(data.panels) ? data.panels.filter((p) => p && typeof p === 'object') : [];
    const panels = [];
    const byKey = {};
    list.forEach((raw) => {
      const key = panelKey(raw);
      if (!key || byKey[key]) return;
      const base = DEFS[key] || { stat: sentence(raw.title || key), icon: 'layers' };
      const entries = entriesOf(raw);
      const n = entries ? entries.length : null;
      const cov = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : null;
      const gaps = cov && Array.isArray(cov.gaps) ? cov.gaps.map(String) : [];
      const live = String(raw.source || '').toLowerCase() === 'vault-live' && raw.hydrated === true;
      const slice = live ? SLICE[key] || SLICE_DEFAULT : null;
      const capped = n != null && n > 0 && (gaps.includes('traversal_limit') || (slice != null && n >= slice));
      const hydrated = raw.hydrated === true && String(raw.status || '').toLowerCase() === 'hydrated';
      const complete = hydrated && cov != null && String(cov.status || '').toLowerCase() === 'complete';
      const times = (entries || []).map((e) => ts(e && e.updated_at)).filter((t) => t != null);
      const p = {
        key,
        def: Object.assign({ tone: 'slate' }, base),
        raw,
        entries,
        n,
        display: n == null ? null : capped ? n + '+' : n,
        capped,
        live,
        hydrated,
        complete,
        gaps,
        history: cov && cov.history ? String(cov.history) : '',
        reason: raw.reason ? String(raw.reason) : '',
        source: String(raw.source || ''),
        times,
        latest: times.length ? Math.max(...times) : null,
        app: APP_ORDER.includes(key),
      };
      panels.push(p);
      byKey[key] = p;
    });
    const rank = (k) => (k === 'people' ? 1e3 : SHOW_ORDER.includes(k) ? SHOW_ORDER.indexOf(k) : 500);
    panels.sort((a, b) => rank(a.key) - rank(b.key));

    const memberOf = new Map();
    const unique = new Map();
    panels.forEach((p) => {
      if (p.key === 'people' || !p.entries) return;
      p.entries.forEach((e) => {
        if (!e || !e.id) return;
        const set = memberOf.get(e.id) || new Set();
        set.add(p.key);
        memberOf.set(e.id, set);
        if (!unique.has(e.id)) unique.set(e.id, e);
      });
    });
    const items = Array.from(unique.values());
    const times = items.map((e) => ts(e.updated_at)).filter((t) => t != null);
    const bucketCounts = BUCKETS.map((b) => ({ ...b, count: 0 }));
    times.forEach((t) => {
      const b = bucketOf(t, now);
      bucketCounts.find((x) => x.key === b.key).count += 1;
    });
    const hourly = new Array(24).fill(0);
    let last24 = 0;
    times.forEach((t) => {
      const age = now - t;
      if (age >= 0 && age < 86400e3) {
        hourly[23 - Math.floor(age / 3600e3)] += 1;
        last24 += 1;
      }
    });

    const pp = byKey.people;
    const people = ((pp && pp.entries) || [])
      .map((p) => ({
        id: p && (p.node_id || p.entity_id || p.id),
        name: personName(p),
        avatar_url: p && p.avatar_url,
        photo: p && p.photo,
        mentions: p && typeof p.mentions === 'number' && Number.isFinite(p.mentions) ? p.mentions : null,
      }))
      .filter((p) => p.name)
      .sort((a, b) => (b.mentions || 0) - (a.mentions || 0));

    const shared = Array.from(memberOf.values()).filter((s) => s.size > 1).length;
    const latest = times.length ? Math.max(...times) : null;
    const hl = data && Array.isArray(data.consolidated_highlights) ? data.consolidated_highlights : [];
    const status = String((data && data.status) || '').toLowerCase();

    return { now, panels, byKey, memberOf, items, times, bucketCounts, hourly, last24, people, shared, latest, hl, status, error: cleanError(data && data.error) };
  }

  /* ------------------------------------------------------------ overview */
  function coverageState(m) {
    if (m.status === 'degraded') return { label: 'Degraded', tone: 'orange' };
    if (!m.panels.length) return { label: 'No panels', tone: 'slate' };
    const ok = ['ok', 'live', 'hydrated', 'healthy'].includes(m.status);
    if (ok && m.panels.every((p) => p.complete)) return { label: 'Complete coverage', tone: 'emerald' };
    return { label: 'Partial coverage', tone: 'slate' };
  }

  function coverageNote(m) {
    const kit = K();
    const parts = [];
    if (m.status === 'degraded') parts.push('Daemon degraded' + (m.error ? ': ' + m.error : '') + '.');
    const snap = m.panels.filter((p) => !p.hydrated);
    if (snap.length) {
      parts.push(listWords(snap.map((p) => p.def.stat)) + (snap.length === 1 ? ' comes' : ' come') +
        ' from the atlas snapshot, not the live vault.');
    }
    const gapSet = new Set();
    m.panels.forEach((p) => p.gaps.forEach((g) => gapSet.add(g)));
    if (gapSet.size) {
      parts.push('Gaps: ' + Array.from(gapSet).map((g) => GAP_WORDS[g] || g.replace(/_/g, ' ')).join(', ') + '.');
    }
    const noBase = m.panels.filter((p) => p.reason === 'baseline_required');
    if (noBase.length) {
      parts.push(listWords(noBase.map((p) => p.def.stat)) + ' ' + (noBase.length === 1 ? 'has' : 'have') +
        ' no history baseline yet, so ' + (noBase.length === 1 ? 'it lists' : 'they list') + ' recent items rather than a diff.');
    }
    const capped = m.panels.filter((p) => p.capped);
    if (capped.length) parts.push('A "+" means only the first slice was returned; more may exist.');
    if (!parts.length) return '';
    const open = noteOpen == null ? !isNarrow() : noteOpen;
    const n = parts.length;
    return '<details class="w10a-note"' + (open ? ' open' : '') + '><summary class="w10a-note-sum">' + kit.icon('alert', 13) +
      '<span>Why coverage is ' + (m.status === 'degraded' ? 'degraded' : 'partial') + '</span><span class="w10a-note-n">' + n + (n === 1 ? ' note' : ' notes') + '</span></summary>' +
      '<p class="w10a-note-body">' + kit.icon('alert', 13) + '<span>' + kit.esc(parts.join(' ')) + '</span></p></details>';
  }

  function segBar(counts, cls) {
    const kit = K();
    const seg = counts
      .filter((b) => b.count > 0)
      .map((b) => '<span class="w10a-seg" data-age="' + b.key + '" style="flex-grow:' + b.count + '"></span>')
      .join('');
    const aria = counts.map((b) => b.label + ' ' + b.count).join(', ');
    return '<div class="w10a-segbar' + (cls ? ' ' + cls : '') + '" role="img" aria-label="' + kit.esc(aria) + '">' + seg + '</div>';
  }
  function panelBuckets(p, now) {
    const counts = BUCKETS.map((b) => ({ ...b, count: 0 }));
    p.times.forEach((t) => {
      counts.find((x) => x.key === bucketOf(t, now).key).count += 1;
    });
    return counts;
  }

  function tileSub(p) {
    if (p.n == null) return null;
    if (p.live) return p.capped ? 'Live vault, first ' + p.n : 'Live vault';
    if (p.hydrated) return p.source ? sentence(p.source) : 'Hydrated';
    return 'Snapshot, ' + String(p.raw.status || 'partial').toLowerCase();
  }

  function overviewHtml(m) {
    const kit = K();
    const cov = coverageState(m);
    const tiles = m.panels.length
      ? '<div class="w10a-tiles" role="list">' +
        m.panels
          .map((p) => {
            const spark = p.times.length
              ? segBar(panelBuckets(p, m.now), 'is-thin')
              : '<span class="w10a-spark-none">' + (p.n ? 'Undated' : 'Empty') + '</span>';
            return '<div role="listitem">' + kit.statTile({
              label: p.def.short || p.def.stat,
              value: p.display,
              sub: tileSub(p),
              icon: p.def.icon,
              tone: p.def.tone,
              spark: p.n == null ? '' : spark,
              action: 'atlas-tab:' + p.key,
            }) + '</div>';
          })
          .join('') +
        '</div>'
      : kit.emptyState({ title: 'No panels returned', body: 'The atlas reply had no panels.', icon: 'globe', compact: true });
    return '<section class="w10a-overview" aria-label="Overview">' +
      kit.sectionHead('Overview', kit.chip(cov.label, cov.tone)) +
      tiles + coverageNote(m) + '</section>';
  }

  function headerMeta(m) {
    const bits = [];
    const listPanels = m.panels.filter((p) => p.key !== 'people' && p.entries);
    if (m.panels.length) {
      bits.push(m.items.length + ' unique item' + (m.items.length === 1 ? '' : 's') + ' across ' + listPanels.length + ' panel' + (listPanels.length === 1 ? '' : 's'));
    } else {
      bits.push('No panels returned');
    }
    const pp = m.byKey.people;
    if (pp && pp.n != null) bits.push((pp.capped ? 'top ' + pp.n : pp.n) + ' people');
    bits.push(m.hl.length + ' world object' + (m.hl.length === 1 ? '' : 's'));
    return bits.join(' · ');
  }

  /* ------------------------------------------------------------ activity + people */
  function activityFacts(m) {
    const kit = K();
    let peak = -1;
    let peakIdx = -1;
    m.hourly.forEach((v, i) => {
      if (v > peak) { peak = v; peakIdx = i; }
    });
    const active = m.hourly.filter((v) => v > 0).length;
    let peakWhen = null;
    if (peak > 0) {
      const hoursAgo = 23 - peakIdx;
      peakWhen = hoursAgo === 0 ? 'this hour' : hoursAgo + 'h ago';
    }
    const facts = [
      { label: 'Busiest hour', value: peak > 0 ? peak : null, sub: peakWhen ? 'updates at ' + peakWhen : null },
      { label: 'Active hours', value: active, sub: 'of the last 24' },
      { label: 'In 2+ panels', value: m.shared, sub: m.shared === 1 ? 'item' : 'items' },
    ];
    return '<dl class="w10a-facts">' + facts
      .map((f) => '<div class="w10a-fact"><dt>' + kit.esc(f.label) + '</dt><dd>' + kit.esc(kit.fmt(f.value)) +
        (f.sub && f.value != null ? '<span>' + kit.esc(f.sub) + '</span>' : '') + '</dd></div>')
      .join('') + '</dl>';
  }

  function freshnessHtml(m) {
    const kit = K();
    const legend = m.bucketCounts
      .map((b) =>
        '<li class="w10a-leg' + (b.count ? '' : ' is-zero') + '" data-age="' + b.key + '"><span class="w10a-leg-dot" aria-hidden="true"></span>' +
        '<span class="w10a-leg-label">' + kit.esc(b.label) + '</span><span class="w10a-leg-n">' + kit.esc(kit.fmt(b.count)) + '</span></li>')
      .join('');
    const rows = m.panels
      .filter((p) => p.key !== 'people' && p.entries)
      .map((p) => {
        const label = p.def.short || p.def.stat;
        return '<li class="w10a-prow-age"><span class="w10a-prow-age-l">' + kit.esc(label) + '</span>' +
          (p.times.length ? segBar(panelBuckets(p, m.now), 'is-thin') : '<span class="w10a-none">' + (p.n ? 'Undated' : 'Empty') + '</span>') +
          '<span class="w10a-prow-age-n">' + kit.esc(kit.fmt(p.display)) + '</span></li>';
      })
      .join('');
    return '<div class="w10a-fresh"><h4 class="w10a-sub-h">Freshness</h4>' + segBar(m.bucketCounts) +
      '<ul class="w10a-legend">' + legend + '</ul>' +
      (rows ? '<ul class="w10a-by-panel" aria-label="Age by panel">' + rows + '</ul>' : '') + '</div>';
  }

  function activityCard(m) {
    const kit = K();
    const total = m.times.length;
    const sub = total
      ? total + ' of ' + m.items.length + ' items carry a timestamp' + (m.latest != null ? ', latest ' : '')
      : 'No item timestamps returned';
    const subHtml = kit.esc(sub) + (m.latest != null ? relTime(m.latest, m.now, '') : '');
    const body = total
      ? '<div class="w10a-act">' +
        '<div class="w10a-act-main"><div class="w10a-big"><span class="w10a-big-n">' + kit.esc(kit.fmt(m.last24)) + '</span><span class="w10a-big-u">updates in the last 24 hours</span></div>' +
        kit.sparkline(m.hourly, { width: 320, height: 56, tone: 'cobalt', min: 0, aria: 'Item updates per hour over the last 24 hours' }) +
        '<div class="w10a-axis" aria-hidden="true"><span>24h ago</span><span>12h</span><span>Now</span></div>' +
        activityFacts(m) + '</div>' +
        freshnessHtml(m) + '</div>'
      : kit.unavailable('No item timestamps returned');
    const card = kit.card({
      title: 'Activity',
      sub: ' ',
      right: '<span class="w10a-card-ic" aria-hidden="true">' + kit.icon('pulse', 14) + '</span>',
      body,
    }).replace('<div class="k10-card-sub"> </div>', '<div class="k10-card-sub">' + subHtml + '</div>');
    const open = activityOpen == null ? !isNarrow() : activityOpen;
    const summary = total ? 'Activity, ' + m.last24 + ' update' + (m.last24 === 1 ? '' : 's') + ' in 24h' : 'Activity, no timestamps';
    return '<details class="w10a-disclose"' + (open ? ' open' : '') + '><summary class="w10a-summary">' +
      kit.icon('pulse', 14) + '<span>' + kit.esc(summary) + '</span>' + kit.icon('arrow', 12) + '</summary>' + card + '</details>';
  }

  function peopleSub(m, top) {
    const pp = m.byKey.people;
    if (!pp || !top.length) return 'Mentions';
    const src = pp.live ? 'By live vault mentions' : 'By mentions in the atlas snapshot';
    return src + (pp.n != null ? ', ' + top.length + ' of ' + (pp.capped ? 'the top ' + pp.n : pp.n) + ' returned' : '');
  }

  function peopleCard(m) {
    const kit = K();
    const top = m.people.slice(0, 6);
    const max = Math.max(0, ...top.map((p) => p.mentions || 0));
    const body = top.length
      ? '<ul class="w10a-pbars">' +
        top
          .map((p) => {
            const pct = p.mentions != null && max > 0 ? Math.round((p.mentions / max) * 100) : 0;
            const attr = p.id ? ' data-jump-node="' + kit.esc(p.id) + '"' : ' disabled';
            const ment = p.mentions == null ? 'mentions unavailable' : kit.fmt(p.mentions) + (p.mentions === 1 ? ' mention' : ' mentions');
            return '<li><button type="button" class="w10a-pbar"' + attr + ' aria-label="' + kit.esc(p.name + ', ' + ment + '. Open in graph') + '">' +
              avatarOf(kit, p, 26) +
              '<span class="w10a-pbar-name k10-truncate">' + kit.esc(p.name) + '</span>' +
              '<span class="w10a-pbar-track" aria-hidden="true"><span class="w10a-pbar-fill" style="width:' + pct + '%"></span></span>' +
              '<span class="w10a-pbar-n">' + kit.esc(kit.fmt(p.mentions)) + '</span></button></li>';
          })
          .join('') +
        '</ul>'
      : kit.unavailable('No people returned');
    return kit.card({
      title: 'People in play',
      sub: peopleSub(m, top),
      right: '<span class="w10a-card-ic" aria-hidden="true">' + kit.icon('people', 14) + '</span>',
      body,
    });
  }

  function pulseHtml(m) {
    return '<div class="w10a-pulse">' + activityCard(m) + '<div class="w10a-people-card">' + peopleCard(m) + '</div></div>';
  }

  function renderTop(data, m) {
    const kit = K();
    const view = root();
    if (!kit || !view) return;
    const container = view.querySelector('.view-container');
    const header = container && container.querySelector('.view-header');
    if (!container || !header) return;
    let top = D.getElementById('w10a-top');
    if (!top) {
      top = D.createElement('div');
      top.id = 'w10a-top';
      top.className = 'w10a-top';
      header.insertAdjacentElement('afterend', top);
    }
    const meta = D.getElementById('atlas-status-meta');
    let html;
    if (!data || !m) {
      html = kit.emptyState({
        title: 'World state unavailable',
        body: cache.error ? 'The atlas request failed: ' + cache.error + '.' : 'The atlas has not returned data yet.',
        icon: 'globe',
        compact: true,
      });
    } else {
      html = overviewHtml(m) + pulseHtml(m);
      if (meta) {
        const text = headerMeta(m);
        if (meta.textContent !== text) meta.textContent = text;
      }
    }
    const sig = String(kit.hash(html));
    if (top.dataset.sig === sig) return;
    top.dataset.sig = sig;
    top.innerHTML = html;
    const det = top.querySelector('.w10a-disclose');
    if (det) det.addEventListener('toggle', () => { activityOpen = det.open; });
    const note = top.querySelector('.w10a-note');
    if (note) note.addEventListener('toggle', () => { noteOpen = note.open; });
  }

  /* ------------------------------------------------------------ panels */
  function activeTab(view) {
    const t = view.querySelector('[data-atlas-tab].is-active');
    return t ? t.getAttribute('data-atlas-tab') : 'all';
  }

  function extraPanelHtml(p) {
    const kit = K();
    const items = (p.entries || []).slice(0, 14);
    const title = p.def.stat;
    const body = items.length
      ? items
          .map((item) => {
            if (!item || typeof item !== 'object') return '';
            const t = String(item.label || item.title || item.name || item.subject || item.text || item.summary || 'Item');
            const rawDesc = String(item.summary || item.detail || item.reason || '');
            const desc = rawDesc && rawDesc.trim() !== t.trim() ? rawDesc : '';
            const nodeId = item.node_id || item.entity_id || item.id || null;
            const docPath = item.doc_path || item.path || null;
            const action = docPath
              ? 'data-open-doc="' + kit.esc(docPath) + '"'
              : nodeId
                ? 'data-jump-node="' + kit.esc(nodeId) + '"'
                : 'data-atlas-ask="' + kit.esc('Synthesize context and next actions for "' + t + '"') + '"';
            const t0 = ts(item.updated_at);
            return '<button type="button" class="atlas-row is-clickable" ' + action + '>' +
              '<div class="atlas-row-top"><span class="atlas-row-title">' + kit.esc(t) + '</span>' +
              (t0 != null ? '<span class="atlas-row-meta">' + kit.esc(rel(t0, Date.now())) + '</span>' : '') + '</div>' +
              (desc ? '<p class="atlas-row-desc">' + kit.esc(desc) + '</p>' : '') + '</button>';
          })
          .join('')
      : '<p class="empty-state">Quiet: no active items in ' + kit.esc(title.toLowerCase()) + '.</p>';
    const badge = p.live
      ? '<span class="badge badge-teal" title="vault-live">live</span>'
      : '<span class="badge badge-neutral" title="' + kit.esc(p.source || 'atlas') + '">atlas</span>';
    return '<section class="atlas-panel" data-w10-extra="' + kit.esc(p.key) + '">' +
      '<header class="atlas-panel-head"><h2 class="atlas-panel-title"><span>' + kit.esc(title) + '</span></h2>' +
      '<div class="atlas-panel-head-right">' + badge + '<span class="section-count tabular">' + (p.n || 0) + '</span></div></header>' +
      '<div class="atlas-panel-body">' + body + '</div></section>';
  }

  function ensureExtras(m, grid, tab) {
    const extras = m.panels.filter((p) => !p.app);
    const view = root();
    const tabs = view && view.querySelector('#atlas-panel-tabs');
    if (tabs) {
      extras.forEach((p) => {
        if (tabs.querySelector('[data-atlas-tab="' + CSS.escape(p.key) + '"]')) return;
        const b = D.createElement('button');
        b.type = 'button';
        b.className = 'sub-tab';
        b.dataset.atlasTab = p.key;
        b.textContent = p.def.short || p.def.stat;
        tabs.appendChild(b);
      });
    }
    const hasApp = !!grid.querySelector(':scope > .atlas-panel:not([data-w10-extra])');
    extras.forEach((p) => {
      const want = tab === p.key || (tab === 'all' && hasApp);
      const el = grid.querySelector(':scope > [data-w10-extra="' + CSS.escape(p.key) + '"]');
      if (want && !el) grid.insertAdjacentHTML('beforeend', extraPanelHtml(p));
      else if (!want && el) el.remove();
    });
  }

  function sourceBadge(sec, p) {
    const badge = sec.querySelector('.atlas-panel-head-right .badge');
    if (!badge || badge.dataset.w10) return;
    badge.dataset.w10 = '1';
    const tip = [p.source || 'unknown source', 'status ' + (p.raw.status || 'unknown')];
    if (p.gaps.length) tip.push('gaps: ' + p.gaps.map((g) => GAP_WORDS[g] || g).join(', '));
    badge.textContent = p.live ? 'Live' : p.hydrated ? sentence(p.source || 'hydrated') : 'Snapshot';
    badge.title = tip.join('; ');
    const count = sec.querySelector('.atlas-panel-head-right .section-count');
    if (count && p.n != null) {
      count.textContent = String(p.display);
      if (p.capped) count.title = 'First ' + p.n + ' returned; more may exist';
    }
  }

  function enhancePanels(data, gridEl, tabName, mIn) {
    const kit = K();
    const view = root();
    if (!kit || !data) return;
    const grid = gridEl || D.getElementById('atlas-panels-grid');
    if (!grid) return;
    const m = mIn || model(data);
    const tab = tabName || (view ? activeTab(view) : 'all');
    grid.dataset.w10Tab = tab;
    if (!grid.querySelector(':scope > .skeleton-block')) ensureExtras(m, grid, tab);

    const appSecs = Array.from(grid.querySelectorAll(':scope > .atlas-panel:not([data-w10-extra])'));
    const appShown = APP_ORDER.filter((k) => k !== 'changed' || m.byKey.changed).filter((k) => tab === 'all' || k === tab);
    const pairs = [];
    if (appSecs.length === appShown.length) appSecs.forEach((sec, i) => pairs.push([sec, m.byKey[appShown[i]]]));
    grid.querySelectorAll(':scope > [data-w10-extra]').forEach((sec) => pairs.push([sec, m.byKey[sec.getAttribute('data-w10-extra')]]));

    const peopleMax = Math.max(0, ...m.people.map((p) => p.mentions || 0));

    pairs.forEach(([sec, p]) => {
      if (!p) return;
      const def = p.def;
      sec.dataset.w10Panel = p.key;
      /* Long lists span the full width (two row columns on wide screens); short ones pair up. */
      sec.dataset.w10Size = p.key === 'people' || (p.n || 0) > 5 ? 'wide' : 'half';
      sec.classList.add('w10a-panel', 'k10-tone-' + def.tone);

      const title = sec.querySelector('.atlas-panel-title');
      if (title && !title.querySelector('.w10a-tile')) {
        const old = title.querySelector('svg, .glyph');
        if (old) old.remove();
        title.insertAdjacentHTML('afterbegin', '<span class="w10a-tile" aria-hidden="true">' + kit.icon(def.icon, 13) + '</span>');
        const span = title.querySelector('span:not([class])');
        if (span) span.textContent = def.stat;
        if (p.latest != null) title.insertAdjacentHTML('beforeend', '<span class="w10a-head-sub">' + relTime(p.latest, m.now, 'Latest ') + '</span>');
      }
      sourceBadge(sec, p);

      const entries = (p.entries || []).slice(0, 14);
      Array.from(sec.querySelectorAll('.atlas-row')).forEach((row, j) => {
        if (row.dataset.w10) return;
        const e = entries[j];
        if (!e || typeof e !== 'object') return;
        const rowTitle = row.querySelector('.atlas-row-title');
        if (!rowTitle || norm(rowTitle.textContent) !== norm(e.label || e.title || e.name || e.subject || e.text || e.summary)) return;
        row.dataset.w10 = '1';
        const t = ts(e.updated_at);
        const b = bucketOf(t, m.now);
        const meta = row.querySelector('.atlas-row-meta');
        if (b && meta) {
          meta.dataset.age = b.key;
          meta.setAttribute('title', 'Updated ' + new Date(t).toLocaleString('en-GB') + ' (' + b.label.toLowerCase() + ')');
        }

        if (p.key === 'people') {
          row.classList.add('w10a-prow');
          const bodyWrap = D.createElement('span');
          bodyWrap.className = 'w10a-prow-body';
          while (row.firstChild) bodyWrap.appendChild(row.firstChild);
          row.insertAdjacentHTML('afterbegin', avatarOf(kit, { name: personName(e), id: e.id, avatar_url: e.avatar_url, photo: e.photo }, 36));
          row.appendChild(bodyWrap);
          const n = typeof e.mentions === 'number' && Number.isFinite(e.mentions) ? e.mentions : null;
          if (n != null) {
            const pct = peopleMax > 0 ? Math.round((n / peopleMax) * 100) : 0;
            bodyWrap.insertAdjacentHTML('beforeend',
              '<span class="w10a-ment"><span class="w10a-ment-track" aria-hidden="true"><span class="w10a-ment-fill" style="width:' + pct + '%"></span></span>' +
              '<span class="w10a-ment-n">' + kit.esc(kit.fmt(n)) + (n === 1 ? ' mention' : ' mentions') + '</span></span>');
          }
          return;
        }

        const others = e.id ? Array.from(m.memberOf.get(e.id) || []).filter((k) => k !== p.key) : [];
        if (others.length) {
          const names = others.map((k) => (m.byKey[k] ? m.byKey[k].def.stat : sentence(k)));
          row.insertAdjacentHTML('beforeend', '<span class="w10a-also">' + kit.icon('link', 11) + '<span>Also in ' + kit.esc(listWords(names)) + '</span></span>');
        }
      });
    });
  }

  function enhanceHighlights(data, gridEl, mIn) {
    const kit = K();
    if (!kit || !data) return;
    const grid = gridEl || D.getElementById('atlas-highlights-grid');
    if (!grid) return;
    const m = mIn || model(data);
    const list = m.hl;
    const nameCount = new Map();
    list.forEach((h) => {
      const k = norm(h && (h.label || h.title || h.name || h.id));
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    });
    const claimNums = list.map((h) => (h && typeof h.claim_count === 'number' && Number.isFinite(h.claim_count) ? h.claim_count : null));
    const claimMax = Math.max(0, ...claimNums.filter((n) => n != null));
    const cards = Array.from(grid.querySelectorAll(':scope > .highlight-item'));
    cards.forEach((card, i) => {
      if (card.dataset.w10) return;
      const h = list[i];
      if (!h) return;
      const t = card.querySelector('.highlight-title');
      const key = norm(h.label || h.title || h.name || h.id);
      if (!t || norm(t.textContent) !== key) return;
      card.dataset.w10 = '1';
      card.classList.add('w10a-hl');
      const badge = card.querySelector('.highlight-top .badge');
      const chips = kit.chip(sentence(h.kind || 'world'), 'slate', { dot: false }) +
        ((nameCount.get(key) || 0) > 1 ? '<span class="w10a-dup" title="' + kit.esc(nameCount.get(key) + ' world objects share this name') + '">' + kit.esc('×' + nameCount.get(key)) + '</span>' : '');
      if (badge) badge.outerHTML = '<span class="w10a-hl-chips">' + chips + '</span>';
      const foot = card.querySelector('.highlight-foot');
      const n = claimNums[i];
      if (foot && n != null) {
        const pct = claimMax > 0 ? Math.round((n / claimMax) * 100) : 0;
        foot.insertAdjacentHTML('afterbegin', '<span class="w10a-claims" aria-hidden="true"><span class="w10a-claims-fill" style="width:' + pct + '%"></span></span>');
      }
    });
  }

  /* ------------------------------------------------------------ wiring */
  function run() {
    scheduled = false;
    const view = root();
    if (!view || !K()) return;
    if (view.hidden) return;
    fetchAtlas(false).then((data) => {
      const m = data ? model(data) : null;
      renderTop(data, m);
      if (data) {
        enhancePanels(data, null, null, m);
        enhanceHighlights(data, null, m);
      }
    });
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  }

  function tick() {
    const view = root();
    if (!view || view.hidden) return;
    const now = Date.now();
    view.querySelectorAll('time.w10a-rel').forEach((el) => {
      const t = ts(el.getAttribute('datetime'));
      const r = rel(t, now);
      if (r) el.textContent = (el.getAttribute('data-w10-prefix') || '') + r;
    });
    const top = D.getElementById('w10a-top');
    if (top) top.dataset.sig = '';
    schedule();
  }
  function setTicker(on) {
    if (on && !ticker) ticker = setInterval(tick, 60000);
    else if (!on && ticker) { clearInterval(ticker); ticker = 0; }
  }

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-k10-action^="atlas-tab:"]') : null;
    if (!el) return;
    const view = root();
    const key = el.getAttribute('data-k10-action').slice('atlas-tab:'.length);
    const tab = view && view.querySelector('#atlas-panel-tabs [data-atlas-tab="' + CSS.escape(key) + '"]');
    if (!tab) return;
    tab.click();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    view.querySelector('#atlas-panel-tabs').scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  /* Renderers for the storyboard (public/storyboard/atlas.html). */
  window.KizukiAtlasW10 = Object.freeze({
    overview: (data) => (K() && data ? overviewHtml(model(data)) : ''),
    meta: (data) => (K() && data ? headerMeta(model(data)) : ''),
    pulse: (data) => (K() && data ? pulseHtml(model(data)) : ''),
    enhancePanels: (data, grid, tab) => enhancePanels(data, grid, tab),
    enhanceHighlights: (data, grid) => enhanceHighlights(data, grid),
  });

  function boot() {
    const view = root();
    if (!view || !D.getElementById('atlas-panels-grid')) return;
    const panels = D.getElementById('atlas-panels-grid');
    const hl = D.getElementById('atlas-highlights-grid');
    const mo = new MutationObserver((recs) => {
      if (recs.some((r) => r.target === panels || r.target === hl)) schedule();
    });
    if (panels) mo.observe(panels, { childList: true });
    if (hl) mo.observe(hl, { childList: true });
    view.addEventListener('click', onClick);

    const refresh = D.getElementById('btn-atlas-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        cache.data = null;
        const top = D.getElementById('w10a-top');
        if (top) top.dataset.sig = '';
      });
    }
    new MutationObserver(() => {
      setTicker(!view.hidden);
      if (!view.hidden) schedule();
    }).observe(view, { attributes: true, attributeFilter: ['hidden'] });

    const relabel = {
      'All Panels': 'All panels',
      'Stale / Attention': 'Needs attention',
      'Open Questions': 'Questions',
      'Consolidated World Objects': 'Consolidated world objects',
    };
    view.querySelectorAll('.sub-tab, .section-heading').forEach((el) => {
      const t = el.textContent.trim();
      if (relabel[t]) el.textContent = relabel[t];
    });

    setTicker(!view.hidden);
    if (!view.hidden) schedule();
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
