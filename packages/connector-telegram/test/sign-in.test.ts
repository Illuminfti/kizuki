import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ConnectionStateStore,
  enrollConnection,
  openLedger,
} from "@kizuki/core";
import { FIXTURE_SESSION, fixtureAccount } from "../src/scripted";
import { parseState } from "../src/state";
import {
  CapturingWriter,
  ScriptedIo,
  harness,
  rejection,
  temporary,
} from "./helpers";

const PHONE = "+15551234567";

test("a completed sign-in writes one state blob and names the account", async () => {
  const { connector, api } = harness({ config: {} });
  const io = new ScriptedIo([PHONE, "22222"]);
  const writer = new CapturingWriter();

  expect(await connector.signIn(io, writer)).toEqual({ display: "@ada" });
  expect(writer.writes).toHaveLength(1);
  const state = parseState(writer.writes[0] as Uint8Array);
  expect(state.user_id).toBe("1001");
  expect(state.session).toBe(FIXTURE_SESSION);
  expect(api.calls.map((call) => call.method)).toEqual([
    "connect",
    "start",
    "me",
    "saveSession",
    "disconnect",
  ]);
});

test("the two-step password is prompted only when the account has one", async () => {
  const plain = harness({ config: {} });
  await plain.connector.signIn(new ScriptedIo([PHONE, "22222"]), new CapturingWriter());

  const account = fixtureAccount();
  account.sign_in = {
    code: "22222",
    password: "correct horse",
    password_hint: "the usual",
  };
  const guarded = harness({ account, config: {} });
  const io = new ScriptedIo([PHONE, "22222", "correct horse"]);
  await guarded.connector.signIn(io, new CapturingWriter());

  expect(io.prompts.map((prompt) => prompt.secret)).toEqual([
    false,
    false,
    true,
  ]);
  expect(io.prompts[2]?.question).toBe(
    "Two-step verification password (hint: the usual): ",
  );
});

test("a malformed phone number is refused before anything is dialled", async () => {
  const { connector, api } = harness({ config: {} });
  const io = new ScriptedIo(["5551234"]);
  const writer = new CapturingWriter();

  const error = await rejection(() => connector.signIn(io, writer));
  expect(error.code).toBe("invalid_phone");
  expect(error.message).not.toContain("5551234");
  expect(api.calls).toEqual([]);
  expect(writer.writes).toEqual([]);
});

test("a third rejected code abandons sign-in without writing state", async () => {
  const { connector, api } = harness({ config: {} });
  const io = new ScriptedIo([PHONE, "11111", "11111", "11111"]);
  const writer = new CapturingWriter();

  const error = await rejection(() => connector.signIn(io, writer));
  expect(error.code).toBe("sign_in_aborted");
  expect(io.notices).toEqual([
    "that code/password was not accepted, try again",
    "that code/password was not accepted, try again",
    "that code/password was not accepted, try again",
  ]);
  expect(writer.writes).toEqual([]);
  expect(api.calls.map((call) => call.method)).toContain("disconnect");
});

test("a short wait is honoured once and then sign-in continues", async () => {
  const account = fixtureAccount();
  account.sign_in = { code: "22222", flood: { seconds: 30, times: 1 } };
  const { connector, sleeps } = harness({ account, config: {} });
  const io = new ScriptedIo([PHONE, "22222"]);
  const writer = new CapturingWriter();

  expect(await connector.signIn(io, writer)).toEqual({ display: "@ada" });
  expect(sleeps).toEqual([30_000]);
  expect(io.notices).toEqual(["Telegram asked us to wait 30s"]);
});

test("a long wait is reported to the owner rather than slept through", async () => {
  const account = fixtureAccount();
  account.sign_in = { code: "22222", flood: { seconds: 120, times: 1 } };
  const { connector, sleeps } = harness({ account, config: {} });
  const writer = new CapturingWriter();

  const error = await rejection(() =>
    connector.signIn(new ScriptedIo([PHONE, "22222"]), writer),
  );
  expect(error.code).toBe("flood_wait");
  expect(error.retry_after).toBe(120);
  expect(sleeps).toEqual([]);
  expect(writer.writes).toEqual([]);
});

test("core enrollment stores the blob on disk and never in the database", async () => {
  const root = temporary();
  const databasePath = join(root, "ledger.sqlite");
  const db = openLedger(databasePath);
  try {
    const store = new ConnectionStateStore(root);
    const { connector } = harness({ config: {} });
    const connection = await enrollConnection(
      db,
      store,
      connector,
      new ScriptedIo(["+15551234567", "22222"]),
    );

    expect(connection.connector_id).toBe("kizuki.telegram");
    expect(connection.config.state_ref_index).toBe(0);
    expect(connection.secret_refs).toEqual([
      `file:connections/${connection.source_key}.state`,
    ]);
    const path = join(root, "connections", `${connection.source_key}.state`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseState(new Uint8Array(readFileSync(path))).user_id).toBe("1001");
    expect(readFileSync(databasePath).includes(Buffer.from(FIXTURE_SESSION))).toBe(
      false,
    );

    const replacement = await store.replace(
      db,
      connection,
      harness({ config: {} }).connector,
      new ScriptedIo(["+15551234567", "22222"]),
    );
    expect(replacement.source_key).toBe(connection.source_key);
    expect(replacement.secret_refs).toEqual(connection.secret_refs);
  } finally {
    db.close();
  }
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

test("provider text on its way to the terminal cannot drive it", async () => {
  const account = fixtureAccount();
  account.me = {
    id: "1001",
    first_name: "ada\u001b]52;c;cGF5bG9hZA==\u0007",
    last_name: "\u001b[2J",
    bot: false,
  };
  account.sign_in = {
    code: "22222",
    password: "correct horse",
    password_hint: "the \u001b[31musual",
  };
  const io = new ScriptedIo(["+15550009876", "22222", "correct horse"]);
  const { connector } = harness({ account, config: {} });

  const display = await connector.signIn(io, new CapturingWriter());
  expect(display.display).not.toMatch(CONTROL);
  expect(display.display).toBe("ada ]52;c;cGF5bG9hZA== [2J");
  for (const prompt of io.prompts) {
    expect(prompt.question).not.toMatch(CONTROL);
  }
  expect(io.prompts.at(-1)?.question).toBe(
    "Two-step verification password (hint: the [31musual): ",
  );
});

test("a name made only of control sequences still labels the account", async () => {
  const account = fixtureAccount();
  account.me = { id: "1001", first_name: "\u0007\u001b", bot: false };
  const { connector } = harness({ account, config: {} });
  const display = await connector.signIn(
    new ScriptedIo(["+15550009876", "22222"]),
    new CapturingWriter(),
  );
  expect(display.display).toBe("user 1001");
});
