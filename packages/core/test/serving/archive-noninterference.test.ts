import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanonPageCache, listCanonPagesReport } from "../../src/vault/pages";
import { serveSearch } from "../../src/serving/search";
import { serveHealth } from "../../src/serving/health";
import { page, serveFixture } from "./helpers";

test("private archived identities and bytes cannot change live scan counters, errors or served results", async () => {
  const f = await serveFixture();
  try {
    writeFileSync(join(f.vaultPath, ".kizuki", "serve.toml"), "[canon]\nmax_scan_files = 100\nmax_scan_bytes = 65536\n");
    const cache = createCanonPageCache();
    const walk = () => listCanonPagesReport(f.vaultPath, cache, { include_archived: false });
    const before = walk();
    const search = await serveSearch(f.agent("reader-public"), { query: "kettle" });
    const health = serveHealth(f.agent("reader-public"));
    for (let index = 0; index < 120; index++) {
      page(f.vaultPath, `facts/archive-${index}.md`, {
        id: index === 0 ? "fact:linked" : `fact:archived-${index}`,
        type: "fact", title: "Synthetic archived evidence", status: "archived",
        sensitivity: "private", taint: "clean", sources: [f.events["private"]!],
      }, "Synthetic private archived evidence. ".repeat(300));
    }
    page(f.vaultPath, "facts/oversized-archive.md", {
      id: "fact:oversized-archive", type: "fact", title: "Synthetic archived evidence",
      status: "archived", sensitivity: "private", taint: "clean", sources: [],
    }, "Synthetic archived body. ".repeat(50_000));
    expect(walk()).toEqual(before);
    const after = await serveSearch(f.agent("reader-public"), { query: "kettle" });
    // Envelope timestamps are caller clocks; the complete observable payload is stable.
    expect({ ...after, at: search.at }).toEqual(search);
    const afterHealth = serveHealth(f.agent("reader-public"));
    expect({ ...afterHealth, at: health.at }).toEqual(health);
    const maintenance = listCanonPagesReport(f.vaultPath);
    expect(maintenance.truncated).toBe(true);
    writeFileSync(join(f.vaultPath, ".kizuki", "serve.toml"), "[canon]\nmax_scan_files = 500\nmax_scan_bytes = 268435456\n");
    const complete = listCanonPagesReport(f.vaultPath);
    expect(complete.truncated).toBe(false);
    expect(complete.skipped.filter(skip => skip.code === "duplicate")).toHaveLength(2);
  } finally { f.dispose(); }
});
