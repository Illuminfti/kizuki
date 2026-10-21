import { isWorldWireToken, type ArtifactCard } from "@kizuki/core/world";
import { clean } from "../../../output";
import { discoverCli } from "./discover";
import { relationLines } from "./relation-render";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, coverageLine, temporalInput } from "./shared";
import type { WorldCliOp } from "./types";
export const artifactCli: WorldCliOp<ArtifactCard> = {
  usage: "--ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--share]",
  options: ["--ref", ...KNOWN_OPTIONS], bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url artifact version token" },
  buildInput: options => { const token = options.get("--ref"), when = temporalInput(options); return token === undefined || !isWorldWireToken(token) || when === null ? null : { artifact: { kind: "object", token }, ...when }; },
  render: data => [clean(data.artifact.labels.map(label => label.text).join(" / ")) || "Artifact version",
    `SHA-256: ${data.content.sha256 ?? "unknown"}`, `Media type: ${clean(data.content.mediaType ?? "unknown")}`, `Bytes: ${data.content.byteLength ?? "unknown"}`,
    `Original: ${data.original.status}. Kizuki does not provide or visually inspect the original.`,
    ...(data.versionOf === null ? [] : relationLines(data.versionOf, "Version of")),
    ...data.inspections.flatMap(row => relationLines(row, "Attributed feedback")), coverageLine(data.coverage)],
};
export const findArtifactsCli: typeof discoverCli = { ...discoverCli, notice: () => null };
