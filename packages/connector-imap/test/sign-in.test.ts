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
import type { SignInIo } from "@kizuki/core";
import { createImapConnector } from "../src/connector";
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

  test("an unknown folder name is refused by name and writes nothing", async () => {
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
    expect((error as KizukiError).message).toContain(
      "unknown folders: Nope, Also/Nope",
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
});
