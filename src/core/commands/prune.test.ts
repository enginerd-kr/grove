import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../ui/e2e-utils.ts";
import { pathExists } from "../fs.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove prune` against a real origin.
 *
 * Both "finished" answers are built the way a forge leaves them — a branch
 * deleted on the remote, and a branch whose commits the trunk has — because the
 * two are found by different questions and a fixture that faked either would
 * pass while the real one did not.
 */

async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);

  return join(repo.work, "origin");
}

async function commitIn(worktree: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(worktree, file), contents);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

/** A branch with a commit of its own, pushed — the state a pull request starts in. */
async function proposed(root: string, branch: string, file: string): Promise<string> {
  expect((await runCli(["add", branch, "--push"], { cwd: root })).exitCode).toBe(0);
  const worktree = join(root, branch);
  await commitIn(worktree, file, `${file}\n`);
  await seedGit(worktree, ["push", "origin", `HEAD:${branch}`]);

  return worktree;
}

/** What a merged pull request with the delete box ticked leaves behind. */
async function deleteOnOrigin(repo: TempRepo, branch: string): Promise<void> {
  await seedGit(repo.originPath, ["branch", "-D", branch]);
}

let scratchCount = 0;

/** Lands a branch on the origin's trunk, the way a forge would. */
async function landOnOrigin(
  repo: TempRepo,
  branch: string,
  how: "merge" | "squash",
): Promise<void> {
  scratchCount += 1;
  const scratch = join(repo.root, `elsewhere-${scratchCount}`);
  await seedGit(repo.root, ["clone", "--branch", "main", repo.originPath, scratch]);

  if (how === "squash") {
    await seedGit(scratch, ["merge", "--squash", `origin/${branch}`]);
    await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Squash ${branch}`]);
  } else {
    await seedGit(scratch, [
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      "-m",
      `Merge ${branch}`,
      `origin/${branch}`,
    ]);
  }

  await seedGit(scratch, ["push", "origin", "HEAD:main"]);
  await rm(scratch, { recursive: true, force: true });
}

/** A commit pushed straight onto the origin's trunk, from outside the repo under test. */
async function commitOnOriginMain(repo: TempRepo, file: string, contents: string): Promise<void> {
  scratchCount += 1;
  const scratch = join(repo.root, `elsewhere-${scratchCount}`);
  await seedGit(repo.root, ["clone", "--branch", "main", repo.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Change ${file}`]);
  await seedGit(scratch, ["push", "origin", "HEAD:main"]);
  await rm(scratch, { recursive: true, force: true });
}

async function localBranches(root: string): Promise<readonly string[]> {
  const result = await probeGit(join(root, ".bare"), [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("grove prune", () => {
  test("finds both kinds of finished, narrows to one with --gone and --merged, and keeps the branches", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      const goneDir = await proposed(root, "shipped", "shipped.txt");
      await deleteOnOrigin(repo, "shipped");

      const mergedDir = await proposed(root, "landed", "landed.txt");
      await landOnOrigin(repo, "landed", "merge");

      const gone = await runCli(["prune", "--gone"], { cwd: root });
      expect(gone.exitCode).toBe(0);
      expect(gone.stdout).toContain("shipped");
      expect(gone.stdout).toContain("gone");
      expect(gone.stdout).not.toContain("landed");
      expect(await pathExists(goneDir)).toBe(false);
      expect(await pathExists(mergedDir)).toBe(true);

      const merged = await runCli(["prune", "--merged"], { cwd: root });
      expect(merged.exitCode).toBe(0);
      expect(merged.stdout).toContain("landed");
      expect(merged.stdout).toContain("merged");
      expect(await pathExists(mergedDir)).toBe(false);

      // Removes the directories and keeps the branches: the commits are still
      // there, and `grove add` brings either worktree back.
      const branches = await localBranches(root);
      expect(branches).toContain("shipped");
      expect(branches).toContain("landed");

      expect((await runCli(["prune"], { cwd: root })).stderr).toContain("nothing is finished with");
    });
  });

  test("fetches first, so a branch deleted on the remote only reads as gone once the ref is pruned", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      const worktree = await proposed(root, "shipped", "shipped.txt");
      await deleteOnOrigin(repo, "shipped");

      // The tracking ref is still there, so from stale refs the branch is alive.
      const stale = await runCli(["prune", "--no-fetch"], { cwd: root });
      expect(stale.exitCode).toBe(0);
      expect(stale.stderr).toContain("nothing is finished with");
      expect(await pathExists(worktree)).toBe(true);

      // The same question, after a fetch that prunes: now it is gone — and a
      // dry run says so while removing nothing.
      const dry = await runCli(["prune", "--dry-run"], { cwd: root });
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout).toContain("shipped");
      expect(dry.stderr).toContain("would remove 1");
      expect(await pathExists(worktree)).toBe(true);

      // And `-n` is the same flag.
      expect((await runCli(["prune", "-n"], { cwd: root })).stderr).toContain("would remove 1");
      expect(await pathExists(worktree)).toBe(true);

      const pruned = await runCli(["prune"], { cwd: root });
      expect(pruned.exitCode).toBe(0);
      expect(pruned.stderr).toContain("removed 1");
      expect(await pathExists(worktree)).toBe(false);
    });
  });

  test("--delete-branch parts with the branch where git will, and reports the one it will not", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      const landed = await proposed(root, "landed", "landed.txt");
      await landOnOrigin(repo, "landed", "merge");

      // Deleted on the remote with commits that are on nothing else: exactly
      // the branch `git branch -d` refuses, and the refusal is the safety net.
      const shipped = await proposed(root, "shipped", "shipped.txt");
      await deleteOnOrigin(repo, "shipped");

      const pruned = await runCli(["prune", "--delete-branch"], { cwd: root });
      expect(pruned.exitCode).toBe(0);
      expect(await pathExists(landed)).toBe(false);
      expect(await pathExists(shipped)).toBe(false);

      expect(pruned.stdout).toContain("branch deleted");
      expect(pruned.stdout).toContain("branch kept: git -C");

      const branches = await localBranches(root);
      expect(branches).not.toContain("landed");
      expect(branches).toContain("shipped");
    });
  });

  test("--delete-branch takes a pull request's remote with its pr/<n> branch", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      const bare = join(root, ".bare");

      // The shape `grove pr` leaves: a `pr/<n>` branch and a `pr-<n>` remote
      // that exists to serve it and nothing else.
      const worktree = await proposed(root, "pr/7", "pr7.txt");
      await seedGit(bare, ["remote", "add", "pr-7", repo.originPath]);
      await landOnOrigin(repo, "pr/7", "merge");

      const pruned = await runCli(["prune", "--delete-branch"], { cwd: root });
      expect(pruned.exitCode).toBe(0);
      expect(await pathExists(worktree)).toBe(false);
      expect(await localBranches(root)).not.toContain("pr/7");

      // The review is over, so nothing should still be fetching for it.
      const remotes = await probeGit(bare, ["remote"]);
      expect(remotes.stdout.split("\n")).not.toContain("pr-7");
    });
  });

  test("leaves anything dirty, mid-rebase, locked, or holding the cwd exactly where it is", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);

      const dirs: Record<string, string> = {};
      for (const branch of ["dirty", "stopped", "held", "standing"]) {
        dirs[branch] = await proposed(root, branch, `${branch}.txt`);
        await deleteOnOrigin(repo, branch);
      }

      await Bun.write(join(dirs.dirty ?? "", "uncommitted.txt"), "work in progress\n");

      // A rebase stopped on a conflict, built from the fixture's single known
      // line of app.txt so the conflict is certain rather than incidental.
      await commitIn(dirs.stopped ?? "", "app.txt", "mine\n");
      await commitOnOriginMain(repo, "app.txt", "theirs\n");
      await seedGit(join(root, ".bare"), ["fetch", "origin", "--prune"]);
      const conflicted = await probeGit(dirs.stopped ?? "", ["rebase", "origin/main"]);
      expect(conflicted.code).not.toBe(0);

      await seedGit(join(root, ".bare"), ["worktree", "lock", dirs.held ?? ""]);

      // Run from inside the fourth, which is the one nothing may delete out
      // from under the shell.
      const pruned = await runCli(["prune"], { cwd: dirs.standing });
      expect(pruned.exitCode).toBe(0);

      for (const [branch, dir] of Object.entries(dirs)) {
        expect(await pathExists(dir)).toBe(true);
        const row = pruned.stdout.split("\n").find((line) => line.startsWith(`· ${branch}`));
        expect(row).toBeDefined();
        expect(row).toContain("kept:");
      }

      expect(pruned.stdout).toContain("you are standing in it");
      expect(pruned.stdout).toContain("locked");
      expect(pruned.stdout).toContain("rebase");
      expect(pruned.stderr).toContain("4 left alone");
    });
  });

  // The case the feature exists for: the remote still has the branch, so `gone`
  // says nothing, and the squash rewrote the commits, so ancestry says nothing
  // either — only the patch comparison behind `merged` finds it.
  test("finds a branch whose commits the trunk squashed in", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      const worktree = await proposed(root, "squashed", "squashed.txt");
      // The remote keeps the branch, which is what a squash without the delete
      // box leaves — so `gone` cannot be what finds this one.
      await landOnOrigin(repo, "squashed", "squash");

      const pruned = await runCli(["prune", "--merged"], { cwd: root });
      expect(pruned.exitCode).toBe(0);
      expect(pruned.stdout).toContain("squashed");
      expect(await pathExists(worktree)).toBe(false);
    });
  });
});
