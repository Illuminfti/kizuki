import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { admitArtifactMetadata } from "../../src/world/artifact-import";
import { artifactFixture, ART_WHEN } from "../helpers/artifact-fixture";
import { enrollSource } from "../helpers/world-seed";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { runPurge } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { rebuildWorldLayer } from "../../src/derived";
test("same bytes in denied sources never union annotations or alter visible work", async () => {
  const f = await artifactFixture();
  try {
    const source = enrollSource(f.db, 'kizuki.markdown-folder', 'private');
    const visible = await f.capture('Shared artifact bytes');
    await visible.feedback('Permitted annotation');
    const agent = addAgent(f.db, 'artifact-public', { ...OWNER_AGENT_GRANT, ceiling: 'public' }), ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const ref = visible.ref(ctx), input = { operation: 'artifact_version', artifact: ref, ...ART_WHEN };
    const observe = () => collectReadFrames(() => serveWorldView(ctx, input));
    const before = observe();
    const hidden = await f.capture('Shared artifact bytes', 'private', source);
    await hidden.feedback('Private annotation marker');
    const after = observe();
    const body = (value: ReturnType<typeof observe>) => { const result = value.result.data; if (!('result' in result) || !('data' in result.result))
      throw new Error('missing card'); return result.result.data; };
    expect(body(after)).toEqual(body(before));
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(visible.card().artifact.ref.token).not.toBe(hidden.card().artifact.ref.token);
    expect(JSON.stringify(visible.card())).not.toContain('Private annotation marker');
    expect(JSON.stringify(hidden.card())).not.toContain('Permitted annotation');
    const discovery = f.payload({ operation: 'find_artifacts' }, ctx);
    expect(discovery).toMatchObject({ matches: [{ labels: [`Artifact ${visible.metadata.sha256.slice(0, 12)}`] }] });
  }
  finally {
    f.dispose();
  }
}, 120000);
test.each(['revoke', 'purge'] as const)("%s invalidates artifact cards, references and retained views", async (action) => {
  const f = await artifactFixture();
  try {
    const item = await f.capture('Artifact to withdraw');
    await item.feedback('Withdrawn annotation');
    const ref = item.ref();
    const before = serveWorldView(f.ctx, { operation: 'artifact_version', artifact: ref, ...ART_WHEN }).data;
    if (!('result' in before) || before.result.status !== 'current')
      throw new Error('missing retained baseline');
    if (action === 'purge')
      await runPurge(f.db, f.ctx.vaultPath, { event_id: item.event.event_id }, 'artifact-purge');
    else
      revokeSourceGrant(f.db, { source_key: item.sourceKey, expected_revision: 1, operation_id: 'artifact-revoke' });
    const after = serveWorldView(f.ctx, { operation: 'artifact_version', artifact: ref, priorView: before.result.view, ...ART_WHEN }).data;
    expect(after).toMatchObject({ result: { status: 'new_view_required' } });
    expect(f.payload({ operation: 'find_artifacts' })).toMatchObject({ matches: [] });
    expect(serveWorldView(f.ctx, { operation: 'artifact_version', artifact: ref, ...ART_WHEN }).data).toEqual({ status: 'not_found' });
  }
  finally {
    f.dispose();
  }
}, 120000);
test("artifact versions survive export/restore and rebuild; purged source leaves no artifact feedback", async () => {
  const f = await artifactFixture(), root = mkdtempSync(join(tmpdir(), 'artifact-recovery-'));
  let restored: ReturnType<typeof openLedger> | undefined;
  try {
    const removed = await f.capture('Remove exact version'), survivor = await f.capture('Keep different version');
    await removed.feedback('Erased annotation marker');
    await survivor.feedback('Retained version feedback');
    const before = survivor.card().content;
    rebuildWorldLayer(f.db);
    expect(survivor.card().content).toEqual(before);
    await runPurge(f.db, f.ctx.vaultPath, { event_id: removed.event.event_id }, 'artifact-export-purge');
    exportVault(f.db, f.ctx.vaultPath, join(root, 'backup'));
    restoreVault(join(root, 'backup'), join(root, 'restored'));
    restored = openLedger(join(root, 'restored/.kizuki/kizuki.db'));
    expect(restored.query('SELECT 1 FROM events WHERE event_id=?').get(removed.event.event_id)).toBeNull();
    const reader = { ...f.ctx, db: restored, vaultPath: join(root, 'restored') };
    const matches = f.payload({ operation: 'find_artifacts' }, reader);
    if (!('matches' in matches))
      throw new Error('missing restored discovery');
    expect(matches.matches).toHaveLength(1);
    const card = f.payload({ operation: 'artifact_version', artifact: matches.matches[0]!.ref }, reader);
    expect(card).toMatchObject({ content: before });
    expect(JSON.stringify(card)).not.toContain('Erased annotation marker');
    expect(JSON.stringify(card)).toContain('Retained version feedback');
  }
  finally {
    restored?.close();
    f.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
test("grant revocation during metadata preparation leaves no partially admitted artifact", async () => {
  const f = await artifactFixture();
  try {
    const item = await f.capture('Race at metadata admission', 'public', undefined, false);
    const pending = admitArtifactMetadata(f.db, item.event.event_id);
    revokeSourceGrant(f.db, { source_key: item.sourceKey, expected_revision: 1, operation_id: 'artifact-admission-revoke' });
    await expect(pending).rejects.toThrow();
    expect(f.db.query<{
      n: number;
    }, [
    ]>('SELECT count(*) n FROM claim_v2_semantics').get()!.n).toBe(0);
  }
  finally {
    f.dispose();
  }
});
