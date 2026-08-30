import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { ExitCode, type ExitCodeValue } from "./cli/exit-codes.ts";
import { runCli } from "./cli/test-cli.ts";
import { seedGit, withTempRepo } from "./core/test-utils.ts";
import { startUi } from "./ui/e2e-utils.ts";

/**
 * The entry point, run as the binary.
 *
 * `run.test.ts` covers what happens once a command is chosen; everything here
 * is what only a real process can answer — which of the three things a parsed
 * argv turns into, whether the screen is drawn or the usage printed, and the
 * number the shell is left holding.
 *
 * `.e2e.` in the name because none of it can move in-process, and the name is
 * what `scripts/test.sh` sorts the tiers by. Every test here spawns `cli.tsx`,
 * two of them over a real PTY or a signal: a decision made *from* `isTTY` and
 * `process.exitCode` cannot be observed by the process making it, and there is
 * no argument to pass that would let it be.
 *
 * Every repository-dependent case is given a `cwd`, deliberately: this checkout
 * is itself a grove-managed repository, so a run without one would discover the
 * developer's own worktrees and pass for the wrong reason.
 */

/** git's own environment, pinned so a laptop's global config cannot join in. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const EXIT_CODES: readonly ExitCodeValue[] = Object.values(ExitCode);

/** POSIX only — `startUi` needs a PTY, and there is none to give it on Windows. */
const describeUi = process.platform === "win32" ? describe.skip : describe;

/** An empty directory with no repository above it, below it, or beside it. */
async function withNowhere(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "grove-nowhere-"));

  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("--version and --help answer without needing anything else", () => {
  test("--version and -v print the version the package declares, and exit 0", async () => {
    for (const argv of [["--version"], ["-v"]]) {
      const result = await runCli(argv);

      expect([argv, result.exitCode]).toEqual([argv, ExitCode.ok]);
      expect(result.stdout).toBe(`${version}\n`);
      // A version is a result, so nothing else may share the run with it —
      // `grove --version | cut -d. -f1` has to read a number and not a warning.
      expect(result.stderr).toBe("");
    }
  }, 30_000);

  test("--help, -h and `help` all print the global usage and exit 0", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const result = await runCli(argv);

      expect([argv, result.exitCode]).toEqual([argv, ExitCode.ok]);
      expect(result.stdout).toContain("Usage: grove <command> [options]");
      expect(result.stderr).toBe("");
    }
  }, 30_000);

  test("a subcommand's --help wins over the arguments it is missing", async () => {
    const result = await runCli(["add", "--help"]);

    expect(result.exitCode).toBe(ExitCode.ok);
    expect(result.stdout).toContain("Usage: grove add <branch>");
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("a bare `grove` chooses between the screen and the usage", () => {
  test("piped, it prints the usage and exits rather than waiting for a keyboard", async () => {
    // The screen needs a terminal to draw on and a keyboard to read from, and a
    // pipe is neither. This is what keeps `grove | head` and `grove > usage.txt`
    // working — and, more importantly, what stops a scripted run from hanging.
    const result = await runCli([]);

    expect(result.exitCode).toBe(ExitCode.ok);
    expect(result.stdout).toContain("Usage: grove <command> [options]");
    expect(result.stderr).toBe("");
  }, 30_000);

  test("piped, it is the usage even from inside a repository it could have drawn", async () => {
    await withTempRepo(async (repo) => {
      expect((await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work })).exitCode).toBe(
        ExitCode.ok,
      );

      const result = await runCli([], { cwd: join(repo.work, "app") });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toContain("Usage: grove <command> [options]");
    });
  }, 60_000);
});

describeUi("a bare `grove` on a real terminal", () => {
  test("--headless declines the screen even with a terminal on both ends", async () => {
    // The other half of the same decision: a TTY is not enough on its own, so
    // anyone who wants plain output has one switch that works everywhere.
    const session = startUi({ args: ["--headless"] });

    try {
      expect(await session.exited).toBe(ExitCode.ok);
      expect(session.frame()).toContain("Usage: grove <command> [options]");
    } finally {
      session.kill();
    }
  }, 60_000);
});

describe("a mistake exits 2 with the usage on stderr", () => {
  test("an unknown subcommand names the ones that exist", async () => {
    const result = await runCli(["nope"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    // A mistyped `grove lst --json | jq` must not feed jq a usage message.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unknown command "nope"');
    expect(result.stderr).toContain("Usage: grove <command>");
  }, 30_000);

  test("an unknown global flag says which one", async () => {
    const result = await runCli(["--nope"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option '--nope'");
  }, 30_000);

  test("an unknown flag on a subcommand shows that subcommand's usage", async () => {
    const result = await runCli(["add", "--brnach", "x"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option '--brnach'");
    expect(result.stderr).toContain("Usage: grove add");
  }, 30_000);
});

describe("what the shell is left holding", () => {
  test("running outside any repository exits 3, with nothing on stdout", async () => {
    await withNowhere(async (dir) => {
      // `--json` too: a script reading stdout gets an empty stream and a code,
      // never half a document.
      for (const argv of [["list"], ["list", "--json"], ["path"]]) {
        const result = await runCli(argv, { cwd: dir, env: GIT_ENV });

        expect([argv, result.exitCode]).toEqual([argv, ExitCode.notARepo]);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("no worktree repository found");
      }
    });
  }, 60_000);

  test("a bug in this tool exits 1 and says what actually broke", async () => {
    await withTempRepo(async (repo) => {
      expect((await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work })).exitCode).toBe(
        ExitCode.ok,
      );

      // git missing is a real way to reach the top-level catch with something
      // that is not a `GroveError`: `runGit` does not catch what `Bun.spawn`
      // throws. The PATH keeps `bun` so the binary still starts.
      const bin = join(repo.root, "bun-only-bin");
      await mkdir(bin, { recursive: true });
      await symlink(process.execPath, join(bin, "bun"));

      const result = await runCli(["list"], { cwd: join(repo.work, "app"), env: { PATH: bin } });

      expect(result.exitCode).toBe(ExitCode.internal);
      expect(result.stdout).toBe("");
      // A stack, on purpose — but one whose first line names the missing thing,
      // rather than an empty failure the reporter would have to be guessed at.
      expect(result.stderr).toContain("git");
      expect(result.stderr).toContain("Executable not found");
    });
  }, 60_000);

  test("nothing escapes as an unhandled rejection, and every exit is a number ExitCode names", async () => {
    await withTempRepo(async (repo) => {
      const work = repo.work;
      const root = join(work, "app");

      const runs = [
        await runCli(["--version"]),
        await runCli([]),
        await runCli(["nope"]),
        await runCli(["add"], { cwd: work }),
        await runCli(["clone", "not a url"], { cwd: work }),
        await runCli(["clone", repo.originUrl, "app"], { cwd: work }),
        await runCli(["list"], { cwd: root }),
        await runCli(["remove", "main"], { cwd: root }),
        await runCli(["clone", repo.originUrl, "app"], { cwd: work }),
        await runCli(["path", "nothing-like-it"], { cwd: root }),
      ];

      for (const result of runs) {
        expect(EXIT_CODES).toContain(result.exitCode as ExitCodeValue);
        // Bun prints this itself when a promise rejects with nobody watching;
        // the entry point's `try`/`catch` is what has to make it impossible.
        expect(result.stderr.toLowerCase()).not.toContain("unhandled");
      }

      // And the batch really did exercise more than success, or the loop above
      // would be asserting that 0 is a number.
      expect(runs.some((result) => result.exitCode !== ExitCode.ok)).toBe(true);
    });
  }, 120_000);
});

describe("Ctrl-C", () => {
  test("interrupting a running command exits 130", async () => {
    await withTempRepo(async (repo) => {
      expect((await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work })).exitCode).toBe(
        ExitCode.ok,
      );

      const root = join(repo.work, "app");
      const trunk = join(root, "main");

      // Something slow enough to interrupt, and committed so `add` reads it out
      // of the trunk the way a real project's `.grove.toml` arrives.
      await Bun.write(join(trunk, ".grove.toml"), '[setup]\nrun = ["sleep 10"]\n');
      await seedGit(trunk, ["add", "-A"]);
      await seedGit(trunk, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);

      // Spawned here rather than through `runCli` for the one thing `runCli`
      // cannot do: hold the child long enough to signal it.
      const child = Bun.spawn(
        ["bun", `${import.meta.dir}/cli.tsx`, "add", "feat/slow", "--trust", "--headless"],
        { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );

      let stderr = "";
      const reading = (async () => {
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
          stderr += new TextDecoder().decode(chunk);
        }
      })();

      // Signalled on a marker rather than on a clock: the interrupt has to land
      // while the command is working, and "after 500ms" is a guess that fails
      // on a busy machine.
      const deadline = Date.now() + 30_000;
      while (!stderr.includes("running sleep 10") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stderr).toContain("running sleep 10");

      child.kill("SIGINT");
      const exitCode = await child.exited;
      await reading;

      // 128 + SIGINT, the number a shell reports for Ctrl-C.
      expect(exitCode).toBe(ExitCode.interrupted);
      expect(await new Response(child.stdout).text()).toBe("");
    });
  }, 90_000);
});
