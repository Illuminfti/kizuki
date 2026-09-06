import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { authenticateAgentCredential, initAgents, initGraph, initSearch, openLedger, PortError, PortRegistry, bindLocalSourcePort, loadConfiguredRetrieval } from "@kizuki/core";
import { registerEmbeddedRetrieval } from "@kizuki/retrieval-pg";
import type { Principal, RetrievalPort } from "@kizuki/core";
import { ownerPrincipal, principalFromToken } from "./principal";
import { runStdio } from "./stdio";

const USAGE = [
  "usage: kizuki-mcp --vault PATH (--owner | --token-env VAR | --token-ref file:/absolute/path) [--retrieval ID]",
  "Kizuki MCP — stdio adapter over one vault. No policy of its own.",
].join("\n");

type Authentication = { kind: "owner" } | { kind: "environment"; name: string } | { kind: "file"; reference: string };

interface Options {
  vault: string;
  authentication: Authentication;
  retrieval: string | null;
}

/** A token never travels on argv: every process on the machine can read it. */
function parse(argv: string[]): Options | null {
  let vault: string | null = null;
  let authentication: Authentication | null = null;
  let retrieval: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--owner") {
      if (authentication !== null) return null;
      authentication = { kind: "owner" };
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    index += 1;
    if (flag === "--vault") vault = value;
    else if (flag === "--token-env" || flag === "--token-ref") {
      if (authentication !== null) return null;
      authentication = flag === "--token-env"
        ? { kind: "environment", name: value }
        : { kind: "file", reference: value };
    }
    else if (flag === "--retrieval") retrieval = value;
    else return null;
  }

  if (vault === null || authentication === null) return null;
  return { vault: resolve(vault), authentication, retrieval };
}

/**
 * RFC 0002 §9.7 rule 10: one engine connection for the process lifetime,
 * opened here and closed when the session ends. With none named the process
 * runs on the deterministic floor, which is what invariant 5 requires of
 * every served read.
 */
async function bindRetrieval(vault: string, id: string): Promise<RetrievalPort> {
  const dataDir = join(vault, ".kizuki", "retrieval", id);
  const registry = new PortRegistry();
  registerEmbeddedRetrieval(registry);
  const { port } = await registry.bindFromConfig<RetrievalPort>("retrieval", { retrieval: id }, {
    vault_path: vault,
    data_dir: dataDir,
    config: loadConfiguredRetrieval(vault).config,
    secrets: () => Promise.reject(new Error("no secret is configured")),
    clock: () => new Date().toISOString(),
    // stdout is the protocol channel; a port's own lines go to stderr.
    logger: (line) => process.stderr.write(`${line.level} ${line.message}\n`),
  });
  // The host registry above contains only the concrete local embedded factory.
  return id === "kizuki.retrieval.embedded-pg" ? bindLocalSourcePort(port, { store_id: `local:${id}` }) : port;
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

  let db: ReturnType<typeof openLedger> | undefined;
  try {
    db = openLedger(join(stateDir, "kizuki.db"), { busyTimeoutMs: 5000 });
    initSearch(db);
    initGraph(db);
    initAgents(db);
  } catch {
    db?.close();
    refuse("vault could not open");
  }

  let principal: Principal;
  if (options.authentication.kind === "owner") {
    principal = ownerPrincipal();
  } else if (options.authentication.kind === "environment") {
    const token = process.env[options.authentication.name];
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
  } else {
    const resolved = authenticateAgentCredential(db, options.authentication.reference);
    if (resolved === null) {
      db.close();
      refuse("credential not recognized");
    }
    principal = resolved;
  }

  let retrieval: RetrievalPort | null = null;
  let retrievalUnavailable: true | undefined;
  try {
    const selectedRetrieval = options.retrieval ?? loadConfiguredRetrieval(options.vault).id;
    if (selectedRetrieval !== "kizuki.retrieval.fts5") {
      retrieval = await bindRetrieval(options.vault, selectedRetrieval);
    }
  } catch (error) {
    // An explicit port is a required binding. A transiently busy configured
    // enhancement may use the same authorized, model-free floor as the CLI.
    if (options.retrieval !== null || !(error instanceof PortError) ||
        !error.retryable || !["lease_required", "timeout", "unavailable"].includes(error.code)) {
      db.close();
      refuse("retrieval port could not start");
    }
    retrievalUnavailable = true;
    process.stderr.write("retrieval-unavailable; using the lexical floor\n");
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
      ...(retrievalUnavailable === undefined ? {} : { retrievalUnavailable }),
    });
  } finally {
    try {
      if (retrieval !== null) await retrieval.close();
    } finally {
      db.close();
    }
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
