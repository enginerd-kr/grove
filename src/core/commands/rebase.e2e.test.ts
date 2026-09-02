import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, seedGit, seedWorktree, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove rebase` through the real binary.
 *
 * What `rebaseWorktree` decides is asserted in-process in `rebase.test.ts`.
 * What is left here is what only the binary does: the row on stdout, the exit
 * code composed from the result after the row is printed, and the refusal a
 * pipe gets in place of the question — a piped run has nobody to pick a base,
 * and the parser cannot know that, so it is `run.ts` that has to say so.
 */

let scratchCount = 0;

async function commitOnOrigin(
  temp: TempRepo,
  branch: string,
  file: string,
  contents: string,
): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-e2e-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", branch, temp.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", `HEAD:${branch}`]);
  await rm(scratch, { recursive: true, force: true });
}

async function commitIn(worktree: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(worktree, file), contents);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

describe("grove rebase, through the binary", () => {
  test("prints one row on stdout, and --json the whole result", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const rebased = await runCli(["rebase", "feat/login", "--trunk"], { cwd: repo.root });
      expect(rebased.exitCode).toBe(ExitCode.ok);
      expect(rebased.stdout.trim()).toBe("feat/login\trebased");
      expect(rebased.stderr).toContain("rebased onto origin/main");

      const again = await runCli(["rebase", "feat/login", "--trunk", "--json"], { cwd: repo.root });
      expect(again.exitCode).toBe(ExitCode.ok);
      expect(JSON.parse(again.stdout)).toMatchObject({
        dir: "feat/login",
        onto: "origin/main",
        kind: "up-to-date",
      });
    });
  });

  test("in a pipe, no base is a usage error that lists what the flags would mean", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const asked = await runCli(["rebase", "feat/login"], { cwd: repo.root });

      expect(asked.exitCode).toBe(ExitCode.usage);
      expect(asked.stderr).toContain("--upstream, --trunk, or --onto <ref>");
      // The same list the terminal would have offered, so the log says what
      // each flag would have picked.
      expect(asked.stderr).toContain("origin/feat/login");
      expect(asked.stderr).toContain("origin/main");
      expect(asked.stdout).toBe("");
    });
  });

  test("a conflict is exit 5 with the row still on stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      await commitIn(join(repo.root, "spike"), "app.txt", "mine\n");
      await commitOnOrigin(temp, "main", "app.txt", "theirs\n");

      const conflicted = await runCli(["rebase", "spike", "--trunk"], { cwd: repo.root });

      expect(conflicted.exitCode).toBe(ExitCode.rebaseConflict);
      expect(conflicted.stderr).toContain("app.txt");
      expect(conflicted.stdout.trim()).toBe("spike\tconflicted");
    });
  });
});
