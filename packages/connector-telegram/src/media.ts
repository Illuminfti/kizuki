import type { TelegramAttachment } from "./api";

/** Media stays a reference: this connector never downloads a file. */
export function describeMedia(media: unknown): {
  attachment: TelegramAttachment | null;
  kind: string | null;
} {
  if (typeof media !== "object" || media === null) {
    return { attachment: null, kind: null };
  }
  const record = media as {
    className?: unknown;
    photo?: unknown;
    document?: unknown;
  };
  const className =
    typeof record.className === "string" ? record.className : null;
  const photoId = identifier(record.photo);
  if (photoId !== null) {
    return {
      attachment: { attachment_id: photoId, media_type: "image/jpeg" },
      kind: null,
    };
  }
  const document = record.document;
  const documentId = identifier(document);
  if (documentId !== null && typeof document === "object" && document !== null) {
    const file = document as {
      mimeType?: unknown;
      size?: unknown;
      attributes?: unknown;
    };
    const size = Number(file.size);
    const name = fileName(file.attributes);
    return {
      attachment: {
        attachment_id: documentId,
        media_type:
          typeof file.mimeType === "string" && file.mimeType.length > 0
            ? file.mimeType
            : "application/octet-stream",
        ...(name === null ? {} : { filename: name }),
        ...(Number.isSafeInteger(size) && size >= 0
          ? { byte_size: size }
          : {}),
      },
      kind: null,
    };
  }
  return { attachment: null, kind: className };
}

function identifier(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  if (id === undefined || id === null) return null;
  const text = String(id);
  return /^-?[0-9]+$/.test(text) ? text : null;
}

function fileName(attributes: unknown): string | null {
  if (!Array.isArray(attributes)) return null;
  for (const attribute of attributes) {
    if (typeof attribute !== "object" || attribute === null) continue;
    const named = attribute as { fileName?: unknown };
    if (typeof named.fileName === "string" && named.fileName.length > 0) {
      return named.fileName;
    }
  }
  return null;
}
