import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { nextFrame, plain, waitFor } from "../test-utils.ts";
import { Spinner } from "./Spinner.tsx";

/** The braille cycle, in order. Not exported by the component, so restated. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The same cycle, widened: `toContain` on the tuple would demand a literal. */
const CYCLE: readonly string[] = FRAMES;

/**
 * Short enough that a full cycle fits inside `waitFor`'s deadline.
 *
 * Every wait below is a `waitFor` on the frame rather than a sleep of a fixed
 * length, so a slow machine makes the test slower, never redder — and a
 * spinner that stopped fails on the deadline instead of hanging.
 */
const TICK = 10;

/**
 * Waits until the component has drawn `count` frames, then returns them all.
 *
 * Reading the recorded frames rather than polling `lastFrame` is what makes a
 * "one frame per tick" assertion honest: a poll slower than the interval skips
 * frames, and a poll faster than it still races. `waitFor` is borrowed for its
 * deadline — the string it is handed is the count, not a frame.
 */
async function drawn(instance: { readonly frames: string[] }, count: number): Promise<string[]> {
  await waitFor(
    () => String(instance.frames.length),
    (length) => Number(length) >= count,
  );

  return instance.frames.map(plain);
}

/**
 * The spinner's clock, turned by hand.
 *
 * The tests that say which frame follows which cannot let the interval run:
 * a tick's frame is drawn in a React scheduler task, not in the tick, and the
 * scheduler hands the event loop back after 5ms of work. On a starved runner
 * — the macOS shard, three times slower than ubuntu — the next tick came due
 * in that gap, React folded both updates into one commit, and a glyph was
 * never drawn. Nothing the component promises was broken; the test had
 * assumed a frame per tick, which is the interval racing the renderer.
 *
 * So `setInterval` is captured instead of started, and `tick` calls what it
 * captured once and waits for the frame that call produces before returning.
 * Two updates can never be pending at once, and "one frame per tick, in
 * order" is exactly what is asserted. `restore` puts the real one back;
 * the timer handed to the component is real, so its `clearInterval` on
 * unmount has something to clear.
 */
function clock() {
  const real = globalThis.setInterval;
  let callback: (() => void) | undefined;
  globalThis.setInterval = ((fn: () => void) => {
    callback = fn;
    return real(() => {}, 2_000_000_000);
  }) as typeof setInterval;

  return {
    async tick(instance: { readonly frames: string[] }, times = 1): Promise<void> {
      for (let i = 0; i < times; i++) {
        // The interval is started from an effect, which lands after the mount.
        await waitFor(
          () => (callback ? "started" : ""),
          (frame) => frame === "started",
        );
        const before = instance.frames.length;
        callback?.();
        await drawn(instance, before + 1);
      }
    },
    restore(): void {
      globalThis.setInterval = real;
    },
  };
}

describe("Spinner", () => {
  test("starts on the first frame, with nothing else on the line", () => {
    const instance = render(<Spinner intervalMs={null} />);
    try {
      expect(plain(instance.lastFrame())).toBe(FRAMES[0]);
    } finally {
      instance.unmount();
    }
  });

  test("puts the label one space after the spinner", () => {
    const instance = render(<Spinner label="cloning" intervalMs={null} />);
    try {
      expect(plain(instance.lastFrame())).toBe(`${FRAMES[0]} cloning`);
    } finally {
      instance.unmount();
    }
  });

  test("an empty label adds no trailing space", () => {
    const instance = render(<Spinner label="" intervalMs={null} />);
    try {
      expect(plain(instance.lastFrame())).toBe(FRAMES[0]);
    } finally {
      instance.unmount();
    }
  });

  test("advances one frame per interval, keeping the label", async () => {
    const ticks = clock();
    const instance = render(<Spinner label="cloning" intervalMs={TICK} />);
    try {
      await ticks.tick(instance, 3);
      expect(instance.frames.map(plain).slice(0, 4)).toEqual(
        FRAMES.slice(0, 4).map((frame) => `${frame} cloning`),
      );
    } finally {
      instance.unmount();
      ticks.restore();
    }
  });

  test("wraps back round to the first frame after the last", async () => {
    const ticks = clock();
    const instance = render(<Spinner intervalMs={TICK} />);
    try {
      // Proof of the modulo rather than of the tenth tick: without it the
      // component would index past the end and draw nothing.
      await ticks.tick(instance, 11);
      expect(instance.frames.map(plain).slice(0, 12)).toEqual([...FRAMES, FRAMES[0], FRAMES[1]]);
    } finally {
      instance.unmount();
      ticks.restore();
    }
  });

  test("never draws anything outside the cycle", async () => {
    const instance = render(<Spinner intervalMs={TICK} />);
    try {
      for (const frame of await drawn(instance, 25)) expect(CYCLE).toContain(frame);
    } finally {
      instance.unmount();
    }
  });

  test("a null interval freezes it", async () => {
    const instance = render(<Spinner label="held" intervalMs={null} />);
    try {
      await nextFrame(TICK * 8);

      expect(plain(instance.lastFrame())).toBe(`${FRAMES[0]} held`);
      expect(instance.frames.map(plain)).toEqual([`${FRAMES[0]} held`]);
    } finally {
      instance.unmount();
    }
  });

  test("freezing mid-cycle holds the frame it reached", async () => {
    const instance = render(<Spinner intervalMs={TICK} />);
    try {
      await drawn(instance, 3);
      instance.rerender(<Spinner intervalMs={null} />);
      const held = plain(instance.lastFrame());
      const frozen = instance.frames.length;
      await nextFrame(TICK * 8);

      expect(plain(instance.lastFrame())).toBe(held);
      expect(instance.frames).toHaveLength(frozen);
    } finally {
      instance.unmount();
    }
  });

  test("unfreezing starts it moving again", async () => {
    const ticks = clock();
    const instance = render(<Spinner intervalMs={null} />);
    try {
      await nextFrame(TICK * 4);
      expect(plain(instance.lastFrame())).toBe(FRAMES[0]);

      instance.rerender(<Spinner intervalMs={TICK} />);
      const held = instance.frames.length;

      await ticks.tick(instance, 2);
      expect(instance.frames.map(plain).slice(held, held + 2)).toEqual([FRAMES[1], FRAMES[2]]);
    } finally {
      instance.unmount();
      ticks.restore();
    }
  });

  test("it stops when it is unmounted", async () => {
    const instance = render(<Spinner intervalMs={TICK} />);
    await drawn(instance, 2);

    instance.unmount();
    const settled = instance.frames.length;
    await nextFrame(TICK * 8);

    expect(instance.frames).toHaveLength(settled);
  });
});
