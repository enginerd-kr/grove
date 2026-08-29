import { runGit } from "./git.ts";

/**
 * The last few commits in a worktree — `git log --oneline`, as data.
 *
 * Read per worktree rather than for the whole repository, because that is the
 * question the screen is asking: not "what has happened here" but "what has
 * happened on the branch under the cursor", which is what tells one row's
 * history from the next one's.
 *
 * Tolerant, like every other read that runs on a timer: a branch with no
 * commits yet, a git that refuses, a directory that is no longer there — all
 * answer "nothing to show" rather than failing a screen that was only ever
 * going to draw a few lines with it.
 */

export type Commit = {
  /** Abbreviated the way git chose to abbreviate it — unique within this log. */
  readonly sha: string;
  /** The first line of the message, which is the whole of what `--oneline` shows. */
  readonly subject: string;
  /** When it was committed, as epoch milliseconds. */
  readonly when: number;
  /** `HEAD -> feat/login, origin/feat/login`, and empty for most commits. */
  readonly refs: string;
};

/**
 * NUL between the fields, because it is the one byte none of them can contain.
 *
 * A space or a tab would do until the first subject with one in it, and a
 * decoration is itself a comma-separated list — so the separator has to be
 * something git will not let into the data.
 */
const FIELD = "\u0000";

/** The newest `limit` commits reachable from the worktree's HEAD. */
export async function recentCommits(path: string, limit: number): Promise<readonly Commit[]> {
  if (limit <= 0) return [];

  const result = await runGit(
    ["log", `--max-count=${limit}`, "--no-color", "--format=%h%x00%ct%x00%D%x00%s"],
    { cwd: path },
  );
  // Every way this fails is a worktree with nothing to show — an unborn HEAD
  // most often, which is what a branch reads as before its first commit.
  if (result.code !== 0) return [];

  const commits: Commit[] = [];

  for (const line of result.stdout.split("\n")) {
    const [sha, seconds, refs, subject] = line.split(FIELD);
    if (sha === undefined || seconds === undefined || refs === undefined) continue;
    if (sha.length === 0) continue;

    const when = Number(seconds);
    if (!Number.isFinite(when)) continue;

    // A commit with an empty subject is a real commit, so it keeps its row.
    commits.push({ sha, when: when * 1000, refs, subject: subject ?? "" });
  }

  return commits;
}
