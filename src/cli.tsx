#!/usr/bin/env bun
import { render } from "ink";
import { BIN_NAME, parseCliArgs } from "./cli/args.ts";
import { App } from "./ui/index.ts";

const command = parseCliArgs(Bun.argv.slice(2));

if (command.kind === "error") {
  console.error(`${command.message}\nRun with --help for usage.`);
  process.exit(2);
}

// Before the TTY guard on purpose: `--help` and `--version` are the two things
// that must answer when piped, which is how every other CLI behaves.
if (command.kind === "text") {
  console.log(command.output);
  process.exit(0);
}

// Ink needs raw mode for keyboard input, which only a TTY provides. Piping the
// output (`bun run ui | cat`) would otherwise crash inside `useInput`.
if (!process.stdin.isTTY) {
  console.error(`${BIN_NAME} needs an interactive terminal (stdin is not a TTY).`);
  process.exit(1);
}

const { waitUntilExit } = render(<App initialTab={command.initialTab} />);

await waitUntilExit();
