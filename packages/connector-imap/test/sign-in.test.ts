import { Database } from "bun:sqlite";
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
  runBackfill,
  setSourceGrant,
} from "@kizuki/core";
import type { SignInIo } from "@kizuki/core";
import { IMAP_CONNECTOR_ID, createImapConnector } from "../src/connector";
import { parseImapState } from "../src/state";
import { FakeImapServer } from "../src/testing/fake-imap";
import { memoryDialer } from "../src/testing/memory-dialer";
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  fixtureMailbox,
} from "../src/testing";

const directories: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-imap-signin-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ScriptedIo extends SignInIo {
  asked: string[];
  notices: string[];
}

function scriptedIo(answers: string[]): ScriptedIo {
  const queue = [...answers];
  const io: ScriptedIo = {
    asked: [],
    notices: [],
    async prompt(question) {
      io.asked.push(question);
      return queue.shift() ?? "";
    },
    notify(text) {
      io.notices.push(text);
    },
    async openUrl() {},
  };
  return io;
}

function server(options: { password?: string } = {}): FakeImapServer {
  return new FakeImapServer(fixtureMailbox(), {
    username: FIXTURE_USERNAME,
    password: options.password ?? FIXTURE_PASSWORD,
  });
}

const HAPPY = [
  "mail.acme.example",
  "",
  FIXTURE_USERNAME,
  FIXTURE_PASSWORD,
  "INBOX, Archive/2026",
];

describe("interactive sign-in", () => {
  test("writes exactly one 0600 state file with the typed answers", async () => {
    const fake = server();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());
    const io = scriptedIo(HAPPY);

    const saved = await enrollConnection(
      db,
      store,
      createImapConnector({}, { dial: memoryDialer(fake) }),
      io,
    );

    expect(io.asked).toEqual([
      "IMAP server host: ",
      "IMAP port [993]: ",
      "Username (usually your email address): ",
      "App password: ",
      "Folders to sync [INBOX]: ",
    ]);
    expect(io.notices[0]).toContain("Folders on the server: ");
    expect(io.notices[0]).toContain("Archive/2026");

    const stateFiles = readdirSync(store.directory).filter((name) =>
      name.endsWith(".state"),
    );
    expect(stateFiles).toHaveLength(1);
    expect(
      statSync(join(store.directory, `${saved.source_key}.state`)).mode & 0o777,
    ).toBe(0o600);

    const bytes = store.read(saved) ?? new Uint8Array();
    expect(parseImapState(new TextDecoder().decode(bytes))).toEqual({
      schema: "kizuki.imap-state/v1",
      host: "mail.acme.example",
      port: 993,
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
      folders: ["INBOX", "Archive/2026"],
      max_message_bytes: 2_097_152,
    });
    db.close();
  });

  test("returns the username as the terminal label", async () => {
    const connector = createImapConnector({}, { dial: memoryDialer(server()) });
    const written: Uint8Array[] = [];
    const display = await connector.signIn(scriptedIo(HAPPY), {
      write: async (bytes) => {
        written.push(bytes);
      },
    });
    expect(display).toEqual({ display: FIXTURE_USERNAME });
    expect(written).toHaveLength(1);
  });

  test("puts INBOX first however the owner ordered the answer", async () => {
    const connector = createImapConnector({}, { dial: memoryDialer(server()) });
    let bytes: Uint8Array = new Uint8Array();
    await connector.signIn(
      scriptedIo([
        "mail.acme.example",
        "993",
        FIXTURE_USERNAME,
        FIXTURE_PASSWORD,
        "Archive/2026, inbox",
      ]),
      {
        write: async (written) => {
          bytes = written;
        },
      },
    );
    expect(parseImapState(new TextDecoder().decode(bytes)).folders).toEqual([
      "INBOX",
      "Archive/2026",
    ]);
  });

  test("adds INBOX when the owner named only other folders", async () => {
    const connector = createImapConnector({}, { dial: memoryDialer(server()) });
    let bytes: Uint8Array = new Uint8Array();
    await connector.signIn(
      scriptedIo([
        "mail.acme.example",
        "993",
        FIXTURE_USERNAME,
        FIXTURE_PASSWORD,
        "Archive/2026",
      ]),
      {
        write: async (written) => {
          bytes = written;
        },
      },
    );
    // The connector syncs INBOX plus the owner's picks; a state holding only
    // a custom folder would sync neither what was asked for nor what was said.
    expect(parseImapState(new TextDecoder().decode(bytes)).folders).toEqual([
      "INBOX",
      "Archive/2026",
    ]);
  });

  test("a server without an INBOX is refused", async () => {
    const fake = new FakeImapServer(
      fixtureMailbox().filter((folder) => folder.wire !== "INBOX"),
      { username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD },
    );
    const connector = createImapConnector({}, { dial: memoryDialer(fake) });
    const written: Uint8Array[] = [];
    const error = await connector
      .signIn(scriptedIo(HAPPY), {
        write: async (bytes) => {
          written.push(bytes);
        },
      })
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("misconfigured");
    expect((error as KizukiError).message).toContain("lists no INBOX");
    expect(written).toEqual([]);
  });

  test("state that does not list INBOX first is refused", () => {
    const error = ((): unknown => {
      try {
        return parseImapState(
          JSON.stringify({
            schema: "kizuki.imap-state/v1",
            host: "mail.acme.example",
            port: 993,
            username: FIXTURE_USERNAME,
            password: FIXTURE_PASSWORD,
            folders: ["Archive/2026"],
            max_message_bytes: 2_097_152,
          }),
        );
      } catch (caught: unknown) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("misconfigured");
    expect((error as KizukiError).message).toContain("must list INBOX first");
  });

  test("a wrong password fails unauthenticated and writes nothing", async () => {
    const fake = server({ password: "the-real-one" });
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());

    const error = await enrollConnection(
      db,
      store,
      createImapConnector({}, { dial: memoryDialer(fake) }),
      scriptedIo(HAPPY),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("unauthenticated");
    expect((error as KizukiError).message).not.toContain(FIXTURE_PASSWORD);
    expect(
      readdirSync(store.directory).filter((name) => name.endsWith(".state")),
    ).toEqual([]);
    db.close();
  });

  test("an unknown folder name is refused without echoing it and writes nothing", async () => {
    const fake = server();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());

    const error = await enrollConnection(
      db,
      store,
      createImapConnector({}, { dial: memoryDialer(fake) }),
      scriptedIo([
        "mail.acme.example",
        "",
        FIXTURE_USERNAME,
        FIXTURE_PASSWORD,
        "INBOX, Nope, Also/Nope",
      ]),
    ).catch((caught: unknown) => caught);

    expect((error as KizukiError).code).toBe("misconfigured");
    expect((error as KizukiError).message).toBe(
      "kizuki.imap: one or more selected folders are unavailable",
    );
    expect(
      readdirSync(store.directory).filter((name) => name.endsWith(".state")),
    ).toEqual([]);
    db.close();
  });

  test("a port out of range is refused before any connection", async () => {
    const fake = server();
    const connector = createImapConnector({}, { dial: memoryDialer(fake) });
    await expect(
      connector.signIn(
        scriptedIo([
          "mail.acme.example",
          "70000",
          FIXTURE_USERNAME,
          FIXTURE_PASSWORD,
        ]),
        { write: async () => {} },
      ),
    ).rejects.toThrow(KizukiError);
    expect(fake.received).toEqual([]);
  });

  test("a hostile mailbox name cannot reach the terminal", async () => {
    const hostile = "INBOX/\u001b]0;pwned\u0007\u001b[2J";
    const fake = new FakeImapServer(
      [
        ...fixtureMailbox(),
        {
          wire: hostile,
          attributes: ["\\HasNoChildren"],
          uidvalidity: 3,
          uidnext: 1,
          messages: [],
        },
      ],
      { username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD },
    );
    const io = scriptedIo(HAPPY);
    const connector = createImapConnector({}, { dial: memoryDialer(fake) });
    await connector.signIn(io, { write: async () => {} });

    const notice = io.notices[0] ?? "";
    expect(notice).toContain("Folders on the server: ");
    for (const character of notice) {
      expect((character.codePointAt(0) ?? 0) >= 0x20).toBe(true);
    }
    expect(notice).not.toContain("\u001b");
    expect(notice).not.toContain("\u0007");
  });

  test("a host with whitespace is refused before any connection", async () => {
    const fake = server();
    const connector = createImapConnector({}, { dial: memoryDialer(fake) });
    await expect(
      connector.signIn(
        scriptedIo(["mail acme example", "993", FIXTURE_USERNAME, "pw"]),
        { write: async () => {} },
      ),
    ).rejects.toThrow(KizukiError);
    expect(fake.received).toEqual([]);
  });

  test("re-selecting folders keeps the source key and the raw db holds no password", async () => {
    const directory = temporary();
    const dbPath = join(directory, "ledger.sqlite");
    const db = openLedger(dbPath);
    const store = new ConnectionStateStore(directory);
    const connector = createImapConnector({}, { dial: memoryDialer(server()) });

    const first = await enrollConnection(
      db,
      store,
      connector,
      scriptedIo(HAPPY),
    );
    const replaced = await store.replace(
      db,
      first,
      connector,
      scriptedIo([
        "mail.acme.example",
        "",
        FIXTURE_USERNAME,
        FIXTURE_PASSWORD,
        "INBOX",
      ]),
    );

    expect(replaced.source_key).toBe(first.source_key);
    const bytes = store.read(replaced) ?? new Uint8Array();
    expect(parseImapState(new TextDecoder().decode(bytes)).folders).toEqual([
      "INBOX",
    ]);
    db.close();

    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from(FIXTURE_PASSWORD))).toBe(false);
    expect(raw.includes(Buffer.from("mail.acme.example"))).toBe(false);
  });

  test("a run keeps the credential out of SQLite but does store folder names", async () => {
    const directory = temporary();
    const dbPath = join(directory, "ledger.sqlite");
    const db = openLedger(dbPath);
    const store = new ConnectionStateStore(directory);
    const fake = server();
    const enroller = createImapConnector({}, { dial: memoryDialer(fake) });

    const saved = await enrollConnection(db, store, enroller, scriptedIo(HAPPY));
    // Explicit synthetic owner consent; keep connector sensitivity authoritative.
    setSourceGrant(db, {
      source_key: saved.source_key, expected_revision: 0, operation_id: "fixture-grant",
      policy: {
        purposes: ["capture", "recall", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only",
        sensitivity_floor: "public",
      },
    });
    const ref = saved.secret_refs[0] ?? "";
    const bytes = store.read(saved) ?? new Uint8Array();
    const connector = createImapConnector(
      { secret_ref: ref },
      { dial: memoryDialer(fake) },
    );
    await connector.connect(async () => new TextDecoder().decode(bytes));
    const result = await runBackfill(db, connector, IMAP_CONNECTOR_ID, saved.source_key);
    expect(result.errors).toEqual([]);
    expect(result.stored).toBeGreaterThan(0);
    const connections = db
      .query("select config, secret_refs from connections")
      .all();
    expect(JSON.stringify(connections)).not.toContain(FIXTURE_USERNAME);
    db.close();

    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from(FIXTURE_PASSWORD))).toBe(false);
    expect(raw.includes(Buffer.from("mail.acme.example"))).toBe(false);
    // The README says so plainly: the checkpoint cursor is keyed by folder and
    // every event carries metadata.folder, so folder names are not a secret.
    // SQLite may split the string across pages. Prove logical persistence by
    // decoding a reopened read-only row; the raw secret scans above stay intact.
    const reopened = new Database(dbPath, { readonly: true });
    try {
      const folders = reopened.query<{ metadata: string }, []>("SELECT metadata FROM events")
        .all().map(row => (JSON.parse(row.metadata) as { folder?: string }).folder);
      expect(folders).toContain("Archive/2026");
    } finally { reopened.close(); }
  });
});
