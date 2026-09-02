import { parseArgs } from "node:util";
import { version } from "../../package.json";
import type { RebaseBase } from "../core/commands/rebase.ts";
import type { FlagSpec, SubcommandSpec } from "./help.ts";
import {
  findSubcommand,
  formatGlobalHelp,
  formatSubcommandHelp,
  GLOBAL_FLAGS,
  SUBCOMMANDS,
} from "./help.ts";

/**
 * Argument parsing, kept apart from the process it drives.
 *
 * Returning a description of what to do — rather than printing and exiting in
 * place — is what makes every branch testable without spawning anything. For
 * the same reason nothing here reads `process`: the invocation directory is
 * injected by the entry point, so a test can pretend to run anywhere.
 */

export type GlobalOptions = {
  /** `-C/--repo`: skip discovery and use this directory. */
  readonly repo?: string;
  readonly json: boolean;
  readonly verbose: boolean;
  /** `--headless`: log progress as plain lines rather than drawing it. */
  readonly headless: boolean;
};

export type GroveCommand =
  | {
      readonly name: "clone";
      readonly url: string;
      readonly dir?: string;
      readonly branch?: string;
    }
  | {
      readonly name: "add";
      readonly branch: string;
      readonly from?: string;
      /** `--on`: the branch this one is stacked on, recorded as well as used as the base. */
      readonly on?: string;
      readonly fetch: boolean;
      readonly push: boolean;
      readonly setup: boolean;
      /** `--trust`: run `.grove.toml`'s commands, having read them. */
      readonly trust: boolean;
      /** `--take`: move the current worktree's uncommitted changes into the new one. */
      readonly take: boolean;
    }
  | {
      readonly name: "pr";
      /** As typed: a number, a URL, or a branch. `gh` resolves it, so we do not. */
      readonly pr: string;
      readonly setup: boolean;
      readonly trust: boolean;
    }
  | { readonly name: "list" }
  | { readonly name: "doctor" }
  | {
      readonly name: "setup";
      /** Absent, and without `--all`, means the worktree the shell is standing in. */
      readonly target?: string;
      readonly all: boolean;
      readonly trust: boolean;
    }
  | {
      readonly name: "exec";
      /** The command and its arguments, as the shell handed them over. Never empty. */
      readonly argv: readonly string[];
      readonly failFast: boolean;
    }
  | {
      readonly name: "prune";
      /** `--gone`/`--merged`; absent means both. */
      readonly only?: "gone" | "merged";
      readonly dryRun: boolean;
      readonly deleteBranch: boolean;
      readonly fetch: boolean;
    }
  | {
      readonly name: "rename";
      readonly target: string;
      /** The branch's new name. Spelled `to` because `name` is the discriminant. */
      readonly to: string;
      readonly push: boolean;
      readonly force: boolean;
    }
  | { readonly name: "path"; readonly target?: string }
  | {
      readonly name: "open";
      /** Absent means the worktree the shell is standing in. */
      readonly target?: string;
      readonly trust: boolean;
    }
  | {
      readonly name: "reset";
      readonly target: string;
      readonly to?: string;
      readonly clean: boolean;
    }
  | {
      readonly name: "remove";
      readonly target: string;
      readonly force: boolean;
      readonly deleteBranch: boolean;
      /** `--no-teardown`: skip `.grove.toml`'s `[teardown]` commands. */
      readonly teardown: boolean;
    }
  | {
      readonly name: "sync";
      readonly target?: string;
      readonly all: boolean;
      readonly abortOnConflict: boolean;
      readonly push: boolean;
      readonly publish: boolean;
    }
  | {
      readonly name: "rebase";
      readonly target?: string;
      /**
       * Where the branch goes, when a flag said. Absent means nobody said,
       * which `run.ts` turns into a question at a terminal and a usage error
       * everywhere else — the parser cannot tell which of those it is.
       */
      readonly base?: RebaseBase;
      readonly fetch: boolean;
      readonly abortOnConflict: boolean;
      /** `--no-stash` off: carry uncommitted changes through the rebase. */
      readonly carry: boolean;
    };

export type CliCommand =
  | { readonly kind: "run"; readonly command: GroveCommand; readonly global: GlobalOptions }
  /**
   * A bare `grove`: open the interactive screen.
   *
   * `usage` travels with it because the screen needs a terminal — piped, or
   * `--headless`, the entry point prints this instead.
   */
  | { readonly kind: "app"; readonly global: GlobalOptions; readonly usage: string }
  /** Write to stdout and exit 0: any flavour of `--help`, and `--version`. */
  | { readonly kind: "text"; readonly output: string }
  /** Write to stderr and exit 2. `usage` is the relevant help, when there is one. */
  | { readonly kind: "error"; readonly message: string; readonly usage?: string };

type ParsedValues = Record<string, string | boolean | undefined>;

function optionsFor(flags: readonly FlagSpec[]) {
  return Object.fromEntries(
    flags.map((flag) => [
      flag.name,
      { type: flag.type, ...(flag.short === undefined ? {} : { short: flag.short }) },
    ]),
  );
}

function text(output: string): CliCommand {
  return { kind: "text", output };
}

function unknownSubcommand(name: string): CliCommand {
  return {
    kind: "error",
    message: `unknown command ${JSON.stringify(name)}. Expected one of: ${SUBCOMMANDS.map(
      (spec) => spec.name,
    ).join(", ")}`,
    usage: formatGlobalHelp(),
  };
}

function usageError(spec: SubcommandSpec, message: string): CliCommand {
  return { kind: "error", message, usage: formatSubcommandHelp(spec) };
}

function str(values: ParsedValues, key: string): string | undefined {
  const value = values[key];

  return typeof value === "string" ? value : undefined;
}

function bool(values: ParsedValues, key: string): boolean {
  return values[key] === true;
}

/** The four global options, read the same way either side of the subcommand. */
function globalsFrom(values: ParsedValues): GlobalOptions {
  return {
    repo: str(values, "repo"),
    json: bool(values, "json"),
    verbose: bool(values, "verbose"),
    headless: bool(values, "headless"),
  };
}

function buildCommand(
  spec: SubcommandSpec,
  values: ParsedValues,
  positionals: readonly string[],
): CliCommand | GroveCommand {
  // The usage strings in `help.ts` are the contract; these checks enforce the
  // same arity so a typo lands as "wrong number of arguments" rather than as a
  // branch named after a flag the user misspelled.
  const [first, second] = positionals;
  /** Every missing-argument refusal, named for the argument rather than the flag. */
  const needs = (what: string): CliCommand => usageError(spec, `${spec.name} needs ${what}`);

  switch (spec.name) {
    case "clone": {
      if (first === undefined) return needs("a repository URL");
      return { name: "clone", url: first, dir: second, branch: str(values, "branch") };
    }
    case "add": {
      if (first === undefined) return needs("a branch name");

      const from = str(values, "from");
      const on = str(values, "on");
      // Both name a base, and only one of them is also remembered — see
      // `checkedParent` in `core/commands/add.ts`. Refused here rather than
      // ranked, because either ranking silently does something the other flag
      // was typed to ask for.
      if (from !== undefined && on !== undefined) {
        return usageError(spec, "--on and --from both say where the branch starts; pass one");
      }

      return {
        name: "add",
        branch: first,
        from,
        on,
        fetch: !bool(values, "no-fetch"),
        push: bool(values, "push"),
        setup: !bool(values, "no-setup"),
        trust: bool(values, "trust"),
        take: bool(values, "take"),
      };
    }
    case "pr": {
      if (first === undefined) return needs("a pull request");
      return {
        name: "pr",
        pr: first,
        setup: !bool(values, "no-setup"),
        trust: bool(values, "trust"),
      };
    }
    case "list":
      return { name: "list" };
    case "doctor":
      return { name: "doctor" };
    case "setup":
      return {
        name: "setup",
        target: first,
        all: bool(values, "all"),
        trust: bool(values, "trust"),
      };
    case "exec": {
      // Every positional, not just the first: the usage line ends in `...`, so
      // `maxPositionals` let them all through and they are the command.
      if (positionals.length === 0) return needs("a command to run");

      return { name: "exec", argv: positionals, failFast: bool(values, "fail-fast") };
    }
    case "prune": {
      const gone = bool(values, "gone");
      const merged = bool(values, "merged");

      return {
        name: "prune",
        // Both, or neither, is the same request as the default: the two are
        // halves of one question, and asking for both halves is asking the
        // question.
        only: gone === merged ? undefined : gone ? "gone" : "merged",
        dryRun: bool(values, "dry-run"),
        deleteBranch: bool(values, "delete-branch"),
        fetch: !bool(values, "no-fetch"),
      };
    }
    case "rename": {
      if (first === undefined) return needs("a worktree to rename");
      if (second === undefined) return needs("a new branch name");

      return {
        name: "rename",
        target: first,
        to: second,
        push: bool(values, "push"),
        force: bool(values, "force"),
      };
    }
    case "path":
      return { name: "path", target: first };
    case "open":
      return { name: "open", target: first, trust: bool(values, "trust") };
    case "reset": {
      if (first === undefined) return needs("a worktree to reset");
      return {
        name: "reset",
        target: first,
        to: str(values, "to"),
        clean: bool(values, "clean"),
      };
    }
    case "remove": {
      if (first === undefined) return needs("a worktree to remove");
      return {
        name: "remove",
        target: first,
        force: bool(values, "force"),
        deleteBranch: bool(values, "delete-branch"),
        teardown: !bool(values, "no-teardown"),
      };
    }
    case "sync":
      return {
        name: "sync",
        target: first,
        all: bool(values, "all"),
        abortOnConflict: !bool(values, "no-abort"),
        push: !bool(values, "no-push"),
        publish: bool(values, "publish"),
      };
    case "rebase": {
      const onto = str(values, "onto");
      const bases: RebaseBase[] = [
        ...(onto === undefined ? [] : [{ kind: "ref", ref: onto } as const]),
        ...(bool(values, "upstream") ? [{ kind: "upstream" } as const] : []),
        ...(bool(values, "trunk") ? [{ kind: "trunk" } as const] : []),
      ];
      // Refused rather than ranked, the way `add` refuses `--on` beside
      // `--from`: two bases is two answers to the one question the command
      // asks, and picking either would move the branch somewhere the other
      // flag was typed to send it away from.
      if (bases.length > 1) {
        return usageError(spec, "--onto, --upstream and --trunk each name the base; pass one");
      }

      return {
        name: "rebase",
        target: first,
        base: bases[0],
        fetch: !bool(values, "no-fetch"),
        abortOnConflict: !bool(values, "no-abort"),
        carry: !bool(values, "no-stash"),
      };
    }
    default:
      // Unreachable while `SUBCOMMANDS` and this switch agree; a new entry in
      // the table without a case here surfaces as a usage error, not a crash.
      return unknownSubcommand(spec.name);
  }
}

/**
 * How many positionals the usage line promises, read straight off `spec.args`.
 *
 * A line ending in `...` promises no limit. That is `exec` and only `exec`: what
 * follows it is somebody else's command line, and counting its words would be
 * this parser having an opinion about how long `bun run build --watch` is.
 */
function maxPositionals(args: string): number {
  if (args.endsWith("...")) return Number.POSITIVE_INFINITY;

  return args.split(/\s+/).filter((token) => token.length > 0).length;
}

/** Whether `token` expects the following argument to be its value. */
function takesNextValue(token: string): boolean {
  // `--repo=path` and `-Cpath` already carry theirs.
  if (token.startsWith("--")) {
    if (token.includes("=")) return false;

    return GLOBAL_FLAGS.some((flag) => `--${flag.name}` === token && flag.type === "string");
  }

  if (token.length !== 2) return false;

  return GLOBAL_FLAGS.some((flag) => flag.short === token.slice(1) && flag.type === "string");
}

/**
 * Splits global flags written *before* the subcommand from the rest.
 *
 * `-C` is spelled after git's own, and `git -C dir status` puts it first — so
 * that is where people type it. Supporting only `grove list -C dir` would be a
 * wart in exactly the flag most likely to be reached for out of habit.
 *
 * The scan has to know which flags take a value, or `grove -C repo list` would
 * read `repo` as the subcommand.
 */
function splitLeadingGlobals(argv: readonly string[]): {
  leading: readonly string[];
  rest: readonly string[];
} {
  const leading: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];
    // `--` ends option parsing, and a non-flag is the subcommand.
    if (token === undefined || token === "--" || !token.startsWith("-")) break;

    leading.push(token);
    index += 1;

    if (takesNextValue(token) && index < argv.length) {
      const value = argv[index];
      if (value !== undefined) leading.push(value);
      index += 1;
    }
  }

  return { leading, rest: argv.slice(index) };
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const { leading, rest: afterGlobals } = splitLeadingGlobals(argv);

  let leadingValues: ParsedValues = {};
  if (leading.length > 0) {
    try {
      ({ values: leadingValues } = parseArgs({
        args: [...leading],
        options: optionsFor(GLOBAL_FLAGS),
        allowPositionals: false,
        strict: true,
      }));
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        usage: formatGlobalHelp(),
      };
    }
  }

  // Answered before a subcommand is required, so `grove --help` and `grove -v` work.
  if (bool(leadingValues, "help")) return text(formatGlobalHelp());
  if (bool(leadingValues, "version")) return text(version);

  const [head, ...rest] = afterGlobals;

  // A bare invocation opens the screen rather than erroring: someone typing the
  // binary's name is asking what is here, and that is a question the list
  // answers better than a menu of commands does.
  if (head === undefined) {
    return {
      kind: "app",
      global: globalsFrom(leadingValues),
      usage: formatGlobalHelp(),
    };
  }

  if (head === "help") {
    const target = rest[0];
    if (target === undefined) return text(formatGlobalHelp());

    const spec = findSubcommand(target);
    return spec ? text(formatSubcommandHelp(spec)) : unknownSubcommand(target);
  }

  if (head.startsWith("-")) {
    return {
      kind: "error",
      message: `expected a command before ${JSON.stringify(head)}`,
      usage: formatGlobalHelp(),
    };
  }

  const spec = findSubcommand(head);
  if (!spec) return unknownSubcommand(head);

  let values: ParsedValues;
  let positionals: string[];

  try {
    // Positionals are allowed now — a subcommand's arguments are positionals —
    // so `strict` is what stops a misspelled flag from being silently accepted
    // as a branch name. `--` still works, which is how a branch called `-x`
    // stays reachable.
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: optionsFor([...spec.flags, ...GLOBAL_FLAGS]),
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return usageError(spec, error instanceof Error ? error.message : String(error));
  }

  // Checked before arity so `grove add --help` explains itself instead of
  // complaining about the branch name it is missing.
  if (bool(values, "help")) return text(formatSubcommandHelp(spec));
  if (bool(values, "version")) return text(version);

  const max = maxPositionals(spec.args);
  if (positionals.length > max) {
    const extra = positionals.slice(max).map((value) => JSON.stringify(value));
    return usageError(
      spec,
      `${spec.name} takes ${max} argument(s); unexpected ${extra.join(", ")}`,
    );
  }

  const built = buildCommand(spec, values, positionals);
  if ("kind" in built) return built;

  // Written either side of the subcommand; the later spelling wins, which is
  // what `grove -C a list -C b` reads as.
  const global = { ...leadingValues, ...values };

  return { kind: "run", command: built, global: globalsFrom(global) };
}
