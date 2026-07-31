import { Box, Text } from "ink";
import { isStep, type Line } from "../../report/lines.ts";
import { theme } from "../theme.ts";
import { ProgressBar } from "./ProgressBar.tsx";
import { Spinner } from "./Spinner.tsx";

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

/**
 * One line of reported work: a spinner while it runs, a mark once it settles.
 *
 * Shared by the progress reporter and the app so a `git clone` looks the same
 * whether it was started from a command line or from a keystroke.
 */
export function StepRow({ line, truncate }: Props) {
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
  // the label takes what is left. Held to one row by height and clipped, not by
  // `wrap`: the label is measured before the bar is placed, so a `truncate` on
  // it would still leave the row two lines tall on a narrow terminal.
  return (
    <Box height={truncate === true ? 1 : undefined} overflow="hidden">
      <Spinner label={line.label} />
      {line.percent === undefined ? null : (
        <Box marginLeft={1}>
          <ProgressBar value={line.percent / 100} width={16} />
        </Box>
      )}
    </Box>
  );
}
