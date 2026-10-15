import { GroveError, isGroveError } from "./errors.ts";
import { gitFailure, gitOutput, runGit, runGitOrThrow } from "./git.ts";
import { operationInProgress } from "./worktrees.ts";

/** Read actual unmerged entries, not a guess from a command's exit code or prose. */
export async function conflictedPaths(path: string): Promise<readonly string[]> {
  const output = await runGitOrThrow(["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: path,
  });
  return output.split("\0").filter((file) => file.length > 0);
}

/** Only claim a rollback after Git succeeded, cleared the operation, and restored HEAD. */
export async function abortRebase(path: string, before: string): Promise<void> {
  const hint = "inspect this worktree with `git status`, then finish or abort the rebase manually";
  try {
    const args = ["rebase", "--abort"];
    const result = await runGit(args, { cwd: path });
    if (result.code !== 0) throw gitFailure(args, result);

    const operation = await operationInProgress(path);
    const head = await gitOutput(["rev-parse", "HEAD"], { cwd: path });
    if (operation !== undefined || head !== before) {
      throw new GroveError("state-conflict", "Git did not restore the previous rebase state", {
        details: [
          `expected HEAD ${before}, found ${head}`,
          ...(operation ? [`${operation} is still in progress`] : []),
        ],
      });
    }
  } catch (error) {
    if (!isGroveError(error)) throw error;
    throw new GroveError(error.code, "could not roll back the rebase", {
      details: [error.message, ...error.details],
      hint,
      cause: error,
    });
  }
}
