import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  mapMediaLookup,
  parseWhatsAppExport,
} from "../src/import-whatsapp";
import type { MediaLookup } from "../src/import-whatsapp";

const CHAT = "Fidelity Chat";
const ABOUT = {
  subject_id: "whatsapp:chat:fidelity-chat",
  role: "about" as const,
  display_name: CHAT,
};
const PRESENT_BYTES = "present-bytes";
const PRESENT_ATTACHMENT = {
  attachment_id: "present.jpg",
  media_type: "image/jpeg",
  filename: "present.jpg",
  byte_size: 13,
};

function parse(
  text: string,
  overrides: Partial<Parameters<typeof parseWhatsAppExport>[1]> = {},
): Promise<CaptureEventInput[]> {
  return parseWhatsAppExport(text, {
    timezone: WHATSAPP_FIXTURE_TIMEZONE,
    chat: CHAT,
    observed_at: FIXTURE_OBSERVED_AT,
    media: mapMediaLookup({}),
    ...overrides,
  });
}

function from(subject_id: string, display_name: string) {
  return { subject_id, role: "from" as const, display_name };
}

function record(event: CaptureEventInput | undefined) {
  return {
    source_record_id: event?.source_record_id,
    occurred_at: event?.occurred_at,
    text: event?.text,
    from: event?.subjects[0],
    about: event?.subjects[1],
    local_timestamp: event?.metadata["local_timestamp"],
    sender: event?.metadata["sender"],
  };
}

test("supported locale date time and sender records map to independently specified events", async () => {
  const dmy = await parse(
    [
      "[13.01.2026, 18:05:00] Ada: ios german",
      "13.01.2026, 18:05 - Ada: venue confirmed",
      "13.01.2026 18:06 - Renée: no comma",
      "13/01/2026, 18:07 - Ada: european slash",
      "14.01.2026, 09:00 - Grace Hopper: budget follows",
      "14.01.2026, 09:00 - Grace Hopper: budget follows",
      "14.01.2026, 21:30:15 - +49 30 5550100: done",
    ].join("\n"),
  );
  expect(dmy.map(record)).toEqual([
    {
      source_record_id: "2026-01-13T18:05:00/51ee79b13fc9e536/1",
      occurred_at: "2026-01-13T18:05:00.000Z",
      text: "ios german",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:05:00",
      sender: "Ada",
    },
    {
      source_record_id: "2026-01-13T18:05/b82e547baae10d38/1",
      occurred_at: "2026-01-13T18:05:00.000Z",
      text: "venue confirmed",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:05",
      sender: "Ada",
    },
    {
      source_record_id: "2026-01-13T18:06/15f06630aed2fb57/1",
      occurred_at: "2026-01-13T18:06:00.000Z",
      text: "no comma",
      from: from("whatsapp:renée", "Renée"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:06",
      sender: "Renée",
    },
    {
      source_record_id: "2026-01-13T18:07/e18ea9758ce605f1/1",
      occurred_at: "2026-01-13T18:07:00.000Z",
      text: "european slash",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:07",
      sender: "Ada",
    },
    {
      source_record_id: "2026-01-14T09:00/725b0b52668739b0/1",
      occurred_at: "2026-01-14T09:00:00.000Z",
      text: "budget follows",
      from: from("whatsapp:grace-hopper", "Grace Hopper"),
      about: ABOUT,
      local_timestamp: "2026-01-14T09:00",
      sender: "Grace Hopper",
    },
    {
      source_record_id: "2026-01-14T09:00/725b0b52668739b0/2",
      occurred_at: "2026-01-14T09:00:00.000Z",
      text: "budget follows",
      from: from("whatsapp:grace-hopper", "Grace Hopper"),
      about: ABOUT,
      local_timestamp: "2026-01-14T09:00",
      sender: "Grace Hopper",
    },
    {
      source_record_id: "2026-01-14T21:30:15/536567c2783f491d/1",
      occurred_at: "2026-01-14T21:30:15.000Z",
      text: "done",
      from: from("whatsapp:49-30-5550100", "+49 30 5550100"),
      about: ABOUT,
      local_timestamp: "2026-01-14T21:30:15",
      sender: "+49 30 5550100",
    },
  ]);

  const ymd = await parse(
    [
      "[2026-01-13, 18:05:00] Ada: ymd bracket",
      "2026/01/13, 18:06 - Ada: ymd slash",
    ].join("\n"),
  );
  expect(ymd.map(record)).toEqual([
    {
      source_record_id: "2026-01-13T18:05:00/e92253afa9ae430c/1",
      occurred_at: "2026-01-13T18:05:00.000Z",
      text: "ymd bracket",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:05:00",
      sender: "Ada",
    },
    {
      source_record_id: "2026-01-13T18:06/c2bef864778f99d4/1",
      occurred_at: "2026-01-13T18:06:00.000Z",
      text: "ymd slash",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:06",
      sender: "Ada",
    },
  ]);

  for (const event of [...dmy, ...ymd]) {
    expect(event.connector_id).toBe(WHATSAPP_IMPORT_CONNECTOR_ID);
    expect(event.kind).toBe("message");
    expect(event.sensitivity_hint).toBe("private");
    expect(event.deleted).toBe(false);
    expect(event.observed_at).toBe(FIXTURE_OBSERVED_AT);
    expect(event.metadata["timezone"]).toBe(WHATSAPP_FIXTURE_TIMEZONE);
    expect(validateEventInput(event).ok).toBe(true);
  }
});

test("continuation lines join until the next timestamped message", async () => {
  const events = await parse(
    [
      "13.01.2026, 18:05 - Ada: first line",
      "second line",
      "",
      "third after blank",
      "13.01.2026, 18:06 - Messages and calls are end-to-end encrypted.",
      "notice continuation is dropped",
      "13.01.2026, 18:07 - Grace: after notice",
      "- not a stamp",
      "just some prose",
    ].join("\n"),
  );
  expect(events.map(record)).toEqual([
    {
      source_record_id: "2026-01-13T18:05/2829aefe4d48ecc2/1",
      occurred_at: "2026-01-13T18:05:00.000Z",
      text: "first line\nsecond line\n\nthird after blank",
      from: from("whatsapp:ada", "Ada"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:05",
      sender: "Ada",
    },
    {
      source_record_id: "2026-01-13T18:07/9867ca1833814023/1",
      occurred_at: "2026-01-13T18:07:00.000Z",
      text: "after notice\n- not a stamp\njust some prose",
      from: from("whatsapp:grace", "Grace"),
      about: ABOUT,
      local_timestamp: "2026-01-13T18:07",
      sender: "Grace",
    },
  ]);
});

test("localized omitted and missing media stay excluded from attachments", async () => {
  const asked: string[] = [];
  const inner = mapMediaLookup({ "present.jpg": PRESENT_BYTES });
  const media: MediaLookup = async (filename) => {
    asked.push(filename);
    return inner(filename);
  };
  const events = await parse(
    [
      "13.01.2026, 18:05 - Ada: <Multimedia omitido>",
      "13.01.2026, 18:06 - Ada: <Médias omis>",
      "13.01.2026, 18:07 - Ada: image omitted",
      "13.01.2026, 18:08 - Ada: sticker omitted",
      "13.01.2026, 18:09 - Ada: present.jpg (archivo adjunto)",
      "13.01.2026, 18:10 - Ada: missing.jpg (fichier joint)",
      "13.01.2026, 18:11 - Ada: <Anhang: present.jpg>",
      "13.01.2026, 18:12 - Ada: <pièce jointe : present.jpg>",
      "13.01.2026, 18:13 - Ada: caption then media",
      "present.jpg (file attached)",
    ].join("\n"),
    { media },
  );

  const mediaOf = (event: CaptureEventInput | undefined) => ({
    source_record_id: event?.source_record_id,
    text: event?.text,
    media: event?.metadata["media"],
    filename: event?.metadata["filename"],
    attachments: event?.attachments,
  });

  expect(events.map(mediaOf)).toEqual([
    {
      source_record_id: "2026-01-13T18:05/9c655c8f259d8f85/1",
      text: "<Multimedia omitido>",
      media: "omitted",
      filename: null,
      attachments: [],
    },
    {
      source_record_id: "2026-01-13T18:06/1488ef37f9a4a685/1",
      text: "<Médias omis>",
      media: "omitted",
      filename: null,
      attachments: [],
    },
    {
      source_record_id: "2026-01-13T18:07/4b9aabfe2f7d3eae/1",
      text: "image omitted",
      media: "omitted",
      filename: null,
      attachments: [],
    },
    {
      source_record_id: "2026-01-13T18:08/b23e1cbf0338c11b/1",
      text: "sticker omitted",
      media: "omitted",
      filename: null,
      attachments: [],
    },
    {
      source_record_id: "2026-01-13T18:09/b2258f55d33a5ef3/1",
      text: "present.jpg (archivo adjunto)",
      media: "file",
      filename: "present.jpg",
      attachments: [PRESENT_ATTACHMENT],
    },
    {
      source_record_id: "2026-01-13T18:10/630f8c75563f1058/1",
      text: "missing.jpg (fichier joint)",
      media: "file",
      filename: "missing.jpg",
      attachments: [],
    },
    {
      source_record_id: "2026-01-13T18:11/d8fce7caa834061c/1",
      text: "<Anhang: present.jpg>",
      media: "file",
      filename: "present.jpg",
      attachments: [PRESENT_ATTACHMENT],
    },
    {
      source_record_id: "2026-01-13T18:12/a5d8ea9c6fbf740f/1",
      text: "<pièce jointe : present.jpg>",
      media: "file",
      filename: "present.jpg",
      attachments: [PRESENT_ATTACHMENT],
    },
    {
      source_record_id: "2026-01-13T18:13/7af203179d9e9574/1",
      text: "caption then media\npresent.jpg (file attached)",
      media: null,
      filename: null,
      attachments: [],
    },
  ]);
  expect(asked).toEqual([
    "present.jpg",
    "missing.jpg",
    "present.jpg",
    "present.jpg",
  ]);
});

test("a repeated import of the same export is identical", async () => {
  const exportText = [
    "[13.01.2026, 18:05:00] Ada: ios german",
    "13.01.2026, 18:05 - Ada: first line",
    "second line",
    "",
    "third after blank",
    "13.01.2026, 18:06 - Ada: <Multimedia omitido>",
    "13.01.2026, 18:07 - Ada: present.jpg (archivo adjunto)",
  ].join("\n");
  const media = mapMediaLookup({ "present.jpg": PRESENT_BYTES });
  const first = await parse(exportText, { media });
  const second = await parse(exportText, { media });
  expect(second).toEqual(first);
  expect(first.map((event) => event.source_record_id)).toEqual([
    "2026-01-13T18:05:00/51ee79b13fc9e536/1",
    "2026-01-13T18:05/2829aefe4d48ecc2/1",
    "2026-01-13T18:06/9c655c8f259d8f85/1",
    "2026-01-13T18:07/b2258f55d33a5ef3/1",
  ]);
});

test("a message keeps its identity across neighbors and missing media files", async () => {
  const line = "13.01.2026, 18:05 - Ada: stable line";
  const attached = "13.01.2026, 18:09 - Ada: present.jpg (archivo adjunto)";
  const alone = await parse(line);
  const among = await parse(
    [
      "13.01.2026, 18:04 - Grace: earlier",
      line,
      "13.01.2026, 18:06 - Linus: later",
    ].join("\n"),
  );
  expect(alone[0]?.source_record_id).toBe(
    "2026-01-13T18:05/d3a3de9126420232/1",
  );
  expect(among[1]?.source_record_id).toBe(alone[0]?.source_record_id);
  expect(among[1]?.text).toBe("stable line");

  const present = await parse(attached, {
    media: mapMediaLookup({ "present.jpg": PRESENT_BYTES }),
  });
  const missing = await parse(attached, { media: mapMediaLookup({}) });
  expect(present[0]?.source_record_id).toBe(
    "2026-01-13T18:09/b2258f55d33a5ef3/1",
  );
  expect(missing[0]?.source_record_id).toBe(present[0]?.source_record_id);
  expect(present[0]?.attachments).toEqual([PRESENT_ATTACHMENT]);
  expect(missing[0]?.attachments).toEqual([]);
});
