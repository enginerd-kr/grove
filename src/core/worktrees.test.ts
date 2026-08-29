import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isGroveError } from "./errors.ts";
import { probeGit, seedGit, withTempRepo } from "./test-utils.ts";
import {
  listWorktrees,
  parseStatus,
  parseWorktreeList,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "./worktrees.ts";

/** `git status -z` terminates every field with a NUL, including the last. */
function zed(...fields: readonly string[]): string {
  return fields.map((field) => `${field}\0`).join("");
}

const OID = "5beccc923160b02a80082e4be0dd27320476f164";
const BLOB = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";

function record(overrides: Partial<WorktreeRecord> & { path: string }): WorktreeRecord {
  return { detached: false, bare: false, ...overrides };
}

describe("parseWorktreeList", () => {
  test("reads the three record shapes git emits", () => {
    const porcelain = [
      `worktree /repos/app/main\nHEAD ${OID}\nbranch refs/heads/main\n`,
      `worktree /repos/app/detached\nHEAD ${OID}\ndetached\n`,
      `worktree /repos/app/feat/login\nHEAD ${OID}\nbranch refs/heads/feat/login\n`,
    ].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/repos/app/main", head: OID, branch: "main", detached: false, bare: false },
      { path: "/repos/app/detached", head: OID, detached: true, bare: false },
      {
        path: "/repos/app/feat/login",
        head: OID,
        branch: "feat/login",
        detached: false,
        bare: false,
      },
    ]);
  });

  test("keeps the bare entry, which callers filter out themselves", () => {
    const records = parseWorktreeList(`worktree /repos/app/.bare\nbare\n`);

    expect(records).toEqual([{ path: "/repos/app/.bare", detached: false, bare: true }]);
  });

  test("only refs/heads/ comes off the branch, not a slash inside the name", () => {
    const records = parseWorktreeList(`worktree /w\nbranch refs/heads/feat/a/b\n`);

    expect(records[0]?.branch).toBe("feat/a/b");
  });

  test("locked and prunable are meaningful with an empty reason", () => {
    const records = parseWorktreeList(
      [
        `worktree /a\nHEAD ${OID}\ndetached\nlocked\n`,
        `worktree /b\nHEAD ${OID}\ndetached\nlocked in use by me\n`,
        `worktree /c\nHEAD ${OID}\ndetached\nprunable gitdir file points to non-existent location\n`,
        `worktree /d\nHEAD ${OID}\ndetached\nprunable\n`,
      ].join("\n"),
    );

    expect(records.map((entry) => [entry.path, entry.locked, entry.prunable])).toEqual([
      ["/a", "", undefined],
      ["/b", "in use by me", undefined],
      ["/c", undefined, "gitdir file points to non-existent location"],
      ["/d", undefined, ""],
    ]);
  });

  test("an absent attribute is undefined, not an empty string", () => {
    const records = parseWorktreeList(`worktree /a\nHEAD ${OID}\nbranch refs/heads/main\n`);

    expect(records[0]?.locked).toBeUndefined();
    expect(records[0]?.prunable).toBeUndefined();
    expect(records[0]?.rebasing).toBeUndefined();
  });

  test("splits paths on the first space only, so a path may contain spaces", () => {
    const records = parseWorktreeList(`worktree /repos/my app/feat one\nHEAD ${OID}\ndetached\n`);

    expect(records[0]?.path).toBe("/repos/my app/feat one");
  });

  test("a trailing newline does not invent an extra record", () => {
    const one = parseWorktreeList(`worktree /a\nHEAD ${OID}\nbranch refs/heads/main\n`);
    const two = parseWorktreeList(`worktree /a\nHEAD ${OID}\nbranch refs/heads/main\n\n`);

    expect(one).toHaveLength(1);
    expect(two).toEqual(one);
  });

  test("extra blank lines between records are just separators", () => {
    const records = parseWorktreeList(`worktree /a\ndetached\n\n\n\nworktree /b\ndetached\n`);

    expect(records.map((entry) => entry.path)).toEqual(["/a", "/b"]);
  });

  test("a block with no worktree line contributes nothing", () => {
    expect(parseWorktreeList(`HEAD ${OID}\nbranch refs/heads/main\n`)).toEqual([]);
  });

  test("unknown attributes are ignored rather than fatal", () => {
    const records = parseWorktreeList(`worktree /a\nHEAD ${OID}\nsomething-new value\ndetached\n`);

    expect(records).toEqual([{ path: "/a", head: OID, detached: true, bare: false }]);
  });

  test("empty and whitespace-only input yield no records", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n")).toEqual([]);
    expect(parseWorktreeList("\n\n  \n\n")).toEqual([]);
  });
});

describe("parseStatus", () => {
  const HEADERS = [`# branch.oid ${OID}`, "# branch.head main"];

  test("a clean worktree with no upstream", () => {
    expect(parseStatus(zed(...HEADERS))).toEqual({
      dirty: false,
      changed: [],
      untracked: [],
      upstream: undefined,
      ahead: 0,
      behind: 0,
    });
  });

  test("empty output is a clean worktree", () => {
    expect(parseStatus("")).toEqual({
      dirty: false,
      changed: [],
      untracked: [],
      upstream: undefined,
      ahead: 0,
      behind: 0,
    });
  });

  test("staged and unstaged changes are both dirty, and both tracked", () => {
    const status = parseStatus(
      zed(
        ...HEADERS,
        `1 M. N... 100644 100644 100644 ${BLOB} ${BLOB} staged.txt`,
        `1 .M N... 100644 100644 100644 ${BLOB} ${BLOB} unstaged.txt`,
        `1 MM N... 100644 100644 100644 ${BLOB} ${BLOB} both.txt`,
      ),
    );

    expect(status.dirty).toBe(true);
    expect(status.changed).toEqual(["staged.txt", "unstaged.txt", "both.txt"]);
    expect(status.untracked).toEqual([]);
  });

  test("untracked files count as changed and are listed separately", () => {
    const status = parseStatus(zed(...HEADERS, "? new.txt", "? sub dir/"));

    expect(status.dirty).toBe(true);
    expect(status.changed).toEqual(["new.txt", "sub dir/"]);
    expect(status.untracked).toEqual(["new.txt", "sub dir/"]);
  });

  test("a rename's original path is not read back as a second entry", () => {
    const status = parseStatus(
      zed(
        ...HEADERS,
        `2 R. N... 100644 100644 100644 ${BLOB} ${BLOB} R100 re named.txt`,
        "a.txt",
        `1 .M N... 100644 100644 100644 ${BLOB} ${BLOB} after.txt`,
      ),
    );

    expect(status.changed).toEqual(["re named.txt", "after.txt"]);
  });

  test("an unmerged entry has three stages before its path", () => {
    const status = parseStatus(
      zed(...HEADERS, `u UU N... 100644 100644 100644 100644 ${BLOB} ${BLOB} ${BLOB} app.txt`),
    );

    expect(status.changed).toEqual(["app.txt"]);
    expect(status.untracked).toEqual([]);
  });

  test("paths keep their spaces, which is the whole point of -z", () => {
    const status = parseStatus(
      zed(
        ...HEADERS,
        `1 .M N... 100644 100644 100644 ${BLOB} ${BLOB} a file with spaces.txt`,
        "? another one.txt",
      ),
    );

    expect(status.changed).toEqual(["a file with spaces.txt", "another one.txt"]);
  });

  test("upstream and divergence come off the branch headers", () => {
    const status = parseStatus(
      zed(...HEADERS, "# branch.upstream origin/main", "# branch.ab +2 -3"),
    );

    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(3);
  });

  test("an upstream with no divergence is still an upstream", () => {
    const status = parseStatus(
      zed(...HEADERS, "# branch.upstream origin/feat/login", "# branch.ab +0 -0"),
    );

    expect(status.upstream).toBe("origin/feat/login");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  test("no upstream leaves the counts at zero", () => {
    const status = parseStatus(zed(...HEADERS, "? new.txt"));

    expect(status.upstream).toBeUndefined();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  test("ignored entries are reported like untracked ones", () => {
    const status = parseStatus(zed(...HEADERS, "! node_modules/"));

    expect(status.changed).toEqual(["node_modules/"]);
    expect(status.untracked).toEqual(["node_modules/"]);
  });
});

describe("worktreeDir", () => {
  test("the root itself is `.`", () => {
    expect(worktreeDir("/repos/app", "/repos/app")).toBe(".");
  });

  test("a nested worktree keeps its whole relative path", () => {
    expect(worktreeDir("/repos/app", "/repos/app/main")).toBe("main");
    expect(worktreeDir("/repos/app", "/repos/app/feat/login")).toBe("feat/login");
  });

  test("a worktree outside the root is honest about being outside it", () => {
    expect(worktreeDir("/repos/app", "/repos/app-feat-login")).toBe("../app-feat-login");
    expect(worktreeDir("/repos/app", "/elsewhere/thing")).toBe("../../elsewhere/thing");
  });
});

describe("resolveTarget", () => {
  const root = "/repos/app";
  const cwd = "/repos/app/main";

  const worktrees: readonly WorktreeRecord[] = [
    record({ path: "/repos/app/main", branch: "main" }),
    record({ path: "/repos/app/feat/login", branch: "feat/login" }),
    record({ path: "/repos/app/spike", detached: true }),
  ];

  test("finds a worktree by its branch name", () => {
    expect(resolveTarget("feat/login", worktrees, { root, cwd }).path).toBe(
      "/repos/app/feat/login",
    );
    expect(resolveTarget("main", worktrees, { root, cwd }).path).toBe("/repos/app/main");
  });

  test("finds a detached worktree by its directory", () => {
    expect(resolveTarget("spike", worktrees, { root, cwd }).path).toBe("/repos/app/spike");
  });

  test("a nested worktree's directory is the whole relative path", () => {
    expect(resolveTarget("feat/login/", worktrees, { root, cwd }).path).toBe(
      "/repos/app/feat/login",
    );
  });

  test("a parent folder is not a worktree", () => {
    expect(() => resolveTarget("feat", worktrees, { root, cwd })).toThrow(
      'no worktree matches "feat"',
    );
  });

  test("finds a worktree by path, absolute or relative to cwd", () => {
    expect(resolveTarget("/repos/app/spike", worktrees, { root, cwd }).path).toBe(
      "/repos/app/spike",
    );
    expect(resolveTarget("../spike", worktrees, { root, cwd }).path).toBe("/repos/app/spike");
  });

  test("the branch wins when a name is also some other worktree's directory", () => {
    const colliding: readonly WorktreeRecord[] = [
      record({ path: "/repos/app/one", branch: "spike" }),
      record({ path: "/repos/app/spike", branch: "two" }),
    ];

    expect(resolveTarget("spike", colliding, { root, cwd }).path).toBe("/repos/app/one");
  });

  test("two worktrees on one branch is ambiguous rather than a coin toss", () => {
    const duplicated: readonly WorktreeRecord[] = [
      record({ path: "/repos/app/a", branch: "main" }),
      record({ path: "/repos/app/b", branch: "main" }),
    ];

    try {
      resolveTarget("main", duplicated, { root, cwd });
      throw new Error("expected resolveTarget to throw");
    } catch (error) {
      if (!isGroveError(error)) throw error;

      expect(error.code).toBe("usage");
      expect(error.message).toContain("matches more than one worktree");
      expect(error.details).toEqual(["/repos/app/a", "/repos/app/b"]);
    }
  });

  test("an unmatched target lists what is actually there", () => {
    try {
      resolveTarget("nope", worktrees, { root, cwd });
      throw new Error("expected resolveTarget to throw");
    } catch (error) {
      if (!isGroveError(error)) throw error;

      expect(error.code).toBe("not-a-repo");
      expect(error.details).toEqual(["main  main", "feat/login  feat/login", "(detached)  spike"]);
    }
  });

  test("nothing matches when there are no worktrees at all", () => {
    expect(() => resolveTarget("main", [], { root, cwd })).toThrow('no worktree matches "main"');
  });
});

describe("against real git", () => {
  test("listWorktrees drops the bare entry and reads the rest", async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const bare = join(work, "app.git");

      await seedGit(work, ["clone", "--bare", originUrl, bare]);
      await seedGit(bare, ["worktree", "add", join(work, "main"), "main"]);
      await seedGit(bare, ["worktree", "add", join(work, "login"), "feat/login"]);
      await seedGit(bare, ["worktree", "add", "--detach", join(work, "spike"), "main"]);

      const records = await listWorktrees(bare);

      expect(records.some((entry) => entry.bare)).toBe(false);
      expect(records.map((entry) => entry.branch ?? "(detached)").sort()).toEqual([
        "(detached)",
        "feat/login",
        "main",
      ]);
      expect(records.filter((entry) => entry.detached)).toHaveLength(1);
      expect(records.every((entry) => (entry.head ?? "").length === 40)).toBe(true);
    });
  });

  test("statusOf reads clean, dirty, untracked and divergence from real output", async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const app = join(work, "app");

      await seedGit(work, ["clone", originUrl, app]);
      expect(await statusOf(app)).toEqual({
        dirty: false,
        changed: [],
        untracked: [],
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
      });

      await seedGit(app, ["reset", "--hard", "HEAD~1"]);
      await Bun.write(join(app, "app.txt"), "two\n");
      await Bun.write(join(app, "new file.txt"), "new\n");
      await seedGit(app, ["add", "app.txt"]);
      await seedGit(app, ["-c", "commit.gpgsign=false", "commit", "-m", "Diverge"]);
      await Bun.write(join(app, "app.txt"), "three\n");

      const status = await statusOf(app);

      expect(status.dirty).toBe(true);
      expect(status.changed).toEqual(["app.txt", "new file.txt"]);
      expect(status.untracked).toEqual(["new file.txt"]);
      expect(status.upstream).toBe("origin/main");
      expect(status.ahead).toBe(1);
      expect(status.behind).toBe(1);
    });
  });

  test("a worktree stopped mid-rebase is reported under the branch being rebased", async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const app = join(work, "app");

      await seedGit(work, ["clone", originUrl, app]);
      await seedGit(app, ["checkout", "-b", "feat/conflict"]);
      await Bun.write(join(app, "app.txt"), "feat\n");
      await seedGit(app, ["add", "-A"]);
      await seedGit(app, ["-c", "commit.gpgsign=false", "commit", "-m", "Feat edit"]);

      await seedGit(app, ["checkout", "main"]);
      await Bun.write(join(app, "app.txt"), "main\n");
      await seedGit(app, ["add", "-A"]);
      await seedGit(app, ["-c", "commit.gpgsign=false", "commit", "-m", "Main edit"]);

      await seedGit(app, ["checkout", "feat/conflict"]);
      // The rebase is meant to stop on the conflict, so its exit code is the point.
      expect((await probeGit(app, ["rebase", "main"])).code).not.toBe(0);

      const records = await listWorktrees(app);
      const stopped = records.find((entry) => entry.path === app);

      expect(stopped?.detached).toBe(true);
      expect(stopped?.rebasing).toBe(true);
      expect(stopped?.branch).toBe("feat/conflict");
    });
  });
});
