import { Database } from "bun:sqlite";
import { toFtsQuery } from "../search/query";

/** Recheck a nomination against the exact text released, using the floor's FTS grammar. */
export function servedTextMatcher(query: string) {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE served_text USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')");
  const ftsQuery = toFtsQuery(query);
  const insert = db.prepare("INSERT INTO served_text(title,body) VALUES (?,?)");
  const matches = db.prepare<{ found: number }, [string]>("SELECT 1 AS found FROM served_text WHERE served_text MATCH ? LIMIT 1");
  return {
    matches(title: string, body: string): boolean {
      if (ftsQuery === "") return false;
      db.exec("DELETE FROM served_text");
      insert.run(title, body);
      return matches.get(ftsQuery) !== null;
    },
    close() { db.close(); },
  };
}
