# P004 shared evidence reader independent review

Verdict: **NEEDS CORRECTION** for `ce8395792a333ad760594f92f1198639e0936445`. The v3 reader is fail closed for malformed references, preserves the old evidence paths, keeps every unimplemented family without credit, and correctly leaves the overall report at `NO-GO`. Two release-integrity defects and one sealed-runtime import failure prevent acceptance of the implemented surface family.

The reviewed commit has sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and tree `40e3d68d494d5922c88a21f67a1e3f6e1a7747e2`. The private P004 clone was clean: its index and tracked working tree matched `HEAD`, and it had no untracked paths. The complete diff changes only `scripts/go-no-go.ts`, `scripts/go-no-go.test.ts`, and the new `scripts/release-evidence.ts`. Their SHA-256 digests are `395ac8e4b3847f7c5324ba236b7cde4ec0e34a7770ed8de611c3581785f708c5`, `e347b2df2a500c74c5642dc41e7e1bfe425156be0cd6dbe8aed3e9c03d13542b`, and `c8f225866a1e86b14fe84bb5b815f9ccf31a8b703930f6a9149e724d35cf6319`. The frozen handoff SHA-256 is `e62ce7b02fb2a6afca7602913a256f7acde9f690f6bfb71dc0becaf2caaa26dc`.

## Findings

### P1: a surface PASS is not bound to the claimed commit tree

`scripts/release-evidence.ts:221-234` hashes files through ordinary working-tree reads, while `checkoutSha` only runs `git rev-parse HEAD`. `expectedSurfaceInventory` then combines those live bytes with runtime imports and returns the unchanged `HEAD` at `scripts/release-evidence.ts:266-284`. The comparison at lines 344-384 therefore proves that a receipt agrees with the current process and filesystem, but it never proves those bytes and imported product definitions belong to the claimed commit.

A dirty or staged producer, documentation file, help/registry/tool module, or an untracked `scripts/capability-proof.ts` can be used to produce the expected values while the checkout still reports the old `HEAD`. A committed symlink can also make the ordinary reads hash target contents instead of the Git blob. This violates the frozen requirement to compute from “actual candidate-tree bytes” and derive every expected value from the “exact candidate checkout” (`P004-WORKER-HANDOFF.md:128-132,158-163`). It also weakens the later verifier seam: mere presence of an uncommitted capability file activates receipt consumption in `scripts/go-no-go.ts:136-150`.

Require the evaluator's executing repository root, `HEAD`, index, tracked bytes and modes, and relevant module resolution to match the claimed candidate before and after inventory derivation. Reject staged, dirty and untracked source. Require the capability producer and every directly observed product definition to be tracked regular files at that commit. Use bounded stable reads for hashed candidate files. The correction handoff gives a concrete strategy.

### P1: the CLI inventory validates a copied list instead of live help output

`scripts/release-evidence.ts:57-61` duplicates the private `GROUPS` constant from `packages/cli/src/help.ts:7-15`; `cliVerbSequence` at lines 237-244 combines that duplicate with `COMMANDS`. A change to the real help grouping or order can therefore leave both P006's producer and P004's validator agreeing on the stale duplicate while public `kizuki --help` differs. The test at `scripts/go-no-go.test.ts:531-542` asserts the duplicate's current literal value and cannot detect this divergence.

The frozen contract requires the ordered live sequence from `help.ts` and independently recomputed disagreement (`P004-WORKER-HANDOFF.md:140-143,154-163`). Remove `CLI_HELP_GROUPS`. Call the exported `printRootHelp` with the actual `COMMANDS`, collect its bounded output, extract exact command rows against the bounded known command set, and fail unless every live command appears exactly once. This stays within P004's owned files and leaves P006's `help.ts` path untouched.

### P1: the new module cannot load in the sealed root-script environment

`scripts/release-evidence.ts:7-8` imports `@kizuki/connectors` and `@kizuki/mcp`. The repository root package does not declare either workspace package as a dependency, and the accepted sealed runner mounts dependencies without inventing root workspace aliases. Root's exact candidate run `cb9fb1aa075e41698864945a4cc02685` failed before tests with `Cannot find module '@kizuki/connectors' from '/repo/scripts/release-evidence.ts'`: 0 pass, 1 fail, exit 1. The input remained unchanged and `stale` is false.

Use repository-relative source imports, as the existing root scripts do. Import the connector registry from `../packages/connectors/src/index` and MCP tool definition from `../packages/mcp/src/index` (and `printRootHelp` from its relative CLI source path). Their package-local dependency resolution remains available through the sealed mounts. This also makes the product-module paths explicit for the candidate-custody check. The retained receipt is `PRIVATE_FLEET/test-controller/runs/cb9fb1aa075e41698864945a4cc02685/result.json`; stderr SHA-256 is `26ff22b71b358ae565544a694de61f83dec12233291430790a6a1f8ea724ef66`.

## Completion hygiene and scope

`git diff --check f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7...HEAD` is currently nonzero because `scripts/go-no-go.test.ts:586` adds a blank line at EOF. Remove it in the correction.

Static review found no release credit granted to reserved families and no unsafe fixture requiring quarantine. The added cases use temporary local files and one synthetic local Git repository; they contain no network, account, model, credential, private-data, exploit, race, or unbounded workload. This reviewer did not execute a test or product command. Root's retained sealed run failed during module loading and supplies no passing test credit. Typecheck, a corrected focused run, full verification, merge, capability-producer acceptance, and release acceptance remain separate gates.

Receipt: `P004-CE83957-INDEPENDENT-REVIEW.json`. Corrective brief: `P004-CE83957-CORRECTIVE-HANDOFF.md`.
