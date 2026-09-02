import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { RebaseChoice } from "../../core/commands/rebase.ts";
import { plain } from "../test-utils.ts";
import { Bases, baseRows } from "./Bases.tsx";

/**
 * The rebase popup's own parts: how tall it is and what it draws. Which
 * command opens it and what `enter` then runs is `App.test.tsx`'s.
 */

const CHOICES: readonly RebaseChoice[] = [
  { base: { kind: "upstream" }, ref: "origin/feat/login", label: "upstream" },
  { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
  { base: { kind: "ref", ref: "feat/search" }, ref: "feat/search", label: "feat/search" },
];

describe("baseRows", () => {
  test("the border, the heading, and one row per base it can show", () => {
    expect(baseRows(3, 8)).toBe(2 + 1 + 3);
    expect(baseRows(12, 8)).toBe(2 + 1 + 8);
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
});
