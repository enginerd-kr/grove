import { rm } from "node:fs/promises";
import { GroveError, stderrDetails } from "./errors.ts";
import { gitOutput, runGit, runGitOrThrow } from "./git.ts";

/**
 * A worktree's uncommitted changes, kept as a commit that touches no ref.
 *
 * Three commands move or destroy uncommitted work — `add --take`, `rebase`
 * and `reset` — and each of them wants the same thing first: a copy that
 * survives whatever happens next, and that `git stash apply <sha>` brings back
 * with no help from grove. `git stash create` is that copy for the tracked
 * changes. It writes the exact commit `git stash push` would have stored, and
 * stores it nowhere — which is the point, because **`refs/stash` is shared by
 * every worktree in the repository**, and a stack that `feat/login` pushes onto
 * is one `fix/crash` can pop off. See `take.ts`.
 *
 * What `stash create` cannot do is take the untracked files. `stash push -u`
 * can, and does it by adding a third parent to the stash commit: a commit whose
 * tree holds only the untracked paths, which `stash apply` then checks out
 * beside the tracked changes. That third parent is what this builds by hand,
 * with a throwaway index, so the commit this hands back is the same shape as
 * `stash push -u`'s and answers to the same `stash apply` — without a ref
 * being written anywhere on the way.
 */

export type SnapshotOptions = {
  /**
   * The untracked paths to carry, from `statusOf`. Empty means the tracked
   * changes alone — what `rebase` wants, since a rebase leaves untracked files
   * where they are.
   */
  readonly untracked?: readonly string[];
  /** What to do instead, for the refusal a snapshot that cannot be taken raises. */
  readonly hint: string;
};

/**
 * The snapshot, or nothing when there is nothing to snapshot.
 *
 * Nothing is a clean tree, or one whose only changes are untracked files the
 * caller did not ask to carry. It is an answer and not a failure: the command
 * behind this runs with no sha to name, because there is nothing a sha would
 * bring back.
 */
export async function snapshotChanges(
  path: string,
  message: string,
  options: SnapshotOptions,
): Promise<string | undefined> {
  const created = await runGit(["stash", "create", message], { cwd: path });
  if (created.code !== 0) {
    throw new GroveError("git-failed", "could not snapshot the uncommitted changes", {
      hint: options.hint,
      details: stderrDetails(created.stderr),
    });
  }

  const tracked = created.stdout.trim();
  const untracked = options.untracked ?? [];
  if (untracked.length === 0) return tracked.length === 0 ? undefined : tracked;

  try {
    return await withUntracked(
      path,
      message,
      tracked.length === 0 ? undefined : tracked,
      untracked,
    );
  } catch (error) {
    if (error instanceof GroveError) throw error;
    throw new GroveError("git-failed", "could not snapshot the untracked files", {
      hint: options.hint,
      details: [error instanceof Error ? error.message : String(error)],
      cause: error,
    });
  }
}

/**
 * The stash-shaped commit with the untracked files as its third parent.
 *
 * `git stash push -u` builds exactly this, and its parts are all plumbing:
 * the untracked paths are added to an index that is not the worktree's, the
 * tree that index writes becomes a commit with no parent, and the stash commit
 * is rewritten — same tree, same first two parents — with that commit as a
 * third. `git stash apply` reads `^3:` to decide whether there are untracked
 * files to put back, and nothing else about the commit is looked at.
 *
 * With no tracked changes there is no stash commit to rewrite, so the two
 * parents `stash create` would have written are made here: HEAD, and an index
 * commit holding HEAD's own tree. `stash apply` insists on both.
 */
async function withUntracked(
  path: string,
  message: string,
  stash: string | undefined,
  untracked: readonly string[],
): Promise<string> {
  // In the worktree's own git dir rather than under `/tmp`: `GIT_INDEX_FILE`
  // has to be somewhere git can write, and this is the directory git already
  // writes this worktree's index into.
  const index = await gitOutput(
    ["rev-parse", "--path-format=absolute", "--git-path", "grove-snapshot.index"],
    { cwd: path },
  );
  const paths = await gitOutput(
    ["rev-parse", "--path-format=absolute", "--git-path", "grove-snapshot.paths"],
    { cwd: path },
  );

  try {
    // NUL-separated through a file rather than as arguments: a worktree can
    // hold more untracked paths than a command line does.
    await Bun.write(paths, `${untracked.join("\0")}\0`);
    await rm(index, { force: true });

    const env = { GIT_INDEX_FILE: index };
    await runGitOrThrow(
      ["add", "--force", "--pathspec-file-nul", `--pathspec-from-file=${paths}`],
      { cwd: path, env },
    );
    const untrackedTree = await gitOutput(["write-tree"], { cwd: path, env });
    const untrackedCommit = await gitOutput(
      ["commit-tree", untrackedTree, "-m", `untracked files: ${message}`],
      { cwd: path },
    );

    const head = await gitOutput(["rev-parse", "HEAD"], { cwd: path });
    const tree = stash === undefined ? `${head}^{tree}` : `${stash}^{tree}`;
    const indexCommit =
      stash === undefined
        ? await gitOutput(
            ["commit-tree", `${head}^{tree}`, "-p", head, "-m", `index: ${message}`],
            {
              cwd: path,
            },
          )
        : `${stash}^2`;

    return await gitOutput(
      ["commit-tree", tree, "-p", head, "-p", indexCommit, "-p", untrackedCommit, "-m", message],
      { cwd: path },
    );
  } finally {
    await rm(index, { force: true });
    await rm(paths, { force: true });
  }
}

/** The one line that recovers a snapshot by hand, wherever a command has to say it. */
export function recoverLine(sha: string): string {
  return `git stash apply ${sha}`;
}
