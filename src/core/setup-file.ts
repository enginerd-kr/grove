import { join } from "node:path";
import { GroveError } from "./errors.ts";
import { gitSucceeds, runGit, runGitOrThrow } from "./git.ts";
import { BARE_DIR } from "./layout.ts";

/**
 * `.grove.toml` — how a repository says what its worktrees need.
 *
 * It is a tracked file in the worktree, and that is the point. "This project
 * copies `.env` and runs `bun install`" is a property of the project and not of
 * the laptop it is checked out on, so putting it anywhere machine-local means
 * every person on the team works it out again by hand. It travels, it is
 * reviewed in a pull request like anything else, and a new clone is set up
 * correctly before anybody has been told how.
 *
 * ```toml
 * [setup]
 * copy = [".env", "local.properties", "certs"]
 * link = ["node_modules"]
 * env  = { UV_INDEX_USERNAME = "PLACE_HOLDER" }
 * run  = ["uv sync"]
 * ```
 *
 * The cost of travelling is `run`: a `git pull` can now hand you a command that
 * executes on your machine. So `copy` and `link` apply on sight — they move
 * files that are already on your disk, inside a directory you asked to be
 * created — and `run` does not, until `grove trust` says so. See `trust.ts`.
 *
 * `copy` takes a directory as readily as a file — `certs` above — and a
 * directory the branch already checked out is filled in rather than replaced.
 * See `takeOne` in `setup.ts` for why that is not the same rule as `link`'s.
 *
 * TOML because Bun parses it with no dependency, and because a file people are
 * expected to read and review deserves comments. It is read out of the trunk's
 * worktree and not out of the one being set up — see `readSetupPlan` — which is
 * also what makes `env` usable: the committed file carries placeholders, and the
 * real values are an uncommitted edit to the one copy every worktree reads.
 */

export const SETUP_FILE = ".grove.toml";

/** One `NAME=value` from `env`, split where the first `=` is. */
export type SetupEnv = {
  readonly name: string;
  readonly value: string;
};

export type SetupPlan = {
  /** Paths taken from the trunk, each a file or a whole directory. */
  readonly copy: readonly string[];
  readonly link: readonly string[];
  /** Given to every command, over the environment grove was started in. */
  readonly env: readonly SetupEnv[];
  /** Command lines, run in the order the file lists them. */
  readonly commands: readonly string[];
  /** Absent when the worktree has no `.grove.toml`. */
  readonly path?: string;
  /** The file's contents, hashed — what `trust` records and compares. */
  readonly fingerprint?: string;
};

export const EMPTY_PLAN: SetupPlan = { copy: [], link: [], env: [], commands: [] };

/** How much of the file asked for something. Zero means there is nothing to do. */
export function plannedCount(plan: SetupPlan): number {
  return plan.copy.length + plan.link.length + plan.commands.length;
}

/** What each key's error says to write instead, so the advice is about that key. */
const EXAMPLES: Readonly<Record<string, string>> = {
  run: "bun install",
  env: "UV_INDEX_USERNAME=PLACE_HOLDER",
};

/**
 * One key, which may be written as a list or as the single thing it usually is.
 *
 * `copy = ".env"` is what people write the first time, and refusing it would be
 * pedantry about a shape that has exactly one sensible reading.
 */
function stringsAt(table: Record<string, unknown>, key: string): readonly string[] {
  const value = table[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];

  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new GroveError("usage", `${SETUP_FILE}: setup.${key} must be a list of strings`, {
      hint: `for example: ${key} = [${JSON.stringify(EXAMPLES[key] ?? ".env")}]`,
    });
  }

  return value as readonly string[];
}

const KNOWN = new Set(["copy", "link", "env", "run"]);

/** A name a shell would accept, which is the only kind worth passing to one. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name, checked once, wherever the two spellings below found it. */
function checkedEnvName(name: string, wrote: string): string {
  if (ENV_NAME.test(name)) return name;

  throw new GroveError("usage", `${SETUP_FILE}: setup.env has no name in ${wrote}`, {
    hint: `a name, then its value: ${EXAMPLES.env} — or UV_INDEX_USERNAME = "PLACE_HOLDER"`,
  });
}

/**
 * A TOML scalar as the string a process will actually receive.
 *
 * `PORT = 3000` is what somebody writes, and refusing it to insist on `"3000"`
 * would be pedantry about a shape with one reading — an environment holds
 * strings, so a number written in the file was always going to become one. A
 * list or a table is a different matter: there is no obvious string for those,
 * and guessing one is how a config file starts lying.
 */
function scalar(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  throw new GroveError("usage", `${SETUP_FILE}: setup.env.${name} must be a string`, {
    hint: `for example: ${name} = "PLACE_HOLDER"`,
  });
}

/**
 * `env`, written either way round.
 *
 * ```toml
 * env = ["UV_INDEX_USERNAME=PLACE_HOLDER"]        # a list of NAME=value
 * env = { UV_INDEX_USERNAME = "PLACE_HOLDER" }    # the same, as a table
 *
 * [setup.env]                                     # and the same again
 * UV_INDEX_USERNAME = "PLACE_HOLDER"
 * ```
 *
 * Both, because they are the same file to a reader and the second is the one
 * TOML would have chosen: a table is what a set of named values *is*, it quotes
 * its own values so a password full of `#` survives, and it is the spelling
 * anybody arriving from JSON or from a `.env` file already writes. The list
 * stays because `NAME=value` is what the shell prints and what people paste.
 *
 * The list form splits at the *first* `=`, so a value may hold as many more as
 * it likes — a token or a URL routinely does, and a second rule about escaping
 * them would be a worse file to read than the one line it saves.
 *
 * Values live here rather than in the environment grove happened to start in
 * because that environment is the thing that keeps not being there: the
 * credential exported from `~/.zshrc` is missing from every non-interactive
 * shell, from a login shell, and from anything a launcher started, and the
 * failure it produces is a 401 from inside `uv` that says nothing about shells.
 *
 * The file is committed with placeholders and the trunk's working copy holds
 * the real ones — which is exactly how much secrecy this offers, and it is not
 * much: the values sit in a file git can see, one `git add -A` away from being
 * pushed. For a real secret, keep pointing the tool at a credential store; this
 * is for the settings that merely have to *be there*.
 */
function envAt(table: Record<string, unknown>): readonly SetupEnv[] {
  const value = table.env;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(value).map(([name, each]) => ({
      name: checkedEnvName(name, JSON.stringify(name)),
      value: scalar(each, name),
    }));
  }

  return stringsAt(table, "env").map((line) => {
    const at = line.indexOf("=");

    return {
      name: checkedEnvName(at === -1 ? "" : line.slice(0, at), JSON.stringify(line)),
      value: line.slice(at + 1),
    };
  });
}

/**
 * Parses the file, refusing what it cannot act on.
 *
 * An unknown key is an error rather than something ignored. `cpoy = [".env"]`
 * that quietly does nothing is the exact failure this file exists to prevent —
 * somebody would find out weeks later, from a worktree that would not build.
 */
export function parseSetupFile(text: string): SetupPlan {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new GroveError("usage", `${SETUP_FILE} is not valid TOML`, {
      details: [error instanceof Error ? error.message : String(error)],
      cause: error,
    });
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const section = root.setup;
  if (section === undefined) return EMPTY_PLAN;

  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new GroveError("usage", `${SETUP_FILE}: [setup] must be a table`);
  }

  const table = section as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (KNOWN.has(key)) continue;

    throw new GroveError(
      "usage",
      `${SETUP_FILE}: [setup] has no key named ${JSON.stringify(key)}`,
      {
        hint: `the keys are ${[...KNOWN].join(", ")}`,
      },
    );
  }

  return {
    copy: stringsAt(table, "copy"),
    link: stringsAt(table, "link"),
    env: envAt(table),
    commands: stringsAt(table, "run"),
  };
}

/**
 * Reads the file out of one worktree.
 *
 * A worktree without one is not an error and not a warning: most repositories
 * need none of this, and the ones that do should be the ones that say so.
 */
export async function readSetupFile(worktree: string): Promise<SetupPlan> {
  const path = join(worktree, SETUP_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_PLAN;

  const text = await file.text();
  const plan = parseSetupFile(text);

  return { ...plan, path, fingerprint: fingerprintOf(text) };
}

/**
 * What `trust` records: the file's contents, not its name or its date.
 *
 * Contents, so that editing the file withdraws the trust it was given. That is
 * the whole mechanism — a `git pull` that changes the commands changes this,
 * and the commands stop running until somebody has read them again.
 */
export function fingerprintOf(text: string): string {
  return Bun.SHA256.hash(text, "hex");
}

const TRUST_KEY = "grove.trusted";

/**
 * Whether these exact contents have been trusted on this machine.
 *
 * The one thing here that stays in git config, and it has to: a tracked file
 * cannot vouch for itself, so the record of having read it belongs somewhere
 * the repository cannot write to. `.bare/config` is local, per-repository, and
 * never pushed.
 */
export async function isTrusted(bare: string, fingerprint: string): Promise<boolean> {
  const result = await runGit(["config", "--get-all", "--null", TRUST_KEY], { cwd: bare });
  if (result.code !== 0) return false;

  return result.stdout.split("\0").some((value) => value.trim() === fingerprint);
}

/** Records these contents as read and agreed to. Replaces any earlier answer. */
export async function trust(bare: string, fingerprint: string): Promise<void> {
  await runGitOrThrow(["config", "--replace-all", TRUST_KEY, fingerprint], { cwd: bare });
}

/** Forgets every answer, so the next run asks again. */
export async function revokeTrust(bare: string): Promise<boolean> {
  return gitSucceeds(["config", "--unset-all", TRUST_KEY], { cwd: bare });
}

/**
 * The file `--detect` proposes, as text somebody can read before it exists.
 *
 * Directories arrive commented out rather than left out. `link` shares one copy
 * between every worktree, which is right for a dependency cache and wrong for
 * anything a build writes into — so the line is written, and uncommenting it is
 * where the decision goes.
 *
 * `copy` is the third answer and is described rather than written: it takes a
 * directory too, but it already has a line of its own above, and a second one
 * waiting to be uncommented would be a duplicate key the moment somebody did.
 */
export function renderSetupFile(files: readonly string[], directories: readonly string[]): string {
  const list = (values: readonly string[]) =>
    `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

  const lines = ["[setup]"];

  if (files.length > 0) lines.push(`copy = ${list(files)}`);
  if (directories.length > 0) {
    lines.push("");
    lines.push("# A directory is a decision. `link` shares one copy between every worktree,");
    lines.push("# which suits a dependency cache and not a build output; adding it to `copy`");
    lines.push("# gives each worktree its own; a `run` command rebuilds it in each instead.");
    lines.push("# Uncomment whichever is true here.");
    lines.push(`# link = ${list(directories)}`);
    lines.push(`# run = ["bun install"]`);
  }

  return `${lines.join("\n")}\n`;
}

/** Where the file goes, and the `.bare` guard nothing else would catch. */
export function setupFilePath(worktree: string): string {
  if (worktree.endsWith(BARE_DIR)) {
    throw new GroveError("usage", `${SETUP_FILE} belongs in a worktree, not in ${BARE_DIR}`);
  }

  return join(worktree, SETUP_FILE);
}
