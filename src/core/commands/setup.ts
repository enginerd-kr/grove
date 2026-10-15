import { failureFor as hookFailure, runSetup, type SetupResult } from "../../hooks/index.ts";
import { type ConfigSource, setConfigSource } from "../../hooks/source.ts";
import type { Reporter } from "../../report/reporter.ts";
import { GroveError } from "../errors.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { listWorktrees, resolveTarget, type WorktreeRecord } from "../worktrees.ts";

/**
 * `grove setup` — `.grove.toml`'s `[setup]`, run in a worktree that already exists.
 *
 * `add` fills a worktree in at the moment it makes one, which covers the file
 * as it was on the day the worktree was made and no day after. Then somebody
 * adds `copy = [".env.local"]` in a pull request, and every worktree created
 * before it is missing a file it now says every worktree should have. There was
 * no command to fix that, so the fix was the `cp` this tool exists to remove —
 * per worktree, from memory.
 *
 * This is the same argument `grove open` was added for one version earlier, and
 * the same answer: the configuration is a standing description of what a
 * worktree of this project needs, not an event that happened once.
 *
 * It re-runs rather than patches, and the hook was already written for that.
 * `copy` takes the trunk's version over what is there — a stale `.env` is
 * refreshed — `link` keeps what the worktree already has, and `run` commands
 * are the project's own, written to be run in a checkout that may or may not
 * have been installed into. See `hooks/setup.ts`.
 *
 * What it does **not** do is open anything. `open` is the one key in the file
 * whose subject is a person, and a `--all` over eleven worktrees would put
 * eleven editor windows on the screen. `grove open` is that half, aimed at one
 * worktree at a time, which is the only way anybody wants it.
 */

export type SetupCommandOptions = {
  readonly configSource?: ConfigSource;
  /** Which worktree. Omitted, and without `--all`, means the one you are standing in. */
  readonly target?: string;
  readonly all: boolean;
};

export async function setUpWorktrees(
  repo: RepoPaths,
  cwd: string,
  options: SetupCommandOptions,
  reporter: Reporter,
): Promise<readonly SetupResult[]> {
  const worktrees = await listWorktrees(repo.gitDir);
  const targets = chooseTargets(worktrees, repo.root, cwd, options);

  const results: SetupResult[] = [];
  for (const record of targets) {
    if (options.configSource !== undefined && record.branch !== undefined) {
      await setConfigSource(repo, record.branch, options.configSource);
    }
    results.push(
      await runSetup(
        repo,
        { path: record.path, branch: record.branch },
        { opens: false },
        reporter,
      ),
    );
  }

  return results;
}

/**
 * Which worktrees to fill in — the same three answers `sync` gives.
 *
 * Standing in one is the default because that is where the question is usually
 * asked from: you pulled, the file changed, and the worktree that needs it is
 * the one you are in.
 */
function chooseTargets(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  options: SetupCommandOptions,
): readonly WorktreeRecord[] {
  if (options.all) return worktrees;
  if (options.target !== undefined) {
    return [resolveTarget(options.target, worktrees, { root, cwd })];
  }

  const here = worktrees.find((record) => contains(record.path, cwd));
  if (here) return [here];

  throw new GroveError("usage", "not inside a worktree, so there is nothing to set up", {
    hint: "name one (`grove setup <branch>`) or pass --all",
  });
}

/**
 * Turns the results into the one exit code the shell sees.
 *
 * A command that failed determines the exit code after results are reported.
 *
 * Reported after every worktree has had its turn, the way `sync --all` does it.
 */
export function failureFor(results: readonly SetupResult[]): GroveError | undefined {
  const failed = results.filter((result) => result.failed !== undefined);
  if (failed.length === 0) return undefined;
  if (failed.length === 1 && failed[0]) return hookFailure(failed[0]);

  return new GroveError("setup-failed", `a setup command failed in ${failed.length} worktrees`, {
    details: failed.map(
      (result) => `${result.dir}: ${result.failed?.command} exited ${result.failed?.code}`,
    ),
  });
}
