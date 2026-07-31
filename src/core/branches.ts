import { GardenError } from "./errors.ts";
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
    throw new GardenError("git-failed", `cannot tell which branch ${REMOTE} considers default`, {
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
