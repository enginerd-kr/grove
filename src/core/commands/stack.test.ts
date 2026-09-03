import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  attempt,
  managedRepo,
  recorder,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { formatStack, type StackResult, type StackRow, stackOf } from "./stack.ts";

/**
 * `grove stack` against a real repository.
 *
 * The records are written by `add --on`, the drift is git's own count, and
 * what is asserted is the whole result: which branches are in the picture, in
 * what order, under whom, and how far each has moved from its base. The
 * drawing is checked apart, over rows written by hand, because the guides are
 * the part with rules in it and none of them need a repository.
 */

/** A worktree cut from the trunk, or stacked `--on` another. */
async function branch(repo: Awaited<ReturnType<typeof managedRepo>>, name: string, on?: string) {
  const result = await addWorktree(
    repo,
    repo.root,
    { branch: name, on, fetch: false, push: false, setup: false, trust: false, take: false },
    recorder().reporter,
  );

  return result.path;
}

async function commit(worktree: string, file: string): Promise<void> {
  await Bun.write(join(worktree, file), `${file}\n`);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

/** The fields a picture is drawn from, which is what most of these are about. */
function shape(result: StackResult): readonly string[] {
  return result.rows.map(
    (row) =>
      `${"  ".repeat(row.depth)}${row.branch}${row.current ? " *" : ""} <- ${row.parent ?? "-"} ${
        row.ahead ?? "?"
      }/${row.behind ?? "?"}`,
  );
}

describe("what the stack says", () => {
  test("the trunk at the top, each branch under the one it sits on, and the drift against that one", async () => {
    await withTempRepo(async (temp: TempRepo) => {
      const repo = await managedRepo(temp);
      const login = await branch(repo, "feat/login");
      await commit(login, "login.txt");
      await commit(login, "login2.txt");
      const api = await branch(repo, "feat/login-api", "feat/login");
      await commit(api, "api.txt");
      // The parent moves on after the child was cut: the child is now behind it.
      await commit(login, "login3.txt");
      const ui = await branch(repo, "feat/login-ui", "feat/login");
      await commit(ui, "ui.txt");
      await seedWorktree(repo, "fix/crash");

      const result = succeeded(await attempt(() => stackOf(repo, api, { all: false })));

      // Asked from inside `feat/login-api`: its stack is the tree under
      // `feat/login`, and `fix/crash` is nobody's business here.
      expect(result.trunk).toBe("main");
      // `feat/login` is the fixture's own branch, one commit up on the trunk
      // before the three made here.
      expect(shape(result)).toEqual([
        "main <- - ?/?",
        "  feat/login <- main 4/0",
        "    feat/login-api * <- feat/login 1/1",
        "    feat/login-ui <- feat/login 1/0",
      ]);

      // The whole of one row: the worktree beside the branch, for `--json`.
      expect(result.rows[2]).toEqual({
        branch: "feat/login-api",
        parent: "feat/login",
        depth: 2,
        dir: "feat/login-api",
        path: api,
        ahead: 1,
        behind: 1,
        exists: true,
        current: true,
      });

      // From the parent, the same picture — a stack is one thing wherever it
      // is asked about from.
      expect(shape(succeeded(await attempt(() => stackOf(repo, login, { all: false }))))).toEqual(
        shape(result)
          .map((line) => line.replace(" *", ""))
          .map((line, at) => (at === 1 ? line.replace("feat/login <-", "feat/login * <-") : line)),
      );
    });
  }, 60_000);

  test("--all draws every stack, and leaves the unstacked branches out", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await branch(repo, "feat/a");
      await branch(repo, "feat/b", "feat/a");
      await branch(repo, "fix/one");
      await branch(repo, "fix/two", "fix/one");
      await seedWorktree(repo, "chore/alone");

      const result = succeeded(await attempt(() => stackOf(repo, repo.root, { all: true })));

      expect(result.rows.map((row) => `${row.depth}:${row.branch}`)).toEqual([
        "0:main",
        "1:feat/a",
        "2:feat/b",
        "1:fix/one",
        "2:fix/two",
      ]);
      expect(result.rows.some((row) => row.branch === "chore/alone")).toBe(false);
    });
  }, 60_000);

  test("an unstacked branch is itself under the trunk, and the trunk alone is the trunk", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "chore/alone");

      const alone = succeeded(
        await attempt(() => stackOf(repo, repo.root, { target: "chore/alone", all: false })),
      );
      expect(alone.rows.map((row) => row.branch)).toEqual(["main", "chore/alone"]);

      const trunk = succeeded(
        await attempt(() => stackOf(repo, repo.root, { target: "main", all: false })),
      );
      expect(trunk.rows.map((row) => row.branch)).toEqual(["main"]);
    });
  }, 60_000);

  test("a branch in the stack without a worktree, and one the repository has lost, are both drawn", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await branch(repo, "feat/a");
      await branch(repo, "feat/b", "feat/a");
      await branch(repo, "feat/c", "feat/b");

      // `feat/a` keeps its branch and loses its worktree: still the bottom of
      // the stack, still a base, and drawn as one with nowhere to stand.
      await seedGit(repo.root, ["worktree", "remove", join(repo.root, "feat", "a")]);
      const kept = succeeded(
        await attempt(() => stackOf(repo, repo.root, { target: "feat/c", all: false })),
      );
      expect(kept.rows.map((row) => [row.branch, row.exists, row.dir, row.ahead])).toEqual([
        ["main", true, "main", undefined],
        ["feat/a", true, undefined, 0],
        ["feat/b", true, "feat/b", 0],
        ["feat/c", true, "feat/c", 0],
      ]);

      // Then the branch itself goes. `feat/b`'s record still names it — the
      // record is in `feat/b`'s own section, which the deletion did not touch
      // — so the picture keeps the name, says it is gone, and has no drift to
      // count against it.
      await seedGit(repo.gitDir, ["branch", "-D", "feat/a"]);
      const lost = succeeded(
        await attempt(() => stackOf(repo, repo.root, { target: "feat/c", all: false })),
      );
      expect(lost.rows.map((row) => [row.branch, row.exists, row.dir, row.ahead])).toEqual([
        ["main", true, "main", undefined],
        ["feat/a", false, undefined, undefined],
        ["feat/b", true, "feat/b", undefined],
        ["feat/c", true, "feat/c", 0],
      ]);
    });
  }, 60_000);

  test("outside every worktree, with no target, it says so and names --all", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const error = refused(await attempt(() => stackOf(repo, repo.root, { all: false })));

      expect(error.code).toBe("usage");
      expect(error.message).toBe("not inside a worktree, so there is no stack to show");
      expect(error.hint).toContain("--all");
    });
  }, 60_000);
});

describe("how it is drawn", () => {
  function row(branch: string, depth: number, overrides: Partial<StackRow> = {}): StackRow {
    return {
      branch,
      depth,
      parent: depth === 0 ? undefined : "x",
      dir: branch,
      path: `/repo/${branch}`,
      ahead: 1,
      behind: 0,
      exists: true,
      current: false,
      ...overrides,
    };
  }

  test("tree guides, the marker, the worktree, and the drift line up in columns", () => {
    const drawn = formatStack({
      trunk: "main",
      rows: [
        row("main", 0, { ahead: undefined, behind: undefined }),
        row("feat/login", 1, { ahead: 2, current: true }),
        row("feat/login-api", 2, { behind: 1 }),
        row("feat/login-ui", 2, { dir: undefined, path: undefined }),
        row("fix/crash", 1, { exists: false, dir: undefined, ahead: undefined, behind: undefined }),
      ],
    });

    expect(drawn).toBe(
      [
        "main",
        "├─ feat/login *       feat/login      ↑2 ↓0",
        "│  ├─ feat/login-api  feat/login-api  ↑1 ↓1",
        "│  └─ feat/login-ui   no worktree     ↑1 ↓0",
        "└─ fix/crash          gone",
      ].join("\n"),
    );
  });

  test("a guide is dropped under the last child, and kept under one with siblings to come", () => {
    const drawn = formatStack({
      trunk: "main",
      rows: [row("main", 0), row("a", 1), row("b", 2), row("c", 3), row("d", 1), row("e", 2)],
    });

    // The guide and the name: everything before the first gap that is not
    // inside a guide, which a guide's own two spaces are.
    expect(drawn.split("\n").map((line) => line.split(/\s{2,}(?=[^│├└\s]|$)/)[0])).toEqual([
      "main",
      "├─ a",
      "│  └─ b",
      "│     └─ c",
      "└─ d",
      "   └─ e",
    ]);
  });
});
