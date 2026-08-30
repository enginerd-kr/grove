import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * The bridge out of this tool's one hard limit: a child process cannot move
 * the shell that started it. So what matters is that the answer is a bare
 * absolute path — `cd "$(grove path x)"` has to work, which it does not if
 * anything else is on the line.
 */

async function clone(repo: TempRepo): Promise<string> {
  const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });
  expect(result.exitCode).toBe(ExitCode.ok);

  return join(repo.work, "app");
}

describe("grove path", () => {
  test("answers to a branch, a directory, or a path, and always with the same one", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);

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
        const result = await runCli(["path", target], { cwd: where });

        expect([target, result.exitCode]).toEqual([target, ExitCode.ok]);
        expect([target, result.stdout]).toEqual([target, `${login}\n`]);
      }
    });
  }, 60_000);

  test("prints a bare path: absolute, undecorated, one trailing newline", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const main = join(root, "main");

      // Run from inside the worktree, where every other command would print a
      // relative path because it is shorter. This one may not.
      const result = await runCli(["path", "main"], { cwd: main });

      expect(result.stdout).toBe(`${main}\n`);
      expect(result.stdout.startsWith("/")).toBe(true);
      // No colour, no marker, no second line — `cd "$(…)"` gets a directory.
      expect(result.stdout).not.toContain(String.fromCharCode(27));
      expect(result.stdout.split("\n")).toHaveLength(2);
    });
  }, 60_000);

  test("with no target, answers the repository root", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // The root is the one directory that is never a worktree, which makes it
      // the place to stand while removing anything.
      for (const cwd of [root, join(root, "main")]) {
        const result = await runCli(["path"], { cwd });

        expect(result.exitCode).toBe(ExitCode.ok);
        expect(result.stdout).toBe(`${root}\n`);
      }

      const json = await runCli(["path", "--json"], { cwd: root });
      expect(JSON.parse(json.stdout)).toEqual({ path: root, dir: "." });
    });
  }, 60_000);

  test("--json names the directory and the branch as well as the path", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      const result = await runCli(["path", "main", "--json"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(JSON.parse(result.stdout)).toEqual({
        path: join(root, "main"),
        dir: "main",
        branch: "main",
      });
    });
  }, 60_000);

  test("a target that matches nothing fails, and says what is there", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      const result = await runCli(["path", "nope"], { cwd: root });

      expect(result.exitCode).not.toBe(ExitCode.ok);
      expect(result.exitCode).toBe(ExitCode.notARepo);
      // Nothing on stdout: `cd "$(grove path nope)"` must not cd anywhere.
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('no worktree matches "nope"');
      expect(result.stderr).toContain("grove list");
    });
  }, 60_000);
});
