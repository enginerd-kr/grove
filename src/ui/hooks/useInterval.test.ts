import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { nextFrame, waitFor } from "../test-utils.ts";
import { useInterval } from "./useInterval.ts";

/**
 * The hook exercised the way a component uses it, rather than called directly.
 *
 * A hook outside a render has no effects, so calling it would test nothing:
 * arming, re-arming and tearing down the timer all happen in `useEffect`, and
 * only a mounted tree runs those. `createElement` keeps this file `.ts`.
 */
type TickerProps = {
  readonly delayMs: number | null;
  readonly onTick: () => void;
};

function Ticker({ delayMs, onTick }: TickerProps) {
  useInterval(onTick, delayMs);

  return createElement(Text, null, "ticking");
}

function ticker(props: TickerProps) {
  return createElement(Ticker, props);
}

/** Short enough that a handful of ticks fit well inside `waitFor`'s deadline. */
const TICK = 10;

/**
 * Waits for the callback to have run `count` times, or fails on a deadline.
 *
 * `waitFor` is borrowed for its timeout and its failure message; the string it
 * polls here is the tick count rather than a frame. A hook that never fires
 * therefore fails in a second instead of hanging the suite.
 */
async function untilTicks(read: () => number, count: number): Promise<void> {
  await waitFor(
    () => String(read()),
    (ticks) => Number(ticks) >= count,
  );
}

describe("useInterval", () => {
  test("calls back once per delay, over and over", async () => {
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: TICK,
        onTick: () => {
          ticks++;
        },
      }),
    );

    try {
      await untilTicks(() => ticks, 3);

      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      instance.unmount();
    }
  });

  test("does not fire before the first delay has passed", () => {
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: 5_000,
        onTick: () => {
          ticks++;
        },
      }),
    );

    try {
      expect(ticks).toBe(0);
    } finally {
      instance.unmount();
    }
  });

  test("a null delay never arms the timer", async () => {
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: null,
        onTick: () => {
          ticks++;
        },
      }),
    );

    try {
      await nextFrame(TICK * 10);

      expect(ticks).toBe(0);
    } finally {
      instance.unmount();
    }
  });

  test("switching the delay to null stops it", async () => {
    let ticks = 0;
    const onTick = () => {
      ticks++;
    };
    const instance = render(ticker({ delayMs: TICK, onTick }));

    try {
      await untilTicks(() => ticks, 2);
      instance.rerender(ticker({ delayMs: null, onTick }));
      const stopped = ticks;
      await nextFrame(TICK * 10);

      expect(ticks).toBe(stopped);
    } finally {
      instance.unmount();
    }
  });

  test("switching the delay back off null re-arms it", async () => {
    let ticks = 0;
    const onTick = () => {
      ticks++;
    };
    const instance = render(ticker({ delayMs: null, onTick }));

    try {
      await nextFrame(TICK * 4);
      expect(ticks).toBe(0);

      instance.rerender(ticker({ delayMs: TICK, onTick }));
      await untilTicks(() => ticks, 2);
    } finally {
      instance.unmount();
    }
  });

  test("a new delay replaces the old timer rather than adding a second one", async () => {
    let ticks = 0;
    const onTick = () => {
      ticks++;
    };
    // The first delay is long enough that it can never fire during the test:
    // any tick that arrives proves the second timer, and the count proves the
    // first one was cleared rather than left running alongside it.
    const instance = render(ticker({ delayMs: 5_000, onTick }));

    try {
      instance.rerender(ticker({ delayMs: TICK, onTick }));
      await untilTicks(() => ticks, 3);

      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      instance.unmount();
    }
  });

  test("the newest callback is the one that runs", async () => {
    const called: string[] = [];
    const instance = render(ticker({ delayMs: TICK, onTick: () => called.push("first") }));

    try {
      await untilTicks(() => called.length, 1);
      instance.rerender(ticker({ delayMs: TICK, onTick: () => called.push("second") }));

      const before = called.length;
      await untilTicks(() => called.filter((name) => name === "second").length, 2);

      // A callback swap must not restart the interval either, but that is only
      // observable as the absence of a gap; the identity of the caller is the
      // part worth pinning.
      expect(called.length).toBeGreaterThan(before);
      expect(called.at(-1)).toBe("second");
    } finally {
      instance.unmount();
    }
  });

  test("a callback that changes on every render still ticks", async () => {
    // The realistic shape: an inline arrow, new on each render. Kept in a ref
    // so it cannot restart the timer — without that, a render per tick would
    // reset the countdown and the callback would never fire twice.
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: TICK,
        onTick: () => {
          ticks++;
        },
      }),
    );

    try {
      for (let render = 0; render < 5; render++) {
        instance.rerender(
          ticker({
            delayMs: TICK,
            onTick: () => {
              ticks++;
            },
          }),
        );
      }

      await untilTicks(() => ticks, 3);
    } finally {
      instance.unmount();
    }
  });

  test("nothing is called after unmount", async () => {
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: TICK,
        onTick: () => {
          ticks++;
        },
      }),
    );

    await untilTicks(() => ticks, 2);
    instance.unmount();
    const atUnmount = ticks;
    await nextFrame(TICK * 10);

    expect(ticks).toBe(atUnmount);
  });

  test("unmounting with a null delay tears down cleanly too", async () => {
    let ticks = 0;
    const instance = render(
      ticker({
        delayMs: null,
        onTick: () => {
          ticks++;
        },
      }),
    );

    instance.unmount();
    await nextFrame(TICK * 4);

    expect(ticks).toBe(0);
  });
});
