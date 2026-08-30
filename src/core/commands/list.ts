import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type BranchState,
  branchStates,
  commitTimes,
  type Drift,
  defaultBranch,
  driftFrom,
  remoteRef,
} from "../branches.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { readStack } from "../stack.ts";
import { listWorktrees, statusOf, worktreeDir } from "../worktrees.ts";

/** `grove list` — what is here, what state it is in, and where you are standing. */

/**
 * How many changed paths a summary carries with it.
 *
 * Higher than any terminal has rows, so the panel that draws them never runs
 * out of list before it runs out of screen, and low enough that a worktree
 * somebody unpacked a tarball into does not turn every refresh tick into a
 * copy of its file listing.
 */
const FILE_SAMPLE = 200;

/**
 * Why a worktree looks finished with, when it does.
 *
 * The two traces a merge leaves, and the two spellings this reports back:
 * `gone` is the remote's own answer — the branch was pushed and the remote no
 * longer has it, which is what a merged pull request with the delete box ticked
 * leaves behind. `merged` is git's — every commit on the branch is already on
 * the trunk, which is what a squash or a rebase leaves behind instead.
 *
 * `gone` wins where both are true, because it is the stronger claim: somebody
 * deliberately deleted that branch, while `merged` is a fact about commits that
 * nobody had to decide.
 */
export type Finished = "gone" | "merged";

/**
 * Whether a branch has finished, and how — or nothing.
 *
 * Both answers need the branch to have had an upstream. Without one it has
 * never left this machine, and "every commit is already on the trunk" is just
 * as true of a branch cut ten seconds ago that nobody has committed to yet —
 * which is precisely the worktree it would be worst to offer to clear away.
 *
 * The trunk is never finished with, whatever is true of it. It is the branch
 * everything else is measured against, and measuring it against itself would
 * badge the one worktree that must always be there.
 */
function finishedWith(
  branch: string | undefined,
  trunk: string,
  state: BranchState | undefined,
): Finished | undefined {
  if (branch === undefined || branch === trunk) return undefined;
  if (state?.upstream === undefined) return undefined;
  if (state.gone) return "gone";

  return state.merged ? "merged" : undefined;
}

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
  /**
   * How many of `changed` git is not tracking.
   *
   * Counted apart because they are destroyed by a different command — `reset
   * --hard` leaves them and `clean` takes them — so a confirmation that lumped
   * them together would be promising one thing and doing another.
   */
  readonly untracked: number;
  /**
   * The changed paths themselves, up to `FILE_SAMPLE` of them.
   *
   * `changed` says how much is uncommitted; this says *what*, which is the
   * question a count only ever raises — and it costs nothing to carry, because
   * the `status` behind the count already named every one of these.
   *
   * Capped because it is drawn into a panel a screen tall: a worktree with ten
   * thousand changed paths would hold ten thousand strings per refresh tick to
   * draw thirty of them. `changed` is still the honest total, which is what
   * lets the panel say how many it is not showing.
   */
  readonly files: readonly string[];
  readonly ahead: number;
  readonly behind: number;
  readonly upstream?: string;
  /**
   * How far this branch has drifted from the default branch.
   *
   * A second question entirely from `ahead`/`behind`, which are about the branch
   * this one tracks. Working in a worktree you care about both: whether there is
   * anything to push, and whether the trunk has moved out from under you — the
   * second is what `sync` is for and the first has nothing to say about it.
   *
   * Absent where there is nothing to compare: the default branch itself, a
   * detached HEAD, and a git too old to answer in one call.
   */
  readonly trunk?: Drift;
  /**
   * When this worktree was last worked in, as epoch milliseconds.
   *
   * The later of the HEAD commit's time and the newest uncommitted edit —
   * because "when was I last here" has two honest answers, and the commit alone
   * gives the wrong one for exactly the worktree you left mid-change. Absent
   * when neither can be read, and the column simply stays blank.
   */
  readonly touched?: number;
  readonly locked: boolean;
  /** A rebase is stopped part-way here and needs finishing or aborting. */
  readonly rebasing: boolean;
  /**
   * Why this worktree looks finished with, when it does — what `prune` acts on.
   *
   * Absent for every branch still being worked on, which is what makes the
   * badge worth having: on most screens it is on none of the rows, and the two
   * it is on are the two nobody has cleared away yet.
   */
  readonly finished?: Finished;
  /**
   * The branch this one was stacked on, when it was stacked on one.
   *
   * Absent for almost every row, which is what makes it worth showing: a stack
   * is the case where "how far from the trunk" is answering about the wrong
   * base, and this is the field that says so. See `core/stack.ts`.
   */
  readonly parent?: string;
  /** True for the branch the repository treats as its trunk. */
  readonly isDefault: boolean;
  /** True for the worktree the command was run from. */
  readonly current: boolean;
};

/**
 * The newest thing that happened in a worktree, committed or not.
 *
 * The commit time answers for a clean worktree; a dirty one is newer than its
 * last commit by definition, so the changed files' mtimes are read too — and
 * `status` has already named them, which is what keeps this a handful of stats
 * rather than a walk of the tree. A path that cannot be statted is a deletion
 * or a rename's old name, and says nothing about when.
 */
async function latestTouch(
  path: string,
  changed: readonly string[],
  committed: number | undefined,
): Promise<number | undefined> {
  const mtimes = await Promise.all(
    changed.map(async (file) => {
      try {
        return (await stat(join(path, file))).mtimeMs;
      } catch {
        return undefined;
      }
    }),
  );

  const known = [committed, ...mtimes].filter((time): time is number => time !== undefined);

  return known.length === 0 ? undefined : Math.max(...known);
}

export async function listWorktreeSummaries(
  repo: RepoPaths,
  cwd: string,
): Promise<readonly WorktreeSummary[]> {
  const [records, trunk, stack] = await Promise.all([
    listWorktrees(repo.gitDir),
    defaultBranch(repo.gitDir),
    readStack(repo.gitDir),
  ]);
  // After `trunk` is known, and once for every branch rather than per worktree.
  const [drift, states, committed] = await Promise.all([
    driftFrom(repo.gitDir, trunk),
    // Against the remote's trunk rather than the local one, so a branch that
    // landed upstream reads as landed before anybody has pulled it down here.
    branchStates(repo.gitDir, remoteRef(trunk)),
    commitTimes(
      repo.gitDir,
      records.map((record) => record.head).filter((head): head is string => head !== undefined),
    ),
  ]);

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
        untracked: status.untracked.length,
        files: status.changed.slice(0, FILE_SAMPLE),
        ahead: status.ahead,
        behind: status.behind,
        upstream: status.upstream,
        // Nothing to say about the trunk's distance from itself.
        trunk:
          record.branch === undefined || record.branch === trunk
            ? undefined
            : drift.get(record.branch),
        touched: await latestTouch(
          record.path,
          status.changed,
          record.head === undefined ? undefined : committed.get(record.head),
        ),
        locked: record.locked !== undefined,
        rebasing: record.rebasing === true,
        finished: finishedWith(
          record.branch,
          trunk,
          record.branch === undefined ? undefined : states.get(record.branch),
        ),
        parent: record.branch === undefined ? undefined : stack.get(record.branch),
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

/**
 * What is true about the working tree itself, before the remote comes into it.
 *
 * `withDirty` is off for the app, which draws that one as a dot instead.
 */
function stateParts(summary: WorktreeSummary, withDirty: boolean): string[] {
  const parts: string[] = [];

  // Reported instead of "detached", which is technically true of a stopped
  // rebase and tells the user nothing about what to do next.
  if (summary.rebasing) parts.push("rebasing");
  else if (summary.detached) parts.push("detached");
  if (withDirty && summary.dirty) parts.push("dirty");
  // First of the ordinary states, and the only one that is an invitation
  // rather than a warning: `merged` on a row is the tool saying there is
  // nothing left to do here, which is what `r` — or `grove prune` for all of
  // them at once — is for.
  if (summary.finished !== undefined) parts.push(summary.finished);

  return parts;
}

/**
 * The state column: the shortest true description of the worktree.
 *
 * The parent is appended rather than folded in with the rest, and after
 * `clean`. Everything before it is a state the worktree is in and could get out
 * of; where a branch was cut from is not one of those, and a row reading `on
 * feat/login` *instead* of `clean` would have dropped the answer to the
 * question the column is for.
 */
function describeState(summary: WorktreeSummary): string {
  const parts = stateParts(summary, true);
  if (summary.ahead > 0) parts.push(`${summary.ahead} ahead`);
  if (summary.behind > 0) parts.push(`${summary.behind} behind`);
  if (summary.locked) parts.push("locked");

  const state = parts.length === 0 ? "clean" : parts.join(", ");

  return summary.parent === undefined ? state : `${state}, on ${summary.parent}`;
}

/**
 * The states that still need a word once a dot has said whether it is dirty.
 *
 * For the app, which draws the working tree as `○`/`●` and gives the drift its
 * own column — leaving this with the three that are neither: a rebase stopped
 * part-way, a detached HEAD, and a lock. All three are unusual, and all three
 * are things you would rather read than decode.
 */
export function noteParts(summary: WorktreeSummary): readonly string[] {
  const parts = stateParts(summary, false);
  if (summary.locked) parts.push("locked");
  // Last, because it is the only one of these that is not a warning: the other
  // three are things to deal with, and this is where the row sits.
  if (summary.parent !== undefined) parts.push(`on ${summary.parent}`);

  return parts;
}

export function describeNotes(summary: WorktreeSummary): string {
  return noteParts(summary).join(", ");
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
 * The same, against the default branch: `↑` is what this branch adds to it, `↓`
 * is what it has fallen behind by — and the second is the one `sync` exists to
 * close.
 *
 * Empty where the comparison is meaningless rather than zero, since `↑0 ↓0` on
 * the trunk's own row would be answering a question nobody asked.
 */
export function describeTrunk(summary: WorktreeSummary): string {
  if (summary.trunk === undefined) return "";

  return `↑${summary.trunk.ahead} ↓${summary.trunk.behind}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The touched column: how long ago, until "ago" stops meaning anything.
 *
 * `5m ago` is an answer about now — which of these was I just in — and that
 * question fades within a week. Past it the honest answer is a date, because
 * "34d ago" is arithmetic the reader has to undo to learn what `2026-07-03
 * 14:12` just says. Local time, since "when was I last here" is a question
 * about the reader's day and not about UTC.
 *
 * A timestamp from the future reads as `now`: clocks drift, and a column that
 * said `-2m ago` would be reporting the drift rather than the worktree.
 */
export function describeTouched(summary: WorktreeSummary, now: number): string {
  if (summary.touched === undefined) return "";

  return describeAge(summary.touched, now);
}

/**
 * The same answer for any moment in the past, which is what the app's commit
 * log asks of it too.
 *
 * Shared rather than written twice, because "when" should read the same
 * wherever the screen says it: the `last` column and the commits under the
 * list are the same question about two different things, and two spellings of
 * `2h ago` would be two conventions to learn.
 */
export function describeAge(time: number, now: number): string {
  const age = now - time;
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d ago`;

  const date = new Date(time);

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
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
