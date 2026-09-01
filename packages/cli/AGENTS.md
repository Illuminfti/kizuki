# CLI package instructions

These rules apply under `packages/cli` in addition to the root `AGENTS.md`.

## Responsibility

The CLI is a thin, predictable composition layer over public core and connector
APIs. It may collect explicit owner input and render results. It must not
reimplement storage, authorization, promotion, or connector policy.

## Rules

- Route state changes through public core APIs. Never write the database or
  canon directly from a command handler.
- Preserve the owner promotion gate and agent proposal-only authority.
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
  defined by core. A CLI flag must not create a policy bypass.
- Keep command help and README examples aligned with behavior that exists on
  the exact revision.

## Tests

Use temporary vaults and synthetic fixtures. Cover the public process seam:
valid invocation, invalid arguments, exit status, stdout/stderr separation,
repeated invocation, interruption and cleanup, denied authorization,
redaction, and proof that canon writes still pass through owner promotion.
Run CLI tests, typecheck, and the full repository gate.
