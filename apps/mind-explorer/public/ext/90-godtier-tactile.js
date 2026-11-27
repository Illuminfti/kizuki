/* ==========================================================================
   KIZUKI MIND OS - GOD-TIER PHYSICAL TACTILE RUNTIME
   1. ?detail=on|off Subtraction Proof URL synchronization
   2. Live physical keycap depression feedback on visible <kbd> chips
   3. Single rAF-throttled pointermove specular rim tracker
   4. Optional 12ms filtered WebAudio mechanical click detent
   ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiTactile = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiTactile = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (globalRoot) {
  'use strict';

  var RIM_SELECTOR = [
    '[data-tactile-rim]',
    '.brief-hero',
    '.dossier-hero',
    '.tr-radar-shell',
    '.tr-card',
    '.codex-card',
    '.taste-card',
    '.taste-option-card',
    '.eb-mesh-shell',
    '.cmdp-modal',
  ].join(', ');

  var KBD_SELECTOR = 'kbd, .kbd, .kbd-hint, .tr-kbd, .tr-rank-kbd, .taste-keycap';
  var TRACKED_KEYS = new Set([
    'a', 'r', 'd', 's', 'x', 'u',
    '1', '2', '3', '4', '5',
    'k', 'j', 'm', 't',
    '?', 'escape', 'enter', 'tab', 'arrowup', 'arrowdown',
  ]);

  var SOUND_STORAGE_KEY = 'kizuki-sound';
  var DETENT_COOLDOWN_MS = 24;

  var gestureUnlocked = false;
  var audioCtx = null;
  var lastDetentAt = -Infinity;
  var activeRimEl = null;
  var pendingPointer = null;
  var rafId = null;
  var pressedKeyEls = new Map();
  var releaseTimers = new WeakMap();
  var initialized = false;

  function getWin() {
    if (typeof window !== 'undefined' && window) return window;
    if (globalRoot && globalRoot.window) return globalRoot.window;
    return null;
  }

  function getDoc() {
    if (typeof document !== 'undefined' && document) return document;
    var w = getWin();
    return w && w.document ? w.document : null;
  }

  function nowMs() {
    var w = getWin();
    if (w && w.performance && typeof w.performance.now === 'function') {
      return w.performance.now();
    }
    return Date.now();
  }

  function isDetailOff() {
    var doc = getDoc();
    if (!doc || !doc.documentElement) return false;
    return doc.documentElement.getAttribute('data-detail') === 'off';
  }

  function isReducedMotion() {
    var w = getWin();
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      return Boolean(w.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function isHoverFinePointer() {
    var w = getWin();
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      return Boolean(w.matchMedia('(hover: hover) and (pointer: fine)').matches);
    } catch (_) {
      return false;
    }
  }

  function isSoundAllowed() {
    if (!gestureUnlocked || isDetailOff() || isReducedMotion()) return false;
    var w = getWin();
    if (w && w.KizukiSound) {
      try {
        if (typeof w.KizukiSound.isEnabled === 'function' && !w.KizukiSound.isEnabled()) {
          return false;
        }
        if (typeof w.KizukiSound.isMuted === 'function' && w.KizukiSound.isMuted()) {
          return false;
        }
      } catch (_) {
        return false;
      }
    }
    try {
      if (w && w.localStorage) {
        var raw = w.localStorage.getItem(SOUND_STORAGE_KEY);
        if (raw !== null) {
          var norm = String(raw).trim().toLowerCase();
          if (norm === 'false' || norm === '0' || norm === 'off') return false;
        }
      }
    } catch (_) {
      // Ignore storage access restrictions.
    }
    return true;
  }

  // =========================================================================
  // 1. SUBTRACTION PROOF URL SYNC (?detail=on|off)
  // =========================================================================

  function syncDetailFromUrl() {
    var w = getWin();
    var doc = getDoc();
    if (!w || !doc || !doc.documentElement || !w.location) return null;
    try {
      var params = new URLSearchParams(w.location.search || '');
      var raw = params.get('detail');
      if (raw !== 'off' && raw !== 'on') return doc.documentElement.getAttribute('data-detail');
      doc.documentElement.setAttribute('data-detail', raw);
      var toggleBtn = doc.getElementById('btn-detail-toggle');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', raw === 'on' ? 'true' : 'false');
      }
      if (raw === 'off') {
        clearActiveRim();
      }
      return raw;
    } catch (_) {
      return null;
    }
  }

  // =========================================================================
  // 2. SUBTLE PHYSICAL TACTILE MICRO-FOLEY (12ms Filtered Click)
  // =========================================================================

  function ensureAudioContext() {
    if (!gestureUnlocked) return null;
    if (audioCtx) {
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        try {
          Promise.resolve(audioCtx.resume()).catch(function () {});
        } catch (_) {}
      }
      return audioCtx;
    }
    var w = getWin();
    var Ctor = w && (w.AudioContext || w.webkitAudioContext);
    if (typeof Ctor !== 'function') return null;
    try {
      audioCtx = new Ctor();
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function clickDetent(kind) {
    if (!isSoundAllowed()) return false;
    var tNow = nowMs();
    if (tNow - lastDetentAt < DETENT_COOLDOWN_MS) return false;
    lastDetentAt = tNow;

    var ctx = ensureAudioContext();
    if (!ctx || ctx.state === 'closed') return false;

    try {
      var start = ctx.currentTime;
      var duration = 0.012;
      var preset = kind || 'detent';
      var freq = 1850;
      var qVal = 2.6;
      var peakGain = 0.032;

      if (preset === 'keycap') {
        freq = 2350;
        qVal = 3.0;
        peakGain = 0.028;
      } else if (preset === 'confirm') {
        freq = 1480;
        qVal = 2.1;
        peakGain = 0.04;
      } else if (preset === 'soft') {
        freq = 1220;
        qVal = 1.8;
        peakGain = 0.018;
      }

      var osc = ctx.createOscillator();
      var filter = ctx.createBiquadFilter();
      var gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(Math.max(240, freq * 0.36), start + duration);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(freq * 0.92, start);
      filter.Q.setValueAtTime(qVal, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.0018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + duration + 0.002);
      return true;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 3. LIVE PHYSICAL KEYCAP FEEDBACK
  // =========================================================================

  function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    var tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null) {
      var style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      if (!style || style.position !== 'fixed' || style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeKbdLabel(text) {
    var raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!raw) return [];
    var out = [raw];
    if (raw === 'esc') out.push('escape');
    if (raw === 'escape') out.push('esc');
    if (raw === '\u2318k' || raw === 'cmd+k' || raw === 'ctrl+k') out.push('mod+k');
    if (raw === '\u2318j' || raw === 'cmd+j' || raw === 'ctrl+j') out.push('mod+j');
    if (raw === '\u21b5' || raw === 'return') out.push('enter');
    if (raw === '\u2191' || raw === 'up') out.push('arrowup');
    if (raw === '\u2193' || raw === 'down') out.push('arrowdown');
    return out;
  }

  function resolvePressedTokens(ev) {
    var key = String(ev.key || '').toLowerCase();
    var hasMod = Boolean(ev.metaKey || ev.ctrlKey);
    var tokens = new Set();

    if (hasMod && (key === 'k' || key === 'j')) {
      tokens.add('mod+' + key);
      tokens.add('cmd+' + key);
      tokens.add('\u2318' + key);
      tokens.add(key);
      return tokens;
    }

    if (!TRACKED_KEYS.has(key)) return tokens;
    tokens.add(key);
    if (key === 'escape') tokens.add('esc');
    return tokens;
  }

  function releaseKeycapEl(el) {
    if (!el) return;
    var timer = releaseTimers.get(el);
    if (timer) {
      clearTimeout(timer);
      releaseTimers.delete(el);
    }
    el.classList.remove('is-key-pressed');
  }

  function pressKeycap(tokens, keyId) {
    var doc = getDoc();
    if (!doc || !tokens || tokens.size === 0) return 0;

    var nodes = doc.querySelectorAll(KBD_SELECTOR);
    var matched = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!isElementVisible(el)) continue;
      var labels = normalizeKbdLabel(el.textContent);
      var hit = false;
      for (var j = 0; j < labels.length; j += 1) {
        if (tokens.has(labels[j])) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      el.classList.add('is-key-pressed');
      var prevTimer = releaseTimers.get(el);
      if (prevTimer) clearTimeout(prevTimer);
      (function (node) {
        var tid = setTimeout(function () {
          releaseKeycapEl(node);
        }, 240);
        releaseTimers.set(node, tid);
      })(el);
      matched.push(el);
    }

    if (matched.length > 0) {
      pressedKeyEls.set(keyId, matched);
      clickDetent('keycap');
    }
    return matched.length;
  }

  function releaseAllKeycaps() {
    pressedKeyEls.forEach(function (els) {
      for (var i = 0; i < els.length; i += 1) {
        releaseKeycapEl(els[i]);
      }
    });
    pressedKeyEls.clear();
  }

  function onKeyDown(ev) {
    gestureUnlocked = true;
    if (ev.repeat) return;
    var hasMod = Boolean(ev.metaKey || ev.ctrlKey);
    var key = String(ev.key || '').toLowerCase();

    if (isEditableTarget(ev.target) && !hasMod && key !== 'escape') {
      return;
    }

    var tokens = resolvePressedTokens(ev);
    if (tokens.size === 0) return;
    var keyId = (hasMod ? 'mod:' : '') + key;
    pressKeycap(tokens, keyId);
  }

  function onKeyUp(ev) {
    var key = String(ev.key || '').toLowerCase();
    var ids = [key, 'mod:' + key];
    for (var i = 0; i < ids.length; i += 1) {
      var list = pressedKeyEls.get(ids[i]);
      if (!list) continue;
      for (var j = 0; j < list.length; j += 1) {
        releaseKeycapEl(list[j]);
      }
      pressedKeyEls.delete(ids[i]);
    }
  }

  // =========================================================================
  // 4. SINGLE rAF-THROTTLED SPECULAR RIM TRACKER
  // =========================================================================

  function clearActiveRim() {
    if (activeRimEl) {
      activeRimEl.removeAttribute('data-rim-active');
      activeRimEl = null;
    }
  }

  function flushRimFrame() {
    rafId = null;
    var sample = pendingPointer;
    pendingPointer = null;
    if (!sample) return;

    var doc = getDoc();
    if ((doc && doc.hidden) || isDetailOff() || isReducedMotion() || !isHoverFinePointer()) {
      clearActiveRim();
      return;
    }

    var rawTarget = sample.target;
    var rimEl = rawTarget && typeof rawTarget.closest === 'function'
      ? rawTarget.closest(RIM_SELECTOR)
      : null;

    if (rimEl !== activeRimEl) {
      clearActiveRim();
      activeRimEl = rimEl;
    }

    if (!rimEl || !rimEl.isConnected) {
      clearActiveRim();
      return;
    }

    var rect = rimEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      clearActiveRim();
      return;
    }

    var gx = Math.round((sample.x - rect.left) * 10) / 10;
    var gy = Math.round((sample.y - rect.top) * 10) / 10;
    rimEl.style.setProperty('--gx', gx + 'px');
    rimEl.style.setProperty('--gy', gy + 'px');
    rimEl.setAttribute('data-rim-active', '1');
  }

  function onPointerMove(ev) {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    if (isDetailOff() || isReducedMotion() || !isHoverFinePointer()) {
      if (activeRimEl) clearActiveRim();
      return;
    }
    pendingPointer = {
      x: ev.clientX,
      y: ev.clientY,
      target: ev.target,
    };
    if (rafId !== null) return;
    var w = getWin();
    if (w && typeof w.requestAnimationFrame === 'function') {
      rafId = w.requestAnimationFrame(flushRimFrame);
    }
  }

  function onPointerDown() {
    gestureUnlocked = true;
  }

  function init() {
    if (initialized) return;
    var w = getWin();
    var doc = getDoc();
    if (!w || !doc) return;
    initialized = true;

    syncDetailFromUrl();

    var shell = doc.getElementById('app-shell');
    if (shell) {
      shell.addEventListener('pointermove', onPointerMove, { passive: true });
      shell.addEventListener('pointerleave', clearActiveRim, { passive: true });
    }
    // Lightweight fallback for teleported overlays like #kizuki-cmdp-backdrop in document.body
    doc.addEventListener('pointermove', function (ev) {
      if (shell && shell.contains(ev.target)) return;
      if (ev.target && typeof ev.target.closest === 'function' && ev.target.closest('.cmdp-modal')) {
        onPointerMove(ev);
      } else if (activeRimEl && (!shell || !shell.contains(activeRimEl))) {
        clearActiveRim();
      }
    }, { passive: true });

    w.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    w.addEventListener('keydown', onKeyDown, { capture: true, passive: true });
    w.addEventListener('keyup', onKeyUp, { capture: true, passive: true });
    w.addEventListener('blur', function () {
      releaseAllKeycaps();
      clearActiveRim();
    }, { passive: true });

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) {
        releaseAllKeycaps();
        clearActiveRim();
        if (audioCtx && audioCtx.state === 'running' && typeof audioCtx.suspend === 'function') {
          try {
            Promise.resolve(audioCtx.suspend()).catch(function () {});
          } catch (_) {}
        }
      }
    });

    w.addEventListener('kizuki:sound-change', function (ev) {
      if (ev && ev.detail && ev.detail.enabled === false && audioCtx && audioCtx.state === 'running') {
        try {
          Promise.resolve(audioCtx.suspend()).catch(function () {});
        } catch (_) {}
      }
    });
  }

  var docNow = getDoc();
  if (docNow) {
    if (docNow.readyState === 'loading') {
      docNow.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }

  return {
    version: '1.0.0',
    init: init,
    syncDetailFromUrl: syncDetailFromUrl,
    isDetailOff: isDetailOff,
    isReducedMotion: isReducedMotion,
    clickDetent: clickDetent,
    pressKeycap: pressKeycap,
  };
});
