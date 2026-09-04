# Native local package

Kizuki can produce a local native package from this checkout. It is not a
registry package, release signature, or proof of a supported 1.0 installer.

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

The package contains `kizuki`, `kizuki-mcp`, `README.txt`, and
`SHA256SUMS`. The checksum manifest covers all three package files. The build
refuses to overwrite an existing target and stages output before publishing it.

`bun run smoke:release` runs the package outside the checkout with a synthetic
vault. It proves version/help, init with `--no-service`, Markdown import,
query, context packet, one no-HTTP serve pass, and MCP initialization plus
`tools/list`.

## Support boundary

The target is `bun-linux-x64-baseline`: Linux x86_64, including older baseline
CPUs. Each executable bundles Kizuki code, workspace dependencies, and the
Bun runtime. It is not statically linked, signed, published, or tested on
macOS, Windows, ARM, or a stranger machine.

The binaries do not automatically load `.env` or `bunfig.toml`. They do not
contact a network endpoint by themselves. Network access remains limited to
explicitly configured connectors and model endpoints. Local GGUF model files
and optional retrieval engines are not packaged.

Use `bun packages/cli/src/main.ts` and `bun packages/mcp/src/bin.ts` from a
source checkout. Use `./kizuki` and `./kizuki-mcp` from the native package.
If `kizuki serve --install` creates a user service, run it from the binary's
final path; moving the executable later leaves that service pointing at the
old path.
