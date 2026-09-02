#!/usr/bin/env bash
# Checksummed gitleaks CLI. The GitHub action calls pulls/*/commits and
# 403s under contents:read. This scans the checkout without that API.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  printf 'verification failed: gitleaks pin is linux x64 only\n' >&2
  exit 2
fi

config=".github/gitleaks.toml"
ignore=".github/gitleaksignore"
if [[ ! -f "$config" || ! -f "$ignore" ]]; then
  printf 'verification failed: gitleaks config or ignore file missing\n' >&2
  exit 2
fi

version="8.24.3"
expected="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"
archive="gitleaks_${version}_linux_x64.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

curl -fsSL "$url" -o "$work/$archive"
actual="$(sha256sum -- "$work/$archive" | awk '{ print $1 }')"
if [[ "$actual" != "$expected" ]]; then
  printf 'verification failed: gitleaks checksum mismatch\n' >&2
  exit 2
fi

tar -xzf "$work/$archive" -C "$work" gitleaks
if [[ ! -x "$work/gitleaks" ]]; then
  printf 'verification failed: gitleaks binary missing after extract\n' >&2
  exit 2
fi

"$work/gitleaks" version
"$work/gitleaks" detect \
  --source . \
  --config "$config" \
  --gitleaks-ignore-path "$ignore" \
  --verbose \
  --redact \
  --no-banner
