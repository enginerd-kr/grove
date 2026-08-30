import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ExitCode, errorToExitCode } from "../cli/exit-codes.ts";
import type { Reporter, Step } from "../report/reporter.ts";
import { cloneRepo } from "./commands/clone.ts";
import { type GroveError, isGroveError } from "./errors.ts";
import { entryExists } from "./fs.ts";
import { type RepoPaths, repoPaths } from "./layout.ts";
import {
  checkedSetupPath,
  describeSetup,
  failureFor,
  pendingCommands,
  readSetupPlan,
  repoSetupPlan,
  runSetup,
  runTeardown,
  SETUP_FILE,
  type SetupOptions,
  type SetupResult,
  trustAndRun,
} from "./setup.ts";
import { EMPTY_PLAN, fingerprintOf, isTrusted, openTargetFor, trust } from "./setup-file.ts";
import { seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * Setup against a real repository, because almost everything here is about what
 * lands on disk: what a `copy` line reaches, where a `link` points, and which
 * commands a machine has agreed to run.
 */

type Recorder = {
  readonly reporter: Reporter;
  readonly warnings: string[];
  readonly infos: string[];
  readonly succeeded: string[];
  readonly failed: string[];
  readonly reset: () => void;
};

function recorder(): Recorder {
  const warnings: string[] = [];
  const infos: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];

  const reporter: Reporter = {
    step(text): Step {
      let label = text;

      return {
        update: (next) => {
          label = next;
        },
        progress: () => {},
        succeed: (final) => succeeded.push(final ?? label),
        fail: (final) => failed.push(final ?? label),
      };
    },
    info: (text) => infos.push(text),
    warn: (text) => warnings.push(text),
    out: () => {},
    close: async () => {},
  };

  return {
    reporter,
    warnings,
    infos,
    succeeded,
    failed,
    reset: () => {
      warnings.length = 0;
      infos.length = 0;
      succeeded.length = 0;
      failed.length = 0;
    },
  };
}

type Fixture = {
  readonly temp: TempRepo;
  readonly repo: RepoPaths;
  /** The default branch's worktree — where every copy and link comes from. */
  readonly trunk: string;
  /** A second worktree, the one being set up. */
  readonly worktree: string;
  readonly branch: string;
  readonly log: Recorder;
  /** Writes the trunk's `.grove.toml`, which is the one that governs. */
  readonly configure: (text: string) => Promise<void>;
};

/**
 * A managed repository with two worktrees, built by the real clone command.
 *
 * Going through `cloneRepo` rather than assembling `.bare` by hand is the point:
 * setup reads `origin/HEAD` and `git worktree list` to decide where copies come
 * from, and a hand-built layout would answer those differently than a real one.
 */
async function withRepo(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    const log = recorder();
    const clone = await cloneRepo(temp.work, { url: temp.originUrl, dir: "repo" }, log.reporter);
    const repo = repoPaths(clone.root);

    const branch = "feat/login";
    const worktree = join(clone.root, "feat", "login");
    await seedGit(repo.gitDir, ["worktree", "add", "-b", branch, worktree, "main"]);

    log.reset();

    await body({
      temp,
      repo,
      trunk: clone.worktree,
      worktree,
      branch,
      log,
      configure: async (text) => {
        await Bun.write(join(clone.worktree, SETUP_FILE), text);
      },
    });
  });
}

/** Runs setup against the second worktree, which is what `add` does. */
function setUp(fixture: Fixture, options: SetupOptions = {}): Promise<SetupResult> {
  return runSetup(
    fixture.repo,
    { path: fixture.worktree, branch: fixture.branch },
    options,
    fixture.log.reporter,
  );
}

/**
 * Waits for something an `open` line was going to do, because nothing awaits it.
 *
 * The whole point of `open` is that grove lets go of the process, so a test has
 * no exit code to read and no stream to drain — only the disk, once the child
 * has got there. Polling and not a fixed sleep: on a loaded CI runner a sleep
 * long enough to be safe is long enough to be worth avoiding sixty times over.
 */
async function waitForEntry(path: string, timeout = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await entryExists(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
}

/** Long enough to catch a launch that should not have happened. */
const NOT_OPENED = 400;

function refusalFrom(body: () => unknown): GroveError {
  try {
    body();
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected a GroveError, but nothing was thrown");
}

/** The same, for the refusals that only come out once there is a disk to read. */
async function refusalFromRun(body: () => Promise<unknown>): Promise<GroveError> {
  try {
    await body();
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected a GroveError, but nothing was thrown");
}

describe("checkedSetupPath", () => {
  test("accepts a relative path inside the worktree", () => {
    expect(checkedSetupPath("copy", ".env")).toBe(".env");
    expect(checkedSetupPath("copy", "config/local.json")).toBe("config/local.json");
    expect(checkedSetupPath("link", "node_modules")).toBe("node_modules");
  });

  test("normalises the spellings of the same path", () => {
    expect(checkedSetupPath("copy", "./.env")).toBe(".env");
    expect(checkedSetupPath("copy", "a//b")).toBe("a/b");
    expect(checkedSetupPath("copy", "a/./b/")).toBe("a/b");
    // Windows separators, so one file reads the same on either kind of machine.
    expect(checkedSetupPath("copy", "config\\local.json")).toBe("config/local.json");
  });

  test("refuses a path that climbs out of the worktree", () => {
    for (const value of [
      "..",
      "../.env",
      "../../etc/passwd",
      "a/../../b",
      "a/..",
      "..\\.env",
      "a\\..\\..\\b",
      "./../x",
    ]) {
      const error = refusalFrom(() => checkedSetupPath("copy", value));

      expect(error.code).toBe("usage");
      expect(error.message).toContain(JSON.stringify(value));
      expect(error.hint).toContain("inside the worktree");
    }
  });

  test("refuses an absolute path, on either kind of machine", () => {
    for (const value of [
      "/etc/passwd",
      "/",
      "\\\\server\\share",
      "\\etc\\passwd",
      "C:\\Windows\\system32",
      "c:/Windows",
    ]) {
      expect(refusalFrom(() => checkedSetupPath("copy", value)).code).toBe("usage");
    }
  });

  test("refuses the repository's own plumbing", () => {
    for (const value of [
      ".git",
      ".git/config",
      "a/.git/hooks",
      ".bare",
      ".bare/config",
      "a/.bare",
    ]) {
      expect(refusalFrom(() => checkedSetupPath("copy", value)).code).toBe("usage");
    }
  });

  test("refuses a path that names nothing", () => {
    for (const value of ["", ".", "./", "/", "//", "\\"]) {
      expect(refusalFrom(() => checkedSetupPath("copy", value)).code).toBe("usage");
    }
  });

  test("says which key it was reading", () => {
    expect(refusalFrom(() => checkedSetupPath("link", "../x")).message).toStartWith("link: ");
    expect(refusalFrom(() => checkedSetupPath("copy", "../x")).message).toStartWith("copy: ");
  });

  test("keeps a name that merely looks alarming", () => {
    // Only a segment that *is* `..` climbs; `...` and `..env` are ordinary names.
    expect(checkedSetupPath("copy", "...")).toBe("...");
    expect(checkedSetupPath("copy", "..env")).toBe("..env");
    expect(checkedSetupPath("copy", ".gitignore")).toBe(".gitignore");
    expect(checkedSetupPath("copy", ".github/workflows")).toBe(".github/workflows");
  });
});

describe("readSetupPlan", () => {
  test("checks every path, so a bad line refuses the file as a whole", async () => {
    await withTempRepo(async (temp) => {
      await Bun.write(
        join(temp.work, SETUP_FILE),
        '[setup]\ncopy = [".env", "../../.ssh/id_rsa"]\n',
      );

      await expect(readSetupPlan(temp.work)).rejects.toThrow("is not a usable path");
    });
  });

  test("a worktree with no file plans nothing", async () => {
    await withTempRepo(async (temp) => {
      expect(await readSetupPlan(temp.work)).toEqual(EMPTY_PLAN);
    });
  });
});

describe("repoSetupPlan", () => {
  test("reads the trunk's file, not the worktree being set up", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = [".env"]\n');
      await Bun.write(join(fixture.worktree, SETUP_FILE), '[setup]\nrun = ["exit 1"]\n');

      const plan = await repoSetupPlan(fixture.repo);

      expect(plan.copy).toEqual([".env"]);
      expect(plan.commands).toEqual([]);
      expect(plan.path).toBe(join(fixture.trunk, SETUP_FILE));
    });
  });

  test("falls back to the worktree it was given when the trunk has none", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.worktree, SETUP_FILE), '[setup]\nrun = ["true"]\n');
      await seedGit(fixture.repo.gitDir, ["worktree", "remove", "--force", fixture.trunk]);

      expect((await repoSetupPlan(fixture.repo, fixture.worktree)).commands).toEqual(["true"]);
      // Without a fallback there is nothing to read, and that is not an error.
      expect(await repoSetupPlan(fixture.repo)).toEqual(EMPTY_PLAN);
    });
  });

  test("a repository with no file plans nothing", async () => {
    await withRepo(async (fixture) => {
      expect(await repoSetupPlan(fixture.repo)).toEqual(EMPTY_PLAN);
    });
  });
});

describe("runSetup", () => {
  test("does nothing, and says so, when there is no file", async () => {
    await withRepo(async (fixture) => {
      const result = await setUp(fixture);

      expect(result).toMatchObject({
        planned: 0,
        copied: [],
        linked: [],
        ran: [],
        untrusted: false,
        dir: "feat/login",
      });
      expect(describeSetup(result)).toBe(`no ${SETUP_FILE}`);
      expect(fixture.log.warnings).toEqual([]);
    });
  });

  test("copies files and whole directories out of the trunk", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await Bun.write(join(fixture.trunk, "certs", "dev.pem"), "pem\n");
      await Bun.write(join(fixture.trunk, "certs", "nested", "deep.txt"), "deep\n");
      await fixture.configure('[setup]\ncopy = [".env", "certs"]\n');

      const result = await setUp(fixture);

      expect(result.copied).toEqual([".env", "certs"]);
      expect(await Bun.file(join(fixture.worktree, ".env")).text()).toBe("SECRET=1\n");
      expect(await Bun.file(join(fixture.worktree, "certs", "dev.pem")).text()).toBe("pem\n");
      expect(await Bun.file(join(fixture.worktree, "certs", "nested", "deep.txt")).text()).toBe(
        "deep\n",
      );
      expect(describeSetup(result)).toBe("2 copied");
    });
  });

  test("links to the trunk's copy rather than duplicating it", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "left-pad", "index.js"), "//\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      const result = await setUp(fixture);
      const link = join(fixture.worktree, "node_modules");

      expect(result.linked).toEqual(["node_modules"]);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      // Relative, so moving the repository folder does not break it.
      expect(await readlink(link)).not.toStartWith("/");
      expect(await realpath(link)).toBe(await realpath(join(fixture.trunk, "node_modules")));
      expect(await Bun.file(join(link, "left-pad", "index.js")).text()).toBe("//\n");
    });
  });

  test("reports what the trunk did not have", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = ["nothing-here.txt"]\nlink = ["also-absent"]\n');

      const result = await setUp(fixture);

      expect(result.missing).toEqual(["nothing-here.txt", "also-absent"]);
      expect(result.copied).toEqual([]);
      expect(describeSetup(result)).toBe("nothing to do");
      expect(fixture.log.infos.join("\n")).toContain("nothing-here.txt");
    });
  });

  test("takes the trunk's version of a file the worktree already had", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=fresh\n");
      await Bun.write(join(fixture.worktree, ".env"), "SECRET=stale\n");
      await fixture.configure('[setup]\ncopy = [".env"]\n');

      const result = await setUp(fixture);

      expect(await Bun.file(join(fixture.worktree, ".env")).text()).toBe("SECRET=fresh\n");
      expect(result.overwritten).toEqual([".env"]);
      expect(describeSetup(result)).toBe("1 copied, 1 overwritten");
    });
  });

  test("merges a directory entry by entry instead of replacing it", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "certs", "dev.pem"), "fresh\n");
      await Bun.write(join(fixture.trunk, "certs", "ca.pem"), "ca\n");
      await Bun.write(join(fixture.worktree, "certs", "dev.pem"), "stale\n");
      await Bun.write(join(fixture.worktree, "certs", "mine.pem"), "mine\n");
      await fixture.configure('[setup]\ncopy = ["certs"]\n');

      const result = await setUp(fixture);
      const at = (name: string) => Bun.file(join(fixture.worktree, "certs", name)).text();

      expect(await at("dev.pem")).toBe("fresh\n");
      expect(await at("ca.pem")).toBe("ca\n");
      // The worktree's own file survives — deleting the directory would have
      // taken it with it.
      expect(await at("mine.pem")).toBe("mine\n");
      expect(result.overwritten).toEqual(["certs/dev.pem"]);
    });
  });

  test("leaves a link alone when something is already there", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "a.js"), "trunk\n");
      await Bun.write(join(fixture.worktree, "node_modules", "b.js"), "mine\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      const result = await setUp(fixture);

      expect(result.kept).toEqual(["node_modules"]);
      expect(result.linked).toEqual([]);
      expect((await lstat(join(fixture.worktree, "node_modules"))).isSymbolicLink()).toBe(false);
      expect(await Bun.file(join(fixture.worktree, "node_modules", "b.js")).text()).toBe("mine\n");
      expect(describeSetup(result)).toBe("1 kept");
    });
  });

  test("warns about a copied file git would report as a change", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await Bun.write(join(fixture.trunk, "ignored.txt"), "x\n");
      await Bun.write(join(fixture.trunk, ".gitignore"), "ignored.txt\n");
      await seedGit(fixture.worktree, ["config", "core.excludesFile", "/dev/null"]);
      await Bun.write(join(fixture.worktree, ".gitignore"), "ignored.txt\n");
      await fixture.configure('[setup]\ncopy = [".env", "ignored.txt"]\n');

      await setUp(fixture);

      const warning = fixture.log.warnings.join("\n");

      expect(warning).toContain("not ignored here");
      expect(warning).toContain(".env");
      expect(warning).not.toContain("ignored.txt —");
    });
  });

  describe("commands", () => {
    const RUNS = [
      "[setup]",
      'env = { GREETING = "hello" }',
      `run = ['printf "%s|%s|%s|%s" "$GREETING" "$(pwd)" "$GROVE_WORKTREE" "$GROVE_BRANCH" > ran.txt']`,
    ].join("\n");

    test("waits for trust, and lets the files land anyway", async () => {
      await withRepo(async (fixture) => {
        await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
        await fixture.configure(`[setup]\ncopy = [".env"]\nrun = ["touch ran.txt"]\n`);

        const result = await setUp(fixture);

        expect(result.untrusted).toBe(true);
        expect(result.ran).toEqual([]);
        expect(await entryExists(join(fixture.worktree, "ran.txt"))).toBe(false);
        // The copy is the half that moves files already on this disk.
        expect(result.copied).toEqual([".env"]);
        expect(fixture.log.warnings.join("\n")).toContain("--trust");
        expect(describeSetup(result)).toBe("1 copied, commands not trusted");
      });
    });

    test("pendingCommands is what the screen offers, and empties once trusted", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["bun install", "bun run build"]\n');

        expect(await pendingCommands(fixture.repo)).toEqual(["bun install", "bun run build"]);

        const plan = await repoSetupPlan(fixture.repo);
        await trust(fixture.repo.gitDir, plan.fingerprint ?? "");

        expect(await pendingCommands(fixture.repo)).toEqual([]);
      });
    });

    test("nothing pending for a repository that configures no commands", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\ncopy = [".env"]\n');

        expect(await pendingCommands(fixture.repo)).toEqual([]);
      });
    });

    test("trustAndRun records the file and then does what it says", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(`${RUNS}\n`);

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree, branch: fixture.branch },
          fixture.log.reporter,
        );

        expect(result.untrusted).toBe(false);
        expect(result.ran).toHaveLength(1);
        expect(await Bun.file(join(fixture.worktree, "ran.txt")).text()).toBe(
          // The environment, the cwd, and grove's own answer to "where am I".
          `hello|${fixture.worktree}|${fixture.worktree}|${fixture.branch}`,
        );
      });
    });

    test("a trusted file keeps running without asking again", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["touch ran.txt"]\n');
        await trustAndRun(fixture.repo, { path: fixture.worktree }, recorder().reporter);
        await rm(join(fixture.worktree, "ran.txt"));

        const again = await setUp(fixture);

        expect(again.untrusted).toBe(false);
        expect(again.ran).toEqual(["touch ran.txt"]);
      });
    });

    test("one edit to the file withdraws the trust it was given", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["touch ran.txt"]\n');
        await trustAndRun(fixture.repo, { path: fixture.worktree }, recorder().reporter);

        // What a `git pull` does: the commands change, so the answer no longer
        // covers them.
        await fixture.configure('[setup]\nrun = ["touch ran.txt", "touch surprise.txt"]\n');

        const again = await setUp(fixture);

        expect(again.untrusted).toBe(true);
        expect(again.ran).toEqual([]);
        expect(await entryExists(join(fixture.worktree, "surprise.txt"))).toBe(false);
      });
    });

    test("the file's env cannot lie to the command about where it is", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(
          [
            "[setup]",
            'env = { GROVE_WORKTREE = "/somewhere/else" }',
            `run = ['printf "%s" "$GROVE_WORKTREE" > where.txt']`,
          ].join("\n"),
        );

        await trustAndRun(fixture.repo, { path: fixture.worktree }, fixture.log.reporter);

        expect(await Bun.file(join(fixture.worktree, "where.txt")).text()).toBe(fixture.worktree);
      });
    });

    test("a failed command stops the ones after it and becomes an error", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(
          [
            "[setup]",
            `run = ['touch first.txt', 'echo it broke >&2; exit 3', 'touch third.txt']`,
          ].join("\n"),
        );

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.ran).toEqual(["touch first.txt"]);
        expect(result.failed).toMatchObject({ command: "echo it broke >&2; exit 3", code: 3 });
        expect(result.failed?.details.join("\n")).toContain("it broke");
        expect(await entryExists(join(fixture.worktree, "third.txt"))).toBe(false);

        const error = failureFor(result);

        expect(error?.code).toBe("setup-failed");
        expect(error?.message).toContain("exited 3");
        expect(error?.details.join("\n")).toContain("it broke");
        expect(errorToExitCode(error?.code ?? "usage")).toBe(ExitCode.setupFailed);
      });
    });

    test("no failure means no error to raise", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["true"]\n');

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(failureFor(result)).toBeUndefined();
        expect(describeSetup(result)).toBe("1 run");
      });
    });
  });

  /**
   * `[setup] open`, which is the one key here grove starts and then forgets.
   *
   * Every test below reads the disk rather than a result, because that is all
   * there is to read: nothing is awaited and no stream is kept, so "it opened"
   * can only ever mean "the thing it opened got as far as touching a file".
   */
  describe("open", () => {
    /**
     * `touch` stands in for an editor: it is a real program on PATH, it takes
     * the same shape a configured line takes, and it leaves the only evidence
     * there is to leave — a file, which for a line grove let go of is all a
     * test can look at.
     */
    const OPENS = '[setup]\nopen = "touch opened.txt"\n';

    test("runs the line in the worktree, and says it before it does", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(
          '[setup]\nenv = { GREETING = "hello" }\n' +
            `open = 'printf "%s|%s|%s" "$GREETING" "$(pwd)" "$GROVE_BRANCH" > opened.txt'\n`,
        );

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree, branch: fixture.branch },
          fixture.log.reporter,
        );

        const opened = join(fixture.worktree, "opened.txt");
        expect(await waitForEntry(opened)).toBe(true);
        // `.` in a configured line means the worktree because the cwd does,
        // which is what lets the line be written the way it would be typed
        // there. `$(pwd)` is that promise, checked.
        expect(await Bun.file(opened).text()).toBe(
          ["hello", await realpath(fixture.worktree), fixture.branch].join("|"),
        );
        expect(result.opened).toContain("printf");
        expect(describeSetup(result)).toBe("opened");
        expect(fixture.log.warnings.join("\n")).not.toContain("could not open");
      });
    });

    test("a line that fails fast is said out loud, not swallowed", async () => {
      await withRepo(async (fixture) => {
        // The shape of a misspelled editor: `open -a "Visual Stuio Code"` exits
        // 1 well inside the watching window. Saying nothing here is what made a
        // typo look exactly like an editor that opened.
        await fixture.configure('[setup]\nopen = "exit 4"\n');

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.opened).toBeUndefined();
        // Still not a failure of the add: the worktree is what was asked for.
        expect(failureFor(result)).toBeUndefined();
        expect(fixture.log.warnings.join("\n")).toContain("could not open: exit 4 exited 4");
      });
    });

    test("a line that keeps running is what opening looks like, and is let go", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nopen = "sleep 30"\n');

        const startedAt = Date.now();
        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        // The editor nobody has quit. Watched only long enough to know it did
        // not fall over, then released — `grove add` must not stand behind it.
        expect(result.opened).toBe("sleep 30");
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        expect(fixture.log.warnings.join("\n")).not.toContain("could not open");
      });
    });

    test("waits for the same trust the commands wait for", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(OPENS);

        const result = await setUp(fixture);

        // No `run` in this file at all: the gate has to be counting `open`, or
        // an editor would launch out of a file nobody had read.
        expect(result.untrusted).toBe(true);
        expect(result.opened).toBeUndefined();
        expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
        expect(fixture.log.warnings.join("\n")).toContain("1 command in");
        expect(fixture.log.warnings.join("\n")).toContain("--trust");
      });
    });

    test("is offered with the commands, so the file's whole ask is on the screen", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["bun install"]\nopen = "code ."\n');

        expect(await pendingCommands(fixture.repo)).toEqual(["bun install", "code ."]);
      });
    });

    test("does not open onto a worktree whose setup failed", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["exit 3"]\nopen = "touch opened.txt"\n');

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.failed?.code).toBe(3);
        expect(result.opened).toBeUndefined();
        expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
        expect(fixture.log.infos.join("\n")).toContain("did not open: exit 3 failed");
      });
    });

    test("says so rather than opening nothing quietly when there is no terminal", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(OPENS);
        const plan = await repoSetupPlan(fixture.repo);
        await trust(fixture.repo.gitDir, plan.fingerprint ?? "");

        const result = await setUp(fixture, { open: false });

        expect(result.opened).toBeUndefined();
        expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
        expect(fixture.log.infos.join("\n")).toContain("did not open: this is not a terminal");
      });
    });

    test("a worktree that vanished is a warning, not a failed add", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(OPENS);
        const plan = await repoSetupPlan(fixture.repo);
        await trust(fixture.repo.gitDir, plan.fingerprint ?? "");

        // The failure that happens before the line runs at all: there is no
        // directory to run it in.
        const result = await runSetup(
          fixture.repo,
          { path: join(fixture.worktree, "gone") },
          {},
          fixture.log.reporter,
        );

        expect(result.opened).toBeUndefined();
        expect(failureFor(result)).toBeUndefined();
        expect(fixture.log.warnings.join("\n")).toContain("could not open");
      });
    });

    test("a file that names other platforms opens nothing here, and says which", async () => {
      await withRepo(async (fixture) => {
        // Whichever platform this is not. The point is a real team file: the
        // Mac users wrote their line, and nobody added the Linux one.
        const elsewhere = process.platform === "win32" ? "macos" : "windows";
        await fixture.configure(`[setup.open]\n${elsewhere} = "touch opened.txt"\n`);

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.opened).toBeUndefined();
        expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
        // Not silence: finding out from the run beats finding out from asking
        // why everyone else's editor opened and yours did not.
        expect(fixture.log.infos.join("\n")).toContain(
          `nothing in ${SETUP_FILE} opens on ${openTargetFor(process.platform)}`,
        );
      });
    });

    test("the platform's own line is the one that is offered and the one that runs", async () => {
      await withRepo(async (fixture) => {
        const here = openTargetFor(process.platform);
        const elsewhere = here === "macos" ? "linux" : "macos";
        await fixture.configure(
          `[setup.open]\n${here} = "touch mine.txt"\n${elsewhere} = "touch theirs.txt"\n`,
        );

        // One line read once: what is offered for trust is what will start.
        expect(await pendingCommands(fixture.repo)).toEqual(["touch mine.txt"]);

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.opened).toBe("touch mine.txt");
        expect(await waitForEntry(join(fixture.worktree, "mine.txt"))).toBe(true);
        expect(await waitForEntry(join(fixture.worktree, "theirs.txt"), NOT_OPENED)).toBe(false);
      });
    });
  });

  test("uses a plan the caller already read", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure('[setup]\ncopy = ["never-read.txt"]\n');

      const result = await runSetup(
        fixture.repo,
        { path: fixture.worktree },
        { plan: { ...EMPTY_PLAN, copy: [".env"] } },
        fixture.log.reporter,
      );

      expect(result.copied).toEqual([".env"]);
    });
  });
});

describe("describeSetup", () => {
  const base: SetupResult = {
    path: "/repo/feat/login",
    dir: "feat/login",
    planned: 0,
    copied: [],
    linked: [],
    ran: [],
    missing: [],
    kept: [],
    overwritten: [],
    untrusted: false,
  };

  test("nothing configured reads differently from nothing to do", () => {
    expect(describeSetup(base)).toBe(`no ${SETUP_FILE}`);
    expect(describeSetup({ ...base, planned: 2 })).toBe("nothing to do");
  });

  test("counts what happened, in the order it happened", () => {
    expect(
      describeSetup({
        ...base,
        planned: 5,
        copied: [".env", "certs"],
        overwritten: [".env"],
        linked: ["node_modules"],
        ran: ["bun install"],
        kept: ["build"],
      }),
    ).toBe("2 copied, 1 overwritten, 1 linked, 1 run, 1 kept");
  });

  test("says when the commands are waiting on somebody", () => {
    expect(describeSetup({ ...base, planned: 1, untrusted: true })).toBe("commands not trusted");
  });
});

describe("runTeardown", () => {
  const teardown = (fixture: Fixture) =>
    runTeardown(
      fixture.repo,
      { path: fixture.worktree, branch: fixture.branch },
      fixture.log.reporter,
    );

  test("a repository with no [teardown] has nothing to run", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = [".env"]\n');

      expect(await teardown(fixture)).toMatchObject({ planned: 0, ran: [], untrusted: false });
      expect(fixture.log.warnings).toEqual([]);
    });
  });

  test("runs the commands inside the worktree, with [teardown]'s own env", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[setup]",
        'env = { TOKEN = "install" }',
        "",
        "[teardown]",
        'env = { TOKEN = "cleanup" }',
        `run = ['printf "%s|%s" "$TOKEN" "$(pwd)" > /dev/stderr; printf "%s|%s" "$TOKEN" "$(pwd)" > gone.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);
      await trust(fixture.repo.gitDir, fingerprintOf(`${text}\n`));

      const result = await teardown(fixture);

      expect(result.ran).toHaveLength(1);
      expect(result.failed).toBeUndefined();
      // `[setup]`'s value is not in reach: the credential that installs and the
      // one that tears down are rarely the same.
      expect(await Bun.file(join(fixture.worktree, "gone.txt")).text()).toBe(
        `cleanup|${fixture.worktree}`,
      );
    });
  });

  test("a failing command is loud, but does not block the removal", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[teardown]",
        `run = ['echo docker is not running >&2; exit 7', 'touch never.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);
      await trust(fixture.repo.gitDir, fingerprintOf(`${text}\n`));

      // Resolves rather than throws — that is the whole rule.
      const result = await teardown(fixture);

      expect(result.failed).toMatchObject({ code: 7 });
      expect(result.failed?.details.join("\n")).toContain("docker is not running");
      expect(result.ran).toEqual([]);
      expect(await entryExists(join(fixture.worktree, "never.txt"))).toBe(false);
      expect(fixture.log.failed.join("\n")).toContain("exited 7");

      // And the worktree it was finished with really can go.
      await seedGit(fixture.repo.gitDir, ["worktree", "remove", "--force", fixture.worktree]);
      expect(await entryExists(fixture.worktree)).toBe(false);
    });
  });

  test("untrusted commands are skipped and the worktree still goes", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[teardown]\nrun = ["touch never.txt"]\n');

      const result = await teardown(fixture);

      expect(result).toMatchObject({ planned: 1, ran: [], untrusted: true });
      expect(await entryExists(join(fixture.worktree, "never.txt"))).toBe(false);
      expect(fixture.log.warnings.join("\n")).toContain("the worktree still goes");
    });
  });

  test("one trust covers both sections, and one edit withdraws both", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[setup]",
        `run = ['touch setup-ran.txt']`,
        "",
        "[teardown]",
        `run = ['touch teardown-ran.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);

      // One `--trust`, given for the whole file by the setup half.
      await trustAndRun(fixture.repo, { path: fixture.worktree }, fixture.log.reporter);

      expect(await entryExists(join(fixture.worktree, "setup-ran.txt"))).toBe(true);
      expect((await teardown(fixture)).untrusted).toBe(false);
      expect(await entryExists(join(fixture.worktree, "teardown-ran.txt"))).toBe(true);

      // One edit, in the `[setup]` half only, and the teardown stops too.
      const edited = text.replace("setup-ran.txt", "setup-ran-again.txt");
      await fixture.configure(`${edited}\n`);
      await rm(join(fixture.worktree, "teardown-ran.txt"));

      const after = await teardown(fixture);

      expect(after.untrusted).toBe(true);
      expect(after.ran).toEqual([]);
      expect(await isTrusted(fixture.repo.gitDir, fingerprintOf(`${edited}\n`))).toBe(false);
    });
  });

  test("reads [teardown] from the trunk, like everything else here", async () => {
    await withRepo(async (fixture) => {
      const text = "[teardown]\nrun = ['touch from-trunk.txt']\n";
      await fixture.configure(text);
      await Bun.write(
        join(fixture.worktree, SETUP_FILE),
        "[teardown]\nrun = ['touch from-worktree.txt']\n",
      );
      await trust(fixture.repo.gitDir, fingerprintOf(text));

      await teardown(fixture);

      expect(await entryExists(join(fixture.worktree, "from-trunk.txt"))).toBe(true);
      expect(await entryExists(join(fixture.worktree, "from-worktree.txt"))).toBe(false);
    });
  });
});

describe("the paths a configured line can reach", () => {
  /**
   * A committed symlink in the trunk is a path check `checkedSetupPath` cannot
   * see: the value has no `..` in it, and the climb happens on disk instead.
   *
   * So the disk is what decides. `copy = ["certs/id_rsa"]` against a trunk
   * where `certs` is a symlink to `~/.ssh` is refused rather than run, and the
   * key never reaches a worktree somebody is about to commit from.
   */
  test("a copy cannot follow a symlink in the source out of the worktree", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "PRIVATE KEY\n");

      // What a repository can commit: a symlink under an innocent name.
      await symlink(outside, join(fixture.trunk, "certs"));

      await fixture.configure('[setup]\ncopy = ["certs/id_rsa"]\n');

      const error = await refusalFromRun(() => setUp(fixture));

      expect(error.code).toBe("usage");
      expect(error.message).toContain('"certs/id_rsa"');
      expect(error.details.join("\n")).toContain(join(outside, "id_rsa"));
      expect(await entryExists(join(fixture.worktree, "certs", "id_rsa"))).toBe(false);
    });
  });

  test("a link source out of the worktree is refused too", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(join(outside, "node_modules"), { recursive: true });
      await symlink(join(outside, "node_modules"), join(fixture.trunk, "node_modules"));

      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      expect((await refusalFromRun(() => setUp(fixture))).code).toBe("usage");
      expect(await entryExists(join(fixture.worktree, "node_modules"))).toBe(false);
    });
  });

  test("a link inside the directory being copied is checked as well", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "PRIVATE KEY\n");

      await mkdir(join(fixture.trunk, "config", "keys"), { recursive: true });
      await symlink(join(outside, "id_rsa"), join(fixture.trunk, "config", "keys", "id_rsa"));

      await fixture.configure('[setup]\ncopy = ["config"]\n');

      const error = await refusalFromRun(() => setUp(fixture));

      expect(error.message).toContain('"config/keys/id_rsa"');
      expect(await entryExists(join(fixture.worktree, "config"))).toBe(false);
    });
  });

  test("a symlink that stays inside the worktree is still taken", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "config", "dev.json"), "{}\n");
      await symlink("dev.json", join(fixture.trunk, "config", "local.json"));
      // A link pointing at nothing yet is where it points, not whether it lands.
      await symlink("not-yet.json", join(fixture.trunk, "config", "pending.json"));

      await fixture.configure('[setup]\ncopy = ["config"]\n');

      expect((await setUp(fixture)).copied).toEqual(["config"]);
      expect(await readlink(join(fixture.worktree, "config", "local.json"))).toBe("dev.json");
    });
  });

  test("a link is created inside the worktree it was made for", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "a.js"), "//\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      await setUp(fixture);

      const link = join(fixture.worktree, "node_modules");
      const target = resolve(dirname(link), await readlink(link));

      expect(target).toBe(join(fixture.trunk, "node_modules"));
    });
  });
});
