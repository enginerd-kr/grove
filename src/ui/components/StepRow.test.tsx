import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { Line, StepLine } from "../../report/lines.ts";
import { plain } from "../test-utils.ts";
import { StepRow } from "./StepRow.tsx";

/** The spinner's first frame: every running row is caught before it ticks. */
const SPIN = "⠋";
/** ink-testing-library fixes the terminal at 100 columns. */
const COLUMNS = 100;

function step(overrides: Partial<StepLine> = {}): StepLine {
  return { kind: "step", id: 1, label: "cloning", state: "running", ...overrides };
}

/**
 * The row as text, read before the spinner can advance.
 *
 * `render` is synchronous and the spinner's first tick is 80ms away, so a
 * running row is always caught on frame one — and unmounting immediately stops
 * the interval before it can outlive the test.
 */
function frameOf(line: Line, truncate?: boolean): string {
  const instance = render(<StepRow line={line} truncate={truncate} />);
  try {
    return plain(instance.lastFrame());
  } finally {
    instance.unmount();
  }
}

describe("StepRow", () => {
  test("an info note is a dot and its text", () => {
    expect(frameOf({ kind: "info", id: 1, text: "nothing to do" })).toBe("· nothing to do");
  });

  test("a warning is marked differently from a note, so it can be found", () => {
    expect(frameOf({ kind: "warn", id: 1, text: "detached head" })).toBe("! detached head");
  });

  test("a running step is a spinner and its label", () => {
    expect(frameOf(step())).toBe(`${SPIN} cloning`);
  });

  test("a step that succeeded is a tick and its label", () => {
    expect(frameOf(step({ state: "done", label: "cloned" }))).toBe("✓ cloned");
  });

  test("a step that failed is a cross and its label", () => {
    expect(frameOf(step({ state: "failed", label: "no such remote" }))).toBe("✗ no such remote");
  });

  test("a settled step drops the spinner rather than freezing it", () => {
    expect(frameOf(step({ state: "done" }))).not.toContain(SPIN);
    expect(frameOf(step({ state: "failed" }))).not.toContain(SPIN);
  });

  test("a running step with a percent grows a bar after the label", () => {
    expect(frameOf(step({ percent: 50 }))).toBe(`${SPIN} cloning ████████░░░░░░░░  50%`);
  });

  test("the bar is 16 cells wide, whatever the percent", () => {
    for (const percent of [0, 1, 50, 99, 100]) {
      const bar = frameOf(step({ percent })).match(/[█░]+/)?.[0];

      expect(bar).toHaveLength(16);
    }
  });

  test("a percent of 0 draws an empty bar, not no bar at all", () => {
    // Absent and zero are different states: zero means "started, nothing done
    // yet", and a row that hides the bar until 1% jumps as soon as it appears.
    expect(frameOf(step({ percent: 0 }))).toBe(`${SPIN} cloning ░░░░░░░░░░░░░░░░   0%`);
  });

  test("without a percent there is no bar", () => {
    expect(frameOf(step())).not.toContain("░");
    expect(frameOf(step())).not.toContain("%");
  });

  test("a settled step never draws a bar, even if it kept its percent", () => {
    expect(frameOf(step({ state: "done", percent: 50 }))).toBe("✓ cloning");
    expect(frameOf(step({ state: "failed", percent: 50 }))).toBe("✗ cloning");
  });

  describe("truncate", () => {
    const long = "L".repeat(150);

    test("off, a long settled row wraps onto as many lines as it needs", () => {
      expect(frameOf(step({ state: "done", label: long })).split("\n").length).toBeGreaterThan(1);
    });

    test("on, a long settled row is cut to one line at the terminal edge", () => {
      const frame = frameOf(step({ state: "done", label: long }), true);

      expect(frame.split("\n")).toHaveLength(1);
      expect(frame).toHaveLength(COLUMNS);
      expect(frame.endsWith("…")).toBe(true);
    });

    test("on, a long note is cut the same way, whichever kind it is", () => {
      for (const kind of ["info", "warn"] as const) {
        const frame = frameOf({ kind, id: 1, text: long }, true);

        expect(frame.split("\n")).toHaveLength(1);
        expect(frame).toHaveLength(COLUMNS);
      }
    });

    // The running row is clipped by a one-row box rather than by `wrap`: the
    // label is measured before the bar is placed, so truncating the text would
    // still leave the row two lines tall.
    test("on, a long running row is clipped to one line", () => {
      const frame = frameOf(step({ label: long }), true);

      expect(frame.split("\n")).toHaveLength(1);
      expect(frame).toHaveLength(COLUMNS);
    });

    test("off, a long running row wraps", () => {
      expect(frameOf(step({ label: long })).split("\n").length).toBeGreaterThan(1);
    });

    // The row cuts its own label rather than leaving it to the clip, which
    // drops the label whole when it would wrap to a last line of a character
    // or two — a `--verbose` git line of exactly the wrong length would
    // otherwise become a bare spinner. 99 and 100 are those lengths at 100
    // columns; 98 and 120 are not.
    test("on, a running row whose label wraps to a 1-2 character remainder keeps its label", () => {
      for (const length of [99, 100]) {
        const frame = frameOf(step({ label: "L".repeat(length) }), true);

        expect(frame).toHaveLength(COLUMNS);
        expect(frame.startsWith(`${SPIN} LLL`)).toBe(true);
      }
    });

    test("a row that already fits is left exactly as it was", () => {
      for (const line of [
        step(),
        step({ state: "done" }),
        step({ state: "failed" }),
        step({ percent: 25 }),
        { kind: "info", id: 1, text: "nothing to do" } as const,
        { kind: "warn", id: 1, text: "detached head" } as const,
      ]) {
        expect(frameOf(line, true)).toBe(frameOf(line));
      }
    });

    test("undefined and false both mean do not truncate", () => {
      const line = step({ state: "done", label: long });

      expect(frameOf(line, false)).toBe(frameOf(line, undefined));
    });
  });
});
