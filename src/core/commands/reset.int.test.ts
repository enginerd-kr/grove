import { expect, test } from "bun:test";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import type { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { gitOutput } from "../git.ts";
import { type RepoPaths, repoPaths } from "../layout.ts";
import { seedGit, withTempRepo } from "../test-utils.ts";
import { statusOf } from "../worktrees.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { resetWorktree } from "./reset.ts";

/**
 * `reset` against real git, because what it does is destroy files and no stub
 * can vouch for that having happened. Every assertion here is about the disk.
 */

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<GroveError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as GroveError;
}

async function withRepo(body: (repo: RepoPaths, work: string) => Promise<void>): Promise<void> {
  await withTempRepo(async ({ work, originUrl }) => {
    const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
    const repo = repoPaths(root);
    await addWorktree(
      repo,
      { branch: "feat/login", fetch: true, push: false, setup: true, trust: false },
      silent(),
    );

    await body(repo, work);
  });
}

onPosix(
  "throws away changes to tracked files and leaves the commits alone",
  async () => {
    await withRepo(async (repo) => {
      const worktree = join(repo.root, "feat/login");
      const before = await gitOutput(["rev-parse", "HEAD"], { cwd: worktree });

      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "login.txt"), "also edited\n");
      expect((await statusOf(worktree)).dirty).toBe(true);

      const result = await resetWorktree(
        repo,
        repo.root,
        { target: "feat/login", clean: false },
        silent(),
      );

      expect(result.changed).toBe(2);
      expect(result.discarded.toSorted()).toEqual(["app.txt", "login.txt"]);
      expect((await statusOf(worktree)).dirty).toBe(false);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("one\n");
      // The branch has not moved: this discards changes, it does not rewind.
      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: worktree })).toBe(before);
    });
  },
  60_000,
);

// The difference people are caught by: `git reset --hard` is about tracked
// files, so a worktree can come out of one still dirty.
onPosix(
  "leaves untracked files alone, and says that it did",
  async () => {
    await withRepo(async (repo) => {
      const worktree = join(repo.root, "feat/login");
      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "mine\n");

      const result = await resetWorktree(
        repo,
        repo.root,
        { target: "feat/login", clean: false },
        silent(),
      );

      expect(result.untracked).toBe(1);
      expect(result.cleaned).toBe(false);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
      // Still dirty afterwards, which is exactly why the result mentions it.
      expect((await statusOf(worktree)).dirty).toBe(true);
    });
  },
  60_000,
);

onPosix(
  "--clean takes the untracked files too",
  async () => {
    await withRepo(async (repo) => {
      const worktree = join(repo.root, "feat/login");
      await Bun.write(join(worktree, "scratch.txt"), "mine\n");
      await Bun.write(join(worktree, "build/out.js"), "built\n");

      const result = await resetWorktree(
        repo,
        repo.root,
        { target: "feat/login", clean: true },
        silent(),
      );

      expect(result.untracked).toBe(2);
      expect(result.cleaned).toBe(true);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(false);
      // `-d` rather than `-f` alone: a build output tree is the usual reason a
      // reset leaves a worktree dirty, and it is never one file.
      expect(await pathExists(join(worktree, "build"))).toBe(false);
      expect((await statusOf(worktree)).dirty).toBe(false);
    });
  },
  60_000,
);

onPosix(
  "--to drops commits as well, which the default does not",
  async () => {
    await withRepo(async (repo) => {
      const worktree = join(repo.root, "feat/login");
      const before = await gitOutput(["rev-parse", "HEAD"], { cwd: worktree });

      await Bun.write(join(worktree, "extra.txt"), "extra\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Extra"]);
      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: worktree })).not.toBe(before);

      await resetWorktree(
        repo,
        repo.root,
        { target: "feat/login", to: before, clean: false },
        silent(),
      );

      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: worktree })).toBe(before);
      expect(await pathExists(join(worktree, "extra.txt"))).toBe(false);
    });
  },
  60_000,
);

// The one refusal. A stopped rebase has commits half-applied and a HEAD of its
// own; resetting through that abandons them somewhere only the reflog knows.
onPosix(
  "refuses a worktree in the middle of a rebase",
  async () => {
    await withRepo(async (repo) => {
      const worktree = join(repo.root, "feat/login");
      const main = join(repo.root, "main");

      // Conflict the same line from both sides, then start a rebase that stops.
      await Bun.write(join(main, "app.txt"), "from main\n");
      await seedGit(main, ["add", "-A"]);
      await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Main edit"]);
      await Bun.write(join(worktree, "app.txt"), "from login\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Login edit"]);

      await Bun.$`git -C ${worktree} rebase main`.quiet().nothrow();

      const error = await expectError(
        resetWorktree(repo, repo.root, { target: "feat/login", clean: false }, silent()),
      );

      expect(error.code).toBe("refused");
      expect(error.message).toContain("rebase");
    });
  },
  60_000,
);

onPosix(
  "a clean worktree resets to nothing rather than failing",
  async () => {
    await withRepo(async (repo) => {
      const result = await resetWorktree(
        repo,
        repo.root,
        { target: "feat/login", clean: false },
        silent(),
      );

      expect(result.changed).toBe(0);
      expect(result.discarded).toEqual([]);
    });
  },
  60_000,
);
