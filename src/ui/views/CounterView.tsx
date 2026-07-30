import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { theme } from "../theme.ts";

const MAX = 100;

type Props = {
  /** Only the visible view reacts to keys, so shortcuts never collide. */
  readonly isActive: boolean;
};

/** Smallest possible stateful view: local state + `useInput`. */
export function CounterView({ isActive }: Props) {
  const [count, setCount] = useState(0);

  useInput(
    (input, key) => {
      if (key.rightArrow || input === "+" || input === "=") {
        setCount((current) => Math.min(MAX, current + 1));
      }

      if (key.leftArrow || input === "-") {
        setCount((current) => Math.max(0, current - 1));
      }

      if (input === "r") {
        setCount(0);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        Count{" "}
        <Text bold color={theme.accent}>
          {count}
        </Text>
        <Text dimColor>{` / ${MAX}`}</Text>
      </Text>

      <ProgressBar value={count / MAX} />

      <Text dimColor>
        {count === MAX ? "Maxed out — press r to reset." : "←/→ to change, r to reset."}
      </Text>
    </Box>
  );
}
