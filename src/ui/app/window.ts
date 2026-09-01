/**
 * The window of rows to draw, holding the cursor inside it.
 *
 * Every scrolling list on the screen — the worktree list, the command menu,
 * the pull-request popup, the repository picker — answers the same question:
 * which slice of the rows to show, given where the cursor is. The answer is
 * one centring rule, kept here so the lists cannot drift apart: the cursor
 * stays put while the rows move under it, rather than the rows staying put
 * and the cursor running off the end of what is drawn, and the scrolling
 * stops once the end of the list is on screen.
 */
export function windowOf(count: number, index: number, rows: number): number {
  if (count <= rows) return 0;

  return Math.max(0, Math.min(count - rows, index - Math.floor(rows / 2)));
}
