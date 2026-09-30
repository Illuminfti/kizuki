import type { Tool } from "../agents";
import { serveCorrect } from "./correct";
import type { CorrectArgs } from "./correct";
import { serveEntities } from "./entities";
import type { EntitiesArgs } from "./entities";
import { serveGraph } from "./graph";
import type { GraphArgs } from "./graph";
import { serveHealth } from "./health";
import { serveGetPage } from "./page";
import type { GetPageArgs } from "./page";
import { serveContextPacket, serveContextPacketV2 } from "./packet";
import type { ContextPacketArgs } from "./packet";
import type { ContextPacketArgsV2 } from "./v2/context-packet";
import { servePropose } from "./propose";
import type { ProposeArgs } from "./propose";
import { serveSearch } from "./search";
import type { SearchArgs } from "./search";
import { serveTimeline } from "./timeline";
import type { TimelineArgs } from "./timeline";
import type { WorldViewEnvelope } from "./world-view";
import { serveWorldView } from "./world-view";
import { chooseContract, unsupportedContract } from "./contract";
import { refuseCall } from "./gate";
import { ENVELOPE_V2_SCHEMA, ServeError } from "./types";
import type { Envelope, EnvelopeV2, ServeContext } from "./types";
import type { ResponseContract } from "./types";

export interface DispatchOptions {
  /**
   * The serving contract the adapter chose, kept apart from the tool's own
   * arguments. Absent means the tool's default: v1 for every tool but
   * `world_view`, which has only v2. Anything else it cannot serve is
   * refused, audited, before any read.
   */
  readonly response_contract?: unknown;
}

function serveSelected(
  ctx: ServeContext,
  tool: Exclude<Tool, "world_view">,
  args: Record<string, unknown>,
  contract: ResponseContract,
): Envelope<unknown> | EnvelopeV2 | Promise<Envelope<unknown> | EnvelopeV2> {
  switch (tool) {
    case "search":
      return serveSearch(ctx, args as unknown as SearchArgs, contract);
    case "get_page":
      return serveGetPage(ctx, args as unknown as GetPageArgs, contract);
    case "query_entities":
      return serveEntities(ctx, args as unknown as EntitiesArgs, contract);
    case "timeline":
      return serveTimeline(ctx, args as unknown as TimelineArgs, contract);
    case "context_packet":
      return serveContextPacket(ctx, args as unknown as ContextPacketArgs);
    case "graph_neighbors":
      return serveGraph(ctx, args as unknown as GraphArgs, contract);
    case "system_health":
      return serveHealth(ctx, contract);
    case "propose":
      return servePropose(ctx, args as unknown as ProposeArgs, contract);
    case "correct":
      return serveCorrect(ctx, args as unknown as CorrectArgs, contract);
    default: {
      const _exhaustive: never = tool;
      throw new ServeError("error", "serving failed");
    }
  }
}

/**
 * One routing table for every serve host (stdio MCP and loopback HTTP).
 * Policy stays in the `serve*` functions; hosts only translate transport.
 */
export async function dispatchServeTool(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  options: DispatchOptions = {},
): Promise<Envelope<unknown> | EnvelopeV2 | WorldViewEnvelope> {
  const contract = chooseContract(tool, options.response_contract, args);
  if (contract === null) return refuseCall(ctx, tool, args, unsupportedContract());
  if (tool === "world_view") return serveWorldView(ctx, args);
  if (tool === "context_packet" && contract === ENVELOPE_V2_SCHEMA)
    return serveContextPacketV2(ctx, args as unknown as ContextPacketArgsV2);
  return serveSelected(ctx, tool, args, contract);
}
