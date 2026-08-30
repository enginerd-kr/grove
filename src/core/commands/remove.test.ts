import { describe, expect, test } from "bun:test";
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
import { type RemoveResult, removeWorktree } from "./remove.ts";

/**
 * `grove remove` against a real repository.
 *
 * The refusals are the command — git already declines a dirty tree — so most of
 * what is asserted here is that the directory is still on disk afterwards, not
 * merely that the exit code was unhappy.
 *
 * `removeWorktree` is called directly, with the `RepoPaths` a clone would have
 * produced and a recording reporter, for the reason `cli/run.test.ts` calls
 * `runCommand` that way: the repository is the part that has to be real, and a
 * process around it buys nothing but latency. It also costs coverage. Through
 * the binary a refusal is an exit code and a line of stderr, and this command
 * refuses for six different reasons — three of which `--force` overrides and
 * three of which it does not — so holding the `GroveError` is what tells them
 * apart, by `code` and by the `hint` that says whether there is a way past.
 * Holding the `RemoveResult` turns "exit 0" into an assertion about the branch
 * that was kept, the `[teardown]` that ran, and the unpushed commits somebody
 * is about to walk away from. And `discardDirty` has no flag at all — it is the
 * app's answer to a question it asked on screen — so a direct call is the only
 * caller that can reach it.
 *
 * What still goes through the binary is in `remove.e2e.test.ts`: the `--json`
 * document and the exit code a wrapper script branches on.
 */

type RemoveCall = {
  readonly force?: boolean;
  readonly deleteBranch?: boolean;
  /** The app's "yes, discard them" — narrower than `force`, and flagless. */
  readonly discardDirty?: boolean;
  /** Off skips `.grove.toml`'s `[teardown]`, the way `--no-teardown` does. */
  readonly teardown?: boolean;
  /** Where the removal is asked from. Defaults to the repository root. */
  readonly cwd?: string;
};

/** Removes, and hands back whichever of the two outcomes happened. */
function attemptRemove(
  repo: RepoPaths,
  target: string,
  { force = false, deleteBranch = false, discardDirty, teardown, cwd = repo.root }: RemoveCall = {},
): Promise<Attempt<RemoveResult>> {
  return attempt((reporter) =>
    removeWorktree(repo, cwd, { target, force, deleteBranch, discardDirty, teardown }, reporter),
  );
}

/** The local branches, read back out of git rather than out of a result. */
async function localBranches(repo: RepoPaths): Promise<string> {
  return (await probeGit(repo.gitDir, ["branch", "--list"])).stdout;
}

/** A commit on the worktree's branch, so there is work to be left behind. */
async function commit(worktree: string, name: string): Promise<void> {
  await Bun.write(join(worktree, `${name}.txt`), `${name}\n`);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${name}`]);
}

/**
 * Records `.grove.toml`'s contents as trusted, the way `--trust` would.
 *
 * Written here rather than by running `grove add --trust` so the fixture says
 * what it means: teardown commands run only for a fingerprint git config has
 * seen, and that is the whole of the precondition.
 */
async function trustSetupFile(repo: RepoPaths, contents: string): Promise<void> {
  await Bun.write(join(repo.root, "main", ".grove.toml"), contents);
  await seedGit(repo.gitDir, [
    "config",
    "--replace-all",
    "grove.trusted",
    Bun.SHA256.hash(contents, "hex"),
  ]);
}

describe("grove remove", () => {
  test("takes a branch name, a directory name, or a path, and clears the folders they left", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // A branch whose directory is not spelled the same as the branch, so
      // "resolved by branch" and "resolved by directory" are distinguishable.
      for (const branch of ["fix/bug#7", "chore/tidy@up", "solo"]) {
        await seedWorktree(repo, branch);
      }

      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(true);
      expect(await pathExists(join(root, "chore", "tidy-up"))).toBe(true);

      const outcome = await attemptRemove(repo, "fix/bug#7");

      // The whole result, field by field — what "exit 0" was standing in for.
      // `branch` is the branch as git spells it and `dir` the directory as the
      // list spells it, and the pair only differs at all because the name
      // needed sanitising: this is the case that proves the mapping is looked
      // up rather than inverted.
      expect(succeeded(outcome)).toEqual({
        path: join(root, "fix", "bug-7"),
        dir: "fix/bug-7",
        branch: "fix/bug#7",
        branchDeleted: false,
        // Nothing was pushed, so the branch tracks nothing and there is no
        // count to warn about — absent rather than "0 unpushed commits".
        unpushedWarning: undefined,
        // `[teardown]` ran, in the sense that it was asked and had nothing to
        // do: no `.grove.toml` in the trunk means an empty plan, not a skip.
        teardown: { dir: "fix/bug-7", planned: 0, ran: [], failed: undefined, untrusted: false },
      });

      const byDir = succeeded(await attemptRemove(repo, "chore/tidy-up"));
      const byPath = succeeded(await attemptRemove(repo, join(root, "solo")));

      // All three spellings land on the same worktree record, so all three
      // answer with the directory the list prints rather than what was typed.
      expect([byDir.dir, byPath.dir]).toEqual(["chore/tidy-up", "solo"]);

      expect(await pathExists(join(root, "fix", "bug-7"))).toBe(false);
      expect(await pathExists(join(root, "chore", "tidy-up"))).toBe(false);
      expect(await pathExists(join(root, "solo"))).toBe(false);

      // The point of the nesting: the empty folder the branch name created goes
      // with the last worktree under it.
      expect(await pathExists(join(root, "fix"))).toBe(false);
      expect(await pathExists(join(root, "chore"))).toBe(false);

      // The branches themselves are kept — only the directories were asked for.
      expect(await localBranches(repo)).toContain("fix/bug#7");

      // The transcript is one step per removal and nothing else, and none of it
      // is on stdout: a result never goes through the reporter.
      expect(outcome.log.err.join("")).toContain("✓ removed fix/bug-7");
      expect(outcome.log.out).toEqual([]);
    });
  });

  test("refuses a worktree with uncommitted changes until --force", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const worktree = join(repo.root, "feat", "login");
      await Bun.write(join(worktree, "login.txt"), "edited\n");

      const outcome = await attemptRemove(repo, "feat/login");
      const dirty = refused(outcome);

      expect(dirty.code).toBe("refused");
      // The number a script branches on, composed the way `cli.tsx` composes it.
      expect(errorToExitCode(dirty.code)).toBe(ExitCode.refused);
      expect(dirty.message).toBe("feat/login has uncommitted changes");
      // A refusal with no way past it would be a wall; the hint is the door,
      // and it names both doors rather than only `--force`.
      expect(dirty.hint).toBe("commit or stash them, or pass --force to discard them");
      // Which files were in the way, as a list — through the binary these were
      // an undifferentiated part of the same stderr blob as the sentence.
      expect(dirty.details).toEqual(["login.txt"]);
      // Nothing was even begun: the refusal happens before `[teardown]` is run,
      // let alone before the step that removes the directory is opened.
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(worktree)).toBe(true);

      const forced = succeeded(await attemptRemove(repo, "feat/login", { force: true }));

      expect([forced.dir, forced.branchDeleted]).toEqual(["feat/login", false]);
      expect(await pathExists(worktree)).toBe(false);
    });
  });

  test("--discard-dirty is an answer about the changes and about nothing else", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const worktree = join(repo.root, "feat", "login");
      await Bun.write(join(worktree, "login.txt"), "edited\n");

      // No flag reaches this: it is the app's record of a question already
      // asked on screen ("and discard 1 change?"), so the binary cannot be
      // pointed at it and only a direct call can check what it overrides.
      const discarded = succeeded(await attemptRemove(repo, "feat/login", { discardDirty: true }));

      expect(discarded.dir).toBe("feat/login");
      expect(await pathExists(worktree)).toBe(false);

      // And what it does not override. With `feat/login` gone the trunk is also
      // the last worktree, and that is the refusal that fires — two refusals
      // that both exit 4 and differ only in the sentence, which is exactly the
      // pair a `toContain` on stderr would have let pass for one another.
      const last = refused(await attemptRemove(repo, "main", { discardDirty: true }));

      expect(last.code).toBe("refused");
      expect(last.message).toBe("main is the only worktree");
      expect(last.hint).toBe("pass --force if you really want an empty repository");

      // With something else there to be the last one, the trunk refusal is the
      // one left standing: nobody was asked about the branch everything else
      // syncs onto, so nobody is taken to have said yes to that either.
      await seedWorktree(repo, "spike");
      const trunk = refused(await attemptRemove(repo, "main", { discardDirty: true }));

      expect(trunk.code).toBe("refused");
      expect(trunk.message).toBe("main is the branch everything else syncs onto");
      expect(trunk.hint).toBe("pass --force if you are sure");
      expect(await pathExists(join(repo.root, "main"))).toBe(true);
    });
  });

  test("refuses the directory you are standing in, and the default branch's worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const worktree = join(root, "feat", "login");
      const outcome = await attemptRemove(repo, "feat/login", { cwd: worktree });
      const standing = refused(outcome);

      expect(standing.code).toBe("refused");
      expect(errorToExitCode(standing.code)).toBe(ExitCode.refused);
      // The absolute path, not the short name the other refusals use: this one
      // is about where a shell is sitting, and that is what `pwd` would say.
      expect(standing.message).toBe(`you are inside ${worktree}`);
      expect(standing.hint).toBe("cd somewhere else first");
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(worktree)).toBe(true);

      // Not overridable by --force either, unlike the trunk below — and the
      // proof is that it is the same error, not merely a second failure.
      const forcedStanding = refused(
        await attemptRemove(repo, "feat/login", { cwd: worktree, force: true }),
      );
      expect(forcedStanding.code).toBe("refused");
      expect(forcedStanding.message).toBe(`you are inside ${worktree}`);
      expect(await pathExists(worktree)).toBe(true);

      const trunk = refused(await attemptRemove(repo, "main"));

      expect(trunk.code).toBe("refused");
      expect(trunk.message).toBe("main is the branch everything else syncs onto");
      // This one does have a way past it, which is the difference from above.
      expect(trunk.hint).toBe("pass --force if you are sure");
      expect(await pathExists(join(root, "main"))).toBe(true);
    });
  });

  test("refuses a worktree stopped part-way through a rebase, --force included", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "spike");

      // Stopped on a failing `--exec` rather than on a conflict, because the
      // clean case is the dangerous one: there is nothing in the tree for the
      // uncommitted-changes refusal to catch, and `git worktree remove` would
      // take the directory and the rebase inside it with exit 0.
      const worktree = join(root, "spike");
      await commit(worktree, "spike");
      await commit(join(root, "main"), "trunk");

      expect((await probeGit(worktree, ["rebase", "--exec", "false", "main"])).code).not.toBe(0);
      // The state the dirty guard cannot see: git reports nothing to commit.
      expect((await probeGit(worktree, ["status", "--porcelain=v2"])).stdout).toBe("");

      const outcome = await attemptRemove(repo, "spike");
      const rebasing = refused(outcome);

      expect(rebasing.code).toBe("refused");
      expect(errorToExitCode(rebasing.code)).toBe(ExitCode.refused);
      expect(rebasing.message).toBe("spike is in the middle of a rebase");
      // The whole hint, which is a command that can be pasted — a `toContain`
      // on stderr never checked that the `-C` pointed at the right worktree.
      expect(rebasing.hint).toBe(`finish or abandon it first: git -C ${worktree} rebase --abort`);
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(worktree)).toBe(true);

      // Not overridable, unlike the trunk and the dirty tree above: --force
      // answers "discard my changes", and half-applied commits are not that.
      const forced = refused(await attemptRemove(repo, "spike", { force: true }));
      expect(forced.message).toBe("spike is in the middle of a rebase");
      expect(await pathExists(worktree)).toBe(true);

      // Still stopped mid-rebase: the abort the hint names is still there to run.
      expect((await probeGit(worktree, ["rebase", "--abort"])).code).toBe(0);
    });
  });

  test("--delete-branch takes the branch with the directory", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const outcome = await attemptRemove(repo, "feat/login", { deleteBranch: true });
      const removed = succeeded(outcome);

      expect([removed.branch, removed.branchDeleted]).toEqual(["feat/login", true]);
      // The deletion is the other way out of this command, and it is narrated:
      // a branch disappearing is not something to discover from `git branch`.
      expect(outcome.log.err.join("")).toContain("· deleted branch feat/login");
      // Nothing to warn about a branch that is gone — the field is for the
      // commits a *kept* branch is still holding.
      expect(removed.unpushedWarning).toBeUndefined();

      expect(await localBranches(repo)).not.toContain("feat/login");
      expect(await pathExists(join(repo.root, "feat"))).toBe(false);
    });
  });

  test("a kept branch holding unpushed commits says where the work went", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "solo", { push: true });
      // Pushed, so the branch has an upstream to be ahead of; without one there
      // is no count and nothing is claimed, which is the case above.
      await commit(join(repo.root, "solo"), "solo");

      const removed = succeeded(await attemptRemove(repo, "solo"));

      // The directory disappearing is exactly when somebody assumes the work
      // went with it, so the sentence says where it went and how to get it back.
      expect(removed.unpushedWarning).toBe(
        "branch solo still holds 1 unpushed commit(s); `grove add solo` brings it back",
      );
      expect(removed.branchDeleted).toBe(false);
      expect(await localBranches(repo)).toContain("solo");
    });
  });

  test("runs [teardown] inside the worktree first, skips it for --no-teardown, and removes anyway when it fails", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // The marker is written outside the worktree on purpose: anything written
      // inside it would go with the directory and prove nothing about ordering.
      await trustSetupFile(
        repo,
        [
          "[teardown]",
          `run = ['pwd > "$GROVE_ROOT/teardown-$GROVE_BRANCH"', 'test "$GROVE_BRANCH" != boom']`,
          "",
        ].join("\n"),
      );

      for (const branch of ["alpha", "quiet", "boom"]) await seedWorktree(repo, branch);

      const alpha = succeeded(await attemptRemove(repo, "alpha"));

      // Ran, and ran in the worktree — which by then no longer exists.
      expect((await Bun.file(join(root, "teardown-alpha")).text()).trim()).toBe(
        join(root, "alpha"),
      );
      expect(await pathExists(join(root, "alpha"))).toBe(false);
      // Both commands, in order, and reported as run rather than merely as not
      // having failed — a count `--json` carries and stderr only implied.
      expect(alpha.teardown).toEqual({
        dir: "alpha",
        planned: 2,
        ran: [`pwd > "$GROVE_ROOT/teardown-$GROVE_BRANCH"`, `test "$GROVE_BRANCH" != boom`],
        failed: undefined,
        untrusted: false,
      });

      const quiet = succeeded(await attemptRemove(repo, "quiet", { teardown: false }));

      // Skipped outright rather than run and found empty: no result at all is
      // the difference between "you told me not to" and "there was nothing".
      expect(quiet.teardown).toBeUndefined();
      expect(await pathExists(join(root, "teardown-quiet"))).toBe(false);
      expect(await pathExists(join(root, "quiet"))).toBe(false);

      const outcome = await attemptRemove(repo, "boom");
      const boom = succeeded(outcome);

      // Loud, but not fatal: the documented rule is that broken cleanup never
      // strands a directory somebody has finished with.
      expect(outcome.log.err.join("")).toContain("; removing boom anyway");
      expect(await pathExists(join(root, "teardown-boom"))).toBe(true);
      expect(await pathExists(join(root, "boom"))).toBe(false);
      // Which command failed and with what — the first one ran, the second
      // exited 1, and nothing after a failure is attempted.
      expect(boom.teardown?.ran).toEqual([`pwd > "$GROVE_ROOT/teardown-$GROVE_BRANCH"`]);
      expect(boom.teardown?.failed?.command).toBe(`test "$GROVE_BRANCH" != boom`);
      expect(boom.teardown?.failed?.code).toBe(1);
    });
  });

  test("an edit to the file withdraws its trust, and the worktree still goes", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      const trusted = ["[teardown]", `run = ['touch "$GROVE_ROOT/ran-$GROVE_BRANCH"']`, ""].join(
        "\n",
      );
      await trustSetupFile(repo, trusted);
      await seedWorktree(repo, "alpha");

      // The same file, one line longer. Trust is keyed on the contents, so this
      // is a command that arrived over the network since anybody read it.
      await Bun.write(join(root, "main", ".grove.toml"), `${trusted}# pulled\n`);

      const outcome = await attemptRemove(repo, "alpha");
      const removed = succeeded(outcome);

      expect(removed.teardown?.untrusted).toBe(true);
      expect(removed.teardown?.ran).toEqual([]);
      expect(await pathExists(join(root, "ran-alpha"))).toBe(false);
      // Said out loud, and said with the way back in it — an untrusted file is
      // not a failure, so this is a warning beside a removal that happened.
      expect(outcome.log.err.join("")).toContain(
        "1 teardown command in main/.grove.toml has not been trusted here",
      );
      expect(await pathExists(join(root, "alpha"))).toBe(false);
    });
  });
});
