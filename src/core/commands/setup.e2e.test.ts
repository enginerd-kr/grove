import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, seedGit, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove setup` through the real binary.
 *
 * What only the child can answer is the trust gate as a person meets it: a
 * `run` line out of a tracked file is printed and skipped, the exit code stays
 * 0 because the files did land, and `--trust` is what changes that. In-process
 * the same facts are fields on a result; here they are the sentence somebody
 * reads and the number a script branches on.
 *
 * The `open` line is in the fixture on purpose. `add` would have started it and
 * this command must not, and a pipe is where that would be hardest to notice —
 * so the assertion is that nothing about opening is even mentioned.
 */

describe("grove setup", () => {
  test("fills in the worktree it is standing in, and says what it did", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const added = await seedWorktree(repo, "feat/login");

      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=1\n");
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\ncopy = [".env"]\n');

      const result = await runCli(["setup"], { cwd: added.path });

      expect(result.exitCode).toBe(ExitCode.ok);
      // `.` because the command was asked from inside the worktree it filled.
      expect(result.stdout).toBe(".\t1 copied\n");
      expect(await Bun.file(join(added.path, ".env")).text()).toBe("TOKEN=1\n");
    });
  }, 60_000);

  test("holds a tracked file's commands back, exits 0, and offers --trust", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const added = await seedWorktree(repo, "feat/login");
      const trunk = join(repo.root, "main");

      await Bun.write(join(trunk, ".grove.toml"), '[setup]\nrun = ["touch installed"]\n');
      await seedGit(trunk, ["add", "-A"]);
      await seedGit(trunk, ["-c", "commit.gpgsign=false", "commit", "-m", "Add .grove.toml"]);

      const held = await runCli(["setup", "feat/login"], { cwd: repo.root });

      // Not a failure: what did not happen is waiting on somebody having read
      // the file, which is a different thing from something going wrong.
      expect(held.exitCode).toBe(ExitCode.ok);
      expect(held.stderr).toContain("--trust");
      expect(await Bun.file(join(added.path, "installed")).exists()).toBe(false);

      const trusted = await runCli(["setup", "feat/login", "--trust"], { cwd: repo.root });

      expect(trusted.exitCode).toBe(ExitCode.ok);
      expect(trusted.stdout).toBe("feat/login\t1 run\n");
      expect(await Bun.file(join(added.path, "installed")).exists()).toBe(true);
    });
  }, 60_000);

  test("opens nothing, and does not report having declined to", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const added = await seedWorktree(repo, "feat/login");
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\nopen = "touch opened"\n');

      const result = await runCli(["setup", "feat/login", "--trust"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(await Bun.file(join(added.path, "opened")).exists()).toBe(false);
      // Nothing was refused, so there is nothing to say — which is what makes
      // this different from `grove open` in a pipe.
      expect(result.stderr).not.toContain("open");
    });
  }, 60_000);

  test("a failed command exits 9, having said what the command said", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await Bun.write(
        join(repo.root, "main", ".grove.toml"),
        '[setup]\nrun = ["echo nope >&2; exit 3"]\n',
      );

      const result = await runCli(["setup", "feat/login", "--trust"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.setupFailed);
      expect(result.stderr).toContain("nope");
    });
  }, 60_000);

  test("--all fills in every worktree, and the rows are one per worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=1\n");
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\ncopy = [".env"]\n');

      const result = await runCli(["setup", "--all"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(2);
      expect(result.stdout).toContain("feat/login\t1 copied");
    });
  }, 60_000);
});
