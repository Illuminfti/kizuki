import { rawSubjectNamespace, rawSubjectRefKey } from "../contracts/claim-v2";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type {
  ClaimV2Assertion,
  ClaimMeaning,
  RawSubjectRef,
} from "../contracts/claim-v2";

export function assertionEndpoints(
  semantic: ClaimV2Assertion | ClaimMeaning,
): RawSubjectRef[] {
  const refs = [
    semantic.subject,
    ...(semantic.object.kind === "subject" ? [semantic.object.ref] : []),
    ...semantic.context,
    semantic.perspective.holder,
    semantic.perspective.speaker,
    semantic.perspective.addressee,
  ];
  return [
    ...new Map(
      refs
        .filter((ref): ref is RawSubjectRef => ref !== null)
        .map((ref) => [rawSubjectRefKey(ref), ref]),
    ).values(),
  ];
}

/** Called only by the existing support writer, in its transaction after admission. */
export function allocateWorldEndpoints(
  db: Database,
  semantic: ClaimV2Assertion,
  supportKey: string,
  at: string,
): void {
  if (!db.inTransaction)
    throw new Error("world allocation requires the claim transaction");
  for (const ref of assertionEndpoints(semantic)) {
    let handle = db
      .query<
        { handle_id: string },
        [string, string, string]
      >("SELECT handle_id FROM semantic_bindings WHERE raw_kind=? AND raw_namespace=? AND raw_id=?")
      .get(ref.kind, rawSubjectNamespace(ref), ref.id)?.handle_id;
    if (handle === undefined) {
      do {
        handle = randomBytes(16).toString("hex");
      } while (
        db
          .query("SELECT 1 FROM semantic_handles WHERE handle_id=?")
          .get(handle) !== null
      );
      db.query("INSERT INTO semantic_handles(handle_id) VALUES (?)").run(
        handle,
      );
      db.query(
        "INSERT INTO semantic_bindings(raw_kind,raw_namespace,raw_id,handle_id) VALUES (?,?,?,?)",
      ).run(ref.kind, rawSubjectNamespace(ref), ref.id, handle);
    }
    if (
      db
        .query(
          "SELECT 1 FROM semantic_allocations WHERE handle_id=? AND support_key=?",
        )
        .get(handle, supportKey) === null
    ) {
      db.query(
        "INSERT INTO semantic_allocations(receipt_id,handle_id,support_key,allocated_at) VALUES (?,?,?,?)",
      ).run(randomBytes(16).toString("hex"), handle, supportKey, at);
    }
  }
}
