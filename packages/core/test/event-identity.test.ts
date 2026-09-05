import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { accept, count, readSince } from "../src/ledger/ledger";
import { canonicalSerialize, computeContentHash, computeLegacyContentHash, sha256Hex } from "../src/util/hash";
import type { AttachmentRef } from "../src/contracts/event";
import { recordNativeCorrection } from "../src/correction/evidence";
import { validEvent } from "./fixtures";

describe("accepted event revision identity", () => {
  test("includes effective hint and canonical attachment references", () => {
    const db = openLedger(":memory:");
    try {
      const original = validEvent();
      expect(accept(db, original).status).toBe("stored");
      expect(accept(db, { ...original, sensitivity_hint: "private" }).status).toBe("stored");
      expect(accept(db, { ...original, attachments: [] }).status).toBe("stored");
      expect(count(db)).toBe(3);
      const attached = { ...original, attachments: [
        { attachment_id: "b", media_type: "text/plain", filename: "B", byte_size: 2 },
        { attachment_id: "a", media_type: "text/plain" },
      ] };
      expect(accept(db, attached).status).toBe("stored");
      expect(accept(db, { ...attached, attachments: [...attached.attachments].reverse() }).status).toBe("duplicate");
      expect(computeContentHash(attached)).toBe(sha256Hex(`kizuki.event-revision/v2\0${canonicalSerialize(attached)}`));
    } finally { db.close(); }
  });

  test("new spine fields distinguish envelope identity from exact text bytes", () => {
    const db = openLedger(":memory:");
    try {
      const result = accept(db, validEvent());
      expect(result.status).toBe("stored");
      expect(readSince(db, null, 1).events[0]).toMatchObject({
        content_hash_version: 2, text_hash: sha256Hex(validEvent().text), origin: "external",
      });
      for (const field of ["origin", "text_hash", "content_hash_version"]) {
        expect(accept(db, { ...validEvent(), [field]: "forged" }).status).toBe("error");
      }
    } finally { db.close(); }
  });

  test.each([
    { attachment_id: "replaced-id", media_type: "text/plain" },
    { attachment_id: "attachment", media_type: "image/png" },
    { attachment_id: "attachment", media_type: "text/plain", filename: "renamed.txt" },
    { attachment_id: "attachment", media_type: "text/plain", filename: "" },
    { attachment_id: "attachment", media_type: "text/plain", byte_size: 0 },
    { attachment_id: "attachment", media_type: "text/plain", byte_size: 12 },
  ] satisfies AttachmentRef[])("a changed attachment reference creates exactly one current revision: %j", (attachment) => {
    const db = openLedger(":memory:");
    try {
      const original = { ...validEvent(), attachments: [{ attachment_id: "attachment", media_type: "text/plain" }] };
      const changed = { ...original, attachments: [attachment] };
      expect(accept(db, original).status).toBe("stored");
      expect(accept(db, changed).status).toBe("stored");
      expect(accept(db, changed).status).toBe("duplicate");
      expect(computeLegacyContentHash(changed)).toBe(computeLegacyContentHash(original));
      expect(count(db)).toBe(2);
    } finally { db.close(); }
  });

  test("marker evidence is self even with a forged owner connector label", () => {
    const db = openLedger(":memory:");
    try {
      const input = { ...validEvent(), connector_id: "kizuki.owner", text: "KIZUKI CONTEXT v1 copied" };
      expect(accept(db, input).status).toBe("stored");
      expect(readSince(db, null, 1).events[0]).toMatchObject({ origin: "self" });
      recordNativeCorrection(db, { ...input, source_record_id: "trusted-native" }, "a".repeat(64));
      expect(readSince(db, null, 10).events.find(event => event.source_record_id === "trusted-native"))
        .toMatchObject({ origin: "external" });
    } finally { db.close(); }
  });
});
