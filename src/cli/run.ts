import { relative } from "node:path";
import { addWorktree, warnSetupFailure } from "../core/commands/add.ts";
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
import { proposePullRequest, proposeStack } from "../core/commands/propose.ts";
import { describePrune, formatPruneTable, pruneWorktrees } from "../core/commands/prune.ts";
import {
  type RebaseBase,
  rebaseChoices,
  failureFor as rebaseFailure,
  rebaseWorktree,
} from "../core/commands/rebase.ts";
import { removeWorktree } from "../core/commands/remove.ts";
import { renameWorktree } from "../core/commands/rename.ts";
import { resetWorktree } from "../core/commands/reset.ts";
import { setUpWorktrees, failureFor as setupFailure } from "../core/commands/setup.ts";
import { formatStack, stackOf } from "../core/commands/stack.ts";
import { failureFor, syncWorktrees } from "../core/commands/sync.ts";
import { followUpstream } from "../core/commands/upstream.ts";
import { findRepoRoot } from "../core/discover.ts";
import { GroveError } from "../core/errors.ts";
import type { RepoPaths } from "../core/layout.ts";
import { recoverLine } from "../core/snapshot.ts";
import { plural } from "../core/text.ts";
import {
  describeSetup,
  type HookTarget,
  pendingCommands,
  pendingOpen,
  type SetupResult,
  trustAndRun,
} from "../hooks/index.ts";
import type { Reporter } from "../report/reporter.ts";
import type { GlobalOptions, GroveCommand } from "./args.ts";
import type { Ask, Choose } from "./ask.ts";

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
  /**
   * A question for the person at the terminal, when there is one.
   *
   * Absent on every run nobody is watching — piped, `--headless`, `--json` —
   * and the commands then do what they always did: say what is waiting on
   * `--trust` and carry on without it. See `ask.ts`.
   */
  readonly ask?: Ask;
  /**
   * A pick out of a few, for the one command whose question is not yes or no.
   *
   * Absent exactly where `ask` is, and `rebase` then needs its base spelled
   * out on the command line — a script cannot be shown a list.
   */
  readonly choose?: Choose;
};

/**
 * How many bases the terminal question lists.
 *
 * One key is one press, and the digits are the keys — so nine, and anything
 * past that is named as a count with the flag that reaches it. A repository
 * with more than nine worktrees to rebase onto is one where the name is worth
 * typing anyway.
 */
const OFFERED = 9;

/**
 * Asks which base a rebase goes onto, when no flag said.
 *
 * `rebaseChoices` is what the screen's `/rebase` lists too, so the two surfaces
 * offer the same rows in the same order: the branch's own remote, the parent it
 * was stacked on, the trunk, and the other worktrees' branches. Nobody to ask
 * is a usage error naming the flags — the same list, printed under it, so the
 * person reading it in a pipe's log can see what each flag would have meant.
 *
 * `undefined` is a key that picked nothing, which the caller reads as "leave it".
 */
async function chooseBase(
  repo: RepoPaths,
  cwd: string,
  target: string | undefined,
  choose: Choose | undefined,
  reporter: Reporter,
): Promise<RebaseBase | undefined> {
  const { dir, choices } = await rebaseChoices(repo, cwd, target);

  if (choose === undefined) {
    throw new GroveError("usage", `say where ${dir} goes: --upstream, --trunk, or --onto <ref>`, {
      hint: "nobody is at the terminal to pick one",
      details: choices.map((choice) => `${choice.label.padEnd(8)}  ${choice.ref}`),
    });
  }

  const offered = choices.slice(0, OFFERED);
  if (choices.length > offered.length) {
    reporter.info(
      `${plural(choices.length - offered.length, "more base")} not listed — --onto <ref> reaches any of them`,
    );
  }

  const key = await choose(
    `rebase ${dir} onto which base?`,
    offered.map((choice, index) => ({
      key: String(index + 1),
      label: choice.label,
      // A worktree's branch is its own label, and saying it twice is noise.
      detail: choice.ref === choice.label ? undefined : choice.ref,
    })),
  );
  if (key === undefined) return undefined;

  return offered[Number(key) - 1]?.base;
}

/**
 * Shows the commands `[setup]` is holding back, and asks.
 *
 * What `--trust` asks for is that somebody read the exact lines before they
 * run, and a question with the lines above it is that reading — the same
 * thing the screen does after `a`, from the one surface that could show them.
 * Nothing is asked where nothing is gated: a file already trusted here, or
 * commands out of a layer you wrote yourself, ran already.
 */
async function askAboutCommands(repo: RepoPaths, ask: Ask, reporter: Reporter): Promise<boolean> {
  const commands = await pendingCommands(repo);
  if (commands.length === 0) return false;

  for (const command of commands) reporter.info(`  ${command}`);

  return ask(`run ${plural(commands.length, "command")} from .grove.toml? y trusts the file`);
}

/**
 * `add` and `pr` made the worktree and were denied its commands; this asks
 * and, on `y`, runs them the way `--trust` would have.
 *
 * `trustAndRun` is what the screen's `y` calls too, so the record it writes is
 * the same one: answering here answers for `a` and for every later `add`. A
 * command that fails is a warning under a worktree that exists, exactly as it
 * is when `add --trust` runs it.
 */
async function offerSetup(
  repo: RepoPaths,
  target: HookTarget,
  ask: Ask,
  reporter: Reporter,
  open: boolean,
): Promise<SetupResult | undefined> {
  if (!(await askAboutCommands(repo, ask, reporter))) {
    reporter.info(`skipped — \`grove setup ${target.branch ?? ""} --trust\` runs them later`);
    return undefined;
  }

  const result = await trustAndRun(repo, target, reporter, { open });
  warnSetupFailure(result, reporter);

  return result;
}

/** Paths are reported relative to where the user is standing, when that is shorter. */
function display(cwd: string, path: string): string {
  const rel = relative(cwd, path);

  // Empty means it *is* the current directory, which "." says and an absolute
  // path buries — and that is the row people scan for.
  if (rel.length === 0) return ".";

  return rel.length < path.length ? rel : path;
}

export async function runCommand(command: GroveCommand, context: CommandContext): Promise<void> {
  const { cwd, global, reporter, ask, choose } = context;

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

    case "upstream": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await followUpstream(repo, options, reporter);

      report(result, () => reporter.out(`${result.trunk}\t${result.ref}`));
      return;
    }

    case "add": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await addWorktree(repo, cwd, { ...options, open: canOpen }, reporter);

      if (result.setup?.untrusted && ask) {
        await offerSetup(
          repo,
          { path: result.path, branch: result.branch },
          ask,
          reporter,
          canOpen,
        );
      }
      if (result.alreadyPresent) reporter.info(`${command.branch} already has a worktree`);
      // Said out loud rather than left to be discovered: `--take` emptied a
      // directory somebody was working in, and the sha is what undoes that.
      if (result.took?.stash !== undefined) {
        reporter.info(`the changes are also saved as a commit: ${recoverLine(result.took.stash)}`);
      }

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.branch}`));
      return;
    }

    case "pr": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await checkoutPullRequest(repo, cwd, { ...options, open: canOpen }, reporter);

      if (result.setup?.untrusted && ask) {
        await offerSetup(
          repo,
          { path: result.path, branch: result.branch },
          ask,
          reporter,
          canOpen,
        );
      }
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

    case "propose": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);

      // One line per pull request either way. `--stack` is a list because it
      // is several, and a script reading `--json` gets an array there and an
      // object here — the same split `setup --all` makes against `setup`.
      const line = (result: { path: string; url?: string; base: string }) =>
        `${display(cwd, result.path)}\t${result.url ?? result.base}`;

      if (options.stack) {
        const results = await proposeStack(repo, cwd, options, reporter);

        report(results, () => reporter.out(results.map(line).join("\n")));
        return;
      }

      const result = await proposePullRequest(repo, cwd, options, reporter);

      // The URL is the result: it is what gets pasted into the next message,
      // and `--web` has none to give yet, so the base stands in for it there.
      report(result, () => reporter.out(line(result)));
      return;
    }

    case "stack": {
      const { name, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);
      const result = await stackOf(repo, cwd, options);

      report(result, () => {
        // The trunk alone is a picture of nothing. Said on stderr, the way
        // `list` says `no worktrees`, and with the command that would change it.
        if (result.rows.length === 1) {
          reporter.info(
            options.all
              ? "nothing is stacked — `grove add <branch> --on <parent>` stacks one"
              : `${result.trunk} is the trunk, which every stack sits on — --all draws them`,
          );
          return;
        }

        reporter.out(formatStack(result));
      });
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
      let result = await openWorktree(repo, cwd, { ...options, open: canOpen }, reporter);

      // The line, then the question, then — on `y` — the same call with the
      // `--trust` that answer is. `pendingOpen` is what the screen's `/open`
      // asks, and the sentence is the one it puts on the row.
      if (result.untrusted && ask) {
        const waiting = await pendingOpen(repo, { path: result.path, branch: result.branch });
        if (
          waiting &&
          (await ask(
            `open ${result.dir} with \`${waiting.command}\`? nobody here has read ${waiting.files.join(" or ")}`,
          ))
        ) {
          result = await openWorktree(
            repo,
            cwd,
            { ...options, trust: true, open: canOpen },
            reporter,
          );
        }
      }

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
      let results = await setUpWorktrees(repo, cwd, options, reporter);

      // Asked once for however many worktrees: trust is one record for the
      // trunk's file, so one `y` answers for all of them. The run is repeated
      // rather than resumed because it is idempotent — `copy` takes the trunk's
      // version again and `link` leaves what is there — and the commands are
      // what was waiting.
      if (results.some((result) => result.untrusted) && ask) {
        if (await askAboutCommands(repo, ask, reporter)) {
          results = await setUpWorktrees(repo, cwd, { ...options, trust: true }, reporter);
        }
      }

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

    case "rebase": {
      const { name, base, ...options } = command;
      const repo = await findRepoRoot(cwd, global.repo);

      // The flag, or the question, or the usage error — decided here because
      // this is the layer that knows whether anybody is at the terminal.
      const onto = base ?? (await chooseBase(repo, cwd, command.target, choose, reporter));
      if (onto === undefined) {
        reporter.info("left as it is — nothing was rebased");
        return;
      }

      const result = await rebaseWorktree(repo, cwd, { ...options, base: onto }, reporter);

      report(result, () => reporter.out(`${display(cwd, result.path)}\t${result.kind}`));

      // The row first and the error after, the way `sync` does it: the row
      // says what state the worktree is in, and the exit code is for whatever
      // is reading it.
      const failure = rebaseFailure(result);
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
