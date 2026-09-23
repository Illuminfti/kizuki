import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** A real child process exits right after the Nth stage creation fsyncs. */
export function killAfterStage(f: { dbPath: string; vault: string; reopen(): void }, claimId: string, createIndex: number): void {
  const src = join(import.meta.dir, "../../src");
  const script = `
    import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import { getClaim } from ${JSON.stringify(join(src, "claims/store.ts"))};
    import { resolveTarget } from ${JSON.stringify(join(src, "canon/arbiter.ts"))};
    import { createBudgetTracker } from ${JSON.stringify(join(src, "canon/budget.ts"))};
    import { applyCanonWriteOwned } from ${JSON.stringify(join(src, "canon/apply.ts"))};
    import { withCanonMutationSync, snapshotCanonIo, requireCanonFiles } from ${JSON.stringify(join(src, "canon/io.ts"))};
    const db = openLedger(${JSON.stringify(f.dbPath)}), claim = getClaim(db, ${JSON.stringify(claimId)});
    const io = snapshotCanonIo({ db, vault_path: ${JSON.stringify(f.vault)} });
    let creates = 0;
    withCanonMutationSync(io, (scope, owned) => {
      const files = requireCanonFiles(scope, owned), create = files.create.bind(files);
      files.create = (...args) => { const result = create(...args); if (++creates === ${createIndex}) process.exit(73); return result; };
      applyCanonWriteOwned(scope, owned, claim, resolveTarget(owned, claim), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }) });
    });
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 30_000 });
  expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
  f.reopen();
}

