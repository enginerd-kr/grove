import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, runGitOrThrow } from "./git.ts";

/**
 * A throwaway git universe for the integration tests.
 *
 * The remote is a bare repository on disk reached over `file://`, so these tests
 * exercise the real fetch/clone machinery — refspecs, remote-tracking refs,
 * pruning — while needing no network and no fixtures checked into the tree.
 */

export type TempRepo = {
  /** Scratch root. Everything below lives here and is deleted afterwards. */
  readonly root: string;
  /** An empty directory to run commands from, standing in for `~/work`. */
  readonly work: string;
  readonly originPath: string;
  /** What you would pass to `wt clone`. */
  readonly originUrl: string;
};

/**
 * git configuration and identity, pinned so these tests do not depend on whose
 * machine they run on.
 *
 * Without `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointing at nothing, a
 * developer's `commit.gpgsign`, `init.defaultBranch`, or a `url.*.insteadOf`
 * rewrite silently changes what these tests do — and CI, having none of that,
 * would disagree with the laptop that wrote them. Pinning here rather than in
 * the workflow file is deliberate: the guarantee travels with the tests.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "wt tests",
  GIT_AUTHOR_EMAIL: "tests@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "wt tests",
  GIT_COMMITTER_EMAIL: "tests@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** Runs git with the pinned test identity. For arranging fixtures, not for assertions. */
export function seedGit(cwd: string, args: readonly string[]): Promise<string> {
  return runGitOrThrow(args, { cwd, env: GIT_ENV });
}

/** Same, but hands back the exit code so a test can assert on a deliberate failure. */
export function probeGit(cwd: string, args: readonly string[]) {
  return runGit(args, { cwd, env: GIT_ENV });
}

async function seedOrigin(root: string, originPath: string): Promise<void> {
  await seedGit(root, ["init", "--bare", "--initial-branch=main", originPath]);

  const seed = join(root, "seed");
  await seedGit(root, ["init", "--initial-branch=main", seed]);
  await seedGit(seed, ["remote", "add", "origin", originPath]);

  await Bun.write(join(seed, "README.md"), "# fixture\n");
  await seedGit(seed, ["add", "-A"]);
  await seedGit(seed, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a readme"]);

  // A second commit on main so `sync` has something to fast-forward over, and a
  // file with a known single line so a later test can conflict on it precisely.
  await Bun.write(join(seed, "app.txt"), "one\n");
  await seedGit(seed, ["add", "-A"]);
  await seedGit(seed, ["-c", "commit.gpgsign=false", "commit", "-m", "Add app.txt"]);
  await seedGit(seed, ["push", "-u", "origin", "main"]);

  // A second branch, so `add` has a remote branch to track that is not the
  // default — the case where a wrong refspec would go unnoticed.
  await seedGit(seed, ["checkout", "-b", "feat/login"]);
  await Bun.write(join(seed, "login.txt"), "login\n");
  await seedGit(seed, ["add", "-A"]);
  await seedGit(seed, ["-c", "commit.gpgsign=false", "commit", "-m", "Add login"]);
  await seedGit(seed, ["push", "-u", "origin", "feat/login"]);

  // The seed clone has served its purpose; leaving it would give discovery a
  // second, unmanaged repository to trip over.
  await rm(seed, { recursive: true, force: true });
}

/**
 * Builds the fixture, runs `body`, and deletes everything afterwards.
 *
 * The pinned git environment is also installed on `process.env` for the
 * duration, because the code under test calls `runGit` without an `env`
 * override — that is the whole point of it being production code.
 */
export async function withTempRepo(body: (repo: TempRepo) => Promise<void>): Promise<void> {
  // Canonicalised because on macOS `tmpdir()` is a symlink (`/var` → `/private/var`)
  // and git reports the resolved path. Without this, every assertion comparing a
  // path git produced against one the test built would fail on the prefix alone.
  const root = await realpath(await mkdtemp(join(tmpdir(), "wt-")));
  const restore = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(GIT_ENV)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const originPath = join(root, "origin.git");
    const work = join(root, "work");

    await seedOrigin(root, originPath);
    await mkdir(work, { recursive: true });

    await body({ root, work, originPath, originUrl: `file://${originPath}` });
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}
