import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { version } from "../../../package.json";
import { plain } from "../test-utils.ts";
import { Banner, bannerRows } from "./Banner.tsx";

/**
 * The banner, at the sizes where it changes shape.
 *
 * The one thing worth pinning down is that `bannerRows` and the component agree:
 * the screen slices the list to the rows left after the banner, so a banner that
 * draws one row more than it claimed pushes the key bar off the bottom of the
 * terminal — a bug that only shows up at one window size and is invisible in a
 * frame you read from the top.
 */

function draw(columns: number, rows: number) {
  const { lastFrame } = render(
    <Banner repoRoot="/work/repo" worktrees={3} here="main" columns={columns} rows={rows} />,
  );

  return plain(lastFrame()).split("\n");
}

test("says what it is, which version, and which folder — at any size", () => {
  for (const [columns, rows] of [
    [90, 30],
    [40, 12],
  ] as const) {
    const drawn = draw(columns, rows).join("\n");

    expect(drawn).toContain(`garden v${version}`);
    expect(drawn).toContain("/work/repo");
    expect(drawn).toContain("3 worktrees");
    expect(drawn).toContain("in main");
  }
});

test("the art appears when there is room for it, and goes when there is not", () => {
  expect(draw(90, 30).join("\n")).toContain("▝▜█▄█▛▘");
  // Short terminal, then narrow one: either is reason enough to give the rows
  // back to the list.
  expect(draw(90, 12).join("\n")).not.toContain("▝▜█▄█▛▘");
  expect(draw(40, 30).join("\n")).not.toContain("▝▜█▄█▛▘");
});

test("`bannerRows` is what the banner actually draws", () => {
  for (const [columns, rows] of [
    [90, 30],
    [80, 22],
    [80, 21],
    [40, 12],
  ] as const) {
    expect(draw(columns, rows)).toHaveLength(bannerRows(columns, rows));
  }
});

test("an empty repository says so rather than counting to zero", () => {
  const { lastFrame } = render(
    <Banner repoRoot="/work/repo" worktrees={0} columns={90} rows={30} />,
  );

  expect(plain(lastFrame())).toContain("no worktrees yet");
});
