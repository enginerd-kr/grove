import { runGit } from "../core/git.ts";

/**
 * Which version of `.grove.toml` each worktree was last filled in from.
 *
 * `add` applies the file as it is on the day the worktree is made, and the
 * file goes on changing afterwards — a `copy` line lands in a pull request, an
 * install command is renamed — and every worktree made before that is quietly
 * a worktree of an older project. `grove setup` is the fix, and the only way to
 * know it was needed was to remember. This is the remembering: after a setup
 * completes, the fingerprint of the file it ran from is written down beside
 * the branch, and `list` compares that with the file as it is now.
 *
 * The fingerprint is `trust.ts`'s — the same hash of the same tracked text —
 * so one edit to the file withdraws the trust it was given *and* marks every
 * worktree filled in from the old version as stale. One fact, two records,
 * and no second definition of "the file changed".
 *
 * Kept in `branch.<name>`, the way `stack.ts` keeps a branch's parent: it is
 * where git keeps the rest of what is known about a branch, `git branch -m`
 * carries it along, and deleting the branch takes it away. A worktree that is
 * removed clears it itself — the record is about the directory that was filled
 * in, and the branch outlives that.
 *
 * Absent is "nothing is known", never "stale": a worktree made before this
 * record existed has no badge, rather than every one of them asking to be set
 * up again the morning after an upgrade.
 */

/** The variable name, under `branch.<name>`. git lowercases it, so it is written lowercased. */
const KEY = "grovesetup";

function keyFor(branch: string): string {
  return `branch.${branch}.${KEY}`;
}

/** Records the fingerprint a worktree's branch was last filled in from. */
export async function recordApplied(
  bare: string,
  branch: string,
  fingerprint: string,
): Promise<void> {
  await runGit(["config", "--replace-all", keyFor(branch), fingerprint], { cwd: bare });
}

/**
 * Forgets what a branch was filled in from.
 *
 * Exit 5 — "the key was not there" — is the ordinary case, and answered rather
 * than thrown: every caller clears a record it is not certain exists.
 */
export async function clearApplied(bare: string, branch: string): Promise<void> {
  await runGit(["config", "--unset-all", keyFor(branch)], { cwd: bare });
}

/**
 * Every recorded fingerprint, in one call — read by `list`, which redraws on
 * a timer, for the reason `readStack` reads its records in one.
 */
export async function appliedFingerprints(bare: string): Promise<ReadonlyMap<string, string>> {
  const result = await runGit(["config", "--get-regexp", `^branch\\..*\\.${KEY}$`], { cwd: bare });

  const applied = new Map<string, string>();
  if (result.code !== 0) return applied;

  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;

    const key = line.slice(0, space);
    const fingerprint = line.slice(space + 1).trim();
    const branch = key.slice("branch.".length, key.length - KEY.length - 1);

    if (branch.length === 0 || fingerprint.length === 0) continue;
    applied.set(branch, fingerprint);
  }

  return applied;
}

/**
 * Whether a worktree was filled in from a version of the file that is no
 * longer the current one.
 *
 * Both sides have to be known: no record is a worktree nobody has set up
 * through grove since the record existed, and no current fingerprint is a
 * project with no tracked file to be stale against. Neither is a badge.
 */
export function isStale(applied: string | undefined, current: string | undefined): boolean {
  return applied !== undefined && current !== undefined && applied !== current;
}
