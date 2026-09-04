import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import type { SecretResolver } from "@kizuki/core";
import { createImapConnector } from "../src/connector";
import { secretSpellings } from "../src/imap/codes";
import { serializeImapState } from "../src/state";
import type { ImapState } from "../src/state";
import { FakeImapServer } from "../src/testing/fake-imap";
import type { FakeImapOptions } from "../src/testing/fake-imap";
import { memoryDialer } from "../src/testing/memory-dialer";
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  fixtureMailbox,
  fixtureState,
} from "../src/testing";

const REF = "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state";

function server(options: FakeImapOptions = {}): FakeImapServer {
  return new FakeImapServer(fixtureMailbox(), {
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    ...options,
  });
}

function resolverFor(state: ImapState): SecretResolver {
  const text = new TextDecoder().decode(serializeImapState(state));
  return async () => text;
}

function connectorFor(
  fake: FakeImapServer,
  state: ImapState = fixtureState(),
): {
  connector: ReturnType<typeof createImapConnector>;
  resolve: SecretResolver;
} {
  return {
    connector: createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(fake), now: () => new Date("2026-03-02T00:00:00Z") },
    ),
    resolve: resolverFor(state),
  };
}

describe("manifest", () => {
  test("declares sign-in, tombstones and purge with no required secrets", () => {
    const manifest = createImapConnector({}).manifest();
    expect(manifest).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: "kizuki.imap",
      version: "0.1.0",
      contract_minor: 1,
      implementation: "@kizuki/connector-imap",
      allowed_egress: [],
      cursor_schema: "kizuki.imap-cursor/v1",
      kinds: ["email"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: true,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      default_sensitivity: "private",
      sensitivity_floor: "personal",
      auth_modes: ["sign_in"],
    });
    expect(JSON.stringify(manifest)).not.toContain(FIXTURE_USERNAME);
  });
});

describe("connect fails closed", () => {
  test("without a secret_ref", async () => {
    const error = await createImapConnector({})
      .connect(async () => "{}")
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("missing_secret");
  });

  test("with a non-file secret_ref", async () => {
    const error = await createImapConnector({ secret_ref: "env:MAIL" })
      .connect(async () => "{}")
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("missing_secret");
  });

  test("when the resolver rejects", async () => {
    const error = await createImapConnector({ secret_ref: REF })
      .connect(async () => {
        throw new Error("no such file");
      })
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("missing_secret");
  });

  test("when the state is malformed", async () => {
    const error = await createImapConnector({ secret_ref: REF })
      .connect(async () => '{"schema":"kizuki.imap-state/v9"}')
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("misconfigured");
  });

  test("backfill before connect refuses", async () => {
    const error = await createImapConnector({ secret_ref: REF })
      .backfill(null)
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("missing_secret");
  });
});

describe("health", () => {
  test("is disabled before connect and ok afterwards", async () => {
    const { connector, resolve } = connectorFor(server());
    const before = await connector.health();
    expect(before.state).toBe("disabled");
    expect(before.detail).toBe("not connected");

    await connector.connect(resolve);
    const after = await connector.health();
    expect(after.state).toBe("ok");
    expect(after.detail).toBeUndefined();
  });

  test("reports a missing folder as misconfigured by display name", async () => {
    const fake = server();
    const state = fixtureState({ folders: ["INBOX", "Gone"] });
    const connector = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(fake) },
    );
    await connector.connect(resolverFor(state));
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toBe("folder not found: Gone");
  });

  test("a uidvalidity change is reported once, then clears", async () => {
    const fake = server();
    const { connector, resolve } = connectorFor(fake);
    await connector.connect(resolve);
    const first = await connector.backfill(null);
    expect((await connector.health()).state).toBe("ok");

    fake.resetUidValidity("INBOX");
    const second = await connector.sync(first.cursor);
    expect(second.events.some((event) => event.deleted)).toBe(true);

    const degraded = await connector.health();
    expect(degraded.state).toBe("degraded");
    expect(degraded.detail).toBe("uidvalidity changed: INBOX");
    expect((await connector.health()).state).toBe("ok");
  });

  test("a withheld body makes the run read degraded", async () => {
    const fake = server();
    const { connector, resolve } = connectorFor(fake);
    await connector.connect(resolve);
    fake.withholdBody("INBOX", 1);

    const batch = await connector.backfill(null);
    expect(batch.events.some((event) => event.metadata["uid"] === 1)).toBe(
      false,
    );
    const report = await connector.health();
    expect(report.state).toBe("degraded");
    expect(report.detail).toBe("message bodies not returned: INBOX (1)");
  });

  test("maps a refused LOGIN, a rate limit and a BYE", async () => {
    const refused = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(server({ password: "different" })) },
    );
    await expect(refused.connect(resolverFor(fixtureState()))).rejects.toThrow(
      KizukiError,
    );

    const limited = server({
      password: "different",
      loginFailureCode: "LIMIT",
    });
    const limitedConnector = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(limited) },
    );
    const limitError = await limitedConnector
      .connect(resolverFor(fixtureState()))
      .catch((caught: unknown) => caught);
    expect((limitError as KizukiError).code).toBe("rate_limited");

    const bye = server();
    const byeConnector = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(bye) },
    );
    await byeConnector.connect(resolverFor(fixtureState()));
    bye.byeNext();
    const report = await byeConnector.health();
    expect(report.state).toBe("unreachable");
  });

  test("records the last success once a walk has run", async () => {
    const { connector, resolve } = connectorFor(server());
    await connector.connect(resolve);
    await connector.backfill(null);
    const report = await connector.health();
    expect(report.last_success_at).toBe("2026-03-02T00:00:00.000Z");
  });
});

describe("purge plans", () => {
  test("lists what a subject touched but claims no deletion", async () => {
    const { connector, resolve } = connectorFor(server());
    await connector.connect(resolve);
    const plan = await connector.purgeSource("email:ada@acme.example");
    expect(plan.subject_id).toBe("email:ada@acme.example");
    expect(plan.source_record_ids).toEqual([]);
    expect(plan.unreachable_source_record_ids.length).toBeGreaterThan(0);
    for (const id of plan.unreachable_source_record_ids) {
      expect(id.startsWith("42:")).toBe(true);
      expect(id.endsWith(":INBOX")).toBe(true);
    }
  });

  test("is empty for a non-email subject and before connect", async () => {
    const { connector, resolve } = connectorFor(server());
    const before = await connector.purgeSource("email:ada@acme.example");
    expect(before.unreachable_source_record_ids).toEqual([]);

    await connector.connect(resolve);
    const other = await connector.purgeSource("conformance:subject");
    expect(other).toEqual({
      subject_id: "conformance:subject",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
  });

  test("refuses to build a query from an address with quoting metacharacters", async () => {
    const { connector, resolve } = connectorFor(server());
    await connector.connect(resolve);
    const plan = await connector.purgeSource('email:a"b@acme.example');
    expect(plan.unreachable_source_record_ids).toEqual([]);
  });

  test("a subject id whose code points mask down to CR, LF or SPACE sends nothing", async () => {
    const fake = server();
    const { connector, resolve } = connectorFor(fake);
    await connector.connect(resolve);
    // Combining marks survive toLowerCase() and do not match /\s/, so an
    // address minted from a third-party calendar can carry them all the way
    // here; masked into bytes they would be CR, LF and SPACE.
    const hostile =
      "email:ada\u030d\u030aA0009\u0320STORE\u03201\u0320+FLAGS\u0320(Deleted)\u030d\u030a@acme.example".toLowerCase();
    fake.received.length = 0;
    const plan = await connector.purgeSource(hostile);
    expect(plan.unreachable_source_record_ids).toEqual([]);
    expect(fake.received).toEqual([]);
  });

  test("every line a purge sends is one of the sanctioned read-only commands", async () => {
    const fake = server();
    const { connector, resolve } = connectorFor(fake);
    await connector.connect(resolve);
    fake.received.length = 0;
    await connector.purgeSource("email:ada@acme.example");
    // A literal payload line carries no tag; every line that opens a command
    // has to be one of the read-only verbs this connector is allowed to use.
    const commands = fake.received
      .map((line) => /^A\d{4} ([A-Z]+(?: [A-Z]+)?)/.exec(line)?.[1])
      .filter((command): command is string => command !== undefined);
    expect(commands).toEqual([
      "CAPABILITY",
      "LOGIN",
      "EXAMINE",
      "UID SEARCH",
      "LOGOUT",
    ]);
  });
});

describe("revocation and redaction", () => {
  test("revoke drops the in-memory state", async () => {
    const { connector, resolve } = connectorFor(server());
    await connector.connect(resolve);
    await connector.revoke();
    expect((await connector.health()).state).toBe("disabled");
  });

  test("no error or health detail ever carries the credentials", async () => {
    const details: string[] = [];
    const fake = server({ password: "different" });
    const connector = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(fake) },
    );
    const connectError = await connector
      .connect(resolverFor(fixtureState()))
      .catch((caught: unknown) => caught);
    details.push((connectError as KizukiError).message);
    details.push((await connector.health()).detail ?? "");

    const stateError = await createImapConnector({ secret_ref: REF })
      .connect(async () => '{"schema":"kizuki.imap-state/v1","host":""}')
      .catch((caught: unknown) => caught);
    details.push((stateError as KizukiError).message);

    for (const detail of details) {
      expect(detail).not.toContain(FIXTURE_PASSWORD);
      expect(detail).not.toContain(FIXTURE_USERNAME);
      expect(detail).not.toContain("mail.acme.example");
    }
  });

  test("a server that quotes the credentials back cannot leak them", async () => {
    const fake = server({
      password: "different",
      loginFailureCode: "AUTHENTICATIONFAILED",
      echoCredentialsOnFailure: true,
    });
    const connector = createImapConnector(
      { secret_ref: REF },
      { dial: memoryDialer(fake) },
    );
    const failure = (await connector
      .connect(resolverFor(fixtureState()))
      .catch((caught: unknown) => caught)) as KizukiError;
    expect(failure.code).toBe("unauthenticated");
    const detail = (await connector.health()).detail ?? "";
    for (const text of [failure.message, detail]) {
      expect(text).not.toContain(FIXTURE_PASSWORD);
      expect(text).not.toContain(FIXTURE_USERNAME);
      // The wire is read as latin-1, so the mangled spelling of a non-ASCII
      // password is just as readable and must go the same way.
      for (const spelling of secretSpellings(FIXTURE_PASSWORD)) {
        expect(text).not.toContain(spelling);
      }
    }
  });

  test("the cursor never carries the credentials", async () => {
    const { connector, resolve } = connectorFor(server());
    await connector.connect(resolve);
    const batch = await connector.backfill(null);
    expect(batch.cursor).not.toBeNull();
    expect(batch.cursor ?? "").not.toContain(FIXTURE_PASSWORD);
    expect(batch.cursor ?? "").not.toContain(FIXTURE_USERNAME);
    expect(JSON.stringify(batch.events)).not.toContain(FIXTURE_PASSWORD);
  });
});
