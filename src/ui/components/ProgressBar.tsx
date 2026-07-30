import { Text } from "ink";
import { theme } from "../theme.ts";

type Props = {
  /** Completion between 0 and 1. Out-of-range and NaN values are clamped. */
  readonly value: number;
  readonly width?: number;
  readonly color?: string;
  readonly showPercent?: boolean;
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Stateless bar: `████░░░░  50%`. */
export function ProgressBar({
  value,
  width = 24,
  color = theme.accent,
  showPercent = true,
}: Props) {
  const ratio = clamp01(value);
  const filled = Math.round(ratio * width);
  const percent = `${Math.round(ratio * 100)}`.padStart(3, " ");

  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(width - filled)}</Text>
      {showPercent ? <Text dimColor>{` ${percent}%`}</Text> : null}
    </Text>
  );
}
