import type { Reporter } from "../report/reporter.ts";

/**
 * One yes-or-no question, put to whoever is sitting at the terminal.
 *
 * The command line had no way to ask anything. `.grove.toml`'s commands wait
 * for `--trust`, and without it `grove add` printed them, said they had not
 * been trusted, and moved on — so the first thing a newcomer typed out of the
 * README made a worktree with no `.env` and no install in it, and the answer
 * was on a flag they had not read about yet. The screen has asked since 0.4.2.
 * A terminal with a person at it can be asked the same thing.
 *
 * `undefined` where there is nobody: a pipe, `--headless`, `--json`. Those runs
 * are scripts, and a script that hangs on a question is worse than one that
 * skips the commands and says so. `CommandContext.ask` carries the difference,
 * and the commands treat its absence as the answer they always had.
 */
export type Ask = (question: string) => Promise<boolean>;

/** One row of a choice: what one key picks, and what to call it. */
export type Choice = {
  readonly key: string;
  readonly label: string;
  /** Said after the label, dimmer: the ref a base resolves to, say. */
  readonly detail?: string;
};

/**
 * One pick out of a few, put to the same person.
 *
 * `Ask` is yes or no, and `rebase` asks a question with more answers than
 * that: which base. The shape is the same — the question through the reporter,
 * one raw key back — and so is the absence: nobody at the terminal means no
 * question, and the command says which flag would have answered it.
 *
 * `undefined` is any key that picks nothing, which is the "never mind" the
 * screen's `esc` is. Ctrl-C is that and the interrupt it always is.
 */
export type Choose = (question: string, choices: readonly Choice[]) => Promise<string | undefined>;

/** What a key is read from — `process.stdin`, or a stand-in for a test. */
export type KeySource = {
  readonly setRawMode: (mode: boolean) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
  readonly once: (event: "data", listener: (data: Buffer | string) => void) => unknown;
};

/** What Ctrl-C arrives as once the terminal is raw. */
const INTERRUPT = "\u0003";

/**
 * Asks through the reporter, so the question lands where the progress does —
 * under the lines it is about, and never in the middle of a frame the drawn
 * reporter is repainting. The key is read raw, one press and no enter, the
 * way the screen reads `y`.
 *
 * Anything but `y` is no. Ctrl-C is no as well, and it is also the interrupt
 * it always is: raw mode swallows the signal, so it is raised by hand for the
 * handler in `cli.tsx`, which exits 130 once the command has unwound.
 */
export function terminalAsker(reporter: Reporter, stdin: KeySource = process.stdin): Ask {
  return async (question) => {
    reporter.info(`${question} [y/N]`);

    const key = await readKey(stdin);
    if (key === INTERRUPT) {
      process.emit("SIGINT", "SIGINT");
      return false;
    }

    return key === "y" || key === "Y";
  };
}

/**
 * Lists the choices under the question, one key each, and reads one press.
 *
 * The keys are the caller's — digits, for `rebase` — so the last line can say
 * what to press without this function knowing what the rows are. Every row is
 * padded to the widest label, so the details line up in a column the way the
 * screen's popup draws them.
 */
export function terminalChooser(reporter: Reporter, stdin: KeySource = process.stdin): Choose {
  return async (question, choices) => {
    reporter.info(question);

    const width = Math.max(0, ...choices.map((choice) => choice.label.length));
    for (const choice of choices) {
      const detail = choice.detail === undefined ? "" : `  ${choice.detail}`;
      reporter.info(`  ${choice.key}  ${choice.label.padEnd(width)}${detail}`.trimEnd());
    }
    const keys = choices.map((choice) => choice.key);
    const span = keys.length > 2 ? `${keys[0]}-${keys[keys.length - 1]}` : keys.join(" or ");
    reporter.info(`${span} picks one; anything else leaves it`);

    const key = await readKey(stdin);
    if (key === INTERRUPT) {
      process.emit("SIGINT", "SIGINT");
      return undefined;
    }

    return choices.find((choice) => choice.key === key)?.key;
  };
}

function readKey(stdin: KeySource): Promise<string> {
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (data) => {
      // Back the way it was, and paused: a stdin left flowing keeps the
      // process alive after the command is done, which reads as a hang.
      stdin.setRawMode(false);
      stdin.pause();
      resolve(data.toString());
    });
  });
}
