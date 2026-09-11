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

# Public repository links admit only the exact owner occurrence in tracked text.
# Paths and every other occurrence, including URL suffixes, keep the denylist.
tracked_text_root="$fixture_root/tracked-text"
mkdir -p "$tracked_text_root"
git -C "$tracked_text_root" init -q
tracked_identifier_re='ill''umi|her''mes|ika-''hetzner|alb''edo'
public_repository='https://github.com/Illuminfti/kizuki'
private_token='ill''umi'
public_owner='Ill''uminfti'
upper_owner='ILL''UMINFTI'
printf 'ordinary text\n' >"$tracked_text_root/fixture.txt"
git -C "$tracked_text_root" add fixture.txt

check_tracked_text() {
  local expected="$1" text="$2" observed
  printf '%s\n' "$text" >"$tracked_text_root/fixture.txt"
  if (cd "$tracked_text_root"; assert_safe_tracked_text "$tracked_identifier_re") >"$fixture_root/tracked-result.log" 2>&1; then
    observed=0
  else
    observed=$?
  fi
  if ((observed != expected)); then
    printf 'policy test failed: tracked-text expected %d, received %d\n' "$expected" "$observed" >&2
    cat "$fixture_root/tracked-result.log" >&2
    exit 1
  fi
}

for valid in \
  'ordinary text without a match' \
  "$public_repository" \
  "($public_repository)" \
  "<$public_repository>" \
  "\"$public_repository/blob/0123456789abcdef/docs/local-app.md\"" \
  "$public_repository?tab=readme#setup" \
  "$public_repository#setup" \
  "$public_repository/docs/one ($public_repository/docs/two)"
do
  check_tracked_text 0 "$valid"
done

for invalid in \
  "$private_token" \
  "${private_token}nfti" \
  "https://github.com/${private_token}nfti/kizuki" \
  "HTTPS://github.com/${public_owner}/kizuki" \
  "https://GITHUB.com/${public_owner}/kizuki" \
  "https://github.com/${upper_owner}/kizuki" \
  "https://github.com/${public_owner}/Kizuki" \
  "https://github.com/${public_owner}/kizuki-mirror/docs" \
  "https://github.com/${public_owner}/kizuki.git" \
  "https://github.com/${public_owner}/kizuki%2Fdocs" \
  "https://github.com/${public_owner}/other" \
  "https://github.com.evil.invalid/${public_owner}/kizuki" \
  "https://evil.invalid/github.com/${public_owner}/kizuki" \
  "https://reader@github.com/${public_owner}/kizuki" \
  "http://github.com/${public_owner}/kizuki" \
  "x$public_repository" \
  "/$public_repository" \
  "https://evil.invalid/?target=$public_repository" \
  "$public_repository:extra" \
  "$private_token $public_repository" \
  "$public_repository $private_token" \
  "$public_repository/docs/$private_token" \
  "$public_repository?owner=$private_token" \
  "$public_repository#$private_token" \
  "$public_repository ($public_repository/docs/$private_token)"
do
  check_tracked_text 1 "$invalid"
done
for private_token in 'her''mes' 'ika-''hetzner' 'alb''edo'; do
  check_tracked_text 1 "$public_repository/docs/$private_token"
  check_tracked_text 1 "$public_repository text $private_token"
done
check_tracked_text 0 "$public_repository"
newline_path=$'new\nline.txt'
printf '%s\n' 'ill''umi' >"$tracked_text_root/$newline_path"
git -C "$tracked_text_root" add "$newline_path"
check_tracked_text 1 "$public_repository"
printf '%s\n' "$public_repository" >"$tracked_text_root/$newline_path"
check_tracked_text 0 "$public_repository"

printf 'ordinary text\n' >"$tracked_text_root/$public_owner.txt"
git -C "$tracked_text_root" add "$public_owner.txt"
if (cd "$tracked_text_root"; assert_safe_tracked_paths "$tracked_identifier_re") >/dev/null 2>&1; then
  printf 'policy test failed: public owner passed tracked-path denylist\n' >&2
  exit 1
fi

if (git() { return 23; }; assert_safe_tracked_text "$tracked_identifier_re") >"$fixture_root/tracked-error.log" 2>&1; then
  producer_status=0
else
  producer_status=$?
fi
if ((producer_status != 23)); then
  printf 'policy test failed: tracked-text producer failure was masked\n' >&2
  exit 1
fi
if (git() { printf 'invalid records'; }; assert_safe_tracked_text "$tracked_identifier_re") >/dev/null 2>&1; then
  validator_status=0
else
  validator_status=$?
fi
if ((validator_status != 2)); then
  printf 'policy test failed: tracked-text validator failure was masked\n' >&2
  exit 1
fi
for malformed in '' 'missing separators' 'file\x00invalid\x00text\n' 'file\x0012\x00text' 'file\x001\x00text\x00hidden\n'; do
  if printf '%b' "$malformed" | bun "$script_dir/verify-tracked-text.ts" "$tracked_identifier_re" >/dev/null 2>&1; then
    malformed_status=0
  else
    malformed_status=$?
  fi
  if ((malformed_status != 2)); then
    printf 'policy test failed: malformed tracked-text producer record passed\n' >&2
    exit 1
  fi
done

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
# Floor-guardian display names are tracked-text only (not history).
printf 'Harden doctor\n\nCo-authored-by: Alb''edo <nazarick@agentmail.to>\n' >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor\n\nmentions alb''edo in the body\n\nCo-authored-by: bot <bot@example.invalid>\n' >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor\n\nmentions her''mes in the body\n\nCo-authored-by: bot <bot@example.invalid>\n' >"$history_messages"
if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
  printf 'policy test failed: body denylist token passed when trailer present\n' >&2
  exit 1
fi

rm -f -- "$history_messages"

if ! grep -F 'verify-rfc-tests.ts' "$script_dir/verify.sh" >/dev/null; then
  printf 'policy test failed: rfc inventory gate is not invoked\n' >&2
  exit 1
fi
if bun "$script_dir/verify-rfc-tests.ts" >/dev/null; then
  :
else
  printf 'policy test failed: live rfc inventory gate failed\n' >&2
  exit 1
fi
rfc_fixture="$(mktemp -d)"
mkdir -p "$rfc_fixture/rfcs"
printf '# RFC\n\n## 16. Worked examples\n' >"$rfc_fixture/rfcs/0002-autonomous-canon.md"
if bun "$script_dir/verify-rfc-tests.ts" "$rfc_fixture" >/dev/null 2>"$rfc_fixture/err"; then
  printf 'policy test failed: malformed rfc inventory passed\n' >&2
  rm -rf -- "$rfc_fixture"
  exit 1
fi
if ! grep -F 'missing section 15' "$rfc_fixture/err" >/dev/null; then
  printf 'policy test failed: rfc inventory failure was not propagated\n' >&2
  rm -rf -- "$rfc_fixture"
  exit 1
fi
rm -rf -- "$rfc_fixture"

printf 'verification policy tests passed\n'
