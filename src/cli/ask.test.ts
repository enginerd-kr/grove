import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { recorder } from "../core/test-utils.ts";
import { type KeySource, terminalAsker } from "./ask.ts";

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
