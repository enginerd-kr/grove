import type { Reporter } from "../../report/reporter.ts";
import { fetchRemotes } from "../branches.ts";
import { isGroveError } from "../errors.ts";
import { runGit } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { type Finished, listWorktreeSummaries, type WorktreeSummary } from "./list.ts";
import { removeWorktree } from "./remove.ts";
import { describeDiscard } from "./reset.ts";

/**
 * `grove prune` — clear away the worktrees that are finished with.
 *
 * The problem this exists for is not making worktrees, which `add` already
 * does in one word. It is that they never go away: a pull request is merged,
 * the branch disappears from the forge, and the directory it was checked out
 * into sits there for the rest of the year. Thirty of those is what makes a
 * `grove list` unreadable, and removing them one at a time is bookkeeping —
 * which is the thing this tool exists to take away.
 *
 * What counts as finished is `list`'s `finished`, and it is deliberately two
 * things: the remote no longer has the branch, or the trunk already has every
 * commit on it. See `Finished` there for why neither alone is enough.
 *
 * This removes by default rather than asking first, for the same reason
 * `remove` does: a command line is where you type things on purpose, and there
 * is nothing to prompt on in a pipe. What makes that safe is what it refuses —
 * anything holding uncommitted work, anything mid-rebase, anything locked, and
 * the directory your shell is standing in are reported and left exactly where
 * they are. A removed worktree costs a `grove add` to bring back; the four it
 * skips are the ones that would cost more than that.
 */

export type PruneOptions = {
  /** Only one kind of finished. Absent means both, which is the usual answer. */
  readonly only?: Finished;
  /** Say what would go, and remove nothing. */
  readonly dryRun: boolean;
  /** Delete the branch too, where git will part with it. */
  readonly deleteBranch: boolean;
  /**
   * Fetch first. On by default, and load-bearing rather than a courtesy:
   * `gone` means "the remote-tracking ref is not there", and that ref is only
   * withdrawn by a fetch that prunes. Without one, a branch deleted on the
   * forge this morning still reads as alive.
   */
  readonly fetch: boolean;
};

export type PruneEntry = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  readonly reason: Finished;
  /** Why it is still there. Absent means it went — or would have, on a dry run. */
  readonly skipped?: string;
  /** True when the branch went with the directory. */
  readonly branchDeleted: boolean;
  /** Set when the branch was kept because git would not part with it. */
  readonly branchKept?: string;
};

export type PruneResult = {
  /** Every finished worktree, each saying what happened to it. */
  readonly entries: readonly PruneEntry[];
  readonly dryRun: boolean;
};

/**
 * Why this one stays where it is, or nothing.
 *
 * Each of these is a worktree holding something a removal would take with it,
 * and none of them is overridable here. `grove remove --force` is where that
 * decision is made, one worktree at a time, having read which one it is —
 * which is the opposite of what a command that sweeps up a dozen should offer.
 */
function skipReason(summary: WorktreeSummary): string | undefined {
  if (summary.current) return "you are standing in it";
  if (summary.locked) return "locked";
  if (summary.rebasing) return "a rebase is stopped part-way through";
  if (summary.dirty) {
    return `holds ${describeDiscard(summary.changed - summary.untracked, summary.untracked)}`;
  }

  return undefined;
}

/**
 * Deletes the branch, and treats git's refusal as news rather than a failure.
 *
 * Always `-d`, never `-D`. git refuses to delete a branch holding commits that
 * are on nothing else, and that refusal is the entire safety of deleting
 * branches in bulk — a `gone` branch whose pull request was squashed genuinely
 * does hold commits no other ref has, and forcing past that would throw away
 * the only copy. What it refuses is reported with the one command that would
 * do it anyway, so the decision stays with the person who can make it.
 */
async function deleteBranch(
  bare: string,
  branch: string,
): Promise<{ deleted: boolean; kept?: string }> {
  const result = await runGit(["branch", "-d", branch], { cwd: bare });
  if (result.code === 0) return { deleted: true };

  return { deleted: false, kept: `git -C ${bare} branch -D ${branch}` };
}

export async function pruneWorktrees(
  repo: RepoPaths,
  cwd: string,
  options: PruneOptions,
  reporter: Reporter,
): Promise<PruneResult> {
  if (options.fetch) {
    const step = reporter.step("fetching");
    // Answered rather than thrown, like every other fetch in this tool: offline,
    // the `merged` half of the question is still answerable from what is
    // already here, and refusing to prune anything at all would be a worse
    // trade than a `gone` badge that is a day stale.
    if (await fetchRemotes(repo.gitDir)) step.succeed("fetched");
    else step.fail("could not fetch — working from what was last seen");
  }

  const summaries = await listWorktreeSummaries(repo, cwd);
  const finished = summaries.filter(
    (summary): summary is WorktreeSummary & { finished: Finished } =>
      summary.finished !== undefined &&
      (options.only === undefined || summary.finished === options.only),
  );

  // Deepest first, so removing the last worktree under `feat/` lets the same
  // call clear the empty `feat/` behind it instead of tripping over a sibling
  // that has not gone yet.
  const ordered = finished.toSorted(
    (a, b) => b.dir.split("/").length - a.dir.split("/").length || a.dir.localeCompare(b.dir),
  );

  const entries: PruneEntry[] = [];

  for (const summary of ordered) {
    const base = {
      path: summary.path,
      dir: summary.dir,
      // Narrowed by the filter above: `finished` is only ever set for a branch.
      branch: summary.branch ?? "",
      reason: summary.finished,
      branchDeleted: false,
    };

    const skipped = skipReason(summary);
    if (skipped !== undefined) {
      entries.push({ ...base, skipped });
      continue;
    }

    if (options.dryRun) {
      entries.push(base);
      continue;
    }

    try {
      // The same removal `grove remove` performs, refusals and all — this is
      // that command in a loop and not a wider power, which is what makes a
      // dozen of them at once safe to type. Anything it declines lands below
      // as a skip in its own words.
      await removeWorktree(
        repo,
        cwd,
        { target: summary.path, force: false, deleteBranch: false },
        reporter,
      );
    } catch (error) {
      entries.push({
        ...base,
        skipped: isGroveError(error) ? error.message : String(error),
      });
      continue;
    }

    if (!options.deleteBranch || base.branch.length === 0) {
      entries.push(base);
      continue;
    }

    const outcome = await deleteBranch(repo.gitDir, base.branch);
    entries.push({ ...base, branchDeleted: outcome.deleted, branchKept: outcome.kept });
  }

  return { entries, dryRun: options.dryRun };
}

/** What went, what would go, and what stayed — the counts, in one line. */
export function describePrune(result: PruneResult): string {
  const skipped = result.entries.filter((entry) => entry.skipped !== undefined);
  const acted = result.entries.length - skipped.length;

  if (result.entries.length === 0) return "nothing is finished with";

  const verb = result.dryRun ? "would remove" : "removed";
  const parts = [`${verb} ${acted}`];

  const branches = result.entries.filter((entry) => entry.branchDeleted).length;
  if (branches > 0) parts.push(`${branches} branch${branches === 1 ? "" : "es"} deleted`);
  if (skipped.length > 0) parts.push(`${skipped.length} left alone`);

  return parts.join(", ");
}

/**
 * A line per worktree, saying which of the two answers put it on the list.
 *
 * The reason is on every row on purpose. `gone` and `merged` are not the same
 * claim — one is somebody having deleted the branch, the other is arithmetic
 * about commits — and a list that flattened them into "finished" would be
 * asking to be trusted about a judgement it did not show its working for.
 */
export function formatPruneTable(result: PruneResult): string {
  const dirWidth = Math.max(0, ...result.entries.map((entry) => entry.dir.length));
  const reasonWidth = Math.max(0, ...result.entries.map((entry) => entry.reason.length));

  return result.entries
    .map((entry) => {
      const marker = entry.skipped === undefined ? (result.dryRun ? "-" : "✓") : "·";
      const tail =
        entry.skipped !== undefined
          ? `  kept: ${entry.skipped}`
          : entry.branchDeleted
            ? "  branch deleted"
            : entry.branchKept !== undefined
              ? `  branch kept: ${entry.branchKept}`
              : "";

      return `${marker} ${entry.dir.padEnd(dirWidth)}  ${entry.reason.padEnd(reasonWidth)}${tail}`;
    })
    .join("\n");
}
