import { join } from "node:path";
import { GroveError } from "./errors.ts";
import { runGit, runGitOrThrow } from "./git.ts";

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
 * open = "code ."
 * ```
 *
 * The cost of travelling is `run`: a `git pull` can now hand you a command that
 * executes on your machine. So `copy` and `link` apply on sight — they move
 * files that are already on your disk, inside a directory you asked to be
 * created — and `run` does not, until `--trust` says so. See `isTrusted` and
 * `trust` below: the record is a fingerprint of these exact contents, kept in
 * the bare repository's config, so an edit withdraws it.
 *
 * `copy` takes a directory as readily as a file — `certs` above. A file already
 * in the worktree is overwritten with the trunk's copy, and a directory the
 * branch already checked out is merged entry by entry, the trunk winning where
 * both have one. See `copyEntry` and `takeOne` in `setup.ts` for why `link`
 * does not follow that rule.
 *
 * `open` is the last line of the file's story and the one thing here that is not
 * about the worktree: `run` makes a checkout runnable, and `open` is the editor
 * you were going to start anyway. It is a separate key because it cannot be a
 * `run` line. Those go through `runShell`, which is `detached` so that a
 * cancelled `bun install && bun run build` takes its whole tree down with it —
 * and a process group is exactly what an editor must not be in, because the
 * next Ctrl-C would close it. They are also awaited, which would leave `grove
 * add` sitting behind an editor nobody has quit yet, and their output is piped
 * somewhere nobody reads. `openShell` in `git.ts` does the opposite of all
 * three: started, watched only for the moment a mistake would show, and then
 * let go of.
 *
 * It is a command line like `run`'s, and it runs in the worktree, so `.` is the
 * worktree. What it is not is a line that works everywhere: `open -a` is macOS
 * and `xdg-open` is not, and `code` is on a Linux PATH long before macOS has
 * been asked to install the shim. A file whose whole claim is that it travels
 * cannot pick one of those, so `[setup.open]` writes it once per platform:
 *
 * ```toml
 * [setup.open]
 * macos = 'open -a "Visual Studio Code" .'
 * linux = "code ."
 * ```
 *
 * A platform the table leaves out opens nothing, and the run says so rather
 * than leaving somebody to wonder why their editor was the one that did not
 * appear. A bare `open = "code ."` fills all three, for the file whose team is
 * all on one kind of machine.
 *
 * One line and not a list, because the shell it is handed to already spells
 * "and this too" as `&&` — and because a list is what somebody reaches for when
 * what they wanted was the table above, which is where the refusal points them.
 *
 * Letting go is the price, and it is paid in what can be reported. No stream is
 * kept — a pipe nobody drains stops the writer, and one somebody drains holds
 * `grove` here for an editor's whole lifetime — so a line's own words are lost.
 * What survives is the exit code, if there is one inside the moment `openShell`
 * watches for: `open -a "Visual Stuio Code" .` answers in about a sixth of a
 * second, and a misspelled editor that opened nothing and said nothing was the
 * worst thing this key could do. Past that moment a line is one that means to
 * keep running, which is what opening something looks like.
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

/**
 * `[teardown]` — what to run in a worktree just before it is removed.
 *
 * The other half of `[setup]`, and the half that was missing. A `run` line that
 * starts a container, a database, or a tunnel leaves that thing running after
 * the directory it was started in is gone, and nothing in the repository ever
 * said how to stop it — so it was stopped by hand, by whoever remembered, or
 * not at all. This is where the project says it once.
 *
 * No `copy` and no `link`: there is nothing to take from a worktree on the way
 * out that could not have been committed. Only commands, and the environment
 * they need, which is its own rather than `[setup]`'s — the credential that
 * installs dependencies and the one that tears down a stack are rarely the
 * same, and sharing them would put both in reach of both.
 */
export type TeardownPlan = {
  readonly env: readonly SetupEnv[];
  readonly commands: readonly string[];
};

/** The platforms `[setup.open]` can name, which is every one grove runs on. */
export type OpenTarget = "macos" | "linux" | "windows";

/** One command line per platform, run in the worktree. `""` means "not here". */
export type OpenPlan = Readonly<Record<OpenTarget, string>>;

/**
 * Which key a running platform answers to.
 *
 * Named for what people write on a config line rather than for what Node calls
 * them: `macos` and not `darwin`, `windows` and not `win32`. `linux` catches
 * every other Unix too, which is the honest reading — the rule there is "the
 * name is the command", and that is as true on FreeBSD as on Ubuntu. Not named
 * per distribution: `process.platform` cannot tell Ubuntu from Fedora, so an
 * `ubuntu` key would be a promise this could not keep.
 */
export function openTargetFor(platform: NodeJS.Platform): OpenTarget {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";

  return "linux";
}

export const NO_OPEN: OpenPlan = { macos: "", linux: "", windows: "" };

/** Whether the file asked to open anything at all, on any platform. */
export function wantsOpen(open: OpenPlan): boolean {
  return open.macos !== "" || open.linux !== "" || open.windows !== "";
}

export type SetupPlan = {
  /** Paths taken from the trunk, each a file or a whole directory. */
  readonly copy: readonly string[];
  readonly link: readonly string[];
  /** Given to every command, over the environment grove was started in. */
  readonly env: readonly SetupEnv[];
  /** Command lines, run in the order the file lists them. */
  readonly commands: readonly string[];
  /**
   * What to open the finished worktree with, per platform, as a command line.
   *
   * `""` is "nothing to open on that one" — either because the file said
   * nothing at all, or because it named the platforms it knew about and this
   * was not one of them. Run in the worktree, so `.` is the worktree.
   *
   * Three lines and not one, because there is no one line. `open -a` is macOS
   * and `code` is what is on a Linux PATH, and a file whose whole claim is that
   * it travels cannot pick one of those and be right on the other. A bare
   * `open = "code ."` fills all three, which is the common case and stays a
   * single line.
   *
   * Held apart from `commands` all the way down rather than merged with a flag:
   * every rule that applies to one is the opposite of the rule for the other —
   * awaited against watched-briefly-then-released, killable against not, part
   * of what `add` reports against beside it.
   */
  readonly open: OpenPlan;
  /**
   * `[teardown]`, carried on the same plan.
   *
   * One read of one file, because it is one file: `trust` records the whole of
   * its contents and both sections answer to that record, so splitting them
   * into two plans would mean two reads that could disagree about which
   * version of the file they were reading.
   */
  readonly teardown: TeardownPlan;
  /** Absent when the worktree has no `.grove.toml`. */
  readonly path?: string;
  /** The file's contents, hashed — what `trust` records and compares. */
  readonly fingerprint?: string;
};

export const EMPTY_TEARDOWN: TeardownPlan = { env: [], commands: [] };

export const EMPTY_PLAN: SetupPlan = {
  copy: [],
  link: [],
  env: [],
  commands: [],
  open: NO_OPEN,
  teardown: EMPTY_TEARDOWN,
};

/** How much of the file asked for something. Zero means there is nothing to do. */
export function plannedCount(plan: SetupPlan): number {
  // `open` counts once however many arguments or platforms spell it: it is one
  // application, and the rest is how to start it rather than more work. Counted
  // even when this platform is not one it named, because the question here is
  // whether the file asked for anything — "nothing to do" and "no file at all"
  // are different answers and this is what tells them apart.
  return (
    plan.copy.length + plan.link.length + plan.commands.length + (wantsOpen(plan.open) ? 1 : 0)
  );
}

/** What each key's error says to write instead, so the advice is about that key. */
const EXAMPLES: Readonly<Record<string, string>> = {
  run: "bun install",
  open: "code .",
  macos: 'open -a "Visual Studio Code" .',
  linux: "code .",
  windows: "code .",
  env: "UV_INDEX_USERNAME=PLACE_HOLDER",
};

/**
 * One key, which may be written as a list or as the single thing it usually is.
 *
 * `copy = ".env"` is what people write the first time, and refusing it would be
 * pedantry about a shape that has exactly one sensible reading.
 */
function stringsAt(
  section: string,
  table: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = table[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];

  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new GroveError("usage", `${SETUP_FILE}: ${section}.${key} must be a list of strings`, {
      hint: `for example: ${key} = [${JSON.stringify(EXAMPLES[key] ?? ".env")}]`,
    });
  }

  return value as readonly string[];
}

/**
 * `open`, in either of the two shapes it is written in.
 *
 * One name covers every platform, which is what most files want and what keeps
 * them one line long. A table names them apart, for the editor that is `Visual
 * Studio Code` to macOS and `code` to a Linux PATH — and each side keeps its
 * own arguments, which is the thing a `"macos:..."` prefix inside one string
 * could not have done without splitting on spaces and taking the quoting
 * problem back.
 *
 * A platform the table does not mention gets `[]` and opens nothing. That is
 * the whole of the rule: this file is written by whoever knows which machines
 * the team is on, and inventing a name for a platform they left out would be
 * guessing at an application that is not installed.
 */
function openAt(setup: Record<string, unknown>): OpenPlan {
  const value = setup.open;
  if (value === undefined) return NO_OPEN;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const table = value as Record<string, unknown>;
    for (const key of Object.keys(table)) {
      if (OPEN_TARGETS.has(key)) continue;

      throw new GroveError(
        "usage",
        `${SETUP_FILE}: [setup.open] has no key named ${JSON.stringify(key)}`,
        { hint: `the keys are ${[...OPEN_TARGETS].join(", ")}` },
      );
    }

    return {
      macos: commandAt("setup.open", table, "macos"),
      linux: commandAt("setup.open", table, "linux"),
      windows: commandAt("setup.open", table, "windows"),
    };
  }

  const line = commandAt("setup", setup, "open");

  return { macos: line, linux: line, windows: line };
}

/**
 * One command line, or nothing — the shape `open` is written in.
 *
 * A list is refused rather than read as several: `open` is one line, and the
 * shell it is handed to already spells "and then this too" as `&&`. The refusal
 * points at `[setup.open]`, because a list is what somebody reaches for when
 * what they actually wanted was to name the platforms apart.
 *
 * An empty string is refused for a different reason: `open = ""` reads as "open
 * nothing", and what it would do is start a shell that exits, which grove would
 * report as having opened something.
 */
function commandAt(section: string, table: Record<string, unknown>, key: string): string {
  const value = table[key];
  if (value === undefined) return "";

  if (typeof value !== "string") {
    throw new GroveError("usage", `${SETUP_FILE}: ${section}.${key} must be one command line`, {
      hint:
        `for example: ${key} = ${JSON.stringify(EXAMPLES[key] ?? EXAMPLES.open)} — ` +
        "and [setup.open] to say it differently per platform",
    });
  }

  if (value.trim().length === 0) {
    throw new GroveError("usage", `${SETUP_FILE}: ${section}.${key} has nothing to open`, {
      hint: `for example: ${key} = ${JSON.stringify(EXAMPLES[key] ?? EXAMPLES.open)}`,
    });
  }

  return value;
}

const OPEN_TARGETS: ReadonlySet<string> = new Set<OpenTarget>(["macos", "linux", "windows"]);

const KNOWN = new Set(["copy", "link", "env", "run", "open"]);
const KNOWN_TEARDOWN = new Set(["env", "run"]);

/** A name a shell would accept, which is the only kind worth passing to one. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name, checked once, wherever the two spellings below found it. */
function checkedEnvName(section: string, name: string, wrote: string): string {
  if (ENV_NAME.test(name)) return name;

  throw new GroveError("usage", `${SETUP_FILE}: ${section}.env has no name in ${wrote}`, {
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
function scalar(section: string, value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  throw new GroveError("usage", `${SETUP_FILE}: ${section}.env.${name} must be a string`, {
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
function envAt(section: string, table: Record<string, unknown>): readonly SetupEnv[] {
  const value = table.env;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(value).map(([name, each]) => ({
      name: checkedEnvName(section, name, JSON.stringify(name)),
      value: scalar(section, each, name),
    }));
  }

  return stringsAt(section, table, "env").map((line) => {
    const at = line.indexOf("=");

    return {
      name: checkedEnvName(section, at === -1 ? "" : line.slice(0, at), JSON.stringify(line)),
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
  const setup = tableAt(root, "setup", KNOWN);
  const teardown = tableAt(root, "teardown", KNOWN_TEARDOWN);

  // Read apart rather than one gating the other: a repository whose worktrees
  // need nothing on the way in and a `docker compose down` on the way out is an
  // ordinary repository, and returning nothing for it because `[setup]` was
  // absent would be the silent no-op this file's unknown-key check exists to
  // prevent, arrived at from the other side.
  return {
    copy: stringsAt("setup", setup, "copy"),
    link: stringsAt("setup", setup, "link"),
    env: envAt("setup", setup),
    commands: stringsAt("setup", setup, "run"),
    open: openAt(setup),
    teardown: {
      env: envAt("teardown", teardown),
      commands: stringsAt("teardown", teardown, "run"),
    },
  };
}

/**
 * One section, checked for keys it does not have.
 *
 * An unknown key is an error rather than something ignored, for both sections
 * and for the same reason: `cpoy = [".env"]` that quietly does nothing is the
 * exact failure this file exists to prevent.
 */
function tableAt(
  root: Record<string, unknown>,
  name: string,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const section = root[name];
  if (section === undefined) return {};

  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new GroveError("usage", `${SETUP_FILE}: [${name}] must be a table`);
  }

  const table = section as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (known.has(key)) continue;

    throw new GroveError(
      "usage",
      `${SETUP_FILE}: [${name}] has no key named ${JSON.stringify(key)}`,
      { hint: `the keys are ${[...known].join(", ")}` },
    );
  }

  return table;
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
