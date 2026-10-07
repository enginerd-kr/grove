import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { RebaseChoice } from "../../core/commands/rebase.ts";
import { plain } from "../test-utils.ts";
import { Bases, baseGrid, baseRows, moveBaseIndex } from "./Bases.tsx";

/**
 * The rebase popup's own parts: how tall it is and what it draws. Which
 * command opens it and what `enter` then runs is `App.test.tsx`'s.
 */

const CHOICES: readonly RebaseChoice[] = [
  { base: { kind: "upstream" }, ref: "origin/feat/login", label: "upstream" },
  { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
  { base: { kind: "ref", ref: "feat/search" }, ref: "feat/search", label: "feat/search" },
];

const MANY: readonly RebaseChoice[] = Array.from({ length: 12 }, (_, index) => {
  const ref = `feat/branch-${index}`;
  return { base: { kind: "ref", ref }, ref, label: ref };
});

describe("baseRows", () => {
  test("the border, the heading, and one row per base it can show", () => {
    expect(baseRows(3, 8)).toBe(2 + 1 + 3);
    expect(baseRows(12, 8)).toBe(2 + 1 + 8);
    expect(baseRows(12, 8, 100)).toBe(2 + 1 + 6);
    expect(baseRows(12, 8, 50)).toBe(2 + 1 + 8);
  });
});

describe("branch column navigation", () => {
  test("horizontal keys keep the row, vertical keys stay in their column", () => {
    const grid = baseGrid(12, 4, 100);
    expect(moveBaseIndex(grid, 1, "right")).toBe(7);
    expect(moveBaseIndex(grid, 7, "left")).toBe(1);
    expect(moveBaseIndex(grid, 6, "down")).toBe(7);
    expect(moveBaseIndex(grid, 7, "up")).toBe(6);
    expect(moveBaseIndex(grid, 6, "up")).toBe(6);
    expect(moveBaseIndex(grid, 5, "down")).toBe(5);
    expect(moveBaseIndex(grid, 1, "left")).toBe(1);
    expect(moveBaseIndex(grid, 7, "right")).toBe(7);
  });

  test("an incomplete right column selects its last branch instead of an empty cell", () => {
    const grid = baseGrid(11, 4, 100);
    expect(moveBaseIndex(grid, 5, "right")).toBe(10);
    expect(moveBaseIndex(grid, 10, "down")).toBe(10);
    expect(moveBaseIndex(grid, 10, "left")).toBe(4);
  });

  test("narrow terminals use one column without changing the selected branch", () => {
    const grid = baseGrid(12, 4, 50);
    expect(grid.columnCount).toBe(1);
    expect(moveBaseIndex(grid, 7, "right")).toBe(7);
    expect(moveBaseIndex(grid, 7, "left")).toBe(7);
    expect(moveBaseIndex(grid, 7, "up")).toBe(6);
    expect(moveBaseIndex(grid, 7, "down")).toBe(8);
    expect(moveBaseIndex(baseGrid(0, 4, 100), 0, "right")).toBe(0);
  });
});

describe("Bases", () => {
  function draw(props: Partial<Parameters<typeof Bases>[0]> = {}) {
    const instance = render(
      <Bases dir="feat/login" choices={CHOICES} index={0} rows={CHOICES.length} {...props} />,
    );

    return plain(instance.lastFrame());
  }

  test("names the worktree in the heading, and the ref beside each role", () => {
    const frame = draw();

    expect(frame).toContain("rebase feat/login onto");
    expect(frame).toContain("upstream");
    expect(frame).toContain("origin/feat/login");
    expect(frame).toContain("trunk");
    expect(frame).toContain("origin/main");
  });

  // A branch is its own label, and a row reading `feat/search  feat/search`
  // would be the popup repeating itself.
  test("a worktree's branch is said once", () => {
    const row = draw()
      .split("\n")
      .find((line) => line.includes("feat/search"));

    expect(row?.match(/feat\/search/g)).toHaveLength(1);
  });

  test("the marker is on the row the cursor is on, and on no other", () => {
    const rows = draw({ index: 1 })
      .split("\n")
      .filter((line) => line.includes("▸"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("trunk");
  });

  test("a popup shorter than the list keeps the cursor inside it, and counts", () => {
    const frame = draw({ index: 2, rows: 2 });

    expect(frame).toContain("3 of 3");
    expect(frame).toContain("feat/search");
    expect(frame).not.toContain("upstream");
  });

  test("two columns put the horizontal neighbour on the same rendered row", () => {
    const frame = draw({ choices: MANY, index: 7, rows: 8, columns: 100 });
    const selected = frame.split("\n").find((line) => line.includes("▸"));
    expect(selected).toMatch(/feat\/branch-1\s+▸ feat\/branch-7/);
    expect(frame).toContain("feat/branch-11");
    expect(frame.split("\n")).toHaveLength(baseRows(12, 8, 100));
  });

  test("scrolling the right column keeps both columns aligned and the selected branch visible", () => {
    const frame = draw({ choices: MANY, index: 11, rows: 3, columns: 100 });
    const selected = frame.split("\n").find((line) => line.includes("▸"));
    expect(selected).toMatch(/feat\/branch-5\s+▸ feat\/branch-11/);
    expect(frame).toContain("12 of 12");
    expect(frame).not.toContain("feat/branch-0");
    expect(frame.split("\n")).toHaveLength(baseRows(12, 3, 100));
  });
});
