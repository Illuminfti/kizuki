# Portable connection history

Portable backups omit opaque connector state. New exports therefore record
every connection as disconnected, with empty `secret_refs` and the canonical
`kizuki.connection-config/v1` config whose `state_ref_index` is `null`. Export
reads only connection-history metadata and leaves the source connection alone.
It neither resolves state references nor reads connector credentials.

Restore applies the same normalization to supported v1, v2 and v3 connection
records, including older records which named state files or claimed an active
connection. A prior disconnection timestamp is retained; otherwise export or
restore records the time it made that portable history disconnected. The
original connection timestamp, source key, implementation version, checkpoint
history, source policies and consent receipts remain available as evidence.

Restored connections are excluded from active connection selection. Their old
checkpoints cannot start provider capture, and their null-state records cannot
perform same-source sign-in replacement or automatic state refresh. Restore
returns a recovery warning whenever connection history is present; the existing
CLI displays that warning. Retained policy and checkpoint rows do not reactivate
the old connection or grant consent to a new identity.

Further capture requires a supported fresh enrollment with a newly minted
source key and fresh consent. The core stateless enrollment path can create an
independent source, which starts without a checkpoint. It does not copy the old
source's cursor or consent. This is not a universal re-enrollment guarantee:
Google's existing duplicate-identity verifier requires the old opaque state for
same-connector comparisons. After portable restore, it can refuse a new-source
enrollment because that identity evidence is unavailable. That refusal remains
in force pending a separate source-identity recovery design; do not clear or
rewrite the historical rows to bypass it.

The backup schema remains v3. Missing recovery journals, holds, purge/run state,
and the shared snapshot boundary are separate work. Disconnected connection
history does not make the artifact a complete runtime recovery backup.
