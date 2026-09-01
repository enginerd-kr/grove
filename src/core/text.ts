/**
 * `1 command`, `2 commands`, `3 directories` — a count and its noun, agreed.
 *
 * One rule for every sentence the tool counts in, because the sentences end up
 * side by side — a sync summary over a doctor line over a removal — and two of
 * them disagreeing about pluralisation is the kind of seam nobody should be
 * able to notice.
 */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * Text as lines, with CR, LF and CRLF all counting as a break.
 *
 * The lone `\r` is the reason this is written once. A process narrating its
 * progress redraws one line with carriage returns and no newline at all, so
 * splitting on `\n` alone hands back one enormous line with the whole animation
 * in it — and every caller here is reading output in order to quote the last
 * few lines of it back to somebody.
 */
export function toLines(text: string): readonly string[] {
  return text.split(/\r?\n|\r/);
}
