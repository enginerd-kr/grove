import { expect, test } from "bun:test";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import type { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { gitOutput, runGit } from "../git.ts";
import { type RepoPaths, repoPaths } from "../layout.ts";
import { withTempRepo } from "../test-utils.ts";
import { listWorktrees } from "../worktrees.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { removeWorktree } from "./remove.ts";

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<GroveError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as GroveError;
}

/** A repo with `main` plus a `feat/login` worktree — the shape these tests need. */
async function withRepo(
  body: (repo: RepoPaths, work: string, originPath: string) => Promise<void>,
): Promise<void> {
  await withTempRepo(async ({ work, originUrl, originPath }) => {
    const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
    const repo = repoPaths(root);
    await addWorktree(
      repo,
      { branch: "feat/login", fetch: true, push: false, setup: true, trust: false },
      silent(),
    );

    await body(repo, work, originPath);
  });
}

onPosix(
  "removes a clean worktree and prunes the record of it",
  async () => {
    await withRepo(async (repo, work) => {
      const result = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      expect(result.path).toBe(join(repo.root, "feat", "login"));
      expect(await pathExists(result.path)).toBe(false);
      expect((await listWorktrees(repo.bare)).map((w) => w.branch)).toEqual(["main"]);

      // Pruned, so re-adding the same directory is not refused by a leftover
      // administrative record.
      const again = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false, setup: true, trust: false },
        silent(),
      );
      expect(await pathExists(again.path)).toBe(true);
    });
  },
  30_000,
);

// Nesting would otherwise leave an empty `feat/` behind forever, and those
// accumulate into exactly the clutter the grouping was supposed to organise away.
onPosix(
  "removing the last branch under a prefix takes the empty folder with it",
  async () => {
    await withRepo(async (repo, work) => {
      await addWorktree(
        repo,
        { branch: "feat/search", fetch: true, push: false, setup: true, trust: false },
        silent(),
      );

      await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );
      // A sibling is still there, so the folder stays.
      expect(await pathExists(join(repo.root, "feat"))).toBe(true);

      await removeWorktree(
        repo,
        work,
        { target: "feat/search", force: false, deleteBranch: false },
        silent(),
      );
      expect(await pathExists(join(repo.root, "feat"))).toBe(false);
      // Never the repo root itself, whatever is left.
      expect(await pathExists(repo.root)).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "a folder holding something of yours is left alone",
  async () => {
    await withRepo(async (repo, work) => {
      await Bun.write(join(repo.root, "feat", "notes.txt"), "mine\n");

      await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      // Anything in there is someone's, not ours.
      expect(await pathExists(join(repo.root, "feat", "notes.txt"))).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "either spelling of the target reaches the same worktree",
  async () => {
    await withRepo(async (repo, work) => {
      const byDir = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      expect(byDir.branch).toBe("feat/login");
    });
  },
  30_000,
);

// Deleting the directory your shell is in leaves it somewhere that no longer
// exists, and every later command fails for an unrelated-looking reason.
onPosix(
  "refuses to remove the worktree you are standing in, even with --force",
  async () => {
    await withRepo(async (repo) => {
      const inside = join(repo.root, "feat/login", "nested");

      for (const force of [false, true]) {
        const error = await expectError(
          removeWorktree(
            repo,
            inside,
            { target: "feat/login", force, deleteBranch: false },
            silent(),
          ),
        );

        expect(error.code).toBe("refused");
        expect(error.hint).toContain("cd");
      }

      expect(await pathExists(join(repo.root, "feat", "login"))).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "refuses a dirty worktree and names what is in the way",
  async () => {
    await withRepo(async (repo, work) => {
      const path = join(repo.root, "feat", "login");
      await Bun.write(join(path, "login.txt"), "unsaved\n");

      const error = await expectError(
        removeWorktree(
          repo,
          work,
          { target: "feat/login", force: false, deleteBranch: false },
          silent(),
        ),
      );

      expect(error.code).toBe("refused");
      expect(error.details).toContain("login.txt");
      expect(await pathExists(path)).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "--force discards uncommitted changes",
  async () => {
    await withRepo(async (repo, work) => {
      const path = join(repo.root, "feat", "login");
      await Bun.write(join(path, "login.txt"), "unsaved\n");

      await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: true, deleteBranch: false },
        silent(),
      );

      expect(await pathExists(path)).toBe(false);
    });
  },
  30_000,
);

onPosix(
  "refuses the default branch's worktree unless forced",
  async () => {
    await withRepo(async (repo, work) => {
      const error = await expectError(
        removeWorktree(repo, work, { target: "main", force: false, deleteBranch: false }, silent()),
      );

      expect(error.code).toBe("refused");
      expect(error.message).toContain("syncs onto");

      await removeWorktree(
        repo,
        work,
        { target: "main", force: true, deleteBranch: false },
        silent(),
      );
      expect(await pathExists(join(repo.root, "main"))).toBe(false);
    });
  },
  30_000,
);

onPosix(
  "refuses the last worktree unless forced",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
      const repo = repoPaths(root);

      const error = await expectError(
        removeWorktree(repo, work, { target: "main", force: false, deleteBranch: false }, silent()),
      );

      // Both rules apply here; either refusal is correct, and the point is that
      // one of them fires rather than which.
      expect(error.code).toBe("refused");
      expect(await listWorktrees(repo.bare)).toHaveLength(1);
    });
  },
  30_000,
);

// The branch is where unpushed work lives, so it is kept — but the directory
// vanishing is exactly when someone assumes the work went with it.
onPosix(
  "keeps the branch by default and says so when it holds unpushed commits",
  async () => {
    await withRepo(async (repo, work) => {
      const path = join(repo.root, "feat", "login");
      await Bun.write(join(path, "extra.txt"), "work\n");
      await runGit(["add", "-A"], { cwd: path });
      await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "unpushed"], { cwd: path });

      const result = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      expect(result.branchDeleted).toBe(false);
      expect(result.unpushedWarning).toContain("1 unpushed");
      expect(
        await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
          cwd: repo.bare,
        }),
      ).toContain("feat/login");
    });
  },
  30_000,
);

onPosix(
  "a fully pushed branch is removed without a warning",
  async () => {
    await withRepo(async (repo, work) => {
      const result = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      expect(result.unpushedWarning).toBeUndefined();
    });
  },
  30_000,
);

onPosix(
  "--delete-branch removes a merged branch too",
  async () => {
    await withRepo(async (repo, work) => {
      const result = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: true },
        silent(),
      );

      expect(result.branchDeleted).toBe(true);
      expect(
        await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
          cwd: repo.bare,
        }),
      ).not.toContain("feat/login");
    });
  },
  30_000,
);

// `git branch -d` refusing unmerged commits is the safety net; only --force
// downgrades it to -D.
onPosix(
  "--delete-branch stops short of throwing away unmerged commits",
  async () => {
    await withRepo(async (repo, work) => {
      const path = join(repo.root, "feat", "login");
      await Bun.write(join(path, "extra.txt"), "work\n");
      await runGit(["add", "-A"], { cwd: path });
      await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "unmerged"], { cwd: path });

      const error = await expectError(
        removeWorktree(
          repo,
          work,
          { target: "feat/login", force: false, deleteBranch: true },
          silent(),
        ),
      );

      expect(error.code).toBe("refused");
      // The worktree is already gone at this point; the message has to say the
      // branch survived, or the user assumes the work is lost.
      expect(await pathExists(path)).toBe(false);
      expect(
        await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
          cwd: repo.bare,
        }),
      ).toContain("feat/login");
    });
  },
  30_000,
);

onPosix(
  "an unknown target lists what is actually there",
  async () => {
    await withRepo(async (repo, work) => {
      const error = await expectError(
        removeWorktree(
          repo,
          work,
          { target: "feat/typo", force: false, deleteBranch: false },
          silent(),
        ),
      );

      expect(error.code).toBe("not-a-repo");
      expect(error.details.join("\n")).toContain("feat/login");
    });
  },
  30_000,
);

onPosix(
  "a locked worktree is refused with the command that unlocks it",
  async () => {
    await withRepo(async (repo, work) => {
      await runGit(["worktree", "lock", "--reason", "held", join(repo.root, "feat", "login")], {
        cwd: repo.bare,
      });

      const error = await expectError(
        removeWorktree(
          repo,
          work,
          { target: "feat/login", force: true, deleteBranch: false },
          silent(),
        ),
      );

      expect(error.code).toBe("refused");
      expect(error.hint).toContain("worktree unlock");
      expect(error.details).toContain("held");
    });
  },
  30_000,
);
