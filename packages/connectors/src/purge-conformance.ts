import { isPlainObject } from "@kizuki/core";
import type { Connector, PurgePlan } from "@kizuki/core";

export interface PurgeFixtureRow {
  readonly source_record_id: string;
  /** Digest of the complete synthetic record, including its selection fields. */
  readonly sha256: string;
}

/** Test-owned source only. Never wrap a configured account in this factory. */
export interface PurgeConformanceFixture {
  readonly connector: Connector;
  readonly subject_id: string;
  readonly removable_ids: readonly string[];
  readonly unreachable_ids: readonly string[];
  readonly unrelated_ids: readonly string[];
  snapshot(): Promise<readonly PurgeFixtureRow[]>;
  execute(plan: Readonly<PurgePlan>): Promise<void>;
  verifyAbsent(ids: readonly string[]): Promise<{ checked: number; found: readonly string[] }>;
  dispose(): Promise<void>;
}

/** Creates a fresh connector and an independently observed disposable source. */
export type PurgeConformanceFactory = () => Promise<PurgeConformanceFixture>;
type Timed = <T>(label: string, operation: () => Promise<T>) => Promise<T>;
const MAX_IDS = 10_000;
class PurgeFixtureError extends Error {}
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(id);

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    throw new PurgeFixtureError("purge fixture IDs must be bounded, unique strings");
  }
  const detached: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !Object.hasOwn(entry, "value") || !validId(entry.value)) {
      throw new PurgeFixtureError("purge fixture IDs must be bounded, unique strings");
    }
    detached.push(entry.value);
  }
  if (new Set(detached).size !== detached.length) throw new PurgeFixtureError("purge fixture IDs must be bounded, unique strings");
  return detached.sort();
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function rows(value: unknown): PurgeFixtureRow[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || value.some(row => !isPlainObject(row) ||
      !validId(row["source_record_id"]) || typeof row["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(row["sha256"]))) {
    throw new PurgeFixtureError("purge fixture snapshot is invalid");
  }
  ids(value.map(row => row.source_record_id));
  return value.map(row => ({ source_record_id: row.source_record_id, sha256: row.sha256 }))
    .sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);
}
function plan(value: unknown, subject: string, removable: string[], unreachable: string[]): PurgePlan {
  if (!isPlainObject(value)) throw new PurgeFixtureError("purge fixture plan must be complete and match the exact selector partition");
  const fields = Object.getOwnPropertyDescriptors(value);
  const ownValue = (key: string): unknown => Object.hasOwn(fields, key) ? fields[key]?.value : undefined;
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string" ||
      !["subject_id", "source_record_ids", "unreachable_source_record_ids", "complete", "continuation"].includes(key) || !Object.hasOwn(fields[key]!, "value")) ||
      ownValue("subject_id") !== subject || ownValue("complete") !== true ||
      ownValue("continuation") !== undefined || !same(ids(ownValue("source_record_ids")), removable) ||
      !same(ids(ownValue("unreachable_source_record_ids")), unreachable)) {
    throw new PurgeFixtureError("purge fixture plan must be complete and match the exact selector partition");
  }
  // The executor receives the exact admitted plan, detached from provider state.
  return Object.freeze({ subject_id: subject, source_record_ids: Object.freeze([...removable]),
    unreachable_source_record_ids: Object.freeze([...unreachable]), complete: true }) as unknown as PurgePlan;
}

export async function checkPurgeFixture(base: Connector, factory: PurgeConformanceFactory | undefined,
  timed: Timed, failures: string[]): Promise<void> {
  if (typeof factory !== "function") {
    failures.push("purge capability requires an isolated synthetic fixture factory; configured purgeSource was not called");
    return;
  }
  let fixture: PurgeConformanceFixture | undefined;
  let created: Promise<PurgeConformanceFixture> | undefined;
  let disposalStarted = false;
  const dispose = async (owned: PurgeConformanceFixture): Promise<void> => {
    if (disposalStarted) return;
    disposalStarted = true;
    try {
      if (owned && typeof owned.dispose === "function") await timed("purge fixture disposal", () => owned.dispose());
    } catch { failures.push("purge fixture disposal failed"); }
  };
  try {
    fixture = await timed("purge fixture factory", () => created = Promise.resolve().then(factory));
    if (!fixture || fixture.connector === base || !validId(fixture.subject_id) ||
        typeof fixture.snapshot !== "function" || typeof fixture.execute !== "function" ||
        typeof fixture.verifyAbsent !== "function" || typeof fixture.dispose !== "function") {
      throw new PurgeFixtureError("purge fixture must own a separate connector, source oracle, executor and verifier");
    }
    const expectedManifest = base.manifest(), actualManifest = fixture.connector.manifest();
    if (actualManifest.connector_id !== expectedManifest.connector_id || actualManifest.version !== expectedManifest.version ||
        actualManifest.implementation !== expectedManifest.implementation || actualManifest.capabilities.purge !== true) {
      throw new PurgeFixtureError("purge fixture connector does not match the declared implementation");
    }
    const subject = fixture.subject_id, removable = ids(fixture.removable_ids), unreachable = ids(fixture.unreachable_ids), unrelated = ids(fixture.unrelated_ids);
    const all = ids([...removable, ...unreachable, ...unrelated]);
    if (removable.length + unreachable.length === 0 || unrelated.length === 0) {
      throw new PurgeFixtureError("purge fixture requires selected records and independent retained records");
    }
    const owned = fixture;
    const snapshot = async () => rows(await timed("purge fixture snapshot", () => owned.snapshot()));
    const before = await snapshot();
    if (!same(before.map(row => row.source_record_id), all)) throw new PurgeFixtureError("purge fixture source does not match its known IDs");
    const rawPlan = await timed("purge fixture plan", () => owned.connector.purgeSource(subject));
    if (!same(await snapshot(), before)) throw new PurgeFixtureError("purge fixture planning mutated the source");
    const exact = plan(rawPlan, subject, removable, unreachable);
    if (!same(await snapshot(), before)) throw new PurgeFixtureError("purge fixture admission mutated the source");
    await timed("purge fixture execute", () => owned.execute(exact));
    const proof = await timed("purge fixture verify absence", () => owned.verifyAbsent(removable));
    if (!isPlainObject(proof) || proof["checked"] !== removable.length || !same(ids(proof["found"]), [])) {
      throw new PurgeFixtureError("purge fixture did not prove absence of every removable ID");
    }
    const removed = new Set(removable);
    const survivors = before.filter(row => !removed.has(row.source_record_id));
    const after = await snapshot();
    if (!same(after, survivors)) throw new PurgeFixtureError("purge fixture retained removed records or changed unreachable or unrelated records");
    plan(await timed("purge fixture replan", () => owned.connector.purgeSource(subject)), subject, [], unreachable);
    if (!same(await snapshot(), after)) throw new PurgeFixtureError("purge fixture replanning mutated the source");
  } catch (error) {
    const known = error instanceof PurgeFixtureError;
    failures.push(known ? error.message : "purge fixture qualification failed");
  } finally {
    if (fixture) await dispose(fixture);
    // A deadline stops qualification, not ownership of an eventual factory
    // result. Observe rejection and dispose a late result without retrying it.
    else if (created) void created.then(dispose, () => undefined);
  }
}
