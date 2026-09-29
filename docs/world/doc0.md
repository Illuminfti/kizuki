# World-model documents: amendments and domain contracts

This note says what the amendment record and the domain contracts appendix are, where they live and how to check them. Both are Proposed. Neither ships a surface, adds a migration or changes a decision row.

## What exists

- The [amendment record](../../rfcs/0004-living-epistemic-world-model.md#amendments) at the end of RFC 0004 lists twelve proposed deviations. Each names the text it changes, the new rule, the reason and the proposed decision row.
- [Appendix B](../../rfcs/0004-domain-contracts.md) defines the closed codec sketches, predicates, vocabulary values, gap use and honest fallbacks for questions, people, skills, frameworks, procedures, commitments, decisions, Situation v2, artifact versions, outcomes, World Slice, World Diff, attention, forecasts, Atlas views and the resume handle. Each contract names the fixtures that oracle it.
- The [shipped subset and migration allocation](../../rfcs/0004-world-storage.md#shipped-subset-and-migration-allocation-for-the-world-model-expansion) section of the storage appendix says what of that appendix is built, marks the rest deferred and lists the expected migration order from 34.
- [Proposed decision rows](decisions-proposed.md) are drafts for the owner. An agent never edits the decision log.

## How to use them

A workstream that implements a kind or an operation cites its contract in Appendix B and states each deviation. A deviation needs a new amendment, not a private variation. Feature work adds its own `docs/world` file and its fixtures; it does not edit the RFC set.

## Checks

```bash
bun test packages/core/test/docs
bun test rfcs/fixtures/world-allocation-compatibility.test.ts
```

The first command checks that every amendment has its four labelled parts and a draft decision row, that every relative link and anchor resolves, and that every schema id, predicate and fixture id named in the amendments and Appendix B exists in the RFC set, the legacy predicate registry or the fixtures directory. The second checks the shipped subset against the live migration chain and fails if a deferred storage item appears in the code.

These checks read documents. They prove that the documents agree with each other and with the code they describe. They do not prove that any contract is implemented.
