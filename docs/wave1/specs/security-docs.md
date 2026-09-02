> **VOID as written, 2026-09-02.** Owner-gated canon, `kizuki review` /
> `promote` as the daily path, and the tension paragraph are dead. Reissue
> against `rfcs/0002-autonomous-canon.md` and `docs/CURRENT.md`.

# Lane: security-docs — README rewrite, SECURITY.md, CONTRIBUTING.md, docs/connectors.md, and a docs gate that keeps every claim traceable

Reconciled against `main` @ `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; bun 1.3.14 locally, CI pins 1.3.10). Every path, symbol, table and
test title below was grepped on that revision; anything not on main is marked
NEW with its intended location. The three product documents this lane lands
exist only on `origin/codex/product-context` (draft PR #3, head `76868f7`).

Packages and files: root `README.md` (rewrite), NEW `SECURITY.md`, NEW
`CONTRIBUTING.md`, NEW `docs/connectors.md`, NEW
`.github/PULL_REQUEST_TEMPLATE.md`, landed `docs/product-context.md`,
`docs/lifeos-capability-gap.md`, `docs/upstream-policy.md`; NEW
`scripts/verify-docs.ts` + `scripts/markdown.ts` + `scripts/verify-docs.test.ts`;
one line in `scripts/verify.sh` and one script in the root `package.json`; NEW
`packages/connectors/test/docs.test.ts`; NEW `packages/cli/test/readme.test.ts`.
No product code changes anywhere under `packages/*/src`.

Read first, in order: `CONVENTIONS.md`; `docs/architecture.md` (all ten
invariants; the "Security" paragraph names SECURITY.md as a shipped artifact
that does not exist on main, which this lane corrects); `rfcs/0000-constraints.md`;
`rfcs/0001-deep-model-arbitration.md` (what is accepted, adapted, deferred,
rejected); `AGENTS.md` (the three-way status vocabulary: implemented /
accepted design / direction; "Documentation and RFCs" verification;
"Data, privacy, and external research"); `.agents/skills/documentation-accuracy/SKILL.md`,
`threat-modeling/SKILL.md`, `security-privacy-review/SKILL.md`,
`dependency-evaluation/SKILL.md`, `connector-work/SKILL.md`; `scripts/verify.sh`
(the attribution and identifier gates you must pass; the regexes are
split-quoted there on purpose, never spell them out), `scripts/verify-attribution.ts`,
`scripts/verify-policy.test.sh`, `scripts/verify-network.ts`; the three
documents on the branch (`git show origin/codex/product-context:docs/<name>`);
`packages/core/src/index.ts` (the public surface you may cite), every
`packages/*/AGENTS.md`, `packages/connectors/src/{registry,conformance}.ts` and
the three connector manifests (`markdown-folder/index.ts`,
`import-chatgpt/index.ts`, `import-claude/index.ts`), the test files named in
§3 and §4 (you cite their titles), and the sibling specs in this directory
whose README edits you fold in (§2.6). Design references in
`workspace/kizuki-plan/ARCHITECTURE.md`: §0 (invariants), §1 (layout on
disk), §3.1–3.2 (connectors, conformance, sign-in not setup), §8 (serving),
§9 (proactive rails), §10 (security: the SECURITY.md content list), §11 (repo
layout), §12 (testing and CI), §13 (deferred to RFCs).

## Already on main (build on it; do not restate it elsewhere)

- `README.md`: 32 lines; four pledges; "Status: pre-alpha, nothing installable";
  one sentence claiming zero runtime dependencies and zero network calls.
  Several sibling lanes replace that sentence (§2.6).
- `docs/` holds only `architecture.md`. No `SECURITY.md`, `CONTRIBUTING.md`,
  `docs/connectors.md`, PR template, or docs gate exists.
- `scripts/verify.sh` (`bun run verify`): frozen install, typecheck, tests,
  `verify-policy.test.sh`, the network AST scan, the phone-home dependency grep
  over tracked `package.json` files, the forbidden-identifier grep over tracked
  text, tracked paths and every reachable commit message, and the attribution
  validator over `README.md` and `docs/upstream-policy.md` (exact spelling
  outside URLs; the exact delimited canonical URL inside them; the attributed
  identifier may appear in no other tracked file).
- Connector registry: exactly three entries, all `auth_modes: ["none"]`,
  `emits_sensitivity_hint: false`, `required_secrets: []`:
  `kizuki.markdown-folder` (`kinds: ["file"]`, backfill/sync/tombstones/fixture
  true, purge false), `kizuki.import-chatgpt` and `kizuki.import-claude`
  (`kinds: ["message"]`, backfill/sync/fixture true, tombstones/purge false).
  Constructors validate `config.path` as a string and touch no disk
  (`packages/connectors/src/util.ts` `requirePathConfig`), so `manifest()` is
  readable from a test without fixtures on disk.
- `AGENTS.md` "Start here" already lists `docs/product-context.md when it
exists on the checked-out revision`; landing it makes that line true.
- The repository's GitHub owner segment matches the identifier denylist.
  Consequence for every file in this lane: never write this repository's own
  URL, clone command, or `owner/repo` slug into a tracked file or a commit
  message. Refer to "this repository" and use relative links.

## Objective

A stranger who lands on the repository can tell in one screen what runs, what
is decided, and what is only direction; can find the threat model and how to
report a vulnerability privately; can contribute without tripping the gates;
and can read, per connector, exactly what is captured and what is not. Every
sentence under "What runs today" points at a test or a command, and a gate
(`scripts/verify-docs.ts`, run by `scripts/verify.sh`) fails CI when a cited
test disappears, a link breaks, a Mermaid fence is malformed, a registry entry
has no connector doc row, or a CLI verb has no README row.

## Non-goals

No CLI verbs, no product code, no new SQLite tables, no changes to
`docs/architecture.md`, `rfcs/*`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or
`.github/workflows/ci.yml` (ci-hardening owns CI). No per-package READMEs for
connectors (their lanes own them; `docs/connectors.md` links to them when they
exist). No release notes, changelog, code of conduct, DCO/CLA, issue templates,
badges, screenshots, or hosted docs site. No edits to the three landed product
documents beyond what §1 allows. No naming of any person, host, or the
maintainer's other products; synthetic names only (`ada`, `grace`, `linus`,
`acme`).

## Runtime dependencies

None. `scripts/verify-docs.ts` uses `node:fs`, `node:path` and
`Bun.spawnSync(["git", "ls-files", "-z"])`; no Markdown or Mermaid library
(a full Mermaid parser is a dependency for nothing this lane needs; §6 defines
the bounded structural checks instead). `@kizuki/core` stays dependency-free.

## 1. Land the product documents

Cherry-pick the three commits from `origin/codex/product-context`
(`f8ed535` product context, `684eae8` capability-gap audit, `76868f7`
upstream policy) onto the lane branch, in that order, without `-x` and
without editing the files:

```
git cherry-pick f8ed535 684eae8 76868f7
git diff --quiet origin/codex/product-context -- docs/product-context.md docs/lifeos-capability-gap.md docs/upstream-policy.md && echo IDENTICAL
```

Their subjects and bodies pass the identifier denylist (checked 2026-09-02;
`bash scripts/verify.sh` re-checks every reachable commit message). Read all
three before writing a line of README: the README's "Direction" section is a
compression of `docs/product-context.md`, never an extension of it; the
"Explicit non-decisions" list there is binding on the README (invent no
threshold, no federation protocol, no delivery channel).

`docs/lifeos-capability-gap.md` is a dated snapshot ("Audit date: 2026-09-01")
whose "Kizuki gap" column goes stale as lanes land. The README links it as a
dated audit and never cites it for current status; current status lives only
in the README tables with proof tokens (§2.2). `docs/upstream-policy.md` is
the attribution authority: its sixth registry row (the personal-knowledge
reference project evaluated at package 0.9.1) carries the only spelling and
the only URL of that project's name that the attribution validator accepts.
When the README credits it (§2.4 "Ecosystem credit"), copy both verbatim from
that row; the gate `assert_exact_attribution_spelling README.md docs/upstream-policy.md`
in `scripts/verify.sh` is the proof.

Draft PR #3 is superseded once this lane's PR is open; say so in the lane
report and leave PR #3 for the owner to close (AGENTS.md: never close another
agent's pull request).

## 2. README.md

### 2.1 Shape (pinned; `scripts/verify-docs.ts` enforces the three status headings)

Title `# Kizuki`, the kanji line, one paragraph: "Your life, queryable as a
CLI and MCP. Local-first; not a harness; hosts no agents." Then exactly these
H2 sections, in this order:

1. `## Pledges` — the four existing pledges, each one sentence plus a proof
   token (§2.2). The zero-phone-home pledge sentence is computed from the
   merged tree (§2.6), never copied from an older README.
2. `## How it works` — diagrams D1 and D2 (§2.3) with one paragraph each, and
   the tension paragraph: owner-gated canon and no silent canon merges stay
   in force for high-impact truth; beneath canon a reversible working model
   (RFC 0001's `wm_*` layer, accepted, not on main) may update automatically;
   the boundary between the two is an explicit non-decision
   (`docs/product-context.md`, "The current design tension").
3. `## What runs today` — tables only (§2.4), every table with a `Proof`
   column; ends with the stranger loop and its subsections.
4. `## Accepted design` — bullets citing `docs/architecture.md` sections and
   the RFCs; nothing here claims to run.
5. `## Direction` — bullets compressed from `docs/product-context.md`; every
   bullet ends with the word `(direction)`.
6. `## Connectors` — three sentences and a link to `docs/connectors.md`; names
   Composio and the WhatsApp Business API as deferred.
7. `## Security` — one line per threat (host trust, prompt injection, agent
   overreach, connector supply chain), each ending with the invariant number,
   then a link to `SECURITY.md` and the private-reporting sentence.
8. `## Ecosystem credit` — the table in §2.4.
9. `## Contributing` — three lines: `bun run verify` is the gate, AGENTS.md is
   the policy, link `CONTRIBUTING.md`.
10. `## License` — MIT, link `LICENSE`.

Status line under the title: `Pre-alpha. No packaged releases yet; build a
single-file binary from source (see "Build a binary")` when ci-hardening has
landed, else `Pre-alpha. No packaged releases yet; run from source with Bun
(see "Try it")`. Keep the whole file under 400 lines. Prose is plain: no
marketing adjectives, no "seamless", no promises about speed or scale.

### 2.2 Proof tokens (the traceability contract)

Every table under `## What runs today`, and every table anywhere in the
checked files whose header contains a `Proof` cell, must fill that cell with
one or more backticked tokens. Grammar, checked by `scripts/verify-docs.ts`:

```
proof-cell   := token ( ("," | " ") token )*
token        := "`" ( file-proof | run-proof ) "`"
file-proof   := tracked-path [ "::" needle ]
run-proof    := "run: " command
tracked-path := a path in `git ls-files`
needle       := a literal substring that must occur in the file (use the exact test() or describe() title)
command      := "bun run <script>"          where <script> is a key of the root package.json "scripts"
              | "bash scripts/<file>"       where scripts/<file> is tracked
              | "bun scripts/<file> ..."    where scripts/<file> is tracked
              | "bun packages/<pkg>/src/<file> ..."   where that file is tracked
```

A claim without a proof token is not written. A proof that names a whole test
file is acceptable only for a table row that summarizes a module; a row that
asserts one behavior names the test title. Examples that resolve on main today
(use them; add rows for what has landed by merge time):

| Row                                                        | Proof                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing writes canon except owner promote                  | `packages/core/test/staging/invariants.test.ts::the promote path is the only door to canon`                                                                                                                      |
| Unlabeled pages and events are withheld from everyone      | `packages/core/test/agents/authorization.test.ts::denies unlabeled items to every grant including the owner`, `packages/core/test/search/search.test.ts::personal ceiling hides private and unlabeled documents` |
| Connector state bytes never reach SQLite                   | `packages/core/test/connections.test.ts::raw SQLite never contains state bytes`                                                                                                                                  |
| Agent tokens are stored only as hashes                     | `packages/core/test/agents/identity.test.ts::never stores the token in the database file`                                                                                                                        |
| Audit rows carry hashed query shapes, never the query      | `packages/core/test/agents/audit.test.ts::stores only the query shape and round-trips served and denied`                                                                                                         |
| Captured text cannot escape its quote into canon prose     | `packages/core/test/staging/producers.test.ts::captured text cannot escape the quote into canon prose`                                                                                                           |
| Purge cascades to proposals, derived rows, and canon holds | `packages/core/test/purge.test.ts::files one purge review and hold without changing promoted canon`, `packages/core/test/purge.test.ts::removes matching derived search and graph rows through real schemas`     |
| Derived layers rebuild from ledger + canon                 | `packages/core/test/derived.test.ts::restores identical counts after every derived table is deleted`                                                                                                             |
| Export copies the vault and excludes `.kizuki/`            | `packages/core/test/export.test.ts::copies ordinary vault files but excludes the control directory`                                                                                                              |
| `.kizuki/` is gitignored by `init`                         | `packages/core/test/vault.test.ts::self-ignores the database directory in Git`                                                                                                                                   |
| Every registry connector passes conformance                | `packages/connectors/test/conformance.test.ts::all registry connectors pass conformance`                                                                                                                         |
| No network call anywhere under `packages/`                 | `run: bun run scripts/verify-network.ts`, `scripts/verify-network.test.ts`                                                                                                                                       |
| No telemetry SDK in any manifest                           | `scripts/verify.sh::phone-home dependency`                                                                                                                                                                       |
| Schema migrations v1→v2 keep data                          | `packages/core/test/migration.test.ts::upgrades v1 without losing events or promotion hashes`                                                                                                                    |

### 2.3 Diagrams (four compact Mermaid fences; GitHub-renderable)

Constraints for every fence: first line is `flowchart LR` or `flowchart TB`;
at most 14 nodes; every label containing `(`, `)`, `[`, `:` or a quote is
double-quoted (`A["Ledger (append-only)"]`); no `%%{init}` directive, no
`click`/`href`, no HTML in labels; status is carried by `subgraph` titles
`shipped`, `accepted design`, `direction`, never by colour alone. Membership
of a node in `shipped` follows the tables in "What runs today" on the merged
tree, not this spec (e.g. the MCP node sits in `shipped` only when
`packages/mcp` is on the branch; else in `accepted design` with the label
`MCP server (designed)`).

- **D1 — Data path** (`flowchart LR`): `Sources and importers` → `Event ledger
(append-only; purge = delete + receipt)` → `Staging proposals` → `Owner
review (kizuki review / promote)` → `Canon vault (Markdown on disk)` →
  `Derived: FTS5, graph, timeline (rebuildable)`; `Agents and harnesses` →
  `Serving: CLI · MCP` reads `Derived` and `Canon`; `propose` edge from
  `Agents and harnesses` back to `Staging proposals` labelled `the only agent
write`. Edge label on ledger→staging: `deterministic floor; LLM optional`.
- **D2 — Knowledge layers** (`flowchart TB`): `Evidence (ledger)` →
  `Working model (reversible, source-linked)` → `Canon (owner-promoted
Markdown)`; edge labels `automatic, reversible` and `owner promote only`;
  `Conversational correction` → working model, and `Purge` with edges to all
  three labelled `cascades by provenance`. Evidence and canon in `shipped`;
  working model in `accepted design` (RFC 0001 `wm_*`, planned for 1.0);
  correction in `direction`.
- **D3 — Agents and permissions** (`flowchart LR`): `Harness or agent` →
  `token (kzk_…, stored as sha256)` → `grant: ceiling · types · subjects ·
time · tools · rate` → `query engine (SQL ceiling + authorize)` → `audit
row (hashed query shape)`; branch `served: canon + quoted (tainted)` and
  `withheld: unlabeled · held · out of scope`; `propose → staging` as the
  single write. Agents module in `shipped`; `Bounded autonomy modes` in
  `direction`.
- **D4 — Ingestion and proactive outputs** (`flowchart LR`): `connect
(sign-in, not setup)` → `backfill (checkpointed, resumable)` → `sync
(tombstones, edits)` → `Ledger`; `kizuki serve: scheduler + notifiers`
  (`accepted design`) → `briefs · insights · scenarios (evidence-backed,
non-actioning)` (`direction`) → `Owner`. Folder and export connectors in
  `shipped`; sign-in connectors in `accepted design` unless landed.

Together the four cover what issue #4 asks for: sources/connectors, the
knowledge layers, rebuildable retrieval, agents/harnesses,
permissions/autonomy, progressive ingestion, proactive outputs.

### 2.4 Section content rules

`## What runs today` — tables, in this order, each with columns
`Capability | What it means | Proof`:

1. **Foundation**: contracts (`kizuki.event/v1`, `kizuki.proposal/v1`,
   `kizuki.connector/v1`), ledger accept/dedupe/tombstones, staging and the
   deterministic producers, owner promote for every proposal kind with
   receipts, vault init/frontmatter/doctor, purge with receipts and holds,
   export, opaque connection state with the SQLite CHECK envelope, migrations.
2. **Retrieval**: FTS5 search with the ceiling in SQL, graph edges and
   neighbors, timeline, one-command rebuild.
3. **Agents and serving**: identity, grants, rate, audit, `authorize`; the
   serving engine and stdio MCP server only when `packages/core/src/serving`
   and `packages/mcp` are on the branch (serving-mcp); otherwise the row reads
   "agent policy exists as library code; no serving surface wires it yet".
4. **Connectors**: one row per `REGISTRY` key with a link to its section in
   `docs/connectors.md` and the proof `packages/connectors/test/conformance.test.ts::all registry connectors pass conformance`.
5. **CLI** — columns `Verb | One line | Proof`: one row per `COMMANDS` entry
   from `packages/cli/src/commands/index.ts` (cli-verbs), same order, verb
   backticked; proof = the cli-verbs test file that exercises it (e.g.
   `packages/cli/test/e2e.test.ts`, `packages/cli/test/config.test.ts`).
   `packages/cli/test/readme.test.ts` (§7) pins this table to `COMMANDS`.

Then `### Try it (pre-alpha)`: the config file location
(`$KIZUKI_CONFIG`, else `$XDG_CONFIG_HOME/kizuki/config.toml`, else
`$HOME/.config/kizuki/config.toml`) and the stranger loop as one fenced
block, byte-for-byte the sequence cli-verbs §7 specifies (`init`, `import
markdown-folder --source`, `review --list`, `promote --sensitivity personal`,
`query`, `doctor`, `export --out`), followed by the two sentences cli-verbs
requires: unlabeled capture is never served by `query`; sign-in connectors
are not wired until their lanes land (drop the second sentence when one is on
the branch). Subsections `### Build a binary` (ci-hardening §9),
`### Agents and MCP` (cli-wave2 §10, with its registration snippet and the
"What an agent sees" paragraph), `### Optional: an LLM producer`
(llm-producer §14) appear only when their lanes are on the branch, with
their content folded in verbatim (§2.6).

`## Accepted design` — one bullet each, citing the source: the connector
protocol and sign-in-not-setup (`docs/architecture.md` "kizuki.connector/v1";
compiled-in project credentials, `KIZUKI_*` build variables, placeholder
refusal); the 1.0 connector set (telegram, google gmail+calendar, imap + ics,
whoop, x with archive importer, screenpipe, markdown-folder, the export
importers) with the sentence "listed in `docs/connectors.md` with the limits
known today; a connector is real only when it is in the registry table there";
the serving surface (`docs/architecture.md` "Serving"); `kizuki serve`
(`docs/architecture.md` "Proactive"); the LLM producer as a generic
OpenAI-compatible chat-completions endpoint configured by base URL, model and
a secret reference, strictly additive (invariant 5); RFC 0000 as binding
constraints; RFC 0001's accepted items (sensitivity lattice with an explicit
bottom, universal provenance, promotion receipts with hashes, taint separation)
and its deferred `wm_*` layer as "accepted for 1.0, RFC pending, not on main";
the versioned encryption seam as "reserved in the design, no schema field
exists today".

`## Direction` — compress `docs/product-context.md`: reconciliation and
conversational correction; taste and skills as source-linked working
knowledge; context packets (when not shipped); semantic/vector retrieval with
FTS as the floor; proactive briefs, auto-wiki/enrichment, scenarios and
predictions as analyses not facts; the three autonomy modes; consented
federation. End with a link to the "Explicit non-decisions" heading of that
document. Nothing in this section may appear in a "What runs today" table
and vice versa.

`## Ecosystem credit` — table `Upstream | Role in Kizuki | Status`, rows in
the order of the `docs/upstream-policy.md` registry: Bun (runtime, test
runner, `bun:sqlite`; CI pins 1.3.10 or `.bun-version` when ci-hardening has
landed); TypeScript (development dependency `^5.9.0`, lockfile 5.9.3);
SQLite + FTS5 (embedded storage and search through `bun:sqlite`); the Model
Context Protocol specification (planned adapter, or shipped stdio adapter
pinned to the SDK version `packages/mcp/package.json` carries when
serving-mcp has landed); the personal-knowledge reference project (evaluated
reference and integration candidate only; not a dependency, fork, or copied
code; spelling and URL verbatim from the policy row); the maintainer-owned
reference implementations (clean reimplementation of verified behavior only,
no private code or data). One sentence above the table: credit is part of
engineering quality; the policy and the required evaluation record are in
`docs/upstream-policy.md`.

### 2.5 Links

Relative links to `docs/architecture.md`, `docs/product-context.md`,
`docs/lifeos-capability-gap.md` (as "dated capability audit"),
`docs/upstream-policy.md`, `docs/connectors.md`, `SECURITY.md`,
`CONTRIBUTING.md`, `AGENTS.md`, `rfcs/0000-constraints.md`,
`rfcs/0001-deep-model-arbitration.md`, `LICENSE`. Anchored links use the
GitHub slug of the heading (§6 checks them). External links only to the
upstream URLs already present in `docs/upstream-policy.md`; never to this
repository.

### 2.6 Merge-order reconciliation (the README is shared ground)

Sibling lanes each edit one README sentence or section: cli-verbs §7 ("Try
it"), ci-hardening §9 ("Build a binary", the pledge sentence, the status
line), oauth-core §10 and connector-telegram §9 and connector-imap-ics §2.4
and llm-producer §14 (four variants of the zero-phone-home pledge sentence),
serving-mcp §3 (two sentences), cli-wave2 §10 ("Agents and MCP"). This lane
depends on cli-verbs and rewrites the file wholesale; for every other lane:

- landed before this lane: fold its content under the heading named in §2.1
  and §2.4, keeping every claim it made and every proof it can now carry;
  delete nothing it proved.
- landing after this lane: it edits the named heading; its spec's sentence
  replaces the pledge sentence in place.

The zero-phone-home pledge is derived from the merged tree, one sentence:
when `scripts/network-allowlist.txt` exists, "Every file that may open a
socket is listed with its reason in `scripts/network-allowlist.txt`; CI fails
on any network call outside that list and on any telemetry package in a
manifest"; otherwise "There is no network call anywhere under `packages/`;
CI scans every source file and every manifest". Runtime dependencies are
listed per package from `packages/*/package.json` at merge time
(`@kizuki/core`: none — always true, stated as such).

Before the final commit run the `humanizer` skill pass (embedded mode) over
`README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/connectors.md`; it may
change wording, never a claim, a proof token, a heading pinned by §2.1, or a
table the tests parse (§5.1, §7).

## 3. SECURITY.md (root)

Sections, in this order. Tables with a `Proof` column follow §2.2.

1. `## Scope and status` — pre-alpha; the supported version is the head of
   `main`; no packaged releases; single-owner local product; the host-trust
   interim stance in two sentences: canon, ledger text and SQLite are
   plaintext on the owner's disk; connection state files are mode 0600 in a
   0700 directory; there is no encryption at rest; a versioned key-id seam is
   reserved by `docs/architecture.md` but no schema field exists yet.
2. `## Reporting a vulnerability` — use GitHub private vulnerability
   reporting: this repository's **Security** tab → **Report a vulnerability**
   → a draft advisory visible to the maintainers only. Never open a public
   issue for a suspected vulnerability. If the Security tab does not offer
   the button, the feature is not enabled yet for this repository: do not
   post details anywhere public; open a draft advisory as a collaborator if
   you have access, otherwise wait for the maintainers to enable it (§ Open
   questions). What to include: affected file or command, reproduction with
   synthetic data, impact, the head SHA. What never to include: captured
   personal text, real credentials or tokens, a real vault. No bounty, no
   SLA promised; the advisory thread is where acknowledgement and fix status
   appear. Coordinated disclosure: the fix lands with a test and a note in
   the advisory; credit on request. No e-mail address (none exists to
   promise).
3. `## Assets and trust boundaries` — a bullet list: owner and their
   terminal; the vault directory (canon, `archive/`, `.kizuki/`); SQLite
   (`kizuki.db`: events, purge receipts, proposals, promotions, checkpoints,
   connections, canon holds, agents, grants, audit, `search_docs`,
   `graph_edges`); connection state files; agent tokens (only hashes stored);
   connectors and provider responses; captured text, filenames, archives
   and metadata (hostile by contract, invariant 7); the owner-configured
   model endpoint (hostile responses); other processes under the same OS
   account (trusted under the interim stance). Diagram optional; if present
   it obeys §2.3 constraints.
4. `## Threat model` — one table `Threat | What an attacker can do | Control
today | Proof | Not yet built | Residual risk`, rows: host trust (plaintext
   at rest); prompt injection through captured content (control: captured
   text is data, never instruction; TUI strips control sequences
   `packages/tui/test/ansi.test.ts`; producers keep quotes inside quotes;
   unlabeled never served; serving envelope separates `canon` from `quoted`
   with `tainted: true` when serving-mcp has landed, else "designed:
   `docs/architecture.md` invariant 7"; the LLM producer's posture when
   llm-producer has landed); agent overreach (tokens hashed and compared in
   constant time, grants with ceiling/scope/tools/rate, audit rows, the one
   write `propose`, promote is the only door to canon, owner too is denied
   unlabeled items); connector supply chain (in-tree curated registry, shared
   conformance suite, `@kizuki/core` dependency-free, frozen lockfile,
   network AST scan, phone-home dependency grep, compiled-in project
   credentials with placeholder refusal when ci-hardening has landed,
   gitleaks in CI when landed); credential custody (secret references only,
   `env:`/`file:` grammar in `packages/core/src/contracts/secret-ref.ts`,
   opaque state envelope enforced by CHECK constraints
   `packages/core/test/migration.test.ts::v2 keys connector state by source and carries promotion hashes`,
   state bytes never in SQLite, tokens printed once); deletion and exit
   (subject-keyed purge with receipts, holds, `kizuki export`); resource
   exhaustion (bounded page sizes, `MAX_CONNECTION_STATE_BYTES` in
   `packages/core/src/ledger/connection-state.ts`, search and timeline
   limits; name the tests that pin them). Every "Not yet built" cell names
   the lane or the architecture section; every residual-risk cell is honest
   (e.g. "a harness that is served private canon can leak it; grants bound
   what it is served, not what it does with it").
5. `## Out of scope` — an attacker with the owner's OS account or root;
   physical disk access; a harness acting within its own grant; provider-side
   compromise the connector cannot observe; the owner pasting secrets into
   canon by hand.
6. `## What CI enforces` — bullets mapping to `scripts/verify.sh`: frozen
   install, typecheck, tests, policy tests, network scan, phone-home
   dependency grep, forbidden-identifier denylist over tracked text, paths and
   commit messages, attribution validator, and this lane's docs gate; plus
   the invariants tests (`packages/core/test/staging/invariants.test.ts`).
7. `## Secure development rules` — synthetic fixtures only; no plaintext
   credentials in SQLite, logs, fixtures, snapshots or Markdown; captured text
   never in error messages; diagnostics to stderr; every denial path has a
   test; a dependency needs the evaluation record from
   `docs/upstream-policy.md`.

Length under 250 lines. Nothing in SECURITY.md names a person, a host, the
maintainer's other products, or this repository's URL.

## 4. CONTRIBUTING.md and the PR template

`CONTRIBUTING.md` (under 180 lines), sections: `## Before you start` (read
`AGENTS.md`, it is the policy; this file is the workflow); `## Set up`
(`bun install --frozen-lockfile`; Bun version from `.bun-version` when
ci-hardening has landed, else 1.3.10 as CI pins; `bun run typecheck`,
`bun test`, `bun run verify`); `## The gates` (one line per `verify.sh`
step and what makes it fail, including: a fixed list of private identifiers
is rejected in any tracked text, path and commit message — the list lives
only in `scripts/verify.sh`; never write the name of a person, a machine, or
an upstream product other than the ones credited in `docs/upstream-policy.md`,
and never this repository's URL); `## Branches and pull requests` (branch
`agent/<topic>` or a descriptive name; draft until the gates pass on the
exact head; the PR body follows `.github/PULL_REQUEST_TEMPLATE.md`; two review
axes from `AGENTS.md`; no merge without authority); `## Commits` (imperative
subject ≤ 72 chars, short body with the why, no co-author trailers, small
reviewable commits); `## Code rules` (the CONVENTIONS list in one paragraph:
strict TypeScript, zero new runtime dependencies unless a spec names one,
`@kizuki/core` dependency-free, no network in product code, fail closed, no
fake surface, files under ~400 lines, tests use temp dirs and synthetic
names); `## Documentation rules` (§2.2 proof tokens explained for humans;
the three status words; `bun run verify:docs`; adding a CLI verb adds a README
row; adding a registry connector adds a `docs/connectors.md` row plus a
fixture config in `packages/connectors/test/docs.test.ts`);
`## Adding a connector` (the `connector-work` skill checklist in six lines:
sanctioned auth, stable ids, fixtures, conformance, tombstones or documented
absence, purge plan, redaction, no network in fixture paths, registry entry
last, docs row); `## Adding a dependency` (`dependency-evaluation` skill and
the seven-item evaluation record from `docs/upstream-policy.md`; exact pins);
`## Design changes` (`rfcs/`, `write-rfc` skill; an RFC binds only when
merged); `## Security` (link `SECURITY.md`; never test against a real vault);
`## License` (MIT; contributions are accepted under the same license).

NEW `.github/PULL_REQUEST_TEMPLATE.md` (under 40 lines): headings `Purpose`,
`Scope (files and contracts)`, `Base and head SHA`, `Tests run (commands and
results)`, `Security and privacy impact`, `Dependencies added or upgraded
(with the evaluation record)`, `Docs updated (README rows, connectors, proofs)`,
`Blockers and open questions`, and a checklist: `bun run verify` green on the
exact head; no personal data, credentials, private paths or identifiers; draft
until gates pass.

## 5. docs/connectors.md

### 5.1 Shape (the first two tables are parsed by `packages/connectors/test/docs.test.ts`)

1. `## The contract` — `kizuki.connector/v1` in plain words: manifest,
   `auth_modes` (`none` = a path you point at; `sign_in` = phone code or app
   password in the terminal; `oauth` = browser consent through PKCE and a
   loopback listener; `secret_ref` = an existing token you point at),
   capabilities and what each word promises (`backfill`, `sync`,
   `tombstones` = deletions at the source become `deleted: true` events,
   `purge` = the connector can plan what a subject purge removes, `fixture` =
   offline synthetic sample), `emits_sensitivity_hint` and its consequence
   (events without a hint are stored but withheld from every reader until the
   owner promotes and labels a page), the conformance suite items
   (`packages/connectors/src/conformance.ts`), credential custody (secret
   references; opaque state under `<vault>/.kizuki/connections/`, 0600, never
   in SQLite), and the honesty rule from the `connector-work` skill: a source
   is named as live sync, local loopback, folder snapshot, or export import —
   an export importer is never called sync.
2. `## Shipped` — one table, rows sorted by `connector_id`, exactly these
   columns and cell forms:

   ```
   | connector_id | auth | kinds | backfill | sync | tombstones | purge | fixture | hint | mode |
   ```

   `auth` = `auth_modes` joined by `, `; `kinds` joined by `, `; the five
   capability columns and `hint` are `yes`/`no`; `mode` is one of `folder
snapshot`, `export import`, `live sync`, `local loopback`. On main the
   rows are `kizuki.import-chatgpt` (none; message; yes yes no no yes; no;
   export import), `kizuki.import-claude` (same), `kizuki.markdown-folder`
   (none; file; yes yes yes no yes; no; folder snapshot). The test derives
   the expected rows from `REGISTRY` and each `manifest()`, so a lane that
   lands a connector must add its row (and its fixture config to the test)
   or CI fails.

3. `### <connector_id>` — one H3 per registry key (the test asserts the
   heading exists), each with: what is captured (`kind`, `source_record_id`
   form, subjects, hint), how a cursor works, how deletions and edits are
   observed, what is never captured, purge semantics, and known limits. On
   main: `kizuki.markdown-folder` (recursive `.md` snapshot; cursor is the
   snapshot; a vanished file becomes a tombstone on the next `sync`; no file
   watching, no daemon; no sensitivity hint — every captured note is withheld
   until promoted; `purge: false` — the folder is the owner's); the two export
   importers (one JSON export file; `backfill` and `sync` both re-read the
   file; no tombstones — a conversation removed from a later export stays in
   the ledger until the owner purges it; no purge plan; `kind: message`;
   parser bounds as implemented in `parseChatGptExport` / `parseClaudeExport`).
   Point at the package README when a connector has one.
4. `## Accepted for 1.0, not in the tree` — a table `connector_id | auth |
source class | provider facts and limits (checked date) | status`, one row
   per owner-decided 1.0 connector: `kizuki.telegram` (sign_in; the account's
   own dialogs through the MTProto client API, not a bot; no deletion
   detection without the update stream; edits re-read within a bounded
   window; media as references, no downloads; secret chats not reachable;
   flood-wait honoured; project app credentials compiled in at build time,
   placeholders refuse sign-in), `kizuki.google` (oauth; Gmail + Calendar
   read-only through an installed-app client with PKCE; consent-screen
   verification and Workspace admin gates apply; trash and cancellations as
   tombstones), `kizuki.imap` (sign_in; app password; implicit TLS only, no
   STARTTLS, no OAuth providers — providers that have retired app passwords
   are unsupported; read-only `EXAMINE`/`BODY.PEEK`; expunges as tombstones),
   `kizuki.ics` (none or sign_in; file or `https://` URL; bounded RRULE
   subset; a private calendar URL is treated as a credential),
   `kizuki.whoop` (oauth; no public-client flow exists — an owner-registered
   client via secret references is the primary path; deletions are
   webhook-only, so no tombstones; no provider-side delete, so no purge plan;
   rate limits 100/min, 10 000/day), `kizuki.x` (archive importer plus Basic
   API user-context sync with PKCE; paid, bounded history; the archive is
   the history path), `kizuki.screenpipe` (local SQLite adapter; loopback
   only), and the export importers `whatsapp-export`, `pocket`, `omnivore`,
   `x-archive` (export files; no live sync exists or is sanctioned). The
   `status` cell reads `specified` or `in progress`; a heading sentence
   states that nothing in this table is a claim of working software and that
   provider facts were checked on 2026-09-02 and must be re-checked when the
   connector is implemented (`connector-work` skill). The test asserts that no
   `REGISTRY` key appears in this table.
5. `## Deferred` — two H3s the test asserts by name: `### Composio` (a
   meta-connector whose SDK routes provider traffic through a third-party
   service; that puts a cloud in the loop of every source and conflicts with
   zero phone-home and local custody; deferred until an owner decision names
   the boundary) and `### WhatsApp Business API` (serves business accounts
   through hosted webhooks and platform review; there is no sanctioned read
   API for a person's own history; deferred; the export importer is the
   supported path).
6. `## Adding a connector` — link to `CONTRIBUTING.md` and the skill.

Under 300 lines; no provider marketing names beyond the product names needed
to identify a source; no screenshots; no real handles, hosts, or accounts.

## 6. `scripts/verify-docs.ts` and `scripts/markdown.ts` (NEW) — the docs gate

`scripts/markdown.ts` (pure parsers, no I/O, under 300 lines):

```ts
export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}
export interface Link {
  target: string;
  line: number;
} // inline [text](target); code spans and fences skipped
export interface Fence {
  info: string;
  body: string;
  line: number;
  closed: boolean;
}
export interface Table {
  header: string[];
  rows: { cells: string[]; line: number }[];
  line: number;
}
export interface Section {
  heading: Heading;
  text: string;
} // an H2 and everything up to the next H2

export function slugify(headingText: string): string; // GitHub anchor rule: lowercase, strip everything except letters, digits, spaces, hyphens; spaces → "-"; keep unicode letters
export function extractHeadings(md: string): Heading[]; // ATX headings outside fences; text with inline code kept, backticks removed
export function extractLinks(md: string): Link[];
export function extractFences(md: string): Fence[];
export function extractTables(md: string): Table[]; // pipe tables; cells trimmed; escaped pipes honoured
export function sections(md: string): Section[];
export function stripCodeSpans(line: string): string;
```

`scripts/verify-docs.ts` (under 400 lines):

```ts
export interface DocProblem {
  file: string;
  line: number;
  reason: string;
}
export interface ProofToken {
  raw: string;
  kind: "file" | "run";
  path: string | null;
  needle: string | null;
  command: string | null;
}
export interface DocsContext {
  tracked: Set<string>; // repo-relative paths from git ls-files
  readFile(path: string): string | null; // repo-relative; null when unreadable
  scripts: Set<string>; // keys of the root package.json "scripts"
}
export interface DocsReport {
  files: string[];
  links: number;
  anchors: number;
  proofs: number;
  mermaid: number;
  problems: DocProblem[];
}
export const CHECKED_GLOB = "*.md" as const; // every tracked Markdown file
export const STATUS_HEADINGS = [
  "What runs today",
  "Accepted design",
  "Direction",
] as const;
export const HONESTY_FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/connectors.md",
] as const;
export const FORBIDDEN_PHRASES = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bFIXME\b/,
  /coming soon/i,
] as const;
export const MERMAID_FIRST_LINE =
  /^(flowchart|graph)\s+(LR|RL|TB|TD|BT)\b|^(sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram)\b/;

export function parseProofTokens(cell: string): ProofToken[]; // backticked tokens; a cell with none → one problem
export function checkProof(token: ProofToken, ctx: DocsContext): string | null; // null = ok, else the reason
export function checkDocument(
  file: string,
  md: string,
  ctx: DocsContext,
): DocProblem[];
export function verifyDocs(root: string, ctx?: DocsContext): DocsReport; // default ctx built from git ls-files + fs
```

Rules in `checkDocument`, each with a unit test (§7):

1. **Links.** Every inline link target that is not `https://…`, `mailto:…`
   or `#…` is resolved relative to the file's directory (`.`/`..` allowed,
   never escaping the repo); the target path (anchor stripped) must be in
   `tracked`, or be a directory prefix of a tracked path. `http://` links
   are a problem (`insecure link`). An anchor on a `.md` target must equal
   the `slug` of a heading in that file; an in-file `#anchor` likewise.
   External `https://` links are neither fetched nor validated.
2. **Mermaid.** Every fence whose info string starts with `mermaid` must be
   closed; its first non-blank line matches `MERMAID_FIRST_LINE`; the body
   contains no `%%{`, no `click ` or `href`, no HTML tag (`/<\/?[a-z]/i`), no
   tab character; `subgraph` lines and `end` lines balance. Each fence counts
   toward `mermaid`.
3. **Proof tables.** In every table whose header has a cell equal to `Proof`,
   every row's Proof cell parses to ≥ 1 token and every token passes
   `checkProof`: `file` tokens — `path` in `tracked`, and `needle` (when
   present) occurs literally in `readFile(path)`; `run` tokens — `bun run
   <script>` with `<script>` in `ctx.scripts`, or `bash scripts/<f>` /
   `bun scripts/<f>` / `bun packages/<p>/src/<f>` with the file in `tracked`.
   Each token counts toward `proofs`.

4. **README status headings.** In `README.md` the three `STATUS_HEADINGS`
   exist as H2, in that order, and every table in the "What runs today"
   section has a `Proof` header cell.
5. **Honesty phrases.** In `HONESTY_FILES`, any line outside a code fence
   matching a `FORBIDDEN_PHRASES` entry is a problem.
6. **Fences.** Every fence in every checked file is closed.

`main()`: `verifyDocs(process.cwd())`; print each problem as
`<file>:<line>: <reason>` to stderr and exit 1 when any; otherwise print
`documentation verification passed (<files> files, <links> links, <anchors> anchors, <proofs> proofs, <mermaid> mermaid fences)`
and exit 0. No network, no writes.

Wiring: `scripts/verify.sh` `main()` gains the line
`bun run scripts/verify-docs.ts` directly after `bun run scripts/verify-network.ts`
(ci-hardening edits other lines of the same function; the merge is
one-line). Root `package.json` scripts gain `"verify:docs": "bun scripts/verify-docs.ts"`.
`tsconfig.json` already includes `scripts/**/*.ts`, so both files are
typechecked and `scripts/verify-docs.test.ts` runs under `bun test`.

## 7. Tests

All under `bun test`; synthetic content only; temp dirs via `mkdtempSync`;
no network.

- `scripts/verify-docs.test.ts` (NEW): `slugify` matches GitHub for
  `## What runs today` → `what-runs-today`, `## kizuki.markdown-folder` →
  `kizukimarkdown-folder`, a heading with backticks and parentheses; a broken
  relative link, a link escaping the repo (`../../x.md`), an `http://` link,
  a missing anchor, and a valid anchored link (in-memory `ctx` with an
  injected `tracked` set and `readFile` map — no git); a mermaid fence that
  is unclosed, one starting with `pie`, one containing `%%{init`, one with
  an HTML label, one with an unbalanced `subgraph`, and a valid `flowchart
LR` with a quoted label; a Proof cell with no token, a token naming an
  untracked path, a token whose needle is absent, a valid `file::needle`,
  a valid `run: bun run verify`, an invalid `run: curl …`; README missing a
  status heading or with the headings out of order; a table under "What runs
  today" without a `Proof` column; `TBD` inside a code fence is allowed and
  outside is a problem; `checkDocument` on a file with none of the above
  returns `[]`. Tree test: `verifyDocs(<repo root>)` has `problems: []`,
  `mermaid >= 4`, `proofs >= 30`, `files >= 12` — a broken proof anywhere
  fails `bun test`, not only `bun run verify`.
- `packages/connectors/test/docs.test.ts` (NEW): reads `docs/connectors.md`
  relative to `import.meta.dir`; `FIXTURE_CONFIGS: Record<string, unknown>`
  with the three synthetic path configs; "every registry connector has a
  fixture config for the docs test" (a missing key fails naming the id and
  this file); "the Shipped table lists exactly the registry, sorted" (rows'
  `connector_id` equals `Object.keys(REGISTRY).sort()`); "every Shipped row
  matches its manifest" (auth, kinds, the five capabilities, hint, derived
  from `getConnector(id, FIXTURE_CONFIGS[id]).manifest()`); "the mode cell is
  one of the four honest words"; "every registry connector has its own H3
  section"; "no registry connector sits in the not-in-the-tree table"; "the
  Deferred section names Composio and WhatsApp Business API".
- `packages/cli/test/readme.test.ts` (NEW; depends on cli-verbs): imports
  `COMMANDS` from `../src/commands/index`; parses the README "What runs
  today" section's table whose first header cell is `Verb`; "the README verb
  table is exactly COMMANDS, in order" (backticked names); "the stranger loop
  names every verb the quickstart drives" (`init`, `import`, `review
--list`, `promote`, `query`, `doctor`, `export` appear in the fenced block
  under `### Try it (pre-alpha)`).
- `bash scripts/verify-policy.test.sh` stays green (no change to the
  attribution or path assertions).

## Acceptance

````
git log --oneline main..HEAD -- docs/product-context.md docs/lifeos-capability-gap.md docs/upstream-policy.md | wc -l   # 3 (the cherry-picks)
git diff --quiet origin/codex/product-context -- docs/product-context.md docs/lifeos-capability-gap.md docs/upstream-policy.md && echo IDENTICAL   # IDENTICAL
for f in SECURITY.md CONTRIBUTING.md docs/connectors.md .github/PULL_REQUEST_TEMPLATE.md scripts/verify-docs.ts scripts/markdown.ts scripts/verify-docs.test.ts packages/connectors/test/docs.test.ts packages/cli/test/readme.test.ts; do git ls-files --error-unmatch "$f" >/dev/null && echo "tracked $f"; done   # nine lines
git diff --stat main..HEAD -- packages/*/src | cat                           # empty: no product code changed
git diff --stat main..HEAD -- '*/package.json' bun.lock | cat                # only package.json (the verify:docs script); bun.lock unchanged
bun install --frozen-lockfile && bun run typecheck                            # exit 0
bun test                                                                      # green; the three new test files present and counted
bun run verify:docs                                                           # "documentation verification passed (N files, … proofs, 4 mermaid fences)" — proofs ≥ 30, exit 0
grep -n '^## ' README.md                                                      # exactly: Pledges, How it works, What runs today, Accepted design, Direction, Connectors, Security, Ecosystem credit, Contributing, License
grep -c '^```mermaid' README.md                                               # 4
awk '/^## What runs today/,/^## Accepted design/' README.md | grep -c '| Proof'   # ≥ 5 (foundation, retrieval, agents, connectors, CLI)
grep -c '(direction)$' README.md                                              # ≥ 6 (every Direction bullet)
grep -n -E 'TODO|TBD|FIXME|coming soon' README.md SECURITY.md CONTRIBUTING.md docs/connectors.md   # no output
grep -c 'Report a vulnerability' SECURITY.md                                  # ≥ 1
grep -c '^| Threat' SECURITY.md                                               # 1 (the threat table) and it has a Proof column: grep -c '| Proof' SECURITY.md → ≥ 1
grep -n '^| kizuki\.' docs/connectors.md | head -3                            # the three registry rows, sorted: import-chatgpt, import-claude, markdown-folder (plus any landed since)
grep -c '^### Composio\|^### WhatsApp Business API' docs/connectors.md        # 2
git grep -n 'github.com/' -- README.md SECURITY.md CONTRIBUTING.md docs/connectors.md .github/PULL_REQUEST_TEMPLATE.md   # only upstream URLs already present in docs/upstream-policy.md; none pointing at this repository
sed -i 's/promote path is the only door to canon/promote path is the only door to kanon/' README.md && bun run verify:docs; echo $?; git checkout -- README.md   # the mutated proof fails: exit 1 naming README.md and the needle
bash scripts/verify.sh                                                        # exit 0 (frozen install, typecheck, tests, policy tests, network scan, docs gate, dependency grep, identifier denylist over tracked text, paths and every reachable commit message, attribution validator)
git status --porcelain                                                        # empty
````

Manual step, recorded in the lane report: push the branch, open the draft PR
from `.github/PULL_REQUEST_TEMPLATE.md`, open the rendered `README.md` and
`SECURITY.md` on GitHub and confirm all four diagrams render and every
relative link resolves (the gate checks structure; GitHub is the renderer).

## Open questions (for the lane report; none blocks the tests)

1. GitHub private vulnerability reporting is not enabled: the repository is
   private and the reporting endpoint returned 404 on 2026-09-02. SECURITY.md
   documents the Security-tab path plus the "not enabled yet" fallback; the
   owner enables the setting (Settings → Code security) before or at the
   moment the repository goes public.
2. Draft PR #3 is superseded by this lane's branch; the owner closes it.
3. Merge order: after cli-verbs (hard dependency). ci-hardening, oauth-core,
   connector-telegram, connector-imap-ics, serving-mcp, cli-wave2 and
   llm-producer each touch one README sentence or section; §2.6 gives the
   fold rule for either order.
4. `docs/lifeos-capability-gap.md` keeps repository-relative paths of the
   maintainer's other monorepo, which the document itself calls
   non-sensitive; it lands byte-identical. If the owner wants those paths
   generalized, that edit belongs in this lane before merge.
5. SECURITY.md promises no response time; the owner may add one.
6. README says the `wm_*` working model is "accepted for 1.0, RFC pending";
   RFC 0001 on main still says "Wave 5". The RFC, not the README, is where
   that wording is reconciled when the wm lane's RFC lands.
7. DCO or CLA: undecided; CONTRIBUTING.md states only that contributions are
   accepted under MIT.
