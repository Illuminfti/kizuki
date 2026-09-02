# Lane: oauth-signin — SUPERSEDED, split on 2026-09-02

This spec was reconciled against `main` @ `76930db` and split into two lanes.
Do not implement from this file.

- `oauth-core.md` — `packages/core/src/auth/` (PKCE + loopback sign-in helper,
  `kizuki.oauth-state/v1` envelope, `OAuthSession` refresh + persistence),
  `ConnectionStateStore.rewrite` / `createStatePersister`, `KizukiError` moved
  to core, the network-scanner allowlist. Zero dependencies.
- `connector-google.md` — NEW `packages/connector-google` (Gmail + Calendar
  read-only backfill/sync/tombstones/purge plan on the helper). Depends on
  `oauth-core`.

Everything the old text assumed that main no longer has (`signIn(io, secretsDir)`,
`saveTokens`/`loadTokens`, `file:` refs for tokens, a connector-chosen
`source_key`, `scripts/check-no-network.sh`) is listed under "Already on main"
and "Dropped" at the top of `oauth-core.md`.
