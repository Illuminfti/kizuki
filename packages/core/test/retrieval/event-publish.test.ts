import { afterEach, expect, test } from "bun:test";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_DESCRIPTOR } from "../../src/retrieval";
import { eventRetrievalDoc, publishLedgerEvent } from "../../src/retrieval/events";
import { retrievalDocId } from "../../src/retrieval/ids";
import { storedEvent } from "../search/helpers";
import { searchDb } from "../search/helpers";
import { temporaryPortContext } from "../contracts/fixtures";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

test("publishLedgerEvent upserts a live event through kizuki.retrieval/v1 and withdraws a tombstone", async () => {
  const db = searchDb();
  disposers.push(() => db.close());
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  disposers.push(temporary.cleanup);
  const port = createFts5RetrievalPort(temporary.ctx);
  disposers.push(() => {
    void port.close();
  });

  const live = storedEvent(db, "publish-live", {
    text: "kettle publication evidence",
    sensitivity_hint: "personal",
  });
  expect(eventRetrievalDoc(live)).toMatchObject({
    doc_id: retrievalDocId("event", live.event_id),
    kind: "event",
    authority: "connector_evidence",
    taint: "quoted",
    sensitivity: "personal",
  });
  await publishLedgerEvent(port, live);
  const found = await port.search({
    text: "kettle publication",
    mode: "lexical",
    scope: { kinds: ["event"] },
    ceiling: "personal",
    limit: 10,
    deadline_ms: 1_000,
  });
  expect(found.hits.map((hit) => hit.doc_id)).toEqual([retrievalDocId("event", live.event_id)]);

  await publishLedgerEvent(port, { ...live, deleted: true });
  const absent = await port.verifyAbsent([retrievalDocId("event", live.event_id)]);
  expect(absent.found).toEqual([]);
});
