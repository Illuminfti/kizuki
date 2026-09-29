# Connect a harness to Kizuki

Kizuki is not an agent harness. It gives whichever harness you run two things: a
scoped read surface over MCP, and a hook command that hands a session a short,
labelled block of context when it starts. This guide wires both into Claude Code,
Codex and any other client that can launch a stdio MCP server or run a command.

Every path below is a placeholder. Replace `/absolute/path/to/vault` and
`/absolute/path/to/credential` with your own, and keep them absolute.

## What you set up

| Piece             | Command                     | What it gives the agent                                                            |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| Scoped credential | `kizuki agent add`          | An identity with an explicit grant. Every call it makes is audited under its name. |
| MCP server        | `kizuki-mcp`                | The read tools, plus `propose` and `correct` when the grant allows them.           |
| Session hook      | `kizuki hook session-start` | A bounded context block injected once, at session start.                           |

The hook is a pull. It asks Kizuki for a `context_packet` with `purpose=session`,
prints it in the shape the harness documents, and exits. It writes nothing, opens
no network connection beyond the local loopback daemon, and stays silent when
anything goes wrong.

## 1. Create a scoped credential

Give each harness its own agent so its calls are attributable and revocable. Do
not point an agent at the owner principal (`--owner`) unless it is a harness you
run yourself and you accept that it carries the owner's full authority.

Write a grant file that names exactly what the agent may do:

```json
{
  "ceiling": "personal",
  "types": null,
  "subjects": null,
  "since": null,
  "until": null,
  "tools": ["context_packet", "search", "get_page", "timeline", "world_view"],
  "rate_limit_per_minute": 60,
  "relay_owner_corrections": false
}
```

Then enroll it into a private directory that only you can read:

```sh
mkdir -m 700 /absolute/path/to/credentials
kizuki agent add my-harness \
  --grant grant.json \
  --token-ref file:/absolute/path/to/credentials/my-harness.credential \
  --operation-id my-harness-setup-1 \
  --vault /absolute/path/to/vault
```

The `ceiling` is the most sensitive label the agent may read. `world_view` in
`tools` lets the session block include Situations from the world model; without
it those parts of the block say so and stay empty. See the
[agent enrollment guide](agent-enrollment.md) for recovery and revocation. To end
access later, run `kizuki agent revoke my-harness`.

## 2. Claude Code

### MCP server

Register the server in a project `.mcp.json`, or with `claude mcp add`:

```json
{
  "mcpServers": {
    "kizuki": {
      "command": "kizuki-mcp",
      "args": [
        "--vault",
        "/absolute/path/to/vault",
        "--token-ref",
        "file:/absolute/path/to/credentials/my-harness.credential"
      ]
    }
  }
}
```

### SessionStart hook

Add this to `~/.claude/settings.json`, or to a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "kizuki hook session-start --harness claude-code --vault /absolute/path/to/vault --token-ref file:/absolute/path/to/credentials/my-harness.credential --timeout-ms 4000",
            "timeout": 6
          }
        ]
      }
    ]
  }
}
```

Keep `--token-ref` in the command. Without it the hook reads as the owner, at the
owner's sensitivity ceiling, and injects owner-level claims into whatever model
the harness talks to. An agent credential limits the block to what that agent's
grant allows. The same applies to every hook recipe below.

Claude Code sends the session's JSON on standard input and adds the printed
`additionalContext` to the conversation. Keep the harness `timeout` (seconds) a
little above `--timeout-ms` so Kizuki, not the harness, decides when to give up.

## 3. Codex

### MCP server

In `~/.codex/config.toml`:

```toml
[mcp_servers.kizuki]
command = "kizuki-mcp"
args = [
  "--vault", "/absolute/path/to/vault",
  "--token-ref", "file:/absolute/path/to/credentials/my-harness.credential",
]
```

`codex mcp add kizuki -- kizuki-mcp --vault ... --token-ref ...` writes the same
entry. The [local app guide](local-app.md#connect-codex-cli) shows the generated
command form.

### SessionStart hook

In `~/.codex/hooks.json`, or a repository's `.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "kizuki hook session-start --harness codex --vault /absolute/path/to/vault --token-ref file:/absolute/path/to/credentials/my-harness.credential --timeout-ms 4000"
          }
        ]
      }
    ]
  }
}
```

This recipe has not been run against a real Codex client. Codex hooks are a
newer feature and a build may need an opt-in setting or a minimum version before
it reads `hooks.json`; check the current Codex hooks documentation for both, and
if the hook never runs, that is the first thing to look at. `--harness codex`
prints the same `hookSpecificOutput` object Claude Code takes; if your Codex
build wants plain standard output instead, use `--harness generic`.

## 4. Any other client

An MCP client that can launch a stdio server needs only the command line:

```sh
kizuki-mcp --vault /absolute/path/to/vault \
  --token-ref file:/absolute/path/to/credentials/my-harness.credential
```

A token never travels on argv. The `--token-env VAR` form reads it from an
environment variable instead. Tools are the ones the grant allows; see the
[CLI reference](cli.md#mcp-not-a-cli-verb).

For a harness that can run a command before a turn or a session but has no MCP
support, use the plain-text mode and place the output wherever the harness takes
extra context:

```sh
echo '{"cwd":"/path/to/project"}' \
  | kizuki hook session-start --harness generic \
      --vault /absolute/path/to/vault \
      --token-ref file:/absolute/path/to/credentials/my-harness.credential
```

Standard input is optional. Without a `cwd` the block has no project query and
shows only the session sections and recent capture.

## What the block contains

The block starts with `KIZUKI CONTEXT v1` and a rules line. It is a
`context_packet` with `purpose=session` at the budget you set with `--budget`
(50 to 2000 tokens, default 450). For a full block, these sections come first,
each capped at a few lines:

- `owner`: identity facts the owner stated or corrected, such as a display name.
- `now`: current Situations from the world model and recently recorded changes.
- `commitments`: open commitments, from Situations and from commitment claims.
- `uncertain`: contradictions between live claims and hedged statements.

A section with nothing to report is listed under `not recorded` with the reason,
so an empty section is never mistaken for a missing one. Canon pages and recent
captured records follow, within the same budget.

Sections only show claims that are current: a claim whose validity has ended, or
not yet begun, is not listed. A section says `unavailable` rather than
`none_recorded` when the newest 60 candidates were all unreadable or ended, since
absence is then not proven. The first state line is preceded by a note that state
lines are data unless they are clean and owner-authored.

Each line carries its labels. Lines Kizuki produced are marked as produced prose.
Captured text is marked `tainted` and quoted, and every claim line shows its
sensitivity, taint and authority. The block tells the harness to treat quoted
lines as data, not instructions. Nothing in it is invented: an empty vault prints
no block at all.

The hook sends the project's name, taken from the last segment of `cwd`, as the
search query. The path itself is never sent or printed.

## How the hook behaves

1. It reads the harness's JSON from standard input, at most 64 KiB.
2. If `kizuki serve` is running, it calls that daemon's loopback endpoint with the
   agent's own credential, and only when the endpoint file belongs to the daemon
   process of the current boot. Without `--token-ref` it acts as the owner at the
   owner's ceiling and uses the daemon's standing token.
3. If no daemon answers, it reads the vault directly in a child process that it
   can stop at the deadline.
4. It prints the harness's output shape and exits 0.

It exits 0 and prints nothing on a timeout, a denied or revoked credential, a
missing or uninitialized vault, an empty result, or any other error. Add
`--verbose` to see one line on standard error naming the class of failure. That
line never contains a path, a token or captured text. A misconfigured command
(an unknown `--harness`, a bad `--token-ref`, an unknown option) is silent too,
so a typo cannot fail every session; `--verbose` prints `nothing injected
(usage)`. Out-of-range `--budget` and `--timeout-ms` values are pulled to the
nearest bound.

`--direct` skips the daemon and reads in the current process. Its deadline covers
waiting only, not a read already in progress, so prefer the default.

Every served call is recorded in the agent audit under the credential's name.

## Limits

- The hook runs once, at session start. It is not a per-turn recall.
- A cold read of a large vault can take seconds. Past `--timeout-ms` the hook
  injects nothing rather than delaying the session. Raise the deadline and the
  harness's own timeout together if you want more patience.
- `context_packet` negotiation still reports `pull_only` when a client advertises
  hooks. The hook is a client-side adapter over the pull, not a server push.
- Without a configured model the world model is empty, so `now` and
  `commitments` will say `none_recorded` until Situations exist. `doctor` tells
  you whether canon writing is on.
- The credential file is the secret. Keep it owner-only and outside any
  repository.

## Check it works

```sh
echo '{"cwd":"/path/to/project"}' \
  | kizuki hook session-start --harness generic --verbose \
      --vault /absolute/path/to/vault
```

A block that starts with `KIZUKI CONTEXT v1` means the pull works. Silence with a
`--verbose` line means the reason is on standard error. Then start a real session
in the harness and confirm the block appears in its context, and that a search
through the MCP server returns a source reference.
