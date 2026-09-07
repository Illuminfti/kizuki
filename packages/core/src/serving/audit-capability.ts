import type { Database } from "bun:sqlite";
import { reserveAudit, updateAudit } from "../agents/audit";

interface AuditCapability {
  reserve: (...args: Tail<Parameters<typeof reserveAudit>>) => ReturnType<typeof reserveAudit>;
  update: (...args: Tail<Parameters<typeof updateAudit>>) => void;
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
const bound = new WeakMap<Database, AuditCapability>();

/** Internal composition seam: the reader and writer are admitted by one ledger opener. */
export function bindServingAudit(reader: Database, writer: Database, assertCurrent: () => void): void {
  if (bound.has(reader)) throw new Error("serving audit is already bound");
  const owned = new Set<string>();
  bound.set(reader, {
    reserve(...args) {
      assertCurrent();
      const result = reserveAudit(writer, ...args);
      assertCurrent();
      owned.add(result.audit_id);
      return result;
    },
    update(id, ...args) {
      assertCurrent();
      if (!owned.has(id)) throw new Error("serving audit reservation is not owned");
      writer.transaction(() => {
        if (writer.query("SELECT 1 FROM agent_audit WHERE audit_id = ?").get(id) === null) {
          throw new Error("serving audit reservation is missing");
        }
        updateAudit(writer, id, ...args);
        const changed = writer.query<{ n: number }, []>("SELECT changes() AS n").get();
        if (changed?.n !== 1 || writer.query("SELECT 1 FROM agent_audit WHERE audit_id = ?").get(id) === null) {
          throw new Error("serving audit update was not recorded");
        }
        assertCurrent();
      }).immediate();
    },
  });
}

export function reserveServingAudit(db: Database, ...args: Tail<Parameters<typeof reserveAudit>>): ReturnType<typeof reserveAudit> {
  return bound.get(db)?.reserve(...args) ?? reserveAudit(db, ...args);
}

export function updateServingAudit(db: Database, ...args: Tail<Parameters<typeof updateAudit>>): void {
  const capability = bound.get(db);
  if (capability === undefined) updateAudit(db, ...args);
  else capability.update(...args);
}
