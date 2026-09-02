import { Box, Text } from "ink";
import type { RebaseChoice } from "../../core/commands/rebase.ts";
import { theme } from "../theme.ts";
import { windowOf } from "./window.ts";

/**
 * The bases a worktree can be rebased onto, as a list to pick one out of.
 *
 * `/rebase` is the one command here whose question has more than two answers,
 * so it gets the shape `/review` has rather than the `y`/`n` the confirmations
 * share: rows, a cursor, and enter. What is drawn is what tells the rows apart
 * — the role a base plays (`upstream`, `parent`, `trunk`, or a worktree's own
 * branch) and the ref that role resolves to — and nothing that needs reading.
 */

type Props = {
  /** Which worktree the question is about, for the heading. */
  readonly dir: string;
  readonly choices: readonly RebaseChoice[];
  /** Which row the cursor is on, as an index into `choices`. */
  readonly index: number;
  /** How many rows there is room for. The heading sits above these. */
  readonly rows: number;
};

/** Between the label and the ref — the breath the other popups give their columns. */
const GAP = "  ";

/**
 * How many rows this takes at this size. The layout has to know before it
 * draws — the same question `pullRequestRows` answers for the other popup.
 */
export function baseRows(count: number, rows: number): number {
  return 2 + 1 + Math.min(Math.max(0, rows), count);
}

export function Bases({ dir, choices, index, rows }: Props) {
  const room = Math.max(0, rows);
  const start = windowOf(choices.length, index, room);
  const shown = choices.slice(start, start + room);

  const labelWidth = Math.max(0, ...shown.map((choice) => choice.label.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text dimColor wrap="truncate">
        {choices.length > shown.length
          ? `rebase ${dir} onto   ${index + 1} of ${choices.length}`
          : `rebase ${dir} onto`}
      </Text>

      {shown.map((choice, offset) => {
        const selected = start + offset === index;

        return (
          <Text key={choice.ref} wrap="truncate">
            <Text color={theme.accent}>{selected ? "▸ " : "  "}</Text>
            <Text color={selected ? theme.accent : undefined} dimColor={!selected}>
              {choice.label.padEnd(labelWidth)}
            </Text>
            {/* A worktree's branch is its own label, and saying it twice is
                noise; the role words get the ref they stand for beside them. */}
            {choice.ref === choice.label ? null : (
              <>
                {GAP}
                <Text dimColor>{choice.ref}</Text>
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
