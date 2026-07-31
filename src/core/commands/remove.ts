import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch } from "../branches.ts";
import { GardenError } from "../errors.ts";
import { isEmptyOrMissing } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import {
  listWorktrees,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";

/**
 * `garden remove` — delete a worktree, after establishing that you meant it.
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
};

export type RemoveResult = {
  readonly path: string;
  readonly branch?: string;
  readonly branchDeleted: boolean;
  /** Set when the branch was kept and holds commits the remote has not seen. */
  readonly unpushedWarning?: string;
};

export async function removeWorktree(
  repo: RepoPaths,
  cwd: string,
  options: RemoveOptions,
  reporter: Reporter,
): Promise<RemoveResult> {
  const worktrees = await listWorktrees(repo.bare);
  const target = resolveTarget(options.target, worktrees, { root: repo.root, cwd });
  const dir = worktreeDir(repo.root, target.path);

  await refuseUnsafe(repo, cwd, target, dir, worktrees, options);

  const step = reporter.step(`removing ${dir}`);
  try {
    await runGitOrThrow(
      ["worktree", "remove", ...(options.force ? ["--force"] : []), target.path],
      { cwd: repo.bare },
    );
    // Clears the administrative files git leaves behind, so a later `add` of the
    // same directory name is not refused by a record of the one just deleted.
    await runGitOrThrow(["worktree", "prune"], { cwd: repo.bare });
    await pruneEmptyParents(repo.root, target.path);
    step.succeed(`removed ${dir}`);
  } catch (error) {
    step.fail(`could not remove ${dir}`);
    throw error;
  }

  if (options.deleteBranch && target.branch !== undefined) {
    await deleteBranch(repo.bare, target.branch, options.force, reporter);

    return { path: target.path, branch: target.branch, branchDeleted: true };
  }

  return {
    path: target.path,
    branch: target.branch,
    branchDeleted: false,
    unpushedWarning: await unpushedWarning(repo.bare, target.branch),
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
  // Not overridable by --force. Deleting the directory your shell is sitting in
  // leaves that shell in a path that no longer exists, and every later command
  // fails for a reason that has nothing to do with what went wrong.
  if (contains(target.path, cwd)) {
    throw new GardenError("refused", `you are inside ${target.path}`, {
      hint: "cd somewhere else first",
    });
  }

  if (target.locked !== undefined) {
    throw new GardenError("refused", `${dir} is locked`, {
      hint: `unlock it first: git -C ${repo.bare} worktree unlock ${target.path}`,
      details: target.locked.length > 0 ? [target.locked] : [],
    });
  }

  if (!options.force) {
    if (worktrees.length === 1) {
      throw new GardenError("refused", `${dir} is the only worktree`, {
        hint: "pass --force if you really want an empty repository",
      });
    }

    if (target.branch !== undefined && target.branch === (await defaultBranch(repo.bare))) {
      throw new GardenError(
        "refused",
        `${target.branch} is the branch everything else syncs onto`,
        {
          hint: "pass --force if you are sure",
        },
      );
    }

    const status = await statusOf(target.path);
    if (status.dirty) {
      throw new GardenError("refused", `${dir} has uncommitted changes`, {
        hint: "commit or stash them, or pass --force to discard them",
        details: status.changed.slice(0, 5),
      });
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
 */
async function pruneEmptyParents(root: string, removed: string): Promise<void> {
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
    throw new GardenError("refused", `the worktree is gone, but ${branch} has unmerged commits`, {
      hint: "pass --force to delete the branch too, or push it first",
      details: [`the branch itself is still there: git -C ${bare} branch -D ${branch}`],
    });
  }

  reporter.info(`deleted branch ${branch}`);
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

  return `branch ${branch} still holds ${count} unpushed commit(s); \`garden add ${branch}\` brings it back`;
}
