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
      continue
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

main() {
  local dependency_re='"(posthog|@sentry|sentry|@amplitude|mixpanel|segment)'
  local forbidden_identifier_re='ill''umi|her''mes|ika-''hetzner|alb''edo'
  local attributed_identifier_re='g''brain'
  local commit_messages
  local cleanup_command
  local log_status

  commit_messages="$(mktemp)"
  printf -v cleanup_command 'rm -f -- %q' "$commit_messages"
  trap "$cleanup_command" EXIT

  bun install --frozen-lockfile
  bun run typecheck
  bun test
  bash scripts/verify-policy.test.sh
  bun run scripts/verify-network.ts
  bun run scripts/verify-docs.ts

  assert_no_match "phone-home dependency" git grep -I -n -E "$dependency_re" -- ':(glob)**/package.json'
  assert_safe_tracked_paths "$forbidden_identifier_re|$attributed_identifier_re"
  assert_no_match "forbidden identifier in tracked text" git grep -I -n -i -E "$forbidden_identifier_re"
  assert_no_match "attributed identifier outside public documentation" git grep -I -n -i -E "$attributed_identifier_re" -- . ':(exclude)README.md' ':(exclude)docs/upstream-policy.md'
  assert_exact_attribution_spelling README.md docs/upstream-policy.md

  set +e
  git log --all --format=%B >"$commit_messages"
  log_status=$?
  set -e
  if ((log_status != 0)); then
    printf 'verification failed: reachable commit-message producer exited %d\n' "$log_status" >&2
    return "$log_status"
  fi
  assert_no_match "forbidden identifier in reachable commit messages" grep -I -n -i -E "$forbidden_identifier_re|$attributed_identifier_re" "$commit_messages"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
