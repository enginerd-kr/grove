import { describe, expect, test } from "bun:test";
import { nextFrame, plain } from "../ui/test-utils.ts";
import { createInkReporter } from "./ink-reporter.tsx";
import type { Reporter } from "./reporter.ts";

/**
 * The drawing reporter, driven through the streams it actually writes to.
 *
 * `ink-testing-library` cannot render this one: `createInkReporter` calls
 * Ink's own `render` with `stdout: process.stderr` and exports no component, so
 * there is no tree to hand to it. Swapping `write` on the two process streams
 * reaches the same frames — and it is the only way to test the half of this
 * file that is *about* those streams: that drawing goes to stderr and results
 * are held back for stdout until the UI is gone.
 */

/**
 * Any one of the spinner's braille frames, as a regex fragment.
 *
 * Which frame a live row had reached by the time the UI closed is a matter of
 * milliseconds, so pinning one would make every assertion below a race.
 */
const SPIN = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

/** A running row, anchored to its own line. */
function row(text: string): RegExp {
  return new RegExp(`^${SPIN} ${text}$`, "m");
}

/**
 * Long enough for Ink to have committed the pending renders.
 *
 * Ink throttles to 30fps, and the store's updates arrive from outside React, so
 * the settled rows are written a frame or two after the call that settled them.
 */
const FLUSH = 120;

type Captured = {
  /** Everything written to stderr, ANSI stripped. */
  readonly screen: string;
  /** Whatever had reached stdout before `close()` was called. */
  readonly heldBack: string;
  /** Everything on stdout once `close()` has returned. */
  readonly stdout: string;
};

/**
 * Replaces a stream's `write`, and reports it as a pipe rather than a terminal.
 *
 * `isTTY` is forced off so the run is the same whether the suite was started
 * from a terminal or from a pipe: on a TTY Ink repaints and erases, and the
 * accumulated bytes would then hold every intermediate frame — which makes
 * "the finished screen never said this" impossible to assert.
 */
function capture(stream: NodeJS.WriteStream, seen: string[]): () => void {
  const write = stream.write;
  const isTty = Object.getOwnPropertyDescriptor(stream, "isTTY");

  Object.defineProperty(stream, "isTTY", { value: false, configurable: true, writable: true });
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    seen.push(String(chunk));
    // Ink queues an empty write as a barrier at unmount and waits for its
    // callback; without this, `close()` would never resolve.
    const done = rest.find((argument) => typeof argument === "function");
    if (typeof done === "function") (done as () => void)();

    return true;
  }) as typeof stream.write;

  return () => {
    stream.write = write;
    if (isTty === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", isTty);
  };
}

async function draw(run: (reporter: Reporter) => void | Promise<void>): Promise<Captured> {
  const err: string[] = [];
  const out: string[] = [];
  const restoreErr = capture(process.stderr, err);
  const restoreOut = capture(process.stdout, out);
  let heldBack = "";

  try {
    const reporter = createInkReporter();
    await run(reporter);
    await nextFrame(FLUSH);
    heldBack = out.join("");
    await reporter.close();
  } finally {
    // Always, and before any assertion: leaving a swapped `write` behind would
    // silence the test runner itself.
    restoreOut();
    restoreErr();
  }

  return { screen: plain(err.join("")), heldBack, stdout: out.join("") };
}

describe("createInkReporter", () => {
  test("draws a settled step with its mark", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning").succeed("cloned into main");
    });

    expect(screen).toContain("✓ cloned into main");
  });

  test("draws a whole transcript: marks, notes and warnings, in order", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning").succeed("cloned");
      reporter.info("2 worktrees");
      reporter.step("fetching").fail("no such remote");
      reporter.warn("detached head");
    });

    expect(screen).toContain("✓ cloned\n· 2 worktrees\n✗ no such remote\n! detached head\n");
  });

  test("a settled row is printed once, not repainted", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning").succeed("cloned");
    });

    // `Static` is what keeps a finished row off every later frame; without it
    // a long command redraws its whole history on each spinner tick.
    expect(screen.split("✓ cloned")).toHaveLength(2);
  });

  test("a step still running when the UI closes keeps its spinner and the cancel hint", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning");
    });

    expect(screen).toMatch(row("cloning"));
    expect(screen).toContain("ctrl+c cancel");
  });

  test("a running step draws its progress bar", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning").progress(50);
    });

    expect(screen).toMatch(row("cloning ████████░░░░░░░░  50%"));
  });

  test("update renames the running row rather than adding another", async () => {
    const { screen } = await draw((reporter) => {
      const step = reporter.step("cloning");
      step.update("resolving deltas");
    });

    expect(screen).toMatch(row("resolving deltas"));
    expect(screen).not.toContain("cloning");
  });

  test("the cancel hint is gone once nothing is running", async () => {
    const { screen } = await draw((reporter) => {
      reporter.step("cloning").succeed();
    });

    // Non-interactive rendering defers the live frame to unmount, so the only
    // frame that could carry the hint is the one drawn after everything settled.
    expect(screen).not.toContain("ctrl+c");
  });

  test("results are held back until the UI has released the terminal", async () => {
    const { heldBack, stdout } = await draw((reporter) => {
      reporter.step("listing").succeed();
      reporter.out("/repos/app/main");
      reporter.out("/repos/app/feat/login");
    });

    // A result printed mid-repaint lands inside a frame Ink is about to erase.
    expect(heldBack).toBe("");
    expect(stdout).toBe("/repos/app/main\n/repos/app/feat/login\n");
  });

  test("a result that already ends in a newline is not given a second one", async () => {
    const { stdout } = await draw((reporter) => {
      reporter.out('[\n  "main"\n]\n');
    });

    expect(stdout).toBe('[\n  "main"\n]\n');
  });

  test("nothing it draws reaches stdout", async () => {
    const { stdout } = await draw((reporter) => {
      const step = reporter.step("cloning");
      step.progress(50);
      step.update("resolving deltas");
      step.succeed("cloned");
      reporter.info("2 worktrees");
      reporter.warn("detached head");
      reporter.step("fetching").fail("no such remote");
    });

    // The reason `grove list --json | jq` works while a spinner is on screen.
    expect(stdout).toBe("");
  });

  test("closing twice does not throw or print the results again", async () => {
    const { stdout } = await draw(async (reporter) => {
      reporter.out("main");
      await nextFrame(FLUSH);
      await reporter.close();
    });

    expect(stdout).toBe("main\n");
  });

  test("a reporter that was given nothing to do draws nothing", async () => {
    const { screen, stdout } = await draw(() => {});

    expect(screen.trim()).toBe("");
    expect(stdout).toBe("");
  });

  // `<Static>` only ever appends: it writes the items past the count it last
  // saw. So settled lines reach it in the order they settled — a step that
  // closes after a note was printed lands after that note, rather than being
  // inserted before it and costing the transcript both rows.
  test("a note printed while a step runs does not swallow the step's closing row", async () => {
    const { screen } = await draw(async (reporter) => {
      const step = reporter.step("cloning");
      reporter.info("2 worktrees");
      // The flush is what exposes it: settling in the same tick as the note
      // batches into one render, and Static sees a list that only grew.
      await nextFrame(FLUSH);
      step.succeed("cloned");
      await nextFrame(FLUSH);
    });

    expect(screen).toContain("✓ cloned");
    expect(screen.split("· 2 worktrees")).toHaveLength(2);
  });
});
