/* ==========================================================================
   KIZUKI MIND EXPLORER - @ui-sdk/core BEHAVIORAL PRIMITIVES ENGINE
   Zero-dependency browser + CommonJS implementation of composable headless
   UI primitives inspired by Vercel Labs @ui-sdk/core (vercel-labs/ui).

   Exports: window.KizukiUiSdk (and module.exports in CommonJS / Node)
   Primitives:
     1. createStore         - Minimal reactive store with diff-gated updates & batching
     2. definePrimitive     - Declarative slot-based headless primitive factory
     3. createSelection     - Roving keyboard selection & aria-activedescendant
     4. createTypeahead     - Sub-ms prefix + boundary + subsequence fuzzy scorer
     5. createPopup         - Viewport-clamped floating popup with auto-flip & ARIA
     6. createFocusRecovery - Safe focus capture & restoration with fallback
     7. createDismissable   - Composable LIFO Escape & outside-click dismissal stack
   ========================================================================== */
(function initKizukiUiSdk(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiUiSdk = api;
  }
  if (typeof window !== 'undefined' && window !== root) {
    window.KizukiUiSdk = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function createKizukiUiSdk(root) {
    'use strict';

    let uidCounter = 0;

    function nextId(prefix) {
      uidCounter += 1;
      return (prefix || 'ui-sdk') + '-' + uidCounter;
    }

    function getDocument(explicitDoc, el) {
      if (explicitDoc) return explicitDoc;
      if (el && el.ownerDocument) return el.ownerDocument;
      if (typeof document !== 'undefined') return document;
      if (root && root.document) return root.document;
      return null;
    }

    function getWindow(explicitDoc, el) {
      const doc = getDocument(explicitDoc, el);
      if (doc && doc.defaultView) return doc.defaultView;
      if (typeof window !== 'undefined') return window;
      if (root && root.window) return root.window;
      return root || null;
    }

    function isPlainObject(val) {
      if (val === null || typeof val !== 'object') return false;
      const proto = Object.getPrototypeOf(val);
      return proto === Object.prototype || proto === null;
    }

    function isElement(val) {
      return Boolean(
        val &&
          typeof val === 'object' &&
          (typeof val.setAttribute === 'function' || val.nodeType === 1)
      );
    }

    function isConnectedEl(el) {
      if (!el) return false;
      if (typeof el.isConnected === 'boolean') return el.isConnected;
      const doc = el.ownerDocument || getDocument(null, el);
      if (doc && doc.documentElement && typeof doc.documentElement.contains === 'function') {
        return doc.documentElement.contains(el);
      }
      return true;
    }

    function isDisabledEl(el) {
      if (!el) return true;
      if (el.disabled === true) return true;
      if (typeof el.getAttribute === 'function') {
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('data-disabled') !== null && el.getAttribute('data-disabled') !== 'false') {
          return true;
        }
      }
      return false;
    }

    function isHiddenEl(el) {
      if (!el) return true;
      if (el.hidden === true) return true;
      if (typeof el.getAttribute === 'function') {
        const h = el.getAttribute('hidden');
        if (h !== null && h !== 'false') return true;
      }
      return false;
    }

    function addListener(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return function noop() {};
      }
      target.addEventListener(type, handler, options);
      let active = true;
      return function remove() {
        if (!active) return;
        active = false;
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, handler, options);
        }
      };
    }

    function ensureId(el, prefix) {
      if (!el) return '';
      if (el.id) return el.id;
      const existing = typeof el.getAttribute === 'function' ? el.getAttribute('id') : '';
      if (existing) return existing;
      const generated = nextId(prefix);
      if (typeof el.setAttribute === 'function') {
        el.setAttribute('id', generated);
      } else {
        el.id = generated;
      }
      return generated;
    }

    function toElementArray(input, rootEl) {
      if (!input) return [];
      const resolved = typeof input === 'function' ? input() : input;
      if (!resolved) return [];
      if (typeof resolved === 'string') {
        const scope = rootEl || getDocument();
        if (scope && typeof scope.querySelectorAll === 'function') {
          return Array.from(scope.querySelectorAll(resolved)).filter(isElement);
        }
        return [];
      }
      if (isElement(resolved)) return [resolved];
      if (typeof resolved.length === 'number') {
        return Array.from(resolved).filter(isElement);
      }
      return [];
    }

    function isEventInside(event, el) {
      if (!el || !event) return false;
      const target = event.target;
      if (target === el) return true;
      if (typeof el.contains === 'function' && target) {
        try {
          if (el.contains(target)) return true;
        } catch (_err) {
          // Ignore non-Node targets
        }
      }
      if (typeof event.composedPath === 'function') {
        const path = event.composedPath();
        if (Array.isArray(path) && path.indexOf(el) !== -1) {
          return true;
        }
      }
      return false;
    }

    function serializeAttrValue(key, rawValue) {
      if (rawValue === null || rawValue === undefined) {
        return null;
      }
      if (typeof rawValue === 'boolean') {
        if (key.indexOf('aria-') === 0) {
          return rawValue ? 'true' : 'false';
        }
        if (key.indexOf('data-') === 0) {
          return rawValue ? 'true' : null;
        }
        return rawValue ? '' : null;
      }
      return String(rawValue);
    }

    function applyAttributeDiff(el, nextAttrs, cacheMap) {
      if (!el || typeof el.setAttribute !== 'function') return;
      const nextKeys = Object.create(null);
      if (nextAttrs && typeof nextAttrs === 'object') {
        const keys = Object.keys(nextAttrs);
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          nextKeys[key] = true;
          const serialized = serializeAttrValue(key, nextAttrs[key]);
          const prev = cacheMap.has(key) ? cacheMap.get(key) : undefined;
          if (prev === serialized) continue;

          if (serialized === null) {
            if (typeof el.removeAttribute === 'function') {
              el.removeAttribute(key);
            }
            if (key === 'hidden') {
              try {
                el.hidden = false;
              } catch (_err) {}
            }
            cacheMap.delete(key);
          } else {
            el.setAttribute(key, serialized);
            if (key === 'hidden') {
              try {
                el.hidden = true;
              } catch (_err) {}
            }
            cacheMap.set(key, serialized);
          }
        }
      }

      // Remove attributes previously managed by this slot that are no longer present
      const prevKeys = Array.from(cacheMap.keys());
      for (let i = 0; i < prevKeys.length; i += 1) {
        const key = prevKeys[i];
        if (!nextKeys[key]) {
          if (typeof el.removeAttribute === 'function') {
            el.removeAttribute(key);
          }
          if (key === 'hidden') {
            try {
              el.hidden = false;
            } catch (_err) {}
          }
          cacheMap.delete(key);
        }
      }
    }

    /* ========================================================================
       1. createStore(initialState)
       Minimal reactive store with shallow diff gating and batch coalescing.
       ======================================================================== */
    function createStore(initialState) {
      const seed = isPlainObject(initialState)
        ? Object.assign({}, initialState)
        : initialState;
      let state = isPlainObject(seed) ? Object.assign({}, seed) : seed;

      const listeners = new Set();
      let batchDepth = 0;
      let flushing = false;
      let dirty = false;
      let batchPrevState = state;
      let batchChangedKeys = new Set();

      function get() {
        return state;
      }

      function emitPending() {
        if (flushing || batchDepth > 0 || !dirty) return;
        flushing = true;
        let guard = 0;
        try {
          while (dirty && guard < 32) {
            guard += 1;
            const nextState = state;
            const prevState = batchPrevState;
            const changed = Array.from(batchChangedKeys);
            dirty = false;
            batchPrevState = nextState;
            batchChangedKeys = new Set();

            const snapshot = Array.from(listeners);
            for (let i = 0; i < snapshot.length; i += 1) {
              if (listeners.has(snapshot[i])) {
                snapshot[i](nextState, prevState, changed);
              }
            }
          }
        } finally {
          flushing = false;
        }
      }

      function set(patchOrFn) {
        const prev = state;
        const patch = typeof patchOrFn === 'function' ? patchOrFn(prev) : patchOrFn;

        if (patch === undefined || patch === null || Object.is(patch, prev)) {
          return state;
        }

        if (isPlainObject(prev) && isPlainObject(patch)) {
          const patchKeys = Object.keys(patch);
          let hasDiff = false;
          const diffKeys = [];

          for (let i = 0; i < patchKeys.length; i += 1) {
            const key = patchKeys[i];
            if (!Object.prototype.hasOwnProperty.call(prev, key) || !Object.is(prev[key], patch[key])) {
              hasDiff = true;
              diffKeys.push(key);
            }
          }

          if (!hasDiff) {
            return state;
          }

          const next = Object.assign({}, prev, patch);
          if (!dirty) {
            batchPrevState = prev;
          }
          state = next;
          for (let i = 0; i < diffKeys.length; i += 1) {
            batchChangedKeys.add(diffKeys[i]);
          }
          dirty = true;
        } else {
          if (Object.is(prev, patch)) {
            return state;
          }
          if (!dirty) {
            batchPrevState = prev;
          }
          state = patch;
          dirty = true;
        }

        emitPending();
        return state;
      }

      function batch(fn) {
        if (typeof fn !== 'function') return undefined;
        batchDepth += 1;
        try {
          return fn();
        } finally {
          batchDepth -= 1;
          if (batchDepth === 0) {
            emitPending();
          }
        }
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') {
          return function noop() {};
        }
        listeners.add(listener);
        let active = true;
        return function unsubscribe() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        };
      }

      function reset() {
        const nextSeed = isPlainObject(seed) ? Object.assign({}, seed) : seed;
        return set(nextSeed);
      }

      return {
        get,
        set,
        subscribe,
        batch,
        reset,
      };
    }

    /* ========================================================================
       6. createFocusRecovery({ fallback })
       Captures activeElement before popup/re-render and restores safely.
       ======================================================================== */
    function createFocusRecovery(options) {
      const opts = options || {};
      const explicitDoc = opts.doc || null;
      let capturedEl = null;

      function isBodyOrRoot(el, doc) {
        if (!el) return true;
        if (doc && (el === doc.body || el === doc.documentElement)) return true;
        const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
        return tag === 'BODY' || tag === 'HTML';
      }

      function canFocus(el, doc) {
        if (!el || typeof el.focus !== 'function') return false;
        if (isBodyOrRoot(el, doc)) return false;
        if (!isConnectedEl(el)) return false;
        if (isDisabledEl(el)) return false;
        if (isHiddenEl(el)) return false;
        return true;
      }

      function resolveCandidate(source, doc) {
        if (!source) return null;
        const val = typeof source === 'function' ? source() : source;
        if (!val) return null;
        if (typeof val === 'string') {
          return doc && typeof doc.querySelector === 'function'
            ? doc.querySelector(val)
            : null;
        }
        return val;
      }

      function capture(explicitEl) {
        const doc = getDocument(explicitDoc, explicitEl);
        const target = explicitEl !== undefined ? explicitEl : doc ? doc.activeElement : null;
        if (canFocus(target, doc)) {
          capturedEl = target;
        } else {
          capturedEl = null;
        }
        return capturedEl;
      }

      function isStranded(withinEl) {
        const doc = getDocument(explicitDoc, withinEl || capturedEl);
        const active = doc ? doc.activeElement : null;
        if (!active || isBodyOrRoot(active, doc) || !isConnectedEl(active)) {
          return true;
        }
        if (withinEl && (active === withinEl || (typeof withinEl.contains === 'function' && withinEl.contains(active)))) {
          return true;
        }
        return false;
      }

      function restore(restoreOpts) {
        const rOpts = restoreOpts || {};
        const doc = getDocument(explicitDoc, capturedEl);

        if (rOpts.onlyIfStranded && !isStranded(rOpts.withinEl)) {
          if (rOpts.clear !== false) capturedEl = null;
          return { restored: false, element: null, reason: 'focus-elsewhere' };
        }

        let target = null;
        if (canFocus(capturedEl, doc)) {
          target = capturedEl;
        } else {
          const overrideFb = resolveCandidate(rOpts.fallback, doc);
          if (canFocus(overrideFb, doc)) {
            target = overrideFb;
          } else {
            const defaultFb = resolveCandidate(opts.fallback, doc);
            if (canFocus(defaultFb, doc)) {
              target = defaultFb;
            }
          }
        }

        if (rOpts.clear !== false) {
          capturedEl = null;
        }

        if (!target) {
          return { restored: false, element: null, reason: 'no-focusable-target' };
        }

        const preventScroll = rOpts.preventScroll !== false;
        try {
          target.focus({ preventScroll });
        } catch (_err) {
          target.focus();
        }
        return { restored: true, element: target };
      }

      function getCaptured() {
        return capturedEl;
      }

      function clear() {
        capturedEl = null;
      }

      function destroy() {
        capturedEl = null;
      }

      return {
        capture,
        restore,
        isStranded,
        getCaptured,
        clear,
        destroy,
      };
    }

    /* ========================================================================
       7. createDismissable({ el, ignoreEls?, onDismiss })
       Composable LIFO Escape & outside-click dismissal stack per document.
       ======================================================================== */
    const dismissHostMap = new WeakMap();

    function getDismissHost(doc) {
      let host = dismissHostMap.get(doc);
      if (host) return host;

      host = {
        entries: [],
        cleanups: [],
        lastPointerDownTarget: null,
        lastPointerDownAt: 0,
      };
      dismissHostMap.set(doc, host);
      return host;
    }

    function attachDismissListeners(doc, host) {
      if (host.cleanups.length > 0) return;

      function handleKeyDown(event) {
        if (!event || event.key !== 'Escape') return;
        if (host.entries.length === 0) return;
        const top = host.entries[host.entries.length - 1];
        if (!top || !top.active) return;
        if (!top.closeOnEscape) return;

        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (typeof top.onDismiss === 'function') {
          top.onDismiss('escape', event);
        }
      }

      function handleOutsidePointer(event, sourceType) {
        if (!event || host.entries.length === 0) return;

        // Deduplicate synthetic mousedown immediately following pointerdown
        const now = Date.now();
        if (sourceType === 'pointerdown') {
          host.lastPointerDownTarget = event.target || null;
          host.lastPointerDownAt = now;
        } else if (
          sourceType === 'mousedown' &&
          host.lastPointerDownTarget === (event.target || null) &&
          now - host.lastPointerDownAt < 40
        ) {
          return;
        }

        const top = host.entries[host.entries.length - 1];
        if (!top || !top.active || !top.closeOnOutsideClick) return;

        const el = typeof top.getEl === 'function' ? top.getEl() : top.el;
        if (el && isEventInside(event, el)) return;

        const ignores = toElementArray(top.ignoreEls, doc);
        for (let i = 0; i < ignores.length; i += 1) {
          if (isEventInside(event, ignores[i])) return;
        }

        if (typeof top.onDismiss === 'function') {
          top.onDismiss('outside-click', event);
        }
      }

      host.cleanups.push(
        addListener(doc, 'keydown', handleKeyDown, true),
        addListener(
          doc,
          'pointerdown',
          function onPD(e) {
            handleOutsidePointer(e, 'pointerdown');
          },
          true
        ),
        addListener(
          doc,
          'mousedown',
          function onMD(e) {
            handleOutsidePointer(e, 'mousedown');
          },
          true
        )
      );
    }

    function detachDismissListenersIfEmpty(doc, host) {
      if (host.entries.length > 0) return;
      while (host.cleanups.length > 0) {
        const fn = host.cleanups.pop();
        fn();
      }
      host.lastPointerDownTarget = null;
      host.lastPointerDownAt = 0;
    }

    function createDismissable(options) {
      const opts = options || {};
      const elOption = opts.el;
      const doc = getDocument(opts.doc, typeof elOption === 'function' ? elOption() : elOption);
      const entry = {
        el: typeof elOption === 'function' ? null : elOption || null,
        getEl: typeof elOption === 'function' ? elOption : null,
        ignoreEls: opts.ignoreEls || null,
        onDismiss: opts.onDismiss || null,
        closeOnEscape: opts.closeOnEscape !== false,
        closeOnOutsideClick: opts.closeOnOutsideClick !== false,
        active: false,
        destroyed: false,
      };

      function activate() {
        if (entry.destroyed || !doc) return false;
        const host = getDismissHost(doc);
        const idx = host.entries.indexOf(entry);
        if (idx !== -1) {
          host.entries.splice(idx, 1);
        }
        host.entries.push(entry);
        entry.active = true;
        attachDismissListeners(doc, host);
        return true;
      }

      function deactivate() {
        if (!doc) {
          entry.active = false;
          return;
        }
        const host = dismissHostMap.get(doc);
        if (host) {
          const idx = host.entries.indexOf(entry);
          if (idx !== -1) {
            host.entries.splice(idx, 1);
          }
          detachDismissListenersIfEmpty(doc, host);
        }
        entry.active = false;
      }

      function isActive() {
        return entry.active;
      }

      function isTopmost() {
        if (!entry.active || !doc) return false;
        const host = dismissHostMap.get(doc);
        if (!host || host.entries.length === 0) return false;
        return host.entries[host.entries.length - 1] === entry;
      }

      function bringToFront() {
        if (entry.destroyed) return false;
        return activate();
      }

      function destroy() {
        if (entry.destroyed) return;
        deactivate();
        entry.destroyed = true;
      }

      if (opts.enabled !== false) {
        activate();
      }

      return {
        activate,
        deactivate,
        isActive,
        isTopmost,
        bringToFront,
        destroy,
      };
    }

    function getDismissStackSize(explicitDoc) {
      const doc = getDocument(explicitDoc);
      if (!doc) return 0;
      const host = dismissHostMap.get(doc);
      return host ? host.entries.length : 0;
    }

    /* ========================================================================
       3. createSelection({ getItems, loop, orientation, onSelect, onActiveChange })
       Headless keyboard selection, roving active index, and ARIA state.
       ======================================================================== */
    function createSelection(options) {
      const opts = options || {};
      const loop = opts.loop !== false;
      const orientation = opts.orientation || 'vertical';
      const selectOnSpace = opts.selectOnSpace !== false;
      const idPrefix = opts.idPrefix || 'ui-sdk-option';

      let activeIndex = typeof opts.initialIndex === 'number' ? opts.initialIndex : -1;
      let destroyed = false;
      const ariaTargets = new Set();
      const cleanups = [];

      if (opts.ariaTarget) ariaTargets.add(opts.ariaTarget);
      if (opts.containerEl) ariaTargets.add(opts.containerEl);
      if (opts.inputEl) ariaTargets.add(opts.inputEl);

      function resolveItems() {
        const raw = typeof opts.getItems === 'function' ? opts.getItems() : opts.getItems;
        if (!raw) return [];
        return Array.from(raw).filter(isElement);
      }

      function findEnabledIndex(items, start, step) {
        const len = items.length;
        if (len === 0) return -1;

        if (loop) {
          for (let offset = 0; offset < len; offset += 1) {
            const idx = (((start + offset * step) % len) + len) % len;
            if (!isDisabledEl(items[idx])) return idx;
          }
          return -1;
        }

        for (let idx = start; idx >= 0 && idx < len; idx += step) {
          if (!isDisabledEl(items[idx])) return idx;
        }
        return -1;
      }

      function syncDom(items, scrollActive) {
        let activeEl = null;

        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const isActive = i === activeIndex && !isDisabledEl(item);

          if (isActive) {
            activeEl = item;
            ensureId(item, idPrefix);
            if (typeof item.setAttribute === 'function') {
              item.setAttribute('aria-selected', 'true');
              item.setAttribute('data-active', 'true');
            }
            if (scrollActive && typeof item.scrollIntoView === 'function') {
              try {
                item.scrollIntoView({ block: 'nearest' });
              } catch (_err) {
                item.scrollIntoView();
              }
            }
          } else if (typeof item.setAttribute === 'function') {
            item.setAttribute('aria-selected', 'false');
            if (typeof item.removeAttribute === 'function') {
              item.removeAttribute('data-active');
            }
          }
        }

        const descendantId = activeEl ? activeEl.id || (typeof activeEl.getAttribute === 'function' ? activeEl.getAttribute('id') : '') : '';
        ariaTargets.forEach(function updateTarget(target) {
          if (!target || typeof target.setAttribute !== 'function') return;
          if (descendantId) {
            target.setAttribute('aria-activedescendant', descendantId);
          } else if (typeof target.removeAttribute === 'function') {
            target.removeAttribute('aria-activedescendant');
          }
        });

        return activeEl;
      }

      function setActiveIndex(nextIndex, setOpts) {
        if (destroyed) return -1;
        const sOpts = setOpts || {};
        const items = resolveItems();
        const prevIndex = activeIndex;

        if (items.length === 0 || nextIndex < 0 || nextIndex >= items.length) {
          activeIndex = -1;
        } else if (isDisabledEl(items[nextIndex])) {
          const fallback = findEnabledIndex(items, nextIndex, 1);
          activeIndex = fallback;
        } else {
          activeIndex = nextIndex;
        }

        const activeEl = syncDom(items, sOpts.scroll !== false);

        if (!sOpts.silent && activeIndex !== prevIndex && typeof opts.onActiveChange === 'function') {
          opts.onActiveChange(activeEl, activeIndex, prevIndex);
        }
        return activeIndex;
      }

      function moveNext() {
        const items = resolveItems();
        if (items.length === 0) return setActiveIndex(-1);
        const start = activeIndex < 0 ? 0 : activeIndex + 1;
        if (!loop && start >= items.length) {
          return activeIndex;
        }
        const next = findEnabledIndex(items, start, 1);
        return next === -1 ? activeIndex : setActiveIndex(next);
      }

      function movePrev() {
        const items = resolveItems();
        if (items.length === 0) return setActiveIndex(-1);
        const start = activeIndex < 0 ? (loop ? items.length - 1 : 0) : activeIndex - 1;
        if (!loop && start < 0) {
          return activeIndex;
        }
        const prev = findEnabledIndex(items, start, -1);
        return prev === -1 ? activeIndex : setActiveIndex(prev);
      }

      function moveFirst() {
        const items = resolveItems();
        if (items.length === 0) return setActiveIndex(-1);
        const first = findEnabledIndex(items, 0, 1);
        return setActiveIndex(first);
      }

      function moveLast() {
        const items = resolveItems();
        if (items.length === 0) return setActiveIndex(-1);
        const last = findEnabledIndex(items, items.length - 1, -1);
        return setActiveIndex(last);
      }

      function selectActive(event) {
        if (destroyed) return null;
        const items = resolveItems();
        if (activeIndex < 0 || activeIndex >= items.length) return null;
        const item = items[activeIndex];
        if (!item || isDisabledEl(item)) return null;
        if (typeof opts.onSelect === 'function') {
          opts.onSelect(item, activeIndex, event || null);
        }
        return item;
      }

      function handleKeyDown(event) {
        if (destroyed || !event) return false;
        const key = event.key;
        const isVertical = orientation === 'vertical' || orientation === 'both';
        const isHorizontal = orientation === 'horizontal' || orientation === 'both';

        if ((isVertical && key === 'ArrowDown') || (isHorizontal && key === 'ArrowRight')) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          moveNext();
          return true;
        }

        if ((isVertical && key === 'ArrowUp') || (isHorizontal && key === 'ArrowLeft')) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          movePrev();
          return true;
        }

        if (key === 'Home') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          moveFirst();
          return true;
        }

        if (key === 'End') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          moveLast();
          return true;
        }

        if (key === 'Enter' || (selectOnSpace && (key === ' ' || key === 'Spacebar'))) {
          const items = resolveItems();
          if (activeIndex >= 0 && activeIndex < items.length && !isDisabledEl(items[activeIndex])) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            selectActive(event);
            return true;
          }
        }

        return false;
      }

      function sync(syncOpts) {
        if (destroyed) return -1;
        const items = resolveItems();
        if (activeIndex >= items.length) {
          activeIndex = items.length > 0 ? findEnabledIndex(items, items.length - 1, -1) : -1;
        } else if (activeIndex >= 0 && isDisabledEl(items[activeIndex])) {
          activeIndex = findEnabledIndex(items, activeIndex, 1);
        }
        syncDom(items, Boolean(syncOpts && syncOpts.scroll));
        return activeIndex;
      }

      function reset() {
        return setActiveIndex(-1, { scroll: false });
      }

      function getActiveIndex() {
        return activeIndex;
      }

      function getActiveItem() {
        const items = resolveItems();
        return activeIndex >= 0 && activeIndex < items.length ? items[activeIndex] : null;
      }

      function attach(targetEl) {
        if (!targetEl) return function noop() {};
        ariaTargets.add(targetEl);
        const removeKey = addListener(targetEl, 'keydown', handleKeyDown);
        sync({ scroll: false });

        let active = true;
        function detach() {
          if (!active) return;
          active = false;
          removeKey();
          ariaTargets.delete(targetEl);
          if (typeof targetEl.removeAttribute === 'function') {
            targetEl.removeAttribute('aria-activedescendant');
          }
        }
        cleanups.push(detach);
        return detach;
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        while (cleanups.length > 0) {
          const fn = cleanups.pop();
          fn();
        }
        ariaTargets.forEach(function clearTarget(target) {
          if (target && typeof target.removeAttribute === 'function') {
            target.removeAttribute('aria-activedescendant');
          }
        });
        ariaTargets.clear();
        activeIndex = -1;
      }

      if (activeIndex >= 0) {
        sync({ scroll: false });
      }

      return {
        getActiveIndex,
        getActiveItem,
        setActiveIndex,
        moveNext,
        movePrev,
        moveFirst,
        moveLast,
        selectActive,
        handleKeyDown,
        sync,
        reset,
        attach,
        destroy,
      };
    }

    /* ========================================================================
       4. createTypeahead({ getItems, getLabel, onFilter })
       Sub-millisecond prefix + word-boundary + subsequence fuzzy scorer.
       ======================================================================== */
    function isBoundaryChar(ch) {
      return (
        ch === '/' ||
        ch === '-' ||
        ch === '_' ||
        ch === '.' ||
        ch === ':' ||
        ch === '@' ||
        ch === ' ' ||
        ch === '#'
      );
    }

    function isBoundaryAt(label, idx) {
      if (idx === 0) return true;
      const prev = label.charCodeAt(idx - 1);
      const curr = label.charCodeAt(idx);
      if (isBoundaryChar(label.charAt(idx - 1))) return true;
      // camelCase boundary (lowercase followed by uppercase)
      if (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90) return true;
      return false;
    }

    function mergeIndicesToRanges(indices) {
      if (!indices || indices.length === 0) return [];
      const ranges = [];
      let start = indices[0];
      let end = start + 1;
      for (let i = 1; i < indices.length; i += 1) {
        const idx = indices[i];
        if (idx === end) {
          end += 1;
        } else {
          ranges.push([start, end]);
          start = idx;
          end = idx + 1;
        }
      }
      ranges.push([start, end]);
      return ranges;
    }

    function scoreFuzzyLabel(rawLabel, rawQuery) {
      const label = String(rawLabel == null ? '' : rawLabel);
      const query = String(rawQuery == null ? '' : rawQuery).trim();

      if (!query) {
        return { matched: true, score: 0, ranges: [], matchType: 'all' };
      }

      const labelLower = label.toLowerCase();
      const queryLower = query.toLowerCase();
      const qLen = queryLower.length;
      const lLen = labelLower.length;

      if (qLen > lLen) {
        return { matched: false, score: -1, ranges: [], matchType: 'none' };
      }

      // 1. Exact case-insensitive match
      if (labelLower === queryLower) {
        return {
          matched: true,
          score: 1000,
          ranges: [[0, lLen]],
          matchType: 'exact',
        };
      }

      // 2. Exact prefix match
      if (labelLower.indexOf(queryLower) === 0) {
        const compactness = Math.round((qLen / lLen) * 80);
        return {
          matched: true,
          score: 850 + compactness,
          ranges: [[0, qLen]],
          matchType: 'prefix',
        };
      }

      // 3. Handle-stripped prefix match (e.g. query "cl" against "@claude")
      if (
        (labelLower.charAt(0) === '@' || labelLower.charAt(0) === '#') &&
        queryLower.charAt(0) !== labelLower.charAt(0) &&
        labelLower.indexOf(queryLower, 1) === 1
      ) {
        const compactness = Math.round((qLen / lLen) * 75);
        return {
          matched: true,
          score: 820 + compactness,
          ranges: [[1, 1 + qLen]],
          matchType: 'handle-prefix',
        };
      }

      // 4. Word/segment boundary substring match (e.g. "dec" in "kizuki/decisions")
      let searchFrom = 0;
      let bestBoundaryIdx = -1;
      while (searchFrom <= lLen - qLen) {
        const hit = labelLower.indexOf(queryLower, searchFrom);
        if (hit === -1) break;
        if (isBoundaryAt(label, hit)) {
          bestBoundaryIdx = hit;
          break;
        }
        searchFrom = hit + 1;
      }

      if (bestBoundaryIdx !== -1) {
        const compactness = Math.round((qLen / lLen) * 60);
        const posPenalty = Math.min(bestBoundaryIdx * 2, 40);
        return {
          matched: true,
          score: 680 + compactness - posPenalty,
          ranges: [[bestBoundaryIdx, bestBoundaryIdx + qLen]],
          matchType: 'boundary-prefix',
        };
      }

      // 5. Contiguous substring match anywhere
      const subIdx = labelLower.indexOf(queryLower);
      if (subIdx !== -1) {
        const compactness = Math.round((qLen / lLen) * 50);
        const posPenalty = Math.min(subIdx * 2, 50);
        return {
          matched: true,
          score: 520 + compactness - posPenalty,
          ranges: [[subIdx, subIdx + qLen]],
          matchType: 'substring',
        };
      }

      // 6. Fast-path O(N) subsequence existence check
      let qi = 0;
      for (let li = 0; li < lLen && qi < qLen; li += 1) {
        if (labelLower.charCodeAt(li) === queryLower.charCodeAt(qi)) {
          qi += 1;
        }
      }
      if (qi < qLen) {
        return { matched: false, score: -1, ranges: [], matchType: 'none' };
      }

      // 7. Boundary-preferring subsequence alignment
      // Try matching starting from each occurrence of queryLower[0], preferring
      // boundary starts and consecutive character runs.
      let bestScore = -Infinity;
      let bestIndices = null;

      for (let startPos = 0; startPos < lLen; startPos += 1) {
        if (labelLower.charCodeAt(startPos) !== queryLower.charCodeAt(0)) continue;

        const indices = [startPos];
        let li = startPos + 1;
        let qIdx = 1;
        let localScore = isBoundaryAt(label, startPos) ? 26 : 8;
        let prevIdx = startPos;

        while (qIdx < qLen && li < lLen) {
          const targetCode = queryLower.charCodeAt(qIdx);
          // Look ahead for a boundary match of targetCode if one exists before remaining chars run out
          let chosen = -1;
          let firstHit = -1;
          for (let scan = li; scan < lLen; scan += 1) {
            if (labelLower.charCodeAt(scan) === targetCode) {
              if (firstHit === -1) firstHit = scan;
              if (scan === prevIdx + 1 || isBoundaryAt(label, scan)) {
                chosen = scan;
                break;
              }
            }
          }
          if (chosen === -1) chosen = firstHit;
          if (chosen === -1) break;

          indices.push(chosen);
          if (chosen === prevIdx + 1) {
            localScore += 22;
          } else if (isBoundaryAt(label, chosen)) {
            localScore += 18;
          } else {
            localScore += 4;
          }
          localScore -= Math.min(chosen - prevIdx - 1, 8);
          prevIdx = chosen;
          li = chosen + 1;
          qIdx += 1;
        }

        if (qIdx === qLen) {
          const span = indices[qLen - 1] - indices[0] + 1;
          const densityBonus = Math.round((qLen / span) * 40);
          const lengthPenalty = Math.min(lLen - qLen, 30);
          const total = 220 + localScore + densityBonus - lengthPenalty - Math.min(startPos, 20);
          if (total > bestScore) {
            bestScore = total;
            bestIndices = indices;
          }
        }
      }

      if (!bestIndices) {
        return { matched: false, score: -1, ranges: [], matchType: 'none' };
      }

      return {
        matched: true,
        score: Math.max(1, bestScore),
        ranges: mergeIndicesToRanges(bestIndices),
        matchType: 'subsequence',
      };
    }

    function splitMatchRanges(label, ranges) {
      const text = String(label == null ? '' : label);
      if (!ranges || ranges.length === 0) {
        return text ? [{ text, matched: false }] : [];
      }
      const parts = [];
      let cursor = 0;
      for (let i = 0; i < ranges.length; i += 1) {
        const start = ranges[i][0];
        const end = ranges[i][1];
        if (start > cursor) {
          parts.push({ text: text.slice(cursor, start), matched: false });
        }
        if (end > start) {
          parts.push({ text: text.slice(start, end), matched: true });
        }
        cursor = Math.max(cursor, end);
      }
      if (cursor < text.length) {
        parts.push({ text: text.slice(cursor), matched: false });
      }
      return parts;
    }

    function createTypeahead(options) {
      const opts = options || {};
      const getItems = typeof opts.getItems === 'function' ? opts.getItems : function () {
        return Array.isArray(opts.getItems) ? opts.getItems : [];
      };
      const getLabel = typeof opts.getLabel === 'function'
        ? opts.getLabel
        : function defaultGetLabel(item) {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              return String(item.label || item.name || item.id || '');
            }
            return String(item == null ? '' : item);
          };
      const getKeywords = typeof opts.getKeywords === 'function' ? opts.getKeywords : null;
      const maxResults = typeof opts.maxResults === 'number' && opts.maxResults > 0 ? opts.maxResults : 0;

      let lastQuery = '';
      let lastResults = [];
      let destroyed = false;

      function filter(query) {
        if (destroyed) return [];
        const q = String(query == null ? '' : query);
        lastQuery = q;
        const items = getItems() || [];
        const trimmed = q.trim();
        const scored = [];

        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const label = String(getLabel(item) || '');

          if (!trimmed) {
            scored.push({
              item,
              label,
              score: 0,
              ranges: [],
              matchType: 'all',
              index: i,
            });
            continue;
          }

          let res = scoreFuzzyLabel(label, trimmed);
          if (!res.matched && getKeywords) {
            const keywords = getKeywords(item) || [];
            let bestKw = null;
            for (let k = 0; k < keywords.length; k += 1) {
              const kwRes = scoreFuzzyLabel(keywords[k], trimmed);
              if (kwRes.matched && (!bestKw || kwRes.score > bestKw.score)) {
                bestKw = kwRes;
              }
            }
            if (bestKw) {
              res = {
                matched: true,
                score: Math.max(1, Math.round(bestKw.score * 0.7)),
                ranges: [],
                matchType: 'keyword',
              };
            }
          }

          if (res.matched) {
            scored.push({
              item,
              label,
              score: res.score,
              ranges: res.ranges,
              matchType: res.matchType,
              index: i,
            });
          }
        }

        if (trimmed) {
          scored.sort(function compareMatches(a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (a.label.length !== b.label.length) return a.label.length - b.label.length;
            return a.index - b.index;
          });
        }

        lastResults = maxResults > 0 ? scored.slice(0, maxResults) : scored;
        if (typeof opts.onFilter === 'function') {
          opts.onFilter(lastResults, q);
        }
        return lastResults;
      }

      function reset() {
        return filter('');
      }

      function getQuery() {
        return lastQuery;
      }

      function getResults() {
        return lastResults;
      }

      function destroy() {
        destroyed = true;
        lastQuery = '';
        lastResults = [];
      }

      return {
        filter,
        score: scoreFuzzyLabel,
        splitRanges: splitMatchRanges,
        reset,
        getQuery,
        getResults,
        destroy,
      };
    }

    /* ========================================================================
       5. createPopup({ triggerEl, contentEl, placement, offset, onOpenChange })
       Viewport-clamped floating popup controller with auto-flip & ARIA sync.
       ======================================================================== */
    function parsePlacement(placement) {
      const raw = String(placement || 'bottom-start');
      const parts = raw.split('-');
      const side = parts[0] || 'bottom';
      const align = parts[1] || '';
      return { side, align };
    }

    function readRect(el) {
      if (!el) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const width = (r && r.width) || el.offsetWidth || 0;
      const height = (r && r.height) || el.offsetHeight || 0;
      const top = r ? r.top : 0;
      const left = r ? r.left : 0;
      const right = r && typeof r.right === 'number' ? r.right : left + width;
      const bottom = r && typeof r.bottom === 'number' ? r.bottom : top + height;
      return { top, left, right, bottom, width, height };
    }

    function createPopup(options) {
      const opts = options || {};
      const triggerEl = opts.triggerEl || null;
      const contentEl = opts.contentEl || null;
      const preferredPlacement = opts.placement || 'bottom-start';
      const offset = typeof opts.offset === 'number' ? opts.offset : 6;
      const padding = typeof opts.padding === 'number' ? opts.padding : 8;
      const strategy = opts.strategy || 'fixed';
      const closeOnOutsideClick = opts.closeOnOutsideClick !== false;
      const closeOnEscape = opts.closeOnEscape !== false;
      const shouldRestoreFocus = opts.restoreFocus !== false;

      const doc = getDocument(opts.doc, contentEl || triggerEl);
      const win = getWindow(doc, contentEl || triggerEl);

      let openState = false;
      let destroyed = false;
      let currentPlacement = preferredPlacement;
      let dismissable = null;
      let rafId = null;
      const activeCleanups = [];

      const focusRecovery = createFocusRecovery({
        doc,
        fallback: opts.focusFallback || function () {
          return triggerEl;
        },
      });

      const contentId = contentEl ? ensureId(contentEl, 'ui-sdk-popup') : '';

      if (triggerEl && typeof triggerEl.setAttribute === 'function') {
        if (contentId) {
          triggerEl.setAttribute('aria-controls', contentId);
        }
        triggerEl.setAttribute('aria-expanded', 'false');
        triggerEl.setAttribute('data-state', 'closed');
      }

      if (contentEl && typeof contentEl.setAttribute === 'function') {
        contentEl.setAttribute('data-state', 'closed');
        contentEl.setAttribute('hidden', '');
        try {
          contentEl.hidden = true;
        } catch (_err) {}
      }

      function clearActiveListeners() {
        while (activeCleanups.length > 0) {
          const fn = activeCleanups.pop();
          fn();
        }
        if (rafId !== null && win && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(rafId);
        }
        rafId = null;
        if (dismissable) {
          dismissable.destroy();
          dismissable = null;
        }
      }

      function reposition() {
        if (destroyed || !triggerEl || !contentEl) {
          return { x: 0, y: 0, placement: currentPlacement, flipped: false };
        }

        const parsed = parsePlacement(preferredPlacement);
        const initialSide = parsed.side;
        let side = initialSide;
        const align = parsed.align;

        const triggerRect = readRect(triggerEl);
        const contentRect = readRect(contentEl);
        const cw = contentRect.width;
        const ch = contentRect.height;

        const vw =
          (win && typeof win.innerWidth === 'number' && win.innerWidth) ||
          (doc && doc.documentElement && doc.documentElement.clientWidth) ||
          1024;
        const vh =
          (win && typeof win.innerHeight === 'number' && win.innerHeight) ||
          (doc && doc.documentElement && doc.documentElement.clientHeight) ||
          768;

        const spaceBelow = vh - triggerRect.bottom - offset - padding;
        const spaceAbove = triggerRect.top - offset - padding;
        const spaceRight = vw - triggerRect.right - offset - padding;
        const spaceLeft = triggerRect.left - offset - padding;

        // Automatic flip when overflowing primary edge and opposite edge has more space
        if (side === 'bottom' && ch > spaceBelow && spaceAbove > spaceBelow) {
          side = 'top';
        } else if (side === 'top' && ch > spaceAbove && spaceBelow > spaceAbove) {
          side = 'bottom';
        } else if (side === 'right' && cw > spaceRight && spaceLeft > spaceRight) {
          side = 'left';
        } else if (side === 'left' && cw > spaceLeft && spaceRight > spaceLeft) {
          side = 'right';
        }

        let x = 0;
        let y = 0;

        if (side === 'bottom' || side === 'top') {
          y = side === 'bottom' ? triggerRect.bottom + offset : triggerRect.top - ch - offset;
          if (align === 'start') {
            x = triggerRect.left;
          } else if (align === 'end') {
            x = triggerRect.right - cw;
          } else {
            x = triggerRect.left + (triggerRect.width - cw) / 2;
          }
        } else {
          x = side === 'right' ? triggerRect.right + offset : triggerRect.left - cw - offset;
          if (align === 'start') {
            y = triggerRect.top;
          } else if (align === 'end') {
            y = triggerRect.bottom - ch;
          } else {
            y = triggerRect.top + (triggerRect.height - ch) / 2;
          }
        }

        // Viewport clamping
        const maxX = Math.max(padding, vw - cw - padding);
        const maxY = Math.max(padding, vh - ch - padding);
        x = Math.min(Math.max(x, padding), maxX);
        y = Math.min(Math.max(y, padding), maxY);

        const rx = Math.round(x);
        const ry = Math.round(y);
        const actualPlacement = align ? side + '-' + align : side;
        currentPlacement = actualPlacement;

        if (contentEl.style) {
          contentEl.style.position = strategy;
          contentEl.style.left = rx + 'px';
          contentEl.style.top = ry + 'px';
        }
        if (typeof contentEl.setAttribute === 'function') {
          contentEl.setAttribute('data-placement', actualPlacement);
          contentEl.setAttribute('data-side', side);
          if (align) {
            contentEl.setAttribute('data-align', align);
          } else if (typeof contentEl.removeAttribute === 'function') {
            contentEl.removeAttribute('data-align');
          }
        }

        return {
          x: rx,
          y: ry,
          placement: actualPlacement,
          side,
          align,
          flipped: side !== initialSide,
        };
      }

      function scheduleReposition() {
        if (!openState || destroyed) return;
        if (win && typeof win.requestAnimationFrame === 'function') {
          if (rafId !== null) return;
          rafId = win.requestAnimationFrame(function flushReposition() {
            rafId = null;
            if (openState && !destroyed) reposition();
          });
        } else {
          reposition();
        }
      }

      function open() {
        if (destroyed || openState) return false;

        if (shouldRestoreFocus) {
          focusRecovery.capture();
        }

        openState = true;

        if (triggerEl && typeof triggerEl.setAttribute === 'function') {
          triggerEl.setAttribute('aria-expanded', 'true');
          triggerEl.setAttribute('data-state', 'open');
        }

        if (contentEl) {
          if (typeof contentEl.removeAttribute === 'function') {
            contentEl.removeAttribute('hidden');
          }
          try {
            contentEl.hidden = false;
          } catch (_err) {}
          if (typeof contentEl.setAttribute === 'function') {
            contentEl.setAttribute('data-state', 'open');
          }
        }

        const pos = reposition();

        dismissable = createDismissable({
          doc,
          el: contentEl,
          ignoreEls: triggerEl ? [triggerEl] : [],
          closeOnEscape,
          closeOnOutsideClick,
          onDismiss: function onPopupDismiss(reason) {
            close({ reason });
          },
        });

        if (win) {
          activeCleanups.push(
            addListener(win, 'resize', scheduleReposition),
            addListener(win, 'scroll', scheduleReposition, true)
          );
        }
        if (doc && doc !== win) {
          activeCleanups.push(addListener(doc, 'scroll', scheduleReposition, true));
        }

        if (typeof opts.onOpenChange === 'function') {
          opts.onOpenChange(true, { placement: pos.placement, flipped: pos.flipped });
        }
        return true;
      }

      function close(closeOpts) {
        if (!openState) return false;
        const cOpts = closeOpts || {};
        const reason = cOpts.reason || 'programmatic';

        openState = false;
        clearActiveListeners();

        if (triggerEl && typeof triggerEl.setAttribute === 'function') {
          triggerEl.setAttribute('aria-expanded', 'false');
          triggerEl.setAttribute('data-state', 'closed');
        }

        if (contentEl && typeof contentEl.setAttribute === 'function') {
          contentEl.setAttribute('data-state', 'closed');
          contentEl.setAttribute('hidden', '');
          try {
            contentEl.hidden = true;
          } catch (_err) {}
        }

        if (shouldRestoreFocus && cOpts.restoreFocus !== false) {
          focusRecovery.restore({
            onlyIfStranded: reason === 'outside-click',
            withinEl: contentEl,
          });
        } else {
          focusRecovery.clear();
        }

        if (typeof opts.onOpenChange === 'function') {
          opts.onOpenChange(false, { reason });
        }
        return true;
      }

      function toggle() {
        return openState ? close({ reason: 'toggle' }) : open();
      }

      function isOpen() {
        return openState;
      }

      function getPlacement() {
        return currentPlacement;
      }

      function destroy() {
        if (destroyed) return;
        if (openState) {
          close({ reason: 'destroy', restoreFocus: false });
        } else {
          clearActiveListeners();
        }
        focusRecovery.destroy();
        destroyed = true;
      }

      return {
        open,
        close,
        toggle,
        reposition,
        isOpen,
        getPlacement,
        destroy,
      };
    }

    /* ========================================================================
       2. definePrimitive({ name, state, api, slots })
       Declarative headless primitive factory following @ui-sdk/core's model.
       ======================================================================== */
    function isNativePressable(el) {
      const tag = el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
      return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SUMMARY';
    }

    function bindPressBehavior(el, handler, getPart) {
      const cleanups = [];
      let isPressed = false;
      let lastKeyPressTs = 0;

      function setPressed(next) {
        if (isPressed === next) return;
        isPressed = next;
        if (typeof el.setAttribute !== 'function') return;
        if (next) {
          el.setAttribute('data-pressed', 'true');
        } else if (typeof el.removeAttribute === 'function') {
          el.removeAttribute('data-pressed');
        }
      }

      function invoke(event) {
        if (isDisabledEl(el)) return;
        handler(event, getPart());
      }

      cleanups.push(
        addListener(el, 'pointerdown', function onPointerDown(event) {
          if (isDisabledEl(el)) return;
          if (event && typeof event.button === 'number' && event.button !== 0) return;
          setPressed(true);
        }),
        addListener(el, 'pointerup', function onPointerUp() {
          setPressed(false);
        }),
        addListener(el, 'pointercancel', function onPointerCancel() {
          setPressed(false);
        }),
        addListener(el, 'blur', function onBlur() {
          setPressed(false);
        }),
        addListener(el, 'click', function onClick(event) {
          setPressed(false);
          if (Date.now() - lastKeyPressTs < 50) return;
          invoke(event);
        }),
        addListener(el, 'keydown', function onKeyDown(event) {
          if (!event || isDisabledEl(el)) return;
          const key = event.key;
          if (key === 'Enter') {
            if (!isNativePressable(el)) {
              if (typeof event.preventDefault === 'function') event.preventDefault();
              setPressed(true);
              lastKeyPressTs = Date.now();
              invoke(event);
              setPressed(false);
            } else {
              setPressed(true);
            }
          } else if (key === ' ' || key === 'Spacebar') {
            if (!isNativePressable(el)) {
              if (typeof event.preventDefault === 'function') event.preventDefault();
            }
            setPressed(true);
          }
        }),
        addListener(el, 'keyup', function onKeyUp(event) {
          if (!event) return;
          const key = event.key;
          if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            const wasPressed = isPressed;
            setPressed(false);
            if ((key === ' ' || key === 'Spacebar') && wasPressed && !isNativePressable(el)) {
              lastKeyPressTs = Date.now();
              invoke(event);
            }
          }
        })
      );

      return function teardownPress() {
        setPressed(false);
        while (cleanups.length > 0) {
          cleanups.pop()();
        }
      };
    }

    function definePrimitive(config) {
      if (!config || typeof config !== 'object' || !config.name) {
        throw new Error('definePrimitive requires a config object with a non-empty name');
      }

      const primitiveName = String(config.name);
      const slotDefs = config.slots || {};

      function mount(rootEl, slotMap, options) {
        const providedSlots = slotMap || {};
        const mountOptions = options || {};
        const initialState =
          typeof config.state === 'function' ? config.state(mountOptions) : config.state || {};
        const store = createStore(initialState);

        let destroyed = false;
        const cleanups = [];
        const resolvedSlots = Object.create(null);

        function onCleanup(fn) {
          if (typeof fn === 'function') {
            cleanups.push(fn);
          } else if (fn && typeof fn.destroy === 'function') {
            cleanups.push(function destroyChild() {
              fn.destroy();
            });
          }
        }

        // Tag root element with data-ui-primitive
        if (rootEl && typeof rootEl.setAttribute === 'function') {
          const prevPrimitiveAttr =
            typeof rootEl.getAttribute === 'function'
              ? rootEl.getAttribute('data-ui-primitive')
              : null;
          rootEl.setAttribute('data-ui-primitive', primitiveName);
          onCleanup(function restoreRootAttr() {
            if (prevPrimitiveAttr === null) {
              if (typeof rootEl.removeAttribute === 'function') {
                rootEl.removeAttribute('data-ui-primitive');
              }
            } else {
              rootEl.setAttribute('data-ui-primitive', prevPrimitiveAttr);
            }
          });
        }

        // Resolve slot elements from slotMap or auto-discover inside rootEl
        const slotNames = Object.keys(slotDefs);
        for (let i = 0; i < slotNames.length; i += 1) {
          const slotName = slotNames[i];
          let els = [];
          if (Object.prototype.hasOwnProperty.call(providedSlots, slotName) && providedSlots[slotName] != null) {
            els = toElementArray(providedSlots[slotName], rootEl);
          } else if (rootEl && typeof rootEl.querySelectorAll === 'function') {
            els = Array.from(
              rootEl.querySelectorAll('[data-ui-slot="' + slotName + '"], [data-slot="' + slotName + '"]')
            ).filter(isElement);
          }
          resolvedSlots[slotName] = els;
        }

        function getSlot(name) {
          const list = resolvedSlots[name];
          return list && list.length > 0 ? list[0] : null;
        }

        function getSlots(name) {
          return resolvedSlots[name] ? resolvedSlots[name].slice() : [];
        }

        const ctx = {
          name: primitiveName,
          store,
          get: store.get,
          set: store.set,
          batch: store.batch,
          options: mountOptions,
          rootEl: rootEl || null,
          slots: resolvedSlots,
          getSlot,
          getSlots,
          onCleanup,
        };

        const api =
          typeof config.api === 'function'
            ? config.api(ctx) || {}
            : isPlainObject(config.api)
              ? Object.assign({}, config.api)
              : {};

        ctx.api = api;

        const boundEntries = [];

        for (let s = 0; s < slotNames.length; s += 1) {
          const slotName = slotNames[s];
          const slotDef = slotDefs[slotName] || {};
          const elements = resolvedSlots[slotName] || [];

          for (let idx = 0; idx < elements.length; idx += 1) {
            const el = elements[idx];
            const attrCache = new Map();
            let lastPresent = undefined;

            const part = {
              el,
              name: slotName,
              index: idx,
              store,
              api,
              rootEl: rootEl || null,
              slots: resolvedSlots,
              getSlot,
              getSlots,
              get: store.get,
              set: store.set,
              batch: store.batch,
              options: mountOptions,
              onCleanup,
              get state() {
                return store.get();
              },
            };

            // Tag element with data-ui-slot
            if (typeof el.setAttribute === 'function') {
              const prevSlotAttr =
                typeof el.getAttribute === 'function' ? el.getAttribute('data-ui-slot') : null;
              el.setAttribute('data-ui-slot', slotName);
              onCleanup(function restoreSlotAttr() {
                if (prevSlotAttr === null) {
                  if (typeof el.removeAttribute === 'function') {
                    el.removeAttribute('data-ui-slot');
                  }
                } else {
                  el.setAttribute('data-ui-slot', prevSlotAttr);
                }
              });
            }

            // Declarative event map (`on`)
            if (slotDef.on) {
              const eventMap = typeof slotDef.on === 'function' ? slotDef.on(part) : slotDef.on;
              if (eventMap && typeof eventMap === 'object') {
                const eventNames = Object.keys(eventMap);
                for (let e = 0; e < eventNames.length; e += 1) {
                  const eventName = eventNames[e];
                  const listener = eventMap[eventName];
                  if (typeof listener !== 'function') continue;
                  onCleanup(
                    addListener(el, eventName, function wrappedSlotListener(evt) {
                      if (destroyed) return;
                      listener(evt, part);
                    })
                  );
                }
              }
            }

            // Unified press behavior (`press`)
            if (typeof slotDef.press === 'function') {
              onCleanup(
                bindPressBehavior(
                  el,
                  function wrappedPress(evt, currentPart) {
                    if (destroyed) return;
                    slotDef.press(evt, currentPart);
                  },
                  function getCurrentPart() {
                    return part;
                  }
                )
              );
            }

            // Custom imperative hook (`bind(el, part)`)
            if (typeof slotDef.bind === 'function') {
              const maybeCleanup = slotDef.bind(el, part);
              if (maybeCleanup) {
                onCleanup(maybeCleanup);
              }
            }

            boundEntries.push({
              el,
              slotDef,
              part,
              attrCache,
              syncPresence: function syncPresence(nextState) {
                if (typeof slotDef.present !== 'function') return;
                const present = Boolean(slotDef.present(nextState, part));
                if (present === lastPresent) return;
                lastPresent = present;
                if (typeof el.setAttribute === 'function') {
                  el.setAttribute('data-present', present ? 'true' : 'false');
                  if (present) {
                    if (typeof el.removeAttribute === 'function') {
                      el.removeAttribute('hidden');
                    }
                    try {
                      el.hidden = false;
                    } catch (_err) {}
                  } else {
                    el.setAttribute('hidden', '');
                    try {
                      el.hidden = true;
                    } catch (_err) {}
                  }
                }
              },
            });

            if (typeof slotDef.present === 'function') {
              onCleanup(function clearPresentAttr() {
                if (typeof el.removeAttribute === 'function') {
                  el.removeAttribute('data-present');
                }
              });
            }
          }
        }

        function sync(nextState) {
          if (destroyed) return;
          const s = nextState !== undefined ? nextState : store.get();
          for (let i = 0; i < boundEntries.length; i += 1) {
            const entry = boundEntries[i];
            if (typeof entry.slotDef.attrs === 'function') {
              const computed = entry.slotDef.attrs(s, entry.part);
              applyAttributeDiff(entry.el, computed, entry.attrCache);
            }
            entry.syncPresence(s);
          }
        }

        // Initial synchronous render & subscribe to store updates
        sync(store.get());
        const unsubscribe = store.subscribe(function onStoreChange(nextState) {
          sync(nextState);
        });
        onCleanup(unsubscribe);

        if (typeof config.onMount === 'function') {
          const mountCleanup = config.onMount(ctx);
          if (mountCleanup) onCleanup(mountCleanup);
        }

        function destroy() {
          if (destroyed) return;
          destroyed = true;
          if (typeof config.onDestroy === 'function') {
            config.onDestroy(ctx);
          }
          while (cleanups.length > 0) {
            const fn = cleanups.pop();
            try {
              fn();
            } catch (_err) {
              // Ensure remaining cleanups always run
            }
          }
        }

        return {
          name: primitiveName,
          store,
          api,
          slots: resolvedSlots,
          sync,
          destroy,
        };
      }

      return {
        name: primitiveName,
        mount,
      };
    }

    return {
      version: '1.0.0',
      createStore,
      definePrimitive,
      createSelection,
      createTypeahead,
      createPopup,
      createFocusRecovery,
      createDismissable,
      getDismissStackSize,
    };
  }
);
