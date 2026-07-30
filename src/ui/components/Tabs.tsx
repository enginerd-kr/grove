import { Box, Text } from "ink";
import { theme } from "../theme.ts";

type Props = {
  readonly items: readonly string[];
  readonly activeIndex: number;
};

/** Numbered tab strip: the number is also the shortcut that selects the tab. */
export function Tabs({ items, activeIndex }: Props) {
  return (
    <Box>
      {items.map((label, index) => {
        const isActive = index === activeIndex;

        return (
          <Box key={label} marginRight={1}>
            <Text color={isActive ? theme.accent : theme.muted} bold={isActive} inverse={isActive}>
              {` ${index + 1} ${label} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
