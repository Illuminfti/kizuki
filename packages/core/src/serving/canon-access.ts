import type { Database } from "bun:sqlite";
import { authorize, denyClassesOf, sensitivity, type Grant } from "../agents";
import { CanonAuthorityResolver } from "../canon/authority";
import { readLiveEvent } from "../ledger/ledger";
import { observeStatements } from "../ledger/lifetime";
import { inspectSourceGrant, sourceEventsAllowed, sourceSensitivity, type SourceGrant } from "../ledger/source-grants";
import { eventIdFromReference } from "../retrieval/ids";
import { stringArray, type CanonPage } from "../vault/pages";
import { assessLivePageEvidence, isDeterministicBrief, type LivePageEvidence } from "../vault/provenance";
import { eligible, pageDecision, pageScope, type CanonIndex } from "./canon";
import { proofStatementSafe, readProofEpoch, type ReadProofEpoch } from "./read-proof-epoch";

type Decision = ReturnType<typeof pageDecision>;
interface PageRead {
  input: string;
  /** SHA-256 of `input`, the page's key among the proofs kept across calls. */
  key?: string;
  decision?: Decision;
  evidence?: LivePageEvidence;
  derivable?: boolean;
  visible?: boolean;
}
type KeptProof = Omit<PageRead, "input" | "key">;
/**
 * Owner proofs kept between served calls on one connection, for one reader
 * scope, under one reading of the read-proof epoch. Any write to a proof
 * input moves the epoch (read-proof-epoch.ts) and empties the set before it
 * is consulted again.
 */
interface KeptProofs {
  token: string;
  schema: number;
  epoch: number;
  pages: Map<string, KeptProof>;
}
const MAX_KEPT_SCOPES = 4;
const keptProofs = new WeakMap<Database, Map<string, KeptProofs>>();
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
  private databaseRevision = 0;
  private chars = 0;
  private pages = new Map<CanonPage, PageRead>();
  private events = new Map<string, boolean>();
  private grants = new Map<string, SourceGrant | null>();
  private grantChars = 0;
  private resolver: CanonAuthorityResolver | undefined;
  private resolverPaths = new Set<string>();
  /** The epoch read at the current database stamp; null when it cannot vouch. */
  private epoch: ReadProofEpoch | null = null;
  private kept: KeptProofs | undefined;
  /**
   * Set once a proof ran a statement the epoch does not cover. From then on
   * this phase keeps nothing for later calls; it still serves exactly.
   */
  private unvouched = false;
  private observing = 0;
  private judging = false;
  /** Inside `batch`: inputs read once, and proofs to keep once the batch checks out. */
  private batching: { inputs: string | null; pages: Map<CanonPage, string | null>; keeps: (() => void)[] } | undefined;

  constructor(private readonly index: CanonIndex, private readonly grant: Grant) {
    this.db = index.sourceContext.db;
  }

  /** Only an owner reader on a host that answers many calls keeps proofs. */
  private keeping(): boolean {
    const ctx = this.index.sourceContext;
    return ctx.principal.kind === "owner" && ctx.keepProofs === true;
  }

  /**
   * Runs one owner proof with every statement it prepares judged first
   * (read-proof-epoch.ts). A statement the epoch does not cover, or a
   * connection whose statements cannot be observed, leaves the phase
   * unvouched: it still serves exactly, and keeps nothing for later calls.
   */
  private observed<T>(prove: () => T): T {
    if (!this.keeping() || this.observing > 0) return prove();
    const db = this.index.sourceContext.db;
    const judge = (sql: string): void => {
      if (this.unvouched || this.judging) return;
      this.judging = true;
      try { if (this.epoch === null || !proofStatementSafe(db, sql, this.epoch.schema)) this.unvouched = true; }
      finally { this.judging = false; }
    };
    this.observing += 1;
    try {
      const observed = observeStatements(db, judge, prove);
      if (observed !== null) return observed.value;
      this.unvouched = true;
      return prove();
    } finally { this.observing -= 1; }
  }

  appliesTo(index: CanonIndex, grant: Grant): boolean {
    return this.index === index && this.grant === grant;
  }

  private clearPageReads(): void {
    this.pages.clear(); this.resolver = undefined; this.resolverPaths.clear(); this.chars = 0;
    this.revision += 1;
  }

  /** Raw event and policy facts depend on the database, not the reader's scope. */
  private currentDatabase(): number {
    // The stamp and the epoch decide what may be reused; they are not proof inputs.
    const judging = this.judging;
    this.judging = true;
    try { return this.readDatabaseStamp(); } finally { this.judging = judging; }
  }

  private readDatabaseStamp(): number {
    const db = this.index.sourceContext.db;
    const row = db.query<{ changes: number; version: number; schema: number }, []>(
      "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema",
    ).get()!;
    const stamp = `${row.changes}:${row.version}:${row.schema}`;
    // A savepoint rollback need not change total_changes(). Do not reuse reads
    // inside explicit transactions; final publication owns its own snapshot.
    if (this.db !== db || stamp !== this.stamp || db.inTransaction) {
      this.db = db; this.stamp = stamp;
      this.clearPageReads(); this.events.clear(); this.grants.clear(); this.grantChars = 0;
      this.databaseRevision += 1;
      this.epoch = this.keeping() && !db.inTransaction ? readProofEpoch(db) : null;
      this.kept = undefined;
    }
    return this.databaseRevision;
  }

  private readerInputs(): string | null {
    const ctx = this.index.sourceContext;
    return inputKey([ctx.principal, this.grant, ctx.sourcePurpose ?? "recall", ctx.selection ?? null]);
  }

  /**
   * One synchronous pass over many pages. The reader's inputs and each page's
   * input are serialized once instead of on every call, and checked again
   * when the pass ends. Proof code writes neither; if anything did, nothing
   * the pass proved is kept or returned, and the pass runs again unbatched.
   */
  batch<T>(read: () => T): T {
    if (this.batching !== undefined) return read();
    const batching = { inputs: this.readerInputs(), pages: new Map<CanonPage, string | null>(), keeps: [] as (() => void)[] };
    this.batching = batching;
    let result: T;
    try { result = read(); } finally { this.batching = undefined; }
    if (this.readerInputs() === batching.inputs && [...batching.pages].every(([page, input]) => this.pageInput(page) === input)) {
      for (const keep of batching.keeps) keep();
      return result;
    }
    this.clearPageReads(); this.kept = undefined;
    return read();
  }

  private current(): number {
    this.currentDatabase();
    const ctx = this.index.sourceContext;
    const inputs = ctx.db.inTransaction ? null : this.batching !== undefined ? this.batching.inputs : this.readerInputs();
    if (inputs === null || inputs !== this.inputs) {
      this.inputs = inputs ?? "";
      this.clearPageReads();
      this.kept = undefined;
    }
    return this.revision;
  }

  /** The kept proofs of this scope under the current epoch, emptied when the epoch moved. */
  private keptProofs(): KeptProofs | undefined {
    if (this.kept !== undefined) return this.kept;
    const epoch = this.epoch;
    if (epoch === null || this.inputs === "" || !this.keeping()) return undefined;
    let scopes = keptProofs.get(this.db);
    if (scopes === undefined) { scopes = new Map(); keptProofs.set(this.db, scopes); }
    let kept = scopes.get(this.inputs);
    if (kept === undefined) {
      if (scopes.size >= MAX_KEPT_SCOPES) scopes.delete(scopes.keys().next().value!);
      kept = { token: epoch.token, schema: epoch.schema, epoch: epoch.epoch, pages: new Map() };
      scopes.set(this.inputs, kept);
    } else if (kept.token !== epoch.token || kept.schema !== epoch.schema || kept.epoch !== epoch.epoch) {
      kept.token = epoch.token; kept.schema = epoch.schema; kept.epoch = epoch.epoch; kept.pages = new Map();
    }
    this.kept = kept;
    return kept;
  }

  private keyOf(entry: PageRead): string {
    entry.key ??= new Bun.CryptoHasher("sha256").update(entry.input).digest("hex");
    return entry.key;
  }

  /** A proof an earlier call made under this epoch, scope and page input. */
  private keptRead(entry: PageRead | undefined): KeptProof | undefined {
    if (entry === undefined) return undefined;
    return this.keptProofs()?.pages.get(this.keyOf(entry));
  }

  /**
   * Called only when the database stamp held for the whole proof. The kept
   * value is the phase's own private copy, which no caller ever receives:
   * every read hands out a clone.
   */
  private keep(entry: PageRead | undefined, field: keyof KeptProof): void {
    if (entry === undefined || this.unvouched) return;
    const kept = this.keptProofs();
    if (kept === undefined) return;
    // The set of this epoch: a later epoch replaces it, so a deferred proof never lands in a newer one.
    const pages = kept.pages, key = this.keyOf(entry), copy = entry[field];
    const store = (): void => {
      let page = pages.get(key);
      if (page === undefined) {
        if (pages.size >= MAX_PAGES) return;
        page = {};
        pages.set(key, page);
      }
      (page as Record<string, unknown>)[field] = copy;
    };
    if (this.batching !== undefined) this.batching.keeps.push(store);
    else store();
  }

  private pageInput(page: CanonPage): string | null {
    if (["id", "relPath", "contentHash", "data", "body"].some(key => !("value" in (Object.getOwnPropertyDescriptor(page, key) ?? {})))) return null;
    return inputKey([page.id, page.relPath, page.contentHash, page.data,
      // Only the class fallback inspects body bytes. Owner scope skips it.
      denyClassesOf(this.grant).length === 0 ? null : page.body,
      this.index.generation, this.index.holds.has(page.relPath), this.index.deniedPaths.has(page.relPath)]);
  }

  private entry(page: CanonPage): PageRead | undefined {
    const batching = this.batching;
    let input: string | null;
    if (batching === undefined) input = this.pageInput(page);
    else if (batching.pages.has(page)) input = batching.pages.get(page)!;
    else { input = this.pageInput(page); batching.pages.set(page, input); }
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
      this.resolver = this.observed(() => new CanonAuthorityResolver(ctx.db, paths));
      this.resolverPaths = new Set(paths);
    }
    // Mutated scope, newly added snapshots and renamed paths may become visible
    // without a database write. They retain the ordinary independent resolver.
    return this.resolverPaths.has(page.relPath) ? this.resolver : undefined;
  }

  private liveExternalEvent = (id: string): boolean => {
    const before = this.currentDatabase();
    const known = this.events.get(id);
    if (known !== undefined) return known;
    const valid = this.observed(() => readLiveEvent(this.db, id)?.origin === "external");
    if (this.currentDatabase() === before && id.length <= 256 && this.events.size < MAX_EVENTS) this.events.set(id, valid);
    return valid;
  };

  /** Reuse the full validated inspection, never a policy-only shortcut. */
  grantOf = (sourceKey: string): SourceGrant | null => {
    const before = this.currentDatabase();
    if (this.grants.has(sourceKey)) return structuredClone(this.grants.get(sourceKey)!);
    const grant = this.observed(() => inspectSourceGrant(this.db, sourceKey));
    const input = inputKey(grant);
    if (this.currentDatabase() === before && sourceKey.length <= 256 && input !== null
      && input.length <= 1024 * 1024 && this.grants.size < MAX_SOURCE_GRANTS
      && this.grantChars + input.length <= MAX_SOURCE_GRANT_CHARS) {
      this.grants.set(sourceKey, structuredClone(grant)); this.grantChars += input.length;
    }
    return grant;
  };

  evidence(page: CanonPage): LivePageEvidence {
    const before = this.current(), entry = this.entry(page);
    if (entry?.evidence !== undefined) return structuredClone(entry.evidence);
    const kept = this.keptRead(entry)?.evidence;
    if (kept !== undefined) { entry!.evidence = kept; return structuredClone(kept); }
    const ctx = this.index.sourceContext;
    const evidence = this.observed(() => assessLivePageEvidence(this.db, page, this.authority(page),
      { ...ctx, principal: { ...ctx.principal, grant: this.grant } }, false, this.liveExternalEvent));
    if (this.current() === before && entry !== undefined) { entry.evidence = structuredClone(evidence); this.keep(entry, "evidence"); }
    return evidence;
  }

  decision(page: CanonPage): Decision {
    const before = this.current(), entry = this.entry(page);
    if (entry?.decision !== undefined) return structuredClone(entry.decision);
    const kept = this.keptRead(entry)?.decision;
    if (kept !== undefined) { entry!.decision = kept; return structuredClone(kept); }
    const decision = this.observed(() => pageDecision(this.index, this.grant, page, { evidence: candidate => this.evidence(candidate), grantOf: this.grantOf }));
    if (this.current() === before && entry !== undefined) { entry.decision = structuredClone(decision); this.keep(entry, "decision"); }
    return decision;
  }

  /**
   * Visible-index health's scope and source filter, before any receipt or
   * provenance work (index-health.ts): the same predicate, on the phase's
   * shared grant inspections.
   */
  visible(page: CanonPage): boolean {
    const before = this.current(), entry = this.entry(page);
    if (entry?.visible !== undefined) return entry.visible;
    const kept = this.keptRead(entry)?.visible;
    if (kept !== undefined) { entry!.visible = kept; return kept; }
    const ctx = this.index.sourceContext, grant = this.grant;
    const visible = this.observed(() => {
      if (this.index.deniedPaths.has(page.relPath) || !eligible(page) || isDeterministicBrief(page) || !authorize(grant, pageScope(ctx, page, grant)).allow) return false;
      const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
      const original = sensitivity(page.data["sensitivity"]);
      return (ctx.principal.kind === "owner" || sources.length > 0)
        && original !== null
        && sourceEventsAllowed(ctx.db, sources, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant), grantOf: this.grantOf })
        && authorize(grant, { ...pageScope(ctx, page, grant), sensitivity: sourceSensitivity(ctx.db, sources, original, this.grantOf) }).allow;
    });
    if (this.current() === before && entry !== undefined) { entry.visible = visible; this.keep(entry, "visible"); }
    return visible;
  }

  projectable(page: CanonPage): boolean {
    const before = this.current(), entry = this.entry(page);
    if (entry?.derivable !== undefined) return entry.derivable;
    // Derivation retains its distinct owner/purpose context, including typed
    // world-basis checks; a reader's recall permission is not derivation consent.
    const kept = this.keptRead(entry)?.derivable;
    if (kept !== undefined) { entry!.derivable = kept; return kept; }
    const derivable = this.observed(() => {
      const evidence = assessLivePageEvidence(this.db, page, this.authority(page), undefined, false, this.liveExternalEvent);
      return evidence.admitted && sourceEventsAllowed(this.db, evidence.sourceIds, { owner: true, purpose: "derive", grantOf: this.grantOf });
    });
    if (this.current() === before && entry !== undefined) { entry.derivable = derivable; this.keep(entry, "derivable"); }
    return derivable;
  }
}
