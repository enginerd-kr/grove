import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { isGroveError } from "./errors.ts";
import {
  BARE_DIR,
  contains,
  GIT_FILE_CONTENTS,
  looksLikeRepoUrl,
  plainRepoPaths,
  repoNameFromUrl,
  repoPaths,
  slugifySegment,
  worktreePathFor,
  worktreeRelPath,
} from "./layout.ts";

/** The `usage` GroveError these functions throw, or a failure if nothing was thrown. */
function usageErrorFrom(body: () => unknown): { code: string; message: string } {
  try {
    body();
  } catch (error) {
    if (!isGroveError(error)) throw error;
    return { code: error.code, message: error.message };
  }

  throw new Error("expected a GroveError, but the call returned");
}

describe("slugifySegment", () => {
  const CASES: [string, string][] = [
    ["main", "main"],
    ["JIRA-123", "JIRA-123"],
    ["with_underscore", "with_underscore"],
    ["v1.2.3", "v1.2.3"],
    // Case survives: git treats `Feat` and `feat` as two branches, so two
    // directories is the honest answer.
    ["Feat", "Feat"],
    ["feat login", "feat-login"],
    ["feat  login", "feat-login"],
    ["feat@#$login", "feat-login"],
    ["a--b", "a-b"],
    ["a-@-b", "a-b"],
    ["-lead", "lead"],
    ["trail-", "trail"],
    [".hidden", "hidden"],
    ["dot.", "dot"],
    ["-.a.-", "a"],
    ["café", "caf"],
    ["café-au-lait", "caf-au-lait"],
    // A slash means nothing here; splitting on it is `worktreeRelPath`'s job.
    ["feat/login", "feat-login"],
  ];

  test("sanitises one segment at a time", () => {
    expect(CASES.map(([input]) => [input, slugifySegment(input)])).toEqual(CASES);
  });

  test("has nothing to keep in a segment of punctuation", () => {
    for (const degenerate of ["", ".", "..", "...", "-", "---", ".-.", "   ", "@@@"]) {
      expect(slugifySegment(degenerate)).toBe("");
    }
  });
});

describe("worktreeRelPath", () => {
  const CASES: [string, string][] = [
    ["main", "main"],
    // The branch's shape is kept, so the tree on disk mirrors `refs/heads`.
    ["feat/login", "feat/login"],
    ["a/b/c/d", "a/b/c/d"],
    ["feat/JIRA-123 login!", "feat/JIRA-123-login"],
    ["feat//login", "feat/login"],
    ["/feat/login/", "feat/login"],
    ["feat/", "feat"],
  ];

  test("maps a branch to a directory below the root", () => {
    expect(CASES.map(([branch]) => [branch, worktreeRelPath(branch)])).toEqual(CASES);
  });

  const ESCAPES: [string, string][] = [
    ["../evil", "evil"],
    ["../../evil", "evil"],
    ["a/../../b", "a/b"],
    ["a/./b", "a/b"],
    ["/etc/passwd", "etc/passwd"],
    ["~/.ssh/authorized_keys", "ssh/authorized_keys"],
    ["..evil", "evil"],
    // Leading dots are stripped, so the plumbing names cannot be reproduced.
    [".git", "git"],
    [".bare", "bare"],
    ["feat/../.bare", "feat/bare"],
  ];

  test("cannot be talked into a path that leaves the root", () => {
    expect(ESCAPES.map(([branch]) => [branch, worktreeRelPath(branch)])).toEqual(ESCAPES);

    for (const [branch] of ESCAPES) {
      const rel = worktreeRelPath(branch);

      expect(isAbsolute(rel)).toBe(false);
      expect(rel.split("/")).not.toContain("..");
      expect(rel.split("/")).not.toContain(".");
      expect(rel.split("/")).not.toContain(BARE_DIR);
      expect(rel.split("/")).not.toContain(".git");
    }
  });

  test("refuses a branch name with nothing usable in it", () => {
    for (const branch of ["", "..", "...", "/", "//", "---", "./..", "   "]) {
      const error = usageErrorFrom(() => worktreeRelPath(branch));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("cannot derive a directory");
      expect(error.message).toContain(JSON.stringify(branch));
    }
  });
});

describe("repoPaths", () => {
  test("a managed repository keeps its clone in .bare behind a .git pointer", () => {
    expect(repoPaths("/repos/app")).toEqual({
      root: "/repos/app",
      gitDir: "/repos/app/.bare",
      gitFile: "/repos/app/.git",
      kind: "managed",
    });
  });

  test("a plain repository's git dir and git file are the same directory", () => {
    const plain = plainRepoPaths("/repos/app");

    expect(plain).toEqual({
      root: "/repos/app",
      gitDir: "/repos/app/.git",
      gitFile: "/repos/app/.git",
      kind: "plain",
    });
    expect(plain.gitDir).toBe(plain.gitFile);
  });

  test("only the managed layout separates the pointer from the clone", () => {
    const managed = repoPaths("/repos/app");

    expect(managed.gitDir).not.toBe(managed.gitFile);
    expect(BARE_DIR).toBe(".bare");
  });

  test("the .git pointer is relative, so the repo folder can be moved", () => {
    expect(GIT_FILE_CONTENTS).toBe("gitdir: ./.bare\n");
    expect(GIT_FILE_CONTENTS).toContain(`./${BARE_DIR}`);
    expect(GIT_FILE_CONTENTS.endsWith("\n")).toBe(true);
  });
});

describe("worktreePathFor", () => {
  test("a managed repository nests worktrees inside the root", () => {
    const repo = repoPaths("/repos/app");

    expect(worktreePathFor(repo, "main")).toBe("/repos/app/main");
    expect(worktreePathFor(repo, "feat/login")).toBe("/repos/app/feat/login");
    expect(worktreePathFor(repo, "a/b/c")).toBe("/repos/app/a/b/c");
  });

  test("a plain repository puts them beside itself, prefixed with its own name", () => {
    const repo = plainRepoPaths("/repos/app");

    expect(worktreePathFor(repo, "hotfix")).toBe("/repos/app-hotfix");
    expect(worktreePathFor(repo, "feat/login")).toBe("/repos/app-feat-login");
    expect(worktreePathFor(repo, "a/b/c")).toBe("/repos/app-a-b-c");
  });

  test("sanitising happens before the layout choice, in both kinds", () => {
    expect(worktreePathFor(repoPaths("/repos/app"), "../evil")).toBe("/repos/app/evil");
    expect(worktreePathFor(plainRepoPaths("/repos/app"), "../evil")).toBe("/repos/app-evil");

    expect(usageErrorFrom(() => worktreePathFor(repoPaths("/repos/app"), "..")).code).toBe("usage");
    expect(usageErrorFrom(() => worktreePathFor(plainRepoPaths("/repos/app"), "..")).code).toBe(
      "usage",
    );
  });
});

describe("contains", () => {
  test("a directory contains itself and everything below it", () => {
    expect(contains("/a/b", "/a/b")).toBe(true);
    expect(contains("/a/b", "/a/b/c")).toBe(true);
    expect(contains("/a/b", "/a/b/c/d/e")).toBe(true);
    expect(contains("/", "/a")).toBe(true);
  });

  test("a directory does not contain its parent or its siblings", () => {
    expect(contains("/a/b", "/a")).toBe(false);
    expect(contains("/a/b", "/a/c")).toBe(false);
    expect(contains("/a/b", "/x/y")).toBe(false);
  });

  test("a shared prefix is not containment", () => {
    expect(contains("/a/foo", "/a/foobar")).toBe(false);
    expect(contains("/a/foobar", "/a/foo")).toBe(false);
    expect(contains("/repos/app", "/repos/app-feat-login")).toBe(false);
  });

  test("relative paths are compared the same way", () => {
    expect(contains("a", "a/b")).toBe(true);
    expect(contains("a", "ab")).toBe(false);
    expect(contains(".", "b")).toBe(true);
  });
});

describe("looksLikeRepoUrl", () => {
  const URLS: readonly string[] = [
    "https://github.com/org/repo.git",
    "http://example.com/repo",
    "HTTPS://github.com/org/repo",
    "ssh://git@github.com/org/repo.git",
    "git://example.com/repo.git",
    "file:///tmp/origin.git",
    "git+ssh://host/repo",
    "git@github.com:org/repo.git",
    "user@host.example:repo",
    "/abs/path/repo.git",
    "./relative",
    "../sibling",
    "~/repos/app",
  ];

  const NOT_URLS: readonly string[] = [
    "",
    "repo",
    "org/repo",
    "not a url",
    "https:/github.com/org/repo",
    "github.com/org/repo",
    "-",
    "1://x",
  ];

  test("accepts the shapes git can clone", () => {
    expect(URLS.map((url) => [url, looksLikeRepoUrl(url)])).toEqual(URLS.map((url) => [url, true]));
  });

  test("rejects what is plainly not one", () => {
    expect(NOT_URLS.map((url) => [url, looksLikeRepoUrl(url)])).toEqual(
      NOT_URLS.map((url) => [url, false]),
    );
  });
});

describe("repoNameFromUrl", () => {
  const CASES: [string, string][] = [
    ["https://github.com/org/repo.git", "repo"],
    ["https://github.com/org/repo", "repo"],
    ["https://github.com/org/repo/", "repo"],
    ["https://github.com/org/repo.git/", "repo"],
    ["https://github.com/org/repo.GIT", "repo"],
    ["https://github.com/org/group/sub/repo.git", "repo"],
    ["https://github.com/org/repo.git?ref=main", "repo"],
    ["https://github.com/org/repo.git#tag", "repo"],
    ["git@github.com:org/repo.git", "repo"],
    ["git@github.com:repo.git", "repo"],
    ["ssh://git@github.com/org/repo.git", "repo"],
    ["file:///tmp/origin.git", "origin"],
    ["/abs/path/my-app", "my-app"],
    ["../sibling/app.git", "app"],
  ];

  test("picks the directory name git clone would have picked", () => {
    expect(CASES.map(([url]) => [url, repoNameFromUrl(url)])).toEqual(CASES);
  });

  test("refuses a URL with no name left once .git comes off", () => {
    for (const url of ["", ".git", "https://host/org/.git", "https://host/org/..git", "/"]) {
      const error = usageErrorFrom(() => repoNameFromUrl(url));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("cannot derive a directory name");
    }
  });
});
