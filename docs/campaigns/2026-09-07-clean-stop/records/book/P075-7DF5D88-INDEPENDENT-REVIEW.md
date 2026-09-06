# P075 independent ICS fixture review

Verdict: **ACCEPT for the exact test-only candidate**, reviewed 6 September 2026. No blocking specification/security or implementation/regression finding. This accepts the stated synthetic calendar coverage; it is not native-package, account, complete standards-conformance, integration, or release acceptance.

Head `7df5d889b52360df879b52a63ef53205aacb1701` has sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and tree `ee58bf07a4a80c9a916ef2d2041707f8ec87fe56`. The private clone `PRIVATE_FLEET/code-repos/P075` is clean. The complete diff adds only the approved 503-line `packages/connector-ics/test/fleet-calendar-fidelity.test.ts`. Its committed blob, current file, and sealed input share SHA-256 `3c58b47f652a0716026bc4f52e56f3cb6feea3f96997b73e65ce53859e7d243e`. The exact base-to-head whitespace check passed.

## Specification and security

Seven cases exercise exported parse/map functions and the actual file-mode connector. The authored calendars and literal expected events cover zoned, date-only and floating starts; observation-clock independence; a weekly series crossing DST with EXDATE and a moved override; cancelled series/instances; date-only recurrence identities; and exact source-identity tombstones after explicit cancellation at the connector seam.

The weekly oracle fixes each original slot's source ID independently of the moved start and expects the correct different UTC offsets around the chosen transition. It checks that EXDATE removes only its occurrence and that moving an occurrence does not create an ID from its new wall-clock start. The date-only series uses date suffixes and explicitly excludes a fabricated midnight time suffix. Cancellation comparisons name exactly the prior source record and require siblings to produce no extra output.

The fixtures preserve this package's documented semantics: scheduled instants are `occurred_at`, ingestion has its own observation time, all-day values remain labelled, and floating values use the documented UTC approximation with `tz.approximation: floating`. The latter is honest characterization of an approximation, not evidence of an actual timezone for a floating meeting. Explicit cancellation becomes an observation-time tombstone through the existing connector path.

All UIDs, text, and dates are synthetic. Two connector cases write only a generated `mkdtempSync` directory and its `fleet.ics` file. Each directory is registered immediately for `afterEach` cleanup; there is no arbitrary path deletion, real calendar, URL request, account, secret, subprocess, or native artifact operation. No production or existing test file changes.

## Implementation, overlap, and limits

I read the complete new file and compared it with `events.test.ts`, `datetime.test.ts`, `rrule.test.ts`, `connector.test.ts`, the package README, and the mapper/connector implementation. Existing suites already cover ordinary zoned/all-day values, DST conversion, EXDATE, overrides, cancelled mapper entries, removed-record tombstones, and unchanged sync. The added value is their composition with exact records: a zoned recurrent series crossing DST and retaining a moved slot ID; all-day EXDATE identities; changing only the observation clock; explicit STATUS:CANCELLED through file sync; and cancellation of one recurrence instance without re-emitting or deleting siblings.

The expected records, source IDs, time conversions, and tombstones are literal authored values. No production time, recurrence, UID, or mapper helper is used to calculate an expected record. The small calendar builders only frame input text; the schedule helper projects actual fields. Fixed clocks keep all finite-count series inside the mapper's window. Complete output equality supplies both positive and absence assertions. The guarded tombstone access follows a required `toBeDefined` assertion and cannot silently pass an absent event.

The explicit fixtures overlap ordinary assertions from the prior suites but provide new combinations and connector-level checks. No wholly redundant new case or assertion-suppression path was identified. This does not add support for unsupported recurrence rules, unresolved zones, live calendar transport, or arbitrary ICS syntax.

## Execution receipt

Root run `d07e5375a5704c0d865e44bab42490b4` used:

```text
bun test packages/connector-ics/test/fleet-calendar-fidelity.test.ts packages/connector-ics/test/events.test.ts packages/connector-ics/test/datetime.test.ts packages/connector-ics/test/rrule.test.ts packages/connector-ics/test/connector.test.ts packages/connector-ics/test/parse.test.ts packages/connector-ics/test/fetch.test.ts
```

The complete retained log shows **175 pass, 0 fail, 1,454 assertions across seven files**, including all seven new cases. Bun 1.3.14 reports 2.94 seconds. The sealed runner reports exit 0, no termination reason, confirmed cleanup, and `stale: false`; both input digests equal `6ea6e78a3383f01cd8d121a017e9654779906147e3a1948834f9333b236a62ae`. The fixed offline image is `sha256:aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef`; source/dependencies were read-only.

Receipt: `PRIVATE_FLEET/test-controller/runs/d07e5375a5704c0d865e44bab42490b4/result.json`. Independently rehashed stdout: `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` (28 bytes). Stderr: `6c2863bca4f6d585f7f0452cbc757d1401b4241e4a55d7e6d667c684d79087ff` (16,175 bytes). Exact commit/current/frozen-file bindings match.

This reviewer executed no tests and altered no candidate. Typecheck, full repository verification, final compiled-package journeys, actual calendar acquisition, and release acceptance remain separate evidence requirements.
