import { describe, expect, test } from "bun:test";
import {
  createStoreReporter,
  isStep,
  type Line,
  LineStore,
  type NoteLine,
  type StepLine,
} from "./lines.ts";

/** The store's steps, already narrowed — most assertions are about `label`/`state`. */
function stepsOf(store: LineStore): readonly StepLine[] {
  return store.snapshot().filter(isStep);
}

/** A reporter wired to a fresh store, plus the sink `out()` writes into. */
function wired() {
  const store = new LineStore();
  const sink: string[] = [];
  const reporter = createStoreReporter(store, (text) => sink.push(text));

  return { store, sink, reporter };
}

describe("LineStore", () => {
  test("starts empty", () => {
    expect(new LineStore().snapshot()).toEqual([]);
  });

  test("a step is added running, with no percent yet", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");

    expect(store.snapshot()).toEqual([{ kind: "step", id, label: "cloning", state: "running" }]);
    // Absent rather than 0: `StepRow` draws the bar only once a percent exists,
    // and 0 would put an empty bar on every step that never reports one.
    expect(stepsOf(store)[0]?.percent).toBeUndefined();
  });

  test("notes carry their kind and text", () => {
    const store = new LineStore();
    store.addNote("info", "nothing to do");
    store.addNote("warn", "detached head");

    expect(store.snapshot()).toEqual([
      { kind: "info", id: 0, text: "nothing to do" },
      { kind: "warn", id: 1, text: "detached head" },
    ]);
  });

  test("ids come from one counter shared by steps and notes", () => {
    const store = new LineStore();
    const first = store.addStep("a");
    store.addNote("info", "between");
    const second = store.addStep("b");

    expect([first, second]).toEqual([0, 2]);
    expect(store.snapshot().map((line) => line.id)).toEqual([0, 1, 2]);
  });

  test("lines keep the order they arrived in", () => {
    const store = new LineStore();
    store.addStep("first");
    store.addNote("warn", "second");
    store.addStep("third");

    expect(store.snapshot().map((line) => (isStep(line) ? line.label : line.text))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("updateStep patches only the fields it names", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");

    store.updateStep(id, { percent: 40 });
    expect(stepsOf(store)[0]).toEqual({
      kind: "step",
      id,
      label: "cloning",
      state: "running",
      percent: 40,
    });

    store.updateStep(id, { label: "cloning objects" });
    expect(stepsOf(store)[0]?.percent).toBe(40);
    expect(stepsOf(store)[0]?.label).toBe("cloning objects");
  });

  test("an empty patch leaves the step alone", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");
    store.updateStep(id, {});

    expect(stepsOf(store)[0]).toEqual({ kind: "step", id, label: "cloning", state: "running" });
  });

  test("percent 0 is a value, not an absence", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");
    store.updateStep(id, { percent: 0 });

    expect(stepsOf(store)[0]?.percent).toBe(0);
  });

  test("a step runs to done, or to failed", () => {
    const store = new LineStore();
    const good = store.addStep("cloning");
    const bad = store.addStep("fetching");

    store.updateStep(good, { state: "done" });
    store.updateStep(bad, { state: "failed", label: "fetch failed" });

    expect(stepsOf(store).map((step) => [step.state, step.label])).toEqual([
      ["done", "cloning"],
      ["failed", "fetch failed"],
    ]);
  });

  // The store is a dumb container: refusing a second settle is the reporter's
  // job (see `createStoreReporter` below), so nothing here rejects it. Pinned
  // so moving that guard down here would be a deliberate change, not a silent one.
  test("the store itself allows a settled step to change state again", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");

    store.updateStep(id, { state: "done" });
    store.updateStep(id, { state: "failed" });
    expect(stepsOf(store)[0]?.state).toBe("failed");

    store.updateStep(id, { state: "running" });
    expect(stepsOf(store)[0]?.state).toBe("running");
  });

  test("updating an id that is not there changes nothing", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");
    const before = store.snapshot();

    store.updateStep(id + 99, { state: "done" });

    expect(store.snapshot()).toEqual(before);
  });

  test("a note cannot be patched as if it were a step", () => {
    const store = new LineStore();
    store.addNote("info", "nothing to do");

    store.updateStep(0, { state: "failed", label: "hijacked" });

    expect(store.snapshot()).toEqual([{ kind: "info", id: 0, text: "nothing to do" }]);
  });

  test("clear empties the lines but keeps handing out fresh ids", () => {
    const store = new LineStore();
    store.addStep("cloning");
    store.clear();

    expect(store.snapshot()).toEqual([]);
    // Ids are React keys. Restarting them would let a new line reuse the key of
    // one that just left, and `Static` would skip drawing it.
    expect(store.addStep("next")).toBe(1);
  });

  test("subscribers hear every commit and stop when they unsubscribe", () => {
    const store = new LineStore();
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard++;
    });

    const id = store.addStep("cloning");
    store.updateStep(id, { percent: 10 });
    store.addNote("info", "note");
    store.clear();
    expect(heard).toBe(4);

    unsubscribe();
    store.addStep("unheard");
    expect(heard).toBe(4);
  });

  test("two subscribers are both notified, and one leaving does not silence the other", () => {
    const store = new LineStore();
    let first = 0;
    let second = 0;
    const stop = store.subscribe(() => {
      first++;
    });
    store.subscribe(() => {
      second++;
    });

    store.addStep("cloning");
    stop();
    store.addStep("fetching");

    expect([first, second]).toEqual([1, 2]);
  });

  // `useSyncExternalStore` compares snapshots by reference: a mutated array
  // would render nothing, and a fresh array per read would render forever.
  test("the snapshot is one stable reference between commits, and a new one after", () => {
    const store = new LineStore();
    const before = store.snapshot();

    expect(store.snapshot()).toBe(before);

    store.addStep("cloning");
    const after = store.snapshot();
    expect(after).not.toBe(before);
    expect(store.snapshot()).toBe(after);
  });

  test("a snapshot already taken is not rewritten by later commits", () => {
    const store = new LineStore();
    const id = store.addStep("cloning");
    const taken = store.snapshot();

    store.updateStep(id, { state: "done" });

    expect(taken).toEqual([{ kind: "step", id, label: "cloning", state: "running" }]);
  });
});

describe("isStep", () => {
  const step: Line = { kind: "step", id: 0, label: "cloning", state: "running" };
  const info: Line = { kind: "info", id: 1, text: "nothing to do" };
  const warn: Line = { kind: "warn", id: 2, text: "detached head" };

  test("accepts a step and rejects both note kinds", () => {
    expect(isStep(step)).toBe(true);
    expect(isStep(info)).toBe(false);
    expect(isStep(warn)).toBe(false);
  });

  test("narrows to the step fields in the true branch", () => {
    const labels = [step, info, warn].filter(isStep).map((line) => line.label);

    expect(labels).toEqual(["cloning"]);
  });

  test("narrows to the note fields in the false branch", () => {
    const notes: NoteLine[] = [];
    for (const line of [step, info, warn]) if (!isStep(line)) notes.push(line);

    expect(notes.map((note) => note.text)).toEqual(["nothing to do", "detached head"]);
  });
});

describe("createStoreReporter", () => {
  test("a step starts running under the text it was given", () => {
    const { store, reporter } = wired();
    reporter.step("cloning");

    expect(store.snapshot()).toEqual([{ kind: "step", id: 0, label: "cloning", state: "running" }]);
  });

  test("update renames a running step and progress sets its percent", () => {
    const { store, reporter } = wired();
    const step = reporter.step("cloning");

    step.update("cloning objects");
    step.progress(42);

    expect(stepsOf(store)[0]).toEqual({
      kind: "step",
      id: 0,
      label: "cloning objects",
      state: "running",
      percent: 42,
    });
  });

  test("succeed marks the step done, keeping its label unless given a new one", () => {
    const { store, reporter } = wired();
    reporter.step("cloning").succeed();
    reporter.step("fetching").succeed("fetched 3 refs");

    expect(stepsOf(store).map((step) => [step.state, step.label])).toEqual([
      ["done", "cloning"],
      ["done", "fetched 3 refs"],
    ]);
  });

  test("fail marks the step failed, keeping its label unless given a new one", () => {
    const { store, reporter } = wired();
    reporter.step("cloning").fail();
    reporter.step("fetching").fail("no such remote");

    expect(stepsOf(store).map((step) => [step.state, step.label])).toEqual([
      ["failed", "cloning"],
      ["failed", "no such remote"],
    ]);
  });

  test("a settled step ignores every later settle", () => {
    const { store, reporter } = wired();
    const good = reporter.step("cloning");
    const bad = reporter.step("fetching");

    good.succeed();
    good.fail("too late");
    good.succeed("also too late");

    bad.fail("no such remote");
    bad.succeed("too late");

    expect(stepsOf(store).map((step) => [step.state, step.label])).toEqual([
      ["done", "cloning"],
      ["failed", "no such remote"],
    ]);
  });

  // `update` and `progress` are outside the settle guard, so a caller holding a
  // finished handle can still move it. No command does, but the row would
  // change under the reader if one did — pinned so that stays a known shape.
  test("update and progress still reach a step that has already settled", () => {
    const { store, reporter } = wired();
    const step = reporter.step("cloning");

    step.succeed();
    step.update("renamed after the fact");
    step.progress(10);

    expect(stepsOf(store)[0]).toEqual({
      kind: "step",
      id: 0,
      label: "renamed after the fact",
      state: "done",
      percent: 10,
    });
  });

  test("steps interleave: two open at once settle independently", () => {
    const { store, reporter } = wired();
    const first = reporter.step("cloning");
    const second = reporter.step("fetching");

    second.succeed();
    first.fail();

    expect(stepsOf(store).map((step) => [step.label, step.state])).toEqual([
      ["cloning", "failed"],
      ["fetching", "done"],
    ]);
  });

  test("info and warn become notes in call order", () => {
    const { store, reporter } = wired();
    reporter.info("nothing to do");
    reporter.warn("detached head");

    expect(store.snapshot()).toEqual([
      { kind: "info", id: 0, text: "nothing to do" },
      { kind: "warn", id: 1, text: "detached head" },
    ]);
  });

  test("out reaches the sink verbatim and never becomes a line", () => {
    const { store, sink, reporter } = wired();
    reporter.out("/repos/app/main");
    reporter.out("no trailing newline added here");

    expect(sink).toEqual(["/repos/app/main", "no trailing newline added here"]);
    // Whether results are buffered or newline-terminated belongs to whoever
    // supplied `out` — that is the entire reason it is a parameter.
    expect(store.snapshot()).toEqual([]);
  });

  test("the store and the sink stay disjoint across a whole command", () => {
    const { store, sink, reporter } = wired();

    const step = reporter.step("listing");
    step.progress(50);
    reporter.info("2 worktrees");
    step.succeed("listed");
    reporter.out("main");
    reporter.out("feat/login");

    expect(sink).toEqual(["main", "feat/login"]);
    expect(store.snapshot()).toEqual([
      { kind: "step", id: 0, label: "listed", state: "done", percent: 50 },
      { kind: "info", id: 1, text: "2 worktrees" },
    ]);
  });

  test("close resolves and leaves the store as it was", async () => {
    const { store, reporter } = wired();
    reporter.step("cloning").succeed();
    const before = store.snapshot();

    await reporter.close();

    expect(store.snapshot()).toBe(before);
  });

  test("the reporter writes through to whichever store it was handed", () => {
    const shared = new LineStore();
    const first = createStoreReporter(shared, () => {});
    const second = createStoreReporter(shared, () => {});

    first.step("cloning").succeed();
    second.info("done");

    expect(shared.snapshot().map((line) => line.id)).toEqual([0, 1]);
  });
});
