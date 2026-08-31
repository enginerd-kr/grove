import { relative } from "node:path";
import { addWorktree } from "../core/commands/add.ts";
import { cloneRepo } from "../core/commands/clone.ts";
import {
  diagnose,
  failureFor as diagnosisFailure,
  formatDiagnosis,
} from "../core/commands/doctor.ts";
import {
  describeExec,
  failureFor as execFailure,
  execInWorktrees,
  execNotes,
  formatExec,
} from "../core/commands/exec.ts";
import { formatWorktreeTable, listWorktreeSummaries } from "../core/commands/list.ts";
import { openWorktree } from "../core/commands/open.ts";
import { worktreePath } from "../core/commands/path.ts";
import { checkoutPullRequest } from "../core/commands/pr.ts";
import { describePrune, formatPruneTable, pruneWorktrees } from "../core/commands/prune.ts";
import { removeWorktree } from "../core/commands/remove.ts";
import { renameWorktree } from "../core/commands/rename.ts";
import { resetWorktree } from "../core/commands/reset.ts";
import { setUpWorktrees, failureFor as setupFailure } from "../core/commands/setup.ts";
import { failureFor, syncWorktrees } from "../core/commands/sync.ts";
import { findRepoRoot } from "../core/discover.ts";
import { describeSetup } from "../hooks/index.ts";
import type { Reporter } from "../report/reporter.ts";
import type { GlobalOptions, GroveCommand } from "./args.ts";

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

  /**
   * Whether there is a terminal for `[setup] open` to open into.
   *
   * Worked out here because this is the layer that knows about a process at
   * all, and once, because `add` and `pr` must not be able to disagree about
   * it. `stdout` and not `stdin`: what is being asked is whether a person is
   * watching this run, and `grove add | tee` redirects the half they would be
   * watching.
   *
   * Deliberately not also `--headless`. That flag chooses how progress is
   * drawn, which is a different question from whether anybody is there to see
   * it — somebody who wants plain lines instead of a spinner still wants their
   * editor, and reading it as "no person here" would make one flag mean two
   * things.
   */
  const canOpen = process.stdout.isTTY === true;

  // Every command answers `--json` the same way — one document on stdout — so
  // the choice is made once here rather than restated in thirteen places.
  const report = (value: unknown, prose: () => void): void => {
    if (global.json) reporter.out(JSON.stringify(value, null, 2));
    else prose();
  };

  switch (command.name) {
    case "clone": {
      // `name` is the discriminant and nothing else; what is left is exactly the
      // options the core function takes, which is why it is spread rather than
      // copied field by field.
      const { name, ...options } = command;
      const result = await cloneRepo(cwd, options, reporter);

      report(result, () => reporter.out(`${display(cwd, result.worktree)}\t${result.branch}`));
      return;
    }

    case "add": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await addWorktree(repo, cwd, { ...options, open: canOpen }, reporter);

      if (result.alreadyPresent) reporter.info(`${command.branch} already has a worktree`);
      // Said out loud rather than left to be discovered: `--take` emptied a
      // directory somebody was working in, and the sha is what undoes that.
      if (result.took?.stash !== undefined) {
        reporter.info(
          `the changes are also saved as a commit: git stash apply ${result.took.stash}`,
        );
      }

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.branch}`));
      return;
    }

    case "pr": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await checkoutPullRequest(repo, cwd, { ...options, open: canOpen }, reporter);

      // A worktree that was already there is only "nothing happened" when the
      // branch did not move either; catching up with the pull request is the
      // outcome, and the same line has to say which of the two it was.
      if (result.updated === "fast-forwarded") {
        reporter.info(`${result.branch} caught up with pull request ${result.number}`);
      } else if (result.alreadyPresent) {
        reporter.info(`${result.branch} already has a worktree`);
      }

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.branch}`));
      return;
    }

    case "path": {
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await worktreePath(repo, cwd, command.target);

      // Absolute on purpose, where every other command prints relative when it
      // is shorter: this one exists to be handed to `cd`, and a relative path
      // is only right from the directory it was relative to.
      report(result, () => reporter.out(result.path));
      return;
    }

    case "open": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await openWorktree(repo, cwd, { ...options, open: canOpen }, reporter);

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.opened ?? ""}`));
      return;
    }

    case "list": {
      const repo = await findRepoRoot(cwd, global.repo);
      const summaries = await listWorktreeSummaries(repo, cwd);

      report(summaries, () => {
        // An empty repository is not an error, and printing a blank line for it
        // would be worse than saying so.
        if (summaries.length === 0) {
          reporter.info("no worktrees");
          return;
        }

        reporter.out(formatWorktreeTable(summaries));
      });
      return;
    }

    case "setup": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const results = await setUpWorktrees(repo, cwd, options, reporter);

      report(results, () =>
        reporter.out(
          results
            .map((result) => `${display(cwd, result.path)}\t${describeSetup(result)}`)
            .join("\n"),
        ),
      );

      // Printed first and thrown after, the way `sync --all` does it: with
      // `--all` the eight worktrees that were filled in are still the news, and
      // the ninth one's failed command is the exit code.
      const setupFailed = setupFailure(results);
      if (setupFailed) throw setupFailed;

      return;
    }

    case "exec": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const outcomes = await execInWorktrees(repo, options, reporter);

      report(outcomes, () => {
        for (const outcome of outcomes) {
          if (outcome.skipped !== undefined) {
            reporter.warn(`${outcome.dir}: ${outcome.skipped}`);
            continue;
          }

          // The heading on stderr, above the block it belongs to, so a person
          // watching can tell the blocks apart and a redirect gets only the
          // command's own words. See `formatExec`.
          reporter.info(outcome.dir);
          for (const line of execNotes(outcome)) reporter.info(line);

          const body = formatExec(outcome);
          if (body.length > 0) reporter.out(body);
        }

        reporter.info(describeExec(outcomes));
      });

      const execFailed = execFailure(outcomes);
      if (execFailed) throw execFailed;

      return;
    }

    case "doctor": {
      const repo = await findRepoRoot(cwd, global.repo);
      const diagnosis = await diagnose(repo);

      report(diagnosis, () => reporter.out(formatDiagnosis(diagnosis)));

      // Printed first, then thrown, for the same reason `sync` does it: the
      // findings are what was asked for, and the exit code is for whatever is
      // reading them.
      const failure = diagnosisFailure(diagnosis);
      if (failure) throw failure;

      return;
    }

    case "prune": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await pruneWorktrees(repo, cwd, options, reporter);

      report(result, () => {
        // The counts on stderr and the rows on stdout: `grove prune -n | wc -l`
        // should count worktrees, not read a sentence about them.
        reporter.info(describePrune(result));
        if (result.entries.length > 0) reporter.out(formatPruneTable(result));
      });
      return;
    }

    case "rename": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await renameWorktree(repo, cwd, options, reporter);

      if (result.upstreamNote) reporter.info(result.upstreamNote);
      // Composed here rather than carried in the result: the sentence has a
      // shell command inside it, and a shell command is not something `--json`
      // should be handing a program as data. The result says the fact.
      if (result.standingInOldPath) {
        reporter.info(`you are still standing in the old path: cd "$(grove path ${command.to})"`);
      }

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.to}`));
      return;
    }

    case "remove": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await removeWorktree(repo, cwd, options, reporter);

      if (result.unpushedWarning) reporter.warn(result.unpushedWarning);

      report(result, () => reporter.out(display(cwd, result.path)));
      return;
    }

    case "reset": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await resetWorktree(repo, cwd, options, reporter);

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.head}`));
      return;
    }

    case "sync": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const outcomes = await syncWorktrees(repo, cwd, options, reporter);

      report(outcomes, () =>
        reporter.out(outcomes.map((o) => `${display(cwd, o.path)}\t${o.kind}`).join("\n")),
      );

      // Reported first, then thrown: with --all the successful worktrees are
      // still worth knowing about, and stdout is where that belongs.
      const failure = failureFor(outcomes);
      if (failure) throw failure;

      return;
    }

    // Total by construction, the way `errorToExitCode` is: a new `GroveCommand`
    // without a case above fails the typecheck here rather than being parsed,
    // dispatched, and silently doing nothing. The assignment is what does it —
    // this switch returns no value, and without one TypeScript has nothing to
    // call missing.
    default: {
      const unhandled: never = command;
      throw new Error(`unhandled command ${JSON.stringify(unhandled)} — a bug in this tool`);
    }
  }
}
