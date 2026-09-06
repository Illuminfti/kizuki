# Grok fleet skill and worker instruction pack

Prepared 6 September 2026 for root's requested 100-worker, 12-hour Grok subscription campaign. Status: reviewable instruction pack only. This pack has not installed skills, changed global configuration, launched workers, or verified the effective Grok model, subscription route, discovery behavior, capacity, or runtime limits.

## Use the pack

1. Root reconciles live ownership and assigns a bounded task, isolated worktree, exact base, owned paths/contracts, dependencies, and acceptance evidence in [TASK-PACKET.template.md](TASK-PACKET.template.md). Existing owners keep their lanes.
2. Give the worker that filled packet, [COMMON-WORKER.md](COMMON-WORKER.md), and exactly one matching file from `roles/`. Select specialist skills from [SKILL-MANIFEST.md](SKILL-MANIFEST.md) only when their triggers apply. Read the selected canonical files; these templates do not replace them.
3. Root verifies effective discovery before dispatch. The supplied discovery contract names repository `AGENTS.md`, `.agents/skills`, and `.claude/skills`; this pack does not claim the installed Grok has demonstrated it. Check that a harmless preflight reports the actual repository, applicable instructions, chosen skill paths, model identity, and authorized subscription route. Confirm actual tool reads and selected-file hashes, not only a model's statement that it read them. Preserve a redacted receipt. A missing skill is a setup dependency, not permission to install globally.
4. Allocate separate workers for specification/security review and implementation/regression review at the frozen head. C2 also requires an independent-model review: two Grok workers alone do not satisfy that lens. Root assigns it through a separately qualified model route.
5. Workers return [RESULT.template.md](RESULT.template.md). Root integrates dependencies and obtains the required exact-head checks and packaged consumer evidence before making readiness claims.

The requested fleet size and window do not create 100 independent contracts or 100 full-suite slots. Root controls concurrency, test slots, resource limits, retries, and deadlines. Workers do not recursively dispatch a second fleet. Use task-specific context and local evidence; do not send every worker the campaign transcript or all skills.

## Source identity

Canonical repository skills were inspected at clean `a7e4b53ce7107bccaa7a62e6e91e4ee384a38f08`, tree `d342460db16297ba1deba1127a4b6e2fba9b4e70`, in `WORKTREES/kizuki-stranger-main327-20260906`. This is an inspection snapshot, not a claim that it remains live main. Use each worker's assigned revision and refresh changed instructions before work.

[sources.json](sources.json) records exact inspected absolute paths, SHA-256 hashes, lengths, triggers, and role mappings. `.claude/skills/connector-work/SKILL.md` was checked as a pointer to the canonical `.agents` skill; do not load both bodies as separate policy. External design skills are optional local references, not automatically installed Grok skills.

## Reconciliation

System/developer rules and explicit owner instructions govern the assignment. Within Kizuki, `docs/CURRENT.md`, `docs/decision-log.md`, and binding RFC0002 override subordinate repository guidance; root/scoped `AGENTS.md` constrain skills. Read the current task's applicable instruction chain.

D19 supersedes mandatory seven-/fourteen-day readiness windows. Stranger installation/use, zero live P0s on the exact candidate, honest installation, and the remaining product/platform/review requirements remain. Twelve hours of worker activity proves no elapsed qualification that did not occur. C2's independent-model lens and C5's delegated maintainer authority remain distinct from worker authority.

Generic global `implement`, `code-review`, `review-and-ship`, `fix-ci`, and `handoff` were screened but not selected: their current-branch commits, recursive subagents/setup, pushes/PR actions, or temporary-file conventions are less precise than the repository playbooks. No automatic merge, paid-account setup, rate-limit workaround, or global installation procedure is included. Visual skills are conditional and subordinate to the existing design, privacy, accessibility, and dependency rules.

Verification of this pack covers source identity, selected skill paths/hashes, template links, placeholder structure, and scope. It does not establish worker execution or product acceptance.
