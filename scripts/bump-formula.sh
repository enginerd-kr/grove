#!/usr/bin/env bash
# Rewrite a tap formula's `version` and sha256 lines from a release's
# SHA256SUMS. The formula stays the tap's document — its prose, its layout,
# its choices — and this touches nothing but the numbers, which is what lets
# the release workflow run it against a repo it does not own the words of.
#
# Usage: scripts/bump-formula.sh <formula.rb> <version> <SHA256SUMS>
set -euo pipefail
formula="$1" version="$2" sums="$3"

perl -pi -e 's/^(\s*version ")[^"]+(")/${1}'"$version"'${2}/' "$formula"

# Each checksum lands on the sha256 line directly under the url naming its
# tarball — matching by adjacency, so the mapping cannot silently cross.
while read -r sha file; do
  f="$file" s="$sha" perl -0pi -e '
    s/(\Q$ENV{f}\E"\n\s*sha256 ")[0-9a-f]+/${1}$ENV{s}/;
  ' "$formula"
done < "$sums"

# A half-done rewrite must fail loudly: every sum and the version must have
# landed, or brew would fetch a real tarball against a stale checksum.
while read -r sha _; do
  grep -q "$sha" "$formula" || { echo "sha ${sha} did not land in ${formula}" >&2; exit 1; }
done < "$sums"
grep -q "version \"${version}\"" "$formula" \
  || { echo "version ${version} did not land in ${formula}" >&2; exit 1; }
