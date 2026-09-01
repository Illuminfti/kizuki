#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  accept,
  count,
  doctorVault,
  initVault,
  openLedger,
  parseFrontmatter,
  readCheckpoint,
  replay,
  writeCheckpoint,
} from "@kizuki/core";
import type { CaptureEvent } from "@kizuki/core";
import {
  SENSITIVITY_LEVELS,
  STAGING_STATUSES,
  cascadeTombstone,
  fileProposal,
  initStaging,
  listProposals,
  ownerPromote,
  proposalsForEvent,
  readReceiptsLog,
  setProposalStatus,
} from "@kizuki/core/staging";
import type {
  Sensitivity,
  StagedProposal,
  StagingStatus,
} from "@kizuki/core/staging";
import { getConnector } from "@kizuki/connectors";

const USAGE =
  "usage: kizuki <init|ingest|proposals|promote|reject|query|doctor|version>";

class UsageError extends Error {}

interface ParsedArguments {
  options: Map<string, string>;
  positionals: string[];
}

function parseArguments(
  tokens: string[],
  allowedOptions: string[],
): ParsedArguments {
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
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(USAGE);
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

function assertVault(vaultPath: string): string {
  const absolutePath = resolve(vaultPath);
  // The two markers every initialized vault has; also what the vault writer
  // uses to find the root.
  if (
    !existsSync(join(absolutePath, ".kizuki")) ||
    !existsSync(join(absolutePath, "archive"))
  ) {
    throw new Error(`vault is not initialized: ${absolutePath}`);
  }
  return absolutePath;
}

function openVaultDb(vaultPath: string): Database {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initStaging(db);
  return db;
}

function isSensitivity(value: string): value is Sensitivity {
  return (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

function snippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return compact.slice(0, 120);
  const start = Math.max(0, index - 40);
  const end = Math.min(compact.length, index + query.length + 80);
  return compact.slice(start, end);
}

function summarize(proposal: StagedProposal): string {
  return proposal.body.replace(/\s+/g, " ").trim().slice(0, 160);
}

function printProposalTable(rows: StagedProposal[]): void {
  const values = [
    ["id", "kind", "producer", "summary"],
    ...rows.map((row) => [
      row.proposal_id,
      row.kind,
      row.producer,
      summarize(row),
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

interface CanonPage {
  body: string;
  id: string;
  path: string;
}

function readCanonPages(vaultPath: string): CanonPage[] {
  const pages: CanonPage[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === ".kizuki") continue;
      // archive/ holds retracted pages and prior revisions; never served.
      if (entry.name === "archive" && directory === vaultPath) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        entry.name === "CANON.md" ||
        entry.name === "SCHEMA.md"
      ) {
        continue;
      }
      try {
        const page = parseFrontmatter(readFileSync(target, "utf8"));
        const id = page.data["id"];
        if (typeof id === "string" && page.data["status"] !== "archived") {
          pages.push({ body: page.body, id, path: target });
        }
      } catch {
        // Doctor reports malformed pages; query only serves parseable ones.
      }
    }
  };
  walk(vaultPath);
  return pages;
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
    const vaultPath = resolve(parsed.positionals[0] ?? "");
    initVault(vaultPath);
    console.log(vaultPath);
    return 0;
  }

  if (verb === "ingest") {
    const parsed = parseArguments(rest, ["--vault", "--source"]);
    requirePositionals(parsed.positionals, 1);
    const connectorId = parsed.positionals[0] ?? "";
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const sourcePath = resolve(parsed.options.get("--source") ?? process.cwd());
    const connector = getConnector(connectorId, { path: sourcePath });
    await connector.connect(async (secretRef: string) => {
      throw new Error(`no secret configured for ${secretRef}`);
    });
    const db = openVaultDb(vaultPath);
    let stored = 0;
    let duplicates = 0;
    let proposalsCreated = 0;
    let withdrawn = 0;
    let retractionsFiled = 0;
    try {
      // First run backfills; later runs resume from the stored checkpoint so
      // `sync` can emit tombstones for records that vanished at the source.
      const cursor = readCheckpoint(db, connectorId, sourcePath);
      const batch =
        cursor === null
          ? await connector.backfill(null)
          : await connector.sync(cursor);
      const storedEvents: CaptureEvent[] = [];
      for (const input of batch.events) {
        const result = accept(db, input);
        if (result.status === "error") {
          throw new Error(`event could not be accepted: ${result.error}`);
        }
        if (result.status === "duplicate") {
          duplicates += 1;
          continue;
        }
        stored += 1;
        storedEvents.push(result.event);
      }
      for (const event of storedEvents) {
        if (event.deleted) {
          const cascade = cascadeTombstone(db, event);
          withdrawn += cascade.withdrawn.length;
          retractionsFiled += cascade.retractions_filed.length;
          continue;
        }
        for (const input of proposalsForEvent(event)) {
          if (fileProposal(db, input).outcome === "stored") {
            proposalsCreated += 1;
          }
        }
      }
      if (batch.cursor !== null) {
        writeCheckpoint(db, connectorId, sourcePath, batch.cursor);
      }
    } finally {
      db.close();
    }
    console.log(
      `events_stored=${stored} duplicates=${duplicates} proposals_created=${proposalsCreated} withdrawn=${withdrawn} retractions_filed=${retractionsFiled}`,
    );
    return 0;
  }

  if (verb === "proposals") {
    const parsed = parseArguments(rest, ["--vault", "--status"]);
    requirePositionals(parsed.positionals, 0);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const rawStatus = parsed.options.get("--status") ?? "pending";
    const status = rawStatus === "open" ? "pending" : rawStatus;
    if (!(STAGING_STATUSES as readonly string[]).includes(status)) {
      throw new Error(
        `--status must be one of open | ${STAGING_STATUSES.join(" | ")}`,
      );
    }
    const db = openVaultDb(vaultPath);
    try {
      printProposalTable(
        listProposals(db, { status: status as StagingStatus }),
      );
    } finally {
      db.close();
    }
    return 0;
  }

  if (verb === "promote") {
    const parsed = parseArguments(rest, ["--vault", "--sensitivity"]);
    requirePositionals(parsed.positionals, 1);
    const rawSensitivity = parsed.options.get("--sensitivity");
    if (rawSensitivity === undefined)
      throw new Error("--sensitivity is required");
    if (!isSensitivity(rawSensitivity)) {
      throw new Error("--sensitivity must be public, personal, or private");
    }
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const db = openVaultDb(vaultPath);
    try {
      const receipt = ownerPromote(db, vaultPath, parsed.positionals[0] ?? "", {
        sensitivity: rawSensitivity,
      });
      console.log(`page_path=${join(vaultPath, receipt.page_path)}`);
      console.log(`receipt_id=${receipt.receipt_id}`);
    } finally {
      db.close();
    }
    return 0;
  }

  if (verb === "reject") {
    const parsed = parseArguments(rest, ["--vault", "--reason"]);
    requirePositionals(parsed.positionals, 1);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const reason = requireOption(parsed.options, "--reason");
    const proposalId = parsed.positionals[0] ?? "";
    const db = openVaultDb(vaultPath);
    try {
      setProposalStatus(db, proposalId, "rejected", reason);
    } finally {
      db.close();
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
        console.log(
          `page ${page.id} ${page.path} ${snippet(page.body, query)}`,
        );
      }
    }
    const db = openVaultDb(vaultPath);
    try {
      // Two passes: a record with a tombstone is deleted at the source, so
      // none of its events are served, only stored.
      const events = [...replay(db, {})];
      const tombstoned = new Set(
        events
          .filter((event) => event.deleted)
          .map((event) => `${event.connector_id} ${event.source_record_id}`),
      );
      for (const event of events) {
        if (event.deleted) continue;
        if (tombstoned.has(`${event.connector_id} ${event.source_record_id}`)) {
          continue;
        }
        if (
          event.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ) {
          console.log(`event ${event.event_id} ${snippet(event.text, query)}`);
        }
      }
    } finally {
      db.close();
    }
    return 0;
  }

  if (verb === "doctor") {
    const parsed = parseArguments(rest, ["--vault"]);
    requirePositionals(parsed.positionals, 0);
    const vaultPath = assertVault(requireOption(parsed.options, "--vault"));
    const report = doctorVault(vaultPath);
    const db = openVaultDb(vaultPath);
    try {
      console.log(`events=${count(db)}`);
      // A pending deletion proposal is a source record that vanished while its
      // canon page still stands — the owner decision doctor must surface.
      for (const proposal of listProposals(db, {
        kind: "deletion",
        status: "pending",
      })) {
        console.log(
          `retraction-pending ${proposal.proposal_id} page=${proposal.target ?? ""}.md`,
        );
      }
    } finally {
      db.close();
    }
    for (const receipt of readReceiptsLog(vaultPath)) {
      console.log(
        `receipt ${receipt.receipt_id} proposal=${receipt.proposal_id} page=${receipt.page_path} at=${receipt.at}`,
      );
    }
    for (const page of report.pages) {
      for (const error of page.errors) {
        console.log(`problem ${page.page}: ${error}`);
      }
    }
    if (report.counts.invalid > 0) {
      console.error(
        `error: vault doctor found ${report.counts.invalid} invalid page(s)`,
      );
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
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
