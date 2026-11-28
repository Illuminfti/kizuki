/* View layers: the shared kit (ext/97a-w10-kit.*) and each view's Wave 10 css/js (ext/97b-w10-<view>.*)
   arrive when that view first opens, then the rest load while the browser is idle,
   so Today's first load stays inside the wire budget. */
(function loadViewLayers(root) {
  'use strict';
  if (typeof document === 'undefined') return;
  const lazy = (root.__KIZUKI_CHUNKS__ && root.__KIZUKI_CHUNKS__.lazyExt) || {};
  const done = new Set();

  function attach(view) {
    const layer = lazy['w10-' + view];
    if (!layer || done.has(view)) return;
    done.add(view);
    if (view !== 'kit') attach('kit');
    const head = document.head || document.documentElement;
    if (layer.css) {
      const ln = document.createElement('link');
      ln.rel = 'stylesheet';
      ln.href = layer.css;
      ln.setAttribute('data-k10-layer', view);
      head.appendChild(ln);
    }
    if (layer.js) {
      const sc = document.createElement('script');
      sc.src = layer.js;
      sc.async = false;
      sc.setAttribute('data-k10-layer', view);
      head.appendChild(sc);
    }
  }

  function activeView() {
    const m = /(?:^|\s)view-([a-z]+)(?:\s|$)/.exec(document.body ? document.body.className : '');
    return m && m[1] !== 'is' ? m[1] : null;
  }

  function sync() {
    const v = activeView();
    if (v) attach(v);
  }

  function prefetchRest() {
    Object.keys(lazy)
      .filter((k) => k.indexOf('w10-') === 0)
      .forEach((k) => attach(k.slice(4)));
  }

  function start() {
    sync();
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const idle = root.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
    idle(prefetchRest, { timeout: 6000 });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
