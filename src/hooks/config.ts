import { join } from "node:path";
import { defaultBranch } from "../core/branches.ts";
import { GroveError } from "../core/errors.ts";
import { BARE_DIR, type RepoPaths } from "../core/layout.ts";
import { listWorktrees } from "../core/worktrees.ts";
import { fingerprintOf } from "./trust.ts";

/**
 * `.grove.toml` — how a repository says what it wants done around a worktree.
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
 * This module is the file and nothing else: what it says, where it is read
 * from, and what each key is refused for. Doing what it says belongs to the
 * hooks beside it — see `index.ts` for why they are their own package.
 *
 * The cost of travelling is `run`: a `git pull` can now hand you a command that
 * executes on your machine. So `copy` and `link` apply on sight — they move
 * files that are already on your disk, inside a directory you asked to be
 * created — and `run` does not, until `--trust` says so. See `trust.ts`: the
 * record is a fingerprint of these exact contents, kept in the bare
 * repository's config, so an edit withdraws it.
 *
 * `copy` takes a directory as readily as a file — `certs` above. A file already
 * in the worktree is overwritten with the trunk's copy, and a directory the
 * branch already checked out is merged entry by entry, the trunk winning where
 * both have one. See `copyEntry` and `takeOne` in `setup.ts` for why `link`
 * does not follow that rule.
 *
 * `open` is the last line of the file's story and the one hook here whose
 * subject is a person: `run` makes a checkout runnable, and `open` is the
 * editor you were going to start anyway. It is a separate key because it cannot
 * be a `run` line — see `open.ts`, which explains what letting go of a process
 * costs and why it is worth paying.
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
 * TOML because Bun parses it with no dependency, and because a file people are
 * expected to read and review deserves comments. It is read out of the trunk's
 * worktree and not out of the one being set up — see `readHooks` — which is
 * also what makes `env` usable: the committed file carries placeholders, and the
 * real values are an uncommitted edit to the one copy every worktree reads.
 */

export const HOOKS_FILE = ".grove.toml";

/** One `NAME=value` from `env`, split where the first `=` is. */
export type HookEnv = {
  readonly name: string;
  readonly value: string;
};

/**
 * `[teardown]` — the commands to run in a worktree just before it is removed.
 *
 * See `teardown.ts` for why the section exists at all.
 *
 * No `copy` and no `link`: there is nothing to take from a worktree on the way
 * out that could not have been committed. Only commands, and the environment
 * they need, which is its own rather than `[setup]`'s — the credential that
 * installs dependencies and the one that tears down a stack are rarely the
 * same, and sharing them would put both in reach of both.
 */
export type TeardownHook = {
  readonly env: readonly HookEnv[];
  readonly commands: readonly string[];
};

/** The platforms `[setup.open]` can name, which is every one grove runs on. */
export type OpenTarget = "macos" | "linux" | "windows";

/** One command line per platform, run in the worktree. `""` means "not here". */
export type OpenHook = Readonly<Record<OpenTarget, string>>;

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

export const NO_OPEN: OpenHook = { macos: "", linux: "", windows: "" };

/** Whether the file asked to open anything at all, on any platform. */
export function wantsOpen(open: OpenHook): boolean {
  return open.macos !== "" || open.linux !== "" || open.windows !== "";
}

/**
 * The `open` line for the platform this is running on, or `""`.
 *
 * The platform is read once, here, so that every question about `open` — what
 * is pending, what the trust gate counts, what actually starts — is answering
 * about the same line. A file that names only `macos` gives a Linux machine
 * nothing, which is "nothing to open" and not an error.
 */
export function openHere(hooks: Hooks, platform: NodeJS.Platform = process.platform): string {
  return hooks.open[openTargetFor(platform)];
}

export type Hooks = {
  /** Paths taken from the trunk, each a file or a whole directory. */
  readonly copy: readonly string[];
  readonly link: readonly string[];
  /** Given to every command, over the environment grove was started in. */
  readonly env: readonly HookEnv[];
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
  readonly open: OpenHook;
  /**
   * `[teardown]`, carried on the same record.
   *
   * One read of one file, because it is one file: `trust` records the whole of
   * its contents and both sections answer to that record, so splitting them
   * into two plans would mean two reads that could disagree about which
   * version of the file they were reading.
   */
  readonly teardown: TeardownHook;
  /** Absent when the worktree has no `.grove.toml`. */
  readonly path?: string;
  /** The file's contents, hashed — what `trust` records and compares. */
  readonly fingerprint?: string;
};

export const NO_TEARDOWN: TeardownHook = { env: [], commands: [] };

export const NO_HOOKS: Hooks = {
  copy: [],
  link: [],
  env: [],
  commands: [],
  open: NO_OPEN,
  teardown: NO_TEARDOWN,
};

/** How much of the file asked for something. Zero means there is nothing to do. */
export function plannedCount(hooks: Hooks): number {
  // `open` counts once however many arguments or platforms spell it: it is one
  // application, and the rest is how to start it rather than more work. Counted
  // even when this platform is not one it named, because the question here is
  // whether the file asked for anything — "nothing to do" and "no file at all"
  // are different answers and this is what tells them apart.
  return (
    hooks.copy.length + hooks.link.length + hooks.commands.length + (wantsOpen(hooks.open) ? 1 : 0)
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
    throw new GroveError("usage", `${HOOKS_FILE}: ${section}.${key} must be a list of strings`, {
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
function openAt(setup: Record<string, unknown>): OpenHook {
  const value = setup.open;
  if (value === undefined) return NO_OPEN;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const table = value as Record<string, unknown>;
    for (const key of Object.keys(table)) {
      if (OPEN_TARGETS.has(key)) continue;

      throw new GroveError(
        "usage",
        `${HOOKS_FILE}: [setup.open] has no key named ${JSON.stringify(key)}`,
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
    throw new GroveError("usage", `${HOOKS_FILE}: ${section}.${key} must be one command line`, {
      hint:
        `for example: ${key} = ${JSON.stringify(EXAMPLES[key] ?? EXAMPLES.open)} — ` +
        "and [setup.open] to say it differently per platform",
    });
  }

  if (value.trim().length === 0) {
    throw new GroveError("usage", `${HOOKS_FILE}: ${section}.${key} has nothing to open`, {
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

  throw new GroveError("usage", `${HOOKS_FILE}: ${section}.env has no name in ${wrote}`, {
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

  throw new GroveError("usage", `${HOOKS_FILE}: ${section}.env.${name} must be a string`, {
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
function envAt(section: string, table: Record<string, unknown>): readonly HookEnv[] {
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
export function parseHooks(text: string): Hooks {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new GroveError("usage", `${HOOKS_FILE} is not valid TOML`, {
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
    throw new GroveError("usage", `${HOOKS_FILE}: [${name}] must be a table`);
  }

  const table = section as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (known.has(key)) continue;

    throw new GroveError(
      "usage",
      `${HOOKS_FILE}: [${name}] has no key named ${JSON.stringify(key)}`,
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
export async function readHooksFile(worktree: string): Promise<Hooks> {
  const path = join(worktree, HOOKS_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return NO_HOOKS;

  const text = await file.text();
  const hooks = parseHooks(text);

  return { ...hooks, path, fingerprint: fingerprintOf(text) };
}

/**
 * A configured path, checked rather than rewritten.
 *
 * Checked for a sharp reason: these paths are resolved twice, once against the
 * worktree being filled and once against the one being read from, so a `..`
 * that escaped would let a line in a config file copy `~/.ssh` into a directory
 * somebody is about to commit from.
 */
export function checkedPath(key: "copy" | "link" | string, value: string): string {
  const segments = value.split(/[/\\]/).filter((segment) => segment.length > 0 && segment !== ".");
  const bad =
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    segments.length === 0 ||
    segments.some((segment) => segment === ".." || segment === ".git" || segment === BARE_DIR);

  if (bad) {
    throw new GroveError("usage", `${key}: ${JSON.stringify(value)} is not a usable path`, {
      hint: "a relative path inside the worktree, such as `.env` or `config/local.json`",
    });
  }

  return segments.join("/");
}

/**
 * Reads the repository's `.grove.toml`, with its paths checked.
 *
 * **The trunk's copy, not the worktree being set up.** Both were tenable and
 * this one is uniform: a branch cut last month has no file in it, and reading
 * the local copy would mean the repository was configured for the worktrees
 * made after Tuesday and not the ones made before. It is also where copies come
 * from already, so there is one rule here rather than two.
 *
 * Paths are checked here rather than at the point of use, so a file with an
 * unusable path in it is refused as a whole: a run that copied two of three
 * paths and then explained the third would leave a worktree nobody can reason
 * about.
 */
export async function readHooks(worktree: string): Promise<Hooks> {
  const hooks = await readHooksFile(worktree);

  return {
    ...hooks,
    copy: hooks.copy.map((value) => checkedPath("copy", value)),
    link: hooks.link.map((value) => checkedPath("link", value)),
  };
}

/**
 * Where copies and links come from: the default branch's worktree.
 *
 * One rule, and a predictable one. "Whichever worktree you happen to be
 * standing in" would mean the `.env` you get depends on where your shell was,
 * and the trunk is the checkout that always exists and that nobody is
 * experimenting in.
 *
 * `self` is the trunk setting itself up, which is not a failure and not worth a
 * word — there is no third worktree to prefer, and the commands still run.
 */
export type Source =
  | { readonly kind: "at"; readonly path: string }
  | { readonly kind: "self" }
  | { readonly kind: "none"; readonly trunk?: string };

/** The default branch's worktree, which is what everything here reads from. */
async function trunkWorktree(repo: RepoPaths): Promise<string | undefined> {
  const source = await sourceWorktree(repo, "");

  return source.kind === "at" ? source.path : undefined;
}

/**
 * The repository's hooks: the trunk's file, or the worktree's own as a fallback.
 *
 * The fallback is for the one repository that has no trunk worktree — somebody
 * removed it — where reading nothing at all would be a worse answer than
 * reading what is in front of us.
 */
export async function repoHooks(repo: RepoPaths, fallback?: string): Promise<Hooks> {
  const trunk = (await trunkWorktree(repo)) ?? fallback;

  return trunk === undefined ? NO_HOOKS : readHooks(trunk);
}

export async function sourceWorktree(
  repo: RepoPaths,
  /** The worktree being filled, so the trunk can recognise itself in it. */
  worktree: string,
): Promise<Source> {
  let trunk: string;
  try {
    trunk = await defaultBranch(repo.gitDir);
  } catch {
    // A repository whose remote advertises no HEAD. Everything else here still
    // works, and failing the `add` this is running inside of would be a poor
    // trade for a `.env` we could not find a source for anyway.
    return { kind: "none" };
  }

  const worktrees = await listWorktrees(repo.gitDir);
  const record = worktrees.find((entry) => entry.branch === trunk);

  if (!record) return { kind: "none", trunk };
  if (record.path === worktree) return { kind: "self" };

  return { kind: "at", path: record.path };
}
