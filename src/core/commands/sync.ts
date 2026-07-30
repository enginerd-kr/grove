import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch } from "../branches.ts";
import { WtError } from "../errors.ts";
import { gitOutput, runGit } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import {
  listWorktrees,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";

/**
 * `wt sync` — fetch, then bring worktrees up to date with the default branch.
 *
 * Nothing here touches a worktree it has not first established is safe to touch.
 * A sync that half-finishes is worse than one that declines, because the user
 * finds out later and in the middle of something else.
 */

export type SyncOptions = {
  /** Which worktree. Omitted means the one you are standing in. */
  readonly target?: string;
  readonly all: boolean;
  /** Undo a conflicted rebase instead of leaving it to resolve by hand. */
  readonly abortOnConflict: boolean;
};

export type SyncOutcome = {
  readonly path: string;
  /** The worktree's directory relative to the repo root, for messages. */
  readonly dir: string;
  readonly branch?: string;
  readonly kind: "up-to-date" | "fast-forwarded" | "rebased" | "skipped" | "conflicted";
  /** Why it was skipped, or what conflicted. Absent when nothing went wrong. */
  readonly reason?: string;
  readonly conflicts?: readonly string[];
};

const REMOTE = "origin";

export async function syncWorktrees(
  repo: RepoPaths,
  cwd: string,
  options: SyncOptions,
  reporter: Reporter,
): Promise<readonly SyncOutcome[]> {
  const worktrees = await listWorktrees(repo.bare);
  const targets = chooseTargets(worktrees, repo.root, cwd, options);

  // One fetch for the whole run: the remote does not change between worktrees,
  // and `--all` over ten of them should not mean ten round trips.
  const step = reporter.step("fetching");
  await runGit(["fetch", "--all", "--prune", "--tags"], { cwd: repo.bare });
  step.succeed("fetched");

  const trunk = await defaultBranch(repo.bare);
  const outcomes: SyncOutcome[] = [];

  for (const target of targets) {
    outcomes.push(await syncOne(target, repo.root, trunk, options, reporter));
  }

  return outcomes;
}

function chooseTargets(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  options: SyncOptions,
): readonly WorktreeRecord[] {
  if (options.all) return worktrees;
  if (options.target !== undefined) {
    return [resolveTarget(options.target, worktrees, { root, cwd })];
  }

  const here = worktrees.find((record) => contains(record.path, cwd));
  if (here) return [here];

  throw new WtError("usage", "not inside a worktree, so there is nothing to sync", {
    hint: "name one (`wt sync <branch>`) or pass --all",
  });
}

async function syncOne(
  record: WorktreeRecord,
  root: string,
  trunk: string,
  options: SyncOptions,
  reporter: Reporter,
): Promise<SyncOutcome> {
  const name = worktreeDir(root, record.path);
  const skip = (reason: string, conflicts?: readonly string[]): SyncOutcome => ({
    path: record.path,
    dir: name,
    branch: record.branch,
    kind: "skipped",
    reason,
    conflicts,
  });

  // Checked before the detached test, because a worktree stopped mid-rebase is
  // detached: walking into someone's half-finished rebase would either fail
  // confusingly or discard the conflict resolution they were part-way through.
  if (record.rebasing) {
    return skip("a rebase is already in progress here");
  }

  if (record.detached || record.branch === undefined) {
    return skip("detached HEAD, so there is no branch to move");
  }

  const status = await statusOf(record.path);
  if (status.dirty) {
    // Checked before anything is run, not after: this is the difference between
    // declining and leaving the worktree half-updated.
    return skip("uncommitted changes", status.changed.slice(0, 5));
  }

  const before = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });
  const onto = `${REMOTE}/${trunk}`;
  const step = reporter.step(`syncing ${name}`);

  // The default branch is fast-forwarded rather than rebased. Rebasing `main`
  // onto `origin/main` would rewrite local commits nobody asked to have
  // rewritten — the one case where the safe operation and the useful one differ.
  const result =
    record.branch === trunk
      ? await runGit(["merge", "--ff-only", onto], { cwd: record.path })
      : await runGit(["rebase", onto], { cwd: record.path });

  if (result.code !== 0) {
    if (record.branch === trunk) {
      step.fail(`${name} has diverged from ${onto}`);
      return skip(`local commits on ${trunk} that ${onto} does not have`);
    }

    const conflicts = await conflictedPaths(record.path);
    if (options.abortOnConflict) {
      await runGit(["rebase", "--abort"], { cwd: record.path });
    }
    step.fail(`${name} conflicts with ${onto}`);

    return {
      path: record.path,
      dir: name,
      branch: record.branch,
      kind: "conflicted",
      reason: options.abortOnConflict
        ? "rebase conflicted and was rolled back"
        : "rebase conflicted and was left in place to resolve",
      conflicts,
    };
  }

  const after = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });
  if (before === after) {
    step.succeed(`${name} already up to date`);
    return { path: record.path, dir: name, branch: record.branch, kind: "up-to-date" };
  }

  step.succeed(`${name} updated`);

  return {
    path: record.path,
    dir: name,
    branch: record.branch,
    kind: record.branch === trunk ? "fast-forwarded" : "rebased",
  };
}

/** The files git stopped on, captured before the rebase is rolled back. */
async function conflictedPaths(path: string): Promise<readonly string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: path });
  if (result.code !== 0) return [];

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Turns outcomes into the one exit code the shell sees.
 *
 * A conflict outranks a skip: it is the result that needs a decision, and with
 * `--all` it would otherwise be hidden behind a worktree that merely had
 * uncommitted changes.
 */
export function failureFor(outcomes: readonly SyncOutcome[]): WtError | undefined {
  const conflicted = outcomes.filter((outcome) => outcome.kind === "conflicted");
  const skipped = outcomes.filter((outcome) => outcome.kind === "skipped");

  if (conflicted.length > 0) {
    return new WtError("rebase-conflict", describe(conflicted, "conflicted"), {
      hint: "resolve them by hand, or sync after committing",
      details: conflicted.flatMap((outcome) => [
        `${outcome.dir}: ${outcome.reason ?? ""}`,
        ...(outcome.conflicts ?? []).map((file) => `  ${file}`),
      ]),
    });
  }

  if (skipped.length > 0) {
    return new WtError("refused", describe(skipped, "skipped"), {
      details: skipped.flatMap((outcome) => [
        `${outcome.dir}: ${outcome.reason ?? ""}`,
        ...(outcome.conflicts ?? []).map((file) => `  ${file}`),
      ]),
    });
  }

  return undefined;
}

function describe(outcomes: readonly SyncOutcome[], what: string): string {
  return outcomes.length === 1 && outcomes[0]
    ? `${outcomes[0].dir} ${what}`
    : `${outcomes.length} worktrees ${what}`;
}
