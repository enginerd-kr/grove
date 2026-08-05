/**
 * The command surface, described once.
 *
 * `args.ts` builds its `parseArgs` option tables from this and `--help` renders
 * from it, so usage text cannot drift from what the parser accepts — the same
 * trick the old entry point played with its tab list, applied to a bigger
 * surface where the drift would actually cost something.
 */

export const BIN_NAME = "garden";

export type FlagSpec = {
  readonly name: string;
  readonly short?: string;
  readonly type: "string" | "boolean";
  /** Shown after the flag in help, e.g. `--from <base>`. String flags only. */
  readonly placeholder?: string;
  /** Repeatable: every occurrence is kept, rather than the last one winning. */
  readonly multiple?: boolean;
  readonly summary: string;
};

export type SubcommandSpec = {
  readonly name: string;
  readonly aliases: readonly string[];
  /** The positional part, for the usage line: `clone <url> [dir]`. */
  readonly args: string;
  readonly summary: string;
  readonly description: readonly string[];
  readonly flags: readonly FlagSpec[];
};

/**
 * Flags accepted before or after any subcommand.
 *
 * `--repo` is spelled `-C` as well because that is what git calls it, and
 * anyone reaching for it is already thinking in git.
 */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "repo",
    short: "C",
    type: "string",
    placeholder: "<path>",
    summary: "operate on the repo at <path> instead of discovering one",
  },
  { name: "json", type: "boolean", summary: "print results as JSON on stdout" },
  { name: "verbose", type: "boolean", summary: "log every git command, its exit code, and timing" },
  { name: "headless", type: "boolean", summary: "log progress as plain lines instead of drawing" },
  { name: "version", short: "v", type: "boolean", summary: "print the version and exit" },
  { name: "help", short: "h", type: "boolean", summary: "show this help and exit" },
];

export const SUBCOMMANDS: readonly SubcommandSpec[] = [
  {
    name: "clone",
    aliases: ["init"],
    args: "<url> [dir]",
    summary: "create a managed repo from a remote URL",
    description: [
      "Clones <url> as a bare repository and checks out its default branch as",
      "the first worktree. The result is one directory holding .bare and a",
      "sibling worktree per branch, created under the current directory.",
    ],
    flags: [
      {
        name: "branch",
        short: "b",
        type: "string",
        placeholder: "<name>",
        summary: "check out <name> first instead of the remote's default branch",
      },
    ],
  },
  {
    name: "add",
    aliases: [],
    args: "<branch>",
    summary: "create a worktree for a branch",
    description: [
      "Uses the branch if it exists locally, tracks it if it exists on the",
      "remote, and otherwise creates it from the default branch.",
      "",
      "The new worktree is then filled in from .garden.toml, if the default",
      "branch's worktree has one: `copy` and `link` apply on sight, and `run`",
      "commands are printed and skipped until --trust says you have read them.",
    ],
    flags: [
      {
        name: "from",
        type: "string",
        placeholder: "<base>",
        summary: "base a new branch on <base> instead of the default branch",
      },
      {
        name: "dir",
        type: "string",
        placeholder: "<name>",
        summary: "name the directory <name> instead of deriving it from the branch",
      },
      {
        name: "no-fetch",
        type: "boolean",
        summary: "skip the fetch that looks for a remote branch",
      },
      { name: "push", type: "boolean", summary: "push the branch and set its upstream" },
      {
        name: "no-setup",
        type: "boolean",
        summary: "skip the copies, links, and commands .garden.toml asks for",
      },
      {
        name: "trust",
        type: "boolean",
        summary: "run .garden.toml's commands, recording that you have read them",
      },
    ],
  },
  {
    name: "path",
    aliases: [],
    args: "[target]",
    summary: "print a worktree's directory — or the repo root, given nothing",
    description: [
      'For scripts, and for shells: `cd "$(garden path feat/login)"` works',
      "anywhere, and the function `shell-init` installs spells it `garden cd",
      "feat/login`. The root is the one directory that is never a worktree,",
      "which makes it the place to stand while removing anything.",
    ],
    flags: [],
  },
  {
    name: "shell-init",
    aliases: [],
    args: "<shell>",
    summary: "print the shell function behind `garden cd` and enter-to-cd",
    description: [
      "A child process cannot move the shell that started it, so `cd` has to",
      "be a shell function wearing garden's name. One line installs it:",
      "",
      '  eval "$(garden shell-init zsh)"      # zsh, bash, or fish',
      "",
      "It adds `garden cd [target]`, and makes enter in the app quit into the",
      "selected worktree. Everything else passes through untouched. The",
      "function calls back by the spelling that printed it, so running from a",
      "bare checkout (`bun …/src/cli.tsx`) needs nothing on PATH.",
    ],
    flags: [],
  },
  {
    name: "list",
    aliases: ["ls"],
    args: "",
    summary: "show every worktree, its branch, and whether it is clean",
    description: [],
    flags: [],
  },
  {
    name: "remove",
    aliases: ["rm"],
    args: "<target>",
    summary: "delete a worktree",
    description: [
      "<target> may be a branch name, a directory name, or a path — whichever",
      "you have in mind. Refuses anything unsafe unless --force.",
    ],
    flags: [
      { name: "force", type: "boolean", summary: "remove even with uncommitted changes" },
      { name: "delete-branch", type: "boolean", summary: "also delete the branch it held" },
    ],
  },
  {
    name: "reset",
    aliases: [],
    args: "<target>",
    summary: "throw away a worktree's uncommitted changes",
    description: [
      "Runs `git reset --hard` inside the worktree. Every change to a tracked",
      "file goes, and there is no undo. Untracked files are left where they are",
      "unless --clean says otherwise.",
    ],
    flags: [
      {
        name: "to",
        type: "string",
        placeholder: "<ref>",
        summary: "reset to <ref> rather than the worktree's own HEAD, dropping commits too",
      },
      { name: "clean", type: "boolean", summary: "also delete untracked files and directories" },
    ],
  },
  {
    name: "sync",
    aliases: [],
    args: "[target]",
    summary: "fetch, then bring a worktree up to date with the default branch",
    description: [
      "Fast-forwards the default branch's own worktree. Every other one is",
      "rebased onto its own remote first and then onto the default branch, and",
      "the result is force-pushed back with --force-with-lease. Stops without",
      "changing anything if the worktree is dirty.",
    ],
    flags: [
      { name: "all", type: "boolean", summary: "sync every worktree instead of one" },
      {
        name: "no-push",
        type: "boolean",
        summary: "leave the rebased commits local, diverged from the branch's remote",
      },
      {
        name: "no-abort",
        type: "boolean",
        summary: "leave a conflicted rebase in place to resolve",
      },
    ],
  },
];

export function findSubcommand(name: string): SubcommandSpec | undefined {
  return SUBCOMMANDS.find((spec) => spec.name === name || spec.aliases.includes(name));
}

function flagLabel(flag: FlagSpec): string {
  const short = flag.short ? `-${flag.short}, ` : "    ";
  const placeholder = flag.placeholder ? ` ${flag.placeholder}` : "";

  return `${short}--${flag.name}${placeholder}`;
}

/** Pads labels to a shared column so the summaries line up in a column of their own. */
function describeFlags(flags: readonly FlagSpec[]): readonly string[] {
  const labels = flags.map(flagLabel);
  const width = Math.max(0, ...labels.map((label) => label.length));

  return flags.map((flag, index) => `  ${(labels[index] ?? "").padEnd(width)}  ${flag.summary}`);
}

export function formatGlobalHelp(): string {
  const width = Math.max(...SUBCOMMANDS.map((spec) => spec.name.length));
  const commands = SUBCOMMANDS.map((spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`);

  return [
    `Usage: ${BIN_NAME} <command> [options]`,
    "",
    "Manage git worktrees backed by a single bare clone.",
    "",
    "Commands:",
    ...commands,
    "",
    "Options:",
    ...describeFlags(GLOBAL_FLAGS),
    "",
    `Run \`${BIN_NAME} <command> --help\` for a command's own options.`,
  ].join("\n");
}

export function formatSubcommandHelp(spec: SubcommandSpec): string {
  const alias = spec.aliases.length > 0 ? [`Alias: ${spec.aliases.join(", ")}`, ""] : [];
  const flags = spec.flags.length > 0 ? ["Options:", ...describeFlags(spec.flags), ""] : [];
  const description = spec.description.length > 0 ? [...spec.description, ""] : [];

  return [
    `Usage: ${BIN_NAME} ${spec.name}${spec.args ? ` ${spec.args}` : ""} [options]`,
    "",
    ...alias,
    ...description,
    ...flags,
    "Global options:",
    ...describeFlags(GLOBAL_FLAGS),
  ]
    .join("\n")
    .trimEnd();
}
