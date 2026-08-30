import { findRepoRoot } from "../core/discover.ts";
import { runGit } from "../core/git.ts";
import { listWorktrees, worktreeDir } from "../core/worktrees.ts";
import { type FlagSpec, GLOBAL_FLAGS, SUBCOMMANDS } from "./help.ts";
import { invocation, type Shell } from "./shell-init.ts";

/**
 * The completion scripts, and the two words they call grove back with.
 *
 * Everything a person types at this tool is the name of a worktree — `grove cd
 * feat/login`, `grove remove feat/login`, `grove sync feat/login` — and a name
 * with a slash in it is the kind nobody types twice without a typo. So the
 * shell should be filling them in, and this is what lets it.
 *
 * The static half is generated from `help.ts`, the same table `--help` renders
 * and `args.ts` builds its parser from. That is the whole reason it is here
 * rather than in three checked-in script files: a command added to that table
 * completes without anybody remembering to add it in three more places, and a
 * flag renamed cannot leave a completion offering the old spelling.
 *
 * The moving half — which worktrees exist, which branches do not have one — has
 * to be asked at the moment TAB is pressed, so the scripts call back with
 * `grove completion targets` and `grove completion branches`. They call back by
 * **the spelling that printed them**, exactly as `shell-init`'s function does,
 * so a completion installed from a bare checkout reaches the same checkout.
 *
 * Both callbacks answer with one word per line and nothing else, and both are
 * silent about everything that could go wrong. A shell completion is not a
 * place to report that this directory is not a repository: the answer there is
 * no suggestions, which is what an empty answer is.
 */

/** The words `grove completion` takes, past the shells: what the scripts ask for. */
export const COMPLETION_WORDS = ["targets", "branches"] as const;
export type CompletionWord = (typeof COMPLETION_WORDS)[number];

export function isCompletionWord(value: string): value is CompletionWord {
  return (COMPLETION_WORDS as readonly string[]).includes(value);
}

/**
 * The subcommands whose argument is a worktree that exists.
 *
 * `cd` is in here and not in `SUBCOMMANDS`, because it is not a subcommand: it
 * is the shell function `shell-init` installs, and the completion is registered
 * on that same name — so as far as a shell is concerned it is one of these, and
 * leaving it out would break completion for the command people type most.
 *
 * Aliases are listed with their names. A shell reads the word that was typed,
 * and `grove rm <TAB>` is as ordinary a thing to type as `grove remove <TAB>`.
 */
const TAKES_TARGET = [
  "cd",
  "path",
  "open",
  "setup",
  "remove",
  "rm",
  "reset",
  "sync",
  "rename",
  "mv",
] as const;

/** The one whose argument is a branch that may well not have a worktree yet. */
const TAKES_BRANCH = ["add"] as const;

/** And the ones whose argument is the name of a shell. */
const TAKES_SHELL = ["shell-init", "install", "completion"] as const;

/** Where a second positional is a worktree and the first was something else. */
const TAKES_TARGET_FIRST = ["rename", "mv"] as const;

type Word = { readonly word: string; readonly summary: string };

function subcommandWords(): readonly Word[] {
  return SUBCOMMANDS.map((spec) => ({ word: spec.name, summary: spec.summary }));
}

function flagWords(name: string): readonly Word[] {
  const spec = SUBCOMMANDS.find((each) => each.name === name || each.aliases.includes(name));
  const flags: readonly FlagSpec[] = [...(spec?.flags ?? []), ...GLOBAL_FLAGS];

  return flags.map((flag) => ({ word: `--${flag.name}`, summary: flag.summary }));
}

/** POSIX single-quoting, for a summary with an apostrophe in it — and they have them. */
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** fish escapes rather than closing the quote, inside single quotes. */
function fishQuote(word: string): string {
  return `'${word.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * One `word:description` pair for zsh's `_describe`.
 *
 * The colon is the separator, so a colon inside a description has to be
 * escaped — none of the summaries has one today, and a completion that
 * truncated itself the day one did would be a bug nobody would look for here.
 */
function zshPair({ word, summary }: Word): string {
  return quote(`${word}:${summary.replace(/:/g, "\\:")}`);
}

export function completionScript(shell: Shell): string {
  if (shell === "fish") return fishScript();
  if (shell === "bash") return bashScript();

  return zshScript();
}

function zshScript(): string {
  const grove = invocation(quote);
  const commands = subcommandWords().map(zshPair).join(" ");
  const flags = SUBCOMMANDS.map(
    (spec) => `    ${spec.name}) opts=(${flagWords(spec.name).map(zshPair).join(" ")}) ;;`,
  ).join("\n");

  return `_grove_targets() {
  local -a words
  words=(\${(f)"$(${grove} completion targets 2>/dev/null)"})
  compadd -a words
}

_grove_branches() {
  local -a words
  words=(\${(f)"$(${grove} completion branches 2>/dev/null)"})
  compadd -a words
}

_grove() {
  local -a commands opts
  commands=(${commands})

  if (( CURRENT == 2 )); then
    _describe 'grove command' commands
    return
  fi

  local cmd=\${words[2]}

  case $cmd in
${flags}
    *) opts=(${GLOBAL_FLAGS.map((flag) => zshPair({ word: `--${flag.name}`, summary: flag.summary })).join(" ")}) ;;
  esac

  if [[ \${words[CURRENT]} == -* ]]; then
    _describe 'option' opts
    return
  fi

  case $cmd in
    ${TAKES_TARGET_FIRST.join("|")}) (( CURRENT == 3 )) && _grove_targets ;;
    ${TAKES_TARGET.filter((name) => !TAKES_TARGET_FIRST.includes(name as never)).join("|")}) _grove_targets ;;
    ${TAKES_BRANCH.join("|")}) _grove_branches ;;
    ${TAKES_SHELL.join("|")}) compadd zsh bash fish ;;
  esac
}

# Only where the completion system is loaded. This is printed from an rc file,
# which on a shell that has never run \`compinit\` is a line before \`compdef\`
# exists — and an error at every shell start is a worse trade than no
# completions on the shells that do not want them.
if whence compdef > /dev/null 2>&1; then
  compdef _grove grove
fi`;
}

function bashScript(): string {
  const grove = invocation(quote);
  const commands = SUBCOMMANDS.map((spec) => spec.name).join(" ");
  const flags = SUBCOMMANDS.map(
    (spec) =>
      `    ${spec.name}) opts="${flagWords(spec.name)
        .map((flag) => flag.word)
        .join(" ")}" ;;`,
  ).join("\n");

  return `_grove() {
  local cur cmd opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    mapfile -t COMPREPLY < <(compgen -W "${commands}" -- "$cur")
    return
  fi

  case "$cmd" in
${flags}
    *) opts="${GLOBAL_FLAGS.map((flag) => `--${flag.name}`).join(" ")}" ;;
  esac

  case "$cur" in
    -*)
      mapfile -t COMPREPLY < <(compgen -W "$opts" -- "$cur")
      return
      ;;
  esac

  local words=""
  case "$cmd" in
    ${TAKES_TARGET_FIRST.join("|")})
      [ "$COMP_CWORD" -eq 2 ] && words="$(${grove} completion targets 2>/dev/null)"
      ;;
    ${TAKES_TARGET.filter((name) => !TAKES_TARGET_FIRST.includes(name as never)).join("|")})
      words="$(${grove} completion targets 2>/dev/null)"
      ;;
    ${TAKES_BRANCH.join("|")}) words="$(${grove} completion branches 2>/dev/null)" ;;
    ${TAKES_SHELL.join("|")}) words="zsh bash fish" ;;
  esac

  mapfile -t COMPREPLY < <(compgen -W "$words" -- "$cur")
}

complete -F _grove grove`;
}

function fishScript(): string {
  const grove = invocation(fishQuote);
  const lines: string[] = [
    // No files anywhere: every argument this tool takes is a branch, a worktree,
    // or a shell, and a directory listing offered beside them is noise.
    "complete -c grove -f",
  ];

  for (const spec of SUBCOMMANDS) {
    lines.push(
      `complete -c grove -n __fish_use_subcommand -a ${fishQuote(spec.name)} -d ${fishQuote(spec.summary)}`,
    );
  }

  for (const spec of SUBCOMMANDS) {
    const names = [spec.name, ...spec.aliases].join(" ");
    for (const flag of spec.flags) {
      const short = flag.short === undefined ? "" : ` -s ${flag.short}`;
      lines.push(
        `complete -c grove -n ${fishQuote(`__fish_seen_subcommand_from ${names}`)}` +
          `${short} -l ${flag.name} -d ${fishQuote(flag.summary)}`,
      );
    }
  }

  for (const flag of GLOBAL_FLAGS) {
    const short = flag.short === undefined ? "" : ` -s ${flag.short}`;
    lines.push(`complete -c grove${short} -l ${flag.name} -d ${fishQuote(flag.summary)}`);
  }

  lines.push(
    `complete -c grove -n ${fishQuote(`__fish_seen_subcommand_from ${TAKES_TARGET.join(" ")}`)}` +
      ` -a ${fishQuote(`(${grove} completion targets 2>/dev/null)`)}`,
    `complete -c grove -n ${fishQuote(`__fish_seen_subcommand_from ${TAKES_BRANCH.join(" ")}`)}` +
      ` -a ${fishQuote(`(${grove} completion branches 2>/dev/null)`)}`,
    `complete -c grove -n ${fishQuote(`__fish_seen_subcommand_from ${TAKES_SHELL.join(" ")}`)}` +
      " -a 'zsh bash fish'",
  );

  return lines.join("\n");
}

/**
 * What a script asks back for, one word per line.
 *
 * Never throws, whatever it finds. This runs while somebody is holding TAB
 * down: a directory that is not a repository, a bare clone with no refs, a git
 * that is not on PATH — every one of them is "no suggestions" here, and a
 * completion that printed an error into the middle of a command line would be
 * worse than the one it was trying to save.
 */
export async function completionWords(
  cwd: string,
  repoOption: string | undefined,
  what: CompletionWord,
): Promise<readonly string[]> {
  try {
    const repo = await findRepoRoot(cwd, repoOption);
    const worktrees = await listWorktrees(repo.gitDir);
    const dirs = worktrees.map((record) => worktreeDir(repo.root, record.path));

    if (what === "targets") return dirs.filter((dir) => dir !== ".").sort();

    // Branches, minus the ones already checked out somewhere: `grove add` on
    // those is a command that reports the worktree it did not have to make.
    const taken = new Set(worktrees.map((record) => record.branch));
    // Both spellings of each ref: the full one says whether it is a symbolic
    // `HEAD`, and the short one is the name. `refs/remotes/origin/HEAD`
    // shortens to `origin`, which is a remote and not a branch — reading only
    // the short name would offer it as one.
    const refs = await runGit(
      ["for-each-ref", "--format=%(refname)%09%(refname:short)", "refs/heads/", "refs/remotes/"],
      { cwd: repo.gitDir },
    );
    if (refs.code !== 0) return [];

    const branches = new Set<string>();
    for (const line of refs.stdout.split("\n")) {
      const [full, short] = line.split("\t");
      if (full === undefined || short === undefined || full.endsWith("/HEAD")) continue;

      // `origin/feat/login` is the branch `feat/login` to every command here,
      // and the remote's name is not part of what anybody types at `add`.
      const branch = short.startsWith("origin/") ? short.slice("origin/".length) : short;
      if (branch !== "" && !taken.has(branch)) branches.add(branch);
    }

    return [...branches].sort();
  } catch {
    return [];
  }
}
