# Native local package

Kizuki can produce a local native package from this checkout. It is not a
registry package, release signature, or proof of a supported 1.0 installer.
The [artifact isolation proof](stranger-proof.md) adds deterministic evidence
outside the checkout, but is not a human stranger proof.

## Build and verify

Use the Bun version recorded in `.bun-version`; the build refuses a different
runtime. CI builds and smoke-tests the native package after the repository gate.

```bash
bun install --frozen-lockfile
bun run build:release
cd dist/kizuki-0.1.0/bun-linux-x64-baseline
sha256sum -c SHA256SUMS
./kizuki --help
./kizuki init ./vault --no-service
./kizuki-mcp --vault ./vault --owner
```

The package contains `kizuki`, `kizuki-mcp`, `README.txt`, `BUILD.json`, and
`SHA256SUMS`. The checksum manifest covers the four package files. `BUILD.json`
records the exact source SHA, target, and Bun runtime. The build refuses to
overwrite an existing target and stages output before publishing it.

`bun run smoke:release` exercises the built package with a synthetic vault. It
proves version/help, init with `--no-service`, Markdown import, query, context
packet, one no-HTTP serve pass, and MCP initialization plus `tools/list`.

`bun run proof:artifact -- --report /tmp/kizuki-artifact-proof` copies the
checksummed package out of the checkout, uses a clean home and Kizuki config,
and records a v2 receipt for init, the copied CLI and MCP SQLite identities,
import, query, context, export, and clean-target restore. Both child engine
identities must agree with the exact qualification policy. See the
[engine evidence contract](stranger-proof.md#effective-sqlite-engine-evidence).
Linux CI retains this package and its available receipt for seven days.

## Support boundary

The closed native registry implements `bun-linux-x64-baseline` (Linux x86_64,
including older baseline CPUs) and `bun-darwin-arm64` (macOS Apple Silicon).
Linux x64 has local qualification evidence; macOS arm64 remains an unqualified
candidate until an actual native receipt exists. Intel macOS, Windows and other
targets are unsupported. Each executable bundles Kizuki code, workspace
dependencies and the Bun runtime. It is not statically linked, signed, published
or qualified by an unfamiliar human.

Canon byte writes require the Linux x64/glibc descriptor backend. The writer
returns a typed refusal on macOS and other unsupported native backends, with
no pathname fallback. The macOS build target therefore does not currently
qualify canon-writing workflows. A macOS implementation and copied-executable
proof remain required; the build registry alone does not establish support.

The binaries do not automatically load `.env` or `bunfig.toml`. They do not
contact a network endpoint by themselves. Network access remains limited to
explicitly configured connectors and model endpoints. Local GGUF model files
are not packaged. The embedded PostgreSQL/pgvector retrieval implementation
and tokenizer are bundled; their presence does not configure a model or fetch
model weights.

Use `bun packages/cli/src/main.ts` and `bun packages/mcp/src/bin.ts` from a
source checkout. Use `./kizuki` and `./kizuki-mcp` from the native package.
If `kizuki serve --install` creates a user service, run it from the binary's
final path; moving the executable later leaves that service pointing at the
old path.

## Manual macOS candidate gate

The closed build registry accepts native Linux x64 baseline and native macOS
Apple Silicon (`bun-darwin-arm64`). Build and proof refuse host/target mismatch;
Intel macOS and other targets remain unsupported. The selected native host is
the default; `KIZUKI_TARGET` can explicitly select only its matching registry
entry. macOS checksums use `shasum -a 256 -c SHA256SUMS`.

`.github/workflows/macos-native.yml` is manual-only, with one standard
`macos-15` arm64 runner and a 15-minute timeout. It requires an exact ancestor
`base_sha` and binds the checkout to the actual dispatch SHA. The default-false
`existing_allowance_verified` input must remain false until existing allowance
and spending limits prove that this run and artifact retention add no cost.
Usage showing zero billed cost is not proof of remaining allowance. No runner
was started as part of preparing this change.

The job runs native filesystem, lock, config, terminal and plist checks, builds
both binaries, and executes the package outside the checkout. It retains the
package and content-free synthetic proof receipt in this repository for seven
days. It does not load a launchd service, sign/notarize binaries, publish a
release, or count as installed-service or human stranger evidence. Actual macOS
execution is still a required verification gate until an exact-head receipt
exists. Linux validation does not supply that receipt.

The shared lock uses the OS system library on each target and retains the same
native advisory locking and stable-inode ownership protocol. macOS daemon boot
identity currently falls back to a PID string; this does not satisfy the strict
calendar qualification UUID contract. macOS calendar qualification remains
unqualified and no synthetic boot identity is generated here.
