#!/usr/bin/env bun
import { parseCliArgs } from "./cli/args.ts";
import { terminalAsker, terminalChooser } from "./cli/ask.ts";
import { ExitCode, errorToExitCode } from "./cli/exit-codes.ts";
import { runCommand } from "./cli/run.ts";
import { isGroveError } from "./core/errors.ts";
import { killRunningGit, traceGit } from "./core/git.ts";
import { createInkReporter } from "./report/ink-reporter.tsx";
import { createPlainReporter, type Reporter } from "./report/reporter.ts";
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
  //
  // The stack is not trusted to carry the message, though, which it normally
  // does on its first line. Under load Bun renders it as a bare `Error` with
  // the message gone, and what is left is a report naming a file and a line
  // number but not what went wrong — `Executable not found in $PATH: "git"`
  // becomes six frames of stack and no sentence. It is added back only when it
  // is actually missing, so the ordinary case does not say it twice.
  const described =
    error instanceof Error
      ? error.stack === undefined || !error.stack.includes(error.message)
        ? `${error.message}\n${error.stack ?? ""}`.trimEnd()
        : error.stack
      : String(error);

  console.error(described);
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

/**
 * Whether Ctrl-C has been pressed, which decides three things below.
 *
 * The commands clean up after themselves on the way out — `cloneRepo` deletes a
 * partial `.bare`, because discovery would otherwise find it and every later
 * command would trip over a repository that is half a repository. That cleanup
 * is a `catch`, and a `catch` only runs if the throw is allowed to travel. The
 * handler used to call `process.exit` the moment `reporter.close()` settled,
 * which for the plain reporter is a microtask — so the rollback was dead code
 * on the one path that needed it, and what stood in for it was `git` happening
 * to remove its own junk. That cover ends the instant the bare clone returns.
 */
let interrupted = false;

// Drawn unless told otherwise, and no TTY guard either way: piped and scripted
// are ordinary ways to run this, Ink writes its frame once when nothing is
// watching, and `--headless` is the one switch for anyone who wants plain lines
// regardless. Both reporters draw on stderr, so neither can disturb a result.
const drawn = command.global.headless ? createPlainReporter() : createInkReporter();

/**
 * The same reporter, with stdout shut off once Ctrl-C has been pressed.
 *
 * Letting the command unwind is what makes the rollbacks run, and it also means
 * a command can reach its result on the way out: interrupt `add` while its
 * `grove.setup` is installing and the worktree is genuinely there, so `add`
 * genuinely has a path to report. Printing it would still be wrong. stdout is
 * the data channel — the whole reporter interface exists to keep it that way —
 * and a pipeline reading a path from a command that exited 130 would act on a
 * result the person cancelled. The exit code says nothing to rely on came of
 * this, and stdout has to say the same thing.
 */
const reporter: Reporter = {
  ...drawn,
  out: (text) => {
    if (!interrupted) drawn.out(text);
  },
};

// Progress, not results: `--verbose` must not put anything on stdout, or it
// would break every pipeline it was turned on to debug.
if (command.global.verbose) traceGit((line) => reporter.info(line));

// A half-finished `git clone` is worse than none, so stop the child rather than
// letting it race the exit. 130 is the conventional 128 + SIGINT.
process.on("SIGINT", () => {
  // A second Ctrl-C means the unwind is taking longer than the person is
  // willing to wait, and the answer to that is always to go. Whatever is left
  // on disk at this point is what they chose over waiting.
  if (interrupted) process.exit(ExitCode.interrupted);

  // The first one stops the work and nothing else. Killing the child makes the
  // git call reject, the rejection unwinds through the command's own `catch`,
  // and the exit happens below once there is nothing half-made left behind.
  interrupted = true;
  killRunningGit();
});

/**
 * Whether there is somebody to ask, which is a stricter question than `canOpen`
 * in `run.ts`: an editor can be opened for a person who is merely watching, but
 * a question needs a keyboard, and both `--headless` and `--json` are the
 * spellings of a run that is a script whatever it is attached to.
 */
const attended =
  process.stdin.isTTY === true &&
  process.stderr.isTTY === true &&
  !command.global.headless &&
  !command.global.json;

try {
  await runCommand(command.command, {
    cwd: process.cwd(),
    global: command.global,
    reporter,
    ask: attended ? terminalAsker(reporter) : undefined,
    choose: attended ? terminalChooser(reporter) : undefined,
  });
  await reporter.close();

  // Interrupted, but it finished anyway — the signal landed on the last step,
  // or on one that had nothing left to stop. The work is done and correct, so
  // the only honest thing left to report is that it was interrupted.
  process.exit(interrupted ? ExitCode.interrupted : ExitCode.ok);
} catch (error) {
  await reporter.close();

  // The interrupt is the cause, so it is what the shell hears. Reporting the
  // git error underneath would tell a script the remote had failed, when what
  // actually happened is that somebody pressed Ctrl-C.
  if (interrupted) process.exit(ExitCode.interrupted);
  fail(error);
}
