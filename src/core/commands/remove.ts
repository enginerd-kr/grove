import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { clearApplied, failureFor, runTeardown, type TeardownResult } from "../../hooks/index.ts";
import { type Reporter, withStep } from "../../report/reporter.ts";
import { refuseTrunk } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { isEmptyOrMissing } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { contains, type RepoPaths, worktreeBase } from "../layout.ts";
import { forgetBranch } from "../stack.ts";
import {
  LISTED,
  listWorktrees,
  refuseMidRebase,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";
import { prNumberOf, remoteFor } from "./pr.ts";
import { discardedRef } from "./reset.ts";

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
  /**
   * Relative to the root, `/`-separated — the name the list uses.
   *
   * Already what every message this command prints says; reported beside the
   * absolute path so a `--json` reader can line this row up with `grove list`
   * without re-deriving it, the way `path`, `reset` and `rename` do.
   */
  readonly dir: string;
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

  await withStep(
    reporter,
    { start: `removing ${dir}`, done: `removed ${dir}`, failed: `could not remove ${dir}` },
    async () => {
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
    },
  );

  // The record of what this directory was filled in from goes with the
  // directory. The branch stays, and a worktree `grove add` makes for it later
  // is filled in afresh and records itself — until then there is nothing to
  // be stale.
  if (target.branch !== undefined) await clearApplied(repo.gitDir, target.branch);

  if (options.deleteBranch && target.branch !== undefined) {
    const outcome = await deleteBranch(
      repo.gitDir,
      target.branch,
      { force: options.force, announce: true },
      reporter,
    );
    if (!outcome.deleted) {
      // `-d` refusing is the safety net; here the worktree is already gone, so
      // the refusal has to say what half-happened and hand over the decision.
      throw new GroveError(
        "refused",
        `the worktree is gone, but ${target.branch} has unmerged commits`,
        {
          hint: "pass --force to delete the branch too, or push it first",
          details: [`the branch itself is still there: ${outcome.kept}`],
        },
      );
    }

    return { path: target.path, dir, branch: target.branch, branchDeleted: true, teardown };
  }

  return {
    path: target.path,
    dir,
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
  refuseMidRebase(target, dir);

  if (!options.force) {
    if (worktrees.length === 1) {
      throw new GroveError("refused", `${dir} is the only worktree`, {
        hint: "pass --force if you really want an empty repository",
      });
    }

    await refuseTrunk(repo.gitDir, target.branch, "pass --force if you are sure");

    if (options.discardDirty !== true) {
      const status = await statusOf(target.path);
      if (status.dirty) {
        throw new GroveError("refused", `${dir} has uncommitted changes`, {
          hint: "commit or stash them, or pass --force to discard them",
          details: status.changed.slice(0, LISTED),
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

/**
 * Deletes a branch, with everything that hangs off the deletion — the one
 * spelling of it, shared with `prune`.
 *
 * The stack repair runs *before* the deletion and not after: `git branch -d`
 * takes the whole `branch.<name>` config section with it, and the stack record
 * is in there. Anything standing on this branch is handed to whatever it was
 * standing on.
 *
 * `-d` refuses a branch whose commits are not merged anywhere; that refusal is
 * the safety net, so it is only downgraded to `-D` when `force` says so. What
 * it refuses comes back as `kept` — the one command that would do it anyway —
 * so the decision stays with the caller who knows whether to raise it or to
 * put it in a table.
 *
 * `announce` is that same split said once: removing one worktree, a deleted
 * branch is news and belongs on the line under it; reaping twenty, it is a
 * column in the table `prune` prints and a line each would be noise.
 */
export async function deleteBranch(
  bare: string,
  branch: string,
  options: { readonly force: boolean; readonly announce: boolean },
  reporter: Reporter,
): Promise<{ readonly deleted: boolean; readonly kept?: string }> {
  for (const { child, parent } of await forgetBranch(bare, branch)) {
    reporter.info(`${child} now sits on ${parent ?? "the default branch"}`);
  }

  const result = await runGit(["branch", options.force ? "-D" : "-d", branch], { cwd: bare });
  if (result.code !== 0) return { deleted: false, kept: `git -C ${bare} branch -D ${branch}` };

  if (options.announce) reporter.info(`deleted branch ${branch}`);
  await dropPrRemote(bare, branch, reporter);
  // The snapshot `reset` held for this branch goes with it: it was kept for
  // a regret about a branch that is now gone on purpose. Absent is the
  // ordinary case, and the object stays reachable by its sha either way.
  await runGit(["update-ref", "-d", discardedRef(branch)], { cwd: bare });

  return { deleted: true };
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
 * A merged pull request whose fork branch is gone is exactly what
 * `prune --delete-branch` reaps, so `deleteBranch` above is what keeps the two
 * commands from leaking these differently.
 */
async function dropPrRemote(bare: string, branch: string, reporter: Reporter): Promise<void> {
  const number = prNumberOf(branch);
  if (number === undefined) return;

  const remote = remoteFor(number);
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
