import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { withTempRepo } from "../test-utils.ts";

/**
 * `grove clone` through the real binary.
 *
 * More of this command stays here than of any other, and for one reason: clone
 * is the only command whose arguments are two bare positionals. `grove clone
 * <url> [dir]` decides where a repository lands by argument *order*, `-b` picks
 * the branch by flag, and a call to `cloneRepo({ url, dir, branch })` has all
 * three already sorted out — it cannot show that the parser put them there.
 *
 * The rest is the same line every other e2e file draws. The row on stdout and
 * the `--json` document are composed in `cli/run.ts` from a `CloneResult` that
 * `clone.test.ts` asserts whole; what is untestable in-process is which stream
 * each lands on. And the exit codes are the promise to a wrapper script:
 * clone is the command most likely to be run by one, and "the remote was
 * unreachable" (8) has to be tellable from "you typed the URL wrong" (2) and
 * "that directory is occupied" (6) without grepping the sentence beside it.
 */

type CloneJson = {
  readonly root: string;
  readonly gitDir: string;
  readonly defaultBranch: string;
  readonly branch: string;
  readonly worktree: string;
};

describe("grove clone", () => {
  test("the row on stdout is the worktree and its branch, tab separated", async () => {
    await withTempRepo(async (temp) => {
      const named = await runCli(["clone", temp.originUrl, "app"], { cwd: temp.work });

      expect(named.exitCode).toBe(ExitCode.ok);
      // Relative to where the command was run, which is where the person is.
      expect(named.stdout).toBe("app/main\tmain\n");
      // The narration is the other stream's, so `grove clone … | cut -f1` gets
      // a path and not a progress log.
      expect(named.stderr).toContain("cloned");

      // The second positional is optional, and dropping it is not a parse
      // error but a different default — the name comes off the URL instead.
      const derived = await runCli(["clone", temp.originUrl], { cwd: temp.work });

      expect(derived.exitCode).toBe(ExitCode.ok);
      expect(derived.stdout).toBe("origin/main\tmain\n");
    });
  }, 30_000);

  test("-b checks out another branch first, and only that one", async () => {
    await withTempRepo(async (temp) => {
      const result = await runCli(["clone", temp.originUrl, "app", "-b", "feat/login"], {
        cwd: temp.work,
      });

      expect(result.exitCode).toBe(ExitCode.ok);
      // The flag reached `branch` and not `dir`, which is the only thing a
      // direct call could not have shown: the row names the branch that was
      // asked for, in the directory the positional named.
      expect(result.stdout).toBe("app/feat/login\tfeat/login\n");
      expect(await Bun.file(join(temp.work, "app", "feat", "login", "login.txt")).exists()).toBe(
        true,
      );
    });
  }, 30_000);

  test("--json describes what was made", async () => {
    await withTempRepo(async (temp) => {
      const result = await runCli(["clone", temp.originUrl, "app", "--json"], {
        cwd: temp.work,
      });

      expect(result.exitCode).toBe(ExitCode.ok);

      const root = join(temp.work, "app");
      // Every field of the `CloneResult` survives the trip out, and the
      // document has stdout to itself: `--json` is read by a program, and a
      // stray progress line in front of the `{` would break `jq` outright.
      expect(JSON.parse(result.stdout) as CloneJson).toEqual({
        root,
        gitDir: join(root, ".bare"),
        defaultBranch: "main",
        branch: "main",
        worktree: join(root, "main"),
      });
      expect(result.stdout).not.toContain("ready");
      expect(result.stderr).toContain("is ready");
    });
  }, 30_000);

  test("each refusal reaches the shell as the exit code a script branches on", async () => {
    await withTempRepo(async (temp) => {
      // Every refusal's `code`, `message` and `hint` is asserted directly in
      // `clone.test.ts` and mapped through `errorToExitCode` there. This is the
      // one thing that lets nothing compose: the binary really does exit with
      // these numbers, and they are what a wrapper reads instead of grepping.
      const url = await runCli(["clone", "not a url"], { cwd: temp.work });
      expect(url.exitCode).toBe(ExitCode.usage);
      expect(url.stderr).toContain("does not look like a repository URL");
      // A failure prints nothing a pipe would mistake for a result.
      expect(url.stdout).toBe("");

      const missing = await runCli(["clone", `file://${join(temp.root, "nothing.git")}`, "app"], {
        cwd: temp.work,
      });
      expect(missing.exitCode).toBe(ExitCode.remote);
      expect(missing.stdout).toBe("");

      const branch = await runCli(["clone", temp.originUrl, "app", "--branch", "nope"], {
        cwd: temp.work,
      });
      expect(branch.exitCode).toBe(ExitCode.usage);
      expect(branch.stderr).toContain('the remote has no branch named "nope"');

      const occupied = join(temp.work, "occupied");
      await mkdir(occupied, { recursive: true });
      await Bun.write(join(occupied, "mine.txt"), "keep me\n");

      const taken = await runCli(["clone", temp.originUrl, "occupied"], { cwd: temp.work });
      expect(taken.exitCode).toBe(ExitCode.stateConflict);
      expect(taken.stderr).toContain("already exists and is not empty");
    });
  }, 30_000);
});
