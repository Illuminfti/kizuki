/* ==========================================================================
   KIZUKI MIND EXPLORER - RICH MULTIPLAYER MESSAGE & ARTIFACT RENDERER
   Evil Rabbit "Evil Code" Studio Typography, Interactive Mentions,
   Structured Spec Cards, Machined Unified Git Diffs, Code & Kizuki Mind Pills.
   Exports: window.KizukiBoardArtifacts = {
     renderRichMessage,
     renderSignalBadge,
     renderTelemetryRibbon,
     renderReplyPreviewStrip,
     renderThreadSpineHtml,
     isLongMessageBody,
     copyCodeHandler,
   }
   Zero external deps | 100% XSS-safe | Zero em-dashes | Deterministic
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiBoardArtifacts = api;
  }
  if (typeof window !== 'undefined' && window && typeof window === 'object') {
    window.KizukiBoardArtifacts = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this,
  function (root) {
    'use strict';

    const EM_DASH_RE = /\s*\u2014\s*/g;
    const EN_DASH_RE = /\s*\u2013\s*/g;
    const MAX_ARTIFACTS = 4;
    const COPY_RESET_MS = 1200;

    const OWNER_DOT_SVG =
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' +
      '<circle cx="7" cy="7" r="3.1"/></svg>';

    const MIND_KINDS = Object.freeze({
      person: {
        prefix: 'Person',
        defaultView: 'people',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="5.2" r="2.6"/><path d="M3.2 13.4c.7-2.4 2.5-3.6 4.8-3.6s4.1 1.2 4.8 3.6"/></svg>',
      },
      vault: {
        prefix: 'Vault',
        defaultView: 'vault',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M4 2.5h5.5L13 6v7.5H4z"/><path d="M9.5 2.5V6H13"/></svg>',
      },
      codex: {
        prefix: 'Codex',
        defaultView: 'codex',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5M9 3.5 7 12.5"/></svg>',
      },
      taste: {
        prefix: 'Taste',
        defaultView: 'taste',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6 8 2.2Z"/></svg>',
      },
      replay: {
        prefix: 'Replay',
        defaultView: 'replay',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/></svg>',
      },
      commit: {
        prefix: 'Commit',
        defaultView: 'codex',
        icon:
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="2.4"/><path d="M2 8h3.6M10.4 8H14"/></svg>',
      },
    });

    const SIGNAL_MAP = Object.freeze({
      decision: { slug: 'decision', label: 'Decision' },
      debate: { slug: 'debate', label: 'Debate' },
      debrief: { slug: 'debrief', label: 'Debrief' },
      rsi: { slug: 'rsi', label: 'RSI' },
      taste: { slug: 'taste', label: 'Taste' },
      work: { slug: 'work', label: 'Work' },
      telemetry: { slug: 'telemetry', label: 'Telemetry' },
    });

    const BARE_MENTION_RE =
      /(^|[\s(>\[,;:])@(claude(?:-[a-zA-Z0-9_.-]+)?|codex(?:-[a-zA-Z0-9_.-]+)?|orchestrator|board-keeper|dreamer|scribe-bot|brain|scribe[a-zA-Z0-9_-]*|antigravity-swarm|antigravity|neon|designer|scout-fleet(?:-[a-zA-Z0-9_.-]+)?|daemon|owner)(?![a-zA-Z0-9_.-])/gi;

    const KV_KEY_RE =
      /^(goal|done-check|done_check|sources|risk-classification|risk|owner|tid|branch|worktree|receipt|diff|top lesson|status|evidence|source|confidence)\s*:\s*(.+)$/i;

    const SECTION_HEAD_RE =
      /^(learned|learnings|frustrations|ideas(?:\s+filed\s+to\s+intake)?|taste|decisions|next|actions|blockers)\s*:\s*$/i;

    let copySeq = 0;

    function getWin() {
      if (typeof window !== 'undefined' && window) return window;
      if (root && root.window) return root.window;
      return root || null;
    }

    function getDoc() {
      if (typeof document !== 'undefined' && document) return document;
      const w = getWin();
      return w && w.document ? w.document : null;
    }

    function playClickSound() {
      const w = getWin();
      const sound = (w && w.KizukiSound) || (root && root.KizukiSound);
      if (!sound || typeof sound.click !== 'function') return;
      try {
        sound.click();
      } catch {
        // Optional audio feedback must never block UI interactions
      }
    }

    function stripEmDash(value) {
      return String(value == null ? '' : value)
        .replace(EM_DASH_RE, ' - ')
        .replace(EN_DASH_RE, ' - ');
    }

    function humanizeMentionsText(value) {
      return stripEmDash(value == null ? '' : value)
        .replace(/@\[local:user:[^\]+]+\+([^\]]+)\]/gi, '@$1')
        .replace(/@\[local:user:([^\]+]+)\]/gi, '@$1')
        .replace(/@\[tailscale:user:([^\]@]+)@[^\]]+\]/gi, '@$1')
        .replace(/@\[tailscale:user:([^\]]+)\]/gi, '@$1')
        .replace(/@ubuntu\/([a-zA-Z0-9._-]+)/gi, '@$1');
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

    function sanitizeSlug(value, fallback) {
      const clean = String(value == null ? '' : value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return clean || (fallback || 'default');
    }

    function isSafeHttpUrl(raw) {
      if (typeof raw !== 'string') return false;
      const trimmed = raw.trim();
      if (!/^https?:\/\/[^\s<>"'`]+$/i.test(trimmed)) return false;
      try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    }

    function cleanUrlTail(url) {
      let out = String(url || '').trim();
      while (out.length > 8 && /[.,;:!?\]})]+$/.test(out)) {
        const last = out.charAt(out.length - 1);
        if (last === ')') {
          const opens = (out.match(/\(/g) || []).length;
          const closes = (out.match(/\)/g) || []).length;
          if (closes <= opens) break;
        }
        out = out.slice(0, -1);
      }
      return out;
    }

    function extractActorSlug(rawActor, rawProfile) {
      const profile = rawProfile ? String(rawProfile).trim().replace(/^@+/, '') : '';
      if (profile) return profile;
      const clean = String(rawActor || '').trim().replace(/^@+/, '');
      if (!clean) return '';
      if (clean.includes('+')) {
        return clean.split('+').slice(1).join('+').trim();
      }
      const ubuntuSlash = /^ubuntu\/([a-zA-Z0-9._-]+)$/i.exec(clean);
      if (ubuntuSlash && ubuntuSlash[1]) {
        return ubuntuSlash[1].trim();
      }
      const tailscaleMatch = /^tailscale:user:(.+)$/i.exec(clean);
      if (tailscaleMatch && tailscaleMatch[1]) {
        const email = tailscaleMatch[1].trim();
        return email.includes('@') ? email.split('@')[0].trim() : email;
      }
      const localMatch = /^local:user:([^:+]+)(?::(.+))?$/i.exec(clean);
      if (localMatch) {
        return (localMatch[2] || localMatch[1] || '').trim();
      }
      return clean;
    }

    function resolveAgentBrand(rawHandle, explicitBrand) {
      const raw = String(rawHandle || '').trim();
      const slug = extractActorSlug(raw, '');
      const lower = slug.toLowerCase();
      const exp = String(explicitBrand || '').toLowerCase();

      if (
        /^tailscale:user:/i.test(raw) ||
        /^local:user:[^:+]+$/i.test(raw) ||
        lower === 'owner' ||
        lower === 'ubuntu' ||
        lower === 'owner' ||
        lower === 'self' ||
        exp === 'owner'
      ) {
        return {
          handle: slug || 'owner',
          brand: 'owner',
          glyphHtml: OWNER_DOT_SVG,
          isOwner: true,
        };
      }

      if (lower.includes('claude') || exp === 'claude') {
        return {
          handle: slug || 'claude',
          brand: 'claude',
          glyphHtml: '*',
          isOwner: false,
        };
      }

      if (lower.includes('codex') || lower.includes('scout-fleet') || exp === 'codex') {
        return {
          handle: slug || 'codex',
          brand: 'codex',
          glyphHtml: '&lt;/&gt;',
          isOwner: false,
        };
      }

      if (
        lower.includes('antigravity') ||
        lower.includes('designer') ||
        lower.includes('design') ||
        lower.includes('neon') ||
        lower.includes('dreamer') ||
        lower.includes('visual') ||
        lower.includes('rabbit') ||
        lower.startsWith('scribe') ||
        exp === 'designer' ||
        exp === 'neon'
      ) {
        return {
          handle: slug || 'designer',
          brand: 'designer',
          glyphHtml: 'II',
          isOwner: false,
        };
      }

      if (
        lower.includes('orchestrator') ||
        lower.includes('board-keeper') ||
        lower.includes('brain') ||
        lower === 'kizuki' ||
        lower === 'dispatch' ||
        lower.includes('daemon') ||
        lower.includes('ambient') ||
        exp === 'brain' ||
        exp === 'orchestrator'
      ) {
        return {
          handle: slug || 'brain',
          brand: 'brain',
          glyphHtml: '&gt;_',
          isOwner: false,
        };
      }

      return {
        handle: slug || 'worker',
        brand: 'worker',
        glyphHtml: 'II',
        isOwner: false,
      };
    }

    function renderMentionChip(rawTarget, displayOverride) {
      const meta = resolveAgentBrand(rawTarget, '');
      const handle = meta.handle;
      const label = displayOverride ? stripEmDash(displayOverride) : handle;
      const glyphCls = meta.isOwner ? 'eb-mention-glyph is-owner-dot' : 'eb-mention-glyph';
      return (
        `<button type="button" class="eb-mention-chip is-${meta.brand}" ` +
        `data-eb-mention-filter="${escAttr(handle)}" ` +
        `title="Filter by @${escAttr(handle)}">` +
        `<span class="${glyphCls}" aria-hidden="true">${meta.glyphHtml}</span>` +
        `<span class="eb-mention-label">@${escHtml(label)}</span>` +
        `</button>`
      );
    }

    function renderThreadRef(numStr) {
      const digits = String(numStr || '').replace(/[^\d]/g, '');
      if (!digits) return '';
      return (
        `<button type="button" class="eb-thread-ref" ` +
        `data-eb-open-thread="${escAttr(digits)}" ` +
        `title="Open thread #${escAttr(digits)}">#${escHtml(digits)}</button>`
      );
    }

    function renderSafeInline(rawText) {
      // 1. Escape ALL untrusted input FIRST before any regex/markdown transform.
      let escaped = escHtml(rawText);
      const tokens = [];

      function stash(html) {
        const idx = tokens.length;
        tokens.push(html);
        return `\u0000EBT_${idx}\u0000`;
      }

      // 2. Inline code spans (kept verbatim inside <code>, already escaped).
      escaped = escaped.replace(/`([^`\n]+)`/g, function (_m, inner) {
        return stash(`<code class="eb-inline-code">${inner}</code>`);
      });

      // 3. Canonical mentions: @[local:user:ubuntu+<slug>], @[local:user:<u...>], @[tailscale:user:<email>]
      escaped = escaped.replace(
        /@\[(local:user:[^\]\s]+|tailscale:user:[^\]\s]+)\]/gi,
        function (_m, canonical) {
          const decoded = canonical
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"');
          return stash(renderMentionChip(decoded));
        }
      );

      // 4. Markdown links [label](url): strictly allow http:// and https:// only.
      escaped = escaped.replace(
        /\[([^\]\n]{1,180})\]\(([^)\s]{1,1000})\)/g,
        function (_m, labelEsc, urlEsc) {
          const rawUrl = urlEsc.replace(/&amp;/g, '&');
          const cleanUrl = cleanUrlTail(rawUrl);
          if (!isSafeHttpUrl(cleanUrl)) {
            return stash(`<span class="eb-unsafe-link-text">${labelEsc}</span>`);
          }
          return stash(
            `<a class="eb-inline-link" href="${escAttr(cleanUrl)}" ` +
              `target="_blank" rel="noopener noreferrer">${labelEsc}</a>`
          );
        }
      );

      // 5. Bare http(s) URLs.
      escaped = escaped.replace(
        /(^|[\s(>\[,;:])(https?:\/\/[^\s<>()\[\]"'`]+)/gi,
        function (_m, lead, urlEsc) {
          const rawUrl = urlEsc.replace(/&amp;/g, '&');
          const cleanUrl = cleanUrlTail(rawUrl);
          const trailing = rawUrl.slice(cleanUrl.length);
          if (!isSafeHttpUrl(cleanUrl)) {
            return lead + urlEsc;
          }
          const display = cleanUrl.length > 68 ? `${cleanUrl.slice(0, 65)}...` : cleanUrl;
          return (
            lead +
            stash(
              `<a class="eb-inline-link" href="${escAttr(cleanUrl)}" ` +
                `target="_blank" rel="noopener noreferrer" title="${escAttr(cleanUrl)}">${escHtml(display)}</a>`
            ) +
            escHtml(trailing)
          );
        }
      );

      // 6. @ubuntu/<slug> mentions.
      escaped = escaped.replace(
        /(^|[\s(>\[,;:])@ubuntu\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,40})/gi,
        function (_m, lead, slug) {
          return lead + stash(renderMentionChip(`ubuntu/${slug}`, slug));
        }
      );

      // 7. Bare known agent mentions (@claude, @codex, @orchestrator, @board-keeper, @dreamer, @scribe, @brain, @scribe*, @antigravity-swarm, ...)
      escaped = escaped.replace(BARE_MENTION_RE, function (_m, lead, handle) {
        return lead + stash(renderMentionChip(handle, handle));
      });

      // 8. Cross-thread numeric refs (#2105). Lead boundary excludes HTML entities (&#39;).
      escaped = escaped.replace(
        /(^|[\s(\[,;:])#(\d{1,7})(?![0-9a-fA-F_/-])/g,
        function (_m, lead, num) {
          return lead + stash(renderThreadRef(num));
        }
      );

      // 9. Safe bold & emphasis (after all interactive tokens are stashed).
      escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      escaped = escaped.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');

      // 10. Restore stashed HTML tokens.
      return escaped.replace(/\u0000EBT_(\d+)\u0000/g, function (_m, idxStr) {
        const idx = Number(idxStr);
        return tokens[idx] != null ? tokens[idx] : '';
      });
    }

    function splitFencedBlocks(rawText) {
      const normalized = stripEmDash(rawText || '').replace(/\r\n?/g, '\n');
      const lines = normalized.split('\n');
      const segments = [];
      let proseBuf = [];
      let i = 0;

      function flushProse() {
        if (proseBuf.length) {
          segments.push({ type: 'prose', text: proseBuf.join('\n') });
          proseBuf = [];
        }
      }

      while (i < lines.length) {
        const openMatch = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]);
        if (!openMatch) {
          proseBuf.push(lines[i]);
          i += 1;
          continue;
        }
        const fenceChar = openMatch[1].charAt(0);
        const fenceLen = openMatch[1].length;
        const info = (openMatch[2] || '').trim();
        const closeRe = new RegExp(`^[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*$`);
        let j = i + 1;
        const bodyLines = [];
        let closed = false;
        while (j < lines.length) {
          if (closeRe.test(lines[j])) {
            closed = true;
            break;
          }
          bodyLines.push(lines[j]);
          j += 1;
        }
        flushProse();
        segments.push({
          type: 'fence',
          info,
          code: bodyLines.join('\n'),
          closed,
        });
        i = closed ? j + 1 : j;
      }

      flushProse();
      return segments;
    }

    function isUnifiedDiffBlock(info, code) {
      const lang = String(info || '').trim().toLowerCase();
      if (lang === 'diff' || lang === 'patch') return true;
      if (lang.startsWith('json#')) return false;
      const text = String(code || '');
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) return true;
      if (/^--- .+\n\+\+\+ /m.test(text)) return true;
      return false;
    }

    function extractDiffFileName(lines) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const plus = /^\+\+\+\s+(?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
        if (plus && plus[1] && plus[1] !== '/dev/null') return plus[1].trim();
        const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (git && git[2]) return git[2].trim();
      }
      for (let i = 0; i < lines.length; i += 1) {
        const minus = /^---\s+(?:a\/)?(.+?)(?:\t.*)?$/.exec(lines[i]);
        if (minus && minus[1] && minus[1] !== '/dev/null') return minus[1].trim();
      }
      return 'patch.diff';
    }

    function renderDiffBlock(rawCode, opts) {
      const cleanCode = stripEmDash(rawCode || '').replace(/\r\n?/g, '\n');
      const lines = cleanCode.split('\n');
      const fileName = extractDiffFileName(lines);
      const blockId = `eb-diff-${++copySeq}`;
      let adds = 0;
      let dels = 0;
      let oldLn = 0;
      let newLn = 0;
      let inHunk = false;

      const rowHtml = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
        if (hunk) {
          oldLn = Number(hunk[1]) || 1;
          newLn = Number(hunk[2]) || 1;
          inHunk = true;
          rowHtml.push(
            `<div class="eb-diff-line is-hunk">` +
              `<span class="eb-diff-ln eb-diff-ln-old" aria-hidden="true">...</span>` +
              `<span class="eb-diff-ln eb-diff-ln-new" aria-hidden="true">...</span>` +
              `<span class="eb-diff-sign" aria-hidden="true">@@</span>` +
              `<span class="eb-diff-code">${escHtml(line)}</span>` +
            `</div>`
          );
          continue;
        }

        if (
          line.startsWith('diff --git ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('new file mode') ||
          line.startsWith('deleted file mode')
        ) {
          rowHtml.push(
            `<div class="eb-diff-line is-meta">` +
              `<span class="eb-diff-ln eb-diff-ln-old" aria-hidden="true"></span>` +
              `<span class="eb-diff-ln eb-diff-ln-new" aria-hidden="true"></span>` +
              `<span class="eb-diff-sign" aria-hidden="true"></span>` +
              `<span class="eb-diff-code">${escHtml(line)}</span>` +
            `</div>`
          );
          continue;
        }

        if (line.startsWith('+')) {
          adds += 1;
          const nStr = inHunk ? String(newLn++) : '';
          rowHtml.push(
            `<div class="eb-diff-line is-add">` +
              `<span class="eb-diff-ln eb-diff-ln-old" aria-hidden="true"></span>` +
              `<span class="eb-diff-ln eb-diff-ln-new" aria-hidden="true">${escHtml(nStr)}</span>` +
              `<span class="eb-diff-sign" aria-hidden="true">+</span>` +
              `<span class="eb-diff-code">${escHtml(line.slice(1))}</span>` +
            `</div>`
          );
          continue;
        }

        if (line.startsWith('-')) {
          dels += 1;
          const oStr = inHunk ? String(oldLn++) : '';
          rowHtml.push(
            `<div class="eb-diff-line is-del">` +
              `<span class="eb-diff-ln eb-diff-ln-old" aria-hidden="true">${escHtml(oStr)}</span>` +
              `<span class="eb-diff-ln eb-diff-ln-new" aria-hidden="true"></span>` +
              `<span class="eb-diff-sign" aria-hidden="true">-</span>` +
              `<span class="eb-diff-code">${escHtml(line.slice(1))}</span>` +
            `</div>`
          );
          continue;
        }

        const oStr = inHunk ? String(oldLn++) : '';
        const nStr = inHunk ? String(newLn++) : '';
        const body = line.startsWith(' ') ? line.slice(1) : line;
        rowHtml.push(
          `<div class="eb-diff-line is-ctx">` +
            `<span class="eb-diff-ln eb-diff-ln-old" aria-hidden="true">${escHtml(oStr)}</span>` +
            `<span class="eb-diff-ln eb-diff-ln-new" aria-hidden="true">${escHtml(nStr)}</span>` +
            `<span class="eb-diff-sign" aria-hidden="true"> </span>` +
            `<span class="eb-diff-code">${escHtml(body)}</span>` +
          `</div>`
        );
      }

      const compactCls = opts && opts.compact ? ' is-compact' : '';
      return (
        `<div class="eb-diff-block${compactCls}" data-eb-block-id="${escAttr(blockId)}">` +
          `<div class="eb-diff-head">` +
            `<div class="eb-diff-head-left">` +
              `<span class="eb-code-lang is-diff">DIFF</span>` +
              `<span class="eb-diff-file" title="${escAttr(fileName)}">${escHtml(fileName)}</span>` +
            `</div>` +
            `<div class="eb-diff-head-right">` +
              `<span class="eb-diff-stats" aria-label="${adds} additions, ${dels} deletions">` +
                `<span class="eb-diff-stat is-add">+${adds}</span>` +
                `<span class="eb-diff-stat is-del">-${dels}</span>` +
              `</span>` +
              `<button type="button" class="eb-copy-btn" data-eb-copy-code="${escAttr(blockId)}" ` +
                `data-eb-copy-text="${escAttr(cleanCode)}" aria-label="Copy diff">Copy</button>` +
            `</div>` +
          `</div>` +
          `<div class="eb-diff-body" role="region" aria-label="Unified diff ${escAttr(fileName)}">` +
            rowHtml.join('') +
          `</div>` +
        `</div>`
      );
    }

    function renderCodeBlock(info, rawCode, opts) {
      const cleanCode = stripEmDash(rawCode || '').replace(/\r\n?/g, '\n');
      const lines = cleanCode.split('\n');
      const langRaw = String(info || '').trim().split(/\s+/)[0] || 'text';
      const langSlug = sanitizeSlug(langRaw.split('#')[0], 'text');
      const langLabel = langRaw.split('#')[0].toUpperCase() || 'TEXT';
      const blockId = `eb-code-${++copySeq}`;
      const lineCount = lines.length;
      const lineLabel = lineCount === 1 ? '1 line' : `${lineCount} lines`;

      const rowHtml = lines.map(function (line, idx) {
        return (
          `<span class="eb-code-line">` +
            `<span class="eb-code-ln" aria-hidden="true">${idx + 1}</span>` +
            `<span class="eb-code-text">${escHtml(line)}</span>` +
          `</span>`
        );
      });

      const compactCls = opts && opts.compact ? ' is-compact' : '';
      return (
        `<div class="eb-code-block${compactCls}" data-eb-block-id="${escAttr(blockId)}" data-eb-lang="${escAttr(langSlug)}">` +
          `<div class="eb-code-head">` +
            `<div class="eb-code-head-left">` +
              `<span class="eb-code-lang is-${escAttr(langSlug)}">${escHtml(langLabel)}</span>` +
              `<span class="eb-code-meta">${escHtml(lineLabel)}</span>` +
            `</div>` +
            `<div class="eb-code-head-right">` +
              `<button type="button" class="eb-copy-btn" data-eb-copy-code="${escAttr(blockId)}" ` +
                `data-eb-copy-text="${escAttr(cleanCode)}" aria-label="Copy code">Copy</button>` +
            `</div>` +
          `</div>` +
          `<pre class="eb-code-body"><code class="language-${escAttr(langSlug)}">${rowHtml.join('\n')}</code></pre>` +
        `</div>`
      );
    }

    function renderDebriefSpecCard(data, opts) {
      const learned = Array.isArray(data.learned)
        ? data.learned
        : Array.isArray(data.learnings)
          ? data.learnings
          : [];
      const frustrations = Array.isArray(data.frustrations) ? data.frustrations : [];
      const ideas = Array.isArray(data.ideas) ? data.ideas : [];
      const taste = Array.isArray(data.taste) ? data.taste : [];
      const did = typeof data.did === 'string' ? data.did.trim() : '';
      const profile = typeof data.profile === 'string' ? data.profile.trim() : '';
      const project = typeof data.project === 'string' ? data.project.trim() : '';
      const harness = typeof data.harness === 'string' ? data.harness.trim() : '';

      const counts = [];
      if (learned.length) counts.push(`${learned.length} learned`);
      if (frustrations.length) counts.push(`${frustrations.length} frustrations`);
      if (ideas.length) counts.push(`${ideas.length} ideas`);
      if (taste.length) counts.push(`${taste.length} taste`);
      const countSummary = counts.length ? counts.join(' \u00b7 ') : 'summary';

      const sections = [];
      if (did) {
        sections.push(
          `<div class="eb-spec-did"><span class="eb-spec-k">Did</span><span class="eb-spec-v">${renderSafeInline(did)}</span></div>`
        );
      }

      const listDefs = [
        { key: 'learned', title: 'Learned', items: learned },
        { key: 'frustrations', title: 'Frustrations', items: frustrations },
        { key: 'ideas', title: 'Ideas', items: ideas },
        { key: 'taste', title: 'Taste', items: taste },
      ];

      for (let i = 0; i < listDefs.length; i += 1) {
        const def = listDefs[i];
        if (!def.items.length) continue;
        const liHtml = def.items
          .map(function (entry) {
            const text =
              typeof entry === 'string'
                ? entry
                : entry && typeof entry === 'object'
                  ? entry.preference || entry.summary || entry.text || JSON.stringify(entry)
                  : String(entry == null ? '' : entry);
            return `<li>${renderSafeInline(text)}</li>`;
          })
          .join('');
        sections.push(
          `<div class="eb-spec-section is-${def.key}">` +
            `<div class="eb-spec-section-title">${escHtml(def.title)} <span class="eb-spec-count">${def.items.length}</span></div>` +
            `<ul class="eb-spec-list is-${def.key}">${liHtml}</ul>` +
          `</div>`
        );
      }

      const metaChips = [];
      if (project) metaChips.push(`<span class="eb-meta-pill is-project">${escHtml(project)}</span>`);
      if (profile) metaChips.push(renderMentionChip(profile));
      if (harness) metaChips.push(`<span class="eb-meta-pill is-harness">${escHtml(harness)}</span>`);

      const openAttr = opts && opts.compact ? '' : ' open';
      return (
        `<details class="eb-spec-card is-debrief" data-eb-spec="session-debrief@1"${openAttr}>` +
          `<summary class="eb-spec-summary">` +
            `<span class="eb-spec-summary-left">` +
              `<span class="eb-meta-pill is-debrief">DEBRIEF SPEC</span>` +
              `<span class="eb-spec-counts">${escHtml(countSummary)}</span>` +
            `</span>` +
            `<span class="eb-spec-summary-right">${metaChips.join('')}</span>` +
          `</summary>` +
          `<div class="eb-spec-body">${sections.join('')}</div>` +
        `</details>`
      );
    }

    function renderTasteSpecCard(data, opts) {
      const preference = typeof data.preference === 'string' ? data.preference.trim() : '';
      const evidence = typeof data.evidence === 'string' ? data.evidence.trim() : '';
      const confidenceRaw = typeof data.confidence === 'string' ? data.confidence.trim().toLowerCase() : '';
      const confidence =
        confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
          ? confidenceRaw
          : confidenceRaw
            ? sanitizeSlug(confidenceRaw, 'medium')
            : '';
      const source = typeof data.source === 'string' ? data.source.trim() : '';
      const domain = typeof data.domain === 'string' ? data.domain.trim() : '';

      const chips = [];
      if (confidence) {
        chips.push(
          `<span class="eb-confidence-chip is-${escAttr(confidence)}">${escHtml(confidence.toUpperCase())}</span>`
        );
      }
      if (domain) {
        chips.push(`<span class="eb-meta-pill is-domain">${escHtml(domain)}</span>`);
      }

      const bodyParts = [];
      if (preference) {
        bodyParts.push(
          `<div class="eb-taste-pref"><span class="eb-spec-k">Preference</span><div class="eb-taste-pref-val">${renderSafeInline(preference)}</div></div>`
        );
      }
      if (evidence) {
        bodyParts.push(
          `<blockquote class="eb-taste-evidence"><span class="eb-spec-k">Evidence</span><p>${renderSafeInline(evidence)}</p></blockquote>`
        );
      }
      if (source) {
        bodyParts.push(
          `<div class="eb-taste-source"><span class="eb-spec-k">Source</span><span class="eb-spec-v">${renderSafeInline(source)}</span></div>`
        );
      }

      const openAttr = opts && opts.compact ? '' : ' open';
      return (
        `<details class="eb-spec-card is-taste" data-eb-spec="taste@1"${openAttr}>` +
          `<summary class="eb-spec-summary">` +
            `<span class="eb-spec-summary-left">` +
              `<span class="eb-meta-pill is-taste">TASTE RULE</span>` +
              (preference
                ? `<span class="eb-spec-preview">${escHtml(truncateWordBoundary(humanizeMentionsText(preference), 72))}</span>`
                : '') +
            `</span>` +
            `<span class="eb-spec-summary-right">${chips.join('')}</span>` +
          `</summary>` +
          `<div class="eb-spec-body">${bodyParts.join('')}</div>` +
        `</details>`
      );
    }

    function renderFenceSegment(seg, opts) {
      const info = String(seg.info || '').trim();
      const lowerInfo = info.toLowerCase();

      if (lowerInfo === 'json#session-debrief@1' || lowerInfo.startsWith('json#session-debrief')) {
        try {
          const parsed = JSON.parse(seg.code);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { html: renderDebriefSpecCard(parsed, opts), isStructured: true };
          }
        } catch {
          // Fall through to safe code block on malformed JSON
        }
      }

      if (lowerInfo === 'json#taste@1' || lowerInfo.startsWith('json#taste')) {
        try {
          const parsed = JSON.parse(seg.code);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { html: renderTasteSpecCard(parsed, opts), isStructured: true };
          }
        } catch {
          // Fall through to safe code block on malformed JSON
        }
      }

      if (isUnifiedDiffBlock(info, seg.code)) {
        return { html: renderDiffBlock(seg.code, opts), isStructured: true };
      }

      return { html: renderCodeBlock(info, seg.code, opts), isStructured: true };
    }

    function extractStructuredPrefix(rawText) {
      const text = stripEmDash(rawText || '').replace(/\r\n?/g, '\n');
      const trimmedLead = text.replace(/^\s+/, '');
      const badges = [];
      let remainder = trimmedLead;
      let headerHtml = '';
      let isStructured = false;
      let isLint = false;
      let dreamDate = null;

      // 1. [RSI HIGH|MEDIUM|LOW / <category>]
      const rsiMatch = /^\[RSI\s+(HIGH|MEDIUM|LOW)\s*\/\s*([^\]]+)\]\s*/i.exec(trimmedLead);
      if (rsiMatch) {
        const sev = rsiMatch[1].toUpperCase();
        const sevLow = sev.toLowerCase();
        const cat = rsiMatch[2].trim();
        const sevPill = `<span class="eb-meta-pill is-rsi-${sevLow}">RSI ${escHtml(sev)}</span>`;
        const catPill = `<span class="eb-meta-pill is-rsi-cat">${escHtml(cat)}</span>`;
        badges.push({ kind: 'rsi', label: `RSI ${sev}`, tone: sevLow, html: sevPill });
        badges.push({ kind: 'rsi-category', label: cat, tone: 'neutral', html: catPill });
        remainder = trimmedLead.slice(rsiMatch[0].length);
        isStructured = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      // 2. run <taskId>-<round> on <seat> (<model>): <status>, <duration>, exit <code>
      const runMatch =
        /^run\s+([a-zA-Z0-9._-]+)\s+on\s+([a-zA-Z0-9._-]+)(?:\s*\(([^)]+)\))?\s*:\s*([^,\n]+),\s*([0-9]+(?:\.[0-9]+)?(?:ms|s|m(?:\d+s)?|h(?:\d+m)?)),\s*exit\s+(-?\d+)(?:\s*;\s*([^\n]*))?/i.exec(
          trimmedLead
        );
      if (runMatch) {
        const runId = runMatch[1].trim();
        const seat = runMatch[2].trim();
        const model = (runMatch[3] || '').trim();
        const status = runMatch[4].trim();
        const duration = runMatch[5].trim();
        const exitCode = Number(runMatch[6]);
        const tail = (runMatch[7] || '').trim();
        const seatMeta = resolveAgentBrand(seat, '');
        const exitOk = exitCode === 0;
        const exitCls = exitOk ? 'is-ok' : 'is-fail';

        // Extract optional worktree / branch from the trailing clause
        let worktree = '';
        let branch = '';
        let leftoverTail = tail;
        const wtMatch = /worked in\s+([^\s();,]+)/i.exec(tail);
        if (wtMatch && wtMatch[1]) {
          worktree = wtMatch[1].trim();
        }
        const brMatch = /\bbranch[:=\s]+([a-zA-Z0-9._/-]+)/i.exec(tail);
        if (brMatch && brMatch[1]) {
          branch = brMatch[1].trim();
        }
        if (worktree && /^worked in\s+\S+(?:\s*\([^)]*\))?\.?$/i.test(tail)) {
          leftoverTail = '';
        }

        const runTaskNum = /^(\d+)-\d+$/.exec(runId);
        const runIdHtml = runTaskNum
          ? `<button type="button" class="eb-run-id eb-thread-ref" data-eb-open-thread="${escAttr(runTaskNum[1])}" title="Open task #${escAttr(runTaskNum[1])}">run ${escHtml(runId)}</button>`
          : `<span class="eb-run-id">run ${escHtml(runId)}</span>`;

        const seatHtml =
          `<button type="button" class="eb-run-seat is-${seatMeta.brand}" data-eb-mention-filter="${escAttr(seat)}" title="Seat ${escAttr(seat)}">` +
          `<span class="eb-mention-glyph" aria-hidden="true">${seatMeta.glyphHtml}</span>` +
          `<span>${escHtml(seat)}</span></button>`;

        const modelHtml = model
          ? `<span class="eb-run-model" title="Model ${escAttr(model)}">${escHtml(model)}</span>`
          : '';
        const statusHtml = `<span class="eb-run-status">${escHtml(status)}</span>`;
        const durHtml = `<span class="eb-run-duration">${escHtml(duration)}</span>`;
        const exitHtml = `<span class="eb-run-exit ${exitCls}">exit ${escHtml(String(exitCode))}</span>`;

        const locTag = branch || (worktree ? shortenPath(worktree) : '');
        const locHtml = locTag
          ? `<button type="button" class="eb-run-worktree" data-eb-artifact-action="copyPath" ` +
            `data-eb-artifact-target="${escAttr(worktree || branch)}" ` +
            `data-eb-copy-text="${escAttr(worktree || branch)}" ` +
            `title="${escAttr(worktree || branch)}">${escHtml(locTag)}</button>`
          : '';

        headerHtml =
          `<div class="eb-run-strip ${exitCls}" data-eb-run-id="${escAttr(runId)}" data-eb-exit="${escAttr(String(exitCode))}">` +
            `<div class="eb-run-strip-main">${runIdHtml}${seatHtml}${modelHtml}${statusHtml}${durHtml}${exitHtml}</div>` +
            (locHtml ? `<div class="eb-run-strip-meta">${locHtml}</div>` : '') +
          `</div>`;

        badges.push({ kind: 'run', label: `run ${runId}`, tone: exitOk ? 'ok' : 'fail', html: exitHtml });
        badges.push({ kind: 'seat', label: seat, tone: seatMeta.brand, html: seatHtml });

        const afterMatch = trimmedLead.slice(runMatch[0].length).replace(/^\n+/, '');
        remainder = [leftoverTail, afterMatch].filter(Boolean).join('\n');
        isStructured = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      // 3. debrief <profile> [<project>]: <summary>
      const debriefMatch = /^debrief\s+([a-zA-Z0-9._-]+)(?:\s+\[([^\]]+)\])?\s*:\s*/i.exec(trimmedLead);
      if (debriefMatch) {
        const profile = debriefMatch[1].trim();
        const project = (debriefMatch[2] || '').trim();
        const debriefPill = '<span class="eb-meta-pill is-debrief">DEBRIEF</span>';
        badges.push({ kind: 'debrief', label: 'DEBRIEF', tone: 'debrief', html: debriefPill });
        if (project) {
          const projPill = `<span class="eb-meta-pill is-project">${escHtml(project)}</span>`;
          badges.push({ kind: 'project', label: project, tone: 'neutral', html: projPill });
        }
        const profChip = renderMentionChip(profile);
        badges.push({ kind: 'profile', label: profile, tone: 'agent', html: profChip });
        remainder = trimmedLead.slice(debriefMatch[0].length);
        isStructured = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      // 4. dream YYYY-MM-DD:
      const dreamMatch = /^dream\s+(\d{4}-\d{2}-\d{2})\s*:\s*/i.exec(trimmedLead);
      if (dreamMatch) {
        const dateStr = dreamMatch[1];
        dreamDate = dateStr;
        const dreamPill = '<span class="eb-meta-pill is-dream">DREAM</span>';
        const datePill =
          `<button type="button" class="eb-meta-pill is-dream-date eb-mind-pill is-replay" ` +
          `data-eb-mind-view="replay" data-eb-mind-target="${escAttr(dateStr)}" ` +
          `data-eb-mind-kind="replay" title="Open Replay day ${escAttr(dateStr)}">` +
          `${MIND_KINDS.replay.icon}<span>${escHtml(dateStr)}</span></button>`;
        badges.push({ kind: 'dream', label: 'DREAM', tone: 'dream', html: dreamPill });
        badges.push({ kind: 'dream-date', label: dateStr, date: dateStr, tone: 'replay', html: datePill });
        remainder = trimmedLead.slice(dreamMatch[0].length);
        isStructured = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      // 5. taste: <preference>
      const tasteMatch = /^taste\s*:\s*/i.exec(trimmedLead);
      if (tasteMatch) {
        const tastePill = '<span class="eb-meta-pill is-taste">TASTE</span>';
        badges.push({ kind: 'taste', label: 'TASTE', tone: 'taste', html: tastePill });
        remainder = trimmedLead.slice(tasteMatch[0].length);
        isStructured = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      // 6. ab lint:
      const lintMatch = /^ab\s+lint\s*:\s*/i.exec(trimmedLead);
      if (lintMatch) {
        const lintPill = '<span class="eb-meta-pill is-lint">AB LINT</span>';
        badges.push({ kind: 'lint', label: 'AB LINT', tone: 'warn', html: lintPill });
        remainder = trimmedLead.slice(lintMatch[0].length);
        isStructured = true;
        isLint = true;
        return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
      }

      return { badges, headerHtml, remainder, isStructured, isLint, dreamDate };
    }

    function renderProseSegment(rawText) {
      const text = stripEmDash(rawText || '').replace(/\r\n?/g, '\n');
      if (!text.trim()) return { html: '', hasStructure: false };

      const lines = text.split('\n');
      const blocks = [];
      let paraLines = [];
      let listItems = [];
      let quoteLines = [];
      let hasStructure = false;

      function flushPara() {
        if (!paraLines.length) return;
        blocks.push(`<p class="eb-rich-p">${paraLines.map(renderSafeInline).join('<br>')}</p>`);
        paraLines = [];
      }

      function flushList() {
        if (!listItems.length) return;
        blocks.push(
          `<ul class="eb-rich-list">${listItems.map((li) => `<li>${renderSafeInline(li)}</li>`).join('')}</ul>`
        );
        listItems = [];
      }

      function flushQuote() {
        if (!quoteLines.length) return;
        blocks.push(
          `<blockquote class="eb-rich-quote">${quoteLines.map(renderSafeInline).join('<br>')}</blockquote>`
        );
        quoteLines = [];
      }

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
          flushPara();
          flushList();
          flushQuote();
          continue;
        }

        // Heading (# .. ###)
        const hMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
        if (hMatch) {
          flushPara();
          flushList();
          flushQuote();
          const lvl = Math.min(4, hMatch[1].length + 2);
          blocks.push(`<h${lvl} class="eb-rich-heading">${renderSafeInline(hMatch[2])}</h${lvl}>`);
          continue;
        }

        // Bullet list item
        const liMatch = /^[-*]\s+(.+)$/.exec(trimmed);
        if (liMatch) {
          flushPara();
          flushQuote();
          listItems.push(liMatch[1]);
          continue;
        }

        // Blockquote
        const qMatch = /^>\s?(.*)$/.exec(trimmed);
        if (qMatch) {
          flushPara();
          flushList();
          quoteLines.push(qMatch[1]);
          continue;
        }

        // Structured section header (learned:, frustrations:, ideas:, taste:)
        const secMatch = SECTION_HEAD_RE.exec(trimmed);
        if (secMatch) {
          flushPara();
          flushList();
          flushQuote();
          hasStructure = true;
          blocks.push(
            `<div class="eb-section-label">${escHtml(secMatch[1].trim())}</div>`
          );
          continue;
        }

        // Structured key-value line (goal:, done-check:, sources:, risk-classification:)
        const kvMatch = KV_KEY_RE.exec(trimmed);
        if (kvMatch) {
          flushPara();
          flushList();
          flushQuote();
          hasStructure = true;
          blocks.push(
            `<div class="eb-kv-row">` +
              `<span class="eb-kv-key">${escHtml(kvMatch[1].toLowerCase())}</span>` +
              `<span class="eb-kv-val">${renderSafeInline(kvMatch[2])}</span>` +
            `</div>`
          );
          continue;
        }

        flushList();
        flushQuote();
        paraLines.push(trimmed);
      }

      flushPara();
      flushList();
      flushQuote();

      return { html: blocks.join(''), hasStructure };
    }

    function shortenPath(pathStr) {
      const s = String(pathStr || '').trim();
      if (s.length <= 36) return s;
      const parts = s.split('/').filter(Boolean);
      if (parts.length <= 2) return s;
      return `.../${parts.slice(-2).join('/')}`;
    }

    function extractArtifacts(rawText, item) {
      const text = stripEmDash(rawText || '');
      const seen = new Set();
      const candidates = [];

      function pushArtifact(kind, label, target, action) {
        const key = `${kind}:${target}`;
        if (!target || seen.has(key)) return;
        seen.add(key);
        candidates.push({ kind, label, target, action });
      }

      // 1. Collect strict http(s) URLs first and mask them so URL paths aren't misread as local files
      let masked = text.replace(/https?:\/\/[^\s<>()\[\]"'`]+/gi, function (match) {
        const clean = cleanUrlTail(match);
        if (isSafeHttpUrl(clean)) {
          let label = clean;
          try {
            const u = new URL(clean);
            const pathPart = u.pathname && u.pathname !== '/' ? u.pathname : '';
            label = u.host + (pathPart.length > 24 ? `${pathPart.slice(0, 21)}...` : pathPart);
          } catch {
            label = clean.slice(0, 36);
          }
          pushArtifact('url', label, clean, 'openExternal');
        }
        return ' '.repeat(match.length);
      });

      // Also check explicit item.links if present
      if (item && Array.isArray(item.links)) {
        for (let i = 0; i < item.links.length; i += 1) {
          const link = item.links[i];
          const url = typeof link === 'string' ? link : link && (link.url || link.href);
          if (typeof url === 'string') {
            const clean = cleanUrlTail(url);
            if (isSafeHttpUrl(clean)) {
              let label = (link && link.label) || clean;
              if (label === clean) {
                try {
                  label = new URL(clean).host;
                } catch {
                  label = clean.slice(0, 32);
                }
              }
              pushArtifact('url', label, clean, 'openExternal');
            }
          }
        }
      }

      // 2. Local & vault file paths (workspace/..., ~/..., world/...md)
      const pathRe =
        /(?:^|[\s(\["'`:,;])((?:\/(?:data|home|workspace|etc|var|opt|srv)\/[a-zA-Z0-9._/+@-]+|~\/[a-zA-Z0-9._/+@-]+|world\/[a-zA-Z0-9._/-]+\.md))/g;
      masked = masked.replace(pathRe, function (full, rawPath) {
        const clean = rawPath.replace(/[.,;:!?\]})]+$/, '');
        if (clean.length < 5) return full;
        const isDoc = /\.md$/i.test(clean);
        pushArtifact(
          isDoc ? 'doc' : 'path',
          shortenPath(clean),
          clean,
          isDoc ? 'openDoc' : 'copyPath'
        );
        return ' '.repeat(full.length);
      });

      // 3. Commit SHAs (explicit commit/sha prefix or standalone 7-40 hex with mixed digits+letters)
      const explicitCommitRe = /\b(?:commit|sha|rev|cherry-pick)\s+([0-9a-f]{7,40})\b/gi;
      let cm;
      while ((cm = explicitCommitRe.exec(masked)) !== null) {
        const sha = cm[1].toLowerCase();
        pushArtifact('commit', sha.slice(0, 7), sha, 'copyPath');
      }

      const bareCommitRe = /(?:^|[\s(\[,;:])([0-9a-f]{7,40})(?=$|[\s)\],;:.])/g;
      while ((cm = bareCommitRe.exec(masked)) !== null) {
        const sha = cm[1];
        if (/[0-9]/.test(sha) && /[a-f]/.test(sha) && !/^\d+$/.test(sha)) {
          pushArtifact('commit', sha.slice(0, 7), sha, 'copyPath');
        }
      }

      // Prioritize docs -> urls -> paths -> commits, cap at MAX_ARTIFACTS (4)
      const rank = { doc: 0, url: 1, path: 2, commit: 3 };
      candidates.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
      const limited = candidates.slice(0, MAX_ARTIFACTS);

      return limited.map(function (art) {
        let html = '';
        if (art.action === 'openExternal' && isSafeHttpUrl(art.target)) {
          html =
            `<a class="eb-artifact-pill is-${art.kind}" href="${escAttr(art.target)}" ` +
            `target="_blank" rel="noopener noreferrer" ` +
            `data-eb-artifact-action="openExternal" data-eb-artifact-kind="${escAttr(art.kind)}" ` +
            `data-eb-artifact-target="${escAttr(art.target)}" title="${escAttr(art.target)}">` +
            `<span class="eb-artifact-tag">LINK</span>` +
            `<span class="eb-artifact-label">${escHtml(art.label)}</span>` +
            `</a>`;
        } else {
          const tag = art.kind === 'doc' ? 'DOC' : art.kind === 'commit' ? 'SHA' : 'PATH';
          const copyAttr =
            art.action === 'copyPath' ? ` data-eb-copy-text="${escAttr(art.target)}"` : '';
          html =
            `<button type="button" class="eb-artifact-pill is-${art.kind}" ` +
            `data-eb-artifact-action="${escAttr(art.action)}" ` +
            `data-eb-artifact-kind="${escAttr(art.kind)}" ` +
            `data-eb-artifact-target="${escAttr(art.target)}"${copyAttr} ` +
            `title="${escAttr(art.target)}">` +
            `<span class="eb-artifact-tag">${tag}</span>` +
            `<span class="eb-artifact-label">${escHtml(art.label)}</span>` +
            `</button>`;
        }
        return Object.assign({}, art, { html });
      });
    }

    function normalizeMindLinks(item, dreamDate) {
      const rawList = item && Array.isArray(item.mindLinks) ? item.mindLinks : [];
      const seen = new Set();
      const out = [];

      function addLink(raw) {
        if (!raw || typeof raw !== 'object') return;
        const rawKind = String(raw.kind || raw.type || 'vault').trim().toLowerCase();
        const kind = Object.prototype.hasOwnProperty.call(MIND_KINDS, rawKind) ? rawKind : 'vault';
        const def = MIND_KINDS[kind];
        const target = stripEmDash(
          raw.target != null
            ? raw.target
            : raw.id != null
              ? raw.id
              : raw.path != null
                ? raw.path
                : raw.slug != null
                  ? raw.slug
                  : raw.date != null
                    ? raw.date
                    : raw.sha || ''
        ).trim();
        if (!target) return;
        const key = `${kind}:${target}`;
        if (seen.has(key)) return;
        seen.add(key);

        const view = sanitizeSlug(raw.view || raw.targetView || def.defaultView, def.defaultView);
        const label = stripEmDash(raw.label || raw.title || raw.name || target).trim();
        const tooltip = stripEmDash(
          raw.tooltip || raw.reason || raw.subtitle || `${def.prefix}: ${label}`
        ).trim();

        const html =
          `<button type="button" class="eb-mind-pill is-${kind}" ` +
          `data-eb-mind-view="${escAttr(view)}" ` +
          `data-eb-mind-target="${escAttr(target)}" ` +
          `data-eb-mind-kind="${escAttr(kind)}" ` +
          `title="${escAttr(tooltip)}">` +
          `<span class="eb-mind-pill-icon" aria-hidden="true">${def.icon}</span>` +
          `<span class="eb-mind-pill-prefix">${escHtml(def.prefix)}</span>` +
          `<span class="eb-mind-pill-label">${escHtml(label)}</span>` +
          `</button>`;

        out.push({ kind, view, target, label, tooltip, html });
      }

      for (let i = 0; i < rawList.length; i += 1) {
        addLink(rawList[i]);
      }

      if (dreamDate && !seen.has(`replay:${dreamDate}`)) {
        addLink({
          kind: 'replay',
          view: 'replay',
          target: dreamDate,
          label: `Replay ${dreamDate}`,
          tooltip: `Open Replay for ${dreamDate}`,
        });
      }

      return out;
    }

    function truncateWordBoundary(text, maxLen) {
      const clean = stripEmDash(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return '';
      if (clean.length <= maxLen) return clean;
      const slice = clean.slice(0, maxLen);
      const lastSpace = slice.lastIndexOf(' ');
      const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
      return `${cut.replace(/[,;:.\-/\s]+$/, '')}...`;
    }

    function isLongMessageBody(rawText) {
      const normalized = stripEmDash(rawText || '').replace(/\r\n?/g, '\n').trim();
      if (!normalized) return false;
      const lineCount = normalized.split('\n').length;
      return normalized.length > 320 || lineCount > 5;
    }

    function extractExecSummaryAndKv(rawText) {
      const normalized = stripEmDash(rawText || '').replace(/\r\n?/g, '\n').trim();
      const lines = normalized ? normalized.split('\n') : [];
      let goal = '';
      let doneCheck = '';
      const previewLines = [];
      let inFence = false;

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence || !trimmed) continue;

        const cleanLine = trimmed.replace(/^[-*]\s+/, '').replace(/^\*\*([^*]+)\*\*/, '$1').trim();
        const goalMatch = /^goal\s*:\s*(.+)$/i.exec(cleanLine);
        if (goalMatch && goalMatch[1]) {
          if (!goal) goal = goalMatch[1].trim();
          continue;
        }
        const doneMatch = /^(?:done[-_\s]?check|verification)\s*:\s*(.+)$/i.exec(cleanLine);
        if (doneMatch && doneMatch[1]) {
          if (!doneCheck) doneCheck = doneMatch[1].trim();
          continue;
        }
        if (SECTION_HEAD_RE.test(cleanLine)) continue;

        const proseCandidate = trimmed.replace(/^#{1,4}\s+/, '').replace(/^>\s?/, '').trim();
        if (proseCandidate && previewLines.length < 3) {
          previewLines.push(proseCandidate);
        }
      }

      const previewJoined = previewLines.join(' ').trim();
      const previewText = previewJoined
        ? truncateWordBoundary(previewJoined, 240)
        : truncateWordBoundary(normalized.replace(/```[\s\S]*?```/g, ' '), 220);

      return {
        goal,
        doneCheck,
        previewLines: previewLines.slice(0, 3),
        previewText,
        lineCount: lines.length,
        charCount: normalized.length,
      };
    }

    function renderExecKvTableHtml(goal, doneCheck) {
      if (!goal && !doneCheck) return '';
      const cells = [];
      if (goal) {
        cells.push(
          `<div class="eb-exec-kv-cell" role="cell">` +
            `<span class="eb-exec-kv-label">GOAL</span>` +
            `<span class="eb-exec-kv-val">${renderSafeInline(truncateWordBoundary(goal, 140))}</span>` +
          `</div>`
        );
      }
      if (doneCheck) {
        cells.push(
          `<div class="eb-exec-kv-cell" role="cell">` +
            `<span class="eb-exec-kv-label">DONE-CHECK</span>` +
            `<span class="eb-exec-kv-val">${renderSafeInline(truncateWordBoundary(doneCheck, 140))}</span>` +
          `</div>`
        );
      }
      const singleCls = cells.length === 1 ? ' is-single' : '';
      return (
        `<div class="eb-exec-kv-table${singleCls}" role="table" aria-label="Task specification">` +
          cells.join('') +
        `</div>`
      );
    }

    function renderRichMessage(item, opts) {
      const options = opts && typeof opts === 'object' ? opts : {};
      const obj = typeof item === 'string' ? { text: item } : item && typeof item === 'object' ? item : {};
      const rawText = String(
        obj.text != null
          ? obj.text
          : obj.body != null
            ? obj.body
            : obj.content != null
              ? obj.content
              : obj.message != null
                ? obj.message
                : ''
      );

      const prefix = extractStructuredPrefix(rawText);
      const segments = splitFencedBlocks(prefix.remainder);
      let isStructured = prefix.isStructured;

      const bodyParts = [];
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        if (seg.type === 'fence') {
          const rendered = renderFenceSegment(seg, options);
          if (rendered.html) bodyParts.push(rendered.html);
          if (rendered.isStructured) isStructured = true;
        } else {
          const rendered = renderProseSegment(seg.text);
          if (rendered.html) bodyParts.push(rendered.html);
          if (rendered.hasStructure) isStructured = true;
        }
      }

      const mindLinks = normalizeMindLinks(obj, prefix.dreamDate);
      const artifacts = extractArtifacts(rawText, obj);

      const parts = [];
      if (options.includeBadges !== false && prefix.headerHtml) {
        parts.push(prefix.headerHtml);
      } else if (options.includeBadges !== false && prefix.badges.length) {
        parts.push(
          `<div class="eb-meta-pill-row">${prefix.badges.map((b) => b.html).join('')}</div>`
        );
      }

      const bodyJoined = bodyParts.join('');
      const normalizedRaw = stripEmDash(rawText).replace(/\r\n?/g, '\n').trim();
      const lineCount = normalizedRaw ? normalizedRaw.split('\n').length : 0;
      const charCount = normalizedRaw.length;
      const shouldCollapse = Boolean(options.collapsible && isLongMessageBody(rawText) && bodyJoined);

      if (shouldCollapse) {
        const exec = extractExecSummaryAndKv(prefix.remainder || rawText);
        const expanded = Boolean(options.expanded);
        const kvTableHtml = renderExecKvTableHtml(exec.goal, exec.doneCheck);
        const previewInner = exec.previewLines.length
          ? exec.previewLines.map((l) => `<p class="eb-rich-p">${renderSafeInline(truncateWordBoundary(l, 150))}</p>`).join('')
          : `<p class="eb-rich-p">${renderSafeInline(exec.previewText)}</p>`;
        const fullBlockHtml = prefix.isLint
          ? `<div class="eb-lint-callout">${bodyJoined}</div>`
          : `<div class="eb-rich-body">${bodyJoined}</div>`;
        const logKey = String(
          options.logKey || obj.threadId || obj.id || obj.numericId || obj.eventId || ''
        ).trim();

        parts.push(
          `<div class="eb-collapsible-body${expanded ? ' is-expanded' : ''}" data-eb-collapsible="true" data-eb-expanded="${expanded ? 'true' : 'false'}"${logKey ? ` data-eb-log-key="${escAttr(logKey)}"` : ''}>` +
            `<div class="eb-collapsible-summary">` +
              `<div class="eb-exec-preview">${previewInner}</div>` +
              `${kvTableHtml}` +
            `</div>` +
            `<div class="eb-collapsible-panel" aria-hidden="${expanded ? 'false' : 'true'}">` +
              `<div class="eb-collapsible-inner">${fullBlockHtml}</div>` +
            `</div>` +
            `<button type="button" class="eb-collapsible-toggle" data-action="toggle-expand-log"${logKey ? ` data-eb-log-key="${escAttr(logKey)}"` : ''} aria-expanded="${expanded ? 'true' : 'false'}">` +
              `<span class="eb-collapsible-toggle-label">${expanded ? 'Collapse' : 'Expand full log'}</span>` +
              `<span class="eb-collapsible-toggle-meta">${escHtml(`${lineCount} lines · ${charCount} chars`)}</span>` +
            `</button>` +
          `</div>`
        );
      } else if (bodyJoined) {
        if (prefix.isLint) {
          parts.push(`<div class="eb-lint-callout">${bodyJoined}</div>`);
        } else {
          parts.push(`<div class="eb-rich-body">${bodyJoined}</div>`);
        }
      } else if (!parts.length) {
        parts.push('<div class="eb-rich-body"><p class="eb-rich-p eb-rich-empty">(empty message)</p></div>');
      }

      if (options.includeMindLinks !== false && mindLinks.length) {
        parts.push(
          `<div class="eb-mind-pills" aria-label="Kizuki Mind links">` +
            mindLinks.map((m) => m.html).join('') +
          `</div>`
        );
      }

      if (options.includeArtifacts !== false && artifacts.length) {
        parts.push(
          `<div class="eb-artifact-strip" aria-label="Attached artifacts">` +
            artifacts.map((a) => a.html).join('') +
          `</div>`
        );
      }

      const rootCls = `eb-rich-message${isStructured ? ' is-structured' : ''}${options.compact ? ' is-compact' : ''}${shouldCollapse ? ' is-collapsible' : ''}`;
      return {
        html: `<div class="${rootCls}">${parts.join('')}</div>`,
        badges: prefix.badges,
        artifacts,
        mindLinks,
        isStructured,
        isCollapsible: shouldCollapse,
        lineCount,
        charCount,
      };
    }

    function renderSignalBadge(signal) {
      if (!signal) return '';
      const raw =
        typeof signal === 'string'
          ? signal
          : typeof signal === 'object'
            ? signal.signalKind || signal.kind || signal.type || signal.signal || signal.label || ''
            : String(signal);
      const clean = stripEmDash(raw).trim();
      if (!clean) return '';

      const key = clean.toLowerCase();
      const mapped = SIGNAL_MAP[key];
      const slug = mapped ? mapped.slug : sanitizeSlug(clean, 'signal');
      const label = mapped
        ? mapped.label
        : typeof signal === 'object' && signal.label
          ? stripEmDash(signal.label).trim()
          : clean.charAt(0).toUpperCase() + clean.slice(1);

      return (
        `<span class="eb-signal-badge is-${escAttr(slug)}" data-eb-signal="${escAttr(slug)}">` +
          `<span class="eb-signal-dot" aria-hidden="true"></span>` +
          `${escHtml(label)}` +
        `</span>`
      );
    }

    function formatTelemetrySummary(summary) {
      if (!summary) return { text: '', computedCount: 0 };
      if (typeof summary === 'string') {
        return { text: stripEmDash(summary).trim(), computedCount: 0 };
      }
      if (Array.isArray(summary)) {
        let total = 0;
        const parts = [];
        for (let i = 0; i < summary.length; i += 1) {
          const entry = summary[i];
          if (typeof entry === 'string') {
            const s = stripEmDash(entry).trim();
            if (s) parts.push(s);
          } else if (entry && typeof entry === 'object') {
            const c = Number(entry.count || 0);
            const label = stripEmDash(entry.label || entry.name || entry.kind || '').trim();
            if (Number.isFinite(c) && c > 0 && label) {
              total += c;
              parts.push(`${c} ${label}`);
            }
          }
        }
        return { text: parts.join(' \u00b7 '), computedCount: total };
      }
      if (typeof summary === 'object') {
        if (typeof summary.text === 'string' && summary.text.trim()) {
          return { text: stripEmDash(summary.text).trim(), computedCount: Number(summary.total || 0) || 0 };
        }
        if (typeof summary.summary === 'string' && summary.summary.trim()) {
          return { text: stripEmDash(summary.summary).trim(), computedCount: Number(summary.total || 0) || 0 };
        }
        if (Array.isArray(summary.categories)) {
          return formatTelemetrySummary(summary.categories);
        }
        const labelMap = {
          wakePings: 'wake pings',
          wake_pings: 'wake pings',
          wake: 'wake pings',
          fleetHealth: 'fleet health',
          fleet_health: 'fleet health',
          health: 'fleet health',
          tickerAlerts: 'ticker alerts',
          ticker_alerts: 'ticker alerts',
          ticker: 'ticker alerts',
          heartbeats: 'heartbeats',
          pings: 'pings',
        };
        let total = 0;
        const parts = [];
        const keys = Object.keys(summary);
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i];
          if (k === 'total' || k === 'count') continue;
          const v = Number(summary[k]);
          if (Number.isFinite(v) && v > 0) {
            total += v;
            const label = labelMap[k] || stripEmDash(k).replace(/[_-]+/g, ' ');
            parts.push(`${v} ${label}`);
          }
        }
        return { text: parts.join(' \u00b7 '), computedCount: total };
      }
      return { text: '', computedCount: 0 };
    }

    function renderTelemetryRibbon(telemetrySummary, telemetryCount, activeFilter) {
      const modeRaw = String(activeFilter || 'signal').trim().toLowerCase();
      const mode = modeRaw === 'all' || modeRaw === 'telemetry' ? modeRaw : 'signal';
      const parsed = formatTelemetrySummary(telemetrySummary);
      const countNum = Number.isFinite(Number(telemetryCount))
        ? Math.max(0, Math.floor(Number(telemetryCount)))
        : parsed.computedCount;
      const summaryText =
        parsed.text || (countNum > 0 ? `${countNum} telemetry events` : 'Quiet channel');

      const expanded = mode !== 'signal';
      const rollupBtn =
        countNum > 0
          ? `<button type="button" class="eb-telemetry-rollup-btn${expanded ? ' is-expanded' : ''}" ` +
            `data-eb-toggle-telemetry="${expanded ? '0' : '1'}" ` +
            `data-eb-stream-filter="${expanded ? 'signal' : 'all'}" ` +
            `aria-expanded="${expanded ? 'true' : 'false'}" ` +
            `title="${escAttr(summaryText)}">` +
              `<span class="eb-telemetry-rollup-dot" aria-hidden="true"></span>` +
              `<span class="eb-telemetry-rollup-text">${escHtml(summaryText)}</span>` +
              `<span class="eb-telemetry-rollup-cta">${expanded ? 'Hide' : `Show ${countNum}`}</span>` +
            `</button>`
          : `<span class="eb-telemetry-quiet">${escHtml(summaryText)}</span>`;

      return (
        `<div class="eb-telemetry-ribbon" data-eb-active-filter="${escAttr(mode)}" role="region" aria-label="Signal and telemetry filter">` +
          `<div class="eb-ribbon-tabs" role="tablist" aria-label="Stream filter">` +
            `<button type="button" class="eb-ribbon-tab${mode === 'signal' ? ' is-active' : ''}" ` +
              `role="tab" aria-selected="${mode === 'signal' ? 'true' : 'false'}" ` +
              `data-eb-stream-filter="signal">Signal</button>` +
            `<button type="button" class="eb-ribbon-tab${mode === 'all' ? ' is-active' : ''}" ` +
              `role="tab" aria-selected="${mode === 'all' ? 'true' : 'false'}" ` +
              `data-eb-stream-filter="all">All</button>` +
            `<button type="button" class="eb-ribbon-tab${mode === 'telemetry' ? ' is-active' : ''}" ` +
              `role="tab" aria-selected="${mode === 'telemetry' ? 'true' : 'false'}" ` +
              `data-eb-stream-filter="telemetry">Telemetry` +
              (countNum > 0 ? ` <span class="eb-ribbon-count">${countNum}</span>` : '') +
            `</button>` +
          `</div>` +
          `<div class="eb-telemetry-rollup">${rollupBtn}</div>` +
        `</div>`
      );
    }

    function cleanReplyPreviewText(rawText) {
      return humanizeMentionsText(rawText || '')
        .replace(/```[\s\S]*?```/g, '[code]')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function renderReplyPreviewStrip(replyPreview, totalReplies, threadId) {
      const tid = String(threadId == null ? '' : threadId).trim();
      let items = [];
      let participants = [];
      let latest = null;

      if (Array.isArray(replyPreview)) {
        items = replyPreview.filter((x) => x && typeof x === 'object');
      } else if (replyPreview && typeof replyPreview === 'object') {
        if (Array.isArray(replyPreview.items)) {
          items = replyPreview.items.filter((x) => x && typeof x === 'object');
        }
        if (Array.isArray(replyPreview.participants)) {
          participants = replyPreview.participants;
        }
        if (replyPreview.latest && typeof replyPreview.latest === 'object') {
          latest = replyPreview.latest;
        } else if (
          replyPreview.excerpt ||
          replyPreview.preview ||
          replyPreview.text ||
          replyPreview.by ||
          replyPreview.byActor
        ) {
          latest = replyPreview;
        }
      }

      const count = Math.max(
        Number.isFinite(Number(totalReplies)) ? Math.floor(Number(totalReplies)) : 0,
        items.length
      );
      if (count <= 0 && !latest) return '';

      if (!latest && items.length) {
        // Backend orders replyPreview DESC (newest reply first)
        latest = items[0];
      }

      const seenAgents = new Set();
      const avatars = [];
      const agentSources = participants.length ? participants : items.length ? items : latest ? [latest] : [];
      for (let i = 0; i < agentSources.length && avatars.length < 4; i += 1) {
        const src = agentSources[i];
        const rawActor =
          typeof src === 'string'
            ? src
            : src.byProfile || src.byActor || src.by || src.actor || src.author || '';
        const rawBrand = typeof src === 'object' && src ? src.brand : '';
        const meta = resolveAgentBrand(rawActor, rawBrand);
        if (seenAgents.has(meta.handle)) continue;
        seenAgents.add(meta.handle);
        const name =
          typeof src === 'object' && src && src.displayName
            ? stripEmDash(src.displayName)
            : meta.handle;
        const glyphCls = meta.isOwner ? 'eb-reply-avatar is-owner is-owner-dot' : `eb-reply-avatar is-${meta.brand}`;
        avatars.push(
          `<span class="${glyphCls}" title="${escAttr(name)}" aria-hidden="true">${meta.glyphHtml}</span>`
        );
      }

      let latestHtml = '';
      if (latest) {
        const latestActor =
          latest.byProfile || latest.byActor || latest.by || latest.actor || latest.author || 'agent';
        const latestMeta = resolveAgentBrand(latestActor, latest.brand);
        const latestAuthor = latest.displayName
          ? stripEmDash(latest.displayName).trim()
          : `@${latestMeta.handle}`;
        const rawExcerpt =
          latest.excerpt || latest.preview || latest.text || latest.body || latest.summary || '';
        const excerpt = truncateWordBoundary(cleanReplyPreviewText(rawExcerpt), 96);
        latestHtml =
          `<span class="eb-reply-latest">` +
            `<span class="eb-reply-author is-${latestMeta.brand}">${escHtml(latestAuthor)}</span>` +
            (excerpt ? `<span class="eb-reply-excerpt">${escHtml(excerpt)}</span>` : '') +
          `</span>`;
      }

      const viewAllLabel =
        count === 1 ? 'View all 1 reply ->' : `View all ${count} replies ->`;

      return (
        `<div class="eb-reply-strip" data-eb-open-thread="${escAttr(tid)}">` +
          (avatars.length ? `<span class="eb-reply-avatars">${avatars.join('')}</span>` : '') +
          latestHtml +
          `<button type="button" class="eb-reply-view-all" ` +
            `data-eb-open-thread="${escAttr(tid)}" data-action="inspect" ` +
            `data-thread-id="${escAttr(tid)}">${escHtml(viewAllLabel)}</button>` +
        `</div>`
      );
    }

    function parseTimestampMs(val) {
      if (val == null || val === '') return null;
      if (typeof val === 'number') {
        if (!Number.isFinite(val) || val < 1000000000000) return null;
        return val;
      }
      const num = Number(val);
      if (Number.isFinite(num) && num >= 1000000000000) return num;
      const parsed = Date.parse(String(val));
      return Number.isFinite(parsed) && parsed >= 1000000000000 ? parsed : null;
    }

    function brandSpineColor(brand) {
      if (brand === 'claude') return 'var(--eb-claude, #f59e0b)';
      if (brand === 'codex') return 'var(--eb-codex, #56b6f9)';
      if (brand === 'designer' || brand === 'worker') return 'var(--eb-designer, #b48eff)';
      if (brand === 'brain') return 'var(--eb-brain, #4ade80)';
      if (brand === 'owner') return 'var(--eb-owner, #ededed)';
      return 'var(--eb-designer, #b48eff)';
    }

    function renderThreadSpineHtml(item) {
      if (!item || typeof item !== 'object') return '';

      const tid = String(
        item.threadId != null
          ? item.threadId
          : item.numericId != null
            ? item.numericId
            : item.id != null
              ? item.id
              : ''
      ).trim();

      const rootActor =
        item.byProfile || item.byActor || item.by || item.actor || item.author || item.sender || 'agent';
      const rootMeta = resolveAgentBrand(rootActor, item.brand);
      const rootTs =
        parseTimestampMs(item.createdAtMs) ||
        parseTimestampMs(item.createdAt) ||
        parseTimestampMs(item.created_at) ||
        parseTimestampMs(item.ts) ||
        Date.now();
      const lastTs =
        parseTimestampMs(item.lastAtMs) ||
        parseTimestampMs(item.lastAt) ||
        parseTimestampMs(item.at) ||
        rootTs;

      const rawPreviews = Array.isArray(item.replyPreview)
        ? item.replyPreview
        : item.replyPreview && Array.isArray(item.replyPreview.items)
          ? item.replyPreview.items
          : [];
      const previews = rawPreviews
        .filter((x) => x && typeof x === 'object')
        .map((r) => {
          const rActor = r.byProfile || r.byActor || r.by || r.actor || r.author || 'agent';
          const rMeta = resolveAgentBrand(rActor, r.brand);
          const rTs =
            parseTimestampMs(r.createdAtMs) ||
            parseTimestampMs(r.createdAt) ||
            parseTimestampMs(r.created_at) ||
            parseTimestampMs(r.at) ||
            parseTimestampMs(r.ts) ||
            null;
          return {
            meta: rMeta,
            displayName: r.displayName ? stripEmDash(r.displayName) : rMeta.handle,
            ts: rTs,
          };
        });

      // Chronological ascending order for previews
      previews.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const rawReplyCount = Number(
        typeof item.replies === 'number'
          ? item.replies
          : item.replyCount != null
            ? item.replyCount
            : item.reply_count != null
              ? item.reply_count
              : item.repliesCount != null
                ? item.repliesCount
                : previews.length
      );
      const replyCount = Math.max(
        Number.isFinite(rawReplyCount) ? Math.floor(rawReplyCount) : 0,
        previews.length
      );

      // Build overlapping participant avatar stack (up to 4 unique, 18px circles overlapping by 5px)
      const participantMetas = [];
      const seenHandles = new Set();
      function pushParticipant(rawHandle, explicitBrand, displayName) {
        const m = resolveAgentBrand(rawHandle, explicitBrand);
        const key = m.handle.toLowerCase();
        if (seenHandles.has(key)) return;
        seenHandles.add(key);
        participantMetas.push({
          meta: m,
          label: displayName ? stripEmDash(displayName) : m.handle,
        });
      }

      pushParticipant(rootActor, item.brand, item.displayName || rootMeta.handle);
      for (let i = 0; i < previews.length; i += 1) {
        pushParticipant(previews[i].meta.handle, previews[i].meta.brand, previews[i].displayName);
      }
      const rawParticipants = Array.isArray(item.participants) ? item.participants : [];
      for (let i = 0; i < rawParticipants.length; i += 1) {
        const p = rawParticipants[i];
        if (typeof p === 'string') {
          pushParticipant(p, '', p);
        } else if (p && typeof p === 'object') {
          pushParticipant(
            p.byProfile || p.byActor || p.by || p.actor || p.handle || '',
            p.brand || '',
            p.displayName || p.handle || ''
          );
        }
      }

      const avatarItems = participantMetas.slice(0, 4);
      const avatarsHtml = avatarItems
        .map((entry, idx) => {
          const m = entry.meta;
          const cls = m.isOwner
            ? 'eb-spine-avatar is-owner is-owner-dot'
            : `eb-spine-avatar is-${m.brand}`;
          return (
            `<span class="${cls}" style="z-index:${4 - idx};" title="${escAttr(entry.label)}" aria-hidden="true">` +
              `${m.glyphHtml}` +
            `</span>`
          );
        })
        .join('');

      // Build chronological ticks across the thread span
      const events = [{ ts: rootTs, meta: rootMeta, label: item.displayName || rootMeta.handle }];
      for (let i = 0; i < previews.length; i += 1) {
        const p = previews[i];
        const fallbackTs =
          rootTs + Math.round(((Math.max(lastTs, rootTs + 60000) - rootTs) * (i + 1)) / (previews.length + 1));
        events.push({ ts: p.ts || fallbackTs, meta: p.meta, label: p.displayName });
      }

      const maxTicks = 14;
      const extraReplies = Math.min(Math.max(0, replyCount - previews.length), maxTicks - events.length);
      if (extraReplies > 0) {
        const endSpan = Math.max(lastTs, events[events.length - 1].ts, rootTs + 120000);
        const firstPreviewTs = previews.length && previews[0].ts ? previews[0].ts : endSpan;
        const fillEnd = firstPreviewTs > rootTs + 10000 ? firstPreviewTs : endSpan;
        const pool = participantMetas.length ? participantMetas : [{ meta: rootMeta, label: rootMeta.handle }];
        for (let i = 0; i < extraReplies; i += 1) {
          const ratio = (i + 1) / (extraReplies + 1);
          const pick = pool[(i + 1) % pool.length];
          events.push({
            ts: Math.round(rootTs + (fillEnd - rootTs) * ratio),
            meta: pick.meta,
            label: pick.label,
          });
        }
      }

      events.sort((a, b) => a.ts - b.ts);
      const minTs = events[0].ts;
      const maxTs = Math.max(events[events.length - 1].ts, lastTs);
      const spanMs = Math.max(1, maxTs - minTs);

      const ticksHtml = events
        .map((ev, idx) => {
          let pct;
          if (events.length === 1) {
            pct = 12;
          } else if (maxTs === minTs) {
            pct = 6 + (idx / (events.length - 1)) * 88;
          } else {
            pct = 4 + ((ev.ts - minTs) / spanMs) * 92;
          }
          const clampedPct = Math.max(3, Math.min(97, pct));
          const color = brandSpineColor(ev.meta.brand);
          return (
            `<span class="eb-spine-tick is-${escAttr(ev.meta.brand)}" ` +
              `style="left:${clampedPct.toFixed(1)}%;background:${color};" ` +
              `title="${escAttr(ev.label)}"></span>`
          );
        })
        .join('');

      // 48h Momentum Sparkline (60x16 SVG, 12 x 4h buckets, crisp 1.25px polyline)
      const BUCKETS = 12;
      const WINDOW_48H_MS = 48 * 3600 * 1000;
      const counts = new Array(BUCKETS).fill(0);
      const nowRef = Math.max(Date.now(), maxTs);
      const winStart = nowRef - WINDOW_48H_MS;
      const in48h = events.some((ev) => ev.ts >= winStart);

      for (let i = 0; i < events.length; i += 1) {
        const ts = events[i].ts;
        let ratio;
        if (in48h) {
          if (ts < winStart) continue;
          ratio = (ts - winStart) / WINDOW_48H_MS;
        } else {
          ratio = spanMs > 1 ? (ts - minTs) / spanMs : 0.85;
        }
        const b = Math.max(0, Math.min(BUCKETS - 1, Math.floor(ratio * BUCKETS)));
        counts[b] += 1;
      }

      // Ensure total burst reflects replyCount even when only 3 previews are returned
      const bucketSum = counts.reduce((acc, v) => acc + v, 0);
      if (bucketSum === 0) {
        counts[BUCKETS - 1] = 1;
      } else if (replyCount + 1 > bucketSum) {
        const deficit = Math.min(20, replyCount + 1 - bucketSum);
        const peakIdx = counts.reduce((best, val, idx, arr) => (val >= arr[best] ? idx : best), BUCKETS - 1);
        counts[peakIdx] += Math.ceil(deficit * 0.65);
        const prevIdx = Math.max(0, peakIdx - 1);
        counts[prevIdx] += Math.floor(deficit * 0.35);
      }

      const maxBucket = Math.max(1, ...counts);
      const pts = [];
      let lastDotX = 59;
      let lastDotY = 14;
      for (let i = 0; i < BUCKETS; i += 1) {
        const x = Number((1 + (i / (BUCKETS - 1)) * 58).toFixed(1));
        const norm = counts[i] / maxBucket;
        const y = Number((counts[i] > 0 ? 13.5 - norm * 11 : 14.2).toFixed(1));
        pts.push(`${x},${y}`);
        if (counts[i] > 0) {
          lastDotX = x;
          lastDotY = y;
        }
      }

      const sparkStroke = brandSpineColor(
        events.length ? events[events.length - 1].meta.brand : rootMeta.brand
      );
      const replyLabel = replyCount === 1 ? '1 reply' : `${replyCount} replies`;
      const openAttr = tid ? ` data-eb-open-thread="${escAttr(tid)}"` : '';

      return (
        `<div class="eb-thread-spine"${openAttr} role="group" aria-label="Thread activity spine, ${escAttr(replyLabel)}">` +
          `<span class="eb-spine-avatars" aria-label="${avatarItems.length} participants">${avatarsHtml}</span>` +
          `<span class="eb-spine-track" aria-hidden="true">` +
            `<span class="eb-spine-bar"></span>` +
            `${ticksHtml}` +
          `</span>` +
          `<span class="eb-spine-momentum" title="48h activity momentum (${escAttr(replyLabel)})">` +
            `<svg class="eb-spine-spark" width="60" height="16" viewBox="0 0 60 16" fill="none" aria-hidden="true">` +
              `<line x1="1" y1="14.5" x2="59" y2="14.5" stroke="currentColor" stroke-opacity="0.16" stroke-width="1"/>` +
              `<polyline fill="none" stroke="${sparkStroke}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}"/>` +
              `<circle cx="${lastDotX}" cy="${lastDotY}" r="1.6" fill="${sparkStroke}"/>` +
            `</svg>` +
            `<span class="eb-spine-count">${replyCount}</span>` +
          `</span>` +
        `</div>`
      );
    }

    function resolveCopyText(btnEl) {
      if (!btnEl || typeof btnEl.getAttribute !== 'function') return '';
      const direct = btnEl.getAttribute('data-eb-copy-text');
      if (direct != null && direct !== '') return direct;

      const targetAttr = btnEl.getAttribute('data-eb-artifact-target');
      if (targetAttr != null && targetAttr !== '') return targetAttr;

      if (typeof btnEl.closest === 'function') {
        const codeBlock = btnEl.closest('.eb-code-block');
        if (codeBlock && typeof codeBlock.querySelectorAll === 'function') {
          const codeLines = codeBlock.querySelectorAll('.eb-code-text');
          if (codeLines && codeLines.length) {
            return Array.prototype.map.call(codeLines, (el) => el.textContent || '').join('\n');
          }
          const pre = codeBlock.querySelector('pre');
          if (pre) return pre.textContent || '';
        }

        const diffBlock = btnEl.closest('.eb-diff-block');
        if (diffBlock && typeof diffBlock.querySelectorAll === 'function') {
          const diffRows = diffBlock.querySelectorAll('.eb-diff-line');
          if (diffRows && diffRows.length) {
            return Array.prototype.map
              .call(diffRows, (row) => {
                const signEl = row.querySelector('.eb-diff-sign');
                const codeEl = row.querySelector('.eb-diff-code');
                const sign = signEl ? signEl.textContent || '' : '';
                const code = codeEl ? codeEl.textContent || '' : '';
                if (sign === '@@') return code;
                return `${sign}${code}`;
              })
              .join('\n');
          }
        }
      }

      return '';
    }

    function writeClipboardText(text) {
      const w = getWin();
      const nav = (w && w.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        return Promise.resolve()
          .then(() => nav.clipboard.writeText(text))
          .then(() => true)
          .catch(() => fallbackExecCopy(text));
      }
      return Promise.resolve(fallbackExecCopy(text));
    }

    function fallbackExecCopy(text) {
      const doc = getDoc();
      if (!doc || !doc.body || typeof doc.createElement !== 'function') return false;
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        doc.body.appendChild(ta);
        ta.select();
        const ok = typeof doc.execCommand === 'function' ? Boolean(doc.execCommand('copy')) : false;
        doc.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    function copyCodeHandler(btnEl) {
      if (!btnEl) return Promise.resolve({ ok: false, text: '' });
      playClickSound();
      const text = resolveCopyText(btnEl);

      return writeClipboardText(text).then(function (ok) {
        try {
          const origLabel =
            (btnEl.dataset && btnEl.dataset.ebCopyOrig) ||
            (typeof btnEl.getAttribute === 'function' && btnEl.getAttribute('data-eb-copy-orig')) ||
            btnEl.textContent ||
            'Copy';

          if (btnEl.dataset) {
            btnEl.dataset.ebCopyOrig = origLabel;
          } else if (typeof btnEl.setAttribute === 'function') {
            btnEl.setAttribute('data-eb-copy-orig', origLabel);
          }

          if (btnEl._ebCopyTimer) {
            clearTimeout(btnEl._ebCopyTimer);
          }

          btnEl.textContent = 'Copied';
          if (btnEl.classList && typeof btnEl.classList.add === 'function') {
            btnEl.classList.add('is-copied');
          }
          if (typeof btnEl.setAttribute === 'function') {
            btnEl.setAttribute('data-copied', '1');
          }

          btnEl._ebCopyTimer = setTimeout(function () {
            btnEl.textContent = origLabel;
            if (btnEl.classList && typeof btnEl.classList.remove === 'function') {
              btnEl.classList.remove('is-copied');
            }
            if (typeof btnEl.removeAttribute === 'function') {
              btnEl.removeAttribute('data-copied');
            }
            btnEl._ebCopyTimer = null;
          }, COPY_RESET_MS);
        } catch {
          // Never fail UI on minimal button mocks
        }

        return { ok, text };
      });
    }

    return {
      renderRichMessage,
      renderSignalBadge,
      renderTelemetryRibbon,
      renderReplyPreviewStrip,
      renderThreadSpineHtml,
      isLongMessageBody,
      copyCodeHandler,
      humanizeMentionsText,
    };
  }
);
