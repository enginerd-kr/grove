import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { recorder } from "../core/test-utils.ts";
import { type KeySource, terminalAsker, terminalChooser } from "./ask.ts";

/** A stdin that answers with one key, and records how it was handled. */
function keyboard(answer: string): { readonly stdin: KeySource; readonly log: string[] } {
  const events = new EventEmitter();
  const log: string[] = [];

  return {
    log,
    stdin: {
      setRawMode: (mode) => log.push(`raw ${mode}`),
      resume: () => {
        log.push("resume");
        // Typed after the listener is on, the way a person is.
        queueMicrotask(() => events.emit("data", Buffer.from(answer)));
      },
      pause: () => log.push("pause"),
      once: (event, listener) => events.once(event, listener),
    },
  };
}

describe("terminalAsker", () => {
  test("puts the question through the reporter and reads one raw key", async () => {
    const { stdin, log } = keyboard("y");
    const { reporter, err } = recorder();

    expect(await terminalAsker(reporter, stdin)("run 2 commands?")).toBe(true);

    // Through the reporter, not straight to stderr: the drawn reporter owns
    // that stream, and a line written past it lands inside a frame.
    expect(err).toEqual(["· run 2 commands? [y/N]\n"]);
    // Raw for exactly the one key, and paused afterwards so the process can end.
    expect(log).toEqual(["raw true", "resume", "raw false", "pause"]);
  });

  test("only `y` is yes", async () => {
    const { reporter } = recorder();

    expect(await terminalAsker(reporter, keyboard("Y").stdin)("?")).toBe(true);
    expect(await terminalAsker(reporter, keyboard("n").stdin)("?")).toBe(false);
    expect(await terminalAsker(reporter, keyboard("\r").stdin)("?")).toBe(false);
    // One key, not a word: `yes` is what a shell prompt takes, and this is
    // read the way the screen reads its `y`.
    expect(await terminalAsker(reporter, keyboard("yes").stdin)("?")).toBe(false);
  });
});

describe("terminalChooser", () => {
  const CHOICES = [
    { key: "1", label: "upstream", detail: "origin/feat/login" },
    { key: "2", label: "trunk", detail: "origin/main" },
    { key: "3", label: "feat/search" },
  ];

  test("lists the choices under the question, and answers with the key pressed", async () => {
    const { stdin, log } = keyboard("2");
    const { reporter, err } = recorder();

    expect(
      await terminalChooser(reporter, stdin)("rebase feat/login onto which base?", CHOICES),
    ).toBe("2");

    // The labels padded to a column, the detail beside each that has one, and
    // the keys said as a span — all through the reporter, for the reason the
    // yes/no question goes through it.
    expect(err).toEqual([
      "· rebase feat/login onto which base?\n",
      "·   1  upstream     origin/feat/login\n",
      "·   2  trunk        origin/main\n",
      "·   3  feat/search\n",
      "· 1-3 picks one; anything else leaves it\n",
    ]);
    expect(log).toEqual(["raw true", "resume", "raw false", "pause"]);
  });

  test("two choices are said as one or the other", async () => {
    const { reporter, err } = recorder();

    await terminalChooser(reporter, keyboard("1").stdin)("?", CHOICES.slice(0, 2));

    expect(err.at(-1)).toBe("· 1 or 2 picks one; anything else leaves it\n");
  });

  test("a key that is no choice picks nothing", async () => {
    const { reporter } = recorder();

    expect(await terminalChooser(reporter, keyboard("x").stdin)("?", CHOICES)).toBeUndefined();
    expect(await terminalChooser(reporter, keyboard("\r").stdin)("?", CHOICES)).toBeUndefined();
    // One key: a `12` is not a twelfth row.
    expect(await terminalChooser(reporter, keyboard("12").stdin)("?", CHOICES)).toBeUndefined();
  });
});
