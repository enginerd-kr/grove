import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.ts";
import { snapshotChanges } from "./snapshot.ts";
import { managedRepo, probeGit, seedGit, seedWorktree, withTempRepo } from "./test-utils.ts";
import { statusOf } from "./worktrees.ts";

/**
 * The snapshot commit, and the one claim made about it: `git stash apply
 * <sha>` brings everything back, with no help from grove.
 *
 * Asserted by applying, against a real repository, because the shape being
 * built is git's own — a stash commit with a third parent for the untracked
 * files — and the only proof that the shape is right is that `git stash`
 * accepts it.
 */

async function status(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["status", "--porcelain"])).stdout;
}

describe("snapshotChanges", () => {
  test("carries tracked changes and untracked files, and git stash apply restores both", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");
      await mkdir(join(worktree, "junk"), { recursive: true });
      await Bun.write(join(worktree, "junk", "output.bin"), "junk\n");
      // Staged, so the index half of the stash has something of its own to carry.
      await Bun.write(join(worktree, "staged.txt"), "staged\n");
      await seedGit(worktree, ["add", "staged.txt"]);

      const before = await statusOf(worktree);
      const sha = await snapshotChanges(worktree, "grove: test", {
        untracked: before.untracked,
        hint: "n/a",
      });

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      if (sha === undefined) throw new Error("no snapshot");

      // The shape `git stash push -u` stores: three parents, the third holding
      // only the untracked paths, and nothing under `refs/stash` or anywhere
      // else — the object is reachable by its sha and by nothing.
      const parents = (await probeGit(worktree, ["rev-list", "--parents", "-n", "1", sha])).stdout
        .trim()
        .split(" ");
      expect(parents).toHaveLength(4);
      const untrackedTree = (
        await probeGit(worktree, ["ls-tree", "-r", "--name-only", `${sha}^3`])
      ).stdout
        .trim()
        .split("\n")
        .toSorted();
      expect(untrackedTree).toEqual(["junk/output.bin", "scratch.txt"]);
      expect(
        (await probeGit(worktree, ["rev-parse", "--verify", "--quiet", "refs/stash"])).code,
      ).not.toBe(0);
      // The throwaway index and path list are gone, not left beside the real one.
      const gitDir = (await probeGit(worktree, ["rev-parse", "--git-dir"])).stdout.trim();
      expect(await pathExists(join(gitDir, "grove-snapshot.index"))).toBe(false);
      expect(await pathExists(join(gitDir, "grove-snapshot.paths"))).toBe(false);

      // Everything gone, then everything back, through git's own command.
      await seedGit(worktree, ["reset", "--hard", "HEAD"]);
      await seedGit(worktree, ["clean", "-fd"]);
      expect(await status(worktree)).toBe("");

      expect((await probeGit(worktree, ["stash", "apply", sha])).code).toBe(0);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("edited\n");
      expect(await Bun.file(join(worktree, "scratch.txt")).text()).toBe("scratch\n");
      expect(await Bun.file(join(worktree, "junk", "output.bin")).text()).toBe("junk\n");
      expect(await Bun.file(join(worktree, "staged.txt")).text()).toBe("staged\n");
    });
  });

  test("untracked files alone still make a snapshot, and none of anything makes none", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      // A clean tree has nothing to keep, and says so with nothing.
      expect(await snapshotChanges(worktree, "grove: test", { hint: "n/a" })).toBeUndefined();

      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");
      const before = await statusOf(worktree);

      // Not asked to carry the untracked files: `stash create` has nothing to
      // write, which is `rebase`'s case, and the answer is still nothing.
      expect(await snapshotChanges(worktree, "grove: test", { hint: "n/a" })).toBeUndefined();

      // Asked to: the two parents `stash create` would have written are made
      // here, so `stash apply` accepts the commit it never saw made.
      const sha = await snapshotChanges(worktree, "grove: test", {
        untracked: before.untracked,
        hint: "n/a",
      });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      if (sha === undefined) throw new Error("no snapshot");

      await seedGit(worktree, ["clean", "-fd"]);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(false);

      expect((await probeGit(worktree, ["stash", "apply", sha])).code).toBe(0);
      expect(await Bun.file(join(worktree, "scratch.txt")).text()).toBe("scratch\n");
    });
  });
});
