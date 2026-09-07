import { expect, test } from "bun:test";
import { validateEventInput, type CaptureEventInput } from "@kizuki/core";
import { messageEvent } from "../src/events";
import { FIELDS, type Field } from "../src/state";
const OBSERVED = "2024-01-02T00:00:00.000Z";
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const control = (code: number) => String.fromCharCode(code);
const plain = (text: string, extra: Record<string, unknown> = {}) => ({ mimeType: "text/plain", body: { data: b64(text) }, ...extra });
const message = (payload: unknown, extra: Record<string, unknown> = {}) => ({ id: "m1", threadId: "t1", historyId: "100", internalDate: "1704067200000", payload, ...extra });
/** Every event the projection emits must already satisfy the frozen core ingress. */
function emit(raw: unknown, selected: readonly Field[] = FIELDS): CaptureEventInput {
    const event = messageEvent("fixture-account", raw, OBSERVED, selected);
    expect(validateEventInput(event).ok).toBe(true);
    return event;
}
function refuse(raw: unknown, code: string, selected: readonly Field[] = FIELDS): void {
    let caught: unknown;
    try {
        messageEvent("fixture-account", raw, OBSERVED, selected);
    }
    catch (error) {
        caught = error;
    }
    expect(caught).toMatchObject({ code });
}
test("control character in a header value refuses the record", () => {
    refuse(message(plain("ok", { headers: [{ name: "Subject", value: `hidden${control(0x1b)}[2Jsentinel` }] })), "source_schema");
    refuse(message(plain("ok", { headers: [{ name: "From", value: `a@example.test${control(0x01)}` }] })), "source_schema");
    expect(emit(message(plain("ok", { headers: [{ name: "Subject", value: "tab\tand newline\nallowed" }] }))).metadata.headers).toEqual({ subject: "tab\tand newline\nallowed" });
});
test("html-only body is reported unsupported and yields no text", () => {
    const event = emit(message({ mimeType: "text/html", body: { data: b64("<p>HTML_SENTINEL</p>") } }));
    expect(event.text).toBe("");
    expect(event.metadata.body_coverage).toEqual(["mime_projection_limited_depth_8", "non_plain_body_unsupported"]);
});
test("non-utf8 charset declaration is reported unsupported without decoding", () => {
    const event = emit(message(plain("LATIN_SENTINEL", { headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }] })));
    expect(event.text).toBe("");
    expect(event.metadata.body_coverage).toEqual(["charset_unsupported", "mime_projection_limited_depth_8"]);
    expect(emit(message(plain("ascii ok", { headers: [{ name: "Content-Type", value: 'text/plain; charset="US-ASCII"' }] }))).text).toBe("ascii ok");
});
test("body beyond 65536 decoded bytes is excluded and reported", () => {
    const event = emit(message(plain("x".repeat(65537))));
    expect(event.text).toBe("");
    expect(event.metadata.body_coverage).toEqual(["body_size_unsupported", "mime_projection_limited_depth_8"]);
    expect(emit(message(plain("y".repeat(65536)))).text).toHaveLength(65536);
});
test("body byte budget is cumulative across parts", () => {
    const event = emit(message({ mimeType: "multipart/mixed", parts: [plain("a".repeat(40000)), plain("b".repeat(30000))] }));
    expect(event.text).toBe("a".repeat(40000));
    expect(event.metadata.body_coverage).toContain("body_size_unsupported");
});
test("invalid base64url body characters refuse the record", () => {
    refuse(message({ mimeType: "text/plain", body: { data: "not+base64url/" } }), "source_schema");
    refuse(message({ mimeType: "text/plain", body: { data: "a b" } }), "source_schema");
});
test("decoded bytes that are not utf-8 are malformed", () => {
    refuse(message({ mimeType: "text/plain", body: { data: b64(new Uint8Array([0xff, 0xfe, 0x41])) } }), "malformed_record");
});
test("mime nesting deeper than eight levels is malformed", () => {
    const nest = (levels: number): Record<string, unknown> => levels === 0 ? plain("leaf") : { mimeType: "multipart/mixed", parts: [nest(levels - 1)] };
    expect(emit(message(nest(8))).text).toBe("leaf");
    refuse(message(nest(9)), "malformed_record");
});
test("more than 128 mime nodes refuse", () => {
    const wide = (count: number) => ({ mimeType: "multipart/mixed", parts: Array.from({ length: count }, (_, n) => plain(`p${n}`)) });
    expect(emit(message(wide(127))).text.split("\n")).toHaveLength(127);
    refuse(message(wide(128)), "malformed_record");
    refuse(message(wide(129)), "source_schema");
});
test("participants are capped at 64 distinct subjects and truncation is reported", () => {
    const addresses = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => `${prefix}${n}@example.test`).join(", ");
    const event = emit(message(plain("hi", { headers: [{ name: "From", value: "sender@example.test" }, { name: "To", value: addresses("to", 40) }, { name: "Cc", value: addresses("cc", 30) }] })));
    expect(event.subjects).toHaveLength(64);
    expect(new Set(event.subjects.map(s => s.subject_id)).size).toBe(64);
    expect(event.subjects[0]).toEqual({ subject_id: "email:sender@example.test", role: "from" });
    expect(event.metadata.body_coverage).toContain("participants_truncated");
    expect(emit(message(plain("hi", { headers: [{ name: "To", value: addresses("to", 64) }] }))).metadata.body_coverage).not.toContain("participants_truncated");
});
test("attachment parts become references only and never contribute body text", () => {
    const event = emit(message({ mimeType: "multipart/mixed", parts: [
            plain("visible body"),
            { partId: "1", mimeType: "Application/PDF", filename: "report.pdf", body: { attachmentId: "att-1", size: 1234, data: b64("ATTACHMENT_SENTINEL") } },
            { partId: "2", mimeType: "text/plain", filename: "notes.txt", body: { data: b64("INLINE_SENTINEL") } },
        ] }));
    expect(event.text).toBe("visible body");
    expect(event.attachments).toEqual([
        { attachment_id: "att-1", media_type: "application/pdf", filename: "report.pdf", byte_size: 1234 },
        { attachment_id: "part:2", media_type: "text/plain", filename: "notes.txt" },
    ]);
    expect(event.metadata.body_coverage).toEqual(["attachment_body_unsupported", "mime_projection_limited_depth_8"]);
    expect(JSON.stringify(event)).not.toContain("_SENTINEL");
    expect(event.metadata.attachments_downloaded).toBe(false);
});
test("labels are bounded, deduplicated and sorted", () => {
    refuse(message(plain("ok"), { labelIds: Array.from({ length: 257 }, (_, n) => `L${n}`) }), "source_schema");
    const event = emit(message(plain("ok"), { labelIds: ["UNREAD", "INBOX", "UNREAD", "CATEGORY_PERSONAL", "INBOX"] }));
    expect(event.metadata.labels).toEqual(["CATEGORY_PERSONAL", "INBOX", "UNREAD"]);
    expect(emit(message(plain("ok"), { labelIds: ["INBOX"] }), ["text"]).metadata.labels).toBeUndefined();
});
test("unselected text reports body_not_selected and no other coverage marker", () => {
    const event = emit(message({ mimeType: "text/html", body: { data: b64("<b>HTML_SENTINEL</b>") } }), ["headers", "labels"]);
    expect(event.text).toBe("");
    expect(event.metadata.body_coverage).toEqual(["body_not_selected"]);
    expect(JSON.stringify(event)).not.toContain("HTML_SENTINEL");
});
test("an address repeated across To and Cc is one recipient subject", () => {
    const headers = [{ name: "From", value: "sender@example.test" }, { name: "To", value: "shared@example.test, other@example.test" }, { name: "Cc", value: "shared@example.test" }];
    const event = emit(message(plain("ok", { headers })));
    expect(event.subjects).toEqual([
        { subject_id: "email:sender@example.test", role: "from" },
        { subject_id: "email:shared@example.test", role: "to" },
        { subject_id: "email:other@example.test", role: "to" },
    ]);
});
