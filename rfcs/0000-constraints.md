# RFC 0000 — deep-model design constraints

Status: BINDING. Constraint set for the evidence-to-world-model design stream
(event envelopes, normalized activities, typed entity/identity candidates,
atomic claims, semantic reduction, review packets, transactional promotion,
provenance, purge/revocation, migration, derived insights). Designs arrive as
numbered RFCs in this directory and bind only when merged.

1. **Ingress is frozen.** Consume `kizuki.event/v1` exactly as specified in
   docs/architecture.md. The deep model lives between the ledger and the
   review surface; it may not alter the connector-facing contract.
2. **Egress is the receipted write.** Output is `kizuki.claim/v1` records
   and canon writes performed by the single receipted writer in
   `packages/core/src/canon/`. No other module may write a canon byte.
   Every write carries provenance, confidence, sensitivity, a writer stamp
   and before/after hashes, and is reversible by receipt id.
3. **SQLite-fit for authoritative state.** Events, claims, receipts,
   schedules, leases, grants and audit run on a single embedded SQLite
   database per vault; canon is Markdown on disk. Derived retrieval is a
   port and its implementation may own a separate embedded store inside the
   vault, provided it is rebuildable from ledger + canon with one command,
   supports verified deletion, and requires no server process the owner did
   not install. No hosted service, ever.
4. **Deterministic floor preserved for everything except canon writing.**
   Capture, dedup, ledger reads, lexical search, timeline, context packets,
   audit and undo must run with no model configured. Canon writing requires
   a configured model; when none is configured the loop performs every
   other stage and `doctor` reports canon writing as off. A stage that
   needs a model must return a tri-state result in which "unavailable" is
   distinct from "nothing found", and unavailable must never advance a
   checkpoint.
5. **Subjects are first-class.** Events carry subject refs from day one;
   identity resolution must key purge and sensitivity per subject and must be
   reversible (candidate links; merged autonomously only above the configured
   threshold with independent corroboration; every merge receipted and
   reversible; purge keyed on raw subject refs, never on merged identity).
6. **Provenance is total.** Every derived artifact carries the event_ids it
   came from; purge cascades must be computable from provenance alone.
7. **Append-only.** No in-place mutation of ledger rows or promoted claims;
   supersession is a new record with validity intervals (bi-temporal design
   welcome within SQLite constraints).
8. **Local-first, zero phone-home.** No stage may require a network call
   beyond the user-configured model endpoint.
9. **Language/runtime.** TypeScript on Bun, strict mode; zero-dependency lean
   core (heavy libs only behind optional packages).
10. **Reviewability.** RFCs are ordinary Markdown files in small PRs with
    concrete schemas and worked examples; no design binds until merged.
11. **Ports, not engines.** Every replaceable component is reached through
    a versioned contract in `packages/core/src/contracts` with a registry,
    a shared conformance suite and config selection. A lane spec implements
    against a port; naming a concrete engine in core is a defect.
