import { Box, Text } from "ink";
import { describeAge } from "../../core/commands/list.ts";
import type { PullRequest } from "../../core/commands/pr.ts";
import { theme } from "../theme.ts";

/**
 * The open pull requests, as a list to pick one out of.
 *
 * It exists for the one thing `grove pr <n>` cannot supply: the number. Knowing
 * it means going to look it up somewhere that is not this screen, and not
 * having to leave is the whole argument for a key — so what this draws is
 * exactly enough to recognise a pull request by, and nothing that would need
 * reading.
 *
 * Sized to its contents like the list above it, and truncating the title rather
 * than any of the four things that identify a row: the number you would have
 * typed, the branch it came from, who proposed it, and how long ago they last
 * touched it.
 */

type Props = {
  readonly prs: readonly PullRequest[];
  /** Which row the cursor is on, as an index into `prs`. */
  readonly index: number;
  /** How many pull-request rows there is room for. The heading sits above these. */
  readonly rows: number;
};

/** Between the columns — the same breath the list and the log panel give theirs. */
const GAP = "  ";

/**
 * How many rows this takes at this size. The layout has to know before it draws.
 *
 * Two for the border, one for the heading, and one per row it can show. Unlike
 * the `add` box, whose three rows are the same however long the branch name is,
 * this is as tall as the forge says — which is why it is asked rather than
 * assumed.
 */
export function pullRequestRows(count: number, rows: number): number {
  return 2 + 1 + Math.min(Math.max(0, rows), count);
}

/**
 * The window of rows to draw, holding the cursor inside it.
 *
 * The same centring the list uses: the cursor stays put while the rows move
 * under it, rather than the rows staying put and the cursor running off the
 * end of what is drawn.
 */
function windowOf(count: number, index: number, rows: number): number {
  if (count <= rows) return 0;

  return Math.max(0, Math.min(count - rows, index - Math.floor(rows / 2)));
}

export function PullRequests({ prs, index, rows }: Props) {
  const room = Math.max(0, rows);
  const start = windowOf(prs.length, index, room);
  const shown = prs.slice(start, start + room);
  const now = Date.now();
  const ages = shown.map((pr) => describeAge(pr.updatedAt, now));

  // Sized to what is on screen rather than to the whole list: a window of five
  // rows should not carry the width of a four-digit number it is not showing.
  const numberWidth = Math.max(0, ...shown.map((pr) => String(pr.number).length));
  const headWidth = Math.max(0, ...shown.map((pr) => pr.headRefName.length));
  const authorWidth = Math.max(0, ...shown.map((pr) => pr.author.length));
  const ageWidth = Math.max(0, ...ages.map((age) => age.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text dimColor wrap="truncate">
        {prs.length > shown.length
          ? `pull requests   ${index + 1} of ${prs.length}`
          : `pull requests   ${prs.length}`}
      </Text>

      {shown.map((pr, offset) => {
        const selected = start + offset === index;

        return (
          <Text key={pr.number} wrap="truncate">
            <Text color={theme.accent}>{selected ? "▸ " : "  "}</Text>
            {/* Right-aligned, because these are numbers being compared and a
                three-digit one beside a five-digit one should line up on the
                end that differs. */}
            <Text color={selected ? theme.accent : undefined} dimColor={!selected}>
              {String(pr.number).padStart(numberWidth)}
            </Text>
            {GAP}
            {/* A draft is marked as well as coloured, the same pairing the
                list's state and drift cells make: a column that only works in
                colour does not work for everyone. */}
            <Text color={theme.warn}>{pr.isDraft ? "●" : " "}</Text>{" "}
            <Text color={selected ? theme.accent : undefined}>
              {pr.headRefName.padEnd(headWidth)}
            </Text>
            {GAP}
            <Text dimColor>{pr.author.padEnd(authorWidth)}</Text>
            {GAP}
            <Text dimColor>{(ages[offset] ?? "").padEnd(ageWidth)}</Text>
            {GAP}
            {/* Last, and the only column allowed to run out of room: it is the
                one thing here you read rather than recognise, and the four
                before it are what tell the rows apart. */}
            <Text dimColor={!selected}>{pr.title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
