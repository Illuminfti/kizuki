#!/usr/bin/env bun
import { MarkdownFolderConnector } from "./connectors-shim";
import { Ledger } from "./ledger-shim";
import { lastReceipts, Staging } from "./staging-shim";
import type { ProposalStatus } from "@kizuki/core";
import {
  assertVault,
  doctor as doctorVault,
  initVault,
  isSensitivity,
  readCanonPages,
} from "./vault-shim";

const USAGE =
  "usage: kizuki <init|ingest|proposals|promote|reject|query|doctor|version>";

class UsageError extends Error {}

interface ParsedArguments {
  options: Map<string, string>;
  positionals: string[];
}

function parseArguments(tokens: string[], allowedOptions: string[]): ParsedArguments {
  const allowed = new Set(allowedOptions);
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token) || options.has(token)) throw new UsageError(USAGE);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(USAGE);
    options.set(token, value);
    index += 1;
  }
  return { options, positionals };
}

function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function requirePositionals(positionals: string[], count: number): void {
  if (positionals.length !== count) throw new UsageError(USAGE);
}

function snippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return compact.slice(0, 120);
  const start = Math.max(0, index - 40);
  const end = Math.min(compact.length, index + query.length + 80);
  return compact.slice(start, end);
}

function printProposalTable(
  rows: Array<{ id: string; kind: string; producer: string; summary: string }>,
): void {
  const values = [
    ["id", "kind", "producer", "summary"],
    ...rows.map((row) => [
      row.id,
      row.kind,
      row.producer,
      row.summary.replace(/\s+/g, " ").trim(),
    ]),
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...values.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of values) {
    const line = row
      .map((value, column) =>
        column < 3 ? value.padEnd(widths[column] ?? value.length) : value,
      )
      .join("  ")
      .trimEnd();
    console.log(line);
  }
}

async function run(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  if (verb === undefined) throw new UsageError(USAGE);

  if (verb === "version") {
    requirePositionals(rest, 0);
    console.log("0.1.0");
    return 0;
  }

  if (verb === "init") {
    const parsed = parseArguments(rest, []);
    requirePositionals(parsed.positionals, 1);
    console.log(initVault(parsed.positionals[0] ?? ""));
    return 0;
  }

  if (verb === "ingest") {
    const parsed = parseArguments(rest, ["--vault", "--source"]);
    requirePositionals(parsed.positionals, 1);
    const connectorId = parsed.positionals[0];
    if (connectorId !== "kizuki.markdown-folder") {
      throw new Error(`unknown connector: ${connectorId ?? ""}`);
    }
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const connector = new MarkdownFolderConnector(
      parsed.options.get("--source") ?? process.cwd(),
    );
    await connector.connect(async () => {
      throw new Error("markdown connector does not use secrets");
    });
    const batch = await connector.backfill(null);
    const ledger = new Ledger(vaultPath);
    let stored = 0;
    let duplicates = 0;
    const storedEvents = [];
    try {
      for (const input of batch.events) {
        const result = ledger.accept(input);
        if (result === "error") throw new Error("event could not be accepted");
        if (result === "duplicate") {
          duplicates += 1;
          continue;
        }
        stored += 1;
        const event = ledger.findAccepted(input);
        if (event === undefined) throw new Error("stored event could not be read back");
        storedEvents.push(event);
      }
    } finally {
      ledger.close();
    }
    const staging = new Staging(vaultPath);
    try {
      const proposalsCreated = staging.createProposalsFromEvents(storedEvents);
      console.log(
        `events_stored=${stored} duplicates=${duplicates} proposals_created=${proposalsCreated}`,
      );
    } finally {
      staging.close();
    }
    return 0;
  }

  if (verb === "proposals") {
    const parsed = parseArguments(rest, ["--vault", "--status"]);
    requirePositionals(parsed.positionals, 0);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const rawStatus = parsed.options.get("--status") ?? "pending";
    const status = rawStatus === "open" ? "pending" : rawStatus;
    const staging = new Staging(vaultPath);
    try {
      printProposalTable(staging.listProposals(status as ProposalStatus));
    } finally {
      staging.close();
    }
    return 0;
  }

  if (verb === "promote") {
    const parsed = parseArguments(rest, ["--vault", "--sensitivity"]);
    requirePositionals(parsed.positionals, 1);
    const rawSensitivity = parsed.options.get("--sensitivity");
    if (rawSensitivity === undefined) throw new Error("--sensitivity is required");
    if (!isSensitivity(rawSensitivity)) {
      throw new Error("--sensitivity must be public, personal, or private");
    }
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const staging = new Staging(vaultPath);
    try {
      const result = staging.promote(parsed.positionals[0] ?? "", rawSensitivity);
      console.log(`page_path=${result.pagePath}`);
      console.log(`receipt_id=${result.receiptId}`);
    } finally {
      staging.close();
    }
    return 0;
  }

  if (verb === "reject") {
    const parsed = parseArguments(rest, ["--vault", "--reason"]);
    requirePositionals(parsed.positionals, 1);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const reason = requireOption(parsed.options, "--reason");
    const proposalId = parsed.positionals[0] ?? "";
    const staging = new Staging(vaultPath);
    try {
      staging.reject(proposalId, reason);
    } finally {
      staging.close();
    }
    console.log(`proposal_id=${proposalId} status=rejected`);
    return 0;
  }

  if (verb === "query") {
    const parsed = parseArguments(rest, ["--vault"]);
    requirePositionals(parsed.positionals, 1);
    const query = parsed.positionals[0] ?? "";
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    for (const page of readCanonPages(vaultPath)) {
      if (page.body.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
        console.log(`page ${page.id} ${page.path} ${snippet(page.body, query)}`);
      }
    }
    const ledger = new Ledger(vaultPath);
    try {
      for (const event of ledger.searchText(query)) {
        console.log(`event ${event.event_id} ${snippet(event.text, query)}`);
      }
    } finally {
      ledger.close();
    }
    return 0;
  }

  if (verb === "doctor") {
    const parsed = parseArguments(rest, ["--vault"]);
    requirePositionals(parsed.positionals, 0);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const problems = doctorVault(vaultPath);
    const ledger = new Ledger(vaultPath);
    try {
      console.log(`events=${ledger.count()}`);
    } finally {
      ledger.close();
    }
    for (const receipt of lastReceipts(vaultPath)) {
      console.log(
        `receipt ${receipt.receipt_id} proposal=${receipt.proposal_id} page=${receipt.page_path} at=${receipt.at}`,
      );
    }
    for (const problem of problems) console.log(`problem ${problem}`);
    if (problems.length > 0) {
      console.error(`error: vault doctor found ${problems.length} problem(s)`);
      return 1;
    }
    return 0;
  }

  throw new UsageError(USAGE);
}

try {
  process.exitCode = await run(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
