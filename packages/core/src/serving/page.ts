import { relPath, text } from "./arguments";
import {
  canonChunk,
  eligible,
  excerptOf,
  loadCanon,
  pageDecision,
} from "./canon";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

const MAX_ID_CHARS = 256;
const MAX_BODY_CHARS = 65_536;

export type GetPageArgs = { id: string } | { path: string };

export function serveGetPage(ctx: ServeContext, args: GetPageArgs): Envelope {
  return gate(ctx, "get_page", auditArguments(args), ({ ctx }): Served<undefined> => {
    const bag: Record<string, unknown> = { ...args };
    const wantsId = bag["id"] !== undefined;
    const wantsPath = bag["path"] !== undefined;
    if (wantsId === wantsPath) {
      throw new ServeError(
        "invalid_arguments",
        "invalid arguments: id: exactly one of id or path is required",
      );
    }

    const index = loadCanon(ctx);
    const page = wantsId
      ? index.byId.get(text("id", bag["id"], MAX_ID_CHARS))
      : index.byPath.get(relPath("path", bag["path"]));

    // Absent or retracted answers the same way: existence is neither
    // confirmed nor denied to a caller who guessed an id.
    if (page === undefined || !eligible(page)) {
      return { canon: [], quoted: [], withheld: [] };
    }

    const decision = pageDecision(index, ctx.principal.grant, page);
    if (!decision.allow) {
      return {
        canon: [],
        quoted: [],
        withheld: [{ id: page.id, reason: decision.reason }],
      };
    }

    const { excerpt, truncated } = excerptOf(page.body, MAX_BODY_CHARS);
    return {
      canon: [canonChunk(page, decision.sensitivity, excerpt, truncated)],
      quoted: [],
      withheld: [],
    };
  });
}
