// Child process of the reconcile tests: another process files one synthetic page through the receipted writer.
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { recordedPage } from "../helpers/recorded-page";

const [vault, name, body] = process.argv.slice(2) as [string, string, string];
const db = openLedger(join(vault, ".kizuki/kizuki.db"));
try {
  await recordedPage(db, vault, `facts/${name}.md`, { id: `fact:${name}`, title: name, type: "fact", status: "active", sensitivity: "public", taint: "clean" }, body);
} finally { db.close(); }
