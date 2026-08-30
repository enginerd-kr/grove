import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../fs.ts";
import { managedRepo, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove remove` through the real binary.
 *
 * Everything `removeWorktree` decides is asserted in `remove.test.ts`, by
 * calling it. What is left here is what only a process can be asked for: the
 * `--json` document a `jq` reader is written against, the exit code a wrapper
 * script branches on, and the rule that stdout carries the row while stderr
 * carries everything said to a person. None of those live in `remove.ts` — they
 * are composed in `cli/run.ts` and reported by `cli.tsx` — so a direct call
 * cannot see them at all.
 *
 * The repository is still built in-process: only the act under test needs to be
 * a subprocess, and `grove clone` plus three `grove add`s to arrange one would
 * cost four processes to observe one.
 */

/** The half of `RemoveResult` these tests read back out of `--json`. */
type RemoveJson = {
  readonly path: string;
  readonly dir: string;
  readonly branch?: string;
  readonly branchDeleted: boolean;
};

describe("grove remove", () => {
  test("--json names the directory it removed, the way the list does", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      for (const branch of ["fix/bug#7", "chore/tidy@up"]) await seedWorktree(repo, branch);

      const removed = await runCli(["remove", "fix/bug#7", "--json"], { cwd: root });
      expect(removed.exitCode).toBe(ExitCode.ok);

      // The name every message this command prints already used, reported
      // rather than left to be re-derived: repo-root-relative and
      // `/`-separated, the spelling `path`, `reset` and `rename` answer with.
      const parsed = JSON.parse(removed.stdout) as RemoveJson;
      expect([parsed.dir, parsed.branch, parsed.branchDeleted]).toEqual([
        "fix/bug-7",
        "fix/bug#7",
        false,
      ]);
      expect(parsed.path).toBe(join(root, "fix", "bug-7"));
      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(false);

      // The command's other way out answers with the same field.
      const deleted = await runCli(["remove", "chore/tidy@up", "--delete-branch", "--json"], {
        cwd: root,
      });
      expect(deleted.exitCode).toBe(ExitCode.ok);

      const parsedDeleted = JSON.parse(deleted.stdout) as RemoveJson;
      expect([parsedDeleted.dir, parsedDeleted.branchDeleted]).toEqual(["chore/tidy-up", true]);
      // The document is for programs, and the branch it deleted was narrated
      // for the person — one fact, on the two streams that keep `| jq` working.
      expect(deleted.stderr).toContain("deleted branch chore/tidy@up");
    });
  }, 60_000);

  test("a refusal reaches the shell as the exit code a script branches on", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const worktree = join(root, "feat", "login");
      await Bun.write(join(worktree, "login.txt"), "edited\n");

      // `remove.test.ts` holds the `GroveError` and composes its exit code with
      // `errorToExitCode`. This is the one that lets nothing compose: the
      // binary really does exit 4 on a refusal, and 4 is what a wrapper script
      // reads instead of grepping the sentence beside it.
      const refused = await runCli(["remove", "feat/login"], { cwd: root });

      expect(refused.exitCode).toBe(ExitCode.refused);
      expect(refused.stderr).toContain("uncommitted changes");
      // A failure prints nothing a pipe would mistake for a result.
      expect(refused.stdout).toBe("");
      expect(await pathExists(worktree)).toBe(true);

      const forced = await runCli(["remove", "feat/login", "--force"], { cwd: root });

      expect(forced.exitCode).toBe(ExitCode.ok);
      // The row, relative to where the shell is standing — one line, and the
      // only thing on stdout, so `$(grove remove …)` is a usable path.
      expect(forced.stdout).toBe("feat/login\n");
      expect(await pathExists(worktree)).toBe(false);
    });
  });
});
