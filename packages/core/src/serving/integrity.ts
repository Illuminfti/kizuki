import { createHmac, randomBytes } from "node:crypto";
import type { Principal } from "../agents";

let receiptKey: Buffer | undefined;

/** Raw receipt hashes remain on disk; an agent cannot test guesses against them. */
export function servedReceiptHash(principal: Principal, hash: string): string {
  if (principal.kind === "owner") return hash;
  receiptKey ??= randomBytes(32);
  return createHmac("sha256", receiptKey).update(hash).digest("hex");
}
