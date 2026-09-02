# Wave 1 session record (2026-09-02)

> **Superseded in part on 2026-09-02.** `docs/CURRENT.md`, `docs/decision-log.md`
> and `rfcs/0002-autonomous-canon.md` are binding: autonomous canon with no
> owner review gate, auto-labeled sensitivity, a configured model required for
> the world model, retrieval behind a port, an MCP `correct` tool, an always-on
> daemon installed at init, and a modular monolith with pluggable ports. This
> document is a historical record; where it conflicts, the binding documents win.

Lane specs and the design plan from the paused Claude Code Wave 1 session
(`a5628bd4-1ddc-45d7-a0bb-82a2f0065695`), reconciled against `main` at
`76930db` (515 tests green).

These files are the source of truth for remaining independent lanes, subject
to the binding documents above. Every spec that carried a superseded policy
now opens with a "Decision-log deltas (2026-09-02)" section naming the exact
sentences that are dead and the semantics that replace them; read it before
the spec body. Read `specs/CONVENTIONS.md` first in every case. Do not
re-derive these files from chat. Implement one lane per PR. Merges follow
`docs/decision-log.md` C5.

- `specs/` — per-lane implementation briefs
- `plan/` — MASTERPLAN, ARCHITECTURE, ROADMAP, COMPETITION, MIGRATION
