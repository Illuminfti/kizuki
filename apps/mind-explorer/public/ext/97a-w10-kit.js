/* Kizuki Wave 10 component kit.
   window.KizukiKit: pure functions that return HTML strings. Every value comes from arguments;
   a missing value renders as '--' or an explicit unavailable state, never a stand-in number.
   Generated visuals (avatars, banners, covers) are local SVG/CSS derived from a string hash. */
(function initKizukiKit(root) {
  'use strict';
  if (root.KizukiKit && root.KizukiKit.__v === 1) return;

  const TONES = ['cobalt', 'orange', 'emerald', 'violet', 'rose', 'slate'];
  const TONE_ALIAS = { blue: 'cobalt', green: 'emerald', amber: 'orange', red: 'rose', neutral: 'slate', gray: 'slate', grey: 'slate' };
  const TONE_HUE = { cobalt: 255, orange: 50, emerald: 155, violet: 295, rose: 20, slate: 250 };

  function esc(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hash(str) {
    let h = 0x811c9dc5;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let a = hash(seed) || 1;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function tone(t) {
    const k = String(t || '').toLowerCase();
    if (TONES.includes(k)) return k;
    if (TONE_ALIAS[k]) return TONE_ALIAS[k];
    return 'slate';
  }

  function isBlank(v) {
    return v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  }

  function fmt(v) {
    if (isBlank(v)) return '--';
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (Number.isInteger(v)) return v.toLocaleString('en-GB');
      return v.toLocaleString('en-GB', { maximumFractionDigits: 1 });
    }
    return String(v);
  }

  function initials(name) {
    const parts = String(name || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function personName(p) {
    if (p == null) return '';
    if (typeof p === 'string') return p;
    return p.name || p.display_name || p.title || p.label || p.key || p.id || '';
  }

  function num(v, lo, hi) {
    if (isBlank(v) || typeof v === 'boolean') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(lo, Math.min(hi, n));
  }

  function actionAttr(action) {
    return action ? ` data-k10-action="${esc(action)}"` : '';
  }

  /* ---------------------------------------------------------------- icons */
  const ICONS = {
    doc: '<path d="M3.5 2.5h6.2L13 5.8v7.7H3.5V2.5Z"/><path d="M9.5 2.5v3.5H13"/>',
    inbox: '<rect x="2.2" y="3.5" width="11.6" height="9" rx="1.8"/><path d="M2.5 5.2 8 9l5.5-3.8"/>',
    check: '<circle cx="8" cy="8" r="5.8"/><path d="m5.4 8.2 1.8 1.8 3.5-3.7"/>',
    person: '<circle cx="8" cy="5.4" r="2.5"/><path d="M3 13.5c.5-2.6 2.5-4 5-4s4.5 1.4 5 4"/>',
    people: '<circle cx="6.2" cy="5.6" r="2"/><path d="M2.5 12.6c.4-2 1.8-3 3.7-3s3.3 1 3.7 3M10.6 4.6a1.8 1.8 0 0 1 0 3.2M11.6 9.9c1 .4 1.7 1.3 1.9 2.7"/>',
    spark: '<path d="M8 1.8l1.4 4L13.4 7l-4 1.4L8 12.4 6.6 8.4 2.6 7l4-1.2L8 1.8Z"/>',
    clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.2"/>',
    calendar: '<rect x="2.5" y="3.2" width="11" height="10.2" rx="1.6"/><path d="M5.2 2v2.2M10.8 2v2.2M2.5 6.6h11"/>',
    graph: '<circle cx="8" cy="3.5" r="1.5"/><circle cx="3.8" cy="11.5" r="1.5"/><circle cx="12.2" cy="11.5" r="1.5"/><path d="M7.1 4.9 4.6 10.1M8.9 4.9l2.5 5.2M5.3 11.5h5.4"/>',
    pulse: '<path d="M1.8 8.4h2.6l1.6-4 2.6 8 1.8-5.2 1 1.2h2.8"/>',
    folder: '<path d="M2.2 4.4c0-.8.6-1.4 1.4-1.4h2.6l1.4 1.6h4.8c.8 0 1.4.6 1.4 1.4v5.6c0 .8-.6 1.4-1.4 1.4H3.6c-.8 0-1.4-.6-1.4-1.4V4.4Z"/>',
    tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6v-5Z"/><circle cx="5.4" cy="5.4" r=".9"/>',
    chat: '<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6.2L3.2 13.5V11H4a1.5 1.5 0 0 1-1.5-1.5V4Z"/>',
    star: '<path d="m8 2 1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.8 4.1-.5L8 2Z"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7"/>',
    map: '<path d="M2.5 4.2 6 2.8l4 1.6 3.5-1.4v8.8L10 13.2l-4-1.6-3.5 1.4V4.2Z"/><path d="M6 2.8v8.8M10 4.4v8.8"/>',
    bolt: '<path d="M9 1.8 3.6 9h4l-.6 5.2L12.4 7h-4L9 1.8Z"/>',
    layers: '<path d="m8 2.2 5.8 3L8 8.2l-5.8-3L8 2.2Z"/><path d="m2.2 8 5.8 3 5.8-3M2.2 10.8l5.8 3 5.8-3"/>',
    eye: '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.9"/>',
    brain: '<path d="M6 2.8a2 2 0 0 0-2 2v.3a2.2 2.2 0 0 0-1 3.9 2.2 2.2 0 0 0 2.2 3.3A1.9 1.9 0 0 0 8 13V3.9a1.9 1.9 0 0 0-2-1.1Z"/><path d="M10 2.8a2 2 0 0 1 2 2v.3a2.2 2.2 0 0 1 1 3.9 2.2 2.2 0 0 1-2.2 3.3A1.9 1.9 0 0 1 8 13"/>',
    search: '<circle cx="7" cy="7" r="4.4"/><path d="m10.3 10.3 3.3 3.3"/>',
    arrow: '<path d="M3 8h9.6M8.8 4.2 12.6 8l-3.8 3.8"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.7 1.7 2.4 3.6 2.4 5.8S9.7 12.1 8 13.8C6.3 12.1 5.6 10.2 5.6 8S6.3 3.9 8 2.2Z"/>',
    image: '<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6"/><circle cx="5.8" cy="6.2" r="1.2"/><path d="m2.6 11.6 3.4-3.2 2.4 2.2 2-1.8 3 2.8"/>',
    archive: '<rect x="2" y="2.8" width="12" height="3.2" rx="1"/><path d="M3 6v6.2c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.4 8.6h3.2"/>',
    alert: '<path d="M8 2.2 14 13H2L8 2.2Z"/><path d="M8 6.4v3M8 11.2v.2"/>',
    mic: '<rect x="6" y="2" width="4" height="7.4" rx="2"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14"/>',
  };

  function icon(name, size) {
    const body = ICONS[name];
    if (!body) return '';
    const s = Number(size) > 0 ? Number(size) : 14;
    return `<svg class="k10-ic" width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  /* -------------------------------------------------------------- avatars */
  function safeImageSrc(src) {
    if (!src || typeof src !== 'string') return null;
    const s = src.trim();
    if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^blob:/i.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return s;
    try {
      const u = new URL(s, root.location ? root.location.href : 'http://localhost/');
      if (root.location && u.origin === root.location.origin) return u.href;
    } catch (_) { /* invalid */ }
    return null;
  }

  const HAIR = [
    'M20.4 28C19.6 19 25 14.2 32 14.2S44.4 19 43.6 28C42 23 38 20.6 32 20.6S22 23 20.4 28Z',
    'M20.2 29C19 19.4 24.6 13.8 32.4 13.8C39.6 13.8 44.6 18.8 43.8 27C40 25.6 36 23 33.6 19.4C30.6 23.6 25.8 26.8 20.2 29Z',
    'M19 44C17 36 18 26 19.6 21.6C21.6 16.4 26.4 13.4 32 13.4S42.4 16.4 44.4 21.6C46 26 47 36 45 44C43.6 40 43 34 42.6 28C41 23.4 37 21 32 21S23 23.4 21.4 28C21 34 20.4 40 19 44Z',
    'M32 6.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2ZM20.6 27.6C20 19.6 25.2 14.6 32 14.6S44 19.6 43.4 27.6C41.6 23.2 37.6 20.8 32 20.8S22.4 23.2 20.6 27.6Z',
    'M19.6 27C17.6 22 19.4 16 24 13.6C26.6 11 30.2 10.8 32.6 11.6C36 10.6 40.4 12 42.6 15.4C45.6 18.6 46 23.4 44.4 27.6C42.6 23.6 38.6 20.8 32 20.8S21.4 23 19.6 27Z',
    'M20.8 30.4C19.4 22 23.4 14 32 14C40.6 14 44.6 22 43.2 30.4C42.6 26.4 41.4 24 39.6 22.6C36.4 24 28.6 24.2 24.4 22.6C22.6 24 21.4 26.4 20.8 30.4Z',
  ];

  function avatarParts(name) {
    const h = hash(name || '?');
    const hue = h % 360;
    const hue2 = (hue + 28 + ((h >>> 9) % 36)) % 360;
    return {
      h,
      hue,
      hue2,
      hair: (h >>> 4) % HAIR.length,
      sw: 10 + ((h >>> 12) % 6),
      head: 0.95 + ((h >>> 16) % 9) / 100,
      collar: (h >>> 20) % 3,
      lit: 40 + ((h >>> 24) % 30),
    };
  }

  function portraitSvg(parts) {
    const { sw, head, hair, collar } = parts;
    const hx = 32;
    const hy = 28.4;
    const rx = (11 * head).toFixed(2);
    const ry = (12.6 * head).toFixed(2);
    const l = 32 - sw - 13;
    const r = 32 + sw + 13;
    const collarPath = collar === 0
      ? `<path class="k10-av-collar" d="M26.4 45.2 32 52l5.6-6.8"/>`
      : collar === 1
        ? `<path class="k10-av-collar" d="M25 45.6c2 3 4.4 4.4 7 4.4s5-1.4 7-4.4"/>`
        : '';
    return `<svg class="k10-av-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path class="k10-av-body" d="M${l} 66c0-12.4 7.6-20.6 ${(32 - l).toFixed(1)}-21.6S${r} 52.6 ${r} 66Z"/>
      <path class="k10-av-neck" d="M27.6 37.6h8.8v7c-1.3 1.3-2.8 2-4.4 2s-3.1-.7-4.4-2Z"/>
      ${collarPath}
      <ellipse class="k10-av-head" cx="${hx}" cy="${hy}" rx="${rx}" ry="${ry}"/>
      ${HAIR[hair] ? `<path class="k10-av-hair" d="${HAIR[hair]}"/>` : ''}
    </svg>`;
  }

  function avatar(person, opts) {
    const o = opts || {};
    const name = personName(person) || 'Unknown';
    const size = Math.max(16, Math.min(160, Number(o.size) || 32));
    const parts = avatarParts(name);
    // Real people never get an invented face: without a photo they get a monogram. 'portrait' is opt-in for abstract agents.
    const mode = o.mode === 'portrait' ? 'portrait' : 'initials';
    const portrait = mode === 'portrait' || (mode === 'auto' && size >= 28);
    const src = person && typeof person === 'object' ? safeImageSrc(person.avatar_url || person.photo) : null;
    const ringTone = o.ring ? tone(o.ring === true ? 'cobalt' : o.ring) : '';
    const style = `--k10-av-size:${size}px;--k10-av-h:${parts.hue};--k10-av-h2:${parts.hue2};--k10-av-lit:${parts.lit}%`;
    const cls = ['k10-av', portrait ? 'is-portrait' : 'is-initials', ringTone ? `has-ring k10-tone-${ringTone}` : '', size <= 24 ? 'is-xs' : size >= 64 ? 'is-lg' : '']
      .filter(Boolean)
      .join(' ');
    const fallback = portrait
      ? portraitSvg(parts)
      : `<span class="k10-av-ini" aria-hidden="true">${esc(initials(name))}</span>`;
    const img = src
      ? `<img class="k10-av-img" src="${esc(src)}" alt="${esc(name)}" loading="lazy" decoding="async" width="${size}" height="${size}">`
      : '';
    const label = src ? '' : ` role="img" aria-label="${esc(name)}"`;
    return `<span class="${cls}" style="${style}"${label} title="${esc(name)}">${fallback}${img}</span>`;
  }

  function avatarStack(people, opts) {
    const o = opts || {};
    const list = Array.isArray(people) ? people.filter((p) => personName(p)) : [];
    if (!list.length) return '';
    const max = Math.max(1, Number(o.max) || 4);
    const size = Number(o.size) || 22;
    const shown = list.slice(0, max);
    const extra = list.length - shown.length;
    const names = list.map(personName).join(', ');
    return `<span class="k10-av-stack" style="--k10-av-size:${size}px" role="group" aria-label="${esc(names)}">${shown
      .map((p) => avatar(p, { size, mode: o.mode }))
      .join('')}${extra > 0 ? `<span class="k10-av k10-av-more" style="--k10-av-size:${size}px" title="${esc(list.slice(max).map(personName).join(', '))}">+${extra}</span>` : ''}</span>`;
  }

  /* ---------------------------------------------------------- generated art */
  function contourPaths(r, cx, cy, rings, wobble, scale) {
    const out = [];
    const phase = r() * Math.PI * 2;
    const f1 = 2 + Math.floor(r() * 3);
    const f2 = 3 + Math.floor(r() * 4);
    for (let k = 0; k < rings; k++) {
      const base = (k + 1) * scale;
      const pts = [];
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const w = 1 + wobble * (0.6 * Math.sin(a * f1 + phase + k * 0.35) + 0.4 * Math.sin(a * f2 - phase * 0.7));
        pts.push(`${(cx + Math.cos(a) * base * 1.35 * w).toFixed(1)},${(cy + Math.sin(a) * base * w).toFixed(1)}`);
      }
      out.push(`<polyline points="${pts.join(' ')}"/>`);
    }
    return out.join('');
  }

  const ART_KINDS = ['contour', 'orbit', 'grid', 'aurora'];

  function artLayer(seed, toneName, kind, w, h) {
    const r = rng(seed);
    const k = ART_KINDS.includes(kind) ? kind : ART_KINDS[hash(seed) % ART_KINDS.length];
    const base = TONE_HUE[toneName] != null ? TONE_HUE[toneName] : 250;
    const h1 = Math.round((base + (r() * 40 - 20) + 360) % 360);
    const h2 = Math.round((h1 + 40 + r() * 50) % 360);
    const h3 = Math.round((h1 - 50 - r() * 40 + 360) % 360);
    const x1 = Math.round(55 + r() * 35);
    const y1 = Math.round(10 + r() * 40);
    const x2 = Math.round(70 + r() * 28);
    const y2 = Math.round(50 + r() * 45);
    const style = `--k10-h1:${h1};--k10-h2:${h2};--k10-h3:${h3};--k10-x1:${x1}%;--k10-y1:${y1}%;--k10-x2:${x2}%;--k10-y2:${y2}%`;
    let svg = '';
    const cx = w * (0.62 + r() * 0.26);
    const cy = h * (0.3 + r() * 0.5);
    if (k === 'contour' || k === 'aurora') {
      svg = `<g class="k10-art-lines">${contourPaths(r, cx, cy, k === 'aurora' ? 6 : 11, 0.16 + r() * 0.1, h / (k === 'aurora' ? 6 : 9))}</g>`;
    } else if (k === 'orbit') {
      const rings = [];
      const nodes = [];
      for (let i = 1; i <= 6; i++) {
        const rad = i * (h / 7);
        rings.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(rad * 1.5).toFixed(1)}" ry="${rad.toFixed(1)}"/>`);
        const a = r() * Math.PI * 2;
        nodes.push(`<circle cx="${(cx + Math.cos(a) * rad * 1.5).toFixed(1)}" cy="${(cy + Math.sin(a) * rad).toFixed(1)}" r="${(1.6 + r() * 1.6).toFixed(1)}"/>`);
      }
      svg = `<g class="k10-art-lines">${rings.join('')}</g><g class="k10-art-nodes">${nodes.join('')}</g>`;
    } else {
      const lines = [];
      const step = 22;
      for (let x = step; x < w; x += step) lines.push(`<path d="M${x} 0V${h}"/>`);
      for (let y = step; y < h; y += step) lines.push(`<path d="M0 ${y}H${w}"/>`);
      const cells = [];
      const n = 7 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        const gx = Math.floor((0.45 + r() * 0.55) * (w / step)) * step;
        const gy = Math.floor(r() * (h / step)) * step;
        cells.push(`<rect x="${gx}" y="${gy}" width="${step}" height="${step}" style="opacity:${(0.25 + r() * 0.6).toFixed(2)}"/>`);
      }
      svg = `<g class="k10-art-grid">${lines.join('')}</g><g class="k10-art-cells">${cells.join('')}</g>`;
    }
    return `<div class="k10-art k10-art-${k}" style="${style}" aria-hidden="true"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" focusable="false">${svg}</svg></div>`;
  }

  function banner(opts) {
    const o = opts || {};
    const t = tone(o.tone || 'cobalt');
    const seed = o.seed != null ? String(o.seed) : String(o.title || 'kizuki');
    const stats = Array.isArray(o.stats) ? o.stats.filter((s) => s && s.label) : [];
    const eyebrow = o.eyebrow ? `<div class="k10-banner-eyebrow">${o.eyebrowIcon ? icon(o.eyebrowIcon, 13) : ''}${esc(o.eyebrow)}</div>` : '';
    const lead = o.avatar ? `<div class="k10-banner-lead">${avatar(o.avatar, { size: 64 })}</div>` : '';
    return `<section class="k10-banner k10-tone-${t}${o.compact ? ' is-compact' : ''}"${o.title ? ` aria-label="${esc(o.title)}"` : ''}>
      ${artLayer(seed, t, o.art, 720, 220)}
      <div class="k10-banner-body">
        ${lead}
        <div class="k10-banner-text">
          ${eyebrow}
          ${o.title ? `<h2 class="k10-banner-title">${esc(o.title)}</h2>` : ''}
          ${o.subtitle ? `<p class="k10-banner-sub">${esc(o.subtitle)}</p>` : ''}
        </div>
        ${o.right ? `<div class="k10-banner-right">${o.right}</div>` : ''}
      </div>
      ${stats.length ? `<dl class="k10-banner-stats">${stats
        .map((s) => `<div class="k10-banner-stat${isBlank(s.value) ? ' is-empty' : ''}"><dt>${esc(s.label)}</dt><dd>${esc(fmt(s.value))}</dd></div>`)
        .join('')}</dl>` : ''}
    </section>`;
  }

  function coverArt(seed, toneName, opts) {
    const o = opts || {};
    const t = tone(toneName || 'slate');
    const hgt = Math.max(36, Math.min(320, Number(o.height) || 96));
    return `<div class="k10-cover k10-tone-${t}" style="--k10-cover-h:${hgt}px">${artLayer(String(seed == null ? '' : seed), t, o.art, 320, 120)}${o.label ? `<span class="k10-cover-label">${esc(o.label)}</span>` : ''}</div>`;
  }

  /* ------------------------------------------------------------ data viz */
  function toneColor(c) {
    if (!c) return 'var(--k10-tone)';
    const t = String(c).toLowerCase();
    if (TONES.includes(t) || TONE_ALIAS[t]) return `var(--k10-c-${tone(t)})`;
    if (/^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\)|(rgb|hsl|oklch)a?\([0-9.,%\s/a-z-]+\))$/i.test(String(c).trim())) return String(c).trim();
    return 'var(--k10-tone)';
  }

  function ring(pct, color, opts) {
    const o = opts || {};
    const size = Math.max(20, Math.min(160, Number(o.size) || 36));
    const sw = Number(o.stroke) || Math.max(2.4, size / 12);
    const rad = (size - sw) / 2;
    const c = 2 * Math.PI * rad;
    const p = num(pct, 0, 100);
    const label = o.label != null ? o.label : p == null ? '--' : `${Math.round(p)}`;
    const aria = o.aria || (p == null ? 'Unavailable' : `${Math.round(p)} percent`);
    const off = p == null ? c : c * (1 - p / 100);
    return `<span class="k10-ring${p == null ? ' is-empty' : ''}" style="--k10-ring-size:${size}px" role="img" aria-label="${esc(aria)}">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
        <circle class="k10-ring-track" cx="${size / 2}" cy="${size / 2}" r="${rad.toFixed(2)}" stroke-width="${sw.toFixed(2)}"${p == null ? ' stroke-dasharray="2 3"' : ''}/>
        ${p == null ? '' : `<circle class="k10-ring-val" cx="${size / 2}" cy="${size / 2}" r="${rad.toFixed(2)}" stroke-width="${sw.toFixed(2)}" style="stroke:${toneColor(color)}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>`}
      </svg>
      ${label === '' ? '' : `<span class="k10-ring-num">${esc(label)}</span>`}
    </span>`;
  }

  function bars(items, opts) {
    const o = opts || {};
    const list = Array.isArray(items) ? items.filter((b) => b && (b.label || b.name)) : [];
    if (!list.length) return unavailable(o.empty || 'No data');
    const values = list.filter((b) => !isBlank(b.value)).map((b) => Number(b.value)).filter((v) => Number.isFinite(v));
    const max = Number(o.max) > 0 ? Number(o.max) : Math.max(0, ...values);
    // Clickable bars are buttons (toggle state via aria-pressed), so the container is a group, not a list.
    const anyAction = list.some((b) => b && b.action);
    return `<div class="k10-bars" role="${anyAction ? 'group' : 'list'}">${list
      .map((b) => {
        const v = Number(b.value);
        const ok = !isBlank(b.value) && typeof b.value !== 'boolean' && Number.isFinite(v);
        const pct = ok && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
        const lead = b.person ? avatar(b.person, { size: 20 }) : b.icon ? `<span class="k10-bar-ic">${icon(b.icon, 12)}</span>` : '';
        const shown = b.display != null ? b.display : fmt(ok ? v : null);
        const tag = b.action ? 'button type="button"' : 'div';
        const close = b.action ? 'button' : 'div';
        return `<${tag} class="k10-bar${ok ? '' : ' is-empty'}"${anyAction ? '' : ' role="listitem"'}${actionAttr(b.action)}${b.id != null ? ` data-k10-id="${esc(b.id)}"` : ''}>
          <span class="k10-bar-label">${lead}<span class="k10-truncate">${esc(b.label || b.name)}</span></span>
          <span class="k10-bar-track"><span class="k10-bar-fill" style="width:${pct.toFixed(1)}%;background:${toneColor(b.tone || o.tone)}"></span></span>
          <span class="k10-bar-val">${esc(shown)}${b.detail ? `<span class="k10-bar-detail">${esc(b.detail)}</span>` : ''}</span>
        </${close}>`;
      })
      .join('')}</div>`;
  }

  function sparkline(values, opts) {
    const o = opts || {};
    const vals = (Array.isArray(values) ? values : []).map((v) => (isBlank(v) ? NaN : Number(v)));
    const finite = vals.filter((v) => Number.isFinite(v));
    if (finite.length < 2) return unavailable(o.empty || 'Not enough data');
    const w = Number(o.width) || 120;
    const h = Number(o.height) || 32;
    const pad = 2;
    const min = o.min != null ? Number(o.min) : Math.min(...finite);
    const max = Math.max(...finite);
    const span = max - min || 1;
    const stepX = (w - pad * 2) / Math.max(1, vals.length - 1);
    // Gaps stay gaps: each run of consecutive values is its own segment.
    const segs = [[]];
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        if (segs[segs.length - 1].length) segs.push([]);
        return;
      }
      segs[segs.length - 1].push([pad + i * stepX, h - pad - ((v - min) / span) * (h - pad * 2)]);
    });
    const runs = segs.filter((sg) => sg.length);
    const pts = runs.flat();
    const last = pts[pts.length - 1];
    const ptsStr = (sg) => sg.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const lines = runs
      .map((sg) => (sg.length > 1 ? `<polyline class="k10-spark-line" points="${ptsStr(sg)}"/>` : `<circle class="k10-spark-dot" cx="${sg[0][0].toFixed(1)}" cy="${sg[0][1].toFixed(1)}" r="1.4"/>`))
      .join('');
    const area = o.area === false
      ? ''
      : runs
          .filter((sg) => sg.length > 1)
          .map((sg) => `<polygon class="k10-spark-area" points="${sg[0][0].toFixed(1)},${h} ${ptsStr(sg)} ${sg[sg.length - 1][0].toFixed(1)},${h}"/>`)
          .join('');
    const aria = o.aria || `Trend of ${finite.length} values, latest ${fmt(finite[finite.length - 1])}`;
    return `<svg class="k10-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="--k10-spark:${toneColor(o.tone)}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="none">${area}${lines}<circle class="k10-spark-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2"/></svg>`;
  }

  function meter(pct, opts) {
    const o = opts || {};
    const p = num(pct, 0, 100);
    return `<div class="k10-meter${p == null ? ' is-empty' : ''}">
      ${o.label ? `<div class="k10-meter-head"><span>${esc(o.label)}</span><span class="k10-meter-val">${p == null ? '--' : `${Math.round(p)}%`}</span></div>` : ''}
      <div class="k10-meter-track" role="meter" aria-valuemin="0" aria-valuemax="100"${p == null ? '' : ` aria-valuenow="${Math.round(p)}"`} aria-label="${esc(o.label || 'Progress')}">
        <span class="k10-meter-fill" style="width:${p == null ? 0 : p.toFixed(1)}%;background:${toneColor(o.tone)}"></span>
      </div>
    </div>`;
  }

  /* --------------------------------------------------------- composition */
  function statTile(opts) {
    const o = opts || {};
    const t = tone(o.tone || 'slate');
    const empty = isBlank(o.value);
    const tag = o.action ? 'button type="button"' : 'div';
    const close = o.action ? 'button' : 'div';
    return `<${tag} class="k10-stat k10-tone-${t}${empty ? ' is-empty' : ''}"${actionAttr(o.action)}>
      <div class="k10-stat-top">
        <span class="k10-stat-label">${esc(o.label || '')}</span>
        ${o.icon && ICONS[o.icon] ? `<span class="k10-stat-icon">${icon(o.icon, 14)}</span>` : ''}
      </div>
      <div class="k10-stat-val">${esc(fmt(o.value))}${o.unit && !empty ? `<span class="k10-stat-unit">${esc(o.unit)}</span>` : ''}</div>
      ${o.sub ? `<div class="k10-stat-sub">${esc(o.sub)}</div>` : empty ? `<div class="k10-stat-sub">Unavailable</div>` : ''}
      ${o.spark ? `<div class="k10-stat-spark">${o.spark}</div>` : ''}
    </${close}>`;
  }

  function sectionHead(title, right, opts) {
    const o = opts || {};
    const lvl = o.level === 3 ? 'h3' : 'h2';
    return `<div class="k10-sec-head">
      <div class="k10-sec-titles"><${lvl} class="k10-sec-title">${esc(title || '')}</${lvl}>${o.sub ? `<span class="k10-sec-sub">${esc(o.sub)}</span>` : ''}</div>
      ${right ? `<div class="k10-sec-right">${right}</div>` : ''}
    </div>`;
  }

  function card(opts) {
    const o = opts || {};
    const head = o.title ? `<header class="k10-card-head"><div><h3 class="k10-card-title">${esc(o.title)}</h3>${o.sub ? `<div class="k10-card-sub">${esc(o.sub)}</div>` : ''}</div>${o.right ? `<div class="k10-card-right">${o.right}</div>` : ''}</header>` : '';
    return `<article class="k10-card${o.tone ? ` k10-tone-${tone(o.tone)} has-tone` : ''}${o.flush ? ' is-flush' : ''}">${o.cover || ''}${head}<div class="k10-card-body">${o.body || ''}</div></article>`;
  }

  function emptyState(opts) {
    const o = opts || {};
    const act = o.action && o.action.label
      ? `<button type="button" class="k10-btn" data-k10-action="${esc(o.action.action || o.action.id || '')}">${o.action.icon ? icon(o.action.icon, 13) : ''}${esc(o.action.label)}</button>`
      : '';
    return `<div class="k10-empty${o.compact ? ' is-compact' : ''}">
      <span class="k10-empty-ic" aria-hidden="true">${icon(o.icon && ICONS[o.icon] ? o.icon : 'layers', 18)}</span>
      <div class="k10-empty-title">${esc(o.title || 'Nothing here yet')}</div>
      ${o.body ? `<p class="k10-empty-body">${esc(o.body)}</p>` : ''}
      ${act}
    </div>`;
  }

  function unavailable(label) {
    return `<span class="k10-unavail"><span class="k10-unavail-dot" aria-hidden="true"></span>${esc(label || 'Unavailable')}</span>`;
  }

  function chip(text, toneName, opts) {
    const o = opts || {};
    if (isBlank(text)) return '';
    const t = toneName ? tone(toneName) : '';
    return `<span class="k10-chip${t ? ` k10-tone-${t} is-toned` : ''}">${o.dot !== false && t ? '<span class="k10-chip-dot" aria-hidden="true"></span>' : ''}${o.icon ? icon(o.icon, 12) : ''}${esc(text)}</span>`;
  }

  function personRow(person, meta) {
    const m = meta || {};
    const name = personName(person) || 'Unknown';
    const key = person && typeof person === 'object' ? person.key || person.id || person.slug || '' : '';
    const tag = m.action ? 'button type="button"' : 'div';
    const close = m.action ? 'button' : 'div';
    const right = m.right != null && m.right !== '' ? `<span class="k10-prow-right">${esc(m.right)}${m.rightSub ? `<span class="k10-prow-rsub">${esc(m.rightSub)}</span>` : ''}</span>` : '';
    return `<${tag} class="k10-prow${m.selected ? ' is-selected' : ''}"${actionAttr(m.action)}${key ? ` data-k10-person="${esc(key)}"` : ''}>
      ${avatar(person, { size: Number(m.size) || 32, ring: m.ring })}
      <span class="k10-prow-body">
        <span class="k10-prow-name k10-truncate">${esc(name)}</span>
        ${m.sub ? `<span class="k10-prow-sub k10-truncate">${esc(m.sub)}</span>` : ''}
      </span>
      ${m.spark ? `<span class="k10-prow-spark">${m.spark}</span>` : ''}
      ${m.chip ? chip(m.chip, m.tone || 'slate') : ''}
      ${right}
    </${close}>`;
  }

  /* Remove <img> that fails so the generated portrait underneath shows. */
  if (root.document && !root.__k10ImgGuard) {
    root.__k10ImgGuard = true;
    root.document.addEventListener('error', (e) => {
      const el = e.target;
      if (el && el.classList && el.classList.contains('k10-av-img')) {
        const host = el.parentElement;
        if (host) {
          host.setAttribute('role', 'img');
          host.setAttribute('aria-label', el.getAttribute('alt') || '');
        }
        el.remove();
      }
    }, true);
  }

  root.KizukiKit = Object.freeze({
    __v: 1,
    tones: TONES.slice(),
    icons: Object.keys(ICONS),
    esc,
    hash,
    fmt,
    initials,
    icon,
    avatar,
    avatarStack,
    banner,
    coverArt,
    statTile,
    sectionHead,
    card,
    ring,
    bars,
    sparkline,
    meter,
    emptyState,
    unavailable,
    chip,
    personRow,
  });
})(typeof window !== 'undefined' ? window : globalThis);

