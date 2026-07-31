import { expect, test } from "bun:test";
import type { GardenErrorCode } from "../core/errors.ts";
import { ExitCode, errorToExitCode } from "./exit-codes.ts";

test("every error code maps to a distinct, non-zero exit code", () => {
  const codes: readonly GardenErrorCode[] = [
    "usage",
    "not-a-repo",
    "refused",
    "rebase-conflict",
    "state-conflict",
    "setup-failed",
    "git-failed",
    "remote",
  ];

  const mapped = codes.map(errorToExitCode);

  // Distinct is the point: a wrapper script has to tell "dirty worktree" from
  // "unreachable remote" without grepping stderr.
  expect(new Set(mapped).size).toBe(codes.length);
  expect(mapped).not.toContain(ExitCode.ok);
  // 1 is reserved for bugs in this tool, so no user-facing failure may claim it.
  expect(mapped).not.toContain(ExitCode.internal);
});

test("the codes a wrapper script is most likely to branch on are stable", () => {
  expect(errorToExitCode("usage")).toBe(2);
  expect(errorToExitCode("not-a-repo")).toBe(3);
  expect(errorToExitCode("refused")).toBe(4);
  expect(errorToExitCode("rebase-conflict")).toBe(5);
  // The worktree is there and only the install on top of it is not, which is a
  // cue to retry that rather than to conclude there is no worktree.
  expect(errorToExitCode("setup-failed")).toBe(9);
  expect(ExitCode.interrupted).toBe(130);
});
