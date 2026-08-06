/**
 * The shell function `grove shell-init` prints, and why it exists.
 *
 * A child process cannot change its parent shell's directory — every tool that
 * seems to (zoxide, direnv, yazi) is really a shell function wearing the
 * tool's name, and this is grove's. Installed with one line in the shell's rc
 * file, it adds the two motions the binary alone cannot make:
 *
 *   eval "$(grove shell-init zsh)"
 *
 * - `grove cd [target]` — `cd` to what `grove path …` answers, spelled the
 *   short way. No target is the repository root, the one directory that is
 *   never a worktree: the place to stand while removing anything.
 * - enter, in the app — the wrapper hands every run a temp file via
 *   `GROVE_CD_FILE`; the app writes the selected worktree there on enter, and
 *   the wrapper cds after the screen closes. Without the wrapper the file is
 *   never offered and enter explains itself instead.
 *
 * The function calls back into grove **by the spelling that just printed
 * it** — the running runtime and entry script, absolute paths and all — not a
 * `grove` it hopes is on PATH. That is what lets
 * `eval "$(bun ~/src/grove/src/cli.tsx shell-init zsh)"` work from a bare
 * checkout with nothing installed: however this command was reached, the
 * function reaches back the same way. The eval line re-prints the function at
 * every shell start, so a moved checkout heals on the next shell.
 *
 * Everything else passes straight through, exit code and all, so scripts that
 * wrap grove see no difference.
 */

export const SHELLS = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/** POSIX single-quoting: closes the quote, escapes the quote, reopens it. */
function posixQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** fish quotes differently: backslash-escape `\` and `'` inside single quotes. */
function fishQuote(word: string): string {
  return `'${word.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Whether this grove is a compiled binary rather than a script under bun.
 *
 * `bun build --compile` embeds the entry script inside the executable, and
 * `Bun.main` then names it by a virtual path — `/$bunfs/...` on POSIX,
 * `B:\\~BUN\\...` on Windows — that exists for no other process. Emitting it
 * into the shell function would hand every wrapper call a bogus first
 * argument, which is how an installed `grove` would break the moment the
 * function it printed called back.
 */
export function isCompiledMain(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.startsWith("B:\\~BUN");
}

/**
 * How grove is running right now, as the words that re-create the invocation.
 *
 * `process.execPath` is the runtime and `Bun.main` is the entry script —
 * together they re-create this very invocation whether it came from an
 * installed `grove` on PATH, `bun run grove`, or a path typed out in full.
 * Compiled, the executable alone is the whole invocation.
 */
function invocationWords(): readonly string[] {
  return isCompiledMain(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];
}

function invocation(quote: (word: string) => string): string {
  return invocationWords().map(quote).join(" ");
}

/**
 * The line `grove install` appends to an rc file.
 *
 * Built from the same words the printed function calls back through, so the
 * line this writes and the line a bare checkout would be told to write by
 * hand are never out of step. fish parses its own `$(...)` with fish quoting
 * rather than POSIX, which is why the choice of `quote` follows `shell` here
 * too.
 */
export function evalLine(shell: Shell): string {
  const quote = shell === "fish" ? fishQuote : posixQuote;
  const words = [...invocationWords(), "shell-init", shell].map(quote).join(" ");

  return `eval "$(${words})"`;
}

export function shellInit(shell: Shell): string {
  if (shell === "fish") {
    const grove = invocation(fishQuote);

    return `function grove
  if test (count $argv) -ge 1; and test "$argv[1]" = "cd"
    set --erase argv[1]
    set -l dest (${grove} path $argv); or return $status
    builtin cd $dest
  else
    set -l tmp (mktemp)
    GROVE_CD_FILE=$tmp ${grove} $argv
    set -l code $status
    if test -s $tmp
      builtin cd (cat $tmp)
    end
    rm -f $tmp
    return $code
  end
end`;
  }

  // zsh and bash take the same text: nothing here is outside their shared
  // dialect, and one script for both is one script to test.
  const grove = invocation(posixQuote);

  return `grove() {
  if [ "$1" = "cd" ]; then
    shift
    local dest
    dest="$(${grove} path "$@")" || return $?
    builtin cd "$dest"
  else
    local tmp code
    tmp="$(mktemp "\${TMPDIR:-/tmp}/grove-cd.XXXXXX")" || { ${grove} "$@"; return $?; }
    GROVE_CD_FILE="$tmp" ${grove} "$@"
    code=$?
    if [ -s "$tmp" ]; then
      builtin cd "$(cat "$tmp")" || code=$?
    fi
    rm -f "$tmp"
    return $code
  fi
}`;
}
