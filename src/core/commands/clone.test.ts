import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../ui/e2e-utils.ts";
import { probeGit, withTempRepo } from "../test-utils.ts";

/**
 * `clone` is the command with the most to get wrong that nothing else would
 * notice: the refspec a bare clone declines to write, the `.git` pointer, the
 * upstream, the branches nobody asked for. Each one surfaces as a *later*
 * command failing, so each one is asserted here.
 */

type CloneJson = {
  readonly root: string;
  readonly gitDir: string;
  readonly defaultBranch: string;
  readonly branch: string;
  readonly worktree: string;
};

/** The branch names that exist locally, which a fresh clone keeps to one. */
async function localBranches(gitDir: string): Promise<readonly string[]> {
  const result = await probeGit(gitDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("grove clone", () => {
  test("lays out .bare, a .git pointer, and a worktree for the default branch", async () => {
    await withTempRepo(async (repo) => {
      const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });

      expect(result.exitCode).toBe(ExitCode.ok);
      // The row is the path and the branch, tab separated, on stdout.
      expect(result.stdout).toBe("app/main\tmain\n");

      const root = join(repo.work, "app");
      const bare = join(root, ".bare");

      expect(await Bun.file(join(bare, "HEAD")).exists()).toBe(true);
      // Relative, so the whole folder can be moved without breaking git.
      expect(await Bun.file(join(root, ".git")).text()).toBe("gitdir: ./.bare\n");

      // The worktree is a real checkout of main, not an empty directory.
      expect(await Bun.file(join(root, "main", "README.md")).text()).toBe("# fixture\n");
      expect(await Bun.file(join(root, "main", "app.txt")).text()).toBe("one\n");

      // The refspec `git clone --bare` will not write, without which
      // `origin/*` never appears and every later command fails elsewhere.
      expect((await probeGit(bare, ["config", "--get", "remote.origin.fetch"])).stdout.trim()).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );
      expect(
        (await probeGit(bare, ["rev-parse", "--verify", "refs/remotes/origin/main"])).code,
      ).toBe(0);
      expect(
        (await probeGit(bare, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout,
      ).toBe("origin/main\n");

      // HEAD follows the branch that got the worktree.
      expect((await probeGit(bare, ["symbolic-ref", "HEAD"])).stdout).toBe("refs/heads/main\n");
      // With an upstream, so `git status` and a bare `git push` both work.
      expect(
        (await probeGit(join(root, "main"), ["rev-parse", "--abbrev-ref", "main@{upstream}"]))
          .stdout,
      ).toBe("origin/main\n");

      // A bare clone imports every remote branch; only the checked-out one stays.
      expect(await localBranches(bare)).toEqual(["main"]);
    });
  }, 30_000);

  test("names the directory after the URL when no directory is given", async () => {
    await withTempRepo(async (repo) => {
      // `origin.git` minus the suffix nobody wants in a working directory.
      const result = await runCli(["clone", repo.originUrl], { cwd: repo.work });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(await Bun.file(join(repo.work, "origin", ".bare", "HEAD")).exists()).toBe(true);
      expect(await Bun.file(join(repo.work, "origin", "main", "app.txt")).exists()).toBe(true);
    });
  }, 30_000);

  test("-b checks out another branch first, and only that one", async () => {
    await withTempRepo(async (repo) => {
      const result = await runCli(["clone", repo.originUrl, "app", "-b", "feat/login"], {
        cwd: repo.work,
      });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toBe("app/feat/login\tfeat/login\n");

      const root = join(repo.work, "app");

      // The branch's own shape on disk: `feat/login` is a directory inside `feat`.
      expect(await Bun.file(join(root, "feat", "login", "login.txt")).text()).toBe("login\n");
      expect(await Bun.file(join(root, "main", "app.txt")).exists()).toBe(false);
      expect(await localBranches(join(root, ".bare"))).toEqual(["feat/login"]);
      // The default branch is still reported as what the remote calls default.
      expect((await probeGit(join(root, ".bare"), ["symbolic-ref", "HEAD"])).stdout).toBe(
        "refs/heads/feat/login\n",
      );
    });
  }, 30_000);

  test("--json describes what was made", async () => {
    await withTempRepo(async (repo) => {
      const result = await runCli(["clone", repo.originUrl, "app", "--json"], {
        cwd: repo.work,
      });

      expect(result.exitCode).toBe(ExitCode.ok);

      const root = join(repo.work, "app");
      expect(JSON.parse(result.stdout) as CloneJson).toEqual({
        root,
        gitDir: join(root, ".bare"),
        defaultBranch: "main",
        branch: "main",
        worktree: join(root, "main"),
      });
    });
  }, 30_000);
});

describe("grove clone, when it cannot", () => {
  test("a URL that is not one is a usage error, before anything is spawned", async () => {
    await withTempRepo(async (repo) => {
      const result = await runCli(["clone", "not a url"], { cwd: repo.work });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("does not look like a repository URL");
    });
  }, 30_000);

  test("a remote that is not there reports the remote, and leaves nothing behind", async () => {
    await withTempRepo(async (repo) => {
      const missing = `file://${join(repo.root, "nothing.git")}`;
      const result = await runCli(["clone", missing, "app"], { cwd: repo.work });

      expect(result.exitCode).toBe(ExitCode.remote);
      // A partial `.bare` would make discovery find it and every later command
      // fail obscurely, so a failed clone cleans up after itself.
      expect(await Bun.file(join(repo.work, "app", ".bare", "HEAD")).exists()).toBe(false);
    });
  }, 30_000);

  test("a branch the remote does not have is a usage error, and rolls back", async () => {
    await withTempRepo(async (repo) => {
      const result = await runCli(["clone", repo.originUrl, "app", "--branch", "nope"], {
        cwd: repo.work,
      });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain('the remote has no branch named "nope"');
      expect(await Bun.file(join(repo.work, "app", ".bare", "HEAD")).exists()).toBe(false);
    });
  }, 30_000);

  test("a directory with something in it is refused rather than clobbered", async () => {
    await withTempRepo(async (repo) => {
      const root = join(repo.work, "app");
      await mkdir(root, { recursive: true });
      await Bun.write(join(root, "mine.txt"), "keep me\n");

      const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });

      expect(result.exitCode).toBe(ExitCode.stateConflict);
      expect(result.stderr).toContain("already exists and is not empty");
      expect(await Bun.file(join(root, "mine.txt")).text()).toBe("keep me\n");
    });
  }, 30_000);
});
