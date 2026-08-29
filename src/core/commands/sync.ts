import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, enableReflogs, fetchRemotes } from "../branches.ts";
import { GroveError } from "../errors.ts";
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
 * `grove sync` — fetch, then bring worktrees up to date with the default branch.
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
  const worktrees = await listWorktrees(repo.gitDir);
  const targets = chooseTargets(worktrees, repo.root, cwd, options);

  // Asserted here, before the fetch, and not only in `clone`: a repository
  // cloned before grove started setting it has no reflogs, and the push at the
  // end of this needs them. Idempotent, so every later sync is a no-op.
  await enableReflogs(repo.gitDir);

  // One fetch for the whole run: the remote does not change between worktrees,
  // and `--all` over ten of them should not mean ten round trips.
  const step = reporter.step("fetching");
  // Answered rather than thrown — see `fetchRemotes` — but never silently: the
  // trunk this rebases onto is a local ref, so a fetch that did not happen
  // means every worktree below is measured against whatever was last seen. A
  // `✓ fetched` over that is the stale-trunk sync this command exists to
  // prevent, reported as the success it was not.
  if (await fetchRemotes(repo.gitDir)) step.succeed("fetched");
  else step.fail("could not fetch — the trunk below is as it was last seen");

  const trunk = await defaultBranch(repo.gitDir);
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

  throw new GroveError("usage", "not inside a worktree, so there is nothing to sync", {
    hint: "name one (`grove sync <branch>`) or pass --all",
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

  /**
   * `--fork-point` is what makes this survive a force-push.
   *
   * Without it git replays every commit the branch has that `base` does not —
   * which, after somebody rewrote `base`, includes the pre-rewrite copies of
   * the very commits that replaced them. They land on top of their own
   * replacements and conflict with themselves, and the user is asked to
   * resolve a change against an edit of itself.
   *
   * The reflog of `base` is what tells the two apart. A commit that is only
   * reachable from a position `base` used to be at was published and then
   * withdrawn, so it is dropped; a commit that never was on `base` is the
   * user's own and is carried, exactly as before. When there is no reflog to
   * consult — a fresh clone — git falls back to plain `base`, so nothing is
   * worse than it was.
   */
  const rebaseOnto = async (base: string): Promise<SyncOutcome | undefined> => {
    const result = await runGit(["rebase", "--fork-point", base], { cwd: record.path });
    if (result.code === 0) return undefined;

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
  };

  /**
   * The default branch: a fast-forward when it is merely behind, `pull
   * --rebase` when it has commits of its own.
   *
   * The commits are the deciding fact. A commit sitting only on the local
   * trunk — and never on the remote one, which is the line `rebaseOnto` draws
   * — already happened: somebody made it, it is theirs, and a tool that
   * refused to sync until it was disowned would be demanding an undo of an
   * event. So it is carried: replayed on top of what the remote gained, then
   * pushed back **plainly**. No force spelling is ever aimed at the trunk —
   * after the rebase the branch is strictly ahead, so a plain push suffices,
   * and if the remote is protected the refusal arrives as a warning while the
   * local rebase stands, the same way a contended feature branch is reported.
   */
  if (record.branch === trunk) {
    const ff = await runGit(["merge", "--ff-only", onto], { cwd: record.path });
    if (ff.code === 0) return settle(record, name, before, step, "fast-forwarded");

    const conflicted = await rebaseOnto(onto);
    if (conflicted) return conflicted;

    const published = await publish(record, name, onto, options, reporter, { force: false });

    return { ...(await settle(record, name, before, step, "rebased")), ...published };
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

    const conflicted = await rebaseOnto(base);
    if (conflicted) return conflicted;
  }

  const published = await publish(record, name, status.upstream, options, reporter, {
    force: true,
  });

  return { ...(await settle(record, name, before, step, "rebased")), ...published };
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
 * history. A refusal says somebody else's work is in the way — but it is still
 * a failure of this command, because the branch is now rewritten locally and
 * published nowhere, and a user who believes otherwise finds out the next time
 * somebody asks them where their work is. So it is recorded on the outcome and
 * turned into the exit code at the end rather than thrown here: the rebase did
 * happen, and with `--all` one contended branch should not bury the news about
 * the other nine.
 */
async function publish(
  record: WorktreeRecord,
  name: string,
  upstream: string | undefined,
  options: SyncOptions,
  reporter: Reporter,
  /**
   * The lease-guarded force is for branches a rebase has just rewritten.
   * The trunk never gets it: after its rebase it is strictly ahead, a plain
   * push suffices, and a force spelling aimed at a trunk is a habit not worth
   * teaching a tool.
   */
  { force }: { readonly force: boolean },
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
    [
      "push",
      ...(force ? ["--force-with-lease", "--force-if-includes"] : []),
      REMOTE,
      record.branch ?? "HEAD",
    ],
    { cwd: record.path },
  );

  if (result.code !== 0) {
    step.fail(`${name} was not pushed`);

    // Said once, here, and carried on the outcome: `failureFor` prints it under
    // the error, so warning about it as well would put the same refusal on
    // stderr twice.
    return { pushed: false, pushRefusal: `${upstream} refused it: ${stderrTail(result.stderr)}` };
  }

  step.succeed(`pushed ${name}`);

  return { pushed: true };
}

/**
 * git says a lot when it refuses a push; this is the line that says why.
 *
 * Not simply the last one. git ends with `error: failed to push some refs`,
 * which only repeats that the push failed — the reason is in the `! [rejected]`
 * line above it, and for a hook it is the only place the hook's own words
 * appear. Preferring that line is what turns "it did not work" into something
 * a person can act on.
 */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("To "));

  // Both spellings: `! [rejected]` for a non-fast-forward, `! [remote rejected]`
  // when the far end's own hook turned it down.
  const rejected = lines.filter((line) => /\[(?:remote )?rejected\]/.test(line));

  return rejected.at(-1) ?? lines.at(-1) ?? "no reason given";
}

/** Whether anything moved, which is the difference between the two good outcomes. */
async function settle(
  record: WorktreeRecord,
  name: string,
  before: string,
  step: { succeed: (text?: string) => void },
  moved: "fast-forwarded" | "rebased",
): Promise<SyncOutcome> {
  const after = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });

  if (before === after) {
    step.succeed(`${name} already up to date`);

    return { path: record.path, dir: name, branch: record.branch, kind: "up-to-date" };
  }

  step.succeed(`${name} updated`);

  return { path: record.path, dir: name, branch: record.branch, kind: moved };
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
 * A conflict outranks a refused push, which outranks a skip: each is a result
 * that needs a decision, and with `--all` the sharper one would otherwise be
 * hidden behind a worktree that merely had uncommitted changes.
 *
 * A push that was refused is a failure even though the rebase it followed
 * worked. Exiting 0 there is what let `rebased` be printed over a branch the
 * remote never received — the one outcome of this command nobody would think to
 * check for.
 */
export function failureFor(outcomes: readonly SyncOutcome[]): GroveError | undefined {
  const conflicted = outcomes.filter((outcome) => outcome.kind === "conflicted");
  const skipped = outcomes.filter((outcome) => outcome.kind === "skipped");

  if (conflicted.length > 0) {
    return new GroveError("rebase-conflict", describe(conflicted, "conflicted"), {
      hint: "resolve them by hand, or sync after committing",
      details: reasons(conflicted),
    });
  }

  const unpublished = outcomes.filter((outcome) => outcome.pushed === false);
  if (unpublished.length > 0) {
    return new GroveError("refused", describe(unpublished, "not pushed"), {
      hint: "the rebase stands locally; look at what the remote gained, then sync again",
      details: unpublished.map((outcome) => `${outcome.dir}: ${outcome.pushRefusal ?? ""}`),
    });
  }

  if (skipped.length > 0) {
    return new GroveError("refused", describe(skipped, "skipped"), {
      details: reasons(skipped),
    });
  }

  return undefined;
}

/** Why each of these went the way it did, with any conflicting files indented under it. */
function reasons(outcomes: readonly SyncOutcome[]): string[] {
  return outcomes.flatMap((outcome) => [
    `${outcome.dir}: ${outcome.reason ?? ""}`,
    ...(outcome.conflicts ?? []).map((file) => `  ${file}`),
  ]);
}

function describe(outcomes: readonly SyncOutcome[], what: string): string {
  return outcomes.length === 1 && outcomes[0]
    ? `${outcomes[0].dir} ${what}`
    : `${outcomes.length} worktrees ${what}`;
}
