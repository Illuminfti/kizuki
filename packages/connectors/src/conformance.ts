import {
  CONNECTOR_SCHEMA,
  isPlainObject,
  validateEventInput,
} from "@kizuki/core";
import type {
  Connector,
  Cursor,
  Manifest,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "./errors";
import { InMemoryLedger } from "./ledger";
import { errorMessage } from "./util";

export interface TombstoneConformanceHooks {
  prepare(): Promise<Cursor | null>;
  mutate(): Promise<void>;
}

export interface ConformanceOptions {
  backfillTwice?: boolean;
  tombstone?: TombstoneConformanceHooks;
}

export interface ConformanceResult {
  pass: boolean;
  failures: string[];
}

export async function runConformance(
  connector: Connector,
  opts: ConformanceOptions = {},
): Promise<ConformanceResult> {
  try {
    return await runConformanceChecks(connector, opts);
  } catch (error) {
    return {
      pass: false,
      failures: [`conformance battery crashed: ${errorMessage(error)}`],
    };
  }
}

async function runConformanceChecks(
  connector: Connector,
  opts: ConformanceOptions,
): Promise<ConformanceResult> {
  const failures: string[] = [];
  let rawManifest: unknown;
  try {
    rawManifest = connector.manifest();
  } catch (error) {
    failures.push(`manifest() rejected: ${errorMessage(error)}`);
    return result(failures);
  }
  const manifest = parseManifest(rawManifest, failures);
  if (manifest === undefined) return result(failures);

  let fixtureEvents: unknown[] | undefined;
  if (manifest.capabilities.fixture) {
    try {
      const fixture = await connector.fixture();
      if (!Array.isArray(fixture) || fixture.length === 0) {
        failures.push(
          "fixture capability declared but fixture() returned no events",
        );
      } else {
        fixtureEvents = fixture;
        inspectEvents(fixture, "fixture", manifest, failures);
      }
    } catch (error) {
      failures.push(
        `fixture capability declared but fixture() rejected: ${errorMessage(error)}`,
      );
    }
  }

  if (manifest.capabilities.backfill) {
    try {
      inspectBatch(
        await connector.backfill(null),
        "backfill(null)",
        manifest,
        failures,
      );
    } catch (error) {
      failures.push(
        `backfill capability declared but backfill(null) rejected: ${errorMessage(error)}`,
      );
    }
  }

  if (manifest.capabilities.sync) {
    try {
      inspectBatch(
        await connector.sync(null),
        "sync(null)",
        manifest,
        failures,
      );
    } catch (error) {
      failures.push(
        `sync capability declared but sync(null) rejected: ${errorMessage(error)}`,
      );
    }
  }

  if (manifest.capabilities.purge) {
    try {
      const plan = await connector.purgeSource("conformance:subject");
      if (
        !isPlainObject(plan) ||
        plan["subject_id"] !== "conformance:subject" ||
        !Array.isArray(plan["source_record_ids"]) ||
        !Array.isArray(plan["unreachable_source_record_ids"])
      ) {
        failures.push(
          "purge capability declared but purgeSource() returned an invalid plan",
        );
      }
    } catch (error) {
      failures.push(
        `purge capability declared but purgeSource() rejected: ${errorMessage(error)}`,
      );
    }
  }

  if (fixtureEvents !== undefined) {
    const ledger = new InMemoryLedger();
    const first = ledger.acceptMany(fixtureEvents);
    if (!first.every((accept) => accept.status === "stored")) {
      failures.push(
        "fixture round-trip: first accept did not store every event",
      );
    }
    const second = ledger.acceptMany(fixtureEvents);
    if (!second.every((accept) => accept.status === "duplicate")) {
      failures.push(
        "fixture round-trip: repeated accept was not entirely duplicate",
      );
    }
  }

  if (manifest.required_secrets.length > 0) {
    const rejectResolver: SecretResolver = async (secretRef) => {
      throw new KizukiError("missing_secret", `missing ${secretRef}`);
    };
    try {
      await connector.connect(rejectResolver);
      failures.push(
        "connect fail-closed: connector accepted missing required secrets",
      );
    } catch (error) {
      if (!(error instanceof KizukiError)) {
        failures.push("connect fail-closed: rejection was not a KizukiError");
      }
    }
  }

  if (manifest.capabilities.backfill && opts.backfillTwice !== false) {
    try {
      const first = inspectBatch(
        await connector.backfill(null),
        "first backfill",
        manifest,
        failures,
      );
      const second = inspectBatch(
        await connector.backfill(null),
        "second backfill",
        manifest,
        failures,
      );
      if (first !== undefined && second !== undefined) {
        if (first.events.length !== second.events.length) {
          failures.push("double-backfill: event counts differ");
        }
        const ledger = new InMemoryLedger();
        const firstAccepts = ledger.acceptMany(first.events);
        if (!firstAccepts.every((accept) => accept.status === "stored")) {
          failures.push("double-backfill: first batch was not entirely stored");
        }
        const secondAccepts = ledger.acceptMany(second.events);
        if (!secondAccepts.every((accept) => accept.status === "duplicate")) {
          failures.push(
            "double-backfill: second batch was not entirely duplicate",
          );
        }
      }
    } catch (error) {
      failures.push(`double-backfill rejected: ${errorMessage(error)}`);
    }
  }

  if (manifest.capabilities.tombstones && opts.tombstone === undefined) {
    // Fail, don't skip: a tombstones:true manifest with no hooks supplied
    // would otherwise self-certify without ever emitting a deleted event.
    failures.push(
      "tombstones capability declared but no tombstone hooks were supplied to the suite",
    );
  }

  if (manifest.capabilities.tombstones && opts.tombstone !== undefined) {
    try {
      const cursor = await opts.tombstone.prepare();
      await opts.tombstone.mutate();
      const batch = inspectBatch(
        await connector.sync(cursor),
        "tombstone sync",
        manifest,
        failures,
      );
      if (
        batch !== undefined &&
        !batch.events.some((event) => event.deleted === true)
      ) {
        failures.push("tombstone sync emitted no deleted event");
      }
    } catch (error) {
      failures.push(`tombstone check rejected: ${errorMessage(error)}`);
    }
  }

  return result(failures);
}

function parseManifest(raw: unknown, failures: string[]): Manifest | undefined {
  if (!isPlainObject(raw)) {
    failures.push("manifest: must be an object");
    return undefined;
  }
  if (raw["schema"] !== CONNECTOR_SCHEMA) {
    failures.push(`manifest.schema: must be ${CONNECTOR_SCHEMA}`);
  }
  for (const field of ["connector_id", "version"] as const) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      failures.push(`manifest.${field}: must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(raw["kinds"]) ||
    raw["kinds"].length === 0 ||
    !raw["kinds"].every((kind) => typeof kind === "string" && kind.length > 0)
  ) {
    failures.push("manifest.kinds: must contain non-empty strings");
  }
  const capabilities = raw["capabilities"];
  const capabilityNames = [
    "backfill",
    "sync",
    "tombstones",
    "purge",
    "fixture",
  ] as const;
  if (!isPlainObject(capabilities)) {
    failures.push("manifest.capabilities: must be an object");
  } else {
    for (const capability of capabilityNames) {
      if (typeof capabilities[capability] !== "boolean") {
        failures.push(`manifest.capabilities.${capability}: must be boolean`);
      }
    }
  }
  if (
    !Array.isArray(raw["required_secrets"]) ||
    !raw["required_secrets"].every(
      (secret) => typeof secret === "string" && secret.length > 0,
    )
  ) {
    failures.push("manifest.required_secrets: must contain strings");
  }
  if (typeof raw["emits_sensitivity_hint"] !== "boolean") {
    failures.push("manifest.emits_sensitivity_hint: must be boolean");
  }

  if (failures.length > 0) return undefined;
  return raw as unknown as Manifest;
}

function inspectBatch(
  raw: unknown,
  label: string,
  manifest: Manifest,
  failures: string[],
): SyncBatch | undefined {
  if (
    !isPlainObject(raw) ||
    !Array.isArray(raw["events"]) ||
    !(raw["cursor"] === null || typeof raw["cursor"] === "string")
  ) {
    failures.push(`${label}: did not return a SyncBatch shape`);
    return undefined;
  }
  inspectEvents(raw["events"], label, manifest, failures);
  return raw as unknown as SyncBatch;
}

function inspectEvents(
  events: unknown[],
  label: string,
  manifest: Manifest,
  failures: string[],
): void {
  events.forEach((event, index) => {
    const validated = validateEventInput(event);
    if (!validated.ok) {
      failures.push(`${label}[${index}]: ${validated.errors.join("; ")}`);
      return;
    }
    if (validated.value.connector_id !== manifest.connector_id) {
      failures.push(`${label}[${index}]: connector_id does not match manifest`);
    }
    if (!manifest.kinds.includes(validated.value.kind)) {
      failures.push(`${label}[${index}]: kind is not declared in manifest`);
    }
  });
}

function result(failures: string[]): ConformanceResult {
  return { pass: failures.length === 0, failures };
}
