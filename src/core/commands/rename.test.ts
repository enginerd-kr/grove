import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../fs.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove rename` against a real repository.
 *
 * The promise under test is that the branch and the directory are one thing:
 * every assertion here checks both, because a rename that moved only one of
 * them is precisely the state the command exists to prevent.
 */

const USAGE = 2;
const REFUSED = 4;
const STATE_CONFLICT = 6;
const GIT_FAILED = 7;

/** The half of `RenameResult` these tests read back. */
type RenameJson = {
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly dir: string;
  readonly moved: boolean;
  readonly pushed: boolean;
  readonly upstreamNote?: string;
  readonly standingInOldPath: boolean;
};

async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);

  return join(repo.work, "origin");
}

/** What a local branch tracks, or the empty string. */
async function upstreamOf(root: string, branch: string): Promise<string> {
  const result = await probeGit(join(root, ".bare"), [
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  ]);

  return result.stdout.trim();
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
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/logn", "--push"], { cwd: root })).exitCode).toBe(0);
      expect(await upstreamOf(root, "feat/logn")).toBe("origin/feat/logn");

      // Renamed out of `feat/` entirely, so the folder the old name created has
      // nothing left under it.
      const renamed = await runCli(["rename", "feat/logn", "signin"], { cwd: root });
      expect(renamed.exitCode).toBe(0);

      expect(await pathExists(join(root, "signin"))).toBe(true);
      expect(await pathExists(join(root, "feat", "logn"))).toBe(false);
      expect(await pathExists(join(root, "feat"))).toBe(false);

      const branches = await probeGit(join(root, ".bare"), [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ]);
      expect(branches.stdout).toContain("signin");
      expect(branches.stdout).not.toContain("feat/logn");

      // The one thing a rename deliberately leaves alone, said out loud rather
      // than left to be discovered.
      expect(await upstreamOf(root, "signin")).toBe("origin/feat/logn");
      expect(renamed.stderr).toContain("still tracking origin/feat/logn");

      // And the remote still has the old name, because nothing pushed the new one.
      const remote = await originBranches(repo.originPath);
      expect(remote).toContain("feat/logn");
      expect(remote).not.toContain("signin");
    });
  });

  test("--push publishes the new name and makes it the upstream", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/logn", "--push"], { cwd: root })).exitCode).toBe(0);

      const renamed = await runCli(["rename", "feat/logn", "feat/signin", "--push"], { cwd: root });
      expect(renamed.exitCode).toBe(0);

      expect(await pathExists(join(root, "feat", "signin"))).toBe(true);
      expect(await pathExists(join(root, "feat", "logn"))).toBe(false);

      expect(await originBranches(repo.originPath)).toContain("feat/signin");
      expect(await upstreamOf(root, "feat/signin")).toBe("origin/feat/signin");
      // Nothing here deletes the old branch on the remote: that is somebody
      // else's checkout, and a local rename does not get to decide about it.
      expect(await originBranches(repo.originPath)).toContain("feat/logn");
    });
  });

  test("refuses a name that is taken, and the default branch until --force", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);

      const taken = await runCli(["rename", "feat/login", "main"], { cwd: root });
      expect(taken.exitCode).toBe(STATE_CONFLICT);
      expect(taken.stderr).toContain("already exists");
      // Nothing moved: the refusal happens before the branch is touched.
      expect(await pathExists(join(root, "feat", "login"))).toBe(true);
      expect(await upstreamOf(root, "feat/login")).toBe("origin/feat/login");

      const trunk = await runCli(["rename", "main", "trunk"], { cwd: root });
      expect(trunk.exitCode).toBe(REFUSED);
      expect(trunk.stderr).toContain("everything else syncs onto");
      expect(await pathExists(join(root, "main"))).toBe(true);

      const forced = await runCli(["rename", "main", "trunk", "--force"], { cwd: root });
      expect(forced.exitCode).toBe(0);
      expect(await pathExists(join(root, "trunk"))).toBe(true);
      expect(await pathExists(join(root, "main"))).toBe(false);
    });
  });

  test("a nested new name makes the folders it needs, and the old name's are cleared", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "a/b/c"], { cwd: root })).exitCode).toBe(0);

      // Neither `x/` nor `x/y/` has ever existed here, and `git worktree move`
      // will not create the directory above its destination.
      const renamed = await runCli(["rename", "a/b/c", "x/y/z", "--json"], { cwd: root });
      expect(renamed.exitCode).toBe(0);

      const parsed = JSON.parse(renamed.stdout) as RenameJson;
      expect([parsed.from, parsed.to, parsed.dir, parsed.moved]).toEqual([
        "a/b/c",
        "x/y/z",
        "x/y/z",
        true,
      ]);
      expect(await Bun.file(join(root, "x", "y", "z", "app.txt")).text()).toBe("one\n");

      // Several levels deep, and every level the old name created goes with it.
      expect(await pathExists(join(root, "a"))).toBe(false);

      // Nothing pushed it, so there is no upstream to be inconsistent about and
      // nothing to say — the note is for a branch that really does track something.
      expect(parsed.upstreamNote).toBeUndefined();
      expect(renamed.stderr).not.toContain("still tracking");
    });
  });

  test("a dirty worktree moves with its changes intact", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "solo"], { cwd: root })).exitCode).toBe(0);

      const before = join(root, "solo");
      await Bun.write(join(before, "app.txt"), "edited\n");
      await Bun.write(join(before, "scratch.txt"), "scratch\n");

      // A rename is not a reset: nothing here is a reason to refuse, and
      // nothing here is a reason to throw work away either.
      const renamed = await runCli(["rename", "solo", "moved"], { cwd: root });
      expect(renamed.exitCode).toBe(0);

      const after = join(root, "moved");
      expect(await Bun.file(join(after, "app.txt")).text()).toBe("edited\n");
      expect(await Bun.file(join(after, "scratch.txt")).text()).toBe("scratch\n");
      expect((await probeGit(after, ["status", "--porcelain"])).stdout).toBe(
        " M app.txt\n?? scratch.txt\n",
      );
      expect(await pathExists(before)).toBe(false);
    });
  });

  test("--push onto a name the remote already carries, fast-forward and not", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      // The remote already has `ahead-name`, sitting where main sits.
      await seedGit(repo.originPath, ["branch", "ahead-name", "main"]);
      expect((await runCli(["add", "ff"], { cwd: root })).exitCode).toBe(0);
      await commit(join(root, "ff"), "ff");

      const forward = await runCli(["rename", "ff", "ahead-name", "--push", "--json"], {
        cwd: root,
      });
      expect(forward.exitCode).toBe(0);

      const parsed = JSON.parse(forward.stdout) as RenameJson;
      expect(parsed.pushed).toBe(true);
      // Pushed onto the branch that was already there, and now tracking it —
      // so there is nothing left to warn about.
      expect(parsed.upstreamNote).toBeUndefined();
      expect(await upstreamOf(root, "ahead-name")).toBe("origin/ahead-name");
      expect(
        (await probeGit(repo.originPath, ["log", "--oneline", "-1", "ahead-name"])).stdout,
      ).toContain("Add ff");

      // `feat/login` on the remote has a commit nothing local has, so this one
      // cannot fast-forward and git refuses it.
      expect((await runCli(["add", "mine"], { cwd: root })).exitCode).toBe(0);
      await commit(join(root, "mine"), "mine");

      const rejected = await runCli(["rename", "mine", "feat/login", "--push"], { cwd: root });

      expect(rejected.exitCode).toBe(GIT_FAILED);
      expect(rejected.stderr).toContain("renamed it, but pushing feat/login failed");
      // The rename landed and only the push did not, which is why the failure
      // says so rather than reading as though nothing happened.
      expect(await pathExists(join(root, "feat", "login"))).toBe(true);
      expect(await pathExists(join(root, "mine"))).toBe(false);
      expect(await Bun.file(join(root, "feat", "login", "mine.txt")).text()).toBe("mine\n");
      // And the remote is untouched: it still has the branch it had.
      expect(
        (await probeGit(repo.originPath, ["log", "--oneline", "-1", "feat/login"])).stdout,
      ).toContain("Add login");
    });
  });

  test("refuses its own name, a directory in the way, a nesting name, and a detached head", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "fix/bug#7"], { cwd: root })).exitCode).toBe(0);

      const same = await runCli(["rename", "fix/bug#7", "fix/bug#7"], { cwd: root });
      expect(same.exitCode).toBe(USAGE);
      expect(same.stderr).toContain("is already its name");

      // The name it would slug to is the directory it is already in. Refused on
      // the directory rather than renamed in place, which is why `moved: false`
      // never actually happens.
      const inPlace = await runCli(["rename", "fix/bug#7", "fix/bug-7"], { cwd: root });
      expect(inPlace.exitCode).toBe(STATE_CONFLICT);
      expect(inPlace.stderr).toContain("fix/bug-7 already exists");

      // A directory nobody made a worktree of still counts: the branch and the
      // disk can disagree, and this is the half git would not have noticed.
      await mkdir(join(root, "occupied"), { recursive: true });
      const occupied = await runCli(["rename", "fix/bug#7", "occupied"], { cwd: root });
      expect(occupied.exitCode).toBe(STATE_CONFLICT);
      expect(occupied.stderr).toContain("occupied already exists");

      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      const nested = await runCli(["rename", "fix/bug#7", "feat/login/deeper"], { cwd: root });
      expect(nested.exitCode).toBe(STATE_CONFLICT);
      expect(nested.stderr).toContain("that would nest with the worktree at feat/login");

      // Every refusal happens before `git branch -m`, so the branch is still there.
      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(true);
      const branches = await probeGit(join(root, ".bare"), [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ]);
      expect(branches.stdout).toContain("fix/bug#7");

      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);
      await seedGit(join(root, "spike"), ["checkout", "--detach", "HEAD"]);
      const detached = await runCli(["rename", "spike", "attached"], { cwd: root });
      expect(detached.exitCode).toBe(REFUSED);
      expect(detached.stderr).toContain("spike has no branch to rename");
      expect(await pathExists(join(root, "spike"))).toBe(true);
    });
  });

  test("renaming the directory you are standing in says where it went", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "solo"], { cwd: root })).exitCode).toBe(0);

      // The shell follows the directory by inode, so nothing breaks and `pwd`
      // quietly starts naming a path that no longer exists.
      const renamed = await runCli(["rename", "solo", "elsewhere"], { cwd: join(root, "solo") });

      expect(renamed.exitCode).toBe(0);
      expect(renamed.stderr).toContain('cd "$(grove path elsewhere)"');
      // Printed relative to where the shell is, which is no longer inside it.
      expect(renamed.stdout.trim()).toBe("../elsewhere\telsewhere");
      expect(await pathExists(join(root, "elsewhere"))).toBe(true);
    });
  });

  test("--json reports standing in the old path as a fact, not as the sentence", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "solo"], { cwd: root })).exitCode).toBe(0);

      const inside = await runCli(["rename", "solo", "elsewhere", "--json"], {
        cwd: join(root, "solo"),
      });
      expect(inside.exitCode).toBe(0);

      const parsed = JSON.parse(inside.stdout) as RenameJson;
      expect(parsed.standingInOldPath).toBe(true);
      // The document is for programs: the `cd` line still goes to the person on
      // stderr, and the shell command it contains is nowhere inside the JSON.
      expect(inside.stdout).not.toContain("grove path");
      expect(inside.stderr).toContain('cd "$(grove path elsewhere)"');

      // Present and false from anywhere else, rather than an absent field —
      // "you are not standing in it" is an answer worth being able to read.
      const outside = await runCli(["rename", "elsewhere", "back", "--json"], { cwd: root });
      expect(outside.exitCode).toBe(0);
      expect((JSON.parse(outside.stdout) as RenameJson).standingInOldPath).toBe(false);
      expect(outside.stderr).not.toContain("still standing");
    });
  });
});
