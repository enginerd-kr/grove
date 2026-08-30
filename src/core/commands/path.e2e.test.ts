import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove path` through the real binary.
 *
 * This command is unusual in how little of it a direct call can be asked about.
 * `worktreePath` resolves a word to a worktree and `path.test.ts` asserts that
 * whole; everything below is about the *line* — and the line is the product.
 * `cd "$(grove path x)"` breaks if there is a colour code on it, a second line
 * under it, or a relative path where an absolute one was promised, and every
 * one of those is decided in `cli/run.ts`: it is the only place that chooses
 * `result.path` over the shorter relative form every other command prints, and
 * the only place that turns a `PathResult` into a `--json` document. A refusal
 * is here for the same reason from the other side: what matters is that nothing
 * reached stdout, so `cd "$(grove path nope)"` cds nowhere.
 */

describe("grove path", () => {
  test("prints a bare path: absolute, undecorated, one trailing newline", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");

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
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // The root is the place to stand while removing anything, and the answer
      // is the same absolute path from inside a worktree as from outside one.
      for (const cwd of [root, join(root, "main")]) {
        const result = await runCli(["path"], { cwd });

        expect(result.exitCode).toBe(ExitCode.ok);
        expect(result.stdout).toBe(`${root}\n`);
      }

      const json = await runCli(["path", "--json"], { cwd: root });
      // No `branch` key at all rather than a null one: the root is no worktree,
      // and `JSON.stringify` dropping the absent field is what a reader of this
      // document actually depends on.
      expect(JSON.parse(json.stdout)).toEqual({ path: root, dir: "." });
    });
  }, 60_000);

  test("--json names the directory and the branch as well as the path", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      const result = await runCli(["path", "main", "--json"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.ok);
      // Every field of the `PathResult` survives the trip out as JSON, which is
      // the contract `grove path … --json | jq` is written against.
      expect(JSON.parse(result.stdout)).toEqual({
        path: join(root, "main"),
        dir: "main",
        branch: "main",
      });
    });
  }, 60_000);

  test("a target that matches nothing fails, and says what is there", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = await runCli(["path", "nope"], { cwd: repo.root });

      // The error itself — its code, its hint, and the listing on its details —
      // is asserted in `path.test.ts`. What costs a process to pin is that the
      // failure reaches the shell as a number and leaves stdout empty.
      expect(result.exitCode).toBe(ExitCode.notARepo);
      // Nothing on stdout: `cd "$(grove path nope)"` must not cd anywhere.
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('no worktree matches "nope"');
      expect(result.stderr).toContain("grove list");
    });
  }, 60_000);
});
