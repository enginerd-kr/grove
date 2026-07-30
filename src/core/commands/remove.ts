import { basename } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch } from "../branches.ts";
import { WtError } from "../errors.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { listWorktrees, resolveTarget, statusOf, type WorktreeRecord } from "../worktrees.ts";
import { contains } from "./list.ts";

/**
 * `wt remove` — delete a worktree, after establishing that you meant it.
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
  const target = resolveTarget(options.target, worktrees, cwd);

  await refuseUnsafe(repo, cwd, target, worktrees, options);

  const step = reporter.step(`removing ${basename(target.path)}`);
  try {
    await runGitOrThrow(
      ["worktree", "remove", ...(options.force ? ["--force"] : []), target.path],
      { cwd: repo.bare },
    );
    // Clears the administrative files git leaves behind, so a later `add` of the
    // same directory name is not refused by a record of the one just deleted.
    await runGitOrThrow(["worktree", "prune"], { cwd: repo.bare });
    step.succeed(`removed ${basename(target.path)}`);
  } catch (error) {
    step.fail(`could not remove ${basename(target.path)}`);
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
  worktrees: readonly WorktreeRecord[],
  options: RemoveOptions,
): Promise<void> {
  // Not overridable by --force. Deleting the directory your shell is sitting in
  // leaves that shell in a path that no longer exists, and every later command
  // fails for a reason that has nothing to do with what went wrong.
  if (contains(target.path, cwd)) {
    throw new WtError("refused", `you are inside ${target.path}`, {
      hint: "cd somewhere else first",
    });
  }

  if (target.locked !== undefined) {
    throw new WtError("refused", `${basename(target.path)} is locked`, {
      hint: `unlock it first: git -C ${repo.bare} worktree unlock ${target.path}`,
      details: target.locked.length > 0 ? [target.locked] : [],
    });
  }

  if (!options.force) {
    if (worktrees.length === 1) {
      throw new WtError("refused", `${basename(target.path)} is the only worktree`, {
        hint: "pass --force if you really want an empty repository",
      });
    }

    if (target.branch !== undefined && target.branch === (await defaultBranch(repo.bare))) {
      throw new WtError("refused", `${target.branch} is the branch everything else syncs onto`, {
        hint: "pass --force if you are sure",
      });
    }

    const status = await statusOf(target.path);
    if (status.dirty) {
      throw new WtError("refused", `${basename(target.path)} has uncommitted changes`, {
        hint: "commit or stash them, or pass --force to discard them",
        details: status.changed.slice(0, 5),
      });
    }
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
    throw new WtError("refused", `the worktree is gone, but ${branch} has unmerged commits`, {
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

  return `branch ${branch} still holds ${count} unpushed commit(s); \`wt add ${branch}\` brings it back`;
}
