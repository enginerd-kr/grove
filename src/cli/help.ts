/**
 * The command surface, described once.
 *
 * `args.ts` builds its `parseArgs` option tables from this and `--help` renders
 * from it, so usage text cannot drift from what the parser accepts — the same
 * trick the old entry point played with its tab list, applied to a bigger
 * surface where the drift would actually cost something.
 */

export const BIN_NAME = "grove";

export type FlagSpec = {
  readonly name: string;
  readonly short?: string;
  readonly type: "string" | "boolean";
  /** Shown after the flag in help, e.g. `--from <base>`. String flags only. */
  readonly placeholder?: string;
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
      "Setup runs after checkout; unapproved commands wait for confirmation.",
    ],
    flags: [
      { name: "no-setup", type: "boolean", summary: "create the worktrees without project setup" },
      {
        name: "trust",
        type: "boolean",
        summary: "approve the project setup commands and run them",
      },
      {
        name: "branch",
        short: "b",
        type: "string",
        placeholder: "<name>",
        summary: "also check out <name> beside the default branch",
      },
      {
        name: "upstream",
        type: "string",
        placeholder: "<url>",
        summary: "this is a fork of <url>: follow its trunk, push to origin (see `upstream`)",
      },
    ],
  },
  {
    name: "upstream",
    aliases: [],
    args: "<url>",
    summary: "follow another repository's trunk — this is a fork of it",
    description: [
      "Adds <url> as a remote called upstream, fetches it, tells the trunk to",
      "follow upstream's copy, and sets remote.pushDefault to origin. From then",
      "on the trunk column, the merged badge, the base a new branch is cut from",
      "and what sync rebases onto are all measured against upstream, and your",
      "branches are still pushed to origin.",
      "",
      "Three git settings, nothing of grove's: `git remote add`, `git branch",
      "-u`, and `remote.pushDefault`. git push and git pull read the same",
      "three. Run it again with the same URL and nothing changes; a different",
      "URL is refused unless --force says to replace it.",
      "",
      "Nothing is detected. Which repository a fork came from is a fact only",
      "the forge holds, so the URL is typed once by somebody who knows it.",
    ],
    flags: [
      {
        name: "force",
        type: "boolean",
        summary: "replace an upstream remote that already points somewhere else",
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
      "The new worktree is then filled in from .grove.toml, if the default",
      "branch's worktree has one: `copy` and `link` apply on sight, and `run`",
      "commands are printed and skipped until --trust says you have read them.",
      "`open` then starts what the file says to open it with — written per",
      "platform — and is skipped when there is no terminal to open into.",
      "",
      "--take carries the uncommitted changes of the worktree you are standing",
      "in over to the new one, and leaves that one clean — the stash-and-pop",
      "that follows every `I should have branched first`, without a stash stack",
      "shared between every worktree in the repository to get it wrong.",
      "",
      "--on <branch> cuts the branch from another branch of yours rather than",
      "from the trunk, and writes down that it sits there. From then on `sync`",
      "rebases it onto that branch, and onto the trunk only through it — which",
      "is what keeps a second pull request written on top of a first one from",
      "being replayed over the absence of it.",
    ],
    flags: [
      {
        name: "config-source",
        type: "string",
        placeholder: "<trunk|worktree>",
        summary: "setup recipe source; files still come from trunk",
      },
      {
        name: "from",
        type: "string",
        placeholder: "<base>",
        summary: "base a new branch on <base> instead of the default branch",
      },
      {
        name: "on",
        type: "string",
        placeholder: "<branch>",
        summary: "stack on <branch> and remember the parent",
      },
      {
        name: "no-fetch",
        type: "boolean",
        summary: "skip the fetch that looks for a remote branch",
      },
      { name: "push", type: "boolean", summary: "push the branch and set its upstream" },
      {
        name: "take",
        type: "boolean",
        summary: "move this worktree's uncommitted changes into the new one",
      },
      {
        name: "no-setup",
        type: "boolean",
        summary: "skip the copies, links, and commands .grove.toml asks for",
      },
      {
        name: "trust",
        type: "boolean",
        summary: "approve and run .grove.toml's commands",
      },
    ],
  },
  {
    name: "pr",
    aliases: [],
    args: "<pr>",
    summary: "create a worktree for reviewing a pull request",
    description: [
      "Fetches pull request <pr> from wherever it was proposed — a branch on",
      "the remote, or somebody's fork — and gives it a worktree at pr/<number>,",
      "on a real branch of that name. Committing there and pushing sends the",
      "change back to the pull request rather than to a branch of your own.",
      "",
      "<pr> is a number, the URL you copied out of the browser, or the branch it",
      "was proposed from; `gh` is what resolves it, and `gh` is the only tool",
      "beyond git that grove runs. `propose` is the other direction: a pull",
      "request for a branch of your own.",
      "",
      "The worktree is filled in from .grove.toml the same way `add` fills one",
      "in. Run it again to catch the worktree up when the pull request moves; it",
      "refuses rather than dropping commits you added to it.",
    ],
    flags: [
      {
        name: "config-source",
        type: "string",
        placeholder: "<trunk|worktree>",
        summary: "setup recipe source; files still come from trunk",
      },
      {
        name: "replace",
        type: "boolean",
        summary: "save local work and replace a rewritten PR",
      },
      {
        name: "no-setup",
        type: "boolean",
        summary: "skip the copies, links, and commands .grove.toml asks for",
      },
      {
        name: "trust",
        type: "boolean",
        summary: "approve and run .grove.toml's commands",
      },
    ],
  },
  {
    name: "propose",
    aliases: [],
    args: "[target]",
    summary: "open a pull request for a worktree, onto the branch it is stacked on",
    description: [
      "Pushes the worktree's branch where `git push` would send it — a first",
      "push sets the upstream, the way `sync --publish` does — and asks gh to",
      "open a pull request for it. The base is the branch `add --on` recorded",
      "it as sitting on, so the second pull request of a stack does not show",
      "the first one's diff over again; an unstacked branch goes onto the",
      "trunk, and --base <branch> says otherwise.",
      "",
      "The title and body are filled in from the commits unless --title says",
      "what they are, or --web opens the browser to write them there. A branch",
      "that already has an open pull request is reported rather than proposed",
      "twice — and if that pull request goes onto a different base than the",
      "stack says, the `gh pr edit` that moves it is printed.",
      "",
      "--stack opens the pull requests the stack under the branch needs first,",
      "bottom-up, and then the branch's own — each onto the branch below it.",
      "One that already exists is reported and left alone, so a stack proposed",
      "half-way last week is finished rather than refused.",
      "",
      "No [target] is the worktree you are standing in. Needs gh.",
    ],
    flags: [
      {
        name: "base",
        type: "string",
        placeholder: "<branch>",
        summary: "open it onto <branch> instead of the recorded parent or the trunk",
      },
      {
        name: "stack",
        type: "boolean",
        summary: "propose the branches it sits on first, bottom-up, then it",
      },
      { name: "draft", type: "boolean", summary: "open it as a draft" },
      {
        name: "title",
        type: "string",
        placeholder: "<text>",
        summary: "the title, instead of the first commit's",
      },
      {
        name: "body",
        type: "string",
        placeholder: "<text>",
        summary: "the body, beside --title; empty when only --title is given",
      },
      { name: "web", type: "boolean", summary: "push, then write the pull request in the browser" },
    ],
  },
  {
    name: "stack",
    aliases: [],
    args: "[target]",
    summary: "draw the stack a worktree's branch is in, and how far each is from its base",
    description: [
      "The branches `add --on` stacked on one another, as the tree they are:",
      "the trunk at the top, each branch under the one it sits on, and beside",
      "each how many commits it adds to its base and how many it has fallen",
      "behind by — the number `sync` would close. `*` marks where you are.",
      "",
      "  main",
      "  ├─ feat/login *       feat/login      ↑2 ↓0",
      "  │  └─ feat/login-api  feat/login-api  ↑1 ↓1",
      "  └─ fix/crash          no worktree     ↑1 ↓0",
      "",
      "A branch in the stack with no worktree says so; `grove add <branch>`",
      "gives it one. A branch the records name that the repository has lost",
      "reads `gone`.",
      "",
      "No [target] is the stack of the worktree you are standing in; --all",
      "draws every stack in the repository. Reads git only — whether a branch",
      "has a pull request is the forge's word, and the screen's pr column is",
      "where that is drawn.",
    ],
    flags: [{ name: "all", type: "boolean", summary: "every stack in the repository" }],
  },
  {
    name: "path",
    aliases: [],
    args: "[target]",
    summary: "print a worktree's directory — or the repo root, given nothing",
    description: [
      'For scripts, and for shells: `cd "$(grove path feat/login)"` moves you',
      "there, and the interactive screen's enter puts the same line on the",
      "clipboard. The root is the one directory that is never a worktree,",
      "which makes it the place to stand while removing anything.",
    ],
    flags: [],
  },
  {
    name: "open",
    aliases: [],
    args: "[target]",
    summary: "open a worktree with what .grove.toml says to open it with",
    description: [
      "Runs the `open` line from [setup] in an existing worktree. `add` runs it",
      "once, when the worktree is made; this is the same line on any day after",
      "— the worktree is still there next week and the editor window is not.",
      "",
      "No [target] is the worktree you are standing in, which is where this is",
      "usually reached for. It waits for the same --trust the commands do, and",
      "a platform the file wrote no line for opens nothing.",
    ],
    flags: [
      {
        name: "trust",
        type: "boolean",
        summary: "run .grove.toml's open line, recording that you have read it",
      },
    ],
  },
  {
    name: "setup",
    aliases: [],
    args: "[target]",
    summary: "run .grove.toml's [setup] again in a worktree that already exists",
    description: [
      "`add` fills a worktree in on the day it makes one, which covers the file",
      "as it was that day and no day after. Then a pull request adds a line to",
      "[setup], and every worktree made before it is missing something the",
      "project now says every worktree has. This is the command that catches",
      "them up — one, or --all of them.",
      "",
      "Safe to run again: `copy` takes the trunk's version over what is there,",
      "`link` leaves what the worktree already has, and the `run` commands are",
      "the project's own, written for a checkout that may already be installed.",
      "",
      "It opens nothing. `open` is the one key in the file whose subject is a",
      "person, and --all over eleven worktrees would be eleven editor windows;",
      "`grove open` is that half, aimed at one worktree at a time.",
      "",
      "No [target] is the worktree you are standing in, which is where this is",
      "usually reached for — you pulled, the file changed, and this is the",
      "checkout that needs it.",
    ],
    flags: [
      {
        name: "config-source",
        type: "string",
        placeholder: "<trunk|worktree>",
        summary: "setup recipe source; files still come from trunk",
      },
      { name: "all", type: "boolean", summary: "fill in every worktree instead of one" },
      {
        name: "trust",
        type: "boolean",
        summary: "approve and run .grove.toml's commands",
      },
    ],
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
      "",
      "Runs .grove.toml's [teardown] commands inside the worktree first, so",
      "whatever the setup started — a container, a database, a tunnel — is given",
      "the chance to stop before the directory it was started in goes away.",
    ],
    flags: [
      { name: "force", type: "boolean", summary: "remove even with uncommitted changes" },
      { name: "delete-branch", type: "boolean", summary: "also delete the branch it held" },
      {
        name: "no-teardown",
        type: "boolean",
        summary: "skip the commands .grove.toml's [teardown] asks for",
      },
    ],
  },
  {
    name: "prune",
    aliases: [],
    args: "",
    summary: "remove every worktree that is finished with",
    description: [
      "Finished means one of two things, and both are looked for: the remote no",
      "longer has the branch — what a merged pull request leaves behind — or the",
      "trunk already has every commit on it, which is what a squash or a rebase",
      "leaves instead.",
      "",
      "Fetches first, because a branch deleted on the forge only reads as gone",
      "once a fetch has pruned the ref that tracked it.",
      "",
      "--closed adds a third that only the forge can answer: a pull request",
      "closed without being merged, its branch still on the remote and nothing",
      "of it on the trunk. It asks gh, one question per worktree, and only",
      "counts a pull request whose head is the commit the worktree is at.",
      "",
      "Removes the directories and keeps the branches. Anything holding",
      "uncommitted work, stopped mid-rebase, locked, or containing the directory",
      "you are standing in is reported and left exactly where it is.",
    ],
    flags: [
      {
        name: "forge-merged",
        type: "boolean",
        summary: "include forge-confirmed merges at this head; needs gh",
      },
      { name: "gone", type: "boolean", summary: "only the ones the remote no longer has" },
      { name: "merged", type: "boolean", summary: "only the ones the trunk already has" },
      {
        name: "closed",
        type: "boolean",
        summary: "also the ones whose pull request was closed without merging; needs gh",
      },
      {
        name: "dry-run",
        short: "n",
        type: "boolean",
        summary: "say what would go, remove nothing",
      },
      {
        name: "delete-branch",
        type: "boolean",
        summary: "delete the branch too, where git will part with it",
      },
      { name: "no-fetch", type: "boolean", summary: "work from the refs as they were last seen" },
    ],
  },
  {
    name: "rename",
    aliases: ["mv"],
    args: "<target> <name>",
    summary: "rename a branch, and move its worktree to match",
    description: [
      "The directory is the branch's name here, so renaming one without the",
      "other would leave a `feat/logn` directory holding `feat/login` — which is",
      "the bookkeeping this tool exists to remove. Both move together, and the",
      "directories the old name left empty are cleared up behind it.",
      "",
      "The branch keeps tracking whatever it tracked. Renaming here says nothing",
      "about the remote, which still has the old name until something pushes the",
      "new one — `--push` is that something.",
    ],
    flags: [
      { name: "push", type: "boolean", summary: "push the new name and set it as the upstream" },
      { name: "force", type: "boolean", summary: "rename the branch everything else syncs onto" },
    ],
  },
  {
    name: "reset",
    aliases: [],
    args: "<target>",
    summary: "throw away a worktree's uncommitted changes",
    description: [
      "Runs `git reset --hard` inside the worktree. Every change to a tracked",
      "file goes, and untracked files are left where they are unless --clean",
      "says otherwise.",
      "",
      "What goes is saved first, as a commit that touches no ref — the same",
      "shape `git stash push -u` stores — and its sha is printed on the way",
      "out: `git stash apply <sha>` is the undo. The latest one for a branch",
      "is also held under refs/grove/discarded/<branch>, so it outlives git's",
      "own housekeeping.",
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
      "Fast-forwards the default branch, refusing divergence. Review worktrees",
      "receive the PR head without rebase or push; --contribute explicitly",
      "rebases and pushes them onto their PR base. Development branches are",
      "rebased onto its own remote first and then onto the default branch, and",
      "the result is force-pushed back with --force-with-lease. Stops without",
      "changing anything if the worktree is dirty. A branch that is on no remote",
      "yet is rebased and reported, and pushed only with --publish.",
    ],
    flags: [
      {
        name: "contribute",
        type: "boolean",
        summary: "explicitly rebase and push a review branch onto its PR base",
      },
      { name: "all", type: "boolean", summary: "sync every worktree instead of one" },
      {
        name: "publish",
        type: "boolean",
        summary: "push a branch that is on no remote yet where git push would, and track it",
      },
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
  {
    name: "rebase",
    aliases: [],
    args: "[target]",
    summary: "rebase a worktree onto a base you choose, carrying uncommitted changes",
    description: [
      "Moves one worktree's branch onto a base and pushes nothing. `sync` picks",
      "its base for you — the branch's own remote, then the trunk — and pushes",
      "the result; this is for the days the base is the whole question: onto",
      "origin/develop for a while, onto the trunk without the push, onto what",
      "the remote has of the branch and nothing else.",
      "",
      "The base is one of --upstream, --trunk, or --onto <ref>. --upstream is",
      "the branch the worktree tracks. --trunk is the default branch as origin",
      "has it, the same ref `sync` rebases onto; `--onto main` is the local",
      "checkout of it. --onto takes any branch or ref, and a name only the",
      "remote has — `develop` for origin/develop — is taken to mean that. With",
      "none of the three and a terminal attached, the bases are listed and one",
      "is picked by number; in a pipe, one has to be spelled out.",
      "",
      "Uncommitted changes are carried through rather than refused: they are",
      "snapshotted, the rebase runs, and they are put back on top of it. The",
      "snapshot is a commit that touches `refs/stash` in no worktree. If the",
      "rebase conflicts, or the changes will not sit on the rebased branch, the",
      "whole thing is undone and the worktree is exactly as it was — unless",
      "--no-abort asks for the half-finished state to resolve by hand, in which",
      "case the snapshot's sha is printed so `git stash apply` can bring the",
      "changes back once it is.",
    ],
    flags: [
      {
        name: "onto",
        type: "string",
        placeholder: "<ref>",
        summary: "rebase onto <ref> — a branch, origin/<branch>, a tag, a sha",
      },
      { name: "upstream", type: "boolean", summary: "rebase onto the branch it tracks" },
      {
        name: "trunk",
        type: "boolean",
        summary: "rebase onto the default branch as origin has it",
      },
      {
        name: "no-stash",
        type: "boolean",
        summary: "refuse a worktree with uncommitted changes instead of carrying them",
      },
      {
        name: "no-abort",
        type: "boolean",
        summary: "leave a conflicted rebase, or conflicting changes, in place to resolve",
      },
      { name: "no-fetch", type: "boolean", summary: "work from the refs as they were last seen" },
    ],
  },
  {
    name: "exec",
    aliases: [],
    args: "<command>...",
    summary: "run one command in every worktree",
    description: [
      "The thing a repository full of worktrees is: N directories that were the",
      "same yesterday and are not today. A lockfile changed and each of them",
      "needs the install; you are looking for which one holds the uncommitted",
      "work; a codemod has to land in all of them. Each is a `for` loop that",
      "gets written, mis-quoted, and written again next week.",
      "",
      "  grove exec -- bun install",
      "  grove exec -- git status --short",
      "",
      "The `--` is what stops the command's own flags being read as grove's,",
      "and it is worth typing every time. What follows it is run as a program",
      "and not as a shell line, so the quoting your shell already did is the",
      "quoting it gets; a line that wants a shell can ask for one with",
      "`grove exec -- sh -c '…'`.",
      "",
      "Every worktree gets its turn even when one of them fails, the way",
      "`sync --all` does — the news is which one, and stopping would hide it.",
      "The command's stdout is this command's stdout and everything else is on",
      "stderr, so `grove exec -- cat version.txt > all.txt` collects versions",
      "rather than a transcript. GROVE_ROOT, GROVE_WORKTREE and GROVE_BRANCH",
      "are in the environment, the same three a [setup] command gets.",
      "",
      "Exits 11 if the command failed anywhere.",
    ],
    flags: [
      {
        name: "fail-fast",
        type: "boolean",
        summary: "stop at the first worktree the command fails in",
      },
    ],
  },
  {
    name: "doctor",
    aliases: [],
    args: "",
    summary: "check the repository for the things that break a later command",
    description: [
      "Reads the repository, reports what is wrong with it, and prints the",
      "command that clears each one. Nothing is written.",
      "",
      "It looks for the bare clone with no fetch refspec — the one that makes",
      "origin/* never appear and every later command fail somewhere else —",
      "worktrees git still lists but that are gone from disk — including the",
      "locked ones `git worktree prune` skips — directories a prune left",
      "behind pointing at a git dir that is not there, a repo root",
      "whose .git file names the wrong place, and the symlinks .grove.toml's",
      "`link` made, where what they point at has since gone.",
      "",
      "Exits 6 when it found a problem, and 0 for a warning — so a stale",
      "directory does not fail a pipeline this is running in.",
    ],
    flags: [],
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
