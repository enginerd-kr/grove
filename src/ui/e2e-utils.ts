import { Terminal } from "@xterm/headless";

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

/** One position on the screen, with the attributes `frame()` flattens away. */
export type Cell = {
  /** The character standing there, or `""` for a cell nothing has written to. */
  readonly chars: string;
  readonly dim: boolean;
  /** The palette index chalk asked for, or `undefined` for the default colour. */
  readonly color: number | undefined;
};

export type UiSession = {
  /** Sends raw bytes, exactly as a terminal would — reuse `keys` from test-utils. */
  readonly press: (input: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** What the terminal is displaying now, one line per row, right-trimmed. */
  readonly frame: () => string;
  /**
   * The bytes as they arrived, escape sequences intact.
   *
   * For the handful of assertions that are *about* the escapes: entering and
   * leaving the alternate screen is a sequence and nothing else, and a terminal
   * handed back to the shell has nothing left on it to look for.
   */
  readonly raw: () => string;
  /**
   * The cell at a row and column of `frame()`, attributes included.
   *
   * Colour is a real decision in this app — `StateCell` and `DriftCell` dim on
   * their own contents rather than on the cursor — and it is the one part of a
   * frame that surviving as text proves nothing about.
   */
  readonly cellAt: (row: number, column: number) => Cell | undefined;
  /** Draws a line under everything received so far. */
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

/**
 * How long a resend waits for the child to say something first.
 *
 * A resend is for the one key that was never read — raw mode is enabled from an
 * effect that runs after the first paint, and a key sent into that window is
 * eaten by the line discipline. It is *not* for a key that landed and is taking
 * a while to answer, and telling the two apart matters more than it looks: the
 * app blocks the keyboard while a command runs and drops what arrives, so a
 * second copy of a key sent during the first one's work is not a retry, it is a
 * key queued behind a refresh that will swallow the test's next press. That is
 * how two of these tests failed on a runner and nowhere else — `open`'s `R`
 * resent while the first refresh was still fetching, and the `L` that followed
 * landed inside the second refresh and was discarded.
 *
 * So a resend needs silence as well as time: anything at all from the child
 * proves the key was read, and only a screen that has said nothing since the
 * write is one that never heard it.
 */
const RETRY_MS = 250;

/**
 * How long the stream must stay silent before a frame counts as complete.
 *
 * The emulator retired half of what this was for. A predicate used to be able
 * to match text belonging to a frame that had already been painted over, and
 * waiting for quiet was one of the two things holding that back; a grid holds
 * one screen, so that half is gone.
 *
 * The other half is untouched, and is arguably worse now. A repaint still
 * arrives as several chunks, and Ink's is not atomic: it walks the cursor up,
 * erases and rewrites line by line. Feed it half and the grid does not look
 * half-applied — it looks like a screen, with the new rows on top of the rows
 * the last frame left underneath. `selected()` reading two cursor markers, or a
 * `not.toContain` matching a row that is about to be overwritten, is exactly
 * that. Waiting for the stream to go quiet is still what makes the frame whole,
 * and the views under test are static once painted (the log stream's timers
 * stop while its tab is hidden), so quiet really does mean finished.
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
 * A PTY hands back a stream of repaints, not a screen: Ink walks the cursor
 * back over the lines it drew and rewrites them, so accumulating the bytes and
 * stripping the escapes gives you every frame since the process started, laid
 * end to end. `not.toContain` means nothing against that, and the assertions
 * that mattered — is this row still on the screen, is that panel gone — are all
 * of that shape.
 *
 * So the bytes go through a real terminal emulator and `frame()` reads the grid
 * it maintains. The escape sequences stop being noise to strip and become the
 * thing that decides what the screen says, which is what a person watching the
 * app sees and the only honest thing to assert against.
 */
export function startUi({ cols = 80, rows = 24, args = [], cwd }: StartOptions = {}): UiSession {
  // Older runtimes ignore the `terminal` option instead of rejecting it, so the
  // child quietly gets no PTY and every wait here dies on a timeout that says
  // nothing. Fail on the actual reason.
  if (typeof Bun.Terminal !== "function") {
    throw new Error(`Bun.spawn({ terminal }) needs Bun >= 1.3.5; running ${Bun.version}`);
  }

  const decoder = new TextDecoder();
  // `allowProposedApi` is not a warning about stability here: `buffer` is
  // behind that flag, and the buffer is the entire point.
  const screen = new Terminal({ cols, rows, allowProposedApi: true });

  let buffer = "";
  let lastDataAt = Date.now();
  // The emulator applies a write on a later tick, so a frame read in the same
  // turn as the chunk that fills it would be a frame short. Nothing may count
  // as settled while a write is still queued.
  let pendingWrites = 0;
  let heardSinceClear = true;
  // Whether the child has spoken since the last key was written; see RETRY_MS.
  let heardSinceWrite = true;

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
      // ...and `supports-color` does not, because it only asks whether `CI` is
      // *present* — so the line above, meant for Ink, silently turned chalk off
      // and left this suite colourless. Worse, it left it colourless only on a
      // laptop: on GitHub Actions `GITHUB_ACTIONS` is still in the inherited
      // environment and wins that branch, so the same test saw a coloured
      // screen there and a plain one here. Pinning the level makes colour a
      // decision of the harness rather than of whoever is running it, and the
      // app only ever asks for chalk's named colours, which are the same bytes
      // at every level above zero.
      FORCE_COLOR: "1",
    },
    terminal: {
      cols,
      rows,
      data(_terminal, chunk) {
        // `stream: true` is required, not an optimization: a PTY splits on byte
        // boundaries, so a 3-byte box-drawing character routinely straddles two
        // chunks. Decoding each in isolation turns the halves into replacement
        // characters, which silently widens the frame and corrupts assertions.
        const text = decoder.decode(chunk, { stream: true });
        buffer += text;
        pendingWrites += 1;
        screen.write(text, () => {
          pendingWrites -= 1;
        });
        lastDataAt = Date.now();
        heardSinceClear = true;
        heardSinceWrite = true;
      },
    },
  });

  /**
   * Every line the active buffer holds.
   *
   * `buffer.active` rather than `buffer.normal` because the app runs with
   * `alternateScreen: true`: the normal buffer keeps whatever the shell left
   * there and would answer for a screen the app is not drawing on. The two
   * differ in one more useful way — the alternate buffer has no scrollback, so
   * this is exactly its rows, while a command that just prints (`--headless`)
   * keeps the lines that scrolled off the top, which is what a person would
   * find by scrolling up to look for them.
   */
  const frame = () => {
    const active = screen.buffer.active;
    const lines: string[] = [];

    for (let row = 0; row < active.length; row += 1) {
      // `trimEnd` as well as the emulator's own trim: xterm stops at the last
      // cell anything was written to, and Ink pads its rows out with real
      // spaces, so a row that looks blank at the end of a line still is not.
      lines.push(active.getLine(row)?.translateToString(true).trimEnd() ?? "");
    }

    return lines.join("\n");
  };

  let exitCode: number | null = null;
  const exited = proc.exited.then((code) => {
    exitCode = code;
    proc.terminal?.close();
    return code;
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const write = (input: string) => {
    try {
      heardSinceWrite = false;
      proc.terminal?.write(input);
    } catch {
      // The process can exit between the check and the write; nothing to send to.
    }
  };

  /**
   * Whether the screen can be trusted to be the answer to the last thing sent.
   *
   * Three conditions, and each is a separate way of reading a frame too early:
   * the child has said something since `clear()` drew the line, the emulator
   * has applied all of it, and the stream has gone quiet for `QUIET_MS`.
   */
  const settled = () =>
    heardSinceClear && pendingWrites === 0 && Date.now() - lastDataAt >= QUIET_MS;

  const waitForFrame = async (predicate: (frame: string) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const current = frame();
      if (predicate(current) && settled()) return current;

      if (Date.now() >= deadline) {
        throw new Error(`waitForFrame timed out after ${timeoutMs}ms. Screen:\n${current}`);
      }

      await sleep(10);
    }
  };

  return {
    press: write,
    raw: () => buffer,
    resize: (nextCols, nextRows) => {
      // The emulator first, and not as a tidy-up: the child answers SIGWINCH
      // with a repaint sized to the new terminal, and a grid still the old
      // shape would wrap that repaint's lines and hand every assertion after
      // the resize a screen of a width nobody ever drew.
      screen.resize(nextCols, nextRows);
      proc.terminal?.resize(nextCols, nextRows);
    },
    frame,
    cellAt: (row, column) => {
      const cell = screen.buffer.active.getLine(row)?.getCell(column);
      if (cell === undefined) return undefined;

      return {
        chars: cell.getChars(),
        // The attribute is a bit in a packed word, not a boolean.
        dim: cell.isDim() !== 0,
        color: cell.isFgDefault() ? undefined : cell.getFgColor(),
      };
    },
    clear: () => {
      // The screen is no longer an accumulation, so this is not about keeping
      // it readable any more. It is the barrier that stops a wait returning the
      // frame as it was *before* the key about to be pressed: most of these
      // predicates are already true of the current screen the moment they are
      // asked (`not.toContain` of a panel that has not opened yet), and without
      // something to say "not until you have heard back", the wait passes on
      // its first poll and the assertion after it races the repaint.
      buffer = "";
      heardSinceClear = false;
    },
    waitForFrame,
    pressUntil: async (input, predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let sent = false;
      let lastWrite = 0;

      for (;;) {
        const current = frame();
        if (predicate(current) && settled()) return current;

        if (Date.now() >= deadline) {
          throw new Error(
            `pressUntil(${JSON.stringify(input)}) timed out after ${timeoutMs}ms. Screen:\n${current}`,
          );
        }

        // The first one goes out at once; the rest only into silence.
        if (!sent || (!heardSinceWrite && Date.now() - lastWrite >= RETRY_MS)) {
          write(input);
          sent = true;
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
            `pressUntilExit(${JSON.stringify(input)}) timed out after ${timeoutMs}ms. Screen:\n${frame()}`,
          );
        }

        write(input);
        await sleep(RETRY_MS);
      }
    },
    exited,
    // The emulator is deliberately not disposed here: the PTY goes on flushing
    // whatever the child had already written, and a `write` into a disposed
    // terminal would throw from inside a callback nobody is in a position to
    // catch. A grid of a few thousand cells is not worth that.
    kill: () => proc.kill(),
  };
}
