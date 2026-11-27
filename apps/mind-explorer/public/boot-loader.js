/* Kizuki Mind OS - Staged View Chunk Loader
 * Exposes window.KizukiLoader = { ensure(view), preloadAllIdle(), isLoaded(view), getChunkUrl(view), chunkForView(view) }.
 * Loads view-specific bundles on demand with deduplicated Promises and prefetches remaining chunks during idle time.
 */
(function (root) {
  'use strict';

  var DEFAULT_CHUNKS = {
    board: '/bundle/chunk-board.js',
    replay: '/bundle/chunk-replay.js',
    codex: '/bundle/chunk-codex.js',
    taste: '/bundle/chunk-taste.js',
    people: '/bundle/chunk-people.js',
    graph: '/bundle/chunk-graph.js',
  };

  var GLOBAL_PROBES = {
    board: 'KizukiAgentBoardView',
    replay: 'KizukiReplayMap',
    codex: 'KizukiCodexView',
    taste: 'KizukiTasteView',
    people: 'KizukiPersonVisuals',
    graph: 'KizukiGraph',
  };

  var manifest = (root && root.__KIZUKI_CHUNKS__) || {};
  var chunkUrls = Object.assign({}, DEFAULT_CHUNKS, manifest.chunks || {});
  var loaded = new Set(Array.isArray(manifest.loaded) ? manifest.loaded : []);
  var inFlight = new Map();
  var idleScheduled = false;

  function chunkForView(view) {
    if (!view) return null;
    var key = String(view).trim().toLowerCase();
    if (key === 'board' || key === 'agent-board') return 'board';
    if (key === 'codex' || key === 'mind-codex') return 'codex';
    if (key === 'taste' || key === 'taste-studio') return 'taste';
    if (key === 'replay') return 'replay';
    if (key === 'people') return 'people';
    if (key === 'graph') return 'graph';
    return null;
  }

  function isLoaded(view) {
    var chunk = chunkForView(view);
    if (!chunk) return true;
    if (loaded.has(chunk)) return true;
    var probe = GLOBAL_PROBES[chunk];
    if (probe && root && root[probe]) {
      loaded.add(chunk);
      return true;
    }
    return false;
  }

  function getChunkUrl(view) {
    var chunk = chunkForView(view);
    if (!chunk) return null;
    return chunkUrls[chunk] || null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') {
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.defer = false;
      script.dataset.kizukiChunk = src;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error('Failed to load Kizuki chunk: ' + src));
      };
      (document.head || document.body || document.documentElement).appendChild(script);
    });
  }

  function ensure(view) {
    var chunk = chunkForView(view);
    if (!chunk || isLoaded(chunk)) {
      return Promise.resolve(true);
    }
    var existing = inFlight.get(chunk);
    if (existing) {
      return existing;
    }
    var url = chunkUrls[chunk];
    if (!url) {
      return Promise.resolve(false);
    }
    var promise = loadScript(url).then(
      function () {
        loaded.add(chunk);
        inFlight.delete(chunk);
        return true;
      },
      function (err) {
        inFlight.delete(chunk);
        throw err;
      }
    );
    inFlight.set(chunk, promise);
    return promise;
  }

  function scheduleIdleStep(fn) {
    if (typeof root.requestIdleCallback === 'function') {
      root.requestIdleCallback(fn, { timeout: 2500 });
    } else {
      setTimeout(fn, 120);
    }
  }

  function preloadAllIdle() {
    if (idleScheduled) return;
    if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) {
      return;
    }
    idleScheduled = true;
    var order = ['people', 'board', 'codex', 'taste', 'replay', 'graph'];
    var idx = 0;

    function next() {
      while (idx < order.length && isLoaded(order[idx])) {
        idx += 1;
      }
      if (idx >= order.length) return;
      var chunk = order[idx];
      idx += 1;
      ensure(chunk)
        .catch(function () {
          // Non-fatal idle prefetch failure; explicit navigation will retry
        })
        .finally(function () {
          if (idx < order.length) {
            scheduleIdleStep(next);
          }
        });
    }

    scheduleIdleStep(next);
  }

  // Capture nav button clicks before app.js if the target view chunk has not finished loading yet.
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'click',
      function (ev) {
        var target = ev.target;
        if (!target || typeof target.closest !== 'function') return;
        var btn = target.closest('.os-nav-btn[data-view]');
        if (!btn) return;
        var view = btn.getAttribute('data-view');
        var chunk = chunkForView(view);
        if (!chunk || isLoaded(chunk)) return;

        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (btn.getAttribute('data-chunk-loading') === '1') return;
        btn.setAttribute('data-chunk-loading', '1');
        btn.setAttribute('aria-busy', 'true');
        ensure(chunk)
          .then(function () {
            btn.removeAttribute('data-chunk-loading');
            btn.removeAttribute('aria-busy');
            btn.click();
          })
          .catch(function () {
            btn.removeAttribute('data-chunk-loading');
            btn.removeAttribute('aria-busy');
          });
      },
      true
    );
  }

  // Start idle prefetch well after first paint and initial Today hydration settle.
  if (typeof root.addEventListener === 'function') {
    var kickIdle = function () {
      setTimeout(function () {
        preloadAllIdle();
      }, 1500);
    };
    if (typeof document !== 'undefined' && document.readyState === 'complete') {
      kickIdle();
    } else {
      root.addEventListener('load', kickIdle, { once: true });
    }
  }

  root.KizukiLoader = {
    ensure: ensure,
    preloadAllIdle: preloadAllIdle,
    isLoaded: isLoaded,
    getChunkUrl: getChunkUrl,
    chunkForView: chunkForView,
    chunks: Object.assign({}, chunkUrls),
  };
})(typeof window !== 'undefined' ? window : globalThis);
