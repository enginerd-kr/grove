import { relative } from "node:path";
import { GroveError } from "../core/errors.ts";
import { runShell } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import type { Reporter } from "../report/reporter.ts";
import { HOOKS_FILE, type HookEnv, type Hooks, openHere, repoHooks } from "./config.ts";
import { isTrusted } from "./trust.ts";

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
  const waiting = opening === "" ? hooks.commands : [...hooks.commands, opening];
  if (waiting.length === 0 || hooks.fingerprint === undefined) return [];

  return (await isTrusted(repo.gitDir, hooks.fingerprint)) ? [] : waiting;
}

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
  section: { readonly commands: readonly string[]; readonly env: readonly HookEnv[] },
  /** How the refusal reads: `2 teardown commands in … — the worktree still goes`. */
  warning: { readonly noun: string; readonly tail: string },
  reporter: Reporter,
  /**
   * How much else this gate answers for without running it — `[setup]`'s `open`.
   *
   * A count and not a list, because `open` is one application however many
   * arguments spell it. The gate is here and not beside the caller that opens,
   * so that the promise this file makes stays literally true: one piece of code
   * decides trust for the whole file. Counted in the warning as well, because
   * "1 command has not been trusted" beside a file asking for two things is the
   * wrong number to read.
   */
  alsoGated = 0,
): Promise<{ ran: readonly string[]; failed?: HookFailure; untrusted: boolean }> {
  const { commands, env } = section;
  const gated = commands.length + alsoGated;

  const untrusted =
    gated > 0 &&
    hooks.fingerprint !== undefined &&
    !(await isTrusted(repo.gitDir, hooks.fingerprint));

  if (untrusted) {
    // Named by the file that actually governs, which is the trunk's — pointing
    // at the worktree being set up would send somebody to read a copy that
    // nothing consults, or to a file that is not there at all.
    const where = hooks.path === undefined ? HOOKS_FILE : relative(repo.root, hooks.path);

    reporter.warn(
      `${plural(gated, warning.noun)} in ${where} ${
        gated === 1 ? "has" : "have"
      } not been trusted here — ${warning.tail}`,
    );

    return { ran: [], untrusted };
  }

  const commandEnv = commandEnvFor(repo, target, env);

  const ran: string[] = [];
  let failed: HookFailure | undefined;

  for (const command of commands) {
    const step = reporter.step(`running ${command}`);
    const result = await runShell(command, { cwd: target.path, env: commandEnv });

    if (result.code !== 0) {
      step.fail(`${command} exited ${result.code}`);
      // The rest do not run. They were written as a sequence — an install and
      // then a build over what it installed — so carrying on past a failure
      // would be running the second half against the first half's absence.
      failed = { command, code: result.code, details: tail(result.stderr, result.stdout) };
      break;
    }

    step.succeed(`ran ${command}`);
    ran.push(command);
  }

  return { ran, failed, untrusted };
}

/** `1 command`, `2 commands` — the shared half of every warning here. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The last few lines a failed command said, on whichever stream it said them. */
function tail(stderr: string, stdout: string, max = 5): readonly string[] {
  return [stderr, stdout]
    .join("\n")
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max);
}
