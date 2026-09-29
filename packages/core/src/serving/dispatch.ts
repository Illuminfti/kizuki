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
import { serveContextPacket } from "./packet";
import type { ContextPacketArgs } from "./packet";
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
import { projectEnvelope } from "./v2/envelope";

export interface DispatchOptions {
  /**
   * The serving contract the adapter chose, kept apart from the tool's own
   * arguments. Absent means the tool's default: v1 for every tool but
   * `world_view`, which has only v2. Anything else it cannot serve is
   * refused, audited, before any read.
   */
  readonly response_contract?: unknown;
}

async function serveV1(
  ctx: ServeContext,
  tool: Exclude<Tool, "world_view">,
  args: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  switch (tool) {
    case "search":
      return serveSearch(ctx, args as unknown as SearchArgs);
    case "get_page":
      return serveGetPage(ctx, args as unknown as GetPageArgs);
    case "query_entities":
      return serveEntities(ctx, args as unknown as EntitiesArgs);
    case "timeline":
      return serveTimeline(ctx, args as unknown as TimelineArgs);
    case "context_packet":
      return serveContextPacket(ctx, args as unknown as ContextPacketArgs);
    case "graph_neighbors":
      return await serveGraph(ctx, args as unknown as GraphArgs);
    case "system_health":
      return serveHealth(ctx);
    case "propose":
      return await servePropose(ctx, args as unknown as ProposeArgs);
    case "correct":
      return await serveCorrect(ctx, args as unknown as CorrectArgs);
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
  if (contract === ENVELOPE_V2_SCHEMA) return projectEnvelope(ctx, await serveV1(ctx, tool, args));
  return serveV1(ctx, tool, args);
}
