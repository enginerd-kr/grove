import { GardenError } from "./errors.ts";
import { gitOutput, runGit } from "./git.ts";

/** Questions about refs, asked of the bare repository. */

const REMOTE = "origin";

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
