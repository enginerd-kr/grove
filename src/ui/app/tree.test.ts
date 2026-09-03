import { describe, expect, test } from "bun:test";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import {
  buildFileTree,
  buildTree,
  firstChildOf,
  leavesOf,
  parentOf,
  type TreeRow,
} from "./tree.ts";

/**
 * The two folds the screen is made of, without a screen.
 *
 * Everything here is a pure function over a list, so the ordering rules — the
 * part anybody would notice going wrong — are a table of examples rather than a
 * terminal to drive. The fixtures below are the shape `list` hands over: it is
 * `dir` that is folded, not `branch`, because `dir` is where the worktree
 * actually sits and a branch that slugified differently would otherwise be
 * drawn somewhere it is not.
 */

function wt(dir: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/repos/app/${dir}`,
    dir,
    branch: dir,
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
    files: [],
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    setupStale: false,
    isDefault: false,
    current: false,
    ...overrides,
  };
}

/** The three fields a row is drawn from, which is what most of these are about. */
function shape(rows: readonly TreeRow[]): readonly (readonly [string, string, number])[] {
  return rows.map((row) => [row.kind, row.label, row.depth] as const);
}

function labels(rows: readonly { readonly label: string }[]): readonly string[] {
  return rows.map((entry) => entry.label);
}

/** The row at `index`, or a failure that names the index rather than a `!`. */
function at(rows: readonly TreeRow[], index: number): TreeRow {
  const found = rows[index];
  if (found === undefined) throw new Error(`no row at index ${index} of ${rows.length}`);

  return found;
}

/** A folder row's carried worktrees, by directory. Fails loudly on a leaf. */
function carried(row: TreeRow | undefined): readonly string[] {
  if (row?.kind !== "group") throw new Error(`not a folder row: ${row?.label}`);

  return row.leaves.map((leaf) => leaf.dir);
}

describe("a stack inside a folder", () => {
  test("a branch stacked on one in the same folder is drawn one step under it", () => {
    const rows = buildTree([
      wt("main", { isDefault: true }),
      wt("feat/login-api", { parent: "feat/login" }),
      wt("feat/login"),
      wt("feat/search"),
    ]);

    // Under its parent rather than beside it, and the parent keeps its place
    // among the folder's roots. The row says so, so the state column can
    // leave `on feat/login` out.
    expect(shape(rows)).toEqual([
      ["leaf", "main", 0],
      ["group", "feat/", 0],
      ["leaf", "login", 1],
      ["leaf", "login-api", 2],
      ["leaf", "search", 1],
    ]);
    expect(rows.map((row) => row.kind === "leaf" && row.underParent)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  test("a stack three deep nests three deep, and siblings sort alphabetically under their parent", () => {
    const rows = buildTree([
      wt("feat/c", { parent: "feat/a" }),
      wt("feat/b", { parent: "feat/a" }),
      wt("feat/d", { parent: "feat/b" }),
      wt("feat/a"),
    ]);

    expect(shape(rows)).toEqual([
      ["group", "feat/", 0],
      ["leaf", "a", 1],
      ["leaf", "b", 2],
      ["leaf", "d", 3],
      ["leaf", "c", 2],
    ]);
  });

  test("a parent in another folder, or with no worktree, leaves the row where its directory is", () => {
    const rows = buildTree([
      wt("fix/followup", { parent: "feat/login" }),
      wt("feat/login"),
      wt("feat/orphan", { parent: "feat/gone" }),
    ]);

    // Neither is indented, and both keep their `on <parent>` note: the
    // folders are the shape the disk has, and a row moved out of its folder
    // would be drawn somewhere it is not.
    expect(shape(rows)).toEqual([
      ["group", "feat/", 0],
      ["leaf", "login", 1],
      ["leaf", "orphan", 1],
      ["group", "fix/", 0],
      ["leaf", "followup", 1],
    ]);
    expect(rows.every((row) => row.kind === "group" || !row.underParent)).toBe(true);
  });

  test("two branches recorded on each other are both drawn, once, one under the other", () => {
    const rows = buildTree([
      wt("feat/a", { parent: "feat/b" }),
      wt("feat/b", { parent: "feat/a" }),
    ]);

    // Neither is a root, so neither would be reached from one; the loop is
    // broken at the first name and the rest hangs from it, rather than both
    // vanishing from the folder.
    expect(shape(rows)).toEqual([
      ["group", "feat/", 0],
      ["leaf", "a", 1],
      ["leaf", "b", 2],
    ]);
  });

  test("the arrows walk into and out of a stack the way they walk a folder", () => {
    const rows = buildTree([wt("feat/login"), wt("feat/login-api", { parent: "feat/login" })]);
    const [, login, api] = rows;

    expect(firstChildOf(rows, at(rows, 1))).toBe(api);
    expect(parentOf(rows, at(rows, 2))).toBe(login);
  });

  test("a folder still carries every worktree under it, nested or not", () => {
    const rows = buildTree([wt("feat/login"), wt("feat/login-api", { parent: "feat/login" })]);

    expect(carried(rows[0])).toEqual(["feat/login", "feat/login-api"]);
  });
});

describe("buildTree", () => {
  test("a branch with no slash is one leaf at the top level", () => {
    const main = wt("main", { isDefault: true });

    expect(buildTree([main])).toEqual([
      {
        kind: "leaf",
        key: "/repos/app/main",
        label: "main",
        depth: 0,
        summary: main,
        underParent: false,
      },
    ]);
  });

  test("branches sharing a prefix are drawn under one folder", () => {
    const rows = buildTree([wt("feat/login"), wt("main", { isDefault: true }), wt("feat/search")]);

    expect(shape(rows)).toEqual([
      ["leaf", "main", 0],
      ["group", "feat/", 0],
      ["leaf", "login", 1],
      ["leaf", "search", 1],
    ]);
  });

  test("the trunk leads its level, then worktrees alphabetically, then folders", () => {
    const rows = buildTree([
      wt("zeta"),
      wt("chore/tidy"),
      wt("alpha"),
      wt("main", { isDefault: true }),
    ]);

    expect(shape(rows)).toEqual([
      ["leaf", "main", 0],
      ["leaf", "alpha", 0],
      ["leaf", "zeta", 0],
      ["group", "chore/", 0],
      ["leaf", "tidy", 1],
    ]);
  });

  test("the same rule applies inside a folder, not only at the root", () => {
    const rows = buildTree([wt("feat/zeta"), wt("feat/nested/deep"), wt("feat/alpha")]);

    expect(shape(rows)).toEqual([
      ["group", "feat/", 0],
      ["leaf", "alpha", 1],
      ["leaf", "zeta", 1],
      ["group", "nested/", 1],
      ["leaf", "deep", 2],
    ]);
  });

  test("every segment of a deep name is a folder of its own, keyed by its whole path", () => {
    const rows = buildTree([wt("a/b/c/d")]);

    expect(shape(rows)).toEqual([
      ["group", "a/", 0],
      ["group", "b/", 1],
      ["group", "c/", 2],
      ["leaf", "d", 3],
    ]);
    expect(rows.map((row) => row.key)).toEqual(["a/", "a/b/", "a/b/c/", "/repos/app/a/b/c/d"]);
  });

  test("a folder whose name is also a branch keeps both rows", () => {
    const rows = buildTree([wt("feat"), wt("feat/login")]);

    expect(shape(rows)).toEqual([
      ["leaf", "feat", 0],
      ["group", "feat/", 0],
      ["leaf", "login", 1],
    ]);
    // Distinct keys, or React would be told two different rows are one row.
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  test("two branches with the same last segment are told apart by their key", () => {
    const rows = leavesOf(buildTree([wt("feat/login"), wt("fix/login")]));

    expect(labels(rows)).toEqual(["login", "login"]);
    expect(rows.map((row) => row.key)).toEqual(["/repos/app/feat/login", "/repos/app/fix/login"]);
  });

  test("no worktrees is no rows", () => {
    expect(buildTree([])).toEqual([]);
  });

  test("a worktree with no path under the root is kept rather than dropped", () => {
    // `insert` has a branch for exactly this, because dropping it would hide a
    // worktree that git is still reporting.
    const rows = buildTree([wt(""), wt(".")]);

    expect(shape(rows)).toEqual([
      ["leaf", "", 0],
      ["leaf", ".", 0],
    ]);
  });

  test("a folder carries every worktree beneath it, at any depth", () => {
    const rows = buildTree([wt("feat/login"), wt("feat/deep/search"), wt("main")]);
    expect(carried(rows.find((row) => row.kind === "group"))).toEqual([
      "feat/login",
      "feat/deep/search",
    ]);
  });

  test("a collapsed folder drops its rows and keeps its worktrees on the row", () => {
    const summaries = [wt("feat/login"), wt("feat/deep/search"), wt("main")];
    const rows = buildTree(summaries, new Set(["feat/"]));

    expect(shape(rows)).toEqual([
      ["leaf", "main", 0],
      ["group", "feat/", 0],
    ]);

    expect(at(rows, 1)).toMatchObject({ collapsed: true });
    // Folding must not change what a key acting on the folder would remove.
    expect(carried(at(rows, 1))).toEqual(["feat/login", "feat/deep/search"]);
  });

  test("an expanded folder says so, rather than leaving the flag off", () => {
    const rows = buildTree([wt("feat/login")]);

    expect(rows[0]).toMatchObject({ kind: "group", key: "feat/", collapsed: false });
  });

  test("a folder folded inside a folded one is still folded when the outer opens", () => {
    const summaries = [wt("a/x"), wt("a/b/y")];
    const shut = buildTree(summaries, new Set(["a/", "a/b/"]));

    expect(shape(shut)).toEqual([["group", "a/", 0]]);

    const opened = buildTree(summaries, new Set(["a/b/"]));

    expect(shape(opened)).toEqual([
      ["group", "a/", 0],
      ["leaf", "x", 1],
      ["group", "b/", 1],
    ]);
    expect(opened[2]).toMatchObject({ collapsed: true });
  });

  test("a collapsed key that matches nothing folds nothing", () => {
    const rows = buildTree([wt("feat/login")], new Set(["feat", "fix/", "feat/login"]));

    expect(shape(rows)).toEqual([
      ["group", "feat/", 0],
      ["leaf", "login", 1],
    ]);
  });
});

describe("leavesOf", () => {
  test("only the worktrees, in the order they are drawn", () => {
    const rows = buildTree([wt("feat/login"), wt("main", { isDefault: true }), wt("feat/search")]);

    expect(labels(leavesOf(rows))).toEqual(["main", "login", "search"]);
  });

  test("a folded folder's worktrees are not on screen, so they are not leaves", () => {
    const rows = buildTree([wt("feat/login"), wt("main")], new Set(["feat/"]));

    expect(labels(leavesOf(rows))).toEqual(["main"]);
  });

  test("no rows is no leaves, and a tree of nothing but folders has none either", () => {
    expect(leavesOf([])).toEqual([]);
    expect(leavesOf(buildTree([wt("a/b/c")], new Set(["a/"])))).toEqual([]);
  });
});

describe("firstChildOf", () => {
  const rows = buildTree([wt("main"), wt("a/x"), wt("a/b/y")]);

  test("a folder's first child is the row nested directly under it", () => {
    const group = at(rows, 1);

    expect(group.label).toBe("a/");
    expect(firstChildOf(rows, group)?.label).toBe("x");
  });

  test("a worktree has nothing under it", () => {
    const leaf = at(rows, 0);

    expect(leaf.label).toBe("main");
    expect(firstChildOf(rows, leaf)).toBeUndefined();
  });

  test("the last row has nothing after it at all", () => {
    const last = at(rows, rows.length - 1);

    expect(last.label).toBe("y");
    expect(firstChildOf(rows, last)).toBeUndefined();
  });

  test("a folded folder is the dead end it looks like", () => {
    const folded = buildTree([wt("feat/login"), wt("main")], new Set(["feat/"]));

    expect(carried(at(folded, 1))).toHaveLength(1);
    expect(firstChildOf(folded, at(folded, 1))).toBeUndefined();
  });

  test("a row from another list has no child in this one", () => {
    const other = buildTree([wt("elsewhere")]);

    expect(firstChildOf(rows, at(other, 0))).toBeUndefined();
  });
});

describe("parentOf", () => {
  const rows = buildTree([wt("main"), wt("a/x"), wt("a/b/y")]);

  test("a worktree's parent is the folder it is drawn under", () => {
    const leaf = at(rows, 2);

    expect(leaf.label).toBe("x");
    expect(parentOf(rows, leaf)?.label).toBe("a/");
  });

  test("the nearest row one level out, not merely the row above", () => {
    const deep = at(rows, 4);

    expect(deep.label).toBe("y");
    expect(parentOf(rows, deep)?.label).toBe("b/");
    expect(parentOf(rows, at(rows, 3))?.label).toBe("a/");
  });

  test("a top-level row has no parent, folder or worktree", () => {
    expect(parentOf(rows, at(rows, 0))).toBeUndefined();
    expect(parentOf(rows, at(rows, 1))).toBeUndefined();
  });

  test("a folded folder still walks out to the folder holding it", () => {
    const folded = buildTree([wt("a/x"), wt("a/b/y")], new Set(["a/b/"]));
    const inner = at(folded, 2);

    expect(inner).toMatchObject({ label: "b/", collapsed: true });
    expect(parentOf(folded, inner)?.label).toBe("a/");
  });

  test("a row from another list has no parent in this one", () => {
    const other = buildTree([wt("other/thing")]);

    expect(parentOf(rows, at(other, 1))).toBeUndefined();
  });
});

describe("buildFileTree", () => {
  test("a flat list stays flat, ordered the way a reader would sort it", () => {
    // `localeCompare`, so case is a tiebreak rather than the whole sort — an
    // ASCII sort would file every capitalised name above every lowercase one.
    expect(buildFileTree(["README.md", "app.txt", "Makefile"])).toEqual([
      { kind: "leaf", key: "app.txt", label: "app.txt", depth: 0 },
      { kind: "leaf", key: "Makefile", label: "Makefile", depth: 0 },
      { kind: "leaf", key: "README.md", label: "README.md", depth: 0 },
    ]);
  });

  test("files sharing a directory name it once", () => {
    const rows = buildFileTree(["src/b.ts", "src/a.ts"]);

    expect(rows).toEqual([
      { kind: "group", key: "src/", label: "src/", depth: 0 },
      { kind: "leaf", key: "src/a.ts", label: "a.ts", depth: 1 },
      { kind: "leaf", key: "src/b.ts", label: "b.ts", depth: 1 },
    ]);
  });

  test("a change confined to one directory reads as one heading and its files", () => {
    const rows = buildFileTree([
      "src/ui/app/App.tsx",
      "src/ui/app/tree.ts",
      "src/ui/app/service.ts",
    ]);

    expect(rows.filter((row) => row.kind === "group").map((row) => row.key)).toEqual([
      "src/",
      "src/ui/",
      "src/ui/app/",
    ]);
    expect(rows.filter((row) => row.kind === "leaf").map((row) => row.label)).toEqual([
      "App.tsx",
      "service.ts",
      "tree.ts",
    ]);
    expect(rows.at(-1)?.depth).toBe(3);
  });

  test("nested directories nest, and files come before them at each level", () => {
    expect(buildFileTree(["src/ui/App.tsx", "src/index.ts", "README.md"])).toEqual([
      { kind: "leaf", key: "README.md", label: "README.md", depth: 0 },
      { kind: "group", key: "src/", label: "src/", depth: 0 },
      { kind: "leaf", key: "src/index.ts", label: "index.ts", depth: 1 },
      { kind: "group", key: "src/ui/", label: "ui/", depth: 1 },
      { kind: "leaf", key: "src/ui/App.tsx", label: "App.tsx", depth: 2 },
    ]);
  });

  test("git's trailing slash on an unwalked directory is kept, and is still one leaf", () => {
    expect(buildFileTree(["node_modules/", "src/build/"])).toEqual([
      { kind: "leaf", key: "node_modules/", label: "node_modules/", depth: 0 },
      { kind: "group", key: "src/", label: "src/", depth: 0 },
      { kind: "leaf", key: "src/build/", label: "build/", depth: 1 },
    ]);
  });

  test("paths keep their spaces, which is what `git status -z` went to the trouble of", () => {
    expect(buildFileTree(["my dir/a file.txt"])).toEqual([
      { kind: "group", key: "my dir/", label: "my dir/", depth: 0 },
      { kind: "leaf", key: "my dir/a file.txt", label: "a file.txt", depth: 1 },
    ]);
  });

  test("the same file name in two directories keeps two keys", () => {
    const rows = buildFileTree(["a/index.ts", "b/index.ts"]);

    expect(rows.filter((row) => row.kind === "leaf").map((row) => row.key)).toEqual([
      "a/index.ts",
      "b/index.ts",
    ]);
  });

  test("one file at the root is one row", () => {
    expect(buildFileTree(["app.txt"])).toEqual([
      { kind: "leaf", key: "app.txt", label: "app.txt", depth: 0 },
    ]);
  });

  test("nothing changed is no rows", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  test("a path that names nothing contributes nothing", () => {
    expect(buildFileTree(["", "/"])).toEqual([]);
  });
});
