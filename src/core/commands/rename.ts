import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, localBranchExists } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { contains, type RepoPaths, worktreePathFor } from "../layout.ts";
import { listWorktrees, resolveTarget, worktreeDir } from "../worktrees.ts";
import { pruneEmptyParents } from "./remove.ts";

/**
 * `grove rename` — give a branch another name, and its directory the same one.
 *
 * This command exists because of a promise the rest of the tool makes: the
 * directory *is* the branch's name, which is what lets a row of the list say
 * one thing instead of two. `git branch -m` breaks that promise the moment it
 * is used — `feat/logn/` holding `feat/login` is exactly the bookkeeping this
 * tool was written to remove, and it is bookkeeping the tool's own layout
 * created. So the two move together, and the directories the old name left
 * behind are cleared up after it.
 *
 * What it deliberately does *not* touch is the remote. `git branch -m` moves
 * the branch's configuration as it stands, upstream included, so a renamed
 * branch goes on tracking the remote branch it was tracking — which is correct,
 * because that branch really is still called the old thing. Saying so, and
 * offering `--push`, is better than quietly repointing a branch at a ref that
 * does not exist yet.
 */

const REMOTE = "origin";

export type RenameOptions = {
  readonly target: string;
  /** The new branch name. Its directory is derived from it, as `add`'s would be. */
  readonly to: string;
  /** Push the new name and make it the upstream. */
  readonly push: boolean;
  /** Rename the branch everything else syncs onto. */
  readonly force: boolean;
};

export type RenameResult = {
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly dir: string;
  /** False when the worktree was already at the name the new branch wants. */
  readonly moved: boolean;
  /** True when `--push` created the new branch on the remote. */
  readonly pushed: boolean;
  /**
   * The remote branch this still tracks, when that is no longer its own name.
   *
   * The one thing a rename leaves inconsistent, and it is inconsistent on
   * purpose — see the note above. Reported so it is a decision rather than a
   * discovery.
   */
  readonly upstreamNote?: string;
  /** Set when the shell is standing in the directory that just moved. */
  readonly standingNote?: string;
};

export async function renameWorktree(
  repo: RepoPaths,
  cwd: string,
  options: RenameOptions,
  reporter: Reporter,
): Promise<RenameResult> {
  const worktrees = await listWorktrees(repo.gitDir);
  const target = resolveTarget(options.target, worktrees, { root: repo.root, cwd });
  const from = target.branch;

  if (from === undefined) {
    throw new GroveError(
      "refused",
      `${worktreeDir(repo.root, target.path)} has no branch to rename`,
      {
        hint: "a detached HEAD is a commit, not a name; check out a branch there first",
      },
    );
  }

  // Throws a usage error for a name no directory could be derived from, which
  // is the check worth making before anything at all has moved.
  const path = worktreePathFor(repo, options.to);
  const dir = worktreeDir(repo.root, path);

  await refuseUnsafe(repo, target.path, from, path, options, worktrees);

  const step = reporter.step(`renaming ${from} to ${options.to}`);
  try {
    await runGitOrThrow(["branch", "-m", from, options.to], { cwd: repo.gitDir });
    step.succeed(`renamed ${from} to ${options.to}`);
  } catch (error) {
    step.fail(`could not rename ${from}`);
    throw error;
  }

  const moved = target.path !== path;
  if (moved) await moveWorktree(repo, target.path, path, from, options.to, reporter);

  const pushed = options.push ? await pushBranch(path, options.to, reporter) : false;

  return {
    from,
    to: options.to,
    path,
    dir,
    moved,
    pushed,
    upstreamNote: pushed ? undefined : await upstreamNote(repo.gitDir, options.to),
    // A directory that moves takes the shell inside it along by inode, so
    // nothing breaks and `pwd` quietly starts lying. Saying where it went is
    // cheaper than letting somebody work that out from a path that no longer
    // exists.
    standingNote: contains(target.path, cwd)
      ? `you are still standing in the old path: cd "$(grove path ${options.to})"`
      : undefined,
  };
}

/**
 * Moves the directory, and puts the branch back if it cannot.
 *
 * The rename is two writes and this is the second, so a failure here would
 * otherwise leave exactly the state the whole command exists to prevent: a
 * branch under the new name in a directory under the old one. Undoing the first
 * write is what keeps the pair atomic from where anybody is standing.
 */
async function moveWorktree(
  repo: RepoPaths,
  fromPath: string,
  toPath: string,
  fromBranch: string,
  toBranch: string,
  reporter: Reporter,
): Promise<void> {
  const step = reporter.step(`moving ${worktreeDir(repo.root, fromPath)}`);

  try {
    // `git worktree move` will not create the directory above its destination,
    // and a nested branch name needs one — `feat/login` under a repository that
    // has never had a `feat/` before.
    await mkdir(dirname(toPath), { recursive: true });
    await runGitOrThrow(["worktree", "move", fromPath, toPath], { cwd: repo.gitDir });
  } catch (error) {
    await runGit(["branch", "-m", toBranch, fromBranch], { cwd: repo.gitDir });
    step.fail(`could not move the worktree; ${fromBranch} keeps its name`);
    throw error;
  }

  // The old name may have been the last thing under `feat/`, and an empty
  // `feat/` left behind is the clutter the nesting was there to organise away.
  await pruneEmptyParents(repo.kind === "plain" ? dirname(repo.root) : repo.root, fromPath);
  step.succeed(`moved to ${worktreeDir(repo.root, toPath)}`);
}

async function refuseUnsafe(
  repo: RepoPaths,
  fromPath: string,
  from: string,
  toPath: string,
  options: RenameOptions,
  worktrees: readonly { readonly path: string }[],
): Promise<void> {
  if (from === options.to) {
    throw new GroveError("usage", `${from} is already its name`, {
      hint: "pass the name you want it to have instead",
    });
  }

  // Not overridable: in a plain repository the root is the repository, and
  // `git worktree move` refuses to move a main worktree for the same reason.
  if (repo.kind === "plain" && fromPath === repo.root) {
    throw new GroveError("refused", "that is the repository itself, not a worktree beside it", {
      hint: `rename the branch alone if you mean to: git -C ${repo.root} branch -m ${options.to}`,
    });
  }

  if (!options.force && from === (await defaultBranch(repo.gitDir))) {
    throw new GroveError("refused", `${from} is the branch everything else syncs onto`, {
      hint: "renaming it locally does not rename it on the remote; pass --force if you are sure",
    });
  }

  if (await localBranchExists(repo.gitDir, options.to)) {
    throw new GroveError("state-conflict", `${options.to} already exists`, {
      hint: "pick a name nothing here is using",
    });
  }

  // Checked apart from the branch, because the two can disagree: a branch name
  // that slugs onto a directory somebody made by hand would collide on disk
  // while git saw nothing wrong at all.
  if (await pathExists(toPath)) {
    throw new GroveError("state-conflict", `${worktreeDir(repo.root, toPath)} already exists`, {
      hint: "move or delete that directory first",
    });
  }

  const clash = worktrees.find(
    (record) =>
      record.path !== fromPath && (contains(record.path, toPath) || contains(toPath, record.path)),
  );

  if (clash) {
    throw new GroveError(
      "state-conflict",
      `that would nest with the worktree at ${worktreeDir(repo.root, clash.path)}`,
      {
        hint: "one worktree inside another makes each report the other's files; pick another name",
      },
    );
  }
}

/** What the branch goes on tracking, when that is no longer what it is called. */
async function upstreamNote(bare: string, branch: string): Promise<string | undefined> {
  const result = await runGit(
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    {
      cwd: bare,
    },
  );
  if (result.code !== 0) return undefined;

  const upstream = result.stdout.trim();
  if (upstream.length === 0 || upstream === `${REMOTE}/${branch}`) return undefined;

  return `still tracking ${upstream}; \`grove rename … --push\` or \`git push -u ${REMOTE} ${branch}\` moves it`;
}

/**
 * Pushes the new name, and says what it did not do.
 *
 * The remote keeps the old branch. Deleting it is a decision about somebody
 * else's pull request and somebody else's checkout, and it is not one a rename
 * on this machine gets to make.
 */
async function pushBranch(path: string, branch: string, reporter: Reporter): Promise<boolean> {
  const step = reporter.step(`pushing ${branch}`);
  try {
    await runGitOrThrow(["push", "-u", REMOTE, "HEAD"], { cwd: path });
    step.succeed(`pushed ${branch}`);

    return true;
  } catch (error) {
    // The rename landed; only the push did not. Saying so beats an error that
    // reads as though nothing happened.
    step.fail(`renamed it, but pushing ${branch} failed`);
    throw error;
  }
}
