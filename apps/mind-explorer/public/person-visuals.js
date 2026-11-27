/* ==========================================================================
   KIZUKI MIND EXPLORER - PERSON VISUALS & INLINE MARKDOWN ENGINE
   Vercel Geist Dual-Polarity (Dark + Light via CSS custom properties)
   Pure SVG + safe HTML renderers with zero external dependencies.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiPersonVisuals = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const EM_DASH_RE = /\s*\u2014\s*/g;
  const CHANNEL_META = [
    { key: 'whatsapp', aliases: ['whatsapp', 'wa'], label: 'WA', full: 'WhatsApp', color: 'var(--pv-ch-wa, #46a758)' },
    { key: 'telegram', aliases: ['telegram', 'tg'], label: 'TG', full: 'Telegram', color: 'var(--pv-ch-tg, #22b8cf)' },
    { key: 'imessage', aliases: ['imessage', 'imsg', 'sms', 'messages'], label: 'iMsg', full: 'iMessage', color: 'var(--pv-ch-imsg, #3291ff)' },
    { key: 'gmail', aliases: ['gmail', 'email', 'mail'], label: 'Gmail', full: 'Gmail', color: 'var(--pv-ch-gmail, #888888)' },
    { key: 'calendar', aliases: ['calendar', 'cal', 'gcal'], label: 'Cal', full: 'Calendar', color: 'var(--pv-ch-cal, #a78bfa)' },
  ];

  const CHANNEL_BY_ALIAS = Object.create(null);
  for (let i = 0; i < CHANNEL_META.length; i += 1) {
    const ch = CHANNEL_META[i];
    for (let j = 0; j < ch.aliases.length; j += 1) {
      CHANNEL_BY_ALIAS[ch.aliases[j]] = ch;
    }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripEmDash(str) {
    return String(str == null ? '' : str).replace(EM_DASH_RE, ' - ');
  }

  function safeText(str) {
    return escapeHtml(stripEmDash(str));
  }

  function getKizukiIcons() {
    const g = typeof globalThis !== 'undefined'
      ? globalThis
      : (typeof window !== 'undefined' ? window : null);
    return g && g.KizukiIcons && typeof g.KizukiIcons === 'object' ? g.KizukiIcons : null;
  }

  const FALLBACK_CONTACT_PATHS = Object.freeze({
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.6"/><path d="M2.6 4.5 8 8.6l5.4-4.1"/>',
    telegram: '<path d="M13.85 2.75 2.15 7.45l4.2 1.55 1.55 4.25 1.9-2.85 2.85 1.85 1.2-9.5Z"/><path d="M6.35 9 13.5 3.1"/>',
    x_social: '<path d="M2.6 2.6h2.85l8 10.8H10.6L2.6 2.6Z"/><path d="M13.1 2.6 2.9 13.4"/>',
    github: '<path d="M6.25 12.15c-2.65.8-2.65-1.35-3.7-1.65M9.75 13.75v-2.1c.05-.65-.15-1.25-.6-1.65 1.95-.2 4-.95 4-4.35a3.4 3.4 0 0 0-.9-2.35 3.15 3.15 0 0 0-.1-2.3s-.75-.25-2.4.9a8.35 8.35 0 0 0-4.4 0c-1.65-1.15-2.4-.9-2.4-.9a3.15 3.15 0 0 0-.1 2.3 3.4 3.4 0 0 0-.9 2.35c0 3.4 2.05 4.15 4 4.35-.45.4-.65 1-.6 1.65v2.1"/>',
    linkedin: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2"/><path d="M5.25 7.1v4.15M5.25 4.95v.05M8 11.25V7.1M8 8.6c0-1 .75-1.65 1.65-1.65.9 0 1.45.6 1.45 1.7v2.6"/>',
    whatsapp: '<path d="M8 2.25a5.5 5.5 0 0 0-4.75 8.25L2.4 13.6l3.2-.85A5.5 5.5 0 1 0 8 2.25Z"/><path d="M6.1 5.9c.2-.15.45-.1.6.15l.55.9c.1.2.05.45-.1.6l-.35.35a3.7 3.7 0 0 0 1.3 1.3l.35-.35c.15-.15.4-.2.6-.1l.9.55c.25.15.3.4.15.6-.35.45-.95.75-1.55.65-1.75-.3-3.1-1.65-3.4-3.4-.1-.6.2-1.2.65-1.55Z"/>',
    imessage: '<path d="M8 2.6c-3.25 0-5.75 2.2-5.75 4.95 0 1.4.65 2.65 1.75 3.55L3.1 13.5l2.75-.95c.68.18 1.4.28 2.15.28 3.25 0 5.75-2.2 5.75-4.95S11.25 2.6 8 2.6Z"/>',
    phone: '<path d="M4.2 2.4h2.15l.95 2.75-1.35 1.1a7.4 7.4 0 0 0 3.8 3.8l1.1-1.35 2.75.95v2.15a1.4 1.4 0 0 1-1.5 1.4C6.55 12.85 3.15 9.45 2.8 3.9a1.4 1.4 0 0 1 1.4-1.5Z"/>',
    repo: '<path d="M4 2.4h8a1.25 1.25 0 0 1 1.25 1.25v9.95H4.9A1.65 1.65 0 0 1 3.25 11.95V3.65A1.25 1.25 0 0 1 4 2.4Z"/><path d="M3.25 11.2h10"/>',
    calendar: '<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.8"/><path d="M2.25 6.4h11.5M5.4 2.1v2.3M10.6 2.1v2.3"/>',
    globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.5 8h11M8 2.4c1.65 1.55 2.45 3.45 2.45 5.6S9.65 12.05 8 13.6C6.35 12.05 5.55 10.15 5.55 8S6.35 3.95 8 2.4Z"/>',
    archetype: '<path d="M8 2.15 13.25 5.15v5.7L8 13.85 2.75 10.85v-5.7L8 2.15Z"/><circle cx="8" cy="8" r="1.75"/>',
  });

  const FALLBACK_CONTACT_KIND_MAP = Object.freeze({
    email: 'mail',
    mail: 'mail',
    gmail: 'mail',
    telegram: 'telegram',
    tg: 'telegram',
    x: 'x_social',
    twitter: 'x_social',
    x_social: 'x_social',
    github: 'github',
    gh: 'github',
    linkedin: 'linkedin',
    li: 'linkedin',
    whatsapp: 'whatsapp',
    wa: 'whatsapp',
    imessage: 'imessage',
    imsg: 'imessage',
    sms: 'imessage',
    phone: 'phone',
    tel: 'phone',
    mobile: 'phone',
    repo: 'repo',
    git: 'repo',
    repository: 'repo',
    calendar: 'calendar',
    cal: 'calendar',
    web: 'globe',
    url: 'globe',
    website: 'globe',
    site: 'globe',
  });

  function sanitizeCssClassList(raw) {
    return String(raw == null ? '' : raw)
      .trim()
      .replace(/[^a-zA-Z0-9_\-\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderContactIcon(kind, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const icons = getKizukiIcons();
    if (icons && typeof icons.contactIconForKind === 'function') {
      return icons.contactIconForKind(kind, options);
    }
    const k = String(kind == null ? '' : kind).toLowerCase().trim();
    const iconKey = Object.prototype.hasOwnProperty.call(FALLBACK_CONTACT_KIND_MAP, k)
      ? FALLBACK_CONTACT_KIND_MAP[k]
      : 'globe';
    const size = clamp(options.size, 8, 96, 14);
    const extraCls = sanitizeCssClassList(options.className);
    const cls = extraCls ? 'k-icon k-icon-' + iconKey + ' ' + extraCls : 'k-icon k-icon-' + iconKey;
    return (
      '<svg class="' + escapeHtml(cls) + '" viewBox="0 0 16 16" width="' + fmtNum(size, 2) + '" height="' + fmtNum(size, 2) + '" ' +
        'fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" focusable="false">' +
        FALLBACK_CONTACT_PATHS[iconKey] +
      '</svg>'
    );
  }

  function renderArchetypeBadge(archetype, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const icons = getKizukiIcons();
    if (icons && typeof icons.archetypeBadge === 'function') {
      return icons.archetypeBadge(archetype, options);
    }
    const label = stripEmDash(String(archetype == null ? '' : archetype)).replace(/\s+/g, ' ').trim() || 'Ambient Signal';
    const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'signal';
    const size = clamp(options.size, 8, 96, 13);
    const extraCls = sanitizeCssClassList(options.className);
    const cls = extraCls ? 'k-archetype-chip is-' + slug + ' ' + extraCls : 'k-archetype-chip is-' + slug;
    return (
      '<span class="' + escapeHtml(cls) + '" data-archetype="' + escapeHtml(slug) + '">' +
        '<svg class="k-icon k-chip-icon" viewBox="0 0 16 16" width="' + fmtNum(size, 2) + '" height="' + fmtNum(size, 2) + '" ' +
          'fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" ' +
          'aria-hidden="true" focusable="false">' +
          FALLBACK_CONTACT_PATHS.archetype +
        '</svg>' +
        '<span class="k-chip-label">' + escapeHtml(label) + '</span>' +
      '</span>'
    );
  }

  function safeNum(val, fallback) {
    const n = Number(val);
    return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function clamp(val, min, max, fallback) {
    const n = safeNum(val, fallback);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function fmtNum(val, digits) {
    const n = safeNum(val, 0);
    const d = digits == null ? 1 : digits;
    return Number(n.toFixed(d)).toString();
  }

  function truncate(str, maxLen) {
    const s = stripEmDash(String(str == null ? '' : str)).trim();
    if (!maxLen || s.length <= maxLen) return s;
    if (maxLen <= 2) return s.slice(0, maxLen);
    const budget = maxLen - 1;
    const head = s.slice(0, budget);
    if (s.charAt(budget) && !/[\s\/\-]/.test(s.charAt(budget))) {
      const match = head.match(/^(.*?)[\s\/\-]+[^\s\/\-]*$/);
      if (match && match[1].length >= Math.floor(budget * 0.45)) {
        return match[1].replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
      }
    }
    return head.replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
  }

  function deriveInitials(name, fallback) {
    const clean = stripEmDash(String(name == null ? '' : name)).trim();
    if (!clean) return fallback || '?';
    const parts = clean.split(/[\s._\-/]+/).filter(Boolean);
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    if (!/^https?:\/\/[^\s<>"'`]+$/i.test(trimmed)) return false;
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    return true;
  }

  function trimBareUrl(raw) {
    let url = raw;
    let trail = '';
    while (url.length > 0) {
      const last = url[url.length - 1];
      if (last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?') {
        trail = last + trail;
        url = url.slice(0, -1);
      } else if (last === ')') {
        const opens = (url.match(/\(/g) || []).length;
        const closes = (url.match(/\)/g) || []).length;
        if (closes > opens) {
          trail = last + trail;
          url = url.slice(0, -1);
        } else {
          break;
        }
      } else if (last === ']') {
        const opens = (url.match(/\[/g) || []).length;
        const closes = (url.match(/\]/g) || []).length;
        if (closes > opens) {
          trail = last + trail;
          url = url.slice(0, -1);
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return { url: url, trail: trail };
  }

  function formatDisplayUrl(escapedUrl) {
    const cleaned = escapedUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (cleaned.length <= 44) return cleaned;
    return cleaned.slice(0, 41) + '\u2026';
  }

  function applyEmphasis(escaped) {
    let out = escaped;
    // Fix broken single-leading-asterisk artifacts such as "*Observed fact:**"
    out = out.replace(
      /(^|[\s(\[{>])\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?=$|[\s.,;:!?)\]}<])/g,
      '$1<strong>$2</strong>'
    );
    // Standard **bold**
    out = out.replace(
      /\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g,
      '<strong>$1</strong>'
    );
    // Standard *italic* (never mangles snake_case)
    out = out.replace(
      /(^|[\s(\[{>])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=$|[\s.,;:!?)\]}<])/g,
      '$1<em>$2</em>'
    );
    return out;
  }

  // =========================================================================
  // 1. SAFE INLINE MARKDOWN ENGINE
  // =========================================================================

  function renderInlineMd(text) {
    if (text == null) return '';
    // Strip NUL bytes so placeholder sentinels can never collide with input
    let src = String(text).replace(/\u0000/g, '');
    // Normalize em-dashes before escaping
    src = stripEmDash(src);
    // Escape raw HTML FIRST for strict XSS safety
    let out = escapeHtml(src);

    const tokens = [];
    function stash(html) {
      const idx = tokens.length;
      tokens.push(html);
      return '\u0000PVT' + idx + '\u0000';
    }

    // 1. Protect inline `code` spans first so markdown/URLs inside code stay literal
    out = out.replace(/`([^`\n]+)`/g, function (_m, code) {
      return stash('<code class="wm-inline-code">' + code + '</code>');
    });

    // 2. Markdown links [label](https://...) with strict https?:// validation
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, function (full, label, href) {
      // Unescape &amp; only for URL validation, keep escaped href in attribute
      const rawCheck = href.replace(/&amp;/g, '&');
      if (!isSafeHttpUrl(rawCheck)) return full;
      const safeLabel = applyEmphasis(label);
      return stash(
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer" class="wm-inline-link">' +
          safeLabel +
        '</a>'
      );
    });

    // 3. Bare https?:// URLs converted into clean clickable links
    out = out.replace(/(^|[\s(\[{>])(https?:\/\/[^\s<>"'`\u0000]+)/gi, function (full, prefix, candidate) {
      const parts = trimBareUrl(candidate);
      const rawCheck = parts.url.replace(/&amp;/g, '&');
      if (!isSafeHttpUrl(rawCheck)) return full;
      const anchor =
        '<a href="' + parts.url + '" target="_blank" rel="noopener noreferrer" class="wm-inline-link">' +
          formatDisplayUrl(parts.url) +
        '</a>';
      return prefix + stash(anchor) + parts.trail;
    });

    // 4. Bold, broken-bold repair, and italic transforms
    out = applyEmphasis(out);

    // 5. Restore protected code & link placeholders
    out = out.replace(/\u0000PVT(\d+)\u0000/g, function (_m, id) {
      const i = Number(id);
      return Number.isInteger(i) && i >= 0 && i < tokens.length ? tokens[i] : '';
    });

    return out;
  }

  // =========================================================================
  // 2. BEHAVIORAL TRAIT RADAR SVG (320 x 230)
  // =========================================================================

  function splitRadarLabel(rawLabel, maxLineChars) {
    const upper = stripEmDash(String(rawLabel == null ? '' : rawLabel)).trim().toUpperCase();
    if (!upper) return ['TRAIT'];
    if (upper.length <= maxLineChars) return [upper];
    const words = upper.split(/[\s/_-]+/).filter(Boolean);
    if (words.length >= 2) {
      let bestSplit = 1;
      let bestMax = Infinity;
      for (let k = 1; k < words.length; k += 1) {
        const l1 = words.slice(0, k).join(' ');
        const l2 = words.slice(k).join(' ');
        const m = Math.max(l1.length, l2.length);
        if (m < bestMax) {
          bestMax = m;
          bestSplit = k;
        }
      }
      return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')];
    }
    // Never hard-truncate single-word axis names (e.g. RECIPROCITY)
    return [upper];
  }

  function renderTraitRadarSvg(axes) {
    const list = Array.isArray(axes) ? axes.filter(Boolean).slice(0, 8) : [];
    if (list.length < 3) {
      return (
        '<div class="pv-radar-wrap pv-empty">' +
          '<span class="pv-empty-label">No behavioral trait axes available.</span>' +
        '</div>'
      );
    }

    const cx = 160;
    const cy = 115;
    const radius = 68;
    const n = list.length;
    const ringScales = [0.33, 0.66, 1.0];

    function polarPoint(index, r) {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
      return {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
      };
    }

    // Concentric regular polygon rings (33%, 66%, 100%)
    const ringsSvg = ringScales.map(function (scale, idx) {
      const pts = [];
      for (let i = 0; i < n; i += 1) {
        const p = polarPoint(i, radius * scale);
        pts.push(fmtNum(p.x) + ',' + fmtNum(p.y));
      }
      const stroke = idx === ringScales.length - 1
        ? 'var(--border-strong, rgba(255, 255, 255, 0.16))'
        : 'var(--border-hairline, rgba(255, 255, 255, 0.09))';
      return (
        '<polygon class="pv-radar-ring" points="' + pts.join(' ') + '" ' +
          'fill="none" stroke="' + stroke + '" stroke-width="1" />'
      );
    }).join('');

    // Radial spokes
    const spokesSvg = list.map(function (_axis, i) {
      const outer = polarPoint(i, radius);
      return (
        '<line class="pv-radar-spoke" x1="' + cx + '" y1="' + cy + '" ' +
          'x2="' + fmtNum(outer.x) + '" y2="' + fmtNum(outer.y) + '" ' +
          'stroke="var(--border-hairline, rgba(255, 255, 255, 0.09))" stroke-width="1" />'
      );
    }).join('');

    // Data polygon + vertex dots + perimeter labels
    const dataPts = [];
    const dotsSvg = [];
    const labelsSvg = [];

    for (let i = 0; i < n; i += 1) {
      const axis = list[i] || {};
      const label = stripEmDash(axis.label || axis.key || ('Axis ' + (i + 1))).trim();
      const score = Math.round(clamp(axis.score, 0, 100, 0));
      const evidence = stripEmDash(axis.evidence || axis.basis || axis.note || '').trim();
      const tooltipText = label.toUpperCase() + ': ' + score + '/100' + (evidence ? ' - ' + evidence : '');
      const escapedTip = escapeHtml(tooltipText);

      const dp = polarPoint(i, (score / 100) * radius);
      dataPts.push(fmtNum(dp.x) + ',' + fmtNum(dp.y));

      dotsSvg.push(
        '<g class="pv-radar-vertex">' +
          '<circle class="pv-radar-hit" cx="' + fmtNum(dp.x) + '" cy="' + fmtNum(dp.y) + '" r="10" ' +
            'fill="transparent" stroke="none" tabindex="0" style="cursor:pointer;" ' +
            'data-viz-tip="' + escapedTip + '">' +
            '<title>' + escapedTip + '</title>' +
          '</circle>' +
          '<circle class="pv-radar-dot" cx="' + fmtNum(dp.x) + '" cy="' + fmtNum(dp.y) + '" r="3.2" ' +
            'fill="var(--pv-radar-stroke, var(--accent-blue, #3291ff))" ' +
            'stroke="var(--surface-raised, #0a0a0a)" stroke-width="1.25" ' +
            'style="pointer-events:none;">' +
            '<title>' + escapedTip + '</title>' +
          '</circle>' +
        '</g>'
      );

      // Position perimeter labels with generous 93px side margins inside 320x230
      const outer = polarPoint(i, radius);
      const isTop = outer.sin < -0.85;
      const isBottom = outer.sin > 0.85;
      const isRight = !isTop && !isBottom && outer.cos >= 0;

      let anchor = 'middle';
      let lx = cx;
      let ly = 17;
      let scoreY = 30;
      let lines = [label.toUpperCase()];

      if (isTop) {
        anchor = 'middle';
        lx = cx;
        ly = 17;
        scoreY = 30;
        lines = [label.toUpperCase()];
      } else if (isBottom) {
        anchor = 'middle';
        lx = cx;
        ly = 205;
        scoreY = 219;
        lines = [label.toUpperCase()];
      } else if (isRight) {
        anchor = 'start';
        lx = Math.min(230, Math.max(outer.x + 8, 224));
        lines = splitRadarLabel(label, 14);
        const baseY = outer.y;
        ly = lines.length > 1 ? baseY - 6 : baseY - 2;
        scoreY = lines.length > 1 ? baseY + 16 : baseY + 11;
      } else {
        anchor = 'end';
        lx = Math.max(90, Math.min(outer.x - 8, 96));
        lines = splitRadarLabel(label, 14);
        const baseY = outer.y;
        ly = lines.length > 1 ? baseY - 6 : baseY - 2;
        scoreY = lines.length > 1 ? baseY + 16 : baseY + 11;
      }

      const labelTspans = lines.map(function (line, lineIdx) {
        return (
          '<tspan x="' + fmtNum(lx) + '" dy="' + (lineIdx === 0 ? '0' : '11') + '">' +
            escapeHtml(line) +
          '</tspan>'
        );
      }).join('');

      labelsSvg.push(
        '<g class="pv-radar-axis-label" data-viz-tip="' + escapedTip + '" style="cursor:default;">' +
          '<title>' + escapedTip + '</title>' +
          '<text x="' + fmtNum(lx) + '" y="' + fmtNum(ly) + '" text-anchor="' + anchor + '" ' +
            'font-family="var(--font-mono, monospace)" font-size="9.5" font-weight="500" ' +
            'letter-spacing="0.02em" fill="var(--ink-secondary, #a1a1aa)">' +
            labelTspans +
          '</text>' +
          '<text x="' + fmtNum(lx) + '" y="' + fmtNum(scoreY) + '" text-anchor="' + anchor + '" ' +
            'font-family="var(--font-mono, monospace)" font-size="10" font-weight="600" ' +
            'font-variant-numeric="tabular-nums" fill="var(--ink-primary, #e4e4e7)">' +
            score +
          '</text>' +
        '</g>'
      );
    }

    return (
      '<svg class="pv-radar-svg" viewBox="0 0 320 230" width="100%" ' +
        'role="img" aria-label="Behavioral operating traits radar" ' +
        'style="display:block;max-width:320px;height:auto;overflow:visible;">' +
        '<g class="pv-radar-grid">' +
          ringsSvg +
          spokesSvg +
          '<circle cx="' + cx + '" cy="' + cy + '" r="1.5" fill="var(--border-strong, rgba(255, 255, 255, 0.16))" />' +
        '</g>' +
        '<polygon class="pv-radar-poly pv-radar-data" points="' + dataPts.join(' ') + '" ' +
          'fill="var(--pv-radar-fill, var(--tint-blue-bg, rgba(50, 145, 255, 0.14)))" ' +
          'stroke="var(--pv-radar-stroke, var(--accent-blue, #3291ff))" ' +
          'stroke-width="1.75" stroke-linejoin="round" />' +
        '<g class="pv-radar-dots">' + dotsSvg.join('') + '</g>' +
        '<g class="pv-radar-labels">' + labelsSvg.join('') + '</g>' +
      '</svg>'
    );
  }

  // =========================================================================
  // 3. ASYMMETRIC LEVERAGE & TRUST TELEMETRY
  // =========================================================================

  function renderLeverageBalanceSvg(balance) {
    const b = balance && typeof balance === 'object' ? balance : {};
    const ourCount = Math.max(0, Math.round(safeNum(b.our_count, 0)));
    const theirCount = Math.max(0, Math.round(safeNum(b.their_count, 0)));
    const totalLevers = ourCount + theirCount;

    let ourPct = 0;
    let theirPct = 0;
    if (b.our_pct != null && b.their_pct != null && (safeNum(b.our_pct, 0) > 0 || safeNum(b.their_pct, 0) > 0)) {
      const rawOur = clamp(b.our_pct, 0, 100, 0);
      const rawTheir = clamp(b.their_pct, 0, 100, 0);
      const sum = rawOur + rawTheir;
      if (sum > 0) {
        ourPct = Math.round((rawOur / sum) * 100);
        theirPct = 100 - ourPct;
      }
    } else if (totalLevers > 0) {
      ourPct = Math.round((ourCount / totalLevers) * 100);
      theirPct = 100 - ourPct;
    }

    const barW = 320;
    const barH = 12;
    const ourW = (ourPct / 100) * barW;
    const theirW = (theirPct / 100) * barW;
    const theirX = barW - theirW;

    const trustScore = Math.round(clamp(b.trust_score, 0, 100, 0));
    const trustW = (trustScore / 100) * 108;
    const trustColor = trustScore >= 70
      ? 'var(--accent-green, #46a758)'
      : (trustScore >= 45 ? 'var(--accent-blue, #3291ff)' : 'var(--accent-amber, #f5a623)');

    const sentPos = Math.max(0, Math.round(safeNum(b.sentiment_pos, 0)));
    const sentNeu = Math.max(0, Math.round(safeNum(b.sentiment_neu, 0)));
    const sentNeg = Math.max(0, Math.round(safeNum(b.sentiment_neg, 0)));
    const sentTotal = sentPos + sentNeu + sentNeg;

    const leverWord = ourCount === 1 ? 'lever' : 'levers';
    const watchWord = theirCount === 1 ? 'watch-out' : 'watch-outs';
    const ourTip = 'Our Edge: ' + ourCount + ' ' + leverWord + ' (' + ourPct + '%)';
    const theirTip = 'Their Edge: ' + theirCount + ' ' + watchWord + ' (' + theirPct + '%)';
    const splitTitle = ourTip + ' vs ' + theirTip;

    let sentimentHtml = '';
    if (sentTotal > 0) {
      const sBarW = 120;
      const posW = (sentPos / sentTotal) * sBarW;
      const neuW = (sentNeu / sentTotal) * sBarW;
      const negW = Math.max(0, sBarW - posW - neuW);
      const sentTitle = 'Sentiment signals: ' + sentPos + ' positive, ' + sentNeu + ' neutral, ' + sentNeg + ' negative';

      sentimentHtml =
        '<div class="pv-telemetry-metric pv-sentiment-metric" title="' + escapeHtml(sentTitle) + '" data-viz-tip="' + escapeHtml(sentTitle) + '">' +
          '<div class="pv-telemetry-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:var(--font-mono,monospace);font-size:11px;font-variant-numeric:tabular-nums;">' +
            '<span class="pv-telemetry-k" style="color:var(--ink-muted,#737373);text-transform:uppercase;letter-spacing:0.04em;font-size:10px;">Sentiment</span>' +
            '<span class="pv-sentiment-counts" style="display:inline-flex;align-items:center;gap:6px;">' +
              '<span class="pv-sent-pos" style="color:var(--accent-green,#46a758);">\u25b2 ' + sentPos + '</span>' +
              '<span class="pv-sent-neu" style="color:var(--ink-muted,#737373);">\u2022 ' + sentNeu + '</span>' +
              '<span class="pv-sent-neg" style="color:var(--wm-rose,#f43f5e);">\u25bc ' + sentNeg + '</span>' +
            '</span>' +
          '</div>' +
          '<svg class="pv-sentiment-svg" viewBox="0 0 ' + sBarW + ' 6" width="100%" height="6" role="img" aria-label="' + escapeHtml(sentTitle) + '" style="display:block;margin-top:5px;">' +
            '<title>' + escapeHtml(sentTitle) + '</title>' +
            '<rect x="0" y="0" width="' + sBarW + '" height="6" rx="3" fill="var(--surface-inset, rgba(128,128,128,0.14))" />' +
            (posW > 0 ? '<rect x="0" y="0" width="' + fmtNum(posW) + '" height="6" rx="2" fill="var(--accent-green, #46a758)" />' : '') +
            (neuW > 0 ? '<rect x="' + fmtNum(posW) + '" y="0" width="' + fmtNum(neuW) + '" height="6" fill="var(--ink-faint, #666666)" />' : '') +
            (negW > 0 ? '<rect x="' + fmtNum(posW + neuW) + '" y="0" width="' + fmtNum(negW) + '" height="6" rx="2" fill="var(--wm-rose, #f43f5e)" />' : '') +
          '</svg>' +
        '</div>';
    }

    const trustTitle = 'Trust Index: ' + trustScore + '/100';

    return (
      '<div class="pv-leverage-card">' +
        '<div class="pv-balance-block">' +
          '<div class="pv-balance-head" style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;font-family:var(--font-mono,monospace);font-size:11px;font-variant-numeric:tabular-nums;">' +
            '<span class="pv-edge-ours" style="color:var(--pv-edge-ours,var(--accent-green,#46a758));font-weight:500;">' +
              'Our Edge <strong style="font-weight:600;">' + ourCount + '</strong> ' + leverWord +
            '</span>' +
            '<span class="pv-edge-theirs" style="color:var(--pv-edge-theirs,var(--accent-amber,#f5a623));font-weight:500;">' +
              'Their Edge <strong style="font-weight:600;">' + theirCount + '</strong> ' + watchWord +
            '</span>' +
          '</div>' +
          '<svg class="pv-balance-svg" viewBox="0 0 ' + barW + ' ' + barH + '" width="100%" height="12" role="img" aria-label="' + escapeHtml(splitTitle) + '" style="display:block;">' +
            '<title>' + escapeHtml(splitTitle) + '</title>' +
            '<rect x="0" y="2" width="' + barW + '" height="8" rx="3" fill="var(--surface-inset, rgba(128,128,128,0.14))" stroke="var(--border-hairline, rgba(255,255,255,0.09))" stroke-width="0.75" />' +
            (ourW > 0
              ? '<rect class="pv-leverage-seg pv-bar-ours" x="0" y="2" width="' + fmtNum(ourW) + '" height="8" rx="3" ' +
                  'fill="var(--pv-edge-ours, var(--accent-green, #46a758))" ' +
                  'data-viz-tip="' + escapeHtml(ourTip) + '" style="cursor:default;">' +
                  '<title>' + escapeHtml(ourTip) + '</title>' +
                '</rect>'
              : '') +
            (theirW > 0
              ? '<rect class="pv-leverage-seg pv-bar-theirs" x="' + fmtNum(theirX) + '" y="2" width="' + fmtNum(theirW) + '" height="8" rx="3" ' +
                  'fill="var(--pv-edge-theirs, var(--accent-amber, #f5a623))" ' +
                  'data-viz-tip="' + escapeHtml(theirTip) + '" style="cursor:default;">' +
                  '<title>' + escapeHtml(theirTip) + '</title>' +
                '</rect>'
              : '') +
            '<line class="pv-balance-midtick" x1="' + (barW / 2) + '" y1="0" x2="' + (barW / 2) + '" y2="' + barH + '" stroke="var(--ink-primary, #ededed)" stroke-opacity="0.5" stroke-width="1" />' +
          '</svg>' +
          '<div class="pv-balance-ratio" style="display:flex;justify-content:space-between;margin-top:4px;font-family:var(--font-mono,monospace);font-size:10px;font-variant-numeric:tabular-nums;color:var(--ink-muted,#737373);">' +
            '<span>' + ourPct + '%</span>' +
            '<span>' + (totalLevers === 0 ? 'Unscored' : '50/50 midline') + '</span>' +
            '<span>' + theirPct + '%</span>' +
          '</div>' +
        '</div>' +
        '<div class="pv-telemetry-row" style="display:grid;grid-template-columns:' + (sentTotal > 0 ? '1fr 1fr' : '1fr') + ';gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-hairline,rgba(255,255,255,0.09));">' +
          '<div class="pv-telemetry-metric pv-trust-metric" title="' + escapeHtml(trustTitle) + '" data-viz-tip="' + escapeHtml(trustTitle) + '">' +
            '<div class="pv-telemetry-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:var(--font-mono,monospace);font-size:11px;font-variant-numeric:tabular-nums;">' +
              '<span class="pv-telemetry-k" style="color:var(--ink-muted,#737373);text-transform:uppercase;letter-spacing:0.04em;font-size:10px;">Trust Index</span>' +
              '<span class="pv-trust-val" style="color:var(--ink-primary,#ededed);font-weight:500;">' + trustScore + '/100</span>' +
            '</div>' +
            '<svg class="pv-trust-svg" viewBox="0 0 108 6" width="100%" height="6" role="img" aria-label="' + escapeHtml(trustTitle) + '" style="display:block;margin-top:5px;">' +
              '<title>' + escapeHtml(trustTitle) + '</title>' +
              '<rect x="0" y="0" width="108" height="6" rx="3" fill="var(--surface-inset, rgba(128,128,128,0.14))" />' +
              (trustW > 0 ? '<rect x="0" y="0" width="' + fmtNum(trustW) + '" height="6" rx="3" fill="' + trustColor + '" />' : '') +
              '<line x1="27" y1="0" x2="27" y2="6" stroke="var(--surface-raised, #0a0a0a)" stroke-opacity="0.45" stroke-width="0.75" />' +
              '<line x1="54" y1="0" x2="54" y2="6" stroke="var(--surface-raised, #0a0a0a)" stroke-opacity="0.45" stroke-width="0.75" />' +
              '<line x1="81" y1="0" x2="81" y2="6" stroke="var(--surface-raised, #0a0a0a)" stroke-opacity="0.45" stroke-width="0.75" />' +
            '</svg>' +
          '</div>' +
          sentimentHtml +
        '</div>' +
      '</div>'
    );
  }

  // =========================================================================
  // 4. CADENCE SPARKLINE, CHANNEL MIX & RECIPROCITY (360 x 94)
  // =========================================================================

  function lookupChannelMeta(channelName, fallbackLabel) {
    const key = String(channelName == null ? '' : channelName).trim().toLowerCase();
    if (CHANNEL_BY_ALIAS[key]) return CHANNEL_BY_ALIAS[key];
    return {
      key: key || 'other',
      label: truncate(fallbackLabel || channelName || 'Other', 8),
      full: stripEmDash(fallbackLabel || channelName || 'Other'),
      color: 'var(--ink-faint, #666666)',
    };
  }

  function formatRibbonWeekLabel(weekStart) {
    const raw = String(weekStart == null ? '' : weekStart).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return truncate(raw || 'Week', 10);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const parts = raw.split('-');
    const mIdx = Math.max(0, Math.min(11, Number(parts[1]) - 1));
    const day = Number(parts[2]);
    return months[mIdx] + ' ' + day;
  }

  let ledgerSvgSeq = 0;

  function buildSmoothSplinePath(pts) {
    if (!Array.isArray(pts) || pts.length === 0) return '';
    if (pts.length === 1) {
      return 'M ' + fmtNum(pts[0].x) + ' ' + fmtNum(pts[0].y);
    }
    let d = 'M ' + fmtNum(pts[0].x) + ' ' + fmtNum(pts[0].y);
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const midX = (p0.x + p1.x) * 0.5;
      d += ' C ' + fmtNum(midX) + ' ' + fmtNum(p0.y) + ', ' + fmtNum(midX) + ' ' + fmtNum(p1.y) + ', ' + fmtNum(p1.x) + ' ' + fmtNum(p1.y);
    }
    return d;
  }

  function renderRelationshipLedgerRibbon(ledger, channelBreakdown, reciprocity) {
    const led = ledger && typeof ledger === 'object' ? ledger : null;
    const rawWeeks = led && Array.isArray(led.weeks) ? led.weeks : [];
    const weeks = [];
    for (let i = 0; i < 52; i += 1) {
      const src = rawWeeks[i] && typeof rawWeeks[i] === 'object' ? rawWeeks[i] : {};
      weeks.push({
        weekStart: stripEmDash(src.weekStart || src.week_start || ('W' + (i + 1))).trim(),
        inCount: Math.max(0, Math.round(safeNum(src.in, 0))),
        outCount: Math.max(0, Math.round(safeNum(src.out, 0))),
        meetings: Math.max(0, Math.round(safeNum(src.meetings, 0))),
        channels: Array.isArray(src.channels) ? src.channels.filter(Boolean).map(String) : [],
      });
    }

    const driftZ = safeNum(led && led.drift_z, 0);
    const medianGap = safeNum(led && led.median_gap_days, 0);
    const currentGap = safeNum(led && led.current_gap_days, 0);
    const streakWeeks = Math.max(0, Math.round(safeNum(led && led.streak_weeks, 0)));
    const owed = Boolean(led && led.last_inbound_unanswered);
    const openLoops = led && Array.isArray(led.open_loops) ? led.open_loops : [];
    const firstAsk = openLoops.find(function (l) { return l && l.kind === 'inbound_ask'; });
    const nextTouch = stripEmDash((led && led.next_touch) || 'No immediate touch scheduled.').trim();
    const summarySentence = stripEmDash((led && led.summary_sentence) || '').trim();

    const isDrifting = driftZ > 2;
    const owedLabel = owed
      ? (firstAsk && Number.isFinite(Number(firstAsk.ageHours))
        ? 'Reply owed (' + (firstAsk.ageHours < 48 ? Math.round(firstAsk.ageHours) + 'h' : Math.round(firstAsk.ageHours / 24) + 'd') + ')'
        : 'Reply owed')
      : 'Caught up';
    const driftLabel = (driftZ > 0 ? '+' : '') + fmtNum(driftZ, 1) + 'z';
    const driftTip = medianGap > 0
      ? 'Current gap ' + fmtNum(currentGap, 1) + 'd vs ' + fmtNum(medianGap, 1) + 'd median cadence (z ' + fmtNum(driftZ, 2) + ')'
      : 'Cadence baseline still forming';
    const streakLabel = streakWeeks + 'w';

    // Explicit Ledger Header Row: Owed / Drift (z) / Streak / Next Touch
    const headerRowHtml =
      '<div class="pv-ledger-header" role="region" aria-label="Relationship cadence summary">' +
        '<div class="pv-ledger-kpis">' +
          '<span class="pv-ledger-kpi is-owed' + (owed ? ' is-alert' : ' is-calm') + '" data-ledger-kpi="owed">' +
            '<span class="pv-ledger-kpi-k">Owed</span>' +
            '<strong class="pv-ledger-kpi-v">' + escapeHtml(owedLabel) + '</strong>' +
          '</span>' +
          '<span class="pv-ledger-kpi is-drift' + (isDrifting ? ' is-alert' : '') + '" data-ledger-kpi="drift" title="' + escapeHtml(driftTip) + '" data-viz-tip="' + escapeHtml(driftTip) + '">' +
            '<span class="pv-ledger-kpi-k">Drift (z)</span>' +
            '<strong class="pv-ledger-kpi-v tabular">' + escapeHtml(driftLabel) + '</strong>' +
          '</span>' +
          '<span class="pv-ledger-kpi is-streak" data-ledger-kpi="streak">' +
            '<span class="pv-ledger-kpi-k">Streak</span>' +
            '<strong class="pv-ledger-kpi-v tabular">' + escapeHtml(streakLabel) + '</strong>' +
          '</span>' +
        '</div>' +
        '<div class="pv-ledger-next-touch" data-ledger-kpi="next-touch">' +
          '<span class="pv-ledger-kpi-k">Next Touch</span>' +
          '<span class="pv-ledger-next-text">' + escapeHtml(nextTouch) + '</span>' +
        '</div>' +
      '</div>';

    // Full-width 52-week dual-sided horological SVG ribbon (640 x 134)
    ledgerSvgSeq += 1;
    const uid = 'pv-led-' + ledgerSvgSeq;
    const svgW = 640;
    const svgH = 134;
    const plotLeft = 36;
    const plotRight = 630;
    const axisY = 60;
    const maxUpH = 44;
    const maxDownH = 44;
    const plotW = plotRight - plotLeft;
    const slotW = plotW / 52;
    const barW = Math.max(4, Math.min(8.2, slotW * 0.66));

    let maxSide = 1;
    let peakOutVal = 0;
    let peakOutIdx = -1;
    let peakInVal = 0;
    let peakInIdx = -1;
    let lastActiveIdx = -1;
    for (let i = 0; i < 52; i += 1) {
      const w = weeks[i];
      if (w.outCount > maxSide) maxSide = w.outCount;
      if (w.inCount > maxSide) maxSide = w.inCount;
      if (w.outCount > peakOutVal) {
        peakOutVal = w.outCount;
        peakOutIdx = i;
      }
      if (w.inCount > peakInVal) {
        peakInVal = w.inCount;
        peakInIdx = i;
      }
      if (w.outCount + w.inCount + w.meetings > 0) {
        lastActiveIdx = i;
      }
    }

    // Build luminous spline envelope curves linking active outbound and inbound weeks
    const outSplinePts = [];
    const inSplinePts = [];
    for (let i = 0; i < 52; i += 1) {
      const w = weeks[i];
      const cx = plotLeft + (i + 0.5) * slotW;
      const outY = w.outCount > 0 ? axisY - Math.max(3, (w.outCount / maxSide) * maxUpH) - 1 : axisY - 0.5;
      const inY = w.inCount > 0 ? axisY + Math.max(3, (w.inCount / maxSide) * maxDownH) + 1 : axisY + 0.5;
      outSplinePts.push({ x: cx, y: outY, active: w.outCount > 0 });
      inSplinePts.push({ x: cx, y: inY, active: w.inCount > 0 });
    }

    let envelopeSvg = '';
    if (peakOutVal > 0) {
      const outLineD = buildSmoothSplinePath(outSplinePts);
      const outAreaD = outLineD + ' L ' + fmtNum(outSplinePts[51].x) + ' ' + fmtNum(axisY) + ' L ' + fmtNum(outSplinePts[0].x) + ' ' + fmtNum(axisY) + ' Z';
      envelopeSvg +=
        '<path class="pv-ledger-envelope is-out" d="' + outAreaD + '" fill="url(#' + uid + '-env-out)" />' +
        '<path class="pv-ledger-envelope is-out-line" d="' + outLineD + '" fill="none" stroke="var(--pv-ledger-out, #38bdf8)" stroke-opacity="0.34" stroke-width="1" />';
    }
    if (peakInVal > 0) {
      const inLineD = buildSmoothSplinePath(inSplinePts);
      const inAreaD = inLineD + ' L ' + fmtNum(inSplinePts[51].x) + ' ' + fmtNum(axisY) + ' L ' + fmtNum(inSplinePts[0].x) + ' ' + fmtNum(axisY) + ' Z';
      envelopeSvg +=
        '<path class="pv-ledger-envelope is-in" d="' + inAreaD + '" fill="url(#' + uid + '-env-in)" />' +
        '<path class="pv-ledger-envelope is-in-line" d="' + inLineD + '" fill="none" stroke="var(--pv-ledger-in, #f59e0b)" stroke-opacity="0.32" stroke-width="1" />';
    }

    // Subtle vermilion gap-anomaly shading across trailing silent weeks when drift_z > 2
    let driftShadeSvg = '';
    if (isDrifting) {
      const shadeStartIdx = lastActiveIdx >= 0 ? Math.min(51, lastActiveIdx + 1) : 44;
      const shadeX = plotLeft + shadeStartIdx * slotW;
      const shadeW = Math.max(slotW, plotRight - shadeX);
      const shadeTip = 'Cadence drift anomaly: ' + fmtNum(currentGap, 1) + 'd silent vs ' + fmtNum(medianGap, 1) + 'd median (z ' + fmtNum(driftZ, 1) + ')';
      driftShadeSvg =
        '<rect class="pv-ledger-drift-zone" x="' + fmtNum(shadeX) + '" y="' + (axisY - maxUpH - 4) + '" ' +
          'width="' + fmtNum(shadeW) + '" height="' + (maxUpH + maxDownH + 8) + '" rx="3" ' +
          'fill="var(--pv-ledger-drift-bg, rgba(239, 68, 68, 0.13))" ' +
          'stroke="var(--pv-ledger-drift-border, rgba(239, 68, 68, 0.34))" stroke-width="0.8" stroke-dasharray="3 2" ' +
          'data-viz-tip="' + escapeHtml(shadeTip) + '">' +
          '<title>' + escapeHtml(shadeTip) + '</title>' +
        '</rect>';
    }

    // Quarterly vertical calibration gridlines & horological baseline ticks
    const quarterIndices = [0, 13, 26, 39, 51];
    const quarterGridSvg = quarterIndices.map(function (qi) {
      const qx = qi === 0 ? plotLeft : (qi === 51 ? plotRight : plotLeft + (qi + 0.5) * slotW);
      return (
        '<line class="pv-ledger-qgrid" x1="' + fmtNum(qx) + '" y1="' + (axisY - maxUpH - 4) + '" ' +
          'x2="' + fmtNum(qx) + '" y2="' + (axisY + maxDownH + 4) + '" ' +
          'stroke="var(--border-subtle, rgba(255,255,255,0.08))" stroke-width="0.85" ' +
          (qi === 0 || qi === 51 ? '' : 'stroke-dasharray="2 3" ') + '/>' +
        '<line x1="' + fmtNum(qx) + '" y1="' + (axisY - 3.5) + '" x2="' + fmtNum(qx) + '" y2="' + (axisY + 3.5) + '" ' +
          'stroke="var(--border-strong, rgba(255,255,255,0.28))" stroke-width="1" />'
      );
    }).join('');

    const weekMarksSvg = weeks.map(function (w, idx) {
      const slotX = plotLeft + idx * slotW;
      const cx = slotX + slotW / 2;
      const bx = cx - barW / 2;
      const weekLabel = formatRibbonWeekLabel(w.weekStart);
      const chText = w.channels.length > 0 ? ' [' + w.channels.join(', ') + ']' : '';
      const tip =
        weekLabel + ' (' + w.weekStart + '): ' +
        w.outCount + ' out, ' + w.inCount + ' in' +
        (w.meetings > 0 ? ', ' + w.meetings + ' mtg' + (w.meetings === 1 ? '' : 's') : '') +
        chText;
      const escapedTip = escapeHtml(tip);

      let marks = '';
      if (w.outCount > 0) {
        const outH = Math.max(3, (w.outCount / maxSide) * maxUpH);
        const topY = axisY - outH - 1;
        const isPeakOut = idx === peakOutIdx && peakOutVal > 0;
        marks +=
          '<rect class="pv-ledger-bar-out" x="' + fmtNum(bx) + '" y="' + fmtNum(topY) + '" ' +
            'width="' + fmtNum(barW) + '" height="' + fmtNum(outH) + '" rx="1.6" ' +
            'fill="url(#' + uid + '-bar-out)" />' +
          '<rect class="pv-ledger-cap-out" x="' + fmtNum(bx + 0.4) + '" y="' + fmtNum(topY) + '" ' +
            'width="' + fmtNum(Math.max(2, barW - 0.8)) + '" height="1.8" rx="0.9" ' +
            'fill="' + (isPeakOut ? '#e0f2fe' : '#bae6fd') + '" fill-opacity="' + (isPeakOut ? '0.96' : '0.78') + '" />';
        if (isPeakOut) {
          marks +=
            '<circle class="pv-ledger-cap-glow" cx="' + fmtNum(cx) + '" cy="' + fmtNum(topY) + '" r="4.6" fill="rgba(56, 189, 248, 0.22)" />' +
            '<circle class="pv-ledger-cap-glow" cx="' + fmtNum(cx) + '" cy="' + fmtNum(topY) + '" r="2.0" fill="#e0f2fe" />';
        }
      }
      if (w.inCount > 0) {
        const inH = Math.max(3, (w.inCount / maxSide) * maxDownH);
        const botY = axisY + 1 + inH;
        const isPeakIn = idx === peakInIdx && peakInVal > 0;
        marks +=
          '<rect class="pv-ledger-bar-in" x="' + fmtNum(bx) + '" y="' + fmtNum(axisY + 1) + '" ' +
            'width="' + fmtNum(barW) + '" height="' + fmtNum(inH) + '" rx="1.6" ' +
            'fill="url(#' + uid + '-bar-in)" />' +
          '<rect class="pv-ledger-cap-in" x="' + fmtNum(bx + 0.4) + '" y="' + fmtNum(botY - 1.8) + '" ' +
            'width="' + fmtNum(Math.max(2, barW - 0.8)) + '" height="1.8" rx="0.9" ' +
            'fill="' + (isPeakIn ? '#fef3c7' : '#fde68a') + '" fill-opacity="' + (isPeakIn ? '0.96' : '0.78') + '" />';
        if (isPeakIn) {
          marks +=
            '<circle class="pv-ledger-cap-glow" cx="' + fmtNum(cx) + '" cy="' + fmtNum(botY) + '" r="4.6" fill="rgba(245, 158, 11, 0.22)" />' +
            '<circle class="pv-ledger-cap-glow" cx="' + fmtNum(cx) + '" cy="' + fmtNum(botY) + '" r="2.0" fill="#fef3c7" />';
        }
      }
      if (w.outCount === 0 && w.inCount === 0 && w.meetings === 0) {
        marks +=
          '<rect class="pv-ledger-bar-zero" x="' + fmtNum(cx - 1.1) + '" y="' + fmtNum(axisY - 0.9) + '" ' +
            'width="2.2" height="1.8" rx="0.9" fill="var(--border-strong, rgba(255,255,255,0.18))" />';
      }
      if (w.meetings > 0) {
        const mtgSize = w.meetings > 1 ? 4.0 : 3.2;
        const pts =
          fmtNum(cx) + ',' + fmtNum(axisY - mtgSize) + ' ' +
          fmtNum(cx + mtgSize) + ',' + fmtNum(axisY) + ' ' +
          fmtNum(cx) + ',' + fmtNum(axisY + mtgSize) + ' ' +
          fmtNum(cx - mtgSize) + ',' + fmtNum(axisY);
        marks +=
          '<polygon class="pv-ledger-mtg-tick" points="' + pts + '" ' +
            'fill="var(--pv-ledger-mtg, #10b981)" stroke="var(--surface-raised, #0a0a0a)" stroke-width="0.9" />';
      }

      return (
        '<g class="pv-ledger-week" data-week-index="' + idx + '" data-week-start="' + escapeHtml(w.weekStart) + '" ' +
          'data-viz-tip="' + escapedTip + '" tabindex="0" style="cursor:default;">' +
          '<title>' + escapedTip + '</title>' +
          '<rect class="pv-ledger-hit" x="' + fmtNum(slotX) + '" y="10" width="' + fmtNum(slotW) + '" height="100" fill="transparent" />' +
          marks +
        '</g>'
      );
    }).join('');

    // Quarter markers across the 52 weeks
    const tickDefs = [
      { idx: 0, anchor: 'start', label: formatRibbonWeekLabel(weeks[0].weekStart) },
      { idx: 13, anchor: 'middle', label: formatRibbonWeekLabel(weeks[13].weekStart) },
      { idx: 26, anchor: 'middle', label: formatRibbonWeekLabel(weeks[26].weekStart) },
      { idx: 39, anchor: 'middle', label: formatRibbonWeekLabel(weeks[39].weekStart) },
      { idx: 51, anchor: 'end', label: 'Now' },
    ];
    const xTicksSvg = tickDefs.map(function (t) {
      const tx = t.anchor === 'start'
        ? plotLeft
        : (t.anchor === 'end' ? plotRight : plotLeft + (t.idx + 0.5) * slotW);
      return (
        '<text x="' + fmtNum(tx) + '" y="126" text-anchor="' + t.anchor + '" ' +
          'font-family="var(--font-mono, monospace)" font-size="10" fill="var(--ink-muted, #888888)">' +
          escapeHtml(t.label) +
        '</text>'
      );
    }).join('');

    const ribbonSvg =
      '<div class="pv-ledger-well-frame">' +
        '<svg class="pv-ledger-svg" viewBox="0 0 ' + svgW + ' ' + svgH + '" width="100%" ' +
          'data-weeks="52" role="img" aria-label="52-week dual-sided relationship cadence ribbon" ' +
          'style="display:block;height:auto;">' +
          '<defs>' +
            '<linearGradient id="' + uid + '-bar-out" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="#7dd3fc" />' +
              '<stop offset="100%" stop-color="#0284c7" stop-opacity="0.82" />' +
            '</linearGradient>' +
            '<linearGradient id="' + uid + '-bar-in" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="#d97706" stop-opacity="0.82" />' +
              '<stop offset="100%" stop-color="#fbbf24" />' +
            '</linearGradient>' +
            '<linearGradient id="' + uid + '-env-out" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.24" />' +
              '<stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02" />' +
            '</linearGradient>' +
            '<linearGradient id="' + uid + '-env-in" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="#f59e0b" stop-opacity="0.02" />' +
              '<stop offset="100%" stop-color="#f59e0b" stop-opacity="0.22" />' +
            '</linearGradient>' +
          '</defs>' +
          '<line x1="' + plotLeft + '" y1="' + (axisY - maxUpH) + '" x2="' + plotRight + '" y2="' + (axisY - maxUpH) + '" ' +
            'stroke="var(--border-subtle, rgba(255,255,255,0.07))" stroke-dasharray="2 3" stroke-width="0.9" />' +
          '<line x1="' + plotLeft + '" y1="' + fmtNum(axisY - maxUpH * 0.5) + '" x2="' + plotRight + '" y2="' + fmtNum(axisY - maxUpH * 0.5) + '" ' +
            'stroke="var(--border-subtle, rgba(255,255,255,0.045))" stroke-dasharray="1 4" stroke-width="0.8" />' +
          '<line x1="' + plotLeft + '" y1="' + fmtNum(axisY + maxDownH * 0.5) + '" x2="' + plotRight + '" y2="' + fmtNum(axisY + maxDownH * 0.5) + '" ' +
            'stroke="var(--border-subtle, rgba(255,255,255,0.045))" stroke-dasharray="1 4" stroke-width="0.8" />' +
          '<line x1="' + plotLeft + '" y1="' + (axisY + maxDownH) + '" x2="' + plotRight + '" y2="' + (axisY + maxDownH) + '" ' +
            'stroke="var(--border-subtle, rgba(255,255,255,0.07))" stroke-dasharray="2 3" stroke-width="0.9" />' +
          quarterGridSvg +
          driftShadeSvg +
          envelopeSvg +
          '<line class="pv-ledger-axis" x1="' + plotLeft + '" y1="' + axisY + '" x2="' + plotRight + '" y2="' + axisY + '" ' +
            'stroke="var(--border-strong, rgba(255,255,255,0.24))" stroke-width="1" />' +
          '<text x="' + (plotLeft - 6) + '" y="' + (axisY - maxUpH + 7) + '" text-anchor="end" ' +
            'font-family="var(--font-mono, monospace)" font-size="9.5" font-weight="600" fill="var(--pv-ledger-out, #38bdf8)">OUT</text>' +
          '<text x="' + (plotLeft - 6) + '" y="' + (axisY + maxDownH) + '" text-anchor="end" ' +
            'font-family="var(--font-mono, monospace)" font-size="9.5" font-weight="600" fill="var(--pv-ledger-in, #f59e0b)">IN</text>' +
          '<g class="pv-ledger-weeks">' + weekMarksSvg + '</g>' +
          xTicksSvg +
        '</svg>' +
      '</div>';

    const legendHtml =
      '<div class="pv-ledger-legend">' +
        '<span class="pv-ledger-leg-item"><span class="pv-ledger-swatch is-out"></span>Outbound</span>' +
        '<span class="pv-ledger-leg-item"><span class="pv-ledger-swatch is-in"></span>Inbound</span>' +
        '<span class="pv-ledger-leg-item"><span class="pv-ledger-swatch is-mtg"></span>Meeting</span>' +
        (isDrifting ? '<span class="pv-ledger-leg-item is-drift"><span class="pv-ledger-swatch is-drift"></span>Drift anomaly</span>' : '') +
        '<span class="pv-ledger-leg-span tabular">52 weeks</span>' +
      '</div>';

    const summaryHtml = summarySentence
      ? '<p class="pv-ledger-summary">' + escapeHtml(summarySentence) + '</p>'
      : '';

    const extras = renderChannelAndReciprocityExtras(channelBreakdown, reciprocity);

    return (
      '<div class="pv-ledger-ribbon" data-weeks="52" data-drifting="' + (isDrifting ? 'true' : 'false') + '" data-owed="' + (owed ? 'true' : 'false') + '">' +
        headerRowHtml +
        summaryHtml +
        ribbonSvg +
        legendHtml +
        extras +
      '</div>'
    );
  }

  function renderChannelAndReciprocityExtras(channelBreakdown, reciprocity) {
    let channelMixHtml = '';
    const chItems = Array.isArray(channelBreakdown)
      ? channelBreakdown
          .filter(function (c) { return c && (safeNum(c.count, 0) > 0 || safeNum(c.pct, 0) > 0); })
      : [];

    if (chItems.length > 0) {
      const totalCount = chItems.reduce(function (acc, c) { return acc + Math.max(0, safeNum(c.count, 0)); }, 0);
      const totalPct = chItems.reduce(function (acc, c) { return acc + Math.max(0, safeNum(c.pct, 0)); }, 0);

      const mixNormalized = chItems.map(function (c) {
        const meta = lookupChannelMeta(c.channel, c.label);
        const rawPct = totalCount > 0
          ? (Math.max(0, safeNum(c.count, 0)) / totalCount) * 100
          : (totalPct > 0 ? (Math.max(0, safeNum(c.pct, 0)) / totalPct) * 100 : 0);
        return {
          meta: meta,
          label: stripEmDash(c.label || meta.label).trim() || meta.label,
          count: Math.max(0, Math.round(safeNum(c.count, 0))),
          pct: clamp(Math.round(rawPct), 0, 100, 0),
          exactPct: clamp(rawPct, 0, 100, 0),
        };
      });

      const mixSegs = mixNormalized.map(function (item) {
        const tip = item.meta.full + ': ' + item.count + ' (' + item.pct + '%)';
        return (
          '<span class="pv-mix-seg is-' + escapeHtml(item.meta.key) + '" ' +
            'title="' + escapeHtml(tip) + '" data-viz-tip="' + escapeHtml(tip) + '" ' +
            'style="display:block;height:100%;width:' + fmtNum(item.exactPct, 2) + '%;background:' + item.meta.color + ';"></span>'
        );
      }).join('');

      const mixLegend = mixNormalized.map(function (item) {
        return (
          '<span class="pv-mix-item" style="display:inline-flex;align-items:center;gap:4px;">' +
            '<span class="pv-mix-dot" style="display:inline-block;width:6px;height:6px;border-radius:999px;background:' + item.meta.color + ';"></span>' +
            '<span>' + escapeHtml(item.label) + ' ' + item.pct + '%</span>' +
          '</span>'
        );
      }).join('<span class="pv-mix-sep" aria-hidden="true" style="color:var(--ink-faint,#666666);">\u00b7</span>');

      channelMixHtml =
        '<div class="pv-channel-mix" style="margin-top:8px;">' +
          '<div class="pv-mix-bar" style="display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;gap:1px;background:var(--surface-inset,rgba(128,128,128,0.14));">' +
            mixSegs +
          '</div>' +
          '<div class="pv-mix-legend" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:5px;font-family:var(--font-mono,monospace);font-size:11px;font-variant-numeric:tabular-nums;color:var(--ink-secondary,#a1a1a1);">' +
            mixLegend +
          '</div>' +
        '</div>';
    }

    let reciprocityHtml = '';
    const rec = reciprocity && typeof reciprocity === 'object' ? reciprocity : null;
    if (rec) {
      const youCount = Math.max(0, Math.round(safeNum(rec.you_count, 0)));
      const themCount = Math.max(0, Math.round(safeNum(rec.them_count, 0)));
      const recTotal = youCount + themCount;
      if (recTotal > 0) {
        const youPct = rec.you_pct != null && Number.isFinite(Number(rec.you_pct))
          ? Math.round(clamp(rec.you_pct, 0, 100, 50))
          : Math.round((youCount / recTotal) * 100);
        const themPct = 100 - youPct;
        const recTitle = 'Reciprocity: You ' + youCount + ' (' + youPct + '%) vs Them ' + themCount + ' (' + themPct + '%)';

        reciprocityHtml =
          '<div class="pv-reciprocity" title="' + escapeHtml(recTitle) + '" data-viz-tip="' + escapeHtml(recTitle) + '" style="margin-top:9px;padding-top:8px;border-top:1px solid var(--border-hairline,rgba(255,255,255,0.09));">' +
            '<div class="pv-reciprocity-head" style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-family:var(--font-mono,monospace);font-size:11px;font-variant-numeric:tabular-nums;">' +
              '<span style="color:var(--ink-primary,#ededed);">You <strong>' + youPct + '%</strong> <span style="color:var(--ink-muted,#737373);">(' + youCount + ')</span></span>' +
              '<span style="color:var(--ink-secondary,#a1a1a1);">Them <strong>' + themPct + '%</strong> <span style="color:var(--ink-muted,#737373);">(' + themCount + ')</span></span>' +
            '</div>' +
            '<div class="pv-reciprocity-track" style="position:relative;display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;background:var(--surface-inset,rgba(128,128,128,0.14));">' +
              '<span class="pv-reciprocity-you" style="display:block;height:100%;width:' + youPct + '%;background:var(--pv-reciprocity-you,var(--accent-blue,#3291ff));"></span>' +
              '<span class="pv-reciprocity-them" style="display:block;height:100%;width:' + themPct + '%;background:var(--pv-reciprocity-them,var(--ink-faint,#666666));"></span>' +
              '<span class="pv-reciprocity-mid" aria-hidden="true" style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--surface-raised,#0a0a0a);opacity:0.7;"></span>' +
            '</div>' +
          '</div>';
      }
    }

    return channelMixHtml + reciprocityHtml;
  }

  function renderCadenceSparklineSvg(series, channelBreakdown, reciprocity, ledger) {
    // Prefer 52-week dual-sided relationship ledger ribbon when supplied
    if (ledger && typeof ledger === 'object' && Array.isArray(ledger.weeks) && ledger.weeks.length === 52) {
      return renderRelationshipLedgerRibbon(ledger, channelBreakdown, reciprocity);
    }
    if (series && !Array.isArray(series) && typeof series === 'object' && Array.isArray(series.weeks) && series.weeks.length === 52) {
      return renderRelationshipLedgerRibbon(series, channelBreakdown, reciprocity);
    }
    const weeks = Array.isArray(series) ? series.filter(Boolean).slice(-16) : [];
    const plotLeft = 28;
    const plotRight = 352;
    const plotTop = 10;
    const plotBottom = 74;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    let maxTotal = 0;
    const normalizedWeeks = weeks.map(function (w, idx) {
      const wa = Math.max(0, safeNum(w.whatsapp, 0));
      const tg = Math.max(0, safeNum(w.telegram, 0));
      const imsg = Math.max(0, safeNum(w.imessage, 0));
      const gm = Math.max(0, safeNum(w.gmail, 0));
      const cal = Math.max(0, safeNum(w.calendar, 0));
      const stackedSum = wa + tg + imsg + gm + cal;
      const explicitTotal = Math.max(0, safeNum(w.total, 0));
      const total = Math.max(stackedSum, explicitTotal);
      const other = Math.max(0, total - stackedSum);
      if (total > maxTotal) maxTotal = total;
      return {
        label: stripEmDash(w.week_label || ('W' + (idx + 1))).trim(),
        total: total,
        segments: [
          { meta: CHANNEL_META[0], val: wa },
          { meta: CHANNEL_META[1], val: tg },
          { meta: CHANNEL_META[2], val: imsg },
          { meta: CHANNEL_META[3], val: gm },
          { meta: CHANNEL_META[4], val: cal },
          { meta: { key: 'other', label: 'Other', full: 'Other', color: 'var(--ink-faint, #666666)' }, val: other },
        ],
      };
    });

    const scaleMax = maxTotal > 0 ? maxTotal : 1;
    let barsSvg = '';
    let xTicksSvg = '';

    if (normalizedWeeks.length === 0) {
      barsSvg =
        '<text x="' + fmtNum(plotLeft + plotW / 2) + '" y="' + fmtNum(plotTop + plotH / 2 + 3) + '" ' +
          'text-anchor="middle" font-family="var(--font-mono, monospace)" font-size="10" fill="var(--ink-muted, #737373)">' +
          'No recent weekly cadence recorded' +
        '</text>';
    } else {
      const count = normalizedWeeks.length;
      const slotW = plotW / count;
      const barW = Math.max(4, Math.min(16, slotW * 0.66));

      barsSvg = normalizedWeeks.map(function (w, idx) {
        const cx = plotLeft + (idx + 0.5) * slotW;
        const x = cx - barW / 2;

        const detailParts = [];
        for (let s = 0; s < w.segments.length; s += 1) {
          if (w.segments[s].val > 0) {
            detailParts.push(w.segments[s].meta.label + ' ' + Math.round(w.segments[s].val));
          }
        }
        const totalRounded = Math.round(w.total);
        const tip = w.label + ': ' + totalRounded + ' interactions' + (detailParts.length ? ' (' + detailParts.join(', ') + ')' : '');
        const escapedTip = escapeHtml(tip);

        let stackY = plotBottom;
        const rects = [];
        if (w.total > 0) {
          for (let s = 0; s < w.segments.length; s += 1) {
            const seg = w.segments[s];
            if (seg.val <= 0) continue;
            const rawH = (seg.val / scaleMax) * plotH;
            const segH = Math.max(1.5, rawH);
            const y = Math.max(plotTop, stackY - segH);
            const actualH = Math.max(0, stackY - y);
            stackY = y;
            rects.push(
              '<rect class="pv-cadence-seg is-' + seg.meta.key + '" ' +
                'x="' + fmtNum(x) + '" y="' + fmtNum(y) + '" width="' + fmtNum(barW) + '" height="' + fmtNum(actualH) + '" ' +
                'rx="1" fill="' + seg.meta.color + '" />'
            );
          }
        } else {
          rects.push(
            '<rect class="pv-cadence-zero" x="' + fmtNum(x) + '" y="' + fmtNum(plotBottom - 1.5) + '" ' +
              'width="' + fmtNum(barW) + '" height="1.5" rx="0.75" fill="var(--border-strong, rgba(255,255,255,0.16))" />'
          );
        }

        return (
          '<g class="pv-cadence-bar" data-viz-tip="' + escapedTip + '" tabindex="0" style="cursor:default;">' +
            '<title>' + escapedTip + '</title>' +
            '<rect class="pv-cadence-hit" x="' + fmtNum(plotLeft + idx * slotW) + '" y="' + plotTop + '" width="' + fmtNum(slotW) + '" height="' + plotH + '" fill="transparent" />' +
            rects.join('') +
          '</g>'
        );
      }).join('');

      // First / Mid / Last X-axis week ticks
      const tickIndices = [0];
      if (count >= 3) tickIndices.push(Math.floor((count - 1) / 2));
      if (count >= 2) tickIndices.push(count - 1);

      xTicksSvg = tickIndices.map(function (ti, pos) {
        const isFirst = pos === 0;
        const atEnd = pos === tickIndices.length - 1 && tickIndices.length > 1;
        const anchor = isFirst ? 'start' : (atEnd ? 'end' : 'middle');
        const tx = isFirst
          ? plotLeft
          : (atEnd ? plotRight : plotLeft + (ti + 0.5) * slotW);
        return (
          '<text x="' + fmtNum(tx) + '" y="88" text-anchor="' + anchor + '" ' +
            'font-family="var(--font-mono, monospace)" font-size="9" fill="var(--ink-muted, #737373)">' +
            escapeHtml(truncate(normalizedWeeks[ti].label, 12)) +
          '</text>'
        );
      }).join('');
    }

    const chartSvg =
      '<svg class="pv-cadence-svg" viewBox="0 0 360 94" width="100%" ' +
        'role="img" aria-label="Weekly multi-channel interaction cadence" style="display:block;height:auto;">' +
        '<line x1="' + plotLeft + '" y1="' + plotTop + '" x2="' + plotRight + '" y2="' + plotTop + '" ' +
          'stroke="var(--border-subtle, rgba(255,255,255,0.06))" stroke-dasharray="2 3" stroke-width="1" />' +
        '<line x1="' + plotLeft + '" y1="' + plotBottom + '" x2="' + plotRight + '" y2="' + plotBottom + '" ' +
          'stroke="var(--border-strong, rgba(255,255,255,0.16))" stroke-width="1" />' +
        '<text x="' + (plotLeft - 5) + '" y="' + (plotTop + 3) + '" text-anchor="end" ' +
          'font-family="var(--font-mono, monospace)" font-size="9" font-variant-numeric="tabular-nums" fill="var(--ink-muted, #737373)">' +
          Math.round(maxTotal) +
        '</text>' +
        '<text x="' + (plotLeft - 5) + '" y="' + (plotBottom + 2) + '" text-anchor="end" ' +
          'font-family="var(--font-mono, monospace)" font-size="9" font-variant-numeric="tabular-nums" fill="var(--ink-faint, #666666)">0</text>' +
        barsSvg +
        xTicksSvg +
      '</svg>';

    // Channel Mix Bar + compact legend
    let channelMixHtml = '';
    const chItems = Array.isArray(channelBreakdown)
      ? channelBreakdown
          .filter(function (c) { return c && (safeNum(c.count, 0) > 0 || safeNum(c.pct, 0) > 0); })
      : [];

    if (chItems.length > 0) {
      const totalCount = chItems.reduce(function (acc, c) { return acc + Math.max(0, safeNum(c.count, 0)); }, 0);
      const totalPct = chItems.reduce(function (acc, c) { return acc + Math.max(0, safeNum(c.pct, 0)); }, 0);

      const mixNormalized = chItems.map(function (c) {
        const meta = lookupChannelMeta(c.channel, c.label);
        const rawPct = totalCount > 0
          ? (Math.max(0, safeNum(c.count, 0)) / totalCount) * 100
          : (totalPct > 0 ? (Math.max(0, safeNum(c.pct, 0)) / totalPct) * 100 : 0);
        return {
          meta: meta,
          label: stripEmDash(c.label || meta.label).trim() || meta.label,
          count: Math.max(0, Math.round(safeNum(c.count, 0))),
          pct: clamp(Math.round(rawPct), 0, 100, 0),
          exactPct: clamp(rawPct, 0, 100, 0),
        };
      });

      const mixSegs = mixNormalized.map(function (item) {
        const tip = item.meta.full + ': ' + item.count + ' (' + item.pct + '%)';
        return (
          '<span class="pv-mix-seg is-' + escapeHtml(item.meta.key) + '" ' +
            'title="' + escapeHtml(tip) + '" data-viz-tip="' + escapeHtml(tip) + '" ' +
            'style="display:block;height:100%;width:' + fmtNum(item.exactPct, 2) + '%;background:' + item.meta.color + ';"></span>'
        );
      }).join('');

      const mixLegend = mixNormalized.map(function (item) {
        return (
          '<span class="pv-mix-item" style="display:inline-flex;align-items:center;gap:4px;">' +
            '<span class="pv-mix-dot" style="display:inline-block;width:6px;height:6px;border-radius:999px;background:' + item.meta.color + ';"></span>' +
            '<span>' + escapeHtml(item.label) + ' ' + item.pct + '%</span>' +
          '</span>'
        );
      }).join('<span class="pv-mix-sep" aria-hidden="true" style="color:var(--ink-faint,#666666);">\u00b7</span>');

      channelMixHtml =
        '<div class="pv-channel-mix" style="margin-top:8px;">' +
          '<div class="pv-mix-bar" style="display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;gap:1px;background:var(--surface-inset,rgba(128,128,128,0.14));">' +
            mixSegs +
          '</div>' +
          '<div class="pv-mix-legend" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:5px;font-family:var(--font-mono,monospace);font-size:10px;font-variant-numeric:tabular-nums;color:var(--ink-secondary,#a1a1a1);">' +
            mixLegend +
          '</div>' +
        '</div>';
    }

    // Reciprocity Bar (only when you_count + them_count > 0)
    let reciprocityHtml = '';
    const rec = reciprocity && typeof reciprocity === 'object' ? reciprocity : null;
    if (rec) {
      const youCount = Math.max(0, Math.round(safeNum(rec.you_count, 0)));
      const themCount = Math.max(0, Math.round(safeNum(rec.them_count, 0)));
      const recTotal = youCount + themCount;
      if (recTotal > 0) {
        const youPct = rec.you_pct != null && Number.isFinite(Number(rec.you_pct))
          ? Math.round(clamp(rec.you_pct, 0, 100, 50))
          : Math.round((youCount / recTotal) * 100);
        const themPct = 100 - youPct;
        const recTitle = 'Reciprocity: You ' + youCount + ' (' + youPct + '%) vs Them ' + themCount + ' (' + themPct + '%)';

        reciprocityHtml =
          '<div class="pv-reciprocity" title="' + escapeHtml(recTitle) + '" data-viz-tip="' + escapeHtml(recTitle) + '" style="margin-top:9px;padding-top:8px;border-top:1px solid var(--border-hairline,rgba(255,255,255,0.09));">' +
            '<div class="pv-reciprocity-head" style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-family:var(--font-mono,monospace);font-size:10px;font-variant-numeric:tabular-nums;">' +
              '<span style="color:var(--ink-primary,#ededed);">You <strong>' + youPct + '%</strong> <span style="color:var(--ink-muted,#737373);">(' + youCount + ')</span></span>' +
              '<span style="color:var(--ink-secondary,#a1a1a1);">Them <strong>' + themPct + '%</strong> <span style="color:var(--ink-muted,#737373);">(' + themCount + ')</span></span>' +
            '</div>' +
            '<div class="pv-reciprocity-track" style="position:relative;display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;background:var(--surface-inset,rgba(128,128,128,0.14));">' +
              '<span class="pv-reciprocity-you" style="display:block;height:100%;width:' + youPct + '%;background:var(--pv-reciprocity-you,var(--accent-blue,#3291ff));"></span>' +
              '<span class="pv-reciprocity-them" style="display:block;height:100%;width:' + themPct + '%;background:var(--pv-reciprocity-them,var(--ink-faint,#666666));"></span>' +
              '<span class="pv-reciprocity-mid" aria-hidden="true" style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--surface-raised,#0a0a0a);opacity:0.7;"></span>' +
            '</div>' +
          '</div>';
      }
    }

    return (
      '<div class="pv-cadence-card">' +
        chartSvg +
        channelMixHtml +
        reciprocityHtml +
      '</div>'
    );
  }

  // =========================================================================
  // 5. EGO NETWORK CONSTELLATION SVG (560 x 230)
  // =========================================================================

  // Pre-balanced left/right slots on r=68 (inner) and r=102 (outer).
  // Guarantees >= 39px vertical spacing on each side and zero overlap with the center pill.
  const EGO_SLOTS = [
    { r: 68,  deg: -35, side: 'right' },
    { r: 68,  deg: -145, side: 'left' },
    { r: 102, deg: 0, side: 'right' },
    { r: 102, deg: 180, side: 'left' },
    { r: 68,  deg: 45, side: 'right' },
    { r: 68,  deg: 135, side: 'left' },
    { r: 102, deg: -62, side: 'right' },
    { r: 102, deg: -118, side: 'left' },
    { r: 102, deg: 64, side: 'right' },
    { r: 102, deg: 116, side: 'left' },
  ];

  function renderEgoGraphSvg(egoGraph) {
    const g = egoGraph && typeof egoGraph === 'object' ? egoGraph : {};
    const center = g.center && typeof g.center === 'object' ? g.center : {};
    const centerName = stripEmDash(center.name || 'Subject').trim() || 'Subject';
    const centerInitials = stripEmDash(center.initials || deriveInitials(centerName, '?'))
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const centerTier = stripEmDash(center.tier || '').trim();
    const centerRole = stripEmDash(center.role || '').trim();
    const centerTitle = [centerName, centerTier, centerRole].filter(Boolean).join(' - ');

    const nodes = Array.isArray(g.nodes) ? g.nodes.filter(Boolean).slice(0, 10) : [];
    const cx = 280;
    const cy = 115;

    let maxWeight = 1;
    for (let i = 0; i < nodes.length; i += 1) {
      const w = safeNum(nodes[i].weight, 1);
      if (w > maxWeight) maxWeight = w;
    }

    const edgesSvg = [];
    const nodesSvg = [];

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const slot = EGO_SLOTS[i];
      const rad = (slot.deg * Math.PI) / 180;
      const nx = cx + Math.cos(rad) * slot.r;
      const ny = cy + Math.sin(rad) * slot.r;

      const weight = Math.max(0, safeNum(node.weight, 1));
      const normW = maxWeight > 0 ? clamp(weight / maxWeight, 0, 1, 0.5) : 0.5;
      const strokeW = 1.15 + normW * 1.35;

      // Quadratic Bezier control point subtly curved perpendicular to the spoke
      const dx = nx - cx;
      const dy = ny - cy;
      const mx = cx + dx * 0.5;
      const my = cy + dy * 0.5;
      const bendSign = (i % 2 === 0 ? 1 : -1) * (slot.side === 'right' ? 1 : -1);
      const qx = mx - dy * 0.14 * bendSign;
      const qy = my + dx * 0.14 * bendSign;

      const kindRaw = String(node.kind || 'person').toLowerCase();
      const isPerson = kindRaw === 'person';
      const isCompany = kindRaw === 'company' || kindRaw === 'org' || kindRaw === 'organization';
      const safeKind = isPerson ? 'person' : (isCompany ? 'company' : 'workstream');
      const label = stripEmDash(node.label || node.key || node.id || 'Node').trim() || 'Node';
      const meta = stripEmDash(node.meta || '').trim();
      const nodeTitle = label + (meta ? ' - ' + meta : '');

      const edgeStroke = isPerson
        ? 'var(--accent-blue, #3291ff)'
        : (isCompany ? 'var(--accent-amber, #f5a623)' : 'var(--accent-violet, #a78bfa)');
      const strokeOp = isPerson
        ? (0.46 + normW * 0.42)
        : (0.54 + normW * 0.34);

      edgesSvg.push(
        '<path class="pv-ego-edge is-' + safeKind + '" ' +
          'd="M ' + cx + ' ' + cy + ' Q ' + fmtNum(qx) + ' ' + fmtNum(qy) + ' ' + fmtNum(nx) + ' ' + fmtNum(ny) + '" ' +
          'fill="none" stroke="' + edgeStroke + '" ' +
          'style="stroke:' + edgeStroke + ';stroke-opacity:' + fmtNum(strokeOp, 2) + ';stroke-width:' + fmtNum(strokeW, 2) + ';" ' +
          'stroke-linecap="round">' +
          '<title>' + escapeHtml(nodeTitle) + '</title>' +
        '</path>'
      );

      // Compute non-clipping outward label pill
      const isRight = slot.side === 'right';
      const availPx = isRight ? (554 - (nx + 15)) : ((nx - 15) - 6);
      const maxChars = Math.max(8, Math.min(22, Math.floor((availPx - 12) / 6.1)));
      const shortLabel = truncate(label, maxChars);
      const pillW = Math.min(availPx, Math.max(36, shortLabel.length * 6.1 + 12));
      const pillH = 18;
      const pillY = ny - pillH / 2;
      const pillX = isRight ? (nx + 15) : (nx - 15 - pillW);
      const textX = isRight ? (pillX + 6) : (pillX + pillW - 6);
      const textAnchor = isRight ? 'start' : 'end';

      const pillBorder = isPerson
        ? 'var(--border-strong, rgba(255,255,255,0.22))'
        : (isCompany
          ? 'var(--tint-amber-border, rgba(245, 166, 35, 0.42))'
          : 'var(--tint-violet-border, rgba(167, 139, 250, 0.42))');

      const pillSvg =
        '<rect class="pv-ego-pill-bg" x="' + fmtNum(pillX) + '" y="' + fmtNum(pillY) + '" ' +
          'width="' + fmtNum(pillW) + '" height="' + pillH + '" rx="4" ' +
          'fill="var(--surface-selected, #141416)" stroke="' + pillBorder + '" stroke-width="1.1" />' +
        '<text class="pv-ego-pill-text" x="' + fmtNum(textX) + '" y="' + fmtNum(ny + 3.5) + '" ' +
          'text-anchor="' + textAnchor + '" font-family="var(--font-sans, sans-serif)" font-size="10" font-weight="500" ' +
          'fill="var(--ink-primary, #ededed)">' +
          escapeHtml(shortLabel) +
        '</text>';

      const kindDisplay = isPerson ? 'Person' : (isCompany ? 'Company' : 'Workstream');
      if (isPerson) {
        const openKey = stripEmDash(node.key || node.id || label).trim();
        const initials = stripEmDash(node.initials || deriveInitials(label, '?'))
          .trim()
          .toUpperCase()
          .slice(0, 2);
        const egoTip = label + ' (' + kindDisplay + ') - Click to open' + (meta ? ' (' + meta + ')' : '');
        nodesSvg.push(
          '<g class="pv-ego-node is-person is-clickable" data-open-person="' + escapeHtml(openKey) + '" ' +
            'data-viz-tip="' + escapeHtml(egoTip) + '" ' +
            'tabindex="0" role="button" aria-label="Open dossier for ' + escapeHtml(label) + '" style="cursor:pointer;">' +
            '<title>' + escapeHtml(egoTip) + '</title>' +
            '<circle class="pv-ego-node-dot" cx="' + fmtNum(nx) + '" cy="' + fmtNum(ny) + '" r="10" ' +
              'fill="var(--surface-raised, #0a0a0a)" stroke="var(--border-strong, rgba(255,255,255,0.22))" stroke-width="1.25" />' +
            '<text x="' + fmtNum(nx) + '" y="' + fmtNum(ny + 3) + '" text-anchor="middle" ' +
              'font-family="var(--font-mono, monospace)" font-size="8.5" font-weight="600" ' +
              'fill="var(--ink-primary, #ededed)">' +
              escapeHtml(initials) +
            '</text>' +
            pillSvg +
          '</g>'
        );
      } else {
        const badgeGlyph = isCompany ? 'CO' : 'WS';
        const boxFill = isCompany
          ? 'var(--tint-amber-bg, rgba(245, 166, 35, 0.14))'
          : 'var(--tint-violet-bg, rgba(167, 139, 250, 0.14))';
        const boxStroke = isCompany
          ? 'var(--accent-amber, #f5a623)'
          : 'var(--accent-violet, #a78bfa)';
        const egoTip = label + ' (' + kindDisplay + ')' + (meta ? ' - ' + meta : '');
        nodesSvg.push(
          '<g class="pv-ego-node is-' + safeKind + '" data-viz-tip="' + escapeHtml(egoTip) + '" style="cursor:default;">' +
            '<title>' + escapeHtml(egoTip) + '</title>' +
            '<rect class="pv-ego-node-box" x="' + fmtNum(nx - 10) + '" y="' + fmtNum(ny - 10) + '" ' +
              'width="20" height="20" rx="4" ' +
              'fill="' + boxFill + '" stroke="' + boxStroke + '" stroke-opacity="0.82" stroke-width="1.35" />' +
            '<text x="' + fmtNum(nx) + '" y="' + fmtNum(ny + 3) + '" text-anchor="middle" ' +
              'font-family="var(--font-mono, monospace)" font-size="8" font-weight="600" ' +
              'fill="var(--ink-primary, #ededed)">' +
              badgeGlyph +
            '</text>' +
            pillSvg +
          '</g>'
        );
      }
    }

    // Center full-name pill beneath the 24px center node
    const centerShort = truncate(centerName, 18);
    const centerPillW = Math.min(132, Math.max(54, centerShort.length * 6.2 + 14));
    const centerPillX = cx - centerPillW / 2;
    const centerPillY = cy + 19;

    const centerSvg =
      '<g class="pv-ego-center" data-viz-tip="' + escapeHtml(centerTitle) + '">' +
        '<title>' + escapeHtml(centerTitle) + '</title>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="16.5" fill="none" stroke="var(--border-strong, rgba(255,255,255,0.22))" stroke-width="1" />' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="12" fill="var(--surface-inverse, #ededed)" stroke="var(--surface-raised, #0a0a0a)" stroke-width="1.5" />' +
        '<text x="' + cx + '" y="' + (cy + 3.5) + '" text-anchor="middle" ' +
          'font-family="var(--font-mono, monospace)" font-size="9.5" font-weight="600" ' +
          'fill="var(--ink-on-accent, #0a0a0a)">' +
          escapeHtml(centerInitials) +
        '</text>' +
        '<rect x="' + fmtNum(centerPillX) + '" y="' + fmtNum(centerPillY) + '" ' +
          'width="' + fmtNum(centerPillW) + '" height="16" rx="4" ' +
          'fill="var(--surface-overlay, #111111)" stroke="var(--border-strong, rgba(255,255,255,0.16))" stroke-width="1" />' +
        '<text x="' + cx + '" y="' + fmtNum(centerPillY + 11.2) + '" text-anchor="middle" ' +
          'font-family="var(--font-sans, sans-serif)" font-size="10" font-weight="600" ' +
          'fill="var(--ink-primary, #ededed)">' +
          escapeHtml(centerShort) +
        '</text>' +
      '</g>';

    const emptyHint = nodes.length === 0
      ? '<text x="' + cx + '" y="' + (cy + 52) + '" text-anchor="middle" font-family="var(--font-mono, monospace)" font-size="10" fill="var(--ink-muted, #737373)">No connected graph nodes yet</text>'
      : '';

    return (
      '<svg class="pv-ego-svg" viewBox="0 0 560 230" width="100%" ' +
        'role="img" aria-label="Ego relationship constellation for ' + escapeHtml(centerName) + '" ' +
        'style="display:block;height:auto;">' +
        '<g class="pv-ego-orbits">' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="68" fill="none" stroke="var(--border-hairline, rgba(255,255,255,0.09))" stroke-width="1" />' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="102" fill="none" stroke="var(--border-subtle, rgba(255,255,255,0.055))" stroke-dasharray="2 3" stroke-width="1" />' +
        '</g>' +
        '<g class="pv-ego-edges">' + edgesSvg.join('') + '</g>' +
        '<g class="pv-ego-nodes">' + nodesSvg.join('') + '</g>' +
        centerSvg +
        emptyHint +
      '</svg>'
    );
  }

  return {
    renderInlineMd: renderInlineMd,
    renderTraitRadarSvg: renderTraitRadarSvg,
    renderLeverageBalanceSvg: renderLeverageBalanceSvg,
    renderCadenceSparklineSvg: renderCadenceSparklineSvg,
    renderRelationshipLedgerRibbon: renderRelationshipLedgerRibbon,
    renderEgoGraphSvg: renderEgoGraphSvg,
    renderContactIcon: renderContactIcon,
    renderArchetypeBadge: renderArchetypeBadge,
  };
});
