import { expect, test } from "bun:test";
import { describeTouched, type WorktreeSummary } from "./list.ts";

/**
 * The touched column's words, checked against a clock the test controls.
 *
 * `now` is a parameter for exactly this reason: a formatter that read the real
 * clock could only be tested against "roughly".
 */

function summary(touched?: number): WorktreeSummary {
  return {
    path: "/repo/main",
    dir: "main",
    branch: "main",
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    touched,
    locked: false,
    rebasing: false,
    isDefault: true,
    current: false,
  };
}

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("nothing to say when no time could be read", () => {
  expect(describeTouched(summary(undefined), NOW)).toBe("");
});

test("under a minute is now — seconds would be a clock, not an answer", () => {
  expect(describeTouched(summary(NOW - 30_000), NOW)).toBe("now");
});

test("recent times are relative", () => {
  expect(describeTouched(summary(NOW - 5 * MINUTE), NOW)).toBe("5m ago");
  expect(describeTouched(summary(NOW - 59 * MINUTE), NOW)).toBe("59m ago");
  expect(describeTouched(summary(NOW - 3 * HOUR), NOW)).toBe("3h ago");
  expect(describeTouched(summary(NOW - 23 * HOUR), NOW)).toBe("23h ago");
  expect(describeTouched(summary(NOW - DAY), NOW)).toBe("1d ago");
  expect(describeTouched(summary(NOW - 6 * DAY - HOUR), NOW)).toBe("6d ago");
});

test("a week out, ago stops meaning anything and the date takes over", () => {
  expect(describeTouched(summary(NOW - 7 * DAY), NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("the absolute form is the local calendar, zero-padded", () => {
  const touched = NOW - 30 * DAY;
  const date = new Date(touched);
  const pad = (value: number) => String(value).padStart(2, "0");

  expect(describeTouched(summary(touched), NOW)).toBe(
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  );
});

test("a time from the future reads as now — the drift is the clock's, not the worktree's", () => {
  expect(describeTouched(summary(NOW + 2 * MINUTE), NOW)).toBe("now");
});
