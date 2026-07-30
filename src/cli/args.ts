import { parseArgs } from "node:util";
import { version } from "../../package.json";

/**
 * Argument parsing, kept apart from the process it drives.
 *
 * Returning a description of what to do — rather than printing and exiting in
 * place — is what makes every branch testable without spawning anything.
 *
 * Interim shape: the tabbed demo this used to drive is gone and the worktree
 * subcommands have not landed yet, so `--help` and `--version` are the whole
 * surface. The `kind: "run"` variant returns when there is a command to run.
 */
export type CliCommand =
  /** Write to stdout and exit 0: `--help`, `--version`, and a bare invocation. */
  | { readonly kind: "text"; readonly output: string }
  /** Write to stderr and exit 2. */
  | { readonly kind: "error"; readonly message: string };

const OPTIONS = {
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
} as const;

export const BIN_NAME = "typescript-test";

export function formatHelp(): string {
  return [
    `Usage: ${BIN_NAME} [options]`,
    "",
    "A git worktree manager. Subcommands are still being built.",
    "",
    "Options:",
    "  -v, --version    print the version and exit",
    "  -h, --help       show this help and exit",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  let values: { version?: boolean; help?: boolean };

  try {
    // `strict` rejects unknown flags; refusing positionals keeps a typo from
    // being read as an argument. Both loosen in the subcommand rewrite.
    ({ values } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  // Checked first so `--help --version` still explains itself.
  if (values.help) return { kind: "text", output: formatHelp() };
  if (values.version) return { kind: "text", output: version };

  // No subcommands to dispatch to yet, so a bare run shows the help rather than
  // erroring — which is what it will keep doing once they exist.
  return { kind: "text", output: formatHelp() };
}
