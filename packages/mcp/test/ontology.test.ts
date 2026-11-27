import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  accept,
  addAgent,
  authenticate,
  insertClaim,
  revokeAgent,
  setGrant,
} from "@kizuki/core";
import { rebuildDerived } from "@kizuki/core/internal";
import { purgeEvents } from "../../core/src/ledger/purge";
import {
  compileOntologyFromVault,
  defaultOntologyDbPath,
  openOntologyStore,
} from "@kizuki/ontology";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { ONTOLOGY_TOOL_NAMES } from "../src/ontology";
import { call, connectClient, errorOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: McpFixture | null = null;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

function payloadOf(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("MCP ontology_* tools", () => {
  test("dynamic grant gating hides ungranted ontology tools and refuses direct calls", async () => {
    const running = live();

    // search-only has only ["search"]: must NOT see any ontology_* tool
    const searchOnly = await connectClient(running.agent("search-only"), cleanups);
    const searchOnlyNames = (await searchOnly.listTools()).tools.map((t) => t.name);
    for (const name of ONTOLOGY_TOOL_NAMES) {
      expect(searchOnlyNames).not.toContain(name);
    }

    // Direct calls to ungranted ontology tools must fail with tool_not_granted
    for (const [toolName, args] of [
      ["ontology_status", {}],
      ["ontology_search", { query: "Ada" }],
      ["ontology_check_answerable", { question: "Who is Ada?" }],
      ["ontology_certify", { term_id: "person:ada" }],
    ] as const) {
      const res = await call(searchOnly, toolName, args);
      expect(res.isError).toBe(true);
      expect(errorOf(res).error).toBe("tool_not_granted");
    }

    // Add an agent with only system_health -> sees only ontology_status
    const healthOnlyToken = addAgent(running.db, "onto-health", {
      ceiling: "personal",
      tools: ["system_health"],
    }).token;
    const healthPrincipal = authenticate(running.db, healthOnlyToken)!;
    const healthClient = await connectClient(
      { db: running.db, vaultPath: running.vaultPath, principal: healthPrincipal },
      cleanups,
    );
    expect(
      (await healthClient.listTools()).tools
        .map((t) => t.name)
        .filter((n) => n.startsWith("ontology_")),
    ).toEqual(["ontology_status"]);

    // Mid-session grant expansion to search + context_packet adds ontology_search & ontology_check_answerable
    setGrant(running.db, "onto-health", {
      tools: ["system_health", "search", "context_packet"],
    });
    expect(
      (await healthClient.listTools()).tools
        .map((t) => t.name)
        .filter((n) => n.startsWith("ontology_")),
    ).toEqual(["ontology_status", "ontology_search", "ontology_check_answerable"]);

    // Adding propose grants ontology_certify
    setGrant(running.db, "onto-health", {
      tools: ["system_health", "search", "context_packet", "propose"],
    });
    expect(
      (await healthClient.listTools()).tools
        .map((t) => t.name)
        .filter((n) => n.startsWith("ontology_")),
    ).toEqual([...ONTOLOGY_TOOL_NAMES]);

    // Revoking agent empties tools/list and refuses calls
    revokeAgent(running.db, "onto-health");
    expect((await healthClient.listTools()).tools).toEqual([]);
    const afterRevoke = await call(healthClient, "ontology_status", {});
    expect(afterRevoke.isError).toBe(true);
    expect(errorOf(afterRevoke).error).toBe("unknown_agent");
  });

  test("ontology_status never mutates a fresh vault and hides db_path from scoped agents", async () => {
    const running = live();
    const dbPath = defaultOntologyDbPath(running.vaultPath);
    expect(existsSync(dbPath)).toBe(false);

    const owner = await connectClient(running.owner(), cleanups);
    const personal = await connectClient(
      running.agent("reader-personal"),
      cleanups,
    );

    const ownerStatus = payloadOf(await call(owner, "ontology_status", {}));
    expect(ownerStatus["schema"]).toBe("kizuki.ontology-status/v1");
    expect(ownerStatus["compiled"]).toBe(false);
    expect(ownerStatus["term_count"]).toBe(0);
    expect(ownerStatus["db_path"]).toBe(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    const agentStatus = payloadOf(await call(personal, "ontology_status", {}));
    expect(agentStatus["schema"]).toBe("kizuki.ontology-status/v1");
    expect(agentStatus["compiled"]).toBe(false);
    expect(agentStatus["ceiling"]).toBe("personal");
    expect("db_path" in agentStatus).toBe(false);
    expect(existsSync(dbPath)).toBe(false);

    // Auto-compile read-only fallback on ontology_search & ontology_check_answerable
    // works without creating ontology.sqlite on disk
    const autoSearch = payloadOf(
      await call(owner, "ontology_search", { query: "Ada" }),
    );
    expect(autoSearch["schema"]).toBe("kizuki.ontology-search/v1");
    expect(autoSearch["compiled"]).toBe(false);
    expect((autoSearch["terms"] as unknown[]).length).toBeGreaterThan(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("enforces sensitivity ceiling and subject scope across search, check_answerable, status, and certify", async () => {
    const running = live();

    // Seed public, personal, and private entities + relations.
    // Keep public entities (Grace Hopper, Atlas Engine) free of private claims
    // so monotonic sensitivity keeps them visible to personal-ceiling agents,
    // while Cobalt Cipher + Private Custodian stay strictly private.
    await recordedPage(
      running.db,
      running.vaultPath,
      "entities/person-grace.md",
      {
        id: "person:grace",
        title: "Grace Hopper",
        type: "person",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["person:grace"],
      },
      "Grace Hopper leads the public Atlas Engine program.",
      [running.eventId],
    );
    await recordedPage(
      running.db,
      running.vaultPath,
      "facts/atlas-public.md",
      {
        id: "project:atlas",
        title: "Atlas Engine",
        type: "fact",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["project:atlas", "person:grace"],
      },
      "Atlas Engine is a public astronomy toolkit led by Grace Hopper.",
      [running.eventId],
    );
    await recordedPage(
      running.db,
      running.vaultPath,
      "facts/vault-cipher-private.md",
      {
        id: "secret:cobalt_cipher",
        title: "Cobalt Cipher",
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
        subjects: ["secret:cobalt_cipher"],
      },
      "Cobalt Cipher is a strictly private recovery key sequence.",
      [running.eventId],
    );
    await recordedPage(
      running.db,
      running.vaultPath,
      "facts/beta-corp.md",
      {
        id: "org:beta_corp",
        title: "Beta Corp",
        type: "fact",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["org:beta_corp"],
      },
      "Beta Corp builds weather buoys.",
      [running.eventId],
    );

    await insertClaim(
      { db: running.db, vault_path: running.vaultPath },
      {
        kind: "claim",
        producer: "owner",
        subject: "Grace Hopper",
        predicate: "project.owns",
        object: "Atlas Engine",
        body: "Grace Hopper owns Atlas Engine.",
        provenance: [running.eventId],
        sensitivity: "public",
        confidence: 0.96,
      },
    );
    await insertClaim(
      { db: running.db, vault_path: running.vaultPath },
      {
        kind: "claim",
        producer: "owner",
        subject: "Ada",
        predicate: "tool.uses",
        object: "Cobalt Cipher",
        body: "Ada uses Cobalt Cipher.",
        provenance: [running.eventId],
        sensitivity: "private",
        confidence: 0.98,
      },
    );
    rebuildDerived(running.db, running.vaultPath);

    // Compile ontology store on disk
    const dbPath = defaultOntologyDbPath(running.vaultPath);
    const store = openOntologyStore(dbPath);
    try {
      compileOntologyFromVault(running.db, store);
    } finally {
      store.close();
    }

    const owner = await connectClient(running.owner(), cleanups);
    const personal = await connectClient(
      running.agent("reader-personal"),
      cleanups,
    );

    // Owner sees Cobalt Cipher; personal agent NEVER sees it in search
    const ownerSearch = payloadOf(
      await call(owner, "ontology_search", { query: "Cobalt Cipher" }),
    );
    expect(
      (ownerSearch["terms"] as { term: { canonical_name: string } }[]).some(
        (t) => t.term.canonical_name === "Cobalt Cipher",
      ),
    ).toBe(true);

    const personalSearch = payloadOf(
      await call(personal, "ontology_search", { query: "Cobalt Cipher" }),
    );
    expect(personalSearch["ceiling"]).toBe("personal");
    expect(personalSearch["terms"]).toEqual([]);
    expect(String(personalSearch["rendered"])).not.toContain("Cobalt Cipher");

    // Personal agent sees fewer terms in ontology_status than owner
    const ownerStatus = payloadOf(await call(owner, "ontology_status", {}));
    const personalStatus = payloadOf(await call(personal, "ontology_status", {}));
    expect(ownerStatus["compiled"]).toBe(true);
    expect(Number(ownerStatus["term_count"])).toBeGreaterThan(
      Number(personalStatus["term_count"]),
    );

    // Pre-flight answerability check for personal agent:
    // 1. Public concepts with join path -> answerable with join path
    const personalAnswerable = payloadOf(
      await call(personal, "ontology_check_answerable", {
        question: "How does Grace Hopper relate to Atlas Engine?",
      }),
    );
    expect(personalAnswerable["schema"]).toBe("kizuki.ontology-check-answerable/v1");
    expect(personalAnswerable["verdict"]).toBe("answerable");
    expect(Number(personalAnswerable["coverage"])).toBeGreaterThanOrEqual(0.85);
    expect((personalAnswerable["join_paths"] as unknown[]).length).toBeGreaterThan(0);

    // 2. Private concept queried by personal agent -> missing & never leaked
    const personalPrivateCheck = payloadOf(
      await call(personal, "ontology_check_answerable", {
        question: "What is Cobalt Cipher?",
      }),
    );
    expect(personalPrivateCheck["verdict"]).toBe("unanswerable");
    expect(personalPrivateCheck["coverage"]).toBe(0);
    expect((personalPrivateCheck["resolved"] as unknown[]).length).toBe(0);
    expect((personalPrivateCheck["missing"] as string[]).length).toBeGreaterThan(0);

    // 3. Owner CAN answer the private concept question
    const ownerPrivateCheck = payloadOf(
      await call(owner, "ontology_check_answerable", {
        question: "How does Ada relate to Cobalt Cipher?",
      }),
    );
    expect(ownerPrivateCheck["verdict"]).toBe("answerable");
    expect((ownerPrivateCheck["join_paths"] as unknown[]).length).toBeGreaterThan(0);

    // 4. Personal agent CANNOT certify a private term (refused as not_found, no existence leak)
    const certifyPrivateDenied = await call(personal, "ontology_certify", {
      term_id: "secret:cobalt_cipher",
      description: "Attempted hijack",
    });
    expect(certifyPrivateDenied.isError).toBe(true);
    expect(errorOf(certifyPrivateDenied).error).toBe("not_found");

    // 5. Subject-scoped agent cannot see or certify out-of-scope terms
    const scopedToken = addAgent(running.db, "grace-only", {
      ceiling: "personal",
      subjects: ["person:grace"],
      tools: ["system_health", "search", "context_packet", "propose"],
    }).token;
    const scopedPrincipal = authenticate(running.db, scopedToken)!;
    const scopedClient = await connectClient(
      { db: running.db, vaultPath: running.vaultPath, principal: scopedPrincipal },
      cleanups,
    );
    const scopedCertifyBeta = await call(scopedClient, "ontology_certify", {
      term_id: "org:beta_corp",
      description: "Out of subject scope",
    });
    expect(scopedCertifyBeta.isError).toBe(true);
    expect(errorOf(scopedCertifyBeta).error).toBe("not_found");

    const scopedCertifyGrace = await call(scopedClient, "ontology_certify", {
      term_id: "person:grace",
      description: "In-scope certification by scoped agent.",
    });
    expect(scopedCertifyGrace.isError ?? false).toBe(false);

    // 6. Sticky certification via ontology_certify survives full vault recompilation
    const certResult = payloadOf(
      await call(personal, "ontology_certify", {
        term_id: "person:grace",
        canonical_name: "Grace Hopper (Certified Lead)",
        description: "Certified public bio for Grace Hopper.",
        synonyms: ["Rear Admiral Grace", "Lead Grace"],
      }),
    );
    expect(certResult["schema"]).toBe("kizuki.ontology-certify/v1");
    expect((certResult["term"] as { certification: string }).certification).toBe(
      "certified",
    );
    expect((certResult["term"] as { certified_by: string }).certified_by).toBe(
      "agent:reader-personal",
    );
    expect((certResult["receipt"] as { receipt_id: string }).receipt_id).toMatch(
      /^cert_/,
    );

    const verifyStore = openOntologyStore(dbPath);
    try {
      const report = compileOntologyFromVault(running.db, verifyStore);
      expect(report.preservedCertified).toBeGreaterThanOrEqual(1);
      const persisted = verifyStore.getTerm("person:grace", {
        sensitivityCeiling: "private",
      });
      expect(persisted?.certification).toBe("certified");
      expect(persisted?.canonicalName).toBe("Grace Hopper (Certified Lead)");
      expect(persisted?.description).toBe("Certified public bio for Grace Hopper.");
      expect(persisted?.synonyms).toEqual(["Rear Admiral Grace", "Lead Grace"]);
    } finally {
      verifyStore.close();
    }
  });

  test("routes ontology calls through Core serving gate for rate limiting and serve_audit logging", async () => {
    const running = live();
    const token = addAgent(running.db, "onto-rate-limited", {
      ceiling: "personal",
      tools: ["system_health", "search", "context_packet", "propose"],
      rate_limit_per_minute: 2,
    }).token;
    const principal = authenticate(running.db, token)!;
    const client = await connectClient(
      { db: running.db, vaultPath: running.vaultPath, principal },
      cleanups,
    );

    // First 2 calls succeed within rate_limit_per_minute = 2.
    const first = await call(client, "ontology_status", {});
    expect(first.isError ?? false).toBe(false);
    const second = await call(client, "ontology_search", { query: "Ada" });
    expect(second.isError ?? false).toBe(false);

    // Third call within the same minute must be refused with rate_limited.
    const third = await call(client, "ontology_search", { query: "Ada" });
    expect(third.isError).toBe(true);
    expect(errorOf(third).error).toBe("rate_limited");

    // Denied ontology call from search-only agent must also write a serve_audit denial row.
    const searchOnly = await connectClient(running.agent("search-only"), cleanups);
    const deniedRes = await call(searchOnly, "ontology_search", { query: "Ada" });
    expect(deniedRes.isError).toBe(true);
    expect(errorOf(deniedRes).error).toBe("tool_not_granted");

    const auditRows = running.db
      .query<
        { tool: string; query_shape: string; served: string; denied: string },
        []
      >(
        "SELECT tool, query_shape, served, denied FROM agent_audit ORDER BY at ASC, audit_id ASC",
      )
      .all();

    const allowedStatusRows = auditRows.filter(
      (r) =>
        r.tool === "system_health" &&
        r.query_shape.includes("ontology_tool") &&
        r.denied === "[]",
    );
    const allowedSearchRows = auditRows.filter(
      (r) =>
        r.tool === "search" &&
        r.query_shape.includes("ontology_tool") &&
        r.denied === "[]",
    );
    const deniedSearchRows = auditRows.filter(
      (r) =>
        r.tool === "search" &&
        r.query_shape.includes("ontology_tool") &&
        r.denied.includes("tool_not_granted"),
    );

    expect(allowedStatusRows.length).toBeGreaterThanOrEqual(1);
    expect(allowedSearchRows.length).toBeGreaterThanOrEqual(1);
    expect(deniedSearchRows.length).toBeGreaterThanOrEqual(1);
  });

  test("authorizes ontology subjects strictly by exact namespaced identity without stripping prefixes", async () => {
    const running = live();
    await recordedPage(
      running.db,
      running.vaultPath,
      "entities/person-atlas.md",
      {
        id: "person:atlas",
        title: "Atlas",
        type: "person",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["person:atlas"],
      },
      "Person Atlas is a cartographer.",
      [running.eventId],
    );
    await recordedPage(
      running.db,
      running.vaultPath,
      "facts/project-atlas.md",
      {
        id: "project:atlas",
        title: "Atlas",
        type: "fact",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["project:atlas"],
      },
      "Project Atlas is an orbital telemetry program.",
      [running.eventId],
    );
    rebuildDerived(running.db, running.vaultPath);

    const dbPath = defaultOntologyDbPath(running.vaultPath);
    const store = openOntologyStore(dbPath);
    try {
      compileOntologyFromVault(running.db, store);
    } finally {
      store.close();
    }

    const token = addAgent(running.db, "person-atlas-only", {
      ceiling: "personal",
      subjects: ["person:atlas"],
      tools: ["system_health", "search", "context_packet", "propose"],
    }).token;
    const principal = authenticate(running.db, token)!;
    const client = await connectClient(
      { db: running.db, vaultPath: running.vaultPath, principal },
      cleanups,
    );

    const searchPayload = payloadOf(
      await call(client, "ontology_search", { query: "Atlas" }),
    );
    const returnedIds = (
      searchPayload["terms"] as { term: { term_id: string } }[]
    ).map((entry) => entry.term.term_id);
    expect(returnedIds).toContain("person:atlas");
    expect(returnedIds).not.toContain("project:atlas");

    const certifyDenied = await call(client, "ontology_certify", {
      term_id: "project:atlas",
      description: "Cross-namespace hijack attempt",
    });
    expect(certifyDenied.isError).toBe(true);
    expect(errorOf(certifyDenied).error).toBe("not_found");
  });

  test("invalidates stale ontology cache after claim retraction and Core purge without manual recompile", async () => {
    const running = live();
    const ephemeral = accept(running.db, {
      schema: "kizuki.event/v1",
      connector_id: "fixture",
      source_record_id: "rec-ephemeral-zephyr",
      kind: "message",
      occurred_at: "2026-03-02T10:00:00Z",
      observed_at: "2026-03-02T10:01:00Z",
      text: "Zephyr Beacon is temporary.",
      subjects: [{ subject_id: "project:zephyr_beacon", role: "about" }],
      sensitivity_hint: "public",
      deleted: false,
      attachments: [],
      metadata: {},
    });
    if (ephemeral.status !== "stored") {
      throw new Error("expected ephemeral event to store");
    }

    const inserted = await insertClaim(
      { db: running.db, vault_path: running.vaultPath },
      {
        kind: "claim",
        producer: "owner",
        subject: "person:solstice_lead",
        predicate: "project.owns",
        object: "project:zephyr_beacon",
        body: "Solstice Lead owns Zephyr Beacon.",
        provenance: [ephemeral.event.event_id],
        sensitivity: "public",
        confidence: 0.95,
      },
    );

    if (inserted.outcome !== "stored") {
      throw new Error("expected claim to store");
    }

    // Persist compiled ontology.sqlite on disk.
    const dbPath = defaultOntologyDbPath(running.vaultPath);
    const store = openOntologyStore(dbPath);
    try {
      compileOntologyFromVault(running.db, store);
    } finally {
      store.close();
    }
    expect(existsSync(dbPath)).toBe(true);

    const owner = await connectClient(running.owner(), cleanups);
    const beforeSearch = payloadOf(
      await call(owner, "ontology_search", { query: "solstice_lead" }),
    );
    expect(beforeSearch["compiled"]).toBe(true);
    expect(
      (beforeSearch["terms"] as { term: { term_id: string } }[]).some(
        (t) => t.term.term_id === "person:solstice_lead",
      ),
    ).toBe(true);
    const beforeStatus = payloadOf(await call(owner, "ontology_status", {}));
    expect(beforeStatus["compiled"]).toBe(true);
    const beforeTermCount = Number(beforeStatus["term_count"]);

    // Retract the claim directly in the ledger WITHOUT manually recompiling ontology.sqlite.
    running.db
      .query("UPDATE claims SET status = 'retracted' WHERE claim_id = ?")
      .run(inserted.claim.claim_id);

    const afterRetractSearch = payloadOf(
      await call(owner, "ontology_search", { query: "solstice_lead" }),
    );
    expect(afterRetractSearch["compiled"]).toBe(false);
    expect(afterRetractSearch["terms"]).toEqual([]);

    const afterRetractStatus = payloadOf(await call(owner, "ontology_status", {}));
    expect(afterRetractStatus["compiled"]).toBe(false);
    expect(Number(afterRetractStatus["term_count"])).toBeLessThan(beforeTermCount);

    // Certify must recompile before lookup and refuse the retracted term.
    const certifyRetracted = await call(owner, "ontology_certify", {
      term_id: "person:solstice_lead",
      description: "Must fail after retraction",
    });
    expect(certifyRetracted.isError).toBe(true);
    expect(errorOf(certifyRetracted).error).toBe("not_found");

    // Re-persist ontology.sqlite, then run Core purgeEvents -> ontology.sqlite is removed and purged subject vanishes immediately.
    const store2 = openOntologyStore(dbPath);
    try {
      compileOntologyFromVault(running.db, store2);
    } finally {
      store2.close();
    }
    expect(existsSync(dbPath)).toBe(true);
    const beforePurgeSearch = payloadOf(
      await call(owner, "ontology_search", { query: "zephyr_beacon" }),
    );
    expect(
      (beforePurgeSearch["terms"] as { term: { term_id: string } }[]).some(
        (t) => t.term.term_id === "project:zephyr_beacon",
      ),
    ).toBe(true);

    purgeEvents(
      running.db,
      running.vaultPath,
      { event_id: ephemeral.event.event_id },
      "remove zephyr beacon",
    );
    expect(existsSync(dbPath)).toBe(false);

    const afterPurgeSearch = payloadOf(
      await call(owner, "ontology_search", { query: "zephyr_beacon" }),
    );
    expect(afterPurgeSearch["terms"]).toEqual([]);

    // Active non-ready purge batch must fail closed with held.
    running.db
      .query("INSERT INTO purge_batches (batch_id, state, created_at) VALUES (?, 'discovering', ?)")
      .run("batch-in-progress", "2026-03-02T12:00:00Z");
    const heldRes = await call(owner, "ontology_search", { query: "Ada" });
    expect(heldRes.isError).toBe(true);
    expect(errorOf(heldRes).error).toBe("held");
  });
});
