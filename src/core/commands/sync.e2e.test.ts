import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import {
  managedRepo,
  probeGit,
  seedGit,
  seedWorktree,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";

/**
 * `grove sync` through the real binary.
 *
 * Everything `syncWorktrees` decides is asserted in-process in `sync.test.ts`,
 * where the outcomes themselves can be read. What is left here is the part that
 * has no existence inside the function: `sync` returns outcomes and never
 * throws, so the exit code a wrapper script branches on is composed afterwards
 * by `cli/run.ts` out of `failureFor`, and the rows are printed *before* that
 * error is thrown. "The run failed and stdout still says which worktree it was"
 * is a fact about the order of two statements in the CLI, and a direct call
 * cannot observe it at all.
 *
 * The fixtures are still built in-process — a `clone` and an `add` spent on
 * arranging a repository buy nothing that a function call does not.
 */

let scratchCount = 0;

/** Somebody else's commit, pushed to the origin from outside the repo under test. */
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

describe("grove sync, through the binary", () => {
  test("sync in a new worktree succeeds from main without publishing", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/local");
      await commitIn(path, "mine.txt", "mine\n");
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const synced = await runCli(["sync"], { cwd: path });
      expect(synced.exitCode).toBe(ExitCode.ok);
      expect(synced.stdout.trim()).toBe(".\trebased");
      expect(await Bun.file(join(path, "trunk.txt")).text()).toBe("trunk\n");
      expect(await Bun.file(join(path, "mine.txt")).text()).toBe("mine\n");
      expect(
        (await probeGit(temp.originPath, ["rev-parse", "--verify", "feat/local"])).code,
      ).not.toBe(0);

      const again = await runCli(["sync", "--all"], { cwd: repo.root });
      expect(again.exitCode).toBe(ExitCode.ok);
      expect(again.stdout).toContain("feat/local\tup-to-date");
    });
  });

  test("--all prints one row per worktree on stdout, and narrates beside it on stderr", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const synced = await runCli(["sync", "--all"], { cwd: repo.root });
      expect(synced.exitCode).toBe(ExitCode.ok);

      // One line per worktree and nothing else, which is what makes `grove sync
      // --all | wc -l` a count of worktrees rather than a count of sentences.
      const lines = synced.stdout.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(synced.stdout).toContain("main\tfast-forwarded");
      expect(synced.stdout).toContain("feat/login\t");

      // The progress the person watching wants is on the other stream entirely.
      expect(synced.stderr).toContain("✓ fetched");
      expect(synced.stdout).not.toContain("fetch");
    });
  });

  test("a skip and a conflict reach the shell as the exit codes a script branches on, with the rows still on stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");
      await Bun.write(join(root, "feat", "login", "login.txt"), "half-finished\n");

      const skipped = await runCli(["sync", "feat/login"], { cwd: root });

      // 4 is what a wrapper reads instead of grepping the sentence beside it.
      expect(skipped.exitCode).toBe(ExitCode.refused);
      expect(skipped.stderr).toContain("uncommitted changes");
      // Printed before the failure is thrown, on purpose: with `--all` the nine
      // worktrees that did sync are still news, so the rows are never withheld
      // on account of the tenth.
      expect(skipped.stdout.trim()).toBe("feat/login\tskipped");

      // A conflict is a different answer from a refusal, and gets its own
      // number so a script can retry one and stop on the other.
      await seedWorktree(repo, "spike");
      await commitIn(join(root, "spike"), "app.txt", "mine\n");
      await commitOnOrigin(temp, "main", "app.txt", "theirs\n");

      const conflicted = await runCli(["sync", "spike"], { cwd: root });

      expect(conflicted.exitCode).toBe(ExitCode.rebaseConflict);
      expect(conflicted.stderr).toContain("app.txt");
      expect(conflicted.stdout.trim()).toBe("spike\tconflicted");
    });
  });
});
