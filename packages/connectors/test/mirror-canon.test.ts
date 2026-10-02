import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker, initVault, parseFrontmatter, registerConnection, runToCompletion, runWritePass, setSourceGrant } from "@kizuki/core";
import type { ProducerPort } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { markdownCommittedIdentities, wikiCommittedIdentities } from "../../cli/src/connections";
import { recordHistory } from "../../cli/src/mirror-history";
import { createLegacyWikiConnector, createMarkdownFolderConnector, LEGACY_WIKI_CONNECTOR_ID, MARKDOWN_FOLDER_CONNECTOR_ID } from "../src";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const SOURCE = "01JJ0000000000000000000001";
const producer: ProducerPort = {
  descriptor: {
    id: "kizuki.producer.mirror-test", kind: "producer", contract: "kizuki.producer/v1",
    contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null,
  },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
};

function fixture(kind: "wiki" | "folder", count = 1) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-mirror-canon-"));
  roots.push(root);
  const vault = join(root, "vault");
  const source = join(root, "source");
  initVault(vault);
  mkdirSync(source);
  if (kind === "wiki") writeFileSync(join(source, "kizuki-mapping.json"), JSON.stringify({
    schema: "kizuki.legacy-wiki-mapping/v1", type: { default: "topic" },
  }));
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const id = kind === "wiki" ? LEGACY_WIKI_CONNECTOR_ID : MARKDOWN_FOLDER_CONNECTOR_ID;
  registerConnection(db, id, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE, expected_revision: 0, operation_id: "mirror-canon-grant",
    policy: {
      purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    },
  });
  const name = (index: number) => `p${index}.md`;
  const put = (index: number, body = `state A ${index}`) =>
    writeFileSync(join(source, name(index)), kind === "wiki" ? `---\ntitle: Page ${index}\n---\n${body}\n` : `${body}\n`);
  for (let index = 0; index < count; index++) put(index);
  const sync = () => runToCompletion(db, kind === "wiki" ? createLegacyWikiConnector({ path: source }, {
    committedFiles: () => wikiCommittedIdentities(db, SOURCE),
    recordHistory: (ids) => recordHistory(db, id, SOURCE, ids),
  }) : createMarkdownFolderConnector({ path: source }, {
    committedFiles: () => markdownCommittedIdentities(db, SOURCE),
    recordHistory: (ids) => recordHistory(db, id, SOURCE, ids),
  }), id, SOURCE, "sync", { vault_path: vault });
  const write = () => runWritePass(db, vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 32 }), producer,
    model_ref: "kizuki.llm.synthetic:mirror-test", claims: { db },
  });
  const pages = () => db.query<{ page_id: string; rel_path: string }, []>(
    "SELECT page_id, rel_path FROM page_index WHERE rel_path LIKE 'auto/%' ORDER BY rel_path",
  ).all().map((row) => ({ ...row, page: parseFrontmatter(readFileSync(join(vault, row.rel_path), "utf8")) }));
  const text = () => {
    // A capture can be composed onto its existing subject page, whose type
    // stays unchanged. Find its quoted source text rather than a page type.
    const found = pages().find((row) => kind === "wiki" || row.page.body.includes("> state "));
    expect(found).toBeDefined();
    const page = found!.page;
    return kind === "wiki" ? page.body.trim() : (page.body.match(/^> .+$/gm) ?? []).map((line) => line.slice(2)).join("\n");
  };
  return { db, source, put, sync, write, pages, name, text };
}

for (const kind of ["wiki", "folder"] as const) {
test(`${kind} A to B to A replaces canon with A and the next sync emits no events`, async () => {
  const h = fixture(kind);
  try {
    expect((await h.sync()).errors).toEqual([]);
    expect((await h.write()).errors).toEqual([]);
    const id = h.pages()[0]!.page_id;
    h.put(0, "state B");
    expect((await h.sync()).stored).toBe(1);
    expect((await h.write()).errors).toEqual([]);
    expect(h.text()).toBe("state B");
    h.put(0);
    expect((await h.sync()).stored).toBe(1);
    expect((await h.write()).errors).toEqual([]);
    expect(h.text()).toBe("state A 0");
    expect(h.pages()[0]!.page_id).toBe(id);
    expect((await h.sync()).stored).toBe(0);
  } finally { h.db.close(); }
});

test(`a ${kind} restore leaves the same canon page active and the next sync emits no events`, async () => {
  const h = fixture(kind);
  try {
    await h.sync();
    await h.write();
    const id = h.pages()[0]!.page_id;
    unlinkSync(join(h.source, h.name(0)));
    expect((await h.sync()).errors).toEqual([]);
    expect((await h.write()).errors).toEqual([]);
    expect(h.pages()[0]!.page.data["status"]).toBe("archived");
    h.put(0);
    expect((await h.sync()).stored).toBe(1);
    expect((await h.write()).errors).toEqual([]);
    expect(h.pages()).toHaveLength(1);
    expect(h.pages()[0]!.page_id).toBe(id);
    expect(h.pages()[0]!.page.data["status"]).toBe("active");
    expect(h.text()).toBe("state A 0");
    expect((await h.sync()).stored).toBe(0);
  } finally { h.db.close(); }
});

test(`ten ${kind} renames emit ten events and preserve ten active page identities without twins`, async () => {
  const h = fixture(kind, 10);
  try {
    await h.sync();
    await h.write();
    const before = h.pages().map((page) => page.page_id);
    for (let index = 0; index < 10; index++) renameSync(join(h.source, h.name(index)), join(h.source, `moved-${h.name(index)}`));
    expect(await h.sync()).toMatchObject({ stored: 10, withdrawn: 0, retractions_filed: 0, errors: [] });
    expect((await h.write()).errors).toEqual([]);
    const after = h.pages();
    expect(after.map((page) => page.page_id)).toEqual(before);
    expect(after.every((page) => page.page.data["status"] === "active")).toBe(true);
    if (kind === "wiki") for (let index = 0; index < 10; index++) expect(after[index]!.page.body.trim()).toMatch(/^state A \d$/);
    expect((await h.sync()).stored).toBe(0);
  } finally { h.db.close(); }
});
}
