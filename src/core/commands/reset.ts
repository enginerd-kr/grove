import { type Reporter, withStep } from "../../report/reporter.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import {
  LISTED,
  listWorktrees,
  refuseMidRebase,
  resolveTarget,
  statusOf,
  worktreeDir,
} from "../worktrees.ts";

/**
 * `grove reset` — throw away what a worktree has changed.
 *
 * The one command here that destroys work rather than moving it about, and the
 * only reason it exists as a command at all is that the alternative is worse:
 * without it people `cd` into the worktree and type `git reset --hard` from
 * memory, in whichever directory the shell happened to be in.
 *
 * So the whole command is about being specific. It names the worktree it is
 * resetting rather than trusting the current directory, it reads the status
 * first so the answer can say what went, and it refuses a worktree in the middle
 * of a rebase — where `reset --hard` does not mean "undo my changes", it means
 * "leave the rebase half-applied and unrecoverable".
 */

export type ResetOptions = {
  readonly target: string;
  /**
   * What to reset to. Defaults to the worktree's own HEAD, which discards
   * changes without moving the branch — a rewind is a different, bigger thing
   * and has to be asked for.
   */
  readonly to?: string;
  /** Also delete untracked files. `git reset --hard` leaves those alone. */
  readonly clean: boolean;
};

export type ResetResult = {
  readonly path: string;
  readonly dir: string;
  readonly branch?: string;
  /** What went. Capped — this is for reading, not for auditing. */
  readonly discarded: readonly string[];
  /** How many paths differed, of which `discarded` is the first few. */
  readonly changed: number;
  /** How many of `changed` git was not tracking. */
  readonly untracked: number;
  /** True when those were deleted too, rather than left where they were. */
  readonly cleaned: boolean;
  /** Where it ended up, so a rewind can be found again in the reflog. */
  readonly head: string;
};

/**
 * What a reset is about to take, or has taken, in words.
 *
 * The two kinds are counted apart wherever this is used, because they are
 * destroyed by different commands and one of them is work git has never seen a
 * copy of — "3 changes" covering a file you wrote ten minutes ago and never
 * added would be the sentence someone regrets having skimmed.
 */
export function describeDiscard(tracked: number, untracked: number): string {
  const parts: string[] = [];

  if (tracked > 0) parts.push(`${tracked} change${tracked === 1 ? "" : "s"}`);
  if (untracked > 0) {
    parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "nothing";

  return parts.join(" and ");
}

export async function resetWorktree(
  repo: RepoPaths,
  cwd: string,
  options: ResetOptions,
  reporter: Reporter,
): Promise<ResetResult> {
  const worktrees = await listWorktrees(repo.gitDir);
  const target = resolveTarget(options.target, worktrees, { root: repo.root, cwd });
  const dir = worktreeDir(repo.root, target.path);

  // Not overridable, and the one refusal here. A stopped rebase has commits
  // half-applied and its own HEAD; resetting through that abandons them
  // somewhere only the reflog remembers, which is not what anybody typing
  // "throw away my changes" is asking for.
  //
  // The trunk is deliberately not the second. `remove` and `rename` both gate
  // it, so its absence here reads like an oversight and is not: `--to` is the
  // gesture, and `pr.ts` hands somebody `grove reset <branch> --to …` as the
  // way out of a pull request that moved under them. Gating it would mean a
  // `--force` this command does not have, to guard a ref the user spelled out
  // by hand — so `grove reset main --to origin/main~5` rewinds the trunk, and
  // is meant to.
  refuseMidRebase(target, dir);

  // Read before, because after the reset there is nothing left to report and
  // "discarded 3 files" is the part worth saying.
  const before = await statusOf(target.path);
  const to = options.to ?? "HEAD";

  await withStep(
    reporter,
    { start: `resetting ${dir}`, done: `reset ${dir}`, failed: `could not reset ${dir}` },
    async () => {
      await runGitOrThrow(["reset", "--hard", to], { cwd: target.path });
      // `-d` for directories as well: a build output tree is the usual reason a
      // reset leaves a worktree still dirty, and it is never one file.
      if (options.clean) await runGitOrThrow(["clean", "-fd"], { cwd: target.path });
    },
  );

  // Only worth saying when they survived: `--clean` is opt-in on the command
  // line, and a worktree that is still dirty after a reset is a surprise.
  if (!options.clean && before.untracked.length > 0) {
    reporter.warn(
      `${dir} still has ${before.untracked.length} untracked file(s); --clean would delete them too`,
    );
  }

  const head = await runGit(["rev-parse", "--short", "HEAD"], { cwd: target.path });

  return {
    path: target.path,
    dir,
    branch: target.branch,
    discarded: before.changed.slice(0, LISTED),
    changed: before.changed.length,
    untracked: before.untracked.length,
    cleaned: options.clean,
    head: head.stdout.trim(),
  };
}
