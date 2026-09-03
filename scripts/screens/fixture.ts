import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../../src/core/commands/add.ts";
import { cloneRepo } from "../../src/core/commands/clone.ts";
import { runGitOrThrow } from "../../src/core/git.ts";
import { type RepoPaths, repoPaths } from "../../src/core/layout.ts";
import { createPlainReporter } from "../../src/report/reporter.ts";
import { NOW } from "./clock.ts";

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
 * How long before `NOW` each branch was last worked in — which is what the
 * `last` column ends up reading, since the column measures against the same
 * pinned moment the dates are built from.
 *
 * Offsets rather than dates, so the column can be *chosen*: these are the
 * spellings the picture should show — `2h ago`, `1d ago`, `4d ago` — rather
 * than whatever a set of literal dates happened to work out to. Keep them
 * clear of the boundaries `describeAge` turns on (an hour, a day, a week) so a
 * reader of this table can tell what the picture will say.
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
  /**
   * The temp directory the whole thing was built in.
   *
   * Handed back so a shot can refuse to publish a frame with it in: the path
   * is different on every run and on every machine, and a picture that had one
   * character of it showing would fail the check that the committed pictures
   * still match the program, for a reason that has nothing to do with the
   * program.
   */
  readonly root: string;
  /** Where the app is standing: the worktree a person would have opened it in. */
  readonly cwd: string;
  /**
   * Every branch this made a worktree for, trunk first.
   *
   * Handed back so a shot can wait for the screen to have read the repository
   * without waiting on a row of the list — the banner counts these, and unlike
   * a row it cannot scroll out of the picture.
   */
  readonly branches: readonly string[];
  readonly dispose: () => Promise<void>;
};

/** The trunk, and the branches given worktrees on top of it. */
const TRUNK = "main";
const BRANCHES = ["feat/login", "feat/search", "fix/crash", "chore/docs"] as const;

/** A reporter with nowhere to write: the fixture's own progress is not the picture. */
const quiet = createPlainReporter({ out: () => {}, err: () => {} });

/**
 * The moment the ages below are measured back from.
 *
 * `NOW` for the pictures, which are compared byte for byte and so must be
 * built from a clock that does not move. The demo recording cannot use it: it
 * launches the app in a separate process, on the real clock, where a fixture
 * dated from a pinned moment in the past would put `1w ago` in the `last`
 * column where the recording wants `2h ago`. So `buildFixture` takes the
 * moment, and only the demo passes one.
 */
let measuredFrom = NOW;

function at(hoursAgo: number): string {
  return new Date(measuredFrom - hoursAgo * 3_600_000).toISOString();
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
  //
  // `bun.lock` is there for the same reason one step removed: the `add` picture
  // runs a real `bun install` in the worktree it has just made, and the row it
  // is a picture of reads clean. A bun that writes a lockfile for a package
  // with no dependencies — this one does not, a later one on a CI runner might
  // — would turn that `○` into a `●` on whichever machine had it, and the
  // pictures are committed and compared byte for byte.
  await Bun.write(join(seed, ".gitignore"), ".env\nnode_modules\nbun.lock\n");
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

export type FixtureOptions = {
  /** What the ages are measured back from. Defaults to the pictures' pinned moment. */
  readonly now?: number;
};

export async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  measuredFrom = options.now ?? NOW;

  // Canonicalised because macOS's `tmpdir()` is a symlink (`/var` →
  // `/private/var`), and a `~` that failed to match `HOME` would put the
  // machine's real temp path in the banner of a published picture.
  const root = await realpath(await mkdtemp(join(tmpdir(), "grove-shots-")));

  // A home of our own, so the banner's path reads the way it reads on a real
  // machine — `~/work/acme` — instead of naming a temp directory. `HOME` is
  // what `shortenPath` compares against, and `USER` is what the greeting says:
  // left alone it would put whoever re-shot the README into the picture.
  process.env.HOME = root;
  // Both spellings the banner tries, because it falls through to the second
  // only when the first is missing — and on a machine that sets `USERNAME`,
  // clearing `USER` alone would still put whoever re-shot the README into the
  // greeting.
  process.env.USER = "";
  process.env.USERNAME = "";
  for (const [key, value] of Object.entries(IDENTITY)) process.env[key] = value;

  const origin = await seedOrigin(root);
  const work = join(root, "work");
  await mkdir(work, { recursive: true });

  const cloned = await cloneRepo(work, { url: `file://${origin}`, dir: "acme" }, quiet);
  const repo = repoPaths(cloned.root);

  // What `copy` and `link` are pointed at: untracked, machine-local, and
  // exactly the two things nobody wants to re-make per worktree by hand.
  const trunk = join(cloned.root, TRUNK);
  await Bun.write(join(trunk, ".env"), "DATABASE_URL=postgres://localhost/acme\n");
  await mkdir(join(trunk, "node_modules", ".bin"), { recursive: true });

  // `trust: false`, deliberately: the file's commands stay unread, so the `a`
  // in the pictures is the first time anything has agreed to run them — which
  // is the row the setup picture is of.
  for (const branch of BRANCHES) {
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
    root,
    cwd: trunk,
    branches: [TRUNK, ...BRANCHES],
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
