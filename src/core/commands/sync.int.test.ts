import { expect, test } from "bun:test";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import type { WtError } from "../errors.ts";
import { gitOutput, runGit, runGitOrThrow } from "../git.ts";
import { type RepoPaths, repoPaths } from "../layout.ts";
import { seedGit, withTempRepo } from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { describeState, listWorktreeSummaries } from "./list.ts";
import { failureFor, type SyncOutcome, syncWorktrees } from "./sync.ts";

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

/** A repo with `main` and `feat/login`, plus a way to advance the remote's main. */
async function withRepo(
  body: (context: {
    repo: RepoPaths;
    work: string;
    advanceRemote: (file: string, contents: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  await withTempRepo(async ({ work, originUrl, originPath, root }) => {
    const { root: repoRoot } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
    const repo = repoPaths(repoRoot);
    await addWorktree(repo, { branch: "feat/login", fetch: true, push: false }, silent());

    // A separate clone stands in for a colleague pushing to main.
    const other = join(root, "other");
    await seedGit(root, ["clone", originPath, other]);

    const advanceRemote = async (file: string, contents: string) => {
      await Bun.write(join(other, file), contents);
      await seedGit(other, ["add", "-A"]);
      await seedGit(other, ["-c", "commit.gpgsign=false", "commit", "-m", `remote: ${file}`]);
      await seedGit(other, ["push", "origin", "main"]);
    };

    await body({ repo, work, advanceRemote });
  });
}

/** Commits in a worktree, so it has something for the rebase to replay. */
async function commitIn(path: string, file: string, contents: string): Promise<void> {
  await Bun.write(join(path, file), contents);
  await runGitOrThrow(["add", "-A"], { cwd: path });
  await runGitOrThrow(["-c", "commit.gpgsign=false", "commit", "-m", `local: ${file}`], {
    cwd: path,
  });
}

function outcomeFor(outcomes: readonly SyncOutcome[], branch: string): SyncOutcome | undefined {
  return outcomes.find((outcome) => outcome.branch === branch);
}

onPosix(
  "replays a branch's commits on top of the updated default branch",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      await commitIn(feature, "mine.txt", "mine\n");
      await advanceRemote("theirs.txt", "theirs\n");

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("rebased");
      // Both files present is what proves a rebase happened rather than a reset.
      expect(await Bun.file(join(feature, "mine.txt")).exists()).toBe(true);
      expect(await Bun.file(join(feature, "theirs.txt")).exists()).toBe(true);
      expect(failureFor(outcomes)).toBeUndefined();
    });
  },
  40_000,
);

// Rebasing `main` onto `origin/main` would rewrite local commits nobody asked to
// have rewritten, so the default branch gets a fast-forward instead.
onPosix(
  "fast-forwards the default branch rather than rebasing it",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      await advanceRemote("theirs.txt", "theirs\n");
      const main = join(repo.root, "main");
      const beforeReflog = await gitOutput(["rev-list", "--count", "HEAD"], { cwd: main });

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "main", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("fast-forwarded");
      expect(Number(await gitOutput(["rev-list", "--count", "HEAD"], { cwd: main }))).toBe(
        Number(beforeReflog) + 1,
      );
    });
  },
  40_000,
);

onPosix(
  "a diverged default branch is refused rather than rewritten",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const main = join(repo.root, "main");
      await commitIn(main, "local-only.txt", "local\n");
      await advanceRemote("theirs.txt", "theirs\n");
      const before = await gitOutput(["rev-parse", "HEAD"], { cwd: main });

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "main", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("skipped");
      expect(outcomes[0]?.reason).toContain("local commits");
      // Untouched: the point of --ff-only is that a refusal changes nothing.
      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: main })).toBe(before);
      expect(failureFor(outcomes)?.code).toBe("refused");
    });
  },
  40_000,
);

onPosix(
  "an already-current worktree reports up-to-date without touching anything",
  async () => {
    await withRepo(async ({ repo, work }) => {
      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "main", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("up-to-date");
    });
  },
  40_000,
);

// The check runs before anything else, so a refusal leaves the worktree exactly
// as it was rather than half-updated.
onPosix(
  "a dirty worktree is skipped before any git command runs against it",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      await advanceRemote("theirs.txt", "theirs\n");
      await Bun.write(join(feature, "login.txt"), "unsaved edit\n");
      const before = await gitOutput(["rev-parse", "HEAD"], { cwd: feature });

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("skipped");
      expect(outcomes[0]?.conflicts).toContain("login.txt");
      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: feature })).toBe(before);
      expect(await Bun.file(join(feature, "login.txt")).text()).toBe("unsaved edit\n");
      expect(failureFor(outcomes)?.code).toBe("refused");
    });
  },
  40_000,
);

onPosix(
  "a real conflict is rolled back, leaving a clean tree",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      // Both sides change app.txt's only line, which is a genuine conflict.
      await commitIn(feature, "app.txt", "ours\n");
      await advanceRemote("app.txt", "theirs\n");

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("conflicted");
      expect(outcomes[0]?.conflicts).toContain("app.txt");

      // Rolled back completely: no rebase in progress, no conflict markers, and
      // the branch still holds our version.
      expect((await runGit(["rebase", "--abort"], { cwd: feature })).code).not.toBe(0);
      expect(await Bun.file(join(feature, "app.txt")).text()).toBe("ours\n");
      const status = await runGit(["status", "--porcelain"], { cwd: feature });
      expect(status.stdout.trim()).toBe("");

      expect(failureFor(outcomes)?.code).toBe("rebase-conflict");
    });
  },
  40_000,
);

onPosix(
  "--no-abort leaves the conflict in place to resolve by hand",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      await commitIn(feature, "app.txt", "ours\n");
      await advanceRemote("app.txt", "theirs\n");

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: false },
        silent(),
      );

      expect(outcomes[0]?.kind).toBe("conflicted");
      expect(await Bun.file(join(feature, "app.txt")).text()).toContain("<<<<<<<");
      // Still mid-rebase, so aborting is something the user can now choose.
      expect((await runGit(["rebase", "--abort"], { cwd: feature })).code).toBe(0);
    });
  },
  40_000,
);

onPosix(
  "a rebase already in progress is left alone",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      await commitIn(feature, "app.txt", "ours\n");
      await advanceRemote("app.txt", "theirs\n");

      // Leave a conflicted rebase behind, then sync again.
      await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: false },
        silent(),
      );

      const outcomes = await syncWorktrees(
        repo,
        work,
        { target: "feat/login", all: false, abortOnConflict: true },
        silent(),
      );

      // Resolvable by branch name at all is the point: git calls a mid-rebase
      // worktree detached, which is true and useless — this is exactly when the
      // user needs `wt sync feat/login` to know where they are.
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.branch).toBe("feat/login");
      expect(outcomes[0]?.kind).toBe("skipped");
      expect(outcomes[0]?.reason).toContain("already in progress");
      // Their half-done resolution survived rather than being aborted for them.
      expect(await Bun.file(join(feature, "app.txt")).text()).toContain("<<<<<<<");

      // And `list` says "rebasing" rather than "detached", so there is something
      // to act on.
      const summaries = await listWorktreeSummaries(repo, work);
      const stuck = summaries.find((summary) => summary.branch === "feat/login");
      expect(stuck?.rebasing).toBe(true);
      expect(stuck && describeState(stuck)).toContain("rebasing");
    });
  },
  40_000,
);

onPosix(
  "--all keeps going past a worktree it cannot touch",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      await Bun.write(join(feature, "login.txt"), "unsaved\n");
      await advanceRemote("theirs.txt", "theirs\n");

      const outcomes = await syncWorktrees(
        repo,
        work,
        { all: true, abortOnConflict: true },
        silent(),
      );

      expect(outcomes).toHaveLength(2);
      expect(outcomeFor(outcomes, "main")?.kind).toBe("fast-forwarded");
      expect(outcomeFor(outcomes, "feat/login")?.kind).toBe("skipped");
      // The run still fails overall, so a script notices.
      expect(failureFor(outcomes)?.code).toBe("refused");
    });
  },
  40_000,
);

// With --all a conflict is the result that needs a decision; a merely dirty
// worktree must not hide it behind the gentler exit code.
onPosix(
  "a conflict outranks a skip when reporting the run",
  async () => {
    await withRepo(async ({ repo, work, advanceRemote }) => {
      const feature = join(repo.root, "feat", "login");
      const main = join(repo.root, "main");
      await commitIn(feature, "app.txt", "ours\n");
      await advanceRemote("app.txt", "theirs\n");
      await Bun.write(join(main, "scratch.txt"), "dirty\n");

      const outcomes = await syncWorktrees(
        repo,
        work,
        { all: true, abortOnConflict: true },
        silent(),
      );

      expect(outcomeFor(outcomes, "main")?.kind).toBe("skipped");
      expect(outcomeFor(outcomes, "feat/login")?.kind).toBe("conflicted");
      expect(failureFor(outcomes)?.code).toBe("rebase-conflict");
    });
  },
  40_000,
);

onPosix(
  "a detached worktree is skipped rather than failing the run",
  async () => {
    await withRepo(async ({ repo, work }) => {
      await runGitOrThrow(["worktree", "add", "--detach", join(repo.root, "det"), "main"], {
        cwd: repo.bare,
      });

      const outcomes = await syncWorktrees(
        repo,
        work,
        { all: true, abortOnConflict: true },
        silent(),
      );
      const detached = outcomes.find((outcome) => outcome.branch === undefined);

      expect(detached?.kind).toBe("skipped");
      expect(detached?.reason).toContain("detached");
    });
  },
  40_000,
);

onPosix(
  "syncs the worktree you are standing in when nothing is named",
  async () => {
    await withRepo(async ({ repo, advanceRemote }) => {
      await advanceRemote("theirs.txt", "theirs\n");
      const main = join(repo.root, "main");

      const outcomes = await syncWorktrees(
        repo,
        join(main, "nested", "deeper"),
        { all: false, abortOnConflict: true },
        silent(),
      );

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.branch).toBe("main");
    });
  },
  40_000,
);

onPosix(
  "standing outside every worktree with no target is a usage error",
  async () => {
    await withRepo(async ({ repo, work }) => {
      const error = await syncWorktrees(
        repo,
        work,
        { all: false, abortOnConflict: true },
        silent(),
      ).then(
        () => undefined,
        (caught: unknown) => caught as WtError,
      );

      expect(error?.code).toBe("usage");
      expect(error?.hint).toContain("--all");
    });
  },
  40_000,
);
