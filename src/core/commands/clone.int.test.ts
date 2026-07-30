import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import { findRepoRoot } from "../discover.ts";
import type { WtError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { gitOutput, runGit } from "../git.ts";
import { withTempRepo } from "../test-utils.ts";
import { cloneRepo } from "./clone.ts";

const onPosix = test.skipIf(process.platform === "win32");

/** Discards output; these tests assert on the repository, not the narration. */
const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<WtError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as WtError;
}

onPosix(
  "lays out .bare, the .git pointer, and a worktree for the default branch",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const result = await cloneRepo(work, { url: originUrl }, silent());

      expect(result.root).toBe(join(work, "origin"));
      expect(result.branch).toBe("main");
      expect(result.defaultBranch).toBe("main");
      expect(result.worktree).toBe(join(work, "origin", "main"));

      expect(await pathExists(join(result.root, ".bare", "HEAD"))).toBe(true);
      // The relative form matters: it is what lets the repo folder be moved.
      expect(await Bun.file(join(result.root, ".git")).text()).toBe("gitdir: ./.bare\n");
      expect(await pathExists(join(result.worktree, "README.md"))).toBe(true);
    });
  },
  30_000,
);

// The bug this whole command exists to prevent. Without the refspec, fetch exits
// 0 having populated nothing and every later command fails somewhere else.
onPosix(
  "configures the fetch refspec so remote-tracking refs actually appear",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { bare } = await cloneRepo(work, { url: originUrl }, silent());

      expect(await gitOutput(["config", "--get", "remote.origin.fetch"], { cwd: bare })).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );

      const refs = await gitOutput(["for-each-ref", "--format=%(refname)", "refs/remotes/"], {
        cwd: bare,
      });
      expect(refs).toContain("refs/remotes/origin/main");
      // The branch that is *not* the default is the one a wrong refspec loses.
      expect(refs).toContain("refs/remotes/origin/feat/login");
      expect(refs).toContain("refs/remotes/origin/HEAD");
    });
  },
  30_000,
);

// The invariant the rest of the tool leans on: a local branch exists exactly
// when a worktree holds it.
onPosix(
  "keeps only the branch that has a worktree in refs/heads",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { bare } = await cloneRepo(work, { url: originUrl }, silent());

      expect(
        await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
          cwd: bare,
        }),
      ).toBe("main");
      // HEAD has to point at a ref that survived the pruning.
      expect(await gitOutput(["symbolic-ref", "--short", "HEAD"], { cwd: bare })).toBe("main");
    });
  },
  30_000,
);

onPosix(
  "--branch checks out something other than the default without losing the default",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const result = await cloneRepo(work, { url: originUrl, branch: "feat/login" }, silent());

      expect(result.branch).toBe("feat/login");
      // Still reported as the remote's trunk, which is what sync rebases onto.
      expect(result.defaultBranch).toBe("main");
      expect(result.worktree).toBe(join(result.root, "feat-login"));
      expect(await pathExists(join(result.worktree, "login.txt"))).toBe(true);

      expect(await gitOutput(["symbolic-ref", "--short", "HEAD"], { cwd: result.bare })).toBe(
        "feat/login",
      );
    });
  },
  30_000,
);

onPosix(
  "the checked-out branch tracks its remote counterpart",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { worktree } = await cloneRepo(work, { url: originUrl }, silent());

      expect(await gitOutput(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: worktree })).toBe(
        "origin/main",
      );
    });
  },
  30_000,
);

onPosix(
  "the second positional names the repo directory",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const result = await cloneRepo(work, { url: originUrl, dir: "myrepo" }, silent());

      expect(result.root).toBe(join(work, "myrepo"));
    });
  },
  30_000,
);

onPosix(
  "refuses a directory that already has something in it",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      await mkdir(join(work, "taken"), { recursive: true });
      await Bun.write(join(work, "taken", "notes.txt"), "mine\n");

      const error = await expectError(cloneRepo(work, { url: originUrl, dir: "taken" }, silent()));

      expect(error.code).toBe("state-conflict");
      // Nothing of ours may appear next to their file.
      expect(await pathExists(join(work, "taken", ".bare"))).toBe(false);
    });
  },
  30_000,
);

// Re-running a failed clone has to behave like the first attempt; a leftover
// partial .bare would make discovery find a broken repository instead.
onPosix(
  "cleans up after a failed clone so the next attempt is unobstructed",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const error = await expectError(
        cloneRepo(work, { url: `${originUrl}-does-not-exist`, dir: "repo" }, silent()),
      );

      expect(error.code).toBe("remote");
      expect(await pathExists(join(work, "repo"))).toBe(false);

      const retry = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
      expect(retry.branch).toBe("main");
    });
  },
  30_000,
);

onPosix(
  "rejects a URL shape before spawning anything",
  async () => {
    await withTempRepo(async ({ work }) => {
      const error = await expectError(cloneRepo(work, { url: "github.com/org/repo" }, silent()));

      expect(error.code).toBe("usage");
    });
  },
  30_000,
);

onPosix(
  "--branch naming a branch the remote lacks fails without leaving a repo behind",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const error = await expectError(
        cloneRepo(work, { url: originUrl, branch: "nope" }, silent()),
      );

      expect(error.code).toBe("usage");
      expect(await pathExists(join(work, "origin"))).toBe(false);
    });
  },
  30_000,
);

onPosix(
  "discovery finds the new repo from inside it, from it, and from beside it",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root, worktree } = await cloneRepo(work, { url: originUrl }, silent());
      const nested = join(worktree, "deep", "deeper");
      await mkdir(nested, { recursive: true });

      // Rule 2: git resolves the common dir from any depth inside a worktree.
      expect((await findRepoRoot(nested)).root).toBe(root);
      expect((await findRepoRoot(worktree)).root).toBe(root);
      // Rule 3: the repo folder itself.
      expect((await findRepoRoot(root)).root).toBe(root);
      // Rule 4: standing next to exactly one managed repository.
      expect((await findRepoRoot(work)).root).toBe(root);
    });
  },
  30_000,
);

onPosix(
  "two repositories side by side is an error rather than a guess",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      await cloneRepo(work, { url: originUrl, dir: "one" }, silent());
      await cloneRepo(work, { url: originUrl, dir: "two" }, silent());

      const error = await expectError(findRepoRoot(work));

      expect(error.code).toBe("usage");
      expect(error.details).toEqual(expect.arrayContaining(["one", "two"]));

      // -C relocates the rules rather than bypassing them, so naming either
      // repository resolves cleanly.
      expect((await findRepoRoot(work, "two")).root).toBe(join(work, "two"));
    });
  },
  30_000,
);

onPosix(
  "an ordinary clone nearby is not mistaken for a managed repo",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const plain = join(work, "plain");
      await runGit(["clone", originUrl, plain], { cwd: work });

      const error = await expectError(findRepoRoot(plain));

      expect(error.code).toBe("not-a-repo");
    });
  },
  30_000,
);
