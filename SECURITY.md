# Security policy

## Scope and status

Kizuki is pre-alpha. There are no packaged releases, no compiled binary, and
no install path. The supported version is the head of the default branch;
older commits get no fixes.

Kizuki is a single-owner local product. It runs on the owner's machine, under
the owner's account, against a vault the owner controls.

The interim host-trust stance is deliberate and unflattering: canon Markdown,
ledger text and the SQLite database are plaintext on the owner's disk, so any
process that can read those files can read the owner's life. Connection state
files are written mode 0600 inside a mode 0700 directory, which stops other
local accounts but not the owner's own account. There is no encryption at
rest. A versioned key-identifier seam is reserved by the architecture, and no
schema field for it exists yet.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, and do not describe
one in a pull request, a commit message, or any other public thread.

GitHub private vulnerability reporting is the intended channel: the
repository's **Security** tab, then **Report a vulnerability**, which opens a
draft advisory visible only to the maintainers.

That feature is not enabled on this repository yet. Checked 2026-09-02: the
repository is private and the advisory endpoints answer 404, so the Security
tab offers no reporting button. Until a maintainer turns it on (repository
Settings, then Code security), there is no private reporting channel here. If
you have collaborator access, open a draft advisory yourself. Otherwise hold
the details and wait; publishing them elsewhere is worse than waiting.

Include, when you can:

- the affected file, command, or contract;
- a reproduction that uses synthetic data;
- the impact you can demonstrate, not the impact you can imagine;
- the commit SHA you tested.

Never include captured personal text, real credentials or tokens, a real
vault, or any path from a real machine. A report that leaks the reporter's own
data is a second incident.

No bounty is offered and no response time is promised. Acknowledgement and fix
status appear in the advisory thread. A fix lands with a test that fails
without it, and the advisory records what changed. Credit on request.

## Assets and trust boundaries

Trusted:

- the owner, their terminal, and the OS account Kizuki runs under;
- other processes running as that same OS account, under the interim stance
  above.

Protected:

- the vault directory: canon Markdown, `archive/`, and the `.kizuki/` control
  directory;
- the SQLite database `kizuki.db`: events, purge receipts, proposals,
  promotion receipts, checkpoints, connections, canon holds, agents, grants,
  audit rows, `search_docs`, and `graph_edges`;
- connection state files under `<vault>/.kizuki/connections/`;
- agent tokens, of which only salt-free SHA-256 hashes are stored.

Hostile by contract:

- captured text, filenames, archives, metadata, and provider responses
  (architecture invariant 7);
- an owner-configured model endpoint and its responses;
- any agent or harness holding a token, which is bounded by its grant rather
  than trusted by its prompt.

## Threat model

| Threat                 | What an attacker can do                                                                                              | Control today                                                                                                                                                                                                                                            | Proof                                                                                                                                                                                                                                                                                                                  | Not yet built                                                                                                                     | Residual risk                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Host trust             | Read canon, ledger text, and SQLite directly from disk                                                               | Connection state is written 0600 inside a 0700 directory and never enters SQLite                                                                                                                                                                         | `packages/core/src/ledger/connection-state.ts::0o700`, `packages/core/test/connections.test.ts::raw SQLite never contains state bytes`                                                                                                                                                                                 | Encryption at rest; the versioned key-identifier seam is reserved in the architecture with no schema field                        | Total, for anything that can read the owner's files. Kizuki does not defend against a compromised account                              |
| Prompt injection       | Smuggle instructions through captured messages, filenames, or provider responses so an agent treats them as commands | Captured text stays quoted evidence: producers keep it inside a blockquote, the review interface strips control sequences, and unlabeled items are served to nobody                                                                                      | `packages/core/test/staging/producers.test.ts::captured text cannot escape the quote into canon prose`, `packages/tui/test/ansi.test.ts::strips escape sequences and control characters, keeps newlines`, `packages/core/test/agents/authorization.test.ts::denies unlabeled items to every grant including the owner` | The serving envelope that stamps quoted chunks `tainted: true` is accepted design, not code; see the architecture Serving section | A harness may still obey text Kizuki correctly labelled as evidence. Labelling is the control; obedience is the harness's problem      |
| Agent overreach        | Use a token to read beyond its scope, write canon, or hide the attempt                                               | Tokens are stored only as hashes and compared in constant time; every grant carries a sensitivity ceiling, type, subject, time, tool and rate bound; every call is audited; the only write is `propose`                                                  | `packages/core/test/agents/identity.test.ts::never stores the token in the database file`, `packages/core/test/agents/audit.test.ts::allows three audited calls at limit three and denies the fourth`, `packages/core/test/staging/invariants.test.ts::the promote path is the only door to canon`                     | Bounded autonomy modes, and a serving surface that would expose these grants over MCP                                             | A harness that is legitimately served private canon can leak it. A grant bounds what an agent is served, never what it does afterwards |
| Connector supply chain | Ship a connector or dependency that exfiltrates the vault                                                            | The registry is in-tree and curated, every entry passes a shared conformance suite, `@kizuki/core` has no runtime dependency, the lockfile is frozen in CI, and CI scans every source file for network surface and every manifest for telemetry packages | `packages/connectors/test/conformance.test.ts::all registry connectors pass conformance`, `run: bun scripts/verify-network.ts`, `run: bash scripts/verify.sh`                                                                                                                                                          | Compiled-in project credentials with placeholder refusal, and secret scanning in CI                                               | A dependency added without the evaluation record in the upstream policy would bypass the intent of the scan while passing it           |
| Credential custody     | Recover a token or password from the database, a log, or a fixture                                                   | Credentials exist only as `env:` and `file:` references; connector state is an opaque envelope enforced by SQLite CHECK constraints; an agent token is printed once and never again                                                                      | `packages/core/src/contracts/secret-ref.ts::parseSecretRef`, `packages/core/test/migration.test.ts::v2 keys connector state by source and carries promotion hashes`, `packages/core/test/connections.test.ts::forged handles and malformed rows fail closed`                                                           | An OS keychain resolver as an optional package                                                                                    | A secret the owner pastes into canon by hand is canon, and Kizuki will faithfully keep it                                              |
| Deletion and exit      | Leave copies behind after the owner deletes a subject, or trap the owner's data in the product                       | Purge is subject-keyed physical deletion plus a receipt; it withdraws proposals, deletes derived rows, and holds every affected canon page until the owner promotes the redaction; `export` copies vault and ledger                                      | `packages/core/test/purge.test.ts::files one purge review and hold without changing promoted canon`, `packages/core/test/purge.test.ts::removes matching derived search and graph rows through real schemas`, `packages/core/test/export.test.ts::copies ordinary vault files but excludes the control directory`      | A CLI purge verb; purge is library code today                                                                                     | A held page stays on disk until the owner acts. Holding is honest, but it is not deletion                                              |
| Resource exhaustion    | Feed an oversized record, a pathological query, or a dense graph to stall the process                                | Connection state is capped, graph fan-out is bounded and reports truncation, timeline and search apply limits after a stable ordering, and previews are byte-bounded                                                                                     | `packages/core/src/ledger/connection-state.ts::MAX_CONNECTION_STATE_BYTES`, `packages/core/test/graph/graph.test.ts::bounds fan-out and reports truncation`, `packages/core/test/query/timeline.test.ts::collapses preview whitespace and bounds it to 160 characters`                                                 | Global time and memory budgets per call                                                                                           | A very large vault can still make a single query slow. Slow is not a denial of the owner's own machine, but it is not bounded either   |

## Out of scope

- An attacker who already has the owner's OS account, or root on the machine.
- Physical access to the disk, or a backup the owner copied elsewhere.
- A harness acting within a grant the owner deliberately issued.
- Provider-side compromise a read-only connector cannot observe.
- The owner pasting a secret into canon by hand.
- Anything about a hosted or multi-tenant deployment. There is none.

## What CI enforces

`bun run verify` is the gate, and it fails closed:

- a frozen install, so the lockfile decides what is present;
- strict typecheck and the full test suite;
- the policy tests in `scripts/verify-policy.test.sh`;
- an AST scan for network surface anywhere under `packages/`;
- a grep for telemetry packages in every tracked manifest;
- a denylist of private identifiers over every tracked text file, every
  tracked path, and every reachable commit message;
- the attribution validator, which pins the exact spelling and the exact
  canonical URL of every credited upstream;
- the documentation gate in `scripts/verify-docs.ts`, which is what keeps the
  proof column above from rotting.

The invariants themselves are tests, not prose:
`packages/core/test/staging/invariants.test.ts` reads the source tree and
fails if any module other than the owner promote path can write canon.

## Secure development rules

- Fixtures are synthetic. Never a real message, handle, host, path, or vault.
- No plaintext credential ever reaches SQLite, a log, a fixture, a snapshot,
  or Markdown.
- Captured text never appears in an error message; errors name the record, not
  its contents.
- Diagnostics go to stderr so that piping a command's output cannot leak them
  into a file the owner did not expect.
- Every denial path has a test that proves the denial, not only the allowance.
- A new dependency needs the evaluation record in
  [docs/upstream-policy.md](docs/upstream-policy.md) before it is added.

Related reading: [docs/architecture.md](docs/architecture.md) for the ten
invariants, [docs/connectors.md](docs/connectors.md) for what each connector
captures, [AGENTS.md](AGENTS.md) for the policy every contributor and agent
works under, and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.
