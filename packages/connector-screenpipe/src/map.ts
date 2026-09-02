import type {
  AttachmentRef,
  CaptureEventInput,
  SubjectRef,
} from "@kizuki/core";
import { SCREENPIPE_CONNECTOR_ID } from "./config";
import { MAX_SUBJECT_CHARS, MAX_TEXT_CHARS } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import type { FrameRow, TranscriptionRow } from "./read";
import { normalizeTimestamp, offsetSeconds } from "./time";

const SLUG_CHARS = 64;

export function slug(name: string): string {
  const normalized = name
    .slice(0, MAX_SUBJECT_CHARS)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length <= SLUG_CHARS) return normalized;
  // Cutting alone would collapse two long names that share a prefix into one
  // subject id: unrelated sites would become one entity and a purge plan for
  // either would list the other's frames. The fingerprint keeps them apart.
  const digest = fingerprint(normalized);
  const head = normalized
    .slice(0, SLUG_CHARS - digest.length - 1)
    .replace(/[-._]+$/g, "");
  return `${head}-${digest}`;
}

/** FNV-1a over the normalized name; a short, stable tail, not a checksum. */
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
        display_name: row.app_name,
      });
    }
  }
  const host = siteHost(row.browser_url);
  if (host !== null) {
    // Staging reads an entity handle from the segment after the last colon, so
    // an address host has to reach the subject id without colons of its own.
    const hostSlug = slug(host);
    if (hostSlug.length > 0) {
      subjects.push({
        subject_id: `screenpipe:site:${hostSlug}`,
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
    text: truncated ? cutText(text) : text,
    subjects,
    sensitivity_hint: "private",
    deleted: false,
    attachments: snapshotAttachments(row.snapshot_path),
    metadata: {
      frame_id: row.id,
      device_name: row.device_name,
      app_name: row.app_name,
      window_name: row.window_name,
      browser_url: row.browser_url,
      document_path: row.document_path,
      focused: row.focused,
      capture_trigger: row.capture_trigger,
      text_source: row.text_source,
      video_chunk_id: row.video_chunk_id,
      offset_index: row.offset_index,
      text_truncated: truncated,
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
        ? { display_name: row.speaker_name }
        : {}),
    });
  }
  if (row.device.length > 0) {
    const deviceSlug = slug(row.device);
    if (deviceSlug.length > 0) {
      subjects.push({
        subject_id: `screenpipe:audio-device:${deviceSlug}`,
        role: "about",
        display_name: row.device,
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
    text: truncated ? cutText(row.transcription) : row.transcription,
    subjects,
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {
      transcription_id: row.id,
      audio_chunk_id: row.audio_chunk_id,
      offset_index: row.offset_index,
      device: row.device,
      is_input_device: row.is_input_device,
      transcription_engine: row.transcription_engine,
      start_time: row.start_time,
      end_time: row.end_time,
      speaker_id: row.speaker_id,
      text_truncated: truncated,
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
  return [
    {
      attachment_id: "snapshot",
      media_type: "image/jpeg",
      ...(filename.length > 0 ? { filename } : {}),
    },
  ];
}

function cutText(text: string): string {
  const cut = text.slice(0, MAX_TEXT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  // A cut between the halves of a surrogate pair leaves a lone surrogate,
  // which SQLite and a file write both replace on the way back out. The stored
  // text would then no longer match the content hash taken from this event.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function requiredTimestamp(raw: string, rowKind: string): string {
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
