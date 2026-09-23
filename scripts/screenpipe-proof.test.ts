import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ScreenpipeConnector } from "../packages/connector-screenpipe/src";
import {
  SCREENPIPE_AUDIO_SENTINEL, SCREENPIPE_CONNECTOR_ID, SCREENPIPE_CREDENTIAL_SEGMENT, SCREENPIPE_EXPECTED,
  SCREENPIPE_REDACTION_MARKER, SCREENPIPE_SENTINEL, SCREENPIPE_SITE_HOST, SCREENPIPE_SITE_SENTINEL,
  screenpipeFixtureShapes, writeScreenpipeFixture,
} from "./screenpipe-proof-fixtures";
import type { ScreenpipeFixtureShape } from "./screenpipe-proof-fixtures";
import {
  SCREENPIPE_LIMITS, SCREENPIPE_REFUSALS, connectObservation, deniedCaptureObservation, expectedScreenpipeSteps,
  emitScreenpipeConnectorEvidence, exportObservation, parseScreenpipeArgs, refusalObservation, runCounts, statusCount,
} from "./screenpipe-proof";
import { empty } from "./file-import-proof";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(shape: ScreenpipeFixtureShape): string {
  const root = mkdtempSync(join(tmpdir(), "kizuki-screenpipe-fixture-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  writeScreenpipeFixture(path, shape);
  return path;
}
const connector = (path: string) => new ScreenpipeConnector({ path, settle_seconds: 0 }, { now: () => Date.parse("2026-02-01T00:00:00.000Z") });

test("the synthetic stopped database holds exactly the rows the proof expects", async () => {
  const instance = connector(fixture("valid"));
  await instance.connect(async () => { throw new Error("screenpipe requires no secret"); });
  expect((await instance.health()).state).toBe("ok");
  const batch = await instance.backfill(null);
  expect(batch.events).toHaveLength(SCREENPIPE_EXPECTED.backfill_stored);
  expect(batch.events.every(event => event.connector_id === SCREENPIPE_CONNECTOR_ID)).toBe(true);
  expect(batch.events.every(event => event.sensitivity_hint === "private")).toBe(true);
  expect(batch.events.map(event => event.kind).sort()).toEqual(["audio_transcription", "screen_text", "screen_text"]);
  const text = batch.events.map(event => event.text).join("\n");
  for (const sentinel of [SCREENPIPE_SENTINEL, SCREENPIPE_SITE_SENTINEL, SCREENPIPE_AUDIO_SENTINEL]) expect(text).toContain(sentinel);
  await instance.revoke();
});

test("a credential-shaped path segment is dropped and the drop is recorded", async () => {
  const instance = connector(fixture("valid"));
  await instance.connect(async () => { throw new Error("screenpipe requires no secret"); });
  const batch = await instance.backfill(null);
  const body = JSON.stringify(batch.events);
  expect(body).not.toContain(SCREENPIPE_CREDENTIAL_SEGMENT);
  expect(body).toContain(SCREENPIPE_REDACTION_MARKER);
  expect(body).toContain(SCREENPIPE_SITE_HOST);
  await instance.revoke();
});

test("a running or locked database is refused rather than read torn", async () => {
  const path = fixture("valid");
  const locker = new Database(path, { readwrite: true, create: false });
  locker.exec("PRAGMA busy_timeout = 0");
  locker.exec("BEGIN EXCLUSIVE");
  locker.exec("CREATE TABLE IF NOT EXISTS synthetic_exclusive_lock (id INTEGER PRIMARY KEY)");
  try {
    const instance = connector(path);
    const refusal = await instance.connect(async () => { throw new Error("screenpipe requires no secret"); })
      .then(() => null, (error: unknown) => error as Error);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain(SCREENPIPE_REFUSALS.locked);
    expect(await instance.backfill(null).then(() => "stored", () => "refused")).toBe("refused");
    await instance.revoke();
  } finally { locker.exec("ROLLBACK"); locker.close(); }
}, 30_000);

test("a below-floor or malformed database refuses before any event is stored", async () => {
  for (const shape of ["below-floor", "malformed"] as const) {
    const instance = connector(fixture(shape));
    const refusal = await instance.connect(async () => { throw new Error("screenpipe requires no secret"); })
      .then(() => null, (error: unknown) => error as Error);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain(SCREENPIPE_REFUSALS[shape]);
    expect(await instance.backfill(null).then(() => "stored", () => "refused")).toBe("refused");
    await instance.revoke();
  }
});

test("fixture shapes stay synthetic, low-entropy and bounded", () => {
  const shapes = screenpipeFixtureShapes();
  expect(shapes.map(row => row.shape)).toEqual(["valid", "below-floor", "malformed"]);
  // A fixed repeated literal: it matches the connector's documented secret-segment
  // shape without being, or resembling, a real credential.
  expect(SCREENPIPE_CREDENTIAL_SEGMENT).toBe("aaaabbbbccccdddd");
  expect(new Set(SCREENPIPE_CREDENTIAL_SEGMENT).size).toBe(4);
  expect(new Set([SCREENPIPE_SENTINEL, SCREENPIPE_SITE_SENTINEL, SCREENPIPE_AUDIO_SENTINEL]).size).toBe(3);
  expect(SCREENPIPE_SITE_HOST.endsWith(".example.test")).toBe(true);
});

test("the proof takes no source or vault path as a runtime knob", () => {
  expect(() => parseScreenpipeArgs(["--artifact", "/a", "--artifact-proof", "/b", "--report", "/c", "--source", "/private"])).toThrow();
  expect(() => parseScreenpipeArgs(["--artifact", "/a", "--artifact", "/b", "--report", "/c"])).toThrow();
  expect(parseScreenpipeArgs(["--artifact", "/a", "--artifact-proof", "/b", "--report", "/c"]).report).toBe("/c");
});

test("the observed step list is complete, unique and names the whole consent arc", () => {
  const steps = expectedScreenpipeSteps();
  expect(new Set(steps).size).toBe(steps.length);
  for (const id of ["connect", "grant", "backfill", "sync", "revoke", "resume-revocation", "purge-status", "denied-backfill"]) expect(steps).toContain(id);
  for (const id of ["locked-connect", "below-floor-connect", "malformed-connect"]) expect(steps).toContain(id);
});

const KEY = "01JJ0000000000000000000001";
test("the enrolment oracle binds the connector, the exact source path and the consent hint", () => {
  const good = `connected ${SCREENPIPE_CONNECTOR_ID} source=${KEY} path=/synthetic/db.sqlite health=ok\nconsent-required: kizuki connect grant --source ${KEY} --policy POLICY.json --expected-revision 0 --operation-id UNIQUE_ID\n`;
  expect(connectObservation(good, "", "/synthetic/db.sqlite").sourceKey).toBe(KEY);
  for (const [stdout, stderr] of [
    [good.replace(SCREENPIPE_CONNECTOR_ID, "kizuki.markdown-folder"), ""],
    [good.replace("/synthetic/db.sqlite", "/elsewhere/db.sqlite"), ""],
    [good.split("\n")[0] + "\n", ""],
    [good, "unexpected\n"],
  ] as const) expect(() => connectObservation(stdout, stderr, "/synthetic/db.sqlite")).toThrow();
});

test("a refusal must carry the connector's own message on stderr alone", () => {
  const locked = `error: ${SCREENPIPE_CONNECTOR_ID}: screenpipe database is locked; retry\n`;
  expect(refusalObservation("", locked, SCREENPIPE_REFUSALS.locked).degraded).toEqual([SCREENPIPE_REFUSALS.locked]);
  expect(() => refusalObservation("connected kizuki.screenpipe\n", locked, SCREENPIPE_REFUSALS.locked)).toThrow();
  expect(() => refusalObservation("", locked, SCREENPIPE_REFUSALS.malformed)).toThrow();
  expect(() => refusalObservation("", locked + "error: extra\n", SCREENPIPE_REFUSALS.locked)).toThrow();
  expect(() => refusalObservation("", "error: something else\n", SCREENPIPE_REFUSALS.locked)).toThrow();
});

test("run counts refuse invented totals, hidden errors and unexpected diagnostics", () => {
  const line = (stored: number, duplicates: number, proposals: number, errors: number) =>
    `events_stored=${stored} duplicates=${duplicates} proposals_created=${proposals} withdrawn=0 retractions_filed=0 errors=${errors}\n`;
  const expected = { stored: 3, duplicates: 0, proposals: 8, errors: [] as string[], degraded: [] as string[] };
  expect(runCounts(line(3, 0, 8, 0), "", expected).stored).toBe(3);
  expect(() => runCounts(line(4, 0, 8, 0), "", expected)).toThrow();
  expect(() => runCounts(line(3, 0, 9, 0), "", expected)).toThrow();
  expect(() => runCounts(line(3, 0, 8, 0), "error: synthetic\n", expected)).toThrow();
  expect(() => runCounts(line(3, 0, 8, 0) + "extra\n", "", expected)).toThrow();
  const duplicates = { stored: 0, duplicates: 3, proposals: 0, errors: [] as string[], degraded: [] as string[] };
  expect(runCounts(`kizuki.screenpipe source=${KEY} ${line(0, 3, 0, 0)}`, "", duplicates).duplicates).toBe(3);
  expect(() => runCounts(`kizuki.screenpipe source=${KEY} ${line(0, 0, 0, 0)}`, "", duplicates)).toThrow();
});

test("a purged source must be refused capture with its own consent hint", () => {
  const denial = `error: source_capture_denied; consent-required: kizuki connect grant --source ${KEY} --policy POLICY.json --expected-revision 3 --operation-id UNIQUE_ID\n`;
  expect(deniedCaptureObservation("", denial, KEY).consent).toBe("denied");
  expect(() => deniedCaptureObservation("events_stored=3 duplicates=0\n", denial, KEY)).toThrow();
  expect(() => deniedCaptureObservation("", denial, "01JJ0000000000000000000009")).toThrow();
  expect(() => deniedCaptureObservation("", "error: source_capture_denied\n", KEY)).toThrow();
});

test("status cardinality refuses a connection a refused database must not have created", () => {
  const body = (connections: unknown[]) => JSON.stringify({ schema: "kizuki.cli.connect/v1", status: "ok", degraded: [], warnings: [], data: { connections } });
  expect(statusCount(body([]), "", 0).stored).toBe(0);
  expect(() => statusCount(body([{ connector_id: SCREENPIPE_CONNECTOR_ID }]), "", 0)).toThrow();
  expect(() => statusCount(body([]), "unexpected\n", 0)).toThrow();
});

test("the export oracle refuses a retained credential shape and an unrecorded drop", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-screenpipe-export-"));
  roots.push(root);
  const directory = join(root, "export");
  const stdout = (complete: boolean) => `manifest=${directory}/manifest.json\nschema=kizuki.export/v1 complete=${complete}\nvault_files=1 events=3\n`;
  const write = async (lines: string[]) => {
    rmSync(join(directory, "ledger"), { recursive: true, force: true });
    await Bun.write(join(directory, "ledger", "events.jsonl"), lines.join("\n") + "\n");
  };
  const event = (text: string) => JSON.stringify({ text, metadata: { url: `https://${SCREENPIPE_SITE_HOST}/s/${SCREENPIPE_REDACTION_MARKER}` } });
  await write([event(SCREENPIPE_SENTINEL), event(SCREENPIPE_SITE_SENTINEL), event(SCREENPIPE_AUDIO_SENTINEL)]);
  expect(exportObservation(stdout(true), "", directory).stored).toBe(SCREENPIPE_EXPECTED.backfill_stored);
  expect(() => exportObservation(stdout(false), "", directory)).toThrow();
  await write([event(SCREENPIPE_SENTINEL), event(SCREENPIPE_SITE_SENTINEL), JSON.stringify({ text: `${SCREENPIPE_AUDIO_SENTINEL} ${SCREENPIPE_CREDENTIAL_SEGMENT}` })]);
  expect(() => exportObservation(stdout(true), "", directory)).toThrow();
});

test("the recorded limits stay the connector's own documented ones", () => {
  expect(SCREENPIPE_LIMITS.length).toBe(4);
  expect(SCREENPIPE_LIMITS.join(" ")).toContain("ledger purge is the path that removes imported evidence");
  expect(SCREENPIPE_LIMITS.join(" ")).toContain("no source-side purge");
});

test("connector evidence emits only counts observed by successful steps and names failed run integrity", () => {
  const report = mkdtempSync(join(tmpdir(), "kizuki-screenpipe-emission-"));
  roots.push(report);
  emitScreenpipeConnectorEvidence(report, "a".repeat(40), [{
    id: "connect", command: ["connect", "screenpipe"], expected_exit: 0, exit_code: 1, passed: false,
    stdout_sha256: "b".repeat(64), stderr_sha256: "c".repeat(64),
    observation: { ...empty(), stored: SCREENPIPE_EXPECTED.backfill_stored, proposals: SCREENPIPE_EXPECTED.proposals_created },
    failure: "synthetic-connect-refusal",
  }], false);
  const index = JSON.parse(readFileSync(join(report, "connector-evidence", "index.json"), "utf8"));
  expect(index.emissions[0].row_counts).toEqual({});
  expect(index.unresolved).toContain(`${SCREENPIPE_CONNECTOR_ID}:failed-step:connect:synthetic-connect-refusal`);
  expect(index.unresolved).toContain(`${SCREENPIPE_CONNECTOR_ID}:run-integrity:proof-failed`);
  expect(index.emissions[0].acceptance_credit).toBe(false);
});

test("connector evidence uses observed capture counts instead of fixture constants", () => {
  const report = mkdtempSync(join(tmpdir(), "kizuki-screenpipe-observed-"));
  roots.push(report);
  const step = (id: string, observation: ReturnType<typeof empty>) => ({
    id, command: [id], expected_exit: 0, exit_code: 0, passed: true,
    stdout_sha256: "b".repeat(64), stderr_sha256: "c".repeat(64), observation, failure: null,
  });
  emitScreenpipeConnectorEvidence(report, "a".repeat(40), [
    step("backfill", { ...empty(), stored: 7, proposals: 11 }),
    step("repeat-backfill", { ...empty(), duplicates: 5 }),
    step("sync", { ...empty(), stored: 2 }),
  ], false);
  const index = JSON.parse(readFileSync(join(report, "connector-evidence", "index.json"), "utf8"));
  expect(index.emissions[0].row_counts).toEqual({ events_stored: 7, proposals_created: 11, repeat_duplicates: 5, sync_stored: 2 });
});
