import { AsyncLocalStorage } from "node:async_hooks";
import { PortError } from "@kizuki/core";
const transactions = new AsyncLocalStorage<boolean>();
export function storeTransactionDepthNow(): number { return transactions.getStore() === true ? 1 : 0; }
export function assertNoStoreTransaction(op: string): void {
  if (transactions.getStore() === true) {
    throw new PortError("unavailable", `no txn spans an embed call (${op})`, false);
  }
}
/** Async context follows the callback until settlement without blocking unrelated calls. */
export function runStoreTransaction<T>(fn: () => T): T { return transactions.run(true, fn); }
