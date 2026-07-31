import { expect, test } from "bun:test";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { buildTree, leavesOf, parentOf } from "./tree.ts";

function summary(dir: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/repo/${dir}`,
    dir,
    branch: dir,
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
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

test("a folded folder keeps its row and loses the rows under it", () => {
  const summaries = [summary("main", { isDefault: true }), summary("feat/a"), summary("feat/b")];

  expect(shape(summaries)).toEqual(["main", "feat/", "  a", "  b"]);
  expect(
    buildTree(summaries, new Set(["feat/"])).map((row) => `${"  ".repeat(row.depth)}${row.label}`),
  ).toEqual(["main", "feat/"]);
});

// The failure this prevents: `r` on a folded folder finding nothing to remove,
// because what it removes was read off rows that folding had taken away.
test("a folder knows what it holds whether it is folded or not", () => {
  const summaries = [summary("feat/api/v2"), summary("feat/login")];

  for (const collapsed of [new Set<string>(), new Set(["feat/"]), new Set(["feat/api/"])]) {
    const feat = buildTree(summaries, collapsed).find((row) => row.key === "feat/");

    expect(feat?.kind === "group" && feat.leaves.map((leaf) => leaf.dir).toSorted()).toEqual([
      "feat/api/v2",
      "feat/login",
    ]);
  }
});

// Folding an outer folder must not forget what was folded inside it, or opening
// it again would spill rows the user had already put away.
test("a fold inside a fold survives the outer one opening again", () => {
  const summaries = [summary("feat/api/v2"), summary("feat/login")];
  const collapsed = new Set(["feat/", "feat/api/"]);

  expect(buildTree(summaries, collapsed).map((row) => row.label)).toEqual(["feat/"]);

  const reopened = buildTree(summaries, new Set(["feat/api/"]));
  expect(reopened.map((row) => row.label)).toEqual(["feat/", "login", "api/"]);
  expect(reopened.find((row) => row.key === "feat/api/")?.kind === "group").toBe(true);
});

test("parentOf walks out one level, and stops at the top", () => {
  const rows = buildTree([summary("main", { isDefault: true }), summary("feat/api/v2")]);
  const byLabel = (label: string) => rows.find((row) => row.label === label);

  const v2 = byLabel("v2");
  const api = byLabel("api/");

  expect(v2 && parentOf(rows, v2)).toBe(api);
  expect(api && parentOf(rows, api)?.label).toBe("feat/");
  // `main` and `feat/` are both at the top; there is nothing to walk out to.
  const main = byLabel("main");
  expect(main && parentOf(rows, main)).toBeUndefined();
});
