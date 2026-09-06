# P053 independent Calendar fixture review

Verdict: **ACCEPT for the exact test-only candidate**, reviewed 6 September 2026. No blocking specification/security or implementation/regression finding. This is fixture coverage, not Google account, OAuth, native-package, integration, or release acceptance.

Head `bca137d398ada6bce612d668f4377f50dc29628c` has sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and tree `d2c444e670ddb51a7b39a0ae56038cffe12d37e0`. The private clone `PRIVATE_FLEET/code-repos/P053` is clean. The entire diff adds only the approved 288-line file `packages/connector-google-calendar/test/fleet-temporal.test.ts`. Its committed blob, current file, and sealed runner input all hash to `8be24e5af09829700ae465d44f41a712ca5ac2b08091e61d2a3c9f90b327d8de`. The exact base-to-head whitespace check passed.

## Specification and security

The nine tests use the existing `CalendarFixture` and actual connected/backfill seam. They exercise winter/summer offsets and local date-times with an IANA zone; all-day exclusive civil dates with a supplied zone; an unexpanded recurring series; moved and cancelled exceptions; cancellation without provider revision time; tentative status; attendance distinct from resource/owner identity; and exclusion of unselected attendee content.

Assertions preserve the package's existing revision semantics: live `occurred_at` is provider `updated`, schedules remain metadata, and cancellation without `updated` uses observation time with an explicit label. Recurrence remains unexpanded. Positive and negative attendee checks verify exact selected subjects/response values and the absence of an inferred organizer identity. The unselected-field case changes only synthetic fixture state and calls the public connector; no production projection or grant code is mocked or changed.

All rows, participant addresses, times, and state references are synthetic. `CalendarFixture` provides in-memory transport and persistence; the tests do not access an account, resolve a real secret file, contact a provider, invoke a browser, or touch an owner vault. Existing tests and production files remain untouched.

## Implementation, overlap, and limits

I read the complete new file and compared it with `test/connector.test.ts`, `test/bounds.test.ts`, `test/validation.test.ts`, native-recovery coverage, and `src/events.ts`/`src/testing.ts`. Existing coverage already proves ordinary all-day capture, cancellation anchors/replay, resource identity across edits, field projection, and refusal paths. The additions provide distinct temporal and attribution combinations: offset/zone retention, exclusive multi-day values with a zone, series versus exception metadata, tentative status, suppressed cancelled attendance, and unselected attendee subjects despite fixture rows carrying them. Basic event-schema and revision-time assertions support those cases rather than constitute separate new behavior.

The oracles are literal authored values or comparisons between fixture input and the exposed schedule, not a duplicate event-mapping algorithm. Small helpers only validate/project outputs. No parser bypass, regenerated golden, shared helper edit, disabled assertion, or exception suppression was introduced.

Coverage remains narrower than two test titles might imply: the moved-exception case proves a distinct series/instance ID and retained original/moved schedule, but it does not compare the same instance before and after a move or independently bind the complete source-ID encoding. It supplies no actual timezone conversion or provider recurrence-expansion proof; the connector deliberately retains the supplied schedule. These are limits on coverage credit, not a defect introduced by this additive fixture.

## Execution receipt

Root run `3ecfa298ca764b0b8df66f43c924bca8` used:

```text
bun test packages/connector-google-calendar/test/fleet-temporal.test.ts packages/connector-google-calendar/test
```

The complete retained log contains **54 pass, 0 fail, 447 assertions across eight files**, including the nine new cases once each. Bun 1.3.14 reports 26.04 seconds. The sealed runner reports exit 0, no termination reason, confirmed cleanup, and `stale: false`; both input digests equal `09033c18cec0901a41cb664aa5d00fff0e28361cd716faa16327e6bd9608ccca`. The pinned image is `sha256:aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef`, with offline execution and read-only source/dependencies.

Receipt: `PRIVATE_FLEET/test-controller/runs/3ecfa298ca764b0b8df66f43c924bca8/result.json`. Independently rehashed stdout: `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` (28 bytes). Stderr: `1f01483e4afb8145a0c088e0a50fe4fd086c2f43684a799e004f935c3bf27008` (5,230 bytes). Exact commit/current/frozen-file hashes agree.

This reviewer performed no execution or candidate edit. Typecheck, full repository verification, final packaged journeys, and external provider qualification remain separate. Existing native-named tests in the package log are synthetic checks; their inclusion does not establish a new native artifact or account result.
