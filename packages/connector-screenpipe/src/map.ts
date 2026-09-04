import path from "node:path";
import type {
  CaptureEventInput,
  SubjectRef,
} from "@kizuki/core";
import { SCREENPIPE_CONNECTOR_ID } from "./config";
import { MAX_TEXT_CHARS } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import type { FrameRow, TranscriptionRow } from "./read";
import { resolveTimestamp, offsetSeconds } from "./time";
import { redactBrowserUrl } from "./url";

export interface MapOptions {
  occurredAt?: string;
  timeZone?: string | null;
  retainFullUrls?: boolean;
}

export function slug(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function siteHost(browserUrl: string | null): string | null {
  if (browserUrl === null) return null;
  try {
    const parsed = new URL(browserUrl);
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
  options: MapOptions = {},
): CaptureEventInput {
  const occurredAt =
    options.occurredAt ??
    requiredTimestamp(row.timestamp, "frame", options.timeZone ?? null);
  const text = requiredFrameText(row.full_text);
  const browserUrl = redactBrowserUrl(
    row.browser_url,
    options.retainFullUrls === true,
  );
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
  const host = siteHost(browserUrl ?? row.browser_url);
  if (host !== null) {
    subjects.push({
      subject_id: `screenpipe:site:${host}`,
      role: "about",
      display_name: host,
    });
  }

  const snapshot = row.snapshot_path;
  return {
    schema: "kizuki.event/v1",
    connector_id: SCREENPIPE_CONNECTOR_ID,
    source_record_id: `frame:${row.id}`,
    kind: "screen_text",
    occurred_at: occurredAt,
    observed_at: observedAt,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
    subjects,
    sensitivity_hint: "private",
    deleted: false,
    attachments:
      snapshot !== null && snapshot.length > 0
        ? [
            {
              attachment_id: "snapshot",
              media_type: "image/jpeg",
              filename: path.basename(snapshot),
            },
          ]
        : [],
    metadata: {
      frame_id: row.id,
      device_name: row.device_name,
      app_name: row.app_name,
      window_name: row.window_name,
      browser_url: browserUrl,
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
  options: MapOptions = {},
): CaptureEventInput {
  const base =
    options.occurredAt ??
    requiredTimestamp(
      row.timestamp,
      "transcription",
      options.timeZone ?? null,
    );
  const occurredAt = offsetSeconds(base, row.start_time);
  if (occurredAt === null) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: transcription offset is invalid",
    );
  }
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
    occurred_at: occurredAt,
    observed_at: observedAt,
    text: truncated
      ? row.transcription.slice(0, MAX_TEXT_CHARS)
      : row.transcription,
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

function requiredTimestamp(
  raw: string,
  rowKind: string,
  timeZone: string | null,
): string {
  const resolved = resolveTimestamp(raw, timeZone);
  if ("reject" in resolved) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      `kizuki.screenpipe: ${rowKind} timestamp is ${resolved.reject === "offset_unknown" ? "offset-unknown" : "invalid"}`,
    );
  }
  return resolved.iso;
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
