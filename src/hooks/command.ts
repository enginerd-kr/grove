import { GroveError } from "../core/errors.ts";
import { runShell } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import { runtimeEnv } from "../core/runtime.ts";
import { toLines } from "../core/text.ts";
import type { Reporter } from "../report/reporter.ts";
import { type HookCommand, type HookEnv, type Hooks, namesSources } from "./config.ts";

/** Shared execution and environment for setup and teardown commands. */

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
export async function commandEnvFor(
  repo: RepoPaths,
  target: HookTarget,
  env: readonly HookEnv[],
): Promise<Record<string, string>> {
  const runtime = await runtimeEnv(repo, target.path);
  return {
    PORT: runtime.GROVE_PORT ?? "",
    COMPOSE_PROJECT_NAME: runtime.GROVE_SERVICE_NAME ?? "",
    ...Object.fromEntries(env.map(({ name, value }) => [name, value])),
    ...runtime,
    GROVE_ROOT: repo.root,
    GROVE_WORKTREE: target.path,
    GROVE_BRANCH: target.branch ?? "",
  };
}

/** Run the configured commands in order, stopping at the first failure. */
export async function runCommands(
  repo: RepoPaths,
  target: HookTarget,
  hooks: Hooks,
  section: { readonly commands: readonly HookCommand[]; readonly env: readonly HookEnv[] },
  reporter: Reporter,
): Promise<{ ran: readonly string[]; failed?: HookFailure }> {
  const { commands, env } = section;

  const commandEnv = commands.length > 0 ? await commandEnvFor(repo, target, env) : {};

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

  return { ran, failed };
}

/** The last few lines a failed command said, on whichever stream it said them. */
function tail(stderr: string, stdout: string, max = 5): readonly string[] {
  return toLines([stderr, stdout].join("\n"))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max);
}
