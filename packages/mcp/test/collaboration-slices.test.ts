import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS, accept, addAgent, authenticate, revokeAgent, setGrant } from "@kizuki/core";
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

    // 0. Advertised MCP schema includes all collaboration inputs and stays strict
    const listedTools = await owner.listTools();
    const expTool = listedTools.tools.find((t) => t.name === "memt_experience");
    const expProps = (expTool?.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: boolean })
      ?.properties ?? {};
    for (const requiredCollabField of [
      "person",
      "partition_key",
      "area",
      "kind",
      "guidance",
      "scope",
      "exceptions",
      "source_roots",
      "authority_level",
      "idempotency_key",
      "served_slice_hash",
      "task",
      "work_summary",
      "correction_text",
      "stage",
      "historical_complete",
      "resume_cursor",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(expProps, requiredCollabField)).toBe(true);
    }

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

    const recPriv = await call(owner, "memt_experience", {
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
    expect(recPriv.isError ?? false).toBe(false);

    const recBob = await call(owner, "memt_experience", {
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
    expect(recBob.isError ?? false).toBe(false);

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

    // 3b. Non-owner agent cannot mutate connection progress, and read-only progress respects caller ceiling
    const mutateProgressDenied = await call(adaAgent, "memt_experience", {
      action: "progress",
      person: "person:ada",
      partition_key: "work",
      stage: "connecting",
      historical_complete: false,
    });
    expect(mutateProgressDenied.isError).toBe(true);
    expect(errorOf(mutateProgressDenied).error).toBe("tool_not_granted");

    const agentReadProgress = payloadOf(
      await call(adaAgent, "memt_experience", {
        action: "progress",
        person: "person:ada",
        partition_key: "work",
      }),
    );
    expect((agentReadProgress["progress"] as { high_info_indexed: number }).high_info_indexed).toBe(1);

    // 3c. Single evidence ref with its own source_root stays hypothesis (never corroborated)
    const ownRootFacet = await call(adaAgent, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "developing_taste",
      kind: "rule",
      condition: "Chart labels",
      guidance: "Use tabular numerals on axes",
      scope: ["charts"],
      citations: ["event:chart_ev_1"],
      source_roots: ["design_review_thread"],
      sensitivity: "work",
      authority_level: "inferred_taste",
    });
    expect(ownRootFacet.isError ?? false).toBe(false);
    const ownRootRec = payloadOf(ownRootFacet)["record"] as {
      epistemic_status: string;
      source_roots: string[];
    };
    expect(ownRootRec.source_roots).toEqual(["design_review_thread"]);
    expect(ownRootRec.epistemic_status).toBe("hypothesis");

    // 3d. Budget below mandatory slice envelope fails closed with invalid_arguments
    const tooSmallBudget = await call(adaAgent, "memt_recall", {
      query: "status update",
      person: "person:ada",
      partition_key: "work",
      budget_tokens: 100,
    });
    expect(tooSmallBudget.isError).toBe(true);
    expect(errorOf(tooSmallBudget).error).toBe("invalid_arguments");

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

    // context_packet v2: view token tracks final packet including Collaboration Brief,
    // refreshes cleanly when a new permitted rule is added, and emits each heading ONCE.
    const packetBeforeCall = await call(freshAgentB, "context_packet", {
      purpose: "session",
      budget_tokens: 1000,
    });
    expect(packetBeforeCall.isError ?? false).toBe(false);
    const packetBeforeEnv = envelopeOf(packetBeforeCall);
    const packetBeforeResult = (
      packetBeforeEnv["data"] as {
        result: {
          status: string;
          view: { kind: "view"; token: string };
          data: { packetMd: string; tokens: number; budgetTokens: number };
        };
      }
    ).result;
    expect(packetBeforeResult.status).toBe("current");
    expect(packetBeforeResult.data.packetMd).not.toContain("## Collaboration Brief");
    const viewBeforeRule = packetBeforeResult.view;

    // Add TWO permitted rules (which also derive rubric items -> 4 collaboration lines total)
    engine.collaboration.recordFacet({
      person_id: "person:ada",
      partition_key: "default",
      area: "communication",
      kind: "rule",
      condition: "Kettle status brief",
      guidance: "Report kettle temperature and readiness in two bullets",
      verification: "Check temperature and readiness bullet count",
      scope: ["session", "kettle", "status_update"],
      evidence_refs: [running.eventId],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });
    engine.collaboration.recordFacet({
      person_id: "person:ada",
      partition_key: "default",
      area: "work_standards",
      kind: "rule",
      condition: "Kettle safety check",
      guidance: "Verify kettle valve seal pressure before reporting ready",
      verification: "Confirm valve seal check recorded",
      scope: ["session", "kettle", "readiness"],
      evidence_refs: ["event:kettle_safety_2"],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });

    // Refreshing with priorView from BEFORE the new rule MUST return current (NOT unchanged!)
    const packetRefreshedCall = await call(freshAgentB, "context_packet", {
      purpose: "session",
      budget_tokens: 1000,
      priorView: viewBeforeRule,
    });
    expect(packetRefreshedCall.isError ?? false).toBe(false);
    const packetRefreshedEnv = envelopeOf(packetRefreshedCall);
    const packetRefreshedResult = (
      packetRefreshedEnv["data"] as {
        result: {
          status: string;
          view: { kind: "view"; token: string };
          data: { packetMd: string; tokens: number; budgetTokens: number };
        };
      }
    ).result;
    expect(packetRefreshedResult.status).toBe("current");
    expect(packetRefreshedResult.view.token).not.toBe(viewBeforeRule.token);
    expect(packetRefreshedResult.data.packetMd).toContain("## Collaboration Brief");
    expect(
      packetRefreshedResult.data.packetMd.match(/## Collaboration Brief/g)?.length ?? 0,
    ).toBe(1);
    expect(packetRefreshedResult.data.packetMd).toContain(
      "Report kettle temperature and readiness in two bullets",
    );
    expect(packetRefreshedResult.data.packetMd).toContain(
      "Verify kettle valve seal pressure before reporting ready",
    );
    expect(packetRefreshedResult.data.tokens).toBeLessThanOrEqual(
      packetRefreshedResult.data.budgetTokens,
    );

    // Refreshing again with the new view token when nothing changed returns unchanged
    const packetUnchangedCall = await call(freshAgentB, "context_packet", {
      purpose: "session",
      budget_tokens: 1000,
      priorView: packetRefreshedResult.view,
    });
    expect(packetUnchangedCall.isError ?? false).toBe(false);
    const packetUnchangedResult = (
      envelopeOf(packetUnchangedCall)["data"] as {
        result: { status: string; view: { kind: "view"; token: string } };
      }
    ).result;
    expect(packetUnchangedResult.status).toBe("unchanged");
    expect(packetUnchangedResult.view.token).toBe(packetRefreshedResult.view.token);

    // Adding a hidden PRIVATE rule must keep the personal-ceiling caller's refresh unchanged
    engine.collaboration.recordFacet({
      person_id: "person:ada",
      partition_key: "default",
      area: "communication",
      kind: "rule",
      condition: "Private kettle secret",
      guidance: "PRIVATE_KETTLE_NEVER_LEAK",
      scope: ["session", "kettle", "readiness"],
      evidence_refs: ["event:kettle_priv_3"],
      sensitivity: "private",
      authority_level: "owner_instruction",
    });
    const packetStillUnchanged = (
      envelopeOf(
        await call(freshAgentB, "context_packet", {
          purpose: "session",
          budget_tokens: 1000,
          priorView: packetRefreshedResult.view,
        }),
      )["data"] as { result: { status: string } }
    ).result;
    expect(packetStillUnchanged.status).toBe("unchanged");

    // Recall context_packet with query also appends a single Collaboration Brief within budget
    const recallPacketCall = await call(freshAgentB, "context_packet", {
      purpose: "recall",
      query: "kettle readiness status",
      budget_tokens: 1000,
    });
    expect(recallPacketCall.isError ?? false).toBe(false);
    const recallPacketData = (
      envelopeOf(recallPacketCall)["data"] as {
        result: { data: { packetMd: string; tokens: number; budgetTokens: number } };
      }
    ).result.data;
    expect(recallPacketData.packetMd.match(/## Collaboration Brief/g)?.length ?? 0).toBe(1);
    expect(recallPacketData.packetMd).toContain("Report kettle temperature and readiness in two bullets");
    expect(recallPacketData.packetMd).not.toContain("PRIVATE_KETTLE_NEVER_LEAK");
    expect(recallPacketData.tokens).toBeLessThanOrEqual(recallPacketData.budgetTokens);

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
      const privDecoy = await call(owner, "memt_experience", {
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
      expect(privDecoy.isError ?? false).toBe(false);
      expect((payloadOf(privDecoy)["record"] as { id?: string })?.id).toBeTruthy();

      const partDecoy = await call(owner, "memt_experience", {
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
      expect(partDecoy.isError ?? false).toBe(false);
      expect((payloadOf(partDecoy)["record"] as { id?: string })?.id).toBeTruthy();

      const bobDecoy = await call(owner, "memt_experience", {
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
      expect(bobDecoy.isError ?? false).toBe(false);
      expect((payloadOf(bobDecoy)["record"] as { id?: string })?.id).toBeTruthy();
    }

    // Prove every decoy is actually stored and owner-readable before testing the fresh agent
    for (const s of SCENARIOS) {
      const ownerPriv = await call(owner, "memt_recall", {
        query: s.prompt,
        person: "person:ada",
        partition_key: "work",
        task_kind: s.taskKind,
        budget_tokens: 2000,
      });
      expect(ownerPriv.isError ?? false).toBe(false);
      expect(JSON.stringify(payloadOf(ownerPriv))).toContain(`MCP_LEAK_PRIV_${s.id}`);

      const ownerPart = await call(owner, "memt_recall", {
        query: s.prompt,
        person: "person:ada",
        partition_key: "diary",
        task_kind: s.taskKind,
        budget_tokens: 2000,
      });
      expect(ownerPart.isError ?? false).toBe(false);
      expect(JSON.stringify(payloadOf(ownerPart))).toContain(`MCP_LEAK_PART_${s.id}`);

      const ownerBob = await call(owner, "memt_recall", {
        query: s.prompt,
        person: "person:bob",
        partition_key: "work",
        task_kind: s.taskKind,
        budget_tokens: 2000,
      });
      expect(ownerBob.isError ?? false).toBe(false);
      expect(JSON.stringify(payloadOf(ownerBob))).toContain(`MCP_LEAK_BOB_${s.id}`);
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

  test("revalidates live Kizuki event purge/revocation/window/type on recall and enforces tools/list <= 38 KB", async () => {
    const running = live();
    const engine = createMemtEngine(running.vaultPath);
    cleanups.push(() => engine.close());

    const owner = await connectClient(running.owner(), engine, "owner-ev");
    const listed = await owner.listTools();
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(38 * 1024);

    // Ingest real Kizuki ledger events via accept()
    const ts = "2026-10-01T10:00:00Z";
    const evLive = accept(running.db, {
      schema: "kizuki.event/v1",
      connector_id: "fixture",
      source_record_id: "rec-checklist-live",
      kind: "note",
      occurred_at: ts,
      observed_at: ts,
      text: "Ada likes crisp checklists",
      subjects: [{ subject_id: "person:ada", role: "from" }],
      sensitivity_hint: "public",
      deleted: false,
      attachments: [],
      metadata: {},
    });
    const evPurged = accept(running.db, {
      schema: "kizuki.event/v1",
      connector_id: "fixture",
      source_record_id: "rec-checklist-purged",
      kind: "note",
      occurred_at: ts,
      observed_at: ts,
      text: "Purged event rule",
      subjects: [{ subject_id: "person:ada", role: "from" }],
      sensitivity_hint: "public",
      deleted: false,
      attachments: [],
      metadata: {},
    });
    if (evLive.status !== "stored" || evPurged.status !== "stored") {
      throw new Error("failed to store test events");
    }
    const liveEventId = evLive.event.event_id;
    const purgedEventId = evPurged.event.event_id;

    const recLive = await call(owner, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "work_standards",
      kind: "rule",
      condition: "When reviewing checklists",
      guidance: "Keep every checklist item verifiable in one line",
      scope: ["checklists"],
      citations: [liveEventId],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });
    expect(recLive.isError ?? false).toBe(false);

    const recPurged = await call(owner, "memt_experience", {
      action: "record_facet",
      person: "person:ada",
      partition_key: "work",
      area: "work_standards",
      kind: "rule",
      condition: "When reviewing checklists",
      guidance: "PURGED_SOURCE_RULE_MUST_VANISH",
      scope: ["checklists"],
      citations: [purgedEventId],
      sensitivity: "public",
      authority_level: "owner_instruction",
    });
    expect(recPurged.isError ?? false).toBe(false);

    // Record an event_purge receipt for purgedEventId without calling MemT purge manually:
    // live evidence revalidation must withhold the facet immediately on MCP recall!
    running.db.query(
      `INSERT INTO event_purges (receipt_id, event_id, connector_id, reason, purged_at)
       VALUES ('purge-92', ?, 'local', 'owner_request', ?)`,
    ).run(purgedEventId, "2026-10-02T00:00:00Z");

    const agentCtx = enrollCustomAgent(running, "window-agent", {
      ceiling: "public",
      subjects: ["person:ada"],
      types: ["note"],
    });
    const agent = await connectClient(agentCtx, engine, "window-host");
    const recall1 = await call(agent, "memt_recall", {
      query: "reviewing checklists",
      person: "person:ada",
      partition_key: "work",
      task_kind: "checklists",
    });
    expect(recall1.isError ?? false).toBe(false);
    const wire1 = JSON.stringify(payloadOf(recall1));
    expect(wire1).toContain("Keep every checklist item verifiable in one line");
    expect(wire1).not.toContain("PURGED_SOURCE_RULE_MUST_VANISH");

    // Event-type and time-window narrowing on the agent grant immediately withholds the facet
    const wrongTypeCtx = enrollCustomAgent(running, "wrong-type-agent", {
      ceiling: "public",
      subjects: ["person:ada"],
      types: ["email"],
    });
    const wrongTypeAgent = await connectClient(wrongTypeCtx, engine, "wrong-type-host");
    const recallWrongType = await call(wrongTypeAgent, "memt_recall", {
      query: "reviewing checklists",
      person: "person:ada",
      partition_key: "work",
      task_kind: "checklists",
    });
    expect(recallWrongType.isError ?? false).toBe(false);
    expect(JSON.stringify(payloadOf(recallWrongType))).not.toContain(
      "Keep every checklist item verifiable in one line",
    );

    const outOfWindowCtx = enrollCustomAgent(running, "out-of-window-agent", {
      ceiling: "public",
      subjects: ["person:ada"],
      types: ["note"],
      since: "2026-10-05T00:00:00Z",
    });
    const outOfWindowAgent = await connectClient(outOfWindowCtx, engine, "out-of-window-host");
    const recallOutOfWindow = await call(outOfWindowAgent, "memt_recall", {
      query: "reviewing checklists",
      person: "person:ada",
      partition_key: "work",
      task_kind: "checklists",
    });
    expect(recallOutOfWindow.isError ?? false).toBe(false);
    expect(JSON.stringify(payloadOf(recallOutOfWindow))).not.toContain(
      "Keep every checklist item verifiable in one line",
    );

    // Purging the live event in event_purges immediately withholds its facet too
    running.db.query(
      `INSERT INTO event_purges (receipt_id, event_id, connector_id, reason, purged_at)
       VALUES ('purge-91', ?, 'fixture', 'owner_request', ?)`,
    ).run(liveEventId, "2026-10-02T00:00:00Z");
    const recall2 = await call(agent, "memt_recall", {
      query: "reviewing checklists",
      person: "person:ada",
      partition_key: "work",
      task_kind: "checklists",
    });
    expect(recall2.isError ?? false).toBe(false);
    expect(JSON.stringify(payloadOf(recall2))).not.toContain(
      "Keep every checklist item verifiable in one line",
    );

    // Agent restricted to person:bob cannot undo a person:ada handoff
    const adaSliceHash = (payloadOf(recall1)["collaboration_slice"] as { slice_hash: string }).slice_hash;
    const adaHandoff = await call(owner, "memt_experience", {
      action: "handoff",
      idempotency_key: "owner-undo-scope-test",
      person: "person:ada",
      partition_key: "work",
      area: "work_standards",
      kind: "owner_correction",
      served_slice_hash: adaSliceHash,
      task: "reviewing checklists",
      work_summary: "Owner correction on checklists",
      correction_text: "Always attach proof links to checklist items",
      citations: ["event:manual_proof_1"],
      sensitivity: "public",
    });
    expect(adaHandoff.isError ?? false).toBe(false);
    const handoffId = (payloadOf(adaHandoff)["handoff"] as { id: string }).id;

    const bobRelayCtx = enrollCustomAgent(running, "bob-relay", {
      ceiling: "public",
      subjects: ["person:bob"],
      relay_owner_corrections: true,
    });
    const bobRelay = await connectClient(bobRelayCtx, engine, "bob-host");
    const undoDenied = await call(bobRelay, "memt_experience", {
      action: "undo_handoff",
      id: handoffId,
    });
    expect(undoDenied.isError).toBe(true);
    expect(errorOf(undoDenied).error).toBe("not_found");
  });
});
