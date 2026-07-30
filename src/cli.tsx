#!/usr/bin/env bun
import { parseCliArgs } from "./cli/args.ts";

const command = parseCliArgs(Bun.argv.slice(2));

if (command.kind === "error") {
  console.error(`${command.message}\nRun with --help for usage.`);
  process.exit(2);
}

// No TTY guard: this is a non-interactive CLI, so it has to work under a pipe
// and in CI. Ink returns only as a progress reporter drawn on stderr, and that
// reporter falls back to plain lines when stderr is not a terminal.
console.log(command.output);
process.exit(0);
