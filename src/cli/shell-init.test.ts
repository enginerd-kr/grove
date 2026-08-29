import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCli } from "../ui/e2e-utils.ts";
import { ExitCode } from "./exit-codes.ts";
import { isCompiledMain, isShell, SHELLS } from "./shell-init.ts";

/**
 * The function is generated from *this* invocation — `process.execPath` and
 * `Bun.main` of the process that printed it — so it has to be read from a real
 * child. Calling `shellInit` in-process would embed the test runner instead,
 * which is precisely the thing that must not happen.
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
      expect(result.stdout).toContain('if [ "$1" = "cd" ]; then');
      expect(result.stdout).toContain('builtin cd "$dest"');
      // fish's spellings, which would be syntax errors here.
      expect(result.stdout).not.toContain("function grove");
      expect(result.stdout).not.toContain("set -l");
    }

    // One script for both, which is what makes one script enough to test.
    expect(zsh.stdout).toBe(bash.stdout);
  });

  test("prints a fish function for fish, in fish's own dialect", async () => {
    const result = await runCli(["shell-init", "fish"]);

    expect(result.exitCode).toBe(ExitCode.ok);
    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("function grove");
    expect(result.stdout).toContain("set --erase argv[1]");
    expect(result.stdout).toContain("or return $status");
    expect(result.stdout).toContain("builtin cd $dest");
    expect(result.stdout.trimEnd().endsWith("\nend")).toBe(true);
    // The posix spellings, which fish does not have.
    expect(result.stdout).not.toContain("grove() {");
    expect(result.stdout).not.toContain('"$@"');
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

describe("isShell", () => {
  test("accepts exactly the shells the list names", () => {
    for (const shell of SHELLS) expect(isShell(shell)).toBe(true);
    for (const other of ["", "sh", "tcsh", "ZSH", "/bin/zsh"]) expect(isShell(other)).toBe(false);
  });
});

describe("isCompiledMain", () => {
  test("recognises the virtual paths a compiled binary reports", () => {
    // Emitting one of these into the shell function would hand every wrapper
    // call a first argument that exists for no other process.
    expect(isCompiledMain("/$bunfs/root/grove")).toBe(true);
    expect(isCompiledMain("B:\\~BUN\\root\\grove")).toBe(true);
  });

  test("leaves a real entry script alone", () => {
    expect(isCompiledMain(ENTRY)).toBe(false);
    expect(isCompiledMain("/home/me/bunfs/cli.tsx")).toBe(false);
  });
});
