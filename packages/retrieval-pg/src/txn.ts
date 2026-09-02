import { PortError } from "@kizuki/core";

let storeTransactionDepth = 0;

export function storeTransactionDepthNow(): number {
  return storeTransactionDepth;
}

export function assertNoStoreTransaction(op: string): void {
  if (storeTransactionDepth > 0) {
    throw new PortError(
      "unavailable",
      `no txn spans an embed call (${op})`,
      false,
    );
  }
}

export function runStoreTransaction<T>(fn: () => T): T {
  storeTransactionDepth += 1;
  try {
    return fn();
  } finally {
    storeTransactionDepth -= 1;
  }
}
