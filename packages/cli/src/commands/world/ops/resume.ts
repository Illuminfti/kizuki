import { isWorldWireToken } from "@kizuki/core/world";
import { CURRENT, coverageLine } from "./shared";
import { conceptCli } from "./concept";
import { situationCli } from "./situation";
import type { WorldCliOp } from "./types";

export const shareCli: WorldCliOp = {
  usage: "--of-operation concept|situation --ref TOKEN",
  options: ["--of-operation", "--ref"],
  bounds: { "--of-operation": "concept|situation", "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const operation = options.get("--of-operation"), token = options.get("--ref");
    if ((operation !== "concept" && operation !== "situation") || token === undefined || !isWorldWireToken(token)) return null;
    return { of: { operation, [operation]: { kind: "object", token } }, ...CURRENT };
  },
  render: (data) => [`Resume handle: ${String(data.handle)} (expires ${String(data.expiresAt)})`],
};

export const resumeCli: WorldCliOp = {
  usage: "--resume HANDLE [--prior-view TOKEN]", options: ["--resume"],
  bounds: { "--resume": "32-byte base64url resume handle" },
  buildInput: (options) => {
    const handle = options.get("--resume");
    return handle === undefined || !isWorldWireToken(handle) ? null : { handle, ...CURRENT };
  },
  render: (data) => data.schema === "kizuki.concept-card/v1"
    ? conceptCli.render(data as Parameters<typeof conceptCli.render>[0])
    : data.schema === "kizuki.situation-card/v1"
      ? situationCli.render(data as Parameters<typeof situationCli.render>[0])
      : [coverageLine(data.coverage as Parameters<typeof coverageLine>[0])],
};
