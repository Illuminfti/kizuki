import { fstatSync, type BigIntStats } from "node:fs";
import type { CustodyStat } from "../util/custody-native";

/** Join the caller's policy snapshot to the native exchange's own before/after
 * interval. Namespace translation may change reported owners, never identity,
 * mode or ctime. Returning only an owner without this bridge would let policy
 * accidentally evaluate a different version of the directory. */
export function observeAncestorOwner(fd: number, observed: BigIntStats, attest: () => CustodyStat): bigint {
  const reply = attest(), current = fstatSync(fd, { bigint: true });
  if (!observed.isDirectory() || !current.isDirectory() ||
      reply.dev !== observed.dev || reply.ino !== observed.ino || reply.mode !== observed.mode ||
      reply.ctimeNs !== observed.ctimeNs || current.dev !== observed.dev || current.ino !== observed.ino ||
      current.mode !== observed.mode || current.ctimeNs !== observed.ctimeNs ||
      current.uid !== observed.uid || current.gid !== observed.gid) {
    throw new Error("service_custody_changed");
  }
  return reply.uid;
}
