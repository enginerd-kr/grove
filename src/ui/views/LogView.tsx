import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { Spinner } from "../components/Spinner.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";

const MAX_LINES = 8;
const TICK_MS = 400;

const LEVELS = [
  { label: "info", color: theme.accent },
  { label: "warn", color: theme.warn },
  { label: "ok", color: theme.ok },
] as const;

const MESSAGES = [
  "fetching manifest",
  "resolved 133 packages",
  "compiling src/ui",
  "cache miss, rebuilding",
  "render loop steady at 60fps",
  "flushed 12 frames",
] as const;

type LogLine = {
  readonly id: number;
  readonly level: (typeof LEVELS)[number];
  readonly message: string;
};

/** Deterministic on purpose — a fake stream that is still reproducible in tests. */
function makeLine(seq: number): LogLine {
  return {
    id: seq,
    level: LEVELS[seq % LEVELS.length] ?? LEVELS[0],
    message: MESSAGES[seq % MESSAGES.length] ?? "",
  };
}

type Props = {
  readonly isActive: boolean;
  /** Injectable so tests can run the stream fast instead of sleeping. */
  readonly tickMs?: number;
};

/** Timer-driven view: a rolling buffer of the last few lines. */
export function LogView({ isActive, tickMs = TICK_MS }: Props) {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [emitted, setEmitted] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  // Sequence keeps counting across a clear, so line numbers stay unique.
  const seq = useRef(0);

  useInterval(
    () => {
      const line = makeLine(seq.current);
      seq.current += 1;
      setLines((previous) => [...previous, line].slice(-MAX_LINES));
      setEmitted(seq.current);
    },
    isActive && !isPaused ? tickMs : null,
  );

  useInput(
    (input) => {
      if (input === "p") setIsPaused((current) => !current);
      if (input === "c") setLines([]);
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" gap={1}>
      {isPaused ? (
        <Text color={theme.warn}>⏸ paused</Text>
      ) : (
        // Freeze the animation while hidden — a spinning hidden view would
        // re-render the whole app every 80ms for nothing.
        <Spinner label={`streaming (${emitted} lines)`} intervalMs={isActive ? 80 : null} />
      )}

      <Box flexDirection="column" minHeight={MAX_LINES}>
        {lines.length === 0 ? (
          <Text dimColor>Waiting for output…</Text>
        ) : (
          lines.map((line) => (
            <Text key={line.id}>
              <Text dimColor>{`${String(line.id).padStart(3, "0")} `}</Text>
              <Text color={line.level.color}>{line.level.label.padEnd(4, " ")}</Text>
              <Text>{` ${line.message}`}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
