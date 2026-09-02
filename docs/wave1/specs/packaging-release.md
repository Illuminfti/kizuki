# Lane: packaging-release — tag-triggered releases: five compiled targets, install.sh, Homebrew formula, npm package, checksums + SBOM + attestations, notes from merged PRs

Scope: `scripts/build.ts` (one target added, one helper), NEW `scripts/release/`
(the release tooling and its tests), NEW `packaging/` (installer template,
Homebrew formula template, npm bin wrapper, npm README, a verbatim copy of the
Bun runtime license), NEW `.github/workflows/release.yml`, NEW
`.github/release.yml`, `scripts/verify.sh` (two accessor functions and one
assertion; `main` semantics unchanged), `scripts/verify-policy.test.sh` (one
case), `scripts/verify-network.ts` (scan `packaging/` too), root
`package.json` (one script), `packages/cli/src/commands/version.ts` (`--json`),
README "Install", NEW `docs/releasing.md`. Read CONVENTIONS.md first, then in
this order: `AGENTS.md` ("Never merge, deploy, publish, create releases …
without explicit authority" — this lane builds the machinery; the owner pushes
the tag), `.agents/skills/release-readiness/SKILL.md`,
`.agents/skills/dependency-evaluation/SKILL.md`,
`.agents/skills/security-privacy-review/SKILL.md`, `docs/architecture.md`
(invariants 6, 8, 10; "Project-owned app credentials are compiled in"),
`rfcs/0000-constraints.md` §8–9, the fuller design in
`workspace/kizuki-plan/ARCHITECTURE.md` §1 (Distribution: compiled single
binary via GitHub releases + install script + Homebrew tap; `npm i -g kizuki`
/ `bunx kizuki` as the registry path), §10 ("No update checks; the binary
prints its version, the repo announces releases"), §12 ("Releases:
tag-triggered GO/NO-GO script only; never manual, never green-over-red").
Then the real code you compose: `scripts/verify.sh`, `scripts/verify-network.ts`

- its test, `scripts/verify-policy.test.sh`, `.github/workflows/ci.yml`,
  `packages/cli/src/main.ts`, `packages/cli/package.json`, `bun.lock` (the
  lockfile format §5 parses), `LICENSE`, and — on the branch you start from —
  `scripts/build.ts` + `scripts/build.test.ts`, `scripts/quickstart.sh`,
  `packages/core/src/app-credentials.ts`, `packages/cli/src/commands/version.ts`
  and `packages/cli/test/helpers.ts` (all NEW in the lanes below).

Reconciled against `main` at `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; bun 1.3.14 locally, CI pins 1.3.10). Every fact marked "verified"
below was run on this box on that date.

Depends on **cli-verbs** (command modules, `packages/cli/package.json`
`"version"`, `version` verb reading it, `runCli(env, …)` test helper) and
**ci-hardening** (`scripts/build.ts` with `COMPILE_TARGETS`, `BuildInfo`,
`buildArgs`, `collectBuildCredentials`, `build()`; `dist/build-info.json`;
`packages/core/src/app-credentials.ts` with `APP_CREDENTIAL_GROUPS`,
`AppCredentialName`, `AppCredentialGroup`; `scripts/quickstart.sh --binary
--isolate`; `.bun-version`; the SHA-pinned `ci.yml`; `scripts/network-allowlist.txt`
and `scanTrackedSources`). Both must be merged first. Nothing here depends on
serving-mcp, cli-wave2 or the connector lanes: whatever runtime packages they
add to `bun.lock` flow into the SBOM, notices and bundles automatically.

## Already on main (do not redo; compose)

- `scripts/verify.sh` is the full gate: frozen install, typecheck, `bun test`,
  policy tests, network scan, phone-home dependency grep, identifier denylist
  over tracked text, tracked paths and every reachable commit message,
  attribution spelling. The two regexes live as split-quoted locals inside
  `main()`; §8 hoists them into functions without changing their spelling.
- `scripts/verify-network.ts` scans `git ls-files -- packages`; §7 widens the
  pathspec to `packages packaging` so the npm wrapper is scanned too.
- `packages/cli/package.json` has `"bin": { "kizuki": "src/main.ts" }` and no
  `"version"` (cli-verbs adds `"version": "0.1.0"`). No package in the tree
  has a `"version"` field today. `.gitignore` ignores `dist/`.
- `git tag -l` is empty; the GitHub repository has no releases and no
  configured Actions secrets (`gh release list`, `gh secret list` on
  2026-09-02). `npm view kizuki` returns E404: the name is unclaimed.
- Verified on bun 1.3.14: `bun build --compile --target=bun-windows-x64
--outfile ./x` writes `./x.exe` (the runtime appends `.exe`; the docs say so
  for every Windows target); a cross-target compile downloads that target's
  bun runtime (`Downloading [31504257]` …) — the only network use of the
  build; `bun build --target=bun` keeps a `#!/usr/bin/env bun` shebang from
  the entry and inlines `import pkg from "./package.json"` (the version
  string is a literal in the bundle); `Bun.JSONC.parse` exists and parses
  `bun.lock` (trailing commas) — `Bun.file(...).json()` does not;
  `bun --no-env-file` exists and stops the runtime reading `.env` from the
  cwd (`bun x.js` in a directory with `.env` otherwise loads it — verified);
  `Bun.isStandaloneExecutable` is `undefined` at 1.3.14 — do not use it;
  `bun publish` has `--access`, `--tag`, `--otp`, `--dry-run` and no
  provenance flag; `gh api -X POST repos/<repo>/releases/generate-notes`
  returns `{ name, body }` built from merged PRs without creating anything.
- GitHub-hosted runner labels checked 2026-09-02 (actions/runner-images
  README): `ubuntu-latest` (24.04, x64), `ubuntu-24.04-arm` (arm64),
  `macos-latest` (arm64), `macos-15-intel` (x64), `windows-latest` (x64).
  arm64 Linux runners are free for public repositories only (§10 note).
- npm trusted publishing (docs.npmjs.com/trusted-publishers, 2026-09-02):
  needs `id-token: write`, npm CLI ≥ 11.5.1 on Node ≥ 22.14, provenance is
  generated automatically for a public package from a public repository, no
  token; configured on npmjs.com with owner, repository, workflow filename
  and (optionally) environment.

## The one constraint that shapes every path below

The repository slug (`<owner>/kizuki`) matches the tracked-text identifier
denylist that `scripts/verify.sh` enforces over every tracked file and
commit message. Consequently **no tracked file may contain the repository
URL, the owner login, the install one-liner, the `brew` tap line or a
`repository` field**. Every artifact that needs the slug is rendered at
release time from `${{ github.repository }}` (workflow) or `--repo` (scripts)
into untracked `dist/` output; templates carry `@REPO@`; README describes the
channels relative to "this repository's Releases page"; the release notes
(untracked, generated) carry the copy-pasteable lines. Tests use the fixture
slug `acme/kizuki`. If you find yourself typing the real slug into a tracked
file, stop: CI will reject it.

## Objective

A `v<version>` tag pushed to `main` produces — with no human step after the
push — a GitHub release holding five compiled binaries (linux-x64,
linux-arm64, darwin-x64, darwin-arm64, windows-x64) as archives,
`checksums.txt`, `sbom.cdx.json`, `THIRD_PARTY_NOTICES.txt`,
`build-info.json`, a rendered `install.sh`, a rendered Homebrew formula and
release notes generated from the merged pull requests; the same version on
npm as `kizuki` (a Bun-run bundle behind a bin wrapper); optionally a commit
to a Homebrew tap. The release is GO only when the full repository gate and
the stranger loop pass on the exact tagged commit, the tag equals the package
version and the commit is on `main` — never green-over-red, never manual.
Project-owned app credentials are embedded from Actions secrets by the one
door ci-hardening built; missing secrets mean placeholder binaries whose
`doctor` and release notes say so. Nothing this lane ships phones home: the
installer fetches exactly the release files, the binary has no update check,
the npm package has no install scripts.

## 1. Targets — `scripts/build.ts` (edit)

```ts
export const COMPILE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64", // NEW
] as const;

/** NEW. The runtime appends .exe for Windows targets; name the outfile so
 *  build-info and the assets step agree on the path that actually exists. */
export function outfileFor(
  outDir: string,
  target: CompileTarget | null,
): string;
// join(outDir, target === null ? "kizuki" : `kizuki-${target}`) + (target === "bun-windows-x64" ? ".exe" : "")
```

`build()` uses `outfileFor` for `--outfile` and for the `built <outfile>
target=<t>` line; `buildArgs` is unchanged (its exact-argv test stays green);
`--all-targets` now means five. `BuildInfo.targets` lists the five target
names. `scripts/build.test.ts` gains: `COMPILE_TARGETS` has exactly five
entries ending in `bun-windows-x64`; `outfileFor(d, "bun-windows-x64")` ends
in `kizuki-bun-windows-x64.exe`; `outfileFor(d, "bun-linux-x64")` does not
end in `.exe`; `outfileFor(d, null)` is `<d>/kizuki`. ci-hardening's CI
`compile` job keeps smoking `dist/kizuki-bun-linux-x64`; no change there.

## 2. Layout — `scripts/release/` (NEW) and `packaging/` (NEW)

```
scripts/release/
  main.ts        # subcommand dispatch: gate | assets | npm | notes; exit codes; nothing else
  gate.ts        # tag grammar, GO/NO-GO decision (pure)
  tar.ts         # deterministic ustar + gzip writer (pure)
  archive.ts     # platform names, asset names, checksums, writeAssets
  lockfile.ts    # bun.lock parser + runtime closure (pure)
  sbom.ts        # CycloneDX 1.6 document (pure)
  notices.ts     # THIRD_PARTY_NOTICES.txt from node_modules + packaging/BUN_LICENSE
  render.ts      # @PLACEHOLDER@ templates: install.sh, kizuki.rb (pure)
  npm.ts         # stage dist/npm: bundle, wrapper, manifest
  notes.ts       # previous tag, repository masking, notes composition (pure)
  *.test.ts      # one per module + workflow.test.ts + install.test.ts
  install.test.sh
packaging/
  install.sh.tmpl        # POSIX sh installer; @REPO@
  homebrew/kizuki.rb.tmpl # formula; @VERSION@ @REPO@ @SHA_*@
  npm/bin/kizuki.js      # the bin wrapper (ESM, runs under node or bun)
  npm/README.md          # what the npm package is and that it needs Bun
  BUN_LICENSE            # verbatim copy of the Bun runtime's LICENSE at the pinned bun tag
```

Root `package.json` scripts: add `"release": "bun scripts/release/main.ts"`.
Call the script directly in documentation and CI (`bun run <script> --flag`
is eaten by bun's flag parser at 1.3.14 — ci-hardening observed the same).
`tsconfig.json` already includes `scripts/**/*.ts`, so every module here is
typechecked and every `*.test.ts` runs under `bun test`.

Grammar (`main.ts`; unknown subcommand or option → usage on stderr, exit 2;
any thrown error → `error: <message>` on stderr, exit 1; `--repo` must match
`/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/` and `--tag`
must satisfy §3 — both fail closed when absent; nothing is read from
`GITHUB_*` implicitly):

```
bun scripts/release/main.ts gate   --tag TAG [--main-ref origin/main]
bun scripts/release/main.ts assets --tag TAG --repo OWNER/NAME [--dist dist] [--out dist/release]
bun scripts/release/main.ts npm    --tag TAG --repo OWNER/NAME [--out dist/npm]
bun scripts/release/main.ts notes  --tag TAG --repo OWNER/NAME [--release-dir dist/release] [--out dist/release/notes.md] [--body-file FILE] [--tap]
```

Nothing under `scripts/release/` prints, logs, serializes or reads a
credential value; the only credential-adjacent data is the boolean
`embedded` map from `build-info.json`.

## 3. GO/NO-GO — `gate.ts`

```ts
export const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
export type Channel = "stable" | "prerelease";
export interface ParsedTag {
  tag: string;
  version: string;
  channel: Channel;
}
export class GateError extends Error {}
export function parseTag(tag: string): ParsedTag;
// GateError `tag ${tag} is not v<major>.<minor>.<patch>[-(alpha|beta|rc).<n>]`; version = tag without the leading v

export interface GateInput {
  tag: string;
  packageVersion: string; // packages/cli/package.json "version"
  bunVersion: string; // Bun.version
  pinnedBun: string; // .bun-version, trimmed
  headOnMain: boolean;
  treeClean: boolean;
}
export interface GateDecision {
  go: boolean;
  version: string;
  channel: Channel;
  reasons: string[];
}
export function evaluateGate(input: GateInput): GateDecision; // pure; every failing check appends one reason, exact text:
//   `tag ${tag} does not match packages/cli/package.json version ${packageVersion}`
//   `bun ${bunVersion} is not the pinned ${pinnedBun} (.bun-version)`
//   `tagged commit is not on main`
//   `working tree is not clean`
```

`main.ts gate` gathers the inputs: package version via
`Bun.file("packages/cli/package.json").json()` (throws `packages/cli/package.json
has no version` when absent — same rule as ci-hardening's `build()`),
`.bun-version` text, `git merge-base --is-ancestor HEAD <main-ref>` (exit 0
→ true; the workflow fetches `origin/main` first), `git status --porcelain`
empty. Prints `GO <tag> version=<v> channel=<c>` (exit 0) or `NO-GO <tag>`
followed by one `reason: <text>` line per reason (exit 1). When
`GITHUB_OUTPUT` is set, appends `version=<v>`, `channel=<c>` and
`prerelease=true|false` to it on GO. The release workflow (§10) runs `bun run
verify` in the same job before this; a red gate never reaches `gate`.

## 4. Archives and checksums — `tar.ts`, `archive.ts`

The archives are written in TypeScript so that every release run yields
byte-identical archives for identical inputs (no GNU-vs-BSD tar, no
timestamps from the runner clock): a ustar writer over `Bun.gzipSync`.

```ts
// tar.ts
export interface TarEntry {
  name: string;
  bytes: Uint8Array;
  mode: 0o644 | 0o755;
  mtime: number; /* unix seconds */
}
export function createTar(entries: readonly TarEntry[]): Uint8Array;
// ustar: uid/gid 0, uname/gname "", typeflag '0', 512-byte blocks, two zero blocks at the end;
// throws on: name longer than 100 bytes, absolute name, a ".." segment, duplicate name, size ≥ 8 GiB
export function createTarGz(entries: readonly TarEntry[]): Uint8Array; // Bun.gzipSync(createTar(entries), { level: 9 })
```

```ts
// archive.ts
export const RELEASE_PLATFORMS = {
  "bun-linux-x64": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
  "bun-darwin-x64": "darwin-x64",
  "bun-darwin-arm64": "darwin-arm64",
  "bun-windows-x64": "windows-x64",
} as const satisfies Record<CompileTarget, string>;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[CompileTarget];
export function assetName(version: string, platform: ReleasePlatform): string; // `kizuki-v${version}-${platform}.tar.gz`
export function binaryName(target: CompileTarget): string; // "kizuki.exe" for bun-windows-x64, else "kizuki"
export interface ChecksumLine {
  sha256: string;
  file: string;
}
export function sha256Hex(bytes: Uint8Array): string; // Bun.CryptoHasher("sha256")
export function formatChecksums(lines: readonly ChecksumLine[]): string;
// sorted by file (codepoint order), `${sha256}  ${file}\n` — two spaces: the format `sha256sum -c` and `shasum -a 256 -c` read
export function parseChecksums(text: string): ChecksumLine[]; // throws on a malformed line or a duplicate file
export interface AssetsInput {
  distDir: string; // where build.ts wrote kizuki-<target>[.exe] and build-info.json
  outDir: string; // created; must not exist or be empty (fail closed like exportVault)
  version: string;
  buildInfo: BuildInfo; // read and validated by main.ts: schema kizuki.build-info/v1, targets exactly COMPILE_TARGETS (any order), version === tag version
  licenseText: string; // LICENSE
  notices: string; // §5
  sbom: string; // §5, pretty JSON + newline
}
export async function writeAssets(
  input: AssetsInput,
): Promise<{ files: string[]; checksums: ChecksumLine[] }>;
```

`writeAssets` order: one archive per target (entries, in this order:
`kizuki`/`kizuki.exe` 0755, `LICENSE` 0644, `THIRD_PARTY_NOTICES.txt` 0644;
`mtime = Math.floor(Date.parse(buildInfo.built_at) / 1000)`), then
`sbom.cdx.json`, `THIRD_PARTY_NOTICES.txt`, `build-info.json` (byte copy),
then the rendered `install.sh` and `kizuki.rb` (§6 — the formula needs the
archive digests), then `checksums.txt` over every file in `outDir` except
itself. It prints one `asset <file> sha256=<hex> bytes=<n>` line per file and
returns the sorted list. A missing binary for any target is an error naming
the target (a release never ships four of five).

## 5. SBOM and notices — `lockfile.ts`, `sbom.ts`, `notices.ts`

`bun.lock` is JSONC (verified: trailing commas). Its shape at
`lockfileVersion: 1`: `workspaces["<path>"] = { name, dependencies?,
devDependencies?, bin? }` and `packages["<key>"] = ["<name>@<version>",
"<registry or empty>", { dependencies?, optionalDependencies?,
peerDependencies?, … }, "<integrity>"]` for registry packages or
`["<name>@workspace:<path>"]` for workspace members; a key may be nested
(`"<parent>/<dep>"`) when two versions of one package coexist.

```ts
// lockfile.ts
export interface LockPackage {
  key: string;
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  integrity: string | null;
  workspace: string | null; // workspace path for "workspace:" entries
}
export interface Lockfile {
  workspaces: Record<
    string,
    { name: string; dependencies: Record<string, string> }
  >;
  packages: Record<string, LockPackage>;
}
export function parseLockfile(text: string): Lockfile; // Bun.JSONC.parse; throws unless lockfileVersion === 1
export function runtimeClosure(
  lock: Lockfile,
  workspacePath: string,
): LockPackage[];
// breadth-first from workspaces[workspacePath].dependencies through dependencies + optionalDependencies
// (never devDependencies, never peerDependencies); resolve `${parentKey}/${dep}` before `${dep}`;
// a "workspace:" dependency recurses into that workspace's dependencies and is not emitted;
// result sorted by (name, version); throws `unresolved dependency ${dep} of ${parent}`
```

```ts
// sbom.ts
export interface SbomInput {
  version: string;
  bun: string;
  commit: string | null;
  components: readonly LockPackage[];
  timestamp: string;
  serialNumber: string; // injected for determinism in tests
}
export function buildSbom(input: SbomInput): Record<string, unknown>;
// CycloneDX 1.6 JSON: bomFormat "CycloneDX", specVersion "1.6", serialNumber `urn:uuid:${serialNumber}`, version 1,
// metadata: { timestamp, component: { type: "application", name: "kizuki", version, purl: `pkg:npm/kizuki@${version}`,
//   licenses: [{ license: { id: "MIT" } }], ...(commit ? { properties: [{ name: "kizuki:commit", value: commit }] } : {}) } },
// components: [ { type: "application", name: "bun", version: bun, purl: `pkg:github/oven-sh/bun@bun-v${bun}`, licenses: [{ license: { id: "MIT" } }] },
//   ...one { type: "library", name, version, purl: `pkg:npm/${purlName}@${version}`, hashes: [{ alg: "SHA-512", content: hex }] } per component
//   (purlName percent-encodes the "@" of a scope; hashes omitted when integrity is null) ]
```

`notices.ts`:

```ts
export interface Notice {
  name: string;
  version: string;
  license: string;
  text: string | null;
}
export function readNotice(nodeModulesDir: string, pkg: LockPackage): Notice;
// license from node_modules/<name>/package.json ("license" string or { type }); text from the first of
// LICENSE, LICENSE.md, LICENSE.txt, LICENCE, LICENCE.md, LICENCE.txt (case-insensitive); throws
// `no license metadata for ${name}@${version}` when neither the field nor a file exists (a release never ships an unlicensed notice)
export function renderNotices(
  bunVersion: string,
  bunLicense: string,
  notices: readonly Notice[],
): string;
// header naming the product and version-independent wording, then the Bun block (verbatim packaging/BUN_LICENSE),
// then per package "----\n<name> <version> — <license>\n\n<text or "(the package ships no license file; see its registry page)">\n"
```

`packaging/BUN_LICENSE` is a byte-for-byte copy of the Bun repository's
`LICENSE` at tag `bun-v<.bun-version>`; `docs/releasing.md` records which tag
it was copied from, and bumping `.bun-version` includes refreshing this file.
The closure is computed for `packages/cli` (what the binary and the npm bundle
contain). On today's main the closure is empty and the notices file contains
only the Bun block — honest, and it grows automatically when serving-mcp and
connector-telegram land their runtime packages.

## 6. Templates — `render.ts`, `packaging/install.sh.tmpl`, `packaging/homebrew/kizuki.rb.tmpl`

```ts
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string;
// replaces every @NAME@ from vars; throws `unrendered placeholder @X@` if /@[A-Z0-9_]+@/ survives
export function installerVars(repo: string): Record<string, string>; // { REPO: repo }
export function formulaVars(
  version: string,
  repo: string,
  checksums: readonly ChecksumLine[],
): Record<string, string>;
// { VERSION, REPO, SHA_LINUX_X64, SHA_LINUX_ARM64, SHA_DARWIN_X64, SHA_DARWIN_ARM64 } from the four assetName() digests; throws when one is missing
```

### 6.1 `packaging/install.sh.tmpl`

POSIX `sh` (runs under `dash` and `bash`; `set -eu`; no bashisms, no `jq`,
no `python`). Header comment states: what it downloads (exactly the
release's `checksums.txt` and one archive; nothing else, ever), that it
sends nothing, and that it was rendered by the release workflow.

```
sh install.sh [--version vX.Y.Z] [--dir DIR] [--dry-run] [--help]
  KIZUKI_VERSION       same as --version (default: the latest stable release)
  KIZUKI_INSTALL_DIR   same as --dir (default: $HOME/.local/bin)
  KIZUKI_RELEASE_BASE  default https://github.com/@REPO@/releases; file:// is accepted (tests)
```

Behavior, in order: refuse to run if `KIZUKI_RELEASE_BASE` still contains
`@REPO@` (`this copy of install.sh was not rendered by the release workflow`,
exit 1); map `uname -s`/`uname -m` → `linux-x64` (Linux x86_64),
`linux-arm64` (Linux aarch64|arm64), `darwin-x64` (Darwin x86_64),
`darwin-arm64` (Darwin arm64); anything else → `unsupported platform <s>/<m>;
download the matching archive from the Releases page` exit 1 (Windows users
get the `windows-x64` archive by hand; `KIZUKI_INSTALL_UNAME_S` /
`KIZUKI_INSTALL_UNAME_M` override the probes for tests only and are
documented as such in the header); pick a downloader (`curl -fsSL --proto
'=https,file' --tlsv1.2` else `wget -qO-`; none → exit 1 naming both);
resolve the base URL: `<base>/download/<tag>/` when a version is given, else
`<base>/latest/download/` (GitHub's redirect for the latest non-prerelease);
`--dry-run` prints both URLs and exits 0 without network; download
`checksums.txt` and `kizuki-<tag>-<platform>.tar.gz` into `mktemp -d`;
`expected=$(grep " kizuki-…tar.gz$" checksums.txt | cut -d' ' -f1)` — empty
→ `checksums.txt has no entry for <file>` exit 1; `actual` via `sha256sum`
or `shasum -a 256`; mismatch → `checksum mismatch for <file>` exit 1 and the
temp dir is removed; `tar -xzf` into the temp dir; `install -m 0755 kizuki
"$DIR/kizuki"` (mkdir -p first); print `installed kizuki <version> to
<DIR>/kizuki` on stdout; if `$DIR` is not on `PATH`, print `add <DIR> to
PATH` on stderr; `"$DIR/kizuki" version` must print the expected version
when `--version` was given (mismatch → exit 1: a stale `latest` redirect or
a tampered archive both surface here). The version printed for `latest` is
whatever the installed binary reports. Trap cleans the temp dir on every
exit.

### 6.2 `packaging/homebrew/kizuki.rb.tmpl`

```ruby
class Kizuki < Formula
  desc "Your life, queryable as a CLI and MCP. Local-first, zero phone-home"
  homepage "https://github.com/@REPO@"
  version "@VERSION@"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/@REPO@/releases/download/v@VERSION@/kizuki-v@VERSION@-darwin-arm64.tar.gz"
      sha256 "@SHA_DARWIN_ARM64@"
    end
    on_intel do
      url "https://github.com/@REPO@/releases/download/v@VERSION@/kizuki-v@VERSION@-darwin-x64.tar.gz"
      sha256 "@SHA_DARWIN_X64@"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/@REPO@/releases/download/v@VERSION@/kizuki-v@VERSION@-linux-arm64.tar.gz"
      sha256 "@SHA_LINUX_ARM64@"
    end
    on_intel do
      url "https://github.com/@REPO@/releases/download/v@VERSION@/kizuki-v@VERSION@-linux-x64.tar.gz"
      sha256 "@SHA_LINUX_X64@"
    end
  end

  def install
    bin.install "kizuki"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/kizuki version").strip
  end
end
```

The rendered file is uploaded as a release asset (`brew install --formula
./kizuki.rb` works without a tap) and, when `HOMEBREW_TAP_TOKEN` is
configured, committed to `<owner>/homebrew-kizuki` at `Formula/kizuki.rb`
(§10). `ruby -c` must accept the rendered formula (ubuntu and macOS runners
ship ruby).

## 7. npm package — `npm.ts`, `packaging/npm/`

The registry path is a Bun-run bundle: `bun:sqlite` has no Node equivalent,
so the package requires Bun and says so in the one place npm lets it — the
bin wrapper's error message — instead of shipping five 95 MB platform
packages (non-goal). No `dependencies` (everything is bundled), no
`scripts`, no install hooks.

```ts
export const NPM_PACKAGE_NAME = "kizuki";
export function npmBundleArgs(
  entry: string,
  outfile: string,
  credentials: Partial<Record<AppCredentialName, string>>,
): string[];
// ["build", "--target=bun", "--format=esm", ...(Object.keys(credentials).length ? ["--define", `KIZUKI_BUILD_CREDENTIALS=${JSON.stringify(credentials)}`] : []), entry, "--outfile", outfile]
export function npmManifest(
  version: string,
  repo: string,
  bunPin: string,
): Record<string, unknown>;
// exactly: { name: "kizuki", version, description: "Your life, queryable as a CLI and MCP. Local-first, zero phone-home.",
//   license: "MIT", type: "module", bin: { kizuki: "bin/kizuki.js" }, files: ["bin", "lib", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
//   engines: { bun: `>=${bunPin}` }, repository: { type: "git", url: `git+https://github.com/${repo}.git` },
//   homepage: `https://github.com/${repo}#readme`, bugs: { url: `https://github.com/${repo}/issues` },
//   keywords: ["cli", "mcp", "local-first", "personal-knowledge", "markdown"], publishConfig: { access: "public" } }
export async function stageNpm(opts: {
  outDir: string;
  version: string;
  repo: string;
  bunPin: string;
  env: Record<string, string | undefined>; // collectBuildCredentials(env) — the npm bundle embeds exactly what the binaries embed
  expectedEmbedded: Record<AppCredentialGroup, boolean>; // from build-info.json; mismatch → throws `npm bundle embedding differs from build-info`
  licenseText: string;
  notices: string;
  bun?: string;
}): Promise<{ files: string[] }>;
// rm -rf outDir; bun build (Bun.spawnSync argv, no shell) → outDir/lib/kizuki.js; copies packaging/npm/bin/kizuki.js (mode 0755),
// packaging/npm/README.md, LICENSE, THIRD_PARTY_NOTICES.txt; writes package.json (pretty, newline);
// proves the stage: `bun --no-env-file outDir/lib/kizuki.js version` prints exactly version (else throws)
```

`packaging/npm/bin/kizuki.js` (ESM; runs under node ≥ 20 and under bun, so
`npm i -g` shims and `bunx` both work):

```js
#!/usr/bin/env node
// kizuki runs on Bun (bun:sqlite has no Node build); npm can only promise node, so hand off.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "kizuki.js",
);
// --no-env-file: a .env in the caller's cwd must not configure the product (same rule as the compiled binary).
const result = spawnSync(
  "bun",
  ["--no-env-file", bundle, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error !== undefined) {
  process.stderr.write(
    "kizuki: this package runs on Bun (https://bun.com) and no `bun` was found on PATH; install Bun or download the compiled binary from the Releases page.\n",
  );
  process.exit(127);
}
process.exit(result.status ?? 1);
```

`packaging/npm/README.md`: ten lines — what the package is, that it needs
Bun (`engines`), the two commands (`npm i -g kizuki` then `kizuki`; `bunx
kizuki`), that compiled binaries without a Bun requirement are on the
repository's Releases page, the zero-phone-home pledge. No slug.

Publishing (§10) uses `npm publish` (npm ≥ 11.5.1 via `actions/setup-node`,
Node 24) from `dist/npm`: with a trusted publisher configured on npmjs.com no
token is needed and provenance is automatic; otherwise `NODE_AUTH_TOKEN` from
the `NPM_TOKEN` secret with `--provenance`. `bun publish` stays the local
dry-run tool (`bun publish --dry-run` in `dist/npm`).

## 8. Release notes — `notes.ts`, `.github/release.yml`, `scripts/verify.sh`

```ts
export function previousTag(
  tags: readonly string[],
  current: ParsedTag,
): string | null;
// tags matching TAG_PATTERN only; the highest one below current by (major, minor, patch, prerelease);
// a stable current ignores prereleases; null when none
export function maskRepository(text: string, repo: string): string;
// case-insensitive replacement of the full slug with "<owner>/<name>" and of the owner login with "<owner>"
export interface NotesInput {
  tag: ParsedTag;
  repo: string;
  checksums: readonly ChecksumLine[];
  embedded: Record<AppCredentialGroup, boolean>;
  body: string;
  tap: boolean;
}
export function composeNotes(input: NotesInput): string;
```

`composeNotes` output, sections in this order, nothing else:

```
## Install
curl -fsSL https://github.com/<repo>/releases/download/<tag>/install.sh | sh
curl -fsSLO https://github.com/<repo>/releases/download/<tag>/kizuki.rb && brew install --formula ./kizuki.rb
brew install <owner>/kizuki/kizuki            ← only when tap === true
npm i -g kizuki@<version>   (needs Bun)  ·  bunx kizuki@<version> version
Windows: download kizuki-<tag>-windows-x64.tar.gz, `tar -xzf` it (Windows 10 1803+ ships tar), run kizuki.exe.

## Verify
<one `<sha256>  <file>` line per archive, from checksums>
sha256sum -c --ignore-missing checksums.txt   (macOS: shasum -a 256 -c --ignore-missing)
gh attestation verify kizuki-<tag>-<platform>.tar.gz --repo <repo>   (gh ≥ 2.49)

## Sign-in support in these builds
telegram: embedded | placeholder   google: … x: … whoop: …
(placeholder = `kizuki connect <service>` refuses in these builds; run `kizuki doctor` to see the same line locally.)

## What's changed
<body verbatim>

sbom.cdx.json (CycloneDX 1.6), THIRD_PARTY_NOTICES.txt and build-info.json are attached to this release.
```

`main.ts notes`: reads `build-info.json` and `checksums.txt` from
`--release-dir`; body from `--body-file` when given, else from `gh api -X POST
repos/<repo>/releases/generate-notes -f tag_name=<tag> -f
target_commitish=<git rev-parse HEAD> [-f previous_tag_name=<previousTag(git
tag -l)>]` (`Bun.spawnSync(["gh", …])`; `gh` authenticates from `GH_TOKEN`;
a non-zero exit is an error with gh's stderr). Then the gate: writes
`maskRepository(body, repo)` to `<release-dir>/notes-body.masked.md` and runs
`bash -c 'source "$1" && assert_release_text_clean "$2"' _ scripts/verify.sh
<that file>`; non-zero → error `release notes contain a forbidden identifier`
(exit 1; the owner edits the offending PR title and re-runs the publish
job). Only then writes `--out`. The masking exists because the generated
body carries PR URLs and `@<login>` mentions of the repository owner; the
gate is about PR-authored text, not the slug.

`scripts/verify.sh` (edit, minimal): hoist the two split-quoted regexes into
functions and add one assertion; `main` calls the functions where it used
the locals — same spelling, same behavior, `verify-policy.test.sh` still
green:

```bash
forbidden_identifier_re() { printf '%s' 'ill''umi|her''mes|ika-''hetzner|alb''edo'; }   # keep the split quoting exactly as main has it today
attributed_identifier_re() { printf '%s' 'g''brain'; }
assert_release_text_clean() {   # $1 = file; used by scripts/release/main.ts notes and by the release workflow
  assert_no_match "forbidden identifier in release text" grep -I -n -i -E "$(forbidden_identifier_re)|$(attributed_identifier_re)" "$1"
}
```

`scripts/verify-policy.test.sh` gains two cases: a fixture file containing
the split-quoted first identifier makes `assert_release_text_clean` fail;
a fixture containing `acme/kizuki`, `@ada` and PR URLs passes.

`.github/release.yml` (NEW; consumed by generate-notes):

```yaml
changelog:
  exclude:
    labels: [skip-changelog]
  categories:
    - title: Breaking changes
      labels: [breaking]
    - title: Connectors
      labels: [connector]
    - title: Features
      labels: [feature, enhancement]
    - title: Fixes
      labels: [fix, bug]
    - title: Security and privacy
      labels: [security, privacy]
    - title: Other changes
      labels: ["*"]
```

## 9. `version` verb — `packages/cli/src/commands/version.ts` (cli-verbs; extend)

```
kizuki version            → the "version" field of packages/cli/package.json (unchanged; the bundle and the binary inline it at build time)
kizuki version --json     → {"version":"0.1.0","bun":"<Bun.version>","platform":"<process.platform>","arch":"<process.arch>"}
```

One line, no trailing fields, keys in that order; any positional → usage,
exit 2. The three channels — `bun packages/cli/src/main.ts`, the compiled
binary, `bun --no-env-file dist/npm/lib/kizuki.js` — print the same string;
§Tests pins it for each. There is no update check and no build channel
field: the binary says what it is; the release page says what is current
(ARCHITECTURE.md §10).

## 10. The workflow — `.github/workflows/release.yml` (NEW)

Pin every action to a full commit SHA with the tag in a trailing comment
(record the check date in the commit body). Never a `pull_request` trigger:
secrets must never reach a PR build.

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
env:
  REPO: ${{ github.repository }}
  TAG: ${{ github.ref_name }}
jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    outputs:
      version: ${{ steps.gate.outputs.version }}
      channel: ${{ steps.gate.outputs.channel }}
      prerelease: ${{ steps.gate.outputs.prerelease }}
    steps:
      - uses: actions/checkout@<sha> # v4
        with: { fetch-depth: 0 } # verify.sh scans every reachable commit message; gate needs origin/main
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bun run verify # the full repository gate on the exact tagged commit — never green-over-red
      - run: git fetch --no-tags origin main
      - id: gate
        run: bun scripts/release/main.ts gate --tag "$TAG"
  build:
    needs: gate
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      KIZUKI_TELEGRAM_API_ID: ${{ secrets.KIZUKI_TELEGRAM_API_ID }}
      KIZUKI_TELEGRAM_API_HASH: ${{ secrets.KIZUKI_TELEGRAM_API_HASH }}
      KIZUKI_GOOGLE_CLIENT_ID: ${{ secrets.KIZUKI_GOOGLE_CLIENT_ID }}
      KIZUKI_GOOGLE_CLIENT_SECRET: ${{ secrets.KIZUKI_GOOGLE_CLIENT_SECRET }}
      KIZUKI_X_CLIENT_ID: ${{ secrets.KIZUKI_X_CLIENT_ID }}
      KIZUKI_WHOOP_CLIENT_ID: ${{ secrets.KIZUKI_WHOOP_CLIENT_ID }}
      KIZUKI_WHOOP_CLIENT_SECRET: ${{ secrets.KIZUKI_WHOOP_CLIENT_SECRET }}
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bun install --frozen-lockfile
      - name: build five targets (unset secrets are absent, not empty — collectBuildCredentials fails closed on "")
        run: |
          for name in KIZUKI_TELEGRAM_API_ID KIZUKI_TELEGRAM_API_HASH KIZUKI_GOOGLE_CLIENT_ID KIZUKI_GOOGLE_CLIENT_SECRET KIZUKI_X_CLIENT_ID KIZUKI_WHOOP_CLIENT_ID KIZUKI_WHOOP_CLIENT_SECRET; do
            if [ -z "${!name-}" ]; then unset "$name"; fi
          done
          bun scripts/build.ts --all-targets --out-dir dist
          bun scripts/release/main.ts assets --tag "$TAG" --repo "$REPO" --dist dist --out dist/release
          bun scripts/release/main.ts npm --tag "$TAG" --repo "$REPO" --out dist/npm
      - run: ruby -c dist/release/kizuki.rb && sh -n dist/release/install.sh
      - uses: actions/upload-artifact@<sha> # v4
        with:
          {
            name: release-assets,
            path: dist/release/,
            retention-days: 7,
            if-no-files-found: error,
          }
      - uses: actions/upload-artifact@<sha> # v4
        with:
          {
            name: npm-stage,
            path: dist/npm/,
            retention-days: 7,
            if-no-files-found: error,
          }
  smoke:
    needs: [gate, build]
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest, platform: linux-x64, isolate: require }
          - { os: ubuntu-24.04-arm, platform: linux-arm64, isolate: require }
          - { os: macos-latest, platform: darwin-arm64, isolate: skip }
          - { os: macos-15-intel, platform: darwin-x64, isolate: skip }
          - { os: windows-latest, platform: windows-x64, isolate: skip }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    defaults: { run: { shell: bash } }
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2   (quickstart.sh prints bun=/pinned=; the binary under test needs no bun)
        with: { bun-version-file: .bun-version }
      - uses: actions/download-artifact@<sha> # v4
        with: { name: release-assets, path: dist/release }
      - name: extract and verify the archive for this platform
        run: |
          cd dist/release
          sha256sum -c --ignore-missing checksums.txt 2>/dev/null || shasum -a 256 -c --ignore-missing checksums.txt
          mkdir -p ../bin && tar -xzf "kizuki-$TAG-${{ matrix.platform }}.tar.gz" -C ../bin
      - name: the binary reports the released version
        run: |
          bin="dist/bin/kizuki"; [ "${{ matrix.platform }}" = windows-x64 ] && bin="dist/bin/kizuki.exe"
          test "$("$bin" version)" = "${{ needs.gate.outputs.version }}"
          "$bin" version --json | grep -c '"version":"${{ needs.gate.outputs.version }}"'
      - name: stranger loop against the release binary
        run: |
          bin="dist/bin/kizuki"; [ "${{ matrix.platform }}" = windows-x64 ] && bin="dist/bin/kizuki.exe"
          bash scripts/quickstart.sh --binary "$bin" --isolate ${{ matrix.isolate }}
  publish:
    needs: [gate, build, smoke]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: release
    permissions:
      contents: write # create the release, upload assets; generate-notes
      id-token: write # Sigstore attestations; npm trusted publishing / provenance
      attestations: write
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
    steps:
      - uses: actions/checkout@<sha> # v4
        with: { fetch-depth: 0 } # previousTag needs the tags
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - uses: actions/setup-node@<sha> # v4
        with: { node-version: 24, registry-url: "https://registry.npmjs.org" }
      - uses: actions/download-artifact@<sha> # v4
        with: { name: release-assets, path: dist/release }
      - uses: actions/download-artifact@<sha> # v4
        with: { name: npm-stage, path: dist/npm }
      - name: release notes from merged pull requests (gated by the identifier denylist)
        run: bun scripts/release/main.ts notes --tag "$TAG" --repo "$REPO" --release-dir dist/release --out dist/notes.md ${{ env.HOMEBREW_TAP_TOKEN != '' && needs.gate.outputs.channel == 'stable' && '--tap' || '' }}
      - uses: actions/attest-build-provenance@<sha> # v4 (wraps actions/attest)
        with:
          subject-path: |
            dist/release/*.tar.gz
            dist/release/checksums.txt
            dist/release/install.sh
            dist/release/kizuki.rb
            dist/release/sbom.cdx.json
      - name: draft the GitHub release with every asset
        run: |
          gh release create "$TAG" --verify-tag --draft --title "kizuki $TAG" --notes-file dist/notes.md \
            ${{ needs.gate.outputs.prerelease == 'true' && '--prerelease' || '' }} \
            dist/release/*.tar.gz dist/release/checksums.txt dist/release/sbom.cdx.json dist/release/THIRD_PARTY_NOTICES.txt \
            dist/release/build-info.json dist/release/install.sh dist/release/kizuki.rb
      - name: publish to npm (trusted publisher, or NPM_TOKEN)
        working-directory: dist/npm
        run: npm publish --access public --provenance ${{ needs.gate.outputs.prerelease == 'true' && '--tag next' || '' }}
      - name: push the formula to the tap (stable releases, only when the token exists)
        if: env.HOMEBREW_TAP_TOKEN != '' && needs.gate.outputs.channel == 'stable'
        run: |
          owner="${REPO%%/*}"
          git clone --depth 1 "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${owner}/homebrew-kizuki.git" tap
          mkdir -p tap/Formula && cp dist/release/kizuki.rb tap/Formula/kizuki.rb
          git -C tap add Formula/kizuki.rb
          git -C tap -c user.name=kizuki-release -c user.email=kizuki-release@users.noreply.github.com commit -m "kizuki ${{ needs.gate.outputs.version }}"
          git -C tap push origin HEAD
      - name: publish the release
        run: gh release edit "$TAG" --draft=false
```

Notes for the implementer:

- The draft-then-undraft order makes a half-finished publish visible instead
  of silent: if `npm publish` fails, the draft stays for the owner to
  inspect; re-running the `publish` job after the fix must be idempotent —
  `gh release create` on an existing draft fails, so precede it with
  `gh release view "$TAG" >/dev/null 2>&1 && gh release delete "$TAG" --yes`
  guarded by `--draft` status (`gh release view --json isDraft`); never
  delete a published release.
- `ubuntu-24.04-arm` is free for public repositories; on a private repository
  the job cannot be scheduled and the release does not publish. That is the
  intended behavior (an untested target never ships), see Open questions.
- Windows runs `bash` (Git Bash) for the smoke: `mktemp`, `sed`, `tar` exist
  there; if `quickstart.sh` needs a portability fix to pass on Windows, fix
  the script — never drop the target from the matrix.
- macOS binaries are not notarized (non-goal). `curl`- and `brew`-fetched
  files carry no quarantine attribute, so the installer and the formula work
  as-is; a browser-downloaded archive needs `xattr -d com.apple.quarantine`.
  `docs/releasing.md` and the README say this in one sentence each.
- The `build` job's artifacts contain the embedded app credentials that the
  release publishes anyway; they are the project's public client
  identifiers by the owner's decision, never an owner token.
- Secrets used, all optional, exact names: the seven `KIZUKI_*` build
  variables, `NPM_TOKEN`, `HOMEBREW_TAP_TOKEN`. `workflow.test.ts` pins this
  set (§Tests).

## 11. Documentation

`README.md` — replace the ci-hardening sentence "No packaged releases yet;
build a single-file binary from source (below)." with an "Install" section
placed before "Try it":

- what every release on this repository's Releases page contains (the five
  archives by platform, `checksums.txt`, `install.sh`, `kizuki.rb`,
  `sbom.cdx.json`, `THIRD_PARTY_NOTICES.txt`, `build-info.json`), and that
  the release notes carry the copy-pasteable installer, Homebrew and npm
  lines;
- the verification commands from §8 (`sha256sum -c --ignore-missing
checksums.txt`, `gh attestation verify … --repo <this repository>`);
- that the npm package (`kizuki`) runs on Bun and the compiled binaries do
  not need it;
- one sentence: macOS binaries are not notarized (curl/brew installs are
  unaffected; a browser download needs the quarantine attribute removed);
- one sentence under "Zero phone-home": the installer downloads exactly two
  release files and sends nothing; the binary never checks for updates.
- Claim nothing that has not happened: if no tag has been pushed at the
  revision you commit, say "the first release is cut by the tag-triggered
  workflow (`docs/releasing.md`)" rather than naming a version.

`docs/releasing.md` (NEW, ≤ 120 lines, maintainer-facing): the version
source (`packages/cli/package.json`), the tag grammar, the exact sequence
(bump-version PR → merge → `git tag v<version> <sha> && git push origin
v<version>` — pushing the tag is the owner's explicit release authority per
AGENTS.md), what the gate checks and the four reasons it prints, the secrets
table (name, purpose, effect when absent), the `release` environment, the
trusted-publisher values to enter on npmjs.com (owner, `kizuki`,
`release.yml`, `release`), the tap repository layout (`Formula/kizuki.rb`),
the artifact list, the two verification commands, the half-publish recovery
(draft stays; re-run `publish`), the `packaging/BUN_LICENSE` provenance
(Bun tag it was copied from) and the rule that bumping `.bun-version`
refreshes it. Use `<owner>` wherever the slug would go.

## Tests

Must exist and pass under `bun test` (all under `scripts/release/` unless
noted; every temp path via `mkdtempSync`, removed afterwards; no network):

- `scripts/build.test.ts` (extend): §1 cases.
- `gate.test.ts`: `parseTag` accepts `v1.2.3`, `v1.2.3-rc.1`, `v0.1.0-beta.12`;
  rejects `1.2.3`, `v1.2`, `v1.2.3-rc`, `v1.2.3-foo.1`, `V1.2.3`, ` v1.2.3`;
  `evaluateGate` GO with every input true/equal; each failing input yields
  exactly its reason text; two failing inputs yield both, in field order.
- `tar.test.ts`: `createTar` of three entries → `tar -tvf` (system tar)
  lists the names with modes `-rwxr-xr-x`/`-rw-r--r--`; extraction bytes
  equal the inputs; two calls are byte-identical; `createTarGz` twice is
  byte-identical and `tar -xzf` extracts it; rejects a 101-byte name, `/abs`,
  `a/../b`, a duplicate.
- `archive.test.ts`: fake `dist/` with five tiny "binaries" (a shell script
  per unix target, any bytes for `.exe`) and a synthetic `build-info.json`;
  `writeAssets` produces exactly the file set of §4 with the §4 names; every
  archive lists `kizuki`/`kizuki.exe`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`;
  `checksums.txt` parses, covers every other file, and `sha256sum -c` passes
  (spawned); a second `writeAssets` into a fresh dir yields identical
  `checksums.txt`; a missing target binary → error naming it; `outDir`
  non-empty → error; `formatChecksums`/`parseChecksums` round-trip, malformed
  line and duplicate rejected.
- `lockfile.test.ts`: a fixture lock (JSONC string with trailing commas)
  containing a workspace with a dev dependency, a runtime dependency with a
  nested-key override (`"a/b"`), an optional dependency and a
  `workspace:` link → closure is `[a, a's nested b, optional]` in sorted
  order, dev excluded, workspace member not emitted, its dependencies
  included; unresolved dependency throws with the exact message; the real
  `bun.lock` parses and `runtimeClosure(lock, "packages/cli")` contains
  neither `typescript` nor `@types/bun`.
- `sbom.test.ts`: `buildSbom` with injected timestamp/serial is deterministic
  and has `bomFormat`, `specVersion "1.6"`, `metadata.component.name
"kizuki"`, the bun component first, one library per package with purl and
  SHA-512 hex derived from a known `sha512-` integrity (assert the hex of a
  fixed base64 input), scoped names percent-encoded.
- `notices.test.ts`: fixture `node_modules` in a temp dir — a package with
  `license` + `LICENSE`, one with `license: { type }` and no file, one with
  neither → the third throws naming `name@version`; `renderNotices` contains
  the Bun block verbatim and one `----` block per notice.
- `render.test.ts`: unrendered placeholder throws naming it; `formulaVars`
  throws when an archive digest is missing; the rendered formula contains
  the version, four digests, four URLs and no `@`-placeholder; `ruby -c`
  accepts it (`test.skipIf(Bun.which("ruby") === null)`); the rendered
  installer contains `acme/kizuki` and no `@REPO@`; `sh -n` accepts it.
- `npm.test.ts`: `npmBundleArgs` exact with and without credentials;
  `npmManifest` exact fields, no `dependencies`, no `scripts`; `stageNpm`
  into a temp dir with `expectedEmbedded` all false: file set exact,
  `lib/kizuki.js` starts with `#!/usr/bin/env bun`, `bun --no-env-file
lib/kizuki.js version` prints the package version, `bun lib/kizuki.js
version --json` parses with that version; `node bin/kizuki.js version`
  prints it (`test.skipIf(Bun.which("node") === null)`); the wrapper with
  `PATH` set to a temp dir holding no `bun` exits 127 and prints the exact
  message; `expectedEmbedded` with `telegram: true` and an env without
  credentials → throws the mismatch message; `npm pack --dry-run --json`
  lists exactly the manifest's `files` closure (`test.skipIf(Bun.which("npm")
=== null)`).
- `notes.test.ts`: `previousTag` picks the highest lower stable tag for a
  stable current and ignores non-matching tags; a prerelease current sees
  prereleases; none → null; `maskRepository` masks `acme/kizuki`,
  `Acme/Kizuki`, `@acme` and leaves `acmeco` alone; `composeNotes` has the
  four `## ` headings in order, the exact install lines, the tap line only
  when `tap`, every archive digest, the four groups with
  `embedded`/`placeholder`, and the body verbatim.
- `install.test.ts` spawns `scripts/release/install.test.sh`, which renders
  the template with `acme/kizuki`, builds a fake release layout in a temp
  dir (`latest/download/{checksums.txt,kizuki-v9.9.9-<host platform>.tar.gz}`
  and `download/v9.9.9/…`, where `kizuki` is a shell script printing
  `9.9.9` for `version`) and runs the installer under `sh`, `dash` (if
  present) and `bash` with `KIZUKI_RELEASE_BASE=file://…` (`curl` required;
  the test skips with a printed reason when `curl` is absent): install into
  `--dir` succeeds and prints the `installed` line; `--version v9.9.9` path
  works; a tampered archive → `checksum mismatch`, nothing installed, temp
  dir gone; a `checksums.txt` without the entry → the exact message;
  `--dry-run` prints two URLs and creates nothing; `KIZUKI_INSTALL_UNAME_S=
Windows_NT` → the unsupported-platform message, exit 1; a template copy
  (with `@REPO@`) refuses; `sh -n` on the rendered script.
- `workflow.test.ts`: parses `.github/workflows/release.yml` as text and
  asserts: the only trigger is `push.tags: ["v*"]` (no `pull_request`,
  no `workflow_dispatch`); top-level `permissions` is exactly `contents:
read`; every `uses:` is pinned to 40 hex characters; the set of
  `secrets.<NAME>` references equals `{GITHUB_TOKEN, HOMEBREW_TAP_TOKEN,
NPM_TOKEN}` ∪ the seven `KIZUKI_*` names; the `publish` job declares
  `environment: release`; the `smoke` matrix names the five platforms of
  `RELEASE_PLATFORMS`; `.github/release.yml` parses (`Bun.YAML.parse`) and
  has a `"*"` category.
- `scripts/verify-network.test.ts` (extend): the tree scan covers
  `packaging/npm/bin/kizuki.js` (assert the file is in the scanned list and
  produces no finding).
- `scripts/verify-policy.test.sh` (extend): the two `assert_release_text_clean`
  cases of §8.
- `packages/cli/test/version.test.ts` (NEW; uses cli-verbs' `runCli`):
  `version` equals `packages/cli/package.json` `version`; `version --json`
  is one line whose keys are exactly `version, bun, platform, arch` with
  `version` equal and `bun` equal to `Bun.version`; `version extra` exits 2.

## Non-goals

Apple notarization / Developer ID signing and Windows Authenticode; winget,
scoop, chocolatey, deb/rpm/AUR/nix packages; Docker images; the
`optionalDependencies` platform-package pattern on npm; musl, baseline and
windows-arm64 targets; a `kizuki update`/`upgrade` verb or any update check
(invariant 6 — forever); the PyPI placeholder (a separate owner action);
a CHANGELOG file (release notes are generated); GPG-signed tags as a gate;
Homebrew core submission or bottles; a `latest`-alias install script
hosted outside the release assets; changing ci-hardening's `ci.yml`
beyond nothing (this lane adds a second workflow); any connector, serving
or core behavior. No edit to `docs/architecture.md`.

## Runtime dependencies

None. `@kizuki/core` stays dependency-free; `packages/cli/package.json`
gains nothing; `bun.lock` is unchanged. Everything in `scripts/release/`
uses `bun:test`, `node:fs`, `node:path`, `Bun.*` (`JSONC`, `gzipSync`,
`CryptoHasher`, `spawnSync`, `file`, `which`). Third-party code runs only
inside GitHub Actions, SHA-pinned: `actions/checkout`, `oven-sh/setup-bun`,
`actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`,
`actions/attest-build-provenance`; plus the runner-provided `gh`, `npm`,
`ruby`, `tar`, `sha256sum`/`shasum`. `npm view` was not needed for any
package: nothing is added.

## Acceptance

```
bun run typecheck && bun test                                 # green; every test file of §Tests present
bun run verify                                                # exit 0: the full gate incl. the new policy cases and the packaging/ scan
grep -c '"bun-windows-x64"' scripts/build.ts                  # 1
V=$(bun -e 'console.log((await Bun.file("packages/cli/package.json").json()).version)'); echo "$V"
export KIZUKI_CONFIG=/tmp/kz-rel/config.toml; mkdir -p /tmp/kz-rel   # keep the developer's real config out of every line below
bun scripts/build.ts --all-targets --out-dir /tmp/kz-rel/dist          # five "built …" lines; cross targets download their bun runtime (the only network use)
ls /tmp/kz-rel/dist                                           # build-info.json kizuki-bun-darwin-arm64 kizuki-bun-darwin-x64 kizuki-bun-linux-arm64 kizuki-bun-linux-x64 kizuki-bun-windows-x64.exe
bun scripts/release/main.ts gate --tag "v$V"; echo $?         # on a clean checkout of main: "GO v$V version=$V channel=stable", 0; on a lane branch: NO-GO with exactly "reason: tagged commit is not on main", 1
bun scripts/release/main.ts gate --tag v9.9.9; echo $?        # NO-GO … "reason: tag v9.9.9 does not match packages/cli/package.json version $V"; 1
bun scripts/release/main.ts gate --tag 1.2.3; echo $?         # "error: tag 1.2.3 is not v<major>.<minor>.<patch>[-(alpha|beta|rc).<n>]"; 1
bun scripts/release/main.ts assets --tag "v$V" --repo acme/kizuki --dist /tmp/kz-rel/dist --out /tmp/kz-rel/release
ls /tmp/kz-rel/release                                        # THIRD_PARTY_NOTICES.txt build-info.json checksums.txt install.sh kizuki-v$V-darwin-arm64.tar.gz kizuki-v$V-darwin-x64.tar.gz kizuki-v$V-linux-arm64.tar.gz kizuki-v$V-linux-x64.tar.gz kizuki-v$V-windows-x64.tar.gz kizuki.rb sbom.cdx.json
(cd /tmp/kz-rel/release && sha256sum -c checksums.txt)        # every file ": OK"; checksums.txt itself is not listed
tar -tzf /tmp/kz-rel/release/kizuki-v$V-linux-x64.tar.gz      # kizuki LICENSE THIRD_PARTY_NOTICES.txt
tar -tzf /tmp/kz-rel/release/kizuki-v$V-windows-x64.tar.gz    # kizuki.exe LICENSE THIRD_PARTY_NOTICES.txt
mkdir -p /tmp/kz-rel/x && tar -xzf /tmp/kz-rel/release/kizuki-v$V-linux-x64.tar.gz -C /tmp/kz-rel/x && /tmp/kz-rel/x/kizuki version   # $V
/tmp/kz-rel/x/kizuki version --json                           # {"version":"$V","bun":"<pinned or local bun>","platform":"linux","arch":"x64"}
bash scripts/quickstart.sh --binary /tmp/kz-rel/x/kizuki --isolate skip   # last line QUICKSTART_OK …
bun scripts/release/main.ts assets --tag "v$V" --repo acme/kizuki --dist /tmp/kz-rel/dist --out /tmp/kz-rel/release2 >/dev/null && diff /tmp/kz-rel/release/checksums.txt /tmp/kz-rel/release2/checksums.txt   # no output: archives are deterministic
ruby -c /tmp/kz-rel/release/kizuki.rb                         # Syntax OK
grep -c '@' /tmp/kz-rel/release/kizuki.rb                     # 0 (every placeholder rendered)
sh -n /tmp/kz-rel/release/install.sh && grep -c '@REPO@' /tmp/kz-rel/release/install.sh   # 0
grep -c 'acme/kizuki' /tmp/kz-rel/release/install.sh          # ≥ 1
sh /tmp/kz-rel/release/install.sh --dry-run                   # two URLs under https://github.com/acme/kizuki/releases/latest/download/, exit 0, no network
mkdir -p /tmp/kz-rel/fake/latest/download && cp /tmp/kz-rel/release/checksums.txt /tmp/kz-rel/release/kizuki-v$V-linux-x64.tar.gz /tmp/kz-rel/fake/latest/download/
KIZUKI_RELEASE_BASE=file:///tmp/kz-rel/fake sh /tmp/kz-rel/release/install.sh --dir /tmp/kz-rel/bin   # "installed kizuki $V to /tmp/kz-rel/bin/kizuki"; stderr "add /tmp/kz-rel/bin to PATH"
printf 'x' >> /tmp/kz-rel/fake/latest/download/kizuki-v$V-linux-x64.tar.gz && KIZUKI_RELEASE_BASE=file:///tmp/kz-rel/fake sh /tmp/kz-rel/release/install.sh --dir /tmp/kz-rel/bin2; echo $?   # "checksum mismatch for kizuki-v$V-linux-x64.tar.gz"; 1; /tmp/kz-rel/bin2 absent
sh packaging/install.sh.tmpl; echo $?                         # "this copy of install.sh was not rendered by the release workflow"; 1
bun -e 'const s = await Bun.file("/tmp/kz-rel/release/sbom.cdx.json").json(); console.log(s.bomFormat, s.specVersion, s.metadata.component.name, s.components[0].name, s.components.length)'   # CycloneDX 1.6 kizuki bun N (N = 1 + the runtime closure of packages/cli; 1 on today's main)
grep -c '^----' /tmp/kz-rel/release/THIRD_PARTY_NOTICES.txt   # N - 1
bun scripts/release/main.ts npm --tag "v$V" --repo acme/kizuki --out /tmp/kz-rel/npm
ls -R /tmp/kz-rel/npm                                         # LICENSE README.md THIRD_PARTY_NOTICES.txt package.json bin/kizuki.js lib/kizuki.js
bun -e 'const p = await Bun.file("/tmp/kz-rel/npm/package.json").json(); console.log(p.name, p.version, p.bin.kizuki, p.dependencies === undefined, p.scripts === undefined, p.engines.bun)'   # kizuki $V bin/kizuki.js true true >=<.bun-version>
head -1 /tmp/kz-rel/npm/lib/kizuki.js                         # #!/usr/bin/env bun
bun --no-env-file /tmp/kz-rel/npm/lib/kizuki.js version       # $V
node /tmp/kz-rel/npm/bin/kizuki.js version                    # $V
PATH=/usr/bin:/bin node /tmp/kz-rel/npm/bin/kizuki.js version; echo $?   # the one-line Bun message on stderr; 127 (on a box where /usr/bin has no bun)
(cd /tmp/kz-rel/npm && npm publish --dry-run --access public 2>&1 | grep -E 'kizuki@|total files')   # kizuki@$V; total files 6
(cd /tmp/kz-rel/npm && bun publish --dry-run 2>&1 | tail -2)  # the dry-run summary, no error
printf '## What'"'"'s Changed\n* Add the thing by @ada in https://github.com/acme/kizuki/pull/7\n' > /tmp/kz-rel/body.md
bun scripts/release/main.ts notes --tag "v$V" --repo acme/kizuki --release-dir /tmp/kz-rel/release --body-file /tmp/kz-rel/body.md --out /tmp/kz-rel/notes.md --tap && grep -c '^## ' /tmp/kz-rel/notes.md   # 4
grep -c 'brew install acme/kizuki/kizuki' /tmp/kz-rel/notes.md   # 1 (0 without --tap)
grep -c 'placeholder' /tmp/kz-rel/notes.md                    # 4 groups … ≥ 4 (this build embedded nothing)
bash -c 'source scripts/verify.sh && assert_release_text_clean /tmp/kz-rel/body.md'; echo $?   # 0
bash scripts/verify-policy.test.sh                            # "verification policy tests passed"
bun packages/cli/src/main.ts version --json                   # {"version":"$V","bun":"…","platform":"…","arch":"…"}
bun packages/cli/src/main.ts version extra; echo $?           # usage on stderr; 2
gh api -X POST repos/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/releases/generate-notes -f tag_name="v$V" -f target_commitish=main | head -c 200   # with gh auth: {"name":"v…","body":"## What's Changed…  (what `notes` runs without --body-file; creates nothing)
bun -e 'const y = await Bun.file(".github/workflows/release.yml").text(); const d = Bun.YAML.parse(y); console.log(Object.keys(d.jobs).join(" "), JSON.stringify(d.on))'   # gate build smoke publish {"push":{"tags":["v*"]}}
grep -c 'uses: .*@[0-9a-f]\{40\}' .github/workflows/release.yml   # ≥ 12 (every action SHA-pinned)
grep -c 'pull_request\|workflow_dispatch' .github/workflows/release.yml   # 0
git grep -n -i -E 'github\.com/[a-z0-9-]+/kizuki' -- . ':(exclude)*.tmpl' | grep -v '@REPO@' | grep -v acme   # no output: no real slug in tracked text
git status --porcelain                                        # empty
# First real run (owner's action, not the implementer's): push tag v$V on main → the four jobs of release.yml go green, the release page lists the eleven assets, `npm view kizuki version` prints $V.
```
