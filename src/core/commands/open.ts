import { openNow } from "../../hooks/open.ts";
import type { Reporter } from "../../report/reporter.ts";
import { GroveError } from "../errors.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { listWorktrees, resolveTarget, worktreeDir } from "../worktrees.ts";

/**
 * `grove open` — the `[setup] open` line, run on a worktree that already exists.
 *
 * `.grove.toml`'s `open` used to fire exactly once per worktree, at the end of
 * the `add` that made it. That is the right moment and the only one it covered:
 * the worktree is still there next week, the editor window is not, and reopening
 * it meant either typing out whatever the file says or `cd`-ing there and
 * remembering. Both are the bookkeeping this tool exists to remove, and the
 * project already wrote down what opens it.
 *
 * No target means the worktree you are standing in, which is the case this
 * command is most often reached for — you are already there, and the window is
 * what is missing. Anywhere else in the repository, name one.
 */

export type OpenResult = {
  readonly path: string;
  readonly dir: string;
  readonly branch?: string;
  /**
   * The command that was started, if one was — which is all that can be known.
   *
   * Nothing is awaited: see `hooks/open.ts` for what letting go of a process
   * costs and why it is worth paying.
   */
  readonly opened?: string;
  /** The `open` line comes from a file git tracks, unread on this machine. */
  readonly untrusted: boolean;
};

export type OpenOptions = {
  readonly target?: string;
  /** `--trust`: run the line, recording that this file has been read. */
  readonly trust: boolean;
  /** Whether there is a terminal to open into — see `SetupOptions.open`. */
  readonly open?: boolean;
};

export async function openWorktree(
  repo: RepoPaths,
  cwd: string,
  options: OpenOptions,
  reporter: Reporter,
): Promise<OpenResult> {
  const worktrees = await listWorktrees(repo.gitDir);

  const record =
    options.target === undefined
      ? here(repo, cwd, worktrees)
      : resolveTarget(options.target, worktrees, { root: repo.root, cwd });

  const { opened, untrusted } = await openNow(
    repo,
    { path: record.path, branch: record.branch },
    reporter,
    { trust: options.trust, allowed: options.open !== false },
  );

  return {
    path: record.path,
    dir: worktreeDir(repo.root, record.path),
    branch: record.branch,
    opened,
    untrusted,
  };
}

/**
 * The worktree the shell is standing in, for the run that named none.
 *
 * `contains` and not an exact path, because people are two directories down in
 * one as often as at its root — the question is which worktree this is, not
 * whether the shell is at the top of it. The repository root is in no worktree
 * and is the one place this cannot answer, which is where the refusal points.
 */
function here(repo: RepoPaths, cwd: string, worktrees: Awaited<ReturnType<typeof listWorktrees>>) {
  const record = worktrees.find((each) => contains(each.path, cwd));
  if (record) return record;

  throw new GroveError("usage", "not inside a worktree, so there is none to open", {
    hint: "name one: `grove open feat/login`",
    details: worktrees
      .map((each) => worktreeDir(repo.root, each.path))
      .sort((a, b) => a.localeCompare(b)),
  });
}
