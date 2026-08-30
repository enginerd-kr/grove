import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "./exit-codes.ts";
import { runCli } from "./test-cli.ts";

/**
 * `grove install`, through the binary.
 *
 * What the command *does* to an rc file is `installShellInit`, and it takes the
 * environment and the home directory as parameters — so all of that is asserted
 * by calling it, in `install.test.ts`. Three things are left that a call cannot
 * reach:
 *
 * - The two writers. The rc file's path is the *result*, so it goes to stdout
 *   and `cd "$(grove install)"` works; the news that it was added is progress,
 *   so it goes to stderr. In-process those are one return value.
 * - The `--json` document, which is what a script reads instead of the sentence.
 * - `grove install tcsh`. A shell this does not know is rejected in argument
 *   parsing, before `installShellInit` is reached at all — the function's
 *   `shell` parameter is typed, so there is no way to hand it "tcsh" from here.
 *
 * Every run still gets a throwaway home, and the variables that relocate an rc
 * file are unset rather than inherited: getting the environment to the child
 * wrong would append to whoever is running the tests' own rc file, which is why
 * `install` below insists the path it was given is inside the temporary home.
 */

/** A home nothing else can see, deleted afterwards. */
async function withTempHome(
  body: (home: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "grove-home-"));

  try {
    await body(home, {
      HOME: home,
      ZDOTDIR: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_CACHE_HOME: join(home, ".cache"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** What the install writes, as the block it appends. */
function block(line: string): string {
  return `\n# grove: the shell function behind 'grove cd'\n${line}\n`;
}

/** The `--json` document, as a script would read it. */
type Installed = {
  readonly outcome: string;
  readonly shell: string;
  readonly rcFile: string;
  readonly line?: string;
};

describe("grove install", () => {
  test("the rc file's path is the result on stdout, and the news is on stderr", async () => {
    await withTempHome(async (home, env) => {
      const result = await runCli(["install"], { env: { ...env, SHELL: "/bin/zsh" } });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toBe(`${join(home, ".zshrc")}\n`);
      expect(result.stderr).toContain("added to");
    });
  });

  test("--json answers with the whole install result, and stdout carries only that", async () => {
    await withTempHome(async (home, env) => {
      const run = await runCli(["install", "--json"], { env: { ...env, SHELL: "/bin/zsh" } });

      expect(run.exitCode).toBe(ExitCode.ok);

      const result = JSON.parse(run.stdout) as Installed;

      // A guard, not an assertion about the product: getting the environment to
      // the child wrong would append to whoever is running the tests' own rc
      // file, and that has to fail here rather than succeed quietly.
      expect(result.rcFile.startsWith(home)).toBe(true);
      expect(result).toEqual({
        outcome: "installed",
        shell: "zsh",
        rcFile: join(home, ".zshrc"),
        // Written by the child, so this is the one place the line names the
        // real entry script rather than a test runner.
        line: expect.stringContaining("'shell-init' 'zsh'"),
      });
      expect(await Bun.file(join(home, ".zshrc")).text()).toBe(block(result.line ?? ""));
    });
  });

  test("a second run is reported as already installed, in the document too", async () => {
    await withTempHome(async (home, env) => {
      const shell = { ...env, SHELL: "/bin/zsh" };
      expect((await runCli(["install"], { env: shell })).exitCode).toBe(ExitCode.ok);
      const after = await Bun.file(join(home, ".zshrc")).text();

      const run = await runCli(["install", "--json"], { env: shell });
      const result = JSON.parse(run.stdout) as Installed;

      expect(run.exitCode).toBe(ExitCode.ok);
      expect(result.outcome).toBe("already-installed");
      expect(result.line).toBeUndefined();
      expect(await Bun.file(join(home, ".zshrc")).text()).toBe(after);
    });
  });

  test("a $SHELL it cannot place is a usage error that says what to type", async () => {
    await withTempHome(async (_home, env) => {
      const result = await runCli(["install"], { env: { ...env, SHELL: "/bin/tcsh" } });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("could not tell which shell this is from $SHELL");
      expect(result.stderr).toContain("grove install <shell>");
    });
  });

  test("a shell it does not know is refused before anything is written", async () => {
    await withTempHome(async (home, env) => {
      const result = await runCli(["install", "tcsh"], { env: { ...env, SHELL: "/bin/zsh" } });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("is not a shell this knows");
      expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
    });
  });
});
