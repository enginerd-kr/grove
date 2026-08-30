import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "./exit-codes.ts";
import { detectShell, rcFileFor } from "./install.ts";
import type { Shell } from "./shell-init.ts";
import { runCli } from "./test-cli.ts";

/**
 * `install` writes to a shell's rc file, which is the one thing in this tool
 * that touches a real home directory — so every run here is given a throwaway
 * one, and the variables that relocate an rc file are cleared rather than
 * inherited from whoever is running the tests.
 */

/** A home nothing else can see, deleted afterwards. */
async function withTempHome(
  body: (home: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "grove-home-"));

  try {
    await body(home, {
      HOME: home,
      // Unset rather than inherited: a developer with either of these set would
      // otherwise have the test write outside the temporary home.
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

type Installed = { readonly outcome: string; readonly rcFile: string; readonly line?: string };

async function install(
  home: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ result: Installed }> {
  const run = await runCli([...args, "--json"], { env });
  expect(run.exitCode).toBe(ExitCode.ok);

  const result = JSON.parse(run.stdout) as Installed;
  // A guard, not an assertion about the product: getting the environment to the
  // child wrong would append to whoever is running the tests' own rc file, and
  // that has to fail here rather than succeed quietly.
  expect(result.rcFile.startsWith(home)).toBe(true);

  return { result };
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

describe("grove install", () => {
  test("detects the shell from $SHELL and writes that shell's rc file", async () => {
    await withTempHome(async (home, env) => {
      const { result } = await install(home, ["install"], { ...env, SHELL: "/bin/zsh" });

      expect(result.outcome).toBe("installed");
      expect(result.rcFile).toBe(join(home, ".zshrc"));
      expect(result.line).toContain("shell-init");
      expect(result.line).toContain("'zsh'");
      expect(await Bun.file(join(home, ".zshrc")).text()).toBe(block(result.line ?? ""));
    });
  });

  test("is idempotent: a second run leaves the file exactly as it was", async () => {
    await withTempHome(async (home, env) => {
      const rc = join(home, ".zshrc");
      await install(home, ["install"], { ...env, SHELL: "/bin/zsh" });
      const after = await Bun.file(rc).text();

      const { result } = await install(home, ["install"], { ...env, SHELL: "/bin/zsh" });

      expect(result.outcome).toBe("already-installed");
      expect(result.rcFile).toBe(rc);
      expect(await Bun.file(rc).text()).toBe(after);
    });
  });

  test("leaves a line somebody wrote by hand, in another spelling, alone", async () => {
    await withTempHome(async (home, env) => {
      // The idempotency is on the marker, not on the exact line: a long-checkout
      // spelling pasted by hand is the same installation.
      const original = '# mine\neval "$(grove shell-init bash)"\n';
      await Bun.write(join(home, ".bashrc"), original);

      const { result } = await install(home, ["install", "bash"], env);

      expect(result.outcome).toBe("already-installed");
      expect(await Bun.file(join(home, ".bashrc")).text()).toBe(original);
    });
  });

  test("appends to an existing rc file without disturbing what is in it", async () => {
    await withTempHome(async (home, env) => {
      // No trailing newline: the block has to start one rather than land on the
      // end of somebody's last line.
      await Bun.write(join(home, ".bashrc"), "export EDITOR=vim");

      const { result } = await install(home, ["install", "bash"], env);

      expect(await Bun.file(join(home, ".bashrc")).text()).toBe(
        `export EDITOR=vim\n${block(result.line ?? "")}`,
      );
    });
  });

  test("fish gets its own rc file, its own directory, and fish quoting", async () => {
    await withTempHome(async (home, env) => {
      const rc = join(home, ".config/fish/config.fish");
      const { result } = await install(home, ["install", "fish"], { ...env, SHELL: "/bin/zsh" });

      // The named shell beats $SHELL, and the directory is created for it.
      expect(result.rcFile).toBe(rc);
      expect(result.line).toContain("'shell-init' 'fish'");
      expect(await Bun.file(rc).text()).toBe(block(result.line ?? ""));
    });
  });

  test("bash lands in the file that is already there", async () => {
    await withTempHome(async (home, env) => {
      await mkdir(home, { recursive: true });
      await Bun.write(join(home, ".profile"), "# login\n");

      const { result } = await install(home, ["install", "bash"], env);

      expect(result.rcFile).toBe(join(home, ".profile"));
      expect(await Bun.file(join(home, ".profile")).text()).toBe(
        `# login\n${block(result.line ?? "")}`,
      );
      expect(await Bun.file(join(home, ".bashrc")).exists()).toBe(false);
    });
  });

  test("the rc file's path is the result on stdout, and the news is on stderr", async () => {
    await withTempHome(async (home, env) => {
      const result = await runCli(["install"], { env: { ...env, SHELL: "/bin/zsh" } });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toBe(`${join(home, ".zshrc")}\n`);
      expect(result.stderr).toContain("added to");
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

  test("every shell it knows writes a line naming that shell", async () => {
    const shells: readonly Shell[] = ["zsh", "bash", "fish"];

    for (const shell of shells) {
      await withTempHome(async (home, env) => {
        const { result } = await install(home, ["install", shell], env);

        expect(result.outcome).toBe("installed");
        expect(result.line).toContain(`'shell-init' '${shell}'`);
        expect(await Bun.file(result.rcFile).text()).toContain(result.line ?? "");
      });
    }
  });
});
