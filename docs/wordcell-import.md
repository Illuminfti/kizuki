# Bring Wordcell notes into Kizuki

Kizuki can import an owner-selected Wordcell Markdown vault through its
existing `import-legacy-wiki` connector. The supplied
[Wordcell mapping](../examples/import-mappings/wordcell.json) carries saved
notes and their metadata into Kizuki's source-consented evidence pipeline.
Wordcell keeps authoring its own files; Kizuki does not become their editor.

This is file-format interoperability, not an embedded Wordcell SDK, a second
memory engine, a graph migration, or a new live service. It requires no
Wordcell executable, model, account or network request. The import command
never writes canon. Any later canon materialization still requires the
configured model and the existing receipted writer.

## Import from a source checkout

Run from the Kizuki checkout. Set `SOURCE` to the selected Wordcell vault and
`VAULT` to an already initialized Kizuki vault. They must be different roots;
do not point either tool at the other tool's generated or control directories.

Keep a copy of the profile at a stable path **outside** the Wordcell vault:

```sh
SOURCE="/absolute/path/to/wordcell-vault"
VAULT="/absolute/path/to/kizuki-vault"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/kizuki"
mkdir -p "$CONFIG/import-mappings"
cp examples/import-mappings/wordcell.json "$CONFIG/import-mappings/wordcell.json"
MAPPING="$CONFIG/import-mappings/wordcell.json"
POLICY="$CONFIG/wordcell-source-policy.json"
```

Write explicit source consent. This example authorizes local capture and
recall, not model egress or extraction. Its private floor is a source boundary,
not a requirement to label individual notes:

```sh
(umask 077; cat > "$POLICY" <<'JSON'
{"purposes":["capture","recall","session","derive"],"allowed_fields":["text","subjects","attachments","metadata"],"retention":"persistent_owned_until_revoked","egress":"local_only","sensitivity_floor":"private"}
JSON
)

bun packages/cli/src/main.ts import import-legacy-wiki \
  --source "$SOURCE" --mapping "$MAPPING" \
  --policy "$POLICY" --expected-revision 0 --operation-id wordcell-first-import \
  --vault "$VAULT"

bun packages/cli/src/main.ts query "your project" --vault "$VAULT"
bun packages/cli/src/main.ts context --purpose session --query "your project" --vault "$VAULT"
```

Revision zero is for a new source grant, not an instruction to overwrite an
existing one. Use the existing [source-consent workflow](cli.md#source-consent)
for an already enrolled source. An authorized MCP client can use `search`
and `context_packet` on the resulting permitted evidence; it receives no
additional grant from this import.

The connection stores the absolute mapping path. A later process reuses it:

```sh
bun packages/cli/src/main.ts import import-legacy-wiki \
  --source "$SOURCE" --vault "$VAULT"
```

Do not delete or move the mapping file while that connection uses it. Passing
a different `--mapping` path for the same active or disconnected source fails
with `mapping_conflict` before capture, grant mutation or reactivation. The
flag does not silently replace an enrollment or pretend the supplied mapping
was used. An existing source using its default beside-source mapping must
continue using that configuration; this command is not a migration operation.
Editing the already configured mapping file retains the legacy importer's
existing mapping-hash and reconciliation semantics.

The same `--mapping FILE` option works for `import-legacy-events` with its
own existing mapping schema. Other connectors and `estate-slice` refuse it.
Omitting the option on a new legacy source retains the previous beside-source
mapping-file convention.

## What crosses the boundary

| Wordcell material | Kizuki representation |
| --- | --- |
| Note body and literal wikilinks | Captured source text, not trusted instructions or automatically resolved graph edges |
| `document_id` | `x-wordcell-document-id` on the existing page candidate; it does not replace the connector's path-based record identity |
| `repository_scopes` | `x-wordcell-repository-scopes`; source metadata, never an authorization grant or a new path-query API |
| `tags` | `x-wordcell-tags` |
| `publish` | `x-wordcell-publish`; never permission to publish, send to a model, or broaden access |
| Note `type` | A `source` candidate with the original vocabulary retained as `x-legacy-type`; a plan, profile or decision is not automatically a Kizuki fact |
| Note path | Preserved as source identity, with mirrored candidate placement under the existing source-page directory |

Missing or unreadable sensitivity defaults to private under the existing
importer. Any readable source label remains subject to connector and source
grant floors. In the policy example above all imported material remains private.
The profile ignores `.wordcell/**` and `.git/**`; existing scanner safety and
resource limits still apply. It does not fetch linked URLs, execute tools,
load models, or rewrite the source.

## Lifecycle and honest limits

Unchanged pages do not create new imported records. A changed page is emitted
under the same path identity. A conclusively absent page produces the existing
tombstone; an unreadable page is not claimed deleted. Source revocation, purge,
correction and canon undo remain Kizuki operations rather than Wordcell writes.

The import preserves neither an entire Wordcell runtime nor all its semantics.
It does not import Git history, attachment bytes, graph query proofs, a complete
upstream ontology or unsaved conversations. Original wikilinks are retained
literally and are not rewritten to Kizuki paths. Renaming a Wordcell file is a
path deletion plus a new path, not a guaranteed `document_id` identity merge.
No date mapping is guessed: occurrence time uses the legacy importer's file
mtime fallback. The existing frontmatter subset, body-size limits, lossy-field
reports and credential-name filtering still apply; see
[legacy import limits](legacy-import.md#honest-limits). This is not a byte-perfect
archive of every note, nor a secret scrubber for arbitrary prose.

The regression suite uses synthetic Wordcell-shaped notes. It covers the
profile and the real Kizuki CLI, not a live Wordcell installation or a measured
retrieval-quality improvement. Runtime verification receipts belong to the
exact PR head; the presence of this guide is not a passing test receipt.

```sh
bun test packages/cli/test/wordcell-import.test.ts
bun test packages/cli/test packages/connectors/test
bun run typecheck
bun run verify
```

## Upstream record

Evaluated on 26 September 2026 against
[hraness/wordcell at `413186cfaced410c7dd3eb5d8d8473b151febf30`](https://github.com/hraness/wordcell/tree/413186cfaced410c7dd3eb5d8d8473b151febf30).
The [README](https://github.com/hraness/wordcell/blob/413186cfaced410c7dd3eb5d8d8473b151febf30/README.md)
and [developer workflow](https://wordcell.io/developers) define the Markdown,
`document_id` and repository-scope conventions used here.

Boundary: Kizuki-owned configuration adapter over existing importer code.
No upstream implementation, fixture, prompt, model, binary or runtime dependency
is copied or bundled. Wordcell's pinned
[license](https://github.com/hraness/wordcell/blob/413186cfaced410c7dd3eb5d8d8473b151febf30/LICENSE)
is MIT, copyright 2026 Hraness contributors. Any later source reuse requires
preserving its copyright and permission notice and a separate dependency and
privacy review under [upstream policy](upstream-policy.md).

For an upstream format change, add a synthetic compatibility fixture before
changing this profile. Keep generic importer fixes in Kizuki; propose an
upstream issue only when the public Wordcell contract itself needs clarification.
Neither package installation nor deployment to an owner's machine is performed
by adding this profile.
