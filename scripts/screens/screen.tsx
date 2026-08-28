import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type { ReactElement } from "react";
import { plain } from "../../src/ui/test-utils.ts";

/**
 * A terminal that only remembers what was drawn on it.
 *
 * Ink writes whole frames here — `debug: true` turns off the cursor arithmetic
 * a real terminal needs — so the last write *is* the screen, escapes and all.
 * The PTY harness in `src/ui/e2e-utils.ts` is the other way to drive the app,
 * and it is the wrong one here: it hands back a stream of repaints rather than
 * a screen, and a picture has to be one frame.
 */
class Screen extends EventEmitter {
  frames: string[] = [];
  last: string | undefined;

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }

  write = (frame: string): void => {
    this.frames.push(frame);
    this.last = frame;
  };
}

/** A keyboard nothing is typed on unless a shot asks for it. */
class Keyboard extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;

  write = (data: string): void => {
    this.pending = data;
    this.emit("readable");
    this.emit("data", data);
  };

  read = (): string | null => {
    const data = this.pending;
    this.pending = null;

    return data;
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export type Session = {
  /** The screen as it stands, escapes intact — what becomes the picture. */
  readonly frame: () => string;
  /** The same frame with every escape stripped, for anchoring on. */
  readonly plain: () => string;
  /** Types into a prompt, a keypress at a time, the way a person would. */
  readonly type: (text: string) => Promise<void>;
  /** Sends one key sequence whole — an arrow, `enter`, a control code. */
  readonly press: (sequence: string) => Promise<void>;
  /** Waits until the drawn frame contains `text`, or gives up saying so. */
  readonly until: (text: string, timeoutMs?: number) => Promise<string>;
  /** Lets timers and promises run for a beat. */
  readonly settle: (ms?: number) => Promise<void>;
  readonly close: () => void;
};

const settleFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a component on a screen of the given size. */
export function open(element: ReactElement, columns: number, rows: number): Session {
  const screen = new Screen(columns, rows);
  const keyboard = new Keyboard();

  const instance = inkRender(element, {
    stdout: screen as unknown as NodeJS.WriteStream,
    stderr: screen as unknown as NodeJS.WriteStream,
    stdin: keyboard as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    frame: () => screen.last ?? "",
    plain: () => plain(screen.last),
    async type(text) {
      for (const char of text) {
        keyboard.write(char);
        await settleFor(20);
      }
    },
    async press(sequence) {
      keyboard.write(sequence);
      await settleFor(50);
    },
    async until(text, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const current = screen.last ?? "";
        if (plain(current).includes(text)) return current;

        if (Date.now() > deadline) {
          throw new Error(`never drew ${JSON.stringify(text)}. Last frame:\n${plain(current)}`);
        }

        await settleFor(25);
      }
    },
    settle: (ms = 60) => settleFor(ms),
    close() {
      instance.unmount();
      instance.cleanup();
    },
  };
}
