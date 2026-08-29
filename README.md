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

Git worktrees are the perfect solution when you need to work on or compare multiple branches at once. However, they are rarely used because managing them is a hassle:
- Where should the new directory go?
- Which clone owns which folder?
- Why are dependencies (`node_modules`) missing in the new worktree?
- Which of these directories contains my uncommitted changes?

`grove` solves these issues by enforcing a consistent, automatic layout. One bare clone holds all your git history; every branch gets its own directory based on its branch name (e.g., `feat/login` goes to `feat/login/`); and a simple `.grove.toml` configuration automates the setup for every new worktree.

The result is an interactive terminal dashboard that displays all your worktrees in one view. You can instantly see which branches have drifted from remote, which folders have uncommitted changes, and when you last worked in them. Creating, syncing, and removing worktrees are bound to single-key shortcuts.

## Installation

```bash
# Install via Homebrew
brew install enginerd-kr/tap/grove

# Set up shell integration (allows `grove cd` and interactive navigation to change your shell directory)
grove install
```

`grove install` automatically detects your shell and adds the required initialization line to your shell's configuration file (e.g., `.zshrc` or `.bashrc`).

If you prefer to configure it manually, add this line to your shell configuration:

```bash
eval "$(grove shell-init zsh)"    # works for zsh, bash, and fish
```

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
grove cd [target]           # Change directory to a worktree (requires shell integration)
grove doctor                # Check the repository for the traps that break a later command
```

Running `grove` without any arguments opens the interactive terminal UI:

- **Navigate**: Move up and down using `↑`/`↓` or `j`/`k`, and press `q` to exit.
- **Expand/Collapse**: Fold or unfold nested branch directories using `←`/`→` or `h`/`l`.
- **Quick Actions**: Press `a` to add a worktree, `r` to remove one — or every worktree under the selected folder — `s` to sync the selected worktree, and `S` to sync them all. `R` re-reads the list on demand. Removals always ask for confirmation first, and say what they would discard.
- **Copy a Path**: Press `Enter` to put the selected worktree's absolute path on the clipboard — a folder answers too — ready to paste into another terminal tab or an editor's "open folder" box.
- **Recent Commits**: The last few commits of the selected worktree are drawn under the list — the sha, how long ago, and where `HEAD` and `origin` point — so `↑2` is something you can read rather than a number to go and look up. `L` puts the panel away when the rows are wanted for the list instead.
- **Pull Requests**: Press `p` to list the repository's open pull requests and pick one. It arrives as a worktree at `pr/<number>`, on a branch of the same name, fetched from wherever it was proposed — somebody's fork included — so reviewing it is a directory you can build and run in rather than a branch you have to put your own work down for. Needs [`gh`](https://cli.github.com), the only tool besides git that `grove` ever runs.
- **Uncommitted Files**: When the selected worktree has changes in it, the files are drawn beside the list as the tree they sit in — directories folded the same way the worktrees are, so a change confined to one directory reads as one heading — and nothing but the paths, so "what have I got open over there" is answered without a `git status` in another terminal. The panel takes only the space to the right of the columns, so it never costs the list a column, and a clean worktree shows nothing at all.
- **Finished Branches**: A row whose branch the trunk already has, or whose branch the remote no longer has, reads `merged` or `gone` beside its state — so the worktrees with nothing left in them are visible without going and asking. `r` clears the one under the cursor; `grove prune` clears every one of them at once.

The keys stay deliberately few: they are the things worktree management is made of, plus the one thing you cannot type without going to look it up first — a pull request's number. Everything else git can do is a `grove` subcommand or a `git` command away, where it has to be typed out on purpose.

### Clearing away what is finished

Making worktrees is the easy half. The half that piles up is that they never leave: a pull request is merged, the branch disappears from the forge, and the directory it was checked out into sits there for the rest of the year.

`grove list` and the interactive screen badge those rows — `merged` when the trunk already has every commit on the branch, `gone` when the branch was pushed and the remote no longer has it. Both are looked for, because no workflow leaves both traces: merging a pull request with the delete box ticked leaves `gone`, and squashing or rebasing leaves `merged`.

```bash
grove prune --dry-run      # say what would go
grove prune                # remove those directories, keeping the branches
grove prune --gone         # only the ones the remote deleted
grove prune --delete-branch
```

It fetches first, since a branch deleted on the forge only reads as gone once a fetch has pruned the ref that tracked it. Anything holding uncommitted work, stopped mid-rebase, locked, or containing the directory you are standing in is reported and left exactly where it is.

### Taking your changes with you

The edits you have been making in `main` for the last twenty minutes should have been a branch. In an ordinary clone that is `git stash`, `git checkout -b`, `git stash pop`; in a repository full of worktrees it is worse, because `refs/stash` is shared between every worktree and a `pop` in one directory can take an entry somebody left in another.

```bash
cd ~/work/repo/main
grove add feat/login --take
```

The new worktree arrives holding the changes — staged ones still staged, untracked files moved across, ignored files left where they are — and the worktree you were in is clean. Nothing goes near the stash stack: the snapshot is a commit object referenced by nothing, and if the changes will not apply cleanly, both worktrees are left exactly as they were and the command tells you the sha that recovers them.

## Directory Layout

Running `grove clone https://github.com/org/repo.git` inside `~/work` creates the following clean directory structure:

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

`grove` also works seamlessly inside an ordinary Git clone. If you run it from within a standard clone, `grove add feat/login` will place the new worktree at `../repo-feat-login` without modifying or reorganizing your existing repository structure.

## Workspace Setup (`.grove.toml`)

When you create a new worktree, it is just a fresh checkout of the source code. To make it runnable, you typically still need to copy gitignored files (like `.env`) or install dependencies.

By adding a `.grove.toml` file to your repository's default branch, you can automate this environment setup. Every new worktree created afterwards will arrive fully prepared:

```toml
[setup]
copy = [".env", "certs"]       # Copied files or folders from the default branch's worktree
link = ["node_modules"]        # Symlinked, so packages are only installed once
env  = { PORT = "3000" }       # Environment variables passed to the run commands below
run  = ["bun install"]         # Shell commands to run inside the new worktree

[teardown]
env = { COMPOSE_PROJECT_NAME = "acme" }
run = ["docker compose down"]  # Shell commands run inside the worktree just before it is removed
```

### How it works:
- **Tracked configuration**: This file is meant to be checked into your Git repository. Setting up a project (like copying `.env` or folders like `certs/`, and running `bun install`) is a project-wide standard, not just a personal local preference.
- **Safe local actions**: The `copy` and `link` steps run immediately because they only reference files already present on your local disk.
- **Secure execution**: Because the `run` commands come from repository code that could be modified in pull requests, `grove` CLI prints and skips them by default for security, until you pass the `--trust` flag. One `--trust` covers both sections, and one edit to the file withdraws both.
- **Interactive UI**: When adding a worktree through the interactive UI, these commands are run automatically since using the UI is considered explicit consent.
- **Teardown never blocks a removal**: whatever `[setup]` started is still running when the directory it was started in is about to go, which is what `[teardown]` is for. A command that fails there is reported loudly and the worktree is still removed — a broken `docker compose down` should not leave you unable to delete a directory you have finished with. `grove remove --no-teardown` skips the section outright.

Pressing `a` and typing a branch name is the whole of it — the worktree appears, and the file fills it in underneath:

<p align="center">
  <img src="docs/screens/add.svg" alt="grove's screen after pressing a: the new worktree in the tree, and under it the .grove.toml steps that copied the .env, shared node_modules, and ran bun install" width="100%">
</p>

## Reviewing a Pull Request

`grove pr 42` fetches pull request 42 and checks it out at `pr/42`, on a local branch of that name. Because the branch is real you can commit there; and because `grove` configures the branch's push refspec, a plain `git push` sends those commits back to the pull request's own branch — whatever it happens to be called, and even when it lives on a fork whose author allowed edits from maintainers.

```bash
grove pr 42                                             # by number
grove pr https://github.com/org/repo/pull/42            # by the URL you copied
grove pr octocat:fix/crash                              # by the branch it came from
```

Run it again and the worktree catches up with whatever the pull request has become. If it has moved *and* you have commits of your own sitting there, `grove` refuses rather than choosing for you, and names the one line that would resolve it.

When you are finished, `grove remove pr/42` — or press `r` on the `pr/` folder in the app to clear out every pull request you have looked at, in one go.

Each pull request `grove` fetches gets a git remote of its own, named `pr-42`, carrying a single-branch refspec so it costs one ref rather than a fork's worth of stale branches. Deleting the branch takes the remote with it (`grove remove pr/42 --delete-branch`), and any left behind by a branch that went another way are swept up the next time `grove pr` runs.

## Development

`grove` is built using [Bun](https://bun.sh), [Ink](https://github.com/vadimdemedes/ink) (for the terminal React UI), and [Biome](https://biomejs.dev) (for linting and formatting).

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

The `bun run screenshots` script automatically creates a temporary Git repository with realistic worktrees, launches the terminal UI, simulates user interactions, and captures the exact terminal frames rendered by Ink directly to `docs/screens/`. This ensures that the screenshots in this README are always accurate and up-to-date with the code.

## License

MIT
