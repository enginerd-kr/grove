import { describe, expect, test } from "bun:test";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { Line } from "../../report/lines.ts";
import { statusBarRows } from "../components/StatusBar.tsx";
import { columnWidths, GAP, hintsFor, type LayoutMode, regionsFor } from "./layout.ts";
import type { Message } from "./message.ts";
import { buildTree, type TreeRow } from "./tree.ts";

/**
 * The screen's arithmetic, without a screen.
 *
 * All of this used to live inside `App`, where the only way to ask "what does
 * the budget come to at 40×10?" was to open a terminal that size and count the
 * rows by eye — which is why the two things checked hardest here went wrong
 * unnoticed: a column sized from a `Date.now()` the memo had stopped
 * re-reading, and a set of region heights nobody could add up. Out here they
 * are numbers in and numbers out, so the sizes nobody has are as cheap to
 * check as the one on the desk.
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

function line(id: number): Line {
  return { kind: "info", id, text: `line ${id}` };
}

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A grove with a folder in it, a dirty row, and a row with somewhere to push. */
const SUMMARIES: readonly WorktreeSummary[] = [
  wt("main", { isDefault: true, current: true, touched: NOW - 30 * MINUTE }),
  wt("feat/login", {
    upstream: "origin/feat/login",
    ahead: 2,
    behind: 1,
    trunk: { ahead: 3, behind: 4 },
    dirty: true,
    changed: 3,
    untracked: 1,
    touched: NOW - 2 * HOUR,
  }),
  wt("feat/signup", { upstream: "origin/feat/signup", trunk: { ahead: 0, behind: 0 } }),
  wt("chore/old", { finished: "merged", touched: NOW - 3 * DAY }),
];

const TREE = buildTree(SUMMARIES, new Set());

/** Everything `regionsFor` needs, with the parts a case is not about held still. */
function input(overrides: Partial<Parameters<typeof regionsFor>[0]> = {}) {
  return {
    terminalRows: 30,
    columns: 100,
    hints: hintsFor("list", TREE[0]),
    mode: { kind: "list" } as LayoutMode,
    message: undefined,
    lines: [] as readonly Line[],
    logOn: true,
    tree: TREE,
    index: 0,
    labelled: true,
    ...overrides,
  };
}

/** The six sizes the screen is expected to survive, widest and tallest first. */
const SIZES: readonly (readonly [number, number])[] = [
  [100, 30],
  [80, 24],
  [60, 14],
  [40, 12],
  [40, 10],
  [100, 8],
];

describe("regionsFor", () => {
  test("the parts add up to no more than the terminal, at every size", () => {
    for (const [columns, terminalRows] of SIZES) {
      for (const mode of [
        { kind: "list" },
        { kind: "busy" },
        { kind: "add" },
        { kind: "confirm" },
        { kind: "pick", prs: { length: 6 } },
        { kind: "onto", choices: { length: 5 } },
        { kind: "menu", matches: 4 },
        // The query that matched nothing: the popup still draws a body row to
        // say so, and the budget has to have counted it.
        { kind: "menu", matches: 0 },
      ] as readonly LayoutMode[]) {
        for (const lines of [[], [line(1)], [line(1), line(2), line(3)]]) {
          for (const logOn of [true, false]) {
            const message: Message = { kind: "info", text: "something happened", hint: "and why" };
            const regions = regionsFor(
              input({ columns, terminalRows, mode, lines, logOn, message }),
            );

            const drawn =
              regions.headerRows +
              regions.detailRows +
              regions.activityRows +
              regions.logHeight +
              regions.listHeight +
              regions.footerRows;

            const where = `${columns}x${terminalRows} ${mode.kind} ${lines.length} ${logOn}`;

            // The list keeps at least one row whatever else wanted them, and
            // nothing else is allowed to spend rows the terminal has not got.
            expect(`${where}: ${drawn}`).toBe(`${where}: ${Math.max(terminalRows, drawn)}`);
            expect(regions.listHeight).toBeGreaterThanOrEqual(1);

            for (const [part, value] of Object.entries(regions)) {
              if (typeof value === "number") {
                expect(`${where} ${part} >= 0: ${value >= 0}`).toBe(`${where} ${part} >= 0: true`);
              }
            }

            // The window onto the tree is a window: never more rows than the
            // list has room for, and never scrolled past the end.
            expect(regions.visible.length).toBeLessThanOrEqual(regions.listHeight);
            expect(regions.start + regions.visible.length).toBeLessThanOrEqual(TREE.length);
          }
        }
      }
    }
  });

  test("a taller terminal spends the rows it gains on the list", () => {
    const short = regionsFor(input({ terminalRows: 30 }));
    const tall = regionsFor(input({ terminalRows: 36 }));

    expect(tall.listHeight).toBe(short.listHeight + 6);
    expect(tall.headerRows).toBe(short.headerRows);
  });

  /**
   * Worth pinning because it reads like a regression and is not: at 30 rows
   * the banner unfolds into its card and takes ten rows the one-line version
   * did not, so the list is *shorter* on the taller terminal. The card is the
   * screen's answer to "what is this and what do I press", and buying it with
   * list rows is the trade the banner already decided on — this only records
   * that the budget still honours it.
   */
  test("the banner's card is paid for out of the list, not out of the terminal", () => {
    const oneLine = regionsFor(input({ terminalRows: 24 }));
    const card = regionsFor(input({ terminalRows: 30 }));

    expect(card.headerRows).toBeGreaterThan(oneLine.headerRows);
    expect(card.listHeight).toBeLessThan(oneLine.listHeight);
  });

  test("the commit panel gives way to the activity, and then to the list", () => {
    const idle = regionsFor(input({ terminalRows: 30, lines: [] }));
    const working = regionsFor(
      input({ terminalRows: 30, lines: [line(1), line(2), line(3), line(4)] }),
    );
    const cramped = regionsFor(input({ terminalRows: 14, lines: [line(1), line(2)] }));

    expect(idle.logHeight).toBeGreaterThan(0);
    expect(working.activityRows).toBeGreaterThan(0);
    expect(working.logHeight).toBeLessThanOrEqual(idle.logHeight);
    // Nothing at all rather than a heading with one commit stuck to it.
    expect(cramped.logHeight).toBe(0);
  });

  test("`L` hands the panel's rows straight to the list", () => {
    const on = regionsFor(input({ logOn: true }));
    const off = regionsFor(input({ logOn: false }));

    expect(off.logHeight).toBe(0);
    expect(off.listHeight).toBe(on.listHeight + on.logHeight);
  });

  test("activity lines that did not fit are counted, not dropped", () => {
    const lines = Array.from({ length: 12 }, (_, at) => line(at));
    const regions = regionsFor(input({ terminalRows: 30, lines }));

    expect(regions.clipped).toBe(lines.length - regions.activity.length - 1);
    // The newest lines are the ones kept: the last thing said is the point.
    expect(regions.activity.at(-1)).toBe(lines[lines.length - 1]);
  });

  test("a cramped screen drops the activity rather than drawing over the banner", () => {
    const regions = regionsFor(input({ terminalRows: 8, columns: 100, lines: [line(1)] }));

    expect(regions.activity).toEqual([]);
    expect(regions.clipped).toBe(1);
    expect(regions.activityRows).toBe(0);
  });

  test("the window keeps the cursor roughly centred, and stops at the end", () => {
    const many = buildTree(
      Array.from({ length: 20 }, (_, at) => wt(`branch-${at}`)),
      new Set(),
    );

    const top = regionsFor(input({ tree: many, index: 0 }));
    const middle = regionsFor(input({ tree: many, index: 10 }));
    const bottom = regionsFor(input({ tree: many, index: 19 }));

    expect(top.start).toBe(0);
    expect(middle.start).toBe(10 - Math.floor(middle.listHeight / 2));
    expect(bottom.start).toBe(many.length - bottom.listHeight);
    expect(bottom.visible.at(-1)).toBe(many[many.length - 1]);
  });

  test("the popup is never drawn with no room to see the cursor in it", () => {
    for (const [columns, terminalRows] of SIZES) {
      const regions = regionsFor(
        input({ columns, terminalRows, mode: { kind: "pick", prs: { length: 8 } } }),
      );

      expect(regions.prBody).toBeGreaterThanOrEqual(1);
      expect(regions.prBody).toBeLessThanOrEqual(8);
    }
  });
});

describe("columnWidths", () => {
  /** Which columns survive at this width, in the order they are dropped. */
  function kept(columns: number, now = NOW): readonly string[] {
    const widths = columnWidths(TREE, columns, "main", now);

    return (["remote", "trunk", "pr", "touched", "state"] as const).filter(
      (column) => widths[column] > 0,
    );
  }

  test("columns are dropped narrowest terminal last: touched, then trunk, then remote", () => {
    // Widest first, and each step down may only take columns away — never put
    // one back, which is what a drop order being an order means.
    let previous = kept(200);
    expect(previous).toEqual(["remote", "trunk", "touched", "state"]);

    for (let columns = 199; columns >= 20; columns -= 1) {
      const here = kept(columns);

      expect(`${columns}: ${here.join(",")}`).toBe(
        `${columns}: ${here.filter((column) => previous.includes(column)).join(",")}`,
      );
      previous = here;
    }

    expect(previous).toEqual(["state"]);
  });

  /** The same grove, with the forge's answer on one row. */
  const BADGED = buildTree(
    SUMMARIES.map((summary) =>
      summary.dir === "feat/login"
        ? {
            ...summary,
            pullRequest: {
              number: 42,
              url: "https://forge/pull/42",
              head: "feat/login",
              base: "main",
              isDraft: false,
              checks: "passing" as const,
              review: "approved" as const,
              conflicts: false,
            },
          }
        : summary,
    ),
    new Set(),
  );

  test("the pr column is drawn only when some row has one, and goes after touched", () => {
    // Nothing from the forge: no column, and no heading over blank cells.
    expect(columnWidths(TREE, 200, "main", NOW).pr).toBe(0);

    const wide = columnWidths(BADGED, 200, "main", NOW);
    expect(wide.pr).toBe("#42 ✓ approved".length);

    // The same walk as above, over the badged rows: `touched` goes first,
    // then `pr`, then `trunk`, and never does a narrower terminal put a
    // column back.
    const keptOf = (columns: number) =>
      (["remote", "trunk", "pr", "touched", "state"] as const).filter(
        (column) => columnWidths(BADGED, columns, "main", NOW)[column] > 0,
      );
    let previous = keptOf(200);
    expect(previous).toEqual(["remote", "trunk", "pr", "touched", "state"]);

    for (let columns = 199; columns >= 20; columns -= 1) {
      const here = keptOf(columns);

      expect(`${columns}: ${here.join(",")}`).toBe(
        `${columns}: ${here.filter((column) => previous.includes(column)).join(",")}`,
      );
      previous = here;
    }

    expect(previous).toEqual(["state"]);
  });

  test("a row drawn under its parent is sized without the `on` it no longer says", () => {
    const stacked = buildTree([wt("feat/login"), wt("feat/login-api", { parent: "feat/login" })]);
    const apart = buildTree([wt("feat/login"), wt("fix/api", { parent: "feat/login" })]);

    // `on feat/login` is eleven characters and two of padding; the nested
    // row says nothing, so the column is the heading's width.
    expect(columnWidths(stacked, 200, "main", NOW).state).toBe(5);
    expect(columnWidths(apart, 200, "main", NOW).state).toBe("on feat/login".length + 2);
  });

  test("what is left over is never spent twice", () => {
    for (let columns = 20; columns <= 200; columns += 1) {
      const widths = columnWidths(BADGED, columns, "main", NOW);
      const taken = [widths.remote, widths.trunk, widths.pr, widths.touched].filter(
        (width) => width > 0,
      );
      const drawn =
        4 +
        widths.tree +
        GAP.length +
        taken.reduce((a, b) => a + b + GAP.length, 0) +
        widths.state +
        widths.slack;

      expect(`${columns}: ${drawn}`).toBe(`${columns}: ${columns}`);
      expect(widths.slack).toBeGreaterThanOrEqual(0);
    }
  });

  test("every column is wide enough for its own heading, or absent", () => {
    for (const trunkName of ["main", "master", "development-trunk"]) {
      const widths = columnWidths(TREE, 120, trunkName, NOW);

      expect(widths.remote).toBeGreaterThanOrEqual("remote".length);
      expect(widths.trunk).toBeGreaterThanOrEqual(trunkName.length);
      expect(widths.state).toBeGreaterThanOrEqual("state".length);
    }
  });

  /**
   * The defect: `now` used to be a `Date.now()` read inside the memo, and the
   * memo was keyed on the tree, the width and the trunk's name — none of which
   * a cursor move changes. A minute later every row drew `1m ago` into a
   * column still sized for `now`, and the label came out as `1m…` until some
   * later refresh happened to rebuild the tree.
   *
   * Pinned as a table of moments rather than as one, because the failure is
   * about the *relationship* between the moment the column was sized with and
   * the moment the label is written with: at every one of these the column has
   * to be at least as wide as the longest thing the rows will say at it.
   */
  test("the touched column is sized for the moment it is asked about", () => {
    const fresh = buildTree(
      [wt("main", { isDefault: true, touched: NOW - 1_000 }), wt("beta", { touched: NOW - 2_000 })],
      new Set(),
    );

    const moments: readonly (readonly [number, string])[] = [
      [NOW, "now"],
      [NOW + 61 * 1_000, "1m ago"],
      [NOW + 30 * MINUTE, "30m ago"],
      [NOW + 5 * HOUR, "5h ago"],
      [NOW + 3 * DAY, "3d ago"],
    ];

    for (const [now, longest] of moments) {
      const widths = columnWidths(fresh, 100, "main", now);

      expect(`${longest}: ${widths.touched}`).toBe(`${longest}: ${longest.length}`);
    }

    // And the shape of the bug itself: sizing at one moment and labelling at
    // another is what truncates, so the two are the same parameter now.
    const stale = columnWidths(fresh, 100, "main", NOW).touched;
    const later = columnWidths(fresh, 100, "main", NOW + 61 * 1_000).touched;

    expect(stale).toBeLessThan(later);
  });

  test("a tree with no times at all draws no touched column", () => {
    const untouched = buildTree([wt("main", { isDefault: true }), wt("beta")], new Set());

    expect(columnWidths(untouched, 100, "main", NOW).touched).toBe(0);
  });

  test("the tree column is capped at a share of the screen, however long the names", () => {
    const long = buildTree([wt("main", { isDefault: true }), wt("a".repeat(200))], new Set());
    const widths = columnWidths(long, 100, "main", NOW);

    expect(widths.tree).toBe(Math.floor(100 * 0.45));
  });
});

describe("hintsFor", () => {
  const group = TREE.find(
    (row): row is Extract<TreeRow, { kind: "group" }> => row.kind === "group",
  );
  const leaf = TREE.find((row) => row.kind === "leaf");
  const dirty = TREE.find((row) => row.kind === "leaf" && row.summary.dirty);
  const clean = TREE.find((row) => row.kind === "leaf" && !row.summary.dirty);

  if (dirty === undefined || clean === undefined) {
    throw new Error("the fixture tree needs one dirty worktree and one clean one");
  }

  test("a mode that takes the keyboard says only what it answers to", () => {
    expect(hintsFor("add", leaf).map((hint) => hint.keys)).toEqual(["enter", "esc"]);
    expect(hintsFor("upstream", leaf).map((hint) => hint.keys)).toEqual(["enter", "esc"]);
    expect(hintsFor("busy", leaf).map((hint) => hint.keys)).toEqual(["ctrl+c"]);
    expect(hintsFor("pick", leaf).map((hint) => hint.keys)).toEqual(["↑↓", "enter", "esc"]);
    expect(hintsFor("menu", leaf).map((hint) => hint.keys)).toEqual(["↑↓", "enter", "esc"]);
    // The picker's keys, and `enter` spelled for what it does here.
    expect(hintsFor("onto", leaf).map((hint) => hint.action)).toEqual(["move", "rebase", "cancel"]);
    // Deliberately `n keep` though any key but `y` keeps: the bar is what to
    // press, not the whole truth table.
    expect(hintsFor("confirm", leaf).map((hint) => hint.action)).toEqual(["remove", "keep"]);
  });

  test("the confirmation spells `y` for the key that opened it", () => {
    expect(hintsFor("confirm", leaf, "one").map((hint) => hint.action)).toEqual(["remove", "keep"]);
    expect(hintsFor("confirm", leaf, "many").map((hint) => hint.action)).toEqual([
      "remove",
      "keep",
    ]);
    expect(hintsFor("confirm", leaf, "reset").map((hint) => hint.action)).toEqual([
      "discard",
      "keep",
    ]);
    // `keep` would be an answer to a question nobody asked: a sync that does
    // not run takes nothing away, it leaves the branch where it stands.
    expect(hintsFor("confirm", leaf, "sync").map((hint) => hint.action)).toEqual([
      "sync",
      "leave it",
    ]);
    expect(hintsFor("confirm", leaf, "sync-all").map((hint) => hint.action)).toEqual([
      "sync",
      "leave it",
    ]);
    // The same pair `r` uses: it is a removal, of however many.
    expect(hintsFor("confirm", leaf, "prune").map((hint) => hint.action)).toEqual([
      "remove",
      "keep",
    ]);
    // Both halves, because the question is not "shall I" but "have you read
    // this": what `y` agrees to and what it does next are two different facts.
    expect(hintsFor("confirm", leaf, "trust-open").map((hint) => hint.action)).toEqual([
      "trust and open",
      "leave it",
    ]);
  });

  test("`x` is offered on a worktree with something to throw away, and nowhere else", () => {
    expect(hintsFor("list", dirty)).toContainEqual({ keys: "x", action: "discard" });
    expect(hintsFor("list", clean).map((hint) => hint.keys)).not.toContain("x");
    // A folder is not a row `x` acts on: it discards one worktree's changes or
    // none at all.
    expect(hintsFor("list", group).map((hint) => hint.keys)).not.toContain("x");
  });

  test("a folder offers what a folder can do, and not `s`", () => {
    if (group === undefined) throw new Error("the fixture tree has no folder in it");

    const keys = hintsFor("list", group).map((hint) => hint.keys);

    expect(keys).toContain("←→");
    expect(keys).not.toContain("s");
    expect(hintsFor("list", group)).toContainEqual({
      keys: "r",
      action: `remove all ${group.leaves.length}`,
    });
  });

  test("a worktree offers `s`, and no fold", () => {
    const keys = hintsFor("list", leaf).map((hint) => hint.keys);

    expect(keys).toContain("s");
    expect(keys).not.toContain("←→");
  });

  test("an empty tree takes the worktree list", () => {
    expect(hintsFor("list", undefined)).toEqual(hintsFor("list", leaf));
  });

  /**
   * The bar is what stops growing, which is the whole point of `/`. These four
   * had a key each and now have a row in the menu, and a key bar that kept
   * advertising them would be advertising keys that no longer do anything.
   */
  test("the commands that moved to `/` are off the bar, and `/` is on it", () => {
    const keys = hintsFor("list", leaf).map((hint) => hint.keys);

    expect(keys).toContain("/");
    for (const moved of ["p", "S", "R", "L"]) expect(keys).not.toContain(moved);
  });

  /**
   * The bar packing onto a second line is legal — `statusBarRows` counts it and
   * the layout hands the row over — but it is a row the list paid for, and
   * moving four commands behind `/` was how it stopped being paid on an
   * ordinary terminal.
   *
   * Worktree rows only, and two widths, because the bar is not one length. A
   * clean row is the short one; `x discard` makes a dirty one longer; and a
   * folder's is longer still and cannot be pinned at all, since `a add under
   * feat/` spells out whatever the folder was named. So ninety is asserted
   * over the rows the number can mean something for, and eighty over the clean
   * one — which is almost every row of almost every repository.
   */
  test("a worktree's key bar is one line at ninety columns, dirty or clean", () => {
    for (const row of TREE.filter((each) => each.kind === "leaf")) {
      expect(statusBarRows(hintsFor("list", row), 90)).toBe(1);
    }

    expect(statusBarRows(hintsFor("list", clean), 80)).toBe(1);
  });
});
