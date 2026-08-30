import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import { pathExists } from "../fs.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { type ResetResult, resetWorktree } from "./reset.ts";

/**
 * `grove reset` against a real repository.
 *
 * `git reset --hard` semantics are the contract, so the assertions are about
 * files on disk and what `git status` says afterwards — not about the summary
 * the command prints, which could be right while the tree was wrong.
 *
 * `resetWorktree` is called directly, with the `RepoPaths` a clone would have
 * produced and a recording reporter, for the reason `cli/run.test.ts` calls
 * `runCommand` that way: the repository is the part that has to be real, and a
 * process around it buys nothing but latency. It also costs coverage. This
 * command's whole job is to say what it destroyed, and through the binary that
 * answer was only readable by asking for `--json` — so the counts were checked
 * where the document happened to be under test and nowhere else. Holding the
 * `ResetResult` makes them assertable everywhere, and holding the `GroveError`
 * separates the two failures that both arrive as a line of stderr: the refusal
 * this command makes, and git's own refusal underneath it.
 *
 * What still goes through the binary is in `reset.e2e.test.ts`: the row on
 * stdout, the `--json` document, and the exit codes a script branches on.
 */

type ResetCall = {
  /** What to reset to. Absent means the worktree's own HEAD. */
  readonly to?: string;
  readonly clean?: boolean;
  /** Where the reset is asked from. Defaults to the repository root. */
  readonly cwd?: string;
};

/** Resets, and hands back whichever of the two outcomes happened. */
function attemptReset(
  repo: RepoPaths,
  target: string,
  { to, clean = false, cwd = repo.root }: ResetCall = {},
): Promise<Attempt<ResetResult>> {
  return attempt((reporter) => resetWorktree(repo, cwd, { target, to, clean }, reporter));
}

async function status(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["status", "--porcelain"])).stdout;
}

async function head(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

/** A commit in the worktree, so a `--to` has something to drop. */
async function commit(worktree: string, message: string): Promise<void> {
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

describe("grove reset", () => {
  test("discards tracked changes, leaves untracked files until --clean, and never touches ignored ones", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const worktree = join(repo.root, "feat", "login");
      // Committed, so the ignore rule is part of the tree the reset restores
      // rather than another untracked file confusing the counts.
      await Bun.write(join(worktree, ".gitignore"), "ignored.txt\n");
      await commit(worktree, "Ignore something");
      const before = await head(worktree);

      await Bun.write(join(worktree, "login.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");
      await Bun.write(join(worktree, "junk", "output.bin"), "junk\n");
      await Bun.write(join(worktree, "ignored.txt"), "ignored\n");

      const outcome = await attemptReset(repo, "feat/login");

      // The whole result, field by field — what "exit 0" was standing in for,
      // and the count of what was about to be destroyed, which is the one
      // number worth reading before the tree has already changed.
      expect(succeeded(outcome)).toEqual({
        path: worktree,
        dir: "feat/login",
        branch: "feat/login",
        discarded: ["login.txt", "junk/", "scratch.txt"],
        changed: 3,
        // Two of the three, and the ignored file is in neither: it is not what
        // "throw away my changes" means, and git's `status` agrees.
        untracked: 2,
        cleaned: false,
        head: before.slice(0, 7),
      });

      // The tracked edit is gone and the branch has not moved.
      expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("login\n");
      expect(await head(worktree)).toBe(before);

      // Everything git was not tracking is exactly where it was, and the
      // command says so rather than leaving a still-dirty dot to be puzzled at.
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
      expect(await pathExists(join(worktree, "junk", "output.bin"))).toBe(true);
      // The whole sentence, counted and addressed to the worktree by name —
      // a `toContain` on stderr only ever checked the last clause of it.
      expect(outcome.log.err).toContain(
        "! feat/login still has 2 untracked file(s); --clean would delete them too\n",
      );
      expect(await status(worktree)).toBe("?? junk/\n?? scratch.txt\n");
      // A result never goes through the reporter, whatever is narrated.
      expect(outcome.log.out).toEqual([]);

      const cleanedOutcome = await attemptReset(repo, "feat/login", { clean: true });
      const cleaned = succeeded(cleanedOutcome);

      expect([cleaned.changed, cleaned.untracked, cleaned.cleaned]).toEqual([2, 2, true]);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(false);
      // `clean -fd` — the directory goes too, which is the usual reason a
      // worktree is still dirty after a reset.
      expect(await pathExists(join(worktree, "junk"))).toBe(false);
      expect(await status(worktree)).toBe("");
      // Nothing survived, so there is nothing to warn about — the warning is
      // for the files a reset left behind, not for the ones it took.
      expect(cleanedOutcome.log.err.join("")).not.toContain("--clean would delete them too");

      // No `-x`, so an ignored file survives both: it is not what "throw away
      // my changes" means, and git's own `clean` draws the line in the same place.
      expect(await pathExists(join(worktree, "ignored.txt"))).toBe(true);
    });
  });

  test("--to <ref> drops the commits as well as the changes", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");

      const worktree = join(repo.root, "spike");
      const trunk = await head(join(repo.root, "main"));

      for (const name of ["one", "two"]) {
        await Bun.write(join(worktree, `${name}.txt`), `${name}\n`);
        await commit(worktree, `Add ${name}`);
      }
      await Bun.write(join(worktree, "app.txt"), "edited\n");

      const result = succeeded(await attemptReset(repo, "spike", { to: "main" }));

      // Where it ended up, so a rewind can be found again in the reflog — and
      // it is the trunk's commit, not the two this branch had.
      expect(result.head).toBe(trunk.slice(0, 7));
      expect(await head(worktree)).toBe(trunk);
      expect(await pathExists(join(worktree, "one.txt"))).toBe(false);
      expect(await pathExists(join(worktree, "two.txt"))).toBe(false);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("one\n");
      expect(await status(worktree)).toBe("");
    });
  });

  test("a target is a branch, a directory, a path, or where you are standing", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      // A branch whose directory is not spelled the same way, so the two
      // lookups are told apart rather than both happening to match.
      await seedWorktree(repo, "fix/bug#7");

      const worktree = join(root, "fix", "bug-7");
      const spellings: readonly [string, string][] = [
        ["fix/bug#7", root],
        ["fix/bug-7", root],
        [worktree, root],
        [".", worktree],
      ];

      for (const [target, cwd] of spellings) {
        await Bun.write(join(worktree, "app.txt"), "edited\n");

        const result = succeeded(await attemptReset(repo, target, { cwd }));

        // Every spelling resolves to the one record, so every one of them
        // answers with the same path, the same branch, and the same count —
        // `[target, …]` so a failure names which spelling was being tried.
        expect([target, result.path, result.branch, result.dir, result.changed]).toEqual([
          target,
          worktree,
          "fix/bug#7",
          "fix/bug-7",
          1,
        ]);
        expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("one\n");
      }

      // And a name that matches nothing is the discovery error, not a reset of
      // whatever the shell happened to be standing in.
      const outcome = await attemptReset(repo, "nowhere");
      const nowhere = refused(outcome);

      expect(nowhere.code).toBe("not-a-repo");
      expect(errorToExitCode(nowhere.code)).toBe(ExitCode.notARepo);
      expect(nowhere.message).toBe('no worktree matches "nowhere"');
      expect(nowhere.hint).toBe("run `grove list` to see what is there");
      // What there *is* instead, as a list rather than a paragraph: branch and
      // directory for every worktree, which is the answer to the question the
      // typo was asking. Sorted here because the order is git's listing order.
      expect([...nowhere.details].sort()).toEqual(["fix/bug#7  fix/bug-7", "main  main"]);
      // Nothing was begun: the lookup fails before the step is opened, so a
      // spinner never appears for a worktree that does not exist.
      expect(outcome.log.err).toEqual([]);
    });
  });

  test("refuses a worktree stopped in a rebase, and leaves the rebase where it was", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "spike");

      // The same line changed on both sides, so the rebase stops rather than
      // finishing and leaving nothing to refuse.
      const worktree = join(root, "spike");
      await Bun.write(join(worktree, "app.txt"), "spike\n");
      await commit(worktree, "Spike edit");

      const main = join(root, "main");
      await Bun.write(join(main, "app.txt"), "trunk\n");
      await commit(main, "Trunk edit");

      expect((await probeGit(worktree, ["rebase", "main"])).code).not.toBe(0);

      const outcome = await attemptReset(repo, "spike");
      const rebasing = refused(outcome);

      // Not overridable, and for a reason the message gives: a reset here
      // abandons the half-applied commits somewhere only the reflog remembers.
      expect(rebasing.code).toBe("refused");
      expect(errorToExitCode(rebasing.code)).toBe(ExitCode.refused);
      // Named `spike` and not `(detached)`, which is what git calls a worktree
      // mid-rebase: the refusal is about the branch the user is thinking of.
      expect(rebasing.message).toBe("spike is in the middle of a rebase");
      // The whole hint, which is a command that can be pasted — a `toContain`
      // on stderr never checked that the `-C` pointed at the right worktree.
      expect(rebasing.hint).toBe(`finish or abandon it first: git -C ${worktree} rebase --abort`);
      // Refused before `reset --hard` was reached, and before the step that
      // would run it was even opened.
      expect(outcome.log.err).toEqual([]);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toContain("<<<<<<<");

      // Still stopped mid-rebase: the abort the hint names is still there to run.
      expect((await probeGit(worktree, ["rebase", "--abort"])).code).toBe(0);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("spike\n");
    });
  });

  test("--to a ref that does not exist fails without throwing anything away", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");

      const worktree = join(repo.root, "spike");
      const before = await head(worktree);
      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");

      const outcome = await attemptReset(repo, "spike", { to: "nope" });
      const missing = refused(outcome);

      // git's failure, not one of ours: the ref was this tool's to pass along
      // and not to validate, so the code is the generic one and the reason
      // underneath it is git's own words — provably carried rather than
      // invented, which one stderr blob could never have shown.
      expect(missing.code).toBe("git-failed");
      expect(errorToExitCode(missing.code)).toBe(ExitCode.gitFailed);
      expect(missing.message).toBe("git reset --hard nope failed (exit 128)");
      expect(missing.details.join("\n")).toContain("unknown revision");
      // The step was opened and then failed, which is what says the command got
      // as far as running git rather than refusing on its own account.
      expect(outcome.log.err).toEqual(["· resetting spike\n", "✗ could not reset spike\n"]);

      // The changes the command was about to destroy are all still here, which
      // is the only interesting thing about a reset that did not run.
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("edited\n");
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
      expect(await head(worktree)).toBe(before);

      // --clean is not reached either: the reset throws before it runs.
      const cleaned = refused(await attemptReset(repo, "spike", { to: "nope", clean: true }));
      expect(cleaned.code).toBe("git-failed");
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
    });
  });

  test("a clean worktree is nothing to do, and a big change is counted rather than listed", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      const quiet = await attemptReset(repo, "spike");
      const nothing = succeeded(quiet);

      expect([nothing.changed, nothing.untracked, nothing.discarded]).toEqual([0, 0, []]);
      expect(nothing.head).toBe((await head(worktree)).slice(0, 7));
      // No warning, because there is nothing a --clean would have taken either.
      expect(quiet.log.err.join("")).not.toContain("--clean");
      // The step still ran and still settled: "nothing to do" is a reset that
      // happened, not one that was skipped.
      expect(quiet.log.err).toEqual(["· resetting spike\n", "✓ reset spike\n"]);

      const names = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
      for (const name of names) {
        await Bun.write(join(worktree, `${name}.txt`), "committed\n");
      }
      await commit(worktree, "Seven files");
      for (const name of names) await Bun.write(join(worktree, `${name}.txt`), "edited\n");

      const parsed = succeeded(await attemptReset(repo, "spike"));

      // Enough to recognise what went, and a count for the rest — this is for
      // reading, not for auditing.
      expect(parsed.changed).toBe(7);
      expect(parsed.discarded).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]);
    });
  });

  test("--clean takes untracked directories and counts them apart from the changes", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "spike");

      const worktree = join(repo.root, "spike");
      await Bun.write(join(worktree, ".gitignore"), "build/\n");
      await commit(worktree, "Ignore build");

      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await mkdir(join(worktree, "build"), { recursive: true });
      await Bun.write(join(worktree, "build", "artifact.bin"), "expensive\n");
      await Bun.write(join(worktree, "scratch", "note.txt"), "note\n");

      const cleaned = succeeded(await attemptReset(repo, "spike", { clean: true }));

      // Counted apart, because they are destroyed by different commands and one
      // of them is work git has never seen a copy of.
      expect([cleaned.changed, cleaned.untracked, cleaned.cleaned]).toEqual([2, 1, true]);
      expect(cleaned.discarded).toContain("app.txt");
      expect(cleaned.discarded).toContain("scratch/");

      expect(await pathExists(join(worktree, "scratch"))).toBe(false);
      // `clean -fd` and not `-fdx`: an ignored build tree is not what "throw
      // away my changes" means, and re-making it is the expensive part.
      expect(await Bun.file(join(worktree, "build", "artifact.bin")).text()).toBe("expensive\n");
    });
  });
});
