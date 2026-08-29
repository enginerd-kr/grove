import { describe, expect, test } from "bun:test";
import { GroveError } from "../../core/errors.ts";
import { detailLines, type Message, messageFor, messageRows } from "./message.ts";

/**
 * How a failure reaches the screen, and how much screen it will take.
 *
 * Two claims are being tested here and the second is the one that misdraws when
 * it slips: `messageRows` is what the list budgets its own height against, so
 * it has to agree with `detailLines` for every shape a message can have — an
 * error with no details, one with more than fit, one with a hint. A message
 * that reserves four rows and draws five pushes the bottom row off the screen.
 */

/** The invariant the screen depends on, asserted the same way every time. */
function agrees(message: Message): void {
  expect(messageRows(message)).toBe(
    1 + detailLines(message).length + (message.hint === undefined ? 0 : 1),
  );
}

describe("messageFor", () => {
  test("a GroveError arrives whole — message, details and hint", () => {
    const error = new GroveError("refused", "feat/login has uncommitted changes", {
      details: ["scratch.txt", "notes.md"],
      hint: "commit them, or remove with --force",
    });

    expect(messageFor(error)).toEqual({
      kind: "error",
      text: "feat/login has uncommitted changes",
      details: ["scratch.txt", "notes.md"],
      hint: "commit them, or remove with --force",
    });
  });

  test("a GroveError with nothing to add carries no empty details", () => {
    // `undefined` rather than `[]`, because `detailLines` would draw an empty
    // row for a list that exists and is empty.
    expect(messageFor(new GroveError("git-failed", "git said no"))).toEqual({
      kind: "error",
      text: "git said no",
      details: undefined,
      hint: undefined,
    });
  });

  test("the code is not shown — the sentence was written to be read", () => {
    const message = messageFor(new GroveError("not-a-repo", "no repository here"));

    expect(message.text).toBe("no repository here");
    expect(JSON.stringify(message)).not.toContain("not-a-repo");
  });

  test("a plain Error is a bug here, so it gets its message and no guidance", () => {
    expect(messageFor(new Error("cannot read properties of undefined"))).toEqual({
      kind: "error",
      text: "cannot read properties of undefined",
      details: undefined,
      hint: undefined,
    });
  });

  test("a subclass of Error is still an Error", () => {
    expect(messageFor(new TypeError("not a function")).text).toBe("not a function");
  });

  test("a thrown string is shown as it was thrown", () => {
    expect(messageFor("something went wrong")).toEqual({
      kind: "error",
      text: "something went wrong",
    });
  });

  test("nothing thrown at all still produces a line rather than a blank one", () => {
    expect(messageFor(undefined)).toEqual({ kind: "error", text: "undefined" });
    expect(messageFor(null)).toEqual({ kind: "error", text: "null" });
    expect(messageFor({ code: 7 })).toEqual({ kind: "error", text: "[object Object]" });
  });

  test("every failure is an error, never an info", () => {
    for (const thrown of [new GroveError("gh", "no gh"), new Error("boom"), "boom", 0]) {
      expect(messageFor(thrown).kind).toBe("error");
    }
  });
});

describe("detailLines", () => {
  test("no details is no rows", () => {
    expect(detailLines({ kind: "error", text: "boom" })).toEqual([]);
    expect(detailLines({ kind: "error", text: "boom", details: [] })).toEqual([]);
  });

  test("a few lines are drawn as they are, each with its place", () => {
    expect(detailLines({ kind: "error", text: "boom", details: ["one", "two"] })).toEqual([
      { id: "0", text: "one" },
      { id: "1", text: "two" },
    ]);
  });

  test("two identical lines are two rows, told apart by position", () => {
    const rows = detailLines({ kind: "error", text: "boom", details: ["same", "same"] });

    expect(rows.map((row) => row.text)).toEqual(["same", "same"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  test("exactly the limit is drawn in full, with nothing standing in for it", () => {
    const rows = detailLines({ kind: "error", text: "boom", details: ["1", "2", "3", "4", "5"] });

    expect(rows).toHaveLength(5);
    expect(rows.at(-1)?.text).toBe("5");
  });

  test("past the limit, the last row counts what did not fit", () => {
    const details = ["1", "2", "3", "4", "5", "6", "7"];
    const rows = detailLines({ kind: "error", text: "boom", details });

    expect(rows.map((row) => row.text)).toEqual(["1", "2", "3", "4", "5", "… 2 more line(s)"]);
  });

  test("a very long list is still six rows — the panel cannot set its own height", () => {
    const details = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const rows = detailLines({ kind: "error", text: "boom", details });

    expect(rows).toHaveLength(6);
    expect(rows.at(-1)?.text).toBe("… 495 more line(s)");
  });

  test("long text is not wrapped or trimmed here — the screen decides that", () => {
    const long = "x".repeat(400);
    const rows = detailLines({ kind: "error", text: "boom", details: [long] });

    expect(rows[0]?.text).toBe(long);
  });
});

describe("messageRows", () => {
  test("a bare line is one row", () => {
    expect(messageRows({ kind: "info", text: "refreshed" })).toBe(1);
  });

  test("a hint is one more row", () => {
    expect(messageRows({ kind: "error", text: "boom", hint: "try again" })).toBe(2);
  });

  test("details are counted as they are drawn, capped included", () => {
    expect(messageRows({ kind: "error", text: "boom", details: ["a", "b"] })).toBe(3);
    expect(
      messageRows({ kind: "error", text: "boom", details: ["a", "b", "c", "d", "e", "f"] }),
    ).toBe(7);
  });

  test("the budget matches what is drawn, for every shape a message has", () => {
    const details = ["a", "b", "c", "d", "e", "f", "g"];

    for (const message of [
      { kind: "info", text: "done" },
      { kind: "info", text: "done", hint: "press ?" },
      { kind: "error", text: "boom" },
      { kind: "error", text: "boom", details: [] },
      { kind: "error", text: "boom", details: ["only"] },
      { kind: "error", text: "boom", details: details.slice(0, 5) },
      { kind: "error", text: "boom", details },
      { kind: "error", text: "boom", details, hint: "read it" },
      { kind: "error", text: "", details: [""], hint: "" },
    ] satisfies readonly Message[]) {
      agrees(message);
    }
  });

  test("what `messageFor` produces is budgeted correctly too", () => {
    const error = new GroveError("setup-failed", '"bun install" exited 1', {
      details: ["error: lockfile had changes", "run `bun install` by hand"],
      hint: "read .grove.toml",
    });

    const message = messageFor(error);

    agrees(message);
    expect(messageRows(message)).toBe(4);
  });
});
