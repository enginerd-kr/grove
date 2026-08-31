import type { RepoPaths } from "../layout.ts";
import { listWorktrees, resolveTarget, worktreeDir } from "../worktrees.ts";

/**
 * `grove path` — where a worktree is, said once, on stdout.
 *
 * The smallest command in the tool, and the bridge out of its one hard limit: a
 * child process cannot move the shell that started it. So the shell asks, and
 * this answers — `cd "$(grove path feat/login)"` moves you there, and the
 * screen's enter key puts that same line on the clipboard.
 *
 * No target means the repository root. The root is the one directory that is
 * never a worktree and never gets removed, which makes it the place to stand
 * while removing anything — the refusal that sends people here says "cd
 * somewhere else first", and this is the somewhere.
 */

export type PathResult = {
  readonly path: string;
  /** Relative to the root, `.` for the root itself — the name the list uses. */
  readonly dir: string;
  readonly branch?: string;
};

export async function worktreePath(
  repo: RepoPaths,
  cwd: string,
  target?: string,
): Promise<PathResult> {
  if (target === undefined) return { path: repo.root, dir: "." };

  const worktrees = await listWorktrees(repo.gitDir);
  const record = resolveTarget(target, worktrees, { root: repo.root, cwd });

  return { path: record.path, dir: worktreeDir(repo.root, record.path), branch: record.branch };
}
