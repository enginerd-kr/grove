import { Box, Text, useStdout } from "ink";
import { isStep, type Line } from "../../report/lines.ts";
import { theme } from "../theme.ts";
import { ProgressBar } from "./ProgressBar.tsx";
import { Spinner } from "./Spinner.tsx";

/** What the spinner and the space after it take from the row. */
const MARK_WIDTH = 2;
/** And the bar, when there is one: a margin, 16 cells, and ` 100%`. */
const BAR_WIDTH = 1 + 16 + 5;
/** When the stream cannot say — piped, or not a terminal at all. */
const FALLBACK_COLUMNS = 80;

type Props = {
  readonly line: Line;
  /**
   * Keep to one row, cutting what does not fit.
   *
   * For the app, which reserves a fixed number of rows for activity and would
   * lose the bottom of its layout to a `--verbose` git line long enough to wrap.
   * The reporter leaves it off: it draws into a log with nothing underneath, so
   * wrapping there costs nothing and truncating would throw text away.
   */
  readonly truncate?: boolean;
};

/** The label cut to `room` columns, with an ellipsis standing where it was cut. */
function clip(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 1) return text.slice(0, Math.max(0, room));

  return `${text.slice(0, room - 1)}…`;
}

/**
 * One line of reported work: a spinner while it runs, a mark once it settles.
 *
 * Shared by the progress reporter and the app so a `git clone` looks the same
 * whether it was started from a command line or from a keystroke.
 */
export function StepRow({ line, truncate }: Props) {
  const { stdout } = useStdout();
  const wrap = truncate === true ? "truncate" : undefined;

  if (!isStep(line)) {
    return line.kind === "warn" ? (
      <Text color={theme.warn} wrap={wrap}>
        ! {line.text}
      </Text>
    ) : (
      <Text dimColor wrap={wrap}>
        · {line.text}
      </Text>
    );
  }

  if (line.state === "done") {
    return (
      <Text wrap={wrap}>
        <Text color={theme.ok}>✓</Text> {line.label}
      </Text>
    );
  }
  if (line.state === "failed") {
    return (
      <Text wrap={wrap}>
        <Text color={theme.danger}>✗</Text> {line.label}
      </Text>
    );
  }

  // Two boxes in a row rather than one `Text`, so the bar keeps its width while
  // the label takes what is left. `wrap` cannot hold that to one row — the
  // label is measured before the bar is placed — and clipping alone cannot
  // either: a label that wraps to a last line of a character or two is dropped
  // whole by the clip, leaving a bare spinner. So the cut is made here, against
  // the room the row has once the spinner and the bar have taken theirs, and
  // the clip stays behind it as the guard for a terminal narrower than it said.
  const room =
    (stdout.columns || FALLBACK_COLUMNS) -
    MARK_WIDTH -
    (line.percent === undefined ? 0 : BAR_WIDTH);

  return (
    <Box height={truncate === true ? 1 : undefined} overflow="hidden">
      <Spinner label={truncate === true ? clip(line.label, room) : line.label} />
      {line.percent === undefined ? null : (
        <Box marginLeft={1}>
          <ProgressBar value={line.percent / 100} width={16} />
        </Box>
      )}
    </Box>
  );
}
