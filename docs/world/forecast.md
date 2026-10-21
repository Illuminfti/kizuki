# Frozen forecasts

`world_view` operations `forecast` and `forecast_scores` read a durable forecast journal. The background World job creates and resolves records; reads never run a model, fit parameters, issue instructions, or create predictions. Predictions do not enter ordinary claims, canon pages, retrieval, or confidence scores.

The implementation uses the existing Forecast contract with an explicit `baseline` descriptor. RFC 0004 remains a proposal; this document describes the implemented compatible operation rather than changing the status of the RFC.

## The fixed baseline

`dependency-v1` is an **uncalibrated heuristic**, not a learned probability or a measure of confidence. The constants are deliberately simple and versioned:

- 0.25 when a supported prerequisite of the owning Situation has an exact deadline later than the target commitment's deadline.
- 0.5 otherwise, representing the unfitted baseline over the eligible frozen evidence.

A unique supported deadline is required. Missing or conflicting deadlines abstain. A date without a time means the end of that UTC date. The rule does not invent a local timezone. Attributed deadlines do not become objective deadlines; hypothetical deadlines create separately labelled `analysis` records, excluded from scoring.

Each prediction freezes its target, rule version, exact claims, supporting roots, ArtifactVersion binding when present, recorded-order position, and the time it was made. Later labels, observations, and summaries cannot rewrite its probability or inputs. A different eligible input set may produce a new record. Already established completion does not create a retrospective prediction.

## Questions and resolution

`commitment_met_by_due` asks whether the frozen target was completed by its frozen deadline. Timely independent success can establish success. A later inspection does not establish what was true at the deadline. A receipted native owner completion statement can establish the owner's completion time. A source statement, provider acknowledgement, or agent correction relay cannot substitute for the owner observation.

`next_independent_inspection_meets_criterion` freezes a specific report's task, attempt, criterion, artifact version, environment, assistance condition, and subject. The first eligible independent inspection resolves that target. A wrong version or negative inspection is not success; a confounded or inconclusive inspection is censored. Different producer names alone are insufficient: source and text roots must also be independent. No inspection leaves the record unresolved.

The first resolution is immutable. Its actual observation time and its host-recorded publication time are distinct. Exact admission positions share the existing recorded-order clock, so a later imported observation cannot change the first selection even if the host clock has the identical timestamp. Old Outcome rows without retained admission positions are not assigned invented positions and cannot resolve a forecast. A real revival or source-purpose renewal establishes a fresh eligibility position; it cannot retroactively enter an earlier resolution. Native owner proof must also have been live with its retained receipt at that cutoff.

## Permissions and erasure

Reads check current source consent, event classes, subject scope, claims, holds, receipts, and all frozen supports before the result window. A later resolution that the reader cannot access leaves the input-backed prediction unresolved. Its addition, revocation, or purge does not change that reader's answer or measured read work.

Losing a prediction input deletes the prediction. Losing resolution-only evidence erases its claim, source, event and time proof and leaves a private terminal invalidation marker. The public prediction becomes unresolved; a later observation cannot replace the erased first resolution. No global sequence or storage identifier is exposed.

The authority journal survives rebuild and is exported and restored. Restore validates frozen input positions, the fixed rule, and the complete first-resolution selection at its retained admission cutoff. It refuses fabricated or substituted resolution results. Journal writes, admission positions, and the shared clock roll back together.

## Reading and interpreting scores

For example:

```text
kizuki world --operation forecast --ref COMMITMENT_OBJECT_TOKEN
kizuki world --operation forecast_scores
```

Both operations accept `--known-at RFC3339` for the journal's recorded-time projection. Snapshot capabilities and valid-time selectors are unavailable for this journal. Current authorization still governs historical answers.

The score operation requires at least 20 authorized resolved predictions. This is a fixed reporting gate, **not evidence of statistical sufficiency or calibration**. Analysis records are excluded. Brier score, unresolved and censored counts, computation cost, and task usefulness remain separate. Unmetered retries, maintenance and CPU time are explicitly unknown; zero observed accounting is not a cost claim. Decision usefulness remains unavailable without independent decision-utility evidence.

The public record window is bounded to 128 authorized records. Coverage reports any truncation. The background job advances bounded discovery and resolution cursors, commits each item atomically, and yields between items; one unresolved record does not hold up later commitments.

## Verification

The focused proof uses actual capture, proposal, native correction and undo, background jobs, Core serving, CLI, MCP, HTTP and App consumers. It covers the fixed rule, independent wrong-version failure, target timing, first-resolution immutability, same-clock later imports, current permissions, revocation, purge, rollback, rebuild and export/restore. Acceptance evidence is tied to the exact implementation commit; a schema checkpoint alone does not establish production readiness.
