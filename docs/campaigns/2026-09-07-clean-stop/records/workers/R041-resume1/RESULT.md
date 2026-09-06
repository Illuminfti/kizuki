# Result R041

Outcome: FINDINGS. Scope: static map of absent/configured/unavailable model
states, doctor/serve/models-pull diagnostics, and existing tests on
`f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. No source edits. No provider calls.

- Repository/worktree/branch: read-only `/repo` git archive of exact base; no Git metadata
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no local HEAD
- Dirty/local-only state and owned files: `/work/out` only
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, D12/D19, RFC 0002 §11.4/§12
- What changed and why: preparation artifacts only. Public contract is the three doctor states (off / unverified / on), serve bind failures as `error: serve model configuration: …` exit 1, and `kizuki models pull` local-copy diagnostics.
- Ownership/dependencies: feeds P039, P040. P006 owns canonical docs. P003 owns shared evidence design. No implementation authority.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/scripts/validate-static.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:04:27Z, `/work/out/checks/static-validate.json` | PASS (static strings + fixture parse only) |
| Existing CLI/package tests | `bun test packages/cli/test/doctor/liveness.test.ts` and siblings | NOT_RUN — `/repo` has no `node_modules`; `bun install` forbidden |
| Package/type/full gate | `bun test`, `bun run typecheck`, `bash scripts/verify.sh` | NOT_RUN — same missing install; no test slot |
| Privacy/diff integrity | fixture scan in validate-static (no `sk-`, no non-loopback `https://`) | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/core/src/serve/doctor.ts:229` / `docs/cli.md:238` — doctor ships `on|off|unverified`; doctor CLI docs still say `on|off`. Invariant: honest doctor states. Fix owner: P006 after P039/P040 decide whether unverified stays.
2. `rfcs/0002-autonomous-canon.md:2122-2124` vs `packages/cli/src/serve-runtime.ts:66-67` and `packages/core/src/serve/config.ts:35-38` — RFC string form is serve-fail + doctor-off, not configured. Invariant: configured vs absent. Do not treat the string form as a model.
3. `packages/cli/src/vault-config.ts:22` vs `serve-runtime.ts:72` — `kizuki.llm.gguf` named, not bound.
4. Invalid TOML: doctor off (`config.ts:28-31`), serve exit 1 (`serve-runtime.ts:53-56`). Distinct from unverified.
5. Doctor swallows bind errors (`commands/doctor.ts:327-330`); serve prints the reason. Tests lock doctor exit 0 for unverified.
6. Brief rail binary on/off (`rails.ts:339`) vs doctor tri-state.
7. Wire `model = "none"` vs port `kizuki.llm.none` — untested divergence.

Hypotheses: doctor may report `on` after binding loopback-complete without a fetch; redaction may spare short model names. Not executed.

Remaining risk: existing tests were not re-run. Issue 473 body was not fetched. No native/account/model/human qualification. Next smallest action: P039/P040 consume `/work/out/config-state-to-message-map.json` and fixtures; rebase before production use; do not duplicate off/unverified/`--from` tests.
