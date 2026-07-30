import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export type Hint = {
  readonly keys: string;
  readonly action: string;
};

type Props = {
  readonly hints: readonly Hint[];
};

/** Bottom keybinding legend: `↑/↓ move · space toggle · q quit`. */
export function StatusBar({ hints }: Props) {
  return (
    <Box>
      {hints.map((hint, index) => (
        <Text key={hint.keys} dimColor>
          {index > 0 ? " · " : ""}
          <Text color={theme.accent}>{hint.keys}</Text>
          {` ${hint.action}`}
        </Text>
      ))}
    </Box>
  );
}
