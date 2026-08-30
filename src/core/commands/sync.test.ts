import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import type { GroveError } from "../errors.ts";
import type { RepoPaths } from "../layout.ts";
import { readStack } from "../stack.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  recorder,
  seedGit,
  seedWorktree,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { failureFor, type SyncOutcome, syncWorktrees } from "./sync.ts";

/**
 * `grove sync` against a real origin.
 *
 * The origin is a real bare repository rather than a stub, because the half of
 * this command a local-only test would miss is the push: a rebase that is never
 * published is the exact failure the push was added for, and the only way to
 * tell the two apart is to ask the origin where its branch is.
 *
 * `syncWorktrees` is called directly, with a recording reporter, for the reason
 * `rename.test.ts` gives: the repository is the part that has to be real, and a
 * process around it buys nothing but latency. Here it also buys back coverage
 * this command had no way to express through the binary. `sync` does not throw
 * on a bad outcome — it returns a `SyncOutcome` per worktree and `failureFor`
 * derives the one error from them — so through the CLI the only evidence of
 * *which* worktree went wrong, and *how*, was an exit code and whatever prose
 * the error happened to compose. Holding the outcomes is what distinguishes
 * "the push was never attempted" (`pushed` absent) from "the remote refused it"
 * (`pushed: false`), which are the same exit code and, with `--no-push`, very
 * nearly the same screen.
 *
 * What still goes through the binary is what only the binary does: the
 * tab-separated row per worktree, the rule that those rows are printed even
 * when the run then fails, and the exit code a wrapper script branches on.
 * Those live in `cli/run.ts`, so they are in `sync.e2e.test.ts`.
 */

let scratchCount = 0;

/**
 * Somebody else's commit, made and pushed from outside the managed repository.
 *
 * A throwaway clone rather than a second worktree in the repo under test: the
 * point is that the origin moved on its own, and a commit made inside the tree
 * being synced would not be that.
 */
async function commitOnOrigin(
  temp: TempRepo,
  branch: string,
  file: string,
  contents: string,
): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);
  await seedGit(temp.root, ["clone", "--branch", branch, temp.originPath, scratch]);
  await Bun.write(join(scratch, file), contents);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", `HEAD:${branch}`]);
  await rm(scratch, { recursive: true, force: true });
}

async function commitIn(worktree: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(worktree, file), contents);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

async function head(cwd: string, ref = "HEAD"): Promise<string> {
  return (await probeGit(cwd, ["rev-parse", ref])).stdout.trim();
}

/** True when a rebase is stopped part-way through in this worktree. */
async function isRebasing(worktree: string): Promise<boolean> {
  const state = await probeGit(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  ]);

  return state.code === 0 && (await Bun.file(join(state.stdout.trim(), "head-name")).exists());
}

/** The flags `cli/args.ts` hands `syncWorktrees`, with its own defaults. */
type SyncCall = {
  readonly target?: string;
  readonly all?: boolean;
  readonly abortOnConflict?: boolean;
  readonly push?: boolean;
  /** Where the sync is asked from. Defaults to the repository root. */
  readonly cwd?: string;
};

function attemptSync(
  repo: RepoPaths,
  { target, all = false, abortOnConflict = true, push = true, cwd = repo.root }: SyncCall = {},
): Promise<Attempt<readonly SyncOutcome[]>> {
  return attempt((reporter) =>
    syncWorktrees(repo, cwd, { target, all, abortOnConflict, push }, reporter),
  );
}

/**
 * The error the outcomes add up to, insisting there is one.
 *
 * `refused()` cannot be used on this command: nothing is thrown, so a test that
 * expected a failure and got a clean run would otherwise read the empty
 * `failureFor` answer as "no error to check" and pass.
 */
function failure(outcomes: readonly SyncOutcome[]): GroveError {
  const error = failureFor(outcomes);
  if (error === undefined) {
    throw new Error("expected these outcomes to add up to a failure, and they did not");
  }

  return error;
}

describe("grove sync", () => {
  test("fast-forwards the default branch, and rebases then plainly pushes it when it has commits of its own", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");

      await commitOnOrigin(temp, "main", "remote-one.txt", "one\n");

      const forward = await attemptSync(repo, { target: "main" });
      const forwarded = succeeded(forward);

      // The whole outcome, field by field — what "exit 0, stdout said
      // fast-forwarded" was standing in for. `pushed` is absent rather than
      // false: a fast-forward publishes nothing, because nothing local moved.
      expect(forwarded).toEqual([
        { path: main, dir: "main", branch: "main", kind: "fast-forwarded", onto: "origin/main" },
      ]);
      expect(failureFor(forwarded)).toBeUndefined();
      expect(await Bun.file(join(main, "remote-one.txt")).text()).toBe("one\n");

      // The fetch happened and said so, which is the precondition for the trunk
      // below being current rather than remembered.
      expect(forward.log.err.join("")).toContain("✓ fetched");
      expect(forward.log.err.join("")).toContain("✓ main updated");
      // Outcomes are returned, never narrated: the rows are `cli/run.ts`'s job.
      expect(forward.log.out).toEqual([]);

      // Now both sides move: the local commit is somebody's work and is carried
      // over what the origin gained, rather than being a reason to refuse.
      await commitIn(main, "local.txt", "local\n");
      await commitOnOrigin(temp, "main", "remote-two.txt", "two\n");

      const rebase = await attemptSync(repo, { target: "main" });

      expect(succeeded(rebase)).toEqual([
        {
          path: main,
          dir: "main",
          branch: "main",
          kind: "rebased",
          pushed: true,
          onto: "origin/main",
        },
      ]);
      expect(failureFor(succeeded(rebase))).toBeUndefined();

      expect(await Bun.file(join(main, "remote-two.txt")).text()).toBe("two\n");
      expect(await Bun.file(join(main, "local.txt")).text()).toBe("local\n");
      // Pushed plainly, and the origin has exactly what the worktree has.
      expect(await head(temp.originPath, "main")).toBe(await head(main));
      expect(rebase.log.err.join("")).toContain("✓ pushed main");
    });
  });

  test("rebases a branch onto its own remote first, and then onto the trunk", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      // A colleague's commit on the branch's own remote, work on the trunk, and
      // a commit of our own — the three the ordering has to reconcile.
      await commitOnOrigin(temp, "feat/login", "colleague.txt", "theirs\n");
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");

      const outcomes = succeeded(await attemptSync(repo, { target: "feat/login" }));

      expect(outcomes).toEqual([
        {
          path: worktree,
          dir: "feat/login",
          branch: "feat/login",
          kind: "rebased",
          pushed: true,
          // Its own remote first and then the trunk — and the trunk is what it
          // finished on, which is what this field is here to say.
          onto: "origin/main",
        },
      ]);

      // Nothing was left behind: the colleague's commit, the trunk's, and ours.
      for (const [file, contents] of [
        ["colleague.txt", "theirs\n"],
        ["trunk.txt", "trunk\n"],
        ["mine.txt", "mine\n"],
      ] as const) {
        expect(await Bun.file(join(worktree, file)).text()).toBe(contents);
      }

      // Ours on top, the colleague's under it, the trunk's under that — which
      // is what "its own remote first, then the trunk" means in commit order.
      const subjects = (await probeGit(worktree, ["log", "--format=%s", "-3"])).stdout;
      expect(subjects.split("\n").slice(0, 3)).toEqual([
        "Add mine.txt",
        "Add colleague.txt",
        "Add login",
      ]);
    });
  });

  // `--force-if-includes` reads the branch's reflog, which a bare clone would
  // not keep — `.bare` is made with `core.logallrefupdates` on so that the
  // lease-guarded push can be verified rather than refused out of hand.
  test("force-pushes the rebased branch back to its own remote", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");
      const originBefore = await head(temp.originPath, "feat/login");

      const outcome = await attemptSync(repo, { target: "feat/login" });
      const [synced] = succeeded(outcome);

      // `pushed: true` rather than an inferred exit 0: the push was attempted
      // and it landed, which is the claim the flag exists to make.
      expect(synced?.pushed).toBe(true);
      expect(synced?.pushRefusal).toBeUndefined();
      expect(outcome.log.err.join("")).toContain("✓ pushed feat/login");

      // `--force-with-lease` rewrites the branch on the remote, so the origin
      // ends up holding exactly what the worktree does.
      const originAfter = await head(temp.originPath, "feat/login");
      expect(originAfter).not.toBe(originBefore);
      expect(originAfter).toBe(await head(worktree));
    });
  });

  test("stops on a dirty worktree without changing anything", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await Bun.write(join(worktree, "login.txt"), "half-finished\n");
      const before = await head(worktree);

      const outcome = await attemptSync(repo, { target: "feat/login" });
      const outcomes = succeeded(outcome);

      // Which worktree, why, and which files — none of which reached the shell,
      // where the whole of this was exit 4 and a sentence with "uncommitted
      // changes" somewhere in it.
      expect(outcomes).toEqual([
        {
          path: worktree,
          dir: "feat/login",
          branch: "feat/login",
          kind: "skipped",
          reason: "uncommitted changes",
          conflicts: ["login.txt"],
        },
      ]);

      const refusal = failure(outcomes);
      expect(refusal.code).toBe("refused");
      // The number a script branches on, composed the way `cli.tsx` composes it.
      expect(errorToExitCode(refusal.code)).toBe(ExitCode.refused);
      expect(refusal.message).toBe("feat/login skipped");
      expect(refusal.details).toEqual(["feat/login: uncommitted changes", "  login.txt"]);
      // A skip is not a conflict, and the hint that tells you how to resolve one
      // would be advice about a rebase that never started.
      expect(refusal.hint).toBeUndefined();

      // The fetch, and then nothing: the dirty check runs before the step for
      // this worktree is opened, so the transcript never claims to have begun.
      expect(outcome.log.err).toEqual(["· fetching\n", "✓ fetched\n"]);

      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("half-finished\n");
      expect((await probeGit(worktree, ["status", "--porcelain"])).stdout).toBe(" M login.txt\n");
    });
  });

  test("--all syncs every worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const outcomes = succeeded(await attemptSync(repo, { all: true }));

      // Keyed rather than ordered: `--all` is about none of them being missed,
      // and `git worktree list`'s order is not this command's promise.
      expect(outcomes.length).toBe(2);
      const byDir = new Map(outcomes.map((outcome) => [outcome.dir, outcome]));
      expect(byDir.get("main")?.kind).toBe("fast-forwarded");
      // The branch had nothing of its own to move, but it was visited: its
      // trunk drift closed, which is what "rebased" reports here.
      expect(byDir.get("feat/login")?.kind).toBe("rebased");
      expect(failureFor(outcomes)).toBeUndefined();

      expect(await Bun.file(join(repo.root, "main", "trunk.txt")).text()).toBe("trunk\n");
      expect(await Bun.file(join(repo.root, "feat", "login", "trunk.txt")).text()).toBe("trunk\n");
    });
  });

  test("--no-push leaves the rebase local and diverged from the remote", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");
      const worktree = join(repo.root, "feat", "login");

      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");
      await commitIn(worktree, "mine.txt", "mine\n");
      const originBefore = await head(temp.originPath, "feat/login");

      const outcome = await attemptSync(repo, { target: "feat/login", push: false });
      const [synced] = succeeded(outcome);

      expect(synced?.kind).toBe("rebased");
      // Absent, not `false`. The two spell different things — "nobody asked for
      // a push" against "the remote refused one" — and only the second is a
      // failure, which is the distinction an exit code of 0 could not carry.
      expect(synced?.pushed).toBeUndefined();
      expect(synced?.pushRefusal).toBeUndefined();
      expect(outcome.log.err.join("")).not.toContain("pushing");

      // The rebase happened locally...
      expect(await Bun.file(join(worktree, "trunk.txt")).text()).toBe("trunk\n");
      // ...and the remote is exactly where it was, which is the divergence the
      // flag is named after.
      expect(await head(temp.originPath, "feat/login")).toBe(originBefore);
      expect(await head(worktree)).not.toBe(originBefore);
    });
  });

  test("says the fetch failed instead of reporting a stale answer as up to date", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // The origin goes away entirely, which is what being offline looks like
      // to a `file://` remote. The whole point of this command is that the
      // trunk it rebases onto is current, so a fetch that did not happen is
      // news — "up to date with what was last seen" is a different claim.
      await rm(temp.originPath, { recursive: true, force: true });

      const outcome = await attemptSync(repo, { target: "main" });

      expect(outcome.log.err.join("")).not.toContain("✓ fetched");
      // The whole sentence, not a substring of it: the warning has to say what
      // is now uncertain, or it is only an apology.
      expect(outcome.log.err).toContain(
        "✗ could not fetch — the trunk below is as it was last seen\n",
      );

      // And the sync still answers, over what was last seen — which is exactly
      // why the line above has to be there. A caller reading only the outcome
      // is being told "up to date", and the warning is the rest of the truth.
      expect(succeeded(outcome)).toEqual([
        {
          path: join(repo.root, "main"),
          dir: "main",
          branch: "main",
          kind: "up-to-date",
          onto: "origin/main",
        },
      ]);
    });
  });

  test("aborts a conflicting rebase and exits 5, and --no-abort leaves it stopped part-way", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      // No upstream, so the only base is the trunk and the conflict is the
      // whole of what is being tested.
      await seedWorktree(repo, "spike");
      const worktree = join(repo.root, "spike");

      // Both sides rewrite the fixture's single known line of app.txt.
      await commitIn(worktree, "app.txt", "mine\n");
      await commitOnOrigin(temp, "main", "app.txt", "theirs\n");
      const before = await head(worktree);

      const aborted = await attemptSync(repo, { target: "spike" });
      const rolledBack = succeeded(aborted);

      expect(rolledBack).toEqual([
        {
          path: worktree,
          dir: "spike",
          branch: "spike",
          kind: "conflicted",
          onto: "origin/main",
          reason: "rebase onto origin/main conflicted and was rolled back",
          // The files git stopped on, captured before the abort threw them
          // away — the one moment they exist to be read.
          conflicts: ["app.txt"],
        },
      ]);

      const conflict = failure(rolledBack);
      expect(conflict.code).toBe("rebase-conflict");
      expect(errorToExitCode(conflict.code)).toBe(ExitCode.rebaseConflict);
      expect(conflict.message).toBe("spike conflicted");
      expect(conflict.hint).toBe("resolve them by hand, or sync after committing");
      expect(conflict.details).toEqual([
        "spike: rebase onto origin/main conflicted and was rolled back",
        "  app.txt",
      ]);
      expect(aborted.log.err.join("")).toContain("✗ spike conflicts with origin/main");

      // Rolled back: the worktree is where it was and there is no half-finished
      // rebase to clear up.
      expect(await isRebasing(worktree)).toBe(false);
      expect(await head(worktree)).toBe(before);
      expect(await Bun.file(join(worktree, "app.txt")).text()).toBe("mine\n");

      const left = succeeded(await attemptSync(repo, { target: "spike", abortOnConflict: false }));

      // The same conflict, and the same exit code — the flag changes what is
      // left on disk, not what the run is judged to be.
      expect(left[0]?.reason).toBe(
        "rebase onto origin/main conflicted and was left in place to resolve",
      );
      expect(errorToExitCode(failure(left).code)).toBe(ExitCode.rebaseConflict);
      expect(failure(left).details.join("\n")).toContain("left in place");
      expect(await isRebasing(worktree)).toBe(true);
      expect((await probeGit(worktree, ["status"])).stdout).toContain("rebase");
    });
  });
});

/**
 * A stack, and the two things `sync` has to get right about one.
 *
 * The base — a branch cut from another branch goes back onto that branch, not
 * onto the trunk — and the order, which is what makes the base worth anything:
 * a child replayed onto a parent that has not yet taken the trunk's new commits
 * is a child left exactly as stale as it was.
 *
 * `push` is off throughout. These branches have never been pushed, so there is
 * no upstream to publish to and nothing about the remote is what is being
 * asserted; leaving it on would only add the `--force-with-lease` machinery to
 * a test about which commit a rebase lands on.
 */
describe("grove sync over a stack", () => {
  /** `feat/a` off the trunk, `feat/b` on top of it, each with a commit of its own. */
  async function twoDeep(repo: RepoPaths): Promise<{ a: string; b: string }> {
    await seedWorktree(repo, "feat/a");
    const a = join(repo.root, "feat", "a");
    await commitIn(a, "a.txt", "a\n");

    await addWorktree(
      repo,
      repo.root,
      {
        branch: "feat/b",
        on: "feat/a",
        fetch: false,
        push: false,
        setup: false,
        trust: false,
        take: false,
      },
      recorder().reporter,
    );
    const b = join(repo.root, "feat", "b");
    await commitIn(b, "b.txt", "b\n");

    return { a, b };
  }

  test("rebases the child onto its parent, and the parent onto the trunk first", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { a, b } = await twoDeep(repo);
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const outcomes = succeeded(await attemptSync(repo, { all: true, push: false }));
      const at = (dir: string) => outcomes.find((outcome) => outcome.dir === dir);

      // The parent went onto the trunk and the child went onto the parent —
      // which is the whole claim, and `onto` is where it is legible.
      expect(at("feat/a")?.onto).toBe("origin/main");
      expect(at("feat/b")?.onto).toBe("feat/a");
      expect(at("feat/b")?.kind).toBe("rebased");

      // And the order was bottom-up, so the child has all three commits: the
      // trunk's, its parent's, and its own.
      for (const [file, contents] of [
        ["trunk.txt", "trunk\n"],
        ["a.txt", "a\n"],
        ["b.txt", "b\n"],
      ] as const) {
        expect(await Bun.file(join(b, file)).text()).toBe(contents);
      }
      // The parent is where the child was replayed from, and nothing about the
      // child leaked back into it.
      expect(await Bun.file(join(a, "b.txt")).exists()).toBe(false);
    });
  });

  test("naming the child brings its parents with it", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { b } = await twoDeep(repo);
      await commitOnOrigin(temp, "main", "trunk.txt", "trunk\n");

      const outcomes = succeeded(await attemptSync(repo, { target: "feat/b", push: false }));

      // Two rows for one name, furthest ancestor first — nothing is hidden,
      // and the trunk's worktree, which was not asked about, is not in here.
      expect(outcomes.map((outcome) => outcome.dir)).toEqual(["feat/a", "feat/b"]);
      expect(await Bun.file(join(b, "trunk.txt")).text()).toBe("trunk\n");
    });
  });

  test("a parent that has gone hands the branch back to the trunk, and says so", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { b } = await twoDeep(repo);

      // Deleted behind grove's back — `remove --delete-branch` would have
      // repaired the record itself, and this is the case that reaches `sync`
      // with a record pointing at nothing.
      await probeGit(repo.gitDir, ["worktree", "remove", "--force", join(repo.root, "feat", "a")]);
      await probeGit(repo.gitDir, ["branch", "-D", "feat/a"]);

      const outcome = succeeded(await attemptSync(repo, { target: "feat/b", push: false }));

      expect(outcome).toHaveLength(1);
      expect(outcome[0]?.onto).toBe("origin/main");
      expect(outcome[0]?.reparented).toBe("main");
      // Repaired rather than tolerated: the next command walks no dead link.
      expect((await readStack(repo.gitDir)).get("feat/b")).toBeUndefined();
      expect(await Bun.file(join(b, "b.txt")).text()).toBe("b\n");
    });
  });

  test("an ordinary branch carries no parent, and is measured against the trunk", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const outcomes = succeeded(await attemptSync(repo, { target: "feat/login", push: false }));

      expect(outcomes.map((outcome) => outcome.dir)).toEqual(["feat/login"]);
      expect(outcomes[0]?.onto).toBe("origin/main");
      // Absent, not `undefined`: nothing was repaired, so there is no key.
      expect(outcomes[0]).not.toHaveProperty("reparented");
    });
  });
});
