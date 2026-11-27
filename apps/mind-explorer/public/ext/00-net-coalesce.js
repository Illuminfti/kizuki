/* ==========================================================================
   KIZUKI MIND EXPLORER - SAME-ORIGIN GET /api/* COALESCER & ETAG LAYER
   Loaded first via public/ext/00-net-coalesce.js before /app.js.
   - Coalesces concurrent identical same-origin GET /api/* calls
   - 1.5s micro-cache returning fresh cloned Response objects
   - In-memory ETag -> If-None-Match conditional revalidation (Contract C5)
   - Skips SSE (/stream), non-GET, and ?nocache=1
   - Auto-invalidates stale /api/agent-board/* entries on kizuki:board-sse
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiNetCoalesce = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiNetCoalesce = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function (root) {
    'use strict';

    const DEFAULT_MICRO_CACHE_MS = 1500;
    const DEFAULT_ETAG_TTL_MS = 5 * 60 * 1000;
    const MAX_CACHE_ENTRIES = 200;

    function createCoalescer(opts) {
      const cfg = opts && typeof opts === 'object' ? opts : {};
      const microCacheMs =
        typeof cfg.microCacheMs === 'number' && cfg.microCacheMs >= 0
          ? cfg.microCacheMs
          : DEFAULT_MICRO_CACHE_MS;
      const etagTtlMs =
        typeof cfg.etagTtlMs === 'number' && cfg.etagTtlMs >= 0
          ? cfg.etagTtlMs
          : DEFAULT_ETAG_TTL_MS;
      const maxEntries =
        typeof cfg.maxEntries === 'number' && cfg.maxEntries > 0
          ? cfg.maxEntries
          : MAX_CACHE_ENTRIES;
      const baseOrigin =
        typeof cfg.origin === 'string' && cfg.origin
          ? cfg.origin
          : typeof window !== 'undefined' && window && window.location && window.location.origin
            ? window.location.origin
            : 'http://127.0.0.1:8797';

      const inFlight = new Map();
      const cache = new Map();
      const stats = {
        totalRequests: 0,
        coalescedHits: 0,
        microCacheHits: 0,
        revalidated304Hits: 0,
        networkFetches: 0,
        passthroughs: 0,
      };

      function getNow() {
        return typeof cfg.now === 'function' ? cfg.now() : Date.now();
      }

      function normalizeHeaders(raw) {
        const out = {};
        if (!raw) return out;
        if (typeof Headers !== 'undefined' && raw instanceof Headers) {
          raw.forEach((v, k) => {
            out[k.toLowerCase()] = v;
          });
          return out;
        }
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i += 1) {
            const pair = raw[i];
            if (Array.isArray(pair) && pair.length >= 2) {
              out[String(pair[0]).toLowerCase()] = String(pair[1]);
            }
          }
          return out;
        }
        if (typeof raw === 'object') {
          const keys = Object.keys(raw);
          for (let i = 0; i < keys.length; i += 1) {
            const k = keys[i];
            if (raw[k] !== undefined && raw[k] !== null) {
              out[String(k).toLowerCase()] = String(raw[k]);
            }
          }
        }
        return out;
      }

      function serializeResponseHeaders(res) {
        const pairs = [];
        if (res && res.headers && typeof res.headers.forEach === 'function') {
          res.headers.forEach((v, k) => {
            pairs.push([k, v]);
          });
        }
        return pairs;
      }

      function buildResponse(entry) {
        const hdrs = new Headers();
        const pairs = Array.isArray(entry.headerPairs) ? entry.headerPairs : [];
        for (let i = 0; i < pairs.length; i += 1) {
          try {
            hdrs.append(pairs[i][0], pairs[i][1]);
          } catch {
            // ignore invalid header pairs
          }
        }
        return new Response(entry.bodyText, {
          status: entry.status,
          statusText: entry.statusText || '',
          headers: hdrs,
        });
      }

      function setCacheEntry(key, entry) {
        if (cache.has(key)) {
          cache.delete(key);
        } else if (cache.size >= maxEntries) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) {
            cache.delete(oldestKey);
          }
        }
        cache.set(key, entry);
      }

      function invalidate(key) {
        if (!key) return;
        const existing = cache.get(key);
        if (existing) {
          existing.storedAt = 0;
        }
      }

      function invalidatePrefix(prefix) {
        const clean = String(prefix || '');
        if (!clean) return;
        for (const [key, entry] of cache.entries()) {
          if (key.startsWith(clean)) {
            entry.storedAt = 0;
          }
        }
      }

      function clear() {
        cache.clear();
      }

      function resolveRequest(input, init) {
        let rawUrl = '';
        let method = 'GET';
        let reqHeaders = {};
        let signal = init && init.signal ? init.signal : undefined;
        let cacheMode = init && init.cache ? String(init.cache) : '';

        if (typeof input === 'string') {
          rawUrl = input;
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
          rawUrl = input.toString();
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          rawUrl = input.url;
          if (input.method) method = String(input.method);
          if (input.headers) reqHeaders = normalizeHeaders(input.headers);
          if (!signal && input.signal) signal = input.signal;
          if (!cacheMode && input.cache) cacheMode = String(input.cache);
        }

        if (init && init.method) {
          method = String(init.method);
        }
        if (init && init.headers) {
          reqHeaders = Object.assign(reqHeaders, normalizeHeaders(init.headers));
        }

        method = method.toUpperCase();
        let parsedUrl = null;
        try {
          parsedUrl = new URL(rawUrl, baseOrigin);
        } catch {
          return { eligible: false, method, parsedUrl: null, cacheKey: '', reqHeaders, signal };
        }

        const sameOrigin = parsedUrl.origin === new URL(baseOrigin).origin;
        const pathname = parsedUrl.pathname || '';
        const isApi = pathname.startsWith('/api/');
        const isStream =
          pathname.endsWith('/stream') ||
          pathname.includes('/stream/') ||
          String(reqHeaders.accept || '').toLowerCase().includes('text/event-stream');
        const noCacheParam =
          parsedUrl.searchParams.get('nocache') === '1' ||
          parsedUrl.searchParams.get('nocache') === 'true';
        const noCoalesceHeader =
          reqHeaders['x-kizuki-no-coalesce'] === '1' ||
          reqHeaders['x-kizuki-no-coalesce'] === 'true';

        const cacheKey = `${pathname}${parsedUrl.search}`;
        const eligible =
          sameOrigin &&
          method === 'GET' &&
          isApi &&
          !isStream &&
          !noCacheParam &&
          !noCoalesceHeader &&
          cacheMode !== 'no-store' &&
          !(signal && signal.aborted);

        return {
          eligible,
          sameOrigin,
          isApi,
          method,
          parsedUrl,
          cacheKey,
          reqHeaders,
          signal,
        };
      }

      function invalidateForMutation(pathname) {
        if (!pathname) return;
        if (pathname.startsWith('/api/agent-board/')) {
          invalidatePrefix('/api/agent-board/');
          invalidatePrefix('/api/today');
          invalidatePrefix('/api/decisions');
        } else if (pathname.startsWith('/api/decisions')) {
          invalidatePrefix('/api/decisions');
          invalidatePrefix('/api/agent-board/');
          invalidatePrefix('/api/today');
        } else if (pathname.startsWith('/api/actions') || pathname.startsWith('/api/today')) {
          invalidatePrefix('/api/actions');
          invalidatePrefix('/api/today');
        } else if (pathname.startsWith('/api/people')) {
          invalidatePrefix('/api/people');
        } else if (pathname.startsWith('/api/codex')) {
          invalidatePrefix('/api/codex');
        } else if (pathname.startsWith('/api/taste')) {
          invalidatePrefix('/api/taste');
        } else {
          const parts = pathname.split('/').slice(0, 3).join('/');
          if (parts) invalidatePrefix(parts);
        }
      }

      function wrapFetch(nativeFetch) {
        if (typeof nativeFetch !== 'function') return nativeFetch;

        const wrapped = function coalescedFetch(input, init) {
          stats.totalRequests += 1;
          const info = resolveRequest(input, init);

          if (!info.eligible) {
            stats.passthroughs += 1;
            if (
              info.sameOrigin &&
              info.isApi &&
              info.method !== 'GET' &&
              info.method !== 'HEAD' &&
              info.parsedUrl
            ) {
              invalidateForMutation(info.parsedUrl.pathname);
            }
            return nativeFetch(input, init);
          }

          const key = info.cacheKey;
          const now = getNow();
          const cached = cache.get(key);

          // 1. Fresh 1.5s micro-cache hit
          if (cached && cached.storedAt > 0 && now - cached.storedAt < microCacheMs) {
            stats.microCacheHits += 1;
            return Promise.resolve(buildResponse(cached));
          }

          // 2. Concurrent in-flight dedupe
          const existingFlight = inFlight.get(key);
          if (existingFlight) {
            stats.coalescedHits += 1;
            return existingFlight.then((entry) => buildResponse(entry));
          }

          // 3. Network fetch with optional ETag conditional revalidation (Contract C5)
          const hasReusableEtag =
            cached &&
            cached.etag &&
            cached.bodyText !== undefined &&
            now - cached.etagAt < etagTtlMs;

          let fetchInit = init ? Object.assign({}, init) : {};
          if (hasReusableEtag) {
            const mergedHeaders = new Headers(
              fetchInit.headers || (input && typeof input === 'object' ? input.headers : undefined),
            );
            if (!mergedHeaders.has('If-None-Match')) {
              mergedHeaders.set('If-None-Match', cached.etag);
            }
            fetchInit.headers = mergedHeaders;
          }

          stats.networkFetches += 1;
          const flightPromise = Promise.resolve()
            .then(() => nativeFetch(input, fetchInit))
            .then(async (res) => {
              if (res.status === 304 && hasReusableEtag && cached) {
                stats.revalidated304Hits += 1;
                const updatedPairs = cached.headerPairs.slice();
                const freshEtag = res.headers && res.headers.get('etag');
                if (freshEtag) {
                  cached.etag = freshEtag;
                }
                const ts = getNow();
                cached.storedAt = ts;
                cached.etagAt = ts;
                const entry = {
                  status: cached.status || 200,
                  statusText: cached.statusText || 'OK',
                  headerPairs: updatedPairs,
                  bodyText: cached.bodyText,
                  etag: cached.etag,
                  storedAt: ts,
                  etagAt: ts,
                };
                setCacheEntry(key, entry);
                return entry;
              }

              const bodyText = await res.text();
              const headerPairs = serializeResponseHeaders(res);
              const etag = (res.headers && res.headers.get('etag')) || null;
              const ts = getNow();
              const entry = {
                status: res.status,
                statusText: res.statusText || '',
                headerPairs,
                bodyText,
                etag,
                storedAt: res.ok ? ts : 0,
                etagAt: res.ok && etag ? ts : 0,
              };
              if (res.ok) {
                setCacheEntry(key, entry);
              }
              return entry;
            })
            .finally(() => {
              if (inFlight.get(key) === flightPromise) {
                inFlight.delete(key);
              }
            });

          inFlight.set(key, flightPromise);
          return flightPromise.then((entry) => buildResponse(entry));
        };

        wrapped.__kizukiNetCoalesced = true;
        return wrapped;
      }

      return {
        wrapFetch,
        invalidate,
        invalidatePrefix,
        clear,
        getStats: () => Object.assign({}, stats, { cacheSize: cache.size, inFlight: inFlight.size }),
      };
    }

    function emitBoardSse(detail) {
      const target =
        typeof window !== 'undefined' && window
          ? window
          : root && typeof root.dispatchEvent === 'function'
            ? root
            : null;
      if (!target || typeof target.dispatchEvent !== 'function') return false;
      const EventCtor =
        (target && target.CustomEvent) ||
        (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (!EventCtor) return false;
      target.dispatchEvent(new EventCtor('kizuki:board-sse', { detail: detail || {} }));
      return true;
    }

    const defaultInstance = createCoalescer();

    function install(targetWin) {
      const w =
        targetWin ||
        (typeof window !== 'undefined' && window ? window : null);
      if (!w || typeof w.fetch !== 'function') return false;
      if (w.fetch.__kizukiNetCoalesced) return true;
      const nativeFetch = w.fetch.bind(w);
      w.fetch = defaultInstance.wrapFetch(nativeFetch);
      if (typeof w.addEventListener === 'function' && !w.__kizukiNetCoalesceSseBound) {
        w.__kizukiNetCoalesceSseBound = true;
        w.addEventListener('kizuki:board-sse', (ev) => {
          const kind = String((ev && ev.detail && ev.detail.kind) || '').toLowerCase();
          if (kind === 'board' || kind === 'action' || kind === 'message') {
            defaultInstance.invalidatePrefix('/api/agent-board/');
          } else if (kind === 'telemetry') {
            defaultInstance.invalidate('/api/agent-board/health');
            defaultInstance.invalidate('/api/agent-board/agents');
          }
        });
      }
      return true;
    }

    // Auto-install in browser environments
    if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') {
      install(window);
    }

    return {
      createCoalescer,
      install,
      invalidate: defaultInstance.invalidate,
      invalidatePrefix: defaultInstance.invalidatePrefix,
      clear: defaultInstance.clear,
      getStats: defaultInstance.getStats,
      emitBoardSse,
    };
  },
);
