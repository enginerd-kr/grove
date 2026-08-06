import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { version } from "../../../package.json";
import { plain } from "../test-utils.ts";
import { Banner, bannerRows } from "./Banner.tsx";
import type { ChangelogEntry } from "./changelog.ts";

/**
 * The banner, at the sizes where it changes shape.
 *
 * The one thing worth pinning down is that `bannerRows` and the component agree:
 * the screen slices the list to the rows left after the banner, so a banner that
 * draws one row more than it claimed pushes the key bar off the bottom of the
 * terminal — a bug that only shows up at one window size and is invisible in a
 * frame you read from the top.
 */

function draw(columns: number, rows: number, whatsNew?: ChangelogEntry) {
  const { lastFrame } = render(
    <Banner
      repoRoot="/work/repo"
      worktrees={3}
      here="main"
      columns={columns}
      rows={rows}
      whatsNew={whatsNew}
    />,
  );

  return plain(lastFrame()).split("\n");
}

test("says what it is, which version, and which folder — at any size", () => {
  for (const [columns, rows] of [
    [90, 30],
    [40, 12],
  ] as const) {
    const drawn = draw(columns, rows).join("\n");

    expect(drawn).toContain(`grove v${version}`);
    expect(drawn).toContain("/work/repo");
    expect(drawn).toContain("3 worktrees");
    expect(drawn).toContain("in main");
  }
});

test("the card greets, and the art appears — when there is room for both", () => {
  const drawn = draw(90, 30).join("\n");

  expect(drawn).toContain("Welcome back");
  expect(drawn).toContain("▝▜█▄█▛▘");
  // Short terminal, then narrow one: either is reason enough to give the rows
  // back to the list.
  expect(draw(90, 12).join("\n")).not.toContain("▝▜█▄█▛▘");
  expect(draw(40, 30).join("\n")).not.toContain("▝▜█▄█▛▘");
});

test("the title sits in the border, corner to corner", () => {
  const [top] = draw(90, 30);

  expect(top).toStartWith(`╭─ grove v${version} `);
  expect(top).toEndWith("╮");
  expect(top).toHaveLength(90);
});

test("`bannerRows` is what the banner actually draws", () => {
  for (const [columns, rows] of [
    [100, 30],
    [90, 30],
    [84, 28],
    [83, 28],
    [80, 28],
    [80, 27],
    [52, 28],
    [40, 12],
  ] as const) {
    expect(draw(columns, rows)).toHaveLength(bannerRows(columns, rows));
  }
});

const NEWS: ChangelogEntry = {
  version: "9.9.9",
  bullets: ["planted a hedge", "watered the beds", "raked the paths", "swept the shed"],
};

test("tips and what's new sit beside the greeting when the terminal is wide enough", () => {
  const drawn = draw(100, 30, NEWS).join("\n");

  expect(drawn).toContain("Tips for getting started");
  expect(drawn).toContain("What's new");
  expect(drawn).not.toContain("v9.9.9");
  expect(drawn).toContain("· planted a hedge");
  // Three bullets at most; the changelog itself holds the rest.
  expect(drawn).toContain("· raked the paths");
  expect(drawn).not.toContain("swept the shed");
  expect(drawn).toContain("CHANGELOG.md for more");
  // The greeting column keeps saying what it always said.
  expect(drawn).toContain("3 worktrees · in main");
});

test("the right-hand column goes when the terminal is narrow or short", () => {
  expect(draw(83, 30, NEWS).join("\n")).not.toContain("Tips for getting started");
  expect(draw(83, 30, NEWS).join("\n")).not.toContain("What's new");
  expect(draw(100, 12, NEWS).join("\n")).not.toContain("What's new");
});

test("the card's height holds still whatever the changelog says", () => {
  for (const bullets of [0, 1, 2, 5]) {
    const entry = { version: "9.9.9", bullets: NEWS.bullets.slice(0, bullets) };

    expect(draw(100, 30, entry)).toHaveLength(bannerRows(100, 30));
  }

  // A bullet-less entry is no entry: the tip stays, the news does not.
  expect(draw(100, 30, { version: "9.9.9", bullets: [] }).join("\n")).not.toContain("What's new");
});

test("an empty repository says so rather than counting to zero", () => {
  const { lastFrame } = render(
    <Banner repoRoot="/work/repo" worktrees={0} columns={90} rows={30} />,
  );

  expect(plain(lastFrame())).toContain("no worktrees yet");
});
