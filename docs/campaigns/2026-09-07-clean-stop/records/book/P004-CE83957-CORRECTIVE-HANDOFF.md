# P004 corrective handoff for `ce839579`

Start only from exact commit `ce8395792a333ad760594f92f1198639e0936445`. Keep writes limited to `scripts/release-evidence.ts`, `scripts/go-no-go.ts`, and `scripts/go-no-go.test.ts`. Preserve v1/v2 behavior, the total v3 mapping, inactive-family states, the optional capability sentinel, and overall `NO-GO`. Do not create or edit `scripts/capability-proof.ts` or `packages/cli/src/help.ts`.

Root's sealed run `cb9fb1aa075e41698864945a4cc02685` failed before tests because `scripts/release-evidence.ts` could not resolve root-level `@kizuki/connectors`. The root package does not declare the connector or MCP workspaces. Replace both new workspace-alias imports with repository-relative source imports (`../packages/connectors/src/index` and `../packages/mcp/src/index`), and import `printRootHelp` through its repository-relative CLI source path. Do not change the harness or add root dependencies to make the candidate pass. Re-run the exact focused test after correction; the failed run gives no test credit.

## Required correction 1: bind execution and observed bytes to the candidate

Add one fail-closed checkout-custody operation used before a surface receipt can be consumed. It must establish all of the following as one local-custody frame:

1. Canonicalize the evaluator root and require Git's `--show-toplevel` to equal it. Require `HEAD` to equal the validated v3 index candidate.
2. Reject any staged change, tracked working-tree byte or mode change, and untracked non-ignored path. Do not let a merely present untracked capability file activate the family.
3. Require `scripts/capability-proof.ts`, `scripts/release-evidence.ts`, `.bun-version`, the four documentation files, and the source modules that define CLI commands/help groups, retired verbs, MCP tools, and the connector registry to be tracked regular files in the candidate tree. Resolve product imports through this candidate root; do not accept package resolution to another checkout or dependency copy.
4. Bind actual tracked bytes and executable/symlink modes to the candidate tree, rather than relying only on `git status` normalization. A viable implementation reads the candidate's `ls-tree`/index entries, applies explicit file-count/per-file/total-byte bounds, hashes raw regular-file bytes using the repository's Git object format, and compares mode plus blob OID. Reject symlinks for every producer or observed-surface definition. Ignored third-party dependencies may remain outside the candidate, but no product inventory definition may resolve there.
5. Take the frame before inventory derivation and repeat its `HEAD`, clean/index/untracked state, relevant resolved paths, and raw-byte bindings after derivation. Candidate file hashing must use bounded regular-file reads with the existing final-unchanged pattern. The stated trust scope remains local operator custody; no hostile concurrent-host claim is needed.

Keep the production surface evaluator fixed to its own `CANDIDATE_ROOT`, or reject any other root. Do not retain the current test shape where a minimal foreign Git repository supplies docs and producer stubs while CLI/MCP/connector values silently come from the reviewer's process.

## Required correction 2: derive CLI order from the public help implementation

Delete `CLI_HELP_GROUPS`. Import the existing exported `printRootHelp` through the candidate-bound relative product path and call `printRootHelp(write, COMMANDS)`. Bound the collected line count and line lengths. Build the exact rendered command-row string for each live command using the same width and summary, extract their order from the collected output, and require the result to contain every `COMMANDS` name exactly once with no unknown or duplicate command row. Return that sequence. Any omission, duplicate, ambiguity, or render failure is `surface-unenumerable`.

## Test shape

Keep comparison logic pure: tests may supply a neutral expected inventory to exercise exact schema, disagreement, fail, and unresolved behavior. Test checkout custody separately with bounded ordinary temporary Git repositories. Cover clean exact-head success and refusal of wrong head, unstaged bytes, staged bytes, executable-mode change, untracked source/capability producer, required-path symlink, and product-module resolution outside the candidate. These are ordinary validator fixtures, not vulnerability reproductions.

Add one test that captures `printRootHelp(COMMANDS)` and proves the derived sequence equals the exact unique rendered command-row order. Remove the current hard-coded sequence oracle. If an end-to-end surface test is retained, run it in a bounded child process rooted in a complete exact candidate source fixture; do not mix a foreign candidate root with product globals loaded from the parent checkout.

Remove the blank line at the end of `scripts/go-no-go.test.ts`. Request root's sealed focused test, then typecheck and full pinned verification. Report the final commit/tree and exact changed paths. No merge, publication, capability activation, or release credit follows from this correction alone.
