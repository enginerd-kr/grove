import { expect, test } from "bun:test";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { rank } from "./filter.ts";

/**
 * The ranking, which is the whole of what makes the filter feel like completing
 * a name. Order is the assertion in almost every case here: that a match is
 * found matters much less than that the one you meant is first.
 */

function summary(dir: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/repo/${dir}`,
    dir,
    branch: dir,
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    isDefault: false,
    current: false,
    ...overrides,
  };
}

const ROWS = [
  summary("main", { isDefault: true }),
  summary("feat/login"),
  summary("feat/login-mobile"),
  summary("fix/hot-crash"),
  summary("chore/relogin-audit"),
];

const order = (filter: string) => rank(ROWS, filter).map((row) => row.summary.dir);

test("what you spelled comes before what merely contains it", () => {
  // `login` is the whole of one segment, the start of another's, and buried in
  // the middle of the third. That is the order it should come back in.
  expect(order("login")).toEqual(["feat/login", "feat/login-mobile", "chore/relogin-audit"]);
});

test("a prefix of the short name beats a match further in", () => {
  expect(order("logi")[0]).toBe("feat/login");
});

test("a word inside a path is a word: `crash` finds `fix/hot-crash`", () => {
  expect(order("crash")).toEqual(["fix/hot-crash"]);
});

// The thing that makes it feel like completion rather than search — and it is
// deliberately last, so it can never outrank something that actually spells it.
test("scattered letters match, and lose to anything that spells the name", () => {
  expect(order("fl")).toEqual(["feat/login", "feat/login-mobile"]);
  // `feat/login` spells `login`; `fl` only scatters through the others.
  expect(order("login")[0]).toBe("feat/login");
});

test("the shorter path wins a tie, being the more direct answer", () => {
  expect(order("feat/login")).toEqual(["feat/login", "feat/login-mobile"]);
});

test("nothing matching is nothing, not everything", () => {
  expect(order("zzz")).toEqual([]);
});

test("the rows come back flat, with the whole path on each", () => {
  const rows = rank(ROWS, "login");

  // No headings to indent under, so the prefix has to be on the row itself or
  // the row does not say which worktree it is.
  expect(rows.every((row) => row.depth === 0)).toBe(true);
  expect(rows.every((row) => row.kind === "leaf")).toBe(true);
  expect(rows[0]?.label).toBe("feat/login");
});

test("case is not something anybody means", () => {
  expect(order("LOGIN")[0]).toBe("feat/login");
});

// The branch is the other name the same worktree goes by, and which one someone
// reaches for depends on whether they are thinking about the tree or the ref.
test("a branch that differs from its directory is matched too", () => {
  const rows = rank([summary("wt-1", { branch: "release/2026-01" })], "release");

  expect(rows.map((row) => row.summary.dir)).toEqual(["wt-1"]);
});
