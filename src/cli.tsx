#!/usr/bin/env bun
import { parseCliArgs } from "./cli/args.ts";
import { ExitCode, errorToExitCode } from "./cli/exit-codes.ts";
import { runCommand } from "./cli/run.ts";
import { isGroveError } from "./core/errors.ts";
import { killRunningGit, traceGit } from "./core/git.ts";
import { createInkReporter } from "./report/ink-reporter.tsx";
import { createPlainReporter } from "./report/reporter.ts";
import { runApp } from "./ui/app/run.tsx";

const command = parseCliArgs(Bun.argv.slice(2));

if (command.kind === "error") {
  // Usage problems go to stderr even though they are not results, so that a
  // mistyped `grove list --json | jq` fails loudly instead of feeding jq garbage.
  console.error(command.message);
  if (command.usage) console.error(`\n${command.usage}`);
  process.exit(ExitCode.usage);
}

if (command.kind === "text") {
  console.log(command.output);
  process.exit(ExitCode.ok);
}

/** The one place that decides what a thrown thing costs the process. */
function fail(error: unknown): never {
  if (isGroveError(error)) {
    console.error(error.message);
    for (const detail of error.details) console.error(`  ${detail}`);
    if (error.hint) console.error(`\n${error.hint}`);
    process.exit(errorToExitCode(error.code));
  }

  // Anything else is a bug here. Show the stack — there is no user-facing
  // advice to give, and hiding it only makes the report harder to act on.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(ExitCode.internal);
}

if (command.kind === "app") {
  // The screen needs a terminal to draw on and a keyboard to read from. Without
  // both — piped, scripted, or `--headless` — `grove` prints what it always did,
  // which is also what makes `grove | head` and `grove > usage.txt` keep working.
  const watched = process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (!watched || command.global.headless) {
    console.log(command.usage);
    process.exit(ExitCode.ok);
  }

  try {
    const outcome = await runApp({
      cwd: process.cwd(),
      repo: command.global.repo,
      onReporter: (reporter) => {
        if (command.global.verbose) traceGit((line) => reporter.info(line));
      },
    });

    // `^C` is an interrupt; `q` and `Esc` are a clean quit.
    process.exit(outcome === "interrupted" ? ExitCode.interrupted : ExitCode.ok);
  } catch (error) {
    fail(error);
  }
}

// Drawn unless told otherwise, and no TTY guard either way: piped and scripted
// are ordinary ways to run this, Ink writes its frame once when nothing is
// watching, and `--headless` is the one switch for anyone who wants plain lines
// regardless. Both reporters draw on stderr, so neither can disturb a result.
const reporter = command.global.headless ? createPlainReporter() : createInkReporter();

// Progress, not results: `--verbose` must not put anything on stdout, or it
// would break every pipeline it was turned on to debug.
if (command.global.verbose) traceGit((line) => reporter.info(line));

// A half-finished `git clone` is worse than none, so stop the child rather than
// letting it race the exit. 130 is the conventional 128 + SIGINT.
process.on("SIGINT", () => {
  killRunningGit();
  void reporter.close().finally(() => process.exit(ExitCode.interrupted));
});

try {
  await runCommand(command.command, {
    cwd: process.cwd(),
    global: command.global,
    reporter,
  });
  await reporter.close();
  process.exit(ExitCode.ok);
} catch (error) {
  await reporter.close();
  fail(error);
}
