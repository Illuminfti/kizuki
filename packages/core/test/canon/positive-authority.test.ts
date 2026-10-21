import { expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { ErasurePendingError, assertPositiveAuthorityMutationAllowed } from "../../src/canon/positive-authority";

test("positive-authority fence uses the current transaction and treats any pending intent as unavailable", () => {
  const db = openLedger(":memory:");
  try {
    expect(() => assertPositiveAuthorityMutationAllowed(db)).toThrow("requires a transaction");
    expect(() => db.transaction(() => assertPositiveAuthorityMutationAllowed(db)).immediate()).not.toThrow();
    // A malformed recovery record also withholds positive writes; this helper
    // neither interprets nor repairs attacker-controlled intent content.
    db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("private-path", "private-source", "unreadable recovery", "private-digest");
    expect(() => db.transaction(() => assertPositiveAuthorityMutationAllowed(db)).immediate()).toThrow(ErasurePendingError);
    expect(db.query("SELECT count(*) n FROM canon_source_erasure_intents").get()).toEqual({ n: 1 });
    db.query("DELETE FROM canon_source_erasure_intents").run();
    expect(() => db.transaction(() => assertPositiveAuthorityMutationAllowed(db)).immediate()).not.toThrow();
  } finally { db.close(); }
});

test("a transaction that stages an intent cannot pass the positive-authority fence and rolls back", () => {
  const db = openLedger(":memory:");
  try {
    expect(() => db.transaction(() => {
      db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("pending", "source", "{}", "digest");
      assertPositiveAuthorityMutationAllowed(db);
    }).immediate()).toThrow(ErasurePendingError);
    expect(db.query("SELECT 1 FROM canon_source_erasure_intents").get()).toBeNull();
  } finally { db.close(); }
});
