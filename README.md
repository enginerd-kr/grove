<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="" width="128">
</picture>

# grove

**A working folder for every branch, with project setup automated.**

grove is a Git worktree manager. Clone a repository once, then develop and review pull requests in separate folders. Configure `.grove.toml` to copy local files and install dependencies whenever you create a worktree.

[![ci](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/enginerd-kr/grove?color=brightgreen)](https://github.com/enginerd-kr/grove/releases)

[Install](#install) · [Quick start](#quick-start) · [User guide](USAGE.md) · [Development](#development)

[English](README.md) · [한국어](docs/md/README.ko.md)

</div>

<p align="center">
  <img src="docs/screens/demo.gif" alt="18-second demo: creating a worktree, applying .grove.toml setup, and incorporating changes from the default branch" width="100%">
</p>

## Install

```bash
brew install enginerd-kr/tap/grove
# or install with npm (macOS and Linux; Node 18+)
npm install -g @enginerd-kr/grove
```

To run without installing, use `npx @enginerd-kr/grove`.

## Quick start

Replace the URL below with your repository's URL.

```bash
grove clone https://github.com/org/repo.git
cd repo
grove add feat/login
cd feat/login
```

Edit code and commit with Git as usual inside `feat/login`. If the project has
setup commands, grove shows them and asks for approval before running them for
the first time. You can create worktrees without a setup file, too.

Run `grove` anywhere in the workspace to see all your worktrees. Press `a` to
start a new task or `s` to sync the selected worktree.

## Everyday workflow

These examples run from `repo/`.

| Task | Command |
| --- | --- |
| Start a new task | `grove add feat/login` |
| Open a PR for your work | `grove propose feat/login` |
| Sync a development branch | `grove sync feat/login` |
| Review someone else's PR | `grove pr 42` |
| Update a PR review worktree | `grove sync pr/42` |
| Preview finished worktrees to remove | `grove prune -n` |

`propose` and `pr` require the GitHub CLI, `gh`. `propose` handles the first push
for a new branch. To publish a branch with `sync` before opening a PR, add
`--publish`.

**On a development branch, `sync` rebases and pushes if it has a remote branch.**
Branches without one sync locally from the default branch. On a PR review worktree,
it receives the latest PR commits. On the default branch, it only fast-forwards.
See [how sync works](USAGE.md#what-does-sync-do) for the differences.

## How are the folders organized?

```text
repo/             # Workspace: run grove here
  .bare/          # Git repository shared by all worktrees
  .git            # File pointing to the Git repository
  main/           # Default branch and shared setup files
  feat/login/     # Login feature development
  pr/42/          # PR #42 review
```

Edit and commit inside a worktree such as `main/`, `feat/login/`, or `pr/42/`.
`main` is an example default branch name; use `master` or another name if that
is what your repository uses. New tasks start from the latest remote default
branch. You do not need to update local `main` or enter its folder first.

## Configure project setup once

Put the project's preparation steps in `.grove.toml` on the default branch.
This minimal example is for a Bun project. Replace `run` with your project's
install command.

```toml
[setup]
run = ["bun install"]
```

To copy `.env` as well, add `copy = [".env"]` under `[setup]` and prepare the
source file at local `main/.env`. Add `.env` to `.gitignore`. Install dependencies
in each worktree and use your package manager's download cache.

`clone`, `add`, and `pr` apply the setup. If an install fails or the configuration
changes later, run `grove setup feat/login` to apply it again.
See [project setup](USAGE.md#project-setup) for configuration and retry instructions.

## Where to go next

- [User guide](USAGE.md): from the first clone to opening a PR and cleaning up
- [Interactive screen](USAGE.md#interactive-screen): manage worktrees with the keyboard
- [Options for specific tasks](USAGE.md#options-for-specific-tasks): move changes, stack branches, replace a review checkout, or use a branch's setup
- [Troubleshooting](USAGE.md#troubleshooting): when setup or sync cannot finish

## Development

Use these commands when contributing to grove itself.

```bash
bun install
bun run grove
bun run grove:dev
bun test
bun run lint
bun run typecheck
bun run build
bun run compile
bun run npm:build
bun run npm:smoke
bun run screenshots
```
