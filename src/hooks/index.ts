/**
 * Hooks — what a repository asks grove to do around a worktree.
 *
 * The rest of `core/` is worktree work: cutting a branch a directory, keeping
 * `.bare` and the layout honest, moving uncommitted changes between checkouts.
 * None of that is in here, and nothing in here is that. A hook is a line
 * somebody wrote in `.grove.toml` — copy this, link that, run these, open the
 * editor afterwards, and stop the container on the way out — and grove's part
 * is to read it, refuse what it cannot act on, ask before running what arrived
 * over the network, and say what happened.
 *
 * That is why it is a package and not two files under `core/`: the worktree
 * commands call in here, and nothing here calls back. `add` makes a worktree
 * and then hands it over; `remove` asks for the teardown before it takes the
 * directory away. Each of them keeps working with no `.grove.toml` at all,
 * which is the honest shape — hooks are what a project adds on top, not
 * something a worktree needs to exist.
 *
 * Inside, one file per hook and three they share:
 *
 * - `config.ts`   the files: what they say, and how the three of them stack up
 * - `trust.ts`    the record of having read it, kept out of the repository
 * - `command.ts`  a command line, its environment, and the gate they pass
 * - `setup.ts`    `[setup]` — filling a new worktree in
 * - `teardown.ts` `[teardown]` — what to stop before the directory goes
 * - `open.ts`     `open` — the one hook whose subject is a person
 *
 * This module is the face the rest of the tool uses. Tests and the hooks
 * themselves reach for the module they mean.
 */

export {
  commandEnvFor,
  failureFor,
  type HookFailure,
  type HookTarget,
  pendingCommands,
  setupGate,
} from "./command.ts";
export {
  configuredFiles,
  globalHooksPath,
  HOOKS_FILE,
  type Hooks,
  LOCAL_HOOKS_FILE,
  openHere,
  repoHooks,
  wantsOpen,
} from "./config.ts";
export { openWhatItAsksFor } from "./open.ts";
export {
  describeSetup,
  runSetup,
  type SetupOptions,
  type SetupResult,
  trustAndRun,
} from "./setup.ts";
export { runTeardown, type TeardownResult } from "./teardown.ts";
