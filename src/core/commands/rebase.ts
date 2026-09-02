import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, fetchRemotes, localBranchExists, REMOTE, remoteRef } from "../branches.ts";
import { classifyGitError, GroveError, stderrDetails } from "../errors.ts";
import { gitOutput, gitSucceeds, runGit, runGitOrThrow } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { ancestry, readStack } from "../stack.ts";
import { plural } from "../text.ts";
import {
  isMidRebase,
  LISTED,
  listWorktrees,
  refuseMidRebase,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";

/**
 * `grove rebase` — move one worktree's branch onto a base you choose.
 *
 * `sync` decides the base for you — its own remote, then the trunk, then a
 * push — and that is the right answer on an ordinary morning. This is the
 * command for the other mornings: the branch should sit on `origin/develop`
 * for a while, or on the trunk without the push, or on whatever the remote
 * has of it and nothing else. The base is the whole of what is asked for, and
 * nothing here is pushed — `sync` is the command that publishes.
 *
 * The other thing it does that `sync` refuses to: it carries uncommitted
 * changes through. `sync` declines a dirty worktree because it is about to
 * push, and pushing over somebody's half-finished edit is not a thing to do
 * quietly. A rebase that goes nowhere but the local branch can afford to move
 * the edit out of the way and put it back — and the way it does that never
 * touches `refs/stash`, for the reason `core/take.ts` gives: every worktree in
 * the repository shares that one stack.
 *
 * The rule the whole file keeps: **the worktree ends up either rebased with the
 * changes back in it, or exactly as it was.** A rebase that stops on a
 * conflict is rolled back and the changes are restored; a rebase that went
 * through but whose changes then would not sit on top of it is rolled back too,
 * and the changes are restored onto the branch they were made on. `--no-abort`
 * is how to ask for the half-finished state instead, and the snapshot's sha is
 * named whenever the changes are not back where they were.
 */

/** Where the branch goes. `ref` is any branch or ref git can resolve. */
export type RebaseBase =
  | { readonly kind: "upstream" }
  | { readonly kind: "trunk" }
  | { readonly kind: "ref"; readonly ref: string };

export type RebaseOptions = {
  /** Which worktree. Omitted means the one you are standing in. */
  readonly target?: string;
  readonly base: RebaseBase;
  readonly fetch: boolean;
  /** Undo a conflicted rebase instead of leaving it to resolve by hand. */
  readonly abortOnConflict: boolean;
  /**
   * Move uncommitted changes out of the way and put them back afterwards.
   *
   * Off is `sync`'s answer — a dirty worktree is refused before anything runs
   * — for whoever would rather be told than have their edit moved about.
   */
  readonly carry: boolean;
};

/** The uncommitted changes that were moved out of the rebase's way. */
export type Carried = {
  /**
   * The snapshot commit, the same object `git stash push` would have stored.
   *
   * Referenced by nothing, so it is the one thing to write down: `git stash
   * apply <sha>` brings the changes back by hand whatever else happened.
   */
  readonly stash: string;
  /** How many tracked paths the snapshot carried. */
  readonly changes: number;
  /** Whether they are back in the working tree — as they were, on whatever HEAD now is. */
  readonly restored: boolean;
};

export type RebaseResult = {
  readonly path: string;
  /** The worktree's directory relative to the repo root, for messages. */
  readonly dir: string;
  readonly branch: string;
  /** The ref the branch was moved onto — `origin/main`, `origin/develop`, `feat/login`. */
  readonly onto: string;
  readonly kind: "up-to-date" | "rebased" | "conflicted";
  /** What conflicted, and what was done about it. Absent when nothing went wrong. */
  readonly reason?: string;
  readonly conflicts?: readonly string[];
  /**
   * For a conflict: whether the worktree was put back as it was.
   *
   * `false` is `--no-abort` — a rebase stopped part-way, or the rebased branch
   * with the changes conflicting on top of it — and is what makes the hint
   * talk about finishing rather than about starting again.
   */
  readonly rolledBack?: boolean;
  /** Absent when the worktree was clean, or held only untracked files. */
  readonly carried?: Carried;
};

/** One base the screen or the terminal can offer: what to call it, and the ref it is. */
export type RebaseChoice = {
  readonly base: RebaseBase;
  readonly ref: string;
  /** `upstream`, `parent`, `trunk`, or the branch's own name. */
  readonly label: string;
};

export type RebaseChoices = {
  readonly record: WorktreeRecord;
  readonly dir: string;
  readonly choices: readonly RebaseChoice[];
};

/**
 * The bases worth offering for one worktree, most likely first.
 *
 * Its own remote, because that is what "rebase" means to somebody who has
 * just been told the branch moved under them; the parent it was cut from, when
 * `grove add --on` wrote one down, because a stacked branch that goes anywhere
 * else is replayed over the absence of the work it sits on; the trunk as the
 * remote has it; and then every other worktree's branch, since a worktree is
 * what this screen's vocabulary is made of. The trunk's own worktree is left
 * out of that last group — `trunk` above already is that branch, measured
 * where `sync` measures it.
 *
 * Any other ref — `origin/develop`, a tag, a sha — is `--onto` on the command
 * line, which is where a name gets typed.
 */
export async function rebaseChoices(
  repo: RepoPaths,
  cwd: string,
  target?: string,
): Promise<RebaseChoices> {
  const worktrees = await listWorktrees(repo.gitDir);
  const record = chooseTarget(worktrees, repo.root, cwd, target);
  const dir = worktreeDir(repo.root, record.path);
  const trunk = await defaultBranch(repo.gitDir);
  const status = await statusOf(record.path);
  const choices: RebaseChoice[] = [];

  if (status.upstream !== undefined) {
    choices.push({ base: { kind: "upstream" }, ref: status.upstream, label: "upstream" });
  }

  const [parent] =
    record.branch === undefined ? [] : ancestry(await readStack(repo.gitDir), record.branch);
  if (parent !== undefined && parent !== trunk && (await localBranchExists(repo.gitDir, parent))) {
    choices.push({ base: { kind: "ref", ref: parent }, ref: parent, label: "parent" });
  }

  choices.push({ base: { kind: "trunk" }, ref: remoteRef(trunk), label: "trunk" });

  const offered = new Set(choices.map((choice) => choice.ref));
  const others = worktrees
    .filter(
      (other) =>
        other.branch !== undefined &&
        other.branch !== record.branch &&
        other.branch !== trunk &&
        !offered.has(other.branch),
    )
    .toSorted((a, b) =>
      worktreeDir(repo.root, a.path).localeCompare(worktreeDir(repo.root, b.path)),
    );
  for (const other of others) {
    const branch = other.branch as string;
    choices.push({ base: { kind: "ref", ref: branch }, ref: branch, label: branch });
  }

  return { record, dir, choices };
}

export async function rebaseWorktree(
  repo: RepoPaths,
  cwd: string,
  options: RebaseOptions,
  reporter: Reporter,
): Promise<RebaseResult> {
  const worktrees = await listWorktrees(repo.gitDir);
  const record = chooseTarget(worktrees, repo.root, cwd, options.target);
  const dir = worktreeDir(repo.root, record.path);

  // The same two refusals `sync` skips on, and for the same reasons — with
  // one target there is nobody else's row to report beside, so they are
  // thrown. Mid-rebase first, because a stopped rebase reads as detached.
  refuseMidRebase(record, dir);
  if (record.detached || record.branch === undefined) {
    throw new GroveError("refused", `${dir} is on a detached HEAD, so there is no branch to move`, {
      hint: "check a branch out there first",
    });
  }
  const branch = record.branch;

  // Read before the fetch, so a refusal about the working tree arrives
  // without a round trip in front of it.
  const status = await statusOf(record.path);
  if (status.dirty && !options.carry) {
    throw new GroveError("refused", `${dir} has uncommitted changes`, {
      hint: "commit them, or leave --no-stash off to carry them through the rebase",
      details: status.changed.slice(0, LISTED),
    });
  }

  // Before the base is resolved, not after: `--onto develop` may name a
  // branch only the remote has, and the fetch is what brings it here. Answered
  // rather than thrown, the way `prune` reads it — `.fetched` and nothing
  // else, since a stale tag changes no answer a rebase gives and `sync`
  // already owns the warning about it.
  if (options.fetch) {
    const step = reporter.step("fetching");
    if ((await fetchRemotes(repo.gitDir)).fetched) step.succeed("fetched");
    else step.fail("could not fetch — the base below is as it was last seen");
  }

  const onto = await resolveBase(
    repo,
    record.path,
    branch,
    status.upstream,
    options.base,
    reporter,
  );
  const identity = { path: record.path, dir, branch, onto };

  // Already sitting on it: nothing to replay, so nothing is moved out of the
  // way either. `--fork-point` could only ever drop commits the base has
  // withdrawn, and a base that is an ancestor of HEAD has withdrawn nothing.
  if (await gitSucceeds(["merge-base", "--is-ancestor", onto, "HEAD"], { cwd: record.path })) {
    reporter.info(`${dir} is already on ${onto}`);

    return { ...identity, kind: "up-to-date" };
  }

  const before = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });
  const step = reporter.step(`rebasing ${dir} onto ${onto}`);

  /**
   * The snapshot, and the tree emptied of what it holds.
   *
   * `git stash create` writes the commit and stores it nowhere — see the file
   * comment — and only tracked changes go into it. Untracked files stay where
   * they are: a rebase does not touch them unless it is about to write over
   * one, and that refusal arrives below as a rebase that never started.
   */
  let stash: string | undefined;
  const changes = status.changed.length - status.untracked.length;
  if (status.dirty) {
    stash = await snapshot(record.path);
    if (stash !== undefined) await runGitOrThrow(["reset", "--hard", "HEAD"], { cwd: record.path });
  }
  const carried = (restored: boolean): Pick<RebaseResult, "carried"> =>
    stash === undefined ? {} : { carried: { stash, changes, restored } };

  /**
   * `--fork-point` for the reason `sync` gives: a commit the base has since
   * withdrawn is dropped rather than replayed onto its own replacement. With
   * no fork point to be found — a base this branch was never on — git falls
   * back to the plain merge base, so nothing is worse than it was.
   */
  const rebase = await runGit(["rebase", "--fork-point", onto], { cwd: record.path });

  if (rebase.code !== 0) {
    // Refused before it began — an untracked file in the way, most often — so
    // there is no rebase to abort and no conflict to name. The changes go
    // back first, and git's own sentence is the error.
    if (!(await isMidRebase(record.path))) {
      const restored = stash === undefined ? true : await apply(record.path, stash);
      step.fail(`could not rebase ${dir}`);

      throw new GroveError(classifyGitError(rebase.stderr), `git rebase ${onto} failed in ${dir}`, {
        details: stderrDetails(rebase.stderr),
        hint: stash !== undefined && !restored ? recover(stash) : undefined,
      });
    }

    const conflicts = await conflictedPaths(record.path);
    step.fail(`${dir} conflicts with ${onto}`);

    if (!options.abortOnConflict) {
      return {
        ...identity,
        kind: "conflicted",
        reason: `rebase onto ${onto} conflicted and was left in place to resolve`,
        conflicts,
        rolledBack: false,
        ...carried(false),
      };
    }

    // The abort puts HEAD back where the snapshot was taken, so the changes
    // fit there exactly as they did before.
    await runGit(["rebase", "--abort"], { cwd: record.path });
    const restored = stash === undefined ? true : await apply(record.path, stash);

    return {
      ...identity,
      kind: "conflicted",
      reason: `rebase onto ${onto} conflicted and was rolled back`,
      conflicts,
      rolledBack: true,
      ...carried(restored),
    };
  }

  /**
   * The rebase stands; now the changes have to sit on it.
   *
   * The two are rarely on the same commit — that is what a rebase is — so this
   * is a three-way merge and can genuinely conflict. The default answer is
   * the same one a conflicted rebase gets: undo it. The branch is put back on
   * `before`, the changes are re-applied where they were made, and the person
   * is told what would not fit — because a worktree left holding conflict
   * markers over an edit they had not finished is the state this exists to
   * prevent. `--no-abort` keeps the rebase and the markers instead.
   */
  if (stash !== undefined && !(await apply(record.path, stash))) {
    const conflicts = await conflictedPaths(record.path);

    if (!options.abortOnConflict) {
      step.fail(`${dir} rebased, but its uncommitted changes conflict with it`);

      return {
        ...identity,
        kind: "rebased",
        reason:
          "the uncommitted changes conflict with the rebased branch and were left in place to resolve",
        conflicts,
        rolledBack: false,
        ...carried(false),
      };
    }

    await runGitOrThrow(["reset", "--hard", before], { cwd: record.path });
    const restored = await apply(record.path, stash);
    step.fail(`${dir}'s uncommitted changes do not fit on ${onto}`);

    return {
      ...identity,
      kind: "conflicted",
      reason: `the uncommitted changes did not apply on top of ${onto}, so the rebase was undone`,
      conflicts,
      rolledBack: true,
      ...carried(restored),
    };
  }

  const after = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });
  const moved = after !== before;
  const back = stash === undefined ? "" : `, ${plural(changes, "change")} back in place`;
  step.succeed(moved ? `${dir} rebased onto ${onto}${back}` : `${dir} already on ${onto}${back}`);

  return { ...identity, kind: moved ? "rebased" : "up-to-date", ...carried(true) };
}

/**
 * The worktree named, or the one being stood in.
 *
 * The same rule `sync` follows for one target: `resolveTarget` answers a name
 * by branch, directory, or path, and no name is the worktree containing the
 * shell — not a guess between two, which is why the empty case is a refusal.
 */
function chooseTarget(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  target: string | undefined,
): WorktreeRecord {
  const chosen =
    target === undefined
      ? worktrees.find((record) => contains(record.path, cwd))
      : resolveTarget(target, worktrees, { root, cwd });

  if (!chosen) {
    throw new GroveError("usage", "not inside a worktree, so there is nothing to rebase", {
      hint: "name one: grove rebase <branch>",
    });
  }

  return chosen;
}

/**
 * The ref a base means, checked to exist before anything is moved onto it.
 *
 * `upstream` is what the branch tracks, and a branch that tracks nothing has
 * no such thing — refused rather than guessed at as `origin/<branch>`, because
 * a branch nobody has pushed has no remote copy to be behind. `trunk` is the
 * default branch as the remote has it, the same ref `sync` rebases onto and
 * the list's trunk column counts against.
 *
 * A typed ref is taken as written when git can resolve it. When it cannot,
 * and the remote has a branch by that name, that is what was meant: `develop`
 * for a branch nobody here has checked out is `origin/develop`, and asking
 * for the prefix to be typed would be this tool knowing the answer and
 * withholding it. It is said out loud, since the step below names the ref.
 */
async function resolveBase(
  repo: RepoPaths,
  path: string,
  branch: string,
  upstream: string | undefined,
  base: RebaseBase,
  reporter: Reporter,
): Promise<string> {
  switch (base.kind) {
    case "upstream": {
      if (upstream === undefined) {
        throw new GroveError("refused", `${branch} tracks no remote branch`, {
          hint: "publish it first (grove sync --publish), or rebase --trunk or --onto <ref>",
        });
      }

      return upstream;
    }
    case "trunk":
      return remoteRef(await defaultBranch(repo.gitDir));
    case "ref": {
      const { ref } = base;
      if (await refExists(path, ref)) return ref;

      const remote = remoteRef(ref);
      if (!ref.startsWith(`${REMOTE}/`) && (await refExists(path, remote))) {
        reporter.info(`${ref} is not a branch here — using ${remote}`);

        return remote;
      }

      throw new GroveError("usage", `no branch or ref named ${JSON.stringify(ref)}`, {
        hint: `run \`git -C ${repo.gitDir} branch -a\` to see what there is`,
      });
    }
  }
}

/** Whether `ref` names a commit git can find from inside the worktree. */
function refExists(path: string, ref: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: path });
}

/**
 * The snapshot, or nothing when there is nothing to snapshot.
 *
 * Empty output is git's answer for a tree whose only changes are untracked
 * files — `stash create` does not take those — and it is an answer, not a
 * failure: the rebase runs with them in place.
 */
async function snapshot(path: string): Promise<string | undefined> {
  const result = await runGit(["stash", "create", "grove: carried through a rebase"], {
    cwd: path,
  });
  if (result.code !== 0) {
    throw new GroveError("git-failed", "could not snapshot the uncommitted changes", {
      hint: "commit them yourself, or rebase with --no-stash after stashing by hand",
      details: stderrDetails(result.stderr),
    });
  }

  const sha = result.stdout.trim();

  return sha.length === 0 ? undefined : sha;
}

/**
 * Puts a snapshot back, and says whether it landed cleanly.
 *
 * `--index` first, so a change that was staged comes back staged. git
 * declines that in two ways that have to be told apart: "conflicts in index"
 * is refused before the tree is touched, and a plain apply is the right
 * answer — everything arrives, unstaged, which is what `git stash pop` mostly
 * does anyway; a merge conflict leaves the tree conflicted, and a second
 * attempt would only conflict again over the markers the first one left.
 * Unmerged paths are what distinguish them.
 */
async function apply(path: string, stash: string): Promise<boolean> {
  const staged = await runGit(["stash", "apply", "--index", stash], { cwd: path });
  if (staged.code === 0) return true;
  if ((await conflictedPaths(path)).length > 0) return false;

  return (await runGit(["stash", "apply", stash], { cwd: path })).code === 0;
}

/** The files git stopped on — of a rebase, or of an apply — captured before anything is rolled back. */
async function conflictedPaths(path: string): Promise<readonly string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: path });
  if (result.code !== 0) return [];

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** The one line that recovers changes this command could not put back itself. */
function recover(stash: string): string {
  return `the uncommitted changes are saved as a commit: git stash apply ${stash}`;
}

/**
 * Turns the result into the one exit code the shell sees.
 *
 * A conflict is exit 5 whichever side it came from — the rebase itself, or
 * the changes going back on top of it — because both are a result that needs
 * a decision. What the hint says depends on what was left behind: nothing,
 * when the rebase was rolled back, and a worktree to finish in when it was
 * not. The snapshot's sha rides on the details whenever the changes are not
 * back in the tree, since that line is the whole of how they come back.
 */
export function failureFor(result: RebaseResult): GroveError | undefined {
  const { dir, carried } = result;
  const unrestored =
    carried !== undefined && !carried.restored ? [`${dir}: ${recover(carried.stash)}`] : [];
  const files = (result.conflicts ?? []).map((file) => `  ${file}`);

  if (result.kind === "conflicted") {
    return new GroveError("rebase-conflict", `${dir} conflicted`, {
      hint:
        result.rolledBack === true
          ? "nothing has changed — commit first, pick another base, or --no-abort to resolve it by hand"
          : `finish it in the worktree: git -C ${result.path} rebase --continue, or rebase --abort`,
      details: [`${dir}: ${result.reason ?? ""}`, ...files, ...unrestored],
    });
  }

  // `--no-abort`, and the rebase stands with the changes conflicting on top
  // of it: the branch moved, the tree needs a hand, and the sha says where
  // the changes are meanwhile.
  if (unrestored.length > 0) {
    return new GroveError(
      "rebase-conflict",
      `${dir} rebased, but its uncommitted changes conflict`,
      {
        hint: "resolve them in the worktree, or `git stash apply` the commit named below onto a clean tree",
        details: [`${dir}: ${result.reason ?? ""}`, ...files, ...unrestored],
      },
    );
  }

  return undefined;
}
