import { relative } from "node:path";
import { addWorktree } from "../core/commands/add.ts";
import { cloneRepo } from "../core/commands/clone.ts";
import {
  diagnose,
  failureFor as diagnosisFailure,
  formatDiagnosis,
} from "../core/commands/doctor.ts";
import { formatWorktreeTable, listWorktreeSummaries } from "../core/commands/list.ts";
import { worktreePath } from "../core/commands/path.ts";
import { checkoutPullRequest } from "../core/commands/pr.ts";
import { describePrune, formatPruneTable, pruneWorktrees } from "../core/commands/prune.ts";
import { removeWorktree } from "../core/commands/remove.ts";
import { renameWorktree } from "../core/commands/rename.ts";
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
        cwd,
        {
          branch: command.branch,
          from: command.from,
          fetch: command.fetch,
          push: command.push,
          setup: command.setup,
          trust: command.trust,
          take: command.take,
        },
        reporter,
      );

      if (result.alreadyPresent) reporter.info(`${command.branch} already has a worktree`);
      // Said out loud rather than left to be discovered: `--take` emptied a
      // directory somebody was working in, and the sha is what undoes that.
      if (result.took?.stash !== undefined) {
        reporter.info(
          `the changes are also saved as a commit: git stash apply ${result.took.stash}`,
        );
      }

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(`${display(cwd, result.path)}\t${result.branch}`);
      return;
    }

    case "pr": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await checkoutPullRequest(
        repo,
        cwd,
        { pr: command.pr, setup: command.setup, trust: command.trust },
        reporter,
      );

      // A worktree that was already there is only "nothing happened" when the
      // branch did not move either; catching up with the pull request is the
      // outcome, and the same line has to say which of the two it was.
      if (result.updated === "fast-forwarded") {
        reporter.info(`${result.branch} caught up with pull request ${result.number}`);
      } else if (result.alreadyPresent) {
        reporter.info(`${result.branch} already has a worktree`);
      }

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

    case "doctor": {
      const repo = await findRepoRoot(cwd, global.repo);
      const diagnosis = await diagnose(repo);

      if (global.json) reporter.out(JSON.stringify(diagnosis, null, 2));
      else reporter.out(formatDiagnosis(diagnosis));

      // Printed first, then thrown, for the same reason `sync` does it: the
      // findings are what was asked for, and the exit code is for whatever is
      // reading them.
      const failure = diagnosisFailure(diagnosis);
      if (failure) throw failure;

      return;
    }

    case "prune": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await pruneWorktrees(
        repo,
        cwd,
        {
          only: command.only,
          dryRun: command.dryRun,
          deleteBranch: command.deleteBranch,
          fetch: command.fetch,
        },
        reporter,
      );

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      // The counts on stderr and the rows on stdout: `grove prune -n | wc -l`
      // should count worktrees, not read a sentence about them.
      reporter.info(describePrune(result));
      if (result.entries.length > 0) reporter.out(formatPruneTable(result));
      return;
    }

    case "rename": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await renameWorktree(
        repo,
        cwd,
        {
          target: command.target,
          to: command.to,
          push: command.push,
          force: command.force,
        },
        reporter,
      );

      if (result.upstreamNote) reporter.info(result.upstreamNote);
      if (result.standingNote) reporter.info(result.standingNote);

      if (global.json) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }

      reporter.out(`${display(cwd, result.path)}\t${result.to}`);
      return;
    }

    case "remove": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await removeWorktree(
        repo,
        cwd,
        {
          target: command.target,
          force: command.force,
          deleteBranch: command.deleteBranch,
          teardown: command.teardown,
        },
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
