#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./App.tsx";

// Ink needs raw mode for keyboard input, which only a TTY provides. Piping the
// output (`bun run ui | cat`) would otherwise crash inside `useInput`.
if (!process.stdin.isTTY) {
  console.error("src/ui needs an interactive terminal (stdin is not a TTY).");
  process.exit(1);
}

const { waitUntilExit } = render(<App />);

await waitUntilExit();
