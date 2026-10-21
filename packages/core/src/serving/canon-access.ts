import { authorize, denyClassesOf, type Grant } from "../agents";
import { CanonAuthorityResolver } from "../canon/authority";
import { readLiveEvent } from "../ledger/ledger";
import { inspectSourceGrant, sourceEventsAllowed, type SourceGrant } from "../ledger/source-grants";
import type { CanonPage } from "../vault/pages";
import { assessLivePageEvidence, type LivePageEvidence } from "../vault/provenance";
import { eligible, pageDecision, pageScope, type CanonIndex } from "./canon";

type Decision = ReturnType<typeof pageDecision>;
interface PageRead {
  input: string;
  decision?: Decision;
  evidence?: LivePageEvidence;
  derivable?: boolean;
}
const MAX_PAGES = 16_384;
const MAX_EVENTS = 32_768;
const MAX_INPUT_CHARS = 32 * 1024 * 1024;
const MAX_SOURCE_GRANTS = 128;
const MAX_SOURCE_GRANT_CHARS = 4 * 1024 * 1024;

/** Mutable parsed inputs must match exactly; exotic programmatic inputs bypass reuse. */
function inputKey(value: unknown): string | null {
  let nodes = 0, chars = 0;
  const plain = (item: unknown, depth: number): boolean => {
    if (++nodes > 32_768 || depth > 64) return false;
    if (typeof item === "string") return (chars += item.length) <= 2 * 1024 * 1024;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object") return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return false;
    if (Object.getOwnPropertySymbols(item).length > 0) return false;
    if (Array.isArray(item) && Object.keys(item).length !== item.length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, property] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
      if ((chars += key.length) > 2 * 1024 * 1024) return false;
      if (!("value" in property) || !property.enumerable || !plain(property.value, depth + 1)) return false;
    }
    return true;
  };
  return plain(value, 0) ? JSON.stringify(value) : null;
}

/**
 * One synchronous search phase, after retrieval finishes. It shares bounded
 * proof work with visible-index health, never with publication or another call.
 * A changed database invalidates work rather than becoming a visible denial.
 */
export class CanonAccessPhase {
  private db;
  private stamp = "";
  private inputs = "";
  private revision = 0;
  private chars = 0;
  private pages = new Map<CanonPage, PageRead>();
  private events = new Map<string, boolean>();
  private grants = new Map<string, SourceGrant | null>();
  private grantChars = 0;
  private resolver: CanonAuthorityResolver | undefined;
  private resolverPaths = new Set<string>();

  constructor(private readonly index: CanonIndex, private readonly grant: Grant) {
    this.db = index.sourceContext.db;
  }

  appliesTo(index: CanonIndex, grant: Grant): boolean {
    return this.index === index && this.grant === grant;
  }

  private current(): number {
    const ctx = this.index.sourceContext;
    const row = ctx.db.query<{ changes: number; version: number; schema: number }, []>(
      "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema",
    ).get()!;
    const stamp = `${row.changes}:${row.version}:${row.schema}`;
    // A savepoint rollback need not change total_changes(). Do not reuse reads
    // inside explicit transactions; final publication owns its own snapshot.
    const inputs = ctx.db.inTransaction ? null : inputKey([ctx.principal, this.grant, ctx.sourcePurpose ?? "recall", ctx.selection ?? null]);
    if (this.db !== ctx.db || stamp !== this.stamp || inputs === null || inputs !== this.inputs) {
      this.db = ctx.db; this.stamp = stamp; this.inputs = inputs ?? "";
      this.pages.clear(); this.events.clear(); this.resolver = undefined; this.resolverPaths.clear(); this.chars = 0;
      this.grants.clear(); this.grantChars = 0;
      this.revision += 1;
    }
    return this.revision;
  }

  private entry(page: CanonPage): PageRead | undefined {
    if (["id", "relPath", "contentHash", "data", "body"].some(key => !("value" in (Object.getOwnPropertyDescriptor(page, key) ?? {})))) return undefined;
    const input = inputKey([page.id, page.relPath, page.contentHash, page.data,
      // Only the class fallback inspects body bytes. Owner scope skips it.
      denyClassesOf(this.grant).length === 0 ? null : page.body,
      this.index.generation, this.index.holds.has(page.relPath), this.index.deniedPaths.has(page.relPath)]);
    if (input === null || this.inputs === "") return undefined;
    const known = this.pages.get(page);
    if (known?.input === input) return known;
    if (known !== undefined) { this.chars -= known.input.length; this.pages.delete(page); }
    if (this.pages.size >= MAX_PAGES || this.chars + input.length > MAX_INPUT_CHARS) return undefined;
    const created = { input };
    this.pages.set(page, created); this.chars += input.length;
    return created;
  }

  private authority(page: CanonPage): CanonAuthorityResolver | undefined {
    if (this.resolver === undefined && this.index.pages.length <= MAX_PAGES) {
      const ctx = this.index.sourceContext;
      // A hidden path never enters the shared receipt reconstruction.
      const paths = this.index.pages.filter(page => !this.index.deniedPaths.has(page.relPath)
        && eligible(page) && authorize(this.grant, pageScope(ctx, page, this.grant)).allow).map(page => page.relPath);
      this.resolver = new CanonAuthorityResolver(ctx.db, paths);
      this.resolverPaths = new Set(paths);
    }
    // Mutated scope, newly added snapshots and renamed paths may become visible
    // without a database write. They retain the ordinary independent resolver.
    return this.resolverPaths.has(page.relPath) ? this.resolver : undefined;
  }

  private liveExternalEvent = (id: string): boolean => {
    const before = this.current();
    const known = this.events.get(id);
    if (known !== undefined) return known;
    const valid = readLiveEvent(this.db, id)?.origin === "external";
    if (this.current() === before && id.length <= 256 && this.events.size < MAX_EVENTS) this.events.set(id, valid);
    return valid;
  };

  /** Reuse the full validated inspection, never a policy-only shortcut. */
  grantOf = (sourceKey: string): SourceGrant | null => {
    const before = this.current();
    if (this.grants.has(sourceKey)) return structuredClone(this.grants.get(sourceKey)!);
    const grant = inspectSourceGrant(this.db, sourceKey);
    const input = inputKey(grant);
    if (this.current() === before && sourceKey.length <= 256 && input !== null
      && input.length <= 1024 * 1024 && this.grants.size < MAX_SOURCE_GRANTS
      && this.grantChars + input.length <= MAX_SOURCE_GRANT_CHARS) {
      this.grants.set(sourceKey, structuredClone(grant)); this.grantChars += input.length;
    }
    return grant;
  };

  evidence(page: CanonPage): LivePageEvidence {
    const before = this.current(), entry = this.entry(page);
    if (entry?.evidence !== undefined) return structuredClone(entry.evidence);
    const ctx = this.index.sourceContext;
    const evidence = assessLivePageEvidence(this.db, page, this.authority(page),
      { ...ctx, principal: { ...ctx.principal, grant: this.grant } }, false, this.liveExternalEvent);
    if (this.current() === before && entry !== undefined) entry.evidence = structuredClone(evidence);
    return evidence;
  }

  decision(page: CanonPage): Decision {
    const before = this.current(), entry = this.entry(page);
    if (entry?.decision !== undefined) return structuredClone(entry.decision);
    const decision = pageDecision(this.index, this.grant, page, { evidence: candidate => this.evidence(candidate), grantOf: this.grantOf });
    if (this.current() === before && entry !== undefined) entry.decision = structuredClone(decision);
    return decision;
  }

  projectable(page: CanonPage): boolean {
    const before = this.current(), entry = this.entry(page);
    if (entry?.derivable !== undefined) return entry.derivable;
    // Derivation retains its distinct owner/purpose context, including typed
    // world-basis checks; a reader's recall permission is not derivation consent.
    const evidence = assessLivePageEvidence(this.db, page, this.authority(page), undefined, false, this.liveExternalEvent);
    const derivable = evidence.admitted && sourceEventsAllowed(this.db, evidence.sourceIds, { owner: true, purpose: "derive", grantOf: this.grantOf });
    if (this.current() === before && entry !== undefined) entry.derivable = derivable;
    return derivable;
  }
}
