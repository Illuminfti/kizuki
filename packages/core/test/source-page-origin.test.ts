import { expect, test, setDefaultTimeout } from "bun:test";
import { registerConnection, setSourceGrant } from "../src/index";
import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { commitMachineByteIntent } from "../src/ledger/event-origin";
import { sourceRoots } from "../src/claims/source-roots";
import { serializePage } from "../src/vault/frontmatter";
import { sha256Hex } from "../src/util/hash";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

setDefaultTimeout(30_000);
const TEXT = "# Atlas\n\nThe source's original prose.";
const PAGE = serializePage({ data: { id: "01J0000000000000000000000A", type: "topic", title: "Atlas", status: "active", sensitivity: "private", sources: [], taint: "quoted" }, body: TEXT });
const policy = { purposes: ["capture", "recall", "derive"] as const, allowed_fields: ["text", "subjects", "attachments", "metadata"] as const, retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
function setup() {
  const db = openLedger(":memory:");
  const a = ulid(), b = ulid();
  for (const source of [a, b]) {
    registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: `grant-${source}`, policy });
  }
  const input = { ...validEvent(), source_record_id: "atlas.md", text: TEXT };
  const first = accept(db, input, { source: { source_key: a, expected_revision: 1 } });
  if (first.status !== "stored") throw Error("source fixture failed");
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(PAGE) }, () => {}, { before: null, after: PAGE });
  return { db, a, b, input, first: first.event };
}

test("an authorized same-source revision retains prior external prose without another witness", () => {
  const f = setup();
  try {
    const revision = accept(f.db, { ...f.input, metadata: { revision: 2 } }, { source: { source_key: f.a, expected_revision: 1 } });
    expect(revision).toMatchObject({ status: "stored", event: { origin: "external", origin_binding_kind: "capture" } });
    if (revision.status !== "stored") throw Error("revision failed");
    expect(sourceRoots(f.db, [f.first.event_id, revision.event.event_id]).size).toBe(1);
  } finally { f.db.close(); }
});

test.each(["new record", "new enrollment", "forged metadata", "unbound claimed identity"])("copied body remains self under %s", (variant) => {
  const f = setup();
  try {
    const input = { ...f.input, source_record_id: variant === "new record" ? "copy.md" : f.input.source_record_id,
      metadata: variant === "forged metadata" ? { source_key: f.a, event_id: f.first.event_id, origin: "external", origin_binding: f.first.origin_binding } : { delivery: variant } };
    const source = variant === "new record" ? f.a : f.b;
    const copied = accept(f.db, input, variant === "unbound claimed identity" ? {} : { source: { source_key: source, expected_revision: 1 } });
    expect(copied).toMatchObject({ status: "stored", event: { origin: "self" } });
  } finally { f.db.close(); }
});

test("prior source prose cannot override exact copied canon or the context marker", () => {
  const f = setup();
  try {
    expect(accept(f.db, { ...f.input, text: PAGE, metadata: { revision: 3 } }, { source: { source_key: f.a, expected_revision: 1 } }))
      .toMatchObject({ status: "stored", event: { origin: "self" } });
    expect(accept(f.db, { ...f.input, text: `KIZUKI CONTEXT v1\n${TEXT}`, metadata: { revision: 4 } }, { source: { source_key: f.a, expected_revision: 1 } }))
      .toMatchObject({ status: "stored", event: { origin: "self" } });
  } finally { f.db.close(); }
});

test("a same-source revision still requires its current capture grant", () => {
  const f = setup();
  try {
    setSourceGrant(f.db, { source_key: f.a, expected_revision: 1, operation_id: "remove-capture", policy: { ...policy, purposes: ["recall"] } });
    expect(accept(f.db, { ...f.input, metadata: { revision: 2 } }, { source: { source_key: f.a, expected_revision: 2 } }))
      .toMatchObject({ status: "error", kind: "validation", error: "source_capture_denied" });
  } finally { f.db.close(); }
});

test("the earlier external admission binding is validated before retaining source origin", () => {
  const f = setup();
  try {
    f.db.exec("DROP TRIGGER events_identity_update");
    f.db.query("UPDATE events SET origin_binding=? WHERE event_id=?").run("0".repeat(64), f.first.event_id);
    expect(accept(f.db, { ...f.input, metadata: { revision: 2 } }, { source: { source_key: f.a, expected_revision: 1 } }))
      .toMatchObject({ status: "error", kind: "infrastructure" });
  } finally { f.db.close(); }
});
