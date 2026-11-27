/* Kizuki Mind OS - Radix-Grade Roving Focus & WCAG AA Accessibility Layer */
(function () {
  'use strict';
  const D = document;
  const ROVING = '.os-nav-list,.today-tabs,.triage-tabs,.pb-tabs,.composer-tabs,.replay-subtabs,.codex-view-toggle,.atlas-tabs,.dir-tabs,[role="tablist"]';
  let queued = false;

  function ensureLandmarks() {
    const html = D.documentElement;
    if (html && !html.getAttribute('lang')) html.setAttribute('lang', 'en');
    const main = D.querySelector('main,[role="main"]') || D.getElementById('workspace');
    if (main) {
      if (main.tagName !== 'MAIN' && !main.getAttribute('role')) main.setAttribute('role', 'main');
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    }
    if (D.body && !D.getElementById('kizuki-skip-link')) {
      const a = D.createElement('a');
      a.id = 'kizuki-skip-link';
      a.className = 'a11y-skip-link';
      a.href = '#' + ((main && main.id) || 'workspace');
      a.textContent = 'Skip to main content';
      a.addEventListener('click', () => {
        const t = D.querySelector('main,[role="main"],#workspace');
        if (t && t.focus) t.focus();
      });
      D.body.insertBefore(a, D.body.firstChild);
    }
  }

  function wrapNavTablist() {
    const nav = D.querySelector('nav.os-nav');
    if (!nav) return;
    if (nav.getAttribute('role') === 'tablist') nav.removeAttribute('role');
    const tabs = [...nav.querySelectorAll(':scope > .os-nav-btn[role="tab"]')];
    if (!nav.querySelector('.os-nav-list') && tabs.length) {
      const box = D.createElement('div');
      box.className = 'os-nav-list';
      box.setAttribute('role', 'tablist');
      box.setAttribute('aria-label', 'Primary workspaces');
      box.setAttribute('aria-orientation', 'vertical');
      nav.insertBefore(box, tabs[0]);
      for (const tab of tabs) box.appendChild(tab);
    }
  }

  function inferLabel(el) {
    const raw = (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
    if (raw) return raw;
    const view = (el.getAttribute('data-view') || '').trim();
    if (view) return 'Open ' + view + ' view';
    const act = (el.getAttribute('data-action') || el.getAttribute('data-eb-action') || '').trim();
    if (act) return act.replace(/[-_]+/g, ' ');
    if (el.id) return el.id.replace(/^(btn|input|select|toggle)-/, '').replace(/[-_]+/g, ' ');
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/close|dismiss|clear/i.test(cls)) return 'Close';
    if (/search|cmdk/i.test(cls)) return 'Search';
    if (/theme/i.test(cls)) return 'Switch theme';
    if (/sound|audio|mute/i.test(cls)) return 'Toggle audio';
    if (/menu|nav/i.test(cls)) return 'Toggle menu';
    if (/refresh|reload/i.test(cls)) return 'Refresh';
    if (/copy/i.test(cls)) return 'Copy';
    return el.tagName === 'INPUT' ? 'Text input' : 'Action button';
  }

  function hasName(el) {
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    const lby = (el.getAttribute('aria-labelledby') || '').trim();
    if (lby && lby.split(/\s+/).some((id) => { const n = D.getElementById(id); return n && (n.textContent || '').trim(); })) return true;
    if (el.id && D.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]')) return true;
    if (el.closest('label')) return true;
    return Boolean((el.textContent || '').trim());
  }

  function repairAria(root) {
    const s = root && root.querySelectorAll ? root : D;

    for (const el of s.querySelectorAll('button,[role="tab"],input:not([type="hidden"]),select,textarea')) {
      if (!hasName(el)) el.setAttribute('aria-label', inferLabel(el));
    }

    for (const tl of s.querySelectorAll('[role="tablist"]')) {
      for (const b of tl.querySelectorAll(':scope > button')) {
        if (!b.getAttribute('role')) b.setAttribute('role', 'tab');
        if (!b.hasAttribute('aria-selected')) b.setAttribute('aria-selected', b.classList.contains('is-active') ? 'true' : 'false');
      }
    }

    for (const c of s.querySelectorAll('.eb-composer[aria-expanded]')) {
      if (!c.getAttribute('role')) {
        c.removeAttribute('aria-expanded');
        c.removeAttribute('aria-controls');
      }
    }

    for (const t of s.querySelectorAll('.eb-exec-kv-table[role="table"]')) t.setAttribute('role', 'list');
    for (const c of s.querySelectorAll('.eb-exec-kv-cell[role="cell"]')) c.setAttribute('role', 'listitem');

    for (const p of s.querySelectorAll('.eb-collapsible-panel[aria-hidden]')) {
      const hid = p.getAttribute('aria-hidden') === 'true';
      p.inert = hid;
      if (hid) p.setAttribute('inert', '');
      else p.removeAttribute('inert');
    }

    for (const g of s.querySelectorAll('div[aria-label]:not([role]),span[aria-label]:not([role])')) {
      g.setAttribute('role', 'group');
    }

    for (const h of s.querySelectorAll('.kbw-thread-row[role="button"],#mobile-composer-bar[role="button"]')) {
      if (h.querySelector('button,a[href]')) {
        h.setAttribute('role', 'group');
        h.removeAttribute('tabindex');
        h.removeAttribute('aria-expanded');
        h.removeAttribute('aria-controls');
      }
    }

    for (const svg of s.querySelectorAll('svg.pv-ego-svg[role="img"]')) {
      if (svg.querySelector('[tabindex],a,button')) svg.setAttribute('role', 'group');
    }
  }

  function rovingItems(group) {
    return [...group.querySelectorAll('[role="tab"],:scope > button,.os-nav-btn')]
      .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  }

  function syncTabindex(group) {
    const items = rovingItems(group);
    if (!items.length) return;
    const active = items.find((el) => el.getAttribute('aria-selected') === 'true' || el.classList.contains('is-active')) || items[0];
    for (const el of items) el.setAttribute('tabindex', el === active ? '0' : '-1');
  }

  function bindRoving(root) {
    const s = root && root.querySelectorAll ? root : D;
    for (const group of s.querySelectorAll(ROVING)) {
      syncTabindex(group);
      if (group.dataset.a11yRoving === '1') continue;
      group.dataset.a11yRoving = '1';
      group.addEventListener('keydown', (ev) => {
        const k = ev.key;
        if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
        const items = rovingItems(group);
        const idx = items.indexOf(D.activeElement);
        if (items.length < 2 || idx === -1) return;
        ev.preventDefault();
        const next = k === 'Home' ? 0 : k === 'End' ? items.length - 1
          : (k === 'ArrowRight' || k === 'ArrowDown') ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
        for (let i = 0; i < items.length; i++) items[i].setAttribute('tabindex', i === next ? '0' : '-1');
        items[next].focus();
      });
      group.addEventListener('click', () => queueMicrotask(() => syncTabindex(group)));
    }
  }

  function run() {
    queued = false;
    ensureLandmarks();
    wrapNavTablist();
    repairAria(D);
    bindRoving(D);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(run, 16);
  }

  function boot() {
    run();
    if (typeof MutationObserver === 'function' && D.body) {
      new MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-hidden', 'aria-selected', 'aria-expanded', 'class', 'hidden']
      });
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.__kizukiA11y = { run, syncTabindex };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { inferLabel, ROVING };
})();
