import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  refused,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { type ExecOutcome, execInWorktrees, execNotes, failureFor, formatExec } from "./exec.ts";

/**
 * `grove exec` over a real repository with real worktrees.
 *
 * Everything worth asserting here is about the fan-out rather than about any
 * one command: that every worktree gets its turn, that the turns come in an
 * order somebody can read, that a failure in one is reported without stopping
 * the rest, and that what each of them said comes back attached to the
 * directory it was said in.
 *
 * The commands run are `git` and `sh`, which the suite already depends on
 * having. Nothing here is about what they do — `git rev-parse --abbrev-ref
 * HEAD` is used because a worktree's own branch is the shortest thing a command
 * can say that is different in every worktree, which is what makes it evidence
 * that the run happened in the right directory.
 */

function attemptExec(
  repo: RepoPaths,
  argv: readonly string[],
  failFast = false,
): Promise<Attempt<readonly ExecOutcome[]>> {
  return attempt((reporter) => execInWorktrees(repo, { argv, failFast }, reporter));
}

/** The fixture every test here starts from: the trunk and two branches. */
async function threeWorktrees(repo: RepoPaths): Promise<void> {
  await seedWorktree(repo, "feat/login");
  await seedWorktree(repo, "fix/crash");
}

describe("grove exec", () => {
  test("runs in every worktree, in directory order, and keeps what each one said", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await threeWorktrees(repo);

      const outcomes = succeeded(
        await attemptExec(repo, ["git", "rev-parse", "--abbrev-ref", "HEAD"]),
      );

      // Directory order, not the order git made them in: two runs over the same
      // repository print their blocks the same way round, so a diff between
      // them is about the command.
      expect(outcomes.map((outcome) => outcome.dir)).toEqual(["feat/login", "fix/crash", "main"]);
      expect(outcomes.map((outcome) => formatExec(outcome))).toEqual([
        "feat/login",
        "fix/crash",
        "main",
      ]);
      expect(outcomes.every((outcome) => outcome.code === 0)).toBe(true);
      expect(failureFor(outcomes)).toBeUndefined();
    });
  });

  test("gives the command the three variables a [setup] command gets", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const outcomes = succeeded(
        await attemptExec(repo, ["sh", "-c", 'echo "$GROVE_BRANCH"; echo "$GROVE_ROOT"']),
      );
      const login = outcomes.find((outcome) => outcome.dir === "feat/login");

      expect(formatExec(login as ExecOutcome)).toBe(`feat/login\n${repo.root}`);
    });
  });

  test("carries on past a worktree the command failed in, and adds up to exit 11", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await threeWorktrees(repo);
      // True everywhere but `fix/crash`, so exactly one of the three fails.
      await Bun.write(join(repo.root, "feat", "login", "marker"), "x\n");
      await Bun.write(join(repo.root, "main", "marker"), "x\n");

      const outcomes = succeeded(await attemptExec(repo, ["test", "-f", "marker"]));

      expect(outcomes.map((outcome) => [outcome.dir, outcome.code])).toEqual([
        ["feat/login", 0],
        ["fix/crash", 1],
        ["main", 0],
      ]);

      // The news is which one, and stopping at it would have hidden the other
      // two — the same rule `sync --all` follows.
      const failure = failureFor(outcomes);
      expect(failure?.message).toBe("the command exited 1 in fix/crash");
      expect(failure?.code).toBe("command-failed");
      expect(errorToExitCode("command-failed")).toBe(ExitCode.commandFailed);
    });
  });

  test("--fail-fast stops at the first failure instead of finishing the round", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await threeWorktrees(repo);

      const outcomes = succeeded(await attemptExec(repo, ["false"], true));

      expect(outcomes.map((outcome) => outcome.dir)).toEqual(["feat/login"]);
      expect(failureFor(outcomes)?.message).toContain("feat/login");
    });
  });

  test("a worktree whose directory is gone is reported, and the rest still run", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      // Deleted behind git's back, which still lists it — the state `doctor`
      // reports. Spawning into it would fail about a path nobody named.
      await rm(join(repo.root, "feat", "login"), { recursive: true, force: true });

      const outcomes = succeeded(await attemptExec(repo, ["true"]));

      expect(outcomes.map((outcome) => [outcome.dir, outcome.skipped])).toEqual([
        ["feat/login", "the directory is gone"],
        ["main", undefined],
      ]);
      // A skip is not a failure: nothing was asked of a directory that is not
      // there, and the exit code is about the command.
      expect(failureFor(outcomes)).toBeUndefined();
    });
  });

  test("a program that is not on PATH is one refusal, not one per worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await threeWorktrees(repo);

      const error = refused(await attemptExec(repo, ["definitely-not-a-real-program-9271"]));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("definitely-not-a-real-program-9271");
      expect(error.hint).toContain("sh -c");
    });
  });

  test("keeps stderr apart from stdout, so a redirect collects only the answers", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const outcomes = succeeded(
        await attemptExec(repo, ["sh", "-c", "echo answer; echo noise >&2"]),
      );
      const only = outcomes[0] as ExecOutcome;

      expect(formatExec(only)).toBe("answer");
      expect(execNotes(only)).toEqual(["noise"]);
    });
  });

  test("refuses an empty command rather than running nothing everywhere", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      expect(refused(await attemptExec(repo, [])).message).toContain("needs a command");
    });
  });
});
