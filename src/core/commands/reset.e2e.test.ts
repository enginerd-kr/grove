import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../fs.ts";
import { managedRepo, probeGit, seedGit, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove reset` through the real binary.
 *
 * Everything `resetWorktree` decides is asserted in `reset.test.ts`, by calling
 * it. What is left here is what only a process can be asked for: the row on
 * stdout that a script reads, the `--json` document a `jq` reader is written
 * against, the rule that keeps the warning off stdout while the row is on it,
 * and the three different exit codes this one command can leave a shell
 * holding. All of that is composed in `cli/run.ts` and reported by `cli.tsx`,
 * so a direct call cannot see any of it.
 *
 * The repository is still built in-process: only the act under test needs to be
 * a subprocess, and arranging one through `grove clone` and `grove add` would
 * cost two processes to observe one.
 */

/** The half of `ResetResult` these tests read back. */
type ResetJson = {
  readonly path: string;
  readonly dir: string;
  readonly branch?: string;
  readonly discarded: readonly string[];
  readonly changed: number;
  readonly untracked: number;
  readonly cleaned: boolean;
  readonly head: string;
  /** The snapshot's sha, when something was discarded. */
  readonly saved?: string;
};

async function head(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("grove reset", () => {
  test("the row on stdout is the path and the head, and what is said to a person is not", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "spike");

      const worktree = join(root, "spike");
      const trunk = await head(join(root, "main"));

      await Bun.write(join(worktree, "one.txt"), "one\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Add one"]);
      // Untracked, so the reset has something to warn about — and the warning
      // is the thing that must not land in the row.
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");

      const reset = await runCli(["reset", "spike", "--to", "main"], { cwd: root });

      expect(reset.exitCode).toBe(ExitCode.ok);
      // `<path>\t<short head>`, relative to where the shell is standing, one
      // line and nothing else: this is what `grove reset … | cut -f2` reads.
      expect(reset.stdout).toBe(`spike\t${trunk.slice(0, 7)}\n`);
      expect(reset.stderr).toContain("--clean would delete them too");
      expect(reset.stdout).not.toContain("--clean");
      expect(await pathExists(join(worktree, "one.txt"))).toBe(false);
    });
  });

  test("--json is the whole result, as a document rather than a sentence", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      // A branch whose directory is not spelled the same way, so `dir` and
      // `branch` in the document are provably two different answers.
      await seedWorktree(repo, "fix/bug#7");

      const worktree = join(root, "fix", "bug-7");
      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");

      const reset = await runCli(["reset", "fix/bug#7", "--json"], { cwd: root });
      expect(reset.exitCode).toBe(ExitCode.ok);

      // Every field the result carries survives the trip out as JSON, which is
      // the contract `grove reset --json | jq` is written against.
      expect(JSON.parse(reset.stdout) as ResetJson).toEqual({
        path: worktree,
        dir: "fix/bug-7",
        branch: "fix/bug#7",
        discarded: ["app.txt", "scratch.txt"],
        changed: 2,
        untracked: 1,
        cleaned: false,
        head: (await head(worktree)).slice(0, 7),
        // The snapshot's sha — what `git stash apply` takes — is the one field
        // a script cannot predict, so its shape is what is checked.
        saved: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown as string,
      });
      // The document has stdout to itself; the warning about the untracked file
      // that survived still goes to the person on stderr.
      expect(reset.stderr).toContain("--clean would delete them too");
    });
  });

  test("the exit codes a script branches on: 3 for no such worktree, 4 refused, 7 from git", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "spike");

      // `reset.test.ts` holds each `GroveError` and composes its exit code with
      // `errorToExitCode`. This is the one that lets nothing compose: the
      // binary really does exit 3, 4 and 7, and those are what a wrapper script
      // reads instead of grepping the sentences beside them.
      const nowhere = await runCli(["reset", "nowhere"], { cwd: root });
      expect(nowhere.exitCode).toBe(ExitCode.notARepo);
      expect(nowhere.stderr).toContain('no worktree matches "nowhere"');
      // The error's `details` reach the person as lines under the message —
      // here, the worktrees that do exist.
      expect(nowhere.stderr).toContain("spike  spike");
      expect(nowhere.stdout).toBe("");

      const worktree = join(root, "spike");
      await Bun.write(join(worktree, "app.txt"), "spike\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Spike edit"]);

      const main = join(root, "main");
      await Bun.write(join(main, "app.txt"), "trunk\n");
      await seedGit(main, ["add", "-A"]);
      await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Trunk edit"]);

      // The same line on both sides, so the rebase stops rather than finishing.
      expect((await probeGit(worktree, ["rebase", "main"])).code).not.toBe(0);

      const refused = await runCli(["reset", "spike"], { cwd: root });
      expect(refused.exitCode).toBe(ExitCode.refused);
      expect(refused.stderr).toContain("spike is in the middle of a rebase");
      expect(refused.stderr).toContain("rebase --abort");
      expect(refused.stdout).toBe("");

      const missing = await runCli(["reset", "main", "--to", "nope"], { cwd: root });
      expect(missing.exitCode).toBe(ExitCode.gitFailed);
      // The step that failed and git's own reason under it, both on stderr.
      expect(missing.stderr).toContain("could not reset main");
      expect(missing.stderr).toContain("unknown revision");
      expect(missing.stdout).toBe("");
    });
  }, 60_000);
});
