#!/usr/bin/env bash
# The suite in two tiers, and the one place that decides which is which.
#
#   *.test.ts       in-process. Pure logic, and real git called as a function.
#                   Cheap: the git tier averages 55ms a test.
#   *.e2e.test.ts   spawns the real `cli.tsx`, over a pipe or a PTY. This is
#                   where "does the built thing actually work" is answered, and
#                   it costs about 460ms a test to answer it.
#
# The split is by filename because that is the one signal a person adding a
# test cannot get wrong by accident: a file that spawns the binary says so in
# its name, and lands in the tier that is allowed to be slow.
set -euo pipefail

usage() {
  echo "usage: test.sh [--unit | --e2e | --all] [bun test args…]" >&2
  exit 2
}

find_tests() {
  find src -name '*.test.ts' -o -name '*.test.tsx' | sort
}

MODE=all
case "${1-}" in
  --unit) MODE=unit; shift ;;
  --e2e) MODE=e2e; shift ;;
  --all) MODE=all; shift ;;
  --help | -h) usage ;;
esac

ALL=$(find_tests)

if [ -z "$ALL" ]; then
  # `bun test` exits non-zero when no file matches, which is a repository whose
  # tests have not been written yet and not a failing test run.
  echo "no test files — nothing to run"
  exit 0
fi

E2E=$(echo "$ALL" | grep '\.e2e\.test\.' || true)
UNIT=$(echo "$ALL" | grep -v '\.e2e\.test\.' || true)

# The default is 5s, and this suite spends most of its time waiting on real git
# processes and a PTY — close enough to 5s that ordinary background load tips a
# different handful of tests over it on every run, in files nobody touched. A
# pure ProgressBar test timing out is what gave it away: the process was being
# starved, not the test being slow. `--timeout` goes before "$@" so a caller's
# own still wins.
#
# `bun test --parallel` is measured and deliberately not used: it is worth 128s
# to 57s, and then roughly one run in six dies inside `spawn` itself, because
# every worker adds its own git and `cli.tsx` children to the ones the tests
# already spawn. It is also silently wrong for the Ink tests — it implies
# `--isolate`, which Ink's layout engine does not survive, and those files
# report as run with their tests missing. Splitting the tiers is the version of
# that idea that works: CI runs them as separate jobs, and shards the slow one.
run() {
  local label=$1
  shift
  local files=$1
  shift

  if [ -z "$files" ]; then
    echo "== $label: none =="
    return 0
  fi

  echo "== $label =="
  # shellcheck disable=SC2086
  bun test --timeout 30000 $files "$@"
}

status=0
case "$MODE" in
  unit) run unit "$UNIT" "$@" || status=$? ;;
  e2e) run e2e "$E2E" "$@" || status=$? ;;
  # Both, and both are reported even when the first fails: "what else is
  # broken" is the question you have after a red run.
  all)
    run unit "$UNIT" "$@" || status=$?
    run e2e "$E2E" "$@" || status=$?
    ;;
esac

exit "$status"
