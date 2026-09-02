import { GroveError } from "../core/errors.ts";
import { runShell } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import { plural, toLines } from "../core/text.ts";
import type { Reporter } from "../report/reporter.ts";
import {
  governingFiles,
  type HookCommand,
  type HookEnv,
  type Hooks,
  namesSources,
  openGatedHere,
  openHere,
} from "./config.ts";
import { repoHooks } from "./source.ts";
import { awaitingTrust } from "./trust.ts";

/**
 * What every hook has in common: a command line, an environment, and a gate.
 *
 * `[setup]` and `[teardown]` differ in which commands they hold and in what the
 * warning says; everything else about running them is the same, and being the
 * same is the point — one `--trust` covers the whole file and one edit
 * withdraws it, which only stays true while one piece of code decides it. So
 * the gate lives here, with the runner, rather than once per hook.
 */

/** Which worktree a hook runs in. `add` has one before git reports it. */
export type HookTarget = {
  readonly path: string;
  readonly branch?: string;
};

export type HookFailure = {
  readonly command: string;
  readonly code: number;
  readonly details: readonly string[];
};

/**
 * The commands a worktree was just denied, if any.
 *
 * The screen asks this straight after making a worktree, because that is the
 * moment the question means something: the files are in place, the commands are
 * not, and what is being agreed to is on the row in front of you. An empty
 * answer is every ordinary repository, and nothing is drawn for it.
 */
export async function pendingCommands(
  repo: RepoPaths,
  /** Where to read from when the trunk has no worktree yet — `clone`'s case. */
  fallback?: string,
): Promise<readonly string[]> {
  const hooks = await repoHooks(repo, fallback);
  // `open` is in here with the rest, because the question is "what would this
  // file run on your machine" and the answer has to be the whole answer. It is
  // the same shell on the same line; that grove stops watching it afterwards
  // makes it more worth listing rather than less.
  const opening = openHere(hooks);
  const lines = hooks.commands.map((command) => command.line);
  const waiting = opening === "" ? lines : [...lines, opening];
  // Nothing gated is nothing to ask about, whatever else the file asks for: a
  // `.grove.local.toml` you wrote is not a thing to be shown and asked to agree
  // to. Those commands run, and this returns the empty answer that says so.
  if (waiting.length === 0) return [];

  return (await awaitingTrust(repo.gitDir, setupGate(hooks).gated > 0, hooks.fingerprint))
    ? waiting
    : [];
}

/**
 * How much of `[setup]` the trust record answers for, and how much there is.
 *
 * Both halves, because the warning needs both: the count that has not been
 * trusted is the one to name, and the difference is what is being held back
 * with it. `open` is one either way — one application, however many arguments
 * spell it — and it is in here because the gate has to cover the whole of what
 * the file would start.
 */
export function setupGate(hooks: Hooks): Gate {
  return {
    gated: hooks.gated.commands + (openGatedHere(hooks) ? 1 : 0),
    total: hooks.commands.length + (openHere(hooks) === "" ? 0 : 1),
  };
}

/** `[teardown]`'s half of the same question. It has no `open`, so it is a count. */
export function teardownGate(hooks: Hooks): Gate {
  return { gated: hooks.gated.teardown, total: hooks.teardown.commands.length };
}

/**
 * What waits for `--trust`, and what waits with it.
 *
 * `gated` is what a `git pull` could have written — the part trust is actually
 * about. `total` is every command the section holds, gated or not, because a
 * refusal stops all of them: they were written as a sequence, and running the
 * half nobody had to agree to would be running it against the absence of the
 * other half.
 */
export type Gate = {
  readonly gated: number;
  readonly total: number;
};

/**
 * The error a failed command becomes, or nothing.
 *
 * Handed back rather than thrown from `runSetup` itself, so a caller can report
 * what did land before it raises what did not — the same shape `sync` uses, and
 * for the same reason: three files copied and then a failed install is two
 * facts, and swallowing the first one helps nobody debug the second.
 *
 * No hint. It used to name `grove setup <worktree>`, which is not a command
 * this tool has, and advice that sends somebody to a help page is worse than
 * none — what they need is on `details`, which is what the command itself said.
 *
 * Takes the failure and not a whole `SetupResult`, so `TeardownResult` — which
 * carries the same `failed` and nothing else this reads — gets the same
 * sentence rather than a second copy of it in `remove`.
 */
export function failureFor(result: { readonly failed?: HookFailure }): GroveError | undefined {
  if (!result.failed) return undefined;

  return new GroveError(
    "setup-failed",
    `${JSON.stringify(result.failed.command)} exited ${result.failed.code}`,
    { details: result.failed.details },
  );
}

/**
 * What a configured line runs with, over whatever grove itself was started in.
 *
 * `env` first and grove's own three last: `GROVE_WORKTREE` is this tool's
 * answer to "where am I", and a file that could overwrite it would be able to
 * lie to the script it is about to run.
 *
 * Not logged, and neither are the values anywhere else — the step line says the
 * command and not its environment, because `env` is where a token ends up and a
 * token belongs in no scrollback.
 */
export function commandEnvFor(
  repo: RepoPaths,
  target: HookTarget,
  env: readonly HookEnv[],
): Record<string, string> {
  return {
    ...Object.fromEntries(env.map(({ name, value }) => [name, value])),
    GROVE_ROOT: repo.root,
    GROVE_WORKTREE: target.path,
    GROVE_BRANCH: target.branch ?? "",
  };
}

/**
 * The commands one section asks for, run once somebody has read the file.
 *
 * This is the whole price of a configuration that travels with the project:
 * `copy` and `link` move files already on your disk, and `run` is a command
 * that arrived over the network. So the files land either way and the commands
 * do not, until `--trust` records these exact contents — and they stop again
 * the moment a pull changes them.
 */
export async function runCommands(
  repo: RepoPaths,
  target: HookTarget,
  /** The whole file, for the fingerprint that trust is keyed on and the path to name. */
  hooks: Hooks,
  section: { readonly commands: readonly HookCommand[]; readonly env: readonly HookEnv[] },
  /** How the refusal reads: `2 teardown commands in … — the worktree still goes`. */
  warning: { readonly noun: string; readonly tail: string },
  reporter: Reporter,
  /**
   * How much of this section the trust record answers for — see `Gate`.
   *
   * Worked out by the caller, which is the one that knows whether `open` is
   * part of its question, and passed rather than recomputed here so that the
   * promise this file makes stays literally true: one piece of code decides
   * trust for the whole file.
   */
  gate: Gate,
): Promise<{ ran: readonly string[]; failed?: HookFailure; untrusted: boolean }> {
  const { commands, env } = section;

  const untrusted = await awaitingTrust(repo.gitDir, gate.gated > 0, hooks.fingerprint);

  if (untrusted) {
    // Named by the files that actually govern, which are the trunk's — pointing
    // at the worktree being set up would send somebody to read a copy that
    // nothing consults, or to a file that is not there at all. Only the gated
    // ones: there is nothing to go and read in a file you wrote yourself.
    const where = governingFiles(hooks, repo.root).join(" and ");

    reporter.warn(
      `${plural(gate.gated, warning.noun)} in ${where} ${
        gate.gated === 1 ? "has" : "have"
      } not been trusted here — ${warning.tail}`,
    );

    // The ones nobody has to agree to, held back with the ones they do. Said
    // out loud because it is otherwise a file of your own that silently did
    // nothing, which is the failure `.grove.toml` refuses unknown keys over.
    const held = gate.total - gate.gated;
    if (held > 0) {
      reporter.info(`${plural(held, warning.noun)} of your own waited with ${where}`);
    }

    return { ran: [], untrusted };
  }

  const commandEnv = commandEnvFor(repo, target, env);

  // Which file the line was written in, said out loud only where there is more
  // than one it could have been — see `namesSources`. It goes on the step and
  // not on a line of its own, because the thing it explains is the command, and
  // a header would be a fact you have to carry down the list to use.
  const named = namesSources(hooks);
  const say = (command: HookCommand) =>
    named ? `${command.line} (${command.from})` : command.line;

  const ran: string[] = [];
  let failed: HookFailure | undefined;

  for (const command of commands) {
    const step = reporter.step(`running ${say(command)}`);
    const result = await runShell(command.line, { cwd: target.path, env: commandEnv });

    if (result.code !== 0) {
      step.fail(`${say(command)} exited ${result.code}`);
      // The rest do not run. They were written as a sequence — an install and
      // then a build over what it installed — so carrying on past a failure
      // would be running the second half against the first half's absence.
      failed = {
        command: command.line,
        code: result.code,
        details: tail(result.stderr, result.stdout),
      };
      break;
    }

    step.succeed(`ran ${say(command)}`);
    ran.push(command.line);
  }

  return { ran, failed, untrusted };
}

/** The last few lines a failed command said, on whichever stream it said them. */
function tail(stderr: string, stdout: string, max = 5): readonly string[] {
  return toLines([stderr, stdout].join("\n"))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max);
}
