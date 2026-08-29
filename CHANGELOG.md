# Changelog

The newest entry is what the app's banner shows as "What's new", and what a
release ships as its notes. Entries begin `## <version>`; only `- ` bullets
directly under one are read.

## 0.3.6 — 2026-08-29

- `.grove.toml`'s `copy` now takes the trunk's version over what the worktree already holds — a stale `.env` is refreshed instead of kept, directories merge with the trunk winning, and what only the worktree has stays
- Removing a dirty worktree asks about its uncommitted changes instead of refusing after the fact: the confirmation counts what `y` would discard, in red, and answering it removes the worktree, changes and all
- `y` copies the path under the cursor to the clipboard — a worktree or a folder, ready to paste into another tab

## 0.3.5 — 2026-08-29

- `.grove.toml`'s `copy` now fills in a directory the new worktree already has, so the ignored files inside a tracked folder — `config/local.json` and the like — arrive with it instead of being skipped as "already there"

## 0.3.4 — 2026-08-28

- `.grove.toml`'s `[setup]` takes an `env` key, so a setup command gets the credential or setting the shell grove was launched from does not have
- An error now shows what the failing thing said — the setup command's own output, the worktrees an ambiguous name matched — instead of only that it failed

## 0.3.3 — 2026-08-06

- `grove install` detects your shell and adds the `grove cd` / enter-to-go line to its rc file, so `shell-init` no longer has to be wired up by hand
- A fresh `grove`, opened without the shell function listening, now offers to install it on the spot — once, before the app opens

## 0.3.2 — 2026-08-06

- New worktrees copy their path to the clipboard, so opening one in another terminal tab is a paste away
- The tip line is colored so it reads against the default line, not the dim hint underneath it
- A new release is re-checked for within the hour instead of a full day, and the tip line now cycles through more advice

## 0.3.1 — 2026-08-06

- Adding a worktree runs its `.grove.toml` commands right away, instead of asking first
- Welcome banner: a quieter version number, brighter changelog bullets, and a tighter card

## 0.3.0 — 2026-08-06

- Each worktree row now shows when it was last touched — `5m ago`, `2d ago`, or a date
- `grove add` no longer takes `--dir`; a worktree's directory always matches its branch

## 0.2.1 — 2026-08-05

- Open with a startup tip pointing at `?` — filtering and raw git from one line

## 0.2.0 — 2026-08-05

- Renamed to grove: the binary, the Homebrew formula, and the repository

## 0.1.1 — 2026-08-05

- A release now bumps the Homebrew tap's formula by itself

## 0.1.0 — 2026-08-05

- First release: worktrees as a tree — add, remove, do PRs, discard from one screen
- Self-contained binaries for macOS and Linux, installed through the Homebrew tap
- `.garden.toml` fills a fresh worktree in and says what a new clone should run
