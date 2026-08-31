<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="" width="128">
</picture>

# grove

**Worktrees that arrive ready.**

grove is a Git worktree manager with project-defined setup. Clone once, branch freely, and let .grove.toml turn each new worktree into a usable development environment.

[![ci](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/enginerd-kr/grove?color=brightgreen)](https://github.com/enginerd-kr/grove/releases)

[Install](#install) · [Quick Start](#quick-start) · [Project Setup](#project-setup-grovetoml) · [Development](#development)

</div>

<p align="center">
  <img src="docs/screens/demo.gif" alt="18-second demo: adding a worktree, .grove.toml setting it up, and syncing it back under the trunk" width="100%">
</p>

## What Is This, Really?

Git worktrees let one repository have many working directories. grove turns that into a managed workspace.

- one bare clone stores the repository once
- every branch gets its own predictable directory

In practice, grove is for keeping several branches alive at once: a feature, a hotfix, a review branch, an experiment, and a coding-agent sandbox, each in its own ready-to-run directory.

## Install

```bash
brew install enginerd-kr/tap/grove
```

## Quick Start

```bash
grove clone https://github.com/org/repo.git
cd repo

grove add feat/login
grove add fix/prod-crash
grove
```

grove clone creates a managed repository. grove add creates a branch worktree and applies .grove.toml. Running grove with no arguments opens the interactive manager.

## Stuff You Do With Grove

- **Start a branch without losing your current one.** grove add feat/search creates a real worktree in a predictable path.
- **Branch after you already started typing.** grove add feat/search --take moves your uncommitted changes into the new worktree and leaves the old one clean.
- **Stack one change on another.** grove add feat/step-2 --on feat/step-1 remembers the base, and sync rebases through it.
- **Review a pull request in a real checkout.** grove pr 42 takes a number, a URL, or a branch name.
- **Give every coding agent its own workspace.** agents/refactor, agents/tests, agents/ui-copy — no second clone.
- **Stop rebuilding the same local setup.** .grove.toml copies .env, links dependency folders, sets the environment, runs the install, opens your editor.
- **See the whole repository at once.** grove shows branches, dirty worktrees, sync drift, and recent activity.

## Why Not Just git worktree?

Raw git worktree is powerful, but the day-to-day is still manual:

- choosing where each branch directory belongs
- remembering which folder has uncommitted changes
- keeping every branch synced with its remote and default branch
- copying ignored files like .env, certs, or local config into every new checkout
- deciding whether dependencies should be installed again or shared through symlinks

grove makes those choices repeatable. Branch feat/login becomes feat/login/, the UI shows what changed, and the repository itself describes how a fresh worktree becomes usable.

## Project Setup (.grove.toml)

A repository can carry its own setup recipe. It is tracked and reviewed like any other file, so a fresh clone is set up before anybody explains how.

Add .grove.toml to the default branch:

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env = { PORT = 3000, API_HOST = "http://localhost:3000" }
run = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

Every new worktree is then filled in from it:

- **copy** brings files or directories from the default branch's worktree. The trunk's copy wins.
- **link** symlinks shared paths like dependency folders, and leaves what the worktree already has.
- **env** reaches the setup commands.
- **run** runs shell commands in the new worktree, in order.
- **open** starts your editor.

<p align="center">
  <img src="docs/screens/add.svg" alt="grove adding a worktree and applying .grove.toml setup steps" width="100%">
</p>

## Layout

One bare clone, and ordinary Git worktrees beside it:

```text
repo/
  .bare/           # Git objects and refs, stored once
  .git             # Points Git commands at .bare
  main/            # Default branch worktree
  feat/login/      # Branch feat/login
  fix/prod-crash/  # Branch fix/prod-crash
  agents/refactor/ # Branch agents/refactor
```

## What It Is Not

- Not a replacement for Git. Every checkout is an ordinary Git worktree.
- Not a package manager. The setup commands are yours: bun install, uv sync, just setup.
- Not a secret manager. .grove.toml is committed and reviewed; keep real secrets out.

## Development

```bash
bun install
bun run grove
bun run grove:dev
bun test
bun run lint
bun run typecheck
bun run build
bun run compile
bun run screenshots
```
