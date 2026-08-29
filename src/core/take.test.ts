import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPlainReporter, type Reporter } from "../report/reporter.ts";
import { type GroveError, isGroveError } from "./errors.ts";
import { pathExists } from "./fs.ts";
import { describeTake, EMPTY_TAKE, takeChanges } from "./take.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";
import { statusOf } from "./worktrees.ts";

/**
 * Two worktrees of one repository, which is the only shape this module has an
 * opinion about. An ordinary clone plus `git worktree add` is the cheapest way
 * to get there, and it is also the layout where a shared `refs/stash` would do
 * the damage this module exists to avoid.
 */
async function twoWorktrees(
  repo: TempRepo,
  { base = "main" }: { readonly base?: string } = {},
): Promise<{ readonly source: string; readonly destination: string }> {
  const source = join(repo.work, "app");
  const destination = join(repo.work, "dest");

  await seedGit(repo.work, ["clone", repo.originUrl, source]);
  await seedGit(source, ["worktree", "add", "-b", "dest", destination, base]);

  return { source, destination };
}

function recorder(): { readonly reporter: Reporter; readonly lines: string[] } {
  const lines: string[] = [];
  const write = (text: string) => {
    lines.push(text.trimEnd());
  };

  return { reporter: createPlainReporter({ out: write, err: write }), lines };
}

/** The stack this module must never push onto, in both worktrees. */
async function stashesAt(worktree: string): Promise<{ ref: boolean; list: string }> {
  const ref = await probeGit(worktree, ["rev-parse", "--verify", "--quiet", "refs/stash"]);
  const list = await seedGit(worktree, ["stash", "list"]);

  return { ref: ref.code === 0, list: list.trim() };
}

async function expectNoStashes(...worktrees: readonly string[]): Promise<void> {
  for (const worktree of worktrees) {
    expect(await stashesAt(worktree)).toEqual({ ref: false, list: "" });
  }
}

async function names(worktree: string, args: readonly string[]): Promise<readonly string[]> {
  const output = (await seedGit(worktree, args)).trim();

  return output.length === 0 ? [] : output.split("\n");
}

async function failure(promise: Promise<unknown>): Promise<GroveError> {
  try {
    await promise;
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected the call to fail");
}

describe("takeChanges", () => {
  test("carries staged, unstaged and untracked work across, and leaves the rest", async () => {
    await withTempRepo(async (repo) => {
      const { source, destination } = await twoWorktrees(repo);
      const { reporter, lines } = recorder();

      // One of each kind of uncommitted thing, so the staged/unstaged split has
      // something to be wrong about.
      await Bun.write(join(source, "app.txt"), "one\ntwo\n");
      await seedGit(source, ["add", "app.txt"]);
      await Bun.write(join(source, "README.md"), "# fixture\n\nedited\n");
      await Bun.write(join(source, "new.txt"), "new\n");
      await Bun.write(join(source, "docs", "nested.txt"), "nested\n");
      // Ignored files belong to the directory, not to the change being carried.
      await Bun.write(join(source, ".git", "info", "exclude"), "secret.txt\n");
      await Bun.write(join(source, "secret.txt"), "hunter2\n");

      const result = await takeChanges(source, destination, reporter);

      expect(result.empty).toBe(false);
      expect(result.tracked).toBe(2);
      // git collapses an untracked directory to one entry, so the whole of
      // `docs/` travels as a single move rather than file by file.
      expect([...result.untracked].sort()).toEqual(["docs/", "new.txt"]);
      expect(result.stash).toMatch(/^[0-9a-f]{40}$/);

      // Staged stays staged and unstaged stays unstaged — the point of `--index`.
      expect(await names(destination, ["diff", "--cached", "--name-only"])).toEqual(["app.txt"]);
      expect(await names(destination, ["diff", "--name-only"])).toEqual(["README.md"]);
      expect(await Bun.file(join(destination, "app.txt")).text()).toBe("one\ntwo\n");
      expect(await Bun.file(join(destination, "new.txt")).text()).toBe("new\n");
      expect(await Bun.file(join(destination, "docs", "nested.txt")).text()).toBe("nested\n");

      // The source is empty-handed afterwards, ignored files excepted.
      expect((await statusOf(source)).dirty).toBe(false);
      expect(await Bun.file(join(source, "app.txt")).text()).toBe("one\n");
      expect(await pathExists(join(source, "new.txt"))).toBe(false);
      expect(await pathExists(join(source, "secret.txt"))).toBe(true);
      expect(await pathExists(join(destination, "secret.txt"))).toBe(false);

      // The whole reason this module exists: the shared stack is untouched.
      await expectNoStashes(source, destination);

      expect(lines).toContain("✓ took 2 changes and 2 untracked files");
    });
  });

  test("needs no snapshot when the only work is untracked", async () => {
    await withTempRepo(async (repo) => {
      const { source, destination } = await twoWorktrees(repo);
      const { reporter } = recorder();

      await Bun.write(join(source, "notes.txt"), "notes\n");

      const result = await takeChanges(source, destination, reporter);

      // `stash create` has nothing to record, and says so with an empty answer.
      expect(result.stash).toBeUndefined();
      expect(result.tracked).toBe(0);
      expect(result.untracked).toEqual(["notes.txt"]);

      expect(await Bun.file(join(destination, "notes.txt")).text()).toBe("notes\n");
      expect(await pathExists(join(source, "notes.txt"))).toBe(false);
      await expectNoStashes(source, destination);
    });
  });

  test("does nothing at all when the source is clean", async () => {
    await withTempRepo(async (repo) => {
      const { source, destination } = await twoWorktrees(repo);
      const { reporter, lines } = recorder();

      expect(await takeChanges(source, destination, reporter)).toBe(EMPTY_TAKE);
      // Nothing was worth reporting, so no step was opened either.
      expect(lines).toEqual([]);
      await expectNoStashes(source, destination);
    });
  });

  test("refuses a destination that has uncommitted work of its own", async () => {
    await withTempRepo(async (repo) => {
      const { source, destination } = await twoWorktrees(repo);
      const { reporter } = recorder();

      await Bun.write(join(source, "app.txt"), "mine\n");
      await Bun.write(join(destination, "app.txt"), "theirs\n");

      const error = await failure(takeChanges(source, destination, reporter));
      expect(error.code).toBe("refused");
      expect(error.message).toContain("uncommitted changes");

      // Refused before anything was snapshotted, so both sides are as they were.
      expect(await Bun.file(join(source, "app.txt")).text()).toBe("mine\n");
      expect(await Bun.file(join(destination, "app.txt")).text()).toBe("theirs\n");
      await expectNoStashes(source, destination);
    });
  });

  test("leaves both worktrees untouched when the changes will not apply", async () => {
    await withTempRepo(async (repo) => {
      const source = join(repo.work, "app");
      await seedGit(repo.work, ["clone", repo.originUrl, source]);

      // The destination edits the same line, so the three-way apply must conflict.
      await seedGit(source, ["checkout", "-b", "other"]);
      await Bun.write(join(source, "app.txt"), "theirs\n");
      await seedGit(source, ["add", "-A"]);
      await seedGit(source, ["-c", "commit.gpgsign=false", "commit", "-m", "Edit app.txt"]);
      await seedGit(source, ["checkout", "main"]);

      const destination = join(repo.work, "dest");
      await seedGit(source, ["worktree", "add", destination, "other"]);
      const { reporter, lines } = recorder();

      await Bun.write(join(source, "app.txt"), "mine\n");
      await Bun.write(join(source, "keep.txt"), "keep\n");

      const error = await failure(takeChanges(source, destination, reporter));

      expect(error.code).toBe("rebase-conflict");
      expect(error.message).toContain("did not apply cleanly");
      expect(lines).toContain("✗ could not take the uncommitted changes");

      // The hint names a sha, and the sha is a real commit holding the work.
      const sha = /saved as ([0-9a-f]{40})/.exec(error.hint ?? "")?.[1];
      expect(sha).toBeDefined();
      if (sha === undefined) throw new Error("no recovery sha in the hint");

      expect((await seedGit(source, ["cat-file", "-t", sha])).trim()).toBe("commit");
      expect(await seedGit(source, ["show", `${sha}:app.txt`])).toBe("mine\n");

      // Nothing moved: the source still holds everything it held...
      expect(await Bun.file(join(source, "app.txt")).text()).toBe("mine\n");
      expect(await pathExists(join(source, "keep.txt"))).toBe(true);
      expect((await statusOf(source)).dirty).toBe(true);

      // ...and the destination is not left full of conflict markers.
      expect(await names(destination, ["status", "--porcelain"])).toEqual([]);
      expect(await Bun.file(join(destination, "app.txt")).text()).toBe("theirs\n");
      expect(await pathExists(join(destination, "keep.txt"))).toBe(false);

      // The recovery commit is reachable by sha alone, and by nothing else.
      await expectNoStashes(source, destination);
    });
  });
});

describe("describeTake", () => {
  test("counts in words, singular and plural", () => {
    expect(describeTake(EMPTY_TAKE)).toBe("nothing to take");
    expect(describeTake({ tracked: 1, untracked: [], empty: false })).toBe("took 1 change");
    expect(describeTake({ tracked: 2, untracked: [], empty: false })).toBe("took 2 changes");
    expect(describeTake({ tracked: 1, untracked: ["a"], empty: false })).toBe(
      "took 1 change and 1 untracked file",
    );
    expect(describeTake({ tracked: 0, untracked: ["a", "b"], empty: false })).toBe(
      "took 0 changes and 2 untracked files",
    );
  });

  test("EMPTY_TAKE is the shape a caller can print without checking", () => {
    expect(EMPTY_TAKE).toEqual({ tracked: 0, untracked: [], empty: true });
  });
});
