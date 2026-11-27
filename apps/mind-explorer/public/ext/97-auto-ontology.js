/* Kizuki Auto-Ontology Studio (Alt+O) - Pre-Flight Answerability, Join Paths, Certification & Ossie YAML */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KizukiAutoOntology = api;
})(function () {
  'use strict';

  const D = typeof document !== 'undefined' ? document : null;
  const W = typeof window !== 'undefined' ? window : null;
  const S = {
    open: false,
    booted: false,
    status: null,
    terms: [],
    totalTerms: 0,
    q: '',
    family: 'all',
    certOnly: false,
    selectedId: null,
    detail: null,
    answer: null,
    tracedPath: null,
    toast: '',
    el: {},
  };

  const cl = (s) => `${s ?? ''}`.replace(/\s*\u2014\s*/g, ' - ').replace(/\u2014/g, '-');
  const es = (s) => cl(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const on = (el, ev, fn) => el?.addEventListener?.(ev, fn);
  const A = (x) => (Array.isArray(x) ? x : []);

  async function apiJson(url, opts) {
    if (typeof fetch !== 'function') return null;
    const res = await fetch(url, { headers: { Accept: 'application/json', ...(opts?.headers || {}) }, ...opts });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text }; }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function setMsg(text) {
    S.toast = cl(text || '');
    if (S.el.msg) S.el.msg.textContent = S.toast;
  }

  function renderStats() {
    if (!S.el.stats || !S.status?.stats) return;
    const st = S.status.stats;
    S.el.stats.innerHTML = [
      ['Terms', st.terms],
      ['Certified', st.certified],
      ['Families', st.families],
      ['Confirmed Rel', st.confirmed_relations],
      ['Metrics', st.metrics],
    ].map(([k, v]) => `<span>${k} <b>${Number(v || 0).toLocaleString()}</b></span>`).join('');
    if (S.el.fams) {
      const fams = A(S.status.families);
      S.el.fams.innerHTML = [
        `<button type="button" class="ont-btn" data-ofam="all" aria-pressed="${S.family === 'all'}">All (${st.terms})</button>`,
        ...fams.map((f) =>
          `<button type="button" class="ont-btn" data-ofam="${es(f.id)}" aria-pressed="${S.family === f.id}">${es(f.name.split('&')[0].trim())} (${f.term_count})</button>`
        ),
      ].join('');
    }
  }

  function renderAnswer() {
    const box = S.el.ans;
    if (!box) return;
    const a = S.answer;
    if (!a) { box.hidden = true; return; }
    box.hidden = false;
    const vc = a.verdict === 'answerable' ? 'is-answerable' : a.verdict === 'partial' ? 'is-partial' : 'is-unanswerable';
    const matched = A(a.matched_terms)
      .map((m) => `<button type="button" class="ont-chip ${m.certified ? 'is-cert' : ''}" data-oterm="${es(m.id)}" title="${es(m.family_name)} (${es(m.match_type)})">${m.certified ? '&#10003; ' : ''}${es(m.canonical_name)}</button>`)
      .join('');
    const missing = A(a.missing_terms)
      .map((g) => `<span class="ont-chip is-gap" title="${es(g.reason)}">missing: ${es(g.phrase)}</span>`)
      .join('');
    const paths = A(a.join_paths).slice(0, 2).map((jp) => {
      const steps = A(jp.edges).map((e) => `${es(e.from_name)} -[${es(e.predicate)}]-> ${es(e.to_name)}`).join(' | ');
      return `<div class="ont-path"><b>Join Path (${jp.hops} hop${jp.hops === 1 ? '' : 's'}):</b> ${es(jp.path_label)}${steps ? ` &middot; <span>${steps}</span>` : ''}</div>`;
    }).join('');
    box.innerHTML =
      `<div class="ont-rtop"><div class="ont-row"><span class="ont-v ${vc}">${es(a.verdict)}</span><span class="ont-tag">Coverage ${a.coverage_pct}%</span><div class="ont-meter"><div class="ont-fill ${vc}" style="width:${Math.max(0, Math.min(100, a.coverage_pct))}%"></div></div></div><span class="ont-msg">${a.latency_ms} ms</span></div>` +
      (matched ? `<div class="ont-chips"><span class="ont-msg">Resolved:</span>${matched}</div>` : '') +
      paths +
      (missing ? `<div class="ont-chips"><span class="ont-msg">Gaps:</span>${missing}</div>` : '');
  }

  function renderList() {
    const box = S.el.list;
    if (!box) return;
    if (!S.terms.length) {
      box.innerHTML = `<div class="ont-msg" style="padding:10px">No matching ontology terms.</div>`;
      return;
    }
    box.innerHTML = S.terms.map((t) =>
      `<button type="button" class="ont-item ${t.id === S.selectedId ? 'is-sel' : ''}" data-oterm="${es(t.id)}">` +
      `<div class="ont-itop"><span class="ont-iname">${es(t.canonical_name)}</span>${t.certified ? '<span class="ont-seal">CERTIFIED</span>' : `<span class="ont-tag">${es(t.kind)}</span>`}</div>` +
      `<div class="ont-imeta"><span>${es(t.family_name)}</span><span>&middot;</span><span>${t.support_count}x evidence</span></div></button>`
    ).join('');
  }

  function renderDetail() {
    const box = S.el.det;
    if (!box) return;
    const d = S.detail;
    if (!d?.term) {
      box.innerHTML = `<div class="ont-card"><div class="ont-sec-k">Semantic Term Inspector</div><div class="ont-msg">Select a term from the ledger or run a Pre-Flight Answerability check above.</div></div>`;
      return;
    }
    const t = d.term, rels = A(d.relations), provs = A(t.provenance), jps = A(d.join_paths);
    const relRows = rels.length
      ? rels.slice(0, 20).map((r) => {
          const out = r.from_id === t.id, oid = out ? r.to_id : r.from_id, oname = out ? r.to_name : r.from_name;
          const dir = out ? `-[${r.predicate}]->` : `<-[${r.predicate}]-`;
          return `<div class="ont-rel"><button type="button" data-oterm="${es(oid)}">${es(dir)} ${es(oname)}</button><span class="ont-msg">${r.confirmed ? 'confirmed' : 'inferred'} &middot; ${r.support_count}x</span></div>`;
        }).join('')
      : `<div class="ont-msg">No direct relations recorded.</div>`;
    const jpHtml = jps.map((jp) => `<div class="ont-path"><b>${jp.hops}h:</b> ${es(jp.path_label)}</div>`).join('');
    const tracedHtml = S.tracedPath
      ? (S.tracedPath.found
          ? `<div class="ont-path"><b>Traced (${S.tracedPath.hops} hops, ${S.tracedPath.latency_ms}ms):</b> ${es(S.tracedPath.path_label)}</div>`
          : `<div class="ont-msg">No semantic join path found within 5 hops.</div>`)
      : '';
    const seal = t.certified
      ? `<span class="ont-v is-answerable" title="Sticky receipt ${es(t.certification_receipt || '')}">Certified ${t.certification_receipt ? '#' + es(t.certification_receipt.slice(0, 8)) : ''}</span>`
      : '<span class="ont-tag">Uncertified</span>';
    box.innerHTML =
      `<div class="ont-card"><div class="ont-rtop"><div><div class="ont-tl">${es(t.canonical_name)}</div><div class="ont-imeta"><span>${es(t.id)}</span><span>&middot;</span><span>${es(t.family_name)}</span><span>&middot;</span><span>${es(t.kind)}</span></div></div><div class="ont-row">${seal}</div></div>` +
      `<div><div class="ont-sec-k">Canonical Description (Sticky Owner Edit)</div><textarea class="ont-ta" data-k="desc">${es(t.description)}</textarea></div>` +
      `<div><div class="ont-sec-k">Synonyms (comma-separated)</div><input type="text" class="ont-in" data-k="syns" value="${es(A(t.synonyms).join(', '))}" placeholder="aliases, acronyms, alternate names"></div>` +
      `<div class="ont-row"><button type="button" class="ont-btn is-primary" data-oact="certify">${t.certified ? 'Update Certified Term' : 'Certify Term'}</button>${t.certified ? '<button type="button" class="ont-btn" data-oact="uncertify">Revoke Seal</button>' : ''}<span class="ont-msg">${t.certified_at ? `Sticky receipt saved ${es(t.certified_at.slice(0, 10))}` : 'Certifications survive every recompile.'}</span></div></div>` +
      `<div class="ont-card"><div class="ont-sec-k">Semantic Join Path Tracer</div><div class="ont-pff"><input type="text" class="ont-in" data-k="pathTo" placeholder="Trace shortest join path to term (e.g. Open Commitments, Taste)..."><button type="button" class="ont-btn" data-oact="trace">Trace Path</button></div>${tracedHtml}${jpHtml}</div>` +
      `<div class="ont-card"><div class="ont-sec-k">Confirmed Relations (${rels.length})</div>${relRows}</div>` +
      `<div class="ont-card"><div class="ont-sec-k">Vault Provenance (${provs.length})</div>${provs.length ? `<div class="ont-chips">${provs.map((p) => `<span class="ont-tag">${es(p.source)}: ${es(p.path)}</span>`).join('')}</div>` : '<div class="ont-msg">Compiled from ontology schema.</div>'}</div>`;
  }

  async function loadStatus() {
    const data = await apiJson('/api/ontology/status');
    if (data) { S.status = data; renderStats(); }
    return data;
  }

  async function searchLedger() {
    const p = new URLSearchParams({ limit: '80' });
    if (S.q) p.set('q', S.q);
    if (S.family && S.family !== 'all') p.set('family', S.family);
    if (S.certOnly) p.set('certified', 'true');
    const data = await apiJson(`/api/ontology/search?${p}`);
    if (data) {
      S.terms = A(data.terms);
      S.totalTerms = Number(data.total || S.terms.length);
      renderList();
      if (!S.selectedId && S.terms[0]) await selectTerm(S.terms[0].id);
    }
    return data;
  }

  async function selectTerm(id) {
    if (!id) return null;
    S.selectedId = id;
    S.tracedPath = null;
    renderList();
    const data = await apiJson(`/api/ontology/term?id=${encodeURIComponent(id)}`);
    if (data?.term) { S.detail = data; renderDetail(); }
    return data;
  }

  async function checkQuestion(question) {
    const q = cl(question || '').trim();
    if (!q) return null;
    if (S.el.pfIn && S.el.pfIn.value !== q) S.el.pfIn.value = q;
    const data = await apiJson('/api/ontology/check-answerable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    if (data) {
      S.answer = data;
      renderAnswer();
      if (data.matched_terms?.[0]?.id) await selectTerm(data.matched_terms[0].id);
    }
    return data;
  }

  async function certifySelected(certified) {
    if (!S.selectedId) return null;
    const descEl = S.el.det?.querySelector('[data-k="desc"]');
    const synsEl = S.el.det?.querySelector('[data-k="syns"]');
    const res = await apiJson('/api/ontology/certify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: S.selectedId,
        certified: certified !== false,
        description: descEl ? descEl.value.trim() : undefined,
        synonyms: synsEl ? synsEl.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      }),
    });
    if (res?.ok) {
      setMsg(res.receipt.certified ? `Certified ${res.term.canonical_name} (#${res.receipt.receipt_hash.slice(0, 8)})` : `Revoked seal for ${res.term.canonical_name}`);
      await Promise.all([loadStatus(), searchLedger(), selectTerm(S.selectedId)]);
    }
    return res;
  }

  async function traceSelectedPath() {
    if (!S.selectedId) return null;
    const to = S.el.det?.querySelector('[data-k="pathTo"]')?.value?.trim();
    if (!to) return null;
    const res = await apiJson(`/api/ontology/path?from=${encodeURIComponent(S.selectedId)}&to=${encodeURIComponent(to)}`);
    if (res) { S.tracedPath = res; renderDetail(); }
    return res;
  }

  async function compile() {
    setMsg('Compiling vault ontology...');
    const data = await apiJson('/api/ontology/compile', { method: 'POST' });
    if (data) {
      S.status = data;
      renderStats();
      await searchLedger();
      if (S.selectedId) await selectTerm(S.selectedId);
      setMsg(`Compiled ${data.stats.terms} terms in ${data.compile_ms} ms (certifications preserved).`);
    }
    return data;
  }

  async function exportYaml(download) {
    const url = `/api/ontology/export?format=ossie-yaml${download ? '&download=1' : ''}`;
    if (download && D) {
      const a = D.createElement('a');
      a.href = url;
      a.download = 'kizuki-ontology.ossie.yaml';
      D.body.appendChild(a);
      a.click();
      a.remove();
      setMsg('Downloaded kizuki-ontology.ossie.yaml');
      return true;
    }
    if (typeof fetch !== 'function') return '';
    const yaml = await (await fetch(url)).text();
    try {
      if (W?.navigator?.clipboard?.writeText) {
        await W.navigator.clipboard.writeText(yaml);
        setMsg(`Copied Ossie YAML (${yaml.length.toLocaleString()} bytes) to clipboard.`);
      } else setMsg(`Exported Ossie YAML (${yaml.length.toLocaleString()} bytes).`);
    } catch { setMsg(`Exported Ossie YAML (${yaml.length.toLocaleString()} bytes).`); }
    return yaml;
  }

  function buildModalDom() {
    if (!D || S.el.bd?.isConnected) return;
    const bd = D.createElement('div');
    bd.id = 'kizuki-ontology-backdrop';
    bd.className = 'ont-bd';
    bd.hidden = true;
    bd.innerHTML =
      `<div class="ont-m" role="dialog" aria-modal="true" aria-label="Auto-Ontology Studio">` +
      `<header class="ont-hd"><div class="ont-hl"><span class="ont-dot"></span><span class="ont-tl">Auto-Ontology Studio</span><span class="ont-tag">Alt+O</span><div class="ont-stats" data-k="stats"></div></div>` +
      `<div class="ont-hr"><span class="ont-msg" data-k="msg"></span><button type="button" class="ont-btn" data-oact="compile">Recompile</button><button type="button" class="ont-btn" data-oact="copyYaml">Copy Ossie YAML</button><button type="button" class="ont-btn" data-oact="dlYaml">Export YAML</button><button type="button" class="ont-btn" data-oact="close">Esc</button></div></header>` +
      `<section class="ont-pf" aria-label="Pre-Flight Answerability Checker"><form class="ont-pff" data-k="pfForm"><input type="text" class="ont-in" data-k="pfIn" placeholder="Pre-Flight check_answerable: ask any question to verify coverage, join paths, and missing terms..."><button type="submit" class="ont-btn is-primary">Check Answerable</button><button type="button" class="ont-btn" data-osample="What are our open Kizuki world model commitments?">Sample: Grounded</button><button type="button" class="ont-btn" data-osample="What was our Q3 TikTok ad spend?">Sample: Gap</button></form><div class="ont-res" data-k="ans" hidden></div></section>` +
      `<div class="ont-body"><div class="ont-left"><div class="ont-flt"><div class="ont-pff"><input type="search" class="ont-in" data-k="qIn" placeholder="Filter terms, synonyms, entities..."><button type="button" class="ont-btn" data-k="certBtn" data-oact="toggleCert" aria-pressed="false">Certified</button></div><div class="ont-fams" data-k="fams"></div></div><div class="ont-list" data-k="list"></div></div><aside class="ont-right" data-k="det"></aside></div></div>`;
    D.body.appendChild(bd);
    S.el.bd = bd;
    bd.querySelectorAll('[data-k]').forEach((n) => { S.el[n.dataset.k] = n; });

    on(bd, 'click', (e) => {
      if (e.target === bd) return close();
      const actEl = e.target.closest('[data-oact]');
      if (actEl) {
        const a = actEl.dataset.oact, fail = (err) => setMsg(err.message);
        if (a === 'close') return close();
        if (a === 'compile') return compile().catch(fail);
        if (a === 'copyYaml') return exportYaml(false).catch(fail);
        if (a === 'dlYaml') return exportYaml(true).catch(fail);
        if (a === 'certify') return certifySelected(true).catch(fail);
        if (a === 'uncertify') return certifySelected(false).catch(fail);
        if (a === 'trace') return traceSelectedPath().catch(fail);
        if (a === 'toggleCert') { S.certOnly = !S.certOnly; actEl.setAttribute('aria-pressed', String(S.certOnly)); return searchLedger().catch(fail); }
      }
      const famEl = e.target.closest('[data-ofam]');
      if (famEl) { S.family = famEl.dataset.ofam || 'all'; renderStats(); return searchLedger().catch((err) => setMsg(err.message)); }
      const termEl = e.target.closest('[data-oterm]');
      if (termEl) return selectTerm(termEl.dataset.oterm).catch((err) => setMsg(err.message));
      const sampEl = e.target.closest('[data-osample]');
      if (sampEl) return checkQuestion(sampEl.dataset.osample).catch((err) => setMsg(err.message));
    });

    on(S.el.pfForm, 'submit', (e) => { e.preventDefault(); checkQuestion(S.el.pfIn?.value || '').catch((err) => setMsg(err.message)); });
    let qTimer = 0;
    on(S.el.qIn, 'input', () => {
      S.q = S.el.qIn.value.trim();
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { searchLedger().catch((err) => setMsg(err.message)); }, 90);
    });
  }

  async function open(opts) {
    buildModalDom();
    if (!S.el.bd) return false;
    S.open = true;
    S.el.bd.hidden = false;
    renderDetail();
    try {
      await Promise.all([loadStatus(), searchLedger()]);
      if (opts?.question) await checkQuestion(opts.question);
    } catch (err) { setMsg(err?.message || 'Failed to load ontology'); }
    try { S.el.pfIn?.focus?.(); } catch {}
    return true;
  }

  function close() { S.open = false; if (S.el.bd) S.el.bd.hidden = true; return true; }
  function toggle() { return S.open ? close() : open(); }

  function boot() {
    if (!D || S.booted) return;
    S.booted = true;
    on(D, 'keydown', (e) => {
      if (e.key === 'Escape' && S.open) { e.preventDefault(); return close(); }
      if (!W?.__KIZUKI_ONTOLOGY_HOOKED__ && e.altKey && !e.ctrlKey && !e.metaKey && (`${e.key || ''}`.toLowerCase() === 'o' || e.code === 'KeyO')) {
        e.preventDefault();
        toggle();
      }
    });
    if (!W?.__KIZUKI_ONTOLOGY_HOOKED__) {
      on(D.getElementById('btn-ontology-open'), 'click', () => open());
      on(D.getElementById('btn-mobile-ontology'), 'click', () => open());
      try { if (W?.location?.search && new URLSearchParams(W.location.search).get('ontology') === 'open') open(); } catch {}
    }
  }

  if (D) D.readyState === 'loading' ? on(D, 'DOMContentLoaded', boot) : boot();

  return {
    open, close, toggle, isOpen: () => S.open,
    checkQuestion, selectTerm, certifySelected, compile, exportYaml,
    getState: () => ({ open: S.open, status: S.status, q: S.q, family: S.family, certOnly: S.certOnly, selectedId: S.selectedId, answer: S.answer }),
    boot,
  };
});
