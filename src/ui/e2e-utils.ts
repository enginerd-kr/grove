import { plain } from "./test-utils.ts";

/**
 * Drives the real `cli.tsx` binary inside a pseudo-terminal.
 *
 * `ink-testing-library` fakes stdout (columns hardcoded to 100, no `isTTY`) and
 * stubs out `setRawMode`, so it can never exercise the TTY guard, the exit code,
 * or a resize. `Bun.spawn({ terminal })` gives the child a real PTY — no
 * `node-pty` needed, which matters because Bun cannot load its C++ addon.
 *
 * POSIX only; the tests skip themselves on Windows.
 */

const ENTRY = `${import.meta.dir}/cli.tsx`;

export type UiSession = {
  /** Sends raw bytes, exactly as a terminal would — reuse `keys` from test-utils. */
  readonly press: (input: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** Everything received since the last `clear()`, ANSI stripped. */
  readonly frame: () => string;
  /** Drops buffered output so the next repaint can be read on its own. */
  readonly clear: () => void;
  readonly waitForFrame: (
    predicate: (frame: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  readonly exited: Promise<number>;
  readonly kill: () => void;
};

type StartOptions = {
  readonly cols?: number;
  readonly rows?: number;
};

/**
 * A PTY hands back a stream of repaints, not a screen: Ink erases the previous
 * lines and rewrites the whole frame on every update, so a naive accumulation
 * still holds every older frame and `not.toContain` becomes meaningless.
 * Clearing the buffer before an interaction makes the next repaint readable on
 * its own — enough for smoke assertions without emulating a terminal grid.
 */
export function startUi({ cols = 80, rows = 24 }: StartOptions = {}): UiSession {
  const decoder = new TextDecoder();
  let buffer = "";

  const proc = Bun.spawn(["bun", ENTRY], {
    // Inherit nothing else: a stray TERM or CI variable would change the output.
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      data(_terminal, chunk) {
        buffer += decoder.decode(chunk);
      },
    },
  });

  // A PTY turns every newline into CRLF; normalizing keeps line-based
  // assertions from measuring a stray `\r` as an extra column.
  const frame = () => plain(buffer).replaceAll("\r\n", "\n");

  const exited = proc.exited.then((code) => {
    proc.terminal?.close();
    return code;
  });

  return {
    press: (input) => {
      proc.terminal?.write(input);
    },
    resize: (nextCols, nextRows) => {
      proc.terminal?.resize(nextCols, nextRows);
    },
    frame,
    clear: () => {
      buffer = "";
    },
    waitForFrame: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const current = frame();
        if (predicate(current)) return current;

        if (Date.now() >= deadline) {
          throw new Error(`waitForFrame timed out after ${timeoutMs}ms. Buffer:\n${current}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    exited,
    kill: () => proc.kill(),
  };
}

/** Runs the entry point with pipes instead of a PTY, to hit the `isTTY` guard. */
export async function runUiWithoutTty(): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  return { exitCode, stderr };
}
