import type { Database } from "bun:sqlite";
import { isSensitivity } from "../../src/agents/types";
import { readPage } from "../../src/canon/store";
import type { FrontmatterValue } from "../../src/contracts/proposal";
import { insertClaim } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { eventIdFromReference } from "../../src/retrieval/ids";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { write } from "../canon/helpers";

/** Positive canon fixtures use the same evidence and receipt path as the product. */
export async function recordedPage(
  db: Database,
  vaultPath: string,
  relPath: string,
  data: Record<string, FrontmatterValue>,
  body: string,
  sourceIds?: readonly string[],
) {
  const { id, status, sensitivity, taint, sources, ...frontmatter } = data;
  if (typeof id !== "string" || status !== "active" || !isSensitivity(sensitivity) ||
      (taint !== "clean" && taint !== "quoted") || !relPath.endsWith(".md")) {
    throw new Error("recorded page fixture requires a complete active page");
  }
  const existing = readPage({ db, vault_path: vaultPath }, relPath);
  if (existing !== null && existing.page.data["id"] !== id) {
    throw new Error("recorded page fixture must preserve the existing page ID");
  }
  // Declare the synthetic connector's policy; existing stricter floors still win.
  seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "recorded-page-fixture" }, {
    default_sensitivity: "public", sensitivity_floor: "public",
  });
  const supplied = sourceIds ?? (Array.isArray(sources) ? sources : undefined);
  let provenance: string[];
  if (supplied !== undefined) {
    if (supplied.length === 0 || !supplied.every(id => typeof id === "string")) {
      throw new Error("recorded page fixture needs existing source IDs");
    }
    provenance = supplied.map(id => eventIdFromReference(id as string));
  } else {
    const result = accept(db, {
      ...validEvent(), connector_id: "fixture", source_record_id: `page-${ulid()}`,
      text: body, sensitivity_hint: sensitivity,
    });
    if (result.status !== "stored") throw new Error(`recorded page capture: ${result.status}`);
    provenance = [result.event.event_id];
  }
  const filed = await insertClaim({ db }, {
    kind: existing === null ? "entity" : "edit", target: relPath.slice(0, -3), body, frontmatter,
    // Page scope belongs in frontmatter; no primary-subject target binding is requested.
    provenance, subjects: [], producer: "model", model_ref: "fixture:synthetic",
    confidence: 1, sensitivity, taint,
  });
  if (filed.outcome !== "stored") throw new Error(`recorded page claim: ${filed.outcome}`);
  let firstId = existing === null;
  const receipt = write({ db, vault_path: vaultPath, ids: () => {
    if (firstId) { firstId = false; return id; }
    return ulid();
  } }, filed.claim);
  if (receipt.page_path !== relPath) throw new Error("recorded page fixture resolved another path");
  return { claim: filed.claim, receipt, sourceIds: provenance };
}
