import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot } from "./discover.ts";
import { type GroveError, isGroveError } from "./errors.ts";
import { GIT_FILE_CONTENTS, type RepoPaths } from "./layout.ts";
import { seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * Discovery is decided by what is on disk, so every fixture here is a real
 * layout: `.bare` plus a `.git` pointer for a managed repository, an ordinary
 * `git clone` for a plain one.
 */

/** The layout `grove clone` produces: `.bare`, a `.git` pointer, and two worktrees. */
async function managedRepo(repo: TempRepo, name = "app"): Promise<string> {
  const root = join(repo.work, name);
  const bare = join(root, ".bare");

  await seedGit(repo.work, ["clone", "--bare", repo.originUrl, bare]);
  await seedGit(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await seedGit(bare, ["fetch", "origin", "--prune"]);
  await Bun.write(join(root, ".git"), GIT_FILE_CONTENTS);
  await seedGit(bare, ["worktree", "add", join(root, "main"), "main"]);
  await seedGit(bare, ["worktree", "add", join(root, "feat", "login"), "feat/login"]);
  await seedGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  return root;
}

async function plainRepo(repo: TempRepo, name = "ordinary"): Promise<string> {
  const root = join(repo.work, name);
  await seedGit(repo.work, ["clone", repo.originUrl, root]);

  return root;
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

describe("a managed repository", () => {
  test("is found from its root, from a worktree, and from deep inside one", async () => {
    await withTempRepo(async (repo) => {
      const root = await managedRepo(repo);
      const nested = join(root, "feat", "login", "src", "deep");
      await mkdir(nested, { recursive: true });

      const expected: RepoPaths = {
        root,
        gitDir: join(root, ".bare"),
        gitFile: join(root, ".git"),
        kind: "managed",
      };

      expect(await findRepoRoot(root)).toEqual(expected);
      expect(await findRepoRoot(join(root, "main"))).toEqual(expected);
      expect(await findRepoRoot(join(root, "feat", "login"))).toEqual(expected);
      expect(await findRepoRoot(nested)).toEqual(expected);
      // `feat` is a plain directory holding a worktree, not a worktree itself.
      expect(await findRepoRoot(join(root, "feat"))).toEqual(expected);
      // The bare repository is the one directory git answers about differently.
      expect(await findRepoRoot(join(root, ".bare"))).toEqual(expected);
    });
  });

  test("is adopted from the directory beside it when it is the only one there", async () => {
    await withTempRepo(async (repo) => {
      const root = await managedRepo(repo);

      expect((await findRepoRoot(repo.work)).root).toBe(root);
    });
  });

  test("is not guessed at when two of them sit side by side", async () => {
    await withTempRepo(async (repo) => {
      await managedRepo(repo, "one");
      await managedRepo(repo, "two");

      const error = await failure(findRepoRoot(repo.work));
      expect(error.code).toBe("usage");
      expect(error.message).toContain("2 repositories here");
      expect(error.hint).toContain("-C");
      expect([...error.details].sort()).toEqual(["one", "two"]);
    });
  });
});

describe("a plain repository", () => {
  test("is recognised as-is, from its root and from a subdirectory", async () => {
    await withTempRepo(async (repo) => {
      const root = await plainRepo(repo);
      const nested = join(root, "src", "deep");
      await mkdir(nested, { recursive: true });

      // No `gitFile`: a plain repo's `.git` *is* its git directory, so the
      // pointer file a managed repo has is not one of its fields at all.
      const expected: RepoPaths = {
        root,
        gitDir: join(root, ".git"),
        kind: "plain",
      };

      expect(await findRepoRoot(root)).toEqual(expected);
      expect(await findRepoRoot(nested)).toEqual(expected);
    });
  });

  test("is not adopted from beside it — only from inside it", async () => {
    await withTempRepo(async (repo) => {
      await plainRepo(repo);

      const error = await failure(findRepoRoot(repo.work));
      expect(error.code).toBe("not-a-repo");
    });
  });

  test("loses to a managed repository found by walking up", async () => {
    await withTempRepo(async (repo) => {
      const root = await managedRepo(repo);
      // An ordinary clone living inside a managed repository's folder: git
      // answers about the inner one, and the `.bare` marker above still wins.
      const inner = join(root, "vendor");
      await seedGit(root, ["clone", repo.originUrl, inner]);

      const found = await findRepoRoot(inner);
      expect(found.kind).toBe("managed");
      expect(found.root).toBe(root);
    });
  });
});

describe("an explicit path", () => {
  test("relocates the search rather than bypassing it", async () => {
    await withTempRepo(async (repo) => {
      const root = await managedRepo(repo);

      // Relative to the invocation directory, as `-C app` would be typed.
      expect((await findRepoRoot(repo.work, "app")).root).toBe(root);
      // Absolute, and pointing at a worktree rather than the root.
      expect((await findRepoRoot(repo.root, join(root, "main"))).root).toBe(root);
      // Pointing at the parent still finds the single repository below it.
      expect((await findRepoRoot(root, "..")).root).toBe(root);
    });
  });

  test("fails on a directory that is under no repository", async () => {
    await withTempRepo(async (repo) => {
      await managedRepo(repo);
      const elsewhere = join(repo.root, "elsewhere");
      await mkdir(elsewhere, { recursive: true });

      const error = await failure(findRepoRoot(repo.work, elsewhere));
      expect(error.code).toBe("not-a-repo");
      // The message names where it looked, which is the resolved explicit path
      // and not the directory the command was invoked from.
      expect(error.message).toContain(elsewhere);
    });
  });

  // Rule 2 spawns git with `cwd` set to a directory that is not there, which
  // fails inside Bun.spawn rather than in git. `spawnProcess` answers the way
  // git would, so the walk falls through to the not-a-repo this means to raise.
  test("fails on a path that does not exist at all", async () => {
    await withTempRepo(async (repo) => {
      const error = await failure(findRepoRoot(repo.work, "no-such-directory"));

      expect(error.code).toBe("not-a-repo");
      expect(error.message).toContain(join(repo.work, "no-such-directory"));
    });
  });
});

test("nothing at all is a not-a-repo failure that says where it looked", async () => {
  await withTempRepo(async (repo) => {
    const nowhere = join(repo.root, "nowhere");
    await mkdir(nowhere, { recursive: true });

    const error = await failure(findRepoRoot(nowhere));

    expect(error.code).toBe("not-a-repo");
    expect(error.message).toContain(nowhere);
    expect(error.hint).toContain("grove clone");
  });
});
