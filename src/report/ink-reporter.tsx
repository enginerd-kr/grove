import { Box, render, Static, Text } from "ink";
import { useSyncExternalStore } from "react";
import { ProgressBar, Spinner, StatusBar, theme } from "../ui/index.ts";
import type { Reporter, Step } from "./reporter.ts";

/**
 * The reporter for when someone is watching.
 *
 * Everything it draws goes to **stderr**, never stdout. That is the whole
 * reason it can exist alongside `wt list --json | jq`: the spinner and the data
 * travel on different streams, so redrawing one cannot corrupt the other.
 */

type StepLine = {
  readonly kind: "step";
  readonly id: number;
  readonly label: string;
  readonly percent?: number;
  readonly state: "running" | "done" | "failed";
};

// Split rather than a shared `kind: "info" | "warn"` member: a union member with
// two literals in one field is not a discriminant, and narrowing on it fails.
type NoteLine = {
  readonly kind: "info" | "warn";
  readonly id: number;
  readonly text: string;
};

type Line = StepLine | NoteLine;

function isStep(line: Line): line is StepLine {
  return line.kind === "step";
}

/**
 * The imperative reporter interface meeting React's pull model.
 *
 * Commands call `step.progress(42)` from inside an async loop; the component
 * subscribes and re-renders. Snapshots are replaced rather than mutated so
 * `useSyncExternalStore` can compare them by reference and skip work.
 */
class LineStore {
  private lines: readonly Line[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): readonly Line[] => this.lines;

  private commit(lines: readonly Line[]): void {
    this.lines = lines;
    for (const listener of this.listeners) listener();
  }

  addStep(label: string): number {
    const id = this.nextId++;
    this.commit([...this.lines, { kind: "step", id, label, state: "running" }]);

    return id;
  }

  addNote(kind: NoteLine["kind"], text: string): void {
    this.commit([...this.lines, { kind, id: this.nextId++, text }]);
  }

  updateStep(id: number, patch: Partial<Omit<StepLine, "id" | "kind">>): void {
    this.commit(
      this.lines.map((line) => (line.id === id && isStep(line) ? { ...line, ...patch } : line)),
    );
  }
}

function Row({ line }: { readonly line: Line }) {
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

function Progress({ store }: { readonly store: LineStore }) {
  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  const settled = lines.filter((line) => !isStep(line) || line.state !== "running");
  const running = lines.filter((line) => isStep(line) && line.state === "running");

  return (
    <Box flexDirection="column">
      {/* Settled lines are printed once and never repainted; without this every
          finished step would be redrawn on each spinner tick. */}
      <Static items={settled}>{(line) => <Row key={line.id} line={line} />}</Static>
      {running.map((line) => (
        <Row key={line.id} line={line} />
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

  return {
    step(text): Step {
      const id = store.addStep(text);
      let settled = false;

      const settle = (state: "done" | "failed", final?: string) => {
        if (settled) return;
        settled = true;
        store.updateStep(id, final === undefined ? { state } : { state, label: final });
      };

      return {
        update: (next) => store.updateStep(id, { label: next }),
        progress: (percent) => store.updateStep(id, { percent }),
        succeed: (final) => settle("done", final),
        fail: (final) => settle("failed", final),
      };
    },
    info: (text) => store.addNote("info", text),
    warn: (text) => store.addNote("warn", text),
    out: (text) => {
      pending.push(text.endsWith("\n") ? text : `${text}\n`);
    },
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit();

      for (const text of pending.splice(0)) process.stdout.write(text);
    },
  };
}
