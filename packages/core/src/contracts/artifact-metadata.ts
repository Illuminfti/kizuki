import { isPlainObject } from "../util/validate";
export const ARTIFACT_METADATA_PREDICATES = ["artifact.content_sha256", "artifact.media_type", "artifact.byte_length"] as const;
export const artifactSubjectId = (sha256: string): string => `artifact:sha256:${sha256}`;
/** Connector-mapped facts, never an extraction response. No original bytes or path is retained here. */
export interface ArtifactMetadata {
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly versionOf: string | null;
  readonly original: "external" | "unavailable";
}
export function parseArtifactMetadata(value: unknown): ArtifactMetadata | null {
  if (!isPlainObject(value) || Object.keys(value).some(key => !["sha256", "mediaType", "byteLength", "versionOf", "original"].includes(key)) ||
    typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.mediaType !== "string" || value.mediaType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType) ||
    !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0 ||
    !(value.versionOf === null || typeof value.versionOf === "string" && value.versionOf.length > 0 && value.versionOf.length <= 256) ||
    !["external", "unavailable"].includes(String(value.original)))
    return null;
  return value as unknown as ArtifactMetadata;
}
