/* ==========================================================================
   KIZUKI PEOPLE RADAR, 52-WEEK RIBBON & LOCAL PREP PACK (AREA 5 EXTENSION)
   Mounts into KizukiSlots ('people-radar', 'person-prep') with automatic
   fallback inside #view-people and #people-detail-body. Strictly local-only.
   ========================================================================== */
(function initKizukiPeopleRadar() {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;

  // The radar's stylesheet travels with the code that renders it, so deep links that inline this chunk still get styled.
  (function attachStyles() {
    if (typeof document === 'undefined' || document.querySelector('link[data-kizuki-people-css]')) return;
    const m = window.__KIZUKI_CHUNKS__ && window.__KIZUKI_CHUNKS__.lazyExt && window.__KIZUKI_CHUNKS__.lazyExt.people;
    if (!m || !m.css) return;
    const ln = document.createElement('link');
    ln.rel = 'stylesheet';
    ln.href = m.css;
    ln.setAttribute('data-kizuki-people-css', '1');
    (document.head || document.documentElement).appendChild(ln);
  })();
  const state = {
    radar: null,
    radarLoadedAt: 0,
    radarLoading: false,
    radarCollapsed: false,
    radarShowAll: false,
    introsOpen: false,
    needsYouActive: false,
    radarRoot: null,
    slotOpenPerson: null,
    prepCache: new Map(),
    prepDrawerOpenFor: null,
    activePersonKey: null,
    lastMountedDossierKey: null,
  };

  function deriveInitials(name) {
    const clean = String(name || '').replace(EM_DASH_RE, ' ').trim();
    if (!clean) return '?';
    const parts = clean.split(/[\s._\-/]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(EM_DASH_RE, ' - ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatHours(h) {
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) return 'now';
    if (n < 1) return Math.max(1, Math.round(n * 60)) + 'm';
    if (n < 48) return Math.round(n) + 'h';
    return Math.round(n / 24) + 'd';
  }

  function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 10);
    return d.toISOString().slice(0, 10);
  }

  async function fetchRadar(force) {
    const now = Date.now();
    if (!force && state.radar && now - state.radarLoadedAt < 25_000) {
      return state.radar;
    }
    if (state.radarLoading && !force) return state.radar;
    state.radarLoading = true;
    try {
      const url = force ? '/api/people/radar?refresh=1' : '/api/people/radar';
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.radar = data;
      state.radarLoadedAt = Date.now();
      return data;
    } catch (err) {
      console.warn('[people-radar] failed to fetch radar:', err);
      return state.radar;
    } finally {
      state.radarLoading = false;
    }
  }

  async function fetchPrepPack(key) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return null;
    const cached = state.prepCache.get(cleanKey);
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.pack;
    }
    try {
      const res = await fetch('/api/people/prep?key=' + encodeURIComponent(cleanKey), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const pack = await res.json();
      state.prepCache.set(cleanKey, { pack: pack, at: Date.now() });
      return pack;
    } catch (err) {
      console.warn('[people-radar] failed to fetch prep pack:', err);
      return null;
    }
  }

  function openPersonByKey(key) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return;
    if (typeof state.slotOpenPerson === 'function') {
      try {
        state.slotOpenPerson(cleanKey);
        return;
      } catch (_) {}
    }
    // Try clicking an existing directory row first so app.js handles full state cleanly
    const existingRow = document.querySelector(
      '#people-list [data-person-key="' + CSS.escape(cleanKey) + '"], #people-list [data-open-person="' + CSS.escape(cleanKey) + '"]'
    );
    if (existingRow && typeof existingRow.click === 'function') {
      existingRow.click();
      return;
    }
    // Fallback: update URL and trigger popstate / direct open
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'people');
      url.searchParams.set('person', cleanKey);
      window.history.pushState({}, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (_) {
      window.location.search = '?view=people&person=' + encodeURIComponent(cleanKey);
    }
  }

  function buildRadarPriorityMap(radar) {
    const map = new Map();
    if (!radar) return map;
    const add = (list, kind, labelFn) => {
      for (let i = 0; i < (list || []).length; i += 1) {
        const entry = list[i];
        if (!entry || !entry.key) continue;
        const prev = map.get(entry.key);
        const rank = (kind === 'owed' ? 3000 : kind === 'upcoming' ? 2000 : 1000) + Number(entry.score || 0);
        if (!prev || rank > prev.rank) {
          map.set(entry.key, {
            key: entry.key,
            name: entry.name,
            tier: entry.tier,
            kind: kind,
            badge: labelFn(entry),
            reason: entry.reason || '',
            rank: rank,
          });
        }
      }
    };
    add(radar.owed_replies, 'owed', (e) => 'Owed ' + formatHours(e.ageHours));
    add(radar.upcoming_touch, 'up', (e) => 'Mtg ' + formatHours(e.ageHours));
    add(radar.drifting, 'drift', (e) => 'Drift z' + (Number(e.drift_z || 0).toFixed(1)));
    return map;
  }

  function renderLaneItems(items, kind) {
    if (!Array.isArray(items) || items.length === 0) {
      const emptyMsg =
        kind === 'owed'
          ? 'All 1:1 threads answered.'
          : kind === 'drifting'
            ? 'Core and Family cadences on track.'
            : 'No meetings within 48 hours.';
      return '<div class="pr-lane-empty">' + esc(emptyMsg) + '</div>';
    }
    const maxItems = state.radarShowAll ? 4 : 2;
    return items
      .slice(0, maxItems)
      .map(function (item) {
        const metaText =
          kind === 'owed'
            ? formatHours(item.ageHours)
            : kind === 'drifting'
              ? 'z' + Number(item.drift_z || 0).toFixed(1)
              : formatHours(item.ageHours);
        const metaCls = kind === 'owed' ? 'is-alert' : kind === 'drifting' ? 'is-drift' : 'is-up';
        const ev = Array.isArray(item.evidence) && item.evidence[0] ? item.evidence[0] : item.reason;
        const initials = deriveInitials(item.name);
        return (
          '<button type="button" class="pr-lane-item" data-pr-open-person="' + esc(item.key) + '" title="' + esc(item.name + ' - ' + (ev || '')) + '">' +
            '<span class="pr-lane-monogram is-' + esc(kind) + '" aria-hidden="true">' + esc(initials) + '</span>' +
            '<div class="pr-lane-item-body">' +
              '<div class="pr-lane-item-top">' +
                '<span class="pr-lane-name">' + esc(item.name) + '</span>' +
                '<span class="pr-lane-meta ' + metaCls + '">' + esc(metaText) + '</span>' +
              '</div>' +
              '<div class="pr-lane-evidence">' + esc(ev || '') + '</div>' +
            '</div>' +
          '</button>'
        );
      })
      .join('');
  }

  function renderWarmIntrosDrawer(intros) {
    if (!state.introsOpen) return '';
    if (!Array.isArray(intros) || intros.length === 0) {
      return (
        '<div class="pr-intros-drawer">' +
          '<div class="pr-lane-empty">No unlinked warm intro opportunities detected yet.</div>' +
        '</div>'
      );
    }
    const cards = intros
      .slice(0, 6)
      .map(function (intro) {
        const ev = Array.isArray(intro.evidence) ? intro.evidence.join(' | ') : '';
        return (
          '<div class="pr-intro-card">' +
            '<div class="pr-intro-pair">' +
              '<button type="button" class="pr-intro-person-btn" data-pr-open-person="' + esc(intro.personA && intro.personA.key) + '">' +
                esc(intro.personA && intro.personA.name) +
              '</button>' +
              '<span aria-hidden="true">&harr;</span>' +
              '<button type="button" class="pr-intro-person-btn" data-pr-open-person="' + esc(intro.personB && intro.personB.key) + '">' +
                esc(intro.personB && intro.personB.name) +
              '</button>' +
            '</div>' +
            '<div class="pr-intro-signal">' + esc(intro.sharedSignal || '') + '</div>' +
            '<div class="pr-intro-ev">' + esc(ev) + '</div>' +
          '</div>'
        );
      })
      .join('');
    return '<div class="pr-intros-drawer"><div class="pr-intros-grid">' + cards + '</div></div>';
  }

  function renderRadarStrip(root) {
    if (!root) return;
    state.radarRoot = root;
    const radar = state.radar;
    if (!radar) {
      root.innerHTML =
        '<section class="pr-radar-shell is-loading" aria-label="People Needs You Radar">' +
          '<div class="pr-radar-topbar">' +
            '<div class="pr-radar-title-group"><span class="pr-radar-beacon" aria-hidden="true"></span><span class="pr-radar-kicker">Needs You Radar</span><span class="pr-radar-stat-chip">Scanning...</span></div>' +
          '</div>' +
        '</section>';
      return;
    }

    const owed = Array.isArray(radar.owed_replies) ? radar.owed_replies : [];
    const drifting = Array.isArray(radar.drifting) ? radar.drifting : [];
    const upcoming = Array.isArray(radar.upcoming_touch) ? radar.upcoming_touch : [];
    const intros = Array.isArray(radar.warm_intros) ? radar.warm_intros : [];
    const needsTotal = buildRadarPriorityMap(radar).size;
    const hasOverflowItems = owed.length > 2 || drifting.length > 2 || upcoming.length > 2;

    const lanesHtml = state.radarCollapsed
      ? ''
      : '<div class="pr-radar-lanes">' +
          '<div class="pr-radar-lane is-owed" data-pr-lane="owed">' +
            '<div class="pr-lane-head"><span class="pr-lane-label"><span class="pr-lane-dot is-owed"></span>Owed Replies</span><span class="pr-lane-count">' + owed.length + '</span></div>' +
            '<div class="pr-lane-list">' + renderLaneItems(owed, 'owed') + '</div>' +
          '</div>' +
          '<div class="pr-radar-lane is-drifting" data-pr-lane="drifting">' +
            '<div class="pr-lane-head"><span class="pr-lane-label"><span class="pr-lane-dot is-drifting"></span>Drifting</span><span class="pr-lane-count">' + drifting.length + '</span></div>' +
            '<div class="pr-lane-list">' + renderLaneItems(drifting, 'drifting') + '</div>' +
          '</div>' +
          '<div class="pr-radar-lane is-upcoming" data-pr-lane="upcoming">' +
            '<div class="pr-lane-head"><span class="pr-lane-label"><span class="pr-lane-dot is-upcoming"></span>Up Next</span><span class="pr-lane-count">' + upcoming.length + '</span></div>' +
            '<div class="pr-lane-list">' + renderLaneItems(upcoming, 'upcoming') + '</div>' +
          '</div>' +
        '</div>' +
        renderWarmIntrosDrawer(intros);

    const summaryChips =
      '<span class="pr-radar-summary-pills" aria-hidden="true">' +
        '<span class="pr-summary-pill is-owed"><span class="pr-lane-dot is-owed"></span>' + owed.length + ' owed</span>' +
        '<span class="pr-summary-pill is-drifting"><span class="pr-lane-dot is-drifting"></span>' + drifting.length + ' drifting</span>' +
        '<span class="pr-summary-pill is-upcoming"><span class="pr-lane-dot is-upcoming"></span>' + upcoming.length + ' up next</span>' +
      '</span>';

    root.innerHTML =
      '<section class="pr-radar-shell' + (state.radarCollapsed ? ' is-collapsed' : '') + '" aria-label="People Needs You Radar">' +
        '<div class="pr-radar-topbar">' +
          '<div class="pr-radar-title-group">' +
            '<span class="pr-radar-beacon" aria-hidden="true"></span>' +
            '<span class="pr-radar-kicker">Needs You</span>' +
            '<span class="pr-radar-stat-chip">' + needsTotal + ' active</span>' +
            summaryChips +
          '</div>' +
          '<div class="pr-radar-actions">' +
            (hasOverflowItems && !state.radarCollapsed
              ? '<button type="button" class="pr-chip-btn' + (state.radarShowAll ? ' is-active' : '') + '" data-pr-toggle-more="true">' +
                  (state.radarShowAll ? 'Compact' : 'More') +
                '</button>'
              : '') +
            '<button type="button" class="pr-chip-btn' + (state.introsOpen ? ' is-active' : '') + '" data-pr-toggle-intros="true">' +
              'Intros (' + intros.length + ')' +
            '</button>' +
            '<button type="button" class="pr-chip-btn" data-pr-refresh="true">Refresh</button>' +
            '<button type="button" class="pr-chip-btn" data-pr-toggle-collapse="true" aria-expanded="' + (state.radarCollapsed ? 'false' : 'true') + '">' +
              (state.radarCollapsed ? 'Show Radar' : 'Hide') +
            '</button>' +
          '</div>' +
        '</div>' +
        lanesHtml +
      '</section>';

    bindRadarEvents(root);
    syncNeedsYouFilterButton();
    applyNeedsYouFilterToDirectory();
  }

  function bindRadarEvents(root) {
    root.querySelectorAll('[data-pr-open-person]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-pr-open-person');
        if (key) openPersonByKey(key);
      });
    });
    const moreBtn = root.querySelector('[data-pr-toggle-more]');
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        state.radarShowAll = !state.radarShowAll;
        renderRadarStrip(root);
      });
    }
    const introsBtn = root.querySelector('[data-pr-toggle-intros]');
    if (introsBtn) {
      introsBtn.addEventListener('click', function () {
        state.introsOpen = !state.introsOpen;
        if (state.introsOpen && state.radarCollapsed) state.radarCollapsed = false;
        renderRadarStrip(root);
      });
    }
    const collapseBtn = root.querySelector('[data-pr-toggle-collapse]');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () {
        state.radarCollapsed = !state.radarCollapsed;
        renderRadarStrip(root);
      });
    }
    const refreshBtn = root.querySelector('[data-pr-refresh]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async function () {
        await fetchRadar(true);
        renderRadarStrip(root);
      });
    }
  }

  function syncNeedsYouFilterButton() {
    const pills = document.getElementById('people-channel-pills');
    if (!pills) return;
    let btn = pills.querySelector('[data-pr-needs-you="true"]');
    const count = buildRadarPriorityMap(state.radar).size;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-pill is-needs-you';
      btn.setAttribute('data-pr-needs-you', 'true');
      btn.title = 'Sort and filter to people who need a reply, reconnect, or meeting prep';
      pills.insertBefore(btn, pills.firstChild ? pills.firstChild.nextSibling : null);

      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.needsYouActive = !state.needsYouActive;
        pills.querySelectorAll('.channel-pill').forEach(function (el) {
          if (el !== btn && state.needsYouActive) el.classList.remove('is-active');
        });
        btn.classList.toggle('is-active', state.needsYouActive);
        if (!state.needsYouActive) {
          const allBtn = pills.querySelector('[data-people-ch="all"]');
          if (allBtn) allBtn.classList.add('is-active');
        }
        applyNeedsYouFilterToDirectory();
      });

      pills.addEventListener('click', function (ev) {
        const target = ev.target && ev.target.closest ? ev.target.closest('.channel-pill') : null;
        if (target && target !== btn && state.needsYouActive) {
          state.needsYouActive = false;
          btn.classList.remove('is-active');
          applyNeedsYouFilterToDirectory();
        }
      });
    }
    btn.textContent = count > 0 ? 'Needs you (' + count + ')' : 'Needs you';
    btn.classList.toggle('is-active', state.needsYouActive);
  }

  function applyNeedsYouFilterToDirectory() {
    const listEl = document.getElementById('people-list');
    if (!listEl) return;
    const priorityMap = buildRadarPriorityMap(state.radar);
    const rows = Array.from(listEl.children).filter(function (el) {
      return el && el.nodeType === 1 && !el.hasAttribute('data-pr-synthetic-row');
    });

    // Clear old synthetic rows first
    listEl.querySelectorAll('[data-pr-synthetic-row]').forEach(function (el) {
      el.remove();
    });

    const matchedKeys = new Set();
    const matchedRows = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const key = row.getAttribute('data-person-key') || row.getAttribute('data-open-person') || '';
      const info = key ? priorityMap.get(key) : null;
      const oldBadge = row.querySelector('.pr-needs-badge');
      if (oldBadge) oldBadge.remove();

      if (info) {
        matchedKeys.add(key);
        const nameEl = row.querySelector('.person-row-name, .triage-row-title, strong, .dir-name') || row;
        const badge = document.createElement('span');
        badge.className = 'pr-needs-badge is-' + info.kind;
        badge.textContent = info.badge;
        if (nameEl) nameEl.appendChild(badge);
        matchedRows.push({ row: row, rank: info.rank });
      }

      if (state.needsYouActive) {
        row.hidden = !info;
      } else {
        row.hidden = false;
      }
    }

    if (state.needsYouActive) {
      matchedRows.sort(function (a, b) { return b.rank - a.rank; });
      for (let i = 0; i < matchedRows.length; i += 1) {
        listEl.appendChild(matchedRows[i].row);
      }
      // Append any radar people not present in current 80-row directory page
      const missing = Array.from(priorityMap.values())
        .filter(function (info) { return !matchedKeys.has(info.key); })
        .sort(function (a, b) { return b.rank - a.rank; });

      for (let i = 0; i < missing.length; i += 1) {
        const info = missing[i];
        const synth = document.createElement('button');
        synth.type = 'button';
        synth.className = 'pr-lane-item';
        synth.setAttribute('data-pr-synthetic-row', 'true');
        synth.setAttribute('data-pr-open-person', info.key);
        synth.innerHTML =
          '<div class="pr-lane-item-top">' +
            '<span class="pr-lane-name">' + esc(info.name) + '</span>' +
            '<span class="pr-needs-badge is-' + esc(info.kind) + '">' + esc(info.badge) + '</span>' +
          '</div>' +
          '<div class="pr-lane-evidence">' + esc(info.reason) + '</div>';
        synth.addEventListener('click', function () {
          openPersonByKey(info.key);
        });
        listEl.appendChild(synth);
      }
    }
  }

  function renderPrepPackDrawerHtml(pack) {
    if (!pack) {
      return '<div class="pr-prep-drawer"><div class="pr-lane-empty">Loading local prep pack...</div></div>';
    }

    const exchangesHtml = (pack.last_exchanges || []).length > 0
      ? pack.last_exchanges
          .map(function (ex) {
            return (
              '<li class="pr-prep-row">' +
                '<span class="pr-prep-meta">' + esc(ex.direction === 'out' ? 'YOU' : 'THEM') + ' ' + esc(ex.channel) + ' ' + esc(formatShortDate(ex.occurred_at)) + '</span>' +
                '<span>' + esc(ex.text) + '</span>' +
              '</li>'
            );
          })
          .join('')
      : '<li class="pr-prep-row">No recent direct exchanges recorded.</li>';

    const asks = (pack.open_loops && pack.open_loops.inbound_asks) || [];
    const promises = (pack.open_loops && pack.open_loops.owner_promises) || [];
    const cardLoops = (pack.open_loops && pack.open_loops.card_loops) || [];
    const loopItems = [];
    asks.forEach(function (a) {
      loopItems.push('<li class="pr-prep-row"><span class="pr-prep-meta">THEIR ASK (' + esc(formatHours(a.ageHours)) + ')</span>' + esc(a.excerpt) + '</li>');
    });
    promises.forEach(function (p) {
      loopItems.push('<li class="pr-prep-row"><span class="pr-prep-meta">YOUR PROMISE (' + esc(formatHours(p.ageHours)) + ')</span>' + esc(p.excerpt) + '</li>');
    });
    cardLoops.forEach(function (cl) {
      loopItems.push('<li class="pr-prep-row"><span class="pr-prep-meta">CARD LOOP</span>' + esc(cl.loop) + '</li>');
    });
    const loopsHtml = loopItems.length > 0 ? loopItems.join('') : '<li class="pr-prep-row">No unresolved open loops.</li>';

    const commitmentsHtml = (pack.commitments || []).length > 0
      ? pack.commitments.map(function (c) { return '<li class="pr-prep-row">' + esc(c) + '</li>'; }).join('')
      : '<li class="pr-prep-row">No active commitments tracked.</li>';

    const boardHtml = (pack.shared_board_threads || []).length > 0
      ? pack.shared_board_threads
          .map(function (t) {
            return (
              '<li class="pr-prep-row">' +
                '<span class="pr-prep-meta">#' + esc(t.channel) + '</span>' +
                '<strong>' + esc(t.title) + '</strong>' +
                (t.summary ? ' - ' + esc(t.summary) : '') +
              '</li>'
            );
          })
          .join('')
      : '<li class="pr-prep-row">No shared Agent Board threads linked.</li>';

    const claimsHtml = (pack.recent_claims || []).length > 0
      ? pack.recent_claims
          .map(function (c) {
            return '<li class="pr-prep-row"><span class="pr-prep-meta">' + esc(formatShortDate(c.created_at)) + '</span>' + esc(c.text) + '</li>';
          })
          .join('')
      : '<li class="pr-prep-row">No recent world claims since last meeting.</li>';

    const openersHtml = (pack.openers || [])
      .map(function (op, idx) {
        return (
          '<div class="pr-opener-row">' +
            '<span>' + esc(op) + '</span>' +
            '<button type="button" class="pr-chip-btn" data-pr-copy-opener="' + idx + '">Copy</button>' +
          '</div>'
        );
      })
      .join('');

    return (
      '<div class="pr-prep-drawer" data-local-only="true">' +
        '<div class="pr-prep-grid">' +
          '<div class="pr-prep-block"><h4 class="pr-prep-block-title">Last 3 Exchanges</h4><ul class="pr-prep-list">' + exchangesHtml + '</ul></div>' +
          '<div class="pr-prep-block"><h4 class="pr-prep-block-title">Open Loops (Both Ways)</h4><ul class="pr-prep-list">' + loopsHtml + '</ul></div>' +
          '<div class="pr-prep-block"><h4 class="pr-prep-block-title">Active Commitments</h4><ul class="pr-prep-list">' + commitmentsHtml + '</ul></div>' +
          '<div class="pr-prep-block"><h4 class="pr-prep-block-title">Shared Board Threads</h4><ul class="pr-prep-list">' + boardHtml + '</ul></div>' +
        '</div>' +
        '<div class="pr-prep-block"><h4 class="pr-prep-block-title">Recent Claims Since Last Meeting</h4><ul class="pr-prep-list">' + claimsHtml + '</ul></div>' +
        '<div class="pr-prep-block"><h4 class="pr-prep-block-title">3 Tailored Openers (Local Only)</h4>' + openersHtml + '</div>' +
      '</div>'
    );
  }

  async function mountPersonPrepSlot(root, ctx) {
    if (!root) return;
    const key = String((ctx && (ctx.personKey || ctx.key || (ctx.person && ctx.person.key))) || getSelectedPersonKeyFromUrl() || '').trim();
    if (!key) return;
    state.activePersonKey = key;

    const existingLedger = ctx && ctx.dossier && ctx.dossier.profile_visuals && ctx.dossier.profile_visuals.ledger;
    const isOpen = state.prepDrawerOpenFor === key;

    const renderSlot = function (pack, ledgerObj) {
      if (!root.isConnected) return;
      const viz = window.KizukiPersonVisuals || null;
      const hasExistingRibbon = Boolean(
        root.parentElement && root.parentElement.querySelector('.pv-ledger-ribbon') && !root.querySelector('.pv-ledger-ribbon')
      );
      let ribbonHtml = '';
      if (!hasExistingRibbon && viz && typeof viz.renderRelationshipLedgerRibbon === 'function' && ledgerObj && Array.isArray(ledgerObj.weeks) && ledgerObj.weeks.length === 52) {
        ribbonHtml = viz.renderRelationshipLedgerRibbon(ledgerObj);
      }

      const openNow = state.prepDrawerOpenFor === key;
      root.innerHTML =
        '<div class="pr-prep-slot" data-pr-prep-key="' + esc(key) + '">' +
          ribbonHtml +
          '<div class="pr-prep-bar">' +
            '<div class="pr-prep-bar-left">' +
              '<span class="pr-radar-kicker">Meeting &amp; Touch Prep</span>' +
              '<span class="pr-local-pill">Local Only</span>' +
            '</div>' +
            '<button type="button" class="pr-chip-btn' + (openNow ? ' is-active' : '') + '" data-pr-toggle-prep="true">' +
              (openNow ? 'Hide Prep Pack' : 'Prep Pack (Local)') +
            '</button>' +
          '</div>' +
          (openNow ? renderPrepPackDrawerHtml(pack) : '') +
        '</div>';

      const toggleBtn = root.querySelector('[data-pr-toggle-prep]');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', async function () {
          state.prepDrawerOpenFor = state.prepDrawerOpenFor === key ? null : key;
          const loadedPack = pack || (await fetchPrepPack(key));
          renderSlot(loadedPack, (loadedPack && loadedPack.ledger) || ledgerObj);
        });
      }
      root.querySelectorAll('[data-pr-copy-opener]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const idx = Number(btn.getAttribute('data-pr-copy-opener'));
          const text = pack && Array.isArray(pack.openers) ? pack.openers[idx] : '';
          if (text && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              btn.textContent = 'Copied';
              setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
            }).catch(function () {});
          }
        });
      });
    };

    const cachedEntry = state.prepCache.get(key);
    const initialPack = cachedEntry ? cachedEntry.pack : null;
    renderSlot(initialPack, existingLedger || (initialPack && initialPack.ledger) || null);

    if (!initialPack || !existingLedger || isOpen) {
      const pack = await fetchPrepPack(key);
      if (pack && state.activePersonKey === key) {
        renderSlot(pack, existingLedger || pack.ledger);
      }
    }
  }

  function getSelectedPersonKeyFromUrl() {
    try {
      const url = new URL(window.location.href);
      return (url.searchParams.get('person') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function ensureAutoMountRadar() {
    const viewPeople = document.getElementById('view-people');
    if (!viewPeople) return;
    let slot =
      viewPeople.querySelector('#people-radar-slot') ||
      viewPeople.querySelector('[data-slot="people-radar"]') ||
      viewPeople.querySelector('[data-kizuki-slot="people-radar"]') ||
      viewPeople.querySelector('#people-radar-auto-slot');
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'people-radar-slot';
      const shell = document.getElementById('people-master-detail');
      if (shell && shell.parentElement === viewPeople) {
        viewPeople.insertBefore(slot, shell);
      } else {
        viewPeople.prepend(slot);
      }
    }
    if (slot.id !== 'people-radar-slot') {
      slot.id = 'people-radar-slot';
    }
    slot.classList.add('people-radar-slot');
    slot.setAttribute('data-slot', 'people-radar');
    slot.setAttribute('data-kizuki-slot', 'people-radar');

    // Deduplicate if an auto-slot and canonical slot both exist
    viewPeople.querySelectorAll('[data-kizuki-slot="people-radar"], [data-slot="people-radar"], #people-radar-auto-slot').forEach(function (el) {
      if (el !== slot) el.remove();
    });

    if (!state.radarRoot || state.radarRoot !== slot || !state.radarRoot.isConnected || !slot.querySelector('.pr-radar-shell')) {
      renderRadarStrip(slot);
      fetchRadar(false).then(function () {
        renderRadarStrip(slot);
      });
    }
    syncNeedsYouFilterButton();
  }

  function ensureAutoMountPersonPrep() {
    const detailBody = document.getElementById('people-detail-body');
    if (!detailBody) return;
    const inner = detailBody.querySelector('.detail-inner');
    if (!inner) return;
    const key = getSelectedPersonKeyFromUrl();
    if (!key) return;

    let slot = inner.querySelector('[data-kizuki-slot="person-prep"], #person-prep-auto-slot');
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'person-prep-auto-slot';
      slot.setAttribute('data-kizuki-slot', 'person-prep');
      const signalSlot = inner.querySelector('#person-signal-visuals-slot');
      if (signalSlot && signalSlot.parentElement) {
        signalSlot.parentElement.insertBefore(slot, signalSlot);
      } else {
        const stats = inner.querySelector('.dossier-stats');
        if (stats && stats.parentElement) {
          stats.parentElement.insertBefore(slot, stats.nextSibling);
        } else {
          inner.prepend(slot);
        }
      }
      state.lastMountedDossierKey = null;
    }

    if (state.lastMountedDossierKey !== key || !slot.querySelector('.pr-prep-slot')) {
      state.lastMountedDossierKey = key;
      mountPersonPrepSlot(slot, { personKey: key });
    }
  }

  function registerSlots() {
    if (window.KizukiSlots && typeof window.KizukiSlots.register === 'function') {
      window.KizukiSlots.register('people-radar', function (root, ctx) {
        if (ctx && typeof ctx.openPerson === 'function') {
          state.slotOpenPerson = ctx.openPerson;
        }
        if (root) {
          root.classList.add('people-radar-slot');
          root.setAttribute('data-slot', 'people-radar');
          root.setAttribute('data-kizuki-slot', 'people-radar');
        }
        renderRadarStrip(root);
        fetchRadar(false).then(function () {
          renderRadarStrip(root);
        });
      });
      window.KizukiSlots.register('person-prep', function (root, ctx) {
        mountPersonPrepSlot(root, ctx || {});
      });
    }
  }

  function bootstrap() {
    registerSlots();
    ensureAutoMountRadar();
    ensureAutoMountPersonPrep();

    // Observe People directory and dossier updates cleanly
    let timer = null;
    const scheduleSync = function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        ensureAutoMountRadar();
        ensureAutoMountPersonPrep();
        applyNeedsYouFilterToDirectory();
      }, 60);
    };

    const detailBody = document.getElementById('people-detail-body');
    if (detailBody && typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleSync).observe(detailBody, { childList: true });
    }
    const peopleList = document.getElementById('people-list');
    if (peopleList && typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleSync).observe(peopleList, { childList: true });
    }
    const viewPeople = document.getElementById('view-people');
    if (viewPeople && typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleSync).observe(viewPeople, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
      bootstrap();
    }
  }

  window.KizukiPeopleRadar = {
    fetchRadar: fetchRadar,
    fetchPrepPack: fetchPrepPack,
    renderRadarStrip: renderRadarStrip,
    mountPersonPrepSlot: mountPersonPrepSlot,
  };
})();
