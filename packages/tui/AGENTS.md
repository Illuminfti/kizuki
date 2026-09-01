# TUI package instructions

These rules apply under `packages/tui` in addition to the root `AGENTS.md`.

## Responsibility

The TUI is the owner's review surface. Its state machine and renderer should be
pure; terminal I/O, editor launches, and persistence belong at explicit edges.

## Rules

- Every key path must be testable without a real TTY.
- Treat proposal titles, diffs, source text, filenames, and editor output as
  hostile. Strip control and escape sequences before rendering.
- Rendering must not execute markup, terminal control, links, or captured
  instructions.
- Preserve explicit owner confirmation for promotion, merge, edit, deletion,
  purge review, and batch operations.
- A batch action must show and bind the exact selected items. Changes in queue
  state invalidate stale confirmation.
- Never write canon or the database directly. Invoke the public review and
  promotion APIs.
- Keep wide and narrow layouts usable, deterministic, and bounded. Truncate
  safely without splitting escape handling or hiding the action being
  confirmed.
- Restore terminal state after success, error, signal, or editor failure.
- Do not log captured content, editor buffers, tokens, or owner-private paths.

## Tests

Exercise reducer transitions, rendering, sanitization, small terminal sizes,
large and malformed input, editor round trips, stale selections, two-step
confirmation, cancellation, failure cleanup, and every proposal kind. Then run
TUI tests, typecheck, and the full repository gate.
