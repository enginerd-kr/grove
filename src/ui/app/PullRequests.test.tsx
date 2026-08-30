import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PullRequest } from "../../core/commands/pr.ts";
import { plain } from "../test-utils.ts";
import { PullRequests, pullRequestRows } from "./PullRequests.tsx";

/**
 * `pullRequestRows`, checked against the popup it is meant to describe.
 *
 * Unlike the `add` box, whose three rows are the same however long the branch
 * name is, this popup is as tall as the forge says — so the layout asks rather
 * than assumes, and an answer one row out is a popup drawn over the key bar.
 * The number is asserted against the drawing for the same reason `bannerRows`
 * is: nothing else can tell whether the two have drifted apart.
 */

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `Change number ${number}`,
    author: "someone",
    isDraft: false,
    headRefName: `feat/${number}`,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function drawn(prs: readonly PullRequest[], rows: number): readonly string[] {
  const instance = render(<PullRequests prs={prs} index={0} rows={rows} />);

  try {
    return plain(instance.lastFrame()).split("\n");
  } finally {
    instance.unmount();
  }
}

test("pullRequestRows is what the popup actually draws", () => {
  const prs = [pr(1), pr(2), pr(3), pr(4)];

  for (const rows of [0, 1, 3, 4, 8]) {
    const lines = drawn(prs, rows);

    expect(`${rows}: ${lines.length}`).toBe(`${rows}: ${pullRequestRows(prs.length, rows)}`);
  }
});

test("the border and the heading are paid for whether or not a row fits inside them", () => {
  // Two for the border and one for the heading: a popup with no room left for
  // its rows still costs the three that say it is there at all.
  expect(pullRequestRows(0, 8)).toBe(3);
  expect(pullRequestRows(5, 0)).toBe(3);
});

test("it counts the rows that will be drawn, not the ones the forge has", () => {
  // Whichever of the two runs out first. The popup takes its rows out of the
  // list underneath it, so a repository with forty open pull requests must not
  // be able to ask for forty rows.
  expect(pullRequestRows(40, 8)).toBe(3 + 8);
  expect(pullRequestRows(2, 8)).toBe(3 + 2);
});

test("a negative row budget is no rows rather than rows taken away", () => {
  expect(pullRequestRows(5, -3)).toBe(3);
});
