import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt, refused } from "../core/test-utils.ts";
import { detectShell, type InstallResult, installShellInit, rcFileFor } from "./install.ts";
import { SHELLS, type Shell } from "./shell-init.ts";

/**
 * `install` writes to a shell's rc file, which is the one thing in this tool
 * that touches a real home directory — so every run here is given a throwaway
 * one, and the variables that relocate an rc file are cleared rather than
 * inherited from whoever is running the tests.
 *
 * `installShellInit` takes both of those as parameters, which is the whole
 * reason they are parameters: the environment and the home directory are what
 * the command is *about*, and passing them in costs a function call where
 * handing them to a child costs a process. It also holds on to the
 * `InstallResult` itself, so "installed" and "already-installed" are told apart
 * by the field that says so rather than by a sentence, and a refusal is the
 * `GroveError` with its code and its hint rather than an exit code.
 *
 * `install.e2e.test.ts` keeps the part that only the binary has: which of the
 * two writers the path and the news go to, the `--json` document, and the
 * shells that are rejected in argument parsing before this function is reached.
 */

/** A home nothing else can see, deleted afterwards. */
async function withTempHome(
  body: (home: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "grove-home-"));

  try {
    await body(home, {
      // Unset rather than inherited: a developer with either of these set would
      // otherwise have the test write outside the temporary home.
      HOME: home,
      ZDOTDIR: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_CACHE_HOME: join(home, ".cache"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The line an install wrote, having insisted that it wrote one. */
function writtenLine(result: InstallResult): string {
  if (result.outcome !== "installed") throw new Error(`expected an install, got ${result.outcome}`);

  return result.line;
}

/** What a full install writes: one block, holding both eval lines. */
function block(line: string): string {
  return `\n# grove: the shell function behind 'grove cd', and tab completion\n${line}\n`;
}

describe("detectShell", () => {
  test("reads the basename of $SHELL, and only a shell it knows", () => {
    expect(detectShell({ SHELL: "/bin/zsh" })).toBe("zsh");
    expect(detectShell({ SHELL: "/usr/local/bin/fish" })).toBe("fish");
    expect(detectShell({ SHELL: "bash" })).toBe("bash");
    expect(detectShell({ SHELL: "/bin/tcsh" })).toBeUndefined();
    expect(detectShell({ SHELL: "" })).toBeUndefined();
    expect(detectShell({})).toBeUndefined();
  });
});

describe("rcFileFor", () => {
  test("zsh and fish each read one place, and honour what relocates it", async () => {
    await withTempHome(async (home) => {
      expect(await rcFileFor("zsh", {}, home)).toBe(join(home, ".zshrc"));
      expect(await rcFileFor("zsh", { ZDOTDIR: "/dots" }, home)).toBe("/dots/.zshrc");
      expect(await rcFileFor("fish", {}, home)).toBe(join(home, ".config/fish/config.fish"));
      expect(await rcFileFor("fish", { XDG_CONFIG_HOME: "/cfg" }, home)).toBe(
        "/cfg/fish/config.fish",
      );
    });
  });

  test("bash takes whichever file is already there, in order", async () => {
    // Which file a bash session reads depends on how it was started, which is
    // not knowable from here — so the one that exists wins.
    for (const [present, expected] of [
      [".bashrc", ".bashrc"],
      [".bash_profile", ".bash_profile"],
      [".profile", ".profile"],
    ] as const) {
      await withTempHome(async (home) => {
        await Bun.write(join(home, present), "# hi\n");
        expect(await rcFileFor("bash", {}, home)).toBe(join(home, expected));
      });
    }

    await withTempHome(async (home) => {
      await Bun.write(join(home, ".bash_profile"), "");
      await Bun.write(join(home, ".profile"), "");
      // .bashrc is absent, and .bash_profile is the next one asked about.
      expect(await rcFileFor("bash", {}, home)).toBe(join(home, ".bash_profile"));
    });

    await withTempHome(async (home) => {
      // Nothing there at all: a fresh install lands in .bashrc.
      expect(await rcFileFor("bash", {}, home)).toBe(join(home, ".bashrc"));
    });
  });
});

describe("installShellInit", () => {
  test("detects the shell from $SHELL and writes that shell's rc file", async () => {
    await withTempHome(async (home, env) => {
      const result = await installShellInit(undefined, {
        env: { ...env, SHELL: "/bin/zsh" },
        home,
      });

      // Every field, not just the outcome: `shell` is what the sentence names
      // and `rcFile` is what a person is told to restart, so both are answers.
      expect(result).toEqual({
        outcome: "installed",
        shell: "zsh",
        rcFile: join(home, ".zshrc"),
        line: expect.stringContaining("'shell-init' 'zsh'"),
      });
      expect(await Bun.file(join(home, ".zshrc")).text()).toBe(block(writtenLine(result)));
    });
  });

  test("is idempotent: a second run leaves the file exactly as it was", async () => {
    await withTempHome(async (home, env) => {
      const rc = join(home, ".zshrc");
      await installShellInit("zsh", { env, home });
      const after = await Bun.file(rc).text();

      const result = await installShellInit("zsh", { env, home });

      // No `line`, and that is the point: there is nothing to tell anybody to
      // run, because the line they would run is already in the file.
      expect(result).toEqual({ outcome: "already-installed", shell: "zsh", rcFile: rc });
      expect(await Bun.file(rc).text()).toBe(after);
    });
  });

  test("leaves a line somebody wrote by hand, in another spelling, alone", async () => {
    await withTempHome(async (home, env) => {
      // The idempotency is on the marker, not on the exact line: a long-checkout
      // spelling pasted by hand is the same installation.
      const original = '# mine\neval "$(grove shell-init bash)"\neval "$(grove completion bash)"\n';
      await Bun.write(join(home, ".bashrc"), original);

      const result = await installShellInit("bash", { env, home });

      expect(result.outcome).toBe("already-installed");
      expect(result.rcFile).toBe(join(home, ".bashrc"));
      expect(await Bun.file(join(home, ".bashrc")).text()).toBe(original);
    });
  });

  test("adds only the line that is missing, for an rc file installed before it existed", async () => {
    await withTempHome(async (home, env) => {
      // Every rc file written by a grove that had no completions looks like
      // this, and the useful answer for it is the one line it is short of.
      const original = 'eval "$(grove shell-init bash)"\n';
      await Bun.write(join(home, ".bashrc"), original);

      const result = await installShellInit("bash", { env, home });

      expect(result.outcome).toBe("installed");
      expect(writtenLine(result)).toContain("'completion' 'bash'");
      expect(writtenLine(result)).not.toContain("'shell-init'");
      // And the heading names what the block holds, rather than repeating a
      // sentence about the function that is already two lines above it.
      expect(await Bun.file(join(home, ".bashrc")).text()).toBe(
        `${original}\n# grove: tab completion\n${writtenLine(result)}\n`,
      );
    });
  });

  test("appends to an existing rc file without disturbing what is in it", async () => {
    await withTempHome(async (home, env) => {
      // No trailing newline: the block has to start one rather than land on the
      // end of somebody's last line.
      await Bun.write(join(home, ".bashrc"), "export EDITOR=vim");

      const result = await installShellInit("bash", { env, home });

      expect(result.outcome).toBe("installed");
      expect(await Bun.file(join(home, ".bashrc")).text()).toBe(
        `export EDITOR=vim\n${block(writtenLine(result))}`,
      );
    });
  });

  test("fish gets its own rc file, its own directory, and fish quoting", async () => {
    await withTempHome(async (home, env) => {
      const rc = join(home, ".config/fish/config.fish");
      const result = await installShellInit("fish", { env: { ...env, SHELL: "/bin/zsh" }, home });

      // The named shell beats $SHELL, and the directory is created for it.
      expect(result.rcFile).toBe(rc);
      expect(result.shell).toBe("fish");
      expect(writtenLine(result)).toContain("'shell-init' 'fish'");
      expect(await Bun.file(rc).text()).toBe(block(writtenLine(result)));
    });
  });

  test("bash lands in the file that is already there", async () => {
    await withTempHome(async (home, env) => {
      await Bun.write(join(home, ".profile"), "# login\n");

      const result = await installShellInit("bash", { env, home });

      expect(result.rcFile).toBe(join(home, ".profile"));
      expect(await Bun.file(join(home, ".profile")).text()).toBe(
        `# login\n${block(writtenLine(result))}`,
      );
      expect(await Bun.file(join(home, ".bashrc")).exists()).toBe(false);
    });
  });

  test("every shell it knows writes a line naming that shell", async () => {
    for (const shell of SHELLS as readonly Shell[]) {
      await withTempHome(async (home, env) => {
        const result = await installShellInit(shell, { env, home });

        expect(result.outcome).toBe("installed");
        expect(writtenLine(result)).toContain(`'shell-init' '${shell}'`);
        expect(await Bun.file(result.rcFile).text()).toContain(writtenLine(result));
      });
    }
  });

  test("a $SHELL it cannot place is a usage error that says what to type", async () => {
    await withTempHome(async (home, env) => {
      const error = refused(
        await attempt(() =>
          installShellInit(undefined, { env: { ...env, SHELL: "/bin/tcsh" }, home }),
        ),
      );

      expect(error.code).toBe("usage");
      expect(error.message).toContain("could not tell which shell this is from $SHELL");
      // The hint is the whole value of refusing rather than guessing: it names
      // the one thing that resolves it, and the words that are allowed in it.
      expect(error.hint).toContain("grove install <shell>");
      expect(error.hint).toContain("zsh, bash, fish");

      // And nothing was written while it was working that out.
      expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
      expect(await Bun.file(join(home, ".bashrc")).exists()).toBe(false);
    });
  });
});
