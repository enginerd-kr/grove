import type { Reporter, Step } from "./reporter.ts";

/**
 * The imperative reporter interface meeting React's pull model.
 *
 * Commands call `step.progress(42)` from inside an async loop; a component
 * subscribes and re-renders. Snapshots are replaced rather than mutated so
 * `useSyncExternalStore` can compare them by reference and skip work.
 *
 * Shared rather than owned by the progress reporter, because the interactive
 * app runs the very same commands and needs the very same running/settled
 * lines — only laid out inside its own screen instead of scrolling past.
 */

export type StepLine = {
  readonly kind: "step";
  readonly id: number;
  readonly label: string;
  readonly percent?: number;
  readonly state: "running" | "done" | "failed";
};

// Split rather than a shared `kind: "info" | "warn"` member: a union member with
// two literals in one field is not a discriminant, and narrowing on it fails.
export type NoteLine = {
  readonly kind: "info" | "warn";
  readonly id: number;
  readonly text: string;
};

export type Line = StepLine | NoteLine;

export function isStep(line: Line): line is StepLine {
  return line.kind === "step";
}

export class LineStore {
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

  /** Drops everything drawn so far. The app calls this between actions. */
  clear(): void {
    this.commit([]);
  }
}

/**
 * A `Reporter` that writes into a store instead of onto a stream.
 *
 * `out` is left to the caller because results are the one thing the two users
 * disagree about: the progress reporter holds them back until Ink has released
 * the terminal, while the app has no stdout to protect and shows them in place.
 */
export function createStoreReporter(store: LineStore, out: (text: string) => void): Reporter {
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
    out,
    close: async () => {},
  };
}
