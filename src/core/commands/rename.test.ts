import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import { pathExists } from "../fs.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { type RenameResult, renameWorktree } from "./rename.ts";

/**
 * `grove rename` against a real repository.
 *
 * The promise under test is that the branch and the directory are one thing:
 * every assertion here checks both, because a rename that moved only one of
 * them is precisely the state the command exists to prevent.
 *
 * `renameWorktree` is called directly, with a hand-built `RepoPaths` and a
 * recording reporter, for the same reason `cli/run.test.ts` calls `runCommand`
 * that way: a real repository is the part that has to be real, and a process
 * around it buys nothing but latency. It also costs coverage — through the
 * binary the only evidence of a refusal is an exit code and a line of stderr,
 * and this command has two distinct checks that produce the *same* sentence
 * ("main already exists", once for the branch and once for the directory) and
 * differ only in the hint. Holding the `GroveError` is what tells them apart,
 * and holding the `RenameResult` is what turns "exit 0" into an assertion about
 * every field the command promises to return.
 *
 * What only the binary does — the `cd` sentence the CLI composes for somebody
 * standing in the directory that moved, the `--json` document, and the split
 * that keeps that sentence on stderr while the document has stdout to itself —
 * lives in `cli/run.ts`, not here, so a direct call could not see it at all.
 * `rename.e2e.test.ts` spawns a process for exactly that much and no more.
 */

type RenameCall = {
  readonly push?: boolean;
  readonly force?: boolean;
  /** Where the rename is asked from. Defaults to the repository root. */
  readonly cwd?: string;
};

/** Renames, and hands back whichever of the two outcomes happened. */
function attemptRename(
  repo: RepoPaths,
  target: string,
  to: string,
  { push = false, force = false, cwd = repo.root }: RenameCall = {},
): Promise<Attempt<RenameResult>> {
  return attempt((reporter) => renameWorktree(repo, cwd, { target, to, push, force }, reporter));
}

/** What a local branch tracks, or the empty string. */
async function upstreamOf(repo: RepoPaths, branch: string): Promise<string> {
  const result = await probeGit(repo.gitDir, [
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  ]);

  return result.stdout.trim();
}

/** The local branches, read back out of git rather than out of a result. */
async function localBranches(repo: RepoPaths): Promise<string> {
  const result = await probeGit(repo.gitDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);

  return result.stdout;
}

/** A commit on the worktree's branch, so a push has something to be rejected over. */
async function commit(worktree: string, name: string): Promise<void> {
  await Bun.write(join(worktree, `${name}.txt`), `${name}\n`);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${name}`]);
}

/** The branches the origin itself has — the remote's own answer, not a cached ref. */
async function originBranches(originPath: string): Promise<readonly string[]> {
  const result = await probeGit(originPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("grove rename", () => {
  test("moves the branch and its directory together, keeps the upstream, and clears the folder left behind", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/logn", { push: true });
      expect(await upstreamOf(repo, "feat/logn")).toBe("origin/feat/logn");

      // Renamed out of `feat/` entirely, so the folder the old name created has
      // nothing left under it.
      const outcome = await attemptRename(repo, "feat/logn", "signin");

      // The whole result, field by field — what "exit 0" was standing in for.
      expect(succeeded(outcome)).toEqual({
        from: "feat/logn",
        to: "signin",
        path: join(root, "signin"),
        dir: "signin",
        moved: true,
        pushed: false,
        // The one thing a rename deliberately leaves alone, said out loud rather
        // than left to be discovered — and said in full, including the two ways
        // out of it, which a `toContain` on stderr never checked were there.
        upstreamNote:
          "still tracking origin/feat/logn; `grove rename … --push` or `git push -u origin signin` moves it",
        standingInOldPath: false,
      });

      expect(await pathExists(join(root, "signin"))).toBe(true);
      expect(await pathExists(join(root, "feat", "logn"))).toBe(false);
      expect(await pathExists(join(root, "feat"))).toBe(false);

      const branches = await localBranches(repo);
      expect(branches).toContain("signin");
      expect(branches).not.toContain("feat/logn");

      expect(await upstreamOf(repo, "signin")).toBe("origin/feat/logn");

      // Two writes, and the transcript says both happened; a result never goes
      // through the reporter, so `out` stays empty however much is narrated.
      expect(outcome.log.err.join("")).toContain("✓ renamed feat/logn to signin");
      expect(outcome.log.err.join("")).toContain("✓ moved to signin");
      expect(outcome.log.out).toEqual([]);

      // And the remote still has the old name, because nothing pushed the new one.
      const remote = await originBranches(temp.originPath);
      expect(remote).toContain("feat/logn");
      expect(remote).not.toContain("signin");
    });
  });

  test("--push publishes the new name and makes it the upstream", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/logn", { push: true });

      const result = succeeded(
        await attemptRename(repo, "feat/logn", "feat/signin", { push: true }),
      );

      expect([result.moved, result.pushed]).toEqual([true, true]);
      // Pushed, so the branch tracks its own name and there is nothing left to
      // warn about — the note and the push are two halves of one decision.
      expect(result.upstreamNote).toBeUndefined();

      expect(await pathExists(join(root, "feat", "signin"))).toBe(true);
      expect(await pathExists(join(root, "feat", "logn"))).toBe(false);

      expect(await originBranches(temp.originPath)).toContain("feat/signin");
      expect(await upstreamOf(repo, "feat/signin")).toBe("origin/feat/signin");
      // Nothing here deletes the old branch on the remote: that is somebody
      // else's checkout, and a local rename does not get to decide about it.
      expect(await originBranches(temp.originPath)).toContain("feat/logn");
    });
  });

  test("refuses a name that is taken, and the default branch until --force", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const takenAttempt = await attemptRename(repo, "feat/login", "main");
      const taken = refused(takenAttempt);

      expect(taken.code).toBe("state-conflict");
      // The number a script branches on, composed the way `cli.tsx` composes it.
      expect(errorToExitCode(taken.code)).toBe(ExitCode.stateConflict);
      expect(taken.message).toBe("main already exists");
      // Which of the two "already exists" checks fired: this is the branch one.
      // The directory check produces the identical sentence, so the hint is the
      // only thing that distinguishes them — and stderr never showed it.
      expect(taken.hint).toBe("pick a name nothing here is using");
      // Nothing moved, and nothing was even begun: the refusal happens before
      // the first step is opened, let alone before the branch is touched.
      expect(takenAttempt.log.err).toEqual([]);
      expect(await pathExists(join(root, "feat", "login"))).toBe(true);
      expect(await upstreamOf(repo, "feat/login")).toBe("origin/feat/login");

      const trunk = refused(await attemptRename(repo, "main", "trunk"));

      expect(trunk.code).toBe("refused");
      expect(errorToExitCode(trunk.code)).toBe(ExitCode.refused);
      expect(trunk.message).toBe("main is the branch everything else syncs onto");
      // A refusal with no way past it would be a wall; the hint is the door.
      expect(trunk.hint).toContain("pass --force if you are sure");
      expect(await pathExists(join(root, "main"))).toBe(true);

      const forced = succeeded(await attemptRename(repo, "main", "trunk", { force: true }));

      expect([forced.from, forced.to, forced.moved]).toEqual(["main", "trunk", true]);
      expect(await pathExists(join(root, "trunk"))).toBe(true);
      expect(await pathExists(join(root, "main"))).toBe(false);
    });
  });

  test("a nested new name makes the folders it needs, and the old name's are cleared", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "a/b/c");

      // Neither `x/` nor `x/y/` has ever existed here, and `git worktree move`
      // will not create the directory above its destination.
      const outcome = await attemptRename(repo, "a/b/c", "x/y/z");
      const result = succeeded(outcome);

      expect([result.from, result.to, result.dir, result.moved]).toEqual([
        "a/b/c",
        "x/y/z",
        "x/y/z",
        true,
      ]);
      // `dir` is the row `grove list` prints; `path` is the absolute one, and
      // the two agreeing is what lets a caller use either.
      expect(result.path).toBe(join(root, "x", "y", "z"));
      expect(await Bun.file(join(root, "x", "y", "z", "app.txt")).text()).toBe("one\n");

      // Several levels deep, and every level the old name created goes with it.
      expect(await pathExists(join(root, "a"))).toBe(false);

      // Nothing pushed it, so there is no upstream to be inconsistent about and
      // nothing to say — the note is for a branch that really does track something.
      expect(result.upstreamNote).toBeUndefined();
      expect(outcome.log.err.join("")).not.toContain("still tracking");
    });
  });

  test("a dirty worktree moves with its changes intact", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "solo");

      const before = join(root, "solo");
      await Bun.write(join(before, "app.txt"), "edited\n");
      await Bun.write(join(before, "scratch.txt"), "scratch\n");

      // A rename is not a reset: nothing here is a reason to refuse, and
      // nothing here is a reason to throw work away either.
      const result = succeeded(await attemptRename(repo, "solo", "moved"));

      const after = join(root, "moved");
      expect(result.path).toBe(after);
      expect(await Bun.file(join(after, "app.txt")).text()).toBe("edited\n");
      expect(await Bun.file(join(after, "scratch.txt")).text()).toBe("scratch\n");
      expect((await probeGit(after, ["status", "--porcelain"])).stdout).toBe(
        " M app.txt\n?? scratch.txt\n",
      );
      expect(await pathExists(before)).toBe(false);
    });
  });

  test("--push onto a name the remote already carries, fast-forward and not", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // The remote already has `ahead-name`, sitting where main sits.
      await seedGit(temp.originPath, ["branch", "ahead-name", "main"]);
      await seedWorktree(repo, "ff");
      await commit(join(root, "ff"), "ff");

      const forward = succeeded(await attemptRename(repo, "ff", "ahead-name", { push: true }));

      expect(forward.pushed).toBe(true);
      // Pushed onto the branch that was already there, and now tracking it —
      // so there is nothing left to warn about.
      expect(forward.upstreamNote).toBeUndefined();
      expect(await upstreamOf(repo, "ahead-name")).toBe("origin/ahead-name");
      expect(
        (await probeGit(temp.originPath, ["log", "--oneline", "-1", "ahead-name"])).stdout,
      ).toContain("Add ff");

      // `feat/login` on the remote has a commit nothing local has, so this one
      // cannot fast-forward and git refuses it.
      await seedWorktree(repo, "mine");
      await commit(join(root, "mine"), "mine");

      const outcome = await attemptRename(repo, "mine", "feat/login", { push: true });
      const failure = refused(outcome);

      expect(failure.code).toBe("git-failed");
      expect(errorToExitCode(failure.code)).toBe(ExitCode.gitFailed);
      // git's own words, carried under our sentence. Through the binary these
      // were indistinguishable from the sentence itself; here it is provable
      // that the reason came from git and was not invented.
      expect(failure.details.join("\n")).toContain("rejected");
      // The step that failed says which half failed, which is the whole point
      // of the message: the rename landed and only the push did not.
      expect(outcome.log.err.join("")).toContain("✗ renamed it, but pushing feat/login failed");
      expect(outcome.log.err.join("")).toContain("✓ renamed mine to feat/login");

      expect(await pathExists(join(root, "feat", "login"))).toBe(true);
      expect(await pathExists(join(root, "mine"))).toBe(false);
      expect(await Bun.file(join(root, "feat", "login", "mine.txt")).text()).toBe("mine\n");
      // And the remote is untouched: it still has the branch it had.
      expect(
        (await probeGit(temp.originPath, ["log", "--oneline", "-1", "feat/login"])).stdout,
      ).toContain("Add login");
    });
  });

  test("refuses its own name, a directory in the way, a nesting name, and a detached head", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "fix/bug#7");

      const same = refused(await attemptRename(repo, "fix/bug#7", "fix/bug#7"));
      expect(same.code).toBe("usage");
      expect(errorToExitCode(same.code)).toBe(ExitCode.usage);
      expect(same.message).toBe("fix/bug#7 is already its name");
      expect(same.hint).toBe("pass the name you want it to have instead");

      // The name it would slug to is the directory it is already in. Refused on
      // the directory rather than renamed in place, which is why `moved: false`
      // never actually happens — and the hint is the proof of *which* check
      // said so, since the branch check would have printed the same sentence.
      const inPlace = refused(await attemptRename(repo, "fix/bug#7", "fix/bug-7"));
      expect(inPlace.code).toBe("state-conflict");
      expect(inPlace.message).toBe("fix/bug-7 already exists");
      expect(inPlace.hint).toBe("move or delete that directory first");

      // A directory nobody made a worktree of still counts: the branch and the
      // disk can disagree, and this is the half git would not have noticed.
      await mkdir(join(root, "occupied"), { recursive: true });
      const occupied = refused(await attemptRename(repo, "fix/bug#7", "occupied"));
      expect(occupied.code).toBe("state-conflict");
      expect(occupied.message).toBe("occupied already exists");
      expect(occupied.hint).toBe("move or delete that directory first");

      await seedWorktree(repo, "feat/login");
      const nested = refused(await attemptRename(repo, "fix/bug#7", "feat/login/deeper"));
      expect(nested.code).toBe("state-conflict");
      expect(nested.message).toBe("that would nest with the worktree at feat/login");
      expect(nested.hint).toContain("one worktree inside another");

      // Every refusal happens before `git branch -m`, so the branch is still there.
      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(true);
      expect(await localBranches(repo)).toContain("fix/bug#7");

      await seedWorktree(repo, "spike");
      await seedGit(join(root, "spike"), ["checkout", "--detach", "HEAD"]);

      const outcome = await attemptRename(repo, "spike", "attached");
      const detached = refused(outcome);
      expect(detached.code).toBe("refused");
      expect(errorToExitCode(detached.code)).toBe(ExitCode.refused);
      expect(detached.message).toBe("spike has no branch to rename");
      expect(detached.hint).toContain("check out a branch there first");
      // Not one of the four refusals narrated a step, which is the same fact as
      // "nothing had started yet" and cheaper to be sure of than a directory listing.
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(join(root, "spike"))).toBe(true);
    });
  });

  test("refuses a new name that differs from another worktree's only by case", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");
      await seedWorktree(repo, "feat/other");

      // `add` has always refused this pair; for a while `rename` did not, and the
      // asymmetry only ever showed up on Linux — where both directories can be
      // made, and the repository that results is one no macOS or Windows
      // checkout can reproduce. On a case-folding filesystem the branch check
      // happened to catch it first and say something else, which is why this
      // asserts the hint: it is the only thing that distinguishes the two.
      const collision = refused(await attemptRename(repo, "feat/other", "feat/Login"));
      expect(collision.code).toBe("state-conflict");
      expect(errorToExitCode(collision.code)).toBe(ExitCode.stateConflict);
      expect(collision.message).toBe("feat/login already exists here");
      expect(collision.hint).toBe(
        "directories differing only by case collide on macOS and Windows; pick a name that differs by more",
      );

      // Refused before `git branch -m`, so both branches keep the names they had.
      const branches = await localBranches(repo);
      expect(branches).toContain("feat/other");
      expect(branches).not.toContain("feat/Login");
      expect(await pathExists(join(root, "feat", "other"))).toBe(true);
    });
  });
});
