import { existsSync } from "node:fs";
import { join } from "node:path";
import { initAgents, initGraph, initSearch, openLedger } from "@kizuki/core";
import type { Principal } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { ownerPrincipal, principalFromToken } from "./principal";
import { runStdio } from "./stdio";

const USAGE = "usage: kizuki-mcp --vault PATH (--owner | --token-env VAR)";

interface Options {
  vault: string;
  tokenEnv: string | null;
}

/** A token never travels on argv: every process on the machine can read it. */
function parse(argv: string[]): Options | null {
  let vault: string | null = null;
  let tokenEnv: string | null = null;
  let owner = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--owner") {
      owner = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    index += 1;
    if (flag === "--vault") vault = value;
    else if (flag === "--token-env") tokenEnv = value;
    else return null;
  }

  if (vault === null) return null;
  if (owner === (tokenEnv !== null)) return null;
  return { vault, tokenEnv };
}

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const options = parse(argv);
  if (options === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  const stateDir = join(options.vault, ".kizuki");
  if (!existsSync(stateDir)) refuse("vault is not initialized");

  const db = openLedger(join(stateDir, "kizuki.db"));
  initStaging(db);
  initSearch(db);
  initGraph(db);
  initAgents(db);

  let principal: Principal;
  if (options.tokenEnv === null) {
    principal = ownerPrincipal();
  } else {
    const token = process.env[options.tokenEnv];
    if (token === undefined || token.length === 0) {
      db.close();
      refuse("token variable is not set");
    }
    const resolved = principalFromToken(db, token);
    // The token value is never printed, not even to help a caller debug.
    if (resolved === null) {
      db.close();
      refuse("token not recognized");
    }
    principal = resolved;
  }

  // The handle closes on the way out whatever happened: a transport that
  // fails mid-answer would otherwise leave the database open behind an
  // unhandled rejection.
  try {
    await runStdio({ db, vaultPath: options.vault, principal });
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
