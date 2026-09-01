import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { GroveError } from "../core/errors.ts";
import { runGit } from "../core/git.ts";
import { BARE_DIR } from "../core/layout.ts";
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

/**
 * `.grove.local.toml` — the same file, for the part that is not the project's.
 *
 * `.grove.toml` travels, and that is both its point and its limit: it is a
 * tracked file on the default branch, so there is nowhere to write in a
 * repository you do not own. `grove pr 42` on somebody else's project is the
 * case that makes it concrete — the worktree still needs the `.env` and the
 * install, and a pull request is not where you put your own.
 *
 * So this one sits beside it, unignored at your peril and never committed:
 * whatever this machine wants that the project has not said. It is read out of
 * the same worktree the committed file is, which keeps one rule about where
 * configuration is read from rather than two.
 *
 * It is not gated on `--trust`, because trust answers a question this file does
 * not raise: a `run` line is dangerous when a `git pull` can change it, and
 * nothing pulls this. The exception is the repository that commits one anyway —
 * see `gatedLayer`, which asks git rather than taking the name's word for it.
 */
export const LOCAL_HOOKS_FILE = ".grove.local.toml";

/**
 * The same file again, once per machine rather than once per repository.
 *
 * `open = "code ."` is a fact about you and not about any project, and writing
 * it into every repository's `.grove.local.toml` is the bookkeeping this tool
 * exists to remove. This is where it goes instead, and every repository on the
 * machine reads it.
 *
 * `$XDG_CONFIG_HOME/grove/config.toml`, or `~/.config` where XDG is silent —
 * the same rule `update-check.ts` follows for the cache, one directory over.
 * Named `config.toml` and not `.grove.toml`: it is not beside a worktree, so
 * the leading dot would hide it in the one directory whose whole contents are
 * configuration.
 */
export function globalHooksPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");

  return join(base, "grove", "config.toml");
}

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
export const OPEN_TARGETS = ["macos", "linux", "windows"] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

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

export const NO_OPEN: OpenHook = mapTargets(() => "");

/** Whether the file asked to open anything at all, on any platform. */
export function wantsOpen(open: OpenHook): boolean {
  return OPEN_TARGETS.some((target) => open[target] !== "");
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
  /**
   * The files this was read from, lowest priority first.
   *
   * Kept rather than thrown away after the merge, because two questions later
   * on can only be answered by the layer a line came from: which files the
   * trust record covers, and which file to name when telling somebody to go
   * and read one.
   */
  readonly layers: readonly HookLayer[];
  /** How much of the above came from a file git could hand you. See `GatedCounts`. */
  readonly gated: GatedCounts;
  /** The gated layers' contents, hashed — what `trust` records and compares. */
  readonly fingerprint?: string;
};

/**
 * One file that was read, and whether trust has anything to say about it.
 *
 * `gated` is the whole of the security story for layering: a `run` line waits
 * for `--trust` when a `git pull` could have written it, and does not when it
 * could not. See `gatedLayer` for how that question is put to git.
 */
export type HookLayer = {
  readonly path: string;
  readonly gated: boolean;
  /** The file as it was read, for the fingerprint the gated ones are keyed on. */
  readonly text: string;
};

/**
 * How much of a merged file came from a layer that answers to `--trust`.
 *
 * Counted per section, and per platform for `open`, because that is the
 * precision the gate needs: a `.grove.toml` that only copies files has nothing
 * for trust to hold back, and holding back the `run` line your own
 * `.grove.local.toml` added on top of it would be asking you to agree to your
 * own file. Zero here means the gate is not in the way at all.
 */
export type GatedCounts = {
  readonly commands: number;
  readonly teardown: number;
  /** Per platform, because `open` merges per platform — see `mergeHooks`. */
  readonly open: Readonly<Record<OpenTarget, boolean>>;
};

export const NOTHING_GATED: GatedCounts = {
  commands: 0,
  teardown: 0,
  open: mapTargets(() => false),
};

/** Whether the `open` line that would actually run came from a gated layer. */
export function openGatedHere(hooks: Hooks, platform: NodeJS.Platform = process.platform): boolean {
  return hooks.gated.open[openTargetFor(platform)];
}

/**
 * Every file that was read, by the name it is written as.
 *
 * `governingFiles`'s counterpart, and the difference is the subject: that one
 * answers "what do I have to read before this will run", which only a gated
 * file can be the answer to, and this one answers "where was this decided",
 * which any layer can be. Bare names, because the sentence it feeds is about
 * the configuration and not about a file to go and open.
 */
export function configuredFiles(hooks: Hooks): readonly string[] {
  return hooks.layers.length === 0
    ? [HOOKS_FILE]
    : hooks.layers.map((layer) => basename(layer.path));
}

/**
 * The gated files, as paths somebody can open.
 *
 * Relative to the repository root, so the answer is `main/.grove.toml` and not
 * `.grove.toml`: the sentence this feeds says "go and read this", and there is
 * a copy of that name in every worktree, only one of which governs.
 *
 * An ungated layer is left out on purpose — there is nothing to go and read in
 * a file you wrote yourself — and a gated one is inside the repository by
 * construction, which is why the relative path is the readable spelling.
 */
export function governingFiles(hooks: Hooks, root: string): readonly string[] {
  const gated = hooks.layers
    .filter((layer) => layer.gated)
    .map((layer) => {
      const rel = relative(root, layer.path);

      return rel === "" || rel.startsWith("..") ? basename(layer.path) : rel;
    });

  return gated.length === 0 ? [HOOKS_FILE] : gated;
}

export const NO_TEARDOWN: TeardownHook = { env: [], commands: [] };

export const NO_HOOKS: Hooks = {
  copy: [],
  link: [],
  env: [],
  commands: [],
  open: NO_OPEN,
  teardown: NO_TEARDOWN,
  layers: [],
  gated: NOTHING_GATED,
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
  copy: ".env",
  link: "node_modules",
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
  /** The file being read, so a refusal names the one that has to be edited. */
  file: string,
  section: string,
  table: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = table[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];

  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new GroveError("usage", `${file}: ${section}.${key} must be a list of strings`, {
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
function openAt(file: string, setup: Record<string, unknown>): OpenHook {
  const value = setup.open;
  if (value === undefined) return NO_OPEN;

  if (isTable(value)) {
    refuseUnknownKeys(file, "setup.open", value, new Set(OPEN_TARGETS));

    return mapTargets((target) => commandAt(file, "setup.open", value, target));
  }

  const line = commandAt(file, "setup", setup, "open");

  return mapTargets(() => line);
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
function commandAt(
  file: string,
  section: string,
  table: Record<string, unknown>,
  key: string,
): string {
  const value = table[key];
  if (value === undefined) return "";

  if (typeof value !== "string") {
    throw new GroveError("usage", `${file}: ${section}.${key} must be one command line`, {
      hint:
        `for example: ${key} = ${JSON.stringify(EXAMPLES[key] ?? EXAMPLES.open)} — ` +
        "and [setup.open] to say it differently per platform",
    });
  }

  if (value.trim().length === 0) {
    throw new GroveError("usage", `${file}: ${section}.${key} has nothing to open`, {
      hint: `for example: ${key} = ${JSON.stringify(EXAMPLES[key] ?? EXAMPLES.open)}`,
    });
  }

  return value;
}

/** A plain TOML table: an object that is not an array, which TOML also parses to objects. */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An unknown key is an error, not something ignored.
 *
 * `cpoy = [".env"]` that quietly does nothing is the failure this file exists
 * to prevent, and every table here refuses the same way — same sentence, same
 * hint — so the refusal reads the same wherever the typo landed.
 */
function refuseUnknownKeys(
  file: string,
  label: string,
  table: Record<string, unknown>,
  known: ReadonlySet<string>,
): void {
  for (const key of Object.keys(table)) {
    if (known.has(key)) continue;

    throw new GroveError("usage", `${file}: [${label}] has no key named ${JSON.stringify(key)}`, {
      hint: `the keys are ${[...known].join(", ")}`,
    });
  }
}

const KNOWN = new Set(["copy", "link", "env", "run", "open"]);
const KNOWN_TEARDOWN = new Set(["env", "run"]);

/** A name a shell would accept, which is the only kind worth passing to one. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name, checked once, wherever the two spellings below found it. */
function checkedEnvName(file: string, section: string, name: string, wrote: string): string {
  if (ENV_NAME.test(name)) return name;

  throw new GroveError("usage", `${file}: ${section}.env has no name in ${wrote}`, {
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
function scalar(file: string, section: string, value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  throw new GroveError("usage", `${file}: ${section}.env.${name} must be a string`, {
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
function envAt(file: string, section: string, table: Record<string, unknown>): readonly HookEnv[] {
  const value = table.env;

  if (isTable(value)) {
    return Object.entries(value).map(([name, each]) => ({
      name: checkedEnvName(file, section, name, JSON.stringify(name)),
      value: scalar(file, section, each, name),
    }));
  }

  return stringsAt(file, section, table, "env").map((line) => {
    const at = line.indexOf("=");

    return {
      name: checkedEnvName(file, section, at === -1 ? "" : line.slice(0, at), JSON.stringify(line)),
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
export function parseHooks(text: string, file: string = HOOKS_FILE): Hooks {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new GroveError("usage", `${file} is not valid TOML`, {
      details: [error instanceof Error ? error.message : String(error)],
      cause: error,
    });
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const setup = tableAt(file, root, "setup", KNOWN);
  const teardown = tableAt(file, root, "teardown", KNOWN_TEARDOWN);

  // Read apart rather than one gating the other: a repository whose worktrees
  // need nothing on the way in and a `docker compose down` on the way out is an
  // ordinary repository, and returning nothing for it because `[setup]` was
  // absent would be the silent no-op this file's unknown-key check exists to
  // prevent, arrived at from the other side.
  return {
    copy: stringsAt(file, "setup", setup, "copy"),
    link: stringsAt(file, "setup", setup, "link"),
    env: envAt(file, "setup", setup),
    commands: stringsAt(file, "setup", setup, "run"),
    open: openAt(file, setup),
    teardown: {
      env: envAt(file, "teardown", teardown),
      commands: stringsAt(file, "teardown", teardown, "run"),
    },
    // What was read, and not where from: a text alone has no path and answers
    // to no trust record. `readLayer` is what knows both, and it is the only
    // caller that can say either honestly.
    layers: [],
    gated: NOTHING_GATED,
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
  file: string,
  root: Record<string, unknown>,
  name: string,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const section = root[name];
  if (section === undefined) return {};

  if (!isTable(section)) {
    throw new GroveError("usage", `${file}: [${name}] must be a table`);
  }

  refuseUnknownKeys(file, name, section, known);

  return section;
}

/**
 * One file, parsed, and told what trust has to say about it.
 *
 * A file that is not there is `undefined` and not `NO_HOOKS`: the difference
 * matters one level up, where a layer that exists and asks for nothing is still
 * a layer whose contents the trust record covers.
 */
async function readLayer(path: string, gated: boolean): Promise<Hooks | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;

  const text = await file.text();
  const hooks = parseHooks(text, basename(path));

  return {
    ...hooks,
    layers: [{ path, gated, text }],
    gated: gated
      ? {
          commands: hooks.commands.length,
          teardown: hooks.teardown.commands.length,
          open: mapTargets((target) => hooks.open[target] !== ""),
        }
      : NOTHING_GATED,
  };
}

/** The same answer for each platform, which is what half the merging here is. */
function mapTargets<T>(of: (target: OpenTarget) => T): Readonly<Record<OpenTarget, T>> {
  return Object.fromEntries(OPEN_TARGETS.map((target) => [target, of(target)])) as Record<
    OpenTarget,
    T
  >;
}

/**
 * Whether git tracks a file, which is whether a pull could have written it.
 *
 * The question the trust gate actually wants asked. `.grove.local.toml` is not
 * gated because nothing pushes it — but that is a claim about your repository,
 * not about the name, and a project that commits one has made it false. So it
 * is put to git rather than assumed, once, when the file turns up.
 *
 * A repository that cannot answer — no index, a worktree that has gone —
 * counts as tracked. The costly direction is the one that runs a command
 * nobody agreed to, and "ask again after `--trust`" is the cheap one.
 */
async function gatedLayer(worktree: string, name: string): Promise<boolean> {
  const result = await runGit(["ls-files", "--error-unmatch", "--", name], { cwd: worktree });

  return result.code === 0 || result.code > 1;
}

/**
 * Two layers, folded into the one file the rest of this package reads.
 *
 * **Each layer adds to the ones under it.** `copy` and `link` collect the paths
 * every layer named, and `run` collects the commands in the order the layers are
 * read, so the project's install runs before the step you added on top of it.
 * `open` and each `env` name are the exception, because there is only one editor
 * and one value for a name: the nearest layer that says anything wins, and
 * `open` decides that per platform, since a layer may name only the machine it
 * was written on.
 *
 * What a higher layer cannot do is un-say something. There is no key for
 * "not that one", and adding one would make the effective configuration a thing
 * you work out rather than read. A `run` line you want gone belongs out of the
 * file that has it.
 */
export function mergeHooks(base: Hooks, over: Hooks): Hooks {
  const names = new Set(over.env.map((each) => each.name));
  const teardownNames = new Set(over.teardown.env.map((each) => each.name));
  const takes = (target: OpenTarget) => over.open[target] !== "";

  return {
    copy: union(base.copy, over.copy),
    link: union(base.link, over.link),
    env: [...base.env.filter((each) => !names.has(each.name)), ...over.env],
    commands: [...base.commands, ...over.commands],
    open: mapTargets((target) => (takes(target) ? over.open[target] : base.open[target])),
    teardown: {
      env: [
        ...base.teardown.env.filter((each) => !teardownNames.has(each.name)),
        ...over.teardown.env,
      ],
      commands: [...base.teardown.commands, ...over.teardown.commands],
    },
    layers: [...base.layers, ...over.layers],
    gated: {
      commands: base.gated.commands + over.gated.commands,
      teardown: base.gated.teardown + over.gated.teardown,
      // The line that would run is the one whose gating counts, so this follows
      // `open` above exactly: whoever supplied the line supplies the answer.
      open: mapTargets((target) =>
        takes(target) ? over.gated.open[target] : base.gated.open[target],
      ),
    },
  };
}

/** Appended, minus what is already there: a path names the same thing twice. */
function union(base: readonly string[], over: readonly string[]): readonly string[] {
  return [...base, ...over.filter((path) => !base.includes(path))];
}

/**
 * What `trust` records, once there can be more than one file to record.
 *
 * Only the gated layers, because they are the only ones the record is about —
 * and a change to your own `.grove.local.toml` withdrawing the agreement you
 * gave to the project's file would be a question asked for no reason.
 *
 * One gated layer hashes its own text and nothing else, which is what this did
 * before layers existed. That is deliberate: every repository already carrying a
 * trust record has exactly one, and a fingerprint that changed shape would ask
 * every one of them to agree again to a file they have not touched.
 */
function fingerprintOfLayers(layers: readonly HookLayer[]): string | undefined {
  const gated = layers.filter((layer) => layer.gated);
  const first = gated[0];
  if (first === undefined) return undefined;
  if (gated.length === 1) return fingerprintOf(first.text);

  return fingerprintOf(gated.map((layer) => `${basename(layer.path)}\0${layer.text}`).join("\0"));
}

/** Where the machine-wide layer is read from, and who is allowed to say otherwise. */
export type HooksOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
};

/**
 * A configured path, checked rather than rewritten.
 *
 * Checked for a sharp reason: these paths are resolved twice, once against the
 * worktree being filled and once against the one being read from, so a `..`
 * that escaped would let a line in a config file copy `~/.ssh` into a directory
 * somebody is about to commit from.
 */
export function checkedPath(key: "copy" | "link", value: string): string {
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
export async function readHooks(worktree: string, options: HooksOptions = {}): Promise<Hooks> {
  // Read in the order they take effect, lowest first: the machine, then the
  // project, then the machine again with the project in front of it. The
  // sequence is the whole of the precedence rule, which is why it is one list
  // and not three calls with a comment each.
  const local = join(worktree, LOCAL_HOOKS_FILE);
  const found = [
    await readLayer(globalHooksPath(options.env, options.home), false),
    await readLayer(join(worktree, HOOKS_FILE), true),
    // Asked of git only once there is a file to ask about: the tracked check is
    // a process, and the repository that has no local layer is every repository.
    (await Bun.file(local).exists())
      ? await readLayer(local, await gatedLayer(worktree, LOCAL_HOOKS_FILE))
      : undefined,
  ].filter((layer): layer is Hooks => layer !== undefined);

  const hooks = found.reduce(mergeHooks, NO_HOOKS);

  return {
    ...hooks,
    copy: hooks.copy.map((value) => checkedPath("copy", value)),
    link: hooks.link.map((value) => checkedPath("link", value)),
    fingerprint: fingerprintOfLayers(hooks.layers),
  };
}

/**
 * The machine's own layer alone, for the repository that has no worktree to
 * read a project's file out of. It is about you and not about any repository,
 * so it applies to the one that has lost its trunk exactly as it does to every
 * other.
 */
export async function globalHooks(options: HooksOptions = {}): Promise<Hooks> {
  const global = await readLayer(globalHooksPath(options.env, options.home), false);

  return global ?? NO_HOOKS;
}
