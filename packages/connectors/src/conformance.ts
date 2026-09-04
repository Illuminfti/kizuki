import {
  AUTH_MODES,
  CONNECTOR_SCHEMA,
  HealthReport,
  KizukiError,
  isAuthMode,
  isHealthState,
  isRfc3339,
  isSecretRef,
  isSensitivity,
  isPlainObject,
  policyFromManifest,
  validateEventInput,
} from "@kizuki/core";
import type {
  Connector,
  Cursor,
  Manifest,
  SecretResolver,
  SignInIo,
  SyncBatch,
} from "@kizuki/core";
import { InMemoryLedger } from "./ledger";
import { resolveSensitivity } from "./sensitivity";
import { errorMessage } from "./util";

export interface TombstoneConformanceHooks {
  prepare(): Promise<Cursor | null>;
  mutate(): Promise<void>;
}

export interface UnavailableConformanceHooks {
  /** A second instance whose source/auth/schema is unusable. */
  connector: Connector;
  checkpoint?: Cursor | null;
}

export interface ConformanceOptions {
  backfillTwice?: boolean;
  tombstone?: TombstoneConformanceHooks;
  unavailable?: UnavailableConformanceHooks;
  /** Host deadline for each connector method. */
  deadlineMs?: number;
}

export interface ConformanceResult {
  pass: boolean;
  failures: string[];
}

const MAX_HEALTH_DETAIL = 256;
const MAX_SIGNIN_TEXT = 512;
const MAX_PAGES = 64;
const DEFAULT_DEADLINE_MS = 30_000;
const CORRUPT_CURSOR = "\u0000not-a-cursor";

const CAPABILITY_METHODS = {
  backfill: "backfill",
  sync: "sync",
  purge: "purgeSource",
  fixture: "fixture",
} as const;

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
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const timed = <T>(label: string, operation: () => Promise<T>): Promise<T> =>
    withDeadline(label, deadlineMs, operation);

  let rawManifest: unknown;
  try {
    rawManifest = connector.manifest();
  } catch (error) {
    failures.push(`manifest() rejected: ${errorMessage(error)}`);
    return result(failures);
  }
  const manifest = parseManifest(rawManifest, failures);
  if (manifest === undefined) return result(failures);
  checkManifestFrozen(connector, manifest, failures);
  checkCapabilityParity(connector, manifest, failures);

  const interactive = manifest.auth_modes.some(
    (mode) => mode === "sign_in" || mode === "oauth",
  );
  if (interactive && typeof connector.signIn !== "function") {
    failures.push(
      "manifest.auth_modes: declares an interactive mode but signIn() is not implemented",
    );
  }
  if (!interactive && typeof connector.signIn === "function") {
    failures.push(
      "manifest.auth_modes: signIn() exists but no interactive mode is declared",
    );
  }

  await checkHealth(connector, "health", timed, failures);

  let fixtureEvents: unknown[] | undefined;
  if (manifest.capabilities.fixture) {
    try {
      const fixture = await timed("fixture", () => connector.fixture());
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
  } else {
    await expectNotSupported(
      "fixture",
      () => timed("fixture absent", () => connector.fixture()),
      failures,
    );
  }

  if (manifest.capabilities.backfill) {
    try {
      inspectBatch(
        await timed("backfill(null)", () => connector.backfill(null)),
        "backfill(null)",
        manifest,
        failures,
      );
    } catch (error) {
      failures.push(
        `backfill capability declared but backfill(null) rejected: ${errorMessage(error)}`,
      );
    }
  } else {
    await expectNotSupported(
      "backfill",
      () => timed("backfill absent", () => connector.backfill(null)),
      failures,
    );
  }

  if (manifest.capabilities.sync) {
    try {
      inspectBatch(
        await timed("sync(null)", () => connector.sync(null)),
        "sync(null)",
        manifest,
        failures,
      );
    } catch (error) {
      failures.push(
        `sync capability declared but sync(null) rejected: ${errorMessage(error)}`,
      );
    }
  } else {
    await expectNotSupported(
      "sync",
      () => timed("sync absent", () => connector.sync(null)),
      failures,
    );
  }

  if (manifest.capabilities.purge) {
    try {
      const plan = await timed("purgeSource", () =>
        connector.purgeSource("conformance:subject"),
      );
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
  } else {
    await expectNotSupported(
      "purge",
      () =>
        timed("purge absent", () =>
          connector.purgeSource("conformance:subject"),
        ),
      failures,
    );
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
      await timed("connect fail-closed", () =>
        connector.connect(rejectResolver),
      );
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
        await timed("first backfill", () => connector.backfill(null)),
        "first backfill",
        manifest,
        failures,
      );
      const second = inspectBatch(
        await timed("second backfill", () => connector.backfill(null)),
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

  if (manifest.capabilities.backfill) {
    await checkPagination(connector, manifest, timed, failures);
  }

  if (opts.unavailable !== undefined) {
    await checkUnavailable(opts.unavailable, timed, failures);
  }

  await checkDeclaredSignIn(connector, manifest, timed, failures);

  if (manifest.capabilities.tombstones && opts.tombstone === undefined) {
    failures.push(
      "tombstones capability declared but no tombstone hooks were supplied to the suite",
    );
  }

  if (manifest.capabilities.tombstones && opts.tombstone !== undefined) {
    try {
      const cursor = await opts.tombstone.prepare();
      await opts.tombstone.mutate();
      const batch = inspectBatch(
        await timed("tombstone sync", () => connector.sync(cursor)),
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

  await checkRevoke(connector, manifest, timed, failures);

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
    typeof raw["contract_minor"] !== "number" ||
    !Number.isSafeInteger(raw["contract_minor"]) ||
    raw["contract_minor"] < 0
  ) {
    failures.push("manifest.contract_minor: must be a non-negative integer");
  }
  if (
    typeof raw["implementation"] !== "string" ||
    raw["implementation"].length === 0
  ) {
    failures.push("manifest.implementation: must be a non-empty string");
  }
  if (
    !Array.isArray(raw["allowed_egress"]) ||
    !raw["allowed_egress"].every(
      (host) => typeof host === "string" && host.length > 0,
    )
  ) {
    failures.push("manifest.allowed_egress: must be an array of hosts");
  }
  if (
    raw["cursor_schema"] !== null &&
    (typeof raw["cursor_schema"] !== "string" ||
      raw["cursor_schema"].length === 0)
  ) {
    failures.push("manifest.cursor_schema: must be a schema id or null");
  }
  if (!isSensitivity(raw["default_sensitivity"])) {
    failures.push("manifest.default_sensitivity: must be a sensitivity label");
  }
  if (!isSensitivity(raw["sensitivity_floor"])) {
    failures.push("manifest.sensitivity_floor: must be a sensitivity label");
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
    !raw["required_secrets"].every(isSecretRef)
  ) {
    failures.push("manifest.required_secrets: must contain secret_ref URIs");
  }
  if (typeof raw["emits_sensitivity_hint"] !== "boolean") {
    failures.push("manifest.emits_sensitivity_hint: must be boolean");
  }
  const authModes = raw["auth_modes"];
  if (
    !Array.isArray(authModes) ||
    authModes.length === 0 ||
    !authModes.every(isAuthMode)
  ) {
    failures.push(
      `manifest.auth_modes: must be a non-empty array of ${AUTH_MODES.join(" | ")}`,
    );
  }

  if (failures.length > 0) return undefined;
  return raw as unknown as Manifest;
}

function checkManifestFrozen(
  connector: Connector,
  manifest: Manifest,
  failures: string[],
): void {
  const snapshot = JSON.stringify(manifest);
  const kinds = manifest.kinds as string[];
  const before = kinds.length;
  try {
    kinds.push("conformance-mutation");
    if (kinds.length !== before) {
      kinds.length = before;
      failures.push("manifest: arrays are mutable");
    }
  } catch {
    // Frozen arrays throw. That is the contract.
  }
  const again = connector.manifest();
  if (JSON.stringify(again) !== snapshot) {
    failures.push("manifest: mutation changed a later manifest() call");
  }
}

function checkCapabilityParity(
  connector: Connector,
  manifest: Manifest,
  failures: string[],
): void {
  for (const [capability, method] of Object.entries(CAPABILITY_METHODS)) {
    const declared =
      manifest.capabilities[capability as keyof typeof CAPABILITY_METHODS];
    const present = typeof connector[method] === "function";
    if (declared && !present) {
      failures.push(
        `capabilities.${capability}: declared but ${method}() is missing`,
      );
    }
  }
}

async function checkHealth(
  connector: Connector,
  label: string,
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<HealthReport | undefined> {
  try {
    const report = await timed(label, () => connector.health());
    if (!(report instanceof HealthReport) && !isHealthShape(report)) {
      failures.push(`${label}: did not return a HealthReport`);
      return undefined;
    }
    if (!isHealthState(report.state)) {
      failures.push(`${label}: state is not a HealthState`);
    }
    if (!isRfc3339(report.checked_at)) {
      failures.push(`${label}: checked_at is not RFC3339`);
    }
    if (
      report.last_success_at !== undefined &&
      !isRfc3339(report.last_success_at)
    ) {
      failures.push(`${label}: last_success_at is not RFC3339`);
    }
    if (report.detail !== undefined) {
      if (typeof report.detail !== "string") {
        failures.push(`${label}: detail must be a string`);
      } else if (report.detail.length > MAX_HEALTH_DETAIL) {
        failures.push(`${label}: detail exceeds ${MAX_HEALTH_DETAIL} characters`);
      } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(report.detail)) {
        failures.push(`${label}: detail contains control characters`);
      }
    }
    return report;
  } catch (error) {
    failures.push(`${label} rejected: ${errorMessage(error)}`);
    return undefined;
  }
}

async function checkPagination(
  connector: Connector,
  manifest: Manifest,
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<void> {
  const seen = new Set<string>();
  let cursor: Cursor | null = null;
  let pages = 0;
  let firstCursor: Cursor | null | undefined;
  try {
    while (pages < MAX_PAGES) {
      const batch = inspectBatch(
        await timed(`page ${pages}`, () => connector.backfill(cursor)),
        `page ${pages}`,
        manifest,
        failures,
      );
      if (batch === undefined) return;
      if (pages === 0) firstCursor = batch.cursor;
      const fresh = batch.events.filter(
        (event) => !seen.has(event.source_record_id),
      );
      if (fresh.length === 0) break;
      for (const event of fresh) seen.add(event.source_record_id);
      if (batch.cursor === null) break;
      if (batch.cursor === cursor) {
        failures.push(
          "pagination: cursor did not advance while still emitting new records",
        );
        return;
      }
      cursor = batch.cursor;
      pages += 1;
    }
    if (pages >= MAX_PAGES) {
      failures.push(`pagination: did not exhaust within ${MAX_PAGES} pages`);
    }
  } catch (error) {
    failures.push(`pagination rejected: ${errorMessage(error)}`);
    return;
  }

  if (firstCursor !== undefined && firstCursor !== null) {
    try {
      const replayed = inspectBatch(
        await timed("cursor replay", () => connector.backfill(firstCursor)),
        "cursor replay",
        manifest,
        failures,
      );
      const original = inspectBatch(
        await timed("cursor replay again", () => connector.backfill(firstCursor)),
        "cursor replay again",
        manifest,
        failures,
      );
      if (
        replayed !== undefined &&
        original !== undefined &&
        JSON.stringify(idsOf(replayed)) !== JSON.stringify(idsOf(original))
      ) {
        failures.push("pagination: replaying a cursor was not stable");
      }
    } catch (error) {
      failures.push(`cursor replay rejected: ${errorMessage(error)}`);
    }
  }

  if (manifest.cursor_schema !== null && manifest.cursor_schema !== undefined) {
    try {
      await timed("corrupt cursor", () => connector.backfill(CORRUPT_CURSOR));
      failures.push("pagination: a corrupt cursor was accepted");
    } catch (error) {
      if (errorCode(error) === undefined) {
        failures.push(
          "pagination: a corrupt cursor must throw a typed connector error",
        );
      }
    }
  }
}

async function checkUnavailable(
  hooks: UnavailableConformanceHooks,
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<void> {
  const checkpoint = hooks.checkpoint ?? null;
  try {
    const batch = await timed("unavailable backfill", () =>
      hooks.connector.backfill(checkpoint),
    );
    if (batch.events.length === 0 && batch.cursor !== checkpoint) {
      failures.push(
        "unavailable: empty page advanced the cursor (unavailable is not empty)",
      );
      return;
    }
    if (batch.events.length === 0) {
      failures.push(
        "unavailable: returned an empty page instead of a typed failure",
      );
    }
  } catch (error) {
    if (errorCode(error) === undefined) {
      failures.push("unavailable: rejection was not a typed connector error");
    }
  }
  const report = await checkHealth(
    hooks.connector,
    "unavailable health",
    timed,
    failures,
  );
  if (report?.state === "ok") {
    failures.push("unavailable: health reported ok for an unusable source");
  }
}

async function checkDeclaredSignIn(
  connector: Connector,
  manifest: Manifest,
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<void> {
  for (const mode of manifest.auth_modes) {
    switch (mode) {
      case "none":
      case "secret_ref":
        break;
      case "sign_in":
      case "oauth":
        await checkInteractiveSignIn(connector, mode, timed, failures);
        break;
      default: {
        const _exhaustive: never = mode;
        failures.push(`manifest.auth_modes: unhandled mode ${_exhaustive}`);
      }
    }
  }
}

async function checkInteractiveSignIn(
  connector: Connector,
  mode: "sign_in" | "oauth",
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<void> {
  if (typeof connector.signIn !== "function") return;
  const notices: string[] = [];
  const urls: string[] = [];
  const io: SignInIo = {
    prompt: async () => {
      throw new KizukiError("timeout", "sign-in cancelled", {
        retryable: false,
      });
    },
    notify: (text) => {
      notices.push(text);
    },
    openUrl: async (url) => {
      urls.push(url);
    },
  };
  try {
    await timed(`signIn(${mode}) cancel`, () =>
      connector.signIn!(io, {
        write: async () => {
          failures.push(`signIn(${mode}): wrote state after cancellation`);
        },
      }),
    );
    failures.push(`signIn(${mode}): cancel returned success`);
  } catch (error) {
    if (errorCode(error) === undefined) {
      failures.push(`signIn(${mode}): cancellation was not a typed error`);
    }
  }
  for (const text of [...notices, ...urls]) {
    if (text.length > MAX_SIGNIN_TEXT) {
      failures.push(`signIn(${mode}): emitted text exceeds ${MAX_SIGNIN_TEXT}`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
      failures.push(`signIn(${mode}): emitted control characters`);
    }
  }
}

async function checkRevoke(
  connector: Connector,
  manifest: Manifest,
  timed: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
  failures: string[],
): Promise<void> {
  try {
    await timed("revoke", () => connector.revoke());
  } catch (error) {
    failures.push(`revoke rejected: ${errorMessage(error)}`);
    return;
  }
  try {
    await timed("revoke again", () => connector.revoke());
  } catch (error) {
    failures.push(`revoke is not idempotent: ${errorMessage(error)}`);
  }

  const needsAuth = !manifest.auth_modes.includes("none");
  if (!needsAuth) return;

  try {
    const report = await timed("health after revoke", () => connector.health());
    if (report.state === "ok") {
      failures.push("revoke: health stayed ok after access ended");
    }
  } catch {
    // Typed health failure after revoke is honest.
  }
  try {
    await timed("backfill after revoke", () => connector.backfill(null));
    failures.push("revoke: backfill still succeeded after access ended");
  } catch (error) {
    if (errorCode(error) === undefined) {
      failures.push("revoke: later backfill was not a typed connector error");
    }
  }
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
    const resolved = resolveSensitivity(
      policyFromManifest(manifest),
      validated.value.sensitivity_hint,
    );
    if (!isSensitivity(resolved)) {
      failures.push(`${label}[${index}]: resolved sensitivity is unlabeled`);
    }
  });
}

async function expectNotSupported(
  capability: string,
  operation: () => Promise<unknown>,
  failures: string[],
): Promise<void> {
  try {
    await operation();
    failures.push(
      `capabilities.${capability}: absent but the method returned a value`,
    );
  } catch (error) {
    if (errorCode(error) !== "not_supported") {
      failures.push(
        `capabilities.${capability}: absent method must throw not_supported`,
      );
    }
  }
}

function isHealthShape(value: unknown): value is HealthReport {
  return (
    isPlainObject(value) &&
    isHealthState(value["state"]) &&
    typeof value["checked_at"] === "string"
  );
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof KizukiError) return error.code;
  if (
    error instanceof Error &&
    error.constructor !== Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    // A generic Error with code ENOENT is a syscall, not a connector refusal.
    return error.code;
  }
  return undefined;
}

function idsOf(batch: SyncBatch): string[] {
  return batch.events.map((event) => event.source_record_id);
}

async function withDeadline<T>(
  label: string,
  ms: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new KizukiError("timeout", `${label} exceeded ${ms}ms`, {
          retryable: true,
        }),
      );
    }, ms);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function result(failures: string[]): ConformanceResult {
  return { pass: failures.length === 0, failures };
}
