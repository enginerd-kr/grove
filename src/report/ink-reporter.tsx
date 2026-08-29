import { Box, render, Static } from "ink";
import { useRef, useSyncExternalStore } from "react";
// Imported one file at a time rather than through anything that gathers the UI
// up: the interactive app would come with it, and a one-shot `grove list` should
// not load a screen it will never render.
import { StatusBar } from "../ui/components/StatusBar.tsx";
import { StepRow } from "../ui/components/StepRow.tsx";
import { createStoreReporter, isStep, type Line, LineStore } from "./lines.ts";
import type { Reporter } from "./reporter.ts";

/**
 * The reporter for a command that was given something to do.
 *
 * Everything it draws goes to **stderr**, never stdout. That is the whole
 * reason it can exist alongside `grove list --json | jq`: the progress and the data
 * travel on different streams, so redrawing one cannot corrupt the other.
 */

function Progress({ store }: { readonly store: LineStore }) {
  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  // Kept in the order the lines settled, rather than filtered out of the list
  // in the order they were added. `<Static>` prints whatever sits past the
  // count it last saw, so the list it is given may only ever grow at the end: a
  // step that settles after a note was printed has to land *after* that note,
  // or Static prints the note a second time and the step's own row not at all.
  const printed = useRef(new Map<number, Line>());
  for (const line of lines) {
    if (isStep(line) && line.state === "running") continue;
    if (!printed.current.has(line.id)) printed.current.set(line.id, line);
  }

  const settled = [...printed.current.values()];
  const running = lines.filter((line) => isStep(line) && line.state === "running");

  return (
    <Box flexDirection="column">
      {/* Settled lines are printed once and never repainted; without this every
          finished step would be redrawn on each spinner tick. */}
      <Static items={settled}>{(line) => <StepRow key={line.id} line={line} />}</Static>
      {running.map((line) => (
        <StepRow key={line.id} line={line} />
      ))}
      {running.length > 0 ? <StatusBar hints={[{ keys: "ctrl+c", action: "cancel" }]} /> : null}
    </Box>
  );
}

export function createInkReporter(): Reporter {
  const store = new LineStore();

  const instance = render(<Progress store={store} />, {
    // Drawing on stderr is the contract, not a preference.
    stdout: process.stderr,
    // Whether to animate is left to Ink's own detection: it repaints on a
    // terminal and writes the frame once at unmount without one, which is what
    // a pipe or a CI log wants from a display it never asked to watch.
    // `--headless` is the way out of the display altogether.
    //
    // We install our own SIGINT handler, which also has to stop the running git
    // child; letting Ink exit first would leave that child behind.
    exitOnCtrlC: false,
    // Our error handler writes with console.error. Patching would route it into
    // the render loop and reorder it against the exit.
    patchConsole: false,
  });

  // Results are held back until the UI is gone. stdout and stderr are separate
  // streams but usually the same terminal, and a result printed mid-repaint
  // lands in the middle of a frame Ink is about to erase.
  const pending: string[] = [];

  const reporter = createStoreReporter(store, (text) => {
    pending.push(text.endsWith("\n") ? text : `${text}\n`);
  });

  return {
    ...reporter,
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit();

      for (const text of pending.splice(0)) process.stdout.write(text);
    },
  };
}
