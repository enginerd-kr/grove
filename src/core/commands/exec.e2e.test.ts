import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove exec` through the real binary.
 *
 * Two things about this command can only be asked of a child process, and both
 * are the point of it. The first is the stream split: the promise is that
 * `grove exec -- cat version.txt > all.txt` collects versions and not a
 * transcript, and in-process that is two arrays on a recorder while here it is
 * two file descriptors. The second is `--`, which is the shell's convention and
 * `parseArgs`'s, and which nothing below `cli/args.ts` ever sees.
 *
 * The exit code is here for the ordinary reason: 11 is what a wrapper script
 * branches on, and it is composed outside the command.
 */

describe("grove exec", () => {
  test("stdout carries the answers and stderr carries which worktree said them", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const result = await runCli(["exec", "--", "git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repo.root,
      });

      expect(result.exitCode).toBe(ExitCode.ok);
      // Only the command's own words, one per worktree, in directory order —
      // which is what makes a redirect of this worth having.
      expect(result.stdout).toBe("feat/login\nmain\n");
      // The headings, and the summary, are on the other stream entirely.
      expect(result.stderr).toContain("feat/login");
      expect(result.stderr).toContain("ran in 2 worktrees");
    });
  }, 60_000);

  test("`--` hands the command its own flags instead of reading them as grove's", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // `--short` is not a flag this tool has; without `--` it would be a usage
      // error about grove rather than an argument to git.
      const result = await runCli(["exec", "--", "git", "status", "--short"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr).not.toContain("unknown option");
    });
  }, 60_000);

  test("a command that fails somewhere exits 11 and still reports the rest", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await Bun.write(join(repo.root, "main", "marker"), "x\n");

      const result = await runCli(["exec", "--", "test", "-f", "marker"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.commandFailed);
      // The worktree that failed is named, and the one that did not still had
      // its turn — the news is which, and stopping would have hidden it.
      expect(result.stderr).toContain("feat/login");
      expect(result.stderr).toContain("ran in 2 worktrees, 1 failed");
    });
  }, 60_000);

  test("--json is one document, and holds what each worktree said", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = await runCli(["exec", "--json", "--", "echo", "hello"], { cwd: repo.root });
      const outcomes = JSON.parse(result.stdout) as { dir: string; code: number; stdout: string }[];

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ dir: "main", code: 0, stdout: "hello\n" });
    });
  }, 60_000);

  test("with no command at all it is a usage error, and nothing has been run", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = await runCli(["exec"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("needs a command to run");
    });
  }, 60_000);
});
