import { join } from "node:path";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";

export const OLD = "The compiler ships nightly.";

function event(): CaptureEventInput {
  return {
    schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: `rec-${crypto.randomUUID()}`,
    kind: "message", occurred_at: "2026-02-28T10:30:00Z", observed_at: "2026-03-01T00:00:00Z",
    text: OLD, subjects: [{ subject_id: "topic:compiler", role: "about", display_name: "Compiler" }],
    sensitivity_hint: "personal", deleted: false, attachments: [], metadata: {},
  };
}

/** A deterministic importer claim: no subject and no predicate, so no claim key, written where the loop writes. */
export async function seedUnkeyed(vault: string): Promise<{ claimId: string; pagePath: string }> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const accepted = accept(db, event());
    if (accepted.status !== "stored") throw new Error("event");
    const eventId = accepted.event.event_id;
    const stored = await insertClaim({ db }, {
      kind: "entity", target: "entities/compiler", body: OLD,
      frontmatter: { type: "topic", title: "Compiler" }, provenance: [eventId], subjects: [],
      producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "quoted",
      events: [{ event_id: eventId, connector_id: "fixture", taint: "untrusted", text: OLD }],
    });
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    const io = { db, vault_path: vault };
    const decision = resolveTarget(io, stored.claim);
    if (decision.action !== "create") throw new Error(decision.action);
    const receipt = applyCanonWrite(io, stored.claim, { ...decision, rel_path: `auto/${decision.rel_path}` }, {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    return { claimId: stored.claim.claim_id, pagePath: receipt.page_path };
  } finally { db.close(); }
}
