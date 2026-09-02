import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Sensitivity } from "../../src/agents/types";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import type { TargetDecision } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import type { CanonReceipt } from "../../src/canon/receipts";
import type { CanonIo } from "../../src/canon/store";
import { insertClaim } from "../../src/claims/store";
import type { InsertClaimInput } from "../../src/claims/store";
import type { Claim } from "../../src/contracts/proposal";
import { openLedger } from "../../src/ledger/db";
import type { Writer } from "../../src/vault/write";
import { eventFacts, putEvent } from "../claims/helpers";
import { tempVault } from "../helpers/vault";

export { putEvent } from "../claims/helpers";

export interface CanonFixture {
  db: Database;
  vault: string;
  io: CanonIo;
  dispose: () => void;
}

export function canonFixture(overrides: Partial<CanonIo> = {}): CanonFixture {
  const db = openLedger(":memory:");
  const vault = tempVault("kizuki-canon-");
  const io: CanonIo = { db, vault_path: vault.path, ...overrides };
  return {
    db,
    vault: vault.path,
    io,
    dispose: () => {
      db.close();
      vault.dispose();
    },
  };
}

export async function storeClaim(
  db: Database,
  eventId: string,
  overrides: Partial<InsertClaimInput> = {},
): Promise<Claim> {
  const input: InsertClaimInput = {
    kind: "claim",
    target: "people/grace",
    subject: "person:grace",
    predicate: "employment.works_at",
    object: "acme",
    polarity: "positive",
    body: "Grace runs partnerships at Acme.",
    frontmatter: { type: "person", title: "Grace" },
    provenance: [eventId],
    subjects: ["person:grace"],
    producer: "deterministic",
    confidence: 0.8,
    sensitivity: "personal" as Sensitivity,
    taint: "clean",
    events: [eventFacts(eventId)],
    ...overrides,
  };
  const result = await insertClaim({ db }, input);
  if (result.outcome === "stored") return result.claim;
  if (result.outcome === "contested") return result.incoming;
  throw new Error(`fixture claim was ${result.outcome}`);
}

export function budget(limit = 10) {
  return createBudgetTracker({ canon_writes_per_run: limit });
}

export function write(
  io: CanonIo,
  claims: Claim | readonly Claim[],
  opts: { writer?: Writer; decision?: TargetDecision; limit?: number } = {},
): CanonReceipt {
  const primary = Array.isArray(claims) ? (claims as readonly Claim[])[0] : (claims as Claim);
  if (primary === undefined) throw new Error("no claim");
  const decision = opts.decision ?? resolveTarget(io, primary);
  return applyCanonWrite(io, claims, decision, {
    writer: opts.writer ?? "loop",
    budget: budget(opts.limit),
  });
}

export function readBytes(vault: string, relPath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(vault, relPath)));
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Every `.ts` file below a directory, vault-relative and sorted. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (entry === "node_modules") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}
