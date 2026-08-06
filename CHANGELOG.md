# Changelog

The newest entry is what the app's banner shows as "What's new", and what a
release ships as its notes. Entries begin `## <version>`; only `- ` bullets
directly under one are read.

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
