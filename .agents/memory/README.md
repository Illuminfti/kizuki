# Cross-harness memory

`.agents/memory/` is the one memory directory shared by each coding harness
(Claude Code, Codex, Cursor Agent, and any others configured on this machine).
It is committed with the code. It is working memory for those harnesses. It is
not Kizuki canon, the owner vault, or a product store.

## Rules

- **Read before work.** Start from [MEMORY.md](MEMORY.md).
- **Write after learning.** When you learn a durable rule or fix a recurring
  problem, add a note under `topics/` and add one relative link to the index
  in `MEMORY.md`.
- **Commit with the code.** Ship memory changes in the same commit as the
  change that taught them.
- **Never commit secrets.** Do not write tokens, API keys, passwords, private
  keys, or emails into `.agents/memory/`. A local secret cache belongs in
  `.secret-cache/`, which is gitignored and must not be committed.

## Claude Code local setting

Do not commit `.claude/settings.local.json`. An absolute checkout path is
machine-specific. Create that file locally, and point Claude Code at this
directory:

```json
{
  "autoMemoryDirectory": "<absolute path to this checkout>/.agents/memory"
}
```

Replace the placeholder with the absolute path of this checkout.
`.claude/settings.local.json` and `.agents/memory/.secret-cache/` are listed
in `.gitignore`.
