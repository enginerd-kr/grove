import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { recentCommits } from "./history.ts";
import { seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * The fixture's `main` carries two commits — "Add a readme" then "Add app.txt" —
 * both stamped with the pinned committer date, which is what lets the times
 * below be exact rather than a range.
 */
const FIXTURE_TIME = Date.parse("2026-01-01T00:00:00Z");

/** An ordinary clone: the cheapest thing that is a worktree with history in it. */
async function clone(repo: TempRepo, name = "app"): Promise<string> {
  const root = join(repo.work, name);
  await seedGit(repo.work, ["clone", repo.originUrl, root]);

  return root;
}

async function commitIn(worktree: string, file: string, body: string, args: readonly string[]) {
  await Bun.write(join(worktree, file), body);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", ...args]);
}

describe("recentCommits", () => {
  test("reads the log newest first, with every field filled in", async () => {
    await withTempRepo(async (repo) => {
      const worktree = await clone(repo);

      const commits = await recentCommits(worktree, 10);

      // Fewer commits than the limit is the ordinary case, not an edge one.
      expect(commits.map((commit) => commit.subject)).toEqual(["Add app.txt", "Add a readme"]);

      const [head, first] = commits;
      if (head === undefined || first === undefined) throw new Error("expected two commits");

      expect(head.when).toBe(FIXTURE_TIME);
      expect(first.when).toBe(FIXTURE_TIME);

      // The sha is abbreviated, and abbreviates the commit it claims to.
      const full = (await seedGit(worktree, ["rev-parse", "HEAD"])).trim();
      expect(head.sha).toMatch(/^[0-9a-f]{7,}$/);
      expect(full.startsWith(head.sha)).toBe(true);

      // The decoration is what tells the row under the cursor from the rest:
      // where this worktree's HEAD is, and where the remote's copy has got to.
      expect(head.refs).toContain("HEAD -> main");
      expect(head.refs).toContain("origin/main");
      expect(first.refs).toBe("");
    });
  });

  test("takes no more than the limit, and nothing at all for a limit of none", async () => {
    await withTempRepo(async (repo) => {
      const worktree = await clone(repo);

      const one = await recentCommits(worktree, 1);
      expect(one).toHaveLength(1);
      expect(one[0]?.subject).toBe("Add app.txt");

      expect(await recentCommits(worktree, 0)).toEqual([]);
      // A negative limit is `git log`'s error, so it never reaches git.
      expect(await recentCommits(worktree, -3)).toEqual([]);
    });
  });

  test("keeps subjects intact, however they are punctuated", async () => {
    await withTempRepo(async (repo) => {
      const worktree = await clone(repo);

      // Commas and tabs are what a naive separator would split on, and a commit
      // with no subject at all is still a commit and still gets its row.
      await commitIn(worktree, "one.txt", "1\n", ["-m", "Fix: a, b\tand c"]);
      await seedGit(worktree, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "--allow-empty-message",
        "-m",
        "",
      ]);

      const commits = await recentCommits(worktree, 3);

      expect(commits.map((commit) => commit.subject)).toEqual([
        "",
        "Fix: a, b\tand c",
        "Add app.txt",
      ]);
    });
  });

  test("answers nothing for a branch with no commits yet", async () => {
    await withTempRepo(async (repo) => {
      const unborn = join(repo.work, "unborn");
      await seedGit(repo.work, ["init", "--initial-branch=main", unborn]);

      expect(await recentCommits(unborn, 5)).toEqual([]);
    });
  });

  test("answers nothing for a directory git will not talk about", async () => {
    await withTempRepo(async (repo) => {
      const plain = join(repo.work, "not-a-repo");
      await mkdir(plain, { recursive: true });

      expect(await recentCommits(plain, 5)).toEqual([]);
    });
  });
});
