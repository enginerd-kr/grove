import { type Reporter, withStep } from "../../report/reporter.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { recoverLine, snapshotChanges } from "../snapshot.ts";
import { plural } from "../text.ts";
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
 *
 * And it keeps a copy. `git reset --hard` is the one thing in git with no
 * reflog behind it: the commits a `--to` drops are still in `HEAD@{1}`, but an
 * edit that was never committed is nowhere once the tree is rewritten, and
 * `clean -fd` takes files git has never seen a copy of. So before either runs,
 * what they are about to destroy is written as a snapshot commit — the same
 * shape `git stash push -u` stores, see `core/snapshot.ts` — and its sha is
 * named on the way out. `git stash apply <sha>` is the undo, and it needs
 * nothing of grove's to work. The latest one per branch is also held under
 * `refs/grove/discarded/<branch>`, so a regret next week finds a commit git's
 * own housekeeping has not yet pruned.
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
  /**
   * The snapshot commit holding what was discarded, in full.
   *
   * `git stash apply <sha>` brings it back — tracked changes, and the
   * untracked files when `--clean` took them. Absent when nothing was taken
   * that a snapshot could hold: a clean tree, or untracked files left where
   * they were.
   */
  readonly saved?: string;
};

/** Where the latest snapshot of a branch's discarded changes is kept. */
export function discardedRef(branch: string): string {
  return `refs/grove/discarded/${branch}`;
}

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

  if (tracked > 0) parts.push(plural(tracked, "change"));
  if (untracked > 0) parts.push(plural(untracked, "untracked file"));
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

  // Before anything is touched, and refusing rather than carrying on without
  // it: a reset that could not keep a copy is exactly the reset somebody will
  // want the copy from. Only what is about to go is in it — the untracked
  // files ride along when `--clean` is taking them, and stay out of it when
  // they are staying on disk.
  const saved = before.dirty
    ? await snapshotChanges(target.path, `grove: discarded in ${dir}`, {
        untracked: options.clean ? before.untracked : [],
        hint: "commit or stash them yourself, then reset again",
      })
    : undefined;

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

  // Held by a ref only once the discard has happened, so a reset that failed
  // leaves no record claiming something was thrown away. Best effort: the sha
  // is named either way, and the ref is a courtesy to next week rather than the
  // thing the recovery depends on.
  if (saved !== undefined) {
    if (target.branch !== undefined) {
      await runGit(["update-ref", discardedRef(target.branch), saved], { cwd: target.path });
    }
    reporter.info(`the discarded changes are saved as a commit: ${recoverLine(saved)}`);
  }

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
    saved,
  };
}
