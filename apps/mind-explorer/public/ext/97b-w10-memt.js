/* Wave 10: MemT procedural library.
   Adds a library banner with an actionable stat strip, one row of insight cards (domains,
   evidence, growth), a sort and evidence-filter toolbar, and decorates each recipe card with
   status chips, an inline confidence ring, a verification block, sources and facts.
   Data: GET /api/memt only. The request is issued alongside the core loader, so the
   same-origin coalescer hands both callers the same response. Every figure is computed from
   that response; missing values render as '--' or an explicit unavailable state. */
(function initW10Memt() {
  'use strict';
  if (window.__w10Memt) return;
  window.__w10Memt = true;

  const ROOT_ID = 'view-memt';
  const LOW_CONF = 80;
  const LOW_SHARE = 50;
  const SYNC_CMD = 'kizuki memt sync --dry-run';
  const SORTS = [
    { id: 'newest', label: 'Newest' },
    { id: 'weakest', label: 'Weakest first' },
    { id: 'cited', label: 'Most cited' },
    { id: 'domain', label: 'Domain' },
  ];
  const st = {
    data: null,
    loading: null,
    failed: false,
    sort: 'newest',
    needProof: false,
    needCites: false,
    observer: null,
    expanded: new Set(),
    usesTracked: false,
  };

  try {
    const saved = JSON.parse(window.localStorage.getItem('kz-w10-memt') || '{}');
    if (saved && saved.sort === 'confidence') saved.sort = 'weakest';
    if (saved && SORTS.some((s) => s.id === saved.sort)) st.sort = saved.sort;
    if (saved && saved.needProof === true) st.needProof = true;
    if (saved && saved.needCites === true) st.needCites = true;
  } catch (_) { /* storage unavailable: defaults apply */ }

  function persist() {
    try {
      window.localStorage.setItem('kz-w10-memt', JSON.stringify({ sort: st.sort, needProof: st.needProof, needCites: st.needCites }));
    } catch (_) { /* ignore */ }
  }

  const K = () => window.KizukiKit;
  const root = () => document.getElementById(ROOT_ID);
  /* Mirrors app.js stripEmDash so card text compares equal to the record text. */
  const strip = (s) => String(s || '').replace(/—/g, ' - ');
  const cap = (s) => { const t = String(s || ''); return t.charAt(0).toUpperCase() + t.slice(1); };
  const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));

  function domainOf(exp) { return String((exp && exp.domain) || 'general').toLowerCase(); }
  function confPct(exp) {
    const n = num(exp && exp.confidence);
    return n == null ? null : Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
  }
  function confColor(p) { return p != null && p < LOW_CONF ? 'orange' : 'var(--ink-secondary)'; }
  function cites(exp) { return Array.isArray(exp && exp.citations) ? exp.citations.filter((c) => typeof c === 'string' && c.trim()) : []; }
  function hasProof(exp) { return !!String((exp && (exp.verification || exp.proof)) || '').trim(); }
  function uses(exp) { return exp ? num(exp.use_count ?? exp.uses) : null; }
  function ts(exp, key) {
    const t = Date.parse(exp && (exp[key] || exp.created_at || exp.updated_at));
    return Number.isFinite(t) ? t : null;
  }
  /* Verified only when the record says so. A record without any status field is Unknown. */
  function isVerified(exp) {
    return !!exp && (exp.outcome === 'verified' || exp.verified === true || exp.status === 'verified');
  }
  function statusLabel(exp) {
    if (isVerified(exp)) return { text: 'Verified', tone: 'emerald', icon: 'check' };
    const raw = exp && (exp.outcome || exp.status || (exp.verified === false ? 'unverified' : ''));
    if (!raw) return { text: 'Unknown status', tone: 'slate' };
    return { text: cap(raw), tone: raw === 'failed' ? 'rose' : 'orange' };
  }

  function relTime(t) {
    if (t == null) return null;
    const d = Date.now() - t;
    const m = Math.round(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const days = Math.round(h / 24);
    if (days < 45) return days + 'd ago';
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function shortDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function clip(s, n) { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }

  /* ------------------------------------------------------------ data */
  function fetchOnce() {
    return fetch('/api/memt', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
  }

  /* Network and HTTP errors retry twice with a longer wait each time. An engine timeout
     arrives as HTTP 200 with mode "unavailable"; that is a valid answer, not retried here. */
  function fetchData() {
    if (st.loading) return st.loading;
    let attempt = 0;
    const run = () => fetchOnce().catch((err) => {
      if (attempt >= 2) throw err;
      attempt += 1;
      return new Promise((res) => setTimeout(res, 1500 * attempt)).then(run);
    });
    st.loading = run()
      .then((d) => {
        st.data = d && typeof d === 'object' ? d : { experiences: [] };
        st.failed = false;
        return st.data;
      })
      .catch((err) => { st.failed = true; throw err; })
      .finally(() => { st.loading = null; });
    return st.loading;
  }

  function exps() { return st.data && Array.isArray(st.data.experiences) ? st.data.experiences : []; }

  function statusOk(status) {
    return !!status && typeof status === 'object' && status.mode !== 'unavailable';
  }

  function summarize(list, rawStatus) {
    const status = statusOk(rawStatus) ? rawStatus : null;
    const s = (status && status.experiences) || {};
    const loaded = list.length;
    const engineTotal = status ? num(s.total) : null;
    const confs = list.map(confPct).filter((v) => v != null);
    const domains = new Map();
    for (const e of list) domains.set(domainOf(e), (domains.get(domainOf(e)) || 0) + 1);
    const created = list.map((e) => ts(e, 'created_at')).filter((v) => v != null);
    const useVals = list.map(uses).filter((v) => v != null);
    const sens = new Map();
    for (const e of list) if (e.sensitivity) sens.set(String(e.sensitivity), (sens.get(String(e.sensitivity)) || 0) + 1);
    let weakest = null;
    for (const e of list) {
      const p = confPct(e);
      if (p != null && (!weakest || p < weakest.pct)) weakest = { pct: p, exp: e };
    }
    const weakestTies = weakest ? list.filter((e) => confPct(e) === weakest.pct).length : 0;
    return {
      loaded,
      engineOk: !!status,
      engineTotal,
      truncated: engineTotal != null && engineTotal > loaded,
      verified: status ? num(s.verified) : null,
      observed: status ? num(s.observed) : null,
      failed: status ? num(s.failed) : null,
      uninternalized: status ? num(s.uninternalized) : null,
      verifiedLoaded: list.filter(isVerified).length,
      avgConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      confKnown: confs.length,
      weakest,
      weakestTies,
      withProof: list.filter(hasProof).length,
      withCites: list.filter((e) => cites(e).length > 0).length,
      citeTotal: list.reduce((a, e) => a + cites(e).length, 0),
      internalized: list.filter((e) => e.internalized_in_snapshot != null && e.internalized_in_snapshot !== '').length,
      embedded: list.filter((e) => e.has_embedding === true).length,
      embedKnown: list.some((e) => typeof e.has_embedding === 'boolean'),
      usesTracked: useVals.some((v) => v > 0),
      usesTotal: useVals.length ? useVals.reduce((a, b) => a + b, 0) : null,
      domains: Array.from(domains.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      lastAdded: created.length ? Math.max(...created) : null,
      created,
      sens: Array.from(sens.entries()).sort((a, b) => b[1] - a[1]),
      snapshots: status && status.snapshots ? num(status.snapshots.total) : null,
      mode: status && status.mode ? String(status.mode) : null,
      gpu: status && status.gpu_backend ? String(status.gpu_backend) : null,
    };
  }

  const pct = (a, b) => (b > 0 && a != null ? (a / b) * 100 : null);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  /* ------------------------------------------------------------ hero */
  function heroSkeleton() {
    return '<div class="w10m-skel" aria-busy="true" aria-label="Loading MemT library">' +
      '<div class="w10m-skel-body"><div class="w10m-skel-text"><span class="w10m-skel-line is-eyebrow"></span><span class="w10m-skel-line is-title"></span><span class="w10m-skel-line is-sub"></span></div><span class="w10m-skel-ring"></span></div>' +
      '<div class="w10m-skel-stats"><span></span><span></span><span></span><span></span></div></div>';
  }

  function statCell(o) {
    const k = K();
    const blank = o.value == null || o.value === '';
    const tag = o.action ? 'button type="button"' : 'div';
    const close = o.action ? 'button' : 'div';
    const attrs = (o.action ? ' data-k10-action="' + k.esc(o.action) + '"' : '') + (o.id ? ' data-k10-id="' + k.esc(o.id) + '"' : '') + (o.title ? ' title="' + k.esc(o.title) + '"' : '');
    return '<' + tag + ' class="w10m-stat' + (blank ? ' is-empty' : '') + (o.warn ? ' is-warn' : '') + '"' + attrs + '>' +
      '<span class="w10m-stat-label">' + k.esc(o.label) + (o.action ? k.icon('arrow', 11) : '') + '</span>' +
      '<span class="w10m-stat-val">' + k.esc(blank ? '--' : String(o.value)) + (o.unit && !blank ? '<span class="w10m-stat-unit">' + k.esc(o.unit) + '</span>' : '') + '</span>' +
      '<span class="w10m-stat-sub k10-truncate">' + k.esc(o.sub || (blank ? 'Unavailable' : '')) + '</span>' +
      '</' + close + '>';
  }

  function heroHtml(data, active) {
    const k = K();
    if (!data) return heroSkeleton();
    const list = Array.isArray(data.experiences) ? data.experiences : [];
    const status = data.status || null;
    const S = summarize(list, status);
    if (!list.length) {
      const confirmedEmpty = S.engineOk && S.engineTotal === 0;
      return confirmedEmpty
        ? k.emptyState({ title: 'No recipes yet', body: 'The MemT engine reports no stored experiences. Save a verified recipe to start the library.', icon: 'layers', action: { label: 'New recipe', action: 'w10m-new', icon: 'plus' } })
        : k.emptyState({ title: 'Recipes did not load', body: S.engineOk ? 'The engine answered but its recipe list came back empty, so library figures are unavailable.' : 'The MemT engine did not answer in time, so the recipe list and library figures are unavailable.', icon: 'alert', compact: true, action: { label: 'Try again', action: 'w10m-retry' } });
    }

    const scope = S.truncated ? 'the ' + S.loaded + ' most recent' : null;
    const engine = [S.mode ? 'Engine ' + S.mode : '', S.gpu ? 'GPU ' + S.gpu : ''].filter(Boolean).join(', ');
    const domainsPhrase = plural(S.domains.length, 'domain');
    const title = S.engineOk && S.engineTotal != null
      ? plural(S.engineTotal, 'recipe') + (scope ? '' : ' across ' + domainsPhrase)
      : plural(S.loaded, 'recipe') + ' loaded across ' + domainsPhrase;
    const subtitle = (S.engineOk ? '' : 'Engine status unavailable, so verification totals are not shown. ') +
      (scope ? 'Figures below cover ' + scope + ', which span ' + domainsPhrase + '. ' : '') +
      (engine ? engine + '.' : '');
    const ringHtml = '<div class="w10m-hero-ring">' +
      k.ring(S.avgConf, confColor(S.avgConf), { size: 72, stroke: 5, aria: S.avgConf == null ? 'Average confidence unavailable' : 'Average confidence ' + Math.round(S.avgConf) + ' percent' }) +
      '<span class="w10m-hero-ring-cap">Average confidence' + (S.confKnown && S.confKnown < S.loaded ? '<br>' + S.confKnown + ' of ' + S.loaded + ' scored' : '') + '</span></div>';

    const banner = k.banner({
      eyebrow: 'Procedural memory', eyebrowIcon: 'brain', title, subtitle,
      seed: 'memt-library', tone: 'emerald', art: 'contour', right: ringHtml,
    });

    const w = S.weakest;
    const statusSub = S.observed != null || S.failed != null ? (scope ? 'Whole library, ' : '') + k.fmt(S.observed) + ' observed, ' + k.fmt(S.failed) + ' failed' : (S.engineOk ? '' : 'Engine status unavailable');
    const statStrip = '<div class="w10m-stats">' +
      statCell({ label: 'Verified', value: S.engineOk ? S.verified : null, unit: S.engineOk && S.engineTotal != null ? '/' + S.engineTotal : '', sub: statusSub }) +
      statCell({ label: 'Weakest recipe', value: w ? Math.round(w.pct) : null, unit: '%', warn: w && w.pct < LOW_CONF,
        sub: w ? clip(strip(w.exp.condition || w.exp.title || ''), 64) + (S.weakestTies > 1 ? ' (+' + (S.weakestTies - 1) + ' tied)' : '') : 'No confidence scores',
        title: w ? 'Show this recipe: ' + strip(w.exp.condition || '') : '',
        action: w && w.exp.id ? 'w10m-weakest' : '', id: w ? w.exp.id : '' }) +
      statCell({ label: 'Has a proof check', value: S.withProof, unit: '/' + S.loaded,
        sub: S.loaded - S.withProof === 0 ? 'Every recipe' + (scope ? ' loaded' : '') : (S.loaded - S.withProof) + ' without a check' }) +
      statCell({ label: 'Internalized', value: S.internalized, unit: '/' + S.loaded, warn: S.internalized === 0,
        sub: S.snapshots == null ? (S.engineOk ? 'Snapshot count unavailable' : 'Engine status unavailable') : plural(S.snapshots, 'snapshot') + (S.uninternalized != null ? ', ' + k.fmt(S.uninternalized) + ' pending' : '') }) +
      '</div>';
    const bannerHtml = banner.replace(/<\/section>\s*$/, statStrip + '</section>');

    const domainBars = k.bars(S.domains.slice(0, 5).map(([d, n]) => ({
      label: d, value: n, tone: d === active ? 'cobalt' : 'slate', action: 'w10m-domain', id: d,
    })), { empty: 'No domains' });
    const moreDomains = S.domains.length > 5 ? '<p class="w10m-note">' + (S.domains.length - 5) + ' more in the filter row below</p>' : '';
    const domainCard = k.card({
      title: 'Domains', sub: 'Recipes per domain' + (scope ? ', ' + scope : '') + '. Select one to filter.',
      right: '<button type="button" class="w10m-link" data-k10-action="w10m-domain" data-k10-id="all"' + (active === 'all' ? ' hidden' : '') + '>Clear</button>',
      body: '<div class="w10m-domain-bars" data-active="' + k.esc(active) + '">' + domainBars + '</div>' + moreDomains,
    });

    const meter = (value, label) => {
      const p = value;
      return k.meter(p, { label, tone: p != null && p < LOW_SHARE ? 'orange' : 'var(--ink-secondary)' });
    };
    const needSync = S.internalized < S.loaded || (S.embedKnown && S.embedded < S.loaded);
    const evidenceBody =
      meter(pct(S.withCites, S.loaded), 'Cites a source (' + plural(S.citeTotal, 'citation') + ')') +
      meter(S.embedKnown ? pct(S.embedded, S.loaded) : null, 'Embedded for recall') +
      meter(pct(S.confKnown, S.loaded), 'Has a confidence score') +
      '<div class="w10m-ev-foot">' +
        (S.sens.length ? '<div class="w10m-sens">' + S.sens.map(([name, n]) => k.chip(cap(name) + ' ' + n, null)).join('') + '</div>' : '') +
        '<p class="w10m-note">' + (S.usesTracked ? 'Applied ' + plural(S.usesTotal, 'time') + ' in total.' : 'Use counts are not tracked yet.') + '</p>' +
        (needSync ? '<button type="button" class="w10m-action" data-copy-text="' + k.esc(SYNC_CMD) + '" title="Copies ' + k.esc(SYNC_CMD) + '">' + k.icon('doc', 12) + 'Copy sync preview command</button>' : '') +
      '</div>';
    const evidenceCard = k.card({ title: 'Evidence', sub: 'Share of ' + (scope || plural(S.loaded, 'recipe')), body: '<div class="w10m-meters">' + evidenceBody + '</div>' });

    const DAYS = 14;
    const now = new Date();
    const days = [];
    for (let i = 0; i < DAYS; i++) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1) + i));
    const start = days[0].getTime();
    const perDay = new Map();
    for (const t of S.created) { const key = dayKey(new Date(t)); perDay.set(key, (perDay.get(key) || 0) + 1); }
    let run = S.created.filter((t) => t < start).length;
    const cumulative = [];
    const daily = [];
    for (const d of days) {
      const n = perDay.get(dayKey(d)) || 0;
      run += n;
      daily.push(n);
      cumulative.push(run);
    }
    const added = daily.reduce((a, b) => a + b, 0);
    const busiest = daily.reduce((best, n, i) => (n > best.n ? { n, i } : best), { n: 0, i: -1 });
    const growthBody = S.created.length
      ? '<div class="w10m-growth"><div class="w10m-growth-num"><span class="w10m-big">' + k.fmt(added) + '</span><span class="w10m-big-cap">added in 14 days</span></div>' +
        '<div class="w10m-growth-spark">' + k.sparkline(cumulative, { width: 260, height: 52, tone: 'var(--ink-secondary)', min: 0, aria: 'Recipes over 14 days, now ' + run }) + '</div>' +
        '<div class="w10m-growth-axis"><span>' + shortDate(days[0]) + '</span><span>Today</span></div>' +
        '<p class="w10m-note">' + (busiest.i >= 0 ? 'Busiest day ' + k.esc(shortDate(days[busiest.i])) + ' with ' + plural(busiest.n, 'recipe') + '. ' : 'No recipes added in this window. ') +
          (S.lastAdded != null ? 'Last added ' + k.esc(relTime(S.lastAdded)) + '.' : '') + '</p>' +
        '</div>'
      : k.unavailable('No creation dates');
    const growthCard = k.card({ title: 'Library growth', sub: 'Running total' + (scope ? ' of ' + scope : '') + ', last 14 days', body: growthBody });

    return bannerHtml + '<div class="k10-grid-3 w10m-insights">' + domainCard + evidenceCard + growthCard + '</div>';
  }

  function heroFailedHtml() {
    return K().emptyState({ title: 'Library summary unavailable', body: 'The MemT endpoint did not respond after three attempts. Recipe cards below come from the core view and show no confidence or status until the summary loads.', icon: 'alert', compact: true, action: { label: 'Try again', action: 'w10m-retry' } });
  }

  function renderHero() {
    const k = K();
    const r = root();
    if (!k || !r) return;
    let host = r.querySelector('#w10-memt-hero');
    if (!host) {
      host = document.createElement('div');
      host.id = 'w10-memt-hero';
      host.className = 'w10m-hero';
      const anchor = r.querySelector('.memt-controls');
      if (!anchor || !anchor.parentNode) return;
      anchor.parentNode.insertBefore(host, anchor);
    }
    host.innerHTML = st.failed && !st.data ? heroFailedHtml() : heroHtml(st.data, activeDomain());
  }

  /* ------------------------------------------------------------ toolbar */
  function renderToolbar() {
    const k = K();
    const r = root();
    if (!k || !r) return;
    let bar = r.querySelector('#w10-memt-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'w10-memt-toolbar';
      bar.className = 'w10m-toolbar';
      const list = r.querySelector('#memt-list');
      if (!list || !list.parentNode) return;
      list.parentNode.insertBefore(bar, list);
    }
    bar.innerHTML = toolbarHtml(st);
  }

  function toolbarHtml(o) {
    const k = K();
    const sortBtns = SORTS.map((s) => '<button type="button" class="w10m-seg-btn" data-w10m-sort="' + s.id + '" aria-pressed="' + (o.sort === s.id) + '">' + k.esc(s.label) + '</button>').join('');
    return '<div class="w10m-count" role="status" aria-live="polite">' + (o.countHtml || '') + '</div>' +
      '<div class="w10m-tools">' +
        '<div class="w10m-toggles" role="group" aria-label="Evidence filters">' +
          '<button type="button" class="w10m-toggle" data-w10m-toggle="proof" aria-pressed="' + !!o.needProof + '">' + k.icon('check', 12) + 'Has proof</button>' +
          '<button type="button" class="w10m-toggle" data-w10m-toggle="cites" aria-pressed="' + !!o.needCites + '">' + k.icon('link', 12) + 'Has citations</button>' +
        '</div>' +
        '<div class="w10m-seg" role="group" aria-label="Sort recipes">' + sortBtns + '</div>' +
      '</div>';
  }

  function countHtml(shown, loaded, total, scopeParts) {
    const k = K();
    return '<span class="w10m-count-n">' + shown + '</span> of ' + loaded + ' recipes' +
      (scopeParts.length ? '<span class="w10m-count-scope"> in ' + k.esc(scopeParts.join(', ')) + '</span>' : '') +
      (total != null && total > loaded ? '<span class="w10m-count-trunc">Showing the ' + loaded + ' most recent of ' + total + '</span>' : '');
  }

  /* ------------------------------------------------------------ cards */
  function proofHtml(text) {
    const k = K();
    /* Prose stays in the body font; only `backticked` spans become code. */
    return String(text).split(/(`[^`]+`)/g).map((part) => (/^`[^`]+`$/.test(part) ? '<code>' + k.esc(part.slice(1, -1)) + '</code>' : k.esc(part))).join('');
  }

  function decorateCard(card, exp, opts) {
    const k = K();
    const o = opts || {};
    const usesTracked = o.usesTracked != null ? o.usesTracked : st.usesTracked;
    const domain = domainOf(exp);
    const p = confPct(exp);
    const c = cites(exp);
    const u = uses(exp);
    const created = ts(exp, 'created_at');
    const updated = ts(exp, 'updated_at');
    card.dataset.w10 = '1';
    card.dataset.w10Id = exp.id || '';
    card.dataset.w10Conf = p == null ? '' : String(p);
    card.dataset.w10Cites = String(c.length);
    card.dataset.w10Created = created == null ? '0' : String(created);
    card.dataset.w10Domain = domain;
    card.dataset.w10Proof = hasProof(exp) ? '1' : '0';
    card.classList.add('w10m-card');
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');

    const head = card.querySelector('.memt-card-head');
    if (head && !card.querySelector('.w10m-chips')) {
      const sl = statusLabel(exp);
      const scope = exp.scope_key && !['general', 'default', domain].includes(String(exp.scope_key).toLowerCase()) ? String(exp.scope_key) : '';
      const chips = document.createElement('div');
      chips.className = 'w10m-chips';
      chips.innerHTML =
        '<div class="w10m-chip-row">' +
          '<span class="w10m-domain">' + k.esc(domain) + (scope ? '<span class="w10m-scope">' + k.esc(scope) + '</span>' : '') + '</span>' +
          k.chip(sl.text, sl.tone, { icon: sl.icon, dot: !sl.icon }) +
          (exp.sensitivity ? '<span class="w10m-sens-tag">' + k.esc(cap(exp.sensitivity)) + '</span>' : '') +
          (updated != null ? '<span class="w10m-when" title="Updated ' + k.esc(new Date(updated).toLocaleString('en-GB')) + '">' + k.esc(relTime(updated)) + '</span>' : '') +
        '</div>' +
        '<span class="w10m-conf' + (p != null && p < LOW_CONF ? ' is-low' : '') + '" title="' + (p == null ? 'No confidence score stored' : 'Confidence ' + Math.round(p) + '%') + '">' +
          k.ring(p, confColor(p), { size: 16, stroke: 2.5, label: '', aria: p == null ? 'Confidence unavailable' : 'Confidence ' + Math.round(p) + ' percent' }) +
          '<span class="w10m-conf-v" aria-hidden="true">' + (p == null ? '--' : Math.round(p) + '%') + '</span></span>';
      head.replaceWith(chips);
    }

    const rec = card.querySelector('.memt-recommendation');
    if (rec && !card.querySelector('.w10m-more')) {
      const long = (rec.textContent || '').length > 240;
      if (long) {
        const key = exp.id || rec.textContent.slice(0, 60);
        rec.id = rec.id || 'w10m-rec-' + (k.hash(key) >>> 0).toString(36);
        const open = st.expanded.has(key);
        rec.classList.toggle('is-clamped', !open);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'w10m-more';
        btn.dataset.w10mKey = key;
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-controls', rec.id);
        btn.textContent = open ? 'Show less' : 'Show more';
        rec.after(btn);
      }
    }

    const proof = card.querySelector('.memt-verification');
    if (proof && !proof.dataset.w10) {
      proof.dataset.w10 = '1';
      const txt = proof.textContent.replace(/^\s*Proof:\s*/, '');
      proof.innerHTML = '<span class="w10m-proof-label">' + k.icon('check', 12) + 'Verification</span><p class="w10m-proof-text">' + proofHtml(txt) + '</p>';
    }

    const foot = card.querySelector('.highlight-foot');
    if (foot && !card.querySelector('.w10m-facts')) {
      const orig = foot.querySelector(':scope > span');
      if (orig) orig.classList.add('w10m-orig-meta');
      const facts = document.createElement('div');
      facts.className = 'w10m-facts';
      facts.innerHTML =
        (usesTracked ? '<span class="w10m-fact"><span class="w10m-fact-v">' + k.esc(k.fmt(u)) + '</span>' + (u === 1 ? 'use' : 'uses') + '</span>' : '') +
        (c.length ? '' : '<span class="w10m-fact">No sources</span>') +
        '<span class="w10m-fact">Added <span class="w10m-fact-v">' + (created == null ? '--' : k.esc(new Date(created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))) + '</span></span>';
      foot.insertBefore(facts, foot.firstChild);
      if (c.length) {
        const det = document.createElement('details');
        det.className = 'w10m-cites';
        det.innerHTML = '<summary>' + k.icon('link', 12) + 'Sources <span class="w10m-cites-n">' + c.length + '</span></summary><ul>' +
          c.map((path) => {
            const clean = String(path).replace(/^\/home\/[^/]+\//, '~/');
            const parts = clean.split('/');
            const base = parts.pop() || clean;
            return '<li title="' + k.esc(clean) + '"><span class="w10m-cite-base">' + k.esc(base) + '</span><span class="w10m-cite-dir k10-truncate">' + k.esc(parts.join('/') || '') + '</span></li>';
          }).join('') + '</ul>';
        foot.before(det);
      }
    }
  }

  function confKey(el) { return el.dataset.w10Conf === '' || el.dataset.w10Conf == null ? null : Number(el.dataset.w10Conf); }

  function applyListState() {
    const r = root();
    const list = r && r.querySelector('#memt-list');
    if (!list) return;
    const cards = Array.from(list.querySelectorAll(':scope > article.memt-card'));
    const n = (el, key) => Number(el.dataset[key] || 0);
    const sorted = cards.slice().sort((a, b) => {
      if (st.sort === 'weakest') {
        const ca = confKey(a);
        const cb = confKey(b);
        if (ca == null || cb == null) return (ca == null) - (cb == null) || n(b, 'w10Created') - n(a, 'w10Created');
        return ca - cb || n(b, 'w10Created') - n(a, 'w10Created');
      }
      if (st.sort === 'cited') return n(b, 'w10Cites') - n(a, 'w10Cites') || n(b, 'w10Created') - n(a, 'w10Created');
      if (st.sort === 'domain') return String(a.dataset.w10Domain || '~').localeCompare(String(b.dataset.w10Domain || '~')) || n(b, 'w10Created') - n(a, 'w10Created');
      return n(b, 'w10Created') - n(a, 'w10Created');
    });
    if (sorted.some((el, i) => el !== cards[i])) {
      const frag = document.createDocumentFragment();
      sorted.forEach((el) => frag.appendChild(el));
      list.insertBefore(frag, list.firstChild);
    }
    let shown = 0;
    for (const el of cards) {
      const hide = !!el.dataset.w10 && ((st.needProof && el.dataset.w10Proof !== '1') || (st.needCites && el.dataset.w10Cites === '0'));
      el.hidden = hide;
      if (!hide) shown++;
    }
    let empty = list.querySelector(':scope > .w10m-empty');
    if (cards.length && !shown) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'w10m-empty';
        list.appendChild(empty);
      }
      empty.innerHTML = K().emptyState({ title: 'No recipes with this evidence', body: 'The evidence filters hide every recipe in this view.', icon: 'search', compact: true, action: { label: 'Clear evidence filters', action: 'w10m-clear-evidence' } });
    } else if (empty) {
      empty.remove();
    }
    if (st.observer) st.observer.takeRecords();

    const count = r.querySelector('#w10-memt-toolbar .w10m-count');
    if (count) {
      if (!st.data) {
        count.innerHTML = '';
      } else {
        const S = st.data.status;
        const total = statusOk(S) && S.experiences ? num(S.experiences.total) : null;
        const dom = activeDomain();
        const q = (r.querySelector('#memt-search') || {}).value || '';
        const parts = [];
        if (dom !== 'all') parts.push(dom);
        if (q.trim()) parts.push('"' + q.trim() + '"');
        count.innerHTML = countHtml(shown, exps().length, total, parts);
      }
    }
    const bars = r.querySelector('.w10m-domain-bars');
    if (bars) {
      const dom = activeDomain();
      bars.setAttribute('data-active', dom);
      bars.querySelectorAll('[data-k10-id]').forEach((b) => {
        const on = b.getAttribute('data-k10-id') === dom;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
        const fill = b.querySelector('.k10-bar-fill');
        if (fill) fill.style.background = on ? 'var(--k10-c-cobalt)' : 'var(--k10-c-slate)';
      });
      const clear = r.querySelector('.w10m-insights .w10m-link');
      if (clear) clear.hidden = dom === 'all';
    }
  }

  function activeDomain() {
    const r = root();
    const pill = r && r.querySelector('#memt-domain-pills [data-memt-domain].is-active');
    return pill ? pill.getAttribute('data-memt-domain') : 'all';
  }

  /* Reproduces renderMemtList's filter so card N maps to record N of the same filtered list. */
  function coreFiltered() {
    const r = root();
    const dom = activeDomain();
    const q = String(((r && r.querySelector('#memt-search')) || {}).value || '').trim().toLowerCase();
    return exps().filter((exp) => {
      if (dom !== 'all' && domainOf(exp) !== dom) return false;
      if (!q) return true;
      return [exp.domain, exp.condition, exp.recommendation, exp.verification, exp.title, exp.id].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }

  function cardText(card) {
    const cond = (card.querySelector('.memt-condition') || {}).textContent || '';
    const rec = (card.querySelector('.memt-recommendation') || {}).textContent || '';
    return cond + '\u0000' + rec;
  }
  function expText(e) {
    return strip(e.condition || e.title || e.trigger || 'Condition') + '\u0000' + strip(e.recommendation || e.action || e.text || '');
  }

  function decorateList() {
    const r = root();
    const list = r && r.querySelector('#memt-list');
    if (!list || !K() || !st.data) return;
    const filtered = coreFiltered();
    let byText = null;
    list.querySelectorAll(':scope > article.memt-card:not([data-w10])').forEach((card) => {
      const text = cardText(card);
      const idx = Number(card.getAttribute('data-memt-idx'));
      let exp = Number.isInteger(idx) && filtered[idx] && expText(filtered[idx]) === text ? filtered[idx] : null;
      if (!exp) {
        /* Fallback only when the text names exactly one record; ambiguous cards stay undecorated. */
        if (!byText) {
          byText = new Map();
          for (const e of exps()) { const t = expText(e); byText.set(t, byText.has(t) ? false : e); }
        }
        exp = byText.get(text) || null;
      }
      if (exp) decorateCard(card, exp);
    });
    applyListState();
  }

  /* ------------------------------------------------------------ events */
  function focusRecipe(id) {
    const r = root();
    if (!r || !id) return;
    const sel = '#memt-list article[data-w10-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
    let card = r.querySelector(sel);
    if (!card || card.hidden) {
      if (st.needProof || st.needCites) {
        st.needProof = false;
        st.needCites = false;
        persist();
        r.querySelectorAll('[data-w10m-toggle]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      }
      const search = r.querySelector('#memt-search');
      if (search && search.value) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
      if (activeDomain() !== 'all') { const all = r.querySelector('#memt-domain-pills [data-memt-domain="all"]'); if (all) all.click(); }
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      decorateList();
      card = r.querySelector(sel);
      if (!card) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      card.focus({ preventScroll: true });
      card.classList.remove('is-flash');
      void card.offsetWidth;
      card.classList.add('is-flash');
      setTimeout(() => card.classList.remove('is-flash'), 1800);
    }));
  }

  function onClick(e) {
    const r = root();
    if (!r || !r.contains(e.target)) return;
    const sortBtn = e.target.closest('[data-w10m-sort]');
    if (sortBtn) {
      st.sort = sortBtn.getAttribute('data-w10m-sort');
      persist();
      r.querySelectorAll('[data-w10m-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b === sortBtn)));
      applyListState();
      return;
    }
    const tog = e.target.closest('[data-w10m-toggle]');
    if (tog) {
      const which = tog.getAttribute('data-w10m-toggle');
      if (which === 'proof') st.needProof = !st.needProof;
      if (which === 'cites') st.needCites = !st.needCites;
      tog.setAttribute('aria-pressed', String(which === 'proof' ? st.needProof : st.needCites));
      persist();
      applyListState();
      return;
    }
    const more = e.target.closest('.w10m-more');
    if (more) {
      const rec = document.getElementById(more.getAttribute('aria-controls'));
      const key = more.dataset.w10mKey;
      const open = more.getAttribute('aria-expanded') !== 'true';
      if (open) st.expanded.add(key); else st.expanded.delete(key);
      if (rec) rec.classList.toggle('is-clamped', !open);
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    const act = e.target.closest('[data-k10-action]');
    if (!act) return;
    const a = act.getAttribute('data-k10-action');
    if (a === 'w10m-domain') {
      const id = act.getAttribute('data-k10-id') || 'all';
      const target = activeDomain() === id ? 'all' : id;
      const pill = r.querySelector('#memt-domain-pills [data-memt-domain="' + (window.CSS && CSS.escape ? CSS.escape(target) : target) + '"]');
      if (pill) pill.click();
    } else if (a === 'w10m-weakest') {
      focusRecipe(act.getAttribute('data-k10-id'));
    } else if (a === 'w10m-new') {
      const btn = document.getElementById('btn-toggle-recipe-form');
      if (btn) btn.click();
    } else if (a === 'w10m-retry') {
      const list = r.querySelector('#memt-list');
      if (!list || !list.querySelector(':scope > article.memt-card')) {
        /* The core list is empty too; only a fresh load of the view reloads it. */
        window.location.reload();
        return;
      }
      st.data = null;
      st.failed = false;
      renderHero();
      load();
    } else if (a === 'w10m-clear-evidence') {
      st.needProof = false;
      st.needCites = false;
      persist();
      r.querySelectorAll('[data-w10m-toggle]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      applyListState();
    }
  }

  let raf = 0;
  function onListMutation(records) {
    const list = root() && root().querySelector('#memt-list');
    /* The core shows a skeleton when loadMemt starts (first visit, or after a recipe is saved).
       Request now so the coalescer hands this view the same response the core receives. */
    if (list && records.some((m) => Array.from(m.addedNodes).some((n) => n.classList && n.classList.contains('skeleton-block')))) {
      st.data = null;
      renderHero();
      load();
      return;
    }
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; decorateList(); });
  }

  function decorateHeader() {
    const r = root();
    if (!r || r.dataset.w10Head) return;
    r.dataset.w10Head = '1';
    const title = r.querySelector('.view-title');
    if (title) title.textContent = 'MemT library';
    const search = r.querySelector('#memt-search');
    if (search) search.placeholder = 'Search recipes and proofs';
    const btn = r.querySelector('#btn-toggle-recipe-form');
    if (btn && K()) {
      btn.innerHTML = K().icon('plus', 13) + '<span>New recipe</span>';
      btn.classList.add('w10m-new-btn');
    }
  }

  function activate() {
    const r = root();
    if (!r || !K()) return;
    decorateHeader();
    renderHero();
    renderToolbar();
    if (!st.observer) {
      const list = r.querySelector('#memt-list');
      if (list) {
        st.observer = new MutationObserver(onListMutation);
        st.observer.observe(list, { childList: true });
      }
      r.addEventListener('click', onClick);
      const pills = r.querySelector('#memt-domain-pills');
      if (pills) pills.addEventListener('click', () => requestAnimationFrame(applyListState));
    }
    /* The core loads once per session and keeps its copy, so re-entry reuses ours too. */
    if (!st.data && !st.loading) load();
    else { decorateList(); }
  }

  function load() {
    fetchData()
      .then(() => {
        st.usesTracked = summarize(exps(), st.data.status).usesTracked;
        renderHero();
        decorateList();
      })
      .catch(() => { renderHero(); applyListState(); });
  }

  let wasActive = false;
  function check() {
    const r = root();
    const on = !!r && !r.hidden;
    if (on && !wasActive) activate();
    wasActive = on;
  }

  window.KizukiW10Memt = Object.freeze({ heroHtml, heroFailedHtml, toolbarHtml, countHtml, decorateCard, summarize, isVerified });

  function boot() {
    const r = root();
    if (!r || !document.getElementById('memt-list')) return;
    check();
    new MutationObserver(check).observe(r, { attributes: true, attributeFilter: ['hidden'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
