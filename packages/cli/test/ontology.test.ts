import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept, insertClaim, serializePage } from "@kizuki/core";
import { initGraph, initSearch, openLedger, rebuildDerived } from "@kizuki/core/internal";
import { parseOssieYaml } from "@kizuki/ontology";
import { createHelpers } from "./helpers";

setDefaultTimeout(60_000);

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

async function seedRichVault(vaultPath: string): Promise<void> {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);

    const writeCanon = (
      relPath: string,
      data: Record<string, unknown>,
      body: string,
    ): void => {
      const fullPath = join(vaultPath, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, serializePage({ data, body }), "utf8");
    };

    writeCanon(
      "entities/person-ada.md",
      {
        id: "person:ada",
        title: "Ada Lovelace",
        type: "person",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["person:ada"],
      },
      "Ada Lovelace leads the Analytical Engine program and coordinates with [[Project Orion]].",
    );
    writeCanon(
      "projects/project-orion.md",
      {
        id: "project:orion",
        title: "Project Orion",
        type: "project",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["project:orion"],
      },
      "Project Orion delivers the core telemetry pipeline for [[Acme Observatory]].",
    );
    writeCanon(
      "orgs/acme-observatory.md",
      {
        id: "org:acme_observatory",
        title: "Acme Observatory",
        type: "org",
        status: "active",
        sensitivity: "public",
        taint: "clean",
        subjects: ["org:acme_observatory"],
      },
      "Acme Observatory operates deep-space instrumentation.",
    );

    const stored = accept(db, {
      schema: "kizuki.event/v1",
      connector_id: "fixture",
      source_record_id: "onto-cli-1",
      kind: "message",
      occurred_at: "2026-03-01T10:00:00Z",
      observed_at: "2026-03-01T10:01:00Z",
      text: "Ada Lovelace leads Project Orion which supports Acme Observatory.",
      subjects: [
        { subject_id: "person:ada", role: "about" },
        { subject_id: "project:orion", role: "about" },
      ],
      sensitivity_hint: "public",
      deleted: false,
      attachments: [],
      metadata: {},
    });
    if (stored.status !== "stored") {
      throw new Error("failed to store seed event");
    }

    await insertClaim(
      { db, vault_path: vaultPath },
      {
        kind: "claim",
        producer: "owner",
        subject: "Ada Lovelace",
        predicate: "project.owns",
        object: "Project Orion",
        body: "Ada Lovelace leads Project Orion.",
        provenance: [stored.event.event_id],
        sensitivity: "public",
        confidence: 0.95,
      },
    );
    await insertClaim(
      { db, vault_path: vaultPath },
      {
        kind: "claim",
        producer: "owner",
        subject: "Project Orion",
        predicate: "employment.works_at",
        object: "Acme Observatory",
        body: "Project Orion supports Acme Observatory.",
        provenance: [stored.event.event_id],
        sensitivity: "public",
        confidence: 0.92,
      },
    );

    rebuildDerived(db, vaultPath);
  } finally {
    db.close();
  }
}

describe("kizuki ontology CLI", () => {
  test("help matches schema and status stays strictly read-only on an untouched vault", () => {
    const env = isolatedEnv();
    const help = runCli(env, "help", "ontology", "--json");
    expect(help.exitCode, help.stderr).toBe(0);
    const helpBody = JSON.parse(help.stdout) as {
      data: { name: string; options: string[]; flags: string[] };
    };
    expect(helpBody.data.name).toBe("ontology");
    expect(helpBody.data.options).toContain("--purpose");
    expect(helpBody.data.options).toContain("--format");
    expect(helpBody.data.flags).toContain("--json");

    const setup = tempVault();
    const dbPath = join(setup.vault, ".kizuki", "ontology.sqlite");
    expect(existsSync(dbPath)).toBe(false);

    const status = runCli(setup.env, "ontology", "status", "--json");
    expect(status.exitCode, status.stderr).toBe(0);
    const body = JSON.parse(status.stdout) as {
      status: string;
      data: { compiled: boolean; termCount: number };
    };
    expect(body.status).toBe("ok");
    expect(body.data.compiled).toBe(false);
    expect(body.data.termCount).toBe(0);
    // Strictly read-only: ontology.sqlite MUST NOT be created.
    expect(existsSync(dbPath)).toBe(false);
  });

  test("compile -> status -> search -> term -> path -> check -> certify (sticky) -> export/import Ossie YAML", async () => {
    const setup = tempVault();
    await seedRichVault(setup.vault);

    // 1. Compile ontology from vault ledger
    const compiled = runCli(setup.env, "ontology", "compile", "--json");
    expect(compiled.exitCode, compiled.stderr).toBe(0);
    const compileData = JSON.parse(compiled.stdout).data as {
      termsCompiled: number;
      relationsCompiled: number;
      defaultJoinsSelected: number;
      metricsCompiled: number;
      preservedCertified: number;
    };
    expect(compileData.termsCompiled).toBeGreaterThanOrEqual(3);
    expect(compileData.relationsCompiled).toBeGreaterThanOrEqual(2);
    expect(compileData.defaultJoinsSelected).toBeGreaterThanOrEqual(2);
    expect(compileData.metricsCompiled).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(setup.vault, ".kizuki", "ontology.sqlite"))).toBe(true);

    // 2. Status reflects compiled ontology
    const status = runCli(setup.env, "ontology", "status", "--json");
    expect(status.exitCode, status.stderr).toBe(0);
    const statusData = JSON.parse(status.stdout).data as {
      compiled: boolean;
      termCount: number;
      relationCount: number;
      metricCount: number;
    };
    expect(statusData.compiled).toBe(true);
    expect(statusData.termCount).toBeGreaterThanOrEqual(3);
    expect(statusData.relationCount).toBeGreaterThanOrEqual(2);
    expect(statusData.metricCount).toBeGreaterThanOrEqual(4);

    // 3. Search with purpose and max-chars
    const searchRes = runCli(
      setup.env,
      "ontology",
      "search",
      "Ada Lovelace",
      "--purpose",
      "all",
      "--max-chars",
      "1200",
      "--json",
    );
    expect(searchRes.exitCode, searchRes.stderr).toBe(0);
    const searchData = JSON.parse(searchRes.stdout).data as {
      terms: { term: { termId: string; canonicalName: string }; tier: string }[];
      rendered: string;
      totalChars: number;
    };
    expect(searchData.terms.length).toBeGreaterThan(0);
    expect(searchData.terms[0]?.tier).toBe("full");
    expect(searchData.totalChars).toBeLessThanOrEqual(1200);
    const adaTermId = searchData.terms.find((t) =>
      t.term.canonicalName.toLowerCase().includes("ada"),
    )?.term.termId;
    expect(adaTermId).toBeDefined();

    // 4. Inspect single term
    const termRes = runCli(setup.env, "ontology", "term", adaTermId!, "--json");
    expect(termRes.exitCode, termRes.stderr).toBe(0);
    const termData = JSON.parse(termRes.stdout).data as {
      term: { termId: string; canonicalName: string; certification: string };
      relations: { relationKind: string }[];
    };
    expect(termData.term.termId).toBe(adaTermId!);
    expect(termData.term.certification).toBe("draft");
    expect(termData.relations.length).toBeGreaterThan(0);

    // 5. Shortest semantic join path across 2 hops: Ada Lovelace -> Project Orion -> Acme Observatory
    const pathRes = runCli(
      setup.env,
      "ontology",
      "path",
      "Ada Lovelace",
      "Acme Observatory",
      "--json",
    );
    expect(pathRes.exitCode, pathRes.stderr).toBe(0);
    const pathData = JSON.parse(pathRes.stdout).data as {
      found: boolean;
      path: { hops: number; pathString: string } | null;
    };
    expect(pathData.found).toBe(true);
    expect(pathData.path).not.toBeNull();
    expect(pathData.path?.hops).toBe(2);
    expect(pathData.path?.pathString).toContain("Project Orion");

    // 6. Pre-flight answerability check: answerable vs unanswerable
    const answerable = runCli(
      setup.env,
      "ontology",
      "check",
      "How does Ada Lovelace relate to Acme Observatory?",
      "--json",
    );
    expect(answerable.exitCode, answerable.stderr).toBe(0);
    const answerableData = JSON.parse(answerable.stdout).data as {
      verdict: string;
      coverage: number;
      resolved: { canonicalName: string }[];
      joinPaths: { hops: number }[];
      missing: string[];
    };
    expect(answerableData.verdict).toBe("answerable");
    expect(answerableData.coverage).toBeGreaterThanOrEqual(0.85);
    expect(answerableData.missing).toEqual([]);
    expect(answerableData.joinPaths.length).toBeGreaterThan(0);

    const unanswerable = runCli(
      setup.env,
      "ontology",
      "check",
      "What is the quantum flux budget for Zephyr Citadel?",
      "--json",
    );
    expect(unanswerable.exitCode, unanswerable.stderr).toBe(0);
    const unanswerableData = JSON.parse(unanswerable.stdout).data as {
      verdict: string;
      coverage: number;
      missing: string[];
      clarification: string | null;
    };
    expect(unanswerableData.verdict).toBe("unanswerable");
    expect(unanswerableData.coverage).toBe(0);
    expect(unanswerableData.missing.length).toBeGreaterThan(0);
    expect(unanswerableData.clarification).not.toBeNull();

    // 7. Certify term with auditable receipt and prove sticky survival across recompilation
    const certified = runCli(
      setup.env,
      "ontology",
      "certify",
      adaTermId!,
      "--name",
      "Ada Lovelace (Principal)",
      "--description",
      "Certified lead architect for Project Orion.",
      "--synonym",
      "Countess Ada",
      "--synonym",
      "Lead Architect Ada",
      "--json",
    );
    expect(certified.exitCode, certified.stderr).toBe(0);
    const certData = JSON.parse(certified.stdout).data as {
      term: {
        termId: string;
        canonicalName: string;
        description: string;
        synonyms: string[];
        certification: string;
        certifiedBy: string | null;
      };
      receipt: { receiptId: string; action: string };
    };
    expect(certData.term.certification).toBe("certified");
    expect(certData.term.certifiedBy).toBe("owner");
    expect(certData.term.canonicalName).toBe("Ada Lovelace (Principal)");
    expect(certData.term.description).toBe(
      "Certified lead architect for Project Orion.",
    );
    expect(certData.term.synonyms).toContain("Countess Ada");
    expect(certData.term.synonyms).toContain("Lead Architect Ada");
    expect(certData.receipt.receiptId).toMatch(/^cert_/);

    // Recompile and confirm sticky certification survives
    const recompiled = runCli(setup.env, "ontology", "compile", "--json");
    expect(recompiled.exitCode, recompiled.stderr).toBe(0);
    expect(JSON.parse(recompiled.stdout).data.preservedCertified).toBeGreaterThanOrEqual(1);

    const afterRecompile = JSON.parse(
      runCli(setup.env, "ontology", "term", adaTermId!, "--json").stdout,
    ).data.term as {
      canonicalName: string;
      description: string;
      synonyms: string[];
      certification: string;
    };
    expect(afterRecompile.certification).toBe("certified");
    expect(afterRecompile.canonicalName).toBe("Ada Lovelace (Principal)");
    expect(afterRecompile.description).toBe(
      "Certified lead architect for Project Orion.",
    );
    expect(afterRecompile.synonyms).toContain("Countess Ada");

    // 8. Export Ossie YAML to file & verify structure + JSON stdout export
    const yamlFile = join(setup.root, "ontology-export.yaml");
    const exportedYaml = runCli(
      setup.env,
      "ontology",
      "export",
      "--format",
      "ossie-yaml",
      "--out",
      yamlFile,
      "--json",
    );
    expect(exportedYaml.exitCode, exportedYaml.stderr).toBe(0);
    expect(existsSync(yamlFile)).toBe(true);
    const yamlText = readFileSync(yamlFile, "utf8");
    const parsedDoc = parseOssieYaml(yamlText);
    expect(parsedDoc.version).toBe("ossie/v1");
    expect(parsedDoc.concepts.some((c) => c.id === adaTermId && c.certified)).toBe(true);

    const exportedJson = runCli(setup.env, "ontology", "export", "--format", "json");
    expect(exportedJson.exitCode, exportedJson.stderr).toBe(0);
    expect(JSON.parse(exportedJson.stdout).version).toBe("ossie/v1");

    // 9. Import Ossie YAML into a second fresh vault and verify round-trip fidelity
    const targetVault = tempVault();
    const imported = runCli(
      targetVault.env,
      "ontology",
      "import",
      "--file",
      yamlFile,
      "--json",
    );
    expect(imported.exitCode, imported.stderr).toBe(0);
    const importData = JSON.parse(imported.stdout).data as {
      conceptsImported: number;
      relationshipsImported: number;
      metricsImported: number;
    };
    expect(importData.conceptsImported).toBe(parsedDoc.concepts.length);
    expect(importData.relationshipsImported).toBe(parsedDoc.relationships.length);
    expect(importData.metricsImported).toBe(parsedDoc.metrics.length);

    const importedTerm = JSON.parse(
      runCli(targetVault.env, "ontology", "term", adaTermId!, "--json").stdout,
    ).data.term as {
      canonicalName: string;
      description: string;
      certification: string;
    };
    expect(importedTerm.certification).toBe("certified");
    expect(importedTerm.canonicalName).toBe("Ada Lovelace (Principal)");
    expect(importedTerm.description).toBe(
      "Certified lead architect for Project Orion.",
    );
  });
});
