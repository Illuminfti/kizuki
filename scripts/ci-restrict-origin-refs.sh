#!/usr/bin/env bash
# checkout fetch-depth:0 downloads every origin head. Sibling lanes own
# their commit messages. Keep origin/main so git log --all still sees
# shared history. Fail closed if main cannot be fetched.
set -euo pipefail

while IFS= read -r ref; do
  case "$ref" in
    refs/remotes/origin/main|refs/remotes/origin/HEAD)
      ;;
    refs/remotes/origin/*)
      git update-ref -d "$ref"
      ;;
  esac
done < <(git for-each-ref --format='%(refname)' refs/remotes/origin)

if git show-ref --verify --quiet refs/remotes/origin/main; then
  printf 'origin-refs: kept origin/main\n'
  exit 0
fi

git fetch --no-tags origin main
if ! git show-ref --verify --quiet refs/remotes/origin/main; then
  printf 'verification failed: origin/main is missing after restrict\n' >&2
  exit 2
fi
printf 'origin-refs: fetched origin/main\n'
