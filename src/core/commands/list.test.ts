import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { managedRepo, seedGit, seedWorktree, withTempRepo } from "../test-utils.ts";
import { formatWorktreeTable, listWorktreeSummaries, type WorktreeSummary } from "./list.ts";

/**
 * `list` is the command everything else is read through, so what is asserted
 * here is the row: which worktrees are on it, what state each is reported in,
 * and that the table drawn from them says the same thing.
 *
 * `listWorktreeSummaries` is called directly, against a real repository, for
 * the reason `rename.test.ts` gives: the git is the part that has to be real,
 * and a process around it buys nothing but latency. Here it also buys back a
 * whole result. The old tests saw this command two ways — as a padded table
 * parsed back apart on runs of whitespace, and as `--json` read through a
 * `toMatchObject` that names five of eighteen fields — and neither could see
 * `path`, `files`, `detached`, `locked` or `rebasing` at all. A summary held in
 * hand is asserted whole, which is what makes "clean" on a row provable rather
 * than merely plausible.
 *
 * What still goes through the binary is in `list.e2e.test.ts`: the stream the
 * `--json` document lands on, which is a fact about `cli/run.ts` and not about
 * anything here.
 */

/** Commits `message` in `worktree`, staging whatever is there. */
async function commit(worktree: string, message: string): Promise<void> {
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

/**
 * A summary as a plain object, with the one field that is a clock left as a
 * matcher — `touched` is an mtime, so its value is the moment the test ran.
 *
 * Every other field has to be given: `Omit` is what makes a forgotten one a
 * typecheck failure rather than a silently narrower assertion, which is the
 * whole difference between this and the `toMatchObject` it replaces.
 */
function summaryLike(fields: Omit<WorktreeSummary, "touched">): WorktreeSummary {
  return { ...fields, touched: expect.any(Number) as unknown as number };
}

describe("what the table says", () => {
  test("every worktree, its branch, and whether it is clean", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const clean = await listWorktreeSummaries(repo, root);

      // The whole of both rows, field by field — what "clean" in a table cell
      // was standing in for. Every one of these is a promise some other command
      // or the app reads: `path` is what `cd` gets, `files` is what the
      // confirmation panel lists, `locked` and `rebasing` are the two states
      // that are neither clean nor dirty.
      expect(clean).toEqual([
        // The trunk first, then alphabetically — a stable order two runs can be
        // diffed against each other.
        summaryLike({
          path: join(root, "main"),
          dir: "main",
          branch: "main",
          detached: false,
          dirty: false,
          changed: 0,
          untracked: 0,
          files: [],
          ahead: 0,
          behind: 0,
          upstream: "origin/main",
          // Nothing to say about the trunk's distance from itself.
          trunk: undefined,
          locked: false,
          rebasing: false,
          finished: undefined,
          setupStale: false,
          publishRemote: "origin",
          isDefault: true,
          current: false,
        }),
        summaryLike({
          path: join(root, "feat", "login"),
          dir: "feat/login",
          branch: "feat/login",
          detached: false,
          dirty: false,
          changed: 0,
          untracked: 0,
          files: [],
          ahead: 0,
          behind: 0,
          upstream: "origin/feat/login",
          // One commit the trunk does not have: the fixture's own `login`.
          trunk: { ahead: 1, behind: 0 },
          locked: false,
          rebasing: false,
          // Pushed and merged are both false here, so no badge — a branch with
          // work still on it is not something to offer to clear away.
          finished: undefined,
          setupStale: false,
          publishRemote: "origin",
          isDefault: false,
          current: false,
        }),
      ]);

      // The table is a rendering of exactly those, and the padding is part of
      // it: the columns line up because every row is padded to the widest.
      expect(formatWorktreeTable(clean)).toBe(
        ["  main        main        clean", "  feat/login  feat/login  clean"].join("\n"),
      );

      const login = join(root, "feat", "login");
      await Bun.write(join(login, "scratch.txt"), "wip\n");

      const dirty = await listWorktreeSummaries(repo, login);

      expect(dirty[1]).toEqual(
        summaryLike({
          path: login,
          dir: "feat/login",
          branch: "feat/login",
          detached: false,
          dirty: true,
          changed: 1,
          untracked: 1,
          // The path itself, which the count alone only ever raises as a
          // question and which nothing outside the app had ever asserted.
          files: ["scratch.txt"],
          ahead: 0,
          behind: 0,
          upstream: "origin/feat/login",
          trunk: { ahead: 1, behind: 0 },
          locked: false,
          rebasing: false,
          finished: undefined,
          setupStale: false,
          publishRemote: "origin",
          isDefault: false,
          // `*` marks where you are standing, which is what people open this
          // command to answer — and it is decided by the cwd passed in, so a
          // path inside the worktree counts as being in it.
          current: true,
        }),
      );
      // Standing in one does not make you stand in the other.
      expect(dirty[0]?.current).toBe(false);

      expect(formatWorktreeTable(dirty)).toBe(
        ["  main        main        clean", "* feat/login  feat/login  dirty"].join("\n"),
      );
    });
  });

  test("drift is counted after a local commit, and again after the origin moves", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");
      const login = join(root, "feat", "login");

      await Bun.write(join(login, "mine.txt"), "mine\n");
      await commit(login, "Add mine");

      const ahead = await listWorktreeSummaries(repo, root);
      expect([ahead[1]?.ahead, ahead[1]?.behind]).toEqual([1, 0]);
      // Committed, so there is nothing uncommitted left to be dirty about: the
      // drift and the working tree are two separate answers.
      expect([ahead[1]?.dirty, ahead[1]?.changed]).toEqual([false, 0]);
      expect(formatWorktreeTable(ahead)).toContain("1 ahead");

      // The remote gains a commit of its own, from a clone standing in for
      // somebody else's laptop.
      const scratch = join(temp.root, "scratch");
      await seedGit(temp.root, ["clone", temp.originPath, scratch]);
      await seedGit(scratch, ["checkout", "feat/login"]);
      await Bun.write(join(scratch, "theirs.txt"), "theirs\n");
      await commit(scratch, "Add theirs");
      await seedGit(scratch, ["push", "origin", "feat/login"]);
      // `list` reports what the last fetch saw, and does not fetch itself.
      const unfetched = await listWorktreeSummaries(repo, root);
      expect([unfetched[1]?.ahead, unfetched[1]?.behind]).toEqual([1, 0]);

      await seedGit(repo.gitDir, ["fetch", "origin", "--prune"]);

      const both = await listWorktreeSummaries(repo, root);
      expect(formatWorktreeTable(both)).toContain("1 ahead, 1 behind");
      expect(both[1]).toMatchObject({
        ahead: 1,
        behind: 1,
        upstream: "origin/feat/login",
        // A second question entirely: how far this branch has drifted from the
        // trunk, which is what `sync` closes. Two, because the fixture's own
        // `login` commit is on it as well as the one made here — and the trunk
        // has not moved, so nothing is behind it.
        trunk: { ahead: 2, behind: 0 },
      });
      // A branch the remote is ahead of is not a finished one: `behind` and
      // `merged` are different claims and the badge only makes the second.
      expect(both[1]?.finished).toBeUndefined();
    });
  });

  test("the merged and gone badges are the two traces a finished branch leaves", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // Pushed and still there, with nothing on it the trunk does not have.
      await seedWorktree(repo, "squashed", { push: true });
      // Pushed, then deleted on the remote — a merged pull request.
      await seedWorktree(repo, "landed", { push: true });
      await seedGit(temp.originPath, ["branch", "-D", "landed"]);
      // A branch only reads as gone once a fetch has pruned the ref.
      await seedGit(repo.gitDir, ["fetch", "origin", "--prune"]);

      const found = await listWorktreeSummaries(repo, root);

      expect(found.map((summary) => [summary.dir, summary.finished])).toEqual([
        // The trunk is never finished with, whatever is true of it.
        ["main", undefined],
        ["landed", "gone"],
        ["squashed", "merged"],
      ]);
      // Both branches still have their upstream recorded — which is what makes
      // the two badges tellable apart at all. Without one, neither is claimed:
      // a branch that has never left this machine is not a merged one.
      expect(found[1]?.upstream).toBe("origin/landed");
      expect(found[2]?.upstream).toBe("origin/squashed");
      // `gone` is the remote's own answer and `merged` is git's, so the branch
      // the remote still carries is the one that is not gone.
      expect([found[1]?.dirty, found[2]?.dirty]).toEqual([false, false]);

      expect(formatWorktreeTable(found)).toBe(
        [
          "  main      main      clean",
          "  landed    landed    gone",
          "  squashed  squashed  merged",
        ].join("\n"),
      );
    });
  });

  test("carries the changed paths, counted apart by whether git is tracking them", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");

      await Bun.write(join(main, "app.txt"), "changed\n");
      await Bun.write(join(main, "extra.txt"), "new\n");

      const summaries = await listWorktreeSummaries(repo, main);
      const [summary] = summaries;

      expect(summary).toMatchObject({ dirty: true, changed: 2, untracked: 1 });
      // Untracked ones are destroyed by a different command than tracked ones,
      // which is why they are counted separately rather than lumped together —
      // and `changed` is the total of both, which the two names do not say and
      // the paths themselves prove.
      expect(summary?.files.toSorted()).toEqual(["app.txt", "extra.txt"]);
      // The table has one word for all of that. Which is the point of the word
      // — and the reason the counts are worth reading straight off the result.
      expect(formatWorktreeTable(summaries)).toBe("* main  main  dirty");
    });
  });
});
