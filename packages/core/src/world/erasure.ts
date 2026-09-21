import type { Database } from "bun:sqlite";
import { parseWorldAdmission } from "../contracts/world-admission";

import { tableExists } from "../ledger/schema";

/** Whole affected contribution, not a dangling admission that still names erased spans. */
export function eraseWorldEventSupports(db: Database, eventId: string): void {
  if (!tableExists(db, "semantic_allocations")) return;
  const rows = db
    .query<{ support_key: string; claim_id: string }, [string]>(
      `SELECT s.support_key,s.claim_id FROM claim_v2_support s JOIN claim_v2_support_events e USING(support_key)
    WHERE e.event_id=? AND json_extract(s.admission,'$.schema')='kizuki.world-admission/v1'`,
    )
    .all(eventId);
  for (const row of rows) {
    db.query("DELETE FROM claim_v2_support_events WHERE support_key=?").run(
      row.support_key,
    );
    db.query("DELETE FROM claim_v2_support WHERE support_key=?").run(
      row.support_key,
    );
  }
  for (const claimId of new Set(rows.map((row) => row.claim_id))) {
    const meaning = db
      .query<
        { payload: string },
        [string]
      >("SELECT payload FROM claim_v2_semantics WHERE claim_id=?")
      .get(claimId);
    if (
      meaning === null ||
      JSON.parse(meaning.payload).schema !== "kizuki.claim-meaning/v1"
    )
      continue;
    const survivors = db
      .query<
        { support_key: string; admission: string },
        [string]
      >("SELECT support_key,admission FROM claim_v2_support WHERE claim_id=?")
      .all(claimId);
    const provenance = new Set<string>();
    for (const survivor of survivors) {
      const admission = parseWorldAdmission(JSON.parse(survivor.admission));
      if (admission === null) continue;
      const events = db
        .query<{ event_id: string }, [string]>(
          `SELECT s.event_id FROM claim_v2_support_events s JOIN events e
        ON e.event_id=s.event_id AND e.content_hash=s.event_content_hash WHERE s.support_key=?`,
        )
        .all(survivor.support_key)
        .map((row) => row.event_id);
      if (
        events.length === 0 ||
        ![
          ...admission.semantic.anchors,
          ...admission.semantic.perspective.anchors,
        ].every((anchor) => events.includes(anchor.event_id))
      )
        continue;
      for (const id of events) provenance.add(id);
    }
    // The qualified parent is neutral bookkeeping. Its provenance union is
    // derived from surviving complete admissions, not the first source forever.
    db.query("UPDATE claims SET provenance=? WHERE claim_id=?").run(
      JSON.stringify([...provenance].sort()),
      claimId,
    );
    db.query("UPDATE proposals SET provenance=? WHERE proposal_id=?").run(
      JSON.stringify([...provenance].sort()),
      claimId,
    );
  }
}
