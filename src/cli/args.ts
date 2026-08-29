import { parseArgs } from "node:util";
import { version } from "../../package.json";
import type { FlagSpec, SubcommandSpec } from "./help.ts";
import {
  BIN_NAME,
  findSubcommand,
  formatGlobalHelp,
  formatSubcommandHelp,
  GLOBAL_FLAGS,
  SUBCOMMANDS,
} from "./help.ts";
import { isShell, SHELLS, type Shell } from "./shell-init.ts";

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
      readonly fetch: boolean;
      readonly push: boolean;
      readonly setup: boolean;
      /** `--trust`: run `.grove.toml`'s commands, having read them. */
      readonly trust: boolean;
      /** `--take`: move the current worktree's uncommitted changes into the new one. */
      readonly take: boolean;
    }
  | { readonly name: "list" }
  | { readonly name: "doctor" }
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
  | { readonly name: "shell-init"; readonly shell: string }
  | { readonly name: "install"; readonly shell?: Shell }
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

export { BIN_NAME };

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

function optionsFor(flags: readonly FlagSpec[]) {
  const config: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> =
    {};

  for (const flag of flags) {
    config[flag.name] = {
      type: flag.type,
      ...(flag.short === undefined ? {} : { short: flag.short }),
      ...(flag.multiple === true ? { multiple: true } : {}),
    };
  }

  return config;
}

function text(output: string): CliCommand {
  return { kind: "text", output };
}

function unknownSubcommand(name: string): CliCommand {
  // `grove cd` reaching the binary means the shell function is not installed —
  // a child process cannot move its parent shell, so the answer is the one
  // line that installs the function, not a list of commands that are not it.
  if (name === "cd") {
    return {
      kind: "error",
      message:
        "`grove cd` is a shell function, and it is not installed in this shell.\n" +
        "Run `grove install`, or add to your shell's rc file yourself:\n" +
        '  eval "$(grove shell-init zsh)"   # or bash, fish',
    };
  }

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

function buildCommand(
  spec: SubcommandSpec,
  values: ParsedValues,
  positionals: readonly string[],
): CliCommand | GroveCommand {
  // The usage strings in `help.ts` are the contract; these checks enforce the
  // same arity so a typo lands as "wrong number of arguments" rather than as a
  // branch named after a flag the user misspelled.
  const [first, second] = positionals;

  switch (spec.name) {
    case "clone": {
      if (first === undefined) return usageError(spec, `${spec.name} needs a repository URL`);
      return { name: "clone", url: first, dir: second, branch: str(values, "branch") };
    }
    case "add": {
      if (first === undefined) return usageError(spec, `${spec.name} needs a branch name`);
      return {
        name: "add",
        branch: first,
        from: str(values, "from"),
        fetch: !bool(values, "no-fetch"),
        push: bool(values, "push"),
        setup: !bool(values, "no-setup"),
        trust: bool(values, "trust"),
        take: bool(values, "take"),
      };
    }
    case "list":
      return { name: "list" };
    case "doctor":
      return { name: "doctor" };
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
      if (first === undefined) return usageError(spec, `${spec.name} needs a worktree to rename`);
      if (second === undefined) return usageError(spec, `${spec.name} needs a new branch name`);

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
    case "shell-init": {
      if (first === undefined) {
        return usageError(spec, `${spec.name} needs a shell: ${SHELLS.join(", ")}`);
      }
      if (!isShell(first)) {
        return usageError(
          spec,
          `${JSON.stringify(first)} is not a shell this knows; expected ${SHELLS.join(", ")}`,
        );
      }
      return { name: "shell-init", shell: first };
    }
    case "install": {
      if (first !== undefined && !isShell(first)) {
        return usageError(
          spec,
          `${JSON.stringify(first)} is not a shell this knows; expected ${SHELLS.join(", ")}`,
        );
      }
      return { name: "install", shell: first };
    }
    case "reset": {
      if (first === undefined) return usageError(spec, `${spec.name} needs a worktree to reset`);
      return {
        name: "reset",
        target: first,
        to: str(values, "to"),
        clean: bool(values, "clean"),
      };
    }
    case "remove": {
      if (first === undefined) return usageError(spec, `${spec.name} needs a worktree to remove`);
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
      };
    default:
      // Unreachable while `SUBCOMMANDS` and this switch agree; a new entry in
      // the table without a case here surfaces as a usage error, not a crash.
      return unknownSubcommand(spec.name);
  }
}

/** How many positionals the usage line promises, read straight off `spec.args`. */
function maxPositionals(args: string): number {
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
      global: {
        repo: str(leadingValues, "repo"),
        json: bool(leadingValues, "json"),
        verbose: bool(leadingValues, "verbose"),
        headless: bool(leadingValues, "headless"),
      },
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

  return {
    kind: "run",
    command: built,
    global: {
      repo: str(global, "repo"),
      json: bool(global, "json"),
      verbose: bool(global, "verbose"),
      headless: bool(global, "headless"),
    },
  };
}
