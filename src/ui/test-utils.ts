// Built from a char code so the escape byte never appears literally in source.
const ESC = String.fromCharCode(27);
// CSI in general, not just SGR: e2e output also carries cursor moves and clears.
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

/** Strips ANSI escape sequences so assertions can match plain text. */
export function plain(frame: string | undefined): string {
  return (frame ?? "").replace(ANSI_PATTERN, "");
}

/** What a terminal actually sends for the keys Ink turns into `key.*`. */
export const keys = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  enter: "\r",
  // 127, which is what a terminal sends for the key labelled backspace — and
  // what Ink reports as `key.backspace`.
  backspace: String.fromCharCode(127),
  esc: ESC,
} as const;

/** Lets Ink flush pending state updates before the next assertion. */
export function nextFrame(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WaitForOptions = {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
};

/**
 * Polls the rendered frame until `predicate` accepts it.
 *
 * Preferred over sleeping a fixed duration: it returns as soon as the frame
 * arrives, and on timeout it reports the frame it gave up on.
 */
export async function waitFor(
  getFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: WaitForOptions = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const frame = plain(getFrame());
    if (predicate(frame)) return frame;

    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms. Last frame:\n${frame}`);
    }

    await nextFrame(intervalMs);
  }
}
