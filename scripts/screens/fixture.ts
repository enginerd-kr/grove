import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../../src/core/commands/add.ts";
import { cloneRepo } from "../../src/core/commands/clone.ts";
import { runGitOrThrow } from "../../src/core/git.ts";
import { type RepoPaths, repoPaths } from "../../src/core/layout.ts";
import { createPlainReporter } from "../../src/report/reporter.ts";

/**
 * A repository worth taking a picture of.
 *
 * Everything the README shows is drawn from real worktrees: the branches are
 * branches, the `↑2 ↓1` was counted by `git rev-list`, and the dirty dot is a
 * file that is really uncommitted. Built by `grove`'s own `clone` and `add`
 * rather than by hand, so the layout in the picture is the layout the tool
 * makes — a fixture arranged with plain `git worktree add` could drift from it
 * and the pictures would be the last place anyone noticed.
 */

/**
 * Dates pinned, so a re-shot README differs where the UI changed and nowhere
 * else. The `last` column reads relative to now, so these are set at build
 * time against the clock rather than as literals.
 */
const AGES_HOURS: Readonly<Record<string, number>> = {
  main: 26,
  "feat/login": 2,
  "feat/search": 5,
  "fix/crash": 49,
  "chore/docs": 100,
};

/**
 * The `.grove.toml` the pictures are taken over.
 *
 * Committed on the trunk, which is where a real one lives and where `grove`
 * reads it from — so `a` in the pictures does what `a` does in a repository
 * that has one: the `.env` is copied, `node_modules` is shared, and the
 * install runs.
 */
const SETUP_FILE = `[setup]
copy = [".env"]
link = ["node_modules"]
run  = ["bun install"]
`;

const IDENTITY: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "grove",
  GIT_AUTHOR_EMAIL: "grove@example.invalid",
  GIT_COMMITTER_NAME: "grove",
  GIT_COMMITTER_EMAIL: "grove@example.invalid",
};

export type Fixture = {
  readonly repo: RepoPaths;
  /** Where the app is standing: the worktree a person would have opened it in. */
  readonly cwd: string;
  readonly dispose: () => Promise<void>;
};

/** A reporter with nowhere to write: the fixture's own progress is not the picture. */
const quiet = createPlainReporter({ out: () => {}, err: () => {} });

function at(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

/** git, with the identity pinned and a commit date that will not move. */
function git(cwd: string, args: readonly string[], hoursAgo = 24): Promise<string> {
  const when = at(hoursAgo);

  return runGitOrThrow(args, {
    cwd,
    env: {
      ...process.env,
      ...IDENTITY,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

async function commit(cwd: string, file: string, body: string, message: string, hoursAgo: number) {
  await Bun.write(join(cwd, file), body);
  await git(cwd, ["add", "-A"], hoursAgo);
  await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", message], hoursAgo);
}

/**
 * The remote every branch in the picture comes from.
 *
 * A bare repository on disk, reached over `file://` — the same trick the tests
 * use. No network, and the fetch, the tracking refs and the drift arithmetic
 * are all the real ones.
 */
async function seedOrigin(root: string): Promise<string> {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");

  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await git(seed, ["remote", "add", "origin", origin]);

  await commit(seed, "README.md", "# acme\n", "Add a readme", 400);
  await commit(seed, "src/app.ts", "export const app = 1;\n", "Add the entry point", 390);
  // No trailing slash on `node_modules`: what `link` puts in a worktree is a
  // symlink, and `node_modules/` matches a directory only — with the slash,
  // every worktree in the pictures would read as dirty.
  await Bun.write(join(seed, ".gitignore"), ".env\nnode_modules\n");
  await Bun.write(join(seed, "package.json"), '{ "name": "acme", "private": true }\n');
  await commit(seed, ".grove.toml", SETUP_FILE, "Set worktrees up on arrival", 380);
  await git(seed, ["push", "-u", "origin", "main"], 380);

  for (const [branch, hours] of Object.entries(AGES_HOURS)) {
    if (branch === "main") continue;

    await git(seed, ["checkout", "-B", branch, "main"], hours);
    await commit(seed, `${branch.replace("/", "-")}.ts`, "export {};\n", `Start ${branch}`, hours);
    await git(seed, ["push", "-u", "origin", branch], hours);
  }

  // Two commits landing on main after everyone branched: what `↓2` in the
  // trunk column is counting, and what `s` exists to close.
  await git(seed, ["checkout", "main"], AGES_HOURS.main ?? 26);
  await commit(seed, "src/app.ts", "export const app = 2;\n", "Tighten the entry point", 30);
  await commit(seed, "CHANGELOG.md", "# changelog\n", "Start a changelog", 26);
  await git(seed, ["push", "origin", "main"], 26);

  await rm(seed, { recursive: true, force: true });

  return origin;
}

export async function buildFixture(): Promise<Fixture> {
  // Canonicalised because macOS's `tmpdir()` is a symlink (`/var` →
  // `/private/var`), and a `~` that failed to match `HOME` would put the
  // machine's real temp path in the banner of a published picture.
  const root = await realpath(await mkdtemp(join(tmpdir(), "grove-shots-")));

  // A home of our own, so the banner's path reads the way it reads on a real
  // machine — `~/work/acme` — instead of naming a temp directory. `HOME` is
  // what `shortenPath` compares against, and `USER` is what the greeting says:
  // left alone it would put whoever re-shot the README into the picture.
  process.env.HOME = root;
  process.env.USER = "";
  for (const [key, value] of Object.entries(IDENTITY)) process.env[key] = value;

  const origin = await seedOrigin(root);
  const work = join(root, "work");
  await mkdir(work, { recursive: true });

  const cloned = await cloneRepo(work, { url: `file://${origin}`, dir: "acme" }, quiet);
  const repo = repoPaths(cloned.root);

  // What `copy` and `link` are pointed at: untracked, machine-local, and
  // exactly the two things nobody wants to re-make per worktree by hand.
  const trunk = join(cloned.root, "main");
  await Bun.write(join(trunk, ".env"), "DATABASE_URL=postgres://localhost/acme\n");
  await mkdir(join(trunk, "node_modules", ".bin"), { recursive: true });

  // `trust: false`, deliberately: the file's commands stay unread, so the `a`
  // in the pictures is the first time anything has agreed to run them — which
  // is the row the setup picture is of.
  for (const branch of ["feat/login", "feat/search", "fix/crash", "chore/docs"]) {
    await addWorktree(
      repo,
      cloned.root,
      { branch, fetch: false, push: false, setup: true, trust: false, take: false },
      quiet,
    );
  }

  // Work that exists only here: two commits on `feat/login`, so `origin` reads
  // `↑2 ↓0` on the row and `main` reads what the trunk moved on without it.
  const login = join(cloned.root, "feat", "login");
  await commit(login, "src/login.ts", "export const login = 1;\n", "Add the form", 3);
  await commit(login, "src/login.test.ts", "export {};\n", "Cover the form", 2);

  // Changes nobody has committed — the dot in `state`, and what `x` throws away.
  const search = join(cloned.root, "feat", "search");
  await Bun.write(join(search, "src/search.ts"), "export const search = 1;\n");
  await Bun.write(join(search, "src/app.ts"), "export const app = 3;\n");
  await Bun.write(join(search, "notes.md"), "ranking, then paging\n");

  return {
    repo,
    cwd: trunk,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
