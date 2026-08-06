#!/usr/bin/env bash
# Compile grove into self-contained binaries for every platform the Homebrew
# tap serves. Outputs dist/compile/<os>-<arch>/grove and dist/release/
# grove-<os>-<arch>.tar.gz — each tarball holds a single file named `grove`,
# which is exactly what the formula's `bin.install "grove"` expects.
set -euo pipefail
cd "$(dirname "$0")/.."

targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

rm -rf dist/compile dist/release
mkdir -p dist/release

for t in "${targets[@]}"; do
  # No --packages external here: the point is everything inside one file. The
  # --define freezes Ink's devtools guard (reconciler.js reads process.env.DEV)
  # to "false", so dead-code elimination drops the import edge to devtools.js —
  # whose static `import 'react-devtools-core'` would otherwise fail to
  # resolve, that package being an optional peer nobody installs. A build that
  # succeeds is the proof the define worked; without it, this line fails.
  # GROVE_RELEASE marks the binary as a released build — the only kind with an
  # upgrade to be told about, so the only kind that checks for one. A source
  # tree never sets it and is never nagged to "upgrade" to something older
  # than itself.
  bun build src/cli.tsx --compile "--target=bun-${t}" \
    --define 'process.env.DEV="false"' \
    --define 'process.env.GROVE_RELEASE="true"' \
    --minify --sourcemap \
    --outfile "dist/compile/${t}/grove"

  tar -czf "dist/release/grove-${t}.tar.gz" -C "dist/compile/${t}" grove
done

ls -l dist/release
