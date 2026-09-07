import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

const path = process.argv[2];
if (path === undefined) throw new Error("synthetic ledger path is required");
const db = openLedger(path);
try {
  process.stdout.write("ready\n");
  if ((await Bun.stdin.text()).trim() !== "accept") {
    throw new Error("synthetic acceptance barrier was not released");
  }
  process.stdout.write(`${accept(db, validEvent()).status}\n`);
} finally {
  db.close();
}
