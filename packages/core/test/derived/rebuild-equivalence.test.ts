import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPurgeRewrite } from "../../src/canon/apply";
import { rebuildDerived, refreshDerivedPage } from "../../src/derived";
import { neighbors } from "../../src/graph/graph";
import { indexEvent } from "../../src/search/indexer";
import { search } from "../../src/search/query";
import { serializePage } from "../../src/vault/frontmatter";
import type { CanonPage } from "../../src/vault/pages";
import { searchDb, storedEvent, tempVault } from "../search/helpers";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function writeCanonPage(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): CanonPage {
  writeFileSync(join(vaultPath, relPath), serializePage({ data, body }), "utf8");
  return {
    id: String(data["id"]),
    path: join(vaultPath, relPath),
    relPath,
    data,
    body,
  };
}

describe("derived rebuild equivalence", () => {
  test("incremental search and graph match a full rebuild", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);

    const tea = writeCanonPage(
      vault.path,
      "facts/tea.md",
      {
        id: "fact:tea",
        title: "Tea",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        subjects: ["person:ada"],
        sources: ["event:source"],
      },
      "Tea uses a [[Kettle]].",
    );
    const kettle = writeCanonPage(
      vault.path,
      "facts/kettle.md",
      {
        id: "fact:kettle",
        title: "Kettle",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "A copper kettle.",
    );
    const event = storedEvent(db, "mail", { text: "Ledger tea note." });
    refreshDerivedPage(db, tea, vault.path);
    refreshDerivedPage(db, kettle, vault.path);
    indexEvent(db, event);

    const incrementalSearch = search(db, "tea")
      .map(({ doc_id }) => doc_id)
      .sort();
    const incrementalGraph = neighbors(db, "fact:tea")
      .edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`)
      .sort();

    rebuildDerived(db, vault.path);

    expect(search(db, "tea").map(({ doc_id }) => doc_id).sort()).toEqual(
      incrementalSearch,
    );
    expect(
      neighbors(db, "fact:tea")
        .edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`)
        .sort(),
    ).toEqual(incrementalGraph);
    expect(incrementalSearch).toEqual([
      `event:${event.event_id}`,
      "page:fact:tea",
    ]);
    expect(incrementalGraph).toContain("fact:tea|fact:kettle|wikilink");
  });

  test("refreshing an archived page drops incoming edges and a restore brings them back", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    const target = writeCanonPage(
      vault.path,
      "facts/target.md",
      {
        id: "fact:target",
        title: "Target",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "Destination.",
    );
    writeCanonPage(
      vault.path,
      "facts/origin.md",
      {
        id: "fact:origin",
        title: "Origin",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "See [[Target]].",
    );
    rebuildDerived(db, vault.path);
    expect(
      neighbors(db, "fact:target").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(["fact:origin|fact:target|wikilink"]);

    writeCanonPage(
      vault.path,
      "facts/target.md",
      { ...target.data, status: "archived" },
      target.body,
    );
    refreshDerivedPage(
      db,
      { ...target, data: { ...target.data, status: "archived" } },
      vault.path,
    );
    expect(neighbors(db, "fact:target").edges).toEqual([]);
    expect(search(db, "Destination").map(({ doc_id }) => doc_id)).toEqual([]);

    writeCanonPage(
      vault.path,
      "facts/target.md",
      target.data,
      target.body,
    );
    refreshDerivedPage(db, target, vault.path);
    expect(
      neighbors(db, "fact:target").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(["fact:origin|fact:target|wikilink"]);
    rebuildDerived(db, vault.path);
    expect(
      neighbors(db, "fact:target").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(["fact:origin|fact:target|wikilink"]);
  });

  test("refreshing a page rewrites other pages when resolution changes", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    const origin = writeCanonPage(
      vault.path,
      "facts/origin.md",
      {
        id: "fact:origin",
        title: "Origin",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "See [[Target]].",
    );
    refreshDerivedPage(db, origin, vault.path);
    expect(
      neighbors(db, "fact:origin").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(["fact:origin|Target|wikilink"]);

    const target = writeCanonPage(
      vault.path,
      "facts/target.md",
      {
        id: "fact:target",
        title: "Target",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "Destination.",
    );
    refreshDerivedPage(db, target, vault.path);
    const resolved = ["fact:origin|fact:target|wikilink"];
    expect(
      neighbors(db, "fact:origin").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(resolved);
    rebuildDerived(db, vault.path);
    expect(
      neighbors(db, "fact:origin").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(resolved);

    writeCanonPage(
      vault.path,
      "facts/target.md",
      { ...target.data, title: "Other" },
      target.body,
    );
    refreshDerivedPage(
      db,
      { ...target, data: { ...target.data, title: "Other" } },
      vault.path,
    );
    const raw = ["fact:origin|Target|wikilink"];
    expect(
      neighbors(db, "fact:origin").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(raw);
    rebuildDerived(db, vault.path);
    expect(
      neighbors(db, "fact:origin").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(raw);
  });

  test("purged and archived pages are absent after rebuild", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanonPage(
      vault.path,
      "facts/live.md",
      {
        id: "fact:live",
        title: "Live",
        type: "fact",
        status: "active",
        sensitivity: "public",
        taint: "clean",
      },
      "keepword",
    );
    writeCanonPage(
      vault.path,
      "facts/old.md",
      {
        id: "fact:old",
        title: "Old",
        type: "fact",
        status: "archived",
        sensitivity: "public",
        taint: "clean",
      },
      "keepword gone",
    );
    storedEvent(db, "gone", { text: "keepword deleted", deleted: true });
    rebuildDerived(db, vault.path);
    expect(search(db, "keepword").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:live",
    ]);
  });

  test("purge rewrite refreshes search and drops archived incoming edges", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanonPage(
      vault.path,
      "facts/tea.md",
      {
        id: "fact:tea",
        title: "Tea",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: ["event:keep", "event:purge"],
      },
      "keepword secretword",
    );
    writeCanonPage(
      vault.path,
      "facts/kettle.md",
      {
        id: "fact:kettle",
        title: "Kettle",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
      },
      "See [[Tea]].",
    );
    rebuildDerived(db, vault.path);
    expect(search(db, "secretword").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:tea",
    ]);
    expect(
      neighbors(db, "fact:tea").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`).sort(),
    ).toEqual([
      "fact:kettle|fact:tea|wikilink",
      "fact:tea|event:keep|source",
      "fact:tea|event:purge|source",
    ]);

    applyPurgeRewrite(
      { db, vault_path: vault.path },
      {
        rel_path: "facts/tea.md",
        purged_event_ids: ["event:purge"],
        purged_claim_ids: ["claim:purged"],
        purged_claim_bodies: ["secretword"],
      },
    );
    expect(search(db, "secretword")).toEqual([]);
    expect(search(db, "keepword").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:tea",
    ]);
    expect(
      neighbors(db, "fact:tea").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`).sort(),
    ).toEqual([
      "fact:kettle|fact:tea|wikilink",
      "fact:tea|event:keep|source",
    ]);

    applyPurgeRewrite(
      { db, vault_path: vault.path },
      {
        rel_path: "facts/tea.md",
        purged_event_ids: ["event:keep"],
        purged_claim_ids: ["claim:rest"],
        purged_claim_bodies: ["keepword"],
      },
    );
    expect(search(db, "keepword")).toEqual([]);
    expect(neighbors(db, "fact:tea").edges).toEqual([]);
    expect(
      neighbors(db, "fact:kettle").edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}`),
    ).toEqual(["fact:kettle|Tea|wikilink"]);
  });
});
