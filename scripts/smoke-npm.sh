#!/usr/bin/env bash
# Prove the npm packaging works where packaging can break it.
#
# Usage: scripts/smoke-npm.sh --launcher-only
#        scripts/smoke-npm.sh [target]
#
# --launcher-only needs no binaries: it stands a fake platform package next to
# the launcher and checks that arguments, the install-channel variable and the
# exit status all pass through, and that a missing package is reported by
# name. CI runs it on every pull request.
#
# The default form takes dist/npm as scripts/build-npm.ts left it, packs the
# main package and the platform package for `target` (this machine's, when
# not given) with `npm pack`, unpacks both into the layout `npm install -g`
# produces — main beside its dependency under one node_modules — and runs
# scripts/smoke-compiled.sh through the launcher, so the version, the
# executable bit and the clone/list/path loop are all exercised through the
# same file npm would put on a PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

scope="@enginerd-kr"
host="$(node -p 'process.platform + "-" + process.arch')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
modules="$work/node_modules/$scope"
mkdir -p "$modules"

launcher_only() {
  mkdir -p "$modules/grove/bin" "$modules/grove-$host/bin"
  printf '{"type":"module"}\n' > "$modules/grove/package.json"
  cp npm/grove/bin/grove.js "$modules/grove/bin/grove.js"
  printf '{"name":"%s/grove-%s"}\n' "$scope" "$host" > "$modules/grove-$host/package.json"
  # A stand-in binary that reports what it was handed and exits with a number
  # nothing else in this script produces.
  printf '#!/bin/sh\nprintf "%%s|%%s\\n" "$GROVE_INSTALL_CHANNEL" "$*"\nexit 7\n' \
    > "$modules/grove-$host/bin/grove"
  chmod 755 "$modules/grove-$host/bin/grove"

  set +e
  out="$(node "$modules/grove/bin/grove.js" --version --x 2>&1)"
  status=$?
  set -e
  [ "$out" = "npm|--version --x" ] || { echo "launcher passed '$out'" >&2; exit 1; }
  [ "$status" = 7 ] || { echo "launcher exited $status, child exited 7" >&2; exit 1; }

  # The channel is the launcher's to set only when nobody set it first.
  out="$(GROVE_INSTALL_CHANNEL=other node "$modules/grove/bin/grove.js" 2>&1 || true)"
  [ "$out" = "other|" ] || { echo "launcher overrode the channel: '$out'" >&2; exit 1; }

  rm -rf "$modules/grove-$host"
  set +e
  err="$(node "$modules/grove/bin/grove.js" 2>&1 >/dev/null)"
  status=$?
  set -e
  [ "$status" = 1 ] || { echo "missing package exited $status, want 1" >&2; exit 1; }
  case "$err" in
    *"$scope/grove-$host"*) ;;
    *) echo "missing-package error does not name the package: $err" >&2; exit 1 ;;
  esac

  echo "smoke ok: launcher"
}

packages() {
  local target="$1"
  local tarballs="$work/tarballs"
  mkdir -p "$tarballs"

  for pkg in grove "grove-$target"; do
    [ -f "dist/npm/$pkg/package.json" ] \
      || { echo "dist/npm/$pkg is missing; run scripts/build-npm.ts first" >&2; exit 1; }
    (cd "dist/npm/$pkg" && npm pack --silent --pack-destination "$tarballs" >/dev/null)
  done

  # `files` decides what ships. Anything beyond these four lines is a leak;
  # anything short of them is a launcher with nothing to launch.
  # Named exactly: `grove-*` would also match the platform tarball.
  version="$(node -p 'require("./dist/npm/grove/package.json").version')"
  for pkg in grove "grove-$target"; do
    tarball="$tarballs/enginerd-kr-$pkg-$version.tgz"
    [ -f "$tarball" ] || { echo "npm pack did not write $tarball" >&2; exit 1; }
    want="package/LICENSE
package/README.md
package/bin/$([ "$pkg" = grove ] && echo grove.js || echo grove)
package/package.json"
    got="$(tar -tzf "$tarball" | LC_ALL=C sort)"
    [ "$got" = "$want" ] || {
      echo "$pkg tarball holds:" >&2
      echo "$got" >&2
      echo "want:" >&2
      echo "$want" >&2
      exit 1
    }
    mkdir -p "$modules/$pkg"
    tar -xzf "$tarball" -C "$modules/$pkg" --strip-components=1
  done

  [ -x "$modules/grove-$target/bin/grove" ] \
    || { echo "bin/grove lost its executable bit through npm pack" >&2; exit 1; }
  [ -x "$modules/grove/bin/grove.js" ] \
    || { echo "bin/grove.js lost its executable bit through npm pack" >&2; exit 1; }

  bash scripts/smoke-compiled.sh "$modules/grove/bin/grove.js"
  echo "smoke ok: npm packages ($target)"
}

case "${1:-}" in
  --launcher-only) launcher_only ;;
  "") packages "$host" ;;
  *) packages "$1" ;;
esac
