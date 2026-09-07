import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Connector, PurgePlan } from "@kizuki/core";
import { TelegramConnector, ScriptedTelegramApi, fixtureAccount, scriptedDeps, encodeState } from "@kizuki/connector-telegram";
import { createImapConnector } from "@kizuki/connector-imap";
import { FakeImapServer, fixtureMailbox, fixtureState, memoryDialer } from "@kizuki/connector-imap/testing";
import { getConnector, WHATSAPP_IMPORT_CONNECTOR_ID, POCKET_IMPORT_CONNECTOR_ID, OMNIVORE_IMPORT_CONNECTOR_ID } from "../src";
import { WHATSAPP_FIXTURE_FILES, WHATSAPP_FIXTURE_TIMEZONE, POCKET_FIXTURE_EXPORT, OMNIVORE_FIXTURE_FILES } from "../src/testkit";
import type { PurgeConformanceFixture, PurgeFixtureRow } from "../src/testkit";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function sourceTreeDigest(root: string): Promise<string> {
  const entries: unknown[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8 || entries.length > 64) throw new Error("synthetic source inventory exceeded its bound");
    const target = join(root, relative), stat = await lstat(target, { bigint: true });
    if (stat.size > 1_048_576n || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("synthetic source type changed");
    // atime is deliberately excluded: observing source bytes may update it.
    entries.push([relative, stat.isDirectory() ? "directory" : digest(await readFile(target)),
      ...[stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]);
    if (!stat.isDirectory()) return;
    const names = await readdir(join(root, relative));
    if (names.length + entries.length > 64) throw new Error("synthetic source inventory exceeded its bound");
    for (const name of names.sort()) await visit(join(relative, name), depth + 1);
  };
  await visit("", 0);
  return digest(JSON.stringify(entries));
}

/** These five planners are read-only at the source. The fixture executor must
 * consume their empty removal set while proving every unreachable row survives.
 * The shared mutable-source adversarial fixture separately proves actual removal.
 */
function readOnlyFixture(connector: Connector, subject: string, selected: string[], allIds: string[],
  snapshot: () => Promise<PurgeFixtureRow[]>, dispose: () => Promise<void>): PurgeConformanceFixture {
  return { connector, subject_id: subject, removable_ids: [], unreachable_ids: selected,
    unrelated_ids: allIds.filter(id => !selected.includes(id)), snapshot, dispose,
    execute: async (plan: Readonly<PurgePlan>) => {
      if (plan.complete !== true || plan.subject_id !== subject || plan.source_record_ids.length !== 0 ||
        JSON.stringify([...plan.unreachable_source_record_ids].sort()) !== JSON.stringify([...selected].sort())) {
        throw new Error("read-only fixture cannot execute that plan");
      }
    },
    verifyAbsent: async ids => { const source = await snapshot(); return { checked: ids.length,
      found: ids.filter(id => source.some(row => row.source_record_id === id)) }; },
  };
}

/** Fresh disposable files, never the configured registry battery's source. */
export async function exportPurgeFixture(id: string): Promise<PurgeConformanceFixture> {
  const root = await mkdtemp(join(tmpdir(), "kizuki-purge-source-fixture-"));
  try {
    const source = join(root, "source"), sentinel = join(root, "unrelated.txt");
    const files = id === WHATSAPP_IMPORT_CONNECTOR_ID ? WHATSAPP_FIXTURE_FILES
      : id === OMNIVORE_IMPORT_CONNECTOR_ID ? OMNIVORE_FIXTURE_FILES
      : id === POCKET_IMPORT_CONNECTOR_ID ? { "pocket.csv": POCKET_FIXTURE_EXPORT } : null;
    if (!files) throw new Error("unsupported synthetic export fixture");
    for (const [name, bytes] of Object.entries(files)) {
      const target = join(source, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    }
    await writeFile(sentinel, "Independent synthetic source stays present.");
    const connector = getConnector(id, { path: id === POCKET_IMPORT_CONNECTOR_ID ? join(source, "pocket.csv") : source,
      ...(id === WHATSAPP_IMPORT_CONNECTOR_ID ? { timezone: WHATSAPP_FIXTURE_TIMEZONE } : {}) });
    const subject = id === WHATSAPP_IMPORT_CONNECTOR_ID ? "whatsapp:ada" : id === POCKET_IMPORT_CONNECTOR_ID ? "pocket:self" : "omnivore:self";
    const known = await connector.fixture();
    const ids = known.map(event => event.source_record_id);
    const selected = known.filter(event => event.subjects.some(value => value.subject_id === subject)).map(event => event.source_record_id);
    const snapshot = async () => {
      // Every record's digest binds the actual complete export bytes, not a cached
      // connector result. Any planning mutation of any source file is detected.
      const sha256 = await sourceTreeDigest(root);
      return [...ids, "fixture:unrelated-source"].map(source_record_id => ({ source_record_id, sha256 }));
    };
    return readOnlyFixture(connector, subject, selected, [...ids, "fixture:unrelated-source"], snapshot,
      () => rm(root, { recursive: true }));
  } catch (error) { await rm(root, { recursive: true }); throw error; }
}

export async function telegramPurgeFixture(): Promise<PurgeConformanceFixture> {
  const account = fixtureAccount(), api = new ScriptedTelegramApi(account);
  const connector = new TelegramConnector({ state_ref: "file:connections/01JJ0000000000000000000000.state" },
    { ...scriptedDeps(), api: () => api });
  try {
    await connector.connect(async () => new TextDecoder().decode(encodeState({ schema: "kizuki.telegram-state/v1", user_id: "1001",
      session: "fixture-session-token-not-a-real-credential" })));
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const batch = await connector.backfill(cursor); cursor = batch.cursor;
      if (batch.events.length === 0) break;
      if (page === 99) throw new Error("synthetic history did not finish");
    }
    const snapshot = async () => Object.entries(account.messages).flatMap(([peer, messages]) => messages.map(message => ({
      source_record_id: `${peer}:${message.id}`, sha256: digest(JSON.stringify({ message, me: account.me, dialogs: account.dialogs })),
    })));
    const selected = ["-100777:23", "-42:10", "1002:1", "1002:2", "1002:3", "1002:4", "1002:5"];
    return readOnlyFixture(connector, "telegram:user:1002", selected, (await snapshot()).map(row => row.source_record_id), snapshot,
      () => connector.close());
  } catch (error) { await connector.close(); throw error; }
}

export async function imapPurgeFixture(): Promise<PurgeConformanceFixture> {
  const state = fixtureState(), server = new FakeImapServer(fixtureMailbox(), { username: state.username, password: state.password });
  const connector = createImapConnector({ secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state" }, { dial: memoryDialer(server) });
  await connector.connect(async () => JSON.stringify(state));
  const snapshot = async () => server.folders.flatMap(folder => folder.messages.map(message => ({
    source_record_id: `${folder.uidvalidity}:${message.uid}:${folder.wire}`,
    sha256: digest(JSON.stringify({ wire: folder.wire, uidvalidity: folder.uidvalidity, uid: message.uid,
      internaldate: message.internaldate, raw: Buffer.from(message.raw).toString("base64"),
      selection: server.folders.map(value => [value.wire, value.attributes, value.uidvalidity]) })),
  })));
  // The owned fake server's exact selector oracle uses its source bytes, never
  // the planner response. The separate Archive mailbox is deliberately unrelated.
  const selected = server.folder("INBOX").messages.filter(message => Buffer.from(message.raw).toString().toLowerCase().includes("ada@acme.example"))
    .map(message => `42:${message.uid}:INBOX`);
  return readOnlyFixture(connector, "email:ada@acme.example", selected, (await snapshot()).map(row => row.source_record_id), snapshot,
    () => connector.revoke());
}
