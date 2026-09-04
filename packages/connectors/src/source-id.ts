/**
 * Length-prefixed source identities. Concatenating with '/' lets
 * `conversation-1/node` + `a` collide with `conversation-1` + `node/a`.
 * The encoding is `v1:<arity>:<len>:<part>…` so a slash is just another
 * character and a missing part cannot steal a neighbour's prefix.
 */
export const SOURCE_RECORD_ID_VERSION = "v1" as const;

export function encodeSourceRecordId(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new TypeError("encodeSourceRecordId: at least one part is required");
  }
  const body = parts.map((part) => `${part.length}:${part}`).join(":");
  return `${SOURCE_RECORD_ID_VERSION}:${parts.length}:${body}`;
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Stable stand-in when the export omitted an id. The digest is content, not
 * position: reordering the same records must not mint a new identity.
 */
export function fallbackSourcePart(
  kind: string,
  material: readonly string[],
): string {
  return `missing:${kind}:${sha256Hex(material.join("\n")).slice(0, 16)}`;
}

export function recordContentHash(material: {
  text: string;
  occurred_at: string;
  deleted: boolean;
  attachments: readonly { attachment_id: string; media_type: string }[];
}): string {
  return sha256Hex(
    JSON.stringify({
      attachments: material.attachments.map((attachment) => [
        attachment.attachment_id,
        attachment.media_type,
      ]),
      deleted: material.deleted,
      occurred_at: material.occurred_at,
      text: material.text,
    }),
  );
}
