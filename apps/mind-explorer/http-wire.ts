import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliCompressSync,
  constants as zlibConstants,
  gzip,
  gzipSync,
} from "node:zlib";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type ViewChunkName = "board" | "replay" | "codex" | "taste" | "people" | "graph";

export const VIEW_CHUNK_NAMES: readonly ViewChunkName[] = [
  "board",
  "replay",
  "codex",
  "taste",
  "people",
  "graph",
] as const;

export const CORE_CSS_FILES: readonly string[] = [
  "styles.css",
  "craft-lift.css",
  "taste-studio.css",
  "master-lift.css",
  "agent-board.css",
  "board-deep.css",
  "kinetic-depth.css",
] as const;

export const CORE_JS_FILES: readonly string[] = [
  "markdown.js",
  "icons.js",
  "motion.js",
  "charts.js",
  "sound.js",
  "instrument-hud.js",
  "board-os-widgets.js",
  "kinetic-os.js",
] as const;

export const VIEW_CHUNK_FILES: Record<ViewChunkName, readonly string[]> = {
  board: [
    "ui-sdk-core.js",
    "board-mesh-canvas.js",
    "board-artifacts.js",
    "board-composer-sdk.js",
    "board-context-stage.js",
    "agent-board-view.js",
  ],
  replay: ["geo-atlas.js", "replay-map.js", "replay-scrubber.js"],
  codex: ["codex-constellation.js", "codex-view.js"],
  taste: ["taste-deck-fx.js", "taste-view.js"],
  people: ["person-visuals.js"],
  graph: ["graph.js"],
};

const ALL_BUNDLED_CSS_SET = new Set<string>(CORE_CSS_FILES);
const ALL_BUNDLED_JS_SET = new Set<string>([
  ...CORE_JS_FILES,
  ...Object.values(VIEW_CHUNK_FILES).flat(),
]);

export interface AssetEntry {
  key: string;
  signature: string;
  sha256Short: string;
  etag: string;
  contentType: string;
  compressible: boolean;
  brotliQuality: number;
  gzipLevel: number;
  raw: Uint8Array;
  br: Uint8Array | null;
  gz: Uint8Array | null;
  brPromise: Promise<Uint8Array> | null;
  gzPromise: Promise<Uint8Array> | null;
}

export function contentTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function isCompressibleContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/event-stream")) return false;
  if (lower.startsWith("text/")) return true;
  if (lower.includes("application/javascript")) return true;
  if (lower.includes("application/json")) return true;
  if (lower.includes("image/svg+xml")) return true;
  if (lower.includes("application/xml")) return true;
  return false;
}

export function negotiateEncoding(acceptEncoding: string | null): "br" | "gzip" | "identity" {
  if (!acceptEncoding) return "identity";
  let brQ = -1;
  let gzipQ = -1;
  let starQ = -1;

  for (const part of acceptEncoding.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) continue;
    const [tokenRaw, ...params] = trimmed.split(";");
    const token = tokenRaw.trim();
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (token === "br") brQ = q;
    else if (token === "gzip" || token === "x-gzip") gzipQ = Math.max(gzipQ, q);
    else if (token === "*") starQ = q;
  }

  const effectiveBr = brQ >= 0 ? brQ : starQ > 0 ? starQ : 0;
  const effectiveGzip = gzipQ >= 0 ? gzipQ : starQ > 0 ? starQ : 0;

  if (effectiveBr > 0 && effectiveBr >= effectiveGzip) return "br";
  if (effectiveGzip > 0) return "gzip";
  if (effectiveBr > 0) return "br";
  return "identity";
}

function normalizeEtagValue(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed.startsWith("W/") || trimmed.startsWith("w/")) {
    return trimmed.slice(2).trim();
  }
  return trimmed;
}

export function ifNoneMatchMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const target = normalizeEtagValue(etag);
  if (!target) return false;
  for (const part of ifNoneMatch.split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    if (candidate === "*") return true;
    if (normalizeEtagValue(candidate) === target) return true;
  }
  return false;
}

const LAZY_EXT_ASSETS = new Set<string>([
  "97-auto-ontology.css",
  "97-auto-ontology.js",
]);

export function listExtAssets(publicDir: string): { css: string[]; js: string[] } {
  const extDir = join(publicDir, "ext");
  const css: string[] = [];
  const js: string[] = [];
  try {
    const names = readdirSync(extDir).sort();
    for (const name of names) {
      if (name.startsWith(".") || LAZY_EXT_ASSETS.has(name)) continue;
      if (name.endsWith(".css")) css.push(`/ext/${name}`);
      else if (name.endsWith(".js")) js.push(`/ext/${name}`);
    }
  } catch {
    // ext directory absent
  }
  return { css, js };
}

export function resolveInitialChunk(url: URL): ViewChunkName | null {
  const params = url.searchParams;
  if (params.get("doc")) return null;
  if (params.get("node")) return "graph";
  if (params.get("person")) return "people";
  const day = params.get("day");
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return "replay";

  const view = (params.get("view") || "").trim().toLowerCase();
  if (!view) return null;
  if (view === "board" || view === "agent-board") return "board";
  if (view === "codex" || view === "mind-codex") return "codex";
  if (view === "taste" || view === "taste-studio") return "taste";
  if (view === "replay") return "replay";
  if (view === "people") return "people";
  if (view === "graph") return "graph";
  return null;
}

const jsMinifier = new Bun.Transpiler({ loader: "js", minifyWhitespace: true });

function minifyJsForBundle(js: string): string {
  try {
    return jsMinifier.transformSync(js);
  } catch {
    return js;
  }
}

function minifyCssForBundle(css: string): string {
  // Strip block comments and trim redundant line indentation/blank lines (preserves strings/calc/var intact)
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function sha256Hex12(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function buildEntry(
  key: string,
  signature: string,
  raw: Uint8Array,
  contentType: string,
  brotliQuality = 11,
  gzipLevel = 9
): AssetEntry {
  const sha256Short = sha256Hex12(raw);
  const etag = `"${sha256Short}"`;
  const compressible = isCompressibleContentType(contentType);
  return {
    key,
    signature,
    sha256Short,
    etag,
    contentType,
    compressible,
    brotliQuality,
    gzipLevel,
    raw,
    br: null,
    gz: null,
    brPromise: null,
    gzPromise: null,
  };
}

async function getCompressedBody(entry: AssetEntry, enc: "br" | "gzip"): Promise<Uint8Array | null> {
  if (!entry.compressible || entry.raw.byteLength === 0) return null;
  if (enc === "br") {
    if (entry.br) return entry.br;
    if (!entry.brPromise) {
      entry.brPromise = brotliCompressAsync(entry.raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: entry.brotliQuality,
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: entry.raw.byteLength,
        },
      }).then((buf) => {
        const out = new Uint8Array(buf);
        entry.br = out;
        entry.brPromise = null;
        return out;
      });
    }
    return entry.brPromise;
  }
  if (entry.gz) return entry.gz;
  if (!entry.gzPromise) {
    entry.gzPromise = gzipAsync(entry.raw, { level: entry.gzipLevel }).then((buf) => {
      const out = new Uint8Array(buf);
      entry.gz = out;
      entry.gzPromise = null;
      return out;
    });
  }
  return entry.gzPromise;
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }
  const parts = existing.split(",").map((s) => s.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}

export class AssetStore {
  readonly publicDir: string;
  private fileCache = new Map<string, AssetEntry>();
  private bundleCache = new Map<string, AssetEntry>();
  private htmlCache = new Map<string, AssetEntry>();

  constructor(publicDir: string) {
    this.publicDir = resolve(publicDir);
  }

  async getFileEntry(absPath: string): Promise<AssetEntry | null> {
    let st: { mtimeMs: number; size: number; isDirectory: () => boolean };
    try {
      st = await stat(absPath);
      if (st.isDirectory()) return null;
    } catch {
      this.fileCache.delete(absPath);
      return null;
    }
    const sig = `${Math.trunc(st.mtimeMs)}:${st.size}`;
    const cached = this.fileCache.get(absPath);
    if (cached && cached.signature === sig) {
      return cached;
    }
    const raw = new Uint8Array(await readFile(absPath));
    const entry = buildEntry(absPath, sig, raw, contentTypeForPath(absPath), 11, 9);
    this.fileCache.set(absPath, entry);
    return entry;
  }

  async getPublicFileEntry(relPath: string): Promise<AssetEntry | null> {
    const cleanRel = relPath.replace(/^\/+/, "");
    return this.getFileEntry(join(this.publicDir, cleanRel));
  }

  private async buildConcatBundle(
    cacheKey: string,
    relPaths: string[],
    contentType: string,
    separator: string
  ): Promise<AssetEntry | null> {
    const resolvedFiles: Array<{ rel: string; abs: string; sig: string }> = [];
    for (const rel of relPaths) {
      const cleanRel = rel.replace(/^\/+/, "");
      const abs = join(this.publicDir, cleanRel);
      try {
        const st = await stat(abs);
        if (!st.isDirectory()) {
          resolvedFiles.push({
            rel: cleanRel,
            abs,
            sig: `${cleanRel}@${Math.trunc(st.mtimeMs)}:${st.size}`,
          });
        }
      } catch {
        // Optional file absent
      }
    }
    if (resolvedFiles.length === 0) {
      this.bundleCache.delete(cacheKey);
      return null;
    }

    const combinedSig = resolvedFiles.map((f) => f.sig).join("|");
    const cached = this.bundleCache.get(cacheKey);
    if (cached && cached.signature === combinedSig) {
      return cached;
    }

    const isCssBundle = contentType.startsWith("text/css");
    const hasTokensFirst = isCssBundle && resolvedFiles.some((f) => f.abs.endsWith("/tokens.css"));
    const sepBytes = new TextEncoder().encode(separator);
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    for (let i = 0; i < resolvedFiles.length; i += 1) {
      const f = resolvedFiles[i];
      const fileEntry = await this.getFileEntry(f.abs);
      if (!fileEntry) continue;
      if (chunks.length > 0) {
        chunks.push(sepBytes);
        totalLen += sepBytes.byteLength;
      }
      let sliceBytes = fileEntry.raw;
      if (isCssBundle) {
        let text = new TextDecoder().decode(sliceBytes);
        if (hasTokensFirst && !f.abs.endsWith("/tokens.css")) {
          if (text.includes('@import url("/tokens.css")') || text.includes("@import url('/tokens.css')")) {
            text = text.replace(/@import\s+url\(["']\/tokens\.css["']\)\s*;?\s*/g, "");
          }
        }
        sliceBytes = new TextEncoder().encode(minifyCssForBundle(text));
      } else if (contentType.startsWith("application/javascript")) {
        sliceBytes = new TextEncoder().encode(minifyJsForBundle(new TextDecoder().decode(sliceBytes)));
      }
      chunks.push(sliceBytes);
      totalLen += sliceBytes.byteLength;
    }

    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }

    const entry = buildEntry(cacheKey, combinedSig, merged, contentType, 10, 9);
    this.bundleCache.set(cacheKey, entry);
    return entry;
  }

  async getCssBundle(includeExt = true): Promise<AssetEntry | null> {
    const files: string[] = ["tokens.css", ...CORE_CSS_FILES];
    if (includeExt) {
      const ext = listExtAssets(this.publicDir);
      for (const href of ext.css) {
        files.push(href.replace(/^\/+/, ""));
      }
    }
    const key = includeExt ? "bundle:app.css" : "bundle:base.css";
    return this.buildConcatBundle(key, files, "text/css; charset=utf-8", "\n");
  }

  async getJsBundle(kind: "core" | ViewChunkName): Promise<AssetEntry | null> {
    const files = kind === "core" ? [...CORE_JS_FILES] : [...VIEW_CHUNK_FILES[kind]];
    return this.buildConcatBundle(
      `bundle:${kind}.js`,
      files,
      "application/javascript; charset=utf-8",
      "\n;\n"
    );
  }

  async serveEntry(
    req: Request,
    url: URL,
    entry: AssetEntry,
    opts?: { forceNoStore?: boolean }
  ): Promise<Response> {
    const vParam = url.searchParams.get("v");
    const isStamped = Boolean(vParam && vParam === entry.sha256Short);
    const cacheControl = opts?.forceNoStore
      ? "no-store"
      : isStamped
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60";

    const headers = new Headers();
    headers.set("Content-Type", entry.contentType);
    headers.set("Cache-Control", cacheControl);
    headers.set("ETag", entry.etag);
    headers.set("X-Content-Type-Options", "nosniff");
    if (entry.compressible) {
      headers.set("Vary", "Accept-Encoding");
    }

    if (
      (req.method === "GET" || req.method === "HEAD") &&
      ifNoneMatchMatches(req.headers.get("if-none-match"), entry.etag)
    ) {
      return new Response(null, { status: 304, headers });
    }

    let body = entry.raw;
    if (entry.compressible) {
      const enc = negotiateEncoding(req.headers.get("accept-encoding"));
      if (enc === "br") {
        const br = await getCompressedBody(entry, "br");
        if (br && br.byteLength < entry.raw.byteLength) {
          body = br;
          headers.set("Content-Encoding", "br");
        }
      } else if (enc === "gzip") {
        const gz = await getCompressedBody(entry, "gzip");
        if (gz && gz.byteLength < entry.raw.byteLength) {
          body = gz;
          headers.set("Content-Encoding", "gzip");
        }
      }
    }

    headers.set("Content-Length", String(body.byteLength));
    if (req.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  }

  async getExtJsBundle(): Promise<AssetEntry | null> {
    const ext = listExtAssets(this.publicDir);
    if (ext.js.length === 0) return null;
    const files = ext.js.map((src) => src.replace(/^\/+/, ""));
    return this.buildConcatBundle(
      "bundle:ext.js",
      files,
      "application/javascript; charset=utf-8",
      "\n;\n"
    );
  }

  async serveVirtualBundle(req: Request, url: URL): Promise<Response | null> {
    const { pathname } = url;
    if (!pathname.startsWith("/bundle/")) return null;

    let entry: AssetEntry | null = null;
    if (pathname === "/bundle/app.css") {
      entry = await this.getCssBundle(true);
    } else if (pathname === "/bundle/base.css") {
      entry = await this.getCssBundle(false);
    } else if (pathname === "/bundle/core.js") {
      entry = await this.getJsBundle("core");
    } else if (pathname === "/bundle/ext.js") {
      entry = await this.getExtJsBundle();
    } else {
      const m = /^\/bundle\/chunk-(board|replay|codex|taste|people|graph)\.js$/.exec(pathname);
      if (m) {
        entry = await this.getJsBundle(m[1] as ViewChunkName);
      }
    }

    if (!entry) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return this.serveEntry(req, url, entry);
  }

  async serveIndexHtml(req: Request, url: URL, indexPath: string): Promise<Response> {
    const rawHtmlEntry = await this.getFileEntry(indexPath);
    if (!rawHtmlEntry) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const initialChunk = resolveInitialChunk(url);
    const ext = listExtAssets(this.publicDir);

    const [
      appCssBundle,
      baseCssBundle,
      coreJsBundle,
      extJsBundle,
      bootLoaderEntry,
      appJsEntry,
      tokensCssEntry,
      ontoCssEntry,
      ontoJsEntry,
      ...chunkEntries
    ] = await Promise.all([
      this.getCssBundle(true),
      this.getCssBundle(false),
      this.getJsBundle("core"),
      this.getExtJsBundle(),
      this.getPublicFileEntry("boot-loader.js"),
      this.getPublicFileEntry("app.js"),
      this.getPublicFileEntry("tokens.css"),
      this.getPublicFileEntry("ext/97-auto-ontology.css"),
      this.getPublicFileEntry("ext/97-auto-ontology.js"),
      ...VIEW_CHUNK_NAMES.map((name) => this.getJsBundle(name)),
    ]);
    const lazyExtMap: Record<string, { css?: string; js?: string }> = {};
    if (ontoCssEntry || ontoJsEntry) {
      lazyExtMap.ontology = {
        ...(ontoCssEntry ? { css: `/ext/97-auto-ontology.css?v=${ontoCssEntry.sha256Short}` } : {}),
        ...(ontoJsEntry ? { js: `/ext/97-auto-ontology.js?v=${ontoJsEntry.sha256Short}` } : {}),
      };
    }
    const bundleExts = ext.css.length + ext.js.length > 4;

    const extCssStamped = await Promise.all(
      ext.css.map(async (href) => {
        const e = await this.getPublicFileEntry(href);
        return e ? `${href}?v=${e.sha256Short}` : href;
      })
    );
    const extJsStamped = await Promise.all(
      ext.js.map(async (src) => {
        const e = await this.getPublicFileEntry(src);
        return e ? `${src}?v=${e.sha256Short}` : src;
      })
    );

    const chunkMap: Record<string, string> = {};
    const chunkSigParts: string[] = [];
    for (let i = 0; i < VIEW_CHUNK_NAMES.length; i += 1) {
      const name = VIEW_CHUNK_NAMES[i];
      const entry = chunkEntries[i];
      if (entry) {
        chunkMap[name] = `/bundle/chunk-${name}.js?v=${entry.sha256Short}`;
        chunkSigParts.push(`${name}:${entry.sha256Short}`);
      }
    }

    const fontFiles = [
      "/fonts/geist-latin-wght-normal.woff2",
      "/fonts/geist-latin-ext-wght-normal.woff2",
      "/fonts/geist-mono-latin-wght-normal.woff2",
      "/fonts/geist-mono-latin-ext-wght-normal.woff2",
      "/fonts/geist-mono-symbols2-wght-normal.woff2",
    ];
    const fontStamps = new Map<string, string>();
    const fontSigParts: string[] = [];
    for (const f of fontFiles) {
      const e = await this.getPublicFileEntry(f);
      if (e) {
        fontStamps.set(f, `${f}?v=${e.sha256Short}`);
        fontSigParts.push(`${f}:${e.sha256Short}`);
      }
    }

    const htmlSig = [
      rawHtmlEntry.signature,
      initialChunk || "none",
      appCssBundle?.sha256Short || "-",
      baseCssBundle?.sha256Short || "-",
      coreJsBundle?.sha256Short || "-",
      extJsBundle?.sha256Short || "-",
      bundleExts ? "b1" : "b0",
      bootLoaderEntry?.sha256Short || "-",
      appJsEntry?.sha256Short || "-",
      tokensCssEntry?.sha256Short || "-",
      ontoCssEntry?.sha256Short || "-",
      ontoJsEntry?.sha256Short || "-",
      extCssStamped.join(","),
      extJsStamped.join(","),
      chunkSigParts.join(","),
      fontSigParts.join(","),
    ].join("|");

    const cacheKey = `html:${initialChunk || "default"}`;
    let htmlEntry = this.htmlCache.get(cacheKey);
    if (!htmlEntry || htmlEntry.signature !== htmlSig) {
      let html = new TextDecoder("utf-8").decode(rawHtmlEntry.raw);

      // Stamp self-hosted font URLs (preload + @font-face)
      for (const [plainPath, stampedPath] of fontStamps.entries()) {
        html = html.split(`"${plainPath}"`).join(`"${stampedPath}"`);
        html = html.split(`'${plainPath}'`).join(`'${stampedPath}'`);
      }

      // Rewrite core CSS <link> tags into a single virtual CSS bundle (plus ext/*.css if present)
      let replacedCoreCss = false;
      const cssLinkRegex = /^[ \t]*<link\s+rel="stylesheet"\s+href="\/([^"?#]+\.css)"\s*\/?>[ \t]*\r?\n?/gm;
      html = html.replace(cssLinkRegex, (match, filename: string) => {
        if (!ALL_BUNDLED_CSS_SET.has(filename)) {
          return match;
        }
        if (replacedCoreCss) {
          return "";
        }
        replacedCoreCss = true;
        if (bundleExts && appCssBundle) {
          return `  <link rel="stylesheet" href="/bundle/app.css?v=${appCssBundle.sha256Short}">\n`;
        }
        if (extCssStamped.length > 0 && baseCssBundle) {
          const extLines = extCssStamped
            .map((href) => `  <link rel="stylesheet" href="${href}">`)
            .join("\n");
          return `  <link rel="stylesheet" href="/bundle/base.css?v=${baseCssBundle.sha256Short}">\n${extLines}\n`;
        }
        if (appCssBundle) {
          return `  <link rel="stylesheet" href="/bundle/app.css?v=${appCssBundle.sha256Short}">\n`;
        }
        return match;
      });

      // Fallback for minimal test index.html without the core CSS links
      if (!replacedCoreCss) {
        const extraHeadLinks: string[] = [];
        if (tokensCssEntry) {
          extraHeadLinks.push(`  <link rel="stylesheet" href="/tokens.css?v=${tokensCssEntry.sha256Short}">`);
        }
        for (const href of extCssStamped) {
          extraHeadLinks.push(`  <link rel="stylesheet" href="${href}">`);
        }
        if (extraHeadLinks.length > 0) {
          html = html.replace("</head>", `${extraHeadLinks.join("\n")}\n</head>`);
        }
      }

      // Rewrite the 24 script tags into staged boot-loader + core.js + optional active view chunk + ext/*.js + app.js
      let replacedScripts = false;
      const scriptTagRegex = /^[ \t]*<script\s+src="\/([^"?#]+\.js)"\s*><\/script>[ \t]*\r?\n?/gm;
      const hasCoreAndChunks = Boolean(coreJsBundle && bootLoaderEntry && appJsEntry);

      if (hasCoreAndChunks) {
        html = html.replace(scriptTagRegex, (match, filename: string) => {
          if (filename !== "app.js" && !ALL_BUNDLED_JS_SET.has(filename)) {
            return match;
          }
          if (filename !== "app.js") {
            return "";
          }
          if (replacedScripts) {
            return "";
          }
          replacedScripts = true;
          const manifestPayload = JSON.stringify({
            chunks: chunkMap,
            loaded: initialChunk && chunkMap[initialChunk] ? [initialChunk] : [],
            lazyExt: lazyExtMap,
          });
          const lines: string[] = [
            `  <script>window.__KIZUKI_CHUNKS__=${manifestPayload};</script>`,
            `  <script src="/boot-loader.js?v=${bootLoaderEntry!.sha256Short}"></script>`,
            `  <script src="/bundle/core.js?v=${coreJsBundle!.sha256Short}"></script>`,
          ];
          if (initialChunk && chunkMap[initialChunk]) {
            lines.push(`  <script src="${chunkMap[initialChunk]}"></script>`);
          }
          if (bundleExts && extJsBundle) {
            lines.push(`  <script src="/bundle/ext.js?v=${extJsBundle.sha256Short}"></script>`);
          } else {
            for (const src of extJsStamped) {
              lines.push(`  <script src="${src}"></script>`);
            }
          }
          lines.push(`  <script src="/app.js?v=${appJsEntry!.sha256Short}"></script>`);
          return `${lines.join("\n")}\n`;
        });
      }

      // Fallback for minimal test index.html (e.g. fixture publicDir without full JS tree)
      if (!replacedScripts) {
        if (appJsEntry) {
          html = html.replace(
            '<script src="/app.js"></script>',
            `<script src="/app.js?v=${appJsEntry.sha256Short}"></script>`
          );
        }
        if (extJsStamped.length > 0) {
          const extScripts = extJsStamped.map((src) => `  <script src="${src}"></script>`).join("\n");
          const appTagRegex = /<script\s+src="\/app\.js(?:\?v=[^"]+)?"><\/script>/;
          if (appTagRegex.test(html)) {
            html = html.replace(appTagRegex, (m) => `${extScripts}\n  ${m}`);
          } else {
            html = html.replace("</body>", `${extScripts}\n</body>`);
          }
        }
      }

      const htmlBytes = new TextEncoder().encode(html);
      htmlEntry = buildEntry(cacheKey, htmlSig, htmlBytes, "text/html; charset=utf-8", 6, 6);
      this.htmlCache.set(cacheKey, htmlEntry);
    }

    return this.serveEntry(req, url, htmlEntry, { forceNoStore: true });
  }
}

const VOLATILE_JSON_CLOCK_RE =
  /"(?:ts|generated_at|generatedAt|checked_at|checkedAt|server_time)"\s*:\s*"\d{4}-\d{2}-\d{2}T[^"]*"/g;

function computeWeakJsonEtag(raw: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(raw);
  const normalized = text.replace(VOLATILE_JSON_CLOCK_RE, '"$clock":""');
  const hashHex = Bun.hash(normalized).toString(16);
  return `W/"${hashHex}"`;
}

// Contract C5: Finalize responses once at the edge of fetchHandler.
// Preserves Cache-Control: no-store on all JSON responses, adds weak ETag + 304 on GET/HEAD,
// compresses JSON bodies > 1024 bytes with brotli (q4) or gzip (level 6), and never buffers SSE.
export async function finalizeResponse(req: Request, res: Response): Promise<Response> {
  if (res.status === 304 || res.status === 204 || res.status === 101) {
    return res;
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    return res;
  }

  if (res.headers.has("content-encoding")) {
    return res;
  }

  const isJson = contentType.includes("application/json");
  if (!isJson) {
    return res;
  }

  const raw = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  if (!headers.get("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  appendVary(headers, "Accept-Encoding");

  if (res.status === 200) {
    const weakEtag = computeWeakJsonEtag(raw);
    if (!headers.has("ETag")) {
      headers.set("ETag", weakEtag);
    }
    const activeEtag = headers.get("ETag") || weakEtag;
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      ifNoneMatchMatches(req.headers.get("if-none-match"), activeEtag)
    ) {
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      return new Response(null, { status: 304, headers });
    }
  }

  let outBody: Uint8Array = raw;
  if (raw.byteLength > 1024) {
    const enc = negotiateEncoding(req.headers.get("accept-encoding"));
    if (enc === "br") {
      const compressed = new Uint8Array(
        brotliCompressSync(raw, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
          },
        })
      );
      if (compressed.byteLength < raw.byteLength) {
        outBody = compressed;
        headers.set("Content-Encoding", "br");
      }
    } else if (enc === "gzip") {
      const compressed = new Uint8Array(gzipSync(raw, { level: 6 }));
      if (compressed.byteLength < raw.byteLength) {
        outBody = compressed;
        headers.set("Content-Encoding", "gzip");
      }
    }
  }

  headers.set("Content-Length", String(outBody.byteLength));
  if (req.method === "HEAD") {
    return new Response(null, { status: res.status, statusText: res.statusText, headers });
  }
  return new Response(outBody, { status: res.status, statusText: res.statusText, headers });
}
