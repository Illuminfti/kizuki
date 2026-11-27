import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { seedSyntheticVaultDb } from "./test-vault-fixture.ts";
import { createExplorerApp, DEFAULT_HOST, DEFAULT_PUBLIC_DIR } from "./server.ts";
import {
  AssetStore,
  finalizeResponse,
  ifNoneMatchMatches,
  negotiateEncoding,
  resolveInitialChunk,
  VIEW_CHUNK_NAMES,
} from "./http-wire.ts";

describe("Area 2 HTTP wire: precompression, ETag/304, conditional JSON C5, staged boot, self-hosted fonts", () => {
  let app: ReturnType<typeof createExplorerApp>;
  let tmpVault = "";

  beforeAll(() => {
    tmpVault = mkdtempSync(join(tmpdir(), "kizuki-wire-test-"));
    mkdirSync(join(tmpVault, ".kizuki", "bridges"), { recursive: true });
    const dbPath = join(tmpVault, ".kizuki", "kizuki.db");
    seedSyntheticVaultDb(dbPath);
    app = createExplorerApp({
      publicDir: DEFAULT_PUBLIC_DIR,
      vaultConfig: {
        vaultPath: tmpVault,
        dbPath,
        bridgesDir: join(tmpVault, ".kizuki", "bridges"),
        antigravityJsonlPath: join(tmpVault, ".kizuki", "evidence.jsonl"),
        lifeosPeopleDir: null,
        relationshipsDir: null,
      },
      agentBoardConfig: {
        dbPath: join(tmpVault, ".kizuki", "agent-board.db"),
      },
    });
  });

  afterAll(() => {
    app?.close();
    if (tmpVault) {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  test("DEFAULT_HOST invariant remains 127.0.0.1", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  test("Accept-Encoding: br on /app.js drops size <= 85,000 B with Content-Encoding: br, Vary, and strong ETag", async () => {
    const rawRes = await app.fetch(new Request("http://127.0.0.1/app.js"));
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("content-encoding")).toBeNull();
    const rawBuf = new Uint8Array(await rawRes.arrayBuffer());
    expect(rawBuf.byteLength).toBeGreaterThan(400_000);

    const brRes = await app.fetch(
      new Request("http://127.0.0.1/app.js", {
        headers: { "Accept-Encoding": "br, gzip" },
      })
    );
    expect(brRes.status).toBe(200);
    expect(brRes.headers.get("content-encoding")).toBe("br");
    expect(brRes.headers.get("vary")).toContain("Accept-Encoding");
    expect(brRes.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = brRes.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/);

    const brBuf = new Uint8Array(await brRes.arrayBuffer());
    expect(brBuf.byteLength).toBeLessThanOrEqual(85_000);

    const decompressed = new Uint8Array(brotliDecompressSync(brBuf));
    expect(decompressed.byteLength).toBe(rawBuf.byteLength);

    // Gzip negotiation also works cleanly
    const gzRes = await app.fetch(
      new Request("http://127.0.0.1/app.js", {
        headers: { "Accept-Encoding": "gzip" },
      })
    );
    expect(gzRes.status).toBe(200);
    expect(gzRes.headers.get("content-encoding")).toBe("gzip");
    const gzBuf = new Uint8Array(await gzRes.arrayBuffer());
    expect(gzBuf.byteLength).toBeLessThan(110_000);
    expect(new Uint8Array(gunzipSync(gzBuf)).byteLength).toBe(rawBuf.byteLength);
  });

  test("Stamped ?v=<12hex> URLs receive immutable Cache-Control and If-None-Match returns 304", async () => {
    const first = await app.fetch(
      new Request("http://127.0.0.1/app.js", { headers: { "Accept-Encoding": "br" } })
    );
    const etag = first.headers.get("etag")!;
    const hash = etag.replace(/"/g, "");

    const stamped = await app.fetch(
      new Request(`http://127.0.0.1/app.js?v=${hash}`, {
        headers: { "Accept-Encoding": "br" },
      })
    );
    expect(stamped.status).toBe(200);
    expect(stamped.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(stamped.headers.get("etag")).toBe(etag);

    const notMod = await app.fetch(
      new Request(`http://127.0.0.1/app.js?v=${hash}`, {
        headers: { "Accept-Encoding": "br", "If-None-Match": etag },
      })
    );
    expect(notMod.status).toBe(304);
    expect(notMod.headers.get("etag")).toBe(etag);
    expect(notMod.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await notMod.arrayBuffer()).byteLength).toBe(0);
  });

  test("Virtual bundles (/bundle/app.css, /bundle/core.js, /bundle/chunk-<view>.js) serve precompressed with strong ETag", async () => {
    const [cssRes, coreRes, ...chunkResList] = await Promise.all([
      app.fetch(
        new Request("http://127.0.0.1/bundle/app.css", {
          headers: { "Accept-Encoding": "br" },
        })
      ),
      app.fetch(
        new Request("http://127.0.0.1/bundle/core.js", {
          headers: { "Accept-Encoding": "br" },
        })
      ),
      ...VIEW_CHUNK_NAMES.map((view) =>
        app.fetch(
          new Request(`http://127.0.0.1/bundle/chunk-${view}.js`, {
            headers: { "Accept-Encoding": "br" },
          })
        )
      ),
    ]);

    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    expect(cssRes.headers.get("content-encoding")).toBe("br");
    expect(cssRes.headers.get("etag")).toMatch(/^"[0-9a-f]{12}"$/);
    const cssBr = new Uint8Array(await cssRes.arrayBuffer());
    expect(cssBr.byteLength).toBeLessThan(85_000);
    const cssText = new TextDecoder().decode(brotliDecompressSync(cssBr));
    expect(cssText).toContain("--font-sans");

    expect(coreRes.status).toBe(200);
    expect(coreRes.headers.get("content-encoding")).toBe("br");
    const coreBr = new Uint8Array(await coreRes.arrayBuffer());
    expect(coreBr.byteLength).toBeLessThan(95_000);

    for (const res of chunkResList) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{12}"$/);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.byteLength).toBeGreaterThan(500);
    }
  });

  test("Contract C5: /api/health keeps Cache-Control: no-store, emits weak ETag, and honors If-None-Match 304", async () => {
    const res1 = await app.fetch(new Request("http://127.0.0.1/api/health"));
    expect(res1.status).toBe(200);
    expect(res1.headers.get("cache-control")).toBe("no-store");
    const etag = res1.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(res1.headers.get("vary")).toContain("Accept-Encoding");

    const res2 = await app.fetch(
      new Request("http://127.0.0.1/api/health", {
        headers: { "If-None-Match": etag! },
      })
    );
    expect(res2.status).toBe(304);
    expect(res2.headers.get("cache-control")).toBe("no-store");
    expect(res2.headers.get("etag")).toBe(etag);
    expect((await res2.arrayBuffer()).byteLength).toBe(0);
  });

  test("Contract C5: large JSON (> 1024 B) compresses with brotli/gzip, preserves no-store, and returns 304 on match", async () => {
    const payload = {
      ok: true,
      items: Array.from({ length: 80 }, (_, i) => ({
        id: i,
        title: `Deterministic item ${i} with repeatable structure for brotli compression check`,
        tags: ["kizuki", "perf", "wire"],
      })),
    };
    const makeRes = () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });

    const reqBr = new Request("http://127.0.0.1/api/synthetic-large", {
      headers: { "Accept-Encoding": "br" },
    });
    const outBr = await finalizeResponse(reqBr, makeRes());
    expect(outBr.status).toBe(200);
    expect(outBr.headers.get("cache-control")).toBe("no-store");
    expect(outBr.headers.get("content-encoding")).toBe("br");
    expect(outBr.headers.get("vary")).toContain("Accept-Encoding");
    const etag = outBr.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);

    const compressedBytes = new Uint8Array(await outBr.arrayBuffer());
    const rawSize = JSON.stringify(payload).length;
    expect(compressedBytes.byteLength).toBeLessThan(rawSize / 4);
    expect(JSON.parse(new TextDecoder().decode(brotliDecompressSync(compressedBytes)))).toEqual(payload);

    // Matching If-None-Match yields 304 with Cache-Control: no-store
    const req304 = new Request("http://127.0.0.1/api/synthetic-large", {
      headers: { "Accept-Encoding": "br", "If-None-Match": etag! },
    });
    const out304 = await finalizeResponse(req304, makeRes());
    expect(out304.status).toBe(304);
    expect(out304.headers.get("cache-control")).toBe("no-store");
    expect(out304.headers.get("etag")).toBe(etag);

    // POST mutations never return 304 even with matching If-None-Match
    const reqPost = new Request("http://127.0.0.1/api/synthetic-large", {
      method: "POST",
      headers: {
        "Accept-Encoding": "br",
        "If-None-Match": etag!,
        "X-Kizuki-Request": "1",
      },
    });
    const outPost = await finalizeResponse(reqPost, makeRes());
    expect(outPost.status).toBe(200);
    expect(outPost.headers.get("cache-control")).toBe("no-store");
  });

  test("Contract C5: text/event-stream is never buffered or compressed", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode("event: ping\ndata: {\"ok\":true}\n\n"));
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 }
    );
    const sseRes = new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
      },
    });
    const out = await finalizeResponse(
      new Request("http://127.0.0.1/api/agent-board/stream", {
        headers: { "Accept-Encoding": "br, gzip" },
      }),
      sseRes
    );
    expect(out).toBe(sseRes);
    expect(out.bodyUsed).toBe(false);
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(pulled).toBe(false);
    const bodyText = await out.text();
    expect(bodyText).toContain("event: ping");
    expect(pulled).toBe(true);
  });

  test("index.html removes third-party Google Fonts, serves self-hosted Geist fonts, and stages bundles", async () => {
    const resToday = await app.fetch(new Request("http://127.0.0.1/?view=today"));
    expect(resToday.status).toBe(200);
    expect(resToday.headers.get("cache-control")).toBe("no-store");
    const htmlToday = await resToday.text();

    // Zero third-party font origins
    expect(htmlToday).not.toContain("fonts.googleapis.com");
    expect(htmlToday).not.toContain("fonts.gstatic.com");

    // Self-hosted stamped woff2 preloads and @font-face
    expect(htmlToday).toMatch(/\/fonts\/geist-latin-wght-normal\.woff2\?v=[0-9a-f]{12}/);
    expect(htmlToday).toMatch(/\/fonts\/geist-mono-latin-wght-normal\.woff2\?v=[0-9a-f]{12}/);
    expect(htmlToday).toContain("font-display: swap");

    // Single core CSS bundle (app.css or base.css + ext/*.css) + staged boot loader + core.js + stamped app.js
    expect(htmlToday).toMatch(/\/bundle\/(?:app|base)\.css\?v=[0-9a-f]{12}/);
    expect(htmlToday).toMatch(/\/boot-loader\.js\?v=[0-9a-f]{12}/);
    expect(htmlToday).toMatch(/\/bundle\/core\.js\?v=[0-9a-f]{12}/);
    expect(htmlToday).toMatch(/\/app\.js\?v=[0-9a-f]{12}/);
    // Today should NOT eagerly include board or replay script tags
    expect(htmlToday).not.toContain('<script src="/bundle/chunk-board.js');
    expect(htmlToday).not.toContain('<script src="/bundle/chunk-replay.js');

    // Opening /?view=board eagerly includes chunk-board.js before app.js
    const resBoard = await app.fetch(new Request("http://127.0.0.1/?view=board"));
    const htmlBoard = await resBoard.text();
    const boardChunkIdx = htmlBoard.indexOf("/bundle/chunk-board.js?v=");
    const appJsIdx = htmlBoard.indexOf('<script src="/app.js?v=');
    expect(boardChunkIdx).toBeGreaterThan(-1);
    expect(appJsIdx).toBeGreaterThan(boardChunkIdx);

    // Self-hosted font asset serves with immutable Cache-Control and font/woff2 without double compression
    const fontMatch = /\/fonts\/geist-latin-wght-normal\.woff2\?v=([0-9a-f]{12})/.exec(htmlToday);
    expect(fontMatch).not.toBeNull();
    const fontRes = await app.fetch(
      new Request(`http://127.0.0.1${fontMatch![0]}`, {
        headers: { "Accept-Encoding": "br, gzip" },
      })
    );
    expect(fontRes.status).toBe(200);
    expect(fontRes.headers.get("content-type")).toBe("font/woff2");
    expect(fontRes.headers.get("content-encoding")).toBeNull();
    expect(fontRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("S0-b: index.html auto-injects public/tokens.css (first in CSS bundle) and public/ext/*.{css,js}", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kizuki-wire-ext-"));
    try {
      mkdirSync(join(tempDir, "ext"), { recursive: true });
      writeFileSync(join(tempDir, "tokens.css"), ":root { --t-base: 13px; }\n");
      writeFileSync(join(tempDir, "styles.css"), "body { font-size: var(--t-base); }\n");
      writeFileSync(join(tempDir, "markdown.js"), "window.KizukiMarkdown = {};\n");
      writeFileSync(join(tempDir, "boot-loader.js"), "window.KizukiLoader = {};\n");
      writeFileSync(join(tempDir, "app.js"), "console.log('app');\n");
      writeFileSync(join(tempDir, "ext", "00-net-coalesce.js"), "window.__EXT_NET__ = true;\n");
      writeFileSync(join(tempDir, "ext", "10-radar.js"), "window.__EXT_RADAR__ = true;\n");
      writeFileSync(join(tempDir, "ext", "10-radar.css"), ".radar { color: red; }\n");
      writeFileSync(
        join(tempDir, "index.html"),
        `<!doctype html><html><head>
  <link rel="stylesheet" href="/styles.css">
</head><body>
  <script src="/markdown.js"></script>
  <script src="/app.js"></script>
</body></html>`
      );

      const store = new AssetStore(tempDir);

      // /bundle/app.css includes tokens.css FIRST, then styles.css, then ext/10-radar.css
      const cssBundleRes = await store.serveVirtualBundle(
        new Request("http://127.0.0.1/bundle/app.css"),
        new URL("http://127.0.0.1/bundle/app.css")
      );
      expect(cssBundleRes).not.toBeNull();
      const cssBundleText = await cssBundleRes!.text();
      const idxTokens = cssBundleText.indexOf("--t-base: 13px");
      const idxStyles = cssBundleText.indexOf("font-size: var(--t-base)");
      const idxExtCss = cssBundleText.indexOf(".radar { color: red; }");
      expect(idxTokens).toBeGreaterThan(-1);
      expect(idxStyles).toBeGreaterThan(idxTokens);
      expect(idxExtCss).toBeGreaterThan(idxStyles);

      // index.html injects stamped ext/*.css and sorted ext/*.js strictly before app.js
      const htmlRes = await store.serveIndexHtml(
        new Request("http://127.0.0.1/"),
        new URL("http://127.0.0.1/"),
        join(tempDir, "index.html")
      );
      const html = await htmlRes.text();
      expect(html).toMatch(/\/bundle\/base\.css\?v=[0-9a-f]{12}/);
      expect(html).toMatch(/\/ext\/10-radar\.css\?v=[0-9a-f]{12}/);
      const idxNet = html.indexOf("/ext/00-net-coalesce.js?v=");
      const idxRadar = html.indexOf("/ext/10-radar.js?v=");
      const idxApp = html.indexOf("/app.js?v=");
      expect(idxNet).toBeGreaterThan(-1);
      expect(idxRadar).toBeGreaterThan(idxNet);
      expect(idxApp).toBeGreaterThan(idxRadar);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("Unit helpers: negotiateEncoding, ifNoneMatchMatches, resolveInitialChunk", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("br;q=0, gzip;q=0.8")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBe("identity");
    expect(negotiateEncoding(null)).toBe("identity");

    expect(ifNoneMatchMatches('"abc123"', '"abc123"')).toBe(true);
    expect(ifNoneMatchMatches('W/"abc123"', '"abc123"')).toBe(true);
    expect(ifNoneMatchMatches('"other", W/"abc123"', 'W/"abc123"')).toBe(true);
    expect(ifNoneMatchMatches("*", '"abc123"')).toBe(true);
    expect(ifNoneMatchMatches('"nope"', '"abc123"')).toBe(false);

    expect(resolveInitialChunk(new URL("http://127.0.0.1/?view=today"))).toBeNull();
    expect(resolveInitialChunk(new URL("http://127.0.0.1/?view=board"))).toBe("board");
    expect(resolveInitialChunk(new URL("http://127.0.0.1/?view=agent-board"))).toBe("board");
    expect(resolveInitialChunk(new URL("http://127.0.0.1/?person=chris"))).toBe("people");
    expect(resolveInitialChunk(new URL("http://127.0.0.1/?day=2026-11-26"))).toBe("replay");
    expect(resolveInitialChunk(new URL("http://127.0.0.1/?node=n1"))).toBe("graph");
  });

  test("Today first-load static wire total (HTML + CSS + core + app + boot-loader + latin fonts) is well under 600 KB", async () => {
    const htmlRes = await app.fetch(
      new Request("http://127.0.0.1/?view=today", { headers: { "Accept-Encoding": "br" } })
    );
    const htmlBr = new Uint8Array(await htmlRes.arrayBuffer());
    const htmlText = new TextDecoder().decode(brotliDecompressSync(htmlBr));

    const assetUrls = new Set<string>();
    for (const m of htmlText.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
      const u = m[1];
      if (u.startsWith("/fonts/") && !u.includes("-latin-wght-")) continue;
      assetUrls.add(u);
    }

    let totalWireBytes = htmlBr.byteLength;
    for (const u of assetUrls) {
      const r = await app.fetch(
        new Request(`http://127.0.0.1${u}`, { headers: { "Accept-Encoding": "br" } })
      );
      expect(r.status).toBe(200);
      totalWireBytes += (await r.arrayBuffer()).byteLength;
    }

    // Total static requests on Today first load <= 14 (including any S0-b ext plugins)
    expect(assetUrls.size + 1).toBeLessThanOrEqual(14);
    // Total static wire bytes <= 350 KB (leaving huge headroom under the 600 KB total budget)
    expect(totalWireBytes).toBeLessThanOrEqual(350_000);
  });

  test("Contract C5: weak ETag ignores volatile server clock timestamps but changes on real payload changes", async () => {
    const mk = (body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });

    const r1 = await finalizeResponse(
      new Request("http://127.0.0.1/api/x"),
      mk({ ok: true, count: 5, ts: "2026-11-27T02:00:00.001Z" })
    );
    const etag1 = r1.headers.get("etag")!;

    // Different ts, same semantic payload -> 304
    const r2 = await finalizeResponse(
      new Request("http://127.0.0.1/api/x", { headers: { "If-None-Match": etag1 } }),
      mk({ ok: true, count: 5, ts: "2026-11-27T02:00:05.999Z" })
    );
    expect(r2.status).toBe(304);
    expect(r2.headers.get("cache-control")).toBe("no-store");

    // Different real payload -> 200 with new ETag
    const r3 = await finalizeResponse(
      new Request("http://127.0.0.1/api/x", { headers: { "If-None-Match": etag1 } }),
      mk({ ok: true, count: 6, ts: "2026-11-27T02:00:06.000Z" })
    );
    expect(r3.status).toBe(200);
    expect(r3.headers.get("etag")).not.toBe(etag1);
    expect(r3.headers.get("cache-control")).toBe("no-store");
  });
});
