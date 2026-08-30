import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import {
  attempt,
  managedRepo,
  refused,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { worktreePath } from "./path.ts";

/**
 * The bridge out of this tool's one hard limit: a child process cannot move the
 * shell that started it. So the shell asks, and this answers.
 *
 * That splits in two, and the split is why half of these tests are next door in
 * `path.e2e.test.ts`. `worktreePath` decides *which* worktree a word means —
 * a branch, a directory, a relative path, an absolute one, or nothing at all —
 * and that is resolution, testable as a function call and asserted here down to
 * the branch and directory it hands back beside the path. What the shell is
 * then left holding is a different promise entirely: a bare absolute path, one
 * newline, nothing else on the line, because `cd "$(grove path x)"` has to
 * work. Only the binary can be asked whether that is what came out of it.
 */

describe("grove path", () => {
  test("answers to a branch, a directory, or a path, and always with the same one", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const login = join(root, "feat", "login");

      for (const [where, target] of [
        // The branch, which is the name people have in mind.
        [root, "feat/login"],
        // The directory, relative to the root.
        [root, "feat/login/"],
        // A path, relative to where the command was run.
        [root, "./feat/login"],
        [join(root, "feat"), "login"],
        // And the absolute path, which resolves to itself.
        [root, login],
      ] as const) {
        const result = await worktreePath(repo, where, target);

        // Every spelling lands on one worktree, and the answer says which by
        // all three of its names — the branch and the directory as well as the
        // path. Through the binary only the path was ever visible, so "the
        // directory `feat/login/` and the branch `feat/login` are the same
        // worktree" was inferred from two identical strings rather than read.
        expect([target, result]).toEqual([
          target,
          { path: login, dir: "feat/login", branch: "feat/login" },
        ]);
      }
    });
  });

  test("with no target, answers the repository root", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // The root is the one directory that is never a worktree, which makes it
      // the place to stand while removing anything — and being no worktree, it
      // has no branch to name, which is the whole of the difference between
      // this answer and every other one.
      for (const cwd of [root, join(root, "main")]) {
        expect(await worktreePath(repo, cwd)).toEqual({ path: root, dir: "." });
      }

      // Answered without looking: no target means the root whatever is on disk,
      // so this is the one call that cannot fail for want of a match.
      expect((await worktreePath(repo, root)).branch).toBeUndefined();
    });
  });

  test("a target that matches nothing fails, and says what is there", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const outcome = await attempt(() => worktreePath(repo, repo.root, "nope"));
      const failure = refused(outcome);

      expect(failure.code).toBe("not-a-repo");
      // The number a script branches on, composed the way `cli.tsx` composes it.
      expect(errorToExitCode(failure.code)).toBe(ExitCode.notARepo);
      expect(failure.message).toBe('no worktree matches "nope"');
      expect(failure.hint).toBe("run `grove list` to see what is there");
      // "says what is there" was a `toContain` on stderr, which only ever
      // proved the words `grove list` were printed. What is actually there is
      // on `details`, in the two columns `grove list` itself prints.
      //
      // Not in `grove list`'s order, though, which is worth pinning because the
      // hint sends the reader straight there: this is git's own worktree order,
      // so the trunk is wherever the alphabet puts it, while `grove list` lifts
      // the trunk to the top. Two listings of the same two worktrees, and the
      // rows are not in the same sequence.
      expect(failure.details).toEqual(["feat/login  feat/login", "main  main"]);

      // A word that is a real worktree's name still resolves after the miss:
      // nothing about the failure is cached or half-applied.
      expect(succeeded(await attempt(() => worktreePath(repo, repo.root, "main"))).dir).toBe(
        "main",
      );
    });
  });
});
