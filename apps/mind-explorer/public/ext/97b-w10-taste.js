/* Kizuki Wave 10: Taste Studio depth layer.
   Enhances #view-taste after each render of public/taste-view.js:
   - a slim calibration strip under the tabs (ring, honest summary line, one next action)
   - rail domain rows get a progress ring that follows the data
   - the deck tab gains a "Gaps to close" strip, recent verdicts and the gardener roster
   - gardeners are shown as their domain icon with a live status dot, not as people
   - the Rules tab radar legend and labels read in sentence case
   All numbers come from /api/taste?domain=all and /api/taste/gardeners. Missing data renders as '--'. */
(function initTasteW10(root) {
  'use strict';
  if (!root || !root.document || root.__w10Taste) return;
  root.__w10Taste = true;

  const doc = root.document;
  const VIEW_ID = 'view-taste';
  const STALE_MS = 5 * 60 * 1000;
  const BACKOFF_BASE_MS = 30 * 1000;
  const BACKOFF_MAX_MS = 5 * 60 * 1000;
  const DOMAIN_ICON = {
    ui_product: 'layers',
    typography_copy: 'doc',
    visual_brand: 'image',
    motion_feel: 'pulse',
    video_anime: 'eye',
    merch_objects: 'tag',
    spaces_life: 'map',
    agent_ops: 'brain',
  };
  // Literal upper-case SVG legend labels drawn by taste-deck-fx.js, mapped to sentence case.
  const LEGEND_TEXT = {
    GAP: 'Gap',
    '7D PRIOR': '7-day prior',
    'GARDENER L1-L5': 'Gardener level 1 to 5',
  };

  // One cache entry per endpoint, refetched only when its own key changes. Requests go through the
  // app's fetch coalescer (ext/00-net-coalesce.js), which merges them with the view's identical GETs
  // and revalidates with ETags, so a refetch right after the view's own load costs no extra request.
  function entry() {
    return { data: null, key: '', at: 0, inflight: false, failed: false, failCount: 0, failedAt: 0 };
  }
  const cache = { taste: entry(), gardeners: entry() };
  let scheduled = false;

  function kit() {
    return root.KizukiKit || null;
  }

  function isActive() {
    const host = doc.getElementById(VIEW_ID);
    return Boolean(host && !host.hidden);
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function humanTrait(t) {
    const s = String(t || '').replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function relTime(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    const d = Math.round(h / 24);
    if (d < 60) return d + 'd ago';
    return Math.round(d / 30) + 'mo ago';
  }

  function viewState() {
    const api = root.KizukiTasteView;
    if (!api || typeof api.getState !== 'function') return null;
    try {
      return api.getState();
    } catch {
      return null;
    }
  }

  function tasteKey(st) {
    const s = st && st.stats;
    if (!s) return '';
    return [s.answered_count, s.remaining_count, s.skipped_count, s.custom_rules_count, s.total_questions, s.vault_docs_count].join('|');
  }

  function gardenerKey(st) {
    if (!st) return '';
    const g = st.gardenersStats;
    return [g ? g.runs_total : '', g ? g.gardeners_running : '', st.gardenersRunning ? 1 : 0].join('|');
  }

  /* ------------------------------------------------------------------ data */
  function refresh(name, url, key) {
    const c = cache[name];
    if (c.inflight || !key) return;
    const now = Date.now();
    if (c.failed) {
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, c.failCount - 1)));
      if (now - c.failedAt < wait) return;
    } else if (c.data && c.key === key && now - c.at < STALE_MS) {
      return;
    }
    c.inflight = true;
    const before = { data: c.data, failed: c.failed };
    root.fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((json) => {
        c.data = json && typeof json === 'object' ? json : null;
        c.failed = !c.data;
        c.failCount = c.failed ? c.failCount + 1 : 0;
        c.failedAt = c.failed ? Date.now() : 0;
      })
      .catch(() => {
        c.failed = true;
        c.failCount += 1;
        c.failedAt = Date.now();
      })
      .then(() => {
        c.key = key;
        c.at = Date.now();
        c.inflight = false;
        // Only re-render when the outcome changed; a repeated failure stays quiet.
        if (c.data !== before.data || c.failed !== before.failed) schedule();
      });
  }

  function ensureData(st) {
    // Wait for the view's own first load so the two never race on a cold server.
    if (!st || !st.stats) return;
    refresh('taste', '/api/taste?domain=all', tasteKey(st));
    refresh('gardeners', '/api/taste/gardeners', gardenerKey(st) || 'none');
  }

  function derive(t) {
    if (!t || typeof t !== 'object') return null;
    const stats = t.stats || {};
    const domains = arr(t.domains);
    const queue = arr(t.queue);
    const history = arr(t.answered_history)
      .slice()
      .sort((a, b) => (Date.parse(b.answered_at) || 0) - (Date.parse(a.answered_at) || 0));
    const queued = {};
    queue.forEach((q) => {
      if (q && q.domain) queued[q.domain] = (queued[q.domain] || 0) + 1;
    });
    const rules = t.rules || {};
    const prefer = arr(rules.prefer);
    const avoid = arr(rules.avoid);
    const rulesByDomain = {};
    prefer.concat(avoid).forEach((r) => {
      if (r && r.domain) rulesByDomain[r.domain] = (rulesByDomain[r.domain] || 0) + 1;
    });
    const lastByDomain = {};
    history.forEach((h) => {
      if (h && h.domain && !lastByDomain[h.domain]) lastByDomain[h.domain] = h;
    });
    const now = Date.now();
    const weekAgo = now - 7 * 864e5;
    const weekCount = history.filter((h) => (Date.parse(h.answered_at) || 0) >= weekAgo).length;
    const gaps = domains
      .filter((d) => (queued[d.id] || 0) > 0 && num(d.pct) != null && d.pct < 100)
      .sort((a, b) => a.pct - b.pct || (queued[b.id] || 0) - (queued[a.id] || 0));
    return {
      stats,
      domains,
      queue,
      queued,
      history,
      prefer,
      avoid,
      rulesByDomain,
      lastByDomain,
      rulesTotal: prefer.length + avoid.length,
      weekCount,
      gaps,
      weakest: gaps[0] || null,
      lastAt: history[0] ? history[0].answered_at : null,
      now,
    };
  }

  /* ------------------------------------------------------------ fragments */
  function summaryLine(d, opts) {
    const s = d.stats;
    const parts = [];
    if (d.lastAt) parts.push('Last verdict ' + relTime(d.lastAt, d.now));
    parts.push(d.weekCount + ' this week');
    const streak = num(s.streak_count);
    if (streak != null && streak > 1) parts.push(streak + '-answer streak with no gap over 36h');
    let line = parts.join(' · ') + '.';
    if (opts && opts.stale) line += ' Data may be stale.';
    return line;
  }

  function heroHtml(d, st, opts) {
    const o = opts || {};
    const failed = Boolean(o.failed);
    const K = kit();
    const s = d ? d.stats : {};
    const pct = d ? num(s.calibration_pct) : null;
    const answered = d ? num(s.answered_count) : null;
    const total = d ? num(s.total_questions) : null;

    let title = failed ? 'Calibration unavailable' : 'Loading calibration';
    let subtitle = failed ? 'The taste API did not answer. Numbers will appear when it does.' : 'Reading /api/taste.';
    if (d) {
      title = answered != null && total != null ? answered + ' of ' + total + ' decisions locked' : 'Decisions unavailable';
      subtitle = summaryLine(d, { stale: failed });
    }

    const ring = K.ring(pct, pct != null && pct >= 100 ? 'emerald' : 'cobalt', {
      size: 52,
      stroke: 5,
      label: pct == null ? '--' : pct + '%',
      aria: pct == null ? 'Calibration unavailable' : pct + ' percent calibrated',
    });

    return '<div class="w10t-hero" data-w10t>' +
      '<section class="w10t-strip k10-tone-cobalt" aria-label="Taste calibration">' +
        K.coverArt('taste-studio-calibration', 'cobalt', { art: 'contour', height: 120 }) +
        '<div class="w10t-strip-body">' +
          ring +
          '<div class="w10t-strip-text">' +
            '<h3 class="w10t-strip-title">' + K.esc(title) + '</h3>' +
            '<p class="w10t-strip-sub">' + K.esc(subtitle) + '</p>' +
          '</div>' +
          nextActionHtml(d, st, failed) +
        '</div>' +
      '</section>' +
    '</div>';
  }

  function nextActionHtml(d, st, failed) {
    const K = kit();
    if (!d) {
      return '<div class="w10t-next"><span class="w10t-next-sub">' + K.esc(failed ? 'Next action unavailable' : 'Loading') + '</span></div>';
    }
    const active = st ? st.activeDomain : 'all';
    const tab = st ? st.activeTab : 'deck';
    const w = d.weakest;
    if (!w) {
      return '<div class="w10t-next">' +
        '<span class="w10t-next-sub">No queued cards in an open domain</span>' +
        '<button type="button" class="w10t-btn is-primary" data-taste-generate>' + K.icon('spark', 13) + 'Generate 5 questions</button>' +
        '</div>';
    }
    const q = d.queued[w.id] || 0;
    const onIt = tab === 'deck' && active === w.id;
    const btn = onIt
      ? '<button type="button" class="w10t-btn is-primary" data-w10t-focus-deck>' + K.icon('arrow', 13) + 'Answer the next card</button>'
      : '<button type="button" class="w10t-btn is-primary" data-taste-next-domain="' + K.esc(w.id) + '">' + K.icon('arrow', 13) + 'Calibrate ' + K.esc(shortLabel(w.label)) + '</button>';
    return '<div class="w10t-next">' +
      '<span class="w10t-next-sub">Weakest: <strong>' + K.esc(shortLabel(w.label)) + '</strong> at ' + K.esc(w.pct) + '%, ' + plural(q, 'card') + ' queued</span>' +
      btn +
      '</div>';
  }

  function shortLabel(label) {
    return String(label || '').split(/\s*[,&]\s*/)[0];
  }

  // The rail already lists every domain with its ring. This strip shows only the domains that still
  // have queued cards, with what the rail cannot: rules count, the latest verdict in full, one button.
  function gapsHtml(d) {
    const K = kit();
    const gaps = Array.isArray(d.gaps) ? d.gaps.slice(0, 3) : [];
    if (!gaps.length) {
      return K.emptyState({ title: 'No gaps with queued cards', body: 'Every domain with cards left is calibrated, or the deck is empty.', icon: 'check', compact: true });
    }
    return '<div class="w10t-gaps">' + gaps.map((dm) => {
      const pct = num(dm.pct);
      const q = d.queued[dm.id] || 0;
      const rules = d.rulesByDomain[dm.id] || 0;
      const last = d.lastByDomain[dm.id];
      const lastPick = last ? (last.chosen_label || last.chosen_key || 'Choice') : '';
      const lastQ = last && last.question_title ? last.question_title : '';
      return '<article class="w10t-gap">' +
        '<div class="w10t-gap-top">' +
          K.ring(pct, 'cobalt', { size: 40, stroke: 4, label: pct == null ? '--' : String(pct), aria: pct == null ? 'Unavailable' : pct + ' percent calibrated' }) +
          '<div class="w10t-gap-titles">' +
            '<h4 class="w10t-gap-name">' + K.esc(dm.label) + '</h4>' +
            '<p class="w10t-gap-meta">' + K.esc(K.fmt(num(dm.answered))) + ' of ' + K.esc(K.fmt(num(dm.total))) + ' decided · ' + plural(rules, 'rule') + '</p>' +
          '</div>' +
        '</div>' +
        (last
          ? '<div class="w10t-gap-last">' +
              '<span class="w10t-gap-last-lbl">Last pick' + (last.answered_at ? ', ' + K.esc(relTime(last.answered_at, d.now)) : '') + '</span>' +
              '<p class="w10t-gap-pick"><strong>' + K.esc(lastPick) + '</strong>' + (lastQ ? ' ' + K.esc(lastQ) : '') + '</p>' +
            '</div>'
          : '<div class="w10t-gap-last"><p class="w10t-gap-pick">No verdicts yet in this domain.</p></div>') +
        '<div class="w10t-gap-foot">' +
          '<span class="w10t-gap-q">' + plural(q, 'card') + ' queued</span>' +
          '<button type="button" class="w10t-btn" data-taste-next-domain="' + K.esc(dm.id) + '">Calibrate' + K.icon('arrow', 12) + '</button>' +
        '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  // Kept for the storyboard: the old name now renders the gaps strip.
  function domainTilesHtml(d) {
    return gapsHtml(d);
  }

  function verdictsHtml(d) {
    const K = kit();
    const rows = Array.isArray(d.history) ? d.history.slice(0, 6) : [];
    if (!rows.length) return K.emptyState({ title: 'No verdicts yet', body: 'Answer a card in the deck to record your first one.', icon: 'check', compact: true });
    const labels = {};
    d.domains.forEach((dm) => { labels[dm.id] = dm.label; });
    return '<ul class="w10t-feed">' + rows.map((h) => {
      return '<li class="w10t-feed-row">' +
        '<span class="w10t-feed-ic" aria-hidden="true">' + K.icon(DOMAIN_ICON[h.domain] || 'check', 14) + '</span>' +
        '<span class="w10t-feed-body">' +
          '<span class="w10t-feed-title k10-truncate"><strong>' + K.esc(h.chosen_label || h.chosen_key || 'Choice') + '</strong> ' + K.esc(h.question_title || '') + '</span>' +
          '<span class="w10t-feed-sub k10-truncate">' + K.esc([relTime(h.answered_at, d.now), shortLabel(labels[h.domain] || h.domain), h.axis].filter(Boolean).join(' · ')) + '</span>' +
        '</span>' +
        (h.trait_tag ? K.chip(humanTrait(h.trait_tag)) : '') +
      '</li>';
    }).join('') + '</ul>';
  }

  // Gardeners are agents, not people: show the icon of their first domain on a plain tile,
  // with an emerald dot only while one is running.
  function gardenerMark(ga, size) {
    const K = kit();
    const first = arr(ga && ga.domains)[0];
    const running = ga && ga.status === 'running';
    return '<span class="w10t-gmark' + (running ? ' is-running' : '') + '" style="--w10t-gmark:' + (size || 32) + 'px" aria-hidden="true">' +
      K.icon(DOMAIN_ICON[first] || 'spark', Math.round((size || 32) * 0.45)) +
      (running ? '<i class="w10t-gmark-dot"></i>' : '') +
    '</span>';
  }

  function rosterHtml(g) {
    const K = kit();
    const list = g ? arr(g.gardeners) : [];
    if (!list.length) return K.emptyState({ title: 'Gardeners unavailable', body: 'The gardener roster did not load.', icon: 'people', compact: true });
    const now = Date.now();
    return '<ul class="w10t-roster">' + list.map((ga) => {
      const runs = num(ga.runs_count);
      const when = ga.status === 'running' ? 'Running now' : (relTime(ga.last_run_at, now) || 'Not run yet');
      return '<li class="w10t-grow">' +
        gardenerMark(ga, 32) +
        '<span class="w10t-grow-body">' +
          '<span class="w10t-grow-name k10-truncate">' + K.esc(ga.name || ga.id || 'Gardener') + '</span>' +
          '<span class="w10t-grow-sub k10-truncate">' + K.esc(ga.codex_scope || '') + '</span>' +
        '</span>' +
        '<span class="w10t-grow-right">' +
          '<span class="w10t-grow-num">' + (runs != null ? K.esc(K.fmt(runs)) + ' runs' : '--') + '</span>' +
          '<span class="w10t-grow-when' + (ga.status === 'running' ? ' is-running' : '') + '">' + K.esc(when) + '</span>' +
        '</span>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function belowDeckHtml(d, st, g) {
    const K = kit();
    const gStats = (g && g.stats) || (st && st.gardenersStats) || null;
    const gapCount = d.gaps.length;
    return '<div class="w10t-below" data-w10t>' +
      '<section class="w10t-sec" aria-label="Gaps to close">' +
        K.sectionHead('Gaps to close', '<button type="button" class="w10t-link" data-taste-tab="rules">Genome' + K.icon('arrow', 12) + '</button>', {
          sub: gapCount ? 'Weakest domains that still have queued cards' + (gapCount > 3 ? ', 3 of ' + gapCount + ' shown' : '') : 'Nothing queued in an open domain',
        }) +
        gapsHtml(d) +
      '</section>' +
      '<div class="w10t-split">' +
        '<section class="w10t-panel" aria-label="Recent verdicts">' +
          K.sectionHead('Recent verdicts', '<button type="button" class="w10t-link" data-taste-tab="rules">All verdicts' + K.icon('arrow', 12) + '</button>', { level: 3, sub: plural(d.history.length, 'verdict') + ' recorded' }) +
          verdictsHtml(d) +
        '</section>' +
        '<section class="w10t-panel" aria-label="Taste gardeners">' +
          K.sectionHead('Gardeners', '<button type="button" class="w10t-link" data-taste-tab="gardeners">Open' + K.icon('arrow', 12) + '</button>', {
            level: 3,
            sub: gStats && num(gStats.runs_total) != null
              ? K.fmt(gStats.runs_total) + ' runs' + (num(gStats.gardeners_running) ? ', ' + gStats.gardeners_running + ' running' : '')
              : 'Run count unavailable',
          }) +
          rosterHtml(g) +
        '</section>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------- enhance */
  function enhanceRail(d) {
    const K = kit();
    const btns = doc.querySelectorAll('#view-taste .taste-rail .taste-domain-btn[data-taste-domain]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const id = b.getAttribute('data-taste-domain');
      let pct = null;
      if (id === 'all') pct = d ? num(d.stats.calibration_pct) : null;
      else if (d) {
        const dm = d.domains.find((x) => x.id === id);
        pct = dm ? num(dm.pct) : null;
      }
      let span = b.querySelector(':scope > .w10t-rail-ring');
      if (pct == null) {
        if (span) span.remove();
        b.classList.remove('w10t-has-ring');
        continue;
      }
      if (span && span.getAttribute('data-pct') === String(pct)) continue;
      if (!span) {
        span = doc.createElement('span');
        span.className = 'w10t-rail-ring';
        span.setAttribute('aria-hidden', 'true');
        b.insertBefore(span, b.firstChild);
      }
      span.setAttribute('data-pct', String(pct));
      span.innerHTML = K.ring(pct, pct >= 100 ? 'emerald' : 'cobalt', { size: 28, stroke: 3, label: '' });
      b.classList.add('w10t-has-ring');
    }
  }

  function enhanceGardeners() {
    const g = cache.gardeners.data;
    const byName = {};
    arr(g && g.gardeners).forEach((x) => { if (x && x.name) byName[x.name] = x; });
    const cards = doc.querySelectorAll('#view-taste .gardener-agent-card');
    for (let i = 0; i < cards.length; i++) {
      const id = cards[i].querySelector('.gardener-agent-identity');
      if (!id) continue;
      const nameEl = id.querySelector('.gardener-agent-name');
      const name = nameEl ? nameEl.textContent.trim() : '';
      const ga = byName[name] || null;
      const html = gardenerMark(ga || { domains: [] }, 40);
      let wrap = id.querySelector(':scope > .w10t-gav');
      if (wrap && wrap.__w10html === html) continue;
      if (!wrap) {
        wrap = doc.createElement('span');
        wrap.className = 'w10t-gav';
        id.insertBefore(wrap, id.firstChild);
      }
      wrap.innerHTML = html;
      wrap.__w10html = html;
      id.classList.add('w10t-has-gav');
    }
    const strip = doc.querySelector('#view-taste .taste-gardener-strip-title-wrap');
    if (!strip || !g) return;
    const list = arr(g.gardeners);
    const html = list.map((x) => {
      const running = x.status === 'running';
      const label = (x.name || x.id || 'Gardener') + ': ' + (running ? 'running' : 'idle');
      return '<i class="w10t-sdot' + (running ? ' is-running' : '') + '" title="' + kit().esc(label) + '"></i>';
    }).join('');
    let dots = strip.parentElement.querySelector(':scope > .w10t-strip-dots');
    if (!list.length) {
      if (dots) dots.remove();
      return;
    }
    if (!dots) {
      dots = doc.createElement('span');
      dots.className = 'w10t-strip-dots';
      strip.insertAdjacentElement('afterend', dots);
    }
    const running = list.filter((x) => x.status === 'running').length;
    const aria = list.length + ' gardeners, ' + running + ' running';
    if (dots.__w10html !== html) {
      dots.innerHTML = html;
      dots.__w10html = html;
      dots.setAttribute('role', 'img');
      dots.setAttribute('aria-label', aria);
    }
  }

  function enhanceHeader() {
    const btn = doc.querySelector('#view-taste .taste-generate-btn');
    if (!btn) return;
    const compact = btn.querySelector('.taste-generate-label-compact');
    if (compact && /^\+5\b/.test(compact.textContent.trim())) compact.textContent = 'Generate 5';
    if (!btn.hasAttribute('title')) btn.setAttribute('title', 'Generate 5 fresh questions with Inkling G4');
  }

  function sentenceCase(t) {
    if (!t || t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
    const s = t.toLowerCase().replace(/\bui\b/g, 'UI');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function enhanceRadar() {
    const names = doc.querySelectorAll('#view-taste .tfx-radar-axis-name');
    for (let i = 0; i < names.length; i++) {
      const t = names[i].textContent;
      const n = sentenceCase(t);
      if (n !== t) names[i].textContent = n;
    }
    const texts = doc.querySelectorAll('#view-taste .tfx-radar-legend text');
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i].textContent.trim();
      if (LEGEND_TEXT[t]) texts[i].textContent = LEGEND_TEXT[t];
    }
    const tags = doc.querySelectorAll('#view-taste .taste-crosslink-tag');
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i].textContent;
      if (t === 'CODEX') tags[i].textContent = 'Codex';
      else if (t === 'CONFLICT') tags[i].textContent = 'Conflicts with';
    }
    const sel = doc.querySelector('#view-taste select[data-taste-rule-polarity]');
    if (sel) {
      for (let i = 0; i < sel.options.length; i++) {
        const o = sel.options[i];
        if (o.value === 'prefer' && o.textContent !== 'Prefer') o.textContent = 'Prefer';
        if (o.value === 'avoid' && o.textContent !== 'Avoid') o.textContent = 'Avoid';
      }
    }
  }

  function upsert(parent, selector, html, where, anchor) {
    const old = parent.querySelector(':scope > ' + selector);
    if (old) {
      if (old.__w10html !== html) {
        old.outerHTML = html;
        const n = parent.querySelector(':scope > ' + selector);
        if (n) n.__w10html = html;
      }
      return;
    }
    if (anchor) anchor.insertAdjacentHTML(where, html);
    else parent.insertAdjacentHTML(where, html);
    const n = parent.querySelector(':scope > ' + selector);
    if (n) n.__w10html = html;
  }

  function enhance() {
    const host = doc.getElementById(VIEW_ID);
    const K = kit();
    if (!host || !K || !isActive()) return;
    const shell = host.querySelector('.taste-shell');
    if (!shell) return;
    const st = viewState();
    ensureData(st);
    const d = derive(cache.taste.data);
    shell.classList.add('w10t');

    const main = shell.querySelector('.taste-main');
    const header = main ? main.querySelector(':scope > .taste-header') : null;
    if (main) {
      // Under the tabs, so the deck card stays close to the top and the header stays the one title.
      // The view's own load failed (no stats and not loading): say unavailable rather than loading forever.
      const viewFailed = Boolean(st && !st.stats && !st.loading);
      const html = heroHtml(d, st, { failed: cache.taste.failed || viewFailed });
      if (header) upsert(main, '.w10t-hero', html, 'afterend', header);
      else upsert(main, '.w10t-hero', html, 'afterbegin');
    }

    const body = shell.querySelector('.taste-body');
    const oldBelow = body ? body.querySelector(':scope > .w10t-below') : null;
    if (body && d && st && st.activeTab === 'deck' && body.querySelector('.taste-deck-stage')) {
      upsert(body, '.w10t-below', belowDeckHtml(d, st, cache.gardeners.data), 'beforeend');
    } else if (oldBelow) {
      oldBelow.remove();
    }

    enhanceRail(d);
    enhanceGardeners();
    enhanceHeader();
    enhanceRadar();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      try {
        enhance();
      } catch (err) {
        if (root.console && root.console.warn) root.console.warn('[w10 taste] enhance skipped', err);
      }
    };
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(run);
    else root.setTimeout(run, 16);
  }

  function onClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-w10t-focus-deck]') : null;
    if (!t) return;
    const card = doc.querySelector('#view-taste .taste-question-card');
    if (!card) return;
    const reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    const first = card.querySelector('.taste-option-card:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  function boot() {
    const host = doc.getElementById(VIEW_ID);
    if (!host) return;
    const obs = new root.MutationObserver(schedule);
    obs.observe(host, { childList: true });
    // Every tab or domain change goes through the view's full innerHTML render, so childList covers it.
    // Showing the panel again (hidden attribute flips) also needs a pass.
    const panelObs = new root.MutationObserver(() => { if (isActive()) schedule(); });
    panelObs.observe(host, { attributes: true, attributeFilter: ['hidden'] });
    // The radar SVG is hydrated after the main render; relabel its legend when it lands.
    const radarObs = new root.MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const n = records[i].target;
        if (n && n.closest && n.closest('.taste-fp-svg-wrap')) { enhanceRadar(); return; }
      }
    });
    radarObs.observe(host, { childList: true, subtree: true });
    host.addEventListener('click', onClick);
    schedule();
  }

  // Pure builders, shared with public/storyboard/taste.html.
  root.KizukiTasteW10 = Object.freeze({ derive, heroHtml, gapsHtml, domainTilesHtml, verdictsHtml, rosterHtml, belowDeckHtml, gardenerMark });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
