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

The result is an interactive terminal dashboard that displays all your worktrees in one view. You can instantly see which branches have drifted from remote, which folders have uncommitted changes, and when you last worked in them. All common actions are bound to simple, single-key shortcuts.

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
grove list                  # List all worktrees along with their git status and sync drift
grove sync [target]         # Fetch and bring all worktrees up-to-date by rebasing them
grove reset <target>        # Discard all uncommitted changes in a worktree
grove remove <target>       # Delete a worktree directory safely
grove path [target]         # Print the absolute path of a selected worktree
grove cd [target]           # Change directory to a worktree (requires shell integration)
```

Running `grove` without any arguments opens the interactive terminal UI:

- **Navigate**: Move up and down using `↑`/`↓` or `j`/`k`. Pressing `Enter` inspects a worktree, and pressing `q` exits the UI and changes your shell's current directory to that worktree.
- **Expand/Collapse**: Fold or unfold nested branch directories using `←`/`→` or `h`/`l`.
- **Quick Actions**: Press `a` to add a new worktree, `r` to remove, `x` to discard uncommitted changes, `s` to sync, `p` to open a pull request, and `y` to copy the selected path to the clipboard. Destructive actions will always ask for confirmation first.
- **Search & Run**: Press `?` to search and filter the list in real-time. Or, start typing with `!` (e.g., `!git status` or `!log -3`) to run raw Git commands directly inside the selected worktree.

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
```

### How it works:
- **Tracked configuration**: This file is meant to be checked into your Git repository. Setting up a project (like copying `.env` or folders like `certs/`, and running `bun install`) is a project-wide standard, not just a personal local preference.
- **Safe local actions**: The `copy` and `link` steps run immediately because they only reference files already present on your local disk.
- **Secure execution**: Because the `run` commands come from repository code that could be modified in pull requests, `grove` CLI prints and skips them by default for security, until you pass the `--trust` flag.
- **Interactive UI**: When adding a worktree through the interactive UI, these commands are run automatically since using the UI is considered explicit consent.

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
