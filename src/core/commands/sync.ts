import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, fetchRemotes } from "../branches.ts";
import { GardenError } from "../errors.ts";
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
 * `garden sync` — fetch, then bring worktrees up to date with the default branch.
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
  /**
   * Publish the rebased commits back to the branch's own remote.
   *
   * On by default because without it the command only does two thirds of what
   * it says: a rebase rewrites the commits, so the branch is left diverged from
   * the remote it tracks and the next sync cannot fix it either.
   */
  readonly push: boolean;
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
  /** Absent when there was nothing to publish; false when the remote refused. */
  readonly pushed?: boolean;
  /** Why the push did not happen, when it was meant to. */
  readonly pushRefusal?: string;
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
  await fetchRemotes(repo.bare);
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

  throw new GardenError("usage", "not inside a worktree, so there is nothing to sync", {
    hint: "name one (`garden sync <branch>`) or pass --all",
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
  if (record.branch === trunk) {
    const result = await runGit(["merge", "--ff-only", onto], { cwd: record.path });

    if (result.code !== 0) {
      step.fail(`${name} has diverged from ${onto}`);
      return skip(`local commits on ${trunk} that ${onto} does not have`);
    }

    return settle(record, name, before, step, trunk);
  }

  /**
   * Its own remote first, then the trunk.
   *
   * The order is the whole of why this works. Rebasing onto the trunk rewrites
   * the branch's commits, so a colleague's commit sitting on `origin/<branch>`
   * would be left behind — and the force-push at the end would then be refused
   * by `--force-if-includes`, correctly, for trying to drop it. Taking their
   * work first means the rebase replays ours on top of theirs and the push has
   * nothing to destroy.
   */
  for (const base of [status.upstream, onto]) {
    if (base === undefined) continue;

    const result = await runGit(["rebase", base], { cwd: record.path });
    if (result.code === 0) continue;

    const conflicts = await conflictedPaths(record.path);
    if (options.abortOnConflict) {
      await runGit(["rebase", "--abort"], { cwd: record.path });
    }
    step.fail(`${name} conflicts with ${base}`);

    return {
      path: record.path,
      dir: name,
      branch: record.branch,
      kind: "conflicted",
      reason: options.abortOnConflict
        ? `rebase onto ${base} conflicted and was rolled back`
        : `rebase onto ${base} conflicted and was left in place to resolve`,
      conflicts,
    };
  }

  const published = await publish(record, name, status.upstream, options, reporter);

  return { ...(await settle(record, name, before, step, trunk)), ...published };
}

/** The half of a rebase workflow that a rebase does not do. */
type Published = { readonly pushed?: boolean; readonly pushRefusal?: string };

/**
 * Puts the rewritten commits back where the branch came from.
 *
 * A rebase changes every commit it moves, so a branch that tracks a remote is
 * diverged from it the moment this command touches it. Leaving it there is what
 * the earlier version of this did, and the result was a screen reporting
 * "up-to-date" over a branch two commits adrift of its own remote with nothing
 * able to close the gap.
 *
 * `--force-with-lease` and `--force-if-includes` together are what make it safe
 * to do without asking: the first refuses if the remote moved since we last
 * looked, the second refuses if what is being overwritten is not already in our
 * history. A refusal is therefore not a failure of this command but a report
 * that somebody else's work is in the way, so it is warned about rather than
 * thrown — the rebase itself succeeded, and with `--all` one contended branch
 * should not bury the news about the other nine.
 */
async function publish(
  record: WorktreeRecord,
  name: string,
  upstream: string | undefined,
  options: SyncOptions,
  reporter: Reporter,
): Promise<Published> {
  if (!options.push || upstream === undefined) return {};

  // Nothing to say if the remote already has exactly this.
  const [local, remote] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd: record.path }),
    runGit(["rev-parse", upstream], { cwd: record.path }),
  ]);
  if (local.code === 0 && remote.code === 0 && local.stdout.trim() === remote.stdout.trim()) {
    return {};
  }

  const step = reporter.step(`pushing ${name}`);
  const result = await runGit(
    ["push", "--force-with-lease", "--force-if-includes", REMOTE, record.branch ?? "HEAD"],
    { cwd: record.path },
  );

  if (result.code !== 0) {
    step.fail(`${name} was not pushed`);
    const refusal = stderrTail(result.stderr);
    reporter.warn(`${name} is rebased locally but ${upstream} refused the push: ${refusal}`);

    return { pushed: false, pushRefusal: refusal };
  }

  step.succeed(`pushed ${name}`);

  return { pushed: true };
}

/** git says a lot when it refuses a push; the last line of it is the reason. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("To "));

  return lines.at(-1) ?? "no reason given";
}

/** Whether anything moved, which is the difference between the two good outcomes. */
async function settle(
  record: WorktreeRecord,
  name: string,
  before: string,
  step: { succeed: (text?: string) => void },
  trunk: string,
): Promise<SyncOutcome> {
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
export function failureFor(outcomes: readonly SyncOutcome[]): GardenError | undefined {
  const conflicted = outcomes.filter((outcome) => outcome.kind === "conflicted");
  const skipped = outcomes.filter((outcome) => outcome.kind === "skipped");

  if (conflicted.length > 0) {
    return new GardenError("rebase-conflict", describe(conflicted, "conflicted"), {
      hint: "resolve them by hand, or sync after committing",
      details: conflicted.flatMap((outcome) => [
        `${outcome.dir}: ${outcome.reason ?? ""}`,
        ...(outcome.conflicts ?? []).map((file) => `  ${file}`),
      ]),
    });
  }

  if (skipped.length > 0) {
    return new GardenError("refused", describe(skipped, "skipped"), {
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
