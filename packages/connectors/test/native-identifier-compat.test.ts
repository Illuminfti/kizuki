import { expect, test } from "bun:test";
import { EVENT_LIMITS, validateEventInput } from "@kizuki/core";
import { pocketEvents } from "../src/import-pocket";
import { mapOmnivoreFiles, omnivoreEvents } from "../src/import-omnivore";
import { FIXTURE_OBSERVED_AT, MAX_RECORD_BYTES } from "../src/util";

test("preserves native Pocket and Omnivore identifiers through event validation", async () => {
  const pocketUrl = `https://example.test/${"界".repeat(2_070)}`;
  const [pocket] = pocketEvents([{
    title: "",
    url: pocketUrl,
    time_added: "1767225600",
    tags: [],
    status: "unread",
  }], FIXTURE_OBSERVED_AT);
  expect(validateEventInput(pocket).ok).toBe(true);
  expect(pocket?.source_record_id).toBe(pocketUrl);

  const nativeId = "é".repeat(MAX_RECORD_BYTES / 2);
  const events = await omnivoreEvents(mapOmnivoreFiles({
    "metadata_0_to_1.json": JSON.stringify([
      { id: nativeId, slug: "one", savedAt: "2026-01-01T00:00:00Z" },
      { id: nativeId, slug: "two", savedAt: "2026-01-02T00:00:00Z" },
    ]),
  }), FIXTURE_OBSERVED_AT);
  expect(events.map((event) => event.source_record_id)).toEqual([nativeId, `${nativeId}#2`]);
  for (const event of events) expect(validateEventInput(event).ok).toBe(true);
});

test("refuses identifiers beyond their explicit native field limits", () => {
  const result = validateEventInput({
    ...pocketEvents([{
      title: "",
      url: "https://example.test/record",
      time_added: "1767225600",
      tags: [],
      status: "unread",
    }], FIXTURE_OBSERVED_AT)[0]!,
    source_record_id: "é".repeat(EVENT_LIMITS.sourceRecordIdBytes / 2 + 1),
  });
  expect(result).toEqual({
    ok: false,
    errors: [`source_record_id: exceeds ${EVENT_LIMITS.sourceRecordIdBytes} UTF-8 bytes`],
  });
});
