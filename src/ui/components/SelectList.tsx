import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export type SelectItem = {
  readonly id: string;
  readonly label: string;
  /** Rendered before the label, e.g. a checkbox. */
  readonly prefix?: string;
  /** Dimmed trailing text, e.g. a shortcut or timestamp. */
  readonly hint?: string;
};

type Props = {
  readonly items: readonly SelectItem[];
  readonly selectedIndex: number;
  readonly emptyMessage?: string;
};

/**
 * Presentational list — selection lives in the parent so the same list can be
 * driven by a keyboard, a timer, or a test.
 */
export function SelectList({ items, selectedIndex, emptyMessage = "Nothing here yet." }: Props) {
  if (items.length === 0) {
    return <Text dimColor>{emptyMessage}</Text>;
  }

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;

        return (
          <Text key={item.id} color={isSelected ? theme.accent : undefined} bold={isSelected}>
            {isSelected ? "❯ " : "  "}
            {item.prefix ? `${item.prefix} ` : ""}
            {item.label}
            {item.hint ? <Text dimColor>{`  ${item.hint}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
