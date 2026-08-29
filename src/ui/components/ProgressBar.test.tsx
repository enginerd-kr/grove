import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { ProgressBar } from "./ProgressBar.tsx";

const FILL = "█";
const EMPTY = "░";

function frameOf(element: React.ReactElement): string {
  const instance = render(element);
  try {
    return plain(instance.lastFrame());
  } finally {
    instance.unmount();
  }
}

/** The bar without its percentage, so width assertions read as counts. */
function barOf(value: number, width?: number): string {
  return frameOf(<ProgressBar value={value} width={width} showPercent={false} />);
}

describe("ProgressBar", () => {
  test("empty at 0", () => {
    expect(frameOf(<ProgressBar value={0} width={8} />)).toBe(`${EMPTY.repeat(8)}   0%`);
  });

  test("half full at 0.5", () => {
    expect(frameOf(<ProgressBar value={0.5} width={8} />)).toBe(
      `${FILL.repeat(4)}${EMPTY.repeat(4)}  50%`,
    );
  });

  test("full at 1", () => {
    expect(frameOf(<ProgressBar value={1} width={8} />)).toBe(`${FILL.repeat(8)} 100%`);
  });

  test("the percentage is right-aligned in three columns, so the bar never shifts", () => {
    const widths = [0, 0.05, 0.5, 1].map(
      (value) => frameOf(<ProgressBar value={value} width={8} />).length,
    );

    expect(new Set(widths).size).toBe(1);
    expect(frameOf(<ProgressBar value={0.05} width={8} />).endsWith("   5%")).toBe(true);
  });

  test("above 1 is clamped to full rather than overflowing the bar", () => {
    expect(frameOf(<ProgressBar value={5} width={8} />)).toBe(`${FILL.repeat(8)} 100%`);
    expect(barOf(1.000001, 8)).toBe(FILL.repeat(8));
  });

  test("below 0 is clamped to empty rather than repeating a negative count", () => {
    expect(frameOf(<ProgressBar value={-1} width={8} />)).toBe(`${EMPTY.repeat(8)}   0%`);
    expect(frameOf(<ProgressBar value={Number.NEGATIVE_INFINITY} width={8} />)).toBe(
      `${EMPTY.repeat(8)}   0%`,
    );
  });

  test("NaN reads as no progress, not as a crash", () => {
    // `String.repeat(NaN)` would throw, taking the whole render down with it —
    // and a percent is one division by zero away from being NaN.
    expect(frameOf(<ProgressBar value={Number.NaN} width={8} />)).toBe(`${EMPTY.repeat(8)}   0%`);
  });

  test("Infinity is clamped like any other out-of-range value", () => {
    expect(frameOf(<ProgressBar value={Number.POSITIVE_INFINITY} width={8} />)).toBe(
      `${FILL.repeat(8)} 100%`,
    );
  });

  test("the bar is always exactly `width` cells wide, whatever the value", () => {
    for (const value of [-1, 0, 0.01, 0.33, 0.5, 0.99, 1, 2, Number.NaN]) {
      expect(barOf(value, 16)).toHaveLength(16);
    }
  });

  test("filled and empty cells always add up to the width", () => {
    for (let step = 0; step <= 20; step++) {
      const bar = barOf(step / 20, 10);
      const filled = [...bar].filter((cell) => cell === FILL).length;
      const empty = [...bar].filter((cell) => cell === EMPTY).length;

      expect(filled + empty).toBe(10);
    }
  });

  test("the fill is rounded, so a value never lands between two cells", () => {
    // 3/8 of 8 cells is 3 exactly; 0.4 of 8 is 3.2, which rounds down to 3.
    expect(barOf(3 / 8, 8)).toBe(`${FILL.repeat(3)}${EMPTY.repeat(5)}`);
    expect(barOf(0.4, 8)).toBe(`${FILL.repeat(3)}${EMPTY.repeat(5)}`);
    expect(barOf(0.44, 8)).toBe(`${FILL.repeat(4)}${EMPTY.repeat(4)}`);
  });

  test("a value just short of complete still draws a full-looking bar", () => {
    // Rounding, not flooring: 99% of a 24-cell bar is 23.76 cells. Flooring
    // would leave a gap that reads as stalled.
    expect(barOf(0.99, 24)).toBe(FILL.repeat(24));
  });

  test("defaults to 24 cells", () => {
    expect(barOf(1)).toHaveLength(24);
    expect(frameOf(<ProgressBar value={0.5} />)).toBe(`${FILL.repeat(12)}${EMPTY.repeat(12)}  50%`);
  });

  test("width 1 is a two-state bar, not a rounding error", () => {
    expect(barOf(0.49, 1)).toBe(EMPTY);
    expect(barOf(0.5, 1)).toBe(FILL);
  });

  test("width 0 draws no bar at all, leaving just the percentage", () => {
    expect(barOf(0.5, 0)).toBe("");
    expect(frameOf(<ProgressBar value={0.5} width={0} />)).toBe("  50%");
  });

  test("showPercent false drops the percentage and its leading space", () => {
    expect(frameOf(<ProgressBar value={1} width={4} showPercent={false} />)).toBe(FILL.repeat(4));
  });

  test("the colour is a style, so it changes no character of the plain output", () => {
    const accent = frameOf(<ProgressBar value={0.5} width={8} />);
    const red = frameOf(<ProgressBar value={0.5} width={8} color="red" />);

    expect(red).toBe(accent);
  });
});
