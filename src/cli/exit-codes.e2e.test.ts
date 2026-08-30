import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "./exit-codes.ts";
import { runCli } from "./test-cli.ts";

/**
 * The numbers a wrapper script actually reads.
 *
 * `exit-codes.test.ts` asserts the mapping — every `GroveErrorCode`, spelled
 * out against the number it becomes — and that is a pure total function, so it
 * needs no process. What no function call can show is the last step: that the
 * number reaches `process.exitCode` at all, that stdout is *empty* when it
 * does, and that the sentence explaining it went to stderr instead. A script
 * that branches on `$?` and pipes stdout into `jq` depends on both halves, and
 * only a real exit can be caught getting either wrong.
 *
 * One case per distinct code that can be provoked without a repository to
 * break first: usage (2), not-a-repo (3), and success (0). The rest of the
 * table is reached through commands, and is asserted where those commands are.
 */

/** git's own environment, pinned so a laptop's global config cannot join in. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("what the shell actually sees", () => {
  test("an unknown flag exits 2, with nothing on stdout", async () => {
    const result = await runCli(["--nope"]);

    expect(result.exitCode).toBe(ExitCode.usage);
    // A mistyped `grove list --json | jq` must not feed jq a usage message.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option");
  });

  test("running outside any repository exits 3", async () => {
    const empty = await mkdtemp(join(tmpdir(), "grove-nowhere-"));

    try {
      const result = await runCli(["list"], { cwd: empty, env: GIT_ENV });

      expect(result.exitCode).toBe(ExitCode.notARepo);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no worktree repository found");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("success is 0 and says so on stdout", async () => {
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(ExitCode.ok);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
