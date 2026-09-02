import type { AuditDenial } from "../agents";
import type { CanonPage } from "../vault/pages";
import { enumOf, limit, text } from "./arguments";
import {
  canonChunk,
  collapseWhitespace,
  eligible,
  excerptOf,
  loadCanon,
  pageDecision,
} from "./canon";
import { auditArguments, compareText, gate } from "./gate";
import type { Served } from "./gate";
import type { CanonChunk, Envelope, ServeContext } from "./types";

export const ENTITY_TYPES = [
  "person",
  "org",
  "project",
  "place",
  "topic",
] as const;

const MAX_NAME_CHARS = 128;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const EXCERPT_CHARS = 240;

export interface EntitiesArgs {
  type?: (typeof ENTITY_TYPES)[number];
  name?: string;
  limit?: number;
}

function stringField(page: CanonPage, key: string): string {
  const value = page.data[key];
  return typeof value === "string" ? value : "";
}

function matchesName(page: CanonPage, needle: string): boolean {
  return (
    stringField(page, "title").toLowerCase().includes(needle) ||
    stringField(page, "x-handle").toLowerCase().includes(needle)
  );
}

export function serveEntities(ctx: ServeContext, args: EntitiesArgs): Envelope {
  return gate(
    ctx,
    "query_entities",
    auditArguments(args),
    ({ ctx }): Served<undefined> => {
      const type =
        args.type === undefined
          ? undefined
          : enumOf("type", args.type, ENTITY_TYPES);
      const name =
        args.name === undefined
          ? undefined
          : text("name", args.name, MAX_NAME_CHARS).toLowerCase();
      const rows = limit("limit", args.limit, MAX_LIMIT, DEFAULT_LIMIT);

      const index = loadCanon(ctx);
      const candidates = index.pages
        .filter((page) => {
          if (!eligible(page)) return false;
          const pageType = stringField(page, "type");
          if (!(ENTITY_TYPES as readonly string[]).includes(pageType)) {
            return false;
          }
          if (type !== undefined && pageType !== type) return false;
          return name === undefined || matchesName(page, name);
        })
        .sort(
          (left, right) =>
            compareText(
              stringField(left, "title"),
              stringField(right, "title"),
            ) || compareText(left.id, right.id),
        );

      const canon: CanonChunk[] = [];
      const withheld: AuditDenial[] = [];
      for (const page of candidates) {
        const decision = pageDecision(index, ctx.principal.grant, page);
        if (!decision.allow) {
          withheld.push({ id: page.id, reason: decision.reason });
          continue;
        }
        // The scan runs past the limit so a match withheld further down the
        // order is still counted; only the served rows stop at the limit.
        if (canon.length === rows) continue;
        const { excerpt, truncated } = excerptOf(
          collapseWhitespace(page.body),
          EXCERPT_CHARS,
        );
        canon.push(canonChunk(page, decision.sensitivity, excerpt, truncated));
      }

      return { canon, quoted: [], withheld };
    },
  );
}
