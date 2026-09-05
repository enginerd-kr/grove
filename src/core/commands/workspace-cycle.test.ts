import { expect, test } from "bun:test";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { recordSetupState } from "../../hooks/state.ts";
import { withRepo } from "../../hooks/test-utils.ts";
import { runtimeEnv } from "../runtime.ts";
import {
  attempt,
  managedRepo,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { withForge } from "./forge-test-utils.ts";
import { listWorktreeSummaries } from "./list.ts";
import { checkoutPullRequest } from "./pr.ts";
import { pruneWorktrees } from "./prune.ts";
import { renameWorktree } from "./rename.ts";
import { setUpWorktrees } from "./setup.ts";
import { syncWorktrees } from "./sync.ts";

const sync = { all: false, abortOnConflict: true, push: true, publish: false } as const;

async function commit(path: string, name: string, text: string) {
  await Bun.write(join(path, name), text);
  await seedGit(path, ["add", "-A"]);
  await seedGit(path, ["-c", "commit.gpgsign=false", "commit", "-m", name]);
}
const head = async (path: string) => (await seedGit(path, ["rev-parse", "HEAD"])).trim();

test("review sync receives new PR commits without rebasing onto main or pushing local commits", async () => {
  await withForge(async (forge) => {
    await forge.answer();
    await forge.propose("fix/crash", "one\n", "first");
    const review = succeeded(
      await attempt((r) =>
        checkoutPullRequest(
          forge.repo,
          forge.repo.root,
          { pr: "42", setup: false, trust: false },
          r,
        ),
      ),
    );
    await commit(join(forge.repo.root, "main"), "trunk-only.txt", "trunk\n");
    await seedGit(join(forge.repo.root, "main"), ["push"]);
    await forge.propose("fix/crash", "two\n", "second");
    const received = succeeded(
      await attempt((r) =>
        syncWorktrees(forge.repo, forge.repo.root, { ...sync, target: review.path }, r),
      ),
    );
    expect(received[0]?.kind).toBe("fast-forwarded");
    expect(received[0]?.pushed).toBeUndefined();
    expect(await Bun.file(join(review.path, "trunk-only.txt")).exists()).toBe(false);
    const remote = (await seedGit(forge.fork, ["rev-parse", "fix/crash"])).trim();
    await commit(review.path, "local.txt", "reviewer's work\n");
    const before = await head(review.path);
    const refused = succeeded(
      await attempt((r) =>
        syncWorktrees(forge.repo, forge.repo.root, { ...sync, target: review.path }, r),
      ),
    );
    expect(refused[0]?.kind).toBe("skipped");
    expect(await head(review.path)).toBe(before);
    expect((await seedGit(forge.fork, ["rev-parse", "fix/crash"])).trim()).toBe(remote);
  });
});

test("replacing a divergent review saves committed and uncommitted work", async () => {
  await withForge(async (forge) => {
    await forge.answer({ baseRefName: "release/1" });
    await forge.propose("fix/crash", "one\n", "first");
    const review = succeeded(
      await attempt((r) =>
        checkoutPullRequest(
          forge.repo,
          forge.repo.root,
          { pr: "42", setup: false, trust: false },
          r,
        ),
      ),
    );
    await commit(review.path, "local.txt", "local commit\n");
    const before = await head(review.path);
    await Bun.write(join(review.path, "notes.txt"), "untracked notes\n");
    await forge.propose("fix/crash", "two\n", "second");
    succeeded(
      await attempt((r) =>
        checkoutPullRequest(
          forge.repo,
          forge.repo.root,
          { pr: "42", replace: true, setup: false, trust: false },
          r,
        ),
      ),
    );
    const backups = await seedGit(forge.repo.gitDir, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/grove/review-backups",
    ]);
    expect(backups.trim()).toBe(before);
    const saved = (
      await seedGit(forge.repo.gitDir, ["rev-parse", "refs/grove/discarded/pr/42"])
    ).trim();
    await seedGit(review.path, ["stash", "apply", saved]);
    expect(await Bun.file(join(review.path, "notes.txt")).text()).toBe("untracked notes\n");
    const summary = (await listWorktreeSummaries(forge.repo, forge.repo.root)).find(
      (row) => row.branch === "pr/42",
    );
    expect(summary?.review?.base).toBe("release/1");
  });
});

test("new branches report the fetched base, and main with divergent commits stays untouched", async () => {
  await withTempRepo(async (temp) => {
    const repo = await managedRepo(temp);
    const main = join(repo.root, "main");
    await commit(main, "local-main.txt", "local\n");
    const local = await head(main);
    const result = succeeded(
      await attempt((r) =>
        addWorktree(
          repo,
          main,
          { branch: "feat/new", fetch: true, push: false, setup: false, trust: false, take: false },
          r,
        ),
      ),
    );
    expect(result.base).toBe("origin/main");
    expect(result.baseSha).toBe(await head(result.path));
    expect(result.baseSha).not.toBe(local);
    // Advance origin independently to make fast-forward impossible.
    await commit(result.path, "remote-main.txt", "remote\n");
    await seedGit(result.path, ["push", "origin", "HEAD:main"]);
    const outcomes = succeeded(
      await attempt((r) => syncWorktrees(repo, repo.root, { ...sync, target: "main" }, r)),
    );
    expect(outcomes[0]?.kind).toBe("skipped");
    expect(await head(main)).toBe(local);
  });
});

test("worktree recipes keep main as copy source, require approval, and report dependency drift", async () => {
  await withRepo(async (fixture) => {
    await fixture.configure('[setup]\nrun = ["echo trunk > recipe.txt"]\n');
    await Bun.write(join(fixture.trunk, ".env"), "FROM_TRUNK=1\n");
    await Bun.write(
      join(fixture.worktree, ".grove.toml"),
      '[setup]\ncopy = [".env"]\nrun = ["echo branch > recipe.txt"]\n',
    );
    const run = (trust: boolean) =>
      setUpWorktrees(
        fixture.repo,
        fixture.repo.root,
        { target: fixture.branch, all: false, trust, configSource: "worktree" },
        fixture.log.reporter,
      );
    const first = await run(false);
    expect(first[0]?.untrusted).toBe(true);
    expect(await Bun.file(join(fixture.worktree, ".env")).text()).toBe("FROM_TRUNK=1\n");
    expect((await listWorktreeSummaries(fixture.repo, fixture.repo.root))[1]?.setupState).toBe(
      "pending",
    );
    await run(true);
    expect(await Bun.file(join(fixture.worktree, "recipe.txt")).text()).toBe("branch\n");
    expect((await listWorktreeSummaries(fixture.repo, fixture.repo.root))[1]?.setupState).toBe(
      "ready",
    );
    await Bun.write(join(fixture.worktree, "bun.lock"), "changed dependencies\n");
    expect((await listWorktreeSummaries(fixture.repo, fixture.repo.root))[1]?.setupState).toBe(
      "stale",
    );
    await Bun.write(join(fixture.worktree, ".grove.toml"), '[setup]\nrun = ["exit 7"]\n');
    await run(true);
    expect((await listWorktreeSummaries(fixture.repo, fixture.repo.root))[1]?.setupState).toBe(
      "failed",
    );
    await recordSetupState(fixture.repo.gitDir, fixture.branch, "running");
    expect((await listWorktreeSummaries(fixture.repo, fixture.repo.root))[1]?.setupState).toBe(
      "running",
    );
  });
});

test("runtime identities and ports differ across worktrees and survive renames and concurrent setup", async () => {
  await withTempRepo(async (temp) => {
    const repo = await managedRepo(temp);
    const added = await seedWorktree(repo, "feat/login");
    const [main, first, again] = await Promise.all([
      runtimeEnv(repo, join(repo.root, "main")),
      runtimeEnv(repo, added.path),
      runtimeEnv(repo, added.path),
    ]);
    expect(first).toEqual(again);
    expect(first.GROVE_PORT).not.toBe(main.GROVE_PORT);
    expect(first.GROVE_DATABASE_NAME).not.toBe(main.GROVE_DATABASE_NAME);
    const renamed = succeeded(
      await attempt((r) =>
        renameWorktree(
          repo,
          repo.root,
          { target: "feat/login", to: "feat/renamed", push: false, force: false },
          r,
        ),
      ),
    );
    expect(await runtimeEnv(repo, renamed.path)).toEqual(first);
    const ports = join(repo.gitDir, "grove-runtime", "ports");
    expect((await readdir(ports)).length).toBe(2);
    expect(await readlink(join(ports, first.GROVE_PORT ?? ""))).toBe(first.GROVE_WORKTREE_ID ?? "");
  });
});

test("forge-confirmed multi-commit squash merges are prune candidates only at the reviewed head", async () => {
  await withForge(async (forge) => {
    const added = await seedWorktree(forge.repo, "feat/squashed", { push: true });
    await commit(added.path, "one.txt", "one\n");
    await commit(added.path, "two.txt", "two\n");
    await seedGit(added.path, ["push"]);
    const proposed = await head(added.path);
    await forge.answerTo(
      "pr list",
      JSON.stringify([{ number: 99, state: "MERGED", headRefOid: proposed }]),
    );
    const options = {
      closed: false,
      forgeMerged: true,
      dryRun: true,
      deleteBranch: false,
      fetch: true,
    };
    const first = succeeded(
      await attempt((r) => pruneWorktrees(forge.repo, forge.repo.root, options, r)),
    );
    expect(first.entries).toMatchObject([{ branch: "feat/squashed", reason: "merged" }]);
    await commit(added.path, "later.txt", "new local work\n");
    const second = succeeded(
      await attempt((r) => pruneWorktrees(forge.repo, forge.repo.root, options, r)),
    );
    expect(second.entries).toEqual([]);
  });
});

test("clone keeps main beside a requested branch and defers unapproved bootstrap commands", async () => {
  await withTempRepo(async (temp) => {
    const source = await managedRepo(temp);
    const main = join(source.root, "main");
    await commit(main, ".grove.toml", '[setup]\nrun = ["echo bootstrapped > bootstrap.txt"]\n');
    await seedGit(main, ["push"]);
    const clone = succeeded(
      await attempt((r) =>
        cloneRepo(
          temp.work,
          { url: temp.originUrl, dir: "new-workspace", branch: "feat/login" },
          r,
        ),
      ),
    );
    expect(clone.setup?.map((item) => item.untrusted)).toEqual([true, true]);
    expect(await Bun.file(join(clone.root, "main", ".grove.toml")).exists()).toBe(true);
    expect(await Bun.file(join(clone.root, "main", "bootstrap.txt")).exists()).toBe(false);
    const repo = {
      ...source,
      root: clone.root,
      gitDir: clone.gitDir,
      gitFile: join(clone.root, ".git"),
    };
    succeeded(
      await attempt((r) => setUpWorktrees(repo, clone.root, { all: true, trust: true }, r)),
    );
    expect(await Bun.file(join(clone.root, "main", "bootstrap.txt")).text()).toBe("bootstrapped\n");
    expect(await Bun.file(join(clone.worktree, "bootstrap.txt")).text()).toBe("bootstrapped\n");
  });
});

test("explicit review contributions follow the current PR base and renamed review checkouts", async () => {
  await withForge(async (forge) => {
    await seedGit(forge.base, ["branch", "release/1", "main"]);
    await forge.answer();
    await forge.propose("fix/crash", "one\n", "first");
    const review = succeeded(
      await attempt((r) =>
        checkoutPullRequest(
          forge.repo,
          forge.repo.root,
          { pr: "42", setup: false, trust: false },
          r,
        ),
      ),
    );
    const renamed = succeeded(
      await attempt((r) =>
        renameWorktree(
          forge.repo,
          forge.repo.root,
          { target: review.path, to: "reviews/crash", push: false, force: false },
          r,
        ),
      ),
    );
    await forge.propose("fix/crash", "two\n", "second");
    const update = succeeded(
      await attempt((r) =>
        syncWorktrees(forge.repo, forge.repo.root, { ...sync, target: renamed.path }, r),
      ),
    );
    expect(update[0]?.path).toBe(renamed.path);
    expect(await Bun.file(join(renamed.path, "crash.txt")).text()).toBe("two\n");
    // Retarget the PR after checkout. Contribution must re-read its actual base.
    await forge.answer({ baseRefName: "release/1" });
    await commit(join(forge.repo.root, "main"), "main-only.txt", "main\n");
    await seedGit(join(forge.repo.root, "main"), ["push"]);
    await commit(renamed.path, "review-fix.txt", "fix\n");
    const contribution = succeeded(
      await attempt((r) =>
        syncWorktrees(
          forge.repo,
          forge.repo.root,
          { ...sync, target: renamed.path, contribute: true },
          r,
        ),
      ),
    );
    expect(contribution[0]?.onto).toBe("origin/release/1");
    expect(contribution[0]?.pushed).toBe(true);
    expect(await Bun.file(join(renamed.path, "main-only.txt")).exists()).toBe(false);
    expect((await seedGit(forge.fork, ["rev-parse", "fix/crash"])).trim()).toBe(
      await head(renamed.path),
    );
  });
});

test("an invalid bootstrap recipe keeps the cloned repository and records failure", async () => {
  await withTempRepo(async (temp) => {
    const source = await managedRepo(temp);
    const main = join(source.root, "main");
    await commit(main, ".grove.toml", '[setup]\ncpoy = [".env"]\n');
    await seedGit(main, ["push"]);
    const result = await attempt((r) =>
      cloneRepo(temp.work, { url: temp.originUrl, dir: "failed-bootstrap" }, r),
    );
    expect(refused(result).code).toBe("usage");
    const root = join(temp.work, "failed-bootstrap");
    expect(await Bun.file(join(root, ".bare", "HEAD")).exists()).toBe(true);
    expect(await Bun.file(join(root, "main", ".grove.toml")).exists()).toBe(true);
    const state = JSON.parse(
      await seedGit(join(root, ".bare"), ["config", "--get", "branch.main.grovesetupstate"]),
    );
    expect(state.state).toBe("failed");
  });
});

test("changing an existing checkout's recipe still carries --take changes before setup", async () => {
  await withRepo(async (fixture) => {
    await Bun.write(join(fixture.trunk, "app.txt"), "carried changes\n");
    await commit(
      fixture.worktree,
      ".grove.toml",
      '[setup]\nrun = ["cat app.txt > observed.txt"]\n',
    );
    const result = succeeded(
      await attempt((r) =>
        addWorktree(
          fixture.repo,
          fixture.trunk,
          {
            branch: fixture.branch,
            fetch: false,
            push: false,
            setup: true,
            trust: true,
            take: true,
            configSource: "worktree",
          },
          r,
        ),
      ),
    );
    expect(result.took).toBeDefined();
    expect(await Bun.file(join(fixture.worktree, "observed.txt")).text()).toBe("carried changes\n");
    expect(await Bun.file(join(fixture.trunk, "app.txt")).text()).toBe("one\n");
  });
});
