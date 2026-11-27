(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.KizukiMarkdown = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CALLOUT_LABELS = {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  };

  const NUMERIC_TOKEN_RE =
    /^[+-~≈]?[$€£¥]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|ms|us|ns|s|sec|min|hr|h|d|k|K|M|B|T|KB|MB|GB|TB|px|fps|Hz|x|X)(?:\/[a-zA-Z]{1,8})?|\/[a-zA-Z]{1,8})?$/;
  const RATIO_TOKEN_RE =
    /^[+-]?[$€£¥]?\d[\d,]*(?:\.\d+)?\s*\/\s*[+-]?[$€£¥]?\d[\d,]*(?:\.\d+)?%?$/;

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function normalizeNewlines(input) {
    let text = String(input == null ? '' : input);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // =========================================================================
  // YAML FRONTMATTER PARSER
  // =========================================================================

  function parseScalarValue(raw) {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null' || trimmed === '~') return null;

    // Double-quoted string
    if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }

    // Single-quoted string
    if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }

    // Inline JSON array or object
    if (
      (trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']') ||
      (trimmed[0] === '{' && trimmed[trimmed.length - 1] === '}')
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        if (trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']') {
          return parseYamlFlowArray(trimmed);
        }
      }
    }

    // Unquoted integer or float
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num;
    }

    return trimmed;
  }

  function parseYamlFlowArray(raw) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let buf = '';
    let quote = null;
    let escaped = false;
    let depth = 0;

    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (escaped) {
        buf += ch;
        escaped = false;
        continue;
      }
      if (quote) {
        buf += ch;
        if (ch === '\\' && quote === '"') {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === '[' || ch === '{') {
        depth += 1;
        buf += ch;
        continue;
      }
      if (ch === ']' || ch === '}') {
        if (depth > 0) depth -= 1;
        buf += ch;
        continue;
      }
      if (ch === ',' && depth === 0) {
        if (buf.trim() !== '') items.push(parseScalarValue(buf));
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim() !== '') items.push(parseScalarValue(buf));
    return items;
  }

  function parseFrontmatterBlock(rawLines) {
    const frontmatter = {};
    let i = 0;

    while (i < rawLines.length) {
      const line = rawLines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        i += 1;
        continue;
      }

      const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!kvMatch) {
        i += 1;
        continue;
      }

      const key = kvMatch[1];
      let valStr = kvMatch[2].trim();

      // Multi-line block list under empty key:
      if (valStr === '') {
        const listItems = [];
        let j = i + 1;
        while (j < rawLines.length) {
          const sub = rawLines[j];
          const itemMatch = sub.match(/^[ \t]+-\s+(.*)$/);
          if (itemMatch) {
            listItems.push(parseScalarValue(itemMatch[1]));
            j += 1;
          } else if (sub.trim() === '' || sub.trim().startsWith('#')) {
            j += 1;
          } else {
            break;
          }
        }
        if (listItems.length > 0) {
          frontmatter[key] = listItems;
          i = j;
          continue;
        }
        frontmatter[key] = '';
        i += 1;
        continue;
      }

      // Multi-line flow array that spans multiple lines
      if (valStr.startsWith('[') && !valStr.endsWith(']')) {
        let combined = valStr;
        let j = i + 1;
        while (j < rawLines.length) {
          combined += ' ' + rawLines[j].trim();
          if (rawLines[j].trim().endsWith(']')) {
            j += 1;
            break;
          }
          j += 1;
        }
        frontmatter[key] = parseScalarValue(combined);
        i = j;
        continue;
      }

      frontmatter[key] = parseScalarValue(valStr);
      i += 1;
    }

    return frontmatter;
  }

  function parseFrontmatter(md) {
    const text = normalizeNewlines(md);
    const lines = text.split('\n');

    if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0])) {
      return {
        frontmatter: {},
        body: text,
        hasFrontmatter: false,
        rawFrontmatter: '',
      };
    }

    let closeIdx = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i])) {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) {
      return {
        frontmatter: {},
        body: text,
        hasFrontmatter: false,
        rawFrontmatter: '',
      };
    }

    const fmLines = lines.slice(1, closeIdx);
    const frontmatter = parseFrontmatterBlock(fmLines);
    let bodyLines = lines.slice(closeIdx + 1);
    while (bodyLines.length > 0 && bodyLines[0].trim() === '') {
      bodyLines.shift();
    }

    return {
      frontmatter,
      body: bodyLines.join('\n'),
      hasFrontmatter: true,
      rawFrontmatter: fmLines.join('\n'),
    };
  }

  // =========================================================================
  // HEADING SLUGS & PLAIN TEXT EXTRACTION
  // =========================================================================

  function stripInlineSyntax(text) {
    let s = String(text || '');
    // Unwrap wikilinks [[target|alias]] or ![[target|alias]] -> alias, [[target]] -> target
    s = s.replace(/!?\[\[([^\]]+)\]\]/g, function (_m, inner) {
      const cleaned = inner.replace(/\\\|/g, '|');
      const pipe = cleaned.indexOf('|');
      if (pipe >= 0) {
        const alias = cleaned.slice(pipe + 1).trim();
        if (alias) return alias;
        const target = cleaned.slice(0, pipe).trim();
        const base = target.split('#')[0].split('/').pop();
        return (base || target).trim();
      }
      return cleaned.trim();
    });
    // Unwrap markdown links & images
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Unwrap inline code
    s = s.replace(/`+([^`]*)`+/g, '$1');
    // Unwrap bold/italic/strikethrough (including nested and mismatched edge cases)
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    s = s.replace(/\*\*([^\s*](?:(?:[^*\n]|\*(?!\*))*?[^\s*])?)\*\*/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
    s = s.replace(/(?<!\*)\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?!\*)/g, '$1');
    s = s.replace(/(?<!\*)\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, '$1');
    s = s.replace(/(?<![\w])__([^_]+)__(?![\w])/g, '$1');
    s = s.replace(/(?<![\w])_([^_]+)_(?![\w])/g, '$1');
    return s.trim();
  }

  function slugifyHeading(text) {
    const plain = stripInlineSyntax(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return 'md-h-' + (plain || 'section');
  }

  function allocateHeadingId(text, slugCounts) {
    const base = slugifyHeading(text);
    const seen = slugCounts.get(base) || 0;
    slugCounts.set(base, seen + 1);
    return seen === 0 ? base : base + '-' + (seen + 1);
  }

  // =========================================================================
  // INLINE MARKDOWN ENGINE (TOKENIZED & STRICTLY XSS-SAFE)
  // =========================================================================

  function classifyLinkHref(rawHref) {
    let href = String(rawHref || '').trim();
    if (!href) return { kind: 'blocked', href: '' };

    // Strip angle brackets if <url>
    if (href.startsWith('<') && href.endsWith('>')) {
      href = href.slice(1, -1).trim();
    }

    // Strip optional link title for external URLs: https://x.com "title"
    if (/^https?:\/\//i.test(href)) {
      const spaceTitle = href.match(/^(\S+)\s+(?:"[^"]*"|'[^']*')$/);
      if (spaceTitle) {
        href = spaceTitle[1];
      }
    }

    // Strip control characters and whitespace for scheme inspection
    const sanitizedForScheme = href.replace(/[\x00-\x20\x7f]+/g, '');
    if (!sanitizedForScheme) return { kind: 'blocked', href: '' };

    // Decode simple numeric/named entities before scheme check to block obfuscated javascript:
    const decodedForScheme = sanitizedForScheme
      .replace(/&#x([0-9a-f]+);?/gi, function (_m, hex) {
        return String.fromCharCode(parseInt(hex, 16) || 0);
      })
      .replace(/&#([0-9]+);?/g, function (_m, dec) {
        return String.fromCharCode(parseInt(dec, 10) || 0);
      })
      .replace(/[\x00-\x20\x7f]+/g, '');

    if (/^(?:javascript|vbscript|data|file|blob):/i.test(decodedForScheme)) {
      return { kind: 'blocked', href: '' };
    }

    if (/^https?:\/\//i.test(href)) {
      if (/[\x00-\x1f\x7f]/.test(href)) return { kind: 'blocked', href: '' };
      return { kind: 'external', href };
    }

    if (/^#[A-Za-z0-9_.:-]+$/.test(href)) {
      return { kind: 'anchor', href };
    }

    // Block protocol-relative // and any other explicit URI scheme
    if (href.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decodedForScheme)) {
      return { kind: 'blocked', href: '' };
    }

    // Relative .md document links (supports spaces in filenames)
    if (/\.md(?:[?#][^\x00-\x1f\x7f]*)?$/i.test(href) && !/[\x00-\x1f\x7f]/.test(href)) {
      return { kind: 'doc', href };
    }

    return { kind: 'blocked', href: '' };
  }

  function applyEmphasisToEscaped(escapedText) {
    let s = escapedText;
    // Bold + Italic ***...*** and bold ending with italic **... *...***
    if (s.indexOf('***') !== -1) {
      s = s.replace(/\*\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*\*/g, '<strong><em>$1</em></strong>');
      s = s.replace(/\*\*([^\s*](?:[^*\n]|\*(?!\*))*?\*[^\s*][^*\n]*?)\*\*\*/g, '<strong>$1*</strong>');
    }
    // Bold **...** (allows inner single * such as **foo *bar* baz** or **2 * 3**)
    if (s.indexOf('**') !== -1) {
      s = s.replace(/\*\*([^\s*](?:(?:[^*\n]|\*(?!\*))*?[^\s*])?)\*\*/g, '<strong>$1</strong>');
    }
    // Bold __...__ (word-boundary safe for snake_case)
    if (s.indexOf('__') !== -1) {
      s = s.replace(/(?<![\w])__([^\s_](?:[^_\n]*?[^\s_])?)__(?![\w])/g, '<strong>$1</strong>');
    }
    // Strikethrough ~~...~~
    if (s.indexOf('~~') !== -1) {
      s = s.replace(/~~([^\s~](?:[^~\n]*?[^\s~])?)~~/g, '<del>$1</del>');
    }
    // Italic *...*
    if (s.indexOf('*') !== -1) {
      s = s.replace(/(?<!\*)\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, '<em>$1</em>');
    }
    // Italic _..._ (word-boundary safe for snake_case)
    if (s.indexOf('_') !== -1) {
      s = s.replace(/(?<![\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w])/g, '<em>$1</em>');
    }
    // Edge-case bold recovery: *Observed fact:**, **Observed fact:*, **Label **:, ** Label**:
    if (s.indexOf('**') !== -1) {
      s = s.replace(/(?<!\*)\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?!\*)/g, '<strong>$1</strong>');
      s = s.replace(/(?<!\*)\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, '<strong>$1</strong>');
      s = s.replace(/\*\*([^\s*][^*\n]*?)[ \t]+\*\*(?![\w*])/g, '<strong>$1</strong>');
      s = s.replace(/(?<![\w*])\*\*[ \t]+([^*\n]*?[^\s*])\*\*/g, '<strong>$1</strong>');
    }
    return s;
  }

  function findBalancedLinkEnd(text, openParenIdx) {
    let depth = 0;
    for (let i = openParenIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return i;
      } else if (ch === '\n') {
        return -1;
      }
    }
    return -1;
  }

  function extractMarkdownLinks(text, addToken, allowLinks) {
    if (!allowLinks) return text;
    let out = '';
    let i = 0;

    while (i < text.length) {
      const isImage = text[i] === '!' && text[i + 1] === '[';
      const isLink = text[i] === '[' && text[i + 1] !== '[';

      if (!isImage && !isLink) {
        out += text[i];
        i += 1;
        continue;
      }

      const labelStart = isImage ? i + 2 : i + 1;
      let bracketDepth = 1;
      let j = labelStart;
      while (j < text.length && bracketDepth > 0) {
        if (text[j] === '\\' && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === '[') bracketDepth += 1;
        else if (text[j] === ']') bracketDepth -= 1;
        if (bracketDepth > 0) j += 1;
      }

      if (bracketDepth === 0 && text[j + 1] === '(') {
        const closeParen = findBalancedLinkEnd(text, j + 1);
        if (closeParen !== -1) {
          const labelRaw = text.slice(labelStart, j);
          const hrefRaw = text.slice(j + 2, closeParen);
          const classified = classifyLinkHref(hrefRaw);

          if (isImage) {
            if (classified.kind === 'external') {
              out += addToken(
                '<img class="md-image" src="' +
                  escapeAttr(classified.href) +
                  '" alt="' +
                  escapeAttr(labelRaw) +
                  '" loading="lazy">'
              );
            } else {
              out += addToken(escapeHtml(labelRaw));
            }
          } else {
            const labelHtml = renderInlineInternal(labelRaw, false);
            if (classified.kind === 'external') {
              out += addToken(
                '<a href="' +
                  escapeAttr(classified.href) +
                  '" target="_blank" rel="noopener noreferrer">' +
                  labelHtml +
                  '</a>'
              );
            } else if (classified.kind === 'doc') {
              out += addToken(
                '<button type="button" class="md-doc-link" data-open-doc="' +
                  escapeAttr(classified.href) +
                  '">' +
                  labelHtml +
                  '</button>'
              );
            } else if (classified.kind === 'anchor') {
              out += addToken(
                '<a class="md-anchor-link" href="' +
                  escapeAttr(classified.href) +
                  '">' +
                  labelHtml +
                  '</a>'
              );
            } else {
              out += addToken('<span class="md-blocked-link">' + labelHtml + '</span>');
            }
          }

          i = closeParen + 1;
          continue;
        }
      }

      out += text[i];
      i += 1;
    }

    return out;
  }

  function trimTrailingUrlPunctuation(rawUrl) {
    let url = rawUrl;
    let suffix = '';

    while (url.length > 0) {
      const last = url[url.length - 1];
      if (/[.,;:!?]/.test(last)) {
        suffix = last + suffix;
        url = url.slice(0, -1);
        continue;
      }
      if (last === ')') {
        const opens = (url.match(/\(/g) || []).length;
        const closes = (url.match(/\)/g) || []).length;
        if (closes > opens) {
          suffix = last + suffix;
          url = url.slice(0, -1);
          continue;
        }
      }
      if (last === ']') {
        const opens = (url.match(/\[/g) || []).length;
        const closes = (url.match(/\]/g) || []).length;
        if (closes > opens) {
          suffix = last + suffix;
          url = url.slice(0, -1);
          continue;
        }
      }
      if (last === '}' || last === '>' || last === '"' || last === "'") {
        suffix = last + suffix;
        url = url.slice(0, -1);
        continue;
      }
      break;
    }

    return { url, suffix };
  }

  function renderInlineInternal(rawText, allowLinks) {
    // Strip NUL bytes to prevent placeholder sentinel forgery
    let s = String(rawText == null ? '' : rawText).replace(/\x00/g, '');
    if (!s) return '';

    const tokens = [];
    const addToken = function (html) {
      const id = tokens.length;
      tokens.push(html);
      return '\x00KZK' + id + '\x00';
    };

    // 1. Inline code spans (supports double-backtick spans containing single backticks)
    s = s.replace(/``([^`\n](?:.*?[^`\n])?)``|`([^`\n]+)`/g, function (_m, dbl, sgl) {
      const code = dbl !== undefined ? dbl.trim() : sgl;
      return addToken('<code>' + escapeHtml(code) + '</code>');
    });

    // 2. Wikilinks [[target]], ![[target]], [[target|alias]], or [[target\|alias]]
    if (allowLinks) {
      s = s.replace(/!?\[\[([^\]\n]+)\]\]/g, function (_m, inner) {
        const normalized = inner.replace(/\\\|/g, '|');
        const pipeIdx = normalized.indexOf('|');
        const rawTarget = (pipeIdx >= 0 ? normalized.slice(0, pipeIdx) : normalized).trim();
        const target = rawTarget.replace(/[\x00-\x1f\x7f]+/g, '').trim();
        if (!target) return _m;
        let label = (pipeIdx >= 0 ? normalized.slice(pipeIdx + 1) : normalized).trim();
        if (!label && pipeIdx >= 0) {
          const base = target.split('#')[0].split('/').pop();
          label = (base || target).trim();
        }
        return addToken(
          '<button type="button" class="md-wikilink" data-open-wikilink="' +
            escapeAttr(target) +
            '">' +
            escapeHtml(label || target) +
            '</button>'
        );
      });
    }

    // 3. Markdown links & images
    s = extractMarkdownLinks(s, addToken, allowLinks);

    // 4. Bare http(s):// auto-links
    if (allowLinks) {
      s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>\x00]+)/g, function (_m, lead, rawUrl) {
        const split = trimTrailingUrlPunctuation(rawUrl);
        if (!split.url || !/^https?:\/\/\S+$/i.test(split.url)) {
          return lead + rawUrl;
        }
        return (
          lead +
          addToken(
            '<a href="' +
              escapeAttr(split.url) +
              '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(split.url) +
              '</a>'
          ) +
          split.suffix
        );
      });
    }

    // 4b. Preserve explicit hard line breaks as tokens so emphasis can span them safely
    if (s.indexOf('\n') !== -1) {
      s = s.replace(/\n/g, function () {
        return addToken('<br>');
      });
    }

    // 5. Escape all remaining raw HTML BEFORE applying emphasis
    s = escapeHtml(s);

    // 6. Apply bold, italic, strikethrough on escaped prose
    s = applyEmphasisToEscaped(s);

    // 7. Restore tokens
    for (let pass = 0; pass < 3 && s.indexOf('\x00KZK') !== -1; pass += 1) {
      s = s.replace(/\x00KZK(\d+)\x00/g, function (_m, idx) {
        const html = tokens[Number(idx)];
        return html !== undefined ? html : '';
      });
    }

    return s;
  }

  function renderInline(text) {
    return renderInlineInternal(text, true);
  }

  // =========================================================================
  // GFM TABLE PARSING & NUMERIC CELL DETECTION
  // =========================================================================

  function splitTableRow(line) {
    let s = line.trim();
    if (!s) return [];
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) {
      s = s.slice(0, -1);
    }

    const cells = [];
    let current = '';
    let inCode = false;
    let inWikilink = false;

    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      const next = s[i + 1];

      if (ch === '\\' && next === '|') {
        if (inWikilink) {
          current += '\\|';
        } else {
          current += '|';
        }
        i += 1;
        continue;
      }

      if (ch === '`') {
        inCode = !inCode;
        current += ch;
        continue;
      }

      if (!inCode && ch === '[' && next === '[' && s.indexOf(']]', i + 2) !== -1) {
        inWikilink = true;
        current += '[[';
        i += 1;
        continue;
      }

      if (!inCode && inWikilink && ch === ']' && next === ']') {
        inWikilink = false;
        current += ']]';
        i += 1;
        continue;
      }

      if (ch === '|' && !inCode && !inWikilink) {
        cells.push(current.trim());
        current = '';
        continue;
      }

      current += ch;
    }

    cells.push(current.trim());
    return cells;
  }

  function parseTableAlignments(delimiterLine) {
    if (!delimiterLine || delimiterLine.indexOf('|') === -1) return null;
    const trimmed = delimiterLine.trim();
    if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return null;
    const cells = splitTableRow(trimmed);
    if (cells.length === 0) return null;

    const alignments = [];
    for (let i = 0; i < cells.length; i += 1) {
      const c = cells[i].trim();
      if (!/^:?-{1,}:?$/.test(c)) return null;
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      if (left && right) alignments.push('center');
      else if (right) alignments.push('right');
      else if (left) alignments.push('left');
      else alignments.push(null);
    }
    return alignments;
  }

  function isNumericCell(rawText) {
    let s = String(rawText == null ? '' : rawText).trim();
    if (!s) return false;
    // Strip simple surrounding markdown formatting like **14/14** or `104,174`
    s = s
      .replace(/^\*\*([^*]+)\*\*$/, '$1')
      .replace(/^\*([^*]+)\*$/, '$1')
      .replace(/^`([^`]+)`$/, '$1')
      .trim();
    if (!s) return false;
    return NUMERIC_TOKEN_RE.test(s) || RATIO_TOKEN_RE.test(s);
  }

  function isTableStart(lines, idx) {
    if (idx + 1 >= lines.length) return false;
    const headerLine = lines[idx];
    const delimLine = lines[idx + 1];
    if (!headerLine || headerLine.indexOf('|') === -1) return false;
    const alignments = parseTableAlignments(delimLine);
    if (!alignments) return false;
    const headerCells = splitTableRow(headerLine);
    if (headerCells.length === 0) return false;
    return true;
  }

  function renderTable(lines, startIdx) {
    const headerCells = splitTableRow(lines[startIdx]);
    const alignments = parseTableAlignments(lines[startIdx + 1]) || [];
    const colCount = Math.max(headerCells.length, alignments.length);
    const bodyRows = [];

    let idx = startIdx + 2;
    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (!trimmed || line.indexOf('|') === -1) break;
      // Stop if a new block construct clearly starts
      if (/^(?:```|~~~|#{1,6}\s|>\s?)/.test(trimmed)) break;
      bodyRows.push(splitTableRow(line));
      idx += 1;
    }

    const thHtml = [];
    for (let c = 0; c < colCount; c += 1) {
      const align = alignments[c] || null;
      const styleAttr = align ? ' style="text-align:' + align + '"' : '';
      const cellText = headerCells[c] !== undefined ? headerCells[c] : '';
      thHtml.push('<th' + styleAttr + '>' + renderInline(cellText) + '</th>');
    }

    const trHtml = [];
    for (let r = 0; r < bodyRows.length; r += 1) {
      const row = bodyRows[r];
      const tdHtml = [];
      for (let c = 0; c < colCount; c += 1) {
        const rawCell = row[c] !== undefined ? row[c] : '';
        const align = alignments[c] || null;
        const attrs = [];
        if (isNumericCell(rawCell)) attrs.push('class="is-numeric"');
        if (align) attrs.push('style="text-align:' + align + '"');
        const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
        tdHtml.push('<td' + attrStr + '>' + renderInline(rawCell) + '</td>');
      }
      trHtml.push('<tr>' + tdHtml.join('') + '</tr>');
    }

    const html =
      '<div class="md-table-wrap"><table class="md-table">' +
      '<thead><tr>' +
      thHtml.join('') +
      '</tr></thead>' +
      (trHtml.length ? '<tbody>' + trHtml.join('') + '</tbody>' : '') +
      '</table></div>';

    return { html, nextIdx: idx };
  }

  // =========================================================================
  // BLOCK-LEVEL HELPERS (FENCES, HR, HEADINGS, LISTS, CALLOUTS, PARAGRAPHS)
  // =========================================================================

  function parseFenceOpen(line) {
    const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!match) return null;
    const marker = match[1];
    const info = match[2].trim();
    // Backtick fences cannot contain backticks in their info string (GFM spec)
    if (marker[0] === '`' && info.indexOf('`') !== -1) return null;
    return {
      char: marker[0],
      length: marker.length,
      lang: info.split(/\s+/)[0] || '',
    };
  }

  function isFenceClose(line, fence) {
    const leadMatch = line.match(/^[ ]{0,3}(.*)$/);
    if (!leadMatch) return false;
    const trimmed = leadMatch[1].replace(/[ \t]+$/, '');
    if (trimmed.length < fence.length) return false;
    for (let i = 0; i < trimmed.length; i += 1) {
      if (trimmed[i] !== fence.char) return false;
    }
    return true;
  }

  function isHorizontalRule(line) {
    const trimmed = line.trim();
    return /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/.test(trimmed);
  }

  function parseHeading(line) {
    const match = line.match(/^[ ]{0,3}(#{1,6})[ \t]+(.*)$/);
    if (!match) return null;
    const level = match[1].length;
    const content = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
    return { level, content };
  }

  function countIndent(line) {
    let width = 0;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === ' ') width += 1;
      else if (line[i] === '\t') width += 2;
      else break;
    }
    return width;
  }

  function parseListItem(line) {
    if (isHorizontalRule(line)) return null;
    const indent = countIndent(line);
    const rest = line.replace(/^[ \t]+/, '');

    const ulMatch = rest.match(/^([-*+])[ \t]+(.*)$/);
    if (ulMatch) {
      const content = ulMatch[2];
      const taskMatch = content.match(/^\[([ xX])\][ \t]+(.*)$/);
      return {
        type: 'ul',
        indent,
        start: null,
        isTask: Boolean(taskMatch),
        checked: taskMatch ? taskMatch[1].toLowerCase() === 'x' : false,
        content: taskMatch ? taskMatch[2] : content,
      };
    }

    const olMatch = rest.match(/^(\d+)[.)][ \t]+(.*)$/);
    if (olMatch) {
      const content = olMatch[2];
      const taskMatch = content.match(/^\[([ xX])\][ \t]+(.*)$/);
      return {
        type: 'ol',
        indent,
        start: Number(olMatch[1]),
        isTask: Boolean(taskMatch),
        checked: taskMatch ? taskMatch[1].toLowerCase() === 'x' : false,
        content: taskMatch ? taskMatch[2] : content,
      };
    }

    return null;
  }

  function renderListBlock(lines, startIdx) {
    const items = [];
    let idx = startIdx;

    while (idx < lines.length) {
      const line = lines[idx];
      if (!line.trim()) {
        // Allow a single blank line if the next non-blank line continues the list at same/deeper indent
        let peek = idx + 1;
        while (peek < lines.length && !lines[peek].trim()) peek += 1;
        if (peek < lines.length && parseListItem(lines[peek])) {
          idx = peek;
          continue;
        }
        break;
      }

      const parsed = parseListItem(line);
      if (parsed) {
        items.push({
          ...parsed,
          continuations: [],
        });
        idx += 1;
        continue;
      }

      // Indented continuation line belonging to previous list item
      if (items.length > 0 && /^[ \t]+\S/.test(line)) {
        const trimmedCont = line.trim();
        if (!parseFenceOpen(trimmedCont) && !isTableStart(lines, idx)) {
          items[items.length - 1].continuations.push(trimmedCont);
          idx += 1;
          continue;
        }
      }

      break;
    }

    // Build nested list tree from flat items with indentation
    function buildListHtml(itemSlice, baseIndent) {
      if (itemSlice.length === 0) return '';
      const listType = itemSlice[0].type;
      const startNum = itemSlice[0].start;
      const hasTasks = itemSlice.some(function (it) {
        return it.indent === baseIndent && it.isTask;
      });

      const openAttrs = [];
      if (hasTasks) openAttrs.push('class="md-task-list"');
      if (listType === 'ol' && startNum !== null && startNum !== 1) {
        openAttrs.push('start="' + startNum + '"');
      }
      const openTag = '<' + listType + (openAttrs.length ? ' ' + openAttrs.join(' ') : '') + '>';
      const closeTag = '</' + listType + '>';

      const parts = [openTag];
      let p = 0;

      while (p < itemSlice.length) {
        const current = itemSlice[p];

        // Collect all nested child items with strictly greater indent
        const children = [];
        let q = p + 1;
        while (q < itemSlice.length && itemSlice[q].indent > current.indent) {
          children.push(itemSlice[q]);
          q += 1;
        }

        const fullText =
          current.continuations.length > 0
            ? current.content + '\n' + current.continuations.join('\n')
            : current.content;
        const inlineHtml = renderInline(fullText);

        let childHtml = '';
        if (children.length > 0) {
          const childBaseIndent = children[0].indent;
          // Group children by listType transitions at childBaseIndent
          let cStart = 0;
          while (cStart < children.length) {
            const cType = children[cStart].type;
            let cEnd = cStart + 1;
            while (
              cEnd < children.length &&
              (children[cEnd].indent > childBaseIndent || children[cEnd].type === cType)
            ) {
              cEnd += 1;
            }
            childHtml += buildListHtml(children.slice(cStart, cEnd), childBaseIndent);
            cStart = cEnd;
          }
        }

        if (current.isTask) {
          const stateClass = current.checked ? 'is-done' : 'is-todo';
          const checkedAttr = current.checked ? ' checked' : '';
          const ariaLabel = current.checked ? 'Completed task' : 'Incomplete task';
          parts.push(
            '<li class="md-task-item ' +
              stateClass +
              '"><input type="checkbox" class="md-task-checkbox"' +
              checkedAttr +
              ' disabled aria-label="' +
              ariaLabel +
              '"><span>' +
              inlineHtml +
              '</span>' +
              childHtml +
              '</li>'
          );
        } else {
          parts.push('<li>' + inlineHtml + childHtml + '</li>');
        }

        // If next sibling at same indent switches list type (ul <-> ol), split list cleanly
        if (q < itemSlice.length && itemSlice[q].indent === baseIndent && itemSlice[q].type !== listType) {
          parts.push(closeTag);
          parts.push(buildListHtml(itemSlice.slice(q), baseIndent));
          return parts.join('');
        }

        p = q;
      }

      parts.push(closeTag);
      return parts.join('');
    }

    const rootIndent = items.length > 0 ? items[0].indent : 0;
    return {
      html: buildListHtml(items, rootIndent),
      nextIdx: idx,
    };
  }

  function renderBlockquoteOrCallout(lines, startIdx, state, options) {
    const innerLines = [];
    let idx = startIdx;

    while (idx < lines.length) {
      const line = lines[idx];
      const bqMatch = line.match(/^[ ]{0,3}>[ ]?(.*)$/);
      if (bqMatch) {
        innerLines.push(bqMatch[1]);
        idx += 1;
      } else {
        break;
      }
    }

    // Check for GitHub / Obsidian Callout on first non-empty line
    let firstNonEmptyIdx = -1;
    for (let k = 0; k < innerLines.length; k += 1) {
      if (innerLines[k].trim() !== '') {
        firstNonEmptyIdx = k;
        break;
      }
    }
    const firstLine = firstNonEmptyIdx >= 0 ? innerLines[firstNonEmptyIdx].trim() : '';
    const calloutMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][+-]?(?:[ \t]+(.*))?$/i);
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const extraOnFirstLine = (calloutMatch[2] || '').trim();
      const remainingLines = innerLines.slice(firstNonEmptyIdx + 1);
      const hasRemainingContent = remainingLines.some(function (l) {
        return l.trim() !== '';
      });

      let title = CALLOUT_LABELS[type] || type;
      let bodyLines = remainingLines;

      if (extraOnFirstLine) {
        if (hasRemainingContent) {
          title = extraOnFirstLine;
        } else {
          bodyLines = [extraOnFirstLine];
        }
      }

      const bodyHtml = renderBlocks(bodyLines, state, options);
      return {
        html:
          '<div class="md-callout md-callout-' +
          type +
          '" role="note"><div class="md-callout-title">' +
          renderInline(title) +
          '</div><div class="md-callout-body">' +
          bodyHtml +
          '</div></div>',
        nextIdx: idx,
      };
    }

    const innerHtml = renderBlocks(innerLines, state, options);
    return {
      html: '<blockquote>' + innerHtml + '</blockquote>',
      nextIdx: idx,
    };
  }

  function startsNewBlock(lines, idx) {
    const line = lines[idx];
    if (!line || !line.trim()) return true;
    if (parseFenceOpen(line)) return true;
    if (parseHeading(line)) return true;
    if (isHorizontalRule(line)) return true;
    if (/^[ ]{0,3}>/.test(line)) return true;
    if (parseListItem(line)) return true;
    if (isTableStart(lines, idx)) return true;
    return false;
  }

  function renderBlocks(lines, state, options) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      // 1. Fenced code block
      const fence = parseFenceOpen(line);
      if (fence) {
        const codeLines = [];
        let j = i + 1;
        while (j < lines.length && !isFenceClose(lines[j], fence)) {
          codeLines.push(lines[j]);
          j += 1;
        }
        const langLabel = fence.lang || 'text';
        const langSlug = fence.lang
          ? fence.lang.toLowerCase().replace(/[^a-z0-9_+-]/g, '')
          : '';
        const safeLangClass = langSlug
          ? ' class="language-' + escapeAttr(langSlug) + '"'
          : '';
        out.push(
          '<div class="md-code-block">' +
            '<div class="md-code-head">' +
            '<span class="md-code-lang">' +
            escapeHtml(langLabel) +
            '</span>' +
            '<button type="button" class="md-code-copy" data-copy-code>Copy</button>' +
            '</div>' +
            '<pre><code' +
            safeLangClass +
            '>' +
            escapeHtml(codeLines.join('\n')) +
            '</code></pre>' +
            '</div>'
        );
        i = j < lines.length ? j + 1 : j;
        continue;
      }

      // 2. Headings (# .. ######)
      const heading = parseHeading(line);
      if (heading) {
        const id = allocateHeadingId(heading.content, state.slugCounts);
        const plainText = stripInlineSyntax(heading.content);
        state.toc.push({
          level: heading.level,
          text: plainText,
          id,
        });
        out.push(
          '<h' +
            heading.level +
            ' id="' +
            escapeAttr(id) +
            '">' +
            renderInline(heading.content) +
            '</h' +
            heading.level +
            '>'
        );
        i += 1;
        continue;
      }

      // 3. Horizontal rule
      if (isHorizontalRule(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      // 4. GFM Table
      if (isTableStart(lines, i)) {
        const tableRes = renderTable(lines, i);
        out.push(tableRes.html);
        i = tableRes.nextIdx;
        continue;
      }

      // 5. Blockquote or GitHub Callout
      if (/^[ ]{0,3}>/.test(line)) {
        const bqRes = renderBlockquoteOrCallout(lines, i, state, options);
        out.push(bqRes.html);
        i = bqRes.nextIdx;
        continue;
      }

      // 6. Ordered / Unordered / Task List (with nesting)
      if (parseListItem(line)) {
        const listRes = renderListBlock(lines, i);
        out.push(listRes.html);
        i = listRes.nextIdx;
        continue;
      }

      // 7. Paragraph (join soft-wrapped lines so multi-line bold/links/wikilinks parse cleanly)
      const paraLines = [line];
      let j = i + 1;
      while (j < lines.length && !startsNewBlock(lines, j)) {
        paraLines.push(lines[j]);
        j += 1;
      }

      let paraRaw = '';
      for (let k = 0; k < paraLines.length; k += 1) {
        const seg = paraLines[k];
        const hardBreak = /[ ]{2,}$/.test(seg) || /\\$/.test(seg);
        const cleanedSeg = hardBreak ? seg.replace(/(?:[ ]{2,}|\\)$/, '').trimStart() : seg.trim();
        paraRaw += cleanedSeg;
        if (k < paraLines.length - 1) {
          paraRaw += hardBreak ? '\n' : ' ';
        }
      }

      out.push('<p>' + renderInline(paraRaw) + '</p>');
      i = j;
    }

    return out.join('\n');
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  function extractToc(mdOrBody) {
    const parsed = parseFrontmatter(mdOrBody);
    const lines = parsed.body.split('\n');
    const slugCounts = new Map();
    const toc = [];
    let activeFence = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (activeFence) {
        if (isFenceClose(line, activeFence)) {
          activeFence = null;
        }
        continue;
      }
      const fence = parseFenceOpen(line);
      if (fence) {
        activeFence = fence;
        continue;
      }
      const heading = parseHeading(line);
      if (heading) {
        const id = allocateHeadingId(heading.content, slugCounts);
        toc.push({
          level: heading.level,
          text: stripInlineSyntax(heading.content),
          id,
        });
      }
    }

    return toc;
  }

  function renderDocument(md, options) {
    const opts = options || {};
    const parsed = parseFrontmatter(md);
    const body = opts.keepFrontmatter ? normalizeNewlines(md) : parsed.body;
    const state = {
      slugCounts: new Map(),
      toc: [],
    };

    if (!body.trim()) {
      return {
        html: typeof opts.emptyHtml === 'string' ? opts.emptyHtml : '',
        frontmatter: parsed.frontmatter,
        hasFrontmatter: parsed.hasFrontmatter,
        body,
        toc: [],
      };
    }

    const html = renderBlocks(body.split('\n'), state, opts);
    return {
      html,
      frontmatter: parsed.frontmatter,
      hasFrontmatter: parsed.hasFrontmatter,
      body,
      toc: state.toc,
    };
  }

  function render(md, options) {
    return renderDocument(md, options).html;
  }

  return {
    parseFrontmatter,
    extractToc,
    render,
    renderDocument,
    renderInline,
    escapeHtml,
    isNumericCell,
    slugifyHeading,
  };
});
