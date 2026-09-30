import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../../src/internal";
import {
  editRetrievalPortToml,
  loadConfiguredRetrieval,
  persistConfiguredRetrieval,
  readRetrievalPortState,
} from "../../src/retrieval/config";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

function vault(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "retrieval-persist-"));
  roots.push(root);
  mkdirSync(join(root, ".kizuki"), { recursive: true, mode: 0o700 });
  if (contents !== undefined) writeFileSync(join(root, ".kizuki", "serve.toml"), contents, { mode: 0o600 });
  return root;
}

test("editRetrievalPortToml preserves unrelated keys and canonicalizes pg", () => {
  const next = editRetrievalPortToml("[budget]\ncanon_writes_per_run = 0\n", "kizuki.retrieval.pg");
  expect(next).toContain("canon_writes_per_run = 0");
  expect(next).toContain('retrieval = "kizuki.retrieval.embedded-pg"');
  expect(() => editRetrievalPortToml(null, "kizuki.retrieval.no-such")).toThrow();
});

test("persistConfiguredRetrieval activates serve.toml and port_state", () => {
  const root = vault("[budget]\ncanon_writes_per_run = 0\n");
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  try {
    const bound = persistConfiguredRetrieval(db, root, "kizuki.retrieval.embedded-pg", {
      now: "2026-09-16T00:00:00Z",
    });
    expect(bound).toMatchObject({
      kind: "retrieval",
      port_id: "kizuki.retrieval.embedded-pg",
      contract: "kizuki.retrieval/v1",
      contract_minor: 0,
      space: null,
      bound_at: "2026-09-16T00:00:00Z",
    });
    expect(loadConfiguredRetrieval(root).id).toBe("kizuki.retrieval.embedded-pg");
    expect(readFileSync(join(root, ".kizuki", "serve.toml"), "utf8")).toContain("canon_writes_per_run = 0");
    expect(readRetrievalPortState(db)?.port_id).toBe("kizuki.retrieval.embedded-pg");
  } finally {
    db.close();
  }
});

test("a failed port_state write restores the previous serve.toml", () => {
  const root = vault('[ports]\nretrieval = "kizuki.retrieval.fts5"\n');
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  persistConfiguredRetrieval(db, root, "kizuki.retrieval.fts5", { now: "2026-09-16T00:00:00Z" });
  const previous = readFileSync(join(root, ".kizuki", "serve.toml"), "utf8");
  db.close();
  expect(() => persistConfiguredRetrieval(db, root, "kizuki.retrieval.embedded-pg", {
    now: "2026-09-16T00:00:01Z",
  })).toThrow();
  expect(readFileSync(join(root, ".kizuki", "serve.toml"), "utf8")).toBe(previous);
  expect(loadConfiguredRetrieval(root).id).toBe("kizuki.retrieval.fts5");
});

test("a closed control directory cannot flip the default", () => {
  const root = vault();
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  try {
    persistConfiguredRetrieval(db, root, "kizuki.retrieval.fts5", { now: "2026-09-16T00:00:00Z" });
    chmodSync(join(root, ".kizuki"), 0o500);
    expect(() => persistConfiguredRetrieval(db, root, "kizuki.retrieval.embedded-pg")).toThrow();
    chmodSync(join(root, ".kizuki"), 0o700);
    expect(loadConfiguredRetrieval(root).id).toBe("kizuki.retrieval.fts5");
    expect(existsSync(join(root, ".kizuki", "serve.toml"))).toBe(true);
  } finally {
    try { chmodSync(join(root, ".kizuki"), 0o700); } catch { /* restore for cleanup */ }
    db.close();
  }
});
