import { Text } from "ink";
import { useState } from "react";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Props = {
  readonly label?: string;
  /** Pass `null` to freeze the animation. */
  readonly intervalMs?: number | null;
};

/** Braille spinner. Purely cosmetic — it never blocks the render loop. */
export function Spinner({ label, intervalMs = 80 }: Props) {
  const [frame, setFrame] = useState(0);

  useInterval(() => setFrame((current) => (current + 1) % FRAMES.length), intervalMs ?? null);

  return (
    <Text color={theme.accent}>
      {FRAMES[frame % FRAMES.length]}
      {label ? ` ${label}` : ""}
    </Text>
  );
}
