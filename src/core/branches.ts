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
