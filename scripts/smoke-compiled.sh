#!/usr/bin/env bash
# Prove a compiled binary works where compilation can break it: the version it
# reports, the headless commands, and the shell wrapper — whose emitted
# function must call back by the binary's own path, never the virtual
# /$bunfs entry the bundle knows itself by.
#
# Usage: scripts/smoke-compiled.sh dist/compile/<target>/garden
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

# The wrapper must not leak the virtual entry path.
if "$bin" shell-init bash | grep -q 'bunfs'; then
  echo 'shell-init leaks $bunfs into the wrapper' >&2
  exit 1
fi

# The whole loop, through the binary itself: clone a managed repo, install the
# wrapper in a real bash, list through it, and land in the repo root with
# `garden cd`. A plain `git init` repo will not do — cd and list only answer
# inside a repository this tool laid out.
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

bash -eu -c "
  eval \"\$('$bin' shell-init bash)\"
  cd '$work/repo/main'
  garden list >/dev/null
  garden cd
  [ \"\$PWD\" = \"\$(cd '$work/repo' && pwd -P)\" ] || { echo 'cd landed elsewhere' >&2; exit 1; }
"

echo "smoke ok: $bin"
