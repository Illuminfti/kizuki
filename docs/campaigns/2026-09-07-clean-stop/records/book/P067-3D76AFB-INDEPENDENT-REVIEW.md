# P067 corrected Markdown lifecycle independent review

**Verdict: ACCEPT as bounded fixture coverage at `3d76afb63af4bf112b40811e534e97d2fc0fbe9c`.** No blocking findings. The corrected test respects the existing public batching protocol and retains the deletion and identity assertions.

## Exact scope and ownership

- Clone: `PRIVATE_FLEET/code-repos/P067`.
- HEAD: `3d76afb63af4bf112b40811e534e97d2fc0fbe9c`; tree: `d402ff431e595f387dbccb14eb370081e167730c`.
- Parent chain: `3d76afb63af4bf112b40811e534e97d2fc0fbe9c` → `993ff9bbf97f749e4091b8d39850cd0e92b86a0a` → original candidate `b82dbcbb8d390e3e315d2dbea335f93ef57d0954` → base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.
- The complete diff against the base is one new owned file, `packages/connectors/test/fleet-markdown-lifecycle.test.ts`, 177 lines. No production source or existing test changes. The worktree is clean and `git diff --check` passes.
- This independent review read the entire new file, both correction diffs, relevant source and existing coverage, and retained results/logs. It did not execute product/test code or edit candidate files.

## Findings and behavior

The three tests cover ordinary folder selection, a complete mixed edit/deletion lifecycle, and distinct stable file identities for identical text. The selection fixture creates an independent selected folder alongside ordinary unselected siblings, asserting exact selected record IDs and text. The lifecycle fixture keeps one file unchanged, edits another and removes a third; it checks exactly one edit and one tombstone with stable IDs and subjects, no event for the unchanged file, no repeat after draining, and a fresh backfill containing only the remaining live files. Temporary fixtures are registered for awaited cleanup.

The original candidate incorrectly expected a mixed update/deletion sweep in a single `sync` batch. Source inspection of `markdown-folder/index.ts` confirms that a nonempty file page is returned before pending tombstones. The correction accumulates events across successive returned public cursors until the ordinary fixture yields an empty batch. Its small loop guard is followed by an explicit empty-tail assertion, so exhausting the guard cannot silently count as success. It does not decode or rely on private cursor fields, omit the tombstone, loosen exact aggregate IDs, or change production paging. These are meaningful test corrections.

Existing tests separately cover ordinary files, edits, tombstones, paging and subject stability. The new file adds composed selection/reopen and mixed lifecycle assertions across the public connector seam; it does not establish broad source acquisition or account-native qualification. All file creation and removal is restricted to synthetic temporary fixtures.

## Retained execution and identity

Root's sealed corrected run `0926db08d9c74fda8b5c4bccce5103a6` executed `bun test packages/connectors/test/fleet-markdown-lifecycle.test.ts packages/connectors/test/markdown-folder.test.ts packages/connectors/test/markdown-vault-boundary.test.ts`: **23 pass, 0 fail, 96 assertions**, three files, including all three new tests. Full retained logs identify Bun 1.3.14 (`0d9b296a`) and reported test duration 347 ms. Receipt exit status is 0, `stale` is false, termination reason is null, cleanup is confirmed, and observed/retained byte counts agree.

The command uses image `sha256:aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef`, no network, read-only source/dependency mounts and a bounded temporary filesystem. Source is the pinned base plus the owned test only. The complete candidate diff matches that test, and its committed blob, current bytes, frozen bytes and receipt hash agree.

| Artifact | SHA-256 |
| --- | --- |
| Owned test (6,877 bytes) | `802b9dd02d6417198232b959f71ca76cea010fd6d2889315abf9a60938711ba2` |
| Corrected run `result.json` | `f8ce2f121603e8d497c149547c8f5dba78928c6d5c93c7bcfea91b7afb511a1a` |
| Corrected stdout (28 bytes) | `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` |
| Corrected stderr (2,346 bytes) | `5c4a6ab15fbf99a81afd7640870193b68364cd4cd671de8f8280ba03c2805b88` |

Before and after identities are equal. Independently recomputed canonical identity digest: `34820b31eccb964214f7591549f0e305a306491413422e9060b666de98ec5874`. Corrected evidence remains under `PRIVATE_FLEET/test-controller/runs/0926db08d9c74fda8b5c4bccce5103a6/`.

The original failed run `ff6f91e6d65a4702ada8887aa06c66b9` remains retained and still reports **22 pass, 1 fail, 80 assertions**, exit 1, at `b82dbcbb8d390e3e315d2dbea335f93ef57d0954`. Its independently rehashed result is `15775a8e273fae381cab8f1835d4036ce29a3f723ff5b7b92c2b654cf7d88b90`; stderr is `fa97ba435cd3c244f9857ddaab21ade9e1e2cecc091699955db6e521b6b1dd49`. These match `P067-P069-FAILED-TEST-REVIEW.json`. The fresh corrected receipt does not rewrite that failure.

Full package/type/repository checks and merged-artifact qualification remain separate. No live connector or release claim follows from these fixture results.
