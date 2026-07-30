import type { Reporter } from "../report/reporter.ts";
import type { GlobalOptions, WtCommand } from "./args.ts";

/**
 * Everything a command needs that it must not go looking for itself.
 *
 * `cwd` is passed rather than read so the commands stay testable without
 * chdir-ing a shared process, and so the e2e harness can aim the binary at a
 * throwaway repository.
 */
export type CommandContext = {
  readonly cwd: string;
  readonly global: GlobalOptions;
  readonly reporter: Reporter;
};

function notImplemented(name: string): never {
  // A plain Error on purpose: this is a gap in the tool, not something the user
  // did, so it exits 1 alongside the other bugs rather than posing as a
  // condition they could fix.
  throw new Error(`\`${name}\` is not implemented yet`);
}

export async function runCommand(command: WtCommand, _context: CommandContext): Promise<void> {
  switch (command.name) {
    case "clone":
    case "add":
    case "list":
    case "remove":
    case "sync":
      return notImplemented(command.name);
  }
}
