import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GroveError, isGroveError } from "../core/errors.ts";
import { pathExists } from "../core/fs.ts";
import { traceGit } from "../core/git.ts";
import { probeGit, type TempRepo, withTempRepo } from "../core/test-utils.ts";
import { createPlainReporter, type Reporter } from "../report/reporter.ts";
import type { GlobalOptions, GroveCommand } from "./args.ts";
import { ExitCode, errorToExitCode } from "./exit-codes.ts";
import { SUBCOMMANDS } from "./help.ts";
import { runCommand } from "./run.ts";
import { runCli } from "./test-cli.ts";

/**
 * The wiring between a parsed command line and a command.
 *
 * `args.test.ts` stops once the argv has become a `GroveCommand`, and each
 * command's own test starts once it has been called — so everything asserted
 * here lives in the gap: which implementation a name reaches, what the global
 * flags actually change, and which writer each kind of output goes to.
 *
 * `runCommand` is called directly with a hand-built `CommandContext` rather
 * than through the binary. That is the whole reason the context is a parameter:
 * it costs a clone instead of a process, and it puts the two writers where a
 * test can read them separately, which is the only way to assert the rule that
 * stdout is data and stderr is progress.
 */

const BASE: GlobalOptions = { repo: undefined, json: false, verbose: false, headless: false };

type Recorder = {
  /** Everything that reached stdout, one entry per `reporter.out`. */
  readonly out: string[];
  readonly err: string[];
  readonly reporter: Reporter;
};

/** A reporter whose two destinations are kept apart — which is the rule under test. */
function recorder(): Recorder {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    reporter: createPlainReporter({ out: (text) => out.push(text), err: (text) => err.push(text) }),
  };
}

type RunOptions = {
  readonly global?: Partial<GlobalOptions>;
  /** Where the command is invoked from. Defaults to the repository root. */
  readonly cwd?: string;
};

type Fixture = {
  readonly temp: TempRepo;
  /** The managed repository, at `<work>/app`. */
  readonly root: string;
  /** A directory with no repository above it, below it, or beside it. */
  readonly elsewhere: string;
  readonly run: (command: GroveCommand, options?: RunOptions) => Promise<Recorder>;
  /** The same, keeping what was written when the command throws. */
  readonly attempt: (
    command: GroveCommand,
    options?: RunOptions,
  ) => Promise<{ readonly log: Recorder; readonly error: unknown }>;
};

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    const root = join(temp.work, "app");
    const elsewhere = join(temp.root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });

    const attempt: Fixture["attempt"] = async (command, { global = {}, cwd = root } = {}) => {
      const log = recorder();

      try {
        await runCommand(command, { cwd, global: { ...BASE, ...global }, reporter: log.reporter });
        return { log, error: undefined };
      } catch (error) {
        return { log, error };
      }
    };

    const run: Fixture["run"] = async (command, options) => {
      const { log, error } = await attempt(command, options);
      if (error !== undefined) throw error;

      return log;
    };

    await run({ name: "clone", url: temp.originUrl, dir: "app" }, { cwd: temp.work });

    await body({ temp, root, elsewhere, run, attempt });
  });
}

/** Whatever the command rejected with, or a failure saying it did not reject. */
function rejection(outcome: { readonly error: unknown }): unknown {
  if (outcome.error === undefined) throw new Error("expected the command to fail, and it did not");

  return outcome.error;
}

/** The same, insisting it was a failure this tool meant to produce. */
function groveFailure(outcome: { readonly error: unknown }): GroveError {
  const error = rejection(outcome);
  if (!isGroveError(error)) throw new Error(`expected a GroveError, got ${String(error)}`);

  return error;
}

/** What a command that only reads has to leave exactly as it found it. */
async function snapshot(root: string): Promise<string> {
  const bare = join(root, ".bare");
  const worktrees = await probeGit(bare, ["worktree", "list", "--porcelain"]);
  const refs = await probeGit(bare, ["for-each-ref", "--format=%(refname) %(objectname)"]);

  return `${worktrees.stdout}\n${refs.stdout}`;
}

/** A directory holding git and nothing else, for proving what a command reaches for. */
async function gitOnlyPath(root: string): Promise<string> {
  const git = Bun.which("git");
  if (git === null) throw new Error("these tests need git on PATH");

  const bin = join(root, "git-only-bin");
  await mkdir(bin, { recursive: true });
  await symlink(git, join(bin, "git"));

  return bin;
}

/**
 * Whether a child process would take `HOME` for its home directory.
 *
 * A guard, not an assertion about the product: `homedir()` is read once at
 * startup and ignores a later `process.env.HOME`, so `install` — the one
 * command that writes outside the repository — is only ever run as a child.
 * If that child would not honour `HOME` either, the rc file it appends to is
 * the developer's own, and this has to stop before that happens rather than
 * report it afterwards.
 */
async function homeIsHonoured(home: string): Promise<boolean> {
  const probe = Bun.spawn(["bun", "-e", 'process.stdout.write(require("node:os").homedir())'], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  const [, seen] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);

  return seen === home;
}

/**
 * One probe per subcommand, each asserting an outcome only that command's
 * implementation could produce.
 *
 * Keyed by name and checked against `SUBCOMMANDS` below, so a command added to
 * the table without being wired up here fails rather than being skipped.
 */
const DISPATCH: Readonly<Record<string, (fixture: Fixture) => Promise<void>>> = {
  clone: async ({ temp, run }) => {
    const clone: GroveCommand = { name: "clone", url: temp.originUrl, dir: "second" };
    const log = await run(clone, { cwd: temp.work });

    expect(log.out).toEqual(["second/main\tmain\n"]);
    expect(await pathExists(join(temp.work, "second", ".bare", "HEAD"))).toBe(true);
  },

  add: async ({ root, run }) => {
    const log = await run({
      name: "add",
      branch: "feat/login",
      from: undefined,
      fetch: true,
      push: false,
      setup: false,
      trust: false,
      take: false,
    });

    expect(log.out).toEqual(["feat/login\tfeat/login\n"]);
    // The remote branch was tracked, not invented: only `addWorktree` gets here.
    expect(await Bun.file(join(root, "feat", "login", "login.txt")).text()).toBe("login\n");
  },

  pr: async ({ temp, attempt }) => {
    // `gh` is the one tool only `pr` reaches for, so a PATH holding git and
    // nothing else is proof of where the dispatch went — offline, and whether
    // or not the machine running this has gh installed.
    const bin = await gitOnlyPath(temp.root);
    const path = process.env.PATH;
    process.env.PATH = bin;

    try {
      const error = groveFailure(
        await attempt({ name: "pr", pr: "1", setup: false, trust: false }),
      );

      expect(error.code).toBe("gh");
      expect(error.message).toContain("gh");
    } finally {
      process.env.PATH = path;
    }
  },

  path: async ({ root, run }) => {
    const log = await run({ name: "path", target: undefined });

    expect(log.out).toEqual([`${root}\n`]);
  },

  install: async () => {
    const home = await mkdtemp(join(tmpdir(), "grove-home-"));

    try {
      expect(await homeIsHonoured(home)).toBe(true);

      const result = await runCli(["install", "zsh", "--json"], {
        // Cleared rather than inherited: either would relocate the rc file out
        // of the throwaway home and into the real one.
        env: { HOME: home, ZDOTDIR: undefined, XDG_CONFIG_HOME: undefined },
      });

      expect(result.exitCode).toBe(ExitCode.ok);

      const written = JSON.parse(result.stdout) as { outcome: string; rcFile: string };
      expect(written.rcFile).toBe(join(home, ".zshrc"));
      expect(written.outcome).toBe("installed");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },

  "shell-init": async ({ run }) => {
    const log = await run({ name: "shell-init", shell: "zsh" });

    // The function body, which nothing else prints.
    expect(log.out.join("")).toContain("GROVE_CD_FILE");
    expect(log.err).toEqual([]);
  },

  list: async ({ run }) => {
    const log = await run({ name: "list" }, { global: { json: true } });
    const [first] = JSON.parse(log.out.join("")) as readonly Record<string, unknown>[];

    // The summary shape, which only `listWorktreeSummaries` produces.
    expect(first).toMatchObject({ dir: "main", branch: "main", isDefault: true, dirty: false });
  },

  remove: async ({ root, run }) => {
    await run({
      name: "add",
      branch: "feat/login",
      from: undefined,
      fetch: true,
      push: false,
      setup: false,
      trust: false,
      take: false,
    });

    const log = await run({
      name: "remove",
      target: "feat/login",
      force: false,
      deleteBranch: false,
      teardown: false,
    });

    expect(log.out).toEqual(["feat/login\n"]);
    expect(await pathExists(join(root, "feat", "login"))).toBe(false);
  },

  prune: async ({ root, run }) => {
    const before = await snapshot(root);
    const log = await run({
      name: "prune",
      only: undefined,
      dryRun: true,
      deleteBranch: false,
      fetch: false,
    });

    // `describePrune`'s own sentence, on stderr where the counts belong.
    expect(log.err.join("")).toContain("nothing is finished with");
    expect(await snapshot(root)).toBe(before);
  },

  rename: async ({ root, run }) => {
    const log = await run({
      name: "rename",
      target: "main",
      to: "trunk",
      push: false,
      force: true,
    });

    expect(log.out).toEqual(["trunk\ttrunk\n"]);
    // The directory moves with the branch — the whole point of the command.
    expect(await pathExists(join(root, "trunk"))).toBe(true);
    expect(await pathExists(join(root, "main"))).toBe(false);
  },

  reset: async ({ root, run }) => {
    await Bun.write(join(root, "main", "app.txt"), "dirtied\n");

    const log = await run({ name: "reset", target: "main", to: undefined, clean: false });

    expect(log.out.join("")).toMatch(/^main\t[0-9a-f]{7}\n$/);
    expect(await Bun.file(join(root, "main", "app.txt")).text()).toBe("one\n");
  },

  sync: async ({ root, run }) => {
    const log = await run(
      { name: "sync", target: undefined, all: false, abortOnConflict: true, push: false },
      { cwd: join(root, "main") },
    );

    // `syncWorktrees` reports one row per worktree as `<path>\t<kind>`, and the
    // path is `.` because the sync was asked for from inside it.
    expect(log.out).toEqual([".\tup-to-date\n"]);
  },

  doctor: async ({ run }) => {
    const log = await run({ name: "doctor" });

    expect(log.out.join("")).toContain("checks, all clean");
    expect(log.err).toEqual([]);
  },
};

describe("dispatch", () => {
  test("the probes below cover every subcommand there is", () => {
    // Not a formality: without this a command added to `SUBCOMMANDS` and never
    // wired into `runCommand` would simply have no test, and pass.
    expect(Object.keys(DISPATCH).toSorted()).toEqual(
      SUBCOMMANDS.map((spec) => spec.name).toSorted(),
    );
  });

  for (const spec of SUBCOMMANDS) {
    test(`${spec.name} reaches its own implementation`, async () => {
      const probe = DISPATCH[spec.name];
      if (probe === undefined) throw new Error(`no probe for ${spec.name}`);

      await withFixture(probe);
    }, 60_000);
  }

  test("the commands that only read leave the repository exactly as they found it", async () => {
    await withFixture(async ({ root, run }) => {
      const before = await snapshot(root);

      await run({ name: "list" });
      await run({ name: "path", target: undefined });
      await run({ name: "doctor" });

      // "and nothing else": a dispatch that quietly fetched, added a worktree,
      // or moved a ref would show up here rather than in whichever later
      // command tripped over it.
      expect(await snapshot(root)).toBe(before);
    });
  }, 60_000);
});

describe("global flags", () => {
  test("-C makes the command operate on that repo rather than one found from cwd", async () => {
    await withFixture(async ({ root, elsewhere, run, attempt }) => {
      // Without it, standing outside every repository is the error it should be.
      expect(groveFailure(await attempt({ name: "list" }, { cwd: elsewhere })).code).toBe(
        "not-a-repo",
      );

      const log = await run({ name: "list" }, { cwd: elsewhere, global: { repo: root } });
      expect(log.out.join("")).toContain("main");

      // Not just reading: a worktree asked for from outside lands in the repo
      // `-C` named, not beside the directory the command was run from.
      await run(
        {
          name: "add",
          branch: "feat/login",
          from: undefined,
          fetch: true,
          push: false,
          setup: false,
          trust: false,
          take: false,
        },
        { cwd: elsewhere, global: { repo: root } },
      );

      expect(await pathExists(join(root, "feat", "login"))).toBe(true);
      expect(await pathExists(join(elsewhere, "feat"))).toBe(false);
    });
  }, 60_000);

  test("--json puts one machine-readable document on stdout, and only that", async () => {
    await withFixture(async ({ run }) => {
      const plain = await run({ name: "list" });
      // The table is for people: it is not JSON, and nothing should treat it as such.
      expect(() => JSON.parse(plain.out.join(""))).toThrow();

      const json = await run({ name: "list" }, { global: { json: true } });
      expect(Array.isArray(JSON.parse(json.out.join("")))).toBe(true);

      // Every command that has a result answers `--json` the same way: one
      // document on stdout, parseable on its own.
      const added = await run(
        {
          name: "add",
          branch: "feat/login",
          from: undefined,
          fetch: true,
          push: false,
          setup: false,
          trust: false,
          take: false,
        },
        { global: { json: true } },
      );
      expect(JSON.parse(added.out.join("")) as { branch: string }).toMatchObject({
        branch: "feat/login",
      });
    });
  }, 60_000);

  test("--verbose is the entry point's to install: nothing traces without a sink", async () => {
    await withFixture(async ({ run }) => {
      const log = await run({ name: "list" }, { global: { verbose: true } });

      // `runCommand` never reads `global.verbose` — `cli.tsx` does, and calls
      // `traceGit`. Pinned here so moving the trace into a command would be
      // noticed, and asserted end to end in `cli.test.tsx`.
      expect(log.err).toEqual([]);
    });
  }, 60_000);

  test("the git trace is a line per command, with its exit code and how long it took", async () => {
    await withFixture(async ({ root, run }) => {
      const lines: string[] = [];

      traceGit((line) => lines.push(line));
      try {
        await run({ name: "list" });
      } finally {
        // Module-level state: leaving it installed would trace every later test.
        traceGit(undefined);
      }

      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(line).toMatch(/^git .+ → (?:ok|exit \d+), \d+ms$/);
      // The `-C` form is the line you can paste into a shell to see the same thing.
      expect(lines[0]).toContain(`git -C ${root} rev-parse`);

      const after: string[] = [];
      traceGit((line) => after.push(line));
      traceGit(undefined);
      await run({ name: "list" });

      expect(after).toEqual([]);
    });
  }, 60_000);
});

describe("stdout is data, stderr is progress", () => {
  test("a --json result arrives on stdout unmixed, while the steps go to stderr", async () => {
    await withFixture(async ({ run }) => {
      const log = await run(
        {
          name: "add",
          branch: "feat/login",
          from: undefined,
          fetch: true,
          push: false,
          setup: false,
          trust: false,
          take: false,
        },
        { global: { json: true } },
      );

      // What `grove add --json | jq` reads: the whole of stdout is the document.
      expect(JSON.parse(log.out.join("")) as { branch: string }).toMatchObject({
        branch: "feat/login",
      });
      // And the narration really did happen — it just happened elsewhere.
      expect(log.err.join("")).toContain("adding feat/login");
    });
  }, 60_000);

  test("no command lets a progress marker onto stdout", async () => {
    await withFixture(async ({ root, run }) => {
      const logs = [
        await run({ name: "list" }),
        await run({ name: "path", target: undefined }),
        await run({ name: "doctor" }),
        await run({
          name: "add",
          branch: "feat/login",
          from: undefined,
          fetch: true,
          push: false,
          setup: false,
          trust: false,
          take: false,
        }),
        await run(
          { name: "sync", target: undefined, all: false, abortOnConflict: true, push: false },
          { cwd: join(root, "main") },
        ),
        await run({
          name: "remove",
          target: "feat/login",
          force: false,
          deleteBranch: false,
          teardown: false,
        }),
      ];

      // The plain reporter prefixes every line it narrates; a result never
      // carries one, because a result never goes through `info`/`warn`/`step`.
      for (const log of logs) {
        for (const line of log.out) expect(line).not.toMatch(/^[·✓✗!] /);
      }
    });
  }, 60_000);
});

describe("what a failure costs", () => {
  test("a GroveError carries the code the shell will see, and stdout stays empty", async () => {
    await withFixture(async ({ temp, elsewhere, attempt }) => {
      const outside = await attempt({ name: "list" }, { cwd: elsewhere });
      const missing = groveFailure(outside);

      expect(missing.code).toBe("not-a-repo");
      expect(errorToExitCode(missing.code)).toBe(ExitCode.notARepo);
      expect(missing.message).toContain("no worktree repository found");
      // Readable, and it says what to do next rather than only what went wrong.
      expect(missing.hint).toContain("grove clone");
      expect(outside.log.out).toEqual([]);

      // A second code, so this is a mapping and not one constant: cloning over
      // something that is already there is a conflict, not a missing repo.
      const clash = groveFailure(
        await attempt({ name: "clone", url: temp.originUrl, dir: "app" }, { cwd: temp.work }),
      );
      expect(clash.code).toBe("state-conflict");
      expect(errorToExitCode(clash.code)).toBe(ExitCode.stateConflict);
    });
  }, 60_000);

  test("doctor prints its findings first and fails afterwards", async () => {
    await withFixture(async ({ root, attempt }) => {
      // The refspec `git clone --bare` will not write, removed again: the one
      // problem that makes `origin/*` never appear.
      await probeGit(join(root, ".bare"), ["config", "--unset", "remote.origin.fetch"]);

      const outcome = await attempt({ name: "doctor" }, { global: { json: true } });
      const error = groveFailure(outcome);

      expect(error.code).toBe("state-conflict");
      // The findings are what was asked for; the exit code is for whatever is
      // reading them, and one must not cost the other.
      expect(JSON.parse(outcome.log.out.join("")) as { findings: unknown[] }).toHaveProperty(
        "findings",
      );
    });
  }, 60_000);

  test("anything that is not a GroveError comes out untouched, for the entry point to call a bug", async () => {
    await withFixture(async ({ temp, attempt }) => {
      // git missing is the honest way to produce one: `runGit` does not catch
      // what `Bun.spawn` throws, and nothing below `cli.tsx` should dress it up.
      const bin = join(temp.root, "empty-bin");
      await mkdir(bin, { recursive: true });

      const path = process.env.PATH;
      process.env.PATH = bin;

      let error: unknown;
      try {
        error = rejection(await attempt({ name: "list" }));
      } finally {
        process.env.PATH = path;
      }

      expect(isGroveError(error)).toBe(false);
      expect(error).toBeInstanceOf(Error);
      // Not a bare stack: the sentence names the thing that is missing.
      expect((error as Error).message).toContain("git");
    });
  }, 60_000);
});

describe("the context a command is handed", () => {
  test("cwd is what paths are reported against", async () => {
    await withFixture(async ({ root, run }) => {
      const fromRoot = await run({
        name: "add",
        branch: "feat/login",
        from: undefined,
        fetch: true,
        push: false,
        setup: false,
        trust: false,
        take: false,
      });
      expect(fromRoot.out).toEqual(["feat/login\tfeat/login\n"]);

      // The same worktree, named from somewhere else: relative when that is
      // shorter, which is the row a person scans for.
      const fromInside = await run(
        {
          name: "add",
          branch: "feat/signup",
          from: undefined,
          fetch: false,
          push: false,
          setup: false,
          trust: false,
          take: false,
        },
        { cwd: join(root, "main") },
      );
      expect(fromInside.out).toEqual(["../feat/signup\tfeat/signup\n"]);

      // And "." for the directory you are standing in, which an absolute path
      // would bury.
      const sync = await run(
        { name: "sync", target: undefined, all: false, abortOnConflict: true, push: false },
        { cwd: join(root, "main") },
      );
      expect(sync.out).toEqual([".\tup-to-date\n"]);
    });
  }, 60_000);

  test("path answers absolutely wherever it is asked from, because `cd` needs that", async () => {
    await withFixture(async ({ root, run }) => {
      for (const cwd of [root, join(root, "main")]) {
        const log = await run({ name: "path", target: "main" }, { cwd });

        expect(log.out).toEqual([`${join(root, "main")}\n`]);
      }
    });
  }, 60_000);

  test("the repository is resolved once, from cwd, and handed to the command", async () => {
    await withFixture(async ({ root, run }) => {
      // Standing deep inside a worktree still finds the repository above it, and
      // the command acts on that repository rather than on the directory.
      const nested = join(root, "main");
      const log = await run({ name: "path", target: undefined }, { cwd: nested });

      expect(log.out).toEqual([`${root}\n`]);
    });
  }, 60_000);

  test("the reporter's out is the only route to stdout", async () => {
    await withFixture(async ({ run }) => {
      const log = await run({ name: "shell-init", shell: "zsh" });

      // A command that has nothing to narrate narrates nothing — the writers
      // are two destinations, not one stream split by convention.
      expect(log.err).toEqual([]);
      expect(log.out).toHaveLength(1);
    });
  }, 60_000);
});
