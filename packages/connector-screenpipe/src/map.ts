import type {
  AttachmentRef,
  CaptureEventInput,
  SubjectRef,
} from "@kizuki/core";
import { SCREENPIPE_CONNECTOR_ID } from "./config";
import {
  MAX_FILENAME_CHARS,
  MAX_METADATA_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_CHARS,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import type { FrameRow, TranscriptionRow } from "./read";
import { cutText } from "./text";
import { normalizeTimestamp, offsetSeconds } from "./time";

const SLUG_CHARS = 64;

/**
 * Characters that carry a name's identity. Separators and punctuation do not:
 * two names that differ only in spacing are the same app. A letter, digit or
 * mark does, so a name the ASCII reduction drops one of needs a fingerprint or
 * two unrelated names collapse into one subject.
 */
const IDENTIFYING = /[\p{L}\p{N}\p{M}]/u;

export function slug(name: string): string {
  const folded = fold(name);
  const reduced = reduce(folded);
  // A name written outside the ASCII subset — Chinese, Japanese, Cyrillic,
  // Greek, Arabic — reduces to separators and would emit no subject at all,
  // and one written partly outside it would share a subject with every other
  // name that reduces the same way.
  if (IDENTIFYING.test(folded.replace(/[a-z0-9._-]+/g, ""))) {
    return withFingerprint(reduced, folded);
  }
  // Cutting alone would collapse two long names that share a prefix into one
  // subject id: unrelated sites would become one entity and a purge plan for
  // either would list the other's frames. The fingerprint keeps them apart.
  return reduced.length <= SLUG_CHARS
    ? reduced
    : withFingerprint(reduced, reduced);
}

/**
 * The segment a site subject id carries. A host is a machine identifier, so any
 * character the reduction changes is identity: an address literal's colons and
 * brackets cannot reach a subject id, and slugging alone maps `[::1]` and
 * `[1::]` onto the same digit. An ordinary hostname passes through unchanged.
 */
export function hostSlug(host: string): string {
  const reduced = reduce(host);
  return reduced === host && reduced.length <= SLUG_CHARS
    ? reduced
    : withFingerprint(reduced, host);
}

function fold(name: string): string {
  return name.slice(0, MAX_SUBJECT_CHARS).normalize("NFKC").toLowerCase();
}

function reduce(folded: string): string {
  return folded.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function withFingerprint(head: string, source: string): string {
  const digest = fingerprint(source);
  const cut = head
    .slice(0, SLUG_CHARS - digest.length - 1)
    .replace(/[-._]+$/g, "");
  // A name that reduces to nothing leaves the fingerprint as the whole segment;
  // the prefix keeps it from reading as a name of its own.
  return cut.length > 0 ? `${cut}-${digest}` : `x-${digest}`;
}

/** FNV-1a over the folded name; a short, stable tail, not a checksum. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

export function siteHost(browserUrl: string | null): string | null {
  if (browserUrl === null) return null;
  try {
    const parsed = new URL(browserUrl.slice(0, MAX_SUBJECT_CHARS));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

export function mapFrame(
  row: FrameRow,
  observedAt: string,
): CaptureEventInput {
  const occurredAt = requiredTimestamp(row.timestamp, "frame");
  const text = requiredFrameText(row.full_text);
  const truncated = text.length > MAX_TEXT_CHARS;
  const subjects: SubjectRef[] = [];
  if (row.app_name !== null && row.app_name.length > 0) {
    const appSlug = slug(row.app_name);
    if (appSlug.length > 0) {
      subjects.push({
        subject_id: `screenpipe:app:${appSlug}`,
        role: "about",
        display_name: cutText(row.app_name, MAX_SUBJECT_CHARS),
      });
    }
  }
  const host = siteHost(row.browser_url);
  if (host !== null) {
    // Staging reads an entity handle from the segment after the last colon, so
    // an address host has to reach the subject id without colons of its own.
    const segment = hostSlug(host);
    if (segment.length > 0) {
      subjects.push({
        subject_id: `screenpipe:site:${segment}`,
        role: "about",
        display_name: host,
      });
    }
  }

  return {
    schema: "kizuki.event/v1",
    connector_id: SCREENPIPE_CONNECTOR_ID,
    source_record_id: `frame:${row.id}`,
    kind: "screen_text",
    occurred_at: occurredAt,
    observed_at: observedAt,
    text: truncated ? cutText(text, MAX_TEXT_CHARS) : text,
    subjects,
    sensitivity_hint: "private",
    deleted: false,
    attachments: snapshotAttachments(row.snapshot_path),
    metadata: {
      frame_id: row.id,
      device_name: cutMetadata(row.device_name),
      app_name: cutMetadata(row.app_name),
      window_name: cutMetadata(row.window_name),
      browser_url: cutMetadata(row.browser_url),
      document_path: cutMetadata(row.document_path),
      focused: row.focused,
      capture_trigger: cutMetadata(row.capture_trigger),
      text_source: cutMetadata(row.text_source),
      video_chunk_id: row.video_chunk_id,
      offset_index: row.offset_index,
      text_truncated: truncated,
      metadata_truncated: anyCut([
        row.device_name,
        row.app_name,
        row.window_name,
        row.browser_url,
        row.document_path,
        row.capture_trigger,
        row.text_source,
        row.snapshot_path,
      ]),
    },
  };
}

export function mapTranscription(
  row: TranscriptionRow,
  observedAt: string,
): CaptureEventInput {
  const base = requiredTimestamp(row.timestamp, "transcription");
  const truncated = row.transcription.length > MAX_TEXT_CHARS;
  const subjects: SubjectRef[] = [];
  if (row.speaker_id !== null) {
    subjects.push({
      subject_id: `screenpipe:speaker:${row.speaker_id}`,
      role: "from",
      ...(row.speaker_name !== null
        ? { display_name: cutText(row.speaker_name, MAX_SUBJECT_CHARS) }
        : {}),
    });
  }
  if (row.device.length > 0) {
    const deviceSlug = slug(row.device);
    if (deviceSlug.length > 0) {
      subjects.push({
        subject_id: `screenpipe:audio-device:${deviceSlug}`,
        role: "about",
        display_name: cutText(row.device, MAX_SUBJECT_CHARS),
      });
    }
  }

  return {
    schema: "kizuki.event/v1",
    connector_id: SCREENPIPE_CONNECTOR_ID,
    source_record_id: `transcription:${row.id}`,
    kind: "audio_transcription",
    occurred_at: offsetSeconds(base, row.start_time),
    observed_at: observedAt,
    text: truncated
      ? cutText(row.transcription, MAX_TEXT_CHARS)
      : row.transcription,
    subjects,
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {
      transcription_id: row.id,
      audio_chunk_id: row.audio_chunk_id,
      offset_index: row.offset_index,
      device: cutMetadata(row.device),
      is_input_device: row.is_input_device,
      transcription_engine: cutMetadata(row.transcription_engine),
      start_time: row.start_time,
      end_time: row.end_time,
      speaker_id: row.speaker_id,
      text_truncated: truncated,
      metadata_truncated: anyCut([row.device, row.transcription_engine]),
    },
  };
}

function snapshotAttachments(snapshotPath: string | null): AttachmentRef[] {
  if (snapshotPath === null || snapshotPath.length === 0) return [];
  // A database copied from another platform carries that platform's separator,
  // which the host's basename does not split on, so the whole captured path
  // would travel as the filename.
  const cut = Math.max(
    snapshotPath.lastIndexOf("/"),
    snapshotPath.lastIndexOf("\\"),
  );
  const filename = snapshotPath.slice(cut + 1);
  // A path the read had to cut has no last component left to read, and a name
  // no filesystem could hold is not one either. The reference stands either
  // way: what it points at is the row, not the name.
  const named =
    snapshotPath.length <= MAX_METADATA_CHARS &&
    filename.length > 0 &&
    filename.length <= MAX_FILENAME_CHARS;
  return [
    {
      attachment_id: "snapshot",
      media_type: "image/jpeg",
      ...(named ? { filename } : {}),
    },
  ];
}

/**
 * Metadata is provider-controlled and travels with every event, so it is cut
 * to its own bound rather than the text bound: one batch's non-text payload
 * has to stay a constant, not five hundred times the largest window title an
 * application can set.
 */
function cutMetadata(value: string | null): string | null {
  return value === null ? null : cutText(value, MAX_METADATA_CHARS);
}

function anyCut(values: readonly (string | null)[]): boolean {
  return values.some(
    (value) => value !== null && value.length > MAX_METADATA_CHARS,
  );
}

function requiredTimestamp(raw: string | null, rowKind: string): string {
  const timestamp = normalizeTimestamp(raw);
  if (timestamp === null) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      `kizuki.screenpipe: ${rowKind} timestamp is invalid`,
    );
  }
  return timestamp;
}

function requiredFrameText(text: string | null): string {
  if (text === null) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: frame text is unavailable",
    );
  }
  return text;
}
