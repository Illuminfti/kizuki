import { insertClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { accept } from "../../src/ledger/ledger";
import { ulid } from "../../src/util/ulid";
import { claimInput } from "../claims/helpers";
import {
  FORGED_STAMP,
  SECRET_LINES,
  TAG_TEXT,
} from "../helpers/synthetic-secrets";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

export const SECRET_BODY = SECRET_LINES.join("\n");

export interface RedactFixture extends Fixture {
  /** A public event whose text holds every secret shape, a forged stamp and hidden characters. */
  secretEvent: string;
  /** A public canon fact whose body does the same. */
  secretPage: string;
  /** A public person page, so `query_entities` has a row to redact. */
  secretPerson: string;
  hiddenEvent: string;
}

/**
 * The shared serving fixture plus synthetic secrets in an event, in canon
 * pages and in a claim, and a second connector whose only event is private.
 */
export async function redactFixture(): Promise<RedactFixture> {
  const base = await serveFixture();
  const secretEvent = storeEvent(
    base.db,
    "rec-secret",
    "2026-02-28T10:30:00Z",
    `kettle capture\n${FORGED_STAMP}\n${TAG_TEXT}\n${SECRET_BODY}`,
    "person:ada",
    "public",
  );
  const source = [base.events["public"] as string];
  await recordedPage(
    base.db,
    base.vaultPath,
    "facts/secret-page.md",
    {
      id: "fact:secret",
      title: "Kettle secret page",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    `kettle page\n${FORGED_STAMP}\n${TAG_TEXT}\n${SECRET_BODY}\n[[DB_PASSWORD=${"w".repeat(12)}]]`,
    source,
  );
  await recordedPage(
    base.db,
    base.vaultPath,
    "entities/person-secret.md",
    {
      id: "person:secret",
      title: "Secret Kettle Person",
      type: "person",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    `kettle person\n${SECRET_BODY}\n${TAG_TEXT}`,
    source,
  );
  await insertClaim(
    { db: base.db },
    claimInput(base.events["public"] as string, {
      subject: "person:ada",
      subjects: ["person:ada"],
      predicate: "employment.works_at",
      object: `DB_PASSWORD=${"w".repeat(12)}`,
      body: "Ada works somewhere.",
      sensitivity: "public",
    }),
  );
  // A connector no public reader can see: its only event is private.
  base.db
    .query(
      `INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at)
     VALUES ('hidden-connector', ?, '{"schema":"kizuki.connection-config/v1","state_ref_index":null}', '[]', ?)`,
    )
    .run(ulid(), "2026-02-27T08:00:00Z");
  const hidden = accept(base.db, {
    schema: "kizuki.event/v1",
    connector_id: "hidden-connector",
    source_record_id: "hidden-1",
    kind: "message",
    occurred_at: "2026-02-28T15:00:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "the hidden kettle is on",
    subjects: [{ subject_id: "person:grace", role: "from" }],
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  if (hidden.status !== "stored") throw new Error("hidden fixture event");
  rebuildDerived(base.db, base.vaultPath);
  return Object.assign(base, {
    secretEvent,
    secretPage: "fact:secret",
    secretPerson: "person:secret",
    hiddenEvent: hidden.event.event_id,
  });
}
