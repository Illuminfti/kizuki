import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { CURRENT, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";

type Matches = Extract<WorldData, { matches: unknown }>;

const bounds = {
  "--label": "up to 200 characters",
  "--cursor": "32-byte base64url token from the previous page",
} as const;

export const discoverCli: WorldCliOp<Matches> = {
  usage: "[--label TEXT] [--cursor TOKEN]",
  options: ["--label", "--cursor"],
  bounds,
  buildInput: (options) => {
    const label = options.get("--label"),
      cursor = options.get("--cursor");
    if ((label?.length ?? 0) > 200 || (cursor !== undefined && !isWorldWireToken(cursor)))
      return null;
    return { label: label ?? "", ...(cursor === undefined ? {} : { cursor }), ...CURRENT };
  },
  render: (data) => [
    ...(data.matches.length === 0
      ? ["No admitted matches in your current scope."]
      : data.matches.map(
          (match) => `${clean(match.labels.join(" / ")) || "Unlabelled"}  ${match.ref.token}`,
        )),
    ...(data.coverage.status === "partial" ? [coverageLine(data.coverage)] : []),
    ...(data.cursor === null ? [] : [`More matches: --cursor ${data.cursor}`]),
  ],
  notice: (data) =>
    data.matches.length === 0
      ? "next: Concepts and Situations appear once the model loop admits them; kizuki doctor shows whether canon writing is on"
      : null,
};
