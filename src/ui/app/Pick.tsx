import { basename } from "node:path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { StatusBar } from "../components/StatusBar.tsx";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { windowOf } from "./window.ts";

/**
 * `grove` in a folder that holds more than one repository.
 *
 * The commands refuse this and are right to: `grove remove main` in `~/work`
 * with two repositories under it would delete a worktree from whichever one
 * the scan happened to list first. But refusing is an answer to "which one did
 * you mean?", and the screen has a better one — it can show them and let you
 * say. Ending the process here was the one folder `grove` would not draw in,
 * and it is a folder people keep every repository they have in.
 *
 * Picking is all this does. There is no repository yet for the app's keys to
 * act on, and no list to move a cursor through except this one, which is the
 * same reason `Setup` is its own screen rather than another `App` mode.
 */

/** Below this the explanation goes; the list and the keys are what must fit. */
const ROOMY_ROWS = 16;

/**
 * The rows left for repositories once everything around them has been paid
 * for: the banner, the breath above and below the list, and the key bar.
 *
 * Deliberately pessimistic rather than measured — this screen is a question
 * with a short answer, and a folder holding more repositories than a terminal
 * can show is one where scrolling is the point anyway.
 */
function listRows(rows: number): number {
  return Math.max(1, rows - 8);
}

type Props = {
  /** The repository roots found directly below `folder`, in the order scanned. */
  readonly roots: readonly string[];
  /** The folder the app opened in — the one holding all of these. */
  readonly folder: string;
  /** Called with the root that was chosen; the app takes over from there. */
  readonly onPick: (root: string) => void;
  /** Ctrl-C. Nothing is running here, but the outcome still has to say so. */
  readonly onCancel?: () => void;
};

export function Pick({ roots, folder, onPick, onCancel }: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel?.();
      exit();

      return;
    }

    if (key.escape || input === "q") return exit();
    // Wrapping, because the list is short and whole on screen: from the last
    // row the next one down is the first, which is the shorter way back to it.
    if (key.upArrow || input === "k") {
      return setIndex((at) => (at === 0 ? roots.length - 1 : at - 1));
    }
    if (key.downArrow || input === "j") {
      return setIndex((at) => (at === roots.length - 1 ? 0 : at + 1));
    }
    if (key.return) {
      const root = roots[index];
      if (root !== undefined) onPick(root);
    }
  });

  const room = listRows(terminalRows);
  const start = windowOf(roots.length, index, room);
  const shown = roots.slice(start, start + room);

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
      <Banner repoRoot={folder} repos={roots.length} columns={columns} rows={terminalRows} />

      {terminalRows >= ROOMY_ROWS ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate">
            {`There are ${roots.length} repositories in this folder, so grove cannot tell which you meant.`}
          </Text>
          <Text dimColor wrap="truncate">
            Pick one to open, or start grove from inside the one you want.
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {shown.map((root, offset) => {
          const selected = start + offset === index;

          return (
            <Text key={root} wrap="truncate">
              <Text color={theme.accent}>{selected ? "▸ " : "  "}</Text>
              <Text color={selected ? theme.accent : undefined} bold={selected}>
                {basename(root)}
              </Text>
            </Text>
          );
        })}
        {roots.length > shown.length ? (
          <Text dimColor wrap="truncate">{`  ${index + 1} of ${roots.length}`}</Text>
        ) : null}
      </Box>

      <Box flexGrow={1} />

      <StatusBar
        hints={[
          { keys: "↑↓", action: "move" },
          { keys: "enter", action: "open" },
          { keys: "q", action: "quit" },
        ]}
        columns={columns}
      />
    </Box>
  );
}
