import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentEnrollmentError, authenticateAgentCredential, enrollAppAgent, listAgents, listAudit, revokeAgentEnrollment, type AgentEnrollmentErrorCode, type AppAgentEnrollmentRequest } from "../../src";
import { openLedger } from "../../src/ledger/db";
import { tryWriteFlock } from "../../src/serve/flock";
import { gateAsync } from "../../src/serving/gate";
import { ServeError } from "../../src/serving/types";
import { tempVault } from "../helpers/vault";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

function fixture() {
  const vault = tempVault("kizuki-app-agent-"); disposers.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki/kizuki.db");
  const db = openLedger(dbPath); db.close(); chmodSync(dbPath, 0o600);
  const directory = join(vault.path, ".kizuki/agent-credentials");
  const request: AppAgentEnrollmentRequest = {
    operation_id: "app-agent-0001", name: "app-reader",
    grant: { ceiling: "personal", types: ["fact"], subjects: ["person:ada"], since: null, until: null,
      tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false },
  };
  return { vault: vault.path, dbPath, directory, credential: join(directory, `app-${request.operation_id}.json`), request };
}

function refusal(work: () => unknown, code: AgentEnrollmentErrorCode): void {
  let error: unknown;
  try { work(); } catch (caught) { error = caught; }
  expect(error instanceof AgentEnrollmentError).toBe(true);
  expect((error as AgentEnrollmentError)?.code).toBe(code);
  expect((error as Error)?.message).toBe(code);
}

test("app enrollment creates one private managed credential through the existing authority writer", () => {
  const f = fixture();
  const first = enrollAppAgent(f.vault, f.request);
  expect(first.receipt).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: false, grant: f.request.grant });
  expect(first.token_ref === `file:${f.credential}`).toBe(true);
  expect(lstatSync(f.directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(f.credential).mode & 0o777).toBe(0o600);
  const before = lstatSync(f.credential), bytes = readFileSync(f.credential);
  const token = (JSON.parse(bytes.toString()) as { token: string }).token;
  expect(JSON.stringify(first).includes(token), "result never contains credential bytes").toBe(false);
  const db = openLedger(f.dbPath);
  try {
    const principal = authenticateAgentCredential(db, first.token_ref!);
    expect(principal?.kind).toBe("agent");
    if (principal?.kind !== "agent") throw new Error("expected scoped principal");
    expect(principal.grant).toEqual(f.request.grant);
    expect(listAgents(db)).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM agent_enrollments").get()).toEqual({ n: 1 });
  } finally { db.close(); }
  const replay = enrollAppAgent(f.vault, f.request);
  expect(replay.receipt).toEqual({ ...first.receipt, replayed: true });
  expect(replay.token_ref === first.token_ref).toBe(true);
  expect(lstatSync(f.credential).ino).toBe(before.ino);
  expect(readFileSync(f.credential).equals(bytes), "retry preserves the original credential").toBe(true);
});

test("app enrollment validates the complete explicit request before creating a directory", () => {
  const f = fixture();
  const { relay_owner_corrections: _, ...partialGrant } = f.request.grant;
  for (const [request, code] of [
    [{ ...f.request, grant: partialGrant }, "invalid_grant"],
    [{ ...f.request, grant: { ...f.request.grant, extra: true } }, "invalid_grant"],
    [{ ...f.request, grant: { ...f.request.grant, ceiling: "owner" } }, "invalid_grant"],
    [{ ...f.request, grant: { ...f.request.grant, tools: ["everything"] } }, "invalid_grant"],
    [{ ...f.request, grant: { ...f.request.grant, rate_limit_per_minute: 1001 } }, "invalid_grant"],
    [{ ...f.request, name: "owner" }, "invalid_request"],
    [{ ...f.request, operation_id: "../outside" }, "invalid_request"],
    [{ ...f.request, token_ref: "file:/synthetic-forbidden-destination" }, "invalid_request"],
  ] as const) refusal(() => enrollAppAgent(f.vault, request as AppAgentEnrollmentRequest), code);
  expect(existsSync(f.directory)).toBe(false);
  const db = openLedger(f.dbPath);
  try { expect(listAgents(db)).toEqual([]); } finally { db.close(); }
});

for (const kind of ["symlink", "public-directory", "regular-file"] as const) {
  test(`app enrollment refuses ${kind} at its managed parent without repairing it`, () => {
    const f = fixture(), outside = tempVault("kizuki-app-agent-outside-"); disposers.push(outside.dispose);
    const sentinel = join(outside.path, "sentinel"); writeFileSync(sentinel, "synthetic outside owner bytes");
    if (kind === "symlink") symlinkSync(outside.path, f.directory);
    else if (kind === "public-directory") mkdirSync(f.directory, { mode: 0o755 });
    else writeFileSync(f.directory, "synthetic parent owner bytes");
    refusal(() => enrollAppAgent(f.vault, f.request), "credential_unsafe");
    expect(readFileSync(sentinel, "utf8") === "synthetic outside owner bytes").toBe(true);
    if (kind === "symlink") expect(lstatSync(f.directory).isSymbolicLink()).toBe(true);
    if (kind === "public-directory") expect(lstatSync(f.directory).mode & 0o777).toBe(0o755);
    if (kind === "regular-file") expect(readFileSync(f.directory, "utf8") === "synthetic parent owner bytes").toBe(true);
    const db = openLedger(f.dbPath);
    try { expect(listAgents(db)).toEqual([]); } finally { db.close(); }
  });
}

test("app enrollment preserves a conflicting credential and the original operation binding", () => {
  const f = fixture(); mkdirSync(f.directory, { mode: 0o700 }); writeFileSync(f.credential, "synthetic existing credential bytes", { mode: 0o600 });
  refusal(() => enrollAppAgent(f.vault, f.request), "credential_conflict");
  expect(readFileSync(f.credential, "utf8") === "synthetic existing credential bytes").toBe(true);
  const other = fixture(); const enrolled = enrollAppAgent(other.vault, other.request);
  refusal(() => enrollAppAgent(other.vault, { ...other.request, name: "different-reader" }), "operation_conflict");
  refusal(() => enrollAppAgent(other.vault, { ...other.request, operation_id: "app-agent-0002" }), "name_conflict");
  expect(enrollAppAgent(other.vault, other.request).receipt.agent_id).toBe(enrolled.receipt.agent_id);
});

test("app enrollment shares the file-only writer and retries after contention", () => {
  const f = fixture(); const lock = tryWriteFlock(f.vault); expect(lock).not.toBeNull();
  try { refusal(() => enrollAppAgent(f.vault, f.request), "enrollment_busy"); expect(existsSync(f.directory)).toBe(false); }
  finally { lock!.release(); }
  expect(enrollAppAgent(f.vault, f.request).receipt.authority).toBe("active");
});

test("revocation and damaged credentials never return launchable references on replay", () => {
  const f = fixture(); enrollAppAgent(f.vault, f.request);
  const original = readFileSync(f.credential);
  expect(revokeAgentEnrollment(f.vault, f.request.name).authority).toBe("revoked");
  const replay = enrollAppAgent(f.vault, f.request);
  expect(replay.receipt.authority).toBe("revoked"); expect(replay.token_ref).toBeNull();
  expect(readFileSync(f.credential).equals(original), "revocation retains credential custody").toBe(true);
  refusal(() => enrollAppAgent(f.vault, { ...f.request, operation_id: "app-agent-0002" }), "name_conflict");
  const other = fixture(); enrollAppAgent(other.vault, other.request);
  writeFileSync(other.credential, "synthetic damaged credential");
  const damaged = enrollAppAgent(other.vault, other.request);
  expect(damaged.receipt.credential).not.toBe("ready"); expect(damaged.token_ref).toBeNull();
});

test("an app-enrolled principal cannot release an already authorized async response after revocation", async () => {
  const f = fixture(), enrolled = enrollAppAgent(f.vault, f.request), db = openLedger(f.dbPath);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  try {
    const principal = authenticateAgentCredential(db, enrolled.token_ref!);
    if (principal?.kind !== "agent") throw new Error("expected scoped principal");
    const pending = gateAsync({ db, vaultPath: f.vault, principal }, "search", { query: "synthetic pending query" }, async () => {
      entered = true;
      await held;
      return { canon: [], quoted: [], withheld: [], data: { text: "SYNTHETIC_WITHDRAWN_RESPONSE" } };
    }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    expect(entered, "the call passed authority checks before revocation").toBe(true);
    expect(revokeAgentEnrollment(f.vault, f.request.name).authority).toBe("revoked");
    release();
    const completed = await pending;
    expect(completed.value).toBeNull();
    expect(completed.error instanceof ServeError).toBe(true);
    expect((completed.error as ServeError).code).toBe("unknown_agent");
    const audit = listAudit(db, f.request.name, { limit: 10 });
    expect(audit.find(row => row.tool === "search")?.denied).toEqual([{ id: "tool:search", reason: "unknown_agent" }]);
    expect(JSON.stringify(audit).includes("SYNTHETIC_WITHDRAWN_RESPONSE")).toBe(false);
  } finally { release(); db.close(); }
});
