import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "./App.tsx";
import { keys, nextFrame, plain, waitFor } from "./test-utils.ts";

afterEach(cleanup);

test("opens on the counter tab", () => {
  const { lastFrame } = render(<App />);
  const frame = plain(lastFrame());

  expect(frame).toContain("1 Counter");
  expect(frame).toContain("Count 0");
  expect(frame).toContain("q quit");
});

test("number keys switch tabs", async () => {
  const { stdin, lastFrame } = render(<App />);

  stdin.write("2");

  const frame = await waitFor(lastFrame, (f) => f.includes("2/5 done"));
  expect(frame).toContain("space toggle");
  expect(frame).not.toContain("Count 0");
});

test("tab and shift+tab cycle through the tabs", async () => {
  const { stdin, lastFrame } = render(<App />);

  stdin.write(keys.tab);
  await waitFor(lastFrame, (f) => f.includes("2/5 done"));

  stdin.write(keys.tab);
  await waitFor(lastFrame, (f) => f.includes("p pause"));

  // Third tab is the last one, so one more wraps back to the counter.
  stdin.write(keys.tab);
  await waitFor(lastFrame, (f) => f.includes("Count 0"));

  stdin.write(keys.shiftTab);
  await waitFor(lastFrame, (f) => f.includes("p pause"));
});

test("only the visible view reacts to keys, and hidden views keep their state", async () => {
  const { stdin, lastFrame } = render(<App />);

  stdin.write(keys.right);
  stdin.write(keys.right);
  await waitFor(lastFrame, (f) => f.includes("Count 2"));

  stdin.write("2");
  await waitFor(lastFrame, (f) => f.includes("2/5 done"));
  stdin.write(keys.right); // counter must ignore this while hidden
  await nextFrame();
  stdin.write("1");

  await waitFor(lastFrame, (f) => f.includes("Count 2"));
});

test("space toggles the selected task", async () => {
  const { stdin, lastFrame } = render(<App initialTab={1} />);

  expect(plain(lastFrame())).toContain("2/5 done");

  stdin.write(" ");
  await waitFor(lastFrame, (f) => f.includes("1/5 done"));

  stdin.write(keys.down);
  stdin.write(" ");
  await waitFor(lastFrame, (f) => f.includes("0/5 done"));
});

test("q tears down the app and later input is ignored", async () => {
  const { stdin, lastFrame } = render(<App />);
  expect(plain(lastFrame())).toContain("1 Counter");

  stdin.write("q");
  const frameAtExit = await waitFor(lastFrame, (f) => !f.includes("1 Counter"));

  stdin.write("2");
  await nextFrame();
  expect(plain(lastFrame())).toBe(frameAtExit);
});
