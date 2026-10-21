# Scoped concept identity

Evidence date: 2026-10-21. This implementation adds owner identity assertions and bounded read projection. Cross-source autonomous convergence remains incomplete because the current admission contract cannot prove foreign endpoints; see the limitation below. It does not ratify RFC 0003 amendment 1 or introduce an identity-control table.

## Owner assertions

Obtain a Concept's `classificationClaims` token and a second Concept's object token from `world_view`. Call the existing `correct` tool with `target: {world_claim}`, `mode: "merge_identity"` or `"separate_identity"`, `object: {kind: "node", ref}`, and the owner's statement. CLI uses the same modes with `--world-claim` and `--object-ref`. An agent must already be authorized to relay owner corrections. A node token is not authority: both endpoints must remain readable for the correction purpose.

The writer records an ordinary positive or negative `concept.same_as` assertion backed by immutable native owner evidence. The original classification stays live. Identity takes effect only after the existing canon writer has produced its receipt. Undo reverts the assertion through the existing receipt path. If the source Concept has no canon page yet, its already admitted source claims receive an ordinary baseline receipt first; the subsequent identity receipt owns the identity change, so its undo preserves the classification. Both writes share the existing reservation, recovery and budget machinery. A failed identity write leaves the assertion inactive and retry resumes the same statement.

The three previous correction modes and legacy inputs retain their behavior. Identity modes require an unattributed, asserted, positive Concept classification and a distinct Concept endpoint. They do not replace arbitrary source text or make source instructions owner assertions. Ordinary correction clients without owner relay cannot invoke them.

## Scoped reads

Identity is computed from eligible claims under the current reader's grant, source consent, sensitivity and purpose. Cards retain the requested object ref as anchor and collect the component's labels and relations. Discovery returns one match per component. Raw references and stored source claims are never rewritten, and there is no global representative.

A receipted native owner merge joins a component. A negative `concept.same_as` or positive `concept.distinguished_from` blocks the disputed component; readers see separate ambiguous nodes. Weak model nominations remain ambiguous. Name equality, co-occurrence and similarity do not join nodes. Hidden intermediate nodes and denied supporting claims contribute neither visible output nor counted work. Full endpoint classifications, edge support and retained receipt ownership are dependencies rechecked before publication. Historical reads use only claims, support and receipts recorded by their cutoff, preserve today's authorization and holds, and refuse an earlier period when any traversed member's retained history coverage is incomplete.

Traversal is bounded at 256 members and 1,024 edges. Overflow yields singleton ambiguous results with partial coverage and `traversal_limit`; a proposed owner merge that would overflow is refused before recording evidence. Other existing card and byte limits continue to apply.

Revocation removes ineligible edges on the next read. Purging evidence removes its dependent admission, and derived rebuild does not reconstruct it. Export and restore retain ordinary claim, support and receipt provenance.

## Autonomous admission limitation

The read algorithm requires at least two independent witness roots for model-proposed identity. Existing copy and lineage checks prevent duplicated or derived records from adding roots. However, WorldAdmission/v1 requires every cited event and endpoint proof to belong to one source namespace. Independent sources cannot currently admit evidence for the same raw pair through the actual writer. `candidate_refs` are nominations, not endpoint authority. Therefore the autonomous two-source acceptance is not complete.

Completing it requires an explicitly versioned admission proof that separates witness evidence from endpoint grounding, checks model egress before sending grounding, and rechecks all dependencies at commit and serve. Grounding must never count as another witness. The existing v1 parser and source ownership rules remain unchanged by this owner/read slice.

## Verification

Run `packages/core/test/serving/world-identity.test.ts` for owner merge/separation, replay/undo, hidden intermediate noninterference, denied relay, purge/rebuild, first page materialization, budget failure/retry, restore and edge overflow. The real adapter calls are in `packages/cli/test/tell-modes.test.ts` and `packages/mcp/test/correct-modes.test.ts`. The parent integration runs the combined repository gate.
