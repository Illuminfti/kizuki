# Hostile input fuzzing

This is an offline regression and mutation harness, not a proof that every
possible input is safe. `corpus.json` contains synthetic hostile byte strings
and compact specifications for large inputs. `cases.ts` adds deterministic
mutations from an unsigned 32-bit seed. Workers never print input, exception
messages, causes, tokens, or scratch paths. Receipts identify target, seed,
last case, completed cases, maximum RSS, elapsed time, and the failed property.

From the repository root on Linux, using the pinned Bun version and the shared
build host's test semaphore:

```sh
ktest bun test scripts/fuzz --timeout 120000
ktest bun scripts/fuzz/run.ts --seed 5369869
ktest bun scripts/fuzz/run.ts --long --seed 5369869
ktest bun scripts/fuzz/run.ts --long --target imap-mime --seed 5369869 --cases 10000
```

The first command is included in ordinary Bun test discovery and therefore
in the existing CI verify job (which runs Bun directly). On a private local
machine without `ktest`, omit that prefix. Its budget is the fixed corpus plus eight
seeded cases per target, a 20-second deadline per worker (90 seconds for
the `http`, `mcp` and `app-http` surfaces, which dispatch real tools against a
real vault for every case), a 512 MiB RSS ceiling, and a 480-second test
deadline. The deadlines bound hangs on a loaded runner; receipts record
`elapsedMs` so headroom can be read. Resource-supervised tests are skipped
on other platforms; the standalone command refuses unsupported RSS accounting.
The standalone command uses the same
budget. Long mode adds 2,000 seeded cases per target and gives each worker
five minutes; `--cases` overrides the generated count (0–100,000). Targets that
open real state, such as `app-http`, cost far more per case than a parser, so
lower `--cases` when a long run reaches the five-minute deadline. `--target`
selects one target, and the same seed and count replay the complete sequence.
The first failing target stops the campaign. There is no automatic shrinking;
reduce the failing synthetic case into a public-seam regression before fixing
it, then retain it in the corpus.

Standing HTTP sends each raw byte case through the shared body reader once,
then mutates fields through all ten tool routes. MCP sends raw argument
containers and wrapped fields through each tool's distinct SDK schema.
An inert-grant witness uses a short schema-valid envelope for each tool;
mutation campaigns then exercise owner dispatch without repeating that fixed
authorization check for every byte string.

App HTTP opens a real vault through the app's own `initialize` route, enrolls
a synthetic Markdown folder and seeds two live claims. `KIZUKI_SUPERVISOR=none`
and an explicit supervisor of that kind keep every service route away from a
real service manager. Each case sends its raw bytes to every route (and to one
route, or every route for the object case, without the bearer token, which must
be refused before the body is read), then puts the hostile text, or another JSON type (null, an array, an object, a number, a
boolean or a dropped key), into six fields in round-robin order. Each field
belongs to a route-specific valid envelope, so the field's own parser runs:
enrollment fields, consent policy, model selection and credential action,
agent grant, correction target, statement and object, and the world-view
window and references. The CI budget reaches every field. No mutated envelope
revokes the enrolled source, applies a correction, selects a model endpoint
that could be valid or varies a folder path. `correct` parses exactly as
`correction_preview` does but enters a canon mutation scope that costs far more
per request, so its fields are varied through the preview and its witness
applies the second live claim.

The short object case proves the parsers are reached. Each control envelope is
accepted (a valid grant enrolls an agent, a valid policy consents, a valid
correction previews and applies against live claims) and its broken copies are refused
with the code only the nested parser gives (`invalid_grant`,
`credential_invalid`, `configuration_invalid`, `invalid_request`). An envelope
that lacks a prerequisite stops at the first parser and proves nothing.

Answers are classified rather than merely bounded. The oracle accepts
`invalid_request` and the few named per-route refusals a healthy synthetic
vault can give, and fails everything else, including `unavailable`, `no_vault`
and custody or storage codes. An accepted operation is polled to its recorded
outcome and classified the same way; a job that vanishes or never finishes
fails.

The supervisor runs one child at a time, samples Linux `VmHWM` every 25 ms,
checks the worker's final maximum-RSS accounting, bounds protocol lines to
4 KiB, kills a child that exceeds its time, memory, or output budget, and
waits for its exit. Scratch trees are created beneath `TMPDIR` and removed
after exit, including killed workers. The supervisor tests exercise a
synchronous hang, an allocation flood, output overflow and a premature zero
exit without a completion receipt. Missing receipts fail closed. RSS sampling is a watchdog, not a
kernel allocation quota: a short allocation spike can temporarily overshoot
before the next sample, and the OS can still kill a process. A resource kill
is a failure, never a parser refusal. Use a private `TMPDIR` with trusted
ancestors when vault custody rejects a shared scratch hierarchy.

Both samples and final receipts use Linux `VmHWM` for the current executable's
address space. [`getrusage` statistics survive `exec`](https://man7.org/linux/man-pages/man2/getrusage.2.html), so Bun's
`process.resourceUsage().maxRSS` can retain the larger parent's peak and
incorrectly fail a small worker in the full CI test process. A regression
holds a larger allocation in the parent while supervising a small child;
the allocation-flood regression still checks a real worker budget breach.

## Coverage and properties

| Targets | Seam exercised | Properties |
| --- | --- | --- |
| `canon-frontmatter`, `wiki-frontmatter` | Markdown frontmatter readers | Determinism, bounded output, malformed-input refusal, prototype isolation |
| `chatgpt`, `claude`, `pocket`, `whatsapp`, `omnivore`, `beacon` | Export parsers, raw grammar and wrapped text | Determinism; normalized ChatGPT, Claude and Beacon events pass frozen ingress |
| `receipt`, `render-output` | Local adapter admission, raw JSON and wrapped instruction/note fields | Bounded refusal with synthetic consent, nonempty projection witnesses, ingress validity; no reference fetch |
| `ics`, `ics-rrule`, `ics-files`, `ics-feed` | Calendar grammar, event mapping, recurrence rule parser, file backfill and synthetic streamed feed | Nesting and recurrence refusal, symlink and UTF-8 refusal, sparse oversized files, bounded output; mapped events pass ingress |
| `imap-mime`, `imap-response` | MIME event mapping and response tokenizer | Invalid octets, multipart prefix ambiguity, depth and part limits, ingress validity |
| `telegram` | Typed provider message projection | Private sensitivity preserved; host ingress admission checked separately |
| `screenpipe-frame`, `screenpipe-audio`, `whoop`, `beeper` | Provider projections and a streamed synthetic Beeper response | Malformed timestamps/schema, selected metric bags, private sensitivity, mapped ingress bounds; split and empty chunks and an open oversized body whose cancellation never settles |
| `x-ytd`, `x-api`, `gmail`, `google-calendar` | Archive wrapper and provider response projections | Determinism, malformed schema refusal, bounded output |
| `session-claude`, `session-codex` | Session JSONL record interpretation | Harness-text exclusion, sanitized evidence, ingress validity |
| `markdown-files`, `wiki-files` | Folder backfill and wiki scanning | Cyclic/file symlinks excluded, malformed UTF-8 refusal, sparse oversized pages, compressed cursor expansion ceiling |
| `session-files-claude`, `session-files-codex`, `legacy-jsonl`, `legacy-sqlite` | File readers, resumable JSONL paging and corrupt read-only SQLite exports | Oversized input, malformed bytes, bounded batches, forward progress past hostile rows |
| `x-archive` | Archive directory scan | Malformed account/tweet data, file symlink refusal, sparse oversized account part and ZIP refusal |
| `chatgpt-files`, `claude-files`, `beacon-files`, `pocket-files`, `omnivore-files`, `whatsapp-files` | Export backfill including highlights and media references | Raw and wrapped file admission, sparse oversized exports, primary/optional symlink exclusion, valid ingress and nonempty projection witnesses |
| `http`, `mcp` | Loopback HTTP and SDK client over in-memory JSON-RPC plus raw stdio framing | Every one of the ten tools; raw containers plus tool-specific field mutations, MCP dispatch witnesses and bounded replies; inert grant refusal, captured instruction text stays in `quoted` |
| `app-http` | All app protocol routes over loopback HTTP through the real app host and a real initialized vault | Bad bearer refusal before dispatch, raw bodies plus route-specific field mutations, nested-parser witnesses, classified answers and completed operation outcomes, bounded output, prototype isolation; no real service manager is reached |

No export importer in this matrix decompresses a ZIP file. X refuses ZIP
input; the supported compressed Markdown cursor is tested with expansion
past its configured limit. Filesystem fixtures never point outside the
worker's own scratch tree. Real provider accounts, credentials, models,
owner vaults, and public network endpoints are not used. The worker refuses
fetches outside its synthetic loopback HTTP server.

Some pure parsers receive already decoded strings or typed provider records;
their file readers and host ingress are separate boundaries. MIME and session
readers can deliberately replacement-decode malformed octets into evidence.
A decoded replacement character is not itself a crash or authorization
failure. The Telegram mapper can return an event that host ingress refuses;
the harness does not mistake a mapper for an authorization or ingestion API.
The matrix does not cover every credential/state decoder,
provider SDK transport, filesystem replacement race, or arbitrary stream
timing. Existing package conformance and boundary tests remain required.

## Findings and open work

The new HTTP public-seam regressions cover non-object JSON silently becoming
an empty call, malformed UTF-8 being accepted, and bodies larger than the
small serving budget reaching dispatch. The standing and app HTTP endpoints
now share a five-second byte reader with fixed storage even for empty
or tiny chunk floods. Standing HTTP caps bodies at 1 MiB to accommodate the
advertised proposal character limits even with escaped Unicode; app HTTP
retains its 128 KiB limit. Standing HTTP also requires an
object argument container and caps JSON depth at 64. Authentication and route
checks still precede body reads. Errors remain generic and carry no input.
An authenticated regression stores a maximal Unicode proposal as quoted
evidence and deduplicates the same body when sent using JSON Unicode escapes.

The pinned MCP SDK already caps its stdio read buffer. An absent-buffer-bound
claim did not reproduce, so this branch does not replace the SDK transport.
The mutation target exercises MCP arguments over real JSON-RPC rather than
pretending that calling a schema validator alone tests the adapter.
Generic MCP and standing HTTP serving failures fail the campaign, even when
the adapter encodes them as an error result, HTTP 400, or an internal-error
denial or context-unavailable degradation inside a successful envelope. An
owner envelope reports the failure as an `error` denial, and an agent envelope,
which hides denials, as the degradation; regressions damage synthetic storage
and cover both, for MCP and standing HTTP. Only trusted envelope fields are
read, never captured text.

The first app campaign did not exercise the app. It created a vault directory
but no ledger, so nearly every authorized route answered `no_vault`, which a
campaign that accepted any HTTP 400 counted as a refusal. The driver now
initializes through the app's own route. Regressions replace a storage table
(the claims epoch) and drop the receipt table to show that an internal failure
fails the campaign as HTTP 400 and as the recorded outcome of an accepted
operation.

With the app reached, hostile input exposed caller errors that the app reported
as `unavailable`, the code it also uses for internal failures:
malformed JSON, invalid source-policy fields, correction and world-view input
the serving layer refuses, an unknown undo receipt, and a missing or
unsupported Google Calendar id. They are now `invalid_request`. A missing
operator Google client configuration, which was also `unavailable`, is
`misconfigured`; the app shows the same setup message for both.
`packages/cli/test/app-host.test.ts` covers each and shows an internal storage
failure is still `unavailable`.

The context-packet newline/stamp and Unicode-tag regression passes on the
current base after its serving-redaction change. The regression is enabled in
`packages/core/test/serve/packet-instruction-fuzz.test.ts`; this branch adds no
second renderer. Structured `canon`/`quoted` separation alone would not prove
flattened Markdown safety. Complete hidden-evidence noninterference remains
the serving lanes' responsibility; this campaign exercises inert grants and
does not claim a proof for every authorized read.

The JSONL source symlink regression also failed on the base. Its reader now
opens with no-follow/non-blocking flags, checks the open descriptor for a
regular file, and measures that descriptor instead of re-statting the path.
Directory and FIFO refusals and resume past an oversized row are covered by
`packages/connectors/test/legacy-jsonl-hostile.test.ts`.

Google Calendar's all-day date projection threw `RangeError` on an invalid
month or day. The public mapper now checks validity before ISO formatting;
the corpus retains the malformed provider record, and the regression covers
start, end, recurrence origin and a valid leap day. The [provider event
resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)
documents these date fields (checked 2026-09-30). This is an offline parser
check; it does not qualify a live account or change authentication.

ICS file backfill followed symlinks and replacement-decoded malformed UTF-8.
It now reads through one no-follow/non-blocking regular-file descriptor with a
fixed byte ceiling, rejects size changes, and decodes UTF-8 strictly. The
regression covers both refusals; the file campaign also probes oversized
calendars. [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) specifies UTF-8
for iCalendar (checked 2026-09-30). Parent-directory replacement races remain
outside this descriptor's final-component guarantee.

Beeper emitted a provider message beyond frozen ingress bounds. Its backfill
now validates the projected events before returning a batch or advancing a
cursor; the regression checks refusal and a valid retry. This is a local
synthetic response check, not live-account qualification or an authentication
change. Provider documentation retrieval was unavailable on 2026-09-30;
existing authentication and pagination contracts are preserved.

Beeper response reads now use fixed storage within the existing 2 MiB ceiling
and a 15-second body deadline. Refusal cancels without awaiting a
provider-controlled promise and releases the reader; an oversized body is a
`parse_error` and a stalled or failing body is an unavailable batch with no
checkpoint change. The Beeper target sends split bytes and empty chunks; the
`beeper-oversized-stream` corpus case creates an open 2 MiB-plus-one-byte
stream whose cancellation never settles, which hung the previous reader.
`packages/connector-beeper/test/hostile-stream.test.ts` covers that case through
the public connector, a declared length beyond the ceiling, a stalled body
(with the deadline's timers compressed), tiny and empty chunks, reader release
and a successful retry. The
[Beeper Desktop API documentation](https://developers.beeper.com/desktop-api/)
was reachable on 2026-09-30: it confirms bearer authentication and the message
search parameters (`cursor`, `direction`, `limit`) and response fields the
connector already uses. This change does not alter authentication or
pagination.

Calendar feed reads now use fixed storage within the existing 16 MiB ceiling,
strict UTF-8 decoding and the request deadline across chunk reads. Refusal does
not wait for stream cancellation. The feed target supplies split bytes and
empty chunks through an injected response; it performs no network call.
`packages/connector-ics/test/hostile-feed.test.ts` covers invalid UTF-8 refusal,
cancellation that never settles, and valid split Unicode.
