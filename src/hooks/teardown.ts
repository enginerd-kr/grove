import type { RepoPaths } from "../core/layout.ts";
import { worktreeDir } from "../core/worktrees.ts";
import type { Reporter } from "../report/reporter.ts";
import { type HookFailure, type HookTarget, runCommands, teardownGate } from "./command.ts";
import { repoHooks } from "./config.ts";

/**
 * `[teardown]` — what to run in a worktree just before it is removed.
 *
 * The other half of `[setup]`, and the half that was missing. A `run` line that
 * starts a container, a database, or a tunnel leaves that thing running after
 * the directory it was started in is gone, and nothing in the repository ever
 * said how to stop it — so it was stopped by hand, by whoever remembered, or
 * not at all. This is where the project says it once.
 */

export type TeardownResult = {
  readonly dir: string;
  /** How many commands `[teardown]` asked for. Zero is every ordinary repository. */
  readonly planned: number;
  readonly ran: readonly string[];
  /** Set when a command exited non-zero. The ones after it were not run. */
  readonly failed?: HookFailure;
  /** True when there were commands and this machine has not trusted the file. */
  readonly untrusted: boolean;
};

/**
 * Runs `[teardown]` in a worktree that is about to be removed.
 *
 * Never throws, and never stops the removal — which is the decision worth
 * writing down. A `docker compose down` that fails because Docker is not
 * running would otherwise leave somebody unable to delete a directory they have
 * finished with, on account of a cleanup for a thing that is already not
 * running. So a failure is loud and the removal carries on, and `--no-teardown`
 * is there for the repository whose cleanup is broken enough to want skipping
 * outright.
 *
 * Trust is the same record `[setup]`'s commands answer to, because it is the
 * same file: one `--trust` covers both, and one edit withdraws both.
 */
export async function runTeardown(
  repo: RepoPaths,
  target: HookTarget,
  reporter: Reporter,
): Promise<TeardownResult> {
  const dir = worktreeDir(repo.root, target.path);
  const hooks = await repoHooks(repo, target.path);
  const { commands } = hooks.teardown;

  const { ran, failed, untrusted } = await runCommands(
    repo,
    target,
    hooks,
    hooks.teardown,
    {
      noun: "teardown command",
      tail: "the worktree still goes, but nothing was run in it",
    },
    reporter,
    teardownGate(hooks),
  );

  return { dir, planned: commands.length, ran, failed, untrusted };
}
