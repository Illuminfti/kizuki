import { expect, test } from "bun:test";
import {
  LedgerError,
  disconnect,
  getConnection,
  registerConnection,
} from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";

const SOURCE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("disconnect requires an active row and preserves the first timestamp", () => {
  const db = openLedger(":memory:");
  const enrolled = registerConnection(db, "markdown", SOURCE);
  expect(enrolled.disconnected_at).toBeNull();

  const first = disconnect(db, "markdown", SOURCE);
  expect(first.disconnected_at).toBeString();
  expect(getConnection(db, "markdown", SOURCE)?.disconnected_at).toBe(first.disconnected_at);

  expect(() => disconnect(db, "markdown", SOURCE)).toThrow(LedgerError);
  expect(() => disconnect(db, "markdown", SOURCE)).toThrow("connection already disconnected");
  expect(getConnection(db, "markdown", SOURCE)?.disconnected_at).toBe(first.disconnected_at);
  db.close();
});

test("disconnect refuses an unknown connection", () => {
  const db = openLedger(":memory:");
  expect(() => disconnect(db, "markdown", SOURCE)).toThrow(LedgerError);
  expect(() => disconnect(db, "markdown", SOURCE)).toThrow("unknown connection");
  db.close();
});
