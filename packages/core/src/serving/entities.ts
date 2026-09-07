import type { AuditDenial, AuditItem } from "../agents";
import { compareText } from "../util/order";
import type { CanonPage } from "../vault/pages";
import { enumOf, limit, text } from "./arguments";
import {
  canonChunk,
  collapseWhitespace,
  eligible,
  excerptOf,
  loadCanon,
  pageDecision,
  stringField,
} from "./canon";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import type { CanonChunk, Envelope, ServeContext, SubjectLabelDegradation } from "./types";
import { attachSubjectLabels, canonSubjects, labelsFor, projectSubjectLabels } from "./subject-labels";

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

function matchesName(page: CanonPage, needle: string): boolean {
  return (
    (stringField(page, "title") ?? "").toLowerCase().includes(needle) ||
    (stringField(page, "x-handle") ?? "").toLowerCase().includes(needle)
  );
}

export interface EntitiesData { degraded: SubjectLabelDegradation[] }

export function serveEntities(ctx: ServeContext, args: EntitiesArgs): Envelope<EntitiesData> {
  return gate(
    ctx,
    "query_entities",
    auditArguments(args),
    ({ ctx, at }): Served<EntitiesData> => {
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
          const pageType = stringField(page, "type") ?? "";
          if (!(ENTITY_TYPES as readonly string[]).includes(pageType)) {
            return false;
          }
          if (type !== undefined && pageType !== type) return false;
          return true;
        })
        .sort(
          (left, right) =>
            compareText(
              (stringField(left, "title") ?? ""),
              (stringField(right, "title") ?? ""),
            ) || compareText(left.id, right.id),
        );

      const canon: CanonChunk[] = [];
      const withheld: AuditDenial[] = [];
      const admitted = candidates.flatMap(page => {
        const decision = pageDecision(index, ctx.principal.grant, page);
        if (!decision.allow) {
          if (name === undefined || matchesName(page, name)) withheld.push({ id: page.id, reason: decision.reason });
          return [];
        }
        return [{ page, decision, subjects: canonSubjects(index, page) }];
      });
      const projection = projectSubjectLabels(index, ctx.principal.grant, at, admitted.flatMap(item => item.subjects), Math.min(rows, admitted.length));
      const audit = new Map<string, AuditItem>();
      for (const { page, decision, subjects } of admitted) {
        const labels = labelsFor(projection, subjects);
        if (name !== undefined && !matchesName(page, name) && !labels.some(label =>
          [label.display_name, ...label.handles].some(value => value?.toLowerCase().includes(name)))) continue;
        // The scan runs past the limit so a match withheld further down the
        // order is still counted; only the served rows stop at the limit.
        if (canon.length === rows) continue;
        const { excerpt, truncated } = excerptOf(
          collapseWhitespace(page.body),
          EXCERPT_CHARS,
        );
        const chunk = canonChunk(index, page, decision, excerpt, truncated);
        for (const item of attachSubjectLabels(projection, chunk, subjects)) audit.set(item.id, item);
        canon.push(chunk);
      }

      return { canon, quoted: [], withheld, audit_served: [...audit.values()],
        ...(projection.degraded.length === 0 ? {} : { data: { degraded: projection.degraded } }) };
    },
  );
}
