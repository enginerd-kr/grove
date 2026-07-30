import { parseArgs } from "node:util";
import { version } from "../../package.json";
import { TAB_LABELS } from "../ui/index.ts";

/**
 * Argument parsing, kept apart from the process it drives.
 *
 * Returning a description of what to do — rather than printing and exiting in
 * place — is what makes every branch testable without spawning anything.
 */
export type CliCommand =
  /** Render the app, with `initialTab` already 0-based for `App`. */
  | { readonly kind: "run"; readonly initialTab: number }
  /** Write to stdout and exit 0: `--help`, `--version`. */
  | { readonly kind: "text"; readonly output: string }
  /** Write to stderr and exit 2. */
  | { readonly kind: "error"; readonly message: string };

const OPTIONS = {
  tab: { type: "string", short: "t" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
} as const;

export const BIN_NAME = "typescript-test";

export function formatHelp(): string {
  const tabs = TAB_LABELS.map((label, index) => `${index + 1} ${label.toLowerCase()}`).join(", ");

  return [
    `Usage: ${BIN_NAME} [options]`,
    "",
    "A small Ink playground: tabs, keyboard input, and a fake log stream.",
    "",
    "Options:",
    `  -t, --tab <n>    open on a tab (${tabs}); default 1`,
    "  -v, --version    print the version and exit",
    "  -h, --help       show this help and exit",
    "",
    "Needs an interactive terminal unless --help or --version is given.",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  let values: { tab?: string; version?: boolean; help?: boolean };

  try {
    // `strict` rejects unknown flags and a `--tab` with no value; refusing
    // positionals keeps a typo like `--tba 2` from being read as an argument.
    ({ values } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  // Checked before --tab so `--help --tab bogus` still explains itself.
  if (values.help) return { kind: "text", output: formatHelp() };
  if (values.version) return { kind: "text", output: version };

  if (values.tab === undefined) return { kind: "run", initialTab: 0 };

  const tab = Number(values.tab);
  if (!Number.isInteger(tab) || tab < 1 || tab > TAB_LABELS.length) {
    return {
      kind: "error",
      message: `--tab expects a whole number from 1 to ${TAB_LABELS.length}, got ${JSON.stringify(values.tab)}`,
    };
  }

  return { kind: "run", initialTab: tab - 1 };
}
