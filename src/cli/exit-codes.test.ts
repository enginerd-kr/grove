import { describe, expect, test } from "bun:test";
import type { GroveErrorCode } from "../core/errors.ts";
import { ExitCode, type ExitCodeValue, errorToExitCode } from "./exit-codes.ts";

/**
 * These numbers are the interface a wrapper script reads, so the test is
 * written as the table it is: every failure code, spelled out, with the number
 * a script would branch on. Adding a code without a line here is a typecheck
 * failure, which is the same guarantee `errorToExitCode`'s switch gives.
 *
 * The mapping is a pure total function, so the table is asserted by calling it.
 * That the number then survives the trip out of the process is a different
 * claim, and lives in `exit-codes.e2e.test.ts`.
 */
const EXPECTED: Readonly<Record<GroveErrorCode, ExitCodeValue>> = {
  usage: 2,
  "not-a-repo": 3,
  refused: 4,
  "rebase-conflict": 5,
  "state-conflict": 6,
  "setup-failed": 9,
  "command-failed": 11,
  gh: 10,
  "git-failed": 7,
  remote: 8,
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
      commandFailed: 11,
      // 128 + SIGINT, the convention a shell reports for Ctrl-C.
      interrupted: 130,
    });
  });
});
