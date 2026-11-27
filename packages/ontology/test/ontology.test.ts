import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OntologyStore,
  checkAnswerable,
  compileOntologyFromInputs,
  compileOntologyFromVault,
  defaultOntologyDbPath,
  detectTermFamilies,
  exportOssieJson,
  exportOssieYaml,
  extractQuestionConcepts,
  findConnectingPaths,
  findJoinPath,
  importOssieModel,
  parseOssieYaml,
  retrieveOntology,
  withinOntologySensitivity,
} from "../src/index";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-ontology-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("OntologyStore (SQLite STRICT + certification receipts + sensitivity)", () => {
  test("creates vault sqlite at default path with 0600 permissions and WAL mode", () => {
    const vaultDir = makeTempDir();
    const dbPath = defaultOntologyDbPath(vaultDir);
    expect(dbPath).toBe(join(vaultDir, ".kizuki", "ontology.sqlite"));

    const store = new OntologyStore(dbPath);
    try {
      const modeRow = store.db
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();
      expect(modeRow?.journal_mode.toLowerCase()).toBe("wal");

      const mode = statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);

      const status = store.getStatus();
      expect(status.schemaVersion).toBe("1");
      expect(status.termCount).toBe(0);
    } finally {
      store.close();
    }
  });

  test("supports full CRUD, certification receipts, and undo restoration", () => {
    const store = OntologyStore.openInMemory();
    try {
      const term = store.upsertTerm({
        canonicalName: "Project Apollo",
        kind: "project",
        domain: "engineering",
        description: "Draft description",
        synonyms: ["Apollo"],
        attributes: [{ name: "owner", values: ["Ada Lovelace"] }],
        provenance: ["page:projects/apollo.md"],
        sensitivity: "public",
        evidenceCount: 4,
      });
      expect(term.certification).toBe("draft");
      expect(term.normalizedKey).toBe("project_apollo");

      const { term: certified, receipt } = store.certifyTerm({
        termId: term.termId,
        actor: "owner",
        canonicalName: "Project Apollo Core",
        description: "Owner-verified flagship launch program.",
        synonyms: ["Apollo", "Apollo Program"],
      });
      expect(certified.certification).toBe("certified");
      expect(certified.canonicalName).toBe("Project Apollo Core");
      expect(certified.certifiedBy).toBe("owner");
      expect(certified.certifiedAt).not.toBeNull();
      expect(receipt.action).toBe("certify");
      expect(receipt.targetKind).toBe("term");

      const metric = store.upsertMetric({
        name: "release_velocity",
        termId: term.termId,
        description: "Draft velocity metric",
        expression: "COUNT(releases) / 7.0",
        grain: "week",
        sensitivity: "public",
      });
      const { metric: certMetric, receipt: metricReceipt } = store.certifyMetric({
        metricId: metric.metricId,
        actor: "owner",
        description: "Certified weekly ship count.",
      });
      expect(certMetric.certification).toBe("certified");
      expect(metricReceipt.targetKind).toBe("metric");

      // Undo term certification and confirm exact restoration
      const undone = store.undoCertification(receipt.receiptId, "owner");
      expect(undone.targetKind).toBe("term");
      const reloaded = store.getTerm(term.termId);
      expect(reloaded?.certification).toBe("draft");
      expect(reloaded?.canonicalName).toBe("Project Apollo");
      expect(reloaded?.description).toBe("Draft description");
      expect(reloaded?.certifiedBy).toBeNull();

      // Undo metric certification
      store.undoCertification(metricReceipt.receiptId, "owner");
      expect(store.getMetric(metric.metricId)?.certification).toBe("draft");
      expect(store.listCertifications().length).toBe(4);
    } finally {
      store.close();
    }
  });

  test("enforces sensitivity lattice and fail-closed subject scoping", () => {
    expect(withinOntologySensitivity("public", "public")).toBe(true);
    expect(withinOntologySensitivity("personal", "public")).toBe(false);
    expect(withinOntologySensitivity("private", "personal")).toBe(false);
    expect(withinOntologySensitivity("personal", "private")).toBe(true);
    expect(withinOntologySensitivity("unknown", "private")).toBe(false);

    const store = OntologyStore.openInMemory();
    try {
      const pub = store.upsertTerm({
        canonicalName: "Public Atlas",
        domain: "docs",
        subjects: ["doc:public_atlas"],
        sensitivity: "public",
      });
      const pers = store.upsertTerm({
        canonicalName: "Personal Journal",
        domain: "notes",
        subjects: ["note:personal_journal"],
        sensitivity: "personal",
      });
      const priv = store.upsertTerm({
        canonicalName: "Private Vault Key",
        domain: "security",
        subjects: ["secret:vault_key"],
        sensitivity: "private",
      });
      store.upsertRelation({
        sourceTermId: pub.termId,
        targetTermId: priv.termId,
        relationKind: "references",
        sensitivity: "public",
      });

      expect(store.listTerms({ sensitivityCeiling: "public" }).map((t) => t.termId)).toEqual([
        pub.termId,
      ]);
      expect(store.listTerms({ sensitivityCeiling: "personal" }).length).toBe(2);
      expect(store.listTerms({ sensitivityCeiling: "private" }).length).toBe(3);

      // Even if a relation row says public, hidden private endpoint blocks visibility.
      expect(store.listRelations({ sensitivityCeiling: "public" })).toEqual([]);
      expect(store.listRelations({ sensitivityCeiling: "private" }).length).toBe(1);

      // Empty allowedSubjects is fail-closed.
      expect(
        store.listTerms({ sensitivityCeiling: "private", allowedSubjects: [] }),
      ).toEqual([]);
      // Domain name alone must NEVER satisfy subject authorization.
      expect(
        store.listTerms({
          sensitivityCeiling: "private",
          allowedSubjects: ["docs"],
        }),
      ).toEqual([]);
      // Exact provenance-backed subject matches.
      expect(
        store
          .listTerms({
            sensitivityCeiling: "private",
            allowedSubjects: ["doc:public_atlas"],
          })
          .map((t) => t.termId),
      ).toEqual([pub.termId]);

      // Distinct namespaces sharing a bare suffix must NEVER cross-authorize.
      const personAtlas = store.upsertTerm({
        termId: "person:atlas",
        canonicalName: "Atlas",
        domain: "people",
        subjects: ["person:atlas"],
        sensitivity: "public",
      });
      const projectAtlas = store.upsertTerm({
        termId: "project:atlas",
        canonicalName: "Atlas",
        domain: "projects",
        subjects: ["project:atlas"],
        sensitivity: "public",
      });
      expect(personAtlas.termId).toBe("person:atlas");
      expect(projectAtlas.termId).toBe("project:atlas");
      expect(
        store
          .listTerms({
            sensitivityCeiling: "private",
            allowedSubjects: ["person:atlas"],
          })
          .map((t) => t.termId),
      ).toEqual(["person:atlas"]);
      expect(pers.sensitivity).toBe("personal");
    } finally {
      store.close();
    }
  });
});

describe("detectTermFamilies (NVIDIA Auto-Ontology twin & hub isolation)", () => {
  test("detects OLD_/NEW_ twin families, expands same-prefix history, and blocks hub bleed", () => {
    const candidates = [
      // Confirmed twins: ROOMS, BUILDING, RESERVATIONS (with mirrored edges)
      {
        entityId: "t_old_rooms",
        domain: "warehouse",
        name: "OLD_ROOMS",
        termId: "term:old_rooms",
        attributes: ["OLD_ID", "OLD_NAME", "OLD_CAPACITY", "OLD_BUILDING_ID"],
      },
      {
        entityId: "t_new_rooms",
        domain: "warehouse",
        name: "NEW_ROOMS",
        termId: "term:new_rooms",
        attributes: ["NEW_ID", "NEW_NAME", "NEW_CAPACITY", "NEW_BUILDING_ID"],
      },
      {
        entityId: "t_old_building",
        domain: "warehouse",
        name: "OLD_BUILDING",
        termId: "term:old_building",
        attributes: ["OLD_ID", "OLD_ADDRESS", "OLD_FLOORS", "OLD_LEGACY_NOTE"],
      },
      {
        entityId: "t_new_building",
        domain: "warehouse",
        name: "NEW_BUILDING",
        termId: "term:new_building",
        attributes: ["NEW_ID", "NEW_ADDRESS", "NEW_FLOORS", "NEW_GEO_CODE"],
      },
      // History table: excluded as twin seed, joins via same-prefix edge expansion
      {
        entityId: "t_old_rooms_hist",
        domain: "warehouse",
        name: "OLD_ROOMS_HIST",
        termId: "term:old_rooms_hist",
        attributes: ["OLD_ID", "OLD_NAME", "OLD_SNAPSHOT_AT"],
      },
      // Shared hub entity with different prefix: must NOT carry expansion across families
      {
        entityId: "t_dim_date",
        domain: "warehouse",
        name: "DIM_DATE",
        termId: "term:dim_date",
        attributes: ["DATE_ID", "CALENDAR_DAY"],
      },
      // Unrelated prefix connected via DIM_DATE: must NOT join OLD or NEW
      {
        entityId: "t_misc_events",
        domain: "warehouse",
        name: "MISC_EVENTS",
        termId: "term:misc_events",
        attributes: ["EVENT_ID", "DATE_ID"],
      },
    ];

    const edges = [
      // Mirrored edge between ROOMS and BUILDING in OLD and NEW
      {
        sourceEntityId: "t_old_rooms",
        targetEntityId: "t_old_building",
        sourceAttribute: "OLD_BUILDING_ID",
        targetAttribute: "OLD_ID",
      },
      {
        sourceEntityId: "t_new_rooms",
        targetEntityId: "t_new_building",
        sourceAttribute: "NEW_BUILDING_ID",
        targetAttribute: "NEW_ID",
      },
      // Same-prefix edge pulling OLD_ROOMS_HIST into OLD family
      {
        sourceEntityId: "t_old_rooms_hist",
        targetEntityId: "t_old_rooms",
        sourceAttribute: "OLD_ID",
        targetAttribute: "OLD_ID",
      },
      // Cross-prefix edges into shared hub DIM_DATE
      {
        sourceEntityId: "t_old_rooms",
        targetEntityId: "t_dim_date",
        sourceAttribute: "OLD_DATE_ID",
        targetAttribute: "DATE_ID",
      },
      {
        sourceEntityId: "t_misc_events",
        targetEntityId: "t_dim_date",
        sourceAttribute: "DATE_ID",
        targetAttribute: "DATE_ID",
      },
    ];

    // 2 twins (ROOMS Jaccard=1.0, BUILDING Jaccard=3/5=0.6 >= 0.5 with mirrored edge) + 1 mirrored edge = 3 evidence!
    const families = detectTermFamilies(candidates, edges);
    expect(families.length).toBe(2);

    const oldFam = families.find((f) => f.prefix === "OLD");
    const newFam = families.find((f) => f.prefix === "NEW");
    expect(oldFam).toBeDefined();
    expect(newFam).toBeDefined();

    expect(oldFam?.twins).toBe(2);
    expect(oldFam?.expanded).toBe(1);
    expect(oldFam?.mirroredEdges).toBe(1);
    expect(oldFam?.members).toEqual({
      "term:old_building": "BUILDING",
      "term:old_rooms": "ROOMS",
      "term:old_rooms_hist": "ROOMS_HIST",
    });

    expect(newFam?.twins).toBe(2);
    expect(newFam?.expanded).toBe(0);
    expect(newFam?.members).toEqual({
      "term:new_building": "BUILDING",
      "term:new_rooms": "ROOMS",
    });
  });

  test("rejects a single coincidental prefix overlap below confirmation threshold", () => {
    const families = detectTermFamilies(
      [
        {
          entityId: "a",
          domain: "app",
          name: "V1_USERS",
          termId: "term:v1_users",
          attributes: ["ID", "EMAIL"],
        },
        {
          entityId: "b",
          domain: "app",
          name: "V2_USERS",
          termId: "term:v2_users",
          attributes: ["ID", "EMAIL"],
        },
      ],
      [],
    );
    expect(families).toEqual([]);
  });
});

describe("findJoinPath & findConnectingPaths (BFS + default join preference + sensitivity ceiling)", () => {
  test("prefers default joins and higher evidence while strictly enforcing sensitivity ceiling on edges and nodes", () => {
    const store = OntologyStore.openInMemory();
    try {
      const a = store.upsertTerm({ canonicalName: "Ada", sensitivity: "public" });
      const b = store.upsertTerm({ canonicalName: "Apollo", sensitivity: "public" });
      const secretHub = store.upsertTerm({ canonicalName: "Secret Bridge", sensitivity: "private" });
      const c = store.upsertTerm({ canonicalName: "Compiler", sensitivity: "public" });

      // Direct non-default relation A -> B vs default relation A -> B
      store.upsertRelation({
        sourceTermId: a.termId,
        targetTermId: b.termId,
        relationKind: "mentioned",
        evidenceCount: 2,
        isDefaultJoin: false,
        sensitivity: "public",
      });
      store.upsertRelation({
        sourceTermId: a.termId,
        targetTermId: b.termId,
        relationKind: "leads",
        evidenceCount: 10,
        isDefaultJoin: true,
        sensitivity: "public",
      });
      // Shortcut A -> Secret Bridge -> C (2 hops, private intermediate node)
      store.upsertRelation({
        sourceTermId: a.termId,
        targetTermId: secretHub.termId,
        relationKind: "accesses",
        evidenceCount: 50,
        isDefaultJoin: true,
        sensitivity: "public",
      });
      store.upsertRelation({
        sourceTermId: secretHub.termId,
        targetTermId: c.termId,
        relationKind: "controls",
        evidenceCount: 50,
        isDefaultJoin: true,
        sensitivity: "public",
      });
      // Public route B -> C
      store.upsertRelation({
        sourceTermId: b.termId,
        targetTermId: c.termId,
        relationKind: "builds",
        evidenceCount: 5,
        isDefaultJoin: true,
        sensitivity: "public",
      });

      const allTerms = new Map(store.listTerms().map((t) => [t.termId, t]));
      const allRels = store.listRelations();

      // Default join preference
      const ab = findJoinPath(allRels, a.termId, b.termId, {
        sensitivityCeiling: "public",
        termMap: allTerms,
      });
      expect(ab).not.toBeNull();
      expect(ab?.hops).toBe(1);
      expect(ab?.edges[0]?.relationKind).toBe("leads");
      expect(ab?.pathString).toBe("Ada --[leads]--> Apollo");

      // Under public ceiling, path A -> C MUST avoid private Secret Bridge and go via Apollo
      const acPublic = findJoinPath(allRels, a.termId, c.termId, {
        sensitivityCeiling: "public",
        termMap: allTerms,
      });
      expect(acPublic).not.toBeNull();
      expect(acPublic?.nodeIds).toEqual([a.termId, b.termId, c.termId]);
      expect(acPublic?.pathString).toBe("Ada --[leads]--> Apollo --[builds]--> Compiler");

      // Under private ceiling, higher-evidence Secret Bridge route wins at equal 2 hops
      const acPrivate = findJoinPath(allRels, a.termId, c.termId, {
        sensitivityCeiling: "private",
        termMap: allTerms,
      });
      expect(acPrivate?.nodeIds).toEqual([a.termId, secretHub.termId, c.termId]);

      const spanning = findConnectingPaths(allRels, [a.termId, b.termId, c.termId], {
        sensitivityCeiling: "public",
        termMap: allTerms,
      });
      expect(spanning.length).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("Incremental Semantic Compiler (defensive vault scan + sticky certification)", () => {
  test("compiles synthetic Kizuki vault DB, selects one default join per pair, detects families, and preserves certified edits across recompiles", () => {
    const vaultDb = new Database(":memory:");
    const store = OntologyStore.openInMemory();
    try {
      vaultDb.exec(`
        CREATE TABLE canon_pages (
          page_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          path TEXT NOT NULL,
          domain TEXT NOT NULL,
          body TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          aliases TEXT NOT NULL
        );
        CREATE TABLE claims (
          claim_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT,
          predicate TEXT,
          object TEXT,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          polarity TEXT NOT NULL,
          confidence REAL NOT NULL,
          corroboration INTEGER NOT NULL,
          sensitivity TEXT NOT NULL,
          provenance TEXT NOT NULL
        );
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          subjects TEXT NOT NULL,
          sensitivity_hint TEXT NOT NULL,
          deleted INTEGER NOT NULL
        );
        CREATE TABLE claim_links (
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation_kind TEXT NOT NULL,
          confidence REAL NOT NULL,
          evidence_count INTEGER NOT NULL,
          sensitivity TEXT NOT NULL
        );
      `);

      vaultDb.exec(`
        INSERT INTO canon_pages VALUES
          ('p1', 'Project Apollo', 'projects/apollo.md', 'engineering', 'Core orbital runtime project.', 'public', '["Apollo Runtime"]'),
          ('p2', 'Ada Lovelace', 'people/ada.md', 'people', 'Lead systems architect.', 'public', '["Ada"]'),
          ('p3', 'Private Budget', 'finance/budget.md', 'finance', 'Internal reserve numbers.', 'private', '[]');

        INSERT INTO claims VALUES
          ('c1', 'claim', 'person:Ada Lovelace', 'leads', 'project:Project Apollo', 'Ada leads Project Apollo.', 'live', 'positive', 0.95, 3, 'public', '["event:e1"]'),
          ('c2', 'claim', 'person:Ada Lovelace', 'reviews', 'project:Project Apollo', 'Ada reviews Apollo specs.', 'live', 'positive', 0.8, 1, 'public', '["event:e2"]'),
          ('c3', 'commitment', 'person:Ada Lovelace', 'committed_to', 'Ship Milestone 1', 'Deliver milestone 1 by Friday.', 'live', 'positive', 0.9, 2, 'public', '["event:e3"]'),
          ('c4', 'claim', 'project:Project Apollo', 'launch_quarter', 'Q3', 'Apollo launches in Q3.', 'live', 'positive', 0.7, 1, 'public', '["event:e4"]'),
          ('c5', 'claim', 'project:Project Apollo', 'launch_quarter', 'Q4', 'Apollo launches in Q4.', 'live', 'positive', 0.7, 1, 'public', '["event:e5"]');

        INSERT INTO events VALUES
          ('e1', 'notes', 'note', 'Kickoff notes', '["project:Project Apollo", "person:Ada Lovelace"]', 'public', 0);

        INSERT INTO claim_links VALUES
          ('p2', 'p1', 'leads', 0.92, 4, 'public');
      `);

      const first = compileOntologyFromVault(vaultDb, store);
      expect(first.termsCompiled).toBeGreaterThanOrEqual(3);
      expect(first.metricsCompiled).toBe(4);
      expect(first.sourceTables).toEqual(["canon_pages", "claims", "events", "claim_links"]);

      // Verify exactly one default join between Ada Lovelace -> Project Apollo
      const ada = store.getTermByKey("ada_lovelace");
      const apollo = store.getTermByKey("project_apollo");
      expect(ada).not.toBeNull();
      expect(apollo).not.toBeNull();

      const pairRels = store.listRelations({
        sourceTermId: ada!.termId,
        targetTermId: apollo!.termId,
      });
      expect(pairRels.length).toBe(2);
      const defaults = pairRels.filter((r) => r.isDefaultJoin);
      expect(defaults.length).toBe(1);
      expect(defaults[0]?.relationKind).toBe("leads");

      // Built-in metrics exist
      expect(store.getMetricByName("active_commitments")).not.toBeNull();
      expect(store.getMetricByName("open_conflicts")).not.toBeNull();
      expect(store.getMetricByName("domain_coverage")).not.toBeNull();
      expect(store.getMetricByName("certified_ratio")).not.toBeNull();

      // Certify Apollo term + active_commitments metric
      const initialEvidence = apollo!.evidenceCount;
      store.certifyTerm({
        termId: apollo!.termId,
        actor: "owner",
        canonicalName: "Apollo Orbital Runtime",
        description: "Owner-certified canonical description.",
        synonyms: ["Apollo Runtime", "AOR"],
      });
      store.certifyMetric({
        name: "active_commitments",
        actor: "owner",
        description: "Owner-approved commitment KPI.",
      });

      // Add new evidence to vault and recompile -> sticky certification MUST hold!
      vaultDb.exec(`
        UPDATE canon_pages SET body = 'Overwritten draft text from crawl.' WHERE page_id = 'p1';
        INSERT INTO events VALUES ('e9', 'notes', 'note', 'Followup', '["project:Project Apollo"]', 'public', 0);
      `);

      const second = compileOntologyFromVault(vaultDb, store);
      expect(second.preservedCertified).toBe(2);

      const apolloAfter = store.getTerm(apollo!.termId);
      expect(apolloAfter?.certification).toBe("certified");
      expect(apolloAfter?.canonicalName).toBe("Apollo Orbital Runtime");
      expect(apolloAfter?.description).toBe("Owner-certified canonical description.");
      expect(apolloAfter?.synonyms).toEqual(["Apollo Runtime", "AOR"]);
      expect(apolloAfter?.evidenceCount).toBeGreaterThan(initialEvidence);
      expect(apolloAfter?.provenance).toContain("event:e9");

      const metricAfter = store.getMetricByName("active_commitments");
      expect(metricAfter?.certification).toBe("certified");
      expect(metricAfter?.description).toBe("Owner-approved commitment KPI.");
    } finally {
      vaultDb.close();
      store.close();
    }
  });

  test("handles empty vault database defensively without throwing", () => {
    const emptyVault = new Database(":memory:");
    const store = OntologyStore.openInMemory();
    try {
      const report = compileOntologyFromVault(emptyVault, store);
      expect(report.termsCompiled).toBe(0);
      expect(report.sourceTables).toEqual([]);
      expect(report.metricsCompiled).toBe(4);
    } finally {
      emptyVault.close();
      store.close();
    }
  });

  test("keeps distinct namespaced subjects separate and removes unsupported terms, relations, and receipts on recompile", () => {
    const store = OntologyStore.openInMemory();
    try {
      const first = compileOntologyFromInputs(
        {
          claims: [
            {
              claimId: "c-alex",
              subject: "person:alex",
              predicate: "leads",
              object: "project:atlas",
              body: "Alex leads Project Atlas.",
              sensitivity: "public",
              provenance: ["event:e-alex"],
            },
            {
              claimId: "c-person-atlas",
              subject: "person:atlas",
              predicate: "role",
              object: "navigator",
              body: "Person Atlas is a navigator.",
              sensitivity: "public",
              provenance: ["event:e-patlas"],
            },
          ],
        },
        store,
      );
      expect(first.termsCompiled).toBe(3);
      expect(first.relationsCompiled).toBe(1);

      // Distinct namespaces sharing suffix "atlas" stay separate and strictly scoped.
      const onlyPersonAtlas = store.listTerms({
        sensitivityCeiling: "private",
        allowedSubjects: ["person:atlas"],
      });
      expect(onlyPersonAtlas.map((t) => t.termId)).toEqual(["person:atlas"]);
      expect(
        store
          .listTerms({
            sensitivityCeiling: "private",
            allowedSubjects: ["project:atlas"],
          })
          .map((t) => t.termId),
      ).toEqual(["project:atlas"]);

      // Certify person:alex and attach a term-bound metric so receipts and metrics exist.
      store.certifyTerm({
        termId: "person:alex",
        actor: "owner",
        description: "Certified Alex profile.",
      });
      store.upsertMetric({
        name: "alex_deliverables",
        termId: "person:alex",
        description: "Deliverables led by Alex.",
        expression: "COUNT(deliverables)",
        sensitivity: "public",
      });
      expect(store.listCertifications("person:alex").length).toBe(1);

      // Recompile with live claim updated (old provenance removed): surviving certified term must NOT retain purged provenance.
      compileOntologyFromInputs(
        {
          claims: [
            {
              claimId: "c-alex-2",
              subject: "person:alex",
              predicate: "status",
              object: "active",
              body: "Alex is active.",
              sensitivity: "public",
              provenance: ["event:e-alex-2"],
            },
          ],
        },
        store,
      );
      const alexRefreshed = store.getTerm("person:alex");
      expect(alexRefreshed?.certification).toBe("certified");
      expect(alexRefreshed?.provenance).toEqual(["event:e-alex-2", "claim:c-alex-2"]);
      expect(alexRefreshed?.provenance).not.toContain("event:e-alex");

      // Recompile with empty inputs: all unsupported terms, relations, term-bound metrics, and receipts are pruned.
      const pruned = compileOntologyFromInputs({}, store, {
        includeBuiltInMetrics: false,
      });
      expect(pruned.termsCompiled).toBe(0);
      expect(pruned.termsRemoved).toBeGreaterThanOrEqual(1);
      expect(store.listTerms()).toEqual([]);
      expect(store.listRelations()).toEqual([]);
      expect(store.listCertifications()).toEqual([]);
      expect(store.getMetricByName("alex_deliverables")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("checkAnswerable (pre-flight coverage grader + fail-closed security)", () => {
  test("grades answerable, partial, and unanswerable questions and enforces sensitivity ceiling", () => {
    const store = OntologyStore.openInMemory();
    try {
      compileOntologyFromInputs(
        {
          entities: [
            {
              name: "Project Apollo",
              domain: "engineering",
              description: "Orbital runtime",
              synonyms: ["Apollo"],
              sensitivity: "public",
            },
            {
              name: "Ada Lovelace",
              domain: "people",
              description: "Lead architect",
              synonyms: ["Ada"],
              sensitivity: "public",
            },
            {
              name: "Secret Treasury",
              domain: "finance",
              description: "Private accounts",
              sensitivity: "private",
            },
          ],
          links: [
            {
              source: "Ada Lovelace",
              target: "Project Apollo",
              relationKind: "leads",
              evidenceCount: 5,
              sensitivity: "public",
            },
          ],
        },
        store,
      );

      // Fully answerable question with join path
      const full = checkAnswerable(
        store,
        "How does Ada Lovelace relate to Project Apollo?",
        { sensitivityCeiling: "public" },
      );
      expect(full.verdict).toBe("answerable");
      expect(full.coverage).toBe(1);
      expect(full.missing).toEqual([]);
      expect(full.clarification).toBeNull();
      expect(full.joinPaths.length).toBe(1);
      expect(full.joinPaths[0]?.pathString).toBe("Ada Lovelace --[leads]--> Project Apollo");

      // Partial question (1 known, 1 unknown)
      const partial = checkAnswerable(
        store,
        "How does Project Apollo integrate with Quantum Telemetry?",
        { sensitivityCeiling: "public" },
      );
      expect(partial.verdict).toBe("partial");
      expect(partial.coverage).toBeGreaterThan(0);
      expect(partial.coverage).toBeLessThan(1);
      expect(partial.missing).toContain("Quantum Telemetry");
      expect(partial.clarification).not.toBeNull();

      // Unanswerable question about a PRIVATE term under default (public) ceiling: MUST NOT LEAK!
      const blocked = checkAnswerable(store, "What is the balance of Secret Treasury?");
      expect(blocked.sensitivityCeiling).toBe("public");
      expect(blocked.verdict).toBe("unanswerable");
      expect(blocked.resolved).toEqual([]);
      expect(blocked.missing).toContain("Secret Treasury");

      // Same question under private ceiling resolves Secret Treasury
      const allowed = checkAnswerable(store, "What is the balance of Secret Treasury?", {
        sensitivityCeiling: "private",
      });
      expect(allowed.resolved.some((r) => r.canonicalName === "Secret Treasury")).toBe(true);

      // Fail-closed allowedSubjects = [] blocks everything even at private ceiling
      const emptyScope = checkAnswerable(store, "Tell me about Project Apollo", {
        sensitivityCeiling: "private",
        allowedSubjects: [],
      });
      expect(emptyScope.verdict).toBe("unanswerable");
      expect(emptyScope.resolved).toEqual([]);

      // Concept extraction preserves quoted phrases and technical identifiers
      const concepts = extractQuestionConcepts(
        'Compare "Launch Readiness" against OLD_ROOMS and person:ada',
      );
      expect(concepts).toContain("Launch Readiness");
      expect(concepts).toContain("OLD_ROOMS");
      expect(concepts).toContain("person:ada");
    } finally {
      store.close();
    }
  });
});

describe("retrieveOntology (two-tier retrieval + certification ranking + maxChars)", () => {
  test("ranks certified ahead of draft, formats full vs compact tiers, and respects maxChars", () => {
    const store = OntologyStore.openInMemory();
    try {
      const draftHigh = store.upsertTerm({
        canonicalName: "Apollo Draft Telemetry",
        domain: "engineering",
        description: "Draft telemetry stream with high evidence count.",
        attributes: ["latency_ms", "throughput"],
        provenance: ["event:e100"],
        sensitivity: "public",
        evidenceCount: 50,
      });
      const certified = store.upsertTerm({
        canonicalName: "Apollo Core",
        domain: "engineering",
        description: "Certified core runtime for mission scheduling.",
        synonyms: ["Apollo"],
        attributes: ["version", "owner"],
        provenance: ["page:projects/apollo.md"],
        sensitivity: "public",
        evidenceCount: 5,
      });
      store.certifyTerm({ termId: certified.termId, actor: "owner" });

      const third = store.upsertTerm({
        canonicalName: "Apollo Documentation",
        domain: "docs",
        description: "Reference documentation and runbooks for Apollo operators.",
        sensitivity: "public",
        evidenceCount: 3,
      });
      const secret = store.upsertTerm({
        canonicalName: "Apollo Private Secrets",
        domain: "security",
        description: "Restricted internal details.",
        sensitivity: "private",
        evidenceCount: 99,
      });

      store.upsertRelation({
        sourceTermId: certified.termId,
        targetTermId: draftHigh.termId,
        relationKind: "emits",
        evidenceCount: 8,
        isDefaultJoin: true,
        sensitivity: "public",
      });

      const res = retrieveOntology(store, "Apollo", {
        purpose: "all",
        fullHits: 1,
        maxChars: 2000,
        sensitivityCeiling: "public",
      });

      // Private term excluded
      expect(res.terms.some((t) => t.term.termId === secret.termId)).toBe(false);
      // Certified ranks first ahead of higher-evidence draft!
      expect(res.terms[0]?.term.termId).toBe(certified.termId);
      expect(res.terms[0]?.tier).toBe("full");
      expect(res.terms[1]?.tier).toBe("summary");
      expect(res.terms[2]?.term.termId).toBe(third.termId);
      expect(res.rendered).toContain("## Full Terms");
      expect(res.rendered).toContain("## Compact Terms");
      expect(res.rendered).toContain("## Join Paths");
      expect(res.rendered.length).toBeLessThanOrEqual(2000);

      // Strict maxChars truncation
      const tight = retrieveOntology(store, "Apollo", {
        purpose: "all",
        fullHits: 2,
        maxChars: 180,
        sensitivityCeiling: "public",
      });
      expect(tight.truncated).toBe(true);
      expect(tight.rendered.length).toBeLessThanOrEqual(180);
    } finally {
      store.close();
    }
  });
});

describe("Ossie YAML/JSON interchange (deterministic export + lossless round-trip)", () => {
  test("round-trips concepts, families, relations, metrics, and tricky strings through YAML and JSON", () => {
    const sourceStore = OntologyStore.openInMemory();
    const targetStore = OntologyStore.openInMemory();
    try {
      const t1 = sourceStore.upsertTerm({
        canonicalName: "OLD_ROOMS",
        kind: "table",
        domain: "warehouse",
        description: "Legacy rooms: includes \"quotes\", colons: yes, and\nsecond line.",
        synonyms: ["Rooms V1", "Legacy:Rooms"],
        attributes: [
          {
            name: "OLD_CAPACITY",
            kind: "integer",
            description: "Seats: max # count",
            values: ["10", "20", "true"],
          },
        ],
        provenance: ["page:warehouse/old_rooms.md"],
        sensitivity: "public",
        evidenceCount: 12,
      });
      sourceStore.certifyTerm({ termId: t1.termId, actor: "owner" });

      const t2 = sourceStore.upsertTerm({
        canonicalName: "OLD_BUILDING",
        kind: "table",
        domain: "warehouse",
        description: "Legacy building master.",
        synonyms: [],
        attributes: [{ name: "OLD_ID" }],
        provenance: [],
        sensitivity: "public",
        evidenceCount: 7,
      });

      sourceStore.upsertTerm({
        canonicalName: "Private Ledger",
        domain: "finance",
        description: "Should be omitted from public export",
        sensitivity: "private",
      });

      sourceStore.upsertTermFamily({
        familyId: "fam:warehouse:old",
        prefix: "OLD",
        domain: "warehouse",
        members: { [t1.termId]: "ROOMS", [t2.termId]: "BUILDING" },
        twinCount: 2,
        mirroredEdgeCount: 1,
      });

      sourceStore.upsertRelation({
        sourceTermId: t1.termId,
        targetTermId: t2.termId,
        relationKind: "belongs_to",
        evidenceCount: 9,
        confidence: 0.93,
        isDefaultJoin: true,
        supportRefs: ["claim:c1"],
        sensitivity: "public",
      });

      const m1 = sourceStore.upsertMetric({
        name: "room_utilization",
        termId: t1.termId,
        description: "Active bookings divided by capacity.",
        expression: "SUM(booked_hours) / NULLIF(SUM(capacity_hours), 0)",
        grain: "day",
        sensitivity: "public",
      });
      sourceStore.certifyMetric({ metricId: m1.metricId, actor: "owner" });

      const fixedTime = "2026-01-15T12:00:00.000Z";
      const yaml1 = exportOssieYaml(sourceStore, {
        sensitivityCeiling: "public",
        exportedAt: fixedTime,
      });
      const yaml2 = exportOssieYaml(sourceStore, {
        sensitivityCeiling: "public",
        exportedAt: fixedTime,
      });
      // Deterministic output
      expect(yaml1).toBe(yaml2);
      expect(yaml1).not.toContain("Private Ledger");

      const parsed = parseOssieYaml(yaml1);
      expect(parsed.version).toBe("ossie/v1");
      expect(parsed.concepts.length).toBe(2);
      expect(parsed.term_families.length).toBe(1);
      expect(parsed.relationships.length).toBe(1);
      expect(parsed.metrics.length).toBe(1);

      const imported = importOssieModel(targetStore, yaml1);
      expect(imported.conceptsImported).toBe(2);
      expect(imported.familiesImported).toBe(1);
      expect(imported.relationshipsImported).toBe(1);
      expect(imported.metricsImported).toBe(1);

      const reloadedT1 = targetStore.getTerm(t1.termId);
      expect(reloadedT1?.certification).toBe("certified");
      expect(reloadedT1?.description).toBe(
        "Legacy rooms: includes \"quotes\", colons: yes, and\nsecond line.",
      );
      expect(reloadedT1?.synonyms).toEqual(["Rooms V1", "Legacy:Rooms"]);
      expect(reloadedT1?.attributes[0]?.values).toEqual(["10", "20", "true"]);

      const reloadedRel = targetStore.listRelations()[0];
      expect(reloadedRel?.isDefaultJoin).toBe(true);
      expect(reloadedRel?.confidence).toBe(0.93);

      const reloadedMetric = targetStore.getMetricByName("room_utilization");
      expect(reloadedMetric?.certification).toBe("certified");
      expect(reloadedMetric?.grain).toBe("day");

      // JSON export also round-trips cleanly
      const jsonStr = exportOssieJson(targetStore, { exportedAt: fixedTime });
      const parsedFromJson = parseOssieYaml(jsonStr);
      expect(parsedFromJson.concepts.length).toBe(2);
    } finally {
      sourceStore.close();
      targetStore.close();
    }
  });
});
