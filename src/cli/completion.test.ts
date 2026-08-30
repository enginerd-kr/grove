import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { managedRepo, seedWorktree, withTempRepo } from "../core/test-utils.ts";
import { completionScript, completionWords } from "./completion.ts";
import { SUBCOMMANDS } from "./help.ts";
import { SHELLS, type Shell } from "./shell-init.ts";

/**
 * The scripts, and the two lists they ask for.
 *
 * The scripts are generated, so the thing worth testing is that they are still
 * scripts: a summary with an apostrophe in it — and half of them have one —
 * lands inside a single-quoted word, and a quoting mistake there is a syntax
 * error at every shell start rather than a completion that is merely wrong. So
 * each one is handed to the shell it is for, to parse and not to run.
 *
 * The lists are the other half, and what matters about them is what they leave
 * out: a branch that already has a worktree is not something `add` should be
 * offering, and a directory that is not a repository is no suggestions rather
 * than an error.
 */

/** Whether this machine has the shell, since fish is on very few CI runners. */
async function has(shell: Shell): Promise<boolean> {
  return (await Bun.spawn(["which", shell], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
}

/** `-n` is parse and do not run, in all three of them. */
async function parses(shell: Shell, script: string): Promise<boolean> {
  const proc = Bun.spawn([shell, "-n", "/dev/stdin"], {
    stdin: new TextEncoder().encode(script),
    stdout: "ignore",
    stderr: "pipe",
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${shell} refused the script it was given:\n${stderr}`);

  return true;
}

describe("completionScript", () => {
  test("every shell it knows gets a script that shell can parse", async () => {
    for (const shell of SHELLS as readonly Shell[]) {
      if (!(await has(shell))) continue;
      expect(await parses(shell, completionScript(shell))).toBe(true);
    }
  });

  test("every subcommand is in every script, because they are one table", async () => {
    for (const shell of SHELLS as readonly Shell[]) {
      const script = completionScript(shell);
      for (const spec of SUBCOMMANDS) expect(script).toContain(spec.name);
    }
  });

  test("the callback is the spelling that printed it, not a `grove` on PATH", () => {
    // The same promise `shell-init` makes: a completion installed from a bare
    // checkout has to reach that checkout, and `grove` may not be anywhere.
    for (const shell of SHELLS as readonly Shell[]) {
      expect(completionScript(shell)).toContain(process.execPath);
      expect(completionScript(shell)).toContain("completion targets");
      expect(completionScript(shell)).toContain("completion branches");
    }
  });
});

describe("completionWords", () => {
  test("targets are the worktrees, by the name the list draws", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      expect(await completionWords(repo.root, undefined, "targets")).toEqual([
        "feat/login",
        "main",
      ]);
    });
  });

  test("branches leave out the ones that already have a worktree", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // The fixture's origin has `main` and `feat/login`; only `main` is checked
      // out, so only the other is a branch `add` would have anything to do.
      const before = await completionWords(repo.root, undefined, "branches");
      expect(before).toContain("feat/login");
      expect(before).not.toContain("main");
      // And never the remote itself, which `refs/remotes/origin/HEAD` shortens to.
      expect(before).not.toContain("origin");

      await seedWorktree(repo, "feat/login");

      expect(await completionWords(repo.root, undefined, "branches")).not.toContain("feat/login");
    });
  });

  test("somewhere that is not a repository is no suggestions, not an error", async () => {
    await withTempRepo(async (temp) => {
      expect(await completionWords(temp.work, undefined, "targets")).toEqual([]);
      expect(await completionWords(join(temp.work, "nowhere"), undefined, "branches")).toEqual([]);
    });
  });
});
