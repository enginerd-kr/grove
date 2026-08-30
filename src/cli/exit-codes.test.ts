import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveErrorCode } from "../core/errors.ts";
import { ExitCode, type ExitCodeValue, errorToExitCode } from "./exit-codes.ts";
import { runCli } from "./test-cli.ts";

/**
 * These numbers are the interface a wrapper script reads, so the test is
 * written as the table it is: every failure code, spelled out, with the number
 * a script would branch on. Adding a code without a line here is a typecheck
 * failure, which is the same guarantee `errorToExitCode`'s switch gives.
 */
const EXPECTED: Readonly<Record<GroveErrorCode, ExitCodeValue>> = {
  usage: 2,
  "not-a-repo": 3,
  refused: 4,
  "rebase-conflict": 5,
  "state-conflict": 6,
  "setup-failed": 9,
  gh: 10,
  "git-failed": 7,
  remote: 8,
};

/** git's own environment, pinned so a laptop's global config cannot join in. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("errorToExitCode", () => {
  test("maps every error code to the number a script branches on", () => {
    for (const [code, expected] of Object.entries(EXPECTED) as [GroveErrorCode, ExitCodeValue][]) {
      expect([code, errorToExitCode(code)]).toEqual([code, expected]);
    }
  });

  test("no two codes collapse onto the same number", () => {
    const codes = Object.keys(EXPECTED) as GroveErrorCode[];
    const values = codes.map(errorToExitCode);

    expect(values).toEqual([...new Set(values)]);
    // And none of them is success, or the bug-in-this-tool code — a `GroveError`
    // is a failure we meant, which is neither of those.
    expect(values).not.toContain(ExitCode.ok);
    expect(values).not.toContain(ExitCode.internal);
  });

  test("the constants themselves are the documented numbers", () => {
    expect(ExitCode).toEqual({
      ok: 0,
      internal: 1,
      usage: 2,
      notARepo: 3,
      refused: 4,
      rebaseConflict: 5,
      stateConflict: 6,
      gitFailed: 7,
      remote: 8,
      setupFailed: 9,
      gh: 10,
      // 128 + SIGINT, the convention a shell reports for Ctrl-C.
      interrupted: 130,
    });
  });
});

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
