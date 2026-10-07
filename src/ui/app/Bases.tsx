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
  /** Which choice the cursor is on, regardless of the number of columns. */
  readonly index: number;
  /** How many rows there is room for. The heading sits above these. */
  readonly rows: number;
  /** Terminal width; a long list uses two columns when both fit. */
  readonly columns?: number;
};

/** Between the label and the ref — the breath the other popups give their columns. */
const GAP = "  ";
const MIN_COLUMN = 30;

/** Shared by drawing, height budgeting and keyboard movement. Items run down each column. */
export function baseGrid(count: number, rows: number, columns = 0) {
  const room = Math.max(0, rows);
  const width = Math.max(0, columns - 4); // Border and horizontal padding.
  const columnCount = count > room && width >= MIN_COLUMN * 2 + GAP.length ? 2 : 1;
  const rowCount = Math.ceil(count / columnCount);
  return {
    count,
    columnCount,
    rowCount,
    shownRows: Math.min(room, rowCount),
    columnWidth:
      columns > 0 ? Math.floor((width - GAP.length * (columnCount - 1)) / columnCount) : undefined,
  };
}

export type BaseDirection = "up" | "down" | "left" | "right";

export function moveBaseIndex(
  grid: ReturnType<typeof baseGrid>,
  index: number,
  direction: BaseDirection,
): number {
  if (grid.count === 0) return 0;
  const at = Math.max(0, Math.min(grid.count - 1, index));
  const column = Math.floor(at / grid.rowCount);
  const first = column * grid.rowCount;
  const last = Math.min(grid.count - 1, first + grid.rowCount - 1);
  switch (direction) {
    case "up":
      return Math.max(first, at - 1);
    case "down":
      return Math.min(last, at + 1);
    case "left":
      return column === 0 ? at : at - grid.rowCount;
    case "right":
      return column === grid.columnCount - 1 ? at : Math.min(grid.count - 1, at + grid.rowCount);
  }
}

/**
 * How many rows this takes at this size. The layout has to know before it
 * draws — the same question `pullRequestRows` answers for the other popup.
 */
export function baseRows(count: number, rows: number, columns?: number): number {
  return 2 + 1 + baseGrid(count, rows, columns).shownRows;
}

export function Bases({ dir, choices, index, rows, columns }: Props) {
  const grid = baseGrid(choices.length, rows, columns);
  const start = windowOf(grid.rowCount, index % (grid.rowCount || 1), grid.shownRows);
  const labelWidth = Math.max(
    0,
    ...choices.filter((choice) => choice.ref !== choice.label).map((choice) => choice.label.length),
  );

  return (
    <Box
      width={columns}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Text dimColor wrap="truncate">
        {grid.rowCount > grid.shownRows
          ? `rebase ${dir} onto   ${index + 1} of ${choices.length}`
          : `rebase ${dir} onto`}
      </Text>

      {choices.slice(start, start + grid.shownRows).map((first, offset) => (
        <Box key={first.ref}>
          {Array.from({ length: grid.columnCount }, (_, column) => {
            const at = column * grid.rowCount + start + offset;
            const choice = choices[at];
            if (!choice) return null;
            const selected = at === index;
            return (
              <Box
                key={choice.ref}
                width={grid.columnWidth}
                flexShrink={0}
                marginLeft={column === 0 ? 0 : GAP.length}
              >
                <Text wrap="truncate">
                  <Text color={theme.accent}>{selected ? "▸ " : "  "}</Text>
                  <Text color={selected ? theme.accent : undefined} dimColor={!selected}>
                    {choice.ref === choice.label ? choice.label : choice.label.padEnd(labelWidth)}
                  </Text>
                  {choice.ref === choice.label ? null : (
                    <>
                      {GAP}
                      <Text dimColor>{choice.ref}</Text>
                    </>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
