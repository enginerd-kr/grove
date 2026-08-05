/**
 * The shell function `garden shell-init` prints, and why it exists.
 *
 * A child process cannot change its parent shell's directory — every tool that
 * seems to (zoxide, direnv, yazi) is really a shell function wearing the
 * tool's name, and this is garden's. Installed with one line in the shell's rc
 * file, it adds the two motions the binary alone cannot make:
 *
 *   eval "$(garden shell-init zsh)"
 *
 * - `garden cd [target]` — `cd` to what `garden path …` answers, spelled the
 *   short way. No target is the repository root, the one directory that is
 *   never a worktree: the place to stand while removing anything.
 * - enter, in the app — the wrapper hands every run a temp file via
 *   `GARDEN_CD_FILE`; the app writes the selected worktree there on enter, and
 *   the wrapper cds after the screen closes. Without the wrapper the file is
 *   never offered and enter explains itself instead.
 *
 * The function calls back into garden **by the spelling that just printed
 * it** — the running runtime and entry script, absolute paths and all — not a
 * `garden` it hopes is on PATH. That is what lets
 * `eval "$(bun ~/src/garden/src/cli.tsx shell-init zsh)"` work from a bare
 * checkout with nothing installed: however this command was reached, the
 * function reaches back the same way. The eval line re-prints the function at
 * every shell start, so a moved checkout heals on the next shell.
 *
 * Everything else passes straight through, exit code and all, so scripts that
 * wrap garden see no difference.
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
 * Whether this garden is a compiled binary rather than a script under bun.
 *
 * `bun build --compile` embeds the entry script inside the executable, and
 * `Bun.main` then names it by a virtual path — `/$bunfs/...` on POSIX,
 * `B:\\~BUN\\...` on Windows — that exists for no other process. Emitting it
 * into the shell function would hand every wrapper call a bogus first
 * argument, which is how an installed `garden` would break the moment the
 * function it printed called back.
 */
export function isCompiledMain(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.startsWith("B:\\~BUN");
}

/**
 * How the function should invoke garden: the way garden is running right now.
 *
 * `process.execPath` is the runtime and `Bun.main` is the entry script —
 * together they re-create this very invocation whether it came from an
 * installed `garden` on PATH, `bun run garden`, or a path typed out in full.
 * Compiled, the executable alone is the whole invocation.
 */
function invocation(quote: (word: string) => string): string {
  const words = isCompiledMain(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];

  return words.map(quote).join(" ");
}

export function shellInit(shell: Shell): string {
  if (shell === "fish") {
    const garden = invocation(fishQuote);

    return `function garden
  if test (count $argv) -ge 1; and test "$argv[1]" = "cd"
    set --erase argv[1]
    set -l dest (${garden} path $argv); or return $status
    builtin cd $dest
  else
    set -l tmp (mktemp)
    GARDEN_CD_FILE=$tmp ${garden} $argv
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
  const garden = invocation(posixQuote);

  return `garden() {
  if [ "$1" = "cd" ]; then
    shift
    local dest
    dest="$(${garden} path "$@")" || return $?
    builtin cd "$dest"
  else
    local tmp code
    tmp="$(mktemp "\${TMPDIR:-/tmp}/garden-cd.XXXXXX")" || { ${garden} "$@"; return $?; }
    GARDEN_CD_FILE="$tmp" ${garden} "$@"
    code=$?
    if [ -s "$tmp" ]; then
      builtin cd "$(cat "$tmp")" || code=$?
    fi
    rm -f "$tmp"
    return $code
  fi
}`;
}
