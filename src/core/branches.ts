import { GroveError } from "./errors.ts";
import { gitOutput, gitSucceeds, runGit } from "./git.ts";

/** Questions about refs, asked of the bare repository — and the one call that refreshes them. */

const REMOTE = "origin";

/**
 * Brings every remote-tracking ref up to date.
 *
 * The one write in this file, and it is here because everything else here reads
 * what it produces: `origin/main` is a local ref, so "2 behind" means two
 * commits behind whatever this last saw, not behind the remote as it is now.
 *
 * Answers rather than throws. Both callers want that — `sync` is about to do the
 * real work and would rather fail there with a better message, and the app polls
 * this in the background, where being offline is an ordinary state of affairs
 * and not something to interrupt anyone about.
 */
export function fetchRemotes(bare: string): Promise<boolean> {
  return gitSucceeds(["fetch", "--all", "--prune", "--tags"], { cwd: bare });
}

export type Drift = { readonly ahead: number; readonly behind: number };

/**
 * How far every local branch has drifted from `base`, in one call.
 *
 * One call rather than one per branch, because this is read on a timer: a
 * `rev-list` per worktree every couple of seconds is a cost that grows with the
 * repository, and `for-each-ref` walks the whole set once.
 *
 * `%(ahead-behind:)` arrived in git 2.41. On anything older the format is not a
 * field name and git refuses the whole command, which is reported here as "no
 * answer" rather than as a failure — the column it feeds simply stays empty,
 * and nothing else about the screen depends on it.
 */
export async function driftFrom(bare: string, base: string): Promise<Map<string, Drift>> {
  const result = await runGit(
    ["for-each-ref", `--format=%(refname:short) %(ahead-behind:${base})`, "refs/heads/"],
    { cwd: bare },
  );

  const drift = new Map<string, Drift>();
  if (result.code !== 0) return drift;

  for (const line of result.stdout.split("\n")) {
    // `<branch> <ahead> <behind>`, and a branch name may contain spaces in
    // nothing git allows — but the counts are the last two fields either way.
    const match = /^(.+) (\d+) (\d+)$/.exec(line.trim());
    if (!match) continue;

    const [, branch, ahead, behind] = match;
    if (branch === undefined) continue;

    drift.set(branch, { ahead: Number(ahead), behind: Number(behind) });
  }

  return drift;
}

/**
 * What the remote and the trunk say about a branch that may be finished with.
 *
 * Two questions, because a merge leaves two different traces and no workflow
 * leaves both. A pull request merged with the box ticked deletes the branch on
 * the remote, and what stays behind here is a local branch whose upstream has
 * been withdrawn — `gone`. A pull request squashed or rebased leaves the remote
 * branch alone but puts every one of its commits on the trunk — `merged`.
 * Looking for only one of them would leave half of everybody's worktrees piling
 * up.
 */
export type BranchState = {
  /** The branch it was configured to track, whether or not the remote still has it. */
  readonly upstream?: string;
  /** Configured to track something the remote no longer has. */
  readonly gone: boolean;
  /** Every commit on this branch is already on the base. */
  readonly merged: boolean;
};

const NO_STATE: BranchState = { gone: false, merged: false };

/**
 * What each local branch's upstream is, and whether it is still there.
 *
 * `%(upstream:track)` is git's own answer to the second question — it reports
 * `[gone]` for a branch configured to track a ref that no longer exists, which
 * is exactly the state `fetch --prune` leaves behind when somebody deletes a
 * merged branch on the forge. Reading it beats comparing two lists ourselves,
 * because git already knows the difference between "never had an upstream" and
 * "had one, and it went".
 *
 * Tab-separated because a ref name cannot contain a control character, so there
 * is no branch this splits wrongly — unlike a space, which `%(upstream:track)`
 * puts in the middle of its own answers.
 */
async function upstreamStates(bare: string): Promise<Map<string, BranchState>> {
  const states = new Map<string, BranchState>();
  const result = await runGit(
    [
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
      "refs/heads/",
    ],
    { cwd: bare },
  );
  if (result.code !== 0) return states;

  for (const line of result.stdout.split("\n")) {
    const [branch, upstream, track] = line.split("\t");
    if (branch === undefined || branch.length === 0) continue;

    states.set(branch, {
      ...NO_STATE,
      ...(upstream === undefined || upstream.length === 0 ? {} : { upstream }),
      gone: track === "gone",
    });
  }

  return states;
}

/** The branches with nothing of their own left to say — every commit is on `base`. */
async function mergedInto(bare: string, base: string): Promise<ReadonlySet<string>> {
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "--merged", base, "refs/heads/"],
    { cwd: bare },
  );
  // A base that cannot be resolved — a repository with no remote-tracking trunk
  // yet — is "nothing is known to be merged", which leaves the badge off rather
  // than putting a wrong one on.
  if (result.code !== 0) return new Set();

  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * Both answers for every branch, in two calls rather than two per branch.
 *
 * `base` should be the *remote's* trunk, not the local one. The question being
 * asked is "has this work landed", and it lands on the remote — a local `main`
 * that has not been pulled since Tuesday would answer "not yet" for every
 * branch merged since, which is the week in which somebody most wants to know.
 */
export async function branchStates(
  bare: string,
  base: string,
): Promise<ReadonlyMap<string, BranchState>> {
  const [states, merged] = await Promise.all([upstreamStates(bare), mergedInto(bare, base)]);

  for (const [branch, state] of states) {
    if (merged.has(branch)) states.set(branch, { ...state, merged: true });
  }

  return states;
}

/**
 * When each of these commits was made, in one call, as epoch milliseconds.
 *
 * One call rather than one per worktree, for the same reason as `driftFrom`:
 * this feeds a screen that redraws on a timer, and `--no-walk` reads exactly
 * the commits it is handed without walking anything's history.
 *
 * Tolerant the same way too. A sha that cannot be shown — or a git that cannot
 * answer — leaves the map short rather than failing the read, and the column
 * this feeds simply stays empty for those rows.
 */
export async function commitTimes(
  bare: string,
  shas: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const times = new Map<string, number>();
  if (shas.length === 0) return times;

  const result = await runGit(["log", "--no-walk=unsorted", "--format=%H %ct", ...shas], {
    cwd: bare,
  });
  if (result.code !== 0) return times;

  for (const line of result.stdout.split("\n")) {
    const match = /^([0-9a-f]+) (\d+)$/.exec(line.trim());
    if (!match) continue;

    const [, sha, seconds] = match;
    if (sha === undefined) continue;

    times.set(sha, Number(seconds) * 1000);
  }

  return times;
}

/**
 * The branch everything else is measured against.
 *
 * Read from `refs/remotes/origin/HEAD` rather than from the bare repo's own
 * HEAD, because HEAD here tracks whichever branch got the first worktree —
 * which the user may have chosen with `--branch` and which says nothing about
 * what the remote considers its trunk.
 */
export async function defaultBranch(bare: string): Promise<string> {
  const result = await runGit(["symbolic-ref", "--short", `refs/remotes/${REMOTE}/HEAD`], {
    cwd: bare,
  });

  if (result.code !== 0) {
    throw new GroveError("git-failed", `cannot tell which branch ${REMOTE} considers default`, {
      hint: `run \`git -C ${bare} remote set-head ${REMOTE} --auto\``,
    });
  }

  // Comes back as `origin/main`; callers want the branch, not the remote-tracking ref.
  return result.stdout.trim().replace(new RegExp(`^${REMOTE}/`), "");
}

/**
 * Points `refs/remotes/origin/HEAD` at whatever the remote currently advertises.
 *
 * Tolerant of failure: a remote with no HEAD is unusual but not fatal, and the
 * caller has a fallback. Returns whether it worked so the caller can pick.
 */
export async function updateRemoteHead(bare: string): Promise<boolean> {
  return (await runGit(["remote", "set-head", REMOTE, "--auto"], { cwd: bare })).code === 0;
}

/** The remote-tracking ref for a branch — what `branchStates` measures against. */
export function remoteRef(branch: string): string {
  return `${REMOTE}/${branch}`;
}

export async function localBranchExists(bare: string, branch: string): Promise<boolean> {
  return (
    (await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: bare }))
      .code === 0
  );
}

export async function remoteBranchExists(bare: string, branch: string): Promise<boolean> {
  return (
    (
      await runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}`], {
        cwd: bare,
      })
    ).code === 0
  );
}

export async function localBranches(bare: string): Promise<readonly string[]> {
  const output = await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
    cwd: bare,
  });

  return output.length === 0 ? [] : output.split("\n");
}
