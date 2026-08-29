import { describe, expect, test } from "bun:test";
import { createPlainReporter, type Reporter, type Step, type Writers } from "./reporter.ts";

/**
 * A reporter whose two streams are arrays.
 *
 * Injecting `Writers` rather than spying on `process` is what makes the stdout
 * rule assertable: the test can say "nothing at all landed on stdout" without
 * having to distinguish the reporter's writes from the runner's.
 */
function headless() {
  const out: string[] = [];
  const err: string[] = [];
  const writers: Writers = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const reporter: Reporter = createPlainReporter(writers);

  return { out, err, reporter };
}

/** Swaps a stream's `write` for the length of `run`, and always puts it back. */
function capturing(stream: NodeJS.WriteStream, run: (seen: string[]) => void): string[] {
  const seen: string[] = [];
  const original = stream.write;

  stream.write = ((chunk: unknown) => {
    seen.push(String(chunk));

    return true;
  }) as typeof stream.write;

  try {
    run(seen);
  } finally {
    stream.write = original;
  }

  return seen;
}

describe("createPlainReporter", () => {
  test("a step prints when it starts and again when it succeeds", () => {
    const { err, reporter } = headless();

    const step = reporter.step("cloning");
    expect(err).toEqual(["· cloning\n"]);

    step.succeed();
    expect(err).toEqual(["· cloning\n", "✓ cloning\n"]);
  });

  test("succeed and fail can replace the label on the closing line only", () => {
    const { err, reporter } = headless();

    reporter.step("cloning").succeed("cloned into main");
    reporter.step("fetching").fail("no such remote");

    expect(err).toEqual([
      "· cloning\n",
      "✓ cloned into main\n",
      "· fetching\n",
      "✗ no such remote\n",
    ]);
  });

  test("a failed step is marked ✗ and keeps its label when given no final text", () => {
    const { err, reporter } = headless();

    reporter.step("cloning").fail();

    expect(err).toEqual(["· cloning\n", "✗ cloning\n"]);
  });

  test("update is remembered for the closing line but never printed on its own", () => {
    const { err, reporter } = headless();

    const step = reporter.step("cloning");
    step.update("cloning objects");
    step.update("resolving deltas");
    expect(err).toEqual(["· cloning\n"]);

    step.succeed();
    expect(err).toEqual(["· cloning\n", "✓ resolving deltas\n"]);
  });

  test("a final text wins over anything update left behind", () => {
    const { err, reporter } = headless();

    const step = reporter.step("cloning");
    step.update("resolving deltas");
    step.fail("aborted");

    expect(err.at(-1)).toBe("✗ aborted\n");
  });

  test("progress prints nothing — percentages belong to the TTY reporter", () => {
    const { out, err, reporter } = headless();

    const step = reporter.step("cloning");
    for (let percent = 0; percent <= 100; percent += 10) step.progress(percent);

    expect(err).toEqual(["· cloning\n"]);
    expect(out).toEqual([]);
  });

  test("a step closes exactly once, however often it is settled", () => {
    const { err, reporter } = headless();

    const step = reporter.step("cloning");
    step.succeed();
    step.succeed("again");
    step.fail("and again");

    expect(err).toEqual(["· cloning\n", "✓ cloning\n"]);
  });

  test("a failed step stays failed when a later succeed arrives", () => {
    const { err, reporter } = headless();

    const step = reporter.step("cloning");
    step.fail("no such remote");
    step.succeed("recovered");

    expect(err).toEqual(["· cloning\n", "✗ no such remote\n"]);
  });

  test("info and warn get their own prefixes", () => {
    const { err, reporter } = headless();

    reporter.info("nothing to do");
    reporter.warn("detached head");

    expect(err).toEqual(["· nothing to do\n", "! detached head\n"]);
  });

  test("sequential steps read as a transcript, in call order", () => {
    const { err, reporter } = headless();

    reporter.step("cloning").succeed();
    reporter.info("2 worktrees");
    reporter.step("fetching").fail();

    expect(err.join("")).toBe("· cloning\n✓ cloning\n· 2 worktrees\n· fetching\n✗ fetching\n");
  });

  // There is no nesting in the transcript — the reporter has no notion of an
  // enclosing step — so an inner step opens and closes inside the outer one's
  // span, and the reader tells them apart by their labels.
  test("a step opened inside another interleaves rather than nests", () => {
    const { err, reporter } = headless();

    const outer = reporter.step("syncing 2 worktrees");
    const inner = reporter.step("syncing main");
    inner.succeed();
    const second = reporter.step("syncing feat/login");
    second.fail("conflict");
    outer.fail("1 of 2 failed");

    expect(err.join("")).toBe(
      [
        "· syncing 2 worktrees\n",
        "· syncing main\n",
        "✓ syncing main\n",
        "· syncing feat/login\n",
        "✗ conflict\n",
        "✗ 1 of 2 failed\n",
      ].join(""),
    );
  });

  test("out terminates results with exactly one newline", () => {
    const { out, reporter } = headless();

    reporter.out("/repos/app/main");
    reporter.out("/repos/app/feat/login\n");
    reporter.out("");

    expect(out).toEqual(["/repos/app/main\n", "/repos/app/feat/login\n", "\n"]);
  });

  test("multi-line JSON is passed through untouched apart from the final newline", () => {
    const { out, reporter } = headless();
    const json = '[\n  {\n    "branch": "main"\n  }\n]';

    reporter.out(json);

    expect(out).toEqual([`${json}\n`]);
  });

  // The rule the interface exists for: `grove list --json | jq` has to work while
  // progress is on screen, so nothing but `out()` may reach stdout.
  test("nothing but out() ever reaches stdout", () => {
    const { out, err, reporter } = headless();

    const step = reporter.step("cloning");
    step.update("cloning objects");
    step.progress(50);
    step.succeed("cloned");
    reporter.info("nothing to do");
    reporter.warn("detached head");
    reporter.step("fetching").fail("no such remote");

    expect(out).toEqual([]);
    expect(err.length).toBe(6);

    reporter.out("main");
    expect(out).toEqual(["main\n"]);
  });

  test("close resolves and writes nothing", async () => {
    const { out, err, reporter } = headless();
    reporter.step("cloning").succeed();

    await reporter.close();

    expect(err).toEqual(["· cloning\n", "✓ cloning\n"]);
    expect(out).toEqual([]);
  });

  test("every Step handle is a fresh one, so labels do not leak between steps", () => {
    const { err, reporter } = headless();

    const first: Step = reporter.step("cloning");
    const second: Step = reporter.step("fetching");
    first.update("cloning objects");
    second.succeed();
    first.succeed();

    expect(err).toEqual(["· cloning\n", "· fetching\n", "✓ fetching\n", "✓ cloning objects\n"]);
  });

  test("without writers it uses the process streams, progress on stderr", () => {
    const stdout = capturing(process.stdout, () => {
      const stderr = capturing(process.stderr, () => {
        const reporter = createPlainReporter();
        reporter.step("cloning").succeed();
        reporter.warn("detached head");
        reporter.out("/repos/app/main");
      });

      expect(stderr).toEqual(["· cloning\n", "✓ cloning\n", "! detached head\n"]);
    });

    expect(stdout).toEqual(["/repos/app/main\n"]);
  });
});
