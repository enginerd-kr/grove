import { defaultBranch } from "../branches.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { listWorktrees, statusOf, worktreeDir } from "../worktrees.ts";

/** `wt list` — what is here, what state it is in, and where you are standing. */

export type WorktreeSummary = {
  readonly path: string;
  readonly dir: string;
  /** Absent when the worktree is on a detached HEAD. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly upstream?: string;
  readonly locked: boolean;
  /** A rebase is stopped part-way here and needs finishing or aborting. */
  readonly rebasing: boolean;
  /** True for the branch the repository treats as its trunk. */
  readonly isDefault: boolean;
  /** True for the worktree the command was run from. */
  readonly current: boolean;
};

export async function listWorktreeSummaries(
  repo: RepoPaths,
  cwd: string,
): Promise<readonly WorktreeSummary[]> {
  const [records, trunk] = await Promise.all([listWorktrees(repo.bare), defaultBranch(repo.bare)]);

  const summaries = await Promise.all(
    records.map(async (record) => {
      const status = await statusOf(record.path);

      return {
        path: record.path,
        dir: worktreeDir(repo.root, record.path),
        branch: record.branch,
        detached: record.detached,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
        upstream: status.upstream,
        locked: record.locked !== undefined,
        rebasing: record.rebasing === true,
        isDefault: record.branch === trunk,
        current: contains(record.path, cwd),
      };
    }),
  );

  // The trunk first, then alphabetically: a stable order means the output can be
  // diffed between runs, and the default branch is the one people look for.
  return summaries.toSorted((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.dir.localeCompare(b.dir);
  });
}

/** The state column: the shortest true description of the worktree. */
export function describeState(summary: WorktreeSummary): string {
  const parts: string[] = [];

  // Reported instead of "detached", which is technically true of a stopped
  // rebase and tells the user nothing about what to do next.
  if (summary.rebasing) parts.push("rebasing");
  else if (summary.detached) parts.push("detached");
  if (summary.dirty) parts.push("dirty");
  if (summary.ahead > 0) parts.push(`${summary.ahead} ahead`);
  if (summary.behind > 0) parts.push(`${summary.behind} behind`);
  if (summary.locked) parts.push("locked");
  if (parts.length === 0) parts.push("clean");

  return parts.join(", ");
}

/**
 * A padded table, written to be read by eye.
 *
 * `*` marks where you are, which is the question people actually open this
 * command to answer.
 */
export function formatWorktreeTable(summaries: readonly WorktreeSummary[]): string {
  const rows = summaries.map((summary) => ({
    marker: summary.current ? "*" : " ",
    branch: summary.branch ?? "(detached)",
    dir: summary.dir,
    state: describeState(summary),
  }));

  const branchWidth = Math.max(0, ...rows.map((row) => row.branch.length));
  const dirWidth = Math.max(0, ...rows.map((row) => row.dir.length));

  return rows
    .map(
      (row) =>
        `${row.marker} ${row.branch.padEnd(branchWidth)}  ${row.dir.padEnd(dirWidth)}  ${row.state}`,
    )
    .join("\n");
}
