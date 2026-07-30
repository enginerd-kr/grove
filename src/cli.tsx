#!/usr/bin/env bun
import { parseCliArgs } from "./cli/args.ts";
import { ExitCode, errorToExitCode } from "./cli/exit-codes.ts";
import { runCommand } from "./cli/run.ts";
import { isWtError } from "./core/errors.ts";
import { killRunningGit } from "./core/git.ts";
import { createPlainReporter } from "./report/reporter.ts";

const command = parseCliArgs(Bun.argv.slice(2));

if (command.kind === "error") {
  // Usage problems go to stderr even though they are not results, so that a
  // mistyped `wt list --json | jq` fails loudly instead of feeding jq garbage.
  console.error(command.message);
  if (command.usage) console.error(`\n${command.usage}`);
  process.exit(ExitCode.usage);
}

if (command.kind === "text") {
  console.log(command.output);
  process.exit(ExitCode.ok);
}

// No TTY guard: piped and scripted are ordinary ways to run this. The reporter
// is what adapts, and its plain form needs no terminal at all. `prefersPlainReporter`
// picks between this and the Ink one once that exists.
const reporter = createPlainReporter();

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

  if (isWtError(error)) {
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
