import { validateRetrievalResult } from "../contracts/retrieval";
import type { RetrievalDocKind, RetrievalQuery } from "../contracts/retrieval";
import type { SearchOptions } from "../search/query";
import type { ServeContext } from "./types";

export interface RetrievalCandidates {
  ids: string[];
  degraded: string[];
}

/** A derived engine nominates identities. Its cached text never becomes served evidence. */
export async function retrievalCandidates(
  ctx: ServeContext,
  query: string,
  options: SearchOptions,
): Promise<RetrievalCandidates> {
  if (ctx.retrieval === undefined) return { ids: [], degraded: ctx.retrievalUnavailable ? ["retrieval-unavailable"] : [] };
  // The v1 port has no page-type predicate. Keep that request on the scoped
  // deterministic index rather than spending its window on excluded types.
  if (options.types !== undefined) {
    return { ids: [], degraded: ["retrieval-type-scope-unavailable"] };
  }
  const kinds: RetrievalDocKind[] = options.scope === "canon" ? ["page"]
    : options.scope === "ledger" ? ["event"] : ["page", "event"];
  const request: RetrievalQuery = {
    text: query, mode: "lexical", scope: { kinds,
      ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    },
    ceiling: options.ceiling ?? ctx.principal.grant.ceiling,
    limit: Math.min(100, options.limit ?? 20), deadline_ms: 3_000,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ctx.retrieval.search(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("retrieval deadline")), 3_000);
      }),
    ]);
    const validated = validateRetrievalResult(result, request.limit);
    return {
      ids: validated.hits.map((hit) => hit.doc_id),
      // Provider strings are not a public diagnostic channel.
      degraded: validated.degraded.length > 0 ? ["retrieval-degraded"] : [],
    };
  } catch {
    return { ids: [], degraded: ["retrieval-unavailable"] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
