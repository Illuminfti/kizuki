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

history_messages="$fixture_root/history-messages"
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

remaining_tokens=('her''mes' 'ika-''hetzner' 'alb''edo' 'g''brain')
for remaining in "${remaining_tokens[@]}"; do
  printf 'review notes mention %s\n' "$remaining" >"$history_messages"
  if assert_safe_reachable_commit_messages "$history_messages" >/dev/null 2>&1; then
    printf 'policy test failed: remaining denylist token passed history scan\n' >&2
    exit 1
  fi
done

expect_policy_status() {
  local expected="$1" label="$2" status=0
  shift 2
  ("$@") >"$fixture_root/last-policy-output" 2>&1 || status=$?
  if ((status != expected)); then
    printf 'policy test failed: %s returned %d, expected %d\n' "$label" "$status" "$expected" >&2
    exit 1
  fi
}

# Every future message line remains in scope, including folded trailers.
for label in Co-authored-by Signed-off-by Reviewed-by Acked-by; do
  printf 'Policy fixture\n\n%s: %s <fixture@example.invalid>\n' "$label" "$remaining" >"$history_messages"
  expect_policy_status 1 "$label history scan" assert_safe_reachable_commit_messages "$history_messages"
done
printf 'Policy fixture\n\nReviewed-by: fixture\n  %s\n' "$remaining" >"$history_messages"
expect_policy_status 1 'folded trailer history scan' assert_safe_reachable_commit_messages "$history_messages"
expect_policy_status 2 'missing message file' assert_safe_reachable_commit_messages "$fixture_root/absent"

# The real Git producer must preserve message bytes and include a sibling ref.
side_commit="$(printf 'Side subject\n\nFirst body line\nSecond body line\n\n' |
  git -C "$fixture_root" commit-tree 'HEAD^{tree}' -p HEAD)"
git -C "$fixture_root" update-ref refs/heads/policy-framing-side "$side_commit"
(
  cd "$fixture_root"
  write_reachable_commit_records "$fixture_root/framed-records"
  bun -e '
    const { readFileSync } = require("node:fs");
    const records = readFileSync(process.argv[1]), seen = new Set();
    let offset = 0;
    while (offset < records.length) {
      const idEnd = records.indexOf(0, offset), end = records.indexOf(0, idEnd + 1);
      if (idEnd < offset || end < 0) throw new Error("invalid producer framing");
      const id = records.toString("utf8", offset, idEnd);
      const object = Bun.spawnSync(["git", "--no-replace-objects", "cat-file", "commit", id]);
      if (object.exitCode !== 0) throw new Error("missing produced object");
      const message = object.stdout.subarray(object.stdout.indexOf(Buffer.from("\n\n")) + 2);
      if (!records.subarray(idEnd + 1, end).equals(message)) throw new Error("producer changed message bytes");
      if (seen.has(id)) throw new Error("producer repeated a commit");
      seen.add(id);
      offset = end + 1;
    }
    if (seen.size !== 2 || !seen.has(process.argv[2])) throw new Error("producer omitted sibling ref");
  ' "$fixture_root/framed-records" "$side_commit"
)
mkdir "$fixture_root/empty-history"
git -C "$fixture_root/empty-history" init -q
expect_policy_status 2 'empty history' bash -c 'source "$1"; cd "$2"; write_reachable_commit_records "$3"' \
  _ "$script_dir/verify.sh" "$fixture_root/empty-history" "$fixture_root/empty-records"
mkdir "$fixture_root/no-repository"
expect_policy_status 128 'failed history producer' bash -c 'source "$1"; GIT_DIR="$2" write_reachable_commit_records "$3"' \
  _ "$script_dir/verify.sh" "$fixture_root/no-repository" "$fixture_root/failed-records"

# These two published messages are immutable regression inputs, not new commits.
published_records="$fixture_root/published-records"
git -C "$script_dir/.." --no-replace-objects log --no-walk=unsorted -z --encoding=none --no-show-signature --format=%H%x00%B \
  1c919f00570c3bb70088114083d8598c01c77903 092d27bfeb9d84b21d0e843b0706273bd0314290 >"$published_records"
sanitize_historical_commit_records "$published_records" "$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
bun -e '
  const { readFileSync, writeFileSync, openSync, ftruncateSync, closeSync } = require("node:fs");
  const [file, root, result] = process.argv.slice(1), bytes = readFileSync(file);
  const fields = bytes.toString("utf8").split("\0");
  if (fields.length !== 5 || fields[4] !== "") throw new Error("published records framing changed");
  const token = "Al" + "bedo", marker = "[historical-policy-exception]";
  if (fields[1].split(token).length !== 2 || fields[3].split(token).length !== 2) throw new Error("published token count changed");
  const expected = fields[1].replace(token, marker) + "\n" + fields[3].replace(token, marker) + "\n";
  if (!readFileSync(result).equals(Buffer.from(expected))) throw new Error("exception changed unapproved bytes");
  const save = (name, value) => writeFileSync(root + "/" + name, value);
  const changed = [...fields]; changed[1] += "Ordinary correction\n";
  save("changed-message", changed.join("\0"));
  const changedId = [...fields]; changedId[0] = "1".repeat(40);
  save("changed-identity", changedId.join("\0"));
  const extra = [...fields]; extra[1] += token + "\n";
  save("extra-occurrence", extra.join("\0"));
  save("missing-pin", fields.slice(0, 2).join("\0") + "\0");
  save("duplicate-pin", Buffer.concat([bytes, bytes]));
  save("truncated-record", bytes.subarray(0, bytes.length - 1));
  save("copied-message", Buffer.concat([bytes, Buffer.from("1".repeat(40) + "\0" + fields[1] + "\0")]));
  const future = "2".repeat(40) + "\0First neutral message\0" + "3".repeat(40) + "\0Second neutral message\0";
  save("neutral-future", Buffer.concat([bytes, Buffer.from(future)]));
  save("expected-future", expected + "First neutral message\nSecond neutral message\n");
  const large = openSync(root + "/over-budget", "w");
  ftruncateSync(large, 64 * 1024 * 1024 + 1); closeSync(large);
' "$published_records" "$fixture_root" "$history_messages"
for invalid in changed-message changed-identity extra-occurrence missing-pin duplicate-pin truncated-record over-budget; do
  expect_policy_status 2 "$invalid exception" sanitize_historical_commit_records "$fixture_root/$invalid" "$fixture_root/rejected-output"
  if [[ -e "$fixture_root/rejected-output" ]]; then
    printf 'policy test failed: rejected records produced an output\n' >&2
    exit 1
  fi
done
expect_policy_status 2 'non-ancestor history' bash -c 'source "$1"; cd "$2"; sanitize_historical_commit_records "$3" "$4"' \
  _ "$script_dir/verify.sh" "$fixture_root" "$published_records" "$fixture_root/rejected-output"
sanitize_historical_commit_records "$fixture_root/copied-message" "$history_messages"
expect_policy_status 1 'copied historical message' assert_safe_reachable_commit_messages "$history_messages"
sanitize_historical_commit_records "$fixture_root/neutral-future" "$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
cmp "$history_messages" "$fixture_root/expected-future"

printf 'verification policy tests passed\n'
