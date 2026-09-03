import { Box, Text } from "ink";
import { guidesFor, type StackResult } from "../../core/commands/stack.ts";
import { theme } from "../theme.ts";
import { clip } from "./Files.tsx";
import { windowOf } from "./window.ts";

/**
 * The stack beside the list, for the row the cursor is on.
 *
 * The list shows a stack one row at a time — a child indented under its
 * parent when the two share a folder, `on feat/login` in the state column
 * when they do not — and neither says the thing a stack raises: how far each
 * branch has moved from the one it sits on, which is the number `sync` would
 * close and not the one the `main` column shows. This is `grove stack`'s
 * picture, drawn where the uncommitted files are drawn: in the slack to the
 * right of the list, only while the cursor is on a row that is in a stack.
 *
 * The files win the space when a row is both dirty and stacked. What is
 * uncommitted is the thing about to be lost or carried; where the branch sits
 * is a fact that keeps, and `grove stack` draws it whole on any terminal.
 */

type Props = {
  readonly result: StackResult;
  /** The branch under the cursor, drawn in the accent so the eye finds itself. */
  readonly selected: string;
  /** The panel's height, and its width including the rule down its left edge. */
  readonly rows: number;
  readonly width: number;
};

/** The panel's left edge — `Files`'s, so the two panels are one shape. */
const EDGE = "  │ ";

export function Stack({ result, selected, rows, width }: Props) {
  const inner = Math.max(0, width - EDGE.length);
  const body = Math.max(0, rows - 1);

  const guides = guidesFor(result.rows);
  const lines = result.rows.map((row, index) => ({
    row,
    head: `${guides[index] ?? ""}${row.branch}${row.current ? " *" : ""}`,
    drift:
      row.ahead === undefined || row.behind === undefined
        ? undefined
        : `↑${row.ahead} ↓${row.behind}`,
  }));

  // A window that keeps the selected row in view, the way the list's own
  // window keeps the cursor: a stack taller than the panel shows the part the
  // cursor is in, and the last row says how much is out of sight.
  const at = Math.max(
    0,
    result.rows.findIndex((row) => row.branch === selected),
  );
  const overflows = lines.length > body;
  const budget = overflows ? Math.max(0, body - 1) : body;
  const start = windowOf(lines.length, at, budget);
  const shown = lines.slice(start, start + budget);
  const hidden = lines.length - shown.length;

  return (
    <Box width={width} flexShrink={0}>
      <Box width={EDGE.length} flexShrink={0}>
        <Text dimColor>{Array.from({ length: rows }, () => EDGE.trimEnd()).join("\n")}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>{clip(`stack under ${result.trunk}`, inner)}</Text>

        {shown.map(({ row, head, drift }) => {
          const chosen = row.branch === selected;
          // The drift sits after the name where it fits, and goes before the
          // name is clipped: which branch this is outranks how far it moved.
          const tail = drift === undefined ? "" : `  ${drift}`;
          const room = inner - tail.length;
          const withDrift = drift !== undefined && head.length <= room;

          return (
            <Text key={row.branch}>
              <Text
                color={chosen ? theme.accent : undefined}
                dimColor={!chosen && (!row.exists || row.dir === undefined)}
              >
                {clip(head, withDrift ? room : inner)}
              </Text>
              {withDrift ? (
                <>
                  {"  "}
                  <Text color={row.ahead ? theme.ok : undefined} dimColor={!row.ahead}>
                    {`↑${row.ahead}`}
                  </Text>{" "}
                  <Text color={row.behind ? theme.warn : undefined} dimColor={!row.behind}>
                    {`↓${row.behind}`}
                  </Text>
                </>
              ) : null}
              {!row.exists ? (
                <Text dimColor>{clip("  gone", Math.max(0, inner - head.length))}</Text>
              ) : null}
            </Text>
          );
        })}

        {hidden > 0 ? <Text dimColor>{clip(`… ${hidden} more`, inner)}</Text> : null}
      </Box>
    </Box>
  );
}
