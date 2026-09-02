import { expect, test } from "bun:test";
import { describeMedia } from "../src/media";

/** big-integer values arrive as objects that only become numbers on demand. */
function big(value: string): { valueOf(): number; toString(): string } {
  return { valueOf: () => Number(value), toString: () => value };
}

test("a photo becomes a jpeg reference with no filename or size", () => {
  const described = describeMedia({
    className: "MessageMediaPhoto",
    photo: { className: "Photo", id: big("7001") },
  });
  expect(described).toEqual({
    attachment: { attachment_id: "7001", media_type: "image/jpeg" },
    kind: null,
  });
});

test("a document keeps its own mime type, filename and size", () => {
  const described = describeMedia({
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      id: big("5001"),
      mimeType: "application/pdf",
      size: big("2048"),
      attributes: [
        { className: "DocumentAttributeFilename", fileName: "agenda.pdf" },
      ],
    },
  });
  expect(described.attachment).toEqual({
    attachment_id: "5001",
    media_type: "application/pdf",
    filename: "agenda.pdf",
    byte_size: 2048,
  });
  expect(described.kind).toBeNull();
});

test("a document with nothing to go on falls back to opaque bytes", () => {
  const described = describeMedia({
    className: "MessageMediaDocument",
    document: { className: "Document", id: big("5002"), attributes: [] },
  });
  expect(described.attachment).toEqual({
    attachment_id: "5002",
    media_type: "application/octet-stream",
  });
});

test("a filename is taken from whichever attribute carries one", () => {
  const described = describeMedia({
    document: {
      id: 5003,
      mimeType: "video/mp4",
      attributes: [
        null,
        "not an attribute",
        { className: "DocumentAttributeVideo", duration: 3 },
        { fileName: "" },
        { fileName: "clip.mp4" },
        { fileName: "later.mp4" },
      ],
    },
  });
  expect(described.attachment?.filename).toBe("clip.mp4");
});

test("a size that is not a plain count is left out rather than guessed", () => {
  for (const size of [
    undefined,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 2,
    "many",
    { nothing: true },
  ]) {
    const described = describeMedia({
      document: { id: 5004, mimeType: "image/png", size },
    });
    expect(described.attachment).toEqual({
      attachment_id: "5004",
      media_type: "image/png",
    });
  }
});

test("media this connector cannot reference is named, not invented", () => {
  for (const className of [
    "MessageMediaPoll",
    "MessageMediaGeo",
    "MessageMediaContact",
    "MessageMediaWebPage",
  ]) {
    expect(describeMedia({ className })).toEqual({
      attachment: null,
      kind: className,
    });
  }
});

test("a payload that is not media at all describes nothing", () => {
  for (const media of [
    undefined,
    null,
    "MessageMediaPhoto",
    42,
    [],
    {},
    { className: 7 },
    { photo: null },
    { photo: {} },
    { photo: { id: "not-a-number" } },
    { document: { id: {} } },
  ]) {
    const described = describeMedia(media);
    expect(described.attachment).toBeNull();
  }
});

test("an empty document is reported as its class rather than a broken reference", () => {
  expect(
    describeMedia({ className: "MessageMediaDocument", document: { id: null } }),
  ).toEqual({ attachment: null, kind: "MessageMediaDocument" });
});
