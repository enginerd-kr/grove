import { expect, test } from "bun:test";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { buildTree, leavesOf } from "./tree.ts";

function summary(dir: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/repo/${dir}`,
    dir,
    branch: dir,
    detached: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    isDefault: false,
    current: false,
    ...overrides,
  };
}

/** `depth:label` per row, which is the whole shape in one string. */
function shape(summaries: readonly WorktreeSummary[]): string[] {
  return buildTree(summaries).map((row) => `${"  ".repeat(row.depth)}${row.label}`);
}

test("a prefix becomes a folder row, and its worktrees sit under it", () => {
  expect(
    shape([
      summary("feat/work-2"),
      summary("chore/work-1"),
      summary("main", { isDefault: true }),
      summary("feat/work-1"),
      summary("chore/work-2"),
    ]),
  ).toEqual(["main", "chore/", "  work-1", "  work-2", "feat/", "  work-1", "  work-2"]);
});

// Reading order rather than alphabetical: `main` is the row people look for,
// and a folder is a heading, so stepping over one to reach a worktree would be
// backwards.
test("worktrees come before folders, and the default branch before its siblings", () => {
  expect(
    shape([summary("zebra"), summary("feat/a"), summary("main", { isDefault: true })]),
  ).toEqual(["main", "zebra", "feat/", "  a"]);
});

test("nesting goes as deep as the branch does", () => {
  expect(shape([summary("feat/api/v2/login"), summary("feat/api/list")])).toEqual([
    "feat/",
    "  api/",
    "    list",
    "    v2/",
    "      login",
  ]);
});

// The cursor lands on worktrees only; a folder has nothing to sync or remove.
test("leaves are the rows an action can act on", () => {
  const rows = buildTree([summary("main", { isDefault: true }), summary("feat/login")]);

  expect(rows).toHaveLength(3);
  expect(leavesOf(rows).map((leaf) => leaf.summary.dir)).toEqual(["main", "feat/login"]);
});

test("a worktree keeps its own name even where a folder shares it", () => {
  // `feat` and `feat/login` cannot both exist as branches — git calls that a
  // ref D/F conflict — but `--dir` can still produce a directory named after a
  // prefix, and it must not be swallowed by the group it looks like.
  expect(shape([summary("feat"), summary("feat/login")])).toEqual(["feat", "feat/", "  login"]);
});

test("an empty list is an empty tree rather than a stray row", () => {
  expect(buildTree([])).toEqual([]);
});
