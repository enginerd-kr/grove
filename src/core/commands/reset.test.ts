import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../ui/e2e-utils.ts";
import { pathExists } from "../fs.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove reset` against a real repository.
 *
 * `git reset --hard` semantics are the contract, so the assertions are about
 * files on disk and what `git status` says afterwards — not about the summary
 * the command prints, which could be right while the tree was wrong.
 */

/** Exit codes from `cli/exit-codes.ts`, spelled out so a change to them is loud. */
const NOT_A_REPO = 3;
const REFUSED = 4;
const GIT_FAILED = 7;

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
};

async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);

  return join(repo.work, "origin");
}

async function status(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["status", "--porcelain"])).stdout;
}

async function head(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("grove reset", () => {
  test("discards tracked changes, leaves untracked files until --clean, and never touches ignored ones", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "feat", "login");
      // Committed, so the ignore rule is part of the tree the reset restores
      // rather than another untracked file confusing the counts.
      await Bun.write(join(worktree, ".gitignore"), "ignored.txt\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Ignore something"]);
      const before = await head(worktree);

      await Bun.write(join(worktree, "login.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");
      await Bun.write(join(worktree, "junk", "output.bin"), "junk\n");
      await Bun.write(join(worktree, "ignored.txt"), "ignored\n");

      const reset = await runCli(["reset", "feat/login"], { cwd: root });
      expect(reset.exitCode).toBe(0);

      // The tracked edit is gone and the branch has not moved.
      expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("login\n");
      expect(await head(worktree)).toBe(before);

      // Everything git was not tracking is exactly where it was, and the
      // command says so rather than leaving a still-dirty dot to be puzzled at.
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
      expect(await pathExists(join(worktree, "junk", "output.bin"))).toBe(true);
      expect(reset.stderr).toContain("--clean would delete them too");
      expect(await status(worktree)).toBe("?? junk/\n?? scratch.txt\n");

      const cleaned = await runCli(["reset", "feat/login", "--clean"], { cwd: root });
      expect(cleaned.exitCode).toBe(0);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(false);
      // `clean -fd` — the directory goes too, which is the usual reason a
      // worktree is still dirty after a reset.
      expect(await pathExists(join(worktree, "junk"))).toBe(false);
      expect(await status(worktree)).toBe("");

      // No `-x`, so an ignored file survives both: it is not what "throw away
      // my changes" means, and git's own `clean` draws the line in the same place.
      expect(await pathExists(join(worktree, "ignored.txt"))).toBe(true);
    });
  });

  test("--to <ref> drops the commits as well as the changes", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "spike");
      const trunk = await head(join(root, "main"));

      for (const name of ["one", "two"]) {
        await Bun.write(join(worktree, `${name}.txt`), `${name}\n`);
        await seedGit(worktree, ["add", "-A"]);
        await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${name}`]);
      }
      await Bun.write(join(worktree, "app.txt"), "edited\n");

      const reset = await runCli(["reset", "spike", "--to", "main"], { cwd: root });
      expect(reset.exitCode).toBe(0);
      // `<path>\t<short head>` on stdout, which is what a script reads.
      expect(reset.stdout.trim().split("\t")[1]).toBe(trunk.slice(0, 7));

      expect(await head(worktree)).toBe(trunk);
      expect(await pathExists(join(worktree, "one.txt"))).toBe(false);
      expect(await pathExists(join(worktree, "two.txt"))).toBe(false);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("one\n");
      expect(await status(worktree)).toBe("");
    });
  });

  test("a target is a branch, a directory, a path, or where you are standing", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      // A branch whose directory is not spelled the same way, so the two
      // lookups are told apart rather than both happening to match.
      expect((await runCli(["add", "fix/bug#7"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "fix", "bug-7");
      const spellings: readonly [string, string][] = [
        ["fix/bug#7", root],
        ["fix/bug-7", root],
        [worktree, root],
        [".", worktree],
      ];

      for (const [target, cwd] of spellings) {
        await Bun.write(join(worktree, "app.txt"), "edited\n");

        const reset = await runCli(["reset", target, "--json"], { cwd });
        expect([target, reset.exitCode, reset.stderr]).toEqual([target, 0, reset.stderr]);

        const parsed = JSON.parse(reset.stdout) as ResetJson;
        expect(parsed.path).toBe(worktree);
        expect(parsed.branch).toBe("fix/bug#7");
        expect(parsed.changed).toBe(1);
        expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("one\n");
      }

      // And a name that matches nothing is the discovery error, not a reset of
      // whatever the shell happened to be standing in.
      const nowhere = await runCli(["reset", "nowhere"], { cwd: root });
      expect(nowhere.exitCode).toBe(NOT_A_REPO);
      expect(nowhere.stderr).toContain('no worktree matches "nowhere"');
      expect(nowhere.stderr).toContain("fix/bug#7");
    });
  });

  test("refuses a worktree stopped in a rebase, and leaves the rebase where it was", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);

      // The same line changed on both sides, so the rebase stops rather than
      // finishing and leaving nothing to refuse.
      const worktree = join(root, "spike");
      await Bun.write(join(worktree, "app.txt"), "spike\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Spike edit"]);

      const main = join(root, "main");
      await Bun.write(join(main, "app.txt"), "trunk\n");
      await seedGit(main, ["add", "-A"]);
      await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Trunk edit"]);

      expect((await probeGit(worktree, ["rebase", "main"])).code).not.toBe(0);

      const refused = await runCli(["reset", "spike"], { cwd: root });

      // Not overridable, and for a reason the message gives: a reset here
      // abandons the half-applied commits somewhere only the reflog remembers.
      expect(refused.exitCode).toBe(REFUSED);
      expect(refused.stderr).toContain("spike is in the middle of a rebase");
      expect(refused.stderr).toContain("rebase --abort");
      expect(await Bun.file(join(worktree, "app.txt")).text()).toContain("<<<<<<<");

      // Still stopped mid-rebase: the abort the hint names is still there to run.
      expect((await probeGit(worktree, ["rebase", "--abort"])).code).toBe(0);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("spike\n");
    });
  });

  test("--to a ref that does not exist fails without throwing anything away", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "spike");
      const before = await head(worktree);
      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await Bun.write(join(worktree, "scratch.txt"), "scratch\n");

      const missing = await runCli(["reset", "spike", "--to", "nope"], { cwd: root });

      expect(missing.exitCode).toBe(GIT_FAILED);
      expect(missing.stderr).toContain("could not reset spike");
      expect(missing.stderr).toContain("unknown revision");

      // The changes the command was about to destroy are all still here, which
      // is the only interesting thing about a reset that did not run.
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("edited\n");
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
      expect(await head(worktree)).toBe(before);

      // --clean is not reached either: the reset throws before it runs.
      const cleaned = await runCli(["reset", "spike", "--to", "nope", "--clean"], { cwd: root });
      expect(cleaned.exitCode).toBe(GIT_FAILED);
      expect(await pathExists(join(worktree, "scratch.txt"))).toBe(true);
    });
  });

  test("a clean worktree is nothing to do, and a big change is counted rather than listed", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);
      const worktree = join(root, "spike");

      const quiet = await runCli(["reset", "spike", "--json"], { cwd: root });
      expect(quiet.exitCode).toBe(0);

      const nothing = JSON.parse(quiet.stdout) as ResetJson;
      expect([nothing.changed, nothing.untracked, nothing.discarded]).toEqual([0, 0, []]);
      expect(nothing.head).toBe((await head(worktree)).slice(0, 7));
      // No warning, because there is nothing a --clean would have taken either.
      expect(quiet.stderr).not.toContain("--clean");

      const names = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
      for (const name of names) {
        await Bun.write(join(worktree, `${name}.txt`), "committed\n");
      }
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Seven files"]);
      for (const name of names) await Bun.write(join(worktree, `${name}.txt`), "edited\n");

      const many = await runCli(["reset", "spike", "--json"], { cwd: root });
      expect(many.exitCode).toBe(0);

      const parsed = JSON.parse(many.stdout) as ResetJson;
      // Enough to recognise what went, and a count for the rest — this is for
      // reading, not for auditing.
      expect(parsed.changed).toBe(7);
      expect(parsed.discarded).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]);
    });
  });

  test("--clean takes untracked directories and counts them apart from the changes", async () => {
    await withTempRepo(async (repo) => {
      const root = await managed(repo);
      expect((await runCli(["add", "spike"], { cwd: root })).exitCode).toBe(0);

      const worktree = join(root, "spike");
      await Bun.write(join(worktree, ".gitignore"), "build/\n");
      await seedGit(worktree, ["add", "-A"]);
      await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Ignore build"]);

      await Bun.write(join(worktree, "app.txt"), "edited\n");
      await mkdir(join(worktree, "build"), { recursive: true });
      await Bun.write(join(worktree, "build", "artifact.bin"), "expensive\n");
      await Bun.write(join(worktree, "scratch", "note.txt"), "note\n");

      const cleaned = await runCli(["reset", "spike", "--clean", "--json"], { cwd: root });
      expect(cleaned.exitCode).toBe(0);

      const parsed = JSON.parse(cleaned.stdout) as ResetJson;
      // Counted apart, because they are destroyed by different commands and one
      // of them is work git has never seen a copy of.
      expect([parsed.changed, parsed.untracked, parsed.cleaned]).toEqual([2, 1, true]);
      expect(parsed.discarded).toContain("app.txt");
      expect(parsed.discarded).toContain("scratch/");

      expect(await pathExists(join(worktree, "scratch"))).toBe(false);
      // `clean -fd` and not `-fdx`: an ignored build tree is not what "throw
      // away my changes" means, and re-making it is the expensive part.
      expect(await Bun.file(join(worktree, "build", "artifact.bin")).text()).toBe("expensive\n");
    });
  });
});
