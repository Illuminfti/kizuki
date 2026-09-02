# CLI package instructions

These rules apply under `packages/cli` in addition to the root `AGENTS.md`.

## Binding context

`docs/CURRENT.md`, `docs/decision-log.md` and `rfcs/0002-autonomous-canon.md`
override this file and the root `AGENTS.md` wherever they conflict. Read them
before editing anything here. No change in this package may restate or
reintroduce a superseded policy: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner labeling of sensitivity (D11), a
zero-model floor that writes canon (D12), a SQLite-only rule for derived
retrieval (D13), or an owner-started daemon (D15).

## Responsibility

The CLI is a thin, predictable composition layer over public core and connector
APIs. It may collect explicit owner input and render results. It must not
reimplement storage, authorization, the receipted canon writer, or
connector policy.

## Rules

- Route state changes through public core APIs. Never write the database or
  canon directly from a command handler.
- Preserve the receipted-writer boundary (docs/decision-log.md D9, D10;
  RFC 0002 §2.1). Agents propose claims and relay owner corrections; no CLI
  verb writes a page except through core undo or the leftover Wave 1
  `promote` path, which is a transitional implementation a named lane
  removes, not the product gate. `review` / `promote` / `reject` are not the
  owner path and must not be presented as one; the accepted verbs are
  `audit`, `tell`, `undo`, `context`, `timeline`, `rebuild`, `models` and
  `serve` (RFC 0002 §2.5).
- Keep argument parsing, orchestration, and presentation separable and testable.
- Use deterministic exit codes and stable, actionable errors.
- Reserve stdout for the command's promised output. Send diagnostics and
  progress to stderr.
- Never print tokens, secret references that expose sensitive paths, captured
  private text in diagnostics, raw provider responses, or unrestricted audit
  arguments.
- Interactive auth must make the provider, requested access, destination, and
  cancellation path clear.
- Refuse unsupported or ambiguous operations rather than guessing a vault,
  connector, identity, or destructive scope.
- Destructive operations require explicit scope and the confirmation semantics
  defined by core. A CLI flag must not create a policy bypass. Canon writes
  are not one of those operations: they are receipted and reversible and are
  never confirmed by the owner (docs/decision-log.md D9, D10). `kizuki init`
  installs `kizuki serve`; the CLI must still work with the daemon down and
  declare its degradation (docs/decision-log.md D15, RFC 0002 §2.1).
- Keep command help and README examples aligned with behavior that exists on
  the exact revision.

## Tests

Use temporary vaults and synthetic fixtures. Cover the public process seam:
valid invocation, invalid arguments, exit status, stdout/stderr separation,
repeated invocation, interruption and cleanup, denied authorization,
redaction, and proof that canon writes still pass through the receipted
writer. Do not add a second canon write path.
Run CLI tests, typecheck, and the full repository gate.
