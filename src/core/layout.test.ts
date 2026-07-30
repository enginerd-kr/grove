import { expect, test } from "bun:test";
import { WtError } from "./errors.ts";
import { looksLikeRepoUrl, repoNameFromUrl, slugify, worktreeDirName } from "./layout.ts";

test("slugify flattens branch names into directory names", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["feat/login", "feat-login"],
    ["main", "main"],
    ["release/v1.2.0", "release-v1.2.0"],
    ["feature/JIRA-123/add-thing", "feature-JIRA-123-add-thing"],
    ["fix/spaces in name", "fix-spaces-in-name"],
    ["feat/한글", "feat"],
    ["a//b", "a-b"],
    ["--leading", "leading"],
    ["trailing--", "trailing"],
    [".hidden", "hidden"],
  ];

  for (const [branch, expected] of cases) {
    expect(slugify(branch)).toBe(expected);
  }
});

// Lowercasing would map two branches git considers distinct onto one directory,
// inventing a collision that did not exist.
test("slugify preserves case", () => {
  expect(slugify("Feat/Login")).toBe("Feat-Login");
  expect(slugify("Feat/Login")).not.toBe(slugify("feat/login"));
});

test("a branch with no usable characters is a usage error naming --dir", () => {
  for (const branch of ["///", "...", "---", "한글"]) {
    const thrown = (() => {
      try {
        worktreeDirName(branch);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(WtError);
    expect((thrown as WtError).code).toBe("usage");
    expect((thrown as WtError).hint).toContain("--dir");
  }
});

test("--dir must be a single safe segment", () => {
  expect(worktreeDirName("feat/login", "login")).toBe("login");

  // The failure this prevents: a worktree created outside the repo folder,
  // where discovery would never find it again.
  for (const override of ["../elsewhere", "nested/dir", ".bare", ".git", "..", ""]) {
    expect(() => worktreeDirName("feat/login", override)).toThrow(WtError);
  }
});

test("slugs that would collide with repository plumbing are rejected", () => {
  // `.bare` and `.git` survive slugify only as `bare`/`git`, which are safe;
  // this pins that they cannot come back as the dotted originals.
  expect(slugify(".bare")).toBe("bare");
  expect(slugify(".git")).toBe("git");
  expect(worktreeDirName(".bare")).toBe("bare");
});

test("repoNameFromUrl matches what git clone would have picked", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["https://github.com/org/repo.git", "repo"],
    ["https://github.com/org/repo", "repo"],
    ["https://github.com/org/repo/", "repo"],
    ["git@github.com:org/repo.git", "repo"],
    ["ssh://git@host:2222/org/repo.git", "repo"],
    ["file:///tmp/wt-abc/origin.git", "origin"],
    ["/tmp/wt-abc/origin.git", "origin"],
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
