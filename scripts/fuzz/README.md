# Hostile input fuzzing

This is an offline regression and mutation harness, not a proof that every
possible input is safe. `corpus.json` contains synthetic hostile byte strings
and compact specifications for large inputs. `cases.ts` adds deterministic
mutations from an unsigned 32-bit seed. Workers never print input, exception
messages, causes, tokens, or scratch paths. Receipts identify target, seed,
last case, completed cases, maximum RSS, and the failed property.

From the repository root on Linux, using the pinned Bun version and the shared
build host's test semaphore:

```sh
ktest bun test scripts/fuzz/fuzz.test.ts --timeout 120000
ktest bun scripts/fuzz/run.ts --seed 5369869
ktest bun scripts/fuzz/run.ts --long --seed 5369869
ktest bun scripts/fuzz/run.ts --long --target imap-mime --seed 5369869 --cases 10000
```

The first command is included in ordinary Bun test discovery and therefore
in the existing CI verify job (which runs Bun directly). On a private local
machine without `ktest`, omit that prefix. Its budget is the fixed corpus plus eight
seeded cases per target, a 20-second deadline per worker, a 512 MiB RSS
ceiling, and a 120-second test deadline. The standalone command uses the same
budget. Long mode adds 2,000 seeded cases per target and gives each worker
five minutes; `--cases` overrides the generated count (0–100,000). `--target`
selects one target, and the same seed and count replay the complete sequence.
The first failing target stops the campaign. There is no automatic shrinking;
reduce the failing synthetic case into a public-seam regression before fixing
it, then retain it in the corpus.

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
| `receipt`, `render-output` | Local adapter admission | Bounded refusal with synthetic consent; no reference fetch |
| `ics`, `ics-rrule` | Calendar grammar, event mapping, recurrence rule parser | Nesting and component refusal, bounded output; mapped events pass ingress |
| `imap-mime`, `imap-response` | MIME event mapping and response tokenizer | Invalid octets, multipart prefix ambiguity, depth and part limits, ingress validity |
| `telegram` | Typed provider message projection | Private sensitivity preserved; host ingress admission checked separately |
| `x-ytd`, `x-api`, `gmail`, `google-calendar` | Archive wrapper and provider response projections | Determinism, malformed schema refusal, bounded output |
| `session-claude`, `session-codex` | Session JSONL record interpretation | Harness-text exclusion, sanitized evidence, ingress validity |
| `markdown-files`, `wiki-files` | Folder backfill and wiki scanning | Cyclic/file symlinks excluded, malformed UTF-8 refusal, sparse oversized pages, compressed cursor expansion ceiling |
| `session-files-claude`, `session-files-codex`, `legacy-jsonl`, `legacy-sqlite` | File readers, resumable JSONL paging and corrupt read-only SQLite exports | Oversized input, malformed bytes, bounded batches, forward progress past hostile rows |
| `x-archive` | Archive directory scan | Malformed account/tweet data, file symlink refusal, sparse oversized account part |
| `http`, `mcp` | Loopback HTTP and SDK client over in-memory JSON-RPC plus raw stdio framing | Every one of the ten tools; inert grant refusal, argument mutations, captured instruction text stays in `quoted` |

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
The matrix does not exercise screenpipe or WHOOP projections, the complete
Pocket/Omnivore/WhatsApp filesystem and media mapping stages, or app-specific
HTTP route handlers. It also does not cover every credential/state decoder,
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

A desired context-packet rendering regression is retained as a named skipped
test in `packages/core/test/serve/packet-instruction-fuzz.test.ts`. Captured
newlines can create stamp-looking Markdown outside the quoted prefix; tag
characters can survive the packet rendering. The serving redaction lane owns
that overlapping renderer. Replay the desired assertion with:

```sh
KIZUKI_FUZZ_REPRODUCE=1 ktest bun test packages/core/test/serve/packet-instruction-fuzz.test.ts --timeout 120000
```

A skipped assertion is open work, not a passing safety claim. The structured
`canon`/`quoted` separation checks do not prove that flattened packet Markdown
is safe. Integrate the serving redaction lane and enable this assertion only
after the same head passes it. Other hidden-evidence noninterference work
remains in the serving lanes; this branch exercises the inert grant and does
not claim a complete noninterference proof for every authorized read.

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
