# Decision log

Settled product decisions. RFC 0002 is the implementation brief for D9–D16.
Gate 0 items D1–D8 were settled 2026-09-01. Autonomy items D9–D16 were
settled 2026-09-02.

| Id | Date | Decision | Answer |
| --- | --- | --- | --- |
| D1 | 2026-09-01 | Frame | Public open-source product. The owner is user one. |
| D2 | 2026-09-01 | Scope | Local-first memory substrate plus proactive rails. Not a harness. Hosts no agents. |
| D3 | 2026-09-01 | Repository | Fresh public repository. Clean history. |
| D4 | 2026-09-01 | Floors | Frozen thin ingress, subject ids from day one, fail closed, zero phone-home, deterministic floor, purge receipts, secret references, no fake surface. |
| D5 | 2026-09-01 | Agent layer | Agents are first-class clients: identity, grants, sensitivity ceilings, audit. No hosted agent loop. |
| D6 | 2026-09-01 | Run model | CLI remains usable without a daemon. D15 later installs the daemon at init. |
| D7 | 2026-09-01 | Language | TypeScript on Bun. Single workspace. |
| D8 | 2026-09-01 | Name and license | Kizuki. MIT. Free local forever. Recall is never metered. |
| D9 | 2026-09-02 | Autonomous canon | The loop writes Markdown canon. Every write is receipted, attributable, budgeted, and reversible. |
| D10 | 2026-09-02 | No owner review queue | There is no owner review queue and there never will be one. The TUI is audit and undo only. |
| D11 | 2026-09-02 | Auto-labeled sensitivity | Sensitivity is assigned automatically from connector defaults and model refinement. Unlabeled pages are never served. |
| D12 | 2026-09-02 | Model required for world model | Capture, ledger, search, timeline, context, audit, and undo work with no model. Canon writing requires a configured model. Doctor says so when it is missing. |
| D13 | 2026-09-02 | Retrieval behind a port | Derived retrieval is a versioned port. Implementations may own a store under `<vault>/.kizuki/retrieval/`. The store is rebuildable from ledger plus canon. |
| D14 | 2026-09-02 | MCP correct | Serving exposes two write tools: `propose` and `correct`. Conversational correction is the human path. |
| D15 | 2026-09-02 | Daemon at init | `kizuki init` installs `kizuki serve` as an always-on user service. The CLI still runs when the daemon is down. |
| D16 | 2026-09-02 | Modular monolith with ports | One process. Every replaceable component sits behind a versioned port, a registry, and a shared conformance suite. |

D9–D16 supersede any earlier Gate 0 answer that made the owner the only
consumer of a review queue, or that forbade scheduled canon writes.
