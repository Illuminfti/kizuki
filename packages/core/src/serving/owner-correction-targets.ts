import { OWNER } from '../agents';
import { getClaim } from '../claims/store';
import { sourcePolicyEpoch } from '../ledger/source-grants';
import { getClaimsEpoch } from '../correction';
import { claimReader } from './claims';
import { serveGetPage } from './page';
import type { ServeContext } from './types';

const MAX_TARGETS = 200;

/** Composition helper for the authenticated owner app, not an agent tool. */
export function inspectOwnerPageCorrectionTargets(ctx: Pick<ServeContext, 'db' | 'vaultPath'>, pageId: string) {
    const epoch = sourcePolicyEpoch(ctx.db), claimsEpoch = getClaimsEpoch(ctx.db);
    const page = serveGetPage({ ...ctx, principal: OWNER, sourcePurpose: 'correction' }, { id: pageId }).canon[0];
    if (!page) return { claims: [], truncated: false };
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
        if (!claim || !reader.canRead(claim) || claim.claim_key === null) return null;
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
