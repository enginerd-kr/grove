# grove — git worktree manager

Manage git worktrees backed by a single bare clone. One directory per repository, one subdirectory per branch, and no bookkeeping to remember.

The name is the shape of the thing: a worktree is a tree, and a repository full of them is a **grove**.

Runs on [Bun](https://bun.sh) with [Biome](https://biomejs.dev) for linting and formatting. Uses [Ink](https://github.com/vadimdemedes/ink) for the terminal UI.

---

## Features

- **Bare Clone Backend**: Saves disk space and organizes all branches of a repository into clean, parallel directories.
- **Interactive Terminal UI**: Manage worktrees with hotkeys—add, remove, sync, reset, filter, run Git commands, and create PRs.
- **Auto-Workspace Setup**: Configure `.grove.toml` to copy files (e.g., `.env`), symlink folders (`node_modules`), and run setup commands (`bun install`) automatically on worktree creation.
- **Smart Syncing**: Automatically fetches and brings worktrees up to date using safe, rebase-based strategies.

---

## Installation

```bash
# Install via Homebrew
brew install enginerd-kr/tap/grove

# Set up shell integration (for `grove cd` and enter-to-cd)
grove install
```

If you prefer to load it manually, add this to your shell's configuration file (`~/.zshrc`, `~/.bashrc`, etc.):
```bash
eval "$(grove shell-init zsh)"    # Options: zsh, bash, fish
```

---

## Directory Layout

Running `grove clone https://github.com/org/repo.git` in `~/work` produces:

```text
~/work/repo/
  .bare/          the bare clone (all git storage)
  .git            file pointing to the bare clone
  main/           worktree for the default branch (e.g., main)
  feat/
    login/        worktree for feat/login
    search/       worktree for feat/search
  fix/
    crash/        worktree for fix/crash
```

> **Note**: `grove` also works inside standard/ordinary repositories! Standing inside a normal clone, `grove add feat/login` will create the worktree as `../repo-feat-login`.

---

## Workspace Setup (`.grove.toml`)

Create a `.grove.toml` file in your repository's default branch to automate worktree initialization:

```toml
[setup]
copy = [".env"]                # Copy files from the default branch (main)
link = ["node_modules"]        # Symlink folders (e.g. to share dependencies)
env  = { PORT = "3000" }       # Environment variables for run commands
run  = ["bun install"]         # Commands to execute in the new worktree
```

---

## CLI Usage & Commands

```bash
grove                       # Open the interactive terminal UI
grove clone <url> [dir]     # Bare-clone a repository and checkout default branch
grove add <branch>          # Create a new worktree for a branch (tracks upstream)
grove list                  # List all worktrees and their current status
grove sync [target]         # Fetch and bring worktrees up to date
grove reset <target>        # Hard-reset a worktree (discard unstaged/staged changes)
grove remove <target>       # Delete a worktree
grove path [target]         # Print a worktree's directory path (default: repo root)
grove cd [target]           # Quick cd to a worktree directory (requires shell integration)
```

---

## The Interactive UI

Run `grove` on its own to launch the interactive terminal application:

- **Navigation**: `↑`/`↓` or `j`/`k` to move, `enter` to CD to a worktree (even without closing the UI!).
- **Manage**: `a` to add a new branch, `r` to remove, `x` to discard/reset changes, `s` to sync, `p` to open a PR.
- **Folders**: `←`/`→` or `h`/`l` to fold and unfold directories.
- **Filter**: Press `?` and type to live-filter and rank worktrees.
- **Git Escape Hatch**: Press `?` and start with `!` (e.g., `!log -3`) to run raw Git commands directly inside the selected worktree.

---

## Development

```bash
bun install          # Install dependencies
bun run grove        # Run CLI in development
bun run grove:dev    # Run CLI with hot reload
bun test             # Run tests
bun run lint         # Check linting and formatting (Biome)
bun run lint:fix     # Auto-fix formatting and linting
bun run build        # Build production bundle
bun run compile      # Compile standalone binaries
```

---

## License

MIT
