# Connect a scoped agent

An agent connects to Kizuki with an explicit grant. Its credential stays in a
private file; the CLI reports setup state without printing the credential or its
path. File enrollment requires native local filesystem custody. A failure to
load the required native custody helper returns `unsupported_platform`;
changing destination permissions cannot supply missing native support.

For guided setup and the exact local Codex registration command, use
[the app's Codex CLI guide](local-app.md#connect-codex-cli). It uses the generated
scoped credential-file reference and does not grant owner access.

## Run from a package or source checkout

The examples below use the package executables `kizuki` and `kizuki-mcp`.
If you followed the [source quick start](../README.md#quick-start), run them
from the checkout root after `bun install --frozen-lockfile`, replacing only
the command prefix:

| In the examples | From the source checkout root |
| --- | --- |
| `kizuki` | `bun packages/cli/src/main.ts` |
| `kizuki-mcp` | `bun packages/mcp/src/bin.ts` |

Keep the same arguments, including the absolute vault and `file:` credential
paths. When configuring an MCP client's launch command, use the absolute Bun
executable path and the checkout's absolute `packages/mcp/src/bin.ts` path as
its first argument, followed by the documented vault and authentication flags.

## Choose the grant

Save a complete grant as `agent-grant.json`. This example allows personal-or-lower
search results concerning the known subject `person:ada`:

```json
{
  "ceiling": "personal",
  "types": null,
  "subjects": ["person:ada"],
  "since": null,
  "until": null,
  "tools": ["search"],
  "rate_limit_per_minute": 60,
  "relay_owner_corrections": false
}
```

All eight fields are required. Unknown fields and owner presets are refused.
`relay_owner_corrections` also decides whether the agent's `world_view` reads
include the owner's own corrections. Without it, a corrected world claim is
absent from that agent's cards: the superseded value is withdrawn and the
owner's replacement is not shown. Enable it for an assistant that should read
the corrected world state.
`null` for types or subjects means unrestricted along that dimension; `[]`
allows none. The grant still applies the tool list, sensitivity ceiling, source
consent and other Core policy. `since` and `until` filter evidence time; they do
not expire the credential. An explicit grant does not change the inert defaults
of the existing Core `addAgent` API.

## Preview and enroll

Use an initialized vault and an absolute credential path. The destination must
be absent. Its parent must already exist, belong to the current user and have
mode 0700. Symlinked ancestry, unsafe writable ancestors and hard-linked files
are refused. Credentials use mode 0600. Inside the vault, only direct files in
`<vault>/.kizuki/agent-credentials` are supported. Create that private directory
explicitly if absent; enrollment never creates or repairs its parent. A private
directory outside the vault is also supported. Other vault paths and the exact
basenames `kizuki.db`, `kizuki.db-wal`, `kizuki.db-shm` and `kizuki.db-journal`
are refused, including those basenames outside the vault.

```bash
mkdir -m 700 /absolute/vault/.kizuki/agent-credentials
kizuki --vault /absolute/vault agent add assistant --grant agent-grant.json --token-ref file:/absolute/vault/.kizuki/agent-credentials/assistant.credential --operation-id assistant-setup-1 --dry-run
kizuki --vault /absolute/vault agent add assistant --grant agent-grant.json --token-ref file:/absolute/vault/.kizuki/agent-credentials/assistant.credential --operation-id assistant-setup-1 --json
kizuki-mcp --vault /absolute/vault --token-ref file:/absolute/vault/.kizuki/agent-credentials/assistant.credential
```

Replace the paths and subject with your intended scope. The operation ID is
8–64 ASCII letters, digits, underscores or hyphens, starting with a letter or
digit. Keep it with the request for retries. Preview does not initialize or
migrate a vault, alter permissions or config, create a credential, or change a
service. On an older ledger it reports `migration_required`; execution uses
Core's ordinary additive migration. Preview requires an idle, checkpointed
ledger with no WAL, shared-memory or rollback-journal sidecars. If those files
exist, or the main database changes during inspection, preview reports
`enrollment_busy` and leaves them intact. It never ignores committed WAL data
or alters a running service to obtain a preview.

MCP requires exactly one of `--owner`, `--token-env VAR` and `--token-ref`.
Credential metadata is never authority: Core checks the current token, agent
identity, completed enrollment and original file binding. Copying the file to a
different path does not satisfy that binding. Existing environment-token
authentication remains available.

## List agents and amend a grant

```bash
kizuki --vault /absolute/vault agent list
kizuki --vault /absolute/vault agent grant assistant --grant agent-grant.json --operation-id assistant-grant-1 --json
```

`agent list` shows each agent's state, grant epoch and grant summary. It never
prints a credential, a token hash or a credential path.

`agent grant` replaces the agent's complete grant without revoking it or
issuing a new credential. The grant file has the same eight required fields as
enrollment, so to add `world_view` to a reader, save the full grant with
`"tools": ["search", "world_view"]`. To change owner-correction relay, change
`relay_owner_corrections`. The credential file and running MCP sessions keep
working; the next call authorizes against the new grant, and the grant epoch
rises by one with an `agent.grant` audit row (see `kizuki audit`).
Use a fresh operation ID for each intended change. Repeating an ID with the same
request is safe and reports the current grant; the same ID with a different
grant, or an ID already used for enrollment, is refused as `operation_conflict`.
An unknown, revoked or unfinished agent is refused as `unknown_agent`. Amending
a quarantined agent with a valid grant repairs it. Old grants are not restored
by a retry.

The Core `OWNER_AGENT_GRANT` preset, meant for a harness the owner runs
themselves, includes `world_view`, `propose` and `correct` with relay on. The
public default grant given to a newly created arbitrary agent stays inert: no
tools, public ceiling and relay off. The app's **Set up an agent** dialog offers
`world_view` among its read tools, unchecked by default, and an owner-correction
relay choice that defaults to off. With relay on, the agent's `world_view` reads
include the owner's own corrections. That dialog grants no `propose` or
`correct` tool, so an app-created agent cannot relay a correction until its
grant is widened with `agent grant`.

## What an agent is served

Every text field an agent receives passes one redaction step in Core, below the
MCP and HTTP adapters, so stdio, loopback HTTP and the `context_packet` session
hook behave alike. It reuses the scrubber that protects model prompts. For an
agent it replaces these shapes with `[redacted:<kind>]`: PEM blocks (`pem`), JWTs
(`jwt`), Kizuki agent (`kzk_`) and prefixed serve (`kzs_`) tokens, common API tokens including
Stripe live, Google, GitLab, npm and Slack app tokens (`api_token`), Bearer values
(`bearer`), Basic and Token authorization values (`authorization`), credentials
in URLs of any scheme (`url_credentials`), secret-named assignments in shell,
JSON or YAML, including indented block scalars (`secret_assignment`), and
mnemonic-like lowercase word runs
(`seed_phrase`). The same Core patterns protect coding-session capture.
Wrapped tokens, re-flowed PEM headers, blank lines after an assignment and
percent-encoded credential forms are recognized. Existing redaction markers
are inert on a second envelope pass, so each replacement is counted once.
The redactor tracks windows and rendered blocks within each call, preserving
clipped markers while still checking credentials newly formed across fields.
It covers `search`, `get_page`, `timeline` and expansion, every context-packet
section, entity and graph labels, and `world_view` cards. The owner keeps
credential text for inspection; the daemon always removes its exact live
credential, including an older unprefixed token. Session-start hook delivery
scrubs credentials even when the hook reads as owner.

Serving scans bounded prefixes before cutting previews and excerpts. Timeline
and search previews cap their scan before redaction; explicit search `full_text`
reads scrub the full requested capture rather than silently clipping it.
Timeline expansion projects at most 131,072 source UTF-16 code units; its `total` and offsets
refer to that scrubbed projection, and `truncated` remains true when source
text lies beyond it. For agents, expansion and task `integrity` bind the served
projection rather than the secret-bearing capture. Owner pins retain the raw
capture digest. Pins from those two views are not interchangeable. Task records
above 16,384 characters fail closed before parsing or scrubbing.
Correction replies give agents keyed receipt digests, stable for the serving
process lifetime; owner replies and durable undo receipts keep their raw hashes.

Every principal receives text without terminal escapes, controls, zero-width
characters, Unicode tags, bidirectional controls or variation selectors.
Opening angle brackets are escaped, including unfinished tags, so captured
text cannot open or close a harness block. In a packet, canon excerpts and
captures remain quoted line by line, and titles and paths remain on one line.

`system_health` for an agent counts only the pages, events and claims its grant
can read and lists only the connections that feed that view. Each count stops at
100,000; when it does, the answer carries `counts_capped: true`. Vault-wide totals,
agent counts, runtime and index details, and connection run results are owner
only. `correct`, `propose` provenance and a `context_packet` task capture refuse
an id the agent may not read with the same answer as an absent id.

Limits. Shape matching is a heuristic backstop, not detection of every possible
secret or persuasive instruction. It does not remove a credential an agent
already knows. Counts describe replacements during response assembly, including
bounded candidates subsequently omitted by the packet budget. `world_view`
evidence spans refer to stored capture offsets; expanding them after an earlier
redaction can select a different served window.
A `world_view` label or literal that redaction lengthened is cut back to the
length the grammar allows. Redaction narrows what is served; the grant,
sensitivity ceiling and source consent still decide what an agent may read at
all.

## Retry and revoke

Repeat the exact add command after a lost response. Its identity and initial
grant are recorded once. A completed retry returns the current grant and epoch,
including later narrowing, rotation, quarantine or revocation. It never reapplies
the old grant or regenerates a missing credential.
If a stored grant is malformed but has not been quarantined, preview reports
unavailable authority and a stale intact credential. Preview does not change
that state or diagnose it as a file conflict.

| Result | Meaning and next action |
| --- | --- |
| Preview | Validation succeeded without enrollment effects. |
| Completed, active, ready | Setup succeeded. Connect using the supplied reference. |
| Completed with absent, conflict or stale credential | Setup is no longer usable with its original credential. The retry does not repair or replace it. |
| Pending | Delivery is incomplete and this enrollment has no active grant. Preserve the artifact and follow the recovery guidance. |
| Cancelled or revoked | Add cannot reactivate this operation. |

An interrupted complete, bound credential can be recovered by the same request.
An interrupted partial file is retained and cannot authenticate. Cancel that
pending enrollment, then use a fresh operation ID and destination. A pre-existing
unrelated destination is never overwritten or deleted.

```bash
kizuki --vault /absolute/vault agent revoke assistant --json
```

Revocation applies to the next tool call in every existing MCP session.
Repeated revocation does not add another epoch or audit entry. It retains the
credential file. Deleting a file alone does not revoke an existing session;
token rotation affects new connections, while revocation stops existing ones.

## Structured output and portability

`--json` uses `kizuki.cli.agent/v1`. Its `data` carries the Core
`kizuki.agent-enrollment/v1` result: operation ID, agent ID, name, status,
authority, credential state, current grant, grant epoch and replay indicator.
Legacy-agent revocation has a null operation ID because it has no enrollment
receipt. Name-only revocation reports credential state `unknown`: it revokes
authority without locating or deleting a file. A result contains no token,
token hash, credential digest or OS path.

Add exits 0 for a validated preview or completed/active/ready setup, 2 for
invalid input, and 1 for every other setup state. Revoke exits 0 after terminal
revocation or cancellation. Grant exits 0 after an amendment or a replay of one,
2 for invalid input or grant, and 1 for every refusal. Its `data` is
`kizuki.agent-grant/v1`: operation ID, agent ID, name, the resulting grant, its
epoch and a replay indicator. List exits 0 with the agent rows. Fixed error codes appear in JSON; diagnostics go
to stderr and omit private paths and input.

Portable backups exclude agent identities, grants, authentication audit,
enrollment receipts and `.kizuki` credential files. A restored vault needs
explicit agent enrollment. This flow does not claim protection against malicious
processes running as the same user or rollback of an entire disk image.

## Verification

The repository tests exercise CLI exit codes and redaction, read-only preview,
credential conflicts, current-grant retries and independent MCP stdio processes.
On Linux x64, the release smoke runs the compiled CLI-to-MCP enrollment and
revocation journey; other native targets check explicit platform refusal.
These synthetic checks do not establish live-account, human or other-platform
qualification.
