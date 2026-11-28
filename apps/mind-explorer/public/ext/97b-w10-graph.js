/* Wave 10: Mind Graph depth layer.
   Enhances #view-graph after the core view renders: a compact directory hero, calmer directory
   rows, canvas legend + live cluster labels, and an inspector head with people and a connection mix.
   Counts follow the canvas classifier (engine node.category), so pills, hero, legend, clusters and
   inspector agree. Data: /api/graph via the engine instance, /api/node via the app's inspector DOM,
   and the full /api/people roster (paged locally, never outside the app). */
(function initW10Graph(root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  var CATS = [
    { id: 'consolidated', label: 'World', plural: 'World objects', one: 'World object', tone: 'orange', glyph: 'ring', icon: 'globe' },
    { id: 'concept', label: 'Concepts', plural: 'Concepts', one: 'Concept', tone: 'cobalt', glyph: 'dot', icon: 'brain' },
    { id: 'memt', label: 'MemT', plural: 'MemT recipes', one: 'MemT recipe', tone: 'emerald', glyph: 'diamond', icon: 'bolt' },
    { id: 'connector', label: 'Sources', plural: 'Sources', one: 'Source', tone: 'violet', glyph: 'square', icon: 'link' },
    { id: 'attention', label: 'Attention', plural: 'Needs attention', one: 'Needs attention', tone: 'rose', glyph: 'dot', icon: 'alert' },
  ];
  var CAT_BY_ID = {};
  CATS.forEach(function (c) { CAT_BY_ID[c.id] = c; });

  var STOP_NAMES = new Set(['will', 'may', 'june', 'april', 'august', 'mark', 'grace', 'hope', 'joy', 'faith', 'rose', 'max', 'art', 'bill', 'ray', 'sky', 'summer', 'dawn', 'jack', 'page', 'chase', 'case', 'code', 'ika', 'unknown', 'telegram', 'whatsapp', 'gmail', 'calendar', 'imessage', 'website', 'team', 'group', 'support', 'admin', 'bot', 'review', 'design', 'video', 'motion', 'canon', 'legacy', 'sample']);
  var EYEBROWS = {
    'inspector-summary-section': 'Distilled summary',
    'inspector-memt-section': 'Verified MemT procedure',
    'inspector-related-docs-section': 'Related vault docs',
  };
  var WEEK_MS = 7 * 86400000;

  var S = {
    inst: null,
    roster: null, /* { items, total, complete } */
    rosterPromise: null,
    matcher: null,
    raf: 0,
    needFull: false,
    layer: null,
    clusterEls: {},
    topMin: 96,
    geomDirty: true,
    lastDataSig: '',
    mounted: false,
    ticker: 0,
    pillObs: null,
  };

  function K() { return root.KizukiKit; }
  function viewEl() { return doc.getElementById('view-graph'); }
  function isActive() {
    var v = viewEl();
    return !!(v && !v.hidden && doc.getElementById('graph-canvas'));
  }

  /* ------------------------------------------------------------ engine capture */
  function patchEngine() {
    var G = root.KizukiGraph;
    if (!G || !G.prototype) return false;
    var proto = G.prototype;
    if (proto.__k10gPatched) return true;
    proto.__k10gPatched = true;
    ['_draw', 'setData', 'resize', 'getNodeById', 'setFilter', 'requestRender'].forEach(function (name) {
      var orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = function () {
        var mine = !!(this && this.canvas && this.canvas.id === 'graph-canvas');
        if (mine) {
          capture(this);
          // One label system: the overlay owns cluster labels, so the engine's faint uppercase
          // sector watermarks are drawn fully transparent while it is mounted.
          if (name === '_draw' && this.palette && S.layer) {
            this.palette.sectorLabel = 'rgba(0,0,0,0)';
            this.palette.sectorLabelActive = 'rgba(0,0,0,0)';
          }
        }
        var out = orig.apply(this, arguments);
        if (mine) {
          if (name === '_draw') {
            if (isActive()) positionClusters();
          } else if (name === 'setData' || name === 'setFilter') {
            scheduleOverlay(true);
          } else if (name === 'resize') {
            S.geomDirty = true;
          }
        }
        return out;
      };
    });
    return true;
  }

  function capture(inst) {
    if (S.inst === inst) return;
    S.inst = inst;
    scheduleOverlay(true);
  }

  function nodes() {
    return S.inst && Array.isArray(S.inst.allNodes) ? S.inst.allNodes : [];
  }
  function edges() {
    return S.inst && Array.isArray(S.inst.allEdges) ? S.inst.allEdges : [];
  }
  function edgeEnds(e) {
    var s = e.source && typeof e.source === 'object' ? e.source.id : e.source;
    var t = e.target && typeof e.target === 'object' ? e.target.id : e.target;
    return [s, t];
  }

  /* ------------------------------------------------------------ people roster */
  /* /api/people caps one page at 300. To match names honestly we need the whole roster, so this
     unions the channel filters and, for any filter still over the cap, initial-letter searches,
     stopping as soon as the union reaches the reported total. */
  function getPeople(qs) {
    return fetch('/api/people?limit=300' + qs, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function loadRoster() {
    if (S.rosterPromise) return S.rosterPromise;
    S.rosterPromise = (async function () {
      var byKey = new Map();
      var add = function (d) {
        (d && Array.isArray(d.items) ? d.items : []).forEach(function (p) {
          if (p && p.key && !byKey.has(p.key)) byKey.set(p.key, p);
        });
      };
      var first = await getPeople('');
      if (!first) return { items: [], total: null, complete: false };
      add(first);
      var total = Number(first.total);
      if (!Number.isFinite(total)) total = null;
      if (total != null && byKey.size < total) {
        var filters = (Array.isArray(first.channels) ? first.channels.map(function (c) { return c && c.id; }) : [])
          .filter(Boolean).concat(['profiled', 'core']);
        var pages = await Promise.all(filters.map(function (f) { return getPeople('&filter=' + encodeURIComponent(f)); }));
        var over = [];
        pages.forEach(function (d, i) {
          add(d);
          if (d && Number(d.total) > (Array.isArray(d.items) ? d.items.length : 0)) over.push(filters[i]);
        });
        if (!over.length && byKey.size < total) over.push('all');
        var letters = 'aeionrstlmdkhcbjpgyfuvwzxq'.split('');
        for (var li = 0; li < letters.length && byKey.size < total; li += 1) {
          for (var fi = 0; fi < over.length && byKey.size < total; fi += 1) {
            add(await getPeople('&filter=' + encodeURIComponent(over[fi]) + '&q=' + letters[li]));
          }
        }
      }
      var items = Array.from(byKey.values());
      return { items: items, total: total, complete: total != null && items.length >= total };
    })().then(function (r) {
      S.roster = r;
      S.matcher = buildMatcher(r.items, r.complete);
      return r;
    }, function () {
      S.roster = { items: [], total: null, complete: false };
      S.matcher = null;
      return S.roster;
    });
    return S.rosterPromise;
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* Full names (two or more words) always match. A first name only matches when it is unique
     across the complete roster; with a partial roster first-name matching is off. */
  function buildMatcher(items, complete) {
    var full = new Map();
    var firstCount = new Map();
    var firstOwner = new Map();
    items.forEach(function (p) {
      var name = String(p.name || '').trim();
      if (!name) return;
      var parts = name.split(/\s+/);
      if (parts.length >= 2 && name.length >= 5) full.set(name.toLowerCase(), p);
      var first = parts[0];
      if (first && first.length >= 3) {
        firstCount.set(first.toLowerCase(), (firstCount.get(first.toLowerCase()) || 0) + 1);
        firstOwner.set(first.toLowerCase(), p);
      }
    });
    var firsts = new Map();
    if (complete) {
      firstCount.forEach(function (n, lower) {
        var p = firstOwner.get(lower);
        var first = String(p.name).trim().split(/\s+/)[0];
        if (n === 1 && /^[A-Z][a-z'-]+$/.test(first) && !STOP_NAMES.has(lower)) firsts.set(first, p);
      });
    }
    var fullNames = Array.from(full.keys()).sort(function (a, b) { return b.length - a.length; });
    var reFull = fullNames.length ? new RegExp('(?:^|[^\\p{L}\\p{N}])(' + fullNames.map(escRe).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu') : null;
    var firstNames = Array.from(firsts.keys());
    var reFirst = firstNames.length ? new RegExp('(?:^|[^A-Za-z])(' + firstNames.map(escRe).join('|') + ')(?=$|[^A-Za-z])', 'g') : null;
    return { full: full, firsts: firsts, reFull: reFull, reFirst: reFirst, complete: !!complete };
  }

  /* Returns [{ person, how: 'full' | 'first' }]. Full names match anywhere in title or body;
     a unique first name only counts in the title. */
  function matchPeople(title, body) {
    var m = S.matcher;
    if (!m) return [];
    var found = new Map();
    var text = String(title || '') + '\n' + String(body || '');
    var hit;
    if (m.reFull) {
      m.reFull.lastIndex = 0;
      while ((hit = m.reFull.exec(text))) {
        var p = m.full.get(hit[1].toLowerCase());
        if (p) found.set(p.key, { person: p, how: 'full' });
      }
    }
    if (m.reFirst) {
      m.reFirst.lastIndex = 0;
      var t = String(title || '');
      while ((hit = m.reFirst.exec(t))) {
        var p2 = m.firsts.get(hit[1]);
        if (p2 && !found.has(p2.key)) found.set(p2.key, { person: p2, how: 'first' });
      }
    }
    return Array.from(found.values());
  }

  /* ------------------------------------------------------------ helpers */
  function relTime(iso) {
    if (!iso) return '';
    var t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.round(s / (86400 * 30)) + 'mo ago';
    return Math.round(s / (86400 * 365)) + 'y ago';
  }

  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function glyph(cat) {
    var c = CAT_BY_ID[cat] || CAT_BY_ID.concept;
    return '<span class="k10g-glyph is-' + c.glyph + ' k10g-cat-' + c.id + '" aria-hidden="true"></span>';
  }

  function counts(list) {
    var out = { all: 0, consolidated: 0, concept: 0, memt: 0, connector: 0, attention: 0 };
    list.forEach(function (n) {
      out.all += 1;
      if (out[n.category] !== undefined) out[n.category] += 1;
    });
    return out;
  }

  /* Fast stable signature of node identities and degrees, so the hero re-renders when the graph
     content changes even if the counts stay the same. */
  function dataSig(list, edgeCount) {
    var h = 2166136261;
    for (var i = 0; i < list.length; i += 1) {
      var s = String(list[i].id) + ':' + (list[i].degree || 0) + ':' + (list[i].category || '') + '|';
      for (var j = 0; j < s.length; j += 1) {
        h ^= s.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
    }
    return list.length + ':' + edgeCount + ':' + (h >>> 0);
  }

  /* ------------------------------------------------------------ directory hero */
  /* Pure renderer. list = engine nodes ({id,label,category,degree,updated_at}); edgeCount may be null.
     opts.now lets the catalog pin time. */
  function heroHtml(list, edgeCount, opts) {
    var kit = K();
    var now = (opts && opts.now) || Date.now();
    if (!list || !list.length) {
      return '<div class="k10g-hero-body"><div class="k10g-hero-head"><h2 class="k10g-hero-title">Mind graph</h2></div>' +
        '<p class="k10g-hero-sub">Waiting for the vault graph to load.</p></div>';
    }
    var c = counts(list);
    var edgesN = Number.isFinite(edgeCount) ? edgeCount : null;
    var segs = CATS.filter(function (cat) { return c[cat.id] > 0; });
    var bar = '<div class="k10g-comp" role="img" aria-label="' + kit.esc('What the graph holds: ' + segs.map(function (cat) { return kit.fmt(c[cat.id]) + ' ' + cat.plural.toLowerCase(); }).join(', ')) + '">' +
      segs.map(function (cat) {
        return '<span class="k10g-comp-seg k10g-cat-' + cat.id + '" style="flex-grow:' + c[cat.id] + '" title="' + kit.esc(kit.fmt(c[cat.id]) + ' ' + cat.plural.toLowerCase()) + '"></span>';
      }).join('') + '</div>';
    // Freshness ignores sources: their timestamp is the last ingest event, not a graph change.
    var newest = 0;
    var week = 0;
    list.forEach(function (n) {
      if (n.category === 'connector') return;
      var t = Date.parse(n.updated_at || '');
      if (!isFinite(t)) return;
      if (t > newest) newest = t;
      if (now - t <= WEEK_MS) week += 1;
    });
    var subParts = [];
    if (newest) subParts.push(kit.fmt(week) + ' changed this week');
    if (newest) subParts.push('newest ' + relTime(newest));
    var hubs = list.filter(function (n) { return n.category !== 'connector' && n.degree > 0; })
      .sort(function (a, b) { return b.degree - a.degree; }).slice(0, 3);
    var total = kit.fmt(c.all) + ' ' + plural(c.all, 'node') + (edgesN != null ? ' · ' + kit.fmt(edgesN) + ' ' + plural(edgesN, 'link') : '');
    return '<div class="k10g-hero-body">' +
      '<div class="k10g-hero-head"><h2 class="k10g-hero-title">Mind graph</h2><span class="k10g-hero-total">' + kit.esc(total) + '</span></div>' +
      bar +
      (subParts.length ? '<p class="k10g-hero-sub">' + kit.esc(subParts.join(' · ')) + '</p>' : '') +
      (hubs.length ? '<div class="k10g-hubs" role="group" aria-label="Busiest hubs"><span class="k10g-hubs-label">Busiest hubs</span><span class="k10g-hubs-unit">links</span><div class="k10g-hub-list">' +
        hubs.map(function (n) {
          return '<button type="button" class="k10g-hub" data-jump-node="' + kit.esc(n.id) + '" title="' + kit.esc(n.label + ', ' + n.degree + ' ' + plural(n.degree, 'link')) + '">' +
            glyph(n.category) + '<span class="k10-truncate">' + kit.esc(n.label) + '</span><span class="k10g-hub-n">' + kit.esc(kit.fmt(n.degree)) + '</span></button>';
        }).join('') + '</div></div>' : '') +
      '</div>';
  }

  function renderHero() {
    var kit = K();
    var dir = doc.getElementById('mind-directory');
    if (!kit || !dir) return;
    var host = doc.getElementById('k10g-hero');
    if (!host) {
      host = doc.createElement('section');
      host.id = 'k10g-hero';
      host.className = 'k10g-hero';
      host.setAttribute('aria-label', 'Graph overview');
      dir.insertBefore(host, dir.firstChild);
    }
    host.innerHTML = heroHtml(nodes(), S.inst ? edges().length : null);
  }

  /* Vault totals sit under the canvas hero; label them as vault-wide so they never read as canvas counts. */
  function decorateMetrics() {
    var box = doc.querySelector('#view-graph .dir-metrics');
    if (!box) return;
    if (!box.hasAttribute('data-k10g')) {
      box.setAttribute('data-k10g', '1');
      box.insertAdjacentHTML('beforebegin', '<p class="k10g-metrics-cap" id="k10g-metrics-cap">Across the whole vault</p>');
      var world = doc.getElementById('metric-consolidated');
      var cell = world && world.closest('.dir-metric');
      var label = cell && cell.querySelector('.dir-metric-label');
      if (label) label.textContent = 'World';
    }
    var w = doc.getElementById('metric-consolidated');
    var wc = w && w.closest('.dir-metric');
    if (wc) {
      var onCanvas = S.inst ? counts(nodes()).consolidated : null;
      wc.title = 'World objects in the vault' + (onCanvas != null ? '. ' + onCanvas + ' are on the canvas.' : '.');
    }
  }

  /* ------------------------------------------------------------ toolbar pills */
  /* The app counts pills with its own bucket rules; the canvas colours and filters by the engine's
     category. Rewrite the counts from the engine so a pill's number is what it filters to. */
  function syncPills() {
    if (!S.inst || !nodes().length) return;
    var c = counts(nodes());
    var els = doc.querySelectorAll('#view-graph .filter-pill [data-count-kind]');
    els.forEach(function (el) {
      var k = el.getAttribute('data-count-kind');
      if (c[k] === undefined) return;
      var v = String(c[k]);
      if (el.textContent !== v) el.textContent = v;
    });
    if (!S.pillObs && els.length && typeof MutationObserver === 'function') {
      S.pillObs = new MutationObserver(function () { syncPills(); });
      els.forEach(function (el) { S.pillObs.observe(el, { childList: true, characterData: true, subtree: true }); });
    }
  }

  /* ------------------------------------------------------------ directory rows */
  function countLabel(n) {
    var cc = num(n.claim_count);
    if (!(cc > 0)) return '';
    if (n.category === 'connector') return K().fmt(cc) + ' ' + plural(cc, 'event');
    if (n.category === 'memt') return '';
    return K().fmt(cc) + ' ' + plural(cc, 'claim');
  }

  /* Pure renderer: leading category glyph plus one meta line. matches = [{person, how}] (or plain people). */
  function rowDecor(n, matches) {
    var kit = K();
    var cat = CAT_BY_ID[n.category] || CAT_BY_ID.concept;
    var ms = (matches || []).map(function (m) { return m && m.person ? m : { person: m, how: 'full' }; });
    var lead = '<span class="k10g-row-lead">' + glyph(cat.id) + '</span>';
    var meta = [];
    if (n.degree > 0) meta.push(kit.fmt(n.degree) + ' ' + plural(n.degree, 'link'));
    var cl = countLabel(n);
    if (cl) meta.push(cl);
    var rt = relTime(n.updated_at);
    if (rt) meta.push(rt);
    var people = '';
    if (ms.length) {
      var names = ms.map(function (m) { return m.person.name + (m.how === 'first' ? ' (first name only)' : ''); }).join(', ');
      people = '<span class="k10g-row-people" title="' + kit.esc('Named here: ' + names) + '">' +
        kit.avatarStack(ms.map(function (m) { return m.person; }), { max: 3, size: 16, mode: 'initials' }) +
        (ms.length === 1 ? '<span class="k10-truncate">' + kit.esc(ms[0].person.name) + '</span>' : '') + '</span>';
    }
    return {
      lead: lead,
      meta: meta.length || people ? '<div class="k10g-row-meta"><span class="k10g-row-facts">' + kit.esc(meta.join(' · ')) + '</span>' + people + '</div>' : '',
    };
  }

  function enhanceDirectory() {
    var kit = K();
    var list = doc.getElementById('dir-list');
    if (!kit || !list) return;
    var map = S.inst && S.inst.nodeMap ? S.inst.nodeMap : null;
    var items = list.querySelectorAll('.dir-item:not([data-k10g])');
    items.forEach(function (btn) {
      var id = btn.getAttribute('data-dir-node');
      var n = map && id ? map.get(id) : null;
      if (!n) return;
      btn.setAttribute('data-k10g', '1');
      var d = rowDecor(n, matchPeople(n.label, ''));
      btn.insertAdjacentHTML('afterbegin', d.lead);
      btn.insertAdjacentHTML('beforeend', d.meta);
      btn.classList.add('k10g-row');
    });
  }

  function redecorateDirectory() {
    var list = doc.getElementById('dir-list');
    if (!list) return;
    list.querySelectorAll('.dir-item[data-k10g]').forEach(function (el) {
      el.removeAttribute('data-k10g');
      el.querySelectorAll('.k10g-row-lead, .k10g-row-meta').forEach(function (x) { x.remove(); });
    });
    enhanceDirectory();
  }

  /* ------------------------------------------------------------ canvas overlay */
  function ensureOverlay() {
    if (S.layer && S.layer.isConnected) return S.layer;
    var stage = doc.getElementById('graph-stage');
    if (!stage || !K()) return null;
    var layer = doc.getElementById('k10g-clusters');
    if (!layer) {
      layer = doc.createElement('div');
      layer.id = 'k10g-clusters';
      layer.className = 'k10g-clusters';
      layer.setAttribute('aria-hidden', 'true');
      var canvas = doc.getElementById('graph-canvas');
      stage.insertBefore(layer, canvas ? canvas.nextSibling : stage.firstChild);
    }
    S.clusterEls = {};
    if (!doc.getElementById('k10g-legend')) {
      var lg = doc.createElement('aside');
      lg.id = 'k10g-legend';
      lg.className = 'k10g-legend';
      lg.setAttribute('aria-label', 'Graph legend');
      stage.appendChild(lg);
    }
    S.layer = layer;
    S.geomDirty = true;
    return layer;
  }

  function renderLegend() {
    var lg = doc.getElementById('k10g-legend');
    if (!K() || !lg) return;
    var html = legendHtml(nodes(), edges());
    lg.hidden = !html;
    lg.innerHTML = html;
  }

  function predName(p) {
    return String(p || '').replace(/^domain:.*/, 'domain').replace(/[_.]/g, ' ').trim() || 'link';
  }

  /* Pure renderer: list = engine nodes, edges = engine edges ({predicate}). Empty list gives ''.
     Kind counts live on the pills and cluster labels; the legend explains the marks. */
  function legendHtml(list, edgeList) {
    var kit = K();
    if (!list || !list.length) return '';
    var c = counts(list);
    var preds = new Map();
    (edgeList || []).forEach(function (e) {
      var p = predName(e.predicate);
      preds.set(p, (preds.get(p) || 0) + 1);
    });
    var predRows = Array.from(preds.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4);
    var max = predRows.length ? predRows[0][1] : 1;
    return '<h3 class="k10g-legend-title">Legend</h3>' +
      '<ul class="k10g-legend-kinds">' + CATS.filter(function (cat) { return c[cat.id] > 0; }).map(function (cat) {
        return '<li>' + glyph(cat.id) + '<span>' + kit.esc(cat.label) + '</span></li>';
      }).join('') + '</ul>' +
      '<p class="k10g-legend-note">Larger nodes have more links.</p>' +
      (predRows.length ? '<h3 class="k10g-legend-title">Most common links</h3><ul class="k10g-legend-preds">' + predRows.map(function (r) {
        return '<li><span class="k10g-pred-name">' + kit.esc(r[0]) + '</span><span class="k10g-pred-bar" aria-hidden="true"><span style="width:' + Math.max(4, Math.round((r[1] / max) * 100)) + '%"></span></span><span class="k10g-legend-n">' + kit.esc(kit.fmt(r[1])) + '</span></li>';
      }).join('') + '</ul>' : '');
  }

  function clusterHtml(catId, count) {
    var kit = K();
    var cat = CAT_BY_ID[catId] || CAT_BY_ID.concept;
    return glyph(cat.id) + '<span>' + kit.esc(cat.plural) + '</span><span class="k10g-cluster-n">' + kit.esc(kit.fmt(count)) + '</span>';
  }

  function scheduleOverlay(full) {
    if (full) S.needFull = true;
    if (S.raf) return;
    S.raf = root.requestAnimationFrame(function () {
      S.raf = 0;
      if (!isActive()) return;
      if (S.needFull) {
        S.needFull = false;
        refreshAll();
      }
      positionClusters();
    });
  }

  /* Runs synchronously after each engine frame. All layout reads happen first (cached toolbar
     bottom, label widths measured only when their text changes), then transforms are written. */
  function positionClusters() {
    var inst = S.inst;
    var layer = ensureOverlay();
    if (!inst || !layer || typeof inst.worldToScreen !== 'function') return;
    var vis = Array.isArray(inst.visibleNodes) ? inst.visibleNodes : [];
    var w = inst.width || 0;
    var h = inst.height || 0;
    if (!w || !h) return;

    if (S.geomDirty) {
      var tb = doc.querySelector('#view-graph .graph-toolbar');
      var tbBottom = tb && tb.offsetHeight ? tb.offsetTop + tb.offsetHeight : 80;
      S.topMin = tbBottom + 16;
      S.geomDirty = false;
      if (layer.parentElement) layer.parentElement.style.setProperty('--k10g-toolbar-bottom', Math.round(tbBottom + 8) + 'px');
    }

    var groups = {};
    var ax = 0;
    var ay = 0;
    var zoom = inst.cam && inst.cam.zoom ? inst.cam.zoom : 1;
    var obstacles = [];
    for (var i = 0; i < vis.length; i += 1) {
      var n = vis[i];
      var g = groups[n.category] || (groups[n.category] = { n: 0, sx: 0, sy: 0, list: [] });
      g.n += 1;
      g.sx += n.x;
      g.sy += n.y;
      g.list.push(n);
      ax += n.x;
      ay += n.y;
      var sp = inst.worldToScreen(n.x, n.y);
      var r = Math.max(3.4, Math.min(13.5, (n.radius || 5) * Math.pow(zoom, 0.58))) + 4;
      // Nodes the engine is likely to label: reserve a box for the label pill under or beside them.
      var labelled = n.category === 'connector' || n.category === 'memt' || n.degree >= 5 || zoom >= 1.25;
      var lw = labelled ? Math.min(26, String(n.label || '').length) * 6.2 + 14 : 0;
      obstacles.push({
        x1: sp.x - Math.max(r, lw / 2), x2: sp.x + Math.max(r, lw / 2),
        y1: sp.y - r - (labelled ? 6 : 0), y2: sp.y + r + (labelled ? 24 : 0),
      });
    }
    if (vis.length) { ax /= vis.length; ay /= vis.length; }
    var focus = !!(inst.selectedId || inst.hoveredId);
    if (S.layerDim !== focus) {
      S.layerDim = focus;
      layer.classList.toggle('is-dim', focus);
    }

    // Phase 1: create elements, set text, measure widths (reads only after text writes are batched).
    var todo = [];
    CATS.forEach(function (cat) {
      var gg = groups[cat.id];
      var el = S.clusterEls[cat.id];
      // Small, scattered groups already carry per-node canvas labels; a cluster label would mislead.
      if (!gg || gg.n < 8) {
        if (el && !el.hidden) el.hidden = true;
        return;
      }
      if (!el) {
        el = doc.createElement('div');
        el.className = 'k10g-cluster k10g-cat-' + cat.id;
        layer.appendChild(el);
        S.clusterEls[cat.id] = el;
      }
      var txt = clusterHtml(cat.id, gg.n);
      if (el.__k10gTxt !== txt) {
        el.innerHTML = txt;
        el.__k10gTxt = txt;
        el.__k10gW = 0;
      }
      if (el.hidden) { el.hidden = false; el.__k10gW = el.__k10gW || 0; }
      todo.push({ cat: cat, g: gg, el: el });
    });
    todo.forEach(function (t) {
      if (!t.el.__k10gW) t.el.__k10gW = t.el.offsetWidth || 120;
    });

    // Phase 2: pure maths and writes.
    var placed = [];
    var hitCount = function (box) {
      var hits = 0;
      for (var k = 0; k < obstacles.length; k += 1) {
        var o = obstacles[k];
        if (box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1) hits += 1;
      }
      for (var p = 0; p < placed.length; p += 1) {
        var q = placed[p];
        if (box.x1 - 6 < q.x2 && box.x2 + 6 > q.x1 && box.y1 - 4 < q.y2 && box.y2 + 4 > q.y1) hits += 100;
      }
      return hits;
    };
    todo.forEach(function (t) {
      var gg = t.g;
      var cx = gg.sx / gg.n;
      var cy = gg.sy / gg.n;
      var dx = cx - ax;
      var dy = cy - ay;
      var len = Math.hypot(dx, dy);
      if (len < 40) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
      var reach = 0;
      for (var i2 = 0; i2 < gg.list.length; i2 += 1) {
        var pr = (gg.list[i2].x - cx) * dx + (gg.list[i2].y - cy) * dy;
        if (pr > reach) reach = pr;
      }
      var anchor = inst.worldToScreen(cx + dx * reach, cy + dy * reach);
      var halfW = t.el.__k10gW / 2;
      var halfH = 12;
      var best = null;
      var bestHits = Infinity;
      // Walk outward along the normal, with small sideways nudges, until the label is clear.
      var pads = [22, 38, 56, 76, 100];
      var sides = [0, 1, -1, 2, -2];
      for (var a = 0; a < pads.length && bestHits > 0; a += 1) {
        for (var b = 0; b < sides.length && bestHits > 0; b += 1) {
          var x = anchor.x + dx * pads[a] - dy * sides[b] * (halfW + 8);
          var y = anchor.y + dy * pads[a] + dx * sides[b] * (halfH + 6);
          if (Math.abs(dx) < 0.5) x = anchor.x + sides[b] * (halfW * 0.9 + 10);
          x = Math.max(halfW + 8, Math.min(w - halfW - 8, x));
          y = Math.max(S.topMin + halfH, Math.min(h - halfH - 8, y));
          var box = { x1: x - halfW, x2: x + halfW, y1: y - halfH, y2: y + halfH };
          var hits = hitCount(box);
          if (hits < bestHits) { bestHits = hits; best = box; }
        }
      }
      placed.push(best);
      var tx = Math.round(best.x1);
      var ty = Math.round(best.y1);
      var key = tx + ',' + ty;
      if (t.el.__k10gPos !== key) {
        t.el.__k10gPos = key;
        t.el.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
      }
    });
  }

  /* ------------------------------------------------------------ inspector */
  function selectedNode() {
    var inst = S.inst;
    if (!inst || !inst.nodeMap) return null;
    var id = inst.selectedId;
    return id ? inst.nodeMap.get(id) || null : null;
  }

  /* The app reuses the neighbour and claim lists between nodes and only replaces them when
     /api/node answers. Children present when a new node opens are marked stale and hidden. */
  function markStale(listId) {
    var el = doc.getElementById(listId);
    if (!el) return;
    Array.prototype.forEach.call(el.children, function (c) { c.setAttribute('data-k10g-old', '1'); });
  }
  function freshChildren(listId) {
    var el = doc.getElementById(listId);
    if (!el) return [];
    return Array.prototype.filter.call(el.children, function (c) { return !c.hasAttribute('data-k10g-old'); });
  }

  function detailState() {
    var claims = freshChildren('inspector-claims-list');
    var neigh = freshChildren('inspector-neighbors-list');
    var failed = claims.some(function (c) { return c.classList.contains('empty-state'); });
    if (failed) return { state: 'failed' };
    if (!neigh.length || !claims.length) return { state: 'pending' };
    return {
      state: 'loaded',
      neighbors: neigh.filter(function (c) { return c.classList.contains('neighbor-chip'); }).length,
      claims: claims.filter(function (c) { return c.classList.contains('claim-row'); }).length,
    };
  }

  /* Every link of the node from the full canvas edge list (the /api/node neighbour list is capped). */
  function connectionMix(id) {
    var map = S.inst && S.inst.nodeMap;
    if (!map || !id) return { total: null, kinds: [], preds: [] };
    var seen = new Set();
    var byCat = {};
    var preds = new Map();
    edges().forEach(function (e) {
      var ends = edgeEnds(e);
      var other = ends[0] === id ? ends[1] : ends[1] === id ? ends[0] : null;
      if (other == null) return;
      var pn = predName(e.predicate);
      preds.set(pn, (preds.get(pn) || 0) + 1);
      if (seen.has(other)) return;
      seen.add(other);
      var o = map.get(other);
      var cat = o ? o.category : 'other';
      byCat[cat] = (byCat[cat] || 0) + 1;
    });
    var kinds = CATS.filter(function (cat) { return byCat[cat.id]; }).map(function (cat) {
      return { label: cat.plural, value: byCat[cat.id], tone: cat.tone };
    });
    if (byCat.other) kinds.push({ label: 'Not on canvas', value: byCat.other, tone: 'slate' });
    return {
      total: seen.size,
      kinds: kinds,
      preds: Array.from(preds.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3),
    };
  }

  function setSectionNote(sectionChildId, noteId, text) {
    var anchor = doc.getElementById(sectionChildId);
    if (!anchor || !anchor.parentElement) return;
    var note = doc.getElementById(noteId);
    if (!note) {
      note = doc.createElement('span');
      note.id = noteId;
      note.className = 'k10g-count';
      anchor.insertAdjacentElement('afterend', note);
    }
    if (note.textContent !== text) note.textContent = text;
  }

  function normaliseEyebrows(isConnector) {
    Object.keys(EYEBROWS).forEach(function (id) {
      var h = doc.querySelector('#' + id + ' .section-eyebrow');
      if (h && h.textContent !== EYEBROWS[id]) h.textContent = EYEBROWS[id];
    });
    var nb = doc.getElementById('inspector-neighbors-count');
    var nbH = nb && nb.parentElement && nb.parentElement.querySelector('.section-eyebrow');
    if (nbH && nbH.textContent !== 'Connected neighbors') nbH.textContent = 'Connected neighbors';
    var cl = doc.getElementById('inspector-claims-count');
    var clH = cl && cl.parentElement && cl.parentElement.querySelector('.section-eyebrow');
    var want = isConnector ? 'Recent events' : 'Live claims';
    if (clH && clH.textContent !== want) clH.textContent = want;
  }

  function decorateChips() {
    var map = S.inst && S.inst.nodeMap;
    if (!map) return;
    doc.querySelectorAll('#inspector-neighbors-list .neighbor-chip[data-jump-node]:not([data-k10g])').forEach(function (chip) {
      var n = map.get(chip.getAttribute('data-jump-node'));
      chip.setAttribute('data-k10g', '1');
      if (n) chip.insertAdjacentHTML('afterbegin', glyph(n.category));
    });
  }

  function renderInspector() {
    var kit = K();
    var drawer = doc.getElementById('node-inspector');
    var body = doc.getElementById('inspector-body');
    if (!kit || !drawer || !body) return;
    var titleEl = doc.getElementById('inspector-title');
    var title = titleEl ? titleEl.textContent.trim() : '';
    var n = selectedNode();
    if (n && title && n.label !== title && !(n.raw && n.raw.label === title)) n = null;
    var hero = doc.getElementById('k10g-insp-hero');
    if (!hero) {
      hero = doc.createElement('div');
      hero.id = 'k10g-insp-hero';
      hero.className = 'k10g-insp-hero';
      body.insertBefore(hero, body.firstChild);
    }
    drawer.classList.add('k10g-insp');
    if (!title || title === 'Select a node') {
      hero.innerHTML = '';
      hero.__k10gSig = '';
      return;
    }
    var cat = CAT_BY_ID[(n && n.category) || 'concept'] || CAT_BY_ID.concept;
    var ds = detailState();
    drawer.classList.toggle('k10g-pending', ds.state === 'pending');
    drawer.classList.toggle('k10g-failed', ds.state === 'failed');
    normaliseEyebrows(cat.id === 'connector');
    decorateChips();

    var degree = n ? num(n.degree) : null;
    var mix = n ? connectionMix(n.id) : { total: null, kinds: [], preds: [] };
    var links = degree != null ? degree : mix.total;

    // Section counts: show what is listed against the canvas truth, never two different totals.
    if (ds.state === 'loaded') {
      var nbText = links != null && ds.neighbors < links ? kit.fmt(ds.neighbors) + ' of ' + kit.fmt(links) : kit.fmt(ds.neighbors);
      setSectionNote('inspector-neighbors-count', 'k10g-nb-count', nbText);
      var cc = n ? num(n.claim_count) : null;
      var clText = cat.id === 'connector' && cc != null && ds.claims < cc
        ? 'Latest ' + kit.fmt(ds.claims) + ' of ' + kit.fmt(cc)
        : kit.fmt(ds.claims);
      setSectionNote('inspector-claims-count', 'k10g-cl-count', clText);
    } else {
      setSectionNote('inspector-neighbors-count', 'k10g-nb-count', ds.state === 'failed' ? 'Unavailable' : 'Loading');
      setSectionNote('inspector-claims-count', 'k10g-cl-count', ds.state === 'failed' ? 'Unavailable' : 'Loading');
    }

    var conf = n && num(n.confidence) != null ? Math.round(n.confidence * 100) + '%' : null;
    var stats;
    if (cat.id === 'connector') {
      stats = [
        { label: 'Events', value: n ? num(n.claim_count) : null },
        { label: 'Links', value: links },
        { label: 'Latest', value: n ? relTime(n.updated_at) || null : null },
      ];
    } else if (cat.id === 'memt') {
      stats = [
        { label: 'Confidence', value: conf },
        { label: 'Links', value: links },
        { label: 'Updated', value: n ? relTime(n.updated_at) || null : null },
      ];
    } else {
      stats = [
        { label: 'Confidence', value: conf },
        { label: 'Claims', value: ds.state === 'loaded' ? ds.claims : null },
        { label: 'Links', value: links },
      ];
    }

    var summaryText = (doc.getElementById('inspector-summary') || {}).textContent || '';
    var claimsText = freshChildren('inspector-claims-list').map(function (el) {
      var t = el.querySelector('.claim-text');
      return t ? t.textContent : '';
    }).join('\n');
    var matches = matchPeople(title, summaryText + '\n' + claimsText);
    var lowerTitle = title.toLowerCase();
    var self = matches.find(function (m) { return m.how === 'full' && String(m.person.name || '').toLowerCase() === lowerTitle; });
    var isPersonKind = n && /\b(person|people|contact)\b/i.test(String(n.kind || '') + ' ' + String((n.raw && n.raw.group) || ''));
    var leadPerson = self ? self.person : isPersonKind ? { name: title } : null;
    var rt = n ? relTime(n.updated_at) : '';
    var group = n && n.raw && n.raw.group && n.raw.group !== n.category ? String(n.raw.group).replace(/_/g, ' ') : '';
    var subtitle = [cat.one, group, cat.id !== 'connector' && cat.id !== 'memt' && rt ? 'updated ' + rt : ''].filter(Boolean).join(' · ');

    var people = leadPerson && leadPerson.key ? matches.filter(function (m) { return m.person.key !== leadPerson.key; }) : matches;
    var model = {
      id: n ? n.id : title,
      title: title,
      category: cat.id,
      subtitle: subtitle,
      stats: stats,
      leadPerson: leadPerson,
      people: people,
      rosterComplete: !!(S.matcher && S.matcher.complete),
      mix: mix,
    };
    var sig = JSON.stringify([model.id, title, subtitle, stats, people.map(function (m) { return m.person.key + m.how; }), leadPerson && leadPerson.name, mix.total, mix.kinds, mix.preds]);
    if (hero.__k10gSig === sig) return;
    hero.__k10gSig = sig;
    hero.innerHTML = inspectorHtml(model);
  }

  function personItem(m) {
    var kit = K();
    var p = m.person;
    var sub = [m.how === 'first' ? 'First name only' : '', [p.role, p.org].filter(Boolean).join(' · ') || p.relationship_tier || ''].filter(Boolean).join(' · ');
    return '<button type="button" class="k10-prow k10g-person"' + (p.key ? ' data-open-person="' + kit.esc(p.key) + '"' : '') + '>' +
      kit.avatar(p, { size: 32, mode: 'initials' }) +
      '<span class="k10-prow-body"><span class="k10-prow-name k10-truncate">' + kit.esc(p.name || 'Unknown') + '</span>' +
      (sub ? '<span class="k10-prow-sub k10-truncate">' + kit.esc(sub) + '</span>' : '') + '</span>' +
      (p.last_seen_label ? '<span class="k10-prow-right k10g-seen" title="Last seen">' + kit.esc(p.last_seen_label) + '</span>' : '') +
      '</button>';
  }

  /* Pure renderer for the inspector head: banner, people named, connection mix.
     model: { id, title, category, subtitle, stats:[{label,value}], leadPerson, people:[{person,how}],
     rosterComplete, mix:{ total, kinds:[{label,value,tone}], preds:[[name,count]] } } */
  function inspectorHtml(m) {
    var kit = K();
    var cat = CAT_BY_ID[m.category] || CAT_BY_ID.concept;
    var html = kit.banner({
      title: m.title,
      subtitle: m.subtitle,
      eyebrow: m.leadPerson ? 'Person' : cat.one,
      eyebrowIcon: m.leadPerson ? 'person' : cat.icon,
      seed: m.id || m.title,
      tone: cat.tone,
      compact: true,
      avatar: m.leadPerson || undefined,
      stats: m.stats || [],
    });
    var people = (m.people || []).map(function (x) { return x && x.person ? x : { person: x, how: 'full' }; });
    if (people.length) {
      var anyFirst = people.some(function (x) { return x.how === 'first'; });
      html += '<section class="k10g-insp-sec" aria-label="People named here">' +
        kit.sectionHead(anyFirst ? 'Possible people' : 'People named here', '<span class="k10g-sec-count">' + kit.esc(kit.fmt(people.length)) + '</span>', {
          level: 3,
          sub: anyFirst ? 'Some by unique first name' : 'Full-name match',
        }) +
        '<div class="k10g-people">' + people.slice(0, 6).map(personItem).join('') + '</div>' +
        (people.length > 6 ? '<p class="k10g-more">' + kit.esc(kit.fmt(people.length - 6)) + ' more named in the claims</p>' : '') +
        '</section>';
    }
    var mix = m.mix || { kinds: [] };
    if (mix.kinds && mix.kinds.length) {
      var predLine = (mix.preds || []).map(function (p) { return p[0] + ' ' + kit.fmt(p[1]); }).join(' · ');
      html += '<section class="k10g-insp-sec" aria-label="Connections by kind">' +
        kit.sectionHead('Connections by kind', '<span class="k10g-sec-count">' + kit.esc(kit.fmt(mix.total)) + '</span>', {
          level: 3,
          sub: 'All canvas links',
        }) +
        kit.bars(mix.kinds, {}) +
        (predLine ? '<p class="k10g-preds">' + kit.esc(predLine) + '</p>' : '') +
        '</section>';
    } else if (mix.total === 0) {
      html += '<section class="k10g-insp-sec" aria-label="Connections by kind">' +
        kit.sectionHead('Connections by kind', '', { level: 3 }) +
        kit.emptyState({ title: 'No links on the canvas', body: 'This node has no edges in the loaded graph.', icon: 'link', compact: true }) +
        '</section>';
    }
    return html;
  }

  /* ------------------------------------------------------------ wiring */
  function refreshAll() {
    ensureOverlay();
    var list = nodes();
    var sig = dataSig(list, edges().length);
    if (sig !== S.lastDataSig) {
      S.lastDataSig = sig;
      renderHero();
      renderLegend();
      redecorateDirectory();
    }
    syncPills();
    decorateMetrics();
    enhanceDirectory();
  }

  function observe() {
    if (S.mounted) return;
    var list = doc.getElementById('dir-list');
    var insp = doc.getElementById('node-inspector');
    if (!list || !insp || typeof MutationObserver !== 'function') return;
    S.mounted = true;
    new MutationObserver(function () { enhanceDirectory(); }).observe(list, { childList: true });

    var inspTimer = 0;
    var titleEl = doc.getElementById('inspector-title');
    var nbList = doc.getElementById('inspector-neighbors-list');
    var clList = doc.getElementById('inspector-claims-list');
    var inspObs = new MutationObserver(function (records) {
      var titleChanged = false;
      var nbChanged = false;
      var clChanged = false;
      var relevant = false;
      for (var i = 0; i < records.length; i += 1) {
        var t = records[i].target;
        if (t && t.nodeType !== 1) t = t.parentElement;
        if (!t || (t.closest && t.closest('#k10g-insp-hero'))) continue;
        relevant = true;
        if (titleEl && (t === titleEl || titleEl.contains(t))) titleChanged = true;
        if (t === nbList && records[i].type === 'childList') nbChanged = true;
        if (t === clList && records[i].type === 'childList') clChanged = true;
      }
      if (!relevant) return;
      // A new node opened: whatever the lists show belongs to the previous node until /api/node answers.
      if (titleChanged && !nbChanged) markStale('inspector-neighbors-list');
      if (titleChanged && !clChanged) markStale('inspector-claims-list');
      if (inspTimer) return;
      inspTimer = root.setTimeout(function () { inspTimer = 0; renderInspector(); }, 30);
    });
    if (titleEl) inspObs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    if (nbList) inspObs.observe(nbList, { childList: true });
    if (clList) inspObs.observe(clList, { childList: true });
    var sum = doc.getElementById('inspector-summary');
    if (sum) inspObs.observe(sum, { childList: true });
  }

  function startTicker() {
    if (S.ticker) return;
    S.ticker = root.setInterval(function () {
      if (!isActive()) {
        root.clearInterval(S.ticker);
        S.ticker = 0;
        return;
      }
      renderHero();
    }, 60000);
  }

  function onActivate() {
    patchEngine();
    if (!isActive()) return;
    observe();
    ensureOverlay();
    startTicker();
    loadRoster().then(function () {
      if (!isActive()) return;
      redecorateDirectory();
      var hero = doc.getElementById('k10g-insp-hero');
      if (hero) hero.__k10gSig = '';
      renderInspector();
    });
    S.lastDataSig = '';
    S.geomDirty = true;
    scheduleOverlay(true);
  }

  root.KizukiGraphW10 = Object.freeze({
    categories: CATS.map(function (c) { return { id: c.id, label: c.label, plural: c.plural, one: c.one, tone: c.tone }; }),
    heroHtml: function (list, edgeCount, opts) { return K() ? heroHtml(list, edgeCount, opts) : ''; },
    rowDecor: function (n, matches) { return K() ? rowDecor(n, matches) : { lead: '', meta: '' }; },
    legendHtml: function (list, edgeList) { return K() ? legendHtml(list, edgeList) : ''; },
    clusterHtml: function (catId, count) { return K() ? clusterHtml(catId, count) : ''; },
    inspectorHtml: function (model) { return K() ? inspectorHtml(model) : ''; },
  });

  function boot() {
    var v = viewEl();
    if (!v || !doc.getElementById('graph-canvas')) return;
    patchEngine();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () { if (isActive()) onActivate(); }).observe(v, { attributes: true, attributeFilter: ['hidden'] });
    }
    root.addEventListener('resize', function () {
      S.geomDirty = true;
      if (isActive()) scheduleOverlay(false);
    }, { passive: true });
    if (isActive()) onActivate();
    // The graph chunk may load after this bundle; patch it once it appears (bounded wait).
    var tries = 0;
    var t = root.setInterval(function () {
      tries += 1;
      var ok = patchEngine();
      if (ok && S.inst) {
        root.clearInterval(t);
        if (isActive()) scheduleOverlay(true);
      } else if (tries > 60) {
        root.clearInterval(t);
      }
    }, 500);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
