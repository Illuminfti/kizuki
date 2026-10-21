import type { Tool } from "../../packages/core/src/index";

/** Mutate a field inside each tool's grammar, as well as its raw container. */
export function wrappedArguments(tool: Tool, text: string): Record<string, unknown> {
  switch (tool) {
    case "search": return { query: text };
    case "get_page": return { id: text };
    case "query_entities": return { name: text };
    case "timeline": return { subject: text };
    case "context_packet": return { purpose: "recall", query: text, budget_tokens: 1000 };
    case "graph_neighbors": return { id: text };
    case "system_health": return {};
    case "world_view": return { operation: "find_concepts", label: text };
    case "propose": return { kind: "claim", body: text, provenance: ["00000000000000000000000000"] };
    case "correct": return { statement: text, target: { claim_id: "00000000000000000000000000" }, dry_run: true };
  }
}
