/* Kizuki Mind OS - Studio Motion Runtime (Lane U1) */
((root, factory) => {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.KizukiStudioMotion = api;
  if (typeof window !== 'undefined' && window) window.KizukiStudioMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), (g) => {
  'use strict';
  const SX = '.today-tabs,.pb-tabs,.tr-filter-bar,.triage-tabs,.composer-tabs,.dir-tabs,.atlas-tabs,.cmdp-mode-tabs,.replay-subtabs,.replay-year-pills,.sm-segmented,[data-sm-segmented]';
  const SN = '.os-nav,.vault-cat-list,[aria-orientation="vertical"],[data-sm-no-thumb]';
  const SP = '.tr-move,.tr-card,.pb-row,.today-card,.taste-card,.sm-tilt-card,.ust-tile,[data-sm-specular]';
  const TS = '.taste-card,.sm-tilt-card';
  const MS = '.tr-detent-btn,#btn-open-vault,#btn-new-action,.iask-send-btn,.icap-submit-btn,#iask-submit,#icap-submit,.iask-submit,#btn-detail-primary,#btn-toggle-quick-action,#btn-new-note,[data-sm-magnetic]';
  const TH = '#btn-theme-toggle,#btn-theme,#btn-mobile-theme';
  const RAD = 220, MT = 2.2, MM = 3.2, SPR = 'cubic-bezier(0.22, 1.28, 0.36, 1)';
  const tState = new WeakMap();
  let lit = new Set(), tiltEl = null, magEl = null, pending = null, pRaf = null, sRaf = null, mTimer = null, ready = false;
  const getW = () => (typeof window !== 'undefined' && window) || g?.window || null;
  const getD = () => (typeof document !== 'undefined' && document) || getW()?.document || null;
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
  const r2 = (n) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };
  const sp = (el, k, v) => el.style.setProperty(k, v);
  const ga = (el, k) => el?.getAttribute?.(k);
  const sa = (el, k, v) => el.setAttribute(k, v);
  const ra = (el, k) => el.removeAttribute(k);
  const hc = (el, c) => Boolean(el?.classList?.contains(c));
  const rc = (el) => el.getBoundingClientRect();
  const on = (t, ev, fn) => t.addEventListener(ev, fn, { passive: true });
  const raf = (fn) => { const w = getW(); return w?.requestAnimationFrame ? w.requestAnimationFrame(fn) : (fn(), null); };
  const dOff = (d) => ga((d || getD())?.documentElement, 'data-detail') === 'off';
  const mq = (w, q, fb) => { try { const m = (w || getW())?.matchMedia; return typeof m === 'function' ? Boolean(m(q).matches) : fb; } catch { return fb; } };
  const reduced = (w) => mq(w, '(prefers-reduced-motion: reduce)', false);
  const hoverOk = (w) => mq(w, '(hover: hover)', true);
  const isEl = (el, s) => { try { return Boolean(el?.nodeType === 1 && el.matches?.(s)); } catch { return false; } };
  const near = (el, s) => { try { return el?.closest?.(s) || null; } catch { return null; } };

  const computeFlipTransform = (p, n) => {
    if (!n || n.w <= 0 || n.h <= 0) return { invert: '', target: '' };
    const target = `translate3d(${r2(n.x)}px, ${r2(n.y)}px, 0) scaleX(1)`;
    if (!p || p.w <= 0 || p.h <= 0) return { invert: target, target };
    const sx = r2(p.w / n.w), sy = r2(p.h / n.h);
    return { invert: `translate3d(${r2(p.x)}px, ${r2(p.y)}px, 0) scaleX(${sx})${sy !== 1 ? ` scaleY(${sy})` : ''}`, target };
  };
  const norm = (x, y, r) => (r?.width > 0 && r?.height > 0 ? [cl((x - (r.left + r.width / 2)) / (r.width / 2), -1, 1), cl((y - (r.top + r.height / 2)) / (r.height / 2), -1, 1)] : null);
  const computeTilt = (x, y, r) => { const o = norm(x, y, r); return o ? { rx: cl(r2(-o[1] * 2.1), -MT, MT), ry: cl(r2(o[0] * 2.1), -MT, MT) } : { rx: 0, ry: 0 }; };
  const computeMagnetic = (x, y, r) => { const o = norm(x, y, r); return o ? { tx: cl(r2(o[0] * 3), -MM, MM), ty: cl(r2(o[1] * 2.6), -MM, MM) } : { tx: 0, ty: 0 }; };
  const distTo = (x, y, r) => Math.hypot(x < r.left ? r.left - x : x > r.right ? x - r.right : 0, y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0);

  const tabItems = (bar) => Array.from(bar.children || []).filter((c) => c?.nodeType === 1 && !hc(c, 'sm-seg-thumb') && (c.tagName === 'BUTTON' || c.tagName === 'A' || ga(c, 'role') === 'tab'));
  const isSegBar = (el) => {
    if (!el || el.nodeType !== 1 || isEl(el, SN)) return false;
    if (isEl(el, SX)) return true;
    if (ga(el, 'role') !== 'tablist') return false;
    const it = tabItems(el);
    if (it.length < 2) return false;
    const a = rc(it[0]), b = rc(it[1]);
    return !(a.width > 0 && b.width > 0 && Math.abs(b.top - a.top) > Math.max(a.height, b.height) * 0.75);
  };

  function syncBar(bar, opts) {
    const doc = opts?.doc || getD();
    if (!bar || !doc || !isSegBar(bar)) return false;
    bar.classList?.add('sm-seg-host');
    let thumb = Array.from(bar.children || []).find((c) => hc(c, 'sm-seg-thumb'));
    if (!thumb) {
      thumb = doc.createElement('span');
      thumb.className = 'sm-seg-thumb';
      sa(thumb, 'aria-hidden', 'true');
      bar.firstChild ? bar.insertBefore(thumb, bar.firstChild) : bar.appendChild(thumb);
    }
    const st = thumb.style;
    const act = tabItems(bar).find((b) => hc(b, 'is-active') || ga(b, 'aria-selected') === 'true' || ga(b, 'aria-pressed') === 'true' || ga(b, 'data-active') === 'true');
    if (!act) { st.opacity = '0'; ra(bar, 'data-sm-ready'); return false; }
    const br = rc(bar), ar = rc(act);
    if (br.width <= 0 || ar.width <= 0 || ar.height <= 0) { st.opacity = '0'; return false; }
    const next = { x: r2(ar.left - br.left - (bar.clientLeft || 0) + (bar.scrollLeft || 0)), y: r2(ar.top - br.top - (bar.clientTop || 0) + (bar.scrollTop || 0)), w: r2(ar.width), h: r2(ar.height) };
    const prev = tState.get(bar), inst = Boolean(opts?.instant) || dOff(doc) || reduced(opts?.win);
    const moved = prev && (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h);
    st.width = `${next.w}px`; st.height = `${next.h}px`;
    const flip = computeFlipTransform(prev, next);
    st.transition = 'none';
    if (!inst && moved) { st.transform = flip.invert; void thumb.offsetWidth; st.transition = `transform 340ms ${SPR}, opacity 140ms ease`; st.transform = flip.target; }
    else { st.transform = flip.target; if (!inst) { void thumb.offsetWidth; st.transition = ''; } }
    st.opacity = ''; sa(bar, 'data-sm-ready', '1'); tState.set(bar, next);
    return true;
  }

  function syncSegmented(target, opts) {
    const doc = opts?.doc || getD();
    if (!doc) return 0;
    if (target?.nodeType === 1 && isSegBar(target)) return syncBar(target, opts) ? 1 : 0;
    const seen = new Set();
    let n = 0;
    for (const bar of (target?.querySelectorAll ? target : doc).querySelectorAll(`${SX},[role="tablist"]`)) {
      if (!seen.has(bar)) { seen.add(bar); if (syncBar(bar, opts)) n += 1; }
    }
    return n;
  }

  const schedSeg = (inst) => { if (sRaf === null) sRaf = raf(() => { sRaf = null; syncSegmented(null, { instant: Boolean(inst) }); }); };
  const resetPair = (el, a, p1, p2, u) => { if (!el) return; sp(el, p1, `0${u}`); sp(el, p2, `0${u}`); ra(el, a); };
  const clearSpec = () => { lit.forEach((c) => { sp(c, '--sm-active', '0'); ra(c, 'data-sm-lit'); }); lit.clear(); };
  const clearPointerEffects = () => { clearSpec(); resetPair(tiltEl, 'data-sm-tilt', '--sm-rx', '--sm-ry', 'deg'); tiltEl = null; resetPair(magEl, 'data-sm-mag', '--sm-tx', '--sm-ty', 'px'); magEl = null; };
  const trackPair = (cur, s, sel, a, p1, p2, u, k1, k2, fn) => {
    const el = near(s.target, sel);
    if (el !== cur) resetPair(cur, a, p1, p2, u);
    if (el) { const v = fn(s.x, s.y, rc(el)); sp(el, p1, `${v[k1]}${u}`); sp(el, p2, `${v[k2]}${u}`); sa(el, a, '1'); }
    return el;
  };

  function flushPointerFrame(sample, doc, win) {
    pRaf = null;
    const s = sample || pending; pending = null;
    if (!s) return;
    const d = doc || getD(), w = win || getW();
    if (d?.hidden || dOff(d) || reduced(w) || !hoverOk(w)) { clearPointerEffects(); return; }
    const hit = near(s.target, SP);
    if (!hit) { if (lit.size) clearSpec(); }
    else {
      const list = [hit], kids = hit.parentElement?.children;
      if (kids) for (let i = 0, len = Math.min(kids.length, 48); i < len; i += 1) if (kids[i] !== hit && isEl(kids[i], SP)) list.push(kids[i]);
      const nextLit = new Set();
      for (const c of list) {
        const rect = rc(c);
        if (rect.width <= 0 || rect.height <= 0) continue;
        const dist = c === hit ? 0 : distTo(s.x, s.y, rect);
        if (dist > RAD) continue;
        sp(c, '--sm-mx', `${r2(s.x - rect.left)}px`);
        sp(c, '--sm-my', `${r2(s.y - rect.top)}px`);
        sp(c, '--sm-active', String(c === hit ? 1 : r2(Math.max(0.24, 1 - dist / RAD))));
        sa(c, 'data-sm-lit', '1');
        nextLit.add(c);
      }
      lit.forEach((p) => { if (!nextLit.has(p)) { sp(p, '--sm-active', '0'); ra(p, 'data-sm-lit'); } });
      lit = nextLit;
    }
    tiltEl = trackPair(tiltEl, s, TS, 'data-sm-tilt', '--sm-rx', '--sm-ry', 'deg', 'rx', 'ry', computeTilt);
    magEl = trackPair(magEl, s, MS, 'data-sm-mag', '--sm-tx', '--sm-ty', 'px', 'tx', 'ty', computeMagnetic);
  }

  function onPointerMove(ev) {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    if (dOff() || reduced() || !hoverOk()) { clearPointerEffects(); return; }
    pending = { x: ev.clientX, y: ev.clientY, target: ev.target };
    if (pRaf === null) pRaf = raf(() => flushPointerFrame());
  }

  function pulseThemeMorph(doc, win) {
    const d = doc || getD(), w = win || getW();
    if (!d || dOff(d) || reduced(w)) return false;
    const btns = Array.from(d.querySelectorAll(TH));
    if (!btns.length) return false;
    for (const b of btns) { b.classList.remove('is-sm-morphing'); void b.offsetWidth; b.classList.add('is-sm-morphing'); }
    try { w?.KizukiTactile?.clickDetent?.('soft'); } catch {}
    if (mTimer) clearTimeout(mTimer);
    mTimer = setTimeout(() => { mTimer = null; btns.forEach((b) => b.classList.remove('is-sm-morphing')); }, 380);
    return true;
  }

  function init() {
    if (ready) return;
    const w = getW(), doc = getD();
    if (!w || !doc) return;
    ready = true;
    syncSegmented(null, { instant: true });
    on(doc, 'pointermove', onPointerMove);
    on(doc, 'pointerleave', clearPointerEffects);
    on(doc, 'click', (ev) => {
      if (!ev?.target) return;
      if (near(ev.target, TH)) pulseThemeMorph();
      if (near(ev.target, `${SX},[role="tablist"]`)) schedSeg(false);
    });
    on(w, 'blur', clearPointerEffects);
    on(w, 'resize', () => schedSeg(true));
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) clearPointerEffects(); });
    if (typeof w.MutationObserver === 'function') {
      const obs = new w.MutationObserver((recs) => {
        let seg = false, off = false;
        for (const r of recs) {
          if (r.type === 'attributes') {
            if (r.attributeName === 'data-detail') { off = dOff(doc); seg = true; }
            else if (r.attributeName === 'data-theme' && r.target === doc.documentElement) pulseThemeMorph(doc, w);
            else if (!hc(r.target, 'sm-seg-thumb')) seg = true;
          } else if (r.type === 'childList' && !(r.addedNodes.length === 1 && !r.removedNodes.length && hc(r.addedNodes[0], 'sm-seg-thumb'))) seg = true;
        }
        if (off) clearPointerEffects();
        if (seg) schedSeg(off);
      });
      doc.documentElement && obs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-detail', 'data-theme'] });
      doc.body && obs.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'data-active'] });
    }
  }
  const d0 = getD();
  d0 && (d0.readyState === 'loading' ? d0.addEventListener('DOMContentLoaded', init, { once: true }) : init());
  return { version: 1, syncSegmented, pulseThemeMorph, clearPointerEffects, flushPointerFrame, computeFlipTransform, computeTilt, computeMagnetic, init };
});
