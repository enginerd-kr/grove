import { Box, Text } from "ink";
import { isStep, type Line } from "../../report/lines.ts";
import { theme } from "../theme.ts";
import { ProgressBar } from "./ProgressBar.tsx";
import { Spinner } from "./Spinner.tsx";

/**
 * One line of reported work: a spinner while it runs, a mark once it settles.
 *
 * Shared by the progress reporter and the app so a `git clone` looks the same
 * whether it was started from a command line or from a keystroke.
 */
export function StepRow({ line }: { readonly line: Line }) {
  if (!isStep(line)) {
    return line.kind === "warn" ? (
      <Text color={theme.warn}>! {line.text}</Text>
    ) : (
      <Text dimColor>· {line.text}</Text>
    );
  }

  if (line.state === "done") {
    return (
      <Text>
        <Text color={theme.ok}>✓</Text> {line.label}
      </Text>
    );
  }
  if (line.state === "failed") {
    return (
      <Text>
        <Text color={theme.danger}>✗</Text> {line.label}
      </Text>
    );
  }

  return (
    <Box>
      <Spinner label={line.label} />
      {line.percent === undefined ? null : (
        <Box marginLeft={1}>
          <ProgressBar value={line.percent / 100} width={16} />
        </Box>
      )}
    </Box>
  );
}
