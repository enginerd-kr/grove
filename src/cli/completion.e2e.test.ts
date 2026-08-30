import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { managedRepo, seedWorktree, withTempRepo } from "../core/test-utils.ts";
import { ExitCode } from "./exit-codes.ts";
import { SHELLS } from "./shell-init.ts";
import { runCli } from "./test-cli.ts";

/**
 * `grove completion`, read out of a real child.
 *
 * What only a child can show is here, and it is the same short list
 * `shell-init.e2e.test.ts` keeps for the same reasons: the invocation the
 * script embeds is generated from whoever printed it, so in-process it names
 * the test runner; and the script is consumed by an `eval` in an rc file, which
 * makes exit 0, a silent stderr, and stdout being where it lands part of the
 * contract.
 *
 * The two callbacks are here too, and their contract is stricter still: a shell
 * reads them while somebody is holding TAB down, so stdout carries the names
 * and nothing else, and no directory anywhere is worth a non-zero exit.
 */

const ENTRY = resolve(import.meta.dir, "../cli.tsx");

describe("grove completion", () => {
  test("every shell gets its script on stdout, silently, and exits 0", async () => {
    for (const shell of SHELLS) {
      const result = await runCli(["completion", shell]);

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr.trim()).toBe("");
      expect(result.stdout).toContain("grove");
    }
  });

  test("the script calls back by the spelling that printed it", async () => {
    const result = await runCli(["completion", "zsh"]);

    // The entry script of the child, not a `grove` it hopes is on PATH — which
    // is what makes a completion installed from a bare checkout work.
    expect(result.stdout).toContain(ENTRY);
    expect(result.stdout).toContain("completion targets");
  });

  test("a word that is neither a shell nor a callback is a usage error", async () => {
    const result = await runCli(["completion", "tcsh"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stderr).toContain("is not a shell this knows");
  });

  test("targets are the worktree names, one per line, on stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const result = await runCli(["completion", "targets"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toBe("feat/login\nmain\n");
    });
  });

  test("outside a repository it says nothing at all, and still exits 0", async () => {
    await withTempRepo(async (temp) => {
      const result = await runCli(["completion", "branches"], { cwd: temp.work });

      // Not even a newline: `compgen` would offer the empty string as a word.
      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toBe("");
    });
  });
});
