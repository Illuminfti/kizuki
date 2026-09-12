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

expect_policy_status() {
  local expected="$1" label="$2" status=0
  shift 2
  ("$@") >"$fixture_root/last-policy-output" 2>&1 || status=$?
  if ((status != expected)); then
    printf 'policy test failed: %s returned %d, expected %d\n' "$label" "$status" "$expected" >&2
    cat "$fixture_root/last-policy-output" >&2
    exit 1
  fi
}

history_messages="$fixture_root/history-messages"
github_owner='Ill''uminfti'
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n' "$github_owner" >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n' 'ILL''UMINFTI' >"$history_messages"
assert_safe_reachable_commit_messages "$history_messages"

standalone_token='ill''umi'
printf 'review notes mention %s in the body\n' "$standalone_token" >"$history_messages"
expect_policy_status 1 'standalone first-token identifier' assert_safe_reachable_commit_messages "$history_messages"
printf 'Merge pull request #379 from %s/cursor/llm-port-8afe\n\nmentions %s\n' \
  "$github_owner" "$standalone_token" >"$history_messages"
expect_policy_status 1 'mixed owner-token plus standalone identifier' \
  assert_safe_reachable_commit_messages "$history_messages"

remaining_tokens=('her''mes' 'ika-''hetzner' 'alb''edo' 'g''brain')
for remaining in "${remaining_tokens[@]}"; do
  printf 'review notes mention %s\n' "$remaining" >"$history_messages"
  expect_policy_status 1 'body denylist token' assert_safe_reachable_commit_messages "$history_messages"
done

# Every future message line remains in scope, including folded trailers.
for label in Co-authored-by Signed-off-by Reviewed-by Acked-by; do
  printf 'Policy fixture\n\n%s: %s <fixture@example.invalid>\n' "$label" "$remaining" >"$history_messages"
  expect_policy_status 1 "$label history scan" assert_safe_reachable_commit_messages "$history_messages"
done
printf 'Policy fixture\n\nReviewed-by: fixture\n  %s\n' "$remaining" >"$history_messages"
expect_policy_status 1 'folded trailer history scan' assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor\n\nCo-authored-by: Alb''edo <nazarick@agentmail.to>\n' >"$history_messages"
expect_policy_status 1 'guardian trailer history scan' assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor\n\nmentions alb''edo in the body\n\nCo-authored-by: bot <bot@example.invalid>\n' \
  >"$history_messages"
expect_policy_status 1 'guardian body with trailer' assert_safe_reachable_commit_messages "$history_messages"
printf 'Harden doctor\n\nmentions her''mes in the body\n\nCo-authored-by: bot <bot@example.invalid>\n' \
  >"$history_messages"
expect_policy_status 1 'body denylist token with trailer' assert_safe_reachable_commit_messages "$history_messages"
expect_policy_status 2 'missing message file' assert_safe_reachable_commit_messages "$fixture_root/absent"

# The real Git producer must preserve message bytes, ignore replace refs, and
# include a sibling ref.
side_commit="$(printf 'Side subject\n\nFirst body line\nSecond body line\n\n' |
  git -C "$fixture_root" commit-tree 'HEAD^{tree}' -p HEAD)"
git -C "$fixture_root" update-ref refs/heads/policy-framing-side "$side_commit"
original_head="$(git -C "$fixture_root" rev-parse HEAD)"
replaced_commit="$(printf 'Replaced subject\n\nmentions %s\n' 'her''mes' |
  git -C "$fixture_root" commit-tree 'HEAD^{tree}' -p HEAD)"
git -C "$fixture_root" replace "$original_head" "$replaced_commit"
(
  cd "$fixture_root"
  write_reachable_commit_records "$fixture_root/framed-records"
  HISTORY_POLICY_RECORDS="$fixture_root/framed-records" \
  HISTORY_POLICY_SIDE="$side_commit" \
  HISTORY_POLICY_HEAD="$original_head" \
  bun -e '
    const { readFileSync } = require("node:fs");
    const records = readFileSync(process.env.HISTORY_POLICY_RECORDS);
    const seen = new Set();
    let offset = 0;
    while (offset < records.length) {
      const idEnd = records.indexOf(0, offset);
      const end = records.indexOf(0, idEnd + 1);
      if (idEnd < offset || end < 0) throw new Error("invalid producer framing");
      const id = records.toString("utf8", offset, idEnd);
      const object = Bun.spawnSync(["git", "--no-replace-objects", "cat-file", "commit", id]);
      if (object.exitCode !== 0) throw new Error("missing produced object");
      const stdout = Buffer.from(object.stdout);
      const separator = stdout.indexOf("\n\n");
      if (separator < 0) throw new Error("unreadable produced object");
      const message = stdout.subarray(separator + 2);
      if (!Buffer.from(records.subarray(idEnd + 1, end)).equals(message)) throw new Error("producer changed message bytes");
      if (seen.has(id)) throw new Error("producer repeated a commit");
      seen.add(id);
      offset = end + 1;
    }
    if (seen.size !== 2 || !seen.has(process.env.HISTORY_POLICY_SIDE) || !seen.has(process.env.HISTORY_POLICY_HEAD)) {
      throw new Error("producer omitted sibling ref");
    }
    if (records.indexOf(Buffer.from("Replaced subject")) >= 0) {
      throw new Error("producer followed replace refs");
    }
  '
)
git -C "$fixture_root" replace -d "$original_head"
mkdir "$fixture_root/empty-history"
git -C "$fixture_root/empty-history" init -q
empty_status=0
bash -c 'source "$1"; cd "$2"; write_reachable_commit_records "$3"' \
  _ "$script_dir/verify.sh" "$fixture_root/empty-history" "$fixture_root/empty-records" \
  >"$fixture_root/last-policy-output" 2>&1 || empty_status=$?
if ((empty_status != 2 && empty_status != 128)); then
  printf 'policy test failed: empty history returned %d, expected 2 or 128\n' "$empty_status" >&2
  cat "$fixture_root/last-policy-output" >&2
  exit 1
fi
mkdir "$fixture_root/no-repository"
expect_policy_status 128 'failed history producer' bash -c 'source "$1"; GIT_DIR="$2" write_reachable_commit_records "$3"' \
  _ "$script_dir/verify.sh" "$fixture_root/no-repository" "$fixture_root/failed-records"

repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"
published_records="$fixture_root/published-records"
git -C "$repo_root" --no-replace-objects log --no-walk=unsorted -z --encoding=none --no-show-signature --format=%H%x00%B \
  74d4e96b89e261ee5102fd52cc09d3a65aa67637 \
  7505a1038dbf47980a5c153f675ef3bf45973ef1 \
  0e3bb2216c9f1a1b3f33191d44eae5c39a6007f1 \
  519f88cb41902cf29e15d9fb7f8b2b2d03c15cdf \
  f4eb5feaa37d031fc28fa2d0083f385f7340c787 \
  79cf67072ef3f2c126fb17bfcf324d2ba1d3472f \
  e787f7bc0fb71347de33c340adcd22e005e4541e \
  0969805c31442b98532b1eb6250f299ba2524ae7 \
  01e22627388a6d5f9b89f2a9aca0e116d094487a \
  092d27bfeb9d84b21d0e843b0706273bd0314290 \
  1c919f00570c3bb70088114083d8598c01c77903 \
  >"$published_records"
sanitize_historical_commit_records "$published_records" "$history_messages" \
  >"$fixture_root/applied-pin-receipt"
assert_safe_reachable_commit_messages "$history_messages"
if ! grep -F 'commits=11' "$fixture_root/applied-pin-receipt" >/dev/null; then
  printf 'policy test failed: applied-pin receipt omitted commit count\n' >&2
  exit 1
fi
if ! grep -F 'occurrences=16' "$fixture_root/applied-pin-receipt" >/dev/null; then
  printf 'policy test failed: applied-pin receipt omitted occurrence count\n' >&2
  exit 1
fi

HISTORY_POLICY_RECORDS="$published_records" HISTORY_POLICY_ROOT="$fixture_root" bun --cwd "$repo_root" -e '
  import { createHash } from "node:crypto";
  import { closeSync, ftruncateSync, openSync, readFileSync, writeFileSync } from "node:fs";
  import {
    HISTORY_RECORD_LIMIT_BYTES,
    HistoryPolicyError,
    PUBLISHED_HISTORY_OCCURRENCE_COUNT,
    PUBLISHED_HISTORY_PINS,
    parseFramedCommitRecords,
    sanitizeHistoricalCommitRecords,
  } from "./scripts/verify-history.ts";

  const file = process.env.HISTORY_POLICY_RECORDS;
  const root = process.env.HISTORY_POLICY_ROOT;
  if (file === undefined || root === undefined) throw new Error("history fixture paths required");
  const bytes = readFileSync(file);
  const parsed = parseFramedCommitRecords(bytes);
  if (parsed.length !== PUBLISHED_HISTORY_PINS.length) throw new Error("published pin count changed");
  const bySha = new Map(parsed.map((record) => [record.sha, record]));
  let occurrences = 0;
  for (const pin of PUBLISHED_HISTORY_PINS) {
    const record = bySha.get(pin.sha);
    if (record === undefined) throw new Error("published pin missing from producer");
    if (createHash("sha256").update(record.message).digest("hex") !== pin.messageSha256) {
      throw new Error("published message digest drifted");
    }
    occurrences += pin.occurrences.length;
  }
  if (occurrences !== PUBLISHED_HISTORY_OCCURRENCE_COUNT) throw new Error("published occurrence count drifted");
  const first = parsed[0];
  if (first === undefined) throw new Error("published records empty");
  const save = (name: string, value: Buffer) => writeFileSync(root + "/" + name, value);
  const join = (records: { sha: string; message: Buffer }[]) =>
    Buffer.concat(records.flatMap((record) => [Buffer.from(record.sha), Buffer.from([0]), record.message, Buffer.from([0])]));
  save("changed-message", join([{ sha: first.sha, message: Buffer.concat([first.message, Buffer.from("Ordinary correction\n")]) }, ...parsed.slice(1)]));
  save("changed-identity", join([{ sha: "1".repeat(40), message: first.message }, ...parsed.slice(1)]));
  save("extra-occurrence", join([{ sha: first.sha, message: Buffer.concat([first.message, Buffer.from("x")]) }, ...parsed.slice(1)]));
  save("missing-pin", join(parsed.slice(1)));
  save("duplicate-pin", Buffer.concat([bytes, bytes]));
  save("truncated-record", bytes.subarray(0, bytes.length - 1));
  save("copied-message", Buffer.concat([bytes, Buffer.from("1".repeat(40) + "\0"), first.message, Buffer.from([0])]));
  const future = Buffer.from("2".repeat(40) + "\0First neutral message\0" + "3".repeat(40) + "\0Second neutral message\0");
  save("neutral-future", Buffer.concat([bytes, future]));
  const large = openSync(root + "/over-budget", "w");
  ftruncateSync(large, HISTORY_RECORD_LIMIT_BYTES + 1);
  closeSync(large);
  save("invalid-sha", Buffer.from("not-a-sha\0message\0"));
  const token = "her" + "mes";
  const overlapMessage = Buffer.from(token + token + "\n");
  const overlapDigest = createHash("sha256").update(overlapMessage).digest("hex");
  const probe = (message: Buffer, digest: string, occurrences: { offset: number; length: number }[]) => {
    const pin = { sha: "a".repeat(40), messageSha256: digest, occurrences };
    try {
      sanitizeHistoricalCommitRecords(Buffer.concat([Buffer.from("a".repeat(40)), Buffer.from([0]), message, Buffer.from([0])]), [pin]);
      return "passed";
    } catch (error) {
      return error instanceof HistoryPolicyError ? error.code : "unknown";
    }
  };
  const hello = Buffer.from("hello world\n");
  const helloDigest = createHash("sha256").update(hello).digest("hex");
  if (probe(hello, helloDigest, [{ offset: 100, length: 6 }]) !== "offset") throw new Error("out-of-bounds offset passed");
  if (probe(overlapMessage, overlapDigest, [{ offset: 0, length: 6 }, { offset: 1, length: 6 }]) !== "offset") {
    throw new Error("overlapping offset passed");
  }
  if (probe(hello, helloDigest, [{ offset: 0, length: 5 }]) !== "offset") throw new Error("non-identifier offset passed");
'

for invalid in changed-message changed-identity extra-occurrence missing-pin duplicate-pin truncated-record over-budget invalid-sha; do
  expect_policy_status 2 "$invalid exception" sanitize_historical_commit_records "$fixture_root/$invalid" "$fixture_root/rejected-output"
  if [[ -e "$fixture_root/rejected-output" ]]; then
    printf 'policy test failed: rejected records produced an output\n' >&2
    exit 1
  fi
done

source_git="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ "$source_git" != /* ]]; then
  git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir)"
  common_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
  if [[ "$common_dir" = /* ]]; then
    source_git="$common_dir"
  else
    source_git="$(cd -- "$git_dir/$common_dir" && pwd)"
  fi
fi
fetch_published_main() {
  local dest="$1" spec="$2"
  if git -C "$dest" fetch --no-tags "$source_git" +refs/remotes/origin/main:"$spec"; then
    return 0
  fi
  git -C "$dest" fetch --no-tags "$source_git" +a5f0d6b69eed7bfc4d79effdc136f8506e271516:"$spec"
}

iso_head="$fixture_root/iso-head"
git init -q "$iso_head"
fetch_published_main "$iso_head" refs/remotes/origin/main
printf 'orphan\n' >"$iso_head/orphan.txt"
git -C "$iso_head" add orphan.txt
git -C "$iso_head" -c user.name=verifier -c user.email=verifier@example.invalid commit -q -m 'orphan head'
(
  cd "$iso_head"
  sanitize_historical_commit_records "$published_records" "$iso_head/ok-messages"
)
assert_safe_reachable_commit_messages "$iso_head/ok-messages"

iso_na="$fixture_root/iso-nonancestor"
git init -q "$iso_na"
fetch_published_main "$iso_na" refs/heads/published-main
printf 'other\n' >"$iso_na/other.txt"
git -C "$iso_na" add other.txt
git -C "$iso_na" -c user.name=verifier -c user.email=verifier@example.invalid commit -q -m 'unrelated main'
git -C "$iso_na" update-ref refs/remotes/origin/main HEAD
expect_policy_status 2 'non-ancestor history' bash -c 'source "$1"; cd "$2"; sanitize_historical_commit_records "$3" "$4"' \
  _ "$script_dir/verify.sh" "$iso_na" "$published_records" "$fixture_root/rejected-output"

iso_replace="$fixture_root/iso-replace"
git init -q "$iso_replace"
git -C "$iso_replace" config user.name verifier
git -C "$iso_replace" config user.email verifier@example.invalid
fetch_published_main "$iso_replace" refs/remotes/origin/main
replace_tree="$(git -C "$iso_replace" rev-parse --verify 'refs/remotes/origin/main^{tree}')"
replace_commit="$(git -C "$iso_replace" commit-tree "$replace_tree" -m 'neutral replacement')"
git -C "$iso_replace" replace 74d4e96b89e261ee5102fd52cc09d3a65aa67637 "$replace_commit"
expect_policy_status 2 'replaced-object history' bash -c 'source "$1"; cd "$2"; sanitize_historical_commit_records "$3" "$4"' \
  _ "$script_dir/verify.sh" "$iso_replace" "$published_records" "$fixture_root/rejected-output"

sanitize_historical_commit_records "$fixture_root/copied-message" "$history_messages"
expect_policy_status 1 'copied historical message' assert_safe_reachable_commit_messages "$history_messages"
sanitize_historical_commit_records "$fixture_root/neutral-future" "$history_messages"
assert_safe_reachable_commit_messages "$history_messages"

if ! grep -F 'verify-history.ts' "$script_dir/verify.sh" >/dev/null; then
  printf 'policy test failed: history pin helper is not invoked\n' >&2
  exit 1
fi
if ! grep -F 'verify-secrets.ts' "$script_dir/verify.sh" >/dev/null; then
  printf 'policy test failed: secrets gate is not invoked\n' >&2
  exit 1
fi
if grep -F 'strip_git_trailers' "$script_dir/verify.sh" >/dev/null; then
  printf 'policy test failed: global trailer exemption remains\n' >&2
  exit 1
fi
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

if ! grep -F 'verify-dependencies.ts' "$script_dir/verify.sh" >/dev/null; then
  printf 'policy test failed: lockfile dependency gate is not invoked\n' >&2
  exit 1
fi
if bun "$script_dir/verify-dependencies.ts" >/dev/null; then
  :
else
  printf 'policy test failed: live lockfile dependency gate failed\n' >&2
  exit 1
fi
deps_fixture="$(mktemp -d)"
printf '{ "lockfileVersion": 1, "packages": { "harmless": ["@sentry/node@7.0.0"] } }\n' >"$deps_fixture/bun.lock"
if bun "$script_dir/verify-dependencies.ts" "$deps_fixture" >/dev/null 2>"$deps_fixture/err"; then
  printf 'policy test failed: denied lockfile dependency passed\n' >&2
  rm -rf -- "$deps_fixture"
  exit 1
fi
if ! grep -F '@sentry/node' "$deps_fixture/err" >/dev/null; then
  printf 'policy test failed: lockfile dependency failure was not propagated\n' >&2
  rm -rf -- "$deps_fixture"
  exit 1
fi
rm -rf -- "$deps_fixture"

printf 'verification policy tests passed\n'
