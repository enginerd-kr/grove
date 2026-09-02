# Using grove

grove manages git worktrees. Run `grove` and you get an interactive screen:
one row per worktree, one key per action. Every action is also a CLI command
(`grove add`, `grove sync`, ...) for scripts, agents, and non-interactive
shells.

This guide covers the screen first, then the commands.

- [Install and first run](#install-and-first-run)
- [The screen](#the-screen)
- [Common tasks](#common-tasks)
- [Keys](#keys)
- [Layout on disk](#layout-on-disk)
- [Worktree setup: .grove.toml](#worktree-setup-grovetoml)
- [CLI reference](#cli-reference)
- [Scripting and agents](#scripting-and-agents)
- [Troubleshooting](#troubleshooting)

## Install and first run

```bash
brew install enginerd-kr/tap/grove
mkdir myapp && cd myapp
grove
```

In a folder with no repository, `grove` asks for a URL, clones it, and opens
the screen. An empty folder becomes the repository itself. A non-empty folder
gets the repository in a subfolder.

grove also works inside an existing `git clone`. New worktrees go beside the
repository (`myapp-feat-login` next to `myapp`). In a folder with several
repositories, `grove` asks which one.

## The screen

<p align="center">
  <img src="docs/screens/list.svg" alt="the grove screen: every worktree, its drift against origin and the trunk, and whether it is clean" width="100%">
</p>

Rows are worktrees, grouped by the folders in their branch names. `*` marks
the worktree you ran `grove` from. `▸` is the cursor.

| column | meaning |
| --- | --- |
| origin | commits ahead / behind the branch's remote |
| main | commits ahead / behind the trunk |
| state | `●` has uncommitted changes, `○` clean, then the age of the last commit |

Below the list: files changed in the selected worktree, and (with `/log`) its
recent commits. The bottom bar shows the keys available right now.

The screen refreshes periodically. `/refresh` forces one.

## Common tasks

**Create a branch.** `a`, type a name, `enter`. grove creates the branch and
worktree, applies `.grove.toml`, opens your editor, and copies `cd <path>` to
the clipboard. The branch is cut from the selected worktree. On a folder row,
the name starts with the folder prefix filled in.

**Jump to a worktree.** Select it, `enter`. The path is on the clipboard.

**Sync.** `s` fetches, rebases onto the remote and then the trunk, and pushes.
If the push would rewrite remote history, grove asks first. A branch that is
on no remote yet is asked about too: `y` pushes it and tracks it. `/sync-all`
does every worktree with a single confirmation, and only says which branches
are on no remote.

**Remove.** `r`. The prompt lists what would be lost. `y` removes the worktree
and keeps the branch. On a folder row, `r` removes every worktree in it.

**Review a pull request.** `/review`, pick one, `enter`. It checks out as
`pr/<number>`. Pushing from there updates the PR. Requires `gh`.

Every destructive action asks first. `y` confirms. Any other key cancels.

## Keys

| key | action |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `←` `→` / `h` `l` | fold or open a folder; step out of or into it |
| `enter` | copy the selected path |
| `a` | add a worktree, branched from the selection |
| `r` | remove the selection, or the whole folder |
| `x` | discard uncommitted changes (shown only when there are any) |
| `s` | sync the selection |
| `/` | command menu |
| `y` / `n` | confirm / cancel |
| `q` / `esc` | quit |

`/` opens a searchable menu. Type to filter, `↑` `↓` to pick, `enter` to run,
`esc` to close.

<p align="center">
  <img src="docs/screens/menu.svg" alt="the / menu open over the list, narrowed by what has been typed" width="100%">
</p>

| command | action |
| --- | --- |
| `/open` | open the selection in the editor |
| `/setup` | re-apply `.grove.toml` to the selection |
| `/sync-all` | sync every worktree |
| `/review` | check out an open pull request |
| `/refresh` | re-read worktrees now |
| `/log` | toggle the commit panel |

Two things are CLI-only by design: moving uncommitted changes into a new
worktree (`grove add --take`) and recording a branch as stacked on another
(`grove add --on`).

## Layout on disk

```text
myapp/
  .bare/           # git objects and refs
  .git             # file pointing at .bare
  main/            # default branch
  feat/login/      # branch feat/login
  feat/login-api/  # branch feat/login-api
  pr/42/           # PR checked out for review
```

Directory name = branch name, slashes included. Each directory is a normal git
worktree; `git` works there as usual. The root is never a worktree.

## Worktree setup: .grove.toml

A new worktree has no `.env` and no `node_modules`. `.grove.toml` on the
default branch declares how to fill one in. Every `a` / `grove add` applies it.

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env  = { PORT = 3000 }
run  = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

| key | meaning |
| --- | --- |
| `copy` | copy from the trunk worktree. Trunk wins; directories merge |
| `link` | symlink to the trunk's path. Existing entries are left alone |
| `env` | environment for `run` commands |
| `run` | commands to run in the worktree, in order, awaited |
| `open` | editor command. Not awaited; survives the terminal closing |
| `[teardown] run` | commands to run before the worktree is removed |

Rules:

- Paths must stay inside the worktree. Absolute paths, `..`, `.git`, and
  `.bare` reject the whole file.
- Unknown keys are errors. `cpoy = [".env"]` fails instead of doing nothing.
- List keys accept a bare string: `copy = ".env"`.

Any key can be per-platform. The keys are `macos`, `linux`, `windows`; a
platform the table leaves out gets nothing there. `env`'s platform keys hold
that platform's variables, over the shared ones:

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."

[setup.copy]
macos   = [".env"]
windows = [".env", "local.bat"]

[setup.env]
PORT    = 3000
windows = { SHELL = "pwsh" }

[teardown.run]
macos = ["docker compose down", "colima stop"]
```

### Three config layers

| file | scope |
| --- | --- |
| `~/.config/grove/config.toml` | your machine. Put `open` here |
| `.grove.toml` | the project. Committed |
| `.grove.local.toml` | this checkout. Gitignored |

Applied in that order. `copy`, `link`, `run` accumulate across layers. `open`
and each `env` variable take the last value set.

### Trust

`copy` and `link` run immediately. `run` and `open` do not until you approve
them, since a `git pull` could otherwise deliver arbitrary commands.

On the screen, grove shows the commands and asks. `y` approves. On the CLI,
pass `--trust`. Without approval the commands are printed and skipped.

Approval is a hash of the file, stored in the bare repository's git config
(local, never pushed). Editing the file revokes it. `config.toml` and an
untracked `.grove.local.toml` never need approval.

### Re-applying setup

`a` applies `.grove.toml` as it was at the time. When the file changes later,
run `/setup` on a worktree or `grove setup --all`. It is idempotent: `copy`
overwrites from the trunk, `link` leaves existing entries, `run` is your own
command.

`run`, `teardown`, and `exec` commands receive `GROVE_ROOT`, `GROVE_WORKTREE`,
and `GROVE_BRANCH`.

## CLI reference

Every command has `--help`, generated from the parser's own table.

```bash
grove clone <url> [-b <branch>]   # first-run screen; `init` is an alias
grove add <branch>                # a
grove list                        # the rows, as text
grove path [target]               # enter; no target prints the root
grove open [target]               # /open
grove setup [target | --all]      # /setup
grove sync [target | --all]       # s, /sync-all
grove pr <number | url | branch>  # /review
grove reset <target>              # x
grove remove <target>             # r
grove prune                       # remove finished worktrees
grove rename <target> <name>      # move branch and directory together
grove exec -- <command>           # run in every worktree
grove doctor                      # diagnose
```

`<target>` is a branch, directory, or path. It defaults to the current
worktree. `-C <path>` selects a repository explicitly.

```bash
cd "$(grove path feat/login)"
```

### add

Uses the local branch if it exists, tracks the remote branch if that exists,
otherwise creates it from the default branch.

| flag | |
| --- | --- |
| `--from <base>` | create from `<base>` instead |
| `--on <branch>` | create from `<branch>` and record it as the parent (stack) |
| `--take` | move the current worktree's uncommitted changes into the new one |
| `--push` | push and set upstream |
| `--trust` | approve `.grove.toml` commands |
| `--no-fetch`, `--no-setup` | skip the fetch / skip `.grove.toml` |

A stacked branch rebases onto its parent, and onto the trunk only through the
parent. Parents sync before children; syncing a child syncs its parents. The
record is `branch.<name>` in the bare repo's config, so `git branch -m`
carries it along.

### sync

Fetches, then:

- **default branch**: fast-forward, or rebase local commits and push.
- **every other branch**: rebase onto its remote, then onto the trunk, then
  push with `--force-with-lease`.

A dirty worktree aborts before anything runs. A conflicted rebase is aborted
unless `--no-abort`. `--no-push` keeps the result local.

A branch on no remote yet (`grove add` without `--push`) is rebased and then
reported with exit code 4: nothing was pushed, and nothing was refused.
`--publish` pushes it to origin and tracks it. `--no-push` says it is meant
to stay local, and reports nothing.

The screen confirms before a force-push and before a first push. The CLI does
neither.

### remove / prune

`remove` refuses unsafe worktrees unless `--force`. A worktree mid-rebase is
refused regardless. `--delete-branch` deletes the branch. `--no-teardown`
skips `[teardown]`.

`prune` fetches, then removes worktrees whose branch is gone from the remote
(`--gone`) or merged into the trunk (`--merged`). No flag means both. `-n`
prints what would go. Dirty, mid-rebase, locked, or current worktrees are
skipped and reported.

### reset

`git reset --hard`. `--clean` also deletes untracked files. `--to <ref>` resets
to another ref.

### exec

Runs the command after `--` in every worktree, as a process, not a shell line.
Use `sh -c` for shell syntax. Continues past failures unless `--fail-fast`.
Only the command's stdout goes to stdout.

```bash
grove exec -- bun install
grove exec -- git status --short
grove exec -- sh -c 'echo $GROVE_BRANCH'
```

## Scripting and agents

- `--json` prints one JSON document to stdout. Human output goes to stderr.
- `--headless` (or a non-TTY) disables the screen. Commands never prompt; they
  act or fail with an exit code.
- `--verbose` logs every git command with exit code and timing.

| exit code | meaning |
| --- | --- |
| 0 | ok |
| 1 | grove bug |
| 2 | usage |
| 3 | not a repository |
| 4 | refused |
| 5 | rebase conflict |
| 6 | state conflict (also `doctor` with a problem) |
| 7 | git command failed |
| 8 | remote error |
| 9 | `[setup]` command failed (worktree exists) |
| 10 | `gh` missing or failed |
| 11 | `exec` failed in at least one worktree |
| 130 | Ctrl-C |

A typical agent loop:

```bash
grove add agents/<task> --trust --json   # create; read the path from stdout
# ... work in the worktree ...
grove sync agents/<task> --publish        # first push too; exit 4 without it
grove remove agents/<task> --delete-branch
```

## Troubleshooting

```bash
grove doctor
```

Reports problems and the command that fixes each. Writes nothing. Checks for:
a bare clone with no fetch refspec, worktrees git lists that are missing on
disk, leftover directories, a root `.git` pointing at the wrong place, and
broken symlinks. Exits `6` on a problem, `0` on warnings only.

Not bugs:

- **Nothing was copied or installed.** `run` needs trust. `copy` / `link`
  read from the trunk worktree, not your branch.
- **`grove` printed usage instead of the screen.** No TTY, or `--headless`.
- **`grove exec` consumed my flags.** Put `--` before the command.
- **`grove <command>` refused to pick a repository.** The folder holds several.
  `cd` into one or pass `-C`.

## What grove is not

- Not a git replacement. Every worktree is a normal git worktree.
- Not a package manager. Setup commands are yours.
- Not a secret manager. `.grove.toml` is committed. Secrets go in the local
  layers.
