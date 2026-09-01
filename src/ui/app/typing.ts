import type { Key } from "ink";

/**
 * What counts as typing, for every prompt the screen offers.
 *
 * Control sequences arrive from the terminal as multi-character strings, so an
 * arrow key would happily type itself into a branch name; taking only
 * printable ASCII is what keeps a prompt a prompt. One rule for the branch
 * prompt, the menu query and the clone URL, so they cannot come to disagree
 * about what a keystroke is.
 */
export const PRINTABLE = /^[\x20-\x7e]+$/;

/** Text for a prompt — not a chord, and not a control sequence. */
export function typed(
  input: string,
  key: { readonly ctrl: boolean; readonly meta: boolean },
): boolean {
  return input.length > 0 && !key.ctrl && !key.meta && PRINTABLE.test(input);
}

/** Text with a caret in it — what both prompts on the screen are, underneath. */
export type Prompt = {
  readonly value: string;
  /**
   * Where the next character lands, counted in characters before it: 0 is the
   * start of `value` and `value.length` is the end. Kept beside the text rather
   * than left at the end of it, because a name typed with a typo three
   * characters back is fixed by walking `←` to it, not by deleting everything
   * after it.
   */
  readonly caret: number;
};

/**
 * One keystroke's effect on a prompt, or `undefined` where the key is not one
 * it takes.
 *
 * Pure, and given the prompt rather than reading it: the caller applies this
 * inside a `setState` updater, so a frame carrying several keys has each of
 * them start from what the one before it left — typing `ab` quickly gives `ab`
 * and not `b`, and two `←` in one frame move the caret twice.
 *
 * The caret moves through the name and stops at either end rather than
 * wrapping: a key that jumps from the start to the end is one you have to look
 * at the screen to use.
 */
export function editPrompt<T extends Prompt>(now: T, input: string, key: Key): T | undefined {
  const insert = (text: string): T => ({
    ...now,
    value: now.value.slice(0, now.caret) + text + now.value.slice(now.caret),
    caret: now.caret + text.length,
  });

  /*
   * A paste arrives as one string, and a branch name copied off a terminal line
   * brings the newline that ended it. Ink reads that newline as Enter, so the
   * whole paste used to land on the branch below as a submit of an empty
   * prompt: the name typed nowhere, the popup gone, nothing added.
   *
   * The text goes in and the newline is dropped rather than submitting, because
   * acting on a name that was never on screen is not what pasting asked for —
   * one more keypress is cheap next to creating the wrong branch. An escape
   * sequence has no trailing newline to lose, so it still fails the printable
   * test below rather than typing itself in.
   */
  const pasted = input.replace(/[\r\n]+$/, "");
  if (pasted.length > 0 && pasted !== input && !key.ctrl && !key.meta) {
    return PRINTABLE.test(pasted) ? insert(pasted) : now;
  }

  if (key.leftArrow) return { ...now, caret: Math.max(0, now.caret - 1) };
  if (key.rightArrow) return { ...now, caret: Math.min(now.value.length, now.caret + 1) };

  // Backspace takes the character the caret sits after, wherever that is, and
  // the caret follows it back so the next one takes its neighbour. Both keys
  // mean backspace here: the key labelled Backspace arrives as `delete` on a
  // mac, and a forward delete is not worth losing that to.
  if (key.backspace || key.delete) {
    return now.caret === 0
      ? now
      : {
          ...now,
          value: now.value.slice(0, now.caret - 1) + now.value.slice(now.caret),
          caret: now.caret - 1,
        };
  }

  return typed(input, key) ? insert(input) : undefined;
}
