/* ==========================================================================
   KIZUKI MIND EXPLORER - PROCEDURAL WEBAUDIO MECHANICAL ACOUSTICS ENGINE
   Teenage Engineering / Dieter Rams micro-acoustics synthesizer.
   Zero external audio files, zero network requests, zero CPU at rest.
   Safe lazy autoplay unlock, Subtraction Proof (?detail=off) mute,
   and prefers-reduced-motion respect.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiSound = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiSound = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const STORAGE_KEY = 'kizuki-sound';
  const MAX_GAIN = 0.08;
  const MIN_GAIN = 0.0001;
  const TICK_THROTTLE_MS = 28;
  const STREAK_RESET_MS = 12000;
  const PENTATONIC_HZ = [440, 494, 554, 659, 740, 880];

  const DELEGATED_SELECTORS =
    '.taste-option-card, .codex-stage-advance-btn, .os-nav-btn, .dossier-subtab, .replay-subtab';

  let enabledCache = null;
  let audioCtx = null;
  let noiseBuffer = null;
  let noiseBufferCtx = null;
  let gestureUnlocked = false;
  let gestureListenersBound = false;
  let visibilityBound = false;
  let lastTickAt = -Infinity;
  let calibrationStreak = 0;
  let lastCalibrateAt = -Infinity;

  const boundRoots = new WeakSet();

  function getWin() {
    if (typeof window !== 'undefined' && window) return window;
    if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
    return null;
  }

  function getDoc() {
    if (typeof document !== 'undefined' && document) return document;
    const w = getWin();
    return w && w.document ? w.document : null;
  }

  function getStorage() {
    try {
      const w = getWin();
      if (w && w.localStorage) return w.localStorage;
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (_) {
      return null;
    }
    return null;
  }

  function getAudioContextCtor() {
    const w = getWin();
    if (w) {
      if (typeof w.AudioContext === 'function') return w.AudioContext;
      if (typeof w.webkitAudioContext === 'function') return w.webkitAudioContext;
    }
    if (typeof globalThis !== 'undefined') {
      if (typeof globalThis.AudioContext === 'function') return globalThis.AudioContext;
      if (typeof globalThis.webkitAudioContext === 'function') return globalThis.webkitAudioContext;
    }
    return null;
  }

  function nowMs() {
    const w = getWin();
    if (w && w.performance && typeof w.performance.now === 'function') {
      return w.performance.now();
    }
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function clampGain(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= MIN_GAIN) return MIN_GAIN;
    return Math.min(num, MAX_GAIN);
  }

  function readPersistedEnabled() {
    const storage = getStorage();
    if (!storage) return true;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null || raw === undefined) return true;
      const normalized = String(raw).trim().toLowerCase();
      if (normalized === 'false' || normalized === '0' || normalized === 'off') {
        return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  function isEnabled() {
    if (enabledCache === null) {
      enabledCache = readPersistedEnabled();
    }
    return enabledCache;
  }

  function setEnabled(next) {
    const flag = Boolean(next);
    enabledCache = flag;
    const storage = getStorage();
    if (storage) {
      try {
        storage.setItem(STORAGE_KEY, flag ? 'true' : 'false');
      } catch (_) {
        // Ignore storage quota or private-mode restrictions.
      }
    }
    if (!flag && audioCtx && audioCtx.state === 'running' && typeof audioCtx.suspend === 'function') {
      try {
        Promise.resolve(audioCtx.suspend()).catch(function () {});
      } catch (_) {
        // Ignore suspend errors.
      }
    }
    const w = getWin();
    if (w && typeof w.dispatchEvent === 'function' && typeof w.CustomEvent === 'function') {
      try {
        w.dispatchEvent(new w.CustomEvent('kizuki:sound-change', { detail: { enabled: flag } }));
      } catch (_) {
        // Ignore event dispatch failures in minimal environments.
      }
    }
    return flag;
  }

  function toggle() {
    return setEnabled(!isEnabled());
  }

  function isDetailOff() {
    const doc = getDoc();
    if (!doc || !doc.documentElement) return false;
    const rootEl = doc.documentElement;
    if (rootEl.dataset && rootEl.dataset.detail === 'off') return true;
    if (typeof rootEl.getAttribute === 'function' && rootEl.getAttribute('data-detail') === 'off') {
      return true;
    }
    return false;
  }

  function isReducedMotion() {
    const w = getWin();
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      const mq = w.matchMedia('(prefers-reduced-motion: reduce)');
      return Boolean(mq && mq.matches);
    } catch (_) {
      return false;
    }
  }

  function isMuted() {
    return !isEnabled() || isDetailOff() || isReducedMotion();
  }

  function ensureContext() {
    if (!gestureUnlocked) return null;
    if (isMuted()) return null;

    if (!audioCtx) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return null;
      try {
        audioCtx = new Ctor();
      } catch (_) {
        audioCtx = null;
        return null;
      }
    }

    if (audioCtx && audioCtx.state === 'closed') {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return null;
      try {
        audioCtx = new Ctor();
        noiseBuffer = null;
        noiseBufferCtx = null;
      } catch (_) {
        audioCtx = null;
        return null;
      }
    }

    if (audioCtx && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try {
        Promise.resolve(audioCtx.resume()).catch(function () {});
      } catch (_) {
        // Ignore autoplay resume errors.
      }
    }

    return audioCtx;
  }

  function unlockFromGesture() {
    gestureUnlocked = true;
    if (isMuted()) return false;
    return Boolean(ensureContext());
  }

  function getNoiseBuffer(ctx) {
    if (noiseBuffer && noiseBufferCtx === ctx) {
      return noiseBuffer;
    }
    if (!ctx || typeof ctx.createBuffer !== 'function') return null;
    try {
      const sampleRate = Number(ctx.sampleRate) || 44100;
      const frameCount = Math.max(64, Math.floor(sampleRate * 0.06));
      const buffer = ctx.createBuffer(1, frameCount, sampleRate);
      if (buffer && typeof buffer.getChannelData === 'function') {
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) {
          data[i] = Math.random() * 2 - 1;
        }
      }
      noiseBuffer = buffer;
      noiseBufferCtx = ctx;
      return buffer;
    } catch (_) {
      return null;
    }
  }

  function scheduleNoiseBurst(ctx, opts) {
    const buffer = getNoiseBuffer(ctx);
    if (!buffer || typeof ctx.createBufferSource !== 'function') return false;

    const startTime = opts.startTime;
    const duration = opts.duration;
    const peakGain = clampGain(opts.gain);
    const attack = Math.min(opts.attack || 0.0012, duration * 0.35);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    let tailNode = src;
    if (typeof ctx.createBiquadFilter === 'function' && opts.filterType) {
      const filter = ctx.createBiquadFilter();
      filter.type = opts.filterType;
      filter.frequency.setValueAtTime(opts.frequency, startTime);
      if (typeof opts.q === 'number' && filter.Q && typeof filter.Q.setValueAtTime === 'function') {
        filter.Q.setValueAtTime(opts.q, startTime);
      }
      tailNode.connect(filter);
      tailNode = filter;
    }

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
    gainNode.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, startTime + duration);

    tailNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    const maxOffset = Math.max(0, 0.055 - duration);
    const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
    src.start(startTime, offset);
    src.stop(startTime + duration + 0.002);
    return true;
  }

  function scheduleTone(ctx, opts) {
    if (typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') {
      return false;
    }

    const startTime = opts.startTime;
    const duration = opts.duration;
    const peakGain = clampGain(opts.gain);
    const attack = Math.min(opts.attack || 0.0015, duration * 0.35);

    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freqStart, startTime);
    if (typeof opts.freqEnd === 'number' && opts.freqEnd > 0 && opts.freqEnd !== opts.freqStart) {
      osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, startTime + duration);
    }

    let tailNode = osc;
    if (opts.lowpass && typeof ctx.createBiquadFilter === 'function') {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(opts.lowpass, startTime);
      tailNode.connect(lp);
      tailNode = lp;
    }

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
    gainNode.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, startTime + duration);

    tailNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.003);
    return true;
  }

  function withActiveContext(fn) {
    if (isMuted()) return false;
    const ctx = ensureContext();
    if (!ctx) return false;
    try {
      return Boolean(fn(ctx, Number(ctx.currentTime) || 0));
    } catch (_) {
      return false;
    }
  }

  /* 1. Machined brass Vernier caliper detent: 14ms band-passed noise (2400Hz, Q=4), min 28ms throttle */
  function tick() {
    const now = nowMs();
    if (now - lastTickAt < TICK_THROTTLE_MS) {
      return false;
    }
    return withActiveContext(function (ctx, t) {
      lastTickAt = now;
      const jitter = (Math.random() - 0.5) * 90;
      return scheduleNoiseBurst(ctx, {
        startTime: t,
        duration: 0.014,
        attack: 0.0012,
        gain: 0.062,
        filterType: 'bandpass',
        frequency: 2400 + jitter,
        q: 4.0
      });
    });
  }

  /* 2. High-damping mechanical keycap tap: 18ms (920Hz -> 340Hz) + micro contact transient */
  function click() {
    return withActiveContext(function (ctx, t) {
      const body = scheduleTone(ctx, {
        startTime: t,
        duration: 0.018,
        attack: 0.001,
        type: 'triangle',
        freqStart: 920,
        freqEnd: 340,
        gain: 0.056
      });
      scheduleNoiseBurst(ctx, {
        startTime: t,
        duration: 0.006,
        attack: 0.0008,
        gain: 0.02,
        filterType: 'highpass',
        frequency: 3200,
        q: 1.0
      });
      return body;
    });
  }

  /* 3. Taste Studio calibration double-tap + ascending pentatonic harmonic sine ping */
  function calibrate(streakIndex) {
    return withActiveContext(function (ctx, t) {
      const now = nowMs();
      let idx;
      if (typeof streakIndex === 'number' && Number.isFinite(streakIndex)) {
        idx = Math.floor(streakIndex);
      } else {
        if (now - lastCalibrateAt > STREAK_RESET_MS) {
          calibrationStreak = 0;
        }
        idx = calibrationStreak;
        calibrationStreak += 1;
      }
      lastCalibrateAt = now;

      const len = PENTATONIC_HZ.length;
      const normalizedIdx = ((idx % len) + len) % len;
      const freq = PENTATONIC_HZ[normalizedIdx];

      /* Tactile double-tap */
      scheduleTone(ctx, {
        startTime: t,
        duration: 0.01,
        attack: 0.001,
        type: 'triangle',
        freqStart: 780,
        freqEnd: 360,
        gain: 0.042
      });
      scheduleTone(ctx, {
        startTime: t + 0.024,
        duration: 0.01,
        attack: 0.001,
        type: 'triangle',
        freqStart: 1040,
        freqEnd: 520,
        gain: 0.032
      });

      /* Ascending pentatonic harmonic sine ping */
      const ping = scheduleTone(ctx, {
        startTime: t + 0.016,
        duration: 0.092,
        attack: 0.004,
        type: 'sine',
        freqStart: freq,
        freqEnd: freq,
        gain: 0.048
      });

      /* Whisper-quiet octave shimmer */
      scheduleTone(ctx, {
        startTime: t + 0.016,
        duration: 0.054,
        attack: 0.003,
        type: 'sine',
        freqStart: freq * 2,
        freqEnd: freq * 2,
        gain: 0.012
      });

      return ping;
    });
  }

  /* 4. Crisp 42ms warm wooden/anodized thock (220Hz -> 130Hz) + soft air click */
  function advance() {
    return withActiveContext(function (ctx, t) {
      const thock = scheduleTone(ctx, {
        startTime: t,
        duration: 0.042,
        attack: 0.002,
        type: 'sine',
        freqStart: 220,
        freqEnd: 130,
        gain: 0.068
      });
      scheduleNoiseBurst(ctx, {
        startTime: t,
        duration: 0.009,
        attack: 0.001,
        gain: 0.022,
        filterType: 'bandpass',
        frequency: 1800,
        q: 2.2
      });
      return thock;
    });
  }

  /* 5. Delicate 140ms two-note fifth interval (523Hz + 784Hz, ultra-low gain 0.045) */
  function chime() {
    return withActiveContext(function (ctx, t) {
      const rootNote = scheduleTone(ctx, {
        startTime: t,
        duration: 0.116,
        attack: 0.006,
        type: 'sine',
        freqStart: 523,
        freqEnd: 523,
        gain: 0.045
      });
      const fifthNote = scheduleTone(ctx, {
        startTime: t + 0.024,
        duration: 0.116,
        attack: 0.006,
        type: 'sine',
        freqStart: 784,
        freqEnd: 784,
        gain: 0.036
      });
      return rootNote && fifthNote;
    });
  }

  /* 6. Subtle descending 30ms soft release tick (420Hz -> 280Hz) */
  function undo() {
    return withActiveContext(function (ctx, t) {
      return scheduleTone(ctx, {
        startTime: t,
        duration: 0.03,
        attack: 0.002,
        type: 'triangle',
        freqStart: 420,
        freqEnd: 280,
        lowpass: 1400,
        gain: 0.052
      });
    });
  }

  function isDisabledControl(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true') {
      return true;
    }
    return false;
  }

  function bindGlobalSounds(rootEl) {
    const targetRoot = rootEl || getDoc();
    if (!targetRoot || typeof targetRoot.addEventListener !== 'function') {
      return false;
    }
    if (boundRoots.has(targetRoot)) {
      return true;
    }

    bindGestureUnlock();
    boundRoots.add(targetRoot);

    targetRoot.addEventListener(
      'click',
      function (event) {
        if (!event || !event.target) return;
        const rawTarget = event.target;
        const el =
          typeof rawTarget.closest === 'function'
            ? rawTarget.closest(DELEGATED_SELECTORS)
            : rawTarget.parentElement && typeof rawTarget.parentElement.closest === 'function'
              ? rawTarget.parentElement.closest(DELEGATED_SELECTORS)
              : null;

        if (!el || isDisabledControl(el)) return;

        if (event.isTrusted !== false) {
          gestureUnlocked = true;
        }

        if (typeof el.matches === 'function') {
          if (el.matches('.taste-option-card')) {
            const rawIdx = el.dataset && el.dataset.streakIndex !== undefined
              ? Number(el.dataset.streakIndex)
              : undefined;
            calibrate(Number.isFinite(rawIdx) ? rawIdx : undefined);
            return;
          }
          if (el.matches('.codex-stage-advance-btn')) {
            advance();
            return;
          }
        }

        click();
      },
      { capture: true, passive: true }
    );

    return true;
  }

  function bindGestureUnlock() {
    if (gestureListenersBound) return;
    const doc = getDoc();
    const w = getWin();
    const target = w || doc;
    if (!target || typeof target.addEventListener !== 'function') return;

    gestureListenersBound = true;

    const onGesture = function () {
      unlockFromGesture();
    };

    target.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
    target.addEventListener('keydown', onGesture, { capture: true, passive: true });

    if (!visibilityBound && doc && typeof doc.addEventListener === 'function') {
      visibilityBound = true;
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden && audioCtx && audioCtx.state === 'running' && typeof audioCtx.suspend === 'function') {
          try {
            Promise.resolve(audioCtx.suspend()).catch(function () {});
          } catch (_) {
            // Ignore background suspend errors.
          }
        }
      });
    }
  }

  /* Auto-bind passive gesture unlock and delegated sounds in browser environments */
  bindGestureUnlock();
  bindGlobalSounds();

  return {
    STORAGE_KEY: STORAGE_KEY,
    PENTATONIC_HZ: PENTATONIC_HZ.slice(),
    TICK_THROTTLE_MS: TICK_THROTTLE_MS,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    toggle: toggle,
    isMuted: isMuted,
    isUnlocked: function () {
      return gestureUnlocked;
    },
    unlock: unlockFromGesture,
    tick: tick,
    click: click,
    calibrate: calibrate,
    advance: advance,
    chime: chime,
    undo: undo,
    bindGlobalSounds: bindGlobalSounds
  };
});
