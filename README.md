<div align="center">

# grove

**A git worktree manager powered by a single bare clone — one directory per repository, one subdirectory per branch, and zero manual bookkeeping.**

A git worktree is like a tree, and a repository full of them is a **grove**.

[![ci](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/enginerd-kr/grove?color=brightgreen)](https://github.com/enginerd-kr/grove/releases)

</div>

<p align="center">
  <img src="docs/screens/list.svg" alt="grove's screen: a repository's worktrees as a tree, with how far each has drifted from its remote and from the trunk, whether anything is uncommitted, and when it was last worked in" width="100%">
</p>

## Why

Worktrees are the right answer for working on two branches at once, and almost nobody uses them — because where the directory goes, which clone owns it, why `node_modules` is missing in it, and which of them holds your uncommitted work are all yours to remember.

`grove` fixes the layout instead: one bare clone holds the history, every branch gets a directory named after it (`feat/login` → `feat/login/`), and a `.grove.toml` fills each new worktree in. What is left is one screen showing every worktree — drift from remote, uncommitted changes, when you last touched it — with add, sync and remove on single keys.

## Installation

```bash
brew install enginerd-kr/tap/grove
grove install      # shell integration: `grove cd` moves your shell, and TAB fills in names
```

`grove install` finds your shell and writes the lines itself — one for `grove cd`, one for tab completion. By hand, they are:

```bash
eval "$(grove shell-init zsh)"    # zsh, bash, and fish
eval "$(grove completion zsh)"
```

Completion fills in the commands, their flags, and the names — `grove cd feat/<TAB>` offers the worktrees you have, and `grove add <TAB>` the branches that do not have one yet. Run `grove install` again if you installed before it existed: it adds the line you are missing and leaves the one you have.

## Usage

```bash
grove clone <url> [dir]     # Clone a repository as a bare clone and set up its default branch
grove add <branch>          # Create a new worktree for a branch, tracking its remote counterpart
grove pr <number>           # Create a worktree for reviewing a pull request, on a branch you can push back from
grove list                  # List all worktrees along with their git status and sync drift
grove sync [target]         # Fetch and bring all worktrees up-to-date by rebasing them
grove prune                 # Remove every worktree whose branch is merged or gone from the remote
grove rename <target> <new> # Rename a branch and move its worktree directory to match
grove reset <target>        # Discard all uncommitted changes in a worktree
grove remove <target>       # Delete a worktree directory safely
grove path [target]         # Print the absolute path of a selected worktree
grove open [target]         # Open a worktree with what `.grove.toml`'s `open` says
grove cd [target]           # Change directory to a worktree (requires shell integration)
grove doctor                # Check the repository for the traps that break a later command
grove completion <shell>    # Print the tab-completion script (`grove install` writes it for you)
```

Two flags worth knowing:

- `grove add <branch> --take` moves the changes you have been making in the current worktree into the new one — staged still staged, untracked carried across — without going near the shared stash stack.
- `grove prune --dry-run` says what would go first. Rows badged `merged` (the trunk has them) or `gone` (the remote deleted them) are the candidates; anything holding uncommitted work, mid-rebase, locked, or under your feet is reported and left alone.

## The interactive UI

Running `grove` with no arguments opens the screen above.

- **Move**: `↑`/`↓` or `j`/`k`, `←`/`→` or `h`/`l` to fold a directory, `q` to quit.
- **Act**: `a` adds, `r` removes — a folder takes everything under it — and `s` syncs the row under the cursor. Removals confirm, and say what they would discard.
- **Discard**: `x` throws away what a dirty worktree has changed — `reset --hard` and `clean -fd`, so untracked files go too — leaving the directory and the branch. It is offered only where there is something to take, it counts the tracked changes and the untracked files apart before you answer, and there is no undo.
- **Copy**: `Enter` puts the selected path on the clipboard, ready for another tab or an editor.
- **Look**: the selected worktree's last few commits are drawn under the list, and its uncommitted files beside it, as the tree they sit in.
- **More**: `/` opens everything that has no key of its own — type to narrow it, `Enter` to run it.
  - `/open` opens the row under the cursor with what `.grove.toml`'s `open` says — the same line `a` ran when the worktree was made, on any day after.
  - `/sync-all` syncs every worktree, not just the one under the cursor.
  - `/review` lists the repository's open pull requests and checks the one you pick out at `pr/<number>`. Needs [`gh`](https://cli.github.com), the only tool besides git that `grove` ever runs.
  - `/refresh` re-reads the list now; `/log` puts the commit panel away when the list wants the rows.

The keys stay few on purpose: the bar holds what acts on the row under the cursor, `/` holds the rest, and everything else git can do is a `grove` subcommand or a `git` command away, where it has to be typed out.

## Directory layout

`grove clone https://github.com/org/repo.git` inside `~/work` gives you:

```text
~/work/repo/
  .bare/          # The bare clone storing all Git history and objects (once)
  .git            # A standard git file pointing to the bare repository
  main/           # Worktree directory for the default branch
  feat/
    login/        # Worktree for feat/login
    search/       # Worktree for feat/search
  fix/
    crash/        # Worktree for fix/crash
  pr/
    42/           # Worktree for pull request 42
```

Inside an ordinary clone, `grove` leaves the layout alone: `grove add feat/login` puts the worktree at `../repo-feat-login`.

## Workspace setup (`.grove.toml`)

A new worktree is a bare checkout — no `.env`, no dependencies. Commit a `.grove.toml` to your default branch and every worktree made afterwards arrives ready:

```toml
[setup]
copy = [".env", "certs"]       # Copied files or folders from the default branch's worktree
link = ["node_modules"]        # Symlinked, so packages are only installed once
env  = { PORT = "3000" }       # Environment variables passed to the run commands below
run  = ["bun install"]         # Shell commands to run inside the new worktree
open = "code ."                # What to open the finished worktree with

[teardown]
env = { COMPOSE_PROJECT_NAME = "acme" }
run = ["docker compose down"]  # Shell commands run inside the worktree just before it is removed
```

- **`copy` and `link` run straight away**; `run` and `open` come from repository code a pull request could edit, so the CLI prints and skips them until you pass `--trust`. The UI runs them, since pressing `a` is consent.
- **`open` is started and let go** — not waited for, and it outlives the shell you typed `grove add` into. It is skipped when there is no terminal to open into (`grove add | tee`, CI), and when a `run` command failed.
- **`open` is not only for the day the worktree is made**: `grove open [target]` runs the same line again, and no target means the worktree you are standing in. `/open` in the app does it for the row under the cursor.
- **`open` can be written per platform**, since one line rarely works everywhere. A platform the table leaves out opens nothing:

  ```toml
  [setup.open]
  macos = 'open -a "Visual Studio Code" .'
  linux = "code ."
  ```

- **`[teardown]` never blocks a removal**: a command that fails there is reported loudly and the worktree still goes. `grove remove --no-teardown` skips it.

### The part that is yours, not the project's

`.grove.toml` is committed, which is its point and also its limit: there is nowhere to write in a repository you do not own, and `grove pr 42` on somebody else's project still needs the `.env` and the install. So two more files stack under and over it:

| File | Where | Who it is for |
| --- | --- | --- |
| `~/.config/grove/config.toml` | once per machine | your editor, your defaults, every repository |
| `.grove.toml` | the default branch's worktree | the project, committed and reviewed |
| `.grove.local.toml` | beside it, gitignored | this repository, this machine |

**Each layer adds to the ones under it.** `copy`, `link` and `run` collect what every layer named, in that order — so the project's `bun install` runs before the step you put on top of it. `open` and each `env` name are the exception, because there is only one editor and one value for a name: the nearest layer that says anything wins, and `open` decides that per platform.

**`--trust` only ever asks about the files git tracks.** A `run` line needs agreeing to because a `git pull` can change it, and nothing pulls the two files above — so yours run without being asked about, and a project file that only copies things gates nothing. The one exception is the repository that commits a `.grove.local.toml` anyway: grove asks git rather than taking the name's word for it.

<p align="center">
  <img src="docs/screens/add.svg" alt="grove's screen after pressing a: the new worktree in the tree, and under it the .grove.toml steps that copied the .env, shared node_modules, and ran bun install" width="100%">
</p>

## Reviewing a pull request

`grove pr 42` checks pull request 42 out at `pr/42`, on a real local branch — so you can commit, and a plain `git push` goes back to the pull request's own branch, fork included.

```bash
grove pr 42                                             # by number
grove pr https://github.com/org/repo/pull/42            # by the URL you copied
grove pr octocat:fix/crash                              # by the branch it came from
```

Run it again to catch up with whatever the pull request has become; if it has moved *and* you have commits sitting there, `grove` refuses rather than choosing for you. Each fetched pull request gets a single-branch remote of its own, cleared away with the worktree.

## Development

`grove` is built with [Bun](https://bun.sh), [Ink](https://github.com/vadimdemedes/ink) for the terminal UI, and [Biome](https://biomejs.dev).

```bash
bun install
bun run grove         # Run the CLI from source
bun run grove:dev     # Run the CLI from source with hot-reloading
bun test              # Run unit tests
bun run lint          # Check code linting and formatting (`bun run lint:fix` to auto-fix)
bun run typecheck     # Verify TypeScript types
bun run build         # Build the application (`bun run compile` for standalone binaries)
bun run screenshots   # Regenerate all SVG screenshots in this README from the live UI
```

`bun run screenshots` builds a throwaway repository, drives the real UI, and captures the frames Ink renders into `docs/screens/` — so the pictures above cannot drift from the code.

## License

MIT
