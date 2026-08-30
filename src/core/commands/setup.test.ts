import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import { HOOKS_FILE, type SetupResult } from "../../hooks/index.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { failureFor, setUpWorktrees } from "./setup.ts";

/**
 * `.grove.toml`'s `[setup]`, run in a worktree that already exists.
 *
 * The scenario every test here builds is the one the command was added for: a
 * worktree made before the file said what it now says. So the worktree comes
 * first and the configuration second, in that order — a fixture that wrote the
 * file before the `add` would be testing `add`.
 *
 * `hooks/setup.test.ts` is where what a `copy` line reaches and what a `link`
 * points at are pinned down. This file is only about the command around it:
 * which worktrees it picks, that it re-runs at all, that it opens nothing, and
 * what it adds up to when a command fails in one of several.
 */

function attemptSetup(
  repo: RepoPaths,
  options: { target?: string; all?: boolean; trust?: boolean } = {},
): Promise<Attempt<readonly SetupResult[]>> {
  const { target, all = false, trust = false } = options;

  return attempt((reporter) => setUpWorktrees(repo, repo.root, { target, all, trust }, reporter));
}

/** The trunk's file, which is the one that governs every worktree. */
function configure(repo: RepoPaths, text: string): Promise<number> {
  return Bun.write(join(repo.root, "main", HOOKS_FILE), text);
}

describe("grove setup", () => {
  test("fills in a worktree from a file that arrived after it did", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      // The worktree was made before any of this was true — which is the whole
      // case, and the one `add` cannot answer for.
      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=1\n");
      await configure(repo, '[setup]\ncopy = [".env"]\n');

      const results = succeeded(await attemptSetup(repo, { target: "feat/login" }));

      expect(results).toHaveLength(1);
      expect(results[0]?.copied).toEqual([".env"]);
      expect(await Bun.file(join(worktree, ".env")).text()).toBe("TOKEN=1\n");
    });
  });

  test("running it again takes the trunk's version over the stale copy", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=1\n");
      await configure(repo, '[setup]\ncopy = [".env"]\n');
      succeeded(await attemptSetup(repo, { target: "feat/login" }));

      // The credential was rotated in the one copy every worktree reads from.
      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=2\n");
      const again = succeeded(await attemptSetup(repo, { target: "feat/login" }));

      expect(again[0]?.overwritten).toEqual([".env"]);
      expect(await Bun.file(join(worktree, ".env")).text()).toBe("TOKEN=2\n");
    });
  });

  test("--all fills in every worktree, the trunk included and unharmed", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await seedWorktree(repo, "fix/crash");

      await Bun.write(join(repo.root, "main", ".env"), "TOKEN=1\n");
      await configure(repo, '[setup]\ncopy = [".env"]\n');

      const results = succeeded(await attemptSetup(repo, { all: true }));

      expect(results.map((result) => result.dir).toSorted()).toEqual([
        "feat/login",
        "fix/crash",
        "main",
      ]);
      for (const dir of [["feat", "login"], ["fix", "crash"], ["main"]]) {
        expect(await Bun.file(join(repo.root, ...dir, ".env")).text()).toBe("TOKEN=1\n");
      }
    });
  });

  test("opens nothing, whatever the file says to open with", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await configure(repo, '[setup]\nopen = "true"\n');

      const run = await attemptSetup(repo, { target: "feat/login", trust: true });
      const results = succeeded(run);

      // Not refused and not reported — an `--all` over eleven worktrees would
      // be eleven editor windows, so opening is simply not this command's half.
      expect(results[0]?.opened).toBeUndefined();
      expect(run.log.err.join("")).not.toContain("did not open");
      expect(run.log.err.join("")).not.toContain("opening");
    });
  });

  test("holds the commands back until --trust, and then runs them", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");
      await configure(repo, '[setup]\nrun = ["touch installed"]\n');

      // Committed, because that is what the gate is about: a `run` line waits
      // for `--trust` when a `git pull` could have written it, and an untracked
      // file of your own is not one of those.
      const trunk = join(repo.root, "main");
      await seedGit(trunk, ["add", "-A"]);
      await seedGit(trunk, ["-c", "commit.gpgsign=false", "commit", "-m", "Add .grove.toml"]);

      const held = succeeded(await attemptSetup(repo, { target: "feat/login" }));
      expect(held[0]?.untrusted).toBe(true);
      expect(held[0]?.ran).toEqual([]);
      expect(await Bun.file(join(worktree, "installed")).exists()).toBe(false);

      const run = succeeded(await attemptSetup(repo, { target: "feat/login", trust: true }));
      expect(run[0]?.ran).toEqual(["touch installed"]);
      expect(await Bun.file(join(worktree, "installed")).exists()).toBe(true);
    });
  });

  test("a failed command is reported per worktree and adds up to exit 9", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await configure(repo, '[setup]\nrun = ["exit 3"]\n');

      const results = succeeded(await attemptSetup(repo, { all: true, trust: true }));
      const failure = failureFor(results);

      // Every worktree still had its turn — the run is not abandoned at the
      // first one — and the exit code is the one a script branches on.
      expect(results).toHaveLength(2);
      expect(failure?.message).toContain("2 worktrees");
      expect(failure?.code).toBe("setup-failed");
      expect(errorToExitCode("setup-failed")).toBe(ExitCode.setupFailed);
    });
  });

  test("refuses when it is neither given a target nor standing in a worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // The repository root is not a worktree in a managed layout, which is
      // exactly where somebody types this by mistake.
      const error = refused(
        await attempt((reporter) =>
          setUpWorktrees(repo, repo.root, { all: false, trust: false }, reporter),
        ),
      );

      expect(error.code).toBe("usage");
      expect(error.hint).toContain("--all");
    });
  });
});
