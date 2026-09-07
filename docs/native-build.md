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

New packages contain `kizuki`, `kizuki-mcp`, `README.txt`, `LICENSE`,
`THIRD-PARTY-NOTICES.txt`, `BUILD.json`, and `SHA256SUMS`. The manifest hashes
the preceding six files. Build V2 records source SHA, target, pinned Bun
revision and material inventory from both actual compile graphs. Unresolved
notice, embedded-asset and source information remains explicit; distribution
has not been assessed. Legacy five-file Build V1 packages remain readable. The build refuses to
overwrite an existing target and stages output before publishing it.

`bun run smoke:release` exercises the built package with a synthetic vault. It
proves version/help, init with `--no-service`, Markdown import, query, context
packet, one no-HTTP serve pass, and MCP initialization plus `tools/list`.

`bun run proof:artifact -- --report /tmp/kizuki-artifact-proof` copies the
checksummed package out of the checkout, uses a clean home and Kizuki config,
and records a v3 receipt for new packages (v2 for legacy packages) covering init, the copied CLI and MCP SQLite identities,
import, query, context, export, and clean-target restore. Both child engine
identities must agree with the exact qualification policy. See the
[engine evidence contract](stranger-proof.md#effective-sqlite-engine-evidence).
Linux CI retains this package and its available receipt for seven days.

## Support boundary

The closed native registry implements `bun-linux-x64-baseline` (Linux x86_64,
including older baseline CPUs) and `bun-darwin-arm64` (macOS Apple Silicon).
Each package still needs qualification on its exact native host and revision.
macOS remains a candidate until the required copied-artifact and installed-service
checks pass. Intel macOS, Windows and other targets are unsupported. Each executable bundles Kizuki code, workspace
dependencies and the Bun runtime. It is not statically linked, signed, published
or qualified by an unfamiliar human.

Canon byte writes have native descriptor backends for Linux x64/glibc and
macOS arm64. Both retain directory and file identity checks; unsupported hosts
or unavailable native adapters return a typed refusal without a pathname
fallback. The Darwin adapter is implemented, but its presence alone does not
qualify every canon-writing workflow in a copied executable.

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

`.github/workflows/macos-native.yml` is manual-only. It requires an exact
ancestor `base_sha` and binds the checkout to the dispatch SHA. The
`existing_allowance_verified` input defaults to false and gates every job;
verify existing allowance and spending limits before dispatch.

The default `native-arm64` job uses a standard `macos-15` arm64 runner. It runs
native filesystem, lock, config, terminal, plist and consumer tests, builds
both binaries, and executes the copied package outside the checkout. This
job's plist test does not load a service. `native_adapter_only` selects a
separate bounded Darwin adapter canary instead of the full product checks.

`native_lifecycle_only` selects the `native-service` matrix on `ubuntu-24.04`
and `macos-15`. It runs the native consumer tests and copied-artifact proof,
then `scripts/native-service-lifecycle.ts` exercises a temporary owned user
service through systemd or launchd. That includes real service installation,
fresh rail health, repeat installation, crash restart, public graceful stop,
uninstall, and installation from a replacement path containing the same
package bytes. Failed activation rollback is tested through the native API;
stopped-vault import, query, export and restore check continued data access.
Cleanup checks the owned process and unit before removing the fixture.

The workflow retains packages and synthetic receipts for seven days, including
lifecycle failure receipts. Inspect those exact-revision receipts for current
results. Neither job signs or notarizes binaries, publishes a release, tests a
cross-version upgrade, or proves an unfamiliar user's onboarding. Service
restart checks do not reboot the host. macOS qualification remains pending
until its required native gates pass; Linux results cannot supply that proof.

The shared lock uses the OS system library on each target and keeps its native
advisory locking and stable-inode ownership protocol. `readBootId()` reads the
Linux kernel boot ID or the native `kern.bootsessionuuid` value on macOS arm64.
Unavailable or malformed native identity falls back conservatively to a PID
string; that fallback cannot establish a boot-session UUID. The native Mac
consumer check compares the implementation across processes with the OS value.
Simulated changed-boot lease recovery and actual host-reboot evidence remain
distinct checks.
