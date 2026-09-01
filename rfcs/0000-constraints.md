# RFC 0000 — deep-model design constraints

Status: BINDING. Constraint set for the evidence-to-world-model design stream
(event envelopes, normalized activities, typed entity/identity candidates,
atomic claims, semantic reduction, review packets, transactional promotion,
provenance, purge/revocation, migration, derived insights). Designs arrive as
numbered RFCs in this directory and bind only when merged.

1. **Ingress is frozen.** Consume `kizuki.event/v1` exactly as specified in
   docs/architecture.md. The deep model lives between the ledger and the
   review surface; it may not alter the connector-facing contract.
2. **Egress is the proposal.** Output must be `kizuki.proposal/v1`-compatible
   review packets. No new canon write paths. The owner-invoked promote with
   receipts is the only door to canon.
3. **SQLite-fit.** All durable state must run on a single embedded SQLite
   database per vault. No server databases, no external services.
4. **Deterministic floor preserved.** Every pipeline stage must either run
   without an LLM or be skippable with graceful degradation to the
   deterministic path.
5. **Subjects are first-class.** Events carry subject refs from day one;
   identity resolution must key purge and sensitivity per subject and must be
   reversible (candidate links, owner-confirmable, never silently merged).
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
