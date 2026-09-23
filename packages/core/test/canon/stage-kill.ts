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


export const CORE_SRC = join(import.meta.dir, "../../src");

/** A real child process runs `operation` against the same ledger and vault and
 * exits right after the Nth canon file creation whose path matches `stage`
 * has fsynced, whatever scope created it. */
export function killAtCanonCreate(f: { dbPath: string; vault: string; reopen(): void }, imports: string, operation: string, stage: RegExp, createIndex = 1): void {
  const script = `
    import { openCanonFiles } from ${JSON.stringify(join(CORE_SRC, "vault/canon-files.ts"))};
    ${imports}
    const probe = openCanonFiles(${JSON.stringify(f.vault)}), native = Object.getPrototypeOf(probe); probe.close();
    const create = native.create; let creates = 0;
    native.create = function (path, bytes) {
      const result = create.call(this, path, bytes);
      if (${stage.toString()}.test(path) && ++creates === ${createIndex}) process.exit(73);
      return result;
    };
    ${operation}
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 60_000 });
  expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
  f.reopen();
}

/** The canon stage name beside one page, for any receipt. */
export function stagePattern(pagePath: string): RegExp {
  const slash = pagePath.lastIndexOf("/"), escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`^${escape(pagePath.slice(0, slash + 1))}\\.${escape(pagePath.slice(slash + 1))}\\.[0-9A-Z]{26}\\.tmp$`);
}
