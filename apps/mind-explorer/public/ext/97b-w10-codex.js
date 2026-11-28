/* Kizuki Wave 10: Mind Codex depth layer.
   Enhances the DOM rendered by codex-view.js (scoped to #view-codex) with a
   section banner and an overview row built from real /api/codex and
   /api/actions data only. Idempotent; re-applied to the nodes each base render adds.
   Data loads on activation, on the Refresh button and shortly after a write. */
(function () {
  'use strict';

  const SEC_TONE = { philosophies: 'violet', interests: 'cobalt', hobbies: 'emerald', ideas: 'orange', actions: 'rose' };
  const SEC_ART = { philosophies: 'contour', interests: 'orbit', hobbies: 'grid', ideas: 'aurora', actions: 'grid' };
  const SEC_ICON = { philosophies: 'brain', interests: 'star', hobbies: 'layers', ideas: 'spark', actions: 'check' };
  const STAGES = [
    { id: 'spark', label: 'Spark' },
    { id: 'validating', label: 'Validating' },
    { id: 'building', label: 'Building' },
    { id: 'shipped', label: 'Shipped' },
    { id: 'parked', label: 'Parked' },
  ];
  const CONVICTIONS = [
    { id: 'core', label: 'Core', tone: 'violet' },
    { id: 'active', label: 'Active', tone: 'emerald' },
    { id: 'testing', label: 'Testing', tone: 'orange' },
  ];
  const CARD_SEL = '.codex-card, .codex-pipeline-card, .codex-decision-card';
  const WRITE_SEL = '[data-codex-pin], [data-codex-toggle-action], [data-codex-delete-action], [data-codex-advance-stage], [data-codex-promote]';

  // Local line icons for the pipeline buttons, which the base renders as text only.
  const SVG = (d) => `<svg class="cx10-ic" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
  const PIPE_ICONS = {
    'data-codex-promote': SVG('<path d="M9 1.8 3.6 9h4l-.8 5.2L12.4 7h-4z"/>'),
    'data-codex-send-board': SVG('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11M10 2.5v6"/>'),
    'data-codex-synth': SVG('<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.6 1.6M10.4 10.4 12 12M12 4l-1.6 1.6M5.6 10.4 4 12"/>'),
    'data-codex-open-doc': SVG('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8.5h4.5M6 11h4.5"/>'),
    'data-codex-edit': SVG('<path d="M10.8 2.6 13.4 5.2 6 12.6l-3.2.6.6-3.2z"/>'),
  };

  let codex = null;
  let ownerActions = null;
  let inflight = null;
  let observer = null;
  let scheduled = false;
  let bound = false;
  let fullScan = true;
  let writeTimer = 0;
  const pending = new Set();

  function K() {
    return window.KizukiKit || null;
  }

  function rootEl() {
    return document.getElementById('view-codex');
  }

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = Promise.all([getJson('/api/codex?section=all'), getJson('/api/actions')])
      .then(([c, a]) => {
        if (c && Array.isArray(c.items)) codex = c;
        ownerActions = a && Array.isArray(a.actions) ? a.actions : null;
        return true;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /* ---------------------------------------------------------------- helpers */
  function activeSection(root) {
    const btn = root.querySelector('.codex-section-btn.is-active[data-codex-section]');
    return btn ? btn.getAttribute('data-codex-section') : 'philosophies';
  }

  function live(i) {
    return i && i.status !== 'archived';
  }

  function sectionItems(sec) {
    if (!codex || !Array.isArray(codex.items)) return [];
    return codex.items.filter((i) => live(i) && i.section === sec);
  }

  function itemById(id) {
    if (!codex || !Array.isArray(codex.items)) return null;
    for (let i = 0; i < codex.items.length; i += 1) {
      if (codex.items[i] && codex.items[i].id === id) return codex.items[i];
    }
    if (Array.isArray(codex.open_decisions)) {
      for (let i = 0; i < codex.open_decisions.length; i += 1) {
        if (codex.open_decisions[i] && codex.open_decisions[i].id === id) return codex.open_decisions[i];
      }
    }
    return null;
  }

  function countBy(list, fn) {
    const out = Object.create(null);
    list.forEach((x) => {
      const k = fn(x);
      if (k == null || k === '') return;
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  function ranked(map) {
    return Object.keys(map)
      .sort((a, b) => map[b] - map[a] || a.localeCompare(b))
      .map((k) => ({ key: k, count: map[k] }));
  }

  function peopleCounts(list) {
    const out = Object.create(null);
    list.forEach((i) => {
      (Array.isArray(i.linked_people) ? i.linked_people : []).forEach((p) => {
        const name = String(p || '').trim();
        if (name) out[name] = (out[name] || 0) + 1;
      });
    });
    return out;
  }

  function conflictLinks(item) {
    return (Array.isArray(item.links) ? item.links : []).filter((l) => l && l.kind === 'conflicts');
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function sentence(text) {
    const s = String(text || '').trim();
    if (!s || s !== s.toUpperCase() || !/[A-Z]{3}/.test(s)) return null;
    return s
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/\b(ai|x|os|gtm)\b/g, (w) => w.toUpperCase());
  }

  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  function rewriteOwnText(el) {
    if (!el || el.children.length) return;
    const next = el.textContent.trim() === 'PIN' ? 'Pinned' : sentence(el.textContent);
    if (next) setText(el, next);
  }

  // Elements matching sel inside node, including node itself.
  function within(node, sel) {
    const out = node.matches && node.matches(sel) ? [node] : [];
    return node.querySelectorAll ? out.concat(Array.from(node.querySelectorAll(sel))) : out;
  }

  /* ---------------------------------------------------------------- banner */
  // Banner figures are ones no overview card repeats.
  function heroStats(sec, list) {
    const pinned = list.filter((i) => i.pinned).length;
    const noMove = list.filter((i) => !String(i.next_move || '').trim()).length;
    if (sec === 'actions') return actionStats(list);
    const base = [
      { label: 'Entries', value: list.length },
      { label: 'Pinned', value: pinned },
      { label: 'No next move', value: noMove },
    ];
    if (sec === 'interests') {
      const bm = codex && codex.stats ? codex.stats.bookmarks : null;
      base.push({ label: 'X bookmarks', value: typeof bm === 'number' ? bm : null });
    } else if (sec === 'ideas') {
      const st = countBy(list, (i) => i.stage);
      base.push({ label: 'In flight', value: (st.spark || 0) + (st.validating || 0) + (st.building || 0) });
    } else {
      base.push({ label: 'With anti-pattern', value: list.filter((i) => String(i.anti_pattern || '').trim()).length });
    }
    return base;
  }

  // Same split the base Action Plane uses: decisions, venture moves, commitments.
  function actionBuckets(list) {
    const open = list.filter((i) => i.status === 'open');
    const decisions = codex && Array.isArray(codex.open_decisions) ? codex.open_decisions.filter(live) : [];
    const decIds = Object.create(null);
    decisions.forEach((d) => {
      decIds[d.id] = true;
    });
    const isCommit = (i) => String(i.id).indexOf('action_commit_') === 0 || (Array.isArray(i.tags) && i.tags.indexOf('commitment') !== -1);
    const commitments = open.filter(isCommit);
    const ventures = open.filter((i) => !decIds[i.id] && !isCommit(i) && String(i.id).indexOf('action_owner_') !== 0);
    return { open, decisions, commitments, ventures };
  }

  function actionStats(list) {
    const b = actionBuckets(list);
    return [
      { label: 'Open in Action Plane', value: b.open.length },
      { label: 'Decisions', value: codex && Array.isArray(codex.open_decisions) ? b.decisions.length : null },
      { label: 'Venture moves', value: b.ventures.length },
      { label: 'Commitments', value: b.commitments.length },
    ];
  }

  function sectionMeta(sec) {
    const list = codex && Array.isArray(codex.sections) ? codex.sections : [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === sec) return list[i];
    }
    return { id: sec, label: sec, description: '' };
  }

  /* -------------------------------------------------------------- overview */
  function domainCard(kit, list, tone) {
    const map = countBy(list, (i) => i.domain || 'General');
    const all = ranked(map);
    const top = all.slice(0, 5);
    const body = top.length
      ? kit.bars(top.map((d) => ({ label: d.key, value: d.count, tone, action: `cx-domain:${d.key}` })))
      : kit.emptyState({ title: 'No domains yet', body: 'Entries in this section have no domain set.', icon: 'tag' });
    return kit.card({
      title: 'Where it lives',
      sub: all.length > 5 ? `Top 5 of ${all.length} domains, tap to filter` : all.length ? `${plural(all.length, 'domain', 'domains')}, tap to filter` : 'Domains',
      body,
    });
  }

  function convictionCard(kit, sec, list) {
    const n = list.length;
    const conv = countBy(list, (i) => i.conviction);
    const clickable = sec === 'philosophies';
    const cells = CONVICTIONS.map((c) => {
      const count = conv[c.id] || 0;
      const pct = n ? (count / n) * 100 : null;
      const inner =
        kit.ring(pct, c.tone, { size: 52, label: String(count), aria: `${c.label}: ${count} of ${n}` }) +
        `<span class="cx10-conv-label">${kit.esc(c.label)}</span>` +
        `<span class="cx10-conv-sub">${pct == null ? '--' : `${Math.round(pct)}%`}</span>`;
      return clickable
        ? `<button type="button" class="cx10-conv" data-k10-action="cx-conv:${c.id}">${inner}</button>`
        : `<div class="cx10-conv">${inner}</div>`;
    }).join('');
    return kit.card({
      title: 'Conviction',
      sub: n ? `${plural(n, 'entry', 'entries')}${clickable ? ', tap to filter' : ''}` : 'No entries',
      body: n ? `<div class="cx10-conv-row">${cells}</div>` : kit.emptyState({ title: 'No entries', body: 'Nothing captured in this section yet.', icon: 'layers' }),
    });
  }

  function pipelineCard(kit, list) {
    const st = countBy(list, (i) => i.stage);
    const items = STAGES.map((s) => ({ label: s.label, value: st[s.id] || 0, tone: 'orange', action: `cx-stage:${s.id}` }));
    return kit.card({
      title: 'Pipeline',
      sub: list.length ? 'Ideas per stage, tap to filter' : 'No ideas yet',
      body: `<div class="cx10-stage-bars">${kit.bars(items)}</div>`,
    });
  }

  function peopleCard(kit, list, opts) {
    const o = opts || {};
    const all = ranked(peopleCounts(list));
    const top = all.slice(0, 4);
    const rest = all.slice(4);
    const body = top.length
      ? `<div class="cx10-people">${top
        .map((p) => kit.personRow({ name: p.key }, {
          size: 26,
          sub: p.count === 1 ? `Linked to 1 ${o.noun || 'entry'}` : `Linked to ${p.count} ${o.nouns || 'entries'}`,
          action: `cx-person:${p.key}`,
        }))
        .join('')}</div>`
      : kit.emptyState({ title: 'No people linked', body: 'Nobody is linked to entries in this section yet.', icon: 'people' });
    return kit.card({
      title: o.title || 'People in orbit',
      sub: all.length ? `${plural(all.length, 'person', 'people')} linked` : 'People',
      right: rest.length ? kit.avatarStack(rest.map((p) => ({ name: p.key })), { max: 3, size: 22, mode: 'initials' }) : '',
      body,
    });
  }

  // Entries whose auto-matched taste links include a conflict. These are similarity
  // suggestions from the matcher, not links the owner made, and the card says so.
  function tensionCard(kit, list, tone) {
    const flagged = list
      .map((i) => ({ item: i, n: conflictLinks(i).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || String(a.item.title).localeCompare(String(b.item.title)));
    if (!flagged.length) return null;
    return kit.card({
      title: 'Possible taste conflicts',
      sub: `${plural(flagged.length, 'entry', 'entries')} flagged by the matcher, unconfirmed`,
      body: kit.bars(flagged.slice(0, 5).map((x) => ({
        label: x.item.title,
        value: x.n,
        tone,
        action: `cx-item:${x.item.id}`,
      }))),
    });
  }

  function overviewRow(kit, sec, list, tone, isPipeline) {
    const second = sec === 'ideas' && !isPipeline ? pipelineCard(kit, list) : convictionCard(kit, sec, list);
    const peopleN = Object.keys(peopleCounts(list)).length;
    const third = (peopleN < 3 && tensionCard(kit, list, tone)) || peopleCard(kit, list);
    return `<div class="cx10-overview" role="group" aria-label="Section overview">${domainCard(kit, list, tone)}${second}${third}</div>`;
  }

  function actionsOverview(kit, list) {
    const total = ownerActions ? ownerActions.length : null;
    const done = ownerActions ? ownerActions.filter((a) => a.done).length : null;
    const open = total == null ? null : total - done;
    const pct = total ? (done / total) * 100 : null;
    const tags = ranked(ownerActions ? countBy(ownerActions.filter((a) => !a.done), (a) => a.tag || 'Work') : {}).slice(0, 4);
    let note = '';
    if (total === 0) note = 'The Today list is empty.';
    else if (total != null && open === 0) note = 'Everything on the Today list is done. Open Action Plane items sit below.';
    const taskBody =
      `<div class="cx10-task-ring">` +
      kit.ring(pct, 'emerald', { size: 56, label: '', aria: pct == null ? 'Today list unavailable' : `${done} of ${total} Today list items done` }) +
      `<div class="cx10-task-copy">` +
      (total == null
        ? `<span class="cx10-task-big is-empty">Unavailable</span>`
        : `<span class="cx10-task-big">${kit.esc(kit.fmt(done))}<span> of ${kit.esc(kit.fmt(total))} done</span></span>`) +
      `<span class="cx10-task-sub">${total == null ? 'The Today list did not load' : `${plural(open, 'item', 'items')} still open`}</span>` +
      `</div>` +
      `</div>` +
      (tags.length
        ? kit.bars(tags.map((t) => ({ label: t.key, value: t.count, tone: 'emerald' })))
        : note ? `<p class="cx10-note">${kit.esc(note)}</p>` : '');

    const decisions = codex && Array.isArray(codex.open_decisions) ? codex.open_decisions.filter(live) : [];
    const decBody = decisions.length
      ? kit.bars(
        decisions
          .slice()
          .sort((a, b) => (Number(b.leverage_score) || -1) - (Number(a.leverage_score) || -1))
          .slice(0, 5)
          .map((d) => ({
            label: d.title,
            value: typeof d.leverage_score === 'number' && Number.isFinite(d.leverage_score) ? d.leverage_score : null,
            action: `cx-item:${d.id}`,
          })),
        { max: 100 },
      )
      : kit.emptyState({ title: 'No open decisions', body: 'Nothing is waiting on a call.', icon: 'check' });

    // Decisions are also Action Plane items; count each id once.
    const seen = Object.create(null);
    const decisionPeople = actionBuckets(list).open.concat(decisions).filter((i) => {
      if (!i || seen[i.id]) return false;
      seen[i.id] = true;
      return true;
    });
    return (
      `<div class="cx10-overview" role="group" aria-label="Action Plane overview">` +
      kit.card({ title: 'Today list', sub: 'Owner actions from the Today page', body: taskBody }) +
      kit.card({ title: 'Decisions by leverage', sub: decisions.length ? `Leverage out of 100, tap to jump` : 'Open decisions', body: `<div class="cx10-dec">${decBody}</div>` }) +
      peopleCard(kit, decisionPeople, { title: 'People involved', noun: 'open item', nouns: 'open items' }) +
      `</div>`
    );
  }

  function heroHtml(kit, sec, isPipeline) {
    const list = sectionItems(sec);
    const tone = SEC_TONE[sec] || 'slate';
    const meta = sectionMeta(sec);
    const banner = kit.banner({
      title: meta.label,
      subtitle: meta.description,
      eyebrow: 'Mind Codex',
      eyebrowIcon: SEC_ICON[sec] || 'layers',
      seed: `codex-${sec}`,
      tone,
      art: SEC_ART[sec],
      stats: heroStats(sec, list),
      compact: true,
    });
    const overview = sec === 'actions' ? actionsOverview(kit, list) : overviewRow(kit, sec, list, tone, isPipeline);
    return banner + overview;
  }

  function dataSig() {
    if (!codex) return 'none';
    const items = codex.items.map((i) => `${i.id}:${i.pinned ? 1 : 0}:${i.stage || ''}:${i.status || ''}:${i.conviction || ''}:${i.domain || ''}`).join(',');
    const acts = ownerActions ? ownerActions.map((a) => `${a.id}:${a.done ? 1 : 0}`).join(',') : 'x';
    return `${codex.updated_at}|${(window.KizukiKit && KizukiKit.hash(items + acts)) || items.length}`;
  }

  function heroSignature(root, sec, isPipeline) {
    return [sec, isPipeline ? 'p' : 'g', dataSig()].join('|');
  }

  function markActiveFilters(root, hero) {
    const filters = root.querySelector('[data-codex-filters]');
    if (!filters) return;
    hero.querySelectorAll('[data-k10-action]').forEach((el) => {
      const act = el.getAttribute('data-k10-action') || '';
      const chip = filterChipFor(filters, act);
      if (!chip) return;
      const on = chip.classList.contains('is-active');
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function filterChipFor(scope, act) {
    if (act.indexOf('cx-domain:') === 0) return findByAttr(scope, 'data-codex-domain-filter', act.slice(10));
    if (act.indexOf('cx-stage:') === 0) return findByAttr(scope, 'data-codex-stage-filter', act.slice(9));
    if (act.indexOf('cx-conv:') === 0) return findByAttr(scope, 'data-codex-conviction-filter', act.slice(8));
    return null;
  }

  function ensureHero(root, content, sec, kit) {
    let hero = content.querySelector(':scope > .cx10-hero');
    if (!codex) {
      if (hero) hero.remove();
      return;
    }
    const isPipeline = Boolean(content.querySelector('.codex-pipeline'));
    const sig = heroSignature(root, sec, isPipeline);
    if (!hero) {
      hero = document.createElement('div');
      hero.className = 'cx10-hero';
      content.insertBefore(hero, content.firstChild);
    } else if (content.firstChild !== hero) {
      content.insertBefore(hero, content.firstChild);
    }
    if (hero.getAttribute('data-sig') !== sig) {
      hero.setAttribute('data-sig', sig);
      hero.setAttribute('data-sec', sec);
      hero.innerHTML = heroHtml(kit, sec, isPipeline);
      hero.querySelectorAll('.k10-bar-label .k10-truncate, .k10-prow-name').forEach((el) => el.setAttribute('title', el.textContent));
    }
    markActiveFilters(root, hero);
  }

  /* ----------------------------------------------------------------- cards */
  const ICON_ONLY = ['data-codex-send-board', 'data-codex-open-doc', 'data-codex-edit', 'data-codex-pin', 'data-codex-open-replay'];
  const PIPE_ICON_ONLY = ['data-codex-promote', 'data-codex-send-board', 'data-codex-synth', 'data-codex-open-doc', 'data-codex-edit'];
  let clampSeq = 0;

  function labelFor(btn) {
    const t = btn.getAttribute('title');
    const text = btn.textContent.replace(/\s+/g, ' ').trim();
    const raw = btn.hasAttribute('data-codex-synth') && t ? t : t && t.length > text.length ? t : text || t || '';
    return titleToSentence(raw);
  }

  function enhanceCard(card, kit) {
    const id = card.getAttribute('data-codex-item-id');
    const item = id ? itemById(id) : null;
    const isPipe = card.classList.contains('codex-pipeline-card');
    const stamp = item ? `${item.id}|${item.domain || ''}|${item.pinned ? 1 : 0}|${item.leverage_score}` : 'none';
    if (card.getAttribute('data-cx10') === stamp) return;
    card.setAttribute('data-cx10', stamp);

    // Pinned marker in the meta row (grid cards); the pin button carries the action.
    const meta = card.querySelector(':scope .codex-card-meta');
    if (meta && card.classList.contains('codex-card')) {
      const old = meta.querySelector('.cx10-pinned');
      if (old) old.remove();
      if (item && item.pinned) {
        const mark = document.createElement('span');
        mark.className = 'cx10-pinned';
        mark.innerHTML = `${kit.icon('star', 11)}Pinned`;
        meta.insertBefore(mark, meta.firstChild);
      }
    }

    // Leverage: the base renders a fallback when the score is missing; only show real scores.
    const lev = card.querySelector('.codex-leverage');
    const levLabel = card.querySelector('.codex-leverage-label');
    const hasScore = item && typeof item.leverage_score === 'number' && Number.isFinite(item.leverage_score);
    if (lev) lev.hidden = !hasScore;
    if (levLabel) {
      if (!hasScore) {
        levLabel.hidden = true;
      } else {
        levLabel.hidden = false;
        const score = Math.round(item.leverage_score);
        setText(levLabel, isPipe ? String(score) : `Leverage ${score}`);
        levLabel.setAttribute('title', `Leverage score ${score} of 100`);
        if (isPipe) levLabel.setAttribute('aria-label', `Leverage ${score} of 100`);
      }
    }

    const actions = card.querySelector('.codex-card-actions');
    if (actions && !actions.querySelector(':scope > .cx10-icon-group')) {
      const group = document.createElement('span');
      group.className = 'cx10-icon-group';
      actions.querySelectorAll(':scope > .codex-action-btn').forEach((btn) => {
        if (!ICON_ONLY.some((a) => btn.hasAttribute(a))) return;
        const label = labelFor(btn);
        if (label) {
          btn.setAttribute('aria-label', label);
          btn.setAttribute('title', label);
        }
        btn.classList.add('cx10-icon-btn');
        group.appendChild(btn);
      });
      if (group.children.length) actions.appendChild(group);
    }

    const pills = isPipe ? card.querySelector('.codex-pipeline-card-pills') : null;
    if (pills && !pills.hasAttribute('data-cx10')) {
      pills.setAttribute('data-cx10', '1');
      pills.querySelectorAll('.codex-action-btn').forEach((btn) => {
        const attr = PIPE_ICON_ONLY.find((a) => btn.hasAttribute(a));
        if (!attr) return;
        const label = labelFor(btn);
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.classList.add('cx10-icon-btn');
        btn.innerHTML = PIPE_ICONS[attr];
      });
    }

    // Long summaries clamp to four lines with a separate Show more button.
    card.querySelectorAll(':scope > p.codex-card-subtitle').forEach((p) => {
      if (p.hasAttribute('data-cx10-clamp')) return;
      p.setAttribute('data-cx10-clamp', '');
      if (String(p.textContent || '').length < 260) return;
      clampSeq += 1;
      if (!p.id) p.id = `cx10-clamp-${clampSeq}`;
      p.classList.add('cx10-clamp');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cx10-more';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', p.id);
      btn.textContent = 'Show more';
      p.insertAdjacentElement('afterend', btn);
    });
  }

  function enhancePeople(scope, kit) {
    within(scope, '.codex-person-pill:not([data-cx10])').forEach((pill) => {
      const name = pill.getAttribute('data-codex-open-person') || pill.textContent.trim();
      if (!name) return;
      pill.setAttribute('data-cx10', '1');
      pill.innerHTML = `${kit.avatar({ name }, { size: 20, mode: 'initials' })}<span class="k10-truncate">${kit.esc(name)}</span>`;
    });
  }

  function enhanceBookmarks(scope, kit) {
    within(scope, '.codex-bookmark-row:not([data-cx10])').forEach((row) => {
      const author = row.querySelector('.codex-bookmark-author');
      if (!author) return;
      row.setAttribute('data-cx10', '1');
      const name = (author.firstChild && author.firstChild.nodeType === 3 ? author.firstChild.textContent : author.textContent).trim();
      const span = document.createElement('span');
      span.className = 'cx10-bm-av';
      span.innerHTML = kit.avatar({ name: name.replace(/^@/, '') }, { size: 22, mode: 'initials' });
      author.insertBefore(span, author.firstChild);
    });
  }

  function titleToSentence(text) {
    let first = true;
    return String(text).replace(/[A-Za-z][A-Za-z']*/g, (w) => {
      if (first) {
        first = false;
        return w;
      }
      return /^[A-Z][a-z']+$/.test(w) ? w.toLowerCase() : w;
    });
  }

  function rewriteLabels(scope) {
    within(scope, '.codex-conviction, .codex-thesis-label, .codex-filter-chip, .codex-stage, .codex-pipeline-title').forEach(rewriteOwnText);
    within(
      scope,
      '.codex-rail-stat-label, .codex-next-move-label, .codex-action-panel-title, .codex-bookmarks-header > span:first-child, .codex-dist-head > span:first-child, .codex-parked-title',
    ).forEach((el) => {
      if (el.children.length && !el.classList.contains('codex-parked-title')) return;
      el.childNodes.forEach((n) => {
        if (n.nodeType !== 3) return;
        const raw = n.textContent;
        let next = sentence(raw) || titleToSentence(raw);
        // The base labels the all-sections pinned count "Pinned Core"; it counts every pinned entry.
        if (el.classList.contains('codex-rail-stat-label') && /^\s*pinned core\s*$/i.test(raw)) {
          next = 'Pinned';
          el.setAttribute('title', 'Pinned entries across all sections');
        }
        if (next !== raw) n.textContent = next;
      });
    });
  }

  /* ---------------------------------------------------------------- engine */
  function enhance() {
    scheduled = false;
    const root = rootEl();
    const kit = K();
    if (!root || !kit || root.hidden) return;
    const shell = root.querySelector('.codex-shell');
    const content = root.querySelector('[data-codex-content]');
    if (!shell || !content) return;

    const scopes = fullScan ? [root] : Array.from(pending).filter((n) => n.isConnected && root.contains(n));
    fullScan = false;
    pending.clear();

    if (observer) observer.disconnect();
    try {
      const sec = activeSection(root);
      const isMap = content.classList.contains('is-constellation-mode');
      root.classList.add('cx10-on');
      root.classList.toggle('cx10-map', isMap);
      root.setAttribute('data-cx10-sec', sec);
      const loading = Boolean(content.querySelector(':scope > .codex-empty')) && !content.querySelector('.codex-card, .codex-action-grid, .codex-pipeline');

      if (!isMap && !loading) {
        ensureHero(root, content, sec, kit);
      } else {
        const hero = content.querySelector(':scope > .cx10-hero');
        if (hero) hero.remove();
      }
      root.classList.toggle('cx10-has-hero', Boolean(content.querySelector(':scope > .cx10-hero')));

      scopes.forEach((scope) => {
        if (scope.closest && scope.closest('.cx10-hero')) return;
        within(scope, CARD_SEL).forEach((c) => enhanceCard(c, kit));
        enhancePeople(scope, kit);
        enhanceBookmarks(scope, kit);
        rewriteLabels(scope);
      });
    } finally {
      if (observer) observer.observe(root, { childList: true, subtree: true });
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(enhance);
  }

  function reload() {
    refresh().then(() => {
      fullScan = true;
      schedule();
    }).catch(schedule);
  }

  function findByAttr(scope, attr, value) {
    const list = scope.querySelectorAll(`[${attr}]`);
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].getAttribute(attr) === value) return list[i];
    }
    return null;
  }

  function onClick(e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const root = rootEl();
    if (!root) return;

    const more = t.closest('.cx10-more');
    if (more) {
      const p = document.getElementById(more.getAttribute('aria-controls') || '');
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
      more.textContent = open ? 'Show less' : 'Show more';
      if (p) p.classList.toggle('is-open', open);
      return;
    }

    if (t.closest('[data-codex-refresh]')) {
      reload();
      return;
    }
    if (t.closest(WRITE_SEL)) {
      // Writes change counts the banner shows; reload once the base has saved.
      clearTimeout(writeTimer);
      writeTimer = setTimeout(reload, 1200);
    }

    const el = t.closest('[data-k10-action]');
    if (!el || !root.contains(el)) return;
    const act = el.getAttribute('data-k10-action') || '';
    const content = root.querySelector('[data-codex-content]') || root;
    if (act.indexOf('cx-item:') === 0) {
      const card = findByAttr(content, 'data-codex-item-id', act.slice(8));
      if (card) {
        e.preventDefault();
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        card.classList.remove('cx10-flash');
        void card.offsetWidth;
        card.classList.add('cx10-flash');
        if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
        card.focus({ preventScroll: true });
      }
      return;
    }
    let target = null;
    if (act.indexOf('cx-person:') === 0) target = findByAttr(content, 'data-codex-open-person', act.slice(10));
    else {
      const filters = root.querySelector('[data-codex-filters]') || root;
      target = filterChipFor(filters, act) || (act.indexOf('cx-domain:') === 0 ? findByAttr(root, 'data-codex-domain-filter', act.slice(10)) : null);
    }
    if (target) {
      // The base toggles each filter dimension: clicking an active chip clears only that one.
      e.preventDefault();
      target.click();
    }
  }

  function onSubmit(e) {
    const root = rootEl();
    if (root && e.target && root.contains(e.target)) {
      clearTimeout(writeTimer);
      writeTimer = setTimeout(reload, 1200);
    }
  }

  function start() {
    const root = rootEl();
    // The storyboard has a stand-in #view-codex; it renders through KizukiCodexW10 instead.
    if (!root || root.closest('#sb-codex') || document.querySelector('.sb-shell, [data-storyboard]')) return;
    if (!bound) {
      bound = true;
      root.addEventListener('click', onClick);
      document.addEventListener('submit', onSubmit, true);
      observer = new MutationObserver((records) => {
        let hit = false;
        for (let i = 0; i < records.length; i += 1) {
          const r = records[i];
          if (r.target.closest && r.target.closest('.cx10-hero')) continue;
          r.addedNodes.forEach((n) => {
            const el = n.nodeType === 1 ? n : n.parentElement;
            if (el && !(el.closest && el.closest('.cx10-hero'))) pending.add(el);
          });
          hit = true;
        }
        if (hit) schedule();
      });
      observer.observe(root, { childList: true, subtree: true });
      // Load on activation (the section toggles its hidden attribute).
      new MutationObserver(() => {
        if (!root.hidden) reload();
      }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
    }
    if (!root.hidden) reload();
    else schedule();
  }

  // Storyboard hooks: render the same components from supplied data without touching live state.
  function withData(c, a, fn) {
    const prev = [codex, ownerActions];
    codex = c || null;
    ownerActions = Array.isArray(a) ? a : null;
    try {
      return fn();
    } finally {
      codex = prev[0];
      ownerActions = prev[1];
    }
  }

  window.KizukiCodexW10 = Object.freeze({
    heroHtml(c, a, sec, opts) {
      const kit = K();
      if (!kit) return '';
      return withData(c, a, () => heroHtml(kit, sec || 'philosophies', Boolean(opts && opts.pipeline)));
    },
    enhanceScope(scope, c, a) {
      const kit = K();
      if (!kit || !scope) return;
      withData(c, a, () => {
        within(scope, CARD_SEL).forEach((el) => enhanceCard(el, kit));
        enhancePeople(scope, kit);
        enhanceBookmarks(scope, kit);
        rewriteLabels(scope);
      });
    },
    toggleMore(btn) {
      if (!btn) return;
      onClick({ target: btn, preventDefault() {} });
    },
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
