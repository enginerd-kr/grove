#!/usr/bin/env bash
# `bun test` exits non-zero when no file matches, which is a repository whose
# tests have not been written yet and not a failing test run. That one case is
# reported and passed over; everything else is `bun test`, exit code and all.
set -euo pipefail

if [ -z "$(find src -name '*.test.ts' -o -name '*.test.tsx' | head -1)" ]; then
  echo "no test files — nothing to run"
  exit 0
fi

# `--timeout` before "$@" so a caller's own still wins. The default is 5s, and
# this suite spends most of its time waiting on real git processes and a PTY —
# close enough to 5s that ordinary background load tips several tests over it,
# a different handful every run, in files nobody touched. A pure ProgressBar
# test timing out is what gave it away: the process was being starved, not the
# test being slow. 30s is far enough above the slowest honest test to make a
# failure mean something, and far enough below a hang to still catch one.
#
# `bun test --parallel` is measured and deliberately not used. It is worth a
# lot of wall clock — 128s to about 57s on eight workers, 65s on four — but
# every worker spawns its own git and `cli.tsx` children on top of the ones the
# tests already spawn, and roughly one run in six then dies inside `spawn`
# itself, in a different test each time. A suite that is wrong one run in six
# costs more than the minute it saves. `--parallel` is also incompatible with
# the Ink tests regardless: it implies `--isolate`, and Ink's layout engine
# does not survive a fresh global, so those files report as run with their
# tests silently missing.
exec bun test --timeout 30000 "$@"
