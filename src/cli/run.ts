import { relative } from "node:path";
import { addWorktree } from "../core/commands/add.ts";
import { cloneRepo } from "../core/commands/clone.ts";
import { formatWorktreeTable, listWorktreeSummaries } from "../core/commands/list.ts";
import { worktreePath } from "../core/commands/path.ts";
import { removeWorktree } from "../core/commands/remove.ts";
import { resetWorktree } from "../core/commands/reset.ts";
import { failureFor, syncWorktrees } from "../core/commands/sync.ts";
import { findRepoRoot } from "../core/discover.ts";
import type { Reporter } from "../report/reporter.ts";
import type { GlobalOptions, GroveCommand } from "./args.ts";
import { installShellInit } from "./install.ts";
import { type Shell, shellInit } from "./shell-init.ts";

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

/** Paths are reported relative to where the user is standing, when that is shorter. */
function display(cwd: string, path: string): string {
  const rel = relative(cwd, path);

  // Empty means it *is* the current directory, which "." says and an absolute
  // path buries — and that is the row people scan for.
  if (rel.length === 0) return ".";

  return rel.length < path.length ? rel : path;
}

export async function runCommand(command: GroveCommand, context: CommandContext): Promise<void> {
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

    case "add": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await addWorktree(
        repo,
        {
          branch: command.branch,
          from: command.from,
          fetch: command.fetch,
          push: command.push,
          setup: command.setup,
          trust: command.trust,
        },
        reporter,
      );

      if (result.alreadyPresent) reporter.info(`${command.branch} already has a worktree`);

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(`${display(cwd, result.path)}\t${result.branch}`);
      return;
    }

    case "path": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await worktreePath(repo, cwd, command.target);

      // Absolute on purpose, where every other command prints relative when it
      // is shorter: this one exists to be handed to `cd`, and a relative path
      // is only right from the directory it was relative to.
      if (global.json) reporter.out(JSON.stringify(result, null, 2));
      else reporter.out(result.path);
      return;
    }

    case "shell-init": {
      // No repository involved: this runs from rc files, before any repo exists.
      reporter.out(shellInit(command.shell as Shell));
      return;
    }

    case "install": {
      // No repository involved either — same reason as `shell-init` above.
      const result = await installShellInit(command.shell);

      if (result.outcome === "already-installed") {
        reporter.info(`already installed in ${result.rcFile}`);
      } else {
        reporter.info(`added to ${result.rcFile} — restart your shell, or run: ${result.line}`);
      }

      if (global.json) reporter.out(JSON.stringify(result, null, 2));
      else reporter.out(result.rcFile);
      return;
    }

    case "list": {
      const repo = await findRepoRoot(cwd, global.repo);
      const summaries = await listWorktreeSummaries(repo, cwd);

      if (global.json) {
        reporter.out(JSON.stringify(summaries, null, 2));
        return;
      }

      // An empty repository is not an error, and printing a blank line for it
      // would be worse than saying so.
      if (summaries.length === 0) {
        reporter.info("no worktrees");
        return;
      }

      reporter.out(formatWorktreeTable(summaries));
      return;
    }

    case "remove": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await removeWorktree(
        repo,
        cwd,
        { target: command.target, force: command.force, deleteBranch: command.deleteBranch },
        reporter,
      );

      if (result.unpushedWarning) reporter.warn(result.unpushedWarning);

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(display(cwd, result.path));
      return;
    }

    case "reset": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await resetWorktree(
        repo,
        cwd,
        { target: command.target, to: command.to, clean: command.clean },
        reporter,
      );

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(`${display(cwd, result.path)}\t${result.head}`);
      return;
    }

    case "sync": {
      const repo = await findRepoRoot(cwd, global.repo);
      const outcomes = await syncWorktrees(
        repo,
        cwd,
        {
          target: command.target,
          all: command.all,
          abortOnConflict: command.abortOnConflict,
          push: command.push,
        },
        reporter,
      );

      if (global.json) reporter.out(JSON.stringify(outcomes, null, 2));
      else reporter.out(outcomes.map((o) => `${display(cwd, o.path)}\t${o.kind}`).join("\n"));

      // Reported first, then thrown: with --all the successful worktrees are
      // still worth knowing about, and stdout is where that belongs.
      const failure = failureFor(outcomes);
      if (failure) throw failure;

      return;
    }
  }
}
