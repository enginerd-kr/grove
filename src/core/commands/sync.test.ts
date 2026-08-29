import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../ui/e2e-utils.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove sync` against a real origin.
 *
 * The origin is a real bare repository rather than a stub, because the half of
 * this command a local-only test would miss is the push: a rebase that is never
 * published is the exact failure the push was added for, and the only way to
 * tell the two apart is to ask the origin where its branch is.
 */

const REFUSED = 4;
const REBASE_CONFLICT = 5;

async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);

  return join(repo.work, "origin");
}

let scratchCount = 0;

/**
 * Somebody else's commit, made and pushed from outside the managed repository.
 *
 * A throwaway clone rather than a second worktree in the repo under test: the
 * point is that the origin moved on its own, and a commit made inside the tree
 * being synced would not be that.
 */
async function commitOnOrigin(
  repo: TempRepo,
  branch: string,
  file: string,
  contents: string,
): Promise<void> {
  scratchCount += 1;
  const scratch = join(repo.root, `elsewhere-${scratchCount}`);
  await seedGit(repo.root, ["clone", "--branch", branch, repo.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", `HEAD:${branch}`]);
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

describe("grove sync", () => {
  test("fast-forwards the default branch, and rebases then plainly pushes it when it has commits of its own", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      const main = join(root, "main");

      await commitOnOrigin(repo, "main", "remote-one.txt", "one\n");

      const forward = await runCli(["sync", "main"], { cwd: root });
      expect(forward.exitCode).toBe(0);
      expect(forward.stdout).toContain("fast-forwarded");
      expect(await Bun.file(join(main, "remote-one.txt")).text()).toBe("one\n");

      // Now both sides move: the local commit is somebody's work and is carried
      // over what the origin gained, rather than being a reason to refuse.
      await commitIn(main, "local.txt", "local\n");
      await commitOnOrigin(repo, "main", "remote-two.txt", "two\n");

      const rebased = await runCli(["sync", "main"], { cwd: root });
      expect(rebased.exitCode).toBe(0);
      expect(rebased.stdout).toContain("rebased");

      expect(await Bun.file(join(main, "remote-two.txt")).text()).toBe("two\n");
      expect(await Bun.file(join(main, "local.txt")).text()).toBe("local\n");
      // Pushed plainly, and the origin has exactly what the worktree has.
      expect(await head(repo.originPath, "main")).toBe(await head(main));
    });
  });

  test("rebases a branch onto its own remote first, and then onto the trunk", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "feat", "login");

      // A colleague's commit on the branch's own remote, work on the trunk, and
      // a commit of our own — the three the ordering has to reconcile.
      await commitOnOrigin(repo, "feat/login", "colleague.txt", "theirs\n");
      await commitOnOrigin(repo, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");

      const synced = await runCli(["sync", "feat/login"], { cwd: root });
      expect(synced.exitCode).toBe(0);
      expect(synced.stdout).toContain("rebased");

      // Nothing was left behind: the colleague's commit, the trunk's, and ours.
      for (const [file, contents] of [
        ["colleague.txt", "theirs\n"],
        ["trunk.txt", "trunk\n"],
        ["mine.txt", "mine\n"],
      ] as const) {
        expect(await Bun.file(join(worktree, file)).text()).toBe(contents);
      }

      // Ours on top, the colleague's under it, the trunk's under that — which
      // is what "its own remote first, then the trunk" means in commit order.
      const subjects = (await probeGit(worktree, ["log", "--format=%s", "-3"])).stdout;
      expect(subjects.split("\n").slice(0, 3)).toEqual([
        "Add mine.txt",
        "Add colleague.txt",
        "Add login",
      ]);
    });
  });

  // `--force-if-includes` reads the branch's reflog, which a bare clone would
  // not keep — `.bare` is made with `core.logallrefupdates` on so that the
  // lease-guarded push can be verified rather than refused out of hand.
  test("force-pushes the rebased branch back to its own remote", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "feat", "login");

      await commitOnOrigin(repo, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");
      const originBefore = await head(repo.originPath, "feat/login");

      const synced = await runCli(["sync", "feat/login"], { cwd: root });
      expect(synced.exitCode).toBe(0);

      // `--force-with-lease` rewrites the branch on the remote, so the origin
      // ends up holding exactly what the worktree does.
      const originAfter = await head(repo.originPath, "feat/login");
      expect(originAfter).not.toBe(originBefore);
      expect(originAfter).toBe(await head(worktree));
    });
  });

  test("stops on a dirty worktree without changing anything", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "feat", "login");

      await commitOnOrigin(repo, "main", "trunk.txt", "trunk\n");
      await Bun.write(join(worktree, "login.txt"), "half-finished\n");
      const before = await head(worktree);

      const synced = await runCli(["sync", "feat/login"], { cwd: root });
      expect(synced.exitCode).toBe(REFUSED);
      expect(synced.stderr).toContain("uncommitted changes");

      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("half-finished\n");
      expect((await probeGit(worktree, ["status", "--porcelain"])).stdout).toBe(" M login.txt\n");
    });
  });

  test("--all syncs every worktree", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      await commitOnOrigin(repo, "main", "trunk.txt", "trunk\n");

      const synced = await runCli(["sync", "--all"], { cwd: root });
      expect(synced.exitCode).toBe(0);

      const lines = synced.stdout.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(synced.stdout).toContain("main\tfast-forwarded");
      // The branch had nothing of its own to move, but it was visited: its
      // trunk drift closed, which is what "rebased" reports here.
      expect(synced.stdout).toContain("feat/login\t");
      expect(await Bun.file(join(root, "main", "trunk.txt")).text()).toBe("trunk\n");
      expect(await Bun.file(join(root, "feat", "login", "trunk.txt")).text()).toBe("trunk\n");
    });
  });

  test("--no-push leaves the rebase local and diverged from the remote", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "feat", "login");

      await commitOnOrigin(repo, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");
      const originBefore = await head(repo.originPath, "feat/login");

      const synced = await runCli(["sync", "feat/login", "--no-push"], { cwd: root });
      expect(synced.exitCode).toBe(0);
      expect(synced.stdout).toContain("rebased");

      // The rebase happened locally...
      expect(await Bun.file(join(worktree, "trunk.txt")).text()).toBe("trunk\n");
      // ...and the remote is exactly where it was, which is the divergence the
      // flag is named after.
      expect(await head(repo.originPath, "feat/login")).toBe(originBefore);
      expect(await head(worktree)).not.toBe(originBefore);
    });
  });

  test("aborts a conflicting rebase and exits 5, and --no-abort leaves it stopped part-way", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      // No upstream, so the only base is the trunk and the conflict is the
      // whole of what is being tested.
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "spike");

      // Both sides rewrite the fixture's single known line of app.txt.
      await commitIn(worktree, "app.txt", "mine\n");
      await commitOnOrigin(repo, "main", "app.txt", "theirs\n");
      const before = await head(worktree);

      const aborted = await runCli(["sync", "spike"], { cwd: root });
      expect(aborted.exitCode).toBe(REBASE_CONFLICT);
      expect(aborted.stderr).toContain("app.txt");

      // Rolled back: the worktree is where it was and there is no half-finished
      // rebase to clear up.
      expect(await isRebasing(worktree)).toBe(false);
      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("mine\n");

      const left = await runCli(["sync", "spike", "--no-abort"], { cwd: root });
      expect(left.exitCode).toBe(REBASE_CONFLICT);
      expect(left.stderr).toContain("left in place");
      expect(await isRebasing(worktree)).toBe(true);
      expect((await probeGit(worktree, ["status"])).stdout).toContain("rebase");
    });
  });
});
