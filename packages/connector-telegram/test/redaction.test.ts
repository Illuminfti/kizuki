import { expect, test } from "bun:test";
import { parseCursor } from "../src/cursor";
import { classify } from "../src/guard";
import { waitSeconds } from "../src/sign-in";
import {
  FIXTURE_SESSION,
  fixtureAccount,
} from "../src/fixture";
import {
  CapturingWriter,
  PROVIDER,
  Rpc,
  ScriptedIo,
  Wait,
  connected,
  drain,
  harness,
  rejection,
  stateResolver,
  stateText,
} from "./helpers";

const PHONE = "+15550009876";
const CODE = "22222";
const PASSWORD = "correct horse";
/** Shaped like a saved session: one opaque run with nothing to break it up. */
const OPAQUE_SESSION = "AQBANOTEwODIzNDU2Nzg5MEFCQ0RFRg";
const SECRETS = [FIXTURE_SESSION, OPAQUE_SESSION, PHONE, CODE, PASSWORD];

function assertClean(label: string, text: string): void {
  for (const secret of SECRETS) {
    expect(`${label}: ${text}`).not.toContain(secret);
  }
}

/** What a log line or a crash report would render, causes included. */
function chain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.name, current.message);
    current = current.cause;
  }
  parts.push(String(current));
  return parts.join("\n");
}

test("the manifest carries nothing the owner typed", async () => {
  const built = await connected();
  assertClean("manifest", JSON.stringify(built.connector.manifest()));
});

test("no health report leaks the session or the sign-in answers", async () => {
  const account = fixtureAccount();
  account.flood = { after_calls: 0, seconds: 45 };
  const built = await connected({ account });
  const reports = [await built.connector.health()];
  await built.connector.backfill(null);
  reports.push(await built.connector.health());
  built.api.revoke();
  reports.push(await built.connector.health());
  built.api.disconnectNetwork();
  reports.push(await built.connector.health());
  for (const report of reports) {
    assertClean("health", JSON.stringify(report));
  }
});

test("nothing a thrown error carries repeats a credential", async () => {
  const account = fixtureAccount();
  account.sign_in = { code: CODE, password: PASSWORD, password_hint: "the usual" };
  const failures = [
    () =>
      harness({ config: {} }).connector.signIn(
        new ScriptedIo(["5551234"]),
        new CapturingWriter(),
      ),
    () =>
      harness({ account, config: {} }).connector.signIn(
        new ScriptedIo([PHONE, "11111", "11111", "11111"]),
        new CapturingWriter(),
      ),
    () => harness({ config: {} }).connector.connect(stateResolver()),
    () => harness().connector.connect(stateResolver(stateText("2002"))),
    () => harness().connector.connect(async () => "{}"),
    // A state blob that lost its quoting: the parser would otherwise quote the
    // session straight into the cause it hands back.
    () =>
      harness().connector.connect(
        async () => `{"schema":"kizuki.telegram-state/v1","session":${OPAQUE_SESSION}}`,
      ),
  ];
  for (const failure of failures) {
    const error = await rejection(failure);
    assertClean("error", error.message);
    assertClean("cause chain", chain(error));
  }
});

test("neither the cursor nor any event metadata carries the session", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  assertClean("cursor", drained.cursor);
  for (const event of drained.events) {
    assertClean("metadata", JSON.stringify(event.metadata));
  }
  assertClean("fixture", JSON.stringify(await built.connector.fixture()));
});

test("terminal prompts never echo what was already typed", async () => {
  const { connector } = harness({ config: {} });
  const io = new ScriptedIo([PHONE, CODE]);
  await connector.signIn(io, new CapturingWriter());
  for (const prompt of io.prompts) {
    assertClean("prompt", prompt.question);
  }
  for (const notice of io.notices) {
    assertClean("notice", notice);
  }
});

/**
 * A failure raised over credential bytes carries them: a resolver names what it
 * could not read, and a JSON parser quotes the token it stopped on. Only the
 * shape of either failure may cross into a cause chain.
 */
test("a failure raised over credential bytes hands back its shape only", async () => {
  const RESOLVED = "resolver-token-not-a-real-credential";
  const STORED = "cursor-token-not-a-real-credential";

  const resolved = await rejection(() =>
    harness().connector.connect(async () => {
      throw new Error(RESOLVED);
    }),
  );
  expect(resolved.code).toBe("missing_session");
  expect(chain(resolved)).not.toContain(RESOLVED);

  const stored = await rejection(async () =>
    parseCursor(`{"schema": ${STORED}}`),
  );
  expect(stored.code).toBe("parse_error");
  expect(chain(stored)).not.toContain(STORED);
});

/**
 * Every field of a provider failure is text the provider chose, and a
 * connection whose reply frames are being written by someone else is exactly
 * the case this connector is built for. None of that text may be repeated in
 * an error, a message or a cause chain, so a credential planted in any of it
 * has nowhere to surface.
 */
test("a provider failure carrying a credential in every field says none of it", () => {
  const hostile = (): Rpc => {
    const error = new Rpc(`UNEXPECTED_${OPAQUE_SESSION}`);
    error.name = `RPCError_${FIXTURE_SESSION}`;
    error.message = `failed: ${PASSWORD}`;
    error.cause = new Error(`${PHONE} ${CODE} ${OPAQUE_SESSION}`);
    return error;
  };

  const classified = [
    classify(hostile(), PROVIDER),
    // The named branches take the same text through a different message.
    classify(new Rpc("SESSION_REVOKED"), PROVIDER),
    // A wait whose length is text rather than a number: the number is the only
    // part of a wait worth repeating, so an unreadable one is not repeated.
    classify(new Wait(`${OPAQUE_SESSION}`), PROVIDER),
    // Nothing that reached the RPC layer at all.
    classify(new Error(`socket ${OPAQUE_SESSION}`), PROVIDER),
  ];
  for (const error of classified) {
    assertClean("classified", error.message);
    assertClean("classified chain", chain(error));
  }
});

test("a wait the provider did not measure is not slept through as though it had", () => {
  const measured = classify(new Wait(42), PROVIDER);
  expect(measured.code).toBe("flood_wait");
  expect(measured.retry_after).toBe(42);

  // Without a length there is nothing to wait out, and inventing one would
  // have the connector report a pause it was never given.
  const unmeasured = classify(new Wait("42"), PROVIDER);
  expect(unmeasured.code).toBe("flood_wait");
  expect(unmeasured.retry_after).toBeUndefined();
  expect(waitSeconds(unmeasured)).toBeNull();
});
