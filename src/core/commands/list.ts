import { defaultBranch } from "../branches.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { listWorktrees, statusOf, worktreeDir } from "../worktrees.ts";

/** `garden list` — what is here, what state it is in, and where you are standing. */

export type WorktreeSummary = {
  readonly path: string;
  readonly dir: string;
  /** Absent when the worktree is on a detached HEAD. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly dirty: boolean;
  /**
   * How many paths differ from HEAD — what a `reset` would throw away.
   *
   * `dirty` says whether there is anything; this says how much, which is the
   * difference between a confirmation someone can weigh and one they wave
   * through.
   */
  readonly changed: number;
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
        changed: status.changed.length,
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

/** What is true about the working tree itself, before the remote comes into it. */
function localParts(summary: WorktreeSummary): string[] {
  const parts: string[] = [];

  // Reported instead of "detached", which is technically true of a stopped
  // rebase and tells the user nothing about what to do next.
  if (summary.rebasing) parts.push("rebasing");
  else if (summary.detached) parts.push("detached");
  if (summary.dirty) parts.push("dirty");

  return parts;
}

function settle(parts: readonly string[], locked: boolean): string {
  const all = locked ? [...parts, "locked"] : [...parts];
  if (all.length === 0) all.push("clean");

  return all.join(", ");
}

/** The state column: the shortest true description of the worktree. */
export function describeState(summary: WorktreeSummary): string {
  const parts = localParts(summary);
  if (summary.ahead > 0) parts.push(`${summary.ahead} ahead`);
  if (summary.behind > 0) parts.push(`${summary.behind} behind`);

  return settle(parts, summary.locked);
}

/**
 * The states that still need a word once a dot has said whether it is dirty.
 *
 * For the app, which draws the working tree as `○`/`●` and gives the drift its
 * own column — leaving this with the three that are neither: a rebase stopped
 * part-way, a detached HEAD, and a lock. All three are unusual, and all three
 * are things you would rather read than decode.
 */
export function describeNotes(summary: WorktreeSummary): string {
  const parts: string[] = [];

  // Reported instead of "detached", which is technically true of a stopped
  // rebase and tells the user nothing about what to do next.
  if (summary.rebasing) parts.push("rebasing");
  else if (summary.detached) parts.push("detached");
  if (summary.locked) parts.push("locked");

  return parts.join(", ");
}

/**
 * How far this branch has drifted from the remote branch it tracks.
 *
 * `↑` is what origin does not have, `↓` is what you do not — the direction each
 * arrow points is the direction the commits have to travel. Both are counted
 * against the remote-tracking ref, so they are as fresh as the last fetch and no
 * fresher, which is why the app fetches on a timer.
 */
export function describeRemote(summary: WorktreeSummary): string {
  if (summary.upstream === undefined) return "no upstream";

  return `↑${summary.ahead} ↓${summary.behind}`;
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
