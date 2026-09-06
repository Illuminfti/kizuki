# Grok fleet receipt status

2026-09-06T22:10:04.564261+00:00

Execution completion is not independent acceptance. Running is reported by controller receipts.

| Scope | Admitted | Running | Completed | Rejected | Failed | Stop unresolved | Starting | Invalid | Not started |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All member attempts | 206 | 7 | 109 | 1 | 11 | 79 | 0 | 1 | 0 |
| Latest per packet | 116 | 7 | 109 | 0 | 0 | 0 | 0 | 0 | 0 |
| P latest | 16 | 6 | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| R latest | 100 | 1 | 99 | 0 | 0 | 0 | 0 | 0 | 0 |

## Downstream queue

- P003 → P004: Review and freeze the release receipt contract, then assign the validator owner. Artifact available; independent review and owner decision remain required.
- P095 → P006: Review current capability contradictions; one canonical docs owner may make truthful corrections. Artifact available; independent review and owner decision remain required.
- P050 → P051, P054: Review one shared Google OAuth contract; keep Calendar-specific work separate. Artifact available; independent review and owner decision remain required.
- P047 → P048: Review Telegram source/native prerequisites and assign a bounded connector correction. Artifact available; independent review and owner decision remain required.
- P056 → P057: Review IMAP protocol/MIME oracle and supported authentication limits before fixes. Artifact available; independent review and owner decision remain required.
- P062 → P063: Review X API enrollment/acceptance-ID gaps; root retains shared wiring and account/funding authority. Artifact available; independent review and owner decision remain required.
- P065 → P066: Review the archive fixture pack; retain separate final-package qualification. Artifact available; independent review and owner decision remain required.
- P059 → P060: Resolve WHOOP client-custody and supported-enrollment decisions before implementation. Artifact available; independent review and owner decision remain required.
- P034 → P035, P036: Review independent semantic goldens with the existing Astra rich-subject owner. Artifact available; independent review and owner decision remain required.
- P044 → P041, P043: Route reviewed app behavior gaps to the existing app/browser owner. Artifact available; independent review and owner decision remain required.

## Limits and anomalies

- Counts report controller-receipt states; this reader does not inspect processes or certify liveness.
- stop_failed is an unresolved stop operation: actual worker liveness is unknown, not counted as running or failed execution.
- Completed means execution ended with a result; all worker assertions and artifacts remain unreviewed here.
- Acceptance is not evaluated; there is deliberately no accepted-task count.
- Retries are shown individually; latest-per-packet is selected by receipt started_at, with duplicate running attempts flagged.
- Reads are limited to selected roster JSON, worker controller-receipt.json and bounded workspace/out artifacts.
- No auth/state, inspect/stdout/stderr logs, controller import, account calls, launches or source edits.
- Output hashes describe the observed bounded files; limits, nonregular entries and concurrent writes are explicit.
- Unknown worker directories: 3
- Duplicate running packet IDs: 0
- Attempts with recorded issues: 4
