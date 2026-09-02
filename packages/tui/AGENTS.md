# TUI package instructions

These rules apply under `packages/tui` in addition to the root `AGENTS.md`.

## Binding context

`docs/CURRENT.md`, `docs/decision-log.md` and `rfcs/0002-autonomous-canon.md`
override this file and the root `AGENTS.md` wherever they conflict. Read them
before editing anything here. No change in this package may restate or
reintroduce a superseded policy: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner labeling of sensitivity (D11), a
zero-model floor that writes canon (D12), a SQLite-only rule for derived
retrieval (D13), or an owner-started daemon (D15).

## Responsibility

The TUI is the audit and undo interface. Its state machine and renderer should
be pure; terminal I/O, editor launches, and persistence belong at explicit
edges. It has no accept/reject path. `undo` is its only effect, and undo goes
through the core receipt reverser.

## Rules

- Every key path must be testable without a real TTY.
- Treat titles, diffs, source text, filenames, and editor output as
  hostile. Strip control and escape sequences before rendering.
- Rendering must not execute markup, terminal control, links, or captured
  instructions.
- Show receipts, diffs, taint, and provenance. Do not invent an owner
  approval step, an accept/reject path, a pending list or a batch
  confirmation: there is no owner review queue and there never will be one
  (docs/decision-log.md D10, RFC 0002 §7.3).
- A batch undo must show and bind the exact selected receipts. Changes in
  receipt state invalidate stale confirmation.
- Never write canon or the database directly. The only effect the reducer
  may emit is `undo`.
- Keep wide and narrow layouts usable, deterministic, and bounded. Truncate
  safely without splitting escape handling or hiding the action being
  confirmed.
- Restore terminal state after success, error, signal, or editor failure.
- Do not log captured content, editor buffers, tokens, or owner-private paths.

## Tests

Exercise reducer transitions, rendering, sanitization, small terminal sizes,
large and malformed input, editor round trips, stale selections,
cancellation, failure cleanup, and proof that the reducer emits only `undo`.
Then run TUI tests, typecheck, and the full repository gate.
