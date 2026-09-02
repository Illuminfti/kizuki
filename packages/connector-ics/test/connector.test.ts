import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionStateStore,
  KizukiError,
  enrollConnection,
  openLedger,
} from "@kizuki/core";
import type { Cursor, SignInIo } from "@kizuki/core";
import { createIcsConnector } from "../src/connector";
import { FIXTURE_ICS, FIXTURE_NOW } from "../src/fixture";
import { parseIcsState } from "../src/state";
import { memoryFetcher, okResult } from "../src/testing/memory-fetch";

const URL_UNDER_TEST = "https://calendar.acme.example/private/abc123.ics";
const REF = "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state";
const NOW = (): Date => FIXTURE_NOW;

const directories: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-ics-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function writeCalendar(text: string): Promise<string> {
  const path = join(temporary(), "team.ics");
  await Bun.write(path, text);
  return path;
}

function scriptedIo(answers: string[]): SignInIo {
  const queue = [...answers];
  return {
    async prompt() {
      return queue.shift() ?? "";
    },
    notify() {},
    async openUrl() {},
  };
}

const SMALL = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:Acme team",
  "BEGIN:VEVENT",
  "UID:one@acme.example",
  "DTSTART:20260302T090000Z",
  "SUMMARY:One",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:two@acme.example",
  "DTSTART:20260303T090000Z",
  "SUMMARY:Two",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("manifest and empty config", () => {
  test("declares both auth modes and no purge", () => {
    expect(createIcsConnector({}).manifest()).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: "kizuki.ics",
      version: "0.1.0",
      kinds: ["calendar_event"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: false,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      auth_modes: ["none", "sign_in"],
    });
  });

  test("an empty config still serves the fixture and refuses to sync", async () => {
    const connector = createIcsConnector({}, { now: NOW });
    expect((await connector.fixture()).length).toBeGreaterThan(0);
    expect((await connector.health()).state).toBe("disabled");
    expect(await connector.purgeSource("email:ada@acme.example")).toEqual({
      subject_id: "email:ada@acme.example",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
    await expect(connector.backfill(null)).rejects.toThrow(KizukiError);
    await expect(connector.sync(null)).rejects.toThrow(KizukiError);
  });
});

describe("file mode", () => {
  test("backfills a calendar and reports health from the path", async () => {
    const path = await writeCalendar(SMALL);
    const connector = createIcsConnector({ path }, { now: NOW });
    await connector.connect(async () => "");
    expect((await connector.health()).state).toBe("ok");

    const batch = await connector.backfill(null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "one@acme.example",
      "two@acme.example",
    ]);
    expect(batch.cursor).not.toBeNull();
  });

  test("sync tombstones a removed event and re-emits an edited one", async () => {
    const path = await writeCalendar(SMALL);
    const connector = createIcsConnector({ path }, { now: NOW });
    const first = await connector.backfill(null);

    await Bun.write(
      path,
      SMALL.replace("SUMMARY:One", "SUMMARY:One (edited)").replace(
        [
          "BEGIN:VEVENT",
          "UID:two@acme.example",
          "DTSTART:20260303T090000Z",
          "SUMMARY:Two",
          "END:VEVENT",
          "",
        ].join("\r\n"),
        "",
      ),
    );

    const second = await connector.sync(first.cursor);
    expect(second.events).toHaveLength(2);
    const [tombstone, edited] = second.events;
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.source_record_id).toBe("two@acme.example");
    expect(tombstone?.metadata).toEqual({ uid: "two@acme.example" });
    expect(edited?.deleted).toBe(false);
    expect(edited?.text).toBe("One (edited)");
  });

  test("a truncated file refuses the sync instead of tombstoning everything", async () => {
    const path = await writeCalendar(SMALL);
    const connector = createIcsConnector({ path }, { now: NOW });
    const first = await connector.backfill(null);

    // What a half-written or half-downloaded calendar looks like: the last
    // component never closes. Read as an empty snapshot it would tombstone
    // every event the owner still has.
    await Bun.write(path, SMALL.slice(0, SMALL.indexOf("UID:two")));
    const error = await connector
      .sync(first.cursor)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("parse_error");
  });

  test("sync emits nothing when the file is unchanged", async () => {
    const path = await writeCalendar(SMALL);
    const connector = createIcsConnector({ path }, { now: NOW });
    const first = await connector.backfill(null);
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([]);
  });

  test("a missing file is misconfigured, not a crash", async () => {
    const connector = createIcsConnector(
      { path: join(temporary(), "gone.ics") },
      { now: NOW },
    );
    expect((await connector.health()).state).toBe("misconfigured");
    await expect(connector.backfill(null)).rejects.toThrow(KizukiError);
  });

  test("an unreadable entry is skipped and the run reads degraded", async () => {
    const path = await writeCalendar(
      SMALL.replace(
        "END:VCALENDAR",
        [
          "BEGIN:VEVENT",
          "UID:three@acme.example",
          "DTSTART;VALUE=DATE:20260305T000000",
          "SUMMARY:Three",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      ),
    );
    const connector = createIcsConnector({ path }, { now: NOW });

    const batch = await connector.backfill(null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "one@acme.example",
      "two@acme.example",
    ]);

    const report = await connector.health();
    expect(report.state).toBe("degraded");
    expect(report.detail).toBe("1 calendar entry could not be read");
    // The note is reported once, not for the rest of the connection's life.
    expect((await connector.health()).state).toBe("ok");
  });

  test("a directory is misconfigured", async () => {
    const connector = createIcsConnector({ path: temporary() }, { now: NOW });
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toBe("path is not a file");
  });
});

describe("url mode", () => {
  const fetcher = (text: string, etag: string | null = '"v1"') =>
    memoryFetcher({ [URL_UNDER_TEST]: okResult(text, etag) });

  function urlConnector(text: string) {
    return createIcsConnector(
      { secret_ref: REF },
      { fetch: fetcher(text), now: NOW },
    );
  }

  const resolver = async (): Promise<string> =>
    JSON.stringify({ schema: "kizuki.ics-state/v1", url: URL_UNDER_TEST });

  test("connect requires a state ref and validates the calendar", async () => {
    await expect(
      createIcsConnector({}, { fetch: fetcher(SMALL) }).connect(resolver),
    ).rejects.toThrow(KizukiError);

    const connector = urlConnector(SMALL);
    await connector.connect(resolver);
    expect((await connector.health()).state).toBe("ok");
  });

  test("a resolver rejection is missing_secret and malformed state is misconfigured", async () => {
    const rejecting = createIcsConnector(
      { secret_ref: REF },
      { fetch: fetcher(SMALL) },
    );
    const missing = await rejecting
      .connect(async () => {
        throw new Error("no state");
      })
      .catch((caught: unknown) => caught);
    expect((missing as KizukiError).code).toBe("missing_secret");

    const malformed = await createIcsConnector(
      { secret_ref: REF },
      { fetch: fetcher(SMALL) },
    )
      .connect(async () => '{"schema":"kizuki.ics-state/v1","url":"ftp://x"}')
      .catch((caught: unknown) => caught);
    expect((malformed as KizukiError).code).toBe("misconfigured");
  });

  test("a 304 yields an empty batch and keeps the cursor records", async () => {
    let text = FIXTURE_ICS;
    let etag = '"v1"';
    const connector = createIcsConnector(
      { secret_ref: REF },
      {
        fetch: memoryFetcher({
          [URL_UNDER_TEST]: () =>
            text === ""
              ? { status: 304, etag, last_modified: null, text: "" }
              : okResult(text, etag),
        }),
        now: NOW,
      },
    );
    await connector.connect(resolver);
    const first = await connector.backfill(null);
    expect(first.events.length).toBeGreaterThan(0);

    text = "";
    etag = '"v1"';
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor).toBe(first.cursor as Cursor);
  });

  test("swapping the route emits a tombstone for what vanished", async () => {
    let text = SMALL;
    const connector = createIcsConnector(
      { secret_ref: REF },
      {
        fetch: memoryFetcher({
          [URL_UNDER_TEST]: () => okResult(text, null),
        }),
        now: NOW,
      },
    );
    await connector.connect(resolver);
    const first = await connector.backfill(null);
    text = SMALL.replace(
      [
        "BEGIN:VEVENT",
        "UID:two@acme.example",
        "DTSTART:20260303T090000Z",
        "SUMMARY:Two",
        "END:VEVENT",
        "",
      ].join("\r\n"),
      "",
    );
    const second = await connector.sync(first.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.deleted).toBe(true);
    expect(second.events[0]?.source_record_id).toBe("two@acme.example");
  });

  test("revoke drops the state and health goes back to disabled", async () => {
    const connector = urlConnector(SMALL);
    await connector.connect(resolver);
    await connector.revoke();
    expect((await connector.health()).state).toBe("disabled");
  });

  test("backfill re-emits the snapshot even when the cursor could 304", async () => {
    const conditionals: { etag?: string; last_modified?: string }[] = [];
    const connector = createIcsConnector(
      { secret_ref: REF },
      {
        fetch: async (_url, conditional) => {
          conditionals.push(conditional);
          return conditional.etag === '"v1"'
            ? { status: 304, etag: '"v1"', last_modified: null, text: "" }
            : okResult(SMALL, '"v1"');
        },
        now: NOW,
      },
    );
    await connector.connect(resolver);
    const first = await connector.backfill(null);
    expect(first.events.length).toBeGreaterThan(0);

    const again = await connector.backfill(first.cursor);
    expect(again.events.map((event) => event.source_record_id)).toEqual(
      first.events.map((event) => event.source_record_id),
    );
    expect(conditionals.at(-1)).toEqual({});

    const synced = await connector.sync(first.cursor);
    expect(synced.events).toEqual([]);
    expect(conditionals.at(-1)).toEqual({ etag: '"v1"' });
  });

  test("an unexpected failure keeps the calendar URL out of the health detail", async () => {
    const connector = createIcsConnector(
      { secret_ref: REF },
      {
        fetch: async (url) => {
          if (probing) throw new Error(`stream failed for ${url}`);
          return okResult(SMALL, null);
        },
        now: NOW,
      },
    );
    let probing = false;
    await connector.connect(resolver);
    probing = true;
    const report = await connector.health();
    expect(report.state).not.toBe("ok");
    expect(report.detail ?? "").not.toContain("abc123");
    expect(report.detail ?? "").not.toContain("calendar.acme.example");
  });
});

describe("url sign-in", () => {
  const fetcher = memoryFetcher({
    "https://calendar.acme.example/private/abc123.ics": okResult(FIXTURE_ICS),
  });

  test("rewrites webcal, writes one 0600 state file and keeps the URL out of SQLite", async () => {
    const directory = temporary();
    const dbPath = join(directory, "ledger.sqlite");
    const db = openLedger(dbPath);
    const store = new ConnectionStateStore(directory);

    const saved = await enrollConnection(
      db,
      store,
      createIcsConnector({}, { fetch: fetcher, now: NOW }),
      scriptedIo(["webcal://calendar.acme.example/private/abc123.ics"]),
    );

    expect(
      readdirSync(store.directory).filter((name) => name.endsWith(".state")),
    ).toHaveLength(1);
    expect(
      statSync(join(store.directory, `${saved.source_key}.state`)).mode & 0o777,
    ).toBe(0o600);
    const bytes = store.read(saved) ?? new Uint8Array();
    expect(parseIcsState(new TextDecoder().decode(bytes)).url).toBe(
      URL_UNDER_TEST,
    );
    db.close();

    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from("abc123"))).toBe(false);
    expect(raw.includes(Buffer.from("calendar.acme.example"))).toBe(false);
  });

  test("returns the calendar name as the display label", async () => {
    const connector = createIcsConnector({}, { fetch: fetcher, now: NOW });
    const display = await connector.signIn(
      scriptedIo(["https://calendar.acme.example/private/abc123.ics"]),
      { write: async () => {} },
    );
    expect(display).toEqual({ display: "Acme team" });
  });

  test("refuses an http URL before fetching anything", async () => {
    let calls = 0;
    const connector = createIcsConnector(
      {},
      {
        fetch: async () => {
          calls += 1;
          return okResult(FIXTURE_ICS);
        },
        now: NOW,
      },
    );
    await expect(
      connector.signIn(scriptedIo(["http://calendar.acme.example/a.ics"]), {
        write: async () => {},
      }),
    ).rejects.toThrow(/only https/);
    expect(calls).toBe(0);
  });

  test("a document without a VCALENDAR fails the sign-in and writes nothing", async () => {
    let written = 0;
    const connector = createIcsConnector(
      {},
      {
        fetch: memoryFetcher({ [URL_UNDER_TEST]: okResult("not a calendar") }),
        now: NOW,
      },
    );
    await expect(
      connector.signIn(scriptedIo([URL_UNDER_TEST]), {
        write: async () => {
          written += 1;
        },
      }),
    ).rejects.toThrow(KizukiError);
    expect(written).toBe(0);
  });
});
