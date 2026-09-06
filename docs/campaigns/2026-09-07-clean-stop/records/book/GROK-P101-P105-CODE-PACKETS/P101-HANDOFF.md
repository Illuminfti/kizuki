# P101 worker handoff: qualification equality and diagnostics

Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. This task changes exactly `scripts/qualification.ts` and `scripts/qualification.test.ts`.

## Defect and required behavior

`statusQualification` and `sampleQualification` compare freshly derived identity to validated manifest identity with `JSON.stringify`. `collect` compares rail policy the same way. Those comparisons observe insertion order even though the accepted manifest key set and its canonical genesis digest are order-insensitive. A same-value manifest can therefore be rejected or marked changed solely because keys were serialized in another order.

Replace only those semantic comparisons with the file's existing canonical representation or explicit field comparison. Preserve exact schema checks, genesis inode and digest checks, proof validation, package byte hashes, and changed-value rejection. Add a same-values/different-key-order fixture for identity and rail policy, then prove one changed field still refuses or interrupts as before.

The executable's top-level catch prints arbitrary `Error.message`. JSON parser, filesystem and SQLite errors can contain source snippets or caller paths. Map those classes to fixed content-free diagnostics before stderr. Keep useful closed messages for trusted qualification and `ArtifactProofError` outcomes only when their vocabulary is already bounded. Failure remains exit 1 with empty stdout. Use neutral sentinels and assert neither source text nor path text reaches stderr.

## Validation and boundaries

Run `bun test scripts/qualification.test.ts` with Bun 1.3.14, then applicable repository checks. Preserve existing privacy projections and every pre-existing assertion. Report final SHA/tree, exact commands and results in `/work/out/result.json`.

Do not touch P004 release-evidence files, artifact proof implementation, core qualification, docs/help, source-survivor work, doctor, accounts, native proof, controller, or release state. This correction does not qualify an artifact or elapsed window.
