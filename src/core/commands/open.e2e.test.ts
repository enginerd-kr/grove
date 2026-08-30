import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove open` through the real binary.
 *
 * One rule here can only be asked of a child, and it is the one this command is
 * most likely to be wrong about: `open` is skipped where there is no terminal to
 * open into, and `runCli` is a pipe. In-process that question is a boolean the
 * caller passes; through the binary it is `process.stdout.isTTY`, decided once
 * in `cli/run.ts`, and getting it wrong means a scripted `grove open` starting
 * an editor on a machine nobody is sitting at.
 *
 * The refusals are here for the ordinary reason: what a person sees is an exit
 * code and a sentence, and both are composed outside the command.
 */

describe("grove open", () => {
  test("in a pipe it opens nothing, says why, and still exits 0", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\nopen = "touch opened"\n');
      const added = await seedWorktree(repo, "feat/login");

      const result = await runCli(["open", "feat/login", "--trust"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr).toContain("not a terminal");
      // Not a failure and not a launch: the worktree is untouched.
      expect(await Bun.file(join(added.path, "opened")).exists()).toBe(false);
    });
  }, 60_000);

  test("a repository that configures no editor is a usage error, with nothing on stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = await runCli(["open", "main"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('open = "code ."');
    });
  }, 60_000);

  test("the root has no worktree to open, and the refusal names the ones there are", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\nopen = "touch opened"\n');

      const result = await runCli(["open"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("not inside a worktree");
      expect(result.stderr).toContain("main");
    });
  }, 60_000);
});
