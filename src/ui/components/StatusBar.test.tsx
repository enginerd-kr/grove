import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { type Hint, packHints, StatusBar, statusBarRows } from "./StatusBar.tsx";

/**
 * The two measurements `packHints` packs against, restated here.
 *
 * Copied rather than imported because neither is exported: the point of
 * restating them is that a change to either has to be made twice, and the
 * second time is this file failing.
 */
const SEPARATOR_WIDTH = " · ".length;

function widthOf(hint: Hint): number {
  return hint.keys.length + 1 + hint.action.length;
}

function rowWidth(row: readonly Hint[]): number {
  const hints = row.reduce((total, hint) => total + widthOf(hint), 0);

  return hints + SEPARATOR_WIDTH * (row.length - 1);
}

const ADD: Hint = { keys: "a", action: "add" }; // 5
const REMOVE: Hint = { keys: "r", action: "remove" }; // 8
const QUIT: Hint = { keys: "q", action: "quit" }; // 6

/** `a add · r remove · q quit` — 5 + 3 + 8 + 3 + 6. */
const BAR: readonly Hint[] = [ADD, REMOVE, QUIT];
const BAR_WIDTH = 25;

/** ink-testing-library fixes the terminal at 100 columns; nothing here may assume more. */
const COLUMNS = 100;

function frameOf(element: React.ReactElement): string {
  const instance = render(element);
  try {
    return plain(instance.lastFrame());
  } finally {
    instance.unmount();
  }
}

describe("packHints", () => {
  test("everything on one row when the width allows it", () => {
    expect(packHints(BAR, 200)).toEqual([BAR]);
  });

  test("the exact width that still fits is not one column too many", () => {
    expect(rowWidth(BAR)).toBe(BAR_WIDTH);
    expect(packHints(BAR, BAR_WIDTH)).toEqual([BAR]);
    expect(packHints(BAR, BAR_WIDTH - 1)).toEqual([[ADD, REMOVE], [QUIT]]);
  });

  test("the break lands at a separator, never inside a hint", () => {
    // 16 is `a add · r remove` exactly; 15 is one short of it.
    expect(rowWidth([ADD, REMOVE])).toBe(16);
    expect(packHints(BAR, 16)).toEqual([[ADD, REMOVE], [QUIT]]);
    expect(packHints(BAR, 15)).toEqual([[ADD], [REMOVE], [QUIT]]);
  });

  test("a hint wider than the terminal still gets a row of its own", () => {
    const wide: Hint = { keys: "ctrl+shift+r", action: "rebuild everything from scratch" };

    expect(packHints([wide], 4)).toEqual([[wide]]);
    // Two of them make two rows rather than one crammed row: the alternative is
    // a break inside a hint, which is the thing the whole function avoids.
    expect(packHints([wide, wide], 4)).toEqual([[wide], [wide]]);
  });

  test("an over-wide hint does not drag the next one onto its row", () => {
    const wide: Hint = { keys: "k", action: "x".repeat(60) };

    expect(packHints([wide, QUIT], 20)).toEqual([[wide], [QUIT]]);
  });

  test("no hints, no rows — at any width", () => {
    expect(packHints([], 40)).toEqual([]);
    expect(packHints([], 1)).toEqual([]);
    expect(packHints([], undefined)).toEqual([]);
    expect(packHints([], 0)).toEqual([]);
  });

  test("an omitted width means do not wrap, however long the bar is", () => {
    expect(packHints(BAR)).toEqual([BAR]);
    expect(packHints(BAR, undefined)).toEqual([BAR]);
  });

  test("a width of zero or less is treated as unmeasured, not as impossibly narrow", () => {
    // A terminal that reports no columns should print the bar, not an empty
    // screen or one row per hint.
    expect(packHints(BAR, 0)).toEqual([BAR]);
    expect(packHints(BAR, -10)).toEqual([BAR]);
  });

  test("a single hint is one row at every width", () => {
    for (const columns of [undefined, 0, 1, 5, 6, 100]) {
      expect(packHints([QUIT], columns)).toEqual([[QUIT]]);
    }
  });

  test("every hint survives, in order, at every width", () => {
    for (let columns = 1; columns <= 40; columns++) {
      expect(packHints(BAR, columns).flat()).toEqual([...BAR]);
    }
  });

  test("no row of two or more hints ever exceeds the width", () => {
    for (let columns = 1; columns <= 40; columns++) {
      for (const row of packHints(BAR, columns)) {
        // A lone hint is allowed to overflow — `truncate` cuts it at the edge.
        if (row.length > 1) expect(rowWidth(row)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("rows are filled greedily: a row breaks only when the next hint cannot fit", () => {
    for (let columns = 1; columns <= 40; columns++) {
      const rows = packHints(BAR, columns);

      for (const [index, row] of rows.entries()) {
        const next = rows[index + 1]?.[0];
        if (next === undefined) continue;

        expect(rowWidth(row) + SEPARATOR_WIDTH + widthOf(next)).toBeGreaterThan(columns);
      }
    }
  });
});

describe("statusBarRows", () => {
  const cases: readonly { readonly hints: readonly Hint[]; readonly columns?: number }[] = [
    { hints: [] },
    { hints: [], columns: 80 },
    { hints: [], columns: 0 },
    { hints: BAR },
    { hints: BAR, columns: undefined },
    { hints: BAR, columns: 0 },
    { hints: BAR, columns: -1 },
    { hints: BAR, columns: 1 },
    { hints: BAR, columns: BAR_WIDTH - 1 },
    { hints: BAR, columns: BAR_WIDTH },
    { hints: BAR, columns: 200 },
    { hints: [QUIT], columns: 2 },
    { hints: [{ keys: "k", action: "x".repeat(200) }], columns: 10 },
  ];

  // A screen slices its list to the space left over after the bar. If this
  // number is one short, the bar's last row is drawn past the bottom of the
  // terminal and the list scrolls; there is no way to see that in a unit test
  // of either function alone, so the agreement is asserted directly.
  test("always equals how many rows packHints produced", () => {
    for (const { hints, columns } of cases) {
      expect(statusBarRows(hints, columns)).toBe(packHints(hints, columns).length);
    }
  });

  test("counts the rows a caller has to reserve", () => {
    expect(statusBarRows([], 80)).toBe(0);
    expect(statusBarRows(BAR, BAR_WIDTH)).toBe(1);
    expect(statusBarRows(BAR, BAR_WIDTH - 1)).toBe(2);
    expect(statusBarRows(BAR, 15)).toBe(3);
    expect(statusBarRows(BAR)).toBe(1);
  });
});

describe("StatusBar", () => {
  test("draws the hints on one line, separated", () => {
    expect(frameOf(<StatusBar hints={[ADD, QUIT]} />)).toBe("a add · q quit");
  });

  test("draws one line per packed row", () => {
    expect(frameOf(<StatusBar hints={BAR} columns={BAR_WIDTH - 1} />)).toBe(
      "a add · r remove\nq quit",
    );
  });

  test("no hints draws nothing at all", () => {
    expect(frameOf(<StatusBar hints={[]} columns={80} />)).toBe("");
  });

  test("a row wider than the terminal is truncated, not wrapped", () => {
    const frame = frameOf(
      <StatusBar hints={[{ keys: "k", action: "x".repeat(200) }]} columns={COLUMNS} />,
    );

    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toHaveLength(COLUMNS);
    expect(frame.endsWith("…")).toBe(true);
  });

  test("unmeasured, the whole bar stays on one line even past the terminal edge", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      keys: `k${index}`,
      action: `action${index}`,
    }));

    expect(frameOf(<StatusBar hints={many} />).split("\n")).toHaveLength(1);
  });

  test("the rows it draws are the rows statusBarRows promised", () => {
    for (const columns of [BAR_WIDTH, BAR_WIDTH - 1, 16, 15, 1]) {
      const lines = frameOf(<StatusBar hints={BAR} columns={columns} />).split("\n");

      expect(lines).toHaveLength(statusBarRows(BAR, columns));
    }
  });
});
