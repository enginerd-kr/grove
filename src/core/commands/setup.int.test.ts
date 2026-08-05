import { expect, test } from "bun:test";
import { lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPlainReporter, type Reporter } from "../../report/reporter.ts";
import type { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { type RepoPaths, repoPaths } from "../layout.ts";
import { pendingCommands, trustAndRun } from "../setup.ts";
import { SETUP_FILE } from "../setup-file.ts";
import { seedGit, withTempRepo } from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";

/**
 * `.grove.toml` against real git and a real disk.
 *
 * Everything here is a claim about files that are *not* in the repository —
 * whether they were copied, linked, left alone, or refused — and nothing but
 * the filesystem can settle those. There is no `setup` command to drive: a
 * worktree is filled in when it is made, so `add` is the way in.
 */

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

/** A reporter that keeps what it was told, for the lines worth asserting on. */
function recording(): { reporter: Reporter; lines: string[] } {
  const lines: string[] = [];

  return {
    reporter: createPlainReporter({ out: () => {}, err: (text) => lines.push(text.trimEnd()) }),
    lines,
  };
}

async function expectError(promise: Promise<unknown>): Promise<GroveError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as GroveError;
}

/** A repo with a `main` worktree holding the untracked files a branch will want. */
async function withRepo(body: (repo: RepoPaths) => Promise<void>): Promise<void> {
  await withTempRepo(async ({ work, originUrl }) => {
    const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
    const repo = repoPaths(root);

    await Bun.write(join(root, "main", ".env"), "TOKEN=secret\n");
    await Bun.write(join(root, "main", "node_modules", "left-pad", "index.js"), "// installed\n");

    await body(repo);
  });
}

/** Writes the repository's file, in the trunk's worktree where setup reads it. */
function configure(repo: RepoPaths, body: string): Promise<number> {
  return Bun.write(join(repo.root, "main", SETUP_FILE), `[setup]\n${body}\n`);
}

function add(
  repo: RepoPaths,
  branch: string,
  options: { trust?: boolean; setup?: boolean } = {},
  reporter: Reporter = silent(),
) {
  return addWorktree(
    repo,
    {
      branch,
      fetch: true,
      push: false,
      setup: options.setup ?? true,
      trust: options.trust ?? false,
    },
    reporter,
  );
}

onPosix("a copied path comes from the default branch's worktree", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]');

    const result = await add(repo, "feat/login");

    expect(result.setup?.copied).toEqual([".env"]);
    expect(await Bun.file(join(repo.root, "feat/login", ".env")).text()).toBe("TOKEN=secret\n");
  });
});

// Relative for the same reason `.git` holds `gitdir: ./.bare` — the repository
// folder is a thing people move, and an absolute link would survive that as a
// link into where it used to be.
onPosix("a linked path becomes a relative symlink to the trunk's copy", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'link = ["node_modules"]');

    const result = await add(repo, "feat/login");
    const link = join(repo.root, "feat/login", "node_modules");

    expect(result.setup?.linked).toEqual(["node_modules"]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    const target = await readlink(link);
    expect(target.startsWith("/")).toBe(false);
    expect(resolve(join(repo.root, "feat/login"), target)).toBe(
      join(repo.root, "main/node_modules"),
    );
    expect(await Bun.file(join(link, "left-pad/index.js")).text()).toBe("// installed\n");
  });
});

onPosix("a path the trunk does not have is reported, not invented", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env.local"]');

    const result = await add(repo, "feat/login");

    expect(result.setup?.missing).toEqual([".env.local"]);
    expect(await pathExists(join(repo.root, "feat/login", ".env.local"))).toBe(false);
  });
});

// What is already there is what the branch checked out, and another branch's
// copy of it is not an improvement — there is no flag that would take it.
onPosix("a path already in the worktree is left exactly as it was", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = ["app.txt"]');
    await Bun.write(join(repo.root, "main", "app.txt"), "trunk's version\n");

    const result = await add(repo, "feat/login");

    expect(result.setup?.kept).toEqual(["app.txt"]);
    expect(await Bun.file(join(repo.root, "feat/login", "app.txt")).text()).toBe("one\n");
  });
});

// One file, in the trunk's worktree. A branch cut last month has no copy of it,
// and reading the local one would mean the repository was configured for the
// worktrees made after Tuesday and not the ones made before.
onPosix("the trunk's file governs, not the new worktree's own", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]');

    const result = await add(repo, "feat/login");

    expect(await pathExists(join(repo.root, "feat/login", SETUP_FILE))).toBe(false);
    expect(result.setup?.copied).toEqual([".env"]);
  });
});

onPosix("a command runs in the new worktree, knowing which one it is", async () => {
  await withRepo(async (repo) => {
    await configure(repo, `run = [${JSON.stringify('echo "$GROVE_BRANCH" > who.txt')}]`);

    const result = await add(repo, "feat/login", { trust: true });

    expect(result.setup?.ran).toEqual(['echo "$GROVE_BRANCH" > who.txt']);
    // Written in the worktree that was just made, not in the trunk or the cwd.
    expect(await Bun.file(join(repo.root, "feat/login", "who.txt")).text()).toBe("feat/login\n");
    expect(await pathExists(join(repo.root, "main", "who.txt"))).toBe(false);
  });
});

// The price of a configuration that travels with the project, and the whole of
// what `--trust` is for: the files move either way, the commands do not.
onPosix("commands wait to be trusted; the copies do not", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]\nrun = ["touch ran.txt"]');

    const { reporter, lines } = recording();
    const untrusted = await add(repo, "feat/login", {}, reporter);

    expect(untrusted.setup?.copied).toEqual([".env"]);
    expect(untrusted.setup?.untrusted).toBe(true);
    expect(untrusted.setup?.ran).toEqual([]);
    expect(await pathExists(join(repo.root, "feat/login", "ran.txt"))).toBe(false);
    expect(lines.join("\n")).toContain("--trust");

    // What was waiting, for the screen to put in its question.
    expect(await pendingCommands(repo)).toEqual(["touch ran.txt"]);

    const trusted = await add(repo, "feat/search", { trust: true });
    expect(trusted.setup?.ran).toEqual(["touch ran.txt"]);
    expect(await pathExists(join(repo.root, "feat/search", "ran.txt"))).toBe(true);
  });
});

// The answer is recorded once and shared: `--trust` and the screen's `y` write
// the same fingerprint, so the next worktree does not ask again.
onPosix("a trusted file stays trusted for the worktrees after it", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'run = ["touch ran.txt"]');
    await add(repo, "feat/login", { trust: true });

    expect(await pendingCommands(repo)).toEqual([]);

    const next = await add(repo, "feat/search");
    expect(next.setup?.ran).toEqual(["touch ran.txt"]);
  });
});

// Contents, not the name: a pull that changes the commands is a new question,
// which is the only version of this worth anything.
onPosix("editing the file takes its trust away again", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'run = ["touch ran.txt"]');
    await add(repo, "feat/login", { trust: true });

    await configure(repo, 'run = ["touch other.txt"]');

    const result = await add(repo, "feat/search");
    expect(result.setup?.untrusted).toBe(true);
    expect(await pathExists(join(repo.root, "feat/search", "other.txt"))).toBe(false);
    expect(await pendingCommands(repo)).toEqual(["touch other.txt"]);
  });
});

// They were written as a sequence — install, then build over what it installed
// — so carrying on past a failure runs the second half against the first
// half's absence.
onPosix("a failed command stops the ones after it, and the worktree still stands", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'run = ["echo nope >&2; exit 3", "touch never.txt"]');

    const result = await add(repo, "feat/login", { trust: true });

    expect(result.setup?.failed?.code).toBe(3);
    expect(result.setup?.failed?.details).toContain("nope");
    expect(result.setup?.ran).toEqual([]);
    expect(await pathExists(join(repo.root, "feat/login", "never.txt"))).toBe(false);

    // `add` was asked for a worktree and there is one; it says the rest out loud.
    expect(await pathExists(join(repo.root, "feat/login", "login.txt"))).toBe(true);
  });
});

onPosix("--no-setup skips all of it", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]\nrun = ["touch ran.txt"]');

    const result = await add(repo, "feat/login", { setup: false, trust: true });

    expect(result.setup).toBeUndefined();
    expect(await pathExists(join(repo.root, "feat/login", ".env"))).toBe(false);
    expect(await pathExists(join(repo.root, "feat/login", "ran.txt"))).toBe(false);
  });
});

// The order matters: a file nobody can resolve should not leave a directory
// behind that the same command then refuses to fill in.
onPosix("a path that could escape the worktree refuses before anything is created", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = ["../../../.ssh"]');

    const error = await expectError(add(repo, "feat/login"));

    expect(error.code).toBe("usage");
    expect(error.message).toContain("copy");
    expect(await pathExists(join(repo.root, "feat/login"))).toBe(false);
  });
});

onPosix("a file that is not valid TOML is refused by name", async () => {
  await withRepo(async (repo) => {
    await Bun.write(join(repo.root, "main", SETUP_FILE), "[setup\ncopy = ");

    const error = await expectError(add(repo, "feat/login"));

    expect(error.code).toBe("usage");
    expect(error.message).toContain(SETUP_FILE);
  });
});

onPosix("no file is no work, and nothing said", async () => {
  await withRepo(async (repo) => {
    const { reporter, lines } = recording();
    const result = await add(repo, "feat/login", {}, reporter);

    expect(result.setup?.planned).toBe(0);
    expect(lines.join("\n")).not.toContain("filling in");
  });
});

// The interaction this tool has to warn about itself: `x` in the app is
// `reset --clean`, which deletes exactly the untracked files setup just wrote.
onPosix("a copied path nothing ignores is called out", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]');

    const { reporter, lines } = recording();
    await add(repo, "feat/login", {}, reporter);

    expect(lines.join("\n")).toContain("not ignored");
  });
});

onPosix("an ignored one is not", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]');
    // `info/exclude` in the common dir, which is where a rule that is yours
    // rather than the project's belongs — and it reaches every worktree.
    await Bun.write(join(repo.bare, "info", "exclude"), ".env\n");

    const { reporter, lines } = recording();
    await add(repo, "feat/login", {}, reporter);

    expect(lines.join("\n")).not.toContain("not ignored");
  });
});

// The first worktree is the one nothing sets up: `copy` and `link` have no
// source — it *is* the source — and `run` is a command from a repository
// downloaded ten seconds ago, which is the worst moment to decide it may
// execute. Saying nothing was the wrong half of that.
onPosix("clone says what the file wants to run, and runs none of it", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'run = ["touch installed.txt"]');
    const main = join(repo.root, "main");
    await seedGit(main, ["add", SETUP_FILE]);
    await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a grove file"]);
    await seedGit(main, ["push", "-q"]);

    // A second clone of the same remote: the file arrives with the checkout,
    // which is exactly what the old "there is no configuration yet" was wrong
    // about.
    const { reporter, lines } = recording();
    const fresh = await cloneRepo(
      join(repo.root, ".."),
      { url: repo.root, dir: "clone" },
      reporter,
    );

    expect(lines.join("\n")).toContain('wants to run "touch installed.txt"');
    expect(await pathExists(join(fresh.worktree, SETUP_FILE))).toBe(true);
    expect(await pathExists(join(fresh.worktree, "installed.txt"))).toBe(false);
  });
});

onPosix("a repository with nothing to run is cloned in silence", async () => {
  await withRepo(async (repo) => {
    const { reporter, lines } = recording();
    await cloneRepo(join(repo.root, ".."), { url: repo.root, dir: "clone" }, reporter);

    expect(lines.join("\n")).not.toContain("wants to run");
  });
});

// Trust is per-repository and the commands are per-worktree, so this is what
// the screen's `y` calls once the worktree it just made is on the row.
onPosix("trustAndRun records the answer and then does the work", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'run = ["touch ran.txt"]');
    const worktree = (await add(repo, "feat/login")).path;
    expect(await pathExists(join(worktree, "ran.txt"))).toBe(false);

    const result = await trustAndRun(repo, { path: worktree, branch: "feat/login" }, silent());

    expect(result.ran).toEqual(["touch ran.txt"]);
    expect(await pathExists(join(worktree, "ran.txt"))).toBe(true);
    expect(await pendingCommands(repo)).toEqual([]);
  });
});

onPosix("the trunk sets nothing up from itself, and still runs its commands", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]\nrun = ["touch ran.txt"]');
    const main = join(repo.root, "main");

    const result = await trustAndRun(repo, { path: main, branch: "main" }, silent());

    expect(result.copied).toEqual([]);
    expect(result.ran).toEqual(["touch ran.txt"]);
    expect(await pathExists(join(main, "ran.txt"))).toBe(true);
  });
});

// git reports `feat/login` as ignored-and-present only where a rule says so;
// what matters here is that the fixture's own commit machinery still works
// around the file this test writes.
onPosix("the file itself is an ordinary tracked file", async () => {
  await withRepo(async (repo) => {
    await configure(repo, 'copy = [".env"]');
    const main = join(repo.root, "main");

    await seedGit(main, ["add", SETUP_FILE]);
    await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a grove file"]);

    // Committed, so a branch cut from main now carries it — and setup still
    // reads the trunk's copy either way.
    const result = await add(repo, "feat/from-main");
    expect(result.setup?.copied).toEqual([".env"]);
  });
});
