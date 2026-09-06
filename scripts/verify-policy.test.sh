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
printf '# Credits\n\n[%s](%s)\n' "$exact_name" "$canonical_url" >"$fixture_root/README.md"
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

restrict_root="$(mktemp -d)"
git -C "$restrict_root" init -q
git -C "$restrict_root" config user.name verifier
git -C "$restrict_root" config user.email verifier@example.invalid
printf 'keep\n' >"$restrict_root/README.md"
git -C "$restrict_root" add README.md
git -C "$restrict_root" commit -q -m 'restrict fixture'
git -C "$restrict_root" update-ref refs/remotes/origin/main HEAD
git -C "$restrict_root" update-ref refs/remotes/origin/sibling HEAD
(
  cd "$restrict_root"
  bash "$script_dir/ci-restrict-origin-refs.sh"
)
if git -C "$restrict_root" show-ref --verify --quiet refs/remotes/origin/sibling; then
  printf 'policy test failed: sibling origin ref survived restrict\n' >&2
  exit 1
fi
if ! git -C "$restrict_root" show-ref --verify --quiet refs/remotes/origin/main; then
  printf 'policy test failed: origin/main was dropped by restrict\n' >&2
  exit 1
fi
rm -rf -- "$restrict_root"

history_messages="$(mktemp)"
github_owner='Ill''uminfti'
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n' "$github_owner" >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n' 'ILL''UMINFTI' >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"

standalone_token='ill''umi'
printf 'review notes mention %s in the body\n' "$standalone_token" >"$history_messages"
if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
  printf 'policy test failed: standalone first-token identifier passed history scan\n' >&2
  exit 1
fi
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n\nmentions %s\n' \
  "$github_owner" "$standalone_token" >"$history_messages"
if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
  printf 'policy test failed: mixed owner-token plus standalone identifier passed history scan\n' >&2
  exit 1
fi

remaining_tokens=('her''mes' 'ika-''hetzner' 'g''brain')
for remaining in "${remaining_tokens[@]}"; do
  printf 'review notes mention %s\n' "$remaining" >"$history_messages"
  if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
    printf 'policy test failed: remaining denylist token passed history scan\n' >&2
    exit 1
  fi
done

# Trailer lines are ignored by denylist-history.
# Agent display-name tokens are not part of the reachable-commit pattern
# (tracked-text denylist still covers them in the tree).
printf 'Harden doctor

Co-authored-by: Floor Guardian <nazarick@agentmail.to>
' >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor

mentions her''mes in the body

Co-authored-by: bot <bot@example.invalid>
' >"$history_messages"
if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
  printf 'policy test failed: body identifier with ignored trailer passed history scan
' >&2
  exit 1
fi

rm -f -- "$history_messages"

printf 'verification policy tests passed\n'
