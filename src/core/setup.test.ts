import { expect, test } from "bun:test";
import type { GroveError } from "./errors.ts";
import { checkedSetupPath, describeSetup, failureFor, type SetupResult } from "./setup.ts";

/**
 * The pure half of setup: which configured paths are usable, and how the
 * outcome reads. Everything that touches a disk is in `commands/setup.int.test.ts`.
 */

const empty: SetupResult = {
  path: "/repo/feat/login",
  dir: "feat/login",
  planned: 0,
  copied: [],
  linked: [],
  ran: [],
  missing: [],
  kept: [],
  untrusted: false,
};

test("a relative path inside the worktree is kept, with its separators tidied", () => {
  expect(checkedSetupPath("copy", ".env")).toBe(".env");
  expect(checkedSetupPath("copy", "config/local.json")).toBe("config/local.json");
  expect(checkedSetupPath("copy", "./config//local.json")).toBe("config/local.json");
  expect(checkedSetupPath("link", "node_modules/")).toBe("node_modules");
});

// The check that matters. These paths are resolved against two directories —
// the worktree being filled and the one being read from — so an escape is a
// config line that copies something from outside the repository into a
// directory somebody is about to commit from.
test("a path that could leave the worktree is refused, naming the key", () => {
  for (const value of ["/etc/passwd", "../secrets", "a/../../b", "C:\\keys", "", "..", "./"]) {
    const error = (() => {
      try {
        checkedSetupPath("copy", value);
        return undefined;
      } catch (caught) {
        return caught as GroveError;
      }
    })();

    expect(error?.code, `expected ${JSON.stringify(value)} to be refused`).toBe("usage");
    expect(error?.message).toContain("copy");
  }
});

// `.git` in a worktree is a file pointing into `.bare`; copying either one
// between worktrees produces a directory git cannot make sense of.
test("git's own plumbing cannot be copied about", () => {
  expect(() => checkedSetupPath("copy", ".git")).toThrow();
  expect(() => checkedSetupPath("copy", ".bare")).toThrow();
  expect(() => checkedSetupPath("link", "vendor/.git")).toThrow();
});

test("the summary counts what happened, and separates the two kinds of nothing", () => {
  expect(describeSetup(empty)).toBe("no .grove.toml");
  expect(describeSetup({ ...empty, planned: 2, missing: [".env", ".npmrc"] })).toBe(
    "nothing to do",
  );
  expect(
    describeSetup({
      ...empty,
      planned: 4,
      copied: [".env"],
      linked: ["node_modules"],
      ran: ["bun install"],
      kept: [".npmrc"],
    }),
  ).toBe("1 copied, 1 linked, 1 run, 1 kept");
});

test("a failed command becomes an error a script can tell apart, and names the retry", () => {
  const failure = failureFor({
    ...empty,
    planned: 1,
    failed: { command: "bun install", code: 3, details: ["error: no lockfile"] },
  });

  expect(failure?.code).toBe("setup-failed");
  expect(failure?.message).toContain("exited 3");
  expect(failure?.details).toEqual(["error: no lockfile"]);
  expect(failure?.hint).toContain("grove setup feat/login");
});

test("nothing failed is nothing thrown", () => {
  expect(failureFor({ ...empty, planned: 1, ran: ["bun install"] })).toBeUndefined();
});
