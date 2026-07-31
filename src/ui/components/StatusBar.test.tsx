import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { type Hint, packHints, StatusBar, statusBarRows } from "./StatusBar.tsx";

/**
 * The key bar, on a terminal too narrow for it.
 *
 * Two things have to hold, and they are the same thing seen from either end: a
 * break lands between hints rather than inside one, and `statusBarRows` says how
 * many rows that came to. The screen subtracts the second before slicing its
 * list, so a bar that quietly took one row more takes it from the bottom of the
 * terminal.
 */

const FOLDER: readonly Hint[] = [
  { keys: "↑↓", action: "move" },
  { keys: "a", action: "add under chore/" },
  { keys: "r", action: "remove all 1" },
  { keys: "S", action: "sync all" },
  { keys: "R", action: "refresh" },
  { keys: "q", action: "quit" },
];

function draw(hints: readonly Hint[], columns?: number) {
  const { lastFrame } = render(<StatusBar hints={hints} columns={columns} />);

  return plain(lastFrame()).split("\n");
}

test("a hint is never split across two lines", () => {
  for (const columns of [34, 46, 60, 79]) {
    // Each drawn line holds whole hints and still fits — which together are what
    // "the break went to a separator" means. A one-hint line is exempt: there is
    // no separator on it to break at.
    for (const line of draw(FOLDER, columns)) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }

    for (const line of packHints(FOLDER, columns)) {
      const drawn = line.map((hint) => `${hint.keys} ${hint.action}`).join(" · ");

      expect(drawn.length <= columns || line.length === 1).toBe(true);
      expect(draw(FOLDER, columns)).toContain(drawn);
    }
  }
});

test("every hint survives the packing, in order", () => {
  expect(packHints(FOLDER, 34).flat()).toEqual([...FOLDER]);
});

test("`statusBarRows` is what the bar actually draws", () => {
  for (const columns of [34, 46, 60, 79, 100]) {
    expect(draw(FOLDER, columns)).toHaveLength(statusBarRows(FOLDER, columns));
  }
});

// The reporter draws into a log, not into a measured layout: there is no width
// to pack against and nothing underneath to protect.
test("without a width, everything goes on one line", () => {
  expect(draw(FOLDER)).toHaveLength(1);
  expect(statusBarRows(FOLDER)).toBe(1);
});

test("a hint wider than the terminal gets a line to itself rather than a break inside it", () => {
  const wide: readonly Hint[] = [
    { keys: "q", action: "quit" },
    { keys: "x", action: "an action nobody would ever write".repeat(2) },
  ];

  expect(packHints(wide, 20)).toEqual([[wide[0] as Hint], [wide[1] as Hint]]);
});
