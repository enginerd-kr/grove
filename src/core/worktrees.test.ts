import { expect, test } from "bun:test";
import { GardenError } from "./errors.ts";
import { parseStatus, parseWorktreeList, resolveTarget, type WorktreeRecord } from "./worktrees.ts";

/** Real output shapes, copied from git rather than imagined. */
const PORCELAIN = [
  "worktree /work/repo/.bare",
  "bare",
  "",
  "worktree /work/repo/main",
  "HEAD a1e77c93d81c31c5c0c8da2eb607c9f059a48551",
  "branch refs/heads/main",
  "",
  "worktree /work/repo/feat-login",
  "HEAD fcebcaa4cd5c730d7484e58581e3c8a2f0462696",
  "branch refs/heads/feat/login",
  "",
  "worktree /work/repo/det",
  "HEAD a1e77c93d81c31c5c0c8da2eb607c9f059a48551",
  "detached",
  "",
].join("\n");

test("parses the bare entry, branches, and a detached HEAD", () => {
  const records = parseWorktreeList(PORCELAIN);

  expect(records).toHaveLength(4);
  expect(records[0]).toMatchObject({ path: "/work/repo/.bare", bare: true, detached: false });
  // The ref prefix is stripped: `feat/login` is what the user typed and will type.
  expect(records[2]).toMatchObject({ path: "/work/repo/feat-login", branch: "feat/login" });
  expect(records[3]).toMatchObject({ detached: true, branch: undefined });
});

test("a path containing spaces survives parsing", () => {
  // The reason attributes are split on the first space only, never tokenised.
  const records = parseWorktreeList(
    ["worktree /work/my repo/feat x", "HEAD abc123", "branch refs/heads/feat/x", ""].join("\n"),
  );

  expect(records[0]?.path).toBe("/work/my repo/feat x");
  expect(records[0]?.branch).toBe("feat/x");
});

test("locked and prunable are distinguished from their reasons", () => {
  const records = parseWorktreeList(
    [
      "worktree /work/repo/a",
      "HEAD abc",
      "branch refs/heads/a",
      "locked",
      "",
      "worktree /work/repo/b",
      "HEAD def",
      "branch refs/heads/b",
      "locked held for a demo",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"),
  );

  // Locked without a reason still counts as locked, so the empty string is
  // meaningful and only `undefined` means unlocked.
  expect(records[0]?.locked).toBe("");
  expect(records[1]?.locked).toBe("held for a demo");
  expect(records[1]?.prunable).toContain("non-existent");
});

test("empty output parses to nothing rather than a phantom record", () => {
  expect(parseWorktreeList("")).toEqual([]);
  expect(parseWorktreeList("\n\n")).toEqual([]);
});

test("status reports cleanliness and drift from one call", () => {
  const status = parseStatus(
    [
      "# branch.oid a1e77c9",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 45b983b 45b983b README.md",
      "? untracked.txt",
      "",
    ].join("\0"),
  );

  expect(status).toMatchObject({ dirty: true, upstream: "origin/main", ahead: 2, behind: 3 });
  expect(status.changed).toEqual(["README.md", "untracked.txt"]);
  // Kept apart because `reset --hard` leaves this one where it is.
  expect(status.untracked).toEqual(["untracked.txt"]);
});

test("a clean worktree is not dirty", () => {
  const status = parseStatus(
    ["# branch.oid a1e77c9", "# branch.head main", "# branch.ab +0 -0", ""].join("\0"),
  );

  expect(status).toEqual({
    dirty: false,
    changed: [],
    untracked: [],
    upstream: undefined,
    ahead: 0,
    behind: 0,
  });
});

// Every entry type has a different field count before the path, and a path may
// itself contain spaces — so the count has to be respected exactly.
test("paths with spaces are extracted from every entry type", () => {
  const status = parseStatus(
    [
      "# branch.head main",
      "1 .M N... 100644 100644 100644 45b983b 45b983b my file.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted file.txt",
      "? new file.txt",
      "",
    ].join("\0"),
  );

  expect(status.changed).toEqual(["my file.txt", "conflicted file.txt", "new file.txt"]);
});

test("a rename's original path is not counted as a second change", () => {
  const status = parseStatus(
    [
      "# branch.head main",
      "2 R. N... 100644 100644 100644 45b983b 45b983b R100 new name.txt",
      "old name.txt",
      "? after.txt",
      "",
    ].join("\0"),
  );

  expect(status.changed).toEqual(["new name.txt", "after.txt"]);
});

const ROOT = "/work/repo";
const WORKTREES: readonly WorktreeRecord[] = [
  { path: "/work/repo/main", branch: "main", detached: false, bare: false },
  { path: "/work/repo/feat/login", branch: "feat/login", detached: false, bare: false },
  { path: "/work/repo/det", detached: true, bare: false },
];

test("a target resolves by branch, by directory, or by path", () => {
  const at = (target: string, cwd = ROOT) =>
    resolveTarget(target, WORKTREES, { root: ROOT, cwd }).path;

  // With nesting the branch and the directory are spelled the same way, which is
  // the point — but both routes still have to work, and neither is a guess.
  expect(at("feat/login")).toBe("/work/repo/feat/login");
  expect(at("/work/repo/feat/login", "/tmp")).toBe("/work/repo/feat/login");
  // Relative to where the user is standing, which is how tab completion spells it.
  expect(at("./feat/login")).toBe("/work/repo/feat/login");
  expect(at("main")).toBe("/work/repo/main");
});

// `feat` is a folder holding worktrees, not a worktree — so naming it is a
// miss, not a partial match on everything beneath it.
test("a parent directory is not a target", () => {
  expect(() => resolveTarget("feat", WORKTREES, { root: ROOT, cwd: ROOT })).toThrow(GardenError);
});

test("branch wins over a directory of the same name", () => {
  const clashing: readonly WorktreeRecord[] = [
    { path: "/work/repo/other", branch: "main", detached: false, bare: false },
    { path: "/work/repo/main", branch: "feat/x", detached: false, bare: false },
  ];

  // "main" is both a branch and a directory here. Branch is what people say out
  // loud, so it is what wins.
  expect(resolveTarget("main", clashing, { root: ROOT, cwd: ROOT }).path).toBe("/work/repo/other");
});

test("an unknown target lists what is actually there", () => {
  const thrown = (() => {
    try {
      resolveTarget("nope", WORKTREES, { root: ROOT, cwd: ROOT });
      return undefined;
    } catch (error) {
      return error;
    }
  })();

  expect(thrown).toBeInstanceOf(GardenError);
  expect((thrown as GardenError).code).toBe("not-a-repo");
  expect((thrown as GardenError).details.join("\n")).toContain("feat/login");
});
