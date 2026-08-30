import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  seedGit,
  seedWorktree,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import type { Finished } from "./list.ts";
import { describePrune, formatPruneTable, type PruneResult, pruneWorktrees } from "./prune.ts";

/**
 * `grove prune` against a real origin.
 *
 * Both "finished" answers are built the way a forge leaves them — a branch
 * deleted on the remote, and a branch whose commits the trunk has — because the
 * two are found by different questions and a fixture that faked either would
 * pass while the real one did not.
 *
 * `pruneWorktrees` is called directly, with a recording reporter, for the
 * reason `rename.test.ts` gives: the repository is the part that has to be
 * real. This command needs it more than most, because it never throws. A
 * worktree it declines to remove is recorded *inside* the result and the run
 * still exits 0, so through the binary the only trace of a refusal was a
 * sentence in a table — and "kept: locked" and "kept: a rebase is stopped
 * part-way through" were, to a `toContain`, interchangeable with each other and
 * with any prose that happened to contain the same word. Holding the
 * `PruneResult` is what turns that into an assertion per worktree, and it is
 * also what lets the exact `git branch -D` command this offers be checked
 * rather than merely observed to start with `git -C`.
 *
 * `describePrune` and `formatPruneTable` are pure functions over that result,
 * so the two lines the user actually reads are asserted here as well. What is
 * left for `prune.e2e.test.ts` is which of them goes to which stream, and the
 * `--json` document.
 */

async function commitIn(worktree: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(worktree, file), contents);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

/** A branch with a commit of its own, pushed — the state a pull request starts in. */
async function proposed(repo: RepoPaths, branch: string, file: string): Promise<string> {
  const added = await seedWorktree(repo, branch, { push: true });
  await commitIn(added.path, file, `${file}\n`);
  await seedGit(added.path, ["push", "origin", `HEAD:${branch}`]);

  return added.path;
}

/** What a merged pull request with the delete box ticked leaves behind. */
async function deleteOnOrigin(temp: TempRepo, branch: string): Promise<void> {
  await seedGit(temp.originPath, ["branch", "-D", branch]);
}

let scratchCount = 0;

/** Lands a branch on the origin's trunk, the way a forge would. */
async function landOnOrigin(
  temp: TempRepo,
  branch: string,
  how: "merge" | "squash",
): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", "main", temp.originPath, scratch]);

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
async function commitOnOriginMain(temp: TempRepo, file: string, contents: string): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", "main", temp.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Change ${file}`]);
  await seedGit(scratch, ["push", "origin", "HEAD:main"]);
  await rm(scratch, { recursive: true, force: true });
}

async function localBranches(repo: RepoPaths): Promise<readonly string[]> {
  const result = await probeGit(repo.gitDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** The flags `cli/args.ts` hands `pruneWorktrees`, with its own defaults. */
type PruneCall = {
  readonly only?: Finished;
  readonly dryRun?: boolean;
  readonly deleteBranch?: boolean;
  readonly fetch?: boolean;
  /** Where the prune is asked from — the worktree it must not delete. */
  readonly cwd?: string;
};

function attemptPrune(
  repo: RepoPaths,
  { only, dryRun = false, deleteBranch = false, fetch = true, cwd = repo.root }: PruneCall = {},
): Promise<Attempt<PruneResult>> {
  return attempt((reporter) =>
    pruneWorktrees(repo, cwd, { only, dryRun, deleteBranch, fetch }, reporter),
  );
}

describe("grove prune", () => {
  test("finds both kinds of finished, narrows to one with --gone and --merged, and keeps the branches", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const goneDir = await proposed(repo, "shipped", "shipped.txt");
      await deleteOnOrigin(temp, "shipped");

      const mergedDir = await proposed(repo, "landed", "landed.txt");
      await landOnOrigin(temp, "landed", "merge");

      const gone = succeeded(await attemptPrune(repo, { only: "gone" }));

      // Exactly one entry, and every field of it: `--gone` narrowing to one of
      // the two answers was previously "landed" not appearing in a blob of
      // stdout, which any table that had wrapped or truncated would also pass.
      expect(gone).toEqual({
        dryRun: false,
        entries: [
          {
            path: goneDir,
            dir: "shipped",
            branch: "shipped",
            reason: "gone",
            branchDeleted: false,
          },
        ],
      });
      expect(describePrune(gone)).toBe("removed 1");
      expect(await pathExists(goneDir)).toBe(false);
      expect(await pathExists(mergedDir)).toBe(true);

      const merged = succeeded(await attemptPrune(repo, { only: "merged" }));

      expect(merged.entries).toEqual([
        {
          path: mergedDir,
          dir: "landed",
          branch: "landed",
          reason: "merged",
          branchDeleted: false,
        },
      ]);
      expect(await pathExists(mergedDir)).toBe(false);

      // Removes the directories and keeps the branches: the commits are still
      // there, and `grove add` brings either worktree back. `branchDeleted:
      // false` above is the same promise said in the result rather than
      // rediscovered from git — both, because they are two different claims.
      const branches = await localBranches(repo);
      expect(branches).toContain("shipped");
      expect(branches).toContain("landed");

      const nothing = succeeded(await attemptPrune(repo));
      expect(nothing.entries).toEqual([]);
      expect(describePrune(nothing)).toBe("nothing is finished with");
    });
  });

  test("fetches first, so a branch deleted on the remote only reads as gone once the ref is pruned", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const worktree = await proposed(repo, "shipped", "shipped.txt");
      await deleteOnOrigin(temp, "shipped");

      // The tracking ref is still there, so from stale refs the branch is alive.
      const stale = succeeded(await attemptPrune(repo, { fetch: false }));
      expect(stale.entries).toEqual([]);
      expect(describePrune(stale)).toBe("nothing is finished with");
      expect(await pathExists(worktree)).toBe(true);

      // The same question, after a fetch that prunes: now it is gone — and a
      // dry run says so while removing nothing.
      const dry = succeeded(await attemptPrune(repo, { dryRun: true }));
      expect(dry.dryRun).toBe(true);
      expect(dry.entries.map((entry) => entry.dir)).toEqual(["shipped"]);
      // Nothing stopped it: a dry run's entry is a plan, not a refusal, and the
      // two would be the same row on stdout but for this field.
      expect(dry.entries[0]?.skipped).toBeUndefined();
      expect(describePrune(dry)).toBe("would remove 1");
      expect(await pathExists(worktree)).toBe(true);

      const pruned = succeeded(await attemptPrune(repo));
      expect(describePrune(pruned)).toBe("removed 1");
      expect(await pathExists(worktree)).toBe(false);
    });
  });

  test("--delete-branch parts with the branch where git will, and reports the one it will not", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const landed = await proposed(repo, "landed", "landed.txt");
      await landOnOrigin(temp, "landed", "merge");

      // Deleted on the remote with commits that are on nothing else: exactly
      // the branch `git branch -d` refuses, and the refusal is the safety net.
      const shipped = await proposed(repo, "shipped", "shipped.txt");
      await deleteOnOrigin(temp, "shipped");

      const result = succeeded(await attemptPrune(repo, { deleteBranch: true }));

      // Both directories go; only one branch does. The command offered as the
      // way past the refusal is asserted in full — through the binary it was
      // `toContain("branch kept: git -C")`, which would have passed just as
      // happily on a command naming the wrong repository or the wrong branch.
      expect(result.entries).toEqual([
        { path: landed, dir: "landed", branch: "landed", reason: "merged", branchDeleted: true },
        {
          path: shipped,
          dir: "shipped",
          branch: "shipped",
          reason: "gone",
          branchDeleted: false,
          branchKept: `git -C ${repo.gitDir} branch -D shipped`,
        },
      ]);
      expect(await pathExists(landed)).toBe(false);
      expect(await pathExists(shipped)).toBe(false);

      const table = formatPruneTable(result);
      expect(table).toContain("branch deleted");
      expect(table).toContain(`branch kept: git -C ${repo.gitDir} branch -D shipped`);
      expect(describePrune(result)).toBe("removed 2, 1 branch deleted");

      const branches = await localBranches(repo);
      expect(branches).not.toContain("landed");
      expect(branches).toContain("shipped");
    });
  });

  test("--delete-branch takes a pull request's remote with its pr/<n> branch", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // The shape `grove pr` leaves: a `pr/<n>` branch and a `pr-<n>` remote
      // that exists to serve it and nothing else.
      const worktree = await proposed(repo, "pr/7", "pr7.txt");
      await seedGit(repo.gitDir, ["remote", "add", "pr-7", temp.originPath]);
      await landOnOrigin(temp, "pr/7", "merge");

      const result = succeeded(await attemptPrune(repo, { deleteBranch: true }));

      expect(result.entries).toEqual([
        { path: worktree, dir: "pr/7", branch: "pr/7", reason: "merged", branchDeleted: true },
      ]);
      expect(await pathExists(worktree)).toBe(false);
      expect(await localBranches(repo)).not.toContain("pr/7");

      // The review is over, so nothing should still be fetching for it.
      const remotes = await probeGit(repo.gitDir, ["remote"]);
      expect(remotes.stdout.split("\n")).not.toContain("pr-7");
    });
  });

  test("leaves anything dirty, mid-rebase, locked, or holding the cwd exactly where it is", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const dirs: Record<string, string> = {};
      for (const branch of ["dirty", "stopped", "held", "standing"]) {
        dirs[branch] = await proposed(repo, branch, `${branch}.txt`);
        await deleteOnOrigin(temp, branch);
      }

      await Bun.write(join(dirs.dirty ?? "", "uncommitted.txt"), "work in progress\n");

      // A rebase stopped on a conflict, built from the fixture's single known
      // line of app.txt so the conflict is certain rather than incidental.
      await commitIn(dirs.stopped ?? "", "app.txt", "mine\n");
      await commitOnOriginMain(temp, "app.txt", "theirs\n");
      await seedGit(repo.gitDir, ["fetch", "origin", "--prune"]);
      const conflicted = await probeGit(dirs.stopped ?? "", ["rebase", "origin/main"]);
      expect(conflicted.code).not.toBe(0);

      await seedGit(repo.gitDir, ["worktree", "lock", dirs.held ?? ""]);

      // Run from inside the fourth, which is the one nothing may delete out
      // from under the shell.
      const result = succeeded(await attemptPrune(repo, { cwd: dirs.standing }));

      // Four reasons, one per worktree, each said in its own words. On stdout
      // these were four rows containing "kept:", and a bug that gave every one
      // of them the same reason would have read identically.
      expect(result.entries.length).toBe(4);
      const byDir = new Map(result.entries.map((entry) => [entry.dir, entry]));
      expect(byDir.get("dirty")?.skipped).toBe("holds 1 untracked file");
      expect(byDir.get("stopped")?.skipped).toBe("a rebase is stopped part-way through");
      expect(byDir.get("held")?.skipped).toBe("locked");
      expect(byDir.get("standing")?.skipped).toBe("you are standing in it");

      // All four were found finished with — being skipped is a decision taken
      // about a worktree that qualified, not a failure to recognise it.
      expect(result.entries.every((entry) => entry.reason === "gone")).toBe(true);
      expect(result.entries.every((entry) => entry.branchDeleted === false)).toBe(true);

      const rows = formatPruneTable(result).split("\n");
      for (const entry of result.entries) {
        const row = rows.find((line) => line.startsWith(`· ${entry.dir}`));
        expect(row).toBeDefined();
        expect(row).toContain(`kept: ${entry.skipped ?? ""}`);
        expect(await pathExists(entry.path)).toBe(true);
      }

      expect(describePrune(result)).toBe("removed 0, 4 left alone");
    });
  });

  // The case the feature exists for: the remote still has the branch, so `gone`
  // says nothing, and the squash rewrote the commits, so ancestry says nothing
  // either — only the patch comparison behind `merged` finds it.
  test("finds a branch whose commits the trunk squashed in", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const worktree = await proposed(repo, "squashed", "squashed.txt");
      // The remote keeps the branch, which is what a squash without the delete
      // box leaves — so `gone` cannot be what finds this one.
      await landOnOrigin(temp, "squashed", "squash");

      const result = succeeded(await attemptPrune(repo, { only: "merged" }));

      // `merged` and not `gone`, which is the whole distinction: the branch is
      // still on the remote, and stdout saying "squashed" somewhere proved only
      // that the row was printed, not which question put it there.
      expect(result.entries).toEqual([
        {
          path: worktree,
          dir: "squashed",
          branch: "squashed",
          reason: "merged",
          branchDeleted: false,
        },
      ]);
      expect(await pathExists(worktree)).toBe(false);
    });
  });
});
