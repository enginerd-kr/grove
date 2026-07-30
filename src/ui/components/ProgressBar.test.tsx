import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { ProgressBar } from "./ProgressBar.tsx";

afterEach(cleanup);

test("renders an empty bar at 0", () => {
  const { lastFrame } = render(<ProgressBar value={0} width={10} />);

  expect(plain(lastFrame())).toBe(`${"░".repeat(10)}   0%`);
});

test("renders a full bar at 1", () => {
  const { lastFrame } = render(<ProgressBar value={1} width={10} />);

  expect(plain(lastFrame())).toBe(`${"█".repeat(10)} 100%`);
});

test("splits the bar proportionally", () => {
  const { lastFrame } = render(<ProgressBar value={0.5} width={10} />);

  expect(plain(lastFrame())).toBe(`${"█".repeat(5)}${"░".repeat(5)}  50%`);
});

test("clamps out-of-range and NaN values", () => {
  for (const value of [-2, 5, Number.NaN]) {
    const { lastFrame } = render(<ProgressBar value={value} width={4} />);
    const frame = plain(lastFrame());

    expect(frame).not.toContain("-");
    expect([...frame].filter((char) => char === "█" || char === "░")).toHaveLength(4);
  }
});

test("hides the percentage when asked", () => {
  const { lastFrame } = render(<ProgressBar value={0.5} width={4} showPercent={false} />);

  expect(plain(lastFrame())).toBe("██░░");
});
