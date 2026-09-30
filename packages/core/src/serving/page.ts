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
import type { ServeContext, ResponseContract, ResponseEnvelope } from "./types";
import { ENVELOPE_SCHEMA } from "./types";

const MAX_ID_CHARS = 256;
const MAX_BODY_CHARS = 65_536;

export type GetPageArgs = { id: string } | { path: string };

export function serveGetPage<C extends ResponseContract = typeof ENVELOPE_SCHEMA>(ctx: ServeContext, args: GetPageArgs, contract: C = ENVELOPE_SCHEMA as C): ResponseEnvelope<undefined, C> {
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

    // The selector is validated before the vault is touched, so a malformed
    // argument answers `invalid_arguments` instead of surfacing as an engine
    // failure when the walk is what fails first.
    const selector = wantsId
      ? text("id", bag["id"], MAX_ID_CHARS)
      : relPath("path", bag["path"]);

    const index = loadCanon(ctx);
    const page = wantsId
      ? index.byId.get(selector)
      : index.byPath.get(selector);

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

    const { excerpt, truncated } = excerptOf(page.body, MAX_BODY_CHARS, ctx);
    return {
      canon: [canonChunk(index, page, decision, excerpt, truncated)],
      quoted: [],
      withheld: [],
    };
  }, contract);
}
