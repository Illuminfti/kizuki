import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_AUDIT_PAGE,
  OWNER,
  addAgent,
  authenticate,
  checkRate,
  initAgents,
  listAudit,
  listAuditPage,
  recordAudit,
  reserveAudit,
  setGrant,
  shapeArguments,
} from "../../src/agents";

function accessRows(db: ReturnType<typeof agentsDb>, name: string) {
  return listAudit(db, name, { kind: "access" });
}
import type { Principal } from "../../src/agents";
import { sha256 } from "../../src/agents/hash";
import { agentsDb } from "./helpers";

function principalWithRate(rate: number): { db: ReturnType<typeof agentsDb>; principal: Principal } {
  const db = agentsDb();
  const { token } = addAgent(db, "reader-1", { rate_limit_per_minute: rate });
  const principal = authenticate(db, token);
  if (principal === null) throw new Error("expected authentication");
  return { db, principal };
}

describe("shapeArguments", () => {
  test("hashes free text at every object depth", () => {
    const query = "find the private launch notes";
    const hash = new Bun.CryptoHasher("sha256").update(query).digest("hex");

    const shaped = shapeArguments({ query, nested: { prompt: query } });

    expect(JSON.stringify(shaped)).not.toContain(query);
    expect(shaped).toEqual({
      query: { len: query.length, sha256: hash },
      nested: { prompt: { len: query.length, sha256: hash } },
    });
  });

  test("hashes every non-empty string, including short identifiers", () => {
    const subject = "person:ada";
    expect(
      shapeArguments({
        limit: 12,
        include_archived: false,
        empty: "",
        subjects: [subject],
        page_ids: ["page-1"],
      }),
    ).toEqual({
      limit: 12,
      include_archived: false,
      empty: "",
      subjects: [{ len: subject.length, sha256: sha256(subject) }],
      page_ids: [{ len: 6, sha256: sha256("page-1") }],
    });
    expect(JSON.stringify(shapeArguments({ subjects: [subject] }))).not.toContain(
      subject,
    );
  });

  test("keeps prototype keys from poisoning or disappearing", () => {
    const shaped = shapeArguments(
      JSON.parse('{"__proto__":{"admin":true},"query":"x"}') as Record<
        string,
        unknown
      >,
    );
    expect(Object.getPrototypeOf(shaped)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(shaped, "__proto__")).toBe(false);
    expect((shaped as { admin?: unknown }).admin).toBeUndefined();
    expect(JSON.stringify(shaped)).toContain(sha256("__proto__"));
  });

  test("hashes strings in arrays that are not declared id collections", () => {
    const text = "secret-1";
    const shaped = shapeArguments({ queries: [text] });
    expect(JSON.stringify(shaped)).not.toContain(text);
    expect(shaped).toEqual({
      queries: [
        {
          len: text.length,
          sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
        },
      ],
    });
  });

  test("bounds cyclic, deep, wide, sparse, and oversized hostile arguments", () => {
    const canary = "audit-shape-bounds-secret";
    const cyclic: Record<string, unknown> = { canary };
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 32; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const wide = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`key_${index}`, canary]),
    );
    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    sparse[999_999] = canary;
    const oversizedKey = `${canary}-${"k".repeat(16_384)}`;
    const oversized = Object.create(null) as Record<string, unknown>;
    oversized[oversizedKey] = canary;

    for (const args of [
      { cyclic },
      { deep },
      { wide },
      { sparse },
      oversized,
      { giant: canary.repeat(16_384) },
    ]) {
      const serialized = JSON.stringify(shapeArguments(args));
      expect(serialized.length).toBeLessThanOrEqual(32 * 1024);
      expect(serialized).not.toContain(canary);
    }
  });

  test("does not invoke caller-owned getters while shaping", () => {
    const args = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(args, "trap", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });

    expect(shapeArguments(args)).toEqual({
      trap: { type: "accessor" },
    });
  });

  test("retains the width marker when a caller uses its preferred metadata key", () => {
    const args = Object.fromEntries([
      ["__audit_truncated_entries__", false],
      ...Array.from({ length: 32 }, (_, index) => [`key_${index}`, index]),
    ]);
    const shaped = shapeArguments(args);
    expect(shaped.__audit_truncated_entries__).toBe(false);
    expect(JSON.stringify(shaped)).toContain('"reason":"object_key_limit"');
  });
});

describe("audit trail", () => {
  for (const reverse of [false, true]) {
    for (const kind of ["oversized", "prototype"] as const) {
      test(`denials retain ${kind} key evidence with colliding caller keys, reverse=${reverse}`, () => {
        const { db, principal } = principalWithRate(1);
        const dangerous = kind === "oversized" ? "k".repeat(300) : "__proto__";
        const collision = kind === "oversized" ? "__audit_truncated_key_1__" : sha256(dangerous);
        const entries: [string, unknown][] = [[dangerous, "private-value"], [collision, false]];
        const args = Object.fromEntries(reverse ? entries.reverse() : entries);
        try {
          const first = recordAudit(db, principal, "search", args, [], [
            { id: "tool:search", reason: "invalid_arguments" },
          ], "2026-03-01T12:00:00Z");
          const second = reserveAudit(db, principal, "search", args, "2026-03-01T12:00:01Z");
          expect(second).toMatchObject({ allow: false, reason: "rate_limited" });
          const rows = listAudit(db, "reader-1", { kind: "access" });
          expect(rows.find((row) => row.audit_id === first)?.denied).toEqual([
            { id: "tool:search", reason: "invalid_arguments" },
          ]);
          for (const row of rows) {
            const encoded = JSON.stringify(row.query_shape);
            expect(encoded).toContain(kind === "oversized" ? '"type":"key_truncated"' : '"key":"rejected"');
            expect(encoded).toContain(sha256(dangerous));
            expect(encoded).not.toContain("private-value");
            expect(row.query_shape[collision]).toBe(false);
          }
        } finally {
          db.close();
        }
      });
    }
  }

  test("charges holes, accessors and markers against the emitted node budget", () => {
    const countValues = (value: unknown): number => 1 + (
      value !== null && typeof value === "object"
        ? Object.values(value).reduce<number>((sum, nested) => sum + countValues(nested), 0)
        : 0
    );
    const holes = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`array_${index}`, new Array(32)]));
    const accessors: Record<string, unknown> = {};
    for (let index = 0; index < 32; index += 1) {
      const child: Record<string, unknown> = {};
      for (let item = 0; item < 32; item += 1) {
        Object.defineProperty(child, `item_${item}`, { enumerable: true, get() { throw new Error("getter invoked"); } });
      }
      accessors[`child_${index}`] = child;
    }
    for (const args of [holes, accessors]) {
      const shaped = shapeArguments(args);
      expect(countValues(shaped)).toBeLessThanOrEqual(256);
      expect(JSON.stringify(shaped)).toContain("node_limit");
      const { db, principal } = principalWithRate(1);
      try {
        recordAudit(db, principal, "search", {}, [], [], "2026-03-01T12:00:00Z");
        const denied = reserveAudit(db, principal, "search", args, "2026-03-01T12:00:01Z");
        expect(denied.allow).toBe(false);
        const row = listAudit(db, "reader-1", { kind: "access" }).find((entry) => entry.audit_id === denied.audit_id)!;
        expect(countValues(row.query_shape)).toBeLessThanOrEqual(256);
        expect(JSON.stringify(row.query_shape)).toContain("node_limit");
      } finally {
        db.close();
      }
    }
  });

  test("records a bounded audit row for cyclic public-agent arguments", () => {
    const { db, principal } = principalWithRate(60);
    const canary = "reserve-audit-cycle-secret";
    const args: Record<string, unknown> = { canary };
    args.self = args;

    const reserved = reserveAudit(db, principal, "search", args);
    expect(reserved.allow).toBe(true);
    const row = db
      .query<{ query_shape: string }, [string]>(
        "SELECT query_shape FROM agent_audit WHERE audit_id = ?",
      )
      .get(reserved.audit_id);
    expect(row?.query_shape.length).toBeLessThanOrEqual(32 * 1024);
    expect(row?.query_shape).not.toContain(canary);
    expect(listAudit(db, "reader-1", { kind: "access" })).toHaveLength(1);
    db.close();
  });

  test("keeps a cyclic request denied when its reservation is rate limited", () => {
    const { db, principal } = principalWithRate(1);
    recordAudit(db, principal, "search", {}, [], [], "2026-03-01T12:00:00.000Z");
    const canary = "rate-limited-cycle-secret";
    const args: Record<string, unknown> = { canary };
    args.self = args;

    const reserved = reserveAudit(
      db,
      principal,
      "search",
      args,
      "2026-03-01T12:00:01.000Z",
    );
    expect(reserved).toMatchObject({ allow: false, reason: "rate_limited" });
    const row = db
      .query<{ query_shape: string }, [string]>(
        "SELECT query_shape FROM agent_audit WHERE audit_id = ?",
      )
      .get(reserved.audit_id);
    expect(row?.query_shape.length).toBeLessThanOrEqual(32 * 1024);
    expect(row?.query_shape).not.toContain(canary);
    expect(listAudit(db, "reader-1", { kind: "access" })).toHaveLength(2);
    db.close();
  });

  test("records a bounded row without leaking hostile getter or oversized key text", () => {
    const { db, principal } = principalWithRate(60);
    const canary = "record-audit-oversized-secret";
    const args = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(args, `${canary}-${"k".repeat(16_384)}`, {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });

    const auditId = recordAudit(db, principal, "search", args, [], []);
    const row = db
      .query<{ query_shape: string }, [string]>(
        "SELECT query_shape FROM agent_audit WHERE audit_id = ?",
      )
      .get(auditId);
    expect(row?.query_shape.length).toBeLessThanOrEqual(32 * 1024);
    expect(row?.query_shape).not.toContain(canary);
    expect(listAudit(db, "reader-1", { kind: "access" })).toHaveLength(1);
    db.close();
  });

  test("stores only the query shape and round-trips served and denied", () => {
    const { db, principal } = principalWithRate(60);
    const query = "Ada's confidential calendar";
    const queryHash = new Bun.CryptoHasher("sha256").update(query).digest("hex");
    const served = [{ id: "page-public", sensitivity: "public", taint: "clean", authority: null }];
    const denied = [{ id: "page-private", reason: "above_ceiling" as const }];

    const auditId = recordAudit(db, principal, "search", { query }, served, denied);
    const raw = db
      .query<{ query_shape: string }, [string]>(
        "SELECT query_shape FROM agent_audit WHERE audit_id = ?",
      )
      .get(auditId);

    expect(raw?.query_shape).not.toContain(query);
    expect(raw?.query_shape).toContain(queryHash);
    expect(listAudit(db, "reader-1")[0]).toMatchObject({
      audit_id: auditId,
      agent_id: principal.kind === "agent" ? principal.agent.agent_id : "",
      tool: "search",
      grant_epoch: 1,
      served: [
        {
          id: sha256("page-public"),
          sensitivity: "public",
          taint: "clean",
          authority: null,
        },
      ],
      denied: [{ id: sha256("page-private"), reason: "above_ceiling" }],
    });
    db.close();
  });

  test("lists newest first and applies the limit", () => {
    const { db, principal } = principalWithRate(60);
    const first = recordAudit(db, principal, "search", { query: "first" }, [], []);
    const second = recordAudit(db, principal, "timeline", { query: "second" }, [], []);
    const third = recordAudit(db, principal, "get_page", { id: "third" }, [], []);

    expect(accessRows(db, "reader-1").map(({ audit_id }) => audit_id)).toEqual([
      third,
      second,
      first,
    ]);
    expect(
      accessRows(db, "reader-1")
        .slice(0, 2)
        .map(({ audit_id }) => audit_id),
    ).toEqual([third, second]);
    db.close();
  });

  test("records owner calls under the reserved owner id", () => {
    const db = agentsDb();
    const auditId = recordAudit(db, OWNER, "system_health", {}, [], []);

    expect(listAudit(db, "owner")).toEqual([
      expect.objectContaining({ audit_id: auditId, agent_id: "owner" }),
    ]);
    expect(listAudit(db, "missing-reader")).toEqual([]);
    db.close();
  });
});

describe("checkRate", () => {
  test("allows three audited calls at limit three and denies the fourth", () => {
    const { db, principal } = principalWithRate(3);
    for (const tool of ["search", "timeline", "get_page"] as const) {
      expect(checkRate(db, principal, tool)).toEqual({ allow: true });
      recordAudit(db, principal, tool, {}, [], []);
    }

    const denied = checkRate(
      db,
      principal,
      "search",
      new Date(Date.now() + 10).toISOString(),
    );
    expect(denied).toMatchObject({ allow: false, reason: "rate_limited" });
    if (denied.allow) throw new Error("expected rate limit");
    expect(denied.retry_after_seconds).toBeGreaterThan(0);
    db.close();
  });

  test("allows calls again after the rolling minute expires", () => {
    const { db, principal } = principalWithRate(1);
    recordAudit(db, principal, "search", {}, [], []);

    expect(
      checkRate(
        db,
        principal,
        "search",
        new Date(Date.now() + 60_100).toISOString(),
      ),
    ).toEqual({ allow: true });
    db.close();
  });

  test("the recorded instant is normalized, so the rolling window holds", () => {
    const { db, principal } = principalWithRate(1);
    // An offset timestamp compares as a raw string in the window query: a
    // caller-supplied instant has to be stored in one shape or the limit
    // silently stops counting.
    recordAudit(db, principal, "search", {}, [], [], "2026-02-28T12:00:00+02:00");
    const stored = accessRows(
      db,
      principal.kind === "agent" ? principal.agent.name : "owner",
    )[0];
    expect(stored?.at).toBe("2026-02-28T10:00:00.000Z");
    expect(
      checkRate(db, principal, "search", "2026-02-28T10:00:30Z"),
    ).toMatchObject({ allow: false });

    expect(() =>
      recordAudit(db, principal, "search", {}, [], [], "yesterday"),
    ).toThrow(TypeError);
    db.close();
  });

  test("never rate limits the owner", () => {
    const db = agentsDb();
    for (let index = 0; index < 100; index += 1) {
      recordAudit(db, OWNER, "search", { index }, [], []);
    }
    expect(checkRate(db, OWNER, "search")).toEqual({ allow: true });
    db.close();
  });

  test("retry_after waits for the row that actually frees a slot", () => {
    const { db, principal } = principalWithRate(10);
    const base = Date.parse("2026-03-01T12:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      recordAudit(
        db,
        principal,
        "search",
        { index },
        [],
        [],
        new Date(base + index * 1_000).toISOString(),
      );
    }
    setGrant(db, "reader-1", { rate_limit_per_minute: 3 });
    const current =
      principal.kind === "agent"
        ? { ...principal, grant: { ...principal.grant, rate_limit_per_minute: 3 } }
        : principal;

    const denied = checkRate(db, current, "search", "2026-03-01T12:00:04.000Z");
    expect(denied).toMatchObject({ allow: false, reason: "rate_limited" });
    if (denied.allow) throw new Error("expected rate limit");
    // Five rows, limit 3: the third-oldest (12:00:02) must expire.
    expect(denied.retry_after_seconds).toBe(58);
    db.close();
  });

  test("rejects forged served counts and oversized lists", () => {
    const { db, principal } = principalWithRate(60);
    expect(() =>
      recordAudit(db, principal, "search", {}, [{ id: "p", sensitivity: "public" }, "x" as never], []),
    ).toThrow(/served/);
    expect(() =>
      recordAudit(
        db,
        principal,
        "search",
        {},
        Array.from({ length: 257 }, (_, index) => ({
          id: `p-${index}`,
          sensitivity: "public",
        })),
        [],
      ),
    ).toThrow(/at most/);
    db.close();
  });
});

describe("reserveAudit", () => {
  test("retry_after accounts for the reserved denial row", () => {
    const { db, principal } = principalWithRate(3);
    const base = Date.parse("2026-03-01T12:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      recordAudit(
        db,
        principal,
        "search",
        { index },
        [],
        [],
        new Date(base + index * 1_000).toISOString(),
      );
    }
    const denied = reserveAudit(
      db,
      principal,
      "search",
      {},
      "2026-03-01T12:00:04.000Z",
    );
    expect(denied).toMatchObject({ allow: false, reason: "rate_limited" });
    if (denied.allow) throw new Error("expected rate limit");
    // Four access rows, limit 3: the second-oldest (12:00:01) must expire.
    expect(denied.retry_after_seconds).toBe(57);
    expect(
      checkRate(db, principal, "search", "2026-03-01T12:01:00.000Z").allow,
    ).toBe(false);
    const retryAt = new Date(
      Date.parse("2026-03-01T12:00:04.000Z") +
        denied.retry_after_seconds * 1_000,
    ).toISOString();
    expect(reserveAudit(db, principal, "search", {}, retryAt).allow).toBe(true);
    db.close();
  });

  test("serialized callers cannot share the last slot", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rate-"));
    const path = join(directory, "agents.sqlite");
    try {
      const writer = new Database(path, { create: true });
      initAgents(writer);
      const { token } = addAgent(writer, "reader-1", {
        rate_limit_per_minute: 1,
      });
      writer.close();

      const first = new Database(path);
      const second = new Database(path);
      const principalOf = (db: Database) => {
        const principal = authenticate(db, token);
        if (principal === null) throw new Error("expected authentication");
        return principal;
      };
      const at = "2026-03-01T12:00:00.000Z";
      const one = reserveAudit(first, principalOf(first), "search", {}, at);
      const two = reserveAudit(second, principalOf(second), "search", {}, at);
      expect([one.allow, two.allow].sort()).toEqual([false, true]);
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("listAuditPage", () => {
  test("caps the page and walks a stable cursor", () => {
    const { db, principal } = principalWithRate(60);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(
        recordAudit(
          db,
          principal,
          "search",
          { index },
          [],
          [],
          new Date(Date.parse("2026-03-01T12:00:00.000Z") + index * 1_000).toISOString(),
        ),
      );
    }
    const newestFirst = [...ids].reverse();
    const first = listAuditPage(db, "reader-1", { limit: 2, kind: "access" });
    expect(first.rows.map((row) => row.audit_id)).toEqual(newestFirst.slice(0, 2));
    expect(first.next_cursor).not.toBeNull();
    const second = listAuditPage(db, "reader-1", {
      limit: 2,
      kind: "access",
      cursor: first.next_cursor ?? "",
    });
    expect(second.rows.map((row) => row.audit_id)).toEqual(newestFirst.slice(2));
    expect(second.next_cursor).toBeNull();
    expect(
      listAudit(db, "reader-1", { limit: MAX_AUDIT_PAGE + 50, kind: "access" }),
    ).toHaveLength(4);
    db.close();
  });
});
