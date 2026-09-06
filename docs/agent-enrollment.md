# Connect a scoped agent

An agent connects to Kizuki with an explicit grant. Its credential stays in a
private file; the CLI reports setup state without printing the credential or its
path. File enrollment currently requires Linux x64 glibc with qualified local
filesystem custody. Other platforms refuse this delivery method.

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
`null` for types or subjects means unrestricted along that dimension; `[]`
allows none. The grant still applies the tool list, sensitivity ceiling, source
consent and other Core policy. `since` and `until` filter evidence time; they do
not expire the credential. An explicit grant does not change the inert defaults
of the existing Core `addAgent` API.

## Preview and enroll

Use an initialized vault and an absolute credential path. The destination must
be absent. Its parent must already exist, belong to the current user and have
mode 0700. Symlinked ancestry, unsafe writable ancestors and hard-linked files
are refused. Credentials use mode 0600. The `.kizuki` control directory or a
private directory outside the vault is supported; ordinary vault content is
refused because it is included in portable backups.

```bash
kizuki --vault /absolute/vault agent add assistant --grant agent-grant.json --token-ref file:/absolute/vault/.kizuki/assistant.credential --operation-id assistant-setup-1 --dry-run
kizuki --vault /absolute/vault agent add assistant --grant agent-grant.json --token-ref file:/absolute/vault/.kizuki/assistant.credential --operation-id assistant-setup-1 --json
kizuki-mcp --vault /absolute/vault --token-ref file:/absolute/vault/.kizuki/assistant.credential
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

## Retry and revoke

Repeat the exact add command after a lost response. Its identity and initial
grant are recorded once. A completed retry returns the current grant and epoch,
including later narrowing, rotation, quarantine or revocation. It never reapplies
the old grant or regenerates a missing credential.

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
revocation or cancellation. Fixed error codes appear in JSON; diagnostics go
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
