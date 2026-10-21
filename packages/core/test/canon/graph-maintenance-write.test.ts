import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readDerivedMeta } from "../../src/derived-meta";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { recordedPage, serveFixture } from "../serving/helpers";

for (const damage of ["shared-writable", "directory"] as const) {
  test(`a ${damage} unrelated archive does not hide a committed write result`, async () => {
    const f = await serveFixture();
    try {
      const archived = join(f.vaultPath, "facts/archived.md");
      const prior = readFileSync(archived);
      if (damage === "shared-writable") chmodSync(archived, 0o664);
      else { unlinkSync(archived); mkdirSync(archived, { mode: 0o700 }); }

      // Changing source authority requires the disposable graph registry to
      // revisit its cached paths after this independent, authorized write.
      const source = ulid();
      registerConnection(f.db, "fixture", source);
      setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: "graph-fixture-grant", policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
      } });
      const captured = accept(f.db, { ...validEvent(), source_record_id: "healthy", text: "A separate synthetic page." },
        { source: { source_key: source, expected_revision: 1 } });
      if (captured.status !== "stored") throw Error("fixture capture failed");
      const result = await recordedPage(f.db, f.vaultPath, "facts/new-healthy.md", {
        id: "fact:new-healthy", title: "New healthy page", type: "fact", status: "active",
        sensitivity: "public", taint: "clean",
      }, "A separate synthetic page.", [captured.event.event_id]);

      expect(existsSync(join(f.vaultPath, result.receipt.page_path))).toBe(true);
      expect(f.db.query("SELECT last_receipt FROM page_index WHERE rel_path=?").get(result.receipt.page_path))
        .toEqual({ last_receipt: result.receipt.receipt_id });
      expect(f.db.query("SELECT count(*) AS n FROM canon_receipts WHERE page_path=?").get(result.receipt.page_path))
        .toEqual({ n: 1 });
      expect(readDerivedMeta(f.db, "graph")?.status).toBe("degraded");
      expect(f.db.query("SELECT 1 FROM graph_edges WHERE src='fact:archived' OR dst='fact:archived'").get()).toBeNull();
      if (damage === "shared-writable") expect(readFileSync(archived)).toEqual(prior);
    } finally { f.dispose(); }
  }, 120_000);
}
