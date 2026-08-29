import { rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
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
  /** What you would pass to `grove clone`. */
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
  GIT_AUTHOR_NAME: "grove tests",
  GIT_AUTHOR_EMAIL: "tests@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "grove tests",
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

const TEMPLATE_PREFIX = "grove-template-";

/**
 * The fixture, built once per test process and copied per test.
 *
 * Seeding costs ~15 git processes; copying the result costs one `cp`. Bun shares
 * module state across the test files in a run, so every test in the process gets
 * its own writable copy of one template rather than its own fifteen processes.
 *
 * THE TEMPLATE MUST STAY PATH-INDEPENDENT. Nothing under it may record where it
 * was built: `seedOrigin` deletes the seed clone precisely so the bare repo is
 * left with no remote pointing at a directory that the copy does not have, and
 * `originUrl` is recomputed from each copy's own root. A future fixture change
 * that bakes an absolute path in — a remote, a worktree `gitdir` pointer, an
 * `alternates` file, a symlink out of the tree — would not break one test loudly;
 * it would break every test at once, and quietly, because each copy would still
 * be a valid repository, just one that reaches back into the template. If you add
 * to the seed, grep the built template for its own root and confirm no hit.
 */
let template: Promise<string> | undefined;

function fixtureTemplate(): Promise<string> {
  // Assigned before the first await, so concurrent first callers share the one
  // build rather than racing to seed several.
  template ??= (async () => {
    await sweepAbandonedTemplates();

    // The pid in the name is what makes that sweep safe; see below.
    const root = await realpath(await mkdtemp(join(tmpdir(), `${TEMPLATE_PREFIX}${process.pid}-`)));

    // `bun test` exits without running either `exit` or `beforeExit`, so this
    // hook is the courtesy path for any other runtime and the sweep above is
    // what actually reclaims the directory. Both are best effort: a killed
    // process runs neither, which is why these live under the OS temp directory.
    process.on("exit", () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    });

    await seedOrigin(root, join(root, "origin.git"));
    await mkdir(join(root, "work"), { recursive: true });
    return root;
  })();
  return template;
}

/**
 * Deletes templates whose builder is gone.
 *
 * Two test runs at once are ordinary — one in a terminal, one in an editor — and
 * deleting a template out from under a live run would break every test in it, so
 * a directory is only reclaimed once the pid in its name is no longer running.
 */
async function sweepAbandonedTemplates(): Promise<void> {
  for (const name of await readdir(tmpdir()).catch(() => [])) {
    if (!name.startsWith(TEMPLATE_PREFIX)) continue;
    const pid = Number(name.slice(TEMPLATE_PREFIX.length).split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || isRunning(pid)) continue;
    await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => {});
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process we are not allowed to signal — alive, and not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "grove-")));
  const restore = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(GIT_ENV)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const originPath = join(root, "origin.git");
    const work = join(root, "work");

    // `cp` keeps file modes and copies symlinks as symlinks, which is what git
    // needs from a copied repository; there is no index and no reflog under the
    // template, so nothing here depends on timestamps either.
    await cp(await fixtureTemplate(), root, { recursive: true });

    await body({ root, work, originPath, originUrl: `file://${originPath}` });
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}
