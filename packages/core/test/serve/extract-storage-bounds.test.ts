import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { requireAtomicExtractReplay } from "../../src/serve/extract";

const fields = [
  ["previous_cursor", 256, false], ["cursor", 256, false], ["drafts", 1_600_000, false],
  ["model_ref", 2_048, true], ["created_at", 64, false], ["input_ids", 4_096, true],
  ["integrity", 74, true], ["outcome", 16, false], ["batch_mode", 16, false],
  ["model_inputs", 8_192, true], ["deferred_inputs", 8_192, true],
] as const;

function fixture() {
  const db = new Database(":memory:");
  // A damaged/non-STRICT table must not bypass the SQLite storage-class guard.
  db.exec(`CREATE TABLE extract_batches (${fields.map(([field]) => `${field}`).join(",")})`);
  db.query(`INSERT INTO extract_batches VALUES ('','cursor','[]',NULL,'2026-09-05T12:00:00Z',NULL,?,'ok','frontier',NULL,NULL)`)
    .run(`atomic-v1:${"a".repeat(64)}`);
  const query = db.query.bind(db);
  let payloadReads = 0;
  const observe = (row: unknown) => {
    if (row && typeof row === "object" && fields.some(([field]) => field in row)) payloadReads++;
  };
  const statementSpies: { mockRestore(): void }[] = [];
  const querySpy = spyOn(db, "query").mockImplementation(<Row, Params extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
    const statement = query<Row, Params>(sql);
    const all = statement.all.bind(statement);
    statementSpies.push(spyOn(statement, "all").mockImplementation((...params) => {
      const rows = all(...params);
      // Observe the actual result boundary, without depending on the SQL shape.
      rows.forEach(observe);
      return rows;
    }));
    const get = statement.get.bind(statement);
    statementSpies.push(spyOn(statement, "get").mockImplementation((...params) => {
      const row = get(...params);
      observe(row);
      return row;
    }));
    return statement;
  });
  return { db, payloadReads: () => payloadReads, close: () => {
    for (const spy of statementSpies.reverse()) spy.mockRestore();
    querySpy.mockRestore();
    db.close();
  } };
}

for (const [field, cap, nullable] of fields) {
  for (const violation of ["oversized text", "oversized UTF-8", "blob", "integer", "real", ...(!nullable ? ["null"] : [])]) {
    test(`${field}: ${violation} refuses before any stored payload is returned`, () => {
      const f = fixture();
      try {
        const value = violation === "oversized text" ? `CAST(zeroblob(${cap + 1}) AS TEXT)` :
          violation === "blob" ? "x'61'" : violation === "integer" ? "1" : violation === "real" ? "1.5" : "NULL";
        if (violation === "oversized UTF-8") {
          f.db.query(`UPDATE extract_batches SET ${field}=CAST(? AS TEXT)`).run(Buffer.from("é".repeat(Math.floor(cap / 2) + 1)));
        } else f.db.exec(`UPDATE extract_batches SET ${field}=${value}`);
        expect(() => requireAtomicExtractReplay(f.db)).toThrow("durable extraction batch is corrupt");
        expect(f.payloadReads()).toBe(0);
      } finally { f.close(); }
    });
  }
}

test("multiple pending rows refuse before returning either payload", () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO extract_batches SELECT * FROM extract_batches");
    expect(() => requireAtomicExtractReplay(f.db)).toThrow("durable extraction batch is corrupt");
    expect(f.payloadReads()).toBe(0);
  } finally { f.close(); }
});

test("a bounded row reaches the pure parser through the observed payload boundary", () => {
  const f = fixture();
  try {
    expect(() => requireAtomicExtractReplay(f.db)).toThrow("durable extraction batch is corrupt");
    expect(f.payloadReads()).toBe(1);
  } finally { f.close(); }
});
