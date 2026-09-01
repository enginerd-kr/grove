/**
 * How commands talk to the user.
 *
 * The rule the whole interface exists to enforce: **stdout is data, stderr is
 * progress**. `grove list --json | jq` has to work while a spinner is on screen, so
 * results go through `out()` and absolutely nothing else does.
 *
 * Commands depend on this interface, never on a concrete reporter — which is
 * what keeps `core/` free of both React and `process`.
 */

export type Step = {
  /** Replace the label while the step is still running. Silent without a TTY. */
  readonly update: (text: string) => void;
  /** 0–100. Silent without a TTY; nobody wants 100 lines of percentages in CI. */
  readonly progress: (percent: number) => void;
  readonly succeed: (text?: string) => void;
  readonly fail: (text?: string) => void;
};

export type Reporter = {
  /** Begin a unit of work worth watching. Cheap operations should not call this. */
  readonly step: (text: string) => Step;
  readonly info: (text: string) => void;
  readonly warn: (text: string) => void;
  /** The only route to stdout. */
  readonly out: (text: string) => void;
  /** Flush and release the terminal. Must run before the process exits. */
  readonly close: () => Promise<void>;
};

/**
 * One step wrapped around one piece of work, settled exactly once.
 *
 * Most steps are this exact envelope: open, try, `succeed`, and on a throw
 * `fail` and let the error keep travelling — the command above knows what the
 * failure means; the step only says it happened. Written out by hand at every
 * site, "settled once, never twice" was a discipline; here it is the shape.
 *
 * `done` may be written against the result, for the step whose success line is
 * the news the work came back with. A step that does more — progress off a
 * stderr stream, a rollback before the `fail` — still writes the envelope out
 * itself: a wrapper wide enough for those would be the try/catch again, with
 * more punctuation.
 */
export async function withStep<T>(
  reporter: Reporter,
  labels: {
    readonly start: string;
    readonly done: string | ((result: T) => string);
    readonly failed: string;
  },
  work: () => Promise<T>,
): Promise<T> {
  const step = reporter.step(labels.start);
  try {
    const result = await work();
    step.succeed(typeof labels.done === "function" ? labels.done(result) : labels.done);

    return result;
  } catch (error) {
    step.fail(labels.failed);
    throw error;
  }
}

export type Writers = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

const defaultWriters: Writers = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * One line when a step starts, one when it ends.
 *
 * No cursor tricks, no colour, no spinner. Drawing is what `grove` does by
 * default, so this runs only when `--headless` asks for it — for a log file, a
 * CI transcript, or anything else that wants plain lines that survive being
 * read a week later.
 */
export function createPlainReporter(writers: Writers = defaultWriters): Reporter {
  const line = (prefix: string, text: string) => {
    writers.err(`${prefix} ${text}\n`);
  };

  return {
    step(text) {
      let label = text;
      let settled = false;
      line("·", label);

      const settle = (prefix: string, final?: string) => {
        if (settled) return;
        settled = true;
        line(prefix, final ?? label);
      };

      return {
        update(next) {
          // Recorded but not printed: a step that renames itself five times
          // would otherwise bury the transcript it is supposed to clarify.
          label = next;
        },
        progress() {
          // Percentages belong to the TTY reporter.
        },
        succeed: (final) => settle("✓", final),
        fail: (final) => settle("✗", final),
      };
    },
    info: (text) => line("·", text),
    warn: (text) => line("!", text),
    out: (text) => writers.out(text.endsWith("\n") ? text : `${text}\n`),
    close: async () => {},
  };
}
