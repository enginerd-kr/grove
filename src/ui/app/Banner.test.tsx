import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { Banner, bannerRows } from "./Banner.tsx";

/**
 * `bannerRows`, checked against the banner it is meant to describe.
 *
 * The screen slices the list to whatever is left once the banner has had its
 * rows, and it has to know the number before anything is drawn — so a banner
 * that draws one row more than it claimed pushes the key bar off the bottom of
 * the terminal. That is a bug at one window size only, and invisible in a frame
 * read from the top, which is why the number is asserted against the drawing
 * rather than against itself.
 */

function drawn(columns: number, rows: number): readonly string[] {
  const instance = render(
    <Banner repoRoot="/work/repo" worktrees={3} here="main" columns={columns} rows={rows} />,
  );

  try {
    return plain(instance.lastFrame()).split("\n");
  } finally {
    instance.unmount();
  }
}

/**
 * The sizes either side of both thresholds the card turns on.
 *
 * `ROOMY_ROWS` (28) and `ROOMY_COLUMNS` (52) are not exported, and are not
 * restated here as numbers: what matters is that the count and the drawing
 * agree at every one of these, whichever shape each one lands in.
 */
const SIZES: readonly (readonly [number, number])[] = [
  [120, 40],
  [100, 30],
  [84, 28],
  [83, 28],
  [52, 28],
  [51, 28],
  [100, 27],
  [80, 24],
  [40, 12],
  [40, 10],
];

test("bannerRows is what the banner actually draws, at every size", () => {
  for (const [columns, rows] of SIZES) {
    const lines = drawn(columns, rows);

    expect(`${columns}x${rows}: ${lines.length}`).toBe(
      `${columns}x${rows}: ${bannerRows(columns, rows)}`,
    );
  }
});

test("the card costs rows, and gives every one of them back when it goes", () => {
  // Both thresholds have to be met, so either one failing is enough to fold the
  // card away — a terminal wide enough but too short is still a one-line
  // banner, and the list gets the difference.
  expect(bannerRows(100, 30)).toBeGreaterThan(1);
  expect(bannerRows(100, 27)).toBe(1);
  expect(bannerRows(51, 30)).toBe(1);
  expect(bannerRows(40, 12)).toBe(1);
});

test("the height does not move with the terminal once the card is drawn", () => {
  // A constant rather than a calculation on purpose: a card that changed height
  // with what it had to say would bounce the list underneath it.
  expect(bannerRows(200, 60)).toBe(bannerRows(52, 28));
});
