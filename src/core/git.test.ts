import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isGroveError } from "./errors.ts";
import {
  gitOutput,
  gitSucceeds,
  killRunningGit,
  parseGitProgress,
  runGit,
  runGitOrThrow,
  runShell,
  runTool,
  traceGit,
} from "./git.ts";
import { seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * The one module that spawns processes, so almost everything here runs real
 * ones. A fake spawner would only prove that the fake agrees with itself, and
 * the things worth asserting — a pinned environment reaching the child, stderr
 * arriving line by line while a clone is still running, a signal landing on
 * something that is genuinely asleep — exist nowhere else.
 *
 * `sh` stands in for the tools `runTool` and `runShell` actually run (`gh`, a
 * `grove.setup` line): it is the one executable a POSIX box is guaranteed to
 * have, and it can be asked to fail on demand.
 */

/** A working clone of the fixture, which is what every git call below needs. */
async function clone(repo: TempRepo, name = "app"): Promise<string> {
  const path = join(repo.work, name);

  await seedGit(repo.work, ["clone", repo.originUrl, path]);

  return path;
}

/**
 * Runs `body` with a trace sink installed and hands back what it recorded.
 *
 * The sink is module-level state: leaving one behind would follow this process
 * into every later test in the file, so removal happens in a `finally` even
 * when the body throws.
 */
async function withTrace(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];

  traceGit((line) => lines.push(line));
  try {
    await body();
  } finally {
    traceGit(undefined);
  }

  return lines;
}

/**
 * A trace line as [command, outcome], with the timing asserted separately.
 *
 * The milliseconds are real and therefore unpredictable; a test that pinned
 * them would fail on a slow machine, and one that ignored the line's shape
 * would not notice the timing disappearing.
 */
function split(line: string | undefined): readonly [string, string] {
  const [command = "", tail = ""] = (line ?? "").split(" → ");
  const [outcome = "", timing = ""] = tail.split(", ");

  expect(timing).toMatch(/^\d+ms$/);

  return [command, outcome];
}

describe("runGit", () => {
  test("a success is a code, a stdout and an empty stderr", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: app });

      expect(result).toEqual({ code: 0, stdout: "main\n", stderr: "" });
    });
  });

  test("a failure is a result, not a throw, and its stderr is captured", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runGit(["rev-parse", "--verify", "refs/heads/nope"], { cwd: app });

      expect(result.code).not.toBe(0);
      // Captured rather than leaked: nothing reached this process's own stderr,
      // which is why callers get to decide whether a failure is worth printing.
      expect(result.stderr).toContain("fatal:");
      expect(result.stdout).toBe("");
    });
  });

  test("a subcommand git does not have is an ordinary non-zero result", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runGit(["definitely-not-a-subcommand"], { cwd: app });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("is not a git command");
    });
  });

  test("a directory that is not a repository fails the way callers classify", async () => {
    await withTempRepo(async ({ root }) => {
      const plain = join(root, "plain");
      await mkdir(plain, { recursive: true });

      const result = await runGit(["status", "--porcelain"], { cwd: plain });

      expect(result.code).toBe(128);
      expect(result.stderr).toContain("not a git repository");
    });
  });

  test("cwd decides which repository answers", async () => {
    await withTempRepo(async (repo) => {
      const one = await clone(repo, "one");
      const two = await clone(repo, "two");

      await seedGit(two, ["checkout", "feat/login"]);

      expect((await runGit(["rev-parse", "--show-toplevel"], { cwd: one })).stdout.trim()).toBe(
        one,
      );
      expect(
        (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: two })).stdout.trim(),
      ).toBe("feat/login");
    });
  });

  test("env is merged over the caller's environment, not a replacement for it", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runGit(["var", "GIT_AUTHOR_IDENT"], {
        cwd: app,
        env: { GIT_AUTHOR_NAME: "Env Override" },
      });

      expect(result.stdout).toStartWith("Env Override <tests@example.invalid>");

      // The committer identity came from `process.env` alone, so the override
      // above added to the environment rather than replacing it — a replacement
      // would have left git with no identity and no PATH at all.
      const committer = await runGit(["var", "GIT_COMMITTER_IDENT"], { cwd: app });

      expect(committer.stdout).toStartWith("grove tests <tests@example.invalid>");
    });
  });

  test("the pinned environment reaches the child whatever the shell looks like", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      // A `!` alias is the only way to ask git what environment it handed its
      // children — which is the environment `classifyGitError` (LC_ALL) and the
      // no-hang guarantee (GIT_TERMINAL_PROMPT) both depend on.
      const result = await runGit(
        [
          "-c",
          "alias.envcheck=!sh -c 'echo $LC_ALL,$GIT_TERMINAL_PROMPT,$GIT_OPTIONAL_LOCKS'",
          "envcheck",
        ],
        { cwd: app },
      );

      expect(result.stdout.trim()).toBe("C,0,0");
    });
  });

  test("onStderrLine sees progress as it arrives, split on git's lone carriage returns", async () => {
    await withTempRepo(async (repo) => {
      const lines: string[] = [];

      await runGit(["clone", "--progress", repo.originUrl, join(repo.work, "app")], {
        cwd: repo.work,
        onStderrLine: (line) => lines.push(line),
      });

      // git rewrites one line with `\r` rather than emitting many, so without the
      // `\r` split the whole clone would arrive as a single unterminated line.
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.some((line) => line.includes("\r"))).toBe(false);
      expect(lines.some((line) => line.startsWith("Receiving objects:"))).toBe(true);
      expect(lines.at(-1)).not.toBe("");
    });
  });

  test("stdout survives multi-byte characters, whatever the chunk boundaries", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const subject = "커밋 메시지 ✅";

      await writeFile(join(app, "unicode.txt"), "x\n");
      await seedGit(app, ["add", "-A"]);
      await seedGit(app, ["-c", "commit.gpgsign=false", "commit", "-m", subject]);

      const result = await runGit(["log", "-1", "--format=%s"], { cwd: app });

      expect(result.stdout).toBe(`${subject}\n`);
    });
  });
});

describe("runGitOrThrow", () => {
  test("returns stdout untouched, trailing newline and all", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      expect(await runGitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: app })).toBe(
        "main\n",
      );
    });
  });

  test("a failure becomes a GroveError carrying the code its stderr implies", async () => {
    await withTempRepo(async ({ root }) => {
      const plain = join(root, "plain");
      await mkdir(plain, { recursive: true });

      try {
        await runGitOrThrow(["status"], { cwd: plain });
        throw new Error("expected runGitOrThrow to throw");
      } catch (error) {
        if (!isGroveError(error)) throw error;

        expect(error.code).toBe("not-a-repo");
        expect(error.message).toBe("git status failed (exit 128)");
      }
    });
  });

  test("git's own words are handed on as details rather than swallowed", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      try {
        await runGitOrThrow(["checkout", "-b", "main"], { cwd: app });
        throw new Error("expected runGitOrThrow to throw");
      } catch (error) {
        if (!isGroveError(error)) throw error;

        expect(error.code).toBe("state-conflict");
        // The message names the command; only the details say what git said, so
        // losing them would leave the user with "checkout failed" and nothing else.
        expect(error.message).toBe("git checkout -b main failed (exit 128)");
        expect(error.details.join("\n")).toContain("a branch named 'main' already exists");
      }
    });
  });

  test("an unclassifiable failure still throws, as the generic code", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      try {
        await runGitOrThrow(["log", "--not-an-option"], { cwd: app });
        throw new Error("expected runGitOrThrow to throw");
      } catch (error) {
        if (!isGroveError(error)) throw error;

        expect(error.code).toBe("git-failed");
        expect(error.details.join("\n")).toContain("--not-an-option");
      }
    });
  });
});

describe("gitSucceeds", () => {
  test("true and false for a ref that does and does not exist", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      expect(await gitSucceeds(["rev-parse", "--verify", "refs/heads/main"], { cwd: app })).toBe(
        true,
      );
      expect(await gitSucceeds(["rev-parse", "--verify", "refs/heads/nope"], { cwd: app })).toBe(
        false,
      );
    });
  });

  test("never throws, however wrong the question is", async () => {
    await withTempRepo(async ({ root }) => {
      const plain = join(root, "plain");
      await mkdir(plain, { recursive: true });

      // Both of these would be a `GroveError` through `runGitOrThrow`; the point
      // of this one is that "does it exist?" is answerable with a plain false.
      expect(await gitSucceeds(["status"], { cwd: plain })).toBe(false);
      expect(await gitSucceeds(["definitely-not-a-subcommand"], { cwd: plain })).toBe(false);
    });
  });
});

describe("gitOutput", () => {
  test("trims what git appends, keeps what git meant", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const subjects = await gitOutput(["log", "--format=%s"], { cwd: app });

      expect(subjects).toBe("Add app.txt\nAdd a readme");
      expect(await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: app })).toBe("main");
    });
  });

  test("no output at all is the empty string, not whitespace", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      // The fixture has no tags, so git exits 0 having printed nothing — the
      // "nothing found" answer callers branch on.
      expect(await gitOutput(["tag", "--list"], { cwd: app })).toBe("");
    });
  });

  test("multi-byte output is decoded before it is trimmed", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      await seedGit(app, ["checkout", "-b", "feat/한글"]);

      expect(await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: app })).toBe(
        "feat/한글",
      );
    });
  });

  test("a failure throws, exactly as runGitOrThrow does", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      await expect(
        gitOutput(["rev-parse", "--verify", "refs/heads/nope"], { cwd: app }),
      ).rejects.toThrow("git rev-parse --verify refs/heads/nope failed (exit 128)");
    });
  });
});

describe("runTool", () => {
  test("a tool that is not installed is null rather than a throw", async () => {
    // The `gh`-is-missing path: an answer the PR commands turn into "install
    // gh", not a failure that has to be caught somewhere generic.
    expect(await runTool(["grove-definitely-not-installed", "--version"])).toBeNull();
  });

  test("both streams are kept apart, and a non-zero exit is reported not thrown", async () => {
    const result = await runTool(["sh", "-c", "echo to-out; echo to-err >&2; exit 3"]);

    expect(result).toEqual({ code: 3, stdout: "to-out\n", stderr: "to-err\n" });
  });

  test("runs where it is told to", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runTool(["sh", "-c", "pwd"], { cwd: app });

      expect(result?.stdout.trim()).toBe(app);
    });
  });

  test("injected env reaches the tool, on top of a prompt-free environment", async () => {
    const result = await runTool(["sh", "-c", 'echo "$GROVE_TEST_TOKEN,$GIT_TERMINAL_PROMPT"'], {
      env: { GROVE_TEST_TOKEN: "injected" },
    });

    // `gh` shells out to git and reads the same prompt switch, so a tool that
    // needs credentials has to fail rather than block on a question.
    expect(result?.stdout.trim()).toBe("injected,0");
  });
});

describe("runShell", () => {
  test("goes through a shell, which is the whole difference from runTool", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      // `&&` and `>` are only meaningful to a shell; as argv they would be words.
      const result = await runShell("echo first && echo second > written.txt", { cwd: app });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("first\n");
      expect(await Bun.file(join(app, "written.txt")).text()).toBe("second\n");
    });
  });

  test("a failing command reports its exit code and its stderr", async () => {
    const result = await runShell("echo out; echo err >&2; exit 7");

    expect(result).toEqual({ code: 7, stdout: "out\n", stderr: "err\n" });
  });

  test("&& stops at the first failure, as a setup line expects", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const result = await runShell("false && echo unreachable > written.txt", { cwd: app });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(await Bun.file(join(app, "written.txt")).exists()).toBe(false);
    });
  });

  test("env is merged in and the prompt switch is pinned, but the locale is not", async () => {
    const result = await runShell('echo "$GROVE_TEST_TOKEN,$GIT_TERMINAL_PROMPT,$LC_ALL"', {
      env: { GROVE_TEST_TOKEN: "injected" },
    });

    // Deliberately unlike `runGit`: forcing LC_ALL=C exists so this tool can read
    // git's English stderr, and imposing it on somebody's own build command would
    // change the language their tooling speaks for no benefit to anyone.
    expect(result.stdout.trim()).toBe(`injected,0,${process.env.LC_ALL ?? ""}`);
  });

  test("stderr arrives line by line for a caller reporting progress", async () => {
    const lines: string[] = [];
    const result = await runShell("echo one >&2; echo two >&2", {
      onStderrLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["one", "two"]);
    expect(result.stderr).toBe("one\ntwo\n");
  });
});

describe("traceGit", () => {
  test("one line per invocation, carrying the command, the outcome and a timing", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const lines = await withTrace(async () => {
        await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: app });
        await runGit(["rev-parse", "--verify", "refs/heads/nope"], { cwd: app });
      });

      expect(lines).toHaveLength(2);
      // The `-C` form is the point: this is a command you can paste into a shell.
      expect(split(lines[0])).toEqual([`git -C ${app} rev-parse --abbrev-ref HEAD`, "ok"]);
      expect(split(lines[1])).toEqual([
        `git -C ${app} rev-parse --verify refs/heads/nope`,
        "exit 128",
      ]);
    });
  });

  test("a cwd-less call has no -C, and an argument needing quoting gets it", async () => {
    const lines = await withTrace(async () => {
      await runGit(["--version"]);
      await runGit(["log", "--format=a b"], { cwd: undefined });
    });

    expect(split(lines[0])).toEqual(["git --version", "ok"]);
    // A word that would not survive being pasted back into a shell is quoted.
    expect(split(lines[1])[0]).toBe('git log "--format=a b"');
  });

  test("the other two spawners are traced too, including a missing tool", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const lines = await withTrace(async () => {
        await runShell("exit 2", { cwd: app });
        await runTool(["sh", "-c", "true"]);
        await runTool(["grove-definitely-not-installed"]);
      });

      expect(split(lines[0])).toEqual([`sh -c "exit 2" in ${app}`, "exit 2"]);
      expect(split(lines[1])).toEqual(["sh -c true", "ok"]);
      // Not installed is neither ok nor an exit code, and saying so is the point
      // of tracing a tool that never ran.
      expect(lines[2]).toBe("grove-definitely-not-installed → not installed");
    });
  });

  test("passing undefined removes the sink for good", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const lines = await withTrace(async () => {
        await runGit(["rev-parse", "HEAD"], { cwd: app });
      });

      // `withTrace` has already removed it; anything recorded after this point
      // would be a sink leaking into the rest of the suite.
      await runGit(["rev-parse", "HEAD"], { cwd: app });
      await runShell("true", { cwd: app });
      await runTool(["sh", "-c", "true"], { cwd: app });

      expect(lines).toHaveLength(1);
    });
  });
});

describe("parseGitProgress", () => {
  test("reads the percentage out of each phase git narrates", () => {
    expect(parseGitProgress("remote: Counting objects:   8% (1/12)        ")).toBe(8);
    expect(parseGitProgress("remote: Compressing objects:  42% (3/7)        ")).toBe(42);
    expect(parseGitProgress("Receiving objects:  42% (5/12)")).toBe(42);
    expect(parseGitProgress("Receiving objects:   0% (0/12)")).toBe(0);
  });

  // git's fourth phase narrates "Resolving deltas:", not objects — and on a
  // large clone it is the part the user waits through, so a bar that stopped
  // reading at the end of "Receiving" would stall exactly where it matters.
  test("the deltas phase counts as progress as well", () => {
    expect(parseGitProgress("Resolving deltas:   0% (0/3)")).toBe(0);
    expect(parseGitProgress("Resolving deltas: 100% (3/3), done.")).toBe(100);
  });

  test("a finished phase reads as 100, twice, which is why a bar can restart", () => {
    expect(parseGitProgress("Receiving objects: 100% (12/12)")).toBe(100);
    expect(parseGitProgress("Receiving objects: 100% (12/12), done.")).toBe(100);
  });

  test("a line with no percentage is not progress", () => {
    expect(parseGitProgress("Cloning into '/repos/app'...")).toBeUndefined();
    expect(parseGitProgress("remote: Enumerating objects: 12, done.")).toBeUndefined();
    expect(
      parseGitProgress("remote: Total 12 (delta 3), reused 0 (delta 0), pack-reused 0"),
    ).toBeUndefined();
  });

  test("a percentage from some other phase is not one of the four counted", () => {
    // `git checkout` narrates too, and feeding its numbers to a clone's bar
    // would make the bar jump backwards for a reason nobody could see.
    expect(parseGitProgress("Updating files:  50% (1/2)")).toBeUndefined();
    expect(parseGitProgress("Checking out files:  50% (1/2)")).toBeUndefined();
  });

  test("junk, emptiness and a near miss are all undefined", () => {
    expect(parseGitProgress("")).toBeUndefined();
    expect(parseGitProgress("fatal: the remote end hung up unexpectedly")).toBeUndefined();
    expect(parseGitProgress("Receiving objects: 42% (5/12)")).toBe(42);
    // The phase word has to be followed by ` objects:`, not anything else.
    expect(parseGitProgress("Receiving files:  42% (5/12)")).toBeUndefined();
  });

  test("every line of a real clone parses to a percentage or to nothing", async () => {
    await withTempRepo(async (repo) => {
      const percentages: number[] = [];
      const phases = new Set<string>();

      await runGit(["clone", "--progress", repo.originUrl, join(repo.work, "app")], {
        cwd: repo.work,
        onStderrLine: (line) => {
          const percent = parseGitProgress(line);
          if (percent === undefined) return;

          percentages.push(percent);
          phases.add(line.replace(/^remote: /, "").split(" objects:")[0] ?? "");
        },
      });

      expect(percentages.length).toBeGreaterThan(0);
      expect(percentages.every((percent) => percent >= 0 && percent <= 100)).toBe(true);
      // Several phases, each running to 100 — the honest reason a bar restarts.
      expect(phases.size).toBeGreaterThan(1);
      expect(percentages.at(-1)).toBe(100);
    });
  });
});

describe("killRunningGit", () => {
  test("with nothing running it is a no-op, not a crash", () => {
    expect(() => killRunningGit()).not.toThrow();
    expect(() => killRunningGit("SIGKILL")).not.toThrow();
  });

  test("a child that is still running is stopped", async () => {
    // `sleep` rather than a git command because a signal has to land on
    // something that is reliably still alive: a real clone of the fixture
    // finishes in milliseconds and the test would race it. This is the same
    // `running` set either way — `runShell` registers its child exactly as
    // `runGit` does, which is why Ctrl-C can reach a `grove.setup` line.
    const child = runShell("sleep 30");
    let settled = false;
    const finished = child.then((result) => {
      settled = true;

      return result;
    });

    const deadline = Date.now() + 2000;
    while (!settled && Date.now() < deadline) {
      killRunningGit();
      await Bun.sleep(20);
    }
    // Belt and braces: whatever happened above, nothing survives this test.
    killRunningGit("SIGKILL");

    expect((await finished).code).not.toBe(0);
  });

  test("a grandchild of a multi-command line is stopped too", async () => {
    // `sh -c` only `exec`s when the line is a single command, so `sleep 37` on
    // its own is the easy case the test above already covers. Add a second
    // command and `sh` stays alive as a parent — which is the shape a
    // `grove.setup` line almost always has (`bun install && bun run build`), and
    // the shape where a signal aimed at `sh` alone leaves the real work running.
    //
    // `pgrep` rather than the returned exit code, because the code cannot tell
    // the two apart: `sh` reports the same failure whether or not it took its
    // child down with it.
    const alive = (): string[] =>
      Bun.spawnSync(["pgrep", "-f", "sleep 37"]).stdout.toString().split("\n").filter(Boolean);

    const finished = runShell("sleep 37 && true");
    try {
      // Both processes have to be up before the signal, or this would pass by
      // having killed nothing.
      const startedBy = Date.now() + 2000;
      while (alive().length < 2 && Date.now() < startedBy) await Bun.sleep(20);
      expect(alive().length).toBe(2);

      killRunningGit();

      // Polled rather than awaited: an orphan inherits the pipes it was spawned
      // with, so `finished` would not settle until the `sleep` did — 37 seconds
      // of exactly the failure being tested.
      const deadline = Date.now() + 1500;
      while (alive().length > 0 && Date.now() < deadline) await Bun.sleep(20);

      expect(alive()).toEqual([]);
    } finally {
      // Whichever assertion above gave way, nothing outlives this test — and
      // once the last holder of those pipes is gone, `finished` can settle.
      Bun.spawnSync(["pkill", "-f", "sleep 37"]);
      await finished;
    }
  });

  test("killing does not disturb children that start afterwards", async () => {
    killRunningGit();

    expect((await runShell("echo alive")).stdout).toBe("alive\n");
  });
});
