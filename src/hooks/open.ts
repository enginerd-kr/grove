import { GroveError } from "../core/errors.ts";
import { openShell } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import type { Reporter } from "../report/reporter.ts";
import { commandEnvFor, type HookFailure, type HookTarget } from "./command.ts";
import {
  configuredFiles,
  governingFiles,
  type Hooks,
  openGatedHere,
  openHere,
  openTargetFor,
  repoHooks,
  wantsOpen,
} from "./config.ts";
import { isTrusted, trust } from "./trust.ts";

/**
 * `open` — the hook whose subject is a person rather than a worktree.
 *
 * Every other hook leaves something on disk that a script can go and read.
 * This one puts a window in front of whoever is sitting there, and that one
 * difference is where all of its rules come from.
 *
 * It cannot be a `run` line. Those go through `runShell`, which is `detached`
 * so that a cancelled `bun install && bun run build` takes its whole tree down
 * with it — and a process group is exactly what an editor must not be in,
 * because the next Ctrl-C would close it. They are also awaited, which would
 * leave `grove add` sitting behind an editor nobody has quit yet, and their
 * output is piped somewhere nobody reads. `openShell` in `../core/git.ts` does
 * the opposite of all three: started, watched only for the moment a mistake
 * would show, and then let go of.
 *
 * Letting go is the price, and it is paid in what can be reported. No stream is
 * kept — a pipe nobody drains stops the writer, and one somebody drains holds
 * `grove` here for an editor's whole lifetime — so a line's own words are lost.
 * What survives is the exit code, if there is one inside the moment `openShell`
 * watches for: `open -a "Visual Stuio Code" .` answers in about a sixth of a
 * second, and a misspelled editor that opened nothing and said nothing was the
 * worst thing this key could do. Past that moment a line is one that means to
 * keep running, which is what opening something looks like.
 */

/**
 * Starts `[setup] open`, once there is a worktree worth opening.
 *
 * Four things have to be true first, and each is a different kind of no.
 *
 * Trust is the same record the commands answer to — it is a shell line out of a
 * file that arrived with a pull, and `open = "curl … | sh"` reaches this
 * machine by exactly the road `run` does. Being let go of afterwards makes it
 * worse than `run`, not better, so it waits for the same `--trust`.
 *
 * A failed command stops it, even though nothing here depends on that command
 * having worked. `run` is what makes the checkout runnable and `open` is what
 * you do with it once it is; opening an editor onto a half-finished install
 * puts the failure two screens up in a scrollback nobody is looking at any
 * more, and the warning `add` prints is easier to read where it was printed.
 *
 * No terminal stops it too, and that one is an exception to a rule this tool
 * otherwise keeps — `add` behaves the same in a pipe as under a terminal
 * precisely so it is one tool and not two. What makes it affordable is the
 * paragraph at the top of this file: in `grove add | tee` or on CI there is
 * nobody sitting there for a window to be put in front of. So it is skipped,
 * and it says so rather than leaving the silence to be worked out.
 *
 * And a platform the file did not write a line for opens nothing, which is the
 * only one of the four that is not really a refusal.
 */
export async function openWhatItAsksFor(
  repo: RepoPaths,
  target: HookTarget,
  hooks: Hooks,
  state: {
    readonly untrusted: boolean;
    readonly failed?: HookFailure;
    /**
     * Whether there is a terminal to open into — `SetupOptions.open`, resolved.
     *
     * A boolean and not the options the caller was handed: this hook has no
     * business in `[setup]`'s shape, and taking the whole record would make the
     * two modules point at each other over one field.
     */
    readonly allowed: boolean;
  },
  reporter: Reporter,
): Promise<string | undefined> {
  const { untrusted, failed, allowed } = state;
  const command = openHere(hooks);

  if (command === "") {
    // Said once rather than left as silence: a file that opens an editor for
    // the rest of the team and not for you is a thing to find out from the run
    // that did not open one, not from asking why afterwards.
    if (wantsOpen(hooks.open) && !untrusted) {
      reporter.info(
        `nothing in ${configuredFiles(hooks).join(" and ")} opens on ` +
          openTargetFor(process.platform),
      );
    }

    return undefined;
  }

  if (untrusted) return undefined;

  if (failed !== undefined) {
    reporter.info(`did not open: ${failed.command} failed`);

    return undefined;
  }

  if (!allowed) {
    reporter.info("did not open: this is not a terminal");

    return undefined;
  }

  reporter.info(`opening ${command}`);

  try {
    const code = await openShell(command, {
      cwd: target.path,
      env: commandEnvFor(repo, target, hooks.env),
    });

    // `undefined` is the line still running, which is what opening something
    // looks like. A number means it was over before grove stopped watching, and
    // a non-zero one is the misspelled application this key used to swallow.
    if (code !== undefined && code !== 0) {
      reporter.warn(`could not open: ${command} exited ${code}`);

      return undefined;
    }
  } catch (error) {
    // The spawn itself, which is a worktree that stopped existing between being
    // made and being opened. Warned and not thrown, because the worktree is
    // what `add` was asked for and an editor that would not start is no reason
    // to report that it is missing.
    reporter.warn(`could not open: ${error instanceof Error ? error.message : String(error)}`);

    return undefined;
  }

  return command;
}

export type OpenNowResult = {
  /** The command that was started, if one was. See `SetupResult.opened`. */
  readonly opened?: string;
  /** The line is from a file git tracks, and this machine has not read it. */
  readonly untrusted: boolean;
};

/**
 * The same hook, asked for on its own — what `grove open` runs.
 *
 * `[setup]` opens a worktree once, at the end of the run that made it, and that
 * covers the day it is created and no day after. The worktree is still there
 * tomorrow; the editor is not. So the one key in the file whose subject is a
 * person is the one worth being able to ask for again, and this is where that
 * ask lands.
 *
 * Everything the hook refuses for it still refuses for, save one: there are no
 * `run` commands here to have failed, because nothing is being set up. What is
 * left is trust, a platform the file wrote no line for, and a terminal to open
 * into — and the file that opens nothing at all, which is a mistake when it is
 * what you asked for and merely quiet when it is the tail of an `add`.
 */
export async function openNow(
  repo: RepoPaths,
  target: HookTarget,
  reporter: Reporter,
  options: { readonly trust: boolean; readonly allowed: boolean },
): Promise<OpenNowResult> {
  const hooks = await repoHooks(repo, target.path);

  if (!wantsOpen(hooks.open)) {
    // Raised rather than reported, because this is the whole of what was asked
    // for. `add` says the same thing as an aside and carries on, having made
    // the worktree it was actually asked for.
    throw new GroveError("usage", `nothing in ${configuredFiles(hooks).join(" or ")} opens`, {
      hint: 'add an `open` line to [setup]: open = "code ."',
    });
  }

  // Recorded before the line is read back, exactly as `trustAndRun` does it, so
  // one answer covers the file's commands and its editor together.
  if (options.trust && hooks.fingerprint !== undefined) {
    await trust(repo.gitDir, hooks.fingerprint);
  }

  const untrusted =
    openGatedHere(hooks) &&
    hooks.fingerprint !== undefined &&
    !(await isTrusted(repo.gitDir, hooks.fingerprint));

  if (untrusted) {
    reporter.warn(
      `the open line in ${governingFiles(hooks, repo.root).join(" and ")} has not been ` +
        "trusted here — read it, then open with --trust",
    );

    return { untrusted };
  }

  const opened = await openWhatItAsksFor(
    repo,
    target,
    hooks,
    { untrusted, allowed: options.allowed },
    reporter,
  );

  return { opened, untrusted };
}

/** The line, and where to go and read it — what a screen needs to ask. */
export type PendingOpen = {
  readonly command: string;
  /** The gated files, as `governingFiles` spells them — what `trust` covers. */
  readonly files: readonly string[];
};

/**
 * The open line waiting on somebody here having read it, when one is waiting.
 *
 * `pendingCommands`' counterpart for the one hook whose subject is a person,
 * and it is here for the reason that one is: a screen cannot ask about a line
 * it cannot show. The command line has nobody to ask — `grove open` in a pipe
 * is the same tool as under a terminal — so it warns and names `--trust`. A
 * screen can put the exact line in front of whoever is sitting at it, and
 * reading it there is the whole of what trust was ever asking for.
 *
 * `undefined` is every case where opening simply happens: a file that opens
 * nothing on this platform, an open line out of a layer you wrote yourself, and
 * a file this machine has already read.
 */
export async function pendingOpen(
  repo: RepoPaths,
  target: HookTarget,
): Promise<PendingOpen | undefined> {
  const hooks = await repoHooks(repo, target.path);

  const command = openHere(hooks);
  if (command === "") return undefined;
  if (!openGatedHere(hooks) || hooks.fingerprint === undefined) return undefined;
  if (await isTrusted(repo.gitDir, hooks.fingerprint)) return undefined;

  return { command, files: governingFiles(hooks, repo.root) };
}
