import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import type { GroveError } from "../errors.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  recorder,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import {
  failureFor,
  type RebaseBase,
  type RebaseResult,
  rebaseChoices,
  rebaseWorktree,
} from "./rebase.ts";

/**
 * `grove rebase` against a real origin.
 *
 * Called directly, with a recording reporter, for the reason `sync.test.ts`
 * gives: the repository is the part that has to be real, and the result is
 * where the claims live — which base was resolved, whether the changes came
 * back, and the sha that recovers them when they did not. The rows and the
 * exit code are `cli/run.ts`'s, and are in `rebase.e2e.test.ts`.
 *
 * The rule under test throughout: the worktree ends up either rebased with
 * the uncommitted changes back in it, or exactly as it was. Every conflict
 * case asserts both the outcome and the tree, because the outcome is only
 * worth anything if the tree agrees with it.
 */

let scratchCount = 0;

/** Somebody else's commit, pushed to `branch` on the origin from outside the repo under test. */
async function commitOnOrigin(
  temp: TempRepo,
  branch: string,
  file: string,
  contents: string,
): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", branch, temp.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", `HEAD:${branch}`]);
  await rm(scratch, { recursive: true, force: true });
}

/** A branch the origin has and nobody here has checked out, cut from `from` with one commit. */
async function branchOnOrigin(
  temp: TempRepo,
  from: string,
  branch: string,
  file: string,
): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", from, temp.originPath, scratch]);
  await seedGit(scratch, ["checkout", "-b", branch]);
  await Bun.write(join(scratch, file), `${file}\n`);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", branch]);
  await rm(scratch, { recursive: true, force: true });
}

async function commitIn(worktree: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(worktree, file), contents);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

async function head(cwd: string, ref = "HEAD"): Promise<string> {
  return (await probeGit(cwd, ["rev-parse", ref])).stdout.trim();
}

/** `git status --porcelain`, one entry per line, sorted so the order git picks is not under test. */
async function porcelain(worktree: string): Promise<readonly string[]> {
  return (await probeGit(worktree, ["status", "--porcelain"])).stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .toSorted();
}

/** True when a rebase is stopped part-way through in this worktree. */
async function isRebasing(worktree: string): Promise<boolean> {
  const state = await probeGit(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  ]);

  return state.code === 0 && (await Bun.file(join(state.stdout.trim(), "head-name")).exists());
}

/** The flags `cli/args.ts` hands `rebaseWorktree`, with its own defaults. */
type RebaseCall = {
  readonly target?: string;
  readonly base?: RebaseBase;
  readonly fetch?: boolean;
  readonly abortOnConflict?: boolean;
  readonly carry?: boolean;
  readonly cwd?: string;
};

const TRUNK: RebaseBase = { kind: "trunk" };

function attemptRebase(
  repo: RepoPaths,
  {
    target,
    base = TRUNK,
    fetch = true,
    abortOnConflict = true,
    carry = true,
    cwd = repo.root,
  }: RebaseCall = {},
): Promise<Attempt<RebaseResult>> {
  return attempt((reporter) =>
    rebaseWorktree(repo, cwd, { target, base, fetch, abortOnConflict, carry }, reporter),
  );
}

/** The error the result adds up to, insisting there is one — `failureFor` answers nothing for a clean run. */
function failure(result: RebaseResult): GroveError {
  const error = failureFor(result);
  if (error === undefined) {
    throw new Error("expected this result to add up to a failure, and it did not");
  }

  return error;
}

const SHA = /^[0-9a-f]{40}$/;

describe("grove rebase", () => {
  test("--trunk rebases onto origin/<default> and pushes nothing", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");
      const originBefore = await head(temp.originPath, "feat/login");

      const outcome = await attemptRebase(repo, { target: "feat/login" });
      const result = succeeded(outcome);

      // The whole result: no `carried`, because the tree was clean, and no
      // `reason` because nothing went wrong.
      expect(result).toEqual({
        path: worktree,
        dir: "feat/login",
        branch: "feat/login",
        onto: "origin/main",
        kind: "rebased",
      });
      expect(failureFor(result)).toBeUndefined();

      expect(await Bun.file(join(worktree, "trunk.txt")).text()).toBe("trunk\n");
      expect(await Bun.file(join(worktree, "mine.txt")).text()).toBe("mine\n");
      // The one thing this command never does: the origin's branch is where it was.
      expect(await head(temp.originPath, "feat/login")).toBe(originBefore);

      expect(outcome.log.err.join("")).toContain("✓ fetched");
      expect(outcome.log.err).toContain("✓ feat/login rebased onto origin/main\n");
      // Results are returned, never narrated: the row is `cli/run.ts`'s job.
      expect(outcome.log.out).toEqual([]);
    });
  });

  test("a branch already on its base is up to date, and nothing is touched", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");
      const before = await head(worktree);

      const outcome = await attemptRebase(repo, { target: "feat/login", fetch: false });

      expect(succeeded(outcome).kind).toBe("up-to-date");
      expect(await head(worktree)).toBe(before);
      // Said, not stepped: there was no work to open a step for.
      expect(outcome.log.err).toEqual(["· feat/login is already on origin/main\n"]);
    });
  });

  test("--upstream rebases onto the branch it tracks, and refuses a branch that tracks nothing", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "feat/login", "colleague.txt", "theirs\n");
      // The trunk moves too, and is not what was asked for: `--upstream` is
      // its own remote and nothing else.
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");

      const result = succeeded(
        await attemptRebase(repo, { target: "feat/login", base: { kind: "upstream" } }),
      );

      expect(result.kind).toBe("rebased");
      expect(result.onto).toBe("origin/feat/login");
      expect(await Bun.file(join(worktree, "colleague.txt")).text()).toBe("theirs\n");
      expect(await Bun.file(join(worktree, "trunk.txt")).exists()).toBe(false);

      // `grove add` without `--push`: a branch no remote has, so nothing to be
      // behind. Refused rather than guessed as `origin/spike`.
      await seedWorktree(repo, "spike");
      const error = refused(
        await attemptRebase(repo, { target: "spike", base: { kind: "upstream" } }),
      );

      expect(error.code).toBe("refused");
      expect(error.message).toBe("spike tracks no remote branch");
      expect(error.hint).toContain("--trunk");
    });
  });

  test("--onto takes a ref as written, reads a remote-only name as origin's, and refuses a name that is neither", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");
      await branchOnOrigin(temp, "main", "develop", "develop.txt");
      await commitIn(worktree, "mine.txt", "mine\n");

      // `develop` is on the origin and in no worktree here, which is the case
      // the flag exists for: the fetch brings it, and the name means it.
      const remote = await attemptRebase(repo, {
        target: "feat/login",
        base: { kind: "ref", ref: "develop" },
      });

      expect(succeeded(remote).onto).toBe("origin/develop");
      expect(remote.log.err).toContain("· develop is not a branch here — using origin/develop\n");
      expect(await Bun.file(join(worktree, "develop.txt")).exists()).toBe(true);

      // A local branch is taken as written: `main` here is the local trunk,
      // not `origin/main`.
      const local = succeeded(
        await attemptRebase(repo, { target: "feat/login", base: { kind: "ref", ref: "main" } }),
      );
      expect(local.onto).toBe("main");

      const missing = refused(
        await attemptRebase(repo, { target: "feat/login", base: { kind: "ref", ref: "nope" } }),
      );
      expect(missing.code).toBe("usage");
      expect(missing.message).toBe('no branch or ref named "nope"');
    });
  });

  test("uncommitted changes are carried through and put back as they were, staged and all", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      // Three kinds of dirt: a modified file, a staged new one, and an
      // untracked one. Only the first two go into the snapshot; the third
      // stays on disk throughout.
      await Bun.write(join(worktree, "login.txt"), "half-finished\n");
      await Bun.write(join(worktree, "staged.txt"), "staged\n");
      await seedGit(worktree, ["add", "staged.txt"]);
      await Bun.write(join(worktree, "notes.txt"), "untracked\n");

      const outcome = await attemptRebase(repo, { target: "feat/login" });
      const result = succeeded(outcome);

      expect(result.kind).toBe("rebased");
      expect(result.carried).toEqual({
        stash: expect.stringMatching(SHA),
        changes: 2,
        restored: true,
      });
      expect(failureFor(result)).toBeUndefined();
      expect(outcome.log.err).toContain(
        "✓ feat/login rebased onto origin/main, 2 changes back in place\n",
      );

      // The rebase happened and the tree is as it was left: the edit, the
      // staged file still staged, the untracked one untouched.
      expect(await Bun.file(join(worktree, "trunk.txt")).text()).toBe("trunk\n");
      expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("half-finished\n");
      expect(await Bun.file(join(worktree, "notes.txt")).text()).toBe("untracked\n");
      expect(await porcelain(worktree)).toEqual([" M login.txt", "?? notes.txt", "A  staged.txt"]);
      // And the snapshot is a real commit, reachable by the sha named.
      const snapshot = await probeGit(worktree, ["cat-file", "-t", result.carried?.stash ?? ""]);
      expect(snapshot.stdout.trim()).toBe("commit");
      // Nothing went near the stack every worktree shares.
      expect((await probeGit(worktree, ["stash", "list"])).stdout).toBe("");
    });
  });

  test("untracked files alone are not carried, because nothing has to be", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await Bun.write(join(worktree, "notes.txt"), "untracked\n");

      const result = succeeded(await attemptRebase(repo, { target: "feat/login" }));

      expect(result.kind).toBe("rebased");
      expect(result).not.toHaveProperty("carried");
      expect(await Bun.file(join(worktree, "notes.txt")).text()).toBe("untracked\n");
    });
  });

  test("--no-stash refuses a dirty worktree before anything runs", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");
      await Bun.write(join(worktree, "login.txt"), "half-finished\n");

      const outcome = await attemptRebase(repo, { target: "feat/login", carry: false });
      const error = refused(outcome);

      expect(error.code).toBe("refused");
      expect(error.message).toBe("feat/login has uncommitted changes");
      expect(error.details).toEqual(["login.txt"]);
      // Before the fetch: nothing was narrated at all.
      expect(outcome.log.err).toEqual([]);
      expect(await porcelain(worktree)).toEqual([" M login.txt"]);
    });
  });

  test("a conflicting rebase is rolled back with the changes restored, and --no-abort leaves it stopped with the sha named", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      // Both sides rewrite the fixture's single known line of app.txt, and
      // there is an unrelated edit open in the tree.
      await commitIn(worktree, "app.txt", "mine\n");
      await commitOnOrigin(temp, "main", "app.txt", "theirs\n");
      await Bun.write(join(worktree, "README.md"), "# edited\n");
      const before = await head(worktree);

      const rolled = await attemptRebase(repo, { target: "spike" });
      const rolledBack = succeeded(rolled);

      expect(rolledBack).toEqual({
        path: worktree,
        dir: "spike",
        branch: "spike",
        onto: "origin/main",
        kind: "conflicted",
        reason: "rebase onto origin/main conflicted and was rolled back",
        conflicts: ["app.txt"],
        rolledBack: true,
        carried: { stash: expect.stringMatching(SHA), changes: 1, restored: true },
      });
      expect(rolled.log.err.join("")).toContain("✗ spike conflicts with origin/main");

      const conflict = failure(rolledBack);
      expect(conflict.code).toBe("rebase-conflict");
      expect(errorToExitCode(conflict.code)).toBe(ExitCode.rebaseConflict);
      expect(conflict.message).toBe("spike conflicted");
      expect(conflict.hint).toContain("nothing has changed");
      expect(conflict.details).toEqual([
        "spike: rebase onto origin/main conflicted and was rolled back",
        "  app.txt",
      ]);

      // Exactly as it was: same HEAD, no rebase in progress, the edit back.
      expect(await isRebasing(worktree)).toBe(false);
      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("mine\n");
      expect(await porcelain(worktree)).toEqual([" M README.md"]);

      const left = await attemptRebase(repo, { target: "spike", abortOnConflict: false });
      const stopped = succeeded(left);

      // The same conflict and the same exit code; what differs is what is on
      // disk — a rebase to finish, and changes that could not go back yet.
      expect(stopped.kind).toBe("conflicted");
      expect(stopped.rolledBack).toBe(false);
      expect(stopped.reason).toBe(
        "rebase onto origin/main conflicted and was left in place to resolve",
      );
      expect(stopped.carried?.restored).toBe(false);
      expect(await isRebasing(worktree)).toBe(true);

      const stash = stopped.carried?.stash ?? "";
      const error = failure(stopped);
      expect(errorToExitCode(error.code)).toBe(ExitCode.rebaseConflict);
      expect(error.hint).toContain("rebase --continue");
      expect(error.details).toContain(
        `spike: the uncommitted changes are saved as a commit: git stash apply ${stash}`,
      );

      // And the sha named is the edit: applied by hand once the rebase is
      // out of the way, it comes back.
      await probeGit(worktree, ["rebase", "--abort"]);
      await probeGit(worktree, ["stash", "apply", stash]);
      expect(await Bun.file(join(worktree, "README.md")).text()).toBe("# edited\n");
    });
  });

  test("changes that will not sit on the rebased branch undo the rebase, unless --no-abort keeps it", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      // The commit rebases cleanly; it is the *uncommitted* edit that collides
      // with what the trunk did to the same line.
      await commitIn(worktree, "mine.txt", "mine\n");
      await commitOnOrigin(temp, "main", "app.txt", "theirs\n");
      await Bun.write(join(worktree, "app.txt"), "dirty\n");
      const before = await head(worktree);

      const undone = succeeded(await attemptRebase(repo, { target: "spike" }));

      expect(undone.kind).toBe("conflicted");
      expect(undone.rolledBack).toBe(true);
      expect(undone.reason).toBe(
        "the uncommitted changes did not apply on top of origin/main, so the rebase was undone",
      );
      expect(undone.conflicts).toEqual(["app.txt"]);
      expect(undone.carried?.restored).toBe(true);
      expect(errorToExitCode(failure(undone).code)).toBe(ExitCode.rebaseConflict);

      // Back on the old base with the edit in place — the rebase never
      // happened as far as the tree can tell.
      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("dirty\n");
      expect(await porcelain(worktree)).toEqual([" M app.txt"]);

      const kept = succeeded(
        await attemptRebase(repo, { target: "spike", abortOnConflict: false }),
      );

      // The branch moved and stays moved; the tree holds the conflict to
      // resolve, and the sha is how the edit is found again.
      expect(kept.kind).toBe("rebased");
      expect(kept.rolledBack).toBe(false);
      expect(kept.conflicts).toEqual(["app.txt"]);
      expect(kept.carried?.restored).toBe(false);
      expect(await head(worktree)).not.toBe(before);
      expect(await isRebasing(worktree)).toBe(false);
      expect((await probeGit(worktree, ["diff", "--name-only", "--diff-filter=U"])).stdout).toBe(
        "app.txt\n",
      );

      const error = failure(kept);
      expect(error.code).toBe("rebase-conflict");
      expect(error.message).toBe("spike rebased, but its uncommitted changes conflict");
      expect(error.details.join("\n")).toContain(`git stash apply ${kept.carried?.stash}`);
    });
  });

  test("a detached worktree has no branch to move", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");
      await seedGit(worktree, ["checkout", "--detach"]);

      const error = refused(await attemptRebase(repo, { target: "feat/login", cwd: worktree }));

      expect(error.code).toBe("refused");
      expect(error.message).toContain("detached HEAD");
    });
  });

  test("outside every worktree, with no target, there is nothing to rebase", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const error = refused(await attemptRebase(repo));

      expect(error.code).toBe("usage");
      expect(error.hint).toContain("grove rebase <branch>");
    });
  });
});

describe("rebaseChoices", () => {
  test("its remote, the trunk, then the other worktrees' branches — the trunk's own left out", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await seedWorktree(repo, "spike");

      const login = await rebaseChoices(repo, repo.root, "feat/login");
      expect(login.dir).toBe("feat/login");
      expect(login.choices).toEqual([
        { base: { kind: "upstream" }, ref: "origin/feat/login", label: "upstream" },
        { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
        { base: { kind: "ref", ref: "spike" }, ref: "spike", label: "spike" },
      ]);

      // No upstream, so no `upstream` row: the list starts at the trunk.
      const spike = await rebaseChoices(repo, repo.root, "spike");
      expect(spike.choices.map((choice) => choice.label)).toEqual(["trunk", "feat/login"]);

      // The trunk's worktree is asked about too, and gets what it tracks.
      const main = await rebaseChoices(repo, join(repo.root, "main"));
      expect(main.choices.map((choice) => choice.ref)).toEqual([
        "origin/main",
        "origin/main",
        "feat/login",
        "spike",
      ]);
    });
  });

  test("a stacked branch is offered its parent, ahead of the trunk and named as such", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      await addWorktree(
        repo,
        repo.root,
        {
          branch: "feat/b",
          on: "feat/a",
          fetch: false,
          push: false,
          setup: false,
          trust: false,
          take: false,
        },
        recorder().reporter,
      );

      const { choices } = await rebaseChoices(repo, repo.root, "feat/b");

      expect(choices).toEqual([
        { base: { kind: "ref", ref: "feat/a" }, ref: "feat/a", label: "parent" },
        { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
      ]);
    });
  });
});
