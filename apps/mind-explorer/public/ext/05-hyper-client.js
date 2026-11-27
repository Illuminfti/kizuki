(function (root, factory) {
const api = factory();
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.KizukiHyperCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';
const W = typeof window !== 'undefined' ? window : null;
const D = typeof document !== 'undefined' ? document : null;
const enc = encodeURIComponent;
const $id = (id) => D?.getElementById(id);
const SCOPES = {
  today: 'today actions intel overview pulse decisions',
  stream: 'stream', people: 'people', graph: 'graph',
  intel: 'intel today/next-moves', board: 'agent-board decisions',
  taste: 'taste', codex: 'codex', replay: 'replay',
  vault: 'docs doc vault', atlas: 'atlas', memt: 'memt',
};
const VIEWS = {
  today: ['today?includeNoise=false', 'intel/briefing'],
  people: ['people?limit=120', 'people/radar'],
  board: ['agent-board/rooms', 'agent-board/health'],
  taste: ['taste', 'taste?domain=all'],
  codex: ['codex', 'codex?section=all'],
  replay: ['replay/index'],
  graph: ['graph?limit=150'],
  stream: ['stream?limit=50'],
};
const MUTS = [
  ['/api/agent-board', ['board', 'today']], ['/api/decisions', ['board', 'today']],
  ['/api/actions', ['today', 'codex']], ['/api/today', ['today', 'codex']],
  ['/api/people', ['people']], ['/api/taste', ['taste']], ['/api/codex', ['codex']],
];
const VERBS = new Set('open approve revise defer draft prep task note capture rule snooze ask'.split(' '));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/\s*\u2014\s*/g, ' - ').replace(/\u2014/g, '-').replace(/[&<>"']/g, (c) => ESC[c]);
const hdr = (h, n) => (!h ? '' : h.get ? String(h.get(n) || '') : String(Object.entries(h).find(([k]) => k.toLowerCase() === n)?.[1] || ''));
const saveData = () => Boolean(typeof navigator !== 'undefined' && navigator.connection?.saveData);

function createHyperCache(opts = {}) {
  const freshMs = opts.freshMs ?? 4000, swrMs = opts.swrMs ?? 12000, maxEntries = opts.maxEntries ?? 160;
  const origin = opts.origin || W?.location?.origin || 'http://127.0.0.1:8797';
  const baseOrigin = new URL(origin).origin;
  const now = () => (opts.now ? opts.now() : Date.now());
  const coal = () => W?.KizukiNetCoalesce || null;
  const store = new Map(), flight = new Map();
  let baseFetch = null;
  const stats = { hits: 0, swrHits: 0, misses: 0, prefetches: 0, invalidations: 0, deltasReceived: 0 };

  const toRes = (e) => {
    const h = new Headers();
    for (const [k, v] of e.headers) { try { h.append(k, v); } catch {} }
    return new Response(e.body, { status: e.status, statusText: e.statusText, headers: h });
  };
  const put = (k, e) => {
    if (store.has(k)) store.delete(k);
    else if (store.size >= maxEntries) store.delete(store.keys().next().value);
    store.set(k, e);
  };
  const invalidate = (k) => { if (k && store.delete(k)) stats.invalidations++; if (k) coal()?.invalidate?.(k); };
  const invalidatePrefix = (p) => {
    if (!p) return;
    for (const k of Array.from(store.keys())) if (k.startsWith(p)) { store.delete(k); stats.invalidations++; }
    coal()?.invalidatePrefix?.(p);
  };
  const clear = () => { store.clear(); coal()?.clear?.(); };
  const invalidateScope = (sc) => {
    const s = String(sc || '').trim().toLowerCase();
    if (!s) return;
    if (s === 'all') return clear();
    (SCOPES[s] ? SCOPES[s].split(' ') : [s]).forEach((x) => invalidatePrefix('/api/' + x));
  };

  const resolve = (inp, init) => {
    const obj = inp && typeof inp === 'object' && !(inp instanceof URL) ? inp : null;
    const m = String(init?.method || obj?.method || 'GET').toUpperCase();
    const acc = hdr(init?.headers, 'accept') || hdr(obj?.headers, 'accept');
    const noH = hdr(init?.headers, 'x-kizuki-no-cache') === '1' || hdr(obj?.headers, 'x-kizuki-no-cache') === '1';
    let u;
    try { u = new URL(typeof inp === 'string' ? inp : obj ? obj.url : String(inp || ''), origin); } catch { return { ok: false }; }
    const same = u.origin === baseOrigin, p = u.pathname, api = p.startsWith('/api/');
    const sse = p === '/api/live/events' || p.endsWith('/stream') || p.includes('/stream/') || /text\/event-stream/i.test(acc);
    const noQ = /^(1|true)$/.test(u.searchParams.get('nocache') || '');
    const noS = (init?.cache || obj?.cache) === 'no-store', ab = (init?.signal || obj?.signal)?.aborted;
    return { ok: same && m === 'GET' && api && !sse && !noQ && !noH && !noS && !ab, same, api, sse, m, u, key: p + u.search };
  };

  const dropMut = (p) => {
    for (const [pref, scs] of MUTS) if (p.startsWith(pref)) return scs.forEach(invalidateScope);
    invalidatePrefix(p.split('/').slice(0, 3).join('/'));
  };

  const fetchStore = (fn, inp, init, key, aliases) => {
    if (flight.has(key)) return flight.get(key);
    const pr = Promise.resolve().then(() => fn(inp, init)).then(async (res) => {
      if (String(res.headers?.get?.('content-type') || '').toLowerCase().includes('text/event-stream')) return { raw: res };
      const body = await res.text(), headers = [];
      res.headers?.forEach?.((v, k) => headers.push([k, v]));
      const e = { status: res.status, statusText: res.statusText || '', headers, body, ts: now() };
      if (res.ok) { put(key, e); if (aliases) for (const a of aliases) if (a && a !== key) put(a, e); }
      return { e };
    }).finally(() => { if (flight.get(key) === pr) flight.delete(key); });
    flight.set(key, pr);
    return pr;
  };

  const wrapFetch = (fn) => {
    if (typeof fn !== 'function' || fn.__kizukiHyperWrapped) return fn;
    baseFetch = fn;
    const w = function hyperFetch(inp, init) {
      const i = resolve(inp, init);
      if (!i.ok) {
        if (i.same && i.api && i.m !== 'GET' && i.m !== 'HEAD' && i.u) dropMut(i.u.pathname);
        if (i.sse) {
          const ni = Object.assign({}, init);
          const h = new Headers(ni.headers || (inp && typeof inp === 'object' ? inp.headers : undefined));
          h.set('x-kizuki-no-coalesce', '1');
          ni.headers = h;
          return fn(inp, ni);
        }
        return fn(inp, init);
      }
      const c = store.get(i.key), age = c ? now() - c.ts : Infinity;
      if (c && age < freshMs) { stats.hits++; return Promise.resolve(toRes(c)); }
      if (c && age < swrMs) {
        stats.swrHits++;
        if (!flight.has(i.key)) fetchStore(fn, inp, init, i.key).catch(() => {});
        return Promise.resolve(toRes(c));
      }
      stats.misses++;
      return fetchStore(fn, inp, init, i.key).then((o) => (o.raw ? o.raw : toRes(o.e)));
    };
    w.__kizukiHyperWrapped = true;
    if (fn.__kizukiNetCoalesced) w.__kizukiNetCoalesced = true;
    return w;
  };

  const hasFresh = (u) => { const i = resolve(u); const c = i.ok ? store.get(i.key) : null; return Boolean(c && now() - c.ts < swrMs); };
  const prefetch = (u, aliases) => {
    if (!baseFetch || saveData()) return Promise.resolve(false);
    const i = resolve(u);
    if (!i.ok) return Promise.resolve(false);
    const c = store.get(i.key);
    if (c && now() - c.ts < swrMs * 0.65) return Promise.resolve(true);
    if (flight.has(i.key)) return flight.get(i.key).then(() => true, () => false);
    stats.prefetches++;
    return fetchStore(baseFetch, i.key, { priority: 'low' }, i.key, aliases?.map((x) => resolve(x).key).filter(Boolean)).then(() => true, () => false);
  };

  let es = null, retryId = null, backoff = 1000, jewel = null, liveState = 'idle';
  const setJewel = (st, t) => {
    liveState = st;
    if (!jewel) return;
    jewel.className = 'hyper-live-jewel is-' + st + (jewel.classList.contains('is-floating') ? ' is-floating' : '');
    if (t) jewel.title = t;
  };
  const pulseJewel = () => {
    if (!jewel) return;
    jewel.classList.remove('is-pulse');
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => jewel?.classList.add('is-pulse'));
  };
  const mountJewel = () => {
    if (!D?.body || (jewel = $id('kizuki-live-jewel'))) return;
    const el = D.createElement('span');
    el.id = 'kizuki-live-jewel';
    el.className = 'hyper-live-jewel is-' + liveState;
    el.role = 'status';
    el.setAttribute('aria-label', 'Live SSE sync');
    el.title = 'Live SSE sync';
    const row = D.querySelector('.os-status-row');
    if (row) { const dup = row.querySelector('.status-dot,.rail-dot,.dot'); dup ? dup.replaceWith(el) : row.prepend(el); }
    else { el.classList.add('is-floating'); D.body.append(el); }
    jewel = el;
  };
  const disconnectLive = (why) => {
    clearTimeout(retryId); retryId = null;
    if (es) { try { es.close(); } catch {} es = null; }
    setJewel('paused', why || 'SSE paused');
  };
  const connectLive = () => {
    if (!W || typeof EventSource !== 'function') return false;
    if (D?.hidden) return setJewel('paused', 'SSE paused'), false;
    if (es) return true;
    clearTimeout(retryId); retryId = null;
    try {
      const src = (es = new EventSource('/api/live/events'));
      src.addEventListener('connected', () => { backoff = 1000; setJewel('online', 'Live SSE active'); });
      src.addEventListener('delta', (ev) => {
        let d; try { d = JSON.parse(ev.data || '{}'); } catch { return; }
        stats.deltasReceived++;
        const scs = Array.isArray(d.scopes) ? d.scopes : [];
        scs.forEach(invalidateScope);
        pulseJewel();
        try { W.dispatchEvent(new CustomEvent('kizuki:live-delta', { detail: d })); } catch {}
        if (scs.includes('board')) coal()?.emitBoardSse?.({ kind: 'board', source: 'live-bus', detail: d });
      });
      src.onerror = () => {
        if (es !== src) return;
        try { src.close(); } catch {}
        es = null;
        if (D?.hidden) return setJewel('paused', 'SSE paused');
        setJewel('reconnecting', 'SSE reconnecting');
        const wait = backoff; backoff = Math.min(30000, backoff * 2);
        retryId = setTimeout(() => { retryId = null; connectLive(); }, wait);
      };
      return true;
    } catch { return setJewel('paused', 'SSE unavailable'), false; }
  };

  let hoverId = null, lastHover = null;
  const schedulePrefetch = (el) => {
    const t = el?.closest?.('[data-view],[data-person-key],[data-open-person],[data-thread-id]');
    if (!t || t === lastHover) return;
    lastHover = t;
    clearTimeout(hoverId);
    hoverId = setTimeout(() => {
      hoverId = null;
      if (saveData()) return;
      const v = t.getAttribute('data-view');
      if (v && VIEWS[v]) {
        VIEWS[v].forEach((u) => prefetch('/api/' + u));
        try { W?.KizukiBoot?.ensureChunk?.(v); } catch {}
        return;
      }
      const pk = t.getAttribute('data-person-key') || t.getAttribute('data-open-person');
      if (pk) return void prefetch(`/api/people/dossier?key=${enc(pk)}&limit=80&offset=0`, [`/api/people/dossier?key=${enc(pk)}`]);
      const tid = t.getAttribute('data-thread-id');
      if (tid) prefetch(`/api/agent-board/context?threadId=${enc(tid)}`);
    }, 65);
  };

  let nId = null, nSeq = 0, lastN = { q: '', hits: [] }, bodyObs = null;
  const isAsk = () => D?.querySelector('.cmdp-mode-tab.is-active')?.getAttribute('data-cmdp-mode') === 'ask';
  const navHit = (h) => {
    W?.KizukiCommandPlane?.close?.();
    const t = h?.target && typeof h.target === 'object' ? h.target : h || {};
    const go = (u) => W && (W.location.href = u);
    if (t.personKey) go('/?person=' + enc(t.personKey));
    else if (t.docPath || t.path) go('/?doc=' + enc(t.docPath || t.path));
    else if (t.threadId) go('/?view=board&thread=' + enc(t.threadId) + '&stage=thread');
    else if (t.itemId) go('/?view=codex&itemId=' + enc(t.itemId));
    else if (t.nodeId) go('/?node=' + enc(t.nodeId));
    else if (t.view) (D?.querySelector(`.os-nav-btn[data-view="${t.view}"]`)?.click() ?? go('/?view=' + enc(t.view)));
  };
  const injectNeural = () => {
    const inp = $id('cmdp-input'), body = $id('cmdp-body');
    if (!inp || !body) return;
    const prev = body.querySelector('[data-hyper-neural="1"]'), q = inp.value.trim();
    if (!q || q !== lastN.q || !lastN.hits.length || isAsk()) return void prev?.remove();
    const seen = new Set(Array.from(body.querySelectorAll('.cmdp-row:not(.hyper-neural-row) .cmdp-row-title'), (n) => n.textContent.trim().toLowerCase()));
    const uniq = lastN.hits.filter((h) => { const nm = String(h.title || h.name || h.label || h.id || '').trim(); return nm && !seen.has(nm.toLowerCase()); });
    if (!uniq.length) return void prev?.remove();
    const wrap = prev || D.createElement('div');
    wrap.className = 'hyper-neural-group';
    wrap.dataset.hyperNeural = '1';
    wrap.innerHTML = '<div class="cmdp-group-label hyper-neural-label">NEURAL RECALL</div>' + uniq.map((it, i) => {
      const sc = typeof it.score === 'number' ? it.score : typeof it.similarity === 'number' ? it.similarity : null;
      const pct = sc !== null ? `<span class="hyper-neural-score tabular">${Math.round(sc <= 1 ? sc * 100 : sc)}%</span>` : '';
      const sub = it.subtitle || it.snippet || it.excerpt || '';
      return `<div class="cmdp-row hyper-neural-row" role="option" tabindex="0" data-hyper-neural-idx="${i}"><div class="cmdp-row-main"><div class="cmdp-row-title-line"><span class="cmdp-row-title">${esc(it.title || it.name || it.label || it.id)}</span><span class="cmdp-row-badge">${esc(it.badge || it.kind || 'Recall')}</span>${pct}</div>${sub ? `<div class="cmdp-row-sub">${esc(String(sub).slice(0, 140))}</div>` : ''}</div></div>`;
    }).join('');
    wrap._hyperHits = uniq;
    if (!prev) body.appendChild(wrap);
  };
  const queryNeural = (raw) => {
    const q = String(raw || '').trim();
    if (nId) { clearTimeout(nId); nId = null; }
    if (q.length < 4 || q === '?' || VERBS.has(q.split(/\s+/)[0].toLowerCase())) { lastN = { q: '', hits: [] }; return injectNeural(); }
    const seq = ++nSeq;
    if (!bodyObs && typeof MutationObserver === 'function') {
      const b = $id('cmdp-body');
      if (b) { bodyObs = new MutationObserver(() => { if (lastN.hits.length && !b.querySelector('[data-hyper-neural="1"]')) injectNeural(); }); bodyObs.observe(b, { childList: true }); }
    }
    nId = setTimeout(() => {
      nId = null;
      if (isAsk()) return;
      fetch('/api/semantic/recall?q=' + enc(q) + '&limit=5')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (seq !== nSeq || !d) return;
          const hits = d.hits || d.results || d.items || [];
          lastN = { q, hits: Array.isArray(hits) ? hits.slice(0, 5) : [] };
          injectNeural();
        }).catch(() => {});
    }, 110);
  };

  const bindDom = () => {
    if (!D || D.__kizukiHyperDomBound) return;
    D.__kizukiHyperDomBound = true;
    mountJewel(); connectLive();
    const on = (ev, fn, opt) => D.addEventListener(ev, fn, opt);
    on('pointerenter', (e) => schedulePrefetch(e.target), { capture: true, passive: true });
    on('focusin', (e) => schedulePrefetch(e.target), { passive: true });
    on('input', (e) => e.target?.id === 'cmdp-input' && queryNeural(e.target.value));
    on('click', (e) => {
      const r = e.target?.closest?.('[data-hyper-neural-idx]');
      const h = r?.closest?.('[data-hyper-neural="1"]')?._hyperHits?.[+r.dataset.hyperNeuralIdx];
      if (h) { e.preventDefault(); e.stopPropagation(); navHit(h); }
    }, true);
    on('visibilitychange', () => (D.hidden ? disconnectLive('SSE paused') : connectLive()));
    W?.addEventListener('pagehide', () => disconnectLive('Page unloading'));
  };

  return {
    wrapFetch, prefetch, hasFresh, invalidate, invalidatePrefix, invalidateScope, clear, connectLive, disconnectLive, bindDom,
    getStats: () => ({ ...stats, cacheSize: store.size, inFlight: flight.size, liveState }),
  };
}

const instance = createHyperCache();
function install(targetWin) {
  const w = targetWin || W;
  if (!w || typeof w.fetch !== 'function') return false;
  if (!w.fetch.__kizukiHyperWrapped) w.fetch = instance.wrapFetch(w.fetch.bind(w));
  if (D) D.readyState === 'loading' ? D.addEventListener('DOMContentLoaded', instance.bindDom, { once: true }) : instance.bindDom();
  return true;
}
if (W?.fetch) install(W);
return Object.assign(instance, { createHyperCache, install });
});
