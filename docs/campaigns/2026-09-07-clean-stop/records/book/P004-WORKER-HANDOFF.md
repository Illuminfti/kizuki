# P004 worker handoff: shared v3 evidence reader and surface validator

Date: 6 September 2026. Contract base:
`f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. This packet implements evidence
plumbing only. It does not establish release readiness or authorize a GO.

## Ownership and inputs

P004 owns exactly:

- `scripts/go-no-go.ts`
- `scripts/go-no-go.test.ts`
- `scripts/release-evidence.ts` (new)

Do not create or edit `scripts/capability-proof.ts`; P006 is its sole owner.
Use the accepted parts of P003 at
`PRIVATE_FLEET/workers/P003-attempt2/workspace/out`
and the corrections in `P003-RELEASE-CONTRACT-OWNER-REVIEW.md`. Preserve all
v1/v2 behavior. Do not implement, simulate, or grant credit to any family
except `kizuki.surface-inventory/v1`.

## Deliverable

Add a shared, fail-closed v3 index reader and shared receipt-identity validator
in `scripts/release-evidence.ts`; integrate them into `evaluateRelease`; add the
surface receipt validator and tests. The capability producer remains absent,
so P004's own final report must still show
`surface.capabilities-and-docs: NOT_IMPLEMENTED` and overall `NO-GO`.

`kizuki.acceptance-evidence/v3` has exactly five keys:
`schema`, `candidate_source_sha`, `artifacts`, `fixture_observation`, and
`gate_receipts`. Retain the current artifact and fixture reference behavior.
Raise the v3 index cap to 32,768 bytes; do not raise the v1/v2 cap.
`gate_receipts` contains at most 40 exact five-key rows:
`producer`, `gate_id`, `target`, `path`, `sha256`.

For the index itself, enforce duplicate-key/depth-safe JSON, exact key sets,
lowercase 40/64-hex digests, canonical absolute paths, a known producer, the
exact producer/gate/target mapping below, and one reference per gate id.
Unknown, duplicate, or mismatched references make `evidence.index` `FAIL` and
prevent consumption of every new-family reference.

## Total producer-to-gate map

The map is closed and evaluator-owned:

| Producer | Allowed gate id | Index `target` |
| --- | --- | --- |
| `kizuki.native-attestation/v1` | `native.<target>` | the same closed target |
| `kizuki.native-lifecycle/v1` | `lifecycle.<target>` | the same closed target |
| `kizuki.required-checks/v1` | `candidate.required-checks` | `null` |
| `kizuki.independent-review/v1` | `candidate.independent-review` | `null` |
| `kizuki.p0-disposition/v1` | `candidate.current-p0-disposition` | `null` |
| `kizuki.surface-inventory/v1` | `surface.capabilities-and-docs` | `null` |
| `kizuki.journey-proof/v1` | `journey.<journey-id>` | `null` |
| `kizuki.connector-evidence/v1` | `connector.<connector-gate-id>` | `null` |
| `kizuki.unfamiliar-user/v1` | `human.unfamiliar-user` | `null` |
| `kizuki.owner-rails-observation/v1` | `owner.seven-day-rails` | `null` |
| `kizuki.estate-parity-observation/v1` | `estate.fourteen-day-parity` | `null` |
| `kizuki.cutover-authority/v1` | `owner.final-cutover` | `null` |

Closed targets are `bun-linux-x64-baseline` and `bun-darwin-arm64`. Closed
journey ids are `connect-resume`, `correct-belief`, `revoke-purge`,
`retrieve-trustworthily`, `import-estate-slice`, `daily-loop`,
`useful-insight`, and `install-recover`. Closed connector gate ids are
`telegram`, `gmail`, `google-calendar`, `imap`, `ics`, `whoop`, `x-api`,
`screenpipe`, `markdown-folder`, `chatgpt-export`, `claude-export`, `x-archive`,
`whatsapp-export`, `pocket`, and `omnivore`.

The total gate inventory remains the current two artifact, two engine, two
native, two lifecycle, one required-checks, one independent-review, one P0,
one surface, eight journey, fifteen connector, one unfamiliar-user, three
optional/superseded, one fixture diagnostic, and one evidence-index rows.
`owner.seven-day-rails`, `estate.fourteen-day-parity`, and
`owner.final-cutover` remain optional with `release_credit: false` semantics.

## File custody and status propagation

Consume a receipt only after the v3 index passes. Read it with the existing
custody boundary: canonical absolute path, no symlink component, regular file,
`nlink === 1`, identity-stable read, supplied SHA-256 equality, and final
unchanged check. Cap the surface receipt at 65,536 bytes. Reserve 262,144 only
for later journey/connector validators. Parse with the same duplicate-key and
depth-32 protection used for proofs; reject unknown keys and control
characters. Validate `recorded_at` as a real RFC3339 UTC instant that
round-trips to the exact millisecond `...sssZ` form.

Shared identity is the exact eight-key P003 object. Require sorted unique
relative POSIX `producer_files`, closed source/actor classes, UUID-v4
`attempt_id`, producer equal to top-level schema, candidate equal to the v3
index candidate, and a non-null producer revision. `pass` requires no
failures; `fail` requires at least one; `unresolved` grants no PASS.

Apply these states in order:

1. Absent reference leaves the gate's current default unchanged.
2. Invalid v3 reference fails `evidence.index`; consume none.
3. An inactive producer leaves its gate `NOT_IMPLEMENTED` (or the current
   explicit `UNVERIFIABLE` default) and does not open its referenced file.
4. For an active producer, a missing, unsafe, changed, oversized, digest-
   mismatched, malformed, wrong-candidate, wrong-revision, wrong-gate, or
   wrong-target receipt makes that named gate `FAIL` with no credited digest.
5. A fully valid implemented receipt with `outcome: fail` is `FAIL`; with
   `outcome: unresolved` it is `UNVERIFIABLE`; only `outcome: pass` plus all
   family predicates is `PASS`.

All non-surface new producers are reserved names only. Do not open their
receipts, call their outcomes authoritative, or alter their default status.
Synthetic fixtures receive no native, CI, review, P0, account, human, journey,
connector, lifecycle, or release credit.

## Surface contract

The only implemented family validator is `kizuki.surface-inventory/v1`, with
source class `candidate-tree-inventory`, actor class `automated-producer`, gate
`surface.capabilities-and-docs`, and `target: null`. Its fixed, sorted producer
file set is exactly:

1. `scripts/capability-proof.ts`
2. `scripts/release-evidence.ts`

No observed product or documentation file belongs in producer identity. If
either producer file later imports another helper that determines emitted
receipt semantics, the contract and fixed list must be reviewed and expanded
before accepting receipts; P004 must not silently discover a file list from a
receipt.

Compute `producer_revision` from the actual candidate-tree bytes as SHA-256 of
the UTF-8 JSON serialization of
`{files:[{path,sha256},{path,sha256}]}` in the exact order above, with no
whitespace or final newline. Require `identity.producer_files` to equal that
array exactly.

The receipt has exactly the P003 surface keys: `schema`, `identity`, `outcome`,
`failures`, `head_sha`, `bun_version`, `cli_verbs`, `retired_verbs`,
`mcp_tools`, `connectors_registered`, `connectors_c3`, `docs`, and
`disagreements`. Bound every list, require sorted uniqueness where order is not
part of the product interface, and use exact nested key sets. Specifically:

- `head_sha` equals both the index candidate and checked-out candidate.
- `bun_version` equals the trimmed candidate `.bun-version`.
- `cli_verbs` equals the ordered live CLI group sequence from
  `packages/cli/src/help.ts`; `retired_verbs` equals the retired command set in
  `packages/cli/src/retired.ts`.
- `mcp_tools` equals the complete tool-name set exported by
  `packages/mcp/src/server.ts`.
- `connectors_registered` equals the complete runtime registry, including
  identifier and capability-relevant fields needed to detect a fake surface.
- `connectors_c3` equals the exact ordered `CONNECTORS` obligations from
  `go-no-go.ts`, including each `id`, nullable `connector_id`, and evidence
  class. `x-api` remains `{connector_id:null,evidence:"live-account"}`.
- `docs.files` is exactly the sorted paths `README.md`, `SECURITY.md`,
  `docs/CURRENT.md`, and `docs/cli.md`, each with the SHA-256 of candidate bytes.
- `disagreements` is a bounded, sorted, unique array of exact
  `{code,path}` rows and must equal the validator's independently recomputed
  differences. A pass requires this array to be empty.

Do not accept an empty self-declared `disagreements` array. The validator must
derive all expected inventories and hashes from the exact candidate checkout,
compare every receipt field, and fail on any omitted, extra, duplicate, stale,
or differently ordered value. Source-parsing shortcuts that can silently miss
dynamic registry entries are out of scope; use the same exported product data
that P006's producer will use, or fail closed if a surface cannot be enumerated.

## Future producer verifier seam

Change verifier-file metadata deliberately rather than adding a missing path
to the current unconditional `readFileSync` map. Existing verifier paths and
`scripts/release-evidence.ts` are mandatory: absence or read failure is fatal.
Predeclare only `scripts/capability-proof.ts` as optional and gate-bound.

The report's verifier list must contain an explicit deterministic entry for
every declared file. Before P006 it is
`{file:"scripts/capability-proof.ts",sha256:null,status:"MISSING"}`; include
that exact sentinel in `verifier_sha256`. In this state the surface producer is
inactive and the gate remains `NOT_IMPLEMENTED`, even if a v3 index lists a
surface receipt. Any error other than true absence is fatal. Once P006 creates
the regular file, hash its bytes and emit
`{file:"scripts/capability-proof.ts",sha256:"<digest>",status:"PRESENT"}`.
Presence only activates validation: it never sets PASS, supplies a receipt, or
waives candidate/revision/recomputation checks.

## Required tests and completion receipt

Add focused tests for v1/v2 compatibility; exact v3 key and total gate mapping;
unknown and duplicate refs; digest/path/custody failures; candidate, identity,
revision, and RFC3339 failures; surface mismatch and truthful disagreement;
fail/unresolved propagation; inactive-producer behavior; the missing/present
capability verifier sentinel; and proof that every non-surface family remains
without credit. A valid neutral surface fixture may exercise the validator by
creating both producer files in an isolated temporary candidate tree; it is
never retained release evidence.

Run the focused test file, typecheck, and the repository's pinned verification
command. Report exact base, final commit/tree, changed paths, commands and
results, and remaining `NO-GO` rows. Completion requires a nonempty diff whose
paths are a subset of the three owned files and whose commit descends directly
from the supplied base. No merge, release, publication, account, credential,
or auth change is authorized by this handoff.
