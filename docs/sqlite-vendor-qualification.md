# Apple SQLite qualification evidence

Observed 7 September 2026 on the standard macOS 15 arm64 runner. Policy v2
admits only the exact observed target, Bun version, kernel and SQLite pair.
This is vendor identity qualification for the existing engine proof contract;
it does not establish release acceptance or audit Apple's private source changes.

## Native observation

Run `34106510331`, job `101692661138`, source
`1baead1b6a19b7b55cbcf23c31ee2c3fbf709421` produced one successful
`scripts/native-sqlite-vendor.test.ts` observation. The fixed read-only command
`/usr/bin/codesign --verify --strict -R '=anchor apple' /usr/bin/sqlite3`
passed. [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
documents inline requirement syntax and the Apple anchor. The command uses the
Apple-code anchor, without substituting the broader Apple-issued-signature anchor.

The system CLI hash was checked before and after its SQLite query. Its runtime
identity matched Bun's in-memory SQLite query. The independently read SDK header
also matched. SDK metadata alone is not a runtime observation.

- Target: `bun-darwin-arm64`; Bun `1.3.14`; kernel `24.6.0`.
- Observed macOS product/build: `15.7.9` / `24G830`.
- SQLite version: `3.43.2`.
- SQLite source ID: `2023-10-10 13:08:14 1b37c146ee9ebb7acd0160c0ab1fd11017a419fa8a3187386ed8cb32b709aapl`.
- System CLI SHA-256: `1879b8999e1a368091d1111272676bd0ef3c66d663970e8d69dc91ec64d443c3`.
- SDK version: `15.5`; sqlite3.h SHA-256: `d6227599d7e32e142ce33b5648e06335dd8c0c82e7e4d41592ed6fedd42ba7f4`.

The exact public [job log](https://api.github.com/repositories/1353875622/actions/jobs/101692661138/logs)
SHA-256 is `2baf962a06f48cd0deb5a009c87fc37ae36ee294fa2706d69d64fcfea9b7f71f`. The sorted-key compact JSON observation, encoded as UTF-8
with one trailing newline, has SHA-256 `00f40816d4873abc7a18f6940958c254c90bdf5cca87fd00f2b324b8b465a2d1`.
The job also passed the native migration, FTS5 conformance/rebuild, FTS5 erasure,
ledger lifetime and privacy consumers. Eight archive encoder tests failed, so
this run is not a successful native lifecycle qualification.

An earlier native copied-package run `34102940818`, source
`5d4c9870797607e22d25e30bdda37a879aba9d69`, observed the same SQLite pair in
both actual compiled executables and passed all sixteen journey steps. Its proof
remained unqualified under the prior policy. It is historical behavior evidence;
a new candidate still needs its own exact copied-executable proof.

## Scope and source limits

[Pinned Bun documentation](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/docs/runtime/sqlite.mdx)
explains that macOS uses system SQLite and describes the Apple version as
proprietary. The [upstream 3.43.2 release](https://www.sqlite.org/releaselog/3_43_2.html)
has a different source ID and is not the source record for this Apple build.
No exact Apple open-source commit was located; this entry does not assert one.

The proof matches runtime identity strings, executable hashes, target, Bun and
kernel. It does not measure the path/hash of Bun's loaded library, identify
Apple's patches or backports, or verify a future device's product/build version.
The product/build, system CLI and SDK hashes above describe this observation;
they are not fields measured by artifact proof V3. An independently malicious
binary can report false strings, so source review and trusted native execution
remain necessary. Changes outside the exact policy require fresh qualification;
there is no version-range fallback.
