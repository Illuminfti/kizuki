#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verify.sh
source "$script_dir/verify.sh"

fixture_root="$(mktemp -d)"
shallow_copy=""
cleanup() {
  rm -rf -- "$fixture_root"
  if [[ -n "$shallow_copy" ]]; then
    rm -rf -- "$shallow_copy"
  fi
}
trap cleanup EXIT

git -C "$fixture_root" init -q
git -C "$fixture_root" config user.name verifier
git -C "$fixture_root" config user.email verifier@example.invalid
mkdir -p "$fixture_root/docs" "$fixture_root/packages"

exact_name='G''Brain'
name_re='g''brain'
canonical_url='https://github.com/garrytan/g''brain'
printf '# Credits\n\n%s\n' "$exact_name" >"$fixture_root/README.md"
printf '# Upstream policy\n\n[%s](%s)\n' "$exact_name" "$canonical_url" >"$fixture_root/docs/upstream-policy.md"
git -C "$fixture_root" add README.md docs/upstream-policy.md

(
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
  assert_no_match \
    "attributed identifier outside public documentation" \
    git grep -I -n -i -E "$name_re" -- . \
    ':(exclude)README.md' \
    ':(exclude)docs/upstream-policy.md'
)

printf '# Upstream policy\n\n[%s](%s-mirror)\n' "$exact_name" "$canonical_url" >"$fixture_root/docs/upstream-policy.md"
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
) >/dev/null 2>&1; then
  printf 'policy test failed: suffixed canonical URL passed\n' >&2
  exit 1
fi

modified_url='https://github.com/garrytanx/g''brain'
printf '# Upstream policy\n\n[%s](%s)\n' "$exact_name" "$modified_url" >"$fixture_root/docs/upstream-policy.md"
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
) >/dev/null 2>&1; then
  printf 'policy test failed: modified canonical URL passed\n' >&2
  exit 1
fi

printf '# Upstream policy\n\n[%s](x%s)\n' "$exact_name" "$canonical_url" >"$fixture_root/docs/upstream-policy.md"
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
) >/dev/null 2>&1; then
  printf 'policy test failed: undelimited canonical URL passed\n' >&2
  exit 1
fi

case_changed_url='https://github.com/garrytan/G''Brain'
printf '# Upstream policy\n\n[%s](%s)\n' "$exact_name" "$case_changed_url" >"$fixture_root/docs/upstream-policy.md"
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
) >/dev/null 2>&1; then
  printf 'policy test failed: case-modified canonical URL passed\n' >&2
  exit 1
fi

printf '# Upstream policy\n\n[%s](%s)\n' "$exact_name" "$canonical_url" >"$fixture_root/docs/upstream-policy.md"
printf '# Credits\n\n%s\n' "$name_re" >"$fixture_root/README.md"
git -C "$fixture_root" add README.md docs/upstream-policy.md
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
) >/dev/null 2>&1; then
  printf 'policy test failed: non-canonical public spelling passed\n' >&2
  exit 1
fi

printf '# Credits\n\n%s\n' "$exact_name" >"$fixture_root/README.md"
printf '%s\n' "$exact_name" >"$fixture_root/packages/leak.txt"
git -C "$fixture_root" add README.md packages/leak.txt
if (
  cd "$fixture_root"
  assert_no_match \
    "attributed identifier outside public documentation" \
    git grep -I -n -i -E "$name_re" -- . \
    ':(exclude)README.md' \
    ':(exclude)docs/upstream-policy.md'
) >/dev/null 2>&1; then
  printf 'policy test failed: non-document attribution passed\n' >&2
  exit 1
fi

printf 'export const local = true;\n' >"$fixture_root/packages/${exact_name}.ts"
git -C "$fixture_root" add "packages/${exact_name}.ts"
if (
  cd "$fixture_root"
  assert_safe_tracked_paths "$name_re"
) >/dev/null 2>&1; then
  printf 'policy test failed: forbidden tracked pathname passed\n' >&2
  exit 1
fi

printf '# Credits\n\n%s\n' "$exact_name" >"$fixture_root/README.md"
if (
  cd "$fixture_root"
  assert_exact_attribution_spelling README.md docs/absent-attribution.md
) >/dev/null 2>&1; then
  printf 'policy test failed: missing attribution path passed\n' >&2
  exit 1
fi

mkdir -p "$fixture_root/packages/phone"
printf '{"dependencies":{"@datadog/browser-rum":"1.0.0"}}\n' >"$fixture_root/packages/phone/package.json"
git -C "$fixture_root" add packages/phone/package.json
if (
  cd "$fixture_root"
  assert_no_match \
    "phone-home dependency" \
    git grep -I -n -E "$(phone_home_dependency_pattern)" -- ':(glob)**/package.json'
) >/dev/null 2>&1; then
  printf 'policy test failed: phone-home dependency passed\n' >&2
  exit 1
fi
printf '{"dependencies":{"typescript":"5.9.0"}}\n' >"$fixture_root/packages/phone/package.json"
git -C "$fixture_root" add packages/phone/package.json
(
  cd "$fixture_root"
  assert_no_match \
    "phone-home dependency" \
    git grep -I -n -E "$(phone_home_dependency_pattern)" -- ':(glob)**/package.json'
)

git -C "$fixture_root" config user.name verifier
git -C "$fixture_root" config user.email verifier@example.invalid
git -C "$fixture_root" add README.md docs/upstream-policy.md
git -C "$fixture_root" commit -q -m 'policy fixture'
shallow_copy="$(mktemp -d)"
git clone -q --depth 1 "file://${fixture_root}" "$shallow_copy"
if (
  cd "$shallow_copy"
  assert_full_history
) >/dev/null 2>&1; then
  printf 'policy test failed: shallow clone passed history check\n' >&2
  exit 1
fi
rm -rf -- "$shallow_copy"

printf 'verification policy tests passed\n'
