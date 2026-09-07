# Portable connection restore

A portable backup preserves source keys, connection history, checkpoints,
source policies and consent receipts. It excludes opaque connector state and
credentials. The backup schema remains v3.

The CLI can also preserve local source paths for its eight path-only, none-auth
connectors: Markdown folders, ChatGPT, Claude, WhatsApp, Pocket, Omnivore,
X archives and Screenpipe. It stores those paths in
`connections/portable-local.v1.jsonl`, inside the hashed backup manifest.
Paths can contain private information; this stream has the same private file
and directory permissions as the rest of the backup. No raw `.state` file is
copied. A connector advertising `none` alongside another authentication mode,
such as ICS, is excluded from this path-only format.

Export reads a selected connection's state only when that source has an active,
matching grant that permits export. Otherwise it retains only sanitized,
disconnected history. The existing whole-backup refusal for a denied source or
an active grant without export permission still applies. Export leaves the
source's state, connection row, grant and checkpoint unchanged.

Each portable path is bound to its source key, connector and original connection
status. Verification checks the stream's bytes, closed record format, bounds,
private native file custody, connection membership and active export grant.
Restore also validates the complete policy and consent receipt graph before
reconstructing any state. A missing, altered, malformed or unsupported stream
fails before the restored vault is published. Backup checksums detect byte
changes against the manifest; they do not authenticate the origin of a manifest
that someone has replaced in full.

With the CLI's supported adapter, restore reconstructs minimal path-only state
inside private staging. It reactivates a source only if the exported connection
was active and its restored grant still permits capture. An originally
disconnected source stays disconnected. The original source key, policy and
checkpoint are preserved, so an eligible connector can resume its own capture
cursor. The CLI rebuilds its derived index before publication; a rebuild failure
leaves no published target. A local path that no longer exists remains a real
health failure reported by `doctor`.

Core callers opt in through `portableLocal` on export and restore. Without that
adapter, Core still validates a present portable stream but restores inert
history without connector state. Legacy backups without the stream also remain
inert. Unmanifested `.state` files are never consumed. Inert records have empty
`secret_refs`, a `state_ref_index` of `null`, and a disconnection timestamp; an
existing timestamp is preserved. Restore reports a recovery warning when
connections remain disconnected.

Sign-in connectors require supported fresh enrollment with a new source key and
fresh consent. Their historical checkpoints and policies do not authorize that
new identity. Google's existing duplicate-identity verifier can refuse fresh
enrollment when the old opaque state is unavailable; this restore mechanism
does not bypass that refusal or reconstruct missing identity evidence.

The optional format is bounded: at most 1,024 connection and grant rows, a 1 MiB
limit for each bound stream and manifest, a 1 MiB aggregate source-state budget,
and 4,096 UTF-8 bytes per canonical absolute path. It is a local-path recovery
format, not a complete runtime recovery backup. Pending recovery and source
export restrictions continue to apply.
