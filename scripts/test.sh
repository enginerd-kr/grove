#!/usr/bin/env bash
# `bun test` exits non-zero when no file matches, which is a repository whose
# tests have not been written yet and not a failing test run. That one case is
# reported and passed over; everything else is `bun test`, exit code and all.
set -euo pipefail

if [ -z "$(find src -name '*.test.ts' -o -name '*.test.tsx' | head -1)" ]; then
  echo "no test files — nothing to run"
  exit 0
fi

exec bun test "$@"
