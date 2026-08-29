import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "../../ui/e2e-utils.ts";
import { pathExists } from "../fs.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove remove` against a real repository.
 *
 * The refusals are the command — git already declines a dirty tree — so most of
 * what is asserted here is that the directory is still on disk afterwards, not
 * merely that the exit code was unhappy.
 */

/** Exit codes from `cli/exit-codes.ts`, spelled out so a change to them is loud. */
const REFUSED = 4;

/** The cheapest managed repository: a clone of the fixture origin. */
async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);

  return join(repo.work, "origin");
}

/**
 * Records `.grove.toml`'s contents as trusted, the way `--trust` would.
 *
 * Written here rather than by running `grove add --trust` so the fixture says
 * what it means: teardown commands run only for a fingerprint git config has
 * seen, and that is the whole of the precondition.
 */
async function trustSetupFile(root: string, contents: string): Promise<void> {
  await Bun.write(join(root, "main", ".grove.toml"), contents);
  await seedGit(join(root, ".bare"), [
    "config",
    "--replace-all",
    "grove.trusted",
    Bun.SHA256.hash(contents, "hex"),
  ]);
}

describe("grove remove", () => {
  test("takes a branch name, a directory name, or a path, and clears the folders they left", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      // A branch whose directory is not spelled the same as the branch, so
      // "resolved by branch" and "resolved by directory" are distinguishable.
      for (const branch of ["fix/bug#7", "chore/tidy@up", "solo"]) {
        expect((await runCli(["add", branch], { cwd: root })).exitCode).toBe(0);
      }

      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(true);
      expect(await pathExists(join(root, "chore", "tidy-up"))).toBe(true);

      const byBranch = await runCli(["remove", "fix/bug#7"], { cwd: root });
      const byDir = await runCli(["remove", "chore/tidy-up"], { cwd: root });
      const byPath = await runCli(["remove", join(root, "solo")], { cwd: root });

      expect([byBranch.exitCode, byDir.exitCode, byPath.exitCode]).toEqual([0, 0, 0]);

      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(false);
      expect(await pathExists(join(root, "chore", "tidy-up"))).toBe(false);
      expect(await pathExists(join(root, "solo"))).toBe(false);

      // The point of the nesting: the empty folder the branch name created goes
      // with the last worktree under it.
      expect(await pathExists(join(root, "fix"))).toBe(false);
      expect(await pathExists(join(root, "chore"))).toBe(false);

      // The branches themselves are kept — only the directories were asked for.
      const branches = await probeGit(join(root, ".bare"), ["branch", "--list"]);
      expect(branches.stdout).toContain("fix/bug#7");
    });
  });

  test("refuses a worktree with uncommitted changes until --force", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "feat", "login");
      await Bun.write(join(worktree, "login.txt"), "edited\n");

      const refused = await runCli(["remove", "feat/login"], { cwd: root });
      expect(refused.exitCode).toBe(REFUSED);
      expect(refused.stderr).toContain("uncommitted changes");
      expect(await pathExists(worktree)).toBe(true);

      const forced = await runCli(["remove", "feat/login", "--force"], { cwd: root });
      expect(forced.exitCode).toBe(0);
      expect(await pathExists(worktree)).toBe(false);
    });
  });

  test("refuses the directory you are standing in, and the default branch's worktree", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "feat", "login");
      const standing = await runCli(["remove", "feat/login"], { cwd: worktree });
      expect(standing.exitCode).toBe(REFUSED);
      expect(standing.stderr).toContain("you are inside");
      expect(await pathExists(worktree)).toBe(true);

      // Not overridable by --force either, unlike the trunk below.
      const forcedStanding = await runCli(["remove", "feat/login", "--force"], { cwd: worktree });
      expect(forcedStanding.exitCode).toBe(REFUSED);
      expect(await pathExists(worktree)).toBe(true);

      const trunk = await runCli(["remove", "main"], { cwd: root });
      expect(trunk.exitCode).toBe(REFUSED);
      expect(trunk.stderr).toContain("everything else syncs onto");
      expect(await pathExists(join(root, "main"))).toBe(true);
    });
  });

  test("--delete-branch takes the branch with the directory", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);

      const removed = await runCli(["remove", "feat/login", "--delete-branch"], { cwd: root });
      expect(removed.exitCode).toBe(0);

      const branches = await probeGit(join(root, ".bare"), ["branch", "--list"]);
      expect(branches.stdout).not.toContain("feat/login");
      expect(await pathExists(join(root, "feat"))).toBe(false);
    });
  });

  test("runs [teardown] inside the worktree first, skips it for --no-teardown, and removes anyway when it fails", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      // The marker is written outside the worktree on purpose: anything written
      // inside it would go with the directory and prove nothing about ordering.
      await trustSetupFile(
        root,
        [
          "[teardown]",
          `run = ['pwd > "$GROVE_ROOT/teardown-$GROVE_BRANCH"', 'test "$GROVE_BRANCH" != boom']`,
          "",
        ].join("\n"),
      );

      for (const branch of ["alpha", "quiet", "boom"]) {
        expect((await runCli(["add", branch], { cwd: root })).exitCode).toBe(0);
      }

      const alpha = await runCli(["remove", "alpha"], { cwd: root });
      expect(alpha.exitCode).toBe(0);
      // Ran, and ran in the worktree — which by then no longer exists.
      expect((await Bun.file(join(root, "teardown-alpha")).text()).trim()).toBe(
        join(root, "alpha"),
      );
      expect(await pathExists(join(root, "alpha"))).toBe(false);

      const quiet = await runCli(["remove", "quiet", "--no-teardown"], { cwd: root });
      expect(quiet.exitCode).toBe(0);
      expect(await pathExists(join(root, "teardown-quiet"))).toBe(false);
      expect(await pathExists(join(root, "quiet"))).toBe(false);

      const boom = await runCli(["remove", "boom"], { cwd: root });
      // Loud, but not fatal: the documented rule is that broken cleanup never
      // strands a directory somebody has finished with.
      expect(boom.exitCode).toBe(0);
      expect(boom.stderr).toContain("anyway");
      expect(await pathExists(join(root, "teardown-boom"))).toBe(true);
      expect(await pathExists(join(root, "boom"))).toBe(false);
    });
  });
});
