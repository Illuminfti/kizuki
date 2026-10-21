import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkdownFolderConnector, MARKDOWN_FOLDER_CONNECTOR_ID } from "../../../connectors/src/markdown-folder";
import { OWNER } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { insertClaim, type InsertClaimInput } from "../../src/claims/store";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import type { ArtifactCard } from "../../src/contracts/artifact-card";
import { artifactSubjectId, parseArtifactMetadata } from "../../src/contracts/artifact-metadata";
import { admitArtifactMetadata } from "../../src/world/artifact-import";
import { resolveWorldObject, worldNamespace } from "../../src/world/references";
import { handleFor } from "../../src/world/relation";
import { serveWorldView } from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { tempVault } from "./vault";
import { enrollSource } from "./world-seed";
export const ART_WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
export async function artifactFixture(database?: Database) {
  const vault = tempVault("kizuki-artifact-"), db = database ?? openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const roots: string[] = [], ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
  function payload(input: Record<string, unknown>, reader = ctx) { const result = serveWorldView(reader, { ...ART_WHEN, ...input }).data; if (!("result" in result) || !("data" in result.result))
    throw new Error(`missing artifact data: ${JSON.stringify(result)}`); return result.result.data; }
  async function capture(text: string, floor: "public" | "private" = "public", sourceKey?: string, admit = true) {
    const root = mkdtempSync(join(tmpdir(), "artifact-input-"));
    roots.push(root);
    writeFileSync(join(root, "artifact.md"), text);
    const connector = createMarkdownFolderConnector({ path: root }), batch = await connector.backfill(null), input = batch.events[0]!;
    const key = sourceKey ?? enrollSource(db, MARKDOWN_FOLDER_CONNECTOR_ID, floor);
    const accepted = accept(db, { ...input, sensitivity_hint: floor }, { source: { source_key: key, expected_revision: 1 } });
    if (accepted.status !== "stored")
      throw new Error(`artifact fixture capture ${accepted.status}`);
    const event = accepted.event;
    const metadata = parseArtifactMetadata(event.metadata.artifact);
    if (!metadata)
      throw new Error("missing mapped metadata");
    if (admit && !await admitArtifactMetadata(db, event.event_id))
      throw new Error("metadata not admitted");
    const subject = { kind: "supplied" as const, id: artifactSubjectId(metadata.sha256), namespace: { connector_id: MARKDOWN_FOLDER_CONNECTOR_ID, source_key: key } };
    async function feedback(value: string, options: {
      subject?: ClaimV2Assertion["subject"];
      span?: [
        number,
        number
      ];
      predicate?: string;
      producer?: InsertClaimInput["producer"];
      mode?: ClaimV2Assertion["perspective"]["mode"];
    } = {}) {
      const semantic: ClaimV2Assertion = { schema: "kizuki.claim/v2", discriminator: "assertion", subject: options.subject ?? subject, predicate: options.predicate ?? "artifact.feedback", object: { kind: "literal", value }, perspective: { holder: null, speaker: null, addressee: null, mode: options.mode ?? "quoted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", valid_from: null, valid_to: null, temporal_basis: "unknown", anchors: [{ event_id: event.event_id, start_utf16: options.span?.[0] ?? 0, end_utf16: options.span?.[1] ?? event.text.length }] };
      const body = `Attributed feedback: ${value}`;
      return insertClaim({ db }, { kind: "claim", body, provenance: [event.event_id], producer: options.producer ?? "model", confidence: 0.6, semantic, world_admission: { schema: "kizuki.world-admission/v1", semantic, rendering: { body, frontmatter: {} }, authority: "model_inference", confidence: 0.6, epistemicKind: "model_inference" } });
    }
    function ref(reader = ctx) { const data = payload({ operation: "find_artifacts", label: metadata!.sha256.slice(0, 12) }, reader); if (!("matches" in data))
      throw new Error("no artifacts"); return db.transaction(() => data.matches.find(row => resolveWorldObject(db, worldNamespace(db, reader.principal), row.ref.token) === handleFor(db, subject))!.ref)(); }
    function card(reader = ctx) { return payload({ operation: "artifact_version", artifact: ref(reader) }, reader) as ArtifactCard; }
    return { event: event, input, metadata, sourceKey: key, subject, feedback, ref, card };
  }
  return { db, ctx, capture, payload, dispose() { if (!database)
      db.close(); vault.dispose(); for (const root of roots)
      rmSync(root, { recursive: true, force: true }); } };
}
