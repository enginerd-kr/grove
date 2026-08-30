import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evalLine, isCompiledMain, isShell, SHELLS, shellInit } from "./shell-init.ts";

/**
 * The shell function `grove shell-init` prints, as the string it is.
 *
 * `shellInit` is pure: given a shell it composes a script out of this process's
 * own `process.execPath` and `Bun.main`. That makes the dialect — posix here,
 * fish there, and nothing from one leaking into the other — a property of a
 * return value, and asserting it costs a function call rather than a process.
 *
 * The invocation it embeds is asserted the same way, and *more* precisely than
 * a child could show it: this process knows exactly which two words it expects
 * to be quoted back at it, so the test compares them rather than looking for a
 * path it hopes is in there. That the words are this test file rather than
 * `cli.tsx` is the point — the function reaches back through however grove was
 * reached, whatever that was.
 *
 * What stays in `shell-init.e2e.test.ts` is what only the binary can answer:
 * that the script reaches stdout with nothing on stderr, that the run exits 0
 * so an rc file's `eval "$(…)"` is not a failed line, and that a real child
 * writes the *entry script* into it — the case this file cannot construct,
 * because in here the entry script is the test runner.
 */

/** The words the printed function must call back through: this very invocation. */
const SELF = `'${process.execPath}' '${Bun.main}'`;

describe("shellInit", () => {
  test("prints a posix function for zsh and bash", () => {
    for (const shell of ["zsh", "bash"] as const) {
      const script = shellInit(shell);

      expect(script).toContain("grove() {");
      expect(script).toContain('if [ "$1" = "cd" ]; then');
      expect(script).toContain('builtin cd "$dest"');
      // fish's spellings, which would be syntax errors here.
      expect(script).not.toContain("function grove");
      expect(script).not.toContain("set -l");
    }

    // One script for both, which is what makes one script enough to test.
    expect(shellInit("zsh")).toBe(shellInit("bash"));
  });

  test("prints a fish function for fish, in fish's own dialect", () => {
    const script = shellInit("fish");

    expect(script).toContain("function grove");
    expect(script).toContain("set --erase argv[1]");
    expect(script).toContain("or return $status");
    expect(script).toContain("builtin cd $dest");
    expect(script.trimEnd().endsWith("\nend")).toBe(true);
    // The posix spellings, which fish does not have.
    expect(script).not.toContain("grove() {");
    expect(script).not.toContain('"$@"');
  });

  test("the function calls back by the spelling that printed it", () => {
    // Not a `grove` it hopes is on PATH: the runtime and entry script this very
    // run was reached by, which is what makes it work from a bare checkout.
    expect(shellInit("zsh")).toContain(`${SELF} path "$@"`);
    expect(shellInit("fish")).toContain(`${SELF} path $argv`);
    for (const shell of SHELLS) expect(shellInit(shell)).toContain("GROVE_CD_FILE");
  });

  test("every shell it claims to know prints something", () => {
    for (const shell of SHELLS) expect(shellInit(shell).length).toBeGreaterThan(0);
  });
});

describe("evalLine", () => {
  test("is the same invocation again, asking for that shell's function", () => {
    // The line `grove install` appends and the line a bare checkout would be
    // told to paste are built from these same words, which is what keeps the
    // two from drifting apart.
    for (const shell of SHELLS) {
      expect(evalLine(shell)).toBe(`eval "$(${SELF} 'shell-init' '${shell}')"`);
    }
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
    expect(isCompiledMain(resolve(import.meta.dir, "../cli.tsx"))).toBe(false);
    expect(isCompiledMain("/home/me/bunfs/cli.tsx")).toBe(false);
  });
});
