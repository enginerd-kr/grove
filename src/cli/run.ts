import { relative } from "node:path";
import { cloneRepo } from "../core/commands/clone.ts";
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

/** Paths are reported relative to where the user is standing, when that is shorter. */
function display(cwd: string, path: string): string {
  const rel = relative(cwd, path);

  return rel.length > 0 && rel.length < path.length ? rel : path;
}

export async function runCommand(command: WtCommand, context: CommandContext): Promise<void> {
  const { cwd, global, reporter } = context;

  switch (command.name) {
    case "clone": {
      const result = await cloneRepo(
        cwd,
        { url: command.url, dir: command.dir, branch: command.branch },
        reporter,
      );

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(`${display(cwd, result.worktree)}\t${result.branch}`);
      return;
    }
    case "add":
    case "list":
    case "remove":
    case "sync":
      return notImplemented(command.name);
  }
}
