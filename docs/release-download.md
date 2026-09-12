# Prepare a download candidate

The preparation tool wraps retained packages in deterministic archives and writes
a manifest. It does not install, publish, sign or approve a release. The manifest
always says `unpublished_candidate`, `release_approved: false` and
`distribution_assessment: not_performed`.

Run it from a reviewed source checkout with Bun and the native directory-custody
backend available. The input package and its existing artifact proof must bind the
same exact source SHA. Preparation does not rebuild or execute either binary.

```sh
bun scripts/release-download.ts --source SOURCE_SHA --out /absolute/new-output \
  --artifact /absolute/retained-package --proof /absolute/artifact-proof.json
```

A second `--artifact DIR --proof FILE` pair can include the other supported target.
The supported targets remain Linux x64 baseline and macOS arm64. One target is
labelled `partial`; two are labelled `both_supported_targets`. Neither label is
release acceptance. Duplicate targets and unsupported targets are refused.

The output directory must be absent, with an existing owner-controlled parent.
Preparation stages private files, syncs them, rechecks the input and output
identities, and uses the existing descriptor-based directory publication helper
to publish without replacing a destination. A failure is not success even when
publication or durability is uncertain; preserve the reported state for review.
Input, staging and destination paths must retain custody throughout the operation.
As with the underlying publication helper, another same-owner writer must not be
allowed to modify the staging files concurrently.

## Archive and manifest contract

Each `kizuki-SOURCE_SHA-TARGET.tar.gz` contains exactly these regular files, in
this order: `kizuki`, `kizuki-mcp`, `README.txt`, `LICENSE`,
`THIRD-PARTY-NOTICES.txt`, `BUILD.json`, `SHA256SUMS`. Executable archive modes
are 0755; text modes are 0644. All uid/gid and timestamps are zero. The archive
uses a closed ustar header representation, exactly two terminal zero blocks and
a canonical level-nine gzip stream. The encoder fixes the gzip OS byte to Unix
on both native hosts; the [gzip format](https://www.rfc-editor.org/rfc/rfc1952)
defines that byte as compressor metadata. Incoming headers remain strict and
are never rewritten. The parser rejects other archive
representations, including links, traversal names, duplicates, extensions,
extra padding or concatenated gzip members. Input and decompressed sizes are
bounded by the existing package-member limits. No archive is extracted during
validation.

The `kizuki.release-download/v1` manifest binds the source, target, Bun version,
archive name/length/hash, all seven member lengths/hashes, exact V3 proof
length/hash and distribution inventory identity/status. It contains no local
input paths, URLs, repository identifiers or release tag. Source-SHA naming
avoids claiming a version/tag binding absent from BUILD/v2. Tag and public-route
verification belong to a later publication boundary.

The existing BUILD/v2 and artifact-proof/v3 parsers validate the package,
notices and engine observations. The complete archive is parsed independently
and rebound to that package/proof before output is created. A self-consistent
replacement of SHA256SUMS cannot replace bytes already bound by the retained
V3 receipt. Output contains archives and the public manifest; raw proof receipts
remain in their original custody and are referenced by digest.

For readback, `parseDownloadManifest(bytes, expectedSource)` validates the closed
manifest. `verifyDownloadArchive(manifest, target, archiveBytes, proofBytes)`
checks the transport, all seven members, notices and V3 binding. These checks
establish integrity and receipt consistency; they do not independently attest
execution, actor identity or release authority. Legacy package and proof formats
remain consumable by existing tools but are not accepted by this new preparer.

Supply the expected source SHA and target independently of the manifest. Bound
local reads, then call the existing parsers:

```sh
bun scripts/verify-retained-download-example.ts \
  --source SOURCE_SHA --target TARGET \
  --manifest /absolute/download-manifest.json \
  --archive /absolute/kizuki-SOURCE_SHA-TARGET.tar.gz \
  --proof /absolute/artifact-proof.json
```

The example reports `integrity_ok` only after those bindings pass. It does not
extract the archive, execute binaries, download files, rebuild, sign, publish or
change release approval.

## Verification and limits

Run `bun test scripts/release-download.test.ts` and the repository typecheck.
The focused tests use labelled synthetic schema packages and never claim those
packages were compiled or executed. Release preparation also requires a separate
round trip of an actual retained compiled package through the generated archive,
manifest verifier and native archive consumer, with all seven hashes unchanged.

A complete notice inventory is not a distribution assessment. Unresolved materials
remain explicit, and even a complete inventory cannot make this manifest approve
release. macOS signing, notarization and normal downloaded-app launch remain
separate requirements; this tool never removes quarantine or bypasses operating
system checks. There is no public download, shell installer, PATH update, service
action, automatic update or acceptance-gate promotion in this preparation step.
