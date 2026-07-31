import { expect, test } from "bun:test";
import type { GardenErrorCode } from "./errors.ts";
import { classifyGitError, GardenError, stderrDetails } from "./errors.ts";

test("classifies the stderr git actually produces", () => {
  const cases: readonly (readonly [string, GardenErrorCode])[] = [
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "remote",
    ],
    ["ssh: Could not resolve hostname nope.invalid: nodename nor servname provided", "remote"],
    ["fatal: Authentication failed for 'https://github.com/org/repo.git/'", "remote"],
    ["git@github.com: Permission denied (publickey).", "remote"],
    ["remote: Repository not found.", "remote"],
    ["fatal: 'origin' does not appear to be a git repository", "remote"],
    ["fatal: 'main' is already checked out at '/work/repo/main'", "state-conflict"],
    ["fatal: '/work/repo/feat-login' already exists", "state-conflict"],
    ["CONFLICT (content): Merge conflict in app.txt", "rebase-conflict"],
    ["error: could not apply 1a2b3c4... Add login", "rebase-conflict"],
    ["error: Your local changes to the following files would be overwritten by merge:", "refused"],
    ["fatal: not a git repository (or any of the parent directories): .git", "not-a-repo"],
    ["fatal: something nobody predicted", "git-failed"],
  ];

  for (const [stderr, code] of cases) {
    expect(classifyGitError(stderr)).toBe(code);
  }
});

// Both sentences contain "git repository". Matching the shorter one first would
// report an unreachable remote as a local path mistake and send the user hunting
// in the wrong place.
test("prefers the remote reading over the local one when both could match", () => {
  const stderr = [
    "fatal: 'file:///gone.git' does not appear to be a git repository",
    "fatal: Could not read from remote repository.",
  ].join("\n");

  expect(classifyGitError(stderr)).toBe("remote");
});

test("stderrDetails keeps the last lines and drops progress noise", () => {
  const stderr = [
    "Receiving objects:  47% (470/1000)",
    "Receiving objects: 100% (1000/1000), done.",
    "fatal: the useful sentence",
    "",
  ].join("\n");

  expect(stderrDetails(stderr)).toEqual(["fatal: the useful sentence"]);
});

test("stderrDetails caps how much git narration reaches the user", () => {
  const stderr = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");

  expect(stderrDetails(stderr)).toEqual(["line 7", "line 8", "line 9", "line 10", "line 11"]);
});

test("a GardenError carries the code, hint, and details forward", () => {
  const error = new GardenError("refused", "worktree has uncommitted changes", {
    hint: "commit or stash first",
    details: ["app.txt"],
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("refused");
  expect(error.hint).toBe("commit or stash first");
  expect(error.details).toEqual(["app.txt"]);
});
