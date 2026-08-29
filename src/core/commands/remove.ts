import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { isEmptyOrMissing } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { contains, type RepoPaths, worktreeBase } from "../layout.ts";
import { failureFor, runTeardown, type TeardownResult } from "../setup.ts";
import {
  listWorktrees,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";

/**
 * `grove remove` — delete a worktree, after establishing that you meant it.
 *
 * The checks below are the command. `git worktree remove` already refuses a
 * dirty tree; what it will not tell you is that this is the branch everything
 * else rebases onto, or that you are standing inside the directory you just
 * asked to delete.
 */

export type RemoveOptions = {
  readonly target: string;
  readonly force: boolean;
  readonly deleteBranch: boolean;
  /**
   * Remove a dirty worktree anyway, discarding its uncommitted changes.
   *
   * Narrower than `force` on purpose. The app's confirmation says "and discard
   * N changes" before anyone answers `y`, so this carries exactly that answer —
   * while the refusals no question was asked about, the only worktree and the
   * branch everything syncs onto, keep standing.
   */
  readonly discardDirty?: boolean;
  /**
   * Run `.grove.toml`'s `[teardown]` commands first. On by default.
   *
   * On, because whatever `[setup]` started is still running and the directory
   * it was started in is about to stop existing. Off is for the repository
   * whose cleanup is itself broken — see `runTeardown`, which never lets a
   * failed command stop the removal either.
   */
  readonly teardown?: boolean;
};

export type RemoveResult = {
  readonly path: string;
  readonly branch?: string;
  readonly branchDeleted: boolean;
  /** Set when the branch was kept and holds commits the remote has not seen. */
  readonly unpushedWarning?: string;
  /** What `[teardown]` did, when the file asked for anything. */
  readonly teardown?: TeardownResult;
};

export async function removeWorktree(
  repo: RepoPaths,
  cwd: string,
  options: RemoveOptions,
  reporter: Reporter,
): Promise<RemoveResult> {
  const worktrees = await listWorktrees(repo.gitDir);
  const target = resolveTarget(options.target, worktrees, { root: repo.root, cwd });
  const dir = worktreeDir(repo.root, target.path);

  await refuseUnsafe(repo, cwd, target, dir, worktrees, options);

  // After the refusals and before the removal: there is no point stopping a
  // container for a worktree that then turns out to be locked, and no point
  // stopping one after the directory holding its compose file has gone.
  const teardown =
    options.teardown === false
      ? undefined
      : await runTeardown(repo, { path: target.path, branch: target.branch }, reporter);

  // `failureFor` builds the sentence; the tail is this command's own, because
  // a failed teardown is news here rather than a failure — see `runTeardown`,
  // which never lets one stop the removal.
  const failure = teardown && failureFor(teardown);
  if (failure) {
    reporter.warn(`${failure.message}; removing ${dir} anyway`);
    for (const detail of failure.details) reporter.info(`  ${detail}`);
  }

  const step = reporter.step(`removing ${dir}`);
  try {
    // `--force` is what lets git delete a dirty tree, so `discardDirty` needs
    // it too — the refusals grove itself makes were already decided above.
    const forced = options.force || options.discardDirty === true;
    await runGitOrThrow(["worktree", "remove", ...(forced ? ["--force"] : []), target.path], {
      cwd: repo.gitDir,
    });
    // Clears the administrative files git leaves behind, so a later `add` of the
    // same directory name is not refused by a record of the one just deleted.
    await runGitOrThrow(["worktree", "prune"], { cwd: repo.gitDir });
    // The base a nested directory climbs back towards without passing it —
    // `worktreeBase`, so this is the same answer `add` placed the worktree by.
    await pruneEmptyParents(worktreeBase(repo), target.path);
    step.succeed(`removed ${dir}`);
  } catch (error) {
    step.fail(`could not remove ${dir}`);
    throw error;
  }

  if (options.deleteBranch && target.branch !== undefined) {
    await deleteBranch(repo.gitDir, target.branch, options.force, reporter);

    return { path: target.path, branch: target.branch, branchDeleted: true, teardown };
  }

  return {
    path: target.path,
    branch: target.branch,
    branchDeleted: false,
    unpushedWarning: await unpushedWarning(repo.gitDir, target.branch),
    teardown,
  };
}

async function refuseUnsafe(
  repo: RepoPaths,
  cwd: string,
  target: WorktreeRecord,
  dir: string,
  worktrees: readonly WorktreeRecord[],
  options: RemoveOptions,
): Promise<void> {
  // Not overridable by --force, and not merely the "only worktree" refusal
  // below: in a plain repository the root is the repository, not a worktree
  // grove made, and there is no folder left to hold another one afterwards.
  if (repo.kind === "plain" && target.path === repo.root) {
    throw new GroveError(
      "refused",
      `${dir} is the repository itself, not a grove-managed worktree`,
      {
        hint: "grove only removes worktrees it can recreate; delete the repository by hand if you mean it",
      },
    );
  }

  // Not overridable by --force. Deleting the directory your shell is sitting in
  // leaves that shell in a path that no longer exists, and every later command
  // fails for a reason that has nothing to do with what went wrong.
  if (contains(target.path, cwd)) {
    throw new GroveError("refused", `you are inside ${target.path}`, {
      hint: "cd somewhere else first",
    });
  }

  if (target.locked !== undefined) {
    throw new GroveError("refused", `${dir} is locked`, {
      hint: `unlock it first: git -C ${repo.gitDir} worktree unlock ${target.path}`,
      details: target.locked.length > 0 ? [target.locked] : [],
    });
  }

  // Not overridable by --force, for the same reason `reset` will not be talked
  // past it: a stopped rebase holds half-applied commits and whatever conflicts
  // have been resolved so far, and all of that lives in the worktree's own git
  // dir — which goes with the directory. It is not caught by the uncommitted
  // changes refusal below either, because a rebase paused at an `edit` step has
  // a perfectly clean tree, and `git worktree remove` would take it with exit
  // 0. What --force answers is "discard my changes"; nobody has been asked
  // about abandoning a rebase, so nobody is taken to have said yes.
  if (target.rebasing === true) {
    throw new GroveError("refused", `${dir} is in the middle of a rebase`, {
      hint: `finish or abandon it first: git -C ${target.path} rebase --abort`,
    });
  }

  if (!options.force) {
    if (worktrees.length === 1) {
      throw new GroveError("refused", `${dir} is the only worktree`, {
        hint: "pass --force if you really want an empty repository",
      });
    }

    if (target.branch !== undefined && target.branch === (await defaultBranch(repo.gitDir))) {
      throw new GroveError("refused", `${target.branch} is the branch everything else syncs onto`, {
        hint: "pass --force if you are sure",
      });
    }

    if (options.discardDirty !== true) {
      const status = await statusOf(target.path);
      if (status.dirty) {
        throw new GroveError("refused", `${dir} has uncommitted changes`, {
          hint: "commit or stash them, or pass --force to discard them",
          details: status.changed.slice(0, 5),
        });
      }
    }
  }
}

/**
 * Removes the directories a nested worktree leaves behind.
 *
 * `feat/test` lives inside `feat/`, and git removes only the worktree itself —
 * so deleting the last branch under a prefix would leave an empty `feat/`
 * forever, and those accumulate into exactly the clutter the nesting was
 * supposed to organise away.
 *
 * Walks up to, but never including, the repo root, and stops the moment a
 * directory is not empty: anything in there is someone's, not ours.
 *
 * Exported for `rename`, which leaves the same emptiness behind for the same
 * reason — a worktree that moves out of `feat/` is a worktree that left it.
 */
export async function pruneEmptyParents(root: string, removed: string): Promise<void> {
  let current = dirname(removed);

  while (current !== root && contains(root, current)) {
    if (!(await isEmptyOrMissing(current))) return;

    try {
      await rmdir(current);
    } catch {
      // Raced with something, or never existed. Either way, stop here.
      return;
    }

    current = dirname(current);
  }
}

async function deleteBranch(
  bare: string,
  branch: string,
  force: boolean,
  reporter: Reporter,
): Promise<void> {
  // `-d` refuses a branch whose commits are not merged anywhere; that refusal is
  // the safety net, so it is only downgraded to `-D` when --force was asked for.
  const result = await runGit(["branch", force ? "-D" : "-d", branch], { cwd: bare });

  if (result.code !== 0) {
    throw new GroveError("refused", `the worktree is gone, but ${branch} has unmerged commits`, {
      hint: "pass --force to delete the branch too, or push it first",
      details: [`the branch itself is still there: git -C ${bare} branch -D ${branch}`],
    });
  }

  reporter.info(`deleted branch ${branch}`);

  await dropPrRemote(bare, branch, reporter);
}

/**
 * Takes a pull request's remote with its branch.
 *
 * `pr-42` exists to serve `pr/42` and nothing else — it carries a push refspec
 * naming that branch — so once the branch is gone it is a remote the refresh
 * tick fetches forever on behalf of a review that finished. Only ever removed
 * alongside the branch, never alongside the worktree: a worktree can be removed
 * and the branch kept, and the branch is what the remote is for.
 *
 * Exported for `prune`, which deletes branches itself rather than through the
 * removal above — and a merged pull request whose fork branch is gone is
 * exactly what `prune --delete-branch` reaps, so it is the command that would
 * leak the most of these.
 */
export async function dropPrRemote(
  bare: string,
  branch: string,
  reporter: Reporter,
): Promise<void> {
  const match = /^pr\/(\d+)$/.exec(branch);
  if (match === null) return;

  const remote = `pr-${match[1]}`;
  const result = await runGit(["remote", "remove", remote], { cwd: bare });
  // Absent is the ordinary case for a `pr/<n>` branch nobody made with
  // `grove pr`, and it is not something to report either way.
  if (result.code === 0) reporter.info(`dropped remote ${remote}`);
}

/**
 * Warns when a kept branch holds work the remote has never seen.
 *
 * Removing a worktree leaves its branch alone on purpose — that is where
 * unpushed commits live. But the directory disappearing is exactly when someone
 * assumes the work went with it, so say where it went instead.
 */
async function unpushedWarning(bare: string, branch?: string): Promise<string | undefined> {
  if (branch === undefined) return undefined;

  const result = await runGit(["rev-list", "--count", `${branch}@{upstream}..${branch}`], {
    cwd: bare,
  });
  if (result.code !== 0) return undefined;

  const count = Number(result.stdout.trim());
  if (!Number.isFinite(count) || count === 0) return undefined;

  return `branch ${branch} still holds ${count} unpushed commit(s); \`grove add ${branch}\` brings it back`;
}
