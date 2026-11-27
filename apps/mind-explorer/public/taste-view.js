/* ==========================================================================
   KIZUKI MIND EXPLORER - TASTE STUDIO & RAPID FINE-TUNING CONTROLLER
   Aligned 1:1 with taste-studio.css (Vercel Geist x Dieter Rams x Linear)
   Exports: window.KizukiTasteView = { mount, load, getState, unmount }
   Zero external deps | Zero XSS | Zero em-dashes | Defensive helper hooks
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiTasteView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const TASTE_FENCE_CLOSED_RE = /```[ \t]*json#taste(?:@[^\s`]+)?[\s\S]*?```/gi;
  const TASTE_FENCE_OPEN_RE = /```[ \t]*json#taste(?:@[^\s`]+)?[\s\S]*$/gi;
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  const SAFE_ID_RE = /^[a-zA-Z0-9_.:/-]+$/;
  const RING_RADIUS = 23;
  const RING_CIRCUMFERENCE = Number((2 * Math.PI * RING_RADIUS).toFixed(2));
  const GARDENER_RING_STYLE_ID = 'kizuki-taste-gardener-ring-styles';
  const GARDENER_RING_RADIUS = 7;
  const GARDENER_RING_CIRCUMFERENCE = Number((2 * Math.PI * GARDENER_RING_RADIUS).toFixed(2));
  const DEFAULT_GARDENER_INTERVAL_MS = 6 * 60 * 60 * 1000;

  const OPTION_KEYS = ['A', 'B', 'C', 'D'];
  const KEY_TO_OPTION = Object.freeze({
    '1': 'A',
    '2': 'B',
    '3': 'C',
    '4': 'D',
  });
  const OPTION_TO_KEY = Object.freeze({
    A: '1',
    B: '2',
    C: '3',
    D: '4',
  });

  const VALID_TABS = Object.freeze({
    deck: true,
    rules: true,
    gardeners: true,
    vault: true,
  });

  const GARDENER_POLL_INTERVAL_MS = 3000;
  const DEFAULT_MASTERY_STAGE_NAMES = Object.freeze([
    'Foundation',
    'Practitioner',
    'Authority',
    'Frontier',
  ]);

  const DEFAULT_DOMAINS = Object.freeze([
    {
      id: 'ui_product',
      label: 'UI & Product Craft',
      shortLabel: 'UI Craft',
      icon: 'layers',
      description: 'Layout density, hierarchy, controls, and tactile product precision.',
    },
    {
      id: 'typography_copy',
      label: 'Typography & Copy',
      shortLabel: 'Typography',
      icon: 'edit',
      description: 'Type pairings, optical cadence, microcopy voice, and zero-slop prose.',
    },
    {
      id: 'visual_brand',
      label: 'Visual & Brand',
      shortLabel: 'Brand',
      icon: 'sparkle_ai',
      description: 'Color polarity, surfaces, art direction, and visual restraint.',
    },
    {
      id: 'motion_feel',
      label: 'Motion & Interaction',
      shortLabel: 'Motion',
      icon: 'stream',
      description: 'Easing physics, information-bearing transitions, and tactile responsiveness.',
    },
    {
      id: 'video_anime',
      label: 'Film, Video & Anime',
      shortLabel: 'Film & Anime',
      icon: 'camera',
      description: 'Framing, satsuei compositing, pacing, sound, and camera craft.',
    },
    {
      id: 'merch_objects',
      label: 'Personal Style & Merch',
      shortLabel: 'Merch',
      icon: 'hobby',
      description: 'Garments, hardware, physical objects, materials, and print craft.',
    },
    {
      id: 'spaces_life',
      label: 'Spaces & Travel',
      shortLabel: 'Spaces',
      icon: 'map_pin',
      description: 'Interiors, lighting, hospitality, neighborhoods, and daily environments.',
    },
    {
      id: 'agent_ops',
      label: 'Agent Behavior',
      shortLabel: 'Agent Ops',
      icon: 'arch_operator',
      description: 'Autonomy boundaries, reporting tone, verification rigor, and taste memory.',
    },
  ]);

  const DOMAIN_META_MAP = Object.create(null);
  for (let i = 0; i < DEFAULT_DOMAINS.length; i += 1) {
    DOMAIN_META_MAP[DEFAULT_DOMAINS[i].id] = DEFAULT_DOMAINS[i];
  }

  const FALLBACK_ICONS = Object.freeze({
    grid: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1"/><rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1"/><rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1"/><rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1"/></svg>',
    layers: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.3 13.5 5.35 8 8.4 2.5 5.35 8 2.3Z"/><path d="M2.5 8.15 8 11.2l5.5-3.05"/><path d="M2.5 10.85 8 13.9l5.5-3.05"/></svg>',
    edit: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 2.65a1.45 1.45 0 0 1 2.05 2.05l-7.25 7.25-2.85.8.8-2.85 7.25-7.25Z"/><path d="M9.45 3.9 11.5 5.95"/></svg>',
    sparkle_ai: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 2.5 7.9 6.1 11.5 7.25 7.9 8.4 6.75 12 5.6 8.4 2 7.25 5.6 6.1 6.75 2.5Z"/><path d="M12.25 2.35v2.3M11.1 3.5h2.3M12.65 10.65v1.9M11.7 11.6h1.9"/></svg>',
    stream: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.9 8.5h2.35l1.6-4.5 2.25 8 1.75-4.75 1.3 1.25h2.95"/></svg>',
    camera: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.25 5.65a1.4 1.4 0 0 1 1.4-1.4h1.35l.95-1.35h4.1l.95 1.35h1.35a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.65a1.4 1.4 0 0 1-1.4-1.4v-6Z"/><circle cx="8" cy="8.55" r="2.1"/></svg>',
    arch_builder: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.15 13.25 5.1v5.8L8 13.85 2.75 10.9V5.1L8 2.15Z"/><path d="M8 8.05 13.25 5.1M8 8.05 2.75 5.1M8 8.05v5.8"/></svg>',
    hobby: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.35 2.15c2.25 1.95 3.75 4.1 3.75 6.45a4.1 4.1 0 1 1-8.2 0c0-1.65.8-3.25 2.1-4.4-.05 1.15.45 1.85 1.15 2.1-.15-1.65.35-3.1 1.2-4.15Z"/><path d="M8 12.7a1.75 1.75 0 0 0 1.75-1.75c0-1-.75-1.75-1.6-2.55-.75.8-1.9 1.55-1.9 2.55A1.75 1.75 0 0 0 8 12.7Z"/></svg>',
    action_plane: '<svg class="k-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.85 2.1 3.45 8.8h4.2l-.5 5.1 5.4-6.7h-4.2l.5-5.1Z"/></svg>',
    chevron_down: '<svg class="k-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.75 6 8 10.25 12.25 6"/></svg>',
    map_pin: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.85s4.35-3.65 4.35-7.15a4.35 4.35 0 1 0-8.7 0c0 3.5 4.35 7.15 4.35 7.15Z"/><circle cx="8" cy="6.7" r="1.5"/></svg>',
    arch_operator: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h3.2M8.7 4.5h4.8M2.5 8h7.3M12.8 8h.7M2.5 11.5h2.1M7.6 11.5h5.9"/><circle cx="7.2" cy="4.5" r="1.45"/><circle cx="11.3" cy="8" r="1.45"/><circle cx="6.1" cy="11.5" r="1.45"/></svg>',
    book: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2.5h8.5a1 1 0 0 1 1 1v10h-8.5a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M3 11.75A1.25 1.25 0 0 1 4.25 10.5H13M6.1 5.5h4.25"/></svg>',
    check: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.1 8.45 6.45 11.8 13.1 4.6"/></svg>',
    plus: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3.1v9.8M3.1 8h9.8"/></svg>',
    trash: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.65 4.4h10.7M6.1 4.4V3.1a.85.85 0 0 1 .85-.85h2.1a.85.85 0 0 1 .85.85v1.3"/><path d="M4.1 4.4 4.75 12.6a1.3 1.3 0 0 0 1.3 1.15h3.9a1.3 1.3 0 0 0 1.3-1.15l.65-8.2"/></svg>',
    replay: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.25 6.25A5.25 5.25 0 1 1 3.4 10.6"/><path d="M2.5 3.5v3h3"/></svg>',
    arrow_right: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.75 8h10.5M9.15 4.1 13.25 8l-4.1 3.9"/></svg>',
    vault: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.2"/><circle cx="8" cy="8" r="2.45"/></svg>',
    external: '<svg class="k-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.6 2.5h3.9v3.9M13.5 2.5 7.85 8.15"/><path d="M11.6 9.15v2.95a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V5.8a1.4 1.4 0 0 1 1.4-1.4h2.95"/></svg>',
    sprout: '<svg class="k-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.75V7.5"/><path d="M8 7.5C8 4.6 10.1 2.75 13 2.75c0 2.9-1.85 4.75-5 4.75Z"/><path d="M8 9.25C8 6.8 6.1 5.2 3.25 5.2c0 2.65 1.75 4.05 4.75 4.05Z"/></svg>',
    play: '<svg class="k-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3.1 12.6 8 4.5 12.9V3.1Z"/></svg>',
    shield: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.15 12.9 4v3.8c0 3.05-2.05 5.3-4.9 6.15-2.85-.85-4.9-3.1-4.9-6.15V4L8 2.15Z"/></svg>',
    compass: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="m10.45 5.55-1.5 3.4-3.4 1.5 1.5-3.4 3.4-1.5Z"/></svg>',
    activity: '<svg class="k-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.25h2.4l1.55-4.2 2.25 7.9 1.75-4.7 1.25 1h2.8"/></svg>',
  });

  function stripEmDash(value) {
    return String(value == null ? '' : value).replace(EM_DASH_RE, ' - ');
  }

  function stripTasteFenceBlocks(value) {
    if (value == null) return '';
    return stripEmDash(String(value))
      .replace(TASTE_FENCE_CLOSED_RE, ' ')
      .replace(TASTE_FENCE_OPEN_RE, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function ensureGardenerRingStyles() {
    const doc = getDoc();
    if (!doc || !doc.head || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
      return false;
    }
    if (doc.getElementById(GARDENER_RING_STYLE_ID)) return true;
    const style = doc.createElement('style');
    style.id = GARDENER_RING_STYLE_ID;
    style.textContent = [
      '.taste-gardener-dots.has-rings {',
      '  gap: 3px;',
      '  padding: 2px 5px;',
      '}',
      '.gardener-countdown-ring {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 18px;',
      '  height: 18px;',
      '  flex-shrink: 0;',
      '  vertical-align: middle;',
      '  line-height: 0;',
      '}',
      '.gardener-countdown-svg {',
      '  display: block;',
      '  width: 18px;',
      '  height: 18px;',
      '  overflow: visible;',
      '}',
      '.gardener-ring-track {',
      '  fill: none;',
      '  stroke: var(--border-strong, rgba(255, 255, 255, 0.14));',
      '  stroke-width: 2;',
      '}',
      'html[data-theme="light"] .gardener-ring-track {',
      '  stroke: rgba(15, 23, 42, 0.14);',
      '}',
      '.gardener-ring-arc {',
      '  fill: none;',
      '  stroke-width: 2;',
      '  stroke-linecap: round;',
      '  transition: stroke-dashoffset 280ms cubic-bezier(0.23, 1, 0.32, 1), stroke 160ms ease;',
      '}',
      '.gardener-countdown-ring.is-idle .gardener-ring-arc {',
      '  stroke: var(--ink-muted, #888888);',
      '}',
      '.gardener-countdown-ring.is-done .gardener-ring-arc {',
      '  stroke: var(--accent-green, #46a758);',
      '}',
      '.gardener-countdown-ring.is-running .gardener-ring-arc {',
      '  stroke: var(--accent-blue, #3291ff);',
      '}',
      '.gardener-countdown-ring.is-error .gardener-ring-arc {',
      '  stroke: var(--wm-rose, #e5484d);',
      '}',
      '.gardener-countdown-ring.is-idle .gardener-ring-core {',
      '  fill: var(--ink-faint, #666666);',
      '}',
      '.gardener-countdown-ring.is-done .gardener-ring-core {',
      '  fill: var(--accent-green, #46a758);',
      '}',
      '.gardener-countdown-ring.is-running .gardener-ring-core {',
      '  fill: var(--accent-blue, #3291ff);',
      '}',
      '.gardener-countdown-ring.is-error .gardener-ring-core {',
      '  fill: var(--wm-rose, #e5484d);',
      '}',
      '.gardener-status.has-ring {',
      '  height: 24px;',
      '  padding: 0 8px 0 4px;',
      '  gap: 6px;',
      '}',
      'html[data-detail="off"] .gardener-ring-arc {',
      '  transition: none;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .gardener-ring-arc { transition: none; }',
      '}',
    ].join('\n');
    doc.head.appendChild(style);
    return true;
  }

  function parseIntervalMs(rawInterval) {
    const text = String(rawInterval || '').trim().toLowerCase();
    if (!text) return DEFAULT_GARDENER_INTERVAL_MS;
    const hrMatch = text.match(/(\d+(?:\.\d+)?)\s*h/);
    if (hrMatch) {
      const hrs = Number(hrMatch[1]);
      if (Number.isFinite(hrs) && hrs > 0) return Math.round(hrs * 3600000);
    }
    const minMatch = text.match(/(\d+(?:\.\d+)?)\s*m/);
    if (minMatch) {
      const mins = Number(minMatch[1]);
      if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60000);
    }
    return DEFAULT_GARDENER_INTERVAL_MS;
  }

  function formatCountdownRemaining(remainingMs) {
    const ms = Math.max(0, Number(remainingMs) || 0);
    const totalMin = Math.ceil(ms / 60000);
    if (totalMin <= 1) return '<1m';
    const hrs = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hrs <= 0) return `${mins}m`;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }

  function formatUtcHhMm(epochMs) {
    const d = new Date(epochMs);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm} UTC`;
  }

  function resolveNextGardenerRunMs(agent, scheduler, nowMs) {
    const directCandidates = [
      agent && agent.next_run_at,
      agent && agent.nextRunAt,
      scheduler && scheduler.next_run_at,
      scheduler && scheduler.nextRunAt,
    ];
    for (let i = 0; i < directCandidates.length; i += 1) {
      const raw = directCandidates[i];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }

    const hint = scheduler && typeof scheduler.next_run_hint === 'string' ? scheduler.next_run_hint : '';
    const timeMatch = hint.match(/(\d{1,2}):(\d{2})\s*UTC/i);
    const base = new Date(nowMs);
    if (timeMatch) {
      const targetH = Math.max(0, Math.min(23, Number(timeMatch[1])));
      const targetM = Math.max(0, Math.min(59, Number(timeMatch[2])));
      let candidate = Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        targetH,
        targetM,
        0,
        0
      );
      if (/tomorrow/i.test(hint) && candidate <= nowMs + 12 * 3600000) {
        if (candidate <= nowMs) {
          candidate += 24 * 3600000;
        }
      } else if (candidate <= nowMs) {
        candidate += 24 * 3600000;
      }
      return candidate;
    }

    // Fallback to OnCalendar=00/6:15 -> 00:15, 06:15, 12:15, 18:15 UTC
    const slots = [0, 6, 12, 18];
    const curH = base.getUTCHours();
    const curM = base.getUTCMinutes();
    for (let i = 0; i < slots.length; i += 1) {
      const h = slots[i];
      if (h > curH || (h === curH && 15 > curM)) {
        return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, 15, 0, 0);
      }
    }
    return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, 0, 15, 0, 0);
  }

  function computeGardenerCountdown(agent, scheduler, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const nowMs = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();
    const sched = scheduler && typeof scheduler === 'object' ? scheduler : {};
    const intervalMs = parseIntervalMs(sched.interval || 'Every 6h');
    const enabled = sched.enabled !== false;
    const isRunning = Boolean(
      o.isRunning != null
        ? o.isRunning
        : (agent && agent.status === 'running')
    );

    const nextRunMs = resolveNextGardenerRunMs(agent, sched, nowMs);
    const nextUtcText = formatUtcHhMm(nextRunMs);
    const nextUtcLabel = nextUtcText ? `Next ${nextUtcText}` : '';

    let lastRunMs = NaN;
    const lastCandidates = [
      agent && agent.last_run_at,
      agent && agent.lastRunAt,
      sched && sched.last_run_at,
      sched && sched.lastRunAt,
    ];
    for (let i = 0; i < lastCandidates.length; i += 1) {
      const raw = lastCandidates[i];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        lastRunMs = raw;
        break;
      }
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) {
          lastRunMs = parsed;
          break;
        }
      }
    }

    if (isRunning) {
      let runProgress = NaN;
      if (agent && agent.progress != null && agent.progress !== '' && Number.isFinite(Number(agent.progress))) {
        const rawP = Number(agent.progress);
        runProgress = rawP > 1 ? rawP / 100 : rawP;
      } else if (agent && agent.progress_pct != null && agent.progress_pct !== '' && Number.isFinite(Number(agent.progress_pct))) {
        runProgress = Number(agent.progress_pct) / 100;
      } else {
        const startedRaw =
          (agent && (agent.started_at || agent.startedAt)) ||
          o.startedAtMs ||
          null;
        let startedMs = NaN;
        if (typeof startedRaw === 'number' && Number.isFinite(startedRaw)) {
          startedMs = startedRaw;
        } else if (typeof startedRaw === 'string' && startedRaw.trim()) {
          startedMs = Date.parse(startedRaw);
        }
        const elapsedRunMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 6000;
        runProgress = 0.16 + 0.78 * (1 - Math.exp(-elapsedRunMs / 22000));
      }
      const clampedRun = Math.max(0.08, Math.min(0.96, Number.isFinite(runProgress) ? runProgress : 0.35));
      return {
        isRunning: true,
        enabled,
        progress: clampedRun,
        pct: Math.round(clampedRun * 100),
        nextRunMs,
        lastRunMs: Number.isFinite(lastRunMs) ? lastRunMs : null,
        remainingMs: 0,
        remainingLabel: 'running',
        nextUtcLabel,
      };
    }

    if (!enabled) {
      return {
        isRunning: false,
        enabled: false,
        progress: 0,
        pct: 0,
        nextRunMs,
        lastRunMs: Number.isFinite(lastRunMs) ? lastRunMs : null,
        remainingMs: Math.max(0, nextRunMs - nowMs),
        remainingLabel: 'paused',
        nextUtcLabel: 'Paused',
      };
    }

    const validWindowLast =
      Number.isFinite(lastRunMs) &&
      lastRunMs < nextRunMs &&
      (nextRunMs - lastRunMs) <= intervalMs * 1.15;
    const windowStartMs = validWindowLast ? lastRunMs : (nextRunMs - intervalMs);
    const windowSpanMs = Math.max(60000, nextRunMs - windowStartMs);
    const elapsedMs = Math.max(0, Math.min(windowSpanMs, nowMs - windowStartMs));
    const remainingMs = Math.max(0, nextRunMs - nowMs);
    const rawProgress = elapsedMs / windowSpanMs;
    const progress = Math.max(0.04, Math.min(1, Number.isFinite(rawProgress) ? rawProgress : 0.04));

    return {
      isRunning: false,
      enabled: true,
      progress,
      pct: Math.round(progress * 100),
      nextRunMs,
      lastRunMs: Number.isFinite(lastRunMs) ? lastRunMs : null,
      remainingMs,
      remainingLabel: formatCountdownRemaining(remainingMs),
      nextUtcLabel,
    };
  }

  function renderGardenerCountdownRingSvg(agent, scheduler, opts) {
    ensureGardenerRingStyles();
    const o = opts && typeof opts === 'object' ? opts : {};
    const info = computeGardenerCountdown(agent, scheduler, o);
    const isRunning = info.isRunning;
    const isError = !isRunning && agent && agent.status === 'error';
    const isDone = !isRunning && !isError && agent && toNonNegInt(agent.runs_count) > 0;
    const statusCls = o.statusCls || (isRunning ? 'is-running' : (isError ? 'is-error' : (isDone ? 'is-done' : 'is-idle')));
    const statusName = isRunning ? 'running' : (isError ? 'error' : (isDone ? 'done' : 'idle'));
    const visualProgress = Math.max(0.12, Math.min(1, Number.isFinite(info.progress) ? info.progress : 0.12));
    const offset = Number((GARDENER_RING_CIRCUMFERENCE * (1 - visualProgress)).toFixed(2));
    const agentId = agent && agent.id ? String(agent.id) : (o.fallbackId || 'gardener');
    const agentName = agent && agent.name ? String(agent.name) : (o.fallbackName || 'Taste Gardener');
    const tip = o.tooltip || (
      isRunning
        ? `${agentName}: running (${info.pct}%)${agent && agent.current_task ? ' - ' + agent.current_task : ''}`
        : !info.enabled
          ? `${agentName}: scheduler paused`
          : `${agentName}: ${info.nextUtcLabel || 'Scheduled'} (in ${info.remainingLabel}, ${info.pct}%)`
    );

    return (
      '<span class="gardener-countdown-ring ' + statusCls + '"' +
        ' data-gardener-ring="true"' +
        ' data-gardener-id="' + escAttr(agentId) + '"' +
        ' data-status="' + escAttr(statusName) + '"' +
        ' data-progress="' + info.pct + '"' +
        ' data-visual-progress="' + Math.round(visualProgress * 100) + '"' +
        ' data-next-utc="' + escAttr(info.nextUtcLabel) + '"' +
        ' data-remaining="' + escAttr(info.remainingLabel) + '"' +
        ' title="' + escAttr(tip) + '"' +
        ' aria-hidden="true">' +
        '<svg class="gardener-countdown-svg" width="18" height="18" viewBox="0 0 18 18" focusable="false">' +
          '<circle class="gardener-ring-track" cx="9" cy="9" r="' + GARDENER_RING_RADIUS + '" />' +
          '<circle class="gardener-ring-arc" cx="9" cy="9" r="' + GARDENER_RING_RADIUS + '"' +
            ' stroke-dasharray="' + GARDENER_RING_CIRCUMFERENCE + '"' +
            ' stroke-dashoffset="' + offset + '"' +
            ' transform="rotate(-90 9 9)" />' +
          '<circle class="gardener-ring-core" cx="9" cy="9" r="2.2" />' +
        '</svg>' +
      '</span>'
    );
  }

  function escHtml(value) {
    return stripEmDash(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    return escHtml(value).replace(/`/g, '&#96;');
  }

  function isValidHexColor(value) {
    if (typeof value !== 'string') return false;
    return HEX_COLOR_RE.test(value.trim());
  }

  function sanitizeHexColor(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
  }

  function contrastInkForHex(validHex) {
    const raw = validHex.slice(1);
    let r = 0;
    let g = 0;
    let b = 0;
    if (raw.length === 3 || raw.length === 4) {
      r = parseInt(raw[0] + raw[0], 16);
      g = parseInt(raw[1] + raw[1], 16);
      b = parseInt(raw[2] + raw[2], 16);
    } else if (raw.length >= 6) {
      r = parseInt(raw.slice(0, 2), 16);
      g = parseInt(raw.slice(2, 4), 16);
      b = parseInt(raw.slice(4, 6), 16);
    } else {
      return '#ffffff';
    }
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#111111' : '#ffffff';
  }

  function clampPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return Math.round(n);
  }

  function toNonNegInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function getDoc() {
    if (typeof document !== 'undefined') return document;
    if (root && root.document) return root.document;
    return null;
  }

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (root && root.window) return root.window;
    return root || null;
  }

  function getTasteFx() {
    const win = getWin();
    if (win && win.KizukiTasteFx) return win.KizukiTasteFx;
    if (root && root.KizukiTasteFx) return root.KizukiTasteFx;
    return null;
  }

  function getBoardWidgets() {
    const win = getWin();
    if (win && win.KizukiBoardWidgets) return win.KizukiBoardWidgets;
    if (root && root.KizukiBoardWidgets) return root.KizukiBoardWidgets;
    return null;
  }

  function getSound() {
    const win = getWin();
    if (win && win.KizukiSound) return win.KizukiSound;
    if (root && root.KizukiSound) return root.KizukiSound;
    return null;
  }

  function playSound(method, arg) {
    const sound = getSound();
    if (!sound || typeof sound[method] !== 'function') return;
    try {
      if (arguments.length > 1) {
        sound[method](arg);
      } else {
        sound[method]();
      }
    } catch {
      // ignore optional sound synthesis errors
    }
  }

  function getIcon(name, size, className) {
    const iconName = String(name || 'sparkle_ai');
    const iconSize = Number.isFinite(Number(size)) ? Number(size) : 14;
    try {
      const lib = root && root.KizukiIcons;
      if (lib && typeof lib.svg === 'function') {
        const rendered = lib.svg(iconName, { size: iconSize, className: className || '' });
        if (typeof rendered === 'string' && rendered.indexOf('<svg') !== -1) {
          return rendered;
        }
      }
    } catch {
      // fall through to inline fallback icon
    }
    return FALLBACK_ICONS[iconName] || FALLBACK_ICONS.sparkle_ai;
  }

  function formatTimestamp(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return stripEmDash(raw).slice(0, 16);
    }
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${min}`;
  }

  function formatRelativeTime(raw, nowMs) {
    if (!raw || typeof raw !== 'string') return '';
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return formatTimestamp(raw);
    const ref = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const diffSec = Math.max(0, Math.floor((ref - t) / 1000));
    if (diffSec < 45) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 14) return `${diffDay}d ago`;
    return formatTimestamp(raw);
  }

  function formatDurationMs(rawMs) {
    const ms = Number(rawMs);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
    const mins = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }

  function resolveDomainMeta(domainId) {
    if (!domainId || domainId === 'all') {
      return {
        id: 'all',
        label: 'All Domains',
        icon: 'grid',
        description: 'Cross-domain calibration across UI, typography, brand, motion, film, objects, spaces, and agents.',
      };
    }
    if (Object.prototype.hasOwnProperty.call(DOMAIN_META_MAP, domainId)) {
      return DOMAIN_META_MAP[domainId];
    }
    const label = stripEmDash(String(domainId))
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id: String(domainId),
      label: label || 'Domain',
      icon: 'sparkle_ai',
      description: '',
    };
  }

  const DOMAIN_SLUG_RE = /\b(ui_product|typography_copy|visual_brand|motion_feel|video_anime|merch_objects|spaces_life|agent_ops)\b/g;

  function humanizeDomainSlugs(text) {
    const raw = stripEmDash(text == null ? '' : text);
    if (!raw) return '';
    return raw.replace(DOMAIN_SLUG_RE, (slug) => {
      const meta = resolveDomainMeta(slug);
      return meta && meta.label ? meta.label : slug;
    });
  }

  function splitScheduleHint(rawHint) {
    const full = stripEmDash(rawHint || '').trim();
    if (!full) return { visible: '', tooltip: '' };
    const visible = full
      .replace(/\s*\(\s*OnCalendar=[^)]*\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      visible: visible || full,
      tooltip: full,
    };
  }

  function compactScheduleNext(rawVisible) {
    const s = stripEmDash(rawVisible || '').trim();
    if (!s) return '';
    const timeMatch = s.match(/(\d{1,2}:\d{2}\s*UTC)/i);
    if (timeMatch) {
      return 'Next ' + timeMatch[1].replace(/\s+/g, ' ').toUpperCase();
    }
    return s
      .replace(/^Next\s+sweep\s+/i, 'Next ')
      .replace(/\s+tomorrow$/i, '')
      .trim();
  }

  function buildSchematicFingerprint(preview) {
    const parts = [
      preview.schematic,
      preview.pattern,
      preview.curve,
      preview.badge,
      preview.sample_head,
      preview.sample_body,
      preview.label,
      preview.timing,
      preview.spec,
    ];
    if (Array.isArray(preview.tokens)) {
      parts.push(preview.tokens.join(' '));
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function renderLayoutSchematicSvg(preview) {
    const fp = buildSchematicFingerprint(preview);
    let inner = '';
    let variant = 'grid';

    if (/bloomberg|4-pane|multi-pane|wall-to-wall|war room|terminal|quad|mosaic|bento/.test(fp)) {
      variant = 'quad';
      inner =
        '<rect x="2" y="2" width="24" height="12" rx="1.5" class="t-sch-cell"/>' +
        '<rect x="30" y="2" width="24" height="12" rx="1.5" class="t-sch-cell is-accent"/>' +
        '<rect x="2" y="18" width="16" height="12" rx="1.5" class="t-sch-cell"/>' +
        '<rect x="22" y="18" width="32" height="12" rx="1.5" class="t-sch-cell"/>' +
        '<line x1="33" y1="8" x2="50" y2="8" class="t-sch-accent-stroke"/>';
    } else if (/drawer|slide|asymmetric|split|editorial|inspector|focus/.test(fp)) {
      variant = 'split';
      inner =
        '<rect x="2" y="2" width="34" height="28" rx="2" class="t-sch-frame"/>' +
        '<line x1="8" y1="10" x2="28" y2="10" class="t-sch-line-strong"/>' +
        '<line x1="8" y1="16" x2="24" y2="16" class="t-sch-line"/>' +
        '<line x1="8" y1="21" x2="20" y2="21" class="t-sch-line"/>' +
        '<rect x="39" y="2" width="15" height="28" rx="1.5" class="t-sch-cell is-accent"/>' +
        '<line x1="39" y1="2" x2="39" y2="30" class="t-sch-accent-stroke"/>';
    } else if (/single|1 card|minimal|decision|air|centered|quiet|sparse|calm/.test(fp)) {
      variant = 'focus';
      inner =
        '<rect x="12" y="4" width="32" height="24" rx="2.5" class="t-sch-frame"/>' +
        '<line x1="18" y1="11" x2="38" y2="11" class="t-sch-line-strong"/>' +
        '<line x1="21" y1="16" x2="35" y2="16" class="t-sch-line"/>' +
        '<rect x="20" y="21" width="16" height="3.5" rx="1.5" class="t-sch-accent-fill"/>';
    } else if (/hairline|swiss|engraved|1px|architect|razor|ruled|border/.test(fp)) {
      variant = 'hairline';
      inner =
        '<rect x="2" y="2" width="52" height="28" rx="1" class="t-sch-frame"/>' +
        '<line x1="2" y1="10" x2="54" y2="10" class="t-sch-line"/>' +
        '<line x1="20" y1="2" x2="20" y2="30" class="t-sch-line"/>' +
        '<line x1="38" y1="10" x2="38" y2="30" class="t-sch-line"/>' +
        '<line x1="2" y1="2" x2="20" y2="2" class="t-sch-accent-stroke"/>' +
        '<circle cx="20" cy="10" r="1.4" class="t-sch-accent-fill"/>';
    } else if (/bevel|tactile|elevat|card|shadow|layer|glass|depth|machined|hardware/.test(fp)) {
      variant = 'bevel';
      inner =
        '<rect x="4" y="5" width="48" height="23" rx="3" class="t-sch-cell"/>' +
        '<rect x="7" y="8" width="42" height="17" rx="2" class="t-sch-frame"/>' +
        '<line x1="9" y1="8.5" x2="47" y2="8.5" class="t-sch-accent-stroke"/>' +
        '<line x1="12" y1="15" x2="34" y2="15" class="t-sch-line-strong"/>' +
        '<line x1="12" y1="20" x2="26" y2="20" class="t-sch-line"/>';
    } else {
      variant = 'cockpit';
      inner =
        '<rect x="2" y="2" width="13" height="28" rx="1.5" class="t-sch-cell"/>' +
        '<line x1="5" y1="8" x2="12" y2="8" class="t-sch-accent-stroke"/>' +
        '<line x1="5" y1="13" x2="11" y2="13" class="t-sch-line"/>' +
        '<line x1="5" y1="18" x2="12" y2="18" class="t-sch-line"/>' +
        '<rect x="18" y="2" width="36" height="7" rx="1.2" class="t-sch-cell is-accent"/>' +
        '<rect x="18" y="12" width="36" height="7" rx="1.2" class="t-sch-frame"/>' +
        '<rect x="18" y="22" width="36" height="8" rx="1.2" class="t-sch-frame"/>';
    }

    return (
      '<span class="taste-preview-schematic-box is-layout is-' + variant + '" aria-hidden="true">' +
        '<svg class="taste-preview-schematic-svg" viewBox="0 0 56 32" width="56" height="32" fill="none" focusable="false">' +
          inner +
        '</svg>' +
      '</span>'
    );
  }

  function renderMotionSchematicSvg(preview) {
    const fp = buildSchematicFingerprint(preview);
    let inner = '';
    let variant = 'ease';

    if (/spring|bounce|overshoot|physics|elastic|tactile|detent|playful/.test(fp)) {
      variant = 'spring';
      inner =
        '<line x1="4" y1="26" x2="52" y2="26" class="t-sch-line"/>' +
        '<line x1="4" y1="10" x2="52" y2="10" class="t-sch-line" stroke-dasharray="2 2"/>' +
        '<path d="M4 26 C 12 26, 15 5, 22 6 C 28 7, 30 13, 36 10.5 C 41 8.8, 45 10.2, 52 10" class="t-sch-accent-stroke"/>' +
        '<circle cx="22" cy="6" r="1.7" class="t-sch-accent-fill"/>' +
        '<circle cx="52" cy="10" r="1.7" class="t-sch-accent-fill"/>';
    } else if (/step|2s|3s|anime|discrete|frame|hold|snap-step|choppy|cel/.test(fp)) {
      variant = 'stepped';
      inner =
        '<line x1="4" y1="26" x2="52" y2="26" class="t-sch-line"/>' +
        '<path d="M4 26 H16 V20 H28 V14 H40 V8 H52" class="t-sch-accent-stroke"/>' +
        '<circle cx="16" cy="20" r="1.5" class="t-sch-accent-fill"/>' +
        '<circle cx="28" cy="14" r="1.5" class="t-sch-accent-fill"/>' +
        '<circle cx="40" cy="8" r="1.5" class="t-sch-accent-fill"/>';
    } else if (/instant|zero|snappy|crisp|120ms|140ms|150ms|fast|tight|direct|brisk|linear/.test(fp)) {
      variant = 'snappy';
      inner =
        '<line x1="4" y1="26" x2="52" y2="26" class="t-sch-line"/>' +
        '<line x1="4" y1="6" x2="4" y2="26" class="t-sch-line"/>' +
        '<path d="M4 26 C 7 10, 14 7, 52 7" class="t-sch-accent-stroke"/>' +
        '<circle cx="14" cy="9" r="1.7" class="t-sch-accent-fill"/>' +
        '<circle cx="52" cy="7" r="1.7" class="t-sch-accent-fill"/>';
    } else if (/subtle|calm|minimal|quiet|reduced|still|none|restrained|gentle/.test(fp)) {
      variant = 'subtle';
      inner =
        '<line x1="4" y1="24" x2="52" y2="24" class="t-sch-line"/>' +
        '<path d="M4 21 C 18 20.5, 34 15.5, 52 15" class="t-sch-accent-stroke"/>' +
        '<circle cx="4" cy="21" r="1.4" class="t-sch-accent-fill"/>' +
        '<circle cx="52" cy="15" r="1.4" class="t-sch-accent-fill"/>';
    } else {
      variant = 'choreographed';
      inner =
        '<line x1="4" y1="26" x2="52" y2="26" class="t-sch-line"/>' +
        '<path d="M4 26 C 18 26, 20 8, 34 8 C 42 8, 46 8, 52 8" class="t-sch-accent-stroke"/>' +
        '<circle cx="14" cy="24" r="1.6" class="t-sch-accent-fill"/>' +
        '<circle cx="28" cy="12" r="1.6" class="t-sch-accent-fill"/>' +
        '<circle cx="46" cy="8" r="1.6" class="t-sch-accent-fill"/>';
    }

    return (
      '<span class="taste-preview-schematic-box is-motion is-' + variant + '" aria-hidden="true">' +
        '<svg class="taste-preview-schematic-svg" viewBox="0 0 56 32" width="56" height="32" fill="none" focusable="false">' +
          inner +
        '</svg>' +
      '</span>'
    );
  }

  function renderOptionPreview(preview) {
    if (!preview || typeof preview !== 'object') return '';
    const kind = String(preview.kind || '').toLowerCase().trim();

    if (kind === 'swatch') {
      const rawList = Array.isArray(preview.tokens)
        ? preview.tokens
        : Array.isArray(preview.colors)
          ? preview.colors
          : Array.isArray(preview.swatches)
            ? preview.swatches
            : Array.isArray(preview.palette)
              ? preview.palette
              : Array.isArray(preview.hexes)
                ? preview.hexes
                : [];
      const chips = [];
      for (let i = 0; i < rawList.length; i += 1) {
        const item = rawList[i];
        const rawHex = typeof item === 'string'
          ? item
          : (item && (item.hex || item.color || item.value)) || '';
        const safeHex = sanitizeHexColor(rawHex);
        if (!safeHex) continue;
        const textInk = contrastInkForHex(safeHex);
        const label = typeof item === 'object' && item && (item.label || item.name)
          ? String(item.label || item.name)
          : safeHex;
        chips.push(
          '<span class="taste-swatch taste-swatch-chip" style="background-color:' + safeHex + ';color:' + textInk + '" title="' + escAttr(label) + '">' +
            '<span class="taste-swatch-hex">' + escHtml(safeHex) + '</span>' +
          '</span>'
        );
      }
      if (!chips.length) {
        return '<div class="taste-opt-preview"><span class="taste-preview-spec">Palette preview unavailable</span></div>';
      }
      const caption = preview.badge || preview.sample_head || preview.caption || preview.label || '';
      return (
        '<div class="taste-opt-preview">' +
          '<div class="taste-preview-swatches">' + chips.join('') + '</div>' +
          (caption
            ? '<div class="taste-preview-swatches-meta"><span>' + escHtml(caption) + '</span><span>' + chips.length + ' swatches</span></div>'
            : '') +
        '</div>'
      );
    }

    if (kind === 'type') {
      const head = preview.sample_head || preview.sample || preview.specimen || preview.headline || preview.text || '';
      const sub = preview.sample_body || preview.sub || preview.subtext || preview.body || '';
      const meta = preview.badge || preview.meta || preview.spec || preview.font || preview.family || preview.caption || '';
      if (!head && !sub && !meta) return '';
      return (
        '<div class="taste-opt-preview">' +
          '<div class="taste-preview-type">' +
            (head ? '<div class="taste-preview-type-head">' + escHtml(head) + '</div>' : '') +
            (sub ? '<div class="taste-preview-type-sub">' + escHtml(sub) + '</div>' : '') +
            (meta ? '<div class="taste-preview-type-meta">' + escHtml(meta) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    }

    if (kind === 'copy') {
      const quote = preview.sample_body || preview.quote || preview.sample_head || preview.sample || preview.text || preview.snippet || '';
      const note = preview.badge || preview.tone || preview.meta || preview.caption || (preview.sample_head && preview.sample_body ? preview.sample_head : '');
      if (!quote && !note) return '';
      return (
        '<div class="taste-opt-preview">' +
          '<div class="taste-preview-copy">' +
            (quote ? '<div>&ldquo;' + escHtml(quote) + '&rdquo;</div>' : '') +
            (note ? '<div class="taste-preview-copy-note">' + escHtml(note) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    }

    if (kind === 'layout' || kind === 'motion') {
      const tokensList = Array.isArray(preview.tokens)
        ? preview.tokens.map((t) => stripEmDash(String(t || '')).trim()).filter(Boolean).slice(0, 3)
        : [];
      const tokenSummary = tokensList.join(' / ');
      const label = preview.sample_head || preview.schematic || preview.label || preview.pattern || preview.curve || preview.sample || preview.text || tokenSummary;
      const spec = preview.badge || preview.spec || preview.timing || preview.meta || preview.caption || '';
      if (!label && !spec && !tokensList.length) return '';
      const cls = kind === 'motion' ? 'taste-preview-motion' : 'taste-preview-layout';
      const schematicHtml = kind === 'layout'
        ? renderLayoutSchematicSvg(preview)
        : renderMotionSchematicSvg(preview);
      const tokensHtml = tokensList.length
        ? '<div class="taste-preview-tokens">' +
            tokensList.map((tok) => '<span class="taste-preview-token-pill">' + escHtml(tok) + '</span>').join('') +
          '</div>'
        : '';
      return (
        '<div class="taste-opt-preview">' +
          '<div class="' + cls + ' taste-preview-schematic">' +
            schematicHtml +
            '<div class="taste-preview-schematic-copy">' +
              '<div class="taste-preview-schematic-top">' +
                '<span class="taste-preview-schematic-label">' + escHtml(label || (kind === 'motion' ? 'Motion profile' : 'Layout structure')) + '</span>' +
                (spec ? '<span class="taste-preview-spec">' + escHtml(spec) + '</span>' : '') +
              '</div>' +
              tokensHtml +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }

    const fallbackText = preview.sample_head || preview.sample_body || preview.text || preview.sample || preview.label || '';
    if (!fallbackText) return '';
    return (
      '<div class="taste-opt-preview">' +
        '<div class="taste-preview-layout">' +
          '<span>' + escHtml(fallbackText) + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function normalizePayload(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const rawStats = data.stats && typeof data.stats === 'object' ? data.stats : {};
    const rawDomains = Array.isArray(data.domains) ? data.domains : [];
    const domainById = Object.create(null);

    for (let i = 0; i < rawDomains.length; i += 1) {
      const d = rawDomains[i];
      if (!d || !d.id) continue;
      domainById[String(d.id)] = d;
    }

    const domains = [];
    const seenIds = Object.create(null);
    for (let i = 0; i < DEFAULT_DOMAINS.length; i += 1) {
      const def = DEFAULT_DOMAINS[i];
      const incoming = domainById[def.id] || {};
      const answered = toNonNegInt(incoming.answered);
      const total = toNonNegInt(incoming.total);
      const pct = incoming.pct != null ? clampPct(incoming.pct) : (total > 0 ? clampPct((answered / total) * 100) : 0);
      domains.push({
        id: def.id,
        label: stripEmDash(incoming.label || def.label),
        description: stripEmDash(incoming.description || def.description),
        icon: def.icon,
        answered,
        total,
        pct,
        signature_traits: Array.isArray(incoming.signature_traits)
          ? incoming.signature_traits.map((t) => stripEmDash(t)).filter(Boolean)
          : [],
        recent_verdicts: Array.isArray(incoming.recent_verdicts) ? incoming.recent_verdicts : [],
      });
      seenIds[def.id] = true;
    }

    for (let i = 0; i < rawDomains.length; i += 1) {
      const d = rawDomains[i];
      if (!d || !d.id || seenIds[String(d.id)]) continue;
      const meta = resolveDomainMeta(d.id);
      const answered = toNonNegInt(d.answered);
      const total = toNonNegInt(d.total);
      domains.push({
        id: String(d.id),
        label: stripEmDash(d.label || meta.label),
        description: stripEmDash(d.description || meta.description),
        icon: meta.icon,
        answered,
        total,
        pct: d.pct != null ? clampPct(d.pct) : (total > 0 ? clampPct((answered / total) * 100) : 0),
        signature_traits: Array.isArray(d.signature_traits)
          ? d.signature_traits.map((t) => stripEmDash(t)).filter(Boolean)
          : [],
        recent_verdicts: Array.isArray(d.recent_verdicts) ? d.recent_verdicts : [],
      });
    }

    const queue = Array.isArray(data.queue) ? data.queue : [];
    const answeredHistory = Array.isArray(data.answered_history) ? data.answered_history : [];
    const rawRules = data.rules && typeof data.rules === 'object' ? data.rules : {};
    const rules = {
      prefer: Array.isArray(rawRules.prefer) ? rawRules.prefer : [],
      avoid: Array.isArray(rawRules.avoid) ? rawRules.avoid : [],
    };
    const vaultDocs = Array.isArray(data.vault_docs) ? data.vault_docs : [];

    const totalQuestions = rawStats.total_questions != null
      ? toNonNegInt(rawStats.total_questions)
      : domains.reduce((acc, d) => acc + d.total, 0);
    const answeredCount = rawStats.answered_count != null
      ? toNonNegInt(rawStats.answered_count)
      : domains.reduce((acc, d) => acc + d.answered, 0);
    const remainingCount = rawStats.remaining_count != null
      ? toNonNegInt(rawStats.remaining_count)
      : Math.max(0, totalQuestions - answeredCount);
    const calibrationPct = rawStats.calibration_pct != null
      ? clampPct(rawStats.calibration_pct)
      : (totalQuestions > 0 ? clampPct((answeredCount / totalQuestions) * 100) : 0);

    return {
      stats: {
        total_questions: totalQuestions,
        answered_count: answeredCount,
        remaining_count: remainingCount,
        skipped_count: toNonNegInt(rawStats.skipped_count),
        custom_rules_count: rawStats.custom_rules_count != null
          ? toNonNegInt(rawStats.custom_rules_count)
          : (rules.prefer.length + rules.avoid.length),
        vault_docs_count: rawStats.vault_docs_count != null
          ? toNonNegInt(rawStats.vault_docs_count)
          : vaultDocs.length,
        calibration_pct: calibrationPct,
        streak_count: toNonNegInt(rawStats.streak_count),
      },
      domains,
      queue,
      answered_history: answeredHistory,
      rules,
      vault_docs: vaultDocs,
      compiled_codex_path: typeof data.compiled_codex_path === 'string' && data.compiled_codex_path.trim()
        ? data.compiled_codex_path.trim()
        : 'world/taste-codex.md',
    };
  }

  function toStringArray(val) {
    if (Array.isArray(val)) {
      return val.map((v) => stripEmDash(typeof v === 'string' ? v : (v && (v.text || v.label || v.title || v.name)) || '').trim()).filter(Boolean);
    }
    if (typeof val === 'string' && val.trim()) {
      return [stripEmDash(val).trim()];
    }
    return [];
  }

  function parseDepthLevel(rawDepth) {
    if (typeof rawDepth === 'number' && Number.isFinite(rawDepth)) {
      return Math.max(1, Math.min(5, Math.round(rawDepth)));
    }
    if (typeof rawDepth === 'string') {
      const m = rawDepth.match(/(\d+)/);
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) {
          return Math.max(1, Math.min(5, Math.round(parsed)));
        }
      }
    }
    return 1;
  }

  function normalizePolicyPolarity(rawVal) {
    const token = String(rawVal || '').trim().toLowerCase();
    if (
      token === 'never' ||
      token === 'avoid' ||
      token === 'dont' ||
      token === "don't" ||
      token === 'ban' ||
      token === 'forbid' ||
      token === 'must_not' ||
      token === 'must not' ||
      token === 'anti'
    ) {
      return { badge: 'NEVER', tastePolarity: 'avoid' };
    }
    return { badge: 'MUST', tastePolarity: 'prefer' };
  }

  function normalizeDomainCultivation(raw, domainId) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const id = String(d.domain || d.id || domainId || '').trim();
    const meta = resolveDomainMeta(id);
    const depthLevel = parseDepthLevel(d.depth_level != null ? d.depth_level : (d.depth != null ? d.depth : d.level));

    const rawStages = Array.isArray(d.mastery_path)
      ? d.mastery_path
      : Array.isArray(d.mastery_stages)
        ? d.mastery_stages
        : Array.isArray(d.path_to_mastery)
          ? d.path_to_mastery
          : Array.isArray(d.stages)
            ? d.stages
            : [];
    const masteryStages = rawStages.slice(0, 4).map((st, idx) => {
      const item = st && typeof st === 'object' ? st : { title: String(st || '') };
      const lvl = Number.isFinite(Number(item.level || item.stage))
        ? Math.max(1, Math.min(4, Math.round(Number(item.level || item.stage))))
        : idx + 1;
      const fallbackName = DEFAULT_MASTERY_STAGE_NAMES[lvl - 1] || `Stage ${lvl}`;
      return {
        level: lvl,
        name: stripEmDash(item.name || item.title || item.label || fallbackName).trim() || fallbackName,
        description: stripEmDash(item.description || item.summary || item.focus || '').trim(),
        milestones: toStringArray(item.milestones || item.criteria || item.skills || item.indicators),
        diagnostic_test: stripEmDash(item.diagnostic_test || item.diagnostic || item.litmus_test || item.test || item.check || '').trim(),
      };
    });

    const rawFrameworks = Array.isArray(d.frameworks)
      ? d.frameworks
      : Array.isArray(d.operational_frameworks)
        ? d.operational_frameworks
        : [];
    const frameworks = rawFrameworks.map((fw, idx) => {
      const item = fw && typeof fw === 'object' ? fw : { name: String(fw || '') };
      return {
        id: String(item.id || `${id}-fw-${idx + 1}`),
        name: stripEmDash(item.name || item.title || `Framework ${idx + 1}`).trim(),
        purpose: stripEmDash(item.purpose || item.summary || item.description || '').trim(),
        steps: toStringArray(item.steps || item.procedure || item.stages),
        when_to_use: stripEmDash(item.when_to_use || item.trigger || item.use_when || item.application || '').trim(),
      };
    }).filter((fw) => fw.name);

    const rawPrinciples = Array.isArray(d.principles)
      ? d.principles
      : Array.isArray(d.core_principles)
        ? d.core_principles
        : [];
    const principles = rawPrinciples.map((pr, idx) => {
      const item = pr && typeof pr === 'object' ? pr : { title: String(pr || '') };
      const antiList = toStringArray(item.anti_pattern || item.anti_patterns || item.avoid || item.failure_mode);
      return {
        id: String(item.id || `${id}-pr-${idx + 1}`),
        title: stripEmDash(item.title || item.name || item.principle || item.statement || `Principle ${idx + 1}`).trim(),
        explanation: stripEmDash(item.explanation || item.rationale || item.detail || item.why || '').trim(),
        anti_pattern: antiList.join('; '),
      };
    }).filter((pr) => pr.title);

    const rawPolicies = Array.isArray(d.policies)
      ? d.policies
      : Array.isArray(d.enforced_policies)
        ? d.enforced_policies
        : [];
    const policies = rawPolicies.map((pol, idx) => {
      const item = pol && typeof pol === 'object' ? pol : { statement: String(pol || '') };
      const polKind = normalizePolicyPolarity(item.polarity || item.type || item.mode || item.rule_type || item.kind || item.directive);
      const statement = stripEmDash(item.statement || item.rule || item.policy || item.text || item.title || '').trim();
      return {
        id: String(item.id || `${id}-pol-${idx + 1}`),
        badge: polKind.badge,
        taste_polarity: polKind.tastePolarity,
        statement,
        rationale: stripEmDash(item.rationale || item.reason || item.why || item.enforcement || '').trim(),
      };
    }).filter((pol) => pol.statement);

    const rawPractices = Array.isArray(d.best_practices)
      ? d.best_practices
      : Array.isArray(d.practices)
        ? d.practices
        : [];
    const bestPractices = rawPractices.map((bp, idx) => {
      const item = bp && typeof bp === 'object' ? bp : { title: String(bp || '') };
      return {
        id: String(item.id || `${id}-bp-${idx + 1}`),
        title: stripEmDash(item.title || item.name || item.practice || item.statement || '').trim(),
        detail: stripEmDash(item.detail || item.rationale || item.description || item.how || '').trim(),
      };
    }).filter((bp) => bp.title || bp.detail);

    const rawCanons = Array.isArray(d.reference_canons)
      ? d.reference_canons
      : Array.isArray(d.canons)
        ? d.canons
        : Array.isArray(d.benchmarks)
          ? d.benchmarks
          : Array.isArray(d.references)
            ? d.references
            : [];
    const referenceCanons = rawCanons.map((rc, idx) => {
      const item = rc && typeof rc === 'object' ? rc : { name: String(rc || '') };
      return {
        id: String(item.id || `${id}-canon-${idx + 1}`),
        name: stripEmDash(item.name || item.title || item.studio || item.benchmark || item.source || '').trim(),
        kind: stripEmDash(item.kind || item.type || item.role || item.category || 'Reference').trim(),
        rationale: stripEmDash(item.rationale || item.why || item.lesson || item.notes || item.description || '').trim(),
      };
    }).filter((rc) => rc.name);

    return {
      domain: id,
      label: stripEmDash(d.label || d.title || meta.label),
      thesis: stripEmDash(d.thesis || d.domain_thesis || d.summary || d.overview || meta.description || '').trim(),
      depth_level: depthLevel,
      depth_label: `L${depthLevel}`,
      dossier_path: typeof (d.dossier_path || d.path || d.markdown_path || d.vault_path) === 'string'
        ? String(d.dossier_path || d.path || d.markdown_path || d.vault_path).trim()
        : '',
      updated_at: typeof (d.updated_at || d.last_cultivated_at || d.last_run_at) === 'string'
        ? String(d.updated_at || d.last_cultivated_at || d.last_run_at).trim()
        : '',
      gardener_id: String(d.gardener_id || d.owner_gardener_id || '').trim(),
      mastery_stages: masteryStages,
      frameworks,
      principles,
      policies,
      best_practices: bestPractices,
      reference_canons: referenceCanons,
    };
  }

  function normalizeGardenersPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rawGardeners = Array.isArray(raw.gardeners) ? raw.gardeners : [];
    const gardeners = rawGardeners.map((g, idx) => {
      const item = g && typeof g === 'object' ? g : {};
      const statusRaw = String(item.status || 'idle').trim().toLowerCase();
      const status = statusRaw === 'running' || statusRaw === 'error' ? statusRaw : 'idle';
      return {
        id: String(item.id || `gardener-${idx + 1}`).trim(),
        name: stripEmDash(item.name || `Gardener ${idx + 1}`).trim(),
        specialty: stripEmDash(item.specialty || '').trim(),
        domains: Array.isArray(item.domains) ? item.domains.map((dom) => String(dom || '').trim()).filter(Boolean) : [],
        status,
        current_task: stripEmDash(item.current_task || '').trim(),
        last_run_at: typeof (item.last_run_at || item.lastRunAt) === 'string'
          ? String(item.last_run_at || item.lastRunAt).trim()
          : '',
        next_run_at: typeof (item.next_run_at || item.nextRunAt) === 'string'
          ? String(item.next_run_at || item.nextRunAt).trim()
          : '',
        started_at: typeof (item.started_at || item.startedAt) === 'string'
          ? String(item.started_at || item.startedAt).trim()
          : '',
        progress: item.progress != null && item.progress !== '' && Number.isFinite(Number(item.progress))
          ? Number(item.progress)
          : null,
        progress_pct: item.progress_pct != null && item.progress_pct !== '' && Number.isFinite(Number(item.progress_pct))
          ? Number(item.progress_pct)
          : null,
        runs_count: toNonNegInt(item.runs_count),
        items_cultivated: toNonNegInt(item.items_cultivated),
        last_engine: stripEmDash(item.last_engine || 'Local LLM').trim() || 'Local LLM',
        last_summary: stripTasteFenceBlocks(item.last_summary || ''),
      };
    });

    const domainsMap = Object.create(null);
    if (Array.isArray(raw.domains)) {
      for (let i = 0; i < raw.domains.length; i += 1) {
        const entry = raw.domains[i];
        if (!entry || typeof entry !== 'object') continue;
        const domId = String(entry.domain || entry.id || '').trim();
        if (!domId) continue;
        domainsMap[domId] = normalizeDomainCultivation(entry, domId);
      }
    } else if (raw.domains && typeof raw.domains === 'object') {
      const keys = Object.keys(raw.domains);
      for (let i = 0; i < keys.length; i += 1) {
        const domId = keys[i];
        const entry = raw.domains[domId];
        if (!entry || typeof entry !== 'object') continue;
        domainsMap[domId] = normalizeDomainCultivation(entry, domId);
      }
    }

    const domainValues = Object.keys(domainsMap).map((k) => domainsMap[k]);
    const rawActivity = Array.isArray(raw.activity_log) ? raw.activity_log : [];
    const activityLog = rawActivity.map((ev, idx) => {
      const item = ev && typeof ev === 'object' ? ev : {};
      const metricsObj = item.metrics && typeof item.metrics === 'object' && !Array.isArray(item.metrics)
        ? item.metrics
        : {};
      return {
        id: String(item.id || `act-${idx + 1}`),
        ts: typeof item.ts === 'string' ? item.ts.trim() : (typeof item.timestamp === 'string' ? item.timestamp.trim() : ''),
        gardener_id: String(item.gardener_id || '').trim(),
        gardener_name: stripEmDash(item.gardener_name || item.gardener_id || 'Taste Gardener').trim(),
        domain: String(item.domain || '').trim(),
        action: stripEmDash(item.action || 'cultivate').trim(),
        engine: stripEmDash(item.engine || 'Local LLM').trim() || 'Local LLM',
        duration_ms: toNonNegInt(item.duration_ms),
        summary: stripEmDash(item.summary || '').trim(),
        metrics: metricsObj,
        dossier_path: typeof item.dossier_path === 'string' ? item.dossier_path.trim() : '',
      };
    });

    const rawSched = raw.scheduler && typeof raw.scheduler === 'object' ? raw.scheduler : {};
    const scheduler = {
      timer_unit: stripEmDash(rawSched.timer_unit || '').trim(),
      interval: stripEmDash(rawSched.interval || 'Every 6h').trim() || 'Every 6h',
      enabled: rawSched.enabled !== false,
      next_run_hint: stripEmDash(rawSched.next_run_hint || '').trim(),
      next_run_at: typeof (rawSched.next_run_at || rawSched.nextRunAt) === 'string'
        ? String(rawSched.next_run_at || rawSched.nextRunAt).trim()
        : '',
      last_run_at: typeof (rawSched.last_run_at || rawSched.lastRunAt) === 'string'
        ? String(rawSched.last_run_at || rawSched.lastRunAt).trim()
        : '',
    };

    const rawStats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const runningCount = rawStats.gardeners_running != null
      ? toNonNegInt(rawStats.gardeners_running)
      : gardeners.filter((g) => g.status === 'running').length;
    const cultivatedCount = rawStats.domains_cultivated != null
      ? toNonNegInt(rawStats.domains_cultivated)
      : domainValues.length;

    const stats = {
      gardeners_total: rawStats.gardeners_total != null ? toNonNegInt(rawStats.gardeners_total) : (gardeners.length || 5),
      gardeners_running: runningCount,
      domains_cultivated: cultivatedCount,
      domains_total: rawStats.domains_total != null ? toNonNegInt(rawStats.domains_total) : DEFAULT_DOMAINS.length,
      total_frameworks: rawStats.total_frameworks != null
        ? toNonNegInt(rawStats.total_frameworks)
        : domainValues.reduce((acc, d) => acc + d.frameworks.length, 0),
      total_principles: rawStats.total_principles != null
        ? toNonNegInt(rawStats.total_principles)
        : domainValues.reduce((acc, d) => acc + d.principles.length, 0),
      total_policies: rawStats.total_policies != null
        ? toNonNegInt(rawStats.total_policies)
        : domainValues.reduce((acc, d) => acc + d.policies.length, 0),
      total_best_practices: rawStats.total_best_practices != null
        ? toNonNegInt(rawStats.total_best_practices)
        : domainValues.reduce((acc, d) => acc + d.best_practices.length, 0),
      total_mastery_stages: rawStats.total_mastery_stages != null
        ? toNonNegInt(rawStats.total_mastery_stages)
        : domainValues.reduce((acc, d) => acc + d.mastery_stages.length, 0),
      runs_total: rawStats.runs_total != null
        ? toNonNegInt(rawStats.runs_total)
        : gardeners.reduce((acc, g) => acc + g.runs_count, 0),
    };

    return {
      stats,
      gardeners,
      domains: domainsMap,
      activity_log: activityLog,
      scheduler,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at.trim() : '',
    };
  }

  function isElementHiddenOrInactive(el) {
    if (!el) return true;
    if (el.hidden === true) return true;
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return true;
    if (el.isConnected === false) return true;

    if (typeof el.closest === 'function') {
      if (el.closest('[hidden]')) return true;
      const viewPanel = el.closest('#view-taste, .view-panel');
      if (viewPanel) {
        if (viewPanel.hidden === true) return true;
        if (typeof viewPanel.hasAttribute === 'function' && viewPanel.hasAttribute('hidden')) return true;
        if (viewPanel.classList && viewPanel.classList.contains('view-panel') && !viewPanel.classList.contains('is-active')) {
          return true;
        }
      }
    }

    const win = getWin();
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
      } catch {
        // ignore style lookup failure in synthetic DOMs
      }
    }
    return false;
  }

  function isFormFieldElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (typeof el.getAttribute === 'function') {
      const ce = el.getAttribute('contenteditable');
      if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
    }
    return false;
  }

  function isAnyBlockingModalOpen() {
    const doc = getDoc();
    if (!doc || typeof doc.querySelector !== 'function') return false;

    const modalSelectors = [
      '#cmdk-backdrop:not([hidden])',
      '#chat-modal-backdrop:not([hidden])',
      '#replay-import-backdrop:not([hidden])',
      '[data-codex-modal-backdrop]:not([hidden])',
      '.codex-modal-backdrop:not([hidden])',
      '[role="dialog"][aria-modal="true"]',
    ];

    for (let i = 0; i < modalSelectors.length; i += 1) {
      let node = null;
      try {
        node = doc.querySelector(modalSelectors[i]);
      } catch {
        node = null;
      }
      if (!node) continue;
      if (node.hidden === true) continue;
      if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) continue;
      if (typeof node.closest === 'function' && node.closest('[hidden]')) continue;

      const win = getWin();
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const cs = win.getComputedStyle(node);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        } catch {
          // ignore
        }
      }
      return true;
    }
    return false;
  }

  function prefersReducedMotion() {
    try {
      const m = root && root.KizukiMotion;
      if (m && typeof m.prefersReducedMotion === 'function') {
        return Boolean(m.prefersReducedMotion());
      }
    } catch {
      // fallback below
    }
    const doc = getDoc();
    if (doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function') {
      if (doc.documentElement.getAttribute('data-detail') === 'off') return true;
    }
    const win = getWin();
    if (win && typeof win.matchMedia === 'function') {
      try {
        return Boolean(win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }
    return false;
  }

  async function fetchJson(url, opts) {
    const fetchFn = (root && typeof root.fetch === 'function')
      ? root.fetch.bind(root)
      : (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) {
      throw new Error('Fetch API unavailable');
    }
    const nextOpts = opts ? { ...opts } : {};
    const method = String(nextOpts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      nextOpts.headers = { 'X-Kizuki-Request': '1', ...(nextOpts.headers || {}) };
    }
    const res = await fetchFn(url, nextOpts);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `Request failed (${res.status})`;
      const err = new Error(stripEmDash(msg));
      err.status = res.status;
      throw err;
    }
    return body || {};
  }

  function createTasteController() {
    const state = {
      mounted: false,
      container: null,
      hooks: {},
      loading: false,
      error: null,
      activeDomain: 'all',
      activeTab: 'deck',
      data: null,
      loadSeq: 0,
      submitting: false,
      chosenKey: null,
      noteDraft: '',
      generating: false,
      lastGeneration: null,
      rulePolarity: 'prefer',
      ruleDomain: 'ui_product',
      ruleSaving: false,
      ruleDeletingId: null,
      reanswerQuestion: null,
      inlineReanswerId: null,
      vaultSearch: '',
      vaultKind: 'all',
      questionCache: Object.create(null),
      localStreakBoost: 0,
      gardenersData: null,
      gardenersLoading: false,
      gardenersError: null,
      gardenerPollTimer: null,
      gardenerPollSeq: 0,
      gardenerRunningTarget: null,
      gardenerRunStartedAt: Object.create(null),
      gardenerSelectedDomain: 'ui_product',
      policyLockingKey: null,
      lockedPolicyKeys: Object.create(null),
      mobileRailExpanded: false,
      ledgerObserver: null,
      lastDealtQuestionId: null,
      crosslinks: [],
      crosslinksLoaded: false,
    };

    let boundClick = null;
    let boundInput = null;
    let boundChange = null;
    let boundSubmit = null;
    let boundKeydown = null;

    function notify(msg, tone) {
      const text = stripEmDash(msg);
      try {
        if (state.hooks && typeof state.hooks.showToast === 'function') {
          state.hooks.showToast(text, tone || 'info');
        }
      } catch {
        // ignore host toast failure
      }
    }

    function openDocInHost(docPath) {
      const cleanPath = String(docPath || '').trim();
      if (!cleanPath) return;
      try {
        if (state.hooks && typeof state.hooks.openDoc === 'function') {
          state.hooks.openDoc(cleanPath);
          return;
        }
      } catch {
        // fallback toast below
      }
      notify(`Document ready: ${cleanPath}`, 'info');
    }

    function updateHostNavCount() {
      try {
        if (!state.data || !state.data.stats) return;
        if (state.hooks && typeof state.hooks.updateNavCount === 'function') {
          state.hooks.updateNavCount(
            `${clampPct(state.data.stats.calibration_pct)}%`,
            state.data.stats
          );
        }
      } catch {
        // ignore host hook failure
      }
    }

    function cacheQuestionsFromData(data) {
      if (!data) return;
      const qList = Array.isArray(data.queue) ? data.queue : [];
      for (let i = 0; i < qList.length; i += 1) {
        const q = qList[i];
        if (q && q.id) {
          state.questionCache[String(q.id)] = q;
        }
      }
      const hist = Array.isArray(data.answered_history) ? data.answered_history : [];
      for (let i = 0; i < hist.length; i += 1) {
        const h = hist[i];
        const qid = h && (h.question_id || h.id);
        if (qid && Array.isArray(h.options) && h.options.length) {
          state.questionCache[String(qid)] = {
            id: String(qid),
            domain: h.domain || 'ui_product',
            axis: h.axis || '',
            title: h.title || h.question_title || 'Calibration Verdict',
            context: h.context || '',
            options: h.options,
          };
        }
      }
    }

    function applyStatePayload(rawPayload) {
      const hadPrevData = Boolean(state.data);
      const normalized = normalizePayload(rawPayload);
      const tasteFx = getTasteFx();
      if (!hadPrevData && tasteFx && typeof tasteFx.recordRadarSnapshot === 'function') {
        try {
          tasteFx.recordRadarSnapshot(normalized.domains, { radarKey: 'taste-studio-main' });
        } catch {
          // ignore optional radar snapshot seed error
        }
      }
      state.data = normalized;
      state.error = null;
      cacheQuestionsFromData(normalized);
      if (state.activeDomain !== 'all') {
        state.ruleDomain = state.activeDomain;
        state.gardenerSelectedDomain = state.activeDomain;
      }
      updateHostNavCount();
    }

    function hasRunningGardener(gData) {
      if (!gData || typeof gData !== 'object') return false;
      if (gData.stats && toNonNegInt(gData.stats.gardeners_running) > 0) return true;
      if (Array.isArray(gData.gardeners)) {
        for (let i = 0; i < gData.gardeners.length; i += 1) {
          if (gData.gardeners[i] && gData.gardeners[i].status === 'running') {
            return true;
          }
        }
      }
      return false;
    }

    function stopGardenerPolling() {
      state.gardenerPollSeq += 1;
      if (state.gardenerPollTimer != null) {
        clearTimeout(state.gardenerPollTimer);
        state.gardenerPollTimer = null;
      }
    }

    function syncGardenerPolling() {
      if (!state.mounted || !state.container) {
        stopGardenerPolling();
        return;
      }
      if (isElementHiddenOrInactive(state.container)) {
        stopGardenerPolling();
        return;
      }
      if (!hasRunningGardener(state.gardenersData)) {
        stopGardenerPolling();
        return;
      }
      if (state.gardenerPollTimer != null) return;

      const pollSeq = ++state.gardenerPollSeq;
      state.gardenerPollTimer = setTimeout(async () => {
        state.gardenerPollTimer = null;
        if (pollSeq !== state.gardenerPollSeq || !state.mounted || !state.container) return;
        if (isElementHiddenOrInactive(state.container)) {
          stopGardenerPolling();
          return;
        }
        try {
          const raw = await fetchJson('/api/taste/gardeners');
          if (pollSeq !== state.gardenerPollSeq || !state.mounted) return;
          applyGardenersPayload(raw);
          render();
          if (hasRunningGardener(state.gardenersData) && !isElementHiddenOrInactive(state.container)) {
            syncGardenerPolling();
          } else {
            stopGardenerPolling();
          }
        } catch {
          stopGardenerPolling();
        }
      }, GARDENER_POLL_INTERVAL_MS);
    }

    function applyGardenersPayload(rawPayload) {
      const normalized = normalizeGardenersPayload(rawPayload);
      if (!normalized) return { transitionedToIdle: false };
      const wasRunning = hasRunningGardener(state.gardenersData);
      const nowMs = Date.now();
      for (let i = 0; i < normalized.gardeners.length; i += 1) {
        const g = normalized.gardeners[i];
        if (!g || !g.id) continue;
        if (g.status === 'running') {
          if (!state.gardenerRunStartedAt[g.id]) {
            state.gardenerRunStartedAt[g.id] = g.started_at ? (Date.parse(g.started_at) || nowMs) : nowMs;
          }
        } else {
          delete state.gardenerRunStartedAt[g.id];
        }
      }
      state.gardenersData = normalized;
      state.gardenersError = null;
      if (state.activeDomain !== 'all') {
        state.gardenerSelectedDomain = state.activeDomain;
      } else if (!normalized.domains[state.gardenerSelectedDomain]) {
        const domainKeys = Object.keys(normalized.domains);
        if (domainKeys.length > 0) {
          state.gardenerSelectedDomain = domainKeys[0];
        }
      }
      const isNowRunning = hasRunningGardener(normalized);
      const transitionedToIdle = Boolean(wasRunning && !isNowRunning);
      if (transitionedToIdle) {
        playSound('chime');
      }
      syncGardenerPolling();
      return { transitionedToIdle };
    }

    async function fetchGardenersSilent() {
      try {
        return await fetchJson('/api/taste/gardeners');
      } catch (err) {
        if (err && err.status === 404) {
          return null;
        }
        return null;
      }
    }

    async function fetchCrosslinksSilent() {
      try {
        const raw = await fetchJson('/api/crosslinks?kind=taste');
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.links)) return raw.links;
        if (raw && Array.isArray(raw.crosslinks)) return raw.crosslinks;
        if (raw && Array.isArray(raw.items)) return raw.items;
        return [];
      } catch {
        return [];
      }
    }

    function resolveDomainGapTier(pct, minPct, maxPct) {
      const fx = getTasteFx();
      if (fx && typeof fx.resolveGapTier === 'function') {
        return fx.resolveGapTier(pct, minPct, maxPct);
      }
      const p = clampPct(pct);
      const hasSpread = Number.isFinite(minPct) && Number.isFinite(maxPct) && (maxPct - minPct) >= 10;
      if (p >= 100) return 'calibrated';
      if (p < 75 || (hasSpread && p <= minPct && p < 95)) return 'gap';
      if (p < 85) return 'mid';
      return 'strong';
    }

    function computeWeeklyDomainDeltas(domains, history) {
      const weeklyDeltas = Object.create(null);
      const weeklyPrevPcts = Object.create(null);
      const list = Array.isArray(domains) ? domains : [];
      const hist = Array.isArray(history) ? history : [];
      const cutoffMs = Date.now() - 7 * 24 * 3600 * 1000;
      const recentByDomain = Object.create(null);
      let totalRecent7d = 0;

      for (let i = 0; i < hist.length; i += 1) {
        const h = hist[i];
        if (!h || !h.domain) continue;
        const tsRaw = h.answered_at || h.timestamp || '';
        const ts = tsRaw ? Date.parse(tsRaw) : NaN;
        if (Number.isFinite(ts) && ts >= cutoffMs) {
          recentByDomain[h.domain] = (recentByDomain[h.domain] || 0) + 1;
          totalRecent7d += 1;
        }
      }

      for (let i = 0; i < list.length; i += 1) {
        const d = list[i];
        if (!d || !d.id) continue;
        const recentCount = recentByDomain[d.id] || 0;
        const total = Math.max(1, toNonNegInt(d.total));
        const deltaPct = recentCount > 0 ? Math.min(d.pct, Math.round((recentCount / total) * 100)) : 0;
        weeklyDeltas[d.id] = deltaPct;
        weeklyPrevPcts[d.id] = Math.max(0, clampPct(d.pct) - deltaPct);
      }

      return { weeklyDeltas, weeklyPrevPcts, totalRecent7d };
    }

    function getRuleCrosslinks(rule) {
      if (!rule || typeof rule !== 'object') return [];
      const out = [];
      const seen = Object.create(null);

      function addLink(raw) {
        if (!raw || typeof raw !== 'object') return;
        const codexId = String(
          raw.codex_id || raw.codexId || raw.target_id || raw.targetId || raw.principle_id || raw.id || ''
        ).trim();
        const title = stripEmDash(
          raw.codex_title || raw.codexTitle || raw.target_title || raw.targetTitle || raw.title || raw.principle || codexId
        ).trim();
        if (!title) return;
        const relRaw = String(raw.relation || raw.kind || raw.type || 'reinforces').toLowerCase();
        const relation = relRaw.includes('conflict') ? 'conflicts' : 'reinforces';
        const score = Number.isFinite(Number(raw.score || raw.similarity))
          ? Math.round(Number(raw.score || raw.similarity) * (Number(raw.score || raw.similarity) <= 1 ? 100 : 1))
          : null;
        const key = `${codexId || title.toLowerCase()}::${relation}`;
        if (seen[key]) return;
        seen[key] = true;
        out.push({ codexId, title, relation, score });
      }

      if (Array.isArray(rule.links)) {
        for (let i = 0; i < rule.links.length; i += 1) {
          addLink(rule.links[i]);
        }
      }

      const ruleId = String(rule.id || '').trim();
      const ruleTextLower = stripTasteFenceBlocks(rule.rule || '').toLowerCase();
      const crosslinks = Array.isArray(state.crosslinks) ? state.crosslinks : [];
      for (let i = 0; i < crosslinks.length; i += 1) {
        const cl = crosslinks[i];
        if (!cl || typeof cl !== 'object') continue;
        const clTasteId = String(cl.taste_id || cl.tasteId || cl.rule_id || cl.ruleId || cl.source_id || cl.sourceId || '').trim();
        const clTasteText = stripEmDash(cl.taste_rule || cl.tasteRule || cl.source_title || '').trim().toLowerCase();
        if ((ruleId && clTasteId && clTasteId === ruleId) || (ruleTextLower && clTasteText && clTasteText === ruleTextLower)) {
          addLink(cl);
        }
      }

      return out.slice(0, 3);
    }

    function getSelectedMasteryDomainId() {
      if (state.activeDomain && state.activeDomain !== 'all') {
        return state.activeDomain;
      }
      if (state.gardenerSelectedDomain && state.gardenerSelectedDomain !== 'all') {
        return state.gardenerSelectedDomain;
      }
      return DEFAULT_DOMAINS[0].id;
    }

    function isPolicyAlreadyLocked(domain, polarity, statement, policyKey) {
      if (policyKey && state.lockedPolicyKeys[policyKey]) return true;
      if (!state.data || !state.data.rules) return false;
      const list = polarity === 'avoid' ? state.data.rules.avoid : state.data.rules.prefer;
      if (!Array.isArray(list)) return false;
      const needle = stripEmDash(statement || '').trim().toLowerCase();
      if (!needle) return false;
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i];
        if (!r || !r.rule) continue;
        if (r.domain && domain && r.domain !== domain && r.domain !== 'all') continue;
        if (stripEmDash(r.rule).trim().toLowerCase() === needle) return true;
      }
      return false;
    }

    function getActiveDomainQueue() {
      if (!state.data) return [];
      const queue = Array.isArray(state.data.queue) ? state.data.queue : [];
      if (state.activeDomain === 'all') return queue;
      return queue.filter((q) => q && q.domain === state.activeDomain);
    }

    function getActiveQuestion() {
      if (state.reanswerQuestion) return state.reanswerQuestion;
      const queue = getActiveDomainQueue();
      return queue.length > 0 ? queue[0] : null;
    }

    function getNextUncalibratedDomain() {
      if (!state.data || !Array.isArray(state.data.domains)) return null;
      const domains = state.data.domains;
      const startIdx = domains.findIndex((d) => d.id === state.activeDomain);
      for (let offset = 1; offset <= domains.length; offset += 1) {
        const idx = (startIdx + offset) % domains.length;
        const candidate = domains[idx];
        if (!candidate || candidate.id === state.activeDomain) continue;
        const rem = Math.max(0, candidate.total - candidate.answered);
        if (rem > 0) return candidate;
      }
      return null;
    }

    function getFilteredRules(list) {
      if (!Array.isArray(list)) return [];
      if (state.activeDomain === 'all') return list;
      return list.filter((r) => !r || !r.domain || r.domain === 'all' || r.domain === state.activeDomain);
    }

    function getFilteredHistory() {
      const hist = (state.data && Array.isArray(state.data.answered_history))
        ? state.data.answered_history
        : [];
      if (state.activeDomain === 'all') return hist;
      return hist.filter((h) => h && h.domain === state.activeDomain);
    }

    function getFilteredVaultDocs() {
      const docs = (state.data && Array.isArray(state.data.vault_docs))
        ? state.data.vault_docs
        : [];
      const q = state.vaultSearch.trim().toLowerCase();
      return docs.filter((doc) => {
        if (!doc) return false;
        if (state.activeDomain !== 'all' && doc.domain && doc.domain !== state.activeDomain) {
          return false;
        }
        const kindToken = String(doc.kind || doc.category || doc.polarity || '').toLowerCase();
        const isAnti = kindToken.includes('anti') || String(doc.polarity || '').toLowerCase() === 'avoid';
        const isExemplar = kindToken.includes('exemplar') || (!isAnti && String(doc.polarity || '').toLowerCase() === 'prefer');
        if (state.vaultKind === 'exemplar' && !isExemplar) return false;
        if (state.vaultKind === 'anti' && !isAnti) return false;
        if (q) {
          const hay = `${doc.title || ''} ${doc.category || ''} ${doc.domain || ''} ${doc.brand || ''} ${doc.medium || ''} ${doc.vault_doc_path || doc.path || doc.source_path || ''} ${doc.summary || doc.excerpt || ''} ${doc.kind || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function renderRailGardenerStripHtml() {
      const gData = state.gardenersData;
      const gStats = gData ? gData.stats : null;
      const gardeners = gData && Array.isArray(gData.gardeners) ? gData.gardeners : [];
      const scheduler = gData && gData.scheduler ? gData.scheduler : { interval: 'Every 6h', enabled: true, next_run_hint: '' };
      const totalAgents = gStats ? gStats.gardeners_total : 5;
      const runningAgents = gStats ? gStats.gardeners_running : 0;
      const isAnyRunning = runningAgents > 0 || state.gardenerRunningTarget === 'all';
      const domainsCultivated = gStats ? gStats.domains_cultivated : 0;
      const domainsTotal = gStats ? gStats.domains_total : DEFAULT_DOMAINS.length;
      const frameworksCount = gStats ? gStats.total_frameworks : 0;
      const policiesCount = gStats ? gStats.total_policies : 0;

      const dotCount = gardeners.length > 0 ? gardeners.length : 5;
      const nowMs = Date.now();
      const ringsHtml = [];
      for (let i = 0; i < dotCount; i += 1) {
        const agent = gardeners[i] || null;
        const agentRunning = Boolean(
          (agent && agent.status === 'running') ||
          state.gardenerRunningTarget === 'all' ||
          (agent && state.gardenerRunningTarget === `gardener:${agent.id}`)
        );
        const startedAtMs = agent && agent.id ? state.gardenerRunStartedAt[agent.id] : null;
        ringsHtml.push(
          renderGardenerCountdownRingSvg(agent, scheduler, {
            nowMs,
            isRunning: agentRunning,
            startedAtMs,
            fallbackId: `gardener-${i + 1}`,
            fallbackName: `Taste Gardener ${i + 1}`,
          })
        );
      }

      const compactInterval = String(scheduler.interval || 'Every 6h')
        .replace(/^every\s+/i, '')
        .trim() || '6h';
      const cadenceText = scheduler.enabled !== false
        ? `Auto ${compactInterval}`
        : 'Auto Paused';
      const hintInfo = splitScheduleHint(scheduler.next_run_hint);
      const nextFallback = computeGardenerCountdown(gardeners[0] || null, scheduler, { nowMs, isRunning: false }).nextUtcLabel;
      const nextText = isAnyRunning
        ? `${Math.max(1, runningAgents)} running`
        : (compactScheduleNext(hintInfo.visible) || nextFallback || (gData ? 'Idle' : 'Ready'));
      const nextTooltip = isAnyRunning ? nextText : (hintInfo.tooltip || nextText);

      return (
        '<section class="taste-gardener-strip' + (isAnyRunning ? ' is-running' : '') + '" aria-label="Live Taste Gardeners">' +
          '<div class="taste-gardener-strip-head">' +
            '<div class="taste-gardener-strip-title-wrap">' +
              '<span class="taste-gardener-strip-eyebrow">Live Cultivation</span>' +
              '<h3 class="taste-gardener-strip-title">' + totalAgents + ' Taste Gardeners</h3>' +
            '</div>' +
            '<div class="taste-gardener-dots has-rings" aria-label="Gardener 6-hour countdown rings">' + ringsHtml.join('') + '</div>' +
          '</div>' +
          '<div class="taste-gardener-strip-metrics">' +
            '<div class="taste-gardener-strip-stat">' +
              '<span class="taste-gardener-strip-val">' + domainsCultivated + '/' + domainsTotal + '</span>' +
              '<span class="taste-gardener-strip-lbl">Domains</span>' +
            '</div>' +
            '<div class="taste-gardener-strip-stat">' +
              '<span class="taste-gardener-strip-val">' + frameworksCount + '</span>' +
              '<span class="taste-gardener-strip-lbl">Frameworks</span>' +
            '</div>' +
            '<div class="taste-gardener-strip-stat">' +
              '<span class="taste-gardener-strip-val">' + policiesCount + '</span>' +
              '<span class="taste-gardener-strip-lbl">Policies</span>' +
            '</div>' +
          '</div>' +
          '<div class="taste-gardener-strip-schedule" title="' + escAttr(nextTooltip) + '">' +
            '<span class="taste-gardener-strip-cadence">' + escHtml(cadenceText) + '</span>' +
            '<span class="taste-gardener-strip-sep" aria-hidden="true">&middot;</span>' +
            '<span class="taste-gardener-strip-next">' + escHtml(nextText) + '</span>' +
          '</div>' +
          '<div class="taste-gardener-strip-actions">' +
            '<button type="button" class="taste-gardener-strip-btn" data-taste-tab="gardeners">' +
              getIcon('layers', 12) +
              '<span>Inspect Gardeners</span>' +
            '</button>' +
            '<button type="button" class="taste-gardener-strip-btn is-primary" data-gardener-run-all' + (isAnyRunning ? ' disabled' : '') + '>' +
              getIcon('action_plane', 11) +
              '<span>' + (isAnyRunning ? 'Running...' : 'Run All') + '</span>' +
            '</button>' +
          '</div>' +
        '</section>'
      );
    }

    function renderRailHtml() {
      const data = state.data;
      const stats = data ? data.stats : {
        total_questions: 0,
        answered_count: 0,
        remaining_count: 0,
        custom_rules_count: 0,
        vault_docs_count: 0,
        calibration_pct: 0,
        streak_count: 0,
      };
      const totalRulesCount = data && data.rules
        ? ((Array.isArray(data.rules.prefer) ? data.rules.prefer.length : 0) +
           (Array.isArray(data.rules.avoid) ? data.rules.avoid.length : 0))
        : toNonNegInt(stats.custom_rules_count);
      const domains = data ? data.domains : DEFAULT_DOMAINS.map((d) => ({
        id: d.id,
        label: d.label,
        description: d.description,
        icon: d.icon,
        answered: 0,
        total: 0,
        pct: 0,
        signature_traits: [],
      }));

      const pct = clampPct(stats.calibration_pct);
      const ringOffset = Number((RING_CIRCUMFERENCE * (1 - pct / 100)).toFixed(2));
      const allActive = state.activeDomain === 'all';
      const codexPath = (data && data.compiled_codex_path) || 'world/taste-codex.md';
      const gStats = state.gardenersData ? state.gardenersData.stats : null;
      const totalAgents = gStats ? gStats.gardeners_total : 5;
      const domainsCultivated = gStats ? gStats.domains_cultivated : 0;
      const domainsTotal = gStats ? gStats.domains_total : DEFAULT_DOMAINS.length;
      const railCls = 'taste-rail' + (state.mobileRailExpanded ? ' is-mobile-expanded' : '');

      let railMinPct = 100;
      let railMaxPct = 0;
      for (let i = 0; i < domains.length; i += 1) {
        const p = clampPct(domains[i].pct);
        if (p < railMinPct) railMinPct = p;
        if (p > railMaxPct) railMaxPct = p;
      }

      const domainRowsHtml = domains.map((d) => {
        const isActive = state.activeDomain === d.id;
        const isComplete = d.total > 0 && d.answered >= d.total;
        const dPct = clampPct(d.pct);
        const gapTier = resolveDomainGapTier(dPct, railMinPct, railMaxPct);
        const topTrait = (d.signature_traits && d.signature_traits[0])
          ? d.signature_traits[0]
          : (isComplete ? 'Calibrated' : 'Ready to fine-tune');
        const btnCls = 'taste-domain-btn is-tier-' + gapTier +
          (isActive ? ' is-active' : '') +
          (isComplete ? ' is-calibrated' : '');
        return (
          '<button type="button" class="' + btnCls + '" data-taste-domain="' + escAttr(d.id) + '" data-gap-tier="' + gapTier + '" role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '">' +
            '<div class="taste-domain-top">' +
              '<span class="taste-domain-label-wrap">' +
                '<span class="taste-domain-dot" aria-hidden="true"></span>' +
                getIcon(d.icon, 13) +
                '<span class="taste-domain-name">' + escHtml(d.label) + '</span>' +
              '</span>' +
              '<span class="taste-domain-count">' + d.answered + '/' + d.total + '</span>' +
            '</div>' +
            '<div class="taste-domain-bar" aria-hidden="true">' +
              '<div class="taste-domain-fill" style="width:' + dPct + '%"></div>' +
            '</div>' +
            '<div class="taste-domain-row">' +
              '<span class="taste-domain-trait">' + escHtml(topTrait) + '</span>' +
              '<span class="taste-domain-pct is-tier-' + gapTier + '">' + dPct + '%</span>' +
            '</div>' +
          '</button>'
        );
      }).join('');

      return (
        '<aside class="' + railCls + '" aria-label="Taste Calibration Rail">' +
          '<div class="taste-mobile-summary">' +
            '<div class="taste-mobile-summary-text">' +
              '<span class="taste-mobile-summary-pct">' + pct + '%</span>' +
              '<span class="taste-mobile-summary-sep" aria-hidden="true">&middot;</span>' +
              '<span>' + stats.answered_count + '/' + stats.total_questions + '</span>' +
              '<span class="taste-mobile-summary-sep" aria-hidden="true">&middot;</span>' +
              '<span>' + totalAgents + ' Gardeners (' + domainsCultivated + '/' + domainsTotal + ')</span>' +
            '</div>' +
            '<button type="button" class="taste-mobile-details-btn" data-taste-mobile-details aria-expanded="' + (state.mobileRailExpanded ? 'true' : 'false') + '">' +
              '<span>' + (state.mobileRailExpanded ? 'Hide' : 'Details') + '</span>' +
              getIcon('chevron_down', 11) +
            '</button>' +
          '</div>' +
          '<header class="taste-rail-head">' +
            '<span class="taste-rail-eyebrow">Calibration Instrument</span>' +
            '<h1 class="taste-rail-title">Taste Studio</h1>' +
            '<p class="taste-rail-sub">Rapid-fire fine-tuning across 8 domains.</p>' +
          '</header>' +
          '<section class="taste-meter-card" aria-label="Overall Taste Calibration">' +
            '<div class="taste-meter-top">' +
              '<div class="taste-meter-ring-wrap">' +
                '<svg class="taste-meter-ring" viewBox="0 0 56 56" aria-hidden="true">' +
                  '<circle class="taste-meter-ring-track" cx="28" cy="28" r="' + RING_RADIUS + '"/>' +
                  '<circle class="taste-meter-ring-fill" cx="28" cy="28" r="' + RING_RADIUS + '"' +
                    ' stroke-dasharray="' + RING_CIRCUMFERENCE + '"' +
                    ' stroke-dashoffset="' + ringOffset + '"/>' +
                '</svg>' +
                '<span class="taste-meter-ring-value">' + pct + '%</span>' +
              '</div>' +
              '<div class="taste-meter-info">' +
                '<span class="taste-meter-label">Taste Calibration</span>' +
                '<span class="taste-meter-value">' + stats.answered_count + ' / ' + stats.total_questions + '</span>' +
                '<span class="taste-meter-meta">' + stats.answered_count + ' / ' + stats.total_questions + ' calibrated &middot; ' + pct + '%</span>' +
              '</div>' +
            '</div>' +
            '<div class="taste-meter-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Taste calibration progress">' +
              '<div class="taste-meter-fill" style="width:' + pct + '%"></div>' +
            '</div>' +
            '<div class="taste-meter-stats">' +
              '<div class="taste-meter-stat">' +
                '<span class="taste-meter-stat-val">' + stats.remaining_count + '</span>' +
                '<span class="taste-meter-stat-lbl">Queued</span>' +
              '</div>' +
              '<div class="taste-meter-stat">' +
                '<span class="taste-meter-stat-val">' + totalRulesCount + '</span>' +
                '<span class="taste-meter-stat-lbl">Rules</span>' +
              '</div>' +
              '<div class="taste-meter-stat">' +
                '<span class="taste-meter-stat-val">' + stats.vault_docs_count + '</span>' +
                '<span class="taste-meter-stat-lbl">Vault</span>' +
              '</div>' +
            '</div>' +
          '</section>' +
          '<div class="taste-rail-section-label">' +
            '<span>Domains</span>' +
            '<span class="tabular">' + domains.length + '</span>' +
          '</div>' +
          '<nav class="taste-domain-list" role="tablist" aria-label="Taste calibration domains">' +
            '<button type="button" class="taste-domain-btn' + (allActive ? ' is-active' : '') + (stats.total_questions > 0 && stats.remaining_count === 0 ? ' is-calibrated' : '') + '" data-taste-domain="all" role="tab" aria-selected="' + (allActive ? 'true' : 'false') + '">' +
              '<div class="taste-domain-top">' +
                '<span class="taste-domain-label-wrap">' +
                  '<span class="taste-domain-dot" aria-hidden="true"></span>' +
                  getIcon('grid', 13) +
                  '<span class="taste-domain-name">All Domains</span>' +
                '</span>' +
                '<span class="taste-domain-count">' + stats.answered_count + '/' + stats.total_questions + '</span>' +
              '</div>' +
              '<div class="taste-domain-bar" aria-hidden="true">' +
                '<div class="taste-domain-fill" style="width:' + pct + '%"></div>' +
              '</div>' +
              '<div class="taste-domain-row">' +
                '<span class="taste-domain-pct">' + (stats.remaining_count > 0 ? `${stats.remaining_count} remaining` : 'Fully calibrated') + '</span>' +
                '<span class="taste-domain-pct">' + pct + '%</span>' +
              '</div>' +
            '</button>' +
            domainRowsHtml +
          '</nav>' +
          renderRailGardenerStripHtml() +
          '<footer class="taste-rail-footer">' +
            '<button type="button" class="taste-codex-btn" data-taste-open-codex="' + escAttr(codexPath) + '">' +
              '<span class="taste-domain-label-wrap">' +
                getIcon('book', 13) +
                '<span>Open Compiled taste-codex.md</span>' +
              '</span>' +
              getIcon('external', 12) +
            '</button>' +
            '<button type="button" class="taste-codex-btn taste-board-jump-btn" data-taste-open-board="box/taste">' +
              '<span class="taste-domain-label-wrap">' +
                getIcon('grid', 13) +
                '<span>Open #box/taste Board</span>' +
              '</span>' +
              getIcon('external', 12) +
            '</button>' +
          '</footer>' +
        '</aside>'
      );
    }

    function renderHeaderHtml() {
      const data = state.data;
      const activeMeta = resolveDomainMeta(state.activeDomain);
      const queueLen = getActiveDomainQueue().length;
      const rulesCount = data
        ? (getFilteredRules(data.rules.prefer).length + getFilteredRules(data.rules.avoid).length)
        : 0;
      const gStats = state.gardenersData ? state.gardenersData.stats : null;
      const gardenersBadge = gStats
        ? (gStats.gardeners_running > 0 ? `${gStats.gardeners_running} live` : `${gStats.domains_cultivated}/${gStats.domains_total}`)
        : '5';
      const vaultCount = data ? data.vault_docs.length : 0;
      const streak = Math.max(
        toNonNegInt(data && data.stats ? data.stats.streak_count : 0),
        state.localStreakBoost
      );

      const genLabel = state.generating
        ? 'Generating via Inkling G4...'
        : 'Generate 5 Fresh Questions (Inkling G4)';
      const genCompactLabel = state.generating
        ? 'Generating...'
        : '+5 Inkling G4';

      let genReceiptHtml = '';
      if (state.lastGeneration && !state.generating) {
        const g = state.lastGeneration;
        const latencyText = g.latency_ms ? ` &middot; ${toNonNegInt(g.latency_ms)}ms` : '';
        genReceiptHtml =
          '<span class="taste-progress-pill" role="status">' +
            '+' + toNonNegInt(g.added_count) + ' via ' + escHtml(g.engine || 'Inkling G4') + latencyText +
          '</span>';
      }

      return (
        '<header class="taste-header">' +
          '<div class="taste-header-left">' +
            '<div class="taste-header-title-wrap taste-header-copy">' +
              '<h2 class="taste-header-title">' + escHtml(activeMeta.label) + '</h2>' +
              (activeMeta.description ? '<p class="taste-header-sub">' + escHtml(activeMeta.description) + '</p>' : '') +
            '</div>' +
            '<div class="taste-mode-tabs taste-tabs" role="tablist" aria-label="Taste Studio views">' +
              '<button type="button" class="taste-mode-tab taste-tab' + (state.activeTab === 'deck' ? ' is-active' : '') + '" role="tab" aria-selected="' + (state.activeTab === 'deck' ? 'true' : 'false') + '" data-taste-tab="deck">' +
                '<span>Fine-Tune Deck</span>' +
                '<span class="taste-mode-count taste-tab-count">' + queueLen + '</span>' +
              '</button>' +
              '<button type="button" class="taste-mode-tab taste-tab' + (state.activeTab === 'rules' ? ' is-active' : '') + '" role="tab" aria-selected="' + (state.activeTab === 'rules' ? 'true' : 'false') + '" data-taste-tab="rules">' +
                '<span>Rules &amp; Genome</span>' +
                '<span class="taste-mode-count taste-tab-count">' + rulesCount + '</span>' +
              '</button>' +
              '<button type="button" class="taste-mode-tab taste-tab' + (state.activeTab === 'gardeners' ? ' is-active' : '') + '" role="tab" aria-selected="' + (state.activeTab === 'gardeners' ? 'true' : 'false') + '" data-taste-tab="gardeners">' +
                '<span>Gardeners &amp; Mastery</span>' +
                '<span class="taste-mode-count taste-tab-count' + (gStats && gStats.gardeners_running > 0 ? ' is-live' : '') + '">' + escHtml(gardenersBadge) + '</span>' +
              '</button>' +
              '<button type="button" class="taste-mode-tab taste-tab' + (state.activeTab === 'vault' ? ' is-active' : '') + '" role="tab" aria-selected="' + (state.activeTab === 'vault' ? 'true' : 'false') + '" data-taste-tab="vault">' +
                '<span>Taste Vault</span>' +
                '<span class="taste-mode-count taste-tab-count">' + vaultCount + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="taste-header-right taste-header-actions">' +
            genReceiptHtml +
            '<button type="button" class="taste-history-change taste-header-board-btn" data-taste-open-board="box/taste" title="Open #box/taste consensus threads on Agent Board" style="gap:5px;">' +
              getIcon('grid', 12) +
              '<span>#box/taste</span>' +
            '</button>' +
            '<span class="taste-streak-pill' + (streak > 0 ? ' is-hot' : '') + '" title="Current calibration streak">' +
              '<span class="taste-streak-dot" aria-hidden="true"></span>' +
              '<span>' + (streak > 0 ? `${streak} streak` : 'Ready') + '</span>' +
            '</span>' +
            '<button type="button" class="taste-generate-btn' + (state.generating ? ' is-loading' : '') + '" data-taste-generate' + (state.generating ? ' disabled' : '') + '>' +
              getIcon('sparkle_ai', 13) +
              '<span class="taste-generate-label-full">' + escHtml(genLabel) + '</span>' +
              '<span class="taste-generate-label-compact">' + escHtml(genCompactLabel) + '</span>' +
            '</button>' +
          '</div>' +
        '</header>'
      );
    }

    function renderDeckHtml() {
      const activeQ = getActiveQuestion();
      const queue = getActiveDomainQueue();
      const activeMeta = resolveDomainMeta(state.activeDomain);
      const activeDomainData = state.data && state.data.domains
        ? state.data.domains.find((d) => d.id === state.activeDomain)
        : null;

      if (!activeQ) {
        const nextDomain = getNextUncalibratedDomain();
        const answeredCount = activeDomainData
          ? activeDomainData.answered
          : (state.data ? state.data.stats.answered_count : 0);
        const totalCount = activeDomainData
          ? activeDomainData.total
          : (state.data ? state.data.stats.total_questions : 0);

        return (
          '<div class="taste-deck-stage">' +
            '<section class="taste-deck-complete" aria-label="Domain calibration complete">' +
              '<div class="taste-complete-mark" aria-hidden="true">' + getIcon('check', 20) + '</div>' +
              '<h3 class="taste-complete-title">' + escHtml(activeMeta.label) + ' Calibrated</h3>' +
              '<p class="taste-complete-sub">' +
                answeredCount + ' / ' + totalCount + ' calibration decisions locked. Generate 5 deeper scenarios via Inkling G4 or jump to the next uncalibrated domain.' +
              '</p>' +
              '<div class="taste-complete-actions">' +
                '<button type="button" class="taste-generate-btn' + (state.generating ? ' is-loading' : '') + '" data-taste-generate' + (state.generating ? ' disabled' : '') + '>' +
                  getIcon('sparkle_ai', 13) +
                  '<span>' + (state.generating ? 'Generating via Inkling G4...' : 'Generate 5 Deeper Questions') + '</span>' +
                '</button>' +
                (nextDomain
                  ? '<button type="button" class="taste-deck-action-btn" data-taste-next-domain="' + escAttr(nextDomain.id) + '">' +
                      '<span>Jump to Next Uncalibrated Domain (' + escHtml(nextDomain.label) + ')</span>' +
                      getIcon('arrow_right', 13) +
                    '</button>'
                  : '<button type="button" class="taste-deck-action-btn" data-taste-tab="rules">' +
                      '<span>Inspect Rules &amp; Genome</span>' +
                      getIcon('arrow_right', 13) +
                    '</button>') +
              '</div>' +
            '</section>' +
          '</div>'
        );
      }

      const qDomainMeta = resolveDomainMeta(activeQ.domain);
      const qDomainData = state.data && state.data.domains
        ? state.data.domains.find((d) => d.id === activeQ.domain)
        : null;
      const progressPct = qDomainData
        ? clampPct(qDomainData.pct)
        : clampPct(state.data && state.data.stats ? state.data.stats.calibration_pct : 0);
      const options = Array.isArray(activeQ.options) ? activeQ.options.slice(0, 4) : [];
      const isReanswering = Boolean(state.reanswerQuestion);
      const canUndo = Boolean(state.data && state.data.answered_history && state.data.answered_history.length > 0 && !state.submitting);

      const optionsHtml = options.map((opt, idx) => {
        const key = String((opt && opt.key) || OPTION_KEYS[idx] || 'A').toUpperCase();
        const keycap = OPTION_TO_KEY[key] || String(idx + 1);
        const isChosen = state.chosenKey === key;
        const cardCls = 'taste-option-card' + (isChosen ? ' is-chosen' : '');
        const previewHtml = renderOptionPreview(opt && opt.preview);
        const traitText = opt && (opt.trait_tag || opt.trait) ? String(opt.trait_tag || opt.trait) : '';
        const rationaleText = opt && (opt.rationale || opt.description || opt.detail)
          ? String(opt.rationale || opt.description || opt.detail)
          : '';

        return (
          '<button type="button" class="' + cardCls + '"' +
            ' data-taste-option-key="' + escAttr(key) + '"' +
            ' data-taste-option-index="' + escAttr(keycap) + '"' +
            ' aria-pressed="' + (isChosen ? 'true' : 'false') + '"' +
            (state.submitting ? ' disabled' : '') + '>' +
            '<div class="taste-opt-head">' +
              '<div class="taste-opt-title-row">' +
                '<kbd class="taste-keycap">' + escHtml(keycap) + '</kbd>' +
                '<span class="taste-opt-label">' + escHtml((opt && opt.label) || `Option ${key}`) + '</span>' +
              '</div>' +
            '</div>' +
            previewHtml +
            (rationaleText ? '<p class="taste-opt-rationale">' + escHtml(rationaleText) + '</p>' : '') +
            (traitText
              ? '<div class="taste-opt-foot">' +
                  '<span class="taste-opt-trait">' + escHtml(traitText) + '</span>' +
                '</div>'
              : '') +
          '</button>'
        );
      }).join('');

      const cardHtml =
        '<article class="taste-question-card" data-question-id="' + escAttr(activeQ.id || '') + '">' +
          '<div class="taste-q-meta">' +
            '<div class="taste-q-badges">' +
              '<span class="taste-q-domain taste-domain-badge">' +
                getIcon(qDomainMeta.icon, 12) +
                '<span>' + escHtml(qDomainMeta.label) + '</span>' +
              '</span>' +
              (activeQ.axis
                ? '<span class="taste-q-axis taste-axis-pill">' + escHtml(activeQ.axis) + '</span>'
                : '') +
              (activeQ.source
                ? '<span class="taste-q-source-pill">' + escHtml(activeQ.source) + '</span>'
                : '') +
            '</div>' +
            '<span class="taste-q-remaining taste-q-counter">' + queue.length + ' remaining</span>' +
          '</div>' +
          '<div class="taste-q-progress-track" aria-hidden="true">' +
            '<div class="taste-q-progress-fill" style="width:' + progressPct + '%"></div>' +
          '</div>' +
          '<div class="taste-q-head">' +
            '<h3 class="taste-q-title">' + escHtml(activeQ.title || 'Calibration Choice') + '</h3>' +
            (activeQ.context
              ? '<p class="taste-q-context">' + escHtml(activeQ.context) + '</p>'
              : '') +
          '</div>' +
          '<div class="taste-options-grid" role="group" aria-label="Calibration choices">' +
            optionsHtml +
          '</div>' +
          '<footer class="taste-deck-footer">' +
            '<div class="taste-deck-footer-top">' +
              '<label for="taste-nuance-note" class="sr-only">Optional nuance note</label>' +
              '<input id="taste-nuance-note" type="text" class="taste-note-input" data-taste-note' +
                ' value="' + escAttr(state.noteDraft) + '"' +
                ' placeholder="Optional nuance note before pressing 1-4 (saved with verdict)..."' +
                ' autocomplete="off">' +
              '<div class="taste-deck-actions">' +
                '<button type="button" class="taste-skip-btn" data-taste-skip' + (state.submitting || isReanswering ? ' disabled' : '') + '>' +
                  '<span>Skip</span>' +
                  '<kbd>S</kbd>' +
                '</button>' +
                '<button type="button" class="taste-undo-btn" data-taste-undo' + (canUndo ? '' : ' disabled') + '>' +
                  getIcon('replay', 12) +
                  '<span>Undo</span>' +
                  '<kbd>U</kbd>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="taste-kbd-legend">' +
              '<div class="taste-kbd-group">' +
                '<span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> Pick option</span>' +
                '<span><kbd>S</kbd> Skip</span>' +
                '<span><kbd>U</kbd> Undo last</span>' +
              '</div>' +
              '<span>Keys active in Deck view</span>' +
            '</div>' +
          '</footer>' +
        '</article>';

      const tasteFx = getTasteFx();
      const remainingCount = isReanswering ? 1 : queue.length;
      let deckCardHtml = cardHtml;
      if (tasteFx && typeof tasteFx.wrapCardInPhysicalStack === 'function') {
        try {
          deckCardHtml = tasteFx.wrapCardInPhysicalStack(cardHtml, remainingCount);
        } catch {
          deckCardHtml = cardHtml;
        }
      }

      return (
        '<div class="taste-deck-stage">' +
          '<div class="taste-deck-ruler">' +
            '<span>' + (isReanswering ? 'RE-CALIBRATING VERDICT' : 'RAPID FINE-TUNE DECK') + '</span>' +
            '<span>' +
              (isReanswering
                ? '<button type="button" class="taste-history-change" data-taste-cancel-reanswer>Cancel Re-answer</button>'
                : `${queue.length} queued in ${escHtml(activeMeta.label)}`) +
            '</span>' +
          '</div>' +
          deckCardHtml +
        '</div>'
      );
    }

    function renderRuleRowHtml(rule, polarity) {
      const id = String((rule && rule.id) || '');
      const domainId = String((rule && rule.domain) || 'ui_product');
      const ruleText = stripTasteFenceBlocks((rule && rule.rule) || '');
      const ruleReason = rule && rule.reason ? stripTasteFenceBlocks(rule.reason) : '';
      const domMeta = resolveDomainMeta(rule && rule.domain);
      const isDeleting = Boolean(id && state.ruleDeletingId === id);
      const canDelete = Boolean(id && (!rule || rule.editable !== false));
      const sourceLabel = rule && rule.source ? stripEmDash(rule.source) : 'calibrated';
      const createdTs = rule && rule.created_at ? formatTimestamp(rule.created_at) : '';
      const docPath = rule && rule.vault_doc_path ? String(rule.vault_doc_path).trim() : '';
      const crosslinks = getRuleCrosslinks(rule);

      const crosslinksHtml = crosslinks.length
        ? '<div class="taste-crosslink-row" aria-label="Linked Mind Codex entries">' +
            crosslinks.map((cl) => (
              '<button type="button" class="taste-crosslink-chip is-' + cl.relation + '"' +
                ' data-taste-open-codex-item="' + escAttr(cl.codexId) + '"' +
                ' data-taste-codex-title="' + escAttr(cl.title) + '"' +
                ' title="' + escAttr((cl.relation === 'conflicts' ? 'Conflicts with Codex: ' : 'Reinforces Codex: ') + cl.title) + '">' +
                '<span class="taste-crosslink-tag">' + (cl.relation === 'conflicts' ? 'CONFLICT' : 'CODEX') + '</span>' +
                '<span class="taste-crosslink-title">' + escHtml(cl.title) + '</span>' +
                (cl.score != null ? '<span class="taste-crosslink-score">' + cl.score + '%</span>' : '') +
              '</button>'
            )).join('') +
          '</div>'
        : '';

      const hasProvenanceDetail = Boolean(ruleReason || createdTs || docPath);
      const provenanceHtml = hasProvenanceDetail
        ? '<details class="taste-rule-provenance">' +
            '<summary class="taste-rule-provenance-summary">' +
              '<span>Provenance &middot; ' + escHtml(sourceLabel) + '</span>' +
              (createdTs ? '<span class="taste-rule-provenance-date">' + escHtml(createdTs) + '</span>' : '') +
            '</summary>' +
            '<div class="taste-rule-provenance-body">' +
              (ruleReason ? '<p class="taste-rule-reason">' + escHtml(ruleReason) + '</p>' : '') +
              (docPath
                ? '<button type="button" class="taste-rule-doc-link" data-taste-open-doc="' + escAttr(docPath) + '">' +
                    getIcon('book', 12) + '<span>' + escHtml(docPath) + '</span>' +
                  '</button>'
                : '') +
            '</div>' +
          '</details>'
        : (rule && rule.source ? '<div class="taste-rule-provenance-static">Source: ' + escHtml(sourceLabel) + '</div>' : '');

      return (
        '<div class="taste-rule-row" data-rule-id="' + escAttr(id) + '">' +
          '<div class="taste-rule-main">' +
            '<div class="taste-rule-top">' +
              '<span class="taste-rule-domain">' + escHtml(domMeta.shortLabel || domMeta.label) + '</span>' +
            '</div>' +
            '<p class="taste-rule-text">' + escHtml(ruleText) + '</p>' +
            crosslinksHtml +
            provenanceHtml +
          '</div>' +
          '<div class="taste-rule-actions">' +
            '<button type="button" class="taste-history-change taste-rule-broadcast"' +
              ' data-taste-broadcast-rule="' + escAttr(id) + '"' +
              ' data-rule-text="' + escAttr(ruleText) + '"' +
              ' data-rule-domain="' + escAttr(domainId) + '"' +
              ' data-rule-polarity="' + escAttr(polarity) + '"' +
              ' title="Broadcast rule to #box/taste on Agent Board"' +
              ' aria-label="Broadcast rule to agents">' +
              getIcon('action_plane', 11) +
              '<span>Broadcast</span>' +
            '</button>' +
            (canDelete
              ? '<button type="button" class="taste-rule-delete" data-taste-delete-rule="' + escAttr(id) + '"' +
                  ' data-taste-delete-domain="' + escAttr(domainId) + '"' +
                  ' data-taste-delete-polarity="' + escAttr(polarity) + '"' +
                  ' aria-label="Delete rule"' + (isDeleting ? ' disabled' : '') + '>' +
                  getIcon('trash', 12) +
                '</button>'
              : '') +
          '</div>' +
        '</div>'
      );
    }

    function renderRulesHtml() {
      const data = state.data;
      const domains = data ? data.domains : [];
      const preferRules = getFilteredRules(data && data.rules ? data.rules.prefer : []);
      const avoidRules = getFilteredRules(data && data.rules ? data.rules.avoid : []);
      const fullHistory = data && Array.isArray(data.answered_history) ? data.answered_history : [];
      const history = getFilteredHistory().slice(0, 20);
      const latestGlobalId = fullHistory[0]
        ? String(fullHistory[0].question_id || fullHistory[0].id || '')
        : '';
      const canUndo = Boolean(fullHistory.length > 0 && !state.submitting);

      const domainOptions = DEFAULT_DOMAINS.map((d) => {
        const selected = state.ruleDomain === d.id ? ' selected' : '';
        return '<option value="' + escAttr(d.id) + '"' + selected + '>' + escHtml(d.label) + '</option>';
      }).join('');

      const verdictsHtml = history.length
        ? history.map((v, idx) => {
            const qid = String(v.question_id || v.id || '');
            const domMeta = resolveDomainMeta(v.domain);
            const chosenKey = String(v.chosen_key || '').toUpperCase();
            const chosenLabel = v.chosen_label || v.label || `Choice ${chosenKey}`;
            const title = v.question_title || v.title || qid;
            const trait = v.trait_tag || v.trait || '';
            const note = v.note || '';
            const ts = formatTimestamp(v.answered_at || v.timestamp || '');
            const latestItem = idx === 0 && qid && qid === latestGlobalId;
            const showInlinePick = state.inlineReanswerId === qid;

            return (
              '<div class="taste-history-row" data-verdict-qid="' + escAttr(qid) + '">' +
                '<div class="taste-history-main">' +
                  '<div class="taste-history-top">' +
                    '<span class="taste-rule-domain">' + escHtml(domMeta.shortLabel || domMeta.label) + '</span>' +
                    '<span class="taste-history-q">' + escHtml(title) + '</span>' +
                  '</div>' +
                  '<div class="taste-history-choice">' +
                    '<span>[' + escHtml(chosenKey || '?') + ']</span>' +
                    '<span>' + escHtml(chosenLabel) + '</span>' +
                    (trait ? '<span class="taste-opt-trait">' + escHtml(trait) + '</span>' : '') +
                  '</div>' +
                  (note ? '<div class="taste-history-note">Note: ' + escHtml(note) + '</div>' : '') +
                  (showInlinePick
                    ? '<div class="taste-deck-actions" role="group" aria-label="Re-pick choice">' +
                        OPTION_KEYS.map((k) =>
                          '<button type="button" class="taste-history-change"' +
                            ' data-taste-repick-qid="' + escAttr(qid) + '"' +
                            ' data-taste-repick-key="' + escAttr(k) + '">' + escHtml(k) + '</button>'
                        ).join('') +
                        '<button type="button" class="taste-history-change" data-taste-repick-cancel>Cancel</button>' +
                      '</div>'
                    : '') +
                '</div>' +
                '<div class="taste-history-right">' +
                  (ts ? '<span class="taste-history-time">' + escHtml(ts) + '</span>' : '') +
                  (qid
                    ? '<button type="button" class="taste-history-change" data-taste-reanswer="' + escAttr(qid) + '">Re-answer</button>'
                    : '') +
                  (latestItem
                    ? '<button type="button" class="taste-history-change" data-taste-undo>Undo</button>'
                    : '') +
                '</div>' +
              '</div>'
            );
          }).join('')
        : '<div class="taste-empty-state">No calibration verdicts recorded in this domain yet. Press 1-4 in the Fine-Tune Deck to lock your first signal.</div>';

      // Primary 8-Axis Aesthetic Fingerprint Instrument (zero redundant 8-tile domain grid!)
      const weeklyInfo = computeWeeklyDomainDeltas(domains, fullHistory);
      let weakestDomain = null;
      let strongestPct = 0;
      let calibratedCount = 0;
      for (let i = 0; i < domains.length; i += 1) {
        const d = domains[i];
        const p = clampPct(d.pct);
        if (p >= 100) calibratedCount += 1;
        if (p > strongestPct) strongestPct = p;
        if (!weakestDomain || p < clampPct(weakestDomain.pct)) {
          weakestDomain = d;
        }
      }
      const weakestPct = weakestDomain ? clampPct(weakestDomain.pct) : 0;
      const spreadPts = Math.max(0, strongestPct - weakestPct);
      const activeDomObj = state.activeDomain !== 'all'
        ? domains.find((d) => d.id === state.activeDomain) || null
        : null;
      const activeTraits = activeDomObj && Array.isArray(activeDomObj.signature_traits) && activeDomObj.signature_traits.length
        ? activeDomObj.signature_traits.slice(0, 5)
        : domains
            .map((d) => (Array.isArray(d.signature_traits) && d.signature_traits[0]) || '')
            .filter(Boolean)
            .slice(0, 5);

      const tasteFx = getTasteFx();
      let radarSvg = '';
      if (tasteFx && typeof tasteFx.renderTasteGenomeRadarSvg === 'function') {
        try {
          radarSvg = tasteFx.renderTasteGenomeRadarSvg(domains, {
            activeDomain: state.activeDomain,
            gardenersData: state.gardenersData && state.gardenersData.domains,
            weeklyPrevPcts: weeklyInfo.weeklyPrevPcts,
            weeklyDeltas: weeklyInfo.weeklyDeltas,
            radarKey: 'taste-studio-main',
          });
        } catch {
          radarSvg = '';
        }
      }

      const overallPct = clampPct(data && data.stats ? data.stats.calibration_pct : 0);
      const weakestGap = weakestDomain ? Math.max(0, 100 - weakestPct) : 0;
      const weakestRemaining = weakestDomain ? Math.max(0, weakestDomain.total - weakestDomain.answered) : 0;

      const fingerprintInstrumentHtml =
        '<section class="taste-fingerprint-stage" aria-label="8-Axis Aesthetic Fingerprint Primary Instrument">' +
          '<div class="taste-fp-radar-col">' +
            '<div class="taste-fp-head">' +
              '<div class="taste-fp-title-group">' +
                '<span class="taste-fp-eyebrow">8-AXIS AESTHETIC FINGERPRINT</span>' +
                '<span class="taste-fp-hint">' +
                  (activeDomObj
                    ? 'Filtering scope to active axis (click vertex again for All)'
                    : 'Click any vertex or axis label to select domain') +
                '</span>' +
              '</div>' +
              '<div class="taste-fp-head-badges">' +
                (weeklyInfo.totalRecent7d > 0
                  ? '<span class="taste-fp-delta-pill">+' + weeklyInfo.totalRecent7d + ' verdicts / 7d</span>'
                  : '') +
                '<span class="taste-fp-score-badge">' + overallPct + '%</span>' +
              '</div>' +
            '</div>' +
            '<div class="taste-fp-svg-wrap">' +
              (radarSvg || '<div class="taste-empty-state">Fingerprint instrument loading...</div>') +
            '</div>' +
          '</div>' +
          '<aside class="taste-fp-telemetry-col" aria-label="Calibration Gap Telemetry">' +
            '<div class="taste-fp-metric-block">' +
              '<span class="taste-fp-eyebrow">CALIBRATION SPREAD</span>' +
              '<div class="taste-fp-spread-row">' +
                '<span class="taste-fp-spread-val is-tier-gap">' + weakestPct + '%</span>' +
                '<span class="taste-fp-spread-arrow" aria-hidden="true">-&gt;</span>' +
                '<span class="taste-fp-spread-val is-tier-calibrated">' + strongestPct + '%</span>' +
              '</div>' +
              '<p class="taste-fp-metric-sub">' +
                calibratedCount + ' of ' + domains.length + ' axes at 100%' +
                (spreadPts > 0 ? (' &middot; ' + spreadPts + ' pt gap to close') : ' &middot; All axes aligned') +
              '</p>' +
              (weakestDomain && weakestGap > 0
                ? '<button type="button" class="taste-fp-gap-cta" data-taste-next-domain="' + escAttr(weakestDomain.id) + '">' +
                    '<span>Fine-Tune Weakest (' + weakestPct + '%' + (weakestRemaining > 0 ? ' &middot; ' + weakestRemaining + ' open' : '') + ')</span>' +
                    getIcon('arrow_right', 12) +
                  '</button>'
                : '') +
            '</div>' +
            '<div class="taste-fp-metric-block">' +
              '<span class="taste-fp-eyebrow">LOCKED SIGNALS</span>' +
              '<div class="taste-fp-trait-list">' +
                (activeTraits.length
                  ? activeTraits.map((tr) => '<span class="taste-fp-trait-chip">' + escHtml(tr) + '</span>').join('')
                  : '<span class="taste-fp-metric-sub">Answer deck cards to lock aesthetic traits.</span>') +
              '</div>' +
            '</div>' +
            '<div class="taste-fp-metric-block taste-fp-scale-key">' +
              '<span class="taste-fp-eyebrow">DISTANCE FROM 100%</span>' +
              '<div class="taste-fp-key-rows">' +
                '<span class="taste-fp-key-item is-tier-calibrated"><i class="taste-fp-key-dot"></i>100% Locked</span>' +
                '<span class="taste-fp-key-item is-tier-strong"><i class="taste-fp-key-dot"></i>85-99% Strong</span>' +
                '<span class="taste-fp-key-item is-tier-mid"><i class="taste-fp-key-dot"></i>75-84% Mid</span>' +
                '<span class="taste-fp-key-item is-tier-gap"><i class="taste-fp-key-dot"></i>&lt;75% / Gap</span>' +
              '</div>' +
            '</div>' +
          '</aside>' +
        '</section>';

      return (
        fingerprintInstrumentHtml +
        '<form class="taste-add-rule-form" data-taste-rule-form aria-label="Lock custom taste rule">' +
          '<label for="taste-rule-polarity" class="sr-only">Rule polarity</label>' +
          '<select id="taste-rule-polarity" name="polarity" class="taste-polarity-select" data-taste-rule-polarity>' +
            '<option value="prefer"' + (state.rulePolarity === 'prefer' ? ' selected' : '') + '>PREFER</option>' +
            '<option value="avoid"' + (state.rulePolarity === 'avoid' ? ' selected' : '') + '>AVOID</option>' +
          '</select>' +
          '<label for="taste-rule-domain" class="sr-only">Rule domain</label>' +
          '<select id="taste-rule-domain" name="domain" class="taste-domain-select" data-taste-rule-domain>' +
            domainOptions +
          '</select>' +
          '<label for="taste-rule-input" class="sr-only">Taste rule statement</label>' +
          '<input id="taste-rule-input" name="rule" type="text" class="taste-rule-input" placeholder="Lock explicit taste rule (e.g. Dense UI first, zero fluff)..." autocomplete="off" required>' +
          '<button type="submit" class="taste-add-rule-btn"' + (state.ruleSaving ? ' disabled' : '') + '>' +
            getIcon('plus', 13) +
            '<span>' + (state.ruleSaving ? 'Locking...' : 'Lock Rule') + '</span>' +
          '</button>' +
        '</form>' +
        '<section class="taste-rules-grid is-asymmetric" aria-label="Prefer versus Avoid rules ledger">' +
          '<div class="taste-rule-col is-prefer">' +
            '<header class="taste-rule-col-head">' +
              '<h3 class="taste-rule-col-title">PREFER</h3>' +
              '<span class="taste-rule-col-count">' + preferRules.length + '</span>' +
            '</header>' +
            '<div class="taste-rule-list">' +
              (preferRules.length
                ? preferRules.map((r) => renderRuleRowHtml(r, 'prefer')).join('')
                : '<div class="taste-empty-state">No PREFER rules locked in this scope yet.</div>') +
            '</div>' +
          '</div>' +
          '<div class="taste-rule-col is-avoid">' +
            '<header class="taste-rule-col-head">' +
              '<h3 class="taste-rule-col-title">AVOID</h3>' +
              '<span class="taste-rule-col-count">' + avoidRules.length + '</span>' +
            '</header>' +
            '<div class="taste-rule-list">' +
              (avoidRules.length
                ? avoidRules.map((r) => renderRuleRowHtml(r, 'avoid')).join('')
                : '<div class="taste-empty-state">No AVOID rules locked in this scope yet.</div>') +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="taste-board-ledger-slot" id="taste-board-ledger-slot" data-board-widget="taste-ledger" data-domain="' + escAttr(state.activeDomain || 'all') + '"></section>' +
        '<section class="taste-history-section" aria-label="Recent calibration verdicts">' +
          '<header class="taste-history-head">' +
            '<h3 class="taste-history-title">Recent Calibration Verdicts (' + history.length + ')</h3>' +
            '<button type="button" class="taste-undo-btn" data-taste-undo' + (canUndo ? '' : ' disabled') + '>' +
              getIcon('replay', 12) +
              '<span>Undo Latest</span>' +
            '</button>' +
          '</header>' +
          '<div class="taste-history-list">' + verdictsHtml + '</div>' +
        '</section>'
      );
    }

    function renderVaultHtml() {
      const docs = getFilteredVaultDocs();
      const totalDocs = state.data ? state.data.vault_docs.length : 0;

      const cardsHtml = docs.length
        ? docs.map((doc) => {
            const rawKind = String(doc.kind || doc.category || doc.polarity || 'reference').toLowerCase();
            const isAnti = rawKind.includes('anti') || String(doc.polarity || '').toLowerCase() === 'avoid';
            const isExemplar = !isAnti && (rawKind.includes('exemplar') || String(doc.polarity || '').toLowerCase() === 'prefer');
            const kindClass = isAnti
              ? 'is-anti'
              : isExemplar
                ? 'is-exemplar'
                : 'is-reference';
            const kindLabel = isAnti
              ? 'Anti-Example'
              : isExemplar
                ? 'Exemplar'
                : stripEmDash(doc.category || doc.kind || 'Reference').replace(/_/g, ' ');
            const docPath = doc.vault_doc_path || doc.path || doc.source_path || '';
            const excerpt = stripTasteFenceBlocks(doc.summary || doc.excerpt || '');
            const domainLabel = doc.domain ? resolveDomainMeta(doc.domain).label : (doc.category || '');
            const tags = [doc.brand, doc.medium].filter(Boolean);
            return (
              '<button type="button" class="taste-vault-card ' + kindClass + '" data-taste-open-doc="' + escAttr(docPath) + '">' +
                '<div class="taste-vault-card-head">' +
                  '<span class="taste-vault-badge">' + escHtml(kindLabel) + '</span>' +
                  (domainLabel ? '<span class="taste-vault-domain">' + escHtml(domainLabel) + '</span>' : '') +
                '</div>' +
                '<h4 class="taste-vault-title">' + escHtml(doc.title || docPath || 'Taste Vault Entry') + '</h4>' +
                (excerpt ? '<p class="taste-vault-excerpt">' + escHtml(excerpt) + '</p>' : '') +
                (tags.length
                  ? '<div class="taste-vault-tags">' +
                      tags.map((t) => '<span class="taste-vault-tag">' + escHtml(t) + '</span>').join('') +
                    '</div>'
                  : '') +
                '<div class="taste-vault-foot">' +
                  '<span class="taste-vault-path">' + escHtml(docPath) + '</span>' +
                  '<span class="taste-vault-open">Open &rarr;</span>' +
                '</div>' +
              '</button>'
            );
          }).join('')
        : '<div class="taste-empty-state">No Taste Vault documents match the current filter.</div>';

      return (
        '<div class="taste-vault-toolbar">' +
          '<div class="taste-vault-filters taste-tabs" role="group" aria-label="Filter Taste Vault by kind">' +
            '<button type="button" class="taste-tab' + (state.vaultKind === 'all' ? ' is-active' : '') + '" data-taste-vault-kind="all">All <span class="taste-tab-count">' + totalDocs + '</span></button>' +
            '<button type="button" class="taste-tab' + (state.vaultKind === 'exemplar' ? ' is-active' : '') + '" data-taste-vault-kind="exemplar">Exemplars</button>' +
            '<button type="button" class="taste-tab' + (state.vaultKind === 'anti' ? ' is-active' : '') + '" data-taste-vault-kind="anti">Anti-Examples</button>' +
          '</div>' +
          '<label for="taste-vault-search" class="sr-only">Filter Taste Vault documents</label>' +
          '<input id="taste-vault-search" type="search" class="taste-note-input" data-taste-vault-search' +
            ' value="' + escAttr(state.vaultSearch) + '"' +
            ' placeholder="Filter exemplars, anti-examples, or paths..." autocomplete="off">' +
        '</div>' +
        '<div class="taste-vault-grid">' + cardsHtml + '</div>'
      );
    }

    function renderActivityMetricsHtml(metrics) {
      if (!metrics || typeof metrics !== 'object') return '';
      const keys = Object.keys(metrics);
      if (!keys.length) return '';
      const chips = [];
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const v = metrics[k];
        if (v == null || v === '' || v === 0) continue;
        const label = stripEmDash(k).replace(/[_-]+/g, ' ').trim();
        const valText = typeof v === 'number' && v > 0 && !label.toLowerCase().includes('depth') && !label.toLowerCase().includes('level')
          ? `+${v}`
          : String(v);
        chips.push(
          '<span class="gardener-delta-chip">' + escHtml(valText) + ' ' + escHtml(label) + '</span>'
        );
      }
      if (!chips.length) return '';
      return '<div class="gardener-activity-deltas">' + chips.join('') + '</div>';
    }

    function renderGardenersHtml() {
      const gData = state.gardenersData;
      if (!gData) {
        if (state.gardenersLoading) {
          return (
            '<div class="taste-empty-state">' +
              '<div class="skeleton-block"></div>' +
            '</div>'
          );
        }
        return (
          '<div class="gardener-console">' +
            '<section class="taste-deck-complete" aria-label="Taste Gardeners initializing">' +
              '<div class="taste-complete-mark" aria-hidden="true">' + getIcon('sparkle_ai', 20) + '</div>' +
              '<h3 class="taste-complete-title">Taste Gardeners Ready</h3>' +
              '<p class="taste-complete-sub">' +
                escHtml(state.gardenersError || 'Cultivation telemetry is initializing. Trigger a live Local LLM sweep or reload gardener state.') +
              '</p>' +
              '<div class="taste-complete-actions">' +
                '<button type="button" class="gardener-btn is-primary" data-gardener-run-all>' +
                  getIcon('action_plane', 12) +
                  '<span>Run All 5 Gardeners</span>' +
                '</button>' +
                '<button type="button" class="gardener-btn" data-gardener-refresh>' +
                  '<span>Reload Gardener State</span>' +
                '</button>' +
              '</div>' +
            '</section>' +
          '</div>'
        );
      }

      const gStats = gData.stats;
      const gardeners = gData.gardeners || [];
      const scheduler = gData.scheduler || { interval: 'Every 6h', enabled: true, next_run_hint: '' };
      const isAllBusy = state.gardenerRunningTarget === 'all' || (gStats.gardeners_total > 0 && gStats.gardeners_running >= gStats.gardeners_total);
      const timerLabel = scheduler.enabled !== false
        ? `Timer: Active ${String(scheduler.interval || 'Every 6h').toLowerCase()}`
        : 'Timer: Paused';
      const hintInfo = splitScheduleHint(scheduler.next_run_hint);

      const summaryStripHtml =
        '<div class="gardener-summary-strip">' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.domains_cultivated + ' / ' + gStats.domains_total + '</span>' +
            '<span class="gardener-summary-lbl">Domains Cultivated</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.total_mastery_stages + '</span>' +
            '<span class="gardener-summary-lbl">Mastery Stages</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.total_frameworks + '</span>' +
            '<span class="gardener-summary-lbl">Frameworks</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.total_policies + '</span>' +
            '<span class="gardener-summary-lbl">Policies</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.total_best_practices + '</span>' +
            '<span class="gardener-summary-lbl">Best Practices</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.total_principles + '</span>' +
            '<span class="gardener-summary-lbl">Principles</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + gStats.runs_total + '</span>' +
            '<span class="gardener-summary-lbl">Cultivation Runs</span>' +
          '</div>' +
          '<div class="gardener-summary-chip">' +
            '<span class="gardener-summary-val">' + escHtml(scheduler.enabled !== false ? (scheduler.interval || 'Every 6h') : 'Paused') + '</span>' +
            '<span class="gardener-summary-lbl">' + escHtml(timerLabel) + '</span>' +
          '</div>' +
        '</div>';

      const consoleHeadHtml =
        '<header class="gardener-console-head">' +
          '<div class="gardener-console-title-wrap">' +
            '<span class="gardener-console-eyebrow">' + getIcon('sparkle_ai', 12) + '<span>Autonomous Local LLM Cultivation</span></span>' +
            '<h3 class="gardener-console-title">5 Taste Gardeners &amp; Domain Mastery</h3>' +
            '<p class="gardener-console-sub"' + (hintInfo.tooltip ? ' title="' + escAttr(hintInfo.tooltip) + '"' : '') + '>' +
              escHtml(timerLabel) +
              (hintInfo.visible ? ' &middot; ' + escHtml(hintInfo.visible) : '') +
              (gStats.gardeners_running > 0 ? ` &middot; ${gStats.gardeners_running} running now` : '') +
            '</p>' +
          '</div>' +
          '<div class="gardener-console-actions">' +
            '<button type="button" class="gardener-btn is-primary" data-gardener-run-all' + (isAllBusy ? ' disabled' : '') + '>' +
              getIcon('action_plane', 12) +
              '<span>' + (isAllBusy ? 'Running Gardeners...' : `Run All ${gStats.gardeners_total || 5} Gardeners`) + '</span>' +
            '</button>' +
          '</div>' +
        '</header>' +
        summaryStripHtml;

      const AGENT_ACCENTS = ['accent-green', 'accent-blue', 'accent-cyan', 'accent-violet', 'accent-amber'];
      const rosterNowMs = Date.now();
      const rosterCardsHtml = gardeners.length
        ? gardeners.map((g, idx) => {
            const isRunning = g.status === 'running' || state.gardenerRunningTarget === `gardener:${g.id}` || state.gardenerRunningTarget === 'all';
            const isError = !isRunning && g.status === 'error';
            const isDone = !isRunning && !isError && g.runs_count > 0;
            const statusCls = isRunning ? 'is-running' : (isError ? 'is-error' : (isDone ? 'is-done' : 'is-idle'));
            const accentCls = !isRunning && !isError ? AGENT_ACCENTS[idx % AGENT_ACCENTS.length] : '';
            const cardCls = 'gardener-agent-card ' + statusCls + (accentCls ? ' ' + accentCls : '');
            const relRun = formatRelativeTime(g.last_run_at, rosterNowMs);
            const countdown = computeGardenerCountdown(g, scheduler, {
              nowMs: rosterNowMs,
              isRunning,
              startedAtMs: state.gardenerRunStartedAt[g.id] || null,
            });
            const ringSvgHtml = renderGardenerCountdownRingSvg(g, scheduler, {
              nowMs: rosterNowMs,
              isRunning,
              statusCls,
              startedAtMs: state.gardenerRunStartedAt[g.id] || null,
            });
            const cleanTask = humanizeDomainSlugs(g.current_task || '');
            const cleanSpecialty = humanizeDomainSlugs(g.specialty || '');
            const cleanSummary = humanizeDomainSlugs(stripTasteFenceBlocks(g.last_summary || 'Ready to cultivate domain frameworks, mastery stages, and policies.'));
            const statusPillText = isRunning
              ? `Running ${countdown.pct}%: ${cleanTask || 'deepening...'}`
              : isError
                ? 'Error'
                : (countdown.nextUtcLabel
                    ? `${countdown.nextUtcLabel} · ${countdown.remainingLabel}`
                    : `Cultivated ${relRun || 'ready'}`);
            const domainPillsHtml = g.domains.map((domId) => {
              const meta = resolveDomainMeta(domId);
              return (
                '<button type="button" class="gardener-domain-pill" data-gardener-select-domain="' + escAttr(domId) + '">' +
                  escHtml(meta.label) +
                '</button>'
              );
            }).join('');

            return (
              '<article class="' + cardCls + '" data-gardener-id="' + escAttr(g.id) + '">' +
                '<div class="gardener-agent-head">' +
                  '<div class="gardener-agent-status-row">' +
                    '<span class="gardener-status has-ring ' + statusCls + '">' +
                      ringSvgHtml +
                      '<span>' + escHtml(statusPillText) + '</span>' +
                    '</span>' +
                  '</div>' +
                  '<div class="gardener-agent-identity">' +
                    '<h4 class="gardener-agent-name">' + escHtml(g.name) + '</h4>' +
                    (cleanSpecialty ? '<p class="gardener-agent-specialty">' + escHtml(cleanSpecialty) + '</p>' : '') +
                  '</div>' +
                '</div>' +
                (domainPillsHtml ? '<div class="gardener-agent-domains">' + domainPillsHtml + '</div>' : '') +
                '<p class="gardener-agent-role">' + escHtml(cleanSummary) + '</p>' +
                '<div class="gardener-agent-telemetry">' +
                  '<div class="gardener-agent-stat">' +
                    '<span class="gardener-agent-stat-val gardener-metric-val">' + g.runs_count + '</span>' +
                    '<span class="gardener-agent-stat-lbl">Runs</span>' +
                  '</div>' +
                  '<div class="gardener-agent-stat">' +
                    '<span class="gardener-agent-stat-val gardener-metric-val">' + g.items_cultivated + '</span>' +
                    '<span class="gardener-agent-stat-lbl">Artifacts</span>' +
                  '</div>' +
                  '<div class="gardener-agent-stat">' +
                    '<span class="gardener-agent-stat-val gardener-metric-val" title="' + escAttr(g.last_engine || 'Local LLM') + '">' + escHtml(g.last_engine || 'Local LLM') + '</span>' +
                    '<span class="gardener-agent-stat-lbl">Engine</span>' +
                  '</div>' +
                '</div>' +
                '<div class="gardener-agent-foot">' +
                  '<span class="gardener-agent-last">' + escHtml(isRunning ? (cleanTask || 'Deepening...') : (relRun ? `${relRun} · ${g.last_engine || 'Local LLM'}` : 'Ready')) + '</span>' +
                  '<button type="button" class="gardener-deepen-btn" data-gardener-run-id="' + escAttr(g.id) + '"' + (isRunning ? ' disabled' : '') + '>' +
                    getIcon('sparkle_ai', 12) +
                    '<span>' + (isRunning ? 'Deepening...' : 'Deepen Now') + '</span>' +
                  '</button>' +
                '</div>' +
              '</article>'
            );
          }).join('')
        : '<div class="gardener-empty-state">No Taste Gardeners registered yet.</div>';

      const selectedDomainId = getSelectedMasteryDomainId();
      const selectedDomainMeta = resolveDomainMeta(selectedDomainId);
      const cultivation = gData.domains ? gData.domains[selectedDomainId] : null;
      const isDomainRunning = state.gardenerRunningTarget === `domain:${selectedDomainId}` ||
        gardeners.some((g) => g.status === 'running' && g.domains.indexOf(selectedDomainId) !== -1);

      const domainFilterTabsHtml = DEFAULT_DOMAINS.map((d) => {
        const c = gData.domains ? gData.domains[d.id] : null;
        const isSelected = d.id === selectedDomainId;
        return (
          '<button type="button" class="gardener-domain-tab' + (isSelected ? ' is-active' : '') + '" data-gardener-select-domain="' + escAttr(d.id) + '" aria-pressed="' + (isSelected ? 'true' : 'false') + '">' +
            getIcon(d.icon, 12) +
            '<span>' + escHtml(d.label) + '</span>' +
            (c ? '<span class="gardener-domain-tab-depth">' + escHtml(c.depth_label) + '</span>' : '') +
          '</button>'
        );
      }).join('');

      let masteryBodyHtml = '';
      if (!cultivation) {
        masteryBodyHtml =
          '<div class="gardener-thesis-banner">' +
            '<div class="gardener-thesis-main">' +
              '<span class="gardener-thesis-eyebrow">Uncultivated Domain</span>' +
              '<h4 class="gardener-thesis-title">' + escHtml(selectedDomainMeta.label) + '</h4>' +
              '<p class="gardener-thesis-text">' + escHtml(selectedDomainMeta.description || 'Run a gardener sweep to build the 4-stage mastery path, frameworks, principles, and enforced policies for this domain.') + '</p>' +
            '</div>' +
            '<div class="gardener-thesis-side">' +
              '<button type="button" class="gardener-btn is-primary" data-gardener-run-domain="' + escAttr(selectedDomainId) + '"' + (isDomainRunning ? ' disabled' : '') + '>' +
                getIcon('sparkle_ai', 12) +
                '<span>' + (isDomainRunning ? 'Deepening...' : 'Deepen This Domain') + '</span>' +
              '</button>' +
            '</div>' +
          '</div>';
      } else {
        const depthPipsHtml = [1, 2, 3, 4, 5].map((lvl) => {
          const isFilled = lvl <= cultivation.depth_level;
          const isCurrent = lvl === cultivation.depth_level;
          return '<span class="gardener-depth-pip' + (isFilled ? ' is-filled' : '') + (isCurrent ? ' is-current' : '') + '">L' + lvl + '</span>';
        }).join('');

        const STAGE_CLASSES = ['is-stage-1 is-foundation', 'is-stage-2 is-practitioner', 'is-stage-3 is-authority', 'is-stage-4 is-frontier'];
        const stagesHtml = (cultivation.mastery_stages || []).length
          ? cultivation.mastery_stages.map((st, idx) => {
              const stageCls = STAGE_CLASSES[Math.max(0, Math.min(3, (st.level || (idx + 1)) - 1))];
              const milestonesHtml = (st.milestones || []).length
                ? '<ul class="gardener-milestone-list">' +
                    st.milestones.map((m) =>
                      '<li class="gardener-milestone-item">' +
                        '<span class="gardener-milestone-check is-done" aria-hidden="true">&#10003;</span>' +
                        '<span>' + escHtml(m) + '</span>' +
                      '</li>'
                    ).join('') +
                  '</ul>'
                : '';
              return (
                '<article class="gardener-stage-card ' + stageCls + '" data-mastery-level="' + escAttr(String(st.level)) + '">' +
                  '<div class="gardener-stage-head">' +
                    '<span class="gardener-stage-step">Level ' + st.level + '</span>' +
                    '<span class="gardener-stage-badge">' + escHtml(DEFAULT_MASTERY_STAGE_NAMES[Math.max(0, Math.min(3, st.level - 1))]) + '</span>' +
                  '</div>' +
                  '<h5 class="gardener-stage-title">' + escHtml(st.name) + '</h5>' +
                  (st.description ? '<p class="gardener-stage-summary">' + escHtml(st.description) + '</p>' : '') +
                  milestonesHtml +
                  (st.diagnostic_test
                    ? '<div class="gardener-diagnostic-box">' +
                        '<span class="gardener-diagnostic-label">Diagnostic Test</span>' +
                        '<p class="gardener-diagnostic-text">' + escHtml(st.diagnostic_test) + '</p>' +
                      '</div>'
                    : '') +
                '</article>'
              );
            }).join('')
          : '<div class="gardener-empty-state">No mastery stages recorded for this domain yet.</div>';

        const frameworksHtml = (cultivation.frameworks || []).length
          ? '<div class="gardener-framework-list">' +
              cultivation.frameworks.map((fw) => {
                const stepsHtml = (fw.steps || []).length
                  ? '<ol class="gardener-framework-steps">' +
                      fw.steps.map((step, sIdx) =>
                        '<li class="gardener-framework-step">' + String(sIdx + 1).padStart(2, '0') + '. ' + escHtml(step) + '</li>'
                      ).join('') +
                    '</ol>'
                  : '';
                return (
                  '<article class="gardener-framework-card">' +
                    '<div class="gardener-framework-head">' +
                      '<h5 class="gardener-framework-name">' + escHtml(fw.name) + '</h5>' +
                      '<span class="gardener-framework-tag">' + (fw.steps.length ? `${fw.steps.length} steps` : 'Framework') + '</span>' +
                    '</div>' +
                    (fw.purpose ? '<p class="gardener-framework-desc">' + escHtml(fw.purpose) + '</p>' : '') +
                    stepsHtml +
                    (fw.when_to_use ? '<p class="gardener-policy-meta">When to use: ' + escHtml(fw.when_to_use) + '</p>' : '') +
                  '</article>'
                );
              }).join('') +
            '</div>'
          : '<div class="gardener-empty-state">No operational frameworks cultivated in this domain yet.</div>';

        const principlesHtml = (cultivation.principles || []).length
          ? cultivation.principles.map((pr, idx) =>
              '<div class="gardener-principle-row">' +
                '<span class="gardener-principle-index">' + String(idx + 1).padStart(2, '0') + '</span>' +
                '<div class="gardener-principle-body">' +
                  '<h5 class="gardener-principle-title">' + escHtml(pr.title) + '</h5>' +
                  (pr.explanation ? '<p class="gardener-principle-text">' + escHtml(pr.explanation) + '</p>' : '') +
                  (pr.anti_pattern ? '<p class="gardener-policy-meta">Anti-pattern: ' + escHtml(pr.anti_pattern) + '</p>' : '') +
                '</div>' +
              '</div>'
            ).join('')
          : '<div class="gardener-empty-state">No core principles cultivated in this domain yet.</div>';

        const policiesHtml = (cultivation.policies || []).length
          ? cultivation.policies.map((pol) => {
              const isNever = pol.badge === 'NEVER';
              const policyKey = `${selectedDomainId}::${pol.taste_polarity}::${pol.id}`;
              const isLocked = isPolicyAlreadyLocked(selectedDomainId, pol.taste_polarity, pol.statement, policyKey);
              const isLocking = state.policyLockingKey === policyKey;
              return (
                '<div class="gardener-policy-row ' + (isNever ? 'is-never' : 'is-must') + '" data-policy-id="' + escAttr(pol.id) + '">' +
                  '<div class="gardener-policy-main">' +
                    '<div class="gardener-policy-top">' +
                      '<span class="gardener-policy-badge ' + (isNever ? 'is-never' : 'is-must') + '">' + escHtml(pol.badge) + '</span>' +
                    '</div>' +
                    '<p class="gardener-policy-text">' + escHtml(pol.statement) + '</p>' +
                    (pol.rationale ? '<span class="gardener-policy-meta">' + escHtml(pol.rationale) + '</span>' : '') +
                  '</div>' +
                  '<button type="button" class="gardener-lock-rule-btn' + (isLocked ? ' is-locked' : '') + '"' +
                    ' data-gardener-lock-policy' +
                    ' data-policy-key="' + escAttr(policyKey) + '"' +
                    ' data-policy-domain="' + escAttr(selectedDomainId) + '"' +
                    ' data-policy-polarity="' + escAttr(pol.taste_polarity) + '"' +
                    ' data-policy-rule="' + escAttr(pol.statement) + '"' +
                    ' data-policy-reason="' + escAttr(pol.rationale || `Cultivated policy from ${selectedDomainMeta.label}`) + '"' +
                    ((isLocked || isLocking) ? ' disabled' : '') + '>' +
                    (isLocked ? getIcon('check', 12) : getIcon('plus', 12)) +
                    '<span>' + (isLocking ? 'Locking...' : (isLocked ? 'Locked in Ledger' : 'Lock as Taste Rule')) + '</span>' +
                  '</button>' +
                '</div>'
              );
            }).join('')
          : '<div class="gardener-empty-state">No enforced policies cultivated in this domain yet.</div>';

        const practicesRowsHtml = (cultivation.best_practices || []).map((bp) =>
          '<div class="gardener-practice-row">' +
            '<div class="gardener-practice-head">' +
              '<h5 class="gardener-practice-title">' + escHtml(bp.title || 'Best Practice') + '</h5>' +
              '<span class="gardener-practice-kind">Practice</span>' +
            '</div>' +
            (bp.detail ? '<p class="gardener-practice-text">' + escHtml(bp.detail) + '</p>' : '') +
          '</div>'
        ).join('');

        const canonsRowsHtml = (cultivation.reference_canons || []).map((rc) =>
          '<div class="gardener-practice-row">' +
            '<div class="gardener-practice-head">' +
              '<h5 class="gardener-practice-title">' + escHtml(rc.name) + '</h5>' +
              '<span class="gardener-practice-kind">' + escHtml(rc.kind || 'Reference') + '</span>' +
            '</div>' +
            (rc.rationale ? '<p class="gardener-practice-text">' + escHtml(rc.rationale) + '</p>' : '') +
          '</div>'
        ).join('');

        const practicesAndCanonsHtml = (practicesRowsHtml || canonsRowsHtml)
          ? practicesRowsHtml + canonsRowsHtml
          : '<div class="gardener-empty-state">No best practices or reference canons cultivated yet.</div>';

        const updatedRel = formatRelativeTime(cultivation.updated_at);
        masteryBodyHtml =
          '<div class="gardener-thesis-banner">' +
            '<div class="gardener-thesis-main">' +
              '<span class="gardener-thesis-eyebrow">' +
                '<span>Domain Thesis</span>' +
                (updatedRel ? '<span>&middot; Updated ' + escHtml(updatedRel) + '</span>' : '') +
              '</span>' +
              '<h4 class="gardener-thesis-title">' + escHtml(cultivation.label || selectedDomainMeta.label) + '</h4>' +
              (cultivation.thesis ? '<p class="gardener-thesis-text">' + escHtml(cultivation.thesis) + '</p>' : '') +
            '</div>' +
            '<div class="gardener-thesis-side">' +
              '<div class="gardener-depth-meter">' +
                '<span class="gardener-depth-label">Depth ' + escHtml(cultivation.depth_label) + '</span>' +
                '<div class="gardener-depth-pips" aria-label="Domain depth ' + escAttr(cultivation.depth_label) + ' of 5">' + depthPipsHtml + '</div>' +
              '</div>' +
              '<div class="gardener-console-actions">' +
                (cultivation.dossier_path
                  ? '<button type="button" class="gardener-dossier-btn" data-taste-open-doc="' + escAttr(cultivation.dossier_path) + '">' +
                      getIcon('book', 12) +
                      '<span>Open Full Dossier .md</span>' +
                      getIcon('external', 11) +
                    '</button>'
                  : '') +
                '<button type="button" class="gardener-btn is-primary" data-gardener-run-domain="' + escAttr(selectedDomainId) + '"' + (isDomainRunning ? ' disabled' : '') + '>' +
                  getIcon('sparkle_ai', 12) +
                  '<span>' + (isDomainRunning ? 'Deepening...' : 'Deepen This Domain') + '</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="gardener-section-head">' +
            '<div class="gardener-section-title-group">' +
              '<h4 class="gardener-section-title">4-Stage Path to Domain Mastery</h4>' +
              '<span class="gardener-section-meta">' + cultivation.mastery_stages.length + ' stages</span>' +
            '</div>' +
          '</div>' +
          '<div class="gardener-mastery-roadmap">' + stagesHtml + '</div>' +
          '<div class="gardener-knowledge-grid">' +
            '<section class="gardener-knowledge-panel" aria-label="Operational Frameworks">' +
              '<header class="gardener-knowledge-head">' +
                '<h4 class="gardener-knowledge-title">Operational Frameworks</h4>' +
                '<span class="gardener-knowledge-count">' + cultivation.frameworks.length + '</span>' +
              '</header>' +
              '<div class="gardener-knowledge-body">' + frameworksHtml + '</div>' +
            '</section>' +
            '<section class="gardener-knowledge-panel" aria-label="Core Principles and Anti-Patterns">' +
              '<header class="gardener-knowledge-head">' +
                '<h4 class="gardener-knowledge-title">Core Principles &amp; Anti-Patterns</h4>' +
                '<span class="gardener-knowledge-count">' + cultivation.principles.length + '</span>' +
              '</header>' +
              '<div class="gardener-knowledge-body">' + principlesHtml + '</div>' +
            '</section>' +
            '<section class="gardener-knowledge-panel" aria-label="Enforced Policies">' +
              '<header class="gardener-knowledge-head">' +
                '<h4 class="gardener-knowledge-title">Enforced Policies (MUST vs NEVER)</h4>' +
                '<span class="gardener-knowledge-count">' + cultivation.policies.length + '</span>' +
              '</header>' +
              '<div class="gardener-knowledge-body">' + policiesHtml + '</div>' +
            '</section>' +
            '<section class="gardener-knowledge-panel" aria-label="Best Practices and Reference Canons">' +
              '<header class="gardener-knowledge-head">' +
                '<h4 class="gardener-knowledge-title">Best Practices &amp; Reference Canons</h4>' +
                '<span class="gardener-knowledge-count">' + (cultivation.best_practices.length + cultivation.reference_canons.length) + '</span>' +
              '</header>' +
              '<div class="gardener-knowledge-body">' + practicesAndCanonsHtml + '</div>' +
            '</section>' +
          '</div>';
      }

      const activityEntries = Array.isArray(gData.activity_log) ? gData.activity_log : [];
      const activityRowsHtml = activityEntries.length
        ? activityEntries.map((ev) => {
            const relTs = formatRelativeTime(ev.ts) || formatTimestamp(ev.ts) || 'recent';
            const absTs = formatTimestamp(ev.ts);
            const domMeta = ev.domain ? resolveDomainMeta(ev.domain) : null;
            const durText = formatDurationMs(ev.duration_ms);
            return (
              '<div class="gardener-activity-row" data-activity-id="' + escAttr(ev.id) + '">' +
                '<div class="gardener-activity-main">' +
                  '<div class="gardener-activity-top">' +
                    '<span class="gardener-activity-time" title="' + escAttr(absTs || ev.ts) + '">' + escHtml(relTs) + '</span>' +
                    '<span class="gardener-activity-agent">' + escHtml(ev.gardener_name) + '</span>' +
                    (domMeta ? '<span class="gardener-activity-domain">' + escHtml(domMeta.label) + '</span>' : '') +
                    '<span class="gardener-engine-chip">' + escHtml(ev.engine || 'Local LLM') + '</span>' +
                    (durText ? '<span class="gardener-activity-time">' + escHtml(durText) + '</span>' : '') +
                  '</div>' +
                  (ev.summary ? '<p class="gardener-activity-summary">' + escHtml(humanizeDomainSlugs(ev.summary)) + '</p>' : '') +
                  renderActivityMetricsHtml(ev.metrics) +
                '</div>' +
                (ev.dossier_path
                  ? '<div class="gardener-activity-actions">' +
                      '<button type="button" class="gardener-inspect-btn" data-taste-open-doc="' + escAttr(ev.dossier_path) + '">Open Dossier</button>' +
                    '</div>'
                  : '') +
              '</div>'
            );
          }).join('')
        : '<div class="gardener-empty-state">No cultivation activity logged yet. Click Run All 5 Gardeners to start the first live sweep.</div>';

      return (
        '<div class="gardener-console">' +
          consoleHeadHtml +
          '<section aria-label="Taste Gardener agents">' +
            '<div class="gardener-section-head">' +
              '<div class="gardener-section-title-group">' +
                '<h4 class="gardener-section-title">Live Gardener Roster</h4>' +
                '<span class="gardener-section-meta">' + gardeners.length + ' agents</span>' +
              '</div>' +
            '</div>' +
            '<div class="gardener-roster-grid">' + rosterCardsHtml + '</div>' +
          '</section>' +
          '<section class="gardener-mastery-section" aria-label="Domain Mastery Path and Frameworks Explorer">' +
            '<div class="gardener-section-head">' +
              '<div class="gardener-section-title-group">' +
                '<h4 class="gardener-section-title">Domain Mastery &amp; Cultivation Explorer</h4>' +
                '<span class="gardener-section-meta">8 domains</span>' +
              '</div>' +
            '</div>' +
            '<div class="gardener-domain-selector" role="tablist" aria-label="Filter mastery explorer by domain">' +
              domainFilterTabsHtml +
            '</div>' +
            masteryBodyHtml +
          '</section>' +
          '<section class="gardener-activity-panel" aria-label="Live Gardener Activity Feed">' +
            '<header class="gardener-activity-head">' +
              '<h4 class="gardener-activity-title">Live Gardener Activity Feed</h4>' +
              '<span class="gardener-activity-meta">' + activityEntries.length + ' runs logged</span>' +
            '</header>' +
            '<div class="gardener-activity-list">' + activityRowsHtml + '</div>' +
          '</section>' +
        '</div>'
      );
    }

    function renderWorkspaceBodyHtml() {
      if (state.loading && !state.data) {
        return (
          '<div class="taste-empty-state">' +
            '<div class="skeleton-block"></div>' +
          '</div>'
        );
      }
      if (state.error && !state.data) {
        return (
          '<div class="taste-deck-complete">' +
            '<h3 class="taste-complete-title">Could not load Taste Studio</h3>' +
            '<p class="taste-complete-sub">' + escHtml(state.error) + '</p>' +
            '<div class="taste-complete-actions">' +
              '<button type="button" class="taste-deck-action-btn" data-taste-retry>Retry Load</button>' +
            '</div>' +
          '</div>'
        );
      }
      if (state.activeTab === 'rules') return renderRulesHtml();
      if (state.activeTab === 'gardeners') return renderGardenersHtml();
      if (state.activeTab === 'vault') return renderVaultHtml();
      return renderDeckHtml();
    }

    function runPostRenderMotion(opts) {
      if (!state.container) return;
      try {
        const m = root && root.KizukiMotion;
        if (!m) return;
        const tabList = state.container.querySelector('.taste-mode-tabs');
        const activeTab = tabList && tabList.querySelector('.taste-mode-tab.is-active');
        if (tabList && activeTab && typeof m.syncSlidingTabInk === 'function') {
          m.syncSlidingTabInk(tabList, activeTab);
        }
        if (opts && opts.animate && typeof m.staggerReveal === 'function') {
          const body = state.container.querySelector('.taste-body');
          if (body) {
            m.staggerReveal(body, '.taste-option-card, .taste-rule-row, .taste-vault-card, .gardener-agent-card, .gardener-stage-card, .gardener-framework-card, .gardener-policy-row');
          }
        }
      } catch {
        // ignore optional motion errors
      }
    }

    function disconnectLedgerObserver() {
      if (state.ledgerObserver && typeof state.ledgerObserver.disconnect === 'function') {
        try {
          state.ledgerObserver.disconnect();
        } catch {
          // ignore observer cleanup failure
        }
      }
      state.ledgerObserver = null;
    }

    function cleanBoardLedgerExcerpts(slotEl) {
      if (!slotEl || typeof slotEl.querySelectorAll !== 'function') return 0;
      let cleanedCount = 0;
      const nodes = slotEl.querySelectorAll('.kbw-thread-excerpt, .kbw-thread-title, [data-taste-excerpt]');
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        if (!el) continue;
        const rawText = typeof el.textContent === 'string' ? el.textContent : '';
        if (!rawText || rawText.indexOf('```') === -1) continue;
        const cleaned = stripTasteFenceBlocks(rawText);
        if (cleaned !== rawText) {
          cleanedCount += 1;
          el.textContent = cleaned;
          if (typeof el.setAttribute === 'function') {
            el.setAttribute('data-taste-fence-stripped', cleaned ? 'true' : 'empty');
          }
          if (!cleaned && el.classList && el.classList.contains('kbw-thread-excerpt') && el.style) {
            el.style.display = 'none';
          }
        }
      }
      return cleanedCount;
    }

    function hydrateRenderedRadar() {
      if (!state.container || typeof state.container.querySelector !== 'function') return;
      const tasteFx = getTasteFx();
      if (!tasteFx || typeof tasteFx.hydrateRadar !== 'function') return;
      const svgEl = state.container.querySelector('.tfx-genome-radar-svg');
      if (!svgEl) return;
      try {
        tasteFx.hydrateRadar(svgEl);
      } catch {
        // ignore optional radar hydration errors
      }
    }

    function render(opts) {
      if (!state.mounted || !state.container) return;
      disconnectLedgerObserver();
      const preserveFocusSelector = opts && opts.preserveFocusSelector;
      const doc = getDoc();
      let selectionStart = null;
      let selectionEnd = null;
      if (preserveFocusSelector && doc && doc.activeElement) {
        try {
          selectionStart = doc.activeElement.selectionStart;
          selectionEnd = doc.activeElement.selectionEnd;
        } catch {
          selectionStart = null;
          selectionEnd = null;
        }
      }

      state.container.innerHTML =
        '<div class="taste-shell" data-active-tab="' + escAttr(state.activeTab) + '" data-active-domain="' + escAttr(state.activeDomain) + '">' +
          renderRailHtml() +
          '<section class="taste-main" aria-label="Taste Studio Workspace">' +
            renderHeaderHtml() +
            '<div class="taste-body taste-content">' +
              renderWorkspaceBodyHtml() +
            '</div>' +
          '</section>' +
        '</div>';

      if (preserveFocusSelector && typeof state.container.querySelector === 'function') {
        const refocusEl = state.container.querySelector(preserveFocusSelector);
        if (refocusEl && typeof refocusEl.focus === 'function') {
          refocusEl.focus();
          if (selectionStart != null && typeof refocusEl.setSelectionRange === 'function') {
            try {
              refocusEl.setSelectionRange(selectionStart, selectionEnd != null ? selectionEnd : selectionStart);
            } catch {
              // ignore cursor restore failure
            }
          }
        }
      }

      runPostRenderMotion(opts);
      hydrateRenderedRadar();

      if (state.activeTab === 'deck') {
        const activeQ = getActiveQuestion();
        const activeQid = activeQ && activeQ.id ? String(activeQ.id) : null;
        if (activeQid && activeQid !== state.lastDealtQuestionId) {
          state.lastDealtQuestionId = activeQid;
          if (opts && (opts.dealCard || opts.animate)) {
            promoteRenderedDeck();
          }
        } else if (!activeQid) {
          state.lastDealtQuestionId = null;
        }
      }

      if (typeof state.container.querySelector === 'function') {
        const ledgerSlot = state.container.querySelector('#taste-board-ledger-slot');
        const widgets = getBoardWidgets();
        if (ledgerSlot) {
          cleanBoardLedgerExcerpts(ledgerSlot);
          const win = getWin();
          if (win && typeof win.MutationObserver === 'function') {
            try {
              const observer = new win.MutationObserver(() => {
                cleanBoardLedgerExcerpts(ledgerSlot);
              });
              observer.observe(ledgerSlot, { childList: true, subtree: true });
              state.ledgerObserver = observer;
            } catch {
              // ignore optional MutationObserver errors
            }
          }
          if (widgets && typeof widgets.mountTasteBoardLedger === 'function') {
            try {
              Promise.resolve(
                widgets.mountTasteBoardLedger(
                  ledgerSlot,
                  { domain: state.activeDomain || 'all' },
                  {
                    openBoard: state.hooks.openBoard,
                    showToast: state.hooks.showToast,
                  }
                )
              ).then(() => {
                cleanBoardLedgerExcerpts(ledgerSlot);
              }).catch(() => {});
            } catch {
              // ignore optional board ledger hydration errors
            }
          }
        }
      }
    }

    async function load(opts) {
      const options = opts && typeof opts === 'object' ? opts : {};
      if (options.domain) {
        const nextDomain = String(options.domain).trim();
        if (nextDomain && SAFE_ID_RE.test(nextDomain)) {
          state.activeDomain = nextDomain;
          if (nextDomain !== 'all') {
            state.gardenerSelectedDomain = nextDomain;
          }
        }
      }
      if (options.tab && VALID_TABS[options.tab]) {
        state.activeTab = options.tab;
      }

      const seq = ++state.loadSeq;
      state.loading = true;
      state.error = null;
      state.reanswerQuestion = null;
      state.inlineReanswerId = null;
      if (!state.data) {
        render();
      }

      try {
        const domainParam = encodeURIComponent(state.activeDomain || 'all');
        const [payload, gardenersPayload, crosslinksPayload] = await Promise.all([
          fetchJson(`/api/taste?domain=${domainParam}`),
          fetchGardenersSilent(),
          fetchCrosslinksSilent(),
        ]);
        if (seq !== state.loadSeq) return state.data;
        state.loading = false;
        state.crosslinks = Array.isArray(crosslinksPayload) ? crosslinksPayload : [];
        state.crosslinksLoaded = true;
        applyStatePayload(payload);
        if (gardenersPayload) {
          applyGardenersPayload(gardenersPayload);
        } else {
          syncGardenerPolling();
        }
        render({ animate: true });
        return state.data;
      } catch (err) {
        if (seq !== state.loadSeq) return null;
        state.loading = false;
        state.error = stripEmDash((err && err.message) || 'Failed to load Taste Studio.');
        render();
        notify(`Taste load failed: ${state.error}`, 'error');
        return null;
      }
    }

    async function refreshGardeners(opts) {
      const silent = Boolean(opts && opts.silent);
      if (!silent) {
        state.gardenersLoading = true;
        state.gardenersError = null;
        render();
      }
      try {
        const raw = await fetchJson('/api/taste/gardeners');
        state.gardenersLoading = false;
        applyGardenersPayload(raw);
        render({ animate: !silent });
        return state.gardenersData;
      } catch (err) {
        state.gardenersLoading = false;
        if (!silent) {
          state.gardenersError = stripEmDash((err && err.message) || 'Could not load Taste Gardeners.');
          render();
        }
        return null;
      }
    }

    async function handleRunGardeners(opts) {
      const req = opts && typeof opts === 'object' ? opts : {};
      if (state.gardenerRunningTarget) return null;

      const body = {};
      let targetKey = 'all';
      let label = 'all 5 Taste Gardeners';
      if (req.gardener_id) {
        body.gardener_id = String(req.gardener_id);
        targetKey = `gardener:${body.gardener_id}`;
        label = body.gardener_id;
      } else if (req.domain) {
        body.domain = String(req.domain);
        targetKey = `domain:${body.domain}`;
        label = resolveDomainMeta(body.domain).label;
      } else {
        body.all = true;
      }

      state.gardenerRunningTarget = targetKey;
      const runStartMs = Date.now();
      if (req.gardener_id) {
        state.gardenerRunStartedAt[String(req.gardener_id)] = runStartMs;
      } else if (state.gardenersData && Array.isArray(state.gardenersData.gardeners)) {
        for (let i = 0; i < state.gardenersData.gardeners.length; i += 1) {
          const g = state.gardenersData.gardeners[i];
          if (g && g.id) state.gardenerRunStartedAt[g.id] = runStartMs;
        }
      }
      render();

      try {
        const res = await fetchJson('/api/taste/gardeners/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        state.gardenerRunningTarget = null;
        let didChime = false;
        if (res && res.state) {
          const applied = applyGardenersPayload(res.state);
          didChime = Boolean(applied && applied.transitionedToIdle);
        } else {
          const fresh = await fetchGardenersSilent();
          if (fresh) {
            const applied = applyGardenersPayload(fresh);
            didChime = Boolean(applied && applied.transitionedToIdle);
          }
        }
        render({ animate: true });
        syncGardenerPolling();
        if (hasRunningGardener(state.gardenersData)) {
          notify(`Started Local LLM cultivation for ${label}.`, 'info');
        } else {
          if (!didChime) {
            playSound('chime');
          }
          notify(`Cultivation complete for ${label}.`, 'success');
        }
        return res;
      } catch (err) {
        state.gardenerRunningTarget = null;
        render();
        notify(`Gardener run failed: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleLockPolicy(btnEl) {
      if (!btnEl || state.policyLockingKey) return null;
      const policyKey = btnEl.getAttribute('data-policy-key') || '';
      const domain = btnEl.getAttribute('data-policy-domain') || getSelectedMasteryDomainId() || 'ui_product';
      const polarity = btnEl.getAttribute('data-policy-polarity') === 'avoid' ? 'avoid' : 'prefer';
      const ruleText = (btnEl.getAttribute('data-policy-rule') || '').trim();
      const reasonText = (btnEl.getAttribute('data-policy-reason') || '').trim();

      if (!ruleText) return null;
      state.policyLockingKey = policyKey || `${domain}::${polarity}::${ruleText}`;
      render();

      try {
        const payload = {
          action: 'upsert',
          domain,
          polarity,
          rule: ruleText,
        };
        if (reasonText) {
          payload.reason = reasonText;
        }
        const res = await fetchJson('/api/taste/rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.policyLockingKey = null;
        if (policyKey) {
          state.lockedPolicyKeys[policyKey] = true;
        }
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: state.activeTab });
          return res;
        }
        render();
        notify(`Locked ${polarity.toUpperCase()} policy into Taste Rules.`, 'success');
        return res;
      } catch (err) {
        state.policyLockingKey = null;
        render();
        notify(`Could not lock policy: ${err.message}`, 'error');
        return null;
      }
    }

    function promoteRenderedDeck() {
      if (!state.container || typeof state.container.querySelector !== 'function') return;
      const tasteFx = getTasteFx();
      if (!tasteFx) return;
      const dealFn = typeof tasteFx.dealCard === 'function'
        ? tasteFx.dealCard
        : (typeof tasteFx.animateDeckPromote === 'function' ? tasteFx.animateDeckPromote : null);
      if (!dealFn) return;
      const stackEl = state.container.querySelector('.tfx-deck-stack') || state.container.querySelector('.taste-question-card');
      if (!stackEl) return;
      try {
        Promise.resolve(dealFn(stackEl)).catch(() => {});
      } catch {
        // ignore optional deck deal animation error
      }
    }

    function runDeckPeel(mode, opts) {
      if (!state.container || typeof state.container.querySelector !== 'function') return null;
      const tasteFx = getTasteFx();
      if (!tasteFx || typeof tasteFx.animateCardPeel !== 'function') return null;
      const cardEl = state.container.querySelector('.taste-question-card');
      if (!cardEl) return null;
      const stackEl = typeof cardEl.closest === 'function' ? cardEl.closest('.tfx-deck-stack') : null;
      if (mode !== 'undo' && stackEl && stackEl.classList) {
        stackEl.classList.add('is-advancing');
      }
      try {
        return Promise.resolve(tasteFx.animateCardPeel(cardEl, mode, opts)).catch(() => null);
      } catch {
        return null;
      }
    }

    async function submitAnswer(chosenKey, explicitQuestionId) {
      if (state.submitting) return null;
      const key = String(chosenKey || '').toUpperCase();
      if (OPTION_KEYS.indexOf(key) === -1) return null;

      const activeQ = getActiveQuestion();
      const qid = explicitQuestionId || (activeQ && activeQ.id);
      if (!qid) return null;

      const chosenOption = activeQ && Array.isArray(activeQ.options)
        ? activeQ.options.find((opt, idx) => String((opt && opt.key) || OPTION_KEYS[idx] || '').toUpperCase() === key)
        : null;
      const lockTone =
        Boolean(state.reanswerQuestion) ||
        (chosenOption && String(chosenOption.polarity || '').toLowerCase() === 'avoid')
          ? 'vermilion'
          : 'emerald';

      const currentStreak = Math.max(
        toNonNegInt(state.data && state.data.stats ? state.data.stats.streak_count : 0),
        state.localStreakBoost
      );
      playSound('calibrate', currentStreak);

      state.submitting = true;
      if (!explicitQuestionId) {
        state.chosenKey = key;
        if (state.container && typeof state.container.querySelectorAll === 'function') {
          const cards = state.container.querySelectorAll('.taste-option-card');
          for (let i = 0; i < cards.length; i += 1) {
            const card = cards[i];
            const cardKey = card.getAttribute('data-taste-option-key');
            if (card.classList) {
              card.classList.toggle('is-chosen', cardKey === key);
            }
            card.setAttribute('aria-pressed', cardKey === key ? 'true' : 'false');
          }
        }
      }

      const note = !explicitQuestionId ? state.noteDraft.trim() : '';
      const payload = {
        question_id: String(qid),
        chosen_key: key,
      };
      if (note) {
        payload.note = note;
      }

      const instant = prefersReducedMotion() || Boolean(state.hooks && state.hooks.instantTransitions);
      const peelPromise = !explicitQuestionId
        ? runDeckPeel('chosen', { chosenKey: key, tone: lockTone })
        : null;
      const transitionPromise = peelPromise || (
        (instant || explicitQuestionId)
          ? Promise.resolve()
          : new Promise((resolve) => setTimeout(resolve, 130))
      );

      try {
        const [res] = await Promise.all([
          fetchJson('/api/taste/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          transitionPromise,
        ]);

        state.submitting = false;
        state.chosenKey = null;
        state.noteDraft = '';
        state.reanswerQuestion = null;
        state.inlineReanswerId = null;

        if (res && res.state) {
          state.localStreakBoost = 0;
          applyStatePayload(res.state);
        } else if (res && res.stats) {
          state.localStreakBoost = 0;
          applyStatePayload(res);
        } else {
          state.localStreakBoost += 1;
          await load({ domain: state.activeDomain, tab: state.activeTab });
          return res;
        }
        render({ animate: true, dealCard: !explicitQuestionId });
        return res;
      } catch (err) {
        state.submitting = false;
        state.chosenKey = null;
        render();
        notify(`Could not record choice: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleSkip() {
      if (state.submitting || state.reanswerQuestion) return null;
      const activeQ = getActiveQuestion();
      if (!activeQ || !activeQ.id) return null;

      playSound('undo');
      const peelPromise = runDeckPeel('skip') || Promise.resolve();

      state.submitting = true;
      try {
        const [res] = await Promise.all([
          fetchJson('/api/taste/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question_id: String(activeQ.id) }),
          }),
          peelPromise,
        ]);
        state.submitting = false;
        state.noteDraft = '';
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: state.activeTab });
          return res;
        }
        render({ animate: true, dealCard: true });
        notify('Skipped question.', 'info');
        return res;
      } catch (err) {
        state.submitting = false;
        render();
        notify(`Skip failed: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleUndo() {
      if (state.submitting) return null;
      if (!state.data || !state.data.answered_history || state.data.answered_history.length === 0) {
        return null;
      }

      playSound('undo');

      state.submitting = true;
      try {
        const res = await fetchJson('/api/taste/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        state.submitting = false;
        state.chosenKey = null;
        state.reanswerQuestion = null;
        state.inlineReanswerId = null;
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: state.activeTab });
          const restoredAfterLoad = runDeckPeel('undo');
          if (restoredAfterLoad) await restoredAfterLoad;
          return res;
        }
        render({ animate: true });
        const restoredPeel = runDeckPeel('undo');
        if (restoredPeel) await restoredPeel;
        notify('Undid last verdict.', 'info');
        return res;
      } catch (err) {
        state.submitting = false;
        render();
        notify(`Undo failed: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleGenerate() {
      if (state.generating) return null;
      state.generating = true;
      render();

      const body = {};
      if (state.activeDomain && state.activeDomain !== 'all') {
        body.domain = state.activeDomain;
      }

      try {
        const res = await fetchJson('/api/taste/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        state.generating = false;
        state.lastGeneration = {
          engine: stripEmDash((res && res.engine) || 'Inkling G4'),
          latency_ms: toNonNegInt(res && res.latency_ms),
          added_count: toNonNegInt(res && res.added_count),
        };
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: 'deck' });
          return res;
        }
        state.activeTab = 'deck';
        render({ animate: true });
        notify(
          `Generated ${state.lastGeneration.added_count} fresh questions via ${state.lastGeneration.engine}.`,
          'success'
        );
        return res;
      } catch (err) {
        state.generating = false;
        render();
        notify(`Question generation failed: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleRuleSubmit(formEl) {
      if (state.ruleSaving || !formEl) return null;
      const polarityEl = formEl.querySelector('[name="polarity"]');
      const domainEl = formEl.querySelector('[name="domain"]');
      const ruleEl = formEl.querySelector('[name="rule"]');
      const polarity = ((polarityEl && polarityEl.value) || state.rulePolarity) === 'avoid' ? 'avoid' : 'prefer';
      const domain = (domainEl && domainEl.value) || state.ruleDomain || 'ui_product';
      const ruleText = (ruleEl && ruleEl.value ? ruleEl.value : '').trim();

      state.rulePolarity = polarity;
      state.ruleDomain = domain;

      if (!ruleText) {
        notify('Enter a taste rule before locking.', 'warn');
        if (ruleEl && typeof ruleEl.focus === 'function') ruleEl.focus();
        return null;
      }

      state.ruleSaving = true;
      render();

      try {
        const res = await fetchJson('/api/taste/rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upsert',
            domain,
            polarity,
            rule: ruleText,
          }),
        });
        state.ruleSaving = false;
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: state.activeTab });
          return res;
        }
        render({ animate: true });
        notify(`Locked ${polarity.toUpperCase()} rule.`, 'success');
        return res;
      } catch (err) {
        state.ruleSaving = false;
        render();
        notify(`Failed to lock rule: ${err.message}`, 'error');
        return null;
      }
    }

    async function handleRuleDelete(id, domain, polarity) {
      if (!id || state.ruleDeletingId) return null;
      state.ruleDeletingId = id;
      render();
      try {
        const res = await fetchJson('/api/taste/rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            id,
            domain: domain || 'ui_product',
            polarity: polarity === 'avoid' ? 'avoid' : 'prefer',
            rule: '',
          }),
        });
        state.ruleDeletingId = null;
        if (res && res.state) {
          applyStatePayload(res.state);
        } else {
          await load({ domain: state.activeDomain, tab: state.activeTab });
          return res;
        }
        render();
        notify('Removed rule.', 'info');
        return res;
      } catch (err) {
        state.ruleDeletingId = null;
        render();
        notify(`Failed to delete rule: ${err.message}`, 'error');
        return null;
      }
    }

    function handleStartReanswer(questionId) {
      if (!questionId) return;
      const cached = state.questionCache[String(questionId)];
      if (cached && Array.isArray(cached.options) && cached.options.length > 0) {
        state.reanswerQuestion = cached;
        state.activeTab = 'deck';
        state.noteDraft = '';
        render({ animate: true });
        return;
      }
      state.inlineReanswerId = state.inlineReanswerId === questionId ? null : questionId;
      render();
    }

    function selectDomainFromRadar(domainId) {
      const clicked = String(domainId || '').trim();
      if (!clicked || !SAFE_ID_RE.test(clicked)) return;
      const nextDom = state.activeDomain === clicked ? 'all' : clicked;
      playSound('click');
      state.activeDomain = nextDom;
      state.reanswerQuestion = null;
      state.inlineReanswerId = null;
      if (nextDom !== 'all') {
        state.ruleDomain = nextDom;
        state.gardenerSelectedDomain = nextDom;
      }
      load({ domain: nextDom, tab: state.activeTab });
    }

    function openCodexCrosslink(codexId, title) {
      playSound('click');
      if (state.hooks && typeof state.hooks.openCodex === 'function') {
        state.hooks.openCodex({ itemId: codexId || undefined, q: codexId ? '' : (title || '') });
        return;
      }
      const win = getWin();
      if (win && win.KizukiCodexView && typeof win.KizukiCodexView.load === 'function') {
        const doc = getDoc();
        const codexNavBtn = doc && typeof doc.querySelector === 'function'
          ? doc.querySelector('[data-view="codex"], [data-nav-view="codex"]')
          : null;
        if (codexNavBtn && typeof codexNavBtn.click === 'function') {
          codexNavBtn.click();
        }
        win.KizukiCodexView.load({ itemId: codexId || undefined, q: codexId ? '' : (title || '') });
        return;
      }
      notify(`Codex link: ${title || codexId}`, 'info');
    }

    function handleKeydown(ev) {
      if (!state.mounted || !state.container) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isElementHiddenOrInactive(state.container)) return;
      if (isAnyBlockingModalOpen()) return;

      const rawKey = String(ev.key || '');
      if ((rawKey === 'Enter' || rawKey === ' ') && ev.target && typeof ev.target.closest === 'function') {
        const radarTarget = ev.target.closest('[data-taste-radar-domain]');
        if (radarTarget && state.container.contains && state.container.contains(radarTarget)) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          selectDomainFromRadar(radarTarget.getAttribute('data-taste-radar-domain'));
          return;
        }
      }

      if (state.activeTab !== 'deck') return;
      if (state.submitting || state.generating) return;

      const doc = getDoc();
      if (isFormFieldElement(ev.target) || (doc && isFormFieldElement(doc.activeElement))) {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(KEY_TO_OPTION, rawKey)) {
        const activeQ = getActiveQuestion();
        if (!activeQ) return;
        const optKey = KEY_TO_OPTION[rawKey];
        const options = Array.isArray(activeQ.options) ? activeQ.options : [];
        const hasChoice = options.some((o, idx) => String((o && o.key) || OPTION_KEYS[idx]).toUpperCase() === optKey);
        if (!hasChoice) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        submitAnswer(optKey);
        return;
      }

      const lower = rawKey.toLowerCase();
      if (lower === 's') {
        const activeQ = getActiveQuestion();
        if (!activeQ || state.reanswerQuestion) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        handleSkip();
        return;
      }

      if (lower === 'u') {
        if (!state.data || !state.data.answered_history || state.data.answered_history.length === 0) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        handleUndo();
      }
    }

    function unbindEvents() {
      if (state.container) {
        if (boundClick) state.container.removeEventListener('click', boundClick);
        if (boundInput) state.container.removeEventListener('input', boundInput);
        if (boundChange) state.container.removeEventListener('change', boundChange);
        if (boundSubmit) state.container.removeEventListener('submit', boundSubmit);
      }
      const doc = getDoc();
      if (doc && boundKeydown) {
        doc.removeEventListener('keydown', boundKeydown);
      }
      boundClick = null;
      boundInput = null;
      boundChange = null;
      boundSubmit = null;
      boundKeydown = null;
    }

    function bindEvents(container) {
      unbindEvents();

      boundClick = (ev) => {
        const target = ev.target && ev.target.closest ? ev.target : null;
        if (!target) return;

        if (target.closest('[data-taste-mobile-details]')) {
          state.mobileRailExpanded = !state.mobileRailExpanded;
          render();
          return;
        }

        const codexBtn = target.closest('[data-taste-open-codex]');
        if (codexBtn) {
          openDocInHost(codexBtn.getAttribute('data-taste-open-codex') || 'world/taste-codex.md');
          return;
        }

        const openBoardBtn = target.closest('[data-taste-open-board]');
        if (openBoardBtn) {
          playSound('click');
          const channel = (openBoardBtn.dataset && openBoardBtn.dataset.tasteOpenBoard)
            || openBoardBtn.getAttribute('data-taste-open-board')
            || 'box/taste';
          if (state.hooks && typeof state.hooks.openBoard === 'function') {
            state.hooks.openBoard({ channel, mode: 'taste' });
          } else {
            notify(`Agent Board channel ready: #${channel}`, 'info');
          }
          return;
        }

        const docBtn = target.closest('[data-taste-open-doc]');
        if (docBtn) {
          openDocInHost(docBtn.getAttribute('data-taste-open-doc'));
          return;
        }

        const crosslinkBtn = target.closest('[data-taste-open-codex-item]');
        if (crosslinkBtn) {
          openCodexCrosslink(
            crosslinkBtn.getAttribute('data-taste-open-codex-item') || '',
            crosslinkBtn.getAttribute('data-taste-codex-title') || ''
          );
          return;
        }

        const radarDomainBtn = target.closest('[data-taste-radar-domain]');
        if (radarDomainBtn) {
          selectDomainFromRadar(radarDomainBtn.getAttribute('data-taste-radar-domain'));
          return;
        }

        const domainBtn = target.closest('[data-taste-domain]');
        if (domainBtn) {
          const nextDom = domainBtn.getAttribute('data-taste-domain');
          if (nextDom && nextDom !== state.activeDomain) {
            state.activeDomain = nextDom;
            state.reanswerQuestion = null;
            state.inlineReanswerId = null;
            if (nextDom !== 'all') {
              state.ruleDomain = nextDom;
              state.gardenerSelectedDomain = nextDom;
            }
            load({ domain: nextDom, tab: state.activeTab });
          }
          return;
        }

        const nextDomBtn = target.closest('[data-taste-next-domain]');
        if (nextDomBtn) {
          const nextDom = nextDomBtn.getAttribute('data-taste-next-domain');
          if (nextDom) {
            state.activeDomain = nextDom;
            state.activeTab = 'deck';
            state.reanswerQuestion = null;
            state.ruleDomain = nextDom;
            state.gardenerSelectedDomain = nextDom;
            load({ domain: nextDom, tab: 'deck' });
          }
          return;
        }

        const tabBtn = target.closest('[data-taste-tab]');
        if (tabBtn) {
          const nextTab = tabBtn.getAttribute('data-taste-tab');
          if (nextTab && VALID_TABS[nextTab] && nextTab !== state.activeTab) {
            state.activeTab = nextTab;
            state.inlineReanswerId = null;
            render({ animate: true });
            if (nextTab === 'gardeners' && !state.gardenersData && !state.gardenersLoading) {
              refreshGardeners({ silent: false });
            } else {
              syncGardenerPolling();
            }
          }
          return;
        }

        if (target.closest('[data-gardener-run-all]')) {
          handleRunGardeners({ all: true });
          return;
        }

        const runGardenerBtn = target.closest('[data-gardener-run-id]');
        if (runGardenerBtn) {
          const gId = runGardenerBtn.getAttribute('data-gardener-run-id');
          if (gId) {
            handleRunGardeners({ gardener_id: gId });
          }
          return;
        }

        const runDomainBtn = target.closest('[data-gardener-run-domain]');
        if (runDomainBtn) {
          const domId = runDomainBtn.getAttribute('data-gardener-run-domain');
          if (domId) {
            handleRunGardeners({ domain: domId });
          }
          return;
        }

        if (target.closest('[data-gardener-refresh]')) {
          refreshGardeners({ silent: false });
          return;
        }

        const selectGardenerDomBtn = target.closest('[data-gardener-select-domain]');
        if (selectGardenerDomBtn) {
          const domId = selectGardenerDomBtn.getAttribute('data-gardener-select-domain');
          if (domId && SAFE_ID_RE.test(domId)) {
            state.gardenerSelectedDomain = domId;
            if (state.activeDomain !== 'all' && state.activeDomain !== domId) {
              state.activeDomain = domId;
              state.ruleDomain = domId;
            }
            if (state.activeTab !== 'gardeners') {
              state.activeTab = 'gardeners';
            }
            render({ animate: true });
          }
          return;
        }

        const lockPolicyBtn = target.closest('[data-gardener-lock-policy]');
        if (lockPolicyBtn) {
          handleLockPolicy(lockPolicyBtn);
          return;
        }

        const optBtn = target.closest('[data-taste-option-key]');
        if (optBtn) {
          const chosenKey = optBtn.getAttribute('data-taste-option-key');
          if (chosenKey) {
            submitAnswer(chosenKey);
          }
          return;
        }

        if (target.closest('[data-taste-skip]')) {
          handleSkip();
          return;
        }

        if (target.closest('[data-taste-undo]')) {
          handleUndo();
          return;
        }

        if (target.closest('[data-taste-generate]')) {
          handleGenerate();
          return;
        }

        if (target.closest('[data-taste-retry]')) {
          load({ domain: state.activeDomain, tab: state.activeTab });
          return;
        }

        if (target.closest('[data-taste-cancel-reanswer]')) {
          state.reanswerQuestion = null;
          render();
          return;
        }

        const broadcastRuleBtn = target.closest('[data-taste-broadcast-rule]');
        if (broadcastRuleBtn) {
          playSound('click');
          const ruleId = broadcastRuleBtn.getAttribute('data-taste-broadcast-rule') || '';
          const ruleText = broadcastRuleBtn.getAttribute('data-rule-text') || '';
          const domain = broadcastRuleBtn.getAttribute('data-rule-domain') || 'all';
          const polarity = broadcastRuleBtn.getAttribute('data-rule-polarity') || 'prefer';
          const widgets = getBoardWidgets();
          if (widgets && typeof widgets.openBoardDispatchModal === 'function') {
            widgets.openBoardDispatchModal(
              {
                sourceKind: 'taste',
                sourceId: ruleId,
                sourceLabel: `${polarity.toUpperCase()} · ${domain}`,
                defaultChannel: 'box/taste',
                defaultAgent: 'board-keeper',
                defaultText: `taste: [${polarity.toUpperCase()} / ${domain}] ${ruleText}`,
              },
              {
                openBoard: state.hooks.openBoard,
                showToast: state.hooks.showToast,
              }
            );
          } else {
            notify('Agent Board dispatch modal is unavailable.', 'warn');
          }
          return;
        }

        const delRuleBtn = target.closest('[data-taste-delete-rule]');
        if (delRuleBtn) {
          handleRuleDelete(
            delRuleBtn.getAttribute('data-taste-delete-rule'),
            delRuleBtn.getAttribute('data-taste-delete-domain'),
            delRuleBtn.getAttribute('data-taste-delete-polarity')
          );
          return;
        }

        const reanswerBtn = target.closest('[data-taste-reanswer]');
        if (reanswerBtn) {
          handleStartReanswer(reanswerBtn.getAttribute('data-taste-reanswer'));
          return;
        }

        const repickBtn = target.closest('[data-taste-repick-qid]');
        if (repickBtn) {
          const qid = repickBtn.getAttribute('data-taste-repick-qid');
          const key = repickBtn.getAttribute('data-taste-repick-key');
          if (qid && key) {
            submitAnswer(key, qid);
          }
          return;
        }

        if (target.closest('[data-taste-repick-cancel]')) {
          state.inlineReanswerId = null;
          render();
          return;
        }

        const vaultKindBtn = target.closest('[data-taste-vault-kind]');
        if (vaultKindBtn) {
          const k = vaultKindBtn.getAttribute('data-taste-vault-kind') || 'all';
          if (k !== state.vaultKind) {
            state.vaultKind = k;
            render();
          }
        }
      };

      boundInput = (ev) => {
        const target = ev.target;
        if (!target || typeof target.matches !== 'function') return;
        if (target.matches('[data-taste-note]')) {
          state.noteDraft = target.value || '';
          return;
        }
        if (target.matches('[data-taste-vault-search]')) {
          state.vaultSearch = target.value || '';
          render({ preserveFocusSelector: '[data-taste-vault-search]' });
        }
      };

      boundChange = (ev) => {
        const target = ev.target;
        if (!target || typeof target.matches !== 'function') return;
        if (target.matches('[data-taste-rule-domain]')) {
          state.ruleDomain = target.value || 'ui_product';
          return;
        }
        if (target.matches('[data-taste-rule-polarity]')) {
          state.rulePolarity = target.value === 'avoid' ? 'avoid' : 'prefer';
        }
      };

      boundSubmit = (ev) => {
        const form = ev.target && ev.target.closest ? ev.target.closest('[data-taste-rule-form]') : null;
        if (form) {
          ev.preventDefault();
          handleRuleSubmit(form);
        }
      };

      container.addEventListener('click', boundClick);
      container.addEventListener('input', boundInput);
      container.addEventListener('change', boundChange);
      container.addEventListener('submit', boundSubmit);

      const doc = getDoc();
      if (doc && typeof doc.addEventListener === 'function') {
        boundKeydown = handleKeydown;
        doc.addEventListener('keydown', boundKeydown);
      }
    }

    function mount(containerEl, hostHooks) {
      if (!containerEl) return;
      const isNewContainer = state.container !== containerEl;
      if (isNewContainer && state.container) {
        unbindEvents();
      }
      state.container = containerEl;
      state.hooks = hostHooks && typeof hostHooks === 'object' ? hostHooks : {};
      state.mounted = true;
      if (isNewContainer || !boundClick) {
        bindEvents(containerEl);
      }
      render();
    }

    function unmount() {
      stopGardenerPolling();
      disconnectLedgerObserver();
      unbindEvents();
      state.mounted = false;
      state.container = null;
      state.lastDealtQuestionId = null;
    }

    function getState() {
      return {
        mounted: state.mounted,
        activeDomain: state.activeDomain,
        activeTab: state.activeTab,
        loading: state.loading,
        submitting: state.submitting,
        generating: state.generating,
        chosenKey: state.chosenKey,
        rulePolarity: state.rulePolarity,
        ruleDomain: state.ruleDomain,
        vaultKind: state.vaultKind,
        vaultSearch: state.vaultSearch,
        stats: state.data ? state.data.stats : null,
        queueLength: getActiveDomainQueue().length,
        gardenersStats: state.gardenersData ? state.gardenersData.stats : null,
        gardenersRunning: hasRunningGardener(state.gardenersData),
        gardenerPollingActive: state.gardenerPollTimer != null,
        gardenerSelectedDomain: getSelectedMasteryDomainId(),
      };
    }

    return {
      mount,
      load,
      unmount,
      getState,
      _test: {
        isValidHexColor,
        sanitizeHexColor,
        contrastInkForHex,
        renderOptionPreview,
        escHtml,
        stripEmDash,
        stripTasteFenceBlocks,
        cleanBoardLedgerExcerpts,
        computeGardenerCountdown,
        renderGardenerCountdownRingSvg,
        normalizeGardenersPayload,
        formatRelativeTime,
        formatDurationMs,
        humanizeDomainSlugs,
        splitScheduleHint,
      },
    };
  }

  return createTasteController();
});
