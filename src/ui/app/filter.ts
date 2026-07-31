import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { TreeLeaf } from "./tree.ts";

/**
 * The filter, ranked — what makes typing at this list feel like completing a
 * name rather than grepping one.
 *
 * Two things follow from that, and the second is the one worth arguing about.
 *
 * Ranked, because the row you meant should be the first row. Someone typing
 * `logi` has one worktree in mind, and a list that puts it third because `t`
 * sorts before `f` is making them read a list they already answered.
 *
 * And flat, because a tree cannot be ranked. Folders are a reading aid for the
 * whole set — `feat/`, `fix/`, `chore/` are how you find anything among thirty —
 * and the moment you have typed a name you are not reading the whole set any
 * more. Keeping the headings would bury the best match under one and put the
 * cursor on the heading instead of on the worktree. So the folders go, the paths
 * come back in full, and the tree returns the moment the filter does not.
 */

/**
 * How well `text` answers `needle`, lower being better, `undefined` being not
 * at all.
 *
 * The order is the useful part: an exact answer, then one that starts the way
 * you started, then one whose *word* starts that way — `logi` finding
 * `feat/login` is the same kind of hit as `feat` finding it, and both beat a
 * match buried mid-word. Last is a subsequence, which is what lets `fl` reach
 * `feat/login` without letting it outrank anything that actually spells it.
 */
function score(text: string, needle: string): number | undefined {
  const haystack = text.toLowerCase();

  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  // `/` and the punctuation people put in branch names, so `login` finds
  // `feat/login` and `crash` finds `fix/hot-crash`.
  if (haystack.split(/[/\-_.]/).some((word) => word.startsWith(needle))) return 2;
  if (haystack.includes(needle)) return 3;
  if (isSubsequence(haystack, needle)) return 4;

  return undefined;
}

/** Every character of `needle`, in order, somewhere in `haystack`. */
function isSubsequence(haystack: string, needle: string): boolean {
  let at = 0;

  for (const character of haystack) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }

  return needle.length === 0;
}

/**
 * The best score a worktree can offer, over each of the names it goes by.
 *
 * The last path segment first in spirit, though the arithmetic does not need to
 * say so: `login` scores 1 against the segment and 2 against the whole path, and
 * taking the better of the two is what makes typing the short name feel direct.
 */
function rate(summary: WorktreeSummary, needle: string): number | undefined {
  const segment = summary.dir.split("/").at(-1) ?? summary.dir;
  const scores = [segment, summary.dir, summary.branch ?? ""]
    .map((text) => score(text, needle))
    .filter((value): value is number => value !== undefined);

  return scores.length === 0 ? undefined : Math.min(...scores);
}

/**
 * The worktrees that match, best first, as rows the list can draw.
 *
 * Ties break on the shorter path — `feat/api` before `feat/api/v2` when both
 * matched the same way, since the shorter one is the more direct answer — then
 * on the default branch, then alphabetically, so the order is never arbitrary
 * between two equally good hits.
 */
export function rank(summaries: readonly WorktreeSummary[], filter: string): readonly TreeLeaf[] {
  const needle = filter.trim().toLowerCase();

  const rated = summaries
    .map((summary) => ({ summary, score: rate(summary, needle) }))
    .filter(
      (entry): entry is { summary: WorktreeSummary; score: number } => entry.score !== undefined,
    )
    .toSorted((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.summary.dir.length !== b.summary.dir.length) {
        return a.summary.dir.length - b.summary.dir.length;
      }
      if (a.summary.isDefault !== b.summary.isDefault) return a.summary.isDefault ? -1 : 1;

      return a.summary.dir.localeCompare(b.summary.dir);
    });

  // Depth 0 and the whole path as the label: there are no headings to indent
  // under, so the prefix has to be on the row or the row does not say which
  // worktree it is.
  return rated.map(({ summary }) => ({
    kind: "leaf" as const,
    key: summary.path,
    label: summary.dir,
    depth: 0,
    summary,
  }));
}
