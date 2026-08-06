import { expect, test } from "bun:test";
import { GroveError } from "./errors.ts";
import {
  contains,
  looksLikeRepoUrl,
  plainRepoPaths,
  repoNameFromUrl,
  repoPaths,
  slugifySegment,
  worktreeRelPath,
} from "./layout.ts";

test("repoPaths lays out the managed shape: .bare, and a .git pointing at it", () => {
  expect(repoPaths("/work/repo")).toEqual({
    root: "/work/repo",
    gitDir: "/work/repo/.bare",
    gitFile: "/work/repo/.git",
    kind: "managed",
  });
});

// The root is a plain repository's main checkout, so its git dir and its
// pointer file are the same directory — there is no separate pointer to keep
// in sync with a folder that might move.
test("plainRepoPaths points gitDir and gitFile at the same .git", () => {
  expect(plainRepoPaths("/work/plain")).toEqual({
    root: "/work/plain",
    gitDir: "/work/plain/.git",
    gitFile: "/work/plain/.git",
    kind: "plain",
  });
});

// The tree on disk mirrors the tree in refs/heads: `feat/test` is a worktree
// inside `feat/`, not a directory called `feat-test`.
test("a branch keeps its shape as a nested directory", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["feat/test", "feat/test"],
    ["feat/login", "feat/login"],
    ["main", "main"],
    ["release/v1.2.0", "release/v1.2.0"],
    ["feature/JIRA-123/add-thing", "feature/JIRA-123/add-thing"],
    ["fix/spaces in name", "fix/spaces-in-name"],
    ["a//b", "a/b"],
    ["--leading", "leading"],
    ["trailing--", "trailing"],
    [".hidden", "hidden"],
    ["feat/한글", "feat"],
  ];

  for (const [branch, expected] of cases) {
    expect(worktreeRelPath(branch)).toBe(expected);
  }
});

// Lowercasing would map two branches git considers distinct onto one directory,
// inventing a collision that did not exist.
test("case is preserved", () => {
  expect(worktreeRelPath("Feat/Login")).toBe("Feat/Login");
  expect(slugifySegment("Feat")).not.toBe(slugifySegment("feat"));
});

test("a branch with no usable characters is a usage error asking for another name", () => {
  for (const branch of ["///", "...", "---", "\uD55C\uAE00"]) {
    const thrown = (() => {
      try {
        worktreeRelPath(branch);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(GroveError);
    expect((thrown as GroveError).code).toBe("usage");
    expect((thrown as GroveError).hint).toContain("branch name");
  }
});

test("no segment may collide with repository plumbing", () => {
  // `.bare` and `.git` survive sanitising only as `bare`/`git`, which are safe;
  // this pins that they cannot come back as the dotted originals.
  expect(worktreeRelPath(".bare")).toBe("bare");
  expect(worktreeRelPath("x/.git/y")).toBe("x/git/y");
});

test("contains matches a directory but not a sibling with a shared prefix", () => {
  // The bug a string prefix would introduce: `/work/repo/main-old` reported as
  // being inside `/work/repo/main`.
  expect(contains("/work/repo/main", "/work/repo/main")).toBe(true);
  expect(contains("/work/repo/main", "/work/repo/main/src/deep")).toBe(true);
  expect(contains("/work/repo/main", "/work/repo/main-old")).toBe(false);
  expect(contains("/work/repo/main", "/work/repo")).toBe(false);
  // And the case nesting makes routine: feat/test really is inside feat.
  expect(contains("/work/repo/feat", "/work/repo/feat/test")).toBe(true);
});

test("repoNameFromUrl matches what git clone would have picked", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["https://github.com/org/repo.git", "repo"],
    ["https://github.com/org/repo", "repo"],
    ["https://github.com/org/repo/", "repo"],
    ["git@github.com:org/repo.git", "repo"],
    ["ssh://git@host:2222/org/repo.git", "repo"],
    ["file:///tmp/grove-abc/origin.git", "origin"],
    ["/tmp/grove-abc/origin.git", "origin"],
    ["../sibling.git", "sibling"],
  ];

  for (const [url, expected] of cases) {
    expect(repoNameFromUrl(url)).toBe(expected);
  }
});

test("looksLikeRepoUrl rejects an obvious typo before anything is spawned", () => {
  for (const url of [
    "https://github.com/org/repo.git",
    "git@github.com:org/repo.git",
    "ssh://git@host/org/repo.git",
    "file:///tmp/origin.git",
    "/abs/path.git",
    "./rel.git",
    "../rel.git",
  ]) {
    expect(looksLikeRepoUrl(url)).toBe(true);
  }

  for (const url of ["", "repo", "github.com/org/repo", "-not-a-url"]) {
    expect(looksLikeRepoUrl(url)).toBe(false);
  }
});
