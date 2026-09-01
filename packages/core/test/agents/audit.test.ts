import { describe, expect, test } from "bun:test";
import {
  OWNER,
  addAgent,
  authenticate,
  checkRate,
  listAudit,
  recordAudit,
  shapeArguments,
} from "../../src/agents";
import type { Principal } from "../../src/agents";
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

  test("keeps scalars and bounded arrays of short ids", () => {
    expect(
      shapeArguments({
        limit: 12,
        include_archived: false,
        empty: "",
        subjects: ["person:ada", "org:acme"],
        page_ids: ["page-1"],
      }),
    ).toEqual({
      limit: 12,
      include_archived: false,
      empty: "",
      subjects: ["person:ada", "org:acme"],
      page_ids: ["page-1"],
    });
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
});

describe("audit trail", () => {
  test("stores only the query shape and round-trips served and denied", () => {
    const { db, principal } = principalWithRate(60);
    const query = "Ada's confidential calendar";
    const queryHash = new Bun.CryptoHasher("sha256").update(query).digest("hex");
    const served = [{ id: "page-public", sensitivity: "public" }];
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
      served,
      denied,
    });
    db.close();
  });

  test("lists newest first and applies the limit", () => {
    const { db, principal } = principalWithRate(60);
    const first = recordAudit(db, principal, "search", { query: "first" }, [], []);
    const second = recordAudit(db, principal, "timeline", { query: "second" }, [], []);
    const third = recordAudit(db, principal, "get_page", { id: "third" }, [], []);

    expect(listAudit(db, "reader-1").map(({ audit_id }) => audit_id)).toEqual([
      third,
      second,
      first,
    ]);
    expect(listAudit(db, "reader-1", { limit: 2 }).map(({ audit_id }) => audit_id)).toEqual([
      third,
      second,
    ]);
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

  test("never rate limits the owner", () => {
    const db = agentsDb();
    for (let index = 0; index < 100; index += 1) {
      recordAudit(db, OWNER, "search", { index }, [], []);
    }
    expect(checkRate(db, OWNER, "search")).toEqual({ allow: true });
    db.close();
  });
});
