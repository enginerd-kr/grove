import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Reporter } from "../report/reporter.ts";
import { GroveError } from "./errors.ts";
import { entryExists } from "./fs.ts";
import { runGit, runGitOrThrow } from "./git.ts";
import { statusOf } from "./worktrees.ts";

/**
 * Moving uncommitted work from one worktree into another.
 *
 * The move this exists for is the one everybody makes by hand: you are in
 * `main`, you have been editing for twenty minutes, and only now does it occur
 * to you that this should have been a branch. In an ordinary clone that is
 * `git stash`, `git checkout -b`, `git stash pop`. In a repository full of
 * worktrees it is worse than that, because **`refs/stash` is not per-worktree**
 * — every worktree in the repository pushes onto and pops off the same stack,
 * so a `pop` in one directory can take an entry somebody left in another.
 *
 * So nothing here touches that stack. `git stash create` writes the same commit
 * object `git stash push` would have stored, and stores it nowhere: the
 * snapshot exists in the object database, addressed by its sha, referenced by
 * nothing. It is applied into the new worktree by that sha, and only once that
 * has worked is the source cleaned. Every failure in between leaves the source
 * holding everything it held, and names the sha — one `git stash apply <sha>`
 * recovers it whatever went wrong.
 *
 * Untracked files travel separately, because `stash create` does not take them.
 * They are moved rather than copied, which is what leaves the source clean, and
 * ignored files stay exactly where they are: `.env` and `node_modules` belong
 * to the directory, not to the change being carried out of it.
 */

export type TakeResult = {
  /** The snapshot commit, kept so a failed apply can be recovered by hand. */
  readonly stash?: string;
  /** How many tracked paths the snapshot carried. */
  readonly tracked: number;
  /** The untracked files moved across, by path within the worktree. */
  readonly untracked: readonly string[];
  /** True when the source had nothing uncommitted and nothing was done. */
  readonly empty: boolean;
};

export const EMPTY_TAKE: TakeResult = { tracked: 0, untracked: [], empty: true };

/** In words, for the line `add` prints when it has carried something across. */
export function describeTake(result: TakeResult): string {
  if (result.empty) return "nothing to take";

  const parts = [`${result.tracked} change${result.tracked === 1 ? "" : "s"}`];
  if (result.untracked.length > 0) {
    parts.push(
      `${result.untracked.length} untracked file${result.untracked.length === 1 ? "" : "s"}`,
    );
  }

  return `took ${parts.join(" and ")}`;
}

/**
 * The snapshot, or nothing when there is nothing to snapshot.
 *
 * `git stash create` prints an empty line for a clean worktree, which is the
 * one case that is not a failure — it is the answer.
 */
async function snapshot(worktree: string): Promise<string | undefined> {
  const result = await runGit(["stash", "create", "grove: taken to another worktree"], {
    cwd: worktree,
  });

  if (result.code !== 0) {
    throw new GroveError("git-failed", "could not snapshot the uncommitted changes", {
      hint: "commit them yourself, then add the worktree without --take",
      details: [result.stderr.trim()].filter((line) => line.length > 0),
    });
  }

  const sha = result.stdout.trim();

  return sha.length === 0 ? undefined : sha;
}

/**
 * One untracked file, moved across.
 *
 * `rename` first because it is atomic and costs nothing, with a copy-then-delete
 * behind it because the two worktrees are only usually on one filesystem — a
 * plain repository puts them side by side wherever the user's directory is,
 * which may well be a mount away from the repository itself.
 */
async function moveEntry(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });

  try {
    await rename(from, to);

    return;
  } catch {
    // EXDEV, or a destination filesystem that minds an existing name.
  }

  await cp(from, to, { recursive: true, verbatimSymlinks: true, force: true });
  await rm(from, { recursive: true, force: true });
}

/**
 * Puts the destination back the way this found it, after an apply that did not
 * land cleanly.
 *
 * `git stash apply` leaves conflict markers in the tree it failed in, and a
 * brand new worktree full of those is a worse place to be left than one that
 * never had the changes offered to it. Safe to be this blunt for exactly one
 * reason: `takeChanges` refuses a destination that was not clean to begin with,
 * so there is nothing here that this did not just put here.
 */
async function unapply(destination: string): Promise<void> {
  await runGit(["reset", "--hard", "HEAD"], { cwd: destination });
  // `reset --hard` does not take a file the snapshot added — it unstages it and
  // leaves it on disk as untracked, which would be a file nobody put there.
  // Safe to be this thorough for one reason, and only that one: the destination
  // was verified clean above, so everything this deletes is something the apply
  // just wrote. `-x` is deliberately absent, so an ignored file is never ours.
  await runGit(["clean", "-fd"], { cwd: destination });
}

/**
 * Carries the source worktree's uncommitted changes into `destination`.
 *
 * The two are rarely on the same commit — `add` bases a new branch on the
 * remote's trunk, and the worktree being emptied is wherever it happens to
 * be — so the apply is a three-way merge and can genuinely conflict. That case
 * is the reason for the order here: snapshot, apply, and only then reset the
 * source. A conflict leaves both worktrees exactly as they were, and says which
 * sha to reach for.
 */
export async function takeChanges(
  source: string,
  destination: string,
  reporter: Reporter,
): Promise<TakeResult> {
  // Checked before anything is snapshotted, because it decides whether the
  // cleanup above is allowed to exist: a destination with work of its own is
  // one this must not reset, so it is one this must not write into either.
  if ((await statusOf(destination)).dirty) {
    throw new GroveError("refused", "the worktree being moved into has uncommitted changes", {
      hint: "commit or discard those first — merging two sets of loose changes is not something this should guess at",
    });
  }

  const status = await statusOf(source);
  if (!status.dirty) return EMPTY_TAKE;

  const untracked = new Set(status.untracked);
  const tracked = status.changed.filter((path) => !untracked.has(path));
  const step = reporter.step(`taking ${status.changed.length} uncommitted`);

  let stash: string | undefined;
  try {
    stash = await snapshot(source);

    if (stash !== undefined) {
      // `--index` first, so a change that was staged arrives staged. git
      // declines that when the index cannot be reinstated on top of a different
      // commit, and a plain apply is the right answer there: everything still
      // arrives, unstaged, which is what `git stash pop` mostly does anyway.
      const staged = await runGit(["stash", "apply", "--index", stash], { cwd: destination });

      if (staged.code !== 0) {
        await unapply(destination);
        const plain = await runGit(["stash", "apply", stash], { cwd: destination });

        if (plain.code !== 0) {
          await unapply(destination);
          throw new GroveError("rebase-conflict", "the changes did not apply cleanly there", {
            hint: `nothing moved — they are still where they were, and also saved as ${stash}`,
            details: [plain.stderr.trim()].filter((line) => line.length > 0),
          });
        }
      }
    }

    // One at a time rather than as a batch, because a half-moved set has to be
    // reportable: what is across is in the new worktree, and what is not is
    // still here.
    const moved: string[] = [];
    for (const path of status.untracked) {
      const from = join(source, path);
      if (!(await entryExists(from))) continue;

      await moveEntry(from, join(destination, path));
      moved.push(path);
    }

    // Last, and only now: everything this was carrying is somewhere else. The
    // snapshot is still in the object database either way, which is what makes
    // a hard reset here something other than a leap.
    if (stash !== undefined) await runGitOrThrow(["reset", "--hard", "HEAD"], { cwd: source });

    const result = { stash, tracked: tracked.length, untracked: moved, empty: false };
    step.succeed(describeTake(result));

    return result;
  } catch (error) {
    step.fail("could not take the uncommitted changes");

    // A `GroveError` from above already says where the work is. Anything else
    // is a surprise, and the sha is the whole of what somebody needs from it.
    if (stash !== undefined && !(error instanceof GroveError)) {
      throw new GroveError("git-failed", "could not take the uncommitted changes", {
        hint: `they are saved as a commit: git stash apply ${stash}`,
        details: [error instanceof Error ? error.message : String(error)],
        cause: error,
      });
    }

    throw error;
  }
}
