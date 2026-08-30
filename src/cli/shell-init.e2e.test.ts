import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ExitCode } from "./exit-codes.ts";
import { SHELLS } from "./shell-init.ts";
import { runCli } from "./test-cli.ts";

/**
 * `grove shell-init`, read out of a real child.
 *
 * The dialect and the shape of the printed function are properties of a pure
 * `shellInit`, and are asserted as such in `shell-init.test.ts`. Two things
 * survive here that a direct call cannot make:
 *
 * - The invocation the function embeds is generated from *this* process —
 *   `process.execPath` and `Bun.main` of whoever printed it. In-process that is
 *   the test runner, so only a child spawned on `cli.tsx` can show that a real
 *   grove writes the real entry script into it. Getting that wrong is how an
 *   installed `grove` breaks the moment the function it printed calls back.
 * - The line is consumed by `eval "$(grove shell-init zsh)"` at the top of a
 *   shell's rc file. That makes exit 0, a clean stderr, and the script being on
 *   *stdout* part of the contract: anything else and every new shell either
 *   prints a complaint or evaluates nothing.
 *
 * The two usage errors are here for the same reason — they are decided in
 * argument parsing, before `shellInit` is reached at all, and what a person
 * sees is the exit code and the sentence on stderr.
 */

/** The entry script `runCli` spawns; what the printed function must call back through. */
const ENTRY = resolve(import.meta.dir, "../cli.tsx");

describe("shell-init", () => {
  test("prints a posix function for zsh and bash, and exits 0", async () => {
    const [zsh, bash] = await Promise.all([
      runCli(["shell-init", "zsh"]),
      runCli(["shell-init", "bash"]),
    ]);

    for (const result of [zsh, bash]) {
      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr.trim()).toBe("");
      expect(result.stdout).toContain("grove() {");
    }

    // One script for both, which is what makes one script enough to test.
    expect(zsh.stdout).toBe(bash.stdout);
  });

  test("prints a fish function for fish, and exits 0", async () => {
    const result = await runCli(["shell-init", "fish"]);

    expect(result.exitCode).toBe(ExitCode.ok);
    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("function grove");
    expect(result.stdout.trimEnd().endsWith("\nend")).toBe(true);
  });

  test("the function calls back by the spelling that printed it", async () => {
    // Not a `grove` it hopes is on PATH: the runtime and entry script this very
    // run was reached by, which is what makes it work from a bare checkout.
    const [posix, fish] = await Promise.all([
      runCli(["shell-init", "zsh"]),
      runCli(["shell-init", "fish"]),
    ]);

    expect(posix.stdout).toContain(`'${ENTRY}' path "$@"`);
    expect(fish.stdout).toContain(`'${ENTRY}' path $argv`);
    for (const result of [posix, fish]) expect(result.stdout).toContain("GROVE_CD_FILE");
  });

  test("every shell it claims to know prints something", async () => {
    const results = await Promise.all(SHELLS.map((shell) => runCli(["shell-init", shell])));

    for (const result of results) {
      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout.length).toBeGreaterThan(0);
    }
  });

  test("a shell it does not know is a usage error", async () => {
    const result = await runCli(["shell-init", "tcsh"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"tcsh" is not a shell this knows');
    expect(result.stderr).toContain("zsh, bash, fish");
  });

  test("no shell at all is a usage error naming the ones there are", async () => {
    const result = await runCli(["shell-init"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stderr).toContain("shell-init needs a shell: zsh, bash, fish");
  });
});
