import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLABORATION_AREAS,
  COLLABORATION_HOST_CONTRACT_VERSION,
  COLLABORATION_SLICE_SCHEMA,
  CollaborationSliceStore,
  createMemtEngine,
  openMemtRegistryDb,
  rubricRequirementLevelFor,
  type CollaborationArea,
  type MemtEngine,
} from "../src/index";

const tempDirs: string[] = [];

function makeTempVault(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Person x Task Collaboration Slices (B1-B7)", () => {
  test("B1: recovers all six collaboration areas independently and keeps absent areas explicitly unknown", () => {
    const db = openMemtRegistryDb(":memory:");
    const store = new CollaborationSliceStore({ db });
    try {
      const seed: readonly { area: CollaborationArea; cond: string; guidance: string; ev: string }[] = [
        {
          area: "communication",
          cond: "Routine engineering status sync",
          guidance: "Use concise bullet summaries with clear blockers first",
          ev: "event:b1_comm",
        },
        {
          area: "work_standards",
          cond: "Production pull request review",
          guidance: "Require deterministic regression tests on public seams",
          ev: "event:b1_std",
        },
        {
          area: "collaboration_protocol",
          cond: "Autonomous bug fix execution",
          guidance: "Proceed without asking permission on reversible edits",
          ev: "event:b1_proto",
        },
        {
          area: "knowledge",
          cond: "SQLite storage architecture tasks",
          guidance: "Owner already knows WAL, FTS5, and strict tables deeply",
          ev: "event:b1_know",
        },
        {
          area: "decision_values",
          cond: "Privacy vs convenience tradeoff",
          guidance: "Fail closed on missing grant or provenance over partial convenience",
          ev: "event:b1_val",
        },
        {
          area: "developing_taste",
          cond: "Minimal Swiss launch poster layout",
          guidance: "Prefer monumental grotesk numerals and restrained negative space",
          ev: "event:b1_taste",
        },
      ];

      for (const item of seed) {
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: item.area,
          kind: "rule",
          condition: item.cond,
          guidance: item.guidance,
          scope: ["all"],
          evidence_refs: [item.ev],
          sensitivity: "work",
          authority_level: "observed_preference",
        });
      }

      const fullSlice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Prepare launch review summary and visual poster checklist",
        sensitivityCeiling: "work",
      });

      expect(fullSlice.schema).toBe(COLLABORATION_SLICE_SCHEMA);
      expect(fullSlice.grants_action_authority).toBe(false);
      for (const area of COLLABORATION_AREAS) {
        expect(fullSlice.areas[area].status).toBe("known");
        expect(fullSlice.areas[area].record_count).toBe(1);
      }
      expect(fullSlice.brief.insufficient_areas).toEqual([]);
      expect("personality" in fullSlice).toBe(false);

      // Person with evidence in only 2 areas keeps the remaining 4 explicitly unknown
      store.recordFacet({
        person_id: "person:lin",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "Weekly notes",
        guidance: "Lead with metric deltas",
        scope: ["status_update"],
        evidence_refs: ["event:lin_comm"],
        sensitivity: "public",
      });
      store.recordFacet({
        person_id: "person:lin",
        partition_key: "work",
        area: "work_standards",
        kind: "rule",
        condition: "Release verification",
        guidance: "Attach exact command outputs",
        scope: ["release"],
        evidence_refs: ["event:lin_std"],
        sensitivity: "public",
      });

      const partialSlice = store.compileSlice({
        person_id: "person:lin",
        partition_key: "work",
        task: "Draft weekly status update",
        task_kind: "status_update",
        sensitivityCeiling: "public",
      });

      expect(partialSlice.areas.communication.status).toBe("known");
      expect(partialSlice.areas.work_standards.status).toBe("known");
      for (const missingArea of [
        "collaboration_protocol",
        "knowledge",
        "decision_values",
        "developing_taste",
      ] as const) {
        expect(partialSlice.areas[missingArea].status).toBe("unknown");
        expect(partialSlice.areas[missingArea].reason).toBe("no_permitted_evidence");
      }
      expect(partialSlice.brief.insufficient_areas.map((a) => a.area).sort()).toEqual([
        "collaboration_protocol",
        "decision_values",
        "developing_taste",
        "knowledge",
      ]);
    } finally {
      db.close();
    }
  });

  test("B2: compiles distinct Person x Task guidance and preserves strict noninterference against hidden records", () => {
    const db = openMemtRegistryDb(":memory:");
    const store = new CollaborationSliceStore({ db });
    try {
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "Short weekly status update",
        guidance: "Cap weekly status updates at three concise bullets",
        scope: ["status_update"],
        evidence_refs: ["event:status_1", "event:status_2"],
        sensitivity: "work",
        authority_level: "owner_instruction",
      });
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "work_standards",
        kind: "rule",
        condition: "Deep technical architecture review",
        guidance: "Include failure modes, rollback plan, and SQL query plans",
        scope: ["technical_review"],
        evidence_refs: ["event:tech_1", "event:tech_2"],
        sensitivity: "work",
        authority_level: "owner_instruction",
      });

      const statusSliceBefore = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Write a short status update for Friday sync",
        task_kind: "status_update",
        sensitivityCeiling: "work",
        allowedSubjects: ["person:ada"],
      });
      const reviewSliceBefore = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Conduct a detailed technical review of storage layer",
        task_kind: "technical_review",
        sensitivityCeiling: "work",
        allowedSubjects: ["person:ada"],
      });

      expect(statusSliceBefore.brief.active_rules.map((r) => r.guidance)).toEqual([
        "Cap weekly status updates at three concise bullets",
      ]);
      expect(reviewSliceBefore.brief.active_rules.map((r) => r.guidance)).toEqual([
        "Include failure modes, rollback plan, and SQL query plans",
      ]);
      expect(statusSliceBefore.slice_hash).not.toBe(reviewSliceBefore.slice_hash);

      // Inject 30 unrelated private, other-partition, and other-person records matching the exact same task terms
      for (let i = 0; i < 10; i += 1) {
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: "communication",
          kind: "rule",
          condition: `Private status update secret #${i}`,
          guidance: `PRIVATE_MARKER_${i} mention private medical schedule in weekly status update`,
          scope: ["status_update"],
          evidence_refs: [`event:priv_${i}`],
          sensitivity: "private",
          authority_level: "owner_instruction",
        });
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "personal-journal",
          area: "communication",
          kind: "rule",
          condition: `Other partition status update #${i}`,
          guidance: `OTHER_PART_MARKER_${i} personal reflection note`,
          scope: ["status_update"],
          evidence_refs: [`event:other_part_${i}`],
          sensitivity: "public",
          authority_level: "owner_instruction",
        });
        store.recordFacet({
          person_id: "person:bob",
          partition_key: "work",
          area: "communication",
          kind: "rule",
          condition: `Bob status update #${i}`,
          guidance: `BOB_MARKER_${i} write long narrative essays for status updates`,
          scope: ["status_update"],
          evidence_refs: [`event:bob_${i}`],
          sensitivity: "public",
          authority_level: "owner_instruction",
        });
      }

      // Recompile under the same grant: byte-for-byte identical (strict noninterference)
      const statusSliceAfter = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Write a short status update for Friday sync",
        task_kind: "status_update",
        sensitivityCeiling: "work",
        allowedSubjects: ["person:ada"],
      });

      expect(statusSliceAfter).toEqual(statusSliceBefore);
      const serialized = JSON.stringify(statusSliceAfter);
      expect(serialized).not.toContain("PRIVATE_MARKER");
      expect(serialized).not.toContain("OTHER_PART_MARKER");
      expect(serialized).not.toContain("BOB_MARKER");

      // Disallowed subject returns empty slice with zero leaks
      const deniedSubjectSlice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Write a short status update for Friday sync",
        task_kind: "status_update",
        sensitivityCeiling: "private",
        allowedSubjects: ["person:bob"],
      });
      expect(deniedSubjectSlice.brief.active_rules).toEqual([]);
      expect(deniedSubjectSlice.areas.communication.status).toBe("unknown");
      expect(JSON.stringify(deniedSubjectSlice)).not.toContain("three concise bullets");
    } finally {
      db.close();
    }
  });

  test("B3: progressive connection-time learning distinguishes ingestion-in-progress from empty and blocks copy-inflation", () => {
    const db = openMemtRegistryDb(":memory:");
    const store = new CollaborationSliceStore({ db });
    try {
      store.updateConnectionProgress({
        person_id: "person:ada",
        partition_key: "work",
        stage: "partial_backfill",
        historical_complete: false,
        resume_cursor: "cursor:batch-42",
      });

      // Record one high-info owner instruction immediately available before backfill finishes
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "collaboration_protocol",
        kind: "rule",
        condition: "PR reviews and deployment handoffs",
        guidance: "Always attach exact verification command outputs",
        scope: ["technical_review", "release"],
        evidence_refs: ["event:owner_pin_1"],
        sensitivity: "work",
        authority_level: "owner_instruction",
      });

      // Record one weak signal, then replay 5 copies from the SAME source root
      const firstWeak = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "rule",
        condition: "Slide deck typography",
        guidance: "Prefer high-contrast sans headings",
        scope: ["presentation"],
        evidence_refs: ["event:slack_msg_100"],
        sensitivity: "work",
        authority_level: "inferred_taste",
        confidence: 0.55,
      });
      expect(firstWeak.record.epistemic_status).toBe("hypothesis");
      expect(firstWeak.record.source_roots).toEqual(["slack_msg_100"]);

      for (const copyRef of [
        "event:slack_msg_100#copy1",
        "event:slack_msg_100#copy2",
        "event:slack_msg_100:dup1",
        "event:slack_msg_100:replay2",
        "event:slack_msg_100@v2",
      ]) {
        const replayed = store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: "developing_taste",
          kind: "rule",
          condition: "Slide deck typography",
          guidance: "Prefer high-contrast sans headings",
          scope: ["presentation"],
          evidence_refs: [copyRef],
          sensitivity: "work",
          authority_level: "inferred_taste",
          confidence: 0.55,
        });
        expect(replayed.deduplicated).toBe(true);
        expect(replayed.record.epistemic_status).toBe("hypothesis");
        expect(replayed.record.source_roots).toEqual(["slack_msg_100"]);
        expect(replayed.record.confidence).toBeCloseTo(0.55, 5);
      }

      // Independent single evidence ref with its own explicit source_root must NOT become corroborated!
      const withOwnRoot = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "rule",
        condition: "Poster grid rhythm",
        guidance: "Use strict 12-column Swiss grid",
        scope: ["poster"],
        evidence_refs: ["event:own_root_msg_1"],
        source_roots: ["slack_design_channel"],
        sensitivity: "work",
        authority_level: "inferred_taste",
        confidence: 0.55,
      });
      expect(withOwnRoot.record.source_roots).toEqual(["slack_design_channel"]);
      expect(withOwnRoot.record.epistemic_status).toBe("hypothesis");

      // Replaying the same evidence ref with a different explicit source_root still cannot inflate corroboration
      const replayedOwnRoot = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "rule",
        condition: "Poster grid rhythm",
        guidance: "Use strict 12-column Swiss grid",
        scope: ["poster"],
        evidence_refs: ["event:own_root_msg_1#copy2"],
        source_roots: ["different_label_same_msg"],
        sensitivity: "work",
        authority_level: "inferred_taste",
        confidence: 0.55,
      });
      expect(replayedOwnRoot.deduplicated).toBe(true);
      expect(replayedOwnRoot.record.source_roots).toEqual(["slack_design_channel"]);
      expect(replayedOwnRoot.record.epistemic_status).toBe("hypothesis");

      // More explicit source_roots than distinct evidence_refs is rejected
      expect(() =>
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: "developing_taste",
          kind: "rule",
          condition: "Forged roots",
          guidance: "Should fail",
          scope: ["poster"],
          evidence_refs: ["event:single_ref_only"],
          source_roots: ["root_a", "root_b"],
          sensitivity: "work",
          authority_level: "inferred_taste",
        }),
      ).toThrow(/source_roots/);

      // Private record must NEVER be counted when updateConnectionProgress uses a lower ceiling
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "decision_values",
        kind: "rule",
        condition: "Private owner strategy",
        guidance: "Hidden private rule",
        scope: ["strategy"],
        evidence_refs: ["event:priv_progress_1"],
        sensitivity: "private",
        authority_level: "owner_instruction",
      });
      const workProgress = store.updateConnectionProgress({
        person_id: "person:ada",
        partition_key: "work",
        stage: "connecting",
        historical_complete: false,
        resume_cursor: "cursor:batch-41",
        sensitivityCeiling: "work",
      });
      expect(workProgress.high_info_indexed).toBe(1);
      const privProgress = store.updateConnectionProgress({
        person_id: "person:ada",
        partition_key: "work",
        stage: "partial_backfill",
        historical_complete: false,
        resume_cursor: "cursor:batch-42",
        sensitivityCeiling: "private",
      });
      expect(privProgress.high_info_indexed).toBe(2);

      // While historical ingestion is incomplete, empty areas report ingestion_in_progress
      const inProgressSlice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Technical review for release candidate",
        task_kind: "technical_review",
        sensitivityCeiling: "work",
      });
      expect(inProgressSlice.progress.stage).toBe("partial_backfill");
      expect(inProgressSlice.progress.historical_complete).toBe(false);
      expect(inProgressSlice.progress.resume_cursor).toBe("cursor:batch-42");
      expect(inProgressSlice.progress.high_info_indexed).toBe(1);
      expect(inProgressSlice.brief.active_rules).toHaveLength(1);
      expect(inProgressSlice.areas.knowledge.status).toBe("unknown");
      expect(inProgressSlice.areas.knowledge.reason).toBe("ingestion_in_progress");

      // Independent second source root promotes the hypothesis to corroborated
      const corroborated = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "rule",
        condition: "Slide deck typography",
        guidance: "Prefer high-contrast sans headings",
        scope: ["presentation"],
        evidence_refs: ["event:design_doc_77"],
        sensitivity: "work",
        authority_level: "inferred_taste",
        confidence: 0.65,
      });
      expect(corroborated.record.source_roots).toHaveLength(2);
      expect(corroborated.record.epistemic_status).toBe("corroborated");

      // Completing backfill transitions empty area reasons to no_permitted_evidence
      store.updateConnectionProgress({
        person_id: "person:ada",
        partition_key: "work",
        stage: "complete",
        historical_complete: true,
        resume_cursor: "cursor:done",
      });
      const completeSlice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Technical review for release candidate",
        task_kind: "technical_review",
        sensitivityCeiling: "work",
      });
      expect(completeSlice.areas.knowledge.reason).toBe("no_permitted_evidence");
    } finally {
      db.close();
    }
  });

  test("B4 & B5: preserves conditional exceptions, temporal bounds, missing-provenance exclusion, grounded examples, conflicts, and rubric authority cap", () => {
    const db = openMemtRegistryDb(":memory:");
    const store = new CollaborationSliceStore({ db });
    try {
      // Missing provenance is rejected on write
      expect(() =>
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: "communication",
          kind: "rule",
          condition: "Updates",
          guidance: "No source attached",
          scope: ["status_update"],
          evidence_refs: [],
          sensitivity: "work",
        }),
      ).toThrow(/evidence_refs/);

      // Rule with explicit exception: "Use brief updates except during incident analysis"
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "Routine team updates",
        guidance: "Use brief updates under five bullets",
        verification: "Check update has at most five bullets",
        scope: ["status_update", "incident_analysis"],
        exceptions: [
          {
            condition: "incident_analysis",
            note: "During incident analysis, provide full root-cause timeline, blast radius, and mitigation proof",
          },
        ],
        evidence_refs: ["event:comm_rule_1"],
        sensitivity: "work",
        authority_level: "owner_instruction",
      });

      // Expired temporal rule (should be excluded at asOf = 2026-11-25T00:00:00Z)
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "Legacy Q1 status format",
        guidance: "Include legacy Q1 migration table",
        scope: ["status_update"],
        evidence_refs: ["event:expired_rule"],
        sensitivity: "work",
        valid_from: "2026-01-01T00:00:00Z",
        valid_until: "2026-04-01T00:00:00Z",
      });

      // Grounded positive & negative examples with reasons + domain-scoped taste
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "example_positive",
        condition: "Editorial poster hero layout",
        guidance: "Single monumental numeral over calm grid with crisp Swiss hierarchy",
        reason: "Immediate visual focal point without clutter",
        scope: ["design_poster"],
        evidence_refs: ["event:poster_pos_1"],
        sensitivity: "work",
        authority_level: "inferred_taste",
      });
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "example_negative",
        condition: "Editorial poster hero layout",
        guidance: "Generic glowing purple bento grid with decorative idle pulses",
        reason: "Looks like template AI slop and distracts from subject",
        scope: ["design_poster"],
        evidence_refs: ["event:poster_neg_1"],
        sensitivity: "work",
        authority_level: "inferred_taste",
      });
      // Inferred taste criterion must NEVER become hard_owner_instruction
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "developing_taste",
        kind: "criterion",
        condition: "Poster visual polish",
        guidance: "Keep hero copy sparse and asymmetrical",
        verification: "Check visual focal hierarchy",
        scope: ["design_poster"],
        evidence_refs: ["event:poster_crit_1", "event:poster_crit_2"],
        sensitivity: "work",
        authority_level: "inferred_taste",
      });

      // Conflicting records in same conflict_group must stay explicit
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "decision_values",
        kind: "rule",
        condition: "Poster release timeline",
        guidance: "Ship poster rapidly with single layout pass",
        scope: ["design_poster"],
        evidence_refs: ["event:conf_1"],
        sensitivity: "work",
        conflict_group: "poster_cadence",
      });
      store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "decision_values",
        kind: "rule",
        condition: "Poster release timeline",
        guidance: "Run three-poster structural duel before shipping",
        scope: ["design_poster"],
        evidence_refs: ["event:conf_2"],
        sensitivity: "work",
        conflict_group: "poster_cadence",
      });

      // Manually inject a corrupted DB row with empty provenance to prove fail-closed read validation
      db.query(
        `INSERT INTO collaboration_records (
          id, person_id, partition_key, area, kind, condition, guidance, reason, verification,
          scope_json, exceptions_json, evidence_refs_json, source_roots_json,
          sensitivity, taint, authority_level, epistemic_status, confidence, uncertainty,
          valid_from, valid_until, conflict_group, superseded_by, dedup_key, created_at, updated_at
        ) VALUES (
          'corrupt_no_prov', 'person:ada', 'work', 'communication', 'rule', 'Updates',
          'CORRUPT_UNPROVEN_RULE', '', '', '["status_update"]', '[]', '[]', '[]',
          'public', 'quoted', 'owner_instruction', 'owner_instruction', 0.9, 0.1,
          NULL, NULL, NULL, NULL, 'corrupt_key', '2026-11-25T00:00:00Z', '2026-11-25T00:00:00Z'
        )`,
      ).run();

      // 1. Routine status update applies brief rule, retains its exception, excludes expired & corrupt rows
      const routine = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Draft routine status update",
        task_kind: "status_update",
        sensitivityCeiling: "work",
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(routine.brief.active_rules).toHaveLength(1);
      expect(routine.brief.active_rules[0]!.guidance).toContain("brief updates");
      expect(routine.brief.active_rules[0]!.exceptions).toHaveLength(1);
      expect(routine.brief.active_rules[0]!.exceptions[0]!.condition).toBe("incident_analysis");
      expect(routine.brief.triggered_exceptions).toHaveLength(0);
      expect(routine.rubric[0]!.requirement_level).toBe("hard_owner_instruction");
      expect(JSON.stringify(routine)).not.toContain("Q1 migration table");
      expect(JSON.stringify(routine)).not.toContain("CORRUPT_UNPROVEN_RULE");
      // Domain-scoped poster taste does NOT leak into status update
      expect(routine.examples.positive).toHaveLength(0);

      // 2. Incident analysis triggers the exception and suppresses the brief-updates directive
      const incident = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Write incident analysis for database failover outage",
        task_kind: "incident_analysis",
        sensitivityCeiling: "work",
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(incident.brief.triggered_exceptions).toHaveLength(1);
      expect(incident.brief.triggered_exceptions[0]!.exception_note).toContain("root-cause timeline");
      expect(incident.brief.active_rules.some((r) => r.guidance.includes("brief updates"))).toBe(false);

      // 2b. Excluded area MUST NOT leak via exception matching!
      const incidentWorkStandardsOnly = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Write incident analysis for database failover outage",
        task_kind: "incident_analysis",
        areas: ["work_standards"],
        sensitivityCeiling: "work",
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(incidentWorkStandardsOnly.brief.triggered_exceptions).toHaveLength(0);
      expect(incidentWorkStandardsOnly.brief.active_rules).toHaveLength(0);

      // 2c. Budget enforcement on complete response: 100-token budget below mandatory envelope fails closed
      expect(() =>
        store.compileSlice({
          person_id: "person:ada",
          partition_key: "work",
          task: "Design launch poster layout",
          task_kind: "design_poster",
          sensitivityCeiling: "work",
          budgetTokens: 100,
          asOf: "2026-11-25T00:00:00Z",
        }),
      ).toThrow(/budget_tokens/);

      // Tight valid budget packs strictly within budget_tokens and sets truncated = true when items are dropped
      const emptySlice = store.compileSlice({
        person_id: "person:empty",
        partition_key: "work",
        task: "Design launch poster layout",
        task_kind: "design_poster",
        sensitivityCeiling: "work",
        budgetTokens: 1200,
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(emptySlice.estimated_tokens).toBeLessThanOrEqual(emptySlice.budget_tokens);
      expect(emptySlice.truncated).toBe(false);

      const tightBudget = emptySlice.estimated_tokens + 60;
      const tightPoster = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design launch poster layout",
        task_kind: "design_poster",
        sensitivityCeiling: "work",
        budgetTokens: tightBudget,
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(tightPoster.estimated_tokens).toBeLessThanOrEqual(tightPoster.budget_tokens);
      expect(tightPoster.truncated).toBe(true);

      // 3. Poster task gets grounded positive/negative examples with reasons, explicit conflict, and soft rubric cap
      const poster = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design launch poster layout",
        task_kind: "design_poster",
        sensitivityCeiling: "work",
        asOf: "2026-11-25T00:00:00Z",
      });
      expect(poster.examples.positive).toHaveLength(1);
      expect(poster.examples.positive[0]!.reason).toContain("focal point");
      expect(poster.examples.negative).toHaveLength(1);
      expect(poster.examples.negative[0]!.reason).toContain("template AI slop");
      expect(poster.brief.conflicts).toHaveLength(1);
      expect(poster.brief.conflicts[0]!.conflict_group).toBe("poster_cadence");
      expect(poster.rubric).toHaveLength(1);
      expect(poster.rubric[0]!.authority_level).toBe("inferred_taste");
      expect(poster.rubric[0]!.requirement_level).toBe("soft_guidance");
      expect(rubricRequirementLevelFor("inferred_taste", "corroborated")).toBe("soft_guidance");
      expect(rubricRequirementLevelFor("inferred_taste", "hypothesis")).toBe("hypothesis_check");
    } finally {
      db.close();
    }
  });

  test("B6 & B7: cross-agent learning, idempotent delivery, undo, purge totality, two-host parity, and stale-slice refresh", async () => {
    const vault = makeTempVault("kizuki-collab-b6-");
    const engine: MemtEngine = createMemtEngine(vault);
    try {
      const initial = engine.collaboration.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "work_standards",
        kind: "rule",
        condition: "API error handling",
        guidance: "Return plain string error payloads",
        scope: ["api_design"],
        evidence_refs: ["event:initial_api_1"],
        sensitivity: "work",
        authority_level: "observed_preference",
      });

      // B7: Two distinct hosts request the same Person x Task slice and get identical semantics + hash
      const hostASlice = engine.compileCollaborationSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design API contract for payment webhook",
        task_kind: "api_design",
        sensitivityCeiling: "work",
        hostId: "host-claude",
      });
      const hostBSlice = engine.compileCollaborationSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design API contract for payment webhook",
        task_kind: "api_design",
        sensitivityCeiling: "work",
        hostId: "host-codex",
      });
      expect(hostASlice.slice_hash).toBe(hostBSlice.slice_hash);
      expect(hostASlice.brief).toEqual(hostBSlice.brief);
      expect(hostASlice.rubric).toEqual(hostBSlice.rubric);
      expect(hostASlice.host_contract.contract_version).toBe(COLLABORATION_HOST_CONTRACT_VERSION);
      expect(hostASlice.host_contract.mode).toBe("pull_only");
      expect(hostASlice.host_contract.grants_action_authority).toBe(false);
      expect(hostASlice.host_contract.per_user_finetuning_required).toBe(false);
      expect(hostASlice.host_contract.hosted_agent_loop).toBe(false);
      expect(hostASlice.host_contract.unsupported_operations).toContain("autonomous_external_action");

      // Stale-slice refresh when unchanged
      const unchanged = engine.compileCollaborationSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design API contract for payment webhook",
        task_kind: "api_design",
        sensitivityCeiling: "work",
        priorSliceHash: hostASlice.slice_hash,
      });
      expect(unchanged.refresh_status).toBe("unchanged");
      expect(unchanged.slice_hash).toBe(hostASlice.slice_hash);

      // B6: Agent A self-claim is NOT owner endorsement and does NOT upgrade guidance
      const claimRes = engine.collaboration.recordCrossAgentHandoff({
        idempotency_key: "idem-agent-a-claim-1",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-a",
        served_slice_hash: hostASlice.slice_hash,
        task: "Design API contract for payment webhook",
        area: "work_standards",
        kind: "agent_claim",
        work_summary: "Claimed API design passed all checks",
        evidence_refs: ["event:agent_a_log_1"],
        sensitivity: "work",
      });
      expect(claimRes.handoff.outcome_status).toBe("unverified_agent_claim");
      expect(claimRes.handoff.endorsed_by_owner).toBe(false);
      expect(claimRes.createdRecord).toBeNull();

      // B6: Owner corrects Agent A's work; repeated delivery is idempotent
      const corr1 = engine.collaboration.recordCrossAgentHandoff({
        idempotency_key: "idem-owner-corr-1",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-a",
        served_slice_hash: hostASlice.slice_hash,
        task: "Design API contract for payment webhook",
        area: "work_standards",
        kind: "owner_correction",
        work_summary: "Agent A emitted plain string errors",
        correction_text: "Always return structured machine-readable error codes without stack traces",
        supersedes_record_id: initial.record.id,
        scope: ["api_design"],
        evidence_refs: ["event:owner_corr_api_1"],
        sensitivity: "work",
      });
      const corrReplay = engine.collaboration.recordCrossAgentHandoff({
        idempotency_key: "idem-owner-corr-1",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-a",
        served_slice_hash: hostASlice.slice_hash,
        task: "Design API contract for payment webhook",
        area: "work_standards",
        kind: "owner_correction",
        work_summary: "Agent A emitted plain string errors",
        correction_text: "Always return structured machine-readable error codes without stack traces",
        supersedes_record_id: initial.record.id,
        scope: ["api_design"],
        evidence_refs: ["event:owner_corr_api_1"],
        sensitivity: "work",
      });
      expect(corr1.idempotentReplay).toBe(false);
      expect(corrReplay.idempotentReplay).toBe(true);
      expect(corrReplay.handoff.id).toBe(corr1.handoff.id);
      expect(corr1.handoff.endorsed_by_owner).toBe(true);

      // Unrelated handoff in a different task/area must NOT appear in api_design slice recent_handoffs
      engine.collaboration.recordCrossAgentHandoff({
        idempotency_key: "idem-unrelated-poster-1",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-c",
        served_slice_hash: hostASlice.slice_hash,
        task: "Design autumn editorial poster typography",
        area: "developing_taste",
        kind: "agent_claim",
        work_summary: "Adjusted poster headline kerning",
        evidence_refs: ["event:unrelated_poster_1"],
        sensitivity: "work",
      });

      // Agent B's next authorized slice immediately reflects owner correction & triggers refresh
      const agentBRefreshed = engine.compileCollaborationSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design API contract for payment webhook",
        task_kind: "api_design",
        sensitivityCeiling: "work",
        priorSliceHash: hostASlice.slice_hash,
      });
      expect(agentBRefreshed.refresh_status).toBe("refreshed");
      expect(agentBRefreshed.slice_hash).not.toBe(hostASlice.slice_hash);
      expect(agentBRefreshed.brief.active_rules.map((r) => r.guidance)).toEqual([
        "Always return structured machine-readable error codes without stack traces",
      ]);
      expect(agentBRefreshed.rubric[0]!.requirement_level).toBe("hard_owner_instruction");
      expect(agentBRefreshed.recent_handoffs.some((h) => h.agent_id === "agent-c")).toBe(false);
      expect(agentBRefreshed.recent_handoffs.some((h) => h.id === corr1.handoff.id)).toBe(true);

      // Purge the original source FIRST, then undo the correction: must NOT resurrect purged evidence!
      const purgeInitial = engine.purgeSources(["event:initial_api_1"]);
      expect(purgeInitial.collaboration.purgedRecordIds).toContain(initial.record.id);

      const undone = engine.collaboration.undoHandoff(corr1.handoff.id, "work");
      expect(undone.undone).toBe(true);
      expect(undone.retracted_record_id).toBe(corr1.createdRecord!.id);
      expect(undone.restored_record_id).toBeNull();

      const afterUndoAndPurge = engine.compileCollaborationSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Design API contract for payment webhook",
        task_kind: "api_design",
        sensitivityCeiling: "work",
      });
      expect(afterUndoAndPurge.brief.active_rules).toEqual([]);
      expect(JSON.stringify(afterUndoAndPurge)).not.toContain("plain string error payloads");
      expect(JSON.stringify(afterUndoAndPurge)).not.toContain("structured machine-readable error codes");

      // Purge correction source removes the handoff record physically too
      const purgeCorr = engine.purgeSources(["event:owner_corr_api_1"]);
      expect(purgeCorr.collaboration.purgedHandoffIds).toContain(corr1.handoff.id);
    } finally {
      await engine.close();
    }
  });

  test("Fresh-agent acceptance oracle: recall >= 92% across 25 Person x Task scenarios with 0 leaks", () => {
    const db = openMemtRegistryDb(":memory:");
    const store = new CollaborationSliceStore({ db });
    try {
      interface ScenarioSpec {
        readonly id: string;
        readonly area: CollaborationArea;
        readonly taskKind: string;
        readonly condition: string;
        readonly guidance: string;
        readonly verification: string;
        readonly posExample?: { text: string; reason: string };
        readonly negExample?: { text: string; reason: string };
        readonly exception?: { condition: string; note: string };
        readonly freshAgentPrompt: string;
        readonly expectExceptionTriggered?: boolean;
      }

      const SCENARIOS: readonly ScenarioSpec[] = [
        {
          id: "s01",
          area: "communication",
          taskKind: "status_update",
          condition: "Weekly team status update",
          guidance: "Keep weekly status updates under five bullet points with metric deltas",
          verification: "Count bullets <= 5 and verify metric delta present",
          posExample: { text: "p95 latency 410ms -> 90ms; 14/14 envelope tests green", reason: "Concrete numbers and state changes" },
          negExample: { text: "Worked on gateway improvements and refactored tests", reason: "Vague activity log without proof" },
          freshAgentPrompt: "Draft a weekly status update summarizing our recent latency work",
        },
        {
          id: "s02",
          area: "communication",
          taskKind: "incident_analysis",
          condition: "Production outage communication",
          guidance: "Keep updates brief during normal days",
          verification: "Verify full root-cause timeline included for incidents",
          exception: { condition: "incident_analysis", note: "Provide complete root-cause timeline, blast radius, and rollback steps" },
          freshAgentPrompt: "Write an incident analysis report for the checkout database outage",
          expectExceptionTriggered: true,
        },
        {
          id: "s03",
          area: "work_standards",
          taskKind: "technical_review",
          condition: "Pull request technical review",
          guidance: "Lead with severity-ranked findings and exact file and line citations",
          verification: "Confirm every finding cites file, line, and failure mode",
          freshAgentPrompt: "Perform a technical review on the new authentication pull request",
        },
        {
          id: "s04",
          area: "work_standards",
          taskKind: "sqlite_migration",
          condition: "SQLite schema migration work",
          guidance: "Use STRICT tables, WAL mode, transactions, and fresh plus upgrade tests",
          verification: "Run migration tests on both clean and prior-version databases",
          freshAgentPrompt: "Plan and verify a SQLite migration for the new ledger index",
        },
        {
          id: "s05",
          area: "work_standards",
          taskKind: "security_audit",
          condition: "Security boundary audit",
          guidance: "Prove both allowed and forbidden paths and redact credentials in audit logs",
          verification: "Verify refusal payload contains zero secrets or cause internals",
          freshAgentPrompt: "Conduct a security audit of the MCP token authentication boundary",
        },
        {
          id: "s06",
          area: "work_standards",
          taskKind: "release_checklist",
          condition: "Release readiness verification",
          guidance: "Run typecheck, full tests, secret scan, and smoke check on exact head SHA",
          verification: "Attach exact head SHA and command exit codes",
          freshAgentPrompt: "Prepare the release checklist verification for version 1.1",
        },
        {
          id: "s07",
          area: "collaboration_protocol",
          taskKind: "autonomous_execution",
          condition: "Reversible engineering execution",
          guidance: "Execute authorized reversible changes directly without asking permission",
          verification: "Deliver completed diff and proof instead of narrating intent",
          freshAgentPrompt: "Run autonomous execution to repair the failing parser edge case",
        },
        {
          id: "s08",
          area: "collaboration_protocol",
          taskKind: "outbound_comms",
          condition: "External emails or messages sent as owner",
          guidance: "Draft outbound messages autonomously and gate final send for approval",
          verification: "Confirm draft is queued and nothing was transmitted externally",
          freshAgentPrompt: "Prepare outbound comms to notify partners about API deprecation",
        },
        {
          id: "s09",
          area: "collaboration_protocol",
          taskKind: "session_handoff",
          condition: "Multi-agent session handoff",
          guidance: "Record exact git head SHA, passing test receipts, and open blockers",
          verification: "Check handoff separates committed state from local-only changes",
          freshAgentPrompt: "Create a session handoff summary before pausing this branch",
        },
        {
          id: "s10",
          area: "collaboration_protocol",
          taskKind: "design_interview",
          condition: "Ambiguous architecture scope forks",
          guidance: "Use concise multiple-choice questions with recommended default first",
          verification: "Verify each decision fork locks cleanly into a written brief",
          freshAgentPrompt: "Run a design interview to lock requirements for the plugin loader",
        },
        {
          id: "s11",
          area: "knowledge",
          taskKind: "mcp_adapter",
          condition: "MCP stdio adapter changes",
          guidance: "Keep MCP stateless over stdio and delegate all policy enforcement to core",
          verification: "Confirm adapter never opens SQLite directly or forwards ServeError cause",
          freshAgentPrompt: "Extend the MCP adapter schema for procedural recall tools",
        },
        {
          id: "s12",
          area: "knowledge",
          taskKind: "canon_writer",
          condition: "Canon Markdown persistence work",
          guidance: "Route all canon writes through the single receipted writer with undo hashes",
          verification: "Verify before and after hashes are recorded on every receipt",
          freshAgentPrompt: "Debug how the canon writer updates entity markdown pages",
        },
        {
          id: "s13",
          area: "knowledge",
          taskKind: "connector_sync",
          condition: "Provider connector sync implementation",
          guidance: "Preserve idempotent backfill checkpoints and map source deletions to tombstones",
          verification: "Run shared connector conformance suite against synthetic fixtures",
          freshAgentPrompt: "Implement incremental cursor checkpointing for connector sync",
        },
        {
          id: "s14",
          area: "knowledge",
          taskKind: "retrieval_ranking",
          condition: "Hybrid lexical and vector retrieval",
          guidance: "Keep lexical FTS5 floor deterministic with zero-model dependency",
          verification: "Verify retrieval passes offline with vector backend disabled",
          freshAgentPrompt: "Tune retrieval ranking weights for hybrid FTS5 and cosine recall",
        },
        {
          id: "s15",
          area: "decision_values",
          taskKind: "dependency_eval",
          condition: "Evaluating new third-party dependencies",
          guidance: "Prefer standard library and Bun built-ins over adding transitive packages",
          verification: "Check offline behavior, license, and exit strategy before adding",
          freshAgentPrompt: "Run a dependency eval before adding a YAML validation library",
        },
        {
          id: "s16",
          area: "decision_values",
          taskKind: "privacy_policy",
          condition: "Handling captured text and grants",
          guidance: "Filter by grant ceiling and source consent prior to ranking or counting",
          verification: "Confirm hidden mutations leave visible bytes and work counters unchanged",
          freshAgentPrompt: "Review privacy policy enforcement for scoped recall queries",
        },
        {
          id: "s17",
          area: "decision_values",
          taskKind: "perf_optimization",
          condition: "Performance optimization loops",
          guidance: "Capture baseline benchmarks first and ratchet only strictly improving edits",
          verification: "Attach before and after p50 and p95 latency deltas",
          freshAgentPrompt: "Run perf optimization on the 384-d vector dot-product loop",
        },
        {
          id: "s18",
          area: "decision_values",
          taskKind: "refactor_cleanup",
          condition: "Codebase simplification and elegance review",
          guidance: "Delete dead wrappers and unify duplicate paths before adding new seams",
          verification: "Verify behavior equivalence across full test suite after deletion",
          freshAgentPrompt: "Perform a refactor cleanup pass over the world slice helpers",
        },
        {
          id: "s19",
          area: "developing_taste",
          taskKind: "design_poster",
          condition: "Editorial web poster design",
          guidance: "Use Swiss typographic hierarchy, crisp grid alignment, and one focal hero",
          verification: "Inspect rendered desktop and mobile PNG stills before shipping",
          posExample: { text: "Oversized grotesk numeral anchored to hairline editorial grid", reason: "High visual conviction and zero clutter" },
          negExample: { text: "Floating neon purple gradient cards with spinning badges", reason: "Generic AI template aesthetic" },
          freshAgentPrompt: "Create a design poster concept for the autumn release showcase",
        },
        {
          id: "s20",
          area: "developing_taste",
          taskKind: "product_dashboard",
          condition: "Dense operational product UI",
          guidance: "Lead with working data tables, tabular numerals, and functional status cues",
          verification: "Check zero decorative idle pulses and crisp contrast",
          freshAgentPrompt: "Refine the product dashboard layout for live vault diagnostics",
        },
        {
          id: "s21",
          area: "developing_taste",
          taskKind: "copy_editing",
          condition: "Technical documentation and release copy",
          guidance: "Eliminate em-dashes and filler adjectives in favor of concrete verbs",
          verification: "Scan output for zero em-dashes and unsupported marketing claims",
          freshAgentPrompt: "Run copy editing on the public changelog and README overview",
        },
        {
          id: "s22",
          area: "developing_taste",
          taskKind: "motion_craft",
          condition: "Interactive web UI transitions",
          guidance: "Use compositor-only transforms and ensure every animation communicates state",
          verification: "Confirm prefers-reduced-motion disables non-essential motion",
          freshAgentPrompt: "Implement motion craft transitions for the timeline inspector drawer",
        },
        {
          id: "s23",
          area: "communication",
          taskKind: "investor_memo",
          condition: "Quarterly executive and investor memos",
          guidance: "Open with traction metrics, burn rate, and top three milestones",
          verification: "Confirm numbers trace directly to verified financial ledger",
          freshAgentPrompt: "Draft the quarterly investor memo covering Q3 growth metrics",
        },
        {
          id: "s24",
          area: "work_standards",
          taskKind: "api_contract",
          condition: "Public TypeScript and CLI API contracts",
          guidance: "Validate inputs at trust boundaries and keep error codes stable and typed",
          verification: "Test both valid payloads and malformed edge cases",
          freshAgentPrompt: "Design the public api contract for collaboration slice refresh",
        },
        {
          id: "s25",
          area: "collaboration_protocol",
          taskKind: "bug_triage",
          condition: "Investigating production bugs or flaky tests",
          guidance: "Enumerate at least two candidate causes and run a discriminating check first",
          verification: "Document exact root cause mechanism before patching",
          freshAgentPrompt: "Start bug triage for the intermittent WAL checkpoint lock failure",
        },
      ];

      for (const s of SCENARIOS) {
        store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: s.area,
          kind: "rule",
          condition: s.condition,
          guidance: s.guidance,
          verification: s.verification,
          scope: [s.taskKind],
          ...(s.exception !== undefined ? { exceptions: [s.exception] } : {}),
          evidence_refs: [`event:ev_${s.id}_a`, `event:ev_${s.id}_b`],
          sensitivity: "work",
          authority_level: s.area === "developing_taste" ? "inferred_taste" : "owner_instruction",
        });
        if (s.posExample !== undefined) {
          store.recordFacet({
            person_id: "person:ada",
            partition_key: "work",
            area: s.area,
            kind: "example_positive",
            condition: s.condition,
            guidance: s.posExample.text,
            reason: s.posExample.reason,
            scope: [s.taskKind],
            evidence_refs: [`event:pos_${s.id}`],
            sensitivity: "work",
            authority_level: "observed_preference",
          });
        }
        if (s.negExample !== undefined) {
          store.recordFacet({
            person_id: "person:ada",
            partition_key: "work",
            area: s.area,
            kind: "example_negative",
            condition: s.condition,
            guidance: s.negExample.text,
            reason: s.negExample.reason,
            scope: [s.taskKind],
            evidence_refs: [`event:neg_${s.id}`],
            sensitivity: "work",
            authority_level: "observed_preference",
          });
        }
      }

      // Adversarial leak decoys: 60 private, 40 other-partition, 40 other-person using identical scopes!
      for (let i = 0; i < 60; i += 1) {
        const s = SCENARIOS[i % SCENARIOS.length]!;
        const res = store.recordFacet({
          person_id: "person:ada",
          partition_key: "work",
          area: s.area,
          kind: "rule",
          condition: s.condition,
          guidance: `LEAK_PRIVATE_TOKEN_${i} confidential family banking credential note`,
          scope: [s.taskKind, "all"],
          evidence_refs: [`event:leak_priv_${i}`],
          sensitivity: "private",
          authority_level: "owner_instruction",
        });
        expect(res.record.id.length).toBeGreaterThan(0);
      }
      for (let i = 0; i < 40; i += 1) {
        const s = SCENARIOS[i % SCENARIOS.length]!;
        const res = store.recordFacet({
          person_id: "person:ada",
          partition_key: "personal-diary",
          area: s.area,
          kind: "rule",
          condition: s.condition,
          guidance: `LEAK_PARTITION_TOKEN_${i} private diary reflection`,
          scope: [s.taskKind, "all"],
          evidence_refs: [`event:leak_part_${i}`],
          sensitivity: "public",
          authority_level: "owner_instruction",
        });
        expect(res.record.id.length).toBeGreaterThan(0);
      }
      for (let i = 0; i < 40; i += 1) {
        const s = SCENARIOS[i % SCENARIOS.length]!;
        const res = store.recordFacet({
          person_id: "person:bob",
          partition_key: "work",
          area: s.area,
          kind: "rule",
          condition: s.condition,
          guidance: `LEAK_OTHER_PERSON_TOKEN_${i} bob-only work guidance`,
          scope: [s.taskKind, "all"],
          evidence_refs: [`event:leak_bob_${i}`],
          sensitivity: "public",
          authority_level: "owner_instruction",
        });
        expect(res.record.id.length).toBeGreaterThan(0);
      }

      // Verify decoys are actually stored and owner-readable before running the fresh-agent zero-leak check
      const ownerPrivCheck = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: SCENARIOS[0]!.freshAgentPrompt,
        task_kind: SCENARIOS[0]!.taskKind,
        sensitivityCeiling: "private",
        budgetTokens: 3000,
      });
      expect(JSON.stringify(ownerPrivCheck)).toContain("LEAK_PRIVATE_TOKEN_");
      const ownerPartCheck = store.compileSlice({
        person_id: "person:ada",
        partition_key: "personal-diary",
        task: SCENARIOS[0]!.freshAgentPrompt,
        task_kind: SCENARIOS[0]!.taskKind,
        sensitivityCeiling: "private",
        budgetTokens: 3000,
      });
      expect(JSON.stringify(ownerPartCheck)).toContain("LEAK_PARTITION_TOKEN_");
      const ownerBobCheck = store.compileSlice({
        person_id: "person:bob",
        partition_key: "work",
        task: SCENARIOS[0]!.freshAgentPrompt,
        task_kind: SCENARIOS[0]!.taskKind,
        sensitivityCeiling: "private",
        budgetTokens: 3000,
      });
      expect(JSON.stringify(ownerBobCheck)).toContain("LEAK_OTHER_PERSON_TOKEN_");

      // Fresh agents connect cold with natural-language prompts (WITHOUT passing task_kind cheat!)
      let hits = 0;
      let leaks = 0;
      for (const s of SCENARIOS) {
        const slice = store.compileSlice({
          person_id: "person:ada",
          partition_key: "work",
          task: s.freshAgentPrompt,
          sensitivityCeiling: "work",
          allowedSubjects: ["person:ada"],
        });

        const wire = JSON.stringify(slice);
        if (
          wire.includes("LEAK_PRIVATE_TOKEN") ||
          wire.includes("LEAK_PARTITION_TOKEN") ||
          wire.includes("LEAK_OTHER_PERSON_TOKEN")
        ) {
          leaks += 1;
        }

        const recovered = s.expectExceptionTriggered
          ? slice.brief.triggered_exceptions.some((ex) => ex.exception_note === s.exception!.note)
          : slice.brief.active_rules.some((r) => r.guidance === s.guidance) &&
            (s.posExample === undefined ||
              slice.examples.positive.some((ex) => ex.example === s.posExample!.text)) &&
            (s.negExample === undefined ||
              slice.examples.negative.some((ex) => ex.example === s.negExample!.text));

        if (recovered) hits += 1;
      }

      const recall = hits / SCENARIOS.length;
      expect(leaks).toBe(0);
      expect(recall).toBeGreaterThanOrEqual(0.92);
    } finally {
      db.close();
    }
  });

  test("P1 hardening: owner_instruction dedup immutability, handoff auth/replay/predecessor, non-destructive undo, observed_passed, and evidence authorization", () => {
    const db = openMemtRegistryDb(":memory:");
    try {
      const store = new CollaborationSliceStore({ db });

      // 1. Ordinary proposal deduplicating onto an owner_instruction cannot widen scope or add exceptions
      const ownerRule = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "When drafting executive updates",
        guidance: "Lead with one clear decision sentence",
        reason: "Owner directive",
        scope: ["exec_updates"],
        exceptions: [],
        evidence_refs: ["event:owner_dir_1"],
        sensitivity: "public",
        taint: "clean",
        authority_level: "owner_instruction",
      });
      const attemptWiden = store.recordFacet({
        person_id: "person:ada",
        partition_key: "work",
        area: "communication",
        kind: "rule",
        condition: "When drafting executive updates",
        guidance: "Lead with one clear decision sentence",
        reason: "Injected agent reason",
        scope: ["all", "billing"],
        exceptions: [{ condition: "when rushed", note: "skip executive summary" }],
        evidence_refs: ["event:agent_prop_2"],
        sensitivity: "public",
        taint: "quoted",
        authority_level: "observed_preference",
      });
      expect(attemptWiden.deduplicated).toBe(true);
      expect(attemptWiden.record.authority_level).toBe("owner_instruction");
      expect(attemptWiden.record.scope).toEqual(["exec_updates"]);
      expect(attemptWiden.record.exceptions).toEqual([]);
      expect(attemptWiden.record.reason).toBe("Owner directive");

      const slice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Draft executive updates",
        task_kind: "exec_updates",
        sensitivityCeiling: "public",
      });

      // 2. Reject invalid served_slice_hash and omitted observed_passed for observed_outcome
      expect(() =>
        store.recordCrossAgentHandoff({
          idempotency_key: "bad-hash",
          person_id: "person:ada",
          partition_key: "work",
          agent_id: "agent-a",
          served_slice_hash: "not-a-valid-sha256",
          task: "Draft executive updates",
          area: "communication",
          kind: "agent_claim",
          work_summary: "Claimed done",
          evidence_refs: ["event:claim_1"],
          sensitivity: "public",
        }),
      ).toThrow(/served_slice_hash/);

      expect(() =>
        store.recordCrossAgentHandoff({
          idempotency_key: "missing-observed-passed",
          person_id: "person:ada",
          partition_key: "work",
          agent_id: "agent-a",
          served_slice_hash: slice.slice_hash,
          task: "Draft executive updates",
          area: "communication",
          kind: "observed_outcome",
          work_summary: "Attempted unverified pass",
          evidence_refs: ["event:obs_1"],
          sensitivity: "public",
        }),
      ).toThrow(/observed_passed/);

      // 3. Handoff replay denies other agents or lower sensitivity ceilings
      const privHandoff = store.recordCrossAgentHandoff({
        idempotency_key: "priv-replay-key",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-alpha",
        served_slice_hash: slice.slice_hash,
        task: "Draft executive updates",
        area: "communication",
        kind: "agent_claim",
        work_summary: "Confidential executive draft",
        evidence_refs: ["event:priv_claim_1"],
        sensitivity: "private",
        sensitivityCeiling: "private",
        callerAgentId: "agent-alpha",
      });
      expect(privHandoff.idempotentReplay).toBe(false);

      expect(() =>
        store.recordCrossAgentHandoff({
          idempotency_key: "priv-replay-key",
          person_id: "person:ada",
          partition_key: "work",
          agent_id: "agent-beta",
          served_slice_hash: slice.slice_hash,
          task: "Draft executive updates",
          area: "communication",
          kind: "agent_claim",
          work_summary: "Replay probe",
          evidence_refs: ["event:probe_1"],
          sensitivity: "public",
          sensitivityCeiling: "public",
          callerAgentId: "agent-beta",
        }),
      ).toThrow(/replay denied/);

      // 4. Correction predecessor check runs BEFORE copying predecessor fields
      const bobPrivate = store.recordFacet({
        person_id: "person:bob",
        partition_key: "secret-part",
        area: "communication",
        kind: "rule",
        condition: "SECRET_BOB_CONDITION",
        guidance: "SECRET_BOB_GUIDANCE",
        scope: ["secret_bob_scope"],
        exceptions: [{ condition: "secret_ex", note: "secret_note" }],
        evidence_refs: ["event:bob_sec_1"],
        sensitivity: "private",
        authority_level: "owner_instruction",
      });
      const crossPred = store.recordCrossAgentHandoff({
        idempotency_key: "cross-pred-corr",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "agent-alpha",
        served_slice_hash: slice.slice_hash,
        task: "Draft executive updates",
        area: "communication",
        kind: "owner_correction",
        work_summary: "Attempt to inherit bob predecessor fields",
        correction_text: "Always include action owner",
        supersedes_record_id: bobPrivate.record.id,
        evidence_refs: ["event:ada_corr_1"],
        sensitivity: "public",
        sensitivityCeiling: "public",
      });
      expect(crossPred.createdRecord).not.toBeNull();
      expect(crossPred.createdRecord!.condition).not.toBe("SECRET_BOB_CONDITION");
      expect(crossPred.createdRecord!.scope).not.toContain("secret_bob_scope");
      expect(crossPred.handoff.supersedes_record_id).toBeNull();
      expect(store.getFacet(bobPrivate.record.id)!.superseded_by).toBeNull();

      // 5. Undoing a deduplicated correction NEVER retracts the pre-existing rule
      const dedupCorr = store.recordCrossAgentHandoff({
        idempotency_key: "dedup-corr-handoff",
        person_id: "person:ada",
        partition_key: "work",
        agent_id: "owner",
        served_slice_hash: slice.slice_hash,
        task: "Draft executive updates",
        area: "communication",
        kind: "owner_correction",
        condition: "When drafting executive updates",
        work_summary: "Re-stated existing owner rule",
        correction_text: "Lead with one clear decision sentence",
        scope: ["exec_updates"],
        evidence_refs: ["event:owner_dir_2"],
        sensitivity: "public",
      });
      expect(dedupCorr.handoff.created_record_id).toBeNull();
      // Undo respects allowedSubjects
      const deniedUndo = store.undoHandoff(dedupCorr.handoff.id, "public", undefined, ["person:bob"]);
      expect(deniedUndo.undone).toBe(false);
      // Authorized undo does not retract the pre-existing owner rule
      const okUndo = store.undoHandoff(dedupCorr.handoff.id, "public", undefined, ["person:ada"]);
      expect(okUndo.undone).toBe(true);
      expect(okUndo.retracted_record_id).toBeNull();
      expect(store.getFacet(ownerRule.record.id)!.epistemic_status).toBe("owner_instruction");

      // 6. Evidence authorization filters records and progress counts before selection/hashing
      const filteredSlice = store.compileSlice({
        person_id: "person:ada",
        partition_key: "work",
        task: "Draft executive updates",
        task_kind: "exec_updates",
        sensitivityCeiling: "public",
        isEvidenceAuthorized: (refs) => !refs.includes("event:owner_dir_1"),
      });
      expect(filteredSlice.brief.active_rules.some((r) => r.id === ownerRule.record.id)).toBe(false);
      expect(filteredSlice.progress.high_info_indexed).toBe(1); // only crossPred remains
    } finally {
      db.close();
    }
  });
});
