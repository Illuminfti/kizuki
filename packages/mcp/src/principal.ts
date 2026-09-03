import type { Database } from "bun:sqlite";
import { OWNER, authenticate } from "@kizuki/core";
import type { Principal } from "@kizuki/core";

/** One import for principal resolution. Neither wrapper adds policy. */
export function ownerPrincipal(): Principal {
  return OWNER;
}

export function principalFromToken(
  db: Database,
  token: string,
): Principal | null {
  return authenticate(db, token);
}
