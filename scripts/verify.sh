#!/usr/bin/env bash
set -euo pipefail

verify_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

assert_no_match() {
  local label="$1"
  shift
  local output
  local status

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e

  case "$status" in
    0)
      printf 'verification failed: %s matched\n%s\n' "$label" "$output" >&2
      return 1
      ;;
    1)
      return 0
      ;;
    *)
      printf 'verification failed: %s scanner exited %d\n%s\n' "$label" "$status" "$output" >&2
      return "$status"
      ;;
  esac
}

assert_exact_attribution_spelling() {
  local canonical_url='https://github.com/garrytan/g''brain'
  local exact_spelling='G''Brain'
  local path
  local -a present_paths=()

  for path in "$@"; do
    if [[ ! -e "$path" ]]; then
      printf 'verification failed: attribution path is missing\n%s\n' "$path" >&2
      return 2
    fi
    if [[ ! -f "$path" ]]; then
      printf 'verification failed: attribution path is not a regular file\n%s\n' "$path" >&2
      return 2
    fi
    present_paths+=("$path")
  done
  if ((${#present_paths[@]} == 0)); then
    printf 'verification failed: attribution validator found no configured documents\n' >&2
    return 2
  fi

  printf '%s\0' "${present_paths[@]}" |
    ATTRIBUTION_CANONICAL_URL="$canonical_url" \
    ATTRIBUTION_EXACT_SPELLING="$exact_spelling" \
    bun "$verify_script_dir/verify-attribution.ts"
}

assert_safe_tracked_paths() {
  local identifier_re="$1"
  local path
  local paths_file
  local status

  paths_file="$(mktemp)"
  set +e
  git ls-files -z >"$paths_file"
  status=$?
  set -e
  if ((status != 0)); then
    rm -f -- "$paths_file"
    printf 'verification failed: tracked-path producer exited %d\n' "$status" >&2
    return "$status"
  fi

  shopt -s nocasematch
  while IFS= read -r -d '' path; do
    if [[ "$path" =~ $identifier_re ]]; then
      shopt -u nocasematch
      rm -f -- "$paths_file"
      printf 'verification failed: forbidden identifier in tracked path\n%s\n' "$path" >&2
      return 1
    fi
  done <"$paths_file"
  shopt -u nocasematch
  rm -f -- "$paths_file"
}

assert_scannable_tracked_text() {
  # The identifier and attribution gates below run `git grep -I`, which never
  # reads a file git classifies as binary. A tracked file that carries a NUL
  # byte is therefore invisible to every one of them.
  local nonempty
  local scannable
  local unscannable
  local status

  set +e
  nonempty="$(git grep -a -l -e '.' -- .)"
  status=$?
  set -e
  if ((status > 1)); then
    printf 'verification failed: tracked-text producer exited %d\n' "$status" >&2
    return "$status"
  fi

  set +e
  scannable="$(git grep -I -l -e '.' -- .)"
  status=$?
  set -e
  if ((status > 1)); then
    printf 'verification failed: scannable-text producer exited %d\n' "$status" >&2
    return "$status"
  fi

  unscannable="$(comm -23 <(printf '%s\n' "$nonempty" | sort) <(printf '%s\n' "$scannable" | sort))"
  if [[ -n "$unscannable" ]]; then
    printf 'verification failed: tracked file is not scannable text\n%s\n' "$unscannable" >&2
    return 1
  fi
}

assert_required_commands() {
  local cmd
  for cmd in bun comm git grep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      printf 'verification failed: required command missing: %s\n' "$cmd" >&2
      return 2
    fi
  done
}

assert_required_helpers() {
  local path
  for path in \
    "$verify_script_dir/verify-attribution.ts" \
    "$verify_script_dir/verify-network.ts" \
    "$verify_script_dir/verify-secrets.ts" \
    "$verify_script_dir/verify-workflows.ts" \
    "$verify_script_dir/network-allowlist.txt" \
    "$verify_script_dir/verify-policy.test.sh" \
    "$verify_script_dir/ci-restrict-origin-refs.sh" \
    "$verify_script_dir/ci-gitleaks.sh"
  do
    if [[ ! -f "$path" ]]; then
      printf 'verification failed: required helper missing\n%s\n' "$path" >&2
      return 2
    fi
  done
}

assert_full_history() {
  local shallow
  shallow="$(git rev-parse --is-shallow-repository)"
  if [[ "$shallow" == "true" ]]; then
    printf 'verification failed: shallow clone cannot scan reachable commit messages\n' >&2
    return 2
  fi
  if [[ "$shallow" != "false" ]]; then
    printf 'verification failed: could not determine whether the clone is shallow\n' >&2
    return 2
  fi
}

phone_home_dependency_pattern() {
  printf '%s' '"(posthog|@sentry|sentry|@amplitude|mixpanel|segment|@datadog|newrelic|@newrelic|bugsnag|@bugsnag|rollbar|analytics-node|@vercel/analytics|@opentelemetry|telemetry)'
}

reachable_commit_identifier_pattern() {
  # Bound the first denylist token with POSIX ERE delimiters so a longer
  # public GitHub owner name that only shares that prefix cannot match.
  # Remaining tokens stay unanchored substring matches. No Perl regex.
  printf '%s' '(^|[^[:alnum:]])ill''umi([^[:alnum:]]|$)|her''mes|ika-''hetzner|alb''edo|g''brain'
}

assert_safe_reachable_commit_messages() {
  local messages_file="$1"

  assert_no_match \
    "forbidden identifier in reachable commit messages" \
    grep -I -n -i -E "$(reachable_commit_identifier_pattern)" "$messages_file"
}

gate() {
  printf 'gate: %s\n' "$1"
}

main() {
  local dependency_re
  local forbidden_identifier_re='ill''umi|her''mes|ika-''hetzner|alb''edo'
  local attributed_identifier_re='g''brain'
  local commit_messages
  local cleanup_command
  local log_status

  dependency_re="$(phone_home_dependency_pattern)"
  commit_messages="$(mktemp)"
  printf -v cleanup_command 'rm -f -- %q' "$commit_messages"
  trap "$cleanup_command" EXIT

  gate required-commands
  assert_required_commands
  gate required-helpers
  assert_required_helpers
  gate full-history
  assert_full_history
  bun "$verify_script_dir/verify-workflows.ts"
  gate workflows

  bun install --frozen-lockfile
  gate install
  bun run typecheck
  gate typecheck
  bun test
  gate test
  bash scripts/verify-policy.test.sh
  gate policy
  bun run scripts/verify-network.ts
  gate network

  assert_no_match "phone-home dependency" git grep -I -n -E "$dependency_re" -- ':(glob)**/package.json'
  gate phone-home
  assert_no_match "tls verification disabled" \
    git grep -I -n -E 'rejectUnauthorized[[:space:]]*:[[:space:]]*(false|0)' -- \
    ':(glob)**/*.ts' ':(glob)**/*.js' ':(glob)**/*.json'
  gate tls
  assert_scannable_tracked_text
  assert_safe_tracked_paths "$forbidden_identifier_re|$attributed_identifier_re"
  assert_no_match "forbidden identifier in tracked text" git grep -I -n -i -E "$forbidden_identifier_re"
  assert_no_match "attributed identifier outside public documentation" git grep -I -n -i -E "$attributed_identifier_re" -- . ':(exclude)README.md' ':(exclude)docs/upstream-policy.md'
  assert_exact_attribution_spelling README.md docs/upstream-policy.md
  gate denylist-tracked

  set +e
  git log --all --format=%B >"$commit_messages"
  log_status=$?
  set -e
  if ((log_status != 0)); then
    printf 'verification failed: reachable commit-message producer exited %d\n' "$log_status" >&2
    return "$log_status"
  fi
  if [[ ! -s "$commit_messages" ]]; then
    printf 'verification failed: reachable commit-message scan produced no text\n' >&2
    return 2
  fi
  assert_safe_reachable_commit_messages "$commit_messages"
  gate denylist-history
  bun "$verify_script_dir/verify-secrets.ts"
  gate secrets
  printf 'VERIFY_OK\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
