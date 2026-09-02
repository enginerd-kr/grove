import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain, waitFor } from "../test-utils.ts";
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

/** The line under the "Tips for getting started" heading, or `undefined` before the card has drawn. */
function tipLine(frame: string | undefined): string | undefined {
  const lines = plain(frame).split("\n");
  const heading = lines.findIndex((line) => line.includes("Tips for getting started"));

  return heading === -1 ? undefined : lines[heading + 1];
}

test("the list screen's tip turns over while the card is up, and never to itself", async () => {
  // The refresh clock re-renders the card every minute; a tip that changed on
  // every render would flicker, and one that never changed would be read once
  // and never again. So it is drawn once, and turned on its own clock.
  const instance = render(
    <Banner
      repoRoot="/work/repo"
      worktrees={3}
      here="main"
      columns={120}
      rows={40}
      tipRotateMs={20}
    />,
  );

  try {
    const first = tipLine(instance.lastFrame());
    expect(first).toBeDefined();

    const second = await waitFor(
      () => instance.lastFrame(),
      (frame) => tipLine(frame) !== first,
    );
    expect(tipLine(second)).not.toBe(first);
  } finally {
    instance.unmount();
  }
});

test("a folder with one thing left to do says that one thing, and keeps saying it", async () => {
  // No worktrees is waiting for `a` and nothing else: there is no pool to
  // draw from, so there is nothing to turn to, and the clock stays off.
  const instance = render(
    <Banner repoRoot="/work/repo" worktrees={0} columns={120} rows={40} tipRotateMs={5} />,
  );

  try {
    const first = tipLine(instance.lastFrame());
    expect(first).toContain("press a to plant your first worktree");

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(tipLine(instance.lastFrame())).toBe(first);
  } finally {
    instance.unmount();
  }
});

test("a list that arrives after the card is up gets a fair draw, not the first tip", () => {
  // The list is empty until the first read lands, so the card is drawn while
  // "no worktrees yet" has one tip to give — and a draw made against a pool
  // of one is 0 in any pool, which put the same first tip on every open.
  const seen = new Set<string>();

  for (let i = 0; i < 20; i++) {
    const instance = render(<Banner repoRoot="/work/repo" worktrees={0} columns={120} rows={40} />);

    try {
      instance.rerender(
        <Banner repoRoot="/work/repo" worktrees={3} here="main" columns={120} rows={40} />,
      );
      const tip = tipLine(instance.lastFrame());
      expect(tip).toBeDefined();
      seen.add(tip ?? "");
    } finally {
      instance.unmount();
    }
  }

  // Twenty draws from ten tips all landing on one is a chance in 10^19, not
  // a flake: if this fails, the draw is being made against the wrong pool.
  expect(seen.size).toBeGreaterThan(1);
});
