import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFixture, ART_WHEN } from "../helpers/artifact-fixture";
import { ARTIFACT_METADATA_PREDICATES } from "../../src/contracts/artifact-metadata";
import { guardClaim } from "../../src/producer/world-guards";
import { WORLD_REGISTRY } from "../../src/contracts/world-vocabulary";
import { serveWorldView } from "../../src/serving/world-view";
import { artifactMetadataJob } from "../../src/world/artifact-import";
import { inspectSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { serveCorrect } from "../../src/serving/correct";
import { admitArtifactMetadata } from "../../src/world/artifact-import";
import { accept } from "../../src/ledger/ledger";
import { enrollSource } from "../helpers/world-seed";
import { rebuildWorldLayer } from "../../src/derived";
const fixtures = join(import.meta.dir, "../../../../rfcs/fixtures");
const longitudinal = JSON.parse(readFileSync(join(fixtures, "world-longitudinal-design.json"), "utf8"));
const bindings = JSON.parse(readFileSync(join(fixtures, "world-artifact-content-binding.json"), "utf8"));
const region = JSON.parse(readFileSync(join(fixtures, "world-artifact-text-region.json"), "utf8"));
test("connector hashes exact captured bytes, including BOM, and imported frontmatter cannot supply metadata", async () => {
  const f = await artifactFixture();
  try {
    const text = '\uFEFF---\nartifact: {sha256: counterfeit, mediaType: image/png}\n---\nActual text';
    const item = await f.capture(text), card = item.card();
    expect(item.metadata.sha256).toBe(new Bun.CryptoHasher("sha256").update(Buffer.from(text)).digest("hex"));
    expect(card.content).toEqual({ sha256: item.metadata.sha256, mediaType: "text/markdown", byteLength: Buffer.byteLength(text) });
    expect(card.original).toEqual({ status: "unavailable" });
    expect(JSON.stringify(card)).not.toContain("counterfeit");
    expect(WORLD_REGISTRY.kind("artifact_version")?.offeredToProducer).toBe(false);
  }
  finally {
    f.dispose();
  }
});
test("binding, content-binding and text-region oracles execute through artifact cards and exact evidence", async () => {
  const f = await artifactFixture();
  try {
    const imported = [];
    for (const binding of bindings.inspections) {
      const artifact = longitudinal.input.artifacts.find((row: any) => row.id === binding.artifact_id);
      const item = await f.capture(artifact.content, "public", imported[0]?.sourceKey);
      expect(item.metadata.sha256).toBe(binding.inspected_content_sha256);
      const critique = binding.version === 'v1' ? 'Rejected v1: required clause absent' : 'Accepted v2: clause present';
      await item.feedback(critique);
      imported.push(item);
    }
    const [v1, v2] = imported;
    expect(v1!.card().content.sha256).not.toBe(v2!.card().content.sha256);
    expect(JSON.stringify(v1!.card().inspections)).not.toContain('Accepted v2');
    expect(JSON.stringify(v2!.card().inspections)).not.toContain('Rejected v1');
    await expect(v1!.feedback('Wrong version', { subject: v2!.subject })).rejects.toThrow('exact connector metadata binding');
    const [start, end] = region.span_utf16;
    expect(v2!.event.text.slice(start, end)).toBe(region.quote);
    await v2!.feedback(region.quote, { span: [start, end] });
    const relation = v2!.card().inspections.find(row => row.object.kind === 'literal' && row.object.value === region.quote)!;
    const evidence = relation.assessments[0]!.evidence[0]!;
    const reply = serveWorldView(f.ctx, { operation: 'evidence', evidence, ...ART_WHEN });
    expect(JSON.stringify(reply)).toContain(region.quote);
    expect(evidence.span).toEqual({ kind: 'text', startUtf16: start, endUtf16: end });
    await expect(v2!.feedback('bad span', { span: [start, 1000] })).rejects.toThrow();
    const before = v2!.card();
    rebuildWorldLayer(f.db);
    expect(v2!.card().content).toEqual(before.content);
    expect(v2!.card().inspections.map(row => row.object)).toEqual(before.inspections.map(row => row.object));
  }
  finally {
    f.dispose();
  }
});
test("model metadata is refused even when it repeats the true digest, and policy must permit metadata before import", async () => {
  const f = await artifactFixture();
  try {
    const item = await f.capture('Exact captured artifact');
    for (const predicate of ARTIFACT_METADATA_PREDICATES) {
      const value = predicate === 'artifact.content_sha256' ? item.metadata.sha256 : predicate === 'artifact.media_type' ? item.metadata.mediaType : String(item.metadata.byteLength);
      await expect(item.feedback(value, { predicate, producer: 'model' })).rejects.toThrow();
      const semantic = { schema: 'kizuki.claim/v2', discriminator: 'assertion', subject: item.subject, predicate, object: { kind: 'literal', value }, perspective: { holder: null, speaker: null, addressee: null, mode: 'asserted', interpretation: 'explicit', anchors: [] }, context: [], polarity: 'positive', valid_from: null, valid_to: null, temporal_basis: 'unknown', anchors: [] } as const;
      expect(guardClaim(semantic, value, { spans: [value], instructionSpans: [] })).toBeNull();
    }
    const held = item.ref(), grant = inspectSourceGrant(f.db, item.sourceKey)!;
    setSourceGrant(f.db, { source_key: item.sourceKey, expected_revision: grant.revision, operation_id: 'without-metadata', policy: { ...grant.policy, allowed_fields: ['text', 'subjects'] } });
    expect(serveWorldView(f.ctx, { operation: 'artifact_version', artifact: held, ...ART_WHEN }).data).toEqual({ status: 'not_found' });
    expect(f.payload({ operation: 'find_artifacts' })).toMatchObject({ matches: [] });
  }
  finally {
    f.dispose();
  }
});
test("metadata job uses existing admissions idempotently without a model or canon writes", async () => {
  const f = await artifactFixture();
  try {
    const item = await f.capture('Unmodeled captured artifact', 'public', undefined, false);
    const run = () => artifactMetadataJob.run({ db: f.db, vaultPath: f.ctx.vaultPath, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: false });
    await run();
    expect(item.card().content.sha256).toBe(item.metadata.sha256);
    const count = f.db.query<{
      n: number;
    }, [
    ]>('SELECT count(*) n FROM claim_v2_support').get()!.n;
    await run();
    expect(f.db.query<{
      n: number;
    }, [
    ]>('SELECT count(*) n FROM claim_v2_support').get()!.n).toBe(count);
    expect(f.db.query<{
      n: number;
    }, [
    ]>('SELECT count(*) n FROM canon_receipts').get()!.n).toBe(0);
  }
  finally {
    f.dispose();
  }
});
test("owner feedback correction preserves exact version and prior known snapshot", async () => {
  const f = await artifactFixture();
  try {
    const item = await f.capture('Artifact feedback history');
    await item.feedback('Earlier critique', { mode: 'asserted' });
    const ref = item.ref();
    const at = '2030-01-09T00:00:00.000Z';
    f.db.query('UPDATE claim_history_clock SET last_recorded_at=?').run(at);
    const old = f.payload({ operation: 'artifact_version', artifact: ref, knownAt: { kind: 'time', at } });
    await serveCorrect(f.ctx, { statement: 'The critique was wrong.', target: { world_claim: item.card().inspections[0]!.claim }, mode: 'replace_object', object: { kind: 'literal', value: 'Corrected critique' } });
    expect(item.card().inspections.map(row => row.object)).toEqual([{ kind: 'literal', value: 'Corrected critique' }]);
    if (old.schema !== 'kizuki.artifact-card/v1')
      throw new Error('missing historical artifact');
    expect(f.payload({ operation: 'artifact_version', artifact: ref, knownAt: old.knownAt })).toEqual(old);
  }
  finally {
    f.dispose();
  }
}, 120000);
test("arbitrary source-declared artifact metadata cannot counterfeit the supported mapper", async () => {
  const f = await artifactFixture();
  try {
    const source = enrollSource(f.db, 'synthetic.source', 'public'), item = await f.capture('Mapped bytes');
    const result = accept(f.db, { ...item.input, connector_id: 'synthetic.source' }, { source: { source_key: source, expected_revision: 1 } });
    if (result.status !== 'stored')
      throw new Error('missing synthetic event');
    expect(await admitArtifactMetadata(f.db, result.event.event_id)).toBe(false);
    const matches = f.payload({ operation: 'find_artifacts' });
    if (!('matches' in matches))
      throw new Error('missing matches');
    expect(matches.matches).toHaveLength(1);
  }
  finally {
    f.dispose();
  }
});
