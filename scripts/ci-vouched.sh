#!/usr/bin/env bash
# Whether CI has already passed on the tree at a commit, so a release does not
# run the suite a second time — and cannot ship a tree the suite never saw.
#
#   ci-vouched.sh <commit>
#
# CI runs on pull requests and reports on the branch's head, so the commit it
# has spoken for is rarely the one a tag points at: that is the merge commit,
# which has never had a run of its own. But a branch that was up to date with
# main when it was merged makes a merge commit whose tree *is* the head's tree,
# byte for byte — and the tree is what the suite ran against, not the commit.
# So the question is put to the tree: this commit, or a parent whose tree it
# shares, must carry a green run.
#
# A merge whose base had moved on shares its tree with nothing, and is refused
# rather than tested here. Re-running the suite on this runner would answer on
# ubuntu alone, and the macOS half of the matrix is the half that has actually
# caught something; the answer is a PR against the main it will land on.
#
# Exit 0 when a green run vouches for the tree, 1 when none does, with the
# reason on stderr. Needs `gh` authenticated for the repository, and `jq`.
set -euo pipefail

# `^{commit}` because an annotated tag names a tag object, not what it points at.
sha=$(git rev-parse "${1:?usage: ci-vouched.sh <commit>}^{commit}")
repo=${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to owner/name}

# The check runs on a commit — the latest attempt of each, which is what the
# API returns by default, so a shard re-run to green does not leave its first
# attempt in the way. The release job asking this is itself a run on the
# commit it is asking about, and is in progress for as long as it asks.
check_runs() {
  gh api "repos/$repo/commits/$1/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.name != "release")]'
}

# 0 when every run present has finished and succeeded, 1 when one has failed,
# 2 when there are none. A run still going is waited for — a tag pushed the
# moment a PR merged can arrive before its last shard reports — but not
# forever.
green() {
  local deadline=$(( $(date +%s) + 900 ))

  while :; do
    local runs total pending failed
    if ! runs=$(check_runs "$1"); then
      echo "could not read the CI runs on ${1:0:7}" >&2
      return 1
    fi
    total=$(jq 'length' <<<"$runs")
    pending=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
    failed=$(jq '[.[] | select(.status == "completed" and .conclusion != "success")] | length' <<<"$runs")

    if [ "$total" -eq 0 ]; then
      return 2
    fi
    if [ "$failed" -gt 0 ]; then
      echo "CI did not pass on ${1:0:7}:" >&2
      jq -r '.[] | select(.status == "completed" and .conclusion != "success") | "  \(.name): \(.conclusion)"' <<<"$runs" >&2
      return 1
    fi
    if [ "$pending" -eq 0 ]; then
      echo "$total green CI runs on ${1:0:7}"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "still waiting on $pending of $total CI runs on ${1:0:7} after 15 minutes" >&2
      return 1
    fi

    echo "waiting on $pending of $total CI runs on ${1:0:7}…"
    sleep 30
  done
}

tree=$(git rev-parse "$sha^{tree}")

# The commit itself first, then each parent standing on the same tree. A run
# that exists and is not green refuses outright: a same-tree parent that passed
# would say the suite is flaky, not that this tree is fine.
for candidate in "$sha" $(git rev-list --parents -n 1 "$sha" | cut -d' ' -f2-); do
  [ "$(git rev-parse "$candidate^{tree}")" = "$tree" ] || continue

  status=0
  green "$candidate" || status=$?
  case $status in
    0)
      [ "$candidate" = "$sha" ] || echo "and ${sha:0:7} is a merge on that same tree"
      exit 0
      ;;
    1) exit 1 ;;
  esac
done

cat >&2 <<MSG
No CI run vouches for ${sha:0:7}: neither it nor a parent on the same tree has
one. CI runs on pull requests — tag a commit that came through one, merged
while its branch was up to date with main.
MSG
exit 1
