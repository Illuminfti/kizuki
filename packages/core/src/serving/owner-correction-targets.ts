import { OWNER } from '../agents';
import { getClaim } from '../claims/store';
import { sourcePolicyEpoch, sourceSensitivity } from '../ledger/source-grants';
import { getClaimsEpoch } from '../correction';
import { claimReader } from './claims';
import { serveGetPage } from './page';
import type { ServeContext } from './types';
import { latestReceiptForPage } from '../canon/receipts';
import { isWorldCanonReceipt } from '../canon/world-receipt';
import { assertWorldReceiptBasis, worldBasisAllowed, worldCanonPath, worldClaimHandle } from '../canon/world-materialization';
import { eligibleWorldClaim } from '../world/projection';
import { issueWorldRef, worldNamespace, type WireRef } from '../world/references';

const MAX_TARGETS = 200;
type Belief = { subject: string | null; predicate: string | null; object: string | null; body: string; authority: string; sensitivity: string };
type OwnerCorrectionClaim = Belief & ({ claim_id: string } | {
    kind: 'world'; target: { world_claim: WireRef<'claim'> } | null; unsupported_reason: 'unsupported_assertion' | null;
});
type OwnerCorrectionTargets = { claims: OwnerCorrectionClaim[]; truncated: boolean };

/** Composition helper for the authenticated owner app, not an agent tool. */
export function inspectOwnerPageCorrectionTargets(ctx: Pick<ServeContext, 'db' | 'vaultPath'>, pageId: string): OwnerCorrectionTargets {
    const epoch = sourcePolicyEpoch(ctx.db), claimsEpoch = getClaimsEpoch(ctx.db);
    const owner: ServeContext = { ...ctx, principal: OWNER, sourcePurpose: 'correction' };
    const page = serveGetPage(owner, { id: pageId }).canon[0];
    if (!page) return { claims: [], truncated: false };
    const receipt = latestReceiptForPage(ctx.db, page.path);
    if (receipt !== null && isWorldCanonReceipt(receipt)) {
        try { assertWorldReceiptBasis(ctx.db, receipt, { historical: true }); }
        catch { return { claims: [], truncated: false }; }
        if (!worldBasisAllowed(owner, receipt.basis.after)) return { claims: [], truncated: false };
        // Opaque references are issued in the existing authorization namespace,
        // from the exact current page basis, never inferred from displayed prose.
        return ctx.db.transaction((): OwnerCorrectionTargets => {
            if (latestReceiptForPage(ctx.db, page.path)?.receipt_id !== receipt.receipt_id) return { claims: [], truncated: false };
            const claims: OwnerCorrectionClaim[] = [], basis = receipt.basis.after ?? [], budget = { bytes: 0 };
            const namespace = worldNamespace(ctx.db, OWNER);
            for (const item of basis.slice(0, MAX_TARGETS)) {
                const eligible = eligibleWorldClaim(owner, item.claim_id, { kind: 'all' }, budget,
                    { supportKeys: item.supports.map(support => support.support_key) });
                const support = eligible?.supports.find(support => support.row.support_key === item.supports[0]?.support_key);
                if (!eligible || !support) return { claims: [], truncated: false };
                const semantic = eligible.semantic;
                // This is presentation of the writer's current grammar, not
                // admission. Preview and write recheck it inside serveCorrect.
                const supported = semantic.object.kind === 'literal' && semantic.subject.kind === 'supplied' &&
                    'namespace' in semantic.subject && semantic.context.length === 0 && semantic.polarity === 'positive' &&
                    semantic.perspective.holder === null && semantic.perspective.speaker === null && semantic.perspective.addressee === null &&
                    semantic.perspective.mode === 'asserted' && semantic.perspective.interpretation === 'explicit';
                claims.push({ kind: 'world', target: supported ? { world_claim: issueWorldRef(ctx.db, namespace, 'claim', item.claim_id) } : null,
                    unsupported_reason: supported ? null : 'unsupported_assertion', subject: null, predicate: semantic.predicate,
                    object: semantic.object.kind === 'literal' ? String(semantic.object.value) : null,
                    body: support.admission.rendering.body, authority: support.admission.authority,
                    sensitivity: sourceSensitivity(ctx.db, support.events.map(event => event.event_id), getClaim(ctx.db, item.claim_id)!.sensitivity) });
            }
            if (sourcePolicyEpoch(ctx.db) !== epoch || getClaimsEpoch(ctx.db) !== claimsEpoch) return { claims: [], truncated: false };
            return { claims, truncated: basis.length > MAX_TARGETS };
        }).immediate();
    }
    // A claim must belong to the admitted page's actual writer history. Never
    // infer a claim identity from the browser's text or a caller-supplied path.
    const candidates = ctx.db.query<{ claim_id: string }, [string, number]>(`
        SELECT c.claim_id FROM claims c JOIN canon_receipts r ON r.receipt_id = c.receipt_id
        WHERE r.page_path = ? AND c.status = 'live' AND c.claim_key IS NOT NULL
        ORDER BY c.claim_id LIMIT ?
    `).all(page.path, MAX_TARGETS + 1);
    const reader = claimReader(ctx.db, OWNER.grant, { owner: true, purpose: 'correction' });
    const claims = candidates.slice(0, MAX_TARGETS).flatMap(row => {
        const claim = getClaim(ctx.db, row.claim_id);
        if (!claim || !reader.canRead(claim)) return [];
        return [{ claim_id: claim.claim_id, subject: claim.subject, predicate: claim.predicate,
            object: claim.object, body: claim.body, authority: claim.authority, sensitivity: claim.sensitivity }];
    });
    if (sourcePolicyEpoch(ctx.db) !== epoch || getClaimsEpoch(ctx.db) !== claimsEpoch) return { claims: [], truncated: false };
    return { claims, truncated: candidates.length > MAX_TARGETS };
}

/** Current admitted page bindings are a preview scope, never a write promise. */
export function inspectOwnerCorrectionPageCount(ctx: Pick<ServeContext, 'db' | 'vaultPath'>, claimIds: readonly string[]): number | null {
    if (claimIds.length === 0 || claimIds.length > MAX_TARGETS) return null;
    const epoch = sourcePolicyEpoch(ctx.db), claimsEpoch = getClaimsEpoch(ctx.db);
    const reader = claimReader(ctx.db, OWNER.grant, { owner: true, purpose: 'correction' });
    const paths = new Set<string>();
    for (const id of claimIds) {
        const claim = getClaim(ctx.db, id);
        if (!claim || !reader.canRead(claim)) return null;
        const handle = worldClaimHandle(ctx.db, id);
        if (handle !== null) {
            const path = worldCanonPath(handle), receipt = latestReceiptForPage(ctx.db, path);
            if (receipt === null || !isWorldCanonReceipt(receipt) || !receipt.basis.after?.some(item => item.claim_id === id) ||
                !worldBasisAllowed({ ...ctx, principal: OWNER, sourcePurpose: 'correction' }, receipt.basis.after)) return null;
            paths.add(path);
            if (paths.size > 25) return null;
            continue;
        }
        if (claim.claim_key === null) return null;
        const rows = ctx.db.query<{ rel_path: string }, [string]>(`
            SELECT DISTINCT p.rel_path FROM claim_bindings b JOIN page_index p ON p.page_id=b.page_id
            WHERE b.claim_key=? ORDER BY p.rel_path LIMIT 26
        `).all(claim.claim_key);
        for (const row of rows) paths.add(row.rel_path);
        if (paths.size > 25) return null;
    }
    let admitted = 0;
    for (const path of paths) if (serveGetPage({ ...ctx, principal: OWNER, sourcePurpose: 'correction' }, { path }).canon.length > 0) admitted++;
    if (sourcePolicyEpoch(ctx.db) !== epoch || getClaimsEpoch(ctx.db) !== claimsEpoch) return null;
    return admitted;
}
