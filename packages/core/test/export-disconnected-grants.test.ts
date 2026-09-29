import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept, disconnect, exportVault, initVault, inspectSourceGrant, registerConnection,
  restoreVault, resumeSourceRevocation, revokeSourceGrant, setSourceGrant,
} from "../src/index";
import { openLedger } from "../src/ledger/db";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const noExport = {
  purposes: ["capture", "recall", "session", "derive"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-disconnected-"));
  dirs.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const source = () => {
    const key = ulid();
    registerConnection(db, "kizuki.fixture", key);
    setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `grant-${key}`, policy: noExport });
    return key;
  };
  return { db, vault, out: (name: string) => join(root, name), source };
}

test("a disconnected source that binds no event does not block export, whatever its grant state", async () => {
  const { db, vault, out, source } = setup();
  try {
    const empty = source();
    const revoked = source();
    const purged = source();
    for (const key of [empty, revoked, purged]) disconnect(db, "kizuki.fixture", key);
    revokeSourceGrant(db, { source_key: revoked, expected_revision: 1, operation_id: "revoke-denied" });
    revokeSourceGrant(db, { source_key: purged, expected_revision: 1, operation_id: "revoke-purged" });
    await resumeSourceRevocation(db, vault, "revoke-purged");
    expect(inspectSourceGrant(db, revoked)?.status).toBe("denied");
    expect(inspectSourceGrant(db, purged)?.status).toBe("purged");
    const manifest = exportVault(db, vault, out("backup"));
    expect(manifest.complete).toBe(true);
    // The exported policy history restores, including the revoked and purged grants.
    restoreVault(out("backup"), out("restored"));
    const restored = openLedger(join(out("restored"), ".kizuki", "kizuki.db"));
    try {
      expect(inspectSourceGrant(restored, revoked)?.status).toBe("denied");
      expect(inspectSourceGrant(restored, purged)?.status).toBe("purged");
      expect(inspectSourceGrant(restored, empty)?.status).toBe("active");
    } finally { restored.close(); }
  } finally { db.close(); }
});

test("an active source without the export purpose still blocks export, and so does a disconnected source that holds events", () => {
  const { db, vault, out, source } = setup();
  try {
    const held = source();
    const stored = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", text: "Synthetic evidence." }, { source: { source_key: held, expected_revision: 1 } });
    expect(stored.status).toBe("stored");
    disconnect(db, "kizuki.fixture", held);
    expect(() => exportVault(db, vault, out("held"))).toThrow(`source_export_denied: source ${held} does not grant the export purpose`);
    expect(existsSync(out("held"))).toBe(false);

    const live = source();
    expect(() => exportVault(db, vault, out("live"))).toThrow(`source ${live} does not grant the export purpose`);
  } finally { db.close(); }
});
