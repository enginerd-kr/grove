import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { nextFrame, plain, waitFor } from "../test-utils.ts";
import { LogView } from "./LogView.tsx";

// A tick this short keeps the run fast; assertions poll instead of sleeping.
const TICK = 5;

afterEach(cleanup);

test("streams lines while active", async () => {
  const { lastFrame } = render(<LogView isActive tickMs={TICK} />);

  expect(plain(lastFrame())).toContain("Waiting for output…");

  const frame = await waitFor(lastFrame, (f) => f.includes("001 warn"));

  expect(frame).toContain("000 info fetching manifest");
  expect(frame).toContain("001 warn resolved 133 packages");
});

test("stays idle while inactive", async () => {
  const { lastFrame } = render(<LogView isActive={false} tickMs={TICK} />);

  await nextFrame(TICK * 20);

  expect(plain(lastFrame())).toContain("Waiting for output…");
});

test("keeps only the last lines", async () => {
  const { lastFrame } = render(<LogView isActive tickMs={TICK} />);

  const frame = await waitFor(lastFrame, (f) => f.includes("009 "));

  // MAX_LINES is 8, so the oldest lines have scrolled off.
  expect(frame).not.toContain("000 ");
  expect(frame).not.toContain("001 ");
});

test("p pauses the stream and c clears it", async () => {
  const { stdin, lastFrame } = render(<LogView isActive tickMs={TICK} />);

  await waitFor(lastFrame, (f) => f.includes("000 info"));
  stdin.write("p");

  const paused = await waitFor(lastFrame, (f) => f.includes("⏸ paused"));

  // Nothing may arrive once paused — the frame stays identical.
  await nextFrame(TICK * 20);
  expect(plain(lastFrame())).toBe(paused);

  stdin.write("c");
  await waitFor(lastFrame, (f) => f.includes("Waiting for output…"));
});
