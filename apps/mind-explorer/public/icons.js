/* ==========================================================================
   KIZUKI MIND EXPLORER - PRECISION INLINE SVG ICON & BADGE SYSTEM
   Aesthetic: Vercel Geist + Linear / Palantir geometric precision
   Grid: 16x16 viewBox, uniform 1.35 stroke, round caps/joins, fill="none"
   Zero external dependencies. Dual-polarity safe via currentColor.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiIcons = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const MULTI_SPACE_RE = /\s+/g;

  function stripEmDash(value) {
    return String(value == null ? '' : value).replace(EM_DASH_RE, ' - ');
  }

  function escapeHtml(value) {
    return stripEmDash(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeClassToken(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/[^a-zA-Z0-9_\-\s]/g, ' ')
      .replace(MULTI_SPACE_RE, ' ')
      .trim();
  }

  function sanitizeSlug(value, fallback) {
    const slug = String(value == null ? '' : value)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return slug || fallback || 'default';
  }

  function normalizeSize(rawSize, fallback) {
    const def = fallback == null ? 14 : fallback;
    if (rawSize == null || rawSize === '') return def;
    const n = Number(rawSize);
    if (!Number.isFinite(n) || n <= 0) return def;
    if (n < 8) return 8;
    if (n > 96) return 96;
    return Number(n.toFixed(2));
  }

  // =========================================================================
  // BESPOKE 16x16 SVG GLYPH PATHS (69 precision geometric glyphs)
  // All coordinates sit within [1.75, 14.25] so 1.35px strokes never clip.
  // =========================================================================

  const ICON_PATHS = Object.freeze({
    // --- WORKSPACE NAV (14) ---
    today:
      '<path d="M2 12.25h12"/>' +
      '<path d="M4.25 12.25a3.75 3.75 0 0 1 7.5 0"/>' +
      '<path d="M8 3.25v2.25M3.75 6.5l1.4 1.4M12.25 6.5l-1.4 1.4"/>',

    people:
      '<circle cx="6.25" cy="5.5" r="2.25"/>' +
      '<path d="M2.25 13.25c0-2.1 1.75-3.5 4-3.5s4 1.4 4 3.5"/>' +
      '<circle cx="11.25" cy="6.25" r="1.65"/>' +
      '<path d="M11.4 9.9c1.45.25 2.35 1.35 2.35 3.1"/>',

    replay:
      '<path d="M3.25 6.25A5.25 5.25 0 1 1 3.4 10.6"/>' +
      '<path d="M2.5 3.5v3h3"/>' +
      '<path d="M8 5.4v2.85l1.95 1.15"/>',

    codex:
      '<path d="M8 4.1c-1.25-.9-2.95-1.15-5-.85v9.1c2.05-.3 3.75-.05 5 .85"/>' +
      '<path d="M8 4.1c1.25-.9 2.95-1.15 5-.85v9.1c-2.05-.3-3.75-.05-5 .85"/>' +
      '<path d="M8 4.1v9.1"/>',

    vault:
      '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.2"/>' +
      '<circle cx="8" cy="8" r="2.45"/>' +
      '<path d="M8 5.55V4.25M8 11.75v-1.3M5.55 8H4.25M11.75 8h-1.3"/>',

    graph:
      '<circle cx="4" cy="4.25" r="1.6"/>' +
      '<circle cx="12.25" cy="5.25" r="1.6"/>' +
      '<circle cx="7.25" cy="12" r="1.75"/>' +
      '<path d="M5.5 4.65l5.15.45M4.8 5.65l1.65 4.75M11.2 6.55L8.45 10.5"/>',

    stream:
      '<path d="M1.9 8.5h2.35l1.6-4.5 2.25 8 1.75-4.75 1.3 1.25h2.95"/>',

    atlas:
      '<path d="M2.25 4.1l3.65-1.35 4.2 1.5 3.65-1.35v9l-3.65 1.35-4.2-1.5-3.65 1.35v-9Z"/>' +
      '<path d="M5.9 2.75v9M10.1 4.25v9"/>',

    memt:
      '<path d="M8 2.15 13.4 5.2v5.6L8 13.85 2.6 10.8V5.2L8 2.15Z"/>' +
      '<path d="M8 5.35 10.7 6.9v3L8 11.45 5.3 9.9v-3L8 5.35Z"/>' +
      '<path d="M8 2.15v3.2M13.4 5.2l-2.7 1.7M2.6 5.2l2.7 1.7"/>',

    chat:
      '<path d="M3 3.25h10a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H6.5L3.25 14v-2.25H3a1.5 1.5 0 0 1-1.5-1.5v-5.5a1.5 1.5 0 0 1 1.5-1.5Z"/>' +
      '<path d="M5.25 6.5h5.5M5.25 8.85h3.5"/>',

    search:
      '<circle cx="7.15" cy="7.15" r="4.4"/>' +
      '<path d="M10.45 10.45 13.75 13.75"/>',

    sun:
      '<circle cx="8" cy="8" r="2.65"/>' +
      '<path d="M8 2v1.45M8 12.55V14M2 8h1.45M12.55 8H14M3.75 3.75l1.05 1.05M11.2 11.2l1.05 1.05M12.25 3.75l-1.05 1.05M4.8 11.2l-1.05 1.05"/>',

    moon:
      '<path d="M12.85 9.85A5.25 5.25 0 0 1 6.15 3.15a5.25 5.25 0 1 0 6.7 6.7Z"/>',

    grid:
      '<rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1"/>' +
      '<rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1"/>' +
      '<rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1"/>' +
      '<rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1"/>',

    // --- CHANNELS & SOURCES (18) ---
    whatsapp:
      '<path d="M8 2.25a5.65 5.65 0 0 0-4.95 8.35L2.35 13.65l3.15-.68A5.65 5.65 0 1 0 8 2.25Z"/>' +
      '<path d="M5.75 5.45h1l.45 1.2-.7.65a4.2 4.2 0 0 0 2.2 2.2l.65-.7 1.2.45v1a.75.75 0 0 1-.8.75 4.85 4.85 0 0 1-4.75-4.75.75.75 0 0 1 .75-.8Z"/>',

    telegram:
      '<path d="M13.85 2.75 2.15 7.25l3.45 1.25 1.25 3.85 2.15-2.1 3.05 2.25 1.8-9.75Z"/>' +
      '<path d="M5.6 8.5 11.15 5.15"/>',

    imessage:
      '<path d="M8 2.65c3.3 0 5.85 2.1 5.85 4.85S11.3 12.35 8 12.35c-.75 0-1.45-.1-2.1-.3L3 13.35l.85-2.15A4.6 4.6 0 0 1 2.15 7.5c0-2.75 2.55-4.85 5.85-4.85Z"/>' +
      '<path d="M5.65 7.5h.01M8 7.5h.01M10.35 7.5h.01"/>',

    gmail:
      '<rect x="2" y="3.25" width="12" height="9.5" rx="1.6"/>' +
      '<path d="M2.65 4.4 8 8.45l5.35-4.05"/>' +
      '<path d="M4.65 12.75V6.65M11.35 12.75V6.65"/>',

    calendar:
      '<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.75"/>' +
      '<path d="M5.25 2v2.4M10.75 2v2.4M2.25 6.65h11.5"/>' +
      '<path d="M5.5 9.4h.01M8 9.4h.01M10.5 9.4h.01M5.5 11.5h.01M8 11.5h.01"/>',

    wispr:
      '<rect x="6.25" y="3" width="3.5" height="6.25" rx="1.75"/>' +
      '<path d="M4.35 7.4a3.65 3.65 0 0 0 7.3 0M8 11.05v2.45M6.1 13.5h3.8"/>' +
      '<path d="M2.35 5.6v3.1M13.65 5.6v3.1"/>',

    whoop:
      '<circle cx="8" cy="8" r="5.65"/>' +
      '<path d="M4.15 8.2h1.95l1.05-2.35 1.65 4.3 1.15-1.95h1.9"/>',

    claude:
      '<path d="M8 2.15v11.7M2.15 8h11.7M3.85 3.85l8.3 8.3M12.15 3.85l-8.3 8.3"/>',

    codex_agent:
      '<rect x="2" y="2.75" width="12" height="10.5" rx="1.8"/>' +
      '<path d="M4.85 6.35 7 8.15 4.85 9.95M8.5 9.95h2.65"/>',

    obsidian:
      '<path d="M8 1.95 12.85 5.3 11.35 13.3 8 14.1 4.65 13.3 3.15 5.3 8 1.95Z"/>' +
      '<path d="M8 1.95 6.35 7.6 8 14.1M6.35 7.6l6.5-2.3M6.35 7.6 3.15 5.3"/>',

    apple_notes:
      '<rect x="2.75" y="2.25" width="10.5" height="11.5" rx="1.65"/>' +
      '<path d="M2.75 5.4h10.5M5.25 8.1h5.5M5.25 10.6h3.75"/>',

    x_social:
      '<path d="M2.75 2.65h2.35l8.15 10.7h-2.35L2.75 2.65Z"/>' +
      '<path d="M12.75 2.65 8.7 7.25M7.3 8.75l-4.55 4.6"/>',

    github:
      '<path d="M6.1 12.25c-2.45.75-2.45-1.2-3.45-1.5m6.9 3v-2a1.7 1.7 0 0 0-.48-1.32c1.6-.18 3.28-.78 3.28-3.55a2.8 2.8 0 0 0-.75-1.92 2.6 2.6 0 0 0-.08-1.88s-.6-.2-1.97.73a6.8 6.8 0 0 0-3.55 0c-1.37-.93-1.97-.73-1.97-.73a2.6 2.6 0 0 0-.08 1.88 2.8 2.8 0 0 0-.75 1.92c0 2.76 1.68 3.37 3.28 3.55a1.7 1.7 0 0 0-.48 1.32v2"/>',

    linkedin:
      '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2"/>' +
      '<path d="M5.25 7v4.15M5.25 4.9h.01M7.8 11.15V7m0 1.45a1.55 1.55 0 0 1 2.95.68v2.02"/>',

    globe:
      '<circle cx="8" cy="8" r="5.65"/>' +
      '<path d="M2.5 8h11M8 2.35c1.55 1.55 2.35 3.45 2.35 5.65S9.55 12.1 8 13.65C6.45 12.1 5.65 10.2 5.65 8S6.45 3.9 8 2.35Z"/>',

    mail:
      '<rect x="2" y="3.25" width="12" height="9.5" rx="1.6"/>' +
      '<path d="M2.65 4.45 8 8.65l5.35-4.2"/>',

    map_pin:
      '<path d="M8 13.85s4.35-3.65 4.35-7.15a4.35 4.35 0 1 0-8.7 0c0 3.5 4.35 7.15 4.35 7.15Z"/>' +
      '<circle cx="8" cy="6.7" r="1.5"/>',

    camera:
      '<path d="M2.25 5.65a1.4 1.4 0 0 1 1.4-1.4h1.35l.95-1.35h4.1l.95 1.35h1.35a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.65a1.4 1.4 0 0 1-1.4-1.4v-6Z"/>' +
      '<circle cx="8" cy="8.55" r="2.1"/>',

    // --- PEOPLE ARCHETYPES (7) ---
    arch_gatekeeper:
      '<path d="M8 2.1 13.1 4.1v3.75c0 3.05-2.15 5.15-5.1 6.1-2.95-.95-5.1-3.05-5.1-6.1V4.1L8 2.1Z"/>' +
      '<path d="M8 5.5v4.9M6.25 7.4h3.5"/>',

    arch_builder:
      '<path d="M8 2.15 13.25 5.1v5.8L8 13.85 2.75 10.9V5.1L8 2.15Z"/>' +
      '<path d="M8 8.05 13.25 5.1M8 8.05 2.75 5.1M8 8.05v5.8"/>',

    arch_founder:
      '<circle cx="8" cy="8" r="5.65"/>' +
      '<path d="M10.4 5.6 9.1 9.1 5.6 10.4 6.9 6.9 10.4 5.6Z"/>',

    arch_household:
      '<path d="M2.35 7.4 8 2.55l5.65 4.85"/>' +
      '<path d="M3.75 6.45v6.4a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6.4"/>' +
      '<path d="M8 11.45s-1.95-1.2-1.95-2.35a1.1 1.1 0 0 1 1.95-.7 1.1 1.1 0 0 1 1.95.7c0 1.15-1.95 2.35-1.95 2.35Z"/>',

    arch_signal:
      '<path d="M8 13.75V7.9"/>' +
      '<circle cx="8" cy="6.7" r="1.1"/>' +
      '<path d="M5.45 9.25a3.6 3.6 0 0 1 0-5.1M10.55 4.15a3.6 3.6 0 0 1 0 5.1"/>' +
      '<path d="M3.55 11.1a6.2 6.2 0 0 1 0-8.8M12.45 2.3a6.2 6.2 0 0 1 0 8.8"/>',

    arch_operator:
      '<path d="M2.5 4.5h3.2M8.7 4.5h4.8M2.5 8h7.3M12.8 8h.7M2.5 11.5h2.1M7.6 11.5h5.9"/>' +
      '<circle cx="7.2" cy="4.5" r="1.45"/>' +
      '<circle cx="11.3" cy="8" r="1.45"/>' +
      '<circle cx="6.1" cy="11.5" r="1.45"/>',

    arch_ally:
      '<path d="M6.65 9.35 9.35 6.65"/>' +
      '<path d="M8.55 4.75 10.1 3.2a2.4 2.4 0 0 1 3.4 3.4l-1.55 1.55"/>' +
      '<path d="M7.45 11.25 5.9 12.8a2.4 2.4 0 0 1-3.4-3.4l1.55-1.55"/>',

    // --- CODEX SECTIONS & IDEA STAGES (10) ---
    philosophy:
      '<path d="M2.25 5.4 8 2.45l5.75 2.95H2.25Z"/>' +
      '<path d="M4.25 5.4v6.35M8 5.4v6.35M11.75 5.4v6.35M2.45 13.5h11.1M3.25 11.75h9.5"/>',

    interest:
      '<path d="M2.75 9.65 11.35 4.6l1.75 3.05L4.5 12.7 2.75 9.65Z"/>' +
      '<path d="M6.85 11.35 5.35 13.85M8.75 10.25l1.65 3.6M12.85 2.45h.01M10.45 2.45h.01"/>',

    hobby:
      '<path d="M8.35 2.15c2.25 1.95 3.75 4.1 3.75 6.45a4.1 4.1 0 1 1-8.2 0c0-1.65.8-3.25 2.1-4.4-.05 1.15.45 1.85 1.15 2.1-.15-1.65.35-3.1 1.2-4.15Z"/>' +
      '<path d="M8 12.7a1.75 1.75 0 0 0 1.75-1.75c0-1-.75-1.75-1.6-2.55-.75.8-1.9 1.55-1.9 2.55A1.75 1.75 0 0 0 8 12.7Z"/>',

    idea:
      '<path d="M5.75 11.15c-.25-.95-1.9-1.95-1.9-4.15a4.15 4.15 0 1 1 8.3 0c0 2.2-1.65 3.2-1.9 4.15H5.75Z"/>' +
      '<path d="M6.1 13.5h3.8M8 5.6v2.5"/>',

    action_plane:
      '<path d="M8.85 2.1 3.45 8.8h4.2l-.5 5.1 5.4-6.7h-4.2l.5-5.1Z"/>',

    stage_spark:
      '<path d="M8 2.15 9.45 6.55 13.85 8 9.45 9.45 8 13.85 6.55 9.45 2.15 8 6.55 6.55 8 2.15Z"/>',

    stage_validating:
      '<circle cx="8" cy="8" r="5.4"/>' +
      '<path d="M5.65 8.15 7.25 9.75 10.65 6.35"/>',

    stage_building:
      '<path d="M3.25 10.75 8 13.5l4.75-2.75"/>' +
      '<path d="M3.25 7.95 8 10.7l4.75-2.75"/>' +
      '<path d="M8 2.4 12.75 5.15 8 7.9 3.25 5.15 8 2.4Z"/>',

    stage_shipped:
      '<path d="M9.65 6.35h.01"/>' +
      '<path d="M6.25 9.75 3.8 10.5l.75-2.45L9.7 2.9a2.1 2.1 0 0 1 2.95 0l.45.45a2.1 2.1 0 0 1 0 2.95L7.95 11.45 5.5 12.2l.75-2.45Z"/>' +
      '<path d="M3.15 12.85 4.8 11.2"/>',

    stage_parked:
      '<rect x="2.5" y="2.5" width="11" height="11" rx="2.2"/>' +
      '<path d="M6.35 5.65v4.7M9.65 5.65v4.7"/>',

    // --- INTELLIGENCE & CONTROLS (18) ---
    leverage_up:
      '<path d="M2.25 11.75 6.25 7.75 9 10.5 13.75 4.75"/>' +
      '<path d="M10.15 4.75h3.6v3.6"/>',

    leverage_risk:
      '<path d="M7.15 2.85a1 1 0 0 1 1.7 0l4.9 8.55a1 1 0 0 1-.86 1.5H3.11a1 1 0 0 1-.86-1.5l4.9-8.55Z"/>' +
      '<path d="M8 6.25v3M8 11.15h.01"/>',

    copy:
      '<rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/>' +
      '<path d="M3.65 10.5H3.5A1.25 1.25 0 0 1 2.25 9.25V3.5A1.25 1.25 0 0 1 3.5 2.25h5.75A1.25 1.25 0 0 1 10.5 3.5v.15"/>',

    check:
      '<path d="M3.1 8.45 6.45 11.8 13.1 4.6"/>',

    plus:
      '<path d="M8 3.1v9.8M3.1 8h9.8"/>',

    sparkle_ai:
      '<path d="M6.75 2.5 7.9 6.1 11.5 7.25 7.9 8.4 6.75 12 5.6 8.4 2 7.25 5.6 6.1 6.75 2.5Z"/>' +
      '<path d="M12.25 2.35v2.3M11.1 3.5h2.3M12.65 10.65v1.9M11.7 11.6h1.9"/>',

    external:
      '<path d="M9.6 2.5h3.9v3.9M13.5 2.5 7.85 8.15"/>' +
      '<path d="M11.6 9.15v2.95a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V5.8a1.4 1.4 0 0 1 1.4-1.4h2.95"/>',

    filter:
      '<path d="M2.35 3.25h11.3l-4.25 5.1v4.4l-2.8-1.4v-3L2.35 3.25Z"/>',

    pin:
      '<path d="M9.65 2.45 13.55 6.35l-1.2 1.2-.9-.2-2.2 2.2.3 1.7-1.05 1.05-4.8-4.8 1.05-1.05 1.7.3 2.2-2.2-.2-.9 1.2-1.2Z"/>' +
      '<path d="M6.1 9.9 2.65 13.35"/>',

    edit:
      '<path d="M10.7 2.65a1.45 1.45 0 0 1 2.05 2.05l-7.25 7.25-2.85.8.8-2.85 7.25-7.25Z"/>' +
      '<path d="M9.45 3.9 11.5 5.95"/>',

    trash:
      '<path d="M2.65 4.4h10.7M6.1 4.4V3.1a.85.85 0 0 1 .85-.85h2.1a.85.85 0 0 1 .85.85v1.3"/>' +
      '<path d="M4.1 4.4 4.75 12.6a1.3 1.3 0 0 0 1.3 1.15h3.9a1.3 1.3 0 0 0 1.3-1.15l.65-8.2"/>' +
      '<path d="M6.75 7.15v4M9.25 7.15v4"/>',

    arrow_right:
      '<path d="M2.75 8h10.5M9.15 4.1 13.25 8l-4.1 3.9"/>',

    chevron_down:
      '<path d="M3.75 6 8 10.25 12.25 6"/>',

    upload:
      '<path d="M8 10.5V2.85M4.75 6.1 8 2.85l3.25 3.25"/>' +
      '<path d="M2.5 10.5v1.65a1.35 1.35 0 0 0 1.35 1.35h8.3a1.35 1.35 0 0 0 1.35-1.35V10.5"/>',

    layers:
      '<path d="M8 2.3 13.5 5.35 8 8.4 2.5 5.35 8 2.3Z"/>' +
      '<path d="M2.5 8.15 8 11.2l5.5-3.05"/>' +
      '<path d="M2.5 10.85 8 13.9l5.5-3.05"/>',

    clock:
      '<circle cx="8" cy="8" r="5.65"/>' +
      '<path d="M8 4.85V8l2.25 1.35"/>',

    book:
      '<path d="M3.5 2.5h8.5a1 1 0 0 1 1 1v10h-8.5a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5Z"/>' +
      '<path d="M3 11.75A1.25 1.25 0 0 1 4.25 10.5H13M6.1 5.5h4.25"/>',

    network:
      '<circle cx="8" cy="8" r="1.65"/>' +
      '<circle cx="3.35" cy="4.25" r="1.25"/>' +
      '<circle cx="12.65" cy="4.25" r="1.25"/>' +
      '<circle cx="3.35" cy="12" r="1.25"/>' +
      '<circle cx="12.65" cy="12" r="1.25"/>' +
      '<path d="M4.45 5.1 6.7 6.9M11.55 5.1 9.3 6.9M4.45 11.15 6.7 9.15M11.55 11.15 9.3 9.15"/>',

    // --- EXTRA CONTACT & GIT PRECISION GLYPHS (2) ---
    phone:
      '<path d="M4.3 2.5h2.15l1 2.75-1.35 1.1a7.4 7.4 0 0 0 3.55 3.55l1.1-1.35 2.75 1v2.15a1.3 1.3 0 0 1-1.4 1.3C6.8 12.7 3.3 9.2 3 3.9A1.3 1.3 0 0 1 4.3 2.5Z"/>',

    repo:
      '<circle cx="4.5" cy="3.85" r="1.5"/>' +
      '<circle cx="11.5" cy="5.5" r="1.5"/>' +
      '<circle cx="4.5" cy="12.15" r="1.5"/>' +
      '<path d="M4.5 5.35v5.3M11.5 7v.5a2.75 2.75 0 0 1-2.75 2.75H6"/>',
  });

  // =========================================================================
  // ICON ALIAS RESOLUTION
  // =========================================================================

  const ICON_ALIASES = Object.freeze({
    wa: 'whatsapp',
    tg: 'telegram',
    imsg: 'imessage',
    sms: 'imessage',
    messages: 'imessage',
    email: 'mail',
    cal: 'calendar',
    gcal: 'calendar',
    ics: 'calendar',
    'wispr-flow': 'wispr',
    wispr_flow: 'wispr',
    voice: 'wispr',
    dictation: 'wispr',
    biometrics: 'whoop',
    health: 'whoop',
    'claude-code': 'claude',
    claude_code: 'claude',
    'mac-claude-sessions': 'claude',
    'codex-agent': 'codex_agent',
    'mac-codex-sessions': 'codex_agent',
    'mac-obsidian': 'obsidian',
    'apple-notes': 'apple_notes',
    'mac-notes': 'apple_notes',
    notes: 'apple_notes',
    x: 'x_social',
    twitter: 'x_social',
    'x-bookmarks': 'x_social',
    x_bookmarks: 'x_social',
    gh: 'github',
    git: 'repo',
    repository: 'repo',
    li: 'linkedin',
    web: 'globe',
    url: 'globe',
    website: 'globe',
    tel: 'phone',
    mobile: 'phone',
    location: 'map_pin',
    map: 'map_pin',
    philosophies: 'philosophy',
    interests: 'interest',
    hobbies: 'hobby',
    ideas: 'idea',
    actions: 'action_plane',
    action: 'action_plane',
    spark: 'stage_spark',
    validating: 'stage_validating',
    building: 'stage_building',
    shipped: 'stage_shipped',
    parked: 'stage_parked',
    gatekeeper: 'arch_gatekeeper',
    builder: 'arch_builder',
    founder: 'arch_founder',
    household: 'arch_household',
    signal: 'arch_signal',
    operator: 'arch_operator',
    ally: 'arch_ally',
  });

  function resolveIconName(rawName) {
    const key = String(rawName == null ? '' : rawName)
      .toLowerCase()
      .trim()
      .replace(/^kizuki\./, '');
    if (Object.prototype.hasOwnProperty.call(ICON_PATHS, key)) return key;
    if (Object.prototype.hasOwnProperty.call(ICON_ALIASES, key)) return ICON_ALIASES[key];
    const underscored = key.replace(/[\s-]+/g, '_');
    if (Object.prototype.hasOwnProperty.call(ICON_PATHS, underscored)) return underscored;
    if (Object.prototype.hasOwnProperty.call(ICON_ALIASES, underscored)) return ICON_ALIASES[underscored];
    return 'globe';
  }

  // =========================================================================
  // 1. CORE INLINE SVG RENDERER
  // =========================================================================

  function svg(name, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const resolved = resolveIconName(name);
    const size = normalizeSize(options.size, 14);
    const extraClass = sanitizeClassToken(options.className);
    const cls = extraClass
      ? 'k-icon k-icon-' + resolved + ' ' + extraClass
      : 'k-icon k-icon-' + resolved;

    const cleanTitle = options.title != null ? stripEmDash(String(options.title)).trim() : '';
    const a11yAttrs = cleanTitle
      ? ' role="img" aria-label="' + escapeHtml(cleanTitle) + '"'
      : ' aria-hidden="true"';
    const titleEl = cleanTitle ? '<title>' + escapeHtml(cleanTitle) + '</title>' : '';

    return (
      '<svg class="' + escapeHtml(cls) + '"' +
      ' width="' + size + '"' +
      ' height="' + size + '"' +
      ' viewBox="0 0 16 16"' +
      ' fill="none"' +
      ' stroke="currentColor"' +
      ' stroke-width="1.35"' +
      ' stroke-linecap="round"' +
      ' stroke-linejoin="round"' +
      a11yAttrs +
      ' focusable="false"' +
      ' data-icon="' + resolved + '">' +
      titleEl +
      ICON_PATHS[resolved] +
      '</svg>'
    );
  }

  // =========================================================================
  // 2. CHANNEL / SOURCE BADGE RENDERER
  // =========================================================================

  const CHANNEL_SPECS = Object.freeze({
    whatsapp: { slug: 'whatsapp', icon: 'whatsapp', label: 'WhatsApp', prefixes: /^(?:wa|whatsapp)\s+/i },
    telegram: { slug: 'telegram', icon: 'telegram', label: 'Telegram', prefixes: /^(?:tg|telegram)\s+/i },
    imessage: { slug: 'imessage', icon: 'imessage', label: 'iMessage', prefixes: /^(?:imsg|imessage|sms)\s+/i },
    gmail: { slug: 'gmail', icon: 'gmail', label: 'Gmail', prefixes: /^(?:gmail)\s+/i },
    calendar: { slug: 'calendar', icon: 'calendar', label: 'Calendar', prefixes: /^(?:cal|gcal|calendar)\s+/i },
    wispr: { slug: 'wispr', icon: 'wispr', label: 'Wispr', prefixes: /^(?:wispr(?:\s+flow)?)\s+/i },
    whoop: { slug: 'whoop', icon: 'whoop', label: 'Whoop', prefixes: /^(?:whoop)\s+/i },
    claude: { slug: 'claude', icon: 'claude', label: 'Claude', prefixes: /^(?:claude(?:\s+code)?)\s+/i },
    codex_agent: { slug: 'codex_agent', icon: 'codex_agent', label: 'Codex', prefixes: /^(?:codex)\s+/i },
    obsidian: { slug: 'obsidian', icon: 'obsidian', label: 'Obsidian', prefixes: /^(?:obsidian)\s+/i },
    apple_notes: { slug: 'apple_notes', icon: 'apple_notes', label: 'Apple Notes', prefixes: /^(?:apple\s+notes|notes)\s+/i },
    x_social: { slug: 'x_social', icon: 'x_social', label: 'X.com', prefixes: /^(?:x(?:\.com)?|twitter)\s+/i },
    github: { slug: 'github', icon: 'github', label: 'GitHub', prefixes: /^(?:gh|github)\s+/i },
    linkedin: { slug: 'linkedin', icon: 'linkedin', label: 'LinkedIn', prefixes: /^(?:li|linkedin)\s+/i },
    mail: { slug: 'mail', icon: 'mail', label: 'Email', prefixes: /^(?:mail|email)\s+/i },
    globe: { slug: 'globe', icon: 'globe', label: 'Web', prefixes: /^(?:web|url)\s+/i },
    map_pin: { slug: 'map_pin', icon: 'map_pin', label: 'Location', prefixes: null },
    camera: { slug: 'camera', icon: 'camera', label: 'Photos', prefixes: null },
  });

  function resolveChannelSpec(rawChannel) {
    const raw = String(rawChannel == null ? '' : rawChannel).toLowerCase().trim();
    const cleaned = raw.replace(/^kizuki\./, '');
    if (!cleaned) return { slug: 'inbox', icon: 'globe', label: 'Channel', prefixes: null, isBookmarks: false };

    if (cleaned.includes('whatsapp') || cleaned === 'wa') return CHANNEL_SPECS.whatsapp;
    if (cleaned.includes('telegram') || cleaned === 'tg') return CHANNEL_SPECS.telegram;
    if (cleaned.includes('imessage') || cleaned === 'imsg' || cleaned === 'sms' || cleaned === 'mac-imessage') {
      return CHANNEL_SPECS.imessage;
    }
    if (cleaned.includes('gmail') || cleaned === 'imap') return CHANNEL_SPECS.gmail;
    if (cleaned === 'mail' || cleaned === 'email') return CHANNEL_SPECS.mail;
    if (cleaned.includes('cal') || cleaned === 'ics') return CHANNEL_SPECS.calendar;
    if (cleaned.includes('wispr') || cleaned === 'voice' || cleaned === 'dictation') return CHANNEL_SPECS.wispr;
    if (cleaned.includes('whoop') || cleaned === 'biometrics') return CHANNEL_SPECS.whoop;
    if (cleaned.includes('claude')) return CHANNEL_SPECS.claude;
    if (cleaned.includes('codex')) return CHANNEL_SPECS.codex_agent;
    if (cleaned.includes('obsidian')) return CHANNEL_SPECS.obsidian;
    if (cleaned.includes('apple-notes') || cleaned.includes('apple_notes') || cleaned === 'mac-notes' || cleaned === 'notes') {
      return CHANNEL_SPECS.apple_notes;
    }
    if (
      cleaned === 'x' ||
      cleaned === 'x_social' ||
      cleaned === 'x-social' ||
      cleaned === 'x-api' ||
      cleaned === 'x-bookmarks' ||
      cleaned === 'x_bookmarks' ||
      cleaned.includes('twitter')
    ) {
      return {
        slug: CHANNEL_SPECS.x_social.slug,
        icon: CHANNEL_SPECS.x_social.icon,
        label: cleaned.includes('bookmark') ? 'Bookmarks' : CHANNEL_SPECS.x_social.label,
        prefixes: CHANNEL_SPECS.x_social.prefixes,
        isBookmarks: cleaned.includes('bookmark'),
      };
    }
    if (cleaned.includes('github') || cleaned === 'gh') return CHANNEL_SPECS.github;
    if (cleaned.includes('linkedin') || cleaned === 'li') return CHANNEL_SPECS.linkedin;
    if (cleaned === 'camera' || cleaned === 'photo' || cleaned === 'photos') return CHANNEL_SPECS.camera;
    if (cleaned === 'map_pin' || cleaned === 'map' || cleaned === 'location') return CHANNEL_SPECS.map_pin;
    if (cleaned === 'web' || cleaned === 'globe' || cleaned === 'url') return CHANNEL_SPECS.globe;

    const fallbackSlug = sanitizeSlug(cleaned, 'channel');
    const fallbackLabel = cleaned
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return { slug: fallbackSlug, icon: 'globe', label: fallbackLabel || 'Channel', prefixes: null };
  }

  function cleanChannelLabel(spec, rawLabel) {
    if (rawLabel == null || String(rawLabel).trim() === '') {
      return spec.label;
    }
    let text = stripEmDash(String(rawLabel)).replace(MULTI_SPACE_RE, ' ').trim();
    if (!text) return spec.label;

    // Collapse exact repeated short token pairs like "X X", "TG TG", "WA WA", "GH GH"
    text = text.replace(/^([A-Za-z0-9.]{1,12})\s+\1(?=$|\s)/i, '$1').trim();

    // Strip redundant leading channel prefix when followed by specific handle/sub-label
    if (spec.prefixes && spec.prefixes.test(text)) {
      const stripped = text.replace(spec.prefixes, '').trim();
      if (stripped) {
        text = stripped;
      }
    }

    // For X/Twitter icon, never render bare "X" beside an X SVG glyph (which visually reads "X X")
    if (spec.slug === 'x_social') {
      const lower = text.toLowerCase();
      if (lower === 'x' || lower === 'x x' || lower === 'x (twitter)' || lower === 'twitter') {
        return spec.isBookmarks ? 'Bookmarks' : 'X.com';
      }
    }

    return text || spec.label;
  }

  function channelBadge(channel, label, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const spec = resolveChannelSpec(channel);
    const displayLabel = cleanChannelLabel(spec, label);
    const iconSize = normalizeSize(options.size, 12);
    const extraClass = sanitizeClassToken(options.className);
    const cls = extraClass
      ? 'k-channel-pill is-' + spec.slug + ' ' + extraClass
      : 'k-channel-pill is-' + spec.slug;

    return (
      '<span class="' + escapeHtml(cls) + '" data-channel="' + escapeHtml(spec.slug) + '">' +
      svg(spec.icon, { size: iconSize, className: 'k-pill-icon' }) +
      '<span class="k-pill-label">' + escapeHtml(displayLabel) + '</span>' +
      '</span>'
    );
  }

  // =========================================================================
  // 3. PEOPLE ARCHETYPE BADGE RENDERER
  // =========================================================================

  const ARCHETYPE_RULES = Object.freeze([
    {
      key: 'gatekeeper',
      icon: 'arch_gatekeeper',
      pattern: /\b(gatekeeper|blocker|choke[\s-]?point|decision[\s-]?node|executive|approver)\b/i,
    },
    {
      key: 'builder',
      icon: 'arch_builder',
      pattern: /\b(builder|tangible[\s-]?systems|maker|creator|craftsman|designer|prototyper)\b/i,
    },
    {
      key: 'founder',
      icon: 'arch_founder',
      pattern: /\b(founder|co[\s-]?founder|ceo|cto|venture|entrepreneur|proof[\s-]?driven)\b/i,
    },
    {
      key: 'household',
      icon: 'arch_household',
      pattern: /\b(household|family|spouse|partner|home|inner[\s-]?circle|anchor)\b/i,
    },
    {
      key: 'operator',
      icon: 'arch_operator',
      pattern: /\b(operator|engineer|infra|systems|technical|devops|security|ops)\b/i,
    },
    {
      key: 'ally',
      icon: 'arch_ally',
      pattern: /\b(ally|collaborator|reciprocal|ecosystem|architect|investor|advisor|mentor|peer)\b/i,
    },
    {
      key: 'signal',
      icon: 'arch_signal',
      pattern: /\b(signal|ambient|correspondent|scout|observer|watch|contact)\b/i,
    },
  ]);

  function resolveArchetype(archetypeName) {
    const clean = stripEmDash(String(archetypeName == null ? '' : archetypeName))
      .replace(MULTI_SPACE_RE, ' ')
      .trim();
    const label = clean || 'Ambient Signal';
    for (let i = 0; i < ARCHETYPE_RULES.length; i += 1) {
      if (ARCHETYPE_RULES[i].pattern.test(label)) {
        return { key: ARCHETYPE_RULES[i].key, icon: ARCHETYPE_RULES[i].icon, label: label };
      }
    }
    return { key: 'signal', icon: 'arch_signal', label: label };
  }

  function archetypeBadge(archetypeName, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const info = resolveArchetype(archetypeName);
    const iconSize = normalizeSize(options.size, 13);
    const extraClass = sanitizeClassToken(options.className);
    const cls = extraClass
      ? 'k-archetype-chip is-' + info.key + ' ' + extraClass
      : 'k-archetype-chip is-' + info.key;

    return (
      '<span class="' + escapeHtml(cls) + '" data-archetype="' + escapeHtml(info.key) + '">' +
      svg(info.icon, { size: iconSize, className: 'k-chip-icon' }) +
      '<span class="k-chip-label">' + escapeHtml(info.label) + '</span>' +
      '</span>'
    );
  }

  // =========================================================================
  // 4. CODEX IDEA STAGE BADGE RENDERER
  // =========================================================================

  const STAGE_SPECS = Object.freeze({
    spark: { slug: 'spark', icon: 'stage_spark', label: 'Spark' },
    validating: { slug: 'validating', icon: 'stage_validating', label: 'Validating' },
    building: { slug: 'building', icon: 'stage_building', label: 'Building' },
    shipped: { slug: 'shipped', icon: 'stage_shipped', label: 'Shipped' },
    parked: { slug: 'parked', icon: 'stage_parked', label: 'Parked' },
  });

  function resolveStage(rawStage) {
    const s = String(rawStage == null ? '' : rawStage)
      .toLowerCase()
      .trim()
      .replace(/^stage_/, '');
    if (Object.prototype.hasOwnProperty.call(STAGE_SPECS, s)) return STAGE_SPECS[s];
    if (s === 'seed' || s === 'idea' || s === 'concept' || s === 'new') return STAGE_SPECS.spark;
    if (s === 'validate' || s === 'testing' || s === 'research' || s === 'exploring') return STAGE_SPECS.validating;
    if (s === 'build' || s === 'active' || s === 'in_progress' || s === 'wip') return STAGE_SPECS.building;
    if (s === 'ship' || s === 'live' || s === 'launched' || s === 'done' || s === 'complete') return STAGE_SPECS.shipped;
    if (s === 'park' || s === 'paused' || s === 'hold' || s === 'archived' || s === 'icebox') return STAGE_SPECS.parked;
    return STAGE_SPECS.spark;
  }

  function stageBadge(stage, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const spec = resolveStage(stage);
    const iconSize = normalizeSize(options.size, 12);
    const extraClass = sanitizeClassToken(options.className);
    const cls = extraClass
      ? 'k-stage-pill is-' + spec.slug + ' ' + extraClass
      : 'k-stage-pill is-' + spec.slug;

    return (
      '<span class="' + escapeHtml(cls) + '" data-stage="' + escapeHtml(spec.slug) + '">' +
      svg(spec.icon, { size: iconSize, className: 'k-pill-icon' }) +
      '<span class="k-pill-label">' + escapeHtml(spec.label) + '</span>' +
      '</span>'
    );
  }

  // =========================================================================
  // 5. CONTACT KIND ICON RESOLVER
  // =========================================================================

  const CONTACT_KIND_MAP = Object.freeze({
    email: 'mail',
    mail: 'mail',
    gmail: 'gmail',
    telegram: 'telegram',
    tg: 'telegram',
    x: 'x_social',
    twitter: 'x_social',
    x_social: 'x_social',
    github: 'github',
    gh: 'github',
    linkedin: 'linkedin',
    li: 'linkedin',
    web: 'globe',
    url: 'globe',
    website: 'globe',
    site: 'globe',
    whatsapp: 'whatsapp',
    wa: 'whatsapp',
    imessage: 'imessage',
    imsg: 'imessage',
    sms: 'imessage',
    repo: 'repo',
    git: 'repo',
    repository: 'repo',
    phone: 'phone',
    tel: 'phone',
    mobile: 'phone',
    calendar: 'calendar',
    cal: 'calendar',
    location: 'map_pin',
    map: 'map_pin',
  });

  function contactIconForKind(kind, opts) {
    const k = String(kind == null ? '' : kind).toLowerCase().trim();
    const iconName = Object.prototype.hasOwnProperty.call(CONTACT_KIND_MAP, k)
      ? CONTACT_KIND_MAP[k]
      : 'globe';
    return svg(iconName, opts);
  }

  function has(name) {
    const key = String(name == null ? '' : name).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(ICON_PATHS, key) ||
      Object.prototype.hasOwnProperty.call(ICON_ALIASES, key);
  }

  function names() {
    return Object.keys(ICON_PATHS);
  }

  return Object.freeze({
    svg: svg,
    channelBadge: channelBadge,
    archetypeBadge: archetypeBadge,
    stageBadge: stageBadge,
    contactIconForKind: contactIconForKind,
    has: has,
    names: names,
    ICON_COUNT: Object.keys(ICON_PATHS).length,
  });
});
