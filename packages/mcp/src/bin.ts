import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initAgents, initGraph, initSearch, openLedger, resolvePort } from "@kizuki/core";
import type { Principal, RetrievalPort } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { ownerPrincipal, principalFromToken } from "./principal";
import { runStdio } from "./stdio";

const USAGE = [
  "usage: kizuki-mcp --vault PATH (--owner | --token-env VAR) [--retrieval ID]",
  "Kizuki MCP — stdio adapter over one vault. No policy of its own.",
].join("\n");

interface Options {
  vault: string;
  tokenEnv: string | null;
  retrieval: string | null;
}

/** A token never travels on argv: every process on the machine can read it. */
function parse(argv: string[]): Options | null {
  let vault: string | null = null;
  let tokenEnv: string | null = null;
  let retrieval: string | null = null;
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
    else if (flag === "--retrieval") retrieval = value;
    else return null;
  }

  if (vault === null) return null;
  if (owner === (tokenEnv !== null)) return null;
  return { vault, tokenEnv, retrieval };
}

/**
 * RFC 0002 §9.7 rule 10: one engine connection for the process lifetime,
 * opened here and closed when the session ends. With none named the process
 * runs on the deterministic floor, which is what invariant 5 requires of
 * every served read.
 */
function bindRetrieval(vault: string, id: string): RetrievalPort {
  const dataDir = join(vault, ".kizuki", "retrieval", id);
  mkdirSync(dataDir, { recursive: true });
  const registration = resolvePort<RetrievalPort>("retrieval", id);
  return registration.factory({
    vault_path: vault,
    data_dir: dataDir,
    config: {},
    secrets: () => Promise.reject(new Error("no secret is configured")),
    clock: () => new Date().toISOString(),
    // stdout is the protocol channel; a port's own lines go to stderr.
    logger: (line) => process.stderr.write(`${line.level} ${line.message}\n`),
  });
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

  let retrieval: RetrievalPort | null = null;
  if (options.retrieval !== null) {
    try {
      retrieval = bindRetrieval(options.vault, options.retrieval);
    } catch {
      db.close();
      // The id is the caller's own argument, so naming it leaks nothing.
      refuse(`retrieval port not registered: ${options.retrieval}`);
    }
  }

  // The handles close on the way out whatever happened: a transport that
  // fails mid-answer would otherwise leave the database open behind an
  // unhandled rejection.
  try {
    await runStdio({
      db,
      vaultPath: options.vault,
      principal,
      ...(retrieval === null ? {} : { retrieval }),
    });
  } finally {
    if (retrieval !== null) await retrieval.close();
    db.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
