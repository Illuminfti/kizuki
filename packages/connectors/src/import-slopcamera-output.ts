import { isPlainObject, isRfc3339, validateEventInput, type CaptureEventInput } from "@kizuki/core";
import { encodeSourceRecordId, sha256Hex } from "./source-id";

/** Pinned hraness/slopcamera output-reference admission. Not a dependency and not a render. */
export const SLOPCAMERA_OUTPUT_PIN = Object.freeze({
  repository: "hraness/slopcamera",
  commit: "305151a9b3c039d0a41e4efd635b1f4569082e75",
  receiptsBlob: "04348be9b679a99751ce79efbbb3d0a70ab7d894",
  projectBlob: "62164f57eefd75d101e16401934a90a5681a8a78",
  projectRenderBlob: "6dba16087a681f0c69d030665c153ab63b499747",
  recordingBlob: "b85f336b2b3a451c3a3244e70f4f701b21a6a894",
  contract: "slopcamera.project-render-output-reference",
  schemaVersion: 1,
});

/** Draft identity only. Not registered, not a command, and not ingress. */
export const SLOPCAMERA_OUTPUT_CONNECTOR_ID = "kizuki.import-slopcamera-output";
export const SLOPCAMERA_OUTPUT_CONSENT = "owner-selected-local-file";
export const MAX_SLOPCAMERA_OUTPUT_BYTES = 64 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const PROJECT_SUFFIX = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const KINDS = new Set([
  "slopcamera.project-render-output-reference",
  "studio.project-render-output-reference",
]);
const KEYS = [
  "bytes",
  "kind",
  "path",
  "planArtifactSha256",
  "projectId",
  "revisionSha256",
  "schemaVersion",
  "sha256",
];
const RESERVED = new Set([
  ".filter-graphs",
  ".overlay-cache",
  ".staging",
  "caption-assets",
  "plans",
  "receipts",
]);
const NOTE_KEYS = ["author", "rationale", "outputSha256"];

export type SlopcameraOutputCode =
  | "ok"
  | "referenced_bytes_unavailable"
  | "consent_required"
  | "invalid_observation"
  | "byte_limit"
  | "bound_exceeded"
  | "invalid_json"
  | "not_object"
  | "unsupported_contract"
  | "unsupported_field"
  | "invalid_digest"
  | "invalid_path"
  | "invalid_record"
  | "note_unbound"
  | "digest_mismatch"
  | "unexpected_reference";

export type SlopcameraOutputNote = {
  author: "owner" | "agent";
  rationale: string;
  outputSha256: string;
};

export type SlopcameraOutputParse =
  | {
      status: "normalized" | "partial";
      code: "ok" | "referenced_bytes_unavailable";
      event: CaptureEventInput;
      missingDigests: readonly string[];
    }
  | { status: "refused"; code: Exclude<SlopcameraOutputCode, "ok" | "referenced_bytes_unavailable">; reason: string };

type Refusal = Extract<SlopcameraOutputParse, { status: "refused" }>;

function refused(code: Refusal["code"], reason: string): Refusal {
  return { status: "refused", code, reason };
}

function digest(value: unknown): string | Refusal {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    return refused("invalid_digest", "content address must be 64 lowercase hex digits");
  }
  return value;
}

function safePath(value: unknown): string | Refusal {
  if (typeof value !== "string") return refused("invalid_path", "output path must be a string");
  if (
    value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^[a-zA-Z]:/u.test(value)
    || value.includes("\\")
    || value.includes("\0")
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return refused("invalid_path", "output path is not a bounded repository-relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return refused("invalid_path", "output path is not a bounded repository-relative path");
  }
  const leaf = parts.at(-1) ?? "";
  if (
    parts[0] !== "renders"
    || parts.length < 2
    || RESERVED.has((parts[1] ?? "").toLowerCase())
    || leaf.toLowerCase() === ".mp4"
    || !leaf.endsWith(".mp4")
  ) {
    return refused("invalid_path", "output path is outside the pinned renders/*.mp4 rule");
  }
  return value;
}

function noteOf(value: unknown, outputSha256: string): SlopcameraOutputNote | Refusal {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => NOTE_KEYS.includes(key))) {
    return refused("unsupported_field", "note has a field outside the pinned evidence shape");
  }
  if (value["author"] !== "owner" && value["author"] !== "agent") {
    return refused("invalid_record", "note author must be owner or agent");
  }
  const rationale = value["rationale"];
  if (typeof rationale !== "string" || rationale.length < 1 || rationale.length > 8192) {
    return refused("invalid_record", "note rationale is outside the pinned bound");
  }
  const bound = digest(value["outputSha256"]);
  if (typeof bound !== "string") return bound;
  if (bound !== outputSha256) return refused("note_unbound", "note digest is not this output");
  return { author: value["author"], rationale, outputSha256: bound };
}

/**
 * Parse one owner-selected slopcamera.project-render-output-reference.
 * The caller passes bytes. This function does not open paths, retrieve URLs,
 * or run imported project source.
 */
export function parseSlopcameraRenderOutput(
  source: string,
  input: {
    observedAt: string;
    consent?: string;
    referencedBytes?: Readonly<Record<string, string>>;
    note?: SlopcameraOutputNote;
  },
): SlopcameraOutputParse {
  if (input.consent !== SLOPCAMERA_OUTPUT_CONSENT) {
    return refused("consent_required", "explicit owner-selected local file consent is required");
  }
  if (!isRfc3339(input.observedAt)) return refused("invalid_observation", "observedAt must be RFC3339");
  if (Buffer.byteLength(source, "utf8") > MAX_SLOPCAMERA_OUTPUT_BYTES) {
    return refused("byte_limit", "output reference exceeds the adapter byte limit");
  }
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return refused("invalid_json", "output reference is not one JSON value"); }
  if (!isPlainObject(raw)) return refused("not_object", "output reference must be one JSON object");
  const keys = Object.keys(raw);
  if (keys.length > KEYS.length || keys.some((key) => !KEYS.includes(key))) {
    return refused("unsupported_field", "output reference has a field outside the pinned profile");
  }
  if (KEYS.some((key) => !keys.includes(key))) return refused("invalid_record", "output reference is missing a pinned field");
  if (typeof raw["kind"] !== "string" || !KINDS.has(raw["kind"]) || raw["schemaVersion"] !== 1) {
    return refused("unsupported_contract", "only the pinned output-reference schema is admitted");
  }
  const outputSha256 = digest(raw["sha256"]);
  if (typeof outputSha256 !== "string") return outputSha256;
  const planSha256 = digest(raw["planArtifactSha256"]);
  if (typeof planSha256 !== "string") return planSha256;
  const revisionSha256 = digest(raw["revisionSha256"]);
  if (typeof revisionSha256 !== "string") return revisionSha256;
  const path = safePath(raw["path"]);
  if (typeof path !== "string") return path;
  const projectId = raw["projectId"];
  if (typeof projectId !== "string" || !projectId.startsWith("project_") || !PROJECT_SUFFIX.test(projectId.slice("project_".length))) {
    return refused("invalid_record", "project id is outside the pinned shape");
  }
  const bytes = raw["bytes"];
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return refused("invalid_record", "claimed byte count is not a positive safe integer");
  }
  const note = input.note === undefined ? undefined : noteOf(input.note, outputSha256);
  if (note && "status" in note) return note;

  const refs = [planSha256, revisionSha256, outputSha256];
  const supplied = input.referencedBytes;
  if (supplied !== undefined && !isPlainObject(supplied)) {
    return refused("invalid_record", "referenced bytes must be a record of digest to text");
  }
  const have = new Set<string>();
  if (supplied !== undefined) {
    for (const [key, body] of Object.entries(supplied)) {
      if (!DIGEST.test(key) || !refs.includes(key)) {
        return refused("unexpected_reference", "referenced bytes name a digest this output does not use");
      }
      if (typeof body !== "string") return refused("invalid_record", "referenced bytes must be text");
      if (sha256Hex(body) !== key) return refused("digest_mismatch", "supplied bytes do not match the content address");
      have.add(key);
    }
  }
  const missingDigests = refs.filter((ref) => !have.has(ref));
  const partial = missingDigests.length > 0;
  const draft: CaptureEventInput = {
    schema: "kizuki.event/v1",
    connector_id: SLOPCAMERA_OUTPUT_CONNECTOR_ID,
    source_record_id: encodeSourceRecordId(["slopcamera.project-render-output-reference", outputSha256]),
    kind: "file",
    occurred_at: input.observedAt,
    observed_at: input.observedAt,
    text: [
      partial
        ? "Slopcamera render output reference (unverified, path not opened, bytes not retrieved):"
        : "Slopcamera render output reference (unverified, path not opened, referenced bytes supplied):",
      `project ${projectId}`,
      `output ${outputSha256}`,
      `revision ${revisionSha256}`,
      "source clock absent; occurred_at is the observation time",
      "acceptance absent; a digest is not approval",
    ].join("\n"),
    subjects: [],
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {
      slopcamera: {
        schema: "kizuki.slopcamera-output-import/v1",
        pin: SLOPCAMERA_OUTPUT_PIN,
        reference: {
          kind: raw["kind"],
          path,
          projectId,
          outputSha256,
          revisionSha256,
          planArtifactSha256: planSha256,
          claimedBytes: bytes,
          mediaType: "video/mp4",
        },
        ...(note === undefined
          ? {}
          : {
              note: {
                author: note.author,
                role: note.author === "owner" ? "owner-note" : "agent-interpretation",
                rationale: note.rationale,
                bound_output_sha256: note.outputSha256,
                acceptance: "absent",
              },
            }),
        coverage: {
          referenced_bytes: partial ? "unavailable" : "supplied",
          missing_digests: missingDigests,
          path_opened: false,
          retrieved: false,
          executed: false,
          media_type_basis: "pinned_mp4_suffix",
          time_region: "unsupported_on_pin",
          acceptance: "absent",
          source_clock: "absent",
        },
      },
    },
  };
  const event = validateEventInput(draft);
  if (!event.ok) return refused("invalid_record", "output reference does not fit kizuki.event/v1");
  return partial
    ? { status: "partial", code: "referenced_bytes_unavailable", event: event.value, missingDigests }
    : { status: "normalized", code: "ok", event: event.value, missingDigests };
}
