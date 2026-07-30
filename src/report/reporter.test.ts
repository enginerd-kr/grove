import { expect, test } from "bun:test";
import { createPlainReporter, type Writers } from "./reporter.ts";

function capture(): Writers & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
  };
}

// The single most important property here: a consumer piping stdout must see
// results and nothing else, however chatty the run was.
test("progress never touches stdout", () => {
  const writers = capture();
  const reporter = createPlainReporter(writers);

  const step = reporter.step("cloning");
  step.update("receiving objects");
  step.progress(42);
  step.succeed("cloned");
  reporter.info("noted");
  reporter.warn("careful");

  expect(writers.stdout).toEqual([]);
  expect(writers.stderr.join("")).toContain("cloning");
  expect(writers.stderr.join("")).toContain("cloned");
});

test("results go to stdout with exactly one trailing newline", () => {
  const writers = capture();
  const reporter = createPlainReporter(writers);

  reporter.out("plain");
  reporter.out("already terminated\n");

  expect(writers.stdout).toEqual(["plain\n", "already terminated\n"]);
});

test("a step reports once when it starts and once when it settles", () => {
  const writers = capture();
  const reporter = createPlainReporter(writers);

  reporter.step("fetching").succeed();

  expect(writers.stderr).toEqual(["· fetching\n", "✓ fetching\n"]);
});

test("succeed after fail is ignored so a step cannot report twice", () => {
  const writers = capture();
  const reporter = createPlainReporter(writers);

  const step = reporter.step("rebasing");
  step.fail("conflicted");
  step.succeed("rebased");

  expect(writers.stderr).toEqual(["· rebasing\n", "✗ conflicted\n"]);
});

test("update renames the step without printing a line of its own", () => {
  const writers = capture();
  const reporter = createPlainReporter(writers);

  const step = reporter.step("fetching");
  step.update("fetching origin");
  step.succeed();

  expect(writers.stderr).toEqual(["· fetching\n", "✓ fetching origin\n"]);
});
