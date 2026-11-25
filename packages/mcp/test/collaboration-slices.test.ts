import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS, addAgent, authenticate, revokeAgent, setGrant } from "@kizuki/core";
import type { Grant, ServeContext } from "@kizuki/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COLLABORATION_AREAS,
  COLLABORATION_HOST_CONTRACT_VERSION,
  COLLABORATION_SLICE_SCHEMA,
  createMemtEngine,
  type CollaborationArea,
  type MemtEngine,
} from "@kizuki/memt";
import { createServer } from "../src/server";
import { call, envelopeOf, errorOf } from "./client";
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

async function connectClient(
  ctx: ServeContext,
  memtEngine?: MemtEngine,
  clientName = "collab-mcp-client",
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx, memtEngine === undefined ? {} : { memtEngine });
  const client = new Client({ name: clientName, version: "1.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function payloadOf(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function enrollCustomAgent(
  running: McpFixture,
  name: string,
  grant: Partial<Grant>,
): ServeContext {
  const { token } = addAgent(running.db, name, {
    ceiling: "personal",
    types: null,
    subjects: null,
    since: null,
    until: null,
    tools: [...TOOLS],
    rate_limit_per_minute: 120,
    relay_owner_corrections: false,
    ...grant,
  });
  const principal = authenticate(running.db, token);
  if (principal === null) throw new Error(`failed to authenticate ${name}`);
  return { db: running.db, vaultPath: running.vaultPath, principal };
}

describe("MCP Person x Task Collaboration Slices (B1-B7)", () => {
  test("enforces grant ceilings, subject scopes, relay_owner_corrections, and mid-session revocation across MCP tools", async () => {
    const running = live();
    const engine = createMemtEngine(running.vaultPath);
    cleanups.push(() => engine.close());

    const owner = await connectClient(running.owner(), engine, "host-owner");
    const adaAgentCtx = enrollCustomAgent(running, "ada-worker", {
      ceiling: "personal",
      subjects: ["person:ada"],
      relay_owner_corrections: false,
    });
    const adaRelayCtx = enrollCustomAgent(running, "ada-relay", {
      ceiling: "personal",
      subjects: ["person:ada"],
      relay_owner_corrections: true,
    });
    const adaAgent = await connectClient(adaAgentCtx, engine, "host-claude");
    const adaRelay = await connectClient(adaRelayCtx, engine, "host-codex");

    // Owner seeds a work rule + a private secret rule + a Bob rule
    const recPublic = await call(owner, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "communication",
      kind: "rule",
      condition: "Routine weekly sync updates",
      guidance: "Use concise status bullets except during incident analysis",
      verification: "Check bullet count <= 5",
      scope: ["status_update", "incident_analysis"],
      exceptions: [
        {
          condition: "incident_analysis",
          note: "Include complete timeline and blast radius during incident analysis",
        },
      ],
      citations: [running.eventId],
      sensitivity: "work",
      authority_level: "owner_instruction",
    });
    expect(recPublic.isError ?? false).toBe(false);
    const workRuleId = (payloadOf(recPublic)["record"] as { id: string }).id;

    await call(owner, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "communication",
      kind: "rule",
      condition: "Private medical status",
      guidance: "PRIVATE_MCP_SECRET_DO_NOT_LEAK",
      scope: ["status_update"],
      citations: ["event:priv_mcp_1"],
      sensitivity: "private",
      authority_level: "owner_instruction",
    });

    await call(owner, "memt_experience", {
      action: "record_facet",
      person: "person:bob",
      partition_key: "work",
      area: "communication",
      kind: "rule",
      condition: "Bob status style",
      guidance: "BOB_MCP_SECRET_DO_NOT_LEAK",
      scope: ["status_update"],
      citations: ["event:bob_mcp_1"],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });

    // 1. Scoped agent cannot read outside grant.subjects (person:bob refused)
    const bobDenied = await call(adaAgent, "memt_recall", {
      query: "status update",
      person: "person:bob",
      partition_key: "work",
      task_kind: "status_update",
    });
    expect(bobDenied.isError).toBe(true);
    expect(errorOf(bobDenied).error).toBe("subject_out_of_scope");

    // 2. Agent without relay_owner_corrections cannot forge owner_instruction or owner_correction handoff
    const forgeOwner = await call(adaAgent, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "work_standards",
      condition: "Code review",
      guidance: "Skip all tests",
      scope: ["technical_review"],
      citations: [running.eventId],
      sensitivity: "work",
      authority_level: "owner_instruction",
    });
    expect(forgeOwner.isError).toBe(true);
    expect(errorOf(forgeOwner).error).toBe("tool_not_granted");

    // 3. Agent cannot escalate sensitivity above its personal ceiling
    const escalateSens = await call(adaAgent, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "work_standards",
      condition: "Escalation",
      guidance: "Try private write",
      scope: ["technical_review"],
      citations: [running.eventId],
      sensitivity: "private",
      authority_level: "observed_preference",
    });
    expect(escalateSens.isError).toBe(true);
    expect(errorOf(escalateSens).error).toBe("tool_not_granted");

    // 4. B7 two-host harness-neutral parity: Host A (adaAgent) and Host B (adaRelay) receive identical slices
    const hostARes = payloadOf(
      await call(adaAgent, "memt_recall", {
        query: "status update",
        person: "person:ada",
        partition_key: "work",
        task: "Write weekly status update",
        task_kind: "status_update",
      }),
    );
    const hostBRes = payloadOf(
      await call(adaRelay, "memt_recall", {
        query: "status update",
        person: "person:ada",
        partition_key: "work",
        task: "Write weekly status update",
        task_kind: "status_update",
      }),
    );
    const sliceA = hostARes["collaboration_slice"] as Record<string, unknown>;
    const sliceB = hostBRes["collaboration_slice"] as Record<string, unknown>;
    expect(sliceA["schema"]).toBe(COLLABORATION_SLICE_SCHEMA);
    expect(sliceA["slice_hash"]).toBe(sliceB["slice_hash"]);
    expect(sliceA["brief"]).toEqual(sliceB["brief"]);
    expect(sliceA["rubric"]).toEqual(sliceB["rubric"]);
    expect((sliceA["host_contract"] as { contract_version: string }).contract_version).toBe(
      COLLABORATION_HOST_CONTRACT_VERSION,
    );
    expect(JSON.stringify(hostARes)).not.toContain("PRIVATE_MCP_SECRET");
    expect(JSON.stringify(hostARes)).not.toContain("BOB_MCP_SECRET");

    // 5. B7 stale-slice refresh unchanged
    const unchangedRes = payloadOf(
      await call(adaAgent, "memt_recall", {
        query: "status update",
        person: "person:ada",
        partition_key: "work",
        task: "Write weekly status update",
        task_kind: "status_update",
        prior_slice_hash: sliceA["slice_hash"] as string,
      }),
    );
    expect((unchangedRes["collaboration_slice"] as { refresh_status: string }).refresh_status).toBe(
      "unchanged",
    );

    // 6. B6 cross-agent learning over MCP: Agent A self-claim -> Relay owner correction -> Agent B refreshed slice -> Undo
    const agentAClaim = payloadOf(
      await call(adaAgent, "memt_experience", {
        action: "handoff",
        person: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "agent_claim",
        idempotency_key: "mcp-claim-1",
        served_slice_hash: sliceA["slice_hash"] as string,
        task: "Write weekly status update",
        work_summary: "Drafted 10-paragraph status essay",
        citations: [running.eventId],
        sensitivity: "work",
      }),
    );
    expect((agentAClaim["handoff"] as { endorsed_by_owner: boolean }).endorsed_by_owner).toBe(false);
    expect((agentAClaim["handoff"] as { outcome_status: string }).outcome_status).toBe(
      "unverified_agent_claim",
    );

    const ownerCorr = payloadOf(
      await call(adaRelay, "memt_experience", {
        action: "handoff",
        person: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "owner_correction",
        idempotency_key: "mcp-owner-corr-1",
        served_slice_hash: sliceA["slice_hash"] as string,
        task: "Write weekly status update",
        work_summary: "Owner shortened Agent A draft",
        correction_text: "Limit status updates to three crisp metric bullets only",
        supersedes_record_id: workRuleId,
        scope: ["status_update"],
        citations: ["event:owner_edit_mcp_1"],
        sensitivity: "work",
      }),
    );
    const handoffId = (ownerCorr["handoff"] as { id: string }).id;
    expect((ownerCorr["handoff"] as { endorsed_by_owner: boolean }).endorsed_by_owner).toBe(true);

    // Fresh Agent B immediately sees the owner correction and refreshed slice hash
    const freshAgentBCtx = enrollCustomAgent(running, "fresh-agent-b", {
      ceiling: "personal",
      subjects: ["person:ada"],
    });
    const freshAgentB = await connectClient(freshAgentBCtx, engine, "host-fresh-b");
    const refreshedB = payloadOf(
      await call(freshAgentB, "memt_recall", {
        query: "status update",
        person: "person:ada",
        partition_key: "work",
        task: "Write weekly status update",
        task_kind: "status_update",
        prior_slice_hash: sliceA["slice_hash"] as string,
      }),
    );
    const sliceBRefreshed = refreshedB["collaboration_slice"] as {
      refresh_status: string;
      slice_hash: string;
      brief: { active_rules: { guidance: string }[] };
    };
    expect(sliceBRefreshed.refresh_status).toBe("refreshed");
    expect(sliceBRefreshed.slice_hash).not.toBe(sliceA["slice_hash"]);
    expect(sliceBRefreshed.brief.active_rules.map((r) => r.guidance)).toEqual([
      "Limit status updates to three crisp metric bullets only",
    ]);

    // context_packet also appends Collaboration Brief for permitted person subject within budget
    engine.collaboration.recordFacet({
      person_id: "person:ada",
      partition_key: "default",
      area: "communication",
      kind: "rule",
      condition: "Kettle status brief",
      guidance: "Report kettle temperature and readiness in two bullets",
      scope: ["kettle", "status_update"],
      evidence_refs: [running.eventId],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });
    const packetCall = await call(freshAgentB, "context_packet", {
      purpose: "recall",
      query: "kettle readiness status",
      budget_tokens: 1000,
    });
    expect(packetCall.isError ?? false).toBe(false);
    const packetEnv = envelopeOf(packetCall);
    const packetMd = (
      packetEnv["data"] as { result: { data: { packetMd: string; tokens: number; budgetTokens: number } } }
    ).result.data;
    expect(packetMd.packetMd).toContain("## Collaboration Brief");
    expect(packetMd.packetMd).toContain("Report kettle temperature and readiness in two bullets");
    expect(packetMd.tokens).toBeLessThanOrEqual(packetMd.budgetTokens);

    // Undo handoff reverts correction and restores prior rule
    const undone = payloadOf(
      await call(adaRelay, "memt_experience", {
        action: "undo_handoff",
        id: handoffId,
      }),
    );
    expect(undone["undone"]).toBe(true);
    expect(undone["restored_record_id"]).toBe(workRuleId);

    // Mid-session grant narrowing and revocation immediately cut off access
    setGrant(running.db, "ada-worker", { subjects: [] });
    const narrowed = await call(adaAgent, "memt_recall", {
      query: "status update",
      person: "person:ada",
      partition_key: "work",
    });
    expect(narrowed.isError).toBe(true);
    expect(errorOf(narrowed).error).toBe("subject_out_of_scope");

    revokeAgent(running.db, "ada-worker");
    const revoked = await call(adaAgent, "memt_recall", {
      query: "status update",
      person: "person:ada",
      partition_key: "work",
    });
    expect(revoked.isError).toBe(true);
    expect(errorOf(revoked).error).toBe("unknown_agent");
  });

  test("End-to-end MCP fresh-agent recall >= 92% with 0 leaks across 15 scenarios and adversarial decoys", async () => {
    const running = live();
    const engine = createMemtEngine(running.vaultPath);
    cleanups.push(() => engine.close());

    const owner = await connectClient(running.owner(), engine, "mcp-seed-owner");

    const SCENARIOS: readonly {
      id: string;
      area: CollaborationArea;
      taskKind: string;
      condition: string;
      guidance: string;
      prompt: string;
      exception?: { condition: string; note: string };
      expectException?: boolean;
    }[] = [
      {
        id: "m01",
        area: "communication",
        taskKind: "weekly_update",
        condition: "Weekly launch update",
        guidance: "Keep weekly updates to three metric bullets",
        prompt: "Write a weekly update on launch metrics",
      },
      {
        id: "m02",
        area: "communication",
        taskKind: "incident_postmortem",
        condition: "Status updates",
        guidance: "Use short summaries for routine syncs",
        prompt: "Write an incident postmortem for the queue outage",
        exception: {
          condition: "incident_postmortem",
          note: "Include complete outage timeline and root-cause proof in incident postmortem",
        },
        expectException: true,
      },
      {
        id: "m03",
        area: "work_standards",
        taskKind: "code_review",
        condition: "Code review feedback",
        guidance: "Rank findings by severity with file and line citations",
        prompt: "Do a thorough code review of the storage patch",
      },
      {
        id: "m04",
        area: "work_standards",
        taskKind: "schema_migration",
        condition: "SQLite schema changes",
        guidance: "Verify fresh database and upgrade migration tests in strict mode",
        prompt: "Review the SQLite schema migration for claim indexes",
      },
      {
        id: "m05",
        area: "work_standards",
        taskKind: "security_review",
        condition: "Access control testing",
        guidance: "Prove both allowed and forbidden grant paths fail closed",
        prompt: "Run a security review on the new MCP endpoint grants",
      },
      {
        id: "m06",
        area: "collaboration_protocol",
        taskKind: "autonomous_fix",
        condition: "Reversible code fixes",
        guidance: "Apply authorized fixes and verify directly without asking",
        prompt: "Perform an autonomous fix on the broken tokenizer edge case",
      },
      {
        id: "m07",
        area: "collaboration_protocol",
        taskKind: "external_draft",
        condition: "Outbound partner emails",
        guidance: "Draft external emails locally and hold final send for approval",
        prompt: "Prepare an external draft email for the beta cohort",
      },
      {
        id: "m08",
        area: "collaboration_protocol",
        taskKind: "branch_handoff",
        condition: "End of session handoff",
        guidance: "Record exact head commit SHA and reproducible test receipts",
        prompt: "Write the branch handoff receipt for the next maintainer",
      },
      {
        id: "m09",
        area: "knowledge",
        taskKind: "mcp_transport",
        condition: "MCP stdio server architecture",
        guidance: "Keep stdout strictly JSON-RPC and send diagnostics to stderr",
        prompt: "Audit the MCP transport logging behavior",
      },
      {
        id: "m10",
        area: "knowledge",
        taskKind: "canon_receipts",
        condition: "Canon page updates",
        guidance: "Write canon pages only through the reversible receipted writer",
        prompt: "Trace how canon receipts track before and after hashes",
      },
      {
        id: "m11",
        area: "decision_values",
        taskKind: "dependency_check",
        condition: "Adding workspace dependencies",
        guidance: "Favor zero-dependency TypeScript utilities over transitive packages",
        prompt: "Perform a dependency check before importing a new parser package",
      },
      {
        id: "m12",
        area: "decision_values",
        taskKind: "noninterference_check",
        condition: "Scoped memory serving",
        guidance: "Apply ceiling and consent filters before ranking or counting",
        prompt: "Verify noninterference check behavior on hidden private records",
      },
      {
        id: "m13",
        area: "developing_taste",
        taskKind: "editorial_poster",
        condition: "Launch poster art direction",
        guidance: "Use crisp Swiss typographic grid with one dominant focal numeral",
        prompt: "Design an editorial poster for the release announcement",
      },
      {
        id: "m14",
        area: "developing_taste",
        taskKind: "dense_dashboard",
        condition: "Developer telemetry UI",
        guidance: "Display dense tabular numerals with zero decorative idle pulses",
        prompt: "Build the dense dashboard view for MemT partition health",
      },
      {
        id: "m15",
        area: "developing_taste",
        taskKind: "release_copy",
        condition: "Public documentation prose",
        guidance: "Remove em-dashes and vague hype adjectives in favor of concrete proof",
        prompt: "Edit the release copy for the CLI command reference",
      },
    ];

    for (const s of SCENARIOS) {
      const res = await call(owner, "memt_experience", {
        action: "record_facet",
        person: "person:ada",
        partition_key: "work",
        area: s.area,
        kind: "rule",
        condition: s.condition,
        guidance: s.guidance,
        scope: [s.taskKind],
        ...(s.exception !== undefined ? { exceptions: [s.exception] } : {}),
        citations: [`event:mcp_ev_${s.id}`],
        sensitivity: "work",
        authority_level: s.area === "developing_taste" ? "inferred_taste" : "owner_instruction",
      });
      expect(res.isError ?? false).toBe(false);

      // Adversarial private, cross-partition, and cross-person decoys for every scenario
      await call(owner, "memt_experience", {
        action: "record_facet",
        person: "person:ada",
        partition_key: "work",
        area: s.area,
        kind: "rule",
        condition: s.condition,
        guidance: `MCP_LEAK_PRIV_${s.id} private health record`,
        scope: [s.taskKind, "all"],
        citations: [`event:mcp_priv_${s.id}`],
        sensitivity: "private",
        authority_level: "owner_instruction",
      });
      await call(owner, "memt_experience", {
        action: "record_facet",
        person: "person:ada",
        partition_key: "diary",
        area: s.area,
        kind: "rule",
        condition: s.condition,
        guidance: `MCP_LEAK_PART_${s.id} diary-only entry`,
        scope: [s.taskKind, "all"],
        citations: [`event:mcp_part_${s.id}`],
        sensitivity: "public",
        authority_level: "owner_instruction",
      });
      await call(owner, "memt_experience", {
        action: "record_facet",
        person: "person:bob",
        partition_key: "work",
        area: s.area,
        kind: "rule",
        condition: s.condition,
        guidance: `MCP_LEAK_BOB_${s.id} bob-only rule`,
        scope: [s.taskKind, "all"],
        citations: [`event:mcp_bob_${s.id}`],
        sensitivity: "public",
        authority_level: "owner_instruction",
      });
    }

    // Fresh MCP agent connects cold with personal ceiling (cannot see private) and person:ada subject scope
    const freshCtx = enrollCustomAgent(running, "fresh-mcp-eval", {
      ceiling: "personal",
      subjects: ["person:ada"],
    });
    const freshClient = await connectClient(freshCtx, engine, "fresh-eval-host");

    let hits = 0;
    let leaks = 0;
    for (const s of SCENARIOS) {
      const res = await call(freshClient, "memt_recall", {
        query: s.prompt,
        person: "person:ada",
        partition_key: "work",
      });
      expect(res.isError ?? false).toBe(false);
      const payload = payloadOf(res);
      const wire = JSON.stringify(payload);
      if (
        wire.includes("MCP_LEAK_PRIV_") ||
        wire.includes("MCP_LEAK_PART_") ||
        wire.includes("MCP_LEAK_BOB_")
      ) {
        leaks += 1;
      }

      const slice = payload["collaboration_slice"] as {
        areas: Record<CollaborationArea, { status: string }>;
        brief: {
          active_rules: { guidance: string }[];
          triggered_exceptions: { exception_note: string }[];
        };
      };
      for (const area of COLLABORATION_AREAS) {
        expect(slice.areas[area].status).toBe("known");
      }

      const matched = s.expectException
        ? slice.brief.triggered_exceptions.some((ex) => ex.exception_note === s.exception!.note)
        : slice.brief.active_rules.some((r) => r.guidance === s.guidance);
      if (matched) hits += 1;
    }

    expect(leaks).toBe(0);
    expect(hits / SCENARIOS.length).toBeGreaterThanOrEqual(0.92);
  });
});
