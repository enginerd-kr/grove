import { isGroveError } from "../../core/errors.ts";

/**
 * The one line a screen shows after something happened, and the ones under it.
 *
 * Shared by the three screens because a refusal reads the same wherever it
 * lands: a `GroveError` was written to be shown to a person and already carries
 * the sentence, what it was told, and the advice, while anything else is a bug
 * here and gets its message printed rather than dressed up as guidance.
 */

export type Message = {
  readonly kind: "info" | "error";
  readonly text: string;
  /**
   * What the thing that failed actually said — stderr, mostly.
   *
   * Carried because dropping it is how `"uv sync" exited 1` becomes a dead end:
   * the reason was on the next line down, and a screen that shows only the
   * sentence sends somebody to re-run the command by hand to read it.
   */
  readonly details?: readonly string[];
  readonly hint?: string;
};

/** How many detail rows a screen will draw before standing in for the rest. */
const DETAIL_LIMIT = 5;

export function messageFor(error: unknown): Message {
  if (isGroveError(error)) {
    return {
      kind: "error",
      text: error.message,
      details: error.details.length > 0 ? error.details : undefined,
      hint: error.hint,
    };
  }

  return { kind: "error", text: error instanceof Error ? error.message : String(error) };
}

/** One detail row, carrying its position so a list of them can be drawn. */
export type DetailRow = {
  /** Its place in the message. Two identical stderr lines are still two rows. */
  readonly id: string;
  readonly text: string;
};

/**
 * The detail rows to draw, with a last line standing in for what did not fit.
 *
 * Capped because these are not always the five lines of a failed install: an
 * ambiguous name lists every worktree that matched, and a screen that let that
 * set its own height would push the list it belongs to off the bottom.
 */
export function detailLines(message: Message): readonly DetailRow[] {
  const details = message.details ?? [];
  const shown =
    details.length <= DETAIL_LIMIT
      ? details
      : [...details.slice(0, DETAIL_LIMIT), `… ${details.length - DETAIL_LIMIT} more line(s)`];

  return shown.map((text, index) => ({ id: `${index}`, text }));
}

/** The rows `MessageView` takes, for a screen that has to budget for them. */
export function messageRows(message: Message): number {
  return 1 + detailLines(message).length + (message.hint === undefined ? 0 : 1);
}
