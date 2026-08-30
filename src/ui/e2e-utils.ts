import { plain } from "./test-utils.ts";

/**
 * Drives the real `cli.tsx` binary inside a pseudo-terminal.
 *
 * `ink-testing-library` fakes stdout (columns hardcoded to 100, no `isTTY`) and
 * stubs out `setRawMode`, so it can never exercise what a terminal actually
 * changes — whether the Ink reporter is chosen at all, the exit code, a resize.
 * `Bun.spawn({ terminal })` gives the child a real PTY — no `node-pty` needed,
 * which matters because Bun cannot load its C++ addon.
 *
 * POSIX only; the tests skip themselves on Windows.
 */

const ENTRY = `${import.meta.dir}/../cli.tsx`;

export type UiSession = {
  /** Sends raw bytes, exactly as a terminal would — reuse `keys` from test-utils. */
  readonly press: (input: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** Everything received since the last `clear()`, ANSI stripped. */
  readonly frame: () => string;
  /**
   * The same bytes, escape sequences intact.
   *
   * For the handful of assertions that are *about* the escapes — entering and
   * leaving the alternate screen is a sequence and nothing else.
   */
  readonly raw: () => string;
  /** Drops buffered output so the next repaint can be read on its own. */
  readonly clear: () => void;
  readonly waitForFrame: (
    predicate: (frame: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  /**
   * Resends `input` until the frame satisfies `predicate`.
   *
   * The child enables raw mode from an effect that runs after its first paint,
   * so a key written into that window is swallowed by the line discipline —
   * rare, but it hangs a test when it happens. Only for idempotent keys: `2`
   * selects a tab however often it arrives, whereas an arrow key would count
   * every repeat. Once one key is confirmed delivered, raw mode is live and
   * plain `press` is safe.
   */
  readonly pressUntil: (
    input: string,
    predicate: (frame: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  /** Same retry, for a key that ends the process. Resolves to the exit code. */
  readonly pressUntilExit: (input: string, timeoutMs?: number) => Promise<number>;
  readonly exited: Promise<number>;
  readonly kill: () => void;
};

/** Gap between resends: long enough that a delivered key has repainted first. */
const RETRY_MS = 250;

/**
 * How long the stream must stay silent before a frame counts as complete.
 *
 * A repaint arrives as several chunks, so a predicate can match text from the
 * top of the frame while the bottom is still in flight — asserting on the
 * status bar then fails against a frame that never contained it. Waiting for
 * the stream to go quiet is what makes the frame whole. The views under test
 * are static once painted (the log stream's timers stop while its tab is
 * hidden), so quiet really does mean finished.
 */
const QUIET_MS = 50;

type StartOptions = {
  readonly cols?: number;
  readonly rows?: number;
  readonly args?: readonly string[];
  /** Where the child starts — every command resolves its target from here. */
  readonly cwd?: string;
};

/**
 * A PTY hands back a stream of repaints, not a screen: Ink erases the previous
 * lines and rewrites the whole frame on every update, so a naive accumulation
 * still holds every older frame and `not.toContain` becomes meaningless.
 * Clearing the buffer before an interaction makes the next repaint readable on
 * its own — enough for smoke assertions without emulating a terminal grid.
 */
export function startUi({ cols = 80, rows = 24, args = [], cwd }: StartOptions = {}): UiSession {
  // Older runtimes ignore the `terminal` option instead of rejecting it, so the
  // child quietly gets no PTY and every wait here dies on a timeout that says
  // nothing. Fail on the actual reason.
  if (typeof Bun.Terminal !== "function") {
    throw new Error(`Bun.spawn({ terminal }) needs Bun >= 1.3.5; running ${Bun.version}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let lastDataAt = Date.now();

  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      // Ink renders non-interactively when `is-in-ci` sees CI or
      // CONTINUOUS_INTEGRATION set (ink/build/ink.js: `!isInCi && isTTY`): it
      // stops repainting and writes one frame on exit, so every waitForFrame
      // here would time out on an empty buffer. `is-in-ci` treats "false" as
      // not-CI, which is the supported way to opt out. The PTY is the point of
      // these tests — the child is interactive whatever the runner claims.
      CI: "false",
      CONTINUOUS_INTEGRATION: "false",
    },
    terminal: {
      cols,
      rows,
      data(_terminal, chunk) {
        // `stream: true` is required, not an optimization: a PTY splits on byte
        // boundaries, so a 3-byte box-drawing character routinely straddles two
        // chunks. Decoding each in isolation turns the halves into replacement
        // characters, which silently widens the frame and corrupts assertions.
        buffer += decoder.decode(chunk, { stream: true });
        lastDataAt = Date.now();
      },
    },
  });

  // A PTY turns every newline into CRLF; normalizing keeps line-based
  // assertions from measuring a stray `\r` as an extra column.
  const frame = () => plain(buffer).replaceAll("\r\n", "\n");

  let exitCode: number | null = null;
  const exited = proc.exited.then((code) => {
    exitCode = code;
    proc.terminal?.close();
    return code;
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const write = (input: string) => {
    try {
      proc.terminal?.write(input);
    } catch {
      // The process can exit between the check and the write; nothing to send to.
    }
  };

  const isQuiet = () => Date.now() - lastDataAt >= QUIET_MS;

  const waitForFrame = async (predicate: (frame: string) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const current = frame();
      if (predicate(current) && isQuiet()) return current;

      if (Date.now() >= deadline) {
        throw new Error(`waitForFrame timed out after ${timeoutMs}ms. Buffer:\n${current}`);
      }

      await sleep(10);
    }
  };

  return {
    press: write,
    raw: () => buffer,
    resize: (nextCols, nextRows) => {
      proc.terminal?.resize(nextCols, nextRows);
    },
    frame,
    clear: () => {
      buffer = "";
    },
    waitForFrame,
    pressUntil: async (input, predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let lastWrite = 0;

      for (;;) {
        const current = frame();
        if (predicate(current) && isQuiet()) return current;

        if (Date.now() >= deadline) {
          throw new Error(
            `pressUntil(${JSON.stringify(input)}) timed out after ${timeoutMs}ms. Buffer:\n${current}`,
          );
        }

        if (Date.now() - lastWrite >= RETRY_MS) {
          write(input);
          lastWrite = Date.now();
        }

        await sleep(10);
      }
    },
    pressUntilExit: async (input, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        if (exitCode !== null) return exitCode;

        if (Date.now() >= deadline) {
          throw new Error(
            `pressUntilExit(${JSON.stringify(input)}) timed out after ${timeoutMs}ms. Buffer:\n${frame()}`,
          );
        }

        write(input);
        await sleep(RETRY_MS);
      }
    },
    exited,
    kill: () => proc.kill(),
  };
}
