#!/usr/bin/env bash
# Prove a compiled binary works where compilation can break it: the version it
# reports, and the headless commands, run against a real managed repository.
#
# Usage: scripts/smoke-compiled.sh dist/compile/<target>/grove
# Only the target this machine can execute, so CI runs it on linux-x64 and a
# release is hand-checked on darwin before the tap learns about it.
set -euo pipefail
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/.."

# The version is a package.json import inlined at build time; the binary and
# the tree it was built from must agree.
want="$(bun -e 'console.log(require("./package.json").version)')"
got="$("$bin" --version)"
[ "$got" = "$want" ] || { echo "version: got '$got' want '$want'" >&2; exit 1; }

# The whole loop, through the binary itself: clone a managed repo, list it, and
# ask it where the root is. A plain `git init` repo will not do — `list` and
# `path` only answer inside a repository this tool laid out.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git init --bare -q --initial-branch=main "$work/origin.git"
git init -q --initial-branch=main "$work/seed"
(
  cd "$work/seed"
  git -c user.email=smoke@invalid -c user.name=smoke commit -q --allow-empty -m seed
  git remote add origin "$work/origin.git"
  git push -q origin main
)

"$bin" clone "file://$work/origin.git" "$work/repo" --headless >/dev/null 2>&1

cd "$work/repo/main"
"$bin" list >/dev/null
root="$("$bin" path)"
[ "$root" = "$(cd "$work/repo" && pwd -P)" ] || {
  echo "path named elsewhere: '$root'" >&2
  exit 1
}
cd - >/dev/null

echo "smoke ok: $bin"
