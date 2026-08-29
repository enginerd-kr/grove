import { Box, Text } from "ink";
import { describeAge } from "../../core/commands/list.ts";
import type { Commit } from "../../core/history.ts";
import { theme } from "../theme.ts";

/**
 * The commits under the list: `git log --oneline` for the row the cursor is on.
 *
 * The list answers "how far has this drifted"; this answers the question the
 * numbers make you ask next — *drifted by what?* — and it is the one question
 * whose answer was only ever a `git -C … log` away in another terminal.
 *
 * Drawn as columns rather than as git's one line, for the same reason the list
 * above it is a table: the sha, the age and the subject are three different
 * kinds of thing, and stacked in columns the eye can run down the ages without
 * reading the subjects. The colours are git's own — a yellow sha, the ref names
 * beside it — so nothing here has to be learned twice.
 *
 * It draws exactly the height it is given, blank rows and all. The panel sits
 * between the list and the activity area, and one that shrank to its contents
 * would move the rule above it every time the cursor landed on a shallower
 * history.
 */

type Props = {
  /** Which row these belong to — the worktree's directory, not the branch. */
  readonly label: string;
  readonly commits: readonly Commit[];
  /**
   * What to say instead of commits: a folder has no history of its own, and a
   * fresh branch has none yet. Absent while a read is still in flight, where
   * blank rows beat a "reading…" that is gone before it is read.
   */
  readonly note?: string;
  /** How many commit rows there is room for; the heading is on top of these. */
  readonly rows: number;
  readonly columns: number;
};

/**
 * The rule the panel hangs from, with its name written into it.
 *
 * The screen's other rules are plain, and this one is not, because it is the
 * only section whose subject changes under you: the commits belong to the row
 * the cursor is on, and a panel that did not say which row that was would be a
 * list of subjects with nothing to attach them to.
 */
function heading(label: string, columns: number): string {
  const text = `── commits in ${label} `;

  return `${text}${"─".repeat(Math.max(0, columns - text.length))}`;
}

/** Between the columns — the same breath the list's `GAP` gives its own. */
const GAP = "  ";

export function Log({ label, commits, note, rows, columns }: Props) {
  const shown = commits.slice(0, rows);
  const now = Date.now();
  const ages = shown.map((commit) => describeAge(commit.when, now));

  // Sized to what is actually there rather than to a guess: git abbreviates a
  // sha to as many characters as the repository needs, and `2026-07-03 14:12`
  // is four times the width of `2h ago`.
  const shaWidth = Math.max(0, ...shown.map((commit) => commit.sha.length));
  const ageWidth = Math.max(0, ...ages.map((age) => age.length));

  return (
    <Box flexDirection="column" height={rows + 1} flexShrink={0}>
      <Text dimColor wrap="truncate">
        {heading(label, columns)}
      </Text>

      {shown.length === 0 && note !== undefined ? (
        <Text dimColor wrap="truncate">{`  ${note}`}</Text>
      ) : null}

      {shown.map((commit, index) => (
        // Keyed by sha: git abbreviates to whatever is unique, so two rows of
        // one log cannot share one.
        <Text key={commit.sha} wrap="truncate">
          {"  "}
          <Text color={theme.warn}>{commit.sha.padEnd(shaWidth)}</Text>
          {GAP}
          {/* Padded rather than right-aligned, which is what the list's own
              `last` column does: `1d ago` beside a `2026-08-13 22:15` two rows
              down would otherwise sit at the far end of a column of blanks. */}
          <Text dimColor>{(ages[index] ?? "").padEnd(ageWidth)}</Text>
          {GAP}
          {/* Where the branch actually points, on the one or two rows that
              have it — the same `(HEAD -> main, origin/main)` git prints, and
              the fastest way to see that a push has not happened. */}
          {commit.refs.length > 0 ? <Text color={theme.accent}>{`(${commit.refs}) `}</Text> : null}
          <Text>{commit.subject}</Text>
        </Text>
      ))}
    </Box>
  );
}
