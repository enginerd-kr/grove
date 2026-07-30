/**
 * How commands talk to the user.
 *
 * The rule the whole interface exists to enforce: **stdout is data, stderr is
 * progress**. `wt list --json | jq` has to work while a spinner is on screen, so
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
 * No cursor tricks, no colour, no spinner: this is what runs when the output is
 * a pipe, a log file, or a CI transcript, and all three want plain lines that
 * survive being read a week later.
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

type ReporterEnvironment = {
  readonly isStderrTty: boolean;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Whether to draw or to log.
 *
 * `--json` forces plain output even on a terminal: a human asking for machine
 * output is usually piping it somewhere, and a redraw loop competing with the
 * consumer helps nobody. `CI` is honoured because build logs capture every
 * escape sequence a spinner emits.
 */
export function prefersPlainReporter({ isStderrTty, json, env }: ReporterEnvironment): boolean {
  if (!isStderrTty) return true;
  if (json) return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  // `is-in-ci`'s convention, which Ink follows: the string "false" opts out.
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return true;

  return false;
}
