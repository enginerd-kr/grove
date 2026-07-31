/**
 * The failure vocabulary the whole tool speaks.
 *
 * Every code here maps to exactly one exit code, and the mapping lives in
 * `cli/exit-codes.ts` as a total switch — so adding a code without deciding how
 * a script should react to it is a type error rather than a silent `1`.
 */
export type GardenErrorCode =
  /** Bad flags, wrong argument count, a branch name that cannot be a directory. */
  | "usage"
  /** Nothing managed by this tool was found from the invocation directory. */
  | "not-a-repo"
  /** The request was understood and declined: dirty tree, unsafe removal. */
  | "refused"
  /** A rebase or merge stopped on conflicting content. */
  | "rebase-conflict"
  /** The repository is not in a state that allows this: dir exists, branch busy. */
  | "state-conflict"
  /** A configured `garden.setup` command exited non-zero. The worktree is there. */
  | "setup-failed"
  /** git failed and the reason did not match anything more specific. */
  | "git-failed"
  /** The remote was unreachable, refused us, or does not exist. */
  | "remote";

type GardenErrorOptions = {
  /** One line telling the user what to do next. Worth writing for every error. */
  readonly hint?: string;
  /** Supporting lines — conflicting paths, git's own stderr — printed under the message. */
  readonly details?: readonly string[];
  readonly cause?: unknown;
};

/**
 * An error we meant to produce.
 *
 * Anything else reaching the top level is a bug in this tool and exits 1, so
 * throwing a bare `Error` for a condition the user can fix is always wrong.
 */
export class GardenError extends Error {
  readonly code: GardenErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: GardenErrorCode, message: string, options: GardenErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "GardenError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }
}

export function isGardenError(error: unknown): error is GardenError {
  return error instanceof GardenError;
}

/**
 * Patterns matched against git's stderr, most specific first.
 *
 * Order matters where two patterns overlap: "does not appear to be a git
 * repository" is the remote rejecting us, while "not a git repository" is the
 * local path being wrong. Matching the general one first would report a network
 * problem as a local one.
 *
 * These are English strings, which is why `runGit` pins `LC_ALL=C`.
 */
const PATTERNS: readonly (readonly [RegExp, GardenErrorCode])[] = [
  [/could not resolve host(?:name)?/i, "remote"],
  [/connection (?:timed out|refused|reset)/i, "remote"],
  [/authentication failed/i, "remote"],
  [/permission denied \(publickey/i, "remote"],
  [/repository not found/i, "remote"],
  [/does not appear to be a git repository/i, "remote"],
  [/terminal prompts disabled/i, "remote"],
  [/unable to access/i, "remote"],
  [/remote end hung up/i, "remote"],
  [/is already checked out at/i, "state-conflict"],
  [/already used by worktree/i, "state-conflict"],
  [/already exists/i, "state-conflict"],
  [/^conflict/im, "rebase-conflict"],
  [/could not apply/i, "rebase-conflict"],
  [/needs merge/i, "rebase-conflict"],
  [/local changes.*would be overwritten/i, "refused"],
  [/please commit your changes or stash them/i, "refused"],
  [/contains modified or untracked files/i, "refused"],
  [/not a git repository/i, "not-a-repo"],
];

/** Best guess at why git failed, defaulting to the honest "we don't know". */
export function classifyGitError(stderr: string): GardenErrorCode {
  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(stderr)) return code;
  }

  return "git-failed";
}

/**
 * The tail of git's stderr, for printing under our own message.
 *
 * Trimmed to a handful of lines because git narrates at length and the useful
 * sentence is almost always the last one; progress lines are dropped since they
 * are noise once the command has already failed.
 */
export function stderrDetails(stderr: string, max = 5): readonly string[] {
  return stderr
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(?:remote: )?\w+ objects:\s+\d+%/.test(line))
    .slice(-max);
}
