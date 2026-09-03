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
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

/**
 * One routing table for every serve host (stdio MCP and loopback HTTP).
 * Policy stays in the `serve*` functions; hosts only translate transport.
 */
export async function dispatchServeTool(
  ctx: ServeContext,
  tool: Tool,
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
      return serveGraph(ctx, args as unknown as GraphArgs);
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
