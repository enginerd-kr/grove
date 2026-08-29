#!/bin/sh
#
# Stop hook: runs the fast half of the CI gate (`biome ci` + `tsc --noEmit`)
# before Claude finishes a turn.
#
# `bun test` is deliberately NOT here. The suite spawns real git processes and a
# PTY, so it runs for minutes rather than seconds — long enough that gating every
# turn on it cost more than it caught, and it overran the hook timeout. Lint and
# types still catch the mistakes a turn actually tends to end on.
#
# The consequence is the point: a green hook no longer means the tests pass.
# Run `bun run ci` before calling substantive work done.
#
# Wired up in .claude/settings.json. Exit codes:
#   0  nothing to check, or the gate passed
#   2  the gate failed - blocks the turn and hands the output back to Claude
set -u

input=$(cat)

# Claude was already sent back to fix a failure; don't loop on it.
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

# Hooks inherit the session cwd, which may be a subdirectory.
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# Skip turns that touched no source: a chat-only turn shouldn't cost a test run.
# Git pathspec globs match across directories, and `??` entries cover new files.
changed=$(git status --porcelain -- \
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.json' '*.jsonc')
[ -z "$changed" ] && exit 0

output=$(bun run check 2>&1) && exit 0

printf 'Stop hook: `bun run check` failed. Fix it before finishing.\n\n%s\n' "$output" >&2
exit 2
