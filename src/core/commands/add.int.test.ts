import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import type { WtError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { gitOutput, runGit } from "../git.ts";
import { repoPaths } from "../layout.ts";
import { withTempRepo } from "../test-utils.ts";
import { listWorktrees } from "../worktrees.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { describeState, listWorktreeSummaries } from "./list.ts";

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<WtError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as WtError;
}

/** Clones the fixture and returns the repo paths, which every test below needs. */
async function cloned(work: string, originUrl: string) {
  const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());

  return repoPaths(root);
}

onPosix(
  "tracks a branch that exists only on the remote",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const result = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false },
        silent(),
      );

      expect(result.source).toBe("remote");
      expect(result.path).toBe(join(repo.root, "feat/login"));
      expect(await pathExists(join(result.path, "login.txt"))).toBe(true);
      // Tracking is the part a wrong refspec would have quietly lost.
      expect(
        await gitOutput(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: result.path }),
      ).toBe("origin/feat/login");
    });
  },
  30_000,
);

onPosix(
  "creates a branch that exists nowhere, based on the default branch",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const result = await addWorktree(
        repo,
        { branch: "feat/brand-new", fetch: true, push: false },
        silent(),
      );

      expect(result.source).toBe("new");
      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: result.path })).toBe(
        await gitOutput(["rev-parse", "origin/main"], { cwd: repo.bare }),
      );
    });
  },
  30_000,
);

onPosix(
  "--from bases a new branch somewhere else",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const result = await addWorktree(
        repo,
        { branch: "hotfix", from: "origin/feat/login", fetch: true, push: false },
        silent(),
      );

      expect(await gitOutput(["rev-parse", "HEAD"], { cwd: result.path })).toBe(
        await gitOutput(["rev-parse", "origin/feat/login"], { cwd: repo.bare }),
      );
      expect(await pathExists(join(result.path, "login.txt"))).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "--from naming something that does not exist is a usage error",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const error = await expectError(
        addWorktree(repo, { branch: "x", from: "origin/nope", fetch: true, push: false }, silent()),
      );

      expect(error.code).toBe("usage");
      expect(await pathExists(join(repo.root, "x"))).toBe(false);
    });
  },
  30_000,
);

// A branch pushed after the clone must be found, or `add` would create a
// second branch of the same name that then collides on push.
onPosix(
  "fetches before deciding a branch does not exist",
  async () => {
    await withTempRepo(async ({ work, originUrl, originPath }) => {
      const repo = await cloned(work, originUrl);

      // Someone else pushes a branch in the meantime.
      await runGit(["branch", "feat/later", "main"], { cwd: originPath });

      const found = await addWorktree(
        repo,
        { branch: "feat/later", fetch: true, push: false },
        silent(),
      );
      expect(found.source).toBe("remote");
    });
  },
  30_000,
);

onPosix(
  "--no-fetch settles for what is already known",
  async () => {
    await withTempRepo(async ({ work, originUrl, originPath }) => {
      const repo = await cloned(work, originUrl);
      await runGit(["branch", "feat/later", "main"], { cwd: originPath });

      const result = await addWorktree(
        repo,
        { branch: "feat/later", fetch: false, push: false },
        silent(),
      );

      expect(result.source).toBe("new");
    });
  },
  30_000,
);

// Re-running has to be safe: that is what makes the command usable in a script.
onPosix(
  "adding a branch that already has a worktree succeeds without doing anything",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      await addWorktree(repo, { branch: "feat/login", fetch: true, push: false }, silent());

      const again = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false },
        silent(),
      );

      expect(again.alreadyPresent).toBe(true);
      expect(await listWorktrees(repo.bare)).toHaveLength(2);
    });
  },
  30_000,
);

onPosix(
  "a branch checked out elsewhere names the directory holding it",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      await addWorktree(
        repo,
        { branch: "feat/login", dir: "somewhere-else", fetch: true, push: false },
        silent(),
      );

      const error = await expectError(
        addWorktree(repo, { branch: "feat/login", fetch: true, push: false }, silent()),
      );

      expect(error.code).toBe("state-conflict");
      expect(error.message).toContain("somewhere-else");
    });
  },
  30_000,
);

onPosix(
  "refuses a directory that already exists",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      await mkdir(join(repo.root, "feat/login"), { recursive: true });

      const error = await expectError(
        addWorktree(repo, { branch: "feat/login", fetch: true, push: false }, silent()),
      );

      expect(error.code).toBe("state-conflict");
      expect(error.hint).toContain("--dir");
    });
  },
  30_000,
);

// The tree on disk mirrors the tree in refs/heads, which is the whole point of
// nesting: `feat/` groups the branches that share the prefix.
onPosix(
  "branches sharing a prefix land in one folder",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const login = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false },
        silent(),
      );
      const search = await addWorktree(
        repo,
        { branch: "feat/search", fetch: true, push: false },
        silent(),
      );

      expect(login.path).toBe(join(repo.root, "feat", "login"));
      expect(search.path).toBe(join(repo.root, "feat", "search"));
      expect(await pathExists(join(repo.root, "feat"))).toBe(true);

      const summaries = await listWorktreeSummaries(repo, work);
      // The `dir` column is the whole relative path, not a basename — otherwise
      // two branches both read as "login" and "search" with no context.
      expect(summaries.map((s) => s.dir).toSorted()).toEqual(["feat/login", "feat/search", "main"]);
    });
  },
  30_000,
);

onPosix(
  "a deeply nested branch nests just as deeply",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const result = await addWorktree(
        repo,
        { branch: "team/api/feat/thing", fetch: true, push: false },
        silent(),
      );

      expect(result.path).toBe(join(repo.root, "team", "api", "feat", "thing"));
      // git creates the intermediate directories itself; nothing here mkdirs.
      expect(await pathExists(join(result.path, "README.md"))).toBe(true);
    });
  },
  30_000,
);

// git allows one worktree inside another and the result is quietly broken: the
// outer one reports the inner one's files as untracked, and `git clean` there
// deletes someone's work. Branches cannot reach this (git forbids `feat` and
// `feat/x` as a ref D/F conflict), but --dir can.
onPosix(
  "refuses a worktree that would nest inside another",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      await addWorktree(repo, { branch: "feat/login", fetch: true, push: false }, silent());

      const swallowing = await expectError(
        addWorktree(repo, { branch: "other", dir: "feat", fetch: false, push: false }, silent()),
      );
      expect(swallowing.code).toBe("state-conflict");

      const swallowed = await expectError(
        addWorktree(
          repo,
          { branch: "other", dir: "feat/login/inner", fetch: false, push: false },
          silent(),
        ),
      );
      expect(swallowed.code).toBe("state-conflict");
    });
  },
  30_000,
);

// On a case-folding filesystem these are one directory; on Linux they are two.
// Refusing beats a repository that only works where it was made.
onPosix(
  "refuses a directory name differing only by case",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);

      const error = await expectError(
        addWorktree(repo, { branch: "feat/x", dir: "MAIN", fetch: false, push: false }, silent()),
      );

      expect(error.code).toBe("state-conflict");
    });
  },
  30_000,
);

onPosix(
  "--push publishes the new branch and sets its upstream",
  async () => {
    await withTempRepo(async ({ work, originUrl, originPath }) => {
      const repo = await cloned(work, originUrl);

      const result = await addWorktree(
        repo,
        { branch: "feat/published", fetch: true, push: true },
        silent(),
      );

      expect(
        await gitOutput(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: result.path }),
      ).toBe("origin/feat/published");
      expect(
        await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
          cwd: originPath,
        }),
      ).toContain("feat/published");
    });
  },
  30_000,
);

onPosix(
  "list reports each worktree's branch, state, and which one you are in",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      const added = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false },
        silent(),
      );
      await Bun.write(join(added.path, "scratch.txt"), "wip\n");

      const summaries = await listWorktreeSummaries(repo, added.path);

      // The default branch sorts first, whatever it is called.
      expect(summaries.map((s) => s.branch)).toEqual(["main", "feat/login"]);
      expect(summaries[0]).toMatchObject({ isDefault: true, dirty: false, current: false });
      expect(summaries[1]).toMatchObject({
        dir: "feat/login",
        dirty: true,
        current: true,
        upstream: "origin/feat/login",
      });
    });
  },
  30_000,
);

onPosix(
  "list counts how far a worktree has drifted",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const repo = await cloned(work, originUrl);
      const main = join(repo.root, "main");

      await Bun.write(join(main, "local.txt"), "local\n");
      await runGit(["add", "-A"], { cwd: main });
      await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "local work"], { cwd: main });

      const summaries = await listWorktreeSummaries(repo, work);
      const summary = summaries[0];

      expect(summary).toBeDefined();
      expect(summary).toMatchObject({ ahead: 1, behind: 0, dirty: false });
      expect(summary && describeState(summary)).toBe("1 ahead");
    });
  },
  30_000,
);
